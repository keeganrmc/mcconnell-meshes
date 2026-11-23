// shoe/lattice.mjs — 3D Lattice Geometry Builder (Gyroid, Voronoi, Kelvin, TPMS & Foams) for shoe pieces.
//
// Converts a solid closed plate (Midsole, Upper, Outsole, Layer) into a real 3D
// watertight manifold lattice mesh using Sparse 8³ Bricks and Marching Tetrahedra.
//
// Features:
// 1. Sparse 8³ Brick Field Grid: memory-bounded for browser/iPad, sub-millimeter resolution.
// 2. Comprehensive Lattice Topologies: Gyroid, Schwarz P, Schwarz D, Neovius, Spinodal,
//    Voronoi, Kelvin Foam (BCC), Diamond Cubic, and Octet Truss.
// 3. Smooth-Min/Max Blending: struts flare smoothly into the shell without notch stress.
// 4. Footwear Outsole Skin (Shell Mask): solid ground-contact tread footprint with open lattice upper.
// 5. Volume-Calibrated Melt: multi-stride Laplacian smoothing without loss of outer shoe volume.

import { TET_CASES } from '../lift/masq/levelset.js';

const TET_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const CUBE_TETS = [
  [ 0, 1, 3, 7 ],
  [ 0, 1, 7, 5 ],
  [ 0, 2, 7, 3 ],
  [ 0, 2, 6, 7 ],
  [ 0, 4, 5, 7 ],
  [ 0, 4, 7, 6 ]
];

// ── Smooth Minimum & Maximum ──────────────────────────────────────────────────
export function smin(a, b, k = 1.0) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ── 1. Sparse 8³ Brick Field Grid ─────────────────────────────────────────────
export const BS = 8, BS3 = 512;

export function createSparseGrid(lo, hi, h, band) {
  const n = [0, 1, 2].map(a => Math.max(2, Math.ceil((hi[a] - lo[a]) / h) + 1));
  const nb = n.map(v => Math.ceil(v / BS));
  const nbT = nb[0] * nb[1] * nb[2];
  return {
    lo: lo.slice(), h, band, n, nb,
    slot: new Int32Array(nbT).fill(-1),
    sign: new Int8Array(nbT).fill(1),
    bricks: [],
    owner: []
  };
}

export const brickId = (g, bi, bj, bk) => (bk * g.nb[1] + bj) * g.nb[0] + bi;

export function allocBrick(g, id, fill) {
  let s = g.slot[id];
  if (s >= 0) return g.bricks[s];
  s = g.bricks.length;
  const arr = new Float32Array(BS3);
  arr.fill(fill === undefined ? g.sign[id] * g.band : fill);
  g.bricks.push(arr);
  g.owner.push(id);
  g.slot[id] = s;
  return arr;
}

export function sparseGridGet(g, i, j, k) {
  if (i < 0 || j < 0 || k < 0 || i >= g.nb[0] * BS || j >= g.nb[1] * BS || k >= g.nb[2] * BS) return g.band;
  const id = brickId(g, i >> 3, j >> 3, k >> 3);
  const s = g.slot[id];
  if (s < 0) return g.sign[id] * g.band;
  return g.bricks[s][((k & 7) * BS + (j & 7)) * BS + (i & 7)];
}

export function sparseGridSet(g, i, j, k, v) {
  if (i < 0 || j < 0 || k < 0 || i >= g.nb[0] * BS || j >= g.nb[1] * BS || k >= g.nb[2] * BS) return;
  const id = brickId(g, i >> 3, j >> 3, k >> 3);
  const arr = allocBrick(g, id);
  arr[((k & 7) * BS + (j & 7)) * BS + (i & 7)] = v;
}

// ── 2. Lattice Cells & Minimal Surfaces (TPMS) ────────────────────────────────
function capDist(px, py, pz, ax, ay, az, bx, by, bz) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  let h = (pax*bax + pay*bay + paz*baz) / (bax*bax + bay*bay + baz*baz || 1e-6);
  if (h < 0) h = 0; else if (h > 1) h = 1;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

/**
 * Triply Periodic Minimal Surface (TPMS) — Schoen's Gyroid sheet distance.
 * sin(x)*cos(y) + sin(y)*cos(z) + sin(z)*cos(x) = 0.
 */
export function gyroidSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const W = (2 * Math.PI) / Math.max(cellMM, 1e-3);
  const qx = x * W, qy = y * W, qz = z * W;
  const f = Math.sin(qx) * Math.cos(qy) + Math.sin(qy) * Math.cos(qz) + Math.sin(qz) * Math.cos(qx);
  const t = 1.25 * Math.max(0.01, Math.min(0.9, infillPct / 100));
  return (Math.abs(f) - t) / W;
}

/**
 * Schwarz P (Primitive) Minimal Surface.
 * cos(x) + cos(y) + cos(z) = 0.
 */
export function schwarzPSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const W = (2 * Math.PI) / Math.max(cellMM, 1e-3);
  const qx = x * W, qy = y * W, qz = z * W;
  const f = Math.cos(qx) + Math.cos(qy) + Math.cos(qz);
  const t = 1.15 * Math.max(0.01, Math.min(0.9, infillPct / 100));
  const grad = Math.sqrt(Math.sin(qx)**2 + Math.sin(qy)**2 + Math.sin(qz)**2 + 1e-6);
  return (Math.abs(f) - t) / (W * Math.max(0.4, grad));
}

/**
 * Schwarz D (Diamond) Minimal Surface.
 * cos(x)cos(y)cos(z) - sin(x)sin(y)sin(z) = 0.
 */
export function schwarzDSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const W = (2 * Math.PI) / Math.max(cellMM, 1e-3);
  const qx = x * W, qy = y * W, qz = z * W;
  const sX = Math.sin(qx), cX = Math.cos(qx);
  const sY = Math.sin(qy), cY = Math.cos(qy);
  const sZ = Math.sin(qz), cZ = Math.cos(qz);
  const f = cX * cY * cZ - sX * sY * sZ;
  const t = 0.85 * Math.max(0.01, Math.min(0.9, infillPct / 100));
  const gx = -sX * cY * cZ - cX * sY * sZ;
  const gy = -cX * sY * cZ - sX * cY * sZ;
  const gz = -cX * cY * sZ - sX * sY * cZ;
  const grad = Math.sqrt(gx*gx + gy*gy + gz*gz + 1e-6);
  return (Math.abs(f) - t) / (W * Math.max(0.3, grad));
}

/**
 * Neovius Minimal Surface.
 * 3(cos(x)+cos(y)+cos(z)) + 4cos(x)cos(y)cos(z) = 0.
 */
export function neoviusSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const W = (2 * Math.PI) / Math.max(cellMM, 1e-3);
  const qx = x * W, qy = y * W, qz = z * W;
  const cX = Math.cos(qx), cY = Math.cos(qy), cZ = Math.cos(qz);
  const f = 3 * (cX + cY + cZ) + 4 * cX * cY * cZ;
  const t = 2.0 * Math.max(0.01, Math.min(0.9, infillPct / 100));
  return (Math.abs(f) - t) / (W * 3.5);
}

/**
 * Spinodal decomposition approximation via multi-directional standing wave interference.
 */
export function spinodalSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const W = (2 * Math.PI) / Math.max(cellMM, 1e-3);
  const qx = x * W, qy = y * W, qz = z * W;
  let f = Math.sin(qx + 0.3) * Math.cos(qy + 0.7) +
          Math.sin(qy + 1.1) * Math.cos(qz + 0.4) +
          Math.sin(qz + 2.1) * Math.cos(qx + 1.8) +
          0.5 * Math.cos(0.7 * (qx - qy + qz));
  f *= 0.285;
  const t = 0.65 * Math.max(0.01, Math.min(0.9, infillPct / 100));
  return (Math.abs(f) - t) / W;
}

