// Deepfield — procedural "instrument" visuals (Canvas 2D + d3-contour).
// Every visual is generated from the same toy geology so screens agree with each other.
import { createNoise2D } from 'simplex-noise';
import { contours } from 'd3-contour';
import { geoPath } from 'd3-geo';

/* ---------- utils ---------- */
export const rng = (seed = 1) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ramp = stops => { const s = stops.map(([p, c]) => [p, hex(c)]); return v => { v = clamp(v); for (let i = 1; i < s.length; i++) if (v <= s[i][0]) { const t = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]); return s[i - 1][1].map((c, k) => lerp(c, s[i][1][k], t)); } return s[s.length - 1][1]; }; };

export const C = { bg: '#060708', fg: '#ecebe6', mut: '#9a9da0', dim: '#5d6165', line: 'rgba(236,235,230,.09)', line2: 'rgba(236,235,230,.2)', acc: '#ff5a1f' };
const MONO = '400 10px "Geist Mono", ui-monospace, monospace';
export const VEL = ramp([[0, '#07090b'], [.22, '#161b20'], [.45, '#323a42'], [.66, '#6c6f6d'], [.84, '#c9c3b6'], [.93, '#efe6d6'], [1, '#ff5a1f']]);
export const LITH = ['#30363c', '#454b51', '#5d6064', '#787268', '#8f877a', '#565c63', '#3a4046'].map(hex);

/* ---------- shared toy geology (x across 0..1, z down 0..1) ---------- */
const nz = createNoise2D(rng(7));
const fbm = (x, y, o = 4) => { let a = 0, f = 1, s = .5; for (let i = 0; i < o; i++) { a += s * nz(x * f, y * f); f *= 2; s *= .5; } return a; };
const FAULT = z => .64 + .1 * z;
export const ORE = { x: .37, z: .6, rx: .085, rz: .038 };
export function horizon(k, x) {
  const throwDown = x > FAULT(.15 + k * .14) ? .045 : 0;
  return .1 + k * .135 + .028 * fbm(x * 2.2, k * 3.1) + .012 * Math.sin(x * 9 + k) + throwDown;
}
export function geo(x, z) {
  let k = 0; while (k < 6 && z > horizon(k, x)) k++;
  const ex = (x - ORE.x) / ORE.rx, ez = (z - ORE.z - (x - ORE.x) * .18) / ORE.rz;
  const ore = Math.max(0, 1 - Math.sqrt(ex * ex + ez * ez));
  const v = .2 + k * .085 + .03 * fbm(x * 6, z * 6) + z * .08;
  return { k, ore, v: ore > 0 ? Math.max(v, .965 + ore * .035) : v };
}

/* ---------- canvas plumbing ---------- */
function canvasViz(canvas, { setup, draw, animated = true, once = false }) {
  const ctx = canvas.getContext('2d');
  const st = { w: 0, h: 0, dpr: 1, t: 0, t0: 0, raf: 0, running: false, done: false };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    st.dpr = Math.min(2, devicePixelRatio || 1);
    st.w = Math.max(1, r.width); st.h = Math.max(1, r.height);
    canvas.width = Math.round(st.w * st.dpr); canvas.height = Math.round(st.h * st.dpr);
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    setup?.(ctx, st);
    draw(ctx, st);
  };
  new ResizeObserver(resize).observe(canvas);
  const loop = now => {
    if (!st.t0) st.t0 = now;
    st.t = (now - st.t0) / 1000;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    draw(ctx, st);
    if (st.running) st.raf = requestAnimationFrame(loop);
  };
  const api = {
    st, _draw: () => { ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); draw(ctx, st); },
    start() { if (!animated || st.running) return; if (once && st.done) return; st.running = true; st.raf = requestAnimationFrame(loop); },
    stop() { st.running = false; cancelAnimationFrame(st.raf); },
    replay() { st.t0 = 0; st.done = false; this.start(); },
  };
  return api;
}
const label = (ctx, txt, x, y, col = C.dim, align = 'left') => { ctx.font = MONO; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(txt.toUpperCase(), x, y); };
const grid = (ctx, x0, y0, w, h, nx, ny) => { ctx.strokeStyle = 'rgba(236,235,230,.05)'; ctx.lineWidth = 1; ctx.beginPath(); for (let i = 0; i <= nx; i++) { const x = x0 + w * i / nx; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); } for (let j = 0; j <= ny; j++) { const y = y0 + h * j / ny; ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); } ctx.stroke(); };

