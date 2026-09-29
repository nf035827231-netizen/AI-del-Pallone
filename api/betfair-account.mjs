// Dati REALI del conto Betfair: saldo, scommesse liquidate, scommesse aperte.
// GET  → lettura pulita per la pagina Bilancio (era betfair-account.mjs).
// POST → scrittura dal bridge locale (era betfair-account-sync.mjs).
// Accorpati in un solo file per restare sotto il limite di funzioni serverless
// del piano Vercel gratuito.

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
    console.error("BETFAIR ACCOUNT — SUPABASE ERROR:", r.status, text);
    throw new Error(`Supabase ${r.status}: ${text}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text || null; }
}

async function supaRead(path){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` }
  });
  const text = await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,300)}`);
  return text ? JSON.parse(text) : [];
}

function round2(x){ const n=Number(x); return Number.isFinite(n)?Math.round(n*100)/100:null; }

function unwrapRpcResult(payload){
  const item = Array.isArray(payload) ? payload[0] : payload;
  return item?.result ?? null;
}

function adaptClearedOrder(o){
  return {
    betId:o.betId,
    market:o.itemDescription?.marketDesc||o.marketDesc||null,
    event:o.itemDescription?.eventDesc||null,
    runner:o.itemDescription?.runnerDesc||null,
    outcome:o.betOutcome||null,
    odds:round2(o.priceMatched),
    stake:round2(o.sizeSettled),
    profit:round2(o.profit),
    placedDate:o.placedDate||null,
    settledDate:o.settledDate||null
  };
}

function adaptCurrentOrder(o){
  return {
    betId:o.betId,
    marketId:o.marketId,
    selectionId:o.selectionId,
    side:o.side||null,
    status:o.status||null,
    odds:round2(o.priceSize?.price ?? o.averagePriceMatched),
    stake:round2(o.priceSize?.size ?? o.sizeRemaining),
    sizeMatched:round2(o.sizeMatched),
    placedDate:o.placedDate||null
  };
}

async function handleGet(req,res){
  const rows = await supaRead('betfair_account?select=data_type,payload,received_at');
  const byType = Object.fromEntries(rows.map(r=>[r.data_type,r]));

  const fundsRow = byType.funds;
  const funds = fundsRow ? {
    availableToBetBalance: round2(fundsRow.payload?.availableToBetBalance),
    exposure: round2(fundsRow.payload?.exposure),
    retainedCommission: round2(fundsRow.payload?.retainedCommission),
    exposureLimit: round2(fundsRow.payload?.exposureLimit),
    receivedAt: fundsRow.received_at
  } : null;

  const clearedRow = byType.clearedOrders;
  const clearedRaw = Array.isArray(clearedRow?.payload?.clearedOrders) ? clearedRow.payload.clearedOrders : [];
  const clearedOrders = clearedRaw.map(adaptClearedOrder).sort((a,b)=>new Date(b.settledDate||0)-new Date(a.settledDate||0));
  const wins = clearedOrders.filter(o=>o.outcome==='WON').length;
  const losses = clearedOrders.filter(o=>o.outcome==='LOST').length;
  const totalProfit = round2(clearedOrders.reduce((s,o)=>s+(o.profit||0),0));

  const currentRow = byType.currentOrders;
  const currentRaw = Array.isArray(currentRow?.payload?.currentOrders) ? currentRow.payload.currentOrders : [];
  const currentOrders = currentRaw.map(adaptCurrentOrder);

  return res.status(200).json({
    funds,
    clearedOrders: { items:clearedOrders, count:clearedOrders.length, wins, losses, totalProfit, receivedAt:clearedRow?.received_at||null },
    currentOrders: { items:currentOrders, count:currentOrders.length, receivedAt:currentRow?.received_at||null },
    disclaimer:'Dati reali dal tuo conto Betfair, sincronizzati dal bridge locale. Lo storico copre gli ultimi 90 giorni.'
  });
}

async function handlePost(req,res){
  if(!auth(req))
    return res.status(401).json({ok:false,error:'Token bridge non valido'});

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const type = body.type;
  const payload = body.payload;

  if(!['funds','clearedOrders','currentOrders'].includes(type) || !payload)
    return res.status(400).json({ok:false,error:'type deve essere funds, clearedOrders o currentOrders'});

  const result = unwrapRpcResult(payload);
  if(result==null)
    return res.status(400).json({ok:false,error:'Risposta Betfair senza "result" riconoscibile'});

  const receivedAt = new Date().toISOString();
  await supa(`betfair_account?on_conflict=data_type`, {
    method:'POST',
    headers:{ Prefer:'resolution=merge-duplicates,return=minimal' },
    body:JSON.stringify({ data_type:type, payload:result, received_at:receivedAt })
  });

  return res.status(200).json({ok:true,type,receivedAt});
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(!SUPA_URL || !SERVICE_KEY)
    return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  try{
    if(req.method==='POST') return await handlePost(req,res);
    if(req.method==='GET') return await handleGet(req,res);
    return res.status(405).json({ok:false,error:'Metodo non consentito'});
  }catch(e){
    console.error("BETFAIR ACCOUNT ERROR:", e);
    return res.status(500).json({error:e?.message||String(e)});
  }
}

