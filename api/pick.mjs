async function handler(req, res) {
  const footballToken = process.env.FOOTBALL_DATA_TOKEN;
  const oddsKey = process.env.ODDS_API_KEY;
  const apiFootballKey = process.env.API_FOOTBALL_KEY;
  const u = new URL(req.url, "https://vercel.local");
  if (!oddsKey) return res.status(500).json({ error: "ODDS_API_KEY non configurata" });
  const supaUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata" });

  const date = u.searchParams.get("date");
  const rawLeagues = u.searchParams.get("leagues") || "";
  // Valore speciale usato dal menu: una sola chiamata al feed globale,
  // ma con filtro rigoroso sulle competizioni europee ammesse.
  const europeOnly = rawLeagues === "EUROPE";
  const requestedCodes = europeOnly ? [] : (rawLeagues
    ? rawLeagues.split(",").map(normalizeLeague).filter(Boolean).slice(0, 80)
    : []);
  const codes = requestedCodes.length ? requestedCodes : null;
  const market = u.searchParams.get("market") || "all";
  if (!date) return res.status(400).json({ error: "Data mancante" });

  const cacheKey = `${date}|${requestedCodes.join(",")}|${market}|source:betfair`;
  const cached = RESPONSE_CACHE.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  let requests = 0;
  const requestBreakdown = {
    oddsLeaguesCatalog: 0,
    oddsEventsDiscovery: 0,
    footballFixturesAndForm: 0,
    oddsLive: 0,
    oddsBatches: 0,
    apiFootballFixtures: 0,
    apiFootballInjuries: 0,
    apiFootballPredictions: 0
  };
  const diagnostics = [];
  const fixtures = [];

  // In modalita' "Tutti i campionati" non vogliamo il vero "tutto":
  // Odds-API.io copre migliaia di tornei, comprese molte serie minori e
  // competizioni regionali. Per AI DEL PALLONE teniamo invece un perimetro
  // editoriale stabile: massime serie europee + principali coppe UEFA,
  // massime serie sudamericane, MLS e J1 League.
  const preferredLeagueFilter = (event) => {
    const slug = String(event?.league?.slug || '').toLowerCase().replace(/_/g,'-');
    const name = String(event?.league?.name || '').toLowerCase();
    const text = `${slug} ${name}`;
    const excluded = /(women|woman|femmin|femen|femin|ladies|u17|u18|u19|u20|u21|u23|youth|reserve|reserves|junior|academy|amateur|regional|division-?2|division-?3|league-?two|league-?one|segunda|tercera|segunda-div|segunda-division|segunda-liga|primera-nacional|primera-b|primera-c|primera-nacional-b|national-league|championship|2\.\s*liga|3\.\s*liga|cup|copa|coppa|super-cup|supercup|friendly|friendlies|playoffs?)/i;
    if (excluded.test(text)) return false;

    // Coppe UEFA principali: le includiamo perche' sono tra le competizioni
    // europee piu' rilevanti, pur non essendo campionati nazionali.
    if (/(champions-league|uefa-champions|europa-league|uefa-europa|conference-league|uefa-conference)/i.test(text)) return true;

    // Europa: solo i principali campionati. Escludiamo le federazioni piu\u0300 piccole
    // (es. Macedonia del Nord, Azerbaigian, Armenia, Georgia, Malta, ecc.)
    // per evitare che il feed globale porti in TOP gare con copertura statistica debole.
    const europeTop = [
      /england.*premier-league|premier-league.*england/,
      /spain.*la-liga|la-liga.*spain|spain.*primera-division/,
      /italy.*serie-a|serie-a.*italy/,
      /germany.*bundesliga|bundesliga.*germany/,
      /france.*ligue-1|ligue-1.*france/,
      /portugal.*primeira-liga|primeira-liga.*portugal/,
      /netherlands.*eredivisie|eredivisie.*netherlands/,
      /belgium.*pro-league|belgium.*first-division|pro-league.*belgium/,
      /scotland.*premiership|scottish-premiership/,
      /austria.*bundesliga|bundesliga.*austria/,
      /switzerland.*super-league|super-league.*switzerland/,
      /turkey.*super-lig|super-lig.*turkey|turkey.*super-league/,
      /greece.*super-league|super-league.*greece/,
      /denmark.*superliga|superliga.*denmark/,
      /sweden.*allsvenskan|allsvenskan.*sweden/,
      /norway.*eliteserien|eliteserien.*norway/,
      /poland.*ekstraklasa|ekstraklasa.*poland/,
      /czech.*first-league|czech-republic.*first-league|czechia.*first-league/,
      /croatia.*hnl|hnl.*croatia/,
      /romania.*liga-1|liga-1.*romania/,
      /serbia.*super-liga|super-liga.*serbia/,
      /ukraine.*premier-league|premier-league.*ukraine/,
      /hungary.*nb-i|hungary.*nemzeti/,
      /slovakia.*super-liga|super-liga.*slovakia/
    ];
    if (europeTop.some(re => re.test(text))) return true;

    // Sudamerica: solo la massima serie nazionale.
    const southAmericaTop = [
      /brazil.*serie-a|serie-a.*brazil|brasil.*serie-a/,
      /argentina.*primera|argentina.*liga-profesional|argentina.*primera-division/,
      /colombia.*primera-a|colombia.*categoria-primera|primera-a.*colombia/,
      /chile.*primera-division|chile.*primera|primera-division.*chile/,
      /uruguay.*primera-division|uruguay.*primera/,
      /ecuador.*liga-pro|ecuador.*serie-a|liga-pro.*ecuador/,
      /peru.*liga-1|liga-1.*peru/
    ];
    if (southAmericaTop.some(re => re.test(text))) return true;

    // USA e Giappone: solo la massima serie indicata.
    if (/(usa|united-states|america).*mls|mls.*(usa|united-states|america)/i.test(text)) return true;
    if (/(japan|giappone).*j1|j1-league.*japan|j-league.*japan|japan.*j-league/i.test(text)) return true;

    return false;
  };

  // STEP 0: il catalogo serve solo quando l'utente ha scelto un torneo
  // specifico. Con "Tutti" usiamo il feed globale degli eventi e risparmiamo
  // una chiamata API inutile.
  let leaguesCatalog = [];
  if (codes) {
    const catalogResult = await getOddsLeaguesCatalog(oddsKey);
    leaguesCatalog = catalogResult.list || [];
    if (catalogResult.fetched) { requests++; requestBreakdown.oddsLeaguesCatalog++; }
  }

  // STEP 1: discover events. When the user leaves the selector on
  // "Tutti i campionati", use Odds-API.io's global football events feed: it
  // exposes events across the available football leagues, so we are no longer
  // limited to the old 9-league allow-list. This is one discovery request.
  // When a specific league is selected, keep the more precise league endpoint.
  let oddsEventResults = [];
  if (!codes) {
    const ev = await odds(`/v3/events?apiKey=${encodeURIComponent(oddsKey)}&sport=football&status=pending`);
    requests++; requestBreakdown.oddsEventsDiscovery++;
    const events = Array.isArray(ev) ? ev : [];
    const dated = events.filter(e => localDate(e.date) === date);
    const europeanMarkers = /(england|scotland|spain|italy|germany|france|portugal|netherlands|belgium|austria|switzerland|turkey|greece|denmark|sweden|norway|poland|czech|croatia|serbia|romania|ukraine|hungary|slovakia|champions-league|uefa-champions|europa-league|uefa-europa|conference-league|uefa-conference)/i;
    const isEuropeanEvent = e => {
      const slug=String(e?.league?.slug||'').toLowerCase().replace(/_/g,'-');
      const name=String(e?.league?.name||'').toLowerCase();
      return europeanMarkers.test(`${slug} ${name}`);
    };
    const relevant = dated.filter(preferredLeagueFilter).filter(e => !europeOnly || isEuropeanEvent(e));
    const rejected = dated.length - relevant.length;
    diagnostics.push({ provider:"odds-api-events-global", results:relevant.length, totalReturned:events.length, dated:dated.length, rejectedByLeagueFilter:rejected, scope:europeOnly?"Europe top divisions + UEFA only":"principali campionati europei + UEFA + Brasile/Argentina/Colombia/Cile/Uruguay/Ecuador/Peru + MLS/J1", europeOnly, error:ev?.error||null });
    oddsEventResults = [{ code:null, slug:null, events, relevant, error:ev?.error||null }];
  } else {
    oddsEventResults = await Promise.all(codes.map(async code => {
      const staticGuess = oddsLeagueSlug(code);
      const slug = resolveLeagueSlug(code, staticGuess, leaguesCatalog, diagnostics);
      if (!slug) { diagnostics.push({ provider:"odds-api-events", league:code, results:0, error:"Slug campionato non trovato (né statico né nel catalogo)" }); return { code, slug:null, events:[] }; }
      const ev = await odds(`/v3/events?apiKey=${encodeURIComponent(oddsKey)}&sport=football&league=${encodeURIComponent(slug)}&status=pending`);
      requests++; requestBreakdown.oddsEventsDiscovery++;
      const events = Array.isArray(ev) ? ev : [];
      const relevant = events.filter(e => localDate(e.date) === date);
      diagnostics.push({ provider:"odds-api-events", league:code, results:relevant.length, error:ev?.error||null });
      return { code, slug, events, relevant, error:ev?.error||null };
    }));
  }

  const activeCodes = new Set();
  const oddsByPair = new Map();
  for (const { code, slug, relevant=[] } of oddsEventResults) {
    if (relevant.length && code) activeCodes.add(code);
    for (const e of relevant) {
      const inferredCode = code || inferFootballDataCode(e);
      if (inferredCode) activeCodes.add(inferredCode);
      oddsByPair.set(normalizePair(e.home, e.away), { ...e, _code:inferredCode || e.league?.slug || "OTHER", _slug:e.league?.slug || slug || null });
      fixtures.push({
        id:`odds-${e.id}`, _oddsEventId:e.id, _code:inferredCode || e.league?.slug || "OTHER", _source:"odds-api",
        homeTeam:{name:e.home}, awayTeam:{name:e.away}, utcDate:e.date,
        competition:{name:e.league?.name||e.league?.slug||"Football"}
      });
    }
  }

  // BETFAIR: le quote usate dal modello arrivano esclusivamente dall'Exchange.
  // Odds-API viene usato solo per scoprire le partite; NON fornisce più la quota
  // usata per Probabilità, Edge, TOP o Pick.
  const betfairSnapshot = await loadBetfairSnapshot(supaUrl, serviceKey);
  diagnostics.push({
    provider:"betfair-exchange",
    catalogueMarkets:betfairSnapshot.catalogueMarkets,
    bookMarkets:betfairSnapshot.bookMarkets,
    matchedFixtures:betfairSnapshot.fixtures.size,
    error:betfairSnapshot.error||null
  });

  // STEP 2: football-data.org is now queried ONLY for competitions that
  // actually have a pending fixture on the selected date. This is the key
  // reduction: no historical/form request for empty competitions.
  const recentByTeam = new Map();
  const h2hByPair = new Map();
  const teamCrests = new Map();
  const standingsByTeam = new Map();
  // Budget server-side: con "Tutti" il feed globale puo' contenere molte
  // competizioni. Interrogare football-data.org per ogni codice fa esplodere
  // il numero di chiamate e puo' portare Vercel a terminare la Function.
  // Limitiamo quindi lo storico alle competizioni piu' rilevanti presenti
  // davvero nel giorno richiesto. Con un campionato selezionato usiamo invece
  // il codice richiesto senza questo limite editoriale.
  let fdCodes = [];
  if (footballToken) {
    if (codes) {
      fdCodes = [...activeCodes].filter(code => normalizeLeague(code));
    } else {
      const fdPriority = new Map();
      for (const { relevant=[] } of oddsEventResults) {
        for (const e of relevant) {
          const code = inferFootballDataCode(e);
          if (!code) continue;
          const priority = leaguePriority(e?.league);
          fdPriority.set(code, Math.max(fdPriority.get(code) || -Infinity, priority));
        }
      }
      fdCodes = [...activeCodes]
        .filter(code => normalizeLeague(code))
        .sort((a,b) => (fdPriority.get(b) ?? 0) - (fdPriority.get(a) ?? 0))
        .slice(0, 6);
      diagnostics.push({provider:"football-data-budget",requestedCodes:activeCodes.size,usedCodes:fdCodes.length,maxCodes:6,reason:"limite storico per evitare timeout della Function con il feed globale"});
    }
  }
  if (!footballToken) diagnostics.push({provider:"football-data", results:0, error:"FOOTBALL_DATA_TOKEN non configurato: si continua comunque con Odds-API.io + API-Football."});
  const fdResults = await Promise.all(fdCodes.map(async code => {
    const from = daysAgo(date, 120);
    const [d, teamsData, standingsData] = await Promise.all([
      fd(`/v4/competitions/${encodeURIComponent(code)}/matches?dateFrom=${from}&dateTo=${date}&limit=500`, footballToken),
      fd(`/v4/competitions/${encodeURIComponent(code)}/teams`, footballToken),
      fd(`/v4/competitions/${encodeURIComponent(code)}/standings`, footballToken)
    ]);
    requests += 3; requestBreakdown.footballFixturesAndForm += 3;
    if (Array.isArray(teamsData?.teams)) {
      for (const t of teamsData.teams) { if (t?.id && t?.crest) teamCrests.set(t.id, t.crest); }
    }
    // La classifica esiste in forma di tabella semplice solo per i campionati
    // a girone unico (non per Champions/Coppe a gironi multipli o fasi a
    // eliminazione): se non troviamo una tabella "TOTAL", salto senza errori.
    const table = standingsData?.standings?.find(s => s.type === "TOTAL")?.table;
    if (Array.isArray(table)) {
      const totalTeams = table.length;
      for (const row of table) {
        if (!row?.team?.id) continue;
        standingsByTeam.set(row.team.id, { position: row.position, totalTeams, playedGames: row.playedGames, points: row.points });
      }
    }
    return { code, d };
  }));

  for (const { code, d } of fdResults) {
    const rows = Array.isArray(d.matches) ? d.matches : [];
    const todayRows = rows.filter(m => localDate(m.utcDate) === date);
    diagnostics.push({ provider:"football-data", league:code, results:todayRows.length, formRows:rows.length, error:d.error||null });
    for (const m of todayRows) {
      // Keep football-data IDs and names where possible so recent form can be
      // attached to the same fixture without another team-specific request.
      fixtures.push({ ...m, _code:code, _source:"football-data" });
    }
    for (const m of rows) {
      if (m.status !== "FINISHED") continue;
      for (const team of [m.homeTeam,m.awayTeam]) {
        if (!team?.id) continue;
        if (!recentByTeam.has(team.id)) recentByTeam.set(team.id, []);
        recentByTeam.get(team.id).push(m);
      }
      const hId=m.homeTeam?.id, aId=m.awayTeam?.id;
      if (hId && aId) {
        const key=h2hKey(hId,aId);
        if (!h2hByPair.has(key)) h2hByPair.set(key, []);
        h2hByPair.get(key).push(m);
      }
    }
  }
  for (const [id, rows] of recentByTeam) {
    rows.sort((a,b)=>new Date(a.utcDate)-new Date(b.utcDate));
    recentByTeam.set(id, rows.slice(-10));
  }
  for (const [key, rows] of h2hByPair) {
    rows.sort((a,b)=>new Date(a.utcDate)-new Date(b.utcDate));
    h2hByPair.set(key, rows.slice(-5)); // ultimi 5 scontri diretti bastano
  }

  // STEP 3: use football-data status to identify live games. This removes
  // the old separate live endpoint call in the normal case.
  const liveFixtures = [];
  for (const { code, d } of fdResults) {
    const rows = Array.isArray(d.matches) ? d.matches : [];
    for (const m of rows.filter(m => localDate(m.utcDate) === date)) {
      if (["LIVE","IN_PLAY","PAUSED","SUSPENDED","INTERRUPTED"].includes(String(m.status||""))) {
        liveFixtures.push({
          id:`live-${m.id}`, eventId:m.id, home:m.homeTeam?.name||"", away:m.awayTeam?.name||"",
          date:m.utcDate, league:m.competition?.name||code, status:"live",
          score:m.score||null
        });
      }
    }
  }
  const uniqueLive=[...new Map(liveFixtures.map(f=>[normalizePair(f.home,f.away),f])).values()];

  // De-duplicate fixtures and prefer football-data when it also knows the
  // same fixture, because it supplies team IDs for local statistics.
  const uniqueMap=new Map();
  for(const f of fixtures){
    const key=`${normalizePair(f.homeTeam?.name||f.homeTeam?.shortName,f.awayTeam?.name||f.awayTeam?.shortName)}|${localDate(f.utcDate)}`;
    if(!uniqueMap.has(key)||f._source==="football-data") uniqueMap.set(key,f);
  }
  const unique=[...uniqueMap.values()];
  const livePairs=new Set(uniqueLive.map(x=>normalizePair(x.home,x.away)));

  const candidates=[];
  const analyzedFixtureIds=new Set();
  const eligiblePool = unique.map(f=>{
    const home=f.homeTeam?.name||f.homeTeam?.shortName;
    const away=f.awayTeam?.name||f.awayTeam?.shortName;
    const event=home&&away ? oddsByPair.get(normalizePair(home,away)) : null;
    const betfair=findBestBetfairFixture(home,away,betfairSnapshot.fixtures);
    return {f,home,away,event,betfair};
  }).filter(x=>x.home&&x.away&&x.event&&x.betfair&&!livePairs.has(normalizePair(x.home,x.away)));

  // In modalita' "Tutti i campionati selezionati" non prendiamo piu'
  // semplicemente i primi 30 eventi restituiti dal provider: l'ordine del feed
  // puo' favorire tornei secondari. Prima ordiniamo per priorita' editoriale
  // e poi garantiamo una minima diversificazione (max 2 partite per lega nella
  // prima passata), cosi' Serie A/Premier/Liga/Bundesliga/Ligue 1 e coppe UEFA
  // hanno precedenza senza monopolizzare tutte le chiamate odds.
  let eligible = eligiblePool;
  if (!codes) {
    const ranked = eligiblePool
      .map(x => ({...x, _priority: leaguePriority(x.event?.league)}))
      .sort((a,b) => b._priority - a._priority || new Date(a.f.utcDate||a.event?.date) - new Date(b.f.utcDate||b.event?.date));
    const selected = [];
    const counts = new Map();
    // Prima passata: massimo 2 eventi per lega, rispettando la priorita'.
    for (const x of ranked) {
      const key = String(x.event?.league?.slug || x.event?.league?.name || 'other').toLowerCase();
      const count = counts.get(key) || 0;
      if (count >= 3) continue;
      selected.push(x);
      counts.set(key, count + 1);
      if (selected.length >= 30) break;
    }
    // Seconda passata: se restano slot, riempi con i migliori eventi ancora
    // esclusi, sempre secondo la priorita' dei campionati.
    if (selected.length < 30) {
      const picked = new Set(selected.map(x => `${x.home}|${x.away}|${x.f.utcDate}`));
      for (const x of ranked) {
        const id = `${x.home}|${x.away}|${x.f.utcDate}`;
        if (picked.has(id)) continue;
        selected.push(x);
        picked.add(id);
        if (selected.length >= 30) break;
      }
    }
    eligible = selected;
    diagnostics.push({
      provider:"editorial-league-priority",
      pool:eligiblePool.length,
      selected:eligible.length,
      rule:"priorita' campionati + massimo 3 partite per lega nella prima passata",
      topLeagues:ranked.slice(0,10).map(x=>x.event?.league?.name||x.event?.league?.slug).filter(Boolean)
    });
  } else {
    eligible = eligiblePool.slice(0,30);
  }

  for(const {f,home,away,event,betfair} of eligible){
    const homeStats=f.homeTeam?.id?{teamId:f.homeTeam.id,teamName:home,matches:recentByTeam.get(f.homeTeam.id)||[]}:null;
    const awayStats=f.awayTeam?.id?{teamId:f.awayTeam.id,teamName:away,matches:recentByTeam.get(f.awayTeam.id)||[]}:null;
    const h2hMatches=(f.homeTeam?.id&&f.awayTeam?.id)?(h2hByPair.get(h2hKey(f.homeTeam.id,f.awayTeam.id))||[]):[];
    const homeStanding=f.homeTeam?.id?standingsByTeam.get(f.homeTeam.id)||null:null;
    const awayStanding=f.awayTeam?.id?standingsByTeam.get(f.awayTeam.id)||null:null;
    // try/catch difensivo: un errore sull'analisi di UNA partita non deve
    // far fallire l'intera risposta API (le altre partite restano valide).
    try {
      const extracted=extractBetfairOdds(betfair,market,home,away);
      const markets=buildMarkets(extracted,homeStats,awayStats,h2hMatches,f.homeTeam?.id,f.awayTeam?.id,homeStanding,awayStanding);
      diagnostics.push({provider:"betfair-analysis",league:f._code,fixture:`${home} - ${away}`,oddsMarkets:extracted.map(x=>x.value),analyzedMarkets:markets.length,bookmaker:"Betfair Exchange",marketIds:betfair.map(x=>x.marketId)});
      if(markets.length) analyzedFixtureIds.add(f.id);
      for(const m of markets) candidates.push({...m,home,away,homeLogo:teamCrests.get(f.homeTeam?.id)||f.homeTeam?.crest||null,awayLogo:teamCrests.get(f.awayTeam?.id)||f.awayTeam?.crest||null,league:f.competition?.name||f._code,leagueCode:f._code,fixtureId:f.id,eventId:event.id,kickoff:f.utcDate||event.date,oddsSource:"Betfair Exchange",statsSource:(homeStats?.matches?.length||awayStats?.matches?.length)?"football-data.org":"odds-only",_homeMatches:homeStats?.matches||[],_awayMatches:awayStats?.matches||[],_homeTeamId:homeStats?.teamId,_awayTeamId:awayStats?.teamId});
    } catch (e) {
      diagnostics.push({provider:"betfair-analysis",league:f._code,fixture:`${home} - ${away}`,oddsMarkets:[],analyzedMarkets:0,error:`Errore interno analisi Betfair: ${e?.message||String(e)}`});
    }
  }

  // STEP 4: enrich ONLY the strongest candidate fixtures with API-Football
  // availability data. One date lookup + one injuries call per unique top
  // fixture keeps the free 100 requests/day quota under control.
  const enriched = await enrichTopCandidates(candidates, date, apiFootballKey, requestBreakdown, diagnostics);
  requests += enriched.requests;
  const data={date,fixtures:unique.length,analyzed:analyzedFixtureIds.size,requests,requestBreakdown,candidates:enriched.candidates,liveFixtures:uniqueLive,diagnostics,cached:false};
  RESPONSE_CACHE.set(cacheKey,{expires:Date.now()+(date===localTodayRome()?30_000:90_000),data});
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(data);
}