/* =========================================================
   1. Shot gather — wiggle traces with variable-area fill.
   Recording sweeps down, then picks are drawn.
========================================================= */
function gather(canvas, o = {}) {
  const NT = o.traces || 54, NS = 380, TMAX = 3.0, r = rng(11);
  const t0s = [.38, .7, 1.02, 1.38, 1.74, 2.2, 2.62], VV = [1.6, 2.1, 2.6, 3.0, 3.5, 4.1, 4.6];
  const ORE_EV = 3;
  const ricker = (tau, f = 22) => { const a = (Math.PI * f * tau) ** 2; return (1 - 2 * a) * Math.exp(-a); };
  const data = [];
  for (let i = 0; i < NT; i++) {
    const x = (i / (NT - 1)) * 2 - 1, off = x * 2.4; // km
    const tr = new Float32Array(NS);
    for (let s = 0; s < NS; s++) {
      const t = s / NS * TMAX; let a = 0;
      a += 1.4 * ricker(t - (Math.abs(off) / 1.9 + .03), 30) * Math.exp(-Math.abs(off) * .3);
      if (t < Math.abs(off) / .75 + .25 && t > Math.abs(off) / .75 - .1) a += .55 * Math.sin(t * 38 + off * 3) * Math.exp(-(((t - Math.abs(off) / .75) * 5) ** 2));
      t0s.forEach((t0, k) => { const tt = Math.sqrt(t0 * t0 + (off / VV[k]) ** 2); a += (k % 2 ? -1 : 1) * (k === ORE_EV ? 1.25 : .8) * ricker(t - tt) * (1 - k * .06); });
      a += (r() - .5) * .16;
      tr[s] = a * (1 + t * .55);
    }
    data.push(tr);
  }
  const PAD = { l: 44, r: 14, t: 30, b: 16 };
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h } = st, W = w - PAD.l - PAD.r, H = h - PAD.t - PAD.b;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      grid(ctx, PAD.l, PAD.t, W, H, 8, 6);
      const cycle = 7.5, ph = st.running ? (st.t % cycle) : cycle - .1;
      const tc = clamp(ph / 4.8) * TMAX, pick = clamp((ph - 4.9) / 1.2);
      const dx = W / NT, amp = dx * 1.5, sMax = Math.floor(tc / TMAX * NS);
      for (let i = 0; i < NT; i++) {
        const tr = data[i], x0 = PAD.l + (i + .5) * dx;
        ctx.beginPath(); ctx.moveTo(x0, PAD.t);
        for (let s = 0; s < sMax; s++) { const y = PAD.t + s / NS * H; ctx.lineTo(x0 + Math.max(0, tr[s]) * amp, y); }
        ctx.lineTo(x0, PAD.t + sMax / NS * H); ctx.closePath();
        ctx.fillStyle = 'rgba(236,235,230,.62)'; ctx.fill();
        ctx.beginPath();
        for (let s = 0; s < sMax; s++) { const y = PAD.t + s / NS * H, xx = x0 + tr[s] * amp; s ? ctx.lineTo(xx, y) : ctx.moveTo(xx, y); }
        ctx.strokeStyle = 'rgba(236,235,230,.4)'; ctx.lineWidth = .6; ctx.stroke();
      }
      // record cursor
      if (tc < TMAX) {
        const y = PAD.t + tc / TMAX * H;
        const g = ctx.createLinearGradient(0, y - 40, 0, y); g.addColorStop(0, 'rgba(255,90,31,0)'); g.addColorStop(1, 'rgba(255,90,31,.18)');
        ctx.fillStyle = g; ctx.fillRect(PAD.l, y - 40, W, 40);
        ctx.fillStyle = C.acc; ctx.fillRect(PAD.l, y, W, 1);
        label(ctx, `t ${tc.toFixed(2)} s`, PAD.l + W - 4, y - 9, C.acc, 'right');
      }
      // picks: hyperbolae
      if (pick > 0) t0s.forEach((t0, k) => {
        ctx.beginPath();
        const n = Math.floor(NT * pick);
        for (let i = 0; i <= n; i++) {
          const ii = k % 2 ? NT - 1 - i : i; const x = (ii / (NT - 1)) * 2 - 1, off = x * 2.4;
          const tt = Math.sqrt(t0 * t0 + (off / VV[k]) ** 2); const px = PAD.l + (ii + .5) * dx, py = PAD.t + tt / TMAX * H;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.strokeStyle = k === ORE_EV ? C.acc : 'rgba(159,180,196,.7)'; ctx.lineWidth = k === ORE_EV ? 1.6 : 1; ctx.setLineDash(k === ORE_EV ? [] : [4, 3]); ctx.stroke(); ctx.setLineDash([]);
        if (pick > .95) label(ctx, k === ORE_EV ? 'R4 · high-impedance body' : `R${k + 1}`, PAD.l + W * .5 + 6, PAD.t + t0 / TMAX * H - 8, k === ORE_EV ? C.acc : C.dim);
      });
      // axes
      if (w > 480) label(ctx, 'offset km', PAD.l, 12); label(ctx, '−2.4', PAD.l, PAD.t - 9); label(ctx, '0', PAD.l + W / 2, PAD.t - 9, C.dim, 'center'); label(ctx, '+2.4', PAD.l + W, PAD.t - 9, C.dim, 'right');
      for (let s = 0; s <= 6; s++) label(ctx, (s * .5).toFixed(1), PAD.l - 8, PAD.t + H * s / 6, C.dim, 'right');
      label(ctx, 'twt s', 6, 12);
    },
  });
}

