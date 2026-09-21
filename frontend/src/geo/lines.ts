// Which lines can take a passenger from where they are to where they want
// to go. Pure functions; positions are route-relative once projected.
import { Corridor, NEAR_CORRIDOR_M, progressForDirection, project, stopsForDirection, CorridorStop } from "./corridor";

export type LineCandidate = {
  route_id: string;
  route_name_ar: string;
  direction: 0 | 1;
  origin_name_ar: string;
  destination_name_ar: string;
  destination_km: number; // destination progress along this direction
  total_km: number;
};

type RouteLike = {
  id: string;
  name_ar: string;
  directions: {
    direction: number;
    origin_name_ar: string;
    destination_name_ar: string;
    total_km: number;
    served: { stop_id: string; progress_km: number }[];
  }[];
};

/** Every (line, direction) that can drop the passenger at `destinationId`. */
export function candidateLines(routes: RouteLike[], destinationId: string): LineCandidate[] {
  const out: LineCandidate[] = [];
  for (const r of routes) {
    for (const d of r.directions) {
      const s = d.served.find((x) => x.stop_id === destinationId);
      if (!s || s.progress_km <= 0) continue; // origin of this direction, not a destination
      out.push({
        route_id: r.id,
        route_name_ar: r.name_ar,
        direction: d.direction as 0 | 1,
        origin_name_ar: d.origin_name_ar,
        destination_name_ar: d.destination_name_ar,
        destination_km: s.progress_km,
        total_km: d.total_km,
      });
    }
  }
  return out;
}

export const MIN_AHEAD_KM = 0.2;

export type LineMatch = LineCandidate & {
  ok: boolean;
  reason: "ok" | "off_corridor" | "destination_behind";
  progress_km: number; // passenger position along this direction
  distance_m: number;
};

/**
 * Project one position onto each candidate line. A line is offered only
 * when the passenger is on/near its corridor and the destination is still
 * ahead of them in that direction.
 */
export function matchLines(candidates: LineCandidate[], corridors: Record<string, Corridor>,
                           lon: number, lat: number): LineMatch[] {
  const out: LineMatch[] = [];
  for (const c of candidates) {
    const corr = corridors[c.route_id];
    if (!corr) continue;
    const p = project(corr, lon, lat);
    const progress = progressForDirection(corr, p.progressKm0, c.direction);
    let reason: LineMatch["reason"] = "ok";
    if (p.distanceM > NEAR_CORRIDOR_M) reason = "off_corridor";
    else if (progress > c.destination_km - MIN_AHEAD_KM) reason = "destination_behind";
    out.push({ ...c, ok: reason === "ok", reason, progress_km: round1(progress), distance_m: Math.round(p.distanceM) });
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || a.distance_m - b.distance_m);
}

/** Stops the passenger could be waiting at for this candidate: everything
 * before the destination in travel order (the destination itself excluded). */
export function stopsBeforeDestination(candidate: LineCandidate, corridor: Corridor): CorridorStop[] {
  return stopsForDirection(corridor, candidate.direction).filter(
    (s) => s.progress_km < candidate.destination_km - MIN_AHEAD_KM,
  );
}

export function round1(km: number): number {
  return Math.round(km * 10) / 10;
}
