// test.js — Pompa Piscina test suite
// Eseguire con: node test.js
// Creare .env (gitignored) con PLUS_2PM_IP, POOL_LAT, POOL_LON — vedi .env.example

'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

// Carica .env se esiste (nessuna dipendenza esterna)
(function loadDotEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const sep = line.indexOf('=');
      if (sep > 0) process.env[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
  } catch (_) {}
}());

const PLUS_IP  = process.env.PLUS_2PM_IP || '127.0.0.1';
const POOL_LAT = process.env.POOL_LAT    || '0';
const POOL_LON = process.env.POOL_LON    || '0';

// ─── MINI FRAMEWORK ──────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const G = '\x1b[32m', R = '\x1b[31m', B = '\x1b[1m', X = '\x1b[0m';

function test(name, fn) {
  try   { fn(); console.log(G + '  PASS' + X + '  ' + name); passed++; }
  catch (e) { console.log(R + '  FAIL' + X + '  ' + name + '\n        ' + e.message); failed++; }
}
function ok(c, msg)    { if (!c) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function has(arr, s)   { if (!arr.some(p => String(p).indexOf(s) >= 0)) throw new Error('"' + s + '" not found in output'); }
function hasnt(arr, s) { if ( arr.some(p => String(p).indexOf(s) >= 0)) throw new Error('"' + s + '" unexpectedly found in output'); }

// ─── SIMULATION FACTORY ──────────────────────────────────────────────────────

const SOURCE = fs.readFileSync(path.join(__dirname, 'pompa_piscina.js'), 'utf8');
// Expose let-scoped STATE/CONFIG to the context after script runs
const SCRIPT = SOURCE + '\ntry{__STATE=STATE;__CONFIG=CONFIG;}catch(e){}';

// 2025-05-01 10:00:00 UTC — ora 10 UTC / 12 UTC+2
const BASE_UNIXTIME = 1746093600;

const WEATHER_BODY = JSON.stringify({
  current: { temperature_2m: 22, relative_humidity_2m: 60, wind_speed_10m: 10 },
  daily:   { temperature_2m_max: [25, 26], wind_speed_10m_max: [12, 14] },
});

function createSim(opts) {
  opts = Object.assign({
    kv:        {},       // chiavi KV precaricate
    tempC:     29,       // temperatura diretta dal sensore (°C)
    tempCSeq:  null,     // sequenza di temperature (null = errore per quel tentativo)
    tempError: false,    // true = HTTP errore su tutti i tentativi
    internetOk: true,    // false = Open-Meteo non raggiungibile
    unixtime:  BASE_UNIXTIME,
    uptime:    200,
    sw1:       false,
    pumpMode:  'AUTO',
    verbose:   false,
  }, opts);

  // pt_lat/pt_lon sempre presenti (richiesti da fetchAmbientTemp); sovrascrivibili via opts.kv
  const kv = Object.assign({ 'pt_lat': POOL_LAT, 'pt_lon': POOL_LON }, opts.kv);
  const prints      = [];
  const switchCalls = [];
  const textCalls   = [];
  const kvSets      = [];
  const timers      = [];
  let   timerSeq    = 0;
  let   tempIdx     = 0;

  const Timer = {
    set:   (ms, repeat, fn) => { const id = ++timerSeq; timers.push({ id, repeat, fn }); return id; },
    clear: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };

  const Shelly = {
    call: (method, params, cb) => {
      if (method === 'KVS.Get') {
        const v = kv[params.key];
        v !== undefined ? cb({ value: v }, null) : cb(null, 'not_found');

      } else if (method === 'KVS.Set') {
        kv[params.key] = params.value;
        kvSets.push({ key: params.key, value: params.value });
        if (cb) cb({}, null);

      } else if (method === 'HTTP.GET') {
        if (params.url.indexOf('open-meteo.com') >= 0) {
          if (opts.internetOk) cb({ code: 200, body: WEATHER_BODY }, null);
          else if (cb) cb(null, 'network error');

        } else if (params.url.indexOf('Temperature.GetStatus') >= 0) {
          if (opts.tempError) { if (cb) cb(null, 'connection refused'); return; }
          const seq = opts.tempCSeq;
          const v   = seq ? seq[tempIdx++ % seq.length] : opts.tempC;
          if (v === null) { if (cb) cb(null, 'timeout'); return; }
          if (cb) cb({ code: 200, body: JSON.stringify({ tC: v }) }, null);

        } else { if (cb) cb(null, 'unknown'); }

      } else if (method === 'Switch.Set') {
        switchCalls.push({ on: params.on });
        if (cb) cb({}, null);

      } else if (method === 'Text.Set') {
        textCalls.push({ id: params.id, value: params.value });
        if (cb) cb({}, null);
      }
    },
    getComponentStatus: (comp) => {
      if (comp === 'sys')          return { unixtime: opts.unixtime, uptime: opts.uptime };
      if (comp === 'input:0')      return { state: opts.sw1 };
      if (comp.startsWith('enum:'))return { value: opts.pumpMode };
      return null;
    },
    addStatusHandler: () => {},
  };

  const print = (msg) => { prints.push(String(msg)); if (opts.verbose) console.log('    LOG:', msg); };

  const ctx = vm.createContext({
    Shelly, Timer, print,
    Math, Date, JSON, parseInt, parseFloat, isNaN,
    __STATE: null, __CONFIG: null,
  });

  vm.runInContext(SCRIPT, ctx);

  // Esegui tutti i timer one-shot pendenti (retry fetchTemperature, ecc.)
  function fireOneShots() {
    let fired;
    do {
      fired = false;
      for (let i = timers.length - 1; i >= 0; i--) {
        if (!timers[i].repeat) {
          const fn = timers.splice(i, 1)[0].fn;
          fn();
          fired = true;
        }
      }
    } while (fired);
  }
  fireOneShots();

  return {
    STATE:   ctx.__STATE,
    CONFIG:  ctx.__CONFIG,
    prints,  switchCalls, textCalls, kvSets, kv, timers,
    // funzioni direttamente accessibili (dichiarazioni function)
    getModeFromTemp:         (t)    => ctx.getModeFromTemp(t),
    shouldPumpRunBySchedule: (h, t) => ctx.shouldPumpRunBySchedule(h, t),
    evaluatePump:            ()     => ctx.evaluatePump(),
    checkDateChange:         ()     => ctx.checkDateChange(),
    fetchTemperature:        ()     => ctx.fetchTemperature(),
    getEffectiveTemp:        ()     => ctx.getEffectiveTemp(),
    fireOneShots,
  };
}

// ─── AVVIO ───────────────────────────────────────────────────────────────────
console.log(B + '\nAvvio\n' + X);

test('Tutti i KV presenti e recenti: caricati senza bootstrap', () => {
  const now = Math.floor(Date.now() / 1000);
  const sim = createSim({ kv: {
    'pt_ip':   PLUS_IP,
    'pt_cal':  '0.5',
    'pt_mode': 'A9:' + (now - 3600),
  }});
  eq(sim.STATE.plusDeviceIP,      PLUS_IP, 'IP');
  ok(Math.abs(sim.STATE.calibOffset - 0.5) < 0.01,  'calibOffset');
  eq(sim.STATE.activeScheduleMode, 'A9',             'modo da KV');
  hasnt(sim.prints, 'Bootstrap temp:', 'nessun bootstrap');
  ok(sim.STATE.ready, 'ready = true');
});

test('Nessun KV: IP null, bootstrap tenta senza IP e non legge temp', () => {
  const sim = createSim({ kv: {} });
  ok(sim.STATE.plusDeviceIP === null,        'IP null');
  ok(sim.STATE.activeScheduleMode === null,  'modo null');
  has(sim.prints,   'pt_ip',                         'avviso IP mancante');
  has(sim.prints,   'Bootstrap temp: nessuna lettura','bootstrap senza letture');
});

test('Solo pt_ip: bootstrap legge temp e imposta il modo', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  ok(sim.STATE.lastTemp !== null,            'lastTemp letto');
  ok(sim.STATE.activeScheduleMode !== null,  'modo impostato');
  has(sim.prints, 'Bootstrap mode:',                 'log modo bootstrap');
});

