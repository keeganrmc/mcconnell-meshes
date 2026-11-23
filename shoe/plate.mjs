// THE PLATE ENGINE: a painted region of the last becomes a quad solid, the
// way MASQ builds its mask. The last is quad-born (Warp's 4,197 quads are
// triangulated as (a,b,c)(a,c,d) pairs), so Pgon's lift runs on it unchanged:
// whole quads selected by coverage, the outline snapped onto the 0.5 contour,
// offset per source vertex by a WALL along a smoothed direction, a rim
// rolled, Catmull-Clark ×2. The wall per source vertex is the SUM of the
// dials, as MASQ's shell assembles it (app.js rebuild, the F.thickness loop):
//
//     wall = base + puff(u) + light·shade(n·L) + pattern·fall(rim) + terrain·fall(rim)
//     coverage' = smoothstep((edge(rim) − sd) / band + ½)      before the lift
//     a deckle: wall = minWall + skive(rim) · (wall − minWall)
//
// then the fold guard (k_min, MASQ's conservativeConcavity) clamps wall + gap
// where the last is concave, and the puffed vertices are smoothed as a
// surface instead (MASQ's guardOnSurface, its Taubin half).
//
// Ported from MASQ app.js: lightDir/lightShade (4722–4755), puffInflation/
// puffField (4776–4886), the surface smoothing of a puff (6768–6808),
// wallPattern/edgeFalloff (5442–5577), the pattern's points (5482–5520),
// maskTerrain/terrainTrueMM/blurOnMask (5360–5480), signedDistanceToContour
// (2465–2528), conservativeConcavity (768–783), modulatedCoverage's
// edge-pattern rebuild and skive (6141–6265), shell.js's skiveFraction.
// Verbatim (lift/masq/): plate.js, edgepattern.js, terrain.js, lift/**.
//
// UNITS: mm in and out; plate.js runs in metres and the conversion is in
// `liftCage` and nowhere else. Frame: the app's (X along, Y up, Z across).
// Pure; node-runnable; no DOM.

import { fieldsFor, quadsToTriangles, dihedralStats, PLATE_LEVELS } from '../lift/masq/plate.js';
import { buildLift, boundaryLoops } from '../lift/masq/lift/lift/lift.v00000-001.js';
import { buildTopology, subdivideCatmullClark, liftFieldToSubdivided, computeQuadNormals, buildTriGrid, closestPointOnMesh } from '../lift/masq/lift/meshkernel/meshkernel.v00000-002.js';
import { NOISE_KINDS, fbm } from '../lift/masq/lift/deform/noise.v00000-001.js';
import { layHoles, perforate } from './perforate.mjs';
import { texture as texTexture, PATTERNS as TEX_PATTERNS, defaults as texDefaults, CURVES as TEX_CURVES, BORDERS as TEX_BORDERS, cap as texCap, kerfPitch as texKerfPitch, isoLines as texIsoLines } from './tex.mjs';
import { fieldLoops } from '../lift/masq/lift/outline/outline.v00000-001.js';
import { patternField, patternCeiling, skiveWidths, PATTERNS } from '../lift/masq/edgepattern.js';
import { sampleBilinear } from '../lift/masq/terrain.js';
import { vertexNormals } from './meshcut.mjs';
import { EDGES_ACROSS_BAND } from './paint.mjs';
import { reliefSampler } from './relief.mjs';
import { placeKeyOfKind, loadTerrainPlace, placeSamplerFor, loadedPlace, registerPlace } from './terrain.mjs';
import { profileAt } from './rimline.mjs';

export { dihedralStats, PLATE_LEVELS };

export const PLATE_DEFAULTS = {
  gap: 0,            // mm, number or per-vertex: what the plate sits on
  wall: 1.8,         // mm, number or per-vertex: the base wall
  minWall: 0.4,      // mm, the printable floor under every dial
  rim: 0.5,          // 0..1 roundness of the rolled rim
  border: 0.5,       // 0..1 tangential relaxation of the outline
  margin: 0,         // mm, grows (+) or shrinks (−) the region
  levels: PLATE_LEVELS,
  dirSmooth: 4,      // passes over the offset direction (MASQ: 32 on a 1.7 mm mesh; the same reach on 5 mm quads)
  guard: true,       // the fold guard on the wall + gap (a terrain sole passes false: its wall is the ground)
  directions: null,  // per-vertex offset direction (3V), else the smoothed normals
  field: null,       // { nearest(p) → { q, d } } over the last (lastField, or superb.mjs's meshField) if the caller keeps one
  puff: null,        // { mm, profile 0..100 }
  light: null,       // { mm, hard 0..100, x, y, z: the direction TOWARD the light, app frame }
  pattern: null,     // { kind, hiMM, scaleMM, angleDeg, seed, smoothMM, falloffMM, points: [[x,y,z] | { x, y, z, sign ±1, strength 0..1, reachMM }] }
  edge: null,        // { kind 'none'|'wave'|'noise'|'deckle', amountMM, count, scaleMM, seed, couple, plane 'side'|'plan' }
  terrain: null,     // { key, hiMM, zoom, curve, rotationDeg, smoothMM, falloffMM, plane 'side'|'plan', place: a loaded record (else loadedPlace(key)) }
};
const PUFF_SWEEPS = 300, PUFF_HOLE_MM2 = 40, PUFF_SURFACE_PASSES = 12, GUARD_CAP_MM = 120, GUARD_REACH_RINGS = 5, GUARD_BLUR_PASSES = 2;
const SKIVE_MM = 3, TERRAIN_ZOOM_MAX = 4, POINT_STRENGTH = 0.6, POINT_REACH_MIN_MM = 20;
const MM = 0.001;
const smoothstep = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// The last's quads from its (a,b,c)(a,c,d) triangle pairs. A pair that does
// not share the a–c diagonal is not a quad, and the whole mesh is refused.
export function quadsOfLast(indices) {
  if (indices.length % 6) return { ok: false, reason: 'triangles', detail: `${indices.length / 3} triangles is not an even count` };
  const nq = indices.length / 6, quads = new Uint32Array(nq * 4);
  let odd = 0;
  for (let q = 0; q < nq; q++) {
    const a = indices[q * 6], b = indices[q * 6 + 1], c = indices[q * 6 + 2], a2 = indices[q * 6 + 3], c2 = indices[q * 6 + 4], d = indices[q * 6 + 5];
    if (a !== a2 || c !== c2) { odd++; continue; }
    quads[q * 4] = a; quads[q * 4 + 1] = b; quads[q * 4 + 2] = c; quads[q * 4 + 3] = d;
  }
  if (odd) return { ok: false, reason: 'triangles', detail: `${odd} of ${nq} triangle pairs do not share a diagonal — the mesh is not quad-born` };
  return { ok: true, quads };
}

// vertex adjacency over the quad edges (no diagonals), CSR, plus the median edge
export function quadAdjacency(positions, quads) {
  const V = positions.length / 3, sets = Array.from({ length: V }, () => new Set());
  for (let f = 0; f < quads.length / 4; f++) for (let e = 0; e < 4; e++) { const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4]; sets[a].add(b); sets[b].add(a); }
  const off = new Uint32Array(V + 1); let total = 0;
  for (let v = 0; v < V; v++) { off[v] = total; total += sets[v].size; } off[V] = total;
  const nbr = new Uint32Array(total), lens = [];
  for (let v = 0; v < V; v++) { let k = off[v]; for (const w of sets[v]) { nbr[k++] = w; if (w > v) lens.push(Math.hypot(positions[w * 3] - positions[v * 3], positions[w * 3 + 1] - positions[v * 3 + 1], positions[w * 3 + 2] - positions[v * 3 + 2])); } }
  lens.sort((a, b) => a - b);
  return { off, nbr, V, edgeMM: lens.length ? lens[lens.length >> 1] : 1 };
}

// the offset direction: the normals averaged over the one-ring `passes`
// times (Pgon's smoothDirections: the direction, never the amount)
export function smoothDirections(normals, adj, passes) {
  let cur = normals;
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(cur.length);
    for (let i = 0; i < adj.V; i++) {
      let x = cur[i * 3], y = cur[i * 3 + 1], z = cur[i * 3 + 2];
      for (let k = adj.off[i]; k < adj.off[i + 1]; k++) { const j = adj.nbr[k]; x += cur[j * 3]; y += cur[j * 3 + 1]; z += cur[j * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      next[i * 3] = x / l; next[i * 3 + 1] = y / l; next[i * 3 + 2] = z / l;
    }
    cur = next;
  }
  return cur;
}

// Signed distance (mm) to the 0.5 contour of a field, negative inside:
// Dijkstra over the edge graph seeded at the crossings, then six one-ring
// passes to take the graph's fingerprint off the metric (MASQ 2465–2528).
export function signedDistanceToContour(f, adj, positions, level = 0.5) {
  const { off, nbr, V } = adj, P = positions;
  const inside = (v) => f[v] > level;
  const d = new Float64Array(V).fill(Infinity), q = [];
  for (let v = 0; v < V; v++) {
    for (let k = off[v]; k < off[v + 1]; k++) {
      const w = nbr[k]; if (inside(w) === inside(v)) continue;
      const L = Math.hypot(P[w * 3] - P[v * 3], P[w * 3 + 1] - P[v * 3 + 1], P[w * 3 + 2] - P[v * 3 + 2]);
      const t = Math.abs((level - f[v]) / ((f[w] - f[v]) || 1e-9));
      const dv = L * Math.max(0, Math.min(1, t));
      if (dv < d[v]) d[v] = dv;
    }
    if (isFinite(d[v])) q.push(v);
  }
  let head = 0;
  while (head < q.length) {
    const v = q[head++], dv = d[v];
    for (let k = off[v]; k < off[v + 1]; k++) {
      const w = nbr[k];
      const nd = dv + Math.hypot(P[w * 3] - P[v * 3], P[w * 3 + 1] - P[v * 3 + 1], P[w * 3 + 2] - P[v * 3 + 2]);
      if (nd >= d[w]) continue;
      d[w] = nd; q.push(w);
    }
  }
  let out = new Float32Array(V);
  for (let v = 0; v < V; v++) out[v] = isFinite(d[v]) ? (inside(v) ? -d[v] : d[v]) : (inside(v) ? -1e4 : 1e4);
  for (let p = 0; p < 6; p++) {
    const tmp = new Float32Array(V);
    for (let v = 0; v < V; v++) { let s = out[v], n = 1; for (let k = off[v]; k < off[v + 1]; k++) { s += out[nbr[k]]; n++; } tmp[v] = s / n; }
    out = tmp;
  }
  return out;
}

// exact straight-line distance to the contour's segments within `band` mm,
// the sign kept from the field (MASQ euclideanToContour, the brute pair)
function euclideanToContour(sd, loops, band, positions, f, level = 0.5) {
  const segs = [];
  for (const L of loops) for (let i = 0; i < L.length; i++) segs.push(L[i], L[(i + 1) % L.length]);
  if (!segs.length) return;
  for (let v = 0; v < sd.length; v++) {
    if (!(Math.abs(sd[v]) < band)) continue;
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    let best = Infinity;
    for (let i = 0; i < segs.length; i += 2) {
      const a = segs[i], b = segs[i + 1];
      const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], L2 = bx * bx + by * by + bz * bz;
      let t = L2 ? ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - (a[0] + bx * t), dy = py - (a[1] + by * t), dz = pz - (a[2] + bz * t);
      const d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) best = d2;
    }
    if (best < Infinity) sd[v] = (f[v] > level ? -1 : 1) * Math.sqrt(best);
  }
}

// how far inside the region each vertex is, 0 at the rim → 1 a `widthMM` in
function edgeFalloff(sd, widthMM) {
  const fall = new Float32Array(sd.length);
  if (!(widthMM > 0)) { fall.fill(1); return fall; }
  for (let i = 0; i < sd.length; i++) fall[i] = smoothstep(-sd[i] / widthMM);
  return fall;
}

// THE EDGE PATTERN: edgepattern.js displaces the signed distance to the rim
// and the coverage is rebuilt as one clean band about the moved contour
// (MASQ modulatedCoverage). The frontal plane of the read is `plane`: 'side'
// (x, y — the last as it is seen) or 'plan' (x, z); the rest positions are
// permuted so that plane is patternField's (x, y), in metres.
export function edgePatternedCoverage(coverage, edge, ctx) {
  const { positions: P, quads, adj } = ctx, V = adj.V;
  const kind = edge.kind || 'none';
  if (kind === 'none' || !(edge.amountMM > 0)) return { coverage, moved: null };
  const plane = edge.plane === 'plan' ? [0, 2, 1] : [0, 1, 2];
  const rest = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) { rest[v * 3] = P[v * 3 + plane[0]] * MM; rest[v * 3 + 1] = P[v * 3 + plane[1]] * MM; rest[v * 3 + 2] = P[v * 3 + plane[2]] * MM; }
  const loops = fieldLoops(P, quads, coverage, { level: 0.5 }).map((L) => L.pts);
  let perim = 0; for (const L of loops) for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; perim += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  const p = { kind, amountMM: edge.amountMM, scaleMM: edge.scaleMM || 16, count: edge.count || 13, seed: edge.seed | 0, couple: edge.couple || 0, perimMM: perim };
  const ceil = patternCeiling(kind, p, adj.edgeMM, perim);
  if (!ceil.ok) return { coverage, moved: null, refused: `the ${PATTERNS[kind].label} fundamental (${ceil.lambda0.toFixed(1)} mm) is under the mesh's floor (${ceil.floor.toFixed(1)} mm)` };
  let cx = 0, cy = 0, cn = 0;
  for (let v = 0; v < V; v++) if (coverage[v] > 0.5) { cx += rest[v * 3]; cy += rest[v * 3 + 1]; cn++; }
  if (cn) { cx /= cn; cy /= cn; }
  const D = patternField({ ...p, octaves: ceil.resolved }, rest, V, { cx, cy });
  const sd = signedDistanceToContour(coverage, adj, P);
  const W = EDGES_ACROSS_BAND * adj.edgeMM;
  euclideanToContour(sd, loops, edge.amountMM + W * 1.5, P, coverage);
  const out = new Float32Array(V);
  for (let v = 0; v < V; v++) out[v] = smoothstep((D[v] - sd[v]) / W + 0.5);
  return { coverage: out, moved: D, ceiling: ceil };
}

