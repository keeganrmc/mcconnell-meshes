// BLOCKS — the third generator. A last blocked out the way a lastmaker blocks
// one: heel seat, cone, ball, toe box and toe as masses, fused into one
// surface. Unreason3D's fuse (kernel/solidwrap.mjs) does the fusing: a cube-
// sphere cage shrink-wrapped onto the masses' signed distance field, then two
// Catmull-Clark levels. The cage topology is fixed by the density before the
// solve begins — every Blocks last at one density has the same vertices and
// faces, whatever its size or type, which is what a keyed sculpt delta needs.
//
// The masses are parametric, from the size chart: body length, last height,
// ball width, heel width, ball girth, the ball's fraction. A fused last grades
// like the other two, runs in a size run and honors the override rule.
//
// Frame: the interim generator's. X along the last with the heel at -L/2, Y
// up with the sole at soleY, Z across with the ball width centered on 0. Heel
// pitch, toe spring, toe shape and vamp length are the app's post-passes, the
// same ones the other generators get; this file builds the flat block.
//
// Pure: same spec and options in, byte-identical mesh out.
// tools/verify/blocks_geometry.mjs imports this file.
import { wrapSolidsToSuperbCage, smoothMinPoly, fuseBlendRadius } from '../kernel/solidwrap.mjs';
import { subdivideCatmullClark } from '../kernel/subd.mjs';

export const BLOCKS_DENSITY = 16;   // 576 cage quads; 9,218 vertices after two levels
export const BLOCKS_FIT = 95;
export const BLOCKS_FUSE_MM = 8;    // gaps up to this wide bridge; masses overlap, so this only rounds the seams
export const BLOCKS_CC_LEVELS = 2;

/* The block is built in one canonical frame and mapped out. The fuse rounds
   its cage's facet counts from the field's extents, so two sizes give two
   topologies (EU36: 624 quads, EU42: 576) and a sculpt keyed to one has no
   vertex in the other. Built at L0 x H0 x BW0 with every other quantity a
   ratio to those, the field's bounding box is the same at every size and
   fitting, so the cage is; the per-axis map to the chart's L, H and BW is
   exact at those three landmarks. */
export const CANON = { L: 280.3, H: 125.2, BW: 98.5 };

// Signed distance to an ellipsoid, Quilez's bound k0(k0-1)/k1 — exact on the
// surface, within a few percent off it, which a shrink-wrap tolerates.
export function ellipsoidDistance(p, c, r) {
  const qx = (p[0] - c[0]) / r[0], qy = (p[1] - c[1]) / r[1], qz = (p[2] - c[2]) / r[2];
  const k0 = Math.hypot(qx, qy, qz);
  const k1 = Math.hypot(qx / r[0], qy / r[1], qz / r[2]);
  return k1 > 0 ? k0 * (k0 - 1) / k1 : -Math.min(r[0], r[1], r[2]);
}

// Perimeter of an ellipse (semi-axes a across, b up, centered at cy) cut by the
// sole plane: the arc above the plane plus the chord along it. This is what a
// tape reads around a ball section that has a flat bottom.
export function clippedEllipsePerimeter(a, b, cy, soleY, n = 720) {
  let arc = 0; const crossings = [];
  let px = a, py = cy, pin = py >= soleY;
  for (let i = 1; i <= n; i++) {
    const th = 2 * Math.PI * i / n;
    const x = a * Math.cos(th), y = cy + b * Math.sin(th), inside = y >= soleY;
    if (pin && inside) arc += Math.hypot(x - px, y - py);
    else if (pin !== inside) { const f = (soleY - py) / (y - py); const cx = px + (x - px) * f; crossings.push(cx); arc += pin ? Math.hypot(cx - px, soleY - py) : Math.hypot(x - cx, y - soleY); }
    px = x; py = y; pin = inside;
  }
  return arc + (crossings.length === 2 ? Math.abs(crossings[0] - crossings[1]) : 0);
}

