// Logic tests for Ladeplan. Runs without a browser or network.
// Usage: TZ=Europe/Copenhagen node tests/plan.test.js
import fs from "node:fs";
import assert from "node:assert";
import { demoData, buildHours, plan, DEF, clone, parsePrices, decide, settingsFrom, tariff, priceParts, totalPrice } from "../ladeplan.js";

if (process.env.TZ !== "Europe/Copenhagen") {
  console.error("Run with TZ=Europe/Copenhagen (the app assumes device time = Danish time).");
  process.exit(1);
}

const fixture = name => JSON.parse(fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
const stored = p => settingsFrom(JSON.stringify(p));

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
  const s = stored({ battery: 0, effPct: "x", maxSoc: 120, cons: { w: null } });
  assert.strictEqual(s.battery, 10);
  assert.strictEqual(s.effPct, DEF.effPct);
  assert.strictEqual(s.maxSoc, 100);
  assert.strictEqual(s.cons.w, DEF.cons.w);
});

test("grid tariff follows season and hour band", () => {
  const s = clone(DEF);
  const at = iso => tariff(new Date(iso).getTime(), s);
  assert.strictEqual(at("2026-10-01T18:00"), s.t.winter.peak);
  assert.strictEqual(at("2026-03-31T03:00"), s.t.winter.night);
  assert.strictEqual(at("2026-04-01T03:00"), s.t.summer.night);
  assert.strictEqual(at("2026-09-30T22:00"), s.t.summer.day);
  assert.strictEqual(at("2026-07-14T20:59"), s.t.summer.peak);
});

test("price parts add up to the final price shown on the chart", () => {
  const s = clone(DEF);
  for (const [spot, iso] of [[1350, "2026-10-19T02:00"], [1210, "2026-10-19T13:00"], [-200, "2026-07-12T13:00"]]) {
    const t = new Date(iso).getTime(), p = priceParts(spot, t, s);
    assert.ok(Math.abs(p.spot + p.fees - p.total) < 1e-12);
    assert.ok(Math.abs(p.total - totalPrice(spot, t, s)) < 1e-12);
    assert.ok(Math.abs(p.grid - tariff(t, s) * 1.25) < 1e-12);
    assert.ok(Math.abs(p.spot - spot / 1000 * 1.25) < 1e-12);
  }
  // Monday 19 Oct 2026, real spot: 13:00 is cheaper spot but dearer in total than 02:00 (winter day tariff)
  const at = (spot, iso) => priceParts(spot, new Date(iso).getTime(), s);
  assert.ok(at(1210, "2026-10-19T13:00").spot < at(1350, "2026-10-19T02:00").spot);
  assert.ok(at(1210, "2026-10-19T13:00").total > at(1350, "2026-10-19T02:00").total);
  // every planned hour carries its parts
  const { hours } = run("2026-10-19T21:00");
  for (const h of hours) assert.ok(Math.abs(h.parts.total - h.price) < 1e-12);
});

test("old flat tariffs migrate to both seasons", () => {
  const { t } = stored({ t: { night: 0.11, day: 0.22, peak: 0.66, supplier: 0.02 } });
  assert.deepStrictEqual(t.winter, { night: 0.11, day: 0.22, peak: 0.66 });
  assert.deepStrictEqual(t.summer, { night: 0.11, day: 0.22, peak: 0.66 });
  assert.strictEqual(t.supplier, 0.02);
  assert.ok(!("night" in t));
});

test("partial seasonal tariffs fill in defaults", () => {
  const { t } = stored({ t: { winter: { peak: 0.9 } } });
  assert.strictEqual(t.winter.peak, 0.9);
  assert.strictEqual(t.winter.night, DEF.t.winter.night);
  assert.deepStrictEqual(t.summer, DEF.t.summer);
});

