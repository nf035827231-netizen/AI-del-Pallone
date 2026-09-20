AI DEL PALLONE — V166 BETFAIR DIRECT FINAL

OBIETTIVO
- Betfair: unica fonte delle quote.
- Bridge: solo eventi che iniziano nelle 6 ore successive al lancio.
- Solo quote BACK.
- Mercati: MATCH_ODDS, OVER/UNDER 1.5, 2.5, 3.5, BOTH_TEAMS_TO_SCORE.

CORREZIONE PRINCIPALE V166
Il backend non interpreta più in modo rigido marketType/runnerName.
Deriva il tipo mercato anche dal marketName e supporta le varianti reali del JSON Betfair.
Il book viene collegato al catalogue tramite marketId e selectionId.
La quota viene letta direttamente da ex.availableToBack.

DATI SUPPORTATI
- Match Odds: 1 / X / 2
- Over/Under 1.5
- Over/Under 2.5
- Over/Under 3.5
- Goal / No Goal

MODELLO
- ESPN: calendario, classifica, ultime 3.
- Betfair: solo quote.
- Quota massima 3.70.
- TOP 3, una proposta per partita.
- Ordinamento solo per probabilità.
- Nessun Edge, ELO, Poisson, Monte Carlo, H2H o blending quota/probabilità.

DIAGNOSTICA
Ora mostra anche:
- mercati Match Odds
- Match Odds con BACK
- mercati totali con BACK
- runner BACK totali
- mercati BTTS
- mercati O/U
- sample dei runner con selectionId, nome e BACK.

ORDINE
1. Deploy V166 su Vercel.
2. Usa il betfair-bridge.command incluso.
3. Esegui il bridge una volta.
4. Attendi BRIDGE COMPLETATO.
5. Apri Pick del Giorno e premi Aggiorna API.
