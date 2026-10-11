// V154: settlement tramite ESPN, senza API-Football e senza football-data.org.
// Il frontend può passare leagueCode=SA/SB/PL/... quando disponibile.
const LEAGUES={SA:'ita.1',SB:'ita.2',PL:'eng.1',PD:'esp.1',BL1:'ger.1',FL1:'fra.1',PPL:'por.1',DED:'ned.1',BEL1:'bel.1',SCO1:'sco.1',AUT1:'aut.1',TUR1:'tur.1',DEN1:'den.1',SWE1:'swe.1',NOR1:'nor.1',POL1:'pol.1',GRE1:'gre.1',ROU1:'rou.1',UKR1:'ukr.1',SUI1:'sui.1',CL:'uefa.champions',EL:'uefa.europa',ECL:'uefa.europa.conference'};
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const u=new URL(req.url,'https://vercel.local');
  const fixtureId=u.searchParams.get('fixtureId'); const market=u.searchParams.get('market');
  const leagueCode=u.searchParams.get('leagueCode')||'';
  if(!fixtureId||!market)return res.status(400).json({error:'Parametri fixtureId e market richiesti'});
  const id=String(fixtureId).replace(/^espn-/,''); if(!/^\d+$/.test(id))return res.status(200).json({settled:false,reason:'Riferimento partita non riconosciuto da V154'});
  const slugs=leagueCode&&LEAGUES[leagueCode]?[LEAGUES[leagueCode]]:Object.values(LEAGUES);
  try{
    for(const slug of slugs){
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(id)}`,{headers:{Accept:'application/json','User-Agent':'AI-del-Pallone/154'}});
      if(!r.ok)continue;
      const m=await r.json();
      const c=Array.isArray(m?.header?.competitions)?m.header.competitions[0]:null;
      const comps=Array.isArray(c?.competitors)?c.competitors:[];
      const home=comps.find(x=>x.homeAway==='home'),away=comps.find(x=>x.homeAway==='away');
      if(!home||!away)continue;
      const completed=Boolean(m?.header?.competitions?.[0]?.status?.type?.completed);
      if(!completed)return res.status(200).json({settled:false,reason:'Partita non ancora conclusa'});
      const hg=Number(home.score),ag=Number(away.score); if(!Number.isFinite(hg)||!Number.isFinite(ag))return res.status(200).json({settled:false,reason:'Risultato finale non disponibile'});
      const result=evaluateMarket(market,hg,ag); if(result==null)return res.status(200).json({settled:false,reason:`Mercato "${market}" non riconosciuto automaticamente`,homeGoals:hg,awayGoals:ag});
      return res.status(200).json({settled:true,result,homeGoals:hg,awayGoals:ag});
    }
    return res.status(200).json({settled:false,reason:'Partita ESPN non trovata nel campionato indicato'});
  }catch(e){return res.status(200).json({settled:false,reason:e?.message||String(e)});}
}
export function evaluateMarket(market,hg,ag){const total=hg+ag,m=String(market||'');if(m.startsWith('1'))return hg>ag?'win':'loss';if(m.startsWith('2'))return ag>hg?'win':'loss';if(m.startsWith('X'))return hg===ag?'win':'loss';if(m==='Over 1.5')return total>1.5?'win':'loss';if(m==='Under 1.5')return total<1.5?'win':'loss';if(m==='Over 2.5')return total>2.5?'win':'loss';if(m==='Under 2.5')return total<2.5?'win':'loss';if(m==='Over 3.5')return total>3.5?'win':'loss';if(m==='Under 3.5')return total<3.5?'win':'loss';if(m==='Over 4.5')return total>4.5?'win':'loss';if(m==='Under 4.5')return total<4.5?'win':'loss';if(m==='Goal')return hg>0&&ag>0?'win':'loss';if(m==='No Goal')return hg===0||ag===0?'win':'loss';return null;}
