# Betfair Exchange — AI DEL PALLONE

Questo pacchetto mantiene l'app v15 completa e aggiunge `api/betfair-status.mjs` per verificare il collegamento server-side a Betfair Exchange Italia.

## Variabili Vercel

Impostare su Production:

- `BETFAIR_APP_KEY` — usare la Delayed App Key per i test
- `BETFAIR_USERNAME`
- `BETFAIR_PASSWORD`
- `BETFAIR_CERT` — contenuto del certificato `.crt`, incluse le righe BEGIN/END
- `BETFAIR_KEY` — contenuto della chiave privata `.key`, incluse le righe BEGIN/END

Non inserire mai queste credenziali nel codice o nel repository.

## Test

Dopo il deployment aprire:

`/api/betfair-status`

Se tutto è configurato correttamente restituisce `ok: true`, `login: SUCCESS` ed `exchangeApi: OK` senza esporre il session token.
