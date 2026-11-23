/* MASQ — ToSuperB.
 *
 * The mask's patch — the shell's outer sheet on the skin, clipped along the
 * fitted outline — as a low-count all-quad SubD cage: QuadriFlow at a count
 * derived from the paint, every opening the paint has cut out of the cage,
 * one mirrored half under Sym, a refit so the limit surface interpolates,
 * and the same cage lifted to the shell's inner sheet as the clearance cage.
 * Written out as an Unreason3D document (its own SuperB leaf, stood up in
 * that app's Z-up frame) and as a quad OBJ in millimetres. Everything here
 * is in the patch's own units unless a function says otherwise.
 */

import {
  referenceMeshToSuperBCage,
} from './centina/subdconvert.mjs';

import {
  subdivideCatmullClark,
  superbDisplayMesh,
  triangulateFace,
  buildTopology,
  edgeKey as subdEdgeKey,
} from './centina/subd.mjs';

import {
  vertexLimitPosition,
  subdToPatches,
} from './centina/subdlimit.mjs';

import {
  simplifySubD,
  polychordsOf,
  refitCageToLimitTargets,
} from './centina/subdsimplify.mjs';

export const MM = 1000; // Meters to millimeters

/* --------------------------------------------------------------------------
 * 1. EXTRACT MASK QUAD PATCH
 * --------------------------------------------------------------------------
 * Extracts the quad patch corresponding to the mask territory on the face.
 *
 * Base positions: Float32Array or array of 3D coordinates [x0, y0, z0, ...]
 * Quads: Uint16Array, Uint32Array, or array of quad indices [v0, v1, v2, v3, ...]
 * Coverage: Float32Array of per-vertex scalar coverage [0..1]
 */
export function extractMaskQuads(basePositions, quads, coverage, opts = {}) {
  const threshold = opts.threshold !== undefined ? opts.threshold : 0.5;
  const minCovered = opts.minCovered !== undefined ? opts.minCovered : 3; // 1 to 4
  const scale = opts.scale !== undefined ? opts.scale : MM;

  const nQuads = (quads.length / 4) | 0;
  const selectedQuadIndices = [];

  for (let q = 0; q < nQuads; q++) {
    const i0 = quads[q * 4];
    const i1 = quads[q * 4 + 1];
    const i2 = quads[q * 4 + 2];
    const i3 = quads[q * 4 + 3];

    let coveredCount = 0;
    if (coverage[i0] >= threshold) coveredCount++;
    if (coverage[i1] >= threshold) coveredCount++;
    if (coverage[i2] >= threshold) coveredCount++;
    if (coverage[i3] >= threshold) coveredCount++;

    if (coveredCount >= minCovered) {
      selectedQuadIndices.push(q);
    }
  }

  if (selectedQuadIndices.length === 0) {
    return {
      vertices: [],
      faces: [],
      boundaryLoops: [],
      stats: { originalQuads: 0, keptQuads: 0, vertices: 0 }
    };
  }

  // Find connected components across quads via shared edges to drop disconnected specks
  const keptQuads = filterLargestComponent(quads, selectedQuadIndices);

  // Remap vertices to compact 0..V-1 indexing
  const remap = new Map();
  const vertices = []; // Array of [x, y, z] in target units
  const faces = [];    // Array of [v0, v1, v2, v3]

  const putVertex = (origIdx) => {
    let newIdx = remap.get(origIdx);
    if (newIdx === undefined) {
      newIdx = vertices.length;
      remap.set(origIdx, newIdx);
      const x = basePositions[origIdx * 3] * scale;
      const y = basePositions[origIdx * 3 + 1] * scale;
      const z = basePositions[origIdx * 3 + 2] * scale;
      vertices.push([x, y, z]);
    }
    return newIdx;
  };

  for (const q of keptQuads) {
    const a = putVertex(quads[q * 4]);
    const b = putVertex(quads[q * 4 + 1]);
    const c = putVertex(quads[q * 4 + 2]);
    const d = putVertex(quads[q * 4 + 3]);
    faces.push([a, b, c, d]);
  }

  // Extract boundary loops
  const boundaryLoops = findQuadBoundaryLoops(faces, vertices.length);

  // Optional tangential boundary relaxation to eliminate staircasing
  if (opts.smoothBoundary !== false && boundaryLoops.length > 0) {
    smoothBoundaryVertices(vertices, boundaryLoops, opts.smoothIterations || 3, opts.smoothStrength || 0.35);
  }

  return {
    vertices,
    faces,
    boundaryLoops,
    stats: {
      originalQuads: nQuads,
      selectedQuads: selectedQuadIndices.length,
      keptQuads: faces.length,
      vertices: vertices.length
    }
  };
}

/* --------------------------------------------------------------------------
 * CONNECTED COMPONENT FILTERING
 * Keeps the largest connected component of quads sharing at least one edge.
 * -------------------------------------------------------------------------- */
function filterLargestComponent(quads, quadIndices) {
  if (quadIndices.length <= 1) return quadIndices;

  // Build edge -> quads map
  const edgeToQuads = new Map();
  const edgeKey = (u, v) => (u < v ? `${u}_${v}` : `${v}_${u}`);

  for (let i = 0; i < quadIndices.length; i++) {
    const q = quadIndices[i];
    const v0 = quads[q * 4];
    const v1 = quads[q * 4 + 1];
    const v2 = quads[q * 4 + 2];
    const v3 = quads[q * 4 + 3];

    const edges = [
      edgeKey(v0, v1),
      edgeKey(v1, v2),
      edgeKey(v2, v3),
      edgeKey(v3, v0)
    ];

    for (const ek of edges) {
      let list = edgeToQuads.get(ek);
      if (!list) {
        list = [];
        edgeToQuads.set(ek, list);
      }
      list.push(i);
    }
  }

  // Disjoint set union
  const parent = new Int32Array(quadIndices.length);
  for (let i = 0; i < quadIndices.length; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i, j) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  };

  for (const qList of edgeToQuads.values()) {
    for (let k = 1; k < qList.length; k++) {
      union(qList[0], qList[k]);
    }
  }

  // Count component sizes
  const compSizes = new Map();
  for (let i = 0; i < quadIndices.length; i++) {
    const root = find(i);
    compSizes.set(root, (compSizes.get(root) || 0) + 1);
  }

  let largestRoot = -1;
  let maxSize = -1;
  for (const [root, sz] of compSizes.entries()) {
    if (sz > maxSize) {
      maxSize = sz;
      largestRoot = root;
    }
  }

  const result = [];
  for (let i = 0; i < quadIndices.length; i++) {
    if (find(i) === largestRoot) {
      result.push(quadIndices[i]);
    }
  }
  return result;
}

/* --------------------------------------------------------------------------
 * BOUNDARY LOOP EXTRACTION
 * -------------------------------------------------------------------------- */
export function findQuadBoundaryLoops(faces, vertexCount) {
  // Directed half-edge map: u -> v  (any face size — the patch is triangles)
  const halfEdges = new Map(); // "u_v" -> count
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const u = f[i];
      const v = f[(i + 1) % f.length];
      const key = `${u}_${v}`;
      halfEdges.set(key, (halfEdges.get(key) || 0) + 1);
    }
  }

  // Boundary directed edges: half-edge exists but reverse does not
  const nextEdge = new Map(); // u -> v
  for (const [key, count] of halfEdges.entries()) {
    const [uStr, vStr] = key.split('_');
    const u = parseInt(uStr, 10);
    const v = parseInt(vStr, 10);
    const revKey = `${v}_${u}`;
    /* a boundary half-edge has no reverse AND appears once: a half-edge seen
     * twice in the same direction is a winding fault between two faces, not
     * a rim, and capping such a "loop" hands the remesher a non-manifold */
    if (!halfEdges.has(revKey) && count === 1) {
      nextEdge.set(u, v);
    }
  }

  const visited = new Set();
  const loops = [];

  for (const start of nextEdge.keys()) {
    if (visited.has(start)) continue;

    const loop = [start];
    visited.add(start);
    let curr = nextEdge.get(start);

    while (curr !== undefined && curr !== start && !visited.has(curr)) {
      visited.add(curr);
      loop.push(curr);
      curr = nextEdge.get(curr);
    }

    if (curr === start && loop.length >= 3) {
      loops.push(loop);
    }
  }

  return loops;
}

/* --------------------------------------------------------------------------
 * A SYMMETRIC CAGE IS BUILT FROM ONE HALF
 * --------------------------------------------------------------------------
 * QuadriFlow's flow is not mirror-symmetric, so under Sym the patch is
 * clipped to x >= 0, the half is remeshed with the cut as a preserved
 * boundary, and the result is mirrored and welded along x = 0. Every vertex
 * then has a partner by INDEX — a seam vertex is its own — and the midline
 * column of quads is what a SubD modeller wants.
 */
export function clipPatchHalf(patch, axis = 0) {
  const P = patch.vertices, out = [], faces = [];
  const idx = new Map();                        // original vertex -> new index
  const cut = new Map();                        // "a_b" -> index of the point on the plane
  const put = (v) => { let j = idx.get(v); if (j === undefined) { j = out.length; idx.set(v, j); out.push(P[v].slice()); } return j; };
  const onPlane = (a, b) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    let j = cut.get(k); if (j !== undefined) return j;
    const pa = P[a], pb = P[b], t = pa[axis] / (pa[axis] - pb[axis]);
    const q = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
    q[axis] = 0;
    j = out.length; out.push(q); cut.set(k, j); return j;
  };
  for (const f of patch.faces) {
    const tris = f.length === 3 ? [f] : [[f[0], f[1], f[2]], [f[0], f[2], f[3]]];
    for (const t of tris) {
      const inside = t.map((v) => P[v][axis] >= 0);
      const n = inside.filter(Boolean).length;
      if (n === 3) { faces.push(t.map(put)); continue; }
      if (n === 0) continue;
      /* rotate so the odd vertex is first */
      let r = t.slice(), ri = inside.slice();
      while (!(n === 1 ? ri[0] : !ri[0])) { r = [r[1], r[2], r[0]]; ri = [ri[1], ri[2], ri[0]]; }
      const [a, b, c] = r;
      if (n === 1) faces.push([put(a), onPlane(a, b), onPlane(a, c)]);
      else { const ab = onPlane(a, b), ac = onPlane(a, c); faces.push([ab, put(b), put(c)]); faces.push([ab, put(c), ac]); }
    }
  }
  return { vertices: out, faces, isTriangles: true };
}
/* --------------------------------------------------------------------------
 * THE CLEARANCE CAGE: THE SAME CAGE, LIFTED TO THE MASK'S INNER FACE
 * --------------------------------------------------------------------------
 * The shell already carries the gap with its seat, hollow tightening and
 * fold guard, as its INNER sheet — one point per skin point of the patch.
 * So the clearance cage is the skin cage with every vertex moved to the
 * inner point of the nearest patch vertex (plus its own small offset from
 * that vertex), refit once. Then the limit surface is checked against the
 * skin — signed distance along the skin's normal — and any cage vertex
 * whose surface dips inside is pushed out along that normal, a few passes;
 * the worst intrusion before and after is reported.
 * `skin` and `inner` are flat arrays over the same patch vertices.
 */
