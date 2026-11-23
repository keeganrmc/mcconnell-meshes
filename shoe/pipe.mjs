// PIPE LAYER — a closed, watertight tubular bead or piping swept along a 3D path.
//
// Forms:
//   - Rim piping: sweeps along the boundary loop of a covered region on a substrate
//     (e.g. collar opening, strap edge, mudguard rim, or feather line welt).
//   - Curve pipe: sweeps along a 3D polyline / beads (closed loop or open curve with caps).
//   - Repeated elements along the same path: beads, eyelets, zipper, laces, chain.
//
// Every generator returns { ok: true, positions, indices, normals, closure, volumeCm3,
// areaCm2, notes } or a refusal { ok: false, reason, message }. Each element is a closed
// manifold wound outward, so volumeCm3 is the SIGNED volume and is positive for a correct
// mesh. `notes` carries one-line human notes for anything the builder changed or could
// not honour (a raised spacing, a fold at a tight bend); `message` is shown as is.
// Parallel transport framing (Bishop frame) prevents axis flipping and twist pinching.
// The tube is offset along the substrate surface normal so it rests cleanly on top
// of the parent piece without clipping into its interior.

import { refineAtIsoline, triangleSides, boundaryLoops, signedVolume, meshArea, vertexNormals } from './meshcut.mjs';
import { resampleClosed } from './curvefit.mjs';

const MAX_ELEMENTS = 600;
const fmt = (v) => (Math.round(v * 10) / 10).toString();

function refuse(reason, message) {
  return { ok: false, reason, message };
}

// bad input is refused by name, never coerced: a NaN point read as 0 put elements at the origin
function pathProblem(points, closed) {
  if (!points || typeof points.length !== 'number' || points.length < 2) return refuse('degenerate_path', 'The line needs at least 2 points.');
  let bad = 0;
  for (const p of points) if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) bad++;
  if (bad) return refuse('bad_points', bad === 1 ? '1 path point is not a number.' : `${bad} path points are not numbers.`);
  if (closed && points.length < 3) return refuse('degenerate_path', 'A closed line needs at least 3 points.');
  return null;
}

// null/undefined takes the default; anything else must be a finite number
function readNumber(opts, key, label, fallback) {
  const v = opts[key];
  if (v == null) return { value: fallback };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: refuse('bad_number', `${label} is not a number.`) };
  return { value: v };
}

// meshClosure's counts (distinct directed edges used twice; edges without a reverse twin)
// from one sorted key array: its Map took a second on a 600-link chain
function closureOf(indices) {
  const n = indices.length;
  const keys = new Float64Array(n);
  for (let t = 0; t < n; t += 3) for (let e = 0; e < 3; e++) keys[t + e] = indices[t + e] * 4294967296 + indices[t + (e + 1) % 3];
  keys.sort();
  const uniq = [];
  let doubled = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && keys[j] === keys[i]) j++;
    if (j - i > 1) doubled++;
    uniq.push(keys[i]);
    i = j;
  }
  let boundary = 0, twinned = 0;
  for (const k of uniq) {
    const a = Math.floor(k / 4294967296), b = k - a * 4294967296;
    const rev = b * 4294967296 + a;
    let lo = 0, hi = uniq.length - 1, found = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (uniq[mid] === rev) { found = true; break; }
      if (uniq[mid] < rev) lo = mid + 1; else hi = mid - 1;
    }
    if (found) twinned++; else boundary++;
  }
  return { boundaryEdges: boundary, doubledEdges: doubled, edges: twinned / 2 };
}

function finishMesh(positions, indices, normals, notes, extra = {}) {
  return {
    ok: true,
    positions,
    indices,
    normals,
    closure: closureOf(indices),
    volumeCm3: signedVolume(positions, indices) / 1000,
    areaCm2: meshArea(positions, indices) / 100,
    notes,
    ...extra,
  };
}

// Tightest bend as the tube sees it: two neighbouring rings stand on planes normal to their
// tangents, which meet on a line (l/2)/tan(dtheta/2) from the path; a ring wider than that
// crosses its neighbour. A sharp polyline corner reads as a radius near 0, a sampled arc as its radius.
export function tightestBend(points, closed) {
  const N = points.length;
  const tan = [];
  for (let i = 0; i < N; i++) {
    const prev = closed ? points[(i - 1 + N) % N] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % N] : points[Math.min(N - 1, i + 1)];
    const t = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
    const l = Math.hypot(t[0], t[1], t[2]);
    tan.push(l > 1e-12 ? [t[0] / l, t[1] / l, t[2] / l] : null);
  }
  let best = Infinity;
  for (let i = 0; i < (closed ? N : N - 1); i++) {
    const j = (i + 1) % N, a = points[i], b = points[j], ta = tan[i], tb = tan[j];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!ta || !tb || len < 1e-9) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, ta[0] * tb[0] + ta[1] * tb[1] + ta[2] * tb[2])));
    if (turn < 1e-9) continue;
    best = Math.min(best, Math.max(0, (len / 2) / Math.tan(turn / 2)));
  }
  return best;
}

// Closest approach of the line to itself between segments more than a half turn of the tube apart
// along it (pi r of arc): a tube there runs into its own other run, which no local ease can mend.
export function selfApproach(points, closed, radius) {
  // densified to half a radius a step (at most ~600 points), so a short line's legs are told apart
  { const S0 = closed ? points.length : points.length - 1, out = [];
    let len = 0; for (let i = 0; i < S0; i++) { const a = points[i], b = points[(i + 1) % points.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
    const h = Math.max(radius / 2, len / 600);
    for (let i = 0; i < S0; i++) { const a = points[i], b = points[(i + 1) % points.length], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / h));
      for (let q = 0; q < k; q++) out.push([a[0] + (b[0] - a[0]) * q / k, a[1] + (b[1] - a[1]) * q / k, a[2] + (b[2] - a[2]) * q / k]); }
    if (!closed) out.push(points[points.length - 1].slice());
    points = out; }
  const N = points.length, S = closed ? N : N - 1;
  if (S < 3) return Infinity;
  const arc = [0]; for (let i = 0; i < S; i++) { const a = points[i], b = points[(i + 1) % N]; arc.push(arc[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
  const total = arc[S], gap = Math.PI * radius;
  const segDist = (p1, q1, p2, q2) => {
    const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]], r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
    let sP = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = e > 1e-12 ? (b * sP + f) / e : 0;
    if (t < 0) { t = 0; sP = a > 1e-12 ? Math.min(1, Math.max(0, -c / a)) : 0; } else if (t > 1) { t = 1; sP = a > 1e-12 ? Math.min(1, Math.max(0, (b - c) / a)) : 0; }
    return Math.hypot(r[0] + d1[0] * sP - d2[0] * t, r[1] + d1[1] * sP - d2[1] * t, r[2] + d1[2] * sP - d2[2] * t);
  };
  let best = Infinity;
  for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) {
    let along = Math.max(0, arc[j] - arc[i + 1]);
    if (closed) along = Math.min(along, Math.max(0, total - arc[j + 1] + arc[i]));
    if (along < gap) continue;
    best = Math.min(best, segDist(points[i], points[(i + 1) % N], points[j], points[(j + 1) % N]));
  }
  return best;
}

