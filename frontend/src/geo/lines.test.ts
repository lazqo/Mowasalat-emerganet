import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildCorridor, Corridor } from "./corridor";
import { candidateLines, matchLines, stopsBeforeDestination } from "./lines";

const DATA = join(__dirname, "..", "..", "..", "backend", "data", "corridors");
const IDS = ["irbid_malka", "irbid_sama_rousan", "irbid_kufr_soum", "irbid_habras", "irbid_umm_qais"];
const corridors: Record<string, Corridor> = {};
for (const id of IDS) corridors[id] = buildCorridor(JSON.parse(readFileSync(join(DATA, `${id}.geojson`), "utf8")));

// Build the same route catalog the backend serves, from the corridor files.
const routes = IDS.map((id) => {
  const c = corridors[id];
  const out = c.stops.map((s) => ({ stop_id: s.stop_id, progress_km: s.progress_km }));
  const inb = [...c.stops].reverse().map((s) => ({ stop_id: s.stop_id, progress_km: c.totalKm - s.progress_km }));
  return {
    id, name_ar: id,
    directions: [
      { direction: 0, origin_name_ar: "إربد", destination_name_ar: id, total_km: c.totalKm, served: out },
      { direction: 1, origin_name_ar: id, destination_name_ar: "إربد", total_km: c.totalKm, served: inb },
    ],
  };
});
const stopLonLat = (id: string, stopId: string): [number, number] => {
  const fc = JSON.parse(readFileSync(join(DATA, `${id}.geojson`), "utf8"));
  return fc.features.find((f: any) => f.properties?.stop_id === stopId).geometry.coordinates;
};

describe("route choice", () => {
  it("lists every line/direction that serves the destination", () => {
    const c = candidateLines(routes, "sama_rousan");
    const keys = c.map((x) => `${x.route_id}/${x.direction}`).sort();
    // outbound on its own line and on the two lines that continue past it; inbound on those two
    assert.deepEqual(keys, ["irbid_habras/0", "irbid_habras/1", "irbid_kufr_soum/0", "irbid_kufr_soum/1", "irbid_sama_rousan/0"]);
    assert.deepEqual(candidateLines(routes, "irbid").map((x) => x.direction), [1, 1, 1, 1, 1]);
    assert.deepEqual(candidateLines(routes, "nowhere"), []);
  });

  it("offers only lines the passenger is on, with the destination ahead", () => {
    // Standing at Beit Ras, going to Sama Al-Rousan: all three northern lines are valid
    const [lon, lat] = stopLonLat("irbid_habras", "beit_ras");
    const m = matchLines(candidateLines(routes, "sama_rousan"), corridors, lon, lat);
    const ok = m.filter((x) => x.ok);
    assert.deepEqual(ok.map((x) => `${x.route_id}/${x.direction}`).sort(),
      ["irbid_habras/0", "irbid_kufr_soum/0", "irbid_sama_rousan/0"]);
    assert.ok(ok.every((x) => Math.abs(x.progress_km - 5.0) < 0.2));
    // the inbound options are on the same road but Sama Al-Rousan is behind a Beit Ras passenger
    assert.ok(m.filter((x) => !x.ok).every((x) => x.direction === 1 && x.reason === "destination_behind"));
    // Standing at Habras, wanting Sama Al-Rousan: only the inbound lines still have it ahead
    const [lon2, lat2] = stopLonLat("irbid_kufr_soum", "habras");
    const m2 = matchLines(candidateLines(routes, "sama_rousan"), corridors, lon2, lat2);
    assert.deepEqual(m2.filter((x) => x.ok).map((x) => `${x.route_id}/${x.direction}`).sort(),
      ["irbid_habras/1", "irbid_kufr_soum/1"]);
    // outbound: Sama Al-Rousan is behind (its own line's corridor has even ended here)
    assert.ok(m2.filter((x) => x.direction === 0).every((x) => !x.ok));
    // Standing on the Malka road, wanting Sama Al-Rousan: off every candidate corridor
    const [lon3, lat3] = stopLonLat("irbid_malka", "hor");
    const m3 = matchLines(candidateLines(routes, "sama_rousan"), corridors, lon3, lat3);
    assert.ok(m3.every((x) => x.reason === "off_corridor"));
  });

  it("uses the inbound direction when heading back to Irbid", () => {
    const [lon, lat] = stopLonLat("irbid_malka", "hatim");
    const m = matchLines(candidateLines(routes, "irbid"), corridors, lon, lat).filter((x) => x.ok);
    assert.deepEqual(m.map((x) => `${x.route_id}/${x.direction}`), ["irbid_malka/1"]);
    assert.ok(Math.abs(m[0].progress_km - (corridors.irbid_malka.totalKm - 16)) < 0.2);
  });

  it("stop picker offers only stops before the destination in travel order", () => {
    const c = candidateLines(routes, "hatim")[0];
    const stops = stopsBeforeDestination(c, corridors.irbid_malka).map((s) => s.stop_id);
    assert.deepEqual(stops, ["irbid", "tuqbul", "hor", "foara", "isara"]);
    const back = candidateLines(routes, "irbid").find((x) => x.route_id === "irbid_malka")!;
    const inbound = stopsBeforeDestination(back, corridors.irbid_malka).map((s) => s.stop_id);
    assert.equal(inbound[0], "malka");
    assert.ok(!inbound.includes("irbid"));
  });
});
