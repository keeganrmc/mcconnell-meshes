/* Terrain as a pattern: a chosen patch of real ground laid over the mask as
 * relief. The places are baked (tools/bake_terrain.mjs) from AWS Terrain
 * Tiles into assets/terrain/<key>.hgt.bin — 256 x 256 uint16 quantized over
 * [elevMinM, elevMaxM], row 0 the northernmost — and read here; the app
 * never fetches the source. Every place passes the rule that keeps plains
 * and water out (terrain.test.js, from the bake's manifest): relief per km
 * ≥ 25 m, p5–p95 spread ≥ 150 m, (p5–p95)/relief ≥ 0.30, no cell at or under
 * 0.5 m. Attribution for the source rides in every export that carries one
 * (TERRAIN_ATTRIBUTION). */

export const GRID = 256;
export const TERRAIN_BASE = './assets/terrain/';

/* the families are the select's groups; wKm is the baked span across (the
 * surveyed square widened 1.2x, so a Span crop has room); `fit` names the
 * mask the place was chosen for */
export const TERRAIN_FAMILIES = ['Peaks', 'Ranges', 'Ridges', 'Canyons', 'Volcanoes', 'Badlands', 'Dunes'];
export const TERRAIN_PLACES = [
  { key: 'matterhorn', label: 'The Matterhorn', family: 'Peaks', lat: 45.9763, lon: 7.6586, wKm: 9.6, region: 'Switzerland/Italy (EU-DEM)', fit: 'a horn: the nose' },
  { key: 'halfdome', label: 'Half Dome', family: 'Peaks', lat: 37.7459, lon: -119.5332, wKm: 5, region: 'Yosemite (3DEP)', fit: 'a dome with a sheer face: the nose' },
  { key: 'devilstower', label: 'Devils Tower', family: 'Peaks', lat: 44.5902, lon: -104.7146, wKm: 6, region: 'Wyoming (3DEP)', fit: 'one boss on rolling ground: the nose' },
  { key: 'rainier', label: 'Mount Rainier', family: 'Peaks', lat: 46.8523, lon: -121.7603, wKm: 24, region: 'Washington (3DEP)', fit: 'a cone with radial valleys: the crown, or a face centred on the nose' },
  { key: 'fuji', label: 'Fuji', family: 'Peaks', lat: 35.3606, lon: 138.7274, wKm: 19.2, region: 'Japan (SRTM)', fit: 'the cleanest cone: the crown' },
  { key: 'kilimanjaro', label: 'Kilimanjaro', family: 'Peaks', lat: -3.07, lon: 37.35, wKm: 24, region: 'Tanzania (SRTM)', fit: 'a massif across the brow' },
  { key: 'denali', label: 'Denali', family: 'Peaks', lat: 63.0695, lon: -151.0074, wKm: 36, region: 'Alaska (3DEP)', fit: 'a massif across the brow' },
  { key: 'everest', label: 'Everest and Khumbu', family: 'Peaks', lat: 27.9881, lon: 86.925, wKm: 24, region: 'Nepal/China (SRTM)', fit: 'a range across a full face' },
  { key: 'dolomites', label: 'The Dolomites', family: 'Ranges', lat: 46.5, lon: 11.82, wKm: 24, region: 'Italy (EU-DEM)', fit: 'the Sella and the Marmolada: pale towers over a full face' },
  { key: 'montblanc', label: 'Mont Blanc', family: 'Ranges', lat: 45.85, lon: 6.9, wKm: 24, region: 'France/Italy (EU-DEM)', fit: 'the massif and its glaciers: a full face' },
  { key: 'jungfrau', label: 'Eiger, Mönch and Jungfrau', family: 'Ranges', lat: 46.56, lon: 7.97, wKm: 24, region: 'Switzerland (EU-DEM)', fit: 'three peaks in a row: across the brow' },
  { key: 'pyrenees', label: 'The Pyrenees at Aneto', family: 'Ranges', lat: 42.63, lon: 0.66, wKm: 24, region: 'Spain/France (EU-DEM)', fit: 'a granite range: a full face' },
  { key: 'tatras', label: 'The High Tatras', family: 'Ranges', lat: 49.18, lon: 20.1, wKm: 24, region: 'Slovakia/Poland (EU-DEM)', fit: 'a compact range: across the eyes' },
  { key: 'caucasus', label: 'The Caucasus at Ushba', family: 'Ranges', lat: 43.12, lon: 42.66, wKm: 24, region: 'Georgia (SRTM)', fit: 'a twin-horned peak among ranges: a full face' },
  { key: 'karakoram', label: 'The Karakoram at K2', family: 'Ranges', lat: 35.88, lon: 76.51, wKm: 36, region: 'Pakistan/China (SRTM)', fit: 'the steepest range on Earth: a full face' },
  { key: 'annapurna', label: 'Annapurna', family: 'Ranges', lat: 28.65, lon: 83.78, wKm: 32, region: 'Nepal (SRTM)', fit: 'a wall of peaks over a gorge: across the brow' },
  { key: 'tianshan', label: 'The Tian Shan at Khan Tengri', family: 'Ranges', lat: 42.21, lon: 80.17, wKm: 36, region: 'Kyrgyzstan/Kazakhstan (SRTM)', fit: 'a marble pyramid among glaciers: the nose' },
  { key: 'aconcagua', label: 'Aconcagua', family: 'Ranges', lat: -32.65, lon: -70.01, wKm: 30, region: 'Argentina (SRTM)', fit: 'the Andes\' highest: a massif across the brow' },
  { key: 'huascaran', label: 'The Cordillera Blanca', family: 'Ranges', lat: -9.12, lon: -77.61, wKm: 24, region: 'Peru (SRTM)', fit: 'Huascarán\'s twin summits: across the eyes' },
  { key: 'fitzroy', label: 'Fitz Roy', family: 'Ranges', lat: -49.27, lon: -73.04, wKm: 24, region: 'Patagonia (SRTM)', fit: 'granite spires: a domino' },
  { key: 'tetons', label: 'The Tetons', family: 'Ranges', lat: 43.74, lon: -110.8, wKm: 24, region: 'Wyoming (3DEP)', fit: 'a range rising straight from a plain: a half mask' },
  { key: 'aoraki', label: 'The Southern Alps at Aoraki', family: 'Ranges', lat: -43.6, lon: 170.14, wKm: 24, region: 'New Zealand (LINZ)', fit: 'a range and its glaciers: a full face' },
  { key: 'toubkal', label: 'The High Atlas at Toubkal', family: 'Ranges', lat: 31.06, lon: -7.92, wKm: 24, region: 'Morocco (SRTM)', fit: 'a dry range: cheeks' },
  { key: 'drakensberg', label: 'The Drakensberg', family: 'Ranges', lat: -28.73, lon: 28.9, wKm: 24, region: 'South Africa (SRTM)', fit: 'an escarpment: a half mask, the wall across the brow' },
  { key: 'hotaka', label: 'The Japanese Alps at Hotaka', family: 'Ranges', lat: 36.29, lon: 137.65, wKm: 24, region: 'Japan (SRTM)', fit: 'sharp ridges and deep valleys: a full face' },
  { key: 'trecime', label: 'Tre Cime', family: 'Ridges', lat: 46.618, lon: 12.302, wKm: 14.4, region: 'Dolomites (EU-DEM)', fit: 'three towers on a ridge: across the eyes' },
  { key: 'banff', label: 'Banff and the Bow', family: 'Ridges', lat: 51.1784, lon: -115.5708, wKm: 24, region: 'Alberta (Canada OGL)', fit: 'ranges and a valley: a full face' },
  { key: 'blackhills', label: 'Black Hills Needles', family: 'Ridges', lat: 43.8791, lon: -103.4591, wKm: 18, region: 'South Dakota (3DEP)', fit: 'granite needles: a domino' },
  { key: 'torres', label: 'Torres del Paine', family: 'Ridges', lat: -50.94, lon: -73.0, wKm: 24, region: 'Chile (SRTM)', fit: 'towers over a valley: a full face' },
  { key: 'machupicchu', label: 'Machu Picchu', family: 'Ridges', lat: -13.1631, lon: -72.545, wKm: 12, region: 'Peru (SRTM)', fit: 'a ridge in a gorge bend: a half mask' },
  { key: 'glencoe', label: 'Glen Coe', family: 'Ridges', lat: 56.65, lon: -4.9, wKm: 14.4, region: 'Scotland (UK EA)', fit: 'a glen between ridges: a domino' },
  { key: 'landmanna', label: 'Landmannalaugar', family: 'Ridges', lat: 63.98, lon: -19.06, wKm: 18, region: 'Iceland (GMTED2010)', fit: 'soft rhyolite hills: cheeks' },
  { key: 'grandcanyon', label: 'The Grand Canyon', family: 'Canyons', lat: 36.0544, lon: -112.1401, wKm: 24, region: 'Arizona (3DEP)', fit: 'the gorge across the eyes, or down the nose turned 90' },
  { key: 'zion', label: 'Zion Canyon', family: 'Canyons', lat: 37.2982, lon: -112.9478, wKm: 18, region: 'Utah (3DEP)', fit: 'a slot between walls: a domino' },
  { key: 'canyonlands', label: 'Island in the Sky', family: 'Canyons', lat: 38.39, lon: -109.86, wKm: 24, region: 'Utah (3DEP)', fit: 'mesas and canyons: a full face' },
  { key: 'waimea', label: 'Waimea Canyon', family: 'Canyons', lat: 22.07, lon: -159.66, wKm: 14.4, region: 'Kauaʻi (3DEP)', fit: 'a red gorge: a half mask' },
  { key: 'haleakala', label: 'Haleakalā', family: 'Volcanoes', lat: 20.75, lon: -156.25, wKm: 18, region: 'Maui (3DEP)', fit: 'the caldera sits at a full face\'s mouth' },
  { key: 'kilauea', label: 'Kīlauea', family: 'Volcanoes', lat: 19.4069, lon: -155.2834, wKm: 12, region: 'Hawaiʻi (3DEP)', fit: 'a shallow caldera: a domino\'s eye' },
  { key: 'sthelens', label: 'Mount St Helens', family: 'Volcanoes', lat: 46.2, lon: -122.19, wKm: 18, region: 'Washington (3DEP)', fit: 'a breached crater: the breach at the mouth, turned 180' },
  { key: 'vesuvius', label: 'Vesuvius and Somma', family: 'Volcanoes', lat: 40.836, lon: 14.44, wKm: 8.4, region: 'Italy (EU-DEM)', fit: 'a cone in a broken ring: a full face' },
  { key: 'etna', label: 'Etna', family: 'Volcanoes', lat: 37.751, lon: 14.9934, wKm: 19.2, region: 'Sicily (EU-DEM)', fit: 'a broad cone: the crown' },
  { key: 'tambora', label: 'Tambora', family: 'Volcanoes', lat: -8.25, lon: 118.0, wKm: 24, region: 'Sumbawa (SRTM)', fit: 'a wide caldera: a full face' },
  { key: 'mayon', label: 'Mayon', family: 'Volcanoes', lat: 13.28, lon: 123.66, wKm: 13.2, region: 'Luzon (SRTM)', fit: 'the perfect cone: the nose or the crown' },
  { key: 'eyjafjalla', label: 'Eyjafjallajökull', family: 'Volcanoes', lat: 63.665, lon: -19.61, wKm: 19.2, region: 'Iceland (GMTED2010)', fit: 'an ice-capped cone: a full face' },
  { key: 'bryce', label: 'Bryce amphitheatre', family: 'Badlands', lat: 37.6283, lon: -112.1677, wKm: 9.6, region: 'Utah (3DEP)', fit: 'hoodoos: cheeks, a Colombina' },
  { key: 'meteora', label: 'Meteora', family: 'Badlands', lat: 39.72, lon: 21.63, wKm: 7.2, region: 'Greece (EU-DEM)', fit: 'pillars: a small-span texture' },
  { key: 'cappadocia', label: 'Cappadocia', family: 'Badlands', lat: 38.64, lon: 34.83, wKm: 12, region: 'Turkey (SRTM)', fit: 'chimneys and valleys: cheeks' },
  { key: 'zhangjiajie', label: 'Zhangjiajie', family: 'Badlands', lat: 29.3158, lon: 110.4344, wKm: 12, region: 'China (SRTM)', fit: 'sandstone pillars: a Moretta' },
  { key: 'wadirum', label: 'Wadi Rum', family: 'Badlands', lat: 29.58, lon: 35.42, wKm: 18, region: 'Jordan (SRTM)', fit: 'mesas on sand: a full face' },
  { key: 'sossusvlei', label: 'Sossusvlei', family: 'Dunes', lat: -24.73, lon: 15.34, wKm: 18, region: 'Namibia (SRTM)', fit: 'the soft one: dunes over a full face' },
  { key: 'greatsand', label: 'Great Sand Dunes', family: 'Dunes', lat: 37.75, lon: -105.52, wKm: 9.6, region: 'Colorado (3DEP)', fit: 'dunes against a range: a half mask' },
];
export const TERRAIN_KEYS = TERRAIN_PLACES.map((p) => p.key);
export const terrainPlace = (key) => TERRAIN_PLACES.find((p) => p.key === key) || null;
/* the next place in the same family, wrapping */
export function nextTerrain(key) {
  const p = terrainPlace(key); if (!p) return TERRAIN_KEYS[0];
  const fam = TERRAIN_PLACES.filter((q) => q.family === p.family);
  return fam[(fam.indexOf(p) + 1) % fam.length].key;
}