const RESPONSE_CACHE = new Map();

function daysAgo(date, days) {
  const d = new Date(`${date}T12:00:00+02:00`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0,10);
}

function localTodayRome() {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Rome", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}

function h2hKey(idA, idB) {
  return [idA, idB].sort((x,y)=>String(x).localeCompare(String(y))).join("-");
}

function inferFootballDataCode(event) {
  const slug = String(event?.league?.slug || "").toLowerCase();
  const name = String(event?.league?.name || "").toLowerCase();
  const s = `${slug} ${name}`;
  if (/italy.*serie-a|serie a/.test(s)) return "SA";
  if (/england.*premier|premier league/.test(s)) return "PL";
  if (/spain.*la-liga|la liga/.test(s)) return "PD";
  if (/germany.*bundesliga/.test(s) && !/2\.?\s*bundesliga/.test(s)) return "BL1";
  if (/france.*ligue-1|ligue 1/.test(s)) return "FL1";
  if (/uefa.*champions|champions league/.test(s) && !/women/.test(s)) return "CL";
  if (/england.*championship|championship/.test(s) && !/scotland/.test(s)) return "ELC";
  if (/netherlands.*eredivisie|eredivisie/.test(s)) return "DED";
  if (/portugal.*primeira|primeira liga|liga portugal/.test(s)) return "PPL";
  return null;
}

function normalizeLeague(x) {
  const s = String(x || "").trim().toUpperCase();
  const map = { "135":"SA", "39":"PL", "140":"PD", "78":"BL1", "61":"FL1", "2":"CL", "88":"DED", "94":"PPL" };
  const allowed = [
    "SA","PL","PD","BL1","FL1","PPL","DED","BEL1","SCO1","AUT1","SUI1","TUR1","GRE1","DEN1","SWE1","NOR1","POL1","CZE1","CRO1","SRB1","ROU1","UKR1","HUN1","SVK1",
    "CL","EL","ECL","BRA1","ARG1","COL1","CHI1","URU1","ECU1","PER1","MLS1","JPN1"
  ];
  return map[s] || (allowed.includes(s) ? s : null);
}

function localDate(iso) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(iso));
  } catch { return String(iso || "").slice(0, 10); }
}

function leaguePriority(league) {
  const slug = String(league?.slug || '').toLowerCase().replace(/_/g,'-');
  const name = String(league?.name || '').toLowerCase();
  const text = `${slug} ${name}`;

  // Fascia 1: competizioni europee/nazionali che devono comparire per prime.
  if (/champions-league|uefa-champions/.test(text)) return 1000;
  if (/europa-league|uefa-europa/.test(text)) return 980;
  if (/conference-league|uefa-conference/.test(text)) return 960;
  if (/italy.*serie-a|serie-a.*italy|serie a/.test(text)) return 950;
  if (/england.*premier-league|premier-league.*england|premier league/.test(text)) return 940;
  if (/spain.*la-liga|la-liga.*spain|la liga/.test(text)) return 930;
  if (/germany.*bundesliga|bundesliga.*germany|bundesliga/.test(text) && !/2\.?\s*bundesliga/.test(text)) return 920;
  if (/france.*ligue-1|ligue-1.*france|ligue 1/.test(text)) return 910;

  // Fascia 2: altre massime serie europee.
  const europe = [
    [/portugal.*primeira|primeira liga|liga portugal/,900],
    [/netherlands.*eredivisie|eredivisie/,890],
    [/belgium.*pro-league|pro league.*belgium/,880],
    [/scotland.*premiership|scottish-premiership/,870],
    [/turkey.*super-lig|super-lig.*turkey/,860],
    [/austria.*bundesliga|bundesliga.*austria/,850],
    [/switzerland.*super-league|super-league.*switzerland/,840],
    [/greece.*super-league|super-league.*greece/,830],
    [/denmark.*superliga|superliga.*denmark/,820],
    [/poland.*ekstraklasa|ekstraklasa.*poland/,810],
    [/czech.*first-league|czechia.*first-league/,800],
    [/sweden.*allsvenskan|allsvenskan.*sweden/,790],
    [/norway.*eliteserien|eliteserien.*norway/,780],
    [/romania.*liga-1|liga-1.*romania/,770],
    [/croatia.*hnl|hnl.*croatia/,760],
    [/serbia.*super-liga|super-liga.*serbia/,750],
    [/ukraine.*premier-league|premier-league.*ukraine/,740],
    [/hungary.*nb-i|hungary.*nemzeti/,730],
  ];
  for (const [re, score] of europe) if (re.test(text)) return score;

  // Fascia 3: massime serie sudamericane, poi MLS e J1.
  const southAmerica = [
    [/brazil.*serie-a|serie-a.*brazil|brasil.*serie-a/,500],
    [/argentina.*primera|argentina.*liga-profesional|argentina.*primera-division/,490],
    [/colombia.*primera-a|colombia.*categoria-primera|primera-a.*colombia/,480],
    [/chile.*primera-division|chile.*primera|primera-division.*chile/,470],
    [/uruguay.*primera-division|uruguay.*primera/,460],
    [/ecuador.*liga-pro|ecuador.*serie-a|liga-pro.*ecuador/,450],
  ];
  for (const [re, score] of southAmerica) if (re.test(text)) return score;
  if (/(usa|united-states|america).*mls|mls.*(usa|united-states|america)/.test(text)) return 390;
  if (/(japan|giappone).*j1|j1-league.*japan|j-league.*japan|japan.*j-league/.test(text)) return 380;

  return 100;
}

async function fd(path, token) {
  try {
    const r = await fetch("https://api.football-data.org" + path, {
      headers: { "X-Auth-Token": token, "Accept": "application/json" }
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 500) }; }
    if (!r.ok) return { error: body.message || body.error || `HTTP ${r.status}` };
    return body;
  } catch (e) { return { error: e?.message || String(e) }; }
}

async function resolveLogoFromSportsDB(team) {
  const q = String(team || '').trim();
  if (!q) return null;
  try {
    const url = 'https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const body = await r.json();
    const rows = Array.isArray(body?.teams) ? body.teams : [];
    const target = normalize(q);
    const scoreName = (name) => {
      const n = normalize(name);
      if (!n || !target) return 0;
      if (n === target) return 100;
      if (n.includes(target) || target.includes(n)) return 85;
      const a = new Set(n.split(' ')), b = target.split(' ');
      return 45 + b.filter(x => a.has(x)).length * 12;
    };
    rows.sort((a,b) => scoreName(b?.strTeam) - scoreName(a?.strTeam));
    const t = rows[0];
    return t?.strBadge ? { logo:t.strBadge, source:'thesportsdb', resolvedName:t.strTeam || null, teamId:t.idTeam || null } : null;
  } catch {
    return null;
  }
}

async function enrichMissingCandidateLogos(rows, diagnostics) {
  const out = [...rows];
  const seenTeams = new Set();
  const jobs = [];
  for (const c of out) {
    for (const role of ['home','away']) {
      const current = role === 'home' ? c.homeLogo : c.awayLogo;
      const team = role === 'home' ? c.home : c.away;
      const key = normalize(team);
      if (current || !key || seenTeams.has(key) || jobs.length >= 8) continue;
      seenTeams.add(key);
      jobs.push({ c, role, team });
    }
    if (jobs.length >= 8) break;
  }
  if (!jobs.length) return out;
  const resolved = await Promise.all(jobs.map(async job => ({...job, result:await resolveLogoFromSportsDB(job.team)})));
  const byTeam = new Map(resolved.filter(x=>x.result?.logo).map(x=>[normalize(x.team),x.result]));
  return out.map(c => ({
    ...c,
    homeLogo: c.homeLogo || byTeam.get(normalize(c.home))?.logo || null,
    awayLogo: c.awayLogo || byTeam.get(normalize(c.away))?.logo || null
  }));
}

