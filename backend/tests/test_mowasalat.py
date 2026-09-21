"""Mowasalat backend API tests - full end-to-end coverage."""
import os
import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-connect-17.preview.emergentagent.com').rstrip('/')
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    ses = requests.Session()
    ses.headers.update({"Content-Type": "application/json"})
    return ses


# ---------- Catalog ----------
class TestCatalog:
    def test_root(self, s):
        r = s.get(f"{API}/")
        assert r.status_code == 200
        assert r.json().get("status") == "ok"

    def test_destinations(self, s):
        r = s.get(f"{API}/destinations")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 7
        ids = {d["id"] for d in data}
        assert {"irbid", "malka", "umm_qais", "kufr_soum", "habras", "sama_rousan", "hakama"} <= ids
        for d in data:
            assert "_id" not in d
            assert d["name_ar"] and d["name_en"]

    def test_routes(self, s):
        r = s.get(f"{API}/routes")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 5
        for rt in data:
            assert len(rt["directions"]) == 2
            for d in rt["directions"]:
                assert d["direction"] in (0, 1)
                assert d["total_km"] > 0
                assert len(d["served"]) >= 2


# ---------- Driver OTP ----------
class TestOtp:
    def test_otp_request(self, s):
        r = s.post(f"{API}/driver/otp/request", json={"phone": "+962777777777"})
        assert r.status_code == 200
        assert r.json().get("sent") is True

    def test_otp_request_invalid_phone(self, s):
        r = s.post(f"{API}/driver/otp/request", json={"phone": "12"})
        assert r.status_code == 400

    def test_otp_verify_bad_code(self, s):
        r = s.post(f"{API}/driver/otp/verify", json={"phone": "+962777777777", "code": "12345"})
        assert r.status_code == 400
        r = s.post(f"{API}/driver/otp/verify", json={"phone": "+962777777777", "code": "abcdef"})
        assert r.status_code == 400

    def test_otp_verify_ok(self, s):
        r = s.post(f"{API}/driver/otp/verify", json={"phone": "+962777777778", "code": "123456"})
        assert r.status_code == 200
        data = r.json()
        assert data["session_token"]
        assert data["phone"] == "+962777777778"
        assert len(data["assigned_route_ids"]) == 5


# ---------- End-to-end trip + passenger matching ----------
@pytest.fixture(scope="module")
def driver_session(s):
    r = s.post(f"{API}/driver/otp/verify", json={"phone": "+962700000001", "code": "654321"})
    assert r.status_code == 200
    return r.json()


class TestTripLifecycle:
    def test_bad_session_401(self, s):
        r = s.post(f"{API}/driver/trip/start",
                   json={"session_token": "bad", "route_id": "irbid_malka", "direction": 0})
        assert r.status_code == 401

    def test_full_flow(self, s, driver_session):
        token = driver_session["session_token"]
        # Start trip
        r = s.post(f"{API}/driver/trip/start",
                   json={"session_token": token, "route_id": "irbid_malka", "direction": 0})
        assert r.status_code == 200
        trip = r.json()
        trip_id = trip["trip_id"]
        assert trip["progress_km"] == 0.0
        assert trip["pseudonym"].startswith("bus-")

        # Passenger creates wait for malka on irbid_malka dir 0
        # total_km = 18; malka progress = 1.0 -> passenger at 18km ahead
        w = s.post(f"{API}/passenger/wait", json={
            "destination_id": "malka",
            "route_id": "irbid_malka",
            "direction": 0,
            "wait_progress_km": 9.0,
        })
        assert w.status_code == 200
        wait_id = w.json()["wait_id"]

        # Buses endpoint: at progress 0, bus 9km away
        r = s.get(f"{API}/passenger/buses",
                  params={"destination_id": "malka", "route_id": "irbid_malka",
                          "direction": 0, "from_progress_km": 9.0})
        assert r.status_code == 200
        buses = r.json()
        assert len(buses) >= 1
        our = next((b for b in buses if b["pseudonym"] == trip["pseudonym"]), None)
        assert our is not None
        assert abs(our["distance_km"] - 9.0) < 0.1
        assert our["state"] == "coming"

        # Advance driver -> near
        r = s.post(f"{API}/driver/trip/progress", json={
            "session_token": token, "trip_id": trip_id,
            "progress_km": 8.0, "speed_kmh": 40.0,
        })
        assert r.status_code == 200
        assert r.json()["progress_km"] == 8.0

        r = s.get(f"{API}/passenger/wait/{wait_id}/status")
        assert r.status_code == 200
        st = r.json()
        near = next((b for b in st["buses"] if b["pseudonym"] == trip["pseudonym"]), None)
        assert near is not None
        assert near["state"] == "near"

        # Advance to very_near
        s.post(f"{API}/driver/trip/progress", json={
            "session_token": token, "trip_id": trip_id,
            "progress_km": 8.8, "speed_kmh": 40.0,
        })
        r = s.get(f"{API}/passenger/wait/{wait_id}/status")
        vn = next((b for b in r.json()["buses"] if b["pseudonym"] == trip["pseudonym"]), None)
        assert vn["state"] == "very_near"

        # Progress cap
        r = s.post(f"{API}/driver/trip/progress", json={
            "session_token": token, "trip_id": trip_id,
            "progress_km": 9999.0, "speed_kmh": 40.0,
        })
        assert r.json()["progress_km"] == 18.0  # capped to total_km

        # Driver waiting endpoint - passenger was at 9km, driver now at 18km => none ahead
        r = s.get(f"{API}/driver/trip/{trip_id}/waiting",
                  params={"session_token": token})
        assert r.status_code == 200

        # Bad session for waiting
        r = s.get(f"{API}/driver/trip/{trip_id}/waiting", params={"session_token": "bad"})
        assert r.status_code == 401

        # Board wait
        r = s.post(f"{API}/passenger/wait/{wait_id}/board")
        assert r.status_code == 200
        r = s.get(f"{API}/passenger/wait/{wait_id}/status")
        assert r.status_code == 404

        # End trip
        r = s.post(f"{API}/driver/trip/end", json={"session_token": token, "trip_id": trip_id})
        assert r.status_code == 200


class TestWaitCancel:
    def test_cancel(self, s):
        w = s.post(f"{API}/passenger/wait", json={
            "destination_id": "umm_qais", "route_id": "irbid_umm_qais",
            "direction": 0, "wait_progress_km": 5.0,
        })
        assert w.status_code == 200
        wid = w.json()["wait_id"]
        r = s.post(f"{API}/passenger/wait/{wid}/cancel")
        assert r.status_code == 200
        r = s.post(f"{API}/passenger/wait/{wid}/cancel")
        assert r.status_code == 404

    def test_bad_route(self, s):
        r = s.post(f"{API}/passenger/wait", json={
            "destination_id": "malka", "route_id": "nonexistent",
            "direction": 0, "wait_progress_km": 1.0,
        })
        assert r.status_code == 404


class TestPrivacy:
    def test_admin_only_counts(self, s):
        r = s.get(f"{API}/admin/state")
        assert r.status_code == 200
        data = r.json()
        assert set(data.keys()) == {"active_trips", "waiting_requests", "sessions"}

    def test_no_gps_in_buses(self, s):
        r = s.get(f"{API}/passenger/buses",
                  params={"destination_id": "malka"})
        for b in r.json():
            assert "lat" not in b and "lng" not in b and "gps" not in b
            assert b["pseudonym"].startswith("bus-")
