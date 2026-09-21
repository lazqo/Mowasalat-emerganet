"""Aggregate demand analytics with minimum-cell suppression.

What is counted: "someone pressed I'm waiting" as (route, direction,
corridor segment, hour). No identity, no exact position, no timestamp.

How it reaches MongoDB: counts accumulate in Redis (TTL) while the hour is
open. When an hour closes, each cell is written to Mongo only if it holds at
least `analytics_k_min` requests. Smaller cells are merged into a per-day
(route, direction) remainder, which is itself written only once it reaches
the threshold; otherwise it expires from Redis unwritten. A lone passenger
therefore never becomes a row.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from .config import Settings
from .state import RealtimeStore

logger = logging.getLogger(__name__)

CELL_TTL_SEC = 3 * 3600
PENDING_TTL_SEC = 48 * 3600


def hour_bucket(t: datetime | None = None) -> str:
    return (t or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H")


def segment_of(progress_km: float, settings: Settings) -> int:
    return int(max(0.0, progress_km) // settings.analytics_segment_km)


async def record_wait(store: RealtimeStore, settings: Settings, route_id: str, direction: int,
                      progress_km: float, when: datetime | None = None) -> None:
    bucket = hour_bucket(when)
    seg = segment_of(progress_km, settings)
    key = f"dem:{bucket}:{route_id}:{direction}:{seg}"
    pipe = store.r.pipeline()
    pipe.incr(key)
    pipe.expire(key, CELL_TTL_SEC)
    pipe.sadd(f"dem_idx:{bucket}", key)
    pipe.expire(f"dem_idx:{bucket}", CELL_TTL_SEC)
    await pipe.execute()


async def flush_closed_buckets(store: RealtimeStore, db, settings: Settings,
                               now: datetime | None = None) -> Dict[str, int]:
    """Move closed hourly buckets from Redis to Mongo with k-suppression.
    Returns counters for logging/tests."""
    now = now or datetime.now(timezone.utc)
    current = hour_bucket(now)
    k = settings.analytics_k_min
    stats = {"written": 0, "merged": 0, "coarse_written": 0}
    async for idx_key in store.r.scan_iter(match="dem_idx:*", count=200):
        bucket = idx_key.split(":", 1)[1]
        if bucket >= current:
            continue  # hour still open
        cells: List[str] = list(await store.r.smembers(idx_key))
        for key in cells:
            raw = await store.r.get(key)
            count = int(raw) if raw else 0
            _, b, route_id, direction, seg = key.split(":")
            if count >= k:
                await db.demand_stats.update_one(
                    {"route_id": route_id, "direction": int(direction), "segment": int(seg), "bucket": b},
                    {"$inc": {"requests": count}}, upsert=True)
                stats["written"] += 1
            elif count > 0:
                day = b[:10]
                pkey = f"dem_pending:{route_id}:{direction}:{day}"
                pending = await store.r.incrby(pkey, count)
                await store.r.expire(pkey, PENDING_TTL_SEC)
                stats["merged"] += 1
                if pending >= k:
                    await db.demand_stats.update_one(
                        {"route_id": route_id, "direction": int(direction), "segment": "all", "bucket": day},
                        {"$inc": {"requests": pending}}, upsert=True)
                    await store.r.delete(pkey)
                    stats["coarse_written"] += 1
            await store.r.delete(key)
        await store.r.delete(idx_key)
    return stats


async def flush_loop(store: RealtimeStore, db, settings: Settings) -> None:
    while True:
        try:
            await asyncio.sleep(settings.analytics_flush_sec)
            st = await flush_closed_buckets(store, db, settings)
            if any(st.values()):
                logger.info("demand analytics flushed: %s", st)
        except asyncio.CancelledError:
            raise
        except Exception:  # keep the loop alive
            logger.exception("demand analytics flush failed")
