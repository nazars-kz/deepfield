import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COMMODITIES, PROVINCES, PRESETS, CLASS_INFO, PRICE_NOTE } from './sim-data.js';

const { gsap } = window;
gsap.ticker.lagSmoothing(0);

/* =========================================================
   Utils
   ========================================================= */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2, D2R = Math.PI / 180, R_EARTH = 6371;
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (v) => (v >= 1e12 ? `$${fmt(v / 1e12, 2)} T` : v >= 1e9 ? `$${fmt(v / 1e9, 1)} B` : v >= 1e6 ? `$${fmt(v / 1e6, 0)} M` : `$${fmt(v / 1e3, 0)} k`);
const qty = (v) => (v >= 1e9 ? `${fmt(v / 1e9, 2)} B` : v >= 1e6 ? `${fmt(v / 1e6, 1)} M` : v >= 1e3 ? `${fmt(v / 1e3, 0)} k` : fmt(v, 0));
const latStr = (v) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? 'N' : 'S'}`;
const lonStr = (v) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? 'E' : 'W'}`;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function hav(la1, lo1, la2, lo2) {
  const a = Math.sin(((la2 - la1) * D2R) / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(((lo2 - lo1) * D2R) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}
const dirFromLatLon = (lat, lon, r = 1) => new THREE.Vector3(Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), -Math.cos(lat * D2R) * Math.sin(lon * D2R)).multiplyScalar(r);
const latLonFromDir = (v) => { const n = v.clone().normalize(); return { lat: Math.asin(n.y) / D2R, lon: Math.atan2(-n.z, n.x) / D2R }; };
// value noise for the local site
const vnoise = (() => {
  const P = new Uint8Array(512); const r = mulberry32(7); const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  const h = (x, y) => P[(P[x & 255] + y) & 255] / 255;
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi; const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1; };
})();
const fbm = (x, y, o = 4) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; } return s; };

/* =========================================================
   State
   ========================================================= */
const S = {
  phase: 'place', // place | scanning | results
  view: 'globe',  // globe | site
  site: null,
  params: { radius: 10, depth: 5 },
  tab: 'res',
  style: 'seismic',
  deploy: true,
  results: null,
  hazards: null,
  prior: null,
  hot: -1,
};
const DATA = { plates: null, volc: [], quakes: [], elev: null, mask: null, live: [] };

/* =========================================================
   Data loading
   ========================================================= */
const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
function loadMask() {
  return new Promise((res) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = 2048, h = 1024, c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
      res({ img, data: x.getImageData(0, 0, w, h).data, w, h });
    };
    img.onerror = () => res(null);
    img.src = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-water.png';
  });
}
function loadImg(src, sampleW = 0) {
  return new Promise((res) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!sampleW) return res({ img });
      const w = sampleW, h = sampleW / 2, c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
      res({ img, data: x.getImageData(0, 0, w, h).data, w, h });
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}
function sampleImg(im, lat, lon) {
  if (!im?.data) return [0, 0, 0];
  const u = ((Math.floor(((lon + 180) / 360) * im.w) % im.w) + im.w) % im.w, v = clamp(Math.floor(((90 - lat) / 180) * im.h), 0, im.h - 1);
  const o = (v * im.w + u) * 4; return [im.data[o] / 255, im.data[o + 1] / 255, im.data[o + 2] / 255];
}
function waterAt(lat, lon) {
  const m = DATA.mask; if (!m) return elevRaw(lat, lon) < 0;
  const u = Math.floor(((lon + 180) / 360) * m.w) % m.w, v = clamp(Math.floor(((90 - lat) / 180) * m.h), 0, m.h - 1);
  return m.data[(v * m.w + u) * 4] > 128;
}
function elevRaw(lat, lon) {
  const g = DATA.elev; if (!g) return 0;
  const fx = ((lon + 180) / 360) * g.w - 0.5, fy = ((90 - lat) / 180) * g.h - 0.5;
  const x0 = Math.floor(fx), y0 = clamp(Math.floor(fy), 0, g.h - 1), y1 = clamp(y0 + 1, 0, g.h - 1);
  const tx = fx - x0, ty = clamp(fy - y0, 0, 1);
  const at = (x, y) => g.data[y * g.w + (((x % g.w) + g.w) % g.w)] ?? 0;
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y1), at(x0 + 1, y1), tx), ty);
}
function surfaceAt(lat, lon) {
  const water = waterAt(lat, lon);
  let e = elevRaw(lat, lon);
  if (!DATA.elev) e = water ? -3800 : 400;
  if (water) e = Math.min(e, -40); else e = Math.max(e, 1);
  return { water, elev: e };
}
function eligibility(water, elev) {
  if (water) { const d = -elev; return { ok: d <= 2000, rule: 'depth', value: d }; }
  return { ok: elev <= 3000, rule: 'alt', value: elev };
}

/* =========================================================
   Geology & hazard models
   ========================================================= */
function plateAt(lat, lon) {
  if (!DATA.plates) return null;
  const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  for (const p of DATA.plates.plates) for (const r of p.rings) if (inRing(r, lon, lat) || inRing(r, lon + 360, lat) || inRing(r, lon - 360, lat)) return p;
  return null;
}
const plateName = (code) => DATA.plates?.plates.find((p) => p.code === code)?.name || code;

function tectonics(lat, lon) {
  if (!DATA.plates) return null;
  let best = null;
  const near = new Map();
  for (const s of DATA.plates.steps) {
    const [lo1, la1, lo2, la2, cls, vel, pair] = s;
    const d = Math.min(hav(lat, lon, la1, lo1), hav(lat, lon, la2, lo2), hav(lat, lon, (la1 + la2) / 2, (lo1 + lo2) / 2));
    if (!best || d < best.dist) best = { dist: d, cls, vel, pair };
    const key = `${pair}:${cls}`;
    if (!near.has(key) || near.get(key).dist > d) near.set(key, { dist: d, cls, vel, pair });
  }
  const list = [...near.values()].sort((a, b) => a.dist - b.dist).slice(0, 3);
  const plate = plateAt(lat, lon);
  return { ...best, info: CLASS_INFO[best.cls] || CLASS_INFO[0], plate, list };
}

function hazards(lat, lon, tect) {
  const R = 300;
  const qs = [];
  for (const q of DATA.quakes) { if (Math.abs(q[0] - lat) > 4 && Math.abs(q[0] - lat) > R / 111) continue; const d = hav(lat, lon, q[0], q[1]); if (d <= R) qs.push({ lat: q[0], lon: q[1], mag: q[2], depth: q[3], year: q[4], d }); }
  const years = 2026.9 - 1980;
  const rate = qs.length / years;
  const maxQ = qs.reduce((m, q) => (!m || q.mag > m.mag ? q : m), null);
  const meanDepth = qs.length ? qs.reduce((s, q) => s + q.depth, 0) / qs.length : 0;
  const seis = qs.length ? 100 * (0.62 * (1 - Math.exp(-rate / 0.9)) + 0.38 * clamp((maxQ.mag - 5.5) / 3, 0, 1)) : 100 * 0.1 * Math.exp(-(tect?.dist ?? 2000) / 400);

  let tectS = 0;
  if (tect) tectS = 100 * tect.info.w * Math.exp(-tect.dist / 320) * (0.55 + 0.45 * Math.min(tect.vel / 70, 1));

  const vs = [];
  for (const v of DATA.volc) { if (Math.abs(v[0] - lat) > 6) continue; const d = hav(lat, lon, v[0], v[1]); if (d <= 400) vs.push({ name: v[2], type: v[3], year: v[4], country: v[5], d }); }
  vs.sort((a, b) => a.d - b.d);
  let surv = 1;
  vs.forEach((v) => { const rec = v.year == null ? 0.3 : v.year >= 1900 ? 1 : v.year >= 0 ? 0.6 : 0.3; surv *= 1 - Math.exp(-v.d / 55) * rec; });
  const volc = 100 * (1 - surv);

  const subs = [seis, tectS, volc];
  const overall = clamp(0.55 * Math.max(...subs) + 0.45 * (0.45 * seis + 0.3 * tectS + 0.25 * volc), 0, 100);
  const level = overall < 20 ? ['Low', '#3ddc97'] : overall < 40 ? ['Moderate', '#c8e05a'] : overall < 65 ? ['High', '#ffb547'] : ['Very high', '#ff5468'];

  const live = DATA.live.filter((q) => hav(lat, lon, q.lat, q.lon) <= 1000).map((q) => ({ ...q, d: hav(lat, lon, q.lat, q.lon) })).sort((a, b) => b.time - a.time);
  return { seis, tect: tectS, volc, overall, level, qs, rate, maxQ, meanDepth, vs, live };
}

const BASE = { cu: 0.03, au: 0.05, fe: 0.03, zn: 0.03, ni: 0.015, li: 0.012, ree: 0.01, u: 0.015, pgm: 0.005, co: 0.006, sn: 0.01 };
function prospectivity(lat, lon, water, tect) {
  const p = {};
  Object.keys(COMMODITIES).forEach((c) => (p[c] = water ? 0.004 : BASE[c]));
  const hits = [];
  for (const [name, plat, plon, r, w] of PROVINCES) {
    const d = hav(lat, lon, plat, plon);
    const f = Math.exp(-((d / r) ** 2));
    if (f < 0.01) continue;
    hits.push({ name, f, d });
    for (const c in w) p[c] = 1 - (1 - p[c]) * (1 - w[c] * f);
  }
  if (!water && tect && [0, 5, 6].includes(tect.cls)) {
    const b = Math.exp(-tect.dist / 350);
    p.cu = 1 - (1 - p.cu) * (1 - 0.14 * b); p.au = 1 - (1 - p.au) * (1 - 0.1 * b);
  }
  if (water) Object.keys(p).forEach((c) => (p[c] *= c === 'sn' ? 0.8 : 0.35));
  hits.sort((a, b) => b.f - a.f);
  return { p, provinces: hits };
}

function runSurvey(site, params, prior) {
  const rng = mulberry32(hashStr(`${site.lat.toFixed(2)},${site.lon.toFixed(2)},${params.radius},${params.depth}`));
  const footF = { 5: 0.65, 10: 1, 20: 1.3 }[params.radius];
  const depthF = { 2: 0.7, 5: 1, 8: 1.12 }[params.depth];
  const out = [];
  const keys = Object.keys(COMMODITIES).sort((a, b) => prior.p[b] - prior.p[a]);
  for (const c of keys) {
    const pe = clamp(1 - Math.pow(1 - prior.p[c], 2 * footF * depthF), 0, 0.96);
    if (rng() >= pe) continue;
    const C = COMMODITIES[c];
    const dmax = params.depth * 1000 * 0.95;
    if (C.depth[0] > dmax) continue;
    const depth = lerp(C.depth[0], Math.min(C.depth[1], dmax), Math.pow(rng(), 0.85));
    const ore = Math.exp(lerp(Math.log(C.ore[0]), Math.log(C.ore[1]), Math.pow(rng(), 1.4))) * Math.sqrt(footF);
    const grade = lerp(C.grade[0], C.grade[1], Math.pow(rng(), 1.2));
    const calc = C.calc(ore * 1e6, grade);
    out.push({
      key: c, ...C, depth, ore, grade, ...calc, ore_min: C.ore[0], ore_max: C.ore[1], g_min: C.grade[0], g_max: C.grade[1],
      type: C.types[Math.floor(rng() * C.types.length)],
      conf: Math.round(clamp(58 + prior.p[c] * 40 + rng() * 14, 55, 97)),
      thick: Math.round(lerp(20, 400, rng()) / 5) * 5,
      pos: [lerp(-0.6, 0.6, rng()), lerp(-0.6, 0.6, rng())],
    });
  }
  out.sort((a, b) => b.value - a.value);
  return out.slice(0, 4);
}

/* =========================================================
   Renderer + scenes
   ========================================================= */
const view = $('view');
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const DPR = Math.min(devicePixelRatio, 1.75);
renderer.setPixelRatio(DPR);
const globeScene = new THREE.Scene();
const siteScene = new THREE.Scene();
const gCam = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
gCam.position.set(0.6, 0.9, 3.2);
const sCam = new THREE.PerspectiveCamera(36, 1, 0.05, 600);
{
  const pm = new THREE.PMREMGenerator(renderer);
  siteScene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  siteScene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const k = new THREE.DirectionalLight(0xfff1e2, 2.4); k.position.set(8, 16, 12); siteScene.add(k);
}
const gCtl = new OrbitControls(gCam, canvas);
Object.assign(gCtl, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 1.01, maxDistance: 5.5, rotateSpeed: 0.45, enableZoom: false, autoRotate: true, autoRotateSpeed: 0.35 });
let gDistT = gCam.position.length(), flying = false;
canvas.addEventListener('wheel', (e) => {
  if (S.view !== 'globe') return;
  e.preventDefault();
  const alt = Math.max(0.004, gDistT - 1);
  gDistT = clamp(1 + alt * Math.exp(e.deltaY * 0.0011), 1.012, 5.5);
}, { passive: false });
const sCtl = new OrbitControls(sCam, canvas);
Object.assign(sCtl, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 2.2, maxDistance: 85, maxPolarAngle: Math.PI * 0.62, autoRotate: true, autoRotateSpeed: 0.4, enabled: false });

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(globeScene, gCam);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.55);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  composer.setSize(r.width, r.height);
  gCam.aspect = sCam.aspect = r.width / r.height;
  gCam.updateProjectionMatrix(); sCam.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

