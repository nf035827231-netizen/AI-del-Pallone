// Riceve dal bridge locale i dati REALI del conto Betfair (saldo, scommesse liquidate,
// scommesse aperte) e li salva su Supabase in una tabella separata da betfair_quotes
// (quella è dati di mercato pubblici; questa è dati personali del conto — separazione
// intenzionale). Stesso schema di autenticazione di betfair-sync.mjs.

const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BRIDGE_TOKEN = process.env.BETFAIR_BRIDGE_TOKEN || '';

function auth(req){
  const h = req.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers?.['x-betfair-bridge-token'] || '');
  return BRIDGE_TOKEN && token === BRIDGE_TOKEN;
}

async function supa(path, init={}){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers:{
      apikey:SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`,
      'Content-Type':'application/json',
      Prefer:'return=minimal',
      ...(init.headers||{})
    }
  });
  const text = await r.text();
  if(!r.ok){
    console.error("BETFAIR ACCOUNT SYNC — SUPABASE ERROR:", r.status, text);
    throw new Error(`Supabase ${r.status}: ${text}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text || null; }
}

// Betfair impacchetta ogni risposta in un envelope JSON-RPC: [{jsonrpc,id,result:...}].
// Unwrap una volta sola, tenendo sia il caso "result è un oggetto" (getAccountFunds)
// che "result è un array" (listClearedOrders/listCurrentOrders).
function unwrapRpcResult(payload){
  const item = Array.isArray(payload) ? payload[0] : payload;
  return item?.result ?? null;
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');

  if(req.method!=='POST')
    return res.status(405).json({ok:false,error:'Metodo non consentito'});
  if(!auth(req))
    return res.status(401).json({ok:false,error:'Token bridge non valido'});
  if(!SUPA_URL || !SERVICE_KEY)
    return res.status(500).json({ok:false,error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const type = body.type;
    const payload = body.payload;

    if(!['funds','clearedOrders','currentOrders'].includes(type) || !payload)
      return res.status(400).json({ok:false,error:'type deve essere funds, clearedOrders o currentOrders'});

    const result = unwrapRpcResult(payload);
    if(result==null)
      return res.status(400).json({ok:false,error:'Risposta Betfair senza "result" riconoscibile'});

    const receivedAt = new Date().toISOString();

    // Una sola riga per tipo: ogni nuova sincronizzazione sostituisce la precedente
    // (non serve tenere uno storico di ogni singolo saldo/lista, solo l'ultimo).
    await supa(`betfair_account?on_conflict=data_type`, {
      method:'POST',
      headers:{ Prefer:'resolution=merge-duplicates,return=minimal' },
      body:JSON.stringify({ data_type:type, payload:result, received_at:receivedAt })
    });

    return res.status(200).json({ok:true,type,receivedAt});
  }catch(e){
    console.error("BETFAIR ACCOUNT SYNC ERROR:", e);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
