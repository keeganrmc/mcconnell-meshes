// Lattice — the field's own grid, and its derivatives.
//
// WHAT THIS IS FOR. Two things the contour-relief deformer needs and the shipped sampler cannot
// give it: the field's PARTIAL DERIVATIVES, and a way to stop the field's grid from lying along
// the world axes. Everything here reproduces `noise.v00000-001.js`'s field exactly at rest — the
// evaluator is the same construction with the same hash and the same fade, not a second one, so
// there is no second field to drift from the first.
//
// ⚠ A LATTICE BASIS IS A LINEAR MAP ON THE SAMPLE POSITION, AND PGON ALREADY HAS THAT CHAIN.
// Run the cubic evaluator at B⁻¹p and you have "noise on lattice B" — which is why a square, a
// diamond and a rhombic basis are the same texture sheared, not three textures. Measured on the
// 2D case: the quincunx construction correlates with the square evaluator on rotated coordinates
// at r = 1.000000, against 0.027 for two seeds of the same field. The quincunx point set
// Z² ∪ (Z²+(½,½)) has orthogonal equal-length basis (½,½),(½,−½); it IS the square lattice at
// 1/√2 spacing turned 45°, and centered-square is not one of the five plane Bravais lattices.
// So `sampleSurfaceField`'s existing rotate → fibre chain already reaches every linear basis:
// Fibre IS cell aspect, rotate IS lattice orientation. A basis enum on top of them would be a
// second copy of two shipped controls.
//
// WHAT A LINEAR MAP CANNOT REACH IS THE NEIGHBORHOOD. That is the one real basis parameter and
// it is the only one here: `cubic` blends eight cell corners with a separable fade, `radial`
// weights four corners of a tetrahedral cell by distance. No shear of the first produces the
// second — the separable fade is what puts a cubic field's features on the axes, and a radial
// kernel has no axes to put them on.

import { hash3 } from './noise.v00000-001.js';

// Smootherstep and its derivative. The fade is `noise.v00000-001.js`'s, character for character,
// because the value this module returns at rest has to be that module's value bit for bit.
const fade  = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const dfade = (t) => 30 * t * t * (t - 1) * (t - 1);

// ---- cubic: the shipped lattice, now with its partials ------------------------------
//
// ⚠ THE VALUE EXPRESSION IS `valueNoise3`'s, IN ITS ORDER. Floating-point addition is not
// associative, so re-associating the lerps to make the derivative fall out more neatly would
// change the last bits of every surface ever saved. The derivative is accumulated ALONGSIDE the
// value rather than by rewriting it. lattice_guard L1 asserts the bit-identity.
export function cubicNoiseD(x, y, z, seed, out) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const ux = x - ix, uy = y - iy, uz = z - iz;
  const fx = fade(ux), fy = fade(uy), fz = fade(uz);
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c000 = c(0,0,0), c100 = c(1,0,0), c010 = c(0,1,0), c110 = c(1,1,0);
  const c001 = c(0,0,1), c101 = c(1,0,1), c011 = c(0,1,1), c111 = c(1,1,1);
  const x00 = lerp(c000, c100, fx), x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx), x11 = lerp(c011, c111, fx);
  const a = lerp(x00, x10, fy), b = lerp(x01, x11, fy);
  const v = lerp(a, b, fz) * 2 - 1;
  if (!out) return v;
  const dx = dfade(ux), dy = dfade(uy), dz = dfade(uz);
  const gx00 = (c100 - c000) * dx, gx10 = (c110 - c010) * dx;
  const gx01 = (c101 - c001) * dx, gx11 = (c111 - c011) * dx;
  const ga = lerp(gx00, gx10, fy), gb = lerp(gx01, gx11, fy);
  const dax = lerp(ga, gb, fz);
  const day = lerp((x10 - x00) * dy, (x11 - x01) * dy, fz);
  const daz = (b - a) * dz;
  out[0] = dax * 2; out[1] = day * 2; out[2] = daz * 2;
  return v;
}

