-- Auto-calibrazione: un'unica riga che tiene il fattore correttivo calcolato da
-- api/stats.mjs confrontando le probabilità stimate dal modello con i risultati reali
-- delle giocate liquidate. pick.mjs la legge (lettura leggera, una riga) a ogni richiesta.

create table if not exists model_calibration (
  id text primary key,              -- sempre 'global' per ora (un solo fattore complessivo)
  factor numeric not null default 1,
  settled_count int not null default 0,
  actual_win_rate numeric,          -- % vittorie reali, solo a scopo di trasparenza/debug
  avg_predicted_prob numeric,       -- % media stimata dal modello, solo a scopo di trasparenza/debug
  updated_at timestamptz not null default now()
);

-- Nessuna riga iniziale necessaria: finché non esiste, pick.mjs usa il fattore neutro 1.0
-- (nessuna correzione) automaticamente. La riga viene creata/aggiornata la prima volta che
-- /api/stats gira con almeno 30 giocate liquidate che hanno un prob_model salvato.
