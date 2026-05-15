# Shelly Pool Pump Controller

Controllo automatico della pompa piscina tramite **Shelly Pro 2PM**, con stima della temperatura acqua via Open-Meteo, integrazione con pompa di calore e centralina tControl, ottimizzazione per impianto fotovoltaico.

---

## Indice

- [Panoramica](#panoramica)
- [Hardware richiesto](#hardware-richiesto)
- [Schema di cablaggio](#schema-di-cablaggio)
- [Struttura del progetto](#struttura-del-progetto)
- [Configurazione](#configurazione)
- [Logica di funzionamento](#logica-di-funzionamento)
- [KV Store](#kv-store)
- [Virtual Components](#virtual-components)
- [Installazione](#installazione)
- [Manutenzione](#manutenzione)

---

## Panoramica

Il sistema sostituisce la logica di controllo temporizzata della centralina **tControl** con uno script intelligente che:

- Riceve la **temperatura reale** dell'acqua dalla sonda digitale collegata al Plus 2PM, che la trasmette via rete tramite lo script `sonda_temperatura.js`
- In assenza di aggiornamenti dalla sonda (> 1 ora), esegue lettura diretta via HTTP come fallback
- Stima la temperatura acqua da **Open-Meteo** (gratuito, no API key) quando nessun sensore è disponibile
- Gestisce la pompa in base a **fasce orarie ottimizzate per il fotovoltaico** (nessun avvio tra le 22:00 e le 08:00)
- Replica la **logica automatica del tControl** (ore di filtraggio proporzionali alla temperatura)
- Mantiene la compatibilità con i segnali hardware esistenti (P2 della pdc e uscita pump del tControl)
- Implementa la funzione **antigelo** autonoma

---

## Hardware richiesto

| Dispositivo | Ruolo |
|-------------|-------|
| **Shelly Pro 2PM** | Controllo pompa (canale 0) e luci piscina (canale 1), script principale |
| **Shelly Plus 2PM** | Lettura sonda temperatura digitale, invio al Pro 2PM via rete |
| **Sonda temperatura digitale** | Misurazione temperatura acqua (component `temperature:100`) |
| **Pompa di calore Mr. Smart** | Gestione termica piscina, segnale P1/P2 |
| **Centralina tControl 1** | Gestione filtrazione/illuminazione esistente |

### Canali Shelly Pro 2PM

| Canale | Funzione |
|--------|----------|
| **Relè 0 (O1)** | Pompa filtrazione |
| **Relè 1 (O2)** | Trasformatore luci piscina |
| **SW1** | Ingresso P2 pdc + uscita pump tControl (parallelo) |
| **SW2** | Uscita luci tControl |

---

## Schema di cablaggio

```
Fase L ──────┬───── P1 (pdc Mr. Smart)
             │              │
             │             P2 ────┐
             │                    ├──── SW1 Shelly Pro 2PM → Relè 0 → Pompa
             └── tControl PUMP ───┘

Fase L ──── tControl LIGHT 230V ──── SW2 Shelly Pro 2PM → Relè 1 → Trafo luci

Sonda digitale ──── Shelly Plus 2PM (temperature:100)
                           │
                    [rete locale]
                           │
                    Shelly Pro 2PM ← number:200 (valore temperatura)
```

### Note cablaggio

- **P2 della pdc** e **uscita PUMP del tControl** sono collegati in parallelo su SW1: entrambi portano 230V AC quando attivi
- La sonda digitale è fisicamente collegata al Plus 2PM; il valore viene trasmesso via HTTP ogni volta che cambia
- Il Plus 2PM e il Pro 2PM devono essere sulla stessa rete locale con IP fissi

---

## Struttura del progetto

```
/
├── README.md                   # Questo file
├── CLAUDE.md                   # Contesto per AI assistant
├── pompa_piscina.js            # Script sorgente Pro 2PM (sviluppo)
├── pompa_piscina.min.js        # Script minificato Pro 2PM (da caricare)
└── sonda_temperatura.js        # Script sorgente Plus 2PM (sviluppo e carico)
```

---

## Configurazione

### 1. Impostare SW1 in modalità Detached (Pro 2PM)

Lo script deve gestire autonomamente il Relè 0. Se SW1 rimane in modalità attached, quando il segnale P2/tControl si disattiva il relè si spegne via hardware, bypassando la logica di fasce orarie, modalità ON e antigelo.

**Settings → Input/Output → Input 0 → modalità Detached**

Oppure via API:
```bash
curl -X POST -d '{"id":1,"method":"Switch.SetConfig","params":{"id":0,"config":{"in_mode":"detached"}}}' http://<IP-PRO-2PM>/rpc
```

> SW2 → Relè 1 (luci) può rimanere in modalità attached per il controllo diretto hardware.

### 2. Creare i Virtual Components (Pro 2PM)

Dall'interfaccia web del Pro 2PM → **Virtual Components**:

| ID | Tipo | Nome | Note |
|----|------|------|------|
| 200 | Enum | Modalità Pompa | Valori: `AUTO`, `ON`, `OFF`, `EXTERNAL` — default: `AUTO` |
| 200 | Number | Temperatura Sonda | Scrittura esterna da `sonda_temperatura.js` via `Number.Set` |
| 200 | Text | Temperatura Acqua | Sola lettura, aggiornato dallo script |
| 201 | Text | Meteo Attuale | Sola lettura, aggiornato ogni 15 min |
| 202 | Text | Previsioni Domani | Sola lettura, aggiornato ogni 15 min |
| 203 | Text | Fascia Oraria | Sola lettura: runtime pompa oggi, energia kWh, ore target fascia |

> **Nota firmware ≥ 1.7.5**: gli ID sono per-tipo — `enum:200`, `number:200` e `text:200` coesistono senza conflitti.

### 3. Impostare il KV Store (Pro 2PM)

```
Percorso: Advanced → KV Storage → Add value
```

| Chiave | Valore |
|--------|--------|
| `pt_ip` | `192.168.x.x` — IP fisso del Plus 2PM |
| `pt_lat` | latitudine della posizione (es. `00.00`) |
| `pt_lon` | longitudine della posizione (es. `00.00`) |

Trovare latitudine e longitudine su [open-meteo.com](https://open-meteo.com) oppure da Google Maps (click destro sulla posizione → "Che cosa c'è qui?").

> Assegnare un IP fisso al Plus 2PM nel router prima di configurare `pt_ip`. Se non si usa la lettura diretta HTTP come fallback, `pt_ip` è facoltativo ma `pt_lat`/`pt_lon` sono sempre necessari per i dati meteo.

### 4. Caricare lo script sul Pro 2PM

Dall'interfaccia web del Pro 2PM → **Scripts** → **Create script**:

1. Incollare il contenuto di `pompa_piscina.min.js`
2. Salvare con nome `pompa_piscina`
3. Abilitare **Run on startup**
4. Avviare lo script

### 5. Configurare il Plus 2PM (sonda_temperatura.js)

Impostare l'IP del Pro 2PM nel KV Store del Plus 2PM:

```
Chiave:   pro_ip
Valore:   192.168.x.x   ← IP fisso del Pro 2PM
```

Caricare lo script sul Plus 2PM → **Scripts** → **Create script**:

1. Incollare il contenuto di `sonda_temperatura.js`
2. Salvare con nome `sonda_temperatura`
3. Abilitare **Run on startup**
4. Avviare lo script

---

## Logica di funzionamento

### Gerarchia di priorità (dalla più alta)

```
1. SW1 attivo (P2 pdc o tControl pump)  →  pompa ON  [sempre, salvo extForcedOff]
2. Antigelo (temperatura < 3°C)          →  pompa ON per 5 min ogni ora
3. Modalità ON  (da app)                 →  pompa ON
4. Modalità OFF (da app)                 →  pompa OFF
5. Modalità EXTERNAL                     →  pompa segue solo SW1
6. Modalità AUTO                         →  fasce orarie + temperatura
```

> **Sicurezza pdc**: SW1 è sempre prioritario anche in modalità OFF. Se la pompa di calore richiede acqua tramite P2, la pompa si avvia indipendentemente dalla modalità impostata, proteggendo il compressore dal surriscaldamento.

### Modalità EXTERNAL

In modalità EXTERNAL la pompa segue esclusivamente lo stato di SW1 (segnale esterno da pdc/tControl), ignorando fasce orarie e temperatura.

**Spegnimento da app in modalità EXTERNAL**: se la pompa è accesa (SW1 attivo) e si imposta la modalità OFF dall'app, viene attivato un blocco persistente (`ext_off` nel KV store). La pompa resta spenta anche se SW1 rimane attivo, finché SW1 non riceve un nuovo impulso di accensione (fronte di salita OFF→ON). Al nuovo impulso la modalità torna automaticamente a EXTERNAL. Il blocco sopravvive al riavvio dello Shelly.

### Fasce orarie AUTO (ottimizzate per fotovoltaico)

Nessun avvio tra le 22:00 e le 08:00. Stesse ore totali del tControl, redistribute in orario solare.

| Temperatura acqua | Ore/giorno | Fasce orarie |
|-------------------|-----------|--------------|
| < 15°C | 1 ora | 13:00–14:00 |
| 16–20°C | 3 ore | 09–10, 12–13, 15–16 |
| 21–25°C | 6 ore | 08–09, 11–15, 16–17 |
| 26–30°C | 9 ore | 08–10, 12–17, 17–19 |
| > 31°C | 13 ore | 08:00–21:00 (continuo) |

La fascia oraria applicata è determinata dalla **media giornaliera** della temperatura, calcolata durante la giornata precedente e salvata a mezzanotte nel KV store (`pt_mode`).

### Temperatura effettiva (cascata di fallback)

```
1. Sonda digitale via numero:200        (evento da sonda_temperatura.js)
2. Lettura HTTP diretta dal Plus 2PM    (fallback se nessun evento per > 1 ora)
3. Ultima lettura nota                  (anche se vecchia)
4. Media o massimo odierno              (da letture precedenti della giornata)
5. Stima da Open-Meteo                  (formula EMA + correzione evaporativa)
6. Sicurezza assoluta: 15°C             (garantisce 1 ora minima di filtraggio)
```

### Stima temperatura acqua (Open-Meteo)

Quando il sensore non è disponibile la temperatura viene stimata con:

```
T_acqua = T_max_prevista_oggi × waterTempFactor + waterTempOffset
```

- `T_max_prevista_oggi`: temperatura massima giornaliera prevista da Open-Meteo (`daily.temperature_2m_max[0]`)
- La temperatura ambientale EMA (costante ~8h) viene tenuta in parallelo ma non entra direttamente nella formula
- Correzione evaporativa tramite formula ASHRAE in base a umidità e vento
- Calibrazione automatica: ogni notte confronta il massimo misurato con la stima e aggiusta l'offset (±8°C max, salvato in `pt_cal`)

I dati meteo (temperatura, umidità, vento, previsioni) sono aggiornati ogni 15 minuti da Open-Meteo (gratuito, no API key).

### Invio temperatura (sonda_temperatura.js)

Lo script sul Plus 2PM ascolta gli eventi di cambio valore della sonda digitale (`temperature:100`) e invia il nuovo valore al Pro 2PM via `Number.Set`. In caso di errore HTTP ritenta ogni 5 secondi fino a 10 volte; se arriva un nuovo valore prima che i retry siano esauriti, il retry precedente viene annullato e si invia il valore aggiornato.

---

## KV Store

Lo script usa fino a 9 chiavi KV (limite dispositivo: 50 chiavi).

| Dispositivo | Chiave | Contenuto | Obbligatoria | Esempio |
|-------------|--------|-----------|:---:|---------|
| Pro 2PM | `pt_ip` | IP del Plus 2PM | — | `192.168.1.100` |
| Pro 2PM | `pt_lat` | Latitudine posizione | ✓ | `00.00` |
| Pro 2PM | `pt_lon` | Longitudine posizione | ✓ | `00.00` |
| Pro 2PM | `ext_off` | Blocco EXTERNAL da app | — | `1` (attivo) / `0` |
| Pro 2PM | `pt_cal` | Offset calibrazione stima temperatura | — | `1.2` |
| Pro 2PM | `pt_mode` | Fascia oraria corrente + timestamp | — | `A9:1748000000` |
| Pro 2PM | `pt_hourly` | Medie orarie temperatura odierna (JSON array 24 slot) | — | `[0,0,...,28.3,28.7,0,...]` |
| Pro 2PM | `pt_day` | Giorno di riferimento di `pt_hourly` ("DD/MM") | — | `15/05` |
| Plus 2PM | `pro_ip` | IP del Pro 2PM | ✓ | `192.168.1.101` |

> Le chiavi `ext_off`, `pt_cal`, `pt_mode`, `pt_hourly` e `pt_day` sono gestite automaticamente dallo script e non richiedono impostazione manuale. `pt_ip` è facoltativo: senza di esso lo script funziona ma non può leggere la temperatura via HTTP diretto (si affida agli eventi da `sonda_temperatura.js`).

---

## Virtual Components

### enum:200 — Modalità Pompa

Controllabile dall'app Shelly o via API:

```
AUTO      →  Script gestisce automaticamente in base a temperatura e orari
ON        →  Pompa sempre accesa (SW1 resta prioritario)
OFF       →  Pompa sempre spenta (SW1 resta prioritario per sicurezza pdc)
EXTERNAL  →  Pompa segue solo SW1; da app si può solo imporre lo spegnimento
```

### number:200 — Temperatura Sonda (ingresso)

Scritto da `sonda_temperatura.js` sul Plus 2PM ad ogni cambio di valore del sensore:

```bash
# Formato chiamata (eseguita dallo script, non manualmente)
POST http://<IP-PRO-2PM>/rpc/Number.Set
{ "id": 200, "value": 28.5 }
```

### text:200 — Temperatura Acqua

Aggiornato ad ogni nuova lettura:

```
29.5 | Max: 30.1 | Min: 27.3
```

Se la lettura dal sensore non è disponibile, la temperatura stimata appare tra `<>`:

```
<28.3> | Max: -- | Min: --
```

### text:201 — Meteo Attuale

Aggiornato ogni 15 minuti con i dati Open-Meteo:

```
A: 32 U:45 V:15 TS: 27.8
```

| Campo | Descrizione |
|-------|-------------|
| `A` | Temperatura aria attuale (°C) |
| `U` | Umidità relativa (%) |
| `V` | Velocità vento (km/h) |
| `TS` | Temperatura acqua stimata |

### text:202 — Previsioni Domani

```
A: 28 U:-- V:22 TS: 26.1
```

| Campo | Descrizione |
|-------|-------------|
| `A` | Temperatura aria massima prevista domani (°C) |
| `U` | Non disponibile da Open-Meteo nelle previsioni giornaliere |
| `V` | Velocità vento massima prevista (km/h) |
| `TS` | Temperatura acqua stimata per domani |

### text:203 — Fascia Oraria

Aggiornato ogni 60 secondi con il consuntivo della giornata in corso:

```
3h25m | 1.2 Kwh | 9h
```

| Campo | Descrizione |
|-------|-------------|
| `Xh YYm` | Tempo totale di funzionamento pompa oggi (sessioni completate + sessione in corso) |
| `Z.Z Kwh` | Energia consumata oggi dal relè 0 (delta dal PM integrato); `--` se dato non disponibile |
| `Wh` | Ore target della fascia oraria attiva (es. `9h` per A9); `--` se non ancora determinata |

---

## Installazione

### Prerequisiti

- Shelly Pro 2PM con firmware ≥ 1.7.5
- Shelly Plus 2PM con sonda temperatura digitale (component `temperature:100`)
- IP fissi assegnati a entrambi i dispositivi nel router

### Procedura rapida

```
1. Pro 2PM — SW1 → modalità Detached
2. Pro 2PM — Creare Virtual Components: enum:200, number:200, text:200, text:201, text:202, text:203
3. Pro 2PM — KV Store: pt_ip = <IP Plus 2PM>
               pt_lat = <latitudine>
               pt_lon = <longitudine>
4. Pro 2PM — Caricare pompa_piscina.min.js, abilitare Run on startup
5. Plus 2PM — KV Store: pro_ip = <IP Pro 2PM>
6. Plus 2PM — Caricare sonda_temperatura.js, abilitare Run on startup
```

### Rigenerare il minificato

```bash
pip install rjsmin
python3 -c "
import rjsmin
with open('pompa_piscina.js') as f: src = f.read()
with open('pompa_piscina.min.js', 'w') as f: f.write(rjsmin.jsmin(src))
"
```

---

## Manutenzione

### Verificare lo stato degli script

```bash
# Pro 2PM
curl "http://<IP-PRO-2PM>/rpc/Script.GetStatus?id=1"

# Plus 2PM
curl "http://<IP-PLUS-2PM>/rpc/Script.GetStatus?id=1"
```

### Leggere i valori KV via API

```bash
# IP Plus 2PM configurato
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_ip"

# Coordinate configurate
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_lat"
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_lon"

# Offset calibrazione
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_cal"

# Fascia oraria corrente (scade dopo 24h)
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_mode"

# Stato blocco EXTERNAL
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=ext_off"

# Storico orario odierno (array 24 slot)
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_hourly"
curl "http://<IP-PRO-2PM>/rpc/KVS.Get?key=pt_day"
```

### Storico temperature orarie

Lo script mantiene in `pt_hourly` un array JSON di 24 elementi (indice = ora, 0 = nessun dato per quell'ora) con la media delle temperature rilevate ora per ora. Il campo `pt_day` contiene il giorno di riferimento nel formato `"DD/MM"`.

Questi dati vengono resettati automaticamente a mezzanotte e ripristinati dalla KV in caso di riavvio del dispositivo. L'app Flutter legge entrambi i valori e, se `pt_day` corrisponde alla data odierna, mostra un grafico con l'andamento della temperatura nelle ore già completate.

### Resettare il blocco EXTERNAL manualmente

Se lo Shelly non risponde al segnale SW1 dopo uno spegnimento da app in modalità EXTERNAL:

```bash
curl -X POST -d '{"id":1,"method":"KVS.Set","params":{"key":"ext_off","value":"0"}}' http://<IP-PRO-2PM>/rpc
```

Poi riavviare lo script.

### Log in tempo reale

Dall'interfaccia web: **Scripts** → click sullo script → **Console**

### Calibrare la stima temperatura

La calibrazione avviene automaticamente ogni notte confrontando il massimo misurato dalla sonda con la stima calcolata. L'offset viene aggiornato del 10% dell'errore e salvato in `pt_cal`.

Per una calibrazione manuale:

```bash
curl -X POST -d '{"id":1,"method":"KVS.Set","params":{"key":"pt_cal","value":"2.5"}}' http://<IP-PRO-2PM>/rpc
```

---

## Licenza

MIT
