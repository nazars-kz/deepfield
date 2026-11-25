import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import Lenis from 'lenis';

const { gsap, ScrollTrigger } = window;
gsap.registerPlugin(ScrollTrigger);

/* =========================================================
   Utils: seeded random + simplex noise
   ========================================================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1337);
const perm = new Uint8Array(512);
{
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const G2D = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
function snoise(xin, yin) {
  let n0 = 0, n1 = 0, n2 = 0;
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = G2D[perm[ii + perm[jj]] & 7]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = G2D[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = G2D[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
  return 70 * (n0 + n1 + n2);
}
function fbm(x, y, o = 4) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < o; i++) { s += a * snoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const gauss = () => { const u = 1 - rand(), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const TAU = Math.PI * 2;
const V3 = THREE.Vector3;

/* =========================================================
   Geology model (procedural)
   ========================================================= */
const HALF = 10, TOP = 1.0, BOTTOM = -8.8, M_PER_UNIT = 560;
const BASES = [-1.1, -2.2, -3.4, -4.7, -6.0, -7.4];
const FN = { x: 0.94, z: -0.34 }, FC = 1.6, FDIP = 0.32;
const DEEP_BOT = -70;
const EXPLODE_GAP = 1.6;

const surfH = (x, z) => 0.9 * fbm(x * 0.09 + 11, z * 0.09 - 3, 5) + 0.16 * fbm(x * 0.5, z * 0.5, 3);
const faultS = (x, y, z) => x * FN.x + z * FN.z - FC + y * FDIP;
function horizonRaw(k, x, z) {
  const b = BASES[k];
  let h = b + 0.32 * fbm(x * 0.14 + k * 7.1, z * 0.14 - k * 3.3, 3) + (0.25 + k * 0.06) * Math.sin(x * 0.26 + z * 0.12 + 0.6);
  h -= (0.55 + k * 0.08) * sstep(-0.06, 0.06, faultS(x, b, z));
  return h;
}
const H = new Float32Array(6);
function horizonsAt(x, z) {
  let prev = surfH(x, z);
  for (let k = 0; k < 6; k++) { const h = Math.min(horizonRaw(k, x, z), prev - 0.28); H[k] = h; prev = h; }
  return H;
}
const layerTop = (L, x, z) => (L === 1 ? surfH(x, z) : horizonsAt(x, z)[L - 2]);
const layerBot = (L, x, z) => (L <= 6 ? horizonsAt(x, z)[L - 1] : BOTTOM);

// organic survey territory — outline follows the landscape (valleys pull it in, ridges push it out)
const R0 = 8.2;
function blobF(x, z) {
  const a = Math.atan2(z, x), r = Math.hypot(x, z);
  const ca = Math.cos(a), sa = Math.sin(a);
  let rr = R0 * (1 + 0.14 * snoise(ca * 1.3 + 5, sa * 1.3) + 0.06 * snoise(ca * 3.2 + 1, sa * 3.2 - 2));
  rr += 1.4 * surfH(ca * rr * 0.9, sa * rr * 0.9);
  rr = Math.min(rr, 9.7);
  return r / rr;
}

const depthKm = (y) => (y >= BOTTOM ? Math.max(0, -y) / -BOTTOM * 5 : 5 + ((-y + BOTTOM) / (BOTTOM - DEEP_BOT)) * 145);
const yAtKm = (km) => (km <= 5 ? -km / 5 * -BOTTOM : BOTTOM - ((km - 5) / 145) * (BOTTOM - DEEP_BOT));

const DEPOSITS = [
  {
    code: 'CU‑02', name: 'Porphyry copper', kind: 'cu', x: -4.6, z: 2.8, layer: 3, rx: 1.5, rz: 1.1, ry: 0.55, color: '#ff6b2c', conf: 94, ton: '1.24 Mt',
    mineral: 'Chalcopyrite · CuFeS₂ / malachite', grade: '0.62 % Cu · 0.18 g/t Au', host: 'Quartz‑monzonite porphyry', thick: '310 m', method: 'Open pit', value: '$7.4 B',
    note: 'Disseminated sulphides with a supergene malachite cap. Strong velocity low and density contrast at the porphyry contact.',
  },
  {
    code: 'LI‑07', name: 'Lithium pegmatite', kind: 'li', x: 4.4, z: -3.6, layer: 2, rx: 2.0, rz: 1.3, ry: 0.4, color: '#6fe2ff', conf: 88, ton: '310 kt',
    mineral: 'Spodumene · LiAlSi₂O₆', grade: '1.4 % Li₂O', host: 'Granitic pegmatite dyke', thick: '85 m', method: 'Open pit', value: '$2.1 B',
    note: 'Coarse spodumene laths up to 40 cm in a zoned pegmatite. Shallow, low strip ratio.',
  },
  {
    code: 'REE‑01', name: 'Rare‑earth carbonatite', kind: 'ree', x: 5.6, z: 4.6, layer: 5, rx: 1.1, rz: 1.1, ry: 0.6, color: '#b9a2ff', conf: 81, ton: '92 kt',
    mineral: 'Bastnäsite · (Ce,La)CO₃F + fluorite', grade: '3.8 % TREO', host: 'Carbonatite plug', thick: '140 m', method: 'Underground', value: '$1.3 B',
    note: 'Light‑REE enriched carbonatite with violet fluorite. Distinct high‑density, high‑velocity body.',
  },
  {
    code: 'AU‑11', name: 'Orogenic gold', kind: 'au', x: -3.2, z: -5.0, layer: 4, rx: 0.9, rz: 1.8, ry: 0.45, color: '#ffd166', conf: 76, ton: '48 t',
    mineral: 'Native gold in quartz veins', grade: '6.2 g/t Au', host: 'Greenstone shear zone', thick: '4–12 m veins', method: 'Underground', value: '$3.0 B',
    note: 'Free gold in laminated quartz veins along a reactivated shear. Follows the fault splay.',
  },
  {
    code: 'NI‑04', name: 'Nickel sulphide', kind: 'ni', x: 1.2, z: 1.4, layer: 6, rx: 1.4, rz: 1.4, ry: 0.5, color: '#8dffb0', conf: 83, ton: '640 kt',
    mineral: 'Pentlandite · (Fe,Ni)₉S₈', grade: '1.9 % Ni · 0.4 % Cu', host: 'Ultramafic intrusion', thick: '60 m', method: 'Underground', value: '$4.6 B',
    note: 'Massive to net‑textured sulphides at the base of an ultramafic sill. High density, high conductivity.',
  },
];

const SITES = [
  { name: 'Atacama', cc: 'CL', lat: -24.5, lon: -69.2, status: 'Live', target: true },
  { name: 'Pilbara', cc: 'AU', lat: -21.4, lon: 118.6, status: 'Processing' },
  { name: 'Kryvbas', cc: 'UA', lat: 47.9, lon: 33.4, status: 'Licensed' },
  { name: 'Nevada', cc: 'US', lat: 39.5, lon: -117.0, status: 'Processing' },
  { name: 'Katanga', cc: 'CD', lat: -10.7, lon: 26.5, status: 'Licensed' },
  { name: 'Kvanefjeld', cc: 'GL', lat: 60.9, lon: -45.9, status: 'Planned' },
  { name: 'Bushveld', cc: 'ZA', lat: -25.0, lon: 29.0, status: 'Licensed' },
];

const DEPTH_MARKS = [
  { km: 0, name: 'Surface', meta: 'DF‑7 array' },
  { km: 5, name: 'Survey floor', meta: 'end of FWI volume' },
  { km: 18, name: 'Conrad discontinuity', meta: 'upper → lower crust' },
  { km: 35, name: 'Mohorovičić', meta: 'crust → mantle' },
  { km: 100, name: 'Lithosphere base', meta: 'rigid plate ends', hot: true },
  { km: 140, name: 'Asthenosphere', meta: 'partial melt · ~1 300 °C', hot: true },
];

/* =========================================================
   Renderer / scene
   ========================================================= */
const isMobile = matchMedia('(max-width: 900px)').matches;
const Q = isMobile ? 0.45 : 1;
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const DPR = Math.min(window.devicePixelRatio, isMobile ? 1.5 : 1.75);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#030405');
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.05, 20000);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const ACCENT = new THREE.Color('#ff5a1f');
const SOURCE = new V3(0, surfH(0, 0) - 0.45, 0);

// lights for the solid-section specimens
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const keyLight = new THREE.DirectionalLight(0xfff1e2, 1.5);
scene.add(keyLight, keyLight.target);
const rimLight = new THREE.DirectionalLight(0x8fb4ff, 0.9);
rimLight.position.set(-12, 6, -4);
scene.add(rimLight);

const GLSL_NOISE = /* glsl */ `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

/* =========================================================
   Point volume (survey territory)
   ========================================================= */
const pointVS = /* glsl */ `
attribute vec4 aData;   // layer, type, depositId, rnd
attribute vec3 aExtra;  // density, fault distance, territory blob (0 centre → 1 edge)
uniform float uTime, uPR, uSize, uIntro;
uniform vec3 uSource;
uniform float uPulse, uScanR, uSlice, uSliceA, uClassify, uExplode, uSurface, uCollapse, uPtsA;
uniform float uFocus, uAperture, uHover, uSweepY, uSweepA;
uniform vec4 uMode;
uniform vec3 uLayerCol[8];
uniform vec3 uDepCol[5];
uniform vec3 uAccent;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;

void main(){
  float layer = aData.x, type = aData.y, dep = aData.z, rnd = aData.w;
  float isSurf = 1.0 - step(0.5, type);
  float isHor  = step(0.5, type) * (1.0 - step(1.5, type));
  float isVol  = step(1.5, type) * (1.0 - step(2.5, type));
  float isDep  = step(2.5, type);
  float blob = aExtra.z;
  float rim = smoothstep(0.84, 0.99, blob);
  vec3 p = position;

  float d = distance(p, uSource);
  float wave = 0.0;
  for (int i = 0; i < 3; i++) {
    float r = mod(uTime * 2.3 + float(i) * 4.7, 14.0);
    wave += exp(-pow((d - r) * 2.6, 2.0)) * (1.0 - r / 14.0);
  }
  wave *= uPulse;
  float detected = smoothstep(uScanR, uScanR - 1.4, d);
  float gate = smoothstep(uScanR + 1.0, uScanR - 0.5, d);
  float front = exp(-pow((d - uScanR) * 2.2, 2.0)) * step(0.05, uScanR) * (1.0 - uClassify);

  vec3 raw = vec3(0.86, 0.88, 0.9);
  float rawB = isSurf * ((0.3 + rim * 0.5) * uSurface + wave * 0.9)
             + isHor * (detected * (0.2 + rim * 0.35) + front * 0.95 + wave * gate * 0.7)
             + isVol * (detected * (0.04 + rim * 0.1) + front * 0.22 + wave * gate * 0.14)
             + isDep * (detected * 0.3 + front * 0.9 + wave * gate * 0.5);
  vec3 rawC = raw * rawB + uAccent * front * (isHor * 0.55 + isDep * 0.9 + isVol * 0.12);
  rawC += uAccent * isSurf * rim * 0.45 * uSurface;

  int li = int(layer + 0.5);
  int di = int(max(dep, 0.0) + 0.5);
  vec3 lc = uLayerCol[li];
  vec3 dc = uDepCol[di];
  float pulseDep = 0.7 + 0.3 * sin(uTime * 2.2 + rnd * 6.283);

  vec3 c0 = mix(lc, dc, isDep);
  float b0 = isSurf * 0.26 * uSurface + isHor * (0.62 + rim * 0.3) + isVol * 0.2 + isDep * 1.3;
  float dens = aExtra.x;
  vec3 c1 = mix(vec3(0.08, 0.13, 0.26), uAccent, smoothstep(0.35, 0.9, dens));
  c1 = mix(c1, vec3(1.0, 0.92, 0.8), smoothstep(0.82, 1.0, dens));
  float b1 = isSurf * 0.12 * uSurface + (1.0 - isSurf) * (0.1 + dens * 0.9) * (0.7 + isHor * 0.6);
  vec3 c2 = mix(vec3(0.6, 0.63, 0.66), dc, isDep);
  float b2 = isSurf * 0.1 * uSurface + isHor * 0.14 + isVol * 0.035 + isDep * 2.6 * pulseDep;
  float fd = aExtra.y;
  float f = exp(-fd * fd * 8.0);
  float side = step(0.0, fd);
  vec3 c3 = mix(vec3(0.85, 0.84, 0.8), vec3(0.4, 0.58, 1.0), side);
  c3 = mix(c3, uAccent, f);
  float b3 = isSurf * 0.12 * uSurface + isHor * (0.48 + f * 2.2) + isVol * (0.06 + f * 1.8) + isDep * 0.25;

  vec3 cls = c0 * b0 * uMode.x + c1 * b1 * uMode.y + c2 * b2 * uMode.z + c3 * b3 * uMode.w;
  float hov = isDep * (1.0 - step(0.5, abs(dep - uHover)));
  cls *= 1.0 + hov * 1.4;

  float behind = 1.0 - step(uSlice, p.x);
  float cl = clamp(uClassify + behind * uSliceA, 0.0, 1.0) * (isSurf + (1.0 - isSurf) * detected);
  vec3 col = mix(rawC, cls, cl);
  float sg = exp(-pow((p.x - uSlice) * 5.0, 2.0)) * uSliceA;
  col += vec3(1.0, 0.96, 0.92) * sg * 1.0 * detected * (1.0 - isSurf * 0.7);
  col += uAccent * exp(-pow((p.x - uSlice) * 1.6, 2.0)) * uSliceA * detected * 0.25 * (isHor + isDep);

  float cz = smoothstep(0.0, 1.0, clamp(uCollapse * 1.25 - rnd * 0.25, 0.0, 1.0));
  p.z *= mix(1.0, 0.05, cz);
  col *= 1.0 + cz * (1.0 - cz) * 2.0;

  p.y -= layer * uExplode * ${EXPLODE_GAP.toFixed(2)};
  p.y += isSurf * uExplode * 0.8;

  float sw = exp(-pow((p.y - uSweepY) * 7.0, 2.0)) * uSweepA;
  col += vec3(0.9, 0.95, 1.0) * sw * (0.35 + isHor * 0.9 + isDep * 0.8);

  float delay = blob * 0.6 + rnd * 0.12;
  float intro = smoothstep(delay, delay + 0.3, uIntro);
  p.y -= (1.0 - intro) * 1.4 * (1.0 - isSurf);
  col += uAccent * isSurf * (1.0 - intro) * smoothstep(0.0, 0.3, uIntro) * 0.6;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float sz = uSize * (isSurf * 0.9 + isHor * 1.05 + isVol * 0.85 + isDep * 1.35) * (0.65 + rnd * 0.7);
  float dist = -mv.z;
  float coc = clamp(abs(dist - uFocus) * uAperture, 0.0, 3.0);
  sz *= 1.0 + coc * 2.2;
  float ps = sz * uPR * (9.0 / dist);
  float a = intro * uPtsA / (1.0 + coc * coc * 2.5);
  if (ps < 1.2) { a *= ps / 1.2; ps = 1.2; }
  gl_PointSize = ps;
  vColor = col;
  vAlpha = a;
  vSoft = coc;
}`;

const pointFS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
void main(){
  if (vAlpha < 0.003) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = clamp(vSoft * 0.5, 0.0, 1.0);
  float m = 1.0 - smoothstep(mix(0.26, 0.0, soft), 0.5, r);
  gl_FragColor = vec4(vColor, vAlpha * m);
}`;

