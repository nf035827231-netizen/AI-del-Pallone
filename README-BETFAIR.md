# AI DEL PALLONE — Betfair Exchange

Questa versione aggiunge `api/betfair-status.mjs` per verificare il collegamento server-side a Betfair Exchange Italia.

## Variabili Vercel

Impostare in **Production** (e Preview se serve):

- `BETFAIR_APP_KEY` — Application Key Betfair (Delayed per i test o Live se attiva)
- `BETFAIR_USERNAME` — username Betfair
- `BETFAIR_PASSWORD` — password Betfair
- `BETFAIR_CERT` — certificato PEM associato all'account
- `BETFAIR_PRIVATE_KEY` — chiave privata PEM del certificato

`BETFAIR_KEY` resta accettata come fallback per compatibilità con la versione precedente, ma è preferibile usare `BETFAIR_PRIVATE_KEY` per evitare confusione con l'Application Key.

## Test

Aprire `/api/betfair-status` sul dominio Vercel.

Se compare `BETTING_RESTRICTED_LOCATION`, Betfair ha raggiunto e verificato la richiesta ma nega il login API perché l'origine IP della funzione server non è autorizzata per il betting italiano. Non è un errore risolvibile cambiando l'Application Key.

Non inserire mai password, session token o chiavi private nel codice o nei messaggi.