// A tube of radius r folds into itself wherever its line bends tighter than r. The line is
// eased there and only there: the points at a bend under 1.05 r (and the ring of points within a
// radius of them) take half a step to their neighbours' midpoint, until every bend clears or 400
// passes run out. An open line's ends stay put. Returns the eased copy, the length of line that
// moved, and the bend it reached; the surface line itself is never touched.
export function easeTightBends(points, closed, radius) {
  const N = points.length, want = 1.05 * radius;
  const pts = points.map((p) => p.slice());
  const before = tightestBend(pts, closed);
  if (!(before < want) || N < 3) return { points: pts, easedMM: 0, bend: before, passes: 0 };
  const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const local = (i) => {   // the bend at point i, from its two segments (as tightestBend reads them)
    const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (lu < 1e-12 || lv < 1e-12) return Infinity;
    const turn = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv))));
    return turn < 1e-9 ? Infinity : (Math.min(lu, lv) / 2) / Math.tan(turn / 2);
  };
  let passes = 0, bend = before;
  for (; passes < 400 && bend < want; passes++) {
    const hot = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!closed && (i === 0 || i === N - 1)) continue;
      if (local(i) < want) {
        // spread the ease a radius along the line each way, so the corner opens into an arc
        hot[i] = 1;
        for (const dir of [-1, 1]) {
          let j = i, run = 0;
          while (run < radius) { const k = closed ? (j + dir + N) % N : j + dir; if (k < 0 || k >= N || k === i) break; run += segLen(pts[j], pts[k]); j = k; hot[j] = 1; }
        }
      }
    }
    if (!closed) { hot[0] = 0; hot[N - 1] = 0; }
    const next = pts.map((p) => p.slice());
    for (let i = 0; i < N; i++) {
      if (!hot[i]) continue;
      const a = pts[(i - 1 + N) % N], c = pts[(i + 1) % N];
      for (let k = 0; k < 3; k++) next[i][k] = pts[i][k] + 0.5 * ((a[k] + c[k]) / 2 - pts[i][k]);
    }
    for (let i = 0; i < N; i++) pts[i] = next[i];
    bend = tightestBend(pts, closed);
  }
  // an ease is a corner opened into an arc; one that shortens the line by a tenth or carries a point
  // more than two radii is no longer the line that was drawn (a hairpin collapsed to a point), so it is
  // given up and the fold is reported as it stands
  const lineLen = (L) => { let t = 0; for (let i = 0; i < (closed ? N : N - 1); i++) t += segLen(L[i], L[(i + 1) % N]); return t; };
  let far = 0; for (let i = 0; i < N; i++) far = Math.max(far, segLen(pts[i], points[i]));
  if (lineLen(pts) < 0.9 * lineLen(points) || far > 2 * radius) return { points: points.map((p) => p.slice()), easedMM: 0, bend: before, passes, refused: true };
  let easedMM = 0;
  const moved = pts.map((p, i) => segLen(p, points[i]) > 1e-3);
  for (let i = 0; i < (closed ? N : N - 1); i++) { const j = (i + 1) % N; if (moved[i] || moved[j]) easedMM += segLen(points[i], points[j]); }
  return { points: pts, easedMM, bend, passes };
}

// Builds parallel transport orthonormal frames along a 3D point sequence.
// For closed curves, distributes any residual twist evenly so the frame closes seamlessly.
export function buildPipeFrames(points, closed = true) {
  const N = points.length;
  if (N < 2) throw new Error('buildPipeFrames: requires at least 2 points');

  const tangents = [];
  for (let i = 0; i < N; i++) {
    let prev, next;
    if (closed) {
      prev = points[(i - 1 + N) % N];
      next = points[(i + 1) % N];
    } else {
      prev = points[Math.max(0, i - 1)];
      next = points[Math.min(N - 1, i + 1)];
    }
    let tx = next[0] - prev[0], ty = next[1] - prev[1], tz = next[2] - prev[2];
    const len = Math.hypot(tx, ty, tz) || 1;
    tangents.push([tx / len, ty / len, tz / len]);
  }

  // Initial reference normal perpendicular to tangent 0
  const t0 = tangents[0];
  const up = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let n0x = up[1] * t0[2] - up[2] * t0[1];
  let n0y = up[2] * t0[0] - up[0] * t0[2];
  let n0z = up[0] * t0[1] - up[1] * t0[0];
  const l0 = Math.hypot(n0x, n0y, n0z) || 1;
  n0x /= l0; n0y /= l0; n0z /= l0;
  const b0x = t0[1] * n0z - t0[2] * n0y;
  const b0y = t0[2] * n0x - t0[0] * n0z;
  const b0z = t0[0] * n0y - t0[1] * n0x;

  const normals = [[n0x, n0y, n0z]];
  const binormals = [[b0x, b0y, b0z]];

  // Parallel transport along the curve
  for (let i = 0; i < N - 1; i++) {
    const tA = tangents[i], tB = tangents[i + 1];
    let vx = tA[1] * tB[2] - tA[2] * tB[1];
    let vy = tA[2] * tB[0] - tA[0] * tB[2];
    let vz = tA[0] * tB[1] - tA[1] * tB[0];
    const vl = Math.hypot(vx, vy, vz);
    let nA = normals[i], nB;
    if (vl > 1e-6) {
      vx /= vl; vy /= vl; vz /= vl;
      const dot = Math.max(-1, Math.min(1, tA[0] * tB[0] + tA[1] * tB[1] + tA[2] * tB[2]));
      const theta = Math.acos(dot);
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const dotVN = vx * nA[0] + vy * nA[1] + vz * nA[2];
      const cx = vy * nA[2] - vz * nA[1], cy = vz * nA[0] - vx * nA[2], cz = vx * nA[1] - vy * nA[0];
      nB = [
        nA[0] * cosT + cx * sinT + vx * dotVN * (1 - cosT),
        nA[1] * cosT + cy * sinT + vy * dotVN * (1 - cosT),
        nA[2] * cosT + cz * sinT + vz * dotVN * (1 - cosT)
      ];
    } else {
      nB = [nA[0], nA[1], nA[2]];
    }
    const nl = Math.hypot(nB[0], nB[1], nB[2]) || 1;
    nB = [nB[0] / nl, nB[1] / nl, nB[2] / nl];
    normals.push(nB);
    binormals.push([
      tB[1] * nB[2] - tB[2] * nB[1],
      tB[2] * nB[0] - tB[0] * nB[2],
      tB[0] * nB[1] - tB[1] * nB[0]
    ]);
  }

  // If closed loop, distribute holonomy (rotation discrepancy) around the ring
  if (closed && N > 2) {
    const nLast = normals[N - 1];
    const cosWrap = Math.max(-1, Math.min(1, nLast[0] * normals[0][0] + nLast[1] * normals[0][1] + nLast[2] * normals[0][2]));
    const sinWrap = (t0[0] * (nLast[1] * normals[0][2] - nLast[2] * normals[0][1]) +
                     t0[1] * (nLast[2] * normals[0][0] - nLast[0] * normals[0][2]) +
                     t0[2] * (nLast[0] * normals[0][1] - nLast[1] * normals[0][0]));
    const twist = Math.atan2(sinWrap, cosWrap);

    for (let i = 0; i < N; i++) {
      const frac = i / N;
      const a = -twist * frac;
      const cosA = Math.cos(a), sinA = Math.sin(a);
      const n = normals[i], b = binormals[i];
      normals[i] = [n[0] * cosA + b[0] * sinA, n[1] * cosA + b[1] * sinA, n[2] * cosA + b[2] * sinA];
      binormals[i] = [-n[0] * sinA + b[0] * cosA, -n[1] * sinA + b[1] * cosA, -n[2] * sinA + b[2] * cosA];
    }
  }

  return { tangents, normals, binormals };
}

