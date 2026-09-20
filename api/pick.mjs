const RESPONSE_CACHE = new Map();

const ESPN_LEAGUES = {
  SA:{slug:'ita.1',name:'Serie A'}, SB:{slug:'ita.2',name:'Serie B'},
  PL:{slug:'eng.1',name:'Premier League'}, PD:{slug:'esp.1',name:'La Liga'},
  BL1:{slug:'ger.1',name:'Bundesliga'}, FL1:{slug:'fra.1',name:'Ligue 1'},
  PPL:{slug:'por.1',name:'Primeira Liga'}, DED:{slug:'ned.1',name:'Eredivisie'},
  BEL1:{slug:'bel.1',name:'Belgian Pro League'}, SCO1:{slug:'sco.1',name:'Scottish Premiership'},
  AUT1:{slug:'aut.1',name:'Austrian Bundesliga'}, TUR1:{slug:'tur.1',name:'Turkish Super Lig'},
  DEN1:{slug:'den.1',name:'Danish Superliga'}, SWE1:{slug:'swe.1',name:'Allsvenskan'},
  NOR1:{slug:'nor.1',name:'Eliteserien'}, POL1:{slug:'pol.1',name:'Ekstraklasa'},
  GRE1:{slug:'gre.1',name:'Greek Super League'}, ROU1:{slug:'rou.1',name:'Liga I'},
  UKR1:{slug:'ukr.1',name:'Ukrainian Premier League'}, SUI1:{slug:'sui.1',name:'Swiss Super League'},
  CL:{slug:'uefa.champions',name:'Champions League'}, EL:{slug:'uefa.europa',name:'Europa League'},
  ECL:{slug:'uefa.europa.conference',name:'Conference League'}, BRA1:{slug:'bra.1',name:'Brasileirao'},
  MLS1:{slug:'usa.1',name:'MLS'}, JPN1:{slug:'jpn.1',name:'J League'},
  WCQ:{slug:'fifa.worldq.uefa',name:'Qualificazioni Mondiali UEFA'},
  NL:{slug:'uefa.nations',name:'UEFA Nations League'}, EURO:{slug:'uefa.euro',name:'Europei'}, EUROQ:{slug:'uefa.euroq',name:'Qualificazioni Europei'}
};

const TOP8=['SA','PL','PD','BL1','FL1','PPL','DED','BEL1'];
const EURO_CUPS=['CL','EL','ECL'];
const NATIONAL_CODES=['WCQ','NL','EURO','EUROQ'];
const PRIORITY_CODES=[...TOP8,...EURO_CUPS,...NATIONAL_CODES];
const FALLBACK_CODES=Object.keys(ESPN_LEAGUES).filter(c=>!PRIORITY_CODES.includes(c));
const DEFAULT_CODES=PRIORITY_CODES;

const ALLOWED_MARKETS=new Set(['1','X','2','Over 2.5','Under 2.5','Over 3.5','Under 3.5']);
const MAX_ODDS=3.70;
const TARGET_PICKS=3;
const HISTORY_DAYS=28;

export default async function safeHandler(req,res){
  try{return await handler(req,res);}catch(e){
    console.error('AI DEL PALLONE /api/pick error',e);
    if(!res.headersSent) res.status(500).json({error:`Errore interno durante l'analisi: ${e?.message||String(e)}`});
  }
}

