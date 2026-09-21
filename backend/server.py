"""
Mowasalat / مواصلات - Backend API
A live information & demand-visibility layer for existing transport routes.
This is NOT a ride-hailing service — no booking, no dispatch, no fares.

Design principles enforced:
- No raw GPS coordinates persisted (route-relative progress only).
- Realtime state kept in-memory with TTLs (no trajectory DB).
- Passengers are anonymous (no accounts).
- Drivers identified by phone only (mock OTP for MVP).
"""

from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
import uuid
import time
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Mowasalat API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory realtime state (mimics Redis for MVP). Everything has a TTL.
# ---------------------------------------------------------------------------
ACTIVE_TRIPS: Dict[str, dict] = {}      # trip_id -> {driver_id, route_id, direction, progress_km, speed_kmh, updated_at, pseudonym}
WAITING_REQUESTS: Dict[str, dict] = {}  # wait_id -> {route_id, direction, destination_id, wait_progress_km, created_at, expires_at, state}
DRIVER_SESSIONS: Dict[str, dict] = {}   # session_token -> {driver_id, phone, expires_at}

TRIP_TTL_SEC = 60 * 60 * 6          # 6h max trip
WAIT_TTL_SEC = 60 * 20              # 20 min wait auto-expire
SESSION_TTL_SEC = 60 * 60 * 24 * 30 # 30d driver session

def now_ts() -> float:
    return time.time()

def cleanup_expired():
    t = now_ts()
    for tid, tr in list(ACTIVE_TRIPS.items()):
        if t - tr.get("updated_at", 0) > TRIP_TTL_SEC:
            ACTIVE_TRIPS.pop(tid, None)
    for wid, w in list(WAITING_REQUESTS.items()):
        if t > w.get("expires_at", 0):
            WAITING_REQUESTS.pop(wid, None)
    for stok, s in list(DRIVER_SESSIONS.items()):
        if t > s.get("expires_at", 0):
            DRIVER_SESSIONS.pop(stok, None)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class Destination(BaseModel):
    id: str
    name_ar: str
    name_en: str

class RouteDirection(BaseModel):
    direction: int  # 0 or 1
    origin_id: str
    destination_id: str
    origin_name_ar: str
    destination_name_ar: str
    # served intermediate destinations (in order) with progress marker (0..1)
    served: List[dict]  # [{destination_id, name_ar, progress}]
    total_km: float

class TransportRoute(BaseModel):
    id: str
    name_ar: str
    name_en: str
    directions: List[RouteDirection]

class OtpRequestIn(BaseModel):
    phone: str

class OtpVerifyIn(BaseModel):
    phone: str
    code: str

class DriverSessionOut(BaseModel):
    session_token: str
    driver_id: str
    phone: str
    name: Optional[str] = None
    assigned_route_ids: List[str]

class StartTripIn(BaseModel):
    session_token: str
    route_id: str
    direction: int

class TripProgressIn(BaseModel):
    session_token: str
    trip_id: str
    progress_km: float
    speed_kmh: float = 40.0

class EndTripIn(BaseModel):
    session_token: str
    trip_id: str

class TripOut(BaseModel):
    trip_id: str
    route_id: str
    direction: int
    progress_km: float
    speed_kmh: float
    pseudonym: str

class WaitCreateIn(BaseModel):
    destination_id: str
    # passenger-computed route match (phone-side privacy):
    route_id: str
    direction: int
    wait_progress_km: float  # where along the corridor the passenger is

class WaitOut(BaseModel):
    wait_id: str
    destination_id: str
    route_id: str
    direction: int
    wait_progress_km: float
    expires_at: float

class ApproachingBus(BaseModel):
    pseudonym: str
    distance_km: float
    eta_min: int
    state: str  # "coming", "near", "very_near"

class WaitingPassengerForDriver(BaseModel):
    distance_km: float
    count: int  # aggregated when passengers are close together

# ---------------------------------------------------------------------------
# Seed data (Irbid ↔ Bani Kinana pilot)
# Progress values are fractional 0..1 relative to that direction's total_km.
# ---------------------------------------------------------------------------
DESTINATIONS: List[Destination] = [
    Destination(id="irbid",       name_ar="إربد",           name_en="Irbid"),
    Destination(id="malka",       name_ar="ملكا",           name_en="Malka"),
    Destination(id="sama_rousan", name_ar="سما الروسان",     name_en="Sama Al-Rousan"),
    Destination(id="kufr_soum",   name_ar="كفرسوم",         name_en="Kufr Soum"),
    Destination(id="habras",      name_ar="حبراص",          name_en="Habras"),
    Destination(id="umm_qais",    name_ar="أم قيس",         name_en="Umm Qais"),
    Destination(id="hakama",      name_ar="حكما",           name_en="Hakama"),
]

