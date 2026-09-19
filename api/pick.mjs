const RESPONSE_CACHE = new Map();

export default async function safeHandler(req, res) {
  try {
    return await handler(req, res);
  } catch (e) {
    console.error("AI DEL PALLONE /api/pick error", e);
    if (!res.headersSent) res.status(500).json({ error:`Errore interno durante l'analisi: ${e?.message || String(e)}` });
  }
}

async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  const supaUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const u = new URL(req.url, "https://vercel.local");
  const date = u.searchParams.get("date");
  const rawLeagues = u.searchParams.get("leagues") || "";
  const requestedCodes = rawLeagues === "EUROPE" ? [] : (rawLeagues ? rawLeagues.split(",").map(normalizeLeague).filter(Boolean) : []);
  const market = u.searchParams.get("market") || "all";
  const timeWindow = u.searchParams.get("timeWindow") || "all";
  if (!date) return res.status(400).json({error:"Data mancante"});
  if (!apiKey) return res.status(500).json({error:"API_FOOTBALL_KEY non configurata"});
  if (!supaUrl || !serviceKey) return res.status(500).json({error:"SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata"});

  const cacheKey=`v153-api-football-primary|${date}|${requestedCodes.join(",")}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached && cached.expires>Date.now()) return res.status(200).json({...cached.data,cached:true});

  let requests=0;
  const requestBreakdown={apiFootballFixtures:0,apiFootballStandings:0,apiFootballTeamLast3:0,betfairSnapshot:0};
  const diagnostics=[];

  // API-Football è ora la fonte primaria: calendario, stato, squadre, classifica
  // e ultime 3. Betfair viene interrogata solo per trovare la quota BACK.
  const fx=await apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=Europe%2FRome`,apiKey);
  requests++; requestBreakdown.apiFootballFixtures++;
  const allFixtures=Array.isArray(fx?.response)?fx.response:[];
  diagnostics.push({provider:"api-football-fixtures",results:allFixtures.length,error:fx?.errors||null,role:"calendario primario"});

  const liveFixtures=allFixtures.filter(f=>isLiveStatus(f?.fixture?.status?.short)).map(f=>({
    id:`af-live-${f.fixture.id}`,eventId:f.fixture.id,home:f.teams?.home?.name||"",away:f.teams?.away?.name||"",
    date:f.fixture?.date||null,league:f.league?.name||"",status:"live",score:{home:f.goals?.home,away:f.goals?.away}
  }));
  const liveKeys=new Set(liveFixtures.map(x=>normalizePair(x.home,x.away)));

  const beforeGate=allFixtures.filter(f=>localDate(f.fixture?.date)===date).length;
  let fixtures=allFixtures
    .filter(f=>localDate(f.fixture?.date)===date)
    .filter(f=>!isLiveStatus(f?.fixture?.status?.short))
    .filter(f=>!isFinishedStatus(f?.fixture?.status?.short))
    .filter(f=>competitionAllowed(f,requestedCodes))
    .filter(f=>{const t=new Date(f.fixture?.date||0).getTime();return Number.isFinite(t)&&t>Date.now();})
    .filter(f=>timeWindowAllows(f.fixture?.date,timeWindow));

  diagnostics.push({provider:"prematch-gate",before:beforeGate,remaining:fixtures.length,rule:"solo API-Football fixture.date futuro + status; Betfair non decide se una gara è già iniziata"});

  const bf=await loadBetfairSnapshot(supaUrl,serviceKey);
  requests++; requestBreakdown.betfairSnapshot++;
  diagnostics.push({provider:"betfair-exchange",catalogueMarkets:bf.catalogueMarkets,bookMarkets:bf.bookMarkets,matchedFixtures:bf.fixtures.size,error:bf.error||null,role:"unica fonte delle quote"});

  const quoted=[];
  for(const f of fixtures){
    const home=f.teams?.home?.name||"", away=f.teams?.away?.name||"";
    const markets=findBestBetfairFixture(home,away,bf.fixtures);
    const odds=extractBetfairOdds(markets,market,home,away).filter(o=>o.odd>1&&o.odd<=3.7);
    if(odds.length) quoted.push({f,home,away,markets,odds});
  }
  diagnostics.push({provider:"betfair-pool",prematch:fixtures.length,withQuote:quoted.length,rule:"partita valida solo se esiste almeno una BACK Betfair tra 1.01 e 3.70"});

  if(!quoted.length){
    diagnostics.push({provider:"no-candidates-debug",reason:fixtures.length?"Nessuna quota BACK Betfair <= 3.70 riconosciuta per le partite API-Football pre-match":"Nessuna partita API-Football pre-match nel perimetro selezionato",apiFootballPrematch:fixtures.length,betfairFixtureKeys:bf.fixtures.size});
    const data={date,fixtures:fixtures.length,analyzed:0,requests,requestBreakdown,candidates:[],liveFixtures,diagnostics,cached:false};
    RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+30_000,data});
    return res.status(200).json(data);
  }

  // 1 chiamata standings per campionato/season, non per squadra.
  const leaguePairs=[...new Map(quoted.map(x=>[`${x.f.league?.id}|${x.f.league?.season}`,{id:x.f.league?.id,season:x.f.league?.season,name:x.f.league?.name}])).values()];
  const standings=new Map();
  await Promise.all(leaguePairs.map(async lp=>{
    const d=await apiFootball(`/standings?league=${encodeURIComponent(lp.id)}&season=${encodeURIComponent(lp.season)}`,apiKey);
    requests++; requestBreakdown.apiFootballStandings++;
    const map=new Map();
    const groups=Array.isArray(d?.response?.[0]?.league?.standings)?d.response[0].league.standings:[];
    for(const group of groups){
      if(!Array.isArray(group)) continue;
      for(const row of group){
        const id=row?.team?.id; if(id==null) continue;
        const form=String(row?.form||"").replace(/[^WDL]/gi,"").toUpperCase();
        map.set(String(id),{
          teamId:id,teamName:row?.team?.name||null,position:Number(row?.rank)||null,totalTeams:group.length,
          points:Number(row?.points)||null,playedGames:Number(row?.all?.played)||null,
          form,last3:form.slice(-3),form3Points:formPoints(form.slice(-3)),
          goalsFor:Number(row?.all?.goals?.for),goalsAgainst:Number(row?.all?.goals?.against)
        });
      }
    }
    standings.set(`${lp.id}|${lp.season}`,map);
    diagnostics.push({provider:"api-football-standings",league:lp.name,leagueId:lp.id,season:lp.season,teams:map.size,error:d?.errors||null,role:"classifica + forma"});
  }));

  // Ultime 3 esatte: una chiamata per squadra, ma solo per le squadre che hanno
  // già una quota Betfair valida. Le quote senza partita non consumano API.
  const teamIds=[...new Set(quoted.flatMap(x=>[x.f.teams?.home?.id,x.f.teams?.away?.id]).filter(Boolean).map(Number))];
  const last3=new Map();
  // Il limite evita una raffica nelle giornate con centinaia di partite. Per le
  // squadre oltre il limite usiamo la forma W/D/L degli standings come fallback.
  const teamJobs=teamIds.slice(0,40);
  await Promise.all(teamJobs.map(async id=>{
    const d=await apiFootball(`/fixtures?team=${encodeURIComponent(id)}&last=3&timezone=Europe%2FRome`,apiKey);
    requests++; requestBreakdown.apiFootballTeamLast3++;
    const rows=Array.isArray(d?.response)?d.response.map(adaptApiFixture).filter(x=>Number.isFinite(x.score?.fullTime?.home)&&Number.isFinite(x.score?.fullTime?.away)):[];
    last3.set(String(id),rows.slice(-3));
  }));
  diagnostics.push({provider:"api-football-last3",teamsRequested:teamJobs.length,teamsTotal:teamIds.length,role:"ultime 3 partite esatte; fallback W/D/L degli standings per le squadre oltre il limite"});

  const scenarios=[];
  for(const q of quoted){
    const f=q.f;
    const hs=getStanding(f,"home",standings), as=getStanding(f,"away",standings);
    const hm=last3.get(String(f.teams?.home?.id))||[], am=last3.get(String(f.teams?.away?.id))||[];
    const hf=hm.length?pointsFromMatches(hm,f.teams.home.id)/3:Number.isFinite(hs?.form3Points)?hs.form3Points/9:0.5;
    const af=am.length?pointsFromMatches(am,f.teams.away.id)/3:Number.isFinite(as?.form3Points)?as.form3Points/9:0.5;
    const homeStats={teamName:q.home,form:hf,sample:hm.length};
    const awayStats={teamName:q.away,form:af,sample:am.length};
    for(const o of q.odds){
      const prob=estimateProbability(o.value,homeStats,awayStats,hs,as,hm,am);
      if(!Number.isFinite(prob)) continue;
      const exactHome=hm.length>=3, exactAway=am.length>=3;
      const modelSample=Math.min(exactHome?3:(hs?.last3?.length||0),exactAway?3:(as?.last3?.length||0));
      const support=(hs&&as?50:30)+(modelSample>=3?50:25);
      const reason=buildReason(o.value,prob,q.home,q.away,hs,as,hm,am);
      scenarios.push({
        home:q.home,away:q.away,market:marketLabel(o.value),odds:o.odd,bookmaker:"Betfair Exchange",
        quoteAgeMin:o.quoteAgeMin??null,quoteFreshnessScore:o.quoteFreshnessScore??null,liquidity:o.liquidity??null,
        prob:round(prob),pStat:round(prob),pFreq:null,pFair:null,edge:null,score:round(prob),topSelectionScore:round(prob),confidence:round(prob),
        analysisSupport:Math.round(clamp(support,0,100)),modelReady:true,topEligible:true,modelSample:modelSample,
        probabilitySource:"API-Football classifica + ultime 3",modelVersion:"V153-API-FOOTBALL-PRIMARY",
        homeStanding:hs,awayStanding:as,standingNote:standingNote(q.home,hs,q.away,as),
        recentForm:{home:hf,away:af,homeMatches:modelSample,awayMatches:modelSample},reason,
        oddsSource:"Betfair Exchange",statsSource:"API-Football",fixtureId:`af-${f.fixture.id}`,eventId:f.fixture.id,kickoff:f.fixture.date,
        league:f.league?.name||"",leagueCode:leagueCode(f.league),homeLogo:f.teams?.home?.logo||null,awayLogo:f.teams?.away?.logo||null,
        _homeMatches:hm,_awayMatches:am,_homeTeamId:f.teams?.home?.id,_awayTeamId:f.teams?.away?.id,
        fieldAnalysis:{reason,confidence:round(prob),confidenceLabel:prob>=70?"Alta":prob>=55?"Media":"Bassa",warnings:[...(modelSample<3?["Ultime 3 non completamente disponibili"]:[]),...(!hs||!as?["Classifica non disponibile per una delle due squadre"]:[])]}
      });
    }
  }

  // Ranking esclusivamente per probabilità. La quota non pesa mai sul modello.
  scenarios.sort((a,b)=>Number(b.prob)-Number(a.prob));
  const candidates=[]; const usedMatches=new Set();
  for(const s of scenarios){
    const key=normalizePair(s.home,s.away);
    if(usedMatches.has(key)) continue;
    usedMatches.add(key); candidates.push(s);
  }
  diagnostics.push({provider:"v153-model",scenarios:scenarios.length,uniqueMatches:candidates.length,rule:"TOP 3 per probabilità; quota Betfair solo come filtro massimo 3.70 e visualizzazione"});

  const data={date,fixtures:fixtures.length,analyzed:quoted.length,requests,requestBreakdown,candidates:candidates.slice(0,120),liveFixtures,diagnostics,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?30_000:90_000),data});
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(data);
}