// ---- radial: the one basis a shear cannot reach -------------------------------------
//
// Simplex skew into a tetrahedral cell, four corners, weight by distance rather than by a
// separable blend along the axes. Skew F3 = 1/3, unskew G3 = 1/6 — the standard construction.
//
// ⚠⚠ THE KERNEL RADIUS IS 0.5, AND IT IS NOT A TUNING NUMBER — IT IS WHAT MAKES THE FIELD
// CONTINUOUS. The six tetrahedra of a cell differ in which two corners the path from (0,0,0) to
// (1,1,1) passes through, so crossing a tetrahedron boundary SWAPS a corner. At the x0 = y0 wall
// the swapped pair sit at equal distance, so both would contribute the same kernel weight against
// DIFFERENT hashes — a step in the field, at every internal boundary of every cell. At radius 0.5
// that distance² is exactly 0.5, the weight is exactly 0, and the swap costs nothing.
// This was found by measuring rather than by reading. 0.6 was taken first, because normalized to
// its extreme it wastes less of the range (p99 0.657 against 0.620), and it failed the gradient
// check at 0.707 relative error. At the worst point the analytic gradient reads (-0.10, 0.11,
// -0.18) and a central difference across it reads (111.8, 0.11, -112.1) — the difference is
// straddling a step of 2.2e-3 that does not shrink when the step does.
// ⚠ AND THE OBVIOUS TEST FOR IT IS THE WRONG ONE. "Shrink the step tenfold and a real field's
// jump shrinks with it" reads 23x rather than 1x on the broken kernel, because the discontinuity
// lives on a surface of measure zero: a fixed sample set straddles it in proportion to the step,
// so the smaller step simply stops finding it. The assertion that works is the gradient check
// itself — lattice_guard B2 — and C2 plants this radius against it.
const R2 = 0.5;
// THE GAIN IS SET FROM THE MEASURED EXTREME: 0.009231 over 1.2 million samples across ten seeds,
// 108.3 to reach 1, taken as 106 so a wider sample than mine still fits. Unlike the value form
// this needs no apology — p99 lands at 0.861 against the cubic field's 0.831, so Amount means
// nearly the same thing on both kernels AND the -1..1 contract holds. The value form could not do
// both at once (p99 0.62 with the contract, or 1.34 without it); a ramp through zero fills the
// range that a bump could only peak in.
export const RADIAL_GAIN = 106.0;
// ⚠ AND THE CELL IS SMALLER, SO DENSITY WOULD HAVE MEANT TWO THINGS. Feature size measured the way
// the pattern registry measures it — the distance at which the field stops resembling itself, the
// autocorrelation's half-length — comes out 0.6146 / 0.5297 / 0.5023 for the cubic kernel at 1, 2
// and 4 octaves against 0.2552 / 0.2188 / 0.2081 for this one. The ratio is 2.408, 2.421, 2.414:
// constant across the fractal sum, so it is the cell and not the stack, and it divides out.
// Without this, switching kernel would silently rescale every pattern that used it.
const RADIAL_SCALE = 1 / 2.414;
export function radialNoiseD(x, y, z, seed, out) {
  x *= RADIAL_SCALE; y *= RADIAL_SCALE; z *= RADIAL_SCALE;
  const s = (x + y + z) * (1 / 3);
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * (1 / 6);
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
  // Which of the six tetrahedra of the cell the point fell in — the ordering of x0, y0, z0.
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0)      { i1=1;j1=0;k1=0; i2=1;j2=1;k2=0; }
    else if (x0 >= z0) { i1=1;j1=0;k1=0; i2=1;j2=0;k2=1; }
    else               { i1=0;j1=0;k1=1; i2=1;j2=0;k2=1; }
  } else {
    if (y0 < z0)       { i1=0;j1=0;k1=1; i2=0;j2=1;k2=1; }
    else if (x0 < z0)  { i1=0;j1=1;k1=0; i2=0;j2=1;k2=1; }
    else               { i1=0;j1=1;k1=0; i2=1;j2=1;k2=0; }
  }
  const corners = [
    [x0, y0, z0, i, j, k],
    [x0 - i1 + 1/6, y0 - j1 + 1/6, z0 - k1 + 1/6, i + i1, j + j1, k + k1],
    [x0 - i2 + 2/6, y0 - j2 + 2/6, z0 - k2 + 2/6, i + i2, j + j2, k + k2],
    [x0 - 1 + 3/6, y0 - 1 + 3/6, z0 - 1 + 3/6, i + 1, j + 1, k + 1],
  ];
  let v = 0, gx = 0, gy = 0, gz = 0;
  for (const [dx, dy, dz, hi, hj, hk] of corners) {
    const r = R2 - dx*dx - dy*dy - dz*dz;
    if (r <= 0) continue;
    // ⚠ A HASHED DIRECTION DOTTED WITH THE OFFSET, NOT A HASHED VALUE. Tried the value form first
    // — one scalar per corner, weighted radially — because it reuses the cubic path's hash exactly.
    // It draws POLKA DOTS. With the supports barely meeting (2.96 live corners on average) each
    // corner's scalar owns its own neighborhood and never blends into its neighbor's, so the
    // field is a lattice of isolated bumps rather than a field. Seen on the contact sheet, not in
    // any number the gate was asking for. A direction contributes a ramp THROUGH zero instead, so
    // neighboring corners cancel where they meet and the result reads as noise.
    const a = hash3(hi, hj, hk, seed) * 6.2831853, b = hash3(hi, hj, hk, seed + 8191) * 2 - 1;
    const sxy = Math.sqrt(Math.max(0, 1 - b*b));
    const ex = Math.cos(a) * sxy, ey = Math.sin(a) * sxy, ez = b;   // a unit direction from the hash
    const dot = ex*dx + ey*dy + ez*dz;
    const r3 = r * r * r;
    v += r3 * r * dot;
    if (out) {
      const k = -8 * r3 * dot, r4 = r3 * r;
      gx += k * dx + r4 * ex; gy += k * dy + r4 * ey; gz += k * dz + r4 * ez;
    }
  }
  // The scale is inside the function, so it is inside the chain rule too.
  if (out) {
    const k = RADIAL_GAIN * RADIAL_SCALE;
    out[0] = gx * k; out[1] = gy * k; out[2] = gz * k;
  }
  return v * RADIAL_GAIN;
}

