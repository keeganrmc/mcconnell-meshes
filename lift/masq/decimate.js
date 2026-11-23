// MASQ — QUADRIC EDGE COLLAPSE, the decimator for the printable level set.
//
// buildLevelSet (src/levelset.js) meshes the zero set of the mask field on a
// uniform grid with marching tetrahedra. That mesh is watertight and it cannot
// self-intersect, and it samples a smooth surface at a fixed rate whether the
// surface is flat or not: a full-face mask at 1.0 mm cells is 737,028
// triangles and a 35 MB archive, against the offset mesh's 74,840 triangles
// and 3.6 MB. No printer resolves the difference. This module removes the
// triangles the surface does not need, and refuses every collapse that would
// cost the level set a property it was built to guarantee.
//
// THE METRIC IS GARLAND-HECKBERT. Each triangle contributes the fundamental
// error quadric of its plane, K = w * (n, d)(n, d)^T with n the unit normal and
// d = -n.p0, weighted by w = the triangle's area. A vertex carries the sum of
// its incident K, and v^T Q v is then the area-weighted sum of the squared
// distances from v to those planes. Collapsing sums the two quadrics.
//
// THE COST IS NORMALIZED BY THE ACCUMULATED WEIGHT, AND WITHOUT THAT
// maxErrorMM WOULD MEAN A DIFFERENT THING AT EACH END OF THE RUN. A raw
// Garland-Heckbert sum grows as a vertex absorbs its neighbors — after a 10x
// reduction one surviving quadric is the sum of a hundred planes — so a fixed
// threshold on it tightens as the mesh coarsens for no geometric reason.
// Dividing by the accumulated area turns the cost into an area-weighted MEAN
// squared distance to the incident planes, in meters squared, whose square root
// is a length that means the same thing at 737k triangles and at 75k. The
// division is by a positive scalar, so it cannot change the sign of a cost or
// the fact that a coplanar neighborhood costs exactly zero.
//
// PLACEMENT: SOLVE, THEN FALL BACK. The position minimizing v^T Q v is the
// solution of A v = -b with A the upper-left 3x3 of Q; it beats the midpoint
// wherever the neighborhood has curvature in three independent directions. A
// is singular on a flat or a symmetric neighborhood, which is most of a level
// set, and it fails in TWO ways: a determinant at the noise floor, and a
// determinant that clears the conditioning test while the solution lands far
// outside the neighborhood, because the quadric is a valley rather than a bowl.
// Both are caught — the first by |det| against the cube of the matrix norm, the
// second by a range test on the result — and both fall back to the cheapest of
// the two endpoints and the midpoint by the same quadric.
// stats.solvedPlacements and stats.fallbackPlacements say which ran.
//
// THREE REFUSALS, AND THEY ARE WHAT MAKE THIS SAFE RATHER THAN FAST.
//
//   A COLLAPSE THAT FLIPS A TRIANGLE IS REFUSED, AGAINST TWO REFERENCES.
//   Every triangle of the one-ring that survives the collapse must keep its
//   unit normal within MAX_TURN of where it was immediately before the collapse,
//   AND on the same side as the normal that triangle had in the INPUT mesh. A
//   reversed triangle in a printable mesh is a self-intersection, and not
//   self-intersecting is the entire reason the level set exists.
//
//   THE SECOND REFERENCE IS NOT REDUNDANT, AND A DECIMATOR WITH ONLY THE FIRST
//   SHIPS REVERSED TRIANGLES. A per-collapse bound does not compound into a
//   bound on the total: a triangle touched by many collapses may turn a little
//   each time and end up facing backward, and it does. Measured on a radially
//   perturbed icosphere, the per-collapse bound alone leaves 1 of 2,560
//   triangles reversed against its input orientation at a 2x reduction and 18 of
//   512 at a 10x; carrying the input normal and refusing on the sign leaves zero
//   at every reduction level. It is also the reference that does the work: on a
//   738,840-triangle level set reduced 10x the refusal fires on 13,297 of
//   346,685 candidate collapses, 12,292 of them on the sign and 1,004 on the
//   angle. Both are counted together in stats.flippedRejected.
//
//   A COLLAPSE THAT WOULD MAKE THE MESH NON-MANIFOLD IS REFUSED. The link
//   condition: for edge (u,v) the intersection of the one-ring neighborhoods of
//   u and v must be exactly the two vertices opposite the edge. An edge that
//   fails it and is collapsed anyway welds two sheets that only touched, and
//   the result is an edge with three or four incident triangles — a mesh a
//   slicer refuses, produced silently. Counted in stats.linkRejected.
//
//   BOUNDARY EDGES ARE PRESERVED, VERTEX FOR VERTEX. A vertex on an edge with
//   anything other than exactly two incident triangles is locked: it never dies
//   and it never moves. An interior vertex may still collapse INTO a locked one,
//   at the locked one's position, so a patch still reduces up to its border. The
//   level set is closed and has no boundary, but keepLargestShell
//   (src/exporters.js) runs immediately before this and a decimator that erodes
//   a boundary is worse than no decimator.
//
// A CLOSED COMPONENT CANNOT GO BELOW FOUR TRIANGLES. The link condition alone
// passes on a tetrahedron, whose collapse leaves two triangles on the same three
// vertices. The triangle floor is the guard the link condition does not give.
//
// THE INPUT IS WELDED HERE, TO THE FILE'S RESOLUTION. Topology is read from the
// index array alone, so two vertices at one point with different indices are
// two vertices to every test in this module and one vertex to every reader of
// the STL, which merges corners by exact float32 millimeter position. Measured
// on the shipped exports, every shell carried one such point: a zero-length
// edge with 10-14 zero-area triangles on it, which the flip refusal then
// locked (a triangle with no input normal fails the sign test against
// everything) and shipped as 5-6 non-manifold edges plus 400-550 sub-degree
// slivers around it. weldVertices runs on the input first, and a triangle
// that arrives with no plane keeps no side: it is collapsed like any other
// rather than holding its neighbors still.
import { weldVertices, WELD_M } from './levelset.js';

