// MASQ — procedural modulation of the mask edge.
//
// The mask's edge is the 0.5 contour of coverage. This module does not touch
// coverage. It returns a per-vertex DISPLACEMENT in millimeters, and the
// caller subtracts it from the signed distance to the rim before rebuilding a
// DERIVED coverage field. The painted field is never written, so Smooth,
// Sharpen, Grow, Shrink and the Outline handles all keep acting on the edge
// the student drew, underneath the pattern.
//
// ⚠ THE DISPLACEMENT IS NOT ADDED TO COVERAGE, AND THAT IS THE WHOLE DESIGN.
// A coverage field moved by dC shifts its own contour by dC/|grad C|, and
// |grad C| is a function of brush hardness and stroke overlap — five to ten
// times shallower under a soft brush. "2 mm of wander" would be 2 mm along a
// hard stroke and 10-15 where two soft ones feathered together, and a student
// would experience the amount slider exploding at random. Displacing the
// signed DISTANCE is what makes an amplitude mean millimeters.
//
// UNITS. `rest` positions are METERS. Every amount, scale and wavelength here
// is MILLIMETERS. The two meet at MM and nowhere else.
const MM = 0.001;

// ---------------------------------------------------------------- the hash --
/* Integer, and deliberately not `fract(sin(dot(p,k)) * 43758.5453)`. That
 * idiom is everywhere in shader code and evaluates differently on different
 * GPUs and in different JS engines, so a student's mask would not reproduce on
 * the lab machine — which is the same class of defect as losing the file.
 * This is a 32-bit integer mix (Wang/Jenkins lineage) done in Math.imul, so
 * every step stays in int32 and the result is bit-identical everywhere. */
function hash3i(ix, iy, iz, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (iy | 0), 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h ^ (iz | 0), 0x9e3779b1);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;      // [0,1)
}

/* Quintic, so the interpolant is C2 and the noise has no visible lattice
 * creases where a cubic's second derivative jumps. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/* VALUE noise, not gradient noise, and the reason is a rendering artifact.
 * Classic Perlin is exactly zero at every lattice point, so at low octave
 * counts the crests are pushed off the lattice and an axis-aligned grid shows
 * up in the pattern that reads as a bug rather than as texture. Value noise
 * has no such constraint. Its own weakness is blockiness, which the quintic
 * fade and two octaves of the fBm both answer. Returns -1..1. */
export function valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c = (dx, dy, dz) => hash3i(xi + dx, yi + dy, zi + dz, seed) * 2 - 1;
  const x00 = c(0,0,0) + u * (c(1,0,0) - c(0,0,0));
  const x10 = c(0,1,0) + u * (c(1,1,0) - c(0,1,0));
  const x01 = c(0,0,1) + u * (c(1,0,1) - c(0,0,1));
  const x11 = c(0,1,1) + u * (c(1,1,1) - c(0,1,1));
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/* Fractal sum. `gain` sets the spectral slope: for lacunarity 2 a gain of
 * 2^(-beta/2) synthesises a 1/f^beta spectrum, which is how the deckle asks
 * for its beta = 2.3 below. */
export function fbm3(x, y, z, seed, octaves, lacunarity, gain) {
  let sum = 0, amp = 1, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * f, y * f, z * f, (seed + o * 0x9e3779b1) | 0);
    f *= lacunarity;
    amp *= gain;
  }
  return sum;
}

/* ⚠ THE RMS IS WHAT MAKES AN AMOUNT A MILLIMETER, AND IT IS NOT 1/sqrt(3).
 * Interpolated value noise does not keep the RMS of the uniform variate it is
 * built from — the quintic fade attenuates it — so one octave measures 0.3870
 * rather than 0.5774, and a naive `A * fbm` would run a mask's edge at 2.3
 * times the number on the slider.
 *
 * Above one octave the sum scales analytically, because the octaves are
 * independent (different seeds at different frequencies): variance adds, so
 *
 *     RMS(n, gain) = RMS1 * sqrt( (1 - gain^2n) / (1 - gain^2) )
 *
 * Measured against the closed form at 200,000 samples the two agree to 0.001
 * — 0.2% of amplitude — across every octave count and both shipped gains. One
 * constant instead of a table, and it holds for whatever octave count the
 * resolution floor leaves standing. The unit test re-measures it and fails if
 * the hash or the fade moves, which is the only thing standing between a
 * student's saved mask and a silent change of amplitude. */
