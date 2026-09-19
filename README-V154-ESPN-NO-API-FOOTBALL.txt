AI DEL PALLONE – V154 ESPN NO API-FOOTBALL

PERCHÉ V154
V153 usava API-Football come fonte primaria e quindi si bloccava quando il piano giornaliero terminava.
V154 elimina completamente API-Football dal percorso principale.

ARCHITETTURA
1. ESPN – calendario, stato partita, classifica e ultime 3 partite.
   - Nessuna API key.
   - Serie A = ita.1
   - Serie B = ita.2
   - Premier League = eng.1
   - La Liga = esp.1
   - Bundesliga = ger.1
   - Ligue 1 = fra.1
   - Primeira Liga = por.1
   - Eredivisie = ned.1
   - altri campionati europei mappati in api/pick.mjs
2. Betfair Exchange via Supabase – SOLO quote BACK.
   - massimo quota 3,70
   - quote vecchie accettate
   - la quota NON entra nella probabilità
3. MODELLO
   - classifica + ultime 3 partite
   - niente Edge
   - niente ELO
   - niente Monte Carlo
   - niente Dixon-Coles
   - niente H2H
   - TOP ordinato solo per probabilità
   - massimo 3 scenari visualizzati dal frontend

OTTIMIZZAZIONE API
Per ogni campionato V154 usa una chiamata ESPN per il blocco calendario/storico recente e una per la classifica.
Le ultime 3 vengono estratte dallo stesso blocco storico: non vengono fatte 2 chiamate per ogni squadra.
Il risultato viene tenuto in cache server-side.

IMPORTANTE
V154 non richiede più API_FOOTBALL_KEY.
Puoi lasciarla nelle variabili Vercel, ma non viene letta da /api/pick.

VARIABILI NECESSARIE
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

VARIABILI NON NECESSARIE PER IL PICK
- API_FOOTBALL_KEY
- FOOTBALL_DATA_TOKEN
- ODDS_API_KEY

BETFAIR
La sincronizzazione Betfair/Supabase resta invariata. Betfair è usata solo per le quote.

DIAGNOSTICA
/api/pick restituisce diagnostics con:
- espn-config
- espn per campionato
- prematch-gate
- betfair-exchange
- betfair-pool
- v154-model

Se TOP è vuoto, il pannello diagnostico indica se il problema è il calendario ESPN, il matching Betfair o l'assenza di quote BACK <= 3,70.