// Deterministic 3D hash for Voronoi cell feature points
function vHash33(x, y, z) {
  let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  const h0 = n - Math.floor(n);
  n = Math.sin(x * 269.5 + y * 183.3 + z * 246.1) * 43758.5453123;
  const h1 = n - Math.floor(n);
  n = Math.sin(x * 113.5 + y * 271.9 + z * 124.6) * 43758.5453123;
  const h2 = n - Math.floor(n);
  return [h0, h1, h2];
}

function vFeat(cx, cy, cz, cellMM) {
  const h = vHash33(cx, cy, cz);
  return [
    (cx + 0.5 + (h[0] - 0.5) * 0.7) * cellMM,
    (cy + 0.5 + (h[1] - 0.5) * 0.7) * cellMM,
    (cz + 0.5 + (h[2] - 0.5) * 0.7) * cellMM
  ];
}

/**
 * 3D Voronoi open-strut cellular lattice.
 */
export function voronoiSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const c = Math.max(cellMM, 2);
  const qx = x / c, qy = y / c, qz = z / c;
  const bx = Math.floor(qx), by = Math.floor(qy), bz = Math.floor(qz);
  const r = c * 0.22 * Math.sqrt(Math.max(0.02, Math.min(0.8, infillPct / 100)));
  const k = r * 1.2;
  let d = 1e5;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        const cx = bx + ox, cy = by + oy, cz = bz + oz;
        const a = vFeat(cx, cy, cz, c);
        const b1 = vFeat(cx + 1, cy, cz, c);
        const b2 = vFeat(cx, cy + 1, cz, c);
        const b3 = vFeat(cx, cy, cz + 1, c);
        d = smin(d, capDist(x, y, z, a[0], a[1], a[2], b1[0], b1[1], b1[2]) - r, k);
        d = smin(d, capDist(x, y, z, a[0], a[1], a[2], b2[0], b2[1], b2[2]) - r, k);
        d = smin(d, capDist(x, y, z, a[0], a[1], a[2], b3[0], b3[1], b3[2]) - r, k);
        const ndx = x - a[0], ndy = y - a[1], ndz = z - a[2];
        d = smin(d, Math.sqrt(ndx*ndx + ndy*ndy + ndz*ndz) - r * 1.15, k);
      }
    }
  }
  return d;
}

/**
 * Kelvin Foam (Truncated Octahedra on BCC Sites).
 * 14-sided cell: 6 square faces + 8 hexagonal faces.
 */
export function kelvinSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const c = Math.max(cellMM, 2);
  const r = c * 0.08 * Math.sqrt(Math.max(0.02, Math.min(0.8, infillPct / 100)));
  const k = r * 1.0;
  const halfC = c / 2;
  const qx = Math.floor(x / halfC), qy = Math.floor(y / halfC), qz = Math.floor(z / halfC);
  let d = 1e5;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        const sx = (qx + ox) * halfC, sy = (qy + oy) * halfC, sz = (qz + oz) * halfC;
        const q0 = [sx, sy, sz];
        const q1 = [sx + halfC, sy, sz];
        const q2 = [sx, sy + halfC, sz];
        const q3 = [sx, sy, sz + halfC];
        d = smin(d, capDist(x, y, z, q0[0], q0[1], q0[2], q1[0], q1[1], q1[2]) - r, k);
        d = smin(d, capDist(x, y, z, q0[0], q0[1], q0[2], q2[0], q2[1], q2[2]) - r, k);
        d = smin(d, capDist(x, y, z, q0[0], q0[1], q0[2], q3[0], q3[1], q3[2]) - r, k);
      }
    }
  }
  return d;
}

/**
 * Diamond Cubic Strut Lattice.
 */
export function diamondSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const c = Math.max(cellMM, 2);
  const r = c * 0.085 * Math.sqrt(Math.max(0.02, Math.min(0.8, infillPct / 100)));
  const k = r * 1.0;
  const qx = Math.floor(x / c) * c, qy = Math.floor(y / c) * c, qz = Math.floor(z / c) * c;
  let d = 1e5;

  for (let ox = 0; ox <= 1; ox++) {
    for (let oy = 0; oy <= 1; oy++) {
      for (let oz = 0; oz <= 1; oz++) {
        const ax = qx + ox * c, ay = qy + oy * c, az = qz + oz * c;
        const bx = ax + c * 0.25, by = ay + c * 0.25, bz = az + c * 0.25;
        d = smin(d, capDist(x, y, z, ax, ay, az, bx, by, bz) - r, k);
      }
    }
  }
  return d;
}

/**
 * Octet Truss Strut Lattice (FCC diagonals).
 */
export function octetSDF(x, y, z, cellMM = 12, infillPct = 20) {
  const c = Math.max(cellMM, 2);
  const r = c * 0.075 * Math.sqrt(Math.max(0.02, Math.min(0.8, infillPct / 100)));
  const k = r * 1.0;
  const qx = Math.floor(x / c) * c, qy = Math.floor(y / c) * c, qz = Math.floor(z / c) * c;
  let d = 1e5;

  const corners = [
    [qx, qy, qz], [qx + c, qy, qz], [qx + c, qy + c, qz], [qx, qy + c, qz],
    [qx, qy, qz + c], [qx + c, qy, qz + c], [qx + c, qy + c, qz + c], [qx, qy + c, qz + c]
  ];
  d = smin(d, capDist(x, y, z, corners[0][0], corners[0][1], corners[0][2], corners[2][0], corners[2][1], corners[2][2]) - r, k);
  d = smin(d, capDist(x, y, z, corners[4][0], corners[4][1], corners[4][2], corners[6][0], corners[6][1], corners[6][2]) - r, k);
  d = smin(d, capDist(x, y, z, corners[0][0], corners[0][1], corners[0][2], corners[5][0], corners[5][1], corners[5][2]) - r, k);
  d = smin(d, capDist(x, y, z, corners[3][0], corners[3][1], corners[3][2], corners[6][0], corners[6][1], corners[6][2]) - r, k);
  return d;
}

/**
 * SRS (Single Regular Surface / Skeletal Gyroid) Lattice.
 */
export function srsSDF(x, y, z, cellMM = 12, infillPct = 20) {
  return gyroidSDF(x, y, z, cellMM, infillPct);
}

/**
 * Unified lattice pattern dispatcher.
 */
// voxels a lattice may sample over its piece, per Resolution
export const LATTICE_VOXEL_BUDGET = { draft: 0.25e6, standard: 0.6e6, fine: 2e6 };
// half a strut's (or sheet's) thickness: the deepest a point sits inside the
// pattern, read over one cell (the 98th percentile of the inside depths)
export function latticeHalfThickness(pattern, cellMM, infillPct) {
  let a = 12345; const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const depths = [];
  for (let i = 0; i < 6000; i++) { const d = latticeSDF(pattern, rnd() * cellMM, rnd() * cellMM, rnd() * cellMM, cellMM, infillPct); if (d < 0) depths.push(-d); }
  if (!depths.length) return 0.1;
  depths.sort((x, y) => x - y);
  return depths[Math.floor(depths.length * 0.98)];
}

