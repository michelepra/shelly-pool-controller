/**
 * SHELLY PRO 2PM - Controllo Pompa Piscina
 * Stima temperatura acqua via formula da temperatura ambientale (Open-Meteo API)
 * IP Plus 2PM letto da KV store - Fasce orarie ottimizzate per fotovoltaico
 *
 * Gerarchia di controllo:
 * 1. SW1 (P2 pdc + tControl pump) sempre prioritario in qualunque modalita'
 * 2. Modalita' ON       pompa sempre accesa (SW1 resta prioritario)
 * 3. Modalita' OFF      pompa sempre spenta (SW1 resta prioritario)
 * 4. Modalita' EXTERNAL pompa segue solo SW1; da app si puo' solo passare a OFF
 * 5. Modalita' AUTO     script gestisce in base a temperatura e fasce orarie
 *
 * FASCE ORARIE (ottimizzate per fotovoltaico, nessun avvio 22:00-08:00):
 *
 * < 15   1 ora  13:00-14:00
 * 16-20  3 ore  09:00-10:00, 12:00-13:00, 15:00-16:00
 * 21-25  6 ore  08:00-09:00, 11:00-15:00, 16:00-17:00
 * 26-30  9 ore  08:00-10:00, 12:00-17:00, 17:00-19:00
 * > 31  13 ore  08:00-21:00 continuo
 *
 * Antigelo: sotto 3 gradi, 5 minuti ogni ora
 *
 * STIMA TEMPERATURA ACQUA (usata quando il sensore non e' disponibile):
 *   T_acqua = T_aria * waterTempFactor + waterTempOffset
 * La temperatura ambientale e' letta da Open-Meteo ogni 15 minuti.
 * Configurare waterTempFactor e waterTempOffset in base al comportamento
 * reale della propria piscina.
 *
 * STRUTTURA KV STORE (3 chiavi obbligatorie):
 * "pt_ip"   IP del Plus 2PM (es. "192.168.1.100") - IMPOSTARE PRIMA DI AVVIARE
 * "pt_lat"  Latitudine posizione (es. "00.00")     - IMPOSTARE PRIMA DI AVVIARE
 * "pt_lon"  Longitudine posizione (es. "00.00")    - IMPOSTARE PRIMA DI AVVIARE
 *
 * VIRTUAL COMPONENTS DA CREARE NELL'APP SHELLY (firmware >= 1.7.5):
 * enum:200   modalita' pompa (valori: AUTO, ON, OFF, EXTERNAL - default: AUTO)
 * number:200  temperatura sonda in ingresso (scrittura esterna via Number.Set)
 * text:200    temperatura acqua (sola lettura, aggiornato dallo script)
 * Nota: gli ID sono per-tipo, tutti i componenti con ID 200 coesistono senza conflitti
 */

// ─── CONFIGURAZIONE ───────────────────────────────────────────────────────────

let CONFIG = {
  plusDevicePort: 80,
  tempSensorID: 100,
  tempReadInterval: 30000,        // lettura sensore acqua ogni 30 sec
  pumpCheckInterval: 60000,       // ciclo controllo ogni 60 sec
  maxTempAge: 3600,               // eta' max lettura sensore valida (sec)
  enumID: 200,                    // ID Virtual Component modalita'
  sondaInputID: 200,              // ID Virtual Component number per ricezione temp sonda
  textID: 200,                    // ID Virtual Component temperatura acqua
  currentMeteoID: 201,            // ID Virtual Component condizioni meteo attuali
  forecastID: 202,                // ID Virtual Component previsioni giorno successivo
  switchID: 0,                    // ID rele' pompa
  antifreezeTempC: 3,             // soglia antigelo
  antifreezeDuration: 300000,     // durata antigelo 5 minuti (ms)
  kvIPKey: "pt_ip",               // chiave KV per IP Plus 2PM
  kvExtOffKey: "ext_off",         // chiave KV per blocco EXTERNAL da app
  kvLatKey: "pt_lat",             // chiave KV latitudine
  kvLonKey: "pt_lon",             // chiave KV longitudine
  waterTempFactor: 0.65,          // formula stima: T_acqua = min(max, T_aria_smorzata * factor + offset)
  waterTempOffset: 8,             // offset formula (gradi)
  waterTempMax: 31,               // temperatura massima raggiungibile dall'acqua
  ambientTempAlpha: 0.03,         // inerzia termica EMA: alpha=0.03 -> ~8h costante di tempo
  evapCorrScale: 3,               // gradi di raffreddamento per kg/h/m2 di evaporazione (calibrare)
  poolCoverEvapFactor: 0.1,       // frazione di evaporazione con telo isotermico (~90% riduzione)
  calibAlpha: 0.1,                // velocita' apprendimento calibrazione (10% per giorno)
  ambientReadInterval: 900000,    // lettura temperatura ambientale ogni 15 min (ms)
};

