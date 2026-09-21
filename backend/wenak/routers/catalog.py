from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request

from ..deps import rate_limited
from ..models import Destination, TransportRoute

router = APIRouter(tags=["catalog"])
_read_limit = rate_limited("read", "read_per_minute_per_ip", 60)


@router.get("/")
async def root():
    return {"service": "Wenak", "status": "ok"}


@router.get("/health")
async def health(request: Request):
    ok = await request.app.state.store.ping()
    return {"status": "ok" if ok else "degraded", "redis": ok}


@router.get("/destinations", response_model=List[Destination], dependencies=[Depends(_read_limit)])
async def list_destinations(request: Request):
    return request.app.state.catalog.destinations


@router.get("/routes", response_model=List[TransportRoute], dependencies=[Depends(_read_limit)])
async def list_routes(request: Request):
    return request.app.state.catalog.routes


@router.get("/routes/{route_id}/corridor", dependencies=[Depends(_read_limit)])
async def route_corridor(route_id: str, request: Request):
    """Corridor polyline + stops for on-phone projection of GPS to progress.
    Phones download this; they never upload positions."""
    fc = request.app.state.catalog.corridors.get(route_id)
    if not fc:
        raise HTTPException(404, "Route not found")
    return fc