async function apiFootball(path,key){
  const r=await fetch("https://v3.football.api-sports.io"+path,{headers:{"x-apisports-key":key,"Accept":"application/json"}});
  const text=await r.text(); let body={}; try{body=text?JSON.parse(text):{}}catch{body={errors:{message:text.slice(0,500)}};}
  if(!r.ok) return {...body,errors:body.errors||{message:`HTTP ${r.status}`}};
  return body;
}

function isLiveStatus(s){return ["1H","HT","2H","ET","BT","P","LIVE","INT","SUSP"].includes(String(s||"").toUpperCase());}
function isFinishedStatus(s){return ["FT","AET","PEN","CANC","PST","ABD","AWD","WO"].includes(String(s||"").toUpperCase());}
function localDate(iso){try{return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(iso));}catch{return String(iso||"").slice(0,10);}}
function localTodayRome(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}
function timeWindowAllows(iso,w){try{const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Rome",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date(iso));const m=Number(p.find(x=>x.type==="hour")?.value)*60+Number(p.find(x=>x.type==="minute")?.value);if(w==="afternoon1")return m>=780&&m<=960;if(w==="afternoon2")return m>=961&&m<=1140;if(w==="evening")return m>=1141&&m<=1320;return m>=660&&m<=1320;}catch{return false;}}
function normalize(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}
function clean(s){return String(s||"").toLowerCase().replace(/\b(fc|cf|afc|calcio|ac|as|ssc|cfc|fk|sk|sv|bk|sc)\b/g,"").replace(/[^a-z0-9]+/g,"").trim();}
function teamKey(s){return normalize(s).replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|the)\b/g," ").replace(/\s+/g," ").trim();}
function teamSimilarity(a,b){const aa=teamKey(a),bb=teamKey(b);if(!aa||!bb)return 0;if(aa===bb)return 1;if(aa.includes(bb)||bb.includes(aa))return .94;const A=new Set(aa.split(" ").filter(x=>x.length>2)),B=new Set(bb.split(" ").filter(x=>x.length>2));let c=0;for(const x of A)if(B.has(x))c++;if(!c)return 0;return Math.max(c/(A.size+B.size-c),(c/Math.min(A.size,B.size))*.92);}

