import json

from tests.helpers import auth, login


def _events(client, url, headers=None, want=1):
    """Read up to `want` events from an SSE endpoint (stream ends by itself:
    sse_max_sec is tiny in the fixture)."""
    out = []
    with client.stream("GET", url, headers=headers or {}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        ev = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: ") and ev:
                out.append((ev, json.loads(line[6:])))
                ev = None
                if len(out) >= want:
                    break
    return out


def test_passenger_wait_stream_and_ended(app_client):
    with app_client(sse_tick_sec=0.02, sse_max_sec=0.5) as c:
        h = auth(login(c, "+962790000050"))
        t = c.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
        w = c.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                "direction": 0, "wait_progress_km": 9.0}).json()
        ev = _events(c, f"/api/passenger/wait/{w['wait_id']}/stream")
        assert ev[0][0] == "status"
        assert ev[0][1]["buses"][0]["pseudonym"] == t["pseudonym"]
        assert set(ev[0][1]["buses"][0]) == {"pseudonym", "distance_km", "eta_min", "state"}
        # boarded -> stream reports ended
        c.post(f"/api/passenger/wait/{w['wait_id']}/board")
        ev = _events(c, f"/api/passenger/wait/{w['wait_id']}/stream")
        assert ev[0] == ("ended", {"reason": "gone"})


def test_buses_stream_before_wait(app_client):
    with app_client(sse_tick_sec=0.02, sse_max_sec=0.3) as c:
        ev = _events(c, "/api/passenger/buses/stream?destination_id=malka&route_id=irbid_malka&direction=0&from_progress_km=3")
        assert ev[0] == ("buses", {"buses": []})


def test_driver_stream_requires_auth_and_shows_demand(app_client):
    with app_client(sse_tick_sec=0.02, sse_max_sec=0.5) as c:
        h = auth(login(c, "+962790000051"))
        t = c.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
        assert c.get(f"/api/driver/trip/{t['trip_id']}/stream").status_code == 401
        c.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                            "direction": 0, "stop_id": "hor"})
        ev = _events(c, f"/api/driver/trip/{t['trip_id']}/stream", headers=h)
        assert ev[0][0] == "demand"
        assert ev[0][1]["total_waiting"] == 1 and ev[0][1]["waiting"] == [{"distance_km": 9.0, "count": 1}]
        # stream hits max age and asks the client to reconnect
        ev = _events(c, f"/api/driver/trip/{t['trip_id']}/stream", headers=h, want=5)
        assert ev[-1][0] == "ended" and ev[-1][1]["reconnect"] is True
