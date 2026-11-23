// Any place on Earth as a terrain place: LoAm's search and terrain fetch
// (Loam/index.html) reduced to what a Terrainer needs — a Nominatim search,
// a patch of AWS terrarium tiles for a lat/lon and a span, resampled onto the
// 256² uint16 grid loadTerrainPlace yields (row 0 north, quantised over
// [minM, maxM]) so placeSampler and terrainTextureWall take it unchanged.
// No DOM, no three.js: the same code runs in the app, its plate worker and
// the node gate (tools/verify/places_2026-09-20.mjs).
//
// Copied from LoAm as it carries them: the Nominatim endpoint and headers,
// the terrarium tile URL and its decode (metres = R·256 + G + B/256 − 32768),
// the mercator helpers, the zoom choice for a span (the finest zoom ≤
// SRC_MAX_Z whose raster fits MAX_RASTER on both axes), the box-average
// resample, the blur, the cut-to-the-land rule (the level clamped to
// [SEA_M, max − 1]), the datum rule (lowest GROUND: sea level and below
// never sets it), the scale readout (1 : round(1000 / mmPerM)) and the
// attribution lines. Nominatim's usage policy: one request per second at
// most, only on a press, never on a keystroke — searchPlaces serialises its
// calls a second apart.

import { TERRAIN_ATTRIBUTION, GRID, registerPlace } from './terrain.mjs';

export { GRID };
export const NOM = 'https://nominatim.openstreetmap.org/';
export const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const EARTH_C = 40075016.686;      // equatorial circumference, m
export const TILE_PX = 256;
export const MAX_RASTER = 2048;           // px along either axis of the sampled raster
export const SRC_MAX_Z = 14;              // AWS terrarium stops being real above this
export const SEA_M = 0.5;                 // m: at or below this is water, everywhere it matters
export const SRTM_M = 30;                 // honest global source resolution, m/sample
export const NOM_INTERVAL_MS = 1000;      // Nominatim: at most one request a second
export const KM_MIN = 0.5, KM_MAX = 400;  // LoAm's span limits
export const TILE_CACHE_NAME = 'lastfirst-terrarium';
export const TILE_RUN = 8;                // tiles in flight at once

// the OSM lines LoAm's ATTRIBUTION.txt carries, after the Tilezen list
export const OSM_ATTRIBUTION = [
  '(c) OpenStreetMap contributors, under the Open Database License (ODbL) 1.0.',
  'Boundaries and search from Nominatim, under the OSMF Nominatim usage policy.',
];
export const PATCH_ATTRIBUTION = [...TERRAIN_ATTRIBUTION, ...OSM_ATTRIBUTION];

// ── mercator ─────────────────────────────────────────────────────────────
export const lon2px = (lon, z) => (lon + 180) / 360 * TILE_PX * (1 << z);
export const lat2px = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_PX * (1 << z); };
export const px2lon = (x, z) => x / (TILE_PX * (1 << z)) * 360 - 180;
export const px2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (TILE_PX * (1 << z)); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
export const mPerDegLat = 111132.0;
export const mPerDegLon = (lat) => 111320.0 * Math.cos(lat * Math.PI / 180);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const round1 = (v) => Math.round(v * 10) / 10;

// the lat/lon box of wKm × hKm centred on (lat, lon)
export function bboxOf(lat, lon, wKm, hKm) {
  const dLat = (hKm * 1000) / mPerDegLat / 2, dLon = (wKm * 1000) / mPerDegLon(lat) / 2;
  return { w: lon - dLon, e: lon + dLon, s: lat - dLat, n: lat + dLat };
}
// the finest zoom whose raster of the box fits maxRaster on both axes, capped at the source ceiling
export function pickZoom(b, maxRaster = MAX_RASTER) {
  for (let z = SRC_MAX_Z; z >= 2; z--) {
    const w = lon2px(b.e, z) - lon2px(b.w, z), h = lat2px(b.s, z) - lat2px(b.n, z);
    if (w <= maxRaster && h <= maxRaster) return z;
  }
  return 2;
}
export const metresPerPx = (lat, z) => EARTH_C * Math.cos(lat * Math.PI / 180) / (TILE_PX * (1 << z));

// ── fetch injection ──────────────────────────────────────────────────────
let fetchFn = null;
export function setFetch(f) { fetchFn = f || null; }
const getFetch = (o) => (o && o.fetch ? o.fetch : fetchFn || (typeof fetch === 'function' ? fetch : null));
const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