test('pt_mode scaduto (>24h): ignorato, bootstrap rieseguito', () => {
  const sim = createSim({ kv: {
    'pt_ip':   PLUS_IP,
    'pt_mode': 'A1:1000000',
  }});
  has(sim.prints, 'scaduto',   'log scaduto');
  has(sim.prints, 'Bootstrap', 'bootstrap eseguito');
  ok(sim.STATE.activeScheduleMode !== 'A1', 'modo stale non usato');
});

test('pt_mode recente senza pt_ip: modo caricato, IP null', () => {
  const now = Math.floor(Date.now() / 1000);
  const sim = createSim({ kv: { 'pt_mode': 'A6:' + (now - 1800) }});
  eq(sim.STATE.plusDeviceIP,       null,  'IP null');
  eq(sim.STATE.activeScheduleMode, 'A6', 'modo caricato');
  hasnt(sim.prints, 'Bootstrap temp:', 'nessun bootstrap');
});

test('Solo pt_cal (no ip, no mode): calibrazione caricata, fallback completo', () => {
  const sim = createSim({ kv: { 'pt_cal': '1.2' }, internetOk: false });
  ok(Math.abs(sim.STATE.calibOffset - 1.2) < 0.01, 'calibOffset');
  ok(sim.STATE.plusDeviceIP === null,               'IP null');
});

