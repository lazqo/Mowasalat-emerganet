"""Server-sent event streams. Each generator polls Redis on a short tick and
emits only when the payload changes (plus a periodic keepalive), then ends
when the underlying wait/trip is gone or the maximum stream age is reached.
The client reconnects for long waits."""
from __future__ import annotations

import asyncio
import json
import time
from typing import AsyncIterator, Awaitable, Callable, Optional

from fastapi import Request
from fastapi.responses import StreamingResponse

from .config import Settings

SSE_HEADERS = {"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


def _frame(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


async def stream(request: Optional[Request], settings: Settings, event: str,
                 produce: Callable[[], Awaitable[Optional[dict]]]) -> AsyncIterator[str]:
    """Yield SSE frames from `produce()`. `produce` returns the current payload
    or None when the subject no longer exists (-> `ended` event)."""
    started = time.monotonic()
    last_payload = None
    last_sent = 0.0
    yield ": connected\n\n"
    while True:
        if request is not None and await request.is_disconnected():
            return
        payload = await produce()
        if payload is None:
            yield _frame("ended", {"reason": "gone"})
            return
        now = time.monotonic()
        if payload != last_payload or now - last_sent >= settings.sse_keepalive_sec:
            yield _frame(event, payload)
            last_payload, last_sent = payload, now
        if now - started >= settings.sse_max_sec:
            yield _frame("ended", {"reason": "max_age", "reconnect": True})
            return
        await asyncio.sleep(settings.sse_tick_sec)


def sse_response(gen: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)