export const LATTICE_KERNELS = { cubic: cubicNoiseD, radial: radialNoiseD };
export const LATTICE_KEYS = Object.keys(LATTICE_KERNELS);

// ---- Grid: how much of the field's own grid lies along the world axes ---------------
//
// A cubic lattice puts its features on X, Y and Z, and on a sculpted form that reads as a
// manufacturing artefact rather than as texture. The cure is to turn each octave, and the
// measured trap is WHICH octaves.
//
// ⚠⚠ ROTATING OCTAVE o BY theta*o DOES NOTHING, WHICH IS THE OBVIOUS CONSTRUCTION AND IS WRONG.
// It leaves octave 0 unrotated, and at roughness 0.5 octave 0 carries more than half the sum at
// the lowest frequency, so it sets the axis whatever the other octaves do. Measured in 2D,
// directional autocorrelation over six seeds: the peak landed on a lattice axis 6/6 at every
// setting of the slider, from one end to the other. theta*(o+1) turns the base octave too and
// gives 0/6, 4/6, 6/6 across the same range.
//
// ⚠ AND THE ANGLE MUST NOT BE A SYMMETRY OF THE LATTICE. Turning a cubic field by 90° about an
// axis, or 120° about (1,1,1), maps the lattice onto itself — indistinguishable from not turning
// it. So "rotate each octave by the lattice's own symmetry angle" is a no-op wearing a control,
// and the useful angle is the one that shares nothing with the lattice.
//
// ⚠⚠ IT IS A TOGGLE, AND THAT IS A MEASUREMENT RATHER THAN A SIMPLIFICATION. Swept as a slider
// over six seeds at two octaves, the cell-wall signature reads 0.1870 at rest, 0.0540 one fiftieth
// of the way over (2.8° of octave rotation), and 0.0350 flat for the whole remaining 98% — against
// a floor of 0.0289. Seventy-one percent of the effect is spent in the first 2% of the travel and
// there is no measurable middle: three degrees is enough to take a cell wall off a world plane,
// and once it is off, it is off. A slider whose whole action happens in one fiftieth of its range
// is the same defect as one that does nothing, so this has two states and says so.
//
// ⚠ AND THE OBVIOUS STATISTIC CANNOT SEE ANY OF IT. Directional autocorrelation — which is the
// instrument that works on 2D gradient noise, where it reads 6/6 on-axis against 0/6 — separates
// these two states by 6 to 22 points with the sign flipping between lags, i.e. not at all. Value
// noise's cubic artefact is not elongation; it is the CELL WALL, the fade's own signature at the
// integer planes, which is what the module's opening note means by "a grid of dents". Bin |grad f|
// by distance to the nearest integer plane and the two states separate 8x. Assert that.
const GOLDEN = 2.399963;                 // radians; irrational against every cubic symmetry angle
const AX = 1 / Math.sqrt(3);             // (1,1,1) normalized — the cube's 3-fold axis

