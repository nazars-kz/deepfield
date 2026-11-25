// Prospectivity model inputs for the simulator.
// Provinces are well-known metallogenic regions (centre, influence radius in km, relative likelihood 0–1 per commodity).
// Locations follow published deposit/province locations (e.g. USGS global porphyry copper database, USGS Mineral
// Commodity Summaries). Weights are a simplified, illustrative model — not a resource estimate.

export const PRICE_NOTE = 'Indicative 2025 prices · in‑situ value, before recovery and costs';

const OZ = 31.1035;
export const COMMODITIES = {
  cu: { name: 'Copper', sym: 'Cu', color: '#ff7a3d', mineral: 'Chalcopyrite · CuFeS₂', grade: [0.3, 0.9], gUnit: '% Cu', ore: [120, 2500], depth: [250, 2600], types: ['Porphyry Cu–Mo', 'IOCG', 'Sediment‑hosted Cu'], price: '$9,500/t',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't Cu', value: c * 9500 }; } },
  au: { name: 'Gold', sym: 'Au', color: '#ffd166', mineral: 'Native gold · Au', grade: [0.8, 7.5], gUnit: 'g/t Au', ore: [5, 250], depth: [80, 2200], types: ['Orogenic', 'Epithermal', 'Carlin‑type'], price: '$3,000/oz',
    calc: (t, g) => { const oz = (t * g) / OZ; return { contained: oz, cUnit: 'oz Au', value: oz * 3000 }; } },
  li: { name: 'Lithium', sym: 'Li', color: '#6fe2ff', mineral: 'Spodumene · LiAlSi₂O₆', grade: [0.8, 1.7], gUnit: '% Li₂O', ore: [10, 160], depth: [0, 650], types: ['Pegmatite (spodumene)', 'Salar brine', 'Clay‑hosted'], price: '$12,000/t LCE',
    calc: (t, g) => { const lce = t * g / 100 * 2.473; return { contained: lce, cUnit: 't LCE', value: lce * 12000 }; } },
  ree: { name: 'Rare earths', sym: 'REE', color: '#b9a2ff', mineral: 'Bastnäsite · (Ce,La)CO₃F', grade: [1, 6], gUnit: '% TREO', ore: [5, 90], depth: [0, 900], types: ['Carbonatite', 'Ionic clay', 'Alkaline intrusion'], price: '$8,000/t TREO',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't TREO', value: c * 8000 }; } },
  ni: { name: 'Nickel', sym: 'Ni', color: '#8dffb0', mineral: 'Pentlandite · (Fe,Ni)₉S₈', grade: [0.5, 2.4], gUnit: '% Ni', ore: [10, 300], depth: [0, 1800], types: ['Magmatic sulphide', 'Laterite'], price: '$16,000/t',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't Ni', value: c * 16000 }; } },
  fe: { name: 'Iron ore', sym: 'Fe', color: '#d0715a', mineral: 'Hematite · Fe₂O₃', grade: [35, 64], gUnit: '% Fe', ore: [200, 3000], depth: [0, 800], types: ['Banded iron formation', 'Magnetite skarn'], price: '$100/t (62% Fe)',
    calc: (t, g) => ({ contained: t, cUnit: 't ore', value: t * 100 * (g / 62) }) },
  zn: { name: 'Zinc–lead', sym: 'Zn', color: '#9fb4c7', mineral: 'Sphalerite · ZnS / galena', grade: [3, 12], gUnit: '% Zn+Pb', ore: [10, 160], depth: [100, 1500], types: ['SEDEX', 'MVT', 'VMS'], price: '$2,700/t',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't Zn+Pb', value: c * 2700 }; } },
  u: { name: 'Uranium', sym: 'U', color: '#d7ff5e', mineral: 'Uraninite · UO₂', grade: [0.05, 2], gUnit: '% U₃O₈', ore: [0.5, 30], depth: [80, 900], types: ['Unconformity', 'Sandstone roll‑front', 'IOCG by‑product'], price: '$70/lb U₃O₈',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't U₃O₈', value: c * 2204.62 * 70 }; } },
  pgm: { name: 'Platinum group', sym: 'PGM', color: '#e6e9ef', mineral: 'Cooperite · PtS', grade: [2, 7], gUnit: 'g/t 4E', ore: [40, 500], depth: [200, 2400], types: ['Layered intrusion reef', 'Magmatic sulphide'], price: '$1,200/oz',
    calc: (t, g) => { const oz = (t * g) / OZ; return { contained: oz, cUnit: 'oz 4E', value: oz * 1200 }; } },
  co: { name: 'Cobalt', sym: 'Co', color: '#4f8cff', mineral: 'Carrollite · CuCo₂S₄', grade: [0.1, 0.5], gUnit: '% Co', ore: [10, 200], depth: [40, 900], types: ['Sediment‑hosted Cu–Co', 'Laterite'], price: '$30,000/t',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't Co', value: c * 30000 }; } },
  sn: { name: 'Tin', sym: 'Sn', color: '#c9c3b0', mineral: 'Cassiterite · SnO₂', grade: [0.2, 1.0], gUnit: '% Sn', ore: [3, 60], depth: [0, 500], types: ['Greisen', 'Placer'], price: '$30,000/t',
    calc: (t, g) => { const c = t * g / 100; return { contained: c, cUnit: 't Sn', value: c * 30000 }; } },
};