/* the source's pixel: metres = R*256 + G + B/256 - 32768 */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;
export const quantise = (m, lo, hi) => Math.max(0, Math.min(65535, Math.round((m - lo) / ((hi - lo) || 1) * 65535)));
export const dequantise = (q, lo, hi) => lo + (q / 65535) * (hi - lo);

/* the rule every shipped place passes; the manifest record carries the bake's numbers */
export function terrainAdmissible(rec) {
  const perKm = rec.reliefM / rec.wKm, spread = rec.p95M - rec.p5M;
  return perKm >= 25 && spread >= 150 && spread / rec.reliefM >= 0.30 && rec.seaCells === 0;
}

/* a loaded place: the grid and its metres; loadPlace memoises the promise, so a
 * place is fetched once a session (and the service worker keeps it after) */
const loaded = new Map();
export function loadPlace(key, fetchFn = (typeof fetch === 'function' ? fetch : null), base = TERRAIN_BASE) {
  if (loaded.has(key)) return loaded.get(key);
  const p = (async () => {
    const place = terrainPlace(key); if (!place) throw new Error('no such terrain: ' + key);
    const [manifest, bin] = await Promise.all([fetchFn(base + 'manifest.json').then((r) => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); }), fetchFn(base + key + '.hgt.bin').then((r) => { if (!r.ok) throw new Error(key + ' ' + r.status); return r.arrayBuffer(); })]);
    const rec = manifest.places.find((r) => r.key === key); if (!rec) throw new Error('not baked: ' + key);
    if (bin.byteLength !== GRID * GRID * 2) throw new Error(key + ': ' + bin.byteLength + ' bytes');
    return { key, grid: new Uint16Array(bin), w: GRID, h: GRID, elevMinM: rec.elevMinM, elevMaxM: rec.elevMaxM, reliefM: rec.reliefM, wKm: rec.wKm, zoomMax: rec.zoomMax || 1, label: place.label, region: place.region, fit: place.fit };
  })();
  p.catch(() => loaded.delete(key));   // a failed fetch is tried again next time
  loaded.set(key, p);
  return p;
}
export const forgetPlaces = () => loaded.clear();

