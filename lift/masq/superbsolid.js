/* THE SUPERB THICKENED: one sheet made a closed SubD solid.
 *
 * The clearance sheet is the INNER face — it is already off the skin by the
 * gap and pushed out of the head — and the solid grows OUTWARD from it: an
 * outer sheet offset along the sheet's smoothed normals, and a rim wall of
 * `loops` quad bands closing every boundary loop. The rim edges carry a
 * crease weight from the two softening dials: the outer rim (the longest
 * loop of each piece) from `rimSoft`, every other loop (an opening) from
 * `holeSoft`. 0 is a hard crease — a cut edge; 1 is no crease — a full
 * round. Weights are Unreason's scale (SUPERB_CREASE_LEVEL_SCALE = 3, one
 * level of sharpness per unit, the Pixar rule Rhino's sharpness follows too,
 * so a weight travels to a .3dm as itself).
 *
 * Two guards, both measured rather than assumed:
 * - THE FOLD GUARD thins the offset where the sheet turns tighter than the
 *   thickness (an outward offset of a hollow shrinks it): a vertex's
 *   thickness is capped so no edge of the outer sheet shortens below half
 *   its inner length, and the cap is spread two rings so the wall thins as a
 *   slope and not a step. `stats.thickMin` says the thinnest wall built.
 * - NEVER INSIDE THE HEAD: the solid's limit surface is sampled against the
 *   head (`opts.head`, positions + normals), an intruding sample charges the
 *   nearest inner-sheet vertex, that vertex is pushed out along the head's
 *   normal and the solid rebuilt, up to `passes` times. Softening never pulls
 *   toward the head (a rounded rim bends the inner sheet toward the wall,
 *   which is outward), so intrusion here means a folded quad — an edit that
 *   turned a face over — and the push is the repair.
 */
import { findQuadBoundaryLoops, evaluateSubDLimitMesh } from './tosuperb.js';

export const CREASE_SCALE = 3;

const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

/* connected pieces of the sheet, by shared vertex */
function pieceOfFace(faces, nV) {
  const parent = new Int32Array(nV);
  for (let i = 0; i < nV; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const f of faces) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) parent[a] = b; }
  return (v) => find(v);
}

/* the sheet's boundary loops, each marked rim (the longest of its piece, by
 * perimeter) or hole */
export function classifyLoops(cage) {
  const V = cage.vertices;
  const loops = findQuadBoundaryLoops(cage.faces, V.length);
  const piece = pieceOfFace(cage.faces, V.length);
  const per = loops.map((L) => { let s = 0; for (let i = 0; i < L.length; i++) { const a = V[L[i]], b = V[L[(i + 1) % L.length]]; s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); } return s; });
  const longest = new Map();
  loops.forEach((L, i) => { const p = piece(L[0]); if (!longest.has(p) || per[longest.get(p)] < per[i]) longest.set(p, i); });
  return loops.map((L, i) => ({ loop: L, perimeter: per[i], rim: longest.get(piece(L[0])) === i }));
}

/* area-weighted vertex normals of a quad cage, smoothed `passes` one-ring
 * passes, unit length; `sign` turns them all */
function sheetNormals(cage, passes, sign) {
  const V = cage.vertices, n = V.length;
  const N = new Float64Array(n * 3);
  for (const q of cage.faces) {
    const a = V[q[0]], b = V[q[1]], c = V[q[2]], d = V[q[q.length - 1]];
    /* the cross of the diagonals is twice the quad's area normal */
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of q) { N[i * 3] += nx; N[i * 3 + 1] += ny; N[i * 3 + 2] += nz; }
  }
  const norm = (A) => { for (let i = 0; i < n; i++) { const l = Math.hypot(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]) || 1; A[i * 3] /= l; A[i * 3 + 1] /= l; A[i * 3 + 2] /= l; } };
  norm(N);
  if (passes > 0) {
    const ring = ringsOf(cage);
    for (let p = 0; p < passes; p++) {
      const M = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        let x = N[i * 3], y = N[i * 3 + 1], z = N[i * 3 + 2];
        for (const j of ring[i]) { x += N[j * 3]; y += N[j * 3 + 1]; z += N[j * 3 + 2]; }
        M[i * 3] = x; M[i * 3 + 1] = y; M[i * 3 + 2] = z;
      }
      norm(M); N.set(M);
    }
  }
  if (sign < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i];
  return N;
}

