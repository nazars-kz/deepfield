// Deepfield — subsurface 3D scenes for inner pages.
// One particle block of toy geology. Modes:
//   hero  — finished, classified volume with a scan sweep, slow orbit
//   story — scroll‑driven: deploy → emit → listen → reconstruct
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { rng } from './viz.js';

const R = rng(42);
const n2 = createNoise2D(rng(9)), n3 = createNoise3D(rng(13));
const fbm2 = (x, y, o = 4) => { let a = 0, f = 1, s = .5; for (let i = 0; i < o; i++) { a += s * n2(x * f, y * f); f *= 2; s *= .5; } return a; };

const BX = 1.7, BZ = 1.35, BD = 1.7;                  // half extents x/z, depth
const surf = (x, z) => .09 * fbm2(x * .7, z * .7, 5) + .03 * fbm2(x * 3, z * 3, 2);
const hor = (k, x, z) => -(.18 + k * .24) + .07 * fbm2(x * .55 + k * 3.1, z * .55 - k, 3) - (x > .55 + .15 * z ? .07 : 0);
const ORE = new THREE.Vector3(-.45, -1.02, .1);
const oreF = (x, y, z) => { const d = Math.hypot((x - ORE.x) / .42, (y - ORE.y) / .16, (z - ORE.z) / .34); return 1 - d + .18 * n3(x * 3, y * 3, z * 3); };
const LITH = [[.78, .74, .67], [.40, .46, .53], [.66, .58, .47], [.30, .34, .40], [.56, .58, .60], [.42, .35, .31], [.22, .25, .30]];
const ACC = [1, .353, .122];

