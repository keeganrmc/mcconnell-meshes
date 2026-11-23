// Orientation: the four named poses, the candidate grid, the first-layer
// contact test, one candidate's score, and the sort the search ranks by.
//
// A candidate is scored on the support module's raster (support.js): tree
// and normal support grams, the tree's footprint on the outer and inner
// face, the first-layer contact, the height. Its `cost` is a penalty built
// from features of the posed mesh: the area that faces down past the support
// threshold (more is worse), the height (more layers, more time), and the
// convex hull of what touches the plate (more is better). Lower is better.
// The weights are fitted (tools/print/fit_time.mjs prints the orderings
// they produce on the fixtures).
//
// Stability: the brim's rule. A pose stands when its first-layer contact's
// convex hull is at least four brim widths across and the surface's area
// centroid lies over that hull; otherwise it needs a brim, whose grams count
// against it.
import { faceNormalsAreas, tiltLean, rotate, dropToPlate } from './mesh.js';
import { estimateSupport, supportGrams, occupied } from './support.js';

/** The brim the app adds to a pose that does not stand, mm. */
export const BRIM_WIDTH_MM = 5;

/** The cost's weights (kind c): per cm² of overhang, per mm of height, per cm² of contact hull. */
export const COST_WEIGHTS = Object.freeze({ overhangPerCm2: 1, heightPerMM: 0.1, contactPerCm2: 0.5 });

export const NAMED = Object.freeze([
  Object.freeze({ name: 'dome up', tiltDeg: 0, leanDeg: 0 }),
  Object.freeze({ name: 'on the chin', tiltDeg: 90, leanDeg: 0 }),
  Object.freeze({ name: 'on the brow', tiltDeg: -90, leanDeg: 0 }),
  Object.freeze({ name: 'face down', tiltDeg: 180, leanDeg: 0 }),
]);

const nameOf = (t, l) => { const n = NAMED.find((p) => p.tiltDeg === t && p.leanDeg === l); return n ? n.name : ''; };

/** Tilt and lean each −90…90 at `stepDeg`; a pose equal to a named one carries its name. */
export function candidates(stepDeg = 10) {
  const out = [];
  for (let t = -90; t <= 90 + 1e-9; t += stepDeg) for (let l = -90; l <= 90 + 1e-9; l += stepDeg) {
    const tilt = Math.round(t), lean = Math.round(l);
    out.push({ name: nameOf(tilt, lean), tiltDeg: tilt, leanDeg: lean });
  }
  return out;
}

/* ---------- convex hull ---------- */

/** Convex hull of [x, y] points, counterclockwise, no collinear points (monotone chain). */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function hullArea(h) {
  if (h.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
  return Math.abs(a) / 2;
}

/** Minimum caliper width: over the hull's edges, the smallest of the farthest vertex's distance from that edge's line. */
export function hullWidth(h) {
  if (h.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
    if (L < 1e-12) continue;
    let far = 0;
    for (const q of h) { const d = Math.abs((q[0] - a[0]) * ey - (q[1] - a[1]) * ex) / L; if (d > far) far = d; }
    if (far < best) best = far;
  }
  return best === Infinity ? 0 : best;
}

/** The largest distance between two hull vertices. */
function hullDiameter(h) {
  let best = 0;
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) { const d = Math.hypot(h[i][0] - h[j][0], h[i][1] - h[j][1]); if (d > best) best = d; }
  return best;
}

/** Is (x, y) inside the counterclockwise convex hull (false for a degenerate one). */
export function insideHull(h, x, y) {
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}

/* ---------- contact ---------- */

/**
 * The first-layer contact from the support raster's occupancy (layer 0,
 * cell c): area, 4-connected components, exposed perimeter (the grid border
 * counts as exposed), the rim (per component, its hull's diameter plus c,
 * summed), the hull's minimum width, and whether `centroidXY` lies over it.
 */