test('3 timer ricorrenti registrati (temp, pump, meteo)', () => {
  const sim = createSim({ kv: {} });
  const recurring = sim.timers.filter(t => t.repeat);
  ok(recurring.length >= 3, 'almeno 3 timer ricorrenti, trovati: ' + recurring.length);
});

// ─── SENSORE TEMPERATURA ─────────────────────────────────────────────────────
console.log(B + '\nSensore temperatura\n' + X);

test('IP non raggiungibile: tutte le letture falliscono, lastTemp null', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }, tempError: true });
  ok(sim.STATE.lastTemp === null,           'lastTemp null');
  has(sim.prints, 'Bootstrap temp: nessuna lettura', 'log nessuna lettura');
});

test('Lettura sensore: prima risposta valida salvata in lastTemp', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }, tempC: 29 });
  ok(sim.STATE.lastTemp !== null,  'lastTemp presente');
  eq(sim.STATE.lastTemp, 29,       'valore corretto');
  has(sim.prints, 'Temp HTTP:',    'log temperatura');
});

test('Retry: dopo errori transitori raggiunge lettura valida', () => {
  // 3 errori (null), poi successo al 4° tentativo
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }, tempCSeq: [null, null, null, 27] });
  ok(sim.STATE.lastTemp !== null, 'lastTemp presente dopo retry');
  eq(sim.STATE.lastTemp, 27,      'valore corretto');
  has(sim.prints, 'tentativo 4',  'quarto tentativo riuscito');
});

test('readingInProgress: fetchTemperature skippato mentre in corso', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  const before = sim.prints.filter(p => p.startsWith('Temp:')).length;
  sim.STATE.readingInProgress = true;
  sim.fetchTemperature();
  sim.fireOneShots();
  const after = sim.prints.filter(p => p.startsWith('Temp:')).length;
  eq(after, before, 'nessuna nuova lettura avviata');
});

// ─── RETE INTERNET ────────────────────────────────────────────────────────────
console.log(B + '\nRete internet\n' + X);

test('Internet non disponibile: ambientTemp e forecast null', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  ok(sim.STATE.ambientTemp === null,         'ambientTemp null');
  ok(sim.STATE.todayForecastTempMax === null,'forecast null');
  has(sim.prints, 'Meteo: errore', 'log errore meteo');
});

test('Internet non disponibile e no sensore: getEffectiveTemp = 15 (sicurezza)', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  const t = sim.getEffectiveTemp();
  eq(t, 15, 'fallback sicurezza');
  has(sim.prints, 'sicurezza 15', 'log fallback sicurezza');
});

test('Internet non disponibile ma sensore ok: getEffectiveTemp usa lastTemp', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }, internetOk: false });
  ok(sim.STATE.lastTemp !== null, 'lastTemp presente');
  eq(sim.getEffectiveTemp(), sim.STATE.lastTemp, 'usa lastTemp');
});

test('Internet ok: ambientTemp e forecast aggiornati', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  ok(sim.STATE.ambientTemp !== null,         'ambientTemp presente');
  ok(sim.STATE.todayForecastTempMax !== null,'forecast presente');
  eq(sim.STATE.ambientTempRaw, 22,           'temperatura aria = 22');
});

// ─── CATENA FALLBACK TEMPERATURA ─────────────────────────────────────────────
console.log(B + '\nFallback temperatura\n' + X);

test('lastTemp recente: getEffectiveTemp restituisce lastTemp senza log', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  const expected = sim.STATE.lastTemp;
  ok(expected !== null, 'prerequisito: lastTemp presente');
  const printsBefore = sim.prints.length;
  const t = sim.getEffectiveTemp();
  eq(t, expected, 'valore corretto');
  eq(sim.prints.length, printsBefore, 'nessun log fallback');
});

