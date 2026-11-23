// Surface noise — a 3D field, sampled at the surface, pushed along the normal.
//
// WHY A FIELD AND NOT A STAMP. Pgon already has alphas: 2D bitmaps a brush stamps where you
// touch. That is the wrong instrument for "make this whole thing look like cast metal", for the
// same reason a brush is the wrong instrument for "taper it" — you would be reproducing by hand
// something that should be a property of the surface. A field is evaluated at each vertex's own
// position in space, so it is continuous across the form, seamless around it, and identical
// wherever two parts of the form happen to meet.
//
// AND IT IS THE SAME IDEA THE APP ALREADY USES. Remesh and the booleans run on a signed distance
// field (fieldcore). This is a different field for a different purpose, but a student who has
// seen one has seen the shape of the other.
//
// WHAT IT IS BUILT FROM. Value noise on an integer lattice with a smootherstep fade and a hashed
// gradient, summed over octaves — the standard construction. Deterministic from a seed, so the
// same settings give the same surface every time: a noise you cannot return to is a noise you
// cannot design with.

// ⚠ A DELIBERATE IMPORT CYCLE, AND IT IS SAFE BOTH WAYS ROUND. lattice.js imports `hash3` from
// here so there is exactly one hash in the app; this file imports `fbmD` from there so the basis
// reaches every fractal kind at once. Neither module touches the other at MODULE-EVALUATION time —
// both references live inside function bodies, and both are hoisted function declarations — so
// whichever is entered first, the other is fully evaluated before anything is called.
// lattice_guard A4 imports them in each order and asserts it.
import { fbmD } from './lattice.v00000-001.js';
// The shared cell primitive. `coffer` is its first consumer in this file and deliberately not its
// only one — an alpha bakes the same outline as a stamp — which is why the shape lives in its own
// module rather than inside the kind below. See cell/cell.v00000-001.js.
import { cellFieldAt, CELL_DEFAULTS } from '../cell/cell.v00000-001.js';

// A cheap, well-distributed integer hash. Deterministic across machines, unlike anything built
// on Math.random, which would make the same slider produce a different surface on every device.
export function hash3(ix, iy, iz, seed) {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Smootherstep: zero first AND second derivative at the ends. Plain lerp leaves visible lattice
// creases at every cell boundary — on a sculpted surface those read as a grid of dents, which is
// exactly the artefact that makes procedural noise look procedural.
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a, b, t) => a + (b - a) * t;
  const x00 = lerp(c(0,0,0), c(1,0,0), fx), x10 = lerp(c(0,1,0), c(1,1,0), fx);
  const x01 = lerp(c(0,0,1), c(1,0,1), fx), x11 = lerp(c(0,1,1), c(1,1,1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz) * 2 - 1;   // -1..1
}

// Fractal sum. `roughness` is the amplitude each octave keeps of the one before it: 0.5 is the
// usual "pink" falloff, lower is smoother, higher is grittier.
//
// THE LATTICE ENTERS HERE, WHICH IS WHY EVERY FRACTAL KIND GETS IT AT ONCE. Cloud, Ridged and
// Pitted are this function remapped; bark, skin, timber, gills and the domain WARP all call it for
// their own sub-fields. Putting the basis on the fractal sum rather than on each kind means one
// edit reaches all of them and none of them can disagree about what a lattice is.
//
// ⚠ REST IS THE ORIGINAL LOOP, NOT A DELEGATION WITH IDENTITY ARGUMENTS. Guarding on the rest
// value rather than routing everything through the general path is the same rule Warp, Fibre and
// the curve follow: a project saved before the lattice existed reloads bit-identically BY
// CONSTRUCTION, not by a measurement that could drift. lattice_guard A2 asserts the two agree.
export function fbm(x, y, z, opts = {}) {
  const { octaves = 4, roughness = 0.5, lacunarity = 2, seed = 1, grid = 1, kernel = 'cubic' } = opts;
  if (grid < 1 || kernel !== 'cubic') return fbmD(x, y, z, opts);
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x * freq, y * freq, z * freq, seed + o * 131) * amp;
    norm += amp;
    amp *= roughness; freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

// ---- the second generator: cellular ------------------------------------------------
//
// WHY A SECOND GENERATOR AT ALL, when three kinds came free from the first. Every kind above is
// a SHAPER: a function of one sampled number. That is why they were cheap, and it is also their
// ceiling — a function of one number cannot know where it is, so it can only ever redistribute
// fractal noise, which is uncorrelated by construction. Biology is not uncorrelated. Cells pack,
// membranes divide, plaques tile. That is ORGANISATION, and no amount of reshaping a fractal
// field produces it. It needs a generator that knows about neighbors.
//
// Worley/cellular noise is that generator, and it is the cheapest one that is: scatter one
// feature point per lattice cell, then ask each position about its nearest two. F1 alone gives
// packed domes; F2 minus F1 is small exactly where two cells meet, which draws the MEMBRANE
// between them; and a per-cell hash gives each cell its own height, which is a tiled plateau.
// Three genuinely different structures out of one 27-cell walk.
//
// THE APPROXIMATION, MEASURED RATHER THAN ASSUMED. Searching only the 3x3x3 cells around the
// query can in principle miss a nearer feature point two cells away, because the jitter is a
// full cell wide. Checked against a 5x5x5 search over 400,000 samples: ZERO disagreements. So
// the cheap walk is used, and the reason it is safe is a number rather than a convention.
export function worley3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let f1 = Infinity, f2 = Infinity, id = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        // Three decorrelated hashes of the same cell, so the feature point can sit anywhere in
        // it. One hash reused for all three axes would put every point on the cube's diagonal.
        const px = cx + hash3(cx, cy, cz, seed);
        const py = cy + hash3(cx, cy, cz, seed + 8191);
        const pz = cz + hash3(cx, cy, cz, seed + 16381);
        const d = Math.hypot(px - x, py - y, pz - z);
        if (d < f1) { f2 = f1; f1 = d; id = hash3(cx, cy, cz, seed + 32749); }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return { f1, f2, id };
}

const clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
// ⚠ EXACTLY 1 AT REST, AND GUARDED SO IT IS NOT EVEN A MULTIPLY. The three Worley kinds each carry
// a hardwired wall width — 0.90 for Cells, 0.15 for Web, 0.10 for the Plaques edge ramp — and this
// scales all three from one control. Returning a literal 1 when the option is absent keeps a
// project saved before this existed bit-identical on reload, which is the same rule Warp, Fibre
// and the curve LUT already follow in this file.
const wallW = (o) => (o && o.width != null && o.width !== 1 ? o.width : 1);
const smoothstep = (t) => t * t * (3 - 2 * t);

// ---- the quaternion Julia constants, CHOSEN BY MEASUREMENT ---------------------------------
//
// Reroll picks from this list rather than walking a path through parameter space, because most of
// parameter space is dust: a c value just outside the connected locus gives a scatter of specks
// with no structure, and a Reroll that can land on a dud is a Reroll a student stops pressing.
// Every entry here was measured on a spherical shell for two things.
//
// ⚠ TWO CLASSIC CONSTANTS WERE CUT FOR SEAM STEPS, and they are the two most famous ones. An
// orbit trap is not continuous everywhere — at points where the closest approach switches from one
// leg of the orbit to another it jumps — and the mirror-tiling seams are where that shows. Walking
// a line across six cells, 20,000 samples: Douady's rabbit stepped 0.107 and the dendrite set
// stepped 0.400, against a field whose whole range is about 2. A 20% jump in a displacement field
// is a visible crack, so both are out however well known they are. The four kept all step under
// 0.004 on the same walk, and all hold an interquartile range above 0.83 at every grain tested.
const JULIA_C = [
  [-0.391, -0.587, 0, 0],       // Siegel disc — smooth lobes, the calmest of the four
  [-0.2, 0.6, 0.2, 0],          // a genuinely 4D constant: structure that no 2D slice shows
  [-0.75, 0, 0, 0],             // San Marco — long chains of buds
  [-0.45, -0.3, -0.3, -0.3],    // all four components, the densest filigree here
];
// ⚠ EACH CONSTANT IS CENTERED ON ITS OWN TRAP DISTRIBUTION, not on a shared threshold. Flattening
// the far field (see the kind) needs a cut-off, and one number for all four does not transfer: the
// four sets approach their own filaments at different distances, so the same cut-off raised 35% of
// the surface on the 4D constant and barely a fifth of it on San Marco. Reroll would then hand a
// student a dud on two of its eight seeds — which is exactly what noise_guard J4 caught. These are
// each constant's own p25, measured over 58,800 samples, so every seed gets about the same share of
// its surface raised. It is the rule Settle and Density already follow: standardize against the
// thing's own spread rather than against a constant.
const JULIA_CENTRE = [0.659, 0.392, 0.889, 0.728];
const JULIA_ITER = 14;   // where the trap stops resolving finer against what it costs per sample
const JULIA_BAIL = 8;    // an orbit past this is gone; carrying it further only risks overflow
const JULIA_PERIOD = 2;  // the fractal's own useful extent, so one tile is one whole set

// The three normalizing widths below are MEASURED, not chosen for looking round. Over 300,000
// samples the raw quantities land at: F1 median 0.524, p99 0.894, max 1.157; F2-F1 median 0.158,
// p99 0.658. There is no closed form for either distribution — it is a random point process — so
// an empirical constant is the honest answer here, and each is picked for how much of the surface
// the raised part covers, which is the thing you actually see.

// ⚠ EVERY KIND IS A FIELD, NOT A SHAPER: it takes a POSITION and returns -1..1. The three
// ⚠⚠ WITH TWO EXCEPTIONS, AND BOTH ARE EXACT RATHER THAN INCIDENTAL. `pitted` is
// sign(n)*n²*PITTED_GAIN over an fbm that returns -1..1, so its bound is exactly ±PITTED_GAIN —
// ±1.75 at the shipped gain, reached on 0.019% of samples. The `waffle` binding is
// (ridge*0.9 - well*0.35)*2 - 1 with both terms in 0..1 and mutually exclusive at their extremes,
// so its bound is exactly [-1.7, +0.8] —
// so a waffle's troughs run more than twice as deep as its peaks stand proud. The consequence lands
// in two different places depending on one control: `curved` CLAMPS its input to the band, so with
// a curve set the out-of-band values saturate and the extremes flatten together; with no curve the
// identity passes them straight through to the displacement, and the pattern moves further than the
// contract says. Neither is normalized here ON PURPOSE — rescaling them would change every surface
// already made with them, which is a worse trade than an honest contract. noise_guard's range
// assertions carry the measured bounds so a THIRD kind leaving the band is caught.
// (Also measured and worth knowing before Amount is read as symmetric: the weave's field mean is
// +0.585 across every binding, against cloud's -0.0001, so Amount inflates the form as it patterns it.)
// original kinds keep their exact arithmetic — they simply call fbm themselves now instead of
// being handed its result — so their output is bit-identical to before. The signature is what
// lets a kind be something other than a rearrangement of fractal noise.
// ---- what the photographed kinds needed that nothing here already had --------------------------

// A Worley walk that hands back the OFFSET to the feature point, not only the distance to it.
//
// ⚠ IT EXISTS FOR ONE REASON: A FACET HAS TO BE MEASURED FROM THE STONE'S OWN CENTER. Bounding a
// cell by a few flat planes is what makes crushed rock look crushed, and a plane is `dot(offset,
// normal)`. With only a distance in hand the offset has to be faked from the sample position, so
// the planes tile SPACE rather than bounding a STONE, and every stone comes out cut by the same
// cracks — which is exactly how the first attempt at angular aggregate rendered: scratches.
//
// It also returns the cell coordinate rather than a hashed id, because the facet directions are
// hashed from it three different ways and a single float id would correlate them.
export function worleyOff3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let f1 = Infinity, ox = 0, oy = 0, oz = 0, cell = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const px = cx + hash3(cx, cy, cz, seed);
        const py = cy + hash3(cx, cy, cz, seed + 17);
        const pz = cz + hash3(cx, cy, cz, seed + 41);
        const ex = x - px, ey = y - py, ez = z - pz;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < f1) { f1 = d; ox = ex; oy = ey; oz = ez; cell = cx * 73856093 ^ cy * 19349663 ^ cz * 83492791; }
      }
    }
  }
  return { f1, ox, oy, oz, cell };
}

// Coarse, medium, fine — and the amplitudes are what make it read as GRADED rather than as three
// patterns on top of each other. Taking the max means the coarse stones win where they are and the
// finer grades only appear in the gaps between them, which is what a graded aggregate is.
const AGGREGATE_GRADES = [[1.0, 1.0], [1.9, 0.62], [3.6, 0.38]];

// Bark's own proportions. The stretch is how far the plates run along the trunk relative to across
// it; the floor is what keeps the fine cracks a second SCALE rather than a second fissure.
const BARK_STRETCH = 1 / 2.4, BARK_FINE_FLOOR = 0.55;
// How much coarser skin's creases are than its fine net. Far enough apart that the two never read
// as one pattern at two sizes.
const SKIN_COARSE = 0.22;
// How far the fine net wanders off a regular lattice, and how stippled the skin between the
// creases is. Both exist because the first version read as a reptile rather than a palm.
const SKIN_JITTER = 0.16, SKIN_GRAIN = 0.16;

// TIMBER's own proportions, and the two frequencies are a PAIR rather than two settings.
// The shard walk is the one that breaks the fibre into blocky files (F over an aspect E); the
// check walk is much coarser and far longer (F2 over E2), which is what draws the deep splits
// that run the whole way with the grain. Set them at one aspect and the splits sit inside the
// shards instead of cutting across them, and there is only one scale again.
const TIMBER_F = 2.4, TIMBER_E = 3.2, TIMBER_F2 = 0.6, TIMBER_E2 = 20.0;
const TIMBER_SHARD = 0.45, TIMBER_CHECK = 0.09, TIMBER_FIB = 0.16, TIMBER_EDGE = 0.085;
// The knot lattice. One candidate per coarse cell, a hashed minority kept.
// ⚠ THE RADIUS COMES FROM THE PHOTOGRAPH AND THE SPACING FROM A SHELL, and the second was measured
// because the first estimate was made on a PLANE and a plane flatters it. A knot is a sphere; a
// plane cut through the lattice meets one whenever it passes anywhere near a center, and a closed
// form does not. Sampled on a spherical shell at the panel's own default Size, the first spacing
// tried (cell 5.5) put 3 sockets on a whole form and its deflection over 3.4% of the surface —
// which means most forms would show no knot at all, and a button named for a thing it usually does
// not do mis-sells itself the way bark's own note describes. Swept on the same shell: cell 4.2
// gives 5 sockets / 7.7% deflected, cell 3.3 gives 6 sockets / 13.0%, cell 2.6 gives 23 sockets /
// 29.1%, which is a plank made of knots. 3.3 is the one where the knot is reliably THERE and still
// rare enough to be an event.
const TIMBER_KF = 0.30, TIMBER_KEEP = 0.45, TIMBER_KR = 1.35, TIMBER_SWIRL = 0.8;

// GILLS: how wide a blade is as a fraction of the spacing, how far the blades wander, what share
// of them are SHORT, and how much of its own length a short one runs.
const GILL_B = 0.60, GILL_WOB = 0.42, GILL_SHORT = 0.45, GILL_RUN = 0.34, GILL_NICK = 0.16;
// ⚠ AND GILLS RUNS THREE TIMES FINER THAN THE FAMILY DEFAULT, WHICH IS A SWATCH DECISION AS MUCH
// AS A BIOLOGICAL ONE. A cap carries thirty-odd blades, not ten; and the pattern swatch is drawn
// over a fixed three world units for every kind, so at the shared spacing the button showed THREE
// stripes — which is a corrugation, not a gilled cap, and the swatch is what a student picks from.
// The same multiplier does both jobs, which is why it is baked rather than left to the Size slider.
const GILL_FREQ = 3.0;

// TRIPLANAR — how a flat pattern gets onto a curved form without being told where the seams are.
//
// ⚠ THREE OF THESE KINDS ARE DIRECTIONAL AND EVERY EARLIER KIND IS NOT, which is why this is
// needed now and was not before. A weave, a tread and a corrugation all have a WARP DIRECTION;
// evaluated as a plain function of position they would be correct on the faces of a form that
// happen to face the right way and smeared into stripes everywhere else — the classic "wrapped in
// cling film" look. Reading the pattern in the plane most square-on to the surface and blending
// between the three readings is the standard answer, and it is the only one that needs nothing
// from the mesh but the normal it already has.
//
// ⚠ THE BLEND EXPONENT IS THE WHOLE QUALITY OF IT. A linear blend has two readings of a periodic
// pattern at different phases fighting across half the form, and two interfering weaves average
// out to porridge. Raising the weights to the fourth power keeps one plane dominant everywhere
// except in a narrow band around the 45-degree lines, so the seam is a short transition rather
// than a wide smear. It is still a seam; a flat pattern on a closed surface cannot not have one.
//
// ⚠ AND IT FALLS BACK TO FACING +Z RATHER THAN TO ZERO. The swatch renderer runs the real
// generators on a small lattice that carries no normals, and weights of zero would return a field
// of zero — a blank square on a button for a pattern that works perfectly.
function triplanar(fn, x, y, z, nx, ny, nz, o) {
  let ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (!(ax + ay + az > 1e-6)) { ax = 0; ay = 0; az = 1; }
  ax *= ax * ax * ax; ay *= ay * ay * ay; az *= az * az * az;
  const s = ax + ay + az;
  return (ax * fn(y, z, o) + ay * fn(z, x, o) + az * fn(x, y, o)) / s;
}

// How many orientations compete in `attention`, and the incommensurate ratios `superposition` lays
// over one another. Both are module constants rather than options because they are what the KIND
// is — a different count is a different claim about the mechanism, not a setting.
const ATTENTION_HEADS = 7;
// ⚠ THE GAIN IS SET SO THIS KIND USES THE SAME RANGE AS ITS NEIGHBORS. Averaging several ridged
// waves under softmax weights necessarily flattens — two or three heads sharing the weight is the
// point of the kind, and the price is amplitude. Left ungained it spanned 0.93 from p05 to p95
// where every other kind here spans about 1.5, which does not read as a subtler pattern: it reads
// as the Amount slider meaning something different on this button than on the one beside it.
const ATTENTION_GAIN = 1.55, ATTENTION_BIAS = 0.35;
// ⚠ TWO CLOSE PAIRS, NOT FOUR SPREAD RATIOS, and the difference is whether the idea is visible at
// all. The first set ran 1, 1.618, 2.414, 3.303 — genuinely incommensurate, and measured, its
// loudest neighborhood varied only 1.27x more than its quietest. Frequencies that far apart
// interfere at a wavelength as short as the features themselves, so the reinforcing and canceling
// happens inside every square millimeter and averages out to a uniform texture. A beat is LONG only
// when two frequencies are CLOSE. Pairing them keeps the field genuinely non-repeating while
// putting the interference on a scale a person can see.
// Each entry is a PAIR of nearby frequencies sharing one direction — see the note in the kind.
const SUPERPOSE_PAIRS = [[1.0, 1.11], [1.83, 2.02]];
const SUPERPOSE_SPLAY = 0.13;   // radians of splay within a pair, so the nodes are not dead straight

// ---- the flat kernels the directional kinds are read through ---------------------------------

// ⚠ THE DRAFT IS DATA. A weaver's drawdown IS a grid of over-and-under, so writing each binding as
// an expression means every new one is code: the three that shipped were three hardcoded formulas,
// and satin and basket were absent because adding them meant adding more. As a table they are rows.
// The two that are NOT plain drawdowns stay as rules below — herringbone reverses its direction per
// band, which is a rule about bands rather than a repeat, and waffle is not an over-under at all.
export const WEAVE_DRAFTS = {
  plain:  [[1, 0],
           [0, 1]],
  // 2/2 twill. Identical at cell centers to the expression it replaces, `((i-j) mod 4) < 2`.
  twill:  [[1, 0, 0, 1],
           [1, 1, 0, 0],
           [0, 1, 1, 0],
           [0, 0, 1, 1]],
  // Plain weave with the threads paired, which is what a basket weave is.
  basket: [[1, 1, 0, 0],
           [1, 1, 0, 0],
           [0, 0, 1, 1],
           [0, 0, 1, 1]],
  // 5-harness satin, move 2: one warp up per pick and never two adjacent, which is what gives satin
  // its unbroken float and its sheen.
  satin:  [[1, 0, 0, 0, 0],
           [0, 0, 1, 0, 0],
           [0, 0, 0, 0, 1],
           [0, 1, 0, 0, 0],
           [0, 0, 0, 1, 0]],
};

// Is the WARP over the weft in this cell? One place, so the smoothing below applies to every
// binding alike instead of being written per formula.
export function weaveOverAt(kind, i, j) {
  if (kind === 'herring') {
    // ⚠ THE BAND REVERSAL IS KEYED TO THE WARP INDEX. Keying it to the weft is the easy mistake and
    // gives a zigzag running the wrong way across the cloth.
    const band = Math.floor(i / 4);
    const d = (band % 2 === 0) ? (i - j) : (i + j);
    return ((((d % 4) + 4) % 4) < 2) ? 1 : 0;
  }
  const D = WEAVE_DRAFTS[kind] || WEAVE_DRAFTS.plain;
  const n = D.length;
  return D[((i % n) + n) % n][((j % n) + n) % n] ? 1 : 0;
}

function weave2(u, v, o) {
  const kind = o.weaveKind || 'plain';
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const prof = (f) => { const t = 2 * f - 1; const s = 1 - t * t; return s > 0 ? Math.sqrt(s) : 0; };
  const warp = prof(fu);
  const weft = prof(fv);
  if (kind === 'waffle') {
    const ridge = Math.max(warp, weft);
    const well = (1 - warp) * (1 - weft);
    return (ridge * 0.9 - well * 0.35) * 2 - 1;
  }
  // ⚠⚠ THE YARN CROSSES OVER, IT DOES NOT TELEPORT. `over` is constant within a cell and flips at
  // the boundary, so the height flipped with it: measured, a jump of 1.12 between samples 2e-4
  // apart, on a field whose whole range is 2.0 — fifty-six per cent of the range in one step, at
  // every crossing. That is a crease no amount of subdivision resolves, because the field itself is
  // discontinuous there.
  // A real warp thread rises and dips ALONG ITS OWN LENGTH. So each thread's lift is interpolated
  // between the CELL CENTERS it passes through — centers, not boundaries, so the middle of a cell
  // still reads exactly what the draft says and only the crossing is blended.
  const LO = 0.42;                       // how far the under-thread sits below the over-thread
  const jm = Math.floor(v - 0.5), tv = (v - 0.5) - jm;
  const wa = weaveOverAt(kind, i, jm), wb = weaveOverAt(kind, i, jm + 1);
  const warpLift = wa + (wb - wa) * smoothstep(tv);
  const im = Math.floor(u - 0.5), tu = (u - 0.5) - im;
  const fa = 1 - weaveOverAt(kind, im, j), fb = 1 - weaveOverAt(kind, im + 1, j);
  const weftLift = fa + (fb - fa) * smoothstep(tu);
  const zWarp = warp * (LO + (1 - LO) * warpLift);
  const zWeft = weft * (LO + (1 - LO) * weftLift);
  return Math.max(zWarp, zWeft) * 2 - 1;
}

// PILE — staggered rows of tufts that RAKE, from the pile-cloth plate.
//
// ⚠ THE RAKE IS THE ONLY REASON THIS IS A KIND. `tread` already has staggered rows and a positional
// lean, so rows alone earn nothing. What no other kind in this file has is an ASYMMETRIC FEATURE
// PROFILE: a tuft that lies over is STEEP on the side you push against and SHALLOW on the side it
// leans toward, which is what gives a velvet its direction and its two-tone sheen.
//
// ⚠⚠ SKEWING THE TUFT'S CENTER DOES NOT RAKE IT. The first version offset the sample by
// `rake * (cv + 0.5)` before a radial falloff — which moves the whole bump and leaves it perfectly
// symmetric about its NEW middle. Measured as mean profile skew across the whole rake sweep:
// 0.010, -0.004, -0.010, 0.000, 0.003 — a control that moves and changes nothing, which is the one
// defect this panel refuses to ship. What leans a tuft is the FALLOFF differing by side: a short
// steep half-width against the nap and a long shallow one with it. Corrected, the same sweep reads
// 0.010, 0.350, 0.587, 0.796, 0.887, against 0.000 for ribs, cells and gills.
function pile2(u, v, o) {
  const rake = o.rake != null ? o.rake : 0.55;
  const seed = o.seed || 1;
  const LEAN = 0.34;                               // rows run at a slight diagonal, as woven pile does
  const uu = u + v * LEAN;
  const wSteep = 1 - 0.42 * rake, wShallow = 1 + 0.75 * rake;

  // ⚠⚠ TUFTS MUST BE ABLE TO OVERLAP, AND UNDER A SINGLE-CELL LOOKUP THEY CANNOT. The first
  // version resolved one cell per sample, so every tuft was clipped at its own cell wall: the
  // field came out a regular lattice of identical lozenges separated by hard black gaps, and no
  // amount of layering on top of it read as cloth. Pile cloth is PACKED — the plate has no gaps
  // between tufts at all, and the tufts differ visibly in size. Both of those need neighbors, so
  // this takes the MAX over the 3x3 block of cells the way a Worley cell does. A tuft may then be
  // larger than its own cell and spill into its neighbors, which is what closes the gaps and what
  // makes a size variation possible without tearing holes at the seams.
  let h = 0;
  const rowC = Math.floor(v);
  for (let dr = -1; dr <= 1; dr++) {
    const row = rowC + dr;
    const uo = uu + hash3(row, 5, 2, seed) * 0.5;  // rows stagger irregularly, not by a clean half
    const colC = Math.floor(uo);
    for (let dc = -1; dc <= 1; dc++) {
      const col = colC + dc;
      // the tuft's own center, jittered off the lattice so the rows do not read as a comb
      const jx = (hash3(col, row, 31, seed) - 0.5) * 0.30;
      const jy = (hash3(col, row, 37, seed) - 0.5) * 0.22;
      const cu = uo - (col + 0.5 + jx);
      const cv = v - (row + 0.5 + jy);
      // RAKE — the falloff differs by SIDE, which is what leans a tuft. Skewing its center instead
      // moves the whole bump and leaves it symmetric about the new middle: measured as mean profile
      // skew that read 0.010 across the entire rake sweep, a control that changed nothing.
      const su = cu / (cu < 0 ? wSteep : wShallow);
      // each tuft its own size — the plate's tufts are visibly unequal, and at 1.0 they overlap
      const sz = 0.82 + 0.36 * hash3(col, row, 13, seed);
      // ⚠ THESE TWO CONSTANTS SET HOW PACKED THE CLOTH IS, AND THEY WERE SWEPT AGAINST COVERAGE
      // rather than picked. Percentage of the field left in deep shadow, which is what reads as a
      // hole rather than as a valley between tufts:
      //     cv*1.35, 1.55/sz -> 22.9%     cv*1.15 -> 13.0%     cv*1.00 -> 6.7%
      //     cv*1.00, 1.40/sz ->  1.7%     cv*0.90, 1.30/sz -> 0.1%
      // The plate has NO black voids but still shows every tuft, so the target is a few percent,
      // not zero: at 0% the tufts merge into one swell and the cloth stops reading as tufted at
      // all. 1.00 with 1.55 sits at 6.7% — covered, and every tuft still separately visible.
      const r = Math.hypot(su * 1.15, cv * 1.00) * (1.55 / sz);
      if (r >= 1) continue;
      let t = Math.sqrt(1 - r * r);
      t *= 0.80 + 0.20 * hash3(col, row, 19, seed);  // and its own height
      if (t > h) h = t;
    }
  }

  // WALES — bands of rows standing prouder than their neighbors, the way a corduroy's ribs run
  // along the cloth rather than across it. The period is deliberately NOT a whole number of rows:
  // on an integer the wale locks to the tuft lattice and prints a repeat instead of cloth.
  const WALE_ROWS = 4.7;
  const wale = 0.5 + 0.5 * Math.cos(((v + hash3(0, 0, 17, seed) * WALE_ROWS) / WALE_ROWS) * Math.PI * 2);
  h *= 0.78 + 0.22 * wale;

  return clamp01(h) * 2 - 1;
}