async function handler(req,res){
  const supaUrl=process.env.SUPABASE_URL||'';
  const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  const u=new URL(req.url,'https://vercel.local');
  const date=u.searchParams.get('date');
  const raw=u.searchParams.get('leagues')||'';
  const requestedCodes=raw==='EUROPE'?DEFAULT_CODES:(raw?raw.split(',').map(normalizeLeague).filter(Boolean):DEFAULT_CODES);
  const market=u.searchParams.get('market')||'all';
  const timeWindow=u.searchParams.get('timeWindow')||'all';
  if(!date) return res.status(400).json({error:'Data mancante'});
  if(!supaUrl||!serviceKey) return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  const cacheKey=`v162-clean|${date}|${requestedCodes.join(',')}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now()) return res.status(200).json({...cached.data,cached:true});

  let requests=0;
  const requestBreakdown={espnScoreboards:0,espnStandings:0,betfairSnapshot:0};
  const diagnostics=[];
  const usingDefaultPool=!raw||raw==='EUROPE';
  const from=shiftDate(date,-HISTORY_DAYS);
  const to=shiftDate(date,1);
  const targetYear=date.slice(0,4);
  const targetMonth=date.slice(0,7).replace('-', '');
  
  // ESPN ha ritirato il formato scoreboard dates=YYYYMMDD-YYYYMMDD: dal 18/09/2026
  // restituisce HTTP 400 'Failed to get events endpoint'. Per il calendario usiamo
  // la singola giornata; per la forma recente usiamo il mese corrente e, solo se
  // serve, il mese precedente. In questo modo niente range deprecati e poche chiamate.
  async function fetchFixtures(codeList){
    const codes=[...new Set(codeList)].filter(c=>ESPN_LEAGUES[c]);
    const unknown=codeList.filter(c=>!ESPN_LEAGUES[c]);
    if(unknown.length) diagnostics.push({provider:'espn-config',unsupported:unknown});
    return await mapLimit(codes,5,async code=>{
      const cfg=ESPN_LEAGUES[code];
      const dailyPath=`/apis/site/v2/sports/soccer/${cfg.slug}/scoreboard?dates=${date.replaceAll('-','')}&limit=1000`;
      const monthPath=`/apis/site/v2/sports/soccer/${cfg.slug}/scoreboard?dates=${targetMonth}&limit=1000`;
      const [daily,month]=await Promise.all([espn(dailyPath),espn(monthPath)]);
      requests+=2; requestBreakdown.espnScoreboards+=2;
      const dailyRows=Array.isArray(daily?.events)?daily.events.map(e=>adaptEspnEvent(e,code,cfg)).filter(Boolean):[];
      const monthRows=Array.isArray(month?.events)?month.events.map(e=>adaptEspnEvent(e,code,cfg)).filter(Boolean):[];
      const merged=new Map();
      for(const f of [...monthRows,...dailyRows]) merged.set(f.id,f);
      const fixtures=[...merged.values()].filter(f=>localDate(f.date)>=from&&localDate(f.date)<=to);
      diagnostics.push({provider:'espn-scoreboard',league:cfg.name,code,slug:cfg.slug,dailyEvents:dailyRows.length,monthEvents:monthRows.length,fixtures:fixtures.length,dailyError:daily?.__error||null,monthError:month?.__error||null});
      return {code,cfg,fixtures,standings:new Map()};
    });
  }


  let sourceResults=await fetchFixtures(requestedCodes);
  let {allFixtures,liveFixtures,fixtures}=assembleFixtures(sourceResults,requestedCodes,date,timeWindow);
  diagnostics.push({provider:'prematch-gate',before:allFixtures.length,remaining:fixtures.length,live:liveFixtures.length,rule:'ESPN kickoff + stato; Betfair non decide se la gara è già iniziata'});

  // FASE 2: standings solo per i campionati che hanno almeno una gara analizzabile.
  // Questo dimezza le chiamate rispetto alla vecchia versione.
  const activeCodes=[...new Set(fixtures.map(f=>f.leagueCode))];
  if(activeCodes.length){
    const active=await mapLimit(activeCodes,5,async code=>{
      const cfg=ESPN_LEAGUES[code];
      const table=await espn(`/apis/v2/sports/soccer/${cfg.slug}/standings`);
      requests++; requestBreakdown.espnStandings++;
      const standings=parseEspnStandings(table);
      diagnostics.push({provider:'espn-standings',league:cfg.name,code,teams:standings.size,error:table?.__error||null});
      return {code,standings};
    });
    for(const x of active){const row=sourceResults.find(r=>r.code===x.code);if(row)row.standings=x.standings;}
  }

  // Betfair è esclusivamente la fonte della quota. Si leggono gli ultimi cataloghi
  // sincronizzati e l'ultimo book disponibile per ogni marketId.
  const bf=await loadBetfairSnapshot(supaUrl,serviceKey);
  requests++; requestBreakdown.betfairSnapshot++;
  diagnostics.push({provider:'betfair-exchange',catalogueRows:bf.catalogueRows,catalogueMarkets:bf.catalogueMarkets,bookMarkets:bf.bookMarkets,events:bf.events,error:bf.error||null,role:'unica fonte delle quote BACK'});

  const standingsByCode=new Map(sourceResults.map(x=>[x.code,x.standings]));
  const quoted=[];
  const scenarios=[];
  const unmatched=[];

  for(const f of fixtures){
    const match=findBestBetfairFixture(f.home,f.away,bf.events,f.date);
    if(!match){unmatched.push({fixture:`${f.home} - ${f.away}`,league:f.league,reason:'evento Betfair non riconosciuto'});continue;}
    const odds=extractBetfairOdds(match.markets,market,f.home,f.away).filter(o=>o.odd>1&&o.odd<=MAX_ODDS&&ALLOWED_MARKETS.has(o.value));
    if(!odds.length){unmatched.push({fixture:`${f.home} - ${f.away}`,league:f.league,reason:'Betfair presente ma nessuna quota BACK ≤ 3,70 nei mercati richiesti'});continue;}
    quoted.push({f,match,odds});

    const table=standingsByCode.get(f.leagueCode)||new Map();
    const hs=table.get(teamKey(f.home));
    const as=table.get(teamKey(f.away));
    const recent=recentThreeForTeams(sourceResults.find(x=>x.code===f.leagueCode)?.fixtures||[],f.home,f.away,date);
    const modelSample=Math.min(recent.home.length,3)+Math.min(recent.away.length,3);
    const probs=estimateProbabilities(hs,as,recent.home,recent.away,f.home,f.away);
    for(const o of odds){
      const p=probs[o.value];
      if(!Number.isFinite(p)||p<=0) continue;
      scenarios.push({
        home:f.home,away:f.away,market:marketLabel(o.value),odds:o.odd,prob:round(p),pStat:round(p),pMarket:null,pFair:round(p),edge:null,score:round(p),topSelectionScore:round(p),confidence:round(p),
        analysisSupport:analysisSupport(hs,as,recent.home,recent.away),modelReady:true,topEligible:true,modelSample:Math.min(recent.home.length,3),
        probabilitySource:'Classifica + ultime 3 partite',modelVersion:'V162-FORM-FIX',
        homeStanding:hs||null,awayStanding:as||null,standingNote:standingNote(f.home,hs,f.away,as),
        recentForm:{home:recent.home,away:recent.away,homeMatches:recent.home.length,awayMatches:recent.away.length},
        reason:buildReason(p,f.home,f.away,hs,as,recent.home,recent.away),
        oddsSource:'Betfair Exchange',statsSource:'ESPN',fixtureId:`espn-${f.id}`,eventId:f.id,kickoff:f.date,
        league:f.league,leagueCode:f.leagueCode,priorityLeague:PRIORITY_CODES.includes(f.leagueCode),homeLogo:f.homeLogo||null,awayLogo:f.awayLogo||null,
        riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value',oddsAgeMin:o.quoteAgeMin,
        fieldAnalysis:{reason:buildReason(p,f.home,f.away,hs,as,recent.home,recent.away),confidence:round(p),confidenceLabel:p>=70?'Alta':p>=55?'Media':'Bassa',warnings:[]}
      });
    }
  }

  // Un solo scenario per partita: scegliamo il mercato con probabilità più alta.
  const bestByMatch=new Map();
  for(const s of scenarios){
    const k=normalizePair(s.home,s.away);
    const old=bestByMatch.get(k);
    if(!old||Number(s.prob)>Number(old.prob)) bestByMatch.set(k,s);
  }
  let candidates=[...bestByMatch.values()].sort((a,b)=>Number(b.prob)-Number(a.prob));

  // Se l'utente ha lasciato il pool di default, allarghiamo solo se non bastano 3
  // partite quotate. Anche il fallback usa ESPN, senza API a consumo.
  if(usingDefaultPool&&candidates.length<TARGET_PICKS&&FALLBACK_CODES.length){
    diagnostics.push({provider:'pool-expansion',reason:`Solo ${candidates.length} partite quotate nel perimetro prioritario; provo gli altri campionati ESPN.`});
    const extra=await fetchFixtures(FALLBACK_CODES);
    sourceResults=[...sourceResults,...extra];
    const assembled=assembleFixtures(sourceResults,[...requestedCodes,...FALLBACK_CODES],date,timeWindow);
    allFixtures=assembled.allFixtures; liveFixtures=assembled.liveFixtures; fixtures=assembled.fixtures;
    const extraCodes=[...new Set(fixtures.map(f=>f.leagueCode))].filter(c=>!activeCodes.includes(c));
    if(extraCodes.length){
      const extraTables=await mapLimit(extraCodes,5,async code=>{
        const cfg=ESPN_LEAGUES[code]; const table=await espn(`/apis/v2/sports/soccer/${cfg.slug}/standings`); requests++; requestBreakdown.espnStandings++;
        const standings=parseEspnStandings(table); diagnostics.push({provider:'espn-standings',league:cfg.name,code,teams:standings.size,error:table?.__error||null}); return {code,standings};
      });
      for(const x of extraTables){const row=sourceResults.find(r=>r.code===x.code);if(row)row.standings=x.standings;}
    }
    // ricostruzione completa sul pool esteso, senza nuove chiamate Betfair
    const tables=new Map(sourceResults.map(x=>[x.code,x.standings]));
    for(const f of fixtures){
      if(bestByMatch.has(normalizePair(f.home,f.away))) continue;
      const match=findBestBetfairFixture(f.home,f.away,bf.events,f.date); if(!match)continue;
      const odds=extractBetfairOdds(match.markets,market,f.home,f.away).filter(o=>o.odd>1&&o.odd<=MAX_ODDS&&ALLOWED_MARKETS.has(o.value)); if(!odds.length)continue;
      const table=tables.get(f.leagueCode)||new Map(), hs=table.get(teamKey(f.home)), as=table.get(teamKey(f.away));
      const recent=recentThreeForTeams(sourceResults.find(x=>x.code===f.leagueCode)?.fixtures||[],f.home,f.away,date);
      const probs=estimateProbabilities(hs,as,recent.home,recent.away,f.home,f.away);
      const best=odds.map(o=>({...makeScenario(f,o,probs[o.value],hs,as,recent),priorityLeague:PRIORITY_CODES.includes(f.leagueCode)})).filter(x=>Number.isFinite(x.prob)).sort((a,b)=>b.prob-a.prob)[0];
      if(best)bestByMatch.set(normalizePair(f.home,f.away),best);
    }
    candidates=[...bestByMatch.values()].sort((a,b)=>Number(b.prob)-Number(a.prob));
  }

  const finalPicks=candidates.slice(0,TARGET_PICKS);
  diagnostics.push({provider:'v162-model',scenarios:scenarios.length,quotedFixtures:quoted.length,candidates:candidates.length,returned:finalPicks.length,maxOdds:MAX_ODDS,markets:[...ALLOWED_MARKETS],rule:'Un solo scenario per partita; TOP 3 ordinato esclusivamente per probabilità; Betfair solo per quota BACK'});
  diagnostics.push({provider:'betfair-matching',matched:quoted.length,unmatched:unmatched.slice(0,30),unmatchedCount:unmatched.length});

  if(!finalPicks.length){
    const reason=fixtures.length?'Nessuna partita ESPN pre-match ha una quota BACK Betfair riconosciuta ≤ 3,70.':'Nessuna partita ESPN pre-match nel perimetro selezionato.';
    diagnostics.push({provider:'no-candidates-debug',reason,espnPrematch:fixtures.length,betfairEvents:bf.events.size,unmatched:unmatched.slice(0,20)});
  }

  const disclaimer=`Il modello usa solo ESPN per calendario, classifica e ultime 3. Betfair Exchange è usata esclusivamente per la quota BACK. Quota massima ${MAX_ODDS.toFixed(2)}. Il TOP 3 è ordinato solo per probabilità stimata: la quota non entra nel calcolo della probabilità. Se non esistono 3 partite reali con quota Betfair compatibile, vengono mostrate solo quelle disponibili.`;
  await logModelPredictions(supaUrl,serviceKey,date,finalPicks);
  const data={date,fixtures:fixtures.length,analyzed:quoted.length,requests,requestBreakdown,candidates:candidates.slice(0,120),liveFixtures,diagnostics,disclaimer,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?120000:600000),data});
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json(data);
}

function makeScenario(f,o,p,hs,as,recent){
  return {
    home:f.home,away:f.away,market:marketLabel(o.value),odds:o.odd,prob:round(p),pStat:round(p),pMarket:null,pFair:round(p),edge:null,score:round(p),topSelectionScore:round(p),confidence:round(p),
    analysisSupport:analysisSupport(hs,as,recent.home,recent.away),modelReady:true,topEligible:true,modelSample:Math.min(recent.home.length,3),probabilitySource:'Classifica + ultime 3 partite',modelVersion:'V162-FORM-FIX',homeStanding:hs||null,awayStanding:as||null,
    standingNote:standingNote(f.home,hs,f.away,as),recentForm:{home:recent.home,away:recent.away,homeMatches:recent.home.length,awayMatches:recent.away.length},reason:buildReason(p,f.home,f.away,hs,as,recent.home,recent.away),oddsSource:'Betfair Exchange',statsSource:'ESPN',fixtureId:`espn-${f.id}`,eventId:f.id,kickoff:f.date,league:f.league,leagueCode:f.leagueCode,priorityLeague:PRIORITY_CODES.includes(f.leagueCode),homeLogo:f.homeLogo||null,awayLogo:f.awayLogo||null,riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value'
  };
}

async function supaWrite(url,key,path,rows){
  const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
  if(!r.ok){const t=await r.text();throw new Error(`Supabase write ${r.status}: ${t.slice(0,300)}`);}
}
async function logModelPredictions(url,key,date,picks){
  if(!picks.length)return;
  const rows=picks.map(p=>({match_date:date,league_code:p.leagueCode||null,league:p.league||null,home:p.home,away:p.away,event_id:p.eventId?String(p.eventId):null,fixture_id:p.fixtureId||null,market:p.market,odds:Number.isFinite(p.odds)?p.odds:null,odds_cap_used:MAX_ODDS,prob_model:Number.isFinite(p.pStat)?p.pStat:null,prob_market:null,prob_blended:null,edge_percent:null,model_sample:Number.isFinite(p.modelSample)?p.modelSample:null,kickoff:p.kickoff||null,settled:false,result:null}));
  try{await supaWrite(url,key,'model_predictions?on_conflict=match_date,home,away,market',rows);}catch(e){console.error('AI DEL PALLONE log model_predictions error',e?.message||e);}
}

async function espn(path){
  try{const r=await fetch(`https://site.api.espn.com${path}`,{headers:{Accept:'application/json'},cache:'no-store'});const text=await r.text();if(!r.ok)return {__error:`ESPN HTTP ${r.status}: ${text.slice(0,220)}`};return text?JSON.parse(text):{};}catch(e){return {__error:e?.message||String(e)};}
}
function adaptEspnEvent(e,code,cfg){
  const c=Array.isArray(e?.competitions)?e.competitions[0]:null; const comps=Array.isArray(c?.competitors)?c.competitors:[];
  const home=comps.find(x=>x?.homeAway==='home')||comps[0],away=comps.find(x=>x?.homeAway==='away')||comps[1]; if(!home?.team?.displayName||!away?.team?.displayName||!e?.date)return null;
  const state=String(e?.status?.type?.state||'').toLowerCase(),completed=Boolean(e?.status?.type?.completed); let status='SCHEDULED'; if(state==='in'||state==='live')status='LIVE'; else if(completed||state==='post')status='FINISHED';
  return {id:String(e.id),date:e.date,status,home:home.team.displayName,away:away.team.displayName,homeId:home.team.id,awayId:away.team.id,homeLogo:home.team.logo||null,awayLogo:away.team.logo||null,score:{home:Number(home.score),away:Number(away.score)},league:e?.league?.name||cfg.name,leagueCode:code};
}
function formPoints(form){
  const s=String(form||'').toUpperCase().replace(/[^WDL]/g,'').slice(-3);
  let points=0;
  for(const r of s){ if(r==='W') points+=3; else if(r==='D') points+=1; }
  return points;
}
function parseEspnStandings(payload){
  if(payload?.__error)return new Map(); const found=[]; walk(payload,x=>{if(Array.isArray(x?.entries)&&x.entries.some(e=>e?.team))found.push(x.entries);});
  const rows=found.flat().filter(e=>e?.team?.displayName||e?.team?.name); const total=rows.length; const map=new Map();
  for(const e of rows){const name=e.team.displayName||e.team.name,stats=Array.isArray(e.stats)?e.stats:[];const get=(...keys)=>{const s=stats.find(x=>keys.some(k=>String(x?.name||'').toLowerCase()===k||String(x?.abbreviation||'').toLowerCase()===k||String(x?.displayName||'').toLowerCase()===k));return s?.value??s?.displayValue??null;};const rank=Number(get('rank','rk','ranking'));const points=Number(get('points','pts'));const played=Number(get('gamesPlayed','gp','played'));const form=String(e?.form||get('form')||'').replace(/[^WDL]/gi,'').toUpperCase();map.set(teamKey(name),{teamId:e.team?.id,teamName:name,position:Number.isFinite(rank)?rank:null,totalTeams:total,points:Number.isFinite(points)?points:null,playedGames:Number.isFinite(played)?played:null,form,last3:form.slice(-3),form3Points:formPoints(form.slice(-3))});}
  return map;
}
function assembleFixtures(results,codes,date,timeWindow){
  const all=results.flatMap(x=>x.fixtures).filter(f=>codes.includes(f.leagueCode)); const live=all.filter(f=>f.status==='LIVE'&&localDate(f.date)===date).map(f=>({...f,status:'LIVE'}));
  const today=localTodayRome(); const selected=all.filter(f=>localDate(f.date)===date).filter(f=>f.status!=='LIVE'&&f.status!=='FINISHED').filter(f=>date===today?new Date(f.date).getTime()>Date.now():date>today).filter(f=>timeWindowAllows(f.date,timeWindow));
  return {allFixtures:all,liveFixtures:live,fixtures:dedupeFixtures(selected)};
}
function dedupeFixtures(rows){const m=new Map();for(const f of rows){const k=`${f.leagueCode}|${normalizePair(f.home,f.away)}|${localDate(f.date)}`;if(!m.has(k))m.set(k,f);}return [...m.values()];}
function recentThreeForTeams(fixtures,home,away,date){const finished=fixtures.filter(f=>f.status==='FINISHED'&&localDate(f.date)<date&&Number.isFinite(Number(f.score?.home))&&Number.isFinite(Number(f.score?.away))).sort((a,b)=>new Date(b.date)-new Date(a.date));const pick=name=>finished.filter(f=>teamSimilarity(f.home,name)>=.72||teamSimilarity(f.away,name)>=.72).slice(0,3).reverse();return {home:pick(home),away:pick(away)};}