test('lastTemp null, todayCurrentTemp presente: usa currentTemp', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  sim.STATE.lastTemp         = null;
  sim.STATE.todayCurrentTemp = 24.5;
  const t = sim.getEffectiveTemp();
  eq(t, 24.5, 'usa currentTemp');
  has(sim.prints, 'fallback: corrente', 'log fallback corrente');
});

test('lastTemp e currentTemp null, todayMaxTemp presente: usa maxTemp', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  sim.STATE.lastTemp         = null;
  sim.STATE.todayCurrentTemp = null;
  sim.STATE.todayMaxTemp     = 27.0;
  const t = sim.getEffectiveTemp();
  eq(t, 27.0, 'usa maxTemp');
  has(sim.prints, 'fallback: massimo', 'log fallback massimo');
});

test('Tutto null, meteo disponibile: getEffectiveTemp usa stima', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  sim.STATE.lastTemp         = null;
  sim.STATE.todayCurrentTemp = null;
  sim.STATE.todayMaxTemp     = null;
  const t = sim.getEffectiveTemp();
  ok(t !== null && t !== 15, 'usa stima meteo (non 15)');
  has(sim.prints, 'fallback: stima meteo', 'log fallback stima');
});

// ─── LOGICA POMPA ─────────────────────────────────────────────────────────────
console.log(B + '\nLogica pompa\n' + X);

test('SW1 attivo: pompa ON indipendentemente da modo e orario', () => {
  const sim = createSim({ kv: {}, pumpMode: 'OFF' });
  sim.STATE.hwActive = true;
  sim.STATE.pumpOn   = false;
  sim.evaluatePump();
  ok(sim.STATE.pumpOn === true, 'pompa ON con SW1');
  has(sim.prints, 'hardware SW1', 'sorgente: hardware SW1');
});

test('Modo ON: pompa accesa indipendentemente da orario', () => {
  const sim = createSim({ kv: {}, pumpMode: 'ON' });
  ok(sim.STATE.pumpOn === true, 'pompa ON in modo ON');
});

test('Modo OFF: pompa spenta indipendentemente da orario', () => {
  const sim = createSim({ kv: {}, pumpMode: 'OFF' });
  ok(sim.STATE.pumpOn === false, 'pompa OFF in modo OFF');
});

test('SW1 prioritario su modo OFF: pompa ON', () => {
  const sim = createSim({ kv: {}, pumpMode: 'OFF' });
  sim.STATE.hwActive = true;
  sim.STATE.pumpOn   = false;
  sim.evaluatePump();
  ok(sim.STATE.pumpOn === true, 'SW1 supera modo OFF');
});

test('Ready=false: evaluatePump termina senza agire', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.ready  = false;
  sim.STATE.pumpOn = false;
  const before = sim.switchCalls.length;
  sim.evaluatePump();
  eq(sim.switchCalls.length, before, 'nessuna chiamata Switch.Set');
  has(sim.prints, 'Avvio in corso', 'log attesa KV');
});

// ─── ANTIGELO ─────────────────────────────────────────────────────────────────
console.log(B + '\nAntigelo\n' + X);

test('Temperatura sotto soglia (1.5C): antigelo attivato, pompa ON', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  sim.STATE.lastTemp         = 1.5;
  sim.STATE.lastTempTime     = Date.now();
  sim.STATE.pumpOn           = false;
  sim.STATE.antifreezeActive = false;
  sim.evaluatePump();
  ok(sim.STATE.antifreezeActive,  'antifreezeActive = true');
  ok(sim.STATE.pumpOn === true,   'pompa ON');
  has(sim.prints, 'ANTIGELO',     'log antigelo');
});

test('Temperatura sopra soglia: antigelo non attivato', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  sim.STATE.lastTemp         = 10.0;
  sim.STATE.lastTempTime     = Date.now();
  sim.STATE.antifreezeActive = false;
  sim.evaluatePump();
  ok(!sim.STATE.antifreezeActive, 'antigelo non attivo');
});

// ─── FASCE ORARIE ─────────────────────────────────────────────────────────────
console.log(B + '\nFasce orarie\n' + X);

test('getModeFromTemp: soglie corrette', () => {
  const sim = createSim({ kv: {} });
  const cases = [
    [10, 'A1'], [14.9, 'A1'], [15, 'A3'], [20, 'A3'], [20.1, 'A6'],
    [25, 'A6'], [25.1, 'A9'], [30, 'A9'], [30.1, 'A13'], [35, 'A13'],
  ];
  cases.forEach(([t, expected]) =>
    eq(sim.getModeFromTemp(t), expected, 'T=' + t)
  );
});