// THE LIGHT: 0 where the offset direction faces the light, 1 in shadow, a
// smoothstep across the terminator; one-sided so only the shadow adds.
export function lightShade(dirs, light, V) {
  let lx = light.x || 0, ly = light.y == null ? 1 : light.y, lz = light.z || 0;
  const l = Math.hypot(lx, ly, lz) || 1; lx /= l; ly /= l; lz /= l;
  const w = 1 - 0.9 * Math.max(0, Math.min(1, (light.hard || 0) / 100));
  const shade = new Float32Array(V);
  for (let i = 0; i < V; i++) { const d = dirs[i * 3] * lx + dirs[i * 3 + 1] * ly + dirs[i * 3 + 2] * lz; shade[i] = smoothstep(0.5 - d / (2 * w)); }
  return shade;
}

// THE PUFF: Poisson inflation Δu = −h² over the region (holes under 40 mm²
// filled), Gauss–Seidel over-relaxed 300 sweeps; the wall H·û^(1/n), H = the
// dial capped at 2·dmax per piece, n from the profile. û is rebased so the
// ring stands at 0 and the deepest point at 1: the puff is ADDED to the base
// wall here (MASQ's replaces it and holds the ring at its median u).
export function puffWall(inRegion, sd, puff, adj) {
  const { off, nbr, V, edgeMM } = adj;
  const dom = new Uint8Array(V); for (let v = 0; v < V; v++) dom[v] = inRegion[v] ? 1 : 0;
  const seen = new Uint8Array(V), stack = [], comps = [];
  const areaPer = edgeMM * edgeMM;
  for (let s0 = 0; s0 < V; s0++) {
    if (seen[s0] || dom[s0]) continue;
    const comp = []; seen[s0] = 1; stack.push(s0);
    while (stack.length) { const v = stack.pop(); comp.push(v); for (let k = off[v]; k < off[v + 1]; k++) { const w = nbr[k]; if (!seen[w] && !dom[w]) { seen[w] = 1; stack.push(w); } } }
    comps.push(comp);
  }
  let largest = -1; comps.forEach((c, i) => { if (largest < 0 || c.length > comps[largest].length) largest = i; });
  comps.forEach((c, i) => { if (i !== largest && c.length * areaPer < PUFF_HOLE_MM2) for (const v of c) dom[v] = 1; });
  const piece = new Int32Array(V).fill(-1); let pieces = 0; seen.fill(0);
  for (let s0 = 0; s0 < V; s0++) {
    if (seen[s0] || !dom[s0]) continue;
    const k = pieces++; seen[s0] = 1; stack.push(s0);
    while (stack.length) { const v = stack.pop(); piece[v] = k; for (let j = off[v]; j < off[v + 1]; j++) { const w = nbr[j]; if (!seen[w] && dom[w]) { seen[w] = 1; stack.push(w); } } }
  }
  const idx = []; for (let v = 0; v < V; v++) if (dom[v]) idx.push(v);
  const u = new Float32Array(V), h2 = edgeMM * edgeMM, omega = 1.9;
  for (let sweep = 0; sweep < PUFF_SWEEPS; sweep++) {
    const fwd = (sweep & 1) === 0;
    for (let q = 0; q < idx.length; q++) {
      const v = idx[fwd ? q : idx.length - 1 - q];
      let sum = 0, deg = 0;
      for (let k = off[v]; k < off[v + 1]; k++) { const w = nbr[k]; deg++; if (dom[w]) sum += u[w]; }
      if (deg) u[v] += omega * ((sum + h2) / deg - u[v]);
    }
  }
  const dmax = new Array(pieces).fill(0), umax = new Array(pieces).fill(0);
  for (let v = 0; v < V; v++) { const k = piece[v]; if (k < 0) continue; if (-sd[v] > dmax[k]) dmax[k] = -sd[v]; if (u[v] > umax[k]) umax[k] = u[v]; }
  const ring = new Uint8Array(V), ringU = Array.from({ length: pieces }, () => []);
  for (let v = 0; v < V; v++) { const k = piece[v]; if (k < 0) continue; for (let j = off[v]; j < off[v + 1]; j++) if (piece[nbr[j]] < 0) { ring[v] = 1; ringU[k].push(u[v]); break; } }
  const rim = ringU.map((a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; });
  const H = dmax.map((dm) => Math.min(puff.mm, 2 * dm));
  const p = Math.max(0, Math.min(1, (puff.profile == null ? 50 : puff.profile) / 100)), nn = Math.max(1.1, 2 * Math.pow(2.5, 1 - 2 * p));
  const wall = new Float32Array(V);
  for (let v = 0; v < V; v++) {
    const k = piece[v]; if (k < 0) continue;
    const span = umax[k] - rim[k];
    const uh = span > 0 ? Math.max(0, Math.min(1, (u[v] - rim[k]) / span)) : 0;
    wall[v] = ring[v] ? 0 : H[k] * Math.pow(uh, 1 / nn);
  }
  const tmp = new Float32Array(V);
  for (let pass = 0; pass < 2; pass++) {
    for (let v = 0; v < V; v++) {
      if (piece[v] < 0 || ring[v]) { tmp[v] = wall[v]; continue; }
      let sum = wall[v], c = 1;
      for (let j = off[v]; j < off[v + 1]; j++) { const w = nbr[j]; if (piece[w] >= 0) { sum += wall[w]; c++; } }
      tmp[v] = sum / c;
    }
    wall.set(tmp);
  }
  return { wall, piece, ring, pieces: dmax.map((dm, k) => ({ dmaxMM: dm, heightMM: H[k], capped: H[k] < puff.mm })), passes: Math.max(1, Math.min(PUFF_SURFACE_PASSES, Math.round(Math.min(...dmax.map((d) => d / edgeMM)) - 2))) };
}

// A blur of a field over the region's graph before it is added (MASQ
// blurOnMask): a diffusion at λ ½ adds half an edge² of variance a pass, so
// passes = 2·(mm / edge)² puts the blur's width at the dial; 60 at most.
function blurOnRegion(raw, inRegion, mm, adj) {
  if (!(mm > 0)) return 0;
  const { off, nbr, V } = adj;
  const passes = Math.min(60, Math.round(2 * (mm / Math.max(adj.edgeMM, 0.1)) ** 2));
  const tmp = new Float32Array(V);
  for (let p = 0; p < passes; p++) {
    for (let v = 0; v < V; v++) {
      if (!inRegion[v]) { tmp[v] = raw[v]; continue; }
      let acc = 0, c = 0;
      for (let k = off[v]; k < off[v + 1]; k++) { const w = nbr[k]; if (!inRegion[w]) continue; acc += raw[w]; c++; }
      tmp[v] = c ? raw[v] + 0.5 * (acc / c - raw[v]) : raw[v];
    }
    raw.set(tmp);
  }
  return passes;
}