export function clearanceCage(cage, skin, inner, faces, opts = {}) {
  const n = skin.length / 3;
  const V = [];
  for (let i = 0; i < n; i++) V.push([skin[i * 3], skin[i * 3 + 1], skin[i * 3 + 2]]);
  /* the skin's normals at the patch vertices */
  const N = new Float64Array(n * 3);
  for (const f of faces) {
    const a = V[f[0]], b = V[f[1]], c = V[f[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of f) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
  }
  for (let i = 0; i < n; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
  /* grid over the skin points */
  let edge = 0, ne = 0;
  for (const f of faces) for (let k = 0; k < f.length; k++) { const a = V[f[k]], b = V[f[(k + 1) % f.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
  edge /= Math.max(1, ne);
  const makeGrid = (pts) => {
    const cell = edge * 3, g = new Map();
    const key = (x, y, z) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
    for (let i = 0; i < pts.length; i++) { const k = key(pts[i][0], pts[i][1], pts[i][2]); let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(i); }
    return (p, r) => {
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell), m = Math.ceil(r / cell);
      let best = -1, bd = r * r;
      for (let dx = -m; dx <= m; dx++) for (let dy = -m; dy <= m; dy++) for (let dz = -m; dz <= m; dz++) {
        const l = g.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
        for (const i of l) { const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2 + (pts[i][2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
      }
      return best;
    };
  };
  const nearest = makeGrid(V);
  /* "Inside" is measured against the whole head, opts.head = { positions,
   * normals }: under an eye hole the patch has no skin, and the nearest
   * patch point is a lid edge whose normal calls the surface over the
   * socket inside. Without it the patch stands in. */
  let HV = V, HN = N, nearestHead = nearest;
  if (opts.head && opts.head.positions) {
    const hp = opts.head.positions, hn = opts.head.normals, m = hp.length / 3;
    HV = []; HN = hn;
    for (let i = 0; i < m; i++) HV.push([hp[i * 3], hp[i * 3 + 1], hp[i * 3 + 2]]);
    nearestHead = makeGrid(HV);
  }
  /* 1. lift every cage vertex by the inner sheet's offset from the skin,
   * AVERAGED OVER THE VERTEX'S FOOTPRINT and then over its ring.
   * ⚠ NOT THE NEAREST SKIN POINT'S. The gap is a field with a seat in it —
   * zero where the mask sits on the brow and cheekbones, the dial elsewhere
   * — and its edge is a 1 mm step over one skin edge (1.7 mm). Read at the
   * nearest point onto a 5 mm cage that step lands between two cage
   * vertices and the limit surface draws it as a ridge across the brow;
   * the dense shell shows nothing because it carries the step at its own
   * spacing. Measured on a brow-and-cheekbone cage: lift lumps against the
   * ring p99 0.47 mm nearest, 0.12 mm footprint-averaged. */
  const withinR = (() => {
    const cell = edge * 3, g = new Map();
    const key = (x, y, z) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
    for (let i = 0; i < V.length; i++) { const k = key(V[i][0], V[i][1], V[i][2]); let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(i); }
    return (p, r) => {
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell), m = Math.ceil(r / cell), out = [], rr = r * r;
      for (let dx = -m; dx <= m; dx++) for (let dy = -m; dy <= m; dy++) for (let dz = -m; dz <= m; dz++) {
        const l = g.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
        for (const i of l) if ((V[i][0] - p[0]) ** 2 + (V[i][1] - p[1]) ** 2 + (V[i][2] - p[2]) ** 2 <= rr) out.push(i);
      }
      return out;
    };
  })();
  let cageEdge = 0, nce = 0;
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = cage.vertices[q[k]], b = cage.vertices[q[(k + 1) % q.length]]; cageEdge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); nce++; }
  cageEdge = nce ? cageEdge / nce : edge * 3;
  const liftVec = cage.vertices.map((v) => {
    const near = withinR(v, 0.6 * cageEdge);
    const use = near.length ? near : (() => { const i = nearest(v, edge * 8); return i < 0 ? [] : [i]; })();
    if (!use.length) return [0, 0, 0];
    let x = 0, y = 0, z = 0;
    for (const i of use) { x += inner[i * 3] - V[i][0]; y += inner[i * 3 + 1] - V[i][1]; z += inner[i * 3 + 2] - V[i][2]; }
    return [x / use.length, y / use.length, z / use.length];
  });
  {
    const rings = cage.vertices.map(() => new Set());
    for (const q of cage.faces) for (let k = 0; k < q.length; k++) { rings[q[k]].add(q[(k + 1) % q.length]); rings[q[(k + 1) % q.length]].add(q[k]); }
    const sm = liftVec.map((L, i) => {
      let x = L[0], y = L[1], z = L[2], c = 1;
      for (const j of rings[i]) { x += liftVec[j][0]; y += liftVec[j][1]; z += liftVec[j][2]; c++; }
      return [x / c, y / c, z / c];
    });
    for (let i = 0; i < liftVec.length; i++) liftVec[i] = sm[i];
  }
  const lifted = cage.vertices.map((v, i) => [v[0] + liftVec[i][0], v[1] + liftVec[i][1], v[2] + liftVec[i][2]]);
  let out = { vertices: lifted, faces: cage.faces, creases: cage.creases || {} };
  /* a mirrored cage is made exact BEFORE it is measured: the lift reads an
   * asymmetric patch, and an average taken after the check moved vertices
   * the check had passed */
  /* a self-partner is a seam vertex when it is within a quarter edge of the
   * plane; one whose twin is gone keeps its place */
  if (opts.partner) {
    const V = out.vertices, partner = opts.partner;
    let edge = 0, ne = 0;
    for (const q of out.faces) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
    const seamTol = 0.25 * edge / Math.max(1, ne);
    for (let i = 0; i < V.length; i++) {
      const j = partner[i];
      if (j === i) { if (Math.abs(V[i][0]) < seamTol) V[i][0] = 0; continue; }
      if (j < i) continue;
      const ax = (V[i][0] - V[j][0]) / 2, ay = (V[i][1] + V[j][1]) / 2, az = (V[i][2] + V[j][2]) / 2;
      V[i] = [ax, ay, az]; V[j] = [-ax, ay, az];
    }
  }
  if (opts.refit === true) {
    const r = refitCageToLimitTargets(out, lifted.map((v) => v.slice()), { passes: opts.refitPasses ?? 1 });
    out = { vertices: r.vertices, faces: cage.faces, creases: cage.creases || {} };
  }
  /* 2. never inside the head: the limit surface against the skin */
  /* ⚠ MEASURED AT THE LEVEL THAT IS DRAWN. At level 1 the samples sit four
   * to a quad and a dip between them goes unseen: a cage that passed at
   * level 1 with nothing inside drew, at level 2, 0.8 mm into the cheek at
   * 300 quads and 1.3 mm at 800. */
  const intrusion = () => {
    const lm = evaluateSubDLimitMesh(out, 2);
    let worst = 0, worstAt = -1;
    const per = new Float64Array(out.vertices.length);   // deepest intrusion charged to each cage vertex
    const dir = new Float64Array(out.vertices.length * 3); // the skin's normal where that intrusion is
    /* an intruding sample charges the four corners of the face it lies
     * under; charged to one vertex, the worst point moves rather than lifts */
    const fc = out.faces.map((q) => { let x = 0, y = 0, z = 0; for (const v of q) { x += out.vertices[v][0]; y += out.vertices[v][1]; z += out.vertices[v][2]; } return [x / 4, y / 4, z / 4]; });
    for (let i = 0; i < lm.positions.length / 3; i++) {
      const p = [lm.positions[i * 3], lm.positions[i * 3 + 1], lm.positions[i * 3 + 2]];
      /* ⚠ AND ONLY SKIN THAT IS NEAR. The reference leaves out the band
       * round the openings and the nostrils, so under the nose a cap's
       * nearest skin was the nose's wing 8 mm away, and the wing's tangent
       * plane put the cap "4.6 mm inside" — a 2 mm mound under the nose. A
       * surface that has gone in has skin within a few edges of it. */
      const j = nearestHead(p, edge * 3); if (j < 0) continue;
      /* ⚠ ONLY SKIN THAT FACES THE WAY THE MASK DOES. A cap over a nostril
       * too small to cut lies across the cavity, and the nearest skin to a
       * point on it is a nostril's inner wall, whose normal points across
       * the cavity: measured against that wall the cap was "4.6 mm inside"
       * and the push raised a 2 mm mound under the nose. The mouth's inner
       * lips do the same. Skin whose normal is more than ~70° off the
       * surface's own is a cavity wall, not the face, and is not measured. */
      const dot = Math.abs(lm.normals[i * 3] * HN[j * 3] + lm.normals[i * 3 + 1] * HN[j * 3 + 1] + lm.normals[i * 3 + 2] * HN[j * 3 + 2]);
      if (dot < 0.3) continue;
      const d = (p[0] - HV[j][0]) * HN[j * 3] + (p[1] - HV[j][1]) * HN[j * 3 + 1] + (p[2] - HV[j][2]) * HN[j * 3 + 2];
      if (d < -1e-9) {
        const depth = -d;
        if (depth > worst) { worst = depth; worstAt = j; }
        let bf = -1, bd = Infinity;
        for (let f = 0; f < fc.length; f++) { const q = fc[f]; const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; if (dd < bd) { bd = dd; bf = f; } }
        if (bf >= 0) for (const c of out.faces[bf]) if (depth > per[c]) { per[c] = depth; dir[c * 3] = HN[j * 3]; dir[c * 3 + 1] = HN[j * 3 + 1]; dir[c * 3 + 2] = HN[j * 3 + 2]; }
      }
    }
    return { worst, per, dir, worstAt };
  };
  const before = intrusion();
  let after = before;
  const passes = opts.passes ?? 12;
  /* the push reaches the ring around a charged vertex at half strength and
   * the ring beyond at a quarter, so a lift is a mound and not a spike —
   * one ring alone left 0.5 mm bumps against the neighbours on a 5 mm cage */
  const ring = out.vertices.map(() => new Set());
  for (const q of out.faces) for (let k = 0; k < 4; k++) { ring[q[k]].add(q[(k + 1) % 4]); ring[q[(k + 1) % 4]].add(q[k]); }
  const ring2 = ring.map((r, i) => { const s2 = new Set(); for (const j of r) for (const k of ring[j]) if (k !== i && !r.has(k)) s2.add(k); return s2; });
  for (let pass = 0; pass < passes && after.worst > (opts.tolerance ?? 0); pass++) {
    const push = new Float64Array(out.vertices.length), along = new Float64Array(out.vertices.length * 3);
    for (let c = 0; c < out.vertices.length; c++) {
      if (!after.per[c]) continue;
      if (after.per[c] + edge * 0.05 > push[c]) { push[c] = after.per[c] + edge * 0.05; along[c * 3] = after.dir[c * 3]; along[c * 3 + 1] = after.dir[c * 3 + 1]; along[c * 3 + 2] = after.dir[c * 3 + 2]; }
      for (const r of ring[c]) if (0.5 * after.per[c] > push[r]) { push[r] = 0.5 * after.per[c]; along[r * 3] = after.dir[c * 3]; along[r * 3 + 1] = after.dir[c * 3 + 1]; along[r * 3 + 2] = after.dir[c * 3 + 2]; }
      for (const r of ring2[c]) if (0.25 * after.per[c] > push[r]) { push[r] = 0.25 * after.per[c]; along[r * 3] = after.dir[c * 3]; along[r * 3 + 1] = after.dir[c * 3 + 1]; along[r * 3 + 2] = after.dir[c * 3 + 2]; }
    }
    /* pushed along the mean of the cage's own normal (turned to agree with
     * the head's) and the head's: at an inside corner — the eye's inner
     * canthus — the nearest skin vertex can sit on the nose's side wall,
     * whose normal points across the dip rather than out of it */
    const CN = new Float64Array(out.vertices.length * 3);
    for (const q of out.faces) {
      const a = out.vertices[q[0]], b = out.vertices[q[1]], c = out.vertices[q[2]], d = out.vertices[q[3]];
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of q) { CN[i * 3] += nx; CN[i * 3 + 1] += ny; CN[i * 3 + 2] += nz; }
    }
    /* a mirrored cage is pushed as one: partners take the larger push (and
     * its mirrored direction), a seam vertex's push has no x — pushed on its
     * own along the nose's normal, a seam vertex went 15 mm off the plane */
    const partner = opts.partner;
    if (partner) for (let c = 0; c < out.vertices.length; c++) { const j = partner[c]; if (j > c) {
      if (push[c] >= push[j]) { push[j] = push[c]; along[j * 3] = -along[c * 3]; along[j * 3 + 1] = along[c * 3 + 1]; along[j * 3 + 2] = along[c * 3 + 2]; }
      else { push[c] = push[j]; along[c * 3] = -along[j * 3]; along[c * 3 + 1] = along[j * 3 + 1]; along[c * 3 + 2] = along[j * 3 + 2]; }
    } }
    for (let c = 0; c < out.vertices.length; c++) {
      if (!push[c]) continue;
      const v = out.vertices[c], j = nearestHead(v, edge * 8); if (j < 0) continue;
      /* out along the skin's normal WHERE THE SURFACE WENT IN, mixed with
       * the cage's own; the normal under the cage vertex alone pointed
       * across a nostril and never out of it */
      let nx = CN[c * 3], ny = CN[c * 3 + 1], nz = CN[c * 3 + 2];
      const l = Math.hypot(nx, ny, nz);
      const hx = along[c * 3] || HN[j * 3], hy = along[c * 3 + 1] || HN[j * 3 + 1], hz = along[c * 3 + 2] || HN[j * 3 + 2];
      if (l < 1e-12) { nx = hx; ny = hy; nz = hz; }
      else {
        nx /= l; ny /= l; nz /= l;
        if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        nx += hx; ny += hy; nz += hz;
      }
      if (partner && partner[c] === c) nx = 0;
      const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
      v[0] += nx * push[c]; v[1] += ny * push[c]; v[2] += nz * push[c];
    }
    after = intrusion();
  }
  return { cage: out, intrusionBefore: before.worst, intrusionAfter: after.worst, worstAt: after.worstAt >= 0 ? HV[after.worstAt] : null };
}

/* The count, derived from the paint: the area at 6 mm quads, plus a ring
 * of twelve for every opening big enough to carry one (60 mm² and up — a
 * nostril's 40 does not; an eye slit's 125 does). A domino with its eyes
 * lands near 800, the cap; a full face at the cap is ~7 mm quads. 6 mm is
 * a hand-built reference SubD's edge (758 faces, median edge 5.0 mm); at
 * 12 mm the nose was faceted and an eye hole a lumpy hexagon. The cap is
 * the measured knee: on a 30,000 mm² domino the limit surface's median
 * distance to the patch is 1.12 mm at 150 quads, 0.94 at 300, 0.78 at 800
 * and 0.75 at 1,500 (p90 1.98 / 1.50 / 1.33 / 1.30) — flat past 800,
 * where a build is ~1 s in node and ~4 s in the app. Units: whatever the
 * patch is in; `mmPer` says how many make a millimetre. */
export function deriveQuadCount(patch, mmPer = 1) {
  const P = patch.vertices;
  let area = 0;
  for (const f of patch.faces) for (let k = 1; k + 1 < f.length; k++) {
    const a = P[f[0]], b = P[f[k]], c = P[f[k + 1]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  const loops = findQuadBoundaryLoops(patch.faces, P.length);
  const loopArea = (loop) => {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = P[loop[i]], b = P[loop[(i + 1) % loop.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return 0.5 * Math.hypot(nx, ny, nz) / (mmPer * mmPer);
  };
  const areas = loops.map(loopArea).sort((a, b) => b - a);
  const pieces = splitPieces(patch).length;
  const openings = areas.slice(pieces).filter((a) => a >= 60).length;
  const edgeMM = 6;
  const areaMM2 = area / (mmPer * mmPer);
  const count = Math.max(30, Math.min(800, Math.round((areaMM2 / (edgeMM * edgeMM) + 12 * openings) / 10) * 10));
  return { count, edgeMM, areaMM2, openings };
}

/* The patch's connected pieces (faces sharing a vertex), each with its own
 * compact vertex list and its area. */
export function splitPieces(patch) {
  const P = patch.vertices, F = patch.faces;
  const parent = new Int32Array(P.length); for (let i = 0; i < P.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const f of F) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) parent[a] = b; }
  const byRoot = new Map();
  F.forEach((f) => { const r = find(f[0]); let l = byRoot.get(r); if (!l) { l = []; byRoot.set(r, l); } l.push(f); });
  const out = [];
  for (const faces of byRoot.values()) {
    const idx = new Map(), vertices = [];
    const put = (v) => { let j = idx.get(v); if (j === undefined) { j = vertices.length; idx.set(v, j); vertices.push(P[v].slice()); } return j; };
    const nf = faces.map((f) => f.map(put));
    let area = 0;
    for (const f of nf) {
      for (let k = 1; k + 1 < f.length; k++) {
        const a = vertices[f[0]], b = vertices[f[k]], c = vertices[f[k + 1]];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      }
    }
    out.push({ vertices, faces: nf, area, isTriangles: patch.isTriangles });
  }
  return out.sort((a, b) => b.area - a.area);
}
/* The partner map after a cut renumbered the vertices. A vertex whose
 * partner was cut away keeps no partner (its own index). */
function repairPartner(cage, partner, kept) {
  const out = new Int32Array(cage.vertices.length);
  for (let i = 0; i < out.length; i++) out[i] = i;
  for (let old = 0; old < partner.length; old++) {
    const a = kept[old], b = kept[partner[old]];
    if (a >= 0 && b >= 0) out[a] = b;
  }
  return out;
}
/* the partner map read off a near-symmetric cage: each vertex's nearest
 * mirror across x = 0 within a quarter of an edge, itself on the seam or
 * when it has none. The fairing seats both halves on the whole patch,
 * which is symmetric to well under a millimetre and not exactly, so a
 * match by exact position paired nothing and every vertex became its own
 * partner — and the symmetrize then put each on x = 0, 12 mm away. */
export function partnerByMirror(cage, axis = 0) {
  const V = cage.vertices, n = V.length;
  let edge = 0, ne = 0;
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
  edge /= Math.max(1, ne);
  const tol = Math.max(1e-9, edge * 0.25), cell = Math.max(1e-9, edge);
  const key = (v) => `${Math.floor(v[0] / cell)}_${Math.floor(v[1] / cell)}_${Math.floor(v[2] / cell)}`;
  const grid = new Map(); V.forEach((v, i) => { const k = key(v); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); });
  const partner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(V[i][axis]) <= tol * 0.2) { partner[i] = i; continue; }
    const m = V[i].slice(); m[axis] = -m[axis];
    const cx = Math.floor(m[0] / cell), cy = Math.floor(m[1] / cell), cz = Math.floor(m[2] / cell);
    let best = i, bd = tol * tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = grid.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
      for (const j of l) { if (j === i) continue; const w = V[j]; const d = (w[0] - m[0]) ** 2 + (w[1] - m[1]) ** 2 + (w[2] - m[2]) ** 2; if (d < bd) { bd = d; best = j; } }
    }
    partner[i] = best;
  }
  return partner;
}
export function mirrorCage(cage, axis = 0, tol) {
  const V = cage.vertices, n = V.length;
  let edge = 0, ne = 0;
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
  const eps = tol ?? (edge / Math.max(1, ne)) * 0.05;
  const vertices = V.map((v) => v.slice());
  const partner = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(V[i][axis]) <= eps) { vertices[i][axis] = 0; partner[i] = i; continue; }
    const m = V[i].slice(); m[axis] = -m[axis];
    partner[i] = vertices.length; vertices.push(m);
  }
  const faces = cage.faces.map((q) => q.slice());
  for (const q of cage.faces) faces.push(q.map((v) => partner[v]).reverse());
  const full = new Int32Array(vertices.length);
  for (let i = 0; i < n; i++) { full[i] = partner[i]; full[partner[i]] = i; }
  return { cage: { vertices, faces, creases: cage.creases || {} }, partner: full, seam: eps };
}

/* --------------------------------------------------------------------------
 * A HOLE THAT MEETS THE SEAM: THE WHOLE IS REMESHED AND FOLDED
 * --------------------------------------------------------------------------
 * Remeshed as a half, a ring mask whose face hole crosses the seam loses
 * the band between the hole and the rim at the seam: the half's boundary
 * runs down the seam, and where the seam turns the corner onto the rim
 * QuadriFlow's boundary leaves the seam and shortcuts across the band to
 * the rim — 23, 27 and 29 mm above the rim corner at 480, 800 and 1,600
 * quads on a 19 mm band (sharp on or off; the corner alone, with no cap,
 * is chorded by 8 mm at 480). No count closes it. Remeshed whole, the band
 * carries 12–15 quads at the seam. So when a hole that will be cut at the
 * asked count crosses the seam, the band along the seam from its crossing
 * to the next loop's is under SEAM_BAND_MM, and the half's cage leaves
 * that band's half-way point uncovered, the whole patch is remeshed with
 * that hole open and the cage is folded at the plane (foldCageAtPlane)
 * and mirrored, which keeps every vertex paired by index. Pairing a whole
 * remesh's two sides by nearest mirror instead does not work: QuadriFlow's
 * flow is not mirror-symmetric even on an exactly mirrored input — the
 * nearest mirrored vertex is 3.4 mm away at the median on a 5.4 mm edge,
 * and 584 of 678 vertices had none within a quarter edge.
 */
