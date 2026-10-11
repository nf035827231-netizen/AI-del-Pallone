# AI DEL PALLONE — integrazione Betfair Exchange via Mac Bridge

Questa versione parte dal v15 e aggiunge un bridge in sola lettura:
Mac -> Betfair Exchange Italia -> endpoint Vercel -> Supabase.

Il Mac NON deve essere raggiungibile da Internet e non serve port forwarding.
Il bridge effettua richieste in uscita verso Betfair e verso Vercel.

## 1) Supabase

Aprire SQL Editor di Supabase ed eseguire il file:
`SQL-BETFAIR-BRIDGE.sql`

## 2) Vercel Environment Variables

Aggiungere in Production:

- `SUPABASE_SERVICE_ROLE_KEY` = Service Role Key del progetto Supabase
- `BETFAIR_BRIDGE_TOKEN` = un token segreto scelto da te

Sono già presenti nel progetto `SUPABASE_URL` e `SUPABASE_ANON_KEY`.

NON mettere password Betfair o private key nel codice del sito.

Per creare un token sul Mac puoi usare:
`openssl rand -hex 32`

## 3) Deploy

Caricare su GitHub il contenuto dello ZIP mantenendo la cartella `api/`.
Vercel ridistribuirà il progetto.

## 4) Mac Bridge

Aprire `betfair-bridge.command`.

Inserire:
- URL Vercel
- BETFAIR_BRIDGE_TOKEN (lo stesso configurato su Vercel)
- Application Key Betfair
- username/password Betfair
- `.crt`
- `.key`

Il bridge:
- fa login su Betfair Italia;
- cerca i mercati calcio MATCH_ODDS delle prossime 48 ore;
- invia il catalogo a Vercel;
- legge i migliori prezzi Exchange BACK/LAY (3 livelli) e EX_TRADED;
- invia i MarketBook a Vercel/Supabase;
- NON piazza scommesse.

La sincronizzazione è volutamente manuale in questa prima integrazione: esegui il bridge quando vuoi aggiornare i dati. Questo evita di lasciare processi attivi sul Mac 24/7.

## 5) Endpoint per recuperare un match

Dopo il deploy:
`/api/betfair-odds?home=FC%20Ashdod&away=Hapoel%20Rishon%20Lezion`

L'endpoint cerca il market Betfair corrispondente e restituisce il MarketBook più recente.

## Nota Application Key

La Delayed Key è adatta a sviluppo e test; Betfair indica che i prezzi possono essere ritardati e che alcune informazioni non sono disponibili. Per dati live servirebbe una Live Application Key attivata secondo le regole Betfair.

## Sicurezza

Non condividere mai in chat:
- password Betfair
- private key `.key`
- session token
- Service Role Key Supabase
- BETFAIR_BRIDGE_TOKEN
