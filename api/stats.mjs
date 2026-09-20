// V155: liquida i pronostici passati salvati in model_predictions e calcola
// le statistiche reali del modello (win rate, ROI, calibrazione edge).
// Nessun numero qui è deciso a tavolino: viene tutto dai risultati reali ESPN.
import { evaluateMarket } from './settle-bet.mjs';

const LEAGUES={SA:'ita.1',SB:'ita.2',PL:'eng.1',PD:'esp.1',BL1:'ger.1',FL1:'fra.1',PPL:'por.1',DED:'ned.1',BEL1:'bel.1',SCO1:'sco.1',AUT1:'aut.1',TUR1:'tur.1',DEN1:'den.1',SWE1:'swe.1',NOR1:'nor.1',POL1:'pol.1',GRE1:'gre.1',ROU1:'rou.1',UKR1:'ukr.1',SUI1:'sui.1',CL:'uefa.champions',EL:'uefa.europa',ECL:'uefa.europa.conference',BRA1:'bra.1',MLS1:'usa.1',JPN1:'jpn.1'};

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const supaUrl=process.env.SUPABASE_URL||'';
    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
    if(!supaUrl||!serviceKey) return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});
    const u=new URL(req.url,'https://vercel.local');
    const days=Math.min(365,Math.max(1,Number(u.searchParams.get('days'))||90));
    const since=new Date(Date.now()-days*86400000).toISOString().slice(0,10);

    const settledCount=await settlePending(supaUrl,serviceKey);

    const rows=await supaRead(supaUrl,serviceKey,`model_predictions?select=*&match_date=gte.${since}&order=match_date.desc&limit=5000`);
    const stats=computeStats(rows);
    return res.status(200).json({sinceDate:since,justSettled:settledCount,totalLogged:rows.length,...stats,disclaimer:'Statistiche calcolate sui pronostici realmente mostrati in passato dal modello. Le performance passate non garantiscono risultati futuri.'});
  }catch(e){
    return res.status(500).json({error:e?.message||String(e)});
  }
}

async function supaRead(url,key,path){
  const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
  const text=await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);
  return text?JSON.parse(text):[];
}

async function supaPatch(url,key,path,body){
  const r=await fetch(`${url}/rest/v1/${path}`,{method:'PATCH',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(body)});
  if(!r.ok){const t=await r.text();throw new Error(`Supabase patch ${r.status}: ${t.slice(0,300)}`);}
}

// Liquida al massimo 60 pronostici non ancora chiusi per chiamata, per restare veloci;
// una chiamata ripetuta (es. cron giornaliero) smaltisce la coda nel tempo.
async function settlePending(url,key){
  const cutoff=new Date(Date.now()-2*3600000).toISOString(); // margine di 2h dal calcio d'inizio
  const pending=await supaRead(url,key,`model_predictions?select=id,event_id,league_code,market&settled=eq.false&kickoff=lt.${encodeURIComponent(cutoff)}&limit=60`);
  let settled=0;
  for(const row of pending){
    const outcome=await settleOne(row);
    if(!outcome) continue;
    await supaPatch(url,key,`model_predictions?id=eq.${row.id}`,{settled:true,result:outcome,settled_at:new Date().toISOString()});
    settled++;
  }
  return settled;
}

async function settleOne(row){
  const id=String(row.event_id||'').replace(/^espn-/,'');
  if(!/^\d+$/.test(id)) return null;
  const slugs=row.league_code&&LEAGUES[row.league_code]?[LEAGUES[row.league_code]]:Object.values(LEAGUES);
  for(const slug of slugs){
    try{
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(id)}`,{headers:{Accept:'application/json','User-Agent':'AI-del-Pallone/155'}});
      if(!r.ok) continue;
      const m=await r.json();
      const c=Array.isArray(m?.header?.competitions)?m.header.competitions[0]:null;
      const comps=Array.isArray(c?.competitors)?c.competitors:[];
      const home=comps.find(x=>x.homeAway==='home'), away=comps.find(x=>x.homeAway==='away');
      if(!home||!away) continue;
      const completed=Boolean(c?.status?.type?.completed);
      if(!completed) return null; // non ancora conclusa, riprovare più avanti
      const hg=Number(home.score), ag=Number(away.score);
      if(!Number.isFinite(hg)||!Number.isFinite(ag)) return null;
      return evaluateMarket(row.market,hg,ag);
    }catch{ /* prova il prossimo slug/campionato */ }
  }
  return null;
}

function computeStats(rows){
  const settled=rows.filter(r=>r.settled&&(r.result==='win'||r.result==='loss'));
  const pending=rows.length-settled.length;
  const overall=summarize(settled);
  const byEdgeSign=[
    {label:'Edge positivo (modello sopra la quota)',...summarize(settled.filter(r=>Number(r.edge_percent)>0))},
    {label:'Edge negativo o nullo',...summarize(settled.filter(r=>!(Number(r.edge_percent)>0)))}
  ];
  const byMarketMap=new Map();
  for(const r of settled){
    const k=String(r.market||'—');
    if(!byMarketMap.has(k)) byMarketMap.set(k,[]);
    byMarketMap.get(k).push(r);
  }
  const byMarket=[...byMarketMap.entries()].map(([market,items])=>({market,...summarize(items)})).sort((a,b)=>b.count-a.count);
  return {pendingSettlement:pending,settledCount:settled.length,overall,byEdgeSign,byMarket};
}

function summarize(rows){
  const count=rows.length;
  if(!count) return {count:0,wins:0,winRate:null,avgOdds:null,roiPercent:null};
  const wins=rows.filter(r=>r.result==='win').length;
  const avgOdds=round(rows.reduce((s,r)=>s+(Number(r.odds)||0),0)/count);
  // ROI a puntata flat da 1 unità: vincita = odds-1, perdita = -1
  const pnl=rows.reduce((s,r)=>s+(r.result==='win'?(Number(r.odds)||1)-1:-1),0);
  return {count,wins,winRate:round(wins/count*100),avgOdds,roiPercent:round(pnl/count*100)};
}

function round(x){return Math.round(x*10)/10;}
