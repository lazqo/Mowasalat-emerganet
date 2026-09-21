// Thin API client for the Wenak backend.
// Privacy rule enforced here: nothing in this file ever sends a coordinate.
// Positions are route-relative kilometres computed on the phone.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, opts: RequestInit = {}, token?: string): Promise<T> {
  if (!BASE) throw new ApiError(0, "EXPO_PUBLIC_BACKEND_URL is not configured");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { ...opts, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

export type Destination = { id: string; name_ar: string; name_en: string };
export type Stop = {
  stop_id: string;
  name_ar: string;
  name_en: string | null;
  progress_km: number;
  kind: "hub" | "village" | "terminus";
};
export type RouteDirection = {
  direction: number;
  origin_id: string;
  destination_id: string;
  origin_name_ar: string;
  destination_name_ar: string;
  served: Stop[];
  total_km: number;
};
export type TransportRoute = {
  id: string;
  name_ar: string;
  name_en: string;
  directions: RouteDirection[];
};
export type ApproachingBus = {
  pseudonym: string;
  distance_km: number;
  eta_min: number;
  state: "coming" | "near" | "very_near";
};
export type WaitOut = {
  wait_id: string;
  destination_id: string;
  route_id: string;
  direction: number;
  wait_progress_km: number;
  expires_at: number;
};
export type DriverSession = {
  session_token: string;
  driver_id: string;
  phone: string;
  name: string | null;
  assigned_route_ids: string[];
  expires_at: number;
};
export type TripOut = {
  trip_id: string;
  route_id: string;
  direction: number;
  progress_km: number;
  speed_kmh: number;
  zone: string | null;
  pseudonym: string;
  expires_at: number;
};
export type WaitingForDriver = { distance_km: number; count: number };
export type OtpRequestOut = { sent: boolean; provider: string; expires_in_sec: number; dev_code?: string };
/** GeoJSON corridor (LineString + stop Points) downloaded to the phone for local projection. */
export type Corridor = { type: "FeatureCollection"; route_id: string; total_km: number; features: any[] };

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  listDestinations: () => req<Destination[]>("/destinations"),
  listRoutes: () => req<TransportRoute[]>("/routes"),
  corridor: (route_id: string) => req<Corridor>(`/routes/${encodeURIComponent(route_id)}/corridor`),

  // Driver auth
  otpRequest: (phone: string) => req<OtpRequestOut>("/driver/otp/request", json({ phone })),
  otpVerify: (phone: string, code: string) => req<DriverSession>("/driver/otp/verify", json({ phone, code })),
  logout: (token: string) => req<{ ok: boolean }>("/driver/logout", { method: "POST" }, token),
  me: (token: string) => req<DriverSession>("/driver/me", {}, token),

  // Driver trips (bearer token in the Authorization header, never in the body or URL)
  startTrip: (token: string, route_id: string, direction: number) =>
    req<TripOut>("/driver/trip/start", json({ route_id, direction }), token),
  updateProgress: (token: string, trip_id: string, progress_km: number, speed_kmh = 40, zone?: string) =>
    req<TripOut>("/driver/trip/progress", json({ trip_id, progress_km, speed_kmh, zone }), token),
  endTrip: (token: string, trip_id: string) => req<{ ended: boolean }>("/driver/trip/end", json({ trip_id }), token),
  currentTrip: (token: string) => req<TripOut>("/driver/trip/current", {}, token),
  tripWaiting: (token: string, trip_id: string) =>
    req<WaitingForDriver[]>(`/driver/trip/${encodeURIComponent(trip_id)}/waiting`, {}, token),

  // Passenger (anonymous)
  buses: (destination_id: string, from_progress_km = 0, route_id?: string, direction?: number) => {
    const p = new URLSearchParams({ destination_id, from_progress_km: String(from_progress_km) });
    if (route_id) p.set("route_id", route_id);
    if (direction !== undefined) p.set("direction", String(direction));
    return req<ApproachingBus[]>(`/passenger/buses?${p.toString()}`);
  },
  createWait: (destination_id: string, route_id: string, direction: number, wait_progress_km: number) =>
    req<WaitOut>("/passenger/wait", json({ destination_id, route_id, direction, wait_progress_km })),
  waitStatus: (wait_id: string) =>
    req<{ wait_id: string; state: string; expires_at: number; buses: ApproachingBus[] }>(
      `/passenger/wait/${encodeURIComponent(wait_id)}/status`,
    ),
  waitBoard: (wait_id: string) =>
    req<{ boarded: boolean }>(`/passenger/wait/${encodeURIComponent(wait_id)}/board`, { method: "POST" }),
  waitCancel: (wait_id: string) =>
    req<{ cancelled: boolean }>(`/passenger/wait/${encodeURIComponent(wait_id)}/cancel`, { method: "POST" }),
};
