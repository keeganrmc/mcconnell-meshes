// A painted region's outline as a curve with points, and the curve back into the paint.
//
// Pgon's and MASQ's region curve, on a triangle substrate (paint.mjs createSubstrate):
// - FIT: the field's 0.5 contour (meshcut's refine + boundary loops), faired, handles at even arc
//   length. The handles are INTERPOLATION points of a closed uniform cubic B-spline (the controls
//   are solved so the curve passes through them), so a dragged point lands where the hand put it.
// - THE CURVE LIES ON THE SURFACE: control handles are world points on the form, every sample is
//   projected onto the nearest triangle, and a gap the projection jumps (across a ridge) is bridged
//   by subdividing the chord and projecting again. Nothing here reads a camera.
// - BACK INTO THE PAINT: the wall is the vertices of the triangles the samples pass through. The
//   rest floods into components; each component takes the side the curve's own geometry gives the
//   vertices that touch the wall (cross(normal, tangent), oriented per loop at fit time), not a vote
//   of the old paint, so a loop dragged far still knows its inside. The ramp is the same band
//   layRegion and the brush write, measured to the CURVE, signed by that side.
// - ⚠ A component whose wall-side votes disagree is a wall the flood walked through (the curve
//   crosses itself, or a gap): the rewrite refuses rather than guessing, and the old paint stands.
// - ⚠ Territory is measured against the field at the START of the drag, never the last move, or a
//   drag ratchets a region away a little per move.

import { refineAtIsoline, triangleSides, boundaryLoops } from './meshcut.mjs';
import { EDGES_ACROSS_BAND, geodesic } from './paint.mjs';

// ---------- closed interpolating cubic (Pgon's spline: cyclic tridiagonal, Sherman-Morrison) ----------
function solveCyclic(n, rhs) {
  const a = 1, c = 1, gamma = -4;
  const bb = new Float64Array(n).fill(4); bb[0] = 4 - gamma; bb[n - 1] = 4 - a * c / gamma;
  const thomas = (d) => {
    const cp = new Float64Array(n), dp = new Float64Array(n);
    cp[0] = c / bb[0]; dp[0] = d[0] / bb[0];
    for (let i = 1; i < n; i++) { const den = bb[i] - a * cp[i - 1]; cp[i] = c / den; dp[i] = (d[i] - a * dp[i - 1]) / den; }
    const x = new Float64Array(n); x[n - 1] = dp[n - 1];
    for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
    return x;
  };
  const u = new Float64Array(n); u[0] = gamma; u[n - 1] = c;
  const y = thomas(rhs), q = thomas(u);
  const f = (y[0] + a * y[n - 1] / gamma) / (1 + q[0] + a * q[n - 1] / gamma);
  const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = y[i] - f * q[i];
  return x;
}
export function controlsFor(handles) {
  const n = handles.length; if (n < 3) return null;
  const cols = [0, 1, 2].map((d) => solveCyclic(n, Float64Array.from(handles, (h) => 6 * h[d])));
  return handles.map((_, i) => [cols[0][i], cols[1][i], cols[2][i]]);
}
export function splineAt(Q, u) {
  const n = Q.length, i = Math.floor(u), t = u - i, t2 = t * t, t3 = t2 * t;
  const at = (k) => Q[((k % n) + n) % n];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const b0 = (1 - 3 * t + 3 * t2 - t3) / 6, b1 = (4 - 6 * t2 + 3 * t3) / 6, b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, b3 = t3 / 6;
  return [0, 1, 2].map((d) => p0[d] * b0 + p1[d] * b1 + p2[d] * b2 + p3[d] * b3);
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------- the surface: nearest triangle to a point ----------
function closestOnTri(p, A, B, C) {
  const ab = sub3(B, A), ac = sub3(C, A), ap = sub3(p, A);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return A.slice();
  const bp = sub3(p, B), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return B.slice();
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return [A[0] + ab[0] * t, A[1] + ab[1] * t, A[2] + ab[2] * t]; }
  const cp = sub3(p, C), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return C.slice();
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return [A[0] + ac[0] * t, A[1] + ac[1] * t, A[2] + ac[2] * t]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [B[0] + (C[0] - B[0]) * t, B[1] + (C[1] - B[1]) * t, B[2] + (C[2] - B[2]) * t]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [A[0] + ab[0] * v + ac[0] * w, A[1] + ab[1] * v + ac[1] * w, A[2] + ab[2] * v + ac[2] * w];
}

