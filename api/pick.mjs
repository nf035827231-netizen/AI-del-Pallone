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
  // Nazionali. Slug dedotti dal pattern ESPN (confermato per fifa.wworldq.uefa, le femminili);
  // vanno verificati dopo il primo deploy guardando diagnostics->espn->fixtures per questi code:
  // se restano a 0 anche in date con partite note, lo slug va corretto.
  WCQ:{slug:'fifa.worldq.uefa',name:'Qualificazioni Mondiali UEFA'},
  NL:{slug:'uefa.nations',name:'UEFA Nations League'},
  EURO:{slug:'uefa.euro',name:'Europei'},
  EUROQ:{slug:'uefa.euroq',name:'Qualificazioni Europei'}
};

// "Migliori 8" campionati europei + le 3 coppe UEFA + le competizioni delle nazionali:
// questo è il perimetro privilegiato di default. Gli altri campionati (elenco sotto)
// vengono usati solo come seconda scelta, e solo se serve, per completare le 5 proposte.
const TOP8=['SA','PL','PD','BL1','FL1','PPL','DED','BEL1'];
const EURO_CUPS=['CL','EL','ECL'];
const NATIONAL_CODES=['WCQ','NL','EURO','EUROQ'];
const PRIORITY_CODES=[...TOP8,...EURO_CUPS,...NATIONAL_CODES];
const FALLBACK_CODES=Object.keys(ESPN_LEAGUES).filter(c=>!PRIORITY_CODES.includes(c));
const DEFAULT_CODES=PRIORITY_CODES;