// Sweeps a tubular mesh along a 3D path.
export function buildPipeTube(points, opts = {}) {
  const closed = opts.closed !== undefined ? !!opts.closed : true;
  const bad = pathProblem(points, closed);
  if (bad) return bad;
  const r0 = readNumber(opts, 'radius', 'Radius', 3.0);
  if (r0.error) return r0.error;
  const f0 = readNumber(opts, 'facets', 'Facets', 12);
  if (f0.error) return f0.error;
  const o0 = readNumber(opts, 'offset', 'Gap', 0);
  if (o0.error) return o0.error;
  const notes = [];
  const radius = Math.max(0.2, r0.value);
  if (radius !== r0.value) notes.push('Radius raised to 0.2 mm: the thinnest pipe that builds.');
  const facets = Math.max(4, Math.round(f0.value));
  const cap = opts.cap || 'round'; // 'round' | 'flat' | 'none'
  const offset = o0.value;
  // repeated points carry no direction and collapse their ring; the curve is the same without them
  const keep = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = keep.length ? points[keep[keep.length - 1]] : null;
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-9) keep.push(i);
  }
  if (closed && keep.length > 1) {
    const p = points[keep[keep.length - 1]], q = points[keep[0]];
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= 1e-9) keep.pop();
  }
  if (keep.length < (closed ? 3 : 2)) return refuse('degenerate_path', 'The line has no length.');
  const srcNormals = opts.surfaceNormals || null;
  const surfaceNormals = srcNormals ? keep.map((i) => srcNormals[i]) : null;
  // a radius per point (Radius at the heel, Toe radius at the toe), each floored like Radius
  let radii = null;
  if (Array.isArray(opts.radii) || ArrayBuffer.isView(opts.radii)) {
    if (opts.radii.length !== points.length || !Array.from(opts.radii).every((r) => Number.isFinite(r)))
      return refuse('bad_number', 'Radius along the line needs one number per point.');
    radii = keep.map((i) => Math.max(0.2, opts.radii[i]));
  }
  if (keep.length !== points.length) points = keep.map((i) => points[i]);
  const N = points.length;

  // a fold cannot print: the line is eased where it bends tighter than the radius, and only
  // there (opts.ease === false leaves it as asked and reports the fold)
  const rOf = (s) => (radii ? radii[s] : radius), rMax = radii ? Math.max(...radii) : radius;
  let bend = tightestBend(points, closed), eased = null;
  if (bend < rMax && opts.ease !== false) {
    eased = easeTightBends(points, closed, rMax);
    points = eased.points;
    bend = eased.bend;
    if (bend >= rMax && !(selfApproach(points, closed, rMax) < 2 * rMax)) notes.push(`Eased ${fmt(eased.easedMM)} mm of the line where it bent tighter than the radius.`);
  }
  const approach = selfApproach(points, closed, rMax);
  if (approach < 2 * rMax) notes.push(`The line comes back within ${fmt(approach)} mm of itself; the tube runs into its other run there.`);
  if (bend < rMax) notes.push(`Radius is larger than the line's tightest bend (${fmt(bend)} mm); the tube folds there.`);

  const { tangents, normals, binormals } = buildPipeFrames(points, closed);

  // with substrate normals the centerline rides radius*0.85 + gap above the surface
  const centers = [];
  for (let s = 0; s < N; s++) {
    const p = points[s];
    let cx = p[0], cy = p[1], cz = p[2];
    const sn = surfaceNormals && surfaceNormals[s];
    if (sn && Number.isFinite(sn[0]) && Number.isFinite(sn[1]) && Number.isFinite(sn[2])) {
      const shift = rOf(s) * 0.85 + offset;
      cx += sn[0] * shift;
      cy += sn[1] * shift;
      cz += sn[2] * shift;
    }
    centers.push([cx, cy, cz]);
  }

  const V_ring = N * facets;
  const hasCaps = !closed && cap !== 'none';
  const V_total = V_ring + (hasCaps ? 2 : 0);
  const positions = new Float32Array(V_total * 3);
  const vertNormals = new Float32Array(V_total * 3);

  for (let s = 0; s < N; s++) {
    const c = centers[s];
    const n = normals[s], b = binormals[s];
    for (let j = 0; j < facets; j++) {
      const angle = (j / facets) * Math.PI * 2;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const nx = cosA * b[0] + sinA * n[0];
      const ny = cosA * b[1] + sinA * n[1];
      const nz = cosA * b[2] + sinA * n[2];
      const idx = (s * facets + j) * 3;
      const rs = rOf(s);
      positions[idx]     = c[0] + rs * nx;
      positions[idx + 1] = c[1] + rs * ny;
      positions[idx + 2] = c[2] + rs * nz;
      vertNormals[idx]     = nx;
      vertNormals[idx + 1] = ny;
      vertNormals[idx + 2] = nz;
    }
  }

  let triCount = (closed ? N : (N - 1)) * facets * 2;
  if (hasCaps) triCount += 2 * facets;
  const indices = new Uint32Array(triCount * 3);
  let ptr = 0;

  // j turns from B toward N, i.e. about -T, so (j, s+1) winds outward
  const spans = closed ? N : (N - 1);
  for (let s = 0; s < spans; s++) {
    const nextS = (s + 1) % N;
    for (let j = 0; j < facets; j++) {
      const nextJ = (j + 1) % facets;
      const v00 = s * facets + j;
      const v01 = s * facets + nextJ;
      const v11 = nextS * facets + nextJ;
      const v10 = nextS * facets + j;
      indices[ptr++] = v00; indices[ptr++] = v11; indices[ptr++] = v01;
      indices[ptr++] = v00; indices[ptr++] = v10; indices[ptr++] = v11;
    }
  }

  if (hasCaps) {
    const startApex = V_ring;
    const endApex = V_ring + 1;
    const capDist = cap === 'round' ? rOf(0) : 0, capDistEnd = cap === 'round' ? rOf(N - 1) : 0;

    const t0 = tangents[0];
    const s0Idx = startApex * 3;
    positions[s0Idx]     = centers[0][0] - t0[0] * capDist;
    positions[s0Idx + 1] = centers[0][1] - t0[1] * capDist;
    positions[s0Idx + 2] = centers[0][2] - t0[2] * capDist;
    vertNormals[s0Idx]     = -t0[0];
    vertNormals[s0Idx + 1] = -t0[1];
    vertNormals[s0Idx + 2] = -t0[2];

    const tN = tangents[N - 1];
    const sNIdx = endApex * 3;
    positions[sNIdx]     = centers[N - 1][0] + tN[0] * capDistEnd;
    positions[sNIdx + 1] = centers[N - 1][1] + tN[1] * capDistEnd;
    positions[sNIdx + 2] = centers[N - 1][2] + tN[2] * capDistEnd;
    vertNormals[sNIdx]     = tN[0];
    vertNormals[sNIdx + 1] = tN[1];
    vertNormals[sNIdx + 2] = tN[2];

    for (let j = 0; j < facets; j++) {
      const nextJ = (j + 1) % facets;
      indices[ptr++] = startApex;
      indices[ptr++] = j;
      indices[ptr++] = nextJ;
    }
    const lastRingBase = (N - 1) * facets;
    for (let j = 0; j < facets; j++) {
      const nextJ = (j + 1) % facets;
      indices[ptr++] = lastRingBase + nextJ;
      indices[ptr++] = lastRingBase + j;
      indices[ptr++] = endApex;
    }
  }

  // the bend estimate misses some twisted corners: a wall face turned against its ring's
  // outward direction is a fold whatever the estimate said
  if (bend >= rMax) {
    for (let t = 0; t < spans * facets * 2; t++) {
      const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const out = (uy * vz - uz * vy) * (vertNormals[a] + vertNormals[b] + vertNormals[c]) +
                  (uz * vx - ux * vz) * (vertNormals[a + 1] + vertNormals[b + 1] + vertNormals[c + 1]) +
                  (ux * vy - uy * vx) * (vertNormals[a + 2] + vertNormals[b + 2] + vertNormals[c + 2]);
      if (out < 0) { notes.push(`The tube folds where the line bends tightest (${fmt(bend)} mm).`); break; }
    }
  }

  return finishMesh(positions, indices, vertNormals, notes, { count: 1, tightestBend: bend, easedMM: eased ? eased.easedMM : 0, radiusMin: radii ? Math.min(...radii) : radius, radiusMax: rMax, ringRadii: radii, facets });
}

// Evenly spaced stations along arc length for discrete repeated elements.
// 'spread' stretches the pitch so an open line ends on an element; 'exact' keeps the
// pitch and leaves the remainder (a chain cannot stretch without opening its links).
function resampleStations(points, closed, spacing, mode = 'spread') {
  const N = points.length;
  const segLens = [];
  let totalL = 0;
  for (let i = 0; i < (closed ? N : N - 1); i++) {
    const a = points[i], b = points[(i + 1) % N];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    segLens.push(d);
    totalL += d;
  }
  if (totalL < 1e-4) return { stations: [], length: totalL, capped: 0 };
  let K = closed ? Math.max(3, Math.round(totalL / spacing)) : Math.max(2, Math.floor(totalL / spacing + 1e-9) + 1);
  let capped = 0;
  if (K > MAX_ELEMENTS) { K = MAX_ELEMENTS; capped = closed ? totalL / K : totalL / (K - 1); }
  const step = closed ? totalL / K : (mode === 'exact' && !capped ? spacing : totalL / Math.max(1, K - 1));
  const stations = [];
  let acc = 0, segIdx = 0;
  for (let k = 0; k < K; k++) {
    const target = Math.min(totalL, k * step);
    // targets rise monotonically, so the segment walk resumes where it stopped
    while (segIdx < segLens.length - 1 && acc + segLens[segIdx] < target) {
      acc += segLens[segIdx];
      segIdx++;
    }
    const sl = segLens[segIdx];
    const f = sl > 1e-9 ? Math.min(1, (target - acc) / sl) : 0;
    const a = points[segIdx], b = points[(segIdx + 1) % N];
    const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const tl = Math.hypot(t[0], t[1], t[2]);
    t = tl > 1e-9 ? [t[0] / tl, t[1] / tl, t[2] / tl] : [1, 0, 0];
    stations.push({ pos: p, tan: t, segIdx, frac: f });
  }
  return { stations, length: totalL, capped, pitch: step };
}

const capNote = (capped, what) => `Spacing raised to ${fmt(capped)} mm: more than ${MAX_ELEMENTS} ${what}.`;

