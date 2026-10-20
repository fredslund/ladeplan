// Logic tests for Ladeplan. Runs without a browser or network.
// Usage: TZ=Europe/Copenhagen node tests/plan.test.js
import fs from "node:fs";
import assert from "node:assert";
import { demoData, buildHours, plan, DEF, clone, parsePrices, decide, settingsFrom, tariff, priceParts, totalPrice, round5, hm5, hhmm, oneWindow, recentDays, priceRating, kmOn, startOfDay, addDays, atTime, notePlanned, socEstimate, logReading, relogKm, deviates, commitFrom } from "../ladeplan.js";

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

test("decision levels: needed vs optional vs forecast vs nothing before you leave", () => {
  const now = new Date("2026-10-19T09:00"), s = clone(DEF), H = 3600e3;
  const dep = new Date("2026-10-20T07:30").getTime();
  const tonight = new Date("2026-10-20T02:00").getTime(), afterDrive = new Date("2026-10-21T02:00").getTime();
  const mk = (start, fc, must) => ({ events: [{ t: dep, check: true, need: 13, lvlAfter: 20, km: 78 }], slots: [], endLvl: 20, B: 58,
    nextDrive: { t: dep, check: true }, mustKwh: must ? 4 : 0, noChargeLvl: must ? 2 : 30,
    blocks: [{ start, end: start + 2 * H, kwh: 6, cost: 12, fc }] });
  const lv = (...a) => { const d = decide(mk(...a), now, s); return [d.cls, d.lvl, d.title]; };
  assert.deepStrictEqual(lv(tonight, false, true), ["must", "Needed for tomorrow", "Charge tonight"]);
  assert.deepStrictEqual(lv(tonight, true, true), ["must", "Needed for tomorrow", "Charge tonight"]);
  assert.deepStrictEqual(lv(tonight, false, false), ["", "Optional · cheapest ahead", "Charge tonight"]);   // no history: no rating
  assert.deepStrictEqual(lv(tonight, true, false), ["fc", "Forecast", "Probably charge tonight"]);
  assert.deepStrictEqual(lv(afterDrive, true, false), ["ok", "Not needed yet", "No need to charge before you leave"]);
});

test("charge title names the actual time, including days ahead before the next drive", () => {
  const H = 3600e3, s = clone(DEF);
  const card = (nowIso, startIso, depIso, must) => {
    const now = new Date(nowIso), start = new Date(startIso).getTime(), dep = new Date(depIso).getTime();
    return decide({ events: [{ t: dep, check: true, need: 13, lvlAfter: 20 }], slots: [], endLvl: 20, B: 58,
      nextDrive: { t: dep, check: true }, mustKwh: must ? 4 : 0, noChargeLvl: 2,
      blocks: [{ start, end: start + 2 * H, kwh: 6, cost: 12, fc: false }] }, now, s);
  };
  // Thursday evening, Friday is WFH: midday tomorrow
  assert.strictEqual(card("2026-10-22T20:00", "2026-10-23T11:00", "2026-10-26T07:30", true).title, "Charge tomorrow 11:00");
  // Friday morning, next drive Monday: a cheap Sunday midday is still before you leave
  const sun = card("2026-10-23T08:00", "2026-10-25T12:00", "2026-10-26T07:30", true);
  assert.deepStrictEqual([sun.cls, sun.lvl, sun.title], ["must", "Needed for Mon", "Charge Sun 12:00"]);
  assert.strictEqual(card("2026-10-19T09:00", "2026-10-19T09:30", "2026-10-20T07:30", false).title, "Charge now");
  assert.strictEqual(card("2026-10-19T09:00", "2026-10-19T13:00", "2026-10-20T07:30", false).title, "Charge today 13:00");
  assert.strictEqual(card("2026-10-19T09:00", "2026-10-19T22:00", "2026-10-20T07:30", false).title, "Charge tonight");
});

