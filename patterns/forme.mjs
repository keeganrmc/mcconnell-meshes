// THE FORME — the last's side, flattened, as a pattern maker draws it.
//
// A pattern is developed from the last by taping its side, marking the center
// lines and the feather edge, peeling the tape and pressing it flat: the
// inside forme and the outside forme, averaged along the center lines into
// the MEAN FORME the upper pattern is drafted on (Motawi, "Footwear Pattern
// Making and Last Design"). This file does the same to the mesh.
//
//   1. The side is cut from the last: everything not facing the ground (the
//      sole is the bottom pattern's), split along the center plane z = 0 into
//      two disks. Cuts are ISOLINES — every crossing edge is interpolated,
//      cut vertices keyed by edge so shared edges get one point.
//   2. Each disk is flattened by least-squares conformal mapping (Lévy et al.
//      2002): the map that comes closest to preserving angles, two vertices
//      pinned to fix the free rigid motion. A last's side is not developable,
//      so the flat forme cannot be exact; the per-face area ratio is reported
//      with the drawing, because a pattern maker cuts relief where the
//      stretch is, and needs to know where that is.
//   3. The flat forme is scaled so its area equals the area of the surface it
//      came from — the sensible fixed point for a conformal map — and the two
//      formes are aligned on their shared center-line points to average into
//      the mean forme.
//
// Pure functions over flat arrays; tools/verify/forme_geometry.mjs runs them
// against closed-form controls (a half cylinder to pi*r by L, a sheet to itself).

// Area-weighted vertex normals.
export function vertexNormals(positions, indices) {
  const n = positions.length / 3, out = new Float64Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { out[i] += nx; out[i + 1] += ny; out[i + 2] += nz; }
  }
  for (let i = 0; i < n; i++) { const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) || 1; out[i * 3] /= l; out[i * 3 + 1] /= l; out[i * 3 + 2] /= l; }
  return out;
}

/* Keep the part of the mesh where a per-vertex scalar is >= 0. Triangles
   crossing zero are clipped at the interpolated crossing; the cut vertex on a
   shared edge is made once. Returns { positions, indices, cut } where `cut`
   flags each new vertex that lies on the isoline. */
export function clipMeshByScalar(positions, indices, values) {
  const outPos = [], outIdx = [], cutFlag = [];
  const vmap = new Map(), emap = new Map();
  const keep = (i) => {
    let n = vmap.get(i);
    if (n === undefined) { n = outPos.length / 3; outPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); cutFlag.push(false); vmap.set(i, n); }
    return n;
  };
  const cut = (a, b) => {
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let n = emap.get(key);
    if (n === undefined) {
      const fa = values[a], fb = values[b], t = fa / (fa - fb);
      n = outPos.length / 3;
      outPos.push(positions[a * 3] + (positions[b * 3] - positions[a * 3]) * t, positions[a * 3 + 1] + (positions[b * 3 + 1] - positions[a * 3 + 1]) * t, positions[a * 3 + 2] + (positions[b * 3 + 2] - positions[a * 3 + 2]) * t);
      cutFlag.push(true);
      emap.set(key, n);
    }
    return n;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    const fv = v.map((i) => values[i]);
    const inCount = fv.filter((x) => x >= 0).length;
    if (inCount === 3) { outIdx.push(keep(v[0]), keep(v[1]), keep(v[2])); continue; }
    if (inCount === 0) continue;
    let r = 0;
    if (inCount === 1) while (fv[r] < 0) r++;
    else while (fv[r] < 0 || fv[(r + 2) % 3] >= 0) r++;
    const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3];
    if (inCount === 1) { outIdx.push(keep(a), cut(a, b), cut(c, a)); }
    else { const p = cut(b, c), q = cut(c, a), A = keep(a), B = keep(b); outIdx.push(A, B, p, A, p, q); }
  }
  return { positions: Float64Array.from(outPos), indices: Uint32Array.from(outIdx), cut: cutFlag };
}

// Weld vertices closer than tol and drop the triangles that collapse; a cut
// through near-coincident vertices otherwise leaves micro-holes.
export function weldVertices(positions, indices, tol = 1e-3) {
  const V = positions.length / 3, map = new Int32Array(V), cell = new Map(), outPos = [];
  const q = 1 / tol;
  for (let i = 0; i < V; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const k = `${Math.round(x * q)}_${Math.round(y * q)}_${Math.round(z * q)}`;
    let n = cell.get(k);
    if (n === undefined) { n = outPos.length / 3; outPos.push(x, y, z); cell.set(k, n); }
    map[i] = n;
  }
  const outIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = map[indices[t]], b = map[indices[t + 1]], c = map[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    outIdx.push(a, b, c);
  }
  return { positions: Float64Array.from(outPos), indices: Uint32Array.from(outIdx), map };
}

// The largest connected component by area; a mesh cut twice leaves islands.
export function largestComponent(positions, indices) {
  const T = indices.length / 3, V = positions.length / 3;
  const vertTris = Array.from({ length: V }, () => []);
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) vertTris[indices[t * 3 + e]].push(t);
  const comp = new Int32Array(T).fill(-1); const areas = [];
  for (let t0 = 0; t0 < T; t0++) {
    if (comp[t0] >= 0) continue;
    const id = areas.length; let area = 0; const stack = [t0]; comp[t0] = id;
    while (stack.length) { const t = stack.pop(); area += meshArea3D(positions, [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]); for (let e = 0; e < 3; e++) for (const u of vertTris[indices[t * 3 + e]]) if (comp[u] < 0) { comp[u] = id; stack.push(u); } }
    areas.push(area);
  }
  let best = 0; for (let i = 1; i < areas.length; i++) if (areas[i] > areas[best]) best = i;
  const keep = [];
  for (let t = 0; t < T; t++) if (comp[t] === best) keep.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
  // compact the vertex set
  const map = new Int32Array(V).fill(-1), outPos = [], outIdx = [];
  for (const i of keep) { if (map[i] < 0) { map[i] = outPos.length / 3; outPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); } outIdx.push(map[i]); }
  return { positions: Float64Array.from(outPos), indices: Uint32Array.from(outIdx), components: areas.length };
}

