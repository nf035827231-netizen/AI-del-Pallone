import { extractOdds } from "./pick.mjs";

// Endpoint minimale, pensato per essere chiamato spesso (una volta per
// giocata in archivio, ogni tot minuti) senza pesare sul budget richieste
// del motore principale: 1 sola chiamata a Odds-API.io per evento.
//
// Nota onesta: questa NON è la "quota di chiusura" in senso stretto (quella
// letta un secondo prima del fischio d'inizio, che richiederebbe un job
// schedulato). È la quota più recente disponibile ogni volta che l'app viene
// aperta prima del calcio d'inizio — una buona approssimazione se il
// telefono/PC apre l'app anche solo una volta a ridosso della partita, ma va
// trattata come tale.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const oddsKey = process.env.ODDS_API_KEY;
  const bookmakersParam = process.env.ODDS_BOOKMAKERS || "Bet365";
  if (!oddsKey) return res.status(500).json({ error: "ODDS_API_KEY non configurata" });

  const u = new URL(req.url, "https://vercel.local");
  const eventId = u.searchParams.get("eventId");
  const market = u.searchParams.get("market");
  if (!eventId || !market) return res.status(400).json({ error: "Parametri eventId e market richiesti" });

  try {
    const r = await fetch(`https://api.odds-api.io/v3/odds/multi?apiKey=${encodeURIComponent(oddsKey)}&eventIds=${encodeURIComponent(eventId)}&bookmakers=${encodeURIComponent(bookmakersParam)}`);
    const rows = await r.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.bookmakers) {
      return res.status(200).json({ eventId, market, odds: null, fetchedAt: Date.now(), note: "Nessuna quota disponibile: la partita è probabilmente già iniziata o l'evento non è più tra quelli pre-match." });
    }
    const extracted = extractOdds(row, "all", "");
    const found = extracted.find(x => x.value === market);
    return res.status(200).json({ eventId, market, odds: found ? found.odd : null, fetchedAt: Date.now() });
  } catch (e) {
    return res.status(200).json({ eventId, market, odds: null, fetchedAt: Date.now(), error: String(e?.message || e) });
  }
}
