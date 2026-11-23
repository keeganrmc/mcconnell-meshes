// Real places on a Terrainer's sidewall: MASQ's baked heightfields (34 places,
// lift/masq/terrain.js, assets/terrain/*.hgt.bin — 256² uint16 quantised over
// [elevMinM, elevMaxM], row 0 north) read through the sole's relief contract,
// sample(u, v) → 0..1, u round the footprint (periodic), v up the sidewall
// (ground.mjs: v = h / stack, relief full at the floor and gone by `top`).
//
// The chart. 'wrap' lays the raster's full width round the footprint once,
// seam at the heel (u = 0); v spans `scale` raster heights centred on the
// place (1 = the whole place, floor to rim), and `bearingDeg` is the compass
// direction that points up the sidewall (0 = north at the rim). 'strip'
// repeats the raster `scale` times round u, one raster height up v.
//
// The seam. A raster is not periodic: its west and east edges are two
// different valleys. Over a band of SEAM_W of u centred on the heel the value
// is a smoothstep crossfade between the east edge running on (mirrored past
// the raster's edge) and the west edge running in, so u = 0 equals u = 1 and
// the slope is continuous. The place appears once; the cost is ±SEAM_W/2 of
// the footprint at the heel being a blend of its two ends.
//
// The band is baked once per (place, mode, bearing, scale) into a BAND_W ×
// BAND_H grid over (u, v), box-prefiltered over each cell's raster footprint
// (a whole place in 30 mm of sidewall is a 20× vertical squash: a ring of the
// loft integrates ~10 raster rows, and an unfiltered read aliases), then
// low-passed in v to the loft's ring pitch (a Gaussian from BAND_SIGMA_V rows
// of BAND_H ≈ 0.75 of a ring at 24 rings, grown ×1.3 until no adjacent step
// of the default chart exceeds MAX_STEP), and normalised to 0..1 by its own
// min and max so a place fills the app's relief amplitude. Measured on the
// 246 × 24 chart, the raster's own steps in u are ≤ 0.16 of the range, so u
// starts unfiltered (tools/verify/terrain_2026-09-19.mjs).
//
// True scale: the sole displaces ±amp (ground.mjs), a span of 2·amp, standing
// for the band's real height span; trueScaleMultiple(amp) = spanM · 1000 /
// (2 · amp) — how many times larger than the sole the place is.

import { TERRAIN_PLACES as MASQ_PLACES, TERRAIN_FAMILIES as MASQ_FAMILIES, TERRAIN_ATTRIBUTION, GRID, sampleBilinear } from '../lift/masq/terrain.js';

export { TERRAIN_ATTRIBUTION, GRID };
export const TERRAIN_BASE = './assets/terrain/';
export const TERRAIN_FAMILIES = MASQ_FAMILIES.slice();

export const SEAM_W = 0.08;         // of u, centred on the heel
export const BAND_W = 512, BAND_H = 96;
export const BAND_SIGMA_V = 3;      // rows of BAND_H, the starting low-pass up the sidewall
export const MAX_STEP = 0.35;       // of the band's range, between adjacent samples of the default chart
export const CHART_KC = 246, CHART_RINGS = 24;  // the default chart: a US 12.5 footprint at 2.5 mm, GROUND_DEFAULTS.rings

// the dataset named in a place's region → its line of the source attribution
const DATASET_LINE = [
  ['EU-DEM', 'Europe terrain data'], ['3DEP', 'United States 3DEP'], ['SRTM', 'United States 3DEP'], ['GMTED2010', 'United States 3DEP'],
  ['Canada OGL', 'Canada terrain data'], ['UK EA', 'United Kingdom terrain data'],
];
function attributionFor(region) {
  for (const [tag, head] of DATASET_LINE) if (region.includes(tag)) return TERRAIN_ATTRIBUTION.find((l) => l.startsWith(head));
  return TERRAIN_ATTRIBUTION[0];
}

// key, label, family, region, wKm, attribution; reliefM / elevMinM / elevMaxM
// / metresPerSample / zoomMax are filled from the manifest when it loads
// (null before; zoomMax is the terrain texture's Zoom ceiling)
export const TERRAIN_PLACES = MASQ_PLACES.map((p) => ({
  key: p.key, label: p.label, family: p.family, region: p.region, wKm: p.wKm, lat: p.lat, lon: p.lon,
  attribution: attributionFor(p.region), reliefM: null, elevMinM: null, elevMaxM: null, metresPerSample: null, zoomMax: null,
}));
export const terrainPlace = (key) => TERRAIN_PLACES.find((p) => p.key === key) || null;