function buildVolume() {
  const est = 420000;
  const pos = new Float32Array(est * 3), dat = new Float32Array(est * 4), ext = new Float32Array(est * 3);
  let n = 0;
  const push = (x, y, z, layer, type, dep, dens, blob) => {
    pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
    dat[n * 4] = layer; dat[n * 4 + 1] = type; dat[n * 4 + 2] = dep; dat[n * 4 + 3] = rand();
    ext[n * 3] = dens; ext[n * 3 + 1] = faultS(x, y, z); ext[n * 3 + 2] = blob;
    n++;
  };
  const densAt = (x, y, z) => clamp(0.18 + (-y / 9) * 0.55 + 0.32 * fbm(x * 0.18 + y * 0.25, z * 0.18 - y * 0.21, 2), 0, 1);

  const sN = Math.round(270 * Math.sqrt(Q)), st = (2 * HALF) / sN;
  for (let i = 0; i < sN; i++) for (let j = 0; j < sN; j++) {
    const x = -HALF + (i + 0.5 + (rand() - 0.5) * 0.5) * st;
    const z = -HALF + (j + 0.5 + (rand() - 0.5) * 0.5) * st;
    const b = blobF(x, z);
    if (b > 1) continue;
    push(x, surfH(x, z), z, 0, 0, -1, 0.1, b);
  }
  const hN = Math.round(160 * Math.sqrt(Q)), ht = (2 * HALF) / hN;
  for (let k = 0; k < 6; k++) for (let i = 0; i < hN; i++) for (let j = 0; j < hN; j++) {
    const x = -HALF + (i + 0.5 + (rand() - 0.5) * 0.6) * ht;
    const z = -HALF + (j + 0.5 + (rand() - 0.5) * 0.6) * ht;
    const b = blobF(x, z);
    if (b > 1) continue;
    const h = horizonsAt(x, z)[k];
    push(x, h, z, k + 1, 1, -1, densAt(x, h, z), b);
  }
  const vN = Math.round(70000 * Q);
  for (let i = 0; i < vN; i++) {
    const x = (rand() * 2 - 1) * HALF, z = (rand() * 2 - 1) * HALF;
    const b = blobF(x, z);
    if (b > 1) continue;
    const s = surfH(x, z);
    const y = BOTTOM + rand() * (s - 0.05 - BOTTOM);
    horizonsAt(x, z);
    let layer = 1;
    for (let k = 0; k < 6; k++) if (y < H[k]) layer = k + 2;
    push(x, y, z, layer, 2, -1, densAt(x, y, z), b);
  }
  DEPOSITS.forEach((d, id) => {
    const cnt = Math.round(3400 * Q);
    const top = layerTop(d.layer, d.x, d.z), bot = layerBot(d.layer, d.x, d.z);
    d.cy = (top + bot) / 2;
    d.th = (top - bot) / 2;
    d.depthM = Math.round(-d.cy * M_PER_UNIT);
    for (let i = 0; i < cnt; i++) {
      const x = clamp(d.x + gauss() * d.rx * 0.6, -HALF, HALF);
      const z = clamp(d.z + gauss() * d.rz * 0.6, -HALF, HALF);
      const b = blobF(x, z);
      if (b > 0.98) continue;
      const t = layerTop(d.layer, x, z), bt = layerBot(d.layer, x, z);
      const mid = (t + bt) / 2, th = (t - bt) / 2;
      const fall = Math.exp(-(((x - d.x) / d.rx) ** 2 + ((z - d.z) / d.rz) ** 2));
      const y = clamp(mid + gauss() * th * d.ry * (0.4 + fall), bt + 0.02, t - 0.02);
      push(x, y, z, d.layer, 3, id, 0.95, b);
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
  geo.setAttribute('aData', new THREE.BufferAttribute(dat.subarray(0, n * 4), 4));
  geo.setAttribute('aExtra', new THREE.BufferAttribute(ext.subarray(0, n * 3), 3));
  return { geo, count: n };
}

const LAYER_COLS = ['#e6e4dc', '#e2d3b8', '#c4b8a4', '#a3b2bb', '#88a0c0', '#7a8cc4', '#7479bd', '#6a63ad'].map((c) => new THREE.Color(c));
const pointUniforms = {
  uTime: { value: 0 }, uPR: { value: DPR }, uSize: { value: isMobile ? 2.2 : 2.0 }, uIntro: { value: 0 },
  uSource: { value: SOURCE },
  uPulse: { value: 0.85 }, uScanR: { value: 0 }, uSlice: { value: -11 }, uSliceA: { value: 0 },
  uClassify: { value: 0 }, uExplode: { value: 0 }, uSurface: { value: 1 }, uCollapse: { value: 0 }, uPtsA: { value: 1 },
  uFocus: { value: 15 }, uAperture: { value: 0.08 }, uHover: { value: -5 },
  uSweepY: { value: 0 }, uSweepA: { value: 0 },
  uMode: { value: new THREE.Vector4(1, 0, 0, 0) },
  uLayerCol: { value: LAYER_COLS },
  uDepCol: { value: DEPOSITS.map((d) => new THREE.Color(d.color)) },
  uAccent: { value: ACCENT },
};

/* =========================================================
   Regional ground: log-radial particle field around the site.
   Equal point density per zoom octave, so it reads at every scale.
   ========================================================= */
const PL = 60;            // planet geometry radius (local units)
const PR = 2000;          // planet radius in world units — survey territory is ~0.5 % of it
const PSCALE = PR / PL;
const PC = new V3(0, -PR, 0);
const REG_MIN = 7, REG_MAX = 1600;
const regionUniforms = { uAlpha: { value: 0 }, uPR: { value: DPR }, uFocal: { value: 1 }, uTime: { value: 0 } };
function buildRegion() {
  const N = Math.round(110000 * Q);
  const pos = [], aR = [], rnd = [];
  for (let i = 0; i < N; i++) {
    const r = REG_MIN * Math.pow(REG_MAX / REG_MIN, rand());
    const a = rand() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (blobF(x, z) < 1.02) continue;
    const relief = surfH(x, z) + 0.018 * r * fbm(x * 0.004 + 3, z * 0.004 - 7, 4) + 0.006 * r * fbm(x * 0.03, z * 0.03, 3);
    pos.push(x, relief - (r * r) / (2 * PR), z);
    aR.push(r); rnd.push(rand());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aR', new THREE.Float32BufferAttribute(aR, 1));
  geo.setAttribute('aRnd', new THREE.Float32BufferAttribute(rnd, 1));
  const p = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: regionUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aR; attribute float aRnd;
      uniform float uAlpha, uPR, uFocal, uTime;
      varying vec3 vC; varying float vA;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 0.01);
        float ws = aR * 0.0048 * (0.6 + aRnd * 0.8);
        float ps = ws * uFocal * uPR / dist;
        float halo = smoothstep(34.0, 9.0, aR);
        float b = 0.07 + halo * 0.16 + (aRnd > 0.985 ? 0.2 : 0.0);
        float rr = mod(uTime * 7.0, 160.0);
        float ring = exp(-pow((aR - rr) * 0.18, 2.0)) * smoothstep(160.0, 20.0, aR);
        vC = vec3(0.82, 0.85, 0.9) * b + vec3(1.0, 0.4, 0.15) * ring * 0.35;
        vA = uAlpha;
        if (ps < 1.0) { vA *= ps; ps = 1.0; }
        vA *= smoothstep(1.5, 6.0, dist);
        gl_PointSize = min(ps, 2.6 * uPR);
      }`,
    fragmentShader: `varying vec3 vC; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5 || vA < 0.003) discard; gl_FragColor = vec4(vC, vA * (1.0 - smoothstep(0.2, 0.5, r))); }`,
  }));
  p.frustumCulled = false;
  return p;
}

/* =========================================================
   Planet (particles + atmosphere + survey sites)
   ========================================================= */
const latLonDir = (lat, lon) => {
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lon);
  return new V3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
};
SITES.forEach((s) => (s.dir = latLonDir(s.lat, s.lon)));
const TARGET_SITE = SITES.find((s) => s.target);
const SITE_QUAT = new THREE.Quaternion().setFromUnitVectors(TARGET_SITE.dir, new V3(0, 1, 0));

function loadLandMask() {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = 1024, h = 512;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, w, h);
      try { resolve({ data: x.getImageData(0, 0, w, h).data, w, h }); } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/textures/planets/earth_specular_2048.jpg';
    setTimeout(() => resolve(null), 6000);
  });
}

const atmUniforms = { uAlpha: { value: 1 } };
const planetUniforms = { uTime: { value: 0 }, uPR: { value: DPR }, uAlpha: { value: 1 }, uCenter: { value: PC }, uScale: { value: PSCALE } };
function buildPlanet(mask) {
  const isLand = (lat, lon) => {
    if (!mask) {
      const d = latLonDir(lat, lon);
      return snoise(d.x * 1.6 + 3, d.y * 1.6) + snoise(d.y * 1.6, d.z * 1.6 + 7) * 0.7 > 0.25;
    }
    const u = ((Math.floor(((lon + 180) / 360) * mask.w) % mask.w) + mask.w) % mask.w;
    const v = clamp(Math.floor(((90 - lat) / 180) * mask.h), 0, mask.h - 1);
    return mask.data[(v * mask.w + u) * 4] < 110;
  };
  const N = Math.round(170000 * Q);
  const pos = [], info = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), ph = i * golden;
    const x = Math.cos(ph) * r, z = Math.sin(ph) * r;
    const lat = THREE.MathUtils.radToDeg(Math.asin(y)), lon = THREE.MathUtils.radToDeg(Math.atan2(-z, x));
    const land = isLand(lat, lon);
    if (!land && rand() > 0.22) continue;
    let coast = 0;
    if (land) {
      const e = 1.1;
      if (!isLand(lat + e, lon) || !isLand(lat - e, lon) || !isLand(lat, lon + e) || !isLand(lat, lon - e)) coast = 1;
    }
    const rr = PL * (land ? 1.0005 + rand() * 0.001 : 1);
    pos.push(x * rr, y * rr, z * rr);
    info.push(land ? 1 : 0, coast, rand());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: planetUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aInfo;
      uniform float uTime, uPR, uAlpha, uScale; uniform vec3 uCenter;
      varying vec3 vC; varying float vA;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize(wp.xyz - uCenter);
        vec3 vd = normalize(cameraPosition - wp.xyz);
        float facing = dot(n, vd);
        float front = smoothstep(-0.1, 0.3, facing);
        float land = aInfo.x, coast = aInfo.y, rnd = aInfo.z;
        float lat = position.y / ${PL.toFixed(1)};
        float band = exp(-pow((lat - sin(uTime * 0.35)) * 22.0, 2.0));
        vec3 col = mix(vec3(0.28, 0.36, 0.5), vec3(0.92, 0.92, 0.88), land);
        float b = land * (0.75 + coast * 0.7) + (1.0 - land) * 0.22;
        b *= mix(0.07, 1.0, front);
        vC = col * b + vec3(1.0, 0.38, 0.14) * band * front * land * 0.5 + vec3(0.8, 0.9, 1.0) * band * front * 0.08;
        vA = uAlpha;
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        float ps = (0.9 + rnd * 0.8 + coast * 0.6) * uPR * (190.0 * uScale / -mv.z);
        vA *= clamp(ps, 0.25, 1.0);
        gl_PointSize = clamp(ps, 1.0, 14.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA;
      void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5 || vA < 0.003) discard; gl_FragColor = vec4(vC, vA * (1.0 - smoothstep(0.2, 0.5, r))); }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

const planetLineMats = [];
const pLine = (color, opacity) => { const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }); m.userData.base = opacity; planetLineMats.push(m); return m; };
const arcUniforms = { uTime: { value: 0 }, uAlpha: { value: 1 }, uColor: { value: ACCENT } };

function buildPlanetGroup(mask) {
  const g = new THREE.Group();
  g.position.copy(PC);
  g.scale.setScalar(PSCALE);
  g.add(buildPlanet(mask));

  const atm = new THREE.Mesh(
    new THREE.SphereGeometry(PL * 1.045, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: atmUniforms, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vNv; void main(){ vNv = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uAlpha; varying vec3 vNv;
        void main(){ float a = -vNv.z; float k = smoothstep(0.0, 0.29, a) * (1.0 - smoothstep(0.29, 0.5, a));
          gl_FragColor = vec4(vec3(0.5, 0.65, 1.0) * k * k * k * 0.07 * uAlpha, 1.0); }`,
    })
  );
  atm.frustumCulled = false;
  g.add(atm);

  const grat = [];
  const R = PL * 1.001;
  for (let la = -60; la <= 60; la += 30) {
    for (let i = 0; i < 128; i++) {
      const a = latLonDir(la, (i / 128) * 360), b = latLonDir(la, ((i + 1) / 128) * 360);
      grat.push(a.multiplyScalar(R), b.multiplyScalar(R));
    }
  }
  for (let lo = 0; lo < 360; lo += 30) {
    for (let i = 0; i < 64; i++) {
      const a = latLonDir(-90 + (i / 64) * 180, lo), b = latLonDir(-90 + ((i + 1) / 64) * 180, lo);
      grat.push(a.multiplyScalar(R), b.multiplyScalar(R));
    }
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grat), pLine(0xecebe6, 0.05)));

  const pins = [], pinsAcc = [];
  SITES.forEach((s) => {
    const d = s.dir, up = d.clone();
    const t1 = new V3().crossVectors(up, Math.abs(up.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0)).normalize();
    const t2 = new V3().crossVectors(up, t1).normalize();
    const arr = s.target ? pinsAcc : pins;
    arr.push(d.clone().multiplyScalar(PL), d.clone().multiplyScalar(PL * (s.target ? 1.09 : 1.05)));
    const rings = s.target ? [1.2, 2.2, 3.4] : [0.8];
    rings.forEach((rr) => {
      for (let i = 0; i < 48; i++) {
        const a0 = (i / 48) * TAU, a1 = ((i + 1) / 48) * TAU;
        arr.push(
          up.clone().multiplyScalar(PL * 1.002).addScaledVector(t1, Math.cos(a0) * rr).addScaledVector(t2, Math.sin(a0) * rr),
          up.clone().multiplyScalar(PL * 1.002).addScaledVector(t1, Math.cos(a1) * rr).addScaledVector(t2, Math.sin(a1) * rr)
        );
      }
    });
  });
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pins), pLine(0xecebe6, 0.7)));
  const accLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pinsAcc), pLine(ACCENT, 1));
  g.add(accLines);

  const P = [], prog = [], off = [];
  SITES.filter((s) => !s.target).forEach((s, si) => {
    const a = TARGET_SITE.dir, b = s.dir;
    const ang = a.angleTo(b);
    const SUB = 80;
    let prev = null;
    for (let i = 0; i <= SUB; i++) {
      const t = i / SUB;
      const v = new V3().copy(a).multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(b, Math.sin(t * ang)).divideScalar(Math.sin(ang));
      v.multiplyScalar(PL * (1 + Math.sin(Math.PI * t) * 0.18 * ang));
      if (prev) { P.push(prev.x, prev.y, prev.z, v.x, v.y, v.z); prog.push((i - 1) / SUB, t); off.push(si * 0.17, si * 0.17); }
      prev = v;
    }
  });
  const ag = new THREE.BufferGeometry();
  ag.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  ag.setAttribute('aProg', new THREE.Float32BufferAttribute(prog, 1));
  ag.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 1));
  g.add(new THREE.LineSegments(ag, new THREE.ShaderMaterial({
    uniforms: arcUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aProg; attribute float aOff; varying float vP; varying float vO;
      void main(){ vP = aProg; vO = aOff; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime, uAlpha; uniform vec3 uColor; varying float vP; varying float vO;
      void main(){ float h = fract(uTime * 0.22 + vO); float g = exp(-abs(vP - h) * 26.0) * step(vP, h);
        gl_FragColor = vec4(uColor * (0.6 + g), (0.1 + g * 1.2) * uAlpha); }`,
  })));
  g.traverse((o) => (o.frustumCulled = false));
  return g;
}

/* =========================================================
   Line objects: probe, rays, geophones, territory outline, slice
   ========================================================= */
const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
const circlePts = (r, y, seg = 64) => { const a = []; for (let i = 0; i <= seg; i++) { const t = (i / seg) * TAU; a.push(new V3(Math.cos(t) * r, y, Math.sin(t) * r)); } return a; };

function buildProbe() {
  const g = new THREE.Group();
  const s0 = surfH(0, 0);
  const m = lineMat(0xecebe6, 0.7), ma = lineMat(ACCENT, 0.9), ms = lineMat(0xecebe6, 0.35);
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(0, s0 + 2.1, 0), new V3(0, s0 - 0.5, 0)]), m));
  const prof = [[2.0, 0.05], [1.92, 0.14], [1.84, 0.19], [1.74, 0.19], [1.64, 0.25], [1.56, 0.25], [1.46, 0.19], [1.3, 0.12], [1.1, 0.12], [0.9, 0.12], [0.7, 0.1], [0.5, 0.1], [0.3, 0.09], [0.1, 0.08], [-0.1, 0.07], [-0.25, 0.05], [-0.38, 0.03]];
  prof.forEach(([y, r], i) => g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(r, s0 + y, 48)), i === 5 || i === 4 ? ma : m)));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(Math.cos(a) * 0.19, s0 + 1.84, Math.sin(a) * 0.19), new V3(Math.cos(a) * 0.12, s0 + 1.3, Math.sin(a) * 0.12), new V3(Math.cos(a) * 0.07, s0 - 0.1, Math.sin(a) * 0.07)]), ms));
  }
  const ground = new THREE.Group();
  ground.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(0.75, s0 + 0.03, 96)), ma));
  const tick = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU, l = i % 6 === 0 ? 0.16 : 0.06;
    tick.push(new V3(Math.cos(a) * 1.1, s0 + 0.03, Math.sin(a) * 1.1), new V3(Math.cos(a) * (1.1 + l), s0 + 0.03, Math.sin(a) * (1.1 + l)));
  }
  ground.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tick), m));
  g.add(ground);
  g.userData = { ground, mats: [m, ma, ms] };
  return g;
}

function makeGlowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const GEOPHONES = [];
for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) {
  const x = -9 + i * 1.8, z = -9 + j * 1.8;
  if (blobF(x, z) > 0.93) continue;
  GEOPHONES.push(new V3(x, surfH(x, z) + 0.02, z));
}
function buildGeophones() {
  const pts = [];
  GEOPHONES.forEach((g) => {
    pts.push(g.clone(), g.clone().add(new V3(0, 0.28, 0)));
    pts.push(g.clone().add(new V3(-0.08, 0, 0)), g.clone().add(new V3(0.08, 0, 0)));
    pts.push(g.clone().add(new V3(0, 0, -0.08)), g.clone().add(new V3(0, 0, 0.08)));
  });
  return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0xecebe6, 0.5));
}

const rayUniforms = { uDraw: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: ACCENT } };
function buildRays() {
  const P = [], prog = [], delay = [];
  const SUB = 14;
  for (let r = 0; r < 70; r++) {
    const g = GEOPHONES[Math.floor(rand() * GEOPHONES.length)];
    const k = Math.floor(rand() * 6);
    const mx = (SOURCE.x + g.x) / 2, mz = (SOURCE.z + g.z) / 2;
    const R = new V3(mx, horizonsAt(mx, mz)[k], mz);
    const pts = [];
    for (let i = 0; i <= SUB; i++) pts.push(SOURCE.clone().lerp(R, i / SUB));
    for (let i = 1; i <= SUB; i++) pts.push(R.clone().lerp(g, i / SUB));
    const total = pts.length - 1;
    const dl = k * 0.07 + rand() * 0.08;
    for (let i = 0; i < total; i++) {
      P.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      prog.push(i / total, (i + 1) / total);
      delay.push(dl, dl);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('aProg', new THREE.Float32BufferAttribute(prog, 1));
  geo.setAttribute('aDelay', new THREE.Float32BufferAttribute(delay, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: rayUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aProg; attribute float aDelay; varying float vP; varying float vD;
      void main(){ vP = aProg; vD = aDelay; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uDraw, uAlpha; uniform vec3 uColor; varying float vP; varying float vD;
      void main(){
        float local = clamp((uDraw - vD) / 0.55, 0.0, 1.0);
        if (vP > local || uAlpha < 0.003) discard;
        float head = exp(-(local - vP) * 24.0) * (1.0 - step(0.999, local));
        float a = (0.1 + head * 1.4) * uAlpha;
        gl_FragColor = vec4(uColor * (0.7 + head * 1.5), a);
      }`,
  });
  return new THREE.LineSegments(geo, mat);
}

// organic outline of the survey territory (surface contour, floor contour, a few verticals)
function buildOutline() {
  const g = new THREE.Group();
  const N = 220, top = [], bot = [], vert = [];
  const edge = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    let r = 0.5;
    while (r < 11 && blobF(Math.cos(a) * r, Math.sin(a) * r) < 1) r += 0.04;
    edge.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  edge.forEach(([x, z], i) => {
    top.push(new V3(x, surfH(x, z) + 0.05, z));
    bot.push(new V3(x, BOTTOM, z));
    if (i % 22 === 0) vert.push(new V3(x, surfH(x, z), z), new V3(x, BOTTOM, z));
  });
  const mTop = lineMat(ACCENT, 0.9), mDim = lineMat(0xecebe6, 0.18);
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), mTop));
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bot), mDim));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vert), mDim));
  g.userData = { mTop, mDim };
  return g;
}

