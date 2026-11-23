// A shell layer on the last, and the footie chip that lays its first region.
//
// buildShellLayer: any coverage field (0..1, the 0.5 contour its boundary)
// becomes an explicit shell — inner sheet the substrate at `gap`, outer sheet
// `wall` further out along the normals, a rim strip on every boundary loop.
// Answers every frame.
//
// The footie chip: a slip-on upper, everything above the feather line under
// a topline — `back` at the heel, `side` at the side's low point (35 % of the
// way to the throat), then a t² ramp to the crown read per x-bin, so the
// opening closes AT throatFrac. It writes the same kind of field the brush
// does (a two-edge band across the rim), so a laid rim and a painted rim are
// the same thing to everything downstream.

import { featherField, buildAdjacency, smoothField, refineAtIsoline, triangleSides, boundaryLoops, meshClosure, signedVolume, meshArea } from './meshcut.mjs';
import { regionShell, distanceFrom } from './shell.mjs';
import { createSubstrate, layRegion } from './paint.mjs';

// the sling's half width and the band a peep toe keeps over the feather, mm
const SLING_HALF_MM = 7, PEEP_BAND_MM = 9;
export const FOOTIE_DEFAULTS = {
  toe: 'closed',   // closed | peep | open
  toeMM: 50,       // how far back an open toe is cut, or a peep toe's width
  sling: false,    // a band round the heel when the back is open
  slingMM: 32,     // its height above the feather at the heel
  back: 65,        // mm above the feather at the heel
  side: 60,        // mm above the feather at the side's low point
  throatFrac: 0.55,// fraction of the length from the heel where the opening closes
  wall: 1.8,       // mm
  gap: 0,          // per-vertex or number
  taper: 0,        // mm of wall taper at the rims (0 = a square rim)
  overlap: 0,      // mm the footie continues BELOW the feather line (to lap a sole)
  openBack: false, // a clog: the rear 40 % of the topline held at `back` (a height that holds no heel), the quarters rising past it
  mule: false,     // a mule: the upper ends at the quarters — nothing behind 45 % of the length from the heel
};

const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// The feather line as points, from the last's own mesh: the sole set's
// boundary, cut at edge midpoints.
export function featherPoints(last) {
  const ff = featherField(last.positions, last.indices);
  const r = refineAtIsoline(last.positions, last.indices, ff.field);
  const side = triangleSides(r.indices, r.values);
  const loops = boundaryLoops(r.indices, Array.from(side, (s) => s < 0));
  const pts = [];
  for (const L of loops) for (const i of L) pts.push(r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]);
  return { pts: Float32Array.from(pts), field: ff.field, sole: ff.sole, normals: ff.normals, loops: loops.length };
}

