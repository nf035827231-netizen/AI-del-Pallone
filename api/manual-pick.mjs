// V158: Analisi manuale. Quando i dati automatici scarseggiano (es. pausa nazionali,
// campionati non coperti dalle fonti gratuite) l'utente può inserire a mano forma recente,
// classifica ed eventuali precedenti per una partita specifica di cui conosce già la quota
// (es. trovata col bridge Betfair). Usa ESATTAMENTE lo stesso motore Poisson + blending con
// il mercato di api/pick.mjs — nessuna logica duplicata "diversa", solo la stessa matematica
// alimentata da input manuali invece che da ESPN/football-data.org/API-Football.

const LEAGUE_AVG_GOALS=1.35, HOME_ADV=1.12, MAX_GOALS_GRID=8;
const ALLOWED_MARKETS=new Set(['1','X','2','Over 2.5','Under 2.5','Over 3.5','Under 3.5','Goal','No Goal']);

function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}
function factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}
function poissonPMF(k,lambda){return Math.exp(-lambda)*Math.pow(lambda,k)/factorial(k);}

function expectedGoals(hgs,ags,standingDiff){
  const hAttack=hgs?hgs.gf/LEAGUE_AVG_GOALS:1, hDefense=hgs?hgs.ga/LEAGUE_AVG_GOALS:1;
  const aAttack=ags?ags.gf/LEAGUE_AVG_GOALS:1, aDefense=ags?ags.ga/LEAGUE_AVG_GOALS:1;
  let expHome=hAttack*aDefense*LEAGUE_AVG_GOALS*HOME_ADV;
  let expAway=aAttack*hDefense*LEAGUE_AVG_GOALS/HOME_ADV;
  expHome*=(1+standingDiff*0.15); expAway*=(1-standingDiff*0.15);
  return {expHome:clamp(expHome,0.2,4.5),expAway:clamp(expAway,0.2,4.5)};
}

function matchProbabilities(expHome,expAway){
  let pHome=0,pDraw=0,pAway=0,over25=0,over35=0,btts=0;
  for(let hg=0;hg<=MAX_GOALS_GRID;hg++){
    for(let ag=0;ag<=MAX_GOALS_GRID;ag++){
      const p=poissonPMF(hg,expHome)*poissonPMF(ag,expAway);
      if(hg>ag)pHome+=p;else if(hg===ag)pDraw+=p;else pAway+=p;
      const total=hg+ag;
      if(total>2.5)over25+=p; if(total>3.5)over35+=p;
      if(hg>0&&ag>0)btts+=p;
    }
  }
  const sum=pHome+pDraw+pAway||1;
  return {
    '1':pHome/sum*100,'X':pDraw/sum*100,'2':pAway/sum*100,
    'Over 2.5':over25*100,'Under 2.5':(1-over25)*100,
    'Over 3.5':over35*100,'Under 3.5':(1-over35)*100,
    'Goal':btts*100,'No Goal':(1-btts)*100
  };
}

function num(v,fallback=null){const n=Number(v);return Number.isFinite(n)?n:fallback;}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const body=req.method==='POST'?req.body:Object.fromEntries(new URL(req.url,'https://vercel.local').searchParams);
    const home=String(body.home||'').trim(), away=String(body.away||'').trim();
    const market=String(body.market||'').trim();
    const odds=num(body.odds);
    if(!home||!away) return res.status(400).json({error:'Nome delle due squadre richiesto'});
    if(!ALLOWED_MARKETS.has(market)) return res.status(400).json({error:`Mercato non valido. Ammessi: ${[...ALLOWED_MARKETS].join(', ')}`});
    if(!(odds>1)) return res.status(400).json({error:'Quota non valida (deve essere > 1.00)'});

    // Forma recente: gol fatti/subiti medi nel ruolo (casa/trasferta). Se non forniti,
    // il modello usa la media di lega come impone anche il motore principale in assenza
    // di dati — stesso comportamento, stessa onestà sul risultato.
    const homeGF=num(body.homeGoalsFor), homeGA=num(body.homeGoalsAgainst);
    const awayGF=num(body.awayGoalsFor), awayGA=num(body.awayGoalsAgainst);
    const hgs=(homeGF!=null&&homeGA!=null)?{gf:homeGF,ga:homeGA}:null;
    const ags=(awayGF!=null&&awayGA!=null)?{gf:awayGF,ga:awayGA}:null;

    // Classifica: posizione/totale squadre per entrambe (opzionale). Usata solo per una
    // piccola correzione, come nel motore principale.
    const homePos=num(body.homePosition), homeTotal=num(body.homeTotalTeams);
    const awayPos=num(body.awayPosition), awayTotal=num(body.awayTotalTeams);
    const strength=(pos,total)=>(pos!=null&&total>1)?clamp((total-pos)/(total-1),0,1):.5;
    const standingDiff=strength(homePos,homeTotal)-strength(awayPos,awayTotal);
    const hasStandings=homePos!=null&&awayPos!=null;

    // Precedenti diretti (opzionale): differenza reti media dal punto di vista della
    // squadra di casa negli ultimi precedenti che l'utente conosce.
    const h2hCount=Math.max(0,Math.round(num(body.h2hCount,0)));
    const h2hAvgGoalDiff=num(body.h2hAvgGoalDiff,0);

    let {expHome,expAway}=expectedGoals(hgs,ags,standingDiff);
    if(h2hCount>0){
      const h2hWeight=clamp(h2hCount/3,0,1)*0.06;
      const nudge=clamp(h2hAvgGoalDiff/3,-1,1)*h2hWeight;
      expHome=clamp(expHome*(1+nudge),0.2,4.5);
      expAway=clamp(expAway*(1-nudge),0.2,4.5);
    }

    const probMap=matchProbabilities(expHome,expAway);
    const modelProb=probMap[market];

    // Quanto ci fidiamo del modello statistico vs. il mercato: qui dipende da quanti campi
    // manuali sono stati davvero compilati, non da un campione di partite automatico.
    const fieldsProvided=[hgs,ags,hasStandings].filter(Boolean).length;
    const sampleWeight=clamp(fieldsProvided/3,0,1);
    const modelWeight=0.35+0.35*sampleWeight;
    const marketImplied=clamp(100/odds,1,99);
    const blended=modelWeight*modelProb+(1-modelWeight)*marketImplied;
    const edge=(blended/100)*odds-1;

    const warnings=[];
    if(!hgs) warnings.push(`Gol fatti/subiti di ${home} non inseriti: usata la media di lega.`);
    if(!ags) warnings.push(`Gol fatti/subiti di ${away} non inseriti: usata la media di lega.`);
    if(!hasStandings) warnings.push('Classifica non inserita: nessuna correzione da posizione in classifica.');
    if(h2hCount===0) warnings.push('Nessun precedente diretto inserito.');

    return res.status(200).json({
      home,away,market,odds,
      prob:round(blended),pStat:round(modelProb),pMarket:round(marketImplied),
      edge:round(edge*1000)/10,
      confidence:round(blended),
      confidenceLabel:blended>=70?'Alta':blended>=55?'Media':'Bassa',
      expectedGoals:{home:round(expHome),away:round(expAway)},
      fieldsProvided,warnings,
      disclaimer:'Stima basata sui dati che hai inserito tu: la qualità della previsione dipende da quanto sono accurati. Non è una garanzia di vincita.'
    });
  }catch(e){
    return res.status(500).json({error:e?.message||String(e)});
  }
}
