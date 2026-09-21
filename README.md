# Wenak / وينك

A live information and demand-visibility layer for existing shared transport
lines. Pilot: Irbid ↔ Bani Kinana (Jordan). Passengers see approaching buses
and can say "I'm waiting here"; drivers see how many passengers are waiting
ahead on their line. **Not ride-hailing**: no booking, no dispatch, no fares.

## Repository layout

| Path | What |
| --- | --- |
| `backend/` | FastAPI service (`wenak/` package, `server.py` entrypoint) |
| `backend/data/corridors/` | Provisional pilot corridors traced from OpenStreetMap (GeoJSON) |
| `backend/tests/` | In-process test suite (no live server needed) |
| `frontend/` | Expo (React Native) app, Arabic-first, RTL |
| `memory/PRD.md` | Product spec |
| `design_guidelines.json` | Visual tokens used by `frontend/src/theme.ts` |

## Privacy architecture (enforced in code)

- **No raw GPS reaches the backend.** Phones download the corridor polyline
  (`GET /api/routes/{id}/corridor`) and project their position onto it
  locally. The API only accepts `route_id`, `direction`, `progress_km`,
  `speed_kmh` and a coarse `zone` label. There is no field for a coordinate.
- **Realtime state lives in Redis with TTLs**, never in MongoDB. Active
  trips, waiting requests, driver sessions, OTP challenges and rate-limit
  counters all expire on their own. A trip that stops reporting for
  `TRIP_STALE_SEC` disappears. Nothing becomes a trip history.
- **MongoDB holds configuration and account data only**: `drivers`
  (id, phone, assigned lines) and `demand_stats` (destination + hour +
  count). The test `test_mongo_holds_only_config_and_aggregates` guards this.
- **Passengers are anonymous.** Buses are shown under a per-trip pseudonym.
- **Location stays on the phone.** Drivers: an Android *foreground service*
  (visible notification) keeps fixes flowing while the screen is off during
  an active trip; each fix is projected onto the corridor locally and only
  route/direction/progress/speed/zone is uploaded. Off-corridor detours and
  wrong-direction travel are not uploaded at all. The service stops the
  moment the trip ends, the driver logs out, or the server drops the trip.
  Passengers: one foreground fix, projected locally, or a chosen stop. No
  passenger location stream and no background location for anyone: the
  manifest removes `ACCESS_BACKGROUND_LOCATION` and only requests
  `ACCESS_FINE/COARSE_LOCATION`, `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_LOCATION`.
- **Demand analytics are k-anonymous.** Waits are counted per (line,
  direction, 3 km segment, hour) in Redis; a cell reaches Mongo only when it
  holds at least `ANALYTICS_K_MIN` (default 5) requests. Smaller cells merge
  into a per-day line total that is itself written only at the threshold,
  otherwise it expires unwritten. A lone passenger never becomes a row.
- Session tokens are stored hashed. Phone numbers are masked in logs. The
  admin endpoint returns counts only and is disabled unless `ADMIN_TOKEN`
  is set.

## Backend

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then edit
uvicorn server:app --reload --port 8001
```

Environment (see `backend/.env.example`):

| Variable | Purpose |
| --- | --- |
| `MONGO_URL`, `DB_NAME` | Durable config/account data only |
| `REDIS_URL` | Realtime TTL state. Required. Use a managed Redis in production. |
| `ALLOW_INMEMORY_STATE=1` | Dev only: fake in-process Redis when `REDIS_URL` is unset |
| `APP_ENV` | `production` disables docs, dev OTP codes and permissive CORS |
| `OTP_PROVIDER` | `mock` (dev; code returned as `dev_code`) or `twilio` (Phase 3) |
| `CORS_ORIGINS` | Comma-separated web origins (native apps need none) |
| `ADMIN_TOKEN` | Enables `GET /api/admin/state` via `X-Admin-Token` |
| `ANALYTICS_K_MIN`, `ANALYTICS_SEGMENT_KM` | Minimum cell size and segment length for demand analytics |
| `SSE_TICK_SEC`, `SSE_KEEPALIVE_SEC`, `SSE_MAX_SEC` | Server-sent event cadence; clients reconnect after `SSE_MAX_SEC` |
| `WAIT_POSITION_ROUND_KM` | Passenger positions are coarsened to this step before storage |

Tests run in-process with fakeredis and mongomock:

```bash
cd backend && pytest
TEST_REDIS_URL=redis://127.0.0.1:6379 pytest   # same suite against a real Redis
```

### API summary (all under `/api`)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/destinations`, `/routes`, `/routes/{id}/corridor` | none | Catalog and corridor GeoJSON |
| POST | `/driver/otp/request`, `/driver/otp/verify` | none | Hashed, expiring, one-use codes; attempt, resend and hourly limits |
| POST | `/driver/logout` · GET `/driver/me` | Bearer | |
| POST | `/driver/trip/start` · `/progress` · `/end` | Bearer | Progress is clamped to the line length |
| GET | `/driver/trip/current` · `/driver/trip/{id}/waiting` | Bearer | Waiting passengers bucketed by distance |
| GET | `/driver/trip/{id}/stream` | Bearer | SSE `demand` events: waiting passengers ahead |
| GET | `/passenger/buses` · `/passenger/buses/stream` | none | Approaching buses for a destination / line (poll or SSE) |
| POST | `/passenger/wait` · `/wait/{id}/board` · `/wait/{id}/cancel` | none | Body carries `stop_id` or a route-relative `wait_progress_km`; waits expire after 20 min |
| GET | `/passenger/wait/{id}/status` · `/wait/{id}/stream` | none | SSE `status` events, `ended` on board/cancel/expiry |
| GET | `/admin/state` | `X-Admin-Token` | Aggregate counts only |

