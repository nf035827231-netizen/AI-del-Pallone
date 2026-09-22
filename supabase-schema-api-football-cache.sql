-- Uso "furbo" di API-Football per restare dentro un budget stretto di chiamate/giorno
-- (es. piano da 100/giorno). Usate solo lato server (service role key).

-- Cache: risultato di fixtures+standings per campionato+data, riusato per tutto il
-- resto della giornata anche se l'utente rilancia l'analisi più volte.
create table if not exists api_football_cache (
  cache_key text primary key,       -- es. "SA-2026-09-21"
  payload jsonb not null,           -- {fixtures:[...], standings:[...]}
  created_at timestamptz not null default now()
);

-- Contatore delle chiamate fatte oggi verso API-Football, per non sforare il piano.
create table if not exists api_football_daily (
  usage_date date primary key,
  calls_used int not null default 0
);

-- Pulizia automatica: le righe di cache più vecchie di qualche giorno non servono più
-- (ogni giorno nuovo riparte comunque da zero per il conteggio in api_football_daily).
-- Facoltativo: puoi cancellarle a mano ogni tanto, oppure programmare una pulizia con
-- un cron su Supabase se preferisci automatizzarlo:
--   delete from api_football_cache where created_at < now() - interval '7 days';
