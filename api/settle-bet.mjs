const FD_BASE='https://api.football-data.org/v4';
export default async function handler(req,res){
  const id=String(req.query?.id||req.body?.id||'').replace(/^football-data-/,'');
  const token=process.env.FOOTBALL_DATA_TOKEN||'';
  if(!id||!/^[0-9]+$/.test(id)) return res.status(400).json({error:'ID partita Football-Data.org mancante'});
  if(!token)return res.status(500).json({error:'FOOTBALL_DATA_TOKEN non configurato'});
  try{const r=await fetch(`${FD_BASE}/matches/${id}`,{headers:{Accept:'application/json','X-Auth-Token':token}});if(!r.ok)return res.status(r.status).json({error:`Football-Data.org HTTP ${r.status}`});const m=await r.json();if(String(m.status).toUpperCase()!=='FINISHED')return res.status(200).json({settled:false,status:m.status});const hg=Number(m.score?.fullTime?.home),ag=Number(m.score?.fullTime?.away);const market=req.query?.market||req.body?.market||'';return res.status(200).json({settled:true,result:evaluateMarket(market,hg,ag),homeGoals:hg,awayGoals:ag,status:m.status});}catch(e){return res.status(500).json({error:e.message});}}
function evaluateMarket(m,h,a){const x=String(m||'');if(x.startsWith('1'))return h>a?'win':'loss';if(x==='X (Pareggio)'||x==='X')return h===a?'win':'loss';if(x.startsWith('2'))return a>h?'win':'loss';const total=h+a;const om=x.match(/(Over|Under) ([0-9.]+)/i);if(om){const line=Number(om[2]);return om[1].toLowerCase()==='over'?(total>line?'win':'loss'):(total<line?'win':'loss');}if(x==='Goal')return h>0&&a>0?'win':'loss';if(x==='No Goal')return h===0||a===0?'win':'loss';return null;}
