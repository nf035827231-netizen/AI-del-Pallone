AI DEL PALLONE V175 — FINESTRA 3 ORE — ODDS-API.IO

FONTI
- Odds-API.io: calendario eventi + quote.
- Football-Data.org: risultati, classifica e ultime 3 partite.
- Nessun Odds-API.io.
- Nessun bridge Mac.

MODELLO
- Probabilità = classifica + ultime 3 partite.
- La quota NON entra nella probabilità.
- TOP 3: una sola proposta per partita, ordinate esclusivamente per probabilità.
- Quota massima 3,70.
- Mercati: 1X2, Over/Under 1.5/2.5/3.5, Goal/No Goal quando disponibili.
- Nessun Edge, ELO, Poisson, Monte Carlo o H2H.

VERCEL
ODDS_API_KEY=...
FOOTBALL_DATA_TOKEN=...
SUPABASE_URL=... (opzionale)
SUPABASE_SERVICE_ROLE_KEY=... (opzionale)

ODDS-API.IO
Base API: https://api.odds-api.io/v3
Flusso usato: /leagues -> /events -> /bookmakers -> /odds/multi.
Gli eventi vengono richiesti una sola volta come pending e filtrati localmente in una finestra rigida di 0–3 ore dall’istante della richiesta; gli eventi oltre 3 ore vengono scartati prima di richiedere le quote. I bookmaker accessibili vengono letti da /bookmakers e messi in cache per 1 ora. Le quote vengono raccolte con /odds/multi a blocchi di massimo 10 eventi, passando esplicitamente il parametro bookmakers richiesto da Odds-API.io.
Il piano/bookmaker configurato nella dashboard Odds-API.io determina quali quote sono disponibili.

FOOTBALL-DATA.ORG
Per ogni competizione usata dall'analisi viene richiesto il calendario fino alla data selezionata; classifica e ultime 3 vengono calcolate localmente dai risultati conclusi.

DEPLOY
1. Usa questo ZIP come nuova versione del progetto.
2. In Vercel imposta ODDS_API_KEY con la chiave presente nella dashboard Odds-API.io.
3. Mantieni FOOTBALL_DATA_TOKEN.
4. Non configurare bridge o credenziali di altri provider.
5. Redeploy e premi Aggiorna API nell'app.

FINESTRA TEMPORALE
- Analizza esclusivamente le partite che iniziano nelle prossime 3 ore.
- Gli eventi oltre le 3 ore non ricevono alcuna richiesta quote.
- La finestra viene calcolata sul timestamp reale della richiesta, in modo da scorrere automaticamente.

TEST RAPIDO
La chiave non va incollata in chat. Per verificare che sia attiva, usa dalla dashboard Odds-API.io la documentazione interattiva oppure una chiamata a /v3/leagues con la tua chiave.
