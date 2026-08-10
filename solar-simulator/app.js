/*
 * app.js — UI layer for the Solar System Simulation Tool.
 * Responsibility: read the form, call the pure SolarSim engine, render results.
 * All mathematics lives in simulation.js — this file only handles the DOM.
 */
(function () {
  'use strict';
  var S = window.SolarSim;
  var charts = {};
  var pvgisPsh = null; // effective PSH from a successful PVGIS fetch (if any)

  // ---- small DOM helpers ----------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? e.value : ''; }
  function num(id) { var v = parseFloat(val(id)); return isNaN(v) ? null : v; }
  function fmt(n) { return Math.round(n).toLocaleString('en-ZA'); }
  function fmtR(n) {
    n = Math.round(n);
    if (Math.abs(n) >= 1e6) return 'R ' + (n / 1e6).toFixed(2) + 'm';
    if (Math.abs(n) >= 1e4) return 'R ' + (n / 1e3).toFixed(0) + 'k';
    return 'R ' + n.toLocaleString('en-ZA');
  }

  // ---- toggle button groups -------------------------------------------------
  function setupToggle(groupId, onChange) {
    var group = $(groupId);
    group.querySelectorAll('.toggle').forEach(function (t) {
      t.addEventListener('click', function () {
        group.querySelectorAll('.toggle').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        if (onChange) onChange(t.getAttribute('data-val'));
      });
    });
  }
  function toggleVal(groupId) {
    var on = $(groupId).querySelector('.toggle.on');
    return on ? on.getAttribute('data-val') : null;
  }

  // ---- region dropdown ------------------------------------------------------
  function initRegions() {
    var sel = $('region');
    Object.keys(S.SA_REGIONS).forEach(function (key) {
      var r = S.SA_REGIONS[key];
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = r.name + ' — ' + r.psh + ' h';
      sel.appendChild(opt);
    });
    sel.value = 'johannesburg';
    sel.addEventListener('change', function () {
      var r = S.SA_REGIONS[sel.value];
      $('psh').value = r.psh;
      $('pshVal').textContent = r.psh.toFixed(1) + ' h';
      pvgisPsh = null;
      $('pvgisNote').textContent = 'Region set to ' + r.name + '. Using regional average PSH; press “Fetch live irradiance” for site-specific data.';
    });
  }

  // ---- range label bindings -------------------------------------------------
  function bindRange(id, labelId, suffix, transform) {
    var el = $(id);
    function upd() {
      var v = transform ? transform(parseFloat(el.value)) : el.value;
      $(labelId).textContent = v + suffix;
    }
    el.addEventListener('input', upd); upd();
  }

  // ---- read the whole form into an engine input object ----------------------
  function readInputs() {
    var consMode = toggleVal('consModeToggle');
    var backupMode = toggleVal('backupModeToggle');
    var exportOn = toggleVal('exportToggle') === 'on';
    var input = {
      psh: pvgisPsh != null ? pvgisPsh : num('psh'),
      pr: num('pr') / 100,
      tilt: num('tilt'),
      azimuth: num('azimuth'),
      loadType: toggleVal('loadTypeToggle'),
      offsetTarget: num('offsetTarget') / 100,
      peakLoadKw: num('peakLoadKw'),
      backupLoadKw: num('backupLoadKw'),
      dod: num('dod') / 100,
      phase: toggleVal('phaseToggle'),
      exportEnabled: exportOn,
      feedInTariff: num('feedInTariff'),
      tariff: num('tariff'),
      escalation: num('escalation') / 100,
      costPerWp: num('costPerWp'),
      batteryCostPerKwh: num('batteryCostPerKwh'),
      inverterCostPerKva: num('inverterCostPerKva'),
      fixedCost: num('fixedCost')
    };
    if (consMode === 'bill') input.monthlyBill = num('monthlyBill');
    else input.dailyKwh = num('dailyKwh');
    if (backupMode === 'stage') input.loadsheddingStage = parseInt(val('loadsheddingStage'), 10);
    else input.backupHours = num('backupHours');
    return input;
  }

  // ---- render results -------------------------------------------------------
  function render(r) {
    var f = r.financial, g = r.generation, e = r.energy, b = r.battery;
    var payback = f.paybackYears != null ? f.paybackYears + ' yrs' : '—';

    var segErr = !r.sseg.compliant;
    var ssegAlert = segErr
      ? '<div class="alert alert-danger">⚠️ <strong>NRS 097-2-1:</strong> ' + r.sseg.message + '</div>'
      : '<div class="alert alert-success">✅ <strong>NRS 097-2-1:</strong> ' + r.sseg.message + '</div>';

    var html = '';

    // --- Hero KPI outputs (the required deliverables) ---
    html += '<div class="kpi-grid">' +
      kpi('PV Array', g.pvKwp, 'kWp', 'gold', true) +
      kpi('Inverter', r.inverter.kva, 'kVA', 'blue') +
      kpi('Battery', b.nominalKwh, 'kWh', 'green') +
      kpi('Payback', payback, '', 'gold') +
      kpi('ROI (25 yr)', f.roiPct + '%', '', 'green') +
      '</div>';

    html += ssegAlert;

    // --- Generation & sizing detail ---
    html += '<div class="card"><div class="card-title">☀️ Generation &amp; Sizing</div>' +
      row('Recommended PV array', g.pvKwp + ' kWp  (' + g.panels600 + ' × 600 Wp panels)') +
      row('Effective PSH used', r.inputsResolved.psh.toFixed(2) + ' h/day' + (pvgisPsh != null ? '  (PVGIS live)' : '  (regional)')) +
      row('Orientation factor', (r.inputsResolved.orient * 100).toFixed(0) + '%  (tilt ' + r.inputsResolved.tilt + '°, ' + Math.abs(r.inputsResolved.azimuth) + '° off-N)') +
      row('Performance Ratio', (r.inputsResolved.pr * 100).toFixed(0) + '%') +
      row('Daily / annual generation', g.dailyGenKwh + ' kWh  /  ' + fmt(g.annualGenKwh) + ' kWh') +
      row('Specific yield', fmt(g.specificYield) + ' kWh/kWp/yr') +
      row('Inverter driven by', r.inverter.drivenBy === 'peak-load' ? 'building peak load' : 'PV array size') +
      '</div>';

    // --- Battery detail ---
    html += '<div class="card"><div class="card-title">🔋 Battery (LiFePO4)</div>' +
      row('Nominal capacity', b.nominalKwh + ' kWh') +
      row('Usable capacity', b.usableKwh + ' kWh  (' + (r.inputsResolved ? Math.round((b.usableKwh / b.nominalKwh) * 100) : 90) + '% DoD)') +
      row('Continuous discharge', b.dischargeKw + ' kW') +
      row('Backup target', r.inputsResolved.backupHours + ' h  @ ' + (r.inputsResolved.peakLoadKw) + ' kW peak') +
      row('Sizing driven by', b.drivenBy === 'peak-power' ? 'peak power (C-rate)' : 'backup energy') +
      '</div>';

    // --- Energy balance ---
    html += '<div class="card"><div class="card-title">⚡ Daily Energy Balance</div>' +
      energyBar(e) +
      row('Daily load', e.dailyLoadKwh + ' kWh') +
      row('Direct solar use', e.directSolarKwh + ' kWh') +
      row('Battery time-shift', e.batteryShiftedKwh + ' kWh') +
      row('Exported to grid', e.exportedKwh + ' kWh' + (r.inputsResolved.exportEnabled ? '' : ' (export OFF — curtailed)')) +
      row('Grid import (remaining)', e.gridImportKwh + ' kWh') +
      row('Self-sufficiency', e.selfSufficiencyPct + '%') +
      '</div>';

    // --- Financial ---
    html += '<div class="card"><div class="card-title">💰 Financial Model</div>' +
      row('Total investment (capex)', fmtR(f.capex)) +
      row('  · PV', fmtR(f.breakdown.pv)) +
      row('  · Battery', fmtR(f.breakdown.battery)) +
      row('  · Inverter', fmtR(f.breakdown.inverter)) +
      row('  · Fixed / install / SSEG', fmtR(f.breakdown.fixed)) +
      row('Baseline annual grid cost', fmtR(f.baselineAnnualCost)) +
      row('Year-1 savings', fmtR(f.annualSavingsY1) + (f.annualExportRevenue > 0 ? '  (incl. ' + fmtR(f.annualExportRevenue) + ' export)' : '')) +
      row('Simple payback', f.simplePaybackYears != null ? f.simplePaybackYears + ' yrs' : '—') +
      row('Payback (with escalation)', payback) +
      row('25-yr lifetime savings', fmtR(f.lifetimeSavings)) +
      row('Net present value (NPV)', fmtR(f.npv)) +
      row('Return on investment', f.roiPct + '%') +
      '<canvas id="cashflowChart" height="150" style="margin-top:14px"></canvas>' +
      '</div>';

    // --- Profile chart ---
    html += '<div class="card"><div class="card-title">📈 Load vs Solar (24h shape)</div>' +
      '<canvas id="profileChart" height="150"></canvas>' +
      '<div class="footnote">Normalised typical-day shapes for a <strong>' + r.profiles.loadType + '</strong> load against the modelled solar curve.</div>' +
      '</div>';

    $('resultsBody').innerHTML = html;
    drawCashflow(f.cashflow);
    drawProfile(r);
  }

  function kpi(lbl, value, unit, color, hero) {
    return '<div class="kpi' + (hero ? ' hero' : '') + '">' +
      '<div class="kpi-lbl">' + lbl + '</div>' +
      '<div class="kpi-val ' + color + '">' + value + '</div>' +
      '<div class="kpi-unit">' + unit + '</div></div>';
  }
  function row(k, v) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }
  function energyBar(e) {
    var total = e.directSolarKwh + e.batteryShiftedKwh + e.gridImportKwh;
    if (total <= 0) return '';
    function pct(x) { return (x / total * 100).toFixed(1) + '%'; }
    return '<div class="bar-wrap"><div class="bar-track">' +
      '<div class="bar-seg" style="width:' + pct(e.directSolarKwh) + ';background:#f0a500"></div>' +
      '<div class="bar-seg" style="width:' + pct(e.batteryShiftedKwh) + ';background:#00c853"></div>' +
      '<div class="bar-seg" style="width:' + pct(e.gridImportKwh) + ';background:#ff4444"></div>' +
      '</div><div class="legend">' +
      '<span><span class="dot" style="background:#f0a500"></span>Direct solar</span>' +
      '<span><span class="dot" style="background:#00c853"></span>Battery</span>' +
      '<span><span class="dot" style="background:#ff4444"></span>Grid import</span>' +
      '</div></div>';
  }

  // ---- charts ---------------------------------------------------------------
  function drawCashflow(cashflow) {
    var ctx = $('cashflowChart'); if (!ctx || !window.Chart) return;
    if (charts.cf) charts.cf.destroy();
    charts.cf = new Chart(ctx, {
      type: 'line',
      data: {
        labels: cashflow.map(function (c) { return 'Yr ' + c.year; }),
        datasets: [{
          label: 'Cumulative net (R)',
          data: cashflow.map(function (c) { return c.cumulative; }),
          borderColor: '#00c853', backgroundColor: 'rgba(0,200,83,0.08)',
          fill: true, tension: 0.3, pointRadius: 0
        }]
      },
      options: chartOpts(function (v) { return fmtR(v); })
    });
  }
  function drawProfile(r) {
    var ctx = $('profileChart'); if (!ctx || !window.Chart) return;
    if (charts.pf) charts.pf.destroy();
    var labels = []; for (var h = 0; h < 24; h++) labels.push(h + 'h');
    var load = r.profiles.loadShape.map(function (v) { return +(v * r.energy.dailyLoadKwh).toFixed(2); });
    var solar = r.profiles.solarShape.map(function (v) { return +(v * r.generation.dailyGenKwh).toFixed(2); });
    charts.pf = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Load (kWh)', data: load, borderColor: '#4db8ff', backgroundColor: 'rgba(30,144,255,0.08)', fill: true, tension: 0.4, pointRadius: 0 },
          { label: 'Solar (kWh)', data: solar, borderColor: '#f0a500', backgroundColor: 'rgba(240,165,0,0.10)', fill: true, tension: 0.4, pointRadius: 0 }
        ]
      },
      options: chartOpts()
    });
  }
  function chartOpts(yFmt) {
    return {
      responsive: true,
      plugins: { legend: { labels: { color: '#8fa8c8', font: { size: 11 } } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8fa8c8', maxTicksLimit: 12 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8fa8c8', callback: yFmt ? function (v) { return yFmt(v); } : undefined } }
      }
    };
  }

  // ---- PVGIS live fetch (best-effort, graceful fallback) --------------------
  function fetchPvgis() {
    var region = S.SA_REGIONS[val('region')];
    var note = $('pvgisNote');
    var tilt = num('tilt'), azimuth = num('azimuth'), pr = num('pr') / 100;
    var orient = S.orientationFactor(tilt, azimuth);
    note.textContent = 'Contacting PVGIS for ' + region.name + '…';
    var url = S.pvgisUrl(region.lat, region.lon, tilt, azimuth);
    fetch(url)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        var eY = data && data.outputs && data.outputs.totals && data.outputs.totals.fixed &&
          data.outputs.totals.fixed.E_y;
        if (!eY) throw new Error('unexpected response');
        pvgisPsh = S.pshFromAnnualYield(eY, pr, orient);
        $('psh').value = pvgisPsh.toFixed(1);
        $('pshVal').textContent = pvgisPsh.toFixed(1) + ' h';
        note.textContent = '✅ PVGIS: ' + fmt(eY) + ' kWh/kWp/yr → effective ' + pvgisPsh.toFixed(2) +
          ' PSH at this tilt/azimuth. (Re-run the simulation.)';
      })
      .catch(function (err) {
        pvgisPsh = null;
        $('psh').value = region.psh;
        $('pshVal').textContent = region.psh.toFixed(1) + ' h';
        note.textContent = '⚠️ PVGIS unavailable (' + err.message + '). Using regional average ' +
          region.psh + ' PSH for ' + region.name + '.';
      });
  }

  // ---- wire everything up ---------------------------------------------------
  function init() {
    initRegions();
    bindRange('psh', 'pshVal', ' h', function (v) { pvgisPsh = null; return v.toFixed(1); });
    bindRange('tilt', 'tiltVal', '°');
    bindRange('azimuth', 'azVal', '°');
    bindRange('pr', 'prVal', '%');
    bindRange('backupHours', 'bhVal', ' h', function (v) { return v.toFixed(1); });
    bindRange('dod', 'dodVal', '%');
    bindRange('offsetTarget', 'offVal', '%');

    setupToggle('loadTypeToggle', function (v) {
      $('loadTypeNote').textContent = v === 'commercial'
        ? 'Commercial: heavy 08:00–17:00 daytime demand, aligned with the solar curve.'
        : 'Residential: morning geyser + evening cooking peaks.';
    });
    setupToggle('consModeToggle', function (v) {
      $('kwhField').style.display = v === 'kwh' ? '' : 'none';
      $('billField').style.display = v === 'bill' ? '' : 'none';
    });
    setupToggle('backupModeToggle', function (v) {
      $('hoursField').style.display = v === 'hours' ? '' : 'none';
      $('stageField').style.display = v === 'stage' ? '' : 'none';
    });
    setupToggle('phaseToggle');
    setupToggle('exportToggle', function (v) {
      $('feedInField').style.display = v === 'on' ? '' : 'none';
    });

    $('pvgisBtn').addEventListener('click', fetchPvgis);
    $('runBtn').addEventListener('click', function () {
      var input = readInputs();
      if (!S.dailyConsumption(input)) {
        alert('Please enter a daily kWh or a monthly bill (with a tariff) first.');
        return;
      }
      render(S.simulate(input));
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
