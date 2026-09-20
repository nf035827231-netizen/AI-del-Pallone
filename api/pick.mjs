const RESPONSE_CACHE = new Map();

// V169: fonte precedente completamente rimosso.
// Betfair = calendario operativo + quote BACK.
// SofaScore = classifica + ultime 3 partite.
const LEAGUE_CODES = new Set(['SA','SB','PL','PD','BL1','FL1','PPL','DED','BEL1','SCO1','AUT1','TUR1','DEN1','SWE1','NOR1','POL1','GRE1','ROU1','UKR1','SUI1','CL','EL','ECL','BRA1','MLS1','JPN1','WCQ','NL','EURO','EUROQ']);
const ALLOWED_MARKETS=new Set(['1','X','2','Over 1.5','Under 1.5','Over 2.5','Under 2.5','Over 3.5','Under 3.5','Goal','No Goal']);
const MAX_ODDS=3.70;
const TARGET_PICKS=3;
const SOFA_BASE='https://www.sofascore.com/api/v1';

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
  const requestedCodes=raw==='EUROPE'?null:(raw?raw.split(',').map(normalizeLeague).filter(Boolean):null);
  const market=u.searchParams.get('market')||'all';
  const timeWindow=u.searchParams.get('timeWindow')||'all';
  if(!date) return res.status(400).json({error:'Data mancante'});
  if(!supaUrl||!serviceKey) return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  const cacheKey=`v169-betfair-sofascore|${date}|${requestedCodes?.join(',')||'ALL'}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now()) return res.status(200).json({...cached.data,cached:true});

  let requests=0;
  const requestBreakdown={betfairSnapshot:0,sofascoreSchedule:0,sofascoreStandings:0,sofascoreForm:0};
  const diagnostics=[];

  const bf=await loadBetfairSnapshot(supaUrl,serviceKey);
  requests++; requestBreakdown.betfairSnapshot++;
  diagnostics.push({provider:'betfair-exchange',catalogueRows:bf.catalogueRows,catalogueMarkets:bf.catalogueMarkets,bookMarkets:bf.bookMarkets,marketsWithBook:bf.marketsWithBook||0,matchOddsMarkets:bf.matchOddsMarkets||0,matchOddsWithBack:bf.matchOddsWithBack||0,totalMarketsWithBack:bf.totalMarketsWithBack||0,totalBackRunners:bf.totalBackRunners||0,bttsMarkets:bf.bttsMarkets||0,totalMarkets:bf.totalMarkets||0,eventCount:bf.eventCount||bf.events.size,events:bf.events.size,sample:bf.sample||[],error:bf.error||null,role:'unica fonte delle quote BACK'});

  const betfairFixtures=buildBetfairFixtures(bf.events,date,timeWindow,requestedCodes);
  diagnostics.push({provider:'betfair-fixtures',fixtures:betfairFixtures.length,rule:'solo eventi presenti nel catalogue Betfair sincronizzato; kickoff futuro; bridge previsto sulle prossime 6 ore'});

  if(!betfairFixtures.length){
    const data={date,fixtures:0,analyzed:0,requests,requestBreakdown,candidates:[],liveFixtures:[],diagnostics,disclaimer:'Betfair fornisce gli eventi e le quote BACK. SofaScore fornisce classifica e ultime 3 partite. Quota massima 3,70.',cached:false};
    RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+120000,data});
    return res.status(200).json(data);
  }

  // Un'unica chiamata giornaliera individua gli eventi SofaScore corrispondenti.
  const sofaSchedule=await sofaGet(`/sport/football/scheduled-events/${date}`);
  requests++; requestBreakdown.sofascoreSchedule++;
  diagnostics.push({provider:'sofascore-schedule',events:Array.isArray(sofaSchedule?.events)?sofaSchedule.events.length:0,error:sofaSchedule?.__error||null});
  const sofaEvents=Array.isArray(sofaSchedule?.events)?sofaSchedule.events:[];

  const enriched=[];
  const unmatched=[];
  for(const f of betfairFixtures){
    const odds=extractBetfairOdds(f.match,market,f.home,f.away).filter(o=>o.odd>1&&o.odd<=MAX_ODDS&&ALLOWED_MARKETS.has(o.value));
    if(!odds.length){unmatched.push({fixture:`${f.home} - ${f.away}`,league:f.league,reason:'Betfair presente ma nessuna quota BACK ≤ 3,70 nei mercati richiesti'});continue;}
    const sf=findSofaFixture(f,sofaEvents);
    if(!sf){unmatched.push({fixture:`${f.home} - ${f.away}`,league:f.league,reason:'evento SofaScore non riconosciuto per classifica/ultime 3'});continue;}
    enriched.push({...f,sofa:sf,odds});
  }

  // Classifiche: una richiesta per torneo/stagione, condivisa tra tutte le partite.
  const standingCache=new Map();
  const standingJobs=[];
  for(const f of enriched){
    const tid=f.sofa?.tournamentId, sid=f.sofa?.seasonId;
    if(tid&&sid){const k=`${tid}|${sid}`;if(!standingCache.has(k)){standingCache.set(k,null);standingJobs.push({k,tid,sid});}}
  }
  const standingResults=await mapLimit(standingJobs,5,async job=>{
    const data=await sofaGet(`/unique-tournament/${job.tid}/season/${job.sid}/standings/total`);
    requests++; requestBreakdown.sofascoreStandings++;
    return {job,data};
  });
  for(const x of standingResults){
    const table=parseSofaStandings(x.data); standingCache.set(x.job.k,table);
    diagnostics.push({provider:'sofascore-standings',tournamentId:x.job.tid,seasonId:x.job.sid,teams:table.size,error:x.data?.__error||null});
  }

  // Ultime 3: una chiamata pre-match form per partita; fallback ai match recenti del team.
  const formResults=await mapLimit(enriched,6,async f=>{
    const data=await sofaGet(`/event/${encodeURIComponent(f.sofa.id)}/pregame-form`);
    requests++; requestBreakdown.sofascoreForm++;
    return {f,data};
  });

  const scenarios=[]; const quoted=[];
  for(const {f,data} of formResults){
    const key=`${f.sofa.tournamentId}|${f.sofa.seasonId}`;
    const table=standingCache.get(key)||new Map();
    const hs=findStanding(table,f.home,f.sofa.homeId);
    const as=findStanding(table,f.away,f.sofa.awayId);
    const recent=parseSofaPregameForm(data,f.home,f.away);
    const probs=estimateProbabilities(hs,as,recent.home,recent.away,f.home,f.away);
    quoted.push(f);
    for(const o of f.odds){
      const p=probs[o.value];
      if(!Number.isFinite(p)||p<=0)continue;
      scenarios.push(makeScenario(f,o,p,hs,as,recent));
    }
  }

  const bestByMatch=new Map();
  for(const s of scenarios){const k=normalizePair(s.home,s.away);const old=bestByMatch.get(k);if(!old||Number(s.prob)>Number(old.prob))bestByMatch.set(k,s);}
  const candidates=[...bestByMatch.values()].sort((a,b)=>Number(b.prob)-Number(a.prob));
  const finalPicks=candidates.slice(0,TARGET_PICKS);

  diagnostics.push({provider:'v169-model',scenarios:scenarios.length,quotedFixtures:quoted.length,candidates:candidates.length,returned:finalPicks.length,maxOdds:MAX_ODDS,markets:[...ALLOWED_MARKETS],rule:'un solo scenario per partita; TOP 3 ordinato esclusivamente per probabilità; quota Betfair non entra nella probabilità'});
  diagnostics.push({provider:'betfair-sofascore-matching',matched:quoted.length,unmatched:unmatched.slice(0,30),unmatchedCount:unmatched.length});
  if(!finalPicks.length) diagnostics.push({provider:'no-candidates-debug',reason:betfairFixtures.length?'Nessuna partita Betfair con quota BACK compatibile e dati statistici riconosciuti.':'Nessun evento Betfair nel periodo.',betfairEvents:bf.events.size,sofascoreEvents:sofaEvents.length});

  const disclaimer=`Il modello usa Betfair per eventi e quote BACK e SofaScore per classifica e ultime 3 partite. Quota massima ${MAX_ODDS.toFixed(2)}. Il TOP 3 è ordinato solo per probabilità stimata: la quota non entra nel calcolo della probabilità.`;
  await logModelPredictions(supaUrl,serviceKey,date,finalPicks);
  const liveFixtures=[];
  const data={date,fixtures:betfairFixtures.length,analyzed:quoted.length,requests,requestBreakdown,candidates:candidates.slice(0,120),liveFixtures,diagnostics,disclaimer,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?120000:600000),data});
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json(data);
}

function buildBetfairFixtures(events,date,timeWindow,requestedCodes){
  const out=[]; const seen=new Set(); const now=Date.now();
  for(const [,entry] of events){
    for(const m of entry){
      const teams=m.eventTeams||parseEventTeams(m?.event?.name||''); if(!teams)continue;
      const kickoff=eventTime(m); if(!kickoff)continue;
      if(localDate(kickoff.toISOString())!==date)continue;
      if(kickoff.getTime()<=now)continue;
      if(!timeWindowAllows(kickoff.toISOString(),timeWindow))continue;
      const league=m?.competition?.name||m?.event?.competition?.name||'Betfair';
      if(requestedCodes?.length&&!requestedCodes.some(code=>leagueMatchesCode(league,code)))continue;
      const eventId=String(m?.event?.id||m?.event?.name||'');
      const k=eventId||normalizePair(teams.home,teams.away);
      if(seen.has(k))continue; seen.add(k);
      const match=findBestBetfairFixture(teams.home,teams.away,events,kickoff.toISOString());
      if(!match)continue;
      out.push({home:teams.home,away:teams.away,date:kickoff.toISOString(),kickoff:kickoff.toISOString(),league,leagueCode:leagueCodeFromName(league),match});
    }
  }
  return out.sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
}

function findSofaFixture(f,events){
  let best=null,bestScore=0,bestDist=Infinity;
  for(const ev of events){
    if(!ev?.homeTeam?.name||!ev?.awayTeam?.name)continue;
    const direct=(teamSimilarity(f.home,ev.homeTeam.name)+teamSimilarity(f.away,ev.awayTeam.name))/2;
    const reverse=(teamSimilarity(f.home,ev.awayTeam.name)+teamSimilarity(f.away,ev.homeTeam.name))/2;
    const score=Math.max(direct,reverse);
    if(score<.68)continue;
    const ts=Number(ev.startTimestamp)*1000; const dist=Number.isFinite(ts)?Math.abs(ts-new Date(f.kickoff).getTime()):Infinity;
    if(!best||score>bestScore+.02||(Math.abs(score-bestScore)<=.02&&dist<bestDist)){best=ev;bestScore=score;bestDist=dist;}
  }
  if(!best)return null;
  return {id:String(best.id),homeId:best.homeTeam?.id,awayId:best.awayTeam?.id,tournamentId:best.tournament?.uniqueTournament?.id||best.tournament?.uniqueTournamentId||best.tournament?.id,seasonId:best.season?.id,homeName:best.homeTeam?.name,awayName:best.awayTeam?.name,score:bestScore};
}

function parseSofaStandings(payload){
  if(payload?.__error)return new Map();
  const root=payload?.standings?.[0]||payload?.standings||payload;
  const rows=Array.isArray(root?.rows)?root.rows:[]; const total=rows.length; const map=new Map();
  for(const r of rows){const name=r?.team?.name||r?.team?.shortName||'';if(!name)continue;const position=Number(r.position);const points=Number(r.points);const played=Number(r.matches);map.set(teamKey(name),{teamId:r.team?.id,teamName:name,position:Number.isFinite(position)?position:null,totalTeams:total,points:Number.isFinite(points)?points:null,playedGames:Number.isFinite(played)?played:null});}
  return map;
}
function findStanding(table,name,id){if(id){for(const v of table.values())if(String(v.teamId)===String(id))return v;}return table.get(teamKey(name))||null;}

function parseSofaPregameForm(payload,home,away){
  const result={home:[],away:[]};
  if(payload?.__error)return result;
  const root=payload;
  // Gestione delle forme più comuni dell'endpoint pregame-form: home/away con form/lastMatches/results.
  const sides=[['home',home],['away',away]];
  for(const [side,name] of sides){
    const obj=root?.[side]||root?.[`${side}Team`]||root?.[side==='home'?'homeTeam':'awayTeam']||{};
    const candidates=[];
    for(const key of ['form','lastMatches','events','matches','results']) if(Array.isArray(obj?.[key]))candidates.push(...obj[key]);
    if(!candidates.length){
      const arr=findArraysContainingMatches(obj); candidates.push(...arr.flat());
    }
    const rows=candidates.map(x=>adaptSofaMatch(x)).filter(Boolean).filter(m=>localDate(m.date)<localTodayRome()||m.finished).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,3).reverse();
    result[side]=rows;
  }
  return result;
}
function findArraysContainingMatches(v){const out=[];walk(v,x=>{if(Array.isArray(x)&&x.some(y=>y&&typeof y==='object'&&(y.homeTeam||y.awayTeam||y.home||y.away||y.homeScore||y.awayScore)))out.push(x);});return out;}
function adaptSofaMatch(x){
  const home=x?.homeTeam?.name||x?.home?.team?.name||x?.home?.name||x?.homeTeam||'';
  const away=x?.awayTeam?.name||x?.away?.team?.name||x?.away?.name||x?.awayTeam||'';
  const hg=Number(x?.homeScore?.current??x?.homeScore?.display??x?.home?.score?.current??x?.home?.score??x?.homeScore);const ag=Number(x?.awayScore?.current??x?.awayScore?.display??x?.away?.score?.current??x?.away?.score??x?.awayScore);
  const ts=Number(x?.startTimestamp)*1000; const date=Number.isFinite(ts)&&ts>0?new Date(ts).toISOString():x?.date||x?.startTime||'';
  if(!home||!away||!Number.isFinite(hg)||!Number.isFinite(ag)||!date)return null;
  const status=String(x?.status?.type||x?.status?.description||'').toLowerCase();
  return {home,away,date,score:{home:hg,away:ag},finished:status.includes('finish')||status.includes('ended')||status==='100'};
}

function leagueCodeFromName(name){const n=normalize(name);if(/serie a/.test(n)&&/ital/.test(n))return 'SA';if(/serie b/.test(n)&&/ital/.test(n))return 'SB';if(/premier league/.test(n))return 'PL';if(/laliga|la liga/.test(n))return 'PD';if(/bundesliga/.test(n))return 'BL1';if(/ligue 1/.test(n))return 'FL1';if(/primeira|liga portugal/.test(n))return 'PPL';if(/eredivisie/.test(n))return 'DED';if(/belgian|jupiler/.test(n))return 'BEL1';if(/scottish|premiership/.test(n))return 'SCO1';if(/champions league/.test(n))return 'CL';if(/europa league/.test(n))return 'EL';if(/conference league/.test(n))return 'ECL';return null;}
function leagueMatchesCode(name,code){const c=leagueCodeFromName(name);return c===code;}

async function sofaGet(path){
  try{
    const r=await fetch(`${SOFA_BASE}${path}`,{headers:{Accept:'application/json','Origin':'https://www.sofascore.com','Referer':'https://www.sofascore.com/'},cache:'no-store'});
    const text=await r.text(); if(!r.ok)return {__error:`SofaScore HTTP ${r.status}: ${text.slice(0,220)}`}; return text?JSON.parse(text):{};
  }catch(e){return {__error:e?.message||String(e)};}
}

function makeScenario(f,o,p,hs,as,recent){
  return {home:f.home,away:f.away,market:marketLabel(o.value),odds:o.odd,prob:round(p),pStat:round(p),pMarket:null,pFair:round(p),edge:null,score:round(p),topSelectionScore:round(p),confidence:round(p),analysisSupport:analysisSupport(hs,as,recent.home,recent.away),modelReady:Boolean(hs&&as&&recent.home.length>=2&&recent.away.length>=2),topEligible:true,modelSample:Math.min(recent.home.length,3),probabilitySource:'Classifica + ultime 3 partite',modelVersion:'V169-BETFAIR-SOFASCORE',homeStanding:hs||null,awayStanding:as||null,standingNote:standingNote(f.home,hs,f.away,as),recentForm:{home:recent.home,away:recent.away,homeMatches:recent.home.length,awayMatches:recent.away.length},reason:buildReason(p,f.home,f.away,hs,as,recent.home,recent.away),oddsSource:'Betfair Exchange',statsSource:'SofaScore',fixtureId:`sofascore-${f.sofa.id}`,eventId:f.sofa.id,kickoff:f.kickoff,league:f.league,leagueCode:f.leagueCode,priorityLeague:false,homeLogo:null,awayLogo:null,riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value',oddsAgeMin:o.quoteAgeMin,fieldAnalysis:{reason:buildReason(p,f.home,f.away,hs,as,recent.home,recent.away),confidence:round(p),confidenceLabel:p>=70?'Alta':p>=55?'Media':'Bassa',warnings:[]}};
}

async function supaWrite(url,key,path,rows){const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});if(!r.ok){const t=await r.text();throw new Error(`Supabase write ${r.status}: ${t.slice(0,300)}`);}}
async function logModelPredictions(url,key,date,picks){if(!picks.length)return;const rows=picks.map(p=>({match_date:date,league_code:p.leagueCode||null,league:p.league||null,home:p.home,away:p.away,event_id:p.eventId?String(p.eventId):null,fixture_id:p.fixtureId||null,market:p.market,odds:Number.isFinite(p.odds)?p.odds:null,odds_cap_used:MAX_ODDS,prob_model:Number.isFinite(p.pStat)?p.pStat:null,prob_market:null,prob_blended:null,edge_percent:null,model_sample:Number.isFinite(p.modelSample)?p.modelSample:null,kickoff:p.kickoff||null,settled:false,result:null}));try{await supaWrite(url,key,'model_predictions?on_conflict=match_date,home,away,market',rows);}catch(e){console.error('AI DEL PALLONE log model_predictions error',e?.message||e);}}

function estimateProbabilities(hs,as,hm,am,homeName,awayName){
  // Modello volutamente semplice: classifica + ultime 3. Nessun ELO,
  // Poisson, Monte Carlo, H2H, edge o blending con la quota.
  const hS=standingStrength(hs),aS=standingStrength(as);
  const fH=pointsFromTeamRows(hm,homeName),fA=pointsFromTeamRows(am,awayName);
  const fDiff=(fH/Math.max(1,hm.length*3))-(fA/Math.max(1,am.length*3));
  const sDiff=hS-aS;
  let home=0.5+sDiff*.23+fDiff*.07+0.045;
  let draw=0.27-Math.abs(sDiff)*.06-Math.abs(fDiff)*.03;
  let away=1-home-draw;
  home=clamp(home,.12,.78);away=clamp(away,.10,.72);draw=clamp(draw,.16,.34);
  const sum=home+draw+away;home/=sum;draw/=sum;away/=sum;

  const totals=goalMarketProbabilities(hm,am,homeName,awayName,sDiff,fDiff);
  return {'1':home*100,'X':draw*100,'2':away*100,...totals};
}

function goalMarketProbabilities(hm,am,homeName,awayName,sDiff,fDiff){
  const rows=[...hm,...am].filter(m=>Number.isFinite(Number(m.score?.home))&&Number.isFinite(Number(m.score?.away)));
  const fallback=.5;
  const freq=(predicate)=>rows.length?rows.filter(predicate).length/rows.length:fallback;
  const over=(line)=>freq(m=>(Number(m.score.home)+Number(m.score.away))>line);
  const under=(line)=>1-over(line);
  const btts=freq(m=>Number(m.score.home)>0&&Number(m.score.away)>0);

  // Piccola correzione con classifica + forma, senza usare la quota.
  // Tiene le stime entro un intervallo realistico e non inventa precisione.
  const formBoost=clamp((fDiff||0)*.05+(sDiff||0)*.03,-.08,.08);
  const adjust=(p)=>clamp(p+formBoost,0.10,0.90);
  const p15=adjust(over(1.5));
  const p25=adjust(over(2.5));
  const p35=adjust(over(3.5));
  const pBtts=adjust(btts);
  return {
    'Over 1.5':p15*100,'Under 1.5':(1-p15)*100,
    'Over 2.5':p25*100,'Under 2.5':(1-p25)*100,
    'Over 3.5':p35*100,'Under 3.5':(1-p35)*100,
    'Goal':pBtts*100,'No Goal':(1-pBtts)*100
  };
}

function analysisSupport(hs,as,hm,am){let s=45;if(hs&&as)s+=30;if(hm.length>=3&&am.length>=3)s+=25;else if(hm.length>=2&&am.length>=2)s+=15;return clamp(s,0,100);}
function buildReason(prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);if(hm.length)bits.push(`${home}: ${pointsFromTeamRows(hm,home)} punti nelle ultime ${hm.length}`);if(am.length)bits.push(`${away}: ${pointsFromTeamRows(am,away)} punti nelle ultime ${am.length}`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join('. ')+'.';}
function pointsFromTeamRows(rows,name){let p=0;for(const m of rows){const hg=Number(m.score?.home),ag=Number(m.score?.away);if(!Number.isFinite(hg)||!Number.isFinite(ag))continue;const isHome=teamSimilarity(m.home,name)>=.72;const gf=isHome?hg:ag,ga=isHome?ag:hg;p+=gf>ga?3:gf===ga?1:0;}return p;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position&&hs?.totalTeams)x.push(`${home} è ${hs.position}ª su ${hs.totalTeams}`);if(as?.position&&as?.totalTeams)x.push(`${away} è ${as.position}º su ${as.totalTeams}`);return x.length?x.join('; '):null;}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}

function findBestBetfairFixture(home,away,events,kickoff){
  let best=null,bestScore=0,bestDist=Infinity;
  const target=normalizePair(home,away);
  for(const [key,entry] of events){
    if(key===target){
      const x=bestTimedEvent(entry,kickoff,1);
      if(x)return x;
    }
  }
  for(const [,entry] of events){
    for(const e of entry){
      const teams=e?.eventTeams||parseEventTeams(e?.event?.name||'');
      if(!teams)continue;
      const direct=(teamSimilarity(home,teams.home)+teamSimilarity(away,teams.away))/2;
      const reverse=(teamSimilarity(home,teams.away)+teamSimilarity(away,teams.home))/2;
      const score=Math.max(direct,reverse);
      if(score<.50)continue;
      const dt=eventTime(e);
      const dist=kickoff&&dt?Math.abs(new Date(kickoff).getTime()-dt.getTime()):0;
      // Squad names are the primary signal. Kickoff proximity breaks ties and
      // prevents a same-team fixture from another round being selected.
      if(!best || score>bestScore+.015 || (Math.abs(score-bestScore)<=.015 && dist<bestDist)){
        best=e;bestScore=score;bestDist=dist;
      }
    }
  }
  if(!best)return null;
  const eventKey=String(best.event?.id||best.event?.name||best.marketId);
  const group=[];
  for(const [,entry] of events)for(const m of entry){
    const k=String(m.event?.id||m.event?.name||m.marketId);
    if(k===eventKey)group.push(m);
  }
  return {markets:group.length?group:[best],score:bestScore,eventTeams:best.eventTeams||parseEventTeams(best.event?.name||'')};
}
function bestTimedEvent(markets,kickoff,score){
  if(!Array.isArray(markets)||!markets.length)return null;
  let best=null,bestDist=Infinity;
  for(const m of markets){
    if(!m?.marketId)continue;
    const dt=eventTime(m);
    const dist=kickoff&&dt?Math.abs(new Date(kickoff).getTime()-dt.getTime()):0;
    if(!best||dist<bestDist){best=m;bestDist=dist;}
  }
  if(!best)return null;
  const eventKey=String(best.event?.id||best.event?.name||best.marketId);
  const group=markets.filter(m=>String(m.event?.id||m.event?.name||m.marketId)===eventKey);
  return {markets:group,score,eventTeams:best.eventTeams||parseEventTeams(best.event?.name||'')};
}
function eventTime(m){
  const v=m?.marketStartTime||m?.event?.openDate;
  const d=v?new Date(v):null;
  return d&&!Number.isNaN(d.getTime())?d:null;
}

function findNearestBetfairEvents(home,away,events,kickoff,limit=3){
  const rows=[];
  for(const [,entry] of events){
    for(const e of entry){
      const teams=e?.eventTeams||parseEventTeams(e?.event?.name||''); if(!teams)continue;
      const direct=(teamSimilarity(home,teams.home)+teamSimilarity(away,teams.away))/2;
      const reverse=(teamSimilarity(home,teams.away)+teamSimilarity(away,teams.home))/2;
      const score=Math.max(direct,reverse); const dt=eventTime(e);
      const dist=kickoff&&dt?Math.round(Math.abs(new Date(kickoff)-dt)/60000):null;
      rows.push({event:e.event?.name||'',score:round(score),minutesFromKickoff:dist,hasBook:Boolean(e.hasBook)});
    }
  }
  return rows.sort((a,b)=>Number(b.score)-Number(a.score)||(a.minutesFromKickoff??999999)-(b.minutesFromKickoff??999999)).slice(0,limit);
}

function deriveBetfairMarketType(m={}){
  const type=String(m.marketType||m.description?.marketType||'').toUpperCase().trim();
  if(type) return type;
  const name=String(m.marketName||'').toLowerCase();
  if(/match\s*odds|1x2|esito\s*finale/.test(name)) return 'MATCH_ODDS';
  if(/both\s*teams\s*to\s*score|goal\s*\/\s*no\s*goal|goal\s*no\s*goal/.test(name)) return 'BOTH_TEAMS_TO_SCORE';
  const n=name.replace(',', '.');
  const line=n.match(/(?:over|under|over\s*\/\s*under|under\s*\/\s*over)[^0-9]*(1\.5|2\.5|3\.5)/);
  if(line) return `OVER_UNDER_${line[1].replace('.','_')}`;
  return '';
}

function extractBetfairOdds(match,requestedMarket,home,away){
  const out=[];
  const allowAll=requestedMarket==='all';
  const allowOne=allowAll||requestedMarket==='1x2';
  const allowTotals=allowAll||requestedMarket==='totals';
  const allowBtts=allowAll||requestedMarket==='btts';

  for(const m of (match?.markets||[])){
    const type=deriveBetfairMarketType(m);
    const name=String(m.marketName||'');
    const low=name.toLowerCase().replace(',', '.');
    const isMatch=type==='MATCH_ODDS';
    const isBtts=type==='BOTH_TEAMS_TO_SCORE';
    let line=null;
    const tm=type.match(/^OVER_UNDER_(1_5|2_5|3_5)$/);
    if(tm) line=Number(tm[1].replace('_','.'));
    if(!line){
      const nm=low.match(/(?:over|under|over\s*\/\s*under|under\s*\/\s*over)[^0-9]*(1\.5|2\.5|3\.5)/);
      if(nm) line=Number(nm[1]);
    }
    const isTotal=Boolean(line&&[1.5,2.5,3.5].includes(line));

    if(isMatch&&!allowOne)continue;
    if(isTotal&&!allowTotals)continue;
    if(isBtts&&!allowBtts)continue;
    if(!isMatch&&!isTotal&&!isBtts)continue;

    for(const r of (Array.isArray(m.runners)?m.runners:[])){
      const odd=bestBack(r);
      if(!(odd>1&&Number.isFinite(odd)))continue;
      const raw=String(r.name||r.runnerName||'').trim();
      const label=normalize(raw);
      let value=null;

      if(isMatch){
        if(['x','draw','the draw','pareggio','tie'].includes(label)) value='X';
        else if(label==='1') value='1';
        else if(label==='2') value='2';
        else if(teamSimilarity(raw,home)>=.72) value='1';
        else if(teamSimilarity(raw,away)>=.72) value='2';
      }else if(isBtts){
        if(/^(yes|si|sì|goal|gg|both teams to score)$/.test(label)) value='Goal';
        else if(/^(no|ng|no goal|both teams not to score)$/.test(label)) value='No Goal';
      }else if(isTotal){
        if(/^over\b/i.test(raw)||label.startsWith('over ')) value=`Over ${line.toFixed(1)}`;
        else if(/^under\b/i.test(raw)||label.startsWith('under ')) value=`Under ${line.toFixed(1)}`;
      }

      if(value)out.push({value,odd,quoteAgeMin:r.quoteAgeMin??m.quoteAgeMin??null,liquidity:r.backSize??null,marketId:m.marketId,marketName:name,marketType:type,runnerName:raw,selectionId:r.selectionId});
    }
  }
  const best=new Map();
  for(const x of out){const old=best.get(x.value);if(!old||x.odd>old.odd)best.set(x.value,x);}
  return [...best.values()];
}

async function loadBetfairSnapshot(url,key){try{
  const catRows=await supaRead(url,key,'betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1');
  const bookRows=await supaRead(url,key,'betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=5000');
  const latestBook=new Map();
  for(const r of bookRows){if(r?.market_id&&!latestBook.has(String(r.market_id)))latestBook.set(String(r.market_id),r);}

  const events=new Map();
  let catalogueMarkets=0,marketsWithBook=0,eventCount=0,matchOddsMarkets=0,matchOddsWithBack=0,totalMarketsWithBack=0,totalBackRunners=0,bttsMarkets=0,totalMarkets=0;
  const seenMarkets=new Set();

  for(const row of catRows){
    for(const m of unwrapCatalogue(row?.payload)){
      const mid=String(m.marketId||'');
      if(!mid||seenMarkets.has(mid))continue;
      seenMarkets.add(mid); catalogueMarkets++;
      const book=latestBook.get(mid);
      if(book)marketsWithBook++;
      const bookRunners=book?unwrapBooks(book.payload):[];
      const catRunners=Array.isArray(m.runners)?m.runners:[];
      const runners=bookRunners.map(r=>({
        selectionId:r.selectionId,
        status:r.status,
        backPrice:bestBack(r),
        backSize:bestBackSize(r),
        name:(catRunners.find(x=>String(x?.selectionId)===String(r.selectionId))?.runnerName)||r.runnerName||String(r.selectionId),
        quoteAgeMin:ageMin(book?.received_at)
      }));
      const eventTeams=parseEventTeams(m?.event?.name||'');
      if(!eventTeams)continue;
      const marketName=String(m.marketName||'');
      const marketType=deriveBetfairMarketType(m);
      const isMatchOdds=marketType==='MATCH_ODDS';
      const isBtts=marketType==='BOTH_TEAMS_TO_SCORE';
      const isTotal=/^OVER_UNDER_(1_5|2_5|3_5)$/.test(marketType);
      const hasBack=runners.some(r=>Number.isFinite(r.backPrice)&&r.backPrice>1);
      const backRunnerCount=runners.filter(r=>Number.isFinite(r.backPrice)&&r.backPrice>1).length;
      if(isMatchOdds)matchOddsMarkets++;
      if(isMatchOdds&&hasBack)matchOddsWithBack++;
      if(isBtts)bttsMarkets++;
      if(isTotal)totalMarkets++;
      if(hasBack){totalMarketsWithBack++;totalBackRunners+=backRunnerCount;}
      const item={marketId:mid,marketName,marketType,event:m.event||null,competition:m.competition||null,marketStartTime:m.marketStartTime||m.event?.openDate||null,receivedAt:book?.received_at||row.received_at,runners,eventTeams,hasBook:Boolean(book),hasBack,backRunnerCount};
      const k=normalizePair(eventTeams.home,eventTeams.away);
      if(!events.has(k)){events.set(k,[]);eventCount++;}
      events.get(k).push(item);
    }
  }
  const sample=[...events.values()].flat().slice(0,50).map(m=>({name:m.event?.name||'',market:m.marketName,marketType:m.marketType,hasBook:m.hasBook,hasBack:m.hasBack,backRunnerCount:m.backRunnerCount,marketId:m.marketId,runners:m.runners.map(r=>({selectionId:r.selectionId,name:r.name,back:r.backPrice}))}));
  return {events,catalogueRows:catRows.length,catalogueMarkets,bookMarkets:latestBook.size,marketsWithBook,matchOddsMarkets,matchOddsWithBack,totalMarketsWithBack,totalBackRunners,bttsMarkets,totalMarkets,eventCount,sample,error:null};
 }catch(e){return {events:new Map(),catalogueRows:0,catalogueMarkets:0,bookMarkets:0,marketsWithBook:0,matchOddsMarkets:0,matchOddsWithBack:0,totalMarketsWithBack:0,totalBackRunners:0,bttsMarkets:0,totalMarkets:0,eventCount:0,sample:[],error:e?.message||String(e)};}}

function parseMaybeJson(value){
  if(typeof value!=='string') return value;
  let v=value;
  for(let i=0;i<3&&typeof v==='string';i++){try{v=JSON.parse(v);}catch{return value;}}
  return v;
}
function unwrapCatalogue(payload){const out=[];const root=parseMaybeJson(payload);walk(root,v=>{if(v?.marketId&&v?.marketName)out.push(v);});return out;}
function unwrapBooks(payload){const out=[];const root=parseMaybeJson(payload);walk(root,v=>{if(v&&v.selectionId!=null&&('status' in v||v.ex))out.push(v);});return out;}
function bestBack(r){const direct=Number(r?.backPrice);if(direct>1&&Number.isFinite(direct))return direct;const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];const prices=xs.map(x=>Number(x?.price)).filter(x=>x>1&&Number.isFinite(x));return prices.length?Math.max(...prices):null;}
function bestBackSize(r){const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.length?Number(xs[0]?.size)||null:null;}
function parseEventTeams(name){
  const s=String(name||'').replace(/\s+/g,' ').trim();
  if(!s)return null;
  const p=s.split(/\s+(?:v|vs|versus|@)\s+|\s+[-–—]\s+/i);
  if(p.length>=2)return {home:p[0].trim(),away:p.slice(1).join(' ').trim()};
  return null;
}

async function supaRead(url,key,path){const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});const text=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);return text?JSON.parse(text):[];}
function ageMin(ts){if(!ts)return null;const d=new Date(ts).getTime();return Number.isFinite(d)?Math.max(0,(Date.now()-d)/60000):null;}
function marketLabel(v){return({'1':'1 (Casa)','X':'X (Pareggio)','2':'2 (Trasferta)'}[v])||v;}
function normalizeLeague(x){const s=String(x||'').trim().toUpperCase();const aliases={'135':'SA','136':'SB','39':'PL','140':'PD','78':'BL1','61':'FL1','2':'CL','88':'DED','94':'PPL'};return aliases[s] || (LEAGUE_CODES.has(s)?s:null);}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();}
function teamKey(s){let n=normalize(s);const aliases={inter:'internazionale', 'inter milan':'internazionale', 'internazionale milano':'internazionale', 'ac milan':'milan', 'hellas verona':'verona', 'as roma':'roma', 'ss lazio':'lazio', 'ssc napoli':'napoli', 'juventus fc':'juventus'};n=aliases[n]||n;return n.replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the|ss|as|ssc|cfc|bk|sv)\b/g,' ').replace(/\s+/g,' ').trim();}
function clean(s){return teamKey(s).replace(/\b\d{2,4}\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function levenshtein(a,b){
  const x=String(a||''),y=String(b||''); if(x===y)return 0;
  const prev=Array.from({length:y.length+1},(_,i)=>i);
  for(let i=1;i<=x.length;i++){let cur=[i];for(let j=1;j<=y.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(x[i-1]===y[j-1]?0:1));for(let j=0;j<=y.length;j++)prev[j]=cur[j];}
  return prev[y.length];
}
function teamSimilarity(a,b){
  const aa=teamKey(a),bb=teamKey(b); if(!aa||!bb)return 0;
  if(aa===bb)return 1;
  if(aa.includes(bb)||bb.includes(aa))return .96;
  const ca=clean(a),cb=clean(b);
  if(ca&&cb&&(ca.includes(cb)||cb.includes(ca)))return .94;
  const A=new Set(aa.split(' ').filter(x=>x.length>2)),B=new Set(bb.split(' ').filter(x=>x.length>2));
  let c=0;for(const x of A)if(B.has(x))c++;
  const j=c/(A.size+B.size-c||1);
  const lev=1-levenshtein(ca,cb)/Math.max(ca.length,cb.length,1);
  return Math.max(j,(c/Math.max(1,Math.min(A.size,B.size)))*.93,lev*.88);
}
function isLiveStatus(s){return String(s||'').toUpperCase()==='LIVE';}
function localDate(iso){try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}catch{return String(iso||'').slice(0,10);}}
function localTodayRome(){return localDate(new Date().toISOString());}
function timeWindowAllows(iso,w){try{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));const m=Number(p.find(x=>x.type==='hour')?.value)*60+Number(p.find(x=>x.type==='minute')?.value);if(w==='afternoon1')return m>=780&&m<=960;if(w==='afternoon2')return m>=961&&m<=1140;if(w==='evening')return m>=1141&&m<=1320;return m>=660&&m<=1320;}catch{return false;}}
function shiftDate(iso,delta){const d=new Date(`${iso}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}
function walk(v,cb){if(v==null)return;if(typeof v!=='object')return;cb(v);if(Array.isArray(v)){for(const x of v)walk(x,cb);}else{for(const x of Object.values(v))walk(x,cb);}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