// THE PATTERN'S POINTS (MASQ patPointFall / patPointDepth / patPointPinch):
// attractors and repulsors on the last, each a sign, a strength and a reach.
// Two effects, each a smoothstep f of 1 − d/reach about the point (d the
// straight-line distance on the last, mm): DEPTH — the wall's swing at a
// vertex scaled by 1 + sign·strength·f, applied after the region's
// normalisation, so an attractor doubles it at full strength and a repulsor
// leaves a level plateau at half the dial; DENSITY — the sampling domain
// scaled about the point by 2^(sign·strength·f) before the kind is read, so
// features bunch up toward an attractor and spread from a repulsor. The
// vertices within any reach are left out of the normalisation, so a point
// does not change the pattern beyond its reach. Several points multiply;
// their displacements sum from the unpinched position, so two commute.
// A point as [x, y, z] is an attractor at strength 0.6 reaching a third of
// the region's extent (20 mm at least), as MASQ places one.
export function patternPoints(points, inRegion, R, V) {
  if (!points || !points.length) return [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (let i = 0; i < V; i++) { if (!inRegion[i]) continue; any = true; for (let k = 0; k < 3; k++) { const v = R[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } }
  const extent = any ? Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 200;
  const reachDefault = Math.round(Math.max(POINT_REACH_MIN_MM, extent / 3));
  const out = [];
  for (const q of points) {
    const p = Array.isArray(q) ? { x: q[0], y: q[1], z: q[2] } : q;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    const strength = p.strength == null ? POINT_STRENGTH : Math.max(0, Math.min(1, p.strength));
    if (!(strength > 0)) continue;
    out.push({ x: p.x, y: p.y, z: p.z, sign: p.sign < 0 ? -1 : 1, strength, reachMM: p.reachMM > 0 ? p.reachMM : reachDefault });
  }
  return out;
}
const pointFall = (q, x, y, z) => {
  const d = Math.hypot(x - q.x, y - q.y, z - q.z);
  if (d >= q.reachMM) return 0;
  const t = 1 - d / q.reachMM;
  return t * t * (3 - 2 * t);
};

// THE PATTERN as a wall (MASQ wallPattern): a kind sampled in the last's own
// frame at scaleMM, the grain turned by angleDeg about Z (the side view's
// depth axis), the domain pinched about the points, normalised to fill −1..1
// by its spread over the region (outside every point's reach), blurred by
// smoothMM, the swing scaled by the points' depth, faded from the rim by
// falloffMM: 0 + (hi − 0)·max(0, ½ + ½·P·amp)·fall.
export function patternWall(inRegion, sd, pattern, ctx) {
  const { positions: R, normals, adj } = ctx, V = adj.V;
  const kind = pattern.kind || 'flat', hi = pattern.hiMM || 0;
  const wall = new Float32Array(V);
  if (kind === 'flat' || !(hi > 0)) return wall;
  const scale = Math.max(2, pattern.scaleMM || 12), seed = pattern.seed | 0;
  const ang = (pattern.angleDeg || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const shaper = kind === 'noise' || kind === 'stripes' ? null : NOISE_KINDS[kind] || null;
  if (kind !== 'noise' && kind !== 'stripes' && !shaper) return wall;
  const o = { octaves: 3, roughness: 0.5, seed, width: 1, weaveKind: 'plain', roundness: 0.55, journey: 0.5, rake: 0.55, voids: 0, kernel: 'cubic', grid: 1 };
  const pts = patternPoints(pattern.points, inRegion, R, V);
  const depthAt = pts.length ? new Float32Array(V).fill(1) : null;
  const raw = new Float32Array(V);
  let sum = 0, sum2 = 0, cnt = 0;
  for (let i = 0; i < V; i++) {
    if (!inRegion[i]) continue;
    let px = R[i * 3], py = R[i * 3 + 1], pz = R[i * 3 + 2], near = false;
    if (pts.length) {
      let dx = 0, dy = 0, dz = 0;
      for (const q of pts) {
        const f = pointFall(q, px, py, pz);
        if (f <= 0) continue;
        near = true;
        depthAt[i] *= Math.max(0, 1 + q.sign * q.strength * f);
        const g = Math.pow(2, q.sign * q.strength * f) - 1;
        dx += (px - q.x) * g; dy += (py - q.y) * g; dz += (pz - q.z) * g;
      }
      px += dx; py += dy; pz += dz;
    }
    const x0 = px / scale, y0 = py / scale, z0 = pz / scale;
    const x = x0 * ca + y0 * sa, y = -x0 * sa + y0 * ca;
    let v;
    if (kind === 'stripes') v = Math.sin(2 * Math.PI * x + seed);
    else if (shaper) v = shaper(x, y, z0, o, normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    else v = fbm(x, y, z0, { octaves: 3, seed });
    if (!Number.isFinite(v)) v = 0;
    raw[i] = v;
    if (near) continue;
    sum += v; sum2 += v * v; cnt++;
  }
  const mean = cnt ? sum / cnt : 0, sdv = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
  blurOnRegion(raw, inRegion, pattern.smoothMM, adj);
  const fall = edgeFalloff(sd, pattern.falloffMM == null ? 6 : pattern.falloffMM);
  for (let i = 0; i < V; i++) {
    if (!inRegion[i]) continue;
    let P = raw[i];
    const amp = depthAt ? depthAt[i] : 1;
    if (kind !== 'stripes') P = sdv > 1e-9 ? Math.max(-1, Math.min(1, (P - mean) / (2 * sdv))) : 0;
    wall[i] = hi * Math.max(0, 0.5 + 0.5 * P * amp) * fall[i];
  }
  return wall;
}

// THE TERRAIN at true scale: the place's metres of relief over the region's
// span (the bounding circle's diameter, mm) against the place's width at the
// zoom (MASQ terrainTrueMM). What the dial's hiMM would be for a true relief.
export function terrainTrueMM(place, regionSpanMM, zoom = 1) {
  if (!place || !(place.reliefM > 0) || !(place.wKm > 0) || !(regionSpanMM > 0)) return 0;
  const acrossM = place.wKm * 1000 / Math.max(1, zoom || 1);
  return place.reliefM * regionSpanMM / acrossM;
}

// THE TERRAIN as a wall (MASQ maskTerrain): a place's raster laid over the
// region's own chart — the side view (x, y) about the region's centroid, the
// chart the pattern samples, or the plan (x, z) for a sole — turned by
// rotationDeg, the region's bounding circle mapped onto the central 1/zoom of
// the raster so no turn or crop leaves it (zoom capped at the place's
// zoomMax), sampled bilinearly, blurred over smoothMM on the last's graph,
// its lowest ground the base wall and its highest hiMM (the spread taken
// after the blur), through the curve's gamma, faded to nothing at the rim
// over falloffMM. Ground, not a texture: the pattern's points do not reach it.
export function terrainTextureWall(inRegion, sd, terrain, place, ctx) {
  const { positions: R, adj } = ctx, V = adj.V;
  const hi = terrain.hiMM || 0, wall = new Float32Array(V);
  const ax = 0, ay = terrain.plane === 'plan' ? 2 : 1;
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < V; i++) if (inRegion[i]) { cx += R[i * 3 + ax]; cy += R[i * 3 + ay]; n++; }
  if (!n || !(hi > 0) || !place || !place.grid) return { wall, stats: null };
  cx /= n; cy /= n;
  const zoomMax = place.zoomMax || TERRAIN_ZOOM_MAX, zoom = Math.max(1, Math.min(zoomMax, terrain.zoom || 1)), tz = 1 / zoom;
  const ang = (terrain.rotationDeg || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const X = new Float32Array(V), Y = new Float32Array(V);
  let radius = 0;
  for (let i = 0; i < V; i++) {
    if (!inRegion[i]) continue;
    const dx = R[i * 3 + ax] - cx, dy = R[i * 3 + ay] - cy;
    X[i] = dx * ca + dy * sa; Y[i] = dy * ca - dx * sa;
    const r = Math.hypot(X[i], Y[i]); if (r > radius) radius = r;
  }
  radius = radius || 1;
  const raw = new Float32Array(V);
  for (let i = 0; i < V; i++) if (inRegion[i]) raw[i] = sampleBilinear(place, 0.5 + tz * X[i] / (2 * radius), 0.5 - tz * Y[i] / (2 * radius));
  const passes = blurOnRegion(raw, inRegion, terrain.smoothMM, adj);
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < V; i++) { if (!inRegion[i]) continue; if (raw[i] < tmin) tmin = raw[i]; if (raw[i] > tmax) tmax = raw[i]; }
  const gamma = Math.max(0.2, terrain.curve || 1), fall = edgeFalloff(sd, terrain.falloffMM == null ? 6 : terrain.falloffMM);
  let peak = 0;
  for (let i = 0; i < V; i++) {
    if (!inRegion[i]) continue;
    const h01 = tmax > tmin ? Math.max(0, Math.min(1, (raw[i] - tmin) / (tmax - tmin))) : 0;
    wall[i] = hi * Math.pow(h01, gamma) * fall[i];
    if (wall[i] > peak) peak = wall[i];
  }
  const perQ = place.elevMaxM != null && place.elevMinM != null ? (place.elevMaxM - place.elevMinM) / 65535 : 0;
  return { wall, stats: { key: place.key, loaded: true, spanMM: 2 * radius, zoom, zoomMax, trueMM: terrainTrueMM(place, 2 * radius, zoom), gamma, blurPasses: passes, peakMM: peak, sampledReliefM: (tmax - tmin) * perQ, plane: ay === 2 ? 'plan' : 'side' } };
}

// THE FOLD GUARD's allowance (mm of safe offset): 0.7/|k_min| where the last
// is concave, the worst concavity within five rings reaching each vertex no
// closer than its distance, blurred twice (MASQ conservativeConcavity).
export function foldAllowance(positions, normals, adj) {
  const { off, nbr, V, edgeMM } = adj, P = positions;
  const kr = new Float32Array(V);
  for (let i = 0; i < V; i++) {
    let lo = 0;
    for (let a = off[i]; a < off[i + 1]; a++) {
      const j = nbr[a];
      const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
      const l2 = dx * dx + dy * dy + dz * dz; if (l2 < 1e-12) continue;
      const kn = -2 * (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * dz) / l2;
      if (kn < lo) lo = kn;
    }
    kr[i] = -lo;   // 1/mm, positive where concave
  }
  const allow = new Float32Array(V).fill(GUARD_CAP_MM);
  let cur = kr;
  for (let r = 1; r <= GUARD_REACH_RINGS; r++) {
    const next = new Float32Array(V);
    for (let v = 0; v < V; v++) { let m = cur[v]; for (let k = off[v]; k < off[v + 1]; k++) m = Math.max(m, cur[nbr[k]]); next[v] = m; }
    cur = next;
    const floorR = (r - 1) * edgeMM;
    for (let v = 0; v < V; v++) { const a = cur[v] > 1e-6 ? Math.min(GUARD_CAP_MM, 0.7 / cur[v]) : GUARD_CAP_MM; const bound = Math.max(a, floorR); if (bound < allow[v]) allow[v] = bound; }
  }
  for (let p = 0; p < GUARD_BLUR_PASSES; p++) {
    const tmp = new Float32Array(V);
    for (let v = 0; v < V; v++) { let s = allow[v], n = 1; for (let k = off[v]; k < off[v + 1]; k++) { s += allow[nbr[k]]; n++; } tmp[v] = s / n; }
    allow.set(tmp);
  }
  return allow;
}

// A puffed wall smoothed as a SURFACE: the outer points Taubin-smoothed over
// the puffed vertices (no shrink; the ring pinned) and written back as the
// wall along each direction, capped (MASQ guardOnSurface's smoothOuter).
function smoothPuffedOuter(th, sel, ring, dirs, positions, adj, passes, cap, minWall) {
  const { off, nbr, V } = adj, P = positions;
  const O = new Float32Array(V * 3), T = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) { const t = th[i]; O[i * 3] = P[i * 3] + dirs[i * 3] * t; O[i * 3 + 1] = P[i * 3 + 1] + dirs[i * 3 + 1] * t; O[i * 3 + 2] = P[i * 3 + 2] + dirs[i * 3 + 2] * t; }
  const step = (lambda) => {
    for (let i = 0; i < V; i++) {
      if (!(sel[i] > 0) || ring[i]) { T[i * 3] = O[i * 3]; T[i * 3 + 1] = O[i * 3 + 1]; T[i * 3 + 2] = O[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0, c = 0;
      for (let k = off[i]; k < off[i + 1]; k++) { const w = nbr[k]; if (!(sel[w] > 0)) continue; x += O[w * 3]; y += O[w * 3 + 1]; z += O[w * 3 + 2]; c++; }
      if (!c) { T[i * 3] = O[i * 3]; T[i * 3 + 1] = O[i * 3 + 1]; T[i * 3 + 2] = O[i * 3 + 2]; continue; }
      T[i * 3] = O[i * 3] + lambda * (x / c - O[i * 3]); T[i * 3 + 1] = O[i * 3 + 1] + lambda * (y / c - O[i * 3 + 1]); T[i * 3 + 2] = O[i * 3 + 2] + lambda * (z / c - O[i * 3 + 2]);
    }
    O.set(T);
  };
  for (let pass = 0; pass < passes; pass++) { step(0.5); step(-0.53); }
  for (let i = 0; i < V; i++) {
    if (!(sel[i] > 0) || ring[i]) continue;
    const t = (O[i * 3] - P[i * 3]) * dirs[i * 3] + (O[i * 3 + 1] - P[i * 3 + 1]) * dirs[i * 3 + 1] + (O[i * 3 + 2] - P[i * 3 + 2]) * dirs[i * 3 + 2];
    th[i] = Math.max(minWall, Math.min(cap, t));
  }
}

// plate.js's build with the CAGE kept: fieldsFor → buildLift in metres
// (positions, thickness and gap scaled in, the cage scaled out), then the
// cage is reseated on the last, then buildTopology → subdivideCatmullClark
// per level in mm. plate.js's own buildPlate hands back only the subdivided
// level, and the cage with its srcOf is what the stack reads (the inner
// sheet IS the last's vertices), so its loop is repeated here.
function liftCage(P, quads, dirs, coverage, thickness, gap, o) {
  const V = P.length / 3, Pm = new Float32Array(V * 3);
  for (let i = 0; i < V * 3; i++) Pm[i] = P[i] * MM;
  const f = fieldsFor(coverage, gap, thickness);
  const out = buildLift({ positions: Pm, quads, normals: dirs, mask: coverage }, {
    thickness: f.medianThickness, offset: 0, thicknessAt: f.thicknessAt, offsetAt: f.offsetAt,
    rim: o.rim, border: o.border, margin: (o.margin || 0) * MM, directionSmooth: 0,
  });
  if (!out.ok) return out;
  let nvOuter = 0; for (let i = 0; i < out.stats.faces * 4; i++) if (out.quads[i] >= nvOuter) nvOuter = out.quads[i] + 1;
  return { ok: true, cage: { positions: Float32Array.from(out.positions, (v) => v / MM), quads: Int32Array.from(out.quads), srcOf: out.srcOf, sheetCount: nvOuter, sheetFaces: out.stats.faces }, stats: out.stats };
}

// ⚠ THE SNAP IS TANGENTIAL AND THE LAST IS COARSE. Pgon slides a rim vertex
// onto the contour in its tangent plane, so it cannot cut into the form; on
// MASQ's 1.7 mm head a slide of an edge lifts 0.1 mm off it. The last's quads
// are 5 mm and its feather edge turns on a ~6 mm radius, so the same slide
// (up to 3.4 mm) lifted the inner sheet 0.94 mm off the last at the feather
// rim — a gap nobody asked for. Every moved patch vertex is put back on the
// last's nearest surface point, and its outer twin and the rim ring spun
// from it move with it, so the wall there is what the field says.
// the last's surface as a nearest-point query (meshkernel's grid); a caller
// keeping superb.mjs's meshField may hand that in as `field` instead
export function lastField(positions, indices) {
  const grid = buildTriGrid(positions, indices);
  return { nearest: (p) => { const q = closestPointOnMesh(p, positions, indices, grid); return q ? { q, d: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) } : { q: null, d: Infinity }; } };
}

// The inner sheet's seat: a vertex the rim's snap carried off the last goes
// back to the last's nearest point — at its GAP along its direction, so a
// piece that stands off the last (a gap stroke, a sole over a footie's wall)
// keeps standing off; the outer vertex and the rim rings ride the same move.
function reseatOnLast(cage, P, field, dirs, gap) {
  const nv = cage.sheetCount, X = cage.positions, n = X.length / 3;
  const ringsOf = new Map();
  for (let i = 2 * nv; i < n; i++) { const s = cage.srcOf[i]; let l = ringsOf.get(s); if (!l) ringsOf.set(s, l = []); l.push(i); }
  let moved = 0, maxMove = 0;
  for (let i = 0; i < nv; i++) {
    const j = nv + i, s = cage.srcOf[j], g = gap ? gap[s] : 0;
    const ox = dirs[s * 3] * g, oy = dirs[s * 3 + 1] * g, oz = dirs[s * 3 + 2] * g;
    const px = X[j * 3] - ox, py = X[j * 3 + 1] - oy, pz = X[j * 3 + 2] - oz;   // where the vertex sits on the last
    const dx0 = px - P[s * 3], dy0 = py - P[s * 3 + 1], dz0 = pz - P[s * 3 + 2];
    if (dx0 * dx0 + dy0 * dy0 + dz0 * dz0 < 1e-12) continue;
    const q = field.nearest([px, py, pz], 10);
    if (!q.q) continue;
    const dx = q.q[0] - px, dy = q.q[1] - py, dz = q.q[2] - pz;
    const targets = [j, i].concat(ringsOf.get(s) || []);
    for (const k of targets) { X[k * 3] += dx; X[k * 3 + 1] += dy; X[k * 3 + 2] += dz; }
    moved++; maxMove = Math.max(maxMove, q.d);
  }
  return { moved, maxMove };
}

/**
 * The Tread on a subdivided plate (see buildPlate): every outer-sheet vertex moves along its normal by the
 * pattern's height at its plan position (core x, y = app x, z), inward for Carved and outward for Raised,
 * faded in over `soft` mm from the rim (walked along the mesh, so a narrow waist fades too). A Carved cut is
 * held so the wall keeps minWall. A pattern finer than 2.5 mesh edges is scaled up to it and the stats say so.
 * tread = { pattern, params, relief: 'carved'|'raised', depthMM, angle, soft, curve, mask, border }
 * mask (Where: a paint channel per build vertex, lifted with the cage as sub.mask): the pattern lays only where it
 * is ≥ ½, and the soft edge fades in from the painted zone's edge as from the rim. An empty mask (nothing painted)
 * lays nothing and says so (unpainted). border = { style (tex BORDERS), widthMM, depthMM, insetMM }: a band
 * `inset` in from the rim and `width` wide, always cut into the outsole in that section; inside it the pattern
 * gives way to the band.
 */
// FLEX GROOVES: straight grooves across the shoe in a band centred on the ball line (landmarks xBall), turned by the
// Angle about the ball's centre. Their pitch is swarf's kerf rule, p = w·R / (T − s): w the groove's width, T − s
// the groove's depth (T the wall, s the floor left under it), R the bend at which the grooves just close.
// A pattern for applyTread, in its terms (build → { h, depth, feature }).
function flexPattern(flex, depthMM, angleDeg) {
  return {
    label: 'flex grooves', short: 'Flex grooves',
    build(p) {
      const w = Math.max(0.5, +flex.widthMM || 3), R = Math.max(1, +flex.bendMM || 15), band = Math.max(w, +flex.bandMM || 40);
      const pitch = texKerfPitch(w, depthMM, 0, R), half = band / 2, hw = w / 2, a = (angleDeg || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      const x0 = +flex.xBall || 0, kMax = Math.floor((half + 1e-9) / pitch);
      return {
        h: (x, z) => { const u = (x - x0) * c + z * sn; let k = Math.round(u / pitch); if (k > kMax) k = kMax; if (k < -kMax) k = -kMax; return texCap(Math.abs(u - k * pitch), hw, p.depth, p.profile || 'cone'); },
        depth: p.depth, feature: w, flex: { widthMM: w, bendMM: R, bandMM: band, pitchMM: pitch, count: 2 * kMax + 1 },
        // the grooves' centrelines in plan (x, z): k·pitch across the ball's centre, turned by the Angle
        lines: (zLo, zHi) => { const out = []; for (let k = -kMax; k <= kMax; k++) { const u = k * pitch, pts = []; for (let v = zLo - 40; v <= zHi + 40; v += 1) pts.push([x0 + u * c - v * sn, u * sn + v * c]); out.push(pts); } return out; },
      };
    },
  };
}

// A tread as the build may read it: whatever a document, an older build or a typed number sent, every number finite
// and inside its control's typed range (the app's fmin..fmax), every name one the tables own (never a prototype key:
// PATTERNS['toString'] is a function), a pattern's own parameters inside swarf's ranges. Unknown names fall back to
// the default; an unknown pattern is null (no tread). Torture: tools/verify/torture_tread_2026-11-01.mjs.
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const num = (v, def, lo, hi) => { const x = typeof v === 'string' && v.trim() !== '' ? +v : v; return typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; };
export function saneTread(tread) {
  if (!tread || typeof tread !== 'object' || Array.isArray(tread)) return null;
  const pattern = tread.pattern, isFlex = pattern === 'flex';
  if (!isFlex && !own(TEX_PATTERNS, pattern)) return null;
  const t = { pattern, relief: tread.relief === 'raised' ? 'raised' : 'carved', depthMM: num(tread.depthMM, 0, 0, 10), angle: num(tread.angle, 0, -1e4, 1e4) % 360 };
  if (tread.soft != null) t.soft = num(tread.soft, 6, 0, 60);
  if (own(TEX_CURVES, tread.curve)) t.curve = tread.curve;
  if (tread.mask && (ArrayBuffer.isView(tread.mask) || Array.isArray(tread.mask))) t.mask = tread.mask;
  else if (tread.mask) t.mask = new Float32Array(0);
  const b = tread.border;
  if (b && typeof b === 'object' && own(TEX_BORDERS, b.style)) t.border = { style: b.style, widthMM: num(b.widthMM, 4, 0.5, 30), depthMM: num(b.depthMM, 0, 0, 10), insetMM: num(b.insetMM, 0, 0, 40) };
  const defs = isFlex ? [{ k: 'profile', type: 'select', options: ['ball', 'cone', 'flat'], def: 'cone' }] : TEX_PATTERNS[pattern].params;
  const p = tread.params && typeof tread.params === 'object' && !Array.isArray(tread.params) ? tread.params : null;
  if (p) {
    t.params = {};
    for (const q of defs) {
      if (!own(p, q.k)) continue;
      const v = p[q.k];
      if (q.type === 'range') { const x = num(v, null, q.min, q.max); if (x != null) t.params[q.k] = x; }
      else if (q.type === 'select') { if (q.options.includes(v)) t.params[q.k] = v; }
      else if (q.type === 'text') { if (typeof v === 'string' && v) t.params[q.k] = v.slice(0, 200); }
    }
  }
  if (isFlex) {
    const f = tread.flex && typeof tread.flex === 'object' ? tread.flex : null;
    if (!f) return null;
    const w = num(f.widthMM, 3, 0.5, 20);
    t.flex = { xBall: num(f.xBall, 0, -1000, 1000), medialSign: f.medialSign < 0 ? -1 : 1, widthMM: w, bendMM: num(f.bendMM, 12, 1, 200), bandMM: Math.max(w, num(f.bandMM, 40, 5, 200)) };
  }
  return t;
}

export function applyTread(sub, treadIn, { wallMM = 2, minWall = 0.6 } = {}) {
  const tread = saneTread(treadIn);
  if (!tread) return { ok: false, reason: 'no pattern ' + String(treadIn && typeof treadIn === 'object' ? treadIn.pattern : treadIn).slice(0, 40) };
  if (!Number.isFinite(minWall) || minWall < 0) minWall = 0.6;
  if (!Number.isFinite(wallMM)) wallMM = 2;
  const isFlex = tread.pattern === 'flex' && tread.flex;
  // a carved groove's depth is what the wall lets it cut (held at wall − minWall), and the pitch is set by that depth
  const flexDepth = isFlex ? Math.min(tread.depthMM > 0 ? tread.depthMM : 1.5, tread.relief === 'raised' ? Infinity : Math.max(0.1, wallMM - minWall)) : 0;
  const pat = isFlex ? flexPattern(tread.flex, flexDepth, tread.angle) : TEX_PATTERNS[tread.pattern];
  if (!pat) return { ok: false, reason: 'no pattern ' + tread.pattern };
  const P = sub.positions, I = sub.indices, n = P.length / 3, sheet = sub.sheet;
  const outer = new Uint8Array(n); let nOuter = 0;
  for (let i = 0; i < n; i++) if (sheet[i] >= 0.99) { outer[i] = 1; nOuter++; }
  // Where: the painted zone, carried down the subdivision
  const zoned = !!tread.mask, M = zoned ? sub.mask : null;
  const inZone = new Uint8Array(n); let nZone = 0;
  for (let i = 0; i < n; i++) if (outer[i] && (!zoned || (M && M[i] >= 0.5))) { inZone[i] = 1; nZone++; }
  if (zoned && nZone === 0) return { ok: false, unpainted: true, reason: 'nothing painted where the tread was asked', pattern: tread.pattern };
  // the mesh's own edge, which sets the finest pattern it can carry
  let e = 0, ne = 0; for (let t = 0; t < I.length && ne < 4000; t += 33) { const a = I[t] * 3, b = I[t + 1] * 3; e += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); ne++; }
  const edgeMM = e / Math.max(1, ne);
  const params = isFlex ? { depth: 1.5, profile: 'cone', ...(tread.params || {}) } : { ...texDefaults(tread.pattern), ...(tread.params || {}) };
  if (tread.depthMM > 0) params.depth = tread.depthMM;
  let probe = pat.build(params);
  const floor = 2.5 * edgeMM;
  let scale = probe.feature > 0 && probe.feature < floor ? floor / probe.feature : 1;
  let tex;
  if (isFlex) {
    // a groove narrower than the mesh can cut is held at its floor, and the pitch follows the width it was cut at
    if (scale > 1) { probe = flexPattern({ ...tread.flex, widthMM: floor }, flexDepth, tread.angle).build(params); }
    tex = { h: probe.h }; scale = 1;
  } else tex = texTexture({ pattern: tread.pattern, params, transform: { angle: tread.angle || 0, scale } });
  const heldFlex = isFlex && probe.feature > (+tread.flex.widthMM || 3) + 1e-9;
  const raised = tread.relief === 'raised';
  // a Carved cut is held so the wall keeps minWall: at each vertex its own wall (sub.wall, lifted with the cage), so
  // a thin painted patch holds the cut there and not across the whole outsole; wallMM (the thinnest) is the fallback
  const W = sub.wall || null, wallAt = (i) => (W && Number.isFinite(W[i]) ? W[i] : wallMM);
  const cap = raised ? Infinity : Math.max(0, wallMM - minWall), capAt = (i) => (raised ? Infinity : Math.max(0, wallAt(i) - minWall));
  // distances along the mesh (Dijkstra): from every vertex off the outer sheet (the rim), and for the fade also
  // from every vertex off the painted zone
  const soft = Math.max(0, tread.soft == null ? 6 : tread.soft), C = TEX_CURVES[tread.curve] || TEX_CURVES.smooth;
  const bd = tread.border && TEX_BORDERS[tread.border.style] ? tread.border : null, prof = bd ? TEX_BORDERS[bd.style] : null;
  const B0 = bd ? Math.max(0, +bd.insetMM || 0) : 0, Bw = bd ? Math.max(0.5, +bd.widthMM || 4) : 0, Bd = bd ? Math.max(0, +bd.depthMM || 0) : 0;
  let adj = null;
  const walk = (seed, reach, pass = outer) => {
    const dist = new Float64Array(n).fill(Infinity);
    if (!adj) { adj = Array.from({ length: n }, () => []); for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) { const a = I[t + k], b = I[t + (k + 1) % 3]; adj[a].push(b); adj[b].push(a); } }
    const heap = [];
    const push = (d, v) => { heap.push([d, v]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    for (let i = 0; i < n; i++) if (seed(i)) { dist[i] = 0; push(0, i); }
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v] || d > reach) continue;
      for (const w of adj[v]) { if (!pass[w]) continue; const nd = d + Math.hypot(P[v * 3] - P[w * 3], P[v * 3 + 1] - P[w * 3 + 1], P[v * 3 + 2] - P[w * 3 + 2]); if (nd < dist[w]) { dist[w] = nd; push(nd, w); } }
    }
    return dist;
  };
  const dist = soft > 0 ? walk((i) => !inZone[i], soft) : null;
  const rimDist = bd ? (!zoned && dist && soft >= B0 + Bw ? dist : walk((i) => !outer[i], B0 + Bw)) : null;
  const N = vertexNormals(P, I);
  const P0 = Float32Array.from(P);   // the uncut ground, for the grooves as curves
  let moved = 0, deepest = 0, capped = 0, banded = 0;
  const lift = new Float32Array(n);   // how far each vertex left the bed side: the cut (carved, border) or the gap under a lug top (raised)
  for (let i = 0; i < n; i++) {
    if (!outer[i]) continue;
    // the border band: the pattern gives way to it, and it always cuts in
    if (bd && rimDist[i] >= B0 && rimDist[i] <= B0 + Bw) {
      let b = (prof ? prof((rimDist[i] - B0) / Bw) : 0) * Bd;
      const bc = Math.max(0, wallAt(i) - minWall); if (b > bc) { b = bc; capped++; }
      banded++;
      if (b > 1e-6) { P[i * 3] -= b * N[i * 3]; P[i * 3 + 1] -= b * N[i * 3 + 1]; P[i * 3 + 2] -= b * N[i * 3 + 2]; moved++; }
      lift[i] = b;
      continue;
    }
    if (!inZone[i]) continue;
    const fall = soft > 0 ? (dist[i] >= soft ? 1 : C(dist[i] / soft)) : 1;
    if (fall <= 0) continue;
    let h = tex.h(P[i * 3], P[i * 3 + 2]) * fall;
    if (raised && fall >= 0.99) lift[i] = Math.max(0, params.depth - h);
    if (!(h > 1e-6)) continue;
    const c = capAt(i); if (h > c) { h = c; capped++; }
    if (!raised) lift[i] = h;
    const sgn = raised ? 1 : -1;
    P[i * 3] += sgn * h * N[i * 3]; P[i * 3 + 1] += sgn * h * N[i * 3 + 1]; P[i * 3 + 2] += sgn * h * N[i * 3 + 2];
    moved++; if (h > deepest) deepest = h;
  }
  // THE ROOF, printed sole down (the app's −y to the bed): a vertex that left the bed side (in a groove, or between
  // lugs) and faces down more than 50° from vertical is over air; the widest such patch, walked across from its
  // edge, is the span the printer must bridge. Tread up turns every groove open to the sky: the app decides.
  const N2 = vertexNormals(P, I), roof = new Uint8Array(n);
  let nRoof = 0, leanSum = 0;
  for (let i = 0; i < n; i++) if (outer[i] && lift[i] > 0.15 && -N2[i * 3 + 1] > 0.766) { roof[i] = 1; nRoof++; leanSum += Math.asin(Math.min(1, -N2[i * 3 + 1])); }
  let widest = 0;
  if (nRoof) { const rd = walk((i) => outer[i] && !roof[i], Infinity, roof); for (let i = 0; i < n; i++) if (roof[i] && Number.isFinite(rd[i]) && rd[i] > widest) widest = rd[i]; widest *= 2; }
  sub.roof = roof;
  // THE GROOVES AS CURVES (for SuperB / .3dm / .unreason, which cannot carry a 2–4 mm groove in a ~5 mm cage): line
  // patterns give their centrelines (swarf's strokes; Flex its own lines), the rest the contour at half depth
  // (swarf's isoLines). Laid on the UNCUT ground face, where a cutter would be swept, and kept only where the
  // tread is at full strength (in its zone, past half the soft edge, off the border).
  const curves = treadCurves(P0, n, inZone, (i) => (soft > 0 ? dist[i] >= soft * 0.5 : true) && !(bd && rimDist[i] <= B0 + Bw), isFlex ? probe : null, tex, tread, params, scale);
  sub.treadCurves = curves.list;
  return { ok: true, pattern: tread.pattern, label: pat.short || pat.label, relief: raised ? 'raised' : 'carved', depthMM: params.depth, deepestMM: deepest,
    roof: { verts: nRoof, widestMM: widest, leanDeg: nRoof ? leanSum / nRoof * 180 / Math.PI : 0 },
    curves: { count: curves.list.length, points: curves.points, kind: curves.kind, truncated: curves.truncated },
    featureMM: probe.feature * scale, held: scale > 1 ? { askedMM: probe.feature, atMM: probe.feature * scale, edgeMM } : heldFlex ? { askedMM: +tread.flex.widthMM || 3, atMM: probe.feature, edgeMM } : null,
    flex: isFlex ? probe.flex : null, capped, capMM: cap, moved, outer: nOuter,
    zoned, zone: nZone, border: bd ? { style: bd.style, widthMM: Bw, depthMM: Bd, insetMM: B0, verts: banded } : null };
}

// The tread's grooves as polylines on the uncut ground: [Float32Array x,y,z,...] (app frame) and how they were found.
function treadCurves(P0, n, inZone, full, flex, tex, tread, params, scale) {
  const CAP = 60000, cell = 2;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    if (!inZone[i] || !full(i)) continue;
    const x = P0[i * 3], z = P0[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
  }
  if (!Number.isFinite(x0)) return { list: [], points: 0, kind: 'none', truncated: false };
  // a plan point onto the ground: kept only within 1.6 mm of a kept vertex, its height blended over the three nearest
  const onGround = (x, z) => {
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell), near = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of grid.get((gx + a) + ',' + (gz + b)) || []) { const d = Math.hypot(P0[i * 3] - x, P0[i * 3 + 2] - z); if (d < 1.6) near.push([d, i]); }
    if (!near.length) return null;
    near.sort((p, q) => p[0] - q[0]);
    let wy = 0, ws = 0; for (const [d, i] of near.slice(0, 3)) { const w = 1 / (d + 0.05); wy += w * P0[i * 3 + 1]; ws += w; }
    return [x, wy / ws, z];
  };
  let plans, kind;
  const P = TEX_PATTERNS[tread.pattern];
  if (flex) { plans = flex.lines(z0, z1); kind = 'centrelines'; }
  else if (P && P.build(params).kind === 'strokes') {
    const t2 = texTexture({ pattern: tread.pattern, params, transform: { angle: tread.angle || 0, scale }, mask: { type: 'rect', x0, y0: z0, x1, y1: z1 } });
    plans = t2.strokes(1).map((s) => s.pts.map((q) => [q.x, q.y])); kind = 'centrelines';
  } else {
    const res = Math.max(0.5, Math.min(2, (tex.feature || 4) / 6));
    plans = texIsoLines((x, z) => tex.h(x, z), { x0, y0: z0, x1, y1: z1 }, res, (params.depth || 1) / 2).map((l) => l.pts); kind = 'contours';
  }
  const list = []; let points = 0, truncated = false;
  for (const poly of plans) {
    let run = [];
    const flush = () => { if (run.length >= 2) { if (points + run.length > CAP) truncated = true; else { list.push(Float32Array.from(run.flat())); points += run.length; } } run = []; };
    // every 1 mm along it (swarf drops collinear points; a straight groove arrives as its two ends)
    const dense = [];
    for (let k = 0; k < poly.length; k++) { if (k) { const [ax, az] = poly[k - 1], [bx, bz] = poly[k], m = Math.ceil(Math.hypot(bx - ax, bz - az)); for (let j = 1; j < m; j++) dense.push([ax + (bx - ax) * j / m, az + (bz - az) * j / m]); } dense.push(poly[k]); }
    for (const [x, z] of dense) { const q = onGround(x, z); if (q) run.push(q); else flush(); }
    flush();
    if (truncated) break;
  }
  return { list, points, kind, truncated };
}