/* =========================================================
   2. Spectrum — what the source puts into the ground.
========================================================= */
function spectrum(canvas) {
  const N = 72, fmin = .5, fmax = 240, r = rng(3);
  const jit = Array.from({ length: N }, () => r());
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st, P = { l: 12, r: 12, t: 14, b: 26 }, W = w - P.l - P.r, H = h - P.t - P.b;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      grid(ctx, P.l, P.t, W, H, 6, 4);
      const bw = W / N;
      for (let i = 0; i < N; i++) {
        const f = fmin * Math.pow(fmax / fmin, i / (N - 1));
        let a = Math.exp(-((Math.log(f) - Math.log(28)) ** 2) / 2.2) * .9 + .1 * Math.exp(-((Math.log(f) - Math.log(4)) ** 2));
        a *= .86 + .14 * Math.sin(t * 3 + jit[i] * 9);
        const bh = a * H;
        ctx.fillStyle = f > 18 && f < 45 ? C.acc : 'rgba(236,235,230,.55)';
        ctx.fillRect(P.l + i * bw + 1, P.t + H - bh, Math.max(1, bw - 2), bh);
      }
      ctx.strokeStyle = 'rgba(159,180,196,.6)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(P.l, P.t + H * .9); ctx.lineTo(P.l + W, P.t + H * .9); ctx.stroke(); ctx.setLineDash([]);
      [1, 10, 100].forEach(f => { const x = P.l + W * Math.log(f / fmin) / Math.log(fmax / fmin); label(ctx, `${f} Hz`, x, h - 10, C.dim, 'center'); });
      label(ctx, 'noise floor', P.l + W - 2, P.t + H * .9 - 8, '#9fb4c4', 'right');
    },
  });
}