export const SEAM_BAND_MM = 30;

/* The seam's bands: the section of the SKIN patch by the plane, chained
 * into polylines. Each runs from one boundary crossing to another, so its
 * length is the width of skin along the seam between two loops (a rim and
 * a hole, or two holes), `mid` is its half-way point, and `loops` names
 * the loop at each end (an index into `loops`, −1 when the crossing edge
 * is on none). Units are the patch's. */
export function seamBands(patch, loops, axis = 0) {
  const P = patch.vertices, F = patch.faces;
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const loopOf = new Map();
  loops.forEach((l, li) => { for (let i = 0; i < l.length; i++) loopOf.set(ek(l[i], l[(i + 1) % l.length]), li); });
  /* a vertex on the plane counts as the + side, so an edge crosses when
   * exactly one end is strictly negative */
  const side = (v) => P[v][axis] < 0;
  const cross = (a, b) => { const pa = P[a], pb = P[b], t = pa[axis] / (pa[axis] - pb[axis]); return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]; };
  /* one segment per crossed triangle, keyed by the two crossed edges */
  const segs = [], atEdge = new Map();
  for (const f of F) {
    const tris = f.length === 3 ? [f] : [[f[0], f[1], f[2]], [f[0], f[2], f[3]]];
    for (const t of tris) {
      const ends = [];
      for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; if (side(a) !== side(b)) ends.push({ key: ek(a, b), p: cross(a, b) }); }
      if (ends.length !== 2) continue;
      const i = segs.length; segs.push(ends);
      for (const e of ends) { let l = atEdge.get(e.key); if (!l) atEdge.set(e.key, l = []); l.push(i); }
    }
  }
  /* walk each chain from an edge the section reaches once: a boundary edge */
  const seen = new Uint8Array(segs.length), bands = [];
  for (const [key0, l0] of atEdge) {
    if (l0.length !== 1 || seen[l0[0]]) continue;
    let key = key0, si = l0[0], length = 0;
    const startLoop = loopOf.has(key0) ? loopOf.get(key0) : -1, pts = [];
    for (;;) {
      seen[si] = 1;
      const [a, b] = segs[si];
      const from = a.key === key ? a : b, to = a.key === key ? b : a;
      if (!pts.length) pts.push(from.p);
      pts.push(to.p);
      length += Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
      key = to.key;
      const next = (atEdge.get(key) || []).filter((j) => j !== si && !seen[j]);
      if (!next.length) break;
      si = next[0];
    }
    /* the point half way along */
    let mid = pts[0], run = 0;
    for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (run + d >= length / 2) { const t = d > 0 ? (length / 2 - run) / d : 0; mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; break; } run += d; }
    bands.push({ length, mid, loops: [startLoop, loopOf.has(key) ? loopOf.get(key) : -1] });
  }
  return bands;
}

/* whether some quad of the cage passes within a quarter of the mean cage
 * edge of the point (the quad as two triangles) */
export function cageCovers(cage, p) {
  const V = cage.vertices, F = cage.faces;
  let edge = 0, ne = 0;
  for (const q of F) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
  edge /= Math.max(1, ne);
  const tol = 0.25 * edge, tol2 = tol * tol;
  for (const q of F) {
    const a = V[q[0]], b = V[q[1]], c = V[q[2]], d = V[q[3]];
    if (Math.min(Math.abs(a[0] - p[0]), Math.abs(b[0] - p[0]), Math.abs(c[0] - p[0]), Math.abs(d[0] - p[0])) > 2 * edge) continue;
    if (triDist2(p, a, b, c) <= tol2 || triDist2(p, a, c, d) <= tol2) return true;
  }
  return false;
}

/* The cage of a whole remesh folded at the plane into a mirrored cage
 * with a partner by index. The quads with their centroid past the plane
 * go; the cut edges are the kept quads' boundary edges that were not
 * boundary edges of the whole, and their vertices are the seam, put on the
 * plane and welded with their mirror. Three arrangements would make that
 * weld non-manifold and are dropped round by round until none remain: a
 * quad with three or more cut edges, or two opposite ones, or all four
 * vertices on the seam; an interior edge with both ends on the seam (in
 * the plane it would carry four quads — the quad nearer the plane goes);
 * and a seam vertex whose kept quads form more than one fan (the fan
 * furthest from the plane stays). A quad with two adjacent cut edges is
 * the structural case — a flow crossing the plane at 45° leaves one at
 * every peak of the zigzag — and dropping those walks the seam away one
 * quad a round (15 mm at 800 on the ring's chin). Its mirror would share
 * both cut edges, so the pair is written as ONE quad across the plane:
 * the peak vertex goes and the fourth vertex's mirror takes its place. */
export function foldCageAtPlane(cage, axis = 0) {
  const V0 = cage.vertices, F0 = cage.faces, n = F0.length;
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const byEdge = new Map();
  F0.forEach((q, i) => { for (let k = 0; k < 4; k++) { const e = ek(q[k], q[(k + 1) % 4]); let l = byEdge.get(e); if (!l) byEdge.set(e, l = []); l.push(i); } });
  const cx = (i) => (V0[F0[i][0]][axis] + V0[F0[i][1]][axis] + V0[F0[i][2]][axis] + V0[F0[i][3]][axis]) / 4;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = cx(i) > 0 ? 1 : 0;
  const dropped = { shape: 0, bridge: 0, fan: 0 };
  let seam = new Set(), cutOf = new Map(), rounds = 0;
  for (; rounds < 64; rounds++) {
    seam = new Set(); cutOf = new Map();
    for (const [e, l] of byEdge) {
      if (l.length < 2) continue;
      const k = l.filter((i) => keep[i]);
      if (k.length !== 1) continue;
      const [a, b] = e.split('_').map(Number); seam.add(a); seam.add(b);
      let c = cutOf.get(k[0]); if (!c) cutOf.set(k[0], c = []); c.push(e);
    }
    const drop = new Set();
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      const q = F0[i], cuts = cutOf.get(i) || [];
      let on = 0; for (const v of q) if (seam.has(v)) on++;
      if (cuts.length >= 3 || on === 4) { drop.add(i); continue; }
      if (cuts.length === 2) {
        const k0 = [0, 1, 2, 3].find((k) => ek(q[k], q[(k + 1) % 4]) === cuts[0]), k1 = [0, 1, 2, 3].find((k) => ek(q[k], q[(k + 1) % 4]) === cuts[1]);
        if ((k0 + 2) % 4 === k1) drop.add(i);
      }
    }
    dropped.shape += drop.size;
    for (const [e, l] of byEdge) {
      if (l.length !== 2 || !keep[l[0]] || !keep[l[1]] || drop.has(l[0]) || drop.has(l[1])) continue;
      const [a, b] = e.split('_').map(Number); if (!seam.has(a) || !seam.has(b)) continue;
      drop.add(cx(l[0]) <= cx(l[1]) ? l[0] : l[1]); dropped.bridge++;
    }
    if (!drop.size) {
      const vf = new Map();
      F0.forEach((q, i) => { if (keep[i]) for (const v of q) { let l = vf.get(v); if (!l) vf.set(v, l = []); l.push(i); } });
      for (const [v, l] of vf) {
        if (l.length < 2) continue;
        const par = l.map((_, i) => i); const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
        const edgesAt = (i) => { const q = F0[l[i]], k = q.indexOf(v); return [ek(v, q[(k + 1) % 4]), ek(v, q[(k + 3) % 4])]; };
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { const ei = edgesAt(i), ej = edgesAt(j); if (ei[0] === ej[0] || ei[0] === ej[1] || ei[1] === ej[0] || ei[1] === ej[1]) { const a = find(i), b = find(j); if (a !== b) par[a] = b; } }
        const fans = new Map(); for (let i = 0; i < l.length; i++) { const r = find(i); let f = fans.get(r); if (!f) fans.set(r, f = []); f.push(l[i]); }
        if (fans.size < 2) continue;
        const ranked = [...fans.values()].map((f) => [f.reduce((t, i) => t + cx(i), 0) / f.length, f]).sort((a, b) => b[0] - a[0]);
        for (const [, f] of ranked.slice(1)) for (const i of f) { drop.add(i); dropped.fan++; }
      }
    }
    if (!drop.size) break;
    for (const i of drop) keep[i] = 0;
  }
  /* the peaks: a kept quad with two adjacent cut edges, its middle seam
   * vertex and the vertex opposite */
  const peak = new Map();
  for (const [i, cuts] of cutOf) {
    if (!keep[i] || cuts.length !== 2) continue;
    const q = F0[i], k0 = [0, 1, 2, 3].find((k) => ek(q[k], q[(k + 1) % 4]) === cuts[0]), k1 = [0, 1, 2, 3].find((k) => ek(q[k], q[(k + 1) % 4]) === cuts[1]);
    const mid = (k0 + 1) % 4 === k1 ? k1 : k0;
    peak.set(i, mid);
    seam.delete(q[mid]);
  }
  /* the half's vertices, seam vertices on the plane; then the mirror */
  const map = new Int32Array(V0.length).fill(-1), vertices = [], seamOut = [];
  let moved = 0;
  const put = (v) => { if (map[v] < 0) { map[v] = vertices.length; const p = V0[v].slice(); if (seam.has(v)) { moved = Math.max(moved, Math.abs(p[axis])); p[axis] = 0; seamOut.push(map[v]); } vertices.push(p); } return map[v]; };
  const halfFaces = [];
  for (let i = 0; i < n; i++) if (keep[i]) { const q = F0[i], mid = peak.get(i); halfFaces.push({ q: q.map((v, k) => (k === mid ? -1 : put(v))), mid }); }
  const nHalf = vertices.length, partner = new Int32Array(nHalf * 2);
  const seamSet = new Set(seamOut);
  for (let i = 0; i < nHalf; i++) {
    if (seamSet.has(i)) { partner[i] = i; continue; }
    const m = vertices[i].slice(); m[axis] = -m[axis];
    partner[i] = vertices.length; partner[vertices.length] = i; vertices.push(m);
  }
  const faces = [];
  for (const { q, mid } of halfFaces) {
    if (mid === undefined) { faces.push(q); faces.push(q.map((v) => partner[v]).reverse()); continue; }
    const t = q[(mid + 2) % 4];
    faces.push(q.map((v, k) => (k === mid ? partner[t] : v)));
  }
  const full = new Int32Array(vertices.length); full.set(partner.subarray(0, vertices.length));
  return { cage: { vertices, faces, creases: cage.creases || {} }, partner: full, seamVertices: seamOut.length, peaks: peak.size, dropped, rounds, moved };
}

/* --------------------------------------------------------------------------
 * CAP THE OPENINGS BEFORE THE REMESH
 * --------------------------------------------------------------------------
 * Handed a patch with holes, QuadriFlow fills some, keeps some, and leaves
 * 3-edge gaps of its own at singularities. Handed the same patch with every
 * interior loop capped by a fan, it returns one clean loop and no gaps. The
 * openings are cut back out afterwards by cutOpenings. Returns the capped
 * patch and the loops it capped, longest loop (the rim) left open.
 */
/* `opts.open`: loop indices left uncapped (the fold path's seam-crossing
 * hole — see SEAM_BAND_MM) */
export function capOpenings(patch, opts = {}) {
  const loops = (patch.boundaryLoops && patch.boundaryLoops.length ? patch.boundaryLoops : findQuadBoundaryLoops(patch.faces, patch.vertices.length));
  if (loops.length < 2) return { vertices: patch.vertices, faces: patch.faces, loops, capped: 0, caps: [] };
  const open = opts.open || null;
  const P = patch.vertices;
  const perim = (loop) => { let l = 0; for (let i = 0; i < loop.length; i++) { const a = P[loop[i]], b = P[loop[(i + 1) % loop.length]]; l += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); } return l; };
  const order = loops.map((l, i) => [perim(l), i]).sort((a, b) => b[0] - a[0]);
  /* every piece keeps its longest loop as its rim; a cap over another
   * piece's rim would lid that piece, and the cut would then take the
   * piece for the cap */
  const parent = new Int32Array(P.length); for (let i = 0; i < P.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const f of patch.faces) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) parent[a] = b; }
  const rimOf = new Set();
  for (const [, li] of order) { const r = find(loops[li][0]); if (!rimOf.has(r)) { rimOf.add(r); rimOf.add('loop' + li); } }
  const vertices = P.map((v) => v.slice()), faces = patch.faces.map((f) => f.slice());
  let capped = 0;
  const caps = [];                              // { from, to, area } per capped loop, by face index
  const loopArea = (loop) => {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < loop.length; i++) { const a = P[loop[i]], b = P[loop[(i + 1) % loop.length]]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    return 0.5 * Math.hypot(nx, ny, nz);
  };
  for (const [, li] of order) {
    if (rimOf.has('loop' + li) || (open && open.has(li))) continue;
    const loop = loops[li];
    let cx = 0, cy = 0, cz = 0; for (const v of loop) { cx += P[v][0]; cy += P[v][1]; cz += P[v][2]; }
    const c = vertices.length; vertices.push([cx / loop.length, cy / loop.length, cz / loop.length]);
    const from = faces.length;
    /* a boundary loop runs with the faces' winding; the cap runs against it */
    for (let i = 0; i < loop.length; i++) faces.push([loop[(i + 1) % loop.length], loop[i], c]);
    caps.push({ from, to: faces.length, area: loopArea(loop), loop: li });
    capped++;
  }
  return { vertices, faces, loops, capped, caps };
}

/* --------------------------------------------------------------------------
 * CUT THE OPENINGS THE REMESHER FILLED
 * --------------------------------------------------------------------------
 * QuadriFlow closes interior loops (a 6-loop patch came back with 4 / 3 /
 * 2 / 6 at 100 / 200 / 400 / 800 quads, the eyes as filled domes), so the
 * openings are enforced after it: a cage quad over a cap goes, the rim that
 * leaves behind snaps to the patch's own boundary loops, and flaps hanging
 * by one edge go too. Units are whatever the patch is in; the thresholds
 * are multiples of its median edge.
 */
/* Tangential Laplacian fairing of a quad cage's interior, re-seated on the
 * patch after every pass: a vertex moves `rate` of the way to its
 * neighbours' centroid, keeps only the part of that move in the patch's
 * tangent plane there, and is put back at the patch's height. Boundary
 * vertices hold still. Returns the largest move in patch units. */