test("planner uses midday on a WFH day and nights on a commute day", () => {
  const plan1 = (iso, edit) => {
    const now = new Date(iso), s = clone(DEF); s.soc = 15; edit(s);
    const d = demoData(now);
    // make 10:00–15:00 clearly the cheapest part of every day
    for (const [t, v] of d.prices) { const h = new Date(t).getHours(); if (h >= 10 && h < 15) d.prices.set(t, v - 600); }
    for (const [t, w] of d.weather) { const h = new Date(t).getHours(); if (h >= 10 && h < 15) w.solar = 1; }
    const { hours } = buildHours(d.prices, d.weather, s, now);
    return { P: plan(hours, s, now), now, s };
  };
  // Thursday evening; Friday is WFH by default, trip on Saturday
  const wfh = plan1("2026-10-22T20:00", s => { s.overrides = { "2026-10-24": 150 }; });
  assert.ok(wfh.P.blocks.length > 0);
  for (const b of wfh.P.blocks) {
    const d = new Date(b.start);
    assert.ok(d.getDay() === 5 && d.getHours() >= 10 && d.getHours() < 15, `WFH charge at ${d}`);
  }
  assert.strictEqual(decide(wfh.P, wfh.now, wfh.s).title, `Charge tomorrow ${hm5(wfh.P.blocks[0].start)}`);
  // Monday evening, Tuesday commute: car is away at midday, so it charges overnight
  const commute = plan1("2026-10-19T20:00", () => {});
  for (const b of commute.P.blocks) assert.ok(new Date(b.start).getHours() < 7, `commute-day charge at ${new Date(b.start)}`);
  assert.strictEqual(decide(commute.P, commute.now, commute.s).title, "Charge tonight");
});

test("charging windows are unbroken and match the planned energy", () => {
  const H = 3600e3;
  for (const [iso, soc] of [["2026-10-19T21:00", 20], ["2026-10-19T21:00", 45], ["2026-10-19T21:20", 10], ["2026-10-22T20:00", 15], ["2026-10-24T18:00", 5]]) {
    const { P, s, now } = run(iso, s => { s.soc = soc; });
    const kw = s.chargerKw * s.effPct / 100;   // battery kWh per hour
    let prevEnd = -Infinity;
    for (const b of P.blocks) {
      assert.ok(b.start >= now.getTime() - 1 && b.start >= prevEnd, `${iso}: windows ordered and not before now`);
      // window length × charger power = battery energy in the window, so charging never pauses inside it
      const energy = b.kwh * s.effPct / 100;
      assert.ok(Math.abs((b.end - b.start) / H * kw - energy) < 0.02, `${iso} ${soc}%: ${hhmm(b.start)}–${hhmm(b.end)} ${energy.toFixed(2)} kWh`);
      // and the slots inside it hold exactly that energy
      const inside = P.slots.filter(sl => sl.t + H > b.start && sl.t < b.end).reduce((a, sl) => a + sl.charge, 0);
      assert.ok(Math.abs(inside - energy) < 0.02, `${iso}: slots inside window`);
      prevEnd = b.end;
    }
  }
});

test("car setup: limit is the level after the session rounded up to 10% (min 50%), timers in 5-minute steps", () => {
  const { P, s, now } = run("2026-10-19T21:00", s => { s.soc = 20; });
  const d = decide(P, now, s);
  const next = P.events.find(e => e.check);
  // nothing charges between the session and departure here, so the limit is the level at departure, rounded up
  // to the car's 10% steps
  const planned = next.lvlBefore / P.B * 100;
  assert.strictEqual(d.setup.limit, Math.max(50, Math.ceil(planned / 10) * 10));
  assert.ok(d.setup.limit >= planned && d.setup.limit % 10 === 0);
  for (const t of d.setup.timers) {
    const m = t.match(/^(now|(\d\d):(\d\d))–(\d\d):(\d\d)$/);
    assert.ok(m, t);
    if (m[3]) assert.strictEqual(+m[3] % 5, 0, t);
    assert.strictEqual(+m[5] % 5, 0, t);
  }
  assert.ok(d.setup.timers.length === 1 || /timer windows/.test(d.setup.hint), d.setup.hint);
});