/* ---------- globe ---------- */
const ACC = new THREE.Color('#ff5a1f');
const globeU = {
  uWater: { value: null }, uElev: { value: null }, uHasElev: { value: 0 }, uHeat: { value: null }, uHeatA: { value: 0 },
  uDeploy: { value: 1 }, uLight: { value: new THREE.Vector3(0.5, 0.6, 0.6).normalize() },
  uDay: { value: null }, uNight: { value: null }, uTopo: { value: null }, uZoom: { value: 0 }, uHasTex: { value: 0 },
};
let globe, plateLines, volcPts, marker, atmo;
function heatTexture() {
  const W = 2048, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'lighter';
  const pxDeg = W / 360;
  for (const [la, lo, m] of DATA.quakes) {
    const px = ((lo + 180) / 360) * W, py = ((90 - la) / 180) * H;
    const rDeg = 1.4 + (m - 5.5) * 1.3, ry = rDeg * pxDeg, rx = ry / Math.max(0.2, Math.cos(la * D2R));
    const a = 0.035 + (m - 5.5) * 0.04;
    x.save(); x.translate(px, py); x.scale(rx / ry, 1);
    const g = x.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, ry, 0, TAU); x.fill(); x.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
function buildGlobe() {
  if (DATA.mask) { const t = new THREE.Texture(DATA.mask.img); t.needsUpdate = true; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; globeU.uWater.value = t; }
  else { globeU.uWater.value = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); globeU.uWater.value.needsUpdate = true; }
  if (DATA.elev) {
    const g = DATA.elev, d = new Uint16Array(g.w * g.h);
    g.data.forEach((v, i) => (d[i] = THREE.DataUtils.toHalfFloat(v ?? 0)));
    const t = new THREE.DataTexture(d, g.w, g.h, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true;
    globeU.uElev.value = t; globeU.uHasElev.value = 1;
  } else { globeU.uElev.value = new THREE.DataTexture(new Uint16Array([0]), 1, 1, THREE.RedFormat, THREE.HalfFloatType); globeU.uElev.value.needsUpdate = true; }
  globeU.uHeat.value = heatTexture();
  const texOr = (img, srgb) => { if (!img) { const t = new THREE.DataTexture(new Uint8Array([40, 40, 40, 255]), 1, 1); t.needsUpdate = true; return t; } const t = new THREE.Texture(img); t.needsUpdate = true; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  globeU.uDay.value = texOr(DATA.day?.img, true);
  globeU.uNight.value = texOr(DATA.night?.img, false);
  globeU.uTopo.value = texOr(DATA.topo?.img, false);
  globeU.uHasTex.value = DATA.day ? 1 : 0;

  globe = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 160), new THREE.ShaderMaterial({
    uniforms: globeU,
    vertexShader: `varying vec3 vN; varying vec3 vW; varying vec2 vUv; void main(){ vN = normalize(position); vUv = uv; vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uWater, uElev, uHeat, uDay, uNight, uTopo; uniform float uHasElev, uHeatA, uDeploy, uZoom, uHasTex; uniform vec3 uLight;
      varying vec3 vN; varying vec3 vW;
      float h21(vec2 p){ p = mod(p, 4096.0); vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
      float ridge(vec2 p){ return 1.0 - abs(vn(p) * 2.0 - 1.0); }
      // level of detail: 1 when a cell of q spans ≥ ~4 px, fading to 0 below ~1.5 px
      float lod(vec2 q){ vec2 w = fwidth(q); return 1.0 - smoothstep(0.22, 0.65, max(w.x, w.y)); }
      float h31(vec3 p){ p = mod(p, 4096.0); p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      float vn3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), u.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), u.x), u.y),
                   mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), u.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), u.x), u.y), u.z); }
      float ridge3(vec3 p){ return 1.0 - abs(vn3(p) * 2.0 - 1.0); }
      float lod3(vec3 q){ vec3 w = fwidth(q); return 1.0 - smoothstep(0.22, 0.65, max(max(w.x, w.y), w.z)); }
      float dots3(vec3 q, float dens, float rad, out float rnd){
        vec3 c = floor(q), f = fract(q); rnd = h31(c + 7.1);
        vec3 o = vec3(h31(c), h31(c + 3.7), h31(c + 9.2)) * 0.5 + 0.25;
        return (1.0 - smoothstep(rad * 0.6, rad, length(f - o))) * step(h31(c + 1.3), dens);
      }
      float dots(vec2 q, float dens, float rad, out float rnd){
        vec2 c = floor(q), f = fract(q); rnd = h21(c + 7.1);
        vec2 o = vec2(h21(c), h21(c + 3.7)) * 0.6 + 0.2;
        return (1.0 - smoothstep(rad * 0.65, rad, length(f - o))) * step(h21(c + 1.3), dens);
      }
      vec3 ramp(float t){
        vec3 a = vec3(0.10, 0.02, 0.22), b = vec3(0.62, 0.06, 0.32), c = vec3(1.0, 0.36, 0.06), d = vec3(1.0, 0.93, 0.62);
        return t < 0.35 ? mix(a, b, t / 0.35) : t < 0.68 ? mix(b, c, (t - 0.35) / 0.33) : mix(c, d, (t - 0.68) / 0.32);
      }
      void main(){
        vec3 n = normalize(vN);
        vec2 uv = vUv;
        float lon = uv.x * 6.2831853 - 3.14159265, lat = (uv.y - 0.5) * 3.14159265;
        float water = texture2D(uWater, uv).r;
        bool isW = water > 0.5;
        float e = uHasElev > 0.5 ? texture2D(uElev, vec2(uv.x, 1.0 - uv.y)).r : (isW ? -3800.0 : 400.0);
        e = isW ? min(e, -40.0) : max(e, 1.0);
        vec3 col;
        float Z = uZoom;
        vec3 day = texture2D(uDay, uv).rgb;
        if (Z > 0.4) {
          vec2 t1 = vec2(1.0 / 4096.0, 1.0 / 2048.0) * 1.2;
          vec3 bl = (texture2D(uDay, uv + vec2(t1.x, t1.y * 0.4)).rgb + texture2D(uDay, uv - vec2(t1.x, t1.y * 0.4)).rgb + texture2D(uDay, uv + vec2(-t1.x * 0.4, t1.y)).rgb + texture2D(uDay, uv + vec2(t1.x * 0.4, -t1.y)).rgb) * 0.25;
          day = mix(day, bl, smoothstep(0.4, 0.9, Z) * 0.75);
        }
        float night = texture2D(uNight, uv).r;
        // isotropic-ish surface coordinates (1 unit ≈ 180°)
        vec2 base = vec2(uv.x * 2.0 * cos(lat), uv.y);
        // local frame for normal perturbation
        vec3 east = normalize(vec3(-sin(lon), 0.0, -cos(lon)));
        vec3 north = normalize(cross(n, east));
        vec3 Nsh = n;
        if (isW) {
          float d = -e;
          col = mix(vec3(0.07, 0.14, 0.22), vec3(0.018, 0.035, 0.06), smoothstep(0.0, 5500.0, d));
          col += vec3(0.05, 0.09, 0.11) * (1.0 - smoothstep(0.0, 300.0, d));
          // swell ripples close up
          vec3 wq = n * 570.0;
          col += vec3(0.04, 0.07, 0.09) * vn3(wq) * lod3(wq) * Z * 0.6;
        } else {
          vec3 styl = mix(vec3(0.15, 0.16, 0.16), vec3(0.55, 0.53, 0.49), smoothstep(0.0, 4200.0, e));
          styl = mix(styl, vec3(0.86), smoothstep(4500.0, 6500.0, e));
          float lum = dot(day, vec3(0.3, 0.59, 0.11));
          vec3 real = mix(vec3(lum), day, 0.72) * 1.25;
          col = mix(styl, real, uHasTex * smoothstep(0.0, 0.7, Z) * 0.9);
          // relief shading from the topography map
          vec2 tx = vec2(1.0 / 2048.0, 1.0 / 1024.0);
          float dx = texture2D(uTopo, uv + vec2(tx.x, 0.0)).r - texture2D(uTopo, uv - vec2(tx.x, 0.0)).r;
          float dy = texture2D(uTopo, uv + vec2(0.0, tx.y)).r - texture2D(uTopo, uv - vec2(0.0, tx.y)).r;
          float k = 1.5 + Z * 3.5;
          // procedural ridges that fade in octave by octave
          float topoH = texture2D(uTopo, uv).r;
          float mtn = smoothstep(0.12, 0.38, topoH);
          vec2 rg = vec2(0.0); float amp = 1.0;
          for (int i = 0; i < 4; i++) {
            float f = 29.0 * pow(3.0, float(i));
            vec3 q = n * f + float(i) * 17.0;
            float w = lod3(q) * amp;
            float r0 = ridge3(q), rx = ridge3(q + east * 0.35), ry = ridge3(q + north * 0.35);
            rg += vec2(rx - r0, ry - r0) * w;
            amp *= 0.55;
          }
          rg *= mtn * (0.4 + mtn) * Z * 1.3;
          Nsh = normalize(n - east * (dx * k + rg.x) - north * (dy * k + rg.y));
          // snow on high ridges
          col = mix(col, vec3(0.9, 0.92, 0.95), smoothstep(0.5, 0.68, topoH + length(rg) * 0.05) * Z * 0.8);
          // break up texture blur with procedural ground detail
          float det = 0.0, da = 0.5;
          for (int i = 0; i < 3; i++) { vec3 q = n * (260.0 * pow(3.0, float(i))); det += (vn3(q) - 0.5) * da * lod3(q); da *= 0.6; }
          col *= 1.0 + det * 0.55 * Z;
          // trees: forest mask from the day map, two scales of canopy dots
          float forest = smoothstep(1.1, 1.55, day.g / max(max(day.r, day.b), 0.002)) * (1.0 - smoothstep(0.07, 0.2, lum));
          float rr;
          for (int i = 0; i < 2; i++) {
            vec3 q = n * (830.0 * pow(3.2, float(i)));
            float w = lod3(q) * smoothstep(0.25, 0.8, Z);
            float t = dots3(q, forest * 0.95, 0.42, rr);
            col = mix(col, vec3(0.012, 0.04, 0.016) * (0.5 + rr), t * w * 0.9);
            col += vec3(0.05, 0.11, 0.05) * dots3(q + 0.11, forest * 0.95, 0.22, rr) * w * 0.5;
          }
          // cities: night-light density → lit blocks and street grid
          float city = smoothstep(0.12, 0.7, night);
          col += vec3(1.0, 0.6, 0.26) * night * night * 0.5 * smoothstep(0.15, 0.6, Z);
          for (int i = 0; i < 2; i++) {
            vec3 q = n * (1650.0 * pow(3.0, float(i)));
            float w = lod3(q) * smoothstep(0.35, 0.9, Z);
            vec3 g = abs(fract(q) - 0.5);
            float street = 1.0 - smoothstep(0.4, 0.48, max(max(g.x, g.y), g.z));
            col = mix(col, vec3(0.26, 0.26, 0.28), (1.0 - street) * city * w * 0.55);
            float lit = dots3(q * 1.7, city * 0.85, 0.3, rr);
            col += vec3(1.0, 0.72, 0.38) * lit * w * (0.6 + rr);
          }
        }
        float ek = e / 1000.0;
        float cl = abs(fract(ek + 0.5) - 0.5) / max(fwidth(ek), 1e-4);
        col += vec3(0.07) * (1.0 - smoothstep(0.0, 1.2, cl)) * (isW ? 0.45 : 1.0) * (1.0 - Z * 0.6);
        float coast = fwidth(water);
        col += vec3(0.55, 0.7, 0.8) * smoothstep(0.05, 0.6, coast) * 0.5;
        bool ok = isW ? (-e <= 2000.0) : (e <= 3000.0);
        float dep = uDeploy * (1.0 - Z * 0.55);
        if (ok) col += vec3(0.24, 0.86, 0.59) * 0.11 * dep;
        else {
          float h = step(0.55, fract((gl_FragCoord.x - gl_FragCoord.y) / 6.0));
          col *= 1.0 - dep * (0.45 + h * 0.2);
        }
        float hv = texture2D(uHeat, uv).r;
        col = mix(col, ramp(clamp(hv * 1.25, 0.0, 1.0)) * 1.1, uHeatA * smoothstep(0.015, 0.22, hv) * 0.9);
        vec3 V = normalize(cameraPosition - vW);
        vec3 L = normalize(uLight + V * 0.6);
        float diff = 0.42 + 0.58 * max(dot(Nsh, L), 0.0);
        col *= diff;
        float fr = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        col += vec3(0.25, 0.45, 0.85) * fr * 0.45;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  globeScene.add(globe);

  atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 64), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vNv; void main(){ vNv = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vNv; void main(){ float a = -vNv.z; float k = smoothstep(0.0, 0.33, a) * (1.0 - smoothstep(0.33, 0.6, a)); gl_FragColor = vec4(vec3(0.35, 0.55, 1.0) * k * k * 0.5, 1.0); }`,
  }));
  globeScene.add(atmo);

  // graticule
  const gp = [];
  for (let la = -60; la <= 60; la += 30) for (let i = 0; i < 180; i++) gp.push(dirFromLatLon(la, i * 2, 1.0015), dirFromLatLon(la, i * 2 + 2, 1.0015));
  for (let lo = -180; lo < 180; lo += 30) for (let i = 0; i < 90; i++) gp.push(dirFromLatLon(-90 + i * 2, lo, 1.0015), dirFromLatLon(-88 + i * 2, lo, 1.0015));
  globeScene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gp), new THREE.LineBasicMaterial({ color: 0xecebe6, transparent: true, opacity: 0.05 })));

  // plate boundaries
  if (DATA.plates) {
    const P = [], C = [], col = new THREE.Color();
    for (const [lo1, la1, lo2, la2, cls] of DATA.plates.steps) {
      if (Math.abs(lo1 - lo2) > 90) continue;
      P.push(...dirFromLatLon(la1, lo1, 1.003).toArray(), ...dirFromLatLon(la2, lo2, 1.003).toArray());
      col.set(CLASS_INFO[cls]?.color || '#fff');
      C.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    plateLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 }));
    globeScene.add(plateLines);
  }

  // volcanoes
  const vp = [], vc = [], vcol = new THREE.Color();
  DATA.volc.forEach(([la, lo, , , yr]) => {
    vp.push(...dirFromLatLon(la, lo, 1.004).toArray());
    vcol.set(yr == null ? '#7a6f6a' : yr >= 1900 ? '#ff5a1f' : yr >= 0 ? '#ffb547' : '#c9a48e');
    vc.push(vcol.r, vcol.g, vcol.b);
  });
  const vg = new THREE.BufferGeometry();
  vg.setAttribute('position', new THREE.Float32BufferAttribute(vp, 3));
  vg.setAttribute('color', new THREE.Float32BufferAttribute(vc, 3));
  volcPts = new THREE.Points(vg, new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uPR: { value: DPR } }, transparent: true, depthWrite: false, vertexColors: true,
    vertexShader: `uniform float uPR; varying vec3 vC; varying float vF; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
      vec3 n = normalize(position); vF = dot(n, normalize(cameraPosition - position)); gl_Position = projectionMatrix * mv; gl_PointSize = 9.0 * uPR; }`,
    fragmentShader: `uniform float uA; varying vec3 vC; varying float vF; void main(){ if (vF < 0.0) discard; vec2 p = gl_PointCoord - 0.5; p.y = -p.y;
      float tri = step(p.y, 0.35) * step(-0.35, p.y) * step(abs(p.x) * 1.6, 0.35 - p.y);
      if (tri < 0.5) discard; gl_FragColor = vec4(vC, uA); }`,
  }));
  globeScene.add(volcPts);

  // site marker
  marker = new THREE.Group();
  const mm = new THREE.LineBasicMaterial({ color: ACC, transparent: true });
  marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.08, 0)]), mm));
  const ring = (r) => { const a = []; for (let i = 0; i <= 64; i++) a.push(new THREE.Vector3(Math.cos((i / 64) * TAU) * r, 0.001, Math.sin((i / 64) * TAU) * r)); return new THREE.Line(new THREE.BufferGeometry().setFromPoints(a), mm); };
  const r1 = ring(0.012), r2 = ring(0.024), r3 = ring(0.024);
  marker.add(r1, r2, r3);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), new THREE.MeshBasicMaterial({ color: ACC }));
  head.position.y = 0.08;
  marker.add(head);
  marker.userData = { mm, pulse: r3, head };
  marker.visible = false;
  globeScene.add(marker);
}

