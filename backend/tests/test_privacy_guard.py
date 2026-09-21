"""Guard: realtime person-movement DTOs must never carry coordinates.

GeoJSON corridor/country-pack models may contain coordinates; this applies
only to payloads that describe where a driver or passenger is right now."""
import inspect
import re

import pytest
from pydantic import BaseModel

from wenak import models
from wenak.routers import driver, passenger

FORBIDDEN = re.compile(r"(^|_)(lat|lng|lon|latitude|longitude|coordinates|coords|geo|position)($|_)", re.I)

MOVEMENT_DTOS = [
    models.TripProgressIn, models.TripOut, models.WaitCreateIn, models.WaitOut,
    models.ApproachingBus, models.WaitStatusOut, models.WaitingPassengerForDriver,
]


def _walk(model, seen=None):
    seen = seen or set()
    for name, f in model.model_fields.items():
        yield model.__name__, name
        ann = f.annotation
        for sub in getattr(ann, "__args__", ()) or (ann,):
            if inspect.isclass(sub) and issubclass(sub, BaseModel) and sub not in seen:
                seen.add(sub)
                yield from _walk(sub, seen)


@pytest.mark.parametrize("model", MOVEMENT_DTOS)
def test_movement_dtos_have_no_coordinate_fields(model):
    for owner, field in _walk(model):
        assert not FORBIDDEN.search(field), f"{owner}.{field} looks like a coordinate"


def test_sse_payloads_have_no_coordinate_keys():
    """The SSE producers build dicts by hand; scan their source for keys."""
    src = inspect.getsource(passenger.passenger_wait_stream) + inspect.getsource(passenger.passenger_buses_stream) \
        + inspect.getsource(driver.trip_stream)
    for key in re.findall(r'"(\w+)":', src):
        assert not FORBIDDEN.search(key), f"SSE payload key {key!r} looks like a coordinate"


def test_progress_endpoint_rejects_coordinates(client):
    from tests.helpers import auth, login
    h = auth(login(client, "+962790000090"))
    t = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
    body = {"trip_id": t["trip_id"], "progress_km": 1.0, "lat": 32.5, "lng": 35.8}
    r = client.post("/api/driver/trip/progress", json=body, headers=h)
    # Unknown fields are dropped, never stored
    assert r.status_code == 200
    tr = client.portal.call(client.app.state.redis.hgetall, f"trip:{t['trip_id']}")
    assert not any(FORBIDDEN.search(k) for k in tr)
