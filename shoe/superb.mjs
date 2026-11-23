// A piece as an editable SuperB: a quad cage from QuadriFlow over the piece's
// OUTER sheet, closed by an inner sheet that is the substrate, as one SubD
// solid. Two closures, chosen by what the piece is:
//
//   shell  (footie: vertex 2k inner, 2k+1 its twin along the last's normal)
//          the outer cage carried to the inner sheet through the twins, the
//          two cages joined by a wall quad per rim edge. Genus 1 per opening.
//   ground (sole: {loops}) the sidewall remeshed between its two rims (the
//          rim on the last, the floor's corner), each rim capped: support
//          rings along the sheet, a QuadriFlow disk, a zipper between —
//          the floor with its contact profile, the inner with the sole
//          patch and any band up the last's side. Genus 0.
//
// Then one refit of the whole solid so the drawn surface (level 2) passes
// through the cage's vertices, which sit on the sheets; the inner sheet's
// targets a bias off the substrate so the ripple between vertices stays out
// of the last. Every rim edge carries a crease (rimSoft, MASQ's dial).
//
// A plate's cage (plate.mjs) is the same kind of solid (plateCage), and both
// take the finish MASQ gives a SuperB: rimCreases (the rims' crease weights
// from rimSoft / holeSoft, or per loop) and detailCage (the outer sheet
// refined locally — Detail — the rest of the cage left one face each).
//
// Units mm throughout; the app's frame (X along, Y up, Z across). MASQ's
// modules are told so (`inMillimeters`, `mmPer = 1`) at every call.
// Plain data in, plain data out — the same call runs in superb.worker.js.

import {
  remeshQuadPatchQuadriFlow, weldPatch, deriveQuadCount, findQuadBoundaryLoops, fairCage,
  validateSuperBCage, evaluateSubDLimitMesh, limitVerticesOwnedBy, refineSheetLocally,
} from '../lift/masq/tosuperb.js';
import { CREASE_SCALE, isClosedManifold, cageVolume } from '../lift/masq/superbsolid.js';
import { subdivideCatmullClark } from '../lift/masq/centina/subd.mjs';
import { vertexNormals, refineAtIsoline, triangleSides, boundaryLoops } from './meshcut.mjs';
import { distanceFrom } from './shell.mjs';

export const SUPERB_DEFAULTS = {
  levels: 2,        // Catmull-Clark levels of the limit mesh
  rimSoft: 0,       // 0 = a hard crease on every rim edge, 1 = no crease (MASQ's dial)
  seed: 0,
  targetQuads: null,// null = deriveQuadCount on the outer sheet (6 mm quads, 30..800)
  touchMM: 0.3,     // a vertex this close to the substrate is on the inner sheet
  refitPasses: 8,   // until the drawn surface is within 0.02 mm of the sheets at the cage's vertices
  biasMM: 0.2,      // the inner sheet's targets sit this far off the substrate
};

const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// ── nearest point on a triangle mesh, by a grid of triangle boxes ──────────
function closestOnTriangle(p, a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return a;
  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + abx * v, a[1] + aby * v, a[2] + abz * v]; }
  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + acx * w, a[1] + acy * w, a[2] + acz * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w];
}

// The field a gate and the adapter both read: nearest(p) → { d, q, tri },
// signed(p) → distance along the mesh's normal there (+ outside).
export function meshField(positions, indices) {
  const T = indices.length / 3, P = positions;
  let edge = 0;
  for (let t = 0; t < T; t++) { const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3; edge += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); }
  edge = T ? edge / T : 1;
  const cell = Math.max(edge * 2, 1e-3);
  const g = new Map();
  const key = (i, j, k) => `${i}_${j}_${k}`;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < 3; c++) { lo[c] = Infinity; hi[c] = -Infinity; }
    for (let e = 0; e < 3; e++) { const i = indices[t * 3 + e] * 3; for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[i + c]); hi[c] = Math.max(hi[c], P[i + c]); } }
    const i0 = Math.floor(lo[0] / cell), i1 = Math.floor(hi[0] / cell), j0 = Math.floor(lo[1] / cell), j1 = Math.floor(hi[1] / cell), k0 = Math.floor(lo[2] / cell), k1 = Math.floor(hi[2] / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) { const kk = key(i, j, k); let l = g.get(kk); if (!l) { l = []; g.set(kk, l); } l.push(t); }
  }
  const tri = (t) => [[P[indices[t * 3] * 3], P[indices[t * 3] * 3 + 1], P[indices[t * 3] * 3 + 2]], [P[indices[t * 3 + 1] * 3], P[indices[t * 3 + 1] * 3 + 1], P[indices[t * 3 + 1] * 3 + 2]], [P[indices[t * 3 + 2] * 3], P[indices[t * 3 + 2] * 3 + 1], P[indices[t * 3 + 2] * 3 + 2]]];
  const nearest = (p, rMax = Infinity) => {
    const ci = Math.floor(p[0] / cell), cj = Math.floor(p[1] / cell), ck = Math.floor(p[2] / cell);
    let best = { d: Infinity, q: null, tri: -1 };
    const seen = new Set();
    for (let r = 0; r < 64; r++) {
      if (r > 0 && (r - 1) * cell > Math.min(best.d, rMax)) break;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
        const l = g.get(key(i, j, k)); if (!l) continue;
        for (const t of l) {
          if (seen.has(t)) continue; seen.add(t);
          const [a, b, c] = tri(t);
          const q = closestOnTriangle(p, a, b, c);
          const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
          if (d < best.d) best = { d, q, tri: t };
        }
      }
    }
    return best;
  };
  const signed = (p, rMax) => {
    const n = nearest(p, rMax);
    if (n.tri < 0) return { d: Infinity, s: Infinity, q: null, tri: -1 };
    const [a, b, c] = tri(n.tri);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const dot = (p[0] - n.q[0]) * nx + (p[1] - n.q[1]) * ny + (p[2] - n.q[2]) * nz;
    return { ...n, s: dot < 0 ? -n.d : n.d };
  };
  // the LOWEST height of the mesh under (x, z), by a plan grid of triangles
  const plan = new Map();
  for (let t = 0; t < T; t++) {
    const [a, b, c] = tri(t);
    const i0 = Math.floor(Math.min(a[0], b[0], c[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0], c[0]) / cell), k0 = Math.floor(Math.min(a[2], b[2], c[2]) / cell), k1 = Math.floor(Math.max(a[2], b[2], c[2]) / cell);
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) { const kk = `${i}_${k}`; let l = plan.get(kk); if (!l) { l = []; plan.set(kk, l); } l.push(t); }
  }
  const yAt = (x, z) => {
    const l = plan.get(`${Math.floor(x / cell)}_${Math.floor(z / cell)}`);
    let best = null;
    if (!l) return best;
    for (const t of l) {
      const [a, b, c] = tri(t);
      const d1 = (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]), d2 = (c[0] - b[0]) * (z - b[2]) - (c[2] - b[2]) * (x - b[0]), d3 = (a[0] - c[0]) * (z - c[2]) - (a[2] - c[2]) * (x - c[0]);
      if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
      const s = d1 + d2 + d3; if (Math.abs(s) < 1e-12) continue;
      const y = (a[1] * d2 + b[1] * d3 + c[1] * d1) / s;
      if (best === null || y < best) best = y;
    }
    return best;
  };
  return { nearest, signed, yAt, edge };
}