function normalizeLeague(x){const s=String(x||"").trim().toUpperCase();const map={"135":"SA","136":"SB","39":"PL","140":"PD","78":"BL1","61":"FL1","2":"CL","88":"DED","94":"PPL"};const allowed=["SA","SB","PL","PD","BL1","FL1","PPL","DED","BEL1","SCO1","AUT1","SUI1","TUR1","GRE1","DEN1","SWE1","NOR1","POL1","CZE1","CRO1","SRB1","ROU1","UKR1","HUN1","SVK1","CL","EL","ECL","BRA1","ARG1","COL1","CHI1","URU1","ECU1","PER1","MLS1","JPN1"];return map[s]||(allowed.includes(s)?s:null);}
function competitionAllowed(f,codes){if(codes?.length)return codes.some(c=>leagueMatches(f.league,c));const t=`${f.league?.country||""} ${f.league?.name||""}`.toLowerCase();if(/women|u17|u18|u19|u20|u21|youth|reserve|friendly|amateur/.test(t))return false;return /serie a.*italy|italy.*serie a|serie b.*italy|italy.*serie b|premier league.*england|england.*premier league|la liga.*spain|spain.*la liga|bundesliga.*germany|ligue 1.*france|primeira liga.*portugal|eredivisie.*netherlands|pro league.*belgium|premiership.*scotland|super lig.*turkey|superliga.*denmark|allsvenskan.*sweden|eliteserien.*norway|ekstraklasa.*poland|champions league|europa league|conference league/.test(t);}
function leagueMatches(l,c){const t=`${l?.country||""} ${l?.name||""}`.toLowerCase();const rules={SA:/italy|italia/.test(t)&&/serie a/.test(t)&&!/serie b/.test(t),SB:/italy|italia/.test(t)&&/serie b/.test(t),PL:/england/.test(t)&&/premier league/.test(t),PD:/spain|spagna/.test(t)&&/la liga/.test(t),BL1:/germany/.test(t)&&/bundesliga/.test(t)&&!/2\.? bundesliga/.test(t),FL1:/france/.test(t)&&/ligue 1/.test(t),PPL:/portugal/.test(t)&&/primeira liga/.test(t),DED:/netherlands|nederland/.test(t)&&/eredivisie/.test(t),CL:/champions league/.test(t),EL:/europa league/.test(t),ECL:/conference league/.test(t)};return !!rules[c];}
function leagueCode(l){const t=`${l?.country||""} ${l?.name||""}`.toLowerCase();if(/italy|italia/.test(t)&&/serie a/.test(t))return"SA";if(/italy|italia/.test(t)&&/serie b/.test(t))return"SB";if(/england/.test(t)&&/premier league/.test(t))return"PL";if(/spain|spagna/.test(t)&&/la liga/.test(t))return"PD";if(/germany/.test(t)&&/bundesliga/.test(t)&&!/2\.? bundesliga/.test(t))return"BL1";if(/france/.test(t)&&/ligue 1/.test(t))return"FL1";if(/portugal/.test(t)&&/primeira liga/.test(t))return"PPL";if(/netherlands|nederland/.test(t)&&/eredivisie/.test(t))return"DED";if(/champions league/.test(t))return"CL";if(/europa league/.test(t))return"EL";if(/conference league/.test(t))return"ECL";return l?.id?`AF-${l.id}`:"AF";}
function adaptApiFixture(f){return{id:`af-${f?.fixture?.id}`,utcDate:f?.fixture?.date,status:isFinishedStatus(f?.fixture?.status?.short)?"FINISHED":isLiveStatus(f?.fixture?.status?.short)?"LIVE":"SCHEDULED",homeTeam:{id:f?.teams?.home?.id,name:f?.teams?.home?.name,crest:f?.teams?.home?.logo},awayTeam:{id:f?.teams?.away?.id,name:f?.teams?.away?.name,crest:f?.teams?.away?.logo},score:{fullTime:{home:Number(f?.goals?.home),away:Number(f?.goals?.away)}},competition:{name:f?.league?.name}};}

