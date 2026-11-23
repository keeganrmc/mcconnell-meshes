// THE RIM LINE: where a piece's region ends on the last — the sole's climb, the
// footie's topline — as a profile of heights round the feather line that a
// person edits by its beads. Sixteen control heights at even arc stations
// round the feather line (u = 0 at the heel, running the lateral side first),
// a periodic cubic between them; the profile is a delta on the piece's own
// laid heights (the dials), so the dials keep working under an edit and a
// zero profile is the chip as laid. Written as the same signed field the chip
// and the brush write, so the three tools meet on equal terms.

import { evalPeriodicCubic } from './curvefit.mjs';

export const RIM_STATIONS = 16;

// per-vertex (u, h): u the arc parameter of the nearest feather point, h the
// height above the feather line there; the feather's arc runs from the heel
export function rimChart(last, lm) {
  const P = last.positions, V = P.length / 3, fp = lm.featherPts, K = fp.length / 3;
  // the feather's points ordered by their loop already; arc length, starting at the rearmost
  let start = 0; for (let k = 1; k < K; k++) if (fp[k * 3] < fp[start * 3]) start = k;
  const uArc = new Float64Array(K); let arc = 0;
  for (let s = 0; s < K; s++) { const k = (start + s) % K, j = (start + s + 1) % K; uArc[k] = arc; arc += Math.hypot(fp[j * 3] - fp[k * 3], fp[j * 3 + 2] - fp[k * 3 + 2]); }
  for (let k = 0; k < K; k++) uArc[k] /= arc || 1;
  const u = new Float32Array(V), h = new Float32Array(V), near = new Int32Array(V);
  for (let i = 0; i < V; i++) {
    const x = P[i * 3], z = P[i * 3 + 2];
    let best = 0, bd = Infinity;
    for (let k = 0; k < K; k++) { const d = (x - fp[k * 3]) ** 2 + (z - fp[k * 3 + 2]) ** 2; if (d < bd) { bd = d; best = k; } }
    near[i] = best; u[i] = uArc[best]; h[i] = P[i * 3 + 1] - fp[best * 3 + 1];
  }
  return { u, h, near, uArc, arcMM: arc, K, start };
}

// the periodic profile's value at u from its station heights
export function profileAt(heights, u) {
  const C = heights.map((v) => [v]);
  return evalPeriodicCubic(C, ((u % 1) + 1) % 1 * heights.length)[0];
}

// a signed field: the base signed field (the chip's) lifted by the profile at
// each vertex's u — the profile in mm, positive raising the rim
export function liftSigned(signed, chart, heights) {
  const out = new Float64Array(signed.length);
  const table = new Float64Array(256); for (let k = 0; k < 256; k++) table[k] = profileAt(heights, k / 256);
  for (let i = 0; i < signed.length; i++) out[i] = signed[i] + table[Math.floor(((chart.u[i] % 1) + 1) % 1 * 256) & 255];
  return out;
}

