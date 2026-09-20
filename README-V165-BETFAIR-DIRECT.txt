AI DEL PALLONE — V165 BETFAIR DIRECT

ARCHITETTURA
- ESPN: calendario, classifica e ultime 3 partite.
- Betfair Exchange: unica fonte delle quote.
- Bridge: recupera SOLO eventi che iniziano nelle 6 ore successive al lancio.
- Quote: SOLO BACK (EX_BEST_OFFERS).

MERCATI BETFAIR
- MATCH_ODDS: 1 / X / 2
- OVER_UNDER_15: Over 1.5 / Under 1.5
- OVER_UNDER_25: Over 2.5 / Under 2.5
- OVER_UNDER_35: Over 3.5 / Under 3.5
- BOTH_TEAMS_TO_SCORE: Goal / No Goal

MODELLO
- Top 3, una sola proposta per partita.
- Ordinamento esclusivamente per probabilità stimata.
- Quota massima 3.70.
- La quota NON entra nella probabilità.
- Nessun Edge, ELO, Poisson, Monte Carlo, H2H o blending quota/probabilità.
- Probabilità 1X2: classifica + punti nelle ultime 3.
- Probabilità O/U e Goal/No Goal: frequenza osservata nelle ultime 3 disponibili delle due squadre, con piccola correzione classifica/forma.

CORREZIONE V165
Il backend legge SOLO l'ULTIMO catalogue sincronizzato dal bridge 6H, evitando contaminazioni da vecchi catalogue.
Il mapping usa marketType Betfair e runnerName/selectionId reali.
Le diagnostiche espongono anche quanti runner hanno una BACK reale.

ORDINE OPERATIVO
1. Deployare questo ZIP su Vercel.
2. Lanciare betfair-bridge.command (è il bridge 6 ore).
3. Aspettare il messaggio BRIDGE COMPLETATO.
4. Aprire Pick del Giorno e premere Aggiorna API.
