"""Pure functions that turn route-relative positions into what each side sees.

Inputs are km along a direction. No coordinates exist at this layer.
"""
from __future__ import annotations

from typing import Dict, Iterable, List

from .models import ApproachingBus, WaitingPassengerForDriver

BUS_PAST_PASSENGER_SLACK_KM = 0.5   # bus slightly past the passenger still counts
BUS_PAST_DEST_SLACK_KM = 0.2
VERY_NEAR_KM = 0.4
NEAR_KM = 1.2
MIN_SPEED_FOR_ETA = 15.0
DRIVER_BUCKET_KM = 0.3
DRIVER_BEHIND_TOLERANCE_KM = 0.2


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def approaching_buses(trips: Iterable[Dict[str, str]], passenger_km: float, destination_km: float) -> List[ApproachingBus]:
    out: List[ApproachingBus] = []
    for tr in trips:
        bus_km = _f(tr.get("progress_km"))
        if bus_km > destination_km + BUS_PAST_DEST_SLACK_KM:
            continue
        if bus_km > passenger_km + BUS_PAST_PASSENGER_SLACK_KM:
            continue
        distance = max(0.0, passenger_km - bus_km)
        speed = max(MIN_SPEED_FOR_ETA, _f(tr.get("speed_kmh"), 30.0))
        eta_min = max(0, int(round((distance / speed) * 60)))
        state = "very_near" if distance < VERY_NEAR_KM else "near" if distance < NEAR_KM else "coming"
        out.append(ApproachingBus(pseudonym=tr["pseudonym"], distance_km=round(distance, 2),
                                  eta_min=eta_min, state=state))
    out.sort(key=lambda b: b.distance_km)
    return out


def waiting_ahead(waits: Iterable[Dict[str, str]], bus_km: float) -> List[WaitingPassengerForDriver]:
    buckets: Dict[float, int] = {}
    for w in waits:
        if w.get("state") != "waiting":
            continue
        gap = _f(w.get("wait_progress_km")) - bus_km
        if gap < -DRIVER_BEHIND_TOLERANCE_KM:
            continue
        key = round(max(0.0, gap) / DRIVER_BUCKET_KM) * DRIVER_BUCKET_KM
        buckets[key] = buckets.get(key, 0) + 1
    return [WaitingPassengerForDriver(distance_km=round(k, 2), count=v) for k, v in sorted(buckets.items())]
