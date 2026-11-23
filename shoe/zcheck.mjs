// A printed-shoe maker's submission checks, and the retarget onto their last.
//
// Pure geometry: no DOM, no three.js, runnable in Node. Units are mm. Two frames meet here:
//   APP frame       X heel→toe, Y up, Z across the foot (the frame every LastFirst mesh is built in)
//   TEMPLATE frame  X heel→toe with the heel at x≈0, Z up, Y across (the frame a template last ships in)
// toTemplateFrame/the retarget carry a shoe from the first to the second.
//
// The rules (numbers from the maker's published submission guidance): one object; watertight (every edge on exactly two faces);
// no self-intersection; overhangs ≤ 45° on the outside with the shoe tilted 120° toe-up; the inside within 0.5 mm
// of the template last; a collar surface that splits the shoe into exactly two parts.
//
// ⚠ A template last is someone else's licensed file. Nothing here keeps it: the caller passes it in for one call
// and the results are numbers and the shoe's own geometry.
import { buildBVH, buildMeshPseudonormals, bvhClosestPoint, bvhIntersect } from '../kernel/bvh.mjs';

/* ── mesh basics ───────────────────────────────────────────────────────── */
export function unindex(P, I){
  const out = new Float32Array(I.length * 3);
  for (let t = 0; t < I.length; t++){ const v = I[t] * 3; out[t * 3] = P[v]; out[t * 3 + 1] = P[v + 1]; out[t * 3 + 2] = P[v + 2]; }
  return out;
}
/** Weld coincident vertices (a hash grid at `tol` mm). Returns { P, I, map } with map[old] = new. */
export function weld(P, I, tol = 1e-4){
  const nv = P.length / 3, map = new Uint32Array(nv), ids = new Map(), out = [];
  const q = (x) => Math.round(x / tol);
  for (let v = 0; v < nv; v++){
    const k = q(P[3 * v]) + ',' + q(P[3 * v + 1]) + ',' + q(P[3 * v + 2]);
    let id = ids.get(k);
    if (id === undefined){ id = out.length / 3; ids.set(k, id); out.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); }
    map[v] = id;
  }
  const J = new Uint32Array(I.length); for (let i = 0; i < I.length; i++) J[i] = map[I[i]];
  return { P: Float64Array.from(out), I: J, map };
}
const edgeKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
/** Shells, naked and non-manifold edges, degenerate faces; on the welded mesh. */
export function meshStats(P0, I0){
  const { P, I } = weld(P0, I0);
  const nv = P.length / 3, nt = I.length / 3;
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edges = new Map(); let degenerate = 0;
  for (let t = 0; t < nt; t++){
    const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2];
    if (a === b || b === c || a === c){ degenerate++; continue; }
    for (const [x, y] of [[a, b], [b, c], [c, a]]){ const k = edgeKey(x, y); edges.set(k, (edges.get(k) || 0) + 1); const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; }
  }
  let naked = 0, nonManifold = 0;
  for (const n of edges.values()){ if (n === 1) naked++; else if (n > 2) nonManifold++; }
  const roots = new Set(); const used = new Uint8Array(nv);
  for (let i = 0; i < I.length; i++) used[I[i]] = 1;
  for (let v = 0; v < nv; v++) if (used[v]) roots.add(find(v));
  return { triangles: nt, vertices: nv, shells: roots.size, naked, nonManifold, degenerate, watertight: naked === 0 && nonManifold === 0 && degenerate === 0 };
}