// Interpolates substrate surface normals and builds an orthonormal frame per station
function interpolateNormalsForStations(stations, points, surfaceNormals) {
  const N = points.length;
  return stations.map((st) => {
    let nx = 0, ny = 1, nz = 0;
    if (surfaceNormals && surfaceNormals.length === N) {
      const na = surfaceNormals[st.segIdx];
      const nb = surfaceNormals[(st.segIdx + 1) % N];
      if (na && nb && Number.isFinite(na[0]) && Number.isFinite(na[1]) && Number.isFinite(na[2]) &&
          Number.isFinite(nb[0]) && Number.isFinite(nb[1]) && Number.isFinite(nb[2])) {
        nx = na[0] * (1 - st.frac) + nb[0] * st.frac;
        ny = na[1] * (1 - st.frac) + nb[1] * st.frac;
        nz = na[2] * (1 - st.frac) + nb[2] * st.frac;
      }
    }
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-6) {
      nx /= nl; ny /= nl; nz /= nl;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    const t = st.tan;
    let bx = t[1] * nz - t[2] * ny, by = t[2] * nx - t[0] * nz, bz = t[0] * ny - t[1] * nx;
    const bl = Math.hypot(bx, by, bz);
    if (bl > 1e-6) {
      bx /= bl; by /= bl; bz /= bl;
    } else {
      const up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      bx = up[1] * t[2] - up[2] * t[1];
      by = up[2] * t[0] - up[0] * t[2];
      bz = up[0] * t[1] - up[1] * t[0];
      const l = Math.hypot(bx, by, bz) || 1;
      bx /= l; by /= l; bz /= l;
    }
    nx = by * t[2] - bz * t[1];
    ny = bz * t[0] - bx * t[2];
    nz = bx * t[1] - by * t[0];
    return { pos: st.pos, T: t, N: [nx, ny, nz], B: [bx, by, bz] };
  });
}

// shared front matter for the repeated elements: validated path, radius, spacing, gap
function elementInputs(points, opts, defaults) {
  const closed = opts.closed !== undefined ? !!opts.closed : defaults.closed;
  const bad = pathProblem(points, closed);
  if (bad) return { error: bad };
  const r = readNumber(opts, 'radius', 'Radius', defaults.radius);
  if (r.error) return r;
  const s = readNumber(opts, 'spacing', 'Spacing', null);
  if (s.error) return s;
  const o = readNumber(opts, 'offset', 'Gap', 0);
  if (o.error) return o;
  return { closed, radius: r.value, spacing: s.value, offset: o.value, surfaceNormals: opts.surfaceNormals || null, notes: [] };
}

// a spacing under the floor is raised to it, and the user is told why
function floorSpacing(asked, fallback, floor, why, notes) {
  const v = asked == null ? fallback : asked;
  if (v < floor - 1e-9) {
    if (asked != null) notes.push(`Spacing raised to ${fmt(floor)} mm: ${why}.`);
    return floor;
  }
  return v;
}

function floorRadius(asked, floor, what, notes) {
  if (asked < floor) { notes.push(`Radius raised to ${fmt(floor)} mm: the smallest ${what} that builds.`); return floor; }
  return asked;
}

// Generates spherical beads along a 3D path
export function buildBeadsAlongPath(points, opts = {}) {
  const inp = elementInputs(points, opts, { closed: true, radius: 2.5 });
  if (inp.error) return inp.error;
  const { closed, offset, surfaceNormals, notes } = inp;
  const radius = floorRadius(inp.radius, 0.4, 'bead', notes);
  const spacing = floorSpacing(inp.spacing, 8.0, radius * 2.1, 'beads would touch', notes);
  const nLat = 8, nLon = 12;

  const rs = resampleStations(points, closed, spacing);
  if (!rs.stations.length) return refuse('degenerate_path', 'The line has no length.');
  if (rs.capped) notes.push(capNote(rs.capped, 'beads'));
  const stations = interpolateNormalsForStations(rs.stations, points, surfaceNormals);

  const vertsPerBead = (nLat - 1) * nLon + 2;
  const trisPerBead = 2 * (nLat - 1) * nLon;
  const positions = new Float32Array(stations.length * vertsPerBead * 3);
  const normals = new Float32Array(stations.length * vertsPerBead * 3);
  const indices = new Uint32Array(stations.length * trisPerBead * 3);
  let vPtr = 0, iPtr = 0;

  for (const st of stations) {
    const vOffset = vPtr / 3;
    const lift = radius * 0.9 + offset;
    const cx = st.pos[0] + st.N[0] * lift;
    const cy = st.pos[1] + st.N[1] * lift;
    const cz = st.pos[2] + st.N[2] * lift;
    const put = (nx, ny, nz) => {
      positions[vPtr] = cx + radius * nx; positions[vPtr + 1] = cy + radius * ny; positions[vPtr + 2] = cz + radius * nz;
      normals[vPtr] = nx; normals[vPtr + 1] = ny; normals[vPtr + 2] = nz;
      vPtr += 3;
    };
    put(st.N[0], st.N[1], st.N[2]);
    for (let i = 1; i < nLat; i++) {
      const theta = (i / nLat) * Math.PI;
      const sinT = Math.sin(theta), cosT = Math.cos(theta);
      for (let j = 0; j < nLon; j++) {
        const phi = (j / nLon) * Math.PI * 2;
        const cosP = Math.cos(phi), sinP = Math.sin(phi);
        put(sinT * cosP * st.B[0] + cosT * st.N[0] + sinT * sinP * st.T[0],
            sinT * cosP * st.B[1] + cosT * st.N[1] + sinT * sinP * st.T[1],
            sinT * cosP * st.B[2] + cosT * st.N[2] + sinT * sinP * st.T[2]);
      }
    }
    put(-st.N[0], -st.N[1], -st.N[2]);
    const southIdx = vOffset + (nLat - 1) * nLon + 1;

    // phi turns from B toward T, i.e. about +N (B x T = N), so (j+1) before j at the north pole winds outward
    for (let j = 0; j < nLon; j++) {
      const nextJ = (j + 1) % nLon;
      indices[iPtr++] = vOffset; indices[iPtr++] = vOffset + 1 + j; indices[iPtr++] = vOffset + 1 + nextJ;
    }
    for (let i = 1; i < nLat - 1; i++) {
      const r1 = vOffset + 1 + (i - 1) * nLon;
      const r2 = vOffset + 1 + i * nLon;
      for (let j = 0; j < nLon; j++) {
        const nextJ = (j + 1) % nLon;
        indices[iPtr++] = r1 + j; indices[iPtr++] = r2 + j; indices[iPtr++] = r2 + nextJ;
        indices[iPtr++] = r1 + j; indices[iPtr++] = r2 + nextJ; indices[iPtr++] = r1 + nextJ;
      }
    }
    const lastRing = vOffset + 1 + (nLat - 2) * nLon;
    for (let j = 0; j < nLon; j++) {
      const nextJ = (j + 1) % nLon;
      indices[iPtr++] = lastRing + nextJ; indices[iPtr++] = lastRing + j; indices[iPtr++] = southIdx;
    }
  }

  return finishMesh(positions, indices, normals, notes, { count: stations.length });
}

// Generates eyelet grommets (tori lying on the surface) along a 3D path.
// Radius is the hole's radius: the torus is major 1.5r, minor 0.5r, so hole = 2r, OD = 4r
// (the 2.5 mm default gives a 5 mm hole and 10 mm OD, a common shoe eyelet).
export function buildEyeletsAlongPath(points, opts = {}) {
  const inp = elementInputs(points, opts, { closed: true, radius: 2.5 });
  if (inp.error) return inp.error;
  const { closed, offset, surfaceNormals, notes } = inp;
  const holeR = floorRadius(inp.radius, 0.4, 'eyelet', notes);
  const majorR = holeR * 1.5, minorR = holeR * 0.5;
  const od = 2 * (majorR + minorR);
  const spacing = floorSpacing(inp.spacing, od * 1.6, od * 1.1, 'eyelets would overlap', notes);
  const nMajor = 16, nMinor = 8;

  const rs = resampleStations(points, closed, spacing);
  if (!rs.stations.length) return refuse('degenerate_path', 'The line has no length.');
  if (rs.capped) notes.push(capNote(rs.capped, 'eyelets'));
  const stations = interpolateNormalsForStations(rs.stations, points, surfaceNormals);

  const vertsPerTorus = nMajor * nMinor;
  const positions = new Float32Array(stations.length * vertsPerTorus * 3);
  const normals = new Float32Array(stations.length * vertsPerTorus * 3);
  const indices = new Uint32Array(stations.length * vertsPerTorus * 2 * 3);
  let vPtr = 0, iPtr = 0;

  for (const st of stations) {
    const vOffset = vPtr / 3;
    const lift = minorR + offset;
    const cx = st.pos[0] + st.N[0] * lift;
    const cy = st.pos[1] + st.N[1] * lift;
    const cz = st.pos[2] + st.N[2] * lift;
    for (let i = 0; i < nMajor; i++) {
      const u = (i / nMajor) * Math.PI * 2;
      const cosU = Math.cos(u), sinU = Math.sin(u);
      const rx = cosU * st.B[0] + sinU * st.T[0];
      const ry = cosU * st.B[1] + sinU * st.T[1];
      const rz = cosU * st.B[2] + sinU * st.T[2];
      for (let j = 0; j < nMinor; j++) {
        const v = (j / nMinor) * Math.PI * 2;
        const cosV = Math.cos(v), sinV = Math.sin(v);
        const nx = cosV * rx + sinV * st.N[0];
        const ny = cosV * ry + sinV * st.N[1];
        const nz = cosV * rz + sinV * st.N[2];
        positions[vPtr]     = cx + majorR * rx + minorR * nx;
        positions[vPtr + 1] = cy + majorR * ry + minorR * ny;
        positions[vPtr + 2] = cz + majorR * rz + minorR * nz;
        normals[vPtr] = nx; normals[vPtr + 1] = ny; normals[vPtr + 2] = nz;
        vPtr += 3;
      }
    }
    for (let i = 0; i < nMajor; i++) {
      const nextI = (i + 1) % nMajor;
      for (let j = 0; j < nMinor; j++) {
        const nextJ = (j + 1) % nMinor;
        const v00 = vOffset + i * nMinor + j;
        const v01 = vOffset + i * nMinor + nextJ;
        const v10 = vOffset + nextI * nMinor + j;
        const v11 = vOffset + nextI * nMinor + nextJ;
        indices[iPtr++] = v00; indices[iPtr++] = v10; indices[iPtr++] = v11;
        indices[iPtr++] = v00; indices[iPtr++] = v11; indices[iPtr++] = v01;
      }
    }
  }

  return finishMesh(positions, indices, normals, notes, { count: stations.length, holeMM: 2 * holeR, odMM: od });
}

