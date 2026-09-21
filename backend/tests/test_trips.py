import time

from tests.helpers import auth, login


def test_trip_requires_auth_and_valid_route(client):
    assert client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}).status_code == 401
    sess = login(client)
    r = client.post("/api/driver/trip/start", json={"route_id": "nope", "direction": 0}, headers=auth(sess))
    assert r.status_code == 404
    r = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 2}, headers=auth(sess))
    assert r.status_code == 422


def test_full_flow_irbid_to_malka(client):
    sess = login(client, "+962790000010")
    h = auth(sess)
    trip = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
    assert trip["progress_km"] == 0.0 and trip["pseudonym"].startswith("bus-")
    total = next(r for r in client.get("/api/routes").json() if r["id"] == "irbid_malka")["directions"][0]["total_km"]

    # Passenger standing at Hor (9 km) heading to Malka.
    w = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                 "direction": 0, "wait_progress_km": 9.0})
    assert w.status_code == 200
    wait_id = w.json()["wait_id"]

    buses = client.get("/api/passenger/buses", params={"destination_id": "malka", "route_id": "irbid_malka",
                                                       "direction": 0, "from_progress_km": 9.0}).json()
    ours = next(b for b in buses if b["pseudonym"] == trip["pseudonym"])
    assert abs(ours["distance_km"] - 9.0) < 0.01 and ours["state"] == "coming"
    assert set(ours) == {"pseudonym", "distance_km", "eta_min", "state"}

    # Driver sees one passenger ~9 km ahead
    ahead = client.get(f"/api/driver/trip/{trip['trip_id']}/waiting", headers=h).json()
    assert ahead == [{"distance_km": 9.0, "count": 1}]

    # Bus advances -> near -> very near
    r = client.post("/api/driver/trip/progress", json={"trip_id": trip["trip_id"], "progress_km": 8.0,
                                                       "speed_kmh": 40, "zone": "on_corridor"}, headers=h)
    assert r.status_code == 200 and r.json()["progress_km"] == 8.0 and r.json()["zone"] == "on_corridor"
    st = client.get(f"/api/passenger/wait/{wait_id}/status").json()
    assert next(b for b in st["buses"] if b["pseudonym"] == trip["pseudonym"])["state"] == "near"
    client.post("/api/driver/trip/progress", json={"trip_id": trip["trip_id"], "progress_km": 8.8}, headers=h)
    st = client.get(f"/api/passenger/wait/{wait_id}/status").json()
    assert next(b for b in st["buses"] if b["pseudonym"] == trip["pseudonym"])["state"] == "very_near"

    # Progress is capped at the line length; once past the passenger the bus disappears for them
    r = client.post("/api/driver/trip/progress", json={"trip_id": trip["trip_id"], "progress_km": 499}, headers=h)
    assert r.json()["progress_km"] == total
    st = client.get(f"/api/passenger/wait/{wait_id}/status").json()
    assert all(b["pseudonym"] != trip["pseudonym"] for b in st["buses"])
    assert client.get(f"/api/driver/trip/{trip['trip_id']}/waiting", headers=h).json() == []

    # Board, then end. Nothing remains in the realtime store.
    assert client.post(f"/api/passenger/wait/{wait_id}/board").status_code == 200
    assert client.get(f"/api/passenger/wait/{wait_id}/status").status_code == 404
    assert client.post("/api/driver/trip/end", json={"trip_id": trip["trip_id"]}, headers=h).status_code == 200
    assert client.get("/api/driver/trip/current", headers=h).status_code == 404
    counts = client.get("/api/admin/state", headers={"X-Admin-Token": "test-admin-token"}).json()
    assert counts["active_trips"] == 0 and counts["waiting_requests"] == 0


def test_driver_has_one_active_trip(client):
    sess = login(client, "+962790000011"); h = auth(sess)
    t1 = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
    t2 = client.post("/api/driver/trip/start", json={"route_id": "irbid_habras", "direction": 1}, headers=h).json()
    assert client.get("/api/driver/trip/current", headers=h).json()["trip_id"] == t2["trip_id"]
    r = client.post("/api/driver/trip/progress", json={"trip_id": t1["trip_id"], "progress_km": 1}, headers=h)
    assert r.status_code == 404


def test_driver_cannot_touch_another_drivers_trip(client):
    a = auth(login(client, "+962790000012")); b = auth(login(client, "+962790000013"))
    t = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=a).json()
    assert client.post("/api/driver/trip/end", json={"trip_id": t["trip_id"]}, headers=b).status_code == 404
    assert client.get(f"/api/driver/trip/{t['trip_id']}/waiting", headers=b).status_code == 404


