// An explicit shell over a triangle region of a substrate: inner sheet at
// `gap` along the normals (reversed), outer sheet at gap + wall, a rim strip
// on every boundary loop the caller does not keep open. Answers every frame
// of a stroke — no field is marched. Vertices are appended to the caller's
// table so several pieces can share one mesh.

import { boundaryLoops } from './meshcut.mjs';

// P, N: positions/normals of the refined substrate. use: per-triangle flag.
// gapOf(v), wallOf(v): mm. open(loop) → true to leave that loop unclosed.
// table: { out: number[], idx: number[] } appended in place.
export function regionShell(P, I, N, use, gapOf, wallOf, open, table) {
  const V = P.length / 3, T = I.length / 3;
  const { out, idx } = table;
  const push = (x, y, z) => { out.push(x, y, z); return out.length / 3 - 1; };
  const innerOf = new Int32Array(V).fill(-1), outerOf = new Int32Array(V).fill(-1);
  for (let t = 0; t < T; t++) if (use[t]) for (let e = 0; e < 3; e++) {
    const i = I[t * 3 + e];
    if (innerOf[i] >= 0) continue;
    const g = gapOf(i), w = wallOf(i);
    innerOf[i] = push(P[i * 3] + N[i * 3] * g, P[i * 3 + 1] + N[i * 3 + 1] * g, P[i * 3 + 2] + N[i * 3 + 2] * g);
    outerOf[i] = push(P[i * 3] + N[i * 3] * (g + w), P[i * 3 + 1] + N[i * 3 + 1] * (g + w), P[i * 3 + 2] + N[i * 3 + 2] * (g + w));
  }
  for (let t = 0; t < T; t++) if (use[t]) {
    idx.push(innerOf[I[t * 3]], innerOf[I[t * 3 + 2]], innerOf[I[t * 3 + 1]]);
    idx.push(outerOf[I[t * 3]], outerOf[I[t * 3 + 1]], outerOf[I[t * 3 + 2]]);
  }
  const loops = boundaryLoops(I, use);
  const kept = [];
  for (const L of loops) {
    const isOpen = open ? open(L) : false;
    kept.push({ loop: L, inner: L.map((i) => innerOf[i]), outer: L.map((i) => outerOf[i]), open: isOpen });
    if (isOpen) continue;
    for (let k = 0; k < L.length; k++) {
      const a = L[k], b = L[(k + 1) % L.length];
      idx.push(outerOf[b], outerOf[a], innerOf[a]); idx.push(outerOf[b], innerOf[a], innerOf[b]);
    }
  }
  return { innerOf, outerOf, loops: kept };
}

// A strip of quads between two rings of equal length that run the SAME way,
// wound so ring A's edges are used forward (A is the ring whose sheet used
// them backward).
export function stripBetween(A, B, idx) {
  const K = A.length;
  for (let k = 0; k < K; k++) {
    const a = A[k], b = A[(k + 1) % K], a2 = B[k], b2 = B[(k + 1) % K];
    idx.push(a, b, b2); idx.push(a, b2, a2);
  }
}

// Geodesic-ish distance from a set of seed vertices along the region's edges.
export function distanceFrom(P, I, use, seeds) {
  const V = P.length / 3;
  const adj = Array.from({ length: V }, () => []);
  for (let t = 0; t < I.length / 3; t++) if (use[t]) for (let e = 0; e < 3; e++) { const a = I[t * 3 + e], b = I[t * 3 + (e + 1) % 3]; adj[a].push(b); adj[b].push(a); }
  const d = new Float64Array(V).fill(Infinity);
  const q = [];
  for (const i of seeds) { d[i] = 0; q.push(i); }
  while (q.length) {
    const i = q.shift();
    for (const j of adj[i]) {
      const dj = d[i] + Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
      if (dj < d[j] - 1e-6) { d[j] = dj; q.push(j); }
    }
  }
  return d;
}
