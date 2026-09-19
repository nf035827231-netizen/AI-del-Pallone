AI DEL PALLONE V140 – revisione algoritmo

Fix principali:
- filtro campionato specifico autorevole: niente fixture Betfair-only;
- minimo 5 partite finite per ENTRAMBE le squadre; nessun fallback 50%;
- baseline gol per campionato da storico Football-Data;
- Dixon-Coles + ELO + forma recente;
- Monte Carlo reale su distribuzione Dixon-Coles, 10.000 simulazioni;
- API-Football predictions usate solo come diagnostica/confronto, non per costruire P_model;
- assenze non trasformate in penalità numerica senza Player Impact/lineup affidabili;
- freschezza quota e spread BACK/LAY considerati nella qualità;
- TOP solo con modello pronto, almeno 5 gare per entrambe le squadre, analisi >=55 e quota non vecchia;
- una sola selezione per partita nel TOP;
- nessuna modifica al Bridge Betfair.
