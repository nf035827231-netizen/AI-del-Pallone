AI DEL PALLONE V153 – API REBOOT

Architettura semplificata:
- API-Football = fonte primaria per calendario, stato pre-match, squadre e competizioni.
- API-Football /standings = classifica corrente, una chiamata per campionato/stagione.
- API-Football /fixtures?team=...&last=3 = ultime 3 esatte per le squadre che hanno una quota Betfair valida; per eventuali squadre oltre il limite prudenziale viene usata la forma W/D/L degli standings.
- Betfair Exchange via Supabase = unica fonte delle quote BACK.
- Odds-API.io NON viene più usata per scoprire le partite.
- football-data.org NON viene più usata per calendario, classifica o storico.

MODELLO
- Solo classifica + ultime 3.
- Nessun Edge.
- Nessun ELO.
- Nessun Monte Carlo.
- Nessun Dixon-Coles.
- Nessun H2H.
- Nessuna quota nel calcolo della probabilità.
- Quota Betfair solo come filtro massimo 3,70 e visualizzazione.
- TOP = migliori 3 scenari, una sola giocata per partita, ordinati esclusivamente per probabilità.
- Partite LIVE/FINISHED/escluse dal pre-match non entrano nel TOP.
- Quote vecchie accettate: l'età non elimina la partita.

DEBUG
La risposta /api/pick include diagnostics separati per: fixture API-Football, gate pre-match, Betfair pool, standings, ultime 3 e modello. Se il TOP è vuoto si può vedere se il collo di bottiglia è il calendario o il matching/quote Betfair.
