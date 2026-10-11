// POST → scrittura dal bridge locale (sincronizzazione mercati/quote, era già qui).
// GET  → lettura quote live per il pannello del singolo pick (era betfair-odds.mjs).
// Accorpati in un solo file per restare sotto il limite di funzioni serverless
// del piano Vercel gratuito.

const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BRIDGE_TOKEN = process.env.BETFAIR_BRIDGE_TOKEN || '';

function auth(req){
  const h = req.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers?.['x-betfair-bridge-token'] || '');
  return BRIDGE_TOKEN && token === BRIDGE_TOKEN;
}

// Per le scritture del bridge (POST): accetta method/body extra.
async function supaWriteCall(path, init={}){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers:{
      apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`,
      'Content-Type':'application/json', Prefer:'return=minimal',
      ...(init.headers||{})
    }
  });
  const text = await r.text();
  if(!r.ok){ console.error("SUPABASE ERROR:", r.status, text); throw new Error(`Supabase ${r.status}: ${text}`); }
  try { return text ? JSON.parse(text) : null; } catch { return text || null; }
}

// Per le letture del pannello live (GET): sempre array su risposta vuota.
async function supaReadCall(path){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` } });
  const t = await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : [];
}

function norm(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
}

function teamMatchKey(s){
  return norm(s)
    .replace(/\b(fc|cf|sc|ac|afc|fk|sk|club|calcio|football|futbol|de|the)\b/g,' ')
    .replace(/\b(1st|first|ii)\b/g,' ')
    .replace(/\d{2,4}/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function teamSimilarity(a,b){
  const aa=teamMatchKey(a), bb=teamMatchKey(b);
  if(!aa||!bb)return 0;
  if(aa===bb)return 1;
  if(aa.includes(bb)||bb.includes(aa))return 0.94;
  const A=new Set(aa.split(' ').filter(x=>x.length>2));
  const B=new Set(bb.split(' ').filter(x=>x.length>2));
  if(!A.size||!B.size)return 0;
  let common=0; for(const x of A) if(B.has(x))common++;
  const jaccard=common/(A.size+B.size-common);
  const containment=common/Math.min(A.size,B.size);
  return Math.max(jaccard,containment*0.92);
}

function clean(s){return norm(s).replace(/\b(fc|cf|afc|calcio|ac|as|ssc|cfc|fk|sk|sv|bk|sc|club)\b/g,'').replace(/[^a-z0-9]+/g,'').trim();}
function normalizePair(a,b){return `${clean(a)}|${clean(b)}`;}

function eventTeams(name){
  const parts=String(name||'').split(/\s+v\s+|\s+vs\.?\s+|\s+-\s+/i);
  if(parts.length<2)return null;
  return {home:parts[0].trim(),away:parts.slice(1).join(' ').trim()};
}

function sameEvent(home,away,eventName){
  const teams=eventTeams(eventName);
  if(!teams)return {ok:false,score:0};
  const hs=teamSimilarity(home,teams.home), as=teamSimilarity(away,teams.away);
  const revhs=teamSimilarity(home,teams.away), revas=teamSimilarity(away,teams.home);
  const direct=(hs+as)/2, reverse=(revhs+revas)/2;
  return {ok:Math.max(hs,revhs)>=0.50 && Math.max(as,revas)>=0.50,score:Math.max(direct,reverse)};
}

function unwrapResults(payload){
  let out=[];
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

function bestPrice(list){
  if(!Array.isArray(list)||!list.length) return null;
  const sorted=[...list].filter(x=>Number.isFinite(Number(x.price))&&Number(x.price)>1)
    .sort((a,b)=>Number(b.price)-Number(a.price));
  return sorted[0]||null;
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET') return handleGetOdds(req,res);
  if(req.method==='POST') return handlePostSync(req,res);
  return res.status(405).json({ok:false,error:'Metodo non consentito'});
}

// --- GET: quote live per un singolo pick (era betfair-odds.mjs) --------------------------
async function handleGetOdds(req,res){
  const u=new URL(req.url,'https://vercel.local');
  const home=norm(u.searchParams.get('home'));
  const away=norm(u.searchParams.get('away'));

  if(!home||!away)
    return res.status(400).json({ok:false,error:'home e away obbligatori'});
  if(!SUPA_URL||!SERVICE_KEY)
    return res.status(500).json({ok:false,error:'Supabase service key non configurata'});

  try{
    const rows=await supaReadCall(
      'betfair_quotes?select=id,data_type,payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=1'
    );

    const markets=[];
    for(const row of rows){
      for(const m of unwrapResults(row.payload)){
        markets.push({...m,received_at:row.received_at});
      }
    }

    const exactKeyDirect=normalizePair(home,away), exactKeyRev=normalizePair(away,home);
    let matching=markets.filter(m=>{
      const t=eventTeams(m.event?.name);
      if(!t)return false;
      const k=normalizePair(t.home,t.away);
      return k===exactKeyDirect||k===exactKeyRev;
    });
    let matchScore=1;
    if(!matching.length){
      let bestScore=0;
      const grouped=new Map();
      for(const m of markets){
        const key=norm(m.event?.name||'');
        if(!key)continue;
        const sim=sameEvent(home,away,m.event?.name||'');
        if(sim.ok && sim.score>bestScore){bestScore=sim.score;grouped.clear();grouped.set(key,m);}
        else if(sim.ok && Math.abs(sim.score-bestScore)<0.0001) grouped.set(key,m);
      }
      matching=[...grouped.values()];
      matchScore=bestScore;
    }

    if(!matching.length)
      return res.status(404).json({ok:false,error:'Mercato Betfair non trovato',home,away});

    const selected=matching.filter(m=>{
      const name=String(m.marketName||'');
      return /match odds|1x2|esito finale/i.test(name) ||
             /under.*over|over.*under/i.test(name) ||
             /both teams to score|goal.*no.?goal|gg.*ng/i.test(name);
    });

    const allowed=selected.filter(m=>{
      const name=String(m.marketName||'');
      if(/under.*over|over.*under/i.test(name)){
        return /(?:2\.5|3\.5)/.test(name);
      }
      if(/both teams to score|goal.*no.?goal|gg.*ng/i.test(name)) return true;
      return /match odds|1x2|esito finale/i.test(name);
    });

    if(!allowed.length)
      return res.status(404).json({ok:false,error:'Nessun mercato 1X2, Under/Over 2.5-3.5 o Goal/No Goal trovato',home,away});

    const marketParam=String(u.searchParams.get('market')||'').trim();
    let narrowed=allowed;
    if(marketParam){
      const lineMatch=marketParam.match(/(Over|Under)\s+(2\.5|3\.5)/i);
      const is1x2=/^[12x]\b/i.test(marketParam)||/casa|trasferta|pareggio/i.test(marketParam);
      const isBtts=/^goal$|^no goal$/i.test(marketParam);
      if(lineMatch){
        const line=lineMatch[2];
        narrowed=allowed.filter(m=>/under.*over|over.*under/i.test(String(m.marketName||''))&&String(m.marketName||'').includes(line));
      }else if(isBtts){
        narrowed=allowed.filter(m=>/both teams to score|goal.*no.?goal|gg.*ng/i.test(String(m.marketName||'')));
      }else if(is1x2){
        narrowed=allowed.filter(m=>/match odds|1x2|esito finale/i.test(String(m.marketName||'')));
      }
      if(!narrowed.length) narrowed=allowed;
    }

    const uniqueAllowed=[...new Map(narrowed.map(m=>[String(m.marketId),m])).values()];
    const output=[];
    for(const found of uniqueAllowed.slice(0,8)){
      const books=await supaReadCall(
        `betfair_quotes?select=payload,received_at&data_type=eq.book&market_id=eq.${encodeURIComponent(found.marketId)}&order=received_at.desc&limit=1`
      );

      const book=books[0]?.payload||null;
      const runners=Array.isArray(book?.runners)?book.runners:[];
      const catalogueRunners=Array.isArray(found.runners)?found.runners:[];
      const bySelection=new Map(
        catalogueRunners.map(r=>[String(r.selectionId),r.runnerName||r.name||String(r.selectionId)])
      );

      const normalized=runners.map(r=>{
        const back=bestPrice(r?.ex?.availableToBack);
        return {
          selectionId:r.selectionId,
          name:bySelection.get(String(r.selectionId))||String(r.selectionId),
          status:r.status,
          backPrice:back?.price??null,
          backSize:back?.size??null
        };
      });

      output.push({
        marketId:found.marketId,
        marketName:found.marketName||'',
        event:found.event,
        competition:found.competition,
        runners:normalized,
        receivedAt:books[0]?.received_at||found.received_at
      });
    }

    return res.status(200).json({ ok:true, event:matching[0].event, competition:matching[0].competition, markets:output, matchScore });
  }catch(e){
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}

// --- POST: sincronizzazione dal bridge locale (comportamento originale) ------------------
async function handlePostSync(req,res){
  if(!auth(req))
    return res.status(401).json({ok:false,error:'Token bridge non valido'});
  if(!SUPA_URL || !SERVICE_KEY)
    return res.status(500).json({ ok:false, error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const type = body.type;
    const payload = body.payload;

    if(!['catalogue','book'].includes(type) || !payload)
      return res.status(400).json({ ok:false, error:'type deve essere catalogue o book' });

    const receivedAt = new Date().toISOString();

    if(type === 'book'){
      let arr = payload;
      if (Array.isArray(arr)) {
        arr = arr.flatMap(item => {
          if (Array.isArray(item)) return item;
          if (Array.isArray(item?.result)) return item.result;
          if (Array.isArray(item?.result?.result)) return item.result.result;
          return item?.marketId ? [item] : [];
        });
      } else if (arr && Array.isArray(arr.result)) {
        arr = arr.result;
      } else if (arr?.result && Array.isArray(arr.result.result)) {
        arr = arr.result.result;
      } else {
        arr = [];
      }

      const markets = arr.filter(x => x?.marketId);
      if(!markets.length)
        throw new Error(`Nessun marketId nel market book (payload ricevuto: ${JSON.stringify(payload).slice(0,500)})`);

      for(const market of markets){
        await supaWriteCall('betfair_quotes', {
          method:'POST',
          body:JSON.stringify({ market_id:market.marketId, data_type:'book', payload:market, received_at:receivedAt })
        });
      }

      return res.status(200).json({ ok:true, type, markets:markets.length, receivedAt });
    }

    await supaWriteCall('betfair_quotes', {
      method:'POST',
      body:JSON.stringify({ market_id:null, data_type:type, payload, received_at:receivedAt })
    });

    return res.status(200).json({ ok:true, type, receivedAt });
  }catch(e){
    console.error("BETFAIR SYNC ERROR:", e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