/* =========================================================
   3. Velocity section — full-waveform inversion converging.
========================================================= */
function section(canvas, o = {}) {
  const RW = 360, RH = 170;
  const mk = fn => { const c = document.createElement('canvas'); c.width = RW; c.height = RH; const x = c.getContext('2d'); const im = x.createImageData(RW, RH); for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) { const col = fn(i / RW, j / RH); const p = (j * RW + i) * 4; im.data[p] = col[0]; im.data[p + 1] = col[1]; im.data[p + 2] = col[2]; im.data[p + 3] = 255; } x.putImageData(im, 0, 0); return c; };
  const fin = mk((x, z) => VEL(geo(x, z).v));
  const ini = mk((x, z) => VEL(.18 + z * .55 + .05 * fbm(x * 1.5, z * 1.5, 2)));
  const PAD = { l: 44, r: 14, t: 14, b: 26 };
  const ITER = 40, DUR = o.duration || 5.5;
  return canvasViz(canvas, {
    once: true,
    draw(ctx, st) {
      const { w, h } = st, W = w - PAD.l - PAD.r, H = h - PAD.t - PAD.b;
      const k = st.running || st.done ? sstep(0, 1, st.t / DUR) : (o.still ? 1 : 0);
      if (st.t > DUR + .2 && st.running) { st.done = true; st.running = false; }
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = 1; ctx.drawImage(ini, PAD.l, PAD.t, W, H);
      ctx.globalAlpha = k; ctx.drawImage(fin, PAD.l, PAD.t, W, H); ctx.globalAlpha = 1;
      // horizons
      const hk = sstep(.75, 1, k), L = canvas.__layers || { h: 1, f: 1, o: 1 };
      if (hk > 0) {
        ctx.lineWidth = 1;
        for (let n = 0; n < 6 && L.h; n++) {
          ctx.beginPath();
          for (let i = 0; i <= 120; i++) { const x = i / 120, y = PAD.t + clamp(horizon(n, x)) * H; i ? ctx.lineTo(PAD.l + x * W, y) : ctx.moveTo(PAD.l, y); }
          ctx.strokeStyle = `rgba(236,235,230,${.35 * hk})`; ctx.stroke();
        }
        // fault
        if (L.f) {
        ctx.beginPath(); ctx.moveTo(PAD.l + FAULT(0) * W, PAD.t); ctx.lineTo(PAD.l + FAULT(1) * W, PAD.t + H);
        ctx.strokeStyle = `rgba(159,180,196,${.8 * hk})`; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
        label(ctx, 'F1 normal fault', PAD.l + FAULT(.1) * W + 8, PAD.t + H * .1, `rgba(159,180,196,${hk})`);
        }
        if (L.o) {
        // ore outline
        ctx.beginPath(); ctx.ellipse(PAD.l + ORE.x * W, PAD.t + ORE.z * H, ORE.rx * W * 1.15, ORE.rz * H * 1.6, .18, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,90,31,${hk})`; ctx.lineWidth = 1.2; ctx.stroke();
        const lx = PAD.l + (ORE.x + ORE.rx + .04) * W, ly = PAD.t + (ORE.z + .12) * H;
        ctx.beginPath(); ctx.moveTo(PAD.l + (ORE.x + ORE.rx * .8) * W, PAD.t + (ORE.z + .02) * H); ctx.lineTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
        label(ctx, 'Vp 6.4 km/s · 1.9 km', lx + 22, ly, `rgba(255,90,31,${hk})`);
        }
      }
      // depth axis
      for (let s = 0; s <= 5; s++) label(ctx, `${s}`, PAD.l - 8, PAD.t + H * s / 5, C.dim, 'right');
      label(ctx, 'km', PAD.l - 8, h - 10, C.dim, 'right');
      for (let s = 0; s <= 6; s++) label(ctx, `${s * 2}`, PAD.l + W * s / 6, h - 10, C.dim, 'center');
      // misfit mini plot
      const mx = PAD.l + W - 150, my = PAD.t + 10, mw = 136, mh = 44;
      ctx.fillStyle = 'rgba(6,7,8,.75)'; ctx.fillRect(mx - 8, my - 6, mw + 16, mh + 26);
      ctx.strokeStyle = C.line2; ctx.strokeRect(mx - 8, my - 6, mw + 16, mh + 26);
      ctx.beginPath();
      const it = Math.round(k * ITER);
      for (let i = 0; i <= it; i++) { const x = mx + mw * i / ITER, y = my + mh * (1 - Math.exp(-i / 8) * .92 - .02); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = C.acc; ctx.lineWidth = 1.2; ctx.stroke();
      label(ctx, `fwi iter ${String(it).padStart(2, '0')}/${ITER}`, mx, my + mh + 12, C.mut);
      label(ctx, `misfit ${(Math.exp(-it / 8) * 92 + 2).toFixed(1)}%`, mx + mw, my + mh + 12, C.dim, 'right');
    },
  });
}

/* =========================================================
   4. Footprint — plan view of a DF‑7 deployment on terrain.
========================================================= */
function footprint(canvas) {
  const r = rng(21), GX = 110, GY = 70;
  const field = new Float64Array(GX * GY);
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) field[j * GX + i] = fbm(i / 38 + 10, j / 38 - 4, 5) + .35 * Math.sin(i / 21);
  const iso = contours().size([GX, GY]).thresholds(22)(Array.from(field));
  const phones = []; [.24, .35, .46].forEach((rr, ring) => { for (let i = 0; i < 27; i++) { const a = i / 27 * Math.PI * 2 + ring * .11; phones.push({ a, rr: rr + (r() - .5) * .012, ring, hit: -9 }); } });
  let bg;
  return canvasViz(canvas, {
    setup(ctx, st) {
      bg = document.createElement('canvas'); bg.width = st.w * st.dpr; bg.height = st.h * st.dpr;
      const b = bg.getContext('2d'); b.scale(st.dpr, st.dpr);
      b.fillStyle = C.bg; b.fillRect(0, 0, st.w, st.h);
      b.save(); b.scale(st.w / (GX - 1), st.h / (GY - 1));
      const path = geoPath(null, b);
      iso.forEach((c, i) => { b.beginPath(); path(c); b.lineWidth = (i % 5 === 0 ? 1.1 : .55) * (GX - 1) / st.w; b.strokeStyle = i % 5 === 0 ? 'rgba(236,235,230,.16)' : 'rgba(236,235,230,.07)'; b.stroke(); });
      b.restore();
      // road
      b.beginPath(); b.moveTo(0, st.h * .86); b.bezierCurveTo(st.w * .25, st.h * .8, st.w * .32, st.h * .62, st.w * .5, st.h * .6); b.bezierCurveTo(st.w * .7, st.h * .58, st.w * .8, st.h * .9, st.w, st.h * .82);
      b.strokeStyle = 'rgba(236,235,230,.22)'; b.setLineDash([6, 5]); b.lineWidth = 1.2; b.stroke(); b.setLineDash([]);
    },
    draw(ctx, st) {
      const { w, h, t } = st, cx = w * .5, cy = h * .5, R = Math.min(w, h);
      ctx.drawImage(bg, 0, 0, w, h);
      // pulse
      const per = 2.6, ph = (t % per) / per, pr = ph * R * .62;
      for (let k = 0; k < 3; k++) {
        const rr = pr - k * 14; if (rr <= 0) continue;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,90,31,${(1 - ph) * (.5 - k * .15)})`; ctx.lineWidth = 1; ctx.stroke();
      }
      // ring guides
      ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(236,235,230,.12)';
      [.24, .35, .46].forEach(rr => { ctx.beginPath(); ctx.arc(cx, cy, rr * R, 0, Math.PI * 2); ctx.stroke(); });
      ctx.setLineDash([]);
      // dimension line
      const D = .46 * R;
      ctx.strokeStyle = 'rgba(159,180,196,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx - D, cy + D + 24); ctx.lineTo(cx + D, cy + D + 24); ctx.moveTo(cx - D, cy + D + 18); ctx.lineTo(cx - D, cy + D + 30); ctx.moveTo(cx + D, cy + D + 18); ctx.lineTo(cx + D, cy + D + 30); ctx.stroke();
      label(ctx, 'Ø up to 20 km', cx, cy + D + 38, '#9fb4c4', 'center');
      // geophones
      phones.forEach((p, i) => {
        const x = cx + Math.cos(p.a) * p.rr * R, y = cy + Math.sin(p.a) * p.rr * R;
        const d = Math.hypot(x - cx, y - cy); if (Math.abs(d - pr) < 4) p.hit = t;
        const f = Math.exp(-(t - p.hit) * 2.2);
        ctx.beginPath(); ctx.arc(x, y, 2.2 + f * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = f > .05 ? `rgba(255,${90 + 140 * (1 - f)},${31 + 180 * (1 - f)},1)` : C.fg; ctx.fill();
        if (f > .3) { ctx.beginPath(); ctx.arc(x, y, 7 + f * 4, 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,90,31,${f * .5})`; ctx.stroke(); }
      });
      // source
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fillStyle = C.acc; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,90,31,.6)'; ctx.stroke();
      label(ctx, 'src‑01 · pulse 0.5–240 hz', cx + 18, cy - 16, C.fg);
      // edge unit + vans on road
      const ex = w * .5, ey = h * .6 + 2;
      const p0 = phones[20]; const gx = cx + Math.cos(p0.a) * p0.rr * R, gy = cy + Math.sin(p0.a) * p0.rr * R;
      ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + 40, gy - 26); ctx.lineTo(gx + 64, gy - 26); ctx.stroke();
      label(ctx, 'geophone 81 · gnss timed', gx + 70, gy - 26, C.mut);
      [[.18, .79], [.83, .86]].forEach(([u, v], i) => { const x = w * u, y = h * v; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.roundRect(x - 9, y - 5, 18, 10, 3); ctx.fill(); label(ctx, i ? 'van 2 · edge unit' : 'van 1 · crew of 4', x + 14, y - 12, C.mut); });
      void ex; void ey;
      // scale + north
      ctx.fillStyle = C.fg; ctx.fillRect(18, h - 22, 60, 1.5); ctx.fillRect(18, h - 26, 1, 9); ctx.fillRect(78, h - 26, 1, 9);
      label(ctx, '0', 18, h - 34); label(ctx, '5 km', 78, h - 34, C.dim, 'center');
      ctx.beginPath(); ctx.moveTo(w - 26, 22); ctx.lineTo(w - 32, 38); ctx.lineTo(w - 26, 34); ctx.lineTo(w - 20, 38); ctx.closePath(); ctx.fillStyle = C.fg; ctx.fill();
      label(ctx, 'N', w - 26, 50, C.dim, 'center');
    },
  });
}

/* =========================================================
   5. Validation — sealed cores laid over the delivered model.
========================================================= */
function cores(canvas) {
  const RW = 300, RH = 150;
  const xs = [.06, .14, .22, .3, .37, .45, .53, .6, .69, .78, .86, .94];
  const miss = 8;
  let img;
  const mkImg = () => { const c = document.createElement('canvas'); c.width = RW; c.height = RH; const x = c.getContext('2d'); const im = x.createImageData(RW, RH); for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) { const g = geo(i / RW, j / RH); const col = g.ore > 0 ? hex(C.acc) : LITH[g.k]; const sh = .78 + .22 * fbm(i / 12, j / 12, 2); const p = (j * RW + i) * 4; im.data[p] = col[0] * sh; im.data[p + 1] = col[1] * sh; im.data[p + 2] = col[2] * sh; im.data[p + 3] = 255; } x.putImageData(im, 0, 0); return c; };
  img = mkImg();
  const PAD = { l: 36, r: 12, t: 30, b: 22 };
  return canvasViz(canvas, {
    once: true,
    draw(ctx, st) {
      const { w, h } = st, W = w - PAD.l - PAD.r, H = h - PAD.t - PAD.b;
      if (st.running && st.t > 3.6) { st.done = true; st.running = false; }
      const tt = st.done ? 9 : st.t;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = .85; ctx.imageSmoothingEnabled = true; ctx.drawImage(img, PAD.l, PAD.t, W, H); ctx.globalAlpha = 1;
      xs.forEach((x, i) => {
        const len = sstep(i * .14, i * .14 + 1.1, tt);
        const cx = PAD.l + x * W, cw = Math.max(5, W * .009);
        const zEnd = .86 * len;
        for (let s = 0; s < 120; s++) {
          const z0 = s / 120 * zEnd, z1 = (s + 1) / 120 * zEnd;
          const g = geo(x + .004, z0 + (i === miss ? .03 : 0) + .006 * Math.sin(i * 5 + s));
          const col = g.ore > 0 ? hex(C.acc) : LITH[g.k].map(c => Math.min(255, c * 1.2));
          ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
          ctx.fillRect(cx - cw / 2, PAD.t + z0 * H, cw, (z1 - z0) * H + .6);
        }
        ctx.strokeStyle = 'rgba(236,235,230,.5)'; ctx.lineWidth = .8; ctx.strokeRect(cx - cw / 2, PAD.t, cw, zEnd * H);
        if (len > .98) {
          const ok = i !== miss;
          label(ctx, `c${String(i + 1).padStart(2, '0')}`, cx, PAD.t - 18, ok ? C.dim : C.acc, 'center');
          ctx.beginPath(); ctx.arc(cx, PAD.t - 6, 3, 0, Math.PI * 2); ctx.fillStyle = ok ? C.fg : C.acc; ctx.fill();
          if (!ok) { ctx.strokeStyle = C.acc; ctx.setLineDash([3, 3]); ctx.strokeRect(cx - cw, PAD.t + (ORE.z - .08) * H, cw * 2, .18 * H); ctx.setLineDash([]); label(ctx, 'missed lens · 30 m', cx + cw + 6, PAD.t + (ORE.z + .12) * H, C.acc); }
        }
      });
      for (let s = 0; s <= 4; s++) label(ctx, `${s}`, PAD.l - 8, PAD.t + H * s / 4, C.dim, 'right');
      label(ctx, 'km', PAD.l - 8, h - 8, C.dim, 'right');
    },
  });
}

/* =========================================================
   6. Dot map — real ETOPO1 land mask, pins for sites.
========================================================= */
let ELEV;
const elev = () => ELEV ||= fetch('data/elevation.json').then(r => r.json());
async function dotmap(canvas, o = {}) {
  const E = await elev();
  const pins = o.pins || [];
  let bg, active = -1;
  const inst = canvasViz(canvas, {
    setup(ctx, st) {
      bg = document.createElement('canvas'); bg.width = st.w * st.dpr; bg.height = st.h * st.dpr;
      const b = bg.getContext('2d'); b.scale(st.dpr, st.dpr);
      const step = st.w < 700 ? 2 : 1, cs = st.w / E.w * step;
      for (let j = 0; j < E.h; j += step) {
        const lat = 90 - (j + .5) * 180 / E.h; if (lat < -58) continue;
        for (let i = 0; i < E.w; i += step) {
          const e = E.data[j * E.w + i]; if (e <= 0) continue;
          const x = (i + .5) / E.w * st.w, y = (j + .5) / E.h * st.h;
          b.beginPath(); b.arc(x, y, Math.max(.7, cs * .26) * (e > 1500 ? 1.25 : 1), 0, Math.PI * 2);
          b.fillStyle = e > 1500 ? 'rgba(236,235,230,.42)' : 'rgba(236,235,230,.22)'; b.fill();
        }
      }
    },
    draw(ctx, st) {
      const { w, h, t } = st;
      ctx.clearRect(0, 0, w, h); ctx.drawImage(bg, 0, 0, w, h);
      pins.forEach((p, i) => {
        const x = (p.lon + 180) / 360 * w, y = (90 - p.lat) / 180 * h, on = i === active;
        const ph = ((t * .6 + i * .37) % 1);
        ctx.beginPath(); ctx.arc(x, y, 4 + ph * (on ? 34 : 18), 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,90,31,${(1 - ph) * (on ? .8 : .45)})`; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, on ? 5 : 3.5, 0, Math.PI * 2); ctx.fillStyle = C.acc; ctx.fill();
        if (on || (o.labels && !p.nl)) {
          const right = x < w * .75, lx = x + (right ? 14 : -14);
          ctx.strokeStyle = on ? C.acc : C.line2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, y - 14); ctx.stroke();
          label(ctx, p.label, lx + (right ? 4 : -4), y - 14, on ? C.fg : C.mut, right ? 'left' : 'right');
          if (p.sub && on) label(ctx, p.sub, lx + (right ? 4 : -4), y - 1, C.dim, right ? 'left' : 'right');
        }
      });
    },
  });
  inst.setActive = i => { active = i; };
  return inst;
}

