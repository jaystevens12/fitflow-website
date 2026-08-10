/*
 * simulation.test.mjs — sanity tests for the pure simulation engine.
 * Run with:  node solar-simulator/simulation.test.mjs
 * No test framework required.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('./simulation.js');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.01 : tol); }

console.log('\nLocation / orientation');
assert('orientation factor is 1.0 at optimal N/30°', approx(S.orientationFactor(30, 0), 1, 0.001));
assert('orientation penalised when facing east (90°)', S.orientationFactor(30, 90) < 0.85);
assert('orientation penalised when flat (0° tilt)', S.orientationFactor(0, 0) < 1);
assert('11 SA regions present', Object.keys(S.SA_REGIONS).length === 11);
assert('Upington PSH is highest (5.5)', S.SA_REGIONS.upington.psh === 5.5);
assert('Durban PSH is lowest listed (4.2)', S.SA_REGIONS.durban.psh === 4.2);

console.log('\nConsumption derivation');
assert('daily from monthly bill (R3500 @ R3.50 ≈ 32.9 kWh/day)',
  approx(S.dailyConsumption({ monthlyBill: 3500, tariff: 3.5 }), 32.89, 0.1));
assert('direct daily kWh passthrough', S.dailyConsumption({ dailyKwh: 40 }) === 40);

console.log('\nGeneration');
assert('daily gen = kWp·PSH·PR·orient', approx(S.dailyGeneration(5, 5.2, 0.78, 1), 20.28, 0.01));
assert('solar shape sums to 1', approx(S.solarShape().reduce((a, b) => a + b, 0), 1, 1e-9));
assert('no solar generated at midnight', S.solarShape()[0] === 0);

console.log('\nSizing');
const pv = S.sizePv(40, 0.8, 5.2, 0.78, 1);
assert('PV sizing offsets ~80% of load', pv >= 7.5 && pv <= 8.5, 'got ' + pv);

const batt = S.sizeBattery(3, 3, 3, { dod: 0.9 });
assert('battery usable = load·hours (3kW·3h = 9kWh)', approx(batt.usableKwh, 9, 0.5), JSON.stringify(batt));
assert('battery nominal accounts for 90% DoD (≥10kWh)', batt.nominalKwh >= 10);

const battPeak = S.sizeBattery(1, 2, 8, { dod: 0.9, maxCrate: 0.5 });
assert('battery upsized when peak power dominates', battPeak.drivenBy === 'peak-power', battPeak.drivenBy);

const inv = S.sizeInverter(8, 5, {});
assert('inverter sized ≥ PV/1.15 and ≥ peak/pf', inv.kva >= 6.9, JSON.stringify(inv));

console.log('\nNRS 097-2-1');
assert('5 kVA single-phase FAILS 4.6 kVA limit', S.nrs097Check(5, 'single', true).compliant === false);
assert('4.6 kVA single-phase PASSES', S.nrs097Check(4.6, 'single', true).compliant === true);
assert('10 kVA three-phase PASSES', S.nrs097Check(10, 'three', true).compliant === true);

console.log('\nEnergy balance');
const shapes = S.normalise(S.LOAD_SHAPES.commercial);
const solar = S.solarShape();
const eb = S.energyBalance(40, 40, 10, 0.92, shapes, solar);
assert('self-consumed ≤ load', eb.selfConsumed <= 40 + 1e-6);
assert('commercial self-consumes a large share directly', eb.directSC > 15, 'directSC=' + eb.directSC);
assert('energy conserved (self + grid ≈ load)', approx(eb.selfConsumed + eb.gridImport, 40, 0.5));

console.log('\nFinancials');
const fin = S.financials(100000, 20000, { escalation: 0.12, years: 25 });
assert('simple payback = capex/annual (5.0 yr)', approx(fin.simplePaybackYears, 5.0, 0.1));
assert('escalated payback faster than simple', fin.escalatedPaybackYears < fin.simplePaybackYears);
assert('ROI positive over 25 yr', fin.roiPct > 0);
assert('cashflow has 25 entries', fin.cashflow.length === 25);

console.log('\nEnd-to-end simulate()');
const r = S.simulate({
  psh: 5.2, pr: 0.78, tilt: 30, azimuth: 0,
  loadType: 'residential', dailyKwh: 30,
  offsetTarget: 0.8, backupHours: 3, phase: 'single',
  exportEnabled: true, tariff: 3.5, escalation: 0.12
});
assert('returns PV kWp > 0', r.generation.pvKwp > 0);
assert('returns inverter kVA > 0', r.inverter.kva > 0);
assert('returns battery kWh > 0', r.battery.nominalKwh > 0);
assert('returns a payback figure', r.financial.paybackYears !== null);
assert('returns an ROI figure', typeof r.financial.roiPct === 'number');
assert('flags NRS non-compliance if single-phase inverter > 4.6',
  r.inverter.kva > 4.6 ? r.sseg.compliant === false : true);
assert('self-sufficiency between 0 and 100%',
  r.energy.selfSufficiencyPct >= 0 && r.energy.selfSufficiencyPct <= 100);

console.log('\n' + (failed === 0 ? '✅ ALL ' + passed + ' TESTS PASSED' : '❌ ' + failed + ' FAILED, ' + passed + ' passed') + '\n');
process.exit(failed === 0 ? 0 : 1);