function setMarker(site) {
  if (!site) { marker.visible = false; return; }
  const d = dirFromLatLon(site.lat, site.lon, 1.0);
  marker.position.copy(d);
  marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  const c = new THREE.Color(site.ok ? '#3ddc97' : '#ff5468');
  marker.userData.mm.color.copy(c);
  marker.userData.head.material.color.copy(c);
  marker.visible = true;
}

/* =========================================================
   UI helpers
   ========================================================= */
function toast(msg, bad = false) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('is-on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('is-on'), 3200);
}
function setSeg(seg, v) {
  const btns = [...seg.querySelectorAll('button')];
  const i = btns.findIndex((b) => b.dataset.v === String(v));
  btns.forEach((b, k) => b.classList.toggle('is-on', k === i));
  seg.querySelector('.seg__pill').style.transform = `translateX(${i * 100}%)`;
}
function setStep(step) {
  const order = ['place', 'scan', 'results'];
  const idx = order.indexOf(step);
  document.querySelectorAll('.stepper li').forEach((li, k) => { li.classList.toggle('is-on', k === idx); li.classList.toggle('is-done', k < idx); });
}
function updateEstimates() {
  const { radius, depth } = S.params;
  const nodes = Math.round(Math.PI * radius * radius / 0.25 / 10) * 10;
  $('eNodes').textContent = fmt(nodes);
  $('eTime').textContent = `${Math.round(18 + radius * 3 + depth * 4)} h`;
  $('eMode').textContent = S.site?.water ? 'OBN' : 'Land';
}

/* =========================================================
   Site placement
   ========================================================= */