function subdivideCage(cage, levels, extraField, maskField, wallField) {
  const cnv = cage.positions.length / 3, nvOuter = cage.sheetCount;
  // passengers ride the ladder (plate.js's rule): `sheet` is 1 on the outer
  // sheet, 0 on the inner, ½ on the rim rings; `extra` is a per-source field;
  // `mask` (the Tread's Where, a paint channel) and `wall` (the wall there, which holds the Tread's cut) are others
  let sheet = new Float32Array(cnv), extra = extraField ? new Float32Array(cnv) : null, mask = maskField ? new Float32Array(cnv) : null, wall = wallField ? new Float32Array(cnv) : null;
  let wallMin = Infinity; if (wall) for (let i = 0; i < cnv; i++) { const sv = cage.srcOf[i]; if (sv >= 0 && wallField[sv] < wallMin) wallMin = wallField[sv]; }
  for (let i = 0; i < cnv; i++) { sheet[i] = i < nvOuter ? 1 : i < 2 * nvOuter ? 0 : 0.5; const sv = cage.srcOf[i]; if (extra) extra[i] = sv >= 0 ? extraField[sv] : 0; if (mask) mask[i] = sv >= 0 ? (maskField[sv] || 0) : 0; if (wall) wall[i] = sv >= 0 ? wallField[sv] : wallMin; }
  let positions = cage.positions, qs = cage.quads, reached = 0;
  for (let i = 0; i < levels; i++) {
    try {
      const nv = positions.length / 3;
      const topo = buildTopology(qs, nv);
      const sub = subdivideCatmullClark(positions, qs, topo);
      if (!sub || !sub.positions || !sub.quads) break;
      sheet = liftFieldToSubdivided(sheet, qs, topo, nv);
      if (extra) extra = liftFieldToSubdivided(extra, qs, topo, nv);
      if (mask) mask = liftFieldToSubdivided(mask, qs, topo, nv);
      if (wall) wall = liftFieldToSubdivided(wall, qs, topo, nv);
      positions = sub.positions; qs = sub.quads; reached++;
    } catch (_) { break; }
  }
  return { positions: Float32Array.from(positions), quads: qs, indices: quadsToTriangles(qs), sheet, extra, mask, wall, levels: reached };
}

