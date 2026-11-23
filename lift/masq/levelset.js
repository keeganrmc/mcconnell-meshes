// MASQ — the printable solid as a LEVEL SET.
//
// buildShell (src/shell.js) offsets the head's vertices along their normals,
// which folds wherever the surface turns tighter than the offset: on this head
// a painted eye/nose/cheek territory inverts 121 triangles at a 1 mm offset and
// 696 at 3 mm. That fold is shown to the student on purpose and buildShell
// keeps it. This module is the other answer, the one that gets printed.
//
// THE FIELD. The mask solid is defined implicitly against the head surface S.
// For a query point x let p be the closest point on S and s(x) the signed
// distance from S, positive on the outward-normal side. Interpolate the painted
// per-vertex fields barycentrically at p and take
//
//     a = gap(p) - s(x)                      x is nearer the face than the gap
//     b = s(x) - (gap(p) + thickness(p))     x is beyond the outer surface
//     c = threshold - coverage(p)            p is outside the painted territory
//     F(x) = max(a, b, c)
//
// x is inside the solid exactly when F(x) < 0, and the printable mesh is the
// zero set. Outer surface, inner surface and the rim wall are all one level set
// of one continuous function, so nothing can pass through anything.
//
// NO FOLD GUARD, AND THAT IS THE POINT. buildShell thins the wall where the
// surface turns tighter than the offset, because a mesh offset must. A level
// set must not: carrying the FULL requested thickness into a crease without
// folding is the whole reason this module exists. `gap` and `thickness` are
// taken as given and never clamped against curvature.
//
// c IS DIVIDED BY THE COVERAGE GRADIENT, AND WITHOUT THAT THE max IS
// DIMENSIONALLY INCOHERENT. a and b are lengths in meters; coverage is a
// dimensionless 0..1 field, so a raw threshold - coverage is some three orders
// of magnitude steeper than a or b at head scale. Scaling c by any positive
// quantity leaves the SIGN of F unchanged, so the solid and its topology are
// identical either way — what changes is where linear interpolation inside a
// cell puts the crossing. Dividing by |grad coverage| on the triangle that owns
// p turns c into a first-order distance to the rim, in meters, so all three
// constraints meet the interpolation on the same footing. Where the gradient
// vanishes (a saturated plateau) the quotient is bounded by a floor on the
// gradient; that bound is far larger than any offset in play, so a bounded c can
// never be the binding constraint near the surface.
//
// SIGN COMES FROM THE PSEUDO-NORMAL, NOT FROM A WINDING NUMBER OR RAY PARITY.
// The GNM head is not closed: 298 boundary edges at the neck opening and the
// mouth sock, plus five disconnected components (two eyeballs, two sets of teeth
// and gums, a tongue) floating inside it. Parity would count those and invert
// the sign in a shell around each. The angle-weighted pseudo-normal at the
// closest point is correct in the narrow band, which is the only place this
// field is evaluated.
//
// ANGLE WEIGHTING, WHERE shell.js USES AREA WEIGHTING. shell.js accumulates the
// unnormalized cross product, which is area weighting, and for an offset
// DIRECTION that is the right choice. It is the wrong choice here: the inside
// test dot(x - p, n_p) is provably correct at a mesh vertex only for the
// angle-weighted normal, because it is the vertex's solid angle that separates
// the two sides, and p lands on a vertex or an edge often enough at a crease to
// matter. Caller-supplied normals are used as given and only re-normalized.
//
// cellMM IS READ AGAINST THE THINNEST WALL, NOT AGAINST THE MESH. A wall under
// about two cells thick is not resolvable by any level-set mesher, and the way
// it fails is quiet: measured on a 50 mm sphere with a 3 mm wall at 2 mm cells,
// the inner and outer shells fuse through each other, the Euler characteristic
// falls from 4 to -356 and the component count from 2 to 1 — while the boundary
// and non-manifold counts stay at zero. A caller that gates only on holes will
// not see it, which is why stats carries `euler` and `components`.
//
// MARCHING TETRAHEDRA, NOT MARCHING CUBES, AND THE REASON IS THE HOLE. The
// classic 256-entry cube table is not topologically consistent: on an ambiguous
// face two neighboring cubes can choose opposite connections and leave a crack,
// which is exactly what the watertight gate must never let through. A cube split
// into six tetrahedra has a 16-entry table with no ambiguous case at all, and
// the split used here (Kuhn's, the six orderings of x, y, z) is invariant under
// translation by one cell, so two neighboring cubes cut their shared face on the
// same diagonal. The table below is GENERATED from the tetrahedron's geometry
// rather than transcribed, because a hand-typed case table is a field list that
// loses an entry silently.

const MM = 0.001;

// Meters. The field value at a corner with no triangle within the search radius:
// far outside, and far enough that it can never be the smaller side of a sign
// change. stats.clampedCrossings counts it if it ever is.
const FAR = 1e3;

// Edges of a tetrahedron, as pairs of corner ROLES 0..3.
const TET_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/**
 * TET_CASES[m] is a flat list of edge indices, three per triangle, for the
 * tetrahedron whose corner r is INSIDE (field < 0) exactly when bit r of m is
 * set. Triangles wind so that their normal points along +grad F, which is out of
 * the solid.
 *
 * Exported so a gate can corrupt one entry and watch the mesh open. Nothing in
 * the app reads it.
 */
export const TET_CASES = buildTetCases();