function estimateProbabilities(hs,as,hm,am,homeName,awayName){
  const hS=standingStrength(hs),aS=standingStrength(as); const fH=pointsFromTeamRows(hm,homeName); const fA=pointsFromTeamRows(am,awayName); const fDiff=((fH/Math.max(1,hm.length*3))-(fA/Math.max(1,am.length*3)));
  const sDiff=hS-aS; let home=0.5+sDiff*.23+fDiff*.07+0.045; let draw=0.27-Math.abs(sDiff)*.06-Math.abs(fDiff)*.03; let away=1-home-draw;
  home=clamp(home,.12,.78);away=clamp(away,.10,.72);draw=clamp(draw,.16,.34);const sum=home+draw+away;home/=sum;draw/=sum;away/=sum;
  const totals=goalTotalProbabilities(hm,am);
  return {'1':home*100,'X':draw*100,'2':away*100,...totals};
}
function goalTotalProbabilities(hm,am){
  const rows=[...hm,...am]; let total=0,n=0;for(const m of rows){const hg=Number(m.score?.home),ag=Number(m.score?.away);if(Number.isFinite(hg)&&Number.isFinite(ag)){total+=hg+ag;n++;}}
  const avg=n?total/n:2.5; const lambda=clamp(avg,.8,5.0); const probs={};
  for(const line of [2.5,3.5]){let under=0;const maxUnder=line===2.5?2:3;for(let k=0;k<=maxUnder;k++)under+=poissonPMF(k,lambda);probs[`Over ${line.toFixed(1)}`]=(1-under)*100;probs[`Under ${line.toFixed(1)}`]=under*100;}
  return probs;
}
function analysisSupport(hs,as,hm,am){let s=45;if(hs&&as)s+=30;if(hm.length>=3&&am.length>=3)s+=25;else if(hm.length>=2&&am.length>=2)s+=15;return clamp(s,0,100);}
function buildReason(prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);if(hm.length)bits.push(`${home}: ${pointsFromTeamRows(hm,home)} punti nelle ultime ${hm.length}`);if(am.length)bits.push(`${away}: ${pointsFromTeamRows(am,away)} punti nelle ultime ${am.length}`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join('. ')+'.';}
function pointsFromTeamRows(rows,name){let p=0;for(const m of rows){const hg=Number(m.score?.home),ag=Number(m.score?.away);if(!Number.isFinite(hg)||!Number.isFinite(ag))continue;const isHome=teamSimilarity(m.home,name)>=.72;const gf=isHome?hg:ag,ga=isHome?ag:hg;p+=gf>ga?3:gf===ga?1:0;}return p;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position&&hs?.totalTeams)x.push(`${home} è ${hs.position}ª su ${hs.totalTeams}`);if(as?.position&&as?.totalTeams)x.push(`${away} è ${as.position}º su ${as.totalTeams}`);return x.length?x.join('; '):null;}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}