function ringsOf(cage) {
  const ring = cage.vertices.map(() => new Set());
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; ring[a].add(b); ring[b].add(a); }
  return ring;
}

/* a grid over points, answering the nearest within r */
function nearestIn(pts, cell) {
  const g = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
  const m = pts.length / 3;
  for (let i = 0; i < m; i++) { const k = key(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]); let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(i); }
  return (p, r) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell), reach = Math.ceil(r / cell);
    let best = -1, bd = r * r;
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
      const l = g.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
      for (const i of l) { const d = (pts[i * 3] - p[0]) ** 2 + (pts[i * 3 + 1] - p[1]) ** 2 + (pts[i * 3 + 2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  };
}

/* which way is out: the sheet's winding normal against the head's normal
 * under it, summed over the sheet. +1 when the winding already points away
 * from the head. */
function windingSign(cage, head, edge) {
  if (!head || !head.positions) return 1;
  const near = nearestIn(head.positions, edge * 3);
  const N = sheetNormals(cage, 0, 1);
  let s = 0;
  for (let i = 0; i < cage.vertices.length; i++) {
    const j = near(cage.vertices[i], edge * 8); if (j < 0) continue;
    s += N[i * 3] * head.normals[j * 3] + N[i * 3 + 1] * head.normals[j * 3 + 1] + N[i * 3 + 2] * head.normals[j * 3 + 2];
  }
  return s < 0 ? -1 : 1;
}

function meanEdge(cage) {
  const V = cage.vertices; let s = 0, n = 0;
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = V[q[k]], b = V[q[(k + 1) % q.length]]; s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); n++; }
  return n ? s / n : 0;
}

/* Per-vertex thickness under the fold guard: the largest t at which no
 * edge of the outer sheet shortens below `keep` of its inner length. For an
 * edge e = b - a with normals na, nb the outer edge is e + t(nb - na); its
 * length along e is |e| + t·e·(nb - na)/|e|. */
/* `ask` is the thickness wanted at each vertex (one number, or a per-vertex
 * array — the colours, a puff, a lift). The condition is the edge's own:
 * for e = b − a, ê = e/|e|, the outer edge's length along ê is
 * |e| + t_b·(n_b·ê) − t_a·(n_a·ê), and it may not fall under keep·|e|. It is
 * relaxed edge by edge to a fixed point, the vertex whose term shortens the
 * edge giving up exactly the deficit — so unequal walls that only TILT an
 * edge (a flat neighbour) are left alone: a 2 mm wall beside a 14 mm lift
 * stays 2, a 3 mm colour beside a 1.2 mm one stays 3 (a ratio cap spread
 * over two rings thins the dial's wall beside a lift, 1.23 under 2.0, and
 * every colour at its boundary). Edges under a tenth of the mean set no
 * cap: at a cut's corner an edge can be a sliver. */