// Generates zipper teeth: two tapes either side of the line, teeth alternating between
// them every half pitch, each tooth reaching past the center line between two of the
// other side's (how a coil or metal zipper meshes). Spacing is the pitch along one tape;
// Radius sets the chain: width 2.4r, tooth height 1.2r (r = 2.5 gives a #5-like 6 mm chain).
export function buildZipperAlongPath(points, opts = {}) {
  const inp = elementInputs(points, opts, { closed: false, radius: 2.5 });
  if (inp.error) return inp.error;
  const { closed, offset, surfaceNormals, notes } = inp;
  const radius = floorRadius(inp.radius, 0.4, 'zipper', notes);
  const pitch = floorSpacing(inp.spacing, 3.0, 1.0, 'teeth this small do not build', notes);
  const chainW = radius * 2.4;
  const toothH = radius * 1.2;
  const toothL = pitch * 0.4;  // two teeth per pitch leave a 0.1-pitch gap either side
  const reach = chainW * 0.12; // how far a tooth crosses the center line

  const rs = resampleStations(points, closed, pitch / 2, 'exact');
  if (!rs.stations.length) return refuse('degenerate_path', 'The line has no length.');
  if (rs.capped) notes.push(capNote(rs.capped * 2, 'teeth'));
  // a closed tape needs an even count so the sides keep alternating across the seam
  let raw = rs.stations;
  if (closed && raw.length % 2) raw = resampleStations(points, true, rs.length / (raw.length + 1)).stations;
  const stations = interpolateNormalsForStations(raw, points, surfaceNormals);
  // on a bend the inner tape's teeth close up; below 2.5 chain widths they meet
  const bend = tightestBend(points, closed);
  if (bend < 2.5 * chainW) notes.push(`The line bends tighter than the zipper can follow (${fmt(bend)} mm); teeth touch there.`);

  const positions = new Float32Array(stations.length * 8 * 3);
  const normals = new Float32Array(stations.length * 8 * 3);
  const indices = new Uint32Array(stations.length * 12 * 3);
  let vPtr = 0, iPtr = 0;
  // corners in the right-handed (T, N, B) frame; each face winds outward
  const boxInds = [
    0, 3, 2, 0, 2, 1, // -B
    4, 5, 6, 4, 6, 7, // +B
    0, 4, 7, 0, 7, 3, // -T
    1, 2, 6, 1, 6, 5, // +T
    0, 1, 5, 0, 5, 4, // -N
    3, 7, 6, 3, 6, 2  // +N
  ];

  for (let k = 0; k < stations.length; k++) {
    const st = stations[k];
    const vOffset = vPtr / 3;
    const side = k % 2 === 0 ? -1 : 1;
    // a tooth spans from its own tape edge to `reach` past the center line
    const b0 = side < 0 ? -chainW / 2 : -reach;
    const b1 = side < 0 ? reach : chainW / 2;
    const hT = toothL / 2;
    const n0 = offset, n1 = offset + toothH;
    const corners = [
      [-hT, n0, b0], [hT, n0, b0], [hT, n1, b0], [-hT, n1, b0],
      [-hT, n0, b1], [hT, n0, b1], [hT, n1, b1], [-hT, n1, b1],
    ];
    const mid = [0, (n0 + n1) / 2, (b0 + b1) / 2];
    for (const cr of corners) {
      positions[vPtr]     = st.pos[0] + cr[0] * st.T[0] + cr[1] * st.N[0] + cr[2] * st.B[0];
      positions[vPtr + 1] = st.pos[1] + cr[0] * st.T[1] + cr[1] * st.N[1] + cr[2] * st.B[1];
      positions[vPtr + 2] = st.pos[2] + cr[0] * st.T[2] + cr[1] * st.N[2] + cr[2] * st.B[2];
      const d = [cr[0] - mid[0], cr[1] - mid[1], cr[2] - mid[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      normals[vPtr]     = (d[0] * st.T[0] + d[1] * st.N[0] + d[2] * st.B[0]) / dl;
      normals[vPtr + 1] = (d[0] * st.T[1] + d[1] * st.N[1] + d[2] * st.B[1]) / dl;
      normals[vPtr + 2] = (d[0] * st.T[2] + d[1] * st.N[2] + d[2] * st.B[2]) / dl;
      vPtr += 3;
    }
    for (let b = 0; b < 36; b++) indices[iPtr++] = vOffset + boxInds[b];
  }

  return finishMesh(positions, indices, normals, notes, { count: stations.length, pitchMM: pitch, widthMM: chainW });
}

// Generates criss-cross lacing down an OPEN line (the throat's center line): eyelet
// pairs either side of the line, cords between them arching over each other at the
// crossings. A closed rim loop has no throat to lace across, so it is refused.
export function buildLacesAlongPath(points, opts = {}) {
  const inp = elementInputs(points, opts, { closed: false, radius: 1.5 });
  if (inp.error) return inp.error;
  if (inp.closed) return refuse('laces_closed', 'Laces need an open line down the throat.');
  const { offset, surfaceNormals, notes } = inp;
  const radius = floorRadius(inp.radius, 0.4, 'lace', notes);
  const spacing = floorSpacing(inp.spacing, 14.0, 6.0, 'eyelet rows would crowd', notes);
  const pattern = opts.pattern || 'crisscross'; // 'crisscross' | 'ladder'
  const w0 = readNumber(opts, 'width', 'Width', 30);
  if (w0.error) return w0.error;
  // eyelet rows sit 25-35 mm apart across a real throat
  const width = Math.min(35, Math.max(25, w0.value));
  if (width !== w0.value) notes.push(`Row separation set to ${fmt(width)} mm: lacing rows sit 25 to 35 mm apart.`);

  const rs = resampleStations(points, false, spacing);
  if (!rs.stations.length) return refuse('degenerate_path', 'The line has no length.');
  if (rs.capped) notes.push(capNote(rs.capped, 'eyelet rows'));
  const stations = interpolateNormalsForStations(rs.stations, points, surfaceNormals);

  // eyelet k on the left pairs with eyelet k on the right (k with N-k counting round both
  // sides); the cord end rides one lace radius above the surface so it rests on it
  const halfW = width * 0.5, lift = radius + offset;
  const side = (st, s) => ({
    pos: [st.pos[0] + s * halfW * st.B[0] + lift * st.N[0],
          st.pos[1] + s * halfW * st.B[1] + lift * st.N[1],
          st.pos[2] + s * halfW * st.B[2] + lift * st.N[2]],
    N: st.N,
  });
  const leftStations = stations.map((st) => side(st, -1));
  const rightStations = stations.map((st) => side(st, 1));
  const numPairs = stations.length;
  if (numPairs < 2) return refuse('degenerate_path', 'The line is too short for two rows of laces.');

  // a quadratic Bezier through an elevated midpoint
  const makeCordTube = (p0, p1, midElevation, nNormal) => {
    const n = nNormal;
    const pMid = [
      (p0[0] + p1[0]) * 0.5 + n[0] * midElevation,
      (p0[1] + p1[1]) * 0.5 + n[1] * midElevation,
      (p0[2] + p1[2]) * 0.5 + n[2] * midElevation,
    ];
    const ctrl = [0, 1, 2].map((q) => 2 * pMid[q] - 0.5 * (p0[q] + p1[q]));
    const cordPts = [];
    for (let s = 0; s < 7; s++) {
      const t = s / 6, omt = 1 - t;
      cordPts.push([0, 1, 2].map((q) => omt * omt * p0[q] + 2 * omt * t * ctrl[q] + t * t * p1[q]));
    }
    return buildPipeTube(cordPts, { radius, facets: 8, cap: 'round', closed: false });
  };
  const avg = (...ns) => {
    const v = [0, 1, 2].map((q) => ns.reduce((s, n) => s + n[q], 0));
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  const tubes = [];
  tubes.push(makeCordTube(leftStations[0].pos, rightStations[0].pos, radius * 0.5, avg(leftStations[0].N, rightStations[0].N)));
  for (let k = 0; k < numPairs - 1; k++) {
    const lCurr = leftStations[k], rCurr = rightStations[k];
    const lNext = leftStations[k + 1], rNext = rightStations[k + 1];
    const avgN = avg(lCurr.N, rCurr.N, lNext.N, rNext.N);
    if (pattern === 'ladder') {
      tubes.push(makeCordTube(lNext.pos, rNext.pos, radius * 0.5, avgN));
      tubes.push(makeCordTube(lCurr.pos, lNext.pos, 0, lCurr.N));
      tubes.push(makeCordTube(rCurr.pos, rNext.pos, 0, rCurr.N));
    } else {
      // alternate which diagonal passes over so the two never cut each other
      const leftOver = (k % 2 === 0);
      const underLift = radius * 0.5;
      const overLift = radius * 3.0;
      tubes.push(makeCordTube(lCurr.pos, rNext.pos, leftOver ? overLift : underLift, avgN));
      tubes.push(makeCordTube(rCurr.pos, lNext.pos, leftOver ? underLift : overLift, avgN));
    }
  }

  let totalVerts = 0, totalTris = 0;
  for (const t of tubes) {
    if (!t.ok) return t;
    totalVerts += t.positions.length / 3;
    totalTris += t.indices.length / 3;
  }
  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedNorm = new Float32Array(totalVerts * 3);
  const mergedInds = new Uint32Array(totalTris * 3);
  let vPtr = 0, iPtr = 0;
  for (const t of tubes) {
    const vOffset = vPtr / 3;
    mergedPos.set(t.positions, vPtr);
    mergedNorm.set(t.normals, vPtr);
    vPtr += t.positions.length;
    for (let i = 0; i < t.indices.length; i++) mergedInds[iPtr++] = vOffset + t.indices[i];
  }

  return finishMesh(mergedPos, mergedInds, mergedNorm, notes, { count: tubes.length, rows: numPairs, widthMM: width });
}

// true when two closed polylines come closer than `limit`; segments outside the other's
// box grown by `limit` are skipped, so only the overlapping ends are measured
function spinesCloserThan(A, B, limit) {
  const box = (L) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of L) for (let q = 0; q < 3; q++) { if (p[q] < b[q]) b[q] = p[q]; if (p[q] > b[q + 3]) b[q + 3] = p[q]; }
    return b;
  };
  const near = (p, q, b) => {
    for (let k = 0; k < 3; k++) if (Math.max(p[k], q[k]) < b[k] - limit || Math.min(p[k], q[k]) > b[k + 3] + limit) return false;
    return true;
  };
  const bA = box(A), bB = box(B);
  const segA = [], segB = [];
  for (let i = 0; i < A.length; i++) if (near(A[i], A[(i + 1) % A.length], bB)) segA.push(i);
  for (let j = 0; j < B.length; j++) if (near(B[j], B[(j + 1) % B.length], bA)) segB.push(j);
  const lim2 = limit * limit;
  for (const i of segA) {
    const p1 = A[i], q1 = A[(i + 1) % A.length];
    for (const j of segB) {
      const p2 = B[j], q2 = B[(j + 1) % B.length];
      const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
      const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
      const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2], e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2], c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
      const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2], den = a * e - b * b;
      let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      let t = e > 1e-12 ? (b * s + f) / e : 0;
      if (t < 0) { t = 0; s = a > 1e-12 ? Math.min(1, Math.max(0, -c / a)) : 0; } else if (t > 1) { t = 1; s = a > 1e-12 ? Math.min(1, Math.max(0, (b - c) / a)) : 0; }
      const dx = r[0] + d1[0] * s - d2[0] * t, dy = r[1] + d1[1] * s - d2[1] * t, dz = r[2] + d1[2] * s - d2[2] * t;
      if (dx * dx + dy * dy + dz * dz < lim2) return true;
    }
  }
  return false;
}