// ── search ───────────────────────────────────────────────────────────────
// Nominatim: the browser sends its own User-Agent; node identifies the app.
const nomHeaders = () => (inBrowser ? { Accept: 'application/json' } : { Accept: 'application/json', 'User-Agent': 'LastFirst/1.0 (renato.design; terrain place search)' });
let nomNext = 0, nomChain = Promise.resolve();
function throttled(run) {
  const p = nomChain.then(async () => {
    const now = Date.now(), wait = Math.max(0, nomNext - now);
    nomNext = Math.max(now, nomNext) + NOM_INTERVAL_MS;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return run();
  });
  nomChain = p.catch(() => {});
  return p;
}
const kindOf = (it) => (it.type === 'administrative' ? 'administrative area' : String(it.type || '').replace(/_/g, ' '));

// → [{ name, displayName, lat, lon, bbox: [s, n, w, e], type, kind, wKm, hKm }]
// wKm/hKm are the frame LoAm's goTo gives a result: its box × 1.10, clamped to [0.5, 400]
export function searchPlaces(query, { signal, limit = 8, fetch: f } = {}) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  const doFetch = getFetch({ fetch: f });
  if (!doFetch) return Promise.reject(new Error('places: no fetch'));
  return throttled(async () => {
    const r = await doFetch(NOM + 'search?format=jsonv2&limit=' + (limit | 0) + '&addressdetails=1&q=' + encodeURIComponent(q), { headers: nomHeaders(), signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.soft = true; throw e; }
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map((it) => {
      const lat = +it.lat, lon = +it.lon;
      const bb = it.boundingbox && it.boundingbox.map(Number);
      const ok = bb && bb.length === 4 && bb.every((v) => isFinite(v));
      const margin = 1.10;
      return {
        name: String(it.display_name || '').split(',')[0], displayName: it.display_name || '', lat, lon,
        bbox: ok ? [bb[0], bb[1], bb[2], bb[3]] : null, type: it.type || '', osmClass: it.class || '', kind: kindOf(it),
        wKm: ok ? clamp(round1((bb[3] - bb[2]) * mPerDegLon(lat) / 1000 * margin), KM_MIN, KM_MAX) : null,
        hKm: ok ? clamp(round1((bb[1] - bb[0]) * mPerDegLat / 1000 * margin), KM_MIN, KM_MAX) : null,
      };
    }).filter((p) => isFinite(p.lat) && isFinite(p.lon));
  });
}

// ── terrarium tiles ──────────────────────────────────────────────────────
export const terrariumM = (r, g, b) => (r * 256 + g + b / 256) - 32768;