// Boundary half-edges (edges in one triangle), walked into loops BY EDGE: a
// bowtie vertex has two boundary edges leaving it, and a vertex-keyed walk
// covers half the boundary.
export function boundaryLoops(indices) {
  const count = new Map(), out = new Map();
  const key = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) { const a = indices[t + e], b = indices[t + (e + 1) % 3]; count.set(key(a, b), (count.get(key(a, b)) || 0) + 1); }
  let boundaryEdges = 0;
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) { const a = indices[t + e], b = indices[t + (e + 1) % 3]; if (count.get(key(a, b)) === 1) { boundaryEdges++; if (!out.has(a)) out.set(a, []); out.get(a).push(b); } }
  const used = new Set(), loops = [];
  for (const [a0, bs] of out) for (const b0 of bs) {
    const k0 = a0 * 4294967296 + b0;
    if (used.has(k0)) continue;
    const loop = [a0]; used.add(k0); let v = b0;
    while (v !== a0) {
      const cands = (out.get(v) || []).filter((w) => !used.has(v * 4294967296 + w));
      if (!cands.length) break;   // an open chain: recorded as it stands
      loop.push(v); used.add(v * 4294967296 + cands[0]); v = cands[0];
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  return { loops, boundaryEdges };
}
// The largest boundary loop as an ordered list of vertices, and the boundary
// edge count — equal for a disk.
export function boundaryLoop(indices) {
  const { loops, boundaryEdges } = boundaryLoops(indices);
  // A two-edge loop is a fold: two triangles on one edge with the same
  // orientation, both half-edges reading as boundary. Inside the surface, not
  // part of its outline.
  const foldEdges = loops.filter((l) => l.length < 3).reduce((n, l) => n + l.length, 0);
  return { loop: loops[0] || [], boundaryEdges, foldEdges, outlineEdges: boundaryEdges - foldEdges, loopCount: loops.length };
}

// Every boundary loop but the largest is a hole; a fan closes each so the
// patch is one disk.
export function fillHoles(positions, indices) {
  const { loops } = boundaryLoops(indices);
  if (loops.length <= 1) return { positions, indices, filled: 0 };
  const outPos = Array.from(positions), outIdx = Array.from(indices);
  for (const L of loops.slice(1)) {
    if (L.length < 3) continue;
    let cx = 0, cy = 0, cz = 0; for (const i of L) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
    const c = outPos.length / 3; outPos.push(cx / L.length, cy / L.length, cz / L.length);
    // the boundary half-edge a->b belongs to a triangle; the fan triangle across it runs b->a
    for (let k = 0; k < L.length; k++) { const a = L[k], b = L[(k + 1) % L.length]; outIdx.push(b, a, c); }
  }
  return { positions: Float64Array.from(outPos), indices: Uint32Array.from(outIdx), filled: loops.length - 1 };
}

/* Least-squares conformal map. pins: [i, j] vertex indices held at (0,0) and
   (d,0) with d their 3D distance. Returns Float64Array uv (2 per vertex).
   The normal equations are solved by conjugate gradient on the sparse system;
   the unknown count is 2V - 4. */
export function lscmFlatten(positions, indices, pins, opts = {}) {
  const V = positions.length / 3, T = indices.length / 3;
  const [pA, pB] = pins;
  const dAB = Math.hypot(positions[pB * 3] - positions[pA * 3], positions[pB * 3 + 1] - positions[pA * 3 + 1], positions[pB * 3 + 2] - positions[pA * 3 + 2]);
  const pinned = new Map([[pA, [0, 0]], [pB, [dAB, 0]]]);
  // unknown index: free vertex k -> u at 2k, v at 2k+1
  const freeIdx = new Int32Array(V).fill(-1); let nFree = 0;
  for (let i = 0; i < V; i++) if (!pinned.has(i)) freeIdx[i] = nFree++;
  // rows: for each triangle two rows (real, imaginary), each a list of (col, coef) plus a constant from pins
  const rows = [];
  for (let t = 0; t < T; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const p0 = P(i0), p1 = P(i1), p2 = P(i2);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const l1 = Math.hypot(...e1) || 1e-12;
    const X = e1.map((c) => c / l1);
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area2 = Math.hypot(...nrm);
    if (area2 < 1e-14) continue;
    const N = nrm.map((c) => c / area2);
    const Y = [N[1] * X[2] - N[2] * X[1], N[2] * X[0] - N[0] * X[2], N[0] * X[1] - N[1] * X[0]];
    const x = [0, l1, e2[0] * X[0] + e2[1] * X[1] + e2[2] * X[2]];
    const y = [0, 0, e2[0] * Y[0] + e2[1] * Y[1] + e2[2] * Y[2]];
    const s = 1 / Math.sqrt(area2);   // 1/sqrt(2A)
    const W = [[x[2] - x[1], y[2] - y[1]], [x[0] - x[2], y[0] - y[2]], [x[1] - x[0], y[1] - y[0]]];
    const verts = [i0, i1, i2];
    const re = { cols: [], coefs: [], c: 0 }, im = { cols: [], coefs: [], c: 0 };
    for (let j = 0; j < 3; j++) {
      const [wr, wi] = W[j].map((c) => c * s), vi = verts[j];
      // Re: wr*u - wi*v ; Im: wi*u + wr*v
      if (pinned.has(vi)) { const [u, v] = pinned.get(vi); re.c += wr * u - wi * v; im.c += wi * u + wr * v; }
      else { const k = freeIdx[vi]; re.cols.push(2 * k, 2 * k + 1); re.coefs.push(wr, -wi); im.cols.push(2 * k, 2 * k + 1); im.coefs.push(wi, wr); }
    }
    rows.push(re, im);
  }
  // normal equations A^T A x = -A^T c, solved by CG
  const n = 2 * nFree;
  const x = new Float64Array(n), r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  const applyAtA = (vec, out) => {
    out.fill(0);
    for (const row of rows) {
      let dot = 0;
      for (let k = 0; k < row.cols.length; k++) dot += row.coefs[k] * vec[row.cols[k]];
      for (let k = 0; k < row.cols.length; k++) out[row.cols[k]] += row.coefs[k] * dot;
    }
  };
  // b = -A^T c
  const b = new Float64Array(n);
  for (const row of rows) for (let k = 0; k < row.cols.length; k++) b[row.cols[k]] -= row.coefs[k] * row.c;
  // Jacobi preconditioner: diag(A^T A)
  const diag = new Float64Array(n);
  for (const row of rows) for (let k = 0; k < row.cols.length; k++) diag[row.cols[k]] += row.coefs[k] * row.coefs[k];
  const z = new Float64Array(n);
  // initial guess: nothing better than zero without a prior
  applyAtA(x, Ap);
  for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = r[i] / (diag[i] || 1); p[i] = z[i]; }
  let rz = 0; for (let i = 0; i < n; i++) rz += r[i] * z[i];
  // The conformal map is the start ARAP refines from; a tight stop buys nothing.
  const maxIter = opts.maxIter ?? Math.min(3000, 4 * n), tol = (opts.tol ?? 1e-8) * Math.sqrt(b.reduce((s2, v) => s2 + v * v, 0) || 1);
  let iters = 0;
  for (; iters < maxIter; iters++) {
    applyAtA(p, Ap);
    let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    let rn = 0; for (let i = 0; i < n; i++) rn += r[i] * r[i];
    if (Math.sqrt(rn) < tol) break;
    for (let i = 0; i < n; i++) z[i] = r[i] / (diag[i] || 1);
    let rzNew = 0; for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz; rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  const uv = new Float64Array(V * 2);
  for (let i = 0; i < V; i++) {
    if (pinned.has(i)) { const [u, v] = pinned.get(i); uv[i * 2] = u; uv[i * 2 + 1] = v; }
    else { const k = freeIdx[i]; uv[i * 2] = x[2 * k]; uv[i * 2 + 1] = x[2 * k + 1]; }
  }
  return { uv, iters };
}

/* As-rigid-as-possible refinement (Liu, Zhang, Gotsman, Gortler 2008). A
   conformal map keeps angles and shrinks a toe cap toward a point; ARAP
   alternates the per-triangle rotation that best fits the flat triangle to
   its 3D shape (local) with the flat vertices that best agree with all those
   placed triangles (global, one cotangent-Laplacian solve per axis), which is
   as close to isometric as the surface allows. */
export function arapRefine(positions, indices, uv0, opts = {}) {
  const V = positions.length / 3, T = indices.length / 3;
  const iterations = opts.iterations ?? 8;
  // per-triangle local frames and cotangent weights
  const local = new Float64Array(T * 6), cot = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const p0 = P(i0), p1 = P(i1), p2 = P(i2);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const l1 = Math.hypot(...e1) || 1e-12, X = e1.map((c) => c / l1);
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const a2 = Math.hypot(...nrm) || 1e-12, N = nrm.map((c) => c / a2);
    const Y = [N[1] * X[2] - N[2] * X[1], N[2] * X[0] - N[0] * X[2], N[0] * X[1] - N[1] * X[0]];
    const x = [0, l1, e2[0] * X[0] + e2[1] * X[1] + e2[2] * X[2]], y = [0, 0, e2[0] * Y[0] + e2[1] * Y[1] + e2[2] * Y[2]];
    for (let j = 0; j < 3; j++) { local[t * 6 + j * 2] = x[j]; local[t * 6 + j * 2 + 1] = y[j]; }
    // cot of the angle OPPOSITE each edge (edge j is between vertices j and j+1, opposite vertex j+2)
    for (let j = 0; j < 3; j++) {
      const a = (j + 2) % 3, b = j, c = (j + 1) % 3;
      const ux = x[b] - x[a], uy = y[b] - y[a], vx = x[c] - x[a], vy = y[c] - y[a];
      const cross = Math.abs(ux * vy - uy * vx) || 1e-12;
      // clamped positive: a negative cotangent makes the Laplacian indefinite
      // and the conjugate gradient diverges; a sliver's must not dominate
      cot[t * 3 + j] = Math.max(0.02, Math.min(5, (ux * vx + uy * vy) / cross));
    }
  }
  const uv = Float64Array.from(uv0);
  // Laplacian as an edge list with weights: for triangle edge (j, j+1) weight = cot opposite
  const pin = 0;
  const applyL = (vec, out) => {
    out.fill(0);
    for (let t = 0; t < T; t++) for (let j = 0; j < 3; j++) {
      const a = indices[t * 3 + j], b = indices[t * 3 + (j + 1) % 3], w = cot[t * 3 + j];
      const d = vec[a] - vec[b]; out[a] += w * d; out[b] -= w * d;
    }
    out[pin] += 1e6 * vec[pin];   // the pin, as a stiff spring at its current place
  };
  const solve = (b, x) => {
    // CG on the SPD Laplacian; warm start from x
    const n = V, r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    applyL(x, Ap); for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; p[i] = r[i]; }
    let rr = 0; for (let i = 0; i < n; i++) rr += r[i] * r[i];
    const tol = 1e-12 * Math.sqrt(b.reduce((s2, v) => s2 + v * v, 0) || 1);
    for (let it = 0; it < 3000 && Math.sqrt(rr) > tol; it++) {
      applyL(p, Ap); let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 0)) break;
      const alpha = rr / pAp;
      for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
      let rrn = 0; for (let i = 0; i < n; i++) rrn += r[i] * r[i];
      const beta = rrn / rr; rr = rrn;
      for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    }
  };
  const bu = new Float64Array(V), bv = new Float64Array(V), U = new Float64Array(V), Wv = new Float64Array(V);
  for (let it = 0; it < iterations; it++) {
    bu.fill(0); bv.fill(0);
    for (let t = 0; t < T; t++) {
      // local: best rotation from the local frame onto the current flat triangle (Procrustes on edge vectors)
      let sxx = 0, sxy = 0, syx = 0, syy = 0;
      for (let j = 0; j < 3; j++) {
        const a = indices[t * 3 + j], b = indices[t * 3 + (j + 1) % 3], w = cot[t * 3 + j];
        const lx = local[t * 6 + j * 2] - local[t * 6 + ((j + 1) % 3) * 2], ly = local[t * 6 + j * 2 + 1] - local[t * 6 + ((j + 1) % 3) * 2 + 1];
        const ux = uv[a * 2] - uv[b * 2], uy2 = uv[a * 2 + 1] - uv[b * 2 + 1];
        sxx += w * lx * ux; sxy += w * lx * uy2; syx += w * ly * ux; syy += w * ly * uy2;
      }
      // rotation angle maximising trace(R^T S): atan2(sxy - syx, sxx + syy)
      const ang = Math.atan2(sxy - syx, sxx + syy), c = Math.cos(ang), sn = Math.sin(ang);
      for (let j = 0; j < 3; j++) {
        const a = indices[t * 3 + j], b = indices[t * 3 + (j + 1) % 3], w = cot[t * 3 + j];
        const lx = local[t * 6 + j * 2] - local[t * 6 + ((j + 1) % 3) * 2], ly = local[t * 6 + j * 2 + 1] - local[t * 6 + ((j + 1) % 3) * 2 + 1];
        const rx = c * lx - sn * ly, ry = sn * lx + c * ly;
        bu[a] += w * rx; bu[b] -= w * rx; bv[a] += w * ry; bv[b] -= w * ry;
      }
    }
    for (let i = 0; i < V; i++) { U[i] = uv[i * 2]; Wv[i] = uv[i * 2 + 1]; }
    bu[pin] += 1e6 * U[pin]; bv[pin] += 1e6 * Wv[pin];
    solve(bu, U); solve(bv, Wv);
    for (let i = 0; i < V; i++) { uv[i * 2] = U[i]; uv[i * 2 + 1] = Wv[i]; }
  }
  return uv;
}

