// Thin API client for Mowasalat backend.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.detail || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export type Destination = { id: string; name_ar: string; name_en: string };
export type RouteDirection = {
  direction: number;
  origin_id: string;
  destination_id: string;
  origin_name_ar: string;
  destination_name_ar: string;
  served: { destination_id: string; name_ar: string; progress: number }[];
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
};
export type TripOut = {
  trip_id: string;
  route_id: string;
  direction: number;
  progress_km: number;
  speed_kmh: number;
  pseudonym: string;
};
export type WaitingForDriver = { distance_km: number; count: number };

export const api = {
  listDestinations: () => req<Destination[]>("/destinations"),
  listRoutes: () => req<TransportRoute[]>("/routes"),

  // Driver
  otpRequest: (phone: string) =>
    req<{ sent: boolean }>("/driver/otp/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),
  otpVerify: (phone: string, code: string) =>
    req<DriverSession>("/driver/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    }),
  startTrip: (session_token: string, route_id: string, direction: number) =>
    req<TripOut>("/driver/trip/start", {
      method: "POST",
      body: JSON.stringify({ session_token, route_id, direction }),
    }),
  updateProgress: (session_token: string, trip_id: string, progress_km: number, speed_kmh = 40) =>
    req<TripOut>("/driver/trip/progress", {
      method: "POST",
      body: JSON.stringify({ session_token, trip_id, progress_km, speed_kmh }),
    }),
  endTrip: (session_token: string, trip_id: string) =>
    req<{ ended: boolean }>("/driver/trip/end", {
      method: "POST",
      body: JSON.stringify({ session_token, trip_id }),
    }),
  tripWaiting: (session_token: string, trip_id: string) =>
    req<WaitingForDriver[]>(
      `/driver/trip/${trip_id}/waiting?session_token=${encodeURIComponent(session_token)}`,
    ),

  // Passenger
  buses: (destination_id: string, from_progress_km = 0, route_id?: string, direction?: number) => {
    const p = new URLSearchParams({
      destination_id,
      from_progress_km: String(from_progress_km),
    });
    if (route_id) p.set("route_id", route_id);
    if (direction !== undefined) p.set("direction", String(direction));
    return req<ApproachingBus[]>(`/passenger/buses?${p.toString()}`);
  },
  createWait: (destination_id: string, route_id: string, direction: number, wait_progress_km: number) =>
    req<WaitOut>("/passenger/wait", {
      method: "POST",
      body: JSON.stringify({ destination_id, route_id, direction, wait_progress_km }),
    }),
  waitStatus: (wait_id: string) =>
    req<{ wait_id: string; state: string; expires_at: number; buses: ApproachingBus[] }>(
      `/passenger/wait/${wait_id}/status`,
    ),
  waitBoard: (wait_id: string) =>
    req<{ boarded: boolean }>(`/passenger/wait/${wait_id}/board`, { method: "POST" }),
  waitCancel: (wait_id: string) =>
    req<{ cancelled: boolean }>(`/passenger/wait/${wait_id}/cancel`, { method: "POST" }),
};