function findBestBetfairFixture(home,away,events,kickoff){let best=null,bestScore=0;const target=normalizePair(home,away);for(const [key,entry] of events){if(key===target){const x=bestTimedEvent(entry,kickoff,1);if(x)return x;}}
  for(const [,entry] of events){const e=entry[0];const teams=parseEventTeams(e?.event?.name||'');if(!teams)continue;const direct=(teamSimilarity(home,teams.home)+teamSimilarity(away,teams.away))/2;const reverse=(teamSimilarity(home,teams.away)+teamSimilarity(away,teams.home))/2;const score=Math.max(direct,reverse);if(score<.60)continue;const timed=bestTimedEvent(entry,kickoff,score);if(timed&&(!best||score>bestScore)){best=timed;bestScore=score;}}
  return best;}
function bestTimedEvent(markets,kickoff,score){if(!Array.isArray(markets)||!markets.length)return null;const valid=markets.filter(m=>m?.marketId);const groups=new Map();for(const m of valid){const eventKey=String(m.event?.id||m.event?.name||m.marketId);if(!groups.has(eventKey))groups.set(eventKey,[]);groups.get(eventKey).push(m);}let best=null,bestDist=Infinity;for(const ms of groups.values()){const dt=eventTime(ms[0]);const dist=kickoff&&dt?Math.abs(new Date(kickoff)-dt):0;if(dist<bestDist){bestDist=dist;best={markets:ms,score};}}return best;}
function eventTime(m){const v=m?.marketStartTime||m?.event?.openDate||m?.event?.timezone;const d=v?new Date(v):null;return d&&!Number.isNaN(d.getTime())?d:null;}

