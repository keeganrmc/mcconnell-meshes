// alphas v00000-001 — the third axis of ZBrush's Brush x Stroke x Alpha model.
//
// An ALPHA is a grayscale stamp that multiplies into a brush's falloff: white pushes at full
// strength, black not at all. It is what turns one brush into pores, scales, scratches or
// cracks without writing a new brush for each. ZBrush, Blender (as a brush Texture) and Nomad
// all ship the same idea; Pgon had eight brushes and no way to shape what any of them
// deposited beyond a smooth dome.
//
// EVERY ALPHA HERE IS GENERATED, NOT VENDORED. ZBrush's own alpha library is Maxon's
// copyrighted content and Blender's brush textures are part of its GPL source — neither is
// ours to ship, exactly the call already made for Blender's UI icons. These are
// original procedural generators writing original bitmaps: the ARCHETYPES (skin pores,
// reptile scales, hatching, cracks, ridges) are the genuinely generic vocabulary of surface
// detail, which is not anyone's to own, but not one byte of anyone else's art is copied.
//
// DETERMINISTIC BY CONSTRUCTION. Every generator draws from a seeded xorshift PRNG with a
// fixed per-alpha seed and never touches Math.random(). Two consequences that both matter:
// a gate can assert exact pixel values, and a .pgonbank saved on one machine reproduces the
// same stamp on another without ever storing the bitmap itself.

const SIZE = 128; // per side. Big enough for legible scratches/cracks, small enough that a
                  // bilinear fetch per affected vertex per stroke sample stays free.

// xorshift32. Small, fast, and — the reason it is here rather than Math.random — seedable, so
// every bitmap below is a pure function of its seed.
function makeRng(seed) {
  let x = seed | 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x |= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x |= 0;
    return ((x >>> 0) / 4294967296);
  };
}

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const smoothstep = (t) => t * t * (3 - 2 * t);

// Stamp a soft radial dot, taking the MAX so overlapping dots merge into one blob rather than
// summing into a hard white clip.
function stampDot(buf, cx, cy, r, peak = 1) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(SIZE - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= r) continue;
      const v = peak * smoothstep(1 - d / r);
      const i = y * SIZE + x;
      if (v > buf[i]) buf[i] = v;
    }
  }
}

// A soft-edged line segment, same max-merge rule.
function stampLine(buf, x0, y0, x1, y1, halfWidth, peak = 1) {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stampDot(buf, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, halfWidth, peak);
  }
}

// ---- the generators ----------------------------------------------------------------

// Skin pores. Many small dots of varied radius, biased small — the size distribution is what
// reads as skin rather than as polka dots, so radius is drawn from a cubed uniform.
function genPores(rng) {
  const buf = new Float32Array(SIZE * SIZE);
  for (let n = 0; n < 620; n++) {
    const u = rng();
    const r = 1.2 + 4.5 * (u * u * u);
    stampDot(buf, rng() * SIZE, rng() * SIZE, r, 0.55 + 0.45 * rng());
  }
  return buf;
}

// Hatching / scratches. Near-parallel strokes with jittered angle and length, plus a few
// much finer ones so the result has two scales rather than one uniform comb.
function genScratches(rng) {
  const buf = new Float32Array(SIZE * SIZE);
  const base = -0.62; // radians, the dominant direction
  for (let n = 0; n < 46; n++) {
    const a = base + (rng() - 0.5) * 0.34;
    const len = SIZE * (0.35 + 0.65 * rng());
    const cx = rng() * SIZE, cy = rng() * SIZE;
    const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
    stampLine(buf, cx - dx, cy - dy, cx + dx, cy + dy, 0.7 + 1.5 * rng(), 0.5 + 0.5 * rng());
  }
  for (let n = 0; n < 70; n++) { // the finer second scale
    const a = base + (rng() - 0.5) * 0.5;
    const len = SIZE * (0.1 + 0.3 * rng());
    const cx = rng() * SIZE, cy = rng() * SIZE;
    stampLine(buf, cx - Math.cos(a) * len / 2, cy - Math.sin(a) * len / 2,
                   cx + Math.cos(a) * len / 2, cy + Math.sin(a) * len / 2, 0.6, 0.25 + 0.35 * rng());
  }
  return buf;
}

