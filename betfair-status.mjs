const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function supa(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Metodo non consentito' });
  if (!SUPA_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase non configurato' });
  }

  try {
    const rows = await supa(
      'betfair_quotes?select=data_type,market_id,received_at&order=received_at.desc&limit=1000'
    );
    const books = rows.filter(x => x?.data_type === 'book');
    const catalogues = rows.filter(x => x?.data_type === 'catalogue');
    const latestBook = books[0]?.received_at || null;
    const latestCatalogue = catalogues[0]?.received_at || null;
    const freshCutoff = Date.now() - 15 * 60 * 1000;
    const freshBooks = books.filter(x => Date.parse(x.received_at || '') >= freshCutoff);
    const uniqueFreshMarkets = new Set(freshBooks.map(x => String(x.market_id || '')).filter(Boolean));

    return res.status(200).json({
      ok: uniqueFreshMarkets.size > 0,
      provider: 'Betfair Exchange via Bridge',
      mode: 'read-only-supabase',
      directBetfairLogin: false,
      freshMarkets: uniqueFreshMarkets.size,
      latestBook,
      latestCatalogue,
      testedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      provider: 'Betfair Exchange via Bridge',
      mode: 'read-only-supabase',
      error: String(e?.message || e),
    });
  }
}