async function enrichTopCandidates(candidates, date, apiKey, breakdown, diagnostics) {
  if (!candidates.length) return { candidates, requests: 0 };
  let requests = 0;
  const fixtureMap = new Map();
  const fixtureLogos = new Map();
  const availability = new Map();
  const predictions = new Map();

  if (!apiKey) {
    diagnostics.push({ provider:"api-football-fixtures", results:0, error:"API_FOOTBALL_KEY non configurata su Vercel: assenze/infortuni e lettura tattica avanzata non disponibili. Le motivazioni usano comunque lo storico gol/forma quando c'è." });
  } else {
  const uniqueFixtures = [];
  const seen = new Set();
  for (const c of [...candidates].sort((a,b)=>b.score-a.score)) {
    const key = normalizePair(c.home, c.away);
    if (!seen.has(key)) { seen.add(key); uniqueFixtures.push(c); }
    if (uniqueFixtures.length >= 6) break;
  }
  try {
    const fx = await apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=Europe%2FRome`, apiKey);
    requests++; breakdown.apiFootballFixtures++; 
    if (Array.isArray(fx?.response)) {
      for (const f of fx.response) {
        const home=f?.teams?.home?.name, away=f?.teams?.away?.name;
        if (home && away) fixtureMap.set(normalizePair(home,away), f);
      }
    }
    diagnostics.push({provider:"api-football-fixtures",results:fixtureMap.size,error:fx?.errors||null});
  } catch(e) {
    diagnostics.push({provider:"api-football-fixtures",results:0,error:e?.message||String(e)});
  }

  for (const [key, f] of fixtureMap) {
    fixtureLogos.set(key, {homeLogo:f?.teams?.home?.logo||null, awayLogo:f?.teams?.away?.logo||null});
  }

  // V15: nessuna chiamata /leagues preventiva.
  // Proviamo direttamente /injuries e /predictions sul fixture trovato.
  // In questo modo un problema di coverage non può bloccare la Function.

  for (const c of uniqueFixtures) {
    const af = findBestApiFootballFixture(c, fixtureMap);
    if (!af?.fixture?.id) {
      diagnostics.push({provider:"api-football-injuries",fixture:`${c.home} - ${c.away}`,results:0,error:"Partita non trovata nell'elenco fixture di API-Football per questa data (nome squadra diverso, competizione non tracciata dalla loro fixture list, o fuso orario)."});
      continue;
    }
    const covKey = af.league?.id && af.league?.season ? `${af.league.id}-${af.league.season}` : null;
    // Nessuna chiamata /leagues preventiva: proviamo direttamente /injuries.
    // Le due letture sono indipendenti: farle in parallelo riduce molto il
    // tempo della Function senza aumentare il numero di richieste.
    const [injuryResult, predictionResult] = await Promise.allSettled([
      apiFootball(`/injuries?fixture=${encodeURIComponent(af.fixture.id)}`, apiKey),
      apiFootball(`/predictions?fixture=${encodeURIComponent(af.fixture.id)}`, apiKey)
    ]);
    requests += 2;
    breakdown.apiFootballInjuries++;
    breakdown.apiFootballPredictions++;
    if (injuryResult.status === "fulfilled") {
      const d = injuryResult.value;
      const rows = Array.isArray(d?.response) ? d.response : [];
      availability.set(normalizePair(c.home,c.away), summarizeAvailability(rows, c.home, c.away));
      diagnostics.push({provider:"api-football-injuries",fixture:`${c.home} - ${c.away}`,fixtureId:af.fixture.id,results:rows.length,error:d?.errors||null});
    } else {
      diagnostics.push({provider:"api-football-injuries",fixture:`${c.home} - ${c.away}`,results:0,error:injuryResult.reason?.message||String(injuryResult.reason)});
    }
    if (predictionResult.status === "fulfilled") {
      const d = predictionResult.value;
      const pred = Array.isArray(d?.response) ? d.response[0]?.predictions : null;
      if (pred) predictions.set(normalizePair(c.home,c.away), pred);
      diagnostics.push({provider:"api-football-predictions",fixture:`${c.home} - ${c.away}`,fixtureId:af.fixture.id,results:pred?1:0,error:d?.errors||null});
    } else {
      diagnostics.push({provider:"api-football-predictions",fixture:`${c.home} - ${c.away}`,results:0,error:predictionResult.reason?.message||String(predictionResult.reason)});
    }
  }
  }

  // V14: modello locale ELO + Monte Carlo. Nessuna chiamata API aggiuntiva.
  const mcByPair = new Map();
  const uniqueForMc = []; const seenMc = new Set();
  for (const c of [...candidates].sort((a,b)=>(b.score||0)-(a.score||0))) {
    const key=normalizePair(c.home,c.away);
    if(seenMc.has(key)) continue;
    seenMc.add(key); uniqueForMc.push(c);
    if(uniqueForMc.length>=12) break;
  }
  for (const c of uniqueForMc) {
    try { mcByPair.set(normalizePair(c.home,c.away), monteCarloFixture(c, availability.get(normalizePair(c.home,c.away)), predictions.get(normalizePair(c.home,c.away)), 10000)); }
    catch(e) { diagnostics.push({provider:"local-monte-carlo",fixture:`${c.home} - ${c.away}`,results:0,error:e?.message||String(e)}); }
  }

  // Questo map gira SEMPRE, con o senza chiave API-Football: garantisce che
  // ogni candidato abbia sempre una motivazione e un punteggio di fiducia
  // validi (mai "-/100"), usando l'arricchimento quando c'è ed eventualmente
  // degradando allo storico gol/forma quando non c'è.
  let out = candidates.map(c => {
    const key = normalizePair(c.home,c.away);
    const av = availability.get(key);
    const pred = predictions.get(key) || null;
    const scored = applyEnrichedScore({...c, monteCarlo:mcByPair.get(key)||null}, av, pred);
    const field = buildFieldAnalysis({...scored, availability:av, prediction:pred}, av, pred);
    const logos = fixtureLogos.get(key) || {};
    return {...scored, homeLogo:logos.homeLogo||c.homeLogo||null, awayLogo:logos.awayLogo||c.awayLogo||null, availability:av||null, prediction:pred||null, reason:field.reason, fieldAnalysis:field};
  });

  // I loghi mancanti vengono risolti qui, lato server, e non dal browser.
  // Limitiamo il recupero ai primi 8 stemmi mancanti per evitare raffiche di richieste.
  const missingBefore = out.reduce((n,c)=>n + (!c.homeLogo?1:0) + (!c.awayLogo?1:0),0);
  if (missingBefore) {
    out = await enrichMissingCandidateLogos(out, diagnostics);
    const missingAfter = out.reduce((n,c)=>n + (!c.homeLogo?1:0) + (!c.awayLogo?1:0),0);
    diagnostics.push({provider:'thesportsdb-logos',requested:Math.min(8,missingBefore),resolved:missingBefore-missingAfter,error:null});
  }
  return {candidates:out, requests};
}

async function apiFootball(path, key) {
  const r = await fetch("https://v3.football.api-sports.io" + path, {
    headers: { "x-apisports-key": key, "Accept":"application/json" }
  });
  const text = await r.text();
  let body; try { body=JSON.parse(text); } catch { body={errors:{message:text.slice(0,500)}}; }
  if (!r.ok) return { ...body, errors: body.errors || {message:`HTTP ${r.status}`} };
  return body;
}


function teamMatchKey(s) {
  return normalize(s)
    .replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|de|the)\b/g, " ")
    .replace(/\b(1st|first|ii|ii)\b/g, " ")
    .replace(/\d{2,4}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamSimilarity(a,b) {
  const aa=teamMatchKey(a), bb=teamMatchKey(b);
  if (!aa || !bb) return 0;
  if (aa===bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.94;
  const A=new Set(aa.split(" ").filter(x=>x.length>2));
  const B=new Set(bb.split(" ").filter(x=>x.length>2));
  if (!A.size || !B.size) return 0;
  let common=0; for (const x of A) if (B.has(x)) common++;
  const jaccard=common/(A.size+B.size-common);
  const containment=common/Math.min(A.size,B.size);
  return Math.max(jaccard, containment*0.92);
}

function findBestApiFootballFixture(candidate, fixtureMap) {
  const exact=fixtureMap.get(normalizePair(candidate.home,candidate.away));
  if (exact) return exact;
  let best=null, bestScore=0;
  for (const f of fixtureMap.values()) {
    const h=f?.teams?.home?.name, a=f?.teams?.away?.name;
    if (!h || !a) continue;
    const hs=teamSimilarity(candidate.home,h), as=teamSimilarity(candidate.away,a);
    const score=(hs+as)/2;
    if (hs>=0.68 && as>=0.68 && score>bestScore) { best=f; bestScore=score; }
  }
  return best;
}

function summarizeAvailability(rows, homeName, awayName) {
  const out = {home:[],away:[],total:0,source:"api-football"};
  for (const x of rows) {
    const team=x?.team?.name||"";
    const player=x?.player?.name||"";
    const type=x?.type||"";
    const reason=x?.reason||"";
    if (!player) continue;
    const item={player,type,reason,status:availabilityStatus(type, reason)};
    if (normalizeTeam(team)===normalizeTeam(homeName)) out.home.push(item);
    else if (normalizeTeam(team)===normalizeTeam(awayName)) out.away.push(item);
  }
  out.total=out.home.length+out.away.length;
  return out;
}

function availabilityStatus(type, reason) {
  const t=String(type||"").toLowerCase();
  const r=String(reason||"").toLowerCase();
  if (t.includes("susp")) return "squalificato";
  if (t.includes("injur") || /injury|lesion|strain|fracture|muscle|ankle|knee|hamstring|thigh|back|illness|ill/.test(r)) return "infortunato";
  if (t.includes("question") || t.includes("doubt")) return "in dubbio";
  if (t.includes("missing") || t.includes("absent")) return "indisponibile";
  return reason ? String(reason).toLowerCase() : "indisponibile";
}

function normalizeTeam(s) { return clean(String(s||"")); }

// Normalizzazione leggibile dei nomi squadra usata dal resolver dei loghi.
// Deve essere distinta da clean(), che serve alle chiavi fixture.
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function warningsPenaltyCount(c) {
  // Penalità leggere per segnali di cautela già rilevati dal modello base.
  // Qui non ricalcoliamo le warning testuali per evitare dipendenze circolari.
  let n = 0;
  const m = String(c?.market || "");
  const h = Number(c?.homeForm), a = Number(c?.awayForm);
  if (Number.isFinite(h) && Number.isFinite(a) && Math.abs(h-a) < 0.35 && ["1 (Casa)","1","2 (Trasferta)","2"].includes(m)) n++;
  return n;
}


function seededRandom(seedObj) {
  seedObj.value = (Math.imul(1664525, seedObj.value) + 1013904223) >>> 0;
  return seedObj.value / 4294967296;
}
function poissonSample(lambda, rng) {
  if (!(lambda > 0)) return 0;
  const L=Math.exp(-Math.min(lambda,6));
  let k=0,p=1;
  do { k++; p*=rng(); } while (p>L && k<15);
  return k-1;
}
function buildEloContext(c) {
  const all=[...(Array.isArray(c?._homeMatches)?c._homeMatches:[]),...(Array.isArray(c?._awayMatches)?c._awayMatches:[])];
  const byId=new Map();
  for (const m of all) {
    const h=m?.homeTeam?.id,a=m?.awayTeam?.id,hg=m?.score?.fullTime?.home,ag=m?.score?.fullTime?.away;
    if(!h||!a||!Number.isFinite(hg)||!Number.isFinite(ag)) continue;
    if(!byId.has(h)) byId.set(h,1500); if(!byId.has(a)) byId.set(a,1500);
    const rh=byId.get(h), ra=byId.get(a), expected=1/(1+Math.pow(10,(ra-rh-55)/400));
    const actual=hg>ag?1:ag>hg?0:0.5, margin=Math.min(2,1+Math.log1p(Math.abs(hg-ag)));
    const k=22*margin;
    byId.set(h,rh+k*(actual-expected)); byId.set(a,ra+k*((1-actual)-(1-expected)));
  }
  const homeId=c?._homeTeamId, awayId=c?._awayTeamId;
  const homeElo=homeId&&byId.has(homeId)?byId.get(homeId):1500;
  const awayElo=awayId&&byId.has(awayId)?byId.get(awayId):1500;
  return {homeElo,awayElo,diff:homeElo-awayElo+55};
}
function monteCarloFixture(c,av,pred,iterations=10000) {
  const h=summarize(c?._homeMatches,c?._homeTeamId), a=summarize(c?._awayMatches,c?._awayTeamId);
  const baseH=avg(h.gfHome!=null?h.gfHome:h.gf,a.gaAway!=null?a.gaAway:a.ga);
  const baseA=avg(a.gfAway!=null?a.gfAway:a.gf,h.gaHome!=null?h.gaHome:h.ga);
  const elo=buildEloContext(c);
  let lambdaH=Number.isFinite(baseH)?baseH:1.35, lambdaA=Number.isFinite(baseA)?baseA:1.15;
  const eloShift=clamp(elo.diff/400,-0.35,0.35);
  lambdaH*=Math.exp(eloShift*0.22); lambdaA*=Math.exp(-eloShift*0.18);
  if(av?.home?.length) lambdaH*=Math.max(0.78,1-0.035*av.home.length);
  if(av?.away?.length) lambdaA*=Math.max(0.78,1-0.035*av.away.length);
  lambdaH=clamp(lambdaH,0.25,3.8); lambdaA=clamp(lambdaA,0.20,3.5);
  const seedBase=Math.abs(hashString(`${c.home}|${c.away}`))>>>0, rngState={value:seedBase||123456789};
  let hWin=0,draw=0,aWin=0,over25=0,over35=0,btts=0, total=0;
  for(let i=0;i<iterations;i++){
    const hg=poissonSample(lambdaH,()=>seededRandom(rngState));
    const ag=poissonSample(lambdaA,()=>seededRandom(rngState));
    const t=hg+ag; total+=t;
    if(hg>ag)hWin++; else if(hg===ag)draw++; else aWin++;
    if(t>=3)over25++; if(t>=4)over35++; if(hg>0&&ag>0)btts++;
  }
  return {iterations,historicalSample,quality:historicalSample>=8?"alta":historicalSample>=3?"media":"baseline",lambdaH,lambdaA,eloHome:round(elo.homeElo),eloAway:round(elo.awayElo),prob:{"1":hWin/iterations*100,"X":draw/iterations*100,"2":aWin/iterations*100,"Over 2.5":over25/iterations*100,"Under 2.5":(1-over25/iterations)*100,"Over 3.5":over35/iterations*100,"Under 3.5":(1-over35/iterations)*100,"Goal":btts/iterations*100,"No Goal":(1-btts/iterations)*100},expectedGoals:total/iterations};
}
function hashString(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

function applyEnrichedScore(c, av, pred) {
  // V2: separiamo la probabilita' del mercato dalla probabilita' del modello.
  // L'errore della versione precedente era lasciare c.prob quasi invariata
  // anche quando API-Football forniva una previsione indipendente: in pratica
  // il ranking continuava a seguire soprattutto la quota.
  const components = [];
  const marketProb = Number.isFinite(c.pFair) ? clamp(c.pFair, 0, 100) : null;
  const statProb = Number.isFinite(c.pStat) ? clamp(c.pStat, 0, 100) : null;
  const freqProb = Number.isFinite(c.pFreq) ? clamp(c.pFreq, 0, 100) : null;
  const predScore = predictionComponent(c.market, pred, c.home, c.away);
  const predictionProb = predScore != null ? clamp(predScore, 0, 100) : null;
  const mc = c.monteCarlo || null;
  const mcProb = mc?.prob?.[c.market] != null && Number(mc.historicalSample||0) >= 3 ? clamp(Number(mc.prob[c.market]),0,100) : null;

  // Costruiamo la probabilita' finale dando piu' spazio alle evidenze di gioco
  // quando esistono. Il mercato resta un prior importante, non il pilota unico.
  const sources = [];
  if (mcProb != null) sources.push([35, mcProb, "Monte Carlo + ELO"]);
  if (statProb != null) sources.push([30, statProb, "storico/modello gol"]);
  if (predictionProb != null) sources.push([20, predictionProb, "prediction API"]);
  if (freqProb != null) sources.push([5, freqProb, "frequenza storica"]);
  if (marketProb != null) sources.push([10, marketProb, "mercato"]);

  let modelProb;
  if (sources.length) {
    const w = sources.reduce((a, x) => a + x[0], 0);
    modelProb = sources.reduce((a, x) => a + x[0] * x[1], 0) / w;
  } else {
    modelProb = Number.isFinite(c.prob) ? c.prob : 50;
  }

  // Se modello storico e prediction API divergono molto, riduciamo
  // l'overconfidence invece di scegliere arbitrariamente una delle due fonti.
  const agreementValues = [statProb, predictionProb].filter(v => v != null);
  const disagreement = agreementValues.length === 2 ? Math.abs(agreementValues[0] - agreementValues[1]) : 0;
  if (disagreement >= 25) modelProb = modelProb * 0.80 + 50 * 0.20;
  else if (disagreement >= 15) modelProb = modelProb * 0.90 + 50 * 0.10;
  modelProb = clamp(modelProb, 5, 95);

  const probabilityScore = modelProb;
  components.push([45, probabilityScore, "probabilità modello"]);
  if (statProb != null) components.push([15, statProb, "statistiche"]);
  if (freqProb != null) components.push([8, freqProb, "frequenza"]);

  const formRaw = Number.isFinite(c.form) ? c.form : null;
  if (formRaw != null) components.push([8, clamp(50 + formRaw * 5, 0, 100), "forma"]);

  const edge = Number.isFinite(c.edge) ? c.edge : (modelProb - (100 / Number(c.odds)));
  // Il valore si ricalcola sulla probabilita' aggiornata, ma resta secondario.
  const valueScore = clamp(50 + 50 * Math.tanh(edge / 20), 0, 100);
  components.push([8, valueScore, "quota"]);

  const homeAdv = Number.isFinite(c.homeForm) ? c.homeForm : null;
  const awayAdv = Number.isFinite(c.awayForm) ? c.awayForm : null;
  const venueScore = venueComponent(c.market, homeAdv, awayAdv);
  const oneXTwoMatchup = oneXTwoFieldComponent(c);
  if (oneXTwoMatchup != null) components.push([8, oneXTwoMatchup, "confronto 1X2"]);
  else if (venueScore != null) components.push([5, venueScore, "casa/trasferta"]);

  const absenceScore = absenceComponent(c.market, c.home, c.away, av);
  if (absenceScore != null) components.push([5, absenceScore, "assenze"]);
  if (predictionProb != null) components.push([12, predictionProb, "prediction"]);

  const totalWeight = components.reduce((s,x)=>s+x[0],0) || 1;
  const weighted = components.reduce((s,x)=>s + x[0] * x[1],0) / totalWeight;

  // Supporto analitico: non conta quante API abbiamo chiamato, ma quante
  // evidenze indipendenti abbiamo realmente a disposizione.
  // QUALITÀ DELL'ANALISI: il punteggio misura la solidità dei dati disponibili,
  // non il numero di endpoint interrogati. Un modello statistico Poisson
  // costruito su uno storico reale è già una base analitica utilizzabile;
  // fonti indipendenti aggiungono robustezza.
  // Anche quando i provider statistici non hanno una scheda completa della partita,
  // la quota contiene comunque un'informazione quantitativa utile come baseline.
  // Non la trattiamo come analisi forte: vale solo 20 punti e viene sempre mostrata
  // come "Limitata". In questo modo la classifica non resta vuota solo perché una
  // competizione ha copertura statistica parziale.
  let evidence = Number.isFinite(Number(c.odds)) ? 15 : 0; // baseline mercato: informazione, non analisi forte
  const homeSample = Number(c?._homeMatches?.length || 0);
  const awaySample = Number(c?._awayMatches?.length || 0);
  const usableSample = Math.min(Math.max(homeSample,awaySample),10);
  if (mcProb != null) evidence += 20;        // simulazione indipendente locale (10.000 iterazioni)
  if (statProb != null) evidence += 35;       // modello statistico da storico gol
  if (usableSample >= 5) evidence += 5;       // campione recente sufficiente
  if (freqProb != null) evidence += 10;      // frequenze osservate
  if (Number.isFinite(c.form)) evidence += 10; // forma recente
  if (oneXTwoMatchup != null || venueScore != null) evidence += 8; // casa/trasferta
  if (c.h2h?.sample >= 2) evidence += 5;     // H2H con campione minimo
  if (c.standingNote) evidence += 5;         // posizione significativa
  if (predictionProb != null) evidence += 20; // modello indipendente API-Football
  if (absenceScore != null) evidence += 5;   // disponibilità rosa
  const analysisSupport = clamp(evidence, 0, 100);

  // Penalita' di disaccordo: se due modelli seri sono lontani, la partita non
  // viene scartata ma perde priorita' rispetto a una previsione piu' coerente.
  const agreementScore = disagreement >= 25 ? 55 : disagreement >= 15 ? 72 : 92;
  // Ranking coerente con il TOP 3: probabilita' 45%, qualita' dei segnali
  // analitici 40%, valore della quota 15%. L'accordo tra modelli agisce come
  // penalita' di cautela, non come fonte artificiale di probabilita'.
  let score = probabilityScore * 0.45 + weighted * 0.40 + valueScore * 0.15;
  if (disagreement >= 25) score -= 8;
  else if (disagreement >= 15) score -= 4;
  if (analysisSupport < 30) score = Math.min(score, Math.max(45, probabilityScore * 0.70));
  else if (analysisSupport < 55) score = Math.min(score, Math.max(48, probabilityScore * 0.82));
  if (warningsPenaltyCount(c) > 0) score -= Math.min(8, warningsPenaltyCount(c) * 3);
  score = clamp(score, 0, 100);

  return {
    ...c,
    // Da ora prob/edge sono quelli del modello arricchito, quindi anche il
    // TOP 3 frontend usa davvero la nuova analisi invece della sola quota.
    prob: round(modelProb),
    edge: round(edge),
    score: round(score),
    analysisSupport: round(analysisSupport),
    analysisLimited: analysisSupport < 35,
    modelAgreement: round(agreementScore),
    scoreComponents: components.map(x=>({name:x[2],weight:x[0],value:round(x[1])})),
    absence: absenceScore == null ? 0 : round(absenceScore),
    pred: predictionProb == null ? 0 : round(predictionProb),
    monteCarlo: mc || null,
    eloHome: mc?.eloHome ?? null,
    eloAway: mc?.eloAway ?? null
  };
}

function oneXTwoFieldComponent(c) {
  const m=String(c?.market||"");
  if (!(m.startsWith("1") || m.startsWith("2") || m.startsWith("X"))) return null;
  const h=summarize(c?._homeMatches,c?._homeTeamId);
  const a=summarize(c?._awayMatches,c?._awayTeamId);
  const eh=recentEvidence(c?._homeMatches,c?._homeTeamId);
  const ea=recentEvidence(c?._awayMatches,c?._awayTeamId);
  const signals=[];
  const hGames=eh.homeWins+eh.homeLosses+eh.draws;
  const aGames=ea.awayWins+ea.awayLosses+ea.draws;
  const hPPG=hGames ? (eh.homeWins*3+eh.draws)/hGames : null;
  const aPPG=aGames ? (ea.awayWins*3+ea.draws)/aGames : null;
  if (hPPG!=null && aPPG!=null) signals.push(m.startsWith("1") ? hPPG-aPPG : m.startsWith("2") ? aPPG-hPPG : -Math.abs(hPPG-aPPG));
  if ([h.gfHome,h.gaHome,a.gfAway,a.gaAway].every(Number.isFinite)) {
    const hGD=h.gfHome-h.gaHome, aGD=a.gfAway-a.gaAway;
    signals.push(m.startsWith("1") ? hGD-aGD : m.startsWith("2") ? aGD-hGD : -Math.abs(hGD-aGD));
  }
  const resultDiff=(eh.homeWins-eh.homeLosses)-(ea.awayWins-ea.awayLosses);
  signals.push(m.startsWith("1") ? resultDiff : m.startsWith("2") ? -resultDiff : -Math.abs(resultDiff));
  if (!signals.length) return null;
  const avgSignal=signals.reduce((x,y)=>x+y,0)/signals.length;
  return clamp(50 + avgSignal*(m.startsWith("X") ? 14 : 16),0,100);
}

function venueComponent(market, homeForm, awayForm) {
  if (!Number.isFinite(homeForm) || !Number.isFinite(awayForm)) return null;
  const m=String(market||"");
  if (m.startsWith("1")) return clamp(50 + (homeForm-awayForm)*18,0,100);
  if (m.startsWith("2")) return clamp(50 + (awayForm-homeForm)*18,0,100);
  return 50;
}

function absenceComponent(market, home, away, av) {
  if (!av || (!av.home?.length && !av.away?.length)) return null;
  const h=av.home?.length||0, a=av.away?.length||0;
  const m=String(market||"");
  // Without reliable player-value data, absence count is deliberately capped.
  // For goal markets we keep it neutral rather than pretending every absence
  // has the same tactical impact.
  if (m.includes("Under") || m.includes("Over") || m.includes("Goal") || m.includes("No Goal")) return 50;
  if (m.startsWith("1")) return clamp(50 + (a-h)*12,0,100);
  if (m.startsWith("2")) return clamp(50 + (h-a)*12,0,100);
  if (m.startsWith("X")) return clamp(50 - Math.abs(h-a)*6,0,100);
  return 50;
}

function predictionComponent(market, pred, home, away) {
  if (!pred) return null;
  const m=String(market||"");
  const pct=pred.percent || {};
  if (m.startsWith("1") && Number.isFinite(Number(pct.home))) return Number(pct.home);
  if (m.startsWith("X") && Number.isFinite(Number(pct.draw))) return Number(pct.draw);
  if (m.startsWith("2") && Number.isFinite(Number(pct.away))) return Number(pct.away);

  const goalsH=Number(pred.goals?.home), goalsA=Number(pred.goals?.away);
  if (Number.isFinite(goalsH) && Number.isFinite(goalsA)) {
    const total=goalsH+goalsA;
    if (m==="Over 2.5") return poissonAtLeast(total,3)*100;
    if (m==="Under 2.5") return poissonAtMost(total,2)*100;
    if (m==="Over 3.5") return poissonAtLeast(total,4)*100;
    if (m==="Under 3.5") return poissonAtMost(total,3)*100;
    if (m==="Goal") return ((1-Math.exp(-goalsH))*(1-Math.exp(-goalsA)))*100;
    if (m==="No Goal") return (1-(1-Math.exp(-goalsH))*(1-Math.exp(-goalsA)))*100;
  }
  return null;
}


function buildFieldAnalysis(c, av, pred) {
  const market = String(c.market || "");
  const h = summarize(c?._homeMatches, c?._homeTeamId);
  const a = summarize(c?._awayMatches, c?._awayTeamId);
  const field = fieldMatchReason(c, market);
  const abs = [];
  if (av?.home?.length) abs.push(formatAbsenceSentence(c.home, av.home));
  if (av?.away?.length) abs.push(formatAbsenceSentence(c.away, av.away));

  const tactical = tacticalMatchReason(c, market, h, a);
  const warnings=[];
  const hForm=h.form, aForm=a.form;
  if (Number.isFinite(hForm)&&Number.isFinite(aForm)&&Math.abs(hForm-aForm)<0.35 && ["1 (Casa)","1","2 (Trasferta)","2"].includes(market)) warnings.push("Le due squadre arrivano in condizioni simili: il risultato secco è meno protetto.");
  if (["1 (Casa)","1","2 (Trasferta)","2"].includes(market)) {
    const mx=oneXTwoFieldComponent(c);
    if (mx!=null && mx>=43 && mx<=57) warnings.push("Il confronto casa/trasferta non offre un vantaggio abbastanza netto: il segno secco va trattato con cautela.");
  }
  if ((market === "Goal" || market.startsWith("Over")) && Number.isFinite(h.gf)&&Number.isFinite(a.gf) && h.gf<1.1 && a.gf<1.1) warnings.push("Negli ultimi risultati manca una produzione offensiva continua: è il principale elemento di cautela.");
  if ((market === "Under 2.5" || market === "Under 3.5") && Number.isFinite(h.ga)&&Number.isFinite(a.ga) && h.ga>=1.5 && a.ga>=1.5) warnings.push("Entrambe concedono occasioni con una certa frequenza: l'Under è meno protetto.");
  if ((market === "Goal" || market === "No Goal") && !av) warnings.push("Le informazioni sulle assenze non sono disponibili per questa partita.");

  const rawValue = market.startsWith("1") ? "1" : market.startsWith("2") ? "2" : market.startsWith("X") ? "X" : market;
  const h2hText = h2hSentence(rawValue, c.home, c.away, c.h2h);
  const signals=[];
  if (h2hText) signals.push(h2hText);
  if (c.standingNote) signals.push(c.standingNote+".");
  if (field) signals.push(field);
  if (tactical && tactical !== field) signals.push(tactical);
  if (abs.length) signals.push(abs.join(" "));
  const reason=signals.slice(0,3).join(" ") || buildBarReason(c,av,pred);
  const score=fieldConfidence(c, market, h, a, av, warnings);
  return { reason, tactical, warnings:warnings.slice(0,2), confidence:score, confidenceLabel:score>=78?"Alta":score>=62?"Media":"Bassa" };
}

function tacticalMatchReason(c, market, h, a) {
  const home=c?.home||"La squadra di casa", away=c?.away||"la squadra ospite";
  const hm=recentEvidence(c?._homeMatches, c?._homeTeamId);
  const am=recentEvidence(c?._awayMatches, c?._awayTeamId);
  const m=String(market||"");
  const bits=[];

  if (m === "Goal") {
    if (hm.scored>=4 && hm.conceded>=3 && am.scored>=4 && am.conceded>=3)
      bits.push(`${home} e ${away} stanno mostrando due copioni favorevoli al Goal: riescono a trovare la rete ma lasciano anche occasioni agli avversari.`);
    else if (hm.scored>=4 && am.conceded>=3)
      bits.push(`${home} sta trovando con continuità la porta, mentre ${away} ha mostrato difficoltà nel proteggere l'area: è il tipo di incrocio che può portare a un gol della squadra di casa.`);
    else if (am.scored>=4 && hm.conceded>=3)
      bits.push(`${away} ha continuità davanti e ${home} ha concesso gol con frequenza: la squadra ospite ha quindi condizioni concrete per creare occasioni.`);
    else if (hm.scored>=3 && am.scored>=3)
      bits.push(`Entrambe hanno mostrato di saper trovare la porta nelle ultime gare: il confronto può produrre occasioni da entrambe le parti.`);
  } else if (m === "No Goal") {
    if (hm.clean>=3 && am.clean>=3)
      bits.push(`Le due difese stanno proteggendo bene l'area: entrambe hanno mantenuto la porta inviolata più volte nelle ultime gare.`);
    else if (hm.clean>=3)
      bits.push(`${home} sta concedendo poco e può togliere spazio all'attacco di ${away}, rendendo difficile il Goal ospite.`);
    else if (am.clean>=3)
      bits.push(`${away} sta difendendo con continuità e può limitare le occasioni di ${home}.`);
  } else if (m === "Over 2.5" || m === "Over 3.5") {
    const line=m === "Over 3.5" ? 4 : 3;
    if (hm.overLine>=3 && am.overLine>=3)
      bits.push(`Le ultime gare delle due squadre hanno spesso superato la soglia dei ${line} gol: il ritmo e gli spazi possono favorire una partita aperta.`);
    else if (hm.overLine>=3 || am.overLine>=3)
      bits.push(`${hm.overLine>=3?home:away} arriva da diverse partite aperte, mentre l'altra squadra ha caratteristiche che possono contribuire ad alzare il ritmo.`);
    else if (hm.scored>=4 && am.scored>=4)
      bits.push(`Entrambe arrivano con continuità realizzativa: se il primo gol arriva presto, la partita può diventare rapidamente aperta.`);
  } else if (m === "Under 2.5" || m === "Under 3.5") {
    const line=m === "Under 3.5" ? 3 : 2;
    if (hm.underLine>=4 && am.underLine>=4)
      bits.push(`Le ultime gare delle due squadre sono state generalmente contenute nel punteggio: il contesto favorisce una partita con pochi gol.`);
    else if (hm.clean>=3 && am.clean>=2)
      bits.push(`La fase difensiva di entrambe sta dando buone risposte: questo può ridurre il numero di occasioni pulite.`);
    else if (hm.sample>=2 && am.sample>=2 && hm.scored<=2 && am.scored<=2)
      bits.push(`Nelle ultime uscite è mancata continuità sotto porta da entrambe le parti, un elemento favorevole a una gara con punteggio contenuto.`);
  } else if (m === "1 (Casa)" || m === "1") {
    if (hm.homeWins>=3 && am.awayLosses>=2)
      bits.push(`${home} sta sfruttando bene il fattore campo, mentre ${away} ha mostrato più difficoltà lontano da casa: il confronto premia la squadra di casa.`);
    else if (hm.homeWins>=3)
      bits.push(`${home} ha costruito le prestazioni migliori davanti al proprio pubblico e può provare a prendere il controllo della gara.`);
    else if (am.awayLosses>=3)
      bits.push(`${away} ha faticato in trasferta nelle ultime uscite: ${home} può approfittare di questa difficoltà per giocare più avanti.`);
  } else if (m === "2 (Trasferta)" || m === "2") {
    if (am.awayWins>=3 && hm.homeLosses>=2)
      bits.push(`${away} sta rendendo bene anche fuori casa, mentre ${home} ha mostrato fragilità davanti al proprio pubblico: è un incrocio favorevole agli ospiti.`);
    else if (am.awayWins>=3)
      bits.push(`${away} ha mostrato personalità in trasferta e può riuscire a portare la partita sul proprio terreno.`);
    else if (hm.homeLosses>=3)
      bits.push(`${home} ha faticato a proteggere il proprio campo nelle ultime uscite: ${away} può sfruttare questa vulnerabilità.`);
  } else if (m === "X (Pareggio)" || m === "X") {
    if (hm.draws>=2 && am.draws>=2)
      bits.push(`Entrambe hanno mostrato la tendenza a partite equilibrate e difficili da sbloccare: il pareggio è coerente con questo tipo di confronto.`);
    else
      bits.push(`Le caratteristiche recenti non indicano una squadra nettamente dominante: la partita può restare in equilibrio a lungo.`);
  }
  return bits.join(" ");
}

function recentEvidence(rows, teamId) {
  const ms=Array.isArray(rows)?rows:[];
  const relevant=ms.filter(m=>Number.isFinite(m?.score?.fullTime?.home)&&Number.isFinite(m?.score?.fullTime?.away)).slice(-5);
  const out={scored:0,conceded:0,clean:0,overLine:0,underLine:0,homeWins:0,homeLosses:0,awayWins:0,awayLosses:0,draws:0,sample:relevant.length};
  for(const m of relevant){
    const hg=m.score.fullTime.home, ag=m.score.fullTime.away;
    const isHome=m.homeTeam?.id===teamId;
    const gf=isHome?hg:ag, ga=isHome?ag:hg;
    if(gf>0) out.scored++;
    if(ga>0) out.conceded++;
    if(ga===0) out.clean++;
    if(hg+ag>=3) out.overLine++;
    if(hg+ag<=3) out.underLine++;
    if(gf>ga) isHome?out.homeWins++:out.awayWins++;
    if(gf<ga) isHome?out.homeLosses++:out.awayLosses++;
    if(gf===ga) out.draws++;
  }
  return out;
}

function fieldConfidence(c, market, h, a, av, warnings) {
  let score=58;
  const hasForm=Number.isFinite(h.form)&&Number.isFinite(a.form);
  const hasGoals=Number.isFinite(h.gf)&&Number.isFinite(a.gf)&&Number.isFinite(h.ga)&&Number.isFinite(a.ga);
  if(hasForm) score+=7;
  if(hasGoals) score+=8;
  if(av) score+=4;
  if(c?.prediction) score+=3;
  const m=String(market||"");
  if((m==="Goal"||m.startsWith("Over"))&&hasGoals&&h.gf>=1.35&&a.gf>=1.35) score+=9;
  if((m==="No Goal"||m.startsWith("Under"))&&hasGoals&&h.ga<=1.2&&a.ga<=1.2) score+=9;
  if((m.startsWith("1")||m.startsWith("2"))&&hasForm) {
    const diff=Math.abs(h.form-a.form);
    if(diff>=0.8) score+=8; else if(diff<0.35) score-=8;
  }
  score-=Math.min(15,(warnings?.length||0)*7);
  return Math.round(clamp(score,35,92));
}

function buildBarReason(c, av, pred) {
  const parts = [];
  const market = String(c.market || "");
  const fieldText = fieldMatchReason(c, market);
  const rawValue = market.startsWith("1") ? "1" : market.startsWith("2") ? "2" : market.startsWith("X") ? "X" : market;
  const h2hText = h2hSentence(rawValue, c.home, c.away, c.h2h);
  if (h2hText) parts.push(h2hText);
  if (c.standingNote) parts.push(c.standingNote+".");

  // La spiegazione deve parlare soprattutto di calcio giocato: forma,
  // atteggiamento offensivo/difensivo, rendimento casa/trasferta e assenze.
  // Evitiamo percentuali, probabilità e gergo da modello nel testo principale.
  if (fieldText) parts.push(fieldText);

  const absenceSentences = [];
  if (av?.home?.length) absenceSentences.push(formatAbsenceSentence(c.home, av.home));
  if (av?.away?.length) absenceSentences.push(formatAbsenceSentence(c.away, av.away));
  if (absenceSentences.length) parts.push(absenceSentences.join(" "));

  // Per 1X2 non aggiungiamo mai una frase generica sul fattore campo senza
  // un segnale reale a supporto (era il bug che generava spiegazioni
  // contraddittorie: "i dati non sostengono il segno 1" scritto proprio
  // sotto un pronostico che consigliava il segno 1). Se non c'è nessun
  // segnale vero, si passa al fallback qui sotto basato sul valore quota.

  if (!parts.length) {
    const odd = Number(c.odds);
    const edge = Number(c.edge);
    const label = market.startsWith("1") ? "il segno 1" : market.startsWith("2") ? "il segno 2" : market.startsWith("X") ? "il pareggio" : null;
    if (label && Number.isFinite(odd) && Number.isFinite(edge) && edge > 0) {
      return `Non c'è una tendenza recente abbastanza netta da spiegare da sola ${label}: il modello lo segnala soprattutto perché la quota (${odd.toFixed(2)}) sembra più alta di quanto meriterebbe questo esito, un margine di valore stimato di circa il ${Math.round(edge)}%.`;
    }
    if (Number.isFinite(odd) && Number.isFinite(edge) && edge > 0) {
      return `Per questa partita non abbiamo ancora abbastanza storico recente delle due squadre. La scelta si basa soprattutto sul confronto tra la quota proposta (${odd.toFixed(2)}) e quanto succede di solito in mercati simili, che lascia un margine di valore stimato di circa il ${Math.round(edge)}%.`;
    }
    return `Per questa partita non abbiamo ancora abbastanza storico recente delle due squadre per un giudizio più preciso: la valutazione resta soprattutto legata alla quota e va presa con più cautela del solito.`;
  }
  return parts.slice(0, 3).join(" ");
}

function fieldMatchReason(c, market) {
  const h = summarize(c?._homeMatches, c?._homeTeamId);
  const a = summarize(c?._awayMatches, c?._awayTeamId);
  const home = c?.home || "La squadra di casa";
  const away = c?.away || "la squadra ospite";
  const evH=recentEvidence(c?._homeMatches,c?._homeTeamId), evA=recentEvidence(c?._awayMatches,c?._awayTeamId);
  const parts=[];
  // ATTENZIONE: qui NON si deve fare Number(h.gf) prima del controllo.
  // Number(null) vale 0 in JavaScript, quindi un controllo tipo
  // Number.isFinite(Number(h.ga)) risulterebbe sempre vero anche a zero
  // partite storiche disponibili (h.ga=null), facendo scattare affermazioni
  // specifiche tipo "difesa solidissima" basate sul nulla. Si controllano
  // quindi i valori grezzi, che restano null finché non c'è un campione reale.
  const hg=h.gf, ag=a.gf, hga=h.ga, aga=a.ga;
  const hStrongAttack=Number.isFinite(hg)&&hg>=1.4, aStrongAttack=Number.isFinite(ag)&&ag>=1.4;
  const hSolidDefense=Number.isFinite(hga)&&hga<=1.1, aSolidDefense=Number.isFinite(aga)&&aga<=1.1;
  const hLeaky=Number.isFinite(hga)&&hga>=1.5, aLeaky=Number.isFinite(aga)&&aga>=1.5;

  // The main reason must be concrete football evidence, not a raw result streak.
  // Prefer descriptions of scoring/conceding patterns and home/away behaviour.
  if(market === "Goal") {
    if(evH.scored>=4 && evH.conceded>=3 && evA.scored>=4 && evA.conceded>=3)
      parts.push(`${home} sta trovando la porta con continuità ma concede anche occasioni; ${away} presenta lo stesso tipo di equilibrio tra pericolosità davanti e vulnerabilità dietro.`);
    else if(evH.scored>=4 && evA.conceded>=3)
      parts.push(`${home} arriva con una buona continuità realizzativa, mentre ${away} ha lasciato spesso spazio agli avversari nella propria area.`);
    else if(evA.scored>=4 && evH.conceded>=3)
      parts.push(`${away} sta trovando la porta con continuità e può attaccare una difesa di ${home} che nelle ultime uscite ha concesso con frequenza.`);
    else if(hStrongAttack && aLeaky)
      parts.push(`${home} ha più soluzioni per attaccare l'area, mentre ${away} ha mostrato difficoltà nel proteggere gli ultimi metri.`);
    else if(aStrongAttack && hLeaky)
      parts.push(`${away} ha armi per attaccare la profondità e ${home} ha mostrato difficoltà nel proteggere la propria area.`);
    else if(evH.scored>=3 && evA.scored>=3)
      parts.push(`Entrambe hanno mostrato una discreta continuità nel trovare la porta, quindi il confronto può produrre occasioni su entrambi i fronti.`);
  } else if(market === "No Goal") {
    if(evH.clean>=3 && evA.clean>=3)
      parts.push(`Le due squadre stanno proteggendo bene l'area e hanno mantenuto più volte la porta inviolata nelle ultime gare.`);
    else if(hSolidDefense && aSolidDefense)
      parts.push(`Entrambe hanno una struttura difensiva solida e stanno concedendo poche occasioni pulite.`);
    else if(hSolidDefense)
      parts.push(`${home} sta concedendo poco e può togliere spazio alle iniziative offensive di ${away}.`);
    else if(aSolidDefense)
      parts.push(`${away} sta proteggendo bene la propria area e può limitare la produzione offensiva di ${home}.`);
  } else if(market === "Over 2.5" || market === "Over 3.5") {
    if(evH.overLine>=3 && evA.overLine>=3)
      parts.push(`Entrambe arrivano da partite spesso aperte e con diversi momenti di campo lungo: se il ritmo cresce, gli spazi possono moltiplicarsi.`);
    else if(hStrongAttack && aStrongAttack)
      parts.push(`Entrambe hanno qualità per attaccare con continuità e creare occasioni da più zone del campo.`);
    else if((hStrongAttack||aStrongAttack)&&(hLeaky||aLeaky))
      parts.push(`Una delle due ha qualità per spingere, mentre l'altra ha mostrato vulnerabilità quando deve difendere gli spazi.`);
  } else if(market === "Under 2.5" || market === "Under 3.5") {
    if(evH.underLine>=4 && evA.underLine>=4)
      parts.push(`Le ultime gare hanno avuto un andamento generalmente controllato e con pochi gol: il copione può restare prudente.`);
    else if(hSolidDefense && aSolidDefense)
      parts.push(`Le due difese stanno concedendo poco spazio e possono tenere la gara su ritmi più controllati.`);
    else if(hSolidDefense || aSolidDefense)
      parts.push(`Almeno una delle due ha una fase difensiva capace di rallentare il ritmo e limitare le occasioni pulite.`);
    else if(Number.isFinite(hg)&&Number.isFinite(ag)&&hStrongAttack===false && aStrongAttack===false)
      parts.push(`Nelle ultime uscite entrambe hanno mostrato poca continuità nella finalizzazione: questo può favorire un punteggio contenuto.`);
  } else if(market === "1 (Casa)" || market === "1") {
    if(evH.homeWins>=3 && evA.awayLosses>=2)
      parts.push(`${home} sta sfruttando bene il proprio campo, mentre ${away} ha mostrato più difficoltà quando gioca lontano da casa.`);
    else if(evH.homeWins>=3)
      parts.push(`${home} ha costruito le prestazioni migliori davanti al proprio pubblico e può provare a prendere il controllo della gara.`);
    else if(evA.awayLosses>=3)
      parts.push(`${away} ha faticato in trasferta nelle ultime uscite: ${home} può provare ad attaccare questa vulnerabilità.`);
  } else if(market === "2 (Trasferta)" || market === "2") {
    if(evA.awayWins>=3 && evH.homeLosses>=2)
      parts.push(`${away} sta rendendo bene anche fuori casa, mentre ${home} ha mostrato fragilità davanti al proprio pubblico.`);
    else if(evA.awayWins>=3)
      parts.push(`${away} ha mostrato personalità in trasferta e può riuscire a portare la partita sul proprio terreno.`);
    else if(evH.homeLosses>=3)
      parts.push(`${home} ha faticato a proteggere il proprio campo nelle ultime uscite: ${away} può sfruttare questa vulnerabilità.`);
  } else if(market === "X (Pareggio)" || market === "X") {
    if(evH.draws>=2 && evA.draws>=2)
      parts.push(`Entrambe hanno mostrato la tendenza a partite equilibrate e difficili da sbloccare: il pareggio è coerente con questo tipo di confronto.`);
    else
      parts.push(`Le caratteristiche recenti non indicano una squadra nettamente dominante: la partita può restare in equilibrio a lungo.`);
  }
  return parts.join(" ");
}

function availabilityNames(rows) {
  return rows.slice(0,5).map(x=>{
    const label=x.status || availabilityStatus(x.type, x.reason);
    const reason=String(x.reason||"").trim();
    const showReason=reason && !["squalificato","infortunato","in dubbio","indisponibile"].includes(label);
    return `${x.player} (${label}${showReason ? `: ${reason.toLowerCase()}` : ""})`;
  }).join(", ");
}

function formatAbsenceSentence(team, rows) {
  const injuries=rows.filter(x=>String(x.type||"").toLowerCase().includes("injur"));
  const suspensions=rows.filter(x=>String(x.type||"").toLowerCase().includes("susp"));
  const others=rows.filter(x=>!injuries.includes(x) && !suspensions.includes(x));
  const parts=[];
  if (injuries.length) parts.push(`${team} ha ${injuries.length===1?"un infortunato":"alcuni infortunati"}: ${availabilityNames(injuries)}`);
  if (suspensions.length) parts.push(`${team} ha ${suspensions.length===1?"un giocatore squalificato":"giocatori squalificati"}: ${availabilityNames(suspensions)}`);
  if (others.length) parts.push(`${team} ha altri indisponibili: ${availabilityNames(others)}`);
  return parts.join(". ")+".";
}

function predictionReason(market, pred) {
  if (!pred) return "";
  const m=String(market||"");
  const pct=pred.percent||{};
  if (m.startsWith("1") && Number.isFinite(Number(pct.home))) return `Anche la previsione API vede ${Number(pct.home).toFixed(0)}% di probabilità per la vittoria di casa.`;
  if (m.startsWith("X") && Number.isFinite(Number(pct.draw))) return `Anche la previsione API vede ${Number(pct.draw).toFixed(0)}% di probabilità per il pareggio.`;
  if (m.startsWith("2") && Number.isFinite(Number(pct.away))) return `Anche la previsione API vede ${Number(pct.away).toFixed(0)}% di probabilità per la vittoria ospite.`;
  if (Number.isFinite(Number(pred.goals?.home)) && Number.isFinite(Number(pred.goals?.away))) {
    const t=Number(pred.goals.home)+Number(pred.goals.away);
    if (m.includes("Under") && t<3.0) return `La previsione API si aspetta circa ${t.toFixed(1)} gol, quindi va nella stessa direzione dell'Under.`;
    if (m.includes("Over") && t>=3.0) return `La previsione API si aspetta circa ${t.toFixed(1)} gol, quindi va nella stessa direzione dell'Over.`;
  }
  return "";
}

function recentFormText(home, away, homeMatches, awayMatches) {
  const h = streakInfo(homeMatches, home), a = streakInfo(awayMatches, away);
  const bits=[];
  if (h) bits.push(`${home} ${h}`);
  if (a) bits.push(`${away} ${a}`);
  return bits.join(" ");
}

function streakInfo(rows, teamName) {
  const ms=Array.isArray(rows)?rows:[];
  const relevant=ms.filter(m=>Number.isFinite(m?.score?.fullTime?.home)&&Number.isFinite(m?.score?.fullTime?.away)).slice(-10);
  if(!relevant.length) return "";
  const results=relevant.map(m=>{
    const hg=m.score.fullTime.home, ag=m.score.fullTime.away;
    const isHome=normalizeTeam(m.homeTeam?.name)===normalizeTeam(teamName) || m.homeTeam?.id===undefined;
    const gf=isHome?hg:ag, ga=isHome?ag:hg;
    return {result:gf>ga?'W':gf<ga?'L':'D',home:isHome};
  });
  const last=results.at(-1)?.result;
  let n=0; for(let i=results.length-1;i>=0&&results[i].result===last;i--)n++;
  const unbeaten=results.slice().reverse().findIndex(x=>x.result==='L');
  const unbeatenN=unbeaten<0?results.length:unbeaten;
  let seq;
  if (last === 'W') seq = n === 1 ? 'ha vinto l’ultima partita' : `viene da ${n} vittorie consecutive`;
  else if (last === 'D') seq = n === 1 ? 'ha pareggiato l’ultima partita' : `viene da ${n} pareggi consecutivi`;
  else seq = n === 1 ? 'ha perso l’ultima partita' : `viene da ${n} sconfitte consecutive`;
  const bits=[seq];
  if(unbeatenN>=5) bits.push(`ed è imbattuta da ${unbeatenN} partite`);
  return bits.join(" ")+".";
}

async function teamStats(teamId, date, token) {
  if (!teamId) return null;
  // Try a recent historical window. If the token does not expose it,
  // return an empty result and let odds-only analysis continue.
  const from = `${Number(date.slice(0,4))-2}-01-01`;
  const d = await fd(`/v4/teams/${teamId}/matches?dateFrom=${from}&dateTo=${date}&status=FINISHED&limit=20`, token);
  return { teamId, matches: Array.isArray(d.matches) ? d.matches.slice(-10) : [] };
}

async function odds(path) {
  try {
    const r = await fetch("https://api.odds-api.io" + path, {
      headers: { "Accept": "application/json" }
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: text.slice(0, 500) }; }
  } catch (e) { return { error: e?.message || String(e) }; }
}

// --- Risoluzione dinamica degli slug campionato --------------------------
// Gli slug statici sotto sono usati come scorciatoia veloce (zero richieste
// extra) ma vengono sempre verificati contro il catalogo REALE restituito
// da Odds-API.io (/v3/leagues). Se uno slug è sbagliato o mancante, viene
// cercato automaticamente per nome nel catalogo e la scelta viene registrata
// in diagnostics. Questo è il fix del bug "Champions League mai analizzata":
// lo slug statico "uefa-champions-league" non esisteva nel catalogo reale,
// quindi la fase di discovery trovava sempre 0 eventi per quel campionato.
let LEAGUES_CATALOG_CACHE = { list: null, fetchedAt: 0 };

async function getOddsLeaguesCatalog(apiKey) {
  const now = Date.now();
  if (LEAGUES_CATALOG_CACHE.list && (now - LEAGUES_CATALOG_CACHE.fetchedAt) < 6 * 60 * 60 * 1000) {
    return { list: LEAGUES_CATALOG_CACHE.list, fetched: false };
  }
  const data = await odds(`/v3/leagues?apiKey=${encodeURIComponent(apiKey)}&sport=football&all=true`);
  if (Array.isArray(data) && data.length) {
    LEAGUES_CATALOG_CACHE = { list: data, fetchedAt: now };
    return { list: data, fetched: true };
  }
  // Se la chiamata fallisce, meglio riusare una cache vecchia che restare
  // senza nulla: gli slug statici corretti continuano comunque a funzionare.
  return { list: LEAGUES_CATALOG_CACHE.list || [], fetched: true };
}

const LEAGUE_SEARCH_HINTS = {
  SA:{includes:["serie a"],excludes:["women","u19","u20","u21","primavera","serie a2","serie b"]}, PL:{includes:["premier league"],excludes:["women","u18","u21","u23"]}, PD:{includes:["la liga"],excludes:["women","segunda","liga 2","u19"]}, BL1:{includes:["bundesliga"],excludes:["women","2. bundesliga","bundesliga 2","u19"]}, FL1:{includes:["ligue 1"],excludes:["women","ligue 2"]}, PPL:{includes:["primeira liga","liga portugal"],excludes:["women","2"]}, DED:{includes:["eredivisie"],excludes:["women","keuken","2"]},
  BEL1:{includes:["pro league"],excludes:["women","challenger","second","2"]}, SCO1:{includes:["premiership"],excludes:["women","championship","league one"]}, AUT1:{includes:["bundesliga"],excludes:["women","2."]}, SUI1:{includes:["super league"],excludes:["women","challenge"]}, TUR1:{includes:["super lig"],excludes:["women","1. lig","2. lig"]}, GRE1:{includes:["super league"],excludes:["women","2"]}, DEN1:{includes:["superliga"],excludes:["women","1st division"]}, SWE1:{includes:["allsvenskan"],excludes:["women"]}, NOR1:{includes:["eliteserien"],excludes:["women","1. divisjon"]}, POL1:{includes:["ekstraklasa"],excludes:["women","1 liga"]}, CZE1:{includes:["first league"],excludes:["women","second"]}, CRO1:{includes:["hnl"],excludes:["women","2"]}, SRB1:{includes:["super liga"],excludes:["women","prva liga"]}, ROU1:{includes:["liga 1"],excludes:["women","liga 2"]}, UKR1:{includes:["premier league"],excludes:["women","first league"]}, HUN1:{includes:["nemzeti bajnoksag i","nb i"],excludes:["women","nb ii"]}, SVK1:{includes:["super liga"],excludes:["women","2. liga"]}, SVN1:{includes:["prva liga"],excludes:["women","2."]}, BUL1:{includes:["first league"],excludes:["women","second"]}, CYP1:{includes:["first division"],excludes:["women","second"]}, ISR1:{includes:["premier league"],excludes:["women","national league"]}, IRL1:{includes:["premier division"],excludes:["women","first division"]}, ISL1:{includes:["besta-deild"],excludes:["women"]}, FIN1:{includes:["veikkausliiga"],excludes:["women"]}, BIH1:{includes:["premier league"],excludes:["women","first league"]}, ALB1:{includes:["kategoria superiore"],excludes:["women","first division"]}, MKD1:{includes:["first league"],excludes:["women","second"]}, GEO1:{includes:["erovnuli liga"],excludes:["women"]}, ARM1:{includes:["premier league"],excludes:["women","first league"]}, AZE1:{includes:["premier league"],excludes:["women","first division"]}, MDA1:{includes:["super liga"],excludes:["women","division a"]}, MLT1:{includes:["premier league"],excludes:["women","challenge league"]}, WAL1:{includes:["cymru premier"],excludes:["women"]}, NIR1:{includes:["premiership"],excludes:["women","championship"]}, EST1:{includes:["meistriliiga"],excludes:["women","esiliiga"]}, LAT1:{includes:["virsliga"],excludes:["women"]}, LTU1:{includes:["a lyga"],excludes:["women","i lyga"]}, LUX1:{includes:["national division"],excludes:["women"]},
  CL:{includes:["champions league"],excludes:["women","qualif","u19","youth"]}, EL:{includes:["europa league"],excludes:["women","qualif","youth"]}, ECL:{includes:["conference league"],excludes:["women","qualif","youth"]},
  BRA1:{includes:["serie a"],excludes:["women","serie b","serie c","serie d"]}, ARG1:{includes:["liga profesional","primera division"],excludes:["women","primera nacional","primera b"]}, COL1:{includes:["primera a","categoria primera a"],excludes:["women","primera b"]}, CHI1:{includes:["primera division"],excludes:["women","primera b"]}, URU1:{includes:["primera division"],excludes:["women","segunda"]}, ECU1:{includes:["liga pro"],excludes:["women","serie b"]}, PER1:{includes:["liga 1"],excludes:["women","liga 2"]}, PAR1:{includes:["primera division"],excludes:["women","intermedia"]}, BOL1:{includes:["division profesional"],excludes:["women","segunda"]}, VEN1:{includes:["primera division"],excludes:["women","segunda"]}, MLS1:{includes:["mls"],excludes:["women","next pro"]}, JPN1:{includes:["j1 league"],excludes:["women","j2","j3"]}
};

function resolveLeagueSlug(code, staticGuess, catalog, diagnostics) {
  const bySlug = new Set((catalog || []).map(l => String(l.slug || "").toLowerCase()));
  if (staticGuess && bySlug.has(staticGuess.toLowerCase())) {
    return staticGuess; // confermato contro il catalogo reale, nessun bisogno di cercare altro
  }
  const hint = LEAGUE_SEARCH_HINTS[code];
  if (!hint || !catalog || !catalog.length) return staticGuess || null;
  const candidates = catalog.filter(l => {
    const name = String(l.name || "").toLowerCase();
    return hint.includes.every(k => name.includes(k)) && !hint.excludes.some(k => name.includes(k));
  }).sort((a, b) => (b.eventsCount || 0) - (a.eventsCount || 0));
  const match = candidates[0];
  if (match) {
    diagnostics.push({ provider: "league-slug-autocorrect", league: code, from: staticGuess || null, to: match.slug, matchedName: match.name });
    return match.slug;
  }
  diagnostics.push({ provider: "league-slug-autocorrect", league: code, from: staticGuess || null, to: null, error: "Nessuna corrispondenza trovata nel catalogo Odds-API.io" });
  return staticGuess || null;
}

function oddsLeagueSlug(code) {
  return {
    SA:"italy-serie-a", PL:"england-premier-league", PD:"spain-la-liga", BL1:"germany-bundesliga", FL1:"france-ligue-1", PPL:"portugal-primeira-liga", DED:"netherlands-eredivisie",
    BEL1:"belgium-first-division-a", SCO1:"scotland-premiership", AUT1:"austria-bundesliga", SUI1:"switzerland-super-league", TUR1:"turkey-super-lig", GRE1:"greece-super-league", DEN1:"denmark-superliga", SWE1:"sweden-allsvenskan", NOR1:"norway-eliteserien", POL1:"poland-ekstraklasa", CZE1:"czech-republic-first-league", CRO1:"croatia-hnl", SRB1:"serbia-super-liga", ROU1:"romania-liga-1", UKR1:"ukraine-premier-league", HUN1:"hungary-nb-i", SVK1:"slovakia-super-liga", SVN1:"slovenia-prva-liga", BUL1:"bulgaria-first-league", CYP1:"cyprus-first-division", ISR1:"israel-premier-league", IRL1:"ireland-premier-division", ISL1:"iceland-urvalsdeild", FIN1:"finland-veikkausliiga", BIH1:"bosnia-premier-league", ALB1:"albania-kategoria-superiore", MKD1:"north-macedonia-first-league", GEO1:"georgia-erovnuli-liga", ARM1:"armenia-premier-league", AZE1:"azerbaijan-premier-league", MDA1:"moldova-super-liga", MLT1:"malta-premier-league", WAL1:"wales-cymru-premier", NIR1:"northern-ireland-premiership", EST1:"estonia-meistriliiga", LAT1:"latvia-virsliga", LTU1:"lithuania-a-lyga", LUX1:"luxembourg-national-division",
    CL:"uefa-champions-league", EL:"uefa-europa-league", ECL:"uefa-europa-conference-league",
    BRA1:"brazil-serie-a", ARG1:"argentina-primera-division", COL1:"colombia-primera-a", CHI1:"chile-primera-division", URU1:"uruguay-primera-division", ECU1:"ecuador-liga-pro", PER1:"peru-liga-1", PAR1:"paraguay-primera-division", BOL1:"bolivia-division-profesional", VEN1:"venezuela-primera-division", MLS1:"usa-mls", JPN1:"japan-j1-league"
  }[code] || null;
}

function normalizePair(a,b) { return `${clean(a)}|${clean(b)}`; }
function clean(s) {
  return String(s || "").toLowerCase()
    .replace(/\b(fc|cf|afc|calcio|ac|as|ssc|cfc|fk|sk|sv|bk)\b/g, "")
    .replace(/[^a-z0-9]+/g, "").trim();
}

async function supaRead(supaUrl, serviceKey, path) {
  const r = await fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,500)}`);
  return text ? JSON.parse(text) : [];
}

function unwrapBetfairCatalogue(payload) {
  const out=[];
  const walk=v=>{
    if(Array.isArray(v)){ for(const x of v) walk(x); return; }
    if(v && typeof v==='object'){
      if(Array.isArray(v.result)){ for(const x of v.result) walk(x); return; }
      if(v.marketId) out.push(v);
    }
  };
  walk(payload);
  return out;
}

function bestBackForRunner(r) {
  if(Number.isFinite(Number(r?.backPrice)) && Number(r.backPrice)>1) return Number(r.backPrice);
  const list=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];
  const valid=list.map(x=>({price:Number(x?.price),size:Number(x?.size)})).filter(x=>x.price>1 && Number.isFinite(x.price));
  valid.sort((a,b)=>b.price-a.price);
  return valid[0]?.price ?? null;
}

function bestBackSizeForRunner(r) {
  if(r?.backSize!=null && Number.isFinite(Number(r.backSize))) return Number(r.backSize);
  const list=Array.isArray(r?.ex?.availableToBack)?r.ex.availableToBack:[];
  const valid=list.map(x=>({price:Number(x?.price),size:Number(x?.size)})).filter(x=>x.price>1 && Number.isFinite(x.price));
  valid.sort((a,b)=>b.price-a.price);
  return valid[0]?.size ?? null;
}

async function loadBetfairSnapshot(supaUrl, serviceKey) {
  try {
    // Il bridge salva un catalogo completo per sincronizzazione e uno snapshot
    // book per ogni market. Prendiamo il catalogo più recente e gli ultimi book.
    const catRows=await supaRead(supaUrl,serviceKey,'betfair_quotes?select=payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1');
    const bookRows=await supaRead(supaUrl,serviceKey,'betfair_quotes?select=market_id,payload,received_at&data_type=eq.book&order=received_at.desc&limit=500');
    const latestBook=new Map();
    for(const row of bookRows){ if(row?.market_id && !latestBook.has(String(row.market_id))) latestBook.set(String(row.market_id),row); }
    const fixtures=new Map();
    const catalogue=catRows[0]?.payload;
    for(const m of unwrapBetfairCatalogue(catalogue)) {
      const name=String(m.marketName||'');
      const isMatch=/match odds|1x2|esito finale/i.test(name);
      const lineMatch=name.match(/(?:under\s*\/\s*over|over\s*\/\s*under|under.*over|over.*under)[^0-9]*(0\.5|1\.5|2\.5|3\.5|4\.5)/i);
      if(!isMatch && !lineMatch) continue;
      const book=latestBook.get(String(m.marketId));
      if(!book) continue;
      const runners=(Array.isArray(book.payload?.runners)?book.payload.runners:[]).map(r=>({
        selectionId:r.selectionId,
        status:r.status,
        backPrice:bestBackForRunner(r),
        backSize:bestBackSizeForRunner(r),
        name:(Array.isArray(m.runners)?m.runners.find(x=>String(x?.selectionId)===String(r?.selectionId))?.runnerName:null)||String(r.selectionId)
      }));
      const item={marketId:String(m.marketId),marketName:name,event:m.event||null,competition:m.competition||null,receivedAt:book.received_at||m.received_at,runners};
      const eventName=String(m.event?.name||'');
      const parts=eventName.split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);
      let pair=null;
      if(parts.length>=2) pair=[parts[0],parts.slice(1).join(' ')];
      if(pair){
        const key=normalizePair(pair[0],pair[1]);
        if(!fixtures.has(key)) fixtures.set(key,[]);
        fixtures.get(key).push(item);
      }
    }
    return {fixtures,catalogueMarkets:unwrapBetfairCatalogue(catalogue).length,bookMarkets:latestBook.size,error:null};
  } catch(e) {
    return {fixtures:new Map(),catalogueMarkets:0,bookMarkets:0,error:e?.message||String(e)};
  }
}

function findBestBetfairFixture(home, away, fixtures) {
  if(!home||!away) return null;
  const exact=fixtures.get(normalizePair(home,away));
  if(exact) return exact;
  const reverse=fixtures.get(normalizePair(away,home));
  if(reverse) return reverse;
  let best=null,bestScore=0;
  for(const [key,markets] of fixtures){
    const sample=markets[0]?.event?.name||'';
    const parts=String(sample).split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);
    if(parts.length<2) continue;
    const h=parts[0],a=parts.slice(1).join(' ');
    const hs=teamSimilarity(home,h), as=teamSimilarity(away,a);
    const revhs=teamSimilarity(home,a), revas=teamSimilarity(away,h);
    const score=Math.max((hs+as)/2,(revhs+revas)/2);
    if(Math.max(hs,revhs)>=0.68 && Math.max(as,revas)>=0.68 && score>bestScore){best=markets;bestScore=score;}
  }
  return best;
}

function extractBetfairOdds(markets, requestedMarket="all", homeTeamName="", awayTeamName="") {
  const out=[];
  const wantsTotals = requestedMarket === "all" || requestedMarket === "totals";
  const wants1x2 = requestedMarket === "all" || requestedMarket === "1x2";
  const wantedLines=[0.5,1.5,2.5,3.5,4.5];
  const norm=v=>String(v??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  const homeN=norm(homeTeamName), awayN=norm(awayTeamName);
  const num=v=>{ const n=Number(v); return Number.isFinite(n)&&n>1?n:null; };

  for(const m of (Array.isArray(markets)?markets:[])){
    const name=String(m.marketName||"");
    const isMatch=/match odds|1x2|esito finale/i.test(name);
    const lineMatch=name.match(/(?:under\s*\/\s*over|over\s*\/\s*under|under.*over|over.*under)[^0-9]*(0\.5|1\.5|2\.5|3\.5|4\.5)/i);
    const line=lineMatch?Number(lineMatch[1]):null;
    if(!isMatch && !(wantsTotals && line!=null && wantedLines.some(x=>Math.abs(x-line)<0.001))) continue;
    if(isMatch && !wants1x2) continue;
    if(line!=null && !wantsTotals) continue;

    for(const r of (Array.isArray(m.runners)?m.runners:[])){
      const odd=num(r.backPrice);
      if(!odd) continue;
      const label=norm(r.name);
      let value=null;
      if(isMatch){
        if(["1","home","casa"].includes(label) || (homeN&&label===homeN) || (homeN&&label.includes(homeN))) value="1";
        else if(["x","draw","pareggio","tie","the draw"].includes(label)) value="X";
        else if(["2","away","trasferta"].includes(label) || (awayN&&label===awayN) || (awayN&&label.includes(awayN))) value="2";
      } else if(line!=null){
        if(/\bover\b/i.test(r.name)) value=`Over ${line.toFixed(1)}`;
        else if(/\bunder\b/i.test(r.name)) value=`Under ${line.toFixed(1)}`;
      }
      if(value) out.push({value,odd,bookmaker:"Betfair Exchange",liquidity:r.backSize??null,marketId:m.marketId});
    }
  }
  // Una sola quota BACK per esito: prendiamo la migliore disponibile.
  const best=new Map();
  for(const x of out){ const old=best.get(x.value); if(!old||x.odd>old.odd) best.set(x.value,x); }
  return [...best.values()];
}

export function extractOdds(data, requestedMarket="all", requestedBookmaker="", homeTeamName="", awayTeamName="") {
  const out = [];
  const books = data?.bookmakers && typeof data.bookmakers === "object" ? data.bookmakers : {};
  const selectedBooks = requestedBookmaker
    ? Object.entries(books).filter(([name]) => String(name).trim().toLowerCase() === String(requestedBookmaker).trim().toLowerCase())
    : Object.entries(books);
  const wantsTotals = requestedMarket === "all" || requestedMarket === "totals";
  const wantsBtts = requestedMarket === "all" || requestedMarket === "btts";
  const wants1x2 = requestedMarket === "all" || requestedMarket === "1x2";

  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(String(v ?? "").replace(",", "."));
      if (Number.isFinite(n) && n > 1) return n;
    }
    return null;
  };
  const marketName = v => String(v?.name ?? v?.market ?? "").trim().toLowerCase();

  for (const [bookmaker, markets] of selectedBooks) {
    if (!Array.isArray(markets)) continue;
    for (const bet of markets) {
      const name = marketName(bet);
      const rows = Array.isArray(bet?.odds) ? bet.odds : [];
      if (!rows.length) continue;

      // Odds-API.io football uses ML, Totals and BTTS/"Both Teams To Score".
      // Keep aliases broad so a bookmaker naming variation does not erase a match.
      // IMPORTANT: keep these market names strict. Using includes("both teams")
      // would also match "Both Teams To Score 2H/HT" and mislabel those odds as
      // the full-match Goal market (which is exactly how a 3.75 can appear).
      const isTotals = wantsTotals && (name === "totals" || name === "over/under" || name === "over under" || name === "goals over/under");
      const isBtts = wantsBtts && (name === "btts" || name === "both teams to score");
      const isMatch = wants1x2 && (name === "ml" || name === "1x2" || name.includes("match result") || name.includes("full time result") || name.includes("three way") || name === "winner");

      if (isTotals) {
        for (const row of rows) {
          const line = num(row?.hdp, row?.line, row?.total, row?.handicap);
          if (line == null) continue;
          const over = num(row?.over, row?.Over, row?.overOdds, row?.o);
          const under = num(row?.under, row?.Under, row?.underOdds, row?.u);
          if (Math.abs(line-2.5)<0.001) {
            if (over) out.push({value:"Over 2.5",odd:over,bookmaker});
            if (under) out.push({value:"Under 2.5",odd:under,bookmaker});
          } else if (Math.abs(line-3.5)<0.001) {
            if (over) out.push({value:"Over 3.5",odd:over,bookmaker});
            if (under) out.push({value:"Under 3.5",odd:under,bookmaker});
          }
        }
      }

      if (isBtts) {
        for (const row of rows) {
          const yes = num(row?.yes, row?.goal, row?.bttsYes, row?.Yes, row?.true);
          const no = num(row?.no, row?.bttsNo, row?.No, row?.false);
          if (yes) out.push({value:"Goal",odd:yes,bookmaker});
          if (no) out.push({value:"No Goal",odd:no,bookmaker});
        }
      }

      if (isMatch) {
        const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
        const homeN = norm(homeTeamName), awayN = norm(awayTeamName);
        const pushOutcome = (label, odd) => {
          const n = num(odd);
          if (!n) return;
          const l = norm(label);
          if (["1","home","casa","team 1","home team","1x2 home"].includes(l) || (homeN && l === homeN) || (homeN && l.includes(homeN))) out.push({value:"1",odd:n,bookmaker});
          else if (["x","draw","pareggio","tie"].includes(l)) out.push({value:"X",odd:n,bookmaker});
          else if (["2","away","trasferta","team 2","away team","1x2 away"].includes(l) || (awayN && l === awayN) || (awayN && l.includes(awayN))) out.push({value:"2",odd:n,bookmaker});
        };
        for (const row of rows) {
          const home = num(row?.home, row?.Home, row?.one, row?.['1']);
          const draw = num(row?.draw, row?.Draw, row?.x, row?.['X']);
          const away = num(row?.away, row?.Away, row?.two, row?.['2']);
          if (home || draw || away) {
            if (home) out.push({value:"1",odd:home,bookmaker});
            if (draw) out.push({value:"X",odd:draw,bookmaker});
            if (away) out.push({value:"2",odd:away,bookmaker});
            continue;
          }
          const label = row?.name ?? row?.label ?? row?.outcome ?? row?.selection ?? row?.type ?? row?.result;
          const odd = row?.odd ?? row?.odds ?? row?.price ?? row?.value ?? row?.decimal;
          if (label != null) pushOutcome(label, odd);
          if (Array.isArray(row?.outcomes)) for (const o of row.outcomes) pushOutcome(o?.name ?? o?.label ?? o?.outcome ?? o?.selection, o?.odd ?? o?.odds ?? o?.price ?? o?.value ?? o?.decimal);
        }
      }
    }
  }

  // If the bookmaker supplied a direct ML object with draw but no recognizable
  // market name, still accept it rather than returning zero candidates.
  if (wants1x2 && !out.some(x=>["1","X","2"].includes(x.value))) {
    const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const homeN=norm(homeTeamName), awayN=norm(awayTeamName);
    const pushLabeled=(bookmaker,row)=>{
      const label=norm(row?.name ?? row?.label ?? row?.outcome ?? row?.selection ?? row?.type ?? row?.result);
      const odd=num(row?.odd,row?.odds,row?.price,row?.value,row?.decimal);
      if(!odd)return;
      if(["1","home","casa"].includes(label)||(homeN&&label.includes(homeN))) out.push({value:"1",odd,bookmaker});
      else if(["x","draw","pareggio","tie"].includes(label)) out.push({value:"X",odd,bookmaker});
      else if(["2","away","trasferta"].includes(label)||(awayN&&label.includes(awayN))) out.push({value:"2",odd,bookmaker});
    };
    for (const [bookmaker, markets] of selectedBooks) {
      for (const bet of (Array.isArray(markets)?markets:[])) {
        for (const row of (Array.isArray(bet?.odds)?bet.odds:[])) {
          const home=num(row?.home,row?.Home,row?.one,row?.['1']);
          const draw=num(row?.draw,row?.Draw,row?.x,row?.['X']);
          const away=num(row?.away,row?.Away,row?.two,row?.['2']);
          if(home) out.push({value:"1",odd:home,bookmaker});
          if(draw) out.push({value:"X",odd:draw,bookmaker});
          if(away) out.push({value:"2",odd:away,bookmaker});
          if(!home&&!draw&&!away) pushLabeled(bookmaker,row);
          if(Array.isArray(row?.outcomes)) for(const o of row.outcomes) pushLabeled(bookmaker,o);
        }
      }
    }
  }

  // Ignore long-shot prices AND overly short prices: the app only considers
  // odds between 1.50 (incluso) e 3.75. Sotto 1.50 il margine di guadagno
  // è troppo risicato per valere il rischio, anche quando il modello stima
  // una probabilità alta.
  // IMPORTANT: never replace the selected bookmaker with another book's price.
  // If a bookmaker is selected, every returned quote must come from that book.
  const filtered = out.filter(x => Number(x.odd) >= 1.5 && Number(x.odd) <= 3.75);
  const best = new Map();
  for (const x of filtered) {
    const old=best.get(x.value);
    if(!old || x.odd > old.odd) best.set(x.value,x);
  }
  return [...best.values()];
}

// Genera una frase di contesto solo quando la posizione in classifica dice
// davvero qualcosa (zona Champions o zona retrocessione) e ci sono
// abbastanza partite giocate perché la classifica sia significativa.
// A centro classifica o a inizio stagione non forziamo nessuna frase.
function standingContext(name, standing) {
  if (!standing || !Number.isFinite(standing.position) || !Number.isFinite(standing.totalTeams)) return null;
  if (!Number.isFinite(standing.playedGames) || standing.playedGames < 8) return null;
  const { position, totalTeams } = standing;
  if (position <= 4) return `${name} è in piena zona Champions League (${position}° posto)`;
  if (position > totalTeams - 3) return `${name} è invischiata nella lotta salvezza (${position}° posto su ${totalTeams})`;
  return null;
}

function buildMarkets(odds, homeStats, awayStats, h2hMatches, homeTeamId, awayTeamId, homeStanding, awayStanding) {
  const out = [];
  const h = summarize(homeStats?.matches, homeStats?.teamId);
  const a = summarize(awayStats?.matches, awayStats?.teamId);
  const h2h = summarizeH2H(h2hMatches, homeTeamId, awayTeamId);
  const homeNote = standingContext(homeStats?.teamName, homeStanding);
  const awayNote = standingContext(awayStats?.teamName, awayStanding);
  const standingNote = [homeNote, awayNote].filter(Boolean).join("; ") || null;

  const lambdaH = avg(h.gfHome != null ? h.gfHome : h.gf, a.gaAway != null ? a.gaAway : a.ga);
  const lambdaA = avg(a.gfAway != null ? a.gfAway : a.gf, h.gaHome != null ? h.gaHome : h.ga);
  const total = lambdaH != null && lambdaA != null ? lambdaH + lambdaA : null;
  const freq = marketFrequencies(homeStats?.matches, awayStats?.matches, homeStats?.teamId, awayStats?.teamId);
  const fair = fairProbabilities(odds);

  for (const o of odds) {
    if (!(Number(o.odd) >= 1.5 && Number(o.odd) <= 3.75)) continue;
    let pStat = null;
    if (total != null) {
      if (o.value === "Over 0.5") pStat = poissonAtLeast(total, 1) * 100;
      else if (o.value === "Under 0.5") pStat = poissonAtMost(total, 0) * 100;
      else if (o.value === "Over 1.5") pStat = poissonAtLeast(total, 2) * 100;
      else if (o.value === "Under 1.5") pStat = poissonAtMost(total, 1) * 100;
      else if (o.value === "Over 2.5") pStat = poissonAtLeast(total, 3) * 100;
      else if (o.value === "Under 2.5") pStat = poissonAtMost(total, 2) * 100;
      else if (o.value === "Over 3.5") pStat = poissonAtLeast(total, 4) * 100;
      else if (o.value === "Under 3.5") pStat = poissonAtMost(total, 3) * 100;
      else if (o.value === "Over 4.5") pStat = poissonAtLeast(total, 5) * 100;
      else if (o.value === "Under 4.5") pStat = poissonAtMost(total, 4) * 100;
    }
    if ((o.value === "Goal" || o.value === "No Goal") && lambdaH != null && lambdaA != null) {
      const yes = (1 - Math.exp(-lambdaH)) * (1 - Math.exp(-lambdaA));
      pStat = (o.value === "Goal" ? yes : 1 - yes) * 100;
    }
    if ((o.value === "1" || o.value === "X" || o.value === "2") && lambdaH != null && lambdaA != null) {
      const probs = poisson1x2(lambdaH, lambdaA);
      pStat = probs[o.value] * 100;
    }

    // Do not let a tiny historical sample create fake certainty.
    const sampleSize = Math.max(
      Array.isArray(homeStats?.matches) ? homeStats.matches.length : 0,
      Array.isArray(awayStats?.matches) ? awayStats.matches.length : 0
    );
    const pFreq = sampleSize >= 5 ? (freq[o.value] ?? null) : null;
    const pFair = fair[o.value] ?? (100 / o.odd);
    let prob, confidence;
    if (pStat != null && pFreq != null) {
      prob = pStat * 0.65 + pFreq * 0.20 + pFair * 0.15; confidence = 1;
    } else if (pStat != null) {
      prob = pStat * 0.80 + pFair * 0.20; confidence = 0.88;
    } else if (pFreq != null) {
      prob = pFreq * 0.70 + pFair * 0.30; confidence = 0.72;
    } else {
      prob = pFair; confidence = 0.40;
    }

    const edge = prob - (100 / o.odd);
    const formBonus = (h.form!=null && a.form!=null) ? clamp((h.form + a.form) * 1.2, -5, 5) : 0;

    // SCORE BASE: prima valutiamo la solidita' dello scenario, poi il valore
    // della quota. La quota NON puo' trasformare un'analisi debole in un TOP.
    const analysisParts=[];
    if (pStat != null) analysisParts.push([55, pStat]);
    if (pFreq != null) analysisParts.push([20, pFreq]);
    if (h.form!=null && a.form!=null) {
      const formSignal = clamp(50 + ((h.form + a.form) * 4.5), 0, 100);
      analysisParts.push([15, formSignal]);
    }
    if (h2h?.sample >= 2) {
      let h2hSignal = 50;
      if (o.value === "1") h2hSignal = 50 + (h2h.homeWins / h2h.sample) * 50;
      else if (o.value === "2") h2hSignal = 50 + (h2h.awayWins / h2h.sample) * 50;
      else if (o.value === "X") h2hSignal = 50 + (h2h.draws / h2h.sample) * 50;
      else if (o.value === "Goal") h2hSignal = h2h.bttsRate ?? 50;
      else if (o.value === "No Goal") h2hSignal = 100 - (h2h.bttsRate ?? 50);
      else if (String(o.value).startsWith("Over")) h2hSignal = h2h.overRate ?? 50;
      else if (String(o.value).startsWith("Under")) h2hSignal = 100 - (h2h.overRate ?? 50);
      analysisParts.push([10, clamp(h2hSignal,0,100)]);
    }
    const analysisWeight=analysisParts.reduce((a,x)=>a+x[0],0);
    const analysisScore=analysisWeight ? analysisParts.reduce((a,x)=>a+x[0]*x[1],0)/analysisWeight : 35;

    // La PROBABILITÀ è il segnale principale per il ranking.
    // La quota serve per misurare il valore (edge), non per far salire
    // artificialmente una previsione meno probabile.
    const valueScore = clamp(50 + 50 * Math.tanh(edge / 20), 0, 100);
    const probabilityScore = clamp(prob, 0, 100);
    // Ranking: probabilità 60%, supporto analitico 25%, valore quota 15%.
    // In questo modo un esito molto probabile e ben supportato precede
    // normalmente una quota alta ma meno probabile.
    let score = probabilityScore * 0.60 + analysisScore * 0.25 + valueScore * 0.15;
    // Se non abbiamo dati analitici reali, non consentiamo comunque una
    // promozione automatica dovuta alla sola quota.
    if (analysisWeight < 35) score = Math.min(score, Math.max(52, probabilityScore * 0.75));
    score = clamp(score, 0, 100);

    out.push({
      market: marketLabel(o.value), odds: o.odd, bookmaker: o.bookmaker || null, prob: round(prob), edge: round(edge),
      form: round(formBonus), absence: 0, pred: 0, confidence: round(confidence * 100),
      homeForm: h.form==null?null:round(h.form), awayForm: a.form==null?null:round(a.form),
      pStat: pStat == null ? null : round(pStat), pFreq: pFreq == null ? null : round(pFreq),
      pFair: round(pFair), score: round(score),
      reason: buildSimpleReason(o.value, prob, edge, pStat, pFreq, o.odd, {...o, homeName: homeStats?.teamName, awayName: awayStats?.teamName}, homeStats, awayStats, h2h, standingNote),
      h2h: h2h ? { sample:h2h.sample, homeWins:h2h.homeWins, draws:h2h.draws, awayWins:h2h.awayWins, overRate:h2h.overRate, bttsRate:h2h.bttsRate } : null,
      standingNote: standingNote
    });
  }
  return out;
}

function h2hSentence(value, home, away, h2h) {
  if (!h2h || h2h.sample < 2) return null; // meno di 2 precedenti non è un pattern, è rumore
  const { sample, homeWins, draws, awayWins, overRate, bttsRate } = h2h;
  if (value === "1" || value === "2" || value === "X") {
    if (homeWins/sample >= 0.6 && homeWins>=2) return `Negli ultimi ${sample} scontri diretti, ${home} ha vinto ${homeWins} volte.`;
    if (awayWins/sample >= 0.6 && awayWins>=2) return `Negli ultimi ${sample} scontri diretti, ${away} ha vinto ${awayWins} volte, anche fuori casa.`;
    if (draws/sample >= 0.5 && draws>=2) return `Negli ultimi ${sample} scontri diretti, il pareggio è uscito ${draws} volte.`;
    return null;
  }
  const overCount = Math.round(overRate*sample), underCount = sample - overCount;
  if (value === "Over 2.5" || value === "Over 3.5") { if (overRate >= 0.7) return `Negli ultimi ${sample} scontri diretti, le reti sono state spesso tante: Over 2.5 in ${overCount} occasioni su ${sample}.`; }
  if (value === "Under 2.5" || value === "Under 3.5") { if (overRate <= 0.3) return `Negli ultimi ${sample} scontri diretti, le reti sono state generalmente poche: Under 2.5 in ${underCount} occasioni su ${sample}.`; }
  const bttsCount = Math.round(bttsRate*sample);
  if (value === "Goal" && bttsRate >= 0.7) return `Negli ultimi ${sample} scontri diretti, entrambe le squadre hanno segnato in ${bttsCount} occasioni su ${sample}.`;
  if (value === "No Goal" && bttsRate <= 0.3) return `Negli ultimi ${sample} scontri diretti, almeno una delle due ha tenuto la porta inviolata in ${sample-bttsCount} occasioni su ${sample}.`;
  return null;
}

function buildSimpleReason(value, prob, edge, pStat, pFreq, odd, marketObj, homeStats, awayStats, h2h, standingNote) {
  const home = marketObj?.homeName || homeStats?.teamName || "La squadra di casa";
  const away = marketObj?.awayName || awayStats?.teamName || "la squadra ospite";
  const c = {
    home, away,
    _homeMatches: homeStats?.matches || [],
    _awayMatches: awayStats?.matches || [],
    _homeTeamId: homeStats?.teamId,
    _awayTeamId: awayStats?.teamId
  };
  const market = value === "1" ? "1 (Casa)" : value === "2" ? "2 (Trasferta)" : value === "X" ? "X (Pareggio)" : value;
  const text = fieldMatchReason(c, market);
  const h2hText = h2hSentence(value, home, away, h2h);
  const stripDot = s => String(s || "").replace(/\.\s*$/, "");
  const parts = [h2hText, standingNote, text].filter(Boolean).map(stripDot);
  if (parts.length) return parts.slice(0, 3).join("; ") + ".";
  if (value === "1" || value === "2" || value === "X") {
    const label = value === "1" ? "il segno 1" : value === "2" ? "il segno 2" : "il pareggio";
    if (Number.isFinite(odd) && Number.isFinite(edge) && edge > 0) {
      return `Non c'è una tendenza recente abbastanza netta da spiegare da sola ${label}: il modello lo segnala soprattutto perché la quota (${odd.toFixed(2)}) sembra più alta di quanto meriterebbe questo esito, un margine di valore stimato di circa il ${Math.round(edge)}%.`;
    }
    if (value === "1") return `${home} ha il fattore campo, ma i dati recenti disponibili non mostrano un vantaggio abbastanza concreto per sostenere il segno 1: valutalo con più cautela del solito.`;
    if (value === "2") return `${away} può avere elementi a favore, ma i dati recenti disponibili non mostrano un vantaggio abbastanza concreto per sostenere il segno 2: valutalo con più cautela del solito.`;
    return `Il confronto recente non mostra una squadra abbastanza superiore da rendere il pareggio una scelta nettamente sostenuta dal campo: valutalo con più cautela del solito.`;
  }
  if (Number.isFinite(odd) && Number.isFinite(edge) && edge > 0) {
    return `Per questa partita non abbiamo ancora abbastanza storico recente delle due squadre. La scelta si basa soprattutto sul confronto tra la quota proposta (${odd.toFixed(2)}) e quanto succede di solito in mercati simili, che lascia un margine di valore stimato di circa il ${Math.round(edge)}%.`;
  }
  return `Per questa partita non abbiamo ancora abbastanza storico recente delle due squadre per un giudizio più preciso: la valutazione resta soprattutto legata alla quota e va presa con più cautela del solito.`;
}

