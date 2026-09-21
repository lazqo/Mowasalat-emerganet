"""Environment-driven settings. Secrets exist only as environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_list(name: str, default: list[str]) -> list[str]:
    v = os.environ.get(name)
    if not v:
        return default
    return [x.strip() for x in v.split(",") if x.strip()]


@dataclass
class Settings:
    app_name: str = "Wenak API"
    environment: str = os.environ.get("APP_ENV", "development")

    # Durable store (configuration/account data only).
    mongo_url: str = os.environ.get("MONGO_URL", "")
    db_name: str = os.environ.get("DB_NAME", "wenak")

    # Realtime store (TTL state only). Use a managed Redis in production.
    redis_url: str = os.environ.get("REDIS_URL", "")
    # Development-only escape hatch: an in-process fake Redis. Never set in
    # production; state then lives in the API process and dies with it.
    allow_inmemory_state: bool = _env_bool("ALLOW_INMEMORY_STATE", False)

    # TTLs (seconds)
    trip_ttl_sec: int = int(os.environ.get("TRIP_TTL_SEC", 60 * 60 * 6))       # 6h max trip
    trip_stale_sec: int = int(os.environ.get("TRIP_STALE_SEC", 60 * 15))       # no update for 15 min => trip expires
    wait_ttl_sec: int = int(os.environ.get("WAIT_TTL_SEC", 60 * 20))           # 20 min wait auto-expire
    session_ttl_sec: int = int(os.environ.get("SESSION_TTL_SEC", 60 * 60 * 24 * 30))  # 30d driver session
    otp_ttl_sec: int = int(os.environ.get("OTP_TTL_SEC", 5 * 60))
    otp_max_attempts: int = int(os.environ.get("OTP_MAX_ATTEMPTS", 5))
    otp_resend_cooldown_sec: int = int(os.environ.get("OTP_RESEND_COOLDOWN_SEC", 60))
    otp_requests_per_hour_per_phone: int = int(os.environ.get("OTP_REQUESTS_PER_HOUR_PER_PHONE", 5))
    otp_requests_per_hour_per_ip: int = int(os.environ.get("OTP_REQUESTS_PER_HOUR_PER_IP", 20))

    # OTP delivery: "mock" (dev/test: code is logged, never sent) or "twilio" (Phase 3).
    otp_provider: str = os.environ.get("OTP_PROVIDER", "mock")

    # HTTP security
    cors_origins: list[str] = field(default_factory=lambda: _env_list("CORS_ORIGINS", []))
    admin_token: str = os.environ.get("ADMIN_TOKEN", "")
    trust_proxy_headers: bool = _env_bool("TRUST_PROXY_HEADERS", True)

    # Generic rate limits (requests per minute per client IP). Mobile carriers
    # put many users behind one NAT address, so these are deliberately loose;
    # they stop abuse, not busy stops.
    passenger_wait_per_minute_per_ip: int = int(os.environ.get("PASSENGER_WAIT_PER_MINUTE_PER_IP", 30))
    read_per_minute_per_ip: int = int(os.environ.get("READ_PER_MINUTE_PER_IP", 1200))

    # Demand analytics (aggregate only). Cells under k_min never reach Mongo.
    analytics_k_min: int = int(os.environ.get("ANALYTICS_K_MIN", 5))
    analytics_segment_km: float = float(os.environ.get("ANALYTICS_SEGMENT_KM", 3.0))
    analytics_flush_sec: int = int(os.environ.get("ANALYTICS_FLUSH_SEC", 300))

    # Server-sent events
    sse_tick_sec: float = float(os.environ.get("SSE_TICK_SEC", 2.0))
    sse_keepalive_sec: float = float(os.environ.get("SSE_KEEPALIVE_SEC", 15.0))
    sse_max_sec: float = float(os.environ.get("SSE_MAX_SEC", 25 * 60))

    # Passenger positions are rounded to this before storage (km).
    wait_position_round_km: float = float(os.environ.get("WAIT_POSITION_ROUND_KM", 0.1))

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in ("production", "prod")


settings = Settings()
