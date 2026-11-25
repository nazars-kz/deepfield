// Fetches the open datasets used by simulator.html and stores compact copies in ./data
//   node tools/fetch-data.mjs            → plates, volcanoes, earthquakes
//   node tools/fetch-data.mjs elevation  → global elevation / bathymetry grid (ETOPO1 via OpenTopoData, ~5 min)
// Sources:
//   Plate boundaries: Bird (2003) PB2002, GeoJSON by github.com/fraxen/tectonicplates
//   Volcanoes: Smithsonian Institution, Global Volcanism Program — Volcanoes of the World
//   Earthquakes: USGS Earthquake Catalog (ComCat)
//   Elevation: NOAA ETOPO1 served by api.opentopodata.org
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(root, { recursive: true });
const save = (name, obj) => { fs.writeFileSync(path.join(root, name), JSON.stringify(obj)); console.log('saved', name, (fs.statSync(path.join(root, name)).size / 1024).toFixed(0) + ' KB'); };
const r2 = (v) => Math.round(v * 100) / 100;
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function plates() {
  const CLASSES = ['SUB', 'OSR', 'OTF', 'CTF', 'CRB', 'CCB', 'OCB'];
  const steps = await getJSON('https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_steps.json');
  const s = steps.features.map(({ properties: p }) => [r2(p.STARTLONG), r2(p.STARTLAT), r2(p.FINALLONG), r2(p.FINALLAT), CLASSES.indexOf(p.STEPCLASS), r2(p.VELOCITYLE), p.PLATEBOUND]);
  const pl = await getJSON('https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_plates.json');
  const plates = pl.features.map((f) => ({
    code: f.properties.Code, name: f.properties.PlateName,
    rings: (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) => poly[0].map(([x, y]) => [r2(x), r2(y)])),
  }));
  save('plates.json', { classes: CLASSES, steps: s, plates });
}

async function volcanoes() {
  const j = await getJSON('https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json');
  const v = j.features.map(({ properties: p, geometry: g }) => [r2(g.coordinates[1]), r2(g.coordinates[0]), p.Volcano_Name, p.Primary_Volcano_Type, p.Last_Eruption_Year ?? null, p.Country]);
  save('volcanoes.json', v);
}

async function quakes() {
  const out = [];
  for (const [a, b] of [['1980-01-01', '2000-01-01'], ['2000-01-01', '2013-01-01'], ['2013-01-01', '2026-11-24']]) {
    const j = await getJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${a}&endtime=${b}&minmagnitude=5.5&orderby=time-asc`);
    j.features.forEach(({ properties: p, geometry: g }) => out.push([r2(g.coordinates[1]), r2(g.coordinates[0]), Math.round(p.mag * 10) / 10, Math.round(g.coordinates[2]), new Date(p.time).getUTCFullYear()]));
    console.log('quakes', a, b, j.features.length);
  }
  save('quakes.json', out);
}

async function elevation() {
  // 240 × 120 grid (1.5°), cell centres; ETOPO1 includes bathymetry
  const W = 240, H = 120, grid = new Array(W * H).fill(null);
  const pts = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) pts.push([90 - (j + 0.5) * (180 / H), -180 + (i + 0.5) * (360 / W)]);
  for (let k = 0; k < pts.length; k += 100) {
    const chunk = pts.slice(k, k + 100);
    const q = chunk.map(([la, lo]) => `${la.toFixed(3)},${lo.toFixed(3)}`).join('|');
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const j = await getJSON(`https://api.opentopodata.org/v1/etopo1?locations=${q}`);
        j.results.forEach((r, i) => (grid[k + i] = Math.round(r.elevation)));
        break;
      } catch (e) { console.log('retry', k, e.message); await sleep(3000); }
    }
    if ((k / 100) % 20 === 0) console.log('elevation', k, '/', pts.length);
    await sleep(1100);
  }
  save('elevation.json', { w: W, h: H, source: 'NOAA ETOPO1 via OpenTopoData', data: grid });
}

const which = process.argv[2];
if (which === 'elevation') await elevation();
else { await plates(); await volcanoes(); await quakes(); }
