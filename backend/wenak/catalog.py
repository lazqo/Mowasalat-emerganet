"""Route catalog built from the provisional corridor files in data/corridors.

Each GeoJSON holds one LineString (the road corridor traced from
OpenStreetMap, hub -> terminus) and Point features (hub, villages, terminus)
with `progress_km` along that line. Direction 0 is hub -> terminus and
direction 1 mirrors it. Drivers are assigned to a named line; the polyline
is a corridor for on-phone projection, not a path they must follow.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from .models import Destination, RouteDirection, Stop, TransportRoute

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "corridors"

# Order of pilot lines in the catalog.
PILOT_ORDER = ["irbid_malka", "irbid_sama_rousan", "irbid_kufr_soum", "irbid_habras", "irbid_umm_qais"]


class Catalog:
    def __init__(self, routes: List[TransportRoute], destinations: List[Destination],
                 corridors: Dict[str, dict]):
        self.routes = routes
        self.destinations = destinations
        self.corridors = corridors  # route_id -> GeoJSON FeatureCollection (public)
        self._routes_by_id = {r.id: r for r in routes}
        self._dest_by_id = {d.id: d for d in destinations}

    def route(self, route_id: str) -> Optional[TransportRoute]:
        return self._routes_by_id.get(route_id)

    @staticmethod
    def direction(r: TransportRoute, direction: int) -> Optional[RouteDirection]:
        return next((d for d in r.directions if d.direction == direction), None)

    def destination(self, destination_id: str) -> Optional[Destination]:
        return self._dest_by_id.get(destination_id)

    def serving(self, destination_id: str) -> List[dict]:
        """[{route_id, direction, destination_km, total_km}] for every
        line/direction that can drop a passenger at destination_id."""
        out = []
        for r in self.routes:
            for d in r.directions:
                for s in d.served:
                    if s.stop_id == destination_id and s.progress_km > 0.0:
                        out.append({"route_id": r.id, "direction": d.direction,
                                    "route_name_ar": r.name_ar,
                                    "destination_km": s.progress_km, "total_km": d.total_km})
        return out


def _stops_from_features(features: List[dict]) -> List[Stop]:
    stops = []
    for f in features:
        if f.get("geometry", {}).get("type") != "Point":
            continue
        p = f.get("properties", {})
        if not p.get("stop_id"):
            continue  # un-named waypoint; not a served stop yet
        stops.append(Stop(stop_id=p["stop_id"], name_ar=p["name_ar"], name_en=p.get("name_en"),
                          progress_km=float(p["progress_km"]), kind=p.get("kind", "village")))
    stops.sort(key=lambda s: s.progress_km)
    return stops


def load_catalog(data_dir: Path = DATA_DIR) -> Catalog:
    routes: List[TransportRoute] = []
    dests: Dict[str, Destination] = {}
    corridors: Dict[str, dict] = {}
    files = {p.stem: p for p in sorted(data_dir.glob("*.geojson"))}
    ordered = [f for f in PILOT_ORDER if f in files] + [f for f in files if f not in PILOT_ORDER]
    for rid in ordered:
        fc = json.loads(files[rid].read_text(encoding="utf-8"))
        line = next(f for f in fc["features"] if f["geometry"]["type"] == "LineString")
        total_km = float(line["properties"]["total_km"])
        out_stops = _stops_from_features(fc["features"])
        if len(out_stops) < 2:
            raise ValueError(f"{rid}: corridor needs at least a hub and a terminus stop")
        hub, term = out_stops[0], out_stops[-1]
        in_stops = [Stop(stop_id=s.stop_id, name_ar=s.name_ar, name_en=s.name_en,
                         progress_km=round(total_km - s.progress_km, 3), kind=s.kind)
                    for s in reversed(out_stops)]
        outbound = RouteDirection(direction=0, origin_id=hub.stop_id, destination_id=term.stop_id,
                                  origin_name_ar=hub.name_ar, destination_name_ar=term.name_ar,
                                  served=out_stops, total_km=round(total_km, 3))
        inbound = RouteDirection(direction=1, origin_id=term.stop_id, destination_id=hub.stop_id,
                                 origin_name_ar=term.name_ar, destination_name_ar=hub.name_ar,
                                 served=in_stops, total_km=round(total_km, 3))
        provisional = fc.get("provenance", {}).get("status", "provisional") != "field_verified"
        routes.append(TransportRoute(id=rid, name_ar=fc["name_ar"], name_en=fc["name_en"],
                                     directions=[outbound, inbound], provisional=provisional))
        for s in out_stops:
            dests.setdefault(s.stop_id, Destination(id=s.stop_id, name_ar=s.name_ar,
                                                    name_en=s.name_en or s.stop_id))
        # Public corridor: geometry + stops only (no provenance notes needed on the phone).
        corridors[rid] = {
            "type": "FeatureCollection", "route_id": rid, "total_km": round(total_km, 3),
            "provisional": provisional,
            "attribution": "© OpenStreetMap contributors (ODbL)",
            "features": [line] + [f for f in fc["features"] if f["geometry"]["type"] == "Point"],
        }
    if not routes:
        raise RuntimeError(f"No corridor files found in {data_dir}")
    return Catalog(routes, list(dests.values()), corridors)