test("setup hint: run to the end of the hour only when the 10% limit matches the plan", () => {
  const H = 3600e3, s = clone(DEF), now = new Date("2026-10-19T21:00");
  const dep = new Date("2026-10-20T07:30").getTime(), start = new Date("2026-10-20T02:00").getTime();
  const card = (end, pctEnd) => decide({ events: [{ t: dep, check: true, need: 13, lvlAfter: 20 }], slots: [], endLvl: 20, B: 58,
    nextDrive: { t: dep, check: true }, mustKwh: 0, noChargeLvl: 30,
    blocks: [{ start, end, kwh: 10, cost: 20, fc: false, lvlEnd: pctEnd / 100 * 58, hours: Math.ceil((end - start) / H) }] }, now, s).setup;
  const midHour = start + 2 * H + 23 * 60e3;
  // plan ends at 59.6%: the 60% limit stops it at the planned level, so the timer may run to 05:00
  const exact = card(midHour, 59.6);
  assert.deepStrictEqual([exact.limit, exact.timers[0]], [60, "02:00–04:25"]);
  assert.ok(exact.hint.includes("until 05:00"), exact.hint);
  // plan ends at 62.3%: the limit rounds up to 70%, so the timer sets the amount
  const loose = card(midHour, 62.3);
  assert.strictEqual(loose.limit, 70);
  assert.ok(loose.hint.includes("timer sets the amount (to about 62%)") && !loose.hint.includes("until"), loose.hint);
  // below the car's 50% minimum
  assert.strictEqual(card(midHour, 34).limit, 50);
  // ends on the hour: no extension tip
  assert.ok(!card(start + 2 * H, 59.6).hint.includes("until"));
});

test("windows merge when it costs under the one-window setting, else the card offers one window and its extra cost", () => {
  const H = 3600e3, now = new Date("2026-10-19T21:00"), s = clone(DEF); s.soc = 10;
  const mk = spike => {
    const d = demoData(now);
    // flat night prices, with a spike at 02:00–03:00 between two cheap stretches
    for (let h = 0; h < 7; h++) { const t = new Date(`2026-10-20T0${h}:00`).getTime(); d.prices.set(t, h === 2 ? 300 + spike : 300); }
    for (const [t] of d.prices) { const h = new Date(t).getHours(); if (t > now.getTime() && (h >= 21 || h === 22 || h === 23)) d.prices.set(t, 2000); }
    const { hours } = buildHours(d.prices, d.weather, s, now);
    const P = plan(hours, s, now);
    return { P, d: decide(P, now, s) };
  };
  // a small spike isn't worth a second timer: one window
  assert.strictEqual(mk(30).d.setup.timers.length, 1, mk(30).d.setup.timers.join(", "));
  // ...unless the setting says never pay extra for one window
  s.oneWindowKr = 0; assert.strictEqual(mk(30).d.setup.timers.length, 2); s.oneWindowKr = DEF.oneWindowKr;
  // a big spike is: two windows, plus the single-window option with its extra cost
  const big = mk(3000);
  assert.ok(big.d.setup.timers.length === 2, big.d.setup.timers.join(", "));
  assert.match(big.d.setup.hint, /If only one window is possible, use (now|\d\d:\d\d)–\d\d:\d\d \(≈ \d+,\d\d kr more\)/);
  const sess = big.P.blocks.slice(0, 2), one = oneWindow(big.P, sess, s, now);
  const kw = s.chargerKw * s.effPct / 100, E = sess.reduce((a, b) => a + b.kwh * s.effPct / 100, 0);
  assert.ok(Math.abs((one.end - one.start) / H * kw - E) < 0.02, "one window holds the same energy");
  assert.ok(one.extra >= DEF.oneWindowKr, `extra ${one.extra}`);
  // with a high enough setting even the big spike is merged into one window
  s.oneWindowKr = 50; assert.strictEqual(mk(3000).d.setup.timers.length, 1); s.oneWindowKr = DEF.oneWindowKr;
});

