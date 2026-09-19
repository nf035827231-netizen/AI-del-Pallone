AI DEL PALLONE – V143
MODELLO SEMPLIFICATO + QUOTE FALLBACK

OBIETTIVO
Il motore ora analizza le partite senza usare Betfair come filtro di ingresso. Per ogni gara disponibile nel perimetro vengono valutati solo:
1) classifica attuale;
2) ultime 3 partite finite di entrambe le squadre;
3) quota disponibile;
4) confronto tra probabilità stimata e probabilità implicita della quota.

LOGICA TOP
- almeno 3 partite recenti per entrambe le squadre;
- EDGE >= 5 punti percentuali;
- indice TOP >= 60;
- quota fresca;
- massimo un esito per partita.

QUOTE
- Betfair Exchange è la fonte preferita quando la partita è presente nel bridge.
- Se Betfair non trova la gara, V143 usa /v3/odds/multi di Odds-API.io in blocchi da massimo 10 eventi.
- V143 non usa più il vecchio filtro artificiale quota 1.50–3.75: la bontà della quota viene valutata dal rapporto probabilità stimata / probabilità implicita.
- Se una partita non ha alcuna quota disponibile, resta comunque ANALIZZATA ma non può entrare nel TOP.

COSA NON ENTRA NEL MODELLO
- ELO
- Monte Carlo
- Dixon-Coles
- H2H
- API-Football predictions
- infortuni/assenze numeriche
- baseline gol di campionato
- pesi storici complessi

DATI
- Odds-API.io: elenco partite + fallback quote.
- Betfair Exchange: quota preferita quando disponibile.
- football-data.org: classifica e risultati necessari per le ultime 3.

SERIE B
Serie B italiana (codice football-data SB) resta supportata nel menu e nel filtro backend.

NOTA
Il modello è un indicatore statistico semplificato e non garantisce l'esito delle partite.
