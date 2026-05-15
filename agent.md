# agent.md — Contesto per AI assistant

Questo file descrive l'architettura complessiva del monorepo `shelly-pool-controller` per assistenti AI. Per il contesto dettagliato del solo script Shelly, vedi `pool-controller-server/CLAUDE.md`.

---

## Panoramica del progetto

Sistema di controllo per piscina privata composto da due sottocomponenti:

| Componente | Percorso | Tecnologia | Target |
|------------|----------|------------|--------|
| Script controller | `pool-controller-server/` | mJS (Shelly) | Shelly Pro 2PM |
| App mobile/web | `pool-controller-client/` | Flutter/Dart | Web, Android, iOS |

Il componente server gira direttamente sull'hardware Shelly (microcontrollore embedded); il client è un'app Flutter che si connette al dispositivo tramite Shelly Cloud, LAN locale o API REST personalizzata.

---

## Repository structure

```
shelly-pool-controller/
├── README.md                        # Documentazione utente (root)
├── agent.md                         # Questo file
├── .gitmodules                      # Submodule pool-controller-client
├── .gitignore
│
├── pool-controller-server/          # Script Shelly (NON un submodule)
│   ├── CLAUDE.md                    # Contesto AI dettagliato per questo componente
│   ├── README.md                    # Documentazione utente completa (italiano)
│   ├── pompa_piscina.js             # Sorgente principale — MODIFICARE QUESTO
│   ├── pompa_piscina.min.js         # Minificato da caricare su Shelly (~16KB)
│   ├── sonda_temperatura.js         # Script per Shelly Plus 2PM
│   ├── test.js                      # Suite test Node.js (60+ casi)
│   ├── .env.example                 # Template variabili d'ambiente
│   ├── .env                         # Config locale (gitignored)
│   └── LICENSE                      # MIT
│
└── pool-controller-client/          # App Flutter (git submodule)
    ├── SETUP.md                     # Guida configurazione Firebase + Shelly
    ├── pubspec.yaml                 # Dipendenze Flutter
    ├── lib/
    │   ├── main.dart
    │   ├── app.dart
    │   ├── firebase_options.dart
    │   ├── core/services/           # ShellyService, WeatherService, SettingsService, TemperatureHistoryService
    │   ├── core/theme/              # Theming app
    │   ├── models/                  # PoolStatus, TemperatureRecord, WeatherData
    │   ├── providers/               # AuthProvider, PoolProvider, SettingsProvider
    │   └── screens/                 # LoginScreen, SettingsScreen, DashboardScreen
    ├── web/ android/ ios/           # Platform-specific files
    └── test/
```

> **Regola chiave**: `pool-controller-server/` è il codice sorgente della logica di controllo. `pool-controller-client/` è un git submodule che punta a `https://github.com/michelepra/pool-controller`. Non modificare il `.min.js` direttamente; rigenerarlo sempre dal sorgente.

---

## Componente 1: pool-controller-server

### Contesto hardware

Lo script gira su **Shelly Pro 2PM**, un relè intelligente con scripting mJS embedded:

- **Relè 0** → Pompa di filtrazione
- **Relè 1** → Trasformatore luci piscina
- **SW1 (input 0)** → 230V AC da P2 pompa di calore + uscita PUMP tControl (in parallelo)
- **SW2 (input 1)** → 230V AC da uscita LIGHT tControl
- **Shelly Plus 2PM** (dispositivo separato) → legge sonda temperatura, invia dati via HTTP

### Gerarchia di controllo (immutabile, in ordine di priorità)

```
1. SW1 attivo          →  pompa ON  (protegge la pompa di calore, assoluto)
2. Temp < 3°C          →  antigelo: pompa ON 5 min ogni ora
3. Modalità ON         →  pompa sempre ON
4. Modalità OFF        →  pompa OFF  (SW1 resta comunque prioritario)
5. Modalità EXTERNAL   →  pompa segue solo SW1; da app si puo' solo passare a OFF
6. Modalità AUTO       →  fasce orarie + temperatura acqua
```

### KV Store (persistenza tra riavvii)

```
pt_ip      →  IP Shelly Plus 2PM                        [obbligatorio]
pt_lat     →  latitudine (float stringa)                 [obbligatorio per meteo]
pt_lon     →  longitudine (float stringa)                [obbligatorio per meteo]
ext_off    →  "1" se EXTERNAL forzato OFF dall'app
pt_cal     →  calibOffset appreso (float stringa)
pt_mode    →  modo fascia oraria + timestamp Unix ("A9:1746969600"), scade 24h
pt_hourly  →  JSON array 24 slot (indice=ora, 0=dato non disponibile), medie orarie temperatura odierna
pt_day     →  giorno di riferimento di pt_hourly ("DD/MM"), resettato a mezzanotte
```

