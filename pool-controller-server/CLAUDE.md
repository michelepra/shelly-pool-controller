# CLAUDE.md

Questo file fornisce contesto e istruzioni per l'AI assistant che lavora su questo progetto.

---

## Descrizione del progetto

Script **mJS** per Shelly Pro 2PM che gestisce la pompa di filtrazione di una piscina privata. Il sistema integra:

- **Pompa di calore Mr. Smart** (Aquark/BSVillage) — segnale P1/P2 a 230V AC
- **Centralina tControl 1** (Aqua Water Systems) — uscite PUMP 230V e LIGHT 230V
- **Shelly Plus 2PM + Plus Add-on** — lettura sonda temperatura digitale (temperature 100)
- **Impianto fotovoltaico** — fasce orarie ottimizzate per consumo diurno

---

## File principali

| File | Descrizione |
|------|-------------|
| `pompa_piscina.js` | Sorgente completo e commentato — modificare questo |
| `pompa_piscina.min.js` | Versione minificata da caricare su Shelly (~16KB) |
| `README.md` | Documentazione completa utente |
| `CLAUDE.md` | Questo file |

> **Regola**: modificare sempre `pompa_piscina.js` e rigenerare il `.min.js`. Non editare il minificato direttamente.

---

## Architettura hardware

### Shelly Pro 2PM (cervello del sistema)

- **SW1**: riceve 230V AC da P2 della pdc (contatto secco) e/o da uscita PUMP tControl — in parallelo
- **SW2**: riceve 230V AC da uscita LIGHT tControl
- **Relè 0**: comanda la pompa filtrazione
- **Relè 1**: comanda il trasformatore luci piscina
- Script principale in esecuzione

### Shelly Plus 2PM + Add-on (sensore)

- Legge la sonda temperatura digitale (temperature 100, in parallelo con tControl)
- Espone la temperatura via API locale: `GET /rpc/Temperature.GetStatus?id=100`
- IP configurabile via KV store del Pro 2PM (chiave `pt_ip`)
- Può avere altri usi sui suoi due relè (luce esterna, impianto audio)

### Gerarchia di controllo (immutabile)

```
SW1 attivo         →  pompa ON  (priorità assoluta, protegge la pdc)
Antigelo < 3       →  pompa ON 5min/ora
Modalità ON        →  pompa ON
Modalità OFF       →  pompa OFF  (SW1 resta prioritario anche qui)
Modalità EXTERNAL  →  pompa segue solo SW1; da app si può solo passare a OFF
Modalità AUTO      →  fasce orarie + temperatura
```

---

## KV Store (6 chiavi su 50 disponibili)

```
pt_ip      →  IP del Plus 2PM (stringa, es. "192.168.1.100")          [obbligatorio]
pt_lat     →  Latitudine della posizione (float stringa, es. "00.00")  [obbligatorio]
pt_lon     →  Longitudine della posizione (float stringa, es. "00.00") [obbligatorio]
ext_off    →  "1" se EXTERNAL mode è bloccata da app, "0" altrimenti (persiste tra riavvii)
pt_cal     →  calibOffset appreso (float stringa, es. "-1.2") — aggiornato ogni notte
pt_mode    →  modo fascia oraria attivo + timestamp Unix (es. "A9:1746969600") — scade dopo 24h
pt_hourly  →  JSON array 24 slot (indice=ora, 0=nessun dato), medie orarie temperatura odierna — resettato a mezzanotte
pt_day     →  giorno di riferimento di pt_hourly ("DD/MM") — usato dal client per verificare freschezza dei dati
```

Le chiavi pt_01..pt_12 (temperature mensili storiche) sono state rimosse nella versione corrente. Se presenti nel dispositivo da versioni precedenti, possono essere eliminate manualmente ma non interferiscono.

---

## Stima temperatura acqua

Quando il sensore Plus 2PM non è disponibile, la temperatura viene stimata in più passi:

1. **Base**: `est = todayForecastTempMax * waterTempFactor + waterTempOffset` (cap a `waterTempMax`)
2. **Correzione evaporativa**: sottrae `evapRate * evapCorrScale * poolCoverEvapFactor` gradi (modello ASHRAE), dove `evapRate` dipende da temperatura acqua stimata, aria, umidità relativa e vento
3. **Calibrazione adattiva**: aggiunge `STATE.calibOffset`, appreso quotidianamente confrontando il massimo sensore reale con la stima; persiste in KV (`pt_cal`)

Valori di default: `factor = 0.65`, `offset = 8`, `waterTempMax = 31`.

La temperatura ambientale è letta da **Open-Meteo** (gratuito, no API key) ogni 15 minuti. La richiesta include temperatura corrente, umidità relativa, vento e previsioni daily (oggi e domani):
```
https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>
  &current=temperature_2m,relative_humidity_2m,wind_speed_10m
  &daily=temperature_2m_max,wind_speed_10m_max&forecast_days=2&timezone=auto
```

L'EMA (Exponential Moving Average) della temperatura con `ambientTempAlpha = 0.03` (~8h di costante di tempo) smorza le variazioni rapide per riflettere l'inerzia termica della piscina.

Coordinate lette dal KV store alle chiavi `pt_lat` e `pt_lon`. Se non configurate, `fetchAmbientTemp` non viene eseguita e lo script funziona senza dati meteo.

---

## Virtual Components (Pro 2PM)

```
enum:200    →  Modalità pompa: AUTO | ON | OFF | EXTERNAL  (default AUTO)
number:200  →  temperatura sonda in ingresso (scrittura esterna via Number.Set — es. da automazione)
text:200    →  temperatura acqua (sola lettura, aggiornato dallo script)
text:201    →  condizioni meteo attuali (sola lettura)
text:202    →  previsioni giorno successivo (sola lettura)
```

Firmware >= 1.7.5: gli ID sono per-tipo — `enum:200` e `text:200` coesistono senza conflitti. Sono sempre referenziati con il prefisso tipo (es. `"enum:200"`). L'API per scrivere il testo e' `Text.Set` (NON `VirtualComponent.Set`).

Formato text:200:
- Lettura sensore disponibile: `29.5 | Max: 30 | Min: 27`
- Lettura non disponibile, stima meteo: `<25.5> | Max: 30 | Min: 27`