def _dest(id_: str) -> Destination:
    return next(d for d in DESTINATIONS if d.id == id_)

def _mkroute(rid: str, name_ar: str, name_en: str, other_id: str, served_out: list, total_km: float) -> TransportRoute:
    irbid = _dest("irbid")
    other = _dest(other_id)
    outbound = RouteDirection(
        direction=0, origin_id="irbid", destination_id=other_id,
        origin_name_ar=irbid.name_ar, destination_name_ar=other.name_ar,
        served=[{"destination_id": d[0], "name_ar": _dest(d[0]).name_ar, "progress": d[1]} for d in served_out],
        total_km=total_km,
    )
    # reverse: mirror progress
    inbound_served = [(d[0], round(1 - d[1], 3)) for d in reversed(served_out)]
    inbound = RouteDirection(
        direction=1, origin_id=other_id, destination_id="irbid",
        origin_name_ar=other.name_ar, destination_name_ar=irbid.name_ar,
        served=[{"destination_id": d[0], "name_ar": _dest(d[0]).name_ar, "progress": d[1]} for d in inbound_served],
        total_km=total_km,
    )
    return TransportRoute(id=rid, name_ar=name_ar, name_en=name_en, directions=[outbound, inbound])

ROUTES: List[TransportRoute] = [
    _mkroute("irbid_malka",       "إربد ↔ ملكا",         "Irbid <-> Malka",
             "malka",       [("irbid", 0.0), ("hakama", 0.45), ("malka", 1.0)], total_km=18.0),
    _mkroute("irbid_sama_rousan", "إربد ↔ سما الروسان",   "Irbid <-> Sama Al-Rousan",
             "sama_rousan", [("irbid", 0.0), ("sama_rousan", 1.0)], total_km=15.0),
    _mkroute("irbid_kufr_soum",   "إربد ↔ كفرسوم",       "Irbid <-> Kufr Soum",
             "kufr_soum",   [("irbid", 0.0), ("kufr_soum", 1.0)], total_km=17.0),
    _mkroute("irbid_habras",      "إربد ↔ حبراص",        "Irbid <-> Habras",
             "habras",      [("irbid", 0.0), ("habras", 1.0)], total_km=16.0),
    _mkroute("irbid_umm_qais",    "إربد ↔ أم قيس",       "Irbid <-> Umm Qais",
             "umm_qais",    [("irbid", 0.0), ("malka", 0.55), ("umm_qais", 1.0)], total_km=30.0),
]

# Every driver seeded is assigned all pilot routes.
DEFAULT_ASSIGNED = [r.id for r in ROUTES]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _route(route_id: str) -> Optional[TransportRoute]:
    return next((r for r in ROUTES if r.id == route_id), None)

def _direction(r: TransportRoute, direction: int) -> Optional[RouteDirection]:
    return next((d for d in r.directions if d.direction == direction), None)

def _authed_driver(session_token: str) -> dict:
    cleanup_expired()
    s = DRIVER_SESSIONS.get(session_token)
    if not s:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return s

def _pseudonym() -> str:
    return "bus-" + uuid.uuid4().hex[:6]

def _routes_serving_destination(destination_id: str) -> List[dict]:
    """Return [{route_id, direction, served_progress}] for routes that can drop
    a passenger at destination_id along a direction (i.e., destination is
    ahead on that direction)."""
    result = []
    for r in ROUTES:
        for d in r.directions:
            for s in d.served:
                if s["destination_id"] == destination_id:
                    result.append({
                        "route_id": r.id, "direction": d.direction,
                        "route_name_ar": r.name_ar,
                        "destination_progress": s["progress"],
                        "total_km": d.total_km,
                    })
    return result

# ---------------------------------------------------------------------------
# API: catalog
# ---------------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"service": "Mowasalat", "status": "ok"}

@api_router.get("/destinations", response_model=List[Destination])
async def list_destinations():
    return DESTINATIONS

@api_router.get("/routes", response_model=List[TransportRoute])
async def list_routes():
    return ROUTES

# ---------------------------------------------------------------------------
# API: driver auth (MOCK OTP - any 6-digit code accepted)
# ---------------------------------------------------------------------------
@api_router.post("/driver/otp/request")
async def driver_otp_request(body: OtpRequestIn):
    if not body.phone or len(body.phone) < 6:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    # MOCK: no SMS sent. Any 6-digit code is accepted on verify.
    logger.info("[MOCK OTP] Would send code to %s (accept any 6-digit code)", body.phone)
    return {"sent": True, "mock": True, "hint": "Enter any 6 digits"}

