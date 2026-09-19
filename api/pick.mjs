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
  MLS1:{slug:'usa.1',name:'MLS'}, JPN1:{slug:'jpn.1',name:'J League'}
};

const DEFAULT_CODES = ['SA','SB','PL','PD','BL1','FL1','PPL','DED','BEL1','SCO1','TUR1','CL'];

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

  const cacheKey=`v154-espn|${date}|${requestedCodes.join(',')}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now()) return res.status(200).json({...cached.data,cached:true});

  let requests=0;
  const requestBreakdown={espnScoreboards:0,espnStandings:0,betfairSnapshot:0};
  const diagnostics=[];

  // ESPN sostituisce API-Football come fonte dati primaria. Non richiede API key.
  // Una chiamata scoreboard per campionato copre oggi + storico recente; una chiamata
  // standings per campionato fornisce classifica. Nessuna chiamata per squadra.
  const codes=[...new Set(requestedCodes)].filter(c=>ESPN_LEAGUES[c]);
  const unknownCodes=requestedCodes.filter(c=>!ESPN_LEAGUES[c]);
  if(unknownCodes.length) diagnostics.push({provider:'espn-config',unsupported:unknownCodes,role:'campionati non mappati'});

  const daysBack=60, daysForward=7;
  const from=shiftDate(date,-daysBack), to=shiftDate(date,daysForward);
  const sourceResults=await mapLimit(codes,4,async code=>{
    const cfg=ESPN_LEAGUES[code];
    const [score,table]=await Promise.all([
      espn(`/apis/site/v2/sports/soccer/${cfg.slug}/scoreboard?dates=${from.replaceAll('-','')}-${to.replaceAll('-','')}`),
      espn(`/apis/v2/sports/soccer/${cfg.slug}/standings`)
    ]);
    requests+=2; requestBreakdown.espnScoreboards++; requestBreakdown.espnStandings++;
    const events=Array.isArray(score?.events)?score.events:[];
    const fixtures=events.map(e=>adaptEspnEvent(e,code,cfg)).filter(Boolean);
    const standings=parseEspnStandings(table,code);
    diagnostics.push({provider:'espn',league:cfg.name,code,slug:cfg.slug,fixtures:fixtures.length,standings:standings.size,scoreError:score?.__error||null,standingsError:table?.__error||null,role:'calendario + ultime 3 + classifica'});
    return {code,cfg,fixtures,standings};
  });

  const allFixtures=sourceResults.flatMap(x=>x.fixtures);
  const liveFixtures=allFixtures.filter(f=>isLiveStatus(f.status)).filter(f=>localDate(f.date)===date).map(f=>({
    id:`espn-live-${f.id}`,eventId:f.id,home:f.home,away:f.away,date:f.date,league:f.league,status:'live',score:f.score
  }));

  const fixtures=allFixtures
    .filter(f=>localDate(f.date)===date)
    .filter(f=>!isLiveStatus(f.status))
    .filter(f=>!isFinishedStatus(f.status))
    .filter(f=>new Date(f.date).getTime()>Date.now())
    .filter(f=>competitionAllowed(f,requestedCodes))
    .filter(f=>timeWindowAllows(f.date,timeWindow));
  diagnostics.push({provider:'prematch-gate',before:allFixtures.filter(f=>localDate(f.date)===date).length,remaining:fixtures.length,rule:'ESPN data + kickoff futuro; Betfair non decide se una gara è già iniziata'});

  const bf=await loadBetfairSnapshot(supaUrl,serviceKey);
  requests++; requestBreakdown.betfairSnapshot++;
  diagnostics.push({provider:'betfair-exchange',catalogueMarkets:bf.catalogueMarkets,bookMarkets:bf.bookMarkets,matchedFixtures:bf.fixtures.size,error:bf.error||null,role:'unica fonte delle quote'});

  const quoted=[];
  for(const f of fixtures){
    const markets=findBestBetfairFixture(f.home,f.away,bf.fixtures);
    const odds=extractBetfairOdds(markets,market,f.home,f.away).filter(o=>o.odd>1&&o.odd<=3.7);
    if(odds.length) quoted.push({f,markets,odds});
  }
  diagnostics.push({provider:'betfair-pool',prematch:fixtures.length,withQuote:quoted.length,rule:'partita valida solo se esiste almeno una BACK Betfair tra 1.01 e 3.70'});

  if(!quoted.length){
    diagnostics.push({provider:'no-candidates-debug',reason:fixtures.length?'Nessuna quota BACK Betfair <= 3.70 riconosciuta per le partite ESPN pre-match':'Nessuna partita ESPN pre-match nel perimetro selezionato',espnPrematch:fixtures.length,betfairFixtureKeys:bf.fixtures.size});
    const data={date,fixtures:fixtures.length,analyzed:0,requests,requestBreakdown,candidates:[],liveFixtures,diagnostics,cached:false};
    RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+30_000,data});
    return res.status(200).json(data);
  }

  const standingsByCode=new Map(sourceResults.map(x=>[x.code,x.standings]));
  const scenarios=[];
  for(const q of quoted){
    const f=q.f;
    const table=standingsByCode.get(f.leagueCode)||new Map();
    const hs=table.get(teamKey(f.home));
    const as=table.get(teamKey(f.away));
    const recent=recentThreeForTeams(sourceResults.find(x=>x.code===f.leagueCode)?.fixtures||[],f.home,f.away,date);
    const hm=recent.home, am=recent.away;
    const hf=hm.length?pointsFromMatches(hm,f.home)/3:Number.isFinite(hs?.form3Points)?hs.form3Points/9:.5;
    const af=am.length?pointsFromMatches(am,f.away)/3:Number.isFinite(as?.form3Points)?as.form3Points/9:.5;
    const homeStats={teamName:f.home,form:hf,sample:hm.length};
    const awayStats={teamName:f.away,form:af,sample:am.length};
    for(const o of q.odds){
      const prob=estimateProbability(o.value,homeStats,awayStats,hs,as,hm,am);
      if(!Number.isFinite(prob)) continue;
      const modelSample=Math.min(hm.length>=3?3:(hs?.last3?.length||0),am.length>=3?3:(as?.last3?.length||0));
      const support=(hs&&as?50:30)+(modelSample>=3?50:25);
      const reason=buildReason(o.value,prob,f.home,f.away,hs,as,hm,am);
      scenarios.push({
        home:f.home,away:f.away,market:marketLabel(o.value),odds:o.odd,bookmaker:'Betfair Exchange',
        quoteAgeMin:o.quoteAgeMin??null,quoteFreshnessScore:null,liquidity:o.liquidity??null,
        prob:round(prob),pStat:round(prob),pFreq:null,pFair:null,edge:null,score:round(prob),topSelectionScore:round(prob),confidence:round(prob),
        analysisSupport:Math.round(clamp(support,0,100)),modelReady:true,topEligible:true,modelSample,
        probabilitySource:'ESPN classifica + ultime 3',modelVersion:'V154-ESPN-NO-API-KEY',
        homeStanding:hs||null,awayStanding:as||null,standingNote:standingNote(f.home,hs,f.away,as),
        recentForm:{home:hf,away:af,homeMatches:hm.length,awayMatches:am.length},reason,
        oddsSource:'Betfair Exchange',statsSource:'ESPN',fixtureId:`espn-${f.id}`,eventId:f.id,kickoff:f.date,
        league:f.league,leagueCode:f.leagueCode,homeLogo:f.homeLogo||null,awayLogo:f.awayLogo||null,
        _homeMatches:hm,_awayMatches:am,
        fieldAnalysis:{reason,confidence:round(prob),confidenceLabel:prob>=70?'Alta':prob>=55?'Media':'Bassa',warnings:[...(modelSample<3?['Ultime 3 non completamente disponibili']:[]),...(!hs||!as?['Classifica non disponibile per una delle due squadre']:[])]}
      });
    }
  }

  scenarios.sort((a,b)=>Number(b.prob)-Number(a.prob));
  const candidates=[],usedMatches=new Set();
  for(const s of scenarios){const key=normalizePair(s.home,s.away);if(usedMatches.has(key))continue;usedMatches.add(key);candidates.push(s);}
  diagnostics.push({provider:'v154-model',scenarios:scenarios.length,uniqueMatches:candidates.length,rule:'TOP 3 per probabilità; quota Betfair solo filtro massimo 3.70 e visualizzazione'});

  const data={date,fixtures:fixtures.length,analyzed:quoted.length,requests,requestBreakdown,candidates:candidates.slice(0,120),liveFixtures,diagnostics,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?120_000:600_000),data});
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json(data);
}

async function espn(path){
  const base='https://site.api.espn.com';
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(base+path,{headers:{Accept:'application/json','User-Agent':'AI-del-Pallone/154'},cache:'no-store'});
      const text=await r.text();let body={};try{body=text?JSON.parse(text):{};}catch{body={};}
      if(r.ok)return body;
      if(r.status===429&&attempt<2){await sleep(600*(attempt+1));continue;}
      return {...body,__error:`HTTP ${r.status}`};
    }catch(e){if(attempt===2)return{__error:e?.message||String(e)};await sleep(300*(attempt+1));}
  }
  return {__error:'ESPN non disponibile'};
}

function adaptEspnEvent(e,code,cfg){
  const c=Array.isArray(e?.competitions)?e.competitions[0]:null;
  const comps=Array.isArray(c?.competitors)?c.competitors:[];
  const home=comps.find(x=>x?.homeAway==='home')||comps[0];
  const away=comps.find(x=>x?.homeAway==='away')||comps[1];
  if(!home?.team?.displayName||!away?.team?.displayName||!e?.date)return null;
  const state=String(e?.status?.type?.state||'').toLowerCase();
  const completed=Boolean(e?.status?.type?.completed);
  let status='SCHEDULED';
  if(state==='in'||state==='live')status='LIVE';else if(completed||state==='post')status='FINISHED';
  return {
    id:String(e.id),date:e.date,status,
    home:home.team.displayName,away:away.team.displayName,
    homeId:home.team.id,awayId:away.team.id,
    homeLogo:home.team.logo||null,awayLogo:away.team.logo||null,
    score:{home:Number(home.score),away:Number(away.score)},
    league:e?.league?.name||e?.league?.abbreviation||cfg.name,leagueCode:code
  };
}

function parseEspnStandings(payload,code){
  const found=[];
  walk(payload,x=>{if(Array.isArray(x?.entries)&&x.entries.some(e=>e?.team))found.push(x.entries);});
  const entries=found.flat();
  const rows=entries.filter(e=>e?.team?.displayName||e?.team?.name);
  const total=rows.length;
  const map=new Map();
  for(const e of rows){
    const name=e.team.displayName||e.team.name;const stats=Array.isArray(e.stats)?e.stats:[];
    const get=(...keys)=>{const s=stats.find(x=>keys.some(k=>String(x?.name||'').toLowerCase()===k||String(x?.abbreviation||'').toLowerCase()===k||String(x?.displayName||'').toLowerCase()===k));return s?.value??s?.displayValue??null;};
    const rank=Number(get('rank','rk','ranking'));const points=Number(get('points','pts'));const played=Number(get('gamesPlayed','gp','played'));const form=String(e?.form||get('form')||'').replace(/[^WDL]/gi,'').toUpperCase();
    map.set(teamKey(name),{teamId:e.team?.id,teamName:name,position:Number.isFinite(rank)?rank:null,totalTeams:total,points:Number.isFinite(points)?points:null,playedGames:Number.isFinite(played)?played:null,form,last3:form.slice(-3),form3Points:formPoints(form.slice(-3))});
  }
  return map;
}

function recentThreeForTeams(fixtures,home,away,date){
  const finished=fixtures.filter(f=>isFinishedStatus(f.status)&&localDate(f.date)<date).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const pick=(name)=>finished.filter(f=>teamSimilarity(f.home,name)>=.75||teamSimilarity(f.away,name)>=.75).slice(0,3).reverse();
  return {home:pick(home),away:pick(away)};
}

function formPoints(s){return String(s||'').split('').reduce((n,x)=>n+(x==='W'?3:x==='D'?1:0),0);}
function pointsFromMatches(rows,name){let p=0;for(const m of rows){const hg=Number(m.score.home),ag=Number(m.score.away),isHome=teamSimilarity(m.home,name)>=.75,gf=isHome?hg:ag,ga=isHome?ag:hg;if(!Number.isFinite(gf)||!Number.isFinite(ga))continue;p+=gf>ga?3:gf===ga?1:0;}return rows.length?p:null;}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}
function estimateProbability(value,h,a,hs,as,hm,am){const m=String(value||''),diff=standingStrength(hs)-standingStrength(as),formDiff=(Number.isFinite(h.form)?h.form:.5)-(Number.isFinite(a.form)?a.form:.5);if(['1','X','2'].includes(m)){const z=clamp(diff*2.1+formDiff*.9,-2,2),home=1/(1+Math.exp(-z)),draw=clamp(.28-Math.abs(z)*.04,.20,.30),non=1-draw,ph=non*home,pa=non-ph;return(m==='1'?ph:m==='2'?pa:draw)*100;}const rows=[...hm,...am];if(!rows.length)return null;if(m==='Goal'||m==='No Goal'){const r=rows.filter(x=>x.score.home>0&&x.score.away>0).length/rows.length,p=clamp(r*100,10,90);return m==='Goal'?p:100-p;}const mm=m.match(/(Over|Under)\s+(1\.5|2\.5|3\.5|4\.5)/i);if(mm){const n=Number(mm[2]),r=rows.filter(x=>x.score.home+x.score.away>n).length/rows.length,p=clamp(r*100,10,90);return mm[1].toLowerCase()==='over'?p:100-p;}return null;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position&&hs?.totalTeams)x.push(`${home} è ${hs.position}ª su ${hs.totalTeams}`);if(as?.position&&as?.totalTeams)x.push(`${away} è ${as.position}º su ${as.totalTeams}`);return x.length?x.join('; '):null;}
function buildReason(value,prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);const hp=hm.length?pointsFromMatches(hm,home):null,ap=am.length?pointsFromMatches(am,away):null;if(hp!=null)bits.push(`${home}: ${hp} punti nelle ultime 3`);if(ap!=null)bits.push(`${away}: ${ap} punti nelle ultime 3`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join('. ')+'.';}
function marketLabel(v){return({'1':'1 (Casa)','X':'X (Pareggio)','2':'2 (Trasferta)'}[v])||v;}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}
function normalizeLeague(x){const s=String(x||'').trim().toUpperCase();const aliases={'135':'SA','136':'SB','39':'PL','140':'PD','78':'BL1','61':'FL1','2':'CL','88':'DED','94':'PPL'};return aliases[s]||((s in ESPN_LEAGUES)?s:null);}
function competitionAllowed(f,codes){if(codes?.length)return codes.includes(f.leagueCode);return true;}
function leagueCode(l){return l||'ESPN';}
function teamKey(s){return normalize(s).replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the)\b/g,' ').replace(/\s+/g,' ').trim();}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function clean(s){return normalize(s).replace(/\b(fc|cf|afc|calcio|ac|as|ssc|cfc|fk|sk|sv|bk|sc|club)\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function teamSimilarity(a,b){const aa=teamKey(a),bb=teamKey(b);if(!aa||!bb)return 0;if(aa===bb)return 1;if(aa.includes(bb)||bb.includes(aa))return .94;const A=new Set(aa.split(' ').filter(x=>x.length>2)),B=new Set(bb.split(' ').filter(x=>x.length>2));let c=0;for(const x of A)if(B.has(x))c++;if(!c)return 0;return Math.max(c/(A.size+B.size-c),(c/Math.min(A.size,B.size))*.92);}
function isLiveStatus(s){return String(s||'').toUpperCase()==='LIVE';}
function isFinishedStatus(s){return ['FINISHED','FT','POST','POSTPONED','CANCELLED','SUSPENDED'].includes(String(s||'').toUpperCase());}
function localDate(iso){try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}catch{return String(iso||'').slice(0,10);}}
function localTodayRome(){return localDate(new Date().toISOString());}
function timeWindowAllows(iso,w){try{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));const m=Number(p.find(x=>x.type==='hour')?.value)*60+Number(p.find(x=>x.type==='minute')?.value);if(w==='afternoon1')return m>=780&&m<=960;if(w==='afternoon2')return m>=961&&m<=1140;if(w==='evening')return m>=1141&&m<=1320;return m>=660&&m<=1320;}catch{return false;}}
function shiftDate(iso,delta){const d=new Date(`${iso}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
function walk(v,cb){if(!v||typeof v!=='object')return;cb(v);if(Array.isArray(v)){for(const x of v)walk(x,cb);}else{for(const x of Object.values(v))walk(x,cb);}}

