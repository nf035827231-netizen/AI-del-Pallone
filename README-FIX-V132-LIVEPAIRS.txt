AI DEL PALLONE - FIX V132

Base: v132(1).zip

Correzione:
- risolto l'errore runtime `livePairs is not defined` in api/pick.mjs;
- il Set delle partite live viene ora creato prima del suo utilizzo;
- la logica dell'algoritmo V132 e tutte le altre funzioni del pacchetto sono state lasciate invariate.

Nessuna modifica a quote, mercati, scoring o filtri dell'algoritmo.
