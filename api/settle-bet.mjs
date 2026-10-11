// V157: settlement multi-fonte. Il fixtureId salvato con la giocata porta un prefisso che
// dice da quale fonte è nata la partita (espn-, fd- per football-data.org, af- per
// API-Football): prima si guardava solo il prefisso "espn-", scartando come "non
// riconosciute" tutte le giocate nate da football-data.org — che oggi è la fonte primaria
// per la maggior parte dei campionati. Qui si gestiscono tutte e tre.
//
// GET ?fixtureId=&market=       → verifica il risultato di UNA giocata (comportamento originale)
// GET ?mode=stats[&days=90]     → statistiche aggregate + calibrazione (era stats.mjs,
//                                  accorpato qui per il limite di funzioni Vercel)
const ESPN_SLUGS={SA:'ita.1',SB:'ita.2',PL:'eng.1',PD:'esp.1',BL1:'ger.1',FL1:'fra.1',PPL:'por.1',DED:'ned.1',BEL1:'bel.1',SCO1:'sco.1',AUT1:'aut.1',TUR1:'tur.1',DEN1:'den.1',SWE1:'swe.1',NOR1:'nor.1',POL1:'pol.1',GRE1:'gre.1',ROU1:'rou.1',UKR1:'ukr.1',SUI1:'sui.1',CL:'uefa.champions',EL:'uefa.europa',ECL:'uefa.europa.conference'};

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const u=new URL(req.url,'https://vercel.local');

  if(u.searchParams.get('mode')==='stats'){
    return handleStats(res,u);
  }

  const fixtureId=u.searchParams.get('fixtureId'); const market=u.searchParams.get('market');
  const leagueCode=u.searchParams.get('leagueCode')||'';
  if(!fixtureId||!market)return res.status(400).json({error:'Parametri fixtureId e market richiesti'});

  const score=await resolveMatchScore(String(fixtureId),leagueCode);
  if(score.error)return res.status(200).json({settled:false,reason:score.error});
  if(!score.completed)return res.status(200).json({settled:false,reason:'Partita non ancora conclusa'});
  const {homeGoals:hg,awayGoals:ag}=score;
  if(!Number.isFinite(hg)||!Number.isFinite(ag))return res.status(200).json({settled:false,reason:'Risultato finale non disponibile'});
  const result=evaluateMarket(market,hg,ag);
  if(result==null)return res.status(200).json({settled:false,reason:`Mercato "${market}" non riconosciuto automaticamente`,homeGoals:hg,awayGoals:ag});
  return res.status(200).json({settled:true,result,homeGoals:hg,awayGoals:ag});
}

// --- Statistiche aggregate + calibrazione (ex stats.mjs) ---------------------------------
async function handleStats(res,u){
  try{
    const supaUrl=process.env.SUPABASE_URL||'';
    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
    if(!supaUrl||!serviceKey) return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});
    const days=Math.min(365,Math.max(1,Number(u.searchParams.get('days'))||90));
    const since=new Date(Date.now()-days*86400000).toISOString().slice(0,10);

    const settledCount=await settlePending(supaUrl,serviceKey);

    const rows=await supaReadStats(supaUrl,serviceKey,`model_predictions?select=*&match_date=gte.${since}&order=match_date.desc&limit=5000`);
    const stats=computeStats(rows);
    const settledRows=rows.filter(r=>r.settled&&(r.result==='win'||r.result==='loss'));
    const calibration=await updateCalibration(supaUrl,serviceKey,settledRows);
    return res.status(200).json({sinceDate:since,justSettled:settledCount,totalLogged:rows.length,...stats,calibration,disclaimer:'Statistiche calcolate sui pronostici realmente mostrati in passato dal modello. Le performance passate non garantiscono risultati futuri.'});
  }catch(e){
    return res.status(500).json({error:e?.message||String(e)});
  }
}

async function supaReadStats(url,key,path){
  const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
  const text=await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);
  return text?JSON.parse(text):[];
}

async function supaPatchStats(url,key,path,body){
  const r=await fetch(`${url}/rest/v1/${path}`,{method:'PATCH',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(body)});
  if(!r.ok){const t=await r.text();throw new Error(`Supabase patch ${r.status}: ${t.slice(0,300)}`);}
}