export function guardedThickness(cage, N, ask, keep = 0.5, ref = null) {
  const V = cage.vertices, n = V.length;
  const want = typeof ask === 'number' ? new Float64Array(n).fill(ask) : Float64Array.from(ask);
  const t = Float64Array.from(want);
  const ring = ringsOf(cage);
  const edges = [];
  let meanL = 0;
  for (let a = 0; a < n; a++) for (const b of ring[a]) if (b > a) {
    const ex = V[b][0] - V[a][0], ey = V[b][1] - V[a][1], ez = V[b][2] - V[a][2];
    const L = Math.hypot(ex, ey, ez); if (L < 1e-12) continue;
    const pa = (ex * N[a * 3] + ey * N[a * 3 + 1] + ez * N[a * 3 + 2]) / L, pb = (ex * N[b * 3] + ey * N[b * 3 + 1] + ez * N[b * 3 + 2]) / L;
    edges.push([a, b, L, pa, pb]); meanL += L;
  }
  meanL = edges.length ? meanL / edges.length : 0;
  /* each pass reads the wall as it stood at the pass's start and writes the
   * least of what the rules ask, so the result does not depend on the order
   * the edges and faces are visited in (a mirrored trough came out 1.6 on one
   * side and 2.3 on the other when they were relaxed in place) */
  const next = new Float64Array(n);
  const A = (q, P) => { let x = 0, y = 0, z = 0; for (let k = 0; k < q.length; k++) { const p1 = P(q[k]), p2 = P(q[(k + 1) % q.length]); x += p1[1] * p2[2] - p1[2] * p2[1]; y += p1[2] * p2[0] - p1[0] * p2[2]; z += p1[0] * p2[1] - p1[1] * p2[0]; } return [x, y, z]; };
  const refs = cage.faces.map((q, fi) => { const ni = A(q, (i) => V[i]); const r = ref ? ref(fi) : null; return { ni, rn: r && (ni[0] * r[0] + ni[1] * r[1] + ni[2] * r[2]) > 0 ? r : ni }; });
  for (let pass = 0; pass < 64; pass++) {
    let moved = false;
    next.set(t);
    for (const [a, b, L, pa, pb] of edges) {
      if (L < 0.1 * meanL) continue;
      const along = L + t[b] * pb - t[a] * pa, deficit = keep * L - along;
      if (deficit <= 1e-12) continue;
      /* the terms that shorten: t_b when n_b leans back along ê, t_a when
       * n_a leans forward; the deficit is taken from them in proportion */
      const cb = pb < 0 ? -pb : 0, ca = pa > 0 ? pa : 0, sum = ca + cb;
      if (sum <= 1e-12) continue;
      if (cb > 0) next[b] = Math.min(next[b], Math.max(0, t[b] - deficit * (cb / sum) / cb));
      if (ca > 0) next[a] = Math.min(next[a], Math.max(0, t[a] - deficit * (ca / sum) / ca));
      moved = true;
    }
    /* and the face itself, seen from the head: an outer quad whose area
     * projected on the head's normal under it has turned over (under 2% of
     * its inner's) comes down at all four corners by a sixth. The head's
     * normal, not the quad's own — in a trough the outer quad stands up
     * vertical and doubles back over its neighbour while still facing its
     * inner; against the head it has turned over. Without a head, the
     * inner's. Turned over, not merely steep: a half-pillow's rim ring
     * stands nearly upright against the head and is no fold. */
    for (let fi = 0; fi < cage.faces.length; fi++) {
      const q = cage.faces[fi], { ni, rn } = refs[fi];
      const no = A(q, (i) => [V[i][0] + N[i * 3] * t[i], V[i][1] + N[i * 3 + 1] * t[i], V[i][2] + N[i * 3 + 2] * t[i]]);
      const dot = rn[0] * no[0] + rn[1] * no[1] + rn[2] * no[2], ii = rn[0] * ni[0] + rn[1] * ni[1] + rn[2] * ni[2];
      if (dot < 0.02 * ii) { for (const i of q) next[i] = Math.min(next[i], t[i] * 5 / 6); moved = true; }
    }
    t.set(next);
    if (!moved) break;
  }
  return t;
}

