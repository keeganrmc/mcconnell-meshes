// Procedural relief for a Terrainer's sidewall: heightfield samplers over a
// (u, v) chart, 0..1 in and 0..1 out, seeded, tileable in u (the chart runs
// round the footprint). Real places (MASQ's heightfields) join this table
// as more kinds; the sampler contract is the same: sample(u, v) → 0..1.

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
// value noise, tileable in x with period px
function vnoise(x, y, seed, px) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const wrap = (i) => ((i % px) + px) % px;
  const a = hash2(wrap(ix), iy, seed), b = hash2(wrap(ix + 1), iy, seed), c = hash2(wrap(ix), iy + 1, seed), d = hash2(wrap(ix + 1), iy + 1, seed);
  const ux = fade(fx), uy = fade(fy);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
function fbm(x, y, seed, px, octaves = 5, gain = 0.5, lac = 2) {
  let s = 0, a = 1, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { s += a * vnoise(x * f, y * f, seed + o * 17, px * f); norm += a; a *= gain; f *= lac; }
  return s / norm;
}
function ridged(x, y, seed, px, octaves = 5) {
  let s = 0, a = 1, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { const n = 1 - Math.abs(vnoise(x * f, y * f, seed + o * 31, px * f) * 2 - 1); s += a * n * n; norm += a; a *= 0.5; f *= 2; }
  return s / norm;
}
// Worley: distance to the nearest feature point, tileable in x
function cells(x, y, seed, px) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, wx = ((cx % px) + px) % px;
    const fx = cx + hash2(wx, cy, seed), fy = cy + hash2(wx, cy, seed + 7);
    const d = Math.hypot(x - fx, y - fy);
    if (d < best) best = d;
  }
  return Math.min(1, best);
}

// kinds: key → { label, sample(u, v, seed, scale) }. `scale` is tiles around
// the footprint (u); v is scaled by the same tile size on a 3:1 chart.
export const RELIEF_KINDS = {
  none:    { label: 'Smooth',   sample: () => 0.5 },
  ridges:  { label: 'Ridges',   sample: (u, v, seed, sc) => ridged(u * sc, v * sc * 0.35, seed, sc) },
  peaks:   { label: 'Peaks',    sample: (u, v, seed, sc) => { const n = fbm(u * sc, v * sc * 0.35, seed, sc, 6); return n * n * 1.6; } },
  dunes:   { label: 'Dunes',    sample: (u, v, seed, sc) => { const n = fbm(u * sc * 0.5, v * sc * 0.2, seed, Math.max(1, Math.round(sc * 0.5)), 3); return 0.5 + 0.5 * Math.sin(n * 9 + u * sc * 2); } },
  cells:   { label: 'Cells',    sample: (u, v, seed, sc) => 1 - cells(u * sc, v * sc * 0.35, seed, sc) },
  strata:  { label: 'Strata',   sample: (u, v, seed, sc) => { const n = fbm(u * sc, v * sc * 0.35, seed, sc, 4); return ((v * sc * 0.35 + n * 1.5) % 1 + 1) % 1; } },
  badlands:{ label: 'Badlands', sample: (u, v, seed, sc) => { const r = ridged(u * sc, v * sc * 0.35, seed, sc, 4), c = 1 - cells(u * sc * 1.7, v * sc * 0.6, seed + 3, Math.round(sc * 1.7)); return Math.min(1, r * 0.6 + c * 0.6); } },
};

export function reliefSampler(kind, seed, scale) {
  const k = RELIEF_KINDS[kind] || RELIEF_KINDS.none;
  const sc = Math.max(1, Math.round(scale));
  return (u, v) => Math.max(0, Math.min(1, k.sample(u, v, seed | 0, sc)));
}