const FX = z => .55 + .15 * z;               // fault trace (matches hor())
const TUN = { y: -.34, z: .55, r: .07 };      // tunnel axis along x
function buildVolume(N, extras = false) {
  // Scan raster: dense jittered grids on the two cut faces, sparse sheets on
  // the interior horizons, and a solid cloud for the ore body.
  const pos = new Float32Array(N * 3), rnd = new Float32Array(N * 3), col = new Float32Array(N * 3), ex = new Float32Array(N * 4), use = new Float32Array(N * 4);
  let i = 0;
  const push = (fx, y, fz, face) => {
    if (i >= N) return;
    if (y > surf(fx, fz) - .01) return;
    let k = 0; while (k < 6 && y < hor(k, fx, fz)) k++;
    let dB = 9; for (let j = 0; j < 6; j++) dB = Math.min(dB, Math.abs(y - hor(j, fx, fz)));
    const boundary = Math.exp(-((dB / .016) ** 2));
    const o = oreF(fx, y, fz);
    let c = LITH[k].slice();
    const sh = (.8 + .2 * n3(fx * 4, y * 4, fz * 4)) * (.74 + .34 * (.5 + .5 * Math.sin(y * 110 + 3 * n3(fx * 1.5, y * 2, fz * 1.5))));
    c = c.map(v => v * sh * (face ? 1 : .7));
    if (boundary > .05) c = c.map((v, j) => v + ([1, .95, .88][j] - v) * boundary * .7);
    if (o > 0) c = ACC.map((v, j) => v * (.7 + .6 * o) + (j === 0 ? 0 : .04));
    pos.set([fx, y, fz], i * 3);
    rnd.set([(R() * 2 - 1) * BX * 1.1, -R() * BD * 1.1 + .1, (R() * 2 - 1) * BZ * 1.1], i * 3);
    col.set(c, i * 3);
    ex.set([R(), boundary, Math.max(0, o), face], i * 4);
    // use-case weights: geothermal fractures, CO2 reservoir + seal, tunnel shell, active fault
    const df = Math.abs(fx - FX(fz));
    const gth = Math.exp(-((df / .07) ** 2)) * Math.min(1, Math.max(0, (-y - .7) / .5));
    const ccs = Math.max(k === 3 ? .4 : 0, Math.exp(-(((y - hor(2, fx, fz)) / .018) ** 2)));
    const td = Math.hypot(y - TUN.y, fz - TUN.z);
    const tun = Math.exp(-(((td - TUN.r) / .016) ** 2)) + (Math.abs(fz - TUN.z) < .02 && Math.abs(y - TUN.y) < TUN.r ? .0 : 0);
    const haz = Math.exp(-((df / .028) ** 2));
    use.set([gth, ccs, tun, haz], i * 4);
    i++;
  };
  const S = .0125, J = S * .35;
  // front face (z = BZ) and side face (x = BX)
  for (let x = -BX; x <= BX; x += S) for (let y = 0; y >= -BD; y -= S) push(x + (R() - .5) * J, y + (R() - .5) * J, BZ, 1);
  for (let z = -BZ; z <= BZ; z += S) for (let y = 0; y >= -BD; y -= S) push(BX, y + (R() - .5) * J, z + (R() - .5) * J, 1);
  // interior horizon sheets
  for (let k = 0; k < 6; k++) for (let x = -BX; x <= BX; x += .034) for (let z = -BZ; z <= BZ; z += .034) { const xx = x + (R() - .5) * .02, zz = z + (R() - .5) * .02; push(xx, hor(k, xx, zz) - .001, zz, 0); }
  // ore body
  for (let n = 0; n < 60000 && i < N; n++) { const x = ORE.x + (R() * 2 - 1) * .55, y = ORE.y + (R() * 2 - 1) * .24, z = ORE.z + (R() * 2 - 1) * .45; if (oreF(x, y, z) > 0) push(x, y, z, 0); }
  if (extras) {
    // fault plane sheet, tunnel tube, reservoir fill — invisible until highlighted
    for (let y = 0; y >= -BD; y -= .02) for (let z = -BZ; z <= BZ; z += .02) { const x = FX(z) + (R() - .5) * .01; if (x < BX) push(x, y + (R() - .5) * .01, z, -1); }
    for (let x = -BX; x <= BX; x += .012) for (let a = 0; a < 26; a++) { const t = a / 26 * Math.PI * 2; push(x, TUN.y + Math.sin(t) * TUN.r, TUN.z + Math.cos(t) * TUN.r, -1); }
    for (let n = 0; n < 40000 && i < N; n++) { const x = (R() * 2 - 1) * BX, z = (R() * 2 - 1) * BZ, y0 = hor(3, x, z), y1 = hor(2, x, z), y = y0 + R() * (y1 - y0); push(x, y, z, -1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('aUse', new THREE.BufferAttribute(use.subarray(0, i * 4), 4));
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd.subarray(0, i * 3), 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(col.subarray(0, i * 3), 3));
  g.setAttribute('aEx', new THREE.BufferAttribute(ex.subarray(0, i * 4), 4));
  return g;
}

const VOL_VS = /* glsl */`
  attribute vec3 aRand; attribute vec3 aCol; attribute vec4 aEx; attribute vec4 aUse;
  uniform vec4 uW; uniform float uW0, uDim;
  uniform float uTime, uReveal, uWave, uWaveOn, uListen, uScan, uScanOn, uSize, uPR, uGhost;
  uniform vec3 uSrc;
  varying vec3 vCol; varying float vA;
  void main(){
    float seed = aEx.x, bnd = aEx.y, ore = aEx.z, face = aEx.w;
    // inversion front sweeps down: points above it are classified
    float depth = -position.y, fr = uReveal * 1.95;
    float rv = 1. - smoothstep(fr - .12 - seed * .06, fr, depth);
    float front = exp(-pow((depth - fr) / .025, 2.)) * step(.001, uReveal) * step(uReveal, .999);
    vec3 p = position;
    float d = distance(p, uSrc);
    float wave = exp(-pow((d - uWave) / .035, 2.)) * uWaveOn * (.35 + face * .65);
    float refl = bnd * exp(-pow((d - uWave) / .07, 2.)) * uListen;
    float scan = uScanOn * exp(-pow((p.x - uScan) / .05, 2.));
    vec3 c = aCol;
    float a = rv * (face > .5 ? .8 : face < -.5 ? 0. : .3) + uGhost * (.04 + bnd * .14) * max(face, 0.);
    c = mix(vec3(.93, .92, .9) * .55, c, rv);
    c += vec3(.93, .92, .9) * wave * .9 + vec3(1., .42, .16) * refl * 2.2 + vec3(1., .55, .3) * scan * .9 + vec3(1., .45, .2) * front * 1.4;
    float oreK = mix(1., uW0, step(.001, uDim));
    c += vec3(1., .35, .12) * ore * (.4 + .4 * sin(uTime * 2.)) * rv * oreK;
    // use-case highlight
    vec4 u = aUse * uW;
    float hl = u.x + u.y + u.z + u.w + ore * uW0 * uDim;
    float pul = .75 + .25 * sin(uTime * 2.4 - position.y * 6.);
    vec3 hc = u.x * vec3(1., .42, .16) + u.y * vec3(.62, .76, .9) + u.z * vec3(.96, .94, .9) + u.w * vec3(1., .3, .1) + ore * uW0 * uDim * vec3(1., .36, .12);
    c = c * mix(1., .28, uDim) + hc * 1.1 * pul;
    a = a * mix(1., .55, uDim);
    a = max(a, wave * .55 + refl + scan * .7 + front * .8 + min(hl, 1.) * .85);
    vCol = c; vA = a;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    gl_PointSize = uSize * uPR * (1. + max(face, 0.) * .5 + ore * .8 + scan * 1.2 + refl + min(hl, 1.) * .6) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const VOL_FS = /* glsl */`
  varying vec3 vCol; varying float vA;
  void main(){ vec2 q = gl_PointCoord - .5; float r = dot(q, q); if (r > .25) discard;
    float s = smoothstep(.25, .0, r); gl_FragColor = vec4(vCol * s, vA * s); }`;

function buildSurface() {
  const S = 140, pos = [], idx = [];
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) { const x = (i / S * 2 - 1) * 2.6, z = (j / S * 2 - 1) * 2.6; pos.push(x, surf(x, z), z); }
  for (let j = 0; j <= S; j += 2) for (let i = 0; i < S; i++) idx.push(j * (S + 1) + i, j * (S + 1) + i + 1);
  for (let i = 0; i <= S; i += 2) for (let j = 0; j < S; j++) idx.push(j * (S + 1) + i, (j + 1) * (S + 1) + i);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uOp: { value: .5 }, uCut: { value: 0 }, uWave: { value: -1 }, uWaveOn: { value: 0 } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform float uOp, uCut, uWave, uWaveOn; varying vec3 vP;
      void main(){ float r = length(vP.xz); float fade = smoothstep(2.6, 1.2, r);
        float inBlock = step(abs(vP.x), ${BX.toFixed(2)}) * step(abs(vP.z), ${BZ.toFixed(2)});
        float a = uOp * fade * .22 * (1. - uCut * inBlock * .85);
        float ring = exp(-pow((r - uWave * 1.2) / .05, 2.)) * uWaveOn;
        gl_FragColor = vec4(vec3(.93,.92,.9) * a + vec3(1.,.36,.12) * ring * .7, 1.); }`,
  });
  return new THREE.LineSegments(g, m);
}

