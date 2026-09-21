# Wenak / وينك - PRD

## Product
A live information & demand-visibility layer for existing shared/public
transport routes in Jordan (pilot: Irbid ↔ Bani Kinana). NOT a ride-hailing
service - no booking, no fare, no dispatch, no chat.

## Roles (single app)
- **Passenger** (no account): pick destination → see approaching buses & ETA →
  "أنا مستني هون" → live bus card → "ركبت" / "إلغاء".
- **Driver** (phone + SMS OTP): pick route + direction → "ابدأ" → active-trip
  screen with "N ركاب بانتظارك" + distance buckets → progress simulator
  (`+0.5 km`) → "خلصت".

## Screens
- `/` Role selection with Jordanian landscape hero.
- `/passenger` وين رايح؟ search + recent destinations.
- `/passenger/waiting` live bus card + I'm-waiting + boarded/cancel.
- `/driver/login` phone → 6-digit OTP (mock).
- `/driver/routes` pick route + direction → start.
- `/driver/trip` waiting demand + progress bar + advance / end trip.

## Backend (FastAPI + MongoDB)
Endpoints (all prefixed `/api`):
- `GET /destinations`, `GET /routes`
- `GET /routes/{id}/corridor` (polyline + stops for on-phone projection)
- `POST /driver/otp/request`, `POST /driver/otp/verify`, `POST /driver/logout`, `GET /driver/me`
- `POST /driver/trip/start|progress|end`, `GET /driver/trip/current`, `GET /driver/trip/{id}/waiting` (Bearer session)
- `GET /passenger/buses`, `POST /passenger/wait`,
  `GET /passenger/wait/{id}/status`, `POST /passenger/wait/{id}/board|cancel`
- `GET /admin/state` (aggregate counts only)

## Privacy architecture (enforced)
- **No raw GPS stored.** Backend receives route-relative progress (km) only.
- **No trajectory database.** Realtime state (trips, waits, sessions, OTP
  challenges) lives in Redis with TTLs. It may survive an API restart but
  expires on its own and never becomes historical trip data. Mongo holds
  configuration/account data only.
- **No passenger accounts.** Buses use temporary pseudonyms (`bus-xxxxxx`).
- **Waits auto-expire** after 20 minutes.
- **Aggregate analytics only** (`demand_stats` collection: destination + hour +
  request count).

## Data model
Mongo (durable, minimal):
- `drivers` — id, phone, assigned_route_ids, verification_tier
- `demand_stats` — destination_id, hour, requests

Redis (TTL, no history):
- trip:*, wait:*, session:*, otp:*, rl:*

Route data: 5 pilot lines (Irbid ↔ Malka, Sama Al-Rousan, Kufr Soum, Habras,
Umm Qais) from `backend/data/corridors/*.geojson`, provisional OSM traces
to be field-checked.

## Excluded from MVP (by product spec)
Payments, wallet, bookings, seats, chat, calls, ratings, driver commission,
passenger accounts, driver bidding, fare negotiation.

## Location model (implemented)
- **Driver:** `expo-location` background task backed by an Android
  foreground service (no background-location permission). Fixes are
  projected onto the corridor on the phone; only route/direction/progress/
  speed/zone is sent, every 5 s / 50 m moving, 30 s stopped. Off-corridor or
  wrong-direction fixes are not sent. Service stops on trip end / logout.
- **Passenger:** one foreground fix projected locally, or a chosen stop.
  No stream, no background location.
- **Realtime:** SSE streams for approaching buses and waiting demand.

## Not implemented in this MVP:
- **Map.** Corridor is shown as a progress bar. `react-native-maps` with OSM
  tiles can be layered on later.
- **Real SMS OTP.** OTP codes are real (hashed, expiring, one-use, attempt
  limited) but delivery is a mock provider until Twilio is wired (Phase 3).

## Business enhancement (future revenue)
Context-based, non-behavioural advertising ("target the journey, not the
person"): a Malka-bound passenger sees a Malka business ad. B2B/B2G later:
sell aggregated **unserved-demand** signals to transit planners.