function marketLabel(v) {
  return ({"1":"1 (Casa)","X":"X (Pareggio)","2":"2 (Trasferta)"}[v]) || v;
}

function poisson1x2(lambdaH, lambdaA) {
  let home = 0, draw = 0, away = 0;
  for (let hg = 0; hg <= 8; hg++) {
    for (let ag = 0; ag <= 8; ag++) {
      const p = poissonProb(lambdaH, hg) * poissonProb(lambdaA, ag);
      if (hg > ag) home += p;
      else if (hg === ag) draw += p;
      else away += p;
    }
  }
  const sum = home + draw + away;
  return {"1": home / sum, "X": draw / sum, "2": away / sum};
}
function poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function fairProbabilities(odds) {
  const groups = [
    ["Over 0.5", "Under 0.5"],
    ["Over 1.5", "Under 1.5"],
    ["Over 2.5", "Under 2.5"],
    ["Over 3.5", "Under 3.5"],
    ["Over 4.5", "Under 4.5"],
    ["1", "X", "2"]
  ];
  const out = {};
  for (const values of groups) {
    const rows = odds.filter(x => values.includes(x.value) && x.odd > 1);
    if (rows.length < 2) continue;
    const raw = rows.map(x => ({ value: x.value, p: 1 / x.odd }));
    const sum = raw.reduce((s, x) => s + x.p, 0);
    for (const x of raw) out[x.value] = x.p / sum * 100;
  }
  return out;
}

