// In-memory cache of downloaded corridors (GeoJSON -> projected Corridor).
// Downloaded to the phone, never uploaded.
import { api } from "./api";
import { buildCorridor, Corridor } from "./geo/corridor";

const raw: Record<string, any> = {};
const built: Record<string, Corridor> = {};

export async function getCorridor(routeId: string): Promise<{ fc: any; corridor: Corridor }> {
  if (!built[routeId]) {
    const fc = await api.corridor(routeId);
    raw[routeId] = fc;
    built[routeId] = buildCorridor(fc);
  }
  return { fc: raw[routeId], corridor: built[routeId] };
}

export async function getCorridors(routeIds: string[]): Promise<Record<string, Corridor>> {
  const out: Record<string, Corridor> = {};
  await Promise.all(routeIds.map(async (id) => {
    out[id] = (await getCorridor(id)).corridor;
  }));
  return out;
}