function extractBetfairOdds(match,requestedMarket,home,away){const out=[];const totals=requestedMarket==='all'||requestedMarket==='totals',one=requestedMarket==='all'||requestedMarket==='1x2';for(const m of(match?.markets||[])){const name=String(m.marketName||'');const isMatch=/match odds|1x2|esito finale/i.test(name);const lm=name.match(/(?:under\s*\/\s*over|over\s*\/\s*under|under.*over|over.*under).*?(1\.5|2\.5|3\.5|4\.5)/i);const line=lm?Number(lm[1]):null;if(isMatch&&!one)continue;if(!isMatch&&!(totals&&line&&[2.5,3.5].includes(line)))continue;for(const r of(Array.isArray(m.runners)?m.runners:[])){const odd=Number(r.backPrice);if(!(odd>1&&Number.isFinite(odd)))continue;let value=null;const label=normalize(r.name);if(isMatch){if(label==='the draw'||label==='draw'||label==='x'||label==='pareggio')value='X';else if(teamSimilarity(r.name,home)>=.72)value='1';else if(teamSimilarity(r.name,away)>=.72)value='2';}else{if(/^over\b/i.test(String(r.name)))value=`Over ${line.toFixed(1)}`;else if(/^under\b/i.test(String(r.name)))value=`Under ${line.toFixed(1)}`;}if(value)out.push({value,odd,quoteAgeMin:r.quoteAgeMin??m.quoteAgeMin??null,liquidity:r.backSize??null});}}
  const best=new Map();for(const x of out){const old=best.get(x.value);if(!old||x.odd>old.odd)best.set(x.value,x);}return [...best.values()];}