function buildSlice() {
  const g = new THREE.Group();
  const pts = [new V3(0, TOP, -HALF), new V3(0, TOP, HALF), new V3(0, BOTTOM, HALF), new V3(0, BOTTOM, -HALF), new V3(0, TOP, -HALF)];
  const m = lineMat(ACCENT, 0.9);
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m));
  const ticks = [];
  for (let z = -HALF; z <= HALF; z += 1) ticks.push(new V3(0, TOP, z), new V3(0, TOP + 0.2, z));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), m));
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * HALF, TOP - BOTTOM),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  plane.rotation.y = Math.PI / 2;
  plane.position.y = (TOP + BOTTOM) / 2;
  g.add(plane);
  g.userData.mats = [m, plane.material];
  return g;
}

/* =========================================================
   Solid section: survey slab (baked from the same geology) + deep column
   ========================================================= */
const SEC_TOP = 1.4, SEC_Z = 0.6;
const STRATA_RGB = [null, '#4a4038', '#a88b62', '#62686f', '#b3ab9a', '#7e6a58', '#88949c', '#6f5d60'].map((h) => h && new THREE.Color(h));
const layerAtSection = (x, y) => { const s = surfH(x, 0); horizonsAt(x, 0); if (y > s) return 0; let L = 1; for (let k = 0; k < 6; k++) if (y < H[k]) L = k + 2; return L; };

/* ---------- 3D relief wall: differential erosion of the cut face ---------- */
const WALL_BACK = 0.31;
const HARD = [0, -0.07, 0.12, -0.1, 0.16, -0.03, 0.11, 0.05]; // hard beds stand proud, soft beds recede
const deepB = (x) => [yAtKm(18) + 0.8 * snoise(x * 0.25, 3.3), yAtKm(35) + 1.3 * snoise(x * 0.18, 7.7), yAtKm(100) + 2.5 * snoise(x * 0.12, 11.1)];
function reliefAt(x, y, s, hs, db) {
  let z;
  if (y >= BOTTOM) {
    z = HARD[1];
    for (let k = 0; k < 6; k++) z += sstep(-0.05, 0.05, hs[k] - y) * (HARD[k + 2] - HARD[k + 1]);
    DEPOSITS.forEach((d) => {
      if (d.cy === undefined) return;
      const e = ((x - d.x) / (d.rx * 0.9)) ** 2 + ((y - d.cy) / (d.th * 0.9 + 0.1)) ** 2;
      z += 0.16 * Math.exp(-e * 1.6);
    });
    z -= 0.18 * Math.exp(-((faultS(x, y, 0) / 0.09) ** 2));
  } else {
    const [b1, b2, b3] = db;
    z = 0.1;
    z -= 0.07 * sstep(-0.3, 0.3, b1 - y);
    z -= 0.04 * sstep(-0.3, 0.3, b2 - y);
    z -= 0.12 * sstep(-0.6, 0.6, b3 - y);
    if (y > b1) z += 0.08 * sstep(-0.12, 0.12, snoise(x * 0.6, y * 0.45)); // jointed granite blocks
    else if (y > b3) z += 0.05 * fbm(x * 0.9 + 4, y * 0.7, 3);
    else z += 0.03 * Math.sin(x * 0.45 + y * 0.32);
  }
  z += 0.065 * fbm(x * 0.55, y * 0.9, 4) + 0.024 * fbm(x * 2.3 + 3, y * 4.2, 3);
  z += 0.006 * Math.sin(y * 38 + snoise(x * 0.4, y) * 2);
  return z;
}
const wallPin = (x, y, s) => Math.min(sstep(0, 0.25, HALF - Math.abs(x)), sstep(0, 0.14, s - y), sstep(0, 0.3, y - DEEP_BOT));
function wallZ(x, y) {
  const s = surfH(x, 0);
  horizonsAt(x, 0);
  const rel = reliefAt(x, y, s, H, deepB(x));
  return SEC_Z + lerp(WALL_BACK - SEC_Z, rel, wallPin(x, y, s));
}