// [name, lat, lon, radiusKm, weights]
export const PROVINCES = [
  // South America
  ['Central Andean porphyry belt', -22.5, -69.0, 650, { cu: 0.6, au: 0.2, co: 0.05 }],
  ['Lithium Triangle (salars)', -23.5, -67.4, 330, { li: 0.65, cu: 0.1 }],
  ['Peruvian porphyry–skarn belt', -13.0, -74.0, 600, { cu: 0.45, zn: 0.35, au: 0.25 }],
  ['El Teniente–Río Blanco', -33.6, -70.4, 260, { cu: 0.55, au: 0.1 }],
  ['Carajás mineral province', -6.0, -50.5, 300, { fe: 0.75, cu: 0.35, au: 0.2, ni: 0.2 }],
  ['Quadrilátero Ferrífero', -20.1, -43.7, 200, { fe: 0.65, au: 0.3 }],
  ['Guiana Shield gold', 5.0, -57.0, 600, { au: 0.35 }],
  // North America
  ['Arizona porphyry district', 33.0, -111.2, 420, { cu: 0.5, au: 0.08 }],
  ['Bingham Canyon', 40.5, -112.1, 150, { cu: 0.6, au: 0.25 }],
  ['Carlin trend & Great Basin', 40.6, -116.4, 330, { au: 0.55, li: 0.25 }],
  ['Mountain Pass', 35.5, -115.5, 120, { ree: 0.5 }],
  ['British Columbia porphyry belt', 55.0, -127.0, 520, { cu: 0.35, au: 0.3 }],
  ['Abitibi greenstone belt', 48.3, -79.0, 360, { au: 0.55, zn: 0.3, cu: 0.2 }],
  ['Sudbury Basin', 46.6, -81.1, 120, { ni: 0.7, cu: 0.4, pgm: 0.4, co: 0.2 }],
  ['Athabasca Basin', 58.0, -105.5, 260, { u: 0.65 }],
  ["Voisey's Bay", 56.3, -62.1, 150, { ni: 0.5, co: 0.25, cu: 0.2 }],
  ['Sierra Madre silver–gold belt', 25.0, -105.5, 600, { au: 0.3, zn: 0.3 }],
  // Africa
  ['Witwatersrand Basin', -26.6, 27.3, 260, { au: 0.6, u: 0.3 }],
  ['Bushveld Complex', -25.0, 29.3, 260, { pgm: 0.7, ni: 0.2, fe: 0.2 }],
  ['Central African Copperbelt', -11.6, 27.2, 420, { cu: 0.65, co: 0.55 }],
  ['Birimian gold belt', 8.0, -2.0, 900, { au: 0.45 }],
  ['Simandou range', 8.6, -8.9, 250, { fe: 0.55 }],
  ['Erongo uranium province', -22.5, 15.0, 300, { u: 0.45 }],
  ['Great Dyke & Bikita pegmatites', -18.5, 30.5, 380, { pgm: 0.4, li: 0.35, au: 0.25 }],
  ['Kibaran tin belt', -2.0, 29.0, 350, { sn: 0.4, au: 0.15 }],
  // Europe
  ['Kryvbas iron basin', 47.9, 33.4, 190, { fe: 0.75 }],
  ['Ukrainian Shield pegmatites', 48.0, 33.5, 330, { li: 0.25, ree: 0.12, au: 0.1 }],
  ['Norrbotten (Kiruna–Aitik)', 67.6, 20.6, 300, { fe: 0.6, cu: 0.3, au: 0.2 }],
  ['Fennoscandian nickel belt', 63.5, 27.5, 260, { ni: 0.35, co: 0.15 }],
  ['Iberian Pyrite Belt', 37.6, -7.0, 200, { zn: 0.5, cu: 0.4 }],
  ['Kupferschiefer', 51.4, 16.1, 200, { cu: 0.5 }],
  ['Erzgebirge Sn–Li', 50.6, 13.0, 150, { sn: 0.4, li: 0.3 }],
  ['Ilímaussaq / Kvanefjeld', 60.9, -45.9, 200, { ree: 0.55, u: 0.3 }],
  ['Urals', 58.0, 59.5, 900, { cu: 0.3, au: 0.3, pgm: 0.2, fe: 0.3 }],
  // Asia
  ['Norilsk–Talnakh', 69.4, 88.2, 250, { ni: 0.7, cu: 0.5, pgm: 0.6, co: 0.2 }],
  ['Bayan Obo', 41.8, 109.9, 200, { ree: 0.8, fe: 0.5 }],
  ['South China ionic clays', 25.0, 115.0, 600, { ree: 0.4, sn: 0.25 }],
  ['Gejiu tin district', 23.3, 103.2, 250, { sn: 0.5, cu: 0.15 }],
  ['Oyu Tolgoi', 43.0, 106.9, 300, { cu: 0.55, au: 0.3 }],
  ['Chu‑Sarysu uranium basin', 44.5, 68.0, 550, { u: 0.55 }],
  ['Kazakh copper belt', 47.0, 74.5, 500, { cu: 0.35, zn: 0.2 }],
  ['Kerman copper belt', 30.0, 56.0, 400, { cu: 0.4 }],
  ['Gangdese porphyry belt', 29.6, 90.5, 480, { cu: 0.4, au: 0.15 }],
  ['Grasberg district', -4.05, 137.1, 230, { cu: 0.6, au: 0.55 }],
  ['Philippine arc', 13.0, 122.0, 700, { cu: 0.35, au: 0.3, ni: 0.3 }],
  ['Sulawesi–Halmahera laterites', -2.5, 121.8, 500, { ni: 0.6, co: 0.3 }],
  ['Southeast Asian tin belt', 2.0, 104.0, 700, { sn: 0.5 }],
  ['Singhbhum–Bailadila iron', 21.0, 84.0, 450, { fe: 0.55, cu: 0.15 }],
  ['Kolyma–Yakutia gold', 62.0, 140.0, 900, { au: 0.4 }],
  ['Kyushu epithermal belt', 32.0, 130.6, 250, { au: 0.35 }],
  // Oceania
  ['Pilbara craton', -21.6, 118.6, 450, { fe: 0.75, li: 0.45, au: 0.2 }],
  ['Yilgarn craton', -30.5, 121.5, 600, { au: 0.55, ni: 0.45, li: 0.3 }],
  ['Greenbushes', -33.9, 116.1, 140, { li: 0.75, sn: 0.2 }],
  ['Mount Weld', -28.9, 122.5, 120, { ree: 0.5 }],
  ['Gawler craton (Olympic Dam)', -30.4, 136.9, 260, { cu: 0.55, u: 0.55, au: 0.3 }],
  ['Mount Isa inlier', -20.7, 139.5, 300, { zn: 0.55, cu: 0.4 }],
  ['Broken Hill', -31.95, 141.45, 150, { zn: 0.5 }],
  ['New Caledonia', -21.5, 165.5, 250, { ni: 0.6, co: 0.3 }],
  ['Papua New Guinea arc', -6.0, 145.0, 500, { au: 0.4, cu: 0.4 }],
];

