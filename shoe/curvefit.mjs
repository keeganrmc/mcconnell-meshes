// Closed outlines as PERIODIC CUBIC B-SPLINES — the curve a designer edits.
// Every closed polyline this app produces (a bottom pattern, a feather line, a
// topline, a forme) is a few hundred points; Rhino's rebuild of one is a
// periodic degree-3 NURBS with sixty-odd control points on uniform knots.
// fitPeriodicCubic() makes that curve here by least squares, so the SVG, the
// .3dm and the .unreason carry the same editable thing.
//
// Uniform periodic cubic B-spline with n control points: span i runs over
// control points P[i], P[i+1], P[i+2], P[i+3] (indices mod n) for local t in
// [0,1), basis (1−t)³/6, (3t³−6t²+4)/6, (−3t³+3t²+3t+1)/6, t³/6.

function basis(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6];
}

// arc-length resample of a closed polyline ([[x,y,(z)],...]) to m points
export function resampleClosed(pts, m) {
  const n = pts.length, dim = pts[0].length;
  const seg = new Float64Array(n); let L = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; let d = 0; for (let k = 0; k < dim; k++) d += (b[k] - a[k]) ** 2; seg[i] = Math.sqrt(d); L += seg[i]; }
  const out = []; let i = 0, acc = 0;
  for (let j = 0; j < m; j++) {
    const target = (j / m) * L;
    while (acc + seg[i] < target && i < n - 1) { acc += seg[i]; i++; }
    const f = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    const a = pts[i], b = pts[(i + 1) % n], p = new Array(dim);
    for (let k = 0; k < dim; k++) p[k] = a[k] + (b[k] - a[k]) * f;
    out.push(p);
  }
  return { points: out, length: L };
}

// Fit n control points to a closed polyline by least squares. Samples are
// spread by arc length; sample j sits at global parameter u = j/m·n, in span
// floor(u). Returns the control points (unique, not wrapped) and the closed
// length; `rms` is the fit's residual in the points' units.
export function fitPeriodicCubic(pts, n = 64, samples = null) {
  const dim = pts[0].length;
  const m = samples || Math.max(4 * n, pts.length);
  const { points: S, length } = resampleClosed(pts, m);
  // normal equations AᵀA c = AᵀS, A is m×n with 4 entries per row
  const AtA = new Float64Array(n * n), AtS = new Float64Array(n * dim);
  const rows = new Array(m);
  for (let j = 0; j < m; j++) {
    const u = (j / m) * n, i = Math.floor(u), t = u - i, b = basis(t);
    const idx = [i % n, (i + 1) % n, (i + 2) % n, (i + 3) % n];
    rows[j] = { idx, b };
    for (let a = 0; a < 4; a++) {
      for (let c = 0; c < 4; c++) AtA[idx[a] * n + idx[c]] += b[a] * b[c];
      for (let k = 0; k < dim; k++) AtS[idx[a] * dim + k] += b[a] * S[j][k];
    }
  }
  // Gaussian elimination with partial pivoting on the (small, SPD) system
  const M = AtA, R = AtS;
  for (let p = 0; p < n; p++) {
    let piv = p; for (let r = p + 1; r < n; r++) if (Math.abs(M[r * n + p]) > Math.abs(M[piv * n + p])) piv = r;
    if (piv !== p) { for (let c = 0; c < n; c++) { const tmp = M[p * n + c]; M[p * n + c] = M[piv * n + c]; M[piv * n + c] = tmp; } for (let k = 0; k < dim; k++) { const tmp = R[p * dim + k]; R[p * dim + k] = R[piv * dim + k]; R[piv * dim + k] = tmp; } }
    const d = M[p * n + p] || 1e-12;
    for (let r = p + 1; r < n; r++) {
      const f = M[r * n + p] / d; if (!f) continue;
      for (let c = p; c < n; c++) M[r * n + c] -= f * M[p * n + c];
      for (let k = 0; k < dim; k++) R[r * dim + k] -= f * R[p * dim + k];
    }
  }
  const C = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    const p = new Array(dim).fill(0);
    for (let k = 0; k < dim; k++) { let s = R[r * dim + k]; for (let c = r + 1; c < n; c++) s -= M[r * n + c] * C[c][k]; p[k] = s / (M[r * n + r] || 1e-12); }
    C[r] = p;
  }
  // residual
  let se = 0;
  for (let j = 0; j < m; j++) { const { idx, b } = rows[j]; for (let k = 0; k < dim; k++) { let v = 0; for (let a = 0; a < 4; a++) v += b[a] * C[idx[a]][k]; se += (v - S[j][k]) ** 2; } }
  return { controlPoints: C, degree: 3, periodic: true, n, length, rms: Math.sqrt(se / m) };
}

export function evalPeriodicCubic(C, u) {
  const n = C.length, dim = C[0].length;
  const uu = ((u % n) + n) % n, i = Math.floor(uu), t = uu - i, b = basis(t);
  const p = new Array(dim).fill(0);
  for (let a = 0; a < 4; a++) { const q = C[(i + a) % n]; for (let k = 0; k < dim; k++) p[k] += b[a] * q[k]; }
  return p;
}

// Bézier segments of the spline (one per span), for an SVG path or any
// cubic-Bézier consumer: exact, not sampled.
export function periodicCubicToBeziers(C) {
  const n = C.length, dim = C[0].length, segs = [];
  const mix = (ws, ids) => { const p = new Array(dim).fill(0); for (let a = 0; a < ids.length; a++) { const q = C[ids[a] % n]; for (let k = 0; k < dim; k++) p[k] += ws[a] * q[k]; } return p; };
  for (let i = 0; i < n; i++) segs.push([
    mix([1 / 6, 4 / 6, 1 / 6], [i, i + 1, i + 2]),
    mix([2 / 3, 1 / 3], [i + 1, i + 2]),
    mix([1 / 3, 2 / 3], [i + 1, i + 2]),
    mix([1 / 6, 4 / 6, 1 / 6], [i + 1, i + 2, i + 3]),
  ]);
  return segs;
}

// SVG path data for the closed spline, 2D, with a transform (x,y) → (sx, sy)
export function periodicCubicSVGPath(C, map = (p) => p) {
  const segs = periodicCubicToBeziers(C);
  const f = (p) => map(p).slice(0, 2).map((v) => v.toFixed(3)).join(' ');
  let d = `M ${f(segs[0][0])}`;
  for (const s of segs) d += ` C ${f(s[1])} ${f(s[2])} ${f(s[3])}`;
  return d + ' Z';
}

// Rhino's periodic layout: control points wrapped by the degree, uniform
// integer knots from −(degree−1). rhino3dm's NurbsCurve.create(true, 3, cps)
// takes the UNIQUE points and builds exactly this; the arrays are here for a
// writer that sets knots itself.
export function periodicCubicRhinoLayout(C) {
  const n = C.length, points = C.concat(C.slice(0, 3));
  const knots = []; for (let k = -2; k < n + 3; k++) knots.push(k);
  return { points, knots, degree: 3 };
}
