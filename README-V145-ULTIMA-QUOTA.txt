AI DEL PALLONE V145 – ULTIMA QUOTA

Base: V144 Semplificato.

MODIFICA PRINCIPALE
- La quota non viene più esclusa dal TOP perché considerata non recente.
- Il sistema usa l'ultima quota disponibile.
- Per Betfair viene privilegiata la quota con timestamp più recente tra quelle disponibili per lo stesso esito.
- Per Odds-API.io viene usata la quota disponibile restituita dal provider quando Betfair non è disponibile.
- La freschezza resta solo informativa (quoteAgeMin / quoteFreshnessScore), non è più un filtro di eleggibilità TOP.

MODELLO
- Classifica
- Ultime 3 partite di entrambe le squadre
- Quota disponibile
- Edge >= 2 punti percentuali
- Score >= 55
- Almeno 3 partite recenti per entrambe le squadre

Non vengono reintrodotti ELO, Monte Carlo, Dixon-Coles, H2H o infortuni nel punteggio semplice.
