// Cutting a triangle mesh along scalar isolines, keeping per-vertex attributes.
// The shoe pieces are regions of the last bounded by isolines — the feather
// line (facing-down field), a topline (height field), a painted coverage —
// and every region must share its boundary vertices with its neighbours so
// the pieces built on them close without welding. refineAtIsoline() inserts
// the crossing vertices ONCE into the whole mesh; regions are then triangle
// subsets read off the refined values.
//
// Frame: the app's. X along the last (heel −, toe +), Y up, Z across.
// Units: mm. positions Float32Array xyz, indices Uint32Array triangles.

export function vertexNormals(positions, indices) {
  const V = positions.length / 3, n = new Float32Array(V * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area-weighted
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  for (let i = 0; i < V; i++) {
    const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
    n[i * 3] /= l; n[i * 3 + 1] /= l; n[i * 3 + 2] /= l;
  }
  return n;
}

export function buildAdjacency(indices, V) {
  const adj = Array.from({ length: V }, () => []);
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3];
    if (!adj[a].includes(b)) adj[a].push(b);
    if (!adj[b].includes(a)) adj[b].push(a);
  }
  return adj;
}

// Laplacian-smoothed copy of a per-vertex field.
export function smoothField(f, adj, passes) {
  let cur = Float64Array.from(f);
  for (let p = 0; p < passes; p++) {
    const g = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) { let s = cur[i], n = 1; for (const j of adj[i]) { s += cur[j]; n++; } g[i] = s / n; }
    cur = g;
  }
  return cur;
}

// The feather field: negative on the sole, positive on the side, zero on the
// feather line. The sole is a VERTEX SET: the facing-down field (normal.y −
// soleCos, smoothed) flooded from the most downward vertex, then closed
// (dilated and eroded `closeRings` rings) so a groove across the underside —
// the Blocks last's seam between its ball and toe masses — stays inside the
// sole instead of pulling the feather line into a bay. The field itself is
// the signed hop distance from the set's boundary, so every crossing sits at
// an edge midpoint: a field read off the smoothed normals put crossings
// 0.008 mm from a vertex wherever it grazed zero, and those slivers folded
// the offset rings.
export function featherField(positions, indices, { soleCos = -0.35, smoothPasses = 5, closeRings = 3, soleSet = null } = {}) {
  const V = positions.length / 3;
  const nrm = vertexNormals(positions, indices);
  const adj = buildAdjacency(indices, V);
  let sole;
  if (soleSet) {
    // the sole given outright (a piece grown on another piece's floor): no flood, no closing
    sole = Uint8Array.from(soleSet);
    closeRings = 0;
  } else {
    const raw = new Float64Array(V);
    for (let i = 0; i < V; i++) raw[i] = nrm[i * 3 + 1] - soleCos;
    const f = smoothField(raw, adj, smoothPasses);
    let seed = 0; for (let i = 1; i < V; i++) if (f[i] < f[seed]) seed = i;
    sole = new Uint8Array(V); const stack = [seed]; sole[seed] = 1;
    while (stack.length) { const i = stack.pop(); for (const j of adj[i]) if (!sole[j] && f[j] < 0) { sole[j] = 1; stack.push(j); } }
  }
  const grow = (set, rings, into) => {
    let cur = set;
    for (let r = 0; r < rings; r++) {
      const nx = Uint8Array.from(cur);
      for (let i = 0; i < V; i++) if (cur[i] === into) for (const j of adj[i]) nx[j] = into;
      cur = nx;
    }
    return cur;
  };
  sole = grow(grow(sole, closeRings, 1), closeRings, 0);
  // any side pocket enclosed by the sole is sole too
  const seenSide = new Uint8Array(V);
  let bestComp = null, bestN = 0;
  const comps = [];
  for (let s0 = 0; s0 < V; s0++) {
    if (sole[s0] || seenSide[s0]) continue;
    const comp = [s0]; seenSide[s0] = 1;
    for (let k = 0; k < comp.length; k++) for (const j of adj[comp[k]]) if (!sole[j] && !seenSide[j]) { seenSide[j] = 1; comp.push(j); }
    comps.push(comp); if (comp.length > bestN) { bestN = comp.length; bestComp = comp; }
  }
  for (const comp of comps) if (comp !== bestComp) for (const i of comp) sole[i] = 1;
  // signed hop distance from the set boundary
  const out = new Float64Array(V).fill(0);
  const q = [];
  for (let i = 0; i < V; i++) for (const j of adj[i]) if (sole[i] !== sole[j]) { out[i] = sole[i] ? -1 : 1; q.push(i); break; }
  while (q.length) {
    const i = q.shift();
    for (const j of adj[i]) if (out[j] === 0 && sole[j] === sole[i]) { out[j] = out[i] + (sole[i] ? -1 : 1); q.push(j); }
  }
  for (let i = 0; i < V; i++) if (out[i] === 0) out[i] = sole[i] ? -1 : 1; // an isolated vertex
  return { field: out, normals: nrm, adj, sole };
}

