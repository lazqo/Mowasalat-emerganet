// Driver location tracking during an active trip.
//
// Android: expo-location background task backed by a *foreground service*
// with a visible notification. That path needs only while-in-use location
// plus FOREGROUND_SERVICE / FOREGROUND_SERVICE_LOCATION - never
// ACCESS_BACKGROUND_LOCATION - and keeps running with the screen off. The
// service is started while the app is visible and stopped the moment the
// trip ends, the driver logs out, or the server says the trip is gone.
//
// Privacy: fixes are projected onto the corridor here, on the phone. Only
// buildProgressPayload() output (route-relative km, speed, zone) is sent.
// Coordinates are never logged, stored or forwarded.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import { api } from "../api";
import {
  buildCorridor, Corridor, DirectionSample, inferDirection, progressForDirection, project, Zone, zoneFor,
} from "../geo/corridor";
import { buildProgressPayload, Fix, ReportState, shouldUpload } from "./reporting";

export const TRACKING_TASK = "wenak-driver-tracking";
const CTX_KEY = "wenak.driver.trip";

export type TripContext = {
  token: string;
  tripId: string;
  routeId: string;
  direction: 0 | 1;
  corridor: any; // GeoJSON FeatureCollection from GET /routes/{id}/corridor
};

export type TrackerStatus = {
  running: boolean;
  permission: "granted" | "denied" | "unknown";
  progressKm: number | null;
  speedKmh: number | null;
  zone: Zone | null;
  lastFixMs: number | null;
  lastUploadMs: number | null;
  uploads: number;
  ended: boolean; // server no longer knows the trip / session
  error: string | null;
};

type Listener = (s: TrackerStatus) => void;

let ctx: TripContext | null = null;
let corridor: Corridor | null = null;
let report: ReportState = null;
let samples: DirectionSample[] = [];
let foregroundSub: Location.LocationSubscription | null = null;
const listeners = new Set<Listener>();
let status: TrackerStatus = {
  running: false, permission: "unknown", progressKm: null, speedKmh: null, zone: null,
  lastFixMs: null, lastUploadMs: null, uploads: 0, ended: false, error: null,
};

function emit(patch: Partial<TrackerStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(status);
  return () => listeners.delete(l);
}

export function getStatus(): TrackerStatus {
  return status;
}

// ---------------------------------------------------------------- core
async function handleLocations(locs: Location.LocationObject[]) {
  if (!ctx || !corridor) {
    const restored = await restoreContext();
    if (!restored) return;
  }
  const c = corridor!;
  const t = ctx!;
  const loc = locs[locs.length - 1];
  if (!loc) return;
  const now = loc.timestamp || Date.now();
  const p = project(c, loc.coords.longitude, loc.coords.latitude);
  const progressKm = progressForDirection(c, p.progressKm0, t.direction);
  let zone: Zone = zoneFor(c, p.distanceM, progressKm);

  if (zone !== "off_corridor") {
    samples.push({ progressKm0: p.progressKm0, tMs: now });
    if (samples.length > 200) samples = samples.slice(-200);
    const inferred = inferDirection(samples, now);
    if (inferred !== null && inferred !== t.direction) zone = "wrong_direction";
  }

  const fix: Fix = { progressKm, speedMps: loc.coords.speed ?? null, zone, tMs: now };
  emit({ progressKm: Math.round(progressKm * 100) / 100, speedKmh: fix.speedMps == null ? null : Math.round(fix.speedMps * 3.6),
         zone, lastFixMs: now, error: null });

  if (!shouldUpload(fix, report)) return;
  const payload = buildProgressPayload(t.tripId, fix);
  try {
    await api.updateProgress(t.token, payload.trip_id, payload.progress_km, payload.speed_kmh, payload.zone);
    report = { lastReportMs: now, lastReportKm: progressKm };
    emit({ lastUploadMs: now, uploads: status.uploads + 1 });
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 404) {
      // Session or trip is gone on the server: stop immediately, never keep tracking.
      await stopTracking();
      emit({ ended: true, error: e.message });
      return;
    }
    emit({ error: e?.message || "upload failed" }); // network: keep going, next fix retries
  }
}

TaskManager.defineTask(TRACKING_TASK, async ({ data, error }: any) => {
  if (error) {
    emit({ error: "location task error" }); // never include error payloads (may contain the fix)
    return;
  }
  const locs: Location.LocationObject[] = data?.locations ?? [];
  await handleLocations(locs);
});

async function restoreContext(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(CTX_KEY);
    if (!raw) return false;
    ctx = JSON.parse(raw);
    corridor = buildCorridor(ctx!.corridor);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- control
export async function requestPermission(): Promise<boolean> {
  const { status: s } = await Location.requestForegroundPermissionsAsync();
  const ok = s === "granted";
  emit({ permission: ok ? "granted" : "denied" });
  return ok;
}

export async function startTracking(next: TripContext): Promise<void> {
  ctx = next;
  corridor = buildCorridor(next.corridor);
  report = null;
  samples = [];
  emit({ running: false, ended: false, error: null, uploads: 0, progressKm: null, zone: null });
  await AsyncStorage.setItem(CTX_KEY, JSON.stringify(next)); // trip context only, no positions
  if (!(await requestPermission())) throw new Error("location permission denied");

  const useTask = Platform.OS !== "web" && (await TaskManager.isAvailableAsync());
  if (useTask) {
    if (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK)) {
      await Location.stopLocationUpdatesAsync(TRACKING_TASK);
    }
    await Location.startLocationUpdatesAsync(TRACKING_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      activityType: Location.ActivityType.AutomotiveNavigation,
      timeInterval: 3000,
      distanceInterval: 15,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      // Android foreground service (visible notification). Starting it here,
      // while the app is in the foreground, is what lets tracking continue
      // with the screen off without any background-location permission.
      foregroundService: {
        notificationTitle: "وينك - رحلة نشطة",
        notificationBody: "يتم مشاركة تقدمك على الخط مع الركاب المنتظرين. لا يتم إرسال موقعك.",
        notificationColor: "#586A45",
        killServiceOnDestroy: true,
      },
    });
  } else {
    // Web / environments without TaskManager: foreground-only watcher.
    foregroundSub?.remove();
    foregroundSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 3000, distanceInterval: 15 },
      (loc) => {
        void handleLocations([loc]);
      },
    );
  }
  emit({ running: true });
}

/** Resume tracking after an app restart when a trip is still active. */
export async function resumeTracking(next: TripContext): Promise<void> {
  const started = Platform.OS !== "web" && (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK).catch(() => false));
  if (started && ctx?.tripId === next.tripId) {
    emit({ running: true });
    return;
  }
  await startTracking(next);
}

export async function stopTracking(): Promise<void> {
  try {
    if (Platform.OS !== "web" && (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK))) {
      await Location.stopLocationUpdatesAsync(TRACKING_TASK);
    }
  } catch {}
  foregroundSub?.remove();
  foregroundSub = null;
  ctx = null;
  corridor = null;
  report = null;
  samples = [];
  await AsyncStorage.removeItem(CTX_KEY);
  emit({ running: false, progressKm: null, speedKmh: null, zone: null });
}

export async function isTracking(): Promise<boolean> {
  if (Platform.OS === "web") return foregroundSub !== null;
  return Location.hasStartedLocationUpdatesAsync(TRACKING_TASK).catch(() => false);
}