def test_shared_corridor_lines_are_matched_separately(client):
    """Habras and Kufr Soum share the road through Sama Al-Rousan, but a
    passenger who chose the Kufr Soum line only sees Kufr Soum buses."""
    h = auth(login(client, "+962790000014"))
    t = client.post("/api/driver/trip/start", json={"route_id": "irbid_habras", "direction": 0}, headers=h).json()
    ks = client.get("/api/passenger/buses", params={"destination_id": "sama_rousan", "route_id": "irbid_kufr_soum",
                                                    "direction": 0, "from_progress_km": 10}).json()
    assert ks == []
    any_line = client.get("/api/passenger/buses", params={"destination_id": "sama_rousan", "from_progress_km": 10}).json()
    assert [b["pseudonym"] for b in any_line] == [t["pseudonym"]]


def test_wait_validation(client):
    bad = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "nonexistent",
                                                   "direction": 0, "wait_progress_km": 1.0})
    assert bad.status_code == 404
    # Malka is not on the Habras line
    bad = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_habras",
                                                   "direction": 0, "wait_progress_km": 1.0})
    assert bad.status_code == 404
    bad = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                   "direction": 0, "wait_progress_km": 99.0})
    assert bad.status_code == 400
    bad = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                   "direction": 0, "wait_progress_km": -1})
    assert bad.status_code == 422
    # Hor is 9 km out; a passenger at 12 km has already passed it
    bad = client.post("/api/passenger/wait", json={"destination_id": "hor", "route_id": "irbid_malka",
                                                   "direction": 0, "wait_progress_km": 12.0})
    assert bad.status_code == 400
    # Cannot wait "for Irbid" on the outbound direction (Irbid is its origin)
    bad = client.post("/api/passenger/wait", json={"destination_id": "irbid", "route_id": "irbid_malka",
                                                   "direction": 0, "wait_progress_km": 1.0})
    assert bad.status_code == 404
    ok = client.post("/api/passenger/wait", json={"destination_id": "irbid", "route_id": "irbid_malka",
                                                  "direction": 1, "wait_progress_km": 1.0})
    assert ok.status_code == 200


def test_wait_cancel_is_idempotent_404(client):
    w = client.post("/api/passenger/wait", json={"destination_id": "umm_qais", "route_id": "irbid_umm_qais",
                                                 "direction": 0, "wait_progress_km": 5.0}).json()
    assert client.post(f"/api/passenger/wait/{w['wait_id']}/cancel").status_code == 200
    assert client.post(f"/api/passenger/wait/{w['wait_id']}/cancel").status_code == 404


def test_waits_and_trips_expire_on_their_own(app_client):
    with app_client(wait_ttl_sec=1, trip_stale_sec=1) as c:
        h = auth(login(c, "+962790000015"))
        t = c.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
        w = c.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                "direction": 0, "wait_progress_km": 2.0}).json()
        time.sleep(1.3)
        assert c.get(f"/api/passenger/wait/{w['wait_id']}/status").status_code == 404
        assert c.post("/api/driver/trip/progress", json={"trip_id": t["trip_id"], "progress_km": 1}, headers=h).status_code == 404
        counts = c.get("/api/admin/state", headers={"X-Admin-Token": "test-admin-token"}).json()
        assert counts["active_trips"] == 0 and counts["waiting_requests"] == 0


def test_rate_limit_on_wait_creation(app_client):
    with app_client(passenger_wait_per_minute_per_ip=2) as c:
        body = {"destination_id": "malka", "route_id": "irbid_malka", "direction": 0, "wait_progress_km": 1.0}
        assert c.post("/api/passenger/wait", json=body).status_code == 200
        assert c.post("/api/passenger/wait", json=body).status_code == 200
        assert c.post("/api/passenger/wait", json=body).status_code == 429


def test_mongo_holds_only_config_and_aggregates(client):
    """Privacy invariant: after a full trip, Mongo has a driver record and an
    hourly counter, and nothing about positions or trips."""
    h = auth(login(client, "+962790000016"))
    t = client.post("/api/driver/trip/start", json={"route_id": "irbid_malka", "direction": 0}, headers=h).json()
    client.post("/api/driver/trip/progress", json={"trip_id": t["trip_id"], "progress_km": 3.3}, headers=h)
    client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                             "direction": 0, "wait_progress_km": 4.4})
    db = client.app.state.db
    names = client.portal.call(db.list_collection_names)
    assert set(names) <= {"drivers", "demand_stats"}
    drivers = client.portal.call(db.drivers.find({}, {"_id": 0}).to_list, 100)
    assert all(set(d) == {"id", "phone", "name", "assigned_route_ids", "verification_tier", "created_at"} for d in drivers)
    stats = client.portal.call(db.demand_stats.find({}, {"_id": 0}).to_list, 100)
    assert all(set(s) == {"destination_id", "hour", "requests"} for s in stats)