test("5-minute rounding never shortens a window", () => {
  const t = new Date("2026-10-20T02:23:10").getTime();
  assert.strictEqual(hhmm(round5(t, false)), "02:20");
  assert.strictEqual(hhmm(round5(t, true)), "02:25");
  const exact = new Date("2026-10-20T02:25:00").getTime();
  assert.strictEqual(hhmm(round5(exact + 0.4, true)), "02:25");   // float noise doesn't add 5 minutes
  assert.strictEqual(hhmm(round5(exact, false)), "02:25");
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

// Past days i=1..7 before `now`: spot 1000+100*i, 0 while the car is away on driving days (must be ignored),
// and a 600 DKK/MWh dip at 11–13 on days the car is home all day.
function dayHistory(now, s) {
  const prices = new Map(), H = 3600e3, today = startOfDay(now);
  for (let i = 1; i <= 7; i++) {
    const day = addDays(today, -i), km = kmOn(day, s), base = 1000 + 100 * i;
    const dep = atTime(day, s.depart).getTime(), back = atTime(day, s.home).getTime();
    for (let t = day.getTime(); t < addDays(day, 1).getTime(); t += H) {
      const h = new Date(t).getHours();
      prices.set(t, km > 0 && t < back && t + H > dep ? 0 : km === 0 && (h === 11 || h === 12) ? base - 600 : base);
    }
  }
  return prices;
}

test("recent days use home hours only, including midday on WFH days and weekends", () => {
  const now = new Date("2026-10-19T21:00"), s = clone(DEF);   // Mon; Fri 16, Sat 17, Sun 18 are home days
  const at = (spot, iso) => totalPrice(spot, new Date(iso).getTime(), s);
  const expected = [1, 2, 3, 4, 5, 6, 7].map(i => {
    const day = addDays(startOfDay(now), -i);
    return kmOn(day, s) > 0 ? at(1000 + 100 * i, "2026-10-15T03:00") : at(1000 + 100 * i - 600, "2026-10-15T12:00");
  }).sort((a, b) => a - b);
  const days = recentDays(dayHistory(now, s), s, now, 2);
  assert.strictEqual(days.length, 7);
  days.forEach((v, j) => assert.ok(Math.abs(v - expected[j]) < 1e-9, `day ${j}: ${v} vs ${expected[j]}`));
});

test("price rating thresholds", () => {
  const n = [1, 2, 3, 4, 5, 6, 7];
  assert.strictEqual(priceRating(0.5, n).level, "cheap");
  assert.strictEqual(priceRating(2.5, n).level, "cheap");     // beats 5/7
  assert.strictEqual(priceRating(3.5, n).level, "typical");   // beats 4/7
  assert.strictEqual(priceRating(5.5, n).level, "pricey");    // beats 2/7
  assert.strictEqual(priceRating(1, [1, 2]), null);           // too little history
});

test("decision card rates the window against recent days", () => {
  const now = new Date("2026-10-19T21:00"), s = clone(DEF), H = 3600e3;
  const prices = dayHistory(now, s);
  const start = new Date("2026-10-20T02:00").getTime();
  const card = spot => {
    const price = totalPrice(spot, start, s);
    const P = { events: [], slots: [], endLvl: 30, B: 58, mustKwh: 0, nextDrive: { t: new Date("2026-10-20T07:30").getTime(), check: true },
      blocks: [{ start, end: start + 2 * H, kwh: 10, cost: 10 * price, fc: false }] };
    return decide(P, now, s, prices);
  };
  const cheap = card(300), pricey = card(1750);
  assert.strictEqual(cheap.rate.level, "cheap");
  assert.strictEqual(cheap.lvl, "Optional · good price");
  assert.ok(cheap.rate.text.includes("beats 7 of the last 7 days") && cheap.rate.text.includes("cheapest 2 home hours"), cheap.rate.text);
  assert.strictEqual(pricey.rate.level, "pricey");
  assert.strictEqual(pricey.lvl, "Optional · cheapest ahead");
});

/* ---------- battery level after a drive ---------- */
// Mon 19 Oct 2026 is a commute day: 07:30–17:00, 78 km, shoulder season 17 kWh/100 km = 13.26 kWh.
const ms = iso => new Date(iso).getTime();
function soc(at, edit) { const s = clone(DEF); s.soc = 80; s.socAt = ms(at); edit && edit(s); return s; }

test("estimate subtracts a completed commute", () => {
  const e = socEstimate(soc("2026-10-19T06:00"), new Date("2026-10-19T18:00"));
  assert.strictEqual(e.trips.length, 1);
  assert.strictEqual(e.km, 78);
  assert.ok(Math.abs(e.usedKwh - 13.26) < 1e-9, e.usedKwh);
  assert.strictEqual(e.pct, Math.round((0.8 * 58 - 13.26) / 58 * 100));   // 57
});

test("no estimate before the car leaves, without socAt, or when stale", () => {
  assert.strictEqual(socEstimate(soc("2026-10-19T06:00"), new Date("2026-10-19T07:00")), null);
  assert.strictEqual(socEstimate(soc("2026-10-19T12:00"), new Date("2026-10-19T16:00")), null);
  assert.strictEqual(socEstimate(soc("2026-10-19T18:00"), new Date("2026-10-19T21:00")), null);
  assert.strictEqual(socEstimate(soc("2026-10-19T06:00", s => { s.socAt = null; }), new Date("2026-10-19T18:00")), null);
  assert.strictEqual(socEstimate(soc("2026-10-01T06:00"), new Date("2026-10-19T18:00")), null);
});

test("level set while away counts half the trip", () => {
  const e = socEstimate(soc("2026-10-19T12:00"), new Date("2026-10-19T18:00"));
  assert.strictEqual(e.km, 39);
  assert.strictEqual(e.trips[0].leg, "back");
});

test("while away, the drive to work counts as done", () => {
  const e = socEstimate(soc("2026-10-19T06:00"), new Date("2026-10-19T12:00"));
  assert.deepStrictEqual(e.trips.map(t => [t.leg, t.km]), [["out", 39]]);
  assert.strictEqual(e.pct, Math.round((0.8 * 58 - 6.63) / 58 * 100));
});

test("plan starts from the estimate: the drive to work is subtracted", () => {
  const now = new Date("2026-10-19T12:00"), d = demoData(now);
  const s = soc("2026-10-18T21:00", s => { s.soc = 30; });
  const { hours } = buildHours(d.prices, d.weather, s, now);
  const P = plan(hours, s, now), back = P.events.find(e => e.returning);
  assert.ok(Math.abs(P.soc0 - (0.3 * 58 - 6.63)) < 1e-9, P.soc0);
  assert.ok(Math.abs(back.lvlBefore - P.soc0) < 1e-9);
  assert.strictEqual(back.need, 6.63);   // only the drive home is still ahead
  // level set at work: nothing driven since, so plan from it
  const s2 = soc("2026-10-19T11:00", s => { s.soc = 30; });
  assert.strictEqual(plan(hours, s2, now).soc0, 0.3 * 58);
  // set at home after the drive: the whole day is subtracted until the level is updated
  const eve = new Date("2026-10-19T19:00"), d2 = demoData(eve), h2 = buildHours(d2.prices, d2.weather, s, eve).hours;
  assert.ok(Math.abs(plan(h2, s, eve).soc0 - (0.3 * 58 - 13.26)) < 1e-9);
});

test("a reading at work and one at home log the two drives", () => {
  const s = soc("2026-10-19T06:00"), noon = new Date("2026-10-19T12:00");
  let log = logReading([], socEstimate(s, noon), 70, s, noon);
  assert.strictEqual(log[0].leg, "out");
  assert.strictEqual(log[0].km, 39);
  const s2 = soc("2026-10-19T12:00", s => { s.soc = 70; }), eve = new Date("2026-10-19T19:00");
  log = logReading(log, socEstimate(s2, eve), 64, s2, eve);
  assert.strictEqual(log.length, 2);
  assert.deepStrictEqual([log[1].leg, log[1].km, log[1].predKwh, log[1].actKwh], ["back", 39, 6.63, 3.48]);
  assert.ok(!deviates(log[1], s2));   // 3.5 vs 6.6 kWh on one drive is noise, not a wrong distance
  assert.ok(deviates({ ...log[1], leg: "day" }, s2));
  // km correction (whole day 100 km) recounts the drive home as half of it, not halved twice
  s2.overrides = { "2026-10-19": 100 };
  const fixed = relogKm(log, s2)[1];
  assert.deepStrictEqual([fixed.km, fixed.predKwh], [50, 8.5]);
});

test("planned charging since socAt is added, clipped to socAt and now", () => {
  const s = soc("2026-10-18T20:00", s => { s.soc = 40; s.planned = [[ms("2026-10-18T19:00"), ms("2026-10-18T22:00")], [ms("2026-10-19T18:00"), ms("2026-10-19T20:00")]]; });
  const e = socEstimate(s, new Date("2026-10-19T19:00"));
  const kw = 11 * 0.9;
  assert.ok(Math.abs(e.chargedKwh - 3 * kw) < 1e-9, e.chargedKwh);   // 2 h Sun evening + 1 h so far tonight
  assert.strictEqual(e.pct, Math.round((0.4 * 58 + 3 * kw - 13.26) / 58 * 100));
});

test("estimate uses km overrides and spans several days, clamped at 0", () => {
  const s = soc("2026-10-19T06:00", s => { s.overrides = { "2026-10-19": 300 }; });
  const e = socEstimate(s, new Date("2026-10-20T18:00"));
  assert.deepStrictEqual(e.trips.map(t => t.km), [300, 78]);
  assert.strictEqual(e.pct, 0);
});

test("notePlanned keeps the past part and replaces the future", () => {
  const s = soc("2026-10-19T18:00"), now = new Date("2026-10-19T21:00");
  const old = [[ms("2026-10-19T17:00"), ms("2026-10-19T19:00")], [ms("2026-10-19T20:00"), ms("2026-10-19T23:00")], [ms("2026-10-20T01:00"), ms("2026-10-20T02:00")]];
  const P = { nextDrive: { t: ms("2026-10-20T07:30") }, blocks: [{ start: ms("2026-10-20T02:00"), end: ms("2026-10-20T03:00") }, { start: ms("2026-10-20T19:00"), end: ms("2026-10-20T20:00") }] };
  assert.deepStrictEqual(notePlanned(old, P, now, s), [
    [ms("2026-10-19T17:00"), ms("2026-10-19T19:00")],
    [ms("2026-10-19T20:00"), ms("2026-10-19T21:00")],
    [ms("2026-10-20T02:00"), ms("2026-10-20T03:00")]]);
});

test("readings: nudges within 10 minutes edit the last entry", () => {
  const s = soc("2026-10-19T06:00"), est = socEstimate(s, new Date("2026-10-19T18:00"));
  let log = logReading([], est, null, s, new Date("2026-10-19T18:00"));
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].actKwh, null);
  assert.strictEqual(log[0].date, "2026-10-19");
  log = logReading(log, null, 50, s, new Date("2026-10-19T18:05"));
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].actKwh, Math.round((0.8 * 58 - 0.5 * 58) * 100) / 100);
  log = logReading(log, null, 49, s, new Date("2026-10-19T18:30"));   // too late to be a nudge, no new drive
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].actKwh, Math.round((0.8 * 58 - 0.5 * 58) * 100) / 100);
  const s2 = soc("2026-10-19T18:05", s => { s.soc = 50; });
  const est2 = socEstimate(s2, new Date("2026-10-20T18:00"));
  log = logReading(log, est2, 30, s2, new Date("2026-10-20T18:00"));
  assert.strictEqual(log.length, 2);
});