// ── the piece split into its sheets ────────────────────────────────────────
function compactPatch(positions, tris) {
  const map = new Map(), vertices = [], faces = [], source = [];
  const id = (i) => { let j = map.get(i); if (j === undefined) { j = vertices.length; map.set(i, j); vertices.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]); source.push(i); } return j; };
  for (const t of tris) faces.push([id(t[0]), id(t[1]), id(t[2])]);
  return { vertices, faces, source };
}

function sheetsOf(piece, sub, touchMM) {
  const P = piece.positions, I = piece.indices, V = P.length / 3, T = I.length / 3;
  const touching = new Uint8Array(V);
  if (piece.rims) { for (let i = 0; i < V; i += 2) touching[i] = 1; }
  else for (let i = 0; i < V; i++) touching[i] = sub.nearest([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], touchMM * 4).d <= touchMM ? 1 : 0;
  /* a ground's loft never touches: its first ring can lie within a wall of
   * the last's rounded heel edge, and a zipper triangle read as inner there
   * put the cage's rim on ring 1, 4.7 mm under the feather line */
  if (piece.loops && piece.loops.floor && piece.stats && piece.stats.rings) {
    const firstLoft = piece.loops.floor[0] - (piece.stats.rings - 1) * piece.loops.floor.length;
    for (let i = Math.max(0, firstLoft); i < V; i++) touching[i] = 0;
  }
  const inner = [], outer = [], floor = [];
  /* a ground's floor cap, by the ground's own vertex order: the cap's
   * vertices are the floor ring and everything pushed after it. It is
   * capped on its own so the floor's corner is a cage loop. (A terrain
   * sidewall lies as flat as the floor in places; its normal says nothing.) */
  const onFloor = new Uint8Array(V);
  if (piece.loops && piece.loops.floor) { let top = 0; for (const i of piece.loops.floor) { onFloor[i] = 1; if (i > top) top = i; } for (let i = top + 1; i < V; i++) onFloor[i] = 1; }
  for (let t = 0; t < T; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const n = touching[a] + touching[b] + touching[c];
    if (n === 3) { inner.push([a, b, c]); continue; }
    if (piece.rims && n !== 0) continue;
    if (onFloor[a] + onFloor[b] + onFloor[c] === 3) { floor.push([a, b, c]); continue; }
    outer.push([a, b, c]);
  }
  return { inner, outer, floor, touching };
}

// A sheet with two rims can come back with an odd count on each (63 + 71):
// a quad disk cannot close an odd loop. One column of quads is split from
// rim to rim — the strip of quads crossed edge to opposite edge from a rim
// edge until the other rim — so both rims gain a vertex.
function evenLoops(cage) {
  const loops = findQuadBoundaryLoops(cage.faces, cage.vertices.length);
  if (loops.length !== 2 || loops[0].length % 2 === 0) return { ok: true, split: 0 };
  const F = cage.faces, V = cage.vertices;
  const owner = new Map(); // directed edge a→b → face index
  for (let fi = 0; fi < F.length; fi++) for (let k = 0; k < 4; k++) owner.set(`${F[fi][k]}_${F[fi][(k + 1) % 4]}`, fi);
  const onLoop = new Map(); loops.forEach((L, li) => { for (let k = 0; k < L.length; k++) onLoop.set(`${L[k]}_${L[(k + 1) % L.length]}`, li); });
  const start = loops[0];
  for (let s0 = 0; s0 < start.length; s0++) {
    /* the boundary edge runs a→b along the loop; the face traverses it the same way */
    let a = start[s0], b = start[(s0 + 1) % start.length];
    const strip = []; const seen = new Set(); let ok = false;
    for (let step = 0; step < F.length; step++) {
      const fi = owner.get(`${a}_${b}`); if (fi === undefined || seen.has(fi)) break;
      seen.add(fi);
      const q = F[fi], k = q.indexOf(a);
      /* q = [a, b, c, d] from a traverses the exit edge c→d; a rim holds it
       * the same way, the face across it runs d→c */
      const c = q[(k + 2) % 4], d = q[(k + 3) % 4];
      strip.push({ fi, a, b, c, d });
      const li = onLoop.get(`${c}_${d}`);
      if (li === 1) { ok = true; break; }
      if (li === 0) break;
      a = d; b = c;
    }
    if (!ok) continue;
    const mid = new Map();
    const midOf = (u, v) => { const key = edgeKey(u, v); let m = mid.get(key); if (m === undefined) { m = V.length; V.push([(V[u][0] + V[v][0]) / 2, (V[u][1] + V[v][1]) / 2, (V[u][2] + V[v][2]) / 2]); mid.set(key, m); } return m; };
    for (const { fi, a, b, c, d } of strip) {
      const mab = midOf(a, b), mcd = midOf(c, d);
      F[fi] = [a, mab, mcd, d];
      F.push([mab, b, c, mcd]);
    }
    return { ok: true, split: strip.length };
  }
  return { ok: false, reason: 'parity', detail: `both rims are odd (${loops[0].length}, ${loops[1].length}) and no quad column joins them` };
}

// ── a sheet remeshed: QuadriFlow, rims snapped and spread, faired ─────────
/* QuadriFlow straight from MASQ's remeshQuadPatchQuadriFlow (its own
 * three-seed retry on a degenerate quad), every rim a preserved boundary,
 * sharp edges kept where asked (a sole's floor corner). It hands back fewer
 * quads than asked on an open sheet (590 of 800 on the footie); under 85 %
 * it is asked once more, scaled by the shortfall. */
