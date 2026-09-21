import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import Settings
from ..deps import get_settings
from ..deps import client_ip, current_driver, get_db, get_store, rate_limited
from ..matching import waiting_ahead
from ..models import (DriverSessionOut, EndTripIn, OtpRequestIn, OtpVerifyIn, StartTripIn,
                      TripOut, TripProgressIn, WaitingPassengerForDriver)
from ..otp import generate_code
from ..phone import mask_phone
from ..state import RealtimeStore

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/driver", tags=["driver"])


def _pseudonym() -> str:
    return "bus-" + uuid.uuid4().hex[:6]


def _trip_out(tr: Dict[str, str]) -> TripOut:
    return TripOut(trip_id=tr["trip_id"], route_id=tr["route_id"], direction=int(tr["direction"]),
                   progress_km=float(tr["progress_km"]), speed_kmh=float(tr["speed_kmh"]),
                   zone=tr.get("zone") or None, pseudonym=tr["pseudonym"],
                   expires_at=float(tr.get("expires_at", 0)))


# ---------------------------------------------------------------- OTP auth
@router.post("/otp/request", dependencies=[Depends(rate_limited("otp_ip", "otp_requests_per_hour_per_ip", 3600))])
async def otp_request(body: OtpRequestIn, request: Request, store: RealtimeStore = Depends(get_store),
                      settings: Settings = Depends(get_settings)):
    phone = body.phone
    if await store.otp_in_cooldown(phone):
        raise HTTPException(429, "Please wait before requesting another code")
    if not await store.hit("otp_phone", phone, settings.otp_requests_per_hour_per_phone, 3600):
        raise HTTPException(429, "Too many codes requested for this number")
    code = generate_code()
    await store.put_otp(phone, code)
    provider = request.app.state.otp_provider
    try:
        await provider.send(phone, code)
    except Exception:  # never leak provider errors or the number
        logger.exception("OTP delivery failed for %s", mask_phone(phone))
        raise HTTPException(502, "Could not send the code, try again")
    out = {"sent": True, "provider": provider.name, "expires_in_sec": settings.otp_ttl_sec}
    if provider.name == "mock" and not settings.is_production:
        out["dev_code"] = code  # development convenience only; never in production
    return out


@router.post("/otp/verify", response_model=DriverSessionOut,
             dependencies=[Depends(rate_limited("otp_verify_ip", "otp_requests_per_hour_per_ip", 3600, multiplier=3))])
async def otp_verify(body: OtpVerifyIn, request: Request, store: RealtimeStore = Depends(get_store), db=Depends(get_db)):
    result = await store.verify_otp(body.phone, body.code)
    if result == "expired":
        raise HTTPException(400, "Code expired or not requested")
    if result == "locked":
        raise HTTPException(429, "Too many attempts, request a new code")
    if result != "ok":
        raise HTTPException(400, "Wrong code")
    driver = await db.drivers.find_one({"phone": body.phone}, {"_id": 0})
    if not driver:
        driver = {
            "id": str(uuid.uuid4()), "phone": body.phone, "name": None,
            # Pilot: every new driver is assigned all pilot lines (config data).
            "assigned_route_ids": [r.id for r in request.app.state.catalog.routes],
            "verification_tier": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.drivers.insert_one(dict(driver))
    token, expires_at = await store.create_session(driver["id"], driver["phone"])
    return DriverSessionOut(session_token=token, driver_id=driver["id"], phone=driver["phone"],
                            name=driver.get("name"), assigned_route_ids=driver.get("assigned_route_ids", []),
                            expires_at=expires_at)



@router.post("/logout")
async def logout(sess: Dict[str, str] = Depends(current_driver), store: RealtimeStore = Depends(get_store)):
    await store.delete_session(sess["token"])
    return {"ok": True}


@router.get("/me", response_model=DriverSessionOut)
async def me(sess: Dict[str, str] = Depends(current_driver), db=Depends(get_db)):
    driver = await db.drivers.find_one({"id": sess["driver_id"]}, {"_id": 0})
    if not driver:
        raise HTTPException(401, "Driver not found")
    return DriverSessionOut(session_token="", driver_id=driver["id"], phone=driver["phone"],
                            name=driver.get("name"), assigned_route_ids=driver.get("assigned_route_ids", []),
                            expires_at=float(sess.get("expires_at", 0)))


# ------------------------------------------------------------------ trips
@router.post("/trip/start", response_model=TripOut)
async def trip_start(body: StartTripIn, request: Request, sess: Dict[str, str] = Depends(current_driver),
                     store: RealtimeStore = Depends(get_store), db=Depends(get_db)):
    catalog = request.app.state.catalog
    r = catalog.route(body.route_id)
    if not r or not catalog.direction(r, body.direction):
        raise HTTPException(404, "Route/direction not found")
    driver = await db.drivers.find_one({"id": sess["driver_id"]}, {"_id": 0, "assigned_route_ids": 1})
    assigned = (driver or {}).get("assigned_route_ids", [])
    if assigned and body.route_id not in assigned:
        raise HTTPException(403, "Driver is not assigned to this line")
    tr = await store.start_trip(sess["driver_id"], body.route_id, body.direction, _pseudonym())
    return _trip_out({k: str(v) for k, v in tr.items()})


async def _own_trip(trip_id: str, sess: Dict[str, str], store: RealtimeStore) -> Dict[str, str]:
    tr = await store.get_trip(trip_id)
    if not tr or tr.get("driver_id") != sess["driver_id"]:
        raise HTTPException(404, "Trip not found")
    return tr


@router.post("/trip/progress", response_model=TripOut)
async def trip_progress(body: TripProgressIn, request: Request, sess: Dict[str, str] = Depends(current_driver),
                        store: RealtimeStore = Depends(get_store)):
    tr = await _own_trip(body.trip_id, sess, store)
    catalog = request.app.state.catalog
    r = catalog.route(tr["route_id"]); d = catalog.direction(r, int(tr["direction"])) if r else None
    max_km = d.total_km if d else body.progress_km
    progress = max(0.0, min(body.progress_km, max_km))
    updated = await store.update_trip(body.trip_id, round(progress, 3), round(body.speed_kmh, 1), body.zone)
    if not updated:
        raise HTTPException(404, "Trip not found")
    return _trip_out(updated)


@router.post("/trip/end")
async def trip_end(body: EndTripIn, sess: Dict[str, str] = Depends(current_driver),
                   store: RealtimeStore = Depends(get_store)):
    await _own_trip(body.trip_id, sess, store)
    await store.end_trip(body.trip_id)
    return {"ended": True}


@router.get("/trip/current", response_model=TripOut)
async def trip_current(sess: Dict[str, str] = Depends(current_driver), store: RealtimeStore = Depends(get_store)):
    trip_id = await store.current_trip_id(sess["driver_id"])
    tr = await store.get_trip(trip_id) if trip_id else None
    if not tr:
        raise HTTPException(404, "No active trip")
    return _trip_out(tr)


@router.get("/trip/{trip_id}/waiting", response_model=List[WaitingPassengerForDriver])
async def trip_waiting(trip_id: str, sess: Dict[str, str] = Depends(current_driver),
                       store: RealtimeStore = Depends(get_store)):
    tr = await _own_trip(trip_id, sess, store)
    waits = await store.waits_on(tr["route_id"], int(tr["direction"]))
    return waiting_ahead(waits, float(tr["progress_km"]))