export function fairCage(cage, patch, opts = {}) {
  const V = cage.vertices, F = cage.faces;
  const nb = V.map(() => new Set());
  for (const q of F) for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; nb[a].add(b); nb[b].add(a); }
  const rim = new Set(); for (const l of findQuadBoundaryLoops(F, V.length)) for (const v of l) rim.add(v);
  /* patch vertex normals and a grid for the nearest patch vertex */
  const P = patch.vertices, N = P.map(() => [0, 0, 0]);
  for (const f of patch.faces) for (let k = 1; k + 1 < f.length; k++) {
    const a = P[f[0]], b = P[f[k]], c = P[f[k + 1]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const i of [f[0], f[k], f[k + 1]]) { N[i][0] += n[0]; N[i][1] += n[1]; N[i][2] += n[2]; }
  }
  for (const n of N) { const l = Math.hypot(n[0], n[1], n[2]) || 1; n[0] /= l; n[1] /= l; n[2] /= l; }
  let edge = 0, ne = 0;
  for (const q of F) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; edge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ne++; }
  edge /= Math.max(1, ne);
  const cell = Math.max(edge, 1e-6), grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)}_${Math.floor(p[1] / cell)}_${Math.floor(p[2] / cell)}`;
  P.forEach((p, i) => { const k = key(p); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); });
  const nearest = (p) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const l = grid.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
      for (const i of l) { const q = P[i]; const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  };
  /* onto the nearest patch vertex's tangent plane — or onto the vertex
   * itself when the point is far off it, as a vertex the remesher left in
   * a nostril's hollow is: that vertex's plane runs along the nostril's
   * wall and a projection onto it never reaches the skin */
  let pe = 0, pn = 0;
  for (const f of patch.faces) for (let k = 0; k < f.length; k++) { const a = P[f[k]], b = P[f[(k + 1) % f.length]]; pe += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); pn++; }
  const patchEdge = pe / Math.max(1, pn);
  const seat = (p) => {
    const j = nearest(p); if (j < 0) return p;
    const n = N[j], q = P[j], h = (p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] + (p[2] - q[2]) * n[2];
    /* a point on the patch is within a patch edge or two of one of its
     * vertices; farther than that it is off the surface, whatever its
     * height over the nearest vertex's plane says */
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 3 * patchEdge) return q.slice();
    return [p[0] - n[0] * h, p[1] - n[1] * h, p[2] - n[2] * h];
  };
  const rate = opts.rate ?? 0.5;
  let moved = 0;
  for (let pass = 0; pass < (opts.passes ?? 5); pass++) {
    const next = V.map((v) => v);
    for (let i = 0; i < V.length; i++) {
      if (rim.has(i) || !nb[i].size) continue;
      const v = V[i]; let x = 0, y = 0, z = 0;
      for (const u of nb[i]) { x += V[u][0]; y += V[u][1]; z += V[u][2]; }
      const n = nb[i].size; x = x / n - v[0]; y = y / n - v[1]; z = z / n - v[2];
      const j = nearest(v); if (j >= 0) { const m = N[j], k = x * m[0] + y * m[1] + z * m[2]; x -= m[0] * k; y -= m[1] * k; z -= m[2] * k; }
      /* a seam vertex is seated ON the seam: the nearest patch vertex to a
       * point between the nostrils sits on a nostril's rim, 3 mm to one
       * side, and the symmetrize would carry it back to x = 0 off the skin */
      const onSeam = opts.seam && opts.seam.has(i);
      const p = seat([onSeam ? 0 : v[0] + x * rate, v[1] + y * rate, v[2] + z * rate]);
      if (onSeam) p[0] = 0;
      moved = Math.max(moved, Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]));
      next[i] = p;
    }
    for (let i = 0; i < V.length; i++) V[i] = next[i];
  }
  return { moved };
}

/* squared distance from a point to a triangle (closest-point, Ericson) */
function triDist2(p, a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + abx * v, a[1] + aby * v, a[2] + abz * v]; }
      else {
        const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + acx * w, a[1] + acy * w, a[2] + acz * w]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w]; }
          }
        }
      }
    }
  }
  return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
}

export function cutOpenings(cage, patch, opts = {}) {
  const P = patch.vertices, F = patch.faces;
  if (!F.length || !cage.faces.length) return { cage, removed: 0 };
  /* A quad is over an opening when the nearest face of the CAPPED patch —
   * what the remesher saw — is a cap. Distance from the surface is not the
   * test: a 10 mm quad spanning the nose tip has its centroid inside the
   * nose. */
  const capFrom = opts.capFrom ?? F.length;
  /* the patch's centroids, and its median edge */
  const cents = new Float32Array(F.length * 3);
  let edgeSum = 0, edgeN = 0;
  for (let i = 0; i < F.length; i++) {
    const f = F[i]; let x = 0, y = 0, z = 0;
    for (const v of f) { x += P[v][0]; y += P[v][1]; z += P[v][2]; }
    cents[i * 3] = x / f.length; cents[i * 3 + 1] = y / f.length; cents[i * 3 + 2] = z / f.length;
    /* the skin's edge, not the caps': a fan over a face-sized hole is made
     * of 50 mm spokes, and a median that counts them doubles the reach */
    if (i >= capFrom) continue;
    for (let k = 0; k < f.length; k++) {
      const a = P[f[k]], b = P[f[(k + 1) % f.length]];
      edgeSum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); edgeN++;
    }
  }
  const edge = edgeSum / Math.max(1, edgeN);
  const cell = edge * 2;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
  for (let i = 0; i < F.length; i++) {
    const k = key(cents[i * 3], cents[i * 3 + 1], cents[i * 3 + 2]);
    let l = grid.get(k); if (!l) { l = []; grid.set(k, l); } l.push(i);
  }
  const faceDist2 = (p, f) => { let d = Infinity; for (let k = 1; k + 1 < f.length; k++) d = Math.min(d, triDist2(p, P[f[0]], P[f[k]], P[f[k + 1]])); return d; };
  /* the nearest SKIN face within r, by true distance over the faces whose
   * centroid is within r */
  const nearestSkin2 = (p, r) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    const n = Math.ceil(r / cell); let best = Infinity;
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (let dz = -n; dz <= n; dz++) {
      const l = grid.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
      for (const i of l) { if (i >= capFrom) continue; const d = faceDist2(p, F[i]); if (d < best) best = d; }
    }
    return best;
  };
  /* 1. drop every cage quad over a cap. The search reaches a cage quad's
   *    own size: the patch's edge is 1.7 mm and a 200-quad cage's is 10. */
  let cageEdge = 0, ce = 0;
  for (const q of cage.faces) for (let k = 0; k < 4; k++) { const a = cage.vertices[q[k]], b = cage.vertices[q[(k + 1) % 4]]; cageEdge += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ce++; }
  cageEdge /= Math.max(1, ce);
  const reach = Math.max(edge * 6, cageEdge * 2);
  /* Sampled across the quad, not at its centroid alone: an eye on this
   * head is a lid slit a few mm tall under a 10 mm quad, and the centroid
   * of a quad over it is nearest a lid, not the cap. Any sample over a cap
   * takes the quad. */
  /* An opening smaller than three quads is not cut — a hole needs a ring;
   * cut smaller, a nostril's ragged hole sagged 9 mm into the nose and a
   * mouth slit's 5.9 mm, past any push. It is left closed and counted in the
   * readout instead. */
  const quadArea = 3 * cageEdge * cageEdge;
  /* the cap faces that can be cut. A sample is over a cap when the cap's
   * surface is nearer than the skin's, by TRUE distance: a fan over a
   * face-sized hole is 656 slivers 52 mm long and 0.6 mm wide, whose
   * centroids all sit on one ring a third of the way in — by nearest
   * centroid, a quad within 8 mm of the hole's rim read as skin, a fringe
   * of 52 quads stayed over the hole, and the hole never opened */
  const cutFaces = [];
  for (const c of opts.caps || []) if (c.area >= quadArea) for (let f = c.from; f < c.to; f++) cutFaces.push(F[f]);
  const overCap = (x, y, z) => {
    if (!cutFaces.length) return false;
    const p = [x, y, z]; let dc = Infinity;
    for (const f of cutFaces) { const d = faceDist2(p, f); if (d < dc) dc = d; }
    if (dc > reach * reach) return false;
    return dc < nearestSkin2(p, reach);
  };
  let faces = cage.faces.filter((q) => {
    const a = cage.vertices[q[0]], b = cage.vertices[q[1]], c = cage.vertices[q[2]], d = cage.vertices[q[3]];
    for (let u = 0.2; u < 1; u += 0.3) for (let v = 0.2; v < 1; v += 0.3) {
      const x = (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c[0] + (1 - u) * v * d[0];
      const y = (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c[1] + (1 - u) * v * d[1];
      const z = (1 - u) * (1 - v) * a[2] + u * (1 - v) * b[2] + u * v * c[2] + (1 - u) * v * d[2];
      if (overCap(x, y, z)) return false;
    }
    return true;
  });
  /* removed in mirror pairs: the patch is symmetric to a millimetre and
   * not exactly, and a quad kept on one side whose twin went on the other
   * left a vertex with no partner — its own — which the symmetrize then
   * read as a seam vertex and put on x = 0, 27–36 mm away (three of them
   * on this ring mask: the two flaps into the face hole) */
  if (opts.partner) {
    const key = (q) => q.slice().sort((a, b) => a - b).join('_');
    const kept = new Set(faces.map(key));
    faces = faces.filter((q) => kept.has(key(q.map((v) => opts.partner[v]))));
  }
  const removed = cage.faces.length - faces.length;
  /* 2. flaps: a quad with three or more boundary edges hangs by one and goes;
   *    repeat until none. ⚠ ONLY WHERE THE CUT REACHED: a quad touching one
   *    the cut took, or a flap already peeled. A band of paint one quad wide
   *    is a staircase of such quads; peeled everywhere, it severs at its
   *    narrowest neck and step 3 drops everything past it. */
  const cutReach = new Set();
  if (removed) { const keptQ = new Set(faces); for (const q of cage.faces) if (!keptQ.has(q)) for (const v of q) cutReach.add(v); }
  for (let pass = 0; pass < 8 && cutReach.size; pass++) {
    const count = new Map();
    const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (const q of faces) for (let k = 0; k < 4; k++) count.set(ek(q[k], q[(k + 1) % 4]), (count.get(ek(q[k], q[(k + 1) % 4])) || 0) + 1);
    const flap = (q) => { let b = 0; for (let k = 0; k < 4; k++) if (count.get(ek(q[k], q[(k + 1) % 4])) === 1) b++; return b >= 3 && q.some((v) => cutReach.has(v)); };
    const gone = faces.filter(flap);
    if (!gone.length) break;
    for (const q of gone) for (const v of q) cutReach.add(v);
    const goneSet = new Set(gone);
    faces = faces.filter((q) => !goneSet.has(q));
  }
  /* 3. the pieces: every connected piece of four quads or 2% of the cage
   *    and up stays — a four-piece mask is four pieces — and the islands
   *    the cut leaves on a cap go */
  faces = realPieces(faces);
  /* 4. the new rim snaps to the patch's own boundary loops */
  const loops = findQuadBoundaryLoops(faces, cage.vertices.length);
  const vertices = cage.vertices.map((v) => v.slice());
  const before = cage.vertices.map((v) => v.slice());
  /* the loops the rim snaps to are the patch's, SMOOTHED AT THE CAGE'S
   * SCALE: a painted edge wobbles at the brush's spacing (a millimetre or
   * two, every few millimetres), the dense shell carries that as a fine
   * ripple in its rim, and a 5 mm cage cannot — snapped onto it, the rim
   * quads twist and the limit surface crumples along the edge. Laplacian
   * passes over each loop, as many as bring the kernel to one cage edge
   * (√k·edge ≈ cageEdge), leave the rim where the paint put it to within
   * the wobble and take the wobble out. Off with smoothLoops: false. */
  const segs = [];
  const loopPasses = opts.smoothLoops === false ? 0 : Math.max(0, Math.round((cageEdge / Math.max(edge, 1e-9)) ** 2));
  for (const loop of patch.boundaryLoops || []) {
    let L = loop.map((i) => P[i].slice());
    /* Taubin, not Laplacian: thirty-odd passes of a pure Laplacian shrink a
     * closed loop, and a narrow one — the mouth's slit, 4 mm across and 60
     * long — collapsed toward its centre line and behind the lips' bulge,
     * where the rim snapped to it and the never-inside push raised a 10.8
     * mm spike at the seam (measured, 4.5 mm inside). The inflate step gives
     * the shrink back and leaves the wobble taken out. */
    const lap = (mu) => L.map((q, i) => { const a = L[(i + L.length - 1) % L.length], c = L[(i + 1) % L.length]; return [q[0] + mu * ((a[0] + c[0]) / 2 - q[0]), q[1] + mu * ((a[1] + c[1]) / 2 - q[1]), q[2] + mu * ((a[2] + c[2]) / 2 - q[2])]; });
    for (let pass = 0; pass < loopPasses && L.length >= 4; pass++) { L = lap(0.5); L = lap(-0.53); }
    for (let i = 0; i < L.length; i++) segs.push([L[i], L[(i + 1) % L.length]]);
  }
  /* the snap's reach is in CAGE edges — `edge` is the patch's, a
   * millimetre, and a reach of three of those left rim vertices a cut had
   * made sitting 7–10 mm off the loop and 5 mm under the skin */
  const snap = (opts.snapEdges ?? 3) * cageEdge / edge;
  let snapped = 0;
  const placed = [];
  /* where the patch's loops cross the seam: a rim vertex on the seam goes
   * to the nearest crossing whatever the distance — QuadriFlow's adaptive
   * mode cuts the half's corner with a chord, and the mirrored corner sat
   * 19 mm below the forehead's rim, past the snap's reach */
  const crossings = [];
  for (const [a, b] of segs) if ((a[0] <= 0) !== (b[0] <= 0)) { const t = a[0] / (a[0] - b[0]); crossings.push([0, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  for (const loop of loops) for (const v of loop) {
    const p = vertices[v]; let best = null, bd = snap * edge;
    if (crossings.length && Math.abs(p[0]) < 0.05 * edge) {
      let cb = Infinity; for (const c of crossings) { const d = Math.hypot(c[1] - p[1], c[2] - p[2]); if (d < cb) { cb = d; best = c.slice(); } }
      /* a second seam vertex at the same crossing would weld into the first */
      if (best && placed.some((r) => Math.hypot(r[0] - best[0], r[1] - best[1], r[2] - best[2]) < 0.3 * cageEdge)) best = null;
      if (best) { vertices[v] = best; placed.push(best); snapped++; continue; }
    }
    for (const [a, b] of segs) {
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const l2 = abx * abx + aby * aby + abz * abz || 1e-20;
      let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2; t = Math.max(0, Math.min(1, t));
      const q = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < bd) { bd = d; best = q; }
    }
    /* two rim vertices clamped to the same patch corner would weld into a
     * degenerate quad; the second keeps its remeshed place */
    if (best && placed.some((r) => Math.hypot(r[0] - best[0], r[1] - best[1], r[2] - best[2]) < 0.3 * cageEdge)) best = null;
    if (best) { vertices[v] = best; placed.push(best); snapped++; }
  }
  /* 4b. the rim relaxed: three passes of tangential smoothing along each loop,
   *     each vertex re-snapped to the patch's loop, so the cut's stair-steps
   *     and slivers even out into a curve */
  for (let pass = 0; pass < (opts.relaxPasses ?? 3); pass++) {
    for (const loop of loops) {
      if (loop.length < 4) continue;
      const next = loop.map((v, i) => {
        const a = vertices[loop[(i + loop.length - 1) % loop.length]], c = vertices[loop[(i + 1) % loop.length]], p = vertices[v];
        return [p[0] + 0.5 * ((a[0] + c[0]) / 2 - p[0]), p[1] + 0.5 * ((a[1] + c[1]) / 2 - p[1]), p[2] + 0.5 * ((a[2] + c[2]) / 2 - p[2])];
      });
      loop.forEach((v, i) => {
        const p = next[i]; let best = null, bd = Infinity;
        for (const [a, b] of segs) {
          const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
          const l2 = abx * abx + aby * aby + abz * abz || 1e-20;
          let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2; t = Math.max(0, Math.min(1, t));
          const q = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
          const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = q; }
        }
        vertices[v] = best && bd < (snap * edge) ** 2 ? best : p;
      });
    }
  }
  /* 4c. THE INTERIOR FOLLOWS THE RIM. A rim vertex the snap or the relax
   * moved a quad's length — the seam corner goes to its crossing whatever
   * the distance, a cut's stair-step slides along the loop — left its
   * inward neighbours where QuadriFlow put them, and the quads between
   * sheared into a ripple along the rim. The ring inside takes half the
   * mean move of its rim neighbours, the ring beyond a quarter; the
   * fairing that follows re-seats them on the patch. */
  if (opts.follow !== false) {
    const rimSet = new Set(); for (const loop of loops) for (const v of loop) rimSet.add(v);
    const adj = new Map();
    for (const q of faces) for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); }
    const move = new Map();
    for (const v of rimSet) move.set(v, [vertices[v][0] - before[v][0], vertices[v][1] - before[v][1], vertices[v][2] - before[v][2]]);
    let frontier = rimSet;
    for (const w of [0.5, 0.25]) {
      const next = new Map();
      for (const v of frontier) for (const u of adj.get(v) || []) {
        if (rimSet.has(u) || move.has(u)) continue;
        let l = next.get(u); if (!l) { l = []; next.set(u, l); }
        l.push(move.get(v));
      }
      for (const [u, ms] of next) {
        let x = 0, y = 0, z = 0; for (const m of ms) { x += m[0]; y += m[1]; z += m[2]; }
        const d = [w * x / ms.length, w * y / ms.length, w * z / ms.length];
        vertices[u][0] += d[0]; vertices[u][1] += d[1]; vertices[u][2] += d[2];
        move.set(u, [d[0] / w, d[1] / w, d[2] / w]);
      }
      frontier = new Set(next.keys());
    }
  }
  /* how far the rim moved, per loop, longest loop first (the outer rim) */
  const moved = loops.map((loop) => { let mx = 0, sum = 0, at = null; for (const v of loop) { const d = Math.hypot(vertices[v][0] - before[v][0], vertices[v][1] - before[v][1], vertices[v][2] - before[v][2]) / cageEdge; sum += d; if (d > mx) { mx = d; at = before[v]; } } return { n: loop.length, mean: sum / loop.length, max: mx, at }; }).sort((a, b) => b.n - a.n);
  /* 5. compact the vertex list; `kept` maps old index -> new, or -1 */
  const used = new Map(); const outV = [];
  const outF = faces.map((q) => q.map((v) => { let j = used.get(v); if (j === undefined) { j = outV.length; used.set(v, j); outV.push(vertices[v]); } return j; }));
  const kept = new Int32Array(cage.vertices.length).fill(-1);
  for (const [old, j] of used) kept[old] = j;
  return { cage: { vertices: outV, faces: outF, creases: {} }, removed, snapped, loops: loops.length, kept, rimMoved: moved };
}
function realPieces(faces) {
  const parent = faces.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byEdge = new Map();
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  faces.forEach((q, i) => { for (let k = 0; k < 4; k++) { const e = ek(q[k], q[(k + 1) % 4]); const j = byEdge.get(e); if (j === undefined) byEdge.set(e, i); else { const a = find(i), b = find(j); if (a !== b) parent[a] = b; } } });
  const size = new Map();
  faces.forEach((_, i) => { const r = find(i); size.set(r, (size.get(r) || 0) + 1); });
  const least = Math.max(4, 0.02 * faces.length);
  return faces.filter((_, i) => size.get(find(i)) >= least);
}

/* --------------------------------------------------------------------------
 * BOUNDARY RELAXATION
 * Tangentially smooths jagged boundary staircasing from quad clipping.
 * -------------------------------------------------------------------------- */
export function smoothBoundaryVertices(vertices, boundaryLoops, iterations = 3, strength = 0.35) {
  for (let iter = 0; iter < iterations; iter++) {
    for (const loop of boundaryLoops) {
      const L = loop.length;
      if (L < 3) continue;

      const newPositions = [];
      for (let i = 0; i < L; i++) {
        const prev = vertices[loop[(i - 1 + L) % L]];
        const curr = vertices[loop[i]];
        const next = vertices[loop[(i + 1) % L]];

        // Laplacian midpoint
        const targetX = 0.5 * (prev[0] + next[0]);
        const targetY = 0.5 * (prev[1] + next[1]);
        const targetZ = 0.5 * (prev[2] + next[2]);

        // Blended displacement
        newPositions.push([
          curr[0] + strength * (targetX - curr[0]),
          curr[1] + strength * (targetY - curr[1]),
          curr[2] + strength * (targetZ - curr[2])
        ]);
      }

      for (let i = 0; i < L; i++) {
        const idx = loop[i];
        vertices[idx][0] = newPositions[i][0];
        vertices[idx][1] = newPositions[i][1];
        vertices[idx][2] = newPositions[i][2];
      }
    }
  }
}

/* --------------------------------------------------------------------------
 * 2. CENTINA POLYCHORD SIMPLIFICATION (Deterministic Pure-JS)
 * --------------------------------------------------------------------------
 * Simplifies a quad cage by collapsing polychords (dual cycles / edge loops)
 * while preserving all-quad manifold topology and refitting the limit surface.
 */
export function simplifyQuadCageCentina(cage, opts = {}) {
  const targetFaces = opts.targetFaces !== undefined ? opts.targetFaces : 150;
  const maxSteps = opts.maxSteps !== undefined ? opts.maxSteps : 50;
  const allowOpenChords = opts.allowOpenChords !== false; // Mask patches are open sheets!

  let cur = {
    vertices: cage.vertices.map(v => [...v]),
    faces: cage.faces.map(f => [...f]),
    creases: cage.creases ? cage.creases.map(c => [...c]) : []
  };

  const initialFaces = cur.faces.length;
  if (initialFaces <= targetFaces) {
    return {
      cage: cur,
      steps: 0,
      initialFaces,
      finalFaces: initialFaces,
      driftRMS: 0,
      driftMax: 0
    };
  }

  let totalSteps = 0;
  let lastResult = null;

  while (cur.faces.length > targetFaces && totalSteps < maxSteps) {
    const res = simplifySubD(cur, {
      amount: 1,
      tier: 'polychord',
      allowOpenChords,
      refit: opts.refit !== false
    });

    if (!res || !res.ok || !res.cage || res.cage.faces.length >= cur.faces.length) {
      break;
    }

    cur = res.cage;
    lastResult = res;
    totalSteps++;
  }

  return {
    cage: cur,
    steps: totalSteps,
    initialFaces,
    finalFaces: cur.faces.length,
    driftRMS: lastResult?.invariants?.driftRMS ?? 0,
    driftMax: lastResult?.invariants?.driftMax ?? 0
  };
}

/* --------------------------------------------------------------------------
 * 3. QUADRIFLOW REMESHING ENGINE (WASM)
 * --------------------------------------------------------------------------
 * Solves an orientation field and extracts an optimal quad mesh from any
 * surface patch (triangles or quads) at an exact target quad count.
 */
/* The counts a piece is asked at, as factors of its share, until its paint
 * is covered; a piece is covered when at most COVER_SLACK of its vertices
 * are off the cage (the rim's own wobble is 4–12 of 8000) */
const COVER_LADDER = [1, 1.1, 0.9, 1.2, 0.8, 1.3], COVER_SLACK = 0.0025;
/* How many of a piece's vertices lie farther than `reach` median cage
 * edges from the cage's quads (each split in two triangles). The cage's
 * quads sit on the skin, so a vertex that far off has no quad over it. */
export function uncoveredCount(cage, points, out, reach = 1.5) {
  const V = cage.vertices, F = cage.faces;
  if (!F.length) return points.length;
  const E = [];
  for (const q of F) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; E.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
  E.sort((a, b) => a - b);
  const tol = reach * E[E.length >> 1], tol2 = tol * tol, cell = tol;
  const grid = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  const tris = [];
  for (const q of F) for (let k = 1; k + 1 < q.length; k++) {
    const t = tris.length; tris.push([V[q[0]], V[q[k]], V[q[k + 1]]]);
    const lo = [0, 1, 2].map((c) => Math.floor((Math.min(V[q[0]][c], V[q[k]][c], V[q[k + 1]][c]) - tol) / cell));
    const hi = [0, 1, 2].map((c) => Math.floor((Math.max(V[q[0]][c], V[q[k]][c], V[q[k + 1]][c]) + tol) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const kk = key(x, y, z); let l = grid.get(kk); if (!l) grid.set(kk, l = []); l.push(t);
    }
  }
  let n = 0;
  for (const p of points) {
    const l = grid.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
    let hit = false;
    if (l) for (const t of l) { const [a, b, c] = tris[t]; if (triDist2(p, a, b, c) <= tol2) { hit = true; break; } }
    if (!hit) { n++; if (out) out.push(p); }
  }
  return n;
}
export async function remeshQuadPatchQuadriFlow(positions, faces, opts = {}) {
  const { remeshToQuads } = await import('./remesh/quadriflow_engine.js');
  const targetQuads = opts.targetQuads || 150;
  const preserveSharp = opts.sharp || false;
  const preserveBoundary = opts.preserveBoundary !== false;
  /* The output depends on the input's vertex order, and one order in three
   * hands back a quad with two coincident corners (a 360-triangle disk: 60
   * clean quads in one order, 66 with three zero-length edges in another).
   * A degenerate result is retried on the next seed; after three, the
   * coincident corners are welded and the collapsed quads dropped. */
  let result = null, tries = 0;
  for (; tries < 3; tries++) {
    result = await remeshToQuads(positions, faces, { targetQuads, preserveSharp, preserveBoundary, minimumCostFlow: !!opts.minimumCostFlow, adaptiveScale: opts.adaptiveScale !== false, seed: (opts.seed | 0) + tries });
    if (!zeroLengthEdges(result.vertices, result.faces)) break;
  }
  const cage = tries < 3 ? { vertices: result.vertices, faces: result.faces, creases: [] } : weldCage(result.vertices, result.faces);
  return { cage, quadCount: cage.faces.length, vertexCount: cage.vertices.length, retries: tries };
}
function zeroLengthEdges(V, F) {
  let scale = 0;
  for (const v of V) scale = Math.max(scale, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  const eps = Math.max(1e-12, scale * 1e-7);
  for (const q of F) for (let k = 0; k < q.length; k++) {
    const a = V[q[k]], b = V[q[(k + 1) % q.length]];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps) return true;
  }
  return false;
}
function weldCage(V, F) {
  let scale = 0;
  for (const v of V) scale = Math.max(scale, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  const eps = Math.max(1e-12, scale * 1e-7);
  const map = new Int32Array(V.length), keep = [];
  const key = (v) => `${Math.round(v[0] / eps)}_${Math.round(v[1] / eps)}_${Math.round(v[2] / eps)}`;
  const seen = new Map();
  V.forEach((v, i) => { const k = key(v); let j = seen.get(k); if (j === undefined) { j = keep.length; seen.set(k, j); keep.push(v.slice()); } map[i] = j; });
  const faces = [];
  for (const q of F) { const m = q.map((v) => map[v]); if (new Set(m).size === 4) faces.push(m); }
  return { vertices: keep, faces, creases: [] };
}

/* --------------------------------------------------------------------------
 * 4. VALIDATION AGAINST UNREASON3D REQUIREMENTS
 * --------------------------------------------------------------------------
 * Uses Centina's referenceMeshToSuperBCage to verify that the quad cage meets
 * every geometric and topological invariant required by Unreason3D.
 */
export function validateSuperBCage(cage, opts = {}) {
  let maxCoord = 0;
  for (const v of cage.vertices) {
    maxCoord = Math.max(maxCoord, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  }
  const defaultTol = maxCoord < 10 ? 1e-6 : 0.001;
  const tolerance = opts.tolerance ?? defaultTol;

  const result = referenceMeshToSuperBCage(cage.vertices, cage.faces, {
    corners: opts.corners !== false,
    tolerance,
    ...opts
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason || 'Invalid SuperB cage'
    };
  }

  return {
    ok: true,
    cage: result.cage || cage,
    stats: {
      vertices: cage.vertices.length,
      faces: cage.faces.length,
      corners: result.corners ? result.corners.length : 0
    }
  };
}

/* --------------------------------------------------------------------------
 * 5B. OPENNURBS / RHINO BREP COMPATIBLE NURBS LIMIT SURFACE EVALUATION
 * --------------------------------------------------------------------------
 * Uses Centina's subdToPatches to evaluate the SubD cage into clamped
 * bicubic B-spline patches (degree 3 in U and V, 4x4 control net).
 * Formatted directly for OpenNURBS ON_NurbsSurface / ON_Brep serialization.
 */
export function evaluateNurbsPatches(cage, opts = {}) {
  const patchRes = subdToPatches(cage, {
    maxIsolation: opts.maxIsolation ?? 3,
    skipStarCaps: opts.skipStarCaps ?? true
  });

  const onSurfaces = patchRes.patches.map((p, idx) => {
    const srf = p.srf;
    return {
      index: idx,
      faceIndex: p.faceIndex,
      kind: p.kind,
      level: p.level,
      // OpenNURBS standard parameters
      type: 'ON_NurbsSurface',
      dim: 3,
      isRational: false,
      orderU: srf.degU + 1, // order = degree + 1 = 4 (cubic)
      orderV: srf.degV + 1,
      cvCountU: srf.ctrlNet.length,     // 4
      cvCountV: srf.ctrlNet[0].length,  // 4
      knotsU: [...srf.knotsU],          // [0, 0, 0, 0, 1, 1, 1, 1]
      knotsV: [...srf.knotsV],
      // 4x4 control point grid in millimeters
      cvNet: srf.ctrlNet.map(row => row.map(pt => [pt[0], pt[1], pt[2]]))
    };
  });

  return {
    surfaces: onSurfaces,
    patchCount: onSurfaces.length,
    levelsUsed: patchRes.levelsUsed,
    uncovered: patchRes.uncovered,
    caps: patchRes.caps
  };
}

/* --------------------------------------------------------------------------
 * 5. LIMIT SURFACE EVALUATION
 * --------------------------------------------------------------------------
 * Evaluates Catmull-Clark subdivision limit surface using Centina kernel.
 * Returns triangulated mesh suitable for Three.js rendering or raycasting.
 */
export function evaluateSubDLimitMesh(cage, levels = 2) {
  const disp = superbDisplayMesh(cage, 'smooth', { level: levels });
  const nV = disp.vertices.length;
  const positions = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) {
    positions[i * 3] = disp.vertices[i][0];
    positions[i * 3 + 1] = disp.vertices[i][1];
    positions[i * 3 + 2] = disp.vertices[i][2];
  }

  const tris = disp.triangles;
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    indices[i * 3] = tris[i][0];
    indices[i * 3 + 1] = tris[i][1];
    indices[i * 3 + 2] = tris[i][2];
  }

  const normals = limitMeshNormals(positions, indices);

  return {
    positions,
    normals,
    indices,
    triCount: tris.length,
    vertexCount: nV
  };
}

/* area-weighted vertex normals of a triangle mesh, unit length */
export function limitMeshNormals(positions, indices) {
  const nV = positions.length / 3;
  const normals = new Float32Array(nV * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < nV; i++) {
    const idx = i * 3;
    const len = Math.hypot(normals[idx], normals[idx + 1], normals[idx + 2]) || 1;
    normals[idx] /= len; normals[idx + 1] /= len; normals[idx + 2] /= len;
  }
  return normals;
}

/* the faces of a cage refined `levels` times, each tagged with the cage
 * face it came from: a face of n sides gives n children per level, in the
 * order subdivideCatmullClark emits them, and every face is a quad after
 * the first level (superbRefineWithOwners without the geometry) */
export function limitFaceOwners(cage, levels) {
  let owners = cage.faces.map((_, i) => i);
  for (let L = 0; L < levels; L++) {
    const next = [];
    for (let i = 0; i < owners.length; i++) { const n = L === 0 ? cage.faces[i].length : 4; for (let c = 0; c < n; c++) next.push(owners[i]); }
    owners = next;
  }
  return owners;
}

/* which vertices of a limit mesh (evaluateSubDLimitMesh at `levels`, one
 * or more) belong to the cage faces `owned(fi)` accepts and to no other:
 * 1 where every triangle at the vertex descends from an accepted face, 0
 * where any does not, so a vertex on the seam between the outer sheet and
 * the rim wall reads 0 and the wall keeps its shape */
export function limitVerticesOwnedBy(limitMesh, cage, levels, owned) {
  if (!(levels >= 1)) throw new Error('limitVerticesOwnedBy: one level at least (a refined face is a quad, two triangles)');
  const owners = limitFaceOwners(cage, levels);
  const nV = limitMesh.positions.length / 3, idx = limitMesh.indices;
  const inSet = new Uint8Array(nV), outSet = new Uint8Array(nV);
  const accepted = new Uint8Array(cage.faces.length);
  for (let fi = 0; fi < cage.faces.length; fi++) accepted[fi] = owned(fi) ? 1 : 0;
  for (let t = 0; t < idx.length / 3; t++) {
    const o = accepted[owners[t >> 1]];
    for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k]; if (o) inSet[v] = 1; else outSet[v] = 1; }
  }
  for (let v = 0; v < nV; v++) if (outSet[v]) inSet[v] = 0;
  return inSet;
}

/* each flagged vertex of a limit mesh moved along its own normal by
 * `amount[v]` (the mesh's unit), the normals rebuilt from the moved
 * positions; returns how many moved */
export function displaceLimitMesh(limitMesh, mask, amount) {
  const P = limitMesh.positions, N = limitMesh.normals, nV = P.length / 3;
  let moved = 0;
  for (let v = 0; v < nV; v++) {
    if (!mask[v]) continue;
    const a = amount[v];
    if (!a) continue;
    P[v * 3] += N[v * 3] * a; P[v * 3 + 1] += N[v * 3 + 1] * a; P[v * 3 + 2] += N[v * 3 + 2] * a;
    moved++;
  }
  if (moved) N.set(limitMeshNormals(P, limitMesh.indices));
  return moved;
}

/* each vertex's ring on a polygon cage, as Int32 offsets into a flat list */
export function cageRings(nV, faces) {
  const sets = Array.from({ length: nV }, () => new Set());
  for (const q of faces) for (let c = 0; c < q.length; c++) { const a = q[c], b = q[(c + 1) % q.length]; sets[a].add(b); sets[b].add(a); }
  const off = new Int32Array(nV + 1);
  for (let v = 0; v < nV; v++) off[v + 1] = off[v] + sets[v].size;
  const nbr = new Int32Array(off[nV]);
  for (let v = 0; v < nV; v++) { let k = off[v]; for (const w of sets[v]) nbr[k++] = w; }
  return { off, nbr };
}

/* A FIELD WRITTEN INTO A CAGE IS BAND-LIMITED AT THE CAGE. A per-vertex
 * displacement varying faster than the cage's spacing cannot be carried by
 * its limit: it reads as a washboard across the quads and as single-vertex
 * spikes. Taubin λ/μ passes over the ring (λ ½, μ −0.53) attenuate the
 * spacing's own frequency and pass the longer ones with no shrink; vertices
 * not `active` hold their value and are read by their neighbours.
 * `mu` 0 makes it a plain diffusion, which rounds a crest as it lowers it. */
export function bandLimitOnCage(values, rings, active, passes = 2, mu = -0.53) {
  const n = values.length, { off, nbr } = rings;
  let a = Float64Array.from(values), b = new Float64Array(n);
  const step = (w) => {
    for (let v = 0; v < n; v++) {
      if (!active[v] || off[v + 1] === off[v]) { b[v] = a[v]; continue; }
      let s = 0; for (let k = off[v]; k < off[v + 1]; k++) s += a[nbr[k]];
      b[v] = a[v] + w * (s / (off[v + 1] - off[v]) - a[v]);
    }
    [a, b] = [b, a];
  };
  for (let p = 0; p < passes; p++) { step(0.5); if (mu) step(mu); }
  return a;
}

/* A HOLD IS A FIELD, NOT A VERDICT PER VERTEX. A fold guard that lowers one
 * vertex and leaves its ring at full depth stands that vertex alone as a
 * notch or a shard. The held fraction d/ask is spread to the ring, only
 * ever lowered (a vertex never rises past what its own hold allowed, so
 * nothing the guard took down comes back up), `passes` times. Returns d. */
export function spreadHold(ask, d, rings, passes = 2) {
  const n = ask.length, { off, nbr } = rings;
  const r = new Float64Array(n).fill(1);
  for (let v = 0; v < n; v++) if (ask[v] > 0) r[v] = Math.min(1, Math.max(0, d[v] / ask[v]));
  const t = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let v = 0; v < n; v++) {
      if (!(ask[v] > 0)) { t[v] = r[v]; continue; }
      let s = 0, c = 0; for (let k = off[v]; k < off[v + 1]; k++) { const w = nbr[k]; if (ask[w] > 0) { s += r[w]; c++; } }
      t[v] = c ? Math.min(r[v], 0.5 * r[v] + 0.5 * s / c) : r[v];
    }
    r.set(t);
  }
  for (let v = 0; v < n; v++) if (ask[v] > 0) d[v] = r[v] * ask[v];
  return d;
}

/* the creases of a cage carried to its once-subdivided children, both
 * halves of each edge keyed by the edge's own new vertex (the original
 * vertices first at their indices, then one per edge in buildTopology's
 * order, then one per face): the semi-sharp rule, one level of sharpness
 * spent by the step, so the child carries w - 1 and an edge at 0 drops
 * out, which is the identical limit in a reader that decays a weight per
 * level (Unreason, Rhino's sharpness, this app's own drawing). A weight at
 * or over `holdAt` is carried as itself: a reader that reads it as a
 * crease (Rhino, at CREASE_SCALE) keeps a crease's children creases. A
 * naked edge is a crease by construction and needs no entry. */
export function subdividedCreases(cage, holdAt = Infinity) {
  const ctx = buildTopology(cage);
  const creases = {};
  let k = cage.vertices.length;
  for (const [key, edge] of ctx.edgeMap) {
    const w = cage.creases ? cage.creases[key] : 0;
    const c = w >= holdAt ? w : w - 1;
    if (c > 0) { creases[subdEdgeKey(edge.v0, k)] = c; creases[subdEdgeKey(edge.v1, k)] = c; }
    k++;
  }
  return creases;
}

/* the cage subdivided once as a whole (Catmull-Clark: the same limit by
 * construction, 4 quads per quad; the children of face fi are faces
 * 4fi..4fi+3 of an all-quad cage) with its creases carried as above */
export function subdivideCageOnce(cage, holdAt = Infinity) {
  const out = subdivideCatmullClark(cage);
  out.creases = subdividedCreases(cage, holdAt);
  return out;
}

/* THE FRONT REFINED, THE REST LEFT. The faces in [from, to) — the solid's
 * outer sheet — are subdivided `levels` times (Catmull-Clark on that sheet
 * alone, its boundary the seam with the rim wall and the openings' walls,
 * which the solid creases, so the seam's points come out where the whole
 * cage's would) and every other face stays one face: a face that shares
 * an edge with the sheet takes the sheet's refined vertices along that
 * edge, so the rim wall's top row becomes (3 + 2^levels)-gons and the cage
 * stays watertight. 4^levels quads per sheet quad; the inner sheet, the
 * wall and the print's level set are not multiplied. The creases: every
 * one spends the levels, the sheet's through the step and the rest by
 * the same count — the cage stands for the whole cage at that level, so
 * a reader that decays a weight per level (Unreason, Rhino's sharpness)
 * draws the inner rim as sharp as the outer, as the whole-cage refinement
 * does — a seam still live at Unreason's display level takes its
 * per-vertex crease path, 271 s to open against 60; `creases` decrements,
 * `creasesHeld` keeps a weight at or over holdAt as itself (Rhino keeps a
 * crease's children creases).
 * Returns { vertices, faces, creases, creasesHeld, sheetFace (1 per face
 * of the sheet), sheetInterior (1 per vertex of the sheet off its seam),
 * normals (per vertex: the sheet's limit normals one level down — the
 * level-1 limit of the sheet at levels − 1 keeps that cage's vertex points
 * first and its edge and face points in the step's order, so its normals
 * are the refined sheet's vertices' — zero elsewhere), parents (per
 * vertex of the last level, the vertices one level down it came from — a
 * vertex point its own, an edge point its two ends, a face point its
 * corners — as global indices of the cage refined one level less, which
 * shares this one's numbering through that level) }. */
export function refineSheetLocally(cage, from, to, levels, holdAt = Infinity) {
  const nV = cage.vertices.length;
  const inSheet = (fi) => fi >= from && fi < to;
  /* the sheet as its own cage, original indices kept in `toLocal` / `toGlobal` */
  const toLocal = new Int32Array(nV).fill(-1), toGlobal = [];
  const local = (g) => { if (toLocal[g] < 0) { toLocal[g] = toGlobal.length; toGlobal.push(g); } return toLocal[g]; };
  const sheetFaces = [];
  for (let fi = from; fi < to; fi++) sheetFaces.push(cage.faces[fi].map(local));
  const creasesOf = (map, keyOf) => { const out = {}; for (const [k, w] of Object.entries(map || {})) { const [a, b] = k.split('_').map(Number); if (toLocal[a] >= 0 && toLocal[b] >= 0) out[keyOf(toLocal[a], toLocal[b])] = w; } return out; };
  let cur = { vertices: toGlobal.map((g) => cage.vertices[g].slice()), faces: sheetFaces, creases: creasesOf(cage.creases, subdEdgeKey) };
  let curHeld = cur.creases;
  /* the seam: every boundary edge of the sheet, as a chain of its refined vertices (local indices) */
  const chains = new Map();   // "a_b" (global, unordered) -> [local ...] from a to b
  {
    const count = new Map();
    for (const f of sheetFaces) for (let k = 0; k < f.length; k++) { const key = subdEdgeKey(f[k], f[(k + 1) % f.length]); count.set(key, (count.get(key) || 0) + 1); }
    for (const [key, c] of count) if (c === 1) { const [a, b] = key.split('_').map(Number); chains.set(subdEdgeKey(toGlobal[a], toGlobal[b]), [a, b]); }
  }
  let limitPrev = null, parentsLocal = null;
  for (let L = 0; L < levels; L++) {
    if (L === levels - 1) limitPrev = evaluateSubDLimitMesh(cur, 1);
    const ctx = buildTopology(cur);
    const edgePoint = new Map(); let k = cur.vertices.length;
    for (const key of ctx.edgeMap.keys()) edgePoint.set(key, k++);
    parentsLocal = cur.vertices.map((_, i) => [i]);
    for (const e of ctx.edgeMap.values()) parentsLocal.push([e.v0, e.v1]);
    for (const f of cur.faces) parentsLocal.push(f.slice());
    for (const [key, chain] of chains) {
      const next = [chain[0]];
      for (let i = 1; i < chain.length; i++) { next.push(edgePoint.get(subdEdgeKey(chain[i - 1], chain[i]))); next.push(chain[i]); }
      chains.set(key, next);
    }
    const held = subdividedCreases({ ...cur, creases: curHeld }, holdAt);
    const nextCage = subdivideCatmullClark(cur);
    nextCage.creases = subdividedCreases(cur, Infinity);
    cur = nextCage; curHeld = held;
  }
  /* the cage reassembled: the originals first (the sheet's moved to their
   * refined positions), the sheet's new vertices after */
  const vertices = cage.vertices.map((v) => v.slice());
  const globalOf = new Int32Array(cur.vertices.length);
  for (let i = 0; i < cur.vertices.length; i++) {
    if (i < toGlobal.length) { globalOf[i] = toGlobal[i]; vertices[toGlobal[i]] = cur.vertices[i].slice(); }
    else { globalOf[i] = vertices.length; vertices.push(cur.vertices[i].slice()); }
  }
  const faces = [], sheetFace = [];
  const seamKey = (a, b) => subdEdgeKey(a, b);
  for (let fi = 0; fi < cage.faces.length; fi++) {
    if (inSheet(fi)) continue;
    const f = cage.faces[fi], out = [];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      out.push(a);
      const chain = chains.get(seamKey(a, b));
      if (!chain) continue;
      /* the chain runs from its first to its last; this face walks a→b */
      const c = toGlobal[chain[0]] === a ? chain : [...chain].reverse();
      for (let i = 1; i < c.length - 1; i++) out.push(globalOf[c[i]]);
    }
    faces.push(out); sheetFace.push(0);
  }
  for (const f of cur.faces) { faces.push(f.map((i) => globalOf[i])); sheetFace.push(1); }
  const creases = {}, creasesHeld = {};
  for (const [k, w] of Object.entries(cage.creases || {})) { const [a, b] = k.split('_').map(Number); if (toLocal[a] >= 0 && toLocal[b] >= 0) continue; if (w - levels > 0) creases[k] = w - levels; const h = w >= holdAt ? w : w - levels; if (h > 0) creasesHeld[k] = h; }
  for (const [k, w] of Object.entries(cur.creases || {})) { const [a, b] = k.split('_').map(Number); creases[subdEdgeKey(globalOf[a], globalOf[b])] = w; }
  for (const [k, w] of Object.entries(curHeld || {})) { const [a, b] = k.split('_').map(Number); creasesHeld[subdEdgeKey(globalOf[a], globalOf[b])] = w; }
  /* the sheet's interior: its vertices off every chain */
  const sheetInterior = new Uint8Array(vertices.length);
  for (let i = 0; i < cur.vertices.length; i++) sheetInterior[globalOf[i]] = 1;
  for (const chain of chains.values()) for (const i of chain) sheetInterior[globalOf[i]] = 0;
  /* the sheet's normals: the limit's, one level down */
  const normals = new Float32Array(vertices.length * 3);
  if (limitPrev) for (let i = 0; i < cur.vertices.length; i++) { const g = globalOf[i]; normals[g * 3] = limitPrev.normals[i * 3]; normals[g * 3 + 1] = limitPrev.normals[i * 3 + 1]; normals[g * 3 + 2] = limitPrev.normals[i * 3 + 2]; }
  /* the parents in the numbering of the cage one level less refined: its
   * originals are these originals, its sheet vertices follow in the same
   * local order, so a local index maps the same way there */
  const globalPrev = (i) => i < toGlobal.length ? toGlobal[i] : nV + (i - toGlobal.length);
  const parents = parentsLocal ? vertices.map(() => null) : null;
  if (parentsLocal) for (let i = 0; i < cur.vertices.length; i++) parents[globalOf[i]] = parentsLocal[i].map(globalPrev);
  return { vertices, faces, creases, creasesHeld, sheetFace: Uint8Array.from(sheetFace), sheetInterior, normals, levels, parents };
}

/* --------------------------------------------------------------------------
 * 5C. SURFACE PATCH BOUNDARY EDGES
 * --------------------------------------------------------------------------
 * Traces the cage face boundaries directly ON the Catmull-Clark limit surface,
 * matching Unreason3D's superbSurfaceEdgePairs display. Without this, a smooth
 * SubD looks like an undifferentiated form with no visible face layout.
 */
export function superbRefineWithOwners(cage, level = 2) {
  let owners = cage.faces.map((_, i) => i);
  let cur = {
    vertices: cage.vertices.map(v => [...v]),
    faces: cage.faces.map(f => [...f]),
    creases: cage.creases || {}
  };
  for (let L = 0; L < level; L++) {
    const next = [];
    cur.faces.forEach((f, fi) => {
      for (let c = 0; c < f.length; c++) next.push(owners[fi]);
    });
    cur = subdivideCatmullClark(cur);
    owners = next;
  }
  return { refined: cur, owners };
}

export function superbSurfaceEdgePairs(cage, level = 2) {
  if (!cage || !cage.vertices || !cage.faces || cage.faces.length === 0) return [];
  const { refined, owners } = superbRefineWithOwners(cage, level);
  const byOwner = new Map();
  refined.faces.forEach((f, fi) => {
    const o = owners[fi];
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(f);
  });
  const emitted = new Set();
  const out = [];
  for (const faces of byOwner.values()) {
    const count = new Map(), store = new Map();
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        count.set(k, (count.get(k) || 0) + 1);
        if (!store.has(k)) store.set(k, [a, b]);
      }
    }
    for (const [k, n] of count) {
      if (n !== 1 || emitted.has(k)) continue;
      emitted.add(k);
      const [a, b] = store.get(k);
      out.push(refined.vertices[a], refined.vertices[b]);
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * 6. EXPORT BUILDERS: .unreason DOCUMENT AND .obj QUAD MESH
 * -------------------------------------------------------------------------- */

/**
 * Builds a valid Unreason3D .unreason document string.
 * When opened via runOpenFile / unrRestoreDocument in Unreason3D, this restores
 * directly as an active SuperB object in the scene tree.
 */
export const UNREASON_MESH_TRIANGLES = 25000;
export function buildUnreasonDocument(cage, opts = {}) {
  /* The record shape is Unreason's own leaf snapshot for a SuperB —
   * `snapshotObjectData` there — so `unrRestoreDocument` builds it without a
   * special case. Creases are a map of "u_v" edge keys to weights. */
  const creases = Array.isArray(cage.creases) ? {} : (cage.creases || {});
  /* Unreason stands things up: Z is up and the front view looks along +Y, so
   * the head's Y-up, faces-+Z design frame goes over as (x, y, z) → (x, -z, y)
   * — the mask upright, facing the front view. The OBJ beside it stays in
   * the design frame so it lands on masq-patch.obj in Rhino. */
  const frame = opts.zUp === false ? (v) => v.slice(0, 3) : (v) => [v[0], -v[2], v[1]];
  const vertices = cage.vertices.map(frame);
  const objects = [
    {
      id: 1,
      name: opts.name || 'masq-superb',
      layerId: 0,
      leaf: {
        type: 'SuperB',
        superbCage: { vertices, faces: cage.faces, creases },
        superbSourceCommand: 'tosubd',
        superbFacets: null
      }
    }
  ];
  /* `opts.curves`: [{name, ctrl, closed}] closed uniform quadratic B-splines
   * in the cage's frame and units. Each goes in as the SketchCurve record
   * Unreason builds for a .3dm curve it imports (`build3dmImportedCurveEntry`):
   * a clamped `crv` whose first and last control points coincide (that is
   * how it reads closed), `sketchSamples` for the wire, no through-points. */
  (opts.curves || []).forEach((cv, i) => {
    const clamped = periodicQuadraticToClamped(cv.ctrl.map(frame));
    if (!clamped) return;
    objects.push({
      id: 2 + i, name: cv.name || 'masq-curve-' + (i + 1), layerId: 0,
      leaf: {
        type: 'SketchCurve', crv: clamped.crv,
        sketchSamples: clamped.samples.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
        sketchPoints: [], sketchGenerated: true, sketchExtracted: false, sketchClosed: true,
        sketchDegree: 2, sketchControlNet: false, annotationColor: null
      }
    });
  });
  /* `opts.meshes`: [{name, positions (flat, mm, the cage's frame), triangles
   * (index arrays of 3)}] go in as the record Unreason writes for an embedded
   * reference mesh (`rec.referenceMesh`): positions as triples, triangles,
   * no colours. Unreason's reader SKIPS a record over 25,000 triangles
   * (REFERENCE_MESH_PERSIST_MAX_TRIANGLES), so a bigger mesh is decimated to
   * that count first, by the app's own quadric decimator, and named so. */
  (opts.meshes || []).forEach((m, i) => {
    const P = m.positions, T = m.triangles;
    const positions = new Array(P.length / 3);
    for (let k = 0; k < positions.length; k++) positions[k] = frame([P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
    if (!positions.length || !T.length) return;
    objects.push({
      id: objects.length + 1, name: m.name || 'masq-mesh-' + (i + 1), layerId: 0,
      referenceMesh: { positions, triangles: T.map((f) => [f[0], f[1], f[2]]), faces: [], mask: null, detectedBodyCount: 1, importUnit: 'mm', scaleLocked: true, placementFrame: null, toSuperBOptions: null },
      sourceTag: m.sourceTag || null,
    });
  });
  /* the envelope is what Open checks first: `format` must read
   * 'unreason-document' and the objects sit under `document` */
  const doc = {
    format: 'unreason-document',
    version: 1,
    app: 'MASQ',
    savedAt: new Date().toISOString(),
    document: { v: 1, nextId: objects.length + 1, currentLayerId: 0, objects }
  };
  /* `opts.refinementLevel`: the document's own Catmull-Clark display level
   * (Unreason's documentSettings.superbRefinementLevel, restored on open).
   * Unreason draws a cage over 1,200 faces at level 1 and pushes each
   * vertex still carrying a crease weight to the limit by subdividing the
   * whole refined cage that many times, per vertex: a full-face solid
   * subdivided once for the pattern (5,904 quads, creases at 2) took over
   * 90 s to open at level 1; at level 2 no weight is left and the picture
   * is the 94k quads the coarse cage drew. */
  if (opts.refinementLevel != null) doc.document.documentSettings = { superbRefinementLevel: opts.refinementLevel };

  /* compact once a mesh is in it: a 25,000-triangle reference indented is
   * three times the file */
  return JSON.stringify(doc, null, opts.meshes && opts.meshes.length ? 0 : 2);
}

/**
 * A closed uniform quadratic B-spline over control points C[0..n-1] (segment k
 * runs from the midpoint of C[k],C[k+1] to the midpoint of C[k+1],C[k+2]) as
 * the same curve in clamped form: control points [M0, C1 .. C(n-1), C0, M0],
 * knots [0,0,0,1..n,n,n]. Span for span the Bezier points agree, so the
 * curve is identical and any P&T reader sees a closed curve (first control
 * point == last). Returns {crv:{degree, knots, ctrlPts:[[x,y,z,1]]}, samples}
 * or null under three control points.
 */
export function periodicQuadraticToClamped(C, perSpan = 8) {
  const n = C.length; if (n < 3) return null;
  const M0 = [(C[0][0] + C[1][0]) / 2, (C[0][1] + C[1][1]) / 2, (C[0][2] + C[1][2]) / 2];
  const P = [M0]; for (let k = 1; k < n; k++) P.push(C[k].slice(0, 3)); P.push(C[0].slice(0, 3)); P.push(M0);
  const knots = [0, 0, 0]; for (let k = 1; k <= n; k++) knots.push(k); knots.push(n, n);
  const samples = [];
  for (let k = 0; k < n; k++) {
    const A = k === 0 ? M0 : [(P[k][0] + P[k + 1][0]) / 2, (P[k][1] + P[k + 1][1]) / 2, (P[k][2] + P[k + 1][2]) / 2];
    const B = P[k + 1];
    const D = k === n - 1 ? M0 : [(P[k + 1][0] + P[k + 2][0]) / 2, (P[k + 1][1] + P[k + 2][1]) / 2, (P[k + 1][2] + P[k + 2][2]) / 2];
    for (let s = 0; s < perSpan; s++) {
      const t = s / perSpan, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
      samples.push([a * A[0] + b * B[0] + c * D[0], a * A[1] + b * B[1] + c * D[1], a * A[2] + b * B[2] + c * D[2]]);
    }
  }
  samples.push(M0.slice());
  return { crv: { degree: 2, knots, ctrlPts: P.map((q) => [q[0], q[1], q[2], 1]) }, samples };
}

/**
 * Builds a clean, compliant quad Wavefront OBJ string in millimeters.
 * When imported into Unreason3D as a reference mesh, clicking "ToSubD" / "ToSuperB"
 * creates a valid SubD limit surface without conversion errors.
 */
export function buildSuperBOBJ(cage, name = 'masq_superb') {
  const lines = [];
  lines.push(`# ${name} — MASQ ToSuperB quad cage.`);
  lines.push('# Units: millimeters.');
  lines.push(cage.faces.every((f) => f.length === 4) ? '# Format: Wavefront OBJ all-quad 2-manifold.' : '# Format: Wavefront OBJ 2-manifold, quads with n-gons along the refined front\'s seam.');
  lines.push(`o ${name}`);

  for (const v of cage.vertices) {
    lines.push(`v ${v[0].toFixed(4)} ${v[1].toFixed(4)} ${v[2].toFixed(4)}`);
  }

  for (const f of cage.faces) {
    // OBJ uses 1-based indices; a face is written whole, however many sides
    lines.push('f ' + f.map((i) => i + 1).join(' '));
  }

  return lines.join('\n') + '\n';
}