async function remeshSheet(patch, targetFaces, o) {
  const loopsIn = findQuadBoundaryLoops(patch.faces, patch.vertices.length).length;
  const welded = weldPatch({ vertices: patch.vertices, faces: patch.faces });
  const run = async (targetQuads) => {
    let res = null;
    for (const ask of [targetQuads, targetQuads * 2]) {
      try { res = await remeshQuadPatchQuadriFlow(welded.vertices, welded.faces, { targetQuads: ask, preserveBoundary: true, minimumCostFlow: true, adaptiveScale: true, sharp: !!o.sharp, seed: o.seed }); break; }
      catch (e) { res = { error: String(e && e.message || e) }; }
    }
    return res;
  };
  let asked = targetFaces, r = await run(asked);
  if (r.cage && r.cage.faces.length < 0.85 * targetFaces) {
    asked = Math.round(targetFaces * targetFaces / r.cage.faces.length);
    const again = await run(asked);
    if (again.cage && Math.abs(again.cage.faces.length - targetFaces) < Math.abs(r.cage.faces.length - targetFaces)) r = again; else asked = targetFaces;
  }
  if (!r.cage) return { ok: false, reason: 'remesh', detail: r.error || 'the remesher returned nothing' };
  const loopsOut = findQuadBoundaryLoops(r.cage.faces, r.cage.vertices.length).length;
  if (loopsOut !== loopsIn) return { ok: false, reason: 'rims', detail: `the sheet has ${loopsIn} rims and its cage ${loopsOut}` };
  const cage = { vertices: r.cage.vertices.map((v) => v.slice()), faces: r.cage.faces.map((f) => f.slice()), creases: {} };
  if (o.evenLoops) { const e = evenLoops(cage); if (!e.ok) return e; }
  /* QuadriFlow's boundary vertices lie NEAR a preserved boundary, not on it
   * (up to 6 mm off the footie's topline), and two can land 1.5 mm apart
   * beside 7 mm quads: each cage loop is snapped to the closest points of
   * the sheet's own rim polyline, then spread along it (its arc parameters
   * relaxed, order kept), and the interior re-faired */
  const rims = findQuadBoundaryLoops(patch.faces, patch.vertices.length).map((L) => {
    const P = L.map((i) => patch.vertices[i]), n = P.length, at = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) { const a = P[k], b = P[(k + 1) % n]; at[k + 1] = at[k] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    const length = at[n];
    const point = (u) => { // arc parameter 0..1 → point
      const d = ((u % 1) + 1) % 1 * length; let k = 0; while (k + 1 < n && at[k + 1] < d) k++;
      const a = P[k], b = P[(k + 1) % n], f = at[k + 1] > at[k] ? (d - at[k]) / (at[k + 1] - at[k]) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
    const param = (p) => { // closest point's arc parameter, and its distance
      let best = 0, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const a = P[k], b = P[(k + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], L2 = ex * ex + ey * ey + ez * ez || 1e-30;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / L2));
        const d = (a[0] + ex * t - p[0]) ** 2 + (a[1] + ey * t - p[1]) ** 2 + (a[2] + ez * t - p[2]) ** 2;
        if (d < bd) { bd = d; best = (at[k] + (at[k + 1] - at[k]) * t) / length; }
      }
      return { u: best, d: Math.sqrt(bd) };
    };
    return { point, param, length };
  });
  let rimMoved = 0, rimMovedAt = null;
  for (const L of findQuadBoundaryLoops(cage.faces, cage.vertices.length)) {
    /* the rim this loop lies on: the one nearest its first vertex */
    let rim = null, rd = Infinity;
    for (const R of rims) { const { d } = R.param(cage.vertices[L[0]]); if (d < rd) { rd = d; rim = R; } }
    if (!rim) continue;
    /* parameters by the loop's own arc length from its first vertex's
     * closest point, run the way the majority of near steps run (a global
     * closest point alone jumps sides where the topline's two banks pass
     * within a quad of each other at the throat); each then pulled to the
     * nearest rim point within half a step, and relaxed */
    const n = L.length, u = L.map((v) => rim.param(cage.vertices[v]).u);
    let up = 0, down = 0;
    for (let k = 0; k < n; k++) { const d = ((u[(k + 1) % n] - u[k]) % 1 + 1.5) % 1 - 0.5; if (Math.abs(d) > 2 / n) continue; if (d > 0) up++; else down++; }
    const sign = up >= down ? 1 : -1;
    const arc = new Float64Array(n); let total = 0;
    for (let k = 0; k < n; k++) { arc[k] = total; const a = cage.vertices[L[k]], b = cage.vertices[L[(k + 1) % n]]; total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    const w = new Float64Array(n);
    const step = 1 / n;
    w[0] = u[0];
    for (let k = 1; k < n; k++) {
      const predicted = w[k - 1] + sign * (arc[k] - arc[k - 1]) / total;
      const own = u[k] + Math.round(predicted - u[k]);
      w[k] = Math.abs(own - predicted) <= 2 * step ? own : predicted;
    }
    for (let pass = 0; pass < 8; pass++) {
      const nx = new Float64Array(n);
      for (let k = 0; k < n; k++) { const a = k ? w[k - 1] : w[n - 1] - sign, b = k + 1 < n ? w[k + 1] : w[0] + sign; nx[k] = w[k] + 0.5 * ((a + b) / 2 - w[k]); }
      w.set(nx);
    }
    L.forEach((v, k) => {
      const q = rim.point(w[k]);
      const moved = Math.hypot(q[0] - cage.vertices[v][0], q[1] - cage.vertices[v][1], q[2] - cage.vertices[v][2]);
      if (moved > rimMoved) { rimMoved = moved; rimMovedAt = cage.vertices[v].map((x) => +x.toFixed(1)); }
      cage.vertices[v] = q;
    });
  }
  const fair = fairCage(cage, { vertices: patch.vertices, faces: patch.faces }, { passes: 3, rate: 0.5 });
  return { ok: true, cage, asked, retries: r.retries, rimSnapped: rimMoved, rimSnappedAt: rimMovedAt, refaired: fair.moved };
}

// ── the outer cage ─────────────────────────────────────────────────────────
async function outerCage(patch, o, evenLoops) {
  const derived = deriveQuadCount({ vertices: patch.vertices, faces: patch.faces }, 1);
  const targetFaces = o.targetQuads || derived.count;
  const r = await remeshSheet(patch, targetFaces, { ...o, evenLoops });
  if (!r.ok) return r;
  return { ok: true, cage: r.cage, targetFaces, asked: r.asked, derived, reduction: { retries: r.retries, rimSnapped: r.rimSnapped, rimSnappedAt: r.rimSnappedAt, refaired: r.refaired } };
}