// Cracks. A random walk that branches — the branching is the whole point, since parallel
// wandering lines read as scratches, not as a fracture.
function genCracks(rng) {
  const buf = new Float32Array(SIZE * SIZE);
  const walk = (x, y, angle, life, width) => {
    while (life-- > 0 && x > -8 && x < SIZE + 8 && y > -8 && y < SIZE + 8) {
      const step = 2 + rng() * 3;
      const nx = x + Math.cos(angle) * step, ny = y + Math.sin(angle) * step;
      stampLine(buf, x, y, nx, ny, width, 1);
      x = nx; y = ny;
      angle += (rng() - 0.5) * 0.7;
      if (width > 0.75 && rng() < 0.06) walk(x, y, angle + (rng() < 0.5 ? 0.9 : -0.9), life * 0.55, width * 0.62);
      width = Math.max(0.5, width * 0.985);
    }
  };
  // Six seeds, not three. Three left the stamp 96% black (measured mean 0.037), so most dabs
  // landed on empty bitmap and did nothing at all — a stamp has to actually carry detail
  // across its whole square, since the brush lands wherever the student puts it.
  for (let n = 0; n < 6; n++) walk(rng() * SIZE, rng() * SIZE, rng() * Math.PI * 2, 110, 1.8);
  return buf;
}

// Reptile scales. Overlapping arcs on a staggered lattice; each row offset by half a cell is
// what makes them interlock instead of forming a grid.
function genScales(rng) {
  const buf = new Float32Array(SIZE * SIZE);
  const cell = SIZE / 5;
  // Rows are pitched at 0.58 of a cell, tighter than the arcs are tall, and the radius is
  // pushed past half a cell — both deliberate. At a 1.0 pitch with r < cell/2 the arcs never
  // touch and the result reads as a row of scallops, not as scales; scales are defined by
  // each one overlapping its neighbors below and to the side.
  const rowPitch = cell * 0.58;
  for (let row = -2; row <= 10; row++) {
    for (let col = -1; col <= 6; col++) {
      const cx = col * cell + (row % 2 ? cell / 2 : 0) + cell / 2;
      const cy = row * rowPitch + cell / 2;
      const r = cell * (0.62 + 0.05 * rng());
      for (let a = 0.1; a <= Math.PI - 0.1; a += 0.04) {
        stampDot(buf, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.75, 1.4, 1);
      }
    }
  }
  return buf;
}

// Parallel ridges. A pure sine, rectified and sharpened — the one alpha here with no
// randomness at all, which makes it the clean control case against the organic ones.
function genRidges() {
  const buf = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = 0.5 + 0.5 * Math.sin((x / SIZE) * Math.PI * 2 * 5);
      buf[y * SIZE + x] = clamp01(Math.pow(v, 2.2));
    }
  }
  return buf;
}

// ---- baked from the pattern library, and the two that survived being flattened -----
//
// THE QUESTION THIS ANSWERS: whether any of the texture images are good candidates to be
// duplicated into alpha brushes. Seventeen kinds live in NOISE_KINDS. TWO of them are here.
// The other fifteen were measured and declined. ⚠ THE REJECTION LIST LIVES IN THE GATE, NOT IN A PLAN DOC:
// `_verify/alpha_pattern_guard.mjs` names every declined kind and re-measures the reason it was
// declined on every run, so if one of them is ever retuned in noise.v00000-001.js until it WOULD
// make a good stamp, the gate says so and re-opens the question instead of a prose list quietly
// going stale.
//
// ⚠ THE SCREEN IS NOT TASTE, IT IS THE SHIPPED FIVE'S OWN SIGNATURE. An alpha is a MARK ON
// EMPTY: measured on the five above, mean coverage runs 0.05-0.36 and the majority of every
// square is at zero. A NOISE kind is a FIELD CENTERED ON ZERO, so mapped v*0.5+0.5 it sits at
// 0.5 nearly everywhere — as a stamp that is not a mark, it is a fill, and a fill accumulated
// over overlapping dabs is a smooth blob. Simulated over a real dab train, the shipped five
// raise the deposit's coefficient of variation to 1.23-1.56x an unstamped stroke's; `cells`
// scores 1.04, `bark` 1.11, `aggregate` 1.06 and `cloud` 1.00. A stamp that measures like no
// stamp is a swatch that teaches a student the control is broken.
//
// ⚠ AND THE ONES THAT FLATTEN BEST ARE THE ONES THAT NEED THIS LEAST. Weave, Tread and Ribs are
// already flat 2D kernels read through `triplanar`, so they survive a plane perfectly — and what
// they are is a COVERING, which the surface field already does seamlessly, over the whole form,
// with no dab repeat. Weave and Tread then fail the screen anyway (1.04 and 1.26 with almost no
// floor); Ribs passes it at 1.61 and is declined for a different reason, that it is Ridges with a
// notch cut in it. Julia is the opposite failure and the sharpest: its filigree is a property of
// the 3D field, a plane slice of it is a solid blob with a fringed edge, and it disperses LESS
// than no alpha at all (0.83). A kind whose character comes from being 3D can look like nothing
// on a flat cut.
//
// Both survivors are baked from the REAL kind rather than reimplemented here. That is the whole
// point of the claim being made — Web the alpha and Web the surface pattern are one structure at
// two scopes, not two drawings of one idea that will drift apart on the next edit.
import { NOISE_KINDS } from '../deform/noise.v00000-001.js';