// Numero di letture in 15 minuti; aggiornare se si cambia tempReadInterval
CONFIG.hourAvgLen = Math.round(900000 / CONFIG.tempReadInterval);

// ─── STATO GLOBALE ────────────────────────────────────────────────────────────

let STATE = {
  plusDeviceIP: null,       // IP Plus 2PM letto da KV
  weatherLat: null,         // latitudine letta da KV (pt_lat)
  weatherLon: null,         // longitudine letta da KV (pt_lon)
  hwActive: false,          // SW1 attivo
  lastSondaTime: 0,         // timestamp ultimo AggiornaTempSonda ricevuto (0=mai)
  currentMode: "AUTO",      // ultima modalita' letta dal VC enum
  extForcedOff: false,      // EXTERNAL: pompa bloccata da app, attende nuovo impulso SW1
  lastTemp: null,           // ultima temperatura sensore acqua letta
  lastTempTime: 0,          // timestamp ultima lettura sensore (ms)
  todayMaxTemp: null,       // temperatura massima registrata oggi
  todayMinTemp: null,       // temperatura minima registrata oggi
  todayCurrentTemp: null,   // temperatura corrente sensore
  todayMonth: -1,           // mese corrente (1-12)
  todayDay: -1,             // giorno del mese corrente (1-31)
  ambientTemp: null,        // EMA temperatura ambientale (smorzata per inerzia termica)
  ambientTempRaw: null,     // temperatura ambientale istantanea (per formula evaporazione)
  ambientRH: null,          // umidita' relativa % da Open-Meteo
  windSpeed: null,          // velocita' vento km/h da Open-Meteo
  todayForecastTempMax: null, // temperatura max prevista oggi (da Open-Meteo daily[0])
  todayForecastWind: null,    // vento max previsto oggi
  forecastTempMax: null,      // temperatura max prevista domani (da Open-Meteo daily[1])
  forecastWind: null,         // vento max previsto domani
  calibOffset: 0,             // correzione additiva appresa dalle letture reali (persistente su KV)
  dailyTempSum: 0,            // somma temperature giornaliere per calcolo media
  dailyTempCount: 0,          // contatore letture giornaliere
  activeScheduleMode: null,   // modo fascia oraria: "A1","A3","A6","A9","A13"
  hourBuf: [],                // buffer circolare ultime CONFIG.hourAvgLen letture
  hourBufIdx: 0,              // indice di scrittura corrente (0..hourAvgLen-1)
  hourBufLen: 0,              // elementi effettivamente presenti (0..hourAvgLen)
  hourBufSum: 0,              // somma corrente del buffer (aggiornamento O(1))
  readingInProgress: false,   // true durante multiReadTemp, blocca il timer
  pumpOn: false,
  antifreezeActive: false,
  antifreezeTimer: null,
  ready: false,
};

// ─── UTILITA' TEMPO ───────────────────────────────────────────────────────────

function getUnixtime() {
  let sys = Shelly.getComponentStatus("sys");
  return (sys && sys.unixtime) ? sys.unixtime : 0;
}

function getDateInfo(unixtime) {
  if (unixtime === 0) return { month: 1, day: 1, hour: 12 };
  let d = new Date(unixtime * 1000);
  return {
    month: d.getMonth() + 1,
    day:   d.getDate(),
    hour:  d.getHours(),
  };
}

function mStr(month) {
  return month < 10 ? "0" + month : "" + month;
}

// ─── STIMA TEMPERATURA ACQUA ──────────────────────────────────────────────────