// project(p) → { p, tri, n } : the closest point among the triangles around the nearest vertices.
export function makeProjector(sub) {
  const P = sub.positions, I = sub.indices, V = sub.V, T = I.length / 3;
  const off = new Uint32Array(V + 1);
  for (let k = 0; k < I.length; k++) off[I[k] + 1]++;
  for (let v = 0; v < V; v++) off[v + 1] += off[v];
  const list = new Uint32Array(I.length), fill = off.slice();
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) list[fill[I[t * 3 + e]]++] = t;
  const cell = Math.max(1, sub.edgeMM * 2), grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let v = 0; v < V; v++) { const k = key(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(v); }
  const at = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const triNormal = (t) => { const a = at(I[t * 3]), b = at(I[t * 3 + 1]), c = at(I[t * 3 + 2]); const n = cross3(sub3(b, a), sub3(c, a)); const l = Math.hypot(...n) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };
  // area-weighted vertex normals: a face's own normal swings across a crease (the instep keel)
  // where the form plainly still faces one way, and "which side faces the eye" reads the smooth one
  const VN = new Float64Array(V * 3);
  for (let t = 0; t < T; t++) { const a = at(I[t * 3]), b = at(I[t * 3 + 1]), c = at(I[t * 3 + 2]); const n = cross3(sub3(b, a), sub3(c, a)); for (let e = 0; e < 3; e++) { const v = I[t * 3 + e]; VN[v * 3] += n[0]; VN[v * 3 + 1] += n[1]; VN[v * 3 + 2] += n[2]; } }
  const smoothNormal = (t) => { const n = [0, 0, 0]; for (let e = 0; e < 3; e++) { const v = I[t * 3 + e]; n[0] += VN[v * 3]; n[1] += VN[v * 3 + 1]; n[2] += VN[v * 3 + 2]; } const l = Math.hypot(...n) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };
  const nearVerts = (p) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    for (let r = 1; r <= 24; r++) {
      const found = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`); if (l) for (const v of l) found.push(v);
      }
      if (found.length) {
        found.sort((a, b) => dist3(at(a), p) - dist3(at(b), p));
        return found.slice(0, 6);
      }
    }
    return [];
  };
  const project = (p) => {
    let best = null, bd = Infinity, bt = -1;
    const seen = new Set();
    for (const v of nearVerts(p)) for (let k = off[v]; k < off[v + 1]; k++) {
      const t = list[k]; if (seen.has(t)) continue; seen.add(t);
      const q = closestOnTri(p, at(I[t * 3]), at(I[t * 3 + 1]), at(I[t * 3 + 2]));
      const d = dist3(q, p); if (d < bd) { bd = d; best = q; bt = t; }
    }
    if (!best) return null;
    return { p: best, tri: bt, n: triNormal(bt), sn: smoothNormal(bt), d: bd };
  };
  return { project, triNormal, at };
}

// ---------- fit: the field's 0.5 contour as loops of handles ----------
function arcResample(pts, count) {
  const n = pts.length, seg = new Float64Array(n); let total = 0;
  for (let i = 0; i < n; i++) { seg[i] = dist3(pts[i], pts[(i + 1) % n]); total += seg[i]; }
  const out = []; let acc = 0, i = 0;
  for (let k = 0; k < count; k++) {
    const want = total * k / count;
    while (i < n - 1 && acc + seg[i] < want) { acc += seg[i]; i++; }
    const t = seg[i] > 0 ? (want - acc) / seg[i] : 0, a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}
export function perimeter(pts) { let L = 0; for (let i = 0; i < pts.length; i++) L += dist3(pts[i], pts[(i + 1) % pts.length]); return L; }
// Taubin λ|μ on a closed polyline, projected back onto the form after each pair: the mesh's
// staircase comes off and the loop neither shrinks nor leaves the surface.
function fairClosed(pts, proj, passes) {
  let p = pts.map((q) => q.slice());
  const step = (k) => {
    const n = p.length, out = new Array(n);
    for (let i = 0; i < n; i++) { const a = p[(i - 1 + n) % n], b = p[(i + 1) % n], c = p[i]; out[i] = [0, 1, 2].map((d) => c[d] + k * ((a[d] + b[d]) / 2 - c[d])); }
    p = out;
  };
  for (let it = 0; it < passes; it++) { step(0.6307); step(-0.6732); p = p.map((q) => { const r = proj.project(q); return r ? r.p : q; }); }
  return p;
}

// field (0..1 per substrate vertex) → [{ handles, orient, length }] (orient +1: inside is cross(n, t))
export function fitOutline(sub, field, proj, { count = 16, minCount = 4 } = {}) {
  const vals = new Float64Array(sub.V); for (let v = 0; v < sub.V; v++) vals[v] = field[v] - 0.5;
  const r = refineAtIsoline(sub.positions, sub.indices, vals);
  const side = triangleSides(r.indices, r.values);
  const raw = boundaryLoops(r.indices, Array.from(side, (s) => s > 0));
  const minLen = 6 * sub.edgeMM;
  let loops = raw.map((L) => L.map((i) => [r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]]))
    .filter((pts) => pts.length >= 6 && perimeter(pts) > minLen);
  if (!loops.length) return [];
  loops = loops.map((pts) => fairClosed(arcResample(pts, Math.max(24, Math.round(perimeter(pts) / (sub.edgeMM * 0.5)))), proj, 8));
  const Lmax = Math.max(...loops.map(perimeter));
  return loops.map((pts) => {
    const L = perimeter(pts);
    const n = Math.max(minCount, Math.round(count * L / Lmax));
    const handles = arcResample(pts, n).map((q) => { const s = proj.project(q); return s ? s.p : q; });
    return { handles, orient: orientOf(handles, proj, field, sub), length: L };
  });
}
// which side of the loop the paint is on, read off the field a short step either side
function orientOf(handles, proj, field, sub) {
  const s = sampleLoop(handles, proj, sub.edgeMM);
  const I = sub.indices, step = 2 * sub.edgeMM;
  let vote = 0;
  for (let i = 0; i < s.pts.length; i += Math.max(1, Math.floor(s.pts.length / 24))) {
    const c = s.pts[i], t = s.tan[i], nrm = s.nrm[i], side = cross3(nrm, t), l = Math.hypot(...side) || 1;
    const q = proj.project([c[0] + side[0] / l * step, c[1] + side[1] / l * step, c[2] + side[2] / l * step]);
    if (!q) continue;
    const f = (field[I[q.tri * 3]] + field[I[q.tri * 3 + 1]] + field[I[q.tri * 3 + 2]]) / 3;
    vote += f > 0.5 ? 1 : -1;
  }
  return vote >= 0 ? 1 : -1;
}

// ---------- the curve on the surface ----------
// → { pts:[[x,y,z]], tri:[t], tan:[[...]], nrm:[[...]], span:[handle index each sample follows] }
export function sampleLoop(handles, proj, edgeMM) {
  const Q = controlsFor(handles); if (!Q) return { pts: [], tri: [], tan: [], nrm: [], span: [] };
  const n = handles.length, pts = [], tri = [], span = [];
  const push = (q, k) => { const s = proj.project(q); if (!s) return; pts.push(s.p); tri.push(s.tri); span.push(k); };
  const maxGap = edgeMM * 0.8;
  for (let k = 0; k < n; k++) {
    const len = dist3(handles[k], handles[(k + 1) % n]);
    const m = Math.max(2, Math.ceil(len / (edgeMM * 0.4)));
    for (let j = 0; j < m; j++) push(splineAt(Q, k + j / m), k);
  }
  // bridge any jump the projection made (a chord across a ridge lands on two far faces)
  const out = [], outTri = [], outSpan = [];
  const bridge = (a, b, ta, depth, k) => {
    if (depth > 6 || dist3(a, b) <= maxGap) return;
    const m = proj.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]); if (!m) return;
    bridge(a, m.p, ta, depth + 1, k); out.push(m.p); outTri.push(m.tri); outSpan.push(k); bridge(m.p, b, m.tri, depth + 1, k);
  };
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]); outTri.push(tri[i]); outSpan.push(span[i]);
    bridge(pts[i], pts[(i + 1) % pts.length], tri[i], 0, span[i]);
  }
  const N = out.length, tan = new Array(N), nrm = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = sub3(out[(i + 1) % N], out[(i - 1 + N) % N]), l = Math.hypot(...t) || 1;
    tan[i] = [t[0] / l, t[1] / l, t[2] / l]; nrm[i] = proj.triNormal(outTri[i]);
  }
  return { pts: out, tri: outTri, tan, nrm, span: outSpan };
}

// Does a sampled loop cross itself or another on the form? Segments closer than a fraction of an
// edge that are not neighbours along the curve.
export function crossesOnForm(samples, edgeMM) {
  const cell = edgeMM * 2, grid = new Map(), tol = edgeMM * 0.25;
  const all = [];
  samples.forEach((s, li) => s.pts.forEach((p, i) => all.push({ li, i, n: s.pts.length, p })));
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const a of all) { const k = key(a.p); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(a); }
  for (const a of all) {
    const c = a.p.map((x) => Math.floor(x / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`); if (!l) continue;
      for (const b of l) {
        if (b === a) continue;
        if (b.li === a.li) { const d = Math.abs(b.i - a.i), w = Math.min(d, a.n - d); if (w < 12) continue; }
        if (dist3(a.p, b.p) < tol) return true;
      }
    }
  }
  return false;
}