function tread2(u, v, o) {
  const seed = o.seed || 1;
  const uu = u + v * 0.38;                       // the lean
  const row = Math.floor(v);
  const uo = uu + hash3(row, 7, 3, seed) * 0.9;  // rows staggered, so lugs are not in columns
  const col = Math.floor(uo);
  const fu = uo - col, fv = v - row;
  const GROOVE = 0.16;
  const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
  let h = smoothstep(clamp01(edge / GROOVE));
  h *= 0.82 + 0.18 * hash3(col, row, 11, seed);  // each lug molded at its own height
  const zig = Math.abs(((fv * 5) % 1) - 0.5) * 2;
  const sl = Math.abs(((fu * 4 + zig * 0.35) % 1) - 0.5) * 2;
  const sipe = 1 - smoothstep(clamp01((sl - 0.03) / 0.07));
  h -= sipe * 0.30 * smoothstep(clamp01(edge / (GROOVE * 1.6)));
  return clamp01(h) * 2 - 1;
}

// COFFER — a lattice of pressed cells on flat land, from the rolled-and-dimpled stainless plate.
//
// ⚠ THE CELL'S SHAPE IS NOT WRITTEN HERE. It comes from cell/cell.v00000-001.js, whose argument is
// that Round, Diamond, Hex and Teardrop are coordinates in one continuous shape function rather
// than four cases — so this kind is a LATTICE and a sampling rule, and the outline it stamps is
// shared with anything else that needs a cell. What that buys, concretely: Corners, Squareness and
// Taper are three sliders here and the same three parameters on the alpha that bakes the outline
// to a stamp, out of one implementation.
//
// ⚠ IT RETURNS 0..1 AND NOT -1..1, WHICH IS `piping`'S CONVENTION AND FOR `piping`'S REASON. The
// land between the cells is the sheet's own surface: it has to stay exactly where it is while
// Amount moves the cells. Centring the field on zero would push the land one way and the cells the
// other, which is not what pressing a sheet does. So the SIGN OF Amount is the whole of the
// emboss/deboss choice — right raises the cells, left presses them in — and no enum is needed for
// it. Voids is the third state: it flips a hashed share of cells, so raised and sunk share one
// sheet, which is what rolled metal and moulded rubber actually look like.
//
// ⚠ THE LEAN COMES FROM Rotate, NOT FROM A CONTROL OF ITS OWN. Everything in the plate leans one
// way — the rows, the cells and the brush — because they are one direction, and a second angle
// beside the app's own Rotate would be a way to make them disagree.
//
// ⚠ WHAT IT COSTS, AGAINST THE KINDS IT SITS BESIDE. 40,000 samples on a plane, same machine, same
// run: weave 6ms, tread 9ms, cloud 15ms, cells 38ms, pile 46ms, COFFER 63ms, netting 80ms, rind
// 112ms — and 113ms at the top of Width, where the cells have outgrown their squares and the
// neighbour block widens. Inside the family at both ends, which is what "live at this tier" means
// here; the distance cull in cellFieldAt is most of why.
//
// ⚠ TWO CONSTANTS RATHER THAN TWO MORE SLIDERS, AND THE PAIR WAS SWEPT AGAINST OVERLAP RATHER
// THAN PICKED. The land coverage barely moves with either — 39.4% at nothing, 38.8% at the shipped
// pair, 38.2% at three times it — so land is the wrong instrument. What actually breaks is cells
// running INTO each other: two dimples merged into one blob reads as a casting fault, not as
// rolling. Share of a 10-unit tile claimed by more than one cell, seed 7:
//   0.00 / 0.00 -> 0.000%   0.10 / 0.18 -> 0.000%   0.14 / 0.22 -> 0.023%
//   0.18 / 0.28 -> 0.129%   0.22 / 0.34 -> 0.319%   0.30 / 0.50 -> 1.099%
// 0.10 / 0.18 is the largest pair that still touches nothing. Neither is a control because neither
// is a question a person asks: a rolled sheet is irregular by a small fixed amount or it is not
// rolled.
// The saturating width curve. RMAX is where the radius is heading as Width runs off the top of its
// range, and RK is set so the rest value 1 lands on the cell module's own default radius of 0.44 —
// 1 - exp(-RK) = 0.44 / RMAX — rather than on a number chosen here.
const COFFER_RMAX = 1.05;
const COFFER_RK = -Math.log(1 - CELL_DEFAULTS.radius / COFFER_RMAX);
const COFFER_JITTER = 0.10;
const COFFER_VARY = 0.18;
function coffer2(u, v, o) {
  return cellFieldAt(u, v, {
    seed: o.seed || 1,
    corners: o.corners != null ? o.corners : CELL_DEFAULTS.corners,
    squareness: o.squareness != null ? o.squareness : CELL_DEFAULTS.squareness,
    taper: o.taper != null ? o.taper : CELL_DEFAULTS.taper,
    aspect: o.aspect != null ? o.aspect : CELL_DEFAULTS.aspect,
    lobes: o.lobes != null ? o.lobes : CELL_DEFAULTS.lobes,
    lobeAmount: o.lobeAmount != null ? o.lobeAmount : CELL_DEFAULTS.lobeAmount,
    lobePhase: o.lobePhase != null ? o.lobePhase : CELL_DEFAULTS.lobePhase,
    roundness: o.roundness != null ? o.roundness : CELL_DEFAULTS.roundness,
    offset: o.offset != null ? o.offset : CELL_DEFAULTS.offset,
    // Width is the pattern library's own wall control doing the same job here as on every other
    // kind that reads it: how much of the lattice cell the feature fills, and therefore how much
    // land is left between.
    //
    // ⚠ SATURATING, NOT CLAMPED, AND THE CLAMP IS WHAT THE FIRST CUT SHIPPED. `min(0.49, 0.44 * w)`
    // pins the radius from w = 1.114 upward, so three quarters of the slider's travel changed
    // nothing: pattern_swatch_width_guard B2 caught it as four distinct pictures across a
    // seven-stop sweep. This reaches COFFER_RMAX asymptotically instead, so every stop differs and
    // no stop is dead. Measured radii across the slider: 0.4 -> 0.205, 1 -> 0.440, 2 -> 0.696,
    // 3 -> 0.844, 4 -> 0.930.
    //
    // ⚠ AND PAST HALF A UNIT THE CELLS MEET, WHICH IS THE HONEST TOP OF THIS CONTROL RATHER THAN A
    // FAULT. The land closes and the sheet becomes packed cells — which is exactly what Width does
    // to Cells, Web and Plaques, and the reason it is one word across all of them. cellFieldAt
    // widens its neighbour block to match, so a cell that has outgrown its own square is still
    // drawn whole.
    radius: COFFER_RMAX * (1 - Math.exp(-COFFER_RK * wallW(o))),
    // A pressed lattice is not a perfect one. Both are hashed from the cell INDEX, which is the
    // requirement the module's own note records: hashed from the sample position instead they
    // would change under Rotate and could not be reproduced from a seed.
    jitter: COFFER_JITTER,
    vary: COFFER_VARY,
    mixed: o.voids != null ? o.voids : 0,
  });
}

function ribs2(u, v, o) {
  const NP = 1.6;                                  // furrow spacing along the rib
  const rib = 0.5 + 0.5 * Math.cos(u * Math.PI * 2);
  const notch = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 / NP);
  const h = rib * (0.45 + 0.55 * notch);
  const cu = ((u % 1) + 1) % 1;
  const dCrest = Math.min(cu, 1 - cu) * 2;         // 0 ON the crest
  const cv = ((v / NP % 1) + 1) % 1;
  const dFurrow = Math.min(cv, 1 - cv) * 2;        // 0 IN the furrow
  const pit = 1 - smoothstep(clamp01(Math.hypot(dCrest, 1 - dFurrow) / 0.42));
  return clamp01(h - pit * 0.5) * 2 - 1;
}

// ⚠ ONE COPY, AND IT IS EXPORTED BECAUSE A GATE HOLDS THE OTHER HALF OF IT. noise_guard's B0
// asserts the three original kinds are bit-identical through the signature refactor and keeps its
// own independently written arithmetic to compare against — which is the right shape, and is also
// exactly the shape that goes stale the moment the kind deliberately changes. Importing this from
// there means B0 goes on testing the REFACTOR (its actual claim) and cannot be silently broken by,
// or silently hide, a change to the gain.
export const PITTED_GAIN = 1.75;

// THE TWO KINDS THAT RETURN 0..1 INSTEAD OF -1..1, NAMED IN ONE PLACE.
//
// The module contract is that a kind returns -1..1 with 0 in the middle of its range. `piping` and
// `coffer` deliberately do not: both draw a feature standing ON a ground that must not move when
// Amount does — a cord laid on a surface, a dimple pressed into a sheet — so their zero is the
// GROUND rather than the middle. That is right for the surface and for the mask, and it is a trap
// for anything that maps a field back into a 0..1 image, because the standard `v * 0.5 + 0.5`
// sends their ground to mid-gray instead of to black. It cost the Blot alpha exactly that on its
// first bake: floor share 0.0%, minimum 0.500, a stamp with no black in it at all, which deposits
// everywhere and is not a stamp.
//
// Declared here rather than as a list inside each consumer, so there is one answer to the
// question. pattern_cell_guard R1 re-derives the set by measuring every kind's minimum and goes
// red if the measurement and this set ever disagree.
export const UNSIGNED_KINDS = new Set(['piping', 'coffer']);

// PIPING — the field's own contour lines, raised as rounded beads.
//
// WHY IT IS NOT ANOTHER LUMP. Cloud, Ridged and Pitted are each a function of ONE sampled number,
// which is why they were nearly free and also where they stop: a function of one number cannot
// know where it is. This one reads the field's SLOPE as well as its value, and that is the whole
// difference. Draw the elevation contours of a smooth field and make each line a bead, and you
// get ridges of near-constant width that run parallel to their neighbors, close into rings
// around every local high point, and fuse where they crowd. None of that can be reached by
// remapping a fractal field, because the spacing between contours is a property of the gradient.
//
// ⚠ THE GRADIENT IS THE WHOLE TRICK AND IT IS WHAT MAKES WIDTH HONEST. Contour lines crowd where
// the field is steep and spread where it is flat, so beading them naively gives fat cords on the
// flats and thin ones on the slopes — which is not what a piped seam looks like. Dividing the
// distance-in-contours by the rate of change converts it into an actual distance.
// MEASURED, by walking the field from a crest to the cord's edge rather than by algebra, binned by
// how steep the field is there: the cord's width varies 2.42x across the whole gradient range,
// against 6.20x for the same construction with the division taken out. Where the correction holds
// — above about 1.1x the median gradient — it is not merely better but exact, 1.010 and 0.942 of
// the predicted width.
// ⚠ AND IT IS NOT CONSTANT EVERYWHERE, WHICH IS A LIMIT OF THE CONSTRUCTION AND NOT A BUG TO FIX.
// The normalization is first-order, so where the field's curvature dominates its slope the cord
// fattens: 1.35x at 0.9 of the median gradient, and 2.28x in the flattest tail, where the floor
// below is also widening it on purpose. The claim asserted is the one that is true — that the
// width varies far less than contouring without the gradient does — rather than a claim of
// constancy that would need the tails excluded to pass. piping_guard B1 carries the spread and B5
// the exact band.
//
// ⚠ THE PHASE. `Math.round`, not `Math.floor`: |g - round(g)| is 0 ON the contour and 0.5 midway
// between two. Using floor puts it the other way up and lands every bead half a pitch off its own
// line — which barely changes the picture, since the midlines of a smooth field are another
// family of parallel closed curves, and is still a lie about what the number means.
//
// ⚠ AND THE FLOOR UNDER THE GRADIENT IS RARE AND TOTAL, WHICH IS WHY IT IS A CONSTANT AND NOT A
// CONTROL. Contour spacing is 1/|grad f|, so as the field flattens toward a local maximum the
// spacing runs away and the bead that should ring that peak disappears instead. Measured over the
// volume, flooring the gradient changes the field by a mean of 0.00125 and by as much as 0.9997
// at a single point: invisible on average, and the whole difference between a closed ring and a
// hole where one should be. A slider reading 0.001 would look dead, so there isn't one.
// ⚠ AND THE SIZE OF THE DEFECT IS A PROPERTY OF THE FIELD BEING 3D. Measured, |grad| falls below
// a quarter of its median on 2.46% of samples in three dimensions against 6.85% in a plane, and
// below a twentieth on 0.064% against 0.684% — eleven times rarer. A version of this written
// against a 2D field would size the floor far too generously.
//
// MEAN 0.37 AT REST, STATED RATHER THAN DISCOVERED: this is a raised bead on an unmoved ground,
// so Amount lifts the whole form by about 0.37 of full displacement before it does anything
// patterned, the same way `weave` does. Subtracting the mean was tried and rejected — it makes
// the rest state a function of Width, so widening the bead would sink the ground under it, which
// is a worse coupling than the offset.
//
// The constants, solved rather than chosen — and the first attempt solved the wrong thing.
// PIPE_PITCH is the field-value distance between contours. Setting it so the ring SPACING matched
// the field's own feature size gave 0.62, which is only 2.7 contour levels across the whole range
// the field spans: at that setting the level at zero dominates, and the result correlates with
// `ridged` at 0.486 — because `ridged` IS that one contour, widened. The quantity to solve for is
// rings PER FEATURE, not ring spacing. Measured correlation against `ridged`: 0.486 at 0.62, then
// 0.094 / 0.060 / 0.043 at 0.30 / 0.20 / 0.14. At 0.30 there are about five and a half levels
// across the range, the nesting reads as a contour map, and it is no longer a second Ridged.
const PIPE_PITCH = 0.30;
// Median |grad f| of the fractal field, measured over 200,000 samples AT THE SETTING THE APP
// ACTUALLY RUNS. It is what turns a distance-in-contours into a real distance, and what the floor
// below is a fraction of.
// ⚠ THE FIRST VALUE HERE WAS MEASURED AT THREE OCTAVES AND THE APP HARDCODES FOUR. `octaves` is not
// a control — `noiseOpts()` passes 4 — so a constant solved at 3 had every length in this kind 8%
// out from the day it shipped. Measure at the operating point, not at the one the probe happened
// to use.
// ⚠ AND `Rough` MOVES IT BY MORE THAN THE OCTAVES DO: median |grad| runs 0.9840 / 1.0456 / 1.2580 /
// 1.6045 / 2.0345 across the slider's 0.2 to 0.8. The cord's WIDTH is held constant by the
// normalization, so what changes is how much of the gap it fills — rings crowd as the field
// roughens and the cords close up, from a duty of 0.35 at the low end to 0.73 at the high one.
// That is the pattern behaving, not drifting: roughen the field and the piping crowds together.
const PIPE_MEDIAN_GRAD = 1.2580;
const PIPE_GRAD_FLOOR = 0.55 * PIPE_MEDIAN_GRAD / PIPE_PITCH;
// ⚠ WIDTH IS A FRACTION OF THE RING SPACING, AND THE BEAD IS STILL A REAL DISTANCE. Those are not
// in tension: the half-width below is a constant length that does not depend on the local gradient,
// which is the whole point of the normalization — it is merely EXPRESSED relative to pitch, so that
// changing pitch keeps the cord's share of the gap the same instead of silently thinning it.
// 0.45 is the cord; the Width slider's 0.4x to 4x reaches a drawn line at one end and, past about
// 2.2x, a duty over 1 where neighboring cords overlap into a continuous fused plateau.
const PIPE_DUTY = 0.45;
const PIPE_HALF = PIPE_DUTY * PIPE_PITCH / PIPE_MEDIAN_GRAD * 0.5;
const PIPE_G = [0, 0, 0];

