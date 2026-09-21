// Decides when a driver fix becomes an API report, and what the report
// contains. Pure; unit-tested in node. The only thing that ever leaves the
// phone is the return value of buildProgressPayload().
import { Zone, shouldReport } from "../geo/corridor";

export const MOVING_MPS = 2; // > 7 km/h counts as moving
export const MOVING_MIN_INTERVAL_MS = 5_000;
export const MOVING_MIN_DISTANCE_KM = 0.05;
export const MOVING_MAX_INTERVAL_MS = 15_000;
export const STOPPED_HEARTBEAT_MS = 30_000;

export type Fix = {
  progressKm: number; // direction-relative
  speedMps: number | null;
  zone: Zone;
  tMs: number;
};

export type ReportState = { lastReportMs: number; lastReportKm: number } | null;

export function shouldUpload(fix: Fix, last: ReportState): boolean {
  if (!shouldReport(fix.zone)) return false; // off corridor / wrong direction: never upload
  if (!last) return true;
  const dt = fix.tMs - last.lastReportMs;
  const moving = (fix.speedMps ?? 0) >= MOVING_MPS;
  if (moving) {
    if (dt < MOVING_MIN_INTERVAL_MS) return false;
    return Math.abs(fix.progressKm - last.lastReportKm) >= MOVING_MIN_DISTANCE_KM || dt >= MOVING_MAX_INTERVAL_MS;
  }
  return dt >= STOPPED_HEARTBEAT_MS;
}

export type ProgressPayload = { trip_id: string; progress_km: number; speed_kmh: number; zone: Zone };

export function buildProgressPayload(tripId: string, fix: Fix): ProgressPayload {
  const speedKmh = Math.max(0, Math.min(150, ((fix.speedMps ?? 0) * 3.6)));
  return {
    trip_id: tripId,
    progress_km: Math.round(fix.progressKm * 100) / 100,
    speed_kmh: Math.round(speedKmh),
    zone: fix.zone,
  };
}