// Tasso di evaporazione [kg/h/m2] dalla formula ASHRAE per piscine scoperte.
// Twater, Tair in gradi, rhPct in %, windKmh in km/h.
function computeEvapRate(Twater, Tair, rhPct, windKmh) {
  // Pressione di saturazione [Pa] con formula di Magnus
  let Pvw = 610.78 * Math.exp(17.27 * Twater / (Twater + 237.3));
  let Pva = 610.78 * Math.exp(17.27 * Tair   / (Tair   + 237.3));
  // Umidita' specifica [kgv/kga]
  let Xw = 0.622 * Pvw / (101325 - Pvw);
  let Xa = 0.622 * (rhPct / 100 * Pva) / (101325 - rhPct / 100 * Pva);
  let dX = Xw - Xa;
  if (dX <= 0) return 0;  // aria piu' umida dell'acqua: nessuna evaporazione
  let V = windKmh / 3.6;  // da km/h a m/s
  return (20.7 + 18 * V) * dX;  // [kg/h/m2]
}

function estimateWaterTemp() {
  if (STATE.todayForecastTempMax === null) return null;
  let est = STATE.todayForecastTempMax * CONFIG.waterTempFactor + CONFIG.waterTempOffset;
  if (est > CONFIG.waterTempMax) est = CONFIG.waterTempMax;
  // Correzione evaporativa ridotta dal telo isotermico (poolCoverEvapFactor)
  if (STATE.ambientRH !== null && STATE.windSpeed !== null) {
    let g = computeEvapRate(est, STATE.todayForecastTempMax, STATE.ambientRH, STATE.windSpeed);
    est -= g * CONFIG.evapCorrScale * CONFIG.poolCoverEvapFactor;
    if (est < 5) est = 5;
  }
  return Math.round((est + STATE.calibOffset) * 10) / 10;
}

// ─── VIRTUAL COMPONENT ───────────────────────────────────────────────────────

function updateVirtualComponent() {
  let corrente;
  if (STATE.todayCurrentTemp !== null) {
    corrente = STATE.todayCurrentTemp;
  } else {
    let est = estimateWaterTemp();
    corrente = est !== null ? "<" + est + ">" : "<-->";
  }
  let max = STATE.todayMaxTemp !== null ? STATE.todayMaxTemp : "--";
  let min = STATE.todayMinTemp !== null ? STATE.todayMinTemp : "--";

  let val = corrente + " | Max: " + max + " | Min: " + min;

  Shelly.call("Text.Set", {
    id: CONFIG.textID,
    value: val
  }, function(result, error) {
    if (error) print("VC text:" + CONFIG.textID + ": errore - " + error);
  });
}

// ─── VIRTUAL COMPONENTS METEO ────────────────────────────────────────────────

function estimateForecastWaterTemp(tAirMax, windKmh) {
  let est = tAirMax * CONFIG.waterTempFactor + CONFIG.waterTempOffset;
  if (est > CONFIG.waterTempMax) est = CONFIG.waterTempMax;
  // Usa umidita' corrente come proxy (daily RH non disponibile da Open-Meteo)
  if (STATE.ambientRH !== null && windKmh !== null) {
    let g = computeEvapRate(est, tAirMax, STATE.ambientRH, windKmh);
    est -= g * CONFIG.evapCorrScale * CONFIG.poolCoverEvapFactor;
    if (est < 5) est = 5;
  }
  return Math.round((est + STATE.calibOffset) * 10) / 10;
}

function updateMeteoComponents() {
  if (STATE.ambientTempRaw !== null) {
    let ts  = estimateWaterTemp();
    let rh  = STATE.ambientRH !== null ? Math.round(STATE.ambientRH)  : "--";
    let v   = STATE.windSpeed !== null ? Math.round(STATE.windSpeed)  : "--";
    let val = "A: " + Math.round(STATE.ambientTempRaw) +
              " U:" + rh + " V:" + v +
              " TS: " + (ts !== null ? ts : "--");
    Shelly.call("Text.Set", { id: CONFIG.currentMeteoID, value: val }, function(r, e) {
      if (e) print("VC text:" + CONFIG.currentMeteoID + ": errore - " + e);
    });
  }
  if (STATE.forecastTempMax !== null) {
    let tsF = estimateForecastWaterTemp(STATE.forecastTempMax, STATE.forecastWind);
    let v   = STATE.forecastWind !== null ? Math.round(STATE.forecastWind) : "--";
    let val = "A: " + Math.round(STATE.forecastTempMax) +
              " U:-- V:" + v +
              " TS: " + tsF;
    Shelly.call("Text.Set", { id: CONFIG.forecastID, value: val }, function(r, e) {
      if (e) print("VC text:" + CONFIG.forecastID + ": errore - " + e);
    });
  }
}