// Mercati che il prodotto vuole analizzare: 1X2 e Over/Under 2.5-3.5. Niente 1.5, 4.5, Goal/No Goal.
const ALLOWED_MARKETS=new Set(['1','X','2','Over 2.5','Under 2.5','Over 3.5','Under 3.5']);
// Quota massima 4.00, fissa: non si allarga oltre come si faceva prima con le quote più alte.
const MAX_ODDS=4.0;

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
  const usingDefaultPool=!raw||raw==='EUROPE'; // solo in questo caso ha senso il fallback "priorità->tutti"
  const market=u.searchParams.get('market')||'all';
  const timeWindow=u.searchParams.get('timeWindow')||'all';
  if(!date) return res.status(400).json({error:'Data mancante'});
  if(!supaUrl||!serviceKey) return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  const cacheKey=`v156-espn|${date}|${requestedCodes.join(',')}|${timeWindow}|${market}`;
  const cached=RESPONSE_CACHE.get(cacheKey);
  if(cached&&cached.expires>Date.now()) return res.status(200).json({...cached.data,cached:true});

  let requests=0;
  const requestBreakdown={espnScoreboards:0,espnStandings:0,betfairSnapshot:0};
  const diagnostics=[];

  // ESPN sostituisce API-Football come fonte dati primaria. Non richiede API key.
  // Una chiamata scoreboard per campionato copre oggi + storico recente; una chiamata
  // standings per campionato fornisce classifica. Nessuna chiamata per squadra.
  // 60 giorni indietro: range sicuro (il limite documentato di ESPN per "dates=" è 13 mesi,
  // circa 396 giorni — un valore troppo vicino a quel limite rischia di far fallire la
  // richiesta per TUTTI i campionati insieme, come è successo con 400 giorni). Gli scontri
  // diretti (H2H) quindi troveranno solo incontri avvenuti negli ultimi 60 giorni: per
  // trovarne anche di più vecchi (stagione scorsa) servirebbe una chiamata dedicata più
  // piccola, solo quando serve — non ancora implementata, vedi nota in fondo alla risposta.
  const daysBack=60, daysForward=7;
  const from=shiftDate(date,-daysBack), to=shiftDate(date,daysForward);
  const apiFootballCircuitBreaker={disabled:false}; // per questa sola richiesta

  async function fetchPool(codeList){
    const codes=[...new Set(codeList)].filter(c=>ESPN_LEAGUES[c]);
    const unknownCodes=codeList.filter(c=>!ESPN_LEAGUES[c]);
    if(unknownCodes.length) diagnostics.push({provider:'espn-config',unsupported:unknownCodes,role:'campionati non mappati'});
    const results=await mapLimit(codes,4,async code=>{
      const cfg=ESPN_LEAGUES[code];
      const [score,table]=await Promise.all([
        espn(`/apis/site/v2/sports/soccer/${cfg.slug}/scoreboard?dates=${from.replaceAll('-','')}-${to.replaceAll('-','')}`),
        espn(`/apis/v2/sports/soccer/${cfg.slug}/standings`)
      ]);
      requests+=2; requestBreakdown.espnScoreboards++; requestBreakdown.espnStandings++;
      const events=Array.isArray(score?.events)?score.events:[];
      let fixtures=events.map(e=>adaptEspnEvent(e,code,cfg)).filter(Boolean);
      let standings=parseEspnStandings(table,code);
      diagnostics.push({provider:'espn',league:cfg.name,code,slug:cfg.slug,fixtures:fixtures.length,standings:standings.size,scoreError:score?.__error||null,standingsError:table?.__error||null,role:'calendario + ultime 3 + classifica'});
      // Riserva: se ESPN non ha risposto per questo campionato (errore o zero dati utili),
      // proviamo API-Football, solo per questo singolo campionato.
      const espnFailed=Boolean(score?.__error)||(fixtures.length===0&&standings.size===0);
      if(espnFailed){
        const fb=await tryApiFootballFallback(code,cfg,date,diagnostics,apiFootballCircuitBreaker);
        if(fb.fixtures.length) fixtures=fb.fixtures;
        if(fb.standings.size) standings=fb.standings;
      }
      return {code,cfg,fixtures,standings};
    });
    return results;
  }

  const tier1Codes=usingDefaultPool?PRIORITY_CODES:requestedCodes;
  let sourceResults=await fetchPool(tier1Codes);
  let usedFallbackPool=false;

  function assembleFixtures(results,codesForGate){
    const allFixtures=results.flatMap(x=>x.fixtures);
    const liveFixtures=allFixtures.filter(f=>isLiveStatus(f.status)).filter(f=>localDate(f.date)===date).map(f=>({
      id:`espn-live-${f.id}`,eventId:f.id,home:f.home,away:f.away,date:f.date,league:f.league,status:'live',score:f.score
    }));
    const fixtures=allFixtures
      .filter(f=>localDate(f.date)===date)
      .filter(f=>!isLiveStatus(f.status))
      .filter(f=>!isFinishedStatus(f.status))
      .filter(f=>new Date(f.date).getTime()>Date.now())
      .filter(f=>competitionAllowed(f,codesForGate))
      .filter(f=>timeWindowAllows(f.date,timeWindow));
    return {allFixtures,liveFixtures,fixtures};
  }

  let {allFixtures,liveFixtures,fixtures}=assembleFixtures(sourceResults,tier1Codes);
  diagnostics.push({provider:'prematch-gate',pool:'priorità (top8+coppe+nazionali)',before:allFixtures.filter(f=>localDate(f.date)===date).length,remaining:fixtures.length,rule:'ESPN data + kickoff futuro; Betfair non decide se una gara è già iniziata'});

  const bf=await loadBetfairSnapshot(supaUrl,serviceKey);
  requests++; requestBreakdown.betfairSnapshot++;
  diagnostics.push({provider:'betfair-exchange',catalogueMarkets:bf.catalogueMarkets,bookMarkets:bf.bookMarkets,matchedFixtures:bf.fixtures.size,error:bf.error||null,role:'unica fonte delle quote'});

  let standingsByCode=new Map(sourceResults.map(x=>[x.code,x.standings]));

  function buildScenarios(oddsCap){
    const quoted=[];
    for(const f of fixtures){
      const markets=findBestBetfairFixture(f.home,f.away,bf.fixtures);
      const odds=extractBetfairOdds(markets,market,f.home,f.away).filter(o=>o.odd>1&&o.odd<=oddsCap);
      if(odds.length) quoted.push({f,markets,odds});
    }
    const scenarios=[];
    for(const q of quoted){
      const f=q.f;
      const table=standingsByCode.get(f.leagueCode)||new Map();
      const hs=table.get(teamKey(f.home));
      const as=table.get(teamKey(f.away));
      const leagueFixtures=sourceResults.find(x=>x.code===f.leagueCode)?.fixtures||[];
      const recent=recentThreeForTeams(leagueFixtures,f.home,f.away,date);
      const hm=recent.home, am=recent.away; // generico (qualunque ruolo): usato per la forma "punti" e come riserva
      const hVenue=recentByVenue(leagueFixtures,f.home,'home',date,hm);
      const aVenue=recentByVenue(leagueFixtures,f.away,'away',date,am);
      const hmv=hVenue.rows, amv=aVenue.rows; // usati per i gol attesi: specifici per ruolo quando il campione basta
      const hf=hm.length?pointsFromMatches(hm,f.home)/3:Number.isFinite(hs?.form3Points)?hs.form3Points/9:.5;
      const af=am.length?pointsFromMatches(am,f.away)/3:Number.isFinite(as?.form3Points)?as.form3Points/9:.5;
      const hgs=goalStats(hmv,f.home), ags=goalStats(amv,f.away);
      let {expHome,expAway}=expectedGoals(hgs,ags,hs,as);
      const h2h=headToHead(leagueFixtures,f.home,f.away,date);
      if(h2h.count>0){
        // Piccola correzione (max ±6%) basata sulla differenza reti media nei precedenti diretti,
        // pesata sul numero di precedenti trovati (1 solo precedente pesa meno di 3).
        const h2hWeight=clamp(h2h.count/3,0,1)*0.06;
        const nudge=clamp(h2h.avgGoalDiff/3,-1,1)*h2hWeight;
        expHome=clamp(expHome*(1+nudge),0.2,4.5);
        expAway=clamp(expAway*(1-nudge),0.2,4.5);
      }
      const probMap=matchProbabilities(expHome,expAway);
      const modelSample=Math.min(hmv.length>=3?3:(hs?.last3?.length||0),amv.length>=3?3:(as?.last3?.length||0));
      const sampleWeight=clamp((hmv.length+amv.length)/6,0,1);
      const modelWeight=0.35+0.35*sampleWeight;
      for(const o of q.odds){
        if(!ALLOWED_MARKETS.has(o.value)) continue; // solo 1X2 e Over/Under 2.5-3.5
        const modelProb=probMap[o.value];
        if(!Number.isFinite(modelProb)) continue;
        const marketImplied=clamp(100/o.odd,1,99);
        const blended=modelWeight*modelProb+(1-modelWeight)*marketImplied;
        const edge=(blended/100)*o.odd-1;
        const support=(hs&&as?50:30)+(modelSample>=3?50:25);
        const h2hNote=h2h.count?` Precedenti diretti: ${h2h.record}.`:'';
        const venueNote=(hVenue.venueOnly?` Forma casalinga ${f.home} sulle ultime ${hVenue.sample}.`:'')+(aVenue.venueOnly?` Forma in trasferta ${f.away} sulle ultime ${aVenue.sample}.`:'');
        const reason=buildReason(o.value,blended,f.home,f.away,hs,as,hm,am)+` Valore atteso stimato: ${edge>=0?'+':''}${round(edge*100)}%.`+venueNote+h2hNote;
        const warnings=[...(modelSample<3?['Campione gol/forma incompleto (meno di 3 partite recenti nel ruolo)']:[]),...(!hs||!as?['Classifica non disponibile per una delle due squadre']:[]),...(edge<0?['Valore atteso negativo secondo il modello: la quota non compensa il rischio stimato']:[]),...(!h2h.count?['Nessun precedente diretto trovato nel periodo analizzato']:[])];
        scenarios.push({
          home:f.home,away:f.away,market:marketLabel(o.value),odds:o.odd,bookmaker:'Betfair Exchange',
          quoteAgeMin:o.quoteAgeMin??null,quoteFreshnessScore:null,liquidity:o.liquidity??null,
          prob:round(blended),pStat:round(modelProb),pFreq:null,pMarket:round(marketImplied),pFair:round(blended),
          edge:round(edge*1000)/10,score:round(edge*1000)/10,topSelectionScore:round(blended),confidence:round(blended),
          analysisSupport:Math.round(clamp(support,0,100)),modelReady:true,topEligible:true,modelSample,
          probabilitySource:'Poisson (gol casa/trasferta specifici + H2H) + classifica, blended con quota di mercato',modelVersion:'V157-VENUE-H2H',
          homeStanding:hs||null,awayStanding:as||null,standingNote:standingNote(f.home,hs,f.away,as),
          headToHead:h2h.count?{count:h2h.count,record:h2h.record,recent:h2h.meetings}:null,
          recentForm:{home:hf,away:af,homeMatches:hm.length,awayMatches:am.length,homeVenueSpecific:hVenue.venueOnly,awayVenueSpecific:aVenue.venueOnly,homeVenueSample:hVenue.sample,awayVenueSample:aVenue.sample},
          expectedGoals:{home:round(expHome),away:round(expAway)},reason,
          oddsSource:'Betfair Exchange',statsSource:'ESPN',fixtureId:`espn-${f.id}`,eventId:f.id,kickoff:f.date,
          league:f.league,leagueCode:f.leagueCode,priorityLeague:PRIORITY_CODES.includes(f.leagueCode),homeLogo:f.homeLogo||null,awayLogo:f.awayLogo||null,
          riskTier:o.odd<=1.8?'sicura':o.odd<=2.6?'equilibrata':'value',
          _homeMatches:hm,_awayMatches:am,
          fieldAnalysis:{reason,confidence:round(blended),confidenceLabel:blended>=70?'Alta':blended>=55?'Media':'Bassa',warnings}
        });
      }
    }
    // Priorità ai migliori 8 campionati + coppe UEFA + nazionali: a parità circa di valore
    // atteso, un incontro "prioritario" passa avanti a uno del pool di riserva.
    scenarios.sort((a,b)=>(Number(b.priorityLeague)-Number(a.priorityLeague))||(Number(b.edge)-Number(a.edge))||(Number(b.prob)-Number(a.prob)));
    return {quoted,scenarios};
  }

  // Non prendo semplicemente le N proposte col miglior valore atteso assoluto: rischierebbe
  // di darti 5 quote tutte alte (o tutte basse). Bilancio un mix per fascia di rischio —
  // dentro ogni fascia scelgo comunque sempre le migliori per valore atteso.
  function diversifySelection(pool,target){
    if(pool.length<=target) return [...pool];
    const lowQ=Math.round(target*0.4), midQ=Math.round(target*0.4), highQ=target-lowQ-midQ;
    const byTier={sicura:pool.filter(c=>c.riskTier==='sicura'),equilibrata:pool.filter(c=>c.riskTier==='equilibrata'),value:pool.filter(c=>c.riskTier==='value')};
    const quotas={sicura:lowQ,equilibrata:midQ,value:highQ};
    const selected=[];
    for(const tier of ['sicura','equilibrata','value']){
      for(const c of byTier[tier].slice(0,quotas[tier])) selected.push(c);
    }
    // Se una fascia non aveva abbastanza candidati, riempio gli slot avanzati con i migliori
    // rimasti (di qualunque fascia), sempre in ordine di valore atteso.
    if(selected.length<target){
      for(const c of pool){
        if(selected.length>=target) break;
        if(selected.includes(c)) continue;
        selected.push(c);
      }
    }
    return selected.sort((a,b)=>(Number(b.priorityLeague)-Number(a.priorityLeague))||(Number(b.edge)-Number(a.edge)));
  }

  // Sempre 5 incontri quando i dati lo permettono, ma senza mai superare quota 4.00 e
  // restando sui mercati 1X2 / Over-Under 2.5-3.5. Prima si prova col pool "privilegiato"
  // (migliori 8 campionati + coppe UEFA + nazionali); solo se non basta si allarga a tutti
  // i campionati disponibili (pool di riserva), rifacendo lo stesso identico procedimento.
  const TARGET_PICKS=5;
  function pickCandidates(){
    const built=buildScenarios(MAX_ODDS);
    const uniqueByMatch=[]; const usedMatches=new Set();
    for(const s of built.scenarios){const key=normalizePair(s.home,s.away);if(usedMatches.has(key))continue;usedMatches.add(key);uniqueByMatch.push(s);}
    const candidates=diversifySelection(uniqueByMatch,TARGET_PICKS);
    if(candidates.length<TARGET_PICKS && built.scenarios.length>candidates.length){
      for(const s of built.scenarios){
        if(candidates.length>=TARGET_PICKS) break;
        if(candidates.includes(s)) continue;
        candidates.push({...s,alternateMarketNote:`Mercato alternativo sullo stesso incontro (${s.home} - ${s.away}): oggi non ci sono abbastanza partite distinte quotate nel pool selezionato.`});
      }
    }
    return {quoted:built.quoted,scenarios:built.scenarios,candidates};
  }

  let {quoted,scenarios,candidates}=pickCandidates();

  if(usingDefaultPool && candidates.length<TARGET_PICKS && FALLBACK_CODES.length){
    diagnostics.push({provider:'pool-expansion',reason:`Pool privilegiato insufficiente per ${TARGET_PICKS} proposte (${candidates.length} trovate): espando agli altri campionati disponibili.`});
    const extra=await fetchPool(FALLBACK_CODES);
    sourceResults=[...sourceResults,...extra];
    standingsByCode=new Map(sourceResults.map(x=>[x.code,x.standings]));
    const allCodes=[...tier1Codes,...FALLBACK_CODES];
    const assembled=assembleFixtures(sourceResults,allCodes);
    allFixtures=assembled.allFixtures; liveFixtures=assembled.liveFixtures; fixtures=assembled.fixtures;
    diagnostics.push({provider:'prematch-gate',pool:'esteso (tutti i campionati)',before:allFixtures.filter(f=>localDate(f.date)===date).length,remaining:fixtures.length});
    usedFallbackPool=true;
    ({quoted,scenarios,candidates}=pickCandidates());
  }

  if(!quoted.length){
    diagnostics.push({provider:'no-candidates-debug',reason:fixtures.length?'Nessuna quota BACK Betfair riconosciuta per le partite ESPN pre-match (anche allargando il tetto quota)':'Nessuna partita ESPN pre-match nel perimetro selezionato',espnPrematch:fixtures.length,betfairFixtureKeys:bf.fixtures.size});
    const data={date,fixtures:fixtures.length,analyzed:0,requests,requestBreakdown,candidates:[],liveFixtures,diagnostics,cached:false};
    RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+30_000,data});
    return res.status(200).json(data);
  }

  // Se le partite reali distinte con quota sono meno di TARGET_PICKS, non se ne inventano altre:
  // pickCandidates() ha già provato a completare con mercati alternativi sullo stesso incontro,
  // etichettati chiaramente (alternateMarketNote). Qui restano solo se davvero non bastano i dati.

  diagnostics.push({provider:'v157-model',scenarios:scenarios.length,returned:candidates.length,pool:usedFallbackPool?'esteso (tutti i campionati)':'privilegiato (top8+coppe+nazionali)',maxOdds:MAX_ODDS,markets:[...ALLOWED_MARKETS],riskMix:candidates.reduce((acc,c)=>{acc[c.riskTier]=(acc[c.riskTier]||0)+1;return acc;},{}),rule:`TOP ${TARGET_PICKS} diversificate per fascia di rischio (≈40% sicure ≤1.80, 40% equilibrate 1.80-2.60, 20% value 2.60-4.00), a parità di fascia per valore atteso (Poisson con forma casa/trasferta + H2H, blended con quota Betfair reale); pool esteso solo se il perimetro privilegiato non basta per ${TARGET_PICKS} proposte`});

  const disclaimer=`Le probabilità e il "valore atteso" sono stime statistiche basate su gol recenti, classifica e quote di mercato (max ${MAX_ODDS.toFixed(2)}, mercati 1X2 e Over/Under 2.5-3.5). Non sono garanzie di vincita: nessun modello può assicurare un esito. Se in una giornata non ci sono abbastanza partite reali quotate nel pool privilegiato o in quello esteso, il sistema non ne inventa: completa con mercati alternativi sugli stessi incontri o restituisce meno di ${TARGET_PICKS} proposte.`;
  const finalPicks=candidates.slice(0,TARGET_PICKS);
  await logModelPredictions(supaUrl,serviceKey,date,finalPicks);
  const data={date,fixtures:fixtures.length,analyzed:quoted.length,requests,requestBreakdown,candidates:candidates.slice(0,120),liveFixtures,diagnostics,disclaimer,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?120_000:600_000),data});
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json(data);
}

