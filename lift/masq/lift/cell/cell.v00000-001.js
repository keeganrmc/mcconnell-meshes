// cell v00000-001 — ONE closed cell outline, in which Round, Diamond, Hex and Teardrop are
// COORDINATES rather than cases.
//
// The obvious way to give a pressed lattice its cell shape is a dropdown: Round / Diamond / Hex /
// Teardrop. An enum of four gives four textures. The same work spent on a continuous shape
// function gives a space that can be wandered, seeded, rerolled and saved — which is what Reroll,
// the Curve editor and the grown patterns already are in this app. So this is one radius function
// with a small parameter set, and the named shapes are settings of it rather than branches in it.
//
// WHY IT IS ITS OWN MODULE AND NOT A FEATURE OF THE ONE KIND THAT USES IT TODAY. A cell is the
// unit of a coffered lattice, of a printed spot, of a quilted pillow and of the loop in a braid —
// four patterns that would each grow their own outline code and drift. Pure, no DOM, no imports:
// node runs it directly and `_verify/pattern_cell_guard.mjs` tests the shapes without a browser.
//
// ⚠ THE FIELD IS 0 ON THE LAND AND 1 AT A CELL CENTRE — it is NOT centred on zero like `cloud`
// or `netting`. `piping` already returns 0..1 for the same reason: the land between cells is the
// sheet's own surface and must not move when Amount does. A field mapped to -1..1 would push the
// land one way and the cells the other, which is not what pressing a sheet does. Mixed sign (see
// `mixed` below) is the one thing that takes it negative, and then deliberately.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The same integer hash the pattern library uses, copied rather than imported so this module stays
// dependency-free and node-testable on its own. Small seeds only: hash3 forms `seed * 1274126177`
// in double precision, and a seed near 2^31 pushes the product past 2^53 and rounds away the low
// bits that decorrelate one cell from the next.
function hash2(ix, iy, seed) {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ⚠⚠ THE DEFAULTS DO NOT SIT AT THE ROUND PRESET, AND THE REASON IS A PROPERTY OF THE FORMULA
// RATHER THAN A PREFERENCE. At squareness EXACTLY 2 the radius is (cos^2 + sin^2)^-1/2 = 1 for
// every corner count — the whole line is the unit circle — so a cell parked there has a Corners
// slider that moves and changes nothing, measured at max |field| difference 0.000000 between 2
// corners and 5. That is the lit-but-inert control this app refuses to ship, and it would have been
// the FIRST thing a person touched. 4 and 2.6 is a soft-cornered square — which is what a coffered
// panel and most knurled sheet actually are — and both sliders are live there. Measured on the
// swatch as max |field - field(default)|: Corners 2 -> 0.155748, 4.5 -> 0.080508, 5 -> 0.129759,
// 8 -> 0.109338; Squareness 1 -> 0.469619, 4 -> 0.160369. `round` is still one preset away.
//
// ⚠ THESE VALUES ARE THE ONES THE SLIDERS SHIP AT, and that is load-bearing rather than tidy: a
// project saved before these existed reloads with them absent, and an absent value has to give
// back the surface the panel is showing. Two sets of defaults is a shape that draws one way on the
// form and another on the button.
export const CELL_DEFAULTS = {
  corners: 4,        // rotational symmetry order, 2..8, CONTINUOUS — see cellRadius
  squareness: 2.6,   // superellipse exponent: 1 diamond, 2 round at EVERY count, above 2 squarish
  aspect: 1,         // elongation along +u, the axis Taper also runs on
  taper: 0,          // head-to-tail asymmetry: 0 symmetric, 1 a cusped teardrop
  lobes: 0,          // radial harmonic order — 0 is off. Rounded to an integer, see cellRadius
  lobeAmount: 0,     // its amplitude as a fraction of the radius
  lobePhase: 0,      // where those lobes sit. Only the Blot alpha and the gate set it — see below
  roundness: 0.55,   // the PROFILE, not the outline: 0 a cone, 1 a spherical cap
  radius: 0.44,      // the cell's half-extent in lattice units — what is left over is the land
  offset: 0,         // row-to-row shift: 0 square rows, 0.5 brickwork, between them a rhomb
  jitter: 0,         // per-cell displacement, hashed from the cell INDEX
  vary: 0,           // per-cell size variation, same hash
  mixed: 0,          // share of cells whose sign is flipped — raised among sunk, or the reverse
  seed: 1,
};

// ⚠ EVERY PARAMETER ABOVE HAS A SHIPPED CONSUMER, AND THAT IS A RULE RATHER THAN AN ACCIDENT. Nine
// of them are Coffer's; `aspect`, `lobes`, `lobeAmount` and `lobePhase` have no slider in the
// pattern panel and are set by the Blot alpha, which exists partly to be their consumer. A shape
// parameter nothing reaches is dead code wearing an API, and it rots differently from dead code
// that looks dead: it keeps passing every gate written against the parameters that ARE used.

// ---- the outline ------------------------------------------------------------------------------

// Gielis' superformula with a = b = 1 and one shared exponent, which is the whole of what is
// needed here: |cos(m*theta/4)|^s + |sin(m*theta/4)|^s, to the power -1/s.
//
// The period in theta is 2*pi/m: cos(m*theta/4) has period 8*pi/m, the absolute value halves that,
// and pairing it with the sine halves it again. So an integer m gives exactly m lobes around the
// turn and a fractional one does not.
//
// ⚠ A FRACTIONAL m DOES NOT LEAVE A CRACK, AND THAT IS WORTH SAYING BECAUSE IT IS THE FIRST THING
// A READER WILL ASSUME. The absolute values make this EVEN in theta, and cellShape reads the angle
// through atan2, whose range is one branch — so r(pi) and r(-pi) agree and the outline closes at
// any m. What a fractional m actually gives is m whole lobes and one truncated one, always at the
// same place, and a shape that is NOT between the two orders it sits between: measured over 6
// fractional counts and 4 exponents, 4,232 of 17,280 samples fall outside the pair of integer
// shapes bracketing them, by as much as 0.2198. cellRadius blends the two integer orders instead,
// which is what makes Corners a path between named shapes rather than a lobe being cut short.
//
// The three named coordinates fall out of s at m = 4: s = 1 is (|cos|+|sin|)^-1, which is the
// diamond |x|+|y| = 1 exactly; s = 2 is (cos^2+sin^2)^-1/2 = 1, the unit circle exactly; above 2
// it runs toward a square with soft corners. At m = 2 the same s = 2 is also exactly the circle,
// which is why the Round and Diamond presets sit at different corner counts and neither is special.
function gielis(theta, m, s) {
  const a = m * theta * 0.25;
  const c = Math.abs(Math.cos(a)), d = Math.abs(Math.sin(a));
  return Math.pow(Math.pow(c, s) + Math.pow(d, s), -1 / s);
}

// The cell's radius at an angle, in units where 1 is the nominal half-extent.
export function cellRadius(theta, p = CELL_DEFAULTS) {
  const corners = Math.min(8, Math.max(2, p.corners != null ? p.corners : CELL_DEFAULTS.corners));
  const s = Math.max(0.4, p.squareness != null ? p.squareness : CELL_DEFAULTS.squareness);
  // ⚠ CONTINUOUS CORNERS ARE A BLEND OF TWO INTEGER ORDERS, NOT A FRACTIONAL m — see gielis above
  // for what the fractional form costs, which is not closure. What comes out between them is
  // genuinely between them sample for sample, and has NO rotational symmetry at all: a 4-fold
  // radius has period pi/2 and a 5-fold one 2*pi/5, and the smallest angle returning both to their
  // start is 2*pi. That is the intended result and not a degenerate case — a rolled sheet's dimples
  // are unequal, and a lattice whose cell is exactly n-fold symmetric is the one that reads machined.
  const m0 = Math.floor(corners), f = corners - m0;
  let r = f > 1e-9 ? gielis(theta, m0, s) * (1 - f) + gielis(theta, m0 + 1, s) * f
                   : gielis(theta, m0, s);

  // TAPER — the parameter no cell in this app had, and the one a pressed teardrop needs.
  //
  // Multiplying by (1 - taper*cos theta) is the limacon, and at taper = 1 it is the cardioid: a
  // blunt round head at theta = pi and a CUSP at theta = 0. That is the shape, exactly, rather
  // than an approximation of it — no blend, no special case at the ends.
  //
  // ⚠ NORMALISED BY (1 + taper), WHICH COSTS WIDTH AND IS THE HONEST TRADE. Without it the head
  // reaches (1 + taper) times the radius it would otherwise have and runs into the next cell; with
  // it the taper term's own maximum is 1, so the cell's extent at any taper is no larger than at
  // none, and it gets NARROWER as it tapers. It has to: a teardrop as long as a circle is thinner
  // than that circle. Size therefore keeps meaning "how big at its widest" across the whole travel
  // of Taper, and the alternative is two controls that are one until the shared term is solved out.
  const taper = clamp01(p.taper != null ? p.taper : 0);
  if (taper > 0) r *= (1 - taper * Math.cos(theta)) / (1 + taper);

  // LOBES — a radial harmonic, r * (1 + a*cos(k*theta + phase)). It is the same term a printed
  // spot wants, which is why it lives here rather than in the one pattern that reads it today.
  // ⚠ k IS ROUNDED TO AN INTEGER, AND HERE THE SEAM REALLY DOES OPEN. Unlike the superformula this
  // term carries a PHASE, so it is not even in theta and r(pi) and r(-pi) stop agreeing: measured
  // at phase 0.7, a gap of 0.0000 at k = 5 and 0.3865 at k = 5.5 — a step across the whole outline
  // on the negative-u axis.
  const k = Math.round(p.lobes != null ? p.lobes : 0);
  if (k > 0) {
    // Clamped short of 1 so the radius cannot reach zero and turn the cell inside out.
    const a = Math.max(-0.85, Math.min(0.85, p.lobeAmount != null ? p.lobeAmount : 0));
    r *= 1 + a * Math.cos(k * theta + (p.lobePhase || 0));
  }
  return r;
}

// Where a point sits relative to the outline: 0 at the centre, 1 ON the outline, above 1 outside.
// Aspect is applied to the SAMPLE rather than to the radius, so the stretch is a true affine
// elongation of the whole cell and Taper still runs along the long axis.
export function cellShape(u, v, p = CELL_DEFAULTS) {
  const a = p.aspect > 0 ? p.aspect : 1;
  const su = u / a, sv = v;
  const R = cellRadius(Math.atan2(sv, su), p);
  return R > 1e-9 ? Math.hypot(su, sv) / R : 1e9;
}

// ---- the profile ------------------------------------------------------------------------------

// How the height falls from the cell's centre to its outline. 0 outside, so the LAND is flat and
// exactly the sheet's own surface.
//
// ⚠ THE SAME CONSTRUCTION `rind` USES, AND DELIBERATELY THE SAME CONTROL. Roundness is a shipped
// word in this app and it already means "cones at the low end, full domes at the high end" on
// two kinds; a third meaning under the same label would evict one of the first two. Blended
// rather than switched, so the slider is continuous over its whole travel.
//
// ⚠ THIS IS WHY THE ADDENDUM'S SIXTH OUTLINE PARAMETER IS NOT HERE. A "Roundness" that fillets
// the outline's corners is what Squareness already does — its own note says "above 2 = squarish
// with soft corners" — so shipping both would be one question under two sliders, and the one
// place they differ (the cusp at Taper 1) is a shape worth having rather than a defect to file off.
export function cellProfile(t, p = CELL_DEFAULTS) {
  if (!(t < 1)) return 0;
  const k = clamp01(p.roundness != null ? p.roundness : CELL_DEFAULTS.roundness);
  const cone = 1 - t;
  const cap = Math.sqrt(Math.max(0, 1 - t * t));
  return cone + (cap - cone) * k;
}

// ---- the lattice ------------------------------------------------------------------------------

// ⚠⚠ PER-CELL JITTER IS HASHED FROM THE CELL INDEX (i, j), NEVER FROM THE SAMPLE POSITION. This is
// a small decision that is expensive to reverse. Position-hashed jitter changes when the pattern
// is rotated, so Rotate stops being a rotation and becomes a reroll; it cannot survive an angle
// snap; and it cannot be reproduced from a seed, so a saved project reopens as a different sheet.
// Index-hashed jitter rotates WITH the lattice, survives the snap, and rerolls deterministically.
// pattern_cell_guard C1 holds it, with a position-hashed control that fails the same assertion.
//
// ⚠⚠ THE NEIGHBOUR BLOCK IS NOT AN OPTIMISATION TO REMOVE. A single-cell lookup clips every cell at
// its own cell wall, so jitter, taper and lobes — each of which can carry a cell past its own
// boundary — come out sliced flat along straight lines that belong to the lattice rather than to
// the shape. `pile` records the same finding from the other direction. The block is read by the
// largest magnitude rather than by max, because a mixed field has cells below the land as well as
// above and a max would let a raised neighbour erase a sunk cell.
export function cellFieldAt(u, v, p = CELL_DEFAULTS) {
  const q = p === CELL_DEFAULTS ? p : { ...CELL_DEFAULTS, ...p };
  const seed = q.seed | 0 || 1;
  const R = q.radius > 0 ? q.radius : CELL_DEFAULTS.radius;
  const jit = clamp01(q.jitter), vary = clamp01(q.vary), mixed = clamp01(q.mixed);
  const asp = Math.max(1, q.aspect > 0 ? q.aspect : 1);
  // ⚠ A STRICT UPPER BOUND ON THE OUTLINE, SO THE CULL BELOW CANNOT CLIP A CELL. The superformula's
  // largest value over a turn is 1 at theta = 0 or 2^(1/2 - 1/s) at the corner where |cos| = |sin|
  // — 0.707 at s = 1, 1 at s = 2, 1.189 at s = 4. Taper only ever scales it down; Lobes scales it
  // by at most (1 + |amount|); `vary` scales it UP by (1 + vary/2), which the first cut of this
  // bound forgot — 167 of 60,000 samples came back clipped, and nothing but X1 could have seen it.
  // Past that radius a sample is outside every cell, so skipping it costs a squared distance rather
  // than three Math.pow calls. Measured on Blot's bake, cull off then on: 83 ms -> 22 ms at a 3x3
  // block, 217 ms -> 32 ms at 5x5, and pattern_cell_guard X1 asserts it changes no sample.
  const sMax = Math.max(0.4, q.squareness);
  const rBound = R * asp * (1 + vary * 0.5) * Math.max(1, Math.pow(2, 0.5 - 1 / sMax))
                 * (1 + Math.min(0.85, Math.abs(q.lobeAmount || 0))) + 1e-9;
  const rBound2 = rBound * rBound;
  // HOW FAR TO LOOK, DERIVED FROM THAT SAME BOUND RATHER THAN FIXED. A sample sits at most
  // 0.5 + jitter/2 from its own cell's centre, so a cell `dc` columns away has its centre at least
  // dc - 0.5 - jitter/2 off — and it can be skipped outright once that exceeds the bound. At every
  // radius Coffer can reach this comes out 1, the 3x3 block every lattice kind here uses; it grows
  // only for a consumer that asks for cells larger than their own squares, and without it such a
  // cell comes back sliced along a lattice line.
  const reach = Math.max(1, Math.ceil(rBound + jit * 0.5 - 0.5));
  const rowC = Math.floor(v);
  let best = 0, bestMag = 0;
  for (let dr = -reach; dr <= reach; dr++) {
    const j = rowC + dr;
    // The row shift is what makes the basis rhombic. It is applied to the SAMPLE, so a row's cells
    // stay on integer columns and the index hash below keeps naming the same cell.
    const uo = u - j * q.offset;
    const colC = Math.floor(uo);
    for (let dc = -reach; dc <= reach; dc++) {
      const i = colC + dc;
      const jx = jit ? (hash2(i, j, seed + 31) - 0.5) * jit : 0;
      const jy = jit ? (hash2(i, j, seed + 37) - 0.5) * jit : 0;
      const sz = vary ? R * (1 - vary * 0.5 + vary * hash2(i, j, seed + 13)) : R;
      const du = uo - (i + 0.5 + jx), dv = v - (j + 0.5 + jy);
      if (du * du + dv * dv > rBound2) continue;
      const t = cellShape(du / sz, dv / sz, q);
      if (!(t < 1)) continue;
      let h = cellProfile(t, q);
      // MIXED — a hashed share of cells flipped the other way, which is what alternating raised
      // and sunk cells on rolled metal and moulded rubber actually is. At 0 not one hash is
      // consulted and the field is bit-identical to a build without it.
      if (mixed && hash2(i, j, seed + 71) < mixed) h = -h;
      const mag = h < 0 ? -h : h;
      if (mag > bestMag) { bestMag = mag; best = h; }
    }
  }
  return best;
}

// ---- named coordinates ------------------------------------------------------------------------

// Presets are SAVED PARAMETER SETS shipped as data, not a menu and not a branch anywhere in the
// code above. They are a starting point and a search target; everything between them is reachable,
// including the shapes nobody thought to name. `_verify/pattern_cell_guard.mjs` measures each one
// against the property its name claims, so a preset cannot quietly stop being what it is called.
export const CELL_PRESETS = {
  round:    { corners: 2, squareness: 2,   taper: 0,    aspect: 1 },
  diamond:  { corners: 4, squareness: 1,   taper: 0,    aspect: 1 },
  hex:      { corners: 6, squareness: 1.3, taper: 0,    aspect: 1 },
  teardrop: { corners: 2, squareness: 2,   taper: 0.7,  aspect: 2.2 },
  lozenge:  { corners: 4, squareness: 1.6, taper: 0,    aspect: 1.9 },
  chevron:  { corners: 3, squareness: 1.1, taper: 0.45, aspect: 1.4 },
};