async function placeSite(lat, lon, fly = true) {
  if (S.phase === 'scanning') return;
  if (S.view === 'site') await backToGlobe(true);
  S.results = null;
  const sf = surfaceAt(lat, lon);
  const el = eligibility(sf.water, sf.elev);
  S.site = { lat, lon, water: sf.water, elev: sf.elev, ok: el.ok, el, src: 'ETOPO1 grid', loading: true };
  S.phase = 'place';
  setStep('place');
  gCtl.autoRotate = false; $('tSpin').setAttribute('aria-pressed', 'false');
  setMarker(S.site);
  if (fly) flyTo(lat, lon, Math.min(gCam.position.length(), 2.3));
  computeAnalysis();
  renderAll();
  // refine with GEBCO 2020 via local proxy (falls back silently on static hosting)
  const req = ++placeReq;
  try {
    const r = await fetch(`/api/elev?dataset=gebco2020&locations=${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (!r.ok) throw new Error();
    const j = await r.json();
    const e = j.results?.[0]?.elevation;
    if (req !== placeReq || e == null || !S.site) return;
    const water = e < 0 ? true : sf.water && e < 5;
    const elev = water ? Math.min(e, -5) : Math.max(e, 1);
    const el2 = eligibility(water, elev);
    Object.assign(S.site, { water, elev, ok: el2.ok, el: el2, src: 'GEBCO 2020 · 450 m', loading: false });
  } catch { if (S.site) S.site.loading = false; }
  if (req !== placeReq || !S.site) return;
  setMarker(S.site);
  computeAnalysis();
  renderSite();
  renderRes();
  if (!S.site.ok) toast(S.site.water ? `Too deep: water depth ${fmt(-S.site.elev)} m exceeds 2,000 m` : `Too high: altitude ${fmt(S.site.elev)} m exceeds 3,000 m`, true);
}
let placeReq = 0;

function computeAnalysis() {
  const s = S.site; if (!s) return;
  s.tect = tectonics(s.lat, s.lon);
  S.prior = prospectivity(s.lat, s.lon, s.water, s.tect);
  S.hazards = hazards(s.lat, s.lon, s.tect);
}

function flyTo(lat, lon, dist = 2.2, dur = 1.6) {
  const from = gCam.position.clone(), d0 = from.length();
  const to = dirFromLatLon(lat + 8, lon, 1).normalize();
  const fromN = from.clone().normalize();
  const o = { t: 0 };
  flying = true; gDistT = dist;
  gsap.to(o, {
    t: 1, duration: dur, ease: 'power3.inOut', onComplete: () => (flying = false), onUpdate: () => {
      const v = new THREE.Vector3().copy(fromN).lerp(to, o.t).normalize();
      gCam.position.copy(v.multiplyScalar(lerp(d0, dist, o.t) + Math.sin(Math.PI * o.t) * 0.25));
      gCam.lookAt(0, 0, 0);
    },
  });
}

/* =========================================================
   Rendering of panels
   ========================================================= */
function renderAll() { renderSite(); renderRes(); renderHaz(); updateEstimates(); }

function renderSite() {
  const s = S.site;
  $('siteEmpty').hidden = !!s;
  $('siteBody').hidden = !s;
  $('resetBtn').disabled = !s;
  const chip = $('siteChip');
  if (!s) { chip.className = 'chip'; chip.textContent = 'Not placed'; $('scanBtn').disabled = true; $('scanBtn').querySelector('span').textContent = 'Start scan'; $('scanHint').textContent = 'Place the array on a valid site first.'; $('scanHint').classList.remove('is-bad'); return; }
  $('sLat').textContent = latStr(s.lat);
  $('sLon').textContent = lonStr(s.lon);
  $('sElevLbl').textContent = s.water ? 'Water depth' : 'Elevation';
  $('sElev').textContent = `${s.loading ? '≈ ' : ''}${fmt(s.water ? -s.elev : s.elev)} m`;
  $('sElevSrc').textContent = s.loading ? 'refining…' : s.src;
  $('sElevSrc').closest('.metric').classList.toggle('is-loading', !!s.loading);
  const rules = $('rules').children;
  const alt = rules[0], dep = rules[1];
  alt.className = s.water ? 'na' : s.ok ? 'ok' : 'bad';
  dep.className = !s.water ? 'na' : s.ok ? 'ok' : 'bad';
  alt.querySelector('em').textContent = s.water ? 'n/a' : `${fmt(s.elev)} m`;
  dep.querySelector('em').textContent = s.water ? `${fmt(-s.elev)} m` : 'n/a';
  chip.className = `chip ${s.ok ? 'chip--ok' : 'chip--bad'}`;
  chip.textContent = s.ok ? 'Deployable' : 'Not deployable';
  const t = s.tect;
  $('sSetting').textContent = s.water ? (-s.elev < 200 ? 'Continental shelf' : 'Continental slope') : s.elev > 1500 ? 'Highlands' : 'Lowland';
  $('sPlate').textContent = t?.plate ? `${t.plate.name} plate` : '—';
  const pv = S.prior?.provinces[0];
  $('sProv').textContent = pv && pv.f > 0.15 ? pv.name : 'No known province nearby';
  const ready = s.ok && S.phase !== 'scanning';
  $('scanBtn').disabled = !ready || S.phase === 'results';
  $('scanBtn').querySelector('span').textContent = S.phase === 'results' ? 'Scan complete' : 'Start scan';
  $('scanHint').textContent = S.phase === 'results' ? 'Reset or pick a new point to scan again.' : s.ok ? `${S.params.radius} km footprint · ${S.params.depth} km imaging depth` : s.water ? 'Water deeper than 2,000 m — choose a shallower spot.' : 'Above 3,000 m — choose a lower spot.';
  $('scanHint').classList.toggle('is-bad', !s.ok);
  updateEstimates();
}

function renderRes() {
  const s = S.site;
  $('resEmpty').hidden = !!s;
  $('priorCard').hidden = !s || S.phase === 'results';
  $('resLive').hidden = S.phase !== 'scanning';
  $('resOut').hidden = S.phase !== 'results';
  if (!s) return;
  if (S.phase !== 'results') {
    const pv = S.prior.provinces.filter((p) => p.f > 0.1).slice(0, 2);
    $('priorProv').textContent = pv.length ? `Within reach of: ${pv.map((p) => `${p.name} (${fmt(p.d)} km)`).join(', ')}` : 'No known metallogenic province within range — background odds only.';
    const top = Object.entries(S.prior.p).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('priorBars').innerHTML = top.map(([k, v]) => { const C = COMMODITIES[k]; return `<li><span class="sym" style="color:${C.color}">${C.sym}</span><span class="nm">${C.name}<span class="tr"><b style="background:${C.color}" data-w="${(v * 100).toFixed(1)}"></b></span></span><span class="pc">${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%</span></li>`; }).join('');
    requestAnimationFrame(() => $('priorBars').querySelectorAll('b').forEach((b) => (b.style.width = `${Math.max(2, +b.dataset.w)}%`)));
  }
  if (S.phase === 'results') renderResults();
}

function renderResults() {
  const r = S.results;
  const total = r.reduce((a, d) => a + d.value, 0);
  $('kValue').textContent = r.length ? money(total) : '$0';
  $('kValueSub').textContent = r.length ? `${r.length} ore bod${r.length > 1 ? 'ies' : 'y'} · ${S.params.radius} km footprint` : 'nothing economic in this volume';
  $('kCount').textContent = r.length;
  $('kCountSub').textContent = r.map((d) => d.sym).join(' · ') || '—';
  $('kShallow').textContent = r.length ? `${fmt(Math.min(...r.map((d) => d.depth)))} m` : '—';
  $('kConf').textContent = r.length ? `${Math.round(r.reduce((a, d) => a + d.conf, 0) / r.length)}%` : '—';
  $('profMax').textContent = `0 – ${S.params.depth} km`;
  // depth profile
  const max = S.params.depth * 1000, W = 320, H = 150;
  let svg = '';
  for (let k = 0; k <= S.params.depth; k++) { const y = 8 + (k * 1000 / max) * (H - 16); svg += `<line x1="34" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(236,235,230,.07)"/><text x="0" y="${y + 3}">${k} km</text>`; }
  r.forEach((d, i) => {
    const y = 8 + (d.depth / max) * (H - 16), h = Math.max(4, (d.thick / max) * (H - 16)), x = 50 + i * ((W - 70) / Math.max(1, r.length));
    svg += `<rect x="${x}" y="${y}" width="${(W - 90) / Math.max(1, r.length)}" height="${h}" rx="4" fill="${d.color}" opacity=".85"/><text x="${x}" y="${y - 4}" style="fill:${d.color}">${d.sym} · ${fmt(d.depth)} m</text>`;
  });
  $('profile').innerHTML = svg;
  $('depCards').innerHTML = r.map((d, i) => `
    <article class="dep" data-i="${i}" style="--c:${d.color}">
      <div class="dep__top"><span class="dep__sym">${d.sym}</span><div><h3>${d.name}</h3><p>${d.type} · ${d.mineral}</p></div>
        <div class="dep__val"><b>${money(d.value)}</b><span>in‑situ</span></div></div>
      <dl class="dep__grid">
        <div><dt>Depth</dt><dd>${fmt(d.depth)} m</dd></div>
        <div><dt>Ore</dt><dd>${qty(d.ore * 1e6)} t</dd></div>
        <div><dt>Grade</dt><dd>${fmt(d.grade, d.grade < 1 ? 2 : 1)} ${d.gUnit}</dd></div>
        <div><dt>Contained</dt><dd>${qty(d.contained)} ${d.cUnit.split(' ')[0]}</dd></div>
        <div><dt>Thickness</dt><dd>${d.thick} m</dd></div>
        <div><dt>Price basis</dt><dd>${d.price}</dd></div>
      </dl>
      <div class="dep__conf"><span>Confidence</span><i><b style="width:${d.conf}%"></b></i><span>${d.conf}%</span></div>
    </article>`).join('');
  $('depCards').querySelectorAll('.dep').forEach((el) => {
    el.addEventListener('mouseenter', () => setHot(+el.dataset.i));
    el.addEventListener('mouseleave', () => setHot(-1));
    el.addEventListener('click', () => focusDeposit(+el.dataset.i));
  });
  $('noFind').hidden = r.length > 0;
  if (!r.length) {
    const best = Object.entries(S.prior.p).sort((a, b) => b[1] - a[1])[0];
    $('noFindTxt').textContent = `The forecast here peaked at ${(best[1] * 100).toFixed(1)}% (${COMMODITIES[best[0]].name}). Try a known province:`;
    $('noFindPicks').innerHTML = PRESETS.slice(0, 4).map((p, i) => `<button data-p="${i}"><b>${p.name}</b><span>${p.note}</span></button>`).join('');
    $('noFindPicks').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { const p = PRESETS[+b.dataset.p]; resetAll(false); placeSite(p.lat, p.lon); }));
  }
  $('priceNote').textContent = PRICE_NOTE;
}

const STYLE_DESC = {
  seismic: 'Density of M5.5+ earthquakes since 1980 (USGS ComCat). Brighter = more frequent and stronger shaking.',
  plates: 'Plate boundaries coloured by type (Bird 2003, PB2002). Convergent margins host the largest earthquakes.',
  volc: 'Holocene volcanoes (Smithsonian GVP), coloured by most recent eruption.',
};
function renderLegend() {
  const L = $('legend');
  if (S.tab !== 'haz') { L.hidden = true; return; }
  L.hidden = false;
  if (S.style === 'seismic') L.innerHTML = `<h4>Seismic density · M5.5+</h4><div class="ramp" style="background:linear-gradient(90deg,#1a0538,#9e0f52,#ff5c0f,#ffeea0)"></div><div class="ramp-l"><span>Rare</span><span>Frequent</span></div>`;
  else if (S.style === 'plates') L.innerHTML = `<h4>Plate boundaries</h4><ul>${CLASS_INFO.map((c) => `<li><i style="background:${c.color}"></i>${c.name}</li>`).join('')}</ul>`;
  else L.innerHTML = `<h4>Last eruption</h4><ul><li><i class="dot2" style="background:#ff5a1f"></i>Since 1900</li><li><i class="dot2" style="background:#ffb547"></i>1 – 1899 CE</li><li><i class="dot2" style="background:#c9a48e"></i>Holocene, BCE</li><li><i class="dot2" style="background:#7a6f6a"></i>Unknown</li></ul>`;
}

function renderHaz() {
  $('styleDesc').textContent = STYLE_DESC[S.style];
  setSeg($('styleSeg'), S.style);
  renderLegend();
  const h = S.hazards;
  $('hazEmpty').hidden = !!h;
  $('hazBody').hidden = !h;
  if (!h) return;
  const s = S.site, t = s.tect;
  const [lvl, col] = h.level;
  document.querySelector('.risk').style.setProperty('--rc', col);
  $('riskVal').textContent = Math.round(h.overall);
  $('riskArc').style.strokeDashoffset = 314.16 * (1 - h.overall / 100);
  $('riskLvl').textContent = lvl;
  const top = [['seismic', h.seis], ['tectonic', h.tect], ['volcanic', h.volc]].sort((a, b) => b[1] - a[1])[0];
  $('riskSum').textContent = h.overall < 20 ? 'Stable setting — natural hazards are unlikely to affect operations.' : `Driven mainly by ${top[0]} activity${t ? ` · ${fmt(t.dist)} km from a ${t.info.name.toLowerCase()}` : ''}.`;
  const subs = $('subscores').children;
  [h.seis, h.tect, h.volc].forEach((v, i) => {
    const c = v < 20 ? '#3ddc97' : v < 40 ? '#c8e05a' : v < 65 ? '#ffb547' : '#ff5468';
    const li = subs[i]; li.classList.toggle('is-on', li.dataset.style === S.style);
    li.querySelector('b').style.background = c; li.querySelector('b').style.width = `${Math.max(2, v)}%`; li.querySelector('em').textContent = Math.round(v);
  });
  // style card
  const card = $('styleCard');
  if (S.style === 'seismic') {
    card.innerHTML = `<header class="card__head"><h2>Seismicity within 300 km</h2><span class="chip chip--mute">1980 – 2026</span></header>
      <div class="stats">
        <div><span class="lbl">Events M5.5+</span><b>${fmt(h.qs.length)}</b><em>${h.rate.toFixed(h.rate < 1 ? 2 : 1)} per year</em></div>
        <div><span class="lbl">Largest</span><b>${h.maxQ ? `M ${h.maxQ.mag.toFixed(1)}` : '—'}</b><em>${h.maxQ ? `${h.maxQ.year} · ${fmt(h.maxQ.d)} km away` : 'none recorded'}</em></div>
        <div><span class="lbl">Mean focal depth</span><b>${h.qs.length ? `${fmt(h.meanDepth)} km` : '—'}</b><em>${h.meanDepth > 70 ? 'intermediate / deep' : 'mostly shallow'}</em></div>
        <div><span class="lbl">Chance of M6+ / 10 yr</span><b>${pctM6(h)}%</b><em>Poisson, local rate</em></div>
      </div>
      <ul class="list"><h5>Largest nearby</h5>${h.qs.sort((a, b) => b.mag - a.mag).slice(0, 4).map((q) => `<li><div>M ${q.mag.toFixed(1)} · ${q.year}<small>${fmt(q.depth)} km deep</small></div><span>${fmt(q.d)} km</span></li>`).join('') || '<li><div>No M5.5+ events recorded</div><span></span></li>'}
      ${DATA.live.length ? `<h5><i class="dot"></i>Live · last 30 days · M4.5+ within 1,000 km</h5>${h.live.slice(0, 3).map((q) => `<li><div>M ${q.mag.toFixed(1)}<small>${q.place}</small></div><span>${daysAgo(q.time)}</span></li>`).join('') || '<li><div>Quiet — no events</div><span></span></li>'}` : ''}</ul>`;
  } else if (S.style === 'plates') {
    card.innerHTML = `<header class="card__head"><h2>Tectonic setting</h2><span class="chip chip--mute">PB2002</span></header>
      <div class="bound" style="--bc:${t.info.color}"><span class="lbl">Nearest boundary</span><b>${t.info.name}</b><p>${t.info.desc}</p></div>
      <div class="stats">
        <div><span class="lbl">On plate</span><b>${t.plate ? t.plate.name : '—'}</b><em>${t.plate ? t.plate.code : ''}</em></div>
        <div><span class="lbl">Distance</span><b>${fmt(t.dist)} km</b><em>to ${t.pair.split(/[-\\/]/).map(plateName).join(' / ')}</em></div>
        <div><span class="lbl">Relative velocity</span><b>${fmt(t.vel, 1)} mm/yr</b><em>${t.info.vel}</em></div>
        <div><span class="lbl">Setting</span><b>${t.dist < 150 ? 'Plate margin' : t.dist < 600 ? 'Near margin' : 'Intraplate'}</b><em>${t.dist < 600 ? 'active deformation' : 'stable interior'}</em></div>
      </div>
      <ul class="list"><h5>Closest boundaries</h5>${t.list.map((b) => `<li><div><span style="color:${CLASS_INFO[b.cls].color}">●</span> ${CLASS_INFO[b.cls].name}<small>${b.pair.split(/[-\\/]/).map(plateName).join(' / ')} · ${fmt(b.vel, 1)} mm/yr</small></div><span>${fmt(b.dist)} km</span></li>`).join('')}</ul>`;
  } else {
    const recent = h.vs.filter((v) => v.year != null && v.year >= 1900).length;
    card.innerHTML = `<header class="card__head"><h2>Volcanism within 400 km</h2><span class="chip chip--mute">Smithsonian GVP</span></header>
      <div class="stats">
        <div><span class="lbl">Holocene volcanoes</span><b>${h.vs.length}</b><em>within 400 km</em></div>
        <div><span class="lbl">Nearest</span><b>${h.vs[0] ? `${fmt(h.vs[0].d)} km` : '—'}</b><em>${h.vs[0] ? h.vs[0].name : 'none'}</em></div>
        <div><span class="lbl">Erupted since 1900</span><b>${recent}</b><em>historically active</em></div>
        <div><span class="lbl">Ashfall exposure</span><b>${h.volc < 15 ? 'Low' : h.volc < 45 ? 'Moderate' : 'High'}</b><em>distance‑weighted</em></div>
      </div>
      <ul class="list"><h5>Nearest volcanoes</h5>${h.vs.slice(0, 5).map((v) => `<li><div>${v.name}<small>${v.type} · last eruption ${v.year == null ? 'unknown' : v.year < 0 ? `${fmt(-v.year)} BCE` : v.year}</small></div><span>${fmt(v.d)} km</span></li>`).join('') || '<li><div>No Holocene volcanoes nearby</div><span></span></li>'}</ul>`;
  }
  // notes
  const notes = [];
  if (h.seis >= 55) notes.push(['#ff5468', 'Design surface equipment and any future infrastructure for strong ground motion; frequent M6+ events in the region.']);
  else if (h.seis >= 25) notes.push(['#ffb547', 'Moderate seismicity — apply regional building codes and anchor recording stations.']);
  if (t && t.cls === 0 && t.dist < 400 && (s.water || s.elev < 200)) notes.push(['#ff5468', 'Near a subduction margin at low elevation — include tsunami run‑up in site planning.']);
  if (h.volc >= 35) notes.push(['#ffb547', `Volcanic exposure: ashfall and lahars possible from ${h.vs[0]?.name || 'nearby centres'}. Monitor alert levels.`]);
  if (t && t.dist < 120) notes.push(['#c38bff', 'Active faulting close by — expect complex structure; denser receiver spacing recommended.']);
  if (h.qs.length > 30) notes.push(['#5fd4ff', 'High natural seismicity can be used for passive imaging, but needs stronger noise filtering during acquisition.']);
  if (!notes.length) notes.push(['#3ddc97', 'Stable intraplate setting with low natural hazard. Standard acquisition and HSE procedures apply.']);
  $('notes').innerHTML = notes.map(([c, n]) => `<li style="--nc:${c}">${n}</li>`).join('');
  document.querySelector('[data-tab="haz"]').innerHTML = `Geohazards <span style="color:${col};margin-left:4px">●</span>`;
}
function pctM6(h) {
  const r6 = h.qs.filter((q) => q.mag >= 6).length / (2026.9 - 1980);
  return Math.round((1 - Math.exp(-r6 * 10)) * 100);
}
const daysAgo = (t) => { const d = Math.round((Date.now() - t) / 864e5); return d <= 0 ? 'today' : `${d} d ago`; };

/* =========================================================
   Local site scene (3D survey)
   ========================================================= */
const siteU = {
  uTime: { value: 0 }, uPR: { value: DPR }, uScanR: { value: 0 }, uSlice: { value: -20 }, uSliceA: { value: 0 }, uClassify: { value: 0 },
  uReveal: { value: 0 }, uIntro: { value: 0 }, uHot: { value: -5 }, uSrc: { value: new THREE.Vector3() }, uFocusK: { value: 0 }, uFocusDep: { value: -5 },
  uDepCol: { value: [0, 1, 2, 3].map(() => new THREE.Color('#fff')) },
  uLayCol: { value: ['#d9d3c7', '#c7b08c', '#8f8a80', '#7a8794', '#61708a', '#4c5677', '#3f4466'].map((c) => new THREE.Color(c)) },
  uAcc: { value: ACC },
};
let site3d = null;
const SR = 9;
async function fetchSiteGrid(lat, lon, km) {
  const N = 10, pts = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const dx = lerp(-km, km, i / (N - 1)), dz = lerp(-km, km, j / (N - 1));
    pts.push([lat - dz / 111.32, lon + dx / (111.32 * Math.cos(lat * D2R))]);
  }
  try {
    const r = await fetch(`/api/elev?dataset=gebco2020&locations=${pts.map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join('|')}`);
    if (!r.ok) throw 0;
    const j = await r.json();
    const v = j.results.map((x) => x.elevation);
    if (v.some((x) => x == null)) throw 0;
    return { N, v };
  } catch { return null; }
}

