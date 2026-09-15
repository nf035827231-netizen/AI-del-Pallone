const cache = new Map();

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
  if (!key) return res.status(503).json({ error: 'API_FOOTBALL_KEY non configurata' });

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
    for (const q of queries) {
      try {
        rows = await searchTeams(key, q);
        if (rows.length) break;
      } catch (e) {
        if (q === queries[queries.length - 1]) throw e;
      }
    }

    rows.sort((a,b) => score(b?.team?.name,target)-score(a?.team?.name,target));
    const t = rows[0]?.team;
    const data = {
      team,
      logo: t?.logo || (t?.id ? `https://media.api-sports.io/football/teams/${t.id}.png` : null),
      teamId: t?.id || null,
      resolvedName: t?.name || null
    };
    cache.set(cacheKey, { expires: Date.now()+86400000, data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