test("decision levels: needed vs optional vs forecast vs wait", () => {
  const now = new Date("2026-10-19T09:00"), s = clone(DEF), H = 3600e3;
  const dep = new Date("2026-10-20T07:30").getTime();
  const tonight = new Date("2026-10-20T02:00").getTime(), later = new Date("2026-10-21T02:00").getTime();
  const mk = (start, fc, must) => ({ events: [{ t: dep, check: true, need: 13, lvlAfter: 20, km: 78 }], slots: [], endLvl: 20, B: 58,
    nextDrive: { t: dep, check: true }, mustKwh: must ? 4 : 0, noChargeLvl: must ? 2 : 30,
    blocks: [{ start, end: start + 2 * H, kwh: 6, cost: 12, fc }] });
  const lv = (...a) => { const d = decide(mk(...a), now, s); return [d.cls, d.lvl, d.title]; };
  assert.deepStrictEqual(lv(tonight, false, true), ["must", "Needed for tomorrow", "Charge tonight"]);
  assert.deepStrictEqual(lv(tonight, true, true), ["must", "Needed for tomorrow", "Charge tonight"]);
  assert.deepStrictEqual(lv(later, false, true).slice(0, 2), ["", "Needed before tomorrow"]);
  assert.deepStrictEqual(lv(tonight, false, false), ["", "Optional · good price", "Charge tonight"]);
  assert.deepStrictEqual(lv(tonight, true, false), ["fc", "Forecast", "Probably charge tonight"]);
  assert.deepStrictEqual(lv(later, true, false).slice(0, 2), ["ok", "Not needed tonight"]);
});

test("planner reports what must be charged before the next drive", () => {
  const low = run("2026-10-19T21:00", s => { s.soc = 20; });
  // 20% of 58 = 11.6 kWh; 78 km at 17 kWh/100 km (October = shoulder) = 13.26 kWh; reserve 5.8 -> must 7.46 kWh
  assert.ok(Math.abs(low.P.mustKwh - 7.46) < 0.01, `mustKwh ${low.P.mustKwh}`);
  const d = decide(low.P, low.now, low.s);
  assert.strictEqual(d.cls, "must");
  const tonightKwh = low.P.blocks.filter(b => b.start < new Date("2026-10-20T07:30").getTime()).reduce((a, b) => a + b.kwh, 0);
  assert.ok(d.big.includes(`${tonightKwh.toFixed(1)} kWh`), `card shows all of tonight: ${d.big}`);
  const high = run("2026-10-19T21:00", s => { s.soc = 70; });
  assert.strictEqual(high.P.mustKwh, 0);
  assert.notStrictEqual(decide(high.P, high.now, high.s).cls, "must");
});

test("untouched old default tariffs move to N1 rates, edited ones stay", () => {
  const load = t => stored({ t }).t;
  // flat pre-seasonal default, copied to both seasons, then replaced
  let t = load({ night: 0.15, day: 0.30, peak: 0.70 });
  assert.deepStrictEqual(t.winter, DEF.t.winter);
  assert.deepStrictEqual(t.summer, DEF.t.summer);
  // seasonal old defaults
  t = load({ winter: { night: 0.15, day: 0.30, peak: 0.70 }, summer: { night: 0.10, day: 0.15, peak: 0.35 } });
  assert.deepStrictEqual(t.winter, DEF.t.winter);
  assert.deepStrictEqual(t.summer, DEF.t.summer);
  // one field edited: keep that season as is
  t = load({ winter: { night: 0.15, day: 0.30, peak: 0.71 }, summer: { night: 0.10, day: 0.15, peak: 0.35 } });
  assert.deepStrictEqual(t.winter, { night: 0.15, day: 0.30, peak: 0.71 });
  assert.deepStrictEqual(t.summer, DEF.t.summer);
});

test("N1 defaults give the published price incl. VAT", () => {
  const s = clone(DEF);
  const gridInclVat = iso => Math.round(tariff(new Date(iso).getTime(), s) * 1.25 * 10000) / 100;   // øre
  assert.strictEqual(gridInclVat("2026-01-15T18:00"), 98.84);
  assert.strictEqual(gridInclVat("2026-01-15T10:00"), 32.95);
  assert.strictEqual(gridInclVat("2026-07-15T18:00"), 42.83);
  assert.strictEqual(gridInclVat("2026-07-15T10:00"), 16.47);
  assert.strictEqual(gridInclVat("2026-07-15T03:00"), 10.98);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