async function supaRead(url,key,path){const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});const text=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);return text?JSON.parse(text):[];}
function unwrapCatalogue(payload){const out=[];const walkCat=v=>{if(Array.isArray(v)){for(const x of v)walkCat(x);return;}if(v&&typeof v==='object'){if(Array.isArray(v.result)){for(const x of v.result)walkCat(x);return;}if(v.marketId)out.push(v);}};walkCat(payload);return out;}
function bestBack(r){const p=Number(r?.backPrice);if(p>1&&Number.isFinite(p))return p;const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.map(x=>Number(x?.price)).filter(x=>x>1&&Number.isFinite(x)).sort((a,b)=>b-a)[0]??null;}
async function loadBetfairSnapshot(url,key){try{const cat=await supaRead(url,key,'betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1');const books=await supaRead(url,key,'betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=3000');const latest=new Map();for(const r of books){if(r?.market_id&&!latest.has(String(r.market_id)))latest.set(String(r.market_id),r);}const fixtures=new Map();for(const m of unwrapCatalogue(cat[0]?.payload)){const name=String(m.marketName||'');if(!/match odds|1x2|esito finale|over|under/i.test(name))continue;const b=latest.get(String(m.marketId));if(!b)continue;const runners=(Array.isArray(b.payload?.runners)?b.payload.runners:[]).map(r=>({selectionId:r.selectionId,status:r.status,backPrice:bestBack(r),backSize:r.backSize??null,layPrice:null,name:(Array.isArray(m.runners)?m.runners.find(x=>String(x?.selectionId)===String(r.selectionId))?.runnerName:null)||String(r.selectionId)}));const item={marketId:String(m.marketId),marketName:name,event:m.event||null,competition:m.competition||null,receivedAt:b.received_at||m.received_at,runners};const en=String(m.event?.name||'');const p=en.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);if(p.length<2)continue;const keyPair=normalizePair(p[0],p.slice(1).join(' '));if(!fixtures.has(keyPair))fixtures.set(keyPair,[]);fixtures.get(keyPair).push(item);}return{fixtures,catalogueMarkets:unwrapCatalogue(cat[0]?.payload).length,bookMarkets:latest.size,error:null};}catch(e){return{fixtures:new Map(),catalogueMarkets:0,bookMarkets:0,error:e?.message||String(e)};}}
function findBestBetfairFixture(home,away,fixtures){if(!home||!away)return null;const exact=fixtures.get(normalizePair(home,away));if(exact)return exact;const rev=fixtures.get(normalizePair(away,home));if(rev)return rev;let best=null,scoreBest=0;for(const [,ms] of fixtures){const en=String(ms?.[0]?.event?.name||'');const p=en.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);if(p.length<2)continue;const bh=p[0],ba=p.slice(1).join(' ');const a=teamSimilarity(home,bh),b=teamSimilarity(away,ba),c=teamSimilarity(home,ba),d=teamSimilarity(away,bh);const direct=(a+b)/2,reverse=(c+d)/2,score=Math.max(direct,reverse);if(Math.max(a,c)>=.50&&Math.max(b,d)>=.50&&score>scoreBest){best=ms;scoreBest=score;}}return best;}
function extractBetfairOdds(markets,requestedMarket,home,away){const out=[];const totals=requestedMarket==='all'||requestedMarket==='totals',one=requestedMarket==='all'||requestedMarket==='1x2';const hn=normalize(home),an=normalize(away);for(const m of(Array.isArray(markets)?markets:[])){const name=String(m.marketName||'');const isMatch=/match odds|1x2|esito finale/i.test(name);const lm=name.match(/(?:under.*over|over.*under|under\s*\/\s*over|over\s*\/\s*under)[^0-9]*(1\.5|2\.5|3\.5|4\.5)/i);const line=lm?Number(lm[1]):null;if(!isMatch&&!(totals&&line))continue;if(isMatch&&!one)continue;for(const r of(Array.isArray(m.runners)?m.runners:[])){const odd=Number(r.backPrice);if(!(odd>1&&Number.isFinite(odd)))continue;const label=normalize(r.name);let value=null;if(isMatch){if(label==='1'||label==='home'||label==='casa'||label===hn||label.includes(hn))value='1';else if(['x','draw','pareggio','tie','the draw'].includes(label))value='X';else if(label==='2'||label==='away'||label==='trasferta'||label===an||label.includes(an))value='2';}else{if(/\bover\b/i.test(r.name))value=`Over ${line.toFixed(1)}`;else if(/\bunder\b/i.test(r.name))value=`Under ${line.toFixed(1)}`;}if(value){const age=m.receivedAt?Math.max(0,(Date.now()-new Date(m.receivedAt).getTime())/60000):null;out.push({value,odd,quoteAgeMin:age,liquidity:r.backSize??null});}}}const best=new Map();for(const x of out){const old=best.get(x.value);if(!old||((x.quoteAgeMin??1e99)<(old.quoteAgeMin??1e99))||(x.quoteAgeMin===old.quoteAgeMin&&x.odd>old.odd))best.set(x.value,x);}return [...best.values()];}
