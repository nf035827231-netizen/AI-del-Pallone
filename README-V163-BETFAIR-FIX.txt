AI DEL PALLONE V163 — BETFAIR MATCHING FIX

Questa versione parte dalla V162 e corregge il collegamento ESPN -> Betfair.

Cambiamenti principali:
- ESPN resta fonte di calendario, classifica e ultime 3.
- Betfair Exchange resta l'unica fonte delle quote.
- Il catalogo Betfair viene indicizzato anche quando il MarketBook non è ancora presente:
  "evento non riconosciuto" e "evento trovato ma senza book" sono ora distinti.
- Matching squadre più robusto: alias, nomi abbreviati, inclusioni, token, Levenshtein,
  separatore v/vs/@/trattino e controllo dell'orario.
- Un evento Betfair può essere riconosciuto anche se casa/trasferta sono invertite.
- La diagnostica mostra cataloghi, mercati, mercati con book, eventi e il match Betfair più vicino.
- Nessuna API-Football e nessun Football-Data.
- Nessun Edge/blending/ELO/H2H/Monte Carlo.
- Quota BACK massima 3,70.
- TOP 3 ordinato solo per probabilità.

IMPORTANTE:
Dopo il deploy eseguire il betfair-bridge.command per sincronizzare un nuovo catalogo e i MarketBook.
Il bridge non piazza scommesse.