function buildTetCases() {
  // A positively oriented reference tetrahedron. Its corners 1, 2, 3 sit on the
  // coordinate axes, so for the linear interpolant grad F is exactly
  // (F1 - F0, F2 - F0, F3 - F0) with no matrix to invert.
  const P = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const table = [];
  for (let m = 0; m < 16; m++) {
    const F = [0, 1, 2, 3].map((r) => (((m >> r) & 1) ? -1 : 1));
    const cut = [];
    for (let e = 0; e < 6; e++) if (F[TET_EDGES[e][0]] * F[TET_EDGES[e][1]] < 0) cut.push(e);
    if (cut.length === 0) { table.push([]); continue; }
    // Two cut edges are neighbors in the section polygon exactly when they lie
    // on a common face of the tetrahedron, i.e. their four endpoints span at
    // most three corners. With three cuts every pair qualifies; with four, each
    // edge has two neighbors and one opposite, so the walk is forced.
    const adjacent = (a, b) => new Set([].concat(TET_EDGES[a], TET_EDGES[b])).size <= 3;
    const ring = [cut[0]];
    const rest = cut.slice(1);
    while (rest.length) {
      const last = ring[ring.length - 1];
      const i = rest.findIndex((e) => adjacent(last, e));
      if (i < 0) throw new Error('levelset: tetrahedron section is not a single ring');
      ring.push(rest[i]);
      rest.splice(i, 1);
    }
    const mid = (e) => [0, 1, 2].map((k) => 0.5 * (P[TET_EDGES[e][0]][k] + P[TET_EDGES[e][1]][k]));
    const pts = ring.map(mid);
    // Newell, so a non-planar quad still gets a meaningful normal.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (nx * (F[1] - F[0]) + ny * (F[2] - F[0]) + nz * (F[3] - F[0]) < 0) ring.reverse();
    const tris = [];
    for (let i = 1; i + 1 < ring.length; i++) tris.push(ring[0], ring[i], ring[i + 1]);
    table.push(tris);
  }
  return table;
}

// The six Kuhn tetrahedra of a cell, as local corner codes bx + 2*by + 4*bz.
// Each is the chain 000 -> e_s0 -> e_s0 + e_s1 -> 111 for one ordering s of the
// three axes. Half of them come out left-handed for a cell with positive
// spacing; those get their last two corners swapped, because TET_CASES assumes a
// positively oriented image of the reference tetrahedron and would otherwise
// emit that tetrahedron's triangles inside out.
const CUBE_TETS = buildCubeTets();

function buildCubeTets() {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const bit = [1, 2, 4];
  const pos = (b) => [b & 1, (b >> 1) & 1, (b >> 2) & 1];
  return orders.map((s) => {
    const t = [0, bit[s[0]], bit[s[0]] | bit[s[1]], 7];
    const p = t.map(pos);
    const u = [0, 1, 2].map((k) => p[1][k] - p[0][k]);
    const v = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
    const w = [0, 1, 2].map((k) => p[3][k] - p[0][k]);
    const det = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
    if (det < 0) { const x = t[2]; t[2] = t[3]; t[3] = x; }
    return t;
  });
}

// A corner count past this is a typo in cellMM, not a request: 40e6 corners is
// already 160 MB of field. The cap is also what keeps the crossing key exact —
// the key is g0 * nCorners + g1, so nCorners^2 must stay under 2^53, and
// 40e6 squared is 1.6e15 against a ceiling of 9.0e15.
const MAX_CORNERS = 40e6;

// A crossing is kept this far off both ends of its grid edge, as a fraction of
// the edge. Two crossings that share a corner would otherwise land on that
// corner and give the mesh two vertices at one point. The margin has to clear
// the resolution of the file the mesh is written to: an STL is float32
// millimeters, 7.6e-6 mm apart at 100 mm, and 1e-6 of a 1 mm cell is under
// that, so two crossings the index array kept apart merged in every reader
// (one zero-length edge with 10-14 zero-area triangles on it, per export).
// 1e-3 of a cell is 1 micron at 1 mm, over a hundred float32 steps.
const T_MARGIN = 1e-3;

// Output vertices closer than this, in meters, are one vertex. Above float32
// millimeter resolution at any mask size and a tenth of the crossing margin at
// the smallest cell in use, so it merges only what the file would have merged.
export const WELD_M = 1e-7;

/**
 * @param {object} args
 * @param {Float32Array} args.positions  3 per vertex, meters
 * @param {Uint32Array|Uint16Array} args.indices  3 per triangle
 * @param {Float32Array} [args.normals]  3 per vertex; computed angle-weighted if absent
 * @param {Float32Array} args.coverage   one 0..1 scalar per vertex
 * @param {Float32Array} args.gap        per-vertex mm from the face to the inner surface
 * @param {Float32Array} args.thickness  per-vertex mm of wall
 * @param {number} args.threshold        0..1, where the painted region ends
 * @param {number} args.cellMM           grid cell size in millimeters
 * @param {number} [args.rimMM]          radius drawn on the rim's two corners
 * @param {'branch'|'field'} [args.crossing]  where a grid edge's crossing is
 *   put: 'branch' (the default) solves it on the constraint whose zero the
 *   surface is; 'field' interpolates F itself, which is wrong by up to a third
 *   of a cell wherever the far corner sits past mid-wall. 'field' exists for
 *   the gate that measures that difference and nothing in the app passes it.
 * @returns {{positions: Float32Array, indices: Uint32Array, stats: object}}
 *   positions are METERS.
 */
/* The printable's result object, built in ONE place.
 *
 * ⚠ THE PIPELINE RUNS TWICE — once in the worker, once inline when a worker
 * cannot be constructed — and each end packed its own result from a
 * hand-written list of the decimator's stats. Both lists were the same eight
 * fields and both had already lost `euler`, which is the only number that
 * witnesses the fusing failure: boundary, non-manifold and component counts
 * are all blind to it by construction. A caller reading `euler` off the
 * printable got `undefined` and no error.
 * `from` and `to` are kept as aliases because that is what the callers say.
 */
export function packPrintable(ls, kept, dec, out, ms) {
  return {
    positions: out.positions, indices: out.indices, stats: ls.stats,
    kept: { components: kept.components, removed: kept.removed, removedFraction: kept.removedFraction },
    decimated: dec ? { ...dec.stats, from: dec.stats.fromTriangles, to: dec.stats.toTriangles } : null,
    ms: ms || null,
  };
}