const RO = SR * 3.2; // surrounding terrain radius
function landcover(lat, lon, water) {
  const avg = (im) => { let a = [0, 0, 0], n = 0; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const s = sampleImg(im, lat + i * 0.12, lon + j * 0.12); a = a.map((v, k) => v + s[k]); n++; } return a.map((v) => v / n); };
  const d = avg(DATA.day), nl = avg(DATA.night);
  const c = new THREE.Color().setRGB(d[0], d[1], d[2], THREE.SRGBColorSpace);
  const forest = clamp((c.g / Math.max(c.r, c.b, 0.002) - 1.05) / 0.5, 0, 1) * (1 - sstep(0.06, 0.2, c.r * 0.3 + c.g * 0.59 + c.b * 0.11));
  if (water) return { tint: new THREE.Color('#1d2a33'), forest: 0, urban: 0 };
  const tint = c.clone().multiplyScalar(1.7);
  const hsl = {}; tint.getHSL(hsl); tint.setHSL(hsl.h, hsl.s * 0.75, clamp(hsl.l * 0.8, 0.05, 0.3));
  return { tint, forest, urban: clamp(nl[0] * 1.6, 0, 1) };
}
const EDGE_GLSL = /* glsl */ `float edgeF(vec2 p){ float a = atan(p.y, p.x); return length(p) / (uR * (1.0 + 0.06 * sin(3.0 * a + uSeed) + 0.04 * sin(5.0 * a + uSeed * 2.0) + 0.03 * sin(7.0 * a + uSeed * 3.0))); }`;