// Generates an interlocking cable chain: oval links alternating flat and upright (90°),
// each passing through its neighbours' ends.
// Link sizes are on the wire's centerline: length L, width W, so the ends are half
// circles of W/2 joined by straights of (L - W). Inside, a link is (L - d) x (W - d) for
// wire diameter d. A neighbour's wire sits in each end, so the pitch must stay within
// 0.85-0.95 of the inside length: longer and the links pull apart, shorter and link k
// meets link k+2 (same plane) through the one between them.
// Spacing is the pitch; without an explicit length the link is sized to it.
export function buildChainAlongPath(points, opts = {}) {
  const inp = elementInputs(points, opts, { closed: false, radius: 1.2 });
  if (inp.error) return inp.error;
  const { closed, offset, surfaceNormals, notes } = inp;
  const l0 = readNumber(opts, 'length', 'Link length', null);
  if (l0.error) return l0.error;
  const wd0 = readNumber(opts, 'width', 'Link width', null);
  if (wd0.error) return wd0.error;
  const wireR = floorRadius(inp.radius, 0.3, 'chain wire', notes);
  const d = 2 * wireR;
  const innerW = wd0.value != null ? wd0.value - d : 1.5 * d;
  if (innerW < 1.15 * d) return refuse('chain_too_small', `Links this narrow cannot interlock: the inside must be wider than the ${fmt(d)} mm wire.`);
  // below 2.9 wires the k and k+2 links meet even at the tightest legal pitch
  const minInnerL = 2.9 * d;
  let innerL;
  if (l0.value != null) {
    innerL = l0.value - d;
    if (innerL < minInnerL) return refuse('chain_too_small', `Links this short cannot interlock: the length needs at least ${fmt(minInnerL + d)} mm for a ${fmt(d)} mm wire.`);
  } else {
    const askedPitch = inp.spacing != null ? inp.spacing : 0.9 * 3.4 * d;
    innerL = askedPitch / 0.9;
    if (innerL < minInnerL) {
      innerL = minInnerL;
      if (inp.spacing != null) notes.push(`Spacing raised to ${fmt(0.9 * minInnerL)} mm: shorter links cannot interlock on a ${fmt(d)} mm wire.`);
    }
  }
  let pitch = inp.spacing != null && l0.value != null ? inp.spacing : 0.9 * innerL;
  const pLo = 0.85 * innerL, pHi = 0.95 * innerL;
  if (pitch < pLo || pitch > pHi) {
    pitch = Math.min(pHi, Math.max(pLo, pitch));
    notes.push(`Spacing set to ${fmt(pitch)} mm: links of this length interlock at ${fmt(pLo)} to ${fmt(pHi)} mm.`);
  }
  const linkW = innerW + d;

  // joints sit one pitch apart along the line and each link spans two of them on the
  // chord, so the chain bends at the joints the way a real one pivots
  let rs = resampleStations(points, closed, pitch, 'exact');
  if (!rs.stations.length) return refuse('degenerate_path', 'The line has no length.');
  if (rs.capped) return refuse('chain_too_long', `The line takes more than ${MAX_ELEMENTS} links; raise the radius or spacing.`);
  if (!closed && rs.length < pitch - 1e-6) return refuse('degenerate_path', `The line is shorter than one link (${fmt(pitch)} mm).`);
  if (closed) {
    // flat and upright must alternate across the seam, so a loop takes an even count
    const K = rs.stations.length;
    if (K % 2) {
      // one more link if the shorter pitch still interlocks, else one fewer
      const up = rs.length / (K + 1);
      const fits = l0.value == null ? up / 0.9 >= minInnerL : Math.abs(up - 0.9 * innerL) <= Math.abs(rs.length / (K - 1) - 0.9 * innerL);
      rs = resampleStations(points, true, rs.length / (fits ? K + 1 : K - 1));
    }
    if (l0.value == null) {
      // a link sized to the spacing follows the loop's even division
      innerL = rs.pitch / 0.9;
    } else if (rs.pitch < pLo - 1e-6 || rs.pitch > pHi + 1e-6) {
      notes.push(`Links on this loop sit ${fmt(rs.pitch)} mm apart; they interlock at ${fmt(pLo)} to ${fmt(pHi)} mm.`);
    }
    pitch = rs.pitch;
  }
  const joints = interpolateNormalsForStations(rs.stations, points, surfaceNormals);
  const nLinks = closed ? joints.length : joints.length - 1;
  const links = [];
  for (let k = 0; k < nLinks; k++) {
    const a = joints[k], b = joints[(k + 1) % joints.length];
    let T = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
    const tl = Math.hypot(T[0], T[1], T[2]) || 1;
    T = [T[0] / tl, T[1] / tl, T[2] / tl];
    let Nn = [a.N[0] + b.N[0], a.N[1] + b.N[1], a.N[2] + b.N[2]];
    const nd = Nn[0] * T[0] + Nn[1] * T[1] + Nn[2] * T[2];
    Nn = [Nn[0] - nd * T[0], Nn[1] - nd * T[1], Nn[2] - nd * T[2]];
    const nl = Math.hypot(Nn[0], Nn[1], Nn[2]);
    Nn = nl > 1e-6 ? [Nn[0] / nl, Nn[1] / nl, Nn[2] / nl] : a.N;
    const B = [T[1] * Nn[2] - T[2] * Nn[1], T[2] * Nn[0] - T[0] * Nn[2], T[0] * Nn[1] - T[1] * Nn[0]];
    links.push({ pos: [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2, (a.pos[2] + b.pos[2]) / 2], T, N: Nn, B });
  }
  // sharpest turn between neighbouring links, for the note's bend radius
  let worst = 0;
  for (let k = 0; k < links.length - (closed ? 0 : 1); k++) {
    const t1 = links[k].T, t2 = links[(k + 1) % links.length].T;
    worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]))));
  }
  const stations = links;
  const linkLFinal = innerL + d;

  const R_end = linkW / 2, h = (linkLFinal - linkW) / 2;
  const S_straight = 4, S_arc = 8;
  const spine2D = [], tangent2D = [];
  for (let i = 0; i < S_straight; i++) {
    spine2D.push([-h + 2 * h * (i / S_straight), R_end]); tangent2D.push([1, 0]);
  }
  for (let i = 0; i < S_arc; i++) {
    const th = Math.PI * 0.5 - (i / S_arc) * Math.PI;
    spine2D.push([h + R_end * Math.cos(th), R_end * Math.sin(th)]); tangent2D.push([Math.sin(th), -Math.cos(th)]);
  }
  for (let i = 0; i < S_straight; i++) {
    spine2D.push([h - 2 * h * (i / S_straight), -R_end]); tangent2D.push([-1, 0]);
  }
  for (let i = 0; i < S_arc; i++) {
    const th = -Math.PI * 0.5 - (i / S_arc) * Math.PI;
    spine2D.push([-h + R_end * Math.cos(th), R_end * Math.sin(th)]); tangent2D.push([Math.sin(th), -Math.cos(th)]);
  }

  const nSpine = spine2D.length, nCircle = 8;
  const vertsPerLink = nSpine * nCircle;
  const positions = new Float32Array(stations.length * vertsPerLink * 3);
  const normals = new Float32Array(stations.length * vertsPerLink * 3);
  const indices = new Uint32Array(stations.length * vertsPerLink * 2 * 3);
  let vPtr = 0, iPtr = 0;
  // the upright links touch the surface; the flat ones ride on the same axis line
  const lift = R_end + wireR + offset;
  const spines = [];

  for (let k = 0; k < stations.length; k++) {
    const st = stations[k];
    const vOffset = vPtr / 3;
    const cx = st.pos[0] + st.N[0] * lift;
    const cy = st.pos[1] + st.N[1] * lift;
    const cz = st.pos[2] + st.N[2] * lift;
    // flat links lie in (T, B), upright ones in (T, N)
    const upright = k % 2 === 1;
    const B_k = upright ? st.N : st.B;
    const N_k = upright ? [-st.B[0], -st.B[1], -st.B[2]] : st.N;
    const spine = [];
    spines.push(spine);

    for (let s = 0; s < nSpine; s++) {
      const u = spine2D[s][0], v = spine2D[s][1];
      const tu = tangent2D[s][0], tv = tangent2D[s][1];
      const px = cx + st.T[0] * u + B_k[0] * v;
      const py = cy + st.T[1] * u + B_k[1] * v;
      const pz = cz + st.T[2] * u + B_k[2] * v;
      spine.push([px, py, pz]);
      let tx = st.T[0] * tu + B_k[0] * tv;
      let ty = st.T[1] * tu + B_k[1] * tv;
      let tz = st.T[2] * tu + B_k[2] * tv;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      let ax = ty * N_k[2] - tz * N_k[1];
      let ay = tz * N_k[0] - tx * N_k[2];
      let az = tx * N_k[1] - ty * N_k[0];
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      for (let j = 0; j < nCircle; j++) {
        const psi = (j / nCircle) * Math.PI * 2;
        const cosPsi = Math.cos(psi), sinPsi = Math.sin(psi);
        const nx = cosPsi * N_k[0] + sinPsi * ax;
        const ny = cosPsi * N_k[1] + sinPsi * ay;
        const nz = cosPsi * N_k[2] + sinPsi * az;
        positions[vPtr]     = px + wireR * nx;
        positions[vPtr + 1] = py + wireR * ny;
        positions[vPtr + 2] = pz + wireR * nz;
        normals[vPtr] = nx; normals[vPtr + 1] = ny; normals[vPtr + 2] = nz;
        vPtr += 3;
      }
    }
    // psi turns from N_k toward (t x N_k), i.e. about -t, so (s+1, j) before (s, j+1) winds outward
    for (let s = 0; s < nSpine; s++) {
      const nextS = (s + 1) % nSpine;
      for (let j = 0; j < nCircle; j++) {
        const nextJ = (j + 1) % nCircle;
        const v00 = vOffset + s * nCircle + j;
        const v01 = vOffset + s * nCircle + nextJ;
        const v10 = vOffset + nextS * nCircle + j;
        const v11 = vOffset + nextS * nCircle + nextJ;
        indices[iPtr++] = v00; indices[iPtr++] = v11; indices[iPtr++] = v10;
        indices[iPtr++] = v00; indices[iPtr++] = v01; indices[iPtr++] = v11;
      }
    }
  }

  // measured, not estimated: wire centerlines of neighbours and of k/k+2 (same plane)
  // must stay a wire apart; a bend sharper than the links can swing makes them touch
  let touching = 0;
  for (let k = 0; k < spines.length; k++) {
    for (const step of [1, 2]) {
      if (!closed && k + step >= spines.length) continue;
      if (spinesCloserThan(spines[k], spines[(k + step) % spines.length], d - 1e-3)) { touching++; break; }
    }
  }
  if (touching) {
    const where = worst > 1e-6 ? ` (about ${fmt(pitch / (2 * Math.sin(worst / 2)))} mm)` : '';
    notes.push(`The line bends tighter than the chain can follow${where}; links touch there.`);
  }

  return finishMesh(positions, indices, normals, notes, {
    count: stations.length, pitchMM: pitch, linkLengthMM: linkLFinal + d, linkWidthMM: linkW + d, wireMM: d,
  });
}