// Sample a 3D kind on the z = 0.5 plane facing +Z — the same plane and the same explicit normal
// the pattern swatches use (`previewField`), so the button in the Alpha row and the button in
// the Surface panel are showing the same face of the same field.
//
// ⚠ ONE SAMPLE PER PIXEL, AND THAT IS A MEASUREMENT AGAINST THE SWATCH RENDERER'S RULE RATHER
// THAN AN EXEMPTION FROM IT. `previewField` supersamples 2x because a wall thinner than a pixel
// draws as SPECKLE rather than faint — but the quantity that rule is about is the wall's width
// IN PIXELS, and the swatch is 24px across three world units where this is 128px across six.
// Web's walls land about 3.2px wide here. Measured: mean neighbor difference is 0.1005 at one
// sample, 0.0951 at four and 0.0945 at nine, and the three bitmaps are indistinguishable by
// eye — while the cost runs 18ms, 54ms and 122ms, paid at boot because the picker builds every
// preview up front. ⚠ IF THE EXTENTS BELOW ARE EVER RAISED PAST ABOUT 40, a wall falls under a
// pixel and the 2x has to come back.
//
// ⚠ SEEDS ARE SMALL INTEGERS HERE AND HEX WORDS ABOVE, DELIBERATELY. hash3 forms
// `seed * 1274126177` in double precision, so a seed near 2^31 pushes the product past 2^53 and
// its low bits — the ones that decorrelate one alpha from another — are rounded away. Anything
// under about 2^21 keeps the product exact. The xorshift generators above WANT a full 32-bit
// word; these want a small one, and the two conventions sitting side by side is the honest
// signal that they seed different machinery.
function bakeKind(kind, seed, { extent, ...opts }) {
  const shape = NOISE_KINDS[kind];
  const buf = new Float32Array(SIZE * SIZE);
  const S = extent / SIZE;
  const o = { seed, ...opts };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // The kind's -1..1 into a stamp's 0..1. The normalizing gain below then does the rest —
      // it is the same treatment every drawn generator here gets, so a baked stamp is not a
      // second class of alpha with its own arithmetic.
      buf[y * SIZE + x] = clamp01(shape(x * S, y * S, 0.5, o, 0, 0, 1) * 0.5 + 0.5);
    }
  }
  return buf;
}

// WEB — the wall between neighboring cells, which is a CLOSED NET. Nothing in the five above is
// one: Cracks is an OPEN branching fracture leaving 89% of its square black, Scales is a lattice
// of arcs. This tessellates, so the mark carries right across the dab. Dab-train dispersion 1.31,
// between Scratches at 1.35 and Ridges at 1.23 — unremarkable inside the family, which is the
// point.
//
// ⚠ SIX CELLS ACROSS, NOT SIXTY, AND THE APP'S OWN READOUT IS WHY. The Alpha panel already warns
// below 40 points across the brush and the default document measures 21 (alpha_guard E3) — so a
// stamp whose features are finer than about a fifth of the disc cannot be recorded at all.
// Box-averaged down to 16 points across, Web at an extent of 6 still measures 0.733 where the
// shipped Pores measures 0.664; at an extent of 12 it falls to 0.423 and is gone.
function genWeb(_rng, seed) { return bakeKind('web', seed, { extent: 6 }); }

// TUBERCLES — knobs GATHERED, with bare skin between the gatherings. Pores scatters dots
// uniformly; this is the same dot at the same size with an organisation over it, and the
// organisation is the entire difference. Cerebriform: brain, coral, cauliflower curd.
//
// ⚠ TWELVE ACROSS RATHER THAN SIX, BECAUSE THE KIND IS TWO-SCALE AND THE COARSER SCALE IS BIGGER
// THAN THE STAMP. The crest field runs at 0.22x the knob frequency, so at an extent of 5 barely
// one crest period spans the whole square, every knob is on it, and the GATHERING — the only
// thing separating this from packed Worley — is invisible. Measured at this width: an extent of 4
// leaves 34% of the square at the floor and disperses 1.002, which is no stamp at all; 8 gives
// 43.9% and 1.261; 12 gives 56.0% and 1.263. Twelve is where the bare skin is unmistakable and
// the knobs are still coarse enough for a mesh to hold — it survives to 16 points across at
// 1.159, better than any shipped alpha but Cracks.
//
// ⚠ WIDTH 0.8, WHICH IS THE PATTERN LIBRARY'S OWN CONTROL AND NOT A PRIVATE VARIANT. At the
// default width the knobs are soft domes that overlap into a mound: same extent, same seed, it
// disperses 1.170 and sits on the bottom edge of the shipped band. Narrowing them to 0.8
// separates the knobs and takes it to 1.263, with the floor rising 42.9% -> 56.0%.
function genTubercles(_rng, seed) { return bakeKind('tubercles', seed, { extent: 12, width: 0.8 }); }