function marketFrequencies(homeMatches, awayMatches, homeId, awayId) {
  const all = [];
  for (const m of [...(homeMatches || []), ...(awayMatches || [])]) {
    const hg = m.score?.fullTime?.home, ag = m.score?.fullTime?.away;
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const isHome = m.homeTeam?.id === homeId || m.homeTeam?.id === awayId;
    const isAway = m.awayTeam?.id === homeId || m.awayTeam?.id === awayId;
    if (!isHome && !isAway) continue;
    all.push({ total: hg + ag, btts: hg > 0 && ag > 0, home: m.homeTeam?.id === homeId, draw: hg === ag });
  }
  if (!all.length) return {};
  const homeCount = all.filter(x => x.home && !x.draw && x.total >= 0).length;
  const awayCount = all.filter(x => !x.home && !x.draw && x.total >= 0).length;
  return {
    "Over 2.5": pct(all.filter(x => x.total > 2.5).length, all.length),
    "Under 2.5": pct(all.filter(x => x.total <= 2.5).length, all.length),
    "Over 3.5": pct(all.filter(x => x.total > 3.5).length, all.length),
    "Under 3.5": pct(all.filter(x => x.total <= 3.5).length, all.length),
    "Goal": pct(all.filter(x => x.btts).length, all.length),
    "No Goal": pct(all.filter(x => !x.btts).length, all.length),
    "1": pct(all.filter(x => x.home && !x.draw).length, all.length),
    "X": pct(all.filter(x => x.draw).length, all.length),
    "2": pct(all.filter(x => !x.home && !x.draw).length, all.length)
  };
}

