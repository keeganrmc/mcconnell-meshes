// ONE BODY: the union of closed meshes as a single closed mesh.
//
// The pieces of a shoe are closed shells that touch and overlap. The midsole's inside lies ON the upper's outside, and
// tens of thousands of face pairs cross there. A mesh boolean on coincident surfaces is the textbook failure, so this
// does not cut triangles. It reads the union along rays:
//   1. a grid of spacing h; along each axis, a ray through every grid line of the other two;
//   2. each ray meets each mesh at exact points. The mesh's winding gives its inside intervals on the ray, the union
//      of the meshes' intervals is the body's, and a gap narrower than `weld` (default h/5) is closed, so pieces that
//      touch become one;
//   3. a node is inside when its x-ray's union says so; where an edge between nodes changes, the crossing is the
//      union's own end point on that edge's ray, so it is exact along every grid line;
//   4. surface nets: a vertex per boundary cell at the mean of its crossings, a quad across every crossed edge. The
//      result is closed (each crossed edge's quad shares its sides with its neighbours').
// Detail finer than h is lost; everything else stands where the pieces put it.
// Pure: no DOM; runs in a worker or in Node.

function bounds(meshes){
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let v = 0; v < m.P.length; v += 3) for (let a = 0; a < 3; a++){ const x = m.P[v + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
  return { lo, hi };
}

/**
 * meshes: [{ P, I }] closed and indexed. Returns { P: Float32Array, I: Uint32Array, stats }.
 * opts.h grid spacing (mm); opts.weld gap closed between touching pieces (mm, default h/5).
 */
export function unionSolid(meshes, opts = {}){
  const h = opts.h || 0.5, weld = opts.weld ?? h / 5, pad = 2;
  const t0 = Date.now();
  const { lo, hi } = bounds(meshes);
  const o = [lo[0] - pad * h, lo[1] - pad * h, lo[2] - pad * h];
  const n = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a]) / h) + 2 * pad + 1);
  const [nx, ny, nz] = n;
  // the rays sit on grid lines, nudged by a fraction of h that no mesh will share, so no ray runs through an edge or
  // a vertex of a triangle exactly (a hit counted twice or not at all would break the parity)
  const nudge = [0.000137 * h, 0.000291 * h, 0.000419 * h];
  // hits[axis] : per ray, a list of [t, mesh, sign]; rays indexed u + v * nu over the other two axes
  const others = [[1, 2], [0, 2], [0, 1]];
  const hits = [0, 1, 2].map((a) => { const [u, v] = others[a]; return new Array(n[u] * n[v]); });
  for (let mi = 0; mi < meshes.length; mi++){
    const { P, I } = meshes[mi];
    // the mesh's winding: an inward-wound mesh has its signs turned round
    let vol = 0; for (let t = 0; t < I.length; t += 3){ const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]); }
    const wind = vol < 0 ? -1 : 1;
    for (let t = 0; t < I.length; t += 3){
      const A = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], B = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], C = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
      const nrm = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
      for (let a = 0; a < 3; a++){
        const [u, v] = others[a];
        const den = nrm[a]; if (den === 0) continue;   // edge-on to this axis: no ray meets it
        const sign = (den > 0 ? 1 : -1) * wind;         // +1: the ray leaves the solid here; -1: it enters
        const umin = Math.min(A[u], B[u], C[u]), umax = Math.max(A[u], B[u], C[u]), vmin = Math.min(A[v], B[v], C[v]), vmax = Math.max(A[v], B[v], C[v]);
        const i0 = Math.max(0, Math.ceil((umin - o[u] - nudge[u]) / h)), i1 = Math.min(n[u] - 1, Math.floor((umax - o[u] - nudge[u]) / h));
        const j0 = Math.max(0, Math.ceil((vmin - o[v] - nudge[v]) / h)), j1 = Math.min(n[v] - 1, Math.floor((vmax - o[v] - nudge[v]) / h));
        for (let i = i0; i <= i1; i++){
          const pu = o[u] + i * h + nudge[u];
          for (let j = j0; j <= j1; j++){
            const pv = o[v] + j * h + nudge[v];
            // the 2D point-in-triangle by edge functions on (u, v)
            const e0 = (B[u] - A[u]) * (pv - A[v]) - (B[v] - A[v]) * (pu - A[u]);
            const e1 = (C[u] - B[u]) * (pv - B[v]) - (C[v] - B[v]) * (pu - B[u]);
            const e2 = (A[u] - C[u]) * (pv - C[v]) - (A[v] - C[v]) * (pu - C[u]);
            if (!((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0))) continue;
            // where the ray meets the triangle's plane
            const ta = A[a] - (nrm[u] * (pu - A[u]) + nrm[v] * (pv - A[v])) / den;
            const r = i + j * n[u];
            (hits[a][r] || (hits[a][r] = [])).push(ta, mi, sign);
          }
        }
      }
    }
  }
  const tRays = Date.now();
  // per ray: the union's intervals, as a flat sorted [s0, e0, s1, e1, …]
  const unionOf = (list) => {
    if (!list) return null;
    const ev = []; for (let k = 0; k < list.length; k += 3) ev.push([list[k], list[k + 1], list[k + 2]]);
    ev.sort((p, q) => p[0] - q[0] || q[2] - p[2]);   // at one t, entries before exits (a touch is not a gap)
    const depth = new Int32Array(meshes.length); let inside = 0; const iv = [];
    for (const [t, m, s] of ev){
      const was = depth[m] < 0 ? 1 : 0; depth[m] += s; const now = depth[m] < 0 ? 1 : 0;   // inside a mesh = entered more than left
      if (was === now) continue;
      const before = inside; inside += now - was;
      if (before === 0 && inside > 0) iv.push(t);
      else if (before > 0 && inside === 0) iv.push(t);
    }
    if (iv.length % 2) iv.pop();
    // close hairline gaps between touching pieces
    const out = []; for (let k = 0; k < iv.length; k += 2){ if (out.length && iv[k] - out[out.length - 1] < weld) out[out.length - 1] = iv[k + 1]; else out.push(iv[k], iv[k + 1]); }
    return out;
  };
  const U = [0, 1, 2].map((a) => hits[a].map(unionOf));
  // node occupancy from the x-rays
  const idx = (i, j, k) => i + nx * (j + ny * k);
  const occ = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++){
    const iv = U[0][j + k * ny]; if (!iv || !iv.length) continue;
    let s = 0;
    for (let i = 0; i < nx; i++){
      const x = o[0] + i * h; while (s < iv.length && iv[s + 1] < x) s += 2;
      if (s < iv.length && iv[s] <= x && x <= iv[s + 1]) occ[idx(i, j, k)] = 1;
    }
  }
  /* WELL-COMPOSED: surface nets is a manifold only where no cell face holds a checkerboard (two inside corners on a
     diagonal, two outside on the other) and no cell holds two opposite corners alone. Those are filled: the outside
     node of the pattern is set inside, so the thin neck it stood for becomes a body of one cell. Repeated until none
     is left (a fill can make a new pattern next door). */
  let fills = 0;
  // the cells worth reading: those with mixed corners (a pattern needs both kinds); a fill adds the cells round it
  const ncx = nx - 1, ncy = ny - 1, ncz = nz - 1;
  let todo = [];
  for (let k = 0; k < ncz; k++) for (let j = 0; j < ncy; j++) for (let i = 0; i < ncx; i++){
    const a0 = idx(i, j, k), v0 = occ[a0];
    if (occ[a0 + 1] !== v0 || occ[a0 + nx] !== v0 || occ[a0 + nx + 1] !== v0 || occ[a0 + nx * ny] !== v0 || occ[a0 + nx * ny + 1] !== v0 || occ[a0 + nx * ny + nx] !== v0 || occ[a0 + nx * ny + nx + 1] !== v0) todo.push(i + ncx * (j + ncy * k));
  }
  const c = new Int32Array(8), b = new Uint8Array(8);
  let pass = 0;
  for (; pass < 32 && todo.length; pass++){
    const again = new Set();
    for (const cell of todo){
      const i = cell % ncx, j = Math.floor(cell / ncx) % ncy, k = Math.floor(cell / (ncx * ncy));
      const a0 = idx(i, j, k);
      c[0] = a0; c[1] = a0 + 1; c[2] = a0 + nx; c[3] = a0 + nx + 1; c[4] = a0 + nx * ny; c[5] = c[4] + 1; c[6] = c[4] + nx; c[7] = c[6] + 1;
      for (let w = 0; w < 8; w++) b[w] = occ[c[w]];
      let changed = false;
      for (const [p, q, r, s2] of [[0, 1, 2, 3], [0, 1, 4, 5], [0, 2, 4, 6], [1, 3, 5, 7], [2, 3, 6, 7], [4, 5, 6, 7]]){
        if (b[p] === b[s2] && b[q] === b[r] && b[p] !== b[q]){ const z = b[p] === 0 ? [p, s2] : [q, r]; for (const w of z){ occ[c[w]] = 1; b[w] = 1; } changed = true; }
      }
      let sum = 0; for (let w = 0; w < 8; w++) sum += b[w];
      if (sum === 2 || sum === 6){
        for (const [p, q] of [[0, 7], [1, 6], [2, 5], [3, 4]]){
          if (sum === 2 && b[p] === 1 && b[q] === 1){ for (let w = 0; w < 8; w++) if (!b[w]){ occ[c[w]] = 1; break; } changed = true; break; }
          if (sum === 6 && b[p] === 0 && b[q] === 0){ occ[c[p]] = 1; changed = true; break; }
        }
      }
      if (changed){
        fills++;
        for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
          const ii = i + di, jj = j + dj, kk = k + dk; if (ii < 0 || jj < 0 || kk < 0 || ii >= ncx || jj >= ncy || kk >= ncz) continue;
          again.add(ii + ncx * (jj + ncy * kk));
        }
      }
    }
    todo = [...again];
  }
  const unresolved = todo.length;
  const tOcc = Date.now();
  // the crossing on an edge along axis a, from node (i,j,k) to the next along a: the union's end point on that ray
  const crossing = (a, i, j, k) => {
    const g = [i, j, k], [u, v] = others[a], iv = U[a][g[u] + g[v] * n[u]];
    const t0 = o[a] + g[a] * h, t1 = t0 + h;
    if (iv) for (let s = 0; s < iv.length; s++){ const t = iv[s]; if (t >= t0 && t <= t1) return t; }
    return t0 + h / 2;   // the rays disagree at a node by a rounding: the middle of the edge
  };
  // surface nets: a vertex per cell with mixed corners
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1), cidx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const VP = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1, 0], [2, 3, 0], [4, 5, 0], [6, 7, 0], [0, 2, 1], [1, 3, 1], [4, 6, 1], [5, 7, 1], [0, 4, 2], [1, 5, 2], [2, 6, 2], [3, 7, 2]];
  const vertexOf = (i, j, k) => {
    const c = cidx(i, j, k); if (cellV[c] >= 0) return cellV[c];
    let sx = 0, sy = 0, sz = 0, m = 0;
    for (const [p, q, a] of edges){
      const cp = corner[p], cq = corner[q];
      const op = occ[idx(i + cp[0], j + cp[1], k + cp[2])], oq = occ[idx(i + cq[0], j + cq[1], k + cq[2])];
      if (op === oq) continue;
      const base = [i + cp[0], j + cp[1], k + cp[2]], pt = [o[0] + base[0] * h, o[1] + base[1] * h, o[2] + base[2] * h];
      pt[a] = crossing(a, base[0], base[1], base[2]);
      sx += pt[0]; sy += pt[1]; sz += pt[2]; m++;
    }
    cellV[c] = VP.length / 6; VP.push(sx / m, sy / m, sz / m, i, j, k); return cellV[c];
  };
  const F = [];
  // every crossed grid edge (away from the border) makes a quad of the four cells around it
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++){
    const here = occ[idx(i, j, k)];
    for (let a = 0; a < 3; a++){
      const d = [0, 0, 0]; d[a] = 1;
      if (i + d[0] >= nx || j + d[1] >= ny || k + d[2] >= nz) continue;
      const there = occ[idx(i + d[0], j + d[1], k + d[2])]; if (here === there) continue;
      const [u, v] = others[a], g = [i, j, k], cs = [];
      for (const [du, dv] of [[0, 0], [-1, 0], [-1, -1], [0, -1]]){ const c = g.slice(); c[u] += du; c[v] += dv; cs.push(vertexOf(c[0], c[1], c[2])); }
      // wound so its normal leaves the solid: inside → outside along +a flips with the axis parity
      const out = here === 1;
      const flip = (a === 1) ? !out : out;
      if (flip) F.push(cs[0], cs[1], cs[2], cs[0], cs[2], cs[3]);
      else F.push(cs[0], cs[2], cs[1], cs[0], cs[3], cs[2]);
    }
  }
  /* VP holds [x, y, z, i, j, k] per vertex. Two cells can put their vertices at the SAME point (their crossings are
     the same few points). An STL has no connectivity, so a checker that welds coincident points would join them and
     read non-manifold edges. Each repeat is moved 1% of h toward its own cell's centre. */
  {
    const nvv = VP.length / 6, out = new Array(nvv * 3), seen = new Map(); let moved = 0;
    for (let v = 0; v < nvv; v++){
      let x = VP[6 * v], y = VP[6 * v + 1], z = VP[6 * v + 2];
      const key = Math.round(x / (h * 1e-3)) + ',' + Math.round(y / (h * 1e-3)) + ',' + Math.round(z / (h * 1e-3));
      if (seen.has(key)){ const cx = o[0] + (VP[6 * v + 3] + 0.5) * h, cy = o[1] + (VP[6 * v + 4] + 0.5) * h, cz = o[2] + (VP[6 * v + 5] + 0.5) * h; x += (cx - x) * 0.01; y += (cy - y) * 0.01; z += (cz - z) * 0.01; moved++; }
      else seen.set(key, v);
      out[3 * v] = x; out[3 * v + 1] = y; out[3 * v + 2] = z;
    }
    VP.length = 0; for (const q of out) VP.push(q);
    var nudged = moved;
  }
  // slivers the grid cut off a thin feature are dropped: shells under minShellMM3 (the body is one shell)
  const minShell = opts.minShellMM3 ?? 50;
  const nv = VP.length / 3, parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < F.length; t += 3){ const a = find(F[t]), b = find(F[t + 1]), c = find(F[t + 2]); if (a !== b) parent[a] = b; if (find(c) !== find(b)) parent[find(c)] = find(b); }
  const shellVol = new Map();
  for (let t = 0; t < F.length; t += 3){ const a = F[t] * 3, b = F[t + 1] * 3, c = F[t + 2] * 3; const v = (VP[a] * (VP[b + 1] * VP[c + 2] - VP[b + 2] * VP[c + 1]) - VP[a + 1] * (VP[b] * VP[c + 2] - VP[b + 2] * VP[c]) + VP[a + 2] * (VP[b] * VP[c + 1] - VP[b + 1] * VP[c])) / 6; const r = find(F[t]); shellVol.set(r, (shellVol.get(r) || 0) + v); }
  const keep = new Set([...shellVol].filter(([, v]) => Math.abs(v) >= minShell).map(([r]) => r));
  const dropped = shellVol.size - keep.size;
  const G = []; for (let t = 0; t < F.length; t += 3) if (keep.has(find(F[t]))) G.push(F[t], F[t + 1], F[t + 2]);
  F.length = 0; for (const x of G) F.push(x);
  const t1 = Date.now();
  return { P: Float32Array.from(VP), I: Uint32Array.from(F), stats: { fills, unresolved, nudged, droppedShells: dropped, h, grid: n, raysMs: tRays - t0, occMs: tOcc - tRays, meshMs: t1 - tOcc, ms: t1 - t0, triangles: F.length / 3 } };
}