async function supaWriteStats(url,key,path,rows){
  const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
  if(!r.ok){const t=await r.text();throw new Error(`Supabase write ${r.status}: ${t.slice(0,300)}`);}
}

// Sotto questa soglia di giocate liquidate, un aggiustamento della calibrazione sarebbe
// rumore statistico, non un segnale reale: si resta sul fattore neutro (1.0, nessuna
// correzione) finché non si raggiunge un campione minimamente affidabile.
const MIN_SETTLED_FOR_CALIBRATION=30;

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
    await supaWriteStats(url,key,'model_calibration?on_conflict=id',[{
      id:'global',factor,settled_count:withModelProb.length,actual_win_rate:Math.round(actualWinRate*1000)/10,
      avg_predicted_prob:Math.round(avgPredicted*1000)/10,updated_at:new Date().toISOString()
    }]);
  }catch{ /* se il salvataggio fallisce, pick.mjs userà il fattore neutro salvato in precedenza (o 1.0) */ }
  return {applied:true,settledCount:withModelProb.length,factor:Math.round(factor*1000)/1000,actualWinRate:Math.round(actualWinRate*1000)/10,avgPredictedProb:Math.round(avgPredicted*1000)/10};
}

async function settlePending(url,key){
  const cutoff=new Date(Date.now()-2*3600000).toISOString();
  const pending=await supaReadStats(url,key,`model_predictions?select=id,event_id,league_code,market&settled=eq.false&kickoff=lt.${encodeURIComponent(cutoff)}&limit=60`);
  let settled=0;
  for(const row of pending){
    const fixtureId=String(row.event_id||'');
    if(!fixtureId) continue;
    const score=await resolveMatchScore(fixtureId,row.league_code||'');
    if(score.error||!score.completed) continue;
    const {homeGoals:hg,awayGoals:ag}=score;
    if(!Number.isFinite(hg)||!Number.isFinite(ag)) continue;
    const outcome=evaluateMarket(row.market,hg,ag);
    if(!outcome) continue;
    await supaPatchStats(url,key,`model_predictions?id=eq.${row.id}`,{settled:true,result:outcome,settled_at:new Date().toISOString()});
    settled++;
  }
  return settled;
}

function computeStats(rows){
  const settled=rows.filter(r=>r.settled&&(r.result==='win'||r.result==='loss'));
  const pending=rows.length-settled.length;
  const overall=summarizeStats(settled);
  const byEdgeSign=[
    {label:'Edge positivo (modello sopra la quota)',...summarizeStats(settled.filter(r=>Number(r.edge_percent)>0))},
    {label:'Edge negativo o nullo',...summarizeStats(settled.filter(r=>!(Number(r.edge_percent)>0)))}
  ];
  const byMarketMap=new Map();
  for(const r of settled){
    const k=String(r.market||'—');
    if(!byMarketMap.has(k)) byMarketMap.set(k,[]);
    byMarketMap.get(k).push(r);
  }
  const byMarket=[...byMarketMap.entries()].map(([market,items])=>({market,...summarizeStats(items)})).sort((a,b)=>b.count-a.count);
  return {pendingSettlement:pending,settledCount:settled.length,overall,byEdgeSign,byMarket};
}

function summarizeStats(rows){
  const count=rows.length;
  if(!count) return {count:0,wins:0,winRate:null,avgOdds:null,roiPercent:null};
  const wins=rows.filter(r=>r.result==='win').length;
  const avgOdds=roundStats(rows.reduce((s,r)=>s+(Number(r.odds)||0),0)/count);
  const pnl=rows.reduce((s,r)=>s+(r.result==='win'?(Number(r.odds)||1)-1:-1),0);
  return {count,wins,winRate:roundStats(wins/count*100),avgOdds,roiPercent:roundStats(pnl/count*100)};
}

function roundStats(x){return Math.round(x*10)/10;}
// -------------------------------------------------------------------------------------