// The footie's signed coverage over the last's own vertices (mm, > 0 inside).
export function footieSigned(last, options = {}) {
  const o = { ...FOOTIE_DEFAULTS, ...options };
  const P = last.positions, V = P.length / 3;
  const fp = featherPoints(last);
  const fx = [], fy = [], fz = [];
  for (let i = 0; i < fp.pts.length; i += 3) { fx.push(fp.pts[i]); fy.push(fp.pts[i + 1]); fz.push(fp.pts[i + 2]); }
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < V; i++) { const x = P[i * 3]; if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const L = maxX - minX, xThroat = minX + L * o.throatFrac;
  // the crown along the length: the last's top over its feather line, per x-bin
  const BINS = 40, crownTop = new Float64Array(BINS).fill(-Infinity), crownFeather = new Float64Array(BINS).fill(Infinity);
  const binOf = (x) => Math.max(0, Math.min(BINS - 1, Math.floor((x - minX) / L * BINS)));
  for (let i = 0; i < V; i++) { const b = binOf(P[i * 3]); crownTop[b] = Math.max(crownTop[b], P[i * 3 + 1]); }
  for (let k = 0; k < fx.length; k++) { const b = binOf(fx[k]); crownFeather[b] = Math.min(crownFeather[b], fy[k]); }
  for (let b = 0; b < BINS; b++) if (!isFinite(crownFeather[b])) crownFeather[b] = b > 0 ? crownFeather[b - 1] : 0;
  const crownAt = (x) => { const b = binOf(x); return crownTop[b] - crownFeather[b]; };
  const halfW = new Float64Array(BINS);
  for (let i = 0; i < V; i++) { const b = binOf(P[i * 3]); halfW[b] = Math.max(halfW[b], Math.abs(P[i * 3 + 2])); }
  const halfWidthAt = (x) => halfW[binOf(x)] || 1;
  // the median edge, to turn the sole's hop distance into mm
  let sum = 0, n = 0;
  for (let t = 0; t < last.indices.length; t += 3) { const a = last.indices[t] * 3, b = last.indices[t + 1] * 3; sum += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); n++; }
  const edge = sum / n;
  const signed = new Float64Array(V);
  for (let i = 0; i < V; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    let best = 0, bd = Infinity;
    for (let k = 0; k < fx.length; k++) { const d = (x - fx[k]) ** 2 + (z - fz[k]) ** 2; if (d < bd) { bd = d; best = k; } }
    const hFeather = fy[best];
    const s = (x - minX) / Math.max(1e-6, xThroat - minX); // 0 heel → 1 throat
    let h;
    if (o.openBack) {
      // an open back: nothing behind the heel — the topline stays at `back`
      // to 40 % of the way to the throat, rises to `side` by 60 %, then
      // ramps to the crown as a slip-on's does
      if (s <= 0.4) h = o.back;
      else if (s <= 0.6) h = o.back + (o.side - o.back) * smoothstep((s - 0.4) / 0.2);
      else if (s < 1) { const t = (s - 0.6) / 0.4; h = o.side + (crownAt(x) - o.side) * t * t; }
      else h = crownAt(x) + 3;
    } else if (s <= 0.35) h = o.back + (o.side - o.back) * smoothstep(s / 0.35);
    else if (s < 1) { const t = (s - 0.35) / 0.65; h = o.side + (crownAt(x) - o.side) * t * t; }
    else h = crownAt(x) + 3;
    signed[i] = hFeather + h - y;
    if (o.mule) signed[i] = Math.min(signed[i], x - (minX + L * 0.45));
    const hF = y - hFeather;
    // THE SLING: with the back open, a band round the heel `slingMM` above the
    // feather, rising to the side's height by the middle of the foot, 14 mm wide
    if (o.sling && (o.openBack || o.mule)) {
      const t = Math.max(0, Math.min(1, (x - minX) / (L * 0.5)));
      const hc = o.slingMM + (o.side - o.slingMM) * smoothstep(t);
      if (x < minX + L * 0.55) signed[i] = Math.max(signed[i], Math.min(SLING_HALF_MM - Math.abs(hF - hc), minX + L * 0.55 - x));
    }
    // THE TOE: Open cuts across the toes on a U, the sides reaching furthest
    // forward; Peep opens an oval on the toe's front over a band at the feather
    if (o.toe === 'open') {
      const u = Math.min(1, Math.abs(z) / Math.max(1, halfWidthAt(x)));
      signed[i] = Math.min(signed[i], (maxX - o.toeMM + 0.45 * o.toeMM * u * u) - x);
    } else if (o.toe === 'peep') {
      const rx = o.toeMM * 0.5, ry = o.toeMM * 0.32, cy = PEEP_BAND_MM + ry;
      const e = Math.hypot((x - maxX) / rx, (hF - cy) / ry, z / (rx * 0.9));
      signed[i] = Math.min(signed[i], (e - 1) * ry);
    }
    // below the feather line the region ends `overlap` mm down: the hop
    // distance is negative on the sole, in edges
    if (fp.sole[i]) signed[i] = Math.min(signed[i], fp.field[i] * edge + o.overlap);
  }
  // smoothed along the surface so the topline is one curve, the sole side held
  const adj = buildAdjacency(last.indices, V);
  const sm = smoothField(signed, adj, 6);
  for (let i = 0; i < V; i++) if (!fp.sole[i]) signed[i] = sm[i];
  return { signed, featherPts: fp.pts, sole: fp.sole };
}

