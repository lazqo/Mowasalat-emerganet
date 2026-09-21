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
- **No passenger background location.** The Android manifest blocks
  `ACCESS_BACKGROUND_LOCATION`; driver tracking is a foreground service
  while a trip is active.
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
| GET | `/passenger/buses` | none | Approaching buses for a destination / line |
| POST | `/passenger/wait` · `/wait/{id}/board` · `/wait/{id}/cancel` | none | Waits expire after 20 min |
| GET | `/passenger/wait/{id}/status` | none | |
| GET | `/admin/state` | `X-Admin-Token` | Aggregate counts only |

## Pilot corridors (provisional)

`backend/data/corridors/*.geojson` were traced on 2026-09-21 from
OpenStreetMap (road via OSRM, places via Nominatim, © OpenStreetMap
contributors, ODbL). They are a starting dataset: the Irbid hub (which
مجمع the lines leave from), the road actually driven, intermediate
waiting points and the terminus stops must be field-checked before public
use. Drivers are assigned to a named line; they are not forced to follow the
polyline.

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
yarn typecheck && yarn lint
```

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
2. **Phase 2:** on-phone GPS projection onto the corridor for drivers,
   passenger local position or stop picker, line selection when several
   lines serve a stop. Corridor endpoint and `zone` field are already in
   place.
3. **Phase 3:** Twilio `OtpProvider` (secrets from environment only).
4. **Phase 4:** EAS Android APK and two-phone acceptance test on
   Irbid ↔ Malka: passenger sees the approaching bus, driver sees the
   waiting passenger, no raw coordinates reach or remain on the backend.
