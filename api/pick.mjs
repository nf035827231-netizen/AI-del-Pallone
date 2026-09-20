const RESPONSE_CACHE = new Map();
const BOOKMAKER_CACHE = { expires: 0, names: [] };

// AI DEL PALLONE — Odds-API.io + Football-Data.org
const MAX_ODDS = 3.70;
const TARGET_PICKS = 3;
const LOOKAHEAD_HOURS = 3;
const LOOKAHEAD_MS = LOOKAHEAD_HOURS * 60 * 60 * 1000;
const ODDS_BASE = 'https://api.odds-api.io/v3';
const FD_BASE = 'https://api.football-data.org/v4';
const SOCCER_TO_FD = {
  'italy-serie-a':'SA','italy-serie-b':'SB','england-premier-league':'PL','spain-la-liga':'PD','germany-bundesliga':'BL1','france-ligue-1':'FL1',
  'portugal-primeira-liga':'PPL','netherlands-eredivisie':'DED','belgium-first-division-a':'BEL1','scotland-premiership':'SCO1','austria-bundesliga':'AUT1',
  'switzerland-super-league':'SUI1','turkey-super-lig':'TUR1','greece-super-league':'GRE1','denmark-superliga':'DEN1','sweden-allsvenskan':'SWE1',
  'norway-eliteserien':'NOR1','poland-ekstraklasa':'POL1','czech-republic-first-league':'CZE1','croatia-hnl':'CRO1','serbia-superliga':'SRB1',
  'romania-liga-1':'ROU1','ukraine-premier-league':'UKR1','hungary-nb-i':'HUN1','slovakia-super-liga':'SVK1',
  'uefa-champions-league':'CL','uefa-europa-league':'EL','uefa-europa-conference-league':'ECL'
};
const FD_TO_ODDS = Object.fromEntries(Object.entries(SOCCER_TO_FD).map(([slug,code])=>[code,slug]));
const ALLOWED_MARKETS = new Set(['1','X','2','Over 1.5','Under 1.5','Over 2.5','Under 2.5','Over 3.5','Under 3.5','Goal','No Goal']);

export default async function safeHandler(req,res){
  try{return await handler(req,res);}catch(e){
    console.error('AI DEL PALLONE /api/pick error',e);
    if(!res.headersSent)res.status(500).json({error:`Errore interno durante l'analisi: ${e?.message||String(e)}`});
  }
}

