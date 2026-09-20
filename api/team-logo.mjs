// Gli stemmi sono opzionali. Il modello non dipende da una fonte esterna per la grafica.
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');const u=new URL(req.url,'https://vercel.local');const team=u.searchParams.get('team')||'';return res.status(200).json({logo:null,resolvedName:team||null,teamId:null,source:'none'});}
