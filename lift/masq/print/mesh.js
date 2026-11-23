// Triangle-mesh geometry for the print estimator: face and vertex normals,
// rotations about the plate's axes and the export's frame, bounds, the drop
// onto z = 0, a ray-cast wall thickness, and the fixture solids. Millimeters
// throughout; a mesh is {positions: Float32Array, indices: Uint32Array}
// (stl.js reads and writes it).

/**
 * Unit face normals (the winding's) and areas, mm².
 * @returns {{normals: Float32Array, areas: Float32Array}}
 */
export function faceNormalsAreas(positions, indices) {
  const n = indices.length / 3;
  const normals = new Float32Array(n * 3), areas = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    areas[t] = L / 2;
    if (L > 0) { normals[t * 3] = nx / L; normals[t * 3 + 1] = ny / L; normals[t * 3 + 2] = nz / L; }
  }
  return { normals, areas };
}

/** Row-major 3×3 rotation about x by deg. y' = y cos − z sin, z' = y sin + z cos. */
export function rotationX(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Row-major 3×3 rotation about y by deg. x' = x cos + z sin, z' = −x sin + z cos. */
export function rotationY(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** A·B, row-major 3×3. */
export function multiply(A, B) {
  const M = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    M[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return M;
}

/** M·v for a row-major 3×3. */
export function apply(M, v) {
  return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
}

/**
 * The print rotation for a tilt about x and a lean about y, applied to the
 * dome-up frame: R = Ry(lean) · Rx(tilt). Tilt 0, lean 0 is the export's frame.
 */
export function tiltLean(tiltDeg, leanDeg) {
  return multiply(rotationY(leanDeg), rotationX(tiltDeg));
}

/** Rotates every vertex; returns a new array. */
export function rotate(positions, M) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = M[0] * x + M[1] * y + M[2] * z;
    out[i + 1] = M[3] * x + M[4] * y + M[5] * z;
    out[i + 2] = M[6] * x + M[7] * y + M[8] * z;
  }
  return out;
}

/** @returns {{min: number[], max: number[], size: number[]}} */
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = positions[i + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Signed volume of the closed mesh by the divergence theorem, mm³; positive for outward winding. */
export function volume({ positions: p, indices }) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
       - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * Unit vertex normals, area-weighted from the faces, and each vertex's share
 * of the surface (a third of its faces' areas), mm².
 * @returns {{normals: Float32Array, areas: Float32Array}}
 */
export function vertexNormalsAreas(positions, indices, face = faceNormalsAreas(positions, indices)) {
  const nV = positions.length / 3;
  const normals = new Float32Array(nV * 3), areas = new Float32Array(nV);
  for (let t = 0; t < indices.length / 3; t++) {
    const a = face.areas[t], nx = face.normals[t * 3] * a, ny = face.normals[t * 3 + 1] * a, nz = face.normals[t * 3 + 2] * a;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      normals[v * 3] += nx; normals[v * 3 + 1] += ny; normals[v * 3 + 2] += nz;
      areas[v] += a / 3;
    }
  }
  for (let v = 0; v < nV; v++) {
    const L = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (L > 0) { normals[v * 3] /= L; normals[v * 3 + 1] /= L; normals[v * 3 + 2] /= L; }
  }
  return { normals, areas };
}

/**
 * The export's frame (src/exporters.js orientForPrint): the rotation taking
 * the unit vector `up` to (0, 0, −1) about their common normal, row-major.
 * Tilt 0 / Lean 0 is this frame, so the chip and the export agree.
 */
export function frameFromUp(up) {
  const L = Math.hypot(up[0], up[1], up[2]);
  if (!(L > 1e-9)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const mx = up[0] / L, my = up[1] / L, mz = up[2] / L;
  // axis = up × (0, 0, −1)
  let ax = -my, ay = mx, az = 0;
  const s = Math.hypot(ax, ay, az), c = -mz;
  if (s < 1e-9) { const k = c > 0 ? 1 : -1; return [1, 0, 0, 0, k, 0, 0, 0, k]; }
  ax /= s; ay /= s; az /= s;
  const ang = Math.atan2(s, c), C = Math.cos(ang), S = Math.sin(ang), t = 1 - C;
  return [
    t * ax * ax + C, t * ax * ay - S * az, t * ax * az + S * ay,
    t * ax * ay + S * az, t * ay * ay + C, t * ay * az - S * ax,
    t * ax * az - S * ay, t * ay * az + S * ax, t * az * az + C,
  ];
}

/**
 * The wall under every vertex: the distance along the inward normal to the
 * first face the ray leaves the solid through, mm; `maxMM` where nothing is
 * hit within it. Triangles are bucketed on a uniform 3D grid and the ray
 * walks the cells it crosses (a DDA), so 34k vertices cost tens of ms.
 * @returns {Float32Array}
 */
export function rayThickness(positions, indices, normals, maxMM = 50, cellMM = 4) {
  const nV = positions.length / 3, nT = indices.length / 3;
  const b = bounds(positions);
  const c = cellMM, o = [b.min[0] - c, b.min[1] - c, b.min[2] - c];
  const nx = Math.ceil((b.max[0] - o[0]) / c) + 1, ny = Math.ceil((b.max[1] - o[1]) / c) + 1, nz = Math.ceil((b.max[2] - o[2]) / c) + 1;
  const cellOf = (x, y, z) => [Math.floor((x - o[0]) / c), Math.floor((y - o[1]) / c), Math.floor((z - o[2]) / c)];
  const count = new Int32Array(nx * ny * nz + 1);
  const lo = new Int32Array(nT * 3), hi = new Int32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3] * 3, bb = indices[t * 3 + 1] * 3, cc = indices[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const v0 = positions[a + k], v1 = positions[bb + k], v2 = positions[cc + k];
      lo[t * 3 + k] = Math.floor((Math.min(v0, v1, v2) - o[k]) / c); hi[t * 3 + k] = Math.floor((Math.max(v0, v1, v2) - o[k]) / c);
    }
    for (let z = lo[t * 3 + 2]; z <= hi[t * 3 + 2]; z++) for (let y = lo[t * 3 + 1]; y <= hi[t * 3 + 1]; y++) for (let x = lo[t * 3]; x <= hi[t * 3]; x++) count[(z * ny + y) * nx + x + 1]++;
  }
  for (let i = 0; i < nx * ny * nz; i++) count[i + 1] += count[i];
  const items = new Int32Array(count[nx * ny * nz]);
  const fill = count.slice(0, nx * ny * nz);
  for (let t = 0; t < nT; t++) for (let z = lo[t * 3 + 2]; z <= hi[t * 3 + 2]; z++) for (let y = lo[t * 3 + 1]; y <= hi[t * 3 + 1]; y++) for (let x = lo[t * 3]; x <= hi[t * 3]; x++) items[fill[(z * ny + y) * nx + x]++] = t;
  const face = faceNormalsAreas(positions, indices);
  const out = new Float32Array(nV);
  const stamp = new Int32Array(nT);
  let stampId = 0;
  const EPS = 1e-6;
  for (let v = 0; v < nV; v++) {
    const ox = positions[v * 3], oy = positions[v * 3 + 1], oz = positions[v * 3 + 2];
    const dx = -normals[v * 3], dy = -normals[v * 3 + 1], dz = -normals[v * 3 + 2];
    if (dx === 0 && dy === 0 && dz === 0) { out[v] = maxMM; continue; }
    let best = maxMM;
    const id = ++stampId;
    let [cx, cy, cz] = cellOf(ox, oy, oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tx = dx !== 0 ? ((o[0] + (cx + (dx > 0 ? 1 : 0)) * c) - ox) / dx : Infinity;
    let ty = dy !== 0 ? ((o[1] + (cy + (dy > 0 ? 1 : 0)) * c) - oy) / dy : Infinity;
    let tz = dz !== 0 ? ((o[2] + (cz + (dz > 0 ? 1 : 0)) * c) - oz) / dz : Infinity;
    const ddx = dx !== 0 ? c / Math.abs(dx) : Infinity, ddy = dy !== 0 ? c / Math.abs(dy) : Infinity, ddz = dz !== 0 ? c / Math.abs(dz) : Infinity;
    let t = 0;
    while (t < best && cx >= 0 && cx < nx && cy >= 0 && cy < ny && cz >= 0 && cz < nz) {
      const cell = (cz * ny + cy) * nx + cx;
      for (let i = count[cell], e = count[cell + 1]; i < e; i++) {
        const tri = items[i];
        if (stamp[tri] === id) continue;
        stamp[tri] = id;
        // the ray leaves the solid through a face it hits from inside
        if (face.normals[tri * 3] * dx + face.normals[tri * 3 + 1] * dy + face.normals[tri * 3 + 2] * dz <= 0) continue;
        const a = indices[tri * 3] * 3, bb = indices[tri * 3 + 1] * 3, cc = indices[tri * 3 + 2] * 3;
        const e1x = positions[bb] - positions[a], e1y = positions[bb + 1] - positions[a + 1], e1z = positions[bb + 2] - positions[a + 2];
        const e2x = positions[cc] - positions[a], e2y = positions[cc + 1] - positions[a + 1], e2z = positions[cc + 2] - positions[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const wx = ox - positions[a], wy = oy - positions[a + 1], wz = oz - positions[a + 2];
        const u = (wx * px + wy * py + wz * pz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = wy * e1z - wz * e1y, qy = wz * e1x - wx * e1z, qz = wx * e1y - wy * e1x;
        const w = (dx * qx + dy * qy + dz * qz) * inv;
        if (w < -1e-9 || u + w > 1 + 1e-9) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > EPS && tt < best) best = tt;
      }
      if (tx < ty && tx < tz) { t = tx; tx += ddx; cx += sx; }
      else if (ty < tz) { t = ty; ty += ddy; cy += sy; }
      else { t = tz; tz += ddz; cz += sz; }
    }
    out[v] = best;
  }
  return out;
}

/**
 * Centers x and y on the bounding box and puts the lowest point on z = 0.
 * Returns a new array and the translation that was subtracted.
 */
export function dropToPlate(positions) {
  const { min, max } = bounds(positions);
  const off = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] - off[0]; out[i + 1] = positions[i + 1] - off[1]; out[i + 2] = positions[i + 2] - off[2];
  }
  return { positions: out, offset: off };
}

/** Rotate by M, then drop to the plate: the print frame of one candidate. */
export function orient(positions, M) {
  return dropToPlate(rotate(positions, M));
}

/**
 * An axis-aligned box as 12 outward-wound triangles, for fixtures.
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
export function box(x0, x1, y0, y1, z0, z1) {
  const P = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(P), indices: Uint32Array.from(I) };
}

/** Several meshes as one, indices offset. */
export function merge(meshes) {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, ov);
    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + ov / 3;
    ov += m.positions.length; oi += m.indices.length;
  }
  return { positions, indices };
}