export const RMS1 = 0.386973;
export function rmsOfSum(octaves, gain) {
  if (octaves <= 1 || gain === 0) return RMS1;
  return RMS1 * Math.sqrt((1 - Math.pow(gain, 2 * octaves)) / (1 - gain * gain));
}

/* Re-measure a parameter set's RMS. Deterministic: a fixed count of samples on
 * an irrational stride, so no sample lands on a lattice point and the answer
 * does not depend on where the walk started. Exported for the test. */
export function measureRMS(octaves, lacunarity, gain, seed = 1, n = 20000) {
  let s = 0;
  const g = 0.7548776662466927;   // 1/plastic number: a 3D low-discrepancy stride
  for (let i = 1; i <= n; i++) {
    const x = (i * g * 7.3) % 97.13, y = (i * g * g * 11.7) % 89.41, z = (i * g * g * g * 5.1) % 101.7;
    const v = fbm3(x, y, z, seed, octaves, lacunarity, gain);
    s += v * v;
  }
  return Math.sqrt(s / n);
}

// ------------------------------------------------------------ the registry --
/* ONE table. The panel's select, the controls each kind shows, the defaults,
 * the save's globals and the evaluator all read it, because five hand-written
 * copies of one set is how they go stale in four places.
 *
 * `uses` names the controls a kind actually reads; anything not listed is
 * hidden rather than shown doing nothing.
 * `band` is the wavelength in millimeters the kind's coarsest octave sits at,
 * and `finest` the shortest wavelength it puts on the rim — which is what the
 * resolution floor is checked against, not the number on the slider. */
export const PATTERNS = {
  none: {
    label: 'None', uses: [],
    lambda0: () => Infinity, octaves: 0, lacunarity: 2, gain: 0,
  },
  wave: {
    /* Lobes around the silhouette. The control is a COUNT, not a wavelength,
     * because only a whole number of periods closes around a loop — a
     * wavelength slider leaves a phase seam wherever the loop starts, which
     * looks like a defect and cannot be diagnosed from the panel. The
     * wavelength is shown beside the count as a readout.
     * One octave by construction: it is a sine. */
    label: 'Wave', uses: ['amount', 'count'],
    lambda0: (p, perimMM) => (p.count > 0 ? perimMM / Math.round(p.count) : Infinity),
    octaves: 1, lacunarity: 2, gain: 0,
  },
  noise: {
    /* The workhorse. A 3D field in the head's rest space: organic,
     * non-repeating, correct on every loop including the eye holes, needing no
     * arc length and no seam treatment, and unchanged by identity, expression
     * or resolution. */
    label: 'Noise', uses: ['amount', 'scale'],
    lambda0: (p) => p.scaleMM,
    octaves: 3, lacunarity: 2, gain: 0.5,
  },
  deckle: {
    /* A torn edge, and it is NOT just noise with a different slope.
     *
     * In hand papermaking the deckle frame cannot seal against the mould, so
     * pulp seeps under its edge: the sheet THINS OUT toward its boundary over
     * a few millimeters and the outline wanders gently. Machine-cut
     * "artificial deckle" has the wander and not the thinning, and that is
     * exactly why it looks wrong. So the wander is only half of this, and the
     * other half is `couple` — the lobes that protrude furthest get the
     * longest skive, so they are also the thinnest and most translucent.
     *
     * Its spectrum is fixed rather than exposed: beta = 2.3 is gain 0.45 at
     * lacunarity 2, off a 40 mm fundamental, which is the band a silhouette is
     * actually read at across a room. Finer than that is paper FIBRE at
     * 0.2-0.8 mm, and no stage of this pipeline reaches it — the panel note
     * says so rather than implying the software delivers it. */
    label: 'Deckle', uses: ['amount', 'couple'],
    lambda0: () => 40,
    octaves: 4, lacunarity: 2, gain: 0.45,
  },
};

export const PATTERN_KINDS = Object.keys(PATTERNS);

/* The widest excursion the amount control offers. It is here rather than in
 * the markup because the app sets the slider's max FROM it and also sizes the
 * redistancing band by it — two readers, so one constant. */
export const AMOUNT_MAX_MM = 4;

export const PATTERN_DEFAULTS = {
  edgeKind: 'none',
  edgeAmountMM: 1.2,
  edgeScaleMM: 16,
  edgeCount: 13,
  edgeCouple: 0.65,
  edgeSeed: 1,
};

