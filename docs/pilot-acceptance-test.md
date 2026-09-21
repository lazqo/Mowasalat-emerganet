# Phase 2 acceptance test (two real Android phones)

Phase 2 is not verified until this has been run on real hardware on the
Irbid ↔ Malka line. Automated tests and a successful build do not count.

## Prerequisites

1. **Backend reachable from both phones**, with `REDIS_URL` set to a real
   Redis and `MONGO_URL` to a real MongoDB. Check:
   ```bash
   curl -s https://<backend>/api/health          # {"status":"ok","redis":true}
   curl -s https://<backend>/api/routes | head   # provisional: true
   ```
2. **APKs built against that backend.** `EXPO_PUBLIC_BACKEND_URL` is baked in
   at build time, so a build pointing at the wrong host cannot be fixed on
   the phone:
   ```bash
   cd frontend
   EXPO_PUBLIC_BACKEND_URL=https://<backend> eas build --platform android --profile pilot
   ```
   Install the same APK on both phones (`adb install -r wenak.apk`).
3. **OTP**: `OTP_PROVIDER=mock` until Phase 3. Outside production the code is
   returned in the response and shown on the code screen; in production it
   is not, so run this test with `APP_ENV` unset or `development`.

## The run

Phone A is the driver, in a vehicle on the road to Malka. Phone B is the
passenger, standing at a waiting point on that road.

| # | Who | Action | Expected |
| --- | --- | --- | --- |
| 1 | A | سائق → phone → code | Lands on the line list, lines marked "مسار أولي" |
| 2 | A | Pick إربد ↔ ملكا, direction إربد ← ملكا, ابدأ | Location permission asked once (while-in-use only, **no** "allow all the time"), trip screen opens |
| 3 | A | — | A persistent notification "وينك - رحلة نشطة" appears; status reads "على الخط"; the update counter rises as the vehicle moves |
| 4 | A | Lock the screen, drive 1–2 km, unlock | Progress advanced while locked (counter and km rose) |
| 5 | B | راكب → ملكا | Location asked once; the app offers إربد ↔ ملكا (or a stop picker if denied) |
| 6 | B | أنا مستني هون | Card shows the driver's bus with ETA; "السائق يرى أن هناك راكباً بانتظاره" |
| 7 | A | — | Within a few seconds: "1 راكب بانتظارك" with the distance ahead |
| 8 | B | ركبت | Returns to the destination list |
| 9 | A | — | Within a few seconds: "لا يوجد ركاب بانتظارك" |
| 10 | A | خلصت | Notification disappears immediately; back on the line list |

## Privacy checks (part of the test, not optional)

Run these while the trip is active.

- **No coordinates in flight.** On the backend, log or capture the bodies of
  `POST /api/driver/trip/progress`. Every body must contain exactly
  `trip_id`, `progress_km`, `speed_kmh`, `zone`.
- **No coordinates at rest.** After steps 6 and 10:
  ```bash
  redis-cli --scan --pattern 'trip:*' | head        # empty after خلصت
  redis-cli --scan --pattern 'wait:*' | head        # empty after ركبت
  mongosh --eval 'db.drivers.findOne()'             # id, phone, name, assigned_route_ids, verification_tier, created_at
  mongosh --eval 'db.demand_stats.find().toArray()' # empty, or rows with requests >= ANALYTICS_K_MIN
  ```
  A single test passenger must leave **no** row in `demand_stats`.
- **Background location is not installed.**
  ```bash
  adb shell dumpsys package jo.wenak.app | grep -i location
  ```
  `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` may appear;
  `ACCESS_BACKGROUND_LOCATION` must not.
- **Tracking really stops.** After خلصت:
  ```bash
  adb shell dumpsys activity services jo.wenak.app | grep -i LocationTaskService
  ```
  must return nothing.

## Off-corridor behaviour

With the trip still running, have the driver turn off the corridor for more
than ~250 m. The status must read "خارج الخط - لا يتم الإرسال" and the
update counter must stop rising. Returning to the road resumes it. The
detour must not appear in the passenger's view at any point.

## Recording the result

Report separately, and do not describe the phase as verified unless all
three are true:

- code complete;
- automated tests passing;
- Android build produced;
- **real-device run above completed**, with the step number of any failure.