const WALL_TEX_W = 1024;
function buildHorizonTexture() {
  const W = WALL_TEX_W, data = new Uint16Array(W * 3 * 4);
  const hf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < W; i++) {
    const x = -HALF + (i / (W - 1)) * 2 * HALF;
    const s = surfH(x, 0);
    horizonsAt(x, 0);
    const db = deepB(x);
    const rows = [[s, H[0], H[1], H[2]], [H[3], H[4], H[5], 0], [db[0], db[1], db[2], 0]];
    rows.forEach((r, row) => r.forEach((v, c) => (data[(row * W + i) * 4 + c] = hf(v))));
  }
  const tex = new THREE.DataTexture(data, W, 3, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const WALL_FRAG_HEAD = /* glsl */ `
varying vec3 vWP;
uniform float uSolid, uTime, uBump;
uniform sampler2D uHor;
uniform vec3 uStrata[8];
uniform vec3 uDepC[5];
uniform vec4 uDepG[5];
uniform vec3 uAccent;
float dfHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dfNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dfHash(i), dfHash(i + vec2(1.0, 0.0)), u.x), mix(dfHash(i + vec2(0.0, 1.0)), dfHash(i + vec2(1.0, 1.0)), u.x), u.y); }
float dfFbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * dfNoise(p); p *= 2.03; a *= 0.5; } return s; }
vec4 horRow(float x, float row){
  float u = ((x + ${HALF.toFixed(1)}) / ${(2 * HALF).toFixed(1)} * ${(WALL_TEX_W - 1).toFixed(1)} + 0.5) / ${WALL_TEX_W.toFixed(1)};
  return texture2D(uHor, vec2(u, (row + 0.5) / 3.0));
}
vec3 wallColor(vec2 p, inout vec3 emis, inout float hgt){
  float x = p.x, y = p.y;
  vec3 col;
  if (y >= ${BOTTOM.toFixed(2)}) {
    vec4 A = horRow(x, 0.0), B = horRow(x, 1.0);
    float top = A.r, L = 1.0;
    if (y < A.g) { L = 2.0; top = A.g; }
    if (y < A.b) { L = 3.0; top = A.b; }
    if (y < A.a) { L = 4.0; top = A.a; }
    if (y < B.r) { L = 5.0; top = B.r; }
    if (y < B.g) { L = 6.0; top = B.g; }
    if (y < B.b) { L = 7.0; top = B.b; }
    vec3 base = uStrata[int(L)];
    float dTop = top - y;
    float lam = sin((y + dfFbm(vec2(x * 0.35, y * 1.2)) * 0.25) * (34.0 + L * 7.0));
    float g = dfFbm(p * vec2(5.0, 11.0));
    float fine = dfFbm(p * vec2(42.0, 64.0) + L);
    float sp = dfHash(floor(p * 160.0));
    float px = length(fwidth(p));
    float fineK = 1.0 - smoothstep(0.004, 0.02, px);
    col = base * (0.9 + 0.05 * lam + 0.3 * (g - 0.5) + 0.16 * (fine - 0.5) * fineK);
    col *= 1.0 + (0.22 * step(0.988, sp) - 0.1 * step(sp, 0.02)) * fineK;
    col *= 0.75 + 0.25 * smoothstep(0.0, 0.25, dTop);
    float pick = (1.0 - smoothstep(0.0, 0.016, dTop)) * step(1.5, L);
    col = mix(col, vec3(0.75), pick * 0.45);
    emis += vec3(0.9, 0.92, 1.0) * pick * 0.04;
    for (int i = 0; i < 5; i++) {
      vec4 d = uDepG[i];
      vec2 e = (p - d.xy) / d.zw;
      float r = dot(e, e);
      float ed = 1.0 + 0.7 * (dfNoise(p * vec2(1.7, 3.5) + float(i) * 9.0) - 0.5);
      col = mix(col, uDepC[i] * 0.45, smoothstep(ed, ed * 0.3, r) * 0.35);
    }
    float fs = abs(x * ${FN.x.toFixed(2)} - ${FC.toFixed(2)} + y * ${FDIP.toFixed(2)});
    col *= mix(0.3, 1.0, smoothstep(0.03, 0.08, fs));
    emis += uAccent * (1.0 - smoothstep(0.0, 0.03, abs(fs - 0.085))) * 0.05;
    hgt = 0.6 * g + 0.35 * fine * fineK + 0.03 * lam;
  } else {
    vec4 Cb = horRow(x, 2.0);
    float b1 = Cb.r, b2 = Cb.g, b3 = Cb.b;
    float grain = dfHash(floor(p * 24.0));
    float fb = dfFbm(p * vec2(0.9, 1.6));
    float fine = dfFbm(p * vec2(30.0, 40.0));
    if (y > b1) {
      col = vec3(0.34, 0.25, 0.25) * (0.75 + 0.45 * fb);
      col += step(0.94, grain) * 0.14 - step(grain, 0.05) * 0.1;
    } else if (y > b2) {
      col = vec3(0.14, 0.18, 0.17) * (0.75 + 0.5 * fb) + 0.02 * sin(y * 13.0 + fb * 7.0);
      col += step(0.96, grain) * 0.07;
    } else if (y > b3) {
      col = vec3(0.13, 0.17, 0.08) * (0.7 + 0.6 * fb);
      col += vec3(0.06, 0.09, 0.02) * step(0.92, grain);
      float heat = smoothstep(${yAtKm(55).toFixed(2)}, b3, y);
      col = mix(col, col * vec3(1.4, 0.7, 0.45), heat * 0.8);
      emis += vec3(0.22, 0.035, 0.0) * heat * heat;
    } else {
      float f = dfFbm(vec2(x * 0.22, y * 0.2 + uTime * 0.12));
      float f2 = dfFbm(vec2(x * 0.45 - uTime * 0.05, y * 0.35 + uTime * 0.18));
      float gg = smoothstep(b3, ${DEEP_BOT.toFixed(1)}, y);
      col = vec3(0.06, 0.012, 0.006);
      emis += mix(vec3(0.1, 0.015, 0.005), vec3(0.8, 0.2, 0.03), f * f * 1.4) * (0.45 + gg * 1.0);
      float vein = 1.0 - smoothstep(0.0, 0.03, abs(f2 - 0.5));
      emis += vec3(1.3, 0.55, 0.18) * vein * (0.2 + gg * 0.8);
    }
    col *= 0.85 + 0.3 * (fine - 0.5);
    float bl = exp(-abs(y - b1) * 26.0) + exp(-abs(y - b2) * 26.0) + exp(-abs(y - b3) * 14.0) * 1.6;
    emis += mix(vec3(0.9, 0.9, 0.86), vec3(1.0, 0.5, 0.2), step(y, b2 - 5.0)) * bl * 0.06;
    hgt = 0.5 * fb + 0.4 * fine + 0.15 * grain;
  }
  float tk = min(fract(y * 0.5), 1.0 - fract(y * 0.5));
  emis += vec3(0.6) * (1.0 - smoothstep(0.0, 0.02, tk)) * step(${(HALF - 0.8).toFixed(2)}, abs(x)) * 0.08;
  vec2 gq = abs(fract(p) - 0.5);
  emis += vec3(0.5) * (1.0 - smoothstep(0.0, 0.01, 0.5 - max(gq.x, gq.y))) * 0.012;
  float sc = exp(-pow((y - (1.0 - mod(uTime * 1.4, 12.0))) * 9.0, 2.0));
  emis += vec3(0.85, 0.9, 1.0) * sc * 0.04 * step(${BOTTOM.toFixed(2)}, y);
  return col;
}`;

function buildWall() {
  const NX = isMobile ? 240 : 460, NY1 = isMobile ? 150 : 300, NY2 = isMobile ? 170 : 340;
  const W = NX + 1, Hh = NY1 + NY2 + 1;
  const pos = new Float32Array(W * Hh * 3);
  for (let i = 0; i < W; i++) {
    const x = -HALF + (i / NX) * 2 * HALF;
    const s = surfH(x, 0);
    horizonsAt(x, 0);
    const hs = H.slice();
    const db = deepB(x);
    for (let j = 0; j < Hh; j++) {
      const y = j <= NY1 ? lerp(s, BOTTOM, j / NY1) : lerp(BOTTOM, DEEP_BOT, (j - NY1) / NY2);
      const rel = reliefAt(x, y, s, hs, db);
      const o = (i * Hh + j) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = SEC_Z + lerp(WALL_BACK - SEC_Z, rel, wallPin(x, y, s));
    }
  }
  const idx = new Uint32Array(NX * (Hh - 1) * 6);
  let n = 0;
  for (let i = 0; i < NX; i++) for (let j = 0; j < Hh - 1; j++) {
    const a = i * Hh + j, b = (i + 1) * Hh + j;
    idx[n++] = a; idx[n++] = a + 1; idx[n++] = b;
    idx[n++] = b; idx[n++] = a + 1; idx[n++] = b + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMapIntensity: 0.12 });
  const horTex = buildHorizonTexture();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uSolid: solidUniforms.uSolid, uTime: solidUniforms.uTime, uAccent: { value: ACCENT },
      uHor: { value: horTex }, uBump: { value: 0.009 },
      uStrata: { value: STRATA_RGB.map((c) => (c ? c.clone().multiplyScalar(0.75) : new THREE.Color(0))) },
      uDepC: { value: DEPOSITS.map((d) => new THREE.Color(d.color)) },
      uDepG: { value: DEPOSITS.map((d) => new THREE.Vector4(d.x, d.cy, d.rx * 1.3, d.th * d.ry * 2 + 0.1)) },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${WALL_FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 dfEmis = vec3(0.0); float dfH = 0.0;
        diffuseColor.rgb = wallColor(vWP.xy, dfEmis, dfH);
        {
          bool surv = vWP.y >= ${BOTTOM.toFixed(2)};
          float topY = surv ? ${SEC_TOP.toFixed(2)} : ${BOTTOM.toFixed(2)};
          float span = surv ? ${(SEC_TOP - BOTTOM).toFixed(2)} : ${(BOTTOM - DEEP_BOT).toFixed(2)};
          float dn = dfFbm(vWP.xy * vec2(1.4, 1.8) + vWP.z * 3.0);
          float prog = uSolid * 1.75 - clamp((topY - vWP.y) / span, 0.0, 1.0) * 0.75;
          if (dn > prog) discard;
          float edge = smoothstep(prog - 0.022, prog, dn);
          dfEmis += uAccent * edge * 1.3 + vec3(1.0) * edge * edge * 0.25;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
          float det = dot(sx, R1);
          vec2 dh = vec2(dFdx(dfH), dFdy(dfH)) * uBump * 60.0;
          vec3 grad = sign(det) * (dh.x * R1 + dh.y * R2);
          normal = normalize(abs(det) * normal - grad);
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += dfEmis;');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

function bakeSection() {
  const W = isMobile ? 512 : 1024, Hh = isMobile ? 256 : 512;
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, Hh);
  const D = img.data;
  const depCols = DEPOSITS.map((d) => new THREE.Color(d.color));
  const hs = new Float32Array(6);
  for (let i = 0; i < W; i++) {
    const x = -HALF + ((i + 0.5) / W) * 2 * HALF;
    const s = surfH(x, 0);
    horizonsAt(x, 0); hs.set(H);
    for (let j = 0; j < Hh; j++) {
      const y = SEC_TOP - ((j + 0.5) / Hh) * (SEC_TOP - BOTTOM);
      const o = (j * W + i) * 4;
      if (y > s) { D[o + 3] = 0; continue; }
      let L = 1;
      for (let k = 0; k < 6; k++) if (y < hs[k]) L = k + 2;
      const base = STRATA_RGB[L];
      const top = L === 1 ? s : hs[L - 2];
      const dTop = top - y;
      const lam = Math.sin((y + snoise(x * 0.35, y * 1.2) * 0.25) * (34 + L * 7));
      let shade = 1 + 0.06 * lam + (rand() - 0.5) * 0.16 + 0.12 * snoise(x * 1.3 + L, y * 3.1);
      shade *= 0.82 + 0.18 * Math.min(1, dTop * 3);
      let r = base.r * shade, g = base.g * shade, b = base.b * shade;
      if (rand() < 0.012) { r *= 1.35; g *= 1.35; b *= 1.35; }
      // alteration halo around ore bodies (the bodies themselves are 3D)
      DEPOSITS.forEach((d, id) => {
        const ex = (x - d.x) / (d.rx * 1.3), ey = (y - d.cy) / (d.th * d.ry * 2 + 0.1);
        const rr = ex * ex + ey * ey;
        const edge = 1 + 0.35 * snoise(x * 1.7 + id * 9, y * 3.5);
        if (rr < edge) {
          const k = sstep(edge, edge * 0.3, rr) * 0.28;
          const dc = depCols[id];
          r = lerp(r, dc.r * 0.6, k); g = lerp(g, dc.g * 0.6, k); b = lerp(b, dc.b * 0.6, k);
        }
      });
      if (L > 1 && dTop < 0.022) { r = lerp(r, 0.92, 0.55); g = lerp(g, 0.92, 0.55); b = lerp(b, 0.9, 0.55); }
      if (s - y < 0.03) { r = lerp(r, 0.9, 0.4); g = lerp(g, 0.9, 0.4); b = lerp(b, 0.88, 0.4); }
      const fs = Math.abs(faultS(x, y, 0));
      if (fs < 0.035) { r *= 0.35; g *= 0.35; b *= 0.35; }
      else if (fs < 0.07) { r = lerp(r, 1.0, 0.25); g = lerp(g, 0.42, 0.25); b = lerp(b, 0.2, 0.25); }
      D[o] = clamp(r, 0, 1) * 255; D[o + 1] = clamp(g, 0, 1) * 255; D[o + 2] = clamp(b, 0, 1) * 255; D[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const solidUniforms = { uTime: { value: 0 }, uSolid: { value: 0 }, uAccent: { value: ACCENT }, uMap: { value: null } };
const solidVS = `varying vec3 vP; varying vec3 vN; void main(){ vP = position + (modelMatrix * vec4(0.0,0.0,0.0,1.0)).xyz; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const solidCommon = /* glsl */ `
uniform float uTime, uSolid; uniform vec3 uAccent;
varying vec3 vP; varying vec3 vN;
${GLSL_NOISE}
float face(){ return abs(vN.z) > 0.5 ? 1.0 : (abs(vN.x) > 0.5 ? 0.55 : 0.75); }
float dissolve(float topY, float span, inout vec3 col){
  float n = fbm2(vP.xy * vec2(1.4, 1.8) + vP.z * 3.0);
  float prog = uSolid * 1.75 - clamp((topY - vP.y) / span, 0.0, 1.0) * 0.75;
  if (n > prog) return -1.0;
  float edge = smoothstep(prog - 0.022, prog, n);
  col += uAccent * edge * 1.3 + vec3(1.0) * edge * edge * 0.25;
  return 1.0;
}
float techGrid(){
  vec2 g = abs(fract(vP.xy) - 0.5);
  float l = 1.0 - smoothstep(0.0, 0.012, 0.5 - max(g.x, g.y));
  return l * step(0.5, abs(vN.z));
}
vec3 microGrain(vec3 col){
  float m = fbm2(vP.xy * 26.0 + vP.z) ;
  float s = hash(floor(vP.xy * 90.0));
  return col * (0.82 + 0.34 * m) * (0.94 + 0.12 * s);
}`;

function buildSolid() {
  const g = new THREE.Group();
  solidUniforms.uMap.value = bakeSection();
  const survey = new THREE.Mesh(
    new THREE.BoxGeometry(2 * HALF, SEC_TOP - BOTTOM, SEC_Z + WALL_BACK - 0.01),
    new THREE.ShaderMaterial({
      uniforms: solidUniforms, vertexShader: solidVS,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        ${solidCommon}
        void main(){
          vec2 uv = vec2((vP.x + ${HALF.toFixed(1)}) / ${(2 * HALF).toFixed(1)}, (vP.y - (${BOTTOM.toFixed(2)})) / ${(SEC_TOP - BOTTOM).toFixed(2)});
          vec4 tx = texture2D(uMap, clamp(uv, 0.001, 0.999));
          if (tx.a < 0.5) discard;
          vec3 col = microGrain(tx.rgb) * face() * 0.9;
          col += vec3(0.9) * techGrid() * 0.03;
          float scan = exp(-pow((vP.y - (1.0 - mod(uTime * 1.4, 12.0))) * 9.0, 2.0));
          col += vec3(0.85, 0.9, 1.0) * scan * 0.1 * step(0.5, abs(vN.z));
          if (dissolve(${SEC_TOP.toFixed(2)}, ${(SEC_TOP - BOTTOM).toFixed(2)}, col) < 0.0) discard;
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  survey.position.set(0, (SEC_TOP + BOTTOM) / 2, (WALL_BACK - 0.01 - SEC_Z) / 2);
  g.add(survey);

  const deepH = BOTTOM - DEEP_BOT;
  const deep = new THREE.Mesh(
    new THREE.BoxGeometry(2 * HALF, deepH, SEC_Z + WALL_BACK - 0.01),
    new THREE.ShaderMaterial({
      uniforms: solidUniforms, vertexShader: solidVS,
      fragmentShader: /* glsl */ `
        ${solidCommon}
        void main(){
          float y = vP.y, x = vP.x;
          float b1 = ${yAtKm(18).toFixed(2)} + (vnoise(vec2(x * 0.25, 3.0)) - 0.5) * 1.6;
          float b2 = ${yAtKm(35).toFixed(2)} + (vnoise(vec2(x * 0.18, 7.0)) - 0.5) * 2.6;
          float b3 = ${yAtKm(100).toFixed(2)} + (vnoise(vec2(x * 0.12, 11.0)) - 0.5) * 5.0;
          vec2 q = vec2(x, y);
          float grain = hash(floor(q * 22.0));
          float fb = fbm2(q * vec2(0.9, 1.6));
          vec3 col;
          if (y > b1) {
            col = vec3(0.16, 0.115, 0.115) * (0.75 + 0.45 * fb);
            col += step(0.94, grain) * 0.07 - step(grain, 0.05) * 0.04;
          } else if (y > b2) {
            col = vec3(0.06, 0.085, 0.08) * (0.75 + 0.5 * fb) + 0.012 * sin(y * 13.0 + fb * 7.0);
            col += step(0.96, grain) * 0.035;
          } else if (y > b3) {
            col = vec3(0.055, 0.075, 0.035) * (0.7 + 0.6 * fb);
            col += vec3(0.03, 0.04, 0.01) * step(0.92, grain);
            float heat = smoothstep(${yAtKm(55).toFixed(2)}, b3, y);
            col = mix(col, col * vec3(1.6, 0.7, 0.45) + vec3(0.09, 0.012, 0.0), heat * 0.85);
          } else {
            float f = fbm2(vec2(x * 0.22, y * 0.2 + uTime * 0.12));
            float f2 = fbm2(vec2(x * 0.45 - uTime * 0.05, y * 0.35 + uTime * 0.18));
            float g = smoothstep(b3, ${DEEP_BOT.toFixed(1)}, y);
            col = mix(vec3(0.1, 0.015, 0.005), vec3(0.8, 0.2, 0.03), f * f * 1.4) * (0.45 + g * 1.0);
            float vein = 1.0 - smoothstep(0.0, 0.03, abs(f2 - 0.5));
            col += vec3(1.3, 0.55, 0.18) * vein * (0.2 + g * 0.8);
          }
          col = microGrain(col);
          float bl = exp(-abs(y - b1) * 26.0) + exp(-abs(y - b2) * 26.0) + exp(-abs(y - b3) * 14.0) * 1.6;
          col += mix(vec3(0.9, 0.9, 0.86), vec3(1.0, 0.5, 0.2), step(y, b2 - 5.0)) * bl * 0.18;
          float tk = min(fract(y * 0.5), 1.0 - fract(y * 0.5));
          col += (1.0 - smoothstep(0.0, 0.02, tk)) * step(${(HALF - 0.8).toFixed(2)}, abs(x)) * 0.14;
          col *= face();
          col += vec3(0.9) * techGrid() * 0.025;
          if (dissolve(${BOTTOM.toFixed(2)}, ${deepH.toFixed(2)}, col) < 0.0) discard;
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  deep.position.set(0, (BOTTOM + DEEP_BOT) / 2, (WALL_BACK - 0.01 - SEC_Z) / 2);
  g.add(deep);
  g.add(buildWall());

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture(), color: new THREE.Color('#ff4a12'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  glow.position.set(0, DEEP_BOT - 2, 0);
  glow.scale.set(70, 26, 1);
  g.add(glow);
  g.userData = { glow };
  return g;
}

const emberUniforms = { uTime: { value: 0 }, uAlpha: { value: 0 }, uPR: { value: DPR } };
function buildEmbers() {
  const N = Math.round(2200 * Q);
  const pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rand() * 2 - 1) * (HALF + 3); pos[i * 3 + 1] = rand(); pos[i * 3 + 2] = SEC_Z + 0.3 + rand() * 3.5;
    rnd[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
  const p = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: emberUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aRnd; uniform float uTime, uAlpha, uPR; varying float vA;
      void main(){
        float t = fract(position.y + uTime * (0.03 + aRnd * 0.05));
        vec3 p = vec3(position.x + sin(uTime * 0.6 + aRnd * 30.0) * 0.4, ${DEEP_BOT.toFixed(1)} + t * 24.0, position.z);
        vA = uAlpha * (1.0 - t) * smoothstep(0.0, 0.08, t);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.0, (1.0 + aRnd * 2.0) * uPR * (14.0 / -mv.z));
      }`,
    fragmentShader: `varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5 || vA < 0.003) discard; gl_FragColor = vec4(vec3(1.0, 0.45, 0.12) * 1.6, vA * (1.0 - r * 2.0)); }`,
  }));
  p.frustumCulled = false;
  return p;
}

/* =========================================================
   3D specimens embedded in the section: rocks, fossils, bones, ore bodies
   ========================================================= */
function lumpGeo(det, amt, sx = 1, sy = 1, sz = 1, seed = 0) {
  const g = new THREE.IcosahedronGeometry(1, det);
  const p = g.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = snoise(v.x * 1.7 + seed, v.y * 1.7 - v.z + seed * 0.3) * 0.6 + snoise(v.y * 3.3 + seed, v.z * 3.3 + v.x) * 0.4;
    v.multiplyScalar(1 + n * amt);
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}
function crystalGeo(r, h, sides = 6, tip = 2.0) {
  const body = new THREE.CylinderGeometry(r, r * 1.08, h, sides, 1).toNonIndexed();
  body.translate(0, h / 2, 0);
  const cone = new THREE.ConeGeometry(r, r * tip, sides).toNonIndexed();
  cone.translate(0, h + (r * tip) / 2, 0);
  const g = mergeGeometries([body, cone]);
  g.computeVertexNormals();
  return g;
}
function ammoniteGeo() {
  const turns = 3.3, steps = 260, seg = 14;
  const pos = [], idx = [];
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * turns * TAU;
    const R = 0.012 * Math.exp(0.19 * th);
    const rt = R * 0.5 * (1 + 0.14 * Math.max(0, Math.sin(th * 11)));
    const nx = Math.cos(th), ny = Math.sin(th);
    for (let j = 0; j <= seg; j++) {
      const ph = (j / seg) * TAU;
      pos.push(R * nx + rt * Math.cos(ph) * nx, R * ny + rt * Math.cos(ph) * ny, rt * Math.sin(ph) * 0.75);
    }
  }
  for (let i = 0; i < steps; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.scale(0.55, 0.55, 0.55);
  return g;
}
function boneGeo() {
  const parts = [new THREE.CylinderGeometry(0.032, 0.026, 0.56, 12, 4)];
  [[-0.032, 0.28, 0.05], [0.03, 0.29, 0.045], [-0.026, -0.28, 0.042], [0.028, -0.285, 0.048]].forEach(([x, y, r]) => {
    const s = new THREE.SphereGeometry(r, 12, 10); s.translate(x, y, 0); parts.push(s);
  });
  const g = mergeGeometries(parts);
  const p = g.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); v.x += Math.sin(v.y * 5) * 0.012; p.setXYZ(i, v.x, v.y, v.z); }
  g.computeVertexNormals();
  return g;
}
function shellGeo() {
  const g = new THREE.SphereGeometry(0.1, 32, 12, 0, TAU, 0, Math.PI / 2);
  const p = g.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.z, v.x);
    const rib = 1 + 0.06 * Math.abs(Math.sin(a * 9));
    p.setXYZ(i, v.x * rib, v.y * 0.45 * rib, v.z * rib * 0.9);
  }
  g.rotateX(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

const specimens = []; // { obj, y, base:Vector3 scale }
const oreGroups = [];
const focusRings = [];

function oreMaterials(kind, color) {
  const c = new THREE.Color(color);
  switch (kind) {
    case 'cu': return {
      a: new THREE.MeshStandardMaterial({ color: '#b8622e', metalness: 1, roughness: 0.34, envMapIntensity: 0.9, emissive: '#2a0e04', emissiveIntensity: 0.3 }),
      b: new THREE.MeshStandardMaterial({ color: '#2bb377', metalness: 0.1, roughness: 0.45, emissive: '#0b3a22', emissiveIntensity: 0.5 }),
    };
    case 'li': return {
      a: new THREE.MeshPhysicalMaterial({ color: '#bdf2f7', metalness: 0, roughness: 0.08, transmission: 0.75, thickness: 0.25, ior: 1.66, emissive: c, emissiveIntensity: 0.06, envMapIntensity: 1.0 }),
      b: new THREE.MeshStandardMaterial({ color: '#6d665c', roughness: 0.7, envMapIntensity: 0.4 }),
    };
    case 'ree': return {
      a: new THREE.MeshPhysicalMaterial({ color: '#a77bff', metalness: 0, roughness: 0.1, transmission: 0.6, thickness: 0.3, ior: 1.43, emissive: '#5b2bd6', emissiveIntensity: 0.25, envMapIntensity: 1.4 }),
      b: new THREE.MeshStandardMaterial({ color: '#8a5a3c', roughness: 0.55, metalness: 0.2 }),
    };
    case 'au': return {
      a: new THREE.MeshStandardMaterial({ color: '#f2bd3c', metalness: 1, roughness: 0.25, envMapIntensity: 1.0, emissive: '#3a2400', emissiveIntensity: 0.3 }),
      b: new THREE.MeshPhysicalMaterial({ color: '#f2efe9', roughness: 0.25, transmission: 0.35, thickness: 0.2, ior: 1.54 }),
    };
    default: return {
      a: new THREE.MeshStandardMaterial({ color: '#b39a5a', metalness: 1, roughness: 0.38, envMapIntensity: 1.3, emissive: '#1c2a10', emissiveIntensity: 0.4 }),
      b: new THREE.MeshStandardMaterial({ color: '#7ccf8c', metalness: 0.3, roughness: 0.4, emissive: '#123c1c', emissiveIntensity: 0.4 }),
    };
  }
}

function buildOreCluster(d, id) {
  const g = new THREE.Group();
  const M = oreMaterials(d.kind, d.color);
  const hostMat = new THREE.MeshStandardMaterial({ color: STRATA_RGB[d.layer].clone().multiplyScalar(0.28), roughness: 0.95, flatShading: true, envMapIntensity: 0.3 });
  const host = new THREE.Mesh(lumpGeo(2, 0.32, 0.62, 0.36, 0.32, id * 7.3), hostMat);
  g.add(host);
  const hemi = () => { const v = new V3(gauss() * 0.75, gauss() * 0.5, Math.abs(gauss()) * 0.7 + 0.45); return v.normalize(); };
  const place = (mesh, dir, dist) => {
    mesh.position.copy(dir).multiply(new V3(0.62, 0.36, 0.32)).multiplyScalar(dist);
    mesh.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
    mesh.rotateY(rand() * TAU);
    g.add(mesh);
  };
  if (d.kind === 'cu') {
    for (let i = 0; i < 16; i++) { const s = 0.05 + rand() * 0.1; const m = new THREE.Mesh(lumpGeo(1, 0.35, s, s * 0.8, s, i + 3), M.a); place(m, hemi(), 0.95); }
    for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(crystalGeo(0.012 + rand() * 0.01, 0.06 + rand() * 0.08, 6, 1.2), M.b); place(m, hemi(), 1.0); }
  } else if (d.kind === 'li') {
    for (let i = 0; i < 18; i++) { const m = new THREE.Mesh(crystalGeo(0.028 + rand() * 0.02, 0.18 + rand() * 0.38, 4, 1.4), M.a); place(m, hemi(), 0.85); }
    for (let i = 0; i < 6; i++) { const s = 0.06 + rand() * 0.05; const m = new THREE.Mesh(lumpGeo(1, 0.3, s, s, s, i), M.b); place(m, hemi(), 0.9); }
  } else if (d.kind === 'ree') {
    for (let i = 0; i < 14; i++) { const s = 0.05 + rand() * 0.07; const m = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), M.a); place(m, hemi(), 0.95); }
    for (let i = 0; i < 9; i++) { const s = 0.04 + rand() * 0.05; const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), M.a); place(m, hemi(), 1.0); }
    for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(crystalGeo(0.018, 0.08 + rand() * 0.06, 6, 0.4), M.b); place(m, hemi(), 0.95); }
  } else if (d.kind === 'au') {
    for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(crystalGeo(0.03 + rand() * 0.02, 0.12 + rand() * 0.2, 6, 1.6), M.b); place(m, hemi(), 0.85); }
    for (let i = 0; i < 16; i++) { const s = 0.025 + rand() * 0.05; const m = new THREE.Mesh(lumpGeo(1, 0.5, s, s * 0.6, s, i * 2), M.a); place(m, hemi(), 1.0); }
  } else {
    for (let i = 0; i < 18; i++) { const s = 0.05 + rand() * 0.08; const m = new THREE.Mesh(lumpGeo(0, 0.25, s, s, s, i + 11), M.a); place(m, hemi(), 0.95); }
    for (let i = 0; i < 6; i++) { const s = 0.03 + rand() * 0.03; const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), M.b); place(m, hemi(), 1.0); }
  }
  const lt = new THREE.PointLight(new THREE.Color(d.color), 0, 3.2, 2);
  lt.position.set(0, 0.2, 0.9);
  g.add(lt);
  g.userData = { light: lt, id };
  g.position.set(d.x, d.cy, wallZ(d.x, d.cy) - 0.14);
  g.scale.setScalar(1.15);

  // focus rings (visible while inspecting)
  const rg = new THREE.Group();
  const mm = lineMat(new THREE.Color(d.color), 0);
  const ring = (r, seg = 128) => { const a = []; for (let i = 0; i <= seg; i++) { const t = (i / seg) * TAU; a.push(new V3(Math.cos(t) * r, Math.sin(t) * r, 0)); } return a; };
  rg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring(0.95)), mm));
  const tk = [];
  for (let i = 0; i < 90; i++) { const t = (i / 90) * TAU, l = i % 15 === 0 ? 0.12 : 0.04; tk.push(new V3(Math.cos(t) * 1.05, Math.sin(t) * 1.05, 0), new V3(Math.cos(t) * (1.05 + l), Math.sin(t) * (1.05 + l), 0)); }
  rg.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tk), mm));
  rg.position.set(d.x, d.cy, wallZ(d.x, d.cy) + 0.3);
  rg.userData = { mat: mm };
  focusRings.push(rg);
  scene.add(rg);
  return g;
}

function buildSpecimens() {
  const g = new THREE.Group();
  // rocks — instanced, colour per layer
  const rockGeo = lumpGeo(1, 0.38, 1, 0.8, 0.9, 2.2);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02, flatShading: true, envMapIntensity: 0.35 });
  const rocksN = Math.round(520 * Q);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rocksN);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new V3(), ps = new V3(), col = new THREE.Color();
  const rockData = [];
  for (let i = 0; i < rocksN; i++) {
    const deep = i > rocksN * 0.45;
    const x = (rand() * 2 - 1) * (HALF - 0.3);
    let y, c;
    if (!deep) {
      y = BOTTOM + 0.15 + rand() * (surfH(x, 0) - 0.25 - BOTTOM);
      const L = layerAtSection(x, y);
      c = STRATA_RGB[Math.max(1, L)].clone().multiplyScalar(0.3 + rand() * 0.35);
    } else {
      y = BOTTOM - 0.3 - Math.pow(rand(), 0.8) * (BOTTOM - DEEP_BOT - 1.5);
      const km = depthKm(y);
      c = new THREE.Color(km < 18 ? '#7a6260' : km < 35 ? '#3e4a47' : km < 100 ? '#4b5d33' : '#2a1a14').multiplyScalar(0.35 + rand() * 0.4);
      if (km >= 35 && km < 100 && rand() < 0.3) c.set('#6f8f3a'); // olivine
    }
    const s = (deep ? 0.08 : 0.04) + Math.pow(rand(), 2.6) * (deep ? 0.45 : 0.24);
    ps.set(x, y, wallZ(x, y) - s * 0.25);
    q.setFromEuler(new THREE.Euler(rand() * TAU, rand() * TAU, rand() * TAU));
    sc.set(s * (0.8 + rand() * 0.6), s * (0.6 + rand() * 0.5), s);
    rockData.push({ p: ps.clone(), q: q.clone(), s: sc.clone(), y });
    m4.compose(ps, q, sc);
    rocks.setMatrixAt(i, m4);
    rocks.setColorAt(i, c);
  }
  rocks.userData.data = rockData;
  g.add(rocks);

  // fossils — a few ammonites and shells in the sedimentary layers, two bones near the top
  const fosMat = new THREE.MeshStandardMaterial({ color: '#8a7052', roughness: 0.6, metalness: 0.1, envMapIntensity: 0.5 });
  const pyrMat = new THREE.MeshStandardMaterial({ color: '#c9b37a', roughness: 0.3, metalness: 0.85, envMapIntensity: 1.2 });
  const boneMat = new THREE.MeshStandardMaterial({ color: '#e3d7bd', roughness: 0.7, metalness: 0 });
  const ammo = ammoniteGeo(), bone = boneGeo(), shell = shellGeo();
  const put = (geo, mat, x, y, rz, s = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, wallZ(x, y) - 0.03);
    m.rotation.set(0.2 * gauss(), 0.25 * gauss(), rz);
    m.scale.setScalar(s);
    g.add(m);
    specimens.push({ obj: m, y, s });
  };
  [[-7.6, 3], [2.6, 4], [7.4, 2], [-1.4, 5]].forEach(([x, L], i) => {
    const t = layerTop(L, x, 0), b = layerBot(L, x, 0);
    put(ammo, i % 2 ? pyrMat : fosMat, x, (t + b) / 2, rand() * TAU, 0.8 + rand() * 0.4);
  });
  [[-6.2, 2], [5.3, 3], [-2.6, 2], [8.3, 4], [0.4, 3]].forEach(([x, L]) => {
    const t = layerTop(L, x, 0), b = layerBot(L, x, 0);
    put(shell, fosMat, x, lerp(b, t, 0.3 + rand() * 0.4), rand() * TAU, 0.8 + rand() * 0.5);
  });
  [[-5.4, 1, 0.4], [6.4, 2, -0.9]].forEach(([x, L, rz]) => {
    const t = layerTop(L, x, 0), b = layerBot(L, x, 0);
    put(bone, boneMat, x, (t + b) / 2, rz, 1.2);
  });

  // ore bodies
  DEPOSITS.forEach((d, i) => {
    const c = buildOreCluster(d, i);
    oreGroups.push(c);
    g.add(c);
    specimens.push({ obj: c, y: d.cy, s: 1.15 });
  });

  // glowing xenoliths in the asthenosphere
  const xen = new THREE.InstancedMesh(lumpGeo(1, 0.4, 1, 0.8, 0.9, 5), new THREE.MeshStandardMaterial({ color: '#2a120a', emissive: '#ff5a1f', emissiveIntensity: 0.6, roughness: 0.8, flatShading: true }), Math.round(60 * Q));
  for (let i = 0; i < xen.count; i++) {
    const s = 0.15 + rand() * 0.35;
    ps.set((rand() * 2 - 1) * (HALF - 0.5), yAtKm(105) - rand() * (yAtKm(105) - DEEP_BOT - 1), SEC_Z - s * 0.2);
    ps.z = wallZ(ps.x, ps.y) - s * 0.25;
    q.setFromEuler(new THREE.Euler(rand() * TAU, rand() * TAU, rand() * TAU));
    m4.compose(ps, q, sc.set(s, s * 0.8, s));
    xen.setMatrixAt(i, m4);
  }
  g.add(xen);
  g.userData = { rocks };
  return g;
}

/* =========================================================
   Post-processing
   ========================================================= */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) },
    uCA: { value: 0.0018 }, uGrain: { value: 0.05 }, uVignette: { value: 0.6 }, uDistort: { value: 0.06 },
    uStreak: { value: 0.35 }, uScanlines: { value: 0.03 }, uFlash: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uCA, uGrain, uVignette, uDistort, uStreak, uScanlines, uFlash; uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 uv = 0.5 + c * (1.0 - uDistort * r2);
      vec2 dir = c * uCA * (0.6 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;
      vec3 st = vec3(0.0);
      for (int i = -7; i <= 7; i++) {
        float o = float(i) * 0.0065;
        vec3 s = texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb;
        st += max(s - 0.62, 0.0) * (1.0 - abs(float(i)) / 8.0);
      }
      col += st * uStreak * vec3(0.55, 0.7, 1.0) * 0.18;
      col += uFlash * vec3(1.0, 0.85, 0.75) * 0.08;
      col *= 1.0 - uScanlines * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.4));
      col *= 1.0 - uVignette * smoothstep(0.25, 0.95, length(c * vec2(1.15, 1.0)) * 1.25);
      float g = hash(vUv * uRes + fract(uTime * 7.13) * 91.0) - 0.5;
      col += g * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const composer = new EffectComposer(renderer);
composer.setPixelRatio(DPR);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const afterPass = new AfterimagePass(0);
composer.addPass(afterPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.55, 0.2);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
const finalPass = new ShaderPass(FinalShader);
composer.addPass(finalPass);

/* =========================================================
   State
   ========================================================= */
const S = {
  z: 0,
  th: 0.62, el: 0.32, r: 15.5, tx: 0, ty: -0.3, tz: 0,
  pulse: 0.85, scanR: 0, rays: 0, raysA: 0, geo: 0.8, slice: -10.5, sliceA: 0, classify: 0, explode: 0,
  box: 0, labels: 0, aperture: 0.085, surface: 1, trail: 0, intro: 0, bloom: 0.75, bloomTh: 0.2, sweep: 0, probe: 1, offX: 0,
  collapse: 0, solid: 0, ptsA: 1, deepUI: 0, oreUI: 0,
};
const MODE = { x: 1, y: 0, z: 0, w: 0 };
const PLANET_POSE = { r: 340 * PSCALE, el: 0.78, th: 0.25 };
const FOCUS = { k: 0, id: 0 };
const fdrag = { th: 0, el: 0, vth: 0 };

/* =========================================================
   Text helpers
   ========================================================= */
function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.innerHTML = words.map((w) => `<span class="w"><span class="wi">${w}</span></span>`).join(' ');
  return el.querySelectorAll('.wi');
}
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/#·—';
function scramble(el, text, dur = 0.6) {
  const o = { p: 0 };
  if (el._sc) gsap.killTweensOf(el._sc);
  el._sc = o;
  gsap.to(o, {
    p: 1, duration: dur, ease: 'none',
    onUpdate() {
      const n = Math.floor(o.p * text.length);
      let s = text.slice(0, n);
      for (let i = n; i < text.length; i++) s += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = s;
    },
    onComplete() { el.textContent = text; },
  });
}

/* =========================================================
   Seismogram
   ========================================================= */
const seis = document.getElementById('seis');
const sctx = seis.getContext('2d');
const T0 = [0.42, 0.8, 1.22, 1.68, 2.18, 2.72], TMAX = 3.3, NTR = 14;
function sizeSeis() {
  const r = seis.getBoundingClientRect();
  seis.width = Math.max(1, r.width * DPR); seis.height = Math.max(1, r.height * DPR);
}
function drawSeismo(p, t) {
  const w = seis.width, h = seis.height;
  sctx.clearRect(0, 0, w, h);
  sctx.lineWidth = 1;
  sctx.strokeStyle = 'rgba(236,235,230,0.05)';
  for (let k = 0.5; k < TMAX; k += 0.5) { const y = (k / TMAX) * h; sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(w, y); sctx.stroke(); }
  const tCur = p * TMAX, yCur = (tCur / TMAX) * h;
  const amp = (w / NTR) * 0.9;
  for (let tr = 0; tr < NTR; tr++) {
    const x0 = ((tr + 0.5) / NTR) * w;
    const off = (tr - (NTR - 1) / 2) * 0.42;
    sctx.beginPath();
    sctx.strokeStyle = 'rgba(236,235,230,0.72)';
    for (let py = 0; py <= yCur; py += 1.5 * DPR) {
      const tt = (py / h) * TMAX;
      let a = 0;
      for (let k = 0; k < 6; k++) {
        const ta = Math.sqrt(T0[k] * T0[k] + (off / 2.4) ** 2);
        const pf = (Math.PI * 7 * (tt - ta)) ** 2;
        a += (1 - 2 * pf) * Math.exp(-pf) * (1 - k * 0.09);
      }
      const direct = Math.abs(off) / 2.6;
      const pd = (Math.PI * 9 * (tt - direct)) ** 2;
      a += (1 - 2 * pd) * Math.exp(-pd) * 0.6;
      a += Math.sin(py * 0.9 + tr * 13.1 + t * 21) * Math.sin(py * 0.37 + tr * 3.7 + t * 7) * 0.07;
      const x = x0 + a * amp * 0.5;
      if (py === 0) sctx.moveTo(x, py); else sctx.lineTo(x, py);
    }
    sctx.stroke();
    sctx.fillStyle = '#ff5a1f';
    for (let k = 0; k < 6; k++) {
      const ta = Math.sqrt(T0[k] * T0[k] + (off / 2.4) ** 2);
      if (ta < tCur - 0.05) { const y = (ta / TMAX) * h; sctx.beginPath(); sctx.arc(x0, y, 1.6 * DPR, 0, TAU); sctx.fill(); }
    }
  }
  if (p > 0 && p < 1) {
    sctx.fillStyle = 'rgba(255,90,31,0.9)';
    sctx.fillRect(0, yCur, w, 1 * DPR);
    const gr = sctx.createLinearGradient(0, yCur - 34 * DPR, 0, yCur);
    gr.addColorStop(0, 'rgba(255,90,31,0)'); gr.addColorStop(1, 'rgba(255,90,31,0.1)');
    sctx.fillStyle = gr;
    sctx.fillRect(0, Math.max(0, yCur - 34 * DPR), w, Math.min(34 * DPR, yCur));
  }
}

/* =========================================================
   Init
   ========================================================= */
const loaderPct = document.getElementById('loaderPct');
const loaderArc = document.getElementById('loaderArc');
let points, probe, rays, geoph, outline, slice, tipGlow, planet, region, solid, embers, specGroup, total = 0;

function init(mask) {
  const vol = buildVolume();
  total = vol.count;
  points = new THREE.Points(vol.geo, new THREE.ShaderMaterial({
    uniforms: pointUniforms, vertexShader: pointVS, fragmentShader: pointFS,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  }));
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);

  planet = buildPlanetGroup(mask); scene.add(planet);
  region = buildRegion(); scene.add(region);
  probe = buildProbe(); scene.add(probe);
  rays = buildRays(); scene.add(rays);
  geoph = buildGeophones(); scene.add(geoph);
  outline = buildOutline(); scene.add(outline);
  slice = buildSlice(); scene.add(slice);
  solid = buildSolid(); scene.add(solid);
  embers = buildEmbers(); scene.add(embers);
  specGroup = buildSpecimens(); scene.add(specGroup);

  tipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture(), color: ACCENT, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  tipGlow.position.copy(SOURCE);
  tipGlow.scale.setScalar(0.7);
  scene.add(tipGlow);

  buildLabels();
  buildDepthScale();
  sizeSeis();
  // warm up shaders so the first appearance of the section doesn't hitch
  renderer.compile(scene, camera);
}

/* ---------- labels ---------- */
const labelsWrap = document.getElementById('labels');
const depLabels = [], siteLabels = [], depthLabels = [], oreLabels = [];
function makeLabel(cls, color, inner, tag = 'div') {
  const el = document.createElement('div');
  el.className = `label ${cls}`;
  if (color) el.style.color = color;
  el.innerHTML = `<i class="label__dot"></i><i class="label__line"></i><${tag} class="label__card">${inner}</${tag}>`;
  labelsWrap.appendChild(el);
  return el;
}
function buildLabels() {
  const list = document.getElementById('depList');
  DEPOSITS.forEach((d, i) => {
    depLabels.push(makeLabel('', d.color, `<span class="mono code">${d.code}</span><span class="name">${d.name}</span><span class="mono meta">${fmt(d.depthM)} m · ${d.conf}%</span>`));
    const li = document.createElement('li');
    li.innerHTML = `<i class="c" style="background:${d.color};box-shadow:0 0 10px ${d.color}"></i><span class="nm">${d.name}<small>${d.code} · ${d.conf}% · ${d.ton}</small></span><span class="mono meta">${fmt(d.depthM)} m</span>`;
    li.addEventListener('mouseenter', () => setHover(i));
    li.addEventListener('mouseleave', () => setHover(-1));
    list.appendChild(li);
    const ore = makeLabel('label--ore', d.color, `<span class="plus"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8"/></svg></span><span class="name">${d.name}</span><span class="mono meta">${d.code} · ${fmt(d.depthM)} m</span>`, 'button');
    ore.querySelector('button').addEventListener('click', () => openInspect(i));
    oreLabels.push(ore);
  });
  const sl = document.getElementById('siteList');
  SITES.forEach((s) => {
    siteLabels.push(makeLabel(`label--site${s.target ? ' is-target' : ''}`, null, `<span class="name">${s.name}</span><span class="mono meta">${s.cc} · ${s.status}</span>`));
    const li = document.createElement('li');
    if (s.target) li.className = 'is-target';
    li.innerHTML = `<i></i><span>${s.name} · ${s.cc}</span><em>${s.status}</em>`;
    sl.appendChild(li);
  });
  DEPTH_MARKS.forEach((m) => {
    m.y = yAtKm(m.km);
    depthLabels.push(makeLabel(`label--depth${m.hot ? ' is-hot' : ''}`, null, `<span class="mono code">${m.km} km</span><span class="name">${m.name}</span><span class="mono meta">${m.meta}</span>`));
  });
}
let hoverId = -1;
function setHover(i) {
  if (hoverId === i) return;
  hoverId = i;
  pointUniforms.uHover.value = i < 0 ? -5 : i;
  document.querySelectorAll('#depList li').forEach((li, k) => li.classList.toggle('is-hover', k === i));
  depLabels.forEach((el, k) => { el.classList.toggle('is-hover', k === i); el.classList.toggle('is-dim', i >= 0 && k !== i); });
  cursorTxt.textContent = i >= 0 ? `${DEPOSITS[i].code} · ${DEPOSITS[i].conf}%` : '';
}

const depthScale = document.getElementById('depthScale');
const gaugeFrac = (km) => (km <= 5 ? (km / 5) * 0.3 : 0.3 + ((km - 5) / 145) * 0.7);
function buildDepthScale() {
  [0, 1, 2, 3, 4, 5, 18, 35, 60, 100, 150].forEach((km) => {
    const t = document.createElement('i');
    if (![0, 5, 35, 100, 150].includes(km)) t.className = 'minor';
    t.style.top = `${gaugeFrac(km) * 100}%`;
    depthScale.appendChild(t);
  });
}

/* =========================================================
   Specimen inspector
   ========================================================= */
const inspectEl = document.getElementById('inspect');
const IN = (id) => document.getElementById(id);
let inspecting = false;
function openInspect(i) {
  if (S.oreUI < 0.5 && !inspecting) return;
  const d = DEPOSITS[i];
  FOCUS.id = i;
  inspecting = true;
  fdrag.th = 0; fdrag.el = 0; fdrag.vth = 0;
  lenis.stop();
  document.body.classList.add('is-focus');
  inspectEl.style.setProperty('--c', d.color);
  IN('inCode').textContent = d.code;
  IN('inName').textContent = d.name;
  IN('inMineral').textContent = d.mineral;
  IN('inConf').textContent = d.conf;
  IN('inDepth').textContent = `${fmt(d.depthM)} m`;
  IN('inGrade').textContent = d.grade;
  IN('inTon').textContent = d.ton;
  IN('inHost').textContent = d.host;
  IN('inThick').textContent = d.thick;
  IN('inMethod').textContent = d.method;
  IN('inValue').textContent = d.value;
  IN('inNote').textContent = d.note;
  IN('inConfArc').style.strokeDashoffset = 276.5;
  IN('inDepthBar').style.width = '0%';
  inspectEl.classList.remove('is-open');
  void inspectEl.offsetWidth;
  inspectEl.classList.add('is-open');
  inspectEl.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    IN('inConfArc').style.strokeDashoffset = 276.5 * (1 - d.conf / 100);
    IN('inDepthBar').style.width = `${(d.depthM / 4930) * 100}%`;
  });
  scramble(IN('inCode'), d.code, 0.5);
  gsap.to(FOCUS, { k: 1, duration: 1.8, ease: 'power3.inOut', overwrite: true });
  gsap.fromTo(finalPass.uniforms.uFlash, { value: 0.8 }, { value: 0, duration: 1.2, ease: 'power2.out' });
}
function closeInspect() {
  if (!inspecting) return;
  inspecting = false;
  inspectEl.classList.remove('is-open');
  inspectEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('is-focus');
  gsap.to(FOCUS, { k: 0, duration: 1.5, ease: 'power3.inOut', overwrite: true, onComplete: () => lenis.start() });
}
IN('inspectClose').addEventListener('click', closeInspect);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspect(); });