// ------------------------------------------------------------- the ceiling --
/* THE WAVELENGTH IS WHAT THE MESH LIMITS, NOT THE AMPLITUDE — and the app used
 * to say the opposite.
 *
 * Marching triangles places each contour vertex by linear interpolation ALONG
 * a mesh edge, at a continuously valued parameter, so the contour's POSITION
 * is not quantised at all: a 0.2 mm displacement is representable exactly on a
 * 1.7 mm mesh. What is quantised is the contour's SHAPE. You draw it with
 * about lambda/h control points per period, and a sine drawn with four points
 * is a diamond.
 *
 * Six samples per period is the working floor. Below about four the amplitude
 * sags to 0.6-0.8 of what was asked; below two the pattern beats against the
 * mesh's own edge-length variation and produces a slow spurious wander the
 * student did not ask for and cannot find the control for — which is the worst
 * of the failures, because it does not look broken, it looks like a different
 * pattern. A 6 mm deckle on a 3 mm mesh does not read as torn, it reads as
 * badly cut. */
export const SAMPLES_PER_PERIOD = 6;
export function lambdaFloorMM(medianEdgeMM) { return SAMPLES_PER_PERIOD * medianEdgeMM; }

/* WHAT THE MESH LEAVES STANDING — refuse the fundamental, DROP the octaves,
 * and count what was dropped.
 *
 * Two different things are unaskable and they get two different answers. A
 * fundamental below the floor is refused outright, because there is nothing
 * left of the pattern to draw and the app does not render what it cannot
 * export. An OCTAVE below the floor is simply dropped: the pattern is still
 * the pattern, one detail level shallower. What must never happen is dropping
 * one silently, because then a student drags a slider, nothing moves, and the
 * only available conclusion is that the feature is broken. So `resolved`
 * against `requested` goes on screen — "4 asked for, 3 resolved".
 *
 * ⚠ AND THE RMS FOLLOWS THE RESOLVED COUNT, NOT THE REQUESTED ONE. Divide by
 * the RMS of a sum that did not happen and the amount is wrong by however many
 * octaves the mesh refused — which is exactly the regime where a student is
 * already suspicious of the number. */
export function patternCeiling(kind, params, medianEdgeMM, perimMM) {
  const P = PATTERNS[kind];
  if (!P) throw new Error('unknown pattern kind: ' + kind);
  const floor = lambdaFloorMM(medianEdgeMM);
  const lambda0 = P.lambda0(params, perimMM);
  const requested = P.octaves;
  let resolved = 0;
  for (let o = 0; o < requested; o++) {
    if (lambda0 / Math.pow(P.lacunarity, o) >= floor) resolved++;
    else break;
  }
  const finest = resolved > 0 ? lambda0 / Math.pow(P.lacunarity, resolved - 1) : lambda0;
  return {
    floor, lambda0, finest, requested, resolved,
    dropped: requested - resolved,
    ok: lambda0 >= floor || !isFinite(lambda0),
  };
}

// ------------------------------------------------------------- the evaluator --
/* The displacement, in millimeters, one per vertex.
 *
 * ⚠ EVERY KIND IS A FUNCTION OF REST-SPACE POSITION AND NOTHING ELSE — never
 * of a vertex index, a triangle index, or a posed position. From that one rule
 * the pattern is welded to the anatomy like a tattoo: identity and expression
 * move the skin and the grain goes with it, the Standard-to-Fine flip only
 * samples the same function better, and the level set evaluates the identical
 * field. Break it and every one of those becomes a scrambling bug at once.
 *
 * @param {object} p        {kind, amountMM, scaleMM, count, seed, ...}
 * @param {Float32Array} rest  rest-space positions, 3 per vertex, METERS
 * @param {number} vCount
 * @param {object} [frame]  {cx, cy} the covered region's centroid in the
 *   frontal plane, meters — Wave's only input beyond rest position. Re-derived
 *   by the caller at evaluation time and never stored.
 * @param {Float32Array} [out]
 * @returns {Float32Array} millimeters, one per vertex
 */