// Ritorna {completed,homeGoals,awayGoals} oppure {error}. Non lancia mai eccezioni:
// un problema con una fonte non deve mai far fallire l'intera richiesta.
export async function resolveMatchScore(fixtureId,leagueCode){
  if(fixtureId.startsWith('fd-')) return resolveFromFootballData(fixtureId.slice(3));
  if(fixtureId.startsWith('af-')) return resolveFromApiFootball(fixtureId.slice(3));
  const id=fixtureId.replace(/^espn-/,'');
  if(!/^\d+$/.test(id)) return {error:'Riferimento partita non riconosciuto'};
  return resolveFromEspn(id,leagueCode);
}

async function resolveFromEspn(id,leagueCode){
  const slugs=leagueCode&&ESPN_SLUGS[leagueCode]?[ESPN_SLUGS[leagueCode]]:Object.values(ESPN_SLUGS);
  try{
    for(const slug of slugs){
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(id)}`,{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'}});
      if(!r.ok)continue;
      const m=await r.json();
      const c=Array.isArray(m?.header?.competitions)?m.header.competitions[0]:null;
      const comps=Array.isArray(c?.competitors)?c.competitors:[];
      const home=comps.find(x=>x.homeAway==='home'),away=comps.find(x=>x.homeAway==='away');
      if(!home||!away)continue;
      const completed=Boolean(c?.status?.type?.completed);
      if(!completed)return {completed:false};
      return {completed:true,homeGoals:Number(home.score),awayGoals:Number(away.score)};
    }
    return {error:'Partita ESPN non trovata nel campionato indicato'};
  }catch(e){return {error:e?.message||String(e)};}
}

async function resolveFromFootballData(id){
  const key=process.env.FOOTBALL_DATA_TOKEN||process.env.FOOTBALL_DATA_KEY||'';
  if(!key)return {error:'FOOTBALL_DATA_TOKEN non configurata'};
  try{
    const r=await fetch(`https://api.football-data.org/v4/matches/${encodeURIComponent(id)}`,{headers:{'X-Auth-Token':key,Accept:'application/json'}});
    if(!r.ok)return {error:`football-data.org HTTP ${r.status}`};
    const m=await r.json();
    const status=String(m?.status||'').toUpperCase();
    if(status!=='FINISHED')return {completed:false};
    return {completed:true,homeGoals:Number(m?.score?.fullTime?.home),awayGoals:Number(m?.score?.fullTime?.away)};
  }catch(e){return {error:e?.message||String(e)};}
}

async function resolveFromApiFootball(id){
  const key=process.env.API_FOOTBALL_KEY||'';
  if(!key)return {error:'API_FOOTBALL_KEY non configurata'};
  try{
    const r=await fetch(`https://v3.football.api-sports.io/fixtures?id=${encodeURIComponent(id)}`,{headers:{'x-apisports-key':key,Accept:'application/json'}});
    if(!r.ok)return {error:`API-Football HTTP ${r.status}`};
    const body=await r.json();
    const item=Array.isArray(body?.response)?body.response[0]:null;
    if(!item)return {error:'Partita API-Football non trovata'};
    const short=String(item?.fixture?.status?.short||'').toUpperCase();
    if(!['FT','AET','PEN'].includes(short))return {completed:false};
    return {completed:true,homeGoals:Number(item?.goals?.home),awayGoals:Number(item?.goals?.away)};
  }catch(e){return {error:e?.message||String(e)};}
}

export function evaluateMarket(market,hg,ag){const total=hg+ag,m=String(market||'');if(m.startsWith('1'))return hg>ag?'win':'loss';if(m.startsWith('2'))return ag>hg?'win':'loss';if(m.startsWith('X'))return hg===ag?'win':'loss';if(m==='Over 1.5')return total>1.5?'win':'loss';if(m==='Under 1.5')return total<1.5?'win':'loss';if(m==='Over 2.5')return total>2.5?'win':'loss';if(m==='Under 2.5')return total<2.5?'win':'loss';if(m==='Over 3.5')return total>3.5?'win':'loss';if(m==='Under 3.5')return total<3.5?'win':'loss';if(m==='Over 4.5')return total>4.5?'win':'loss';if(m==='Under 4.5')return total<4.5?'win':'loss';if(m==='Goal')return hg>0&&ag>0?'win':'loss';if(m==='No Goal')return hg===0||ag===0?'win':'loss';return null;}