// Insert the zero crossings of `values` as vertices, splitting every triangle
// the isoline crosses. Attributes (arrays of stride k per vertex) are
// interpolated at the crossings. Returns the refined mesh with `values` on it
// (exactly 0 at the inserted vertices) and `cut` flags.
export function refineAtIsoline(positions, indices, values, attrs = []) {
  const V = positions.length / 3;
  const pos = Array.from(positions), val = Array.from(values), cut = new Array(V).fill(false);
  const at = attrs.map((a) => ({ stride: a.stride, data: Array.from(a.data) }));
  const emap = new Map();
  const crossing = (a, b) => {
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let n = emap.get(key);
    if (n !== undefined) return n;
    const fa = val[a], fb = val[b], t = fa / (fa - fb);
    n = pos.length / 3;
    for (let k = 0; k < 3; k++) pos.push(positions[a * 3 + k] + (positions[b * 3 + k] - positions[a * 3 + k]) * t);
    for (const x of at) for (let k = 0; k < x.stride; k++) x.data.push(x.data[a * x.stride + k] + (x.data[b * x.stride + k] - x.data[a * x.stride + k]) * t);
    val.push(0); cut.push(true);
    emap.set(key, n);
    return n;
  };
  const out = [];
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    const s = v.map((i) => (val[i] > 0 ? 1 : val[i] < 0 ? -1 : 0));
    const pc = s.filter((x) => x > 0).length, nc = s.filter((x) => x < 0).length;
    if (pc === 0 || nc === 0) { out.push(...v); continue; }
    // rotate so the lone-signed vertex is first
    let lone = -1;
    for (let e = 0; e < 3; e++) { const o1 = s[(e + 1) % 3], o2 = s[(e + 2) % 3]; if (s[e] !== 0 && o1 !== s[e] && o2 !== s[e]) { lone = e; break; } }
    if (lone < 0) { out.push(...v); continue; } // one vertex on the line, two on one side: no split needed
    const a = v[lone], b = v[(lone + 1) % 3], c = v[(lone + 2) % 3];
    const sb = s[(lone + 1) % 3], sc = s[(lone + 2) % 3];
    const ab = sb === 0 ? b : crossing(a, b);
    const ac = sc === 0 ? c : crossing(a, c);
    out.push(a, ab, ac);
    if (ab !== b && ac !== c) { out.push(ab, b, c); out.push(ab, c, ac); }
    else if (ab !== b) out.push(ab, b, c);
    else if (ac !== c) out.push(b, c, ac);
  }
  // a unit attribute (a normal) interpolated across an edge is shorter than
  // one; a wall offset along it would be shorter by the same share
  for (let k = 0; k < at.length; k++) if (attrs[k].unit) {
    const d = at[k].data, st = at[k].stride;
    for (let i = V; i < d.length / st; i++) { let l = 0; for (let c = 0; c < st; c++) l += d[i * st + c] ** 2; l = Math.sqrt(l) || 1; for (let c = 0; c < st; c++) d[i * st + c] /= l; }
  }
  return {
    positions: Float32Array.from(pos), indices: Uint32Array.from(out), values: Float64Array.from(val), cut,
    attrs: at.map((x) => ({ stride: x.stride, data: Float32Array.from(x.data) })),
  };
}

