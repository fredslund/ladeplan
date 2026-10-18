// Logic tests for Ladeplan. Runs without a browser or network.
// Usage: TZ=Europe/Copenhagen node tests/plan.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

if (process.env.TZ !== "Europe/Copenhagen") {
  console.error("Run with TZ=Europe/Copenhagen (the app assumes device time = Danish time).");
  process.exit(1);
}

// Pull the inline <script> out of index.html and expose its functions.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let js = html.split("<script>")[1].split("</script>")[0];
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
js += ";module.exports={demoData,buildHours,plan,drivesFor,consFor,totalPrice,DEF,clone,parsePrices,decide,loadSettings};";
const mod = { exports: {} };
new Function("module", js)(mod);
const { demoData, buildHours, plan, DEF, clone, parsePrices, decide, loadSettings } = mod.exports;
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

function run(iso, edit) {
  const now = new Date(iso);
  const s = clone(DEF);
  edit && edit(s);
  const d = demoData(now);
  const { hours, model } = buildHours(d.prices, d.weather, s, now);
  return { P: plan(hours, s, now), s, hours, model, now };
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("ok  ", name); }
  catch (e) { failed++; console.log("FAIL", name, "\n     ", e.message); }
}

test("reserve is respected on every checked commute", () => {
  for (const iso of ["2026-10-18T17:09", "2026-10-19T21:00", "2026-01-12T19:00"]) {
    const { P, s } = run(iso, s => { s.soc = 20; });
    for (const e of P.events.filter(e => e.check)) {
      assert.ok(e.lvlAfter >= s.battery * s.reserve / 100 - 0.05, `${iso}: arrives with ${e.lvlAfter.toFixed(2)} kWh`);
    }
  }
});

test("charge limit is not exceeded for normal commutes", () => {
  const { P, s } = run("2026-10-19T21:00", s => { s.soc = 20; });
  for (const e of P.events) assert.ok(e.lvlBefore <= s.battery * s.maxSoc / 100 + 0.05);
});

test("no charging planned while the car is away", () => {
  const { P } = run("2026-10-19T14:00", s => { s.soc = 30; });
  for (const sl of P.slots) if (sl.charge > 0) assert.ok(sl.home, new Date(sl.t).toString());
});

test("full battery needs no charging", () => {
  const { P } = run("2026-10-20T22:00", s => { s.soc = 90; });
  assert.strictEqual(P.blocks.length, 0);
});

test("impossible trip is flagged as short", () => {
  const { P } = run("2026-10-21T20:00", s => { s.soc = 25; s.overrides = { "2026-10-22": 400 }; });
  assert.ok(P.events.some(e => e.short > 0));
});

test("seasonal consumption follows the trip date", () => {
  const { P } = run("2026-10-31T20:00", s => { s.overrides = { "2026-11-01": 100 }; });
  for (const e of P.events) assert.strictEqual(+(e.need / e.km * 100).toFixed(1), 20);
  const summer = run("2026-07-14T20:00").P;
  for (const e of summer.events) assert.strictEqual(+(e.need / e.km * 100).toFixed(1), 14);
});

test("forecast model fits example data", () => {
  const { model } = run("2026-10-18T17:09");
  assert.ok(model && model.mae < 100, `MAE ${model && model.mae}`);
});

test("DST change (25 Oct 2026) gives unique hourly slots", () => {
  const { hours } = run("2026-10-24T18:00");
  const ts = hours.map(h => h.t);
  assert.strictEqual(new Set(ts).size, ts.length);
});

test("price files parse to hourly DKK/MWh", () => {
  const m = parsePrices([fixture("2026-10-18_DK1.json"), null]);
  assert.strictEqual(m.size, 24);
  const t0 = new Date("2026-10-18T00:00").getTime();
  assert.ok(Math.abs(m.get(t0) - 1053.92) < 0.01, `got ${m.get(t0)}`);
});

test("DST day price file gives 25 unique hours", () => {
  const m = parsePrices([fixture("2025-10-26_DK1.json")]);
  assert.strictEqual(m.size, 25);
});

test("sub-hourly price records are averaged per hour", () => {
  const m = parsePrices([[
    { DKK_per_kWh: 1, time_start: "2026-10-18T10:00:00+02:00" },
    { DKK_per_kWh: 2, time_start: "2026-10-18T10:15:00+02:00" },
  ]]);
  assert.strictEqual(m.size, 1);
  assert.strictEqual([...m.values()][0], 1500);
});

test("forecast block tonight does not say wait", () => {
  const now = new Date("2026-10-19T09:00"), s = clone(DEF);
  const start = new Date("2026-10-20T02:00").getTime();
  const P = { events: [], slots: [], endLvl: 30, B: 58,
    blocks: [{ start, end: start + 2 * 3600e3, kwh: 10, cost: 20, fc: true }] };
  const d = decide(P, now, s);
  assert.strictEqual(d.title, "Probably charge tonight");
  P.blocks[0].fc = false;
  assert.strictEqual(decide(P, now, s).title, "Charge tonight");
});

test("bad stored settings are clamped or reset", () => {
  const orig = globalThis.localStorage.getItem;
  globalThis.localStorage.getItem = () => JSON.stringify({ battery: 0, effPct: "x", maxSoc: 120, cons: { w: null } });
  try {
    const s = loadSettings();
    assert.strictEqual(s.battery, 10);
    assert.strictEqual(s.effPct, DEF.effPct);
    assert.strictEqual(s.maxSoc, 100);
    assert.strictEqual(s.cons.w, DEF.cons.w);
  } finally { globalThis.localStorage.getItem = orig; }
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