async function supaWrite(url,key,path,rows,extraHeaders={}){
  const r=await fetch(`${url}/rest/v1/${path}`,{
    method:'POST',
    headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal',...extraHeaders},
    body:JSON.stringify(rows)
  });
  if(!r.ok){const t=await r.text();throw new Error(`Supabase write ${r.status}: ${t.slice(0,300)}`);}
}

async function logModelPredictions(url,key,date,picks){
  if(!picks.length) return;
  const rows=picks.map(p=>({
    match_date:date,league_code:p.leagueCode||null,league:p.league||null,
    home:p.home,away:p.away,event_id:p.eventId?String(p.eventId):null,fixture_id:p.fixtureId||null,
    market:p.market,odds:Number.isFinite(p.odds)?p.odds:null,odds_cap_used:Number.isFinite(p.oddsCapUsed)?p.oddsCapUsed:null,
    prob_model:Number.isFinite(p.pStat)?p.pStat:null,prob_market:Number.isFinite(p.pMarket)?p.pMarket:null,
    prob_blended:Number.isFinite(p.pFair)?p.pFair:null,edge_percent:Number.isFinite(p.edge)?p.edge:null,
    model_sample:Number.isFinite(p.modelSample)?p.modelSample:null,kickoff:p.kickoff||null,settled:false,result:null
  }));
  try{
    await supaWrite(url,key,'model_predictions?on_conflict=match_date,home,away,market',rows);
  }catch(e){
    // Non deve mai bloccare la risposta principale: il tracking è "best effort".
    console.error('AI DEL PALLONE log model_predictions error',e?.message||e);
  }
}

