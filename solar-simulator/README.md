# Solar System Simulation Tool — South Africa 🇿🇦☀️

A browser-based tool that sizes a grid-tied / hybrid PV + battery system for
South African conditions and models its financials. Built as plain
HTML/CSS/JS (no build step) so it can be dropped onto any static host.

**Design principle:** the mathematical simulation logic
(`simulation.js`) is fully separated from the user interface
(`index.html` + `app.js` + `styles.css`). The engine is pure, deterministic,
and unit-tested in Node.

## Files

| File | Role |
|------|------|
| `simulation.js` | **Pure engine** — irradiance, sizing, energy balance, financials. No DOM. Usable in the browser (`window.SolarSim`) or Node (`require`). |
| `index.html` | The form + results layout. |
| `app.js` | UI glue — reads the form, calls the engine, renders results & charts. |
| `styles.css` | Styling. |
| `simulation.test.mjs` | 33 sanity tests for the engine. |

## Run

Open `index.html` in a browser (or serve the folder). To run the tests:

```bash
node solar-simulator/simulation.test.mjs
```

## How it maps to the requirements

### 1. Location & Solar Production
- **Irradiance:** 11 hard-coded SA regional Peak-Sun-Hour defaults (Upington 5.5 h,
  Johannesburg 5.2 h, Cape Town 4.8 h, Durban 4.2 h, …). A **PVGIS API**
  fetch (`pvgisUrl` / `pshFromAnnualYield`) pulls site-specific annual yield and
  converts it to an effective PSH; it falls back to the regional average if the
  API is unreachable (e.g. offline or CORS-blocked).
- **System losses:** adjustable **Performance Ratio** defaulting to 78% (75–80%
  band) for temperature derating, dust and inverter efficiency.
- **Orientation:** defaults to **North-facing, 30° tilt**; tilt and azimuth are
  user-adjustable and feed an `orientationFactor()` derate.

### 2. Building Load Profile
- Input either **average daily kWh** or a **monthly bill in ZAR** (converted via
  the tariff).
- **Residential vs Commercial** toggle switches the 24-hour load shape
  (residential = morning geyser + evening peaks; commercial = daytime demand
  aligned with the solar curve), which drives self-consumption modelling.

### 3. Battery Sizing & Loadshedding
- Size by **target backup hours (2.5–4 h)** or by **loadshedding stage**
  (mapped to recommended hours).
- **LiFePO4** defaults: **90% DoD**, 0.5C continuous discharge. The battery is
  sized to meet **both** the backup energy requirement **and** the building's
  **peak kW demand** during an outage (whichever dominates).

### 4. Financial & Regulatory (SSEG)
- Tariff default **R3.50/kWh** with adjustable **annual escalation (default 12%)**.
- **Export to Grid** toggle with a feed-in tariff; **NRS 097-2-1** compliance
  check flags single-phase inverters above **4.6 kVA** on a 60 A connection.
- Outputs: **PV array (kWp)**, **Inverter (kVA)**, **Battery (kWh)**,
  **Payback (years)** and **ROI**, plus NPV, self-sufficiency and a 25-year
  cash-flow projection.

## Assumptions & caveats

- Typical-day modelling (one representative daily load & solar shape) — not an
  8760-hour time series. Good for feasibility/sizing, not for bankable yield
  guarantees.
- ROI is **nominal** over 25 years (escalation compounds), so headline ROI% is
  large; **NPV** (discounted) is shown alongside for a conservative view.
- Costs are indicative rands-per-unit inputs — adjust the *Advanced cost
  assumptions* to match live supplier quotes.
- Charts use Chart.js from a CDN; the tool still functions (numbers/tables) if
  the CDN is blocked.