export function buildLevelSet({ positions, indices, normals, coverage, gap, thickness, threshold, cellMM, rimMM = 0, crossing = 'branch' }) {
  const vCount = positions.length / 3;
  const tCount = indices.length / 3;
  const rimM = rimMM * MM;
  if (!Number.isInteger(vCount)) throw new Error('positions.length must be a multiple of 3');
  if (!Number.isInteger(tCount)) throw new Error('indices.length must be a multiple of 3');
  if (coverage.length !== vCount) throw new Error('coverage must have one entry per vertex');
  if (gap.length !== vCount) throw new Error('gap must have one entry per vertex');
  if (thickness.length !== vCount) throw new Error('thickness must have one entry per vertex');
  if (normals !== undefined && normals !== null && normals.length !== vCount * 3) throw new Error('normals must have three entries per vertex');
  if (!(threshold >= 0) || !(threshold <= 1)) throw new Error('threshold must be within 0..1');
  if (!(cellMM > 0) || !Number.isFinite(cellMM)) throw new Error('cellMM must be a positive number of millimeters');
  if (!(rimMM >= 0) || !Number.isFinite(rimMM)) throw new Error('rimMM must be a non-negative number of millimeters');
  if (crossing !== 'branch' && crossing !== 'field') throw new Error("crossing must be 'branch' or 'field'");

  // ---------------------------------------------------------- UNIT BOUNDARY
  // THE ONLY PLACE THE TWO SYSTEMS MEET. `positions` are meters; `gap`,
  // `thickness` and `cellMM` are millimeters. They are converted here, once,
  // and every value below this block is meters. Mixing the two inside one
  // expression is a defect class this project has already paid for.
  const cellM = cellMM * MM;
  const gapM = new Float64Array(vCount);
  const thickM = new Float64Array(vCount);
  for (let v = 0; v < vCount; v++) { gapM[v] = gap[v] * MM; thickM[v] = thickness[v] * MM; }
  // ------------------------------------------------------ end unit boundary

  const nrm = vertexPseudoNormals(positions, indices, normals, vCount, tCount);

  // THE GRID IS THE COVERED REGION'S BOX, and the covered region is every
  // triangle with at least one vertex past the threshold — not every vertex past
  // it. The isoline runs through the straddling triangles, so their outside
  // vertices bound it and must be in the box.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let maxOffsetM = 0, coveredTriangles = 0;
  for (let t = 0; t < tCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    if (coverage[a] < threshold && coverage[b] < threshold && coverage[c] < threshold) continue;
    coveredTriangles++;
    for (let i = 0; i < 3; i++) {
      const v = indices[t * 3 + i];
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      const o = gapM[v] + thickM[v];
      if (o > maxOffsetM) maxOffsetM = o;
    }
  }
  if (coveredTriangles === 0) return emptyResult(cellMM, coveredTriangles);

  const padM = maxOffsetM + 3 * cellM;
  const ox = minX - padM, oy = minY - padM, oz = minZ - padM;
  const nx = Math.floor((maxX + padM - ox) / cellM) + 2;
  const ny = Math.floor((maxY + padM - oy) / cellM) + 2;
  const nz = Math.floor((maxZ + padM - oz) / cellM) + 2;
  const nCorners = nx * ny * nz;
  if (nCorners > MAX_CORNERS) {
    throw new Error('levelset: ' + nCorners + ' grid corners exceeds the ' + MAX_CORNERS + ' cap; raise cellMM');
  }

  // THE BAND, AND WHY IT IS EXACTLY THIS WIDE. F < 0 requires
  // gap <= s <= gap + thickness, so every point of the solid is within
  // maxOffsetM of S. A crossing needs BOTH ends of its grid edge evaluated
  // truthfully, and the far end of an edge from an inside corner is at most one
  // cell diagonal further out, so the band has to reach maxOffsetM + sqrt(3)
  // cells and there is nothing to gain by reaching further: a pair of corners
  // both outside the band are both positive and cannot bracket a crossing.
  // stats.clampedCrossings is the standing check on that argument.
  const bandM = (maxOffsetM + Math.sqrt(3) * cellM) * 1.01;
  const searchR = bandM;
  const searchR2 = searchR * searchR;

  // The floor on |grad coverage|, in reciprocal meters: it bounds |c| by
  // covReachM, which is many times any offset in play, so a saturated plateau
  // reads as "the rim is nowhere near" rather than as a constraint.
  const covReachM = 8 * (maxOffsetM + 4 * cellM);
  const gradFloor = 1 / covReachM;

  const grid = { ox, oy, oz, nx, ny, nz, nCorners, cellM };
  const hash = buildTriangleHash(positions, indices, tCount, grid, searchR, cellM, bandM);
  const gradC = coverageGradients(positions, indices, coverage, tCount);
  const active = activeCorners(positions, indices, tCount, grid, bandM);

  const field = new Float32Array(nCorners);
  field.fill(FAR);
  // THE THREE CONSTRAINTS ARE KEPT PER CORNER, NOT JUST THEIR MAX. F = max(a,
  // b, c) has a kink at mid-wall where a and b cross, and a grid edge that
  // reaches from outside one sheet to past that kink is not linear in F: a
  // crossing interpolated on F alone lands up to a third of a cell inside the
  // wall. Measured at 1.0 mm cells on a 2 mm wall, 1.7% of the raw vertices
  // were 0.31 mm into the wall, every one on a face or body diagonal. The
  // crossing is solved on the branches instead; see marchTetrahedra.
  const branches = new Float32Array(nCorners * 3);
  // r per corner is only needed where the rim is drawn, since r is the one
  // input to the rounded cross-section the branches do not carry.
  const rimR = rimM > 0 ? new Float32Array(nCorners) : null;
  let evaluated = 0, hit = 0, insideCorners = 0, nudged = 0;
  const q = { tri: -1, u: 0, v: 0, w: 0, d2: 0, px: 0, py: 0, pz: 0 };
  for (let k = 0, g = 0; k < nz; k++) {
    const z = oz + k * cellM;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * cellM;
      for (let i = 0; i < nx; i++, g++) {
        if (!active[g]) continue;
        evaluated++;
        const x = ox + i * cellM;
        if (!hash.closest(x, y, z, searchR2, q)) continue;
        hit++;
        const t3 = q.tri * 3;
        const va = indices[t3], vb = indices[t3 + 1], vc = indices[t3 + 2];
        const dx = x - q.px, dy = y - q.py, dz = z - q.pz;
        const nX = q.u * nrm[va * 3] + q.v * nrm[vb * 3] + q.w * nrm[vc * 3];
        const nY = q.u * nrm[va * 3 + 1] + q.v * nrm[vb * 3 + 1] + q.w * nrm[vc * 3 + 1];
        const nZ = q.u * nrm[va * 3 + 2] + q.v * nrm[vb * 3 + 2] + q.w * nrm[vc * 3 + 2];
        const d = Math.sqrt(q.d2);
        const s = (dx * nX + dy * nY + dz * nZ) < 0 ? -d : d;
        const gp = q.u * gapM[va] + q.v * gapM[vb] + q.w * gapM[vc];
        const tp = q.u * thickM[va] + q.v * thickM[vb] + q.w * thickM[vc];
        const cp = q.u * coverage[va] + q.v * coverage[vb] + q.w * coverage[vc];
        const a = gp - s;
        const b = s - (gp + tp);
        const c = (threshold - cp) / Math.max(gradC[q.tri], gradFloor);
        let f = a > b ? a : b;
        if (c > f) f = c;
        /* THE RIM'S DRAW RADIUS. Two triangles per boundary edge give a
         * square cut or a skive and nothing between; a rim that was actually
         * drawn has a radius on it.
         *
         * ⚠ IT IS THE CROSS-SECTION THAT IS ROUNDED, NOT A BEAD ADDED. A tube
         * unioned onto the rim's centerline — the obvious reading of "roll the
         * rim" — is INERT below half the wall, because the tube lies entirely
         * inside the slab it is meant to soften: measured, 52,574 mm3 against
         * 52,650 at 0.4 mm on a 3 mm wall, which is grid noise. Half a control's
         * range doing nothing is the same defect as a control that does nothing.
         *
         * The rim's cross-section is a 2D region: |dm| <= tp/2 across the wall,
         * and c <= 0 past the boundary. Its two convex corners are rounded by
         * the standard shrink-and-dilate — pull both constraints in by r, take
         * the intersection's exterior distance, and give r back:
         *
         *     u = |dm| - (tp/2 - r),  v = c + r
         *     f_rim = hypot(max(u,0), max(v,0)) + min(max(u,v), 0) - r
         *
         * ⚠ NO CROSS PRODUCT ANYWHERE IN IT, which is why it is here and not in
         * the mesh: a swept profile built from t x n cuts a GROOVE when the
         * order is wrong, and a groove closes perfectly, stays watertight,
         * keeps its Euler characteristic and reads only as less material.
         * ⚠ AND ROUNDING ONLY REMOVES, so it cannot reach back through the gap.
         * The clamp below is what keeps that true: r is held to half the LOCAL
         * wall, which the fold guard thins independently of this slider. */
        if (rimM > 0) {
          const r = Math.min(rimM, tp / 2);
          if (r > 0) {
            const dm = Math.abs(s - (gp + tp / 2));
            const u = dm - (tp / 2 - r);
            const v = c + r;
            const ex = Math.hypot(u > 0 ? u : 0, v > 0 ? v : 0);
            const inn = Math.min(u > v ? u : v, 0);
            const rim = ex + inn - r;
            if (rim > f) f = rim;
            rimR[g] = r;
          }
        }
        // An exact zero has no side. Pushing it out by a millionth of a cell
        // costs nothing geometric and keeps "inside is f < 0" total.
        if (f === 0) { f = cellM * 1e-6; nudged++; }
        field[g] = f;
        branches[g * 3] = a; branches[g * 3 + 1] = b; branches[g * 3 + 2] = c;
        if (f < 0) insideCorners++;
      }
    }
  }

  const mesh = marchTetrahedra(field, grid, crossing === 'branch' ? branches : null, rimR);

  const topo = surfaceTopology(mesh.positions, mesh.indices);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    stats: {
      cellMM,
      dims: [nx, ny, nz],
      cells: [nx - 1, ny - 1, nz - 1],
      bounds: { min: [ox, oy, oz], max: [ox + (nx - 1) * cellM, oy + (ny - 1) * cellM, oz + (nz - 1) * cellM] },
      vertexCount: mesh.positions.length / 3,
      triangleCount: mesh.indices.length / 3,
      edgeCount: topo.edges,
      boundaryEdges: topo.boundary,
      nonManifoldEdges: topo.nonManifold,
      components: topo.components,
      euler: topo.euler,
      coveredTriangles,
      maxOffsetMM: maxOffsetM / MM,
      bandMM: bandM / MM,
      hashCellMM: hash.cellM / MM,
      activeCorners: evaluated,
      surfaceCorners: hit,
      insideCorners,
      nudgedCorners: nudged,
      clampedCrossings: mesh.clampedCrossings,
      cellsVisited: mesh.cellsVisited,
      weldedVertices: mesh.weldedVertices,
      droppedTriangles: mesh.droppedTriangles,
    },
  };
}