async function espn(path){
  const base='https://site.api.espn.com';
  // User-Agent e header "da browser": alcune richieste con uno User-Agent palesemente
  // non-browser (es. un nome di app) vengono bloccate con 403 dal WAF di ESPN. Questi
  // endpoint non sono un'API ufficiale documentata, quindi ci comportiamo come farebbe
  // una normale richiesta da espn.com per ridurre il rischio di blocco.
  const headers={
    Accept:'application/json',
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept-Language':'en-US,en;q=0.9,it;q=0.8',
    Referer:'https://www.espn.com/',
    Origin:'https://www.espn.com'
  };
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch(base+path,{headers,cache:'no-store'});
      const text=await r.text();let body={};try{body=text?JSON.parse(text):{};}catch{body={};}
      if(r.ok)return body;
      if((r.status===429||r.status===403)&&attempt<2){await sleep(700*(attempt+1));continue;}
      return {...body,__error:`HTTP ${r.status}`};
    }catch(e){if(attempt===2)return{__error:e?.message||String(e)};await sleep(300*(attempt+1));}
  }
  return {__error:'ESPN non disponibile'};
}

// Riserva: ID lega di API-Football v3 (v3.football.api-sports.io) per i nostri code interni.
// Usata SOLO quando ESPN non risponde per quel campionato (vedi fetchPool in handler()) —
// mai come fonte primaria, per non tornare a dipendere da un piano/quota giornaliera.
// Attenzione: la stagione (season) qui è dedotta con una regola semplice (mese>=7 → anno
// corrente, altrimenti anno-1); per le nazionali, il cui ciclo di qualificazione può
// scavalcare più stagioni, potrebbe non essere sempre esatta.
const API_FOOTBALL_LEAGUE_IDS={
  SA:135, PL:39, PD:140, BL1:78, FL1:61, PPL:94, DED:88, BEL1:144,
  CL:2, EL:3, ECL:848,
  WCQ:32,  // World Cup - Qualification Europe
  NL:5,    // UEFA Nations League
  EURO:4,  // Euro Championship
  EUROQ:960 // Euro Championship - Qualification (meno certo: verificare in diagnostics)
};