// ─── KV STORE ────────────────────────────────────────────────────────────────

function loadKVIP(onComplete) {
  Shelly.call("KVS.Get", { key: CONFIG.kvIPKey }, function(result, error) {
    if (!error && result && result.value !== null && result.value !== undefined) {
      let ip = result.value;
      print("KV: IP Plus 2PM caricato: " + ip);
      if (onComplete) onComplete(ip);
      return;
    }
    print("!!! KV: chiave '" + CONFIG.kvIPKey + "' non trovata!");
    print("!!! Impostare l'IP del Plus 2PM nel KV store:");
    print("!!! Chiave: " + CONFIG.kvIPKey + "  Valore: 192.168.x.x");
    print("!!! Lo script funzionera' in modalita' fallback senza lettura temperatura.");
    if (onComplete) onComplete(null);
  });
}

function loadExtForcedOff(onComplete) {
  Shelly.call("KVS.Get", { key: CONFIG.kvExtOffKey }, function(result, error) {
    if (!error && result && result.value === "1") {
      STATE.extForcedOff = true;
      print("KV: EXTERNAL forced-off attivo - attendo nuovo impulso SW1");
    }
    if (onComplete) onComplete();
  });
}

function loadCalibration(onComplete) {
  Shelly.call("KVS.Get", { key: "pt_cal" }, function(result, error) {
    if (!error && result && result.value !== null) {
      let v = parseFloat(result.value);
      if (!isNaN(v)) {
        STATE.calibOffset = v;
        print("Cal: offset caricato: " + v);
      }
    }
    if (onComplete) onComplete();
  });
}

function saveCalibration() {
  Shelly.call("KVS.Set", { key: "pt_cal", value: "" + STATE.calibOffset }, function(r, e) {
    if (e) print("Cal: errore salvataggio - " + e);
    else print("Cal: offset salvato: " + STATE.calibOffset);
  });
}

function loadKVCoords(onComplete) {
  Shelly.call("KVS.Get", { key: CONFIG.kvLatKey }, function(rLat, eLat) {
    if (!eLat && rLat && rLat.value !== null) {
      let v = parseFloat(rLat.value);
      if (!isNaN(v)) STATE.weatherLat = v;
    }
    Shelly.call("KVS.Get", { key: CONFIG.kvLonKey }, function(rLon, eLon) {
      if (!eLon && rLon && rLon.value !== null) {
        let v = parseFloat(rLon.value);
        if (!isNaN(v)) STATE.weatherLon = v;
      }
      if (STATE.weatherLat === null || STATE.weatherLon === null) {
        print("!!! KV: pt_lat/pt_lon non configurati - meteo non disponibile");
      } else {
        print("KV: coordinate " + STATE.weatherLat + " / " + STATE.weatherLon);
      }
      if (onComplete) onComplete();
    });
  });
}

function saveScheduleMode(mode) {
  let ts = getUnixtime();
  Shelly.call("KVS.Set", { key: "pt_mode", value: mode + ":" + ts }, function(r, e) {
    if (e) print("Mode: errore salvataggio - " + e);
    else print("Mode: salvato " + mode);
  });
}

function loadScheduleMode(onComplete) {
  Shelly.call("KVS.Get", { key: "pt_mode" }, function(result, error) {
    if (!error && result && result.value) {
      let sep = result.value.indexOf(":");
      if (sep > 0) {
        let mode = result.value.substring(0, sep);
        let savedTs = parseInt(result.value.substring(sep + 1));
        let now = getUnixtime();
        if (!isNaN(savedTs) && (now - savedTs) < 86400) {
          STATE.activeScheduleMode = mode;
          print("Mode: caricato " + mode + " (" + Math.round((now - savedTs) / 3600) + "h fa)");
          if (onComplete) onComplete(true);
          return;
        }
        print("Mode: KV scaduto (" + Math.round((now - savedTs) / 3600) + "h), bootstrap necessario");
      }
    }
    if (onComplete) onComplete(false);
  });
}

// ─── LETTURA TEMPERATURA AMBIENTALE ──────────────────────────────────────────