/* the solid from a sheet and its normals — the pure construction */
function buildSolid(cage, N, t, opts) {
  const V = cage.vertices, F = cage.faces, n = V.length;
  const loops = opts.loops | 0 || 1;
  const vertices = V.map((v) => v.slice());
  for (let i = 0; i < n; i++) vertices.push([V[i][0] + N[i * 3] * t[i], V[i][1] + N[i * 3 + 1] * t[i], V[i][2] + N[i * 3 + 2] * t[i]]);
  /* the inner sheet faces the head: its solid-outward side is against the
   * offset direction, so it is reversed when the winding already points out */
  const flip = opts.windingOut;
  const faces = [];
  for (const q of F) faces.push(flip ? q.slice().reverse() : q.slice());
  for (const q of F) { const o = q.map((v) => v + n); faces.push(flip ? o : o.reverse()); }
  /* rim columns: for a boundary vertex v, ring j (1..loops-1) is a new
   * vertex on the segment inner -> outer; ring `loops` is the outer vertex */
  const classified = classifyLoops(cage);
  const onLoop = new Map(); // boundary vertex -> { rim } of its loop
  for (const c of classified) for (const v of c.loop) onLoop.set(v, c);
  const column = new Map(); // v -> [v, r1, r2, ..., v + n]
  const columnOf = (v) => {
    let col = column.get(v);
    if (col) return col;
    col = [v];
    for (let j = 1; j < loops; j++) {
      const s = j / loops;
      vertices.push([V[v][0] + N[v * 3] * t[v] * s, V[v][1] + N[v * 3 + 1] * t[v] * s, V[v][2] + N[v * 3 + 2] * t[v] * s]);
      col.push(vertices.length - 1);
    }
    col.push(v + n);
    column.set(v, col);
    return col;
  };
  /* wall quads from each naked edge, wound against its owner face (as
   * finally wound), so the wall agrees with both sheets */
  const owners = new Map(); // "a_b" directed, as the inner sheet traverses it
  const count = new Map();
  for (const q of F) for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; count.set(edgeKey(a, b), (count.get(edgeKey(a, b)) || 0) + 1); }
  for (let fi = 0; fi < F.length; fi++) {
    const q = faces[fi];
    for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; if (count.get(edgeKey(a, b)) === 1) owners.set(`${a}_${b}`, true); }
  }
  const creases = {};
  for (const [k, w] of Object.entries(cage.creases || {})) { creases[k] = w; const [a, b] = k.split('_').map(Number); creases[edgeKey(a + n, b + n)] = w; }
  const wallStart = faces.length;
  let rimEdges = 0, holeEdges = 0;
  for (const key of owners.keys()) {
    const [a, b] = key.split('_').map(Number);
    const ca = columnOf(a), cb = columnOf(b);
    for (let j = 0; j < loops; j++) faces.push([cb[j], ca[j], ca[j + 1], cb[j + 1]]);
    const c = onLoop.get(a);
    const soft = c && !c.rim ? opts.holeSoft : opts.rimSoft;
    const w = (1 - Math.min(1, Math.max(0, soft ?? 0))) * CREASE_SCALE;
    if (c && !c.rim) holeEdges++; else rimEdges++;
    if (w > 1e-9) { creases[edgeKey(a, b)] = w; creases[edgeKey(a + n, b + n)] = w; }
  }
  return {
    cage: { vertices, faces, creases },
    inner: n, outer: n, wallStart, column,
    loops: classified, rimEdges, holeEdges,
  };
}

/* worst intrusion of the solid's limit surface into the head, charged to
 * inner-sheet vertices (an intruding sample charges the sheet vertex whose
 * column is nearest) */
function intrusionOf(solid, sheet, head, near, edge) {
  const lm = evaluateSubDLimitMesh(solid.cage, 1);
  const n = sheet.vertices.length;
  const per = new Float64Array(n), dir = new Float64Array(n * 3);
  const nearSheet = nearestIn(Float32Array.from(sheet.vertices.flat()), edge * 2);
  let worst = 0, worstAt = null;
  for (let i = 0; i < lm.positions.length / 3; i++) {
    const p = [lm.positions[i * 3], lm.positions[i * 3 + 1], lm.positions[i * 3 + 2]];
    /* as clearanceCage measures: skin NEAR the sample (the reference has no
     * skin under a capped nostril, and a wing 8 mm off read as 4 mm inside)
     * and FACING the way the surface does (a cavity wall is not the face) */
    const j = near(p, edge * 0.6); if (j < 0) continue;
    const dot = Math.abs(lm.normals[i * 3] * head.normals[j * 3] + lm.normals[i * 3 + 1] * head.normals[j * 3 + 1] + lm.normals[i * 3 + 2] * head.normals[j * 3 + 2]);
    if (dot < 0.3) continue;
    const d = (p[0] - head.positions[j * 3]) * head.normals[j * 3] + (p[1] - head.positions[j * 3 + 1]) * head.normals[j * 3 + 1] + (p[2] - head.positions[j * 3 + 2]) * head.normals[j * 3 + 2];
    if (d >= -1e-9) continue;
    const depth = -d;
    if (depth > worst) { worst = depth; worstAt = [head.positions[j * 3], head.positions[j * 3 + 1], head.positions[j * 3 + 2]]; }
    const c = nearSheet(p, edge * 6); if (c < 0) continue;
    if (depth > per[c]) { per[c] = depth; dir[c * 3] = head.normals[j * 3]; dir[c * 3 + 1] = head.normals[j * 3 + 1]; dir[c * 3 + 2] = head.normals[j * 3 + 2]; }
  }
  return { worst, per, dir, worstAt };
}

