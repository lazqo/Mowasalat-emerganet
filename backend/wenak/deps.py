"""FastAPI dependencies: stores, auth, rate limiting, admin gate."""
from __future__ import annotations

import secrets
from typing import Dict

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings
from .state import RealtimeStore

_bearer = HTTPBearer(auto_error=False)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_store(request: Request) -> RealtimeStore:
    return request.app.state.store


def get_db(request: Request):
    return request.app.state.db


def client_ip(request: Request) -> str:
    if request.app.state.settings.trust_proxy_headers:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


async def current_driver(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    store: RealtimeStore = Depends(get_store),
) -> Dict[str, str]:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token",
                            headers={"WWW-Authenticate": "Bearer"})
    sess = await store.get_session(creds.credentials)
    if not sess:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session",
                            headers={"WWW-Authenticate": "Bearer"})
    sess["token"] = creds.credentials
    return sess


def rate_limited(bucket: str, limit_setting: str, window_sec: int, multiplier: int = 1):
    """Per-client-IP fixed-window limiter as a dependency. `limit_setting` is
    the name of the Settings field holding the limit (resolved per request so
    tests and deployments can override it)."""
    async def dep(request: Request, store: RealtimeStore = Depends(get_store)) -> None:
        limit = getattr(request.app.state.settings, limit_setting) * multiplier
        ok = await store.hit(bucket, client_ip(request), limit, window_sec)
        if not ok:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests, slow down")
    return dep


async def require_admin(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    admin_token = request.app.state.settings.admin_token
    if not admin_token:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if not x_admin_token or not secrets.compare_digest(x_admin_token, admin_token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")