function fetchAmbientTemp() {
  if (STATE.weatherLat === null || STATE.weatherLon === null) {
    print("Meteo: coordinate non configurate (pt_lat/pt_lon mancanti nel KV store)");
    return;
  }
  let url = "https://api.open-meteo.com/v1/forecast?latitude=" +
            STATE.weatherLat + "&longitude=" + STATE.weatherLon +
            "&current=temperature_2m,relative_humidity_2m,wind_speed_10m" +
            "&daily=temperature_2m_max,wind_speed_10m_max&forecast_days=2&timezone=auto";

  Shelly.call("HTTP.GET", { url: url, timeout: 10 }, function(result, error) {
    if (error || result === null || result.code !== 200) {
      print("Meteo: errore lettura");
      return;
    }
    try {
      let data = JSON.parse(result.body);
      let cur = data && data.current;
      if (cur && cur.temperature_2m !== undefined) {
        let raw = cur.temperature_2m;
        STATE.ambientTempRaw = raw;
        if (cur.relative_humidity_2m !== undefined) STATE.ambientRH  = cur.relative_humidity_2m;
        if (cur.wind_speed_10m      !== undefined) STATE.windSpeed = cur.wind_speed_10m;
        // Aggiorna EMA per inerzia termica
        if (STATE.ambientTemp === null) {
          STATE.ambientTemp = raw;
        } else {
          STATE.ambientTemp = Math.round(
            (CONFIG.ambientTempAlpha * raw +
             (1 - CONFIG.ambientTempAlpha) * STATE.ambientTemp) * 10) / 10;
        }
        // Previsioni oggi (indice 0) e domani (indice 1) dall'array daily
        let daily = data.daily;
        if (daily && daily.temperature_2m_max && daily.temperature_2m_max.length > 0) {
          STATE.todayForecastTempMax = daily.temperature_2m_max[0];
        }
        if (daily && daily.wind_speed_10m_max && daily.wind_speed_10m_max.length > 0) {
          STATE.todayForecastWind = daily.wind_speed_10m_max[0];
        }
        if (daily && daily.temperature_2m_max && daily.temperature_2m_max.length > 1) {
          STATE.forecastTempMax = daily.temperature_2m_max[1];
        }
        if (daily && daily.wind_speed_10m_max && daily.wind_speed_10m_max.length > 1) {
          STATE.forecastWind = daily.wind_speed_10m_max[1];
        }
        let ts = estimateWaterTemp();
        print("Aria: " + raw + " UR:" + STATE.ambientRH + "% V:" + STATE.windSpeed +
              "km/h MaxOggi:" + STATE.todayForecastTempMax +
              " -> stima:" + ts);
        if (STATE.forecastTempMax !== null) {
          print("Domani: A:" + Math.round(STATE.forecastTempMax) +
                " V:" + Math.round(STATE.forecastWind) +
                " TS:" + estimateForecastWaterTemp(STATE.forecastTempMax, STATE.forecastWind));
        }
        updateVirtualComponent();
        updateMeteoComponents();
      }
    } catch (e) {
      print("Meteo: errore parsing - " + e);
    }
  });
}

// ─── GESTIONE CAMBIO GIORNO ───────────────────────────────────────────────────

function checkDateChange() {
  let d = getDateInfo(getUnixtime());
  let month = d.month;
  let day = d.day;
  if (month === STATE.todayMonth && day === STATE.todayDay) return;

  if (STATE.todayMaxTemp !== null && STATE.todayDay >= 1) {
    // Calibrazione: confronta massimo sensore con stima (ancora basata su forecast di ieri)
    let est = estimateWaterTemp();
    if (est !== null) {
      let err = STATE.todayMaxTemp - est;
      let newOff = STATE.calibOffset + CONFIG.calibAlpha * err;
      // Limita l'offset a +-8 gradi; oltre conviene ricalibrate factor/offset manualmente
      STATE.calibOffset = Math.round(Math.min(8, Math.max(-8, newOff)) * 10) / 10;
      print("Cal: max=" + STATE.todayMaxTemp + " est=" + est +
            " err=" + Math.round(err * 10) / 10 + " -> offset=" + STATE.calibOffset);
      saveCalibration();
    }
    print("Cambio giorno: max " + STATE.todayMaxTemp);
  }
  // Calcola media giornaliera e determina il modo fascia oraria per il giorno entrante
  if (STATE.dailyTempCount > 0) {
    let avg = Math.round(STATE.dailyTempSum / STATE.dailyTempCount * 10) / 10;
    let newMode = getModeFromTemp(avg);
    STATE.activeScheduleMode = newMode;
    saveScheduleMode(newMode);
    print("Mode: media=" + avg + "C (" + STATE.dailyTempCount + " letture) -> " + newMode);
  }
  STATE.dailyTempSum    = 0;
  STATE.dailyTempCount  = 0;
  STATE.hourBuf         = [];
  STATE.hourBufIdx      = 0;
  STATE.hourBufLen      = 0;
  STATE.hourBufSum      = 0;
  STATE.todayMonth      = month;
  STATE.todayDay        = day;
  STATE.todayMaxTemp    = null;
  STATE.todayMinTemp    = null;
  STATE.todayCurrentTemp = null;
  print("Nuovo giorno " + day + "/" + mStr(month));
  updateVirtualComponent();
}