export function meshArea3D(positions, indices) {
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t] * 3, j = indices[t + 1] * 3, k = indices[t + 2] * 3;
    const ux = positions[j] - positions[i], uy = positions[j + 1] - positions[i + 1], uz = positions[j + 2] - positions[i + 2];
    const vx = positions[k] - positions[i], vy = positions[k + 1] - positions[i + 1], vz = positions[k + 2] - positions[i + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return a;
}
export function meshArea2D(uv, indices) {
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t] * 2, j = indices[t + 1] * 2, k = indices[t + 2] * 2;
    a += ((uv[j] - uv[i]) * (uv[k + 1] - uv[i + 1]) - (uv[k] - uv[i]) * (uv[j + 1] - uv[i + 1])) / 2;
  }
  return a;   // signed
}

// Per-face area ratio flat/3D after scaling, as the 5th and 95th percentile
// by 3D area, so a micro-sliver on a cut line cannot speak for the forme.
export function areaDistortion(positions, uv, indices) {
  const faces = [];
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t], j = indices[t + 1], k = indices[t + 2];
    const a3 = meshArea3D(positions, [i, j, k]);
    if (a3 < 1e-3) continue;
    faces.push({ a3, r: Math.abs(meshArea2D(uv, [i, j, k])) / a3 }); total += a3;
  }
  faces.sort((a, b) => a.r - b.r);
  let acc = 0, p5 = faces[0] ? faces[0].r : 1, p95 = faces[0] ? faces[0].r : 1, median = 1;
  for (const f of faces) { const before = acc; acc += f.a3; if (before < 0.05 * total && acc >= 0.05 * total) p5 = f.r; if (before < 0.5 * total && acc >= 0.5 * total) median = f.r; if (before < 0.95 * total && acc >= 0.95 * total) p95 = f.r; }
  return { min: p5, max: p95, median, p5, p95 };
}