/* ── self-intersection: triangle pairs that share no vertex, tested on a grid ── */
function triTri(p, q){
  // Möller's interval test, reduced: does triangle p (9 numbers) cross triangle q?
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const P = [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[6], p[7], p[8]]], Q = [[q[0], q[1], q[2]], [q[3], q[4], q[5]], [q[6], q[7], q[8]]];
  const n2 = cross(sub(Q[1], Q[0]), sub(Q[2], Q[0])), d2 = -dot(n2, Q[0]);
  const dp = P.map((v) => dot(n2, v) + d2), EPS = 1e-9;
  if ((dp[0] > EPS && dp[1] > EPS && dp[2] > EPS) || (dp[0] < -EPS && dp[1] < -EPS && dp[2] < -EPS)) return false;
  const n1 = cross(sub(P[1], P[0]), sub(P[2], P[0])), d1 = -dot(n1, P[0]);
  const dq = Q.map((v) => dot(n1, v) + d1);
  if ((dq[0] > EPS && dq[1] > EPS && dq[2] > EPS) || (dq[0] < -EPS && dq[1] < -EPS && dq[2] < -EPS)) return false;
  if (dp.every((x) => Math.abs(x) <= EPS)) return false;   // coplanar touching: not a crossing this check counts
  const D = cross(n1, n2);
  const interval = (T, d) => {
    // the segment where T's plane-crossing meets the line, as projections on D
    const pr = T.map((v) => dot(D, v)), out = [];
    for (let i = 0; i < 3; i++){ const j = (i + 1) % 3; if ((d[i] > EPS && d[j] < -EPS) || (d[i] < -EPS && d[j] > EPS)) out.push(pr[i] + (pr[j] - pr[i]) * d[i] / (d[i] - d[j])); else if (Math.abs(d[i]) <= EPS) out.push(pr[i]); }
    return out.length ? [Math.min(...out), Math.max(...out)] : null;
  };
  const a = interval(P, dp), b = interval(Q, dq);
  if (!a || !b) return false;
  return a[0] < b[1] - 1e-7 && b[0] < a[1] - 1e-7;
}
/** Count crossing triangle pairs (up to `cap`); faces sharing a welded vertex are skipped. */
export function selfIntersections(P0, I0, { cap = 200, cellMM = 3, pairs = null } = {}){
  const { P, I } = weld(P0, I0);
  const nt = I.length / 3, cells = new Map(), tri = (t) => [0, 1, 2].flatMap((k) => { const v = I[3 * t + k] * 3; return [P[v], P[v + 1], P[v + 2]]; });
  const box = new Float64Array(nt * 6);
  for (let t = 0; t < nt; t++){
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++){ const v = I[3 * t + k] * 3; for (let a = 0; a < 3; a++){ lo[a] = Math.min(lo[a], P[v + a]); hi[a] = Math.max(hi[a], P[v + a]); } }
    box.set([...lo, ...hi], t * 6);
    for (let x = Math.floor(lo[0] / cellMM); x <= Math.floor(hi[0] / cellMM); x++) for (let y = Math.floor(lo[1] / cellMM); y <= Math.floor(hi[1] / cellMM); y++) for (let z = Math.floor(lo[2] / cellMM); z <= Math.floor(hi[2] / cellMM); z++){
      const k = x + ',' + y + ',' + z; let l = cells.get(k); if (!l){ l = []; cells.set(k, l); } l.push(t);
    }
  }
  // each pair is tested once, in the one cell holding the low corner of the two boxes' overlap: no pair set to keep
  // (a set of every candidate pair passed JavaScript's size limit on a 3 M triangle lattice)
  let count = 0; const at = [];
  for (const [key, l] of cells){
    const [cx, cy, cz] = key.split(',').map(Number);
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++){
      const s = l[i], t = l[j];
      if (box[s * 6] > box[t * 6 + 3] || box[t * 6] > box[s * 6 + 3] || box[s * 6 + 1] > box[t * 6 + 4] || box[t * 6 + 1] > box[s * 6 + 4] || box[s * 6 + 2] > box[t * 6 + 5] || box[t * 6 + 2] > box[s * 6 + 5]) continue;
      const ox = Math.floor(Math.max(box[s * 6], box[t * 6]) / cellMM), oy = Math.floor(Math.max(box[s * 6 + 1], box[t * 6 + 1]) / cellMM), oz = Math.floor(Math.max(box[s * 6 + 2], box[t * 6 + 2]) / cellMM);
      if (ox !== cx || oy !== cy || oz !== cz) continue;
      const vs = [I[3 * s], I[3 * s + 1], I[3 * s + 2]]; if (vs.includes(I[3 * t]) || vs.includes(I[3 * t + 1]) || vs.includes(I[3 * t + 2])) continue;
      if (triTri(tri(s), tri(t))){ count++; if (at.length < 8) at.push(s); if (pairs) pairs.push(s, t); if (count >= cap) return { count, capped: true, at }; }
    }
  }
  return { count, capped: false, at };
}

/* ── overhang at the print tilt ─────────────────────────────────────────── */
/** The build-up direction, in the APP frame, for a shoe tilted `deg` toe-up about its width axis. */
export function buildUp(deg = 120){ const r = deg * Math.PI / 180; return [Math.sin(r), Math.cos(r), 0]; }
/**
 * Area (mm²) of OUTSIDE faces that face down steeper than `maxDeg` from the build direction, above the support
 * plane (the lowest point in print, plus `supportMM`). `skip` marks faces left out (the inside, the collar).
 */