// ── loading ──────────────────────────────────────────────────────────────
// io: { fetch } (browser) or { readFile } (node, readFileSync-shaped: path → bytes); base = the assets/terrain/ directory
function readerFrom(io = {}) {
  const base = io.base || TERRAIN_BASE;
  if (io.readFile) return (name) => Promise.resolve(io.readFile(base + name));
  const f = io.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('terrain: no fetch and no readFile');
  return async (name) => { const r = await f(base + name); if (!r.ok) throw new Error(`${name} ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
}
const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const text = (bytes) => new TextDecoder().decode(toBytes(bytes));

let manifestP = null;
export function loadTerrainManifest(io) {
  if (manifestP) return manifestP;
  manifestP = readerFrom(io)('manifest.json').then((b) => {
    const m = JSON.parse(text(b));
    for (const rec of m.places) { const p = terrainPlace(rec.key); if (p) Object.assign(p, { reliefM: rec.reliefM, elevMinM: rec.elevMinM, elevMaxM: rec.elevMaxM, metresPerSample: rec.metresPerSample, zoomMax: rec.zoomMax || 4 }); }
    return m;
  });
  manifestP.catch(() => { manifestP = null; });
  return manifestP;
}

const loading = new Map(), loadedPlaces = new Map();
export const loadedPlace = (key) => loadedPlaces.get(key) || null;
// a record built elsewhere (shoe/places.mjs: a patch fetched for any lat/lon)
// enters the store under its key, listed in TERRAIN_PLACES if new, and
// loadTerrainPlace(key) resolves to it without a fetch
export function registerPlace(key, record) {
  const rec = record.key === key ? record : { ...record, key };
  loadedPlaces.set(key, rec);
  bands.forEach((_, id) => { if (id.startsWith(key + '|')) bands.delete(id); });
  const listed = terrainPlace(key);
  if (listed) Object.assign(listed, { label: rec.label, family: rec.family, region: rec.region, wKm: rec.wKm, lat: rec.lat, lon: rec.lon, attribution: rec.attribution, reliefM: rec.reliefM, elevMinM: rec.elevMinM, elevMaxM: rec.elevMaxM, metresPerSample: rec.metresPerSample, zoomMax: rec.zoomMax });
  else TERRAIN_PLACES.push({ key, label: rec.label, family: rec.family, region: rec.region, wKm: rec.wKm, lat: rec.lat, lon: rec.lon, attribution: rec.attribution, reliefM: rec.reliefM, elevMinM: rec.elevMinM, elevMaxM: rec.elevMaxM, metresPerSample: rec.metresPerSample, zoomMax: rec.zoomMax });
  return rec;
}
export function loadTerrainPlace(key, io) {
  if (loadedPlaces.has(key)) return Promise.resolve(loadedPlaces.get(key));
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    const place = terrainPlace(key); if (!place) throw new Error('no such terrain: ' + key);
    const [manifest, bytes] = await Promise.all([loadTerrainManifest(io), readerFrom(io)(key + '.hgt.bin')]);
    const rec = manifest.places.find((r) => r.key === key); if (!rec) throw new Error('not baked: ' + key);
    const b = toBytes(bytes);
    if (b.byteLength !== GRID * GRID * 2) throw new Error(`${key}: ${b.byteLength} bytes`);
    const grid = new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const out = { ...place, grid, w: GRID, h: GRID, elevMinM: rec.elevMinM, elevMaxM: rec.elevMaxM, reliefM: rec.reliefM, metresPerSample: rec.metresPerSample, zoomMax: rec.zoomMax || 4 };
    loadedPlaces.set(key, out);
    return out;
  })();
  p.catch(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

// ── the sampler ──────────────────────────────────────────────────────────
const pingpong = (x) => { const t = Math.abs(x) % 2; return t > 1 ? 2 - t : t; };
const smooth = (t) => t * t * (3 - 2 * t);

// one lap of the raster over the chart, u unwrapped (may run past 0..1), with the seam crossfade
function lapReader(place, bearingDeg, vSpan) {
  const th = bearingDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const g = (u, v) => {
    const a = u - 0.5, b = (v - 0.5) * vSpan;
    const s = 0.5 + a * cs + b * sn, t = 0.5 + a * sn - b * cs;
    return sampleBilinear(place, pingpong(s), pingpong(t));
  };
  return (u, v) => {
    u = ((u % 1) + 1) % 1;
    const h = SEAM_W / 2;
    if (u >= h && u < 1 - h) return g(u, v);
    const p = u >= 1 - h ? (u - (1 - h)) / SEAM_W : 0.5 + u / SEAM_W;
    const uE = 1 - h + p * SEAM_W;
    return g(uE, v) * (1 - smooth(p)) + g(uE - 1, v) * smooth(p);
  };
}

// separable Gaussian: periodic in u (x), clamped in v (y); a sigma of 0 skips the axis
function gauss(a, W, H, sigmaU, sigmaV) {
  const kernel = (sigma) => { const r = Math.ceil(sigma * 3), k = new Float64Array(2 * r + 1); let n = 0; for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); n += k[i + r]; } for (let i = 0; i < k.length; i++) k[i] /= n; return { r, k }; };
  let src = a;
  if (sigmaU > 0) {
    const { r, k } = kernel(sigmaU), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * src[y * W + (((x + i) % W) + W) % W]; out[y * W + x] = s; }
    src = out;
  }
  if (sigmaV > 0) {
    const { r, k } = kernel(sigmaV), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let i = -r; i <= r; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); s += k[i + r] * src[yy * W + x]; } out[y * W + x] = s; }
    src = out;
  }
  return src;
}
function bilinearPeriodicU(grid, W, H) {
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * W, y = Math.max(0, Math.min(H - 1, v * (H - 1)));
    const x0 = Math.floor(x) % W, y0 = Math.floor(y), x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1), fx = x - Math.floor(x), fy = y - y0;
    return (grid[y0 * W + x0] * (1 - fx) + grid[y0 * W + x1] * fx) * (1 - fy) + (grid[y1 * W + x0] * (1 - fx) + grid[y1 * W + x1] * fx) * fy;
  };
}
function chartSteps(sample, Kc, rings) {
  let du = 0, dv = 0;
  for (let j = 0; j <= rings; j++) for (let q = 0; q < Kc; q++) du = Math.max(du, Math.abs(sample((q + 1) / Kc, j / rings) - sample(q / Kc, j / rings)));
  for (let q = 0; q < Kc; q++) for (let j = 0; j < rings; j++) dv = Math.max(dv, Math.abs(sample(q / Kc, (j + 1) / rings) - sample(q / Kc, j / rings)));
  return { u: du, v: dv };
}

const bands = new Map();
export function placeSampler(place, { mode = 'wrap', bearingDeg = 0, scale = 1, seed = 0 } = {}) {
  const tiles = mode === 'strip' ? Math.max(1, Math.round(scale)) : 1;
  const vSpan = mode === 'strip' ? 1 : Math.max(0.05, scale);
  const bearing = ((bearingDeg % 360) + 360) % 360;
  const id = `${place.key}|${mode}|${bearing}|${tiles}|${vSpan}`;
  let band = bands.get(id);
  if (!band) {
    const lap = lapReader(place, bearing, vSpan);
    const W = BAND_W, H = BAND_H;
    // box prefilter: each cell integrates its raster footprint
    const su = Math.min(8, Math.max(1, Math.ceil(tiles * place.w / W))), sv = Math.min(8, Math.max(1, Math.ceil(vSpan * place.h / H)));
    let grid = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let acc = 0;
      for (let y = 0; y < sv; y++) for (let x = 0; x < su; x++) {
        const u = ((i + (x + 0.5) / su) / W) * tiles, v = (j + (y + 0.5) / sv - 0.5) / (H - 1);
        acc += lap(u, v);
      }
      grid[j * W + i] = acc / (su * sv);
    }
    // low-pass to the chart, then normalise; the sigma grows until no step
    // of the default chart exceeds MAX_STEP (u starts unfiltered: the raster
    // is already at chart density)
    const normalise = (g) => { let lo = Infinity, hi = -Infinity; for (const q of g) { if (q < lo) lo = q; if (q > hi) hi = q; } const range = hi - lo || 1; const n = new Float32Array(g.length); for (let i = 0; i < g.length; i++) n[i] = (g[i] - lo) / range; return { n, lo, hi }; };
    let sigmaU = 0, sigmaV = BAND_SIGMA_V, out, steps;
    for (let pass = 0; pass < 8; pass++) {
      out = normalise(gauss(grid, W, H, sigmaU, sigmaV));
      steps = chartSteps(bilinearPeriodicU(out.n, W, H), CHART_KC, CHART_RINGS);
      if (steps.u <= MAX_STEP && steps.v <= MAX_STEP) break;
      if (steps.u > MAX_STEP) sigmaU = sigmaU ? sigmaU * 1.3 : 1;
      if (steps.v > MAX_STEP) sigmaV *= 1.3;
    }
    const { n: norm, lo, hi } = out;
    const perQ = (place.elevMaxM - place.elevMinM) / 65535;
    band = { grid: norm, W, H, qMin: lo, qMax: hi, sigmaU, sigmaV, steps, bandMinM: place.elevMinM + lo * perQ, bandMaxM: place.elevMinM + hi * perQ, bandSpanM: (hi - lo) * perQ };
    bands.set(id, band);
  }
  const { grid, W, H } = band;
  const read = bilinearPeriodicU(grid, W, H);
  const sample = (u, v) => { const r = read(u, v); return r < 0 ? 0 : r > 1 ? 1 : r; };
  sample.place = place.key; sample.mode = mode; sample.bearingDeg = bearing; sample.scale = mode === 'strip' ? tiles : vSpan; sample.seed = seed;
  sample.bandMinM = band.bandMinM; sample.bandMaxM = band.bandMaxM; sample.bandSpanM = band.bandSpanM;
  sample.seamWidth = SEAM_W; sample.sigmaU = band.sigmaU; sample.sigmaV = band.sigmaV;
  sample.trueScaleMultiple = (ampMm) => (ampMm > 0 ? band.bandSpanM * 1000 / (2 * ampMm) : Infinity);
  // the largest step between adjacent samples of a Kc × rings chart, in u and in v
  sample.maxStep = (Kc = CHART_KC, rings = CHART_RINGS) => chartSteps(sample, Kc, rings);
  return sample;
}

// ── the places as relief kinds ───────────────────────────────────────────
// Entries shaped like relief.mjs's RELIEF_KINDS, keyed `place:<key>`, in
// MASQ's family order, labelled "Everest and Khumbu — Peaks". Their sample
// takes the app's (seed, scale): seed turns the bearing in 30° steps (seed 1
// = north at the rim), scale = raster heights the sidewall spans ('wrap').
// A place samples flat (0.5) until loadTerrainPlace(key) has resolved.
export const PLACE_KIND_PREFIX = 'place:';
export const bearingOfSeed = (seed) => (((seed | 0) - 1) * 30 % 360 + 360) % 360;
export function reliefKindsFromPlaces() {
  const kinds = {};
  for (const fam of TERRAIN_FAMILIES) for (const p of TERRAIN_PLACES) {
    if (p.family !== fam) continue;
    kinds[PLACE_KIND_PREFIX + p.key] = {
      label: `${p.label} — ${p.family}`, place: p.key, family: p.family,
      sample: (u, v, seed, scale) => { const s = placeSamplerFor(p.key, seed, scale); return s ? s(u, v) : 0.5; },
    };
  }
  return kinds;
}
export const placeKeyOfKind = (kind) => (typeof kind === 'string' && kind.startsWith(PLACE_KIND_PREFIX) ? kind.slice(PLACE_KIND_PREFIX.length) : null);
export function placeSamplerFor(key, seed, scale) {
  const place = loadedPlaces.get(key); if (!place) return null;
  return placeSampler(place, { mode: 'wrap', bearingDeg: bearingOfSeed(seed), scale: Math.max(1, Math.round(scale || 1)), seed });
}
// what the readout says for a place kind at the app's amplitude, or null
export function placeReadout(kind, seed, scale, ampMm) {
  const key = placeKeyOfKind(kind); if (!key) return null;
  const p = terrainPlace(key), s = placeSamplerFor(key, seed, scale);
  if (!p) return null;
  return { key, label: p.label, family: p.family, region: p.region, attribution: p.attribution, loaded: !!s,
    bandSpanM: s ? s.bandSpanM : null, trueScaleMultiple: s ? s.trueScaleMultiple(ampMm) : null, bearingDeg: bearingOfSeed(seed) };
}
