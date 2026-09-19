AI DEL PALLONE V150 - ALGORITMO REBOOT

Obiettivo:
produrre sempre i 3 migliori TOP disponibili con quota BACK Betfair <= 3.70,
senza filtri che possano lasciare la sezione TOP vuota.

MODELLO:
1) Classifica: posizione relativa delle due squadre.
2) Ultime 3: punti per partita nelle ultime tre gare disponibili.
3) Probabilita' 1X2: combinazione semplice di classifica + forma recente + vantaggio casa.
4) Quota: esclusivamente Betfair Exchange, ultima BACK disponibile.
5) Edge: probabilita' stimata - probabilita' implicita della quota.
6) Ranking: probabilita' + qualita' dati + valore della quota.

REGOLE:
- quota BACK > 1.00 e <= 3.70;
- Betfair e' usata SOLO per le quote;
- Odds-API serve per scoprire le partite;
- nessun ELO;
- nessun Monte Carlo;
- nessun Dixon-Coles;
- nessun H2H;
- nessun infortunio nel calcolo;
- classifica/forma mancanti non eliminano la partita: il dato mancante diventa neutro e riduce solo la qualita' del dato;
- il TOP seleziona sempre fino a 3 partite diverse, una sola giocata per partita;
- non e' richiesto un Edge positivo per entrare nel TOP: il sistema ordina i migliori disponibili.

NOTA:
"TOP" significa i 3 migliori scenari disponibili secondo questo modello; non significa
che tutti abbiano necessariamente valore matematico positivo.