async function loadBetfairSnapshot(url,key){try{
  const catRows=await supaRead(url,key,'betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=20');
  const bookRows=await supaRead(url,key,'betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=5000');
  const latestBook=new Map();for(const r of bookRows){if(r?.market_id&&!latestBook.has(String(r.market_id)))latestBook.set(String(r.market_id),r);}
  const events=new Map();let catalogueMarkets=0;
  for(const row of catRows){for(const m of unwrapCatalogue(row?.payload)){catalogueMarkets++;const book=latestBook.get(String(m.marketId));if(!book)continue;const runners=(unwrapBooks(book.payload)).map(r=>({selectionId:r.selectionId,status:r.status,backPrice:bestBack(r),backSize:bestBackSize(r),name:(Array.isArray(m.runners)?m.runners.find(x=>String(x?.selectionId)===String(r.selectionId))?.runnerName:null)||String(r.selectionId),quoteAgeMin:ageMin(book.received_at)}));const item={marketId:String(m.marketId),marketName:String(m.marketName||''),event:m.event||null,competition:m.competition||null,marketStartTime:m.marketStartTime||null,receivedAt:book.received_at||row.received_at,runners};const teams=parseEventTeams(item.event?.name||'');if(!teams)continue;const k=normalizePair(teams.home,teams.away);if(!events.has(k))events.set(k,[]);events.get(k).push(item);}}
  return {events,catalogueRows:catRows.length,catalogueMarkets,bookMarkets:latestBook.size,error:null};
 }catch(e){return {events:new Map(),catalogueRows:0,catalogueMarkets:0,bookMarkets:0,error:e?.message||String(e)};}}