function buildSite(site, grids, results) {
  const g = new THREE.Group();
  const rng = mulberry32(hashStr(`${site.lat.toFixed(3)}${site.lon.toFixed(3)}`));
  const km = S.params.radius, depthKm = S.params.depth;
  const depthU = clamp((depthKm / km) * SR, 4, 13);
  const seed = rng() * 100;
  const eSeed = rng() * 6.283;
  let hAt;
  let waterY = null;
  const bil = ({ N, v }, half, x, z) => {
    const fx = clamp(((x / half) * 0.5 + 0.5) * (N - 1), 0, N - 1.001), fz = clamp(((z / half) * 0.5 + 0.5) * (N - 1), 0, N - 1.001);
    const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
    const a = v[z0 * N + x0], b = v[z0 * N + x0 + 1], c = v[(z0 + 1) * N + x0], d = v[(z0 + 1) * N + x0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  };
  const inner = grids?.inner, outer = grids?.outer;
  if (inner || outer) {
    const ref = inner || outer;
    const mean = ref.v.reduce((a, b) => a + b, 0) / ref.v.length;
    const range = Math.max(...ref.v) - Math.min(...ref.v);
    const vs = Math.min(2.2 / (range + 1), (3 * SR) / (km * 1000));
    hAt = (x, z) => {
      const m = Math.max(Math.abs(x), Math.abs(z));
      const hi = inner ? bil(inner, SR, x, z) : null, ho = outer ? bil(outer, SR * 3, x, z) : null;
      const w = inner && outer ? sstep(SR * 0.75, SR * 0.98, m) : outer ? 1 : 0;
      const h = (hi == null ? ho : ho == null ? hi : lerp(hi, ho, w)) - mean;
      return clamp(h * vs, -6, 7) + fbm(x * 0.35 + seed, z * 0.35, 3) * 0.12 + fbm(x * 0.06, z * 0.06 + seed, 3) * 0.35 * sstep(SR, RO, Math.hypot(x, z));
    };
    if (site.water) waterY = (0 - mean) * vs;
  } else {
    hAt = (x, z) => fbm(x * 0.08 + seed, z * 0.08, 5) * 1.1 + fbm(x * 0.4, z * 0.4 + seed, 3) * 0.15;
    if (site.water) waterY = 1.2;
  }
  const edge = (x, z) => { const a = Math.atan2(z, x); return Math.hypot(x, z) / (SR * (1 + 0.06 * Math.sin(3 * a + eSeed) + 0.04 * Math.sin(5 * a + eSeed * 2) + 0.03 * Math.sin(7 * a + eSeed * 3))); };

  // surrounding ground: real elevation, land‑cover tint, procedural forests / settlements, highlighted footprint
  const lc = landcover(site.lat, site.lon, site.water);
  const gg = new THREE.PlaneGeometry(RO * 2, RO * 2, 260, 260);
  gg.rotateX(-Math.PI / 2);
  const gp0 = gg.attributes.position;
  for (let i = 0; i < gp0.count; i++) gp0.setY(i, hAt(gp0.getX(i), gp0.getZ(i)) - 0.03);
  const groundU = { uA: { value: 0 }, uR: { value: SR }, uRO: { value: RO }, uSeed: { value: eSeed }, uTint: { value: lc.tint }, uForest: { value: lc.forest }, uUrban: { value: lc.urban }, uAcc: { value: ACC }, uL: { value: new THREE.Vector3(-0.5, 0.8, 0.4).normalize() }, uWaterSite: { value: site.water ? 1 : 0 }, uTime: siteU.uTime };
  const ground = new THREE.Mesh(gg, new THREE.ShaderMaterial({
    uniforms: groundU, transparent: true, depthWrite: false, extensions: { derivatives: true },
    vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uA, uR, uRO, uSeed, uForest, uUrban, uWaterSite, uTime; uniform vec3 uTint, uAcc, uL;
      varying vec3 vW;
      float h2(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float n2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1,0)), u.x), mix(h2(i + vec2(0,1)), h2(i + vec2(1,1)), u.x), u.y); }
      float dts(vec2 q, float dens, float rad, out float rnd){ vec2 c = floor(q), f = fract(q); rnd = h2(c + 7.1); vec2 o = vec2(h2(c), h2(c + 3.7)) * 0.6 + 0.2; return (1.0 - smoothstep(rad * 0.6, rad, length(f - o))) * step(h2(c + 1.3), dens); }
      ${EDGE_GLSL}
      void main(){
        vec3 N = normalize(cross(dFdx(vW), dFdy(vW))); if (N.y < 0.0) N = -N;
        float diff = 0.32 + 0.68 * max(dot(N, uL), 0.0);
        vec2 p = vW.xz; float r = length(p); float e = edgeF(p);
        vec3 col = uTint * (0.85 + 0.3 * n2(p * 0.5 + uSeed) + 0.12 * n2(p * 3.0));
        float rr;
        // fields / patchwork
        vec2 fp = floor(p * 0.55 + vec2(n2(p * 0.2) * 0.6));
        col *= 0.9 + 0.2 * h2(fp) * (1.0 - uWaterSite);
        // forest patches with canopy dots
        float fm = clamp(uForest * 1.3, 0.0, 1.0) * smoothstep(0.3, 0.62, n2(p * 0.11 + uSeed)) * (1.0 - uWaterSite);
        col = mix(col, vec3(0.02, 0.05, 0.025), dts(p * 3.2, fm, 0.46, rr) * 0.85);
        col += vec3(0.04, 0.09, 0.04) * dts(p * 3.2 + 0.2, fm, 0.2, rr) * 0.6;
        // settlements: street grid, roofs and lit windows
        float um = clamp(uUrban * 1.4, 0.0, 1.0) * smoothstep(0.5, 0.75, n2(p * 0.06 + uSeed * 2.0)) * (1.0 - uWaterSite);
        vec2 gq = abs(fract(p * 1.1) - 0.5);
        float street = smoothstep(0.38, 0.46, max(gq.x, gq.y));
        col = mix(col, mix(vec3(0.32, 0.31, 0.3), vec3(0.12), street), um * 0.85);
        col += vec3(1.0, 0.7, 0.35) * dts(p * 4.4, um * 0.5, 0.18, rr) * (0.5 + rr);
        // contours
        float hk = vW.y * 2.5; float c = abs(fract(hk + 0.5) - 0.5) / max(fwidth(hk), 1e-4);
        col += vec3(0.06) * (1.0 - smoothstep(0.0, 1.0, c));
        col *= diff;
        // active footprint
        float inside = 1.0 - smoothstep(0.985, 1.015, e);
        float rim = exp(-pow((e - 1.0) * 70.0, 2.0));
        vec2 tg = abs(fract(p * 0.5) - 0.5);
        float grid = (1.0 - smoothstep(0.0, 0.02, 0.5 - max(tg.x, tg.y))) * inside;
        col = mix(col * 0.5, col * 1.1, inside) + uAcc * (rim * 0.45 + grid * 0.05 + inside * 0.02);
        float halo = exp(-max(e - 1.0, 0.0) * 6.0) * (1.0 - inside);
        col += uAcc * halo * 0.04;
        float a = uA * (1.0 - smoothstep(uRO * 0.62, uRO * 0.98, r)) * mix(1.0, 0.5, inside);
        gl_FragColor = vec4(col, a);
      }`,
  }));
  ground.renderOrder = -1;
  ground.frustumCulled = false;
  g.add(ground);
  const LAYERS = 6;
  const hor = (k, x, z) => -((k + 1) / (LAYERS + 1)) * depthU + fbm(x * 0.12 + k * 3 + seed, z * 0.12, 3) * 0.6 + Math.sin(x * 0.25 + k) * 0.25;

  const pos = [], dat = [];
  const push = (x, y, z, type, layer, dep) => { pos.push(x, y, z); dat.push(type, layer, dep, rng()); };
  for (let i = 0; i < 230; i++) for (let j = 0; j < 230; j++) {
    const x = lerp(-SR, SR, (i + rng() * 0.5) / 230), z = lerp(-SR, SR, (j + rng() * 0.5) / 230);
    if (edge(x, z) > 1) continue;
    push(x, hAt(x, z), z, 0, 0, -1);
  }
  for (let k = 0; k < LAYERS; k++) for (let i = 0; i < 120; i++) for (let j = 0; j < 120; j++) {
    const x = lerp(-SR, SR, (i + rng() * 0.6) / 120), z = lerp(-SR, SR, (j + rng() * 0.6) / 120);
    if (edge(x, z) > 1) continue;
    push(x, hor(k, x, z) + hAt(x, z) * 0.3, z, 1, k + 1, -1);
  }
  for (let i = 0; i < 40000; i++) {
    const x = lerp(-SR, SR, rng()), z = lerp(-SR, SR, rng());
    if (edge(x, z) > 1) continue;
    const top = hAt(x, z), y = lerp(-depthU, top - 0.05, rng());
    let L = 1; for (let k = 0; k < LAYERS; k++) if (y < hor(k, x, z)) L = k + 2;
    push(x, y, z, 2, Math.min(L, 6), -1);
  }
  const depCenters = [];
  results.forEach((d, id) => {
    siteU.uDepCol.value[id].set(d.color);
    const cx = d.pos[0] * SR, cz = d.pos[1] * SR;
    const cy = hAt(cx, cz) * 0.3 - (d.depth / (depthKm * 1000)) * depthU;
    const ry = Math.max(0.18, (d.thick / (depthKm * 1000)) * depthU * 0.6);
    depCenters.push(new THREE.Vector3(cx, cy, cz));
    for (let i = 0; i < 3800; i++) {
      const gx = (rng() + rng() + rng() - 1.5) * 1.6, gz = (rng() + rng() + rng() - 1.5) * 1.3, gy = (rng() + rng() + rng() - 1.5) * ry * 1.4;
      push(cx + gx, cy + gy, cz + gz, 3, 0, id);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aData', new THREE.Float32BufferAttribute(dat, 4));
  siteU.uSrc.value.set(0, hAt(0, 0) - 0.4, 0);
  const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: siteU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aData;
      uniform float uTime, uPR, uScanR, uSlice, uSliceA, uClassify, uReveal, uIntro, uHot, uFocusK, uFocusDep;
      uniform vec3 uSrc, uDepCol[4], uLayCol[7], uAcc;
      varying vec3 vC; varying float vA;
      void main(){
        float type = aData.x, layer = aData.y, dep = aData.z, rnd = aData.w;
        float isS = 1.0 - step(0.5, type), isH = step(0.5, type) * (1.0 - step(1.5, type)), isV = step(1.5, type) * (1.0 - step(2.5, type)), isD = step(2.5, type);
        vec3 p = position;
        float d = distance(p, uSrc);
        float det = smoothstep(uScanR, uScanR - 1.2, d);
        float front = exp(-pow((d - uScanR) * 2.2, 2.0)) * step(0.05, uScanR) * (1.0 - uClassify);
        float wave = 0.0;
        for (int i = 0; i < 3; i++) { float r = mod(uTime * 2.6 + float(i) * 5.0, 15.0); wave += exp(-pow((d - r) * 2.4, 2.0)) * (1.0 - r / 15.0); }
        wave *= step(0.05, uScanR) * (1.0 - uClassify) * smoothstep(uScanR + 1.0, uScanR - 0.5, d);
        vec3 raw = vec3(0.85, 0.88, 0.92);
        float b = isS * (0.14 + wave * 0.8) + isH * (det * 0.36 + front * 1.0 + wave * 0.7) + isV * (det * 0.07 + front * 0.25 + wave * 0.12) + isD * (det * 0.12 + front * 0.6);
        vec3 col = raw * b + uAcc * front * (isH * 0.5 + isV * 0.1 + isD * 0.4);
        int li = int(layer + 0.5); int di = int(max(dep, 0.0) + 0.5);
        vec3 lc = uLayCol[li];
        float behind = 1.0 - step(uSlice, p.x);
        float cl = clamp(uClassify + behind * uSliceA, 0.0, 1.0) * (isS + (1.0 - isS) * det);
        float hot = isD * (1.0 - step(0.5, abs(dep - uHot)));
        vec3 cls = lc * (isS * 0.12 + isH * 0.95 + isV * 0.22) + uDepCol[di] * isD * (0.35 + uReveal * (1.6 + 0.5 * sin(uTime * 2.5 + rnd * 6.28)) + hot * 2.0);
        col = mix(col, cls, cl);
        col += vec3(1.0, 0.95, 0.9) * exp(-pow((p.x - uSlice) * 5.0, 2.0)) * uSliceA * det * (1.0 - isS * 0.7);
        float intro = smoothstep(rnd * 0.6, rnd * 0.6 + 0.4, uIntro);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float ps = (isS * 1.8 + isH * 2.0 + isV * 1.5 + isD * 2.6) * (0.6 + rnd * 0.8) * uPR * (12.0 / -mv.z);
        float sel = isD * (1.0 - step(0.5, abs(dep - uFocusDep)));
        vA = intro * (1.0 - uFocusK * mix(0.9, 0.93, sel)); if (ps < 1.2) { vA *= ps / 1.2; ps = 1.2; }
        gl_PointSize = ps; vC = col;
      }`,
    fragmentShader: `varying vec3 vC; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5 || vA < 0.003) discard; gl_FragColor = vec4(vC, vA * (1.0 - smoothstep(0.25, 0.5, r))); }`,
  }));
  pts.frustumCulled = false;
  g.add(pts);

  // outline + depth frame
  const top = [], bot = [], vert = [];
  for (let i = 0; i <= 160; i++) {
    const a = (i / 160) * TAU; let r = 0.5; while (r < SR * 1.2 && edge(Math.cos(a) * r, Math.sin(a) * r) < 1) r += 0.05;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    top.push(new THREE.Vector3(x, hAt(x, z) + 0.04, z)); bot.push(new THREE.Vector3(x, -depthU, z));
    if (i % 20 === 0) vert.push(new THREE.Vector3(x, hAt(x, z), z), new THREE.Vector3(x, -depthU, z));
  }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: ACC, transparent: true, opacity: 0.9 })));
  const dim = new THREE.LineBasicMaterial({ color: 0xecebe6, transparent: true, opacity: 0.16 });
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bot), dim));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vert), dim));
  // geophones
  const gp = [];
  for (let i = -8; i <= 8; i += 1.6) for (let j = -8; j <= 8; j += 1.6) { if (edge(i, j) > 0.92) continue; const y = hAt(i, j); gp.push(new THREE.Vector3(i, y, j), new THREE.Vector3(i, y + 0.3, j)); }
  const geoMat = new THREE.LineBasicMaterial({ color: 0xecebe6, transparent: true, opacity: 0 });
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gp), geoMat));
  // probe
  const probeMat = new THREE.LineBasicMaterial({ color: ACC, transparent: true, opacity: 0 });
  const y0 = hAt(0, 0);
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, y0 + 2.2, 0), new THREE.Vector3(0, y0 - 0.4, 0)]), probeMat));
  // water
  let waterMat = null;
  if (waterY != null) {
    waterMat = new THREE.ShaderMaterial({
      uniforms: { uTime: siteU.uTime, uA: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime, uA; varying vec2 vP; void main(){ float r = length(vP); if (r > ${(RO * 0.98).toFixed(2)}) discard; float fade = 1.0 - smoothstep(${(RO * 0.6).toFixed(2)}, ${(RO * 0.98).toFixed(2)}, r);
        vec2 g = abs(fract(vP * 0.8 + vec2(uTime * 0.05, 0.0)) - 0.5); float l = 1.0 - smoothstep(0.0, 0.03, min(g.x, g.y));
        gl_FragColor = vec4(vec3(0.2, 0.55, 0.9) * (0.25 + l * 0.6), (0.18 + l * 0.25) * uA * fade); }`,
    });
    const w = new THREE.Mesh(new THREE.CircleGeometry(RO, 128), waterMat);
    w.rotation.x = -Math.PI / 2; w.position.y = waterY;
    g.add(w);
  }
  g.userData = { geoMat, probeMat, waterMat, depCenters, depthU, groundU };
  return g;
}

/* =========================================================
   Scan flow
   ========================================================= */
let scanTL = null;
async function startScan() {
  if (!S.site?.ok || S.phase === 'scanning') return;
  S.phase = 'scanning';
  setStep('scan');
  document.querySelectorAll('.seg[data-param]').forEach((s) => s.classList.add('is-locked'));
  renderSite(); renderRes();
  const site = S.site;
  const gridP = (async () => ({ inner: await fetchSiteGrid(site.lat, site.lon, S.params.radius), outer: await fetchSiteGrid(site.lat, site.lon, S.params.radius * 3.2) }))();
  S.results = runSurvey(site, S.params, S.prior);
  // dive in
  flyTo(site.lat - 8, site.lon, 1.22, 1.3);
  await new Promise((r) => setTimeout(r, 1100));
  $('fade').classList.add('is-on');
  const grid = await Promise.race([gridP, new Promise((r) => setTimeout(() => r(null), 5000))]);
  await new Promise((r) => setTimeout(r, 450));
  if (site3d) { siteScene.remove(site3d); site3d = null; }
  site3d = buildSite(site, grid, S.results);
  siteScene.add(site3d);
  enterSiteView();
  $('fade').classList.remove('is-on');
  $('scanUI').hidden = false;
  $('viewHint').querySelector('span').textContent = 'Drag to orbit · scroll to zoom';

  const U = siteU, ud = site3d.userData;
  const maxR = Math.hypot(SR, ud.depthU) + 2;
  Object.assign(U, {}); U.uScanR.value = 0; U.uSlice.value = -SR - 1; U.uSliceA.value = 0; U.uClassify.value = 0; U.uReveal.value = 0; U.uIntro.value = 0;
  const stages = [...$('scanStages').children];
  const stageAt = [0, 0.13, 0.32, 0.55, 0.8];
  scanTL = gsap.timeline({
    onUpdate() {
      const p = scanTL.progress();
      $('scanPct').textContent = `${Math.round(p * 100)}%`;
      $('scanArc').style.strokeDashoffset = 175.9 * (1 - p);
      let k = 0; stageAt.forEach((s, i) => { if (p >= s) k = i; });
      stages.forEach((li, i) => { li.classList.toggle('is-on', i === k); li.classList.toggle('is-done', i < k); });
      const sr = U.uScanR.value;
      $('lvDepth').textContent = `${fmt(clamp(sr / maxR, 0, 1) * S.params.depth * 1000)} m`;
      $('lvRefl').textContent = Math.min(6, Math.floor(clamp(sr / maxR, 0, 1) * 7));
      $('lvPts').textContent = qty(Math.pow(p, 1.3) * 41e6);
      drawTrace(p);
    },
    onComplete: finishScan,
  });
  scanTL.to(ud.groundU.uA, { value: 1, duration: 1.2, ease: 'power2.out' }, 0)
    .to(U.uIntro, { value: 1, duration: 1.4, ease: 'power2.out' }, 0)
    .to(ud.geoMat, { opacity: 0.55, duration: 0.8 }, 0.6)
    .to(ud.probeMat, { opacity: 1, duration: 0.6 }, 0.9)
    .to(U.uScanR, { value: maxR, duration: 6, ease: 'power1.inOut' }, 1.8)
    .to(U.uSliceA, { value: 1, duration: 0.3 }, 7.6)
    .fromTo(U.uSlice, { value: -SR - 1 }, { value: SR + 1, duration: 3.2, ease: 'none' }, 7.7)
    .to(U.uSliceA, { value: 0, duration: 0.4 }, 10.9)
    .to(U.uClassify, { value: 1, duration: 0.8 }, 10.7)
    .to(U.uReveal, { value: 1, duration: 1.6, ease: 'power2.out' }, 11.2)
    .to({}, { duration: 0.6 }, 12.8);
  if (ud.waterMat) scanTL.to(ud.waterMat.uniforms.uA, { value: 1, duration: 1 }, 0.2);
}

function finishScan() {
  scanTL = null;
  S.phase = 'results';
  setStep('results');
  $('scanUI').hidden = true;
  renderAll();
  switchTab('res');
  toast(S.results.length ? `Scan complete · ${S.results.length} ore bod${S.results.length > 1 ? 'ies' : 'y'} detected` : 'Scan complete · no economic mineralisation');
}

function enterSiteView() {
  S.view = 'site';
  view.classList.add('is-site');
  renderPass.scene = siteScene; renderPass.camera = sCam;
  gCtl.enabled = false; sCtl.enabled = true;
  sCam.position.set(26, 12, 30);
  sCtl.target.set(0, -3, 0);
  sCtl.autoRotate = true;
  sCtl.update();
  $('tGlobe').hidden = false; $('tDeploy').hidden = true;
  bloom.strength = 0.8; bloom.threshold = 0.62;
}

async function backToGlobe(quick = false) {
  if (S.view !== 'site') return;
  if (scanTL) { scanTL.kill(); scanTL = null; }
  focusIdx = -1; specimen = null; $('spec').hidden = true; siteU.uFocusK.value = 0;
  if (!quick) { $('fade').classList.add('is-on'); await new Promise((r) => setTimeout(r, 450)); }
  S.view = 'globe';
  view.classList.remove('is-site');
  renderPass.scene = globeScene; renderPass.camera = gCam;
  sCtl.enabled = false; gCtl.enabled = true;
  $('tGlobe').hidden = true; $('tDeploy').hidden = false; $('scanUI').hidden = true;
  $('dlabels').innerHTML = ''; depLabelEls = [];
  $('viewHint').querySelector('span').textContent = 'Click anywhere on Earth to place the DF‑7 array';
  bloom.strength = 0.55; bloom.threshold = 0.55;
  if (S.site) flyTo(S.site.lat, S.site.lon, 2.2, 1.2);
  if (!quick) $('fade').classList.remove('is-on');
}

function resetAll(fly = true) {
  if (scanTL) { scanTL.kill(); scanTL = null; }
  backToGlobe(true);
  if (site3d) { siteScene.remove(site3d); site3d = null; }
  placeReq++;
  Object.assign(S, { phase: 'place', site: null, results: null, hazards: null, prior: null, hot: -1 });
  document.querySelectorAll('.seg[data-param]').forEach((s) => s.classList.remove('is-locked'));
  setMarker(null);
  setStep('place');
  renderAll();
  document.querySelector('[data-tab="haz"]').textContent = 'Geohazards';
  if (fly) { gsap.to(gCam.position, { x: 0.6, y: 0.9, z: 3.2, duration: 1.4, ease: 'power3.inOut', onStart: () => { flying = true; gDistT = 3.38; }, onComplete: () => (flying = false), onUpdate: () => gCam.lookAt(0, 0, 0) }); gCtl.autoRotate = true; $('tSpin').setAttribute('aria-pressed', 'true'); }
}

/* ---------- deposit labels in site view ---------- */
let depLabelEls = [];
function setHot(i) {
  S.hot = i;
  siteU.uHot.value = i < 0 ? -5 : i;
  document.querySelectorAll('.dep').forEach((el) => el.classList.toggle('is-hot', +el.dataset.i === i));
  depLabelEls.forEach((el, k) => el.classList.toggle('is-hot', k === i));
}
/* ---------- 3D ore specimens ---------- */
function lumpGeo(det, amt, sx, sy, sz, seed) {
  const g = new THREE.IcosahedronGeometry(1, det);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = vnoise(v.x * 1.9 + seed, v.y * 1.9 + v.z * 1.3) * 0.6 + vnoise(v.y * 3.7 - seed, v.z * 3.7 + v.x) * 0.4;
    v.multiplyScalar(1 + n * amt);
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}
function crystalGeo(r, h, sides = 6, tip = 2) {
  const body = new THREE.CylinderGeometry(r, r * 1.08, h, sides, 1).toNonIndexed(); body.translate(0, h / 2, 0);
  const cone = new THREE.ConeGeometry(r, r * tip, sides).toNonIndexed(); cone.translate(0, h + (r * tip) / 2, 0);
  const g = mergeGeometries([body, cone]); g.computeVertexNormals(); return g;
}
const M = (o) => new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0, envMapIntensity: 1, ...o });
const ORE_STYLE = {
  cu: { host: '#3d3530', a: M({ color: '#c06a32', metalness: 1, roughness: 0.3 }), b: M({ color: '#2fae74', roughness: 0.45, emissive: '#0a3a20', emissiveIntensity: 0.4 }), shapeA: 'nugget', shapeB: 'needle' },
  au: { host: '#3a3633', a: M({ color: '#e0ad35', metalness: 1, roughness: 0.3, envMapIntensity: 0.7 }), b: M({ color: '#f1eee8', roughness: 0.2, transmission: 0.45, thickness: 0.3, ior: 1.54 }), shapeA: 'nugget', shapeB: 'prism', invert: true },
  li: { host: '#4a4640', a: M({ color: '#cdeff3', roughness: 0.08, transmission: 0.7, thickness: 0.3, ior: 1.66, emissive: '#6fe2ff', emissiveIntensity: 0.06 }), b: M({ color: '#b9b2a8', roughness: 0.7 }), shapeA: 'lath', shapeB: 'nugget' },
  ree: { host: '#3a2e2a', a: M({ color: '#9a6bff', roughness: 0.1, transmission: 0.6, thickness: 0.35, ior: 1.43, emissive: '#4b22c0', emissiveIntensity: 0.25 }), b: M({ color: '#8a5a3c', roughness: 0.5, metalness: 0.2 }), shapeA: 'octa', shapeB: 'cube' },
  ni: { host: '#2f3328', a: M({ color: '#b39a5a', metalness: 1, roughness: 0.35 }), b: M({ color: '#6fcf8c', roughness: 0.5, emissive: '#123c1c', emissiveIntensity: 0.3 }), shapeA: 'block', shapeB: 'nugget' },
  fe: { host: '#3a2420', a: M({ color: '#4a4c52', metalness: 0.9, roughness: 0.28 }), b: M({ color: '#9c2f22', roughness: 0.6 }), shapeA: 'plate', shapeB: 'band' },
  zn: { host: '#34302c', a: M({ color: '#8c9096', metalness: 1, roughness: 0.25 }), b: M({ color: '#a8642a', roughness: 0.2, transmission: 0.4, thickness: 0.2, ior: 2.37 }), shapeA: 'cube', shapeB: 'tetra' },
  u: { host: '#2c2a28', a: M({ color: '#141414', metalness: 0.4, roughness: 0.35 }), b: M({ color: '#e5f24a', roughness: 0.5, emissive: '#9fb300', emissiveIntensity: 0.5 }), shapeA: 'botryoid', shapeB: 'flake' },
  pgm: { host: '#26282a', a: M({ color: '#dfe3e8', metalness: 1, roughness: 0.2 }), b: M({ color: '#151515', metalness: 0.6, roughness: 0.4 }), shapeA: 'nugget', shapeB: 'octa' },
  co: { host: '#2e2a2a', a: M({ color: '#d0679b', roughness: 0.35, emissive: '#4a0f2a', emissiveIntensity: 0.3 }), b: M({ color: '#7d8188', metalness: 1, roughness: 0.3 }), shapeA: 'needle', shapeB: 'cube' },
  sn: { host: '#2f2c29', a: M({ color: '#3a2618', metalness: 0.3, roughness: 0.25 }), b: M({ color: '#ece8e1', roughness: 0.25, transmission: 0.35, thickness: 0.2 }), shapeA: 'bipyramid', shapeB: 'prism' },
};
function shapeGeo(kind, s, rnd) {
  switch (kind) {
    case 'nugget': return lumpGeo(1, 0.45, s, s * 0.75, s, rnd * 50);
    case 'block': return lumpGeo(0, 0.22, s, s, s, rnd * 50);
    case 'botryoid': return lumpGeo(2, 0.25, s, s * 0.8, s, rnd * 50);
    case 'needle': return crystalGeo(s * 0.12, s * 1.6, 6, 1.2);
    case 'prism': return crystalGeo(s * 0.32, s * 1.5, 6, 1.6);
    case 'lath': return crystalGeo(s * 0.28, s * 2.6, 4, 1.4);
    case 'octa': return new THREE.OctahedronGeometry(s * 0.7, 0);
    case 'bipyramid': { const g = new THREE.OctahedronGeometry(s * 0.6, 0); g.scale(0.8, 1.4, 0.8); return g; }
    case 'cube': return new THREE.BoxGeometry(s, s, s);
    case 'tetra': return new THREE.TetrahedronGeometry(s * 0.7, 0);
    case 'plate': return new THREE.BoxGeometry(s * 1.5, s * 0.12, s * 1.1);
    case 'band': return new THREE.BoxGeometry(s * 2.2, s * 0.2, s * 0.5);
    case 'flake': return new THREE.BoxGeometry(s * 0.6, s * 0.04, s * 0.6);
    default: return lumpGeo(1, 0.3, s, s, s, rnd);
  }
}
function richness(d) {
  const tonN = clamp((Math.log(d.ore) - Math.log(d.ore_min)) / (Math.log(d.ore_max) - Math.log(d.ore_min)), 0, 1);
  const gradeN = clamp((d.grade - d.g_min) / (d.g_max - d.g_min), 0, 1);
  return {
    tonN, gradeN,
    size: tonN > 0.75 ? 'Tier‑1 size' : tonN > 0.45 ? 'Large' : tonN > 0.2 ? 'Mid‑size' : 'Small',
    gradeTxt: gradeN > 0.72 ? 'High grade' : gradeN > 0.38 ? 'Average grade' : 'Low grade',
  };
}
function buildSpecimen(d) {
  const st = ORE_STYLE[d.key] || ORE_STYLE.cu;
  const R = richness(d);
  const rng = mulberry32(hashStr(`${d.key}${d.depth.toFixed(0)}${d.ore.toFixed(2)}`));
  const g = new THREE.Group();
  const hostS = 0.75 + R.tonN * 0.55;
  const host = new THREE.Mesh(lumpGeo(3, 0.38, hostS, hostS * 0.62, hostS * 0.8, rng() * 40), M({ color: st.host, roughness: 0.92, flatShading: true, envMapIntensity: 0.4 }));
  g.add(host);
  // ore count scales with tonnage, crystal size with grade
  const nA = Math.round(5 + R.tonN * 22 + R.gradeN * 8);
  const nB = Math.round(3 + (1 - R.gradeN) * 8 + R.tonN * 6);
  const sizeA = 0.09 + R.gradeN * 0.16;
  const place = (mesh, spread) => {
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 1.4 - 0.3, rng() * 2 - 1).normalize();
    mesh.position.copy(dir).multiply(new THREE.Vector3(hostS, hostS * 0.62, hostS * 0.8)).multiplyScalar(spread);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.rotateY(rng() * TAU);
    g.add(mesh);
  };
  for (let i = 0; i < nA; i++) place(new THREE.Mesh(shapeGeo(st.shapeA, sizeA * (0.6 + rng() * 0.8), rng()), st.a), 0.78 + rng() * 0.22);
  for (let i = 0; i < nB; i++) place(new THREE.Mesh(shapeGeo(st.shapeB, 0.07 + rng() * 0.12, rng()), st.b), 0.82 + rng() * 0.2);
  // high-grade bodies get a glowing core vein
  if (R.gradeN > 0.6) {
    const vein = new THREE.Mesh(new THREE.TorusGeometry(hostS * 0.7, 0.025 + R.gradeN * 0.03, 8, 64), M({ color: d.color, emissive: d.color, emissiveIntensity: 0.9, roughness: 0.3 }));
    vein.rotation.set(rng() * 3, rng() * 3, 0); vein.scale.set(1, 0.6, 0.85);
    g.add(vein);
  }
  const lt = new THREE.PointLight(new THREE.Color(d.color), 1.6, 6, 2); lt.position.set(1.2, 1.6, 1.8); g.add(lt);
  const rim = new THREE.PointLight(0x9fc0ff, 1.4, 6, 2); rim.position.set(-1.4, 0.6, -1.2); g.add(rim);
  // orbit ring
  const ring = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * TAU; ring.push(new THREE.Vector3(Math.cos(a) * hostS * 1.7, 0, Math.sin(a) * hostS * 1.7)); }
  const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: new THREE.Color(d.color), transparent: true, opacity: 0.6 }));
  g.add(rl);
  g.userData = { R, ring: rl };
  return g;
}

let specimen = null, focusIdx = -1, preFocus = null;
function focusDeposit(i) {
  if (S.view !== 'site' || !site3d || S.phase !== 'results') return;
  const d = S.results[i];
  const c = site3d.userData.depCenters[i];
  if (focusIdx < 0) preFocus = { pos: sCam.position.clone(), tgt: sCtl.target.clone(), rot: sCtl.autoRotate };
  if (specimen) { const old = specimen; gsap.to(old.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 0.4, onComplete: () => site3d?.remove(old) }); }
  focusIdx = i;
  specimen = buildSpecimen(d);
  specimen.position.copy(c);
  specimen.scale.setScalar(0.001);
  site3d.add(specimen);
  gsap.to(specimen.scale, { x: 1, y: 1, z: 1, duration: 1.2, delay: 0.5, ease: 'back.out(1.6)' });
  sCtl.autoRotate = true; sCtl.autoRotateSpeed = 0.9;
  gsap.to(sCtl.target, { x: c.x, y: c.y, z: c.z, duration: 1.5, ease: 'power3.inOut' });
  const dir = sCam.position.clone().sub(c).setY(0).normalize();
  const to = c.clone().add(dir.multiplyScalar(4.4)).add(new THREE.Vector3(0, 1.6, 0));
  gsap.to(sCam.position, { x: to.x, y: to.y, z: to.z, duration: 1.5, ease: 'power3.inOut' });
  siteU.uFocusDep.value = i;
  gsap.to(siteU.uFocusK, { value: 1, duration: 1.2 });
  gsap.to(site3d.userData.groundU.uA, { value: 0.25, duration: 1.2 });
  setHot(i);
  showSpec(d, specimen.userData.R);
}
function unfocusDeposit() {
  if (focusIdx < 0) return;
  focusIdx = -1;
  $('spec').hidden = true;
  if (specimen) { const old = specimen; specimen = null; gsap.to(old.scale, { x: 0.001, y: 0.001, z: 0.001, duration: 0.5, ease: 'power2.in', onComplete: () => site3d?.remove(old) }); }
  gsap.to(siteU.uFocusK, { value: 0, duration: 1 });
  if (site3d) gsap.to(site3d.userData.groundU.uA, { value: 1, duration: 1 });
  sCtl.autoRotateSpeed = 0.4;
  if (preFocus) {
    gsap.to(sCtl.target, { x: preFocus.tgt.x, y: preFocus.tgt.y, z: preFocus.tgt.z, duration: 1.3, ease: 'power3.inOut' });
    gsap.to(sCam.position, { x: preFocus.pos.x, y: preFocus.pos.y, z: preFocus.pos.z, duration: 1.3, ease: 'power3.inOut' });
    sCtl.autoRotate = preFocus.rot;
  }
  setHot(-1);
}
function showSpec(d, R) {
  const el = $('spec');
  el.style.setProperty('--c', d.color);
  $('spSym').textContent = d.sym;
  $('spName').textContent = d.name;
  $('spType').textContent = `${d.type} · ${d.mineral}`;
  $('spSize').textContent = R.size; $('spGrade').textContent = R.gradeTxt;
  $('spTon').style.width = `${Math.max(4, R.tonN * 100)}%`;
  $('spGr').style.width = `${Math.max(4, R.gradeN * 100)}%`;
  $('spStats').innerHTML = [
    ['Depth', `${fmt(d.depth)} m`], ['Ore', `${qty(d.ore * 1e6)} t`], ['Grade', `${fmt(d.grade, d.grade < 1 ? 2 : 1)} ${d.gUnit}`],
    ['Contained', `${qty(d.contained)} ${d.cUnit.split(' ')[0]}`], ['Thickness', `${d.thick} m`], ['Confidence', `${d.conf}%`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('spValue').textContent = money(d.value);
  el.hidden = false;
  el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in');
}
function updateDepLabels() {
  if (S.view !== 'site' || !site3d || S.phase !== 'results') return;
  const r = view.getBoundingClientRect();
  if (!depLabelEls.length && S.results.length) {
    depLabelEls = S.results.map((d, i) => {
      const el = document.createElement('div');
      el.className = 'dl'; el.style.color = d.color;
      el.innerHTML = `<i style="background:${d.color}">${d.sym}</i>${d.name}<span>${fmt(d.depth)} m</span>`;
      el.addEventListener('mouseenter', () => setHot(i)); el.addEventListener('mouseleave', () => setHot(-1));
      el.addEventListener('click', () => { focusDeposit(i); document.querySelector(`.dep[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      $('dlabels').appendChild(el);
      return el;
    });
  }
  const v = new THREE.Vector3();
  site3d.userData.depCenters.forEach((c, i) => {
    v.copy(c).project(sCam);
    const el = depLabelEls[i]; if (!el) return;
    el.style.left = `${(v.x * 0.5 + 0.5) * r.width}px`; el.style.top = `${(-v.y * 0.5 + 0.5) * r.height}px`;
    el.style.opacity = v.z < 1 && (focusIdx < 0 || focusIdx === i) ? (focusIdx === i ? 0 : 1) : 0;
    el.style.pointerEvents = focusIdx < 0 ? 'auto' : 'none';
  });
}

/* ---------- live trace ---------- */
const trace = $('trace'), tctx = trace.getContext('2d');
function drawTrace(p) {
  const w = (trace.width = trace.clientWidth * DPR), h = (trace.height = trace.clientHeight * DPR);
  tctx.clearRect(0, 0, w, h);
  tctx.strokeStyle = 'rgba(236,235,230,.65)'; tctx.lineWidth = 1 * DPR;
  const t = performance.now() / 1000;
  for (let k = 0; k < 4; k++) {
    tctx.beginPath();
    const y0 = ((k + 0.5) / 4) * h;
    for (let x = 0; x < w * p; x += 2) {
      const tt = x / w;
      let a = Math.sin(tt * 90 + k * 3 + t * 8) * 0.12;
      [0.18, 0.37, 0.58, 0.8].forEach((c, i) => { const q = (tt - c - k * 0.015) * 60; a += Math.exp(-q * q) * Math.cos(q * 2) * (1 - i * 0.15); });
      const y = y0 + a * h * 0.12;
      x ? tctx.lineTo(x, y) : tctx.moveTo(x, y);
    }
    tctx.stroke();
  }
  tctx.fillStyle = '#ff5a1f'; tctx.fillRect(w * p, 0, 1 * DPR, h);
}

/* =========================================================
   Tabs / styles / interaction
   ========================================================= */
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on); });
  document.querySelector('.tabs__pill').style.transform = `translateX(${tab === 'haz' ? 100 : 0}%)`;
  $('panelRes').hidden = tab !== 'res';
  $('panelHaz').hidden = tab !== 'haz';
  if (tab === 'haz' && S.view === 'site') backToGlobe();
  renderLegend();
}
function setStyle(st) { S.style = st; renderHaz(); }

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('styleSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.v)));
$('subscores').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => setStyle(li.dataset.style)));
document.querySelectorAll('.seg[data-param]').forEach((seg) => {
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    S.params[seg.dataset.param] = +b.dataset.v; setSeg(seg, b.dataset.v); renderSite();
  }));
  setSeg(seg, S.params[seg.dataset.param]);
});
$('scanBtn').addEventListener('click', startScan);
$('resetBtn').addEventListener('click', () => resetAll());
$('skipBtn').addEventListener('click', () => scanTL && scanTL.progress(1));
$('tGlobe').addEventListener('click', () => backToGlobe());
$('specClose').addEventListener('click', unfocusDeposit);
$('tHome').addEventListener('click', () => {
  if (S.view === 'site') { gsap.to(sCam.position, { x: 26, y: 12, z: 30, duration: 1.2, ease: 'power3.inOut' }); gsap.to(sCtl.target, { x: 0, y: -3, z: 0, duration: 1.2 }); }
  else gsap.to(gCam.position, { x: 0.6, y: 0.9, z: 3.2, duration: 1.2, ease: 'power3.inOut', onStart: () => { flying = true; gDistT = 3.38; }, onComplete: () => (flying = false), onUpdate: () => gCam.lookAt(0, 0, 0) });
});
$('tSpin').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', on);
  gCtl.autoRotate = on; sCtl.autoRotate = on;
});
$('tDeploy').addEventListener('click', (e) => {
  S.deploy = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', S.deploy);
});
addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea')) return;
  if (e.key === 'r' || e.key === 'R') resetAll();
  if (e.key === 'Escape' && S.view === 'site') { if (focusIdx >= 0) unfocusDeposit(); else backToGlobe(); }
});
$('presets').innerHTML = PRESETS.map((p, i) => `<button data-p="${i}"><b>${p.name}</b><span>${p.note}</span></button>`).join('');
$('presets').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  if (S.phase === 'scanning') return;
  const p = PRESETS[+b.dataset.p];
  if (S.phase === 'results') resetAll(false);
  placeSite(p.lat, p.lon);
}));