/* The two side patches of a last. `positions`/`indices` is the closed last;
   `soleCos` is the normal.y below which a face is sole (-0.35: facing more
   than ~70 degrees down). Returns { medial, lateral }, each
   { positions, indices, cut, centerLine: [indices on z=0] }.
   medialSign is the sign of z on the medial side. */
export function sidePatches(positions, indices, { soleCos = -0.35, medialSign = 1, smoothPasses = 3 } = {}) {
  const nrm = vertexNormals(positions, indices);
  const V = positions.length / 3;
  // vertex adjacency, for the smoothing and the flood
  const adj = Array.from({ length: V }, () => []);
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) { const a = indices[t + e], b = indices[t + (e + 1) % 3]; adj[a].push(b); adj[b].push(a); }
  // "facing down" as a smoothed field, so the feather isoline is one curve and
  // not a speckle of islands where a single normal dips
  let f = new Float64Array(V);
  for (let i = 0; i < V; i++) f[i] = nrm[i * 3 + 1] - soleCos;
  for (let pass = 0; pass < smoothPasses; pass++) {
    const g = new Float64Array(V);
    for (let i = 0; i < V; i++) { let s = f[i], n = 1; for (const j of adj[i]) { s += f[j]; n++; } g[i] = s / n; }
    f = g;
  }
  // The sole is one region: a flood from the most downward-facing vertex
  // through the facing-down set. Not from the lowest vertex, which can sit in
  // a fold sliver on the sole plane with its normal up. A downward patch not
  // connected to the sole stays with the side.
  let seed = 0; for (let i = 1; i < V; i++) if (f[i] < f[seed]) seed = i;
  const sole = new Uint8Array(V); const stack = [seed]; sole[seed] = 1;
  while (stack.length) { const i = stack.pop(); for (const j of adj[i]) if (!sole[j] && f[j] < 0) { sole[j] = 1; stack.push(j); } }
  const upper = new Float64Array(V);
  for (let i = 0; i < V; i++) upper[i] = sole[i] ? Math.min(f[i], -1e-3) : Math.max(f[i], 1e-3);
  const side = clipMeshByScalar(positions, indices, upper);
  const n2 = side.positions.length / 3;
  const zs = new Float64Array(n2);
  const make = (sign) => {
    for (let i = 0; i < n2; i++) zs[i] = side.positions[i * 3 + 2] * sign;
    const c = clipMeshByScalar(side.positions, side.indices, zs);
    const w = weldVertices(c.positions, c.indices, 0.05);
    const p = fillHoles(...(({ positions: pp, indices: ii }) => [pp, ii])(largestComponent(w.positions, w.indices)));
    // vertices on the center plane, by position. Cut vertices sit at z = 0
    // exactly; an ORIGINAL vertex a fraction of a millimetre off the plane is
    // kept by the clip and lies on the same boundary, so the band is 0.5mm.
    const centerLine = [];
    for (let i = 0; i < p.positions.length / 3; i++) if (Math.abs(p.positions[i * 3 + 2]) < 0.5) centerLine.push(i);
    return { positions: p.positions, indices: p.indices, centerLine };
  };
  return { medial: make(medialSign), lateral: make(-medialSign) };
}

