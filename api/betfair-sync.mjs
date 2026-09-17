const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BRIDGE_TOKEN = process.env.BETFAIR_BRIDGE_TOKEN || '';

function auth(req){
  const h = req.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers?.['x-betfair-bridge-token'] || '');
  return BRIDGE_TOKEN && token === BRIDGE_TOKEN;
}
async function supa(path, init={}){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { ...init, headers:{
    apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, 'Content-Type':'application/json', Prefer:'return=minimal', ...(init.headers||{})
  }});
  const text = await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Metodo non consentito'});
  if(!auth(req)) return res.status(401).json({ok:false,error:'Token bridge non valido'});
  if(!SUPA_URL || !SERVICE_KEY) return res.status(500).json({ok:false,error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});
  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const type = body.type;
    const payload = body.payload;
    if(!['catalogue','book'].includes(type) || !payload) return res.status(400).json({ok:false,error:'type deve essere catalogue o book'});
    const receivedAt = new Date().toISOString();
    if (type === 'book') {
      const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.result) ? payload.result : []);
      const markets = arr.filter(x => x?.marketId);
      if (!markets.length) throw new Error('Nessun marketId nel market book');
      for (const market of markets) {
        await supa('betfair_quotes', {method:'POST', body:JSON.stringify({market_id:market.marketId, data_type:'book', payload:market, received_at:receivedAt})});
      }
      return res.status(200).json({ok:true,type,markets:markets.length,receivedAt});
    }
    await supa('betfair_quotes', {method:'POST', body:JSON.stringify({market_id:null, data_type:type, payload, received_at:receivedAt})});
    return res.status(200).json({ok:true,type,receivedAt});
  }catch(e){ return res.status(500).json({ok:false,error:String(e?.message||e)}); }
}