/* =========================================================
   Interaction
   ========================================================= */
const cursor = document.getElementById('cursor');
const cursorTxt = document.getElementById('cursorTxt');
const mouse = { x: 0, y: 0, sx: 0, sy: 0, px: innerWidth / 2, py: innerHeight / 2, cx: innerWidth / 2, cy: innerHeight / 2 };
const drag = { on: false, lx: 0, ly: 0, theta: 0, vel: 0, moved: 0 };
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hoverOre = -1;
addEventListener('pointermove', (e) => {
  mouse.px = e.clientX; mouse.py = e.clientY;
  mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = (e.clientY / innerHeight) * 2 - 1;
  if (drag.on) {
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
    drag.lx = e.clientX; drag.ly = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (inspecting) { fdrag.vth = -dx * 0.006; fdrag.th = clamp(fdrag.th - dx * 0.006, -1.15, 1.15); fdrag.el = clamp(fdrag.el + dy * 0.004, -0.5, 0.6); }
    else { drag.vel = dx * 0.004; drag.theta -= dx * 0.004; }
  }
  cursor.classList.toggle('is-link', !!e.target.closest('a,button') || hoverOre >= 0);
});
addEventListener('pointerdown', (e) => {
  if (e.target.closest('a,button,.interactive')) return;
  drag.moved = 0;
  if (S.labels < 0.5 && !inspecting && S.oreUI < 0.5) return;
  drag.on = true; drag.lx = e.clientX; drag.ly = e.clientY;
});
addEventListener('pointerup', (e) => {
  drag.on = false;
  if (drag.moved < 6 && hoverOre >= 0 && !e.target.closest('a,button,.interactive')) openInspect(hoverOre);
});