const MM = 0.001;

// THE PRINTABLE'S REDUCTION, one rule for every mask. The error budget sets
// the count: 0.05 mm is a quarter of a 0.2 mm layer. Measured at 1.0 mm cells
// with the branch crossing: a full face needs 16,012 triangles for it (24 per
// cm2), an orbital band 2,782, a 40 mm sphere shell 11 per cm2; at 0.02 mm the
// face needs 34,210 and at 0.01 mm 61,344. A fixed count gave the band and the
// face the same 75,000. The floor keeps a small mask from being reduced to
// facets a slicer preview shows and sits under what a plain full face needs,
// so the budget is what decides on a face; the cap bounds the file when the
// budget would let a patterned full face run past it, and past the cap the
// budget yields, so stats.maxErrorMM then reports the deviation actually
// taken. Bound only with the branch crossing in levelset.js: on the field
// interpolation the spikes' own error stopped the same budget at 35,688 on
// the face.
export const PRINT_REDUCTION = Object.freeze({ targetTriangles: 10000, maxErrorMM: 0.05, maxTriangles: 150000 });

// A surviving triangle's unit normal may turn this far under one collapse.
// cos(60 deg). This is the local bound and it is the cheaper of the two flip
// references: the marching-tetrahedra mesh carries slivers whose normals swing
// on the smallest move, and holding the one-ring's shape from step to step is
// what keeps a sliver from being handed to the next collapse already folded.
// The sign test against the input normal is what bounds the total.
const MAX_TURN = 0.5;

// |det A| below this multiple of the cube of A's largest entry is the noise
// floor of the 3x3 quadric solve, not a solvable system.
const SOLVE_COND = 1e-9;

// A solved placement further than this many edge lengths from the edge midpoint
// came out of a near-singular system that cleared SOLVE_COND, and is discarded
// for the fallback.
const SOLVE_RANGE = 4;

// A closed surface component has at least four triangles.
const MIN_TRIANGLES = 4;

/**
 * Edge count, boundary edge count, non-manifold edge count, component count and
 * Euler characteristic of an indexed triangle mesh, read from the indices
 * alone. Components are counted over TRIANGLES joined across shared edges, so
 * two sheets that meet at a single vertex are not joined.
 *
 * Exported because the decimator's whole claim is that these numbers do not
 * move, and a gate has to measure them on an input, on an output and on a
 * deliberately broken copy of either.
 *
 * @param {Float32Array|Float64Array} positions  3 per vertex
 * @param {Uint32Array|Int32Array|Array} indices  3 per triangle
 */
export function meshTopology(positions, indices) {
  const V = positions.length / 3;
  const F = indices.length / 3;
  if (F === 0) return { edges: 0, boundary: 0, nonManifold: 0, components: 0, euler: 0 };
  const use = new Map();
  const parent = new Int32Array(F);
  for (let f = 0; f < F; f++) parent[f] = f;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let f = 0; f < F; f++) {
    const v = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    for (let i = 0; i < 3; i++) {
      const a = v[i], b = v[(i + 1) % 3];
      const key = a < b ? a * V + b : b * V + a;
      const e = use.get(key);
      if (e === undefined) use.set(key, { n: 1, f });
      else { if (e.n === 1) { const ra = find(e.f), rb = find(f); if (ra !== rb) parent[ra] = rb; } e.n++; }
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const e of use.values()) {
    if (e.n === 1) boundary++;
    else if (e.n > 2) nonManifold++;
  }
  let components = 0;
  for (let f = 0; f < F; f++) if (find(f) === f) components++;
  return { edges: use.size, boundary, nonManifold, components, euler: V - use.size + F };
}

