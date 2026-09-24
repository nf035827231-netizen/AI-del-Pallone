// Legge l'ultimo saldo + storico scommesse reali sincronizzati dal bridge e li restituisce
// in un formato pulito, pronto per la pagina Bilancio. Sola lettura, nessuna scrittura qui.

const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function supaRead(path){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` }
  });
  const text = await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,300)}`);
  return text ? JSON.parse(text) : [];
}

function round2(x){ const n=Number(x); return Number.isFinite(n)?Math.round(n*100)/100:null; }

// Un item di listClearedOrders ha (tra gli altri) questi campi principali:
// betId, marketId, selectionId, betOutcome ('WON'|'LOST'), placedDate, settledDate,
// priceMatched, sizeSettled, profit, itemDescription:{eventDesc, marketDesc, runnerDesc, ...}
function adaptClearedOrder(o){
  return {
    betId:o.betId,
    market:o.itemDescription?.marketDesc||o.marketDesc||null,
    event:o.itemDescription?.eventDesc||null,
    runner:o.itemDescription?.runnerDesc||null,
    outcome:o.betOutcome||null, // 'WON' | 'LOST'
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
    side:o.side||null, // 'BACK' | 'LAY'
    status:o.status||null, // 'EXECUTION_COMPLETE' | 'EXECUTABLE'
    odds:round2(o.priceSize?.price ?? o.averagePriceMatched),
    stake:round2(o.priceSize?.size ?? o.sizeRemaining),
    sizeMatched:round2(o.sizeMatched),
    placedDate:o.placedDate||null
  };
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(!SUPA_URL || !SERVICE_KEY)
    return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  try{
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
  }catch(e){
    return res.status(500).json({error:e?.message||String(e)});
  }
}