function updateDailyStats(temp) {
  STATE.todayCurrentTemp = temp;
  STATE.dailyTempSum += temp;
  STATE.dailyTempCount++;

  // Aggiorna buffer circolare (index-based, niente push/shift)
  let maxLen = CONFIG.hourAvgLen;
  let idx = STATE.hourBufIdx;
  if (STATE.hourBufLen === maxLen) {
    STATE.hourBufSum -= STATE.hourBuf[idx];  // sottrai il valore che stiamo per sovrascrivere
  } else {
    STATE.hourBufLen++;
  }
  STATE.hourBuf[idx]   = temp;
  STATE.hourBufSum     += temp;
  STATE.hourBufIdx      = (idx + 1) % maxLen;
  let hourAvg = Math.round(STATE.hourBufSum / STATE.hourBufLen * 10) / 10;

  if (STATE.todayMaxTemp === null || hourAvg > STATE.todayMaxTemp) {
    STATE.todayMaxTemp = hourAvg;
    print("Nuovo massimo odierno: " + hourAvg);
  }
  if (STATE.todayMinTemp === null || hourAvg < STATE.todayMinTemp) {
    STATE.todayMinTemp = hourAvg;
    print("Nuovo minimo odierno: " + hourAvg);
  }
  updateVirtualComponent();
}

// ─── FASCE ORARIE OTTIMIZZATE PER FOTOVOLTAICO ───────────────────────────────
// Nessun avvio tra 22:00 e 08:00
// Stesse ore totali del tControl redistribuite in orario diurno/solare
//
// A1  ( < 15 C)  1 ora:  13-14
// A3  (16-20 C)  3 ore:  09-10, 12-13, 15-16
// A6  (21-25 C)  6 ore:  08-09, 11-15, 16-17
// A9  (26-30 C)  9 ore:  08-10, 12-17, 17-19
// A13 ( > 31 C) 13 ore:  08-21 continuo
//
// Il modo e' determinato dalla media giornaliera e cambia a mezzanotte.

function getModeFromTemp(temp) {
  if (temp < 15) return "A1";
  if (temp <= 20) return "A3";
  if (temp <= 25) return "A6";
  if (temp <= 30) return "A9";
  return "A13";
}

function shouldPumpRunBySchedule(hour, temp) {
  let mode = STATE.activeScheduleMode !== null ? STATE.activeScheduleMode : getModeFromTemp(temp);

  if (mode === "A1")  return (hour >= 13 && hour < 14);
  if (mode === "A3")  return ((hour >= 9  && hour < 10) || (hour >= 12 && hour < 13) || (hour >= 15 && hour < 16));
  if (mode === "A6")  return ((hour >= 8  && hour < 9)  || (hour >= 11 && hour < 15) || (hour >= 16 && hour < 17));
  if (mode === "A9")  return ((hour >= 8  && hour < 10) || (hour >= 12 && hour < 17) || (hour >= 17 && hour < 19));
  return (hour >= 8 && hour < 21);  // A13
}

// ─── LETTURA TEMPERATURA SENSORE ─────────────────────────────────────────────

function fetchTemperatureOnce(cb) {
  if (STATE.plusDeviceIP === null) {
    if (cb) cb(null);
    return;
  }
  let url = "http://" + STATE.plusDeviceIP + ":" + CONFIG.plusDevicePort +
            "/rpc/Temperature.GetStatus?id=" + CONFIG.tempSensorID;
  Shelly.call("HTTP.GET", { url: url, timeout: 5 }, function(result, error) {
    if (error || result === null || result.code !== 200) {
      print("Temperatura: errore lettura (" + STATE.plusDeviceIP + ")");
      if (cb) cb(null);
      return;
    }
    try {
      let data = JSON.parse(result.body);
      if (data && data.tC !== undefined && data.tC !== null) {
        if (cb) cb(Math.round(data.tC * 10) / 10);
      } else {
        if (cb) cb(null);
      }
    } catch (e) {
      print("Temperatura: errore parsing - " + e);
      if (cb) cb(null);
    }
  });
}