// flareChart: the feather outline in plan, arc length parameter u along the loop,
// and outward 2D normals, for positioning and editing the plan outline beads
export function flareChart(last, lm) {
  const fp = lm.featherPts, K = fp.length / 3;
  let start = 0; for (let k = 1; k < K; k++) if (fp[k * 3] < fp[start * 3]) start = k;
  const fx = new Float64Array(K), fy = new Float64Array(K), fz = new Float64Array(K);
  for (let s = 0; s < K; s++) {
    const k = (start + s) % K;
    fx[s] = fp[k * 3]; fy[s] = fp[k * 3 + 1]; fz[s] = fp[k * 3 + 2];
  }
  const uArc = new Float64Array(K); let arc = 0;
  for (let k = 0; k < K; k++) { uArc[k] = arc; const j = (k + 1) % K; arc += Math.hypot(fx[j] - fx[k], fz[j] - fz[k]); }
  for (let k = 0; k < K; k++) uArc[k] /= arc || 1;

  let sx = Float64Array.from(fx), sz = Float64Array.from(fz);
  for (let pass = 0; pass < 24; pass++) {
    const nx = new Float64Array(K), nz = new Float64Array(K);
    for (let k = 0; k < K; k++) { const a = (k + K - 1) % K, b = (k + 1) % K; nx[k] = (sx[a] + sx[k] + sx[b]) / 3; nz[k] = (sz[a] + sz[k] + sz[b]) / 3; }
    sx = nx; sz = nz;
  }
  let area = 0; for (let k = 0; k < K; k++) { const j = (k + 1) % K; area += sx[k] * sz[j] - sx[j] * sz[k]; }
  const mx = new Float64Array(K), mz = new Float64Array(K), reach = 3;
  for (let k = 0; k < K; k++) {
    let ka = (k + K - 1) % K, kb = (k + 1) % K;
    for (let s = 1; s < K / 4 && Math.hypot(fx[k] - fx[ka], fz[k] - fz[ka]) < reach; s++) ka = (k + K - s) % K;
    for (let s = 1; s < K / 4 && Math.hypot(fx[k] - fx[kb], fz[k] - fz[kb]) < reach; s++) kb = (k + s) % K;
    let tx = sx[kb] - sx[ka], tz = sz[kb] - sz[ka]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const sgn = area > 0 ? 1 : -1; mx[k] = tz * sgn; mz[k] = -tx * sgn;
  }

  const atU = (u) => {
    const uu = ((u % 1) + 1) % 1;
    let bk = 0;
    for (let k = 0; k < K; k++) { if (uArc[k] <= uu) bk = k; else break; }
    const j = (bk + 1) % K;
    const u0 = uArc[bk], u1 = j === 0 ? 1 : uArc[j];
    const t = u1 > u0 ? (uu - u0) / (u1 - u0) : 0;
    const x = fx[bk] + (fx[j] - fx[bk]) * t;
    const y = fy[bk] + (fy[j] - fy[bk]) * t;
    const z = fz[bk] + (fz[j] - fz[bk]) * t;
    let ox = mx[bk] + (mx[j] - mx[bk]) * t, oz = mz[bk] + (mz[j] - mz[bk]) * t;
    const l = Math.hypot(ox, oz) || 1; ox /= l; oz /= l;
    return { x, y, z, ox, oz };
  };

  return { K, arcMM: arc, atU, uArc, fx, fy, fz, mx, mz };
}

// the beads for the plan outline: N stations around the feather line offset by
// (wallMM + flareProf[s]) along outward plan normals
export function flareBeads(chart, flareProf, wallMM = 6, groundY = 0) {
  const n = flareProf ? flareProf.length : RIM_STATIONS;
  const beads = [];
  for (let s = 0; s < n; s++) {
    const u = s / n;
    const p = chart.atU(u);
    const fl = flareProf ? flareProf[s] : 0;
    const bx = p.x + p.ox * (wallMM + fl);
    const bz = p.z + p.oz * (wallMM + fl);
    beads.push({ station: s, u, vertex: 0, x: bx, y: groundY, z: bz, ox: p.ox, oz: p.oz, fx: p.x, fy: p.y, fz: p.z, flare: fl });
  }
  return beads;
}

// the plan outline curve as 3D line segment vertices: evaluated along the
// periodic cubic curve
export function flareOutlineSegments(chart, flareProf, wallMM = 6, groundY = 0, segs = 128) {
  const pts = [];
  let prevX = 0, prevY = groundY, prevZ = 0;
  for (let i = 0; i <= segs; i++) {
    const u = (i % segs) / segs;
    const p = chart.atU(u);
    const fl = (flareProf && flareProf.some((v) => v)) ? profileAt(flareProf, u) : 0;
    const px = p.x + p.ox * (wallMM + fl);
    const pz = p.z + p.oz * (wallMM + fl);
    if (i > 0) {
      pts.push(prevX, prevY, prevZ, px, groundY, pz);
    }
    prevX = px; prevZ = pz;
  }
  return pts;
}