function apiFootballSeason(dateIso){
  const d=new Date(`${dateIso}T12:00:00Z`);
  const y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
  return m>=7?y:y-1;
}

async function apiFootball(path,params){
  const key=process.env.API_FOOTBALL_KEY||'';
  if(!key) return {__error:'API_FOOTBALL_KEY non configurata',__skip:true};
  const qs=new URLSearchParams(params).toString();
  try{
    const r=await fetch(`https://v3.football.api-sports.io${path}?${qs}`,{
      headers:{'x-apisports-key':key,Accept:'application/json'},cache:'no-store'
    });
    const text=await r.text();let body={};try{body=text?JSON.parse(text):{};}catch{body={};}
    if(!r.ok) return {...body,__error:`HTTP ${r.status}`};
    // API-Football risponde 200 anche quando la quota giornaliera è esaurita: lo segnala
    // dentro "errors". Lo trattiamo come limite raggiunto, non come crash.
    const errs=body?.errors;
    const hasQuotaError=errs&&(Array.isArray(errs)?errs.length>0:Object.keys(errs).length>0);
    if(hasQuotaError) return {...body,__error:`API-Football: ${JSON.stringify(errs).slice(0,200)}`,__quotaLikely:true};
    return body;
  }catch(e){
    return {__error:e?.message||String(e)};
  }
}

