"""FastAPI application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from motor.motor_asyncio import AsyncIOMotorClient
from starlette.middleware.cors import CORSMiddleware

from .catalog import load_catalog
from .config import Settings, settings as default_settings
from .otp import build_provider
from .routers import admin, catalog, driver, passenger
from .state import RealtimeStore, make_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("wenak")


def create_app(settings: Settings | None = None, *, redis=None, db=None, otp_provider=None) -> FastAPI:
    s = settings or default_settings

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = s
        app.state.catalog = load_catalog()
        r = redis if redis is not None else await make_redis(s)
        app.state.redis = r
        app.state.store = RealtimeStore(r, s)
        if db is not None:
            app.state.mongo = None
            app.state.db = db
        else:
            if not s.mongo_url:
                raise RuntimeError("MONGO_URL is not set")
            app.state.mongo = AsyncIOMotorClient(s.mongo_url)
            app.state.db = app.state.mongo[s.db_name]
        await app.state.db.drivers.create_index("phone", unique=True)
        await app.state.db.drivers.create_index("id", unique=True)
        await app.state.db.demand_stats.create_index([("destination_id", 1), ("hour", 1)], unique=True)
        app.state.otp_provider = otp_provider or build_provider(s.otp_provider)
        logger.info("Wenak API up: env=%s otp=%s routes=%d redis=%s",
                    s.environment, app.state.otp_provider.name, len(app.state.catalog.routes),
                    "external" if s.redis_url else "in-memory (dev)")
        try:
            yield
        finally:
            if app.state.mongo is not None:
                app.state.mongo.close()
            await r.aclose()

    app = FastAPI(title=s.app_name, lifespan=lifespan,
                  docs_url=None if s.is_production else "/api/docs",
                  redoc_url=None, openapi_url=None if s.is_production else "/api/openapi.json")

    api_prefix = "/api"
    app.include_router(catalog.router, prefix=api_prefix)
    app.include_router(driver.router, prefix=api_prefix)
    app.include_router(passenger.router, prefix=api_prefix)
    app.include_router(admin.router, prefix=api_prefix)

    # CORS: native apps do not need it. Expo web / dashboards must be listed
    # in CORS_ORIGINS. In development with nothing configured, allow all.
    origins = s.cors_origins or ([] if s.is_production else ["*"])
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins,
                           allow_credentials=origins != ["*"],
                           allow_methods=["GET", "POST", "OPTIONS"],
                           allow_headers=["Authorization", "Content-Type", "X-Admin-Token"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Cache-Control", "no-store")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    return app