export function applyDeformation(positions, nvOuter, deform, lm) {
  if (!deform) return;
  const { taper = 0, twist = 0, bend = 0, squeeze = 0 } = deform;
  if (taper === 0 && twist === 0 && bend === 0 && squeeze === 0) return;
  const x0 = lm ? lm.heelX : -100, x1 = lm ? lm.toeX : 170;
  const L = Math.max(1e-6, x1 - x0);
  const n = positions.length / 3;
  const nv = nvOuter || n;

  let cz = 0;
  const countOuter = Math.min(nv, n);
  for (let i = 0; i < countOuter; i++) cz += positions[i * 3 + 2];
  cz /= Math.max(1, countOuter);
  const cy = lm ? lm.treadY : 0;

  for (let i = 0; i < n; i++) {
    const weight = i < nv ? 1.0 : (i >= 2 * nv ? 0.5 : 0.0);
    if (weight <= 0) continue;

    const x = positions[i * 3], y0 = positions[i * 3 + 1], z0 = positions[i * 3 + 2];
    const t = Math.max(0, Math.min(1, (x - x0) / L));

    let dy = 0, dz = 0;

    if (taper !== 0) {
      dz += (z0 - cz) * taper * (t * 2 - 1);
    }
    if (squeeze !== 0) {
      dz += (z0 - cz) * squeeze * Math.cos((t - 0.5) * Math.PI);
    }
    if (twist !== 0) {
      const ang = twist * (t - 0.5);
      const c = Math.cos(ang), s = Math.sin(ang);
      const py = y0 - cy, pz = (z0 + dz) - cz;
      const rotY = cy + py * c - pz * s;
      const rotZ = cz + py * s + pz * c;
      dy += (rotY - y0);
      dz += (rotZ - z0 - dz);
    }
    if (bend !== 0) {
      dz += bend * 4 * t * (1 - t);
    }

    positions[i * 3 + 1] = y0 + dy * weight;
    positions[i * 3 + 2] = z0 + dz * weight;
  }
}

/**
 * buildPlate(last, coverage, opts) → { ok, cage, limit, wall, coverage, stats } | { ok:false, reason, message }
 * last: { positions, indices } in mm; coverage: Float32Array per vertex (0.5 the boundary).
 * Beside the wall: pattern / texture (the pattern's and the terrain's walls
 * per source vertex, mm), skive (the deckle's taper width per vertex), and
 * stats.texture — { key, loaded, spanMM, zoom, zoomMax, trueMM, peakMM,
 * sampledReliefM, gamma, blurPasses, plane } or { key, loaded: false, error }.
 */
// THE OPENINGS: the region cut into straps. Seeds are thrown over the region
// at one Cell apart in a metric stretched along X by Flow (the foot's length:
// Veins run toe to collar); e = (d2 − d1)/2, half the gap between the nearest
// two seeds' distances, is the distance to the bisector between their cells,
// so a strap is where e is under half its width. A Border band at the region's
// own rim stays solid, joined to the straps by a smooth minimum (the fillet).
// The field is in mm and ramps across one edge, so the lift's 0.5 contour
// cuts each strap's edge between vertices, not on them. A strap narrower than
// 2.5 of the region's median edges cannot be cut and is held there.
export const OPENING_KINDS = { cells: { label: 'Cells', flow: 1 }, veins: { label: 'Veins', flow: 1.8 } };
function rngOf(seed) { let a = (seed * 2654435761) >>> 0 || 1; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function openingsCoverage(cov, op, ctx) {
  const { positions: P, adj } = ctx, V = P.length / 3, { off, nbr } = adj;
  const kind = OPENING_KINDS[op.kind] || OPENING_KINDS.cells;
  const region = []; for (let i = 0; i < V; i++) if (cov[i] >= 0.5) region.push(i);
  if (!region.length) return { coverage: cov, info: null };
  const edges = [];
  for (let n = 0; n < region.length; n += 7) { const v = region[n]; for (let k = off[v]; k < off[v + 1]; k++) { const w = nbr[k]; edges.push(Math.hypot(P[w * 3] - P[v * 3], P[w * 3 + 1] - P[v * 3 + 1], P[w * 3 + 2] - P[v * 3 + 2])); } }
  edges.sort((a, b) => a - b); const edge = edges[edges.length >> 1] || 2;
  const wantHalf = Math.max(0.25, (op.strapMM || 6) / 2), half = Math.max(wantHalf, 1.25 * edge);
  const flow = Math.max(0.4, op.flow != null ? op.flow : kind.flow), cell = Math.max(4 * half, op.cellMM || 22);
  const sx = 1 / flow;
  // the dart throw, in the stretched metric, on a hash grid one Cell wide
  const rnd = rngOf(op.seed || 1), order = region.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
  const seeds = [], grid = new Map(), key = (a, b, c) => a + ',' + b + ',' + c, r2 = cell * cell;
  for (const v of order) {
    const x = P[v * 3] * sx, y = P[v * 3 + 1], z = P[v * 3 + 2];
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let near = false;
    for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) for (let c = -1; c <= 1 && !near; c++) {
      const l = grid.get(key(gx + a, gy + b, gz + c)); if (!l) continue;
      for (const q of l) { const dx = q[0] - x, dy = q[1] - y, dz = q[2] - z; if (dx * dx + dy * dy + dz * dz < r2) { near = true; break; } }
    }
    if (near) continue;
    const s = [x, y, z]; seeds.push(s);
    const k = key(gx, gy, gz); (grid.get(k) || grid.set(k, []).get(k)).push(s);
  }
  // e at every vertex near the region (the ramp reaches one edge past it)
  let e = new Float32Array(V).fill(1e4);
  for (let v = 0; v < V; v++) {
    if (cov[v] <= 0) continue;
    const x = P[v * 3] * sx, y = P[v * 3 + 1], z = P[v * 3 + 2];
    let d1 = Infinity, d2 = Infinity;
    for (const q of seeds) { const d = Math.hypot(q[0] - x, q[1] - y, q[2] - z); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
    e[v] = isFinite(d2) ? (d2 - d1) / 2 : 1e4;
  }
  // two one-ring passes round the cells' corners
  for (let p = 0; p < 2; p++) {
    const t = new Float32Array(V);
    for (let v = 0; v < V; v++) { if (cov[v] <= 0) { t[v] = e[v]; continue; } let s = e[v], n = 1; for (let k = off[v]; k < off[v + 1]; k++) if (cov[nbr[k]] > 0) { s += e[nbr[k]]; n++; } t[v] = s / n; }
    e = t;
  }
  const border = Math.max(0, op.borderMM != null ? op.borderMM : 6);
  const sd = signedDistanceToContour(cov, adj, P);
  const out = new Float32Array(V);
  for (let v = 0; v < V; v++) {
    if (cov[v] <= 0) continue;
    const a = e[v] - half, b = -sd[v] - border, k = half;
    const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
    const g = b + (a - b) * h - k * h * (1 - h);   // smooth min: the strap meets the border with a fillet
    out[v] = Math.min(cov[v], Math.max(0, Math.min(1, 0.5 - g / edge)));
  }
  return { coverage: out, info: { kind: op.kind, seeds: seeds.length, strapMM: +(2 * half).toFixed(2), held: half > wantHalf + 1e-6, edgeMM: +edge.toFixed(2), halfMM: half } };
}

export function buildPlate(last, coverage, opts = {}) {
  const o = { ...PLATE_DEFAULTS, ...opts };
  const T0 = now(), timings = {};
  const P = last.positions, V = P.length / 3;
  const q = quadsOfLast(last.indices);
  if (!q.ok) return { ok: false, reason: q.reason, message: q.detail };
  const quads = q.quads;
  const adj = quadAdjacency(P, quads);
  const normals = vertexNormals(P, last.indices);
  const dirs = o.directions || smoothDirections(normals, adj, o.dirSmooth);
  timings.setup = now() - T0;

  // the coverage the plate is cut to: the painted field, or its edge-patterned rebuild
  let cov = coverage, edgeInfo = null, edgeD = null;
  if (o.edge && o.edge.kind && o.edge.kind !== 'none' && o.edge.amountMM > 0) {
    const t = now();
    const e = edgePatternedCoverage(coverage, o.edge, { positions: P, quads, adj });
    cov = e.coverage; edgeD = e.moved; edgeInfo = { moved: !!e.moved, refused: e.refused || null, ceiling: e.ceiling || null };
    timings.edge = now() - t;
  }
  let openInfo = null;
  if (o.openings && o.openings.kind && o.openings.kind !== 'none') {
    const t = now();
    const r = openingsCoverage(cov, o.openings, { positions: P, adj });
    cov = r.coverage; openInfo = r.info;
    timings.openings = now() - t;
  }
  const inRegion = new Uint8Array(V); let covered = 0;
  for (let i = 0; i < V; i++) if (cov[i] >= 0.5) { inRegion[i] = 1; covered++; }
  if (!covered) return { ok: false, reason: 'empty', message: 'Nothing is painted yet.' };
  const sd = signedDistanceToContour(cov, adj, P);
  // the region's boundary ring IS the rim once the lift snaps it onto the
  // contour, so every falloff reads it at 0 rather than a ring in
  for (let v = 0; v < V; v++) if (inRegion[v]) for (let k = adj.off[v]; k < adj.off[v + 1]; k++) if (!inRegion[adj.nbr[k]]) { sd[v] = 0; break; }

  // THE WALL, per source vertex
  const t1 = now();
  const th = new Float32Array(V), gap = new Float32Array(V);
  for (let i = 0; i < V; i++) { th[i] = typeof o.wall === 'number' ? o.wall : o.wall[i]; gap[i] = typeof o.gap === 'number' ? o.gap : o.gap[i]; }
  let shade = null, puff = null, pat = null, tex = null, texInfo = null, skive = null;
  if (o.light && o.light.mm > 0) { shade = lightShade(dirs, o.light, V); for (let i = 0; i < V; i++) th[i] += o.light.mm * shade[i]; }
  // the wall's top before the puff: the puff's smoothing caps the puffed
  // outer at this plus the dome, not at the dial's number — a terrainer's
  // wall is the range, 76 mm and more, and a cap read from a 6 mm dial
  // flattened it to 14
  let thTop = 0; for (let i = 0; i < V; i++) if (inRegion[i] && th[i] > thTop) thTop = th[i];
  if (o.puff && o.puff.mm > 0) { puff = puffWall(inRegion, sd, o.puff, adj); for (let i = 0; i < V; i++) th[i] += puff.wall[i]; }
  // ROUND: a strap's wall a dome over its own width — the distance to the
  // nearest opening or rim, capped at half a strap, under a quarter circle
  let round = null;
  if (openInfo && o.openings.round > 0) {
    round = new Float32Array(V); const w = openInfo.halfMM, H = o.openings.round * w;
    for (let i = 0; i < V; i++) { if (!inRegion[i]) continue; const u = 1 - Math.min(-sd[i], w) / w; round[i] = H * Math.sqrt(Math.max(0, 1 - u * u)); th[i] += round[i]; }
  }
  if (o.pattern && o.pattern.kind && o.pattern.kind !== 'flat' && o.pattern.hiMM > 0) { pat = patternWall(inRegion, sd, o.pattern, { positions: P, normals: dirs, adj }); for (let i = 0; i < V; i++) th[i] += pat[i]; }
  // the terrain's place: handed in loaded (the worker fetches it by key), else the module's own store
  if (o.terrain && o.terrain.key && o.terrain.hiMM > 0) {
    const place = o.terrain.place || loadedPlace(o.terrain.key);
    if (place && place.grid) { const t = terrainTextureWall(inRegion, sd, o.terrain, place, { positions: P, adj }); tex = t.wall; texInfo = t.stats; for (let i = 0; i < V; i++) th[i] += tex[i]; }
    else texInfo = { key: o.terrain.key, loaded: false, error: o.terrain.error || 'the place is not loaded' };
  }
  // THE DECKLE'S SKIVE (MASQ shell.js skiveFraction on edgepattern.js's
  // skiveWidths): a torn sheet thins toward its edge, so the wall stands at
  // minWall on the rim and rises to its full over L(v) = 3·(1 + couple·D̂) mm,
  // D̂ the edge's excursion normalised to −1..1 — the lobes that protrude
  // furthest taper over the longest run and the notches stay crisp
  if (edgeD && o.edge.kind === 'deckle') {
    const L = skiveWidths(edgeD, V, SKIVE_MM, o.edge.couple || 0, o.edge.amountMM);
    skive = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      if (!inRegion[i]) continue;
      const f = Math.max(0, Math.min(1, -sd[i] / L[i]));
      skive[i] = L[i];
      th[i] = o.minWall + f * (th[i] - o.minWall);
    }
  }
  let held = 0, allow = null;
  if (o.guard) {
    allow = foldAllowance(P, normals, adj);
    for (let i = 0; i < V; i++) {
      if (puff && puff.wall[i] > 0) continue;   // a puffed wall is guarded on its own surface below
      if (gap[i] + th[i] > allow[i]) { held++; th[i] = Math.max(o.minWall, Math.min(th[i], allow[i] - gap[i])); gap[i] = Math.max(0, Math.min(gap[i], allow[i] - th[i])); }
    }
  }
  for (let i = 0; i < V; i++) if (th[i] < o.minWall) th[i] = o.minWall;
  if (puff) {
    const Hmax = Math.max(1, ...puff.pieces.map((p) => p.heightMM));
    smoothPuffedOuter(th, puff.wall, puff.ring, dirs, P, adj, puff.passes, Math.min(GUARD_CAP_MM, 2 * Hmax) + thTop, o.minWall);
  }
  timings.wall = now() - t1;

  // THE LIFT (Pgon's construction, MASQ's per-vertex wall), then CC
  const t2 = now();
  const lc = liftCage(P, quads, dirs, cov, th, gap, o);
  if (!lc.ok) return { ok: false, reason: lc.reason, message: lc.message, stats: lc.stats };
  const cage = lc.cage;
  const seat = reseatOnLast(cage, P, o.field || lastField(P, last.indices), dirs, gap);
  if (o.deform) applyDeformation(cage.positions, cage.sheetCount, o.deform, o.landmarks);
  const treadOn = !!(o.tread && o.tread.pattern && o.tread.pattern !== 'none');
  const sub = subdivideCage(cage, o.levels, o.extra, treadOn && o.tread.mask && o.tread.mask.length ? o.tread.mask : null, treadOn ? th : null);
  const detail = o.terrainDetail != null ? o.terrainDetail : 0;
  if (detail > 0 && o.terrainWall && o.terrainWall.valley && sub.extra) {
    const P = sub.positions, n = P.length / 3, tw = o.terrainWall;
    const yG = tw.yGround;
    for (let i = 0; i < n; i++) {
      if (sub.sheet[i] >= 0.99 && sub.extra[i] > 0.5) {
        const x = P[i * 3], z = P[i * 3 + 2];
        const targetY = yG(x) + tw.valley(x, z);
        const curY = P[i * 3 + 1];
        const w = smoothstep((sub.extra[i] - 0.5) / 0.4);
        P[i * 3 + 1] = curY + w * detail * (targetY - curY);
      }
    }
  }
  // THE TREAD (swarf's texture core, shoe/tex.mjs): a height pattern on the plan chart, cut into the
  // outer sheet (Carved) or stood up from it (Raised) AFTER subdivision, where the mesh is ~1 mm an edge
  // and a 3 mm lug survives (on the cage, ~5 mm an edge, CC smooths it away). Faded in from the rim.
  let treadInfo = null;
  if (treadOn) {
    let wMin = Infinity; for (let i = 0; i < V; i++) if (inRegion[i] && th[i] < wMin) wMin = th[i];
    treadInfo = applyTread(sub, o.tread, { wallMM: Number.isFinite(wMin) ? wMin : 2, minWall: o.minWall });
  }
  timings.lift = now() - t2;
  const t3 = now();
  // the cage's sheets: the outer is its first sheetFaces quads over vertices
  // [0, nv), the inner the next sheetFaces over [nv, 2nv), the rim rings after;
  // the rims are the outer sheet's boundary loops
  const rims = boundaryLoops(cage.quads.subarray(0, cage.sheetFaces * 4), cage.sheetCount);
  const limitNormals = computeQuadNormals(sub.positions, sub.quads);
  const dh = dihedralStats(sub.positions, sub.quads);
  timings.measure = now() - t3;

  // PERFORATIONS (shoe/perforate.mjs): holes laid on the last from the region and punched through the built sheets.
  // The pitch is held at what the limit mesh can cut (two radii and 2.4 of its edges) and the stats say so.
  let limit = { positions: sub.positions, quads: sub.quads, indices: sub.indices, normals: limitNormals, sheet: sub.sheet, extra: sub.extra || null, roof: sub.roof || null, treadCurves: sub.treadCurves || null }, perfInfo = null;
  if (o.perforate && o.perforate.kind && o.perforate.kind !== 'none') {
    const tp = now(), pf = o.perforate, r = Math.max(0.4, (pf.holeMM || 3) / 2);
    let e = 0, ne = 0; for (let t = 0; t < sub.indices.length / 3 && ne < 3000; t += 11) { const a = sub.indices[t * 3] * 3, b = sub.indices[t * 3 + 1] * 3; e += Math.hypot(sub.positions[a] - sub.positions[b], sub.positions[a + 1] - sub.positions[b + 1], sub.positions[a + 2] - sub.positions[b + 2]); ne++; }
    const edgeMM = e / Math.max(1, ne), floorPitch = 2 * r + 2.4 * edgeMM, pitch = Math.max(pf.pitchMM || 8, floorPitch);
    // pierce where painted: a field per vertex; an EMPTY one (the channel not painted yet) lays no holes at all
    const mask = pf.mask && pf.mask.length === V ? pf.mask : pf.mask && pf.mask.length === 0 ? new Float32Array(V) : null;
    const holes = layHoles(P, cov, sd, { kind: pf.kind, radius: r, pitch, border: pf.borderMM, offset: pf.offsetMM, seed: pf.seed, max: 800, mask });
    const attrs = {}; if (limit.sheet) attrs.sheet = limit.sheet; if (limit.extra) attrs.extra = limit.extra; if (limit.roof) attrs.roof = limit.roof;
    // the thinnest wall over the region (o.wall may be one number or a per-vertex array)
    let wMin = Infinity; for (let i = 0; i < V; i++) if (inRegion[i] && th[i] < wMin) wMin = th[i];
    // no hole laid (nothing painted, a border wider than the piece): the piece is left exactly as built
    const out = holes.length ? perforate({ positions: limit.positions, indices: limit.indices, attrs }, { positions: P, normals }, holes, { wallMM: Number.isFinite(wMin) ? wMin : 1.8 }) : null;
    if (out) {
      const vn = new Float32Array(out.positions.length);
      for (let t = 0; t < out.indices.length / 3; t++) { const a = out.indices[t * 3] * 3, b = out.indices[t * 3 + 1] * 3, c = out.indices[t * 3 + 2] * 3, X = out.positions;
        const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; for (const q of [a, b, c]) { vn[q] += nx; vn[q + 1] += ny; vn[q + 2] += nz; } }
      for (let i = 0; i < vn.length; i += 3) { const l = Math.hypot(vn[i], vn[i + 1], vn[i + 2]) || 1; vn[i] /= l; vn[i + 1] /= l; vn[i + 2] /= l; }
      // the quads no longer describe the punched sheets: consumers read the triangles (positions, indices)
      limit = { positions: out.positions, quads: null, indices: out.indices, normals: vn, sheet: out.attrs.sheet || null, extra: out.attrs.extra || null, roof: out.attrs.roof ? Uint8Array.from(out.attrs.roof) : null, treadCurves: limit.treadCurves, perforated: true, bore: out.bore, from: out.from, holes: out.cuts };
    }
    const why = {}; if (out) for (const k of out.skipped) why[k.reason] = (why[k.reason] || 0) + 1;
    perfInfo = { kind: pf.kind, masked: !!mask, asked: holes.length, punched: out ? out.punched.length : 0, skipped: why, holeMM: 2 * r, pitchMM: +pitch.toFixed(1), held: pitch > (pf.pitchMM || 8) + 1e-6, edgeMM: +edgeMM.toFixed(2) };
    timings.perforate = now() - tp;
  }
  // the wall's range over the region
  const inW = []; for (let i = 0; i < V; i++) if (inRegion[i]) inW.push(th[i]); inW.sort((a, b) => a - b);
  const wallStats = inW.length ? { min: inW[0], median: inW[inW.length >> 1], max: inW[inW.length - 1] } : null;
  timings.total = now() - T0;
  return {
    ok: true,
    cage: { ...cage, rims },
    limit,
    wall: th, gap, coverage: cov, directions: dirs, shade, puff: puff ? { wall: puff.wall, pieces: puff.pieces } : null, pattern: pat, texture: tex, skive, allow,
    stats: {
      cageQuads: cage.quads.length / 4, faces: sub.quads.length / 4, levels: sub.levels, loops: lc.stats.loops, folds: lc.stats.inverted, invertedAt: lc.stats.invertedAt, foldsAtMM: lc.stats.foldsAt / MM,
      held, wall: wallStats, thinnest: wallStats ? wallStats.min : 0, dihedral: dh, covered, edge: edgeInfo, openings: openInfo, perforations: perfInfo, tread: treadInfo, texture: texInfo, reseated: seat,
      perimeterRatio: lc.stats.perimeterRatio, rimRows: lc.stats.rimRows, closed: !lc.stats.openEdges && !lc.stats.inconsistent && lc.stats.components === 1, openEdges: lc.stats.openEdges, inconsistent: lc.stats.inconsistent, components: lc.stats.components,
      timings,
    },
  };
}