function adaptApiFootballFixture(item,code,cfg){
  const home=item?.teams?.home, away=item?.teams?.away, fx=item?.fixture;
  if(!home?.name||!away?.name||!fx?.date) return null;
  const short=String(fx?.status?.short||'').toUpperCase();
  let status='SCHEDULED';
  if(['1H','2H','HT','ET','P','LIVE','BT'].includes(short))status='LIVE';
  else if(['FT','AET','PEN'].includes(short))status='FINISHED';
  return {
    id:`af-${fx.id}`,date:fx.date,status,
    home:home.name,away:away.name,
    homeId:home.id,awayId:away.id,
    homeLogo:home.logo||null,awayLogo:away.logo||null,
    score:{home:Number(item?.goals?.home),away:Number(item?.goals?.away)},
    league:item?.league?.name||cfg.name,leagueCode:code
  };
}

function parseApiFootballStandings(payload,code){
  const groups=payload?.response?.[0]?.league?.standings;
  const rows=Array.isArray(groups)?groups.flat():[];
  const total=rows.length;
  const map=new Map();
  for(const e of rows){
    const name=e?.team?.name; if(!name) continue;
    const form=String(e?.form||'').replace(/[^WDL]/gi,'').toUpperCase();
    map.set(teamKey(name),{
      teamId:e.team?.id,teamName:name,position:Number.isFinite(Number(e.rank))?Number(e.rank):null,
      totalTeams:total,points:Number.isFinite(Number(e.points))?Number(e.points):null,
      playedGames:Number.isFinite(Number(e?.all?.played))?Number(e.all.played):null,
      form,last3:form.slice(-3),form3Points:formPoints(form.slice(-3))
    });
  }
  return map;
}

