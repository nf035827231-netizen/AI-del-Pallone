V146 – FIX TOP

Correzione principale: V145 poteva analizzare molte partite senza avere davvero le ultime 3 partite disponibili, perché in modalità “Tutti” interrogava football-data.org solo per 6 competizioni e faceva una seconda chiamata standings per ciascuna.

V146 usa fino a 10 competizioni storiche prioritarie con una sola chiamata matches per competizione e ricostruisce la classifica dai risultati FINISHED. Il TOP richiede davvero almeno 3 partite recenti per entrambe le squadre, Edge >= 2 e indice >= 55. La quota può essere vecchia: viene comunque usata.

La freschezza della quota NON è un filtro. Betfair resta preferita e Odds-API resta fallback per la quota.