// ── the shell closure: inner cage through the twins, a wall per rim edge ───
// each outer cage vertex at its barycentric place in the nearest outer-sheet
// triangle, carried to the same place in the inner twins' triangle
function liftThroughTwins(outer, patch, piece, outerField) {
  const P = piece.positions;
  return outer.vertices.map((v) => {
    const n = outerField.nearest(v);
    if (n.tri < 0) return v.slice();
    const f = patch.faces[n.tri], q = n.q;
    const A = patch.vertices[f[0]], B = patch.vertices[f[1]], C = patch.vertices[f[2]];
    const v0 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v1 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]], v2 = [q[0] - A[0], q[1] - A[1], q[2] - A[2]];
    const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2], d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2], d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
    const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2], d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
    const den = d00 * d11 - d01 * d01 || 1e-30;
    const wb = (d11 * d20 - d01 * d21) / den, wc = (d00 * d21 - d01 * d20) / den, wa = 1 - wb - wc;
    const ia = patch.source[f[0]] - 1, ib = patch.source[f[1]] - 1, ic = patch.source[f[2]] - 1; // 2k+1 → its twin 2k
    return [wa * P[ia * 3] + wb * P[ib * 3] + wc * P[ic * 3], wa * P[ia * 3 + 1] + wb * P[ib * 3 + 1] + wc * P[ic * 3 + 1], wa * P[ia * 3 + 2] + wb * P[ib * 3 + 2] + wc * P[ic * 3 + 2]];
  });
}

function closeShell(outer, patch, piece, outerField, o) {
  const N = outer.vertices.length;
  const inner = liftThroughTwins(outer, patch, piece, outerField);
  const vertices = inner.concat(outer.vertices.map((v) => v.slice()));
  const faces = [];
  for (const q of outer.faces) faces.push(q.slice().reverse());          // inner sheet, facing the substrate
  for (const q of outer.faces) faces.push(q.map((v) => v + N));          // outer sheet
  const count = new Map();
  for (const q of outer.faces) for (let k = 0; k < 4; k++) count.set(edgeKey(q[k], q[(k + 1) % 4]), (count.get(edgeKey(q[k], q[(k + 1) % 4])) || 0) + 1);
  const wallStart = faces.length, creases = {};
  const w = (1 - Math.min(1, Math.max(0, o.rimSoft))) * CREASE_SCALE;
  for (const q of outer.faces) for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    if (count.get(edgeKey(a, b)) !== 1) continue;
    faces.push([b + N, a + N, a, b]);
    if (w > 1e-9) { creases[edgeKey(a, b)] = w; creases[edgeKey(a + N, b + N)] = w; }
  }
  const loops = findQuadBoundaryLoops(outer.faces, N);
  const rims = loops.map((L) => ({ outer: L.map((v) => v + N), inner: L.slice() }));
  return { ok: true, cage: { vertices, faces, creases }, rims, sheets: { inner: [0, outer.faces.length], outer: [outer.faces.length, wallStart], wall: [wallStart, faces.length] } };
}

// ── the ground closure: each rim capped with rings, a zipper, a disk ───────
// A strip of quads between two rings running the same way round and
// starting near each other: A traversed backward, B forward (the sheet
// above A traverses it forward; the disk inside B traverses it backward).
// n and m vertices, n + m even; (|n − m|) / 2 quads take three of the longer
// ring and one of the other, spread evenly.
function zipperStrip(A, B, vertices, faces) {
  const n = A.length, m = B.length;
  if ((n + m) % 2) return { ok: false, reason: 'zipper', detail: `${n} and ${m} vertices cannot be zipped with quads` };
  const extra = Math.abs(n - m) / 2, aLong = n >= m;
  /* both rings by arc length, 0..1 from their first vertices; each
   * step takes the move that keeps the cross edge shortest in parameter —
   * a walk by index alone sheared the strip a whole quad and folded it */
  const params = (R) => { const u = new Float64Array(R.length + 1); let L = 0; for (let k = 0; k < R.length; k++) { const a = vertices[R[k]], b = vertices[R[(k + 1) % R.length]]; u[k + 1] = u[k] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); } L = u[R.length] || 1; for (let k = 0; k <= R.length; k++) u[k] /= L; return u; };
  const uA = params(A), uB = params(B);
  const from = faces.length;
  let i = 0, j = 0, used = 0;
  while (i < n || j < m) {
    const canA3 = aLong && used < extra && i + 2 <= n, canB3 = !aLong && used < extra && j + 2 <= m;
    const can22 = i < n && j < m;
    /* the lag after each candidate move, as |uA − uB| at the new cross edge */
    const lag22 = can22 ? Math.abs(uA[i + 1] - uB[j + 1]) : Infinity;
    const lagA3 = canA3 ? Math.abs(uA[i + 2] - uB[j]) : Infinity;
    const lagB3 = canB3 ? Math.abs(uA[i] - uB[j + 2]) : Infinity;
    if (canA3 && lagA3 < lag22) { faces.push([A[(i + 2) % n], A[(i + 1) % n], A[i % n], B[j % m]]); i += 2; used++; }
    else if (canB3 && lagB3 < lag22) { faces.push([A[i % n], B[j % m], B[(j + 1) % m], B[(j + 2) % m]]); j += 2; used++; }
    else if (can22) { faces.push([A[(i + 1) % n], A[i % n], B[j % m], B[(j + 1) % m]]); i++; j++; }
    else return { ok: false, reason: 'zipper', detail: `the zipper closed at ${i}/${n} and ${j}/${m}` };
  }
  if (used !== extra) return { ok: false, reason: 'zipper', detail: `${used} of ${extra} triples placed` };
  return { ok: true, from, to: faces.length, triples: extra };
}

