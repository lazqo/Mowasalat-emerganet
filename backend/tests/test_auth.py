from tests.helpers import auth, login


def test_otp_request_normalises_phone_and_returns_dev_code(client):
    r = client.post("/api/driver/otp/request", json={"phone": "0790000001"})
    assert r.status_code == 200
    j = r.json()
    assert j["sent"] is True and j["provider"] == "mock" and len(j["dev_code"]) == 6


def test_otp_request_rejects_bad_phone(client):
    assert client.post("/api/driver/otp/request", json={"phone": "12"}).status_code == 422
    assert client.post("/api/driver/otp/request", json={"phone": "+962123"}).status_code == 422


def test_otp_verify_requires_requested_code(client):
    r = client.post("/api/driver/otp/verify", json={"phone": "+962790000009", "code": "123456"})
    assert r.status_code == 400


def test_otp_wrong_code_then_right_code_is_one_use(client):
    phone = "+962790000002"
    code = client.post("/api/driver/otp/request", json={"phone": phone}).json()["dev_code"]
    wrong = f"{(int(code) + 1) % 1000000:06d}"
    assert client.post("/api/driver/otp/verify", json={"phone": phone, "code": wrong}).status_code == 400
    ok = client.post("/api/driver/otp/verify", json={"phone": phone, "code": code})
    assert ok.status_code == 200
    assert ok.json()["assigned_route_ids"] == ["irbid_malka", "irbid_sama_rousan", "irbid_kufr_soum", "irbid_habras", "irbid_umm_qais"]
    # one use: replay fails
    assert client.post("/api/driver/otp/verify", json={"phone": phone, "code": code}).status_code == 400


def test_otp_attempt_limit_locks_challenge(app_client):
    with app_client(otp_max_attempts=3) as c:
        phone = "+962790000003"
        code = c.post("/api/driver/otp/request", json={"phone": phone}).json()["dev_code"]
        for _ in range(3):
            assert c.post("/api/driver/otp/verify", json={"phone": phone, "code": "000000"}).status_code in (400,)
        r = c.post("/api/driver/otp/verify", json={"phone": phone, "code": code})
        assert r.status_code == 429  # locked, even with the right code


def test_otp_resend_cooldown_and_hourly_limit(app_client):
    with app_client(otp_resend_cooldown_sec=60) as c:
        phone = "+962790000004"
        assert c.post("/api/driver/otp/request", json={"phone": phone}).status_code == 200
        assert c.post("/api/driver/otp/request", json={"phone": phone}).status_code == 429
    with app_client(otp_requests_per_hour_per_phone=2) as c:
        phone = "+962790000005"
        assert c.post("/api/driver/otp/request", json={"phone": phone}).status_code == 200
        assert c.post("/api/driver/otp/request", json={"phone": phone}).status_code == 200
        assert c.post("/api/driver/otp/request", json={"phone": phone}).status_code == 429


def test_dev_code_never_returned_in_production(app_client):
    with app_client(environment="production", cors_origins=["https://app.example"]) as c:
        j = c.post("/api/driver/otp/request", json={"phone": "+962790000006"}).json()
        assert "dev_code" not in j


def test_bearer_session_and_logout(client):
    sess = login(client)
    me = client.get("/api/driver/me", headers=auth(sess))
    assert me.status_code == 200 and me.json()["phone"] == "+962790000001"
    assert client.get("/api/driver/me").status_code == 401
    assert client.get("/api/driver/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/api/driver/logout", headers=auth(sess)).status_code == 200
    assert client.get("/api/driver/me", headers=auth(sess)).status_code == 401


def test_session_token_not_stored_in_clear(client):
    sess = login(client)
    keys = client.portal.call(client.app.state.redis.keys, "session:*")
    assert keys and all(sess["session_token"] not in k for k in keys)


def test_admin_requires_token(client):
    assert client.get("/api/admin/state").status_code == 403
    r = client.get("/api/admin/state", headers={"X-Admin-Token": "test-admin-token"})
    assert r.status_code == 200 and set(r.json()) == {"active_trips", "waiting_requests", "sessions"}


def test_admin_disabled_without_token_config(app_client):
    with app_client(admin_token="") as c:
        assert c.get("/api/admin/state", headers={"X-Admin-Token": "x"}).status_code == 404
