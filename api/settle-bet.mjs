export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const u=new URL(req.url,'https://vercel.local');
  const fixtureId=u.searchParams.get('fixtureId'); const market=u.searchParams.get('market');
  if(!fixtureId||!market)return res.status(400).json({error:'Parametri fixtureId e market richiesti'});
  const id=String(fixtureId).replace(/^sofascore-/,'');
  if(!/^\d+$/.test(id))return res.status(200).json({settled:false,reason:'Riferimento partita non riconosciuto'});
  try{
    const r=await fetch(`https://www.sofascore.com/api/v1/event/${encodeURIComponent(id)}`,{headers:{Accept:'application/json','Origin':'https://www.sofascore.com','Referer':'https://www.sofascore.com/'},cache:'no-store'});
    if(!r.ok)return res.status(200).json({settled:false,reason:`SofaScore HTTP ${r.status}`});
    const m=await r.json();
    const ev=m?.event||m;
    const finished=String(ev?.status?.type||ev?.status?.description||'').toLowerCase().includes('finish')||Number(ev?.status?.code)===100;
    if(!finished)return res.status(200).json({settled:false,reason:'Partita non ancora conclusa'});
    const hg=Number(ev?.homeScore?.current??ev?.homeScore?.normaltime??ev?.homeScore?.display); const ag=Number(ev?.awayScore?.current??ev?.awayScore?.normaltime??ev?.awayScore?.display);
    if(!Number.isFinite(hg)||!Number.isFinite(ag))return res.status(200).json({settled:false,reason:'Risultato finale non disponibile'});
    const result=evaluateMarket(market,hg,ag); if(result==null)return res.status(200).json({settled:false,reason:`Mercato "${market}" non riconosciuto automaticamente`,homeGoals:hg,awayGoals:ag});
    return res.status(200).json({settled:true,result,homeGoals:hg,awayGoals:ag});
  }catch(e){return res.status(200).json({settled:false,reason:e?.message||String(e)});}
}
export function evaluateMarket(market,hg,ag){const total=hg+ag,m=String(market||'');if(m.startsWith('1'))return hg>ag?'win':'loss';if(m.startsWith('2'))return ag>hg?'win':'loss';if(m.startsWith('X'))return hg===ag?'win':'loss';if(m==='Over 1.5')return total>1.5?'win':'loss';if(m==='Under 1.5')return total<1.5?'win':'loss';if(m==='Over 2.5')return total>2.5?'win':'loss';if(m==='Under 2.5')return total<2.5?'win':'loss';if(m==='Over 3.5')return total>3.5?'win':'loss';if(m==='Under 3.5')return total<3.5?'win':'loss';if(m==='Over 4.5')return total>4.5?'win':'loss';if(m==='Under 4.5')return total<4.5?'win':'loss';if(m==='Goal')return hg>0&&ag>0?'win':'loss';if(m==='No Goal')return hg===0||ag===0?'win':'loss';return null;}
