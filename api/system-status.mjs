// Pannello "salute del sistema": aggrega tutto quello che serve per sapere a colpo
// d'occhio se l'app sta funzionando, SENZA MAI testare le fonti dal vivo (zero chiamate
// esterne, zero costo sul budget). Legge solo righe già scritte da pick.mjs, dal bridge
// e dal contatore giornaliero API-Football.

const SUPA_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const API_FOOTBALL_DAILY_BUDGET = 85;

async function supaRead(path){
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` }
  });
  const text = await r.text();
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,300)}`);
  return text ? JSON.parse(text) : [];
}

function minutesAgo(iso){
  if(!iso) return null;
  return Math.round((Date.now()-new Date(iso).getTime())/60000);
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(!SUPA_URL || !SERVICE_KEY)
    return res.status(500).json({error:'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata'});

  try{
    const today = new Date().toISOString().slice(0,10);
    const [statusRows, catalogueRows, budgetRows, fundsRows] = await Promise.all([
      supaRead('system_status?select=*&id=eq.latest').catch(()=>[]),
      supaRead('betfair_quotes?select=received_at&data_type=eq.catalogue&order=received_at.desc&limit=1').catch(()=>[]),
      supaRead(`api_football_daily?select=calls_used&usage_date=eq.${today}`).catch(()=>[]),
      supaRead('betfair_account?select=payload,received_at&data_type=eq.funds').catch(()=>[])
    ]);

    const status = statusRows?.[0] || null;
    const bridgeLastSync = catalogueRows?.[0]?.received_at || null;
    const apiFootballUsed = budgetRows?.[0]?.calls_used ?? 0;
    const fundsRow = fundsRows?.[0] || null;

    return res.status(200).json({
      lastAnalysis: status ? {
        checkedAt: status.checked_at,
        minutesAgo: minutesAgo(status.checked_at),
        analyzedDate: status.analyzed_date,
        footballDataWorking: status.football_data_working,
        espnWorking: status.espn_working,
        apiFootballWorking: status.api_football_working,
        picksReturned: status.picks_returned,
        poolUsed: status.pool_used,
        calibrationFactor: status.calibration_factor
      } : null,
      betfairBridge: {
        lastSync: bridgeLastSync,
        minutesAgo: minutesAgo(bridgeLastSync),
        stale: bridgeLastSync ? minutesAgo(bridgeLastSync) > 20*60 : true // oltre 20 ore = probabilmente fuori dalla finestra utile
      },
      apiFootballBudget: {
        usedToday: apiFootballUsed,
        limit: API_FOOTBALL_DAILY_BUDGET,
        remaining: Math.max(0, API_FOOTBALL_DAILY_BUDGET - apiFootballUsed)
      },
      betfairFunds: fundsRow ? {
        availableToBetBalance: fundsRow.payload?.availableToBetBalance ?? null,
        minutesAgo: minutesAgo(fundsRow.received_at)
      } : null
    });
  }catch(e){
    return res.status(500).json({error:e?.message||String(e)});
  }
}
