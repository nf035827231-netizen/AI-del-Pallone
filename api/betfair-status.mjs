import https from 'node:https';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) throw new Error(`${name} non configurata su Vercel`);
  return String(value);
}

function httpsPost({ hostname, path, headers = {}, body, cert, key }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      cert,
      key,
      timeout: 15000,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout richiesta Betfair')));
    req.on('error', reject);
    req.end(body);
  });
}

async function betfairLogin() {
  const appKey = requireEnv('BETFAIR_APP_KEY');
  const username = requireEnv('BETFAIR_USERNAME');
  const password = requireEnv('BETFAIR_PASSWORD');
  const cert = requireEnv('BETFAIR_CERT');
  const key = requireEnv('BETFAIR_KEY');

  const body = new URLSearchParams({ username, password }).toString();
  const response = await httpsPost({
    hostname: 'identitysso-cert.betfair.it',
    path: '/api/certlogin',
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
    cert,
    key,
  });

  let json = null;
  try { json = JSON.parse(response.body); } catch {}
  if (!json || json.loginStatus !== 'SUCCESS' || !json.sessionToken) {
    const status = json?.loginStatus || 'LOGIN_FAILED';
    const detail = json?.error || json?.errorCode || '';
    throw new Error(`Betfair login: ${status}${detail ? ` · ${detail}` : ''}`);
  }
  return { appKey, sessionToken: json.sessionToken };
}

async function listSoccerEventTypes(appKey, sessionToken) {
  const payload = JSON.stringify([{
    jsonrpc: '2.0',
    method: 'SportsAPING/v1.0/listEventTypes',
    params: { filter: { eventTypeIds: ['1'] } },
    id: 1,
  }]);

  const response = await httpsPost({
    hostname: 'api.betfair.com',
    path: '/exchange/betting/json-rpc/v1',
    headers: {
      'X-Application': appKey,
      'X-Authentication': sessionToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: payload,
  });

  let json = null;
  try { json = JSON.parse(response.body); } catch {}
  const error = Array.isArray(json) ? json[0]?.error : json?.error;
  if (error) throw new Error(`Exchange API: ${error.errorCode || 'ERRORE'}${error.errorDetails ? ` · ${error.errorDetails}` : ''}`);
  return { httpStatus: response.status, ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Metodo non consentito' });

  try {
    const { appKey, sessionToken } = await betfairLogin();
    const exchange = await listSoccerEventTypes(appKey, sessionToken);
    return res.status(200).json({
      ok: true,
      provider: 'Betfair Exchange Italia',
      login: 'SUCCESS',
      exchangeApi: exchange.ok ? 'OK' : 'FAILED',
      appKeyType: /^sk_live_/i.test(appKey) ? 'LIVE' : 'DELAYED_OR_OTHER',
      testedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      provider: 'Betfair Exchange Italia',
      error: String(e?.message || e),
      testedAt: new Date().toISOString(),
    });
  }
}