test("deviation needs 5 points and 25% off; km correction recounts", () => {
  const s = soc("2026-10-19T06:00"), est = socEstimate(s, new Date("2026-10-19T18:00"));   // predicts 13.26 kWh
  const at = pct => logReading([], est, pct, s, new Date("2026-10-19T18:00"))[0];
  assert.ok(!deviates(at(57), s));
  assert.ok(!deviates(at(53), s));            // 15.6 kWh: 18% off
  assert.ok(deviates(at(45), s));             // 20.3 kWh: 53% off, 12 points
  assert.ok(!deviates(at(null), s));
  s.overrides = { "2026-10-19": 120 };
  const fixed = relogKm([at(45)], s)[0];
  assert.strictEqual(fixed.km, 120);
  assert.ok(!deviates(fixed, s));             // 120 km × 17 = 20.4 kWh
});

test("settingsFrom drops malformed SOC history", () => {
  const s = stored({ socAt: "x", planned: [[2, 1], [1, 2], "a"], socLog: [{ at: 1 }, { at: 1, from: 0, km: 78, predKwh: 13, startKwh: 40 }] });
  assert.strictEqual(s.socAt, null);
  assert.deepStrictEqual(s.planned, [[1, 2]]);
  assert.strictEqual(s.socLog.length, 1);
  assert.deepStrictEqual(stored({}).planned, []);
});