// PNG → { w, h, channels, px } for 8-bit non-interlaced gray/RGB(A); the
// inflate is node's zlib or the browser's DecompressionStream
let inflateP = null;
function inflater() {
  if (inflateP) return inflateP;
  inflateP = (async () => {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      const z = await import('node:zlib');
      return (bytes) => new Uint8Array(z.inflateSync(bytes));
    }
    return async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  })();
  return inflateP;
}
export async function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; ctype = b[p + 17]; interlace = b[p + 20]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`PNG ${depth}-bit interlace ${interlace}: unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error('PNG colour type ' + ctype + ': unsupported');
  let n = 0; for (const d of idat) n += d.length;
  const z = new Uint8Array(n); let o = 0; for (const d of idat) { z.set(d, o); o += d.length; }
  const raw = await (await inflater())(z);
  const stride = w * channels, px = new Uint8Array(w * h * channels);
  let ip = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[ip++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[ip++], a = x >= channels ? px[row + x - channels] : 0, up = y > 0 ? px[prev + x] : 0, ul = y > 0 && x >= channels ? px[prev + x - channels] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + up; else if (f === 3) r = v + ((a + up) >> 1);
      else { const pp = a + up - ul, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - ul); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      px[row + x] = r & 255;
    }
  }
  return { w, h, channels, px };
}
// a decoded tile as metres, row 0 north
export function tileToElev({ w, h, channels, px }) {
  const e = new Float32Array(w * h);
  if (channels >= 3) for (let i = 0, p = 0; i < e.length; i++, p += channels) e[i] = terrariumM(px[p], px[p + 1], px[p + 2]);
  else for (let i = 0, p = 0; i < e.length; i++, p += channels) e[i] = terrariumM(px[p], px[p], px[p]);
  return e;
}

// tiles: memory (decoded metres) → Cache API (the PNG bytes) → network
const tileMem = new Map();
let cacheP;
function tileCache() {
  if (cacheP === undefined) cacheP = (typeof caches !== 'undefined' && caches.open) ? caches.open(TILE_CACHE_NAME).catch(() => null) : Promise.resolve(null);
  return cacheP;
}
export function clearTileMemory() { tileMem.clear(); }
export async function loadTile(z, x, y, { signal, fetch: f } = {}) {
  const n = 1 << z;
  if (y < 0 || y >= n) return null;
  x = ((x % n) + n) % n;
  const key = z + '/' + x + '/' + y;
  if (tileMem.has(key)) return tileMem.get(key);
  const url = TILE_URL(z, x, y), cache = await tileCache();
  let bytes = null;
  const hit = cache ? await cache.match(url).catch(() => null) : null;
  if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
  else {
    const doFetch = getFetch({ fetch: f });
    if (!doFetch) throw new Error('places: no fetch');
    let r;
    try { r = await doFetch(url, { signal }); } catch (e) { if (e && e.name === 'AbortError') throw e; return null; }
    if (!r || !r.ok) return null;
    if (cache) { try { await cache.put(url, r.clone()); } catch (_) {} }
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  let elev;
  try { elev = tileToElev(await decodePng(bytes)); } catch (_) { return null; }
  tileMem.set(key, { elev, w: TILE_PX, h: TILE_PX });
  return tileMem.get(key);
}

// ── the raster ───────────────────────────────────────────────────────────
// LoAm's S.src: the tiles of a box at a zoom laid into one raster of metres,
// a tile that fails reading as sea level and counted in `failed`
export async function fetchRaster(b, { zoom, maxRaster = MAX_RASTER, signal, onProgress, fetch: f } = {}) {
  const z = zoom || pickZoom(b, maxRaster);
  const x0 = lon2px(b.w, z), x1 = lon2px(b.e, z), y0 = lat2px(b.n, z), y1 = lat2px(b.s, z);
  const W = Math.max(2, Math.round(x1 - x0)), H = Math.max(2, Math.round(y1 - y0));
  const tx0 = Math.floor(x0 / TILE_PX), tx1 = Math.floor(x1 / TILE_PX), ty0 = Math.floor(y0 / TILE_PX), ty1 = Math.floor(y1 / TILE_PX);
  const elev = new Float32Array(W * H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  const total = jobs.length;
  let done = 0, failed = 0;
  const ox = Math.round(x0), oy = Math.round(y0);
  await Promise.all(Array.from({ length: Math.min(TILE_RUN, jobs.length) }, async () => {
    while (jobs.length) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const [tx, ty] = jobs.pop();
      const t = await loadTile(z, tx, ty, { signal, fetch: f });
      if (t) {
        const px0 = tx * TILE_PX - ox, py0 = ty * TILE_PX - oy;
        const xs = Math.max(0, -px0), xe = Math.min(TILE_PX, W - px0), ys = Math.max(0, -py0), ye = Math.min(TILE_PX, H - py0);
        for (let y = ys; y < ye; y++) { const src = y * TILE_PX, dst = (py0 + y) * W + px0; for (let x = xs; x < xe; x++) elev[dst + x] = t.elev[src + x]; }
      } else failed++;
      done++;
      if (onProgress) onProgress({ done, total, failed });
    }
  }));
  const lat = (b.n + b.s) / 2;
  return { w: W, h: H, elev, bbox: b, z, failed, tiles: total, x0: ox, y0: oy, mPerPx: metresPerPx(lat, z) };
}

// LoAm's resample onto a W × H grid (row 0 north): the frame wKm × hKm
// centred on (lat, lon), turned by bearingDeg (the frame's up points at
// that compass bearing); the box average over each cell's footprint where
// the raster is finer than the grid, bilinear where it is coarser. A cell
// off the raster reads its edge.
export function gridFromRaster(src, { lat, lon, wKm, hKm = wKm, bearingDeg = 0 }, W = GRID, H = GRID) {
  const th = bearingDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const kLat = 1 / mPerDegLat, kLon = 1 / mPerDegLon(lat);
  const px0 = src.x0 !== undefined ? src.x0 : lon2px(src.bbox.w, src.z), py0 = src.y0 !== undefined ? src.y0 : lat2px(src.bbox.n, src.z);
  const place = (i, j) => {
    const ex = ((i + 0.5) / W - 0.5) * wKm * 1000, ny = (0.5 - (j + 0.5) / H) * hKm * 1000;
    const E = ex * cs + ny * sn, N = -ex * sn + ny * cs;
    return [clamp(lon2px(lon + E * kLon, src.z) - px0, 0, src.w - 1.001), clamp(lat2px(lat + N * kLat, src.z) - py0, 0, src.h - 1.001)];
  };
  // raster px per grid cell along each axis of the frame, from the frame's own extent
  const spanPx = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const pxW = spanPx([lon2px(lon - wKm * 500 * kLon, src.z), 0], [lon2px(lon + wKm * 500 * kLon, src.z), 0]);
  const pxH = spanPx([0, lat2px(lat + hKm * 500 * kLat, src.z)], [0, lat2px(lat - hKm * 500 * kLat, src.z)]);
  const hw = (pxW / W) / 2, hh = (pxH / H) / 2;
  const out = new Float32Array(W * H);
  if (hw > 0.75 || hh > 0.75) {
    const rx = Math.max(0, Math.round(hw - 0.5)), ry = Math.max(0, Math.round(hh - 0.5));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const [fx, fy] = place(i, j);
      const cx = Math.round(fx), cy = Math.round(fy);
      const xa = Math.max(0, cx - rx), xb = Math.min(src.w - 1, cx + rx), ya = Math.max(0, cy - ry), yb = Math.min(src.h - 1, cy + ry);
      let sum = 0, n = 0;
      for (let y = ya; y <= yb; y++) { const row = y * src.w; for (let x = xa; x <= xb; x++) { sum += src.elev[row + x]; n++; } }
      out[j * W + i] = sum / n;
    }
    return out;
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [fx, fy] = place(i, j);
    const ix = Math.floor(fx), tx = fx - ix, jy = Math.floor(fy), ty = fy - jy;
    const a = src.elev[jy * src.w + ix], c = src.elev[jy * src.w + ix + 1], d = src.elev[(jy + 1) * src.w + ix], e = src.elev[(jy + 1) * src.w + ix + 1];
    out[j * W + i] = (a + (c - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
  }
  return out;
}

// LoAm's blur: a separable Gaussian of radius r cells (sigma r / 1.4), clamped at the edges
export function smoothGrid(g, nx, ny, r) {
  if (!(r > 0.01)) return g;
  const rad = Math.max(1, Math.round(r)), sig = r / 1.4, k = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-i * i / (2 * sig * sig)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const t = new Float32Array(nx * ny), o = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let v = 0; for (let d = -rad; d <= rad; d++) v += k[d + rad] * g[j * nx + clamp(i + d, 0, nx - 1)]; t[j * nx + i] = v; }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let v = 0; for (let d = -rad; d <= rad; d++) v += k[d + rad] * t[clamp(j + d, 0, ny - 1) * nx + i]; o[j * nx + i] = v; }
  return o;
}

// metres → the uint16 grid over its own [min, max]
export function quantise(elev) {
  let lo = Infinity, hi = -Infinity;
  for (const v of elev) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 0; }
  const span = hi - lo || 1, grid = new Uint16Array(elev.length);
  for (let i = 0; i < elev.length; i++) grid[i] = Math.round((elev[i] - lo) / span * 65535);
  return { grid, minM: lo, maxM: hi, reliefM: hi - lo };
}
export const gridToM = (grid, minM, maxM) => { const per = (maxM - minM) / 65535, e = new Float32Array(grid.length); for (let i = 0; i < e.length; i++) e[i] = minM + grid[i] * per; return e; };

// → the patch: { grid (Uint16Array 256²), minM, maxM, reliefM, elevMinM,
// elevMaxM, w, h, wKm, hKm, lat, lon, bearingDeg, zoom, tiles, failed,
// metresPerSample, raster, attribution }. `viewKm` fetches a raster wider
// than the frame (a square of viewKm, never under the frame's diagonal when
// it is turned) so the frame can pan and turn on it without another fetch:
// patchFromRaster re-frames.
export async function fetchPatch({ lat, lon, wKm, hKm = wKm, bearingDeg = 0, viewKm = 0, smoothPx = 0 }, { signal, onProgress, maxRaster = MAX_RASTER, zoom, fetch: f } = {}) {
  wKm = clamp(+wKm || KM_MIN, KM_MIN, KM_MAX); hKm = clamp(+hKm || wKm, KM_MIN, KM_MAX);
  const view = Math.max(viewKm || 0, bearingDeg ? Math.hypot(wKm, hKm) : 0);
  const b = view > 0 ? bboxOf(lat, lon, Math.max(view, wKm), Math.max(view, hKm)) : bboxOf(lat, lon, wKm, hKm);
  const raster = await fetchRaster(b, { zoom, maxRaster, signal, onProgress, fetch: f });
  return patchFromRaster(raster, { lat, lon, wKm, hKm, bearingDeg, smoothPx });
}
export function patchFromRaster(raster, { lat, lon, wKm, hKm = wKm, bearingDeg = 0, smoothPx = 0 }) {
  let elev = gridFromRaster(raster, { lat, lon, wKm, hKm, bearingDeg });
  if (smoothPx > 0) elev = smoothGrid(elev, GRID, GRID, smoothPx);
  const q = quantise(elev);
  return {
    grid: q.grid, minM: q.minM, maxM: q.maxM, reliefM: q.reliefM, elevMinM: q.minM, elevMaxM: q.maxM,
    w: GRID, h: GRID, wKm, hKm, lat, lon, bearingDeg, zoom: raster.z, tiles: raster.tiles, failed: raster.failed,
    metresPerSample: wKm * 1000 / GRID, sourceMPerPx: raster.mPerPx, smoothPx, raster, attribution: PATCH_ATTRIBUTION,
  };
}

// the patch as a loaded terrain record under `key` (default custom:<lat>,<lon>,<wKm>), registered in terrain.mjs's store
export const patchKey = (p) => `custom:${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)},${round1(p.wKm)}`;
export function placeFromPatch(patch, key = patchKey(patch), { label, family = 'Anywhere', region = 'AWS Terrain Tiles (Tilezen terrarium)' } = {}) {
  const rec = {
    key, label: label || key, family, region, wKm: patch.wKm, hKm: patch.hKm, lat: patch.lat, lon: patch.lon, bearingDeg: patch.bearingDeg || 0,
    attribution: PATCH_ATTRIBUTION[0], attributionLines: PATCH_ATTRIBUTION,
    grid: patch.grid, w: patch.w || GRID, h: patch.h || GRID, elevMinM: patch.minM, elevMaxM: patch.maxM, reliefM: patch.reliefM,
    metresPerSample: patch.metresPerSample || patch.wKm * 1000 / GRID, zoomMax: 4, zoom: patch.zoom, tiles: patch.tiles, failed: patch.failed || 0,
  };
  return registerPlace(key, rec);
}

// ── the cut ──────────────────────────────────────────────────────────────
// LoAm's "Keep only the land": the level clamped to [SEA_M, max(SEA_M, max − 1)];
// every cell below it (keepLand) or above it (keepLand false) set to the level.
// → { grid, cutM, cutQ, flattened, kept, landFrac }
export const clampCut = (cutM, maxM) => clamp(cutM, SEA_M, Math.max(SEA_M, maxM - 1));
export function cutAt(grid, minM, maxM, cutM, { keepLand = true, clampToPatch = true } = {}) {
  const level = clampToPatch ? clampCut(cutM, maxM) : cutM;
  const per = (maxM - minM) / 65535 || 1;
  const cutQ = Math.round(clamp((level - minM) / per, 0, 65535));
  const out = new Uint16Array(grid.length);
  let flattened = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i], m = minM + v * per;
    const off = keepLand ? m < level : m > level;
    if (off) { out[i] = cutQ; flattened++; } else out[i] = v;
  }
  return { grid: out, cutM: level, cutQ, flattened, kept: grid.length - flattened, landFrac: (grid.length - flattened) / grid.length };
}

// ── scale and datum ──────────────────────────────────────────────────────
// LoAm: mmPerM = printMm / the longest ground edge; ratio = round(1000 / mmPerM)
export function trueScale(patchWKm, modelSpanMM) {
  const mmPerM = modelSpanMM / (patchWKm * 1000);
  const ratio = Math.round(1000 / mmPerM);
  return { ratio, mmPerM, mmPerKm: mmPerM * 1000, text: '1 : ' + ratio.toLocaleString('en-US') };
}
export const DATUMS = [['min', 'Lowest ground'], ['sea', 'Sea level']];
// where zero sits: 'min' is the lowest GROUND (sea level and below never sets
// it; an all-water patch falls back to its lowest sample), 'sea' is 0
export function datumOf(grid, minM, maxM, mode = 'min') {
  const per = (maxM - minM) / 65535 || 1;
  let eMin = Infinity, eMax = -Infinity, regMin = Infinity;
  for (let i = 0; i < grid.length; i++) { const v = minM + grid[i] * per; if (v < regMin) regMin = v; if (v <= SEA_M) continue; if (v < eMin) eMin = v; if (v > eMax) eMax = v; }
  const allWater = eMin === Infinity;
  if (allWater) { eMin = regMin; eMax = maxM; }
  const datumM = mode === 'sea' ? 0 : eMin;
  return { datumM, groundMinM: eMin, groundMaxM: eMax, reliefMaxM: Math.max(1e-6, eMax - datumM), allWater };
}
// a sample's model height above the slab: zSpanMm · (rel / reliefMax)^curve, zSpanMm = reliefMax · mmPerM · exaggeration
export function heightMm(hM, { datumM, reliefMaxM }, mmPerM, { exaggeration = 1, curve = 1 } = {}) {
  const rel = Math.max(0, hM - datumM);
  return reliefMaxM * mmPerM * exaggeration * Math.pow(rel / reliefMaxM, curve);
}

// ── hillshade ────────────────────────────────────────────────────────────
// LoAm's Terrain palette by height (dark brown floor to cream peaks), lit by
// a sun at azimuthDeg/altitudeDeg through each cell's slope and aspect (a
// 3 × 3 finite difference), exaggeration scaling the height before the
// slope. → RGBA Uint8ClampedArray for a canvas. Heights are read over the
// grid's own range; cellM and spanM set the true slope when both are given,
// else the relief is taken as one grid width tall. Cells at or under cutQ
// are painted as water.
export const TERRAIN_PALETTE = ['#6b4a2f', '#a8814f', '#c9b795', '#f1eee4'];
export const WATER_RGB = [58, 78, 96];
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const PAL = TERRAIN_PALETTE.map(hex);
export function paletteAt(t) {
  const x = clamp(t, 0, 1) * (PAL.length - 1), k = Math.min(PAL.length - 2, Math.floor(x)), f = x - k;
  return [0, 1, 2].map((c) => PAL[k][c] + (PAL[k + 1][c] - PAL[k][c]) * f);
}
export function hillshade(grid, w, h, { azimuthDeg = 315, altitudeDeg = 45, exaggeration = 1, cellM = 0, spanM = 0, tint = true, cutQ = -1 } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = hi - lo || 1;
  // z in cell units: the whole relief is spanM / cellM cells tall, or w cells when the true scale is unknown
  const zScale = (cellM > 0 && spanM > 0 ? spanM / cellM : w) * exaggeration / range;
  const az = (360 - azimuthDeg + 90) * Math.PI / 180, zen = (90 - altitudeDeg) * Math.PI / 180;
  const cz = Math.cos(zen), sz = Math.sin(zen);
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (x, y) => grid[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, v = grid[y * w + x];
    if (cutQ >= 0 && v <= cutQ) { out[o] = WATER_RGB[0]; out[o + 1] = WATER_RGB[1]; out[o + 2] = WATER_RGB[2]; out[o + 3] = 255; continue; }
    const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y + 1), hh = at(x, y + 1), i2 = at(x + 1, y + 1);
    const dzdx = ((c + 2 * f + i2) - (a + 2 * d + g)) / 8 * zScale, dzdy = ((g + 2 * hh + i2) - (a + 2 * b + c)) / 8 * zScale;
    const slope = Math.atan(Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
    const s = clamp(cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(az - aspect), 0, 1);
    const base = tint ? paletteAt((v - lo) / range) : [220, 220, 220];
    const k = 0.25 + 0.75 * s;
    out[o] = base[0] * k; out[o + 1] = base[1] * k; out[o + 2] = base[2] * k; out[o + 3] = 255;
  }
  return out;
}
