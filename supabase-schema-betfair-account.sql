-- Dati REALI del conto Betfair (saldo, scommesse liquidate, scommesse aperte), separati
-- dalla tabella betfair_quotes (quella è dati di mercato pubblici; questa è personale).
-- Solo lato server (service role key), mai esposta al client.

create table if not exists betfair_account (
  data_type text primary key,   -- 'funds' | 'clearedOrders' | 'currentOrders'
  payload jsonb not null,       -- il campo "result" già scompattato dalla risposta Betfair
  received_at timestamptz not null default now()
);

-- Una sola riga per tipo: ogni sincronizzazione del bridge sostituisce la precedente.
-- Non serve tenere uno storico di ogni singolo saldo, solo l'ultimo aggiornamento —
-- lo storico delle scommesse liquidate arriva già dentro "clearedOrders" (ultimi 90 giorni,
-- forniti direttamente da Betfair a ogni sincronizzazione).