function emptyResult(cellMM, coveredTriangles) {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    stats: {
      cellMM,
      dims: [0, 0, 0],
      cells: [0, 0, 0],
      bounds: null,
      vertexCount: 0,
      triangleCount: 0,
      edgeCount: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      components: 0,
      euler: 0,
      coveredTriangles,
      maxOffsetMM: 0,
      bandMM: 0,
      hashCellMM: 0,
      activeCorners: 0,
      surfaceCorners: 0,
      insideCorners: 0,
      nudgedCorners: 0,
      clampedCrossings: 0,
      weldedVertices: 0,
      droppedTriangles: 0,
      cellsVisited: 0,
    },
  };
}

/* Angle-weighted vertex normals — see the header for why they are not the
 * area-weighted ones shell.js builds. A supplied field is re-normalized and
 * otherwise trusted. */
function vertexPseudoNormals(positions, indices, supplied, vCount, tCount) {
  const n = new Float64Array(vCount * 3);
  if (supplied) {
    for (let i = 0; i < vCount * 3; i++) n[i] = supplied[i];
  } else {
    const e = new Float64Array(9);
    for (let t = 0; t < tCount; t++) {
      const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      const p = v.map((k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
      const wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1], wz = p[2][2] - p[0][2];
      let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (!(fl > 0)) continue;
      fx /= fl; fy /= fl; fz /= fl;
      for (let i = 0; i < 3; i++) {
        const a = p[i], b = p[(i + 1) % 3], c = p[(i + 2) % 3];
        for (let k = 0; k < 3; k++) { e[k] = b[k] - a[k]; e[3 + k] = c[k] - a[k]; }
        const l1 = Math.hypot(e[0], e[1], e[2]), l2 = Math.hypot(e[3], e[4], e[5]);
        if (!(l1 > 0) || !(l2 > 0)) continue;
        let cs = (e[0] * e[3] + e[1] * e[4] + e[2] * e[5]) / (l1 * l2);
        cs = cs < -1 ? -1 : (cs > 1 ? 1 : cs);
        const ang = Math.acos(cs);
        const o = v[i] * 3;
        n[o] += fx * ang; n[o + 1] += fy * ang; n[o + 2] += fz * ang;
      }
    }
  }
  for (let v = 0; v < vCount; v++) {
    const x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-20) { n[v * 3] = x / l; n[v * 3 + 1] = y / l; n[v * 3 + 2] = z / l; }
    else { n[v * 3] = 0; n[v * 3 + 1] = 0; n[v * 3 + 2] = 0; }
  }
  return n;
}