export const NOISE_KINDS = {
  // Straight fractal noise: lumps at every scale. Cast metal, stone, skin at a distance.
  cloud:  (x, y, z, o) => fbm(x, y, z, o),
  // Absolute value folds the field at zero, which turns smooth lumps into CREASES — the standard
  // way to get ridges and erosion out of the same generator, without a second one.
  ridged: (x, y, z, o) => 1 - 2 * Math.abs(fbm(x, y, z, o)),
  // Squaring pushes the distribution toward zero, leaving isolated raised spots: pores, cast
  // pitting, orange peel. Sign preserved so it can go either way.
  // ⚠ AND SQUARING ALSO SQUARES THE RANGE, WHICH IS WHY THIS CARRIES A GAIN. `pitted` is a plain
  // shaper of fbm, so on a surface its p01..p99 is cloud's SQUARED — measured on a 24,531-vertex
  // unit sphere at pitted's own family grain of 4.5, cloud's p99 is 0.4945 and pitted's is 0.2445,
  // which is 0.4945^2 to four figures. That is not a defect in the swatch, it is the kind: a
  // pattern that reads flat on a button reads flat on a form. 1.75 is the gain that puts it back
  // at cloud's range, and it is a DELIBERATE CHOICE rather than a repair — every project already
  // carrying Pitted gets a deeper surface, by this factor exactly.
  // ⚠ WHAT 1.75 ACTUALLY DELIVERS, MEASURED, BECAUSE THE TWO CLAIMS MADE FOR IT ARE NOT BOTH EXACT.
  //   - "puts it at cloud's range": near, not on. At grain 4.5 over four seeds pitted's p99 lands
  //     at 86.5% / 82.7% / 89.2% / 69.0% of cloud's; the gain that would land it exactly at seed 1
  //     is 2.022. On the SWATCH, which is where the flatness shows, it lands at or just past
  //     cloud: measured on the RENDERED button through __pgonSwatchInk at three seeds, pitted's
  //     gray spread goes 71 / 84 / 70 levels before and 123 / 148 / 122 after, against cloud's
  //     114 / 126 / 114 — from 61-67% of cloud's contrast to 107-117% of it. No pixel reaches the
  //     swatch's ink floor or ceiling on either side, so none of that is bought by clamping.
  //   - "with no clipping": true at the setting that matters and not universally. At grain 4.5,
  //     three of four seeds put ZERO samples outside +/-1 and the fourth puts 0.0122%. At grain 10
  //     it reaches 0.078%, max |v| 1.219. The swatch clamps to its ink floor and ceiling, the
  //     surface does not clamp at all, so the visible cost of that is a handful of texels.
  // 2.022 was NOT substituted for the chosen number; the measurement is recorded here so
  // the next person changing it is arguing with a figure rather than with a memory.
  pitted: (x, y, z, o) => { const n = fbm(x, y, z, o); return Math.sign(n) * n * n * PITTED_GAIN; },
  piping: (x, y, z, o) => {
    const f = fbmD(x, y, z, o, PIPE_G);
    const g = f / PIPE_PITCH;
    const m = Math.abs(g - Math.round(g));                       // 0 ON the contour, 0.5 midway
    const gm = Math.max(Math.hypot(PIPE_G[0], PIPE_G[1], PIPE_G[2]) / PIPE_PITCH, PIPE_GRAD_FLOOR);
    const t = clamp01(1 - (m / gm) / (PIPE_HALF * wallW(o)));
    // The circular section. Zero slope at the crest, so it reads as a cord rather than a tent — and
    // a VERTICAL tangent where it meets the ground, which every continuity measurement calls a
    // defect and which is the whole reason a cord reads as something laid ON the surface. Tried
    // both filleted (Round times a smoothstep) and as a cosine hump, rendered as shaded relief
    // rather than as height, because light is what an eye is given: both read as a soft wrinkle IN
    // the surface instead of a cord on it, and both lose about 40% of the mean height as well.
    // ⚠ SO THE SPEC'S `Shoulder` CONTROL IS NOT MISSING, IT IS REFUSED — at its proposed default of
    // 0.15 it would make this worse. piping_guard F1 asserts the steep base and F2 is the filleted
    // version failing it, so the decision cannot be quietly undone.
    // ⚠ AND `Profile` IS NOT MISSING EITHER: the pattern CURVE is this kind's cross-section. For a
    // weave a value remap cannot touch the yarn's shape, because the yarn's geometry is decided
    // inside the kind before the sampler sees a number. Here the number IS the shape — F3 asserts
    // the height is a monotone function of distance to the contour, 0 disagreements in 60,000
    // samples — so Peaks carves grooves, Islands gives flat tops with a moat, Spots a softer cord.
    return Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  },

  // Distance to the nearest feature point: a dome over every one, meeting its neighbors in a
  // valley. Packed cells, fat lobules, cobblestone, a bed of eggs. Divided by 0.90 — just past
  // the p99 of F1 — so the domes fill their cells without the tails clipping flat. 34% of the
  // surface ends up raised.
  cells:   (x, y, z, o) => 1 - 2 * clamp01(worley3(x, y, z, o.seed).f1 / (0.90 * wallW(o))),
  // F2 minus F1 is ZERO exactly on the boundary between two cells and grows toward their middles,
  // so inverting it draws the wall itself: a raised net over flat floors. Capillary beds,
  // reticular fibre, leaf venation, the web between fat lobules. The 0.15 width is what keeps the
  // walls thin — it leaves 27% of the surface raised and pins the rest flat, which is what makes
  // this read as a network laid ON something rather than as more lumps.
  // ⚠ This is a net, not a tree: it has no trunk, nothing branches, and nothing tapers. A real
  // vascular field is a growth process and is a separate thing.
  // ⚠ THE WIDTH IS A CONTROL NOW AND WAS A CONSTANT. At 0.15 the walls are thinner than the gap
  // between vertices on anything but a very dense mesh — so the net can only be drawn where a
  // vertex happens to land ON a wall, and a continuous web renders as broken segments. Reported
  // exactly that way: "any idea why these are essentially dashed?" It is aliasing, not a defect in
  // the field: the feature is finer than the surface can represent. Widening it is the fix that
  // does not require subdividing, which is why it is a knob and not a bigger default.
  // MELON NETTING — a raised corky net over a smooth ground, in two scales, with dead ends.
  //
  // ⚠ IT IS NOT `web` WITH DIFFERENT NUMBERS. web is 1 - (f2-f1)/width, which gives a net of ONE
  // uniform width, no loose ends and one scale — a wire mesh. The photograph has four properties
  // none of which a width parameter can reach:
  //   · the ridge WIDTH varies along the net, from thick ropes to fine threads;
  //   · there are DEAD ENDS — ridges that branch, thin out and simply stop;
  //   · there are TWO SCALES, a coarse net with finer netting inside some of its cells;
  //   · the ridge is a ROUNDED CORKY HUMP, not a flat-topped wall.
  // Each is a separate mechanism below. A netting missing the dead ends in particular reads as
  // manufactured — a perfectly closed net is the one thing a healed crack pattern never is.
  netting: (x, y, z, o) => {
    const W = wallW(o);
    // ⚠ THE CROSS-SECTION IS A ROUNDED HUMP. (f2-f1) is zero ON a cell boundary and grows inward,
    // so t is 0 at the crest and 1 at the edge of the ridge; sqrt(1-t²) is a rounded cap where the
    // linear clamp `web` uses is a flat-topped wall with a hard shoulder. Suberised tissue heals
    // proud and rounded, and the shoulder is what makes a wall read as machined.
    const hump = (t) => Math.sqrt(Math.max(0, 1 - t * t));
    const netAt = (px, py, pz, seed, baseW) => {
      const w = worley3(px, py, pz, seed);
      // ⚠ WIDTH VARIES PER CELL, from the cell's OWN id rather than from position — keyed to
      // position it would drift across a boundary and one ridge would change width along itself
      // for no reason the eye can attribute to anything.
      const j = ((w.id % 997) / 997);
      const halfW = baseW * (0.45 + 1.25 * j);
      return hump(clamp01((w.f2 - w.f1) / halfW));
    };
    let net = netAt(x, y, z, o.seed, 0.16 * W);
    // ⚠ DEAD ENDS ARE MADE BY FADING THE RIDGE, NOT BY CUTTING IT. A hard threshold leaves a clean
    // gap with two blunt ends facing each other, which reads as damage. Fading over a distance
    // leaves a ridge that thins out and stops, which is what a crack that ran out of stress does.
    const cut = fbm(x * 0.9, y * 0.9, z * 0.9, o);
    net *= smoothstep(clamp01((cut + 0.62) / 0.5));
    // ⚠ THE SECOND SCALE LIVES INSIDE THE FIRST'S CELLS. Added everywhere it would cross the coarse
    // ridges and thicken them into a mat; multiplied by (1 - net) it fills the open ground between
    // them, which is where the photograph puts it.
    const F = 2.3;
    const fine = netAt(x * F, y * F, z * F, o.seed + 613, 0.16 * W);
    net = clamp01(net + fine * 0.42 * (1 - net));
    return net * 2 - 1;
  },

  // CITRUS RIND — packed bumps in two sizes, with sparse shallow pores between them.
  //
  // ⚠ IT IS CONVEX-DOMINANT, AND THAT IS THE WHOLE READING. A rind photographs as a field of
  // rounded mounds with small sunken pores BETWEEN them, not as a plane with pits punched into it.
  // Written the other way round — pits, with a raised rim around each — the rim carries the
  // silhouette and the surface reads as a golf ball or a sponge. The pores here are subtracted
  // late, shallow, and from a minority of cells, so they are a detail ON the bumps rather than the
  // structure of the surface.
  //
  // ⚠ A SPHERICAL CAP, NOT A LINEAR RAMP. `cells` divides f1 by a radius, which falls off linearly
  // and reads as a field of CONES once it is deep enough to see. sqrt(1 - t²) is the profile of an
  // actual dome, and it is what makes these read as swollen rather than faceted.
  //
  // ⚠ TWO POPULATIONS, AND THE SECOND IS SMALLER AND RIDES ON THE FIRST. One population at any
  // frequency gives cobblestone — evenly sized lumps, which is what `cells` already is. What makes
  // a rind a rind is a coarse mound carrying finer ones on its back, so the second is added at a
  // fraction of the weight rather than combined with a max, which would let it flatten the first.
  rind:    (x, y, z, o) => {
    const W = wallW(o);
    // ⚠ ROUNDNESS DRIVES THE PROFILE, AND IT ALREADY EXISTED WITH ONE CONSUMER. #noiseRoundness was
    // read by `aggregate` alone — a slider whose name promises a shape control and reaches one kind
    // of twenty. It is exactly the right control here: at 0 the bumps are cones, at 1 they are full
    // hemispherical caps, and the middle is the swollen-but-not-spherical profile a real rind has.
    // Blended rather than switched, so the slider is continuous over its whole travel.
    const round = o.roundness != null ? o.roundness : 0.55;
    const dome = (t) => {
      const cap = Math.sqrt(Math.max(0, 1 - t * t));   // a true spherical cap
      const cone = 1 - t;                              // the linear falloff `cells` uses
      return cone + (cap - cone) * round;
    };
    const a = worley3(x, y, z, o.seed);
    const domeA = dome(clamp01(a.f1 / (0.92 * W)));
    const F = 2.7;                                   // the second population's frequency
    const b = worley3(x * F, y * F, z * F, o.seed + 977);
    const domeB = dome(clamp01(b.f1 / (0.92 * W)));
    let h = domeA * 0.72 + domeB * 0.28;
    // The oil glands: a minority of a third, sparser population, dipped narrowly. Selected by the
    // CELL'S OWN id hash rather than by position, so a pore belongs to a cell and does not drift
    // across the boundary between two of them as the sample point moves.
    const P = 1.35;
    const c = worley3(x * P + 11.3, y * P + 5.1, z * P + 7.7, o.seed + 4211);
    if ((c.id % 1000) / 1000 < 0.34) {
      const tc = clamp01(c.f1 / (0.30 * W));
      h -= 0.26 * (1 - tc) * (1 - tc);               // narrow, quadratic, shallow
    }
    // ⚠ CLAMPED, because the pore subtracts after the sum and the contract is -1..1. Without this
    // a pore landing on the flank of a low mound returns below -1 and leaves the band the whole
    // module promises — the defect noise_guard's range assertions exist to catch.
    return clamp01(h) * 2 - 1;
  },
  web:     (x, y, z, o) => { const w = worley3(x, y, z, o.seed); return 1 - 2 * clamp01((w.f2 - w.f1) / (0.15 * wallW(o))); },
  // Each cell gets its own height from a hash, held flat across its whole interior and ramped
  // down near its borders — islands at different levels with real edges rather than a gradient.
  // Plaques, lichen, dried mud, tortoise shell, bone lamellae. The edge ramp is 0.10 wide: enough
  // that the border is a slope rather than a stair-step, narrow enough that the plateau survives.
  plaques: (x, y, z, o) => {
    const w = worley3(x, y, z, o.seed);
    return (2 * w.id - 1) * smoothstep(clamp01((w.f2 - w.f1) / (0.10 * wallW(o))));
  },


  // ================================================================================================
  // THE PHOTOGRAPHED KINDS, and what abstracting a photograph into a field actually means.
  //
  // These five come from photographs rather than from a paper, and the work was not tracing
  // them — a traced photograph is a bitmap, and a bitmap is an alpha, which this app
  // already has and which is the wrong instrument for "make the whole surface like this". The work
  // was finding the STRUCTURE each one is an instance of, so it can be generated anywhere, at any
  // scale, on any form, and so its proportions become controls rather than being baked into a
  // picture.
  //
  // ⚠ FOUR OF THE FIVE ARE TWO-SCALE, and that is the property the photographs were really asking
  // for. Every kind that existed before this is single-scale: one generator, one feature size. A
  // tyre is lugs AND sipes; a cactus rib is a corrugation AND the furrows that cut it; a monstrose
  // crest is knobs AND the crest they gather along; aggregate is stones AND the smaller stones
  // between them. Composing a coarse structure with a finer one cut into it is the capability, and
  // five more buttons is only how it is reached.
  // ================================================================================================

  // TUBERCLES — knobs gathered along a meandering crest. From a monstrose cactus (IMG_9097): the
  // growing point runs as a wandering line and the tubercles pack along it, leaving bare skin
  // between crests. Brains, coral, cauliflower curd, cerebriform anything.
  //
  // ⚠ THE TWO SCALES HAVE TO SEPARATE OR THIS IS JUST WORLEY, and the first attempt was. The crest
  // field ran at 0.45x the knob frequency, which is not a separation — the crest wandered at
  // almost the rate the knobs did, so no knob was ever clearly on or off a crest.
  // ⚠ AND THE THRESHOLD WAS MEASURED RATHER THAN CHOSEN. `1 - 2|fbm|` is not centered: measured over
  // 40,000 samples its median is 0.654 and its p75 is 0.835, so a band starting at 0.35 — which
  // looks like a reasonable "upper half" — is open across more than four fifths of the surface and
  // gates nothing at all.
  // ⚠ THE THRESHOLD TRADES GATHERING AGAINST COVERAGE and there is no value that maximises both.
  // Swept at a fixed grain: 0.70 raises 3.2% of the surface, 0.60 raises 7.5%, 0.52 raises 10.5%,
  // 0.45 raises 13.3% — and the higher it goes, the more clearly the knobs sit on crests with bare
  // skin between. 0.55 is the middle of that, landing near Villi's own 14.8% once the grain is
  // turned up, which is the density a student reaching for a bumpy surface expects to find.
  // ⚠ MULTIPLIED, NOT BLENDED TOWARD A FLOOR. A knob off the crest must be ABSENT. Blending it
  // toward a fraction of its height leaves packed cells everywhere with a brightness variation
  // over them, which is a shading effect wearing the costume of a structure.
  tubercles: (x, y, z, o) => {
    const F = 0.22;
    const ridge = 1 - 2 * Math.abs(fbm(x * F, y * F, z * F, o));
    const band = smoothstep(clamp01((ridge - 0.55) / 0.26));
    const w = worley3(x, y, z, o.seed);
    const knob = 1 - clamp01(w.f1 / (0.80 * wallW(o)));
    return clamp01(knob * band) * 2 - 1;
  },

  // RIBS — a corrugation cut across by furrows, with a pit where each furrow crosses a crest. From
  // a Gymnocalycium (IMG_9094): meridian ribs divided into wedges, an areole in every notch.
  // Fluting, corduroy, a radiator, a ribbed vault, the tucks in upholstery.
  //
  // ⚠ THE PIT LANDED IN THE VALLEY THE FIRST TIME, which is the opposite of the plant. cos(2*pi*u)
  // peaks at INTEGER u, and the distance was being measured from u = 0.5 — exactly the trough. On
  // a cactus the areole sits in the furrow that interrupts the rib CREST, so the pit's phase is
  // the crest's phase, not the valley's.
  // ⚠ THE FURROW CUTS THE CREST RATHER THAN SCALING THE WHOLE PROFILE. Multiplying the entire rib
  // by the furrow makes the corrugation fade in and out, which reads as a beat rather than as a
  // divided rib; holding a floor under it keeps the rib a rib and takes a bite out of its top.
  // ⚠ AND IT IS READ TRIPLANAR, because a corrugation has a direction. Sampled as a plain function
  // of position it would run true across the faces that happen to face the right way and smear
  // into stripes everywhere else.
  ribs: (x, y, z, o, nx, ny, nz) => triplanar(ribs2, x, y, z, nx, ny, nz, o),

  // AGGREGATE — stone at three grades, roundable from river pebble to crushed rock. From exposed
  // aggregate concrete and asphalt (IMG_9440, IMG_9426).
  //
  // ⚠ IT IS THREE WORLEY WALKS, NOT ONE, AND THAT IS THE WHOLE DIFFERENCE FROM `cells`. A single
  // Worley field gives stones of one size, because one feature point per cell IS one size. Real
  // aggregate is GRADED: coarse stones sit proud and finer ones fill between them, and taking the
  // max over three frequencies at falling amplitude is that grading. It is also why this reads as
  // a material and `cells` reads as a pattern.
  // ⚠ "ANGULAR" IS A DIFFERENT DISTANCE, NOT A DIFFERENT PROFILE. Reshaping the Euclidean distance
  // only changes how domed a pebble is — the first attempt raised it to a power and produced
  // rounder and less round pebbles, never a facet. Crushed rock is faceted because its surface is
  // a few FLAT PLANES, so each stone is bounded by the support distance in a handful of directions
  // keyed to its own id.
  // ⚠ AND THE PLANES HAVE TO BE MEASURED FROM THE STONE'S CENTER. Measured from the world origin —
  // which is all `worley3` allows, since it returns a distance and not an offset — they tile space
  // instead of bounding a stone, and every stone comes out cut by the same set of cracks. That is
  // what worleyOff3 exists for and it is the only reason it exists.
  // ⚠ VOIDS INVERT A HASHED MINORITY OF CELLS AND ARE SUBTRACTED, NOT MAXED. The grades are
  // combined under a max, so a negative stone can never win one and a pit written into `best`
  // would simply be outvoted by the finer grade filling the same place — which is what a vesicle
  // is not: a hole goes through whatever else is there. So a void cell is withheld from the max
  // and taken off the result instead, and a coarse void survives the fine stones inside it.
  // At voids 0 the term is skipped outright, so the field is bit-identical to the build before it.
  aggregate: (x, y, z, o) => {
    const round = o.roundness != null ? o.roundness : 0.55;
    const voids = o.voids > 0 ? o.voids : 0;
    const W = wallW(o);
    let best = -1, pit = 0;
    for (let g = 0; g < AGGREGATE_GRADES.length; g++) {
      const f = AGGREGATE_GRADES[g][0], amp = AGGREGATE_GRADES[g][1];
      const sd = (o.seed || 1) + g * 131;
      const w = worleyOff3(x * f, y * f, z * f, sd);
      const dome = 1 - clamp01(w.f1 / (0.85 * W));
      let sup = 0;
      for (let k = 0; k < 5; k++) {
        const a = hash3(w.cell, k, 17, sd) * 6.283;
        const b = Math.acos(2 * hash3(w.cell, k, 29, sd) - 1);
        const sb = Math.sin(b);
        const nx = Math.cos(a) * sb, ny = Math.cos(b), nz = Math.sin(a) * sb;
        const rad = 0.42 + 0.30 * hash3(w.cell, k, 41, sd);
        sup = Math.max(sup, (w.ox * nx + w.oy * ny + w.oz * nz) / rad);
      }
      const facet = 1 - clamp01(Math.max(sup, w.f1 / 1.35) / W);
      const stone = (dome * round + facet * (1 - round)) * amp;
      // The hash is per CELL and per grade seed, so a void is a whole stone's worth of hole rather
      // than a speckle, and the grades pick their voids independently.
      if (voids && hash3(w.cell, 3, 61, sd) < voids) { if (stone > pit) pit = stone; continue; }
      if (stone > best) best = stone;
    }
    return clamp01(voids ? best - pit : best) * 2 - 1;
  },

  // BARK — plates held at ONE level, split by deep narrow fissures, with a finer crack set scored
  // into each plate. From oak and pine (IMG_9472, IMG_9484, IMG_9459).
  //
  // ⚠ IT IS A THIRD READING OF THE WORLEY WALK, and each of its three properties is what separates
  // it from a kind already here. Held at one level, so it is not `plaques`, whose whole idea is a
  // per-cell hash giving every island its own height. A deep narrow CUT in a mostly-raised surface,
  // so it is not `web`, which is a thin raised net over a floor that is flat at -1 — measured at
  // the same grain and seed, bark reads 59.7% raised and 13.3% below -0.8 and web reads 23.6% and
  // 60.4%, which is the same pair of numbers the other way round. And a second crack scale, which
  // is the two-scale property the photographed kinds exist for.
  //
  // ⚠ THE FINE CRACKS NEED A FLOOR OR THERE IS ONLY ONE SCALE. Multiplied straight in, the second
  // walk cuts as deep as the first and the two fissure sets become indistinguishable: measured, the
  // crossing ratio between a shallow and a deep threshold reads 1.08, which is no separation at
  // all. Holding a floor under it makes it a SCORE in the plate rather than a second fissure
  // through it. Swept — 0.25 gives 1.22, 0.40 gives 1.84, 0.55 gives 1.89, 0.70 falls back to 1.14
  // as the fine cracks stop reaching at all. 0.55 sits in the middle of the window rather than on
  // its edge.
  //
  // ⚠ IT IS STRETCHED, NOT TRIPLANAR, AND THE DIFFERENCE IS A SEAM. `triplanar` exists for the 2D
  // kernels — a flat pattern needs a plane to be read in, and its own note says a flat pattern on a
  // closed surface cannot not have a seam. This is a genuine 3D field: worley3 in three dimensions
  // has no plane and no seam. Bark's directionality is a STRETCH, which costs nothing.
  // ⚠ AND THE STRETCH IS BAKED IN RATHER THAN LEFT TO FIBRE. Fibre does deliver it — measured, it
  // takes plaques' lag-6 correlation ratio from 1.04 to 0.60 — but a button called Bark that only
  // looks like bark once a DIFFERENT slider has been moved is a button that mis-sells itself, and
  // the swatch is what a student picks from. Fibre still composes on top, either way.
  bark: (x, y, z, o) => {
    const W = wallW(o), sd = o.seed || 1;
    const yy = y * BARK_STRETCH;
    const w = worley3(x, yy, z, sd);
    const fissure = smoothstep(clamp01((w.f2 - w.f1) / (0.16 * W)));
    const w2 = worley3(x * 2.7, yy * 2.7, z * 2.7, sd + 733);
    const fine = BARK_FINE_FLOOR + (1 - BARK_FINE_FLOOR) * smoothstep(clamp01((w2.f2 - w2.f1) / (0.22 * W)));
    const grit = 1 - 2 * Math.abs(fbm(x * 3.1, yy * 3.1, z * 3.1, { ...o, octaves: 3 }));
    return clamp01(fissure * fine * (0.72 + 0.28 * grit)) * 2 - 1;
  },

  // SKIN — a fine incised polygonal net, a hashed MINORITY of much deeper creases, and pores.
  // From a palm and a knuckle (IMG_9470, IMG_9469). The most-reached-for surface there is, and
  // the one this app was missing.
  //
  // ⚠ THE COARSE CREASES ARE A MINORITY OF A SECOND WALK, NOT A SECOND WHOLE NET. A full coarse net
  // is a bigger version of the fine one, which is one pattern at two sizes — the exact failure the
  // scale journey's own note warns about and H3 gates. Keeping about a third of the coarse walls
  // leaves long isolated creases with bare skin between them, which is what a palm is.
  // ⚠ MAX, NOT SUM. A crease crossing the fine net must be one crease, not a crease plus a wall:
  // adding them makes every intersection deeper than either, which reads as a beaded seam.
  // ⚠ IT READS AS TOO CLEAN UNLESS BOTH ARE DONE, BECAUSE SKIN IS NOISY IN TWO SEPARATE PLACES.
  // Tidy polygons with glassy flat interiors are a reptile, not a palm. Both are fixed here and
  // they are different defects:
  //   · THE NET'S OWN POSITION IS JITTERED by a slow fbm before the walk, so the cells stop being
  //     regular polygons. Jittering the RESULT would only soften the walls; moving where the walk
  //     is READ bends the cells themselves.
  //   · THE PLATEAUS CARRY A FINE GRAIN, weighted by how far they are from a groove, so it
  //     stipples the flat and leaves the creases as creases rather than filling them in.
  // ⚠ AND THE OBVIOUS METRIC IS A POOR INSTRUMENT HERE, which is worth saying so nobody tunes
  // against it: mean neighbor difference moves only 0.228 -> 0.240, because it is dominated by the
  // deep creases that did not change. The plateau is where the change is, so that is what the gate
  // measures and what the eye was used for.
  skin: (x, y, z, o) => {
    const W = wallW(o), sd = o.seed || 1;
    const j = SKIN_JITTER * fbm(x * 2.3, y * 2.3, z * 2.3, { ...o, octaves: 2 });
    const w = worley3(x + j, y + j * 0.8, z - j * 0.6, sd);
    const fine = 1 - smoothstep(clamp01((w.f2 - w.f1) / (0.20 * W)));
    const wc = worley3(x * SKIN_COARSE, y * SKIN_COARSE, z * SKIN_COARSE, sd + 9173);
    const keep = hash3(Math.round(wc.id * 4096), 0, 0, sd + 51) < 0.34 ? 1 : 0;
    const crease = keep * (1 - smoothstep(clamp01((wc.f2 - wc.f1) / (0.06 * W))));
    const pore = hash3(Math.round(w.id * 4096), 3, 7, sd + 17) < 0.18
      ? (1 - smoothstep(clamp01(w.f1 / (0.22 * W)))) : 0;
    const grooves = clamp01(Math.max(fine * 0.42, crease, pore * 0.55));
    const grain = SKIN_GRAIN * (0.5 + 0.5 * fbm(x * 7.7, y * 7.7, z * 7.7, { ...o, octaves: 3 }));
    return 1 - 2 * clamp01(grooves + grain * (1 - grooves));
  },

  // TIMBER — split, weathered wood: fibre broken into blocky files, deep checks running with the
  // grain, and knots the grain has to get past. From a rotted trunk (IMG_9504, IMG_9505).
  //
  // ⚠ THE TWO PHOTOGRAPHS ARE ONE KIND AND THE KNOT IS WHY. IMG_9505 is plain splintered grain;
  // IMG_9504 is the same board a foot away with a knot hole in it. Building them as two buttons
  // would be two names for one material, and building only the plain one would leave out the
  // single thing in the batch that no field here can already do.
  //
  // ⚠ AND WHAT IS NEW IS NOT THE STRETCH. Elongating a cellular field is reachable already: Fibre
  // does it, and `bark` bakes it. A knot is a SINGULARITY IN THE FIELD'S OWN DIRECTION — the grain
  // arrives, parts, crowds onto the knot's shoulders and closes behind it — and nothing in this
  // file has a direction that varies with position around a defect. `attention` has a direction
  // that varies, but it varies at random and has nothing to vary AROUND.
  //
  // ⚠ THE GRAIN IS NOT WARPED AWAY FROM THE KNOT, IT IS READ IN THE KNOT'S OWN COORDINATE, and
  // that is the whole difference between a knot and a dent. Grain lines past a knot are the
  // streamlines of flow past an obstacle, and for a sphere those are the level sets of
  // psi = rho^2 (1 - a^3/r^3): so the across-grain coordinate the shard walk is sampled at IS
  // psi, which costs one divide and gets the crowding for free. A displacement applied to the
  // height instead would move the surface and leave the fibres running straight through it.
  // ⚠ AND THE FALLOFF IS THE SPHERE'S, NOT THE CYLINDER'S. Tried first as a^2/r^2 — the cylinder
  // law — the deflection reached so far that the whole annulus around a knot collapsed onto its
  // center and came out as CONCENTRIC RINGS, which is not what wood does and is very obviously
  // wrong once it is on the screen. 1/r^3 keeps it local: the fibres bend and stay fibres.
  //
  // ⚠ THE SOCKET'S EDGE IS TORN BY THE FIELD THAT IS ALREADY THERE. A clean radial threshold reads
  // as a drilled hole, and the fine fibre grain is a field this kind has already paid for, so the
  // rim is jittered by it rather than by a fourth sample.
  timber: (x, y, z, o) => {
    const sd = o.seed || 1, W = wallW(o);
    // the knot lattice: one candidate per coarse cell, a hashed minority of them real.
    const k = worleyOff3(x * TIMBER_KF, y * TIMBER_KF, z * TIMBER_KF, sd + 5011);
    const live = hash3(k.cell & 0xffff, 5, 9, sd + 6007) < TIMBER_KEEP;
    let px = x, pz = z, kt = -1;
    if (live) {
      const ox = k.ox / TIMBER_KF, oy = k.oy / TIMBER_KF, oz = k.oz / TIMBER_KF;
      const r2 = ox * ox + oy * oy + oz * oz;
      const a3 = TIMBER_KR * TIMBER_KR * TIMBER_KR;
      const f = TIMBER_SWIRL * a3 / (Math.pow(r2, 1.5) + a3);
      px = x - ox * f; pz = z - oz * f;
      kt = (k.f1 / TIMBER_KF) / TIMBER_KR;
    }
    // Shards: cells three times longer along the grain, each held at its OWN level with a narrow
    // edge — blocky files that break across, not lozenges.
    const w = worley3(px * TIMBER_F, y * TIMBER_F / TIMBER_E, pz * TIMBER_F, sd);
    const edge = smoothstep(clamp01((w.f2 - w.f1) / (TIMBER_EDGE * W)));
    // Checks: a far coarser and far longer walk, so a split runs the whole way rather than sitting
    // inside one shard.
    const w2 = worley3(px * TIMBER_F2, y * TIMBER_F2 / TIMBER_E2, pz * TIMBER_F2, sd + 733);
    const check = smoothstep(clamp01((w2.f2 - w2.f1) / (TIMBER_CHECK * W)));
    const raw = fbm(px * 6.0, y * 1.2, pz * 6.0, { ...o, octaves: 3 });
    let h = (0.55 + TIMBER_SHARD * (2 * w.id - 1) * edge + TIMBER_FIB * raw) * (0.18 + 0.82 * check);
    if (kt >= 0) {
      const t = kt * (1 + 0.30 * raw);
      const hole = 1 - smoothstep(clamp01((t - 0.24) / 0.40));
      const rim = 1 - smoothstep(clamp01(Math.abs(t - 0.80) / 0.32));
      h = h * (1 - hole) + hole * (-0.30 + 0.5 * TIMBER_FIB * raw) + 0.30 * rim;
    }
    return Math.max(-1, Math.min(1, h * 2 - 1));
  },

  // GILLS — deep thin blades at a held spacing, a hashed minority of which run only part of their
  // length. From the underside of a mushroom (IMG_9500).
  //
  // ⚠ THE STRUCTURE IS THE SPACING, NOT THE STRIPE. Anything can draw parallel ridges; `ribs`
  // already does. What a gilled cap does that a corrugation cannot is hold the spacing CONSTANT
  // over a surface that keeps getting wider, which it pays for by starting new blades partway —
  // the short gills. So the claim this kind has to make is that some blades end, and that where
  // one is absent the gap between its neighbors is a double gap.
  //
  // ⚠ AND IT IS BUILT AS A SHORT BLADE, NOT AS A DISLOCATION, WHICH WAS THE FIRST ATTEMPT AND IS
  // ILLEGAL. The textbook way to insert a stripe is a phase field with a topological defect,
  // phi = 2*pi*f*x + sum of atan2 terms. It does not survive being a field on an unbounded domain:
  // the phase of a single defect never decays, so the sum has to be truncated, and truncating it
  // steps the phase — measured, len/Rc is 0.34 rad at any neighborhood this can afford, which is
  // 5% of a period and a visible crack. Windowing the atan2 to fade it out is worse and is not a
  // near miss but a category error: cos(w*theta) is only continuous across the branch cut when w
  // is 0 or 1, so a fractional window puts a 2*pi cut through the middle of the field. That
  // version drew hooks and worms, and the hooks were the cut.
  // A blade that simply STOPS gets the same picture — where it is missing the spacing is twice as
  // wide, which is what a lamellula looks like — for one hash and no topology at all.
  //
  // ⚠ ROUNDED AT THE CREST, AND NOT BECAUSE IT IS PRETTIER. A gill edge is a rounded free margin,
  // and a plateau profile with a hard shoulder reads as a rib. sin(pi/2 * s) has zero slope at the
  // top and a finite slope at the base, so the blade meets the floor cleanly and domes over its
  // own edge; a semicircle would be truer and has an infinite slope at the base, which displacement
  // turns into a crease and shading turns into a staircase — the same defect vesselFieldAt records.
  //
  // ⚠ NO FINE SECOND SCALE, DELIBERATELY. Every photographed kind before this is two-scale and the
  // first version of this one carried striations along the blade faces. At any grain a student can
  // use, those are finer than the gap between vertices — the exact condition `web`'s note names —
  // and they did not render as striations, they rendered as speckle and beading on the blade edge.
  // The second population here is the SHORT BLADES, which are the same size as the first and are
  // the structure the photograph is actually about.
  gills: (x, y, z, o) => {
    const sd = o.seed || 1, W = wallW(o);
    // The blades wander. Applied to the position rather than to the result, so a blade bends and
    // stays one blade, and the bend carries across the form in three dimensions.
    const u = x * GILL_FREQ + GILL_WOB * fbm(x * 0.17, y * 0.17, z * 0.17, { ...o, octaves: 2 });
    const i = Math.round(u);
    const s = clamp01(1 - Math.abs(2 * (u - i) / (GILL_B * W)));
    if (s <= 0) return -1;
    let h = 1;
    if (hash3(i, 11, 3, sd + 77) < GILL_SHORT) {
      // ⚠ SLOW ALONG THE BLADE OR A SHORT GILL IS A DASHED ONE. Keyed to the blade's own index so
      // neighbors are independent, and swept slowly along its length so it stops ONCE.
      const life = fbm(i * 7.3, y * 0.13, z * 0.13, { ...o, octaves: 1, seed: sd + 401 });
      h = smoothstep(clamp01((life + GILL_RUN) / 0.30));
    }
    // The free edge runs a little in height rather than being a drawn line.
    h *= 1 - GILL_NICK * (0.5 + 0.5 * fbm(i * 13.1, y * 0.75, z * 0.75, { ...o, octaves: 2, seed: sd + 913 }));
    return clamp01(Math.sin(clamp01(s * h) * Math.PI / 2)) * 2 - 1;
  },

  // WEAVE — two thread families interlacing, at four bindings. From a herringbone knit, a twill and
  // a waffle cloth (IMG_9451, IMG_9444, IMG_9453).
  //
  // ⚠ THE FIRST VERSION MADE BASKETWEAVE OUT OF EVERY SETTING, and the reason is the thing worth
  // knowing about woven cloth: a binding IS A FLOAT LENGTH. A twill is warp over two wefts, under
  // two, the run shifting one thread per row — so if the thread profile restarts at every crossing,
  // no thread ever floats across more than one, and the diagonal wale can never appear however the
  // over-under rule is written. Each profile is a function of the ACROSS coordinate only, so a
  // thread is continuous along its own length and a float of two reads as one unbroken ridge.
  // ⚠ HERRINGBONE REVERSES IN BANDS ALONG THE WARP, so the reversal keys off the warp index. Keyed
  // off the weft index instead — which is the easy mistake, the bands being visually horizontal —
  // the chevron lies down the wrong way and reads as a staircase.
  // ⚠ WAFFLE IS NOT AN OVER-UNDER AT ALL and is not built as one. It is a raised GRID with a sunk
  // well inside each square, so it is written as a grid and a well rather than as a binding, which
  // is also why it is the one setting that does not look woven.
  weave: (x, y, z, o, nx, ny, nz) => triplanar(weave2, x, y, z, nx, ny, nz, o),

  // TREAD — molded lugs, deep grooves and fine sipes. From a winter tyre (IMG_9439). The one kind
  // here that is manufactured rather than grown, which is most of the reason to have it.
  //
  // ⚠ SHEARED, BECAUSE AXIS-ALIGNED BLOCKS READ AS A KEYBOARD. The first version was a plain grid
  // of rectangles with hard black grooves and looked like nothing on a road. A tread is
  // DIRECTIONAL — the lugs lean, and the lean is what carries the sense of motion.
  // ⚠ THE GROOVE IS A CHAMFER, NOT A CLIFF, and the sipes only cut where there is a lug to cut:
  // sipes running on across the groove floor turn the whole thing into corduroy.
  pile:    (x, y, z, o, nx, ny, nz) => triplanar(pile2, x, y, z, nx, ny, nz, o),
  tread: (x, y, z, o, nx, ny, nz) => triplanar(tread2, x, y, z, nx, ny, nz, o),
  coffer: (x, y, z, o, nx, ny, nz) => triplanar(coffer2, x, y, z, nx, ny, nz, o),

  // ================================================================================================
  // THE THINKING KINDS — three structures from how this thing actually works, as surfaces.
  //
  // Thinking rendered graphically — no words, just shapes. Not diagrams of a transformer:
  // a diagram has labels, arrows and a reading order, and none of those survive being turned into
  // a height field. What survives is the SHAPE of the process, and each of these is one property
  // that is true of the mechanism and happens to make a good surface.
  // ================================================================================================

  // ATTENTION — many competing orientations, and WHICH one wins is decided per position.
  //
  // The mechanism this comes from: every position scores every other, the scores are softmaxed, and
  // a couple dominate while the rest go to nearly nothing. As a surface that is a grain which
  // REORGANISES — coherent in one direction over here, another over there, with a zone of
  // interference where two are competing. That last part is the honest bit and the reason it looks
  // like anything: a softmax rarely picks one, it usually mixes two or three, and the mixing is
  // where the structure gets interesting rather than where it breaks down.
  //
  // ⚠ THE TEMPERATURE IS THE WHOLE PICTURE. At a sharp temperature one head wins essentially
  // everywhere and this is a field of plain diagonal stripes with nothing to say — which is what it
  // was on the first attempt. Softened until two or three heads genuinely share the weight, the
  // competition becomes visible, and the competition is the subject.
  attention: (x, y, z, o) => {
    const sd = o.seed || 1;
    const sc = new Array(ATTENTION_HEADS);
    let best = -1e9;
    for (let k = 0; k < ATTENTION_HEADS; k++) {
      const s = fbm(x * 0.19 + k * 11.3, y * 0.19 - k * 7.1, z * 0.19 + k * 3.7, { ...o, octaves: 2 }) * 3;
      sc[k] = s; if (s > best) best = s;
    }
    let sum = 0;
    for (let k = 0; k < ATTENTION_HEADS; k++) { const e = Math.exp((sc[k] - best) * 1.05); sc[k] = e; sum += e; }
    let acc = 0;
    for (let k = 0; k < ATTENTION_HEADS; k++) {
      const a = hash3(k, 3, 11, sd) * Math.PI, b = hash3(k, 7, 13, sd) * Math.PI * 2;
      const sa = Math.sin(a);
      const kx = Math.cos(a), ky = sa * Math.cos(b), kz = sa * Math.sin(b);
      const wave = Math.cos((x * kx + y * ky + z * kz) * Math.PI * 2 + hash3(k, 5, 17, sd) * 6.283);
      acc += (sc[k] / sum) * (1.5 - 2 * Math.abs(wave));
    }
    return Math.max(-1, Math.min(1, acc * ATTENTION_GAIN - ATTENTION_BIAS));
  },

  // SUPERPOSITION — more systems than there is room for, sharing one space.
  //
  // The mechanism: features are not given a dimension each. Many of them are laid over the same
  // dimensions at incommensurate angles and read back out by interference — which works because
  // they are rarely all active at once. As a surface: several periodic systems at ratios that never
  // come back into step, reinforcing into strong structure where they agree and canceling to flat
  // where they do not. The flat regions are not empty; they are where everything is on at once.
  //
  // ⚠ THE FREQUENCIES ARE IRRATIONAL RATIOS ON PURPOSE. Any rational set repeats, and a pattern
  // that repeats has a tile — which is the one thing this is not about.
  superposition: (x, y, z, o) => {
    const sd = o.seed || 1;
    let s = 0;
    // ⚠ THE PAIRS SHARE A DIRECTION AND THAT IS THE WHOLE MECHANISM. Two waves at nearby
    // frequencies pointing DIFFERENT ways do not beat — they moire, and a moire has no amplitude
    // envelope, so every neighborhood is about as loud as every other. Measured: with four
    // independent directions the loudest block varied 1.27x more than the quietest, and moving the
    // frequencies closer together while leaving the directions random took that to 1.29 — no change,
    // because the frequencies were never the problem. Two waves along nearly the same axis sum to
    // cos(half the difference) times cos(the mean), and the first factor IS the envelope: broad
    // regions where the pair reinforces and broad regions where it cancels.
    for (let pr = 0; pr < SUPERPOSE_PAIRS.length; pr++) {
      const f0 = SUPERPOSE_PAIRS[pr][0], f1 = SUPERPOSE_PAIRS[pr][1];
      const a = hash3(pr, 2, 7, sd) * Math.PI, b = hash3(pr, 9, 19, sd) * Math.PI * 2;
      for (let m = 0; m < 2; m++) {
        // A few degrees of splay between the pair's members, so the interference is not a perfect
        // one-dimensional beat with dead-straight nodes.
        const aa = a + (m ? SUPERPOSE_SPLAY : 0), bb = b + (m ? SUPERPOSE_SPLAY : 0);
        const sa = Math.sin(aa);
        const kx = Math.cos(aa), ky = sa * Math.cos(bb), kz = sa * Math.sin(bb);
        const fr = m ? f1 : f0;
        s += Math.cos((x * kx + y * ky + z * kz) * Math.PI * 2 * fr + hash3(pr, 4 + m, 23, sd) * 6.283);
      }
    }
    s /= SUPERPOSE_PAIRS.length * 2;
    const env = Math.abs(s);
    return Math.max(-1, Math.min(1, smoothstep(clamp01((env - 0.10) / 0.62)) * Math.sign(s) * env * 1.7));
  },

  // BACKTRACK — many attempts begun, most abandoned early, a few carried through and deepened.
  //
  // The mechanism: a lot of candidate explanations get started, nearly all of them are cut off as
  // soon as a measurement refutes them, and the rare one that survives gets pursued further and
  // cuts deeper. The lengths are heavy-tailed by cubing a uniform draw, so short stubs are the
  // common case and a long run is genuinely rare — which is the distribution the work actually
  // has, not a decorative one.
  //
  // ⚠ IT IS NOT VESSELS. A vessel network is a tree in which every branch survives and thickens
  // toward its trunk; this is the opposite claim — dead ends everywhere, no taper, and the depth
  // rewards LENGTH rather than flow. Several attempts share a lane, so an abandoned run and the one
  // that replaced it sit end to end, which is what looking at it again looks like.
  backtrack: (x, y, z, o) => {
    const sd = o.seed || 1;
    const LANES = 3;
    const yl = y * LANES;
    const lane = Math.floor(yl);
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      const L = lane + d;
      const wob = fbm(x * 0.42, L * 3.7, z * 0.42 + sd, { ...o, octaves: 2 }) * 0.30;
      const dist = Math.abs(yl - (L + 0.5 + wob));
      if (dist > 0.60) continue;
      const prof = 1 - smoothstep(clamp01(dist / 0.34));
      if (prof <= 0) continue;
      // ⚠ ONE ATTEMPT PER CELL, NOT FOUR SCATTERED OVER TEN UNITS. Scattering them left the field
      // raising 5% of the surface — sparser than anything else in this file, where the emptiest
      // existing kind (`web`) raises 26% — so at any usable amount it read as a bare sphere with
      // a couple of scratches on it. Anchoring an attempt to each cell makes the density uniform
      // and puts an abandoned run end to end with the one that replaced it, which is the point.
      const cell = Math.floor(x);
      for (let c = cell - 2; c <= cell; c++) {
        const start = c + hash3(L, c, 31, sd) * 0.55;
        // ⚠ THE EXPONENT IS THE TAIL, and flattening it to raise the density lost the claim. The
        // point is that most attempts die early and a rare one carries on, so the mean length has
        // to be held while the SHAPE stays heavy — a bigger exponent with a bigger multiplier does
        // that, where simply shortening everything gave a uniform field of equal dashes.
        const life = 0.10 + 2.2 * Math.pow(hash3(L, c, 53, sd), 3.0);
        const t = x - start;
        if (t < 0 || t > life) continue;
        const fade = smoothstep(clamp01(t / 0.12)) * smoothstep(clamp01((life - t) / 0.12));
        const depth = 0.30 + 0.70 * smoothstep(clamp01(life / 1.3));
        const v = prof * fade * depth;
        if (v > best) best = v;
      }
    }
    return best * 2 - 1;
  },

  // ---- escape-time: the one kind whose detail is exact rather than sampled ------------------
  //
  // Every kind above gets its fine detail from RANDOMNESS — more octaves, more feature points. A
  // quaternion Julia set gets it from ITERATION: the structure at every scale is the same rule
  // applied again, so the filigree is deterministic, self-similar and infinitely deep rather than
  // stacked from independent layers. That is a different-looking thing and it is the reason to
  // have it: coral, bone trabeculae, dendritic arbors, the boundary between two tissues.
  //
  // ⚠ IT IS AN ORBIT TRAP, NOT AN ESCAPE COUNT OR A DISTANCE ESTIMATE, and that was measured
  // rather than preferred. A distance estimate is only defined OUTSIDE the set and saturates on
  // both sides: measured on a spherical shell, a grain of 0.6 left 90-100% of the surface inside
  // the set and a grain of 1.5 left 0-2% — a usable window about half a decade wide, which is a
  // constant tuned to one radius wearing the costume of a feature. An orbit trap is a property of
  // the whole trajectory, so it has no inside to fall into: measured interquartile range 0.83 to
  // 1.29 across shell radii from 2 to 32, a sixteenfold range.
  //
  // ⚠ AND IT MIRROR-TILES, because a Julia set is a fixed object in space while every other kind
  // here is a stationary field. Without tiling, raising the grain does not make the fractal
  // smaller — it walks you out of the fractal, and past the escape radius the field is flat. The
  // fold is a TRIANGLE WAVE rather than a modulo: a modulo fold steps at every cell boundary and a
  // step in a displacement field is a crack in the surface, while reflected cells meet at equal
  // values. The derivative still turns over at a seam, which reads as a faint crease.
  julia: (x, y, z, o) => {
    const ci = Math.abs(Math.round(o.seed || 1)) % JULIA_C.length;
    const c = JULIA_C[ci];
    const f = (t) => { const u = Math.abs(t) % (2 * JULIA_PERIOD); return (u > JULIA_PERIOD ? 2 * JULIA_PERIOD - u : u) - JULIA_PERIOD / 2; };
    let a = f(x), b = f(y), cc = f(z), d = 0, m = Infinity;
    for (let i = 0; i < JULIA_ITER; i++) {
      const r2 = a*a + b*b + cc*cc + d*d;
      // From i>0, so the trap measures where the ORBIT goes rather than where it started — the
      // starting radius is just the sample position and carries no structure at all.
      if (i > 0 && r2 < m) m = r2;
      if (r2 > JULIA_BAIL * JULIA_BAIL) break;
      // Quaternion squaring. Only the real part mixes the imaginary components, which is what
      // makes q^2 cheap: (a,b,c,d)^2 = (a2-b2-c2-d2, 2ab, 2ac, 2ad).
      const na = a*a - b*b - cc*cc - d*d;
      const nb = 2*a*b, nc = 2*a*cc, nd = 2*a*d;
      a = na + c[0]; b = nb + c[1]; cc = nc + c[2]; d = nd + c[3];
    }
    // Center and half-width measured at radius 4 across the four constants: p10 0.18-0.25,
    // p50 1.10-1.41, p90 1.91-2.10. Inverted so the CLOSE approaches — the filaments — come out
    // raised, since the filigree is the thing worth having.
    // ⚠ THE FAR FIELD IS PINNED FLAT RATHER THAN SHADED, and this is the fix for a reported defect:
    // "Julia shouldn't be on these spherical islands". The islands were real and they were not the
    // fractal. For a point that escapes on its first step the trap reduces to the size of that first
    // iterate, which varies SMOOTHLY with position — so every tile of the mirror fold came out as a
    // rounded bowl with a thread of actual filigree in it, and the bowls read as the subject. There
    // is no mapping that turns a compact set into a texture; what there is, is a choice about what
    // the outside should look like. Flat is honest: outside the set there is nothing to describe.
    const t = Math.sqrt(m === Infinity ? 0 : m);
    return Math.max(-1, Math.min(1, (JULIA_CENTRE[ci] - t) / 0.40));
  },

  // ---- one slider through the scales ------------------------------------------------
  //
  // Every kind above answers one question: what does the surface look like at THIS scale. The
  // thing a scale journey is about is that the answer CHANGES as you go in — territories give way
  // to vessels, vessels to cells, cells to pores, pores to grain. A frequency slider cannot show
  // that, because it magnifies one structure instead of arriving at the next one; you get the same
  // pattern larger, which is the opposite of what looking closer does.
  //
  // So this crossfades between MECHANISMS and their scales together. `journey` runs 0..1 and walks
  // the stages below, blending each into the next, and each stage carries its own grain multiplier
  // so the sweep spans about two decades — a hundredfold — rather than a change of pattern at one
  // size. It is one kind rather than a mode beside the others, so it shows its own control the way
  // the radial layouts do and cannot be on at the same time as a fixed kind.
  journey: (x, y, z, o) => {
    const t = clamp01(o.journey == null ? 0.5 : o.journey);
    const u = t * (JOURNEY.length - 1);
    const i = Math.min(JOURNEY.length - 2, Math.floor(u));
    const a = JOURNEY[i], b = JOURNEY[i + 1];
    const va = NOISE_KINDS[a.kind](x * a.grain, y * a.grain, z * a.grain, o);
    const vb = NOISE_KINDS[b.kind](x * b.grain, y * b.grain, z * b.grain, o);
    // Smoothstepped so a stage arrives and departs gently; a linear blend makes the midpoint of
    // every crossing look like mud, because two unrelated structures at half strength always do.
    const w = smoothstep(clamp01(u - i));
    return va + (vb - va) * w;
  },
};

