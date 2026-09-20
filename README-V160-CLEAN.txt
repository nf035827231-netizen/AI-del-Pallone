AI DEL PALLONE – V160 CLEAN

OBIETTIVO
La V159 poteva trovare le partite ma scartarle prima dell'analisi per problemi di matching Betfair,
catalogo incompleto e una catena di provider troppo lunga. V160 riduce il percorso a due fonti.

ARCHITETTURA
1. ESPN – calendario, stato, classifica e ultime 3 partite.
   - Nessuna API key.
   - Una chiamata scoreboard per campionato copre la giornata scelta + 28 giorni precedenti.
   - La classifica viene richiesta solo per i campionati che hanno almeno una partita pre-match.
   - Nessun Football-Data.org.
   - Nessun API-Football.
2. Betfair Exchange via Supabase – SOLO quote BACK.
   - Il bridge sincronizza MATCH_ODDS + OVER_UNDER_25 + OVER_UNDER_35.
   - I market book vengono sincronizzati a blocchi da 40.
   - Il motore legge gli ultimi cataloghi e l'ultimo book per marketId.
   - Il matching ESPN ↔ Betfair usa nomi normalizzati, alias comuni e fuzzy matching.
   - Le quote vecchie non vengono scartate solo per età.

MODELLO
- Classifica + ultime 3 partite.
- Nessun Edge.
- Nessun ELO.
- Nessun Monte Carlo.
- Nessun Dixon-Coles.
- Nessun H2H.
- La quota NON entra nella probabilità.
- Quota massima 3,70.
- Una sola proposta per partita.
- TOP 3 ordinato esclusivamente per probabilità stimata.

MERCATI
- 1X2
- Over 2.5 / Under 2.5
- Over 3.5 / Under 3.5

API E QUOTA
Il Pick usa ESPN senza chiave e Betfair per le quote. API-Football non viene chiamata dal percorso Pick.
Le variabili indispensabili per il backend Pick sono:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

Il bridge richiede invece le credenziali Betfair già usate nelle versioni precedenti e invia i dati a
/api/betfair-sync tramite BETFAIR_BRIDGE_TOKEN.

DIAGNOSTICA
/api/pick restituisce:
- espn-scoreboard per ogni campionato
- prematch-gate
- espn-standings solo per i campionati attivi
- betfair-exchange
- betfair-matching con elenco delle partite non riconosciute e motivo
- v160-model
- no-candidates-debug quando il TOP è vuoto

Se il risultato è "27 partite · 0 quotate", il problema è ora identificabile direttamente:
- evento Betfair non riconosciuto
- Betfair presente ma nessuna BACK <= 3,70
- oppure nessun mercato richiesto sincronizzato.

LIMITI REALI
Non viene inventata una terza partita se non esistono almeno tre partite reali pre-match con una quota
Betfair compatibile. L'algoritmo però non scarta più una gara solo perché la quota è vecchia.
