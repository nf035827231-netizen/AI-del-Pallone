const cache = new Map();
const SERVER_CACHE_TTL = 2 * 30 * 24 * 60 * 60 * 1000; // best-effort server cache; persistent cache is handled by the app

const normalize = x => String(x || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/\b(fc|afc|cf|sc|club|fk|ac|as|us|ss|calcio)\b/g,'')
  .replace(/[^a-z0-9]+/g,' ').trim();

function score(name, target) {
  const n = normalize(name);
  if (!n || !target) return 0;
  if (n === target) return 100;
  if (n.includes(target) || target.includes(n)) return 85;
  const a = new Set(n.split(' ')), b = target.split(' ');
  const common = b.filter(x => a.has(x)).length;
  return 45 + common * 12;
}

async function searchTheSportsDB(query) {
  const url = 'https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' + encodeURIComponent(query);
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return [];
  const body = await r.json();
  return Array.isArray(body?.teams) ? body.teams : [];
}

async function searchTeams(key, query) {
  const url = 'https://v3.football.api-sports.io/teams?search=' + encodeURIComponent(query);
  const r = await fetch(url, { headers: { 'x-apisports-key': key, 'Accept': 'application/json' } });
  const body = await r.json();
  if (!r.ok) throw new Error(body?.message || body?.errors || `HTTP ${r.status}`);
  return Array.isArray(body?.response) ? body.response : [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
  const key = process.env.API_FOOTBALL_KEY;
  const u = new URL(req.url, 'https://vercel.local');
  const team = String(u.searchParams.get('team') || '').trim();
  if (!team) return res.status(400).json({ error: 'Nome squadra mancante' });

  const cacheKey = team.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return res.status(200).json(hit.data);

  try {
    const target = normalize(team);
    const queries = [team];
    // API-Football spesso indicizza il nome senza suffissi societari.
    const stripped = team.replace(/\b(FC|AFC|CF|SC|Club|FK|AC|AS|US|SS)\b/gi,' ').replace(/\s+/g,' ').trim();
    if (stripped && stripped.toLowerCase() !== team.toLowerCase()) queries.push(stripped);

    let rows = [];
    if (key) {
      for (const q of queries) {
        try {
          rows = await searchTeams(key, q);
          if (rows.length) break;
        } catch (e) {
          // Se API-Football non risponde, continuiamo con il fallback gratuito.
        }
      }
    }

    rows.sort((a,b) => score(b?.team?.name,target)-score(a?.team?.name,target));
    const t = rows[0]?.team;
    let logo = t?.logo || (t?.id ? `https://media.api-sports.io/football/teams/${t.id}.png` : null);
    let source = logo ? 'api-football' : null;
    let resolvedName = t?.name || null;
    let teamId = t?.id || null;

    // Fallback gratuito: TheSportsDB. Viene usato anche quando API-Football non è disponibile.
    if (!logo) {
      for (const q of queries) {
        try {
          const tsdbRows = await searchTheSportsDB(q);
          const sorted = tsdbRows.sort((a,b) => score(b?.strTeam,target)-score(a?.strTeam,target));
          const ts = sorted[0];
          if (ts?.strBadge) {
            logo = ts.strBadge;
            source = 'thesportsdb';
            resolvedName = ts.strTeam || resolvedName;
            teamId = ts.idTeam || teamId;
            break;
          }
        } catch {}
      }
    }

    const data = {
      team,
      logo,
      teamId,
      resolvedName,
      source,
      refreshedAt: new Date().toISOString(),
      refreshAfterMonths: 2
    };
    cache.set(cacheKey, { expires: Date.now()+SERVER_CACHE_TTL, data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
