AI DEL PALLONE — V6.3 v127

FILE AGGIORNATO:
- api/pick.mjs

MODIFICHE:
- P_model indipendente dalle quote Betfair.
- Nessun fallback automatico a 95% o 50% come probabilità forte.
- Shrinkage della probabilità verso 50% in funzione del campione storico.
- Frequenza e prediction API usate come validazione/context, non per generare direttamente P_model.
- Edge calcolato solo sulla probabilità calibrata e su quota valida.
- Scenari senza modello statistico di base non possono ottenere un TOP artificiale.
- Penalizzazione esplicita per campioni piccoli.
- Diagnostica: probabilitySource, modelSample, calibrationReliability, modelReady.

FILE INVARIATI:
- index.html
- api/betfair-sync.mjs
- api/betfair-odds.mjs
- api/betfair-status.mjs
- api/closing-odds.mjs
- api/settle-bet.mjs
- api/config.mjs
- api/team-logo.mjs
- asset/loghi/icone/documentazione

BRIDGE:
- NON MODIFICATO.
