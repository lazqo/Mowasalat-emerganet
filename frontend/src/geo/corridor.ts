// Pure geometry for projecting a device position onto a route corridor.
// No React Native imports: this runs on the phone and in node tests.
//
// Everything that touches a coordinate lives here and in the callers that
// obtain the fix from the OS. Outputs are route-relative (km along the
// line, metres off the line, a zone label). Coordinates never leave the
// device.

export type LonLat = [number, number];

export type CorridorStop = {
  stop_id: string;
  name_ar: string;
  name_en?: string | null;
  progress_km: number; // along direction 0 (hub -> terminus)
  kind: "hub" | "village" | "terminus";
};

export type Corridor = {
  routeId: string;
  totalKm: number;
  provisional: boolean;
  stops: CorridorStop[];
  // local planar frame (metres), equirectangular around the line's centre
  xy: [number, number][];
  cumM: number[]; // cumulative metres at each vertex
  lon0: number;
  lat0: number;
  cosLat: number;
};

export type Projection = {
  progressKm0: number; // km from the hub along direction 0
  distanceM: number; // metres from the nearest point of the corridor
  segment: number; // index of the nearest polyline segment
};

export type Zone = "at_hub" | "on_corridor" | "near_corridor" | "off_corridor" | "at_terminus" | "wrong_direction";

const EARTH_R = 6371000;
export const ON_CORRIDOR_M = 60;
export const NEAR_CORRIDOR_M = 250;
export const ENDPOINT_KM = 0.3;

export function buildCorridor(fc: any): Corridor {
  const line = fc.features.find((f: any) => f.geometry?.type === "LineString");
  if (!line) throw new Error("corridor has no LineString");
  const coords: LonLat[] = line.geometry.coordinates;
  if (coords.length < 2) throw new Error("corridor too short");
  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of coords) {
    lonSum += lon;
    latSum += lat;
  }
  const lon0 = lonSum / coords.length;
  const lat0 = latSum / coords.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const xy = coords.map(([lon, lat]) => toXY(lon, lat, lon0, lat0, cosLat));
  const cumM = [0];
  for (let i = 1; i < xy.length; i++) {
    cumM.push(cumM[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  const stops: CorridorStop[] = fc.features
    .filter((f: any) => f.geometry?.type === "Point" && f.properties?.stop_id)
    .map((f: any) => ({
      stop_id: f.properties.stop_id,
      name_ar: f.properties.name_ar,
      name_en: f.properties.name_en ?? null,
      progress_km: Number(f.properties.progress_km),
      kind: f.properties.kind ?? "village",
    }))
    .sort((a: CorridorStop, b: CorridorStop) => a.progress_km - b.progress_km);
  const totalKm = Number(fc.total_km ?? line.properties?.total_km ?? cumM[cumM.length - 1] / 1000);
  return { routeId: fc.route_id, totalKm, provisional: fc.provisional !== false, stops, xy, cumM, lon0, lat0, cosLat };
}

function toXY(lon: number, lat: number, lon0: number, lat0: number, cosLat: number): [number, number] {
  return [((lon - lon0) * Math.PI / 180) * EARTH_R * cosLat, ((lat - lat0) * Math.PI / 180) * EARTH_R];
}

/** Nearest point on the corridor to (lon, lat). O(n) over the polyline. */
export function project(c: Corridor, lon: number, lat: number): Projection {
  const [px, py] = toXY(lon, lat, c.lon0, c.lat0, c.cosLat);
  let best = { d2: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < c.xy.length - 1; i++) {
    const [ax, ay] = c.xy[i];
    const [bx, by] = c.xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d2 = (px - qx) ** 2 + (py - qy) ** 2;
    if (d2 < best.d2) best = { d2, seg: i, t };
  }
  const segLen = c.cumM[best.seg + 1] - c.cumM[best.seg];
  const alongM = c.cumM[best.seg] + best.t * segLen;
  // scale so that the polyline's own length maps onto the published total_km
  const scale = (c.totalKm * 1000) / c.cumM[c.cumM.length - 1];
  return { progressKm0: (alongM * scale) / 1000, distanceM: Math.sqrt(best.d2), segment: best.seg };
}

/** Progress along a given direction. Direction 1 runs terminus -> hub. */
export function progressForDirection(c: Corridor, progressKm0: number, direction: 0 | 1): number {
  const p = direction === 0 ? progressKm0 : c.totalKm - progressKm0;
  return Math.max(0, Math.min(c.totalKm, p));
}

export function zoneFor(c: Corridor, distanceM: number, progressKm: number): Zone {
  if (distanceM > NEAR_CORRIDOR_M) return "off_corridor";
  if (progressKm <= ENDPOINT_KM) return "at_hub";
  if (progressKm >= c.totalKm - ENDPOINT_KM) return "at_terminus";
  return distanceM <= ON_CORRIDOR_M ? "on_corridor" : "near_corridor";
}

/** Zones that are worth reporting. Off-corridor detours are never uploaded. */
export function shouldReport(zone: Zone): boolean {
  return zone === "on_corridor" || zone === "near_corridor" || zone === "at_hub" || zone === "at_terminus";
}

export type DirectionSample = { progressKm0: number; tMs: number };
export const DIRECTION_MIN_KM = 0.3;
export const DIRECTION_WINDOW_MS = 3 * 60 * 1000;

/**
 * Infer travel direction from recent on-corridor samples: 0 if progress
 * (along direction 0) grew by at least DIRECTION_MIN_KM over the window,
 * 1 if it shrank, null if undecided. Uses the earliest and latest sample
 * in the window so GPS jitter between them does not matter.
 */
export function inferDirection(samples: DirectionSample[], nowMs?: number): 0 | 1 | null {
  if (samples.length < 2) return null;
  const now = nowMs ?? samples[samples.length - 1].tMs;
  const recent = samples.filter((s) => now - s.tMs <= DIRECTION_WINDOW_MS);
  if (recent.length < 2) return null;
  const delta = recent[recent.length - 1].progressKm0 - recent[0].progressKm0;
  if (delta >= DIRECTION_MIN_KM) return 0;
  if (delta <= -DIRECTION_MIN_KM) return 1;
  return null;
}

/** Stops on `direction` (direction-relative progress), in travel order. */
export function stopsForDirection(c: Corridor, direction: 0 | 1): CorridorStop[] {
  const stops = c.stops.map((s) => ({ ...s, progress_km: progressForDirection(c, s.progress_km, direction) }));
  return stops.sort((a, b) => a.progress_km - b.progress_km);
}
