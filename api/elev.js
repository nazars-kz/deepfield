// Vercel serverless twin of the /api/elev proxy in serve.mjs.
// GET /api/elev?dataset=gebco2020|etopo1&locations=lat,lon|lat,lon
// OpenTopoData has no CORS and allows ~1 request/s, so we retry once on 429
// and let Vercel's CDN cache identical lookups for a day.
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const dataset = ['gebco2020', 'etopo1'].includes(url.searchParams.get('dataset')) ? url.searchParams.get('dataset') : 'gebco2020';
  const locations = (url.searchParams.get('locations') || '').slice(0, 4000);
  if (!/^[-0-9.,|]+$/.test(locations)) { res.statusCode = 400; return res.end('bad locations'); }
  const target = `https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(locations)}`;
  try {
    let r = await fetch(target);
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1200)); r = await fetch(target); }
    const body = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    if (r.ok) res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message }));
  }
};