/* =========================================================
   7. Rings — quiet wavefronts behind a call to action.
========================================================= */
function rings(canvas) {
  const r = rng(5); const ph = Array.from({ length: 64 }, (_, i) => ({ a: i / 64 * Math.PI * 2, rr: .3 + r() * .02, hit: -9 }));
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st, cx = w / 2, cy = h * .56, R = Math.max(w, h) * .62;
      ctx.clearRect(0, 0, w, h);
      for (let k = 0; k < 7; k++) {
        const p = ((t * .12 + k / 7) % 1), rr = p * R;
        ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * .42, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(236,235,230,${.12 * (1 - p)})`; ctx.lineWidth = 1; ctx.stroke();
      }
      const pr = ((t * .12) % (1 / 7)) * 7;
      ph.forEach(p => {
        const x = cx + Math.cos(p.a) * p.rr * w * .9, y = cy + Math.sin(p.a) * p.rr * w * .9 * .42;
        const f = .5 + .5 * Math.sin(t * 2 - p.a * 3);
        ctx.beginPath(); ctx.arc(x, y, 1.4 + f, 0, Math.PI * 2);
        ctx.fillStyle = f > .92 ? C.acc : `rgba(236,235,230,${.25 + f * .3})`; ctx.fill();
      });
      void pr;
    },
  });
}

/* =========================================================
   8. Contour sheet — slow topographic texture (decor)
========================================================= */
function contoursBg(canvas, o = {}) {
  const GX = 90, GY = 50, seed = o.seed || 3;
  const nzz = createNoise2D(rng(seed));
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st;
      const vals = new Float64Array(GX * GY);
      for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) { let a = 0, f = 1, s = .5; for (let k = 0; k < 4; k++) { a += s * nzz(i / 30 * f + t * .02, j / 30 * f); f *= 2; s *= .5; } vals[j * GX + i] = a; }
      const iso = contours().size([GX, GY]).thresholds(18)(Array.from(vals));
      ctx.clearRect(0, 0, w, h);
      ctx.save(); ctx.scale(w / (GX - 1), h / (GY - 1));
      const path = geoPath(null, ctx);
      iso.forEach((c, i) => { ctx.beginPath(); path(c); ctx.lineWidth = (GX - 1) / w; ctx.strokeStyle = `rgba(236,235,230,${(i % 4 === 0 ? .12 : .05) * (o.a || 1)})`; ctx.stroke(); });
      ctx.restore();
    },
  });
}


/* =========================================================
   9. Target map — plan view of a horizon, ranked targets.
========================================================= */
function targets(canvas, o = {}) {
  const GX = 160, GY = 90, nzz = createNoise2D(rng(o.seed || 17));
  const field = new Float64Array(GX * GY);
  const T = o.targets || [{ x: .58, y: .42, r: .07, n: 'T1', c: 92, d: '1.9 km' }, { x: .76, y: .66, r: .05, n: 'T2', c: 78, d: '2.3 km' }, { x: .4, y: .7, r: .04, n: 'T3', c: 61, d: '2.8 km' }];
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    let a = 0, f = 1, sc = .5; for (let k = 0; k < 5; k++) { a += sc * nzz(i / 50 * f, j / 50 * f); f *= 2; sc *= .5; }
    T.forEach(t => { const dx = i / GX - t.x, dy = (j / GY - t.y) * GY / GX; a += .9 * Math.exp(-(dx * dx + dy * dy) / (t.r * t.r)); });
    field[j * GX + i] = a;
  }
  const iso = contours().size([GX, GY]).thresholds(26)(Array.from(field));
  let bg;
  return canvasViz(canvas, {
    setup(ctx, st) {
      bg = document.createElement('canvas'); bg.width = st.w * st.dpr; bg.height = st.h * st.dpr;
      const b = bg.getContext('2d'); b.scale(st.dpr, st.dpr);
      b.save(); b.scale(st.w / (GX - 1), st.h / (GY - 1)); const path = geoPath(null, b);
      const lo = iso[0].value, hi = iso[iso.length - 1].value;
      iso.forEach((c, i) => {
        const v = (c.value - lo) / (hi - lo); const col = VEL(.12 + v * .8);
        b.beginPath(); path(c); b.fillStyle = `rgba(${col.map(Math.round).join(',')},${.04 + v * .1})`; b.fill();
        b.lineWidth = (GX - 1) / st.w * (i % 4 ? .6 : 1.1); b.strokeStyle = `rgba(236,235,230,${(i % 4 ? .1 : .26) * (.5 + v * .7)})`; b.stroke();
      });
      b.restore();
    },
    draw(ctx, st) {
      const { w, h, t } = st;
      ctx.clearRect(0, 0, w, h); ctx.drawImage(bg, 0, 0, w, h);
      const sx = ((t * .08) % 1.2) * w;
      const g = ctx.createLinearGradient(sx - 120, 0, sx, 0); g.addColorStop(0, 'rgba(255,90,31,0)'); g.addColorStop(1, 'rgba(255,90,31,.12)');
      ctx.fillStyle = g; ctx.fillRect(sx - 120, 0, 120, h); ctx.fillStyle = 'rgba(255,90,31,.6)'; ctx.fillRect(sx, 0, 1, h);
      T.forEach((tg, i) => {
        const x = tg.x * w, y = tg.y * h, r = tg.r * w;
        const pul = .5 + .5 * Math.sin(t * 2 + i);
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r * .9, -.3, 0, Math.PI * 2); ctx.strokeStyle = i ? 'rgba(236,235,230,.6)' : C.acc; ctx.lineWidth = 1.2; ctx.setLineDash(i ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
        if (!i) { ctx.beginPath(); ctx.ellipse(x, y, r * (1.35 + pul * .2), r * (1.05 + pul * .15), -.3, 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,90,31,${.3 * (1 - pul)})`; ctx.stroke(); }
        ctx.strokeStyle = i ? C.fg : C.acc; ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
        const lx = x + r * 1.3 + 10, ly = y - r * .9;
        ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(x + r * .9, y - r * .5); ctx.lineTo(lx - 4, ly); ctx.stroke();
        label(ctx, `${tg.n} · ${tg.c}% conf.`, lx, ly - 7, i ? C.fg : C.acc); label(ctx, `top at ${tg.d}`, lx, ly + 7, C.dim);
      });
      if (o.legend !== false) label(ctx, 'depth to target horizon · plan view', 16, h - 16, C.dim);
    },
  });
}

