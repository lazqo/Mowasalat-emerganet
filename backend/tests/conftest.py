"""In-process test harness: FastAPI TestClient + fakeredis + mongomock.
No live server or network needed. Set TEST_REDIS_URL to run the same suite
against a real Redis (one logical db per xdist worker, flushed per app)."""
import asyncio
import os

import pytest
from fakeredis import aioredis as fakeredis_aio
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient
from redis.asyncio import Redis

from wenak.config import Settings
from wenak.main import create_app


def make_settings(**over) -> Settings:
    base = dict(environment="test", mongo_url="", redis_url="", allow_inmemory_state=True,
                otp_provider="mock", admin_token="test-admin-token", cors_origins=["http://localhost:8081"],
                otp_resend_cooldown_sec=0, otp_requests_per_hour_per_phone=1000,
                otp_requests_per_hour_per_ip=100000, passenger_wait_per_minute_per_ip=100000,
                read_per_minute_per_ip=1000000)
    base.update(over)
    return Settings(**base)


def _redis():
    url = os.environ.get("TEST_REDIS_URL")
    if not url:
        return fakeredis_aio.FakeRedis(decode_responses=True)
    worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
    db = int(worker[2:]) if worker.startswith("gw") else 0

    async def _flush():
        r = Redis.from_url(url, db=db, decode_responses=True)
        await r.flushdb()
        await r.aclose()
    asyncio.run(_flush())
    return Redis.from_url(url, db=db, decode_responses=True)


@pytest.fixture
def app_client():
    def _make(**over):
        app = create_app(make_settings(**over), redis=_redis(), db=AsyncMongoMockClient()["wenak_test"])
        return TestClient(app)
    return _make


@pytest.fixture
def client(app_client):
    with app_client() as c:
        yield c