/**
 * @param {object} args
 * @param {Float32Array} args.positions  3 per vertex, METERS
 * @param {Uint32Array|Uint16Array} args.indices  3 per triangle
 * @param {number} [args.targetTriangles]  stop at or below this; default 0,
 *   which means "as far as the refusals and maxErrorMM allow"
 * @param {number} [args.maxErrorMM]  stop when the cheapest remaining collapse
 *   would cost more than this. MILLIMETERS. Both stopping conditions are
 *   honored and whichever binds first ends the run; stats.stoppedOn says which.
 * @param {number} [args.maxTriangles]  above this count the error budget does
 *   not stop the run: collapses over budget are taken, cheapest first, until
 *   the count is at or under it. Default Infinity. stats.overBudgetCollapses
 *   counts them and stoppedOn reads 'cap' when any were taken.
 * @param {{flips?: boolean, nonManifold?: boolean, boundary?: boolean}} [args.refuse]
 *   Each refusal, on by default. The app never passes this; a gate turns one off
 *   to watch the mesh that refusal defends go wrong on the same fixture.
 * @returns {{positions: Float32Array, indices: Uint32Array, sourceTriangles: Uint32Array, stats: object}}
 *   positions are METERS. sourceTriangles gives, for each output triangle, the
 *   index of the input triangle it descends from: a collapse retargets a
 *   triangle's corners and never splits or reorders one, so the descent is one
 *   to one. It is what carries a per-face attribute across the decimation, and
 *   it is the only way to ask whether a surviving triangle still faces where it
 *   started, which is the refusal that keeps the mesh printable.
 */