// Prova la riserva API-Football per un singolo campionato quando ESPN non ha dato nulla
// di utilizzabile. Non blocca mai: se manca la chiave, se il campionato non è mappato,
// o se la chiamata fallisce (rete, quota esaurita), ritorna fixtures/standings vuoti e
// si continua semplicemente senza quel campionato per oggi.
// Se il piano API-Football in uso non copre la stagione corrente (o siamo a corto di
// chiamate/minuto), non ha senso ritentare per ogni singolo campionato nella stessa
// richiesta: dopo il primo errore di questo tipo, la riserva si disattiva per il resto
// di QUESTA richiesta (il flag arriva da fuori, non è globale: su un container "a caldo"
// riusato tra richieste diverse, un module-level flag resterebbe true per sempre).
async function tryApiFootballFallback(code,cfg,date,diagnostics,circuitBreaker){
  if(circuitBreaker.disabled) return {fixtures:[],standings:new Map()};
  const leagueId=API_FOOTBALL_LEAGUE_IDS[code];
  if(!leagueId) return {fixtures:[],standings:new Map()};
  const season=apiFootballSeason(date);
  const from=shiftDate(date,-21), to=shiftDate(date,7);
  const [fx,st]=await Promise.all([
    apiFootball('/fixtures',{league:leagueId,season,from,to}),
    apiFootball('/standings',{league:leagueId,season})
  ]);
  const skip=fx.__skip||st.__skip;
  const planOrRateIssue=[fx,st].some(r=>/plan|rateLimit/i.test(r?.__error||''));
  if(planOrRateIssue){
    circuitBreaker.disabled=true;
    if(!skip) diagnostics.push({provider:'api-football-fallback',note:'Disattivata per il resto di questa richiesta: piano non compatibile con la stagione corrente o limite chiamate/minuto raggiunto.'});
  }
  if(!skip) diagnostics.push({provider:'api-football-fallback',league:cfg.name,code,leagueId,season,fixtures:Array.isArray(fx?.response)?fx.response.length:0,standingsFound:!!st?.response?.[0],fixturesError:fx.__error||null,standingsError:st.__error||null,quotaLikely:Boolean(fx.__quotaLikely||st.__quotaLikely),role:'fallback quando ESPN non risponde'});
  const fixtures=(Array.isArray(fx?.response)?fx.response:[]).map(x=>adaptApiFootballFixture(x,code,cfg)).filter(Boolean);
  const standings=st?.response?.[0]?parseApiFootballStandings(st,code):new Map();
  return {fixtures,standings};
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

// Ultime 3 partite giocate ESATTAMENTE in quel ruolo (casa o trasferta): una squadra forte in
// casa ma debole fuori (o viceversa) va pesata sul ruolo che avrà nella prossima partita, non
// su una media generica. Se non ce ne sono abbastanza (poche gare stagionali, promozione, ecc.)
// si completa con le ultime generiche per non lavorare su un campione troppo piccolo.
function recentByVenue(fixtures,teamName,venue,date,genericFallback){
  const finished=fixtures.filter(f=>isFinishedStatus(f.status)&&localDate(f.date)<date).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const venueRows=finished.filter(f=>venue==='home'?teamSimilarity(f.home,teamName)>=.75:teamSimilarity(f.away,teamName)>=.75).slice(0,3).reverse();
  if(venueRows.length>=2) return {rows:venueRows,venueOnly:true,sample:venueRows.length};
  // campione troppo corto per il ruolo specifico: uso il generico già calcolato altrove
  return {rows:genericFallback,venueOnly:false,sample:venueRows.length};
}

// Ultimi precedenti diretti tra le due squadre (stesso campionato, fino a ~13 mesi indietro
// grazie alla finestra ESPN allargata). Il campione è quasi sempre piccolo (1-3 gare): lo si
// usa come piccola correzione, non come segnale principale.
function headToHead(fixtures,home,away,date,limit=3){
  const finished=fixtures.filter(f=>isFinishedStatus(f.status)&&localDate(f.date)<date).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const meetings=finished.filter(f=>(teamSimilarity(f.home,home)>=.75&&teamSimilarity(f.away,away)>=.75)||(teamSimilarity(f.home,away)>=.75&&teamSimilarity(f.away,home)>=.75)).slice(0,limit);
  if(!meetings.length) return {count:0,avgGoalDiff:0,record:'',meetings:[]};
  let wins=0,draws=0,losses=0,gdSum=0;
  const summary=[];
  for(const m of meetings){
    const homeWasHome=teamSimilarity(m.home,home)>=.75;
    const hg=homeWasHome?Number(m.score.home):Number(m.score.away);
    const ag=homeWasHome?Number(m.score.away):Number(m.score.home);
    if(!Number.isFinite(hg)||!Number.isFinite(ag))continue;
    gdSum+=(hg-ag);
    if(hg>ag)wins++;else if(hg===ag)draws++;else losses++;
    summary.push(`${localDate(m.date)}: ${m.home} ${m.score.home}-${m.score.away} ${m.away}`);
  }
  return {count:meetings.length,avgGoalDiff:gdSum/meetings.length,record:`${wins}V ${draws}N ${losses}P (dal punto di vista di ${home})`,meetings:summary};
}


function formPoints(s){return String(s||'').split('').reduce((n,x)=>n+(x==='W'?3:x==='D'?1:0),0);}
function pointsFromMatches(rows,name){let p=0;for(const m of rows){const hg=Number(m.score.home),ag=Number(m.score.away),isHome=teamSimilarity(m.home,name)>=.75,gf=isHome?hg:ag,ga=isHome?ag:hg;if(!Number.isFinite(gf)||!Number.isFinite(ga))continue;p+=gf>ga?3:gf===ga?1:0;}return rows.length?p:null;}
function standingStrength(s){const p=Number(s?.position),n=Number(s?.totalTeams);return Number.isFinite(p)&&Number.isFinite(n)&&n>1?clamp((n-p)/(n-1),0,1):.5;}

// --- Modello Poisson (gol fatti/subiti) + blending con probabilità di mercato ---
const LEAGUE_AVG_GOALS=1.35; // gol/squadra/partita, media plausibile per i campionati coperti
const HOME_ADV=1.12;
const MAX_GOALS_GRID=8;

function goalStats(rows,name){
  let gf=0,ga=0,n=0;
  for(const m of rows){
    const isHome=teamSimilarity(m.home,name)>=.75;
    const g=isHome?Number(m.score.home):Number(m.score.away);
    const c=isHome?Number(m.score.away):Number(m.score.home);
    if(!Number.isFinite(g)||!Number.isFinite(c))continue;
    gf+=g;ga+=c;n++;
  }
  return n?{gf:gf/n,ga:ga/n,n}:null;
}

function factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}
function poissonPMF(k,lambda){return Math.exp(-lambda)*Math.pow(lambda,k)/factorial(k);}