// ── THE TERRAINER AS A PLATE ──────────────────────────────────────────────
// The sole is the same plate: the region (the sole set and a climb above the
// feather line) offset per vertex so that its OUTER surface is the ground.
// Three bands of source vertices, one direction and one thickness each:
//
//   floor   sole vertices deeper than `fanHops` rings in: straight DOWN to
//           y_out = y_ground(x) + valley(x, z) — the range hung under the
//           foot, its summits levelled AT the ground as the contact — held
//           at the skirt's hem where it stands above it, SKIRT_FLAT_MM in
//           from the curtain's foot and blended over SKIRT_BLEND_MM beyond;
//   curtain the sole's outer `fanHops` rings: onto a curtain hung from the
//           feather line's plan outline, `wallMM` + relief out, at depths
//           1/fanHops .. 1 of the way from the feather to the curtain's foot;
//   side    vertices above the feather within the climb: along the smoothed
//           normal by (wallMM + relief)·fade, 1 a climb below the rim and
//           0 at the rim, so the sole thins into the upper with no ledge.
//
// The ground is a profile along the length, not a plane:
//   y_ground(x) = base(x) + toe·s_toe(x)² + heel·s_heel(x)², the springs
//   rising quadratically past their start stations (tangent to the flat
//   between); base(x) is one level `y`, or the line from `stackHeelMM` under
//   the tread at the heel station to `stackToeMM` at the toe station — a
//   heel stack past the toe stack hangs the range deeper at the heel.
// THE SKIRT: the curtain's hem is `skirt` of the way from the feather line
// to the ground, y_hem = FY − skirt·(FY − y_ground); the curtain's foot is
// the floor's height at its plan point, the hem at most, so at skirt 1 the
// curtain reaches the ground all round and at skirt 0 the range's own
// outline is the cut — a peak at the edge drops to the ground, a valley at
// the edge is open to the side. Where the floor stands above the hem it is
// held AT the hem for SKIRT_FLAT_MM in from the curtain's foot (the foot
// ring and two floor rows: a Catmull-Clark vertex's limit reaches a plane
// only when its whole one-ring lies in it) and blended up to the range over
// SKIRT_BLEND_MM beyond, so the floor's edge IS the foot and the hem stands
// on the ground at skirt 1. Where the curtain is shorter than
// fanHops·RING_MM the rings walk on inward along the floor at RING_MM, so
// no two ring vertices share a point.
// CHARTS: the floor samples on the last's own (x, z) normalised over the
// sole set's bounding box; the side and the curtain sample on (u, v) with u
// the arc length round the feather line (0..1, the samplers are periodic in
// u so u = 0 is no seam) and v the height from the ground (0) to the top of
// the climb (1). The two charts meet along the floor's outer edge, where
// the curtain bottom takes the floor's height and the floor its plan: the
// position field is continuous there and the seam is a corner, not a step.
export const TERRAIN_DEFAULTS = {
  // `summits` is read as `contact` when `contact` is absent; `y` is the
  // base when both stacks are absent
  // `curve` sharpens the floor's spires (the sampled height raised to it before the contact is levelled)
  // `stance` levels contact pads on the ground where a shoe stands — 3: the
  // heel and both sides of the ball; 5: both sides of the heel, both sides
  // of the ball and the toe — so the range never rocks on a cluster;
  // `padMM` a pad's radius, blended over as much again
  // `roofMM`: the sole under the foot is never thinner than this — a valley
  // that would reach the tread stops a roof short (a tear leaves a roof)
  ground: { y: 0, stackHeelMM: null, stackToeMM: null, contact: 0.10, depth: 0, sample: null, toeSpringMM: 0, heelSpringMM: 0, toeStartFrac: 0.72, heelStartFrac: 0.2, rocker: 0, curve: 1, stance: 0, padMM: 14, roofMM: 4, wearMM: 0 },
  // `stretch` elongates the sidewall's relief down the wall: 1 round, 4 drips;
  // `flare` tilts the sidewall's growth: 1 straight out along the wall's
  // normal, 0 straight down toward the ground (the relief hangs), between
  // a flare that leans out as it falls
  terrain: { sample: null, amp: 0, stretch: 1, flare: 1 },
  skirt: 1,
  climbMM: 40, wallMM: 6, minWall: 0.4, rimMM: 0.25, fanHops: 3, dirSmooth: 4, wearMM: 0,
};
const SKIRT_FLAT_MM = 18, SKIRT_BLEND_MM = 12, RING_MM = 1.5;
const SIDE_NORMAL_MM = 2;   // a tilted (flare < 1) side keeps this much of its growth along the last's normal

export function groundProfile(lm, g) {
  const x0 = lm.heelX, x1 = lm.toeX, L = x1 - x0;
  const xToeStart = x0 + L * (g.toeStartFrac == null ? 0.72 : g.toeStartFrac), xHeelStart = x0 + L * (g.heelStartFrac == null ? 0.2 : g.heelStartFrac);
  const toe = g.toeSpringMM || 0, heel = g.heelSpringMM || 0;
  const stepMM = Math.max(0, g.stepMM || g.step || 0);
  const xBall = lm.xBall != null ? lm.xBall : (x0 + L * 0.68);
  // the base: with stepMM == 0, the line between the two stacks carried straight on past
  // both stations; with stepMM > 0, an architectural heel block that steps at x0 + stepMM
  const sh = g.stackHeelMM != null ? g.stackHeelMM : g.stackToeMM, st = g.stackToeMM != null ? g.stackToeMM : g.stackHeelMM;
  let base;
  if (sh != null) {
    if (stepMM > 0) {
      const xStep = x0 + stepMM;
      const trans = Math.min(12, Math.max(4, stepMM * 0.2));
      base = (x) => {
        const t = Math.max(0, Math.min(1, (x - (xStep - trans * 0.5)) / trans));
        const s = t * t * (3 - 2 * t);
        const stackAtX = sh + (st - sh) * s;
        return lm.treadY - stackAtX;
      };
    } else if (g.couplePitch) {
      const heelY = lm.featherYAt ? lm.featherYAt(x0) : (lm.treadY || 0);
      const lastPitch = Math.max(0, heelY - (lm.treadY || 0));
      const drop = sh - st;
      // the floor tilts only to raise the heel past the last's own pitch (heel height = max(sh, st + pitch)); equal stacks stay level
      const remTilt = Math.max(0, drop - lastPitch);
      base = (x) => lm.treadY - st - remTilt * Math.max(0, (1 - (x - x0) / Math.max(1e-6, L)));
    } else {
      base = (x) => lm.treadY - sh - (st - sh) * (x - x0) / Math.max(1e-6, L);
    }
  } else {
    base = () => g.y || 0;
  }
  // s runs 0 at the start station to 1 at the toe (heel) and ON past it
  const f = (x) => {
    let yCurve = 0;
    if (g.rocker && g.rocker > 0) {
      const r = g.rocker;
      const dx = x - xBall;
      const arc = r - Math.sqrt(Math.max(0, r * r - dx * dx));
      if (stepMM > 0) {
        if (dx > 0) {
          const stRocker = Math.max(0, (x - xBall) / Math.max(1e-6, x1 - xBall));
          yCurve = Math.max(arc, toe * stRocker * stRocker);
        } else {
          const sh_ = Math.max(0, (xHeelStart - x) / Math.max(1e-6, xHeelStart - x0));
          yCurve = heel * sh_ * sh_;
        }
      } else {
        if (dx >= 0) {
          const stRocker = Math.max(0, (x - xBall) / Math.max(1e-6, x1 - xBall));
          yCurve = Math.max(arc, toe * stRocker * stRocker);
        } else {
          const shRocker = Math.max(0, (xBall - x) / Math.max(1e-6, xBall - x0));
          yCurve = Math.max(arc, heel * shRocker * shRocker);
        }
      }
    } else {
      const st_ = Math.max(0, (x - xToeStart) / Math.max(1e-6, x1 - xToeStart));
      const sh_ = Math.max(0, (xHeelStart - x) / Math.max(1e-6, xHeelStart - x0));
      yCurve = toe * st_ * st_ + heel * sh_ * sh_;
    }
    return base(x) + yCurve;
  };
  f.xToeStart = xToeStart; f.xHeelStart = xHeelStart; f.xBall = xBall; f.base = base; f.stackHeelMM = sh; f.stackToeMM = st; f.stepMM = stepMM; f.rocker = g.rocker || 0;
  return f;
}

