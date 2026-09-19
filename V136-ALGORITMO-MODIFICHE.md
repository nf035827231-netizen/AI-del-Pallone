# AI DEL PALLONE V136 — ALGORITMO

## Obiettivo
Prima di ulteriori modifiche grafiche, questa versione corregge il flusso di analisi e rende il modello più robusto.

## Modifiche
- Filtro della finestra oraria applicato anche server-side, non solo nell'interfaccia.
- Per "Tutto il giorno" il perimetro è 11:00–22:00 Europe/Rome.
- Modello gol migliorato con:
  - rendimento casa/trasferta separato;
  - pesatura recente delle prestazioni;
  - forza relativa ELO costruita sullo storico disponibile;
  - expected goals più stabili;
  - distribuzione Dixon-Coles per 1X2 e Under/Over.
- Monte Carlo usa lo stesso modello expected-goals/Dixon-Coles e può arricchire fino a 40 fixture.
- Arricchimento API-Football esteso fino a 30 fixture, senza usare la prediction API come generatore della probabilità principale.
- Edge Betfair calcolato rispetto alla probabilità di break-even dopo la commissione Exchange (4,5% di default), invece della sola probabilità implicita 1/quota.
- P_model resta indipendente dalla quota Betfair.
- La quota viene usata per misurare il valore, non per creare la probabilità.
- Il TOP non deve trasformare una quota alta in una previsione forte se il modello è debole.

## Perimetro invariato
- Betfair Exchange BACK come fonte quote.
- Mercati: 1X2 + Under/Over 1.5, 2.5, 3.5, 4.5.
- Nessun Under/Over 0.5.
- Nessuna modifica al Bridge Betfair.