/* |grad coverage| per triangle, in reciprocal meters. Coverage is linear on a
 * triangle, so the gradient in the triangle's plane is exact:
 *   g = [(cb - ca) * (e2 x n) + (cc - ca) * (n x e1)] / |n|^2
 * which is the unique vector with g.e1 = cb - ca, g.e2 = cc - ca and g.n = 0.
 * Only the magnitude is kept, because the only use is turning a coverage
 * difference into a first-order distance to the isoline. */
function coverageGradients(positions, indices, coverage, tCount) {
  const out = new Float64Array(tCount);
  for (let t = 0; t < tCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const n2 = nx * nx + ny * ny + nz * nz;
    if (!(n2 > 0)) { out[t] = 0; continue; }
    const d1 = coverage[b] - coverage[a], d2 = coverage[c] - coverage[a];
    const p1x = e2y * nz - e2z * ny, p1y = e2z * nx - e2x * nz, p1z = e2x * ny - e2y * nx;
    const p2x = ny * e1z - nz * e1y, p2y = nz * e1x - nx * e1z, p2z = nx * e1y - ny * e1x;
    const gx = (d1 * p1x + d2 * p2x) / n2;
    const gy = (d1 * p1y + d2 * p2y) / n2;
    const gz = (d1 * p1z + d2 * p2z) / n2;
    out[t] = Math.sqrt(gx * gx + gy * gy + gz * gz);
  }
  return out;
}

/* A uniform hash of triangle bounding boxes, in CSR form, plus the closest-point
 * query over it.
 *
 * THE QUERY IS A RING SEARCH AND IT TERMINATES ON A BOUND, NOT ON A GUESS. Every
 * cell outside Chebyshev ring r is at least r hash cells from the query point,
 * so once the best distance found is under r * h the rest cannot beat it. A
 * triangle spanning several cells is tested once, marked by a stamp.
 *
 * Triangles beyond the padded grid box are dropped; the rest have their cell
 * range CLAMPED into the hash. Clamping can only move a triangle toward the
 * query point, so a clamped triangle is found earlier than it should be, never
 * missed — the search stays conservative. */
function buildTriangleHash(positions, indices, tCount, grid, searchR, cellM, bandM) {
  // Sized against the triangles, not the grid: a cell holding a handful of
  // triangles is what keeps the ring search short on both a 1.7 mm subdivided
  // head and a coarse fixture.
  let extentSum = 0, counted = 0;
  const step = Math.max(1, Math.floor(tCount / 4096));
  for (let t = 0; t < tCount; t += step) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    let e = 0;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(positions[a + k], positions[b + k], positions[c + k]);
      const hi = Math.max(positions[a + k], positions[b + k], positions[c + k]);
      if (hi - lo > e) e = hi - lo;
    }
    extentSum += e; counted++;
  }
  const mean = counted ? extentSum / counted : cellM;
  let h = 1.5 * mean;
  if (!(h > 0)) h = cellM;
  if (h < cellM) h = cellM;
  if (h > bandM) h = bandM;

  const lox = grid.ox - searchR, loy = grid.oy - searchR, loz = grid.oz - searchR;
  const hix = grid.ox + (grid.nx - 1) * cellM + searchR;
  const hiy = grid.oy + (grid.ny - 1) * cellM + searchR;
  const hiz = grid.oz + (grid.nz - 1) * cellM + searchR;
  const hnx = Math.max(1, Math.floor((hix - lox) / h) + 1);
  const hny = Math.max(1, Math.floor((hiy - loy) / h) + 1);
  const hnz = Math.max(1, Math.floor((hiz - loz) / h) + 1);
  const nCells = hnx * hny * hnz;

  const box = new Int32Array(6);
  const dim = [hnx, hny, hnz], lo0 = [lox, loy, loz], hi0 = [hix, hiy, hiz];
  const spanOf = (t) => {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(positions[a + k], positions[b + k], positions[c + k]);
      const hi = Math.max(positions[a + k], positions[b + k], positions[c + k]);
      if (hi < lo0[k] || lo > hi0[k]) return false;
      let i0 = Math.floor((lo - lo0[k]) / h), i1 = Math.floor((hi - lo0[k]) / h);
      if (i0 < 0) i0 = 0; if (i1 > dim[k] - 1) i1 = dim[k] - 1;
      if (i1 < 0 || i0 > dim[k] - 1) return false;
      box[k] = i0; box[3 + k] = i1;
    }
    return true;
  };

  const counts = new Int32Array(nCells + 1);
  for (let t = 0; t < tCount; t++) {
    if (!spanOf(t)) continue;
    for (let k = box[2]; k <= box[5]; k++) {
      for (let j = box[1]; j <= box[4]; j++) {
        const base = j * hnx + k * hnx * hny;
        for (let i = box[0]; i <= box[3]; i++) counts[base + i + 1]++;
      }
    }
  }
  for (let i = 0; i < nCells; i++) counts[i + 1] += counts[i];
  const start = counts;
  const items = new Int32Array(start[nCells]);
  const cursor = Int32Array.from(start.subarray(0, nCells));
  for (let t = 0; t < tCount; t++) {
    if (!spanOf(t)) continue;
    for (let k = box[2]; k <= box[5]; k++) {
      for (let j = box[1]; j <= box[4]; j++) {
        const base = j * hnx + k * hnx * hny;
        for (let i = box[0]; i <= box[3]; i++) items[cursor[base + i]++] = t;
      }
    }
  }

  const stampOf = new Int32Array(tCount).fill(-1);
  let stamp = 0;
  // Ring rMax + 1 and beyond sit at least rMax * h from the query point, which
  // is already searchR: there is nothing out there to find.
  const rMax = Math.ceil(searchR / h);

  function closest(x, y, z, r2, out) {
    const ci = clampIndex(Math.floor((x - lox) / h), hnx);
    const cj = clampIndex(Math.floor((y - loy) / h), hny);
    const ck = clampIndex(Math.floor((z - loz) / h), hnz);
    const mark = stamp++;
    let best = r2;
    out.tri = -1;
    for (let r = 0; r <= rMax; r++) {
      const i0 = ci - r, i1 = ci + r, j0 = cj - r, j1 = cj + r, k0 = ck - r, k1 = ck + r;
      for (let k = Math.max(0, k0); k <= Math.min(hnz - 1, k1); k++) {
        const onK = (k === k0 || k === k1);
        for (let j = Math.max(0, j0); j <= Math.min(hny - 1, j1); j++) {
          const onJ = (j === j0 || j === j1);
          const base = j * hnx + k * hnx * hny;
          if (onK || onJ) {
            for (let i = Math.max(0, i0); i <= Math.min(hnx - 1, i1); i++) best = sweepCell(base + i, mark, best);
          } else {
            if (i0 >= 0) best = sweepCell(base + i0, mark, best);
            if (i1 !== i0 && i1 <= hnx - 1) best = sweepCell(base + i1, mark, best);
          }
        }
      }
      const bound = r * h;
      if (out.tri >= 0 && best <= bound * bound) break;
    }
    if (out.tri < 0) return false;
    out.d2 = best;
    return true;

    function sweepCell(cell, mk, bestIn) {
      let b = bestIn;
      for (let n = start[cell]; n < start[cell + 1]; n++) {
        const t = items[n];
        if (stampOf[t] === mk) continue;
        stampOf[t] = mk;
        b = testTriangle(t, x, y, z, b, out);
      }
      return b;
    }
  }

  function testTriangle(t, x, y, z, best, out) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const abx = positions[ib] - ax, aby = positions[ib + 1] - ay, abz = positions[ib + 2] - az;
    const acx = positions[ic] - ax, acy = positions[ic + 1] - ay, acz = positions[ic + 2] - az;
    const apx = x - ax, apy = y - ay, apz = z - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let u, v, w;
    if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
    else {
      const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const s = d1 / (d1 - d3); u = 1 - s; v = s; w = 0; }
        else {
          const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const s = d2 / (d2 - d6); u = 1 - s; v = 0; w = s; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                const s = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                u = 0; v = 1 - s; w = s;
              } else {
                const den = 1 / (va + vb + vc);
                v = vb * den; w = vc * den; u = 1 - v - w;
              }
            }
          }
        }
      }
    }
    const px = ax + abx * v + acx * w, py = ay + aby * v + acy * w, pz = az + abz * v + acz * w;
    const ex = x - px, ey = y - py, ez = z - pz;
    const dd = ex * ex + ey * ey + ez * ez;
    if (dd < best) {
      out.tri = t; out.u = u; out.v = v; out.w = w;
      out.px = px; out.py = py; out.pz = pz;
      return dd;
    }
    return best;
  }

  return { closest, cellM: h, cells: nCells };
}