function fetchTemperatureWithRetry(onDone) {
  if (STATE.plusDeviceIP === null) {
    if (onDone) onDone(null);
    return;
  }
  STATE.readingInProgress = true;
  let attempts = 0;
  let doFetch = function() {
    fetchTemperatureOnce(function(temp) {
      attempts++;
      if (temp !== null) {
        STATE.lastTemp = temp;
        STATE.lastTempTime = Date.now();
        STATE.lastSondaTime = Date.now();
        updateDailyStats(temp);
        print("Temp HTTP: " + temp + " (tentativo " + attempts + ")");
        STATE.readingInProgress = false;
        if (onDone) onDone(temp);
      } else if (attempts < 10) {
        Timer.set(2000, false, doFetch);
      } else {
        print("Temperatura: " + attempts + " tentativi falliti");
        STATE.readingInProgress = false;
        if (onDone) onDone(null);
      }
    });
  };
  doFetch();
}

function fetchTemperature() {
  if (STATE.readingInProgress) return;
  fetchTemperatureWithRetry(null);
}

function bootstrapTemperature(onDone) {
  fetchTemperatureWithRetry(function(temp) {
    if (temp !== null) {
      print("Bootstrap temp: " + temp);
    } else {
      print("Bootstrap temp: nessuna lettura disponibile");
    }
    if (onDone) onDone();
  });
}

function getEffectiveTemp() {
  let ageSeconds = (Date.now() - STATE.lastTempTime) / 1000;

  if (STATE.lastTemp !== null && ageSeconds < CONFIG.maxTempAge) {
    return STATE.lastTemp;
  }
  if (STATE.lastTemp !== null) {
    print("Temp fallback: ultima nota " + STATE.lastTemp);
    return STATE.lastTemp;
  }
  if (STATE.todayCurrentTemp !== null) {
    print("Temp fallback: corrente " + STATE.todayCurrentTemp);
    return STATE.todayCurrentTemp;
  }
  if (STATE.todayMaxTemp !== null) {
    print("Temp fallback: massimo odierno " + STATE.todayMaxTemp);
    return STATE.todayMaxTemp;
  }
  let est = estimateWaterTemp();
  if (est !== null) {
    print("Temp fallback: stima meteo " + est);
    return est;
  }
  print("Temp fallback: sicurezza 15");
  return 15;
}

// ─── ANTIGELO ─────────────────────────────────────────────────────────────────

function checkAntifreeze(temp) {
  if (temp > CONFIG.antifreezeTempC) {
    STATE.antifreezeActive = false;
    return false;
  }
  if (!STATE.antifreezeActive) {
    print("ANTIGELO: " + temp + " pompa ON per 5 minuti");
    STATE.antifreezeActive = true;
    setPump(true, "antigelo");
    if (STATE.antifreezeTimer !== null) Timer.clear(STATE.antifreezeTimer);
    STATE.antifreezeTimer = Timer.set(
      CONFIG.antifreezeDuration, false, function() {
        STATE.antifreezeActive = false;
        STATE.antifreezeTimer = null;
        print("ANTIGELO: ciclo completato");
        evaluatePump();
      }
    );
  }
  return true;
}

// ─── CONTROLLO RELE' ─────────────────────────────────────────────────────────

function setPump(on, source) {
  if (STATE.pumpOn === on) return;
  print("Pompa: " + (on ? "ON" : "OFF") + " [" + source + "]");
  STATE.pumpOn = on;
  Shelly.call("Switch.Set", { id: CONFIG.switchID, on: on });
}

// ─── LOGICA PRINCIPALE ────────────────────────────────────────────────────────