export function overhang(P, I, { deg = 120, maxDeg = 45, supportMM = 1, skip = null, collect = false } = {}){
  const b = buildUp(deg), cosLim = Math.cos(maxDeg * Math.PI / 180);
  let hMin = Infinity; for (let v = 0; v < P.length; v += 3) hMin = Math.min(hMin, P[v] * b[0] + P[v + 1] * b[1] + P[v + 2] * b[2]);
  let area = 0, faces = 0; const list = collect ? [] : null;
  for (let t = 0; t < I.length / 3; t++){
    if (skip && skip[t]) continue;
    const a = I[3 * t] * 3, c = I[3 * t + 1] * 3, d = I[3 * t + 2] * 3;
    const ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz); if (!(len > 0)) continue;
    const down = -(nx * b[0] + ny * b[1] + nz * b[2]) / len;
    const h = ((P[a] + P[c] + P[d]) * b[0] + (P[a + 1] + P[c + 1] + P[d + 1]) * b[1] + (P[a + 2] + P[c + 2] + P[d + 2]) * b[2]) / 3;
    if (down > cosLim && h > hMin + supportMM){ area += len / 2; faces++; if (list) list.push(t); }
  }
  return { area, faces, list };
}

/* ── distance to a last ─────────────────────────────────────────────────── */
/** A closest-point query on a last (indexed mesh). Signed: + outside the last. */
export function lastQuery(P, I){
  // a last wound inward (negative volume) would flip every sign below: turn its faces round first
  let vol = 0;
  for (let t = 0; t < I.length; t += 3){ const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]); }
  if (vol < 0){ const J = Uint32Array.from(I); for (let t = 0; t < J.length; t += 3){ const x = J[t + 1]; J[t + 1] = J[t + 2]; J[t + 2] = x; } I = J; }
  const soup = unindex(P, I), bvh = buildBVH(soup), pn = buildMeshPseudonormals(soup);
  const q = (p, maxDistance = Infinity) => bvhClosestPoint(bvh, soup, p, { pseudonormals: pn, maxDistance });
  // the nearest surface along a line through p (both ways): { point, t } with t signed along dir, or null
  q.along = (p, dir, reach) => {
    const f = bvhIntersect(bvh, soup, p, dir, reach), b = bvhIntersect(bvh, soup, p, [-dir[0], -dir[1], -dir[2]], reach);
    const best = f && (!b || f.t <= b.t) ? { t: f.t } : b ? { t: -b.t } : null;
    return best ? { t: best.t, point: [p[0] + dir[0] * best.t, p[1] + dir[1] * best.t, p[2] + dir[2] * best.t] } : null;
  };
  return q;
}
/**
 * The shoe's inside against a last: every shoe vertex within `band` mm of the last is read as the inside; reports
 * the furthest off the last and the deepest into it, and how many stand past `tol`.
 */
export function fitToLast(shoeP, lastQ, { band = 3, tol = 0.5, inside = null } = {}){
  let n = 0, out = 0, inn = 0, over = 0; const ds = [];
  for (let v = 0; v < shoeP.length; v += 3){
    if (inside && !inside[v / 3]) continue;   // a thin wall's OUTSIDE is within the band too: read the inside sheet only
    const r = lastQ([shoeP[v], shoeP[v + 1], shoeP[v + 2]], band); if (!r) continue;
    const s = r.signed ? r.signedDistance : r.distance; n++; ds.push(Math.abs(s));
    if (s > out) out = s; if (-s > inn) inn = -s; if (Math.abs(s) > tol) over++;
  }
  ds.sort((a, b) => a - b);
  return { inside: n, maxOff: out, maxInto: inn, over, p95: ds.length ? ds[Math.floor(0.95 * (ds.length - 1))] : 0, pass: n > 0 && over === 0 };
}

/* ── sheets: inside, outside, collar ───────────────────────────────────── */
/**
 * Label each face of a shell around a last:
 *   1 the INSIDE   (near the last and facing it)
 *   2 the OUTSIDE  (facing away and off it)
 *   3 the COLLAR   (everything between: the rim band around every opening)
 * The inside grows from faces within `innerMM` of the last whose normal faces the last; the outside from faces whose
 * normal agrees with the last's outward normal. What neither reaches is the collar. `split` counts the parts left
 * when the collar is taken away: the maker wants exactly 2.
 */