function formPoints(s){return String(s||"").split("").reduce((n,x)=>n+(x==="W"?3:x==="D"?1:0),0);}
function pointsFromMatches(rows,id){let p=0;for(const m of rows){const hg=Number(m.score.fullTime.home),ag=Number(m.score.fullTime.away),home=String(m.homeTeam?.id)===String(id),gf=home?hg:ag,ga=home?ag:hg;p+=gf>ga?3:gf===ga?1:0;}return rows.length?p:null;}
function getStanding(f,side,standings){return standings.get(`${f.league?.id}|${f.league?.season}`)?.get(String(side==="home"?f.teams?.home?.id:f.teams?.away?.id))||null;}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}
function estimateProbability(value,h,a,hs,as,hm,am){const m=String(value||""), diff=standingStrength(hs)-standingStrength(as), formDiff=(Number(h.form)||.5)-(Number(a.form)||.5);if(["1","X","2"].includes(m)){const z=clamp(diff*2.1+formDiff*.9,-2,2),home=1/(1+Math.exp(-z)),draw=clamp(.28-Math.abs(z)*.04,.20,.30),non=1-draw,ph=non*home,pa=non-ph;return(m==="1"?ph:m==="2"?pa:draw)*100;}const rows=[...hm,...am];if(!rows.length)return null;if(m==="Goal"||m==="No Goal"){const r=rows.filter(x=>x.score.fullTime.home>0&&x.score.fullTime.away>0).length/rows.length,p=clamp(r*100,10,90);return m==="Goal"?p:100-p;}const mm=m.match(/(Over|Under)\s+(1\.5|2\.5|3\.5|4\.5)/i);if(mm){const n=Number(mm[2]),r=rows.filter(x=>x.score.fullTime.home+x.score.fullTime.away>n).length/rows.length,p=clamp(r*100,10,90);return mm[1].toLowerCase()==="over"?p:100-p;}return null;}
function standingNote(home,hs,away,as){const x=[];if(hs?.position&&hs?.totalTeams)x.push(`${home} è ${hs.position}ª su ${hs.totalTeams}`);if(as?.position&&as?.totalTeams)x.push(`${away} è ${as.position}º su ${as.totalTeams}`);return x.length?x.join("; "):null;}
function buildReason(value,prob,home,away,hs,as,hm,am){const bits=[];const sn=standingNote(home,hs,away,as);if(sn)bits.push(sn);const hp=hm.length?pointsFromMatches(hm,hs?.teamId):null,ap=am.length?pointsFromMatches(am,as?.teamId):null;if(hp!=null)bits.push(`${home}: ${hp} punti nelle ultime 3`);if(ap!=null)bits.push(`${away}: ${ap} punti nelle ultime 3`);bits.push(`probabilità stimata ${Number(prob).toFixed(1)}%`);return bits.slice(0,3).join(". ")+".";}
function marketLabel(v){return({"1":"1 (Casa)","X":"X (Pareggio)","2":"2 (Trasferta)"}[v])||v;}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function round(x){return Math.round(x*10)/10;}

