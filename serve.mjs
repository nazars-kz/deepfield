import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };

// /api/elev?locations=lat,lon|lat,lon&dataset=gebco2020 → proxied to api.opentopodata.org (no CORS there).
// Public API limits: 100 locations / request, 1 request / second, 1000 / day — so requests are queued and cached.
const cache = new Map();
let chain = Promise.resolve(), lastCall = 0;
function topo(dataset, locations) {
  const key = `${dataset}:${locations}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const run = async () => {
    const wait = Math.max(0, lastCall + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(locations)}`);
    const body = await r.text();
    if (r.ok) cache.set(key, body);
    return body;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/elev') {
    const dataset = ['gebco2020', 'etopo1'].includes(url.searchParams.get('dataset')) ? url.searchParams.get('dataset') : 'gebco2020';
    const locations = (url.searchParams.get('locations') || '').slice(0, 4000);
    if (!/^[-0-9.,|]+$/.test(locations)) { res.writeHead(400); return res.end('bad locations'); }
    try { const body = await topo(dataset, locations); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); }
    catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('404'); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(d); });
}).listen(5178, () => console.log('http://localhost:5178'));