// The stages, coarse to fine, with the grain multiplier each is seen at. The multipliers span
// 0.25x to 25x — two decades — which is what makes this a journey through scale rather than a
// crossfade between patterns at one size. Named for what a student is looking at, since that is
// the whole point of arranging them in this order.
//
// ⚠ THE GRAINS ARE SOLVED, NOT CHOSEN, and the first set of them was wrong in the one way that
// matters. Picking round numbers gave a sweep that went coarse, FINE, less fine, finer, finest —
// the web stage came out finer than packed cells, because F2-F1 draws thin walls whose scale is
// set by wall thickness rather than by cell size. A journey through scale that stutters halfway is
// broken at exactly the thing it exists to show, and no amount of looking at one frame reveals it.
//
// So feature size was measured for every kind across a range of grains — as the distance you must
// travel before the field stops resembling itself, which is independent of how sharp its edges
// are — and the grains were then solved to put the five stages on a geometric ladder:
//
//   territories 2.296  ->  walls 0.740  ->  cells 0.232  ->  pores 0.108  ->  grain 0.024
//
// Strictly finer at every step, spanning 95.7x. That is 1.98 decades: the "powers of ten" in the
// name is a measurement rather than a flourish.
const JOURNEY = [
  { kind: 'plaques', grain: 0.25, label: 'territories' },
  { kind: 'web',     grain: 0.25, label: 'vessels and cell walls' },
  { kind: 'cells',   grain: 1.6,  label: 'packed cells' },
  { kind: 'pitted',  grain: 4.5,  label: 'pores' },
  { kind: 'cloud',   grain: 25,   label: 'grain' },
];
export const JOURNEY_STAGES = JOURNEY.map(s => s.label);
// What the slider is looking at right now, for the readout — the nearest stage, or the two it
// currently sits between, so the control says where you are rather than showing a bare number.
export function journeyLabel(t) {
  const u = clamp01(t) * (JOURNEY.length - 1);
  const i = Math.min(JOURNEY.length - 2, Math.floor(u)), f = u - i;
  if (f < 0.2) return JOURNEY[i].label;
  if (f > 0.8) return JOURNEY[i + 1].label;
  return `${JOURNEY[i].label} into ${JOURNEY[i + 1].label}`;
}

// ---- the third generator: a pattern that is GROWN rather than sampled ----------------
//
// ⚠ THIS ONE DOES NOT FIT THE SHAPE OF THE OTHERS, and that is worth saying plainly rather than
// disguising. Every kind above is a function of position: hand it an x,y,z and it answers. A
// reaction-diffusion pattern cannot be, because it has no closed form — it is the state of a
// simulation that has to be run. So it produces a per-vertex BUFFER and the rest of the pipeline
// (settle, the mask, displacement, tint) consumes that buffer exactly as it consumes a sampled
// field. Pretending it was a position function would have meant running it on a 3D grid and
// sampling it, which is possible and which throws away the reason to want it: run on the surface
// itself it follows the form, wraps with no seam, and reacts to the mesh's own density.
//
// GRAY-SCOTT. Two substances diffusing at different rates while reacting:
//     du/dt = Du*lap(u) - u*v^2 + F*(1-u)
//     dv/dt = Dv*lap(v) + u*v^2 - (F+k)*v
// From two numbers — the feed rate F and the kill rate k — the same three lines produce spots,
// stripes, a labyrinth, holes, and spots that divide like cells. That is the whole reason this is
// worth its cost: one solver covers most of what a surface in biology looks like.
//
// The Laplacian is the UMBRELLA on the mesh's own one-ring — the average of a vertex's neighbors
// minus the vertex — which is the same operator the Smooth brush already is. Nothing new had to be
// built to diffuse over a sculpted surface.
//
// ⚠ ITS FEATURE SIZE IS IN EDGES, NOT IN WORLD UNITS, and that is a real difference from Grain.
// Diffusion spreads by one ring per step, so how big a spot ends up is set by how many steps run
// and how many vertices it crossed — meaning the same settings give finer features on a denser
// mesh. `steps` is therefore scaled by the caller against vertex count rather than being a raw
// iteration number the student has to re-guess after every Divide.
export function growReactionDiffusion(vnOffset, vnList, nv, {
  feed = 0.037, kill = 0.06, du = 0.16, dv = 0.08, steps = 2000, seed = 1, seedPatches = 24,
} = {}) {
  let u = new Float32Array(nv).fill(1);
  let v = new Float32Array(nv);
  let u2 = new Float32Array(nv), v2 = new Float32Array(nv);

  // SEEDED, NOT RANDOM. Gray-Scott from a perfectly uniform start stays uniform forever — the
  // pattern has to be disturbed into existence. Patches are chosen by the same integer hash the
  // rest of this file uses, so the same seed grows the same pattern on the same mesh, which is
  // what makes it a thing you can design with rather than a slot machine.
  for (let p = 0; p < seedPatches; p++) {
    const centre = Math.floor(hash3(p, 0, 0, seed) * nv) % nv;
    v[centre] = 1;
    // One ring out, so each seed is a patch rather than a single point: a lone vertex is below the
    // scale the reaction can sustain and dies out before anything grows.
    for (let j = vnOffset[centre]; j < vnOffset[centre + 1]; j++) v[vnList[j]] = 1;
  }

  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < nv; i++) {
      const a = vnOffset[i], b = vnOffset[i + 1], deg = b - a;
      let su = 0, sv = 0;
      for (let j = a; j < b; j++) { su += u[vnList[j]]; sv += v[vnList[j]]; }
      const ui = u[i], vi = v[i];
      const lapU = deg ? su / deg - ui : 0;
      const lapV = deg ? sv / deg - vi : 0;
      const reaction = ui * vi * vi;
      u2[i] = ui + du * lapU - reaction + feed * (1 - ui);
      v2[i] = vi + dv * lapV + reaction - (feed + kill) * vi;
    }
    // Ping-pong rather than writing in place: updating u[i] before its neighbors have read it
    // makes the result depend on vertex ORDER, which would mean the same mesh saved and reloaded
    // could grow a different pattern.
    const tu = u; u = u2; u2 = tu;
    const tv = v; v = v2; v2 = tv;
  }

  // v runs roughly 0..0.4 depending on the regime, so it is normalized against its OWN range
  // rather than a constant: the regimes differ by more than the ramp could absorb, and a preset
  // that came out gray because its chemistry happens to run cool is a preset that looks broken.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nv; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
  const span = hi - lo;
  const out = new Float32Array(nv);
  if (span > 1e-9) for (let i = 0; i < nv; i++) out[i] = ((v[i] - lo) / span) * 2 - 1;
  return out;
}

// ---- the fourth generator: a network that is ROUTED rather than simulated ------------
//
// Noise cannot make a vessel. Vessels branch, taper, merge and never cross, and none of those is
// a property a field of lumps can be shaped into — which is why this is a fourth generator rather
// than a fifth kind. It is also the one thing on the medical-illustration list that nothing else
// here can approximate.
//
// ⚠ NOT A PARTICLE SIMULATION. The published approach for this is space colonisation (Runions et
// al.): scatter attractors, grow a tree toward them, delete attractors the tree reaches. It works,
// and on a surface it needs its own collision handling to stop branches crossing, plus a rule for
// keeping the growth ON the surface. A SHORTEST-PATH FOREST over the mesh's own graph gives the
// same picture for far less, and gets three properties for free rather than by rule:
//
//   1. grow geodesic distance out from a root -> every vertex knows its parent
//   2. pick leaf targets, walk the parents back to the root, counting each vertex on the way
//
// The count IS the calibre. Every leaf drains through the trunk and one leaf through a capillary,
// so tapering falls out of the structure instead of being modeled — which is roughly what
// Murray's law describes. Paths merge as they converge, which is what makes it read as vascular
// rather than as a scatter of lines. And a tree cannot self-cross, so nothing has to prevent it.
// It stays on the surface because it never leaves the graph.
//
// ⚠ A ROOT IN EVERY CONNECTED COMPONENT, and this was measured rather than anticipated. A leaf in
// a shell no root can reach has no parent, so it marks itself and stops — a scatter of unconnected
// single vertices. On a genuine two-shell fixture, 66 of 140 leaves came out as isolated dots:
// vessels on one part and measles on the other, which is exactly what a multi-part import is
// (Pgon's own ecorche fixture is three separated shells). Seeding every component fixes it and is
// also the better anatomy — each separated part gets its own arbor. Verified behavior-preserving:
// on a single connected mesh the output is unchanged.
//
// ⚠ IT ROUTES ON EIGHT DIRECTIONS, NOT FOUR, AND THAT WAS A REPORTED DEFECT. Restricted to mesh
// EDGES, every vertex of a quad mesh offers exactly four directions, so a path cannot go diagonally
// — it staircases along the lattice, and on a quadball that reads as unmistakably rectilinear.
// Reported exactly that way: "dendrites and capillaries look far too rectilinear, not very organic
// at all, are they following the quadball flow?" They were.
//
// Measured as DETOUR — routed length against the great-circle arc it should have followed, where a
// true geodesic is 1.000 and a four-neighbor staircase is bounded by 1.414: the shipped routing
// ran a median 1.190 and a p90 of 1.335, paying a fifth of its length to the grid. Adding each
// quad's two diagonals takes a vertex to eight directions and brings that to 1.030 and 1.062.
//
// A smooth multiplicative jitter on the edge costs was tried first, on the theory that wandering
// lanes would break the alignment. It makes it WORSE — 1.190 to 1.294 — because a cheaper lane
// somewhere else is still reached along the lattice. The problem was never the costs; it was that
// the diagonal did not exist to be taken.
//
// ⚠ ONLY THE ROUTING USES THIS. The reaction diffuses on the true one-ring, because that is a
// physical operator over actual neighbors and a diagonal is not one.
// ⚠ EXPORTED FOR THE CAGE. Its measured value — detour 1.190 to 1.030 — belongs to this one
// implementation; a cage routing on a re-derived copy would be routing on a different graph.
export function withQuadDiagonals(quads, vnOffset, vnList, nv) {
  if (!quads || !quads.length) return { vnOffset, vnList };
  const extra = new Map();
  const add = (a, b) => { let s = extra.get(a); if (!s) { s = new Set(); extra.set(a, s); } s.add(b); };
  for (let q = 0; q < quads.length; q += 4) {
    const a = quads[q], b = quads[q+1], c = quads[q+2], d = quads[q+3];
    add(a, c); add(c, a); add(b, d); add(d, b);
  }
  const off = new Uint32Array(nv + 1), list = [];
  for (let i = 0; i < nv; i++) {
    off[i] = list.length;
    for (let j = vnOffset[i]; j < vnOffset[i+1]; j++) list.push(vnList[j]);
    const e = extra.get(i);
    if (e) for (const u of e) list.push(u);
  }
  off[nv] = list.length;
  return { vnOffset: off, vnList: Uint32Array.from(list) };
}

// The parent chain from the most recent routing. A module-level handoff rather than a return
// value so growVesselNetwork keeps its single-field contract for the callers that only want the
// field; only the gate reads this.
let lastRoute = null;
let lastTube = null;
export const lastVesselTube = () => lastTube;
export const lastVesselRoute = () => lastRoute;

