/**
 * SHELLY PLUS 2PM - Invio temperatura sonda al Pro 2PM
 *
 * Notifica il Pro 2PM ad ogni cambio di valore della sonda digitale
 * temperature:100 tramite Number.Set sul virtual component number:200.
 * Al boot invia subito il valore corrente.
 *
 * IP del Pro 2PM configurabile via KV store:
 *   KVS.Set  key="pro_ip"  value="192.168.x.x"
 */

let CONFIG = {
  tempSensorID: 100,     // ID sonda digitale locale (temperature:100)
  proPort: 80,           // porta HTTP del Pro 2PM
  proNumberID: 200,      // ID virtual component number sul Pro 2PM
  kvProIPKey: "pro_ip",  // chiave KV per IP Pro 2PM
};

let STATE = {
  proIP: null,
  retryTimer: null,  // timer retry attivo, null se nessun invio in corso
};

// ─── INVIO AL PRO 2PM ────────────────────────────────────────────────────────

function sendTemp(temp) {
  if (STATE.proIP === null) return;
  if (STATE.retryTimer !== null) {
    Timer.clear(STATE.retryTimer);
    STATE.retryTimer = null;
  }
  let attempts = 0;
  let url = "http://" + STATE.proIP + ":" + CONFIG.proPort +
            "/rpc/Number.Set?id=" + CONFIG.proNumberID + "&value=" + temp;
  let doSend = function() {
    STATE.retryTimer = null;
    Shelly.call("HTTP.GET", { url: url, timeout: 5 }, function(result, error) {
      attempts++;
      if (!error && result !== null && result.code === 200) {
        print("Temp inviata: " + temp + " (tentativo " + attempts + ")");
      } else if (attempts < 10) {
        STATE.retryTimer = Timer.set(5000, false, doSend);
      } else {
        print("Invio temp: " + attempts + " tentativi falliti (" + temp + "C)");
      }
    });
  };
  doSend();
}

// ─── HANDLER EVENTI ──────────────────────────────────────────────────────────

Shelly.addStatusHandler(function(event) {
  if (event.component !== "temperature:" + CONFIG.tempSensorID) return;
  if (!event.delta || event.delta.tC === undefined || event.delta.tC === null) return;
  sendTemp(Math.round(event.delta.tC * 10) / 10);
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────

function loadProIP(onComplete) {
  Shelly.call("KVS.Get", { key: CONFIG.kvProIPKey }, function(result, error) {
    if (!error && result && result.value) {
      STATE.proIP = result.value;
      print("KV: IP Pro 2PM: " + STATE.proIP);
    } else {
      print("!!! KV: chiave '" + CONFIG.kvProIPKey + "' non trovata!");
      print("!!! Impostare: KVS.Set key=pro_ip value=192.168.x.x");
    }
    if (onComplete) onComplete();
  });
}

print("=== Invio Temperatura Sonda avviato ===");

loadProIP(function() {
  let s = Shelly.getComponentStatus("temperature:" + CONFIG.tempSensorID);
  if (s && s.tC !== undefined && s.tC !== null) {
    sendTemp(Math.round(s.tC * 10) / 10);
  }
});
