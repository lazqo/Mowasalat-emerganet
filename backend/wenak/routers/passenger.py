from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..deps import get_db, get_store, rate_limited
from ..matching import approaching_buses
from ..models import ApproachingBus, WaitCreateIn, WaitOut, WaitStatusOut
from ..state import RealtimeStore

router = APIRouter(prefix="/passenger", tags=["passenger"])
_read_limit = rate_limited("read", "read_per_minute_per_ip", 60)


async def _buses(request: Request, store: RealtimeStore, destination_id: str, from_progress_km: float,
                 route_id: Optional[str], direction: Optional[int]) -> List[ApproachingBus]:
    catalog = request.app.state.catalog
    serving = catalog.serving(destination_id)
    if route_id is not None and direction is not None:
        serving = [x for x in serving if x["route_id"] == route_id and x["direction"] == direction]
    out: List[ApproachingBus] = []
    for line in serving:
        trips = await store.trips_on(line["route_id"], line["direction"])
        out.extend(approaching_buses(trips, from_progress_km, line["destination_km"]))
    out.sort(key=lambda b: b.distance_km)
    return out


@router.get("/buses", response_model=List[ApproachingBus], dependencies=[Depends(_read_limit)])
async def passenger_buses(request: Request, destination_id: str = Query(max_length=64),
                          from_progress_km: float = Query(0.0, ge=0, le=500),
                          route_id: Optional[str] = Query(None, max_length=64),
                          direction: Optional[int] = Query(None, ge=0, le=1),
                          store: RealtimeStore = Depends(get_store)):
    """Approaching buses that can reach `destination_id` and have not passed
    the passenger's route-relative position. Positions are km along the
    line, computed on the phone."""
    return await _buses(request, store, destination_id, from_progress_km, route_id, direction)


@router.post("/wait", response_model=WaitOut,
             dependencies=[Depends(rate_limited("wait_create", "passenger_wait_per_minute_per_ip", 60))])
async def passenger_wait(body: WaitCreateIn, request: Request, store: RealtimeStore = Depends(get_store), db=Depends(get_db)):
    catalog = request.app.state.catalog
    r = catalog.route(body.route_id)
    d = catalog.direction(r, body.direction) if r else None
    if not d:
        raise HTTPException(404, "Route/direction not found")
    stop = next((s for s in d.served if s.stop_id == body.destination_id), None)
    if not stop or stop.progress_km <= 0.0:
        raise HTTPException(404, "Destination not served by this line/direction")
    if body.wait_progress_km > d.total_km:
        raise HTTPException(400, "Position is beyond the end of the line")
    if body.wait_progress_km >= stop.progress_km:
        raise HTTPException(400, "Destination is behind this position on the line")
    w = await store.create_wait(body.route_id, body.direction, body.destination_id, round(body.wait_progress_km, 3))
    # Aggregate analytics only: destination + hour + count. No identity, no position.
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    await db.demand_stats.update_one({"destination_id": body.destination_id, "hour": hour},
                                     {"$inc": {"requests": 1}}, upsert=True)
    return WaitOut(wait_id=w["wait_id"], destination_id=w["destination_id"], route_id=w["route_id"],
                   direction=int(w["direction"]), wait_progress_km=float(w["wait_progress_km"]),
                   expires_at=float(w["expires_at"]))


@router.get("/wait/{wait_id}/status", response_model=WaitStatusOut, dependencies=[Depends(_read_limit)])
async def passenger_wait_status(wait_id: str, request: Request, store: RealtimeStore = Depends(get_store)):
    w = await store.get_wait(wait_id)
    if not w:
        raise HTTPException(404, "Wait expired or not found")
    buses = await _buses(request, store, w["destination_id"], float(w["wait_progress_km"]),
                         w["route_id"], int(w["direction"]))
    return WaitStatusOut(wait_id=wait_id, state=w["state"], expires_at=float(w["expires_at"]), buses=buses)


@router.post("/wait/{wait_id}/board")
async def passenger_wait_board(wait_id: str, store: RealtimeStore = Depends(get_store)):
    if not await store.delete_wait(wait_id):
        raise HTTPException(404, "Wait not found")
    return {"boarded": True}


@router.post("/wait/{wait_id}/cancel")
async def passenger_wait_cancel(wait_id: str, store: RealtimeStore = Depends(get_store)):
    if not await store.delete_wait(wait_id):
        raise HTTPException(404, "Wait not found")
    return {"cancelled": True}
