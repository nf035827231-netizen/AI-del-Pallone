-- Tabella per tracciare nel tempo i pronostici mostrati dal modello (v160).
-- Usata solo lato server (service role key), nessun accesso diretto dal client.
-- Serve a verificare onestamente se il modello ha valore reale nel tempo,
-- confrontando l'esito effettivo con la probabilità e l'edge stimati.

create table if not exists model_predictions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  match_date date not null,
  league_code text,
  league text,
  home text not null,
  away text not null,
  event_id text,
  fixture_id text,
  market text not null,
  odds numeric,
  odds_cap_used numeric,
  prob_model numeric,
  prob_market numeric, -- mantenuto per compatibilità storica; V160 non lo usa
  prob_blended numeric, -- mantenuto per compatibilità storica; V160 non lo usa
  edge_percent numeric, -- mantenuto per compatibilità storica; V160 non lo usa
  model_sample int,
  kickoff timestamptz,
  settled boolean not null default false,
  result text,              -- 'win' | 'loss' | null finché non liquidato
  settled_at timestamptz
);

create unique index if not exists model_predictions_unique
  on model_predictions (match_date, home, away, market);

create index if not exists model_predictions_settle_queue
  on model_predictions (settled, kickoff)
  where settled = false;
