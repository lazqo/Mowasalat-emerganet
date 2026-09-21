"""Shared test helpers."""
from fastapi.testclient import TestClient


def login(c: TestClient, phone: str = "+962790000001") -> dict:
    r = c.post("/api/driver/otp/request", json={"phone": phone})
    assert r.status_code == 200, r.text
    code = r.json()["dev_code"]
    r = c.post("/api/driver/otp/verify", json={"phone": phone, "code": code})
    assert r.status_code == 200, r.text
    return r.json()


def auth(session: dict) -> dict:
    return {"Authorization": f"Bearer {session['session_token']}"}