// ---------- the curve back into the paint ----------
// base: the field at the drag's start. loops: [{ handles, orient }]. Returns
// { ok, field, reason, inside, baseInside }.
export function rewriteRegion(sub, base, loops, proj) {
  const V = sub.V, P = sub.positions, I = sub.indices, off = sub.off, nbr = sub.nbr;
  const half = (EDGES_ACROSS_BAND / 2) * sub.edgeMM;
  const samples = loops.map((L) => sampleLoop(L.handles, proj, sub.edgeMM));
  if (crossesOnForm(samples, sub.edgeMM)) return { ok: false, reason: 'crosses' };
  const bar = new Uint8Array(V);
  for (const s of samples) for (const t of s.tri) { bar[I[t * 3]] = 1; bar[I[t * 3 + 1]] = 1; bar[I[t * 3 + 2]] = 1; }

  // segment grid for the distance to the curve and the side it gives
  const cell = Math.max(half, sub.edgeMM * 2), grid = new Map();
  const keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  samples.forEach((s, li) => { for (let i = 0; i < s.pts.length; i++) { const p = s.pts[i], k = keyOf(p[0], p[1], p[2]); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(li, i); } });
  // nearest point on the curve within `reach` → { d, side }
  const nearest = (x, y, z, reach) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell), r = Math.ceil(reach / cell);
    let bd = Infinity, bs = 0;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!l) continue;
      for (let j = 0; j < l.length; j += 2) {
        const s = samples[l[j]], i = l[j + 1], a = s.pts[i], b = s.pts[(i + 1) % s.pts.length];
        const ab = sub3(b, a), l2 = dot3(ab, ab), ap = [x - a[0], y - a[1], z - a[2]];
        const t = l2 > 0 ? Math.max(0, Math.min(1, dot3(ap, ab) / l2)) : 0;
        const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], d = Math.hypot(x - q[0], y - q[1], z - q[2]);
        if (d < bd) {
          bd = d;
          const tg = l2 > 0 ? ab.map((c) => c / Math.sqrt(l2)) : s.tan[i];
          const sd = cross3(s.nrm[i], tg);
          bs = Math.sign(dot3([x - q[0], y - q[1], z - q[2]], sd)) * loops[l[j]].orient || 1;
        }
      }
    }
    return bd < Infinity ? { d: bd, side: bs } : null;
  };

  // flood the rest into components
  const label = new Int32Array(V).fill(-1), comps = [], stack = [];
  for (let s0 = 0; s0 < V; s0++) {
    if (bar[s0] || label[s0] >= 0) continue;
    const id = comps.length; let plus = 0, minus = 0, n = 0, was = 0;
    label[s0] = id; stack.length = 0; stack.push(s0);
    while (stack.length) {
      const v = stack.pop(); n++; if (base[v] >= 0.5) was++;
      let touches = false;
      for (let k = off[v]; k < off[v + 1]; k++) { const u = nbr[k]; if (bar[u]) touches = true; else if (label[u] < 0) { label[u] = id; stack.push(u); } }
      if (touches) { const q = nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], cell * 2); if (q) { if (q.side > 0) plus++; else minus++; } }
    }
    const votes = plus + minus;
    comps.push({ sign: votes ? (plus >= minus ? 1 : -1) : (was * 2 > n ? 1 : -1), leak: votes > 8 && Math.min(plus, minus) > 0.25 * votes, n });
  }
  if (comps.some((c) => c.leak)) return { ok: false, reason: 'leak' };

  // the near band: a walk from the wall, then the exact distance to the curve
  const seeds = []; for (let v = 0; v < V; v++) if (bar[v]) seeds.push(v);
  const near = geodesic(sub, seeds, half * 2 + sub.edgeMM);
  const out = Float32Array.from(base);
  for (let v = 0; v < V; v++) {
    const s = bar[v] ? 0 : comps[label[v]].sign;
    if (!near.has(v) && !bar[v]) { const was = base[v] >= 0.5 ? 1 : -1; if (was !== s) out[v] = s > 0 ? 1 : 0; continue; }
    const q = nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], half * 3 + sub.edgeMM);
    const sign = bar[v] ? (q ? q.side : (base[v] >= 0.5 ? 1 : -1)) : s;
    const d = q ? q.d : half * 3;
    const t = Math.max(0, Math.min(1, (sign * d + half) / (2 * half)));
    out[v] = t * t * (3 - 2 * t);
  }
  let inside = 0, baseInside = 0;
  for (let v = 0; v < V; v++) { if (out[v] >= 0.5) inside++; if (base[v] >= 0.5) baseInside++; }
  if (baseInside > 0 && inside < 0.25 * baseInside) return { ok: false, reason: 'shrinks', inside, baseInside };
  if (inside > 0.9 * V && baseInside <= 0.9 * V) return { ok: false, reason: 'floods', inside, baseInside };
  return { ok: true, field: out, inside, baseInside, samples };
}

// Every point moved `mm` along the surface, outward from the paint (negative: inward), then put back
// on the form: MASQ's Grow and Shrink as an offset of the curve itself, so the edge keeps its shape.
export function offsetLoops(loops, proj, edgeMM, mm) {
  return loops.map((L) => {
    const s = sampleLoop(L.handles, proj, edgeMM), n = L.handles.length;
    const handles = L.handles.map((h, k) => {
      // the tangent at the handle, from the sampled curve around it
      let best = 0, bd = Infinity;
      for (let i = 0; i < s.pts.length; i++) { if (s.span[i] !== k) continue; const d = dist3(s.pts[i], h); if (d < bd) { bd = d; best = i; } }
      const side = cross3(s.nrm[best], s.tan[best]), l = Math.hypot(...side) || 1, out = -L.orient * mm / l;
      const q = proj.project([h[0] + side[0] * out, h[1] + side[1] * out, h[2] + side[2] * out]);
      return q ? q.p : h.slice();
    });
    return { ...L, handles };
  });
}
