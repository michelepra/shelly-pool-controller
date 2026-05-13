# Shelly Pool Controller

Sistema di controllo intelligente per la pompa di filtrazione di una piscina privata, basato su **Shelly Pro 2PM**. Integra una pompa di calore, una centralina tControl, un sensore di temperatura digitale e un impianto fotovoltaico, con un'app mobile/web Flutter per il controllo remoto.

---

## Struttura del repository

```
shelly-pool-controller/
├── pool-controller-server/   # Script mJS per Shelly Pro 2PM (cervello del sistema)
└── pool-controller-client/   # App Flutter (mobile/web) per il controllo remoto
```

---

## Componenti

### [pool-controller-server](./pool-controller-server/)

Script **mJS** eseguito direttamente sul **Shelly Pro 2PM**. Implementa:

- Gerarchia di controllo a 6 livelli (SW1 > Antigelo > ON > OFF > EXTERNAL > AUTO)
- Fasce orarie ottimizzate per il fotovoltaico (nessun avvio tra 22:00 e 08:00)
- Stima della temperatura dell'acqua con modello ASHRAE + calibrazione adattiva notturna
- Recupero dati meteo da Open-Meteo (gratuito, senza API key)
- Integrazione con Shelly Plus 2PM per la lettura della sonda temperatura
- Virtual Components per la visualizzazione in app (temperatura, meteo, modalità)

**File principali:**

| File | Descrizione |
|------|-------------|
| `pompa_piscina.js` | Sorgente completo e commentato — modificare questo |
| `pompa_piscina.min.js` | Versione minificata da caricare su Shelly (~16KB) |
| `sonda_temperatura.js` | Script per Shelly Plus 2PM (forwarding temperatura) |
| `test.js` | Suite di test Node.js (60+ casi) |
| `README.md` | Documentazione completa utente |

Vedi [pool-controller-server/README.md](./pool-controller-server/README.md) per istruzioni di installazione, configurazione hardware e cablaggio.

---

### [pool-controller-client](./pool-controller-client/)

App **Flutter** multipiattaforma (Web, Android, iOS) per il controllo remoto del sistema. Funzionalità:

- Dashboard con 7 widget: temperatura, pompa, luci, extras, meteo, previsioni
- Grafico storico temperatura (7 giorni)
- Gestione modalità pompa (AUTO / ON / OFF / EXTERNAL)
- Supporto Shelly Cloud, LAN locale o backend REST personalizzato
- Autenticazione Firebase

Vedi [pool-controller-client/SETUP.md](./pool-controller-client/SETUP.md) per la guida alla configurazione Firebase e Shelly.

---

## Architettura hardware

```
                        ┌─────────────────────┐
                        │   Shelly Pro 2PM    │  ← cervello del sistema
                        │                     │
 P2 pdc (230V) ────────►│ SW1   Relè 0 ──────►│ Pompa filtrazione
 PUMP tControl ────────►│                     │
                        │       Relè 1 ──────►│ Trasformatore luci
 LIGHT tControl ───────►│ SW2                 │
                        └─────────┬───────────┘
                                  │ HTTP (LAN)
                        ┌─────────▼───────────┐
                        │  Shelly Plus 2PM    │  ← sensore temperatura
                        │  + Digital Sensor   │
                        └─────────────────────┘
```

**Dispositivi coinvolti:**

| Dispositivo | Ruolo |
|-------------|-------|
| Shelly Pro 2PM | Controller principale, esegue `pompa_piscina.js` |
| Shelly Plus 2PM + Add-on | Lettura sonda temperatura, esegue `sonda_temperatura.js` |
| Pompa di calore Mr. Smart (Aquark) | Segnale P1/P2 a 230V AC su SW1 |
| Centralina tControl 1 | Uscite PUMP e LIGHT 230V su SW1/SW2 |
| Impianto fotovoltaico | Ottimizzazione fasce orarie |

---

## Fasce orarie (ottimizzate per fotovoltaico)

| Temp acqua | Ore/giorno | Fasce attive |
|------------|-----------|--------------|
| < 15°C | 1h | 13:00–14:00 |
| 16–20°C | 3h | 09–10, 12–13, 15–16 |
| 21–25°C | 6h | 08–09, 11–15, 16–17 |
| 26–30°C | 9h | 08–10, 12–17, 17–19 |
| > 31°C | 13h | 08:00–21:00 continuo |

---

## Requisiti

- **Shelly Pro 2PM** con firmware >= 1.7.5
- **Shelly Plus 2PM** con Add-on e sonda temperatura digitale
- Rete LAN con IP statici per entrambi i dispositivi
- Per l'app: Flutter SDK >= 3.2.0, progetto Firebase

---

## Sviluppo rapido

```bash
# Clona il repo con i submodule
git clone --recurse-submodules https://github.com/michelepra/shelly-pool-controller

# Esegui i test dello script Shelly
cd pool-controller-server
node test.js

# Rigenera il file minificato dopo modifiche
pip install rjsmin
python3 -c "
import rjsmin
with open('pompa_piscina.js') as f: src = f.read()
with open('pompa_piscina.min.js', 'w') as f: f.write(rjsmin.jsmin(src))
"

# Avvia l'app Flutter
cd ../pool-controller-client
flutter run -d chrome
```

---

## Licenza

MIT — vedi [pool-controller-server/LICENSE](./pool-controller-server/LICENSE).