function evaluatePump() {
  if (!STATE.ready) {
    print("Avvio in corso, attendo caricamento KV...");
    return;
  }

  if (STATE.hwActive && !STATE.extForcedOff) {
    setPump(true, "hardware SW1");
    return;
  }

  let temp = getEffectiveTemp();

  if (checkAntifreeze(temp)) return;

  let modeVC = Shelly.getComponentStatus("enum:" + CONFIG.enumID);
  let mode = (modeVC && modeVC.value) ? modeVC.value : "AUTO";

  if (mode === "ON") {
    setPump(true, "manuale ON");
    return;
  }

  if (mode === "OFF") {
    setPump(false, "manuale OFF");
    return;
  }

  if (mode === "EXTERNAL") {
    // SW1 attivo e' gia' gestito sopra con priorita' assoluta.
    // Se si arriva qui SW1 e' inattivo: la pompa segue lo stato esterno.
    setPump(false, "esterno SW1 inattivo");
    return;
  }

  let dateInfo = getDateInfo(getUnixtime());
  let shouldRun = shouldPumpRunBySchedule(dateInfo.hour, temp);
  setPump(shouldRun, "auto T=" + temp + " H=" + dateInfo.hour);
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

Shelly.addStatusHandler(function(event) {
  if (event.component === "input:0") {
    if (!event.delta || event.delta.state === undefined) return;
    let prev = STATE.hwActive;
    STATE.hwActive = event.delta.state;
    if (STATE.hwActive !== prev) {
      print("SW1: " + (STATE.hwActive ? "ON" : "OFF"));
      if (STATE.hwActive && STATE.extForcedOff) {
        STATE.extForcedOff = false;
        Shelly.call("KVS.Set", { key: CONFIG.kvExtOffKey, value: "0" }, null);
        Shelly.call("Enum.Set", { id: CONFIG.enumID, value: "EXTERNAL" }, null);
        STATE.currentMode = "EXTERNAL";
        print("EXTERNAL: nuovo impulso SW1, ripristino modalita'");
      }
      evaluatePump();
    }
  }
  if (event.component === "enum:" + CONFIG.enumID) {
    if (!event.delta || !event.delta.value) return;
    let prevMode = STATE.currentMode;
    let newMode = event.delta.value;
    STATE.currentMode = newMode;
    print("Modalita': " + newMode);
    if (newMode === "OFF" && prevMode === "EXTERNAL" && STATE.hwActive) {
      STATE.extForcedOff = true;
      Shelly.call("KVS.Set", { key: CONFIG.kvExtOffKey, value: "1" }, null);
      print("EXTERNAL: pompa bloccata da app, attendo nuovo impulso SW1");
    }
    evaluatePump();
  }
  if (event.component === "number:" + CONFIG.sondaInputID) {
    if (!event.delta || event.delta.value === undefined) return;
    let t = event.delta.value;
    if (typeof t !== "number" || t < -5 || t > 50) return;
    STATE.lastTemp = t;
    STATE.lastTempTime = Date.now();
    STATE.lastSondaTime = Date.now();
    updateDailyStats(t);
    print("AggiornaTempSonda: " + t);
  }
});

// ─── TIMER ───────────────────────────────────────────────────────────────────

Timer.set(CONFIG.tempReadInterval, true, function() {
  if (Date.now() - STATE.lastSondaTime > 3600000) {
    fetchTemperature();
  }
  checkDateChange();
});

Timer.set(CONFIG.pumpCheckInterval, true, function() {
  evaluatePump();
});

Timer.set(CONFIG.ambientReadInterval, true, function() {
  fetchAmbientTemp();
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────

print("=== Controllo Pompa Piscina avviato ===");

loadKVIP(function(ip) {
  STATE.plusDeviceIP = ip;
  loadExtForcedOff(function() {
  loadCalibration(function() {
  loadKVCoords(function() {
    let startInfo = getDateInfo(getUnixtime());
    STATE.todayMonth = startInfo.month;
    STATE.todayDay   = startInfo.day;
    let modeVC = Shelly.getComponentStatus("enum:" + CONFIG.enumID);
    STATE.currentMode = (modeVC && modeVC.value) ? modeVC.value : "AUTO";
    STATE.ready      = true;

    print("Pronto. Giorno " + startInfo.day + "/" + mStr(startInfo.month) +
          (ip !== null ? " IP: " + ip : " IP: non configurato") +
          " cal:" + STATE.calibOffset);

    fetchAmbientTemp();
    loadScheduleMode(function(loaded) {
      if (loaded) {
        evaluatePump();
      } else {
        bootstrapTemperature(function() {
          if (STATE.lastTemp !== null) {
            STATE.activeScheduleMode = getModeFromTemp(STATE.lastTemp);
            print("Bootstrap mode: " + STATE.activeScheduleMode + " (T=" + STATE.lastTemp + ")");
          }
          evaluatePump();
        });
      }
    });
  });
  });
  });
});
