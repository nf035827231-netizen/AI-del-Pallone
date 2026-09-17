import https from "node:https";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} non configurata`);
  return value;
}

function certLogin() {
  return new Promise((resolve, reject) => {
    const username = required("BETFAIR_USERNAME");
    const password = required("BETFAIR_PASSWORD");
    const appKey = required("BETFAIR_APP_KEY");
    const cert = required("BETFAIR_CERT").replace(/\\n/g, "\n");
    const key = required("BETFAIR_KEY").replace(/\\n/g, "\n");
    const body = new URLSearchParams({ username, password }).toString();
    const req = https.request({
      hostname: "identitysso-cert.betfair.it",
      path: "/api/certlogin",
      method: "POST",
      cert, key,
      headers: { "X-Application": appKey, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.loginStatus !== "SUCCESS" || !parsed.token) return reject(new Error(`Betfair login: ${parsed.loginStatus || "RISPOSTA_NON_VALIDA"}`));
          resolve({ token: parsed.token, appKey });
        } catch { reject(new Error("Risposta login Betfair non JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Timeout login Betfair")));
    req.on("error", reject); req.write(body); req.end();
  });
}

function rpc(token, appKey, method, params, area="account") {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    const req = https.request({
      hostname: "api.betfair.com", path: area === "betting" ? "/exchange/betting/json-rpc/v1" : "/exchange/account/json-rpc/v1", method: "POST",
      headers: { "X-Application": appKey, "X-Authentication": token, "Accept": "application/json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 15000,
    }, res => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error?.data?.APINGException?.errorCode || parsed.error?.message || "Betfair API error"));
          resolve(parsed.result);
        } catch { reject(new Error("Risposta API Betfair non JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout ${method}`)));
    req.on("error", reject); req.write(payload); req.end();
  });
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Metodo non consentito" });
  try {
    const session = await certLogin();
    const now = new Date();
    const from = new Date(now.getTime() - 31 * 86400000).toISOString();
    const [funds, current, cleared] = await Promise.all([
      rpc(session.token, session.appKey, "AccountAPING/v1.0/getAccountFunds", { wallet: "ITALIAN" }),
      rpc(session.token, session.appKey, "SportsAPING/v1.0/listCurrentOrders", { orderProjection: "ALL", orderBy: "BY_BET", sortDir: "EARLIEST_TO_LATEST", fromRecord: 0, recordCount: 1000, includeItemDescription: true }, "betting"),
      rpc(session.token, session.appKey, "SportsAPING/v1.0/listClearedOrders", { betStatus: "SETTLED", settledDateRange: { from, to: now.toISOString() }, groupBy: "BET", includeItemDescription: true, locale: "it", fromRecord: 0, recordCount: 1000 }, "betting")
    ]);

    const settled = Array.isArray(cleared?.clearedOrders) ? cleared.clearedOrders : [];
    const open = Array.isArray(current?.currentOrders) ? current.currentOrders : [];
    const settledProfit = settled.reduce((sum, b) => sum + n(b.profit), 0);

    return res.status(200).json({
      ok: true,
      provider: "Betfair Exchange Italy",
      updatedAt: new Date().toISOString(),
      funds: {
        availableToBetBalance: n(funds?.availableToBetBalance),
        exposure: n(funds?.exposure),
        balance: n(funds?.balance),
        creditLimit: n(funds?.creditLimit),
        pointsBalance: n(funds?.pointsBalance)
      },
      period: { from, to: now.toISOString(), days: 31 },
      settled: { count: settled.length, profit: settledProfit, orders: settled.slice(0, 100) },
      currentOrders: { count: open.length, orders: open.slice(0, 100) }
    });
  } catch (error) {
    return res.status(502).json({ ok: false, provider: "Betfair Exchange Italy", error: error?.message || String(error) });
  }
}