test("settingsFrom keeps the car name and a valid price area", () => {
  assert.strictEqual(stored({}).car, "ID.3");
  assert.strictEqual(stored({ car: "  Kona  " }).car, "Kona");
  assert.strictEqual(stored({ car: 3 }).car, "ID.3");
  assert.strictEqual(stored({ car: "x".repeat(40) }).car.length, 24);
  assert.strictEqual(stored({ area: "DK2" }).area, "DK2");
  assert.strictEqual(stored({ area: "SE3" }).area, "DK1");
});

/* ---------- accept or reject the plan ---------- */
// Mon 19 Oct 21:00, commute Tue 07:30: from 20% the plan must charge tonight.
const NIGHT = "2026-10-19T21:00";
const before = (P, c) => P.blocks.filter(b => b.start < c.until);

test("accepting locks the session even when prices change", () => {
  const { P, s, now } = run(NIGHT, s => { s.soc = 20; });
  const c = commitFrom(P, "plan", now);
  assert.strictEqual(c.kind, "plan");
  assert.strictEqual(c.until, ms("2026-10-20T07:30"));
  assert.ok(c.windows.length >= 1 && c.limit >= 50);
  s.commit = c;
  const d = demoData(now);
  for (const [t, v] of d.prices) d.prices.set(t, new Date(t).getHours() === 22 ? 50 : v + 400);   // 22:00 now much cheaper
  const P2 = plan(buildHours(d.prices, d.weather, s, now).hours, s, now);
  assert.deepStrictEqual(before(P2, c).map(b => [Math.round(b.start), Math.round(b.end)]), c.windows);
  const card = decide(P2, now, s, null);
  assert.ok(card.committed && card.lvl === "Accepted", card.lvl);
  assert.ok(!card.choose);
});