const segPill = document.querySelector('.seg__pill');
document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => {
    const m = +b.dataset.mode;
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('is-on', x === b));
    segPill.style.transform = `translateX(${m * 100}%)`;
    gsap.to(MODE, { x: m === 0 ? 1 : 0, y: m === 1 ? 1 : 0, z: m === 2 ? 1 : 0, w: m === 3 ? 1 : 0, duration: 1.1, ease: 'power3.inOut' });
    gsap.fromTo(finalPass.uniforms.uFlash, { value: 1 }, { value: 0, duration: 0.8, ease: 'power2.out' });
    sweepT = 0;
  });
});

/* =========================================================
   Scroll choreography
   ========================================================= */
const lenis = new Lenis({ lerp: 0.085, smoothWheel: true });
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((t) => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);
lenis.stop();

document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
  const id = a.getAttribute('href');
  if (id.length > 1) { e.preventDefault(); lenis.scrollTo(id, { duration: 2.4 }); }
}));

function setupScroll() {
  // master timeline — units are vh of scroll (0 → 1600)
  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: 1.1 },
  });
  // 01 orbit → dive through continent → region → the survey territory
  tl.to(S, { z: 1, duration: 200, ease: 'power1.inOut' }, 0);
  tl.to(S, { intro: 1, duration: 70 }, 105);
  // 02 descend to cross-section and scan
  tl.to(S, { th: 0.0, el: 0.07, r: 18.5, ty: -3.9, aperture: 0.018, surface: 0.45, box: 1, ease: 'power2.inOut', duration: 70 }, 200);
  tl.to(S, { scanR: 1.8, duration: 30 }, 240);
  tl.to(S, { scanR: 7.5, duration: 120 }, 270);
  tl.to(S, { rays: 1, duration: 200 }, 270);
  tl.to(S, { raysA: 1, duration: 20 }, 270);
  tl.to(S, { trail: 0.6, bloom: 0.8, duration: 40 }, 260);
  tl.to(S, { scanR: 16.5, duration: 100 }, 390);
  tl.to(S, { th: 0.2, el: 0.1, r: 17.5, duration: 100, ease: 'sine.inOut' }, 390);
  tl.to(S, { th: 0.9, el: 0.22, r: 24, ty: -4, duration: 110, ease: 'power1.inOut' }, 490);
  tl.to(S, { raysA: 0, pulse: 0.18, trail: 0.3, geo: 0.3, duration: 30 }, 490);
  tl.to(S, { sliceA: 1, duration: 8 }, 498);
  tl.fromTo(S, { slice: -10.5 }, { slice: 10.5, duration: 90, immediateRender: false }, 500);
  tl.to(S, { sliceA: 0, duration: 10 }, 590);
  tl.to(S, { classify: 1, duration: 12 }, 586);
  // 03 model
  tl.to(S, { explode: 1, th: 1.5, el: 0.14, r: 50, ty: -9.6, offX: isMobile ? 0 : 0.2, box: 0, geo: 0, probe: 0.5, aperture: 0.03, trail: 0, bloom: 0.75, duration: 110, ease: 'power2.inOut' }, 600);
  tl.to(S, { labels: 1, sweep: 1, duration: 30 }, 690);
  tl.to(S, { th: 2.7, r: 46, el: 0.24, duration: 230 }, 720);
  // 04 collapse into a vertical section → solid with 3D specimens → inspect → descend
  tl.to(S, { labels: 0, sweep: 0, duration: 20 }, 945);
  tl.to(S, { explode: 0, collapse: 1, th: TAU, el: 0.04, r: 34, ty: -4.2, offX: 0, probe: 1, aperture: 0.006, pulse: 0, duration: 100, ease: 'power2.inOut' }, 950);
  tl.to(S, { solid: 1, duration: 90, ease: 'power1.in' }, 1035);
  tl.to(S, { ptsA: 0, duration: 40 }, 1090);
  tl.to(S, { bloomTh: 0.82, bloom: 0.9, duration: 30 }, 1040);
  tl.to(S, { r: 21, th: TAU + 0.32, el: 0.1, ty: -4.3, duration: 50, ease: 'power2.inOut' }, 1105);
  tl.to(S, { oreUI: 1, duration: 20 }, 1140);
  tl.to(S, { th: TAU + 0.12, duration: 110, ease: 'sine.inOut' }, 1155);
  tl.to(S, { oreUI: 0, duration: 20 }, 1260);
  tl.to(S, { deepUI: 1, duration: 30 }, 1265);
  tl.to(S, { ty: -64, r: 30, th: TAU + 0.22, el: -0.015, duration: 230, ease: 'power1.inOut' }, 1270);
  // 05 pull back: the whole section as a monolith
  tl.to(S, { r: 138, ty: -34.5, th: TAU + 0.55, el: 0.1, offX: isMobile ? 0 : -0.17, deepUI: 0, duration: 100, ease: 'power2.inOut' }, 1500);
  tl.set({}, {}, 1600);

  gsap.to('.hero__content', { opacity: 0, y: -50, ease: 'none', scrollTrigger: { trigger: '#hero', start: 'top top', end: '25% top', scrub: true } });

  const steps = [...document.querySelectorAll('.step')];
  const bounds = [0, 0.475, 0.725, 1];
  ScrollTrigger.create({
    trigger: '#scan', start: 'top top', end: 'bottom bottom',
    onUpdate(self) {
      const p = self.progress;
      steps.forEach((s, i) => {
        const b0 = i === 0 ? 0.175 : bounds[i];
        const lp = clamp((p - b0) / (bounds[i + 1] - b0), 0, 1);
        s.classList.toggle('is-active', p >= bounds[i] && (p < bounds[i + 1] || i === 2));
        s.querySelector('.bar').style.strokeDashoffset = 75.4 * (1 - lp);
      });
    },
  });

  document.querySelectorAll('section h2[data-split]').forEach((h) => {
    const w = splitWords(h);
    gsap.from(w, { yPercent: 110, duration: 1.1, stagger: 0.05, ease: 'power4.out', scrollTrigger: { trigger: h.closest('section'), start: 'top 60%', toggleActions: 'play none none reverse' } });
  });
  ['#scan', '#model', '#depth', '#cta'].forEach((sel) => ScrollTrigger.create({ trigger: sel, start: 'top 55%', end: 'bottom 45%', toggleClass: { targets: sel, className: 'in-view' } }));

  document.querySelectorAll('.stats b').forEach((b) => {
    const to = +b.dataset.count, dec = +b.dataset.dec, o = { v: 0 };
    gsap.to(o, {
      v: to, duration: 1.8, ease: 'power3.out',
      onUpdate: () => { b.textContent = dec ? o.v.toFixed(dec) : fmt(o.v); },
      scrollTrigger: { trigger: '#model', start: 'top 30%', toggleActions: 'play none none reverse' },
    });
  });

  const secIdx = document.getElementById('secIdx'), secName = document.getElementById('secName');
  const navLinks = [...document.querySelectorAll('.nav__pill a[href^="#"]')];
  [['#hero', '01', 'Planet'], ['#scan', '02', 'Acquisition'], ['#model', '03', 'Model'], ['#depth', '04', 'Section'], ['#cta', '05', 'Survey']].forEach(([sel, i, n], k) => {
    ScrollTrigger.create({
      trigger: sel, start: 'top 50%', end: 'bottom 50%',
      onToggle: (self) => {
        if (!self.isActive) return;
        scramble(secIdx, i, 0.4); scramble(secName, n, 0.6);
        navLinks.forEach((a, j) => a.classList.toggle('is-on', j === Math.min(k, 3)));
      },
    });
  });
  ScrollTrigger.create({ trigger: '#scan', start: 'top bottom', end: 'bottom top', onToggle: (s) => (seisActive = s.isActive) });
}
let seisActive = false;

