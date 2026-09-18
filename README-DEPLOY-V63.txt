AI DEL PALLONE — APP V6.3 — DEPLOY

Questa versione corregge il blocco dei pulsanti causato dal motore Monte Carlo e separa il percorso app da un login Betfair diretto su Vercel.

IMPORTANTE
- /api/pick legge i BOOK/CATALOGUE da Supabase.
- /api/betfair-odds legge i market da Supabase.
- /api/betfair-status controlla la freschezza dei dati Supabase e NON effettua login Betfair.
- Il Bridge locale resta il solo componente che interroga Betfair.
- O/U 0.5 escluso.
- O/U 1.5, 2.5, 3.5, 4.5 inclusi.
- Il modello P_model non usa la probabilità Betfair per costruire la propria probabilità.

VERCEL
1. Usa questo progetto come nuova versione del progetto esistente.
2. Mantieni le variabili ambiente già presenti in produzione, in particolare SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY e le chiavi API già usate dal motore.
3. NON aggiungere certificati o chiavi private Betfair a Vercel.
4. Dopo il deploy verifica:
   /api/betfair-status
   Deve rispondere con mode=read-only-supabase e freshMarkets > 0.
5. Apri la home e premi "Analizza dati + statistiche".

BRIDGE
Il Bridge continua a essere eseguito sul Mac e invia i dati a Supabase. Non deve essere modificato per questa correzione.
Deploy test 18-09-2026
Deploy test 18-09-2026