async function handler(req,res){
  const u=new URL(req.url,'https://vercel.local');
  const date=u.searchParams.get('date');
  const raw=u.searchParams.get('leagues')||'';
  const requestedCodes=raw==='EUROPE'?null:(raw?raw.split(',').map(normalizeLeague).filter(Boolean):null);
  const market=u.searchParams.get('market')||'all';
  const timeWindow=u.searchParams.get('timeWindow')||'all';
  if(!date)return res.status(400).json({error:'Data mancante'});

  const oddsKey=process.env.ODDS_API_KEY||'';
  const fdToken=process.env.FOOTBALL_DATA_TOKEN||'';
  const supaUrl=process.env.SUPABASE_URL||'';
  const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  const cacheKey=`v175-3h-oddsapiio-footballdata|${date}|${requestedCodes?.join(',')||'ALL'}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now())return res.status(200).json({...cached.data,cached:true});

  const diagnostics=[]; let requests=0; const requestBreakdown={oddsApiIo:0,footballData:0};
  if(!oddsKey){diagnostics.push({provider:'odds-api.io',error:'ODDS_API_KEY non configurata'});return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown,disclaimer:'Configura ODDS_API_KEY e FOOTBALL_DATA_TOKEN in Vercel.'},cacheKey);}
  if(!fdToken){diagnostics.push({provider:'football-data.org',error:'FOOTBALL_DATA_TOKEN non configurata'});return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown,disclaimer:'Configura ODDS_API_KEY e FOOTBALL_DATA_TOKEN in Vercel.'},cacheKey);}

  // 1) Discover leagues covered by Odds-API.io.
  const leaguesPayload=await oddsGet('/leagues',oddsKey,{sport:'football'}); requests++; requestBreakdown.oddsApiIo++;
  if(leaguesPayload?.__error)return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics:[{provider:'odds-api.io',error:leaguesPayload.__error}],requests,requestBreakdown},cacheKey);
  const leagues=Array.isArray(leaguesPayload)?leaguesPayload:[];
  const selectedLeagues=selectLeagues(leagues,requestedCodes);
  diagnostics.push({provider:'odds-api.io',leaguesFound:leagues.length,leaguesSelected:selectedLeagues.map(x=>({slug:x.slug,name:x.name,fdCode:x.fdCode,eventCount:x.eventCount||0})),role:'unica fonte di calendario e quote'});
  if(!selectedLeagues.length){
    return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics:[...diagnostics,{provider:'no-candidates-debug',reason:'Nessun campionato Odds-API.io compatibile con i filtri selezionati.'}],requests,requestBreakdown},cacheKey);
  }

  // 2) Get all pending football events in one request, then filter locally to 0-3h.
  // This is much cheaper than one /events request per league.
  const windowStart=Date.now();
  const windowEnd=windowStart+LOOKAHEAD_MS;
  const eventPayload=await oddsGet('/events',oddsKey,{sport:'football',status:'pending',limit:100});
  requests++; requestBreakdown.oddsApiIo++;
  if(eventPayload?.__error){
    return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics:[...diagnostics,{provider:'odds-api.io-events',error:eventPayload.__error}],requests,requestBreakdown},cacheKey);
  }
  const rawEvents=[];
  for(const e of Array.isArray(eventPayload)?eventPayload:[]){
    const kickoff=e?.date; if(!kickoff)continue;
    const kickoffMs=Date.parse(kickoff);
    if(!Number.isFinite(kickoffMs))continue;
    if(kickoffMs<windowStart||kickoffMs>windowEnd)continue;
    if(localDate(kickoff)!==date)continue;
    if(!timeWindowAllows(kickoff,timeWindow))continue;
    const slug=normalizeLeagueSlug(e?.league?.slug||'');
    const fdCode=SOCCER_TO_FD[slug]||SOCCER_TO_FD[leagueSlugAlias(slug,e?.league?.name)]||null;
    if(requestedCodes?.length && !requestedCodes.includes(fdCode))continue;
    if(!fdCode)continue;
    rawEvents.push(normalizeOddsEvent(e,{slug,name:e?.league?.name||slug,fdCode}));
  }
  const events=dedupeEvents(rawEvents);
  diagnostics.push({provider:'odds-api.io-events',fixtures:events.length,apiEvents:Array.isArray(eventPayload)?eventPayload.length:0,rule:`unica richiesta /events; solo eventi pending futuri nelle prossime ${LOOKAHEAD_HOURS} ore; nessun evento live`,windowStart:new Date(windowStart).toISOString(),windowEnd:new Date(windowEnd).toISOString()});
  if(!events.length)return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown},cacheKey);

  // 3) Discover accessible bookmakers once, then batch odds. Odds-API.io requires
  // the bookmakers parameter on /odds and /odds/multi. Keep the list cached for 1 hour
  // so this does not become a repeated source of unnecessary calls.
  const bookmakerData=await getBookmakersCached(oddsKey);
  if(bookmakerData.error){
    requests++; requestBreakdown.oddsApiIo++;
    diagnostics.push({provider:'odds-api.io-bookmakers',error:bookmakerData.error});
  } else if(bookmakerData.fetched){
    requests++; requestBreakdown.oddsApiIo++;
  }
  const bookmakerNames=bookmakerData.names||[];
  diagnostics.push({provider:'odds-api.io-bookmakers',available:bookmakerNames.length,selected:bookmakerNames.slice(0,30),rule:'nomi bookmaker ottenuti da /bookmakers e passati esplicitamente a /odds/multi'});

  const oddsMap=new Map();
  const eventIds=events.map(e=>String(e.id));
  const batches=chunk(eventIds,10);
  for(const ids of batches){
    const params={eventIds:ids.join(',')};
    if(bookmakerNames.length)params.bookmakers=bookmakerNames.slice(0,30).join(',');
    const data=await oddsGet('/odds/multi',oddsKey,params);
    requests++; requestBreakdown.oddsApiIo++;
    if(data?.__error){diagnostics.push({provider:'odds-api.io-odds',eventBatch:ids.length,error:data.__error});continue;}
    ingestOddsPayload(data,oddsMap);
  }
  diagnostics.push({provider:'odds-api.io-odds',eventsChecked:events.length,batches:batches.length,eventsReturned:oddsMap.size,markets:'ML + Totals + BTTS when supplied by selected bookmakers',rule:'quote richieste solo per gli eventi già filtrati nella finestra 0-3 ore'});

  // 4) Football-Data.org: one competition request per used competition.
  const codes=[...new Set(events.map(e=>e.fdCode).filter(Boolean))];
  const fdResults=await mapLimit(codes.slice(0,10),4,async code=>{
    const data=await footballDataGet(`/competitions/${encodeURIComponent(code)}/matches?dateTo=${encodeURIComponent(date)}`,fdToken);
    requests++; requestBreakdown.footballData++;
    return {code,data};
  });
  if(codes.length>10)diagnostics.push({provider:'football-data.org',warning:`${codes.length-10} competizioni oltre il limite operativo di 10 richieste per analisi.`});
  const leagueData=new Map();
  for(const x of fdResults){
    const parsed=parseFootballDataMatches(x.data,date); leagueData.set(x.code,parsed);
    diagnostics.push({provider:'football-data.org',competition:x.code,matches:Array.isArray(x.data?.matches)?x.data.matches.length:0,finished:parsed.matches.length,teams:parsed.standings.size,error:x.data?.__error||null});
  }

  const scenarios=[]; const quoted=[]; const unmatched=[];
  for(const e of events){
    const data=leagueData.get(e.fdCode);
    if(!data){unmatched.push({fixture:eventLabel(e),reason:`Football-Data.org non disponibile per ${e.fdCode||'questa competizione'}`});continue;}
    const hs=findStanding(data.standings,e.home), as=findStanding(data.standings,e.away);
    const recent={home:recentForTeam(data.matches,e.home,e.date),away:recentForTeam(data.matches,e.away,e.date)};
    const fdMatch=findFootballDataMatch(data.matches,e);
    if(!hs||!as||recent.home.length<3||recent.away.length<3||!fdMatch){unmatched.push({fixture:eventLabel(e),reason:'Dati insufficienti: servono classifica e ultime 3 per entrambe le squadre.'});continue;}
    const odds=extractOdds(oddsMap.get(String(e.id)),e,market).filter(o=>o.odd>1&&o.odd<=MAX_ODDS&&ALLOWED_MARKETS.has(o.value));
    if(!odds.length){unmatched.push({fixture:eventLabel(e),reason:'Nessuna quota compatibile ≤ 3,70 nei mercati richiesti.'});continue;}
    quoted.push(e);
    const probs=estimateProbabilities(hs,as,recent.home,recent.away,e.home,e.away);
    for(const o of odds){const p=probs[o.value];if(Number.isFinite(p)&&p>0)scenarios.push(makeScenario(e,o,p,hs,as,recent,fdMatch));}
  }

  const bestByMatch=new Map();
  for(const s of scenarios){const k=normalizePair(s.home,s.away);const old=bestByMatch.get(k);if(!old||s.prob>old.prob)bestByMatch.set(k,s);}
  const candidates=[...bestByMatch.values()].sort((a,b)=>b.prob-a.prob);
  const finalPicks=candidates.slice(0,TARGET_PICKS);
  diagnostics.push({provider:'v173-model',scenarios:scenarios.length,quotedFixtures:quoted.length,candidates:candidates.length,returned:finalPicks.length,maxOdds:MAX_ODDS,rule:'un solo scenario per partita; TOP 3 solo per probabilità; la quota non entra nel calcolo'});
  diagnostics.push({provider:'oddsapiio-footballdata-matching',matched:quoted.length,unmatchedCount:unmatched.length,unmatched:unmatched.slice(0,30)});
  if(!finalPicks.length)diagnostics.push({provider:'no-candidates-debug',reason:'Nessuna partita ha contemporaneamente quote compatibili e dati Football-Data.org sufficienti.',events:events.length});

  await logModelPredictions(supaUrl,serviceKey,date,finalPicks);
  const data={date,fixtures:events.length,analyzed:quoted.length,quotedFixtures:quoted.length,candidates:candidates.slice(0,120),liveFixtures:[],diagnostics,requests,requestBreakdown,lookaheadHours:LOOKAHEAD_HOURS,disclaimer:`Odds-API.io = eventi + quote. Football-Data.org = classifica + ultime 3. Finestra analisi: prossime ${LOOKAHEAD_HOURS} ore. Quota massima ${MAX_ODDS.toFixed(2)}. La quota non entra nella probabilità.`,cached:false};
  return finish(res,data,cacheKey);
}

async function finish(res,data,key){RESPONSE_CACHE.set(key,{expires:Date.now()+120000,data});res.setHeader('Cache-Control','no-store');return res.status(200).json(data);}

function selectLeagues(leagues,requestedCodes){
  const arr=(Array.isArray(leagues)?leagues:[]).map(l=>({...l,fdCode:SOCCER_TO_FD[normalizeLeagueSlug(l?.slug||'') ]||SOCCER_TO_FD[leagueSlugAlias(l?.slug,l?.name)]||null})).filter(l=>l.fdCode);
  if(requestedCodes?.length)return arr.filter(l=>requestedCodes.includes(l.fdCode));
  return arr;
}
function leagueSlugAlias(slug,name){
  const n=normalize(String(name||''));
  const s=normalizeLeagueSlug(slug||'');
  const aliases={
    'belgium-jupiler-pro-league':'belgium-first-division-a','belgium-first-division-a':'belgium-first-division-a',
    'scotland-premiership':'scotland-premiership','austria-bundesliga':'austria-bundesliga','switzerland-super-league':'switzerland-super-league',
    'turkey-super-lig':'turkey-super-lig','greece-super-league':'greece-super-league','denmark-superliga':'denmark-superliga',
    'sweden-allsvenskan':'sweden-allsvenskan','norway-eliteserien':'norway-eliteserien','poland-ekstraklasa':'poland-ekstraklasa',
    'czech-first-league':'czech-republic-first-league','croatia-hnl':'croatia-hnl','serbia-superliga':'serbia-superliga',
    'romania-liga-1':'romania-liga-1','ukraine-premier-league':'ukraine-premier-league','hungary-nb-i':'hungary-nb-i','slovakia-super-liga':'slovakia-super-liga',
    'italy-serie-a':'italy-serie-a','italy-serie-b':'italy-serie-b','england-premier-league':'england-premier-league','spain-la-liga':'spain-la-liga',
    'germany-bundesliga':'germany-bundesliga','france-ligue-1':'france-ligue-1','portugal-primeira-liga':'portugal-primeira-liga','netherlands-eredivisie':'netherlands-eredivisie',
    'uefa-champions-league':'uefa-champions-league','uefa-europa-league':'uefa-europa-league','uefa-europa-conference-league':'uefa-europa-conference-league'
  };
  if(aliases[s])return aliases[s];
  if(n.includes('serie a')&&n.includes('ital'))return 'italy-serie-a';
  if(n.includes('serie b')&&n.includes('ital'))return 'italy-serie-b';
  if(n.includes('premier league')&&n.includes('eng'))return 'england-premier-league';
  if(n.includes('la liga'))return 'spain-la-liga';
  if(n.includes('bundesliga')&&n.includes('germ'))return 'germany-bundesliga';
  if(n.includes('ligue 1'))return 'france-ligue-1';
  return null;
}
function normalizeLeagueSlug(s){return normalize(s).replace(/\s+/g,'-');}
function normalizeOddsEvent(e,league){return {id:e.id,home:e.home||'',away:e.away||'',date:e.date,sportTitle:e?.sport?.name||'Football',league:e?.league?.name||league?.name||'',leagueSlug:e?.league?.slug||league?.slug||'',fdCode:league.fdCode,status:e.status};}
function dedupeEvents(arr){const m=new Map();for(const e of arr){const k=String(e.id||`${e.home}|${e.away}|${e.date}`);if(!m.has(k))m.set(k,e);}return [...m.values()];}
function eventLabel(e){return `${e.home} - ${e.away}`;}

function ingestOddsPayload(payload,map){
  if(Array.isArray(payload)){for(const x of payload){if(x?.id!=null)map.set(String(x.id),x);}return;}
  if(payload&&typeof payload==='object'){
    if(payload.id!=null)map.set(String(payload.id),payload);
    for(const key of ['events','odds','data','results'])if(Array.isArray(payload[key]))for(const x of payload[key])if(x?.id!=null)map.set(String(x.id),x);
  }
}
function extractOdds(data,e,requestedMarket){
  const out=[]; if(!data)return out;
  const add=(value,odd,bookmaker,marketKey,href)=>{const n=Number(odd);if(Number.isFinite(n))out.push({value,odd:n,bookmaker,marketKey,href:nullish(href)?null:href});};
  const books=data?.bookmakers&&typeof data.bookmakers==='object'?data.bookmakers:{};
  for(const [bookmaker,markets] of Object.entries(books)){
    for(const m of Array.isArray(markets)?markets:[]){
      const key=normalizeMarketName(m?.name||m?.label||'');
      for(const o of Array.isArray(m?.odds)?m.odds:[]){
        if(key==='ml'){
          if(o.home!=null)add('1',o.home,bookmaker,'ML',o.href);
          if(o.draw!=null)add('X',o.draw,bookmaker,'ML',o.href);
          if(o.away!=null)add('2',o.away,bookmaker,'ML',o.href);
        }
        if(key==='totals'||key==='alternate totals'||key==='total goals'){
          const p=Number(o.hdp??o.point); if(![1.5,2.5,3.5].includes(p))continue;
          if(o.over!=null)add(`Over ${p}`,o.over,bookmaker,'Totals',o.href);
          if(o.under!=null)add(`Under ${p}`,o.under,bookmaker,'Totals',o.href);
        }
        if(key==='btts'||key==='both teams to score'||key==='goal no goal'||key==='goal/nogoal'||key==='ggng'){
          const yes=o.yes??o.goal??o.btts_yes??o.home;
          const no=o.no??o.no_goal??o.btts_no??o.away;
          if(yes!=null&&no!=null&&String(m?.label||'').toLowerCase().includes('goal')){add('Goal',yes,bookmaker,'BTTS',o.href);add('No Goal',no,bookmaker,'BTTS',o.href);}
          else if(o.yes!=null)add('Goal',o.yes,bookmaker,'BTTS',o.href);
          else if(o.no!=null)add('No Goal',o.no,bookmaker,'BTTS',o.href);
        }
      }
    }
  }
  const filtered=requestedMarket==='1x2'?out.filter(x=>['1','X','2'].includes(x.value)):requestedMarket==='totals'?out.filter(x=>x.value.startsWith('Over')||x.value.startsWith('Under')):requestedMarket==='btts'?out.filter(x=>['Goal','No Goal'].includes(x.value)):out;
  const best=new Map();for(const x of filtered){const old=best.get(x.value);if(!old||x.odd>old.odd)best.set(x.value,x);}return [...best.values()];
}
function normalizeMarketName(s){const n=normalize(s);if(n==='ml'||n.includes('moneyline')||n.includes('match result'))return 'ml';if(n==='totals'||n.includes('total goals'))return 'totals';if(n.includes('alternate totals'))return 'alternate totals';if(n==='btts'||n.includes('both teams to score')||n.includes('goal no goal')||n.includes('gg ng'))return 'btts';return n;}
function nullish(x){return x==null||x==='';}

function parseFootballDataMatches(payload,date){
  const finished=[];for(const m of Array.isArray(payload?.matches)?payload.matches:[]){if(String(m?.status||'').toUpperCase()!=='FINISHED')continue;const hg=Number(m?.score?.fullTime?.home),ag=Number(m?.score?.fullTime?.away),ts=Date.parse(m?.utcDate||'');if(!Number.isFinite(hg)||!Number.isFinite(ag)||!Number.isFinite(ts))continue;finished.push({id:m.id,date:new Date(ts).toISOString(),home:m?.homeTeam?.name||'',away:m?.awayTeam?.name||'',homeId:m?.homeTeam?.id,awayId:m?.awayTeam?.id,score:{home:hg,away:ag},leagueCode:m?.competition?.code||null});}
  finished.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));const teams=new Map();
  for(const m of finished){for(const side of ['home','away']){const name=m[side],k=teamKey(name);if(!name)continue;if(!teams.has(k))teams.set(k,{teamName:name,teamId:m[`${side}Id`],points:0,playedGames:0,gf:0,ga:0,gd:0,wins:0,draws:0,losses:0});const t=teams.get(k),gf=side==='home'?m.score.home:m.score.away,ga=side==='home'?m.score.away:m.score.home;t.playedGames++;t.gf+=gf;t.ga+=ga;t.gd=t.gf-t.ga;if(gf>ga){t.points+=3;t.wins++;}else if(gf===ga){t.points++;t.draws++;}else t.losses++;}}
  const ranked=[...teams.values()].sort((a,b)=>b.points-a.points||b.gd-a.gd||b.gf-a.gf||a.teamName.localeCompare(b.teamName));const standings=new Map();ranked.forEach((t,i)=>standings.set(teamKey(t.teamName),{...t,position:i+1,totalTeams:ranked.length}));return {matches:finished,standings};
}
function findStanding(t,n){return t.get(teamKey(n))||findStandingLoose(t,n);}
function findStandingLoose(t,n){let best=null,score=0;for(const v of t.values()){const s=teamSimilarity(n,v.teamName);if(s>score){score=s;best=v;}}return score>=.78?best:null;}
function recentForTeam(matches,name,kickoff){const cut=Date.parse(kickoff),out=[];for(let i=matches.length-1;i>=0&&out.length<3;i--){const m=matches[i],mt=Date.parse(m.date);if(!Number.isFinite(mt)||mt>=cut)continue;if(teamSimilarity(m.home,name)>=.78||teamSimilarity(m.away,name)>=.78)out.push(m);}return out.reverse();}
function findFootballDataMatch(matches,e){let best=null,score=0;for(const m of matches){const d=Math.abs(Date.parse(m.date)-Date.parse(e.date));if(d>36*3600000)continue;const s=teamSimilarity(e.home,m.home)+teamSimilarity(e.away,m.away);if(s>score){score=s;best=m;}}return score>=1.5?best:null;}

async function footballDataGet(path,token){try{const r=await fetch(`${FD_BASE}${path}`,{headers:{Accept:'application/json','X-Auth-Token':token},cache:'no-store'});const text=await r.text();if(!r.ok)return {__error:`Football-Data.org HTTP ${r.status}: ${text.slice(0,300)}`};return text?JSON.parse(text):{};}catch(e){return {__error:e?.message||String(e)};}}
async function getBookmakersCached(key){
  if(BOOKMAKER_CACHE.expires>Date.now() && BOOKMAKER_CACHE.names.length) return {names:BOOKMAKER_CACHE.names,fetched:false};
  try{
    const r=await fetch(`${ODDS_BASE}/bookmakers?${new URLSearchParams({apiKey:key})}`,{headers:{Accept:'application/json'},cache:'no-store'});
    const text=await r.text();
    if(!r.ok)return {names:[],fetched:true,error:`Odds-API.io bookmakers HTTP ${r.status}: ${text.slice(0,300)}`};
    const payload=text?JSON.parse(text):[];
    const rows=Array.isArray(payload)?payload:(Array.isArray(payload?.bookmakers)?payload.bookmakers:Array.isArray(payload?.data)?payload.data:[]);
    const names=rows.filter(x=>x&&x.active!==false).map(x=>x.name||x.slug).filter(Boolean).map(String).slice(0,30);
    if(!names.length)return {names:[],fetched:true,error:'Odds-API.io /bookmakers non ha restituito bookmaker attivi accessibili con questa chiave.'};
    BOOKMAKER_CACHE.names=names; BOOKMAKER_CACHE.expires=Date.now()+60*60*1000;
    return {names,fetched:true};
  }catch(e){return {names:[],fetched:true,error:e?.message||String(e)};}
}

async function oddsGet(path,key,params={}){try{const qs=new URLSearchParams({apiKey:key,...params});const r=await fetch(`${ODDS_BASE}${path}?${qs.toString()}`,{headers:{Accept:'application/json'},cache:'no-store'});const text=await r.text();if(!r.ok)return {__error:`Odds-API.io HTTP ${r.status}: ${text.slice(0,300)}`};return text?JSON.parse(text):{};}catch(e){return {__error:e?.message||String(e)};}}

function makeScenario(e,o,p,hs,as,recent,fdMatch){return {home:e.home,away:e.away,market:marketLabel(o.value),odds:o.odd,bookmaker:o.bookmaker,betUrl:o.href||null,prob:round(p),pStat:round(p),pMarket:null,pFair:round(p),edge:null,score:round(p),topSelectionScore:round(p),confidence:round(p),analysisSupport:analysisSupport(hs,as,recent.home,recent.away),modelReady:true,topEligible:true,modelSample:3,probabilitySource:'Classifica + ultime 3 partite',modelVersion:'V174-3H-ODDS-APIO-FOOTBALL-DATA',homeStanding:hs,awayStanding:as,standingNote:standingNote(e.home,hs,e.away,as),recentForm:{home:recent.home,away:recent.away,homeMatches:3,awayMatches:3},reason:buildReason(p,e.home,e.away,hs,as,recent.home,recent.away),oddsSource:'Odds-API.io',statsSource:'Football-Data.org',fixtureId:`football-data-${fdMatch.id}`,eventId:fdMatch.id,oddsApiEventId:e.id,kickoff:e.date,league:e.league,leagueCode:e.fdCode,priorityLeague:false,homeLogo:null,awayLogo:null,riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value',oddsAgeMin:null,fieldAnalysis:{reason:buildReason(p,e.home,e.away,hs,as,recent.home,recent.away),confidence:round(p),confidenceLabel:p>=70?'Alta':p>=55?'Media':'Bassa',warnings:[]}};}

function estimateProbabilities(hs,as,hm,am,homeName,awayName){const hS=standingStrength(hs),aS=standingStrength(as),fH=pointsFromTeamRows(hm,homeName),fA=pointsFromTeamRows(am,awayName),fDiff=(fH/9)-(fA/9),sDiff=hS-aS;let home=.5+sDiff*.23+fDiff*.07+.045,draw=.27-Math.abs(sDiff)*.06-Math.abs(fDiff)*.03,away=1-home-draw;home=clamp(home,.12,.78);away=clamp(away,.10,.72);draw=clamp(draw,.16,.34);const sum=home+draw+away;home/=sum;draw/=sum;away/=sum;const totals=goalMarketProbabilities(hm,am,sDiff,fDiff);return {'1':home*100,'X':draw*100,'2':away*100,...totals};}
function goalMarketProbabilities(hm,am,sDiff,fDiff){const rows=[...hm,...am],freq=fn=>rows.length?rows.filter(fn).length/rows.length:.5,over=line=>freq(m=>(m.score.home+m.score.away)>line),formBoost=clamp(fDiff*.05+sDiff*.03,-.08,.08),adj=p=>clamp(p+formBoost,.10,.90),p15=adj(over(1.5)),p25=adj(over(2.5)),p35=adj(over(3.5)),btts=adj(freq(m=>m.score.home>0&&m.score.away>0));return {'Over 1.5':p15*100,'Under 1.5':(1-p15)*100,'Over 2.5':p25*100,'Under 2.5':(1-p25)*100,'Over 3.5':p35*100,'Under 3.5':(1-p35)*100,'Goal':btts*100,'No Goal':(1-btts)*100};}
function analysisSupport(hs,as,hm,am){let s=45;if(hs&&as)s+=30;if(hm.length>=3&&am.length>=3)s+=25;return clamp(s,0,100);}
function buildReason(prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);bits.push(`${home}: ${pointsFromTeamRows(hm,home)} punti nelle ultime 3`);bits.push(`${away}: ${pointsFromTeamRows(am,away)} punti nelle ultime 3`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join('. ')+'.';}
function pointsFromTeamRows(rows,name){let p=0;for(const m of rows){const isHome=teamSimilarity(m.home,name)>=.72,gf=isHome?m.score.home:m.score.away,ga=isHome?m.score.away:m.score.home;p+=gf>ga?3:gf===ga?1:0;}return p;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position)x.push(`${home} è ${hs.position}ª`);if(as?.position)x.push(`${away} è ${as.position}º`);return x.join('; ');}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}

async function supaWrite(url,key,path,rows){if(!url||!key)return;const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});if(!r.ok)throw new Error(`Supabase write ${r.status}: ${(await r.text()).slice(0,300)}`);}
async function logModelPredictions(url,key,date,picks){if(!picks.length||!url||!key)return;const rows=picks.map(p=>({match_date:date,league_code:p.leagueCode||null,league:p.league||null,home:p.home,away:p.away,event_id:p.eventId?String(p.eventId):null,fixture_id:p.fixtureId||null,market:p.market,odds:p.odds,odds_cap_used:MAX_ODDS,prob_model:p.pStat,prob_market:null,prob_blended:null,edge_percent:null,model_sample:p.modelSample,kickoff:p.kickoff,settled:false,result:null}));try{await supaWrite(url,key,'model_predictions?on_conflict=match_date,home,away,market',rows);}catch(e){console.error(e.message);}}

function normalizeLeague(x){return String(x||'').trim().toUpperCase();}
function marketLabel(v){return ({'1':'1 (Casa)','X':'X (Pareggio)','2':'2 (Trasferta)'}[v])||v;}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();}
function teamKey(s){let n=normalize(s);const aliases={inter:'internazionale','inter milan':'internazionale','internazionale milano':'internazionale','ac milan':'milan','hellas verona':'verona','as roma':'roma','ss lazio':'lazio','ssc napoli':'napoli','juventus fc':'juventus'};n=aliases[n]||n;return n.replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the|ss|as|ssc|cfc|bk|sv)\b/g,' ').replace(/\s+/g,' ').trim();}
function clean(s){return teamKey(s).replace(/\b\d{2,4}\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function levenshtein(a,b){const m=a.length,n=b.length,d=Array.from({length:m+1},(_,i)=>{const r=new Array(n+1);r[0]=i;return r;});for(let j=1;j<=n;j++)d[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[m][n];}
function teamSimilarity(a,b){const A=clean(a),B=clean(b);if(!A||!B)return 0;if(A===B)return 1;if(A.includes(B)||B.includes(A))return .9;const d=levenshtein(A,B),mx=Math.max(A.length,B.length);return mx?1-d/mx:0;}
function localDate(iso){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
function timeWindowAllows(iso,w){const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));const m=Number(p.find(x=>x.type==='hour')?.value)*60+Number(p.find(x=>x.type==='minute')?.value);if(w==='afternoon1')return m>=780&&m<=960;if(w==='afternoon2')return m>=961&&m<=1140;if(w==='evening')return m>=1141&&m<=1320;return true;}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}
function chunk(arr,size){const out=[];for(let i=0;i<arr.length;i+=size)out.push(arr.slice(i,i+size));return out;}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