test("an own timer window becomes the session, stopped at its limit", () => {
  const { P, s, now } = run(NIGHT, s => { s.soc = 20; });
  s.commit = commitFrom(P, "manual", now, { start: "23:00", end: "06:00", limit: 50 });
  assert.deepStrictEqual(s.commit.windows, [[ms("2026-10-19T23:00"), ms("2026-10-20T06:00")]]);
  const { hours } = buildHours(demoData(now).prices, demoData(now).weather, s, now);
  const P2 = plan(hours, s, now), b = before(P2, s.commit);
  assert.strictEqual(b[0].start, ms("2026-10-19T23:00"));
  assert.ok(Math.abs(b[b.length - 1].lvlEnd - 0.5 * 58) < 0.05, b[b.length - 1].lvlEnd);   // 30% → 20% → 50% limit
  const card = decide(P2, now, s, null);
  assert.strictEqual(card.lvl, "Your timer");
  assert.deepStrictEqual(card.setup, { limit: 50, timers: ["23:00–06:00"], hint: "" });
});

test("not charging warns when it leaves the commute short", () => {
  const { P, s, now, hours } = run(NIGHT, s => { s.soc = 20; });
  s.commit = commitFrom(P, "none", now);
  const P2 = plan(hours, s, now);
  assert.strictEqual(before(P2, s.commit).length, 0);
  const card = decide(P2, now, s, null);
  assert.strictEqual(card.cls, "bad");
  assert.ok(card.title.startsWith("Your choice leaves tomorrow short"), card.title);
});