test('A1 (13-14): acceso solo ora 13', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = 'A1';
  [12, 14, 22, 7].forEach(h => ok(!sim.shouldPumpRunBySchedule(h, 10), 'A1 h=' + h + ' OFF'));
  ok(sim.shouldPumpRunBySchedule(13, 10), 'A1 h=13 ON');
});

test('A3 (9-10, 12-13, 15-16): fasce corrette', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = 'A3';
  [8, 10, 11, 13, 14, 16].forEach(h => ok(!sim.shouldPumpRunBySchedule(h, 18), 'A3 h=' + h + ' OFF'));
  [9, 12, 15].forEach(h =>  ok( sim.shouldPumpRunBySchedule(h, 18), 'A3 h=' + h + ' ON'));
});

test('A6 (8-9, 11-15, 16-17): fasce corrette', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = 'A6';
  [7, 9, 10, 15, 17].forEach(h => ok(!sim.shouldPumpRunBySchedule(h, 23), 'A6 h=' + h + ' OFF'));
  [8, 11, 14, 16].forEach(h =>  ok( sim.shouldPumpRunBySchedule(h, 23), 'A6 h=' + h + ' ON'));
});

test('A9 (8-10, 12-19): fasce corrette', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = 'A9';
  [7, 10, 11, 19].forEach(h => ok(!sim.shouldPumpRunBySchedule(h, 28), 'A9 h=' + h + ' OFF'));
  [8, 9, 12, 17, 18].forEach(h => ok( sim.shouldPumpRunBySchedule(h, 28), 'A9 h=' + h + ' ON'));
});

test('A13 (8-21 continuo): fasce corrette', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = 'A13';
  [7, 21, 23, 0].forEach(h => ok(!sim.shouldPumpRunBySchedule(h, 35), 'A13 h=' + h + ' OFF'));
  [8, 12, 20].forEach(h =>  ok( sim.shouldPumpRunBySchedule(h, 35), 'A13 h=' + h + ' ON'));
});

test('activeScheduleMode null: fallback a getModeFromTemp(temp)', () => {
  const sim = createSim({ kv: {} });
  sim.STATE.activeScheduleMode = null;
  // A6 (21-25°C): ora 11 = ON, ora 10 = OFF
  ok( sim.shouldPumpRunBySchedule(11, 23), 'fallback A6 h=11 ON');
  ok(!sim.shouldPumpRunBySchedule(10, 23), 'fallback A6 h=10 OFF');
});

// ─── CAMBIO GIORNO ────────────────────────────────────────────────────────────
console.log(B + '\nCambio giorno\n' + X);

test('Media giornaliera 28C: modo A9 salvato su KV, accumulatori azzerati', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  sim.STATE.dailyTempSum   = 28 * 10;
  sim.STATE.dailyTempCount = 10;
  sim.STATE.todayMaxTemp   = 29;
  sim.STATE.todayDay       = -1;  // forza cambio giorno
  sim.STATE.todayMonth     = -1;
  sim.checkDateChange();
  ok(sim.kv['pt_mode'] && sim.kv['pt_mode'].startsWith('A9'), 'pt_mode=A9');
  eq(sim.STATE.dailyTempSum,   0,    'dailyTempSum azzerato');
  eq(sim.STATE.dailyTempCount, 0,    'dailyTempCount azzerato');
  ok(sim.STATE.todayMaxTemp === null, 'todayMaxTemp null');
  ok(sim.STATE.hourBuf.length === 0,  'hourBuf azzerato');
  has(sim.prints, 'A9', 'log modo A9');
});

test('Nessuna lettura giornaliera: pt_mode non scritto', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  sim.STATE.dailyTempSum   = 0;
  sim.STATE.dailyTempCount = 0;
  sim.STATE.todayDay       = -1;
  sim.STATE.todayMonth     = -1;
  const kvSetsBefore = sim.kvSets.filter(s => s.key === 'pt_mode').length;
  sim.checkDateChange();
  const kvSetsAfter = sim.kvSets.filter(s => s.key === 'pt_mode').length;
  eq(kvSetsAfter, kvSetsBefore, 'pt_mode non scritto senza letture');
});