// The ball section's semi-height: the b for which the sole-cut ellipse of
// semi-width BW/2, centered 0.7b above the sole, has the chart's girth.
export function solveBallSemiHeight(ballWidth, ballGirth, soleY) {
  let lo = 5, hi = 300;
  for (let i = 0; i < 60; i++) {
    const b = (lo + hi) / 2;
    if (clippedEllipsePerimeter(ballWidth / 2, b, soleY + 0.7 * b, soleY) < ballGirth) lo = b; else hi = b;
  }
  return (lo + hi) / 2;
}

/* The six masses, each {name, c:[x,y,z], r:[rx,ry,rz]} in mm. Fractions are
   of L from the heel; proportions relative to the ball come from the CAD
   reference's stations (waist 0.79, toe box 0.89, toe 0.50 of ball width) and
   the heel seat from the chart's heel width. The sole plane cuts every mass. */
export function blocksMasses(spec) {
  const { L, H, BW, heelW, ballGirth, ballFrac, soleY } = spec;
  const xAt = (t) => -L / 2 + t * L;
  // The ball's semi-height is solved in the REAL frame (the chart's width
  // and girth, the real sole) and carried into this frame by the height ratio;
  // the heel width by the width ratio. Both are exact under the per-axis map.
  const bBall = solveBallSemiHeight(spec.realBW ?? BW, ballGirth, spec.realSoleY ?? soleY) * (spec.realH ? H / spec.realH : 1);
  const heelHalf = (heelW / 2) * (spec.realBW ? BW / spec.realBW : 1);
  const hBall = bBall * 1.7;
  return {
    bBall,
    masses: [
      // the footbed runs the length of the last, so the sole is one surface and every mass above it overlaps it
      { name: 'footbed',   c: [xAt(0.50), soleY + 0.06 * H, 0], r: [0.50 * L, 0.16 * H, 0.33 * BW] },
      { name: 'heel seat', c: [xAt(0.15), soleY + 0.40 * H, 0], r: [0.16 * L, 0.52 * H, heelHalf * 1.12] },
      { name: 'cone',      c: [xAt(0.42), soleY + 0.46 * H, 0], r: [0.22 * L, 0.54 * H, 0.37 * BW] },
      { name: 'ball',      c: [xAt(ballFrac), soleY + 0.7 * bBall, 0], r: [0.15 * L, bBall, BW / 2] },
      { name: 'toe box',   c: [xAt(0.88), soleY + 0.42 * hBall * 0.66, 0], r: [0.12 * L, 0.66 * hBall * 0.58, 0.41 * BW] },
      { name: 'toe',       c: [xAt(0.955), soleY + 0.3 * hBall * 0.5, 0], r: [0.06 * L, 0.5 * hBall * 0.5, 0.24 * BW] },
    ],
  };
}

// The field record the fuse solver reads: distance, gradient, per-member
// distances, a point cloud per member for the principal frame and start box.
export function blocksField(masses, soleY, fuseMm) {
  const k = fuseBlendRadius(fuseMm);
  const distanceAt = (p) => {
    let acc = Infinity;
    for (let i = 0; i < masses.length; i++) { const d = ellipsoidDistance(p, masses[i].c, masses[i].r); acc = i === 0 ? d : smoothMinPoly(acc, d, k); }
    return Math.max(acc, soleY - p[1]);   // the sole plane: intersection with the half-space above it
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const parts = masses.map((m, index) => {
    const N = 48, pos = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * i + 1) / N, rad = Math.sqrt(Math.max(0, 1 - y * y)), th = Math.PI * (1 + Math.sqrt(5)) * i;
      pos[i * 3] = m.c[0] + m.r[0] * Math.cos(th) * rad;
      pos[i * 3 + 1] = Math.max(soleY, m.c[1] + m.r[1] * y);
      pos[i * 3 + 2] = m.c[2] + m.r[2] * Math.sin(th) * rad;
    }
    const b = { lo: [m.c[0] - m.r[0], Math.max(soleY, m.c[1] - m.r[1]), m.c[2] - m.r[2]], hi: [m.c[0] + m.r[0], m.c[1] + m.r[1], m.c[2] + m.r[2]] };
    for (let d = 0; d < 3; d++) { if (b.lo[d] < lo[d]) lo[d] = b.lo[d]; if (b.hi[d] > hi[d]) hi[d] = b.hi[d]; }
    return { index, positions: pos, bounds: b, pn: { closed: true }, parity: false };
  });
  const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const gradientStep = Math.max(diagonal * 5e-4, 1e-9);
  const gradientAt = (p) => { const h = gradientStep; return [
    (distanceAt([p[0] + h, p[1], p[2]]) - distanceAt([p[0] - h, p[1], p[2]])) / (2 * h),
    (distanceAt([p[0], p[1] + h, p[2]]) - distanceAt([p[0], p[1] - h, p[2]])) / (2 * h),
    (distanceAt([p[0], p[1], p[2] + h]) - distanceAt([p[0], p[1], p[2] - h])) / (2 * h)]; };
  return {
    memberCount: parts.length, closedCount: parts.length, openMembers: [], fuse: fuseMm, skin: 0, blendRadius: k,
    bounds: { lo, hi }, diagonal, padding: fuseMm + diagonal * 0.02, gradientStep, parts,
    distanceAt, gradientAt, memberSignedDistances: (p) => masses.map((m) => ellipsoidDistance(p, m.c, m.r)),
    kind: 'ellipsoids',
  };
}