// Rodrigues about (1,1,1)/√3, returned as a flat 9-float row-major matrix.
function octaveRotation(theta) {
  const c = Math.cos(theta), s = Math.sin(theta), t = 1 - c, a = AX;
  const aa = a * a;
  return [
    t*aa + c,      t*aa - s*a,   t*aa + s*a,
    t*aa + s*a,    t*aa + c,     t*aa - s*a,
    t*aa - s*a,    t*aa + s*a,   t*aa + c,
  ];
}

// `grid` 1 = the shipped field, every octave's cell walls on the world planes. Anything below 1 =
// every octave, the base one included, turned by its own incommensurate angle. There is no middle
// (see above), so the value is read as a switch and the angle is fixed.
// ⚠ REST IS 1, NOT 0. At grid 1 no rotation is computed at all and the sum is the shipped one bit
// for bit, so a project saved before this control existed reloads unchanged — the same rule the
// rotate, fibre and warp stages in the sampler follow.
export function latticeRotations(grid, octaves) {
  if (!(grid < 1)) return null;
  const rots = [];
  for (let o = 0; o < octaves; o++) rots.push(octaveRotation(GOLDEN * (o + 1)));
  return rots;
}

// ---- the fractal sum, with derivatives ----------------------------------------------
//
// Reproduces `noise.v00000-001.js:fbm` exactly when grid is 1 and the kernel is cubic — same
// octave loop, same `seed + o * 131`, same `sum / norm`. lattice_guard L1 asserts it on 20,000
// points and is the reason this file may be imported by the sampler without a migration.
const G = [0, 0, 0];
export function fbmD(x, y, z, opts = {}, out = null) {
  const { octaves = 4, roughness = 0.5, lacunarity = 2, seed = 1, grid = 1, kernel = 'cubic' } = opts;
  const noise = LATTICE_KERNELS[kernel] || cubicNoiseD;
  const rots = latticeRotations(grid, octaves);
  let amp = 1, freq = 1, sum = 0, norm = 0, dx = 0, dy = 0, dz = 0;
  for (let o = 0; o < octaves; o++) {
    let sx = x * freq, sy = y * freq, sz = z * freq;
    const R = rots ? rots[o] : null;
    if (R) {
      const a = sx, b = sy, c = sz;
      sx = R[0]*a + R[1]*b + R[2]*c;
      sy = R[3]*a + R[4]*b + R[5]*c;
      sz = R[6]*a + R[7]*b + R[8]*c;
    }
    sum += noise(sx, sy, sz, seed + o * 131, out ? G : null) * amp;
    norm += amp;
    if (out) {
      // Chain rule through the octave's frequency and its rotation. Rotating the SAMPLE POINT by R
      // means the gradient in world space is Rᵀ times the gradient where it was measured; using R
      // instead of Rᵀ tilts every contour by twice the octave angle and is invisible in the value.
      let gx = G[0], gy = G[1], gz = G[2];
      if (R) {
        const a = gx, b = gy, c = gz;
        gx = R[0]*a + R[3]*b + R[6]*c;
        gy = R[1]*a + R[4]*b + R[7]*c;
        gz = R[2]*a + R[5]*b + R[8]*c;
      }
      dx += gx * freq * amp; dy += gy * freq * amp; dz += gz * freq * amp;
    }
    amp *= roughness; freq *= lacunarity;
  }
  if (norm <= 0) { if (out) { out[0] = out[1] = out[2] = 0; } return 0; }
  if (out) { out[0] = dx / norm; out[1] = dy / norm; out[2] = dz / norm; }
  return sum / norm;
}
