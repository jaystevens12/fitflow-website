/*
 * simulation.js — Solar System Simulation Engine (South Africa)
 * ------------------------------------------------------------------
 * PURE calculation logic. No DOM, no rendering, no I/O.
 * Everything here is a deterministic function of its inputs so it can be
 * unit-tested in Node and reused by any UI.
 *
 * Exposed as:
 *   - window.SolarSim  (browser)
 *   - module.exports   (Node / tests)
 *
 * Units convention:
 *   kWp  = DC peak power of the PV array
 *   kVA  = apparent power rating of the inverter
 *   kWh  = energy
 *   PSH  = Peak Sun Hours (kWh/m2/day equivalent full-sun hours)
 *   PR   = Performance Ratio (fraction, 0-1) — temperature/dust/inverter losses
 *   ZAR  = South African Rand (R)
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. LOCATION & IRRADIANCE  ------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Average daily Peak Sun Hours for major South African locations.
   * Used as a fallback when live PVGIS / NASA POWER data is unavailable.
   * Figures are annual daily averages on a north-facing, tilt≈latitude plane.
   */
  var SA_REGIONS = {
    upington:     { name: 'Upington (Northern Cape)',   psh: 5.5, lat: -28.45, lon: 21.26 },
    kimberley:    { name: 'Kimberley (Northern Cape)',  psh: 5.5, lat: -28.74, lon: 24.77 },
    bloemfontein: { name: 'Bloemfontein (Free State)',  psh: 5.4, lat: -29.09, lon: 26.16 },
    polokwane:    { name: 'Polokwane (Limpopo)',        psh: 5.3, lat: -23.90, lon: 29.47 },
    johannesburg: { name: 'Johannesburg (Gauteng)',     psh: 5.2, lat: -26.20, lon: 28.05 },
    pretoria:     { name: 'Pretoria (Gauteng)',         psh: 5.2, lat: -25.75, lon: 28.19 },
    nelspruit:    { name: 'Mbombela / Nelspruit (Mpu)', psh: 4.9, lat: -25.47, lon: 30.99 },
    gqeberha:     { name: 'Gqeberha / PE (E. Cape)',    psh: 4.9, lat: -33.96, lon: 25.60 },
    capetown:     { name: 'Cape Town (Western Cape)',    psh: 4.8, lat: -33.92, lon: 18.42 },
    eastlondon:   { name: 'East London (E. Cape)',      psh: 4.6, lat: -33.02, lon: 27.91 },
    durban:       { name: 'Durban (KwaZulu-Natal)',     psh: 4.2, lat: -29.86, lon: 31.03 }
  };

  /**
   * Orientation derate factor relative to the optimal plane.
   * In the southern hemisphere the optimum is due-NORTH facing at a tilt close
   * to the site latitude (~25-30° for most of SA).
   *
   * @param {number} tilt    Panel tilt from horizontal, degrees (0 = flat).
   * @param {number} azimuth Deviation from due north, degrees (0 = north).
   * @returns {number} multiplier in [0.5, 1.0]
   */
  function orientationFactor(tilt, azimuth) {
    var OPTIMAL_TILT = 30;
    var tiltDev = Math.abs((tilt == null ? OPTIMAL_TILT : tilt) - OPTIMAL_TILT);
    var az = Math.abs(azimuth || 0);
    // Gentle quadratic penalties calibrated to typical PV behaviour:
    //  - a flat (0°) or very steep (60°) array loses ~10-15%
    //  - facing 90° off-north (due E/W) loses ~20-25%
    var tiltF = 1 - 0.0025 * tiltDev - 0.00010 * tiltDev * tiltDev;
    var azF = 1 - 0.00003 * az * az;
    return round(clamp(tiltF, 0.6, 1) * clamp(azF, 0.5, 1), 4);
  }

  /**
   * Build a PVGIS API URL (v5.2 PVcalc). Kept here so the UI layer only deals
   * with fetch/parse. PVGIS already accounts for tilt/temperature losses.
   * aspect: PVGIS convention 0=S, 90=W, -90=E, 180=N. SA arrays face north.
   */
  function pvgisUrl(lat, lon, tilt, azimuth) {
    var aspect = 180 - (azimuth || 0); // due north = 180 in PVGIS terms
    var q = [
      'lat=' + lat, 'lon=' + lon, 'peakpower=1', 'loss=14',
      'mountingplace=building', 'angle=' + (tilt || 30),
      'aspect=' + aspect, 'outputformat=json'
    ].join('&');
    return 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?' + q;
  }

  /**
   * Convert a PVGIS annual specific yield (kWh/kWp/yr) back into an effective
   * PSH figure consistent with THIS engine's generation model, so the rest of
   * the simulation is unchanged whether PSH comes from PVGIS or the table.
   */
  function pshFromAnnualYield(annualYieldKwhPerKwp, pr, orient) {
    return round(annualYieldKwhPerKwp / (365 * pr * orient), 3);
  }

  // ---------------------------------------------------------------------------
  // 2. LOAD PROFILES  ---------------------------------------------------------
  // ---------------------------------------------------------------------------

  // Normalised 24-hour load shapes (relative weights; normalised at use).
  // Residential: morning (geysers) + evening (cooking/lighting) peaks.
  // Commercial : heavy 08:00-17:00 daytime demand, aligning with the solar curve.
  var LOAD_SHAPES = {
    residential: [
      0.020, 0.015, 0.015, 0.015, 0.020, 0.030, 0.055, 0.070, 0.055, 0.035,
      0.030, 0.028, 0.028, 0.028, 0.028, 0.030, 0.040, 0.065, 0.085, 0.090,
      0.075, 0.055, 0.035, 0.025
    ],
    commercial: [
      0.010, 0.010, 0.010, 0.010, 0.010, 0.010, 0.020, 0.040, 0.070, 0.085,
      0.090, 0.090, 0.085, 0.088, 0.090, 0.085, 0.070, 0.055, 0.040, 0.030,
      0.025, 0.020, 0.015, 0.012
    ]
  };

  /** Normalise a 24-element weight array so it sums to 1. */
  function normalise(arr) {
    var s = arr.reduce(function (a, b) { return a + b; }, 0);
    return arr.map(function (v) { return v / s; });
  }

  /** Normalised solar generation shape (clipped cosine, sunrise 06:00, sunset 18:00). */
  function solarShape() {
    var raw = [];
    for (var h = 0; h < 24; h++) {
      var x = (h + 0.5 - 12) / 6; // -1 at 06:00, 0 at noon, +1 at 18:00
      raw.push(Math.abs(x) >= 1 ? 0 : Math.cos(x * Math.PI / 2));
    }
    return normalise(raw);
  }

  /**
   * Derive average daily consumption (kWh/day) from user inputs.
   * Accepts either a direct daily kWh figure, or a monthly bill in ZAR that is
   * converted using the supplied tariff.
   */
  function dailyConsumption(input) {
    if (input.dailyKwh && input.dailyKwh > 0) return input.dailyKwh;
    if (input.monthlyBill && input.tariff > 0) {
      return (input.monthlyBill / input.tariff) / 30.4;
    }
    if (input.monthlyKwh && input.monthlyKwh > 0) return input.monthlyKwh / 30.4;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 3. GENERATION & SELF-CONSUMPTION  ----------------------------------------
  // ---------------------------------------------------------------------------

  /** Daily PV generation (kWh) for a given array size. */
  function dailyGeneration(kwp, psh, pr, orient) {
    return kwp * psh * pr * orient;
  }

  // ---------------------------------------------------------------------------
  // 4. SYSTEM SIZING  ---------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Recommend PV array size (kWp) to offset a target fraction of daily load.
   */
  function sizePv(dailyKwh, offsetTarget, psh, pr, orient) {
    var kwp = (dailyKwh * offsetTarget) / (psh * pr * orient);
    return Math.max(0, roundUp(kwp, 1));
  }

  /**
   * Loadshedding stage -> suggested target backup hours.
   * (Higher stages mean longer & more frequent outage slots.)
   */
  function backupHoursForStage(stage) {
    var map = { 1: 2, 2: 2.5, 3: 2.5, 4: 3, 5: 3.5, 6: 4, 7: 4, 8: 4.5 };
    return map[stage] || 3;
  }

  /**
   * Battery sizing driven by loadshedding backup requirement.
   *
   * Must satisfy BOTH:
   *   (a) Energy: backupLoadKw * backupHours of usable energy.
   *   (b) Power : discharge rating >= peak kW demand during an outage.
   *               LiFePO4 continuous discharge ≈ maxCrate (default 0.5C), so
   *               nominal kWh must be >= peakKw / maxCrate.
   *
   * @returns {{usableKwh, nominalKwh, drivenBy}}
   */
  function sizeBattery(backupLoadKw, backupHours, peakKw, opts) {
    opts = opts || {};
    var dod = opts.dod != null ? opts.dod : 0.90;      // LiFePO4 90% DoD
    var maxCrate = opts.maxCrate != null ? opts.maxCrate : 0.5;

    var energyUsable = backupLoadKw * backupHours;      // (a)
    var energyNominal = energyUsable / dod;

    var powerNominal = peakKw / maxCrate;               // (b)

    var nominalKwh = Math.max(energyNominal, powerNominal);
    var drivenBy = powerNominal > energyNominal ? 'peak-power' : 'backup-energy';

    return {
      usableKwh: round(nominalKwh * dod, 2),
      nominalKwh: roundUp(nominalKwh, 1),
      drivenBy: drivenBy,
      dischargeKw: round(nominalKwh * maxCrate, 2)
    };
  }

  /**
   * Inverter sizing (kVA). Must handle the greater of:
   *   - the PV array (via a DC:AC ratio), and
   *   - the building peak load (via power factor).
   */
  function sizeInverter(pvKwp, peakKw, opts) {
    opts = opts || {};
    var dcAc = opts.dcAcRatio != null ? opts.dcAcRatio : 1.15;
    var pf = opts.powerFactor != null ? opts.powerFactor : 0.9;
    var fromPv = pvKwp / dcAc;
    var fromLoad = peakKw / pf;
    return {
      kva: roundUp(Math.max(fromPv, fromLoad), 0.5),
      drivenBy: fromLoad > fromPv ? 'peak-load' : 'pv-array'
    };
  }

  /**
   * NRS 097-2-1 compliance check for embedded generation.
   * Single-phase inverters are limited to 4.6 kVA on a standard 60 A connection.
   */
  function nrs097Check(inverterKva, phase, exportEnabled) {
    var limit = phase === 'single' ? 4.6 : 13.8; // 3× 4.6 for three-phase
    var compliant = inverterKva <= limit;
    var msg;
    if (compliant) {
      msg = 'Inverter ' + inverterKva + ' kVA is within the NRS 097-2-1 limit (' +
        limit + ' kVA for ' + phase + '-phase).';
    } else if (phase === 'single') {
      msg = 'Inverter ' + inverterKva + ' kVA EXCEEDS the 4.6 kVA single-phase ' +
        'NRS 097-2-1 limit on a 60 A connection. Move to a three-phase supply, ' +
        'split into multiple compliant inverters, or apply for a larger connection.';
    } else {
      msg = 'Inverter ' + inverterKva + ' kVA exceeds the typical ' + limit +
        ' kVA three-phase SSEG threshold — a formal utility study will be required.';
    }
    return { compliant: compliant, limitKva: limit, exportEnabled: !!exportEnabled, message: msg };
  }

  // ---------------------------------------------------------------------------
  // 5. FINANCIAL MODEL  -------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Full financial projection with tariff escalation.
   * @returns {{capex, annualSavingsY1, simplePaybackYears, escalatedPaybackYears,
   *            roiPct, lifetimeSavings, npv, cashflow[]}}
   */
  function financials(capex, annualSavingsY1, opts) {
    opts = opts || {};
    var esc = opts.escalation != null ? opts.escalation : 0.12; // 12% default
    var years = opts.years || 25;
    var discount = opts.discount != null ? opts.discount : 0.10;
    var degradation = opts.degradation != null ? opts.degradation : 0.005; // 0.5%/yr

    var cashflow = [];
    var cumulative = -capex;
    var lifetime = 0;
    var npv = -capex;
    var escalatedPayback = null;
    var simplePayback = annualSavingsY1 > 0 ? capex / annualSavingsY1 : Infinity;

    for (var y = 1; y <= years; y++) {
      var tariffFactor = Math.pow(1 + esc, y - 1);
      var degradeFactor = Math.pow(1 - degradation, y - 1);
      var yearSaving = annualSavingsY1 * tariffFactor * degradeFactor;
      lifetime += yearSaving;
      var prevCumulative = cumulative;
      cumulative += yearSaving;
      npv += yearSaving / Math.pow(1 + discount, y);
      if (escalatedPayback === null && cumulative >= 0) {
        // linear interpolation within the crossover year
        escalatedPayback = round((y - 1) + (-prevCumulative) / yearSaving, 1);
      }
      cashflow.push({ year: y, saving: round(yearSaving, 0), cumulative: round(cumulative, 0) });
    }

    var roiPct = capex > 0 ? round((lifetime - capex) / capex * 100, 0) : 0;

    return {
      capex: round(capex, 0),
      annualSavingsY1: round(annualSavingsY1, 0),
      simplePaybackYears: simplePayback === Infinity ? null : round(simplePayback, 1),
      escalatedPaybackYears: escalatedPayback,
      roiPct: roiPct,
      lifetimeSavings: round(lifetime, 0),
      npv: round(npv, 0),
      cashflow: cashflow
    };
  }

  // ---------------------------------------------------------------------------
  // 6. TOP-LEVEL SIMULATION  --------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Run the full simulation.
   *
   * @param {object} input
   *   Location/Generation:
   *     psh, pr (0-1), tilt, azimuth
   *   Consumption:
   *     loadType ('residential'|'commercial'),
   *     dailyKwh | monthlyKwh | (monthlyBill + tariff)
   *     peakLoadKw (optional; estimated if omitted)
   *   Sizing targets:
   *     offsetTarget (0-1, default 0.8)
   *     backupHours | loadsheddingStage
   *     backupLoadKw (optional; defaults to peak)
   *   Battery:
   *     dod (default 0.9), rte (default 0.92)
   *   Grid / SSEG:
   *     phase ('single'|'three'), exportEnabled (bool), feedInTariff
   *   Financial:
   *     tariff, escalation, costPerWp, batteryCostPerKwh, inverterCostPerKva,
   *     fixedCost, years, discount
   */
  function simulate(input) {
    input = input || {};

    // --- Generation basis -----------------------------------------------------
    var pr = input.pr != null ? input.pr : 0.78;                 // 75-80% band
    var tilt = input.tilt != null ? input.tilt : 30;
    var azimuth = input.azimuth != null ? input.azimuth : 0;
    var orient = orientationFactor(tilt, azimuth);
    var psh = input.psh != null ? input.psh : 5.2;

    // --- Consumption ----------------------------------------------------------
    var dailyKwh = dailyConsumption(input);
    var loadType = input.loadType === 'commercial' ? 'commercial' : 'residential';
    var loadShapeN = normalise(LOAD_SHAPES[loadType]);
    var solarN = solarShape();
    var maxShare = Math.max.apply(null, loadShapeN);
    var peakLoadKw = input.peakLoadKw != null && input.peakLoadKw > 0
      ? input.peakLoadKw
      : round(dailyKwh * maxShare, 2); // peak hour as a share of daily energy

    // --- PV & inverter sizing -------------------------------------------------
    var offsetTarget = input.offsetTarget != null ? input.offsetTarget : 0.8;
    var pvKwp = sizePv(dailyKwh, offsetTarget, psh, pr, orient);
    var genKwh = dailyGeneration(pvKwp, psh, pr, orient);

    var inverter = sizeInverter(pvKwp, peakLoadKw, {
      dcAcRatio: input.dcAcRatio, powerFactor: input.powerFactor
    });

    // --- Battery sizing (loadshedding) ---------------------------------------
    var backupHours = input.backupHours != null
      ? input.backupHours
      : backupHoursForStage(input.loadsheddingStage || 4);
    var backupLoadKw = input.backupLoadKw != null && input.backupLoadKw > 0
      ? input.backupLoadKw
      : peakLoadKw;
    var dod = input.dod != null ? input.dod : 0.90;
    var rte = input.rte != null ? input.rte : 0.92;
    var battery = sizeBattery(backupLoadKw, backupHours, peakLoadKw, { dod: dod, maxCrate: input.maxCrate });

    // --- Daily energy balance with the sized battery -------------------------
    var allowExport = !!input.exportEnabled;
    var balance = energyBalance(dailyKwh, genKwh, battery.usableKwh, rte, loadShapeN, solarN);

    // --- SSEG / NRS 097 -------------------------------------------------------
    var phase = input.phase === 'three' ? 'three' : 'single';
    var nrs = nrs097Check(inverter.kva, phase, allowExport);

    // --- Financials -----------------------------------------------------------
    var tariff = input.tariff != null ? input.tariff : 3.5;      // R3.50/kWh default
    var feedIn = allowExport ? (input.feedInTariff != null ? input.feedInTariff : 0.9) : 0;
    var costPerWp = input.costPerWp != null ? input.costPerWp : 12;
    var battCostKwh = input.batteryCostPerKwh != null ? input.batteryCostPerKwh : 6500;
    var invCostKva = input.inverterCostPerKva != null ? input.inverterCostPerKva : 3500;
    var fixedCost = input.fixedCost != null ? input.fixedCost : 15000; // BoS, install, SSEG app

    var pvCost = pvKwp * 1000 * costPerWp;
    var battCost = battery.nominalKwh * battCostKwh;
    var invCost = inverter.kva * invCostKva;
    var capex = pvCost + battCost + invCost + fixedCost;

    var selfConsumedKwh = balance.selfConsumed;                  // per day
    var exportedKwh = balance.exported;                          // per day
    var annualSelfSavings = selfConsumedKwh * 365 * tariff;
    var annualExportRevenue = exportedKwh * 365 * feedIn;
    var annualSavingsY1 = annualSelfSavings + annualExportRevenue;

    var fin = financials(capex, annualSavingsY1, {
      escalation: input.escalation, years: input.years,
      discount: input.discount, degradation: input.degradation
    });

    var baselineAnnualCost = dailyKwh * 365 * tariff;

    // --- Assemble result ------------------------------------------------------
    return {
      inputsResolved: {
        dailyKwh: round(dailyKwh, 1), loadType: loadType, psh: psh, pr: pr,
        orient: orient, tilt: tilt, azimuth: azimuth, offsetTarget: offsetTarget,
        backupHours: backupHours, peakLoadKw: peakLoadKw, tariff: tariff,
        feedInTariff: feedIn, phase: phase, exportEnabled: allowExport
      },
      generation: {
        pvKwp: pvKwp,
        panels600: Math.ceil(pvKwp * 1000 / 600),
        dailyGenKwh: round(genKwh, 1),
        annualGenKwh: round(genKwh * 365, 0),
        specificYield: round(psh * pr * orient * 365, 0)
      },
      inverter: { kva: inverter.kva, drivenBy: inverter.drivenBy },
      battery: battery,
      energy: {
        dailyLoadKwh: round(dailyKwh, 1),
        directSolarKwh: round(balance.directSC, 1),
        batteryShiftedKwh: round(balance.batterySC, 1),
        selfConsumedKwh: round(selfConsumedKwh, 1),
        exportedKwh: round(exportedKwh, 1),
        gridImportKwh: round(balance.gridImport, 1),
        selfSufficiencyPct: dailyKwh > 0 ? round(selfConsumedKwh / dailyKwh * 100, 0) : 0,
        solarUtilisationPct: genKwh > 0 ? round((genKwh - balance.exported) / genKwh * 100, 0) : 0
      },
      sseg: nrs,
      financial: {
        capex: fin.capex,
        breakdown: {
          pv: round(pvCost, 0), battery: round(battCost, 0),
          inverter: round(invCost, 0), fixed: round(fixedCost, 0)
        },
        baselineAnnualCost: round(baselineAnnualCost, 0),
        annualSavingsY1: fin.annualSavingsY1,
        annualSelfSavings: round(annualSelfSavings, 0),
        annualExportRevenue: round(annualExportRevenue, 0),
        simplePaybackYears: fin.simplePaybackYears,
        paybackYears: fin.escalatedPaybackYears,
        roiPct: fin.roiPct,
        lifetimeSavings: fin.lifetimeSavings,
        npv: fin.npv,
        cashflow: fin.cashflow
      },
      profiles: { loadShape: loadShapeN, solarShape: solarN, loadType: loadType }
    };
  }

  /**
   * Real hour-by-hour battery/energy balance (referenced by simulate()).
   * Kept separate from simulate() so it can be tested independently.
   */
  function energyBalance(loadKwh, genKwh, battUsableKwh, rte, loadShapeN, solarN) {
    var soc = 0;              // stored energy (pre-efficiency), kWh
    var directSC = 0, batterySC = 0, exported = 0, gridImport = 0;
    for (var h = 0; h < 24; h++) {
      var l = loadKwh * loadShapeN[h];
      var s = genKwh * solarN[h];
      if (s >= l) {
        directSC += l;
        var surplus = s - l;
        var room = battUsableKwh - soc;
        var toBatt = Math.min(surplus, Math.max(0, room));
        soc += toBatt;
        exported += surplus - toBatt;
      } else {
        directSC += s;
        var deficit = l - s;
        var deliverable = soc * rte;
        var fromBatt = Math.min(deficit, deliverable);
        batterySC += fromBatt;
        soc -= fromBatt / rte;
        gridImport += deficit - fromBatt;
      }
    }
    return {
      directSC: directSC, batterySC: batterySC,
      selfConsumed: directSC + batterySC,
      exported: exported, gridImport: gridImport
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities  ----------------------------------------------------------------
  // ---------------------------------------------------------------------------
  function round(n, dp) { var f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }
  function roundUp(n, step) { step = step || 1; return Math.ceil(n / step) * step; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  var API = {
    SA_REGIONS: SA_REGIONS,
    orientationFactor: orientationFactor,
    pvgisUrl: pvgisUrl,
    pshFromAnnualYield: pshFromAnnualYield,
    dailyConsumption: dailyConsumption,
    dailyGeneration: dailyGeneration,
    solarShape: solarShape,
    normalise: normalise,
    LOAD_SHAPES: LOAD_SHAPES,
    sizePv: sizePv,
    sizeBattery: sizeBattery,
    sizeInverter: sizeInverter,
    backupHoursForStage: backupHoursForStage,
    nrs097Check: nrs097Check,
    financials: financials,
    energyBalance: energyBalance,
    simulate: simulate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.SolarSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
