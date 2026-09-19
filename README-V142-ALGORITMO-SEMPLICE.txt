AI DEL PALLONE – V142
MODELLO SEMPLIFICATO

OBIETTIVO
Il modello è stato ridotto volutamente a tre elementi leggibili:
1) classifica attuale;
2) ultime 3 partite di entrambe le squadre;
3) quota BACK di Betfair Exchange.

COSA NON ENTRA PIÙ NEL PUNTEGGIO
- ELO
- Monte Carlo 10.000 simulazioni
- Dixon-Coles
- scontri diretti (H2H)
- API-Football predictions
- infortuni/assenze
- baseline gol di campionato
- pesi storici complessi

LOGICA
1. Per ogni squadra vengono prese solo le ultime 3 gare finite disponibili.
2. La forma recente viene calcolata con 3 punti per vittoria, 1 per pareggio, 0 per sconfitta.
3. La classifica viene trasformata in un indicatore semplice della forza relativa.
4. Per 1X2 la probabilità stimata deriva principalmente da classifica + forma delle ultime 3.
5. Per Goal/No Goal e Over/Under la probabilità deriva esclusivamente dalla frequenza osservata nelle ultime 3 gare di entrambe le squadre.
6. La quota Betfair viene convertita in probabilità implicita: 100 / quota.
7. EDGE = probabilità stimata - probabilità implicita della quota.
8. Il TOP richiede almeno 3 gare disponibili per entrambe, quota fresca, EDGE >= 5 punti percentuali e indice TOP >= 60.
9. Nel TOP viene mostrato un solo esito per partita.

DATI E API
- Odds-API.io: scoperta delle partite.
- Betfair Exchange: quota BACK usata nel confronto valore/quota.
- football-data.org: classifica e risultati storici necessari per le ultime 3 partite.
- API-Football non viene più chiamata durante l'analisi.

RIDUZIONE CHIAMATE
Per ogni campionato analizzato football-data.org usa 2 letture: partite recenti + classifica.
Il modello non effettua più richieste per infortuni, predictions o simulazioni.

SERIE B
Serie B italiana (codice football-data SB) è mantenuta nel menu e nel filtro backend.

NOTA
Il punteggio è un indicatore di confronto, non una garanzia sull'esito della partita.