// Side of each triangle against a refined field: +1, −1, or 0 (degenerate, on the line).
export function triangleSides(indices, values) {
  const T = indices.length / 3, side = new Int8Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let e = 0; e < 3; e++) { const v = values[indices[t * 3 + e]]; if (v > 0) s = 1; else if (v < 0) s = -1; }
    side[t] = s;
  }
  return side;
}

// Ordered boundary loops of a triangle subset (indices of the whole mesh;
// `use` is a per-triangle boolean). A directed edge with no twin inside the
// subset is a boundary edge; the edge after a→b is found by turning around b
// through the subset's triangles until the next twinless edge, so a vertex
// the region touches twice (a pinch) is walked through correctly instead of
// breaking the loop. Each loop runs the way the subset's triangles wind.
export function boundaryLoops(indices, use) {
  const key = (a, b) => a * 4294967296 + b;
  const triOf = new Map(); // directed edge → triangle
  for (let t = 0; t < indices.length / 3; t++) {
    if (use && !use[t]) continue;
    for (let e = 0; e < 3; e++) triOf.set(key(indices[t * 3 + e], indices[t * 3 + (e + 1) % 3]), t);
  }
  const isBoundary = (a, b) => triOf.has(key(a, b)) && !triOf.has(key(b, a));
  const third = (t, a, b) => { for (let e = 0; e < 3; e++) { const v = indices[t * 3 + e]; if (v !== a && v !== b) return v; } return -1; };
  const nextEdge = (a, b) => {
    // rotate around b: from triangle (a,b,c), the edge out of b is b→c
    let t = triOf.get(key(a, b)), from = a;
    for (let guard = 0; guard < 64; guard++) {
      const c = third(t, from, b);
      if (isBoundary(b, c)) return c;
      const t2 = triOf.get(key(c, b)); // twin triangle across b→c
      if (t2 === undefined) return -1;
      from = c; t = t2;
    }
    return -1;
  };
  const loops = [], seen = new Set();
  for (const k of triOf.keys()) {
    const a0 = Math.floor(k / 4294967296), b0 = k % 4294967296;
    if (!isBoundary(a0, b0) || seen.has(k)) continue;
    const loop = [a0]; let a = a0, b = b0; seen.add(k);
    for (let guard = 0; guard < 1e6; guard++) {
      loop.push(b);
      const c = nextEdge(a, b);
      if (c < 0) { loop.length = 0; break; }
      a = b; b = c;
      const kk = key(a, b);
      if (kk === k) break;
      if (seen.has(kk)) { loop.length = 0; break; }
      seen.add(kk);
    }
    if (loop.length >= 4) { loop.pop(); loops.push(loop); }
  }
  return loops;
}

// Arc-length parameter 0..1 around a closed loop, and its length.
export function loopArcParam(positions, loop) {
  const n = loop.length, seg = new Float64Array(n); let L = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % n] * 3;
    seg[i] = Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
    L += seg[i];
  }
  const u = new Float64Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { u[i] = acc / L; acc += seg[i]; }
  return { u, length: L };
}

// Closedness and orientation: every directed edge has exactly one twin.
export function meshClosure(indices) {
  const count = new Map(); const key = (a, b) => a * 4294967296 + b;
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const k = key(indices[t + e], indices[t + (e + 1) % 3]);
    count.set(k, (count.get(k) || 0) + 1);
  }
  let boundary = 0, doubled = 0, twinned = 0;
  for (const [k, c] of count) {
    if (c > 1) doubled++;
    const a = Math.floor(k / 4294967296), b = k % 4294967296;
    if (count.has(key(b, a))) twinned++; else boundary++;
  }
  return { boundaryEdges: boundary, doubledEdges: doubled, edges: twinned / 2 };
}

export function signedVolume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
       - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
       + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}

export function meshArea(positions, indices) {
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t] * 3, j = indices[t + 1] * 3, k = indices[t + 2] * 3;
    const ux = positions[j] - positions[i], uy = positions[j + 1] - positions[i + 1], uz = positions[j + 2] - positions[i + 2];
    const vx = positions[k] - positions[i], vy = positions[k + 1] - positions[i + 1], vz = positions[k + 2] - positions[i + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return a;
}