async function supaRead(url,key,path){const r=await fetch(`${url}/rest/v1/${path}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});const text=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}: ${text.slice(0,400)}`);return text?JSON.parse(text):[];}
function unwrapCatalogue(payload){const out=[];const walk=v=>{if(Array.isArray(v)){for(const x of v)walk(x);return;}if(v&&typeof v==="object"){if(Array.isArray(v.result)){for(const x of v.result)walk(x);return;}if(v.marketId)out.push(v);}};walk(payload);return out;}
function bestBack(r){const p=Number(r?.backPrice);if(p>1&&Number.isFinite(p))return p;const xs=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];return xs.map(x=>Number(x?.price)).filter(x=>x>1&&Number.isFinite(x)).sort((a,b)=>b-a)[0]??null;}
async function loadBetfairSnapshot(url,key){try{const cat=await supaRead(url,key,'betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1');const books=await supaRead(url,key,'betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=3000');const latest=new Map();for(const r of books){if(r?.market_id&&!latest.has(String(r.market_id)))latest.set(String(r.market_id),r);}const fixtures=new Map();for(const m of unwrapCatalogue(cat[0]?.payload)){const name=String(m.marketName||"");if(!/match odds|1x2|esito finale|over|under/i.test(name))continue;const b=latest.get(String(m.marketId));if(!b)continue;const runners=(Array.isArray(b.payload?.runners)?b.payload.runners:[]).map(r=>({selectionId:r.selectionId,status:r.status,backPrice:bestBack(r),backSize:r.backSize??null,layPrice:null,name:(Array.isArray(m.runners)?m.runners.find(x=>String(x?.selectionId)===String(r.selectionId))?.runnerName:null)||String(r.selectionId)}));const item={marketId:String(m.marketId),marketName:name,event:m.event||null,competition:m.competition||null,receivedAt:b.received_at||m.received_at,runners};const en=String(m.event?.name||"");const p=en.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);if(p.length<2)continue;const keyPair=normalizePair(p[0],p.slice(1).join(" "));if(!fixtures.has(keyPair))fixtures.set(keyPair,[]);fixtures.get(keyPair).push(item);}return{fixtures,catalogueMarkets:unwrapCatalogue(cat[0]?.payload).length,bookMarkets:latest.size,error:null};}catch(e){return{fixtures:new Map(),catalogueMarkets:0,bookMarkets:0,error:e?.message||String(e)};}}
function findBestBetfairFixture(home,away,fixtures){if(!home||!away)return null;const exact=fixtures.get(normalizePair(home,away));if(exact)return exact;const rev=fixtures.get(normalizePair(away,home));if(rev)return rev;let best=null,scoreBest=0;for(const [,ms] of fixtures){const en=String(ms?.[0]?.event?.name||"");const p=en.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);if(p.length<2)continue;const bh=p[0],ba=p.slice(1).join(" ");const a=teamSimilarity(home,bh),b=teamSimilarity(away,ba),c=teamSimilarity(home,ba),d=teamSimilarity(away,bh);const direct=(a+b)/2,reverse=(c+d)/2,score=Math.max(direct,reverse);if(Math.max(a,c)>=.50&&Math.max(b,d)>=.50&&score>scoreBest){best=ms;scoreBest=score;}}return best;}
function extractBetfairOdds(markets,requestedMarket,home,away){const out=[];const totals=requestedMarket==="all"||requestedMarket==="totals",one=requestedMarket==="all"||requestedMarket==="1x2";const hn=normalize(home),an=normalize(away);for(const m of(Array.isArray(markets)?markets:[])){const name=String(m.marketName||"");const isMatch=/match odds|1x2|esito finale/i.test(name);const lm=name.match(/(?:under.*over|over.*under|under\s*\/\s*over|over\s*\/\s*under)[^0-9]*(1\.5|2\.5|3\.5|4\.5)/i);const line=lm?Number(lm[1]):null;if(!isMatch&&!(totals&&line))continue;if(isMatch&&!one)continue;for(const r of(Array.isArray(m.runners)?m.runners:[])){const odd=Number(r.backPrice);if(!(odd>1&&Number.isFinite(odd)))continue;const label=normalize(r.name);let value=null;if(isMatch){if(label==="1"||label==="home"||label==="casa"||label===hn||label.includes(hn))value="1";else if(["x","draw","pareggio","tie","the draw"].includes(label))value="X";else if(label==="2"||label==="away"||label==="trasferta"||label===an||label.includes(an))value="2";}else{if(/\bover\b/i.test(r.name))value=`Over ${line.toFixed(1)}`;else if(/\bunder\b/i.test(r.name))value=`Under ${line.toFixed(1)}`;}if(value){const age=m.receivedAt?Math.max(0,(Date.now()-new Date(m.receivedAt).getTime())/60000):null;out.push({value,odd,quoteAgeMin:age,quoteFreshnessScore:null,liquidity:r.backSize??null});}}}const best=new Map();for(const x of out){const old=best.get(x.value);if(!old||((x.quoteAgeMin??1e99)<(old.quoteAgeMin??1e99))||(x.quoteAgeMin===old.quoteAgeMin&&x.odd>old.odd))best.set(x.value,x);}return [...best.values()];}