test("not charging with enough battery shows the arrival level", () => {
  const { P, s, now, hours } = run(NIGHT, s => { s.soc = 70; s.cheapFill = 5; });   // cheap fill proposes charging
  s.commit = commitFrom(P, "none", now);
  const card = decide(plan(hours, s, now), now, s, null);
  assert.strictEqual(card.cls, "ok");
  assert.strictEqual(card.title, "No charging before you leave tomorrow 07:30");
  assert.ok(card.sub.includes("You get home from tomorrow's drive with"), card.sub);
});

test("a choice expires when the car leaves", () => {
  const { P, s, now } = run(NIGHT, s => { s.soc = 20; });
  s.commit = commitFrom(P, "none", now);
  const later = new Date("2026-10-20T18:00");
  const d = demoData(later), P2 = plan(buildHours(d.prices, d.weather, s, later).hours, s, later);
  assert.strictEqual(P2.commit, null);
});

test("own timer: start in the past means now, clipped to departure, null if after it", () => {
  const { P, now } = run(NIGHT, s => { s.soc = 20; });
  assert.deepStrictEqual(commitFrom(P, "manual", now, { start: "20:00", end: "09:00", limit: 80 }).windows,
    [[now.getTime(), ms("2026-10-20T07:30")]]);
  assert.strictEqual(commitFrom(P, "manual", now, { start: "08:00", end: "10:00", limit: 80 }), null);
});

test("settingsFrom keeps a valid choice and drops a malformed one", () => {
  const c = { kind: "manual", until: 5, windows: [[1, 2]], limit: 80, at: 0 };
  assert.deepStrictEqual(stored({ commit: c }).commit, c);
  assert.strictEqual(stored({ commit: { ...c, kind: "x" } }).commit, null);
  assert.strictEqual(stored({ commit: { ...c, limit: 30 } }).commit, null);
  assert.strictEqual(stored({ commit: { ...c, windows: [[2, 1]] } }).commit, null);
  assert.strictEqual(stored({ commit: { ...c, kind: "none", limit: null } }).commit.limit, null);
  assert.deepStrictEqual(stored({ planned: [[1, 2, 1], [1, 2, 7]] }).planned, [[1, 2, 1]]);
});

test("estimate tells chosen charging from assumed", () => {
  const s = soc("2026-10-18T20:00", s => { s.soc = 40; s.planned = [[ms("2026-10-18T22:00"), ms("2026-10-18T23:00"), 1], [ms("2026-10-19T01:00"), ms("2026-10-19T02:00")]]; });
  const e = socEstimate(s, new Date("2026-10-19T18:00")), kw = 11 * 0.9;
  assert.ok(Math.abs(e.chargedKwh - 2 * kw) < 1e-9 && Math.abs(e.chosenKwh - kw) < 1e-9);
  const { P, now } = run(NIGHT, s => { s.soc = 20; });
  P.commit = commitFrom(P, "plan", now);
  assert.ok(notePlanned([], P, now, { socAt: null }).every(w => w[2] === 1));
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