// Extracts the 3D boundary loop(s) of a covered region on a substrate mesh.
// Returns an array of 3D point loops: [ [[x,y,z], ...], ... ]
export function extractSubstrateLoops(sub, coverage) {
  const V = sub.positions.length / 3;
  const cov0 = new Float64Array(V);
  for (let i = 0; i < V; i++) cov0[i] = coverage[i] - 0.5;

  const r = refineAtIsoline(sub.positions, sub.indices, cov0);
  const side = triangleSides(r.indices, r.values);
  const loops = boundaryLoops(r.indices, Array.from(side, (s) => s > 0));

  const P = r.positions;
  const out = loops.map((L) => {
    let ySum = 0, per = 0;
    const pts = [];
    for (let k = 0; k < L.length; k++) {
      const idx = L[k] * 3;
      const nextIdx = L[(k + 1) % L.length] * 3;
      const x = P[idx], y = P[idx + 1], z = P[idx + 2];
      pts.push([x, y, z]);
      ySum += y;
      per += Math.hypot(P[nextIdx] - x, P[nextIdx + 1] - y, P[nextIdx + 2] - z);
    }
    return {
      points: pts,
      perimeter: per,
      meanY: ySum / L.length,
      count: L.length
    };
  });

  return out;
}

// Nearest substrate vertex per query point through a uniform grid of ~2 vertices per
// cell: rings of cells are searched outward until no closer cell can remain. The brute
// scan was O(points x vertices) on the main thread at every slider tick.
export function nearestVertexFinder(positions) {
  const V = positions.length / 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < V; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const ex = Math.max(x1 - x0, 1e-6), ey = Math.max(y1 - y0, 1e-6), ez = Math.max(z1 - z0, 1e-6);
  // cell edge from the box volume, floored so a flat sheet does not explode the count
  const cell = Math.max(Math.cbrt((ex * ey * ez) / Math.max(1, V / 2)), Math.max(ex, ey, ez) / 256);
  const nx = Math.max(1, Math.ceil(ex / cell)), ny = Math.max(1, Math.ceil(ey / cell)), nz = Math.max(1, Math.ceil(ez / cell));
  const cellOf = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / cell)));
  const start = new Int32Array(nx * ny * nz + 1);
  const key = new Int32Array(V);
  for (let i = 0; i < V; i++) {
    const k = (cellOf(positions[3 * i], x0, nx) * ny + cellOf(positions[3 * i + 1], y0, ny)) * nz + cellOf(positions[3 * i + 2], z0, nz);
    key[i] = k;
    start[k + 1]++;
  }
  for (let k = 0; k < nx * ny * nz; k++) start[k + 1] += start[k];
  const fill = start.slice(0, nx * ny * nz);
  const items = new Int32Array(V);
  for (let i = 0; i < V; i++) items[fill[key[i]]++] = i;

  return (p) => {
    const cx = cellOf(p[0], x0, nx), cy = cellOf(p[1], y0, ny), cz = cellOf(p[2], z0, nz);
    // a point outside the box starts that far from its clamped cell
    const out = Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(y0 - p[1], 0, p[1] - y1), Math.max(z0 - p[2], 0, p[2] - z1));
    let best = -1, bd = Infinity;
    const maxRing = Math.max(nx, ny, nz);
    for (let r = 0; r <= maxRing; r++) {
      // every unvisited cell is at least (r - 1) cells, and the box gap, away from the query
      const reach = Math.max(out, (r - 1) * cell);
      if (best >= 0 && reach > 0 && reach * reach > bd) break;
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= nx) continue;
        for (let j = cy - r; j <= cy + r; j++) {
          if (j < 0 || j >= ny) continue;
          const shell = Math.abs(i - cx) === r || Math.abs(j - cy) === r;
          for (let k = cz - r; k <= cz + r; k += (shell ? 1 : Math.max(1, 2 * r))) {
            if (k < 0 || k >= nz) continue;
            const c = (i * ny + j) * nz + k;
            for (let q = start[c]; q < start[c + 1]; q++) {
              const v = items[q];
              const d = (positions[3 * v] - p[0]) ** 2 + (positions[3 * v + 1] - p[1]) ** 2 + (positions[3 * v + 2] - p[2]) ** 2;
              if (d < bd) { bd = d; best = v; }
            }
          }
        }
      }
    }
    return best;
  };
}