Formato text:201 (aggiornato ogni 15 min da Open-Meteo):
- `A: 32 U:45 V:15 TS: 27.8`  (A=aria, U=umidita', V=vento, TS=stima acqua)

Formato text:202 (previsioni giorno successivo):
- `A: 28 U:-- V:22 TS: 26.1`  (U non disponibile da API daily Open-Meteo)

---

## Fasce orarie (ottimizzate per fotovoltaico)

Nessun avvio tra 22:00 e 08:00. Stesse ore totali del tControl originale.

| Temp | Ore | Fasce |
|------|-----|-------|
| < 15 | 1h | 13-14 |
| 16-20 | 3h | 09-10, 12-13, 15-16 |
| 21-25 | 6h | 08-09, 11-15, 16-17 |
| 26-30 | 9h | 08-10, 12-17, 17-19 |
| > 31 | 13h | 08-21 continuo |

---

## Variabili globali principali nello script

### CONFIG
Costanti operative. Parametri chiave:
- `kvIPKey: "pt_ip"` — non modificare, è la chiave KV dell'IP
- `kvLatKey: "pt_lat"` / `kvLonKey: "pt_lon"` — chiavi KV per le coordinate geografiche
- `kvExtOffKey: "ext_off"` — chiave KV per stato EXTERNAL forced-off
- `sondaInputID: 200` — ID del virtual component `number:200` per ricezione temperatura esterna
- `waterTempFactor` / `waterTempOffset` / `waterTempMax` — parametri formula stima temperatura
- `ambientTempAlpha: 0.03` — alpha EMA temperatura aria (~8h di inerzia termica)
- `evapCorrScale` — gradi di raffreddamento per kg/h/m2 di evaporazione (da calibrare)
- `poolCoverEvapFactor: 0.1` — riduzione evaporazione con telo (~90% riduzione)
- `calibAlpha: 0.1` — velocità di apprendimento calibratura (10% per giorno)

### STATE
Stato runtime. Campi chiave:
- `plusDeviceIP` — IP letto da KV all'avvio
- `weatherLat` / `weatherLon` — coordinate lette da KV (`pt_lat` / `pt_lon`); null se non configurate (blocca fetchAmbientTemp)
- `ready` — false finché KV non è caricato (blocca `evaluatePump`)
- `extForcedOff` — true se in EXTERNAL mode la pompa è stata bloccata dall'app (persiste via KV)
- `lastSondaTime` — timestamp ultimo aggiornamento temperatura (da HTTP o da number:200)
- `todayMaxTemp` / `todayMinTemp` / `todayCurrentTemp` — statistiche giornaliere (media mobile oraria)
- `ambientTemp` — EMA temperatura ambientale (smorzata, ~8h inerzia termica)
- `ambientTempRaw` — temperatura aria istantanea (per formula evaporazione)
- `ambientRH` / `windSpeed` — umidità relativa % e vento km/h da Open-Meteo
- `todayForecastTempMax` / `forecastTempMax` — max previsto oggi e domani (daily[0] e daily[1])
- `calibOffset` — correzione additiva appresa quotidianamente, persiste su KV `pt_cal`
- `activeScheduleMode` — modo fascia oraria attivo: "A1","A3","A6","A9","A13"; persiste su KV `pt_mode`
- `hourBuf` / `hourBufSum` / `hourBufLen` — buffer circolare ultime ~30 letture (media oraria scorrevole)
- `readingInProgress` — flag per evitare fetch concorrenti
- `todayHour` — ora corrente (-1=non inizializzata), usata per rilevare il cambio d'ora
- `currentHourSum` / `currentHourCount` — accumulatore per la media dell'ora corrente
- `hourlyAvgs` — array 24 slot (indice=ora, 0=nessun dato), medie orarie della giornata odierna; persiste su KV `pt_hourly`

---

## Funzioni chiave (nomi nel sorgente)

| Funzione | Descrizione |
|----------|-------------|
| `evaluatePump()` | Logica principale — applica gerarchia di priorità |
| `shouldPumpRunBySchedule(hour, temp)` | true/false per fascia oraria; usa `STATE.activeScheduleMode` |
| `getModeFromTemp(temp)` | Converte temperatura in codice modo ("A1".."A13") |
| `setPump(on, source)` | Comanda il relè 0, evita comandi ridondanti |
| `checkAntifreeze(temp)` | Gestisce ciclo antigelo 5min quando temp < 3°C |
| `checkDateChange()` | Rileva cambio giorno, aggiorna calibrazione, salva modo, resetta statistiche |
| `updateDailyStats(temp)` | Aggiorna buffer circolare, max/min orari scorrevoli, VC text:200 |
| `updateVirtualComponent()` | Scrive su text:200 via Text.Set |
| `updateMeteoComponents()` | Scrive su text:201 e text:202 |
| `computeEvapRate(Twater,Tair,rh,wind)` | Formula ASHRAE evaporazione [kg/h/m2] |
| `estimateWaterTemp()` | Stima T acqua da forecast oggi + evaporazione + calibOffset |
| `estimateForecastWaterTemp(tMax,wind)` | Stima T acqua per domani (previsioni) |
| `getEffectiveTemp()` | Cascata di fallback: sensore → stima → 15°C |
| `fetchTemperatureOnce(cb)` | Singola HTTP GET al Plus 2PM (Temperature.GetStatus) |
| `fetchTemperatureWithRetry(onDone)` | Ripete fino a 10 tentativi ogni 2s, poi callback |
| `fetchTemperature()` | Avvia fetchTemperatureWithRetry se non già in corso |
| `bootstrapTemperature(onDone)` | Prima lettura all'avvio: attende fino a lettura valida |
| `fetchAmbientTemp()` | HTTP GET Open-Meteo: aggiorna EMA, RH, vento, previsioni, VC meteo |
| `loadKVIP(cb)` | Carica IP Plus 2PM da KV (`pt_ip`) all'avvio |
| `loadKVCoords(cb)` | Carica latitudine/longitudine da KV (`pt_lat`/`pt_lon`) all'avvio |
| `loadExtForcedOff(cb)` | Carica stato EXTERNAL forced-off da KV (`ext_off`) |
| `loadCalibration(cb)` | Carica calibOffset da KV (`pt_cal`) |
| `saveCalibration()` | Salva calibOffset su KV (`pt_cal`) |
| `loadScheduleMode(cb)` | Carica modo fascia oraria da KV (`pt_mode`), scadenza 24h |
| `saveScheduleMode(mode)` | Salva modo + timestamp su KV (`pt_mode`) |
| `checkHourChange()` | Rileva cambio d'ora, salva media ora completata in `STATE.hourlyAvgs`, chiama `saveHourlyData()` |
| `saveHourlyData()` | Salva `pt_day` ("DD/MM") e `pt_hourly` (JSON array 24 slot) su KV |
| `loadHourlyData(cb)` | All'avvio: legge `pt_day` e, se corrisponde a oggi, ripristina `STATE.hourlyAvgs` da `pt_hourly` |

---

## Limitazioni note della piattaforma Shelly mJS

- **Memoria script**: 25KB totali (codice + runtime) — script minificato è ~16KB
- **KV store**: max 50 chiavi, chiave max 42 char, valore max 253 char
- **Script concorrenti**: max 3 in esecuzione simultanea
- **Timer concorrenti**: nessun limite documentato ma usare con parsimonia
- **HTTP.GET timeout**: default 5 secondi, rispetta il limite
- **Niente Promises/async**: tutto asincrono tramite callback
- **No hoisting**: dichiarare funzioni prima di usarle o usare `let f = function(){}`
- **Unicode non supportato**: usare ASCII nei print e nelle stringhe KV

---

## Regola obbligatoria: test dopo ogni modifica

**Dopo ogni modifica a `pompa_piscina.js` eseguire sempre:**

```bash
cd pool-controller-server
node test.js
```

Tutti i test devono passare prima di rigenerare il `.min.js` o fare commit. Ogni nuova feature o comportamento modificato deve essere coperto da almeno un test in `test.js`. Se si aggiunge logica non coperta dai test esistenti, aggiungere i casi corrispondenti prima di considerare la modifica completa.

---

## Istruzioni per modifiche future

### Aggiungere una nuova fascia oraria
Modificare `shouldPumpRunBySchedule()` in `pompa_piscina.js` mantenendo le stesse ore totali per ogni banda di temperatura. Verificare che nessuna fascia inizi prima delle 08:00 o finisca dopo le 22:00.

### Cambiare il dispositivo temperatura
Modificare `CONFIG.plusDevicePort` e `CONFIG.tempSensorID`. L'API deve rispondere con un JSON contenente `tC` (temperatura in Celsius).

### Cambiare la fonte meteo
Modificare `fetchAmbientTemp()` e il parsing della risposta. Il campo atteso è `data.current.temperature_2m` (Open-Meteo). Adattare se si usa un'altra API.

### Calibrare la formula di stima
Modificare `CONFIG.waterTempFactor` e `CONFIG.waterTempOffset` in base alle misurazioni reali. Per un pool riscaldato con pdc in Veneto: factor=0.65, offset=8 sono valori di partenza ragionevoli. Il sistema apprende anche un `calibOffset` adattivo (±8°C max) che si aggiorna ogni notte — verificare il valore in KV (`pt_cal`) dopo qualche settimana di funzionamento per capire se la formula base va ricalibrata.

### Aggiungere notifiche
Aggiungere chiamate HTTP.GET/POST in `evaluatePump()` nei punti di transizione di stato. Predisporre un flag in STATE per evitare notifiche duplicate.

### Rigenerare il file minificato
```bash
pip install rjsmin
python3 -c "
import rjsmin
with open('pompa_piscina.js') as f: src = f.read()
minified = rjsmin.jsmin(src)
with open('pompa_piscina.min.js', 'w') as f: f.write(minified)
print(len(minified), 'bytes')
"
```

> **Nota**: non usare `re.sub` per rimuovere i commenti prima di rjsmin — strippa anche il `//` dentro le stringhe (es. `"http://"` diventa `"http:"` causando SyntaxError). rjsmin gestisce i commenti correttamente da solo.