function clampIndex(i, n) { return i < 0 ? 0 : (i > n - 1 ? n - 1 : i); }

/* Which grid corners are worth a closest-point query. Everything the zero set
 * can reach lies within bandM of the surface; the rest is far outside and costs
 * nothing but the byte that says so.
 *
 * Stamping every corner within bandM of every triangle directly is quadratic in
 * the band: at 0.75 mm cells that is ~22k corners per triangle. Instead the
 * triangles are rasterized onto a COARSE occupancy grid and the occupancy is
 * dilated by a precomputed offset list.
 *
 * THE OFFSET LIST IS A EUCLIDEAN BALL, NOT A CUBE. A separable Chebyshev
 * dilation is three linear passes and is tempting, but its ball is a cube:
 * measured on the 50 mm test sphere at 1 mm cells it made 965k corners active
 * where 536k of them had a triangle in reach, and the 429k that did not each
 * paid a full ring search to discover it. The list below keeps a cell only when
 * the closest points of the two coarse boxes are within bandM, which is exact
 * given occupancy alone. Over-inclusion costs queries, under-inclusion would
 * cost correctness, and only one of those is acceptable. */
function activeCorners(positions, indices, tCount, grid, bandM) {
  const { ox, oy, oz, nx, ny, nz, cellM, nCorners } = grid;
  const coarse = Math.max(cellM, bandM / 5);
  const cx = Math.floor((nx - 1) * cellM / coarse) + 1;
  const cy = Math.floor((ny - 1) * cellM / coarse) + 1;
  const cz = Math.floor((nz - 1) * cellM / coarse) + 1;
  const occ = new Uint8Array(cx * cy * cz);
  const lo = [ox, oy, oz], dim = [cx, cy, cz];
  const b0 = [0, 0, 0], b1 = [0, 0, 0];
  for (let t = 0; t < tCount; t++) {
    let skip = false;
    for (let k = 0; k < 3 && !skip; k++) {
      const a = indices[t * 3] * 3 + k, b = indices[t * 3 + 1] * 3 + k, c = indices[t * 3 + 2] * 3 + k;
      const mn = Math.min(positions[a], positions[b], positions[c]);
      const mx = Math.max(positions[a], positions[b], positions[c]);
      let i0 = Math.floor((mn - lo[k]) / coarse), i1 = Math.floor((mx - lo[k]) / coarse);
      if (i1 < 0 || i0 > dim[k] - 1) { skip = true; break; }
      if (i0 < 0) i0 = 0; if (i1 > dim[k] - 1) i1 = dim[k] - 1;
      b0[k] = i0; b1[k] = i1;
    }
    if (skip) continue;
    for (let k = b0[2]; k <= b1[2]; k++) {
      for (let j = b0[1]; j <= b1[1]; j++) {
        const base = j * cx + k * cx * cy;
        for (let i = b0[0]; i <= b1[0]; i++) occ[base + i] = 1;
      }
    }
  }
  const r = Math.floor(bandM / coarse) + 1;
  const offs = [];
  const reach2 = (bandM / coarse) * (bandM / coarse);
  for (let dk = -r; dk <= r; dk++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const a = Math.max(0, Math.abs(di) - 1), b = Math.max(0, Math.abs(dj) - 1), c = Math.max(0, Math.abs(dk) - 1);
        if (a * a + b * b + c * c <= reach2) offs.push(di + dj * cx + dk * cx * cy, di, dj, dk);
      }
    }
  }
  const dil = new Uint8Array(occ.length);
  for (let k = 0, g = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++, g++) {
        if (!occ[g]) continue;
        for (let o = 0; o < offs.length; o += 4) {
          const ii = i + offs[o + 1], jj = j + offs[o + 2], kk = k + offs[o + 3];
          if (ii < 0 || ii >= cx || jj < 0 || jj >= cy || kk < 0 || kk >= cz) continue;
          dil[g + offs[o]] = 1;
        }
      }
    }
  }
  occ.set(dil);

  const active = new Uint8Array(nCorners);
  const scale = cellM / coarse;
  for (let k = 0, g = 0; k < nz; k++) {
    const kk = clampIndex(Math.floor(k * scale), cz) * cx * cy;
    for (let j = 0; j < ny; j++) {
      const jj = clampIndex(Math.floor(j * scale), cy) * cx + kk;
      for (let i = 0; i < nx; i++, g++) active[g] = occ[clampIndex(Math.floor(i * scale), cx) + jj];
    }
  }
  return active;
}