/* coincident vertices welded by position, faces remapped, triangles with a
 * repeated corner or no area dropped; the vertex list is left whole */
export function weldPatch(patch) {
  const V = patch.vertices, n = V.length;
  const seen = new Map(), remap = new Int32Array(n);
  let welded = 0;
  for (let i = 0; i < n; i++) {
    const k = V[i][0] + ',' + V[i][1] + ',' + V[i][2];
    if (seen.has(k)) { remap[i] = seen.get(k); welded++; } else { seen.set(k, i); remap[i] = i; }
  }
  const faces = [];
  let dropped = 0;
  for (const f of patch.faces) {
    const g = f.map((i) => remap[i]);
    let dup = false;
    for (let a = 0; a < g.length && !dup; a++) for (let b = a + 1; b < g.length; b++) if (g[a] === g[b]) { dup = true; break; }
    if (dup) { dropped++; continue; }
    let area = 0;
    for (let k = 1; k + 1 < g.length; k++) {
      const a = V[g[0]], b = V[g[k]], c = V[g[k + 1]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    if (!(area > 1e-14)) { dropped++; continue; }
    faces.push(g);
  }
  if (!welded && !dropped) return patch;
  return { ...patch, faces, welded, dropped };
}

/* --------------------------------------------------------------------------
 * 7. HIGH-LEVEL ORCHESTRATOR: toSuperB
 * --------------------------------------------------------------------------
 * Unified entry point that executes extraction, simplification, validation,
 * and export document generation.
 */
/* A cage that fails validation — a low count on a mask with holes can
 * leave an edge shared by four faces after the cut and mirror — is retried
 * on the next seed, three in all. Measured: 100 quads on a full face with
 * its eyes cut failed on seed 0 and built on seed 1. */
/* ⚠ QUADRIFLOW CAN CRUMPLE A CORNER AT ONE COUNT AND NOT ITS NEIGHBOURS:
 * on a lower-face mask, 800 quads packed fifteen vertices into a
 * sliver beside the rim at the mouth's corner — 12 turned-over edges after
 * the fairing, the wall guarded to 0.04 mm — while 700, 750, 850, 900, 1000
 * and 1200 came back with none. Fairing cannot untangle a sliver that holds
 * more vertices than its room. A cage that still folds is asked again at
 * nearby counts and the one with the fewest folds is kept. */
const FOLD_LADDER = [1.05, 0.95, 1.1, 0.9];
export async function toSuperB(arg1, arg2, arg3, arg4) {
  const at = arg1 && arg1.positions && arg1.faces ? 1 : Array.isArray(arg2) && (arg3 === undefined || (!Array.isArray(arg3) && !(arg3 instanceof Float32Array))) ? 2 : 3;
  const args = [arg1, arg2, arg3, arg4], opts = args[at] || {};
  let t0 = Date.now(), best = await toSuperBAt(...args);
  if (!best.ok || (opts.engine || 'quadriflow') !== 'quadriflow') return best;
  let folds = foldedEdges(best.cage), retry = null;
  const tries = [[1, folds, Date.now() - t0]];
  for (const f of FOLD_LADDER) {
    if (!folds) break;
    const again = args.slice(); again[at] = { ...opts, targetFaces: Math.round((opts.targetFaces || 200) * f) };
    t0 = Date.now();
    const r = await toSuperBAt(...again);
    if (!r.ok) continue;
    const n = foldedEdges(r.cage);
    tries.push([f, n, Date.now() - t0]);
    if (n < folds) { best = r; folds = n; retry = f; }
  }
  best.reductionStats = { ...(best.reductionStats || {}), folds, foldRetry: retry, foldTries: tries };
  return best;
}

/* edges whose two faces turn over against each other — a crumpled cage,
 * which no wall can be offset from (the guard thins it toward nothing) */
export function foldedEdges(cage) {
  const V = cage.vertices, F = cage.faces;
  const fn = F.map((q) => {
    const a = V[q[0]], b = V[q[1]], c = V[q[2]], d = V[q[q.length - 1]];
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  });
  const byEdge = new Map();
  F.forEach((q, fi) => { for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length], key = a < b ? `${a}_${b}` : `${b}_${a}`; const l = byEdge.get(key); if (l) l.push(fi); else byEdge.set(key, [fi]); } });
  let n = 0;
  for (const fs of byEdge.values()) if (fs.length === 2) { const m = fn[fs[0]], o = fn[fs[1]]; if (m[0] * o[0] + m[1] * o[1] + m[2] * o[2] < 0) n++; }
  return n;
}

