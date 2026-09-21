"""Pydantic models. Note what is deliberately absent: no lat/lng anywhere."""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .phone import normalize_phone

Direction = Literal[0, 1]


class Stop(BaseModel):
    """A named point along a corridor. Progress is km from the direction's origin."""
    stop_id: str
    name_ar: str
    name_en: Optional[str] = None
    progress_km: float
    kind: Literal["hub", "village", "terminus"] = "village"


class RouteDirection(BaseModel):
    direction: Direction
    origin_id: str
    destination_id: str
    origin_name_ar: str
    destination_name_ar: str
    served: List[Stop]
    total_km: float


class TransportRoute(BaseModel):
    id: str
    name_ar: str
    name_en: str
    directions: List[RouteDirection]
    # True while the corridor/stops come from an unverified OSM trace.
    provisional: bool = True


class Destination(BaseModel):
    id: str
    name_ar: str
    name_en: str


# ---- driver auth ---------------------------------------------------------
class OtpRequestIn(BaseModel):
    phone: str = Field(min_length=6, max_length=20)

    @field_validator("phone")
    @classmethod
    def _norm(cls, v: str) -> str:
        return normalize_phone(v)


class OtpVerifyIn(BaseModel):
    phone: str = Field(min_length=6, max_length=20)
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")

    @field_validator("phone")
    @classmethod
    def _norm(cls, v: str) -> str:
        return normalize_phone(v)


class DriverSessionOut(BaseModel):
    session_token: str
    driver_id: str
    phone: str
    name: Optional[str] = None
    assigned_route_ids: List[str]
    expires_at: float


# ---- driver trips --------------------------------------------------------
class StartTripIn(BaseModel):
    route_id: str = Field(max_length=64)
    direction: Direction


class TripProgressIn(BaseModel):
    """Route-relative position only. `zone` is a coarse phone-computed label
    (e.g. "on_corridor", "off_corridor", "at_hub") for future use; it is
    never a coordinate."""
    trip_id: str = Field(max_length=64)
    progress_km: float = Field(ge=0, le=500)
    speed_kmh: float = Field(default=40.0, ge=0, le=150)
    zone: Optional[str] = Field(default=None, max_length=32)


class EndTripIn(BaseModel):
    trip_id: str = Field(max_length=64)


class TripOut(BaseModel):
    trip_id: str
    route_id: str
    direction: Direction
    progress_km: float
    speed_kmh: float
    zone: Optional[str] = None
    pseudonym: str
    expires_at: float


# ---- passenger -----------------------------------------------------------
class WaitCreateIn(BaseModel):
    """Either a chosen stop (`stop_id`) or a phone-computed route-relative
    position (`wait_progress_km`, rounded server-side). Never a coordinate."""
    destination_id: str = Field(max_length=64)
    route_id: str = Field(max_length=64)
    direction: Direction
    wait_progress_km: Optional[float] = Field(default=None, ge=0, le=500)
    stop_id: Optional[str] = Field(default=None, max_length=64)


class WaitOut(BaseModel):
    wait_id: str
    destination_id: str
    route_id: str
    direction: Direction
    wait_progress_km: float
    expires_at: float


class ApproachingBus(BaseModel):
    pseudonym: str
    distance_km: float
    eta_min: int
    state: Literal["coming", "near", "very_near"]


class WaitStatusOut(BaseModel):
    wait_id: str
    state: str
    expires_at: float
    buses: List[ApproachingBus]


class WaitingPassengerForDriver(BaseModel):
    distance_km: float
    count: int