// globe picking
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down = null;
function pickGlobe(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, gCam);
  const o = ray.ray.origin, d = ray.ray.direction;
  const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return latLonFromDir(o.clone().addScaledVector(d, t));
}
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || S.view !== 'globe') return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return;
  const ll = pickGlobe(e);
  if (!ll) return;
  if (S.phase === 'scanning') return;
  if (S.phase === 'results') resetAll(false);
  placeSite(ll.lat, ll.lon);
});
const tip = $('tip');
canvas.addEventListener('pointermove', (e) => {
  if (S.view !== 'globe' || !DATA.ready) { tip.hidden = true; return; }
  const ll = pickGlobe(e);
  if (!ll) { tip.hidden = true; return; }
  const r = view.getBoundingClientRect();
  tip.hidden = false;
  tip.style.left = `${e.clientX - r.left}px`; tip.style.top = `${e.clientY - r.top}px`;
  const sf = surfaceAt(ll.lat, ll.lon), el = eligibility(sf.water, sf.elev);
  $('tLat').textContent = latStr(ll.lat); $('tLon').textContent = lonStr(ll.lon);
  $('tElev').textContent = sf.water ? `Water ≈ ${fmt(-sf.elev)} m deep` : `Land ≈ ${fmt(sf.elev)} m`;
  const ok = $('tOk');
  ok.className = `tip__ok ${el.ok ? 'ok' : 'bad'}`;
  ok.textContent = el.ok ? 'Deployable' : sf.water ? 'Too deep · max 2,000 m' : 'Too high · max 3,000 m';
});
canvas.addEventListener('pointerleave', () => (tip.hidden = true));