@api_router.post("/driver/otp/verify", response_model=DriverSessionOut)
async def driver_otp_verify(body: OtpVerifyIn):
    if not (body.code.isdigit() and len(body.code) == 6):
        raise HTTPException(status_code=400, detail="Code must be 6 digits")
    # Upsert driver by phone (minimal data).
    existing = await db.drivers.find_one({"phone": body.phone}, {"_id": 0})
    if not existing:
        driver_id = str(uuid.uuid4())
        doc = {
            "id": driver_id,
            "phone": body.phone,
            "name": None,
            "assigned_route_ids": DEFAULT_ASSIGNED,
            "verification_tier": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.drivers.insert_one(doc)
        existing = doc
    token = uuid.uuid4().hex
    DRIVER_SESSIONS[token] = {
        "driver_id": existing["id"], "phone": existing["phone"],
        "expires_at": now_ts() + SESSION_TTL_SEC,
    }
    return DriverSessionOut(
        session_token=token,
        driver_id=existing["id"],
        phone=existing["phone"],
        name=existing.get("name"),
        assigned_route_ids=existing.get("assigned_route_ids", DEFAULT_ASSIGNED),
    )

# ---------------------------------------------------------------------------
# API: driver trips
# ---------------------------------------------------------------------------
@api_router.post("/driver/trip/start", response_model=TripOut)
async def driver_trip_start(body: StartTripIn):
    s = _authed_driver(body.session_token)
    r = _route(body.route_id)
    if not r:
        raise HTTPException(status_code=404, detail="Route not found")
    d = _direction(r, body.direction)
    if not d:
        raise HTTPException(status_code=404, detail="Direction not found")
    # End any prior active trip for this driver
    for tid, tr in list(ACTIVE_TRIPS.items()):
        if tr.get("driver_id") == s["driver_id"]:
            ACTIVE_TRIPS.pop(tid, None)
    trip_id = uuid.uuid4().hex
    pseudonym = _pseudonym()
    ACTIVE_TRIPS[trip_id] = {
        "driver_id": s["driver_id"],
        "route_id": body.route_id,
        "direction": body.direction,
        "progress_km": 0.0,
        "speed_kmh": 40.0,
        "updated_at": now_ts(),
        "pseudonym": pseudonym,
    }
    return TripOut(trip_id=trip_id, route_id=body.route_id, direction=body.direction,
                   progress_km=0.0, speed_kmh=40.0, pseudonym=pseudonym)

@api_router.post("/driver/trip/progress", response_model=TripOut)
async def driver_trip_progress(body: TripProgressIn):
    s = _authed_driver(body.session_token)
    tr = ACTIVE_TRIPS.get(body.trip_id)
    if not tr or tr["driver_id"] != s["driver_id"]:
        raise HTTPException(status_code=404, detail="Trip not found")
    r = _route(tr["route_id"]); d = _direction(r, tr["direction"])
    max_km = d.total_km if d else body.progress_km
    tr["progress_km"] = max(0.0, min(body.progress_km, max_km))
    tr["speed_kmh"] = max(0.0, min(body.speed_kmh, 120.0))
    tr["updated_at"] = now_ts()
    return TripOut(trip_id=body.trip_id, route_id=tr["route_id"], direction=tr["direction"],
                   progress_km=tr["progress_km"], speed_kmh=tr["speed_kmh"],
                   pseudonym=tr["pseudonym"])

@api_router.post("/driver/trip/end")
async def driver_trip_end(body: EndTripIn):
    s = _authed_driver(body.session_token)
    tr = ACTIVE_TRIPS.get(body.trip_id)
    if not tr or tr["driver_id"] != s["driver_id"]:
        raise HTTPException(status_code=404, detail="Trip not found")
    ACTIVE_TRIPS.pop(body.trip_id, None)
    return {"ended": True}

@api_router.get("/driver/trip/{trip_id}/waiting", response_model=List[WaitingPassengerForDriver])
async def driver_trip_waiting(trip_id: str, session_token: str):
    s = _authed_driver(session_token)
    tr = ACTIVE_TRIPS.get(trip_id)
    if not tr or tr["driver_id"] != s["driver_id"]:
        raise HTTPException(status_code=404, detail="Trip not found")
    cleanup_expired()
    ahead = []
    for w in WAITING_REQUESTS.values():
        if w["state"] != "waiting": continue
        if w["route_id"] != tr["route_id"] or w["direction"] != tr["direction"]:
            continue
        gap = w["wait_progress_km"] - tr["progress_km"]
        if gap > -0.2:  # tolerate slight backward
            ahead.append(gap)
    # Aggregate passengers within 300m buckets
    buckets: Dict[float, int] = {}
    for g in ahead:
        key = round(max(0.0, g) / 0.3) * 0.3
        buckets[key] = buckets.get(key, 0) + 1
    out = [WaitingPassengerForDriver(distance_km=round(k, 2), count=v)
           for k, v in sorted(buckets.items())]
    return out

# ---------------------------------------------------------------------------
# API: passenger
# ---------------------------------------------------------------------------
@api_router.get("/passenger/buses", response_model=List[ApproachingBus])
async def passenger_buses(destination_id: str, from_progress_km: float = 0.0,
                          route_id: Optional[str] = None, direction: Optional[int] = None):
    """Return approaching buses that can reach `destination_id` and are before
    or at the passenger's location on the corridor.
    `route_id` + `direction` narrow the response to the passenger's chosen
    line; if omitted, all routes serving the destination are considered.
    """
    cleanup_expired()
    serving = _routes_serving_destination(destination_id)
    if route_id is not None and direction is not None:
        serving = [x for x in serving if x["route_id"] == route_id and x["direction"] == direction]
    if not serving:
        return []
    out: List[ApproachingBus] = []
    for tr in ACTIVE_TRIPS.values():
        match = next((x for x in serving if x["route_id"] == tr["route_id"] and x["direction"] == tr["direction"]), None)
        if not match: continue
        dest_km = match["destination_progress"] * match["total_km"]
        # Only include buses that are before or at destination and before or at passenger
        if tr["progress_km"] > dest_km + 0.2: continue
        if tr["progress_km"] > from_progress_km + 0.5: continue  # bus is past the passenger
        distance = max(0.0, from_progress_km - tr["progress_km"])
        speed = max(15.0, tr.get("speed_kmh", 30.0))
        eta_min = int(round((distance / speed) * 60))
        if distance < 0.4:      state = "very_near"
        elif distance < 1.2:    state = "near"
        else:                   state = "coming"
        out.append(ApproachingBus(pseudonym=tr["pseudonym"], distance_km=round(distance, 2),
                                  eta_min=max(0, eta_min), state=state))
    out.sort(key=lambda b: b.distance_km)
    return out

@api_router.post("/passenger/wait", response_model=WaitOut)
async def passenger_wait(body: WaitCreateIn):
    r = _route(body.route_id)
    if not r or not _direction(r, body.direction):
        raise HTTPException(status_code=404, detail="Route/direction not found")
    if not any(d.id == body.destination_id for d in DESTINATIONS):
        raise HTTPException(status_code=404, detail="Destination not found")
    wid = uuid.uuid4().hex
    WAITING_REQUESTS[wid] = {
        "wait_id": wid,
        "route_id": body.route_id,
        "direction": body.direction,
        "destination_id": body.destination_id,
        "wait_progress_km": max(0.0, body.wait_progress_km),
        "created_at": now_ts(),
        "expires_at": now_ts() + WAIT_TTL_SEC,
        "state": "waiting",
    }
    # Aggregate analytics: increment request counter (no personal data)
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    await db.demand_stats.update_one(
        {"destination_id": body.destination_id, "hour": hour},
        {"$inc": {"requests": 1}},
        upsert=True,
    )
    return WaitOut(wait_id=wid, destination_id=body.destination_id,
                   route_id=body.route_id, direction=body.direction,
                   wait_progress_km=body.wait_progress_km,
                   expires_at=WAITING_REQUESTS[wid]["expires_at"])

@api_router.get("/passenger/wait/{wait_id}/status")
async def passenger_wait_status(wait_id: str):
    cleanup_expired()
    w = WAITING_REQUESTS.get(wait_id)
    if not w:
        raise HTTPException(status_code=404, detail="Wait expired or not found")
    buses = await passenger_buses(destination_id=w["destination_id"],
                                   from_progress_km=w["wait_progress_km"],
                                   route_id=w["route_id"], direction=w["direction"])
    return {
        "wait_id": wait_id, "state": w["state"],
        "expires_at": w["expires_at"],
        "buses": [b.dict() for b in buses],
    }

@api_router.post("/passenger/wait/{wait_id}/board")
async def passenger_wait_board(wait_id: str):
    w = WAITING_REQUESTS.pop(wait_id, None)
    if not w:
        raise HTTPException(status_code=404, detail="Wait not found")
    return {"boarded": True}

@api_router.post("/passenger/wait/{wait_id}/cancel")
async def passenger_wait_cancel(wait_id: str):
    w = WAITING_REQUESTS.pop(wait_id, None)
    if not w:
        raise HTTPException(status_code=404, detail="Wait not found")
    return {"cancelled": True}

# ---------------------------------------------------------------------------
# Admin/debug (safe read-only aggregates)
# ---------------------------------------------------------------------------
@api_router.get("/admin/state")
async def admin_state():
    cleanup_expired()
    return {
        "active_trips": len(ACTIVE_TRIPS),
        "waiting_requests": len(WAITING_REQUESTS),
        "sessions": len(DRIVER_SESSIONS),
    }

app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