### Virtual Components (Pro 2PM, firmware >= 1.7.5)

```
enum:200   →  Modalita' pompa: AUTO | ON | OFF | EXTERNAL
number:200 →  Ingresso temperatura esterna (scrittura da sonda_temperatura.js)
text:200   →  Temperatura acqua display  es. "29.5 | Max: 30 | Min: 27"
text:201   →  Meteo corrente             es. "A: 32 U:45 V:15 TS: 27.8"
text:202   →  Previsioni domani          es. "A: 28 U:-- V:22 TS: 26.1"
```

Gli ID sono per-tipo: `enum:200` e `text:200` coesistono. Scrittura testo via `Text.Set` (non `VirtualComponent.Set`).

### Stima temperatura acqua (quando sensore non disponibile)

```
1. est = todayForecastTempMax * 0.65 + 8          (cap a waterTempMax=31)
2. est -= ASHRAE_evapRate * evapCorrScale * 0.1   (raffreddamento evaporativo)
3. est += calibOffset                              (appreso nightly, persiste su pt_cal)
```

L'EMA con alpha=0.03 (~8h di costante di tempo) smorza le variazioni rapide della temperatura aria.

### Cascade di fallback temperatura (6 livelli)

```
1. Sensore Plus 2PM via HTTP (fresco, < 1h)
2. Ultimo valore sensore (anche se stale)
3. Media oraria scorrevole del giorno (buffer circolare 30 letture)
4. Max giornaliero osservato
5. Stima meteo (Open-Meteo + ASHRAE + calibOffset)
6. Default sicuro: 15°C
```

### Fasce orarie (ottimizzate fotovoltaico, nessun avvio 22:00–08:00)

| Codice | Temp | Ore | Fasce |
|--------|------|-----|-------|
| A1 | < 15°C | 1h | 13–14 |
| A3 | 16–20°C | 3h | 09–10, 12–13, 15–16 |
| A6 | 21–25°C | 6h | 08–09, 11–15, 16–17 |
| A9 | 26–30°C | 9h | 08–10, 12–17, 17–19 |
| A13 | > 31°C | 13h | 08–21 continuo |

### API esterna: Open-Meteo

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=<pt_lat>&longitude=<pt_lon>
  &current=temperature_2m,relative_humidity_2m,wind_speed_10m
  &daily=temperature_2m_max,wind_speed_10m_max
  &forecast_days=2&timezone=auto
```

Chiamata ogni 15 minuti. Nessuna API key richiesta.

### Limitazioni piattaforma mJS

- Memoria script: 25KB totali (codice + runtime); minificato ~16KB
- KV store: max 50 chiavi, chiave max 42 char, valore max 253 char
- No Promises/async: tutto tramite callback
- No function hoisting: dichiarare prima di usare
- No Unicode nei print e nelle stringhe KV
- HTTP.GET timeout: 5 secondi

### Test

```bash
cd pool-controller-server
cp .env.example .env   # compilare PLUS_2PM_IP, POOL_LAT, POOL_LON
node test.js
```

Framework custom inline, 60+ casi. Copre: bootstrap KV, retry HTTP, cascade fallback, gerarchia priorita', fasce orarie, calibrazione, statistiche giornaliere, virtual components, override manuale AUTO, contatori runtime pompa, testo text:203.

**Regola obbligatoria**: dopo ogni modifica a `pompa_piscina.js` eseguire `node test.js`. Tutti i test devono passare. Ogni nuova feature o comportamento modificato deve essere coperto da almeno un test prima di considerare la modifica completa.

### Minificazione

```bash
pip install rjsmin
python3 -c "
import rjsmin
with open('pompa_piscina.js') as f: src = f.read()
with open('pompa_piscina.min.js', 'w') as f: f.write(rjsmin.jsmin(src))
print('Done')
"
```

> Non usare `re.sub` per strippar commenti prima di rjsmin: rimuoverebbe anche `//` dentro le stringhe (es. `"http://"` → `"http:"`), causando SyntaxError.

---

## Componente 2: pool-controller-client

App Flutter (git submodule da `https://github.com/michelepra/pool-controller`).