export function sheets(P0, I0, lastQ, { innerMM = 1.2, collarMM = 10 } = {}){
  const { P, I } = weld(P0, I0);
  const nt = I.length / 3, lab = new Uint8Array(nt);
  // the shell's own winding: inward (negative volume) turns every "facing" test round
  let vol = 0; for (let t = 0; t < I.length; t += 3){ const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3; vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]); }
  const sgn = vol < 0 ? -1 : 1;
  const nrm = (t) => { const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3; const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]; const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1; return [n[0] / l, n[1] / l, n[2] / l, [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3]]; };
  /* INSIDE: on the last (within innerMM) and facing it. COLLAR: grown from the inside's own edge through faces that
     cross the wall (their normal within ~45° of square to the last's) and stay within collarMM of the last. That is
     the rim band at every opening. OUTSIDE: the rest. A thick sole's sides are not near the inside's edge and do not
     become collar (reading "not facing the last" as collar took 450 k faces of a joined shoe). */
  const agreeOf = new Float32Array(nt), dOf = new Float32Array(nt).fill(Infinity);
  for (let t = 0; t < nt; t++){
    const [nx, ny, nz, c] = nrm(t), r = lastQ(c, 60); if (!r) continue;
    const ln = r.normal ? r.normal : [0, 0, 0], ll = Math.hypot(...ln) || 1;
    agreeOf[t] = sgn * (nx * ln[0] + ny * ln[1] + nz * ln[2]) / ll; dOf[t] = r.signed ? r.signedDistance : r.distance;
    lab[t] = Math.abs(dOf[t]) <= innerMM && agreeOf[t] < -0.5 ? 1 : 2;
  }
  const edgeFaces = new Map();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++){ const key = edgeKey(I[3 * t + k], I[3 * t + (k + 1) % 3]); const l = edgeFaces.get(key); if (l) l.push(t); else edgeFaces.set(key, [t]); }
  const nbrs = (t) => { const out = []; for (let k = 0; k < 3; k++) for (const u of edgeFaces.get(edgeKey(I[3 * t + k], I[3 * t + (k + 1) % 3])) || []) if (u !== t) out.push(u); return out; };
  { const stack = [];
    for (let t = 0; t < nt; t++) if (lab[t] === 1) for (const u of nbrs(t)) if (lab[u] === 2 && Math.abs(agreeOf[u]) < 0.7 && dOf[u] < collarMM){ lab[u] = 3; stack.push(u); }
    while (stack.length){ const t = stack.pop(); for (const u of nbrs(t)) if (lab[u] === 2 && Math.abs(agreeOf[u]) < 0.7 && dOf[u] < collarMM){ lab[u] = 3; stack.push(u); } } }
  // the parts left without the collar, through shared edges
  const comp = new Int32Array(nt).fill(-1); let parts = 0;
  for (let s = 0; s < nt; s++){
    if (lab[s] === 3 || comp[s] >= 0) continue;
    const stack = [s]; comp[s] = parts;
    while (stack.length){ const t = stack.pop(); for (let k = 0; k < 3; k++){ for (const u of edgeFaces.get(edgeKey(I[3 * t + k], I[3 * t + (k + 1) % 3])) || []) if (comp[u] < 0 && lab[u] !== 3){ comp[u] = parts; stack.push(u); } } }
    parts++;
  }
  /* islands: a part that is neither the largest inside nor the largest outside is a sliver the facing test cut
     off at a fold or a rim bead; it joins the collar, which is what it sits in. The parts are then counted again. */
  /* PARTS, NOT FACES. The collar cuts the shell into parts. The INTERIOR is the part holding the most faces that sit
     on the last facing it, and every face of it is inside, a pocket a couple of millimetres off the last included:
     the maker reads Fit over the whole interior, and a pocket left out of it was neither snapped nor counted. The
     EXTERIOR is the part holding the most faces that face away. Any other part is a sliver and joins the collar. */
  const onLast = new Int32Array(parts), away = new Int32Array(parts), size = new Int32Array(parts);
  for (let t = 0; t < nt; t++){ const c = comp[t]; if (c < 0) continue; size[c]++; if (lab[t] === 1) onLast[c]++; else away[c]++; }
  let bestIn = -1, bestOut = -1;
  for (let c = 0; c < parts; c++) if (onLast[c] > 0 && (bestIn < 0 || onLast[c] > onLast[bestIn])) bestIn = c;
  for (let c = 0; c < parts; c++) if (c !== bestIn && (bestOut < 0 || away[c] > away[bestOut])) bestOut = c;
  const islands = []; for (let c = 0; c < parts; c++) if (c !== bestIn && c !== bestOut) islands.push({ kind: onLast[c] >= away[c] ? 'inside' : 'outside', faces: size[c] });
  const kind0 = Uint8Array.from(lab);   // the face-by-face reading, before parts decided
  for (let t = 0; t < nt; t++){ const c = comp[t]; if (c < 0) continue; lab[t] = c === bestIn ? 1 : c === bestOut ? 2 : 3; }
  const split = (bestIn >= 0 ? 1 : 0) + (bestOut >= 0 ? 1 : 0);
  const count = [0, 0, 0, 0]; for (let t = 0; t < nt; t++) count[lab[t]]++;
  return { labels: lab, kinds: kind0, inside: count[1], outside: count[2], collar: count[3], split, partsBefore: parts, islands, P, I };
}

