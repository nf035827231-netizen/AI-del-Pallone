const SUPA_URL=process.env.SUPABASE_URL||"";
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||"";

function norm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();}
function clean(s){return norm(s).replace(/\b(fc|cf|afc|calcio|ac|as|ssc|cfc|fk|sk|sv|bk)\b/g,"").replace(/[^a-z0-9]+/g,"").trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function unwrap(payload){const out=[];const walk=v=>{if(Array.isArray(v)){for(const x of v)walk(x);return;}if(v&&typeof v==='object'){if(Array.isArray(v.result)){for(const x of v.result)walk(x);return;}if(v.marketId)out.push(v);}};walk(payload);return out;}
function bestBack(r){const list=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];const v=list.map(x=>({p:Number(x?.price),s:Number(x?.size)})).filter(x=>x.p>1&&Number.isFinite(x.p));v.sort((a,b)=>b.p-a.p);return v[0]?.p??null;}
async function supa(path){const r=await fetch(`${SUPA_URL}/rest/v1/${path}`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});const t=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${t}`);return t?JSON.parse(t):[];}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(!SUPA_URL||!SERVICE_KEY)return res.status(500).json({error:"SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata"});
  const u=new URL(req.url,"https://vercel.local");
  const eventId=u.searchParams.get("eventId");
  const market=u.searchParams.get("market");
  const home=u.searchParams.get("home");
  const away=u.searchParams.get("away");
  if(!market||!home||!away)return res.status(400).json({error:"Parametri home, away e market richiesti"});
  try{
    const [catRows,bookRows]=await Promise.all([
      supa('betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1'),
      supa('betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=500')
    ]);
    const latestBook=new Map();for(const r of bookRows){if(r?.market_id&&!latestBook.has(String(r.market_id)))latestBook.set(String(r.market_id),r);}
    const cat=unwrap(catRows[0]?.payload);
    const target=normalizePair(home,away);
    let found=null;
    for(const m of cat){
      const eventName=String(m?.event?.name||"");
      const parts=eventName.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);
      const pair=parts.length>=2?normalizePair(parts[0],parts.slice(1).join(" ")):null;
      if(pair!==target)continue;
      const name=String(m.marketName||"");
      const isMatch=/match odds|1x2|esito finale/i.test(name);
      const lineMatch=name.match(/(?:under\s*\/\s*over|over\s*\/\s*under|under.*over|over.*under)[^0-9]*(0\.5|1\.5|2\.5|3\.5|4\.5)/i);
      let value=null;
      if(isMatch){
        if(market==="1 (Casa)")value="1";else if(market==="X (Pareggio)")value="X";else if(market==="2 (Trasferta)")value="2";else value=market;
      }else if(lineMatch){value=market;}
      if(value==null)continue;
      const book=latestBook.get(String(m.marketId));if(!book)continue;
      const runners=Array.isArray(book.payload?.runners)?book.payload.runners:[];
      const cr=Array.isArray(m.runners)?m.runners:[];
      for(const r of runners){
        const nameR=String(cr.find(x=>String(x?.selectionId)===String(r?.selectionId))?.runnerName||r?.selectionId||"");
        const n=norm(nameR);let v=null;
        if(isMatch){
          if(value==="1"&&(n===norm(home)||n.includes(norm(home))))v="1";
          else if(value==="2"&&(n===norm(away)||n.includes(norm(away))))v="2";
          else if(value==="X"&&/^(the )?draw$|^x$|pareggio|tie$/.test(n))v="X";
        }else if(/over/i.test(nameR)&&market.toLowerCase().startsWith("over"))v=market;
        else if(/under/i.test(nameR)&&market.toLowerCase().startsWith("under"))v=market;
        const p=bestBack(r);
        if(v===value&&p!=null)return res.status(200).json({eventId,market,odds:p,fetchedAt:Date.now(),source:"Betfair Exchange"});
      }
    }
    return res.status(200).json({eventId,market,odds:null,fetchedAt:Date.now(),source:"Betfair Exchange",note:"Nessuna quota BACK Betfair disponibile."});
  }catch(e){return res.status(200).json({eventId,market,odds:null,fetchedAt:Date.now(),source:"Betfair Exchange",error:String(e?.message||e)});}
}