/**
 * terrainWall(last, coverage, lm, opts) → { thickness, directions, yGround, floor, stats }
 * lm: lastLandmarks(last). The result's thickness/directions go straight to
 * buildPlate as { wall, directions, guard: false, rim: 0 }.
 */
export function terrainWall(last, coverage, lm, opts = {}) {
  const og = opts.ground || {};
  const o = { ...TERRAIN_DEFAULTS, ...opts, ground: { ...TERRAIN_DEFAULTS.ground, ...og }, terrain: { ...TERRAIN_DEFAULTS.terrain, ...(opts.terrain || {}) } };
  const P = last.positions, V = P.length / 3;
  const q = quadsOfLast(last.indices);
  if (!q.ok) return { ok: false, reason: q.reason, message: q.detail };
  const adj = quadAdjacency(P, q.quads);
  const dirs = smoothDirections(vertexNormals(P, last.indices), adj, o.dirSmooth);
  const inRegion = new Uint8Array(V); for (let i = 0; i < V; i++) inRegion[i] = coverage[i] >= 0.5 ? 1 : 0;
  // the side wall fades over the climb BELOW THE RIM: the region's own
  // distance to its contour, the boundary ring read at 0 (it is the rim once
  // the lift snaps it onto the contour), so the wall at the rim is exactly rimMM
  const sd = signedDistanceToContour(coverage, adj, P);
  for (let v = 0; v < V; v++) if (inRegion[v]) for (let k = adj.off[v]; k < adj.off[v + 1]; k++) if (!inRegion[adj.nbr[k]]) { sd[v] = 0; break; }
  const yGround = groundProfile(lm, o.ground);
  const skirt = Math.max(0, Math.min(1, o.skirt == null ? 1 : o.skirt));

  // the feather line in plan: its ordered points, arc parameter, smoothed
  // outline and plan-outward direction (ground.mjs's reach rule)
  const fp = lm.featherPts, K = fp.length / 3;
  if (K < 8) return { ok: false, reason: 'feather', message: 'the feather line has too few points' };
  const fx = new Float64Array(K), fy = new Float64Array(K), fz = new Float64Array(K);
  for (let k = 0; k < K; k++) { fx[k] = fp[k * 3]; fy[k] = fp[k * 3 + 1]; fz[k] = fp[k * 3 + 2]; }
  const uArc = new Float64Array(K); let arc = 0;
  for (let k = 0; k < K; k++) { uArc[k] = arc; const j = (k + 1) % K; arc += Math.hypot(fx[j] - fx[k], fz[j] - fz[k]); }
  for (let k = 0; k < K; k++) uArc[k] /= arc || 1;
  let sx = Float64Array.from(fx), sz = Float64Array.from(fz);
  for (let pass = 0; pass < 24; pass++) {
    const nx = new Float64Array(K), nz = new Float64Array(K);
    for (let k = 0; k < K; k++) { const a = (k + K - 1) % K, b = (k + 1) % K; nx[k] = (sx[a] + sx[k] + sx[b]) / 3; nz[k] = (sz[a] + sz[k] + sz[b]) / 3; }
    sx = nx; sz = nz;
  }
  let area = 0; for (let k = 0; k < K; k++) { const j = (k + 1) % K; area += sx[k] * sz[j] - sx[j] * sz[k]; }
  const mx = new Float64Array(K), mz = new Float64Array(K), reach = 3;
  for (let k = 0; k < K; k++) {
    let ka = (k + K - 1) % K, kb = (k + 1) % K;
    for (let s = 1; s < K / 4 && Math.hypot(fx[k] - fx[ka], fz[k] - fz[ka]) < reach; s++) ka = (k + K - s) % K;
    for (let s = 1; s < K / 4 && Math.hypot(fx[k] - fx[kb], fz[k] - fz[kb]) < reach; s++) kb = (k + s) % K;
    let tx = sx[kb] - sx[ka], tz = sz[kb] - sz[ka]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const sgn = area > 0 ? 1 : -1; mx[k] = tz * sgn; mz[k] = -tx * sgn;
  }
  // the nearest point ON the feather polyline (a segment and a fraction along
  // it), with u, the height, the plan point and the outward direction
  // interpolated there: snapped to the nearest feather VERTEX, two ring
  // vertices that shared one landed on one curtain point — a zero-length
  // cage edge OpenNURBS refuses as a SubD
  const nearestFeather = (x, z) => {
    let bk = 0, bt = 0, bd = Infinity;
    for (let k = 0; k < K; k++) {
      const j = (k + 1) % K, ex = fx[j] - fx[k], ez = fz[j] - fz[k], l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? ((x - fx[k]) * ex + (z - fz[k]) * ez) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = (x - fx[k] - ex * t) ** 2 + (z - fz[k] - ez * t) ** 2;
      if (d < bd) { bd = d; bk = k; bt = t; }
    }
    const j = (bk + 1) % K, uj = j === 0 ? 1 : uArc[j];
    let ox = mx[bk] + (mx[j] - mx[bk]) * bt, oz = mz[bk] + (mz[j] - mz[bk]) * bt; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    return { u: uArc[bk] + (uj - uArc[bk]) * bt, x: fx[bk] + (fx[j] - fx[bk]) * bt, y: fy[bk] + (fy[j] - fy[bk]) * bt, z: fz[bk] + (fz[j] - fz[bk]) * bt, ox, oz };
  };

  // the floor chart and its levelled contact: the top `contact` of the
  // floor's heights (its band's vertices) sit ON the ground, the rest rise
  // toward the tread by depth·smoothstep of their drop below that level
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < V; i++) if (lm.sole[i]) { const x = P[i * 3], z = P[i * 3 + 2]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  const g = o.ground, gs = g.sample;
  const avgStack = Math.max(10, (((g.stackHeelMM || 90) + (g.stackToeMM || 90)) / 2));
  const depthShare = g.depthShare != null ? g.depthShare : (g.depth != null && g.depth <= 1.0 ? g.depth : (g.depth ? g.depth / avgStack : 0));
  const depth = g.depth != null && g.depth > 1.0 ? g.depth : (depthShare * avgStack);
  const gamma = og.curve > 0 ? og.curve : 1, roof = Math.max(o.minWall, og.roofMM != null ? og.roofMM : Math.max(4.0, 3 * (o.minWall || 1.5)));
  const floorSample = (x, z) => (gs && depth > 0 ? Math.pow(Math.max(0, Math.min(1, gs((x - minX) / Math.max(1, maxX - minX), (z - minZ) / Math.max(1, maxZ - minZ)))), gamma) : 1);
  const hopOf = (i) => (lm.sole[i] ? -lm.featherField[i] : 0);
  const heights = []; for (let i = 0; i < V; i++) if (lm.sole[i] && inRegion[i] && hopOf(i) > o.fanHops) heights.push(floorSample(P[i * 3], P[i * 3 + 2]));
  heights.sort((a, b) => a - b);
  const contact = og.cutAt != null && depth > 0
    ? Math.max(0.01, Math.min(0.95, og.cutAt / depth))
    : Math.max(0.02, Math.min(0.98, og.contact != null ? og.contact : og.summits != null ? og.summits : TERRAIN_DEFAULTS.ground.contact));
  const level = heights.length ? heights[Math.min(heights.length - 1, Math.floor(heights.length * (1 - contact)))] : 1;
  // the stance's pads: the sole set's plan box, the pads at trade stations
  // (heel 0.2, ball 0.66, toe 0.8 of the length; 0.28 / 0.72 across), or natural mountain summits
  const STANCES = { 3: [[0.2, 0.5], [0.66, 0.26], [0.66, 0.74]], 5: [[0.2, 0.32], [0.2, 0.68], [0.66, 0.24], [0.66, 0.76], [0.8, 0.5]] };
  const isSummitsStance = og.stance === 'summits' || og.stance === '1' || og.stance === 1;
  const pads = isSummitsStance ? [] : (STANCES[og.stance | 0] || []).map(([fx, fz]) => [minX + fx * (maxX - minX), minZ + fz * (maxZ - minZ)]);
  const padR = og.padMM > 0 ? og.padMM : TERRAIN_DEFAULTS.ground.padMM;
  const padWeight = (x, z) => { let w = 0; for (const [px, pz] of pads) { const d = Math.hypot(x - px, z - pz); if (d < padR) return 1; if (d < 2 * padR) w = Math.max(w, 1 - smoothstep((d - padR) / padR)); } return w; };
  const wearMM = Math.max(0, og.wearMM != null ? og.wearMM : (o.wearMM != null ? o.wearMM : (opts.wear != null ? opts.wear : 0)));
  const localDepthAt = (x) => {
    if (depthShare > 0) {
      const gy = yGround(x);
      const n = nearestFeather(x, 0);
      const H = Math.max(10, n.y - gy);
      return depthShare * H;
    }
    return depth;
  };
  const rawValley = (x, z) => {
    if (!(depth > 0 && level > 1e-6)) return 0;
    const dVal = localDepthAt(x);
    const v = dVal * smoothstep((level - floorSample(x, z)) / level);
    const w = pads.length ? padWeight(x, z) : 0;
    return w > 0 ? v * (1 - w) : v;
  };
  const valley = (x, z) => {
    const v0 = rawValley(x, z);
    if (!(wearMM > 0) || !(depth > 0)) return v0;
    if (v0 > wearMM * 2.5) return v0;
    let minV = v0;
    const inv2R = 1 / (2 * wearMM);
    const numDirs = 12;
    const stepRad = [0.35 * wearMM, 0.7 * wearMM, wearMM];
    for (let s = 0; s < stepRad.length; s++) {
      const r = stepRad[s];
      const quadCost = r * r * inv2R;
      if (quadCost >= minV) continue;
      const dAngle = (2 * Math.PI) / numDirs;
      const offsetAngle = s * (dAngle / 3);
      for (let k = 0; k < numDirs; k++) {
        const ang = offsetAngle + k * dAngle;
        const sx = x + Math.cos(ang) * r;
        const sz = z + Math.sin(ang) * r;
        const sv = rawValley(sx, sz) + quadCost;
        if (sv < minV) minV = sv;
      }
    }
    return minV;
  };
  // the floor's height at a plan point `d` mm in from the curtain's foot,
  // held at the hem over the flat and blended beyond; `FY` the feather's
  // height there
  const floorAt = (x, z, d, FY) => {
    const gy = yGround(x), h = gy + valley(x, z);
    if (!(skirt > 0) || d >= SKIRT_FLAT_MM + SKIRT_BLEND_MM) return h;
    const hem = FY - skirt * (FY - gy);
    return h - Math.max(0, h - hem) * (1 - smoothstep((d - SKIRT_FLAT_MM) / SKIRT_BLEND_MM));
  };
  // the side chart, signed flare and stalactite tear
  const t = o.terrain, amp = t.amp || 0;
  const stretch = t.stretch > 0 ? t.stretch : 1;
  const rawFlare = t.flare == null ? (o.flare == null ? 0 : o.flare) : t.flare;
  const flareLat = typeof rawFlare === 'number' ? rawFlare : 0;
  const flareProfile = o.flareStations || (o.terrain && o.terrain.flareStations) || t.flareStations || (t.terrain && t.terrain.flareStations) || t.flareProfile || o.flareProfile || null;
  const flareAt = (u) => {
    if (!flareProfile || !flareProfile.some((v) => v)) return 0;
    return profileAt(flareProfile, u);
  };
  const tear = Math.max(0, Math.min(1, o.tear != null ? o.tear : (t.tear != null ? t.tear : 0)));
  const relief = (u, y, featherY, gy) => {
    if (!(amp > 0) || !t.sample) return 0;
    const v = (y - gy) / Math.max(1, featherY + o.climbMM - gy);
    // u runs `stretch` times faster than v: features narrow round the wall and tall down it
    const uu = (u * stretch) % 1;
    return amp * Math.max(0, Math.min(1, t.sample((uu + 1) % 1, Math.max(0, Math.min(1, v)))));
  };
  const fade = (i) => smoothstep(-sd[i] / Math.max(1e-6, o.climbMM));

  const thickness = new Float32Array(V), out = new Float32Array(V * 3);
  const band = new Uint8Array(V);   // 1 floor, 2 curtain, 3 side
  let floorN = 0, curtainN = 0, sideN = 0, contactN = 0, walkedN = 0;
  for (let i = 0; i < V; i++) {
    out[i * 3] = dirs[i * 3]; out[i * 3 + 1] = dirs[i * 3 + 1]; out[i * 3 + 2] = dirs[i * 3 + 2];
    if (!inRegion[i]) continue;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const hop = hopOf(i);
    let tx, ty, tz;
    if (lm.sole[i] && hop > o.fanHops) {
      band[i] = 1; floorN++;
      // the floor's two outer rows spread halfway and a quarter of the way
      // toward the curtain's foot, so the margin quad is not three times its
      // neighbours: the limit surface across a 15 mm row beside 5 mm rows
      // undershot the ground profile by 0.3 mm
      tx = x; tz = z;
      const n = nearestFeather(x, z);
      const spread = hop === o.fanHops + 1 ? 0.5 : hop === o.fanHops + 2 ? 0.25 : 0;
      if (spread) {
        const spreadFlare = flareLat + flareAt(n.u);
        const gy = yGround(n.x);
        const footRelief = relief(n.u, gy, n.y, gy);
        const spreadWidth = o.wallMM + footRelief + spreadFlare;
        tx += (n.x + n.ox * spreadWidth - x) * spread;
        tz += (n.z + n.oz * spreadWidth - z) * spread;
      }
      const vy = valley(tx, tz); if (vy < 1e-6) contactN++;
      ty = floorAt(tx, tz, Math.hypot(tx - n.x, tz - n.z) + o.wallMM, n.y);
      if (ty > y - roof) ty = y - roof;
    } else {
      const n = nearestFeather(x, z), u = n.u, FY = n.y;
      if (lm.sole[i]) {
        band[i] = 2; curtainN++;
        const f = hop / o.fanHops;
        // the relief sets where the curtain stands, and the floor's height is
        // read THERE: read at the bare wall, a 8 mm ridge at the toe stood
        // 2 mm under a rising spring
        const bx = n.x + n.ox * o.wallMM, gy = yGround(bx);
        const rootFillet = tear > 0 ? (1 - f) * Math.min(1.5, o.wallMM * 0.5) : 0;
        const totalFlare = flareLat + flareAt(u);
        // the relief is read between the feather and the hem and drawn down the curtain;
        // a torn curtain reads it all the way down, so each stalactite carries one drip
        const hem = Math.min(FY - o.minWall, FY - skirt * (FY - gy));
        const yRead = tear > 0 ? FY - f * (FY - gy) : FY + (hem - FY) * f;
        const lat = o.wallMM + relief(u, yRead, FY, gy) + totalFlare * f + rootFillet;
        const px = n.x + n.ox * lat, pz = n.z + n.oz * lat;
        let yFoot = Math.min(floorAt(px, pz, 0, FY), FY - o.minWall);
        if (tear > 0 && depth > 0) {
          const vy = valley(px, pz);
          if (vy > 0) {
            const dVal = localDepthAt(px);
            // Self-supporting arch curve (steepens flanks to >= 45° for clean supportless printing)
            const vRatio = Math.pow(Math.min(1, vy / Math.max(1, dVal)), 1.4);
            const tearLift = tear * vRatio * (FY - o.minWall - yFoot);
            yFoot += tearLift;
          }
        }
        const minLc = tear > 0 ? (1 - tear) * (o.fanHops * RING_MM) : o.fanHops * RING_MM;
        const Lc = FY - yFoot, s = f * Math.max(Lc, minLc);
        if (s <= Lc) { tx = px; tz = pz; ty = FY - s; }
        else {
          const e = s - Lc; walkedN++;
          tx = n.x + n.ox * (lat - e); tz = n.z + n.oz * (lat - e);
          ty = Math.min(floorAt(tx, tz, e, FY), FY - o.minWall);
        }
      } else {
        band[i] = 3; sideN++;
        thickness[i] = Math.max(o.rimMM, (o.wallMM + relief(u, y, FY, yGround(x))) * fade(i));
        const flareTilt = (typeof rawFlare === 'number' && rawFlare >= 0 && rawFlare <= 1) ? rawFlare : (flareLat < 0 ? Math.max(0, 1 + flareLat / 20) : 1);
        if (flareTilt < 1) {
          // the growth tilted toward the ground by (1 − flareTilt), the fade
          // easing it back to the normal at the rim so the rim rolls as before
          const k = 1 - (1 - flareTilt) * fade(i);
          let ex = dirs[i * 3] * k, ey = dirs[i * 3 + 1] * k - (1 - k), ez = dirs[i * 3 + 2] * k;
          const el = Math.hypot(ex, ey, ez) || 1;
          out[i * 3] = ex / el; out[i * 3 + 1] = ey / el; out[i * 3 + 2] = ez / el;
          /* THE WALL STANDS, THE RELIEF HANGS. Tilted all the way down (flare 0), the growth leaves the side no
             thickness along the last's normal: where the last is vertical, its widest line, a Flat midsole's wall stands
             0.5 mm off the last, the join pinches it through and the Zellerfeld check reads the whole shoe as inside
             (5000+ crossing faces once carried). However far it tilts, at least min(thickness, SIDE_NORMAL_MM) of the
             growth stays along the normal. */
          const d0x = dirs[i * 3], d0y = dirs[i * 3 + 1], d0z = dirs[i * 3 + 2], dl = Math.hypot(d0x, d0y, d0z) || 1;
          const th = thickness[i], along = th * (out[i * 3] * d0x + out[i * 3 + 1] * d0y + out[i * 3 + 2] * d0z) / dl;
          const need = Math.min(th, SIDE_NORMAL_MM);
          if (along < need) {
            const vx = out[i * 3] * th + d0x / dl * (need - along), vy = out[i * 3 + 1] * th + d0y / dl * (need - along), vz = out[i * 3 + 2] * th + d0z / dl * (need - along);
            const vl = Math.hypot(vx, vy, vz) || 1;
            thickness[i] = vl; out[i * 3] = vx / vl; out[i * 3 + 1] = vy / vl; out[i * 3 + 2] = vz / vl;
          }
        }
        continue;
      }
    }
    const dx = tx - x, dy = ty - y, dz = tz - z, l = Math.hypot(dx, dy, dz);
    thickness[i] = Math.max(o.minWall, l);
    if (l > 1e-9) { out[i * 3] = dx / l; out[i * 3 + 1] = dy / l; out[i * 3 + 2] = dz / l; }
  }

  // Laplacian passes over the sidewall-to-curtain seam: two on a torn curtain (its
  // stalactites leave the seam creased), none otherwise
  const smoothPasses = o.smoothPasses != null ? o.smoothPasses : (tear > 0 ? 2 : 0);
  if (smoothPasses > 0) {
    const { off, nbr } = adj;
    const canSmooth = (v) => inRegion[v] && ((band[v] === 3 && fade(v) >= 0.15) || (band[v] === 2 && hopOf(v) <= 1) || (band[v] === 1 && valley(P[v * 3], P[v * 3 + 2]) > 0.2));
    for (let p = 0; p < smoothPasses; p++) {
      const nextDispX = new Float32Array(V);
      const nextDispY = new Float32Array(V);
      const nextDispZ = new Float32Array(V);
      for (let i = 0; i < V; i++) {
        const curX = out[i * 3] * thickness[i];
        const curY = out[i * 3 + 1] * thickness[i];
        const curZ = out[i * 3 + 2] * thickness[i];
        if (!canSmooth(i)) {
          nextDispX[i] = curX; nextDispY[i] = curY; nextDispZ[i] = curZ;
          continue;
        }
        let sumX = curX * 2, sumY = curY * 2, sumZ = curZ * 2, cnt = 2;
        for (let k = off[i]; k < off[i + 1]; k++) {
          const w = nbr[k];
          if (canSmooth(w)) {
            sumX += out[w * 3] * thickness[w];
            sumY += out[w * 3 + 1] * thickness[w];
            sumZ += out[w * 3 + 2] * thickness[w];
            cnt++;
          }
        }
        nextDispX[i] = sumX / cnt;
        nextDispY[i] = sumY / cnt;
        nextDispZ[i] = sumZ / cnt;
      }
      for (let i = 0; i < V; i++) {
        if (!canSmooth(i)) continue;
        const dx = nextDispX[i], dy = nextDispY[i], dz = nextDispZ[i];
        const l = Math.hypot(dx, dy, dz);
        if (l > 1e-6) {
          thickness[i] = Math.max(o.minWall, l);
          out[i * 3] = dx / l;
          out[i * 3 + 1] = dy / l;
          out[i * 3 + 2] = dz / l;
        }
      }
    }
  }
  return {
    ok: true, thickness, directions: out, band, yGround, level, valley, floorAt, floorSample,
    floor: { minX, maxX, minZ, maxZ, level, contact, summits: contact, cutAt: og.cutAt != null ? og.cutAt : contact * depth, skirt, wearMM, contactShare: floorN ? contactN / floorN : 0 },
    stats: { floor: floorN, curtain: curtainN, side: sideN, contact: contactN, walked: walkedN, featherPoints: K },
  };
}