/* bilinear on the quantized grid, s across (0 west .. 1 east), t down (0 north .. 1 south), clamped; returns the quantized height 0..65535 */
export function sampleBilinear(place, s, t) {
  const W = place.w, H = place.h, g = place.grid;
  const x = Math.max(0, Math.min(W - 1, s * (W - 1))), y = Math.max(0, Math.min(H - 1, t * (H - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const a = g[y0 * W + x0], b = g[y0 * W + x1], c = g[y1 * W + x0], d = g[y1 * W + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* THE FRAME the map lies in, over the covered vertices of the rest head: the
 * centroid, the mean normal n, north v = +y projected off n (where the patch
 * faces up — the skull cap, n ≈ +y — north = +z, toward the wearer's face),
 * east u = v × n. With n = +z on a face: v = +y, u = +x = the wearer's left =
 * the viewer's right, so the map reads un-mirrored to someone looking at the
 * mask. Rotation turns (u, v) about n. R is the bounding circle's radius of
 * the covered set in that plane. */
export function patchFrame(P, N, inRegion, nv, rotationDeg = 0) {
  let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, w = 0;
  for (let i = 0; i < nv; i++) {
    if (!inRegion(i)) continue;
    cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2];
    nx += N[i * 3]; ny += N[i * 3 + 1]; nz += N[i * 3 + 2]; w++;
  }
  if (!w) return null;
  const c = [cx / w, cy / w, cz / w];
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / nl, ny / nl, nz / nl];
  let ref = [0, 1, 0];
  let d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
  let v = [ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]];
  let vl = Math.hypot(v[0], v[1], v[2]);
  if (vl < 0.3) { ref = [0, 0, 1]; d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2]; v = [ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]]; vl = Math.hypot(v[0], v[1], v[2]) || 1; }
  v = [v[0] / vl, v[1] / vl, v[2] / vl];
  let u = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]];
  if (rotationDeg) {
    const r = rotationDeg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const u2 = [u[0] * cs + v[0] * sn, u[1] * cs + v[1] * sn, u[2] * cs + v[2] * sn];
    const v2 = [v[0] * cs - u[0] * sn, v[1] * cs - u[1] * sn, v[2] * cs - u[2] * sn];
    u = u2; v = v2;
  }
  let R = 0;
  for (let i = 0; i < nv; i++) {
    if (!inRegion(i)) continue;
    const dx = P[i * 3] - c[0], dy = P[i * 3 + 1] - c[1], dz = P[i * 3 + 2] - c[2];
    const x = dx * u[0] + dy * u[1] + dz * u[2], y = dx * v[0] + dy * v[1] + dz * v[2];
    R = Math.max(R, Math.hypot(x, y));
  }
  return { c, n, u, v, R: R || 1, count: w };
}

/* the Tilezen attribution every export that carries a terrain writes, verbatim */
export const TERRAIN_ATTRIBUTION = [
  'Terrain data: AWS Terrain Tiles (Tilezen/Mapzen terrarium), https://registry.opendata.aws/terrain-tiles/ — attribution per https://github.com/tilezen/joerd/blob/master/docs/attribution.md:',
  'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;',
  'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;',
  'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;',
  'Canada terrain data contains information licensed under the Open Government Licence – Canada;',
  'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;',
  'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
  'Mexico terrain data source: INEGI, Continental relief, 2016;',
  'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);',
  'Norway terrain data © Kartverket;',
  'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;',
  'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
];