/* ── frames, alignment, retarget ────────────────────────────────────────── */
/** APP frame → TEMPLATE frame, before any fitting: heel to x = 0, Z up, Y across. */
export function toTemplateFrame(P, heelX){
  const out = new Float64Array(P.length);
  for (let v = 0; v < P.length; v += 3){ out[v] = P[v] - heelX; out[v + 1] = -P[v + 2]; out[v + 2] = P[v + 1]; }
  return out;
}
function bbox(P){ const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let v = 0; v < P.length; v += 3) for (let a = 0; a < 3; a++){ lo[a] = Math.min(lo[a], P[v + a]); hi[a] = Math.max(hi[a], P[v + a]); } return { lo, hi }; }
// the best rotation taking A onto B (both lists of [x,y,z], already paired): Horn's quaternion, the 4×4 by Jacobi
function bestRigid(A, B){
  const n = A.length, ca = [0, 0, 0], cb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++){ ca[k] += A[i][k] / n; cb[k] += B[i][k] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += (A[i][r] - ca[r]) * (B[i][c] - cb[c]);
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz], [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], M = N.map((r) => r.slice());
  for (let sweep = 0; sweep < 60; sweep++){
    let off = 0; for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += M[p][q] * M[p][q]; if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++){
      if (Math.abs(M[p][q]) < 1e-20) continue;
      const th = (M[q][q] - M[p][p]) / (2 * M[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++){ const a = M[k][p], b = M[k][q]; M[k][p] = c * a - s * b; M[k][q] = s * a + c * b; }
      for (let k = 0; k < 4; k++){ const a = M[p][k], b = M[q][k]; M[p][k] = c * a - s * b; M[q][k] = s * a + c * b; }
      for (let k = 0; k < 4; k++){ const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
    }
  }
  let best = 0; for (let k = 1; k < 4; k++) if (M[k][k] > M[best][best]) best = k;
  const [w, x, y, z] = [V[0][best], V[1][best], V[2][best], V[3][best]];
  const R = [[w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z]];
  const t = [0, 1, 2].map((r) => cb[r] - (R[r][0] * ca[0] + R[r][1] * ca[1] + R[r][2] * ca[2]));
  return { R, t };
}
const apply = (R, t, p) => [R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0], R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1], R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2]];
/**
 * Fit our last (TEMPLATE frame already) onto theirs: heel and bottom first, then trimmed ICP below `belowMM` of
 * their bottom (the tops differ by design; the foot does not). Returns { R, t, rms }.
 */
export function alignLasts(ourP, theirQ, theirP, { iters = 30, samples = 3000, belowMM = 100 } = {}){
  const bo = bbox(ourP), bt = bbox(theirP);
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t = [bt.lo[0] - bo.lo[0], (bt.lo[1] + bt.hi[1] - bo.lo[1] - bo.hi[1]) / 2, bt.lo[2] - bo.lo[2]];
  const nv = ourP.length / 3, step = Math.max(1, Math.floor(nv / samples)), pts = [];
  for (let v = 0; v < nv; v += step) if (ourP[3 * v + 2] - bo.lo[2] < belowMM) pts.push([ourP[3 * v], ourP[3 * v + 1], ourP[3 * v + 2]]);
  let rms = Infinity;
  for (let it = 0; it < iters; it++){
    const pairs = [];
    for (const p of pts){ const q = apply(R, t, p), r = theirQ(q); if (r) pairs.push([p, r.point, r.distance]); }
    pairs.sort((a, b) => a[2] - b[2]); const keep = pairs.slice(0, Math.floor(pairs.length * 0.9));
    rms = Math.sqrt(keep.reduce((s, x) => s + x[2] * x[2], 0) / keep.length);
    const fit = bestRigid(keep.map((x) => x[0]), keep.map((x) => x[1]));
    const moved = Math.abs(fit.t[0] - t[0]) + Math.abs(fit.t[1] - t[1]) + Math.abs(fit.t[2] - t[2]);
    R = fit.R; t = fit.t; if (it > 4 && moved < 1e-3) break;
  }
  return { R, t, rms };
}
/**
 * Carry a shoe from our last onto theirs. Both meshes come in the APP frame; the shoe goes out in the TEMPLATE frame.
 * 1. Our last and the shoe go to the template frame, rigidly fitted to their last (alignLasts).
 * 2. Each vertex of our last takes its offset to their surface; the offset is smoothed over our last (Laplacian,
 *    `smooth` passes) so the shoe moves as a whole and does not pick up their last's small features as ripples.
 * 3. Each shoe vertex takes the offset of the closest point on our last (barycentric), so the wall moves as a piece
 *    and keeps its thickness.
 * 4. The INSIDE (vertices within `snapMM` of their last after the move) is put on their surface plus `clearMM`.
 * Returns { P (shoe, TEMPLATE frame), align, before, after } where before/after are fitToLast reports.
 */