function pct(n, d) { return d ? n / d * 100 : null; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function summarizeH2H(matches, homeTeamId, awayTeamId) {
  const rows = Array.isArray(matches) ? matches : [];
  const relevant = rows.filter(m => Number.isFinite(m?.score?.fullTime?.home) && Number.isFinite(m?.score?.fullTime?.away));
  if (!relevant.length) return null;
  let homeWins=0, awayWins=0, draws=0, overCount=0, bttsCount=0;
  for (const m of relevant) {
    const hg=m.score.fullTime.home, ag=m.score.fullTime.away;
    const isHomeTeamHome = m.homeTeam?.id === homeTeamId;
    const gfHomeTeam = isHomeTeamHome ? hg : ag;
    const gfAwayTeam = isHomeTeamHome ? ag : hg;
    if (gfHomeTeam > gfAwayTeam) homeWins++;
    else if (gfHomeTeam < gfAwayTeam) awayWins++;
    else draws++;
    if (hg+ag >= 3) overCount++;
    if (hg>0 && ag>0) bttsCount++;
  }
  return {
    sample: relevant.length,
    homeWins, awayWins, draws,
    overRate: overCount/relevant.length,
    bttsRate: bttsCount/relevant.length
  };
}

function summarize(ms, teamId) {
  const rows = Array.isArray(ms) ? ms.filter(m => Number.isFinite(m?.score?.fullTime?.home) && Number.isFinite(m?.score?.fullTime?.away)) : [];
  if (!rows.length) return { gf:null,ga:null,gfHome:null,gaHome:null,gfAway:null,gaAway:null,form:null,sample:0,homeSample:0,awaySample:0 };
  const ordered = [...rows].sort((a,b)=>new Date(a?.utcDate||0)-new Date(b?.utcDate||0));
  let gf=0,ga=0,weightSum=0,homeGF=0,homeGA=0,homeW=0,awayGF=0,awayGA=0,awayW=0,points=0,pointsW=0;
  const recent = ordered.slice(-8);
  recent.forEach((m,idx)=>{
    const hg=m.score.fullTime.home, ag=m.score.fullTime.away;
    // Peso crescente: le ultime partite contano di più, ma non cancelliamo lo storico.
    const w=1 + (idx/(Math.max(1,recent.length-1))) * 0.75;
    const isHome = m.homeTeam?.id === teamId;
    const isAway = m.awayTeam?.id === teamId;
    if(!isHome && !isAway) return;
    const gfor=isHome?hg:ag, gagain=isHome?ag:hg;
    gf += gfor*w; ga += gagain*w; weightSum += w;
    if(isHome){homeGF += hg*w; homeGA += ag*w; homeW += w;}
    if(isAway){awayGF += ag*w; awayGA += hg*w; awayW += w;}
    if(teamId){
      const p=m.score.winner==='DRAW'?1:((m.score.winner==='HOME'&&isHome)||(m.score.winner==='AWAY'&&isAway)?3:0);
      points += p*w; pointsW += w;
    }
  });
  return {
    gf:weightSum?gf/weightSum:null, ga:weightSum?ga/weightSum:null,
    gfHome:homeW?homeGF/homeW:null, gaHome:homeW?homeGA/homeW:null,
    gfAway:awayW?awayGF/awayW:null, gaAway:awayW?awayGA/awayW:null,
    form:pointsW?points/pointsW:null,
    sample:recent.length, homeSample:ordered.filter(m=>m.homeTeam?.id===teamId).length, awaySample:ordered.filter(m=>m.awayTeam?.id===teamId).length
  };
}
function avg(a,b){return a!=null&&b!=null?(a+b)/2:null}
function round(x){return Math.round(x*10)/10}
function poissonAtLeast(lambda,k){
  if(!(lambda>0))return 0;
  let c=0;
  for(let i=0;i<k;i++)c+=Math.exp(-lambda)*Math.pow(lambda,i)/factorial(i);
  return 1-c
}
function poissonAtMost(lambda,k){
  if(!(lambda>0))return 1;
  let c=0;
  for(let i=0;i<=k;i++)c+=Math.exp(-lambda)*Math.pow(lambda,i)/factorial(i);
  return c
}
function factorial(n){let x=1;for(let i=2;i<=n;i++)x*=i;return x}

// Wrapper di sicurezza: Vercel deve sempre restituire JSON anche in caso di
// eccezione imprevista, evitando che il frontend tenti JSON.parse su HTML.
export default async function safeHandler(req, res) {
  try {
    return await handler(req, res);
  } catch (e) {
    console.error("AI DEL PALLONE /api/pick error", e);
    if (!res.headersSent) {
      res.status(500).json({
        error: `Errore interno durante l'analisi: ${e?.message || String(e)}`,
        detail: e?.stack || e?.message || String(e)
      });
    }
  }
}