function buildPhones() {
  const list = [];
  [.62, .95, 1.28].forEach((rr, ring) => { for (let i = 0; i < 27; i++) { const a = i / 27 * Math.PI * 2 + ring * .11; const x = Math.cos(a) * rr, z = Math.sin(a) * rr; list.push({ x, z, y: surf(x, z), ring, i, d: (i * 7 + ring * 13) % 27 / 27 }); } });
  const geo = new THREE.CylinderGeometry(.004, .009, .06, 6); geo.translate(0, .035, 0);
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
  const mesh = new THREE.InstancedMesh(geo, m, list.length);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(.011, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), list.length);
  heads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
  return { list, mesh, heads };
}

function buildRays(phones) {
  // reflection paths: source → point on a horizon → geophone
  const pos = [], t = [];
  phones.list.forEach((p, i) => {
    if (i % 2) return;
    const k = [1, 2, 3][i % 3];
    const mx = p.x * .5, mz = p.z * .5, my = hor(k, mx, mz);
    pos.push(0, .02, 0, mx, my, mz, mx, my, mz, p.x, p.y + .05, p.z);
    t.push(0, .5, .5, 1);
  });
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uOp: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform float uOp, uTime; varying float vT;
      void main(){ float head = fract(uTime * .45); float d = vT - head; float trail = smoothstep(-.35, 0., d) * step(d, 0.);
        gl_FragColor = vec4(vec3(1.,.45,.2) * (trail * 1.3 + .12) * uOp, 1.); }`,
  });
  return new THREE.LineSegments(g, m);
}

export class Subsurface {
  constructor(canvas, { mode = 'hero', points } = {}) {
    this.canvas = canvas; this.mode = mode; this.running = false; this.p = 0; this.t = 0;
    this.mouse = new THREE.Vector2(); this.mouseT = new THREE.Vector2();
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(1.75, devicePixelRatio)); r.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(32, 1, .05, 60);
    this.look = new THREE.Vector3(0, -.6, 0);

    const N = points || (mode === 'uses' ? 200000 : 140000);
    this.vol = new THREE.Points(buildVolume(N, mode === 'uses'), new THREE.ShaderMaterial({
      vertexShader: VOL_VS, fragmentShader: VOL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uReveal: { value: mode === 'story' ? 0 : 1 }, uWave: { value: -1 }, uWaveOn: { value: 0 }, uListen: { value: 0 }, uScan: { value: 0 }, uScanOn: { value: mode === 'hero' ? 1 : 0 }, uSize: { value: mode === 'hero' ? 9 : 8.5 }, uPR: { value: r.getPixelRatio() }, uGhost: { value: mode === 'hero' ? 0 : .4 }, uSrc: { value: new THREE.Vector3(0, 0, 0) }, uW: { value: new THREE.Vector4() }, uW0: { value: 0 }, uDim: { value: 0 } },
    }));
    this.scene.add(this.vol);
    this.surface = buildSurface(); this.scene.add(this.surface);

    // block frame edges
    const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(BX * 2, BD, BZ * 2)); eg.translate(0, -BD / 2, 0);
    this.frame = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0xecebe6, transparent: true, opacity: .14 }));
    this.scene.add(this.frame);

    if (mode === 'story') {
      this.phones = buildPhones(); this.scene.add(this.phones.mesh, this.phones.heads);
      this.rays = buildRays(this.phones); this.scene.add(this.rays);
      const src = new THREE.Mesh(new THREE.CylinderGeometry(.05, .06, .08, 24), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
      src.position.y = surf(0, 0) + .04; this.src = src; this.scene.add(src);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.36, 1.37, 128), new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: .0, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = .03; this.footRing = ring; this.scene.add(ring);
      this.dummy = new THREE.Object3D();
    }

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.cam));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), .55, .6, .18);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    addEventListener('pointermove', e => { this.mouseT.set(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1); }, { passive: true });
    this.clock = new THREE.Clock();
    this.frameOnce();
  }
  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.cam.aspect = w / h;
    this.cam.fov = w / h < 1 ? 46 : 32;
    // story: push the subject right of centre so the copy has room
    if (this.mode !== 'hero' && w / h > 1.2) this.cam.setViewOffset(w * 1.36, h, 0, 0, w, h); else this.cam.clearViewOffset();
    this.cam.updateProjectionMatrix();
    this.vol.material.uniforms.uPR.value = this.renderer.getPixelRatio() * (h / 900);
  }
  setProgress(p) { this.p = p; }
  setUse(i) { this.useT = i; }
  start() { if (this.running) return; this.running = true; this.clock.getDelta(); const loop = () => { if (!this.running) return; this.tick(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  stop() { this.running = false; }
  frameOnce() { this.tick(0); }
  project(v) { const p = v.clone().project(this.cam); return { x: (p.x * .5 + .5) * this.canvas.clientWidth, y: (-p.y * .5 + .5) * this.canvas.clientHeight, vis: p.z < 1 }; }

  tick(dtIn) {
    const dt = dtIn ?? Math.min(.05, this.clock.getDelta());
    this.t += dt; const t = this.t;
    this.mouse.lerp(this.mouseT, .04);
    const U = this.vol.material.uniforms; U.uTime.value = t;
    if (this.mode === 'hero') {
      const a = .62 + .22 * Math.sin(t * .09) + this.mouse.x * .12;
      const rad = 8.8;
      this.cam.position.set(Math.sin(a) * rad, 1.9 - this.mouse.y * .25, Math.cos(a) * rad);
      this.look.set(0, -.75, 0);
      U.uScan.value = ((t * .28) % 1.4) * (BX * 2 + .6) / 1.4 - BX - .3;
    } else if (this.mode === 'uses') {
      const a = .7 + .18 * Math.sin(t * .07) + this.mouse.x * .1, rad = 8.6;
      this.cam.position.set(Math.sin(a) * rad, 1.5 - this.mouse.y * .2, Math.cos(a) * rad);
      this.look.set(0, -.8, 0);
      // ease highlight weights toward the selected use case
      const tgt = [0, 0, 0, 0, 0]; if (this.useT != null && this.useT >= 0) tgt[this.useT] = 1;
      this.w5 = this.w5 || [0, 0, 0, 0, 0];
      const k = 1 - Math.exp(-dt * 5);
      for (let j = 0; j < 5; j++) this.w5[j] += (tgt[j] - this.w5[j]) * k;
      U.uW0.value = this.w5[0]; U.uW.value.set(this.w5[1], this.w5[2], this.w5[3], this.w5[4]);
      U.uDim.value += ((this.useT >= 0 ? 1 : 0) - U.uDim.value) * k;
    } else this.story(t, U);
    this.cam.lookAt(this.look);
    this.composer.render();
    this.onFrame?.(this);
  }

  story(t, U) {
    const p = this.p;                                  // 0..4
    const s0 = THREE.MathUtils.clamp(p, 0, 1), s1 = THREE.MathUtils.clamp(p - 1, 0, 1), s2 = THREE.MathUtils.clamp(p - 2, 0, 1), s3 = THREE.MathUtils.clamp(p - 3, 0, 1);
    const sm = x => x * x * (3 - 2 * x);
    // camera keyframes
    const K = [[3.6, 2.9, 4.2, 0, -.2, 0], [3.4, 1.7, 4.4, 0, -.5, 0], [2.9, .9, 4.4, 0, -.7, 0], [.9, -.25, 5.4, 0, -.82, 0], [.9, -.25, 5.4, 0, -.82, 0]];
    const seg = Math.min(3, Math.floor(p)), f = sm(THREE.MathUtils.clamp(p - seg, 0, 1));
    const A = K[seg], B = K[seg + 1];
    this.cam.position.set(THREE.MathUtils.lerp(A[0], B[0], f) + this.mouse.x * .15, THREE.MathUtils.lerp(A[1], B[1], f) - this.mouse.y * .1, THREE.MathUtils.lerp(A[2], B[2], f));
    this.look.set(THREE.MathUtils.lerp(A[3], B[3], f), THREE.MathUtils.lerp(A[4], B[4], f), THREE.MathUtils.lerp(A[5], B[5], f));

    // wave loop runs once emitting starts
    const waveOn = sm(THREE.MathUtils.clamp(p - .85, 0, .3) / .3) * (1 - sm(s3));
    const wr = (t * .55) % 2.4;
    U.uWave.value = wr; U.uWaveOn.value = waveOn * (1 - s2 * .5);
    U.uListen.value = sm(s2) * (1 - sm(s3));
    U.uReveal.value = sm(s3);
    U.uGhost.value = .22 + s1 * .3;
    this.surface.material.uniforms.uWave.value = wr; this.surface.material.uniforms.uWaveOn.value = waveOn * .6;
    this.surface.material.uniforms.uCut.value = sm(s3);
    this.surface.material.uniforms.uOp.value = .9 - s3 * .3;
    this.rays.material.uniforms.uOp.value = sm(s2) * (1 - sm(s3) * .85); this.rays.material.uniforms.uTime.value = t;
    this.footRing.material.opacity = .5 * sm(s0) * (1 - s3);
    this.src.scale.setScalar(.001 + sm(THREE.MathUtils.clamp(p * 3 - .2, 0, 1)));
    this.frame.material.opacity = .06 + .14 * sm(s3);

    // geophones drop in, ring by ring; flash on returns
    const { list, mesh, heads } = this.phones, d = this.dummy, col = new THREE.Color();
    list.forEach((g, i) => {
      const local = THREE.MathUtils.clamp((s0 * 1.6 - g.ring * .22 - g.d * .35) / .4, 0, 1);
      const e = sm(local);
      d.position.set(g.x, g.y + (1 - e) * .9, g.z); d.scale.setScalar(.001 + e); d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      d.position.y += .075; d.updateMatrix(); heads.setMatrixAt(i, d.matrix);
      const r = Math.hypot(g.x, g.z), arrive = Math.exp(-((((wr - r * .85) % 2.4) / .08) ** 2)) * U.uListen.value;
      col.setRGB(.7 + .3 * arrive, .69 - .3 * arrive, .66 - .55 * arrive);
      heads.setColorAt(i, col); mesh.setColorAt(i, col.multiplyScalar(.6));
    });
    mesh.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = heads.instanceColor.needsUpdate = true;
    mesh.material.opacity = 1 - sm(s3) * .6;
    this.bloom.strength = .5 + U.uListen.value * .25;
  }
}

export const OREPOS = ORE;