export function patternField(p, rest, vCount, frame, out) {
  const D = out && out.length === vCount ? out : new Float32Array(vCount);
  const kind = p.kind || 'none';
  const P = PATTERNS[kind];
  if (!P) throw new Error('unknown pattern kind: ' + kind);
  const A = p.amountMM || 0;
  if (kind === 'none' || !A) { D.fill(0); return D; }

  if (kind === 'wave') {
    /* n lobes around the silhouette, as the mask is READ — from the front. The
     * head's rest space puts x across the face, y up it and z out of it (the
     * midline is x = 0 and the nape is z < 0, which measure.js relies on), so
     * the frontal plane is x,y and the angle about the region's own centroid
     * sweeps once around the rim.
     * ⚠ IT IS EVEN IN ANGLE, NOT IN ARC LENGTH. On a full face those are close.
     * On a wide flat mask — a domino — the top and bottom runs cross a lot of
     * rim in little angle, so the lobes crowd there. Evening it out wants an
     * arc-length coordinate carried off the rim, which is a second solve and a
     * second thing to voxelise at export; it is not built. The count is still
     * exact and the loop still closes, which is what the control promises. */
    const cx = frame ? frame.cx : 0, cy = frame ? frame.cy : 0;
    const n = Math.max(1, Math.round(p.count || 1));
    /* The seed turns into a phase rather than a lattice offset, so Reroll
     * spins the lobes around the mask instead of changing their number. */
    const ph = hash3i(p.seed | 0, 0, 0, 0x5eed) * Math.PI * 2;
    for (let v = 0; v < vCount; v++) {
      D[v] = A * Math.sin(n * Math.atan2(rest[v * 3 + 1] - cy, rest[v * 3] - cx) + ph);
    }
    return D;
  }

  // noise and deckle: one fractal sum, differing in their spectrum and in
  // whether they drive the skive. The octave count is whatever the mesh left
  // standing, and the RMS the amount is divided by is that count's, not the
  // requested one.
  const lamMM = P.lambda0(p, p.perimMM || 0);
  const oct = Math.max(1, p.octaves || P.octaves);
  const k = 1 / (lamMM * MM);                     // rest meters -> lattice cells
  const norm = A / rmsOfSum(oct, P.gain);
  const seed = p.seed | 0;
  for (let v = 0; v < vCount; v++) {
    D[v] = norm * fbm3(rest[v * 3] * k, rest[v * 3 + 1] * k, rest[v * 3 + 2] * k,
                       seed, oct, P.lacunarity, P.gain);
  }
  return D;
}

/* THE SKIVE, COUPLED TO THE EXCURSION. This is the deckle's actual signature
 * and it is two lines of arithmetic.
 *
 *     L(v) = L0 * (1 + c * Dhat(v))        Dhat = D normalised to -1..1
 *
 * so a lobe that protrudes furthest also tapers over the longest run and comes
 * out the thinnest and most translucent, and a notch is crisp. Wander alone is
 * a wobbly cut; wander plus feathering is a torn sheet.
 *
 * ⚠ D IS SAMPLED AT THE VERTEX, NOT AT THE NEAREST RIM POINT. Those differ by
 * however far the vertex is from the rim, which inside the skive band is at
 * most L0 * (1 + c) — 5 mm at the default — against a pattern whose shortest
 * period is 10 mm. So the error is under half a period and the taper stays
 * monotone along the rim. It would not be at a finer band; the floor is what
 * holds it.
 *
 * The clamp keeps the width positive: at c = 1 an excursion of -1 would ask
 * for a zero-width skive, which is a square cut wearing a leather label. */
export function skiveWidths(D, vCount, L0, couple, amountMM, out) {
  const W = out && out.length === vCount ? out : new Float32Array(vCount);
  if (!(couple > 0) || !(amountMM > 0)) { W.fill(L0); return W; }
  const inv = 1 / amountMM;
  for (let v = 0; v < vCount; v++) {
    let d = D[v] * inv;
    d = d < -1 ? -1 : d > 1 ? 1 : d;
    const w = L0 * (1 + couple * d);
    W[v] = w < 0.2 ? 0.2 : w;
  }
  return W;
}

/* FIDELITY — the honest low-poly meter, and the number that turns an argument
 * into a measurement.
 *
 *     1 - median|realised - commanded| / RMS(commanded)
 *
 * Below about 0.8 the mesh is not carrying the pattern that was asked for,
 * whatever the panel says. It goes on screen beside the amount rather than
 * only into the gate, because a student dragging Scale down needs to watch it
 * fall.
 *
 * @param realised  signed millimeters the rim actually moved, sampled along it
 * @param commanded the displacement asked for at those same samples
 */
export function fidelity(realised, commanded) {
  const n = Math.min(realised.length, commanded.length);
  if (n < 8) return null;
  const err = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    err[i] = Math.abs(realised[i] - commanded[i]);
    ss += commanded[i] * commanded[i];
  }
  const rms = Math.sqrt(ss / n);
  if (!(rms > 1e-9)) return null;
  const s = Array.from(err).sort((a, b) => a - b);
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return 1 - med / rms;
}
