const SUPA_URL=process.env.SUPABASE_URL||'';
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||'';

async function supa(path){const r=await fetch(`${SUPA_URL}/rest/v1/${path}`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});const t=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${t}`);return t?JSON.parse(t):[];}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();}
function teamKey(s){let n=normalize(s);const aliases={inter:'internazionale','inter milan':'internazionale','internazionale milano':'internazionale','ac milan':'milan','hellas verona':'verona','as roma':'roma','ss lazio':'lazio','ssc napoli':'napoli','juventus fc':'juventus'};n=aliases[n]||n;return n.replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the|ss|as|ssc|cfc|bk|sv)\b/g,' ').replace(/\s+/g,' ').trim();}
function clean(s){return teamKey(s).replace(/\b\d{2,4}\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function pair(a,b){return `${clean(a)}|${clean(b)}`;}
function sim(a,b){const aa=teamKey(a),bb=teamKey(b);if(!aa||!bb)return 0;if(aa===bb)return 1;if(aa.includes(bb)||bb.includes(aa))return .95;const A=new Set(aa.split(' ').filter(x=>x.length>2)),B=new Set(bb.split(' ').filter(x=>x.length>2));let c=0;for(const x of A)if(B.has(x))c++;return c?Math.max(c/(A.size+B.size-c),(c/Math.min(A.size,B.size))*.93):0;}
function teams(name){const p=String(name||'').split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);return p.length>=2?{home:p[0].trim(),away:p.slice(1).join(' ').trim()}:null;}
function walk(v,cb){if(v==null||typeof v!=='object')return;cb(v);if(Array.isArray(v))for(const x of v)walk(x,cb);else for(const x of Object.values(v))walk(x,cb);}
function catalogue(payload){const out=[];walk(payload,v=>{if(v?.marketId&&v?.marketName)out.push(v);});return out;}
function books(payload){const out=[];walk(payload,v=>{if(v&&v.selectionId!=null&&('status' in v||v.ex))out.push(v);});return out;}
function bestBack(r){const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.map(x=>Number(x?.price)).filter(x=>x>1&&Number.isFinite(x)).sort((a,b)=>b-a)[0]??null;}
function matchEvent(home,away,markets){const target=pair(home,away);let best=[];let score=0;for(const m of markets){const t=teams(m?.event?.name);if(!t)continue;const k=pair(t.home,t.away);if(k===target)return [m];const direct=(sim(home,t.home)+sim(away,t.away))/2;const reverse=(sim(home,t.away)+sim(away,t.home))/2;const s=Math.max(direct,reverse);if(s>=.60&&s>score){score=s;best=[m];}else if(s>=.60&&Math.abs(s-score)<.001)best.push(m);}return best;}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'Metodo non consentito'});
  const u=new URL(req.url,'https://vercel.local');const home=u.searchParams.get('home');const away=u.searchParams.get('away');
  if(!home||!away)return res.status(400).json({ok:false,error:'home e away obbligatori'});
  if(!SUPA_URL||!SERVICE_KEY)return res.status(500).json({ok:false,error:'Supabase service key non configurata'});
  try{
    const [catRows,bookRows]=await Promise.all([
      supa('betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=20'),
      supa('betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=5000')
    ]);
    const latest=new Map();for(const r of bookRows){if(r?.market_id&&!latest.has(String(r.market_id)))latest.set(String(r.market_id),r);}
    const cats=[];for(const row of catRows)for(const m of catalogue(row.payload)){const b=latest.get(String(m.marketId));if(!b)continue;cats.push({...m,_receivedAt:b.received_at,_book:b.payload});}
    const matched=matchEvent(home,away,cats);
    if(!matched.length)return res.status(404).json({ok:false,error:'Mercato Betfair non trovato',home,away});
    const output=[];
    for(const m of matched){
      const name=String(m.marketName||'');const isMatch=/match odds|1x2|esito finale/i.test(name);const line=name.match(/(?:under\s*\/\s*over|over\s*\/\s*under|under.*over|over.*under).*?(1\.5|2\.5|3\.5|4\.5)/i)?.[1];
      if(!isMatch&&!['2.5','3.5'].includes(line))continue;
      const cr=Array.isArray(m.runners)?m.runners:[];const br=books(m._book);const rows=br.map(r=>({selectionId:r.selectionId,name:cr.find(x=>String(x?.selectionId)===String(r.selectionId))?.runnerName||String(r.selectionId),status:r.status,backPrice:bestBack(r),backSize:Array.isArray(r?.ex?.availableToBack)?Number(r.ex.availableToBack[0]?.size)||null:null}));
      output.push({marketId:m.marketId,marketName:name,event:m.event,competition:m.competition,runners:rows,receivedAt:m._receivedAt});
    }
    return res.status(200).json({ok:true,event:matched[0].event,competition:matched[0].competition,markets:output,matchScore:1});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