/* =========================================================
   10. Holes — grid drilling vs drilling from a model.
========================================================= */
function holes(canvas) {
  const RW = 300, RH = 140;
  const img = (() => { const c = document.createElement('canvas'); c.width = RW; c.height = RH; const x = c.getContext('2d'); const im = x.createImageData(RW, RH); for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) { const g = geo(i / RW, j / RH * .95 + .05); const col = g.ore > 0 ? hex(C.acc) : LITH[g.k]; const sh = .7 + .2 * fbm(i / 10, j / 10, 2); const p = (j * RW + i) * 4; im.data[p] = col[0] * sh; im.data[p + 1] = col[1] * sh; im.data[p + 2] = col[2] * sh; im.data[p + 3] = 255; } x.putImageData(im, 0, 0); return c; })();
  const grid = Array.from({ length: 24 }, (_, i) => .02 + i * .041);
  const aimed = [ORE.x - .05, ORE.x + .01, ORE.x + .06, .8];
  const hit = x => { for (let z = .0; z < .95; z += .005) if (geo(x, z * .95 + .05).ore > 0) return z; return -1; };
  const PAD = { l: 8, r: 8, t: 40, b: 10 };
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st, W = w - PAD.l - PAD.r, H = h - PAD.t - PAD.b;
      const per = 7, mode = Math.floor(t / per) % 2, ph = st.running ? (t % per) / per : .99;
      const xs = mode ? aimed : grid;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = mode ? .95 : .5; ctx.drawImage(img, PAD.l, PAD.t, W, H); ctx.globalAlpha = 1;
      let hits = 0, drawn = 0;
      xs.forEach((x, i) => {
        const p = clamp((ph * 1.6 - i / xs.length * .6) / .35); if (p <= 0) return; drawn++;
        const hz = hit(x), end = hz > 0 ? hz : .78 + .1 * Math.sin(i * 3);
        const zz = end * sstep(0, 1, p);
        const cx = PAD.l + x * W;
        ctx.strokeStyle = hz > 0 ? C.acc : 'rgba(236,235,230,.55)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(cx, PAD.t - 8); ctx.lineTo(cx, PAD.t + zz * H); ctx.stroke();
        ctx.fillStyle = C.fg; ctx.fillRect(cx - 3, PAD.t - 12, 6, 4);
        if (p >= 1) {
          const y = PAD.t + zz * H;
          if (hz > 0) { hits++; ctx.beginPath(); ctx.arc(cx, y, 4, 0, Math.PI * 2); ctx.fillStyle = C.acc; ctx.fill(); }
          else { ctx.strokeStyle = 'rgba(236,235,230,.5)'; ctx.beginPath(); ctx.moveTo(cx - 3, y - 3); ctx.lineTo(cx + 3, y + 3); ctx.moveTo(cx + 3, y - 3); ctx.lineTo(cx - 3, y + 3); ctx.stroke(); }
        }
      });
      label(ctx, mode ? 'drilling from a df‑7 model' : 'grid drilling, no model', PAD.l, 14, mode ? C.acc : C.mut);
      label(ctx, `${drawn} holes · ${hits} hits`, PAD.l + W, 14, C.fg, 'right');
    },
  });
}