/* =========================================================
   Loop
   ========================================================= */
const target = new V3(), tmp = new V3(), tmp2 = new V3(), siteTarget = new V3();
const fTarget = new V3(), fPos = new V3(), camPos = new V3();
const camRead = document.getElementById('camRead');
const depthMarker = document.getElementById('depthMarker');
const depthVal = document.getElementById('depthVal');
const progArc = document.getElementById('progArc');
const coreKm = document.getElementById('coreKm');
const oreHint = document.getElementById('oreHint');
const coreItems = [...document.querySelectorAll('#coreList li')];
const roDepth = document.getElementById('roDepth'), roRefl = document.getElementById('roRefl'), roSnr = document.getElementById('roSnr'), roPts = document.getElementById('roPts');
let last = performance.now(), autoRot = 0, sweepT = 0, frameN = 0, smoothVel = 0, spin = 0, lastSolid = -1;
const qSpin = new THREE.Quaternion(), UP = new V3(0, 1, 0);
const ease = (t) => t * t * (3 - 2 * t);
const m4 = new THREE.Matrix4(), sc4 = new V3();

function placeLabel(el, world, alpha) {
  tmp.copy(world).project(camera);
  const x = (tmp.x * 0.5 + 0.5) * innerWidth, y = (-tmp.y * 0.5 + 0.5) * innerHeight;
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  el.style.opacity = tmp.z < 1 && alpha > 0.01 ? alpha : 0;
  return { x, y };
}

