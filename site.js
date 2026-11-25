// Deepfield — shared shell for inner pages: nav, menu, footer, smooth scroll,
// reveals, counters and lazy visual mounting.
import Lenis from 'lenis';
import { VIZ } from './viz.js';

const gsap = window.gsap, ScrollTrigger = window.ScrollTrigger;
gsap.registerPlugin(ScrollTrigger);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const ARROW = '<svg viewBox="0 0 16 16"><path d="M4 12 12 4M6 4h6v6"/></svg>';
const LOGO = `<svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
  <circle cx="14" cy="14" r="12.5" fill="none" stroke="currentColor" stroke-width="1" opacity=".35"/>
  <circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" stroke-width="1" opacity=".6"/>
  <circle cx="14" cy="14" r="3.4" fill="none" stroke="currentColor" stroke-width="1"/>
  <circle cx="14" cy="14" r="1.3" fill="#ff5a1f"/></svg>`;
const PAGES = [
  ['technology.html', 'Technology'],
  ['solutions.html', 'Solutions'],
  ['company.html', 'Company'],
  ['contacts.html', 'Contacts'],
];
export const CTA = (label = 'Get early access', cls = '') =>
  `<a class="btn ${cls}" href="access.html"><span>${label}</span><i class="btn__ic">${ARROW}</i></a>`;

function shell() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = PAGES.map(([h, t]) => `<a href="${h}"${h === here ? ' aria-current="page"' : ''}>${t}</a>`).join('');
  document.body.insertAdjacentHTML('afterbegin', `
  <header class="nav" id="nav">
    <a class="logo" href="index.html" aria-label="Deepfield home">${LOGO}<span>deepfield</span></a>
    <nav class="nav__pill mono" aria-label="Main">${links}<a class="sim" href="simulator.html">Simulator ↗</a></nav>
    ${CTA('Get early access', 'btn--glass btn--sm')}
    <button class="nav__burger" aria-label="Menu" aria-expanded="false"><i></i><i></i></button>
  </header>
  <div class="menu" id="menu">${PAGES.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}<a href="simulator.html">Simulator ↗</a>${CTA()}</div>`);

  const ftr = document.querySelector('footer.ftr');
  if (ftr) ftr.innerHTML = `
  <div class="wrap">
    <div class="g">
      <div style="--s:5" class="ftr__lead">
        <a class="logo" href="index.html">${LOGO}<span>deepfield</span></a>
        <p class="body" style="margin:22px 0 28px">Acoustic tomography that shows what is under the site before you drill, build or inject.</p>
        ${CTA()}
      </div>
      <div style="--s:2;grid-column:7/span 2"><span class="ftr__h mono">Product</span><ul><li><a href="technology.html">Technology</a></li><li><a href="solutions.html">Solutions</a></li><li><a href="simulator.html">Simulator</a></li></ul></div>
      <div style="--s:2"><span class="ftr__h mono">Company</span><ul><li><a href="company.html">About</a></li><li><a href="company.html#careers">Careers</a></li><li><a href="contacts.html">Contacts</a></li></ul></div>
      <div style="--s:2"><span class="ftr__h mono">Resources</span><ul><li><a href="#">Validation report</a></li><li><a href="#">Press kit</a></li><li><a href="#">Privacy</a></li></ul></div>
    </div>
    <div class="ftr__mark" aria-hidden="true">deepfield</div>
    <div class="ftr__base mono"><span>© 2026 Deepfield Systems</span><span>Acoustic tomography · FWI · Point volumes</span><span>Kyiv · Oslo · Antofagasta</span></div>
  </div>`;

  const burger = document.querySelector('.nav__burger');
  burger.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    burger.setAttribute('aria-expanded', open);
  });
}

function splitLines() {
  document.querySelectorAll('.split').forEach(el => {
    if (el.dataset.done) return;
    el.dataset.done = 1;
    el.innerHTML = el.innerHTML.split(/<br\s*\/?>/i).map(l => `<span class="ln"><span>${l.trim()}</span></span>`).join('');
  });
}

function reveals() {
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -12% 0px' });
  document.querySelectorAll('.split, .rv').forEach(el => {
    if (el.getBoundingClientRect().top < innerHeight) requestAnimationFrame(() => el.classList.add('is-in'));
    else io.observe(el);
  });
}

function counters() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const to = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0);
    const fmt = v => v.toFixed(dec);
    if (REDUCED) { el.textContent = fmt(to); return; }
    el.textContent = fmt(0);
    ScrollTrigger.create({
      trigger: el, start: 'top 88%', once: true,
      onEnter: () => { const o = { v: 0 }; gsap.to(o, { v: to, duration: 2, ease: 'power3.out', onUpdate: () => el.textContent = fmt(o.v) }); },
    });
  });
}

// mount canvas/svg generators lazily; animated ones only tick while visible
function mountViz() {
  const io = new IntersectionObserver(es => es.forEach(e => {
    const inst = e.target.__viz;
    if (!inst) return;
    if (e.isIntersecting) inst.start?.(); else inst.stop?.();
  }), { rootMargin: '200px' });
  document.querySelectorAll('[data-viz]').forEach(el => {
    const fn = VIZ[el.dataset.viz];
    if (!fn) return console.warn('no viz', el.dataset.viz);
    const opts = el.dataset.o ? JSON.parse(el.dataset.o) : {};
    Promise.resolve(fn(el, opts)).then(inst => { el.__viz = inst || {}; io.observe(el); });
  });
}

function smooth() {
  if (REDUCED) return null;
  const lenis = new Lenis({ duration: 1.15, easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)) });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(t => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const t = document.querySelector(a.getAttribute('href'));
    if (t) { e.preventDefault(); lenis.scrollTo(t, { offset: -80 }); }
  }));
  return lenis;
}

function navAutoHide() {
  const nav = document.getElementById('nav');
  let last = 0;
  ScrollTrigger.create({
    start: 0, end: 'max',
    onUpdate: s => {
      const y = s.scroll();
      nav.classList.toggle('is-hidden', y > 400 && y > last && !document.body.classList.contains('menu-open'));
      last = y;
    },
  });
}

// fixed depth gauge on the right edge: the page is read as a descent
function depthGauge(maxKm = 5) {
  if (document.body.dataset.gauge === 'off') return;
  document.body.insertAdjacentHTML('beforeend', `
  <div class="gauge" aria-hidden="true"><i class="gauge__line"></i>
    ${[0, 1, 2, 3, 4, 5].map(k => `<i class="gauge__tick" style="top:${k / 5 * 100}%"><b class="mono">${k}</b></i>`).join('')}
    <div class="gauge__m"><i></i><span class="mono">0.00 km</span></div></div>`);
  const m = document.querySelector('.gauge__m'), s = m.querySelector('span'); let idle;
  ScrollTrigger.create({ start: 0, end: 'max', onUpdate: st => { const p = st.progress; m.style.top = (p * 100) + '%'; s.textContent = (p * maxKm).toFixed(2) + ' km'; m.classList.add('mv'); clearTimeout(idle); idle = setTimeout(() => m.classList.remove('mv'), 1100); } });
}

export function boot() {
  shell();
  depthGauge();
  splitLines();
  const lenis = smooth();
  reveals();
  counters();
  mountViz();
  navAutoHide();
  window.addEventListener('load', () => ScrollTrigger.refresh());
  return { gsap, ScrollTrigger, lenis, REDUCED };
}