/* =========================================================
   11. Area — the client's polygon on contours.
========================================================= */
function area(canvas) {
  const GX = 60, GY = 40, nzz = createNoise2D(rng(31));
  const vals = []; for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) vals.push(nzz(i / 18, j / 18) + .5 * nzz(i / 7, j / 7));
  const iso = contours().size([GX, GY]).thresholds(14)(vals);
  const poly = [[.22, .3], [.62, .18], [.8, .48], [.66, .82], [.3, .74]];
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st;
      ctx.clearRect(0, 0, w, h);
      ctx.save(); ctx.scale(w / (GX - 1), h / (GY - 1)); const path = geoPath(null, ctx);
      iso.forEach((c, i) => { ctx.beginPath(); path(c); ctx.lineWidth = (GX - 1) / w; ctx.strokeStyle = `rgba(236,235,230,${i % 4 ? .07 : .16})`; ctx.stroke(); }); ctx.restore();
      ctx.beginPath(); poly.forEach(([x, y], i) => i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)); ctx.closePath();
      ctx.fillStyle = 'rgba(255,90,31,.08)'; ctx.fill(); ctx.setLineDash([5, 4]); ctx.lineDashOffset = -t * 12; ctx.strokeStyle = C.acc; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
      poly.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x * w, y * h, 3, 0, Math.PI * 2); ctx.fillStyle = C.fg; ctx.fill(); });
      label(ctx, '−23.65, −70.40', poly[0][0] * w - 4, poly[0][1] * h - 14, C.mut);
      label(ctx, '120 km² · target 3 km', w * .52, h * .5, C.fg, 'center');
    },
  });
}