/**
 * thickenCage(sheet, thickness, opts) -> { cage, stats, ... }
 * sheet: { vertices, faces (quads), creases? } in any unit; thickness in it.
 * opts.loops        wall bands across the rim (1..)
 * opts.rimSoft      0..1 crease softening on each piece's outer rim
 * opts.holeSoft     0..1 crease softening on every opening
 * opts.smooth       one-ring passes on the offset direction (2)
 * opts.smoothMM     a kernel for those passes in the sheet's unit — the
 *                   puff's height — passes = (kernel / edge)², two at least
 * opts.head         { positions, normals } flat arrays, the skin to stay out of
 * opts.partner      mirror map by index (a push is mirrored)
 * opts.passes       never-inside passes (6)
 */
export function thickenCage(sheet, thickness, opts = {}) {
  /* one thickness, or one per sheet vertex (the colours); the nominal is
   * the dial's, for the readout */
  const perVertex = thickness && typeof thickness !== 'number' ? thickness : null;
  const T = perVertex ? (opts.nominal ?? (perVertex.reduce((a, b) => a + b, 0) / (perVertex.length || 1))) : +thickness;
  if (!(T > 0) || !sheet || !sheet.faces.length) return null;
  if (perVertex && perVertex.length !== sheet.vertices.length) return null;
  const ask = perVertex || T;
  const edge = meanEdge(sheet);
  const head = opts.head && opts.head.positions && opts.head.positions.length ? opts.head : null;
  const windingOut = (opts.windingOut ?? windingSign(sheet, head, edge)) > 0;
  /* the sheet is copied: a push edits the copy, the handles keep theirs */
  const work = { vertices: sheet.vertices.map((v) => v.slice()), faces: sheet.faces, creases: sheet.creases };
  const near = head ? nearestIn(head.positions, edge * 3) : null;
  /* the offset directions are averaged over a kernel the size of the wall
   * they carry: the cage's normals turn 17° across a 1.5 mm edge at an eye
   * ring's inner canthus, and against them the guard held a 12 mm puff at
   * 2.6 mm; over the puff's height they do not cross. Two passes at any
   * count without a kernel — a 28-quad nose averaged over 40 mm grew its
   * wall forward and the sides' printed wall fell to 0.44 of the ask. */
  const smoothPasses = opts.smoothMM > 0 && edge > 0 ? Math.min(64, Math.max(opts.smooth ?? 2, Math.round((opts.smoothMM / edge) ** 2))) : opts.smooth ?? 2;
  const build = () => {
    const N = sheetNormals(work, smoothPasses, windingOut ? 1 : -1);
    const ref = near && head.normals ? (fi) => { const q = work.faces[fi]; const c = [0, 0, 0]; for (const i of q) { c[0] += work.vertices[i][0] / q.length; c[1] += work.vertices[i][1] / q.length; c[2] += work.vertices[i][2] / q.length; } const j = near(c, edge * 3); return j >= 0 ? [head.normals[j * 3], head.normals[j * 3 + 1], head.normals[j * 3 + 2]] : null; } : null;
    const t = opts.guard === false ? (perVertex ? Float64Array.from(perVertex) : new Float64Array(work.vertices.length).fill(T)) : guardedThickness(work, N, ask, 0.5, ref);
    return { ...buildSolid(work, N, t, { loops: opts.loops, rimSoft: opts.rimSoft, holeSoft: opts.holeSoft, windingOut }), t };
  };
  let solid = build();
  let before = null, after = null, pushed = 0;
  if (near) {
    before = intrusionOf(solid, work, head, near, edge);
    after = before;
    const passes = opts.passes ?? 6;
    const ring = ringsOf(work);
    for (let pass = 0; pass < passes && after.worst > (opts.tolerance ?? 0); pass++) {
      const push = new Float64Array(work.vertices.length), along = new Float64Array(work.vertices.length * 3);
      for (let c = 0; c < work.vertices.length; c++) {
        if (!after.per[c]) continue;
        const amt = after.per[c] + edge * 0.05;
        if (amt > push[c]) { push[c] = amt; along[c * 3] = after.dir[c * 3]; along[c * 3 + 1] = after.dir[c * 3 + 1]; along[c * 3 + 2] = after.dir[c * 3 + 2]; }
        for (const r of ring[c]) if (0.5 * amt > push[r]) { push[r] = 0.5 * amt; along[r * 3] = after.dir[c * 3]; along[r * 3 + 1] = after.dir[c * 3 + 1]; along[r * 3 + 2] = after.dir[c * 3 + 2]; }
      }
      const partner = opts.partner;
      if (partner) for (let c = 0; c < push.length; c++) { const j = partner[c]; if (j > c) {
        if (push[c] >= push[j]) { push[j] = push[c]; along[j * 3] = -along[c * 3]; along[j * 3 + 1] = along[c * 3 + 1]; along[j * 3 + 2] = along[c * 3 + 2]; }
        else { push[c] = push[j]; along[c * 3] = -along[j * 3]; along[c * 3 + 1] = along[j * 3 + 1]; along[c * 3 + 2] = along[j * 3 + 2]; }
      } }
      for (let c = 0; c < push.length; c++) {
        if (!push[c]) continue;
        let nx = along[c * 3], ny = along[c * 3 + 1], nz = along[c * 3 + 2];
        if (partner && partner[c] === c) nx = 0;
        const m = Math.hypot(nx, ny, nz) || 1;
        const v = work.vertices[c];
        v[0] += nx / m * push[c]; v[1] += ny / m * push[c]; v[2] += nz / m * push[c];
        pushed++;
      }
      solid = build();
      after = intrusionOf(solid, work, head, near, edge);
    }
  }
  let thickMin = Infinity, thickMax = 0, thinned = 0;
  solid.t.forEach((x, i) => { if (x < thickMin) thickMin = x; if (x > thickMax) thickMax = x; if (x < (perVertex ? perVertex[i] : T) - 1e-9) thinned++; });
  return {
    cage: solid.cage,
    sheet: work, t: solid.t,
    inner: solid.inner, wallStart: solid.wallStart, column: solid.column,
    stats: {
      thickness: T, thickMin, thickMax, thinned,
      loops: solid.loops.length, rims: solid.loops.filter((l) => l.rim).length, holes: solid.loops.filter((l) => !l.rim).length,
      rimEdges: solid.rimEdges, holeEdges: solid.holeEdges,
      intrusionBefore: before ? before.worst : 0, intrusionAfter: after ? after.worst : 0, worstAt: after ? after.worstAt : null, pushed,
      faces: solid.cage.faces.length, vertices: solid.cage.vertices.length,
    },
  };
}

/* a closed manifold check: every edge in exactly two faces, each way once */
export function isClosedManifold(cage) {
  const dir = new Map();
  for (const q of cage.faces) for (let k = 0; k < q.length; k++) { const a = q[k], b = q[(k + 1) % q.length]; const key = `${a}_${b}`; if (dir.has(key)) return false; dir.set(key, true); }
  for (const key of dir.keys()) { const [a, b] = key.split('_'); if (!dir.has(`${b}_${a}`)) return false; }
  return true;
}

/* signed volume of a closed quad cage (positive when wound outward) */
export function cageVolume(cage) {
  const V = cage.vertices; let s = 0;
  for (const q of cage.faces) for (let k = 1; k + 1 < q.length; k++) {
    const a = V[q[0]], b = V[q[k]], c = V[q[k + 1]];
    s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return s / 6;
}
