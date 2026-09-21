// Guard: realtime person-movement payloads must never gain coordinate
// fields. GeoJSON corridors (downloaded, never uploaded) are exempt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const FORBIDDEN = /(^|_)(lat|lng|lon|latitude|longitude|coordinates|coords|geo|position)($|_)/i;
const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

function typeBlock(source: string, name: string): string {
  const m = source.match(new RegExp(`export type ${name} = \\{([^}]*)\\}`, "s"));
  assert.ok(m, `type ${name} not found`);
  return m![1];
}

describe("privacy guard (frontend)", () => {
  it("movement DTO types in api.ts carry no coordinates", () => {
    const api = src("src/api.ts");
    for (const t of ["TripOut", "WaitOut", "ApproachingBus", "WaitingForDriver"]) {
      for (const key of typeBlock(api, t).match(/(\w+)\s*[:?]/g) ?? []) {
        assert.ok(!FORBIDDEN.test(key.replace(/\s*[:?]$/, "")), `${t}.${key} looks like a coordinate`);
      }
    }
  });
  it("request bodies for progress and wait creation carry no coordinates", () => {
    const api = src("src/api.ts");
    for (const fn of ["updateProgress", "createWait"]) {
      const m = api.match(new RegExp(`${fn}:[\\s\\S]*?json\\(\\{([^}]*)\\}`));
      assert.ok(m, `${fn} body not found`);
      for (const key of m![1].split(",").map((s: string) => s.trim().split(/[:\s]/)[0]).filter(Boolean)) {
        assert.ok(!FORBIDDEN.test(key), `${fn} sends ${key}`);
      }
    }
  });
  it("the driver tracker never hands coordinates to the API, logs or storage", () => {
    const tracker = src("src/driver/tracker.ts");
    // every api.* call in the tracker must be one of the allowed, coordinate-free calls
    const calls = tracker.match(/api\.(\w+)\(/g) ?? [];
    for (const c of calls) assert.ok(["api.updateProgress(", "api.endTrip("].includes(c), `unexpected ${c}`);
    assert.ok(!/console\.(log|warn|error|info)\([^)]*(coords|latitude|longitude)/.test(tracker), "tracker logs coordinates");
    assert.ok(!/AsyncStorage\.setItem\([^)]*(coords|latitude|longitude)/.test(tracker), "tracker stores coordinates");
  });
});
