# AI DEL PALLONE — V129

Modifiche rispetto alla build V128:

- Navigazione: `Oggi` rinominato in `Analizza`.
- Il pulsante `➕ Seleziona` è stato spostato più in alto nella scheda principale, subito dopo il mercato/quota.
- `Consigli AI`: aggiunta della `Quota Betfair BACK` direttamente nelle tre indicazioni.
- `Giocate`: il campo Cash out ora richiede il risultato P/L del cash out con segno, ad esempio `+0,80` oppure `-0,37`.
- `Bilanci`: mantenuti due bilanci separati:
  - Bilancio reale: P/L effettivo Betfair, incluso il cash out.
  - Senza cash out: risultato teorico se la giocata fosse arrivata a fine partita, con commissione Exchange calcolata sulle vincite.
  - Differenza cash out: `reale - senza cash out`.
- Compatibilità: i vecchi record che memorizzavano l'incasso totale del cash out vengono convertiti internamente in P/L (`incasso - stake`), così lo storico non viene perso.
- Il Bridge NON è stato modificato in questa patch.
