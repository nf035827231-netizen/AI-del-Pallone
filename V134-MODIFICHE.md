# V134 — Finestre orarie analisi

## Obiettivo
Ridurre il perimetro operativo alle partite che l'utente può ragionevolmente seguire in diretta e per cui può gestire un eventuale cash out.

## Modifiche
- Aggiunto menu `Finestra oraria` accanto alla data nella sezione Analizza.
- Opzioni:
  - Tutto il giorno — 11:00–22:00
  - Primo pomeriggio — 13:00–16:00
  - Tardo pomeriggio — 16:01–19:00
  - Sera — 19:01–22:00
- Gli orari sono interpretati in `Europe/Rome`.
- Il filtro viene applicato server-side prima dell'analisi, quindi le partite fuori fascia non entrano nel pool e non consumano le chiamate di arricchimento relative a quelle partite.
- Il filtro è incluso nella cache browser e nella cache server: cambiare fascia forza un perimetro distinto.
- L'analisi generale (`Tutti i campionati selezionati`) ora considera il perimetro europeo + coppe UEFA e non include più Sudamerica, MLS e J1 League.
- Sudamerica, MLS e J1 League sono stati rimossi dal menu campionati per evitare selezioni non coerenti con il perimetro operativo attuale.
- Le gare con kickoff tra 22:01 e 10:59 vengono escluse; il limite operativo generale è quindi 11:00–22:00.
- Corretto anche il riferimento a `livePairs` non definito nel percorso di costruzione delle fixture Betfair.

## Note
- `13:00–16:00` include entrambe le estremità.
- `16:01–19:00` e `19:01–22:00` seguono esattamente la suddivisione richiesta.
- La stessa logica temporale viene applicata anche quando si seleziona un singolo campionato, così il comportamento resta coerente.