export function latticeSDF(pattern = 'gyroid', x, y, z, cellMM = 12, infillPct = 20) {
  const p = (pattern || 'gyroid').toLowerCase();
  if (p.includes('voronoi')) return voronoiSDF(x, y, z, cellMM, infillPct);
  if (p.includes('kelvin')) return kelvinSDF(x, y, z, cellMM, infillPct);
  if (p.includes('diamond')) return diamondSDF(x, y, z, cellMM, infillPct);
  if (p.includes('octet')) return octetSDF(x, y, z, cellMM, infillPct);
  if (p.includes('schwarz_p') || p.includes('schwarzp')) return schwarzPSDF(x, y, z, cellMM, infillPct);
  if (p.includes('schwarz_d') || p.includes('schwarzd')) return schwarzDSDF(x, y, z, cellMM, infillPct);
  if (p.includes('neovius')) return neoviusSDF(x, y, z, cellMM, infillPct);
  if (p.includes('spinodal')) return spinodalSDF(x, y, z, cellMM, infillPct);
  if (p.includes('srs')) return srsSDF(x, y, z, cellMM, infillPct);
  return gyroidSDF(x, y, z, cellMM, infillPct);
}

/**
 * A hand-placed plantar pressure map: a multiplier W(x, y, z) in [0.35, 1.85] on the infill.
 * Denser under the lateral heel strike and the 1st/5th metatarsal heads, lighter under the
 * medial arch and the toe flex. Not fitted to measured pressure data. The heel and ball peaks
 * sit at the last's own heelX/xBall when given, else at 12% and 66% of the length.
 */
export function plantarPressureWeight(x, y, z, landmarks = null, bbox = null) {
  let minX = -100, maxX = 170;
  let minZ = -45, maxZ = 45;
  let medialSign = 1;

  if (landmarks) {
    if (landmarks.minX != null && landmarks.maxX != null) {
      minX = landmarks.minX;
      maxX = landmarks.maxX;
    }
    if (landmarks.medialSign != null) {
      medialSign = landmarks.medialSign;
    }
  }
  if (bbox) {
    if (minX === -100 && bbox.minX != null) minX = bbox.minX;
    if (maxX === 170 && bbox.maxX != null) maxX = bbox.maxX;
    if (bbox.minZ != null) minZ = bbox.minZ;
    if (bbox.maxZ != null) maxZ = bbox.maxZ;
  }

  const L = Math.max(1, maxX - minX);
  const u = Math.max(0, Math.min(1, (x - minX) / L));
  const uHeel = landmarks && landmarks.heelX != null ? Math.max(0, Math.min(0.4, (landmarks.heelX - minX) / L + 0.1)) : 0.12;
  const uBall = landmarks && landmarks.xBall != null ? Math.max(0.45, Math.min(0.85, (landmarks.xBall - minX) / L)) : 0.66;
  const uArch = (uHeel + uBall) / 2;

  const centerZ = (minZ + maxZ) / 2;
  const halfW = Math.max(1, (maxZ - minZ) / 2);
  const v = Math.max(-1.5, Math.min(1.5, (z - centerZ) / halfW));
  const vMed = v * medialSign; // +1 medial, -1 lateral

  // 1. Lateral heel strike (lateral vMed ~ -0.2)
  const duH = (u - uHeel) / 0.08;
  const dvH = (vMed - (-0.2)) / 0.55;
  const gHeel = Math.exp(-(duH * duH + dvH * dvH));

  // 2. Medial longitudinal arch, halfway between (medial vMed ~ 0.45)
  const duA = (u - uArch) / 0.12;
  const dvA = (vMed - 0.45) / 0.5;
  const gArch = Math.exp(-(duA * duA + dvA * dvA));

  // 3. Metatarsal heads: the 1st a little ahead of the ball line (medial), the 5th behind it (lateral)
  const duM1 = (u - (uBall + 0.02)) / 0.08;
  const dvM1 = (vMed - 0.45) / 0.4;
  const gM1 = Math.exp(-(duM1 * duM1 + dvM1 * dvM1));

  const duM5 = (u - (uBall - 0.04)) / 0.08;
  const dvM5 = (vMed - (-0.45)) / 0.4;
  const gM5 = Math.exp(-(duM5 * duM5 + dvM5 * dvM5));

  const duMC = (u - (uBall - 0.01)) / 0.09;
  const dvMC = vMed / 0.45;
  const gMC = 0.6 * Math.exp(-(duMC * duMC + dvMC * dvMC));

  const gBall = Math.max(gM1, gM5, gMC);

  // 4. Toe flex, past the ball
  const gToe = 1 / (1 + Math.exp(-(u - (uBall + 0.16)) / 0.05));

  // Combined weight field
  const w = 1.0 + 0.55 * gHeel - 0.45 * gArch + 0.42 * gBall - 0.32 * gToe;
  return Math.max(0.35, Math.min(1.85, w));
}