// How far the sulcus control may discount an edge at its own maximum: at gain g the cheapest an
// edge can become is (1 - g) of its true length.
//
// SWEPT, on two grooved spheres — a Gaussian inward crease standing in for an interventricular
// sulcus — reporting the percentage of the routed trunk that lies inside the groove:
//
//   shallow groove, 7.1% of the surface        deep groove, 4.0% of the surface
//   gain  s=0   0.25  0.5   0.75  1.0          gain  s=0   0.25  0.5   0.75  1.0
//   0.50  6.6   6.8   7.2   9.6   11.7         0.50  4.2   5.3   6.7   8.0   9.6
//   0.70  6.6   7.3   9.0   11.8  16.2         0.70  4.2   5.1   7.8   9.7   11.5
//   0.90  6.6   7.2   9.9   14.7  19.5         0.90  4.2   5.4   9.2   9.9   14.7
//
// The response is MONOTONIC to the top of the slider at every gain on both forms, which is the
// property that actually had to hold: a control whose maximum is worse than its three-quarter mark
// argues with itself. 0.80 is chosen one step back from the strongest value measured rather than at
// it — 0.90 leaves an edge at a tenth of its true length, which is a large distortion to carry onto
// forms this was never swept against, and the gain from 0.80 to 0.90 is small.
//
// ⚠ AND A CLAIM THAT DID NOT REPRODUCE, RECORDED SO NOBODY RE-DERIVES IT. A review reported that a
// curvature-blind router already puts 35.4% of its trunk in a groove covering 3.4% of the surface —
// "a concave sulcus is a geodesic shortcut, so Dijkstra finds it for free". On both fixtures above
// the s=0 column sits AT or BELOW the groove's own share of the surface (6.6% against 7.1%, 4.2%
// against 4.0%): no free preference at all. The effect is real but it depends on groove geometry,
// so the honest claim is that this control does the work, not that it merely sharpens something
// already happening.
const SULCUS_GAIN = 0.80;

export function growVesselNetwork(positions, vnOffset0, vnList0, nv, {
  roots = 1, leaves = 110, width = 1.5, seed = 1, quads = null, wander = 0.35,
  sulcus = 0, normals = null,
} = {}) {
  // ⚠⚠ CLEARED FIRST, BECAUSE FOUR EARLY RETURNS BELOW NEVER REACH THE ASSIGNMENT. `lastTube` is a
  // module-level global read back through `lastVesselTube()`, and it is only written on the
  // SUCCESSFUL path. The four degenerate exits — no flow, no sources, no segments, no radius — each
  // return a filled array and leave the previous run's tube standing, so a caller that asks for the
  // tube after a degenerate run is silently handed the tube of whatever ran BEFORE it, which may be
  // a different pattern kind entirely. Clearing here makes a degenerate run report honestly that
  // there is no tube, which is what every caller can actually handle.
  lastTube = null;
  const { vnOffset, vnList } = withQuadDiagonals(quads, vnOffset0, vnList0, nv);
  // ⚠ THE ROUTING COST CARRIES A DETERMINISTIC PER-EDGE JITTER, which the note in
  // withQuadDiagonals says was tried and rejected. That note is not wrong, it is DATED: jitter was
  // measured worse there (path-length ratio 1.190 -> 1.294) at a time when there were no quad
  // diagonals, so the only escape from a straight lattice run was a longer staircase. Diagonals
  // exist now and took that ratio to 1.030.
  //
  // ⚠ WHY IT IS BACK: path LENGTH was never what was wrong. Without the jitter the channels do
  // not look organic at all. A route over a regular quad grid takes
  // the exactly-cheapest lane every time, and on a cube-sphere every lane is a straight axis or
  // diagonal, so a vascular bed comes out as a printed circuit however near-geodesic its lengths
  // are. The jitter breaks the ties that make those lanes exactly equal. It is keyed to the edge's
  // own endpoints and the seed, so a mesh always routes the same way and a saved seed still
  // reproduces its surface exactly.
  //
  // ⚠ HONEST LIMITS OF THE EVIDENCE FOR THIS VALUE. 0.35 was chosen by LOOKING at the rendered
  // result — the channels visibly meander instead of running as straight spokes — and not by a
  // metric. The path-length ratio was NOT re-measured with diagonals plus
  // jitter, so the cost of it is unknown; the earlier 1.190 -> 1.294 figure does not transfer,
  // because the geometry it was measured on no longer exists. An attempt to invent a
  // lattice-alignment metric afterwards gave an ambiguous reading (mean ridge-neighbor degree
  // 3.21 -> 2.96) and is not quoted as support, because a number found after the decision is not
  // evidence for it. If routing quality ever matters more than appearance, measure the ratio first
  // and treat this constant as unproven.
  // ⚠ NOW A PARAMETER, AND ITS DEFAULT IS THE CONSTANT IT REPLACED, so every kind that does not
  // pass one routes byte-identically to before. The comment above already said this value was
  // unproven and chosen by eye; a number nobody can vary is a number nobody can measure, and
  // exposing it is what turns the note above from an apology into a control.
  const JITTER = Math.max(0, wander);

  // ⚠ SULCUS SEEK — MAKE A CONCAVE GROOVE CHEAPER TO TRAVEL, so trunks run along it the way a
  // coronary artery runs the interventricular sulcus instead of draping over the convex belly.
  //
  // ⚠⚠ IT IS A SMALLER FEATURE THAN IT LOOKS, AND THAT IS WORTH SAYING BEFORE ANYONE TUNES IT. A
  // concave groove is a GEODESIC SHORTCUT, so Dijkstra already prefers it for free: measured on a
  // grooved sphere with this switched OFF, 35.4% of the trunk already lies inside a groove covering
  // 3.4% of the surface, at mean standardized curvature 818 against a mesh mean of 6.7. This
  // control moves that to roughly 63%. It is a refinement, not the difference between working and
  // not, and a gate that only asserts "the trunk is in the groove" would pass with it switched off.
  //
  // ⚠⚠ THE CLAMP IS LOAD-BEARING. curvatureBand's unit is an IQR measured over a mostly-smooth
  // form, so ONE deep sulcus is a far-tail outlier — the z-score inside the groove measured 1,426.
  // An unclamped weight (cost *= exp(-sulcus*z*0.8)) saturates instantly and runs BACKWARDS: 35.4%
  // at sulcus 0, 14.9% at 1. This uses Settle's own shape — smoothstep(clamp01(0.5 + 0.5z)) — so a
  // far-tail vertex and a merely-concave one are not separated by six orders of magnitude.
  const sulcusAmt = Math.max(0, Math.min(1, sulcus));
  let curvW = null;
  if (sulcusAmt > 0 && normals) {
    const k = surfaceCurvature(positions, normals, vnOffset0, vnList0, nv);
    const band = curvatureBand(k, nv);
    // No band means no curvature to read — a sphere, a plane. Leaving curvW null routes exactly as
    // before rather than dividing by a unit that does not exist.
    if (band && band.unit) {
      curvW = new Float32Array(nv);
      for (let i = 0; i < nv; i++) {
        const z = (k[i] - band.median) / band.unit;
        curvW[i] = 1 - sulcusAmt * SULCUS_GAIN * smoothstep(clamp01(0.5 + 0.5 * z));
      }
    }
  }

  const elen = (u, v) => {
    const base = Math.hypot(positions[u*3] - positions[v*3],
                            positions[u*3+1] - positions[v*3+1],
                            positions[u*3+2] - positions[v*3+2]);
    const a = u < v ? u : v, b = u < v ? v : u;
    const jittered = base * (1 + JITTER * (hash3(a, b, 0, seed) - 0.5));
    // The cheaper of the two endpoints decides, so an edge ENTERING a groove is already discounted
    // rather than only edges wholly inside one — otherwise the route has to pay full price to reach
    // the thing it is being encouraged toward.
    return curvW ? jittered * Math.min(curvW[u], curvW[v]) : jittered;
  };
  // A binary heap rather than a linear scan: this is Dijkstra over the whole mesh and the
  // difference is the feature being interactive or not.
  const heap = [];
  const hpush = (d, v) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
  };
  const hpop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2*i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };

  // Components first — see the warning above.
  const comp = new Int32Array(nv).fill(-1);
  let nComp = 0;
  for (let i = 0; i < nv; i++) {
    if (comp[i] >= 0) continue;
    const st = [i]; comp[i] = nComp;
    while (st.length) {
      const c = st.pop();
      for (let j = vnOffset[c]; j < vnOffset[c+1]; j++) { const u = vnList[j]; if (comp[u] < 0) { comp[u] = nComp; st.push(u); } }
    }
    nComp++;
  }
  const firstOf = new Int32Array(nComp).fill(-1), sizeOf = new Int32Array(nComp);
  for (let i = 0; i < nv; i++) { if (firstOf[comp[i]] < 0) firstOf[comp[i]] = i; sizeOf[comp[i]]++; }
  const rootIds = [];
  for (let c = 0; c < nComp; c++) {
    // At least one each; anything beyond that is shared out by size, so a large shell can carry
    // several territories and a small one is not handed more roots than it has room for.
    const want = Math.max(1, Math.round(roots * sizeOf[c] / nv));
    for (let r = 0; r < want; r++) {
      let v = firstOf[c];
      for (let t = 0; t < 32; t++) {
        const cand = Math.floor(hash3(r, 101 + c, 5, seed + t) * nv) % nv;
        if (comp[cand] === c) { v = cand; break; }
      }
      if (rootIds.indexOf(v) < 0) rootIds.push(v);
    }
  }

  const dist = new Float64Array(nv).fill(Infinity), parent = new Int32Array(nv).fill(-1);
  for (const r of rootIds) { dist[r] = 0; hpush(0, r); }
  while (heap.length) {
    const [d, v] = hpop();
    if (d > dist[v]) continue;
    for (let j = vnOffset[v]; j < vnOffset[v+1]; j++) {
      const u = vnList[j], w = d + elen(u, v);
      if (w < dist[u]) { dist[u] = w; parent[u] = v; hpush(w, u); }
    }
  }
  // ⚠ EXPOSED FOR MEASUREMENT, and it has to be. The claim worth gating is about the CENTRELINE —
  // whether a path follows the surface or the lattice — and the returned field is the DILATED
  // network, a tube several vertices thick. Walking that tube measures a wander through its own
  // width: on correct code it read 1.754, worse than the staircase bound it was meant to detect.
  lastRoute = { parent, dist, rootIds };

  const flow = new Float32Array(nv);
  for (let k = 0; k < leaves; k++) {
    let v = Math.floor(hash3(k, 3, 7, seed) * nv) % nv, guard = 0;
    while (v >= 0 && guard++ < nv) { flow[v] += 1; v = parent[v]; }
  }
  let maxFlow = 0;
  for (let i = 0; i < nv; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
  if (!maxFlow) return new Float32Array(nv).fill(-1);

  // Width in MEAN EDGES rather than world units, so the same setting means the same thing on a
  // ring and on a figure — the rule Grain already follows.
  let esum = 0, ec = 0;
  for (let i = 0; i < nv; i++) for (let j = vnOffset[i]; j < vnOffset[i+1]; j++) { esum += elen(i, vnList[j]); ec++; }
  const meanEdge = ec ? esum / ec : 1;
  // Log scale: doubling what a vessel drains does not double its width. That is roughly Murray's
  // law and certainly what a drawing shows — a trunk is not thirty times a capillary.
  const lmax = Math.log(1 + maxFlow);
  const radiusOf = (c) => width * meanEdge * (0.6 + 3.4 * Math.pow(Math.log(1 + c) / lmax, 1.5));

  // ⚠ THE TUBE IS MEASURED FROM A SMOOTHED 3D CENTRELINE, NOT BY WALKING MESH EDGES, AND THAT
  // CHANGE IS THE WHOLE REASON THESE STOPPED READING AS CIRCUITRY. Everything above this point
  // routes on the vertex graph, which is correct — topology, calibre and reach all want the
  // surface's own connectivity. What was wrong was the RASTERISATION. Graph distance can only
  // grow along edges, so on a cube-sphere a tube's boundary is confined to the eight lattice
  // directions and comes out serrated however good the route is. ⚠ Two earlier attempts at it —
  // quad diagonals for routing and a cost jitter to break ties — both aimed at the ROUTE, which
  // was never the part that looked wrong.
  //
  // So the skeleton is lifted off the mesh: the parent chain becomes a polyline in space, the
  // polyline is smoothed, and every vertex's field value is its true perpendicular distance to
  // the nearest segment. Distance to a smooth curve is a smooth function, so the boundary is a
  // clean rounded ridge at any mesh resolution, and the calibre can taper continuously ALONG a
  // segment instead of stepping vertex to vertex.
  //
  // ⚠ CANDIDATES ARE STILL FOUND ON THE SURFACE. A pure 3D distance would let a vessel print
  // through a gap onto whatever is geometrically near but topologically far — the far side of a
  // fold, the opposite wall of a tube. The bounded graph walk below is kept for exactly that:
  // it decides WHICH vertices a vessel may touch, and only then is the smooth 3D distance used
  // to decide how strongly. Reach stays geodesic; only the shape of the falloff is Euclidean.
  const skelOf = new Int32Array(nv).fill(-1);
  const skel = [];
  for (let i = 0; i < nv; i++) if (flow[i] > 0) { skelOf[i] = skel.length; skel.push(i); }
  const ns = skel.length;
  if (!ns) return new Float32Array(nv).fill(-1);

  const P = new Float64Array(ns * 3);
  for (let s = 0; s < ns; s++) {
    const v = skel[s];
    P[s*3] = positions[v*3]; P[s*3+1] = positions[v*3+1]; P[s*3+2] = positions[v*3+2];
  }
  const segA = [], segB = [];
  for (let s = 0; s < ns; s++) {
    const p = parent[skel[s]];
    if (p >= 0 && skelOf[p] >= 0) { segA.push(s); segB.push(skelOf[p]); }
  }
  const nseg = segA.length;
  if (!nseg) return new Float32Array(nv).fill(-1);

  // ⚠ TAUBIN, NOT PLAIN LAPLACIAN, AND ON A TREE THE DIFFERENCE IS NOT COSMETIC. Repeated
  // averaging pulls every branch toward the root — a tree has no closed loop to hold it out — so
  // a capillary bed would quietly retract toward its trunk and lose the reach the routing just
  // spent a Dijkstra establishing. The mu pass pushes back out at a slightly larger magnitude,
  // which is the standard shrinkage-free pair.
  const LAMBDA = 0.5, MU = -0.53, SMOOTH_ROUNDS = 3;
  const acc = new Float64Array(ns * 3), cnt = new Uint32Array(ns);
  const relaxStep = (w) => {
    acc.fill(0); cnt.fill(0);
    for (let e = 0; e < nseg; e++) {
      const a = segA[e], b = segB[e];
      for (let k = 0; k < 3; k++) { acc[a*3+k] += P[b*3+k]; acc[b*3+k] += P[a*3+k]; }
      cnt[a]++; cnt[b]++;
    }
    for (let s = 0; s < ns; s++) {
      if (!cnt[s]) continue;
      for (let k = 0; k < 3; k++) P[s*3+k] += w * (acc[s*3+k] / cnt[s] - P[s*3+k]);
    }
  };
  for (let r = 0; r < SMOOTH_ROUNDS; r++) { relaxStep(LAMBDA); relaxStep(MU); }

  // Calibre per skeleton point, so a segment can interpolate between its two ends.
  //
  // ⚠ THE FLOOR IS WHAT KEEPS A THIN VESSEL CONTINUOUS, and without it this rewrite loses the
  // finest twigs outright. Graph distance always put the value 1 on the skeleton vertex itself —
  // d2 is 0 there by construction — so a tube thinner than the mesh still left a mark, just a
  // detached one. That is precisely the reported "why are these essentially dashed": a dotted
  // line of isolated spikes. True perpendicular distance has no such guarantee, and a smoothed
  // centreline sits slightly off the vertices it came from, so a sub-edge calibre now renders as
  // nothing at all. Holding calibre at about three quarters of an edge means a segment's tube
  // always contains both its endpoints, which makes the finest bed a continuous ridge rather than
  // either a dotted line or a gap.
  //
  // ⚠ 1.25 IS THE LARGEST FLOOR THAT STILL LEAVES THE TRUNK NETWORK'S OWN CALIBRE ALONE, which is
  // the criterion, not a tuned taste. Swept against noise_guard G1/G2/G3: at 0.75 and 1.0 the
  // finest twigs still broke into isolated dots (3 in Capillaries, 1 in Dendrites); at 1.25 both
  // reach zero while Vessels' coverage is unmoved at 27.6%, meaning the floor is touching only
  // twigs thinner than the mesh can carry; at 1.5 Vessels itself climbs to 29.3%, so the floor has
  // started overriding calibre the flow actually computed. A floor is allowed to rescue what the
  // mesh cannot resolve and not allowed to redraw what it can.
  const RADIUS_FLOOR = 1.25 * meanEdge;
  const rad = new Float64Array(ns);
  let maxRadius = 0;
  for (let s = 0; s < ns; s++) { rad[s] = Math.max(radiusOf(flow[skel[s]]), RADIUS_FLOOR); if (rad[s] > maxRadius) maxRadius = rad[s]; }
  if (!(maxRadius > 0)) return new Float32Array(nv).fill(-1);

  // Which vertices a vessel may reach, on the surface. One bounded walk to the widest calibre
  // rather than a per-source cap: the exact strength is decided afterwards, so this only has to
  // be a superset, and a superset is cheaper to reason about than a tight bound that could clip a
  // trunk's own shoulder.
  const REACH = maxRadius * 1.35;
  const d2 = new Float64Array(nv).fill(Infinity);
  heap.length = 0;
  for (let s = 0; s < ns; s++) { const v = skel[s]; d2[v] = 0; hpush(0, v); }
  while (heap.length) {
    const [d, v] = hpop();
    if (d > d2[v] || d > REACH) continue;
    for (let j = vnOffset[v]; j < vnOffset[v+1]; j++) {
      const u = vnList[j], w = d + elen(u, v);
      if (w < d2[u] && w <= REACH) { d2[u] = w; hpush(w, u); }
    }
  }

  // A uniform grid over the segments. Cell size is the widest calibre, so a 3x3x3 neighborhood
  // around a point is guaranteed to contain every segment that could still reach it.
  const H = maxRadius;
  // ⚠ AN INTEGER KEY, NOT A TEMPLATE STRING. The query below asks this Map 27 times PER VERTEX, and
  // a `${x},${y},${z}` key builds and hashes a fresh string every one of those times. Measured on a
  // subdivided cube-sphere, whole routing run, against the string-key version on the same mesh and
  // seed: 332.2ms -> 308.8ms at 55,298 vertices (1.08x) and 1013.1ms -> 849.2ms at 221,186 (1.19x).
  // The gain GROWS with density because the cost is per lookup, which is the direction that matters
  // — the ladder goes up, not down. Both fields were compared vertex by vertex and are BYTE-
  // IDENTICAL, which is the only reason a change like this is worth making at all. Three shipped
  // kinds route through here, so this is not new-feature work.
  //
  // ⚠⚠ AND IT GUARDS ITS OWN RANGE, BECAUSE THE FAILURE MODE OF PACKING IS SILENT AND WRONG. Two
  // distinct cells whose packed keys collide would share a bucket and hand back another part of the
  // tube's segments — geometry that is confidently incorrect rather than merely slow. Cell indices
  // are floor(position / maxRadius), so a small radius on a large form pushes them up; anything
  // outside +/-32768 falls back to the string key rather than wrapping. BIAS and SPAN keep the
  // packed value under 2^48, well inside exact integer range.
  const KEY_BIAS = 32768, KEY_SPAN = 65536;
  const inKeyRange = (v) => v >= -KEY_BIAS && v < KEY_BIAS;
  const cellKey = (x, y, z) => (inKeyRange(x) && inKeyRange(y) && inKeyRange(z))
    ? ((x + KEY_BIAS) * KEY_SPAN + (y + KEY_BIAS)) * KEY_SPAN + (z + KEY_BIAS)
    : x + ',' + y + ',' + z;
  const grid = new Map();
  for (let e = 0; e < nseg; e++) {
    const a = segA[e], b = segB[e];
    const x0 = Math.floor(Math.min(P[a*3],   P[b*3])   / H), x1 = Math.floor(Math.max(P[a*3],   P[b*3])   / H);
    const y0 = Math.floor(Math.min(P[a*3+1], P[b*3+1]) / H), y1 = Math.floor(Math.max(P[a*3+1], P[b*3+1]) / H);
    const z0 = Math.floor(Math.min(P[a*3+2], P[b*3+2]) / H), z1 = Math.floor(Math.max(P[a*3+2], P[b*3+2]) / H);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = cellKey(x, y, z);
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push(e);
    }
  }

  // ⚠ THE TUBE IS HANDED OUT SO IT CAN BE DRAWN AT A RESOLUTION THIS MESH DOES NOT HAVE. Everything
  // above is a GRAPH problem — who connects to whom, how much drains through each branch — and it
  // is answered perfectly well on a mesh of a few tens of thousands of vertices. What is below is a
  // GEOMETRY problem, distance to a smooth curve, and it is a continuous function of position with
  // no resolution of its own at all. Keeping them together forced the second to inherit the first's
  // sampling, which is why a network computed at 55k and lifted to 885k looked no sharper than the
  // mesh it was computed on however far the model was subdivided. See vesselFieldAt.
  lastTube = { P, segA, segB, rad, nseg, H, grid, REACH, cellKey };

  return vesselFieldAt(positions, nv, lastTube, d2);
}

// The tube, drawn at whatever resolution the caller has. `reach` is the caller's own gate — the
// bounded surface walk at the resolution the ROUTING was done on, lifted if need be — and it is
// what stops a vessel printing across a gap onto something geometrically near but topologically
// far. The distance itself is exact at every point, which is the whole reason this is separable.
export function vesselFieldAt(positions, nv, tube, reach) {
  const { P, segA, segB, rad, H, grid, REACH } = tube;
  // The SAME key function the grid was built with. Deriving a second one here would be two
  // implementations of one convention, and the day they diverge every lookup misses silently and
  // the tube simply disappears. Older tubes carry no cellKey, so fall back to the original string.
  const cellKey = tube.cellKey || ((x, y, z) => x + ',' + y + ',' + z);
  const out = new Float32Array(nv).fill(-1);
  for (let i = 0; i < nv; i++) {
    if (reach && !(reach[i] <= REACH)) continue;
    const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
    const cx = Math.floor(px / H), cy = Math.floor(py / H), cz = Math.floor(pz / H);
    let best = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(cellKey(cx+dx, cy+dy, cz+dz));
      if (!bucket) continue;
      for (let n = 0; n < bucket.length; n++) {
        const e = bucket[n], a = segA[e], b = segB[e];
        const ax = P[a*3], ay = P[a*3+1], az = P[a*3+2];
        const bx = P[b*3] - ax, by = P[b*3+1] - ay, bz = P[b*3+2] - az;
        const bb = bx*bx + by*by + bz*bz;
        let t = bb > 0 ? ((px-ax)*bx + (py-ay)*by + (pz-az)*bz) / bb : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - (ax + t*bx), qy = py - (ay + t*by), qz = pz - (az + t*bz);
        const d = Math.hypot(qx, qy, qz);
        const r = rad[a] + t * (rad[b] - rad[a]);
        if (r <= 0) continue;
        const val = 1 - d / r;
        if (val > best) best = val;   // smoothed once, after the max — see below
      }
    }
    // ⚠ A CONE HAS A KINK AT ITS RIM AND A KINK IS A VISIBLE CREASE. `1 - d/r` clamped at zero is
    // continuous but its DERIVATIVE is not: it falls at a constant slope and then stops dead at the
    // tube's edge. Displacement turns that into a crease in the surface, normals are computed from
    // the surface, and a crease line crossing a quad grid at an angle shades as a STAIRCASE — which
    // is what "rough even with lots of polys" and "circuit board" were describing. Redrawing the
    // tube at full resolution made the tube sharp and left the kink exactly where it was.
    //
    // smoothstep has zero derivative at both ends, so the tube meets the surface tangentially and
    // domes over its own centreline instead of coming to a ridge. It is applied AFTER the max over
    // segments, not inside it: smoothing each segment first and then taking the max would put a
    // kink back at every place two segments overlap, which is every junction in the network.
    if (best > 0) out[i] = (best * best * (3 - 2 * best)) * 2 - 1;
  }
  return out;
}


// THE PRESETS, AND WHY THEY ARE NAMED FROM MEASUREMENT RATHER THAN FROM MEMORY.
//
// The published Gray-Scott parameter maps are easy to half-remember and the cost of being wrong
// is a preset called Gyri that grows spots. So each pair below was RUN on a real mesh and
// described by three numbers computed from the field itself, and only then named:
//
//   coverage  how much of the surface the pattern covers
//   perimeter what fraction of edges straddle the boundary — how much EDGE per area, which is
//             what separates a maze from round blobs more sharply than coverage ever could
//   blobs     connected components: spots are many, a labyrinth is a handful because it joins up
//
//   F .029 k .057   cov 45%  per 21%  blobs   3   a connected maze            -> Gyri
//   F .014 k .054   cov 15%  per 11%  blobs 103   many small round bumps      -> Villi
//   F .034 k .065   cov  5%  per  4%  blobs  23   sparse isolated dots        -> Follicles
//   F .039 k .058   cov 78%  per 14%  blobs   1   mostly filled, holed        -> Alveoli
//
// The names are suggestive rather than literal, which is the intended register. Two of them are
// worth being honest about on the card: real cortical folding is a mechanical buckling
// instability, not a Turing pattern, and alveoli are not a reaction product either. This is the
// illustrator's version of those forms — the picture, not the mechanism.
//
// The vessel presets are measured the same way and by the same three descriptors, so the two
// generators can be read side by side. `branch/net` is branch points per network vertex — how
// often the tree divides, which is what separates a fine bed from a few big vessels:
//
//   roots 1  leaves 340  width 0.6   raised 46%  branch/net .150  calibre 1..340  -> Capillaries
//   roots 1  leaves 110  width 1.5   raised 29%  branch/net .114  calibre 1..110  -> Vessels
//   roots 6  leaves  90  width 0.7   raised 18%  branch/net .076  several arbors  -> Dendrites
export const GROWN_PATTERNS = {
  gyri:        { gen: 'rd', label: 'Gyri',      feed: 0.029, kill: 0.057, blurb: 'a connected maze — brain, coral, fingerprint' },
  villi:       { gen: 'rd', label: 'Villi',     feed: 0.014, kill: 0.054, blurb: 'many small bumps — intestinal lining, tongue, chorion' },
  follicles:   { gen: 'rd', label: 'Follicles', feed: 0.034, kill: 0.065, blurb: 'sparse isolated dots — follicles, glands, pores' },
  alveoli:     { gen: 'rd', label: 'Alveoli',   feed: 0.039, kill: 0.058, blurb: 'a filled surface eaten into holes — lung, sponge, lacework' },
  // Multi-scale Turing: an activator and an inhibitor at every scale at once, and each point takes
  // the scale that is quietest there. Equal amounts nest blobs inside blobs with fine rings inside
  // them; amounts rising with scale make broad ribbons with concentric striping — rippled plates.
  nested:      { gen: 'turing', label: 'Nested',  amounts: [1, 1, 1, 1],    blurb: 'blobs inside blobs with rings inside them — lichen, a Turing print at every scale at once' },
  ripples:     { gen: 'turing', label: 'Ripples', amounts: [0.25, 0.5, 1, 2], blurb: 'broad ribbons striped with concentric ripples — a rippled plate, water over sand' },
  vessels:     { gen: 'vessel', label: 'Vessels',     roots: 1, leaves: 110, width: 1.5, blurb: 'a branching tree that thickens toward its trunk — arteries, veins' },
  capillaries: { gen: 'vessel', label: 'Capillaries', roots: 1, leaves: 340, width: 0.6, blurb: 'a fine dense bed — capillaries, leaf venation, reticular fibre' },
  dendrites:   { gen: 'vessel', label: 'Dendrites',   roots: 6, leaves: 90,  width: 0.7, blurb: 'several separate arbors — neurons, bronchi, glands' },
  spiral:      { gen: 'wave',   label: 'Spiral',     bandRings: 3, cores: 7, blurb: 'rotating waves winding into spirals — heart muscle, slime mold, BZ reaction' },
};

