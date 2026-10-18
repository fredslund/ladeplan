# Ladeplan

A personal EV charging planner (VW ID.3, home charger, price area DK1). It answers one question each day: should we charge tonight, and when, or is it cheaper to wait?

## How it works

Two static files, no build step and no backend. Everything runs in the browser.

- `ladeplan.js`: ES module with all pure logic (settings defaults, limits and migration via `settingsFrom()`, time helpers, tariffs, the forecast model, `parsePrices()`, `plan()`, `decide()`, `demoData()`). No DOM, no `localStorage`, no network; the tests import it directly.
- `index.html`: markup, CSS and a `<script type="module">` that imports `ladeplan.js` and does storage, fetching and rendering.
- `package.json` only sets `"type": "module"` (so Node treats the `.js` files as ES modules) and an `npm test` alias.

Module scripts don't run from `file://`, so open the page over HTTP (e.g. `python3 -m http.server`).

1. **Prices**: day-ahead spot prices from elprisenligenu.dk (`/api/v1/prices/{YYYY}/{MM}-{DD}_{DK1|DK2}.json`, one file per day, free, no key, CORS open). Values are `DKK_per_kWh` excl. VAT; `parsePrices()` converts to DKK/MWh keyed by UTC hour and averages any sub-hourly records. The app fetches 22 past days + today + 2 ahead in parallel. Next-day files appear around 13:00 Danish time; before that they 404, and the 404 is cacheable for 4 h, so future days are fetched with `cache: "no-store"`. Energi Data Service was the original source but returns an empty body without CORS headers to browser requests (verified 2026-10-18), so it can't be called from the page.
2. **Total price** per kWh = (spot/1000 + supplier markup + grid tariff + Energinet tariffs + elafgift) × 1.25 VAT. All tariff values are user settings. The grid tariff has hour bands (00–06, 06–17, 17–21 peak, 21–24) and two seasons, `t.winter` (Oct–Mar) and `t.summer` (Apr–Sep), picked by each hour's own date in `tariff()`. Old flat `t.night/day/peak` settings are copied to both seasons by `migrateTariffs()`.
3. **Weather**: Open-Meteo forecast API with `past_days=22`, hourly wind at 100 m, shortwave radiation and temperature at five points (DK west coast, Thy, North Sea, North Germany ×2).
4. **Forecast model**: recency-weighted ridge regression (half-life 7 days) on ~3 weeks of hourly data. Features: wind power proxy (and its square), solar, temperature, weekend flag, hour-of-day dummies. Refitted on every page load. Used only for hours without published prices, up to the end of the day after tomorrow.
5. **Planner** (`plan()`): simulates battery kWh hour by hour. Each commute is an event at departure time that must leave `reserve + trip energy` in the battery. For each event in order, it fills the deficit from the cheapest available home slots before departure, respecting the charge limit (falls back to 100% if a trip needs it). Forecast slots are ranked at price + 0.5σ so the plan only waits for a forecast when it is clearly cheaper. Optional "always fill below X kr/kWh" tops up in very cheap hours.
5b. **Decision card** (`decide()`, pure): two questions set the level. Is charging *needed* before the next drive (`plan()` returns `mustKwh`: energy needed to keep the reserve with no charging at all), and is tonight's price *known or forecast*? Levels: Not enough → Needed (tonight) → Needed before {day} (cheaper later) → Optional · good price → Forecast → Not needed tonight → Not needed. The card totals all windows before tomorrow's departure and says how much of it is strictly needed.
6. **Consumption**: seasonal kWh/100 km (summer/shoulder/winter) with a user-editable month-to-season map; each trip uses the value for its date.
7. **Settings**: `localStorage` key `ladeplan.v1`, per device only. Older keys are migrated in `loadSettings()`. Numeric settings are clamped to `LIMITS` on load and on edit; an emptied field keeps its previous value.
8. **Degraded mode**: if Open-Meteo fails, the app still plans on known prices (no forecast hours) and the stamp says "no forecast".

## Owner's preferences and constraints

- Commute 39 km each way, usually one WFH day per week (configurable weekly pattern plus per-date km overrides).
- Must arrive home with at least 10% battery.
- 58 kWh usable battery, 11 kW AC charging.
- Intended deployment: GitHub Pages, added to the phone home screen. Keep it static with no build step; split further only when a feature needs it (e.g. the backtest view).
- UI copy is English; keep it plain and short. Mobile first (~390 px wide), light and dark themes via CSS tokens on `:root`.

## Tests

```
TZ=Europe/Copenhagen node tests/plan.test.js   # or: npm test
```

The test imports `ladeplan.js` and runs the planner and model on synthetic data (`demoData()`), plus price parsing on real sample files in `tests/fixtures/` (including the 25-hour DST day). No network needed. New logic goes in `ladeplan.js` (and into its `export` list) unless it needs the DOM, storage or network.

## Not yet verified

- **On the phone.** Deployed to GitHub Pages at https://fredslund.github.io/ladeplan/ (repo `fredslund/ladeplan`, Pages from `main`, root). Live prices and weather verified there from desktop Chrome on 2026-10-18; not yet tested on a phone or as a home-screen app.
- **elprisenligenu.dk is a third-party hobby service** with no fallback; if it disappears, prices need another browser-callable source.
- **Default tariffs**: grid tariffs are N1's C-customer rates valid from 1 Jan 2026 (n1.dk/gaeldende-priser, published in øre incl. VAT, stored as kr excl. VAT). N1's page doesn't state the hour bands or season months; the app assumes the standard Tarifmodel 3.0 ones. Energinet, elafgift and supplier markup defaults are still rough estimates. Update the grid defaults when N1 publishes 2027 prices; add the replaced values to `OLD_GRID_DEFAULTS` so untouched settings follow.

## Known simplifications worth reviewing

- The whole day's trip energy is deducted at departure; the hours containing departure and return are treated as away.
- If the battery level is entered while the car is away, only half the day's trip is assumed to remain.
- Trips after the planning horizon (end of the day after tomorrow) are ignored, so the plan can end right at the reserve.
- Grid tariff hour bands and season months (Oct–Mar high) are fixed, not editable.
- Forecast σ is in-sample on the last 7 days and only grows linearly with lead time; there is no proper backtest.
- `headroom()` re-simulates the whole timeline for each candidate slot (O(n²)); fine for ~72 slots.

## Ideas on the list

- Consumption driven by forecast temperature on each drive day instead of fixed seasons.
- Export/import of settings as a short code, to move them between phones.
- A backtest view: how good were the forecasts and how much did the plan save vs. charging at 17:00.
- Optional direct charger or car control if an API is available.