// ── 3. Spatial Acceleration Mesh SDF ──────────────────────────────────────────
export function buildMeshSDF(positions, indices) {
  const vCount = positions.length / 3;
  const tCount = indices.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Angle-weighted pseudo-normals at vertices (provably correct inside/outside test at creases & corners)
  const nrm = new Float64Array(vCount * 3);
  const e = new Float64Array(9);

  for (let t = 0; t < tCount; t++) {
    const v0 = indices[t * 3], v1 = indices[t * 3 + 1], v2 = indices[t * 3 + 2];
    const i0 = v0 * 3, i1 = v1 * 3, i2 = v2 * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];

    minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
    minY = Math.min(minY, ay, by, cy); maxY = Math.max(maxY, ay, by, cy);
    minZ = Math.min(minZ, az, bz, cz); maxZ = Math.max(maxZ, az, bz, cz);

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl > 1e-12) {
      fx /= fl; fy /= fl; fz /= fl;
      const pts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
      const vts = [v0, v1, v2];
      for (let i = 0; i < 3; i++) {
        const a = pts[i], b = pts[(i + 1) % 3], c = pts[(i + 2) % 3];
        e[0] = b[0] - a[0]; e[1] = b[1] - a[1]; e[2] = b[2] - a[2];
        e[3] = c[0] - a[0]; e[4] = c[1] - a[1]; e[5] = c[2] - a[2];
        const l1 = Math.hypot(e[0], e[1], e[2]), l2 = Math.hypot(e[3], e[4], e[5]);
        if (l1 > 1e-12 && l2 > 1e-12) {
          let cs = (e[0] * e[3] + e[1] * e[4] + e[2] * e[5]) / (l1 * l2);
          cs = cs < -1 ? -1 : (cs > 1 ? 1 : cs);
          const ang = Math.acos(cs);
          const o = vts[i] * 3;
          nrm[o] += fx * ang; nrm[o + 1] += fy * ang; nrm[o + 2] += fz * ang;
        }
      }
    }
  }

  for (let v = 0; v < vCount; v++) {
    const o = v * 3;
    const l = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]);
    if (l > 1e-12) { nrm[o] /= l; nrm[o + 1] /= l; nrm[o + 2] /= l; }
  }

  // The sign comes from the pseudo-normal of the feature the closest point
  // lies on: the face normal inside a face, the sum of the two face normals
  // on an edge, the angle-weighted vertex normal at a corner.
  const faceN = new Float64Array(tCount * 3);
  const edgeN = new Map();
  const edgeKey = (a, b) => a < b ? a * vCount + b : b * vCount + a;
  for (let t = 0; t < tCount; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const ux = positions[i1] - positions[i0], uy = positions[i1 + 1] - positions[i0 + 1], uz = positions[i1 + 2] - positions[i0 + 2];
    const wx = positions[i2] - positions[i0], wy = positions[i2 + 1] - positions[i0 + 1], wz = positions[i2 + 2] - positions[i0 + 2];
    let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    faceN[t * 3] = fx; faceN[t * 3 + 1] = fy; faceN[t * 3 + 2] = fz;
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(indices[t * 3 + e], indices[t * 3 + (e + 1) % 3]);
      const acc = edgeN.get(k);
      if (acc) { acc[0] += fx; acc[1] += fy; acc[2] += fz; } else edgeN.set(k, [fx, fy, fz]);
    }
  }

  // Grid binning
  // bins sized to hold a few dozen triangles each on a fine surface
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const area = (maxX - minX) * (maxY - minY) + (maxY - minY) * (maxZ - minZ) + (maxX - minX) * (maxZ - minZ);
  const cellSize = Math.max(1.5, Math.min(diag / 35, Math.sqrt(2 * area * 24 / Math.max(1, tCount))));
  const hnx = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const hny = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const hnz = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const bins = new Map();

  for (let t = 0; t < tCount; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const tMinX = Math.min(positions[i0], positions[i1], positions[i2]);
    const tMaxX = Math.max(positions[i0], positions[i1], positions[i2]);
    const tMinY = Math.min(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]);
    const tMaxY = Math.max(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]);
    const tMinZ = Math.min(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]);
    const tMaxZ = Math.max(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]);

    const bx0 = Math.max(0, Math.min(hnx - 1, Math.floor((tMinX - minX) / cellSize)));
    const bx1 = Math.min(hnx - 1, Math.floor((tMaxX - minX) / cellSize));
    const by0 = Math.max(0, Math.min(hny - 1, Math.floor((tMinY - minY) / cellSize)));
    const by1 = Math.min(hny - 1, Math.floor((tMaxY - minY) / cellSize));
    const bz0 = Math.max(0, Math.min(hnz - 1, Math.floor((tMinZ - minZ) / cellSize)));
    const bz1 = Math.min(hnz - 1, Math.floor((tMaxZ - minZ) / cellSize));

    for (let k = bz0; k <= bz1; k++) {
      for (let j = by0; j <= by1; j++) {
        for (let i = bx0; i <= bx1; i++) {
          const key = i + j * hnx + k * hnx * hny;
          let list = bins.get(key);
          if (!list) bins.set(key, list = []);
          list.push(t);
        }
      }
    }
  }

  const seenAt = new Int32Array(tCount); let query = 0, nearestT = -1;
  // `maxD`: past it only the sign matters, so the ring search stops there
  function closestTriangleDist(x, y, z, maxD = Infinity) {
    const bx = Math.max(0, Math.min(hnx - 1, Math.floor((x - minX) / cellSize)));
    const by = Math.max(0, Math.min(hny - 1, Math.floor((y - minY) / cellSize)));
    const bz = Math.max(0, Math.min(hnz - 1, Math.floor((z - minZ) / cellSize)));

    let bestD2 = Infinity;
    let bestT = -1;
    let bestU = 0, bestV = 0, bestW = 0;
    let bestPx = 0, bestPy = 0, bestPz = 0;

    const maxR = Math.max(hnx, Math.max(hny, hnz));
    const q = ++query;

    for (let r = 0; r <= maxR; r++) {
      // every bin of ring r is at least (r - 1) cells from the query along one
      // axis, so a closer triangle can still sit in ring r until that bound passes
      const rLo = Math.max(0, r - 1) * cellSize;
      if (r > 0 && bestD2 <= rLo * rLo) break;
      if (rLo > maxD) break;

      const i0 = Math.max(0, bx - r), i1 = Math.min(hnx - 1, bx + r);
      const j0 = Math.max(0, by - r), j1 = Math.min(hny - 1, by + r);
      const k0 = Math.max(0, bz - r), k1 = Math.min(hnz - 1, bz + r);

      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (r > 0 && i !== i0 && i !== i1 && j !== j0 && j !== j1 && k !== k0 && k !== k1) continue;
            const bKey = i + j * hnx + k * hnx * hny;
            const list = bins.get(bKey);
            if (!list) continue;

            for (let idx = 0; idx < list.length; idx++) {
              const t = list[idx];
              if (seenAt[t] === q) continue;
              seenAt[t] = q;

              const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
              const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
              const abx = positions[ib] - ax, aby = positions[ib + 1] - ay, abz = positions[ib + 2] - az;
              const acx = positions[ic] - ax, acy = positions[ic + 1] - ay, acz = positions[ic + 2] - az;
              const apx = x - ax, apy = y - ay, apz = z - az;

              const d1 = abx * apx + aby * apy + abz * apz;
              const d2 = acx * apx + acy * apy + acz * apz;
              let u, v, w;
              if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
              else {
                const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
                const d3 = abx * bpx + aby * bpy + abz * bpz;
                const d4 = acx * bpx + acy * bpy + acz * bpz;
                if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
                else {
                  const vc = d1 * d4 - d3 * d2;
                  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const s = d1 / (d1 - d3); u = 1 - s; v = s; w = 0; }
                  else {
                    const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
                    const d5 = abx * cpx + aby * cpy + abz * cpz;
                    const d6 = acx * cpx + acy * cpy + acz * cpz;
                    if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
                    else {
                      const vb = d5 * d2 - d1 * d6;
                      if (vb <= 0 && d2 >= 0 && d6 <= 0) { const s = d2 / (d2 - d6); u = 1 - s; v = 0; w = s; }
                      else {
                        const va = d3 * d6 - d5 * d4;
                        if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const s = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - s; w = s; }
                        else {
                          const denom = 1.0 / (va + vb + vc);
                          u = va * denom; v = vb * denom; w = vc * denom;
                        }
                      }
                    }
                  }
                }
              }

              const px = u * ax + v * positions[ib] + w * positions[ic];
              const py = u * ay + v * positions[ib + 1] + w * positions[ic + 1];
              const pz = u * az + v * positions[ib + 2] + w * positions[ic + 2];
              const dx = x - px, dy = y - py, dz = z - pz;
              const dist2 = dx * dx + dy * dy + dz * dz;

              if (dist2 < bestD2) {
                bestD2 = dist2;
                bestT = t;
                bestU = u; bestV = v; bestW = w;
                bestPx = px; bestPy = py; bestPz = pz;
              }
            }
          }
        }
      }
    }

    nearestT = bestD2 <= maxD * maxD ? bestT : -1;
    if (bestT < 0 || bestD2 > maxD * maxD) { const inside = isFinite(maxD) ? insideByParity(x, y, z) : null; return inside ? -Math.min(maxD, 1e5) : Math.min(maxD, 1e5); }
    const va = indices[bestT * 3], vb = indices[bestT * 3 + 1], vc = indices[bestT * 3 + 2];
    const eps = 1e-6;
    const zu = bestU < eps, zv = bestV < eps, zw = bestW < eps;
    const zeros = (zu ? 1 : 0) + (zv ? 1 : 0) + (zw ? 1 : 0);
    let nx, ny, nz;
    if (zeros === 0) {
      nx = faceN[bestT * 3]; ny = faceN[bestT * 3 + 1]; nz = faceN[bestT * 3 + 2];
    } else if (zeros === 1) {
      const k = zu ? edgeKey(vb, vc) : zv ? edgeKey(va, vc) : edgeKey(va, vb);
      const en = edgeN.get(k);
      nx = en[0]; ny = en[1]; nz = en[2];
    } else {
      const vv = !zu ? va : !zv ? vb : vc;
      nx = nrm[vv * 3]; ny = nrm[vv * 3 + 1]; nz = nrm[vv * 3 + 2];
    }
    const dist = Math.sqrt(bestD2);
    const par = insideByParity(x, y, z);
    if (par !== null) return par ? -dist : dist;
    const ex = x - bestPx, ey = y - bestPy, ez = z - bestPz;
    const dot = ex * nx + ey * ny + ez * nz;
    return dot < 0 ? -dist : dist;
  }

  // THE SIGN, by parity along +x. A plate's surface can fold through itself
  // (the climb over the toe), and there the closest face's normal points away
  // from a point outside: a whole coarse block then reads deep inside and is
  // filled. Crossings counted along a line do not depend on any one face.
  // Lattice queries sit on grid lines, so each line's crossings are found once.
  const yzBins = new Map();
  for (let t = 0; t < tCount; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const j0 = Math.floor((Math.min(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]) - minY) / cellSize);
    const j1 = Math.floor((Math.max(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]) - minY) / cellSize);
    const k0 = Math.floor((Math.min(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]) - minZ) / cellSize);
    const k1 = Math.floor((Math.max(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]) - minZ) / cellSize);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const key = j + k * (hny + 1);
      let list = yzBins.get(key);
      if (!list) yzBins.set(key, list = []);
      list.push(t);
    }
  }
  // the line is nudged off the mesh's vertices and edges so no crossing counts twice
  const NUDGE_Y = 1.37e-4, NUDGE_Z = 2.91e-4;
  const lineCache = new Map();
  function crossingsAt(y, z) {
    const key = y + ',' + z;
    let xs = lineCache.get(key);
    if (xs) return xs;
    const py = y + NUDGE_Y, pz = z + NUDGE_Z;
    const list = yzBins.get(Math.floor((py - minY) / cellSize) + Math.floor((pz - minZ) / cellSize) * (hny + 1));
    const out = [];
    if (list) for (let n = 0; n < list.length; n++) {
      const t = list[n];
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const ay = positions[a + 1], az = positions[a + 2], by = positions[b + 1], bz = positions[b + 2], cy = positions[c + 1], cz = positions[c + 2];
      const area = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      if (Math.abs(area) < 1e-12) continue;
      const w0 = ((by - py) * (cz - pz) - (bz - pz) * (cy - py)) / area;
      const w1 = ((cy - py) * (az - pz) - (cz - pz) * (ay - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      out.push(w0 * positions[a] + w1 * positions[b] + w2 * positions[c]);
    }
    xs = Float64Array.from(out).sort();
    lineCache.set(key, xs);
    return xs;
  }
  function insideByParity(x, y, z) {
    if (y < minY || y > maxY || z < minZ || z > maxZ || x < minX || x > maxX) return false;
    const xs = crossingsAt(y, z);
    if (xs.length & 1) return null;   // an odd count means the line met an opening: fall back to the normal
    let n = 0;
    for (let i = 0; i < xs.length; i++) if (xs[i] > x) n++;
    return (n & 1) === 1;
  }

  return {
    bbox: { minX, minY, minZ, maxX, maxY, maxZ },
    signedDistance: closestTriangleDist,
    // the triangle the last query found nearest, -1 past its cap
    nearestTriangle: () => nearestT
  };
}

// ── 4. Dense Marching Tetrahedra (Standard & Fallback) ────────────────────────
export function marchTetrahedra(field, nx, ny, nz, ox, oy, oz, h) {
  const nCorners = nx * ny * nz;
  const cOff = new Int32Array(8);
  for (let b = 0; b < 8; b++) {
    cOff[b] = (b & 1) + ((b >> 1) & 1) * nx + ((b >> 2) & 1) * nx * ny;
  }
  const cf = new Float64Array(8);
  const cg = new Int32Array(8);
  const cp = new Float64Array(24);
  const vmap = new Map();
  const outPos = [];
  const outIdx = [];

  const crossing = (b0, b1) => {
    const g0 = cg[b0], g1 = cg[b1];
    const key = g0 < g1 ? g0 * nCorners + g1 : g1 * nCorners + g0;
    const hit = vmap.get(key);
    if (hit !== undefined) return hit;
    const f0 = cf[b0], f1 = cf[b1];
    let t = f0 / (f0 - f1);
    if (t < 1e-4) t = 1e-4;
    else if (t > 1 - 1e-4) t = 1 - 1e-4;
    const idx = outPos.length / 3;
    outPos.push(
      cp[b0 * 3] + t * (cp[b1 * 3] - cp[b0 * 3]),
      cp[b0 * 3 + 1] + t * (cp[b1 * 3 + 1] - cp[b0 * 3 + 1]),
      cp[b0 * 3 + 2] + t * (cp[b1 * 3 + 2] - cp[b0 * 3 + 2])
    );
    vmap.set(key, idx);
    return idx;
  };

  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      let base = j * nx + k * nx * ny;
      for (let i = 0; i + 1 < nx; i++, base++) {
        let neg = 0;
        for (let b = 0; b < 8; b++) {
          const g = base + cOff[b];
          cg[b] = g;
          const f = field[g];
          cf[b] = f;
          if (f < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        for (let b = 0; b < 8; b++) {
          cp[b * 3] = ox + (i + (b & 1)) * h;
          cp[b * 3 + 1] = oy + (j + ((b >> 1) & 1)) * h;
          cp[b * 3 + 2] = oz + (k + ((b >> 2) & 1)) * h;
        }
        for (let t = 0; t < 6; t++) {
          const tet = CUBE_TETS[t];
          let m = 0;
          for (let r = 0; r < 4; r++) if (cf[tet[r]] < 0) m |= 1 << r;
          const tris = TET_CASES[m];
          for (let n = 0; n < tris.length; n++) {
            const e = TET_EDGES[tris[n]];
            outIdx.push(crossing(tet[e[0]], tet[e[1]]));
          }
        }
      }
    }
  }

  return assembleMesh(outPos, outIdx);
}

// ── 5. Sparse Marching Tetrahedra (High-Efficiency 8³ Bricks) ─────────────────
export function sparseMarchTetrahedra(g, iso = 0) {
  const h = g.h, lo = g.lo;
  const nbx = g.nb[0], nby = g.nb[1], nbz = g.nb[2];
  const NX = nbx * BS, NY = nby * BS, NZ = nbz * BS;

  const vmap = new Map();
  const outPos = [];
  const outIdx = [];

  const cf = new Float64Array(8);
  const cp = new Float64Array(24);
  const cg = new Int32Array(8);

  const crossing = (b0, b1) => {
    const g0 = cg[b0], g1 = cg[b1];
    const key = g0 < g1 ? `${g0}_${g1}` : `${g1}_${g0}`;
    const hit = vmap.get(key);
    if (hit !== undefined) return hit;
    const f0 = cf[b0], f1 = cf[b1];
    let t = f0 / (f0 - f1);
    if (t < 1e-4) t = 1e-4;
    else if (t > 1 - 1e-4) t = 1 - 1e-4;
    const idx = outPos.length / 3;
    outPos.push(
      cp[b0 * 3] + t * (cp[b1 * 3] - cp[b0 * 3]),
      cp[b0 * 3 + 1] + t * (cp[b1 * 3 + 1] - cp[b0 * 3 + 1]),
      cp[b0 * 3 + 2] + t * (cp[b1 * 3 + 2] - cp[b0 * 3 + 2])
    );
    vmap.set(key, idx);
    return idx;
  };

  const brickSet = new Set();
  for (const id of g.owner) {
    const bk = Math.floor(id / (nbx * nby)), bj = Math.floor(id / nbx) % nby, bi = id % nbx;
    for (let dk = -1; dk <= 0; dk++) {
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const a = bi + di, b = bj + dj, c = bk + dk;
          if (a >= 0 && b >= 0 && c >= 0 && a < nbx && b < nby && c < nbz) {
            brickSet.add((c * nby + b) * nbx + a);
          }
        }
      }
    }
  }

  for (const id of brickSet) {
    const bk = Math.floor(id / (nbx * nby)), bj = Math.floor(id / nbx) % nby, bi = id % nbx;
    for (let o = 0; o < BS3; o++) {
      const li = o & 7, lj = (o >> 3) & 7, lk = o >> 6;
      const i = bi * BS + li, j = bj * BS + lj, k = bk * BS + lk;
      if (i + 1 >= NX || j + 1 >= NY || k + 1 >= NZ) continue;

      let neg = 0;
      for (let b = 0; b < 8; b++) {
        const ci = i + (b & 1);
        const cj = j + ((b >> 1) & 1);
        const ck = k + ((b >> 2) & 1);
        const val = sparseGridGet(g, ci, cj, ck) - iso;
        cf[b] = val === 0 ? 1e-6 : val;
        cg[b] = (ck * NY + cj) * NX + ci;
        if (cf[b] < 0) neg++;
        cp[b * 3] = lo[0] + ci * h;
        cp[b * 3 + 1] = lo[1] + cj * h;
        cp[b * 3 + 2] = lo[2] + ck * h;
      }
      if (neg === 0 || neg === 8) continue;

      for (let t = 0; t < 6; t++) {
        const tet = CUBE_TETS[t];
        let m = 0;
        for (let r = 0; r < 4; r++) if (cf[tet[r]] < 0) m |= 1 << r;
        const tris = TET_CASES[m];
        for (let n = 0; n < tris.length; n++) {
          const e = TET_EDGES[tris[n]];
          outIdx.push(crossing(tet[e[0]], tet[e[1]]));
        }
      }
    }
  }

  return assembleMesh(outPos, outIdx);
}