/* Flatten one patch: pins are the two center-line vertices farthest apart
   (heel and toe ends of the center line). The flat result is scaled to the
   3D area and oriented so the center line runs along +u with the feather
   edge below it (v < 0), heel at the left. */
export function flattenPatch(patch) {
  const { positions, indices, centerLine } = patch;
  let pA = centerLine[0], pB = centerLine[0], best = -1;
  // farthest pair along the center line — by x, which is the last's length
  for (const i of centerLine) { if (positions[i * 3] < positions[pA * 3]) pA = i; if (positions[i * 3] > positions[pB * 3]) pB = i; }
  best = Math.hypot(positions[pB * 3] - positions[pA * 3], positions[pB * 3 + 1] - positions[pA * 3 + 1]);
  if (!(best > 0)) return null;
  const lscm = lscmFlatten(positions, indices, [pA, pB]);
  const iters = lscm.iters;
  // the conformal map is the start; ARAP takes it toward isometry
  let uv = lscm.uv;
  { const a3 = meshArea3D(positions, indices), a2 = meshArea2D(uv, indices); const s0 = Math.sqrt(a3 / Math.abs(a2)); for (let i = 0; i < uv.length; i++) uv[i] *= s0; }
  uv = arapRefine(positions, indices, uv, { iterations: 5 });   // 8 moves the 5th percentile by 0.005
  // scale to the 3D area (ARAP leaves it within a percent; exact by construction here)
  const a3 = meshArea3D(positions, indices), a2 = meshArea2D(uv, indices);
  const s = Math.sqrt(a3 / Math.abs(a2));
  const flip = a2 < 0 ? -1 : 1;   // keep the surface's own orientation
  for (let i = 0; i < uv.length; i += 2) { uv[i] *= s; uv[i + 1] *= s * flip; }
  // rigidly place: pin A at the origin, pin B on +u
  { const ax = uv[pA * 2], ay = uv[pA * 2 + 1], bx = uv[pB * 2] - ax, by = uv[pB * 2 + 1] - ay; const ang = -Math.atan2(by, bx), c = Math.cos(ang), sn = Math.sin(ang);
    for (let i = 0; i < uv.length; i += 2) { const x = uv[i] - ax, y = uv[i + 1] - ay; uv[i] = c * x - sn * y; uv[i + 1] = sn * x + c * y; } }
  // feather edge below the center line: reflect v if the boundary's feather
  // run sits above its center-line run. Judged on the two boundary runs, not
  // on the body: the pins' chord (heel back to toe tip) is low on the side,
  // and most of the body lies above it either way.
  const { loop, boundaryEdges, foldEdges, outlineEdges } = boundaryLoop(indices);
  const cl = new Set(centerLine);
  let feaV = 0, feaN = 0, clV = 0, clN = 0;
  for (const i of loop) { if (cl.has(i)) { clV += uv[i * 2 + 1]; clN++; } else { feaV += uv[i * 2 + 1]; feaN++; } }
  if (feaN && clN && feaV / feaN > clV / clN) for (let i = 1; i < uv.length; i += 2) uv[i] = -uv[i];
  const dist = areaDistortion(positions, uv, indices);
  return { uv, iters, area: a3, outline: loop.map((i) => [uv[i * 2], uv[i * 2 + 1]]), outlineIdx: loop, boundaryEdges, foldEdges, outlineEdges, distortion: dist, pins: [pA, pB] };
}

// Resample a polyline at n points by arc length.
export function resamplePolyline(pts, n) {
  if (pts.length < 2) return Array.from({ length: n }, () => pts[0] ? pts[0].slice() : [0, 0]);
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1] || 1, out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = total * k / (n - 1);
    while (j < L.length - 2 && L[j + 1] < s) j++;
    const t = (s - L[j]) / ((L[j + 1] - L[j]) || 1);
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}

/* Split a patch's flat outline into its center-line run and its feather run,
   both ordered heel -> toe. */
export function splitOutline(flat, patch) {
  const cl = new Set(patch.centerLine);
  const loop = flat.outlineIdx, N = loop.length;
  // find a center-line run: rotate so the loop starts at the first non-CL vertex after a CL run
  let start = 0;
  for (let i = 0; i < N; i++) if (cl.has(loop[i]) && !cl.has(loop[(i + 1) % N])) { start = (i + 1) % N; break; }
  const rot = []; for (let i = 0; i < N; i++) rot.push(loop[(start + i) % N]);
  const feather = [], center = [];
  for (const i of rot) (cl.has(i) ? center : feather).push(i);
  const P = (i) => [flat.uv[i * 2], flat.uv[i * 2 + 1]];
  const asPts = (arr) => { const pts = arr.map(P); if (pts.length > 1 && pts[0][0] > pts[pts.length - 1][0]) pts.reverse(); return pts; };
  return { feather: asPts(feather), center: asPts(center) };
}

/* The mean forme: both formes aligned on their center lines (each already runs
   heel at u=0 along +u), feather edges resampled by arc length and averaged. */
