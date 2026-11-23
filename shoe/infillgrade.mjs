// Graded infill for the Infill body: the slicer's own infill, its density varying through a piece.
// Give's engine (shoe/grade.mjs, generated) cuts the grade into bands, each a closed modifier volume
// the 3MF carries as a modifier_part with its sparse_infill_density. This file holds what is the
// shoe's own: the maps in shoe words, Plantar as a field, and the mean the estimate reads.
//
// Maps, all in the app frame (x heel -> toe, y floor -> top, z across):
//   plantar  the lattice's plantar pressure map (lattice.mjs plantarPressureWeight) times the Infill %,
//            clamped 2..85 as the lattice clamps it, so a lattice and an infill body grade by ONE map
//   along    a curve of % from heel to toe (Give's linear map on x), presets below
//   points   points placed on the piece, each with its own %, blended by inverse distance (Give's points map);
//            a point is stored as u = its place in the piece's bounding box (0..1 per axis), so it rides a
//            size change or a new last with the piece
import { prepMap, makeBands, bandMesh, bandIndexAt, bbox, PRESETS } from './grade.mjs';
import { plantarPressureWeight } from './lattice.mjs';

export const ALONG_PRESETS = {
  'Soft heel, firm arch': PRESETS['Soft heel, firm arch'],
  'Firm ends, soft middle': PRESETS['Firm ends, soft middle'],
  'Soft to firm': PRESETS['Soft to firm'],
};

/** A stored point list made safe: at most 24 points, each u three finite numbers near the box, v 1..100 % */
export function sanePoints(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const q of list) {
    if (out.length >= 24) break;
    if (!q || !Array.isArray(q.u) || q.u.length !== 3) continue;
    const u = q.u.map(Number), v = Number(q.v);
    if (!u.every((x) => Number.isFinite(x) && x >= -0.5 && x <= 1.5) || !Number.isFinite(v)) continue;
    out.push({ u, v: Math.max(1, Math.min(100, Math.round(v))) });
  }
  return out;
}

/** The map for a piece. grade = { mode: 'plantar'|'along'|'points', infillPct, preset, points, count, landmarks } */
export function gradeMap(mesh, grade) {
  const b = bbox(mesh), count = Math.min(16, Math.max(2, grade.count | 0 || 6));   // never a thousand bands from a corrupt number
  if (grade.mode === 'along') {
    const curve = ALONG_PRESETS[grade.preset] || ALONG_PRESETS['Soft heel, firm arch'];
    return prepMap(mesh, { type: 'linear', axis: 0, curve, smooth: true, count });
  }
  if (grade.mode === 'points') {
    const pts = sanePoints(grade.points);
    if (!pts.length) throw new Error('a points grade needs at least one point');
    const points = pts.map(({ u, v }) => ({ p: u.map((x, k) => b.lo[k] + x * b.size[k]), v }));
    return prepMap(mesh, { type: 'points', points, blend: 2, count });
  }
  if (grade.mode !== 'plantar') throw new Error('grade.mode is plantar, along or points, not ' + grade.mode);
  const base = Math.min(100, Math.max(1, +grade.infillPct || 20)), lm = grade.landmarks || null;
  const pbb = { minX: b.lo[0], maxX: b.hi[0], minZ: b.lo[2], maxZ: b.hi[2] };
  const field = (x, y, z) => Math.max(2, Math.min(85, base * plantarPressureWeight(x, y, z, lm, pbb)));
  // Give's points machinery takes any field: its band levels come from the range of `points` values,
  // so the range is read off the piece's own vertices and handed over as two value-only points
  let lo = Infinity, hi = -Infinity;
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) { const d = field(v[i], v[i + 1], v[i + 2]); if (d < lo) lo = d; if (d > hi) hi = d; }
  return { type: 'points', count, b, C: null, field, points: [{ p: [0, 0, 0], v: lo }, { p: [0, 0, 0], v: hi }] };
}

/**
 * The bands of a piece: [{ density, positions, indices }] in the app frame, the map, and the
 * volume-weighted mean %. positions/indices are the piece's (app frame, mm).
 */
export function gradeBands(positions, indices, grade) {
  const mesh = { vertices: positions, triangles: indices };
  const P = gradeMap(mesh, grade);
  const bands = makeBands(mesh, P);
  const out = bands.map((band) => {
    const m = bandMesh(mesh, P, band);
    return { density: band.density, positions: Float32Array.from(m.vertices), indices: Uint32Array.from(m.triangles) };
  });
  const densityAt = (x, y, z) => bands[bandIndexAt(P, bands, x, y, z)].density;
  return { bands: out, levels: bands, map: P, densityAt, meanPct: meanDensity(positions, indices, densityAt) };
}

/**
 * The volume-weighted mean of a density over a closed mesh: columns along y every `stepMM` in x and z,
 * each cut where the ray crosses the surface (parity: inside between pairs), sampled along y at the
 * same step. Returns null for a mesh no column finds inside.
 */
export function meanDensity(positions, indices, densityAt, stepMM = 3) {
  const P = positions, I = indices;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]); }
  const nx = Math.max(1, Math.ceil((x1 - x0) / stepMM)), nz = Math.max(1, Math.ceil((z1 - z0) / stepMM));
  const cells = Array.from({ length: nx * nz }, () => []);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ia = Math.floor((Math.min(P[a], P[b], P[c]) - x0) / stepMM - 0.5), ib = Math.floor((Math.max(P[a], P[b], P[c]) - x0) / stepMM - 0.5);
    const ka = Math.floor((Math.min(P[a + 2], P[b + 2], P[c + 2]) - z0) / stepMM - 0.5), kb = Math.floor((Math.max(P[a + 2], P[b + 2], P[c + 2]) - z0) / stepMM - 0.5);
    for (let i = Math.max(0, ia); i <= Math.min(nx - 1, ib + 1); i++) for (let k = Math.max(0, ka); k <= Math.min(nz - 1, kb + 1); k++) cells[i + nx * k].push(t);
  }
  let sw = 0, sv = 0;
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    // a hair off the grid so a column never runs exactly along a mesh edge
    const x = x0 + (i + 0.5) * stepMM + 1e-4, z = z0 + (k + 0.5) * stepMM + 2e-4, ys = [];
    for (const t of cells[i + nx * k]) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const d = (P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (P[b + 2] - P[a + 2]);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((x - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (z - P[a + 2])) / d;
      const w = ((P[b] - P[a]) * (z - P[a + 2]) - (x - P[a]) * (P[b + 2] - P[a + 2])) / d;
      if (u < 0 || w < 0 || u + w > 1) continue;
      ys.push(P[a + 1] + u * (P[b + 1] - P[a + 1]) + w * (P[c + 1] - P[a + 1]));
    }
    if (ys.length < 2 || ys.length % 2) continue;
    ys.sort((p, q) => p - q);
    for (let j = 0; j < ys.length; j += 2) {
      const len = ys[j + 1] - ys[j], n = Math.max(1, Math.round(len / stepMM));
      for (let s = 0; s < n; s++) { const y = ys[j] + (s + 0.5) * len / n; sv += densityAt(x, y, z) * len / n; sw += len / n; }
    }
  }
  return sw > 0 ? sv / sw : null;
}