export function decimate({ positions, indices, targetTriangles, maxErrorMM, maxTriangles, refuse }) {
  const Vin = positions.length / 3;
  const Fin = indices.length / 3;
  if (!Number.isInteger(Vin)) throw new Error('positions.length must be a multiple of 3');
  if (!Number.isInteger(Fin)) throw new Error('indices.length must be a multiple of 3');
  const target = targetTriangles === undefined || targetTriangles === null ? 0 : targetTriangles;
  if (!Number.isFinite(target) || target < 0) throw new Error('targetTriangles must be a finite count of zero or more');
  if (maxErrorMM !== undefined && maxErrorMM !== null && !(maxErrorMM >= 0)) {
    throw new Error('maxErrorMM must be zero or more millimeters');
  }
  const capTris = maxTriangles === undefined || maxTriangles === null ? Infinity : maxTriangles;
  if (!(capTris >= 0)) throw new Error('maxTriangles must be zero or more');
  for (let i = 0; i < Fin * 3; i++) {
    const v = indices[i];
    if (!(v >= 0 && v < Vin)) throw new Error('indices reference vertex ' + v + ' outside 0..' + (Vin - 1));
  }
  const welded = weldVertices(positions, indices, WELD_M);
  positions = welded.positions; indices = welded.indices;
  const V0 = positions.length / 3;
  const F0 = indices.length / 3;
  const R = {
    flips: refuse === undefined || refuse.flips !== false,
    nonManifold: refuse === undefined || refuse.nonManifold !== false,
    boundary: refuse === undefined || refuse.boundary !== false,
  };

  // ------------------------------------------------------------ UNIT BOUNDARY
  // THE ONLY PLACE THE TWO SYSTEMS MEET. `positions` are meters and
  // `maxErrorMM` is millimeters. It is converted here, once, into the squared
  // meters the quadric cost is already in, and every comparison below this line
  // is meters squared against meters squared. The one conversion back out is
  // the square root at the bottom that fills stats.maxErrorMM. Mixing the two
  // inside one expression is a defect class this project has already paid for.
  const maxErrorM = maxErrorMM === undefined || maxErrorMM === null ? Infinity : maxErrorMM * MM;
  const maxCost = maxErrorM === Infinity ? Infinity : maxErrorM * maxErrorM;
  // -------------------------------------------------------- end unit boundary

  if (F0 === 0) {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      sourceTriangles: new Uint32Array(0),
      stats: emptyStats(target, maxErrorMM, Fin, Vin, welded),
    };
  }

  // Working geometry is doubles: a collapse target is the solution of a linear
  // system, and rounding it to Float32 before the flip test would let the test
  // pass on a position the mesh never gets.
  const px = new Float64Array(V0 * 3);
  for (let i = 0; i < V0 * 3; i++) px[i] = positions[i];
  const tv = new Int32Array(F0 * 3);
  for (let i = 0; i < F0 * 3; i++) tv[i] = indices[i];
  const tlive = new Uint8Array(F0).fill(1);
  let liveTris = F0;

  // -------------------------------------------------------------- incidence
  const vtri = new Array(V0);
  for (let v = 0; v < V0; v++) vtri[v] = [];
  for (let f = 0; f < F0; f++) {
    const a = tv[f * 3], b = tv[f * 3 + 1], c = tv[f * 3 + 2];
    // A triangle that repeats a vertex has no plane and no orientation. It is
    // dropped rather than carried, so it cannot appear in the output as a
    // triangle the flip test was never able to judge.
    if (a === b || b === c || c === a) { tlive[f] = 0; liveTris--; continue; }
    vtri[a].push(f); vtri[b].push(f); vtri[c].push(f);
  }
  const alive = new Uint8Array(V0);
  for (let v = 0; v < V0; v++) alive[v] = vtri[v].length ? 1 : 0;

  // ------------------------------------------------------ edges and the locks
  const edgeUse = new Map();
  for (let f = 0; f < F0; f++) {
    if (!tlive[f]) continue;
    const v = [tv[f * 3], tv[f * 3 + 1], tv[f * 3 + 2]];
    for (let i = 0; i < 3; i++) {
      const a = v[i], b = v[(i + 1) % 3];
      const key = a < b ? a * V0 + b : b * V0 + a;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  const locked = new Uint8Array(V0);
  let lockedVertices = 0;
  if (R.boundary) {
    for (const [key, n] of edgeUse) {
      if (n === 2) continue;
      const a = Math.floor(key / V0), b = key - a * V0;
      locked[a] = 1; locked[b] = 1;
    }
    for (let v = 0; v < V0; v++) if (locked[v]) lockedVertices++;
  }

  // --------------------------------------------------------------- quadrics
  // Eleven doubles per vertex: the ten distinct entries of the symmetric 4x4,
  // then the accumulated area the cost is normalized by. `on` holds the INPUT
  // unit normal of every triangle, which the flip refusal reads for the whole
  // run: it is the reference a per-collapse bound cannot reconstruct once the
  // triangle has moved.
  const Q = new Float64Array(V0 * 11);
  const on = new Float64Array(F0 * 3);
  const oriented = new Uint8Array(F0);
  let flatTriangles = 0;
  for (let f = 0; f < F0; f++) {
    if (!tlive[f]) continue;
    const a = tv[f * 3] * 3, b = tv[f * 3 + 1] * 3, c = tv[f * 3 + 2] * 3;
    const ux = px[b] - px[a], uy = px[b + 1] - px[a + 1], uz = px[b + 2] - px[a + 2];
    const vx = px[c] - px[a], vy = px[c + 1] - px[a + 1], vz = px[c + 2] - px[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) { flatTriangles++; continue; }   // zero area carries no plane and no side
    oriented[f] = 1;
    nx /= len; ny /= len; nz /= len;
    const w = len / 2;
    const d = -(nx * px[a] + ny * px[a + 1] + nz * px[a + 2]);
    on[f * 3] = nx; on[f * 3 + 1] = ny; on[f * 3 + 2] = nz;
    const k0 = nx * nx, k1 = nx * ny, k2 = nx * nz, k3 = nx * d;
    const k4 = ny * ny, k5 = ny * nz, k6 = ny * d;
    const k7 = nz * nz, k8 = nz * d, k9 = d * d;
    for (let i = 0; i < 3; i++) {
      const base = tv[f * 3 + i] * 11;
      Q[base] += w * k0; Q[base + 1] += w * k1; Q[base + 2] += w * k2; Q[base + 3] += w * k3;
      Q[base + 4] += w * k4; Q[base + 5] += w * k5; Q[base + 6] += w * k6;
      Q[base + 7] += w * k7; Q[base + 8] += w * k8; Q[base + 9] += w * k9;
      Q[base + 10] += w;
    }
  }

  // -------------------------------------------------------------- the queue
  // A lazy binary heap. A collapse changes only the surviving vertex's quadric,
  // so every edge on that vertex is pushed again with its new cost and the older
  // entries are discarded when they surface. `stamp` is ver[a] + ver[b]: a
  // version only ever increments, so if either endpoint moved the sum is
  // strictly larger and a stale entry cannot masquerade as fresh.
  const ver = new Int32Array(V0);
  let cap = Math.max(1024, edgeUse.size + 1024);
  let hCost = new Float64Array(cap);
  let hA = new Int32Array(cap);
  let hB = new Int32Array(cap);
  let hS = new Int32Array(cap);
  let hn = 0, peakHeap = 0;
  function heapGrow() {
    cap *= 2;
    const c = new Float64Array(cap); c.set(hCost); hCost = c;
    const a = new Int32Array(cap); a.set(hA); hA = a;
    const b = new Int32Array(cap); b.set(hB); hB = b;
    const s = new Int32Array(cap); s.set(hS); hS = s;
  }
  function heapPush(cost, a, b, stamp) {
    if (hn === cap) heapGrow();
    let i = hn++;
    if (hn > peakHeap) peakHeap = hn;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hCost[p] <= cost) break;
      hCost[i] = hCost[p]; hA[i] = hA[p]; hB[i] = hB[p]; hS[i] = hS[p];
      i = p;
    }
    hCost[i] = cost; hA[i] = a; hB[i] = b; hS[i] = stamp;
  }
  const top = { cost: 0, a: 0, b: 0, stamp: 0 };
  function heapPop() {
    top.cost = hCost[0]; top.a = hA[0]; top.b = hB[0]; top.stamp = hS[0];
    hn--;
    if (hn === 0) return;
    const cost = hCost[hn], a = hA[hn], b = hB[hn], s = hS[hn];
    let i = 0;
    for (;;) {
      let l = 2 * i + 1;
      if (l >= hn) break;
      if (l + 1 < hn && hCost[l + 1] < hCost[l]) l++;
      if (hCost[l] >= cost) break;
      hCost[i] = hCost[l]; hA[i] = hA[l]; hB[i] = hB[l]; hS[i] = hS[l];
      i = l;
    }
    hCost[i] = cost; hA[i] = a; hB[i] = b; hS[i] = s;
  }

  // -------------------------------------------------------- cost and target
  const place = new Float64Array(3);
  const Qm = new Float64Array(11);
  let solved = 0, fallbacks = 0;

  function scratchError(x, y, z) {
    const e = Qm[0] * x * x + 2 * Qm[1] * x * y + 2 * Qm[2] * x * z + 2 * Qm[3] * x
      + Qm[4] * y * y + 2 * Qm[5] * y * z + 2 * Qm[6] * y
      + Qm[7] * z * z + 2 * Qm[8] * z
      + Qm[9];
    return e > 0 ? e : 0;                    // roundoff on a flat neighborhood
  }

  // The NORMALIZED squared error of the best placement for (u,v), in meters
  // squared, with that placement left in `place`. The merged quadric is built in
  // scratch, so costing a candidate never touches either endpoint's own. `count`
  // is set only on the evaluation that leads to a collapse, so the solve and
  // fallback tallies count placements the mesh actually took.
  function edgeCost(u, v, count) {
    const bu = u * 11, bv = v * 11;
    for (let i = 0; i < 11; i++) Qm[i] = Q[bu + i] + Q[bv + i];
    const w = Qm[10] > 0 ? Qm[10] : 1;
    const ux = px[u * 3], uy = px[u * 3 + 1], uz = px[u * 3 + 2];
    const vx = px[v * 3], vy = px[v * 3 + 1], vz = px[v * 3 + 2];

    // A locked endpoint fixes the placement: the survivor sits exactly where the
    // locked vertex already was, so the boundary polygon does not move.
    if (locked[u] && !locked[v]) { place[0] = ux; place[1] = uy; place[2] = uz; return scratchError(ux, uy, uz) / w; }
    if (locked[v] && !locked[u]) { place[0] = vx; place[1] = vy; place[2] = vz; return scratchError(vx, vy, vz) / w; }

    const a2 = Qm[0], ab = Qm[1], ac = Qm[2], b2 = Qm[4], bc = Qm[5], c2 = Qm[7];
    const det = a2 * (b2 * c2 - bc * bc) - ab * (ab * c2 - bc * ac) + ac * (ab * bc - b2 * ac);
    let nrm = 0;
    const ent = [a2, ab, ac, b2, bc, c2];
    for (let i = 0; i < 6; i++) { const m = Math.abs(ent[i]); if (m > nrm) nrm = m; }
    if (Math.abs(det) > SOLVE_COND * nrm * nrm * nrm) {
      const rx = -Qm[3], ry = -Qm[6], rz = -Qm[8];
      const x = (rx * (b2 * c2 - bc * bc) - ab * (ry * c2 - bc * rz) + ac * (ry * bc - b2 * rz)) / det;
      const y = (a2 * (ry * c2 - bc * rz) - rx * (ab * c2 - bc * ac) + ac * (ab * rz - ry * ac)) / det;
      const z = (a2 * (b2 * rz - ry * bc) - ab * (ab * rz - ry * ac) + rx * (ab * bc - b2 * ac)) / det;
      const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
      const reach = SOLVE_RANGE * Math.hypot(vx - ux, vy - uy, vz - uz);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && Math.hypot(x - mx, y - my, z - mz) <= reach) {
        place[0] = x; place[1] = y; place[2] = z;
        if (count) solved++;
        return scratchError(x, y, z) / w;
      }
    }
    // Fallback: the cheapest of the two endpoints and the midpoint, by the same
    // quadric, so its cost stays comparable with a solved edge's.
    const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
    const eu = scratchError(ux, uy, uz);
    const evv = scratchError(vx, vy, vz);
    const em = scratchError(mx, my, mz);
    let best = eu; place[0] = ux; place[1] = uy; place[2] = uz;
    if (evv < best) { best = evv; place[0] = vx; place[1] = vy; place[2] = vz; }
    if (em < best) { best = em; place[0] = mx; place[1] = my; place[2] = mz; }
    if (count) fallbacks++;
    return best / w;
  }

  // --------------------------------------------------------------- refusals
  const mark = new Int32Array(V0);
  const tmark = new Int32Array(F0);
  let gen = 0;

  function compact(v) {
    const L = vtri[v];
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const t = L[i];
      if (!tlive[t]) continue;
      if (tv[t * 3] !== v && tv[t * 3 + 1] !== v && tv[t * 3 + 2] !== v) continue;
      L[w++] = t;
    }
    L.length = w;
    return L;
  }

  // The link condition, with the two vertices opposite the edge left in `opp`.
  const opp = [0, 0];
  function linkCondition(u, v) {
    const Lv = vtri[v];
    let n = 0;
    for (let i = 0; i < Lv.length; i++) {
      const t = Lv[i] * 3;
      const a = tv[t], b = tv[t + 1], c = tv[t + 2];
      if (a !== u && b !== u && c !== u) continue;
      const w = (a !== u && a !== v) ? a : (b !== u && b !== v) ? b : c;
      if (n < 2) opp[n] = w;
      n++;
    }
    if (n !== 2) return false;                      // boundary or non-manifold
    if (opp[0] === opp[1]) return false;            // two faces on one triple
    const g = ++gen;
    const Lu = vtri[u];
    for (let i = 0; i < Lu.length; i++) {
      const t = Lu[i] * 3;
      for (let k = 0; k < 3; k++) { const w = tv[t + k]; if (w !== u) mark[w] = g; }
    }
    for (let i = 0; i < Lv.length; i++) {
      const t = Lv[i] * 3;
      for (let k = 0; k < 3; k++) {
        const w = tv[t + k];
        if (w === u || w === v) continue;
        if (mark[w] === g && w !== opp[0] && w !== opp[1]) return false;
      }
    }
    return true;
  }

  // Every triangle of the one-ring that survives keeps its normal within
  // MAX_TURN of where it is right now AND on the same side as the normal it had
  // in the input. A triangle that is ALREADY zero-area has no current normal to
  // preserve and only has to come out non-degenerate and unreversed; one with no
  // input normal at all has no side to keep and only has to come out
  // non-degenerate. Refusing on a zero input normal (the dot is 0, never
  // positive) is what locked every collapse around a welded point.
  const bx = [0, 0, 0], by = [0, 0, 0], bz = [0, 0, 0];
  const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
  function flipsSomething(u, v, nx, ny, nz) {
    const g = ++gen;
    for (let s = 0; s < 2; s++) {
      const L = s === 0 ? vtri[u] : vtri[v];
      for (let i = 0; i < L.length; i++) {
        const f = L[i];
        if (tmark[f] === g) continue;
        tmark[f] = g;
        const t = f * 3;
        const a = tv[t], b = tv[t + 1], c = tv[t + 2];
        const hasU = a === u || b === u || c === u;
        const hasV = a === v || b === v || c === v;
        if (hasU && hasV) continue;                     // dies in this collapse
        for (let k = 0; k < 3; k++) {
          const w = tv[t + k];
          bx[k] = px[w * 3]; by[k] = px[w * 3 + 1]; bz[k] = px[w * 3 + 2];
          if (w === u || w === v) { ax[k] = nx; ay[k] = ny; az[k] = nz; }
          else { ax[k] = bx[k]; ay[k] = by[k]; az[k] = bz[k]; }
        }
        const anx = (ay[1] - ay[0]) * (az[2] - az[0]) - (az[1] - az[0]) * (ay[2] - ay[0]);
        const any = (az[1] - az[0]) * (ax[2] - ax[0]) - (ax[1] - ax[0]) * (az[2] - az[0]);
        const anz = (ax[1] - ax[0]) * (ay[2] - ay[0]) - (ay[1] - ay[0]) * (ax[2] - ax[0]);
        const al = Math.hypot(anx, any, anz);
        if (al === 0) return true;                        // collapsed to a line
        if (oriented[f] && anx * on[t] + any * on[t + 1] + anz * on[t + 2] <= 0) return true;
        const bnx = (by[1] - by[0]) * (bz[2] - bz[0]) - (bz[1] - bz[0]) * (by[2] - by[0]);
        const bny = (bz[1] - bz[0]) * (bx[2] - bx[0]) - (bx[1] - bx[0]) * (bz[2] - bz[0]);
        const bnz = (bx[1] - bx[0]) * (by[2] - by[0]) - (by[1] - by[0]) * (bx[2] - bx[0]);
        const bl = Math.hypot(bnx, bny, bnz);
        if (bl === 0) continue;                            // no normal to keep
        if ((bnx * anx + bny * any + bnz * anz) / (al * bl) < MAX_TURN) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- seed heap
  for (const key of edgeUse.keys()) {
    const a = Math.floor(key / V0), b = key - a * V0;
    if (locked[a] && locked[b]) continue;
    heapPush(edgeCost(a, b, false), a, b, ver[a] + ver[b]);
  }

  // ----------------------------------------------------------------- the run
  let collapses = 0, flippedRejected = 0, linkRejected = 0, floorRejected = 0, overBudget = 0;
  let worstCost = 0;
  let stoppedOnError = false;
  const ring = [];

  while (liveTris > target && hn > 0) {
    heapPop();
    const u = top.a, v = top.b;
    if (!alive[u] || !alive[v]) continue;
    if (top.stamp !== ver[u] + ver[v]) continue;
    // The heap is min-first and a stale entry never reaches this line, so the
    // first cost over the bound is the cheapest collapse left: nothing after it
    // can be cheaper and the run is finished on maxErrorMM, unless the count is
    // still over the cap, in which case this is the cheapest way down.
    if (top.cost > maxCost) {
      if (liveTris <= capTris) { stoppedOnError = true; break; }
      overBudget++;
    }
    compact(u); compact(v);
    if (vtri[u].length === 0 || vtri[v].length === 0) continue;
    if (locked[u] && locked[v]) continue;

    if (R.nonManifold) {
      if (!linkCondition(u, v)) { linkRejected++; continue; }
    } else {
      // With the link condition off the edge still has to exist, or there is
      // nothing to collapse.
      let shared = 0;
      const L = vtri[v];
      for (let i = 0; i < L.length; i++) {
        const t = L[i] * 3;
        if (tv[t] === u || tv[t + 1] === u || tv[t + 2] === u) shared++;
      }
      if (shared === 0) continue;
    }

    // The placement is recomputed here rather than carried on the heap entry:
    // the stamp guarantees the quadrics have not moved since the push, so this
    // reproduces the pushed cost exactly, and it is where the solve and the
    // fallback are counted.
    const cost = edgeCost(u, v, true);
    const nx = place[0], ny = place[1], nz = place[2];

    let dying = 0;
    const Lv = vtri[v];
    for (let i = 0; i < Lv.length; i++) {
      const t = Lv[i] * 3;
      if (tv[t] === u || tv[t + 1] === u || tv[t + 2] === u) dying++;
    }
    if (liveTris - dying < MIN_TRIANGLES) { floorRejected++; continue; }

    if (R.flips && flipsSomething(u, v, nx, ny, nz)) { flippedRejected++; continue; }

    // The collapse. `kill` merges into `keep`; a locked vertex is always the one
    // that survives, which is what holds the boundary still.
    const keep = locked[u] ? u : v;
    const kill = keep === u ? v : u;
    const Lk = vtri[kill];
    for (let i = 0; i < Lk.length; i++) {
      const f = Lk[i], t = f * 3;
      if (tv[t] === keep || tv[t + 1] === keep || tv[t + 2] === keep) { tlive[f] = 0; liveTris--; }
    }
    for (let i = 0; i < Lk.length; i++) {
      const f = Lk[i], t = f * 3;
      if (!tlive[f]) continue;
      if (tv[t] === kill) tv[t] = keep;
      else if (tv[t + 1] === kill) tv[t + 1] = keep;
      else if (tv[t + 2] === kill) tv[t + 2] = keep;
      vtri[keep].push(f);
    }
    Lk.length = 0;
    alive[kill] = 0;
    px[keep * 3] = nx; px[keep * 3 + 1] = ny; px[keep * 3 + 2] = nz;
    const bk = keep * 11, bd = kill * 11;
    for (let i = 0; i < 11; i++) Q[bk + i] += Q[bd + i];
    ver[keep]++;
    collapses++;
    if (cost > worstCost) worstCost = cost;

    const L = compact(keep);
    ring.length = 0;
    const g = ++gen;
    for (let i = 0; i < L.length; i++) {
      const t = L[i] * 3;
      for (let k = 0; k < 3; k++) {
        const w = tv[t + k];
        if (w === keep || mark[w] === g) continue;
        mark[w] = g;
        ring.push(w);
      }
    }
    for (let i = 0; i < ring.length; i++) {
      const w = ring[i];
      if (locked[keep] && locked[w]) continue;
      heapPush(edgeCost(keep, w, false), keep, w, ver[keep] + ver[w]);
    }
  }

  // ------------------------------------------------------------- compaction
  const remap = new Int32Array(V0).fill(-1);
  let outV = 0;
  for (let f = 0; f < F0; f++) {
    if (!tlive[f]) continue;
    for (let k = 0; k < 3; k++) { const w = tv[f * 3 + k]; if (remap[w] < 0) remap[w] = outV++; }
  }
  const outPos = new Float32Array(outV * 3);
  for (let v = 0; v < V0; v++) {
    const r = remap[v];
    if (r < 0) continue;
    outPos[r * 3] = px[v * 3]; outPos[r * 3 + 1] = px[v * 3 + 1]; outPos[r * 3 + 2] = px[v * 3 + 2];
  }
  const outIdx = new Uint32Array(liveTris * 3);
  const outSrc = new Uint32Array(liveTris);
  const weldSrc = welded.sourceTriangles;
  let w = 0;
  for (let f = 0; f < F0; f++) {
    if (!tlive[f]) continue;
    outSrc[w / 3] = weldSrc === null ? f : weldSrc[f];
    outIdx[w++] = remap[tv[f * 3]];
    outIdx[w++] = remap[tv[f * 3 + 1]];
    outIdx[w++] = remap[tv[f * 3 + 2]];
  }

  const topo = meshTopology(outPos, outIdx);
  return {
    positions: outPos,
    indices: outIdx,
    sourceTriangles: outSrc,
    stats: {
      fromTriangles: Fin,
      toTriangles: liveTris,
      fromVertices: Vin,
      toVertices: outV,
      weldedVertices: welded.welded,
      droppedTriangles: welded.dropped,
      flatTriangles,
      collapses,
      overBudgetCollapses: overBudget,
      // Back across the unit boundary: the largest ACCEPTED cost is a squared
      // meter, so its square root is a meter and this is that in millimeters.
      maxErrorMM: Math.sqrt(worstCost) / MM,
      requestedTargetTriangles: target,
      requestedMaxErrorMM: maxErrorMM === undefined || maxErrorMM === null ? null : maxErrorMM,
      requestedMaxTriangles: capTris,
      stoppedOn: liveTris <= target ? 'target' : stoppedOnError ? (overBudget > 0 ? 'cap' : 'maxError') : 'refusals',
      boundaryEdges: topo.boundary,
      nonManifoldEdges: topo.nonManifold,
      components: topo.components,
      edgeCount: topo.edges,
      euler: topo.euler,
      flippedRejected,
      linkRejected,
      floorRejected,
      lockedVertices,
      solvedPlacements: solved,
      fallbackPlacements: fallbacks,
      peakQueue: peakHeap,
    },
  };
}

function emptyStats(target, maxErrorMM, Fin, Vin, welded) {
  return {
    fromTriangles: Fin,
    toTriangles: 0,
    fromVertices: Vin,
    toVertices: 0,
    weldedVertices: welded.welded,
    droppedTriangles: welded.dropped,
    flatTriangles: 0,
    collapses: 0,
    overBudgetCollapses: 0,
    maxErrorMM: 0,
    requestedTargetTriangles: target,
    requestedMaxErrorMM: maxErrorMM === undefined || maxErrorMM === null ? null : maxErrorMM,
    requestedMaxTriangles: Infinity,
    stoppedOn: 'target',
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    components: 0,
    edgeCount: 0,
    euler: 0,
    flippedRejected: 0,
    linkRejected: 0,
    floorRejected: 0,
    lockedVertices: 0,
    solvedPlacements: 0,
    fallbackPlacements: 0,
    peakQueue: 0,
  };
}
