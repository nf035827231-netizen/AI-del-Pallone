const SUPA_URL=process.env.SUPABASE_URL||'';
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||'';

async function supa(path){
  const r=await fetch(`${SUPA_URL}/rest/v1/${path}`,{
    headers:{
      apikey:SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`
    }
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t?JSON.parse(t):[];
}

function norm(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
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
    .sort((a,b)=>Number(a.price)-Number(b.price));
  return sorted[0]||null;
}

function bestLay(list){
  if(!Array.isArray(list)||!list.length) return null;
  const sorted=[...list].filter(x=>Number.isFinite(Number(x.price))&&Number(x.price)>1)
    .sort((a,b)=>Number(a.price)-Number(b.price));
  return sorted[0]||null;
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')
    return res.status(405).json({ok:false,error:'Metodo non consentito'});

  const u=new URL(req.url,'https://vercel.local');
  const home=norm(u.searchParams.get('home'));
  const away=norm(u.searchParams.get('away'));

  if(!home||!away)
    return res.status(400).json({ok:false,error:'home e away obbligatori'});

  if(!SUPA_URL||!SERVICE_KEY)
    return res.status(500).json({ok:false,error:'Supabase service key non configurata'});

  try{
    const rows=await supa(
      'betfair_quotes?select=id,data_type,payload,received_at&data_type=eq.catalogue&order=received_at.desc&limit=50'
    );

    const markets=[];
    for(const row of rows){
      for(const m of unwrapResults(row.payload)){
        markets.push({...m,received_at:row.received_at});
      }
    }

    const matching=markets.filter(m=>{
      const n=norm(m.event?.name);
      return (n.includes(home)&&n.includes(away))||(n.includes(away)&&n.includes(home));
    });

    if(!matching.length)
      return res.status(404).json({ok:false,error:'Mercato Betfair non trovato',home,away});

    // Calcio: includiamo SOLO Match Odds (1X2) e Under/Over Goal.
    // Tutti gli altri mercati vengono esclusi.
    const selected=matching.filter(m=>{
      const name=String(m.marketName||'');
      return /match odds|1x2|esito finale/i.test(name) ||
             /under.*over|over.*under/i.test(name);
    });

    const allowed=selected.filter(m=>{
      const name=String(m.marketName||'');
      // Under/Over: solo linee goal classiche 0.5, 1.5, 2.5, 3.5, 4.5.
      if(/under.*over|over.*under/i.test(name)){
        return /(?:0\.5|1\.5|2\.5|3\.5|4\.5)/.test(name);
      }
      return /match odds|1x2|esito finale/i.test(name);
    });

    if(!allowed.length)
      return res.status(404).json({ok:false,error:'Nessun mercato 1X2 o Under/Over trovato',home,away});

    const output=[];
    for(const found of allowed.slice(0,8)){
      const books=await supa(
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
        const lay=bestLay(r?.ex?.availableToLay);
        return {
          selectionId:r.selectionId,
          name:bySelection.get(String(r.selectionId))||String(r.selectionId),
          status:r.status,
          backPrice:back?.price??null,
          backSize:back?.size??null,
          layPrice:lay?.price??null,
          laySize:lay?.size??null
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

    return res.status(200).json({
      ok:true,
      event:matching[0].event,
      competition:matching[0].competition,
      markets:output
    });
  }catch(e){
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