function updateSpecimens() {
  if (Math.abs(S.solid - lastSolid) < 0.0005) return;
  lastSolid = S.solid;
  const appear = (y) => sstep(0.45 + clamp((SEC_TOP - y) / (SEC_TOP - DEEP_BOT), 0, 1) * 0.45, 0.6 + clamp((SEC_TOP - y) / (SEC_TOP - DEEP_BOT), 0, 1) * 0.4, S.solid);
  specimens.forEach((s) => { const k = appear(s.y); s.obj.visible = k > 0.001; s.obj.scale.setScalar(s.s * (k < 1 ? 0.4 + 0.6 * k : 1)); });
  const rocks = specGroup.userData.rocks;
  rocks.userData.data.forEach((r, i) => {
    const k = appear(r.y);
    sc4.copy(r.s).multiplyScalar(Math.max(0.0001, k));
    m4.compose(r.p, r.q, sc4);
    rocks.setMatrixAt(i, m4);
  });
  rocks.instanceMatrix.needsUpdate = true;
}

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t = now / 1000;
  frameN++;

  mouse.sx += (mouse.x - mouse.sx) * 0.04;
  mouse.sy += (mouse.y - mouse.sy) * 0.04;
  if (!drag.on) { drag.theta -= drag.vel; drag.vel *= 0.94; fdrag.th = clamp(fdrag.th + fdrag.vth, -1.15, 1.15); fdrag.vth *= 0.93; }
  autoRot += dt * 0.05 * S.labels;
  const settle = 1 - S.collapse;
  mouse.cx += (mouse.px - mouse.cx) * 0.25; mouse.cy += (mouse.py - mouse.cy) * 0.25;
  cursor.style.transform = `translate(${mouse.cx}px, ${mouse.cy}px)`;

  // ---- camera rig: orbit around the planet, then the local survey rig
  const ez = ease(S.z);
  const lr = S.r;
  const r = Math.exp(lerp(Math.log(PLANET_POSE.r), Math.log(lr), S.z));
  const k = clamp((PLANET_POSE.r - r) / (PLANET_POSE.r - lr), 0, 1);
  siteTarget.set(S.tx, S.ty, S.tz);
  target.copy(PC).lerp(siteTarget, Math.pow(k, 0.6));
  const th = lerp(PLANET_POSE.th, S.th, ez) + (drag.theta + autoRot) * settle + mouse.sx * 0.08 * (1 - FOCUS.k);
  const el = lerp(PLANET_POSE.el, S.el, ez) - mouse.sy * 0.035 * (1 - FOCUS.k);
  camPos.set(
    target.x + r * Math.cos(el) * Math.sin(th),
    target.y + r * Math.sin(el),
    target.z + r * Math.cos(el) * Math.cos(th)
  );
  // ---- specimen focus blend
  const fk = FOCUS.k;
  if (fk > 0.0001) {
    const d = DEPOSITS[FOCUS.id];
    fTarget.set(d.x, d.cy, SEC_Z + 0.1);
    const fth = 0.38 + Math.sin(t * 0.22) * 0.12 + fdrag.th + mouse.sx * 0.06;
    const fel = 0.12 + fdrag.el - mouse.sy * 0.04;
    const fr = 4.8;
    fPos.set(fTarget.x + fr * Math.cos(fel) * Math.sin(fth), fTarget.y + fr * Math.sin(fel), fTarget.z + fr * Math.cos(fel) * Math.cos(fth));
    camPos.lerp(fPos, fk);
    camPos.z += Math.sin(Math.PI * fk) * 3.0;
    target.lerp(fTarget, fk);
  }
  camera.position.copy(camPos);
  camera.lookAt(target);
  const camDist = camera.position.distanceTo(target);
  camera.near = clamp(camDist * 0.004, 0.02, 60);
  camera.far = camDist + PR * 2.6;
  const offX = lerp(S.offX - (isMobile ? 0 : 0.1) * (1 - ez), isMobile ? 0 : 0.17, fk);
  camera.setViewOffset(innerWidth, innerHeight, offX * innerWidth, (isMobile ? -0.18 : 0) * fk * innerHeight, innerWidth, innerHeight);

  // ---- planet & region
  spin += dt * 0.07 * (1 - ez);
  qSpin.setFromAxisAngle(UP, spin);
  planet.quaternion.copy(qSpin).multiply(SITE_QUAT);
  const camToSite = camera.position.length();
  const pA = sstep(600, 2600, camToSite);
  planet.visible = pA > 0.002;
  planetUniforms.uAlpha.value = pA;
  planetUniforms.uTime.value = t;
  atmUniforms.uAlpha.value = sstep(3500, 7000, camToSite);
  arcUniforms.uTime.value = t;
  arcUniforms.uAlpha.value = pA * (1 - ez * 0.7);
  planetLineMats.forEach((m) => (m.opacity = m.userData.base * pA));
  const rA = sstep(5200, 1800, camToSite) * (1 - S.collapse) * (1 - 0.75 * S.explode) * (1 - 0.55 * S.box);
  region.visible = rA > 0.002;
  regionUniforms.uAlpha.value = rA;
  regionUniforms.uTime.value = t;
  regionUniforms.uFocal.value = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  // ---- survey volume uniforms
  const U = pointUniforms;
  U.uTime.value = t;
  U.uIntro.value = S.intro;
  U.uPulse.value = S.pulse;
  U.uScanR.value = S.scanR;
  U.uSlice.value = S.slice;
  U.uSliceA.value = S.sliceA;
  U.uClassify.value = S.classify;
  U.uExplode.value = S.explode;
  U.uSurface.value = S.surface;
  U.uCollapse.value = S.collapse;
  U.uPtsA.value = S.ptsA;
  U.uAperture.value = S.aperture * S.z;
  U.uFocus.value = camDist;
  U.uMode.value.set(MODE.x, MODE.y, MODE.z, MODE.w);
  sweepT += dt;
  U.uSweepY.value = 1.5 - ((sweepT * 1.6) % 22);
  U.uSweepA.value = S.sweep * 0.9;
  points.visible = S.intro > 0.001 && S.ptsA > 0.001;

  rayUniforms.uDraw.value = S.rays;
  rayUniforms.uAlpha.value = S.raysA;
  rays.visible = S.raysA > 0.002;
  geoph.material.opacity = 0.5 * S.geo * S.intro;
  geoph.position.y = S.explode * 0.8;
  const oTop = S.intro * (1 - S.collapse) * (1 - S.explode);
  outline.userData.mTop.opacity = 0.85 * oTop;
  outline.userData.mDim.opacity = 0.22 * S.box;
  outline.visible = oTop > 0.002 || S.box > 0.002;
  slice.position.x = S.slice;
  slice.visible = S.sliceA > 0.01;
  slice.userData.mats[0].opacity = 0.9 * S.sliceA;
  slice.userData.mats[1].opacity = 0.035 * S.sliceA;
  probe.position.y = S.explode * 0.8;
  probe.userData.ground.rotation.y = t * 0.15;
  probe.userData.mats[0].opacity = 0.7 * S.probe * S.intro;
  probe.userData.mats[1].opacity = 0.9 * S.probe * S.intro;
  probe.userData.mats[2].opacity = 0.35 * S.probe * S.intro;
  tipGlow.position.set(SOURCE.x, SOURCE.y + S.explode * 0.8, SOURCE.z);
  const beat = Math.pow(Math.max(0, Math.sin(t * 2.3 * Math.PI / 4.7 * 2.0)), 16.0);
  tipGlow.material.opacity = (0.5 + beat * 0.8) * S.intro * (S.pulse > 0.3 ? 1 : 0.45) * (1 - S.solid);
  tipGlow.scale.setScalar(0.6 + beat * 0.6);

  // ---- solid section + specimens
  solid.visible = S.solid > 0.001;
  specGroup.visible = S.solid > 0.001;
  solidUniforms.uSolid.value = S.solid;
  solidUniforms.uTime.value = t;
  updateSpecimens();
  const deepK = sstep(-25, -55, S.ty);
  solid.userData.glow.material.opacity = 0.45 * S.solid * Math.max(deepK, sstep(60, 110, S.r));
  embers.visible = S.solid > 0.5;
  emberUniforms.uTime.value = t;
  emberUniforms.uAlpha.value = S.solid * deepK;
  keyLight.position.copy(target).add(tmp.set(-8, 10, 9));
  keyLight.target.position.copy(target);
  oreGroups.forEach((g, i) => {
    const on = fk * (FOCUS.id === i ? 1 : 0);
    g.userData.light.intensity = (0.35 + 0.25 * Math.sin(t * 2 + i)) * S.solid + on * 0.9;
    g.rotation.y = Math.sin(t * 0.5 + i) * 0.06 + on * Math.sin(t * 0.4) * 0.25;
    g.rotation.x = on * Math.sin(t * 0.3) * 0.08;
    const rg = focusRings[i];
    rg.visible = on > 0.01 || (hoverOre === i && S.oreUI > 0.5);
    rg.userData.mat.opacity = Math.max(on * 0.9, hoverOre === i ? 0.6 * S.oreUI : 0);
    rg.rotation.z = t * 0.25;
    rg.scale.setScalar(1 + (1 - Math.max(on, 0.0001)) * 0.15);
  });

  // ---- post
  const v = Math.abs(lenis.velocity || 0);
  smoothVel += (Math.min(v / 40, 1) - smoothVel) * 0.08;
  afterPass.uniforms.damp.value = S.trail;
  bloomPass.strength = S.bloom + smoothVel * 0.25 - fk * 0.3;
  bloomPass.threshold = S.bloomTh;
  if (bloomPass.highPassUniforms) bloomPass.highPassUniforms.luminosityThreshold.value = S.bloomTh;
  finalPass.uniforms.uTime.value = t;
  finalPass.uniforms.uCA.value = 0.0016 + smoothVel * 0.009 + S.sliceA * 0.0015 + (1 - ez) * 0.001 + fk * 0.0012;
  finalPass.uniforms.uDistort.value = 0.05 + smoothVel * 0.12;
  finalPass.uniforms.uVignette.value = 0.6 + fk * 0.25;

  composer.render();

  // ---- labels: planet sites
  const siteA = pA * (1 - sstep(0.1, 0.35, S.z));
  SITES.forEach((s, i) => {
    tmp2.copy(s.dir).multiplyScalar(PR * (s.target ? 1.09 : 1.05)).applyQuaternion(planet.quaternion).add(PC);
    const n = tmp.copy(tmp2).sub(PC).normalize();
    const facing = n.dot(tmp.clone().copy(camera.position).sub(tmp2).normalize());
    placeLabel(siteLabels[i], tmp2, siteA * sstep(0.08, 0.3, facing));
  });

  // ---- labels: deposits (model)
  if (S.labels > 0.01) {
    let best = -1, bestD = 70;
    DEPOSITS.forEach((d, i) => {
      tmp2.set(d.x, d.cy - d.layer * S.explode * EXPLODE_GAP, d.z);
      const { x, y } = placeLabel(depLabels[i], tmp2, S.labels);
      const dd = Math.hypot(x - mouse.px, y - mouse.py);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (!document.querySelector('#depList li:hover')) setHover(best);
  } else if (depLabels.length && depLabels[0].style.opacity !== '0') {
    depLabels.forEach((el) => (el.style.opacity = 0));
    setHover(-1);
  }

  // ---- labels: ore callouts in the section + 3D hover
  const oA = S.oreUI * (1 - fk);
  DEPOSITS.forEach((d, i) => {
    tmp2.set(d.x + 0.35, d.cy + 0.45, SEC_Z + 0.2);
    placeLabel(oreLabels[i], tmp2, oA);
    oreLabels[i].classList.toggle('is-live', oA > 0.5);
  });
  oreHint.style.opacity = oA;
  if (oA > 0.5 && frameN % 3 === 0) {
    ndc.set(mouse.x, -mouse.y);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(oreGroups, true)[0];
    let id = -1;
    if (hit) { let o = hit.object; while (o && o.userData.id === undefined) o = o.parent; id = o ? o.userData.id : -1; }
    if (id !== hoverOre) { hoverOre = id; cursorTxt.textContent = id >= 0 ? `Inspect ${DEPOSITS[id].code}` : ''; }
  } else if (oA <= 0.5 && hoverOre >= 0) { hoverOre = -1; cursorTxt.textContent = ''; }

  // ---- labels: depth marks along the section
  DEPTH_MARKS.forEach((m, i) => {
    tmp2.set(HALF, m.y, SEC_Z);
    tmp.copy(tmp2).project(camera);
    placeLabel(depthLabels[i], tmp2, S.deepUI * (1 - sstep(0.55, 0.85, Math.abs(tmp.y))) * (1 - fk));
  });

  // ---- HUD
  if (frameN % 3 === 0) {
    let km;
    if (fk > 0.5) km = DEPOSITS[FOCUS.id].depthM / 1000;
    else if (S.solid > 0.5) km = depthKm(Math.min(0, S.ty));
    else km = S.explode > 0.5 ? 4.93 : clamp(S.scanR / 16, 0, 1) * 4.93;
    depthMarker.style.transform = `translateY(${gaugeFrac(km) * depthScale.clientHeight}px)`;
    depthVal.textContent = km < 5.05 ? `${fmt(km * 1000)} m` : `${km.toFixed(0)} km`;
    if (S.solid > 0.5) {
      coreKm.textContent = `${km.toFixed(1)} km`;
      const idx = km < 5 ? 0 : km < 18 ? 1 : km < 35 ? 2 : km < 100 ? 3 : 4;
      coreItems.forEach((li, j) => li.classList.toggle('is-on', j === idx));
    }
    const deg = (a) => (((a * 180) / Math.PI) % 360 + 360) % 360;
    camRead.textContent = `θ ${deg(th).toFixed(1).padStart(5, '0')} · φ ${deg(el).toFixed(1).padStart(4, '0')} · R ${r < 1000 ? r.toFixed(1) : fmt(r)}`;
    const maxS = document.documentElement.scrollHeight - innerHeight;
    progArc.style.strokeDashoffset = 131.95 * (1 - clamp(scrollY / Math.max(1, maxS), 0, 1));
    if (seisActive) {
      const p = clamp(S.scanR / 16, 0, 1);
      roDepth.textContent = `${fmt(Math.min(4930, S.scanR * 330))} m`;
      roRefl.textContent = `${BASES.filter((b) => -b + 0.6 < S.scanR).length} / 6`;
      roSnr.textContent = p > 0 ? `${(22 + p * 17 + Math.sin(t * 9) * 0.6).toFixed(1)} dB` : '— dB';
      roPts.textContent = fmt(Math.pow(p, 1.4) * 38.4e6 * (0.6 + 0.4 * S.slice / 21 + 0.2));
    }
  }
  if (seisActive) drawSeismo(clamp(S.scanR / 16.5, 0, 1), t);

  requestAnimationFrame(tick);
}

/* =========================================================
   Resize
   ========================================================= */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  finalPass.uniforms.uRes.value.set(innerWidth, innerHeight);
  sizeSeis();
  ScrollTrigger.refresh();
});

/* =========================================================
   Boot
   ========================================================= */
window.__dbg = { S, camera, FOCUS, openInspect, closeInspect };
const loader = document.getElementById('loader');
const pct = { v: 0 };
const setPct = () => { loaderPct.textContent = String(Math.round(pct.v)).padStart(3, '0'); loaderArc.style.strokeDashoffset = 339.3 * (1 - pct.v / 100); };
const maskPromise = loadLandMask();
gsap.to(pct, {
  v: 45, duration: 0.6, ease: 'power1.out', onUpdate: setPct,
  onComplete: async () => {
    const mask = await maskPromise;
    init(mask);
    requestAnimationFrame(tick);
    scramble(document.getElementById('loaderTxt'), `${fmt(total)} points ready`, 0.5);
    gsap.to(pct, { v: 100, duration: 0.9, ease: 'power2.inOut', onUpdate: setPct, onComplete: start });
  },
});

function start() {
  loader.classList.add('is-done');
  document.body.classList.remove('is-loading');
  window.scrollTo(0, 0);
  setupScroll();
  lenis.start();
  gsap.from(PLANET_POSE, { r: 520 * PSCALE, el: 1.1, duration: 3.6, ease: 'power3.out' });
  const hw = splitWords(document.querySelector('h1[data-split]'));
  gsap.from(hw, { yPercent: 110, duration: 1.4, stagger: 0.06, ease: 'power4.out', delay: 0.5 });
  gsap.from('.hero [data-fade], .hero .tag', { opacity: 0, y: 18, duration: 1.2, stagger: 0.1, ease: 'power3.out', delay: 0.9 });
  gsap.from('.nav > *', { opacity: 0, y: -10, duration: 1, stagger: 0.08, delay: 0.3 });
}