function assembleMesh(outPos, outIdx) {
  const positions = Float32Array.from(outPos);
  const indices = Uint32Array.from(outIdx);

  // Smooth face-weighted vertex normals
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1e-6;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }

  // Calculate manifold edge stats and enclosed volume
  // every edge as one number (lo · V + hi), sorted, counted in runs
  const nV = positions.length / 3, keys = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const u = indices[i + e], v = indices[i + (e + 1) % 3];
      keys[i + e] = u < v ? u * nV + v : v * nV + u;
    }
  }
  keys.sort();
  let boundaryEdges = 0, nonManifold = 0;
  for (let i = 0; i < keys.length;) {
    let j = i + 1; while (j < keys.length && keys[j] === keys[i]) j++;
    const count = j - i;
    if (count === 1) boundaryEdges++;
    else if (count > 2) nonManifold++;
    i = j;
  }

  // Divergence theorem volume and surface area
  let vol = 0, area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    area += 0.5 * Math.hypot(nx, ny, nz);
    vol += (ax * (by * cz - bz * cy) + bx * (cy * az - cz * ay) + cx * (ay * bz - az * by)) / 6;
  }

  return {
    positions,
    indices,
    normals,
    stats: {
      vertices: positions.length / 3,
      triangles: indices.length / 3,
      boundaryEdges,
      nonManifold,
      closed: boundaryEdges === 0 && nonManifold === 0,
      volumeCm3: Math.abs(vol) / 1000,
      areaCm2: area / 100,
      isLattice: true
    }
  };
}

