// Mask operations — grow, shrink, and masks derived from the form's own curvature.
//
// Scope: grow and shrink buttons for the mask, plus masks derived by cavity and by curvature,
// following ZBrush's set (which also has mask by depth and mask by smooth — see below).
//
// ⚠ MASK BY SMOOTH IS NOT HERE, AND THAT IS DELIBERATE. The Mask mode's **Blur** button already
// calls `maskPass.blur` on the one-ring — the same formula, already shipped and already gated.
// Adding a second button for it would be two features running one formula, which is a defect this
// codebase has a name for. If "By Smooth" is wanted as a NAME, rename Blur; do not build it twice.
//
// ⚠ MASK BY DEPTH IS NOT HERE EITHER, for a different reason: it is the only one of the five that
// needs the camera, so it belongs where the view matrix lives rather than in a geometry module
// that can be tested without a browser.
//
// ⚠⚠ CAVITY AND CURVATURE ARE NOT THE SAME BUTTON TWICE, and the difference is the whole reason
// both exist: **cavity is SIGNED and curvature is UNSIGNED.** Cavity selects concavities — the
// pits, the creases, the places dirt collects, which is what ZBrush's Mask By Cavity is for.
// Curvature selects ANY departure from flat, so it takes the ridges too. On a form with a groove
// and a ridge, cavity marks the groove alone; curvature marks both. If a change ever makes them
// agree, one of the two buttons has become decorative.
//
// ⚠⚠ A DEADBAND IS REQUIRED, NOT OPTIONAL, and the fixture proved it. With softness alone and no
// threshold, Mask By Curvature read **0.352 on an UNTOUCHED sphere** — because a sphere is convex
// everywhere, so its standardized curvature is spread around the median rather than sitting at it.
// A mask that grays a third of a smooth ball is not selecting features, it is selecting the model.
// `threshold` is a deadband in standardized units: nothing is selected below it, and `softness` is
// the ramp above it. Both are in units of the form's OWN spread, so they mean the same thing on a
// ball and on a scan.
//
// ⚠ STANDARDIZED AGAINST THE FORM'S OWN MEDIAN AND IQR, never against a fixed threshold. A smooth
// sphere reads about -0.022 rather than 0, because a sphere is convex everywhere and raw curvature
// carries the form's DC offset; and the spread runs from 0.004 to 0.51 as detail is added. A
// constant would select everything or nothing depending on which model you tried it on. The band
// is computed by the CALLER, using the app's existing curvature path, and passed in — so this
// module and Settle cannot drift apart by each keeping their own copy of the same idea.

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (t) => t * t * (3 - 2 * t);