/** the terrainer in one call: terrainWall, then buildPlate on its fields;
 * the floor band (1 on the floor's source vertices, 0 elsewhere) rides the
 * ladder as limit.extra unless opts.plate.extra is given */
export function buildTerrainPlate(last, coverage, lm, opts = {}) {
  const tw = terrainWall(last, coverage, lm, opts);
  if (!tw.ok) return tw;
  const plate = { ...(opts.plate || {}) };
  if (!plate.extra) plate.extra = Float32Array.from(tw.band, (b) => (b === 1 ? 1 : 0));
  // the caller's per-vertex wall over its dial (a cage lift, a thickness
  // colour) rides on the terrain's thickness: the terrain is the range, the
  // extra is what a hand added to it
  let wall = tw.thickness;
  if (opts.extraWall) { wall = Float32Array.from(tw.thickness); for (let i = 0; i < wall.length; i++) wall[i] += Math.max(0, opts.extraWall[i] || 0); }
  const detail = opts.terrainDetail != null ? opts.terrainDetail : (opts.ground && opts.ground.detail != null ? opts.ground.detail : 0);
  const r = buildPlate(last, coverage, { ...plate, wall, directions: tw.directions, guard: false, rim: 0, minWall: opts.minWall == null ? TERRAIN_DEFAULTS.minWall : opts.minWall, terrainWall: tw, terrainDetail: detail });
  if (!r.ok) return r;
  return { ...r, terrain: tw };
}

// ── the worker road ───────────────────────────────────────────────────────
// A sampler is a function in-process and a descriptor across postMessage:
// { kind, seed, scale } for relief.mjs's kinds ('place:<key>' loads MASQ's
// heightfield through terrain.mjs; io = { fetch | readFile, base }).
export async function resolveSampler(desc, io) {
  if (!desc) return null;
  if (typeof desc === 'function') return desc;
  const key = placeKeyOfKind(desc.kind);
  // a fetched place crosses postMessage as its record (desc.place) and enters this thread's store
  if (key && desc.place && desc.place.grid) registerPlace(key, desc.place);
  if (key) { await loadTerrainPlace(key, io); return placeSamplerFor(key, desc.seed | 0, desc.scale || 1); }
  return reliefSampler(desc.kind || 'none', desc.seed | 0, desc.scale || 1);
}
// the terrain texture's place, fetched by key: the opts with `place` set to
// the loaded record, or with `error` set (buildPlate then reports
// stats.texture = { key, loaded: false, error } and builds without it)
export async function resolveTerrain(terrain, io) {
  if (!terrain || !terrain.key) return terrain || null;
  if (terrain.place && terrain.place.grid) { registerPlace(terrain.key, terrain.place); return terrain; }
  try { return { ...terrain, place: await loadTerrainPlace(terrain.key, io) }; }
  catch (e) { return { ...terrain, place: null, error: String(e && e.message || e) }; }
}

/* One build in flight per client; a result whose id is not the latest asked
 * is dropped (superb.mjs's contract). `build(last, coverage, opts, terrainer)`
 * → Promise of buildPlate's result with typed arrays; `terrainer`, when
 * given, is terrainWall's opts with samplers as descriptors; opts.terrain
 * carries its place by `key` and the worker fetches it. */
export function createPlateWorker(url) {
  let worker = null, nextId = 1, latest = 0;
  const pending = new Map();
  const spawn = () => {
    const w = new Worker(url || new URL('./plate.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      if (e.data.id !== latest) { p.resolve({ ok: false, reason: 'stale', message: 'a newer build was asked for' }); return; }
      p.resolve(e.data);
    };
    w.onerror = (e) => {
      for (const p of pending.values()) p.resolve({ ok: false, reason: 'worker', message: e.message || 'the worker died' });
      pending.clear();
      try { w.terminate(); } catch (_) {}
      worker = null;
    };
    return w;
  };
  return {
    build(last, coverage, opts = {}, terrainer = null) {
      if (!worker) worker = spawn();
      const id = nextId++; latest = id;
      const msg = { id, last: { positions: Float32Array.from(last.positions), indices: Uint32Array.from(last.indices) }, coverage: Float32Array.from(coverage), opts, terrainer };
      return new Promise((resolve) => { pending.set(id, { resolve }); worker.postMessage(msg, [msg.last.positions.buffer, msg.last.indices.buffer, msg.coverage.buffer]); });
    },
    inFlight() { return pending.size; },
    terminate() { if (worker) { try { worker.terminate(); } catch (_) {} worker = null; } for (const p of pending.values()) p.resolve({ ok: false, reason: 'stale', message: 'terminated' }); pending.clear(); },
  };
}

/**
 * Where each outer-sheet cage vertex i (< cage.sheetCount) sits in the built piece's limit mesh. Catmull-Clark keeps
 * them first and in order (i itself); a perforated piece renumbers its survivors (limit.from names each one's index
 * before the cut), and a vertex a hole cut away is -1.
 */
export function cageVertexInLimit(result) {
  const n = result && result.cage ? result.cage.sheetCount : 0, at = new Int32Array(n), from = result && result.limit && result.limit.from;
  if (!from) { for (let i = 0; i < n; i++) at[i] = i; return at; }
  at.fill(-1); for (let j = 0; j < from.length; j++) if (from[j] < n) at[from[j]] = j;
  return at;
}

/**
 * Substrate from a built piece: the base mesh with the piece's outer limit
 * surface in place of the piece's region. Catmull-Clark keeps the cage's
 * vertex points first, so limit.positions[i] for i < cage.sheetCount are the
 * outer sheet's vertex points, corresponding to cage.srcOf[i] in base.
 * The topology matches base exactly, so all zone and coverage fields index it.
 */
export function pieceSubstrate(base, result) {
  if (!base || !result || !result.ok || !result.limit) return base;
  const positions = Float32Array.from(base.positions);
  const c = result.cage, L = result.limit.positions;
  if (c && L) {
    const limLen = L.length, posLen = positions.length, at = cageVertexInLimit(result);
    for (let i = 0; i < c.sheetCount; i++) {
      const sv = c.srcOf[i], j = at[i];
      if (sv >= 0 && j >= 0 && sv * 3 + 2 < posLen && j * 3 + 2 < limLen) {
        positions[sv * 3] = L[j * 3];
        positions[sv * 3 + 1] = L[j * 3 + 1];
        positions[sv * 3 + 2] = L[j * 3 + 2];
      }
    }
  }
  return { positions, indices: base.indices };
}