/* =========================================================
   Loop
   ========================================================= */
const clock = new THREE.Clock();
function loop() {
  const dt = clock.getDelta(), t = clock.elapsedTime;
  if (S.view === 'globe' && globe) {
    const cd = gCam.position.length();
    if (!flying) gCam.position.setLength(lerp(cd, gDistT, 1 - Math.exp(-dt * 5)));
    const alt = clamp((cd - 1) / 1.4, 0.004, 1);
    gCtl.rotateSpeed = 0.45 * Math.max(0.025, alt);
    gCtl.autoRotateSpeed = 0.35 * Math.max(0.03, alt);
    const nr = clamp((cd - 1) * 0.25, 0.0004, 0.05);
    if (Math.abs(gCam.near - nr) / nr > 0.1) { gCam.near = nr; gCam.updateProjectionMatrix(); }
    globeU.uZoom.value = 1 - sstep(1.06, 2.3, cd);
    gCtl.update();
    const haz = S.tab === 'haz';
    const k = 1 - Math.exp(-dt * 6);
    globeU.uHeatA.value += ((haz && S.style === 'seismic' ? 1 : 0) - globeU.uHeatA.value) * k;
    globeU.uDeploy.value += ((S.deploy ? (haz ? 0.35 : 1) : 0) - globeU.uDeploy.value) * k;
    if (plateLines) plateLines.material.opacity += ((haz && S.style === 'plates' ? 1 : haz ? 0.12 : 0) - plateLines.material.opacity) * k;
    volcPts.material.uniforms.uA.value += ((haz && S.style === 'volc' ? 1 : 0) - volcPts.material.uniforms.uA.value) * k;
    volcPts.visible = volcPts.material.uniforms.uA.value > 0.01;
    if (marker.visible) {
      const s = clamp(gCam.position.distanceTo(marker.position) * 0.42, 0.08, 1.2);
      marker.scale.setScalar(s);
      const pk = (t * 0.8) % 1;
      marker.userData.pulse.scale.setScalar(1 + pk * 1.6);
      marker.userData.pulse.material.opacity = 1;
    }
    globeU.uLight.value.copy(gCam.position).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(new THREE.Vector3(0, 0.4, 0)).normalize();
  } else if (S.view === 'site') {
    sCtl.update();
    siteU.uTime.value = t;
    if (specimen) { specimen.rotation.y += dt * 0.18; specimen.userData.ring.rotation.y -= dt * 0.5; }
    updateDepLabels();
  }
  composer.render();
  requestAnimationFrame(loop);
}

/* =========================================================
   Boot
   ========================================================= */
(async function boot() {
  resize();
  const [plates, volc, quakes, elev, mask, day, night, topo] = await Promise.all([
    getJSON('data/plates.json').catch(() => null),
    getJSON('data/volcanoes.json').catch(() => []),
    getJSON('data/quakes.json').catch(() => []),
    getJSON('data/elevation.json').catch(() => null),
    loadMask(),
    loadImg('https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg', 1024),
    loadImg('https://unpkg.com/three-globe@2.31.0/example/img/earth-night.jpg', 1024),
    loadImg('https://unpkg.com/three-globe@2.31.0/example/img/earth-topology.png'),
  ]);
  Object.assign(DATA, { plates, volc, quakes, elev, mask, day, night, topo, ready: true });
  $('bootTxt').textContent = 'Building globe…';
  buildGlobe();
  renderAll();
  switchTab('res');
  $('boot').classList.add('is-done');
  loop();
  // live USGS feed (optional)
  getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson').then((j) => {
    DATA.live = j.features.map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], mag: f.properties.mag, place: f.properties.place, time: f.properties.time }));
    if (S.site) { S.hazards = hazards(S.site.lat, S.site.lon, S.site.tect); renderHaz(); }
  }).catch(() => {});
  if (!elev) toast('Elevation grid unavailable — using coarse land/sea estimate.', true);
})();
window.__sim = { S, DATA, focus: (i) => focusDeposit(i), unfocus: () => unfocusDeposit(), tl: () => scanTL, cam: gCam, look: (lat, lon, d) => { gCtl.autoRotate = false; gCam.position.copy(dirFromLatLon(lat, lon, d)); gDistT = d; gCam.lookAt(0, 0, 0); } };