// Radius at the heel end of the line, Toe radius at its toe end (the last's +X), eased by a
// smoothstep over the line's own length along the last: piping fat at the heel, fine at the toe.
export function radiiHeelToToe(points, heelR, toeR) {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; }
  const span = hi - lo;
  return points.map((p) => {
    const t = span > 1e-9 ? (p[0] - lo) / span : 0, s = t * t * (3 - 2 * t);
    return heelR + (toeR - heelR) * s;
  });
}

const STYLES = new Set(['tube', 'beads', 'eyelets', 'zipper', 'laces', 'chain']);

// Complete end-to-end builder for a pipe layer on a substrate.
// Returns the plate worker contract plus `notes`; a refusal is { ok: false, reason, message }.
// pipeSpacing null/undefined gives each element its own default pitch.
export function buildPipePlate(sub, coverage, layerOpts = {}) {
  const style = layerOpts.pipeStyle || 'tube';
  if (!STYLES.has(style)) return refuse('unknown_style', `There is no "${style}" element.`);
  const r0 = readNumber(layerOpts, 'pipeRadius', 'Radius', layerOpts.wall != null ? layerOpts.wall * 1.5 : 2.5);
  if (r0.error) return r0.error;
  const s0 = readNumber(layerOpts, 'pipeSpacing', 'Spacing', null);
  if (s0.error) return s0.error;
  const g0 = readNumber(layerOpts, 'gap', 'Gap', 0);
  if (g0.error) return g0.error;
  const t0 = readNumber(layerOpts, 'pipeToeRadius', 'Toe radius', null);
  if (t0.error) return t0.error;
  const radius = r0.value, gap = g0.value, spacing = s0.value, toeRadius = t0.value;
  const cap = layerOpts.pipeCap || 'round';
  const facets = layerOpts.pipeFacets || 12;
  const sampleCount = layerOpts.pipeSamples || 64;

  let pathPoints = null;
  let closed = true;

  if (layerOpts.points && layerOpts.points.length) {
    pathPoints = layerOpts.points;
    closed = !!layerOpts.closed;
  } else {
    const loops = extractSubstrateLoops(sub, coverage);
    if (!loops || loops.length === 0) {
      return refuse('no_loops', 'No boundary rim found for pipe region.');
    }
    // a collar or topline takes the highest loop, anything else the longest
    let picked;
    if (layerOpts.region === 'collar' || layerOpts.collarMM) {
      picked = loops.reduce((best, l) => (!best || l.meanY > best.meanY ? l : best), null);
    } else {
      picked = loops.reduce((best, l) => (!best || l.perimeter > best.perimeter ? l : best), null);
    }
    pathPoints = resampleClosed(picked.points, sampleCount).points;
    closed = true;
  }

  const bad = pathProblem(pathPoints, closed);
  if (bad) return bad;
  let totalPathLen = 0;
  for (let s = 0; s < (closed ? pathPoints.length : pathPoints.length - 1); s++) {
    const a = pathPoints[s], b = pathPoints[(s + 1) % pathPoints.length];
    totalPathLen += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (totalPathLen < 1e-3) return refuse('degenerate_path', 'The line has no length.');

  // substrate normal at each path point from its nearest substrate vertex
  const subNormals = vertexNormals(sub.positions, sub.indices);
  const nearest = nearestVertexFinder(sub.positions);
  const stationNormals = pathPoints.map((p) => {
    const b = nearest(p) * 3;
    return [subNormals[b], subNormals[b + 1], subNormals[b + 2]];
  });

  const common = { closed, offset: gap, surfaceNormals: stationNormals };
  let tube;
  try {
    if (style === 'beads') {
      tube = buildBeadsAlongPath(pathPoints, { ...common, radius, spacing });
    } else if (style === 'eyelets') {
      tube = buildEyeletsAlongPath(pathPoints, { ...common, radius, spacing });
    } else if (style === 'zipper') {
      tube = buildZipperAlongPath(pathPoints, { ...common, radius, spacing });
    } else if (style === 'laces') {
      tube = buildLacesAlongPath(pathPoints, {
        ...common,
        radius: Math.max(0.6, radius * 0.75),
        spacing: spacing != null ? Math.max(8.0, spacing * 1.4) : null,
        pattern: layerOpts.pipePattern || 'crisscross',
      });
    } else if (style === 'chain') {
      tube = buildChainAlongPath(pathPoints, { ...common, radius: Math.max(0.5, radius * 0.6), spacing });
    } else {
      tube = buildPipeTube(pathPoints, { ...common, radius, facets, cap, radii: toeRadius != null ? radiiHeelToToe(pathPoints, radius, toeRadius) : null });
    }
  } catch (err) {
    return refuse('generator_error', `The ${style} did not build: ${err.message}`);
  }
  if (!tube.ok) return tube;

  return {
    ok: true,
    notes: tube.notes,
    positions: tube.positions,
    indices: tube.indices,
    limit: {
      positions: tube.positions,
      indices: tube.indices,
      normals: tube.normals,
      quads: new Uint32Array(0),
      sheet: new Uint8Array(0),
    },
    cage: {
      positions: tube.positions,
      quads: new Uint32Array(0),
      srcOf: new Int32Array(0),
      rims: [],
      sheetCount: 0,
      sheetFaces: 0,
    },
    wall: tube.ringRadii
      ? Float32Array.from({ length: tube.positions.length / 3 }, (_, v) => 2 * tube.ringRadii[Math.min(tube.ringRadii.length - 1, Math.floor(v / tube.facets))])
      : new Float32Array(tube.positions.length / 3).fill(radius * 2),
    gap: new Float32Array(tube.positions.length / 3).fill(gap),
    coverage: coverage,
    directions: tube.normals,
    pattern: null,
    texture: null,
    skive: null,
    terrain: null,
    stats: {
      closed: tube.closure.boundaryEdges === 0,
      openEdges: tube.closure.boundaryEdges,
      inconsistent: tube.closure.doubledEdges,
      components: tube.count || 1,
      vertices: tube.positions.length / 3,
      triangles: tube.indices.length / 3,
      volumeCm3: tube.volumeCm3,
      areaCm2: tube.areaCm2,
      wall: tube.ringRadii
        ? { min: 2 * tube.radiusMin, max: 2 * tube.radiusMax, mean: 2 * tube.ringRadii.reduce((a, r) => a + r, 0) / tube.ringRadii.length }
        : { min: radius * 2, max: radius * 2, mean: radius * 2 },
    },
  };
}