/* The rounded rim cross-section of buildLevelSet, as a function of the three
 * branch values and the radius, so a crossing can evaluate the field between
 * two corners. Identical to the corner evaluation, including the r <= 0 case
 * where it is plain max(a, b, c). */
function fieldOf(a, b, c, r) {
  let f = a > b ? a : b;
  if (c > f) f = c;
  if (r > 0) {
    const u = (a > b ? a : b) + r;
    const v = c + r;
    const ex = Math.hypot(u > 0 ? u : 0, v > 0 ? v : 0);
    const inn = Math.min(u > v ? u : v, 0);
    const rim = ex + inn - r;
    if (rim > f) f = rim;
  }
  return f;
}

/* Marching tetrahedra over the whole grid.
 *
 * A CROSSING IS OWNED BY ITS GRID EDGE, NOT BY THE CELL THAT FOUND IT. The key
 * is the pair of global corner indices, low first, so the four to six
 * tetrahedra that share an edge — inside one cell, and across a cell face for
 * the face diagonals — all get the same output vertex rather than copies that
 * differ by an ulp. That, and Kuhn's split cutting a shared face on the same
 * diagonal from both sides, is what closes the mesh.
 *
 * THE CROSSING IS SOLVED ON THE BRANCH, NOT ON F. Walking a grid edge from its
 * positive corner P to its negative corner N, every branch is negative at N
 * and F turns negative where the LAST positive branch does, so with the
 * branches linear along the edge the crossing is the largest k(P) / (k(P) -
 * k(N)) over the branches positive at P. Interpolating F itself is right only
 * while the same branch is the max at both ends; a body diagonal from just
 * outside the inner sheet to past mid-wall has a at P and b at N, and puts the
 * crossing at s = 0.32 mm instead of 0. Measured on a 40 mm sphere with a 2 mm
 * wall at 1.0 mm cells: max sheet error 0.327 mm on F, 0.010 mm on the
 * branches; after decimation 23% of edges turned over 30 degrees on F and
 * none on the branches, because the decimator locks the spiked slivers and
 * collapses the good vertices around them.
 *
 * Where the rim is drawn the field is not a max of linear branches: the
 * rounded corner is a hypot of two of them. It is still convex along the
 * edge, and the branch crossing bounds it from below (rounding only removes
 * material), so the crossing is found by bisection on the composite between
 * the branch crossing and N.
 *
 * THE OUTPUT IS WELDED. Two crossings that round to the same float32 point are
 * one vertex, and a triangle left with a repeated corner is dropped, so the
 * mesh the decimator sees is the mesh a reader of the file sees. With the
 * crossing margin at 1e-3 of a cell this merges nothing on any fixture
 * measured; it is the guard on that margin. */