// GROW and SHRINK — move the mask edge outward or inward by a real DISTANCE across the surface.
//
// ⚠ THIS WAS A RING WALK AND IT MADE RECTANGLES OUT OF EVERYTHING. Taking the max over the 1-ring
// and repeating it N times is a morphological dilation by the SHAPE OF THAT RING, and on a
// subdivision quad mesh the ring is four or eight grid neighbors — so N presses grow a diamond or
// a square, aligned to the parametric grid, whatever shape the mask started as, with stair-stepped
// edges that are the polygon's own sides. It is not a rounding error or a resolution problem;
// repeated dilation by a small structuring element converges to that element's shape, never to a
// disc.
//
// The fix is to dilate by a BALL of the surface metric instead: distance to the nearest masked
// vertex, measured along real edge lengths, thresholded at the radius. The grid then has no say in
// the outcome, so a blob grows into a bigger blob and a stroke into a fatter stroke.
//
// ⚠ AND IT FIXES THE SECOND HALF OF THE SAME DEFECT. A ring walk has no notion of how far it
// has gone, so the step it takes depends on the subdivision level — the reason the caller had to
// convert a distance into a ring count and cap it at 24. A radius IS the quantity that matters,
// so one press moves the edge by the same amount of form at every density, with nothing to convert.
//
// APPROXIMATION, STATED: a vertex takes the value of the NEAREST masked vertex within the radius
// rather than the maximum over every masked vertex within it. For a painted mask — which is what
// this operates on — the two agree wherever the mask is locally flat, and they differ only where a
// lower-valued source sits closer than a higher-valued one. A true max-dilation needs a pass per
// distinct value and is not worth it here; say so rather than imply exactness.
function distanceField(mask, vnOffset, vnList, nv, radius, positions, pick) {
  // dist[] to the nearest SOURCE, and the value that source carried.
  //
  // ⚠ FLOAT64, AND THE REASON IS NOT PRECISION FOR ITS OWN SAKE. The heap holds float64 keys; a
  // Float32Array ROUNDS what it stores. So the staleness test `d > dist[i]` — comparing the exact
  // key against the rounded store — fired for any vertex whose distance rounded DOWN, and those
  // vertices were skipped as stale without ever expanding. MEASURED against a plain O(V^2)
  // Dijkstra on the same mesh: 21 vertices reached instead of 61, and a grow that stopped at 0.109
  // of the 0.25 radius it was given. Every assertion still passed — the patch was round, it just
  // was not the right SIZE — which is exactly why the gate had to measure the reach as well.
  const dist = new Float64Array(nv).fill(Infinity);
  const val = new Float32Array(nv);
  // WHICH source each reached vertex came from. Needed because the accept test is a straight-line
  // distance to that source, not the summed path length — see the note on dilate.
  const src = new Int32Array(nv).fill(-1);
  // A binary heap keyed on distance. Bounded by the radius, so the frontier is only the band
  // around the mask edge — this stays cheap on a million-vertex stratum because almost nothing
  // outside that band is ever pushed.
  const heapD = [], heapI = [];
  const push = (d, i) => {
    heapD.push(d); heapI.push(i);
    let c = heapD.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapD[p] <= heapD[c]) break;
      const td = heapD[p]; heapD[p] = heapD[c]; heapD[c] = td;
      const ti = heapI[p]; heapI[p] = heapI[c]; heapI[c] = ti;
      c = p;
    }
  };
  const pop = () => {
    const topI = heapI[0], topD = heapD[0];
    const lastD = heapD.pop(), lastI = heapI.pop();
    if (heapD.length) {
      heapD[0] = lastD; heapI[0] = lastI;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heapD.length && heapD[l] < heapD[m]) m = l;
        if (r < heapD.length && heapD[r] < heapD[m]) m = r;
        if (m === c) break;
        const td = heapD[m]; heapD[m] = heapD[c]; heapD[c] = td;
        const ti = heapI[m]; heapI[m] = heapI[c]; heapI[c] = ti;
        c = m;
      }
    }
    return { d: topD, i: topI };
  };
  for (let i = 0; i < nv; i++) {
    if (!pick(mask[i])) continue;
    dist[i] = 0; val[i] = mask[i]; src[i] = i; push(0, i);
  }
  while (heapD.length) {
    const { d, i } = pop();
    if (d > dist[i]) continue;           // a stale heap entry
    if (d >= radius) continue;           // nothing beyond the ball can matter
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
    for (let e = vnOffset[i]; e < vnOffset[i + 1]; e++) {
      const n = vnList[e];
      const w = Math.hypot(positions[n * 3] - px, positions[n * 3 + 1] - py, positions[n * 3 + 2] - pz);
      const nd = d + w;
      if (nd < dist[n] && nd <= radius) { dist[n] = nd; val[n] = val[i]; src[n] = src[i]; push(nd, n); }
    }
  }
  return { dist, val, src };
}

// ⚠⚠ THE WALK MEASURES PATH LENGTH; THE ACCEPT TEST MUST NOT. Summing edge lengths along the
// shortest path is NOT the distance across the surface — on a subdivision quad mesh every vertex
// has four neighbors, so reaching a diagonal costs about sqrt(2) more than reaching along the
// grid, and a ball grown by path length comes out a DIAMOND. Measured, growing from a single seed
// on the boot sphere: the grown patch reached 94 vertices with an outline anisotropy of 2.221,
// against 134 vertices and 1.173 for a true ball of the same radius measured by the same
// instrument. That is the grid-shaped mask users report, and it survived the earlier move from a
// ring walk to this Dijkstra because only the UNIT changed — rings to meters — while the shape
// still came from the connectivity.
//
// So connectivity decides only WHAT IS REACHABLE, which is the part it is right about: it stops a
// mask leaping across a gap to the other lip of a crease that happens to be close in space. The
// radius is then applied as a STRAIGHT-LINE distance to the source the path came from, which no
// grid direction can bias. WALK_SLACK is what makes the two agree: a path may be up to about
// sqrt(2) longer than the straight line it spans on a quad grid, so the walk has to run past the
// radius or the diagonals get cut off before the accept test ever sees them.
//
// SWEPT, NOT GUESSED, against a true ball of the same radius on the boot sphere:
//     1.5 -> 146 of 155 vertices, anisotropy 1.372
//     1.8 -> 155 of 155, anisotropy 1.139 — EXACTLY the true ball, which reads 1.139 itself
//     2.2 -> 155 of 155, 1.139        3.0 -> 155 of 155, 1.139
// It plateaus at 1.8 and costs nothing to sit past that: 8.8ms at 1.5 against 9.2ms at 3.0, because
// the heap is still bounded by the frontier band and almost nothing outside it is ever pushed. So
// 2.0 rather than 1.8 — the value is chosen INSIDE the plateau rather than at its edge, since sqrt(2)
// is only the worst case for a PERFECT quad grid and a real mesh has extraordinary vertices where
// the ratio runs higher. A bound that is comfortably slack costs a slightly wider search; one that
// is exactly tight silently clips diagonals on the next form that is not a sphere.
const WALK_SLACK = 2.0;