// ── 6. Volume-Calibrated Melt ─────────────────────────────────────────────────
export function meltSchedule(passes) {
  const out = [];
  let left = passes;
  if (left <= 8) { for (let p = 0; p < left; p++) out.push(1); return out; }
  for (let p = 0; p < 4; p++) out.push(1);
  left -= 4;
  while (left >= 16 + 4) { out.push(4); left -= 16; }
  while (left >= 4) { out.push(2); left -= 4; }
  while (left > 0) { out.push(1); left -= 1; }
  return out;
}

export function meltSparseGrid(g, passes) {
  if (passes <= 0) return g;
  const nbx = g.nb[0], nby = g.nb[1], nbz = g.nb[2];
  const grow = [];
  for (let s = 0; s < g.bricks.length; s++) {
    const id = g.owner[s], bk = Math.floor(id / (nbx * nby)), bj = Math.floor(id / nbx) % nby, bi = id % nbx;
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const a = bi + di, b = bj + dj, c = bk + dk;
      if (a < 0 || b < 0 || c < 0 || a >= nbx || b >= nby || c >= nbz) continue;
      const n = (c * nby + b) * nbx + a;
      if (g.slot[n] < 0) grow.push(n);
    }
  }
  for (const n of grow) allocBrick(g, n);

  const next = g.bricks.map(a => new Float32Array(a.length));
  for (const st of meltSchedule(passes)) {
    for (let s = 0; s < g.bricks.length; s++) {
      const id = g.owner[s], src = g.bricks[s], dst = next[s];
      const bk = Math.floor(id / (nbx * nby)), bj = Math.floor(id / nbx) % nby, bi = id % nbx;
      for (let o = 0; o < BS3; o++) {
        const li = o & 7, lj = (o >> 3) & 7, lk = o >> 6;
        const i = bi * BS + li, j = bj * BS + lj, k = bk * BS + lk;
        const xm = li >= st ? src[o - st] : sparseGridGet(g, i - st, j, k);
        const xp = li + st <= 7 ? src[o + st] : sparseGridGet(g, i + st, j, k);
        const ym = lj >= st ? src[o - 8 * st] : sparseGridGet(g, i, j - st, k);
        const yp = lj + st <= 7 ? src[o + 8 * st] : sparseGridGet(g, i, j + st, k);
        const zm = lk >= st ? src[o - 64 * st] : sparseGridGet(g, i, j, k - st);
        const zp = lk + st <= 7 ? src[o + 64 * st] : sparseGridGet(g, i, j, k + st);
        dst[o] = (src[o] + xm + xp + ym + yp + zm + zp) / 7;
      }
    }
    for (let s = 0; s < g.bricks.length; s++) {
      const t = g.bricks[s]; g.bricks[s] = next[s]; next[s] = t;
    }
  }
  return g;
}

export function sparseGridVolume(g, iso = 0) {
  let count = 0;
  const h3 = g.h * g.h * g.h;
  for (let s = 0; s < g.bricks.length; s++) {
    const arr = g.bricks[s];
    for (let o = 0; o < BS3; o++) {
      if (arr[o] < iso) count++;
    }
  }
  return count * h3;
}

export function isoForVolume(g, targetVol) {
  let a = -g.band * 0.8, b = g.band * 0.8;
  for (let it = 0; it < 24; it++) {
    const m = (a + b) / 2;
    if (sparseGridVolume(g, m) < targetVol) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

// ── 7. Footwear Outsole Tread Masking ─────────────────────────────────────────
export function computeSoleTreadMask(positions, indices) {
  const nv = positions.length / 3;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < minY) minY = positions[i];
    if (positions[i] > maxY) maxY = positions[i];
  }
  const hSpan = maxY - minY || 1;
  const treadCutY = minY + hSpan * 0.28; // Lower 28% is the ground-contact tread/outsole plate
  const mask = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const y = positions[v * 3 + 1];
    mask[v] = y <= treadCutY ? 1.0 : Math.max(0, 1.0 - (y - treadCutY) / (hSpan * 0.15));
  }
  return mask;
}

// Connected components by shared vertex; drops those under an absolute volume
// (mm³) or under a share of the largest. Returns the compacted mesh.
function dropSmallComponents(positions, indices, minAbsMM3 = 0, minShare = 0) {
  const nv = positions.length / 3, nt = indices.length / 3;
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < nt; t++) {
    const a = find(indices[t * 3]), b = find(indices[t * 3 + 1]), c = find(indices[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a); if (a2 !== c) parent[c] = a2;
  }
  const vol = new Map();
  for (let t = 0; t < nt; t++) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const v = (ax * (by * cz - bz * cy) + bx * (cy * az - cz * ay) + cx * (ay * bz - az * by)) / 6;
    const r = find(indices[t * 3]);
    vol.set(r, (vol.get(r) || 0) + v);
  }
  let maxV = 0; for (const v of vol.values()) maxV = Math.max(maxV, Math.abs(v));
  const floor = Math.max(minAbsMM3, maxV * minShare);
  const keepRoot = new Set(); for (const [r, v] of vol) if (Math.abs(v) >= floor) keepRoot.add(r);
  const remap = new Int32Array(nv).fill(-1);
  const outP = []; const outI = [];
  for (let t = 0; t < nt; t++) {
    if (!keepRoot.has(find(indices[t * 3]))) continue;
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e];
      if (remap[v] < 0) { remap[v] = outP.length / 3; outP.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
      outI.push(remap[v]);
    }
  }
  return { positions: Float32Array.from(outP), indices: Uint32Array.from(outI), components: keepRoot.size, dropped: vol.size - keepRoot.size };
}