test('Stesso giorno: checkDateChange non esegue nulla', () => {
  const sim = createSim({ kv: {} });
  const maxBefore = sim.STATE.todayMaxTemp;
  const printsBefore = sim.prints.length;
  sim.checkDateChange();  // stesso giorno già impostato al boot
  eq(sim.prints.length, printsBefore, 'nessun log aggiuntivo');
  eq(sim.STATE.todayMaxTemp, maxBefore, 'todayMaxTemp invariato');
});

// ─── STATISTICHE GIORNALIERE ──────────────────────────────────────────────────
console.log(B + '\nStatistiche giornaliere\n' + X);

test('hourBufLen: non supera Config.hourAvgLen', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  const maxLen = sim.CONFIG.hourAvgLen;
  ok(sim.STATE.hourBufLen <= maxLen,
     'hourBufLen=' + sim.STATE.hourBufLen + ' <= ' + maxLen);
});

test('hourBufSum coerente con hourBuf (somma degli elementi scritti)', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  const len  = sim.STATE.hourBufLen;
  let expected = 0;
  for (let i = 0; i < len; i++) expected += sim.STATE.hourBuf[i];
  ok(Math.abs(sim.STATE.hourBufSum - expected) < 0.01,
     'hourBufSum=' + sim.STATE.hourBufSum + ' atteso=' + expected);
});

// ─── STIMA TEMPERATURA ───────────────────────────────────────────────────────
console.log(B + '\nStima temperatura\n' + X);

test('estimateWaterTemp: null se forecast non disponibile (no internet)', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  ok(sim.STATE.todayForecastTempMax === null, 'forecast null senza internet');
  sim.STATE.lastTemp = null; sim.STATE.todayCurrentTemp = null; sim.STATE.todayMaxTemp = null;
  eq(sim.getEffectiveTemp(), 15, 'fallback sicurezza 15 senza stima');
});

test('estimateWaterTemp: valore numerico finito con forecast disponibile', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  ok(sim.STATE.todayForecastTempMax !== null, 'forecast presente');
  sim.STATE.lastTemp = null; sim.STATE.todayCurrentTemp = null; sim.STATE.todayMaxTemp = null;
  const t = sim.getEffectiveTemp();
  ok(t !== null && t !== 15 && isFinite(t), 'stima numerica: ' + t);
});

test('calibOffset applicato alla stima', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  sim.STATE.lastTemp = null; sim.STATE.todayCurrentTemp = null; sim.STATE.todayMaxTemp = null;
  sim.STATE.calibOffset = 0;
  const base = sim.getEffectiveTemp();
  sim.STATE.calibOffset = 3.0;
  const shifted = sim.getEffectiveTemp();
  ok(Math.abs((shifted - base) - 3.0) < 0.01, 'offset +3.0: ' + base + ' -> ' + shifted);
});

// ─── VIRTUAL COMPONENTS ───────────────────────────────────────────────────────
console.log(B + '\nVirtual Components\n' + X);

test('text:200 scritto con sensore: nessuna parentesi angolare', () => {
  const sim = createSim({ kv: { 'pt_ip': PLUS_IP }});
  const vc = sim.textCalls.filter(t => t.id === 200);
  ok(vc.length > 0, 'text:200 scritto');
  const last = vc[vc.length - 1].value;
  ok(last.indexOf('<') < 0, 'nessuna stima <> con sensore: ' + last);
  has([last], 'Max:', 'contiene Max');
  has([last], 'Min:', 'contiene Min');
});

test('text:200 senza sensore: usa stima con parentesi angolari', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  const vc = sim.textCalls.filter(t => t.id === 200);
  ok(vc.length > 0, 'text:200 scritto');
  const last = vc[vc.length - 1].value;
  ok(last.indexOf('<') >= 0, 'stima con <> senza sensore: ' + last);
});

test('text:201 scritto con dati meteo', () => {
  const sim = createSim({ kv: {}, internetOk: true });
  const vc = sim.textCalls.filter(t => t.id === 201);
  ok(vc.length > 0, 'text:201 scritto');
  has([vc[0].value], 'A:', 'contiene temperatura aria');
  has([vc[0].value], 'TS:', 'contiene stima acqua');
});

test('text:201 non scritto senza internet', () => {
  const sim = createSim({ kv: {}, internetOk: false });
  const vc = sim.textCalls.filter(t => t.id === 201);
  eq(vc.length, 0, 'text:201 non scritto senza meteo');
});

// ─── RIEPILOGO ────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(52));
console.log(B + 'Risultato: ' + G + passed + ' PASS' + X + '  ' +
            (failed ? R : '') + failed + ' FAIL' + X + '\n');
if (failed > 0) process.exit(1);