export function meanForme(medialFlat, medialPatch, lateralFlat, lateralPatch, n = 200) {
  const m = splitOutline(medialFlat, medialPatch), l = splitOutline(lateralFlat, lateralPatch);
  const mf = resamplePolyline(m.feather, n), lf = resamplePolyline(l.feather, n);
  const mc = resamplePolyline(m.center, n), lc = resamplePolyline(l.center, n);
  const avg = (a, b) => a.map((p, i) => [(p[0] + b[i][0]) / 2, (p[1] + b[i][1]) / 2]);
  return { feather: avg(mf, lf), center: avg(mc, lc), medial: m, lateral: l };
}

/* ════════════════════════════════════════════════════════════════════
   PRINCIPAL LENGTH STRAINS & MATERIAL FORMABILITY
   ════════════════════════════════════════════════════════════════════ */

export function principalStrains(positions, faces, uv, opts = {}) {
  const threshold = opts.threshold ?? 0.01;
  const n = faces.length / 3;
  const s1 = new Float64Array(n), s2 = new Float64Array(n), area = new Float64Array(n);
  const flipped = new Uint8Array(n);
  const err = new Float64Array(n);
  let flippedCount = 0, maxS1 = -Infinity, minS2 = Infinity;
  const det = new Float64Array(n);

  const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const U = (i) => [uv[i * 2], uv[i * 2 + 1]];

  for (let f = 0; f < n; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    const p0 = P(a), p1 = P(b), p2 = P(c);
    const uv0 = U(a), uv1 = U(b), uv2 = U(c);

    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const l1 = Math.hypot(...e1) || 1e-12;
    const X = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    const nrm = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const area2 = Math.hypot(...nrm);
    if (area2 < 1e-14) {
      s1[f] = s2[f] = err[f] = NaN;
      continue;
    }
    const N = [nrm[0] / area2, nrm[1] / area2, nrm[2] / area2];
    const Y = [
      N[1] * X[2] - N[2] * X[1],
      N[2] * X[0] - N[0] * X[2],
      N[0] * X[1] - N[1] * X[0],
    ];

    const x2 = l1, x3 = e2[0] * X[0] + e2[1] * X[1] + e2[2] * X[2];
    const y3 = e2[0] * Y[0] + e2[1] * Y[1] + e2[2] * Y[2];

    const du1 = uv1[0] - uv0[0], dv1 = uv1[1] - uv0[1];
    const du2 = uv2[0] - uv0[0], dv2 = uv2[1] - uv0[1];

    if (!(y3 > 0 && x2 > 0)) {
      s1[f] = s2[f] = err[f] = NaN;
      continue;
    }

    const i00 = 1 / x2, i01 = -x3 / (x2 * y3), i11 = 1 / y3;
    const j00 = du1 * i00, j01 = du1 * i01 + du2 * i11;
    const j10 = dv1 * i00, j11 = dv1 * i01 + dv2 * i11;

    const E = (j00 + j11) / 2, F_ = (j00 - j11) / 2;
    const G = (j10 + j01) / 2, H = (j10 - j01) / 2;
    const Q = Math.hypot(E, H), R = Math.hypot(F_, G);
    s1[f] = Q + R;
    s2[f] = Math.abs(Q - R);
    area[f] = 0.5 * area2;

    det[f] = j00 * j11 - j01 * j10;
    err[f] = Math.max(Math.abs(s1[f] - 1), Math.abs(s2[f] - 1));
    if (s1[f] > maxS1) maxS1 = s1[f];
    if (s2[f] < minS2) minS2 = s2[f];
  }

  // a flip is a face turned against the map's OWN orientation: an LSCM map may mirror a whole side, and
  // det <= 0 then marked 8393 of 8466 lateral faces flipped, failing every material on every last
  let orient = 0;
  for (let f = 0; f < n; f++) if (det[f] === det[f]) orient += det[f] * area[f];
  const sgn = orient < 0 ? -1 : 1;
  for (let f = 0; f < n; f++) if (det[f] === det[f] && area[f] > 0 && !(det[f] * sgn > 0)) { flipped[f] = 1; flippedCount++; }
  let sumErr = 0, totalArea = 0, overArea = 0, maxErr = -Infinity;
  for (let f = 0; f < n; f++) {
    const e = err[f];
    if (e !== e) continue;
    if (e > maxErr) maxErr = e;
    sumErr += e * area[f];
    totalArea += area[f];
    if (e > threshold) overArea += area[f];
  }

  return {
    s1, s2, area, flipped, flippedCount,
    summary: {
      maxStretch: maxErr === -Infinity ? null : Math.max(0, maxS1 - 1),
      maxCompression: minS2 === Infinity ? null : Math.max(0, 1 - minS2),
      max: maxErr === -Infinity ? null : maxErr,
      mean: totalArea > 0 ? sumErr / totalArea : null,
      percentAreaOver: totalArea > 0 ? (100 * overArea / totalArea) : null,
      threshold,
    },
  };
}

// synthetic or naturally occurring materials only (no animal products); the limits are working
// estimates, not from a standard
export const FOOTWEAR_MATERIALS = {
  woven_canvas: {
    label: 'Cotton canvas (10oz)',
    desc: 'Orthogonal warp/weft textile with shear lock',
    maxTension: 0.05,
    maxCompression: 0.04,
    maxAreaRel: 0.06,
  },
  knit_mesh: {
    label: 'Engineered knit mesh',
    desc: 'Biaxially compliant athletic upper textile',
    maxTension: 0.35,
    maxCompression: 0.25,
    maxAreaRel: 0.30,
  },
  neoprene: {
    label: 'Neoprene (2.0mm)',
    desc: 'Foam-core lining & collar padding',
    maxTension: 0.45,
    maxCompression: 0.35,
    maxAreaRel: 0.40,
  },
  tpu_film: {
    label: 'TPU skin (0.6mm)',
    desc: 'Hotmelt seamless structural film',
    maxTension: 0.25,
    maxCompression: 0.18,
    maxAreaRel: 0.20,
  },
};