/* =========================================================
   12. Core log — a drilled column that grows with scroll.
========================================================= */
function corelog(canvas, o = {}) {
  const marks = o.marks || [];
  const inst = canvasViz(canvas, {
    animated: false,
    draw(ctx, st) {
      const { w, h } = st, p = inst ? inst.p : 0;
      ctx.clearRect(0, 0, w, h);
      const cw = Math.min(58, w * .3), cx = w - cw - 6, top = 10, H = h - 20;
      ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.strokeRect(cx - .5, top - .5, cw + 1, H + 1);
      const fill = H * p;
      for (let y = 0; y < fill; y += 2) {
        const z = y / H, k = Math.max(0, Math.min(6, Math.floor(z * 6.5 + .5 * fbm(z * 4, 1.3))));
        const col = LITH[k], sh = .8 + .35 * fbm(z * 40, 2, 3);
        ctx.fillStyle = `rgb(${col.map(c => Math.min(255, c * sh * 1.35) | 0).join(',')})`;
        ctx.fillRect(cx, top + y, cw, 2);
        if (Math.abs(z - .62) < .022) { ctx.fillStyle = 'rgba(255,90,31,.85)'; ctx.fillRect(cx, top + y, cw, 2); }
      }
      ctx.fillStyle = C.acc; ctx.fillRect(cx - 5, top + fill - 1, cw + 10, 2);
      marks.forEach(m => {
        const y = top + m.at * H, on = p >= m.at - .005;
        ctx.strokeStyle = on ? C.fg : C.line2; ctx.beginPath(); ctx.moveTo(cx - 14, y); ctx.lineTo(cx - 4, y); ctx.stroke();
        label(ctx, m.label, cx - 20, y, on ? C.fg : C.dim, 'right');
      });
    },
  });
  inst.p = 0;
  inst.setProgress = v => { inst.p = clamp(v); inst._draw(); };
  return inst;
}

/* =========================================================
   13. Portrait — a seeded topographic "fingerprint".
========================================================= */
function portrait(canvas, o = {}) {
  const GX = 70, GY = 88, nzz = createNoise2D(rng(o.seed || 1));
  const vals = []; for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) { const dx = (i - GX * .5) / GX, dy = (j - GY * .42) / GY; vals.push(-Math.hypot(dx * 1.1, dy) * 4.2 + .38 * nzz(i / 22, j / 22) + .06 * nzz(i / 9, j / 9)); }
  const iso = contours().size([GX, GY]).thresholds(16)(vals);
  return canvasViz(canvas, {
    draw(ctx, st) {
      const { w, h, t } = st;
      ctx.fillStyle = '#08090b'; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.scale(w / (GX - 1), h / (GY - 1)); const path = geoPath(null, ctx);
      const hot = Math.floor((t * 3) % iso.length);
      iso.forEach((c, i) => { ctx.beginPath(); path(c); ctx.lineWidth = (GX - 1) / w * .9; ctx.strokeStyle = i === hot && st.running ? 'rgba(255,90,31,.85)' : `rgba(236,235,230,${.07 + i / iso.length * .34})`; ctx.stroke(); });
      ctx.restore();
      label(ctx, o.code || '', 14, h - 16, C.dim);
    },
  });
}

export const VIZ = { gather, spectrum, section, footprint, cores, dotmap, rings, contours: contoursBg, targets, holes, area, corelog, portrait };