// ⚠⚠⚠ THE NEAREST SOURCE'S VALUE IS THE WRONG VALUE, AND ON A PAINTED MASK IT IS ALWAYS THE WRONG
// ONE. This took each new vertex the value of the NEAREST masked vertex — and the nearest masked
// vertex to anything outside a painted mask is on its FADED RIM, where the value is almost zero.
// So Grow propagated zeros outward. Measured on a real painted mask, ten presses:
//     vertices actually protected (>0.5) ..... 361 -> 361 -> 361 -> 361   (it never moved)
//     vertices carrying some value ........... 847 -> 1431 -> 3661 -> 9654
//     of those, below 0.05 ................... 378 -> 962 -> 3192 -> 9185
//     mean value of the band ................. 0.129 -> 0.076 -> 0.030 -> 0.011
// Two faults from one line. The feature does not do its job — the protected region is exactly
// where it was — and every press smears a wider, fainter haze whose frontier is ragged, which on a
// dense sculpted form draws as scattered grid-aligned dashes. Reported as "it was smooth, then
// these little bars when I hit grow ... like barcodes in the selection".
//
// ⚠ THE OLD NOTE SAW THIS AND UNDERSTATED IT. It said the nearest-source rule and a true max
// "differ only where a lower-valued source sits closer than a higher-valued one" — which sounds
// like an edge case and is in fact EVERY frontier vertex of every soft mask, because a rim is by
// construction the lowest-valued part of the mask nearest to the outside.
//
// GROWING A MASK MEANS MOVING ITS PROFILE OUT, so the band has to take the value of the plateau it
// extends: a true grayscale dilation, max over the sources within the radius. That is done as one
// hard dilation per LEVEL and the levels are derived from the mask itself, which is what keeps it
// cheap where it was already right: an all-or-nothing mask has ONE level and costs exactly one
// pass, byte for byte the behavior this shipped with. A painted one costs up to LEVELS passes,
// each bounded to the same thin frontier band.
const LEVELS = 12;