// A creased cage loop capped on a sheet whose boundary it lies on: three
// support rings inside it along the sheet (a quad's width of tight rounding
// — the last's bottom turns up into the feather line on a 5 mm radius, a
// floor meets its sidewall at a corner), a QuadriFlow disk on the rest of
// the sheet, and a zipper strip between. Rings and the cut are isolines of
// the sheet's own edge distance from its boundary, so a sheet standing up
// the last's side is capped the same as a flat one. Appends to
// vertices/faces; returns the face range.
async function capLoop(loop, patch, vertices, faces, o) {
  const n = loop.length;
  const flat = new Float32Array(patch.vertices.length * 3);
  patch.vertices.forEach((v, i) => { flat[i * 3] = v[0]; flat[i * 3 + 1] = v[1]; flat[i * 3 + 2] = v[2]; });
  const I = new Uint32Array(patch.faces.flat());
  const seeds = []; for (const L of findQuadBoundaryLoops(patch.faces, patch.vertices.length)) for (const v of L) seeds.push(v);
  if (!seeds.length) return { ok: false, reason: 'disk', detail: 'the sheet under the loop has no boundary' };
  const dist = distanceFrom(flat, I, new Uint8Array(I.length / 3).fill(1), seeds);
  let edge = 0; for (let k = 0; k < n; k++) { const a = vertices[loop[k]], b = vertices[loop[(k + 1) % n]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); } edge /= n;
  /* the isoline of the distance field at d, as a closed polyline */
  const isoline = (d) => {
    const field = new Float64Array(dist.length); for (let i = 0; i < dist.length; i++) field[i] = dist[i] - d;
    const cut = refineAtIsoline(flat, I, field);
    const side = triangleSides(cut.indices, cut.values);
    const use = Array.from(side, (s) => s < 0);
    let best = null;
    for (const L of boundaryLoops(cut.indices, use)) { if (!L.every((v) => cut.cut[v])) continue; if (!best || L.length > best.length) best = L; }
    return best ? best.map((v) => [cut.positions[v * 3], cut.positions[v * 3 + 1], cut.positions[v * 3 + 2]]) : null;
  };
  /* n points along a polyline at even arc length, started nearest ref[0] and
   * run the way that keeps them beside ref */
  const resample = (poly, ref) => {
    const m = poly.length, at = new Float64Array(m + 1);
    for (let k = 0; k < m; k++) { const a = poly[k], b = poly[(k + 1) % m]; at[k + 1] = at[k] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    const L = at[m];
    const point = (s) => { s = ((s % L) + L) % L; let k = 0; while (k + 1 < m && at[k + 1] < s) k++; const a = poly[k], b = poly[(k + 1) % m], f = at[k + 1] > at[k] ? (s - at[k]) / (at[k + 1] - at[k]) : 0; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
    let s0 = 0, bd = Infinity;
    const r0 = vertices[ref[0]];
    for (let k = 0; k < m; k++) { const p = poly[k]; const d = (p[0] - r0[0]) ** 2 + (p[1] - r0[1]) ** 2 + (p[2] - r0[2]) ** 2; if (d < bd) { bd = d; s0 = at[k]; } }
    const both = [1, -1].map((dir) => { const pts = []; let cost = 0; for (let k = 0; k < n; k++) { const p = point(s0 + dir * k * L / n), r = vertices[ref[k]]; cost += Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]); pts.push(p); } return { pts, cost }; });
    return both[0].cost <= both[1].cost ? both[0].pts : both[1].pts;
  };
  const from = faces.length;
  let ring = loop;
  const rows = [Math.max(1, 0.13 * edge), Math.max(2, 0.35 * edge), Math.max(4, 0.7 * edge)];
  for (const d of rows) {
    const poly = isoline(d);
    if (!poly || poly.length < 8) return { ok: false, reason: 'disk', detail: `no isoline ${d.toFixed(1)} mm inside the loop` };
    const pts = resample(poly, ring), row = [];
    for (let k = 0; k < n; k++) { row.push(vertices.length); vertices.push(pts[k]); }
    for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; faces.push([ring[k], row[k], row[k2], ring[k2]]); }
    ring = row;
  }
  /* the disk: the sheet beyond `cutAt`, remeshed on its own at the loop's
   * spacing, so the zipper is nearly all pairs */
  const cutAt = rows[rows.length - 1] + 0.6 * edge;
  const field = new Float64Array(dist.length); for (let i = 0; i < dist.length; i++) field[i] = dist[i] - cutAt;
  const cut = refineAtIsoline(flat, I, field);
  const side = triangleSides(cut.indices, cut.values);
  const keep = [];
  for (let t = 0; t < side.length; t++) if (side[t] > 0) keep.push([cut.indices[t * 3], cut.indices[t * 3 + 1], cut.indices[t * 3 + 2]]);
  if (!keep.length) return { ok: false, reason: 'disk', detail: 'nothing of the sheet is left inside the rings' };
  /* the largest piece only */
  const largest = (() => {
    const parent = new Map(); const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
    for (const f of keep) for (const v of f) if (!parent.has(v)) parent.set(v, v);
    for (const f of keep) { const a = find(f[0]); for (let k = 1; k < 3; k++) { const b = find(f[k]); if (a !== b) parent.set(b, a); } }
    const area = new Map();
    for (const f of keep) { const r = find(f[0]); const A = cut.positions, a = f[0] * 3, b = f[1] * 3, c = f[2] * 3; const ux = A[b] - A[a], uy = A[b + 1] - A[a + 1], uz = A[b + 2] - A[a + 2], vx = A[c] - A[a], vy = A[c + 1] - A[a + 1], vz = A[c + 2] - A[a + 2]; area.set(r, (area.get(r) || 0) + 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)); }
    let best = null; for (const [r, a] of area) if (best === null || a > area.get(best)) best = r;
    return keep.filter((f) => find(f[0]) === best);
  })();
  const diskPatch = compactPatch(cut.positions, largest);
  let diskArea = 0;
  for (const [a, b, c] of diskPatch.faces) { const A = diskPatch.vertices[a], B = diskPatch.vertices[b], C = diskPatch.vertices[c]; const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2]; diskArea += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); }
  const diskTarget = Math.max(30, Math.round(diskArea / (edge * edge) / 10) * 10);
  const disk = await remeshSheet(diskPatch, diskTarget, { ...o, sharp: false, evenLoops: false });
  if (!disk.ok) return disk;
  const diskLoops = findQuadBoundaryLoops(disk.cage.faces, disk.cage.vertices.length);
  if (diskLoops.length !== 1) return { ok: false, reason: 'disk', detail: `the disk remeshed with ${diskLoops.length} loops` };
  const base = vertices.length;
  for (const v of disk.cage.vertices) vertices.push(v.slice());
  const diskFaces = disk.cage.faces.map((f) => f.map((v) => v + base));
  const diskLoop = diskLoops[0].map((v) => v + base);
  /* the disk faces the way the rings do: its faces then traverse its loop
   * against the ring's order, and the zipper takes that loop reversed.
   * Which way the loops run is read from the resample's own cost. */
  const runsWith = (R) => { // does R (index order) run beside ring's order or against it?
    const m = R.length; let s0 = 0, bd = Infinity; const r0 = vertices[ring[0]];
    for (let k = 0; k < m; k++) { const p = vertices[R[k]]; const d = (p[0] - r0[0]) ** 2 + (p[1] - r0[1]) ** 2 + (p[2] - r0[2]) ** 2; if (d < bd) { bd = d; s0 = k; } }
    let fwd = 0, back = 0;
    for (let k = 0; k < Math.min(n, m); k++) { const r = vertices[ring[k]], f = vertices[R[(s0 + Math.round(k * m / n)) % m]], b = vertices[R[((s0 - Math.round(k * m / n)) % m + m) % m]]; fwd += Math.hypot(f[0] - r[0], f[1] - r[1], f[2] - r[2]); back += Math.hypot(b[0] - r[0], b[1] - r[1], b[2] - r[2]); }
    return { with: fwd <= back, start: s0 };
  };
  let B = diskLoop;
  const rw = runsWith(diskLoop);
  if (rw.with) { for (const f of diskFaces) f.reverse(); } else B = diskLoop.slice().reverse();
  for (const f of diskFaces) faces.push(f);
  const rb = runsWith(B);
  B = B.slice(rb.start).concat(B.slice(0, rb.start));
  const zip = zipperStrip(ring, B, vertices, faces);
  if (!zip.ok) return zip;
  return { ok: true, from, to: faces.length, quads: disk.cage.faces.length, target: diskTarget, rows, cutAt, triples: zip.triples, rimSnapped: disk.rimSnapped };
}