// A shell over the region where coverage ≥ 0.5. `gap` and `wall`: number or
// per-vertex over the last. Returns rims sorted by height (lowest first).
export function buildShellLayer(last, coverage, options = {}) {
  const o = { gap: 0, wall: 1.8, taper: 0, minWall: 0.4, ...options };
  const { positions: P0, indices: I0 } = last;
  const V0 = P0.length / 3;
  const cl0 = meshClosure(I0);
  if (cl0.doubledEdges || cl0.boundaryEdges) return { ok: false, reason: 'mesh', detail: `the last is not a closed manifold: ${cl0.doubledEdges} doubled edges, ${cl0.boundaryEdges} boundary edges` };
  const normals0 = featherField(P0, I0).normals;
  const gap0 = typeof o.gap === 'number' ? new Float32Array(V0).fill(o.gap) : o.gap;
  const wall0 = typeof o.wall === 'number' ? new Float32Array(V0).fill(o.wall) : o.wall;
  const cov0 = new Float64Array(V0);
  let covered = 0;
  for (let i = 0; i < V0; i++) { cov0[i] = coverage[i] - 0.5; if (cov0[i] > 0) covered++; }
  if (!covered) return { ok: false, reason: 'empty', detail: 'nothing is painted' };
  const r = refineAtIsoline(P0, I0, cov0, [{ stride: 3, data: normals0, unit: true }, { stride: 1, data: gap0 }, { stride: 1, data: wall0 }]);
  const P = r.positions, I = r.indices, cov = r.values, N = r.attrs[0].data, gap = r.attrs[1].data, wall = r.attrs[2].data;
  const T = I.length / 3;
  const cs = triangleSides(I, cov);
  const use = new Array(T);
  for (let t = 0; t < T; t++) use[t] = cs[t] > 0;
  const table = { out: [], idx: [] };
  const loops = boundaryLoops(I, use);
  const rimDist = o.taper > 0 ? distanceFrom(P, I, use, loops.flat()) : null;
  const wallOf = (i) => Math.max(o.minWall, rimDist ? wall[i] * Math.min(1, rimDist[i] / o.taper) : wall[i]);
  const shell = regionShell(P, I, N, use, (i) => gap[i], wallOf, null, table);
  const positions = Float32Array.from(table.out), indices = Uint32Array.from(table.idx);
  const closure = meshClosure(indices);
  const volume = signedVolume(positions, indices);
  const rims = shell.loops.map((L) => {
    let y = 0; for (const i of L.loop) y += P[i * 3 + 1]; y /= L.loop.length;
    let per = 0; for (let k = 0; k < L.inner.length; k++) { const a = L.inner[k] * 3, b = L.inner[(k + 1) % L.inner.length] * 3; per += Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]); }
    return { inner: L.inner, outer: L.outer, count: L.loop.length, meanY: y, perimeter: per };
  }).sort((a, b) => a.meanY - b.meanY);
  return {
    ok: true, positions, indices, rims,
    stats: { vertices: positions.length / 3, triangles: indices.length / 3, ...closure, volumeCm3: volume / 1000, areaCm2: meshArea(positions, indices) / 100, rims: rims.length, covered },
  };
}

// The parametric footie: the chip laid, then the shell.
export function buildFootie(last, options = {}) {
  const o = { ...FOOTIE_DEFAULTS, ...options };
  const cl0 = meshClosure(last.indices);
  if (cl0.doubledEdges || cl0.boundaryEdges) return { ok: false, reason: 'mesh', detail: `the last is not a closed manifold: ${cl0.doubledEdges} doubled edges, ${cl0.boundaryEdges} boundary edges` };
  const sub = createSubstrate(last.positions, last.indices);
  const coverage = new Float32Array(sub.V);
  const { signed } = footieSigned(last, o);
  layRegion(sub, coverage, signed, 'set');
  const built = buildShellLayer(last, coverage, { gap: o.gap, wall: o.wall, taper: o.taper });
  if (!built.ok) return built;
  // the lowest rim is the feather line (or the overlap's edge), the rest topline
  const rims = built.rims.map((r, k) => ({ ...r, kind: k === 0 ? 'feather' : 'topline' }));
  const topline = rims.filter((r) => r.kind === 'topline');
  const toplinePerimeter = topline.reduce((s, r) => s + r.perimeter, 0);
  return { ...built, rims, coverage, stats: { ...built.stats, toplinePerimeter, loops: rims.map((r) => r.kind) } };
}

// The opening a region has on the last itself: its coverage's 0.5 contour, cut
// at edge midpoints, as loops sorted by height (lowest first). The inside of
// every piece is exactly the last, so this is the perimeter a foot must pass —
// the same loop buildShellLayer's inner rim runs along, without the shell.
export function coverageOpening(last, coverage) {
  const V = last.positions.length / 3, cov0 = new Float64Array(V);
  for (let i = 0; i < V; i++) cov0[i] = coverage[i] - 0.5;
  const r = refineAtIsoline(last.positions, last.indices, cov0);
  const side = triangleSides(r.indices, r.values);
  const loops = boundaryLoops(r.indices, Array.from(side, (s) => s > 0));
  const P = r.positions;
  const out = loops.map((L) => {
    let y = 0, per = 0;
    for (let k = 0; k < L.length; k++) { const a = L[k] * 3, b = L[(k + 1) % L.length] * 3; y += P[a + 1]; per += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); }
    return { perimeter: per, meanY: y / L.length, count: L.length };
  }).sort((a, b) => a.meanY - b.meanY);
  return { loops: out, topline: out.slice(1).reduce((s, l) => s + l.perimeter, 0) };
}