function marchTetrahedra(field, grid, branches, rimR) {
  const { ox, oy, oz, nx, ny, nz, cellM, nCorners } = grid;
  const cOff = new Int32Array(8);
  for (let b = 0; b < 8; b++) cOff[b] = (b & 1) + ((b >> 1) & 1) * nx + ((b >> 2) & 1) * nx * ny;
  const cf = new Float64Array(8);
  const cg = new Int32Array(8);
  const cp = new Float64Array(24);
  const vmap = new Map();
  const outPos = [];
  const outIdx = [];
  let clampedCrossings = 0, cellsVisited = 0;

  // The crossing as a fraction of the way from corner P (F > 0) to corner N
  // (F < 0), solved on the branches; -1 when either corner has no branches.
  const branchCrossing = (gP, gN) => {
    let tb = 0;
    for (let k = 0; k < 3; k++) {
      const k0 = branches[gP * 3 + k], k1 = branches[gN * 3 + k];
      if (k0 > 0 && k1 < 0) { const tk = k0 / (k0 - k1); if (tk > tb) tb = tk; }
    }
    if (rimR === null) return tb;
    const r0 = rimR[gP], r1 = rimR[gN];
    if (!(r0 > 0) && !(r1 > 0)) return tb;
    const a0 = branches[gP * 3], b0 = branches[gP * 3 + 1], c0 = branches[gP * 3 + 2];
    const a1 = branches[gN * 3], b1 = branches[gN * 3 + 1], c1 = branches[gN * 3 + 2];
    let lo = tb, hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = 0.5 * (lo + hi);
      const f = fieldOf(a0 + m * (a1 - a0), b0 + m * (b1 - b0), c0 + m * (c1 - c0), r0 + m * (r1 - r0));
      if (f > 0) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
  };

  const crossing = (b0, b1) => {
    const g0 = cg[b0], g1 = cg[b1];
    const key = g0 < g1 ? g0 * nCorners + g1 : g1 * nCorners + g0;
    const hit = vmap.get(key);
    if (hit !== undefined) return hit;
    const f0 = cf[b0], f1 = cf[b1];
    if (f0 >= FAR || f1 >= FAR) clampedCrossings++;
    let t;
    if (branches !== null && f0 < FAR && f1 < FAR) {
      t = f0 > 0 ? branchCrossing(g0, g1) : 1 - branchCrossing(g1, g0);
    } else {
      t = f0 / (f0 - f1);
    }
    if (!(t > T_MARGIN)) t = T_MARGIN;
    else if (t > 1 - T_MARGIN) t = 1 - T_MARGIN;
    const i = outPos.length / 3;
    outPos.push(
      cp[b0 * 3] + t * (cp[b1 * 3] - cp[b0 * 3]),
      cp[b0 * 3 + 1] + t * (cp[b1 * 3 + 1] - cp[b0 * 3 + 1]),
      cp[b0 * 3 + 2] + t * (cp[b1 * 3 + 2] - cp[b0 * 3 + 2]));
    vmap.set(key, i);
    return i;
  };

  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      let base = j * nx + k * nx * ny;
      for (let i = 0; i + 1 < nx; i++, base++) {
        let neg = 0;
        for (let b = 0; b < 8; b++) {
          const g = base + cOff[b];
          cg[b] = g;
          const f = field[g];
          cf[b] = f;
          if (f < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        cellsVisited++;
        for (let b = 0; b < 8; b++) {
          cp[b * 3] = ox + (i + (b & 1)) * cellM;
          cp[b * 3 + 1] = oy + (j + ((b >> 1) & 1)) * cellM;
          cp[b * 3 + 2] = oz + (k + ((b >> 2) & 1)) * cellM;
        }
        for (let t = 0; t < 6; t++) {
          const tet = CUBE_TETS[t];
          let m = 0;
          for (let r = 0; r < 4; r++) if (cf[tet[r]] < 0) m |= 1 << r;
          const tris = TET_CASES[m];
          for (let n = 0; n < tris.length; n++) {
            const e = TET_EDGES[tris[n]];
            outIdx.push(crossing(tet[e[0]], tet[e[1]]));
          }
        }
      }
    }
  }
  const welded = weldVertices(Float32Array.from(outPos), Uint32Array.from(outIdx), WELD_M);
  return {
    positions: welded.positions,
    indices: welded.indices,
    clampedCrossings,
    cellsVisited,
    weldedVertices: welded.welded,
    droppedTriangles: welded.dropped,
  };
}

/* Merge vertices closer than `tol` on every axis and drop the triangles that
 * lose a corner to the merge. Vertices are binned on a grid eight times the
 * tolerance; a neighboring bin is searched only when the point is within the
 * tolerance of that bin's face, so a pair that straddles a face is found and
 * most points cost one lookup (1.3 per vertex measured on a level set, against
 * 27 with bins the size of the tolerance). The survivor keeps the first
 * vertex's position and index order, so on a mesh with nothing to weld the
 * arrays come back unchanged.
 *
 * sourceTriangles maps each kept triangle to its index in the input, null when
 * nothing was welded. Exported for the decimator, whose topology is read from
 * indices alone. */
export function weldVertices(positions, indices, tol) {
  const V = positions.length / 3;
  const bin = 8 * tol, inv = 1 / bin;
  const bins = new Map();
  const remap = new Int32Array(V);
  let welded = 0;
  const binKey = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  const lo = new Int32Array(3), hi = new Int32Array(3);
  for (let v = 0; v < V; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const c = positions[v * 3 + k];
      const b = Math.floor(c * inv), frac = c * inv - b;
      lo[k] = frac * bin < tol ? b - 1 : b;
      hi[k] = (1 - frac) * bin < tol ? b + 1 : b;
    }
    let found = -1;
    for (let i = lo[0]; i <= hi[0] && found < 0; i++) {
      for (let j = lo[1]; j <= hi[1] && found < 0; j++) {
        for (let k = lo[2]; k <= hi[2] && found < 0; k++) {
          const list = bins.get(binKey(i, j, k));
          if (list === undefined) continue;
          for (let n = 0; n < list.length; n++) {
            const u = list[n];
            if (Math.abs(positions[u * 3] - x) < tol && Math.abs(positions[u * 3 + 1] - y) < tol
              && Math.abs(positions[u * 3 + 2] - z) < tol) { found = u; break; }
          }
        }
      }
    }
    if (found >= 0) { remap[v] = found; welded++; continue; }
    remap[v] = v;
    const key = binKey(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv));
    const list = bins.get(key);
    if (list === undefined) bins.set(key, [v]); else list.push(v);
  }
  if (welded === 0) return { positions, indices, welded: 0, dropped: 0, sourceTriangles: null };
  const dense = new Int32Array(V).fill(-1);
  let outV = 0;
  for (let v = 0; v < V; v++) if (remap[v] === v) dense[v] = outV++;
  const outPos = new Float32Array(outV * 3);
  for (let v = 0; v < V; v++) {
    if (remap[v] !== v) continue;
    const d = dense[v] * 3;
    outPos[d] = positions[v * 3]; outPos[d + 1] = positions[v * 3 + 1]; outPos[d + 2] = positions[v * 3 + 2];
  }
  const F = indices.length / 3;
  const outIdx = new Uint32Array(F * 3);
  const source = new Uint32Array(F);
  let w = 0, dropped = 0;
  for (let f = 0; f < F; f++) {
    const a = dense[remap[indices[f * 3]]], b = dense[remap[indices[f * 3 + 1]]], c = dense[remap[indices[f * 3 + 2]]];
    if (a === b || b === c || c === a) { dropped++; continue; }
    source[w / 3] = f;
    outIdx[w++] = a; outIdx[w++] = b; outIdx[w++] = c;
  }
  return { positions: outPos, indices: outIdx.slice(0, w), welded, dropped, sourceTriangles: source.slice(0, w / 3) };
}

/* Edge census of the output. Undirected edges, counted by use:
 *   used once   -> the mesh has a hole there
 *   used twice  -> manifold
 *   used more   -> non-manifold
 * Components are grouped through the manifold edges, so a shell pair reads as
 * two and a rimmed mask as one, and the Euler characteristic follows from the
 * three counts. */
function surfaceTopology(positions, indices) {
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
