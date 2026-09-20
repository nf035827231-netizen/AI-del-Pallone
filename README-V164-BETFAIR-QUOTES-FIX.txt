AI DEL PALLONE — V164 BETFAIR QUOTES FIX

Fix principale: il bridge Betfair V163 richiedeva EX_BEST_OFFERS + EX_TRADED su 40 marketId per blocco. La documentazione Betfair assegna a questa combinazione un peso di 20, quindi 40 marketId superano il limite di 200 punti per richiesta. V164 usa EX_BEST_OFFERS soltanto: 40 marketId per blocco = 200 punti.

Altri fix:
- listMarketCatalogue fino a 1000 mercati
- quote BACK reali da availableToBack
- diagnostica separata: Match Odds con book / Match Odds con BACK / mercati con BACK
- nessun API-Football
- nessun Football-Data
- Betfair solo per le quote
- quota massima 3,70
- TOP 3 per probabilità
- nessun Edge/ELO/H2H/Monte Carlo

IMPORTANTE: dopo il deploy eseguire nuovamente betfair-bridge.command per popolare Supabase con i nuovi MarketBook.