export function dilate(mask, vnOffset, vnList, nv, radius, positions) {
  const out = Float32Array.from(mask);
  let hi = 0, lo = Infinity, soft = false;
  for (let i = 0; i < nv; i++) {
    const v = mask[i];
    if (v <= 0) continue;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  if (hi <= 0) return out;                       // nothing masked: nothing to grow
  // ⚠ A FLOOR UNDER THE LOWEST LEVEL, OR THE FIX MAKES THE SYMPTOM WORSE. A painted mask has a
  // long tail of all-but-zero values at the very edge of the brush, and dilating THAT level paints
  // the whole radius band with about 0.002 — measured, one press went from 962 vertices under 0.05
  // to 54,074, which is the haze this change exists to remove, larger. A value that far down
  // protects nothing and is not worth carrying outward, so growth starts at 5% of the mask's own
  // peak and nothing below that is written. The step this leaves at the outer edge is 5% of the
  // mask, which is under what the dimming can show.
  lo = Math.max(lo, hi * 0.05);
  soft = hi - lo > 1e-4;
  const r2 = radius * radius;
  const n = soft ? LEVELS : 1;
  for (let k = 1; k <= n; k++) {
    // Descending, so the highest level claims its band first and cheaper levels only fill what is
    // left. `>=` with a small tolerance because these are Float32 values off a painted mask.
    const level = soft ? lo + (hi - lo) * ((n - k) / (n - 1 || 1)) : hi;
    const { src } = distanceField(mask, vnOffset, vnList, nv, radius * WALK_SLACK, positions, (m) => m >= level - 1e-6);
    for (let i = 0; i < nv; i++) {
      const sIdx = src[i];
      if (sIdx < 0 || out[i] >= level) continue;
      const dx = positions[i * 3] - positions[sIdx * 3];
      const dy = positions[i * 3 + 1] - positions[sIdx * 3 + 1];
      const dz = positions[i * 3 + 2] - positions[sIdx * 3 + 2];
      if (dx * dx + dy * dy + dz * dz <= r2) out[i] = level;
    }
  }
  return out;
}

// SHRINK — erosion is dilation of the complement, and here that is not merely an identity worth
// noting: running the same distance field from the UNMASKED side is what keeps the two exactly
// symmetrical, so Grow then Shrink returns where it started instead of drifting.
export function erode(mask, vnOffset, vnList, nv, radius, positions) {
  // The same straight-line accept test as dilate, for the same reason and so the pair stay exact
  // inverses: a Grow measured one way and a Shrink measured another would not return where it
  // started.
  const { src } = distanceField(mask, vnOffset, vnList, nv, radius * WALK_SLACK, positions, (m) => m <= 0);
  const out = Float32Array.from(mask);
  const r2 = radius * radius;
  for (let i = 0; i < nv; i++) {
    const sIdx = src[i];
    if (sIdx < 0) continue;
    const dx = positions[i * 3] - positions[sIdx * 3];
    const dy = positions[i * 3 + 1] - positions[sIdx * 3 + 1];
    const dz = positions[i * 3 + 2] - positions[sIdx * 3 + 2];
    if (dx * dx + dy * dy + dz * dz <= r2) out[i] = 0;
  }
  return out;
}

// ⚠ ringsForNv WAS HERE AND IS GONE. It converted a vertex count into a number of dilation rings,
// which only had a job while Grow WAS a ring walk — and that walk is what made rectangles out of
// everything. A radius needs no such conversion: the same number means the same distance at every
// density, so the rule this function existed to encode is no longer a rule anyone has to apply.
// Removed rather than left exported: an unused conversion is an invitation to reintroduce the
// unit that caused the defect.

// The standardized curvature of the form, as a signed number in roughly -1..1 where POSITIVE means
// concave. Kept separate from the two masks below because both need it and neither owns it.
function standardise(curv, nv, band) {
  const out = new Float32Array(nv);
  const unit = band && band.unit ? band.unit : 1;
  const mid = band ? band.median : 0;
  for (let i = 0; i < nv; i++) out[i] = (curv[i] - mid) / unit;
  return out;
}

// MASK BY CAVITY — the concave places only. ZBrush calls this Mask By Cavity; Settle reads the
// same signal to decide where a pattern collects.
//
// `amount` is signed so one control does both halves: positive masks the cavities, negative masks
// the peaks. `softness` is the width of the transition in standardized units — a wide one gives a
// gradient you can pose against, a narrow one a hard selection.
export function maskByCavity(curv, nv, band, { amount = 1, softness = 1, threshold = 1 } = {}) {
  const t = standardise(curv, nv, band);
  const out = new Float32Array(nv);
  const sign = amount >= 0 ? 1 : -1;
  const w = Math.max(1e-3, softness);
  for (let i = 0; i < nv; i++) {
    // Only the half of the distribution the sign asks for; the other half stays at zero, which is
    // what makes this different from the unsigned version below.
    const s = sign * t[i];
    out[i] = smoothstep(clamp01((s - threshold) / w)) * Math.min(1, Math.abs(amount));
  }
  return out;
}

// MASK BY CURVATURE — anywhere the surface bends, either way. Grooves AND ridges.
export function maskByCurvature(curv, nv, band, { amount = 1, softness = 1, threshold = 1 } = {}) {
  const t = standardise(curv, nv, band);
  const out = new Float32Array(nv);
  const w = Math.max(1e-3, softness);
  for (let i = 0; i < nv; i++) {
    out[i] = smoothstep(clamp01((Math.abs(t[i]) - threshold) / w)) * Math.min(1, Math.abs(amount));
  }
  return out;
}

// Combine a newly derived mask with whatever is already masked. ZBrush's mask operations add to
// the existing mask rather than replacing it, and replacing silently discards work.
export function combine(existing, added, nv, mode = 'max') {
  const out = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const a = existing ? existing[i] : 0, b = added[i];
    out[i] = mode === 'replace' ? b : mode === 'min' ? Math.min(a, b) : Math.max(a, b);
  }
  return out;
}
