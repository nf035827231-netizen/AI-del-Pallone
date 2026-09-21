// V157: settlement multi-fonte. Il fixtureId salvato con la giocata porta un prefisso che
// dice da quale fonte è nata la partita (espn-, fd- per football-data.org, af- per
// API-Football): prima si guardava solo il prefisso "espn-", scartando come "non
// riconosciute" tutte le giocate nate da football-data.org — che oggi è la fonte primaria
// per la maggior parte dei campionati. Qui si gestiscono tutte e tre.
const ESPN_SLUGS={SA:'ita.1',SB:'ita.2',PL:'eng.1',PD:'esp.1',BL1:'ger.1',FL1:'fra.1',PPL:'por.1',DED:'ned.1',BEL1:'bel.1',SCO1:'sco.1',AUT1:'aut.1',TUR1:'tur.1',DEN1:'den.1',SWE1:'swe.1',NOR1:'nor.1',POL1:'pol.1',GRE1:'gre.1',ROU1:'rou.1',UKR1:'ukr.1',SUI1:'sui.1',CL:'uefa.champions',EL:'uefa.europa',ECL:'uefa.europa.conference'};

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const u=new URL(req.url,'https://vercel.local');
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