function unwrapCatalogue(payload){const out=[];walk(payload,v=>{if(v?.marketId&&v?.marketName)out.push(v);});return out;}
function unwrapBooks(payload){const out=[];walk(payload,v=>{if(v&&v.selectionId!=null&&('status' in v||v.ex))out.push(v);});return out;}
function bestBack(r){const direct=Number(r?.backPrice);if(direct>1&&Number.isFinite(direct))return direct;const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.map(x=>Number(x?.price)).filter(x=>x>1&&Number.isFinite(x)).sort((a,b)=>b-a)[0]??null;}
function bestBackSize(r){const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.length?Number(xs[0]?.size)||null:null;}
function parseEventTeams(name){const p=String(name||'').split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);return p.length>=2?{home:p[0].trim(),away:p.slice(1).join(' ').trim()}:null;}

async function supaRead(url,key,path){const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});const text=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);return text?JSON.parse(text):[];}
function ageMin(ts){if(!ts)return null;const d=new Date(ts).getTime();return Number.isFinite(d)?Math.max(0,(Date.now()-d)/60000):null;}
function marketLabel(v){return({'1':'1 (Casa)','X':'X (Pareggio)','2':'2 (Trasferta)'}[v])||v;}
function normalizeLeague(x){const s=String(x||'').trim().toUpperCase();const aliases={'135':'SA','136':'SB','39':'PL','140':'PD','78':'BL1','61':'FL1','2':'CL','88':'DED','94':'PPL'};return aliases[s]||((s in ESPN_LEAGUES)?s:null);}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();}
function teamKey(s){let n=normalize(s);const aliases={inter:'internazionale', 'inter milan':'internazionale', 'internazionale milano':'internazionale', 'ac milan':'milan', 'hellas verona':'verona', 'as roma':'roma', 'ss lazio':'lazio', 'ssc napoli':'napoli', 'juventus fc':'juventus'};n=aliases[n]||n;return n.replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the|ss|as|ssc|cfc|bk|sv)\b/g,' ').replace(/\s+/g,' ').trim();}
function clean(s){return teamKey(s).replace(/\b\d{2,4}\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function teamSimilarity(a,b){const aa=teamKey(a),bb=teamKey(b);if(!aa||!bb)return 0;if(aa===bb)return 1;if(aa.includes(bb)||bb.includes(aa))return .95;const A=new Set(aa.split(' ').filter(x=>x.length>2)),B=new Set(bb.split(' ').filter(x=>x.length>2));let c=0;for(const x of A)if(B.has(x))c++;if(!c)return 0;return Math.max(c/(A.size+B.size-c),(c/Math.min(A.size,B.size))*.93);}
function isLiveStatus(s){return String(s||'').toUpperCase()==='LIVE';}
function localDate(iso){try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}catch{return String(iso||'').slice(0,10);}}
function localTodayRome(){return localDate(new Date().toISOString());}
function timeWindowAllows(iso,w){try{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));const m=Number(p.find(x=>x.type==='hour')?.value)*60+Number(p.find(x=>x.type==='minute')?.value);if(w==='afternoon1')return m>=780&&m<=960;if(w==='afternoon2')return m>=961&&m<=1140;if(w==='evening')return m>=1141&&m<=1320;return m>=660&&m<=1320;}catch{return false;}}
function shiftDate(iso,delta){const d=new Date(`${iso}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}
function poissonPMF(k,lambda){let f=1;for(let i=2;i<=k;i++)f*=i;return Math.exp(-lambda)*Math.pow(lambda,k)/f;}
function walk(v,cb){if(v==null)return;if(typeof v!=='object')return;cb(v);if(Array.isArray(v)){for(const x of v)walk(x,cb);}else{for(const x of Object.values(v))walk(x,cb);}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