export function insideVertices(sh, nv){ const m = new Uint8Array(nv); for (let t = 0; t < sh.labels.length; t++) if (sh.labels[t] === 1){ m[sh.I[3 * t]] = 1; m[sh.I[3 * t + 1]] = 1; m[sh.I[3 * t + 2]] = 1; } return m; }
export function retarget({ shoeP, shoeI, ourLastP, ourLastI, theirLastP, theirLastI, smooth = 12, snapMM = 3, clearMM = 0.1, inside = null }){
  const heelX = bbox(ourLastP).lo[0];
  const oursT = toTemplateFrame(ourLastP, heelX), shoeT = toTemplateFrame(shoeP, heelX);
  const theirQ = lastQuery(theirLastP, theirLastI);
  const align = alignLasts(oursT, theirQ, theirLastP);
  const nv = oursT.length / 3, L = new Float64Array(oursT.length), off = new Float64Array(oursT.length);
  for (let v = 0; v < nv; v++){ const q = apply(align.R, align.t, [oursT[3 * v], oursT[3 * v + 1], oursT[3 * v + 2]]); L.set(q, 3 * v); const r = theirQ(q); if (r){ off[3 * v] = r.point[0] - q[0]; off[3 * v + 1] = r.point[1] - q[1]; off[3 * v + 2] = r.point[2] - q[2]; } }
  // smooth the offset over our last's own edges
  const nb = Array.from({ length: nv }, () => new Set());
  for (let i = 0; i < ourLastI.length; i += 3){ const a = ourLastI[i], b = ourLastI[i + 1], c = ourLastI[i + 2]; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
  const adj = nb.map((s) => Int32Array.from(s));
  let cur = off, nxt = new Float64Array(off.length);
  for (let it = 0; it < smooth; it++){ for (let v = 0; v < nv; v++){ const a = adj[v]; if (!a.length){ nxt.set(cur.subarray(3 * v, 3 * v + 3), 3 * v); continue; } let x = 0, y = 0, z = 0; for (const u of a){ x += cur[3 * u]; y += cur[3 * u + 1]; z += cur[3 * u + 2]; } nxt[3 * v] = 0.5 * cur[3 * v] + 0.5 * x / a.length; nxt[3 * v + 1] = 0.5 * cur[3 * v + 1] + 0.5 * y / a.length; nxt[3 * v + 2] = 0.5 * cur[3 * v + 2] + 0.5 * z / a.length; } [cur, nxt] = [nxt, cur]; }
  // carry it to the shoe through the closest point on our (moved) last
  const soup = unindex(L, ourLastI), bvh = buildBVH(soup);
  const out = new Float64Array(shoeT.length);
  for (let v = 0; v < shoeT.length; v += 3){
    const q = apply(align.R, align.t, [shoeT[v], shoeT[v + 1], shoeT[v + 2]]);
    const r = bvhClosestPoint(bvh, soup, q);
    let d = [0, 0, 0];
    if (r){ const tri = r.tri, b = r.bary || [1 / 3, 1 / 3, 1 / 3]; for (let k = 0; k < 3; k++){ const vi = ourLastI[3 * tri + k]; d[0] += b[k] * cur[3 * vi]; d[1] += b[k] * cur[3 * vi + 1]; d[2] += b[k] * cur[3 * vi + 2]; } }
    out[v] = q[0] + d[0]; out[v + 1] = q[1] + d[1]; out[v + 2] = q[2] + d[2];
  }
  // the inside: the vertices of the shoe's inside sheet (read against OUR last) when given, else those near theirs
  const ins = inside ? Uint8Array.from(inside) : (() => { const m = new Uint8Array(out.length / 3); for (let v = 0; v < out.length; v += 3){ const r = theirQ([out[v], out[v + 1], out[v + 2]], 1.5); if (r) m[v / 3] = 1; } return m; })();
  const before = fitToLast(out, theirQ, { inside: ins, band: 6 });
  const pre = Float64Array.from(out);
  /* the snap: every inside vertex onto their surface + clearMM. A vertex is inside when its face reads inside against
     OUR last (the mask) or, after the move, against THEIRS (a rim-edge face can change sides by a fraction of a mm).
     Each vertex's correction is then fed a few rings into the rim band (half per ring), so the rim follows the inside
     instead of folding against it: an unfed snap crossed one face pair at the rim on a real template last. */
  /* THE SNAP, PROGRESSIVE. Moving each inside vertex on its own (to its closest point, or along its normal) folds the
     inside sheet wherever the corrections change sharply: round the crease where the footbed meets the side, a joined
     shoe went from 0 crossing faces to 500. So the correction is found, SMOOTHED over the inside sheet (16, 8, 4, 2,
     1, then 0 passes), applied, and found again: each step small and smooth, the last one exact. The wall follows its
     inside at every step (the nearest point on the inside sheet, in full to 6 mm, fading out by 12 mm). */
  const nvS = out.length / 3;
  const nbS = Array.from({ length: nvS }, () => []);
  for (let i = 0; i < shoeI.length; i += 3){ const a = shoeI[i], b = shoeI[i + 1], c = shoeI[i + 2]; nbS[a].push(b, c); nbS[b].push(a, c); nbS[c].push(a, b); }
  { const sh2 = sheets(out, shoeI, theirQ); for (let t = 0; t < sh2.labels.length; t++) if (sh2.labels[t] === 1) for (let k = 0; k < 3; k++) ins[sh2.I[3 * t + k]] = 1; }
  const insFaces = []; for (let t = 0; t < shoeI.length; t += 3) if (ins[shoeI[t]] && ins[shoeI[t + 1]] && ins[shoeI[t + 2]]) insFaces.push(t);
  // the schedule, then a re-read of the inside (stretches that only came near their last as their neighbours moved)
  // and two more passes for what joined it
  const schedule = [16, 8, 4, 2, 1, 0, 'reread', 2, 0];
  for (const passes of schedule){
    if (passes === 'reread'){
      const sh3 = sheets(out, shoeI, theirQ); let added = 0;
      for (let t = 0; t < sh3.labels.length; t++) if (sh3.labels[t] === 1) for (let k = 0; k < 3; k++){ const v = sh3.I[3 * t + k]; if (!ins[v]){ ins[v] = 1; added++; } }
      insFaces.length = 0; for (let t = 0; t < shoeI.length; t += 3) if (ins[shoeI[t]] && ins[shoeI[t + 1]] && ins[shoeI[t + 2]]) insFaces.push(t);
      continue;
    }
    let corr = new Float64Array(out.length);
    for (let v = 0; v < nvS; v++){
      if (!ins[v]) continue;
      const r = theirQ([out[3 * v], out[3 * v + 1], out[3 * v + 2]], snapMM * 2); if (!r || !r.signed) continue;
      const n = r.normal, l = Math.hypot(n[0], n[1], n[2]) || 1;
      corr[3 * v] = r.point[0] + n[0] / l * clearMM - out[3 * v]; corr[3 * v + 1] = r.point[1] + n[1] / l * clearMM - out[3 * v + 1]; corr[3 * v + 2] = r.point[2] + n[2] / l * clearMM - out[3 * v + 2];
    }
    for (let it = 0; it < passes; it++){
      const nx = Float64Array.from(corr);
      for (let v = 0; v < nvS; v++){ if (!ins[v]) continue; let x = 0, y = 0, z = 0, c = 0; for (const u of nbS[v]) if (ins[u]){ x += corr[3 * u]; y += corr[3 * u + 1]; z += corr[3 * u + 2]; c++; } if (c){ nx[3 * v] = 0.5 * corr[3 * v] + 0.5 * x / c; nx[3 * v + 1] = 0.5 * corr[3 * v + 1] + 0.5 * y / c; nx[3 * v + 2] = 0.5 * corr[3 * v + 2] + 0.5 * z / c; } }
      corr = nx;
    }
    // the wall with its inside
    if (insFaces.length){
      const soupS = new Float32Array(insFaces.length * 9); insFaces.forEach((t, q) => { for (let k = 0; k < 3; k++){ const v = shoeI[t + k] * 3; soupS[q * 9 + k * 3] = out[v]; soupS[q * 9 + k * 3 + 1] = out[v + 1]; soupS[q * 9 + k * 3 + 2] = out[v + 2]; } });
      const bvhS = buildBVH(soupS);
      for (let v = 0; v < nvS; v++){
        if (ins[v]) continue;
        const r = bvhClosestPoint(bvhS, soupS, [out[3 * v], out[3 * v + 1], out[3 * v + 2]], { maxDistance: 12 }); if (!r) continue;
        const w = r.distance <= 6 ? 1 : 1 - (r.distance - 6) / 6, t = insFaces[r.tri], bb = r.bary || [1 / 3, 1 / 3, 1 / 3];
        for (let a = 0; a < 3; a++){ let x = 0; for (let k = 0; k < 3; k++) x += bb[k] * corr[shoeI[t + k] * 3 + a]; corr[3 * v + a] = x * w; }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] += corr[i];
  }
  /* UNTANGLE. A few faces can still cross where the inside snapped past a fold of the rim. The inside stays exact; the
     other vertices of each crossing pair ease halfway back toward where they stood before the snap, and the pairs are
     read again, up to six times; an inside vertex in a pair slides along their last instead. (Weld-free indices here, so pair vertices are the shoe's own.) */
  let untangled = 0, stillCrossing = 0, released = 0;
  { const before = Float64Array.from(pre);
    for (let round = 0; round < 6; round++){
      const pairs = []; const si = selfIntersections(out, shoeI, { cap: 5000, pairs });
      stillCrossing = si.count; if (!si.count) break;
      const move = new Set(), slide = new Set();
      for (const t of pairs){
        // a face with a free vertex is the rim's: its snapped vertices sit on the inside sheet's edge, and when it
        // crosses, the snap pressed the rim flat over the sheet (a pleat on their surface that sliding never lifts).
        // Those edge vertices are released from the snap and ease back with the rest of the rim
        const rim = !(ins[shoeI[3 * t]] && ins[shoeI[3 * t + 1]] && ins[shoeI[3 * t + 2]]);
        for (let k = 0; k < 3; k++){ const v = shoeI[3 * t + k]; if (ins[v] && rim){ ins[v] = 0; released++; } (ins[v] ? slide : move).add(v); }
      }
      for (const v of move){ for (let a = 0; a < 3; a++) out[3 * v + a] = 0.5 * out[3 * v + a] + 0.5 * before[3 * v + a]; untangled++; }
      // an inside vertex in a crossing pair slides on their last: to its neighbours' mean, then back onto the surface
      for (const v of slide){
        let x = 0, y = 0, z = 0, c = 0; for (const u of nbS[v]){ x += out[3 * u]; y += out[3 * u + 1]; z += out[3 * u + 2]; c++; }
        if (!c) continue;
        const r = theirQ([x / c, y / c, z / c], snapMM * 2); if (!r || !r.signed) continue;
        const n = r.normal, l = Math.hypot(n[0], n[1], n[2]) || 1;
        out[3 * v] = r.point[0] + n[0] / l * clearMM; out[3 * v + 1] = r.point[1] + n[1] / l * clearMM; out[3 * v + 2] = r.point[2] + n[2] / l * clearMM; untangled++;
      }
    }
  }
  const after = fitToLast(out, theirQ, { inside: ins, band: 6 });
  return { P: out, align, before, after, theirQ, inside: ins, untangled, stillCrossing, released };
}
/** The other foot: mirror across the template's Y (across the foot), faces turned so they still face out. */
export function mirrorY(P, I){
  const Q = Float64Array.from(P); for (let v = 1; v < Q.length; v += 3) Q[v] = -Q[v];
  const J = Uint32Array.from(I); for (let t = 0; t < J.length; t += 3){ const a = J[t + 1]; J[t + 1] = J[t + 2]; J[t + 2] = a; }
  return { P: Q, I: J };
}
/** Binary STL of an indexed mesh. */
export function stl(P, I, header = 'LastFirst'){
  const nt = I.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  const h = new TextEncoder().encode(header.slice(0, 80)); new Uint8Array(buf, 0, h.length).set(h);
  dv.setUint32(80, nt, true);
  for (let t = 0; t < nt; t++){
    const o = 84 + t * 50, a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (let k = 0; k < 3; k++){ const v = I[3 * t + k] * 3; dv.setFloat32(o + 12 + k * 12, P[v], true); dv.setFloat32(o + 16 + k * 12, P[v + 1], true); dv.setFloat32(o + 20 + k * 12, P[v + 2], true); }
  }
  return new Uint8Array(buf);
}