### Modalita' di connessione a Shelly

| Modalita' | Descrizione |
|-----------|-------------|
| Shelly Cloud | Consigliata per accesso remoto; usa API cloud Shelly |
| LAN locale | HTTP diretto all'IP del Pro 2PM (stessa rete) |
| Backend REST | API personalizzata (vedere schema sotto) |

### Schema API backend personalizzato

```
GET  /api/status                  →  PoolStatus JSON
POST /api/pump        {on: bool}  →  controllo pompa
POST /api/lights      {on: bool}  →  controllo luci
POST /api/audio       {on: bool}  →  controllo audio
POST /api/extlight    {on: bool}  →  luce esterna
POST /api/mode      {mode: str}   →  modalita' (AUTO/EXTERNAL)
GET  /api/temperature/history     →  [{timestamp, value}]
GET  /api/weather                 →  WeatherData JSON
```

### Mappatura Shelly → app

**Shelly Pro 2PM**

| Component | Funzione |
|-----------|----------|
| switch:0 | Pompa filtrazione |
| switch:1 | Luci piscina |
| input:0 (SW1) | Segnale pdc/tControl |
| input:1 (SW2) | Segnale luci tControl |
| enum:200 | Modalità pompa |
| text:200 | Temperatura acqua + min/max odierni |
| KVS pt_hourly | Array 24 slot medie orarie temperatura |
| KVS pt_day | Giorno di riferimento ("DD/MM") |

**Shelly Plus 2PM**

| Component | Funzione |
|-----------|----------|
| switch:0 | Luce esterna |
| switch:1 | Impianto audio |
| input:0 | Switch fisico luce esterna |
| input:1 | Switch fisico audio |
| temperature:101 | Temperatura locale tecnico |
| temperature:102 | Temperatura ambiente |

### Dipendenze principali

```yaml
firebase_core: ^2.27.1
firebase_auth: ^4.19.4
flutter_riverpod: ^2.5.1
dio: ^5.4.3+1
fl_chart: ^0.67.0
shared_preferences: ^2.2.3
flutter_dotenv: ^5.2.1
intl: ^0.19.0
```

### Dashboard widgets

1. **TemperatureCard** — temperatura acqua + grafico andamento orario odierno (da `pt_hourly`/`pt_day` del KV store Pro 2PM); se il giorno non corrisponde mostra solo temperatura corrente
2. **PumpCard** — stato pompa + indicatore SW1
3. **ModeCard** — AUTO/EXTERNAL + fascia oraria attiva
4. **LightsCard** — luci + indicatore SW2
5. **ExtrasCard** — audio + luce esterna
6. **EnvironmentCard** — temperatura locale e ambiente
7. **WeatherCard** — meteo corrente + previsioni orarie

### Setup

```bash
cd pool-controller-client
flutter pub get
# Configurare Firebase: vedi SETUP.md
flutter run -d chrome        # web
flutter run                  # mobile
flutter build web            # build produzione web
```

---

## Interazione tra i due componenti

```
sonda_temperatura.js (Plus 2PM)
  └─ ogni cambio temp:100
      └─ HTTP POST → Pro 2PM Number.Set (number:200)
          └─ pompa_piscina.js aggiorna STATE.lastSondaTime

App Flutter
  └─ legge enum:200, text:200/201/202 via Shelly API
  └─ scrive enum:200 per cambiare modalita'
  └─ scrive switch:0/1 per controllo diretto

SW1 (230V fisico)
  └─ evento input:0 → evaluatePump() con priorita' assoluta
```

---

## Decisioni architetturali rilevanti

- **SW1 sempre prioritario**: protegge il compressore della pdc da thermal runaway; non bypassabile da software.
- **Calibrazione adattiva**: il sistema impara la deriva della formula di stima locale nel tempo (alpha=0.1, cap ±8°C), senza richiedere intervento manuale.
- **EXTERNAL forced-off persiste su KV**: sopravvive ai riavvii del dispositivo; si resetta solo al rising edge di SW1 (segnale hardware).
- **Fasce orarie stateless**: il modo (A1..A13) viene determinato dalla temperatura media del giorno precedente a mezzanotte e persiste 24h su KV (`pt_mode`).
- **Niente async/await**: il firmware mJS non supporta Promises; tutta la logica asincrona e' tramite callback concatenate.
- **Submodule per il client**: il client e' sviluppato in un repo separato e incluso come submodule; aggiornare con `git submodule update --remote`.