async function closeGround(outer, sheets, piece, o) {
  const loops = findQuadBoundaryLoops(outer.faces, outer.vertices.length);
  if (loops.length !== 2) return { ok: false, reason: 'loops', detail: `the sidewall remeshed with ${loops.length} boundary loops, not two` };
  const P = piece.positions;
  const vertices = outer.vertices.map((v) => v.slice()), faces = outer.faces.map((f) => f.slice());
  const creases = {}, w = (1 - Math.min(1, Math.max(0, o.rimSoft))) * CREASE_SCALE;
  /* the two loops: the lower is the floor's corner, the upper the rim on the last */
  const meanY = (L) => L.reduce((t, i) => t + vertices[i][1], 0) / L.length;
  const [floorLoop, loop] = loops.slice().sort((a, b) => meanY(a) - meanY(b));
  for (let k = 0; k < floorLoop.length; k++) creases[edgeKey(floorLoop[k], floorLoop[(k + 1) % floorLoop.length])] = CREASE_SCALE;
  if (w > 1e-9) for (let k = 0; k < loop.length; k++) creases[edgeKey(loop[k], loop[(k + 1) % loop.length])] = w;
  const floorCap = await capLoop(floorLoop, compactPatch(P, sheets.floor), vertices, faces, o);
  if (!floorCap.ok) return floorCap;
  const innerStart = faces.length;
  const innerCap = await capLoop(loop, compactPatch(P, sheets.inner), vertices, faces, o);
  if (!innerCap.ok) return innerCap;
  return {
    ok: true, cage: { vertices, faces, creases }, rims: [{ outer: loop.slice(), inner: loop.slice() }],
    sheets: { outer: [0, innerStart], inner: [innerStart, faces.length], wall: [innerStart, innerStart] },
    floor: { quads: floorCap.quads, target: floorCap.target, triples: floorCap.triples, rimSnapped: floorCap.rimSnapped, loop: floorLoop.length },
    disk: { quads: innerCap.quads, target: innerCap.target, rows: innerCap.rows, cutAt: innerCap.cutAt, triples: innerCap.triples, rimSnapped: innerCap.rimSnapped },
  };
}

// ── the finish: one refit of the whole solid ───────────────────────────────
// The refit: every vertex moved until the drawn surface — the cage
// subdivided `levels` times, whose first vertices are the cage's own — passes
// through its target. Crease rules included, so a rim vertex lands on the
// rim; MASQ's refitCageToLimitTargets reads the smooth mask and skips
// creased vertices, which left 0.5 mm along every rim.
function refitToLevel(cage, targets, levels, passes) {
  let maxError = Infinity;
  for (let pass = 0; pass <= passes; pass++) {
    let cur = cage;
    for (let L = 0; L < levels; L++) cur = subdivideCatmullClark(cur);
    let err = 0;
    const d = targets.map((t, i) => { const p = cur.vertices[i]; const m = [t[0] - p[0], t[1] - p[1], t[2] - p[2]]; err = Math.max(err, Math.hypot(m[0], m[1], m[2])); return m; });
    maxError = err;
    if (pass === passes || err < 0.02) break;
    for (let i = 0; i < d.length; i++) { const v = cage.vertices[i]; v[0] += d[i][0]; v[1] += d[i][1]; v[2] += d[i][2]; }
  }
  return { maxError };
}

// ── deviations of the limit surface ────────────────────────────────────────
function deviations(limit, cage, levels, range, field, signedTo) {
  const own = limitVerticesOwnedBy(limit, cage, levels, (fi) => fi >= range[0] && fi < range[1]);
  const ds = [];
  let maxIn = 0;
  for (let v = 0; v < own.length; v++) {
    if (!own[v]) continue;
    const p = [limit.positions[v * 3], limit.positions[v * 3 + 1], limit.positions[v * 3 + 2]];
    if (signedTo) { const s = field.signed(p, 20); if (s.tri >= 0) { ds.push(Math.abs(s.s)); if (s.s < -maxIn) maxIn = -s.s; } }
    else { const n = field.nearest(p, 20); if (n.tri >= 0) ds.push(n.d); }
  }
  ds.sort((x, y) => x - y);
  const at = (f) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(f * ds.length))] : 0);
  return { samples: ds.length, median: at(0.5), p95: at(0.95), max: ds.length ? ds[ds.length - 1] : 0, inside: maxIn };
}

function eulerOf(cage) {
  const E = new Set();
  for (const f of cage.faces) for (let k = 0; k < f.length; k++) E.add(edgeKey(f[k], f[(k + 1) % f.length]));
  const used = new Set(); for (const f of cage.faces) for (const v of f) used.add(v);
  return used.size - E.size + cage.faces.length;
}

/**
 * pieceToSuperB(piece, substrate, opts) → { ok, cage, limitMesh, rims, sheets, stats } | { ok:false, reason, detail }
 * piece: a closed mesh in mm — a footie ({positions, indices, rims}) or a
 * ground ({positions, indices, loops, stats.hasBand}). substrate: the last
 * {positions, indices} the piece sits on. Async: QuadriFlow's wasm.
 */
