// V155: liquida i pronostici passati salvati in model_predictions e calcola
// le statistiche reali del modello (win rate, ROI, calibrazione edge).
// Nessun numero qui è deciso a tavolino: viene tutto dai risultati reali ESPN.
import { evaluateMarket, resolveMatchScore } from './settle-bet.mjs';

// (mappa campionati->slug ESPN non più necessaria qui: la usa resolveMatchScore in settle-bet.mjs)

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
    const settledRows=rows.filter(r=>r.settled&&(r.result==='win'||r.result==='loss'));
    const calibration=await updateCalibration(supaUrl,serviceKey,settledRows);
    return res.status(200).json({sinceDate:since,justSettled:settledCount,totalLogged:rows.length,...stats,calibration,disclaimer:'Statistiche calcolate sui pronostici realmente mostrati in passato dal modello. Le performance passate non garantiscono risultati futuri.'});
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

async function supaWrite(url,key,path,rows){
  const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
  if(!r.ok){const t=await r.text();throw new Error(`Supabase write ${r.status}: ${t.slice(0,300)}`);}
}

// Sotto questa soglia di giocate liquidate, un aggiustamento della calibrazione sarebbe
// rumore statistico, non un segnale reale: si resta sul fattore neutro (1.0, nessuna
// correzione) finché non si raggiunge un campione minimamente affidabile.
const MIN_SETTLED_FOR_CALIBRATION=30;

// Calcola quanto il modello (la sua stima pura, prob_model, non quella già mescolata col
// mercato) si è storicamente discostato dalla realtà, e salva un fattore correttivo che
// pick.mjs userà per fidarsi un po' di più o un po' meno di se stesso in futuro. Il fattore
// resta sempre dentro un range prudente (0.6-1.3): non deve mai poter ribaltare da solo
// il comportamento del modello, solo affinarlo gradualmente.
async function updateCalibration(url,key,settled){
  const withModelProb=settled.filter(r=>Number.isFinite(Number(r.prob_model)));
  if(withModelProb.length<MIN_SETTLED_FOR_CALIBRATION){
    return {applied:false,settledCount:withModelProb.length,minRequired:MIN_SETTLED_FOR_CALIBRATION,factor:1};
  }
  const wins=withModelProb.filter(r=>r.result==='win').length;
  const actualWinRate=wins/withModelProb.length;
  const avgPredicted=withModelProb.reduce((s,r)=>s+Number(r.prob_model)/100,0)/withModelProb.length;
  const rawFactor=avgPredicted>0?actualWinRate/avgPredicted:1;
  const factor=Math.max(0.6,Math.min(1.3,rawFactor));
  try{
    await supaWrite(url,key,'model_calibration?on_conflict=id',[{
      id:'global',factor,settled_count:withModelProb.length,actual_win_rate:Math.round(actualWinRate*1000)/10,
      avg_predicted_prob:Math.round(avgPredicted*1000)/10,updated_at:new Date().toISOString()
    }]);
  }catch{ /* se il salvataggio fallisce, pick.mjs userà il fattore neutro salvato in precedenza (o 1.0) */ }
  return {applied:true,settledCount:withModelProb.length,factor:Math.round(factor*1000)/1000,actualWinRate:Math.round(actualWinRate*1000)/10,avgPredictedProb:Math.round(avgPredicted*1000)/10};
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
  const fixtureId=String(row.event_id||'');
  if(!fixtureId) return null;
  const score=await resolveMatchScore(fixtureId,row.league_code||'');
  if(score.error||!score.completed) return null; // non trovata o non ancora conclusa: si riprova più avanti
  const {homeGoals:hg,awayGoals:ag}=score;
  if(!Number.isFinite(hg)||!Number.isFinite(ag)) return null;
  return evaluateMarket(row.market,hg,ag);
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