## Pilot corridors (PROVISIONAL FIELD DATA)

`backend/data/corridors/*.geojson` were traced on 2026-09-21 from
OpenStreetMap (road via OSRM, places via Nominatim, © OpenStreetMap
contributors, ODbL). **Every file, stop and wait point is provisional and
must not reach the public as-is.** In particular the Irbid hub point is the
OSM city centre, flagged `placeholder: true` in the data; it is not the
bus complex (مجمع) these lines leave from. The road actually driven,
intermediate waiting points and terminus stops all need a field check. The
API marks these routes `provisional: true` and the app labels them
"مسار أولي". Drivers are assigned to a named line; they are not forced to
follow the polyline.

| Line | Length | Intermediate stops found |
| --- | --- | --- |
| Irbid ↔ Malka | 21.0 km | Tuqbul, Hor, Fo'ara, Is'ara, Hatim, Balad Al-Sheikh |
| Irbid ↔ Sama Al-Rousan | 11.9 km | Beit Ras, Hareema, Al-Qasfa |
| Irbid ↔ Kufr Soum | 18.3 km | Beit Ras, Hareema, Al-Qasfa, Sama Al-Rousan, Izreet, Habras, Mansheyet Kufr Soum |
| Irbid ↔ Habras | 15.8 km | Beit Ras, Hareema, Al-Qasfa, Sama Al-Rousan, Izreet |
| Irbid ↔ Umm Qais | 27.9 km | Kufr Yuba, Kufr 'An, Kufr Rahta, Al-Kharaj, Saydour, Balad Al-Basha |

Notes for the field check: the Sama Al-Rousan, Habras and Kufr Soum lines
share the road north through Beit Ras. OSRM routed Umm Qais via the western
road (Kufr Yuba / Saydour); if the buses actually go via Hatim and Malka, the
corridor file must be re-traced. The earlier seed data placed Hakama on the
Malka line; OSM puts Hakama east of Irbid, so it was dropped.

## Frontend

```bash
cd frontend
cp .env.example .env            # EXPO_PUBLIC_BACKEND_URL
yarn install
yarn start                      # Expo dev server
yarn typecheck && yarn lint && yarn test
```

`yarn test` runs node tests for the on-phone geometry (`src/geo`): corridor
projection, direction inference, zones and off-corridor behaviour, line
choice and stop matching against the real corridor files, the driver
reporting cadence, and a privacy guard that fails if a realtime
person-movement DTO gains a coordinate-like field.

Driver flow: pick line and direction, grant while-in-use location, the
foreground service starts and progress is reported every 5 s / 50 m while
moving and every 30 s while stopped; demand ahead arrives over SSE; "خلصت"
stops the service. Passenger flow: pick a destination, the app takes one
location fix and offers the lines that pass your position with the
destination still ahead (or a stop picker if location is denied or you are
not on a line), then "أنا مستني هون" registers the route-relative position
and approaching buses stream over SSE until "ركبت" or cancel.

Identifiers: app name **Wenak** (وينك), scheme `wenak`, Android package and
iOS bundle id `jo.wenak.app`. The pilot ships as a sideloaded Android APK:

```bash
eas build --platform android --profile pilot
```

## Build plan

1. **Phase 1 (this branch):** Redis TTL realtime state, Mongo for config only,
   bearer sessions, hardened OTP flow behind an `OtpProvider` interface,
   rate limits, CORS/admin hardening, dependency cleanup, in-process tests,
   app rename, Android permission strings, provisional OSM corridors.
2. **Phase 2 (this branch):** real driver GPS projected on the phone with an
   Android foreground service, passenger one-shot location or stop picker,
   line choice, SSE for both sides, k-anonymous demand analytics, geometry
   and privacy-guard tests. Real-device acceptance on Irbid ↔ Malka is
   still to be run.
3. **Phase 3:** Twilio `OtpProvider` (secrets from environment only).
4. **Phase 4:** EAS Android APK and two-phone acceptance test on
   Irbid ↔ Malka: passenger sees the approaching bus, driver sees the
   waiting passenger, no raw coordinates reach or remain on the backend.