// One entry point for both generators, so a caller never has to know which is which — the table
// says, and adding a third generator later touches this function and nothing downstream.
//
// ⚠ LEAF COUNT IS SCALED TO THE MESH, and the numbers in the table above are quoted AT THIS
// REFERENCE SIZE. An absolute leaf count means a denser mesh gets a SPARSER network, because the
// same number of paths is spread over more vertices — measured, coverage ran 76% / 54% / 29% /
// 19% across four subdivision levels, a 4x drift for a setting that had not been touched. Scaling
// leaves with vertex count holds it at 31% / 27% / 29% / 39% instead.
//
// Honest about the residual: 1.5x, not 1.0. Coverage is not purely proportional to leaf count —
// vessel width is measured in mean edges, so it shrinks in world terms as the mesh refines while
// the network itself grows — and correcting the rest would mean fitting a curve to four points
// rather than applying a rule. The rule is that leaf DENSITY is what stays constant.
const VESSEL_REF_NV = 6146;
// The app's own working resolution — the default document's top stratum. Used to scale the
// preview's seeding so a swatch is drawn under the conditions the real thing runs under.
const RD_REF_NV = 24578;
export function growPatternField(key, positions, vnOffset, vnList, nv, opts = {}) {
  const { seed = 1, steps = 2000 } = opts;
  const p = GROWN_PATTERNS[key] || GROWN_PATTERNS.gyri;
  if (p.gen === 'vessel') {
    const leaves = Math.max(8, Math.round(p.leaves * nv / VESSEL_REF_NV));
    return growVesselNetwork(positions, vnOffset, vnList, nv, { roots: p.roots, leaves, width: p.width, seed, quads: opts.quads || null });
  }
  if (p.gen === 'wave') {
    // The one-shot form runs the resumable one, because an excitable medium has no closed form
    // and a second copy of the solver is a second place for it to drift.
    const run = createGrowRun(key, positions, vnOffset, vnList, nv, { seed, scale: opts.scale || 1, quads: opts.quads || null });
    run.step(steps);
    return run.field();
  }
  return growReactionDiffusion(vnOffset, vnList, nv, { feed: p.feed, kill: p.kill, steps, seed });
}

// ---- a grow you can watch, and stop when you like it --------------------------------
//
// ⚠ WHY THIS REPLACED A BUTTON THAT RAN TO COMPLETION. A version that simulates for a second or
// two and then applies a finished pattern reads as a button that does not grow anything — the
// natural expectation is that it animates into being. That is the right instinct and such a
// design fights it twice over: nothing moved while it worked, and the amount it applied lived in
// a slider under a DIFFERENT heading, so pressing Grow with that slider at rest did nothing
// visible and said so in a hint most people will never read.
//
// A reaction has no single correct stopping point — it keeps developing, and which moment you
// want is a judgement about how the surface looks. So the run is resumable: the caller advances
// it a few steps per frame, applies the field as it stands, and stops when it looks right. The
// stopping point IS the control, and it is a better one than any number would be.
//
// Both families answer the same interface even though only one of them iterates:
//   * a reaction is stepped, and genuinely changes with every chunk;
//   * a routed network is computed once and then REVEALED outward from its root in order of
//     distance, which is how a vessel bed actually fills, and stopping early leaves a smaller
//     tree rather than a half-drawn one.
// ⚠ `cores` IS AN OPTION, NOT ONLY A PRESET FIELD. A texture whose density cannot be set is a
// demonstration; the request was "options for how big and how to stack them together", which is
// two properties, and for a spiral they are genuinely different — Size sets how wide the arms are,
// this sets how many cores the wave winds around.
// ⚠ `roots` IS THE VESSEL FAMILY'S ANSWER TO "HOW MANY", and it was the difference between two
// presets rather than a control: Vessels and Capillaries are one arbor, Dendrites is six. So the
// thing that most changes how a vascular field PACKS was reachable only by picking a different
// pattern. Same shape as Spiral's cores — the preset supplies a default and the panel can override.
export function createGrowRun(key, positions, vnOffset, vnList, nv, { seed = 1, scale = 1, quads = null, cores: coresOpt = null, roots: rootsOpt = null, sulcus = 0, normals = null, grain = 0, grainDir = 1, levels = 3, mirror = null, mirrorOrigin = [0, 0, 0], density = null } = {}) {
  const spec = GROWN_PATTERNS[key] || GROWN_PATTERNS.gyri;
  let weights = (grain > 0 && normals) ? grainWeights(positions, normals, vnOffset, vnList, nv, { grain, dir: grainDir }) : null;
  // a local density: the Turing blur diffuses through an edge at 1/density² and a reaction's
  // diffusion rate is divided by density² (a weighted mean is blind to a uniform reweighting, so
  // the rate carries it there), so features come out density times smaller — an attractor's
  // pinch on a grown kind
  if (density && spec.gen === 'turing') {
    const dw = new Float32Array(vnList.length);
    for (let i = 0; i < nv; i++) for (let j = vnOffset[i]; j < vnOffset[i + 1]; j++) { const d = 0.5 * (density[i] + density[vnList[j]]); dw[j] = (weights ? weights[j] : 1) / (d * d); }
    weights = dw;
  }
  const partners = mirror && (mirror[0] || mirror[1] || mirror[2]) ? mirrorPartners(positions, nv, mirror, mirrorOrigin) : null;
  if (spec.gen === 'turing') return createTuringRun(spec, positions, vnOffset, vnList, nv, { seed, scale, levels, weights, partners });

  if (spec.gen === 'vessel') {
    const leaves = Math.max(8, Math.round(spec.leaves * nv / VESSEL_REF_NV));
    const full = growVesselNetwork(positions, vnOffset, vnList, nv,
      { roots: Math.max(1, Math.round(rootsOpt != null ? rootsOpt : spec.roots)), leaves, width: spec.width * scale, seed, quads, sulcus, normals });
    // Reveal order: distance from the nearest root, which is already what the forest is built on.
    // Recovered here by walking outward through the network rather than kept from the build, so
    // this needs nothing from growVesselNetwork's internals.
    // ⚠ ONE SEED PER ARBOR, and both halves of that were measured. Seeding every thick vertex made
    // the reveal three rings deep where it needs a hundred, so the first frame already showed the
    // finished network — coverage sat at 31.4% and never moved. Seeding the single global maximum
    // fixed that and broke Dendrites, which is six separate trees: only the one containing that
    // maximum ever grew, and it stalled at 6% of the surface. So each connected piece of the
    // network gets its own seed, at its own thickest point, and they all fill together.
    const order = new Float32Array(nv).fill(Infinity);
    const comp = new Int32Array(nv).fill(-1);
    const bestOf = [];
    for (let i = 0; i < nv; i++) {
      if (comp[i] >= 0 || full[i] <= -1) continue;
      const c = bestOf.length;
      let best = i;
      const st = [i]; comp[i] = c;
      while (st.length) {
        const x = st.pop();
        if (full[x] > full[best]) best = x;
        for (let j = vnOffset[x]; j < vnOffset[x+1]; j++) {
          const u = vnList[j];
          if (comp[u] < 0 && full[u] > -1) { comp[u] = c; st.push(u); }
        }
      }
      bestOf.push(best);
    }
    let frontier = bestOf.length ? bestOf.slice() : [0];
    for (const r of frontier) order[r] = 0;
    let d = 0;
    while (frontier.length) {
      const next = [];
      d++;
      for (const v of frontier) for (let j = vnOffset[v]; j < vnOffset[v+1]; j++) {
        const u = vnList[j];
        if (full[u] > -1 && order[u] === Infinity) { order[u] = d; next.push(u); }
      }
      frontier = next;
    }
    const maxD = d || 1;
    let reached = 0;
    const field = new Float32Array(nv).fill(-1);
    return {
      gen: 'vessel', total: maxD,
      progress: () => Math.min(1, reached / maxD),
      done: () => reached >= maxD,
      step(n) {
        reached = Math.min(maxD, reached + Math.max(1, n));
        for (let i = 0; i < nv; i++) field[i] = order[i] <= reached ? full[i] : -1;
        return field;
      },
      field: () => field,
    };
  }

  // ── an EXCITABLE MEDIUM, stepped (Barkley) ────────────────────────────────────────────────
  //     du/dt = (1/eps) u (1-u) (u - (v+b)/a) + D lap(u)
  //     dv/dt = u - v
  //
  // ⚠ NOT GRAY-SCOTT, AND THAT IS THE WHOLE POINT. Reaction-diffusion makes patterns that SETTLE.
  // A spiral wave needs a medium with a REFRACTORY TAIL — excited, then unexcitable for a while,
  // then ready again — which is what an excitable model has and a reaction-diffusion model does
  // not. The four presets above converge to a still image; this one never stops turning.
  //
  // ⚠⚠ THE INITIAL CONDITION IS THE FEATURE, and two earlier attempts died here.
  //  (1) A FILLED half of the surface at u=1 does exactly nothing — u(1-u) is zero at both 0 and
  //      1, so with a binary field the reaction term vanishes at every vertex and only the
  //      boundary can move. Measured: coverage frozen at its initial value to the last decimal
  //      for 12,000 steps. It looks like a broken solver and it is a degenerate initial state.
  //  (2) A half-LINE of excited cells with nothing behind it does not curl either. A free end
  //      only winds if its trailing side cannot re-excite, so the tail has to be REFRACTORY.
  // What works is all three at once: a narrow excited BAND (the wavefront), loaded v behind it
  // (the tail), and the band BROKEN partway across (the free end). The break is the tip.
  //
  // A SPHERE GIVES A PAIR, and that is topology rather than a quirk of this code. Poincare-Hopf
  // requires the phase singularities on a closed surface to sum to index zero, so the tips come
  // as +1 and -1 and the two spirals counter-rotate. Measured here at every sample from the first
  // step to the twelve-thousandth: exactly 2 tips, +1/-1, total index 0. A run reporting ONE
  // spiral on a closed surface has a broken instrument.
  //
  // MEASURED BEHAVIOR at the shipped constants, on a 3,458-vertex sphere: 13.1 turns over 12,000
  // steps, coverage oscillating between 2.8% and 24.8% without decaying, and a front advancing
  // 1.60 +/- 0.33 per 1,500 steps — steady, where a merely diffusing front would decelerate.
  if (spec.gen === 'wave') {
    // Barkley's standard constants. `a` and `b` set the excitation threshold (v+b)/a, `eps` the
    // ratio of the fast variable's timescale to the slow one — small eps is what makes the front
    // sharp. D is per-step and under 1, so the explicit step is stable on the umbrella Laplacian
    // (which is bounded by 1) without sub-stepping.
    const A = 0.75, B = 0.01, EPS = 0.05, D = 0.20, DT = 0.02;
    let u = new Float32Array(nv), v = new Float32Array(nv);
    // The band is measured in RINGS, not world units: like every diffusion length in this file its
    // feature size is set by how many vertices it crosses, so a denser mesh would otherwise get a
    // proportionally fatter wavefront and a different pattern from the same preset.
    let meanEdge = 0, ne = 0;
    for (let i = 0; i < nv; i++) for (let j = vnOffset[i]; j < vnOffset[i+1]; j++) {
      const k = vnList[j];
      meanEdge += Math.hypot(positions[i*3]-positions[k*3], positions[i*3+1]-positions[k*3+1], positions[i*3+2]-positions[k*3+2]);
      ne++;
    }
    meanEdge = ne ? meanEdge / ne : 0.05;
    const w = (spec.bandRings || 3) * meanEdge * Math.max(0.5, scale);
    // Two orthogonal directions, rotated by the seed so a reroll starts the spiral somewhere else
    // rather than always at the same pole. Their zero-lines cross at two antipodal points, which
    // is where the pair of tips is born.
    // ⚠ MEASURED FROM THE CENTROID, not from the origin. On a sphere the two are the same point
    // and this changes nothing; on the flat lattice the swatch is drawn on — whose coordinates run
    // 0..n rather than straddling zero — an origin-relative break line falls entirely outside the
    // domain, and the whole preview seeds as one uniform refractory sheet that never does
    // anything. One formulation now serves both, instead of the preview needing its own copy of
    // the initial condition to disagree with later.
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < nv; i++) { gx += positions[i*3]; gy += positions[i*3+1]; gz += positions[i*3+2]; }
    gx /= nv; gy /= nv; gz /= nv;
    // ⚠ ONE PAIR OF SPIRALS WAS THE WHOLE PATTERN, AND THAT IS A DEMONSTRATION RATHER THAN A
    // TEXTURE. The construction above crosses two orthogonal zero-lines through the centroid; they
    // meet at two antipodal points and that is where a single pair of counter-rotating tips is born —
    // one pair per form, at any Size, on any mesh, for ever. Rerolling only rotated where it
    // started. It reads as one spiral, sitting in a row of neighbors that all cover the form —
    // where a pattern tool should default to a dense field, or at least offer controls for how big
    // its features are and how they stack.
    //
    // ⚠ AND MANY CORES IS CLOSER TO THE PHYSICS, NOT A COMPROMISE OF IT. An excitable medium seeded
    // at many points is what heart muscle in fibrillation and a BZ dish actually look like; the
    // single pair is the textbook FIGURE, chosen for being legible on a page. So the fix is to seed
    // the same broken-wavefront construction at N scattered points rather than once globally.
    //
    // Each core is a local dipole: an excited arc with a refractory tail immediately behind it,
    // truncated on one side so the front has a FREE END. A free end is what curls; that is the
    // entire trick, and it is the same trick the global version used, applied per site.
    const coreN = Math.max(1, Math.round(coresOpt != null ? coresOpt : (spec.cores != null ? spec.cores : 1)));
    // Fibonacci directions, so the cores are spread evenly however many are asked for and the
    // arrangement is deterministic — a texture you liked comes back with the seed.
    const GA = Math.PI * (3 - Math.sqrt(5));
    for (let c = 0; c < coreN; c++) {
      // A single core reproduces the original construction exactly: the whole form is its cap and
      // the break line passes through the centroid, so nothing about the shipped look changes for
      // anyone who asks for one.
      const single = coreN === 1;
      let dx, dy, dz;
      if (single) { dx = 0; dy = 1; dz = 0; }
      else {
        const yy = 1 - (2 * c + 1) / coreN, r = Math.sqrt(Math.max(0, 1 - yy * yy)), ph = GA * c;
        dx = Math.cos(ph) * r; dy = yy; dz = Math.sin(ph) * r;
      }
      // ⚠ EACH CORE NEEDS ITS OWN FRAME, AND GETTING THIS WRONG COSTS THE WHOLE FEATURE. The first
      // version rotated each core's BREAK line but left the wavefront line as the global y — so
      // every core measured its front from the same global plane and the result was one equatorial
      // band clipped into pieces, not N spirals. It measured as "the field changed" (coverage rose
      // with the count) and rendering the field itself is what showed it: three maps, one band.
      // Two tangents perpendicular to this core's own axis: `t1` carries the wavefront, `t2` is the
      // break. Both are local, so the cores are independent.
      const up = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let t1x = up[1]*dz - up[2]*dy, t1y = up[2]*dx - up[0]*dz, t1z = up[0]*dy - up[1]*dx;
      let tl = Math.hypot(t1x, t1y, t1z) || 1; t1x/=tl; t1y/=tl; t1z/=tl;
      let t2x = dy*t1z - dz*t1y, t2y = dz*t1x - dx*t1z, t2z = dx*t1y - dy*t1x;
      // A per-core turn, so the arms do not all start pointing the same way.
      const th = hash3(seed, 7 + c, 13, seed + c * 31) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const ax = t1x*ct + t2x*st, ay = t1y*ct + t2y*st, az = t1z*ct + t2z*st;   // wavefront axis
      const bx = -t1x*st + t2x*ct, by = -t1y*st + t2y*ct, bz = -t1z*st + t2z*ct; // break axis
      // Cap radius: with many cores each owns roughly its share of the sphere and the arms fill the
      // rest as the wave turns. Too wide and the seeds overwrite each other into one sheet; too
      // narrow and the front is shorter than the band and never curls.
      const capCos = single ? -2 : Math.cos(Math.min(Math.PI * 0.9, 1.6 * Math.sqrt(4 * Math.PI / coreN)));
      for (let i = 0; i < nv; i++) {
        const px = positions[i*3] - gx, py = positions[i*3+1] - gy, pz = positions[i*3+2] - gz;
        const L = Math.hypot(px, py, pz) || 1;
        if (!single && (px*dx + py*dy + pz*dz) / L < capCos) continue;   // outside this core's cap
        const brk = px*bx + py*by + pz*bz;   // the break line: the front exists on one side only
        const fr  = px*ax + py*ay + pz*az;   // across the front, with the refractory tail behind
        if (brk <= 0) continue;              // BROKEN — this is the free end, and the free end is the tip
        if (fr > 0 && fr < w) u[i] = 1;      // the excited band
        else if (fr <= 0) v[i] = 0.9;        // the refractory tail behind it
      }
    }
    const u2 = new Float32Array(nv), v2 = new Float32Array(nv);
    const out = new Float32Array(nv);
    let ran = 0;
    // ⚠ NORMALIZED AGAINST A FIXED RANGE, not against its own min/max like the reaction presets.
    // u genuinely lives in 0..1 here, and rescaling each frame to whatever that frame happened to
    // span would make the arms pulse in depth as the wave went round — an amplitude wobble with
    // no counterpart in the field. The reaction presets need their own range because their
    // chemistry runs at wildly different levels; this one does not.
    const project = () => { for (let i = 0; i < nv; i++) out[i] = u[i] * 2 - 1; return out; };
    return {
      gen: 'wave', total: Infinity,
      progress: () => ran,
      done: () => false,        // it turns forever; the student picks the moment
      step(n) {
        for (let s = 0; s < n; s++) {
          for (let i = 0; i < nv; i++) {
            const lo = vnOffset[i], hi = vnOffset[i+1], deg = hi - lo;
            let su = 0;
            for (let j = lo; j < hi; j++) su += u[vnList[j]];
            const ui = u[i], vi = v[i];
            const lap = deg ? su / deg - ui : 0;
            let nu = ui + DT * (1 / EPS) * ui * (1 - ui) * (ui - (vi + B) / A) + D * lap;
            u2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
            v2[i] = vi + DT * (ui - vi);
          }
          u.set(u2); v.set(v2);
          ran++;
        }
        return project();
      },
      field: project,
    };
  }

  // A reaction, stepped. `scale` is the number of diffusion sub-steps per reaction step: each is
  // the same small stable step, so raising it lengthens how far a substance spreads between
  // reactions — which is what sets the pattern's wavelength — without ever taking a step large
  // enough to blow up. ⚠ Raising the diffusion RATES instead was tried and is not usable: at four
  // times the shipped rates the field dies to nothing (measured, 0% coverage), because an explicit
  // step that large is unstable. Sub-steps buy the same reach and stay stable.
  const sub = Math.max(1, Math.min(RD_MAX_SUBSTEPS, Math.round(scale)));
  const du = 0.16, dv = 0.08, feed = spec.feed, kill = spec.kill;
  // the local diffusion rate from the density: 1/density², never under one native sub-step's
  // worth (1/sub — below it the reaction cannot hold a pattern at this mesh and dies to a blank,
  // measured: an attractor at Scale 12 halved the boundaries instead of doubling them), never
  // past where the explicit step stops being a convex mix
  const rdRate = density ? Float32Array.from(density, (d) => Math.max(1 / sub, Math.min(0.95 / du, 1 / (d * d)))) : null;
  let u = new Float32Array(nv).fill(1), v = new Float32Array(nv);
  let u2 = new Float32Array(nv), v2 = new Float32Array(nv);
  const seedPatches = Math.max(2, Math.round(24 * nv / RD_REF_NV));
  for (let p = 0; p < seedPatches; p++) {
    const c = Math.floor(hash3(p, 0, 0, seed) * nv) % nv;
    v[c] = 1;
    for (let j = vnOffset[c]; j < vnOffset[c+1]; j++) v[vnList[j]] = 1;
  }
  const out = new Float32Array(nv);
  let ran = 0;
  const normalise = () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nv; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    const span = hi - lo;
    if (span > 1e-9) for (let i = 0; i < nv; i++) out[i] = ((v[i] - lo) / span) * 2 - 1;
    else out.fill(-1);
    return out;
  };
  return {
    gen: 'rd', total: Infinity,
    progress: () => ran,
    done: () => false,          // a reaction has no finish line; the student decides
    step(n) {
      for (let s = 0; s < n; s++) {
        for (let d2 = 0; d2 < sub; d2++) {
          for (let i = 0; i < nv; i++) {
            const a = vnOffset[i], b = vnOffset[i+1];
            let su = 0, sv = 0, tw = 0;
            if (weights) { for (let j = a; j < b; j++) { const w = weights[j]; su += w * u[vnList[j]]; sv += w * v[vnList[j]]; tw += w; } }
            else { for (let j = a; j < b; j++) { su += u[vnList[j]]; sv += v[vnList[j]]; } tw = b - a; }
            const k = rdRate ? rdRate[i] : 1;
            u2[i] = u[i] + du * k * (tw ? su / tw - u[i] : 0);
            v2[i] = v[i] + dv * k * (tw ? sv / tw - v[i] : 0);
          }
          let t = u; u = u2; u2 = t; t = v; v = v2; v2 = t;
        }
        for (let i = 0; i < nv; i++) {
          const r = u[i] * v[i] * v[i];
          u2[i] = u[i] - r + feed * (1 - u[i]);
          v2[i] = v[i] + r - (feed + kill) * v[i];
        }
        let t = u; u = u2; u2 = t; t = v; v = v2; v2 = t;
        if (partners) { mirrorField(u, partners); mirrorField(v, partners); }
        ran++;
      }
      return normalise();
    },
    field: normalise,
  };
}
// Measured ceiling: at eight sub-steps Villi dies to nothing, so the control stops before the
// place its own mechanism breaks rather than letting a slider reach it.
const RD_MAX_SUBSTEPS = 6;

