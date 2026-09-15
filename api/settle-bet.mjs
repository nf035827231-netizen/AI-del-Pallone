// Determina automaticamente se una giocata è stata vinta o persa,
// leggendo il risultato finale reale della partita da football-data.org
// (usiamo l'id della partita già salvato al momento del salvataggio della
// giocata, quindi nessuna nuova ricerca serve). Nessun risultato viene
// mai inventato: se la partita non è ancora conclusa o il mercato non è
// riconosciuto, si torna settled:false con il motivo, mai un falso esito.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return res.status(500).json({ error: "FOOTBALL_DATA_TOKEN non configurato" });

  const u = new URL(req.url, "https://vercel.local");
  const fixtureId = u.searchParams.get("fixtureId");
  const market = u.searchParams.get("market");
  if (!fixtureId || !market) return res.status(400).json({ error: "Parametri fixtureId e market richiesti" });

  // football-data.org accetta solo ID numerici interi. Se questa giocata ha
  // un riferimento partita non valido (es. salvata con una versione
  // precedente dell'app, o importata da un vecchio backup), lo diciamo
  // chiaramente qui invece di inoltrare all'utente l'errore tecnico grezzo
  // dell'API esterna ("Argument 'id' is expected to be an integer...").
  if (!/^\d+$/.test(fixtureId)) {
    return res.status(200).json({ settled: false, reason: "Questa giocata ha un riferimento partita non valido (probabilmente salvata con una versione precedente dell'app, o importata da un backup vecchio). Puoi comunque segnare il risultato a mano." });
  }

  try {
    const r = await fetch(`https://api.football-data.org/v4/matches/${encodeURIComponent(fixtureId)}`, {
      headers: { "X-Auth-Token": token }
    });
    const text = await r.text();
    let m;
    try { m = JSON.parse(text); } catch { return res.status(200).json({ settled: false, reason: "Risposta non valida da football-data.org" }); }
    if (!r.ok) {
      const raw = m?.message || `Errore HTTP ${r.status}`;
      const reason = /integer|range/i.test(raw)
        ? "Questa giocata ha un riferimento partita non valido (probabilmente salvata con una versione precedente dell'app, o importata da un backup vecchio). Puoi comunque segnare il risultato a mano."
        : raw;
      return res.status(200).json({ settled: false, reason });
    }

    if (m.status !== "FINISHED") {
      const reason = m.status === "POSTPONED" ? "Partita rinviata"
        : m.status === "CANCELLED" ? "Partita annullata"
        : m.status === "SUSPENDED" ? "Partita sospesa"
        : "Partita non ancora conclusa";
      return res.status(200).json({ settled: false, reason, matchStatus: m.status });
    }

    const hg = m.score?.fullTime?.home, ag = m.score?.fullTime?.away;
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) {
      return res.status(200).json({ settled: false, reason: "Risultato finale non disponibile" });
    }

    const result = evaluateMarket(market, hg, ag);
    if (result == null) {
      return res.status(200).json({ settled: false, reason: `Mercato "${market}" non riconosciuto automaticamente`, homeGoals: hg, awayGoals: ag });
    }
    return res.status(200).json({ settled: true, result, homeGoals: hg, awayGoals: ag });
  } catch (e) {
    return res.status(200).json({ settled: false, reason: e?.message || String(e) });
  }
}

// Valuta un singolo mercato contro il risultato finale reale.
// Ritorna "win" / "loss", o null se il mercato non è tra quelli riconosciuti.
export function evaluateMarket(market, hg, ag) {
  const total = hg + ag;
  const m = String(market || "");
  if (m.startsWith("1")) return hg > ag ? "win" : "loss";
  if (m.startsWith("2")) return ag > hg ? "win" : "loss";
  if (m.startsWith("X")) return hg === ag ? "win" : "loss";
  if (m === "Over 2.5") return total > 2.5 ? "win" : "loss";
  if (m === "Under 2.5") return total < 2.5 ? "win" : "loss";
  if (m === "Over 3.5") return total > 3.5 ? "win" : "loss";
  if (m === "Under 3.5") return total < 3.5 ? "win" : "loss";
  if (m === "Goal") return (hg > 0 && ag > 0) ? "win" : "loss";
  if (m === "No Goal") return (hg === 0 || ag === 0) ? "win" : "loss";
  return null;
}
