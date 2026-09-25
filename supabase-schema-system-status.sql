-- Riepilogo di stato per il pannello "salute del sistema": una sola riga, aggiornata da
-- pick.mjs a ogni analisi reale (senza nessuna chiamata esterna aggiuntiva — riusa solo
-- quello che l'analisi ha già scoperto). Il pannello legge questa riga invece di testare
-- le fonti dal vivo ogni volta che lo apri.

create table if not exists system_status (
  id text primary key,              -- sempre 'latest' per ora
  checked_at timestamptz not null default now(),
  analyzed_date date,
  football_data_working boolean,    -- null = non provato in quell'analisi (nessun campionato coperto richiesto)
  espn_working boolean,
  api_football_working boolean,
  picks_returned int,
  pool_used text,                   -- 'privilegiato' | 'esteso'
  calibration_factor numeric
);
