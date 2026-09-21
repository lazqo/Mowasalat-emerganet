import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgressPayload, shouldUpload } from "./reporting";

const t0 = 1_000_000;
const fix = (over: Partial<Parameters<typeof shouldUpload>[0]>) => ({
  progressKm: 5, speedMps: 12, zone: "on_corridor" as const, tMs: t0, ...over,
});

describe("driver reporting cadence", () => {
  it("reports the first on-corridor fix immediately", () => {
    assert.equal(shouldUpload(fix({}), null), true);
  });
  it("never uploads off-corridor or wrong-direction fixes", () => {
    assert.equal(shouldUpload(fix({ zone: "off_corridor" }), null), false);
    assert.equal(shouldUpload(fix({ zone: "wrong_direction" }), null), false);
  });
  it("throttles while moving: 5 s and 50 m, or 15 s regardless", () => {
    const last = { lastReportMs: t0, lastReportKm: 5 };
    assert.equal(shouldUpload(fix({ tMs: t0 + 3_000, progressKm: 5.3 }), last), false);
    assert.equal(shouldUpload(fix({ tMs: t0 + 6_000, progressKm: 5.02 }), last), false);
    assert.equal(shouldUpload(fix({ tMs: t0 + 6_000, progressKm: 5.06 }), last), true);
    assert.equal(shouldUpload(fix({ tMs: t0 + 16_000, progressKm: 5.0 }), last), true);
  });
  it("sends a 30 s heartbeat while stopped", () => {
    const last = { lastReportMs: t0, lastReportKm: 5 };
    assert.equal(shouldUpload(fix({ speedMps: 0, tMs: t0 + 20_000 }), last), false);
    assert.equal(shouldUpload(fix({ speedMps: null, tMs: t0 + 31_000 }), last), true);
  });
  it("payload carries only route-relative fields", () => {
    const p = buildProgressPayload("abc", fix({ progressKm: 5.4567, speedMps: 11.2 }));
    assert.deepEqual(p, { trip_id: "abc", progress_km: 5.46, speed_kmh: 40, zone: "on_corridor" });
    assert.deepEqual(Object.keys(p).sort(), ["progress_km", "speed_kmh", "trip_id", "zone"]);
  });
});