export async function pieceToSuperB(piece, substrate, opts = {}) {
  const o = { ...SUPERB_DEFAULTS, ...opts };
  const t0 = performance.now();
  const times = {};
  const subField = meshField(substrate.positions, substrate.indices);
  const subMesh = { positions: substrate.positions, indices: substrate.indices, normals: vertexNormals(substrate.positions, substrate.indices) };
  const sheets = sheetsOf(piece, subField, o.touchMM);
  if (!sheets.inner.length) return { ok: false, reason: 'substrate', detail: 'no triangle of the piece lies on the substrate' };
  if (!sheets.outer.length) return { ok: false, reason: 'sheet', detail: 'the piece has no outer sheet' };
  const patch = compactPatch(piece.positions, sheets.outer);
  const whole = sheets.floor && sheets.floor.length ? compactPatch(piece.positions, sheets.outer.concat(sheets.floor)) : patch;
  const outerFlat = new Float32Array(whole.vertices.length * 3);
  whole.vertices.forEach((v, i) => { outerFlat[i * 3] = v[0]; outerFlat[i * 3 + 1] = v[1]; outerFlat[i * 3 + 2] = v[2]; });
  const outerField = meshField(outerFlat, new Uint32Array(whole.faces.flat()));
  times.split = performance.now() - t0;
  const t1 = performance.now();
  const oc = await outerCage(patch, o, !piece.rims);
  if (!oc.ok) return oc;
  times.remesh = performance.now() - t1;
  const t2 = performance.now();
  const closed = piece.rims ? closeShell(oc.cage, patch, piece, outerField, o) : await closeGround(oc.cage, sheets, piece, o);
  if (!closed.ok) return closed;
  let cage = closed.cage;
  if (cageVolume(cage) < 0) cage.faces = cage.faces.map((f) => f.slice().reverse());
  if (!isClosedManifold(cage)) return { ok: false, reason: 'cage', detail: 'the solid is not a closed manifold' };
  /* the cage's vertices sit on the sheets; a Catmull-Clark limit lies inside
   * its cage, so one refit moves them until their limits land back on the
   * sheets, both sheets together */
  /* inner-sheet targets sit `biasMM` off the substrate along its normal:
   * the drawn surface ripples ±0.25 mm between the cage's vertices, and the
   * bias keeps the ripple's inward half under the plan's 0.2 mm */
  const targets = cage.vertices.map((v) => v.slice());
  if (o.biasMM > 0) {
    const innerV = new Set();
    for (let fi = closed.sheets.inner[0]; fi < closed.sheets.inner[1]; fi++) for (const v of cage.faces[fi]) innerV.add(v);
    for (const r of closed.rims) for (const v of r.inner) innerV.delete(v);
    for (const v of innerV) {
      const s = subField.signed(targets[v], 10); if (s.tri < 0) continue;
      const a = substrate.indices[s.tri * 3], nx = subMesh.normals[a * 3], ny = subMesh.normals[a * 3 + 1], nz = subMesh.normals[a * 3 + 2];
      targets[v][0] += nx * o.biasMM; targets[v][1] += ny * o.biasMM; targets[v][2] += nz * o.biasMM;
    }
  }
  const refit = refitToLevel(cage, targets, o.levels, o.refitPasses);
  times.close = performance.now() - t2;
  const val = validateSuperBCage(cage, { corners: false });
  if (!val.ok) return { ok: false, reason: 'cage', detail: val.reason };
  if (val.cage && val.cage.vertices.length !== cage.vertices.length) return { ok: false, reason: 'cage', detail: `${cage.vertices.length - val.cage.vertices.length} coincident cage vertices` };
  const t3 = performance.now();
  const limitMesh = evaluateSubDLimitMesh(cage, o.levels);
  times.limit = performance.now() - t3;
  const t4 = performance.now();
  const dOuter = deviations(limitMesh, cage, o.levels, closed.sheets.outer, outerField, false);
  const dInner = deviations(limitMesh, cage, o.levels, closed.sheets.inner, subField, true);
  times.measure = performance.now() - t4;
  times.total = performance.now() - t0;
  const stats = {
    quads: cage.faces.length, vertices: cage.vertices.length, euler: eulerOf(cage),
    outerQuads: oc.cage.faces.length, targetQuads: oc.targetFaces, askedQuads: oc.asked, derived: oc.derived,
    rims: closed.rims.length, volumeCm3: cageVolume(cage) / 1000, floorY: piece.stats && piece.stats.floorY,
    maxDeviationMM: dOuter.max, p95DeviationMM: dOuter.p95, medianDeviationMM: dOuter.median,
    innerDeviationMM: dInner.max, innerP95MM: dInner.p95, innerInsideMM: dInner.inside, innerSamples: dInner.samples,
    refitMaxError: refit.maxError, floor: closed.floor || null, disk: closed.disk || null,
    reduction: oc.reduction, times,
  };
  return { ok: true, cage, limitMesh, rims: closed.rims, sheets: closed.sheets, stats };
}