export function materialFormabilityVerdict(strains, materialKey = 'tpu_film') {
  const mat = FOOTWEAR_MATERIALS[materialKey] || FOOTWEAR_MATERIALS.tpu_film;
  const { s1, s2, area, flipped } = strains;
  const n = s1.length;
  let totalArea = 0, failArea = 0, marginalArea = 0;
  const st = [], co = [];

  for (let f = 0; f < n; f++) {
    if (s1[f] !== s1[f]) continue;
    const a = area[f];
    totalArea += a;
    const stretch = s1[f] - 1;
    const compress = 1 - s2[f];
    st.push([stretch, a]); co.push([compress, a]);

    if (flipped && flipped[f]) {
      failArea += a;
      continue;
    }

    const stretchRatio = stretch / mat.maxTension;
    const compressRatio = compress / mat.maxCompression;
    const worstRatio = Math.max(stretchRatio, compressRatio);

    if (worstRatio > 1.0) {
      failArea += a;
    } else if (worstRatio > 0.8) {
      marginalArea += a;
    }
  }

  const fracFail = totalArea > 0 ? failArea / totalArea : 0;
  const fracMarginal = totalArea > 0 ? marginalArea / totalArea : 0;
  const fracOk = Math.max(0, 1 - fracFail - fracMarginal);

  // the readout's stretch is the area-weighted 95th percentile: the raw max read +20302% off one sliver
  const p95 = (arr) => { arr.sort((x, y) => x[0] - y[0]); let acc = 0; for (const [v, a] of arr) { acc += a; if (acc >= 0.95 * totalArea) return Math.max(0, v); } return arr.length ? Math.max(0, arr[arr.length - 1][0]) : 0; };
  const maxStretch = p95(st), maxCompress = p95(co);
  // over 5% of the area failing fails the forme; over 1% failing or 5% marginal needs darts or relief cuts
  // (1%, not any face: a sliver at a pinned corner always fails)
  const verdict = fracFail > 0.05 ? 'fail' : ((fracMarginal > 0.05 || fracFail > 0.01) ? 'marginal' : 'pass');

  return {
    material: materialKey,
    label: mat.label,
    verdict,
    fracOk,
    fracMarginal,
    fracFail,
    maxStretch,
    maxCompress,
    limits: mat,
  };
}

/* ════════════════════════════════════════════════════════════════════
   PATTERN OFFSET & CUTTING DIE DXF EXPORTER
   ════════════════════════════════════════════════════════════════════ */

// Offsets a closed 2D polygon outward by distMM.
export function offsetPolygon2D(pts, distMM) {
  const n = pts.length;
  if (n < 3 || Math.abs(distMM) < 1e-4) return pts.map(p => p.slice());

  // Determine polygon winding (shoelace formula)
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  const isCCW = area2 > 0;
  // For CCW, outward normal to edge (dx, dy) is (dy, -dx). For CW, (-dy, dx).
  const sign = isCCW ? 1 : -1;

  // Compute edge unit normals pointing outward
  const normals = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j][0] - pts[i][0];
    const dy = pts[j][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1e-6;
    normals.push([sign * dy / len, -sign * dx / len]);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const n1 = normals[prev], n2 = normals[i];
    const p = pts[i];

    // Line 1: n1 · X = n1 · p + distMM
    // Line 2: n2 · X = n2 · p + distMM
    const c1 = n1[0] * p[0] + n1[1] * p[1] + distMM;
    const c2 = n2[0] * p[0] + n2[1] * p[1] + distMM;

    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-6) {
      out.push([p[0] + distMM * (n1[0] + n2[0]) * 0.5, p[1] + distMM * (n1[1] + n2[1]) * 0.5]);
    } else {
      const ix = (c1 * n2[1] - c2 * n1[1]) / det;
      const iy = (n1[0] * c2 - n2[0] * c1) / det;

      // Miter limit check
      const miterDist = Math.hypot(ix - p[0], iy - p[1]);
      if (miterDist > Math.abs(distMM) * 2.5) {
        out.push([p[0] + distMM * n1[0], p[1] + distMM * n1[1]]);
        out.push([p[0] + distMM * n2[0], p[1] + distMM * n2[1]]);
      } else {
        out.push([ix, iy]);
      }
    }
  }
  return out;
}

// The seam allowance, or null with the reason: a vertex-miter offset turns inside out where a concave
// feature is narrower than twice the allowance (its walls swap and the path doubles back)
export function seamAllowanceOutline(src, mm) {
  const out = offsetPolygon2D(src, mm);
  const n = out.length;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const hits = (p, q, r, s) => {
    const d1 = cross(r, s, p), d2 = cross(r, s, q), d3 = cross(p, q, r), d4 = cross(p, q, s);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const on = (a, b, c) => Math.abs(cross(a, b, c)) < 1e-9 && Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
    return on(r, s, p) || on(r, s, q) || on(p, q, r) || on(p, q, s);
  };
  for (let i = 0; i < n; i++) {
    const p = out[i], q = out[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (hits(p, q, out[j], out[(j + 1) % n])) return { poly: null, reason: `The ${mm} mm seam allowance crosses itself where the outline narrows; left off.` };
    }
  }
  // with no miter split, an offset edge that runs against its source edge is an inversion
  if (n === src.length) for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    if ((out[k][0] - out[i][0]) * (src[k][0] - src[i][0]) + (out[k][1] - out[i][1]) * (src[k][1] - src[i][1]) < 0) return { poly: null, reason: `The ${mm} mm seam allowance turns inside out where the outline narrows; left off.` };
  }
  return { poly: out, reason: '' };
}

// Generate closed perimeter polygon from mean forme: center line forward, feather back
export function meanFormeClosedPerimeter(mean) {
  const poly = [];
  // Center line: heel -> toe
  for (let i = 0; i < mean.center.length; i++) {
    poly.push([mean.center[i][0], mean.center[i][1]]);
  }
  // Feather edge: toe -> heel (reverse)
  for (let i = mean.feather.length - 1; i >= 0; i--) {
    poly.push([mean.feather[i][0], mean.feather[i][1]]);
  }
  return poly;
}

