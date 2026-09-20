# Database sincronizzato tra dispositivi

La v6 ora supporta Supabase per sincronizzare l'archivio giocate tra iPhone, Mac e altri dispositivi.

## 1. Crea il progetto Supabase
1. Vai su https://supabase.com/dashboard
2. Crea un nuovo progetto.
3. Apri **SQL Editor** e incolla tutto il contenuto di `supabase-schema.sql`.
4. Esegui lo script.

## 2. Configura Vercel
Nel progetto Vercel apri **Settings → Environment Variables** e aggiungi:

- `SUPABASE_URL` = URL del progetto Supabase
- `SUPABASE_ANON_KEY` = Publishable/anon key del progetto

Usa la chiave pubblica/anon, MAI la `service_role`.

Poi fai un nuovo deploy.

## 3. Autenticazione
L'app mostra una sezione **Sincronizzazione**.

- **Crea account**: crea il proprio account email/password.
- **Accedi**: usare lo stesso account su tutti i dispositivi.
- L'archivio viene unito e sincronizzato automaticamente.
- Modifiche a risultato, importo, cash out e stato vengono sincronizzate.
- Le cancellazioni vengono registrate come tombstone, così non vengono ricreate da un altro dispositivo.

Se Supabase non è ancora configurato, l'app continua a funzionare in modalità locale con `localStorage`.

## 4. Sicurezza
La tabella `bets` usa Row Level Security: ogni utente può leggere e modificare solo le proprie giocate.

## 5. Tracciamento performance del modello (v160)
Esegui anche `supabase-schema-model-predictions.sql` nello SQL Editor: crea la tabella
`model_predictions`, usata solo lato server (service role key, mai esposta al client) per
registrare ogni pronostico mostrato da `/api/pick` e confrontarlo poi con il risultato reale.

Chiama periodicamente `/api/stats` (es. una volta al giorno, anche manualmente da browser)
per liquidare i pronostici passati e ottenere statistiche reali: win rate, ROI a puntata
flat e risultati per mercato. V160 non usa l’Edge nel calcolo del pronostico.