function expectedGoals(homeGS,awayGS,hs,as){
  const hAttack=homeGS?homeGS.gf/LEAGUE_AVG_GOALS:1, hDefense=homeGS?homeGS.ga/LEAGUE_AVG_GOALS:1;
  const aAttack=awayGS?awayGS.gf/LEAGUE_AVG_GOALS:1, aDefense=awayGS?awayGS.ga/LEAGUE_AVG_GOALS:1;
  let expHome=hAttack*aDefense*LEAGUE_AVG_GOALS*HOME_ADV;
  let expAway=aAttack*hDefense*LEAGUE_AVG_GOALS/HOME_ADV;
  // piccola correzione dalla classifica, utile soprattutto quando il campione di gol è corto
  const diff=standingStrength(hs)-standingStrength(as); // -1..1
  expHome*=(1+diff*0.15);
  expAway*=(1-diff*0.15);
  return {expHome:clamp(expHome,0.2,4.5),expAway:clamp(expAway,0.2,4.5)};
}

function matchProbabilities(expHome,expAway){
  let pHome=0,pDraw=0,pAway=0,over15=0,over25=0,over35=0,over45=0,btts=0;
  for(let hg=0;hg<=MAX_GOALS_GRID;hg++){
    for(let ag=0;ag<=MAX_GOALS_GRID;ag++){
      const p=poissonPMF(hg,expHome)*poissonPMF(ag,expAway);
      if(hg>ag)pHome+=p;else if(hg===ag)pDraw+=p;else pAway+=p;
      const total=hg+ag;
      if(total>1.5)over15+=p; if(total>2.5)over25+=p; if(total>3.5)over35+=p; if(total>4.5)over45+=p;
      if(hg>0&&ag>0)btts+=p;
    }
  }
  const sum1x2=pHome+pDraw+pAway||1; // normalizza la coda troncata oltre MAX_GOALS_GRID
  return {
    '1':pHome/sum1x2*100,'X':pDraw/sum1x2*100,'2':pAway/sum1x2*100,
    'Over 1.5':over15*100,'Under 1.5':(1-over15)*100,
    'Over 2.5':over25*100,'Under 2.5':(1-over25)*100,
    'Over 3.5':over35*100,'Under 3.5':(1-over35)*100,
    'Over 4.5':over45*100,'Under 4.5':(1-over45)*100,
    'Goal':btts*100,'No Goal':(1-btts)*100
  };
}
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
