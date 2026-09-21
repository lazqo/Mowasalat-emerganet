from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..analytics import record_wait
from ..config import Settings
from ..deps import get_settings, get_store, rate_limited
from ..matching import approaching_buses
from ..models import ApproachingBus, WaitCreateIn, WaitOut, WaitStatusOut
from ..realtime import sse_response, stream
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


@router.get("/buses/stream", dependencies=[Depends(_read_limit)])
async def passenger_buses_stream(request: Request, destination_id: str = Query(max_length=64),
                                 from_progress_km: float = Query(0.0, ge=0, le=500),
                                 route_id: Optional[str] = Query(None, max_length=64),
                                 direction: Optional[int] = Query(None, ge=0, le=1),
                                 store: RealtimeStore = Depends(get_store),
                                 settings: Settings = Depends(get_settings)):
    """SSE: `buses` events with the same payload as GET /buses, before the
    passenger has announced a wait."""
    async def produce():
        buses = await _buses(request, store, destination_id, from_progress_km, route_id, direction)
        return {"buses": [b.model_dump() for b in buses]}
    return sse_response(stream(request, settings, "buses", produce))


@router.post("/wait", response_model=WaitOut,
             dependencies=[Depends(rate_limited("wait_create", "passenger_wait_per_minute_per_ip", 60))])
async def passenger_wait(body: WaitCreateIn, request: Request, store: RealtimeStore = Depends(get_store),
                         settings: Settings = Depends(get_settings)):
    catalog = request.app.state.catalog
    r = catalog.route(body.route_id)
    d = catalog.direction(r, body.direction) if r else None
    if not d:
        raise HTTPException(404, "Route/direction not found")
    dest = next((s for s in d.served if s.stop_id == body.destination_id), None)
    if not dest or dest.progress_km <= 0.0:
        raise HTTPException(404, "Destination not served by this line/direction")
    if body.stop_id is not None:
        at = next((s for s in d.served if s.stop_id == body.stop_id), None)
        if not at:
            raise HTTPException(404, "Stop not on this line/direction")
        position = at.progress_km
    elif body.wait_progress_km is not None:
        step = settings.wait_position_round_km
        position = round(round(body.wait_progress_km / step) * step, 3)  # coarsen before storing
    else:
        raise HTTPException(422, "Provide stop_id or wait_progress_km")
    if position > d.total_km:
        raise HTTPException(400, "Position is beyond the end of the line")
    if position >= dest.progress_km:
        raise HTTPException(400, "Destination is behind this position on the line")
    w = await store.create_wait(body.route_id, body.direction, body.destination_id, position)
    # Aggregate analytics only (route, direction, 3 km segment, hour), k-suppressed before Mongo.
    await record_wait(store, settings, body.route_id, body.direction, position)
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


@router.get("/wait/{wait_id}/stream", dependencies=[Depends(_read_limit)])
async def passenger_wait_stream(wait_id: str, request: Request, store: RealtimeStore = Depends(get_store),
                                settings: Settings = Depends(get_settings)):
    """SSE: `status` events (same payload as GET /status); `ended` when the
    wait was boarded, cancelled or expired."""
    async def produce():
        w = await store.get_wait(wait_id)
        if not w:
            return None
        buses = await _buses(request, store, w["destination_id"], float(w["wait_progress_km"]),
                             w["route_id"], int(w["direction"]))
        return {"wait_id": wait_id, "state": w["state"], "expires_at": float(w["expires_at"]),
                "buses": [b.model_dump() for b in buses]}
    return sse_response(stream(request, settings, "status", produce))


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
