const RESPONSE_CACHE = new Map();

// V172 RESET: The Odds API = calendario + quote. Football-Data.org = dati squadre.
const MAX_ODDS = 3.70;
const TARGET_PICKS = 3;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const FD_BASE = 'https://api.football-data.org/v4';
const SOCCER_TO_FD = {
  soccer_italy_serie_a:'SA', soccer_italy_serie_b:'SB', soccer_epl:'PL',
  soccer_spain_la_liga:'PD', soccer_germany_bundesliga:'BL1', soccer_france_ligue_one:'FL1',
  soccer_netherlands_eredivisie:'DED', soccer_portugal_primeira_liga:'PPL',
  soccer_belgium_first_division_a:'BJL', soccer_austria_bundesliga:'ABL',
  soccer_denmark_superliga:'DSU', soccer_sweden_allsvenskan:'ALL',
  soccer_switzerland_superleague:'SSL', soccer_turkey_super_league:'TSL',
  soccer_ukraine_premier_league:'UPL', soccer_norway_eliteserien:'TIP',
  soccer_greece_super_league:'GSL', soccer_poland_ekstraklasa:'POL',
  soccer_czech_republic_first_league:'CZE', soccer_croatia_hnl:'CRO',
  soccer_serbia_superliga:'SRB', soccer_hungary_nb_i:'HUN', soccer_slovakia_super_liga:'SVK',
  soccer_brazil_serie_a:'BSA', soccer_mls:'MLS', soccer_japan_j_league:'J1'
};
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
  const cacheKey=`v172-odds-footballdata|${date}|${requestedCodes?.join(',')||'ALL'}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now())return res.status(200).json({...cached.data,cached:true});

  const diagnostics=[]; let requests=0; const requestBreakdown={oddsApi:0,footballData:0};
  if(!oddsKey){diagnostics.push({provider:'odds-api',error:'ODDS_API_KEY non configurata'});return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown,disclaimer:'Configura ODDS_API_KEY e FOOTBALL_DATA_TOKEN in Vercel.'},cacheKey);}
  if(!fdToken){diagnostics.push({provider:'football-data',error:'FOOTBALL_DATA_TOKEN non configurata'});return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown,disclaimer:'Configura ODDS_API_KEY e FOOTBALL_DATA_TOKEN in Vercel.'},cacheKey);}

  const sports=await oddsGet('/sports',oddsKey); requests++; requestBreakdown.oddsApi++;
  if(sports?.__error) return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics:[{provider:'odds-api',error:sports.__error}],requests,requestBreakdown},cacheKey);
  const selectedSports=selectSports(sports,requestedCodes);
  diagnostics.push({provider:'odds-api',sportsFound:Array.isArray(sports)?sports.length:0,sportsSelected:selectedSports.map(s=>({key:s.key,title:s.title,fdCode:SOCCER_TO_FD[s.key]||null})),role:'unica fonte di calendario e quote'});
  if(!selectedSports.length){return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics:[...diagnostics,{provider:'no-candidates-debug',reason:'Nessun campionato calcio attivo compatibile con i filtri.'}],requests,requestBreakdown},cacheKey);}

  const rawEvents=[];
  for(const sport of selectedSports){
    const path=`/sports/${encodeURIComponent(sport.key)}/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`;
    const data=await oddsGet(path,oddsKey); requests++; requestBreakdown.oddsApi++;
    if(data?.__error){diagnostics.push({provider:'odds-api',sport:sport.key,error:data.__error});continue;}
    const arr=Array.isArray(data)?data:[];
    for(const e of arr){
      const kickoff=e?.commence_time; if(!kickoff)continue;
      if(localDate(kickoff)!==date||new Date(kickoff).getTime()<=Date.now())continue;
      if(!timeWindowAllows(kickoff,timeWindow))continue;
      const fdCode=SOCCER_TO_FD[sport.key]||null;
      if(requestedCodes?.length&&!requestedCodes.includes(fdCode))continue;
      rawEvents.push({...e,fdCode,sportTitle:sport.title});
    }
  }

  const events=dedupeEvents(rawEvents);
  diagnostics.push({provider:'odds-api-events',fixtures:events.length,rule:'solo eventi futuri della data richiesta; quote europee; nessun bridge'});
  if(!events.length)return finish(res,{date,fixtures:0,analyzed:0,quotedFixtures:0,candidates:[],liveFixtures:[],diagnostics,requests,requestBreakdown},cacheKey);

  // BTTS + linee 1.5/2.5/3.5: l'endpoint evento serve i mercati aggiuntivi.
  const enriched=[];
  await mapLimit(events,4,async e=>{
    const extra=await oddsGet(`/sports/${encodeURIComponent(e.sport_key)}/events/${encodeURIComponent(e.id)}/odds?regions=eu&markets=alternate_totals,btts&oddsFormat=decimal`,oddsKey);
    requests++; requestBreakdown.oddsApi++;
    e.extraOdds=extra?.__error?null:extra;
    enriched.push(e);
  });
  diagnostics.push({provider:'odds-api-markets',eventsChecked:events.length,marketRequest:'alternate_totals,btts',errorCount:enriched.filter(x=>!x.extraOdds).length});

  // Una richiesta per competizione: match della stagione fino alla data. Classifica e ultime 3 vengono calcolate localmente.
  const codes=[...new Set(events.map(e=>e.fdCode).filter(Boolean))];
  const fdResults=await mapLimit(codes.slice(0,10),4,async code=>{
    const data=await footballDataGet(`/competitions/${encodeURIComponent(code)}/matches?dateTo=${encodeURIComponent(date)}`,fdToken);
    requests++; requestBreakdown.footballData++;
    return {code,data};
  });
  if(codes.length>10)diagnostics.push({provider:'football-data',warning:`${codes.length-10} competizioni oltre il limite operativo di 10 richieste/minuto.`});
  const leagueData=new Map();
  for(const x of fdResults){const parsed=parseFootballDataMatches(x.data,date);leagueData.set(x.code,parsed);diagnostics.push({provider:'football-data',competition:x.code,matches:Array.isArray(x.data?.matches)?x.data.matches.length:0,finished:parsed.matches.length,teams:parsed.standings.size,error:x.data?.__error||null});}

  const scenarios=[]; const quoted=[]; const unmatched=[];
  for(const e of enriched){
    const data=leagueData.get(e.fdCode); if(!data){unmatched.push({fixture:eventLabel(e),reason:`Football-Data.org non disponibile per ${e.fdCode||'questa competizione'}`});continue;}
    const hs=findStanding(data.standings,e.home_team), as=findStanding(data.standings,e.away_team);
    const recent={home:recentForTeam(data.matches,e.home_team,e.commence_time),away:recentForTeam(data.matches,e.away_team,e.commence_time)};
    const fdMatch=findFootballDataMatch(data.matches,e);
    if(!hs||!as||recent.home.length<3||recent.away.length<3||!fdMatch){unmatched.push({fixture:eventLabel(e),reason:'Dati insufficienti: servono classifica e ultime 3 per entrambe le squadre.'});continue;}
    const odds=extractOdds(e,market).filter(o=>o.odd>1&&o.odd<=MAX_ODDS&&ALLOWED_MARKETS.has(o.value));
    if(!odds.length){unmatched.push({fixture:eventLabel(e),reason:'Nessuna quota compatibile ≤ 3,70 nei mercati richiesti.'});continue;}
    quoted.push(e);
    const probs=estimateProbabilities(hs,as,recent.home,recent.away,e.home_team,e.away_team);
    for(const o of odds){const p=probs[o.value];if(Number.isFinite(p)&&p>0)scenarios.push(makeScenario(e,o,p,hs,as,recent,fdMatch));}
  }

  const bestByMatch=new Map();
  for(const s of scenarios){const k=normalizePair(s.home,s.away);const old=bestByMatch.get(k);if(!old||s.prob>old.prob)bestByMatch.set(k,s);}
  const candidates=[...bestByMatch.values()].sort((a,b)=>b.prob-a.prob);
  const finalPicks=candidates.slice(0,TARGET_PICKS);
  diagnostics.push({provider:'v172-model',scenarios:scenarios.length,quotedFixtures:quoted.length,candidates:candidates.length,returned:finalPicks.length,maxOdds:MAX_ODDS,rule:'un solo scenario per partita; TOP 3 solo per probabilità; la quota non entra nel calcolo'});
  diagnostics.push({provider:'odds-footballdata-matching',matched:quoted.length,unmatchedCount:unmatched.length,unmatched:unmatched.slice(0,30)});
  if(!finalPicks.length)diagnostics.push({provider:'no-candidates-debug',reason:'Nessuna partita ha contemporaneamente quote compatibili e dati Football-Data.org sufficienti.',events:events.length});

  await logModelPredictions(supaUrl,serviceKey,date,finalPicks);
  const data={date,fixtures:events.length,analyzed:quoted.length,quotedFixtures:quoted.length,candidates:candidates.slice(0,120),liveFixtures:[],diagnostics,requests,requestBreakdown,disclaimer:`The Odds API = eventi + quote. Football-Data.org = classifica + ultime 3. Quota massima ${MAX_ODDS.toFixed(2)}. La quota non entra nella probabilità.`,cached:false};
  return finish(res,data,cacheKey);
}

async function finish(res,data,key){RESPONSE_CACHE.set(key,{expires:Date.now()+120000,data});res.setHeader('Cache-Control','no-store');return res.status(200).json(data);}

function selectSports(sports,requestedCodes){
  const arr=(Array.isArray(sports)?sports:[]).filter(s=>String(s?.key||'').startsWith('soccer_')&&!s.outcome);
  const mapped=arr.filter(s=>SOCCER_TO_FD[s.key]);
  return (requestedCodes?.length?mapped.filter(s=>requestedCodes.includes(SOCCER_TO_FD[s.key])):mapped);
}
function dedupeEvents(arr){const m=new Map();for(const e of arr){const k=String(e.id||`${e.home_team}|${e.away_team}|${e.commence_time}`);if(!m.has(k))m.set(k,e);}return [...m.values()];}
function eventLabel(e){return `${e.home_team} - ${e.away_team}`;}

function extractOdds(e,requestedMarket){
  const out=[];
  const add=(value,odd,bookmaker,marketKey)=>{const n=Number(odd);if(!Number.isFinite(n))return;out.push({value,odd:n,bookmaker,marketKey});};
  const books=[...(Array.isArray(e.bookmakers)?e.bookmakers:[])];
  const extraBooks=[...(Array.isArray(e.extraOdds?.bookmakers)?e.extraOdds.bookmakers:[])];
  const all=[...books,...extraBooks];
  for(const b of all){for(const m of (b.markets||[])){
    const mk=m.key;
    if(mk==='h2h') for(const o of m.outcomes||[]){const name=String(o.name||'');const v=name.toLowerCase()==='draw'?'X':teamSimilarity(name,e.home_team)>=.72?'1':teamSimilarity(name,e.away_team)>=.72?'2':null;if(v)add(v,o.price,b.title,mk);}
    if(mk==='totals'||mk==='alternate_totals') for(const o of m.outcomes||[]){const p=Number(o.point);if(![1.5,2.5,3.5].includes(p))continue;const n=String(o.name||'').toLowerCase();const v=n==='over'?`Over ${p}`:n==='under'?`Under ${p}`:null;if(v)add(v,o.price,b.title,mk);}
    if(mk==='btts') for(const o of m.outcomes||[]){const n=String(o.name||'').toLowerCase();if(n==='yes')add('Goal',o.price,b.title,mk);if(n==='no')add('No Goal',o.price,b.title,mk);}
  }}
  const filtered=requestedMarket==='1x2'?out.filter(x=>['1','X','2'].includes(x.value)):requestedMarket==='totals'?out.filter(x=>x.value.startsWith('Over')||x.value.startsWith('Under')):requestedMarket==='btts'?out.filter(x=>['Goal','No Goal'].includes(x.value)):out;
  const best=new Map();for(const x of filtered){const old=best.get(x.value);if(!old||x.odd>old.odd)best.set(x.value,x);}return [...best.values()];
}

function parseFootballDataMatches(payload,date){
  const finished=[];for(const m of Array.isArray(payload?.matches)?payload.matches:[]){if(String(m?.status||'').toUpperCase()!=='FINISHED')continue;const hg=Number(m?.score?.fullTime?.home),ag=Number(m?.score?.fullTime?.away),ts=Date.parse(m?.utcDate||'');if(!Number.isFinite(hg)||!Number.isFinite(ag)||!Number.isFinite(ts))continue;finished.push({id:m.id,date:new Date(ts).toISOString(),home:m?.homeTeam?.name||'',away:m?.awayTeam?.name||'',homeId:m?.homeTeam?.id,awayId:m?.awayTeam?.id,score:{home:hg,away:ag},leagueCode:m?.competition?.code||null});}
  finished.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));const teams=new Map();
  for(const m of finished){for(const side of ['home','away']){const name=m[side],k=teamKey(name);if(!name)continue;if(!teams.has(k))teams.set(k,{teamName:name,teamId:m[`${side}Id`],points:0,playedGames:0,gf:0,ga:0,gd:0,wins:0,draws:0,losses:0});const t=teams.get(k),gf=side==='home'?m.score.home:m.score.away,ga=side==='home'?m.score.away:m.score.home;t.playedGames++;t.gf+=gf;t.ga+=ga;t.gd=t.gf-t.ga;if(gf>ga){t.points+=3;t.wins++;}else if(gf===ga){t.points++;t.draws++;}else t.losses++;}}
  const ranked=[...teams.values()].sort((a,b)=>b.points-a.points||b.gd-a.gd||b.gf-a.gf||a.teamName.localeCompare(b.teamName));const standings=new Map();ranked.forEach((t,i)=>standings.set(teamKey(t.teamName),{...t,position:i+1,totalTeams:ranked.length}));return {matches:finished,standings};
}
function findStanding(t,n){return t.get(teamKey(n))||findStandingLoose(t,n);}
function findStandingLoose(t,n){let best=null,score=0;for(const v of t.values()){const s=teamSimilarity(n,v.teamName);if(s>score){score=s;best=v;}}return score>=.78?best:null;}
function recentForTeam(matches,name,kickoff){const cut=Date.parse(kickoff),out=[];for(let i=matches.length-1;i>=0&&out.length<3;i--){const m=matches[i],mt=Date.parse(m.date);if(!Number.isFinite(mt)||mt>=cut)continue;if(teamSimilarity(m.home,name)>=.78||teamSimilarity(m.away,name)>=.78)out.push(m);}return out.reverse();}
function findFootballDataMatch(matches,e){let best=null,score=0;for(const m of matches){const d=Math.abs(Date.parse(m.date)-Date.parse(e.commence_time));if(d>36*3600000)continue;const s=teamSimilarity(e.home_team,m.home)+teamSimilarity(e.away_team,m.away);if(s>score){score=s;best=m;}}return score>=1.5?best:null;}

async function footballDataGet(path,token){try{const r=await fetch(`${FD_BASE}${path}`,{headers:{Accept:'application/json','X-Auth-Token':token},cache:'no-store'});const text=await r.text();if(!r.ok)return {__error:`Football-Data.org HTTP ${r.status}: ${text.slice(0,300)}`};return text?JSON.parse(text):{};}catch(e){return {__error:e?.message||String(e)};}}
async function oddsGet(path,key){try{const r=await fetch(`${ODDS_BASE}${path}${path.includes('?')?'&':'?'}apiKey=${encodeURIComponent(key)}`,{headers:{Accept:'application/json'},cache:'no-store'});const text=await r.text();if(!r.ok)return {__error:`The Odds API HTTP ${r.status}: ${text.slice(0,300)}`};return text?JSON.parse(text):{};}catch(e){return {__error:e?.message||String(e)};}}

function makeScenario(e,o,p,hs,as,recent,fdMatch){return {home:e.home_team,away:e.away_team,market:marketLabel(o.value),odds:o.odd,bookmaker:o.bookmaker,prob:round(p),pStat:round(p),pMarket:null,pFair:round(p),edge:null,score:round(p),topSelectionScore:round(p),confidence:round(p),analysisSupport:analysisSupport(hs,as,recent.home,recent.away),modelReady:true,topEligible:true,modelSample:3,probabilitySource:'Classifica + ultime 3 partite',modelVersion:'V172-ODDS-API-FOOTBALL-DATA',homeStanding:hs,awayStanding:as,standingNote:standingNote(e.home_team,hs,e.away_team,as),recentForm:{home:recent.home,away:recent.away,homeMatches:3,awayMatches:3},reason:buildReason(p,e.home_team,e.away_team,hs,as,recent.home,recent.away),oddsSource:'The Odds API',statsSource:'Football-Data.org',fixtureId:`football-data-${fdMatch.id}`,eventId:fdMatch.id,oddsApiEventId:e.id,kickoff:e.commence_time,league:e.sport_title,leagueCode:e.fdCode,priorityLeague:false,homeLogo:null,awayLogo:null,riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value',oddsAgeMin:null,fieldAnalysis:{reason:buildReason(p,e.home_team,e.away_team,hs,as,recent.home,recent.away),confidence:round(p),confidenceLabel:p>=70?'Alta':p>=55?'Media':'Bassa',warnings:[]}};}

function estimateProbabilities(hs,as,hm,am,homeName,awayName){const hS=standingStrength(hs),aS=standingStrength(as),fH=pointsFromTeamRows(hm,homeName),fA=pointsFromTeamRows(am,awayName),fDiff=(fH/9)-(fA/9),sDiff=hS-aS;let home=.5+sDiff*.23+fDiff*.07+.045,draw=.27-Math.abs(sDiff)*.06-Math.abs(fDiff)*.03,away=1-home-draw;home=clamp(home,.12,.78);away=clamp(away,.10,.72);draw=clamp(draw,.16,.34);const sum=home+draw+away;home/=sum;draw/=sum;away/=sum;const totals=goalMarketProbabilities(hm,am,sDiff,fDiff);return {'1':home*100,'X':draw*100,'2':away*100,...totals};}
function goalMarketProbabilities(hm,am,sDiff,fDiff){const rows=[...hm,...am],freq=fn=>rows.length?rows.filter(fn).length/rows.length:.5,over=line=>freq(m=>(m.score.home+m.score.away)>line),formBoost=clamp(fDiff*.05+sDiff*.03,-.08,.08),adj=p=>clamp(p+formBoost,.10,.90),p15=adj(over(1.5)),p25=adj(over(2.5)),p35=adj(over(3.5)),btts=adj(freq(m=>m.score.home>0&&m.score.away>0));return {'Over 1.5':p15*100,'Under 1.5':(1-p15)*100,'Over 2.5':p25*100,'Under 2.5':(1-p25)*100,'Over 3.5':p35*100,'Under 3.5':(1-p35)*100,'Goal':btts*100,'No Goal':(1-btts)*100};}
function analysisSupport(hs,as,hm,am){let s=45;if(hs&&as)s+=30;if(hm.length>=3&&am.length>=3)s+=25;return clamp(s,0,100);}
function buildReason(prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);bits.push(`${home}: ${pointsFromTeamRows(hm,home)} punti nelle ultime 3`);bits.push(`${away}: ${pointsFromTeamRows(am,away)} punti nelle ultime 3`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join('. ')+'.';}
function pointsFromTeamRows(rows,name){let p=0;for(const m of rows){const isHome=teamSimilarity(m.home,name)>=.72,gf=isHome?m.score.home:m.score.away,ga=isHome?m.score.away:m.score.home;p+=gf>ga?3:gf===ga?1:0;}return p;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position)x.push(`${home} è ${hs.position}ª`);if(as?.position)x.push(`${away} è ${as.position}º`);return x.join('; ');}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}

async function supaWrite(url,key,path,rows){if(!url||!key)return;const r=await fetch(`${url}/rest/v1/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});if(!r.ok)throw new Error(`Supabase write ${r.status}: ${(await r.text()).slice(0,300)}`);}
async function logModelPredictions(url,key,date,picks){if(!picks.length||!url||!key)return;const rows=picks.map(p=>({match_date:date,league_code:p.leagueCode||null,league:p.league||null,home:p.home,away:p.away,event_id:p.eventId?String(p.eventId):null,fixture_id:p.fixtureId||null,market:p.market,odds:p.odds,odds_cap_used:MAX_ODDS,prob_model:p.pStat,prob_market:null,prob_blended:null,edge_percent:null,model_sample:p.modelSample,kickoff:p.kickoff,settled:false,result:null}));try{await supaWrite(url,key,'model_predictions?on_conflict=match_date,home,away,market',rows);}catch(e){console.error(e.message);}}

function normalizeLeague(x){const s=String(x||'').trim().toUpperCase();return s;}
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
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
