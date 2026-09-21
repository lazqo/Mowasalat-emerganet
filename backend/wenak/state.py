"""Realtime state in Redis. Everything here has a TTL and expires on its own.

Nothing in this module is ever written to MongoDB. Trips are keyed by an
opaque id and carry only route-relative progress; when a trip ends or goes
stale it is deleted, so Redis never accumulates a movement history.

Key layout (all with TTL):
  trip:{trip_id}                 hash   active trip
  trips:{route_id}:{direction}   set    index of trip ids on that line/direction
  driver_trip:{driver_id}        str    the driver's current trip id
  wait:{wait_id}                 hash   passenger waiting request
  waits:{route_id}:{direction}   set    index of wait ids on that line/direction
  session:{sha256(token)}        hash   driver session (token itself is never stored)
  otp:{phone}                    hash   pending OTP challenge (code stored hashed)
  otp_cd:{phone}                 str    resend cooldown marker
  rl:{bucket}:{key}              int    rate-limit counter
"""
from __future__ import annotations

import hashlib
import secrets
import time
from typing import Any, Dict, List, Optional

from redis.asyncio import Redis

from .config import Settings


def now_ts() -> float:
    return time.time()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


class RealtimeStore:
    def __init__(self, redis: Redis, settings: Settings):
        self.r = redis
        self.s = settings

    # ------------------------------------------------------------------ util
    async def ping(self) -> bool:
        return bool(await self.r.ping())

    async def _index_members(self, index_key: str, item_prefix: str) -> List[Dict[str, str]]:
        """Fetch all live hashes referenced by an index set, pruning dead ids."""
        ids = await self.r.smembers(index_key)
        if not ids:
            return []
        pipe = self.r.pipeline()
        for i in ids:
            pipe.hgetall(f"{item_prefix}{i}")
        rows = await pipe.execute()
        out, dead = [], []
        for i, row in zip(ids, rows):
            if row:
                out.append(row)
            else:
                dead.append(i)
        if dead:
            await self.r.srem(index_key, *dead)
        return out

    # ------------------------------------------------------------- sessions
    async def create_session(self, driver_id: str, phone: str) -> tuple[str, float]:
        token = secrets.token_urlsafe(32)
        expires_at = now_ts() + self.s.session_ttl_sec
        key = f"session:{_hash_token(token)}"
        await self.r.hset(key, mapping={"driver_id": driver_id, "phone": phone, "expires_at": expires_at})
        await self.r.expire(key, self.s.session_ttl_sec)
        return token, expires_at

    async def get_session(self, token: str) -> Optional[Dict[str, str]]:
        if not token or len(token) > 128:
            return None
        row = await self.r.hgetall(f"session:{_hash_token(token)}")
        return row or None

    async def delete_session(self, token: str) -> None:
        await self.r.delete(f"session:{_hash_token(token)}")

    # ------------------------------------------------------------------ OTP
    async def put_otp(self, phone: str, code: str) -> None:
        salt = secrets.token_hex(8)
        digest = hashlib.sha256((salt + code).encode()).hexdigest()
        key = f"otp:{phone}"
        await self.r.delete(key)
        await self.r.hset(key, mapping={"salt": salt, "hash": digest, "attempts": 0, "created_at": now_ts()})
        await self.r.expire(key, self.s.otp_ttl_sec)
        if self.s.otp_resend_cooldown_sec > 0:
            await self.r.set(f"otp_cd:{phone}", "1", ex=self.s.otp_resend_cooldown_sec)

    async def otp_in_cooldown(self, phone: str) -> bool:
        return bool(await self.r.exists(f"otp_cd:{phone}"))

    async def verify_otp(self, phone: str, code: str) -> str:
        """Returns "ok", "expired", "locked" or "mismatch". A correct code is
        consumed (one use). Too many wrong attempts delete the challenge."""
        key = f"otp:{phone}"
        row = await self.r.hgetall(key)
        if not row:
            return "expired"
        attempts = await self.r.hincrby(key, "attempts", 1)
        if attempts > self.s.otp_max_attempts:
            await self.r.delete(key)
            return "locked"
        digest = hashlib.sha256((row["salt"] + code).encode()).hexdigest()
        if secrets.compare_digest(digest, row["hash"]):
            await self.r.delete(key)
            return "ok"
        return "mismatch"

    # ---------------------------------------------------------- rate limits
    async def hit(self, bucket: str, key: str, limit: int, window_sec: int) -> bool:
        """Fixed-window counter. Returns True if the request is allowed."""
        k = f"rl:{bucket}:{key}"
        n = await self.r.incr(k)
        if n == 1:
            await self.r.expire(k, window_sec)
        return n <= limit

    # ---------------------------------------------------------------- trips
    async def start_trip(self, driver_id: str, route_id: str, direction: int, pseudonym: str) -> Dict[str, Any]:
        # A driver has at most one active trip.
        prev = await self.r.get(f"driver_trip:{driver_id}")
        if prev:
            await self.end_trip(prev)
        trip_id = secrets.token_hex(16)
        t = now_ts()
        trip = {
            "trip_id": trip_id, "driver_id": driver_id, "route_id": route_id,
            "direction": int(direction), "progress_km": 0.0, "speed_kmh": 0.0,
            "zone": "", "pseudonym": pseudonym, "started_at": t, "updated_at": t,
        }
        ttl = self._trip_ttl(t)
        pipe = self.r.pipeline()
        pipe.hset(f"trip:{trip_id}", mapping=trip)
        pipe.expire(f"trip:{trip_id}", ttl)
        pipe.sadd(f"trips:{route_id}:{direction}", trip_id)
        pipe.expire(f"trips:{route_id}:{direction}", self.s.trip_ttl_sec)
        pipe.set(f"driver_trip:{driver_id}", trip_id, ex=self.s.trip_ttl_sec)
        await pipe.execute()
        trip["expires_at"] = t + ttl
        return trip

    def _trip_ttl(self, started_at: float) -> int:
        """Trip key TTL: stale timeout, but never past the absolute trip cap."""
        remaining_cap = int(started_at + self.s.trip_ttl_sec - now_ts())
        return max(1, min(self.s.trip_stale_sec, remaining_cap))

    async def current_trip_id(self, driver_id: str) -> Optional[str]:
        return await self.r.get(f"driver_trip:{driver_id}")

    async def get_trip(self, trip_id: str) -> Optional[Dict[str, str]]:
        if not trip_id or len(trip_id) > 64:
            return None
        row = await self.r.hgetall(f"trip:{trip_id}")
        return row or None

    async def update_trip(self, trip_id: str, progress_km: float, speed_kmh: float, zone: Optional[str]) -> Optional[Dict[str, Any]]:
        row = await self.get_trip(trip_id)
        if not row:
            return None
        t = now_ts()
        ttl = self._trip_ttl(_f(row.get("started_at"), t))
        mapping = {"progress_km": progress_km, "speed_kmh": speed_kmh, "updated_at": t}
        if zone is not None:
            mapping["zone"] = zone
        pipe = self.r.pipeline()
        pipe.hset(f"trip:{trip_id}", mapping=mapping)
        pipe.expire(f"trip:{trip_id}", ttl)
        await pipe.execute()
        row.update({k: str(v) for k, v in mapping.items()})
        row["expires_at"] = str(t + ttl)
        return row

    async def end_trip(self, trip_id: str) -> bool:
        row = await self.get_trip(trip_id)
        if not row:
            return False
        pipe = self.r.pipeline()
        pipe.delete(f"trip:{trip_id}")
        pipe.srem(f"trips:{row['route_id']}:{row['direction']}", trip_id)
        pipe.delete(f"driver_trip:{row['driver_id']}")
        await pipe.execute()
        return True

    async def trips_on(self, route_id: str, direction: int) -> List[Dict[str, str]]:
        return await self._index_members(f"trips:{route_id}:{direction}", "trip:")

    # ---------------------------------------------------------------- waits
    async def create_wait(self, route_id: str, direction: int, destination_id: str, wait_progress_km: float) -> Dict[str, Any]:
        wait_id = secrets.token_hex(16)
        t = now_ts()
        wait = {
            "wait_id": wait_id, "route_id": route_id, "direction": int(direction),
            "destination_id": destination_id, "wait_progress_km": wait_progress_km,
            "created_at": t, "expires_at": t + self.s.wait_ttl_sec, "state": "waiting",
        }
        pipe = self.r.pipeline()
        pipe.hset(f"wait:{wait_id}", mapping=wait)
        pipe.expire(f"wait:{wait_id}", self.s.wait_ttl_sec)
        pipe.sadd(f"waits:{route_id}:{direction}", wait_id)
        pipe.expire(f"waits:{route_id}:{direction}", self.s.wait_ttl_sec)
        await pipe.execute()
        return wait

    async def get_wait(self, wait_id: str) -> Optional[Dict[str, str]]:
        if not wait_id or len(wait_id) > 64:
            return None
        row = await self.r.hgetall(f"wait:{wait_id}")
        return row or None

    async def delete_wait(self, wait_id: str) -> bool:
        row = await self.get_wait(wait_id)
        if not row:
            return False
        pipe = self.r.pipeline()
        pipe.delete(f"wait:{wait_id}")
        pipe.srem(f"waits:{row['route_id']}:{row['direction']}", wait_id)
        await pipe.execute()
        return True

    async def waits_on(self, route_id: str, direction: int) -> List[Dict[str, str]]:
        return await self._index_members(f"waits:{route_id}:{direction}", "wait:")

    # ---------------------------------------------------------------- admin
    async def counts(self) -> Dict[str, int]:
        out = {"active_trips": 0, "waiting_requests": 0, "sessions": 0}
        async for _ in self.r.scan_iter(match="trip:*", count=500):
            out["active_trips"] += 1
        async for _ in self.r.scan_iter(match="wait:*", count=500):
            out["waiting_requests"] += 1
        async for _ in self.r.scan_iter(match="session:*", count=500):
            out["sessions"] += 1
        return out


async def make_redis(settings: Settings) -> Redis:
    if settings.redis_url:
        return Redis.from_url(settings.redis_url, decode_responses=True)
    if settings.allow_inmemory_state and not settings.is_production:
        from fakeredis import aioredis as fakeredis_aio  # dev/test only
        return fakeredis_aio.FakeRedis(decode_responses=True)
    raise RuntimeError(
        "REDIS_URL is not set. Realtime state must live in Redis (managed Redis in "
        "production). For local development only you may set ALLOW_INMEMORY_STATE=1."
    )