// ---- grain and mirror for the grown kinds ------------------------------------------------------
//
// GRAIN is an anisotropic diffusion: each neighbour's share of the average is weighted by how far
// its edge runs along a direction — 1 + grain·(2cos²θ − 1), floored — so a reaction spreads faster
// along the grain than across it and its features stretch that way. The direction is a world axis
// or the form's own axis ('along'), or the circle around it ('around'), projected onto the tangent
// plane at every vertex. At grain 0 every neighbour weighs 1 and this is the plain average.
export function grainWeights(positions, normals, vnOffset, vnList, nv, { grain = 0, dir = 1 } = {}) {
  if (!(grain > 0)) return null;
  let ax = 0, ay = 0, az = 0;
  if (dir === 'along' || dir === 'around') { const a = formAxis(positions, nv); ax = a[0]; ay = a[1]; az = a[2]; }
  else if (dir === 0) ax = 1; else if (dir === 2) az = 1; else ay = 1;
  const w = new Float32Array(vnList.length);
  for (let i = 0; i < nv; i++) {
    const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
    let dx = ax, dy = ay, dz = az;
    if (dir === 'around') { dx = ay * nz - az * ny; dy = az * nx - ax * nz; dz = ax * ny - ay * nx; }
    const dn = dx * nx + dy * ny + dz * nz;
    dx -= nx * dn; dy -= ny * dn; dz -= nz * dn;
    const dl = Math.hypot(dx, dy, dz);
    const lo = vnOffset[i], hi = vnOffset[i + 1];
    if (dl < 1e-6) { for (let j = lo; j < hi; j++) w[j] = 1; continue; }
    dx /= dl; dy /= dl; dz /= dl;
    const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
    for (let j = lo; j < hi; j++) {
      const k = vnList[j];
      let ex = positions[k*3] - px, ey = positions[k*3+1] - py, ez = positions[k*3+2] - pz;
      const el = Math.hypot(ex, ey, ez) || 1;
      const c = (ex * dx + ey * dy + ez * dz) / el;
      w[j] = Math.max(0.05, 1 + grain * (2 * c * c - 1));
    }
  }
  return w;
}
// MIRROR: a symmetric reaction is the reaction averaged with its own reflection every step. The
// partner map is by index (a vertex with no partner within reach is its own), so a form that is
// exactly symmetric comes out exactly symmetric and a sculpted one comes out as symmetric as it is.
export function mirrorPartners(positions, nv, axes, origin = [0, 0, 0], tol = 0) {
  const keep = [];
  for (const ax of [0, 1, 2]) if (axes[ax]) keep.push(ax);
  if (!keep.length) return null;
  let edge = tol;
  if (!(edge > 0)) { let mn = Infinity; for (let i = 1; i < Math.min(nv, 2000); i++) { const d = Math.hypot(positions[i*3] - positions[0], positions[i*3+1] - positions[1], positions[i*3+2] - positions[2]); if (d > 1e-9 && d < mn) mn = d; } edge = mn; }
  const cell = Math.max(1e-9, edge * 2), key = (x, y, z) => `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
  const grid = new Map();
  for (let i = 0; i < nv; i++) { const k = key(positions[i*3], positions[i*3+1], positions[i*3+2]); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); }
  const partners = [];
  const tol2 = (edge * 0.5) ** 2;
  for (const ax of keep) {
    const p = new Int32Array(nv);
    for (let i = 0; i < nv; i++) {
      const m = [positions[i*3], positions[i*3+1], positions[i*3+2]];
      m[ax] = 2 * origin[ax] - m[ax];
      const cx = Math.floor(m[0] / cell), cy = Math.floor(m[1] / cell), cz = Math.floor(m[2] / cell);
      let best = i, bd = tol2;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = grid.get(`${cx + dx}_${cy + dy}_${cz + dz}`); if (!l) continue;
        for (const j of l) { const d = (positions[j*3] - m[0]) ** 2 + (positions[j*3+1] - m[1]) ** 2 + (positions[j*3+2] - m[2]) ** 2; if (d < bd) { bd = d; best = j; } }
      }
      p[i] = best;
    }
    partners.push(p);
  }
  return partners;
}
function mirrorField(f, partners) {
  if (!partners) return;
  for (const p of partners) for (let i = 0; i < p.length; i++) { const j = p[i]; if (j > i) { const m = 0.5 * (f[i] + f[j]); f[i] = m; f[j] = m; } }
}
// one weighted averaging pass over the graph: the blur every grown kind is built from
function blurPass(src, dst, vnOffset, vnList, nv, w) {
  for (let i = 0; i < nv; i++) {
    const lo = vnOffset[i], hi = vnOffset[i + 1];
    let s = src[i], t = 1;
    if (w) { for (let j = lo; j < hi; j++) { s += w[j] * src[vnList[j]]; t += w[j]; } }
    else { for (let j = lo; j < hi; j++) s += src[vnList[j]]; t += hi - lo; }
    dst[i] = s / t;
  }
}
// the multi-scale Turing run: `levels` scales from radius r0 doubling, an activator blurred to the
// radius and an inhibitor to twice it, the variation |a − b| itself blurred; each point steps by the
// amount of its quietest scale, up or down, and the field is renormalised to [−1, 1]
function createTuringRun(spec, positions, vnOffset, vnList, nv, { seed, scale, levels, weights, partners }) {
  const r0 = 0.75 + 0.5 * Math.max(1, Math.min(6, scale));
  const L = Math.max(2, Math.min(4, levels | 0 || 3));
  const radii = []; for (let k = 0; k < L; k++) radii.push(Math.min(16, r0 * Math.pow(2, k)));
  const amounts = radii.map((r, k) => 0.03 * (spec.amounts[Math.min(k, spec.amounts.length - 1)] || 1));
  let u = new Float32Array(nv);
  for (let i = 0; i < nv; i++) u[i] = hash3(i, 0, 0, seed) * 2 - 1;
  const T = new Float32Array(nv), acts = radii.map(() => new Float32Array(nv)), inhs = radii.map(() => new Float32Array(nv)), vars = radii.map(() => new Float32Array(nv));
  const out = new Float32Array(nv);
  let ran = 0;
  // `passes` averaging passes of src, landing in dst (src and dst may be the same array)
  const blurTo = (src, dst, passes) => {
    if (passes <= 0) { if (dst !== src) dst.set(src); return; }
    blurPass(src, T, vnOffset, vnList, nv, weights); dst.set(T);
    for (let p = 1; p < passes; p++) { blurPass(dst, T, vnOffset, vnList, nv, weights); dst.set(T); }
  };
  const project = () => { out.set(u); return out; };
  return {
    gen: 'turing', total: Infinity,
    progress: () => ran,
    done: () => false,
    step(n) {
      for (let s = 0; s < n; s++) {
        let cur = u, done = 0;
        for (let k = 0; k < L; k++) {
          const ra = radii[k], ri = ra * 2;
          blurTo(cur, acts[k], Math.max(1, Math.round(ra * ra - done))); done = Math.round(ra * ra); cur = acts[k];
          blurTo(cur, inhs[k], Math.max(1, Math.round(ri * ri - done))); done = Math.round(ri * ri); cur = inhs[k];
          for (let i = 0; i < nv; i++) vars[k][i] = Math.abs(acts[k][i] - inhs[k][i]);
          blurTo(vars[k], vars[k], Math.max(1, Math.round(ra)));
        }
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < nv; i++) {
          let best = 0, bv = Infinity;
          for (let k = 0; k < L; k++) { const v = vars[k][i]; if (v < bv) { bv = v; best = k; } }
          const d = acts[best][i] - inhs[best][i];
          const x = u[i] + (d > 0 ? amounts[best] : -amounts[best]);
          u[i] = x; if (x < lo) lo = x; if (x > hi) hi = x;
        }
        const span = hi - lo || 1;
        for (let i = 0; i < nv; i++) u[i] = ((u[i] - lo) / span) * 2 - 1;
        mirrorField(u, partners);
        ran++;
      }
      return project();
    },
    field: project,
  };
}

// ---- a small picture of what a pattern actually is ----------------------------------
//
// ⚠ THE PREVIEW RUNS THE REAL GENERATORS, on a square lattice dressed up as a mesh. It would have
// been easier to draw an illustration of each pattern, and that illustration would then be a
// second thing to keep in step — the failure being a swatch that shows a maze while the button
// grows spots, which is worse than no swatch at all because it is believed. A grid with unit
// spacing and four neighbors is a mesh as far as these generators are concerned, so they can be
// called directly and the picture cannot drift from the result.
function gridGraph(n) {
  const nv = n * n, vnOffset = new Uint32Array(nv + 1), list = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    vnOffset[i] = list.length;
    if (x > 0) list.push(i - 1);
    if (x < n - 1) list.push(i + 1);
    if (y > 0) list.push(i - n);
    if (y < n - 1) list.push(i + n);
  }
  vnOffset[nv] = list.length;
  // ⚠ JITTERED, AND THAT IS WHAT STOPS THE VESSEL SWATCHES BEING A LIE. On an exact integer
  // lattice every straight run along an axis or a diagonal is EXACTLY the cheapest path, so the
  // router takes it every time and the network comes out as a starburst of perfectly straight rays
  // — which is nothing like what the same algorithm produces on a real sculpt, where the vertex
  // graph is irregular and no direction is privileged. The swatch was describing the lattice
  // rather than the pattern. It was there at every size and only became legible once the tiles
  // were big enough to see: at 24px it read as vague branching, at 72px as a snowflake.
  // A third of a cell is enough to break the ties without moving any vertex out of its own square,
  // so the graph's connectivity is untouched and only the path COSTS stop being degenerate.
  // Deterministic, from the same hash the rest of this file uses — a swatch must not change
  // between two paints of the same pattern.
  const positions = new Float32Array(nv * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    positions[i*3]     = x + (hash3(x, y, 0, 1717) - 0.5) * 0.66;
    positions[i*3 + 1] = y + (hash3(x, y, 1, 1717) - 0.5) * 0.66;
  }
  // The lattice's own quads, so the preview routes on the same eight directions the real thing does.
  const quads = [];
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    quads.push(y*n + x, y*n + x + 1, (y+1)*n + x + 1, (y+1)*n + x);
  }
  return { nv, vnOffset, vnList: Uint32Array.from(list), positions, quads: Uint32Array.from(quads) };
}

// The grain a journey is effectively at, so its swatch shows the stage you are actually on rather
// than aliasing into speckle at the fine end.
export function journeyGrainAt(t) {
  const u = clamp01(t) * (JOURNEY.length - 1);
  const i = Math.min(JOURNEY.length - 2, Math.floor(u));
  const w = smoothstep(clamp01(u - i));
  return JOURNEY[i].grain + (JOURNEY[i + 1].grain - JOURNEY[i].grain) * w;
}

// How much of the field one swatch shows, in the kind's own sample units. See previewField.
// SWATCH_SPAN is the span AT SWATCH_REF_GRAIN, not a constant: see swatchSpan.
const SWATCH_SPAN = 3, SWATCH_SPAN_FBM = 6;
// The Size slider's shipped default, and the grain every span number in this file was measured at.
// ⚠ IT IS THE VALUE OF THE `value` ATTRIBUTE ON #noiseScale, and if that ever moves this must move
// with it — otherwise every kind's swatch silently changes zoom on a day nobody touched this file.
const SWATCH_REF_GRAIN = 10;
// The Width slider's rest value, and the value at which a swatch draws exactly what it drew before
// previewField took a width at all. It is the `value` attribute on #noiseWidth and it is the same
// number sampleSurfaceField rests `width` at, so the two halves of the app agree at rest by
// construction rather than by two people typing 1.
// ⚠ IT IS ALSO THE NUMBER wallW GUARDS ON. wallW returns a literal 1 when the option is absent OR
// exactly 1, so handing the kinds this value is not merely close to the old behavior, it takes
// the identical branch — which is what makes the default call bit-identical rather than very
// nearly so, and pattern_swatch_width_guard C1 proves it against a reconstructed pre-width module.
const SWATCH_REF_WIDTH = 1;
const FBM_SHAPERS = new Set(['cloud', 'ridged', 'pitted']);

// HOW WIDE A WINDOW ON THE FIELD ONE SWATCH SHOWS, at the grain the pattern is actually set to.
//
// ⚠ IT SCALES WITH THE GRAIN, AND UNTIL THIS EXISTED IT DID NOT. Every kind was drawn over a fixed
// three sample units while each one ships its own default grain — skin 26, bark and timber 16,
// gills 11 — and the Size slider runs 2..48 on top of that. A form shows pi*grain/(2*sqrt(3)) =
// 0.9069*grain sample units across a hemisphere (that is the app's own `scale / diag`, over an arc
// of pi on a unit sphere), so the field's feature size is fixed in SAMPLE units and the number of
// features a form shows is proportional to the grain. A fixed-width tile therefore FREEZES while
// the surface gets finer: measured, `skin` at its shipped 26 was displayed 2.6x coarser than the
// app gives it, and dragging Size from 2 to 48 moved the picture on the button by exactly nothing.
//
// So the tile keeps a CONSTANT SHARE of what a form shows — three units at grain 10, which is
// today's number, and 0.3 * grain everywhere else. That share is 0.3/0.9069 = a third of the
// hemisphere, i.e. still a threefold zoom-in; widening tracks the form and never overshoots it.
//
// ⚠ THE fbm FLOOR IS A FLOOR, NOT A REPLACEMENT AND NOT A MULTIPLIER, and that was measured three
// ways rather than picked. SWATCH_SPAN_FBM exists because `cloud`, `ridged` and `pitted` are plain
// shapers of fbm, which carries its amplitude in its LOWEST octave at a wavelength of one sample
// unit, so a narrow tile cannot sample the distribution it is illustrating. That is a requirement
// in ABSOLUTE sample units and it does not move with the grain — swept on a 96px tile, cloud's
// share of the surface's range at span 6 reads 0.86 / 0.77 / 0.84 / 0.81 / 0.81 at grains
// 4 / 10 / 16 / 26 / 40. Flat. The number that fixes it is the span, not the grain.
//   - REPLACEMENT (a flat 6) fails the thing this whole function is for: at grain 40 the form
//     shows 36 units and the swatch would still be frozen at 6.
//   - MULTIPLIED (0.6 * grain) takes the LOW end below where it starts: grain 4 gives 2.4 units,
//     and cloud's share falls from 0.86 at span 6 to 0.73 at span 3 and lower still under it.
//     A rule that makes the small-Size end worse than today is not a fix.
//   - THE FLOOR keeps 6 wherever the proportional rule is under it (grain <= 20, which is where
//     all three of these kinds ship) and lets the proportional rule take over above that, so the
//     swatch starts tracking Size again exactly when there is enough tile for it to.
// It stays at 6 rather than the plateau: swept on cloud at 96px the share runs 0.77 at six, 0.80
// at twelve, 0.82 at 15.6 and back to 0.79 at 36 — six buys 94% of what is available and the rest
// costs detail, which is the same conclusion the original sweep reached at a smaller tile.
//
// ⚠⚠ AND ONCE IT IS A FLOOR, IT STOPS BEING A SPECIAL CASE — WHICH IS THE MEASUREMENT THAT
// CHANGED THIS FUNCTION'S SHAPE. `fbm` is not the only kind that needs a minimum number of
// features in the tile; it was just the only one whose default grain made it visible. Scored over
// every sampled kind at thirteen grains from 2 to 48 (the slider's real range), the PURE
// proportional rule puts seven readings under the gate's own 0.55 honesty bar — plaques 0.44 at
// grain 2, superposition 0.38 at grain 3, skin 0.46 at grain 4 — because 0.3 * a small grain is a
// tile too narrow to hold the pattern. The SAME rule with today's number kept as a floor puts
// ZERO readings under it, and its over-claiming list is character-for-character the one today
// already has. So the rule is: THE WINDOW MAY ONLY EVER WIDEN. Every kind has a floor, fbm's is
// twice as high, and the proportional term raises it above grain 10 (grain 20 for the fbm three).
//
// ⚠ WHAT THIS DELIBERATELY DOES NOT FIX, so nobody re-finds it as a defect: at grain 2 a form
// shows 1.81 sample units across a whole hemisphere, which is fewer than two of most kinds'
// features, and the tile's floor of 3 is then WIDER than the form's own window — skin reads 2.20,
// pitted 2.45. That is a property of the field at that setting rather than of the picture: at
// Size 2 the form carries about one feature, and no tile can be both a picture of the pattern and
// an honest account of that. It is unchanged from today and it is at the very end of the slider.
export function swatchSpan(key, grain = SWATCH_REF_GRAIN) {
  const g = Number.isFinite(grain) && grain > 0 ? grain : SWATCH_REF_GRAIN;
  const floor = FBM_SHAPERS.has(key) ? SWATCH_SPAN_FBM : SWATCH_SPAN;
  return Math.max(floor, SWATCH_SPAN * g / SWATCH_REF_GRAIN);
}

// Returns an n x n field in -1..1 for any pattern, sampled or grown.
// ⚠ `grain` IS OPTIONAL AND DEFAULTS TO THE SLIDER'S OWN DEFAULT, so every caller that predates it
// keeps the swatch it had. Passing the pattern's CURRENT Size is what makes the picture on the
// button a picture of what the student is about to get; see swatchSpan.
//
// ⚠ `width` IS THE SAME ARGUMENT AGAIN, FOR THE SAME REASON, and it is the second control that was
// changing the surface and moving no swatch. Width scales the wall constants every Worley-distance
// kind carries (see wallW): Cells fattens its bodies, Web closes its net, Plaques softens its
// step. The surface got it and the tile did not, so a student dragging Width watched the form
// change under a row of buttons that all kept insisting the pattern looked like something else.
//
// ⚠⚠ `rake` WAS PASSED IN BY THE CALLER AND NAMED IN NEITHER PLACE, AND THAT IS THE THIRD TIME
// THIS FILE HAS RECORDED THE SAME DEFECT. drawSwatch has handed `rake` to this function since Pile
// shipped; the signature below never destructured it and the literal further down never named it,
// so the argument arrived and stopped. Measured before the fix: the Pile tile is bit-identical
// across the whole travel of the slider — max |field(rake 0) - field(rake 1)| = 0.000000, against
// 1.791161 for `voids` on Aggregate over the same span, which is the control showing the path
// works the moment the name is present. A student dragging Rake watched the form lean under a
// button that kept insisting the cloth stood upright. Its default here is the slider's own 0.55,
// so every swatch at rest is unchanged bit for bit.
//
// ⚠⚠ IT IS PASSED TO EVERY KIND, UNCONDITIONALLY, AND THAT IS NOT AN OVERSIGHT — IT IS THE MATCH.
// The surface path hands `width` to sampleSurfaceField for every kind alike; sampleSurfaceField
// names it on the ONE sampleOpts object every kind is called with, and the kinds that have no wall
// simply never read it. Restricting the swatch to the panel's WALLED_KINDS instead would make the
// tile respond to a narrower set than the form does, and a swatch that is right about seven kinds
// and stale about three is the same defect this change exists to remove, wearing a smaller number.
// Measured on a unit sphere at grain 10, TEN kinds' surfaces move between width 0.4 and 4 — cells,
// web, plaques, tubercles, aggregate, bark, skin, timber, gills and journey — and the tile now
// moves for exactly those ten and for nothing else. pattern_swatch_width_guard A2 asserts that set
// equality by measuring both sides rather than by naming either.
//
// ⚠ AND IT DOES NOT TOUCH THE WINDOW. `width` changes what the field IS at a point; it does not
// change where the tile looks, because the surface's own `freq` does not depend on it either. So
// swatchSpan takes no width and must not — that is the one thing the two halves must NOT share,
// and D2 checks the source for it.
//
// ⚠ A GROWN PATTERN GETS NOTHING FROM IT, deliberately and by the same rule. A grown field arrives
// at the sampler as a per-vertex buffer, the kind function is never called, and `width` reaches
// nothing on the surface — so the grown branch below returns before this ever applies. The
// `width` on GROWN_PATTERNS' vessel presets is a DIFFERENT QUANTITY with the same name (a vessel
// radius in mean edges) and is read off `spec`, never off this option.
export function previewField(key, n = 24, { seed = 7, journey = 0.5, weaveKind = 'plain', roundness = 0.55, rake = 0.55, voids = 0, grain = SWATCH_REF_GRAIN, width = SWATCH_REF_WIDTH, kernel = 'cubic', grid = 1, corners = CELL_DEFAULTS.corners, squareness = CELL_DEFAULTS.squareness, taper = CELL_DEFAULTS.taper, offset = CELL_DEFAULTS.offset } = {}) {
  const g = gridGraph(n);
  const spec = GROWN_PATTERNS[key];
  if (spec) {
    if (spec.gen === 'vessel') {
      // Leaves scale to the lattice the same way they scale to a real mesh, so the swatch has the
      // density the preset actually has rather than a hand-picked one.
      // The preview lattice is a grid of quads too, so it gets the same diagonals and the swatch
      // keeps describing what the real thing does.
      return growVesselNetwork(g.positions, g.vnOffset, g.vnList, g.nv,
        { roots: spec.roots, leaves: Math.max(6, Math.round(spec.leaves * g.nv / VESSEL_REF_NV)), width: spec.width, seed, quads: g.quads });
    }
    // ⚠ SEEDING IS SCALED TO THE LATTICE, and leaving it at the default is what made the first
    // Villi swatch come out BLANK. Gray-Scott is seeded to disturb it into existence, and at a low
    // feed rate too many seeds on a small domain consume everything and the pattern dies: measured
    // on this 576-cell lattice, 24 patches gave Villi 0% coverage and 6 gave 9%. The real mesh is
    // forty times larger, so the same 24 patches are proportionally sparse there and it develops.
    // Scaled against the app's own working resolution, the swatch tracks the result closely —
    // gyri 43% preview against 45.5% real, villi 12% against 11.5%, alveoli 68% against 74.3%.
    // Steps are lower for the same reason the mesh needs more: the pattern is formed long before
    // a full mesh's count on a lattice this size.
    if (spec.gen === 'wave') {
      // The SAME solver the surface runs, on the lattice — not a drawing of a spiral. The step
      // count is what a swatch needs rather than what a sculpt does: far enough for the arms to be
      // legible, and the wave keeps turning past it either way.
      const run = createGrowRun(key, g.positions, g.vnOffset, g.vnList, g.nv, { seed, scale: 1, quads: g.quads });
      run.step(900);
      return run.field();
    }
    if (spec.gen === 'turing') {
      const run = createGrowRun(key, g.positions, g.vnOffset, g.vnList, g.nv, { seed, scale: 1, levels: 3 });
      run.step(40);
      return run.field();
    }
    const seedPatches = Math.max(2, Math.round(24 * g.nv / RD_REF_NV));
    return growReactionDiffusion(g.vnOffset, g.vnList, g.nv, { feed: spec.feed, kill: spec.kill, steps: 2500, seed, seedPatches });
  }
  const shape = NOISE_KINDS[key] || NOISE_KINDS.cloud;
  // ⚠ SUPERSAMPLED 2x. A wall thinner than a pixel does not draw faint, it draws SPECKLE — and
  // speckle reads as a completely different pattern. Measured on the web swatch, which came out
  // as noise at one sample per pixel and as a clean net at four.
  // ⚠ THIS IS A DIFFERENT QUANTITY FROM THE `grain` OPTION and the two must not be confused.
  // `journey` is one kind that sweeps its own frequency along a depth slider; the option above is
  // the Density slider's value, which journey now carries like every other sampled kind. Two
  // different quantities that both scale the window, named apart so a later edit cannot merge them:
  // journeyFreq is which rung of the ladder Depth is on, `grain` is how big that rung comes out.
  const journeyFreq = key === 'journey' ? journeyGrainAt(journey) : 1;
  // ⚠ THE THREE PLAIN-FBM SHAPERS GET A WIDER WINDOW, AND WHICH THREE WAS MEASURED, NOT CHOSEN.
  // The swatch's job is to give an honest account of a field a student is about to put on a form,
  // and there is a number for that: the p01..p99 the tile shows against the p01..p99 the same kind
  // gives on a unit sphere at its own default grain. Seventeen of the twenty kinds land between
  // 0.86 and 1.12 of the surface's range. `cloud`, `ridged` and `pitted` land at 0.65, 0.63 and
  // 0.42 — and those three are exactly the kinds that are a plain shaper of `fbm` and nothing
  // else. fbm carries its amplitude in its LOWEST octave, whose wavelength is one sample unit, so
  // a three-unit tile holds three of them and cannot sample the distribution it is illustrating.
  // The cellular and photographed kinds do not have this problem because their feature size is
  // set by a lattice a good deal finer than one unit.
  // ⚠ SIX, NOT NINE OR TWELVE, and the ceiling is the tile itself rather than a preference. Swept
  // on cloud, the tile's share of the surface's range runs 0.65 at three units, 0.77 at six, and
  // then STOPS — 0.76 at nine, 0.77 at twelve — because past six the fine octaves fall under a
  // pixel and the 2x supersample eats what widening the window just bought. Six is where the two
  // effects cross; anything beyond it costs detail and buys nothing.
  // ⚠ AND IT IS NOT A KNOB THE SWATCH TURNS TO FLATTER ITSELF. Widening moves the tile TOWARD the
  // form, never away: a form shows about nine units of field across a hemisphere at the family
  // grain, so three units was a threefold zoom-in and six is half of one.
  // ⚠ AND THE WINDOW NOW SCALES WITH THE GRAIN THE PATTERN IS SET TO. See swatchSpan for the
  // measurements behind both halves of that number, and for why the fbm widening is a FLOOR.
  // journey is in this rule rather than exempt from it. It had the fixed window while its Density
  // row was hidden and there was no Size for the tile to track; the row is shown now, so the tile
  // scales with it like every other sampled kind — otherwise the picture on the button reports a
  // size the surface no longer has, which is the mismatch this whole argument exists to prevent.
  // At the shipped default grain the window is unchanged: swatchSpan floors at SWATCH_SPAN and
  // SWATCH_SPAN * 10 / SWATCH_REF_GRAIN is SWATCH_SPAN.
  const span = swatchSpan(key, grain);
  const S = span / n / 2 / journeyFreq;
  const out = new Float32Array(g.nv);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let a = 0;
    // ⚠ FACING +Z EXPLICITLY. The lattice carries no normals, and the triplanar kinds would
    // otherwise fall back inside themselves; naming the plane here keeps the swatch showing the
    // same face of the pattern every time rather than depending on a default two files away.
    // ⚠ `width` IS NAMED HERE AND THAT IS THE WHOLE OF WHAT MAKES IT REACH ANYTHING. This object is
    // the only thing the kind functions see, exactly as sampleOpts is on the surface side, and the
    // note over sampleSurfaceField's own sampleOpts records that adding `width` upstream and
    // forgetting that line shipped a slider which moved and changed the surface by zero. The same
    // line, for the same reason, on the swatch's side of the app.
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) a += shape((2*x+sx)*S, (2*y+sy)*S, 0.5, { seed, journey, weaveKind, roundness, rake, voids, width, kernel, grid, corners, squareness, taper, offset }, 0, 0, 1);
    out[y*n+x] = a / 4;
  }
  return out;
}

// ---- where the pattern SETTLES ------------------------------------------------------
//
// A field evaluated at a position treats every part of the surface alike, and almost nothing in
// the world does. Plaques gather in folds; dirt collects in pores; callus and keratin build on
// the parts that get touched, which are the high ones. Weighting the field by local curvature is
// what turns a pattern that was sprinkled evenly over a form into one that looks like it got
// there — and it is the same quantity a cavity map is, arrived at from the mesh rather than a
// render.
//
// Discrete mean curvature by the standard umbrella: how far a vertex sits from the average of its
// own one-ring, measured ALONG ITS NORMAL. Positive where the vertex sits below its neighbors —
// a valley, a crease, the inside of a fold. Negative on a ridge or a peak.
//
// ⚠ DIVIDED BY THE LOCAL EDGE LENGTH SQUARED, and the exponent was measured rather than reasoned.
// The umbrella offset on a smooth surface goes as h^2/2R for edge length h and radius of
// curvature R, so dividing by h leaves h/2R — still proportional to the edge length, and measured
// on this codebase's own cube-sphere it HALVED at every subdivision (-0.04496 at one level,
// -0.02253 at the next, a factor of 2.00). Dividing by h^2 leaves 1/2R, which is curvature: a
// property of the shape, not of how finely it happens to be tessellated. The first version of
// this used h and its gate passed by a hair against a bar that had been set from the number it
// produced — the halving was the real behavior and the check was fitted to it.
export function surfaceCurvature(positions, normals, vnOffset, vnList, nv, out = null) {
  const k = out || new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const s = vnOffset[i], e = vnOffset[i + 1], deg = e - s;
    if (deg === 0) { k[i] = 0; continue; }
    const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
    let cx = 0, cy = 0, cz = 0, len = 0;
    for (let j = s; j < e; j++) {
      const q = vnList[j] * 3;
      const qx = positions[q], qy = positions[q+1], qz = positions[q+2];
      cx += qx; cy += qy; cz += qz;
      len += Math.hypot(qx - px, qy - py, qz - pz);
    }
    const meanEdge = len / deg;
    if (!(meanEdge > 1e-12)) { k[i] = 0; continue; }
    cx = cx / deg - px; cy = cy / deg - py; cz = cz / deg - pz;
    const v = (cx * normals[i*3] + cy * normals[i*3+1] + cz * normals[i*3+2]) / (meanEdge * meanEdge);
    k[i] = Number.isFinite(v) ? v : 0;
  }
  return k;
}

// ⚠ THE RAW NUMBER CANNOT BE THE ONE THE RAMP READS, and measuring it is what showed why. A
// SMOOTH SPHERE reads -0.0221 at the median, not zero — a sphere is convex at every point, so the
// signed curvature carries the whole form's own shape as a DC offset. Ramped against a fixed
// constant, "build on the ridges" would select the entire sphere and "settle in the creases"
// would select none of it, on a form that has neither.
//
// And there is no constant to pick anyway. Measured across four surfaces, the interquartile
// spread of the signed curvature runs from 0.0043 on a smooth sphere to 0.51 on one carrying web
// detail — two orders of magnitude — because it depends on how much detail is there, which is the
// thing the student is about to change.
//
// So it is STANDARDIZED AGAINST THE FORM AS IT STANDS, which is the rule Grain already follows in
// this file for the same reason. The median is subtracted and the interquartile range is the
// unit, so "crease" means concave RELATIVE TO THIS FORM — which is what the word means when a
// student says it, and it holds across subdivision levels and across how much has been sculpted.
// Median and IQR rather than mean and standard deviation deliberately: a few very deep folds
// would drag both of those and quietly rescale everything else.
//
// 1.349 is the IQR of a standard normal, so dividing by it puts the result on roughly the scale
// of a z-score — a closed form, not a tuned number.
// ⚠ EXPORTED so the mask tools read the SAME band Settle does. Two copies of "standardize the
// curvature against the form's own median and IQR" is two chances to drift, and they would drift
// silently — the masks would simply select somewhere slightly different from where the pattern
// settles, with nothing to say why.
export function curvatureBand(k, nv) {
  // Percentiles come from a SAMPLE, not a full sort: at 3.5M vertices sorting the whole buffer to
  // find two percentiles costs more than everything else in this pass put together, and a stride
  // over a mesh gives the same quartiles to far more precision than a ramp needs.
  const STRIDE = Math.max(1, Math.floor(nv / 20000));
  const s = [];
  for (let i = 0; i < nv; i += STRIDE) s.push(k[i]);
  s.sort((a, b) => a - b);
  if (!s.length) return { median: 0, unit: 0 };
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const iqr = at(0.75) - at(0.25);
  // A perfectly flat or perfectly uniform surface has no spread to standardize against. `unit` 0
  // is the signal for that, and the caller then does no weighting at all rather than dividing by
  // something near zero and turning float noise into a pattern.
  return { median: at(0.5), unit: iqr > 1e-9 ? iqr / 1.349 : 0 };
}

// ---- the two multipliers ------------------------------------------------------------
// Neither of these is a kind. Both act on the POSITION before any kind is sampled, so each one
// applies to every kind there is and every kind there will be — which is why they are worth far
// more than their line count. A new kind gets both for free.

// DOMAIN WARP. Sample the field at a point the field has already moved. Uncorrelated noise looks
// uncorrelated — evenly lumpy, going nowhere — and this is the standard cure: it introduces flow,
// so lumps stretch and swirl and gather into currents instead of sitting in a haze. Muscle
// striation, marbling, cortical swirl, wood. Three fbm evaluations, and it is the single largest
// change in character per line in this file.
// The three offsets decorrelate the axes; sampling the same field three times without them would
// displace every point along the diagonal and shear the result rather than warp it.
function warpPoint(x, y, z, o, amt) {
  return [
    x + amt * fbm(x + 17.13, y +  9.27, z +  3.71, o),
    y + amt * fbm(x -  5.39, y + 41.77, z + 11.93, o),
    z + amt * fbm(x + 22.41, y -  7.83, z + 31.29, o),
  ];
}

// Displace a surface by the field, along its own normals, weighted by (1 - mask) exactly as the
// brushes and the deformation sliders are.
//
// `scale` is in FEATURES PER UNIT of the model's own bounding diagonal, not in world units — so
// the same number gives the same visual grain on a ring and on a figure, which is what makes it a
// setting a student can learn rather than a number to re-guess per model.
//
// `warp` and `fibre` are applied to the SAMPLE POSITION, before the kind ever sees it, so every
// kind gets both. At their rest values (0 and 1) neither touches the coordinate at all — guarded
// rather than multiplied through by one, so the shipped defaults are bit-identical to the build
// before they existed and C3's "a slider at rest changes nothing" stays literally true.
// THE FIELD, SAMPLED AT EVERY VERTEX AND WEIGHTED — shared by the two things that read it.
//
// Displacement and tint are the same pattern answering two different questions: how far to push
// the surface, and how much color to leave on it. Writing the sampling twice would mean a kind,
// a warp, a fibre or a settle rule could drift between them, and the way you would find out is a
// student reporting that the tint does not line up with the bumps. So it is computed once, here,
// and returned as "how much this vertex is in the pattern" with the mask and Settle already in it.
//
// Returns values in -1..1 except for the two exceptions recorded above: sign is the field's own
// sign, magnitude is how strongly this
// vertex is in the pattern after weighting.
// Exported so the panel can SHOW the pattern without applying it — see the preview overlay. The
// field is the pattern; everything else in this file is a way of spending it.
export function surfacePatternField(positions, normals, nv, opts = {}, out = null) {
  return sampleSurfaceField(positions, normals, nv, opts, out).field;
}

// Jacobi rotations on a symmetric 3x3, given as the six upper entries. Returns the eigenvalues and
// a matrix whose COLUMNS are the matching eigenvectors. Twelve sweeps is far more than a 3x3 needs
// — it converges in three or four — and costs nothing at the once-per-apply this is called at.
function eig3sym(a00, a01, a02, a11, a12, a22) {
  const a = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pq = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 12; sweep++) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-15) break;
    for (const [p, q] of pq) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
    }
  }
  return { vals: [a[0][0], a[1][1], a[2][2]], vecs: v };
}

// THE FORM'S OWN AXIS — the spindle a form of revolution turns about, measured from its vertices
// rather than assumed to be Y. Returns the unit axis, the centroid it passes through, and the mean
// distance of the vertices from it.
//
// ⚠ IT IS NOT THE LONGEST DIRECTION, AND ON HALF THE FORMS WORTH ASKING ABOUT THAT IS THE WRONG
// ANSWER. A horn's spindle is its longest direction; a mushroom cap's, a shell's or a plate's is
// its SHORTEST. What both have in common is that the two directions ACROSS the spindle are
// interchangeable, so the axis is the eigenvector of the vertex scatter whose OTHER TWO
// eigenvalues are closest to equal — which reads a rod and a disc correctly with one rule and no
// per-form guess. Taking the largest eigenvector instead would hand a cap its own rim.
//
// ⚠ MEASURED ABOUT THE CENTROID, so a form moved off the origin gives the same axis. Reading the
// scatter about the world origin instead makes the answer depend on where the form is standing —
// and every fixture that happens to be centered agrees with the bug.
//
// A form with no axis at all — a sphere, a cube — has no pair of eigenvalues that stands out, and
// whichever the solver reports is as good as any other: there is nothing there for a fibre to line
// up with in the first place.
export function formAxis(positions, nv) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < nv; i++) { cx += positions[i*3]; cy += positions[i*3+1]; cz += positions[i*3+2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
  for (let i = 0; i < nv; i++) {
    const x = positions[i*3] - cx, y = positions[i*3+1] - cy, z = positions[i*3+2] - cz;
    sxx += x*x; sxy += x*y; sxz += x*z; syy += y*y; syz += y*z; szz += z*z;
  }
  const { vals, vecs } = eig3sym(sxx / nv, sxy / nv, sxz / nv, syy / nv, syz / nv, szz / nv);
  let bestK = 0, bestRound = -1;
  for (let k = 0; k < 3; k++) {
    const o1 = Math.abs(vals[(k+1) % 3]), o2 = Math.abs(vals[(k+2) % 3]);
    const hi = Math.max(o1, o2);
    const round = hi > 0 ? Math.min(o1, o2) / hi : 1;
    if (round > bestRound) { bestRound = round; bestK = k; }
  }
  let ax = vecs[0][bestK], ay = vecs[1][bestK], az = vecs[2][bestK];
  const len = Math.hypot(ax, ay, az) || 1;
  ax /= len; ay /= len; az /= len;
  // The mean radius about the axis. It is what the radial mode compresses toward, so it has to be
  // a real measurement of the form and not a constant: it sets the radius at which the angular
  // width of a feature is left alone, and a constant would make the same setting read as a
  // different number of streaks on every form.
  let meanR = 0;
  for (let i = 0; i < nv; i++) {
    const x = positions[i*3] - cx, y = positions[i*3+1] - cy, z = positions[i*3+2] - cz;
    const h = x*ax + y*ay + z*az;
    meanR += Math.hypot(x - h*ax, y - h*ay, z - h*az);
  }
  meanR /= nv;
  return { ax, ay, az, cx, cy, cz, meanR, roundness: bestRound };
}

function sampleSurfaceField(positions, normals, nv, opts, out) {
  const { scale = 8, octaves = 4, roughness = 0.5, kind = 'cloud', seed = 1,
          warp = 0, fibre = 1, fibreAxis = 1, settle = 0, vn = null, mask = null,
          // WHICH DIRECTION FIBRE STRETCHES IN. 'axis' is the world axis fibreAxis names and is
          // the rest value, guarded so a project saved before this existed reloads bit-identically.
          // The other two read the form's OWN axis — see formAxis — because a form of revolution
          // standing at an angle has no world axis to name, and the useful directions on one are
          // along its spindle and out from its pole.
          fibreMode = 'axis',
          // ROTATE turns the sample space, in radians, about one world axis. It rests at 0,
          // where the transform is skipped outright and the field is bit-identical to a build
          // without it. Only offered for kinds that HAVE a direction to turn — see the note at
          // the transform itself.
          rotate = 0, rotateAxis = 1,
          // A pattern that was GROWN rather than sampled arrives here as a per-vertex buffer and
          // stands in for the position function. Everything downstream — the mask, Settle, the
          // displacement, the tint — then treats it exactly like any other field, which is what
          // lets reaction-diffusion inherit all of them without a second pipeline.
          preField = null,
          // ⚠ THE CURVE. A remap of the field VALUE, applied before the field becomes anything —
          // before the mask weight, before Settle, before displacement or protection. Amount is a
          // gain: it multiplies. This REDISTRIBUTES: it decides which values become which, which
          // is a different act and reaches shapes no gain can. A hard step turns packed cells into
          // flat ground with sharp islands standing out of it; crushing the middle turns them into
          // mesas with cracks between; lifting only the top leaves a smooth surface with a few
          // blisters. Same pattern, same seed, same grain.
          //
          // ⚠ AND IT IS THE GENERAL CASE OF THREE KINDS THIS FILE ALREADY SHIPS. cloud is the
          // identity, ridged is 1-2|n| (a peak at zero), pitted is sign(n)n^2 (a flattened S).
          // Those are curves, hardcoded as separate buttons. The card said so before this existed.
          //
          // A LOOKUP TABLE RATHER THAN A CALLBACK, deliberately: this runs once per vertex on
          // meshes into the millions, and a function call across a module boundary per vertex is
          // the kind of cost that turns a slider into a stutter. Sampled over the field's own
          // -1..1 range, so index 0 is the deepest value and the last index the highest.
          curve = null, width = 1, weaveKind = 'plain', roundness = 0.55,
          // ⚠ NAMED HERE AND IN sampleOpts BOTH, or the kind never sees it however far it is
          // threaded from the panel — the failure this file already records three times over.
          rake = 0.55,
          // The fraction of aggregate's cells that come out as a pit rather than a stone. Rests
          // at 0, where the kind skips the term outright.
          voids = 0,
          // Default 0.5 because that is what BOTH the slider ships at and the journey kind's own
          // fallback uses, so an absent value keeps the surface bit-identical to before it was
          // threaded. See the note above sampleOpts for why naming it there is the part that counts.
          journey = 0.5,
          // The lattice the fractal kinds are built on, and whether its cells lie on the world
          // axes. Both rest at the shipped field: 'cubic' and 1.
          kernel = 'cubic', grid = 1,
          // COFFER'S FOUR, and their rest values are the cell module's own defaults rather than a
          // second copy of them here — a shape that ships two sets of defaults is a shape that
          // draws differently on the surface and on the button. See cell/cell.v00000-001.js.
          corners = CELL_DEFAULTS.corners, squareness = CELL_DEFAULTS.squareness,
          taper = CELL_DEFAULTS.taper, offset = CELL_DEFAULTS.offset } = opts;
  const dst = out || new Float32Array(nv);
  const shape = NOISE_KINDS[kind] || NOISE_KINDS.cloud;
  // Guarded on the REST VALUE rather than multiplied through by an identity, the same rule Warp
  // and Fibre follow — so a project saved before the curve existed reloads bit-identically
  // instead of merely very closely.
  const lut = (curve && curve.length > 1) ? curve : null;
  const curved = lut
    ? (n) => {
        const t = (n + 1) * 0.5;
        const u = t < 0 ? 0 : (t > 1 ? 1 : t);
        const f = u * (lut.length - 1);
        const i0 = f | 0;
        const i1 = i0 >= lut.length - 1 ? lut.length - 1 : i0 + 1;
        const sfrac = f - i0;
        return lut[i0] + (lut[i1] - lut[i0]) * sfrac;
      }
    : (n) => n;
  const grown = preField && preField.length === nv ? preField : null;

  // Measured once, from the geometry as it stands. The diagonal is axis-free, so the grain does
  // not change when the form is rotated or when an unrelated axis control is touched.
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) {
    const v = positions[i*3+a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const diag = Math.hypot(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) || 1;
  const freq = scale / diag;
  // Hoisted out of the loop, where it used to be rebuilt for every vertex — one object literal
  // per vertex per apply, on a pass that already runs over millions of them.
  // ⚠ WHAT THE KIND FUNCTIONS ACTUALLY SEE. This object is the only thing handed to them, so an
  // option added to the panel and threaded all the way to surfacePatternField still reaches
  // NOTHING unless it is named here. Adding `width` upstream and forgetting this line produced a
  // slider that moved and changed the surface by exactly zero — a control that changes nothing,
  // measured as 25.6% of the surface raised at both ends of its range.
  // ⚠ weaveKind AND roundness ARE NAMED HERE FOR THE REASON THE NOTE ABOVE GIVES. Adding an
  // option to the panel and threading it as far as this function still reaches NOTHING unless
  // it appears in this object — that is how `width` once shipped as a slider that moved and
  // changed the surface by exactly zero.
  // Hoisted: the directional kinds read it per vertex and the check must not be.
  const hasN = !!(normals && normals.length >= nv * 3);
  // ⚠ `journey` IS THE THIRD OPTION TO NEED THIS LINE, and the two warnings above did not stop it.
  // It was threaded from the panel to this function and named nowhere here, so the kind read
  // `o.journey == null` and took its own 0.5 fallback at every setting of the slider. The swatch
  // moved the whole time, because previewField takes `journey` as its own parameter and never
  // consulted this path — the picture and the surface were reading two different values.
  // ⚠ `kernel` AND `grid` ARE NAMED HERE, and that is the whole of what makes them reach anything.
  // Three controls have shipped inert by being threaded to the sampler and left out of this
  // literal; these two go through `fbm`, which is one more hop, and the rule is unchanged.
  const sampleOpts = { octaves, roughness, seed, width, weaveKind, roundness, journey, rake, voids, kernel, grid, corners, squareness, taper, offset };
  // Computed once from the geometry as it stands, before anything moves — weighting a vertex by a
  // curvature the pass itself has already changed would let the pattern chase its own tail across
  // the surface, and the result would depend on vertex order.
  let curv = null, curvMid = 0, curvUnit = 0;
  if (settle && vn && vn.vnOffset && vn.vnList) {
    curv = surfaceCurvature(positions, normals, vn.vnOffset, vn.vnList, nv);
    const band = curvatureBand(curv, nv);
    curvMid = band.median; curvUnit = band.unit;
    if (!curvUnit) curv = null;   // nothing to standardize against: no weighting, not a divide by ~0
  }
  const settleAmt = curv ? Math.min(1, Math.abs(settle)) : 0;
  const settleSign = settle >= 0 ? 1 : -1;
  // WHERE THE PATTERN SETTLES. `t` is the standardized curvature turned the way the control
  // points — 1 where this vertex is the kind of place asked for, 0 where it is the opposite — and
  // the weight blends between "everywhere" and "only there" by how far the slider is over. At
  // settle 0 it returns exactly 1, so the multiply at the call site is exact.
  // THE POLE THE FIBRE READS, measured once from the geometry and only when the fibre is actually
  // asking for it. Guarded on the mode and on the fibre being off its rest value, so the world-axis
  // path costs exactly what it did before this existed. The centroid and the mean radius are
  // carried into SAMPLE space by the same freq the positions are, since that is where they are used.
  let pole = null;
  if (fibre !== 1 && fibre > 0 && fibreMode !== 'axis' && !grown) {
    const f = formAxis(positions, nv);
    pole = { ax: f.ax, ay: f.ay, az: f.az, around: fibreMode === 'around',
             cx: f.cx * freq, cy: f.cy * freq, cz: f.cz * freq, r0: f.meanR * freq };
  }
  const settleWeight = (i) => {
    if (!settleAmt) return 1;
    const t = smoothstep(clamp01(0.5 + 0.5 * settleSign * ((curv[i] - curvMid) / curvUnit)));
    return 1 - settleAmt + settleAmt * t;
  };

  for (let i = 0; i < nv; i++) {
    const w = mask ? 1 - Math.min(1, Math.max(0, mask[i])) : 1;
    if (w <= 0) { dst[i] = 0; continue; }
    // A grown field is already ON the vertices, so warp and fibre — which act on a SAMPLE
    // POSITION — have nothing to act on and are skipped rather than silently ignored. Settle and
    // the mask below still apply, because those weight a result rather than move a lookup.
    if (grown) { dst[i] = curved(grown[i]) * w * settleWeight(i); continue; }
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    let sx = x * freq, sy = y * freq, sz = z * freq;
    // ⚠ ROTATION COMES FIRST, AHEAD OF FIBRE AND WARP, AND THE ORDER IS THE DECISION.
    // Composed this way the pattern reaches world space as R⁻¹ after S⁻¹, so the fibre's stretch
    // direction and the warp's bending are carried ROUND WITH the pattern and stay attached to it.
    // Rotating last instead would leave both locked to the world axes while the pattern turned
    // underneath them — the stripes would swing but their elongation would go on pointing at Y,
    // which reads as the pattern shearing rather than turning.
    //
    // ⚠ IT IS OFFERED ONLY WHERE IT MEANS SOMETHING. Turning the sample space of an isotropic kind
    // does not read as a rotation at all: it produces a different instance of the same cloud, which
    // is a RESEED wearing a rotation's label — worse than a dead control, because it moves. Measured
    // as gradient-orientation directionality: gills .97, backtrack .76, weave .71, tread .67,
    // ribs .50, timber .43, attention .41, superposition .33, bark .31 — then a gap to julia .14 and
    // everything below, where a reseed shifts the measured orientation 40-80° and proves that
    // orientation was noise. ⚠ A STRUCTURE TENSOR CANNOT MEASURE THIS: it reports one dominant
    // direction, so a weave's two orthogonal families cancel and it scores .007, below cloud.
    if (rotate) {
      const c = Math.cos(rotate), st = Math.sin(rotate);
      if (rotateAxis === 0)      { const b = sy, d = sz; sy = b * c - d * st; sz = b * st + d * c; }
      else if (rotateAxis === 2) { const a = sx, b = sy; sx = a * c - b * st; sy = a * st + b * c; }
      else                       { const a = sx, d = sz; sx = a * c + d * st; sz = -a * st + d * c; }
    }
    // FIBRE stretches the field along one axis by dividing that coordinate: features get longer
    // in that direction and stay the same width across it, which is what a fibre IS. Muscle,
    // collagen, grain. Applied before the warp so the warp then bends the fibres rather than
    // being stretched itself into streaks.
    if (fibre !== 1 && fibre > 0) {
      if (!pole) {
        if (fibreAxis === 0) sx /= fibre; else if (fibreAxis === 2) sz /= fibre; else sy /= fibre;
      } else {
        // The same stretch, read in the form's own frame: the component along its spindle and the
        // part across it, taken about the centroid so a form standing away from the origin
        // stretches about itself rather than about the world.
        const dx = sx - pole.cx, dy = sy - pole.cy, dz = sz - pole.cz;
        const h = dx * pole.ax + dy * pole.ay + dz * pole.az;
        let ux = dx - h * pole.ax, uy = dy - h * pole.ay, uz = dz - h * pole.az;
        let hh = h;
        if (pole.around) {
          // ⚠ THE RADIUS IS COMPRESSED TOWARD THE FORM'S MEAN CIRCLE; THE ANGLE IS NOT DIVIDED.
          // Dividing the angle is the exact stretch and it cannot close: one trip round the form
          // covers 2π/fibre of sample space, the field does not meet itself, and the form wears a
          // meridian seam. Any map with a uniform hoop compression has that seam by construction —
          // its total angle is not 2π. Compressing the radius instead is continuous everywhere,
          // stretches a feature radially by exactly the fibre (dr'/dr = 1/fibre) and leaves its
          // angular width alone at the mean radius, so the features run out from the pole and
          // converge into it: gills, an iris, a sunburst, hair from a crown.
          const r = Math.hypot(ux, uy, uz);
          if (r > 1e-9) {
            const s = (pole.r0 + (r - pole.r0) / fibre) / r;
            ux *= s; uy *= s; uz *= s;
          }
        } else {
          hh = h / fibre;
        }
        sx = pole.cx + ux + pole.ax * hh;
        sy = pole.cy + uy + pole.ay * hh;
        sz = pole.cz + uz + pole.az * hh;
      }
    }
    if (warp) { const p = warpPoint(sx, sy, sz, sampleOpts, warp); sx = p[0]; sy = p[1]; sz = p[2]; }
    // ⚠ THE NORMAL IS PASSED AS EXTRA ARGUMENTS RATHER THAN ON sampleOpts, and deliberately: this
    // runs once per vertex on meshes into the millions, and writing two fields into a shared object
    // per vertex is the kind of cost that turns a slider into a stutter. Every kind that does not
    // want it simply ignores the extra arguments, so nothing else changed.
    const n = shape(sx, sy, sz, sampleOpts, hasN ? normals[i*3] : 0, hasN ? normals[i*3+1] : 0, hasN ? normals[i*3+2] : 1);
    dst[i] = curved(n) * w * settleWeight(i);
  }
  return { field: dst, diag, freq };
}

// MASK — the same field, left as protection instead of as displacement.
//
// ⚠ THIS WAS A COLOR CONTROL AND IS NOW A MASK. The tell is that a tint control invites the
// question of whether it is a mask at all: the mental model a pattern-shaped field invites is a
// STENCIL, not a coat of paint. It is much the
// more useful of the two, because a mask composes with everything the app already does. Pattern
// the mask and every brush, every deformation slider and the noise itself is then scoped to it —
// carve only in the folds, smooth everything except the vessels, inflate between the cells. Paint
// could only ever color.
//
// The mask lives on EVERY stratum, unlike color, which lives on the highest one only. So this
// needs no jump to the top level and works wherever you are on the ladder.
//
// ⚠ `amount` IS SIGNED, and the sign chooses which half of the field is masked rather than
// inverting it: positive protects where the field is high — the same places a positive
// displacement would raise — and negative protects where it is low. That is what lets one set of
// settings give the bumps and a stencil that lines up with them.
//
// ⚠ AND `maskMode` IS THE OTHER HALF OF IT, WHICH IS A DIFFERENT QUESTION FROM THE SIGN. The sign
// chooses WHICH HALF of the field the pattern acts on; the mode chooses whether it protects that
// half or releases it. Without the subtract branch a pattern could only ever add to a mask, so it
// could protect a region and could not cut itself back out of a protection already there — you
// had to clear the mask and rebuild it. 'add' is the rest value and the branch it takes is the
// one that shipped.
export function applySurfaceMask(mask, positions, normals, opts = {}) {
  const { amount = 0, maskMode = 'add' } = opts;
  const nv = positions.length / 3;
  if (!amount) return { masked: 0 };
  const sub = maskMode === 'subtract';
  // ⚠ THE FIELD IS SAMPLED WITHOUT THE MASK IT IS ABOUT TO WRITE. Passing the live mask in would
  // make the pass weight itself by its own output, so a second application would eat its own
  // pattern away — the field must describe the surface, not the stencil being built from it.
  const { field } = sampleSurfaceField(positions, normals, nv, { ...opts, mask: null });
  let masked = 0;
  for (let i = 0; i < nv; i++) {
    const t = Math.min(1, Math.max(0, field[i] * amount));
    if (!(t > 0)) continue;
    // ⚠ SUBTRACT IS A PROPORTION OF WHAT IS THERE, NOT A DIFFERENCE. `mask - t` would drive an
    // already-light protection negative and, clamped, would flatten every value under t to the
    // same zero — so a second pass at a low setting would erase a region a first pass had only
    // thinned. Scaling by (1 - t) is the exact mirror of the add branch's (1 - mask) * t: it
    // reaches 0 only where the pattern is at full strength, is idempotent in the same way, and
    // cannot touch a vertex the pattern does not cover, because t <= 0 there and this loop
    // already skipped it.
    const v = sub ? mask[i] * (1 - t) : mask[i] + (1 - mask[i]) * t;
    if (Number.isFinite(v)) { if (!sub || v !== mask[i]) masked++; mask[i] = v; }
  }
  return { masked };
}

export function applySurfaceNoise(positions, normals, opts = {}) {
  const { amount = 0, out = null, mask = null } = opts;
  const dst = out || positions;
  const nv = positions.length / 3;
  if (!amount) { if (dst !== positions) dst.set(positions); return { moved: 0, unit: 0 }; }

  // THE SAMPLING IS SHARED WITH THE TINT, deliberately. Displacement and tint are one pattern
  // answering two questions, and writing the sampler twice is how a kind, a warp, a fibre or a
  // settle rule drifts between them — the symptom being a student reporting that the color does
  // not sit on the bumps.
  //
  // ⚠ ONE HONEST COST, recorded rather than left to be discovered. Folding the mask and Settle
  // weights into the sampled value changes the ORDER the per-vertex product is multiplied in, and
  // floating-point multiplication is not associative. So noise RE-DERIVED by journal replay now
  // differs from a pre-refactor build in the last bits of the last float — around 1e-16 relative,
  // far below anything a surface can express, and it does not affect a .pgonbank, whose geometry
  // is stored rather than recomputed. The field buffer is Float64Array for the same reason: a
  // Float32 intermediate here would throw away real precision for no gain, since it is consumed
  // immediately and never stored.
  const { field, diag } = sampleSurfaceField(positions, normals, nv, opts, new Float64Array(nv));
  const unit = diag * 0.03;             // full slider moves 3% of the form's size
  let moved = 0;

  for (let i = 0; i < nv; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    const w = mask ? 1 - Math.min(1, Math.max(0, mask[i])) : 1;
    if (w <= 0) { dst[i*3] = x; dst[i*3+1] = y; dst[i*3+2] = z; continue; }
    const d = field[i] * amount * unit;
    const nx = dst[i*3] = x + normals[i*3] * d;
    const ny = dst[i*3+1] = y + normals[i*3+1] * d;
    const nz = dst[i*3+2] = z + normals[i*3+2] * d;
    // A non-finite write can never be undone by a later edit, so it is refused rather than stored.
    if (!Number.isFinite(nx + ny + nz)) { dst[i*3] = x; dst[i*3+1] = y; dst[i*3+2] = z; continue; }
    if (d !== 0) moved++;
  }
  return { moved, unit };
}