// ── 8. Master Lattice Builder ──────────────────────────────────────────────────
/**
 * Builds a real 3D lattice mesh from a solid plate mesh.
 *
 * @param {object} basePlate  { positions: Float32Array, indices: Uint32Array }
 * @param {object} options    {
 *   pattern: 'gyroid'|'voronoi'|'kelvin'|'diamond'|'octet'|'schwarz_p'|'schwarz_d'|'neovius'|'spinodal',
 *   cellMM: 12, infillPct: 20, skinMM: 1.5,
 *   skinWhere: 'all'|'mask'|'none',
 *   mask: Float32Array,
 *   meltMM: 0,
 *   gridMM: 1.5,
 *   sparse: true
 * }
 * @returns {object} { ok: true, positions, indices, normals, stats, pattern, cellMM, infillPct, skinMM, isLattice: true }
 */
export function buildLatticeMesh(basePlate, options = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rawPattern = options.pattern || 'gyroid';
  const pattern = rawPattern.toLowerCase();
  const cellMM = Math.max(4, options.cellMM || 12);
  const infillPct = Math.max(5, Math.min(80, options.infillPct || 20));
  const skinMM = options.skinMM !== undefined ? Math.max(0, options.skinMM) : 1.5;
  const skinWhere = options.skinWhere || (skinMM > 0 ? 'all' : 'none');
  const meltMM = options.meltMM !== undefined ? Math.max(0, options.meltMM) : 0;
  // THE RESOLUTION follows the strut, not the cell: a sheet a fifth of a 22 mm
  // gyroid is 1.3 mm thick and a 2.75 mm grid steps over it, leaving shards.
  // The grid is sized so a strut is 2.5 voxels across, held to a voxel budget
  // over the piece's volume (Resolution: draft / standard / fine); where the
  // budget cannot reach the strut, the strut is thickened to what the grid
  // carries and says so.
  const strutHalf = latticeHalfThickness(pattern, cellMM, infillPct);
  const pieceMM3 = basePlate.stats && basePlate.stats.volumeCm3 > 0 ? basePlate.stats.volumeCm3 * 1000 : null;
  const budget = LATTICE_VOXEL_BUDGET[options.resolution] || LATTICE_VOXEL_BUDGET.standard;
  const gridFloor = pieceMM3 ? Math.cbrt(pieceMM3 / budget) : 0.5;
  const gridMM = options.gridMM || Math.max(0.3, Math.min(3.0, Math.max(gridFloor, Math.min(cellMM / 6, (2 * strutHalf) / 2.5))));
  const strutExtra = Math.max(0, 1.25 * gridMM - strutHalf);
  const isGraded = options.graded === true || options.densityGraded === true || options.infillMode === 'plantar' || (typeof pattern === 'string' && pattern.includes('plantar'));
  const latAt = (x, y, z) => {
    let effInfill = infillPct;
    if (isGraded) {
      const pw = plantarPressureWeight(x, y, z, options.landmarks || basePlate.landmarks, bb);
      effInfill = Math.max(2, Math.min(85, infillPct * pw));
    }
    return latticeSDF(pattern, x, y, z, cellMM, effInfill) - strutExtra;
  };
  // THE ANCHOR: a lattice open to the outside keeps a skin on its inside face
  // (the plate's inner sheet, against the last) so every strut lands on one
  // form; a strut network sliced by a wall thinner than its cell is otherwise
  // a heap of loose struts
  const sheet = basePlate.sheet || null;
  const anchorMM = sheet && skinWhere !== 'all' && options.anchor !== false ? Math.max(1.2, 1.5 * gridMM) : 0;

  // The field is taken from the surface the piece draws (terrain, drips and
  // all); the SubD cage is coarser than the relief and would erase it.
  const P = basePlate.positions;
  const I = basePlate.indices;

  if (!P || !I || P.length < 9 || I.length < 3) {
    return { ok: false, reason: 'Invalid base mesh for lattice' };
  }

  const sdf = buildMeshSDF(P, I);
  const bb = sdf.bbox;

  // Mask handling for 'mask' skinWhere
  let mask = options.mask || basePlate.mask || null;
  if (skinWhere === 'mask' && !mask) {
    mask = computeSoleTreadMask(P, I);
  }

  const useSparse = options.sparse !== false;

  if (useSparse) {
    const pad = Math.max(4, gridMM * 2.5);
    const lo = [bb.minX - pad, bb.minY - pad, bb.minZ - pad];
    const hi = [bb.maxX + pad, bb.maxY + pad, bb.maxZ + pad];
    const band = Math.max(gridMM * 3, skinMM + 4.0);

    const grid = createSparseGrid(lo, hi, gridMM, band);
    const totalVoxelsX = grid.nb[0] * BS;
    const totalVoxelsY = grid.nb[1] * BS;
    const totalVoxelsZ = grid.nb[2] * BS;

    const yMin = bb.minY, ySpan = (bb.maxY - bb.minY) || 1;
    const treadCutY = yMin + ySpan * 0.28;

    // A full skin keeps the piece's own surface as the outside and meshes
    // only the cavities: void = deeper than the skin AND outside the struts.
    // The cavity surface is flipped and joined to the skin, so the outside
    // is exactly the drawn plate and the lattice lives behind it.
    const skinned = skinWhere === 'all' && skinMM > 0.05;
    // Where the fine field is needed: near the skin's inner level set when
    // skinned, near the surface otherwise. Everything else stays at the
    // grid's default (outside, +band).
    const need = (d) => skinned ? d < -skinMM + gridMM * 2 : d < gridMM * 2;
    // A coarse pass over 4×4×4 blocks (the distance is 1-Lipschitz): a block
    // whose center is farther than its half-diagonal from the needed region
    // is skipped; one wholly deeper than the skin reuses the center's
    // distance, which only sets values that are negative either way.
    const C = 4, r = gridMM * C * 0.8661;
    // no voxel needs the mesh distance beyond the skin, the strut and a few voxels
    const cap = Math.max(skinMM, strutHalf + strutExtra, anchorMM) + gridMM * 4 + 1;
    const deep = skinned ? -skinMM - gridMM * 2 : -Math.max(strutHalf + strutExtra, anchorMM) - gridMM * 2;

    const fieldAt = (x, y, z, dMesh, inner) => {
      const dLat = latAt(x, y, z);
      if (skinned) return Math.max(dMesh + skinMM, -dLat);
      let effSkin = skinWhere === 'none' ? 0 : skinMM;
      if (skinWhere === 'mask') {
        const mWeight = y <= treadCutY ? 1.0 : Math.max(0, 1.0 - (y - treadCutY) / (ySpan * 0.15));
        effSkin = skinMM * mWeight;
      }
      if (inner && anchorMM > effSkin) effSkin = anchorMM;
      const strut = Math.max(dMesh, dLat);
      return effSkin > 0.05 ? Math.min(Math.max(dMesh, -(dMesh + effSkin)), strut) : strut;
    };

    // the mesh's distance is exact on every second grid point and trilinear
    // between: it is 1-Lipschitz and smooth over two voxels (a 20 mm curve
    // bends it by ~h²/8R, 0.05 mm at 1.4 mm), and each exact read is a
    // nearest-triangle search — the build's whole cost
    const exact = new Map(), innerOf = new Map(), NXv = totalVoxelsX + 2, NYv = totalVoxelsY + 2;
    const exactAt = (i, j, k) => {
      const key = i + NXv * (j + NYv * k);
      let d = exact.get(key);
      if (d === undefined) {
        d = sdf.signedDistance(lo[0] + i * gridMM, lo[1] + j * gridMM, lo[2] + k * gridMM, cap + gridMM * 2); exact.set(key, d);
        if (anchorMM) { const t = sdf.nearestTriangle(); innerOf.set(key, t >= 0 && (sheet[I[t * 3]] + sheet[I[t * 3 + 1]] + sheet[I[t * 3 + 2]]) < 0.75); }
      }
      return d;
    };
    // the inner flag of the exact sample nearest the voxel
    const innerAt = (i, j, k) => { if (!anchorMM) return false; const a = i & ~1, b = j & ~1, c = k & ~1; exactAt(a, b, c); return innerOf.get(a + NXv * (b + NYv * c)) === true; };
    const meshAt = (i, j, k) => {
      const a = i & ~1, b = j & ~1, c = k & ~1, u = (i - a) / 2, v = (j - b) / 2, w = (k - c) / 2;
      if (!u && !v && !w) return exactAt(a, b, c);
      let d = 0;
      for (let n = 0; n < 8; n++) {
        const di = n & 1, dj = (n >> 1) & 1, dk = (n >> 2) & 1;
        const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
        if (wt) d += wt * exactAt(a + 2 * di, b + 2 * dj, c + 2 * dk);
      }
      return d;
    };
    for (let k0 = 1; k0 < totalVoxelsZ - 1; k0 += C) {
      for (let j0 = 1; j0 < totalVoxelsY - 1; j0 += C) {
        for (let i0 = 1; i0 < totalVoxelsX - 1; i0 += C) {
          const cx = lo[0] + (i0 + (C - 1) / 2) * gridMM, cy = lo[1] + (j0 + (C - 1) / 2) * gridMM, cz = lo[2] + (k0 + (C - 1) / 2) * gridMM;
          const dC = sdf.signedDistance(cx, cy, cz, r + cap);
          if (!need(dC - r)) continue;
          const coarseDeep = dC + r < deep;
          for (let k = k0; k < Math.min(k0 + C, totalVoxelsZ - 1); k++) {
            const z = lo[2] + k * gridMM;
            for (let j = j0; j < Math.min(j0 + C, totalVoxelsY - 1); j++) {
              const y = lo[1] + j * gridMM;
              for (let i = i0; i < Math.min(i0 + C, totalVoxelsX - 1); i++) {
                const x = lo[0] + i * gridMM;
                const dMesh = coarseDeep ? dC : meshAt(i, j, k);
                if (!need(dMesh)) continue;
                sparseGridSet(grid, i, j, k, fieldAt(x, y, z, dMesh, !coarseDeep && innerAt(i, j, k)));
              }
            }
          }
        }
      }
    }

    let iso = 0;
    if (meltMM > 0) {
      const targetVol = sparseGridVolume(grid, 0);
      const passes = Math.max(1, Math.round(3.5 * (meltMM / gridMM) ** 2));
      meltSparseGrid(grid, passes);
      iso = isoForVolume(grid, targetVol);
    }

    const march = sparseMarchTetrahedra(grid, iso);
    let mesh;
    if (skinned) {
      const voids = dropSmallComponents(march.positions, march.indices, gridMM * gridMM * gridMM * 4, 0);
      const nP = P.length, nV = voids.positions.length;
      const outP = new Float32Array(nP + nV);
      outP.set(P, 0); outP.set(voids.positions, nP);
      const base = nP / 3;
      const outI = new Uint32Array(I.length + voids.indices.length);
      outI.set(I, 0);
      for (let t = 0; t < voids.indices.length; t += 3) {
        outI[I.length + t] = voids.indices[t] + base;
        outI[I.length + t + 1] = voids.indices[t + 2] + base;
        outI[I.length + t + 2] = voids.indices[t + 1] + base;
      }
      mesh = assembleMesh(outP, outI);
      mesh.stats.cavities = voids.components;
    } else {
      const kept = dropSmallComponents(march.positions, march.indices, 0, 0.02);
      mesh = assembleMesh(kept.positions, kept.indices);
      mesh.stats.dropped = kept.dropped;
    }
    const baseStats = basePlate.stats || {};
    const solidVol = baseStats.volumeCm3 || mesh.stats.volumeCm3;
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    return {
      ok: true,
      positions: mesh.positions,
      indices: mesh.indices,
      normals: mesh.normals,
      cage: basePlate.cage || null,
      limit: basePlate.limit || null,
      rims: basePlate.rims || [],
      plateStats: basePlate.plateStats || null,
      terrain: basePlate.terrain || null,
      stats: {
        ...baseStats,
        ...mesh.stats,
        solidVolumeCm3: solidVol,
        volumeCm3: solidVol,
        latticeVolumeCm3: mesh.stats.volumeCm3,
        cellMM,
        infillPct,
        skinMM,
        skinWhere,
        meltMM,
        pattern,
        gridMM: +gridMM.toFixed(2),
        anchorMM: +anchorMM.toFixed(2),
        strutMM: +(2 * (strutHalf + strutExtra)).toFixed(2),
        strutHeld: strutExtra > 1e-6,
        graded: isGraded,
        resolution: options.resolution || 'standard',
        buildMs: Math.round(ms)
      },
      pattern,
      cellMM,
      infillPct,
      skinMM,
      skinWhere,
      meltMM,
      graded: isGraded,
      isLattice: true
    };
  }

  // Fallback dense grid path
  const pad = Math.max(4, gridMM * 2);
  const ox = bb.minX - pad, oy = bb.minY - pad, oz = bb.minZ - pad;
  const nx = Math.ceil((bb.maxX - bb.minX + 2 * pad) / gridMM) + 1;
  const ny = Math.ceil((bb.maxY - bb.minY + 2 * pad) / gridMM) + 1;
  const nz = Math.ceil((bb.maxZ - bb.minZ + 2 * pad) / gridMM) + 1;

  const field = new Float32Array(nx * ny * nz);
  let idx = 0;

  for (let k = 0; k < nz; k++) {
    const z = oz + k * gridMM;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * gridMM;
      for (let i = 0; i < nx; i++) {
        if (i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || k === 0 || k === nz - 1) {
          field[idx++] = Math.max(gridMM, 2.0);
          continue;
        }
        const x = ox + i * gridMM;
        const dMesh = sdf.signedDistance(x, y, z);
        let val;
        if (dMesh > gridMM * 1.5) {
          val = dMesh;
        } else {
          const dLat = latAt(x, y, z);
          val = skinMM > 0
            ? Math.min(Math.max(dMesh, -(dMesh + skinMM)), Math.max(dMesh, dLat))
            : Math.max(dMesh, dLat);
        }
        field[idx++] = val;
      }
    }
  }

  const mesh = marchTetrahedra(field, nx, ny, nz, ox, oy, oz, gridMM);
  const baseStats = basePlate.stats || {};
  const solidVol = baseStats.volumeCm3 || mesh.stats.volumeCm3;

  return {
    ok: true,
    positions: mesh.positions,
    indices: mesh.indices,
    normals: mesh.normals,
    cage: basePlate.cage || null,
    limit: basePlate.limit || null,
    rims: basePlate.rims || [],
    plateStats: basePlate.plateStats || null,
    terrain: basePlate.terrain || null,
    stats: {
      ...baseStats,
      ...mesh.stats,
      solidVolumeCm3: solidVol,
      volumeCm3: solidVol,
      latticeVolumeCm3: mesh.stats.volumeCm3,
      cellMM,
      infillPct,
      skinMM,
      skinWhere,
      pattern,
      isLattice: true
    },
    pattern,
    cellMM,
    infillPct,
    skinMM,
    isLattice: true
  };
}
