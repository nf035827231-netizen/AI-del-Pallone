AI DEL PALLONE — V144

Correzione V143: il TOP era troppo restrittivo.

Motore volutamente semplice:
- classifica attuale
- ultime 3 partite di entrambe le squadre
- quota disponibile
- probabilita stimata
- confronto quota/probabilita (edge)

Per evitare il caso “Nessun candidato” quando esistono scenari con valore moderato, la soglia TOP e stata portata a:
- almeno 3 partite recenti per entrambe
- edge >= 2 punti percentuali
- score >= 55
- quota con freschezza >= 30

Betfair Exchange resta la fonte preferita; Odds-API.io e fallback. Betfair non filtra piu le partite.