/* Build the flat block. Returns { positions: Float32Array, indices: Uint32Array
   (triangles, (a,b,c)(a,c,d) per quad), quads, masses, cageQuads, wrap }.
   After the wrap and the subdivision the canonical block is mapped per axis
   onto the chart's L, H and BW; the map is measured on this build, so the
   fuse's rounding and the wrap's fit cost nothing at those landmarks. The
   ball girth is left to the masses: the ball mass carries it by construction
   and the wrap sits within a percent. */
export function buildBlocksMesh(spec, opts = {}) {
  const density = opts.density ?? BLOCKS_DENSITY, fit = opts.fit ?? BLOCKS_FIT, fuseMm = opts.fuse ?? BLOCKS_FUSE_MM, levels = opts.levels ?? BLOCKS_CC_LEVELS;
  const { L, H, BW, soleY } = spec;
  const canon = { L: CANON.L, H: CANON.H, BW: CANON.BW, soleY: -CANON.H / 2, heelW: spec.heelW, ballGirth: spec.ballGirth, ballFrac: spec.ballFrac,
                  realBW: BW, realH: H, realSoleY: soleY };
  const { masses, bBall } = blocksMasses(canon);
  const field = blocksField(masses, canon.soleY, fuseMm);
  const wrap = wrapSolidsToSuperbCage([], { field, density, fit, topology: 'sphere' });
  if (!wrap.ok) return { ok: false, reason: wrap.reason, message: wrap.message };
  let V = wrap.cage.vertices, F = wrap.cage.faces;
  for (let i = 0; i < levels; i++) { const r = subdivideCatmullClark({ vertices: V, faces: F, creases: {} }); V = r.vertices; F = r.faces; }

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of V) for (let d = 0; d < 3; d++) { if (v[d] < mn[d]) mn[d] = v[d]; if (v[d] > mx[d]) mx[d] = v[d]; }
  const target = [[-L / 2, L / 2], [soleY, soleY + H], [-BW / 2, BW / 2]];
  const correction = [0, 1, 2].map((d) => (target[d][1] - target[d][0]) / (mx[d] - mn[d]));
  const positions = new Float32Array(V.length * 3);
  for (let i = 0; i < V.length; i++) for (let d = 0; d < 3; d++) positions[i * 3 + d] = target[d][0] + (V[i][d] - mn[d]) * correction[d];
  const indices = new Uint32Array(F.length * 6);
  for (let f = 0; f < F.length; f++) {
    const [a, b, c, d] = F[f];
    indices[f * 6] = a; indices[f * 6 + 1] = b; indices[f * 6 + 2] = c;
    indices[f * 6 + 3] = a; indices[f * 6 + 4] = c; indices[f * 6 + 5] = d;
  }
  return { ok: true, positions, indices, quads: F, masses, bBall: bBall * H / CANON.H, correction, cageQuads: wrap.quadCount, density, fit, fuse: fuseMm, worstFieldMm: wrap.worstFieldError };
}