export function contactFrom(est, centroidXY) {
  const cols = est.columns, occ = est.occupancy;
  const { nx, ny } = cols;
  const c = cols.cellMM ?? est.cellMM;
  const x0 = cols.x0 ?? 0, y0 = cols.y0 ?? 0;
  const on = new Uint8Array(nx * ny);
  let cells = 0;
  for (let p = 0; p < nx * ny; p++) if (occupied(occ, 0, p)) { on[p] = 1; cells++; }
  let exposed = 0;
  const comp = new Int32Array(nx * ny).fill(-1);
  const groups = [];
  for (let p = 0; p < nx * ny; p++) {
    if (!on[p]) continue;
    const i = p % nx, j = (p - i) / nx;
    if (i === 0 || !on[p - 1]) exposed++;
    if (i === nx - 1 || !on[p + 1]) exposed++;
    if (j === 0 || !on[p - nx]) exposed++;
    if (j === ny - 1 || !on[p + nx]) exposed++;
    if (comp[p] >= 0) continue;
    const id = groups.length, pts = [], stack = [p];
    comp[p] = id;
    while (stack.length) {
      const q = stack.pop();
      const qi = q % nx, qj = (q - qi) / nx;
      pts.push([x0 + (qi + 0.5) * c, y0 + (qj + 0.5) * c]);
      if (qi > 0 && on[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; stack.push(q - 1); }
      if (qi < nx - 1 && on[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; stack.push(q + 1); }
      if (qj > 0 && on[q - nx] && comp[q - nx] < 0) { comp[q - nx] = id; stack.push(q - nx); }
      if (qj < ny - 1 && on[q + nx] && comp[q + nx] < 0) { comp[q + nx] = id; stack.push(q + nx); }
    }
    groups.push(pts);
  }
  let rimMM = 0;
  const all = [];
  for (const pts of groups) { rimMM += hullDiameter(convexHull(pts)) + c; for (const q of pts) all.push(q); }
  const hull = convexHull(all);
  const width = hullWidth(hull);
  return {
    areaMM2: cells * c * c, components: groups.length, perimeterMM: exposed * c, rimMM,
    hull, hullWidthMM: width, hullAreaMM2: hullArea(hull),
    centroidInside: centroidXY ? insideHull(hull, centroidXY[0], centroidXY[1]) : false,
  };
}

/** The surface's area centroid in xy. */
function areaCentroidXY(P, I, areas) {
  let cx = 0, cy = 0, A = 0;
  for (let t = 0; t < areas.length; t++) {
    const a = areas[t]; if (!(a > 0)) continue;
    const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
    cx += a * (P[i0] + P[i1] + P[i2]) / 3; cy += a * (P[i0 + 1] + P[i1 + 1] + P[i2 + 1]) / 3; A += a;
  }
  return A > 0 ? [cx / A, cy / A] : [0, 0];
}

/* ---------- the cost ---------- */

/**
 * Pose features on the mesh in its print frame (z up, min z 0): area facing
 * down past the support threshold, the height, and the convex hull of the
 * vertices within one first-layer height of the plate.
 */
export function poseFeatures(P, I, normals, areas, { thresholdDeg = 30, firstLayerMM = 0.2 } = {}) {
  const cut = -Math.cos(thresholdDeg * Math.PI / 180);
  let overhangMM2 = 0, contactMM2 = 0, maxZ = -Infinity;
  for (let i = 2; i < P.length; i += 3) if (P[i] > maxZ) maxZ = P[i];
  const band = [];
  for (let v = 0; v < P.length; v += 3) if (P[v + 2] <= firstLayerMM) band.push([P[v], P[v + 1]]);
  for (let t = 0; t < areas.length; t++) {
    const nz = normals[t * 3 + 2];
    const z = (P[I[t * 3] * 3 + 2] + P[I[t * 3 + 1] * 3 + 2] + P[I[t * 3 + 2] * 3 + 2]) / 3;
    if (z <= firstLayerMM) { contactMM2 += areas[t]; continue; }
    if (nz < cut) overhangMM2 += areas[t];
  }
  return { overhangMM2, contactMM2, contactHullMM2: hullArea(convexHull(band)), heightMM: Math.max(0, maxZ) };
}

/** The penalty: overhang and height cost, contact earns. Monotone in each. */
export function poseCost(f, w = COST_WEIGHTS) {
  return w.overhangPerCm2 * f.overhangMM2 / 100 + w.heightPerMM * f.heightMM - w.contactPerCm2 * Math.max(f.contactHullMM2, f.contactMM2) / 100;
}

/**
 * One candidate on the support raster.
 * @param {{positions: Float32Array, indices: Uint32Array}} domeUp  the mesh in the dome-up frame
 * @param {{name?: string, tiltDeg: number, leanDeg: number}} cand
 * @param {{cellMM: number, layerMM: number, profile?: object, density?: number}} o
 */
export function scoreOrientation(domeUp, cand, o = {}) {
  const T = tiltLean(cand.tiltDeg, cand.leanDeg);
  const positions = dropToPlate(rotate(domeUp.positions, T)).positions;
  const mesh = { positions, indices: domeUp.indices };
  const outerDir = [T[2], T[5], T[8]];
  const sup = estimateSupport(mesh, { cellMM: o.cellMM, layerMM: o.layerMM, outerDir, profile: o.profile });
  const density = o.density;
  const supportTreeG = sup.tree ? supportGrams(sup.tree, { density }) : 0;
  const supportNormalG = supportGrams(sup.normal, { density });
  const face = faceNormalsAreas(positions, domeUp.indices);
  const contact = contactFrom(sup, areaCentroidXY(positions, domeUp.indices, face.areas));
  const stable = contact.hullWidthMM >= BRIM_WIDTH_MM * 4 && contact.centroidInside;
  const brimMM3 = stable ? 0 : (contact.perimeterMM * BRIM_WIDTH_MM + Math.max(1, contact.components) * Math.PI * BRIM_WIDTH_MM ** 2) * sup.layerMM;
  const brimG = brimMM3 * (density ?? 1.24) / 1000;
  const pr = o.profile || {};
  const features = poseFeatures(positions, domeUp.indices, face.normals, face.areas, { thresholdDeg: pr.thresholdDeg ?? 30, firstLayerMM: pr.initialLayerMM ?? 0.2 });
  return {
    name: cand.name || '', tiltDeg: cand.tiltDeg, leanDeg: cand.leanDeg,
    tree: sup.tree, normal: sup.normal,
    supportTreeG, supportNormalG, brimG, materialG: supportTreeG + (stable ? 0 : brimG),
    footprintOuterMM2: sup.tree ? sup.tree.footprintOuterMM2 : 0, footprintInnerMM2: sup.tree ? sup.tree.footprintInnerMM2 : 0,
    heightMM: features.heightMM, unstable: !stable, contact, features, cost: poseCost(features),
  };
}

const q = (v, step) => Math.round(v / step);

/** Rows sorted by the objective; keys quantized so ties are exact and the candidate's index breaks them. */
export function sortRows(rows, objective = 'support') {
  const key = (r, i) => {
    const idx = r.index ?? i, u = r.unstable ? 1 : 0;
    const mat = q(r.materialG ?? r.supportTreeG ?? 0, 0.1), cost = q(r.cost ?? 0, 0.001);
    if (objective === 'cost') return [u, cost, mat, idx];
    if (objective === 'finish') return [u, q(r.footprintOuterMM2 ?? 0, 1), mat, cost, idx];
    return [u, mat, cost, idx];
  };
  return rows.map((r, i) => ({ r, k: key(r, i) })).sort((a, b) => {
    for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
    return 0;
  }).map((e) => e.r);
}

/** Every candidate at `stepDeg` and the named poses, scored and sorted. */
export function rankOrientations(domeUp, opts = {}) {
  const seen = new Set();
  const list = [];
  for (const c of [...NAMED, ...candidates(opts.stepDeg ?? 30)]) {
    const key = c.tiltDeg + '/' + c.leanDeg;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(c);
  }
  const rows = list.map((c, index) => ({ ...scoreOrientation(domeUp, c, opts), index }));
  return sortRows(rows, opts.objective || 'support');
}
