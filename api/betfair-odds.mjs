const SUPA_URL=process.env.SUPABASE_URL||'';
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
async function supa(path){const r=await fetch(`${SUPA_URL}/rest/v1/${path}`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});const t=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${t}`);return t?JSON.parse(t):[]}
function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
function extractMarkets(rows){const out=[];for(const r of rows){const p=r.payload;const arr=Array.isArray(p)?p:(Array.isArray(p?.result)?p.result:[]);for(const m of arr){if(m?.marketId)out.push({...m,received_at:r.received_at})}}return out}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'Metodo non consentito'});
 const u=new URL(req.url,'https://vercel.local'); const home=norm(u.searchParams.get('home')); const away=norm(u.searchParams.get('away'));
 if(!home||!away)return res.status(400).json({ok:false,error:'home e away obbligatori'});
 if(!SUPA_URL||!SERVICE_KEY)return res.status(500).json({ok:false,error:'Supabase service key non configurata'});
 try{
  const rows=await supa('betfair_quotes?select=id,data_type,payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=20');
  const markets=extractMarkets(rows);
  let found=null;
  for(const m of markets){const n=norm(m.event?.name);if((n.includes(home)&&n.includes(away))||(n.includes(away)&&n.includes(home))){found=m;break;}}
  if(!found)return res.status(404).json({ok:false,error:'Mercato Betfair non trovato',home,away});
  const books=await supa(`betfair_quotes?select=payload,received_at&data_type=eq.book&market_id=eq.${encodeURIComponent(found.marketId)}&order=received_at.desc&limit=1`);
  const book=books[0]?.payload||null;
  return res.status(200).json({ok:true,marketId:found.marketId,event:found.event,competition:found.competition,marketName:found.marketName,book,receivedAt:books[0]?.received_at||found.received_at});
 }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