// ── a plate as a cage ──────────────────────────────────────────────────────
// buildPlate's cage as the SuperB it is: the outer sheet's quads first over
// vertices [0, nv), the inner sheet's next over [nv, 2nv) (vertex nv + i the
// twin of i), the rim rings after; each rim as { outer, inner } by the twin
// rule. No creases: rimCreases writes them.
export function plateCage(plate) {
  const c = plate.cage || plate, P = c.positions, Q = c.quads, nv = c.sheetCount;
  const vertices = new Array(P.length / 3), faces = new Array(Q.length / 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  for (let f = 0; f < faces.length; f++) faces[f] = [Q[f * 4], Q[f * 4 + 1], Q[f * 4 + 2], Q[f * 4 + 3]];
  const rims = (c.rims || []).map((L) => { const outer = Array.from(L); return { outer, inner: outer.map((v) => v + nv) }; });
  return { vertices, faces, creases: {}, rims, sheets: { outer: [0, c.sheetFaces], inner: [c.sheetFaces, 2 * c.sheetFaces], wall: [2 * c.sheetFaces, faces.length] } };
}

// ── the rims' creases ──────────────────────────────────────────────────────
// The crease map for a cage from its rim loops (MASQ superbsolid's rule): a
// loop's weight is (1 − soft)·CREASE_SCALE, 1 a hard crease (the current
// build), 0 no crease; `rimSoft` for the feather line — the LOWEST loop by
// its mean height — and `holeSoft` for every other loop (an opening: the
// topline, a vent); `weights[k]` (0..1 soft, per loop, null to defer) is the
// app's own say over loop k. A loop is an array of vertex ids or
// { outer, inner } (pieceToSuperB's rims, plateCage's), both sides creased.
// Every other entry of the cage's map (a sole's floor corner) is kept.
// Returns { creases, loops: [{ soft, weight, meanY, feather, edges }] }.
export function rimCreases(cage, loops, { rimSoft = 0, holeSoft = 0, weights = null } = {}) {
  const V = cage.vertices, creases = { ...(cage.creases || {}) };
  const sides = (L) => (Array.isArray(L) ? [L] : [L.outer, L.inner].filter((x) => x && x.length));
  const meanY = (L) => { const o = Array.isArray(L) ? L : L.outer; return o.reduce((t, i) => t + V[i][1], 0) / (o.length || 1); };
  const ys = loops.map(meanY);
  let lowest = -1; ys.forEach((y, k) => { if (lowest < 0 || y < ys[lowest]) lowest = k; });
  const report = [];
  loops.forEach((L, k) => {
    const feather = k === lowest;
    const given = weights && weights[k] != null ? weights[k] : null;
    const soft = Math.max(0, Math.min(1, given != null ? given : feather ? rimSoft : holeSoft));
    const w = (1 - soft) * CREASE_SCALE;
    let edges = 0;
    for (const S of sides(L)) for (let i = 0; i < S.length; i++) {
      const key = edgeKey(S[i], S[(i + 1) % S.length]);
      if (w > 1e-9) creases[key] = w; else delete creases[key];
      edges++;
    }
    report.push({ soft, weight: w, meanY: ys[k], feather, edges });
  });
  return { creases, loops: report };
}

// ── Detail: the outer sheet refined locally ────────────────────────────────
// The outer sheet's faces subdivided `levels` times (Catmull-Clark on the
// sheet alone; tosuperb's refineSheetLocally), every other face left one
// face: a face across the seam takes the sheet's refined vertices along it,
// so the rim wall's top row becomes (3 + 2^levels)-gons and the cage stays
// watertight. 4^levels quads per sheet quad. Detail 1 is 2× (one level),
// 2 is 4×. The sheet's creases are carried a level down per level in
// `creases` (a reader that decays a weight per level: Unreason) and held at
// CREASE_SCALE in `creasesHeld` (a reader whose crease's children are
// creases: Rhino, cage3dm); the rest as they were.
// cage: { vertices, faces, creases } with `sheets.outer` = [from, to) (or
// opts.outer). Returns { vertices, faces, creases, creasesHeld, sheetFace,
// sheetInterior, normals, levels, outer: [from', to'), cage3dm, stats }.
export function detailCage(cage, levels = 1, opts = {}) {
  const L = Math.max(0, Math.min(3, Math.round(levels)));
  const range = opts.outer || (cage.sheets && cage.sheets.outer) || (cage.sheetFaces ? [0, cage.sheetFaces] : null);
  if (!range) return { ok: false, reason: 'sheet', detail: 'no outer sheet range: pass opts.outer = [from, to)' };
  const [from, to] = range;
  if (!L) return { ok: true, vertices: cage.vertices.map((v) => v.slice()), faces: cage.faces.map((f) => f.slice()), creases: { ...(cage.creases || {}) }, creasesHeld: { ...(cage.creases || {}) }, levels: 0, outer: [from, to], cage3dm: null, stats: { outerQuads: to - from, before: cage.faces.length, after: cage.faces.length, ngons: 0 } };
  const r = refineSheetLocally(cage, from, to, L, CREASE_SCALE);
  const rest = cage.faces.length - (to - from);
  let ngons = 0, maxSides = 0;
  for (const f of r.faces) { if (f.length > 4) ngons++; if (f.length > maxSides) maxSides = f.length; }
  const out = {
    ok: true, vertices: r.vertices, faces: r.faces, creases: r.creases, creasesHeld: r.creasesHeld,
    sheetFace: r.sheetFace, sheetInterior: r.sheetInterior, normals: r.normals, levels: L, outer: [rest, r.faces.length],
    stats: { outerQuads: to - from, before: cage.faces.length, after: r.faces.length, ngons, maxSides, vertices: r.vertices.length },
  };
  out.cage3dm = { vertices: r.vertices, faces: r.faces, creases: r.creasesHeld };
  return out;
}

// ── the worker road: plain data both ways ──────────────────────────────────
export function packPiece(piece) {
  return {
    positions: Float32Array.from(piece.positions), indices: Uint32Array.from(piece.indices),
    rims: piece.rims ? piece.rims.map((r) => ({ inner: Array.from(r.inner), outer: Array.from(r.outer), kind: r.kind })) : null,
    loops: piece.loops ? { feather: Array.from(piece.loops.feather), floor: Array.from(piece.loops.floor), rims: piece.loops.rims.map((l) => Array.from(l)) } : null,
    stats: piece.stats ? { hasBand: !!piece.stats.hasBand, rings: piece.stats.rings, floorY: piece.stats.floorY } : null,
  };
}
export function packResult(r) {
  if (!r.ok) return r;
  const V = new Float64Array(r.cage.vertices.length * 3);
  r.cage.vertices.forEach((v, i) => { V[i * 3] = v[0]; V[i * 3 + 1] = v[1]; V[i * 3 + 2] = v[2]; });
  const F = new Int32Array(r.cage.faces.length * 4);
  r.cage.faces.forEach((f, i) => { F[i * 4] = f[0]; F[i * 4 + 1] = f[1]; F[i * 4 + 2] = f[2]; F[i * 4 + 3] = f[3]; });
  return { ok: true, V, F, creases: r.cage.creases, limit: { positions: r.limitMesh.positions, normals: r.limitMesh.normals, indices: r.limitMesh.indices }, rims: r.rims, sheets: r.sheets, stats: r.stats };
}
export function unpackResult(m) {
  if (!m.ok) return m;
  const vertices = new Array(m.V.length / 3), faces = new Array(m.F.length / 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = [m.V[i * 3], m.V[i * 3 + 1], m.V[i * 3 + 2]];
  for (let i = 0; i < faces.length; i++) faces[i] = [m.F[i * 4], m.F[i * 4 + 1], m.F[i * 4 + 2], m.F[i * 4 + 3]];
  return { ok: true, cage: { vertices, faces, creases: m.creases }, limitMesh: m.limit, rims: m.rims, sheets: m.sheets, stats: m.stats };
}

/* One build in flight per client; a result whose id is not the latest asked
 * is dropped. `url` defaults to superb.worker.js beside this module. */
export function createSuperBWorker(url) {
  let worker = null, nextId = 1, latest = 0;
  const pending = new Map();
  const spawn = () => {
    const w = new Worker(url || new URL('./superb.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      if (e.data.id !== latest) { p.resolve({ ok: false, reason: 'stale', detail: 'a newer build was asked for' }); return; }
      p.resolve(unpackResult(e.data));
    };
    w.onerror = (e) => {
      for (const p of pending.values()) p.resolve({ ok: false, reason: 'worker', detail: e.message || 'the worker died' });
      pending.clear();
      try { w.terminate(); } catch (_) {}
      worker = null;
    };
    return w;
  };
  return {
    build(piece, substrate, opts = {}) {
      if (!worker) worker = spawn();
      const id = nextId++; latest = id;
      const msg = { id, piece: packPiece(piece), substrate: { positions: Float32Array.from(substrate.positions), indices: Uint32Array.from(substrate.indices) }, opts };
      return new Promise((resolve) => { pending.set(id, { resolve }); worker.postMessage(msg, [msg.piece.positions.buffer, msg.piece.indices.buffer, msg.substrate.positions.buffer, msg.substrate.indices.buffer]); });
    },
    inFlight() { return pending.size; },
    terminate() { if (worker) { try { worker.terminate(); } catch (_) {} worker = null; } for (const p of pending.values()) p.resolve({ ok: false, reason: 'stale', detail: 'terminated' }); pending.clear(); },
  };
}