async function toSuperBAt(arg1, arg2, arg3, arg4) {
  const args = [arg1, arg2, arg3, arg4];
  let at = -1;
  for (let i = 3; i >= 1; i--) if (args[i] && typeof args[i] === 'object' && !Array.isArray(args[i]) && !ArrayBuffer.isView(args[i])) { at = i; break; }
  let res = null;
  for (let tries = 0; tries < 3; tries++) {
    const a = args.slice();
    if (at >= 0) a[at] = { ...args[at], seed: (args[at].seed | 0) + tries };
    else if (tries) break;
    res = await toSuperBOnce(a[0], a[1], a[2], a[3]);
    if (res && (res.ok || !/^Validation failed/.test(res.reason || ''))) return res;
  }
  return res;
}
async function toSuperBOnce(arg1, arg2, arg3, arg4) {
  let patch;
  let opts = {};

  if (arg1 && arg1.positions && arg1.faces) {
    // Mode A: Direct mesh object { positions, faces } (triangles or quads, e.g. masq-patch or imported mesh)
    opts = arg2 || {};
    const scale = opts.scale !== undefined ? opts.scale : (opts.inMillimeters ? 1 : MM);
    const rawPos = arg1.positions;
    const nV = (rawPos.length / 3) | 0;
    const vertices = [];
    for (let i = 0; i < nV; i++) {
      vertices.push([rawPos[i * 3] * scale, rawPos[i * 3 + 1] * scale, rawPos[i * 3 + 2] * scale]);
    }
    const isTriangles = arg1.faces.length > 0 && arg1.faces[0].length === 3;
    patch = {
      vertices,
      faces: arg1.faces,
      isTriangles
    };
  } else if (Array.isArray(arg2) && (arg3 === undefined || (!Array.isArray(arg3) && !(arg3 instanceof Float32Array)))) {
    // Mode B: toSuperB(positions, faces, opts)
    opts = arg3 || {};
    const scale = opts.scale !== undefined ? opts.scale : (opts.inMillimeters ? 1 : MM);
    const rawPos = arg1;
    const nV = (rawPos.length / 3) | 0;
    const vertices = [];
    for (let i = 0; i < nV; i++) {
      vertices.push([rawPos[i * 3] * scale, rawPos[i * 3 + 1] * scale, rawPos[i * 3 + 2] * scale]);
    }
    const isTriangles = arg2.length > 0 && arg2[0].length === 3;
    patch = {
      vertices,
      faces: arg2,
      isTriangles
    };
  } else {
    // Mode C: toSuperB(basePositions, quads, coverage, opts)
    opts = arg4 || {};
    patch = extractMaskQuads(arg1, arg2, arg3, opts);
    if (patch.faces.length === 0) {
      return {
        ok: false,
        reason: 'No mask coverage found at specified threshold'
      };
    }
    patch.isTriangles = false;
  }

  /* ⚠ A ZERO-AREA TRIANGLE KILLS THE REMESHER. Where the clip's crossing
   * lands on a mesh vertex two patch vertices coincide and every triangle
   * between them has no area; QuadriFlow's traversal then hits its own
   * exit(0) and the instance is dead. A mask opened from a .masq (coverage
   * back through JSON) had 10 such pairs and 454 such triangles and never
   * built again. Coincident vertices are welded and empty triangles dropped
   * before anything reads the faces. */
  patch = weldPatch(patch);

  let cage = {
    vertices: patch.vertices,
    faces: patch.faces,
    creases: []
  };

  // Step 2: Simplify / remesh to target low-polygon count
  const targetFaces = opts.targetFaces || 200;
  const engine = opts.engine || 'quadriflow';
  /* the patch's units per millimeter: the input is meters scaled by `scale`
   * (MM by default), or millimeters as they are */
  const mmPer = opts.inMillimeters ? 1 : (opts.scale !== undefined ? opts.scale : MM) / MM;

  let reductionStats = null;
  let partner = null;
  if (engine === 'quadriflow') {
    /* cap every opening on the WHOLE patch first — see capOpenings — so an
     * opening the seam would cut in two (the mouth) is capped like the rest
     * and not left as a notch in the half's rim */
    const capped = opts.cutOpenings !== false ? capOpenings(patch) : { vertices: patch.vertices, faces: patch.faces, loops: [], capped: 0, caps: [] };
    /* under Sym: one half, remeshed, mirrored and welded — see clipPatchHalf.
     * Unless a hole that will be cut at this count crosses the seam with a
     * band under SEAM_BAND_MM beside it AND the half comes back with no quad
     * over that band at the seam: then the whole is remeshed and folded —
     * see foldCageAtPlane. The band is the skin along the seam from the
     * hole's crossing to the next loop's (seamBands); a hole is cut at
     * this count when its cap is at least a quad of the nominal edge, as
     * cutOpenings decides it; the band is covered when some cage quad
     * passes within a quarter of a cage edge of its half-way point (a quad
     * on the skin is within a tenth of a millimeter of it, the chord across
     * the ring's chin ran 7 mm under it). The half is always tried first:
     * a full face's mouth has a 22 mm band to the chin rim and the half
     * covers it, so a rule on the band alone would move that mask. */
    let narrow = [], crossing = null;
    if (opts.mirror && capped.caps.length) {
      const P = capped.vertices;
      let area = 0;
      for (const f of capped.faces) for (let k = 1; k + 1 < f.length; k++) { const a = P[f[0]], b = P[f[k]], c = P[f[k + 1]]; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); }
      const quadArea = 3 * area / Math.max(1, targetFaces);
      crossing = new Set();
      for (const c of capped.caps) {
        if (c.area < quadArea) continue;
        const loop = capped.loops[c.loop]; let neg = false, pos = false;
        for (const v of loop) { if (P[v][0] < 0) neg = true; else if (P[v][0] > 0) pos = true; }
        if (neg && pos) crossing.add(c.loop);
      }
      if (crossing.size) narrow = seamBands(patch, capped.loops, 0).filter((b) => b.loops.some((li) => crossing.has(li)) && b.length < SEAM_BAND_MM * mmPer);
    }
    const half = opts.mirror ? clipPatchHalf(capped, 0) : null;
    /* ⚠ A MASK CAN BE IN PIECES — two eye patches, a brow and a chin — and
     * the remesher assumes one. Each connected piece is remeshed on its own
     * at a share of the count by area, and the cages are merged. */
    /* a crumb — a piece under six quads' worth of area, or under 1% of
     * the mask — is not a mask piece: a lash line the eraser left, a sliver
     * the seam cut off. Each would get twelve quads of its own. (Forty
     * quads' worth dropped a temple disc of a four-piece mask at 320.) */
    const remeshPieces = async (src, want, ladder = true) => {
      const all = splitPieces(src);
      const totalArea0 = all.reduce((t, pc) => t + pc.area, 0) || 1;
      const quadArea = totalArea0 / Math.max(1, want);
      const pieces = all.filter((pc) => pc.area >= Math.max(6 * quadArea, 0.01 * totalArea0));
      const totalArea = pieces.reduce((t, pc) => t + pc.area, 0) || 1;
      const merged = { vertices: [], faces: [], creases: {} };
      let dropped = all.length - pieces.length, uncovered = 0;
      for (const pc of pieces) {
        let qfResult = null;
        /* a piece the remesher throws on is asked again with more quads —
         * a small disc at a dozen quads returns nothing — before it is dropped */
        const ask = Math.max(12, Math.round(want * pc.area / totalArea));
        /* an open piece must come back open: asked for two dozen quads on a
         * 16 mm disc, QuadriFlow returned a closed 25-quad blob with no rim */
        const openIn = findQuadBoundaryLoops(pc.faces, pc.vertices.length).length > 0;
        /* ⚠ QUADRIFLOW CAN SKIP A NARROW TAIL OF THE PIECE: a band past a
         * 10 mm neck comes back missing at some counts and not at their
         * neighbours (one half: 600/1000/1300/2050 quads lost 267/31/33/85
         * vertices, 500/800/1600/2350 none); no seed, flag or higher count
         * cures it. Each result is measured against the piece and asked
         * again at nearby counts; the first that covers it, else the best,
         * is kept. */
        const allowed = Math.max(4, Math.round(COVER_SLACK * pc.vertices.length));
        let best = null, bestMissed = Infinity;
        for (const f of ladder ? COVER_LADDER : [1]) {
          if (bestMissed <= allowed) break;
          let got = null;
          for (const targetQuads of [ask, ask * 2, ask * 4, ask * 8].map((n) => Math.max(12, Math.round(n * f)))) {
            try {
              got = await remeshQuadPatchQuadriFlow(pc.vertices, pc.faces, {
                targetQuads, preserveBoundary: true, minimumCostFlow: opts.minimumCostFlow !== false, adaptiveScale: opts.adaptiveScale !== false, seed: opts.seed | 0,
              });
              if (openIn && !findQuadBoundaryLoops(got.cage.faces, got.cage.vertices.length).length) { got = null; continue; }
              break;
            } catch (e) { got = null; }
          }
          if (!got) continue;
          const missed = uncoveredCount(got.cage, pc.vertices);
          if (missed < bestMissed) { best = got; bestMissed = missed; }
        }
        qfResult = best;
        if (best && bestMissed > allowed) uncovered += bestMissed;
        if (!qfResult) { dropped++; continue; }
        const base = merged.vertices.length;
        for (const v of qfResult.cage.vertices) merged.vertices.push(v);
        for (const q of qfResult.cage.faces) merged.faces.push(q.map((v) => v + base));
      }
      return { merged, dropped, pieces, totalArea0, quadArea, uncovered };
    };
    /* the half is asked once before the cover ladder: a band at the seam
     * the half cannot reach is remeshed whole below, and its misses are
     * the same at every rung (a ring's chin band: 148–233 of 3446, six
     * rungs at ~20 s each for nothing) */
    const halfAsk = Math.max(20, Math.round(targetFaces / 2));
    let r = await remeshPieces(half || capped, half ? halfAsk : targetFaces, !half);
    if (!r.merged.faces.length) return { ok: false, reason: 'the remesher returned nothing for this mask' };
    let folded = null;
    const mirrorHalf = () => {
      cage = r.merged;
      reductionStats = { patchLoops: capped.loops.length, crumbs: r.dropped, uncovered: r.uncovered };
      const m = mirrorCage(cage, 0);
      cage = m.cage; partner = m.partner;
      reductionStats = { ...(reductionStats || {}), mirrored: true, seamVertices: [...m.partner].filter((p, i) => p === i).length };
    };
    if (!half) {
      cage = r.merged;
      reductionStats = { patchLoops: capped.loops.length, crumbs: r.dropped, uncovered: r.uncovered };
    } else {
      mirrorHalf();
      const uncovered = narrow.filter((b) => !cageCovers(cage, b.mid));
      if (!uncovered.length && r.uncovered) {
        const rl = await remeshPieces(half, halfAsk);
        if (rl.merged.faces.length) { r = rl; mirrorHalf(); }
      }
      if (uncovered.length) {
        /* the crossing holes are left OPEN for the whole remesh: a fan cap
         * over a face-sized hole is 656 slivers 52 mm long and 0.6 mm wide
         * meeting at an interior apex, and on the whole ring QuadriFlow's
         * field collapsed round it — 2 rows of 27 mm quads across a 54 mm
         * forehead band where the half had 8 rows of 7 (a flat, deep or
         * ring-subdivided cap was worse). Uncapped, the whole ring came
         * back with both loops, 7 mm quads on the forehead and 12 in the
         * chin band at the seam. The cut still runs against the fully
         * capped patch, so a hole the remesher fills anyway is cut like
         * the rest. */
        const r2 = await remeshPieces(capOpenings(patch, { open: crossing }), targetFaces);
        if (r2.merged.faces.length) {
          r = r2;
          const f = foldCageAtPlane(r.merged, 0);
          cage = f.cage; partner = f.partner;
          folded = { bands: uncovered.map((b) => +(b.length / mmPer).toFixed(1)) };
          reductionStats = { patchLoops: capped.loops.length, crumbs: r.dropped, mirrored: true, seamVertices: f.seamVertices, foldedBands: folded.bands, foldPeaks: f.peaks, foldDropped: f.dropped, foldRounds: f.rounds, foldMoved: +(f.moved / mmPer).toFixed(2) };
        }
      }
    }
    const { pieces, totalArea0, quadArea } = r;
    /* the openings, cut out of the whole cage against the whole capped patch */
    if (opts.cutOpenings !== false) {
      const cut = cutOpenings(cage, { vertices: capped.vertices, faces: capped.faces, boundaryLoops: capped.loops }, { capFrom: patch.faces.length, caps: capped.caps, partner, relaxPasses: opts.relaxPasses, snapEdges: opts.snapEdges, follow: opts.follow, smoothLoops: opts.smoothLoops });
      cage = cut.cage;
      reductionStats = { ...(reductionStats || {}), cutRemoved: cut.removed, cutSnapped: cut.snapped, loops: cut.loops, rimMoved: cut.rimMoved };
      if (partner) partner = repairPartner(cage, partner, cut.kept);
    }
    /* the interior faired: QuadriFlow's quads run regular over open skin and
     * crowd where the flow turns — the nose's bridge and tip — so each
     * interior vertex is drawn toward its neighbours' centroid along the
     * surface and put back on the patch. The rim keeps its relaxed place
     * and the seam its x = 0. */
    if (opts.fair !== false) {
      /* seated on the CAPPED patch: over a nostril too small to cut the
       * cage bridges the hole, and the bridge is the cap */
      const seam = partner ? new Set([...partner].map((p, i) => (p === i ? i : -1)).filter((i) => i >= 0)) : null;
      const f = fairCage(cage, { vertices: capped.vertices, faces: capped.faces }, { passes: opts.fairPasses ?? 5, rate: 0.5, seam });
      reductionStats = { ...(reductionStats || {}), fairMoved: f.moved };
    }
    /* exact again: the fairing seats each half on the whole patch, which is
     * symmetric to well under a millimetre and not exactly; every pair is
     * averaged by index and the seam held on the plane */
    /* a vertex that is its own partner is a seam vertex when it is at the
     * plane; one whose twin is gone keeps its place */
    const seamTol = cage.faces.length ? 0.25 * cage.faces.reduce((t, q) => { const a = cage.vertices[q[0]], b = cage.vertices[q[1]]; return t + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }, 0) / cage.faces.length : 0;
    if (partner) {
      const V = cage.vertices;
      for (let i = 0; i < V.length; i++) {
        const j = partner[i];
        if (j === i) { if (Math.abs(V[i][0]) < seamTol) V[i][0] = 0; continue; }
        if (j < i) continue;
        const ax = (V[i][0] - V[j][0]) / 2, ay = (V[i][1] + V[j][1]) / 2, az = (V[i][2] + V[j][2]) / 2;
        V[i] = [ax, ay, az]; V[j] = [-ax, ay, az];
      }
    }
    /* QuadriFlow puts the cage's vertices ON the surface, and a Catmull-Clark
     * limit surface lies inside its cage, so the mask came out under the skin
     * it was traced from. Move the interior control points until their limit
     * positions land back on the surface — the surface interpolates the
     * remeshed points instead of shrinking away from them.
     * ⚠ ONE PASS, NOT TWELVE. Measured on the full-face archetype at 200
     * quads, limit surface to skin: unrefitted median 0.74 mm, p90 2.10,
     * max 5.74; one pass 0.44 / 1.83 / 6.84; eight passes 0.54 / 2.29 /
     * 12.00. Forcing a coarse cage through every sample makes it ring
     * between them, and the worst point doubles while the median barely
     * moves. */
    if (opts.interpolate === true) {
      const targets = cage.vertices.map((v) => v.slice());
      const refit = refitCageToLimitTargets(cage, targets, { passes: opts.refitPasses ?? 1 });
      cage = { vertices: refit.vertices, faces: cage.faces, creases: cage.creases };
      /* the refit moves each side on its own; a mirrored cage is put back
       * exactly by averaging every pair, seam vertices held on the plane */
      if (partner) {
        const V = cage.vertices;
        for (let i = 0; i < V.length; i++) {
          const j = partner[i];
          if (j === i) { if (Math.abs(V[i][0]) < seamTol) V[i][0] = 0; continue; }
          if (j < i) continue;
          const ax = (V[i][0] - V[j][0]) / 2, ay = (V[i][1] + V[j][1]) / 2, az = (V[i][2] + V[j][2]) / 2;
          V[i] = [ax, ay, az]; V[j] = [-ax, ay, az];
        }
      }
      reductionStats = { ...(reductionStats || {}), refitMaxError: refit.maxError, refitMoved: refit.movedCount };
    }
    /* the openings, counted on the whole: loops less one rim per piece, on
     * the patch as asked and on the cage as delivered */
    const wholePieces = half && !folded ? splitPieces(patch).filter((pc) => pc.area >= Math.max(6 * quadArea, 0.01 * totalArea0)).length : pieces.length;
    /* an opening asked for is a capped loop of at least a quarter of a quad;
     * the specks the eraser leaves are not openings */
    const asked = capped.caps.filter((c) => c.area >= 0.25 * quadArea).length;
    const delivered = findQuadBoundaryLoops(cage.faces, cage.vertices.length).length - wholePieces;
    /* an opening big enough to cut (a cap of at least a quad) that is not
     * delivered has JOINED THE RIM: the band between them was under the
     * quads' reach and the remesh bridged nothing there (measured on a ring
     * mask: a 19 mm chin band at 7 mm quads, zero quads in it, one loop of
     * 134 where two were asked) — that is not "too small to cut" */
    const cuttable = capped.caps.filter((c) => c.area >= quadArea).length;
    const joined = Math.max(0, Math.min(cuttable, asked - Math.max(0, delivered)));
    reductionStats = {
      ...(reductionStats || {}),
      engine: 'quadriflow',
      steps: 1,
      openingsAsked: Math.max(0, asked), openings: Math.max(0, delivered), openingsJoined: joined, pieces: wholePieces,
      initialFaces: patch.faces.length,
      finalFaces: cage.faces.length
    };
  } else {
    // Default: Centina polychord simplification
    const centinaResult = simplifyQuadCageCentina(cage, {
      targetFaces,
      maxSteps: opts.maxSteps || 60,
      allowOpenChords: true,
      refit: opts.refit !== false
    });
    cage = centinaResult.cage;
    reductionStats = {
      engine: 'centina',
      steps: centinaResult.steps,
      initialFaces: centinaResult.initialFaces,
      finalFaces: centinaResult.finalFaces,
      driftRMS: centinaResult.driftRMS,
      driftMax: centinaResult.driftMax
    };
  }

  // Step 3: Validate cage against Unreason3D requirements
  const val = validateSuperBCage(cage, { corners: opts.corners !== false });
  if (!val.ok) {
    return {
      ok: false,
      reason: `Validation failed: ${val.reason}`,
      cage
    };
  }
  if (val.cage) {
    /* the validator can weld vertices, and the partner map is by index */
    if (partner && val.cage.vertices.length !== cage.vertices.length) partner = partnerByMirror(val.cage);
    cage = val.cage;
  }

  // Step 4: Evaluate limit surface for preview
  const limitMesh = opts.evaluateLimit !== false
    ? evaluateSubDLimitMesh(cage, opts.limitLevels || 2)
    : null;

  // Step 4B: Evaluate OpenNURBS / Rhino B-spline patches if requested
  const nurbsPatches = opts.evaluateNurbs
    ? evaluateNurbsPatches(cage, opts)
    : null;

  // Step 5: Build export strings
  const unreasonDoc = buildUnreasonDocument(cage, {
    name: opts.name || 'Masq_SuperB_Mask',
    levels: opts.limitLevels || 2
  });

  const objContent = buildSuperBOBJ(cage, opts.name || 'masq_superb');

  return {
    ok: true,
    cage,
    partner,
    reductionStats,
    limitMesh,
    nurbsPatches,
    unreasonDoc,
    objContent,
    stats: {
      vertices: cage.vertices.length,
      faces: cage.faces.length,
      validation: val.stats
    }
  };
}