export const PRESETS = [
  { name: 'Atacama', note: 'Porphyry Cu', lat: -22.9, lon: -69.3 },
  { name: 'Pilbara', note: 'Fe · Li', lat: -21.0, lon: 118.9 },
  { name: 'Sudbury', note: 'Ni · PGM', lat: 46.6, lon: -81.2 },
  { name: 'Copperbelt', note: 'Cu · Co', lat: -12.4, lon: 27.6 },
  { name: 'Bayan Obo', note: 'REE', lat: 41.78, lon: 109.97 },
  { name: 'Kryvbas', note: 'Iron', lat: 47.9, lon: 33.4 },
  { name: 'Iceland', note: 'Rift · volcanoes', lat: 64.0, lon: -19.0 },
  { name: 'Sahara', note: 'Quiet craton', lat: 23.0, lon: 12.0 },
];

export const CLASS_INFO = [
  { code: 'SUB', name: 'Subduction zone', color: '#ff5a1f', w: 1.0, vel: 'convergent', desc: 'One plate dives beneath another. Hosts the largest (megathrust) earthquakes, arc volcanism and tsunami risk.' },
  { code: 'OSR', name: 'Oceanic spreading ridge', color: '#5fd4ff', w: 0.4, vel: 'divergent', desc: 'Plates pull apart and new crust forms. Frequent shallow, moderate earthquakes and basaltic volcanism.' },
  { code: 'OTF', name: 'Oceanic transform fault', color: '#ffd166', w: 0.5, vel: 'transform', desc: 'Plates slide past each other along the seafloor. Shallow strike‑slip earthquakes.' },
  { code: 'CTF', name: 'Continental transform fault', color: '#ffb347', w: 0.85, vel: 'transform', desc: 'Strike‑slip boundary on land (e.g. San Andreas, North Anatolian). Large shallow earthquakes near populated areas.' },
  { code: 'CRB', name: 'Continental rift', color: '#c38bff', w: 0.6, vel: 'divergent', desc: 'A continent stretching apart. Normal faulting, moderate earthquakes and volcanism.' },
  { code: 'CCB', name: 'Continental collision', color: '#ff7f6b', w: 0.9, vel: 'convergent', desc: 'Two continents collide and build mountains (e.g. Himalaya). Broad zones of strong earthquakes.' },
  { code: 'OCB', name: 'Oceanic convergent boundary', color: '#ff9a6b', w: 0.8, vel: 'convergent', desc: 'Convergence within oceanic lithosphere. Thrust earthquakes and island‑arc activity.' },
];