// AutoCAD R12 DXF of the mean forme at 1:1 in mm: cut line, seam allowance, notches, grainline
export function formeDXF(mean, meta = {}, opts = {}) {
  const seamAllowanceMM = opts.seamAllowanceMM != null ? opts.seamAllowanceMM : 8.0;
  const cutPoly = meanFormeClosedPerimeter(mean);
  const seam = seamAllowanceMM > 0 ? seamAllowanceOutline(cutPoly, seamAllowanceMM) : { poly: null, reason: '' };
  const seamPoly = seam.poly;
  if (opts.report) opts.report.seam = seam;

  // Find landmarks for alignment notches
  const heelCenter = mean.center[0];
  const toeTip = mean.center[mean.center.length - 1];
  const featherMid = mean.feather[Math.floor(mean.feather.length * 0.5)];
  const centerMid = mean.center[Math.floor(mean.center.length * 0.5)];

  const notchLength = 4.0;
  const notches = [
    // Heel notch pointing inward along center line
    { x1: heelCenter[0], y1: heelCenter[1], x2: heelCenter[0] + notchLength, y2: heelCenter[1] },
    // Feather midpoint notch pointing inward
    { x1: featherMid[0], y1: featherMid[1], x2: featherMid[0], y2: featherMid[1] + notchLength },
    // Toe notch pointing backward
    { x1: toeTip[0], y1: toeTip[1], x2: toeTip[0] - notchLength, y2: toeTip[1] },
  ];

  // Grainline arrow along mid-body
  const grainStart = [heelCenter[0] + 40, (heelCenter[1] + featherMid[1]) * 0.5];
  const grainEnd = [toeTip[0] - 40, (toeTip[1] + featherMid[1]) * 0.5];

  let dxf = '';
  const line = (code, val) => { dxf += `${code}\n${val}\n`; };

  // HEADER
  line(0, 'SECTION');
  line(2, 'HEADER');
  line(9, '$ACADVER');
  line(1, 'AC1009'); // AutoCAD R12
  line(9, '$INSUNITS');
  line(70, 4);      // Millimeters
  line(0, 'ENDSEC');

  // TABLES (Layers)
  line(0, 'SECTION');
  line(2, 'TABLES');
  line(0, 'TABLE');
  line(2, 'LAYER');
  line(70, 6);

  const layers = [
    { name: '0', color: 7 },
    { name: 'CUT_FORME', color: 4 },       // Cyan = Die cut boundary
    { name: 'SEAM_ALLOWANCE', color: 2 },  // Yellow = Outer allowance
    { name: 'ALIGN_NOTCHES', color: 1 },   // Red = Slit/V-notches
    { name: 'GRAINLINE', color: 5 },       // Blue = Grain alignment
    { name: 'TEXT_ANNOTATION', color: 7 }, // White = Info
  ];

  for (const lyr of layers) {
    line(0, 'LAYER');
    line(2, lyr.name);
    line(70, 0);
    line(62, lyr.color);
    line(6, 'CONTINUOUS');
  }
  line(0, 'ENDTAB');
  line(0, 'ENDSEC');

  // ENTITIES
  line(0, 'SECTION');
  line(2, 'ENTITIES');

  // Helper: write 2D Polyline
  const writePolyline = (pts, layerName, closed = true) => {
    line(0, 'POLYLINE');
    line(8, layerName);
    line(66, 1);
    line(70, closed ? 1 : 0);
    line(10, 0.0);
    line(20, 0.0);
    line(30, 0.0);
    for (const p of pts) {
      line(0, 'VERTEX');
      line(8, layerName);
      line(10, p[0].toFixed(4));
      line(20, p[1].toFixed(4));
      line(30, 0.0);
    }
    line(0, 'SEQEND');
  };

  // 1. Cut Forme outline
  writePolyline(cutPoly, 'CUT_FORME', true);

  // 2. Seam Allowance outline
  if (seamPoly) {
    writePolyline(seamPoly, 'SEAM_ALLOWANCE', true);
  }

  // 3. Alignment Notches
  for (const ntc of notches) {
    line(0, 'LINE');
    line(8, 'ALIGN_NOTCHES');
    line(10, ntc.x1.toFixed(4));
    line(20, ntc.y1.toFixed(4));
    line(30, 0.0);
    line(11, ntc.x2.toFixed(4));
    line(21, ntc.y2.toFixed(4));
    line(31, 0.0);
  }

  // 4. Grainline shaft and arrowheads
  line(0, 'LINE');
  line(8, 'GRAINLINE');
  line(10, grainStart[0].toFixed(4));
  line(20, grainStart[1].toFixed(4));
  line(30, 0.0);
  line(11, grainEnd[0].toFixed(4));
  line(21, grainEnd[1].toFixed(4));
  line(31, 0.0);

  // Arrowhead right
  line(0, 'LINE');
  line(8, 'GRAINLINE');
  line(10, grainEnd[0].toFixed(4));
  line(20, grainEnd[1].toFixed(4));
  line(30, 0.0);
  line(11, (grainEnd[0] - 6).toFixed(4));
  line(21, (grainEnd[1] + 3).toFixed(4));
  line(31, 0.0);

  line(0, 'LINE');
  line(8, 'GRAINLINE');
  line(10, grainEnd[0].toFixed(4));
  line(20, grainEnd[1].toFixed(4));
  line(30, 0.0);
  line(11, (grainEnd[0] - 6).toFixed(4));
  line(21, (grainEnd[1] - 3).toFixed(4));
  line(31, 0.0);

  // 5. Annotations
  const textX = grainStart[0];
  const textY = grainStart[1] + 6;
  // ASCII only: R12 declares no codepage
  const label = `LASTFIRST FORME - ${meta.lastType || 'LAST'} - EU ${meta.size || '42'} - FIT ${meta.fitting || 'M'} - SA ${seamPoly ? seamAllowanceMM + 'mm' : 'none'}`;

  line(0, 'TEXT');
  line(8, 'TEXT_ANNOTATION');
  line(10, textX.toFixed(4));
  line(20, textY.toFixed(4));
  line(30, 0.0);
  line(40, 3.5); // Text height in mm
  line(1, label);

  line(0, 'ENDSEC');
  line(0, 'EOF');

  return dxf;
}