/**
 * A hemispherical shell for fixtures: outer radius R, wall t, dome up on
 * z = 0 with its rim annulus closed; `segments` around, `rings` from rim to
 * pole. Outward winding.
 */
export function hemisphereShell(R, t, segments = 96, rings = 24) {
  const r = R - t;
  const P = [], I = [];
  const ring = (rad, k) => { const phi = (k / rings) * Math.PI / 2; return [rad * Math.cos(phi), rad * Math.sin(phi)]; };
  const push = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  // Outer surface: rings k = 0 (rim) .. rings-1, then the pole.
  const outer = [], inner = [];
  for (let k = 0; k < rings; k++) {
    const [rr, zz] = ring(R, k), row = [];
    for (let s = 0; s < segments; s++) { const a = (s / segments) * 2 * Math.PI; row.push(push(rr * Math.cos(a), rr * Math.sin(a), zz)); }
    outer.push(row);
  }
  const poleO = push(0, 0, R);
  for (let k = 0; k < rings; k++) {
    const [rr, zz] = ring(r, k), row = [];
    for (let s = 0; s < segments; s++) { const a = (s / segments) * 2 * Math.PI; row.push(push(rr * Math.cos(a), rr * Math.sin(a), zz)); }
    inner.push(row);
  }
  const poleI = push(0, 0, r);
  // The outer surface, then the inner, then the rim: the fixture files were written in this order.
  for (let k = 0; k < rings - 1; k++) for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    I.push(outer[k][s], outer[k][s1], outer[k + 1][s1], outer[k][s], outer[k + 1][s1], outer[k + 1][s]);
  }
  for (let s = 0; s < segments; s++) I.push(outer[rings - 1][s], outer[rings - 1][(s + 1) % segments], poleO);
  for (let k = 0; k < rings - 1; k++) for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    I.push(inner[k][s], inner[k + 1][s1], inner[k][s1], inner[k][s], inner[k + 1][s], inner[k + 1][s1]);
  }
  for (let s = 0; s < segments; s++) I.push(inner[rings - 1][s], poleI, inner[rings - 1][(s + 1) % segments]);
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    // The rim annulus faces down.
    I.push(outer[0][s], inner[0][s1], outer[0][s1], outer[0][s], inner[0][s], inner[0][s1]);
  }
  return { positions: Float32Array.from(P), indices: Uint32Array.from(I) };
}