// ---- the library -------------------------------------------------------------------
// `id: 'none'` carries a null bitmap deliberately rather than an all-white one: the kernel
// then skips alpha sampling entirely and its arithmetic is bit-identical to a build with no
// alpha support at all, which keeps every existing gate green by construction, not by tolerance.
export const ALPHAS = [
  { id: 'none',      label: 'None',      seed: 0,          gen: null },
  { id: 'pores',     label: 'Pores',     seed: 0x51ed2701, gen: genPores },
  { id: 'scratches', label: 'Scratches', seed: 0x1a3f77b5, gen: genScratches },
  { id: 'cracks',    label: 'Cracks',    seed: 0x7c19e42d, gen: genCracks },
  { id: 'scales',    label: 'Scales',    seed: 0x2b60c39f, gen: genScales },
  { id: 'ridges',    label: 'Ridges',    seed: 0x3d8a1147, gen: genRidges },
  // Baked from NOISE_KINDS — same structure as the Surface pattern of the same name, read on a
  // plane. Small seeds on purpose; see bakeKind's note.
  { id: 'web',       label: 'Web',       seed: 20461,      gen: genWeb },
  { id: 'tubercles', label: 'Tubercles', seed: 33107,      gen: genTubercles },
];

const cache = new Map();

// Returns { size, data } or null for 'none'. Built once per id and memoized — a generator is
// a few milliseconds, but it must not run inside a stroke.
export function getAlpha(id) {
  if (!id || id === 'none') return null;
  if (cache.has(id)) return cache.get(id);
  const spec = ALPHAS.find(a => a.id === id);
  if (!spec || !spec.gen) return null;
  // The seed goes in TWICE and the two uses are different machinery: the drawn generators want a
  // full-width xorshift stream, the baked ones want the integer NOISE_KINDS hashes its lattice
  // with. Passing both keeps one seed column in the table above rather than two.
  const data = spec.gen(makeRng(spec.seed), spec.seed);

  // NORMALIZING GAIN, and the reasoning matters because this is a deliberate departure from
  // just multiplying the raw bitmap in.
  //
  // A stamp is mostly black — these run 5% to 36% mean coverage — so feeding it in raw makes
  // every brush dramatically weaker the moment a student picks an alpha. Measured on a real
  // Build stroke without this gain: peak deposit falls ~2.2x and total falls ~6x. Picking
  // "Pores" would read as the brush half-breaking, which is the opposite of what the control
  // is for. An alpha is supposed to change WHERE material lands, not how hard you are pressing.
  //
  // So each alpha carries a gain that brings its PEAK back to roughly parity with an
  // un-stamped stroke. Not 1/mean, which would be a spike generator: Cracks means 0.053, so
  // 1/mean is a 19x multiplier on every white pixel. An inverse square root, capped at 3x,
  // restores peak feel without ever handing the kernel a displacement it was not tuned for
  // (the Strength slider itself already reaches 2.2x, so 3x is inside the range the brush math
  // has always had to survive).
  //
  // TOTAL deposit stays legitimately lower than an un-stamped stroke, and that is correct
  // rather than a shortfall: a sparse stamp genuinely covers less of the disc. Only the
  // apparent strength is restored, not the coverage.
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  const gain = mean > 0 ? Math.min(3, 1 / Math.sqrt(mean)) : 1;

  const built = { size: SIZE, data, mean, gain };
  cache.set(id, built);
  return built;
}

// Bilinear fetch. u,v in [0,1]; anything outside returns 0 so a stamp can never bleed past
// its own square. Hot path: called once per affected vertex per stroke sample.
export function sampleAlpha(alpha, u, v) {
  if (!alpha) return 1;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const n = alpha.size, d = alpha.data;
  const fx = u * (n - 1), fy = v * (n - 1);
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < n ? x0 + 1 : x0, y1 = y0 + 1 < n ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const a = d[y0 * n + x0], b = d[y0 * n + x1], c = d[y1 * n + x0], e = d[y1 * n + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}

// Small preview bitmap for the picker UI — returns an ImageData-ready RGBA Uint8ClampedArray
// at the alpha's own resolution. Kept here rather than in index.html so the UI never has to
// know how an alpha is stored.
export function alphaPreviewRGBA(id) {
  const alpha = getAlpha(id);
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = alpha ? Math.round(alpha.data[i] * 255) : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { size: SIZE, rgba: out };
}
