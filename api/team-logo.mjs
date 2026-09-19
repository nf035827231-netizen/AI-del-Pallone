// V154: niente API-Football per gli stemmi.
// Gli stemmi delle partite arrivano direttamente dalla fonte ESPN nel payload pick.
// Per le vecchie giocate restituiamo null e il frontend usa le iniziali della squadra.
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const u=new URL(req.url,'https://vercel.local');
  const team=u.searchParams.get('team')||'';
  return res.status(200).json({logo:null,resolvedName:team||null,teamId:null,source:'none-v154'});
}
