import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildCorridor, inferDirection, progressForDirection, project, shouldReport, stopsForDirection, zoneFor,
} from "./corridor";

const DATA = join(__dirname, "..", "..", "..", "backend", "data", "corridors");
const load = (id: string) => buildCorridor(JSON.parse(readFileSync(join(DATA, `${id}.geojson`), "utf8")));
const malka = load("irbid_malka");
const R = 6371000;
const fromXY = (c: ReturnType<typeof load>, x: number, y: number): [number, number] => [
  c.lon0 + ((x / (R * c.cosLat)) * 180) / Math.PI, c.lat0 + ((y / R) * 180) / Math.PI,
];
// back-project a vertex to lon/lat for tests
const vertex = (c: ReturnType<typeof load>, i: number): [number, number] => fromXY(c, c.xy[i][0], c.xy[i][1]);
// a point `metres` perpendicular to the segment starting at vertex i
const beside = (c: ReturnType<typeof load>, i: number, metres: number): [number, number] => {
  const [ax, ay] = c.xy[i];
  const [bx, by] = c.xy[i + 1];
  const len = Math.hypot(bx - ax, by - ay);
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  return fromXY(c, ax + nx * metres, ay + ny * metres);
};

describe("corridor projection", () => {
  it("builds from the real GeoJSON and keeps the published length", () => {
    assert.equal(malka.routeId, "irbid_malka");
    assert.ok(malka.totalKm > 20 && malka.totalKm < 22);
    assert.equal(malka.provisional, true);
    assert.equal(malka.stops[0].stop_id, "irbid");
    assert.equal(malka.stops[malka.stops.length - 1].stop_id, "malka");
  });

  it("projects the hub to 0 km and the terminus vertex to total_km", () => {
    const [lon, lat] = vertex(malka, 0);
    const p0 = project(malka, lon, lat);
    assert.ok(p0.progressKm0 < 0.01 && p0.distanceM < 1);
    const [lon2, lat2] = vertex(malka, malka.xy.length - 1);
    const p1 = project(malka, lon2, lat2);
    assert.ok(Math.abs(p1.progressKm0 - malka.totalKm) < 0.01);
  });

  it("progress is monotonic along the polyline", () => {
    let last = -1;
    for (let i = 0; i < malka.xy.length; i += 25) {
      const [lon, lat] = vertex(malka, i);
      const p = project(malka, lon, lat).progressKm0;
      assert.ok(p >= last - 1e-6, `vertex ${i}: ${p} < ${last}`);
      last = p;
    }
  });

  it("measures distance off the corridor and flags zones", () => {
    // pick a straight stretch (the hill road to Malka has switchbacks where a
    // perpendicular offset lands on the next leg of the same road)
    const i = 200;
    const [lon, lat] = vertex(malka, i);
    const on = project(malka, lon, lat);
    assert.ok(on.distanceM < 1);
    assert.equal(zoneFor(malka, on.distanceM, on.progressKm0), "on_corridor");
    // 200 m beside the road: near, not on
    const [nlon, nlat] = beside(malka, i, 200);
    const near = project(malka, nlon, nlat);
    assert.ok(near.distanceM > 150 && near.distanceM <= 250, String(near.distanceM));
    assert.equal(zoneFor(malka, near.distanceM, near.progressKm0), "near_corridor");
    // 1 km beside the road: off corridor, never reported
    const [olon, olat] = beside(malka, i, 1000);
    const off = project(malka, olon, olat);
    assert.ok(off.distanceM > 800, String(off.distanceM));
    assert.equal(zoneFor(malka, off.distanceM, off.progressKm0), "off_corridor");
    assert.equal(shouldReport("off_corridor"), false);
    assert.equal(shouldReport("wrong_direction"), false);
    assert.equal(shouldReport("near_corridor"), true);
  });

  it("labels the ends of the line", () => {
    assert.equal(zoneFor(malka, 5, 0.1), "at_hub");
    assert.equal(zoneFor(malka, 5, malka.totalKm - 0.1), "at_terminus");
  });

  it("mirrors progress for the inbound direction", () => {
    assert.equal(progressForDirection(malka, 0, 1), malka.totalKm);
    assert.ok(Math.abs(progressForDirection(malka, 4, 1) - (malka.totalKm - 4)) < 1e-9);
    assert.equal(progressForDirection(malka, -3, 0), 0);
    const inbound = stopsForDirection(malka, 1);
    assert.equal(inbound[0].stop_id, "malka");
    assert.equal(inbound[inbound.length - 1].stop_id, "irbid");
  });
});

describe("direction inference", () => {
  const t0 = 1_000_000;
  it("needs enough movement", () => {
    assert.equal(inferDirection([]), null);
    assert.equal(inferDirection([{ progressKm0: 1, tMs: t0 }]), null);
    assert.equal(inferDirection([{ progressKm0: 1, tMs: t0 }, { progressKm0: 1.1, tMs: t0 + 20_000 }]), null);
  });
  it("detects outbound and inbound travel despite jitter", () => {
    const out = [
      { progressKm0: 1.0, tMs: t0 }, { progressKm0: 0.95, tMs: t0 + 5_000 },
      { progressKm0: 1.2, tMs: t0 + 10_000 }, { progressKm0: 1.4, tMs: t0 + 20_000 },
    ];
    assert.equal(inferDirection(out), 0);
    assert.equal(inferDirection(out.map((s) => ({ ...s, progressKm0: 10 - s.progressKm0 }))), 1);
  });
  it("ignores samples outside the window", () => {
    const old = { progressKm0: 0, tMs: t0 - 10 * 60_000 };
    assert.equal(inferDirection([old, { progressKm0: 5, tMs: t0 }], t0), null);
  });
});
