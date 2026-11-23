// outline — turning a raw pointer stroke into a closed loop something can be built from.
//
// Every tool that takes a drawn region needs the same four things: an explicit closure, an even
// resampling, a refusal when the loop crosses itself, and the loop's INRADIUS. They live here once
// so a second outline tool does not grow a second copy of them and drift.
//
// ⚠ NOTHING HERE REPAIRS. A stroke that crosses itself is refused and says where. Repairing it means
// guessing which of two readings the hand meant, and a wrong guess produces a plausible region that
// is not the one that was drawn — which is the failure this module exists to make impossible.

// ⚠ THE CLOSING SEGMENT IS PART OF THE LOOP. A resampler that walks p[0]..p[n-1] and stops covers
// every edge except the one from the last point back to the first, so the samples bunch and the
// tail is padded with duplicates of the final point. The gap then survives into the geometry as a
// notch. This walks the wrap segment like any other.
export function perimeter(pts) {
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    d += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return d;
}

// Signed area, positive for counter-clockwise. Also the emptiness test: a stroke that doubles back
// on itself encloses nothing, and its area is the only thing that says so.
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Orientation is a convention every consumer depends on and none should have to establish.
export function toCounterClockwise(pts) {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts.slice();
}

// ⚠ CLOSURE IS EXPLICIT, AND THE THRESHOLD IS A FRACTION OF THE STROKE'S OWN SIZE, not pixels.
// A fixed pixel gap means the same stroke closes at one zoom and not at another. `tol` is a
// fraction of the bounding diagonal, so it travels.
export function closeOutline(pts, { tol = 0.45 } = {}) {
  if (!pts || pts.length < 3) return { ok: false, why: 'a loop needs at least three points', pts: null };
  // The gap is measured against the stroke's OWN PATH LENGTH, not against its bounding
  // diagonal. The diagonal is a property of the box the stroke happens to sit in, so the
  // same drawn shape passed or failed depending on how it was oriented and how eccentric
  // it was — a banana-shaped stroke was refused at 24% of its diagonal while being a
  // perfectly unambiguous loop. Chord-over-arc is scale-free AND rotation-free, and for a
  // circular arc of angle t it is exactly 2*sin(t/2)/t:
  //     full loop 0%   3/4 circle 30%   5/8 circle 43%   half circle 64%   straight line 100%
  // so tol = 0.45 admits anything past about five eighths of a loop and refuses a half-arc
  // or less, which is a line, not a loop. (The old message already read "% of the stroke
  // apart" — it described this test while the code measured the box.)
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (!(path > 0)) return { ok: false, why: 'the stroke has no extent', pts: null };
  const a = pts[0], b = pts[pts.length - 1];
  const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (gap > path * tol) {
    return { ok: false, why: `the ends are ${(100 * gap / path).toFixed(0)}% of the stroke apart \u2014 draw a closed shape`, pts: null, gap, path };
  }
  // Drop a final point that merely duplicates the first; the loop is closed by index wrap, not by a
  // repeated vertex. A repeated vertex is a zero-length edge and every consumer has to special-case it.
  const out = pts.slice();
  if (gap < path * 1e-9) out.pop();
  return out.length >= 3
    ? { ok: true, pts: out, gap, path }
    : { ok: false, why: 'a loop needs at least three points', pts: null };
}

// ⚠ VERIFIED ON: a smooth blob, a CRESCENT (whose centroid lies outside itself), a 7-lobed star, a
// comb, a plus folded on its own diagonal, a loop drawn nowhere near the line's origin, and a U cut
// through both arms (four crossings). Every one comes back a single ring that `selfIntersection`
// clears and `prepareOutline` accepts, and reflecting every output point lands on the ring to
// 0.0000 of its extent. Two folds in succession give four-fold symmetry, also to 0.0000.

// FOLD A DRAWN LOOP ABOUT A LINE, so the outline itself is symmetric and puff builds ONE form.
//
// Not a polygon union: a union of a shape with its mirror needs a general 2D boolean, and the
// result has to come back a SIMPLE loop or prepareOutline refuses it. Folding is exact and cheap —
// take the part of the loop on one side of the line, mirror THAT, and join the two. The join is
// guaranteed simple because the kept arc never crosses the line between its two endpoints.
export function mirrorFold(pts, o, d) {
  const n = pts.length;
  const L = Math.hypot(d[0], d[1]) || 1;
  const dx = d[0] / L, dy = d[1] / L;
  // Signed distance from the line, positive on one side. cross(d, p - o).
  const sd = pts.map(p => dx * (p[1] - o[1]) - dy * (p[0] - o[0]));
  // Every crossing, as (index i meaning between i and i+1, and the point itself).
  // ⚠ A VERTEX EXACTLY ON THE LINE IS THE CASE THAT BREAKS THE NAIVE TEST. Skipping edges where an
  // endpoint has sd === 0 loses the crossing entirely: a plus folded on its diagonal has its notch
  // corners ON the line, both of that vertex's edges get skipped, and the shape reads as "the line
  // misses it" while the line runs straight through the middle. Classify each POINT to one side
  // with a consistent tie-break (zero counts as positive) and look for changes in that
  // classification — the crossing then lands exactly on the vertex, which is where it belongs.
  const pos = sd.map(v => v >= 0);
  const cross = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (pos[i] === pos[j]) continue;
    const a = sd[i], b = sd[j];
    const t = (a - b) !== 0 ? a / (a - b) : 0;
    const p = pts[i], q = pts[j];
    cross.push({ i, pt: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] });
  }
  if (cross.length < 2) return { ok: false, why: 'the line misses the shape', crossings: cross.length };
  // ⚠ THE LONGEST ARC ON ONE SIDE, not "all of one side". A wiggly loop can cross the line four or
  // six times; taking every positive stretch and mirroring them all reproduces the union problem
  // this exists to avoid. The longest contiguous arc between two consecutive crossings is a single
  // open curve that starts and ends ON the line, which is exactly what folds into a simple loop.
  let best = null;
  for (let c = 0; c < cross.length; c++) {
    const a = cross[c], b = cross[(c + 1) % cross.length];
    const arc = [a.pt];
    let i = (a.i + 1) % n;
    let guard = 0;
    while (i !== (b.i + 1) % n && guard++ < n + 2) { arc.push(pts[i]); i = (i + 1) % n; }
    arc.push(b.pt);
    // Which side is this arc on? Test its middle sample against the line.
    const m = arc[Math.floor(arc.length / 2)];
    const side = dx * (m[1] - o[1]) - dy * (m[0] - o[0]);
    let len = 0;
    for (let k = 1; k < arc.length; k++) len += Math.hypot(arc[k][0]-arc[k-1][0], arc[k][1]-arc[k-1][1]);
    if (!best || len > best.len) best = { arc, len, side };
  }
  if (!best || best.arc.length < 3) return { ok: false, why: 'no usable arc on either side' };
  // Reflect the kept arc about the line and walk it back, so the two halves make one closed ring.
  const refl = (p) => {
    const vx = p[0] - o[0], vy = p[1] - o[1];
    const t = vx * dx + vy * dy;                      // component along the line
    const px = o[0] + dx * t, py = o[1] + dy * t;     // foot on the line
    return [2 * px - p[0], 2 * py - p[1]];
  };
  const out = best.arc.slice();
  // Both endpoints already sit ON the line, so their mirrors are themselves — skip them or the ring
  // gets a duplicated vertex at each end, which is a zero-length edge every consumer special-cases.
  for (let k = best.arc.length - 2; k >= 1; k--) out.push(refl(best.arc[k]));
  // ⚠⚠ AND DEDUPE, BECAUSE A VERTEX SITTING ON THE LINE PRODUCES THE SAME POINT TWICE. When a drawn
  // vertex lands within float noise of the fold line, the interpolated crossing is that vertex, and
  // the ring then carries it as both the crossing AND the first point of the arc. Measured on a
  // 60-point hand-drawn loop: four zero-length edges, at 0, 31, 32 and 63 of 64 — and
  // `selfIntersection` reports the ring as crossing itself because of them, so `prepareOutline`
  // refuses a shape that is geometrically perfectly simple. The denser fixtures this was first
  // written against never produced a vertex close enough to the line to show it.
  // Cyclic, and scaled to the ring's own size so it means the same thing at every zoom.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of out) for (let k = 0; k < 2; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  const eps = 1e-7 * Math.max(1e-12, Math.hypot(hi[0] - lo[0], hi[1] - lo[1]));
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= eps) continue;
    clean.push(p);
  }
  while (clean.length > 2) {
    const a = clean[0], b = clean[clean.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > eps) break;
    clean.pop();
  }
  if (clean.length < 3) return { ok: false, why: 'the fold collapsed to a line' };
  // ⚠ AND AREA, BECAUSE THE DEDUPE ABOVE ONLY SEES CONSECUTIVE REPEATS. A kept arc that is very
  // nearly straight folds to a ring that doubles back along itself — measured on a two-point input
  // it returns [[0.5,0],[1,0],[0.5,0],[0,0]], which repeats a vertex NON-consecutively and so
  // survives the dedupe while enclosing nothing. prepareOutline would refuse it downstream ("the
  // outline encloses no area"), but a function that hands back a ring it knows is empty makes its
  // caller's fallback fire one step later and for a reason that reads like someone else's fault.
  const A = Math.abs(signedArea(clean));
  const span = Math.max(1e-12, Math.hypot(hi[0] - lo[0], hi[1] - lo[1]));
  if (!(A > 1e-9 * span * span)) return { ok: false, why: 'the fold encloses no area' };
  return { ok: true, pts: clean, keptLen: best.len, crossings: cross.length };
}

// ⚠ VERIFIED ON a blob, a teardrop, a long bar and a crescent at 3, 6 and 12 copies: every one comes
// back a single ring that `selfIntersection` clears and `prepareOutline` accepts, and rotating the
// RESULT by one sector lands back on itself to ~1e-15 of its extent.

// RADIAL SYMMETRY AS ONE OUTLINE — the union of the rotated copies, expressed as a radius function.
//
// A mirror folds; a rosette cannot. Clipping one angular wedge and rotating it N times joins each
// copy to the next at a DIFFERENT radius, so the ring closes with a notch at every sector boundary.
// Taking the MAX over the rotated copies instead is the union of them all, it is continuous
// wherever the source is, and it is by construction star-shaped about the pivot — which means the
// result is always a simple closed loop, the one thing prepareOutline insists on.
export function radialUnion(pts, o, n, want = 512) {
  if (!pts || pts.length < 3 || !(n >= 2)) return { ok: false, why: 'radial needs at least two copies' };
  // ⚠ THE SAMPLE COUNT IS A MULTIPLE OF n, AND THAT IS WHAT MAKES THE SYMMETRY EXACT RATHER THAN
  // NEARLY RIGHT. With an arbitrary count, rotating by one sector lands between samples and the
  // copy is taken from the nearest one instead — measured at 7.8e-3 of the form's extent, which is
  // small, visible on a large form, and completely avoidable. Rounding the count UP to a multiple
  // of n makes the rotation land exactly on a sample and the result symmetric to float precision.
  const samples = Math.ceil(want / n) * n;
  const N = pts.length;
  // Farthest hit along the ray, not the nearest: a shape that is not star-shaped about the pivot
  // still has an outer silhouette, and using it means a crescent produces a rosette of crescent
  // tips rather than being refused outright.
  const rayR = (ux, uy) => {
    let best = 0;
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const ox = a[0] - o[0], oy = a[1] - o[1];
      const t = (ox * ey - oy * ex) / den;      // along the ray
      const s = (ox * uy - oy * ux) / den;      // along the edge
      if (t > 0 && s >= 0 && s <= 1 && t > best) best = t;
    }
    return best;
  };
  const step = 2 * Math.PI / samples;
  const base = new Float64Array(samples);
  for (let i = 0; i < samples; i++) base[i] = rayR(Math.cos(i * step), Math.sin(i * step));
  let hits = 0;
  for (let i = 0; i < samples; i++) if (base[i] > 0) hits++;
  if (hits < samples * 0.9) return { ok: false, why: 'the pivot is not inside the shape' };
  const out = [];
  for (let i = 0; i < samples; i++) {
    let r = 0;
    for (let k = 0; k < n; k++) {
      const j = (i + Math.round(k * samples / n)) % samples;
      if (base[j] > r) r = base[j];
    }
    out.push([o[0] + r * Math.cos(i * step), o[1] + r * Math.sin(i * step)]);
  }
  return { ok: true, pts: out };
}

// ⚠ REFUSE, DO NOT REPAIR. Returns the first crossing pair so a caller can SHOW it rather than
// saying "invalid". Adjacent segments share an endpoint and are skipped; so is the wrap pair.
export function selfIntersection(pts) {
  const n = pts.length;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // ⚠⚠ THE SIDE TEST IS SCALE-RELATIVE, AND A STRICT `> 0` WAS FALSELY REFUSING REAL SHAPES.
  // `cross` returns twice a signed area, so on two NEARLY-PARALLEL edges it is a tiny number whose
  // SIGN is floating-point noise. Written as `(d1 > 0) !== (d2 > 0)` that noise reads as a straddle,
  // and since more samples means more nearly-parallel pairs, the false positive is
  // DENSITY-DEPENDENT: a plain thin triangle measured clean at 10 samples an edge and "crosses
  // itself" at 40. A hand-drawn thin shape at pencil density is exactly that input, and the puff
  // tool it feeds refused it by name.
  //
  // Dividing by the segment's length turns the cross product back into a PERPENDICULAR DISTANCE,
  // which is comparable against the outline's own size. The epsilon is 1e-9 of the bounding
  // diagonal: about seven orders of magnitude above double-precision noise on these coordinates,
  // and six below the 0.001-wide gap section D of the gate requires NOT to be flagged — so it
  // separates "noise" from "a real near-miss" with room on both sides rather than being tuned
  // between them.
  //
  // ⚠⚠ AND A POINT LYING ON THE OTHER SEGMENT IS TESTED SEPARATELY, BECAUSE THE EPSILON WOULD
  // OTHERWISE HAVE THROWN AWAY A REAL CROSSING. A polygon that visits the same point twice is not
  // simple, and a densely-sampled bowtie does exactly that: sampled at 40 per edge, both diagonals
  // land a vertex EXACTLY on (0,0), so the two paths TOUCH at a shared point rather than crossing
  // transversally through segment interiors. The strict test caught that by accident of sign
  // convention; suppressing the zero side lost it, and the gate could not see the loss because its
  // own bowtie is four raw points, where the crossing IS transversal. So the two questions are
  // asked separately: do the segments straddle each other, and does an endpoint of either lie on
  // the other. Both are self-intersections; only the first is what the side test measures.
  let lo0 = Infinity, lo1 = Infinity, hi0 = -Infinity, hi1 = -Infinity;
  for (const p of pts) {
    if (p[0] < lo0) lo0 = p[0]; if (p[0] > hi0) hi0 = p[0];
    if (p[1] < lo1) lo1 = p[1]; if (p[1] > hi1) hi1 = p[1];
  }
  const EPS = Math.hypot(hi0 - lo0, hi1 - lo1) * 1e-9;
  const side = (d, len) => { const h = len > 0 ? d / len : 0; return h > EPS ? 1 : (h < -EPS ? -1 : 0); };
  // Does p lie ON segment a-b — within EPS of the line AND between the ends?
  const onSeg = (p, a, b, len) => {
    if (!(len > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]) <= EPS;
    const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
    if (t < 0 || t > 1) return false;
    return Math.hypot(p[0] - (a[0] + (b[0] - a[0]) * t), p[1] - (a[1] + (b[1] - a[1]) * t)) <= EPS;
  };
  for (let i = 0; i < n; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n];
    const len12 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue;
      // neighbors share a vertex; the first and last segments share one too
      if (j === (i + 1) % n || i === (j + 1) % n) continue;
      const p3 = pts[j], p4 = pts[(j + 1) % n];
      const len34 = Math.hypot(p4[0] - p3[0], p4[1] - p3[1]);
      const s1 = side(cross(p3, p4, p1), len34), s2 = side(cross(p3, p4, p2), len34);
      const s3 = side(cross(p1, p2, p3), len12), s4 = side(cross(p1, p2, p4), len12);
      // a transversal crossing: each segment straddles the other's line, on both counts
      if (s1 !== 0 && s2 !== 0 && s3 !== 0 && s4 !== 0 && s1 !== s2 && s3 !== s4) return { at: [i, j] };
      // a touch: an endpoint of one lying on the other. Non-adjacent segments already, so a shared
      // point here is the outline meeting itself, not two edges meeting at their own corner.
      if ((s1 === 0 && onSeg(p1, p3, p4, len34)) || (s2 === 0 && onSeg(p2, p3, p4, len34))
       || (s3 === 0 && onSeg(p3, p1, p2, len12)) || (s4 === 0 && onSeg(p4, p1, p2, len12))) {
        return { at: [i, j] };
      }
    }
  }
  return null;
}

// ⚠ ARC LENGTH, NOT INDEX. A hand moves at wildly different speeds around a loop, so index-uniform
// samples bunch where the hand slowed and thin where it hurried — and every downstream measure that
// assumes even spacing then reads the hand's tempo as the shape's geometry.
export function resampleByArcLength(pts, count) {
  const n = pts.length;
  if (n < 3 || count < 3) return pts.slice();
  // Cumulative arc length at each vertex, with the wrap segment closing the table. Walking a
  // precomputed table rather than consuming the input means the source is never mutated and the
  // output count is exact by construction — a resampler that can terminate early pads its tail with
  // duplicates of the last point, and duplicates are zero-length edges every consumer must special-case.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[n];
  if (!(total > 0)) return pts.slice();
  const out = new Array(count);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k * total) / count;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const L = cum[seg + 1] - cum[seg];
    const t = L > 0 ? (target - cum[seg]) / L : 0;
    const a = pts[seg], b = pts[(seg + 1) % n];
    out[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return out;
}

export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function distanceToBoundary(pts, x, y) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
    if (d < best) best = d;
  }
  return best;
}

// ⚠ THE INRADIUS IS THE NUMBER THAT DECIDES RESOLUTION, and it is not the drawn size.
// A puffed region's height is bounded by half its local thickness, so the deepest interior point —
// not the bounding box — says how many voxels the shape needs to survive a field bake. A crescent
// drawn as wide as a disc has a small fraction of the disc's inradius, and a grid sized from the
// drawn extent renders it as a blunted lump. Sampled on a grid: `spacing` is the accuracy, and it is
// returned so a caller can say how sure it is rather than implying exactness.
export function inradius(pts, { samples = 96 } = {}) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of pts) {
    lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]);
    hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]);
  }
  const w = hi[0] - lo[0], h = hi[1] - lo[1];
  const nx = Math.max(8, Math.round(samples * (w >= h ? 1 : w / h)));
  const ny = Math.max(8, Math.round(samples * (h >= w ? 1 : h / w)));
  const sx = w / nx, sy = h / ny;
  let best = 0, at = null;
  for (let iy = 0; iy <= ny; iy++) {
    const y = lo[1] + iy * sy;
    for (let ix = 0; ix <= nx; ix++) {
      const x = lo[0] + ix * sx;
      if (!pointInPolygon(pts, x, y)) continue;
      const d = distanceToBoundary(pts, x, y);
      if (d > best) { best = d; at = [x, y]; }
    }
  }
  return { r: best, at, spacing: Math.max(sx, sy), diag: Math.hypot(w, h) };
}

// The one entry point a tool should call. Everything above is exported so a gate can test the parts.
export function prepareOutline(raw, { count = 128, tol = 0.15 } = {}) {
  const closed = closeOutline(raw, { tol });
  if (!closed.ok) return { ok: false, why: closed.why };
  const ccw = toCounterClockwise(closed.pts);
  const hit = selfIntersection(ccw);
  if (hit) return { ok: false, why: 'the outline crosses itself — draw a simple loop', at: hit.at };
  const pts = resampleByArcLength(ccw, count);
  const area = Math.abs(signedArea(pts));
  if (!(area > 0)) return { ok: false, why: 'the outline encloses no area' };
  const ir = inradius(pts);
  return { ok: true, pts, area, inradius: ir.r, inradiusAt: ir.at, inradiusSpacing: ir.spacing, diag: ir.diag };
}


/**
 * TAUBIN FAIRING OF A CLOSED CURVE — low-pass a drawn outline WITHOUT shrinking it.
 *
 * ⚠⚠⚠ WHY THIS EXISTS, in the user's own words: "Lines drawn into puff will always be irregular,
 * blobby." That is the design constraint, not a caveat. A hand-drawn loop carries tremor, and the
 * inflation is faithful to it — every wobble in the line becomes a lobe in the solid, and the
 * medial axis between lobes becomes a crease. The fix cannot be to hope for a clean stroke.
 *
 * ⚠ TAUBIN, NOT A PLAIN LAPLACIAN, AND THE DIFFERENCE IS THE WHOLE POINT. A plain neighbor
 * average shrinks a closed curve on every pass — smooth it enough to remove tremor and the drawn
 * shape has visibly deflated. Alternating a positive step with a slightly LARGER negative one
 * cancels that. Measured over 10/20/40 iterations on gentle, typical and scribbly strokes, the
 * enclosed AREA lands at 100.1% - 100.5% of the original: it does not shrink at all.
 *
 * ⚠ AND IT BARELY MOVES THE LINE. Worst deviation from the drawn curve, as a fraction of the
 * shape's half-width: 0.8% gentle, 1.5% typical, 2.1% scribbly, at 20 iterations. What it removes
 * is tremor, not shape — a deliberate lobe survives, a hand wobble does not.
 *
 * The lambda/mu pair is the one the original SmoothTeddy uses in `TaubinFairing` (pass-band 0.1).
 * That program also ships a `TaubinFairing2D` doing exactly this to a closed 2D polyline; it is
 * dead code there, with zero call sites. It is not dead here.
 */
// ⚠ THE COORDINATE COUNT IS READ OFF THE POINTS. A drawn outline is two-dimensional and a region
// boundary on a form is three; the operator is the same relaxation either way, and a second copy
// of it is a second place for the lambda/mu pair to drift.
export function taubinSmoothClosed(pts, { iters = 20, lam = 0.63139836, mu = -0.6739516 } = {}) {
  if (!pts || pts.length < 5 || !(iters > 0)) return pts;
  const dim = pts[0].length;
  let Q = pts.map(p => p.slice());
  const step = (w) => {
    const n = Q.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Q[(i - 1 + n) % n], b = Q[i], c = Q[(i + 1) % n], q = new Array(dim);
      for (let d = 0; d < dim; d++) q[d] = b[d] + w * ((a[d] + c[d]) / 2 - b[d]);
      out[i] = q;
    }
    Q = out;
  };
  for (let k = 0; k < iters; k++) { step(lam); step(mu); }
  return Q;
}

// ── A MEASURED NEGATIVE, KEPT AS A NOTE RATHER THAN AS CODE ──────────────────────────────────────
// A PERIODIC CUBIC SPLINE (G2 at the seam by construction) WAS BUILT HERE AND REMOVED, because it
// changed nothing. The seam of a drawn loop is its worst point — discrete curvature, worst around
// the loop against the mean:
//
//      as prepared   gap 0%  4.0x     gap 3%  5.2x     gap 8%  7.2x    (worst is AT the seam)
//      + Taubin x20          2.9x             3.0x             3.8x
//      + periodic spline     2.9x             3.0x             3.8x    <- no change at all
//
// ⚠ C2 MEANS THE CURVATURE IS CONTINUOUS, NOT SMALL. An interpolating spline through points that
// genuinely turn at the seam still turns there; it removes the DISCONTINUITY and leaves the
// MAGNITUDE. What a person sees as a kink is the magnitude.
//
// ⚠ AND THE CONTROL SAYS THE RESIDUAL IS MODEST. Clean analytic curves, same instrument:
// circle 1.0x, ellipse 1.2:1 1.4x, ellipse 1.4:1 1.9x, ellipse 2:1 3.4x. A faired stroke of
// roughly 1.4:1 sitting at 2.9x is elevated — it carries one region as sharp as a 2:1 ellipse's
// end — but it is not the 7.2x it started at.
//
// WHAT WOULD ACTUALLY FIX IT: reduce the curvature magnitude AT the join specifically — either by
// weighting the fairing toward the seam, or by blending the stroke's ends over an overlap when it
// is closed, so the join is smooth by construction rather than faired-toward-smooth afterwards.
// Neither is built. Do not reach for a higher continuity class again; that has been measured.


// ── THE SECOND MEASURED NEGATIVE ON THE SEAM. BOTH ATTEMPTS ARE RECORDED SO NEITHER IS REPEATED ──
// A CURVATURE-OUTLIER FAIRING was written here and removed. The idea: do not look for the seam,
// smooth wherever curvature is an outlier against its own LOCAL neighborhood, so the seam is found
// because it is an outlier and a deliberate corner is left alone because a shape that is sharp all
// the way round has none. Measured, worst-over-mean curvature:
//
//                        taubin only    + outlier fairing
//      gap 0%               2.9x              2.9x        <- did not fire at all
//      gap 3%               3.0x              3.0x        <- did not fire at all
//      gap 8%               3.8x              3.8x        <- did not fire at all
//      TRIANGLE (control)  22.2x             11.2x        <- FIRED, and rounded the corners
//
// ⚠ IT DID EXACTLY THE OPPOSITE OF ITS PURPOSE, and the reason is worth keeping: after Taubin the
// seam is a BROAD ELEVATED REGION spread over several points, so no single point stands out from
// its neighbors — while a deliberate corner IS a single-point spike. "Local outlier" is a detector
// for sharp corners, which is the one thing that must not be touched. The control caught it; a
// seam-only fixture set would have shown a harmless no-op and hidden the corner damage entirely.
//
// So the two things tried and measured, neither of which works:
//   1. a PERIODIC CUBIC SPLINE (G2 by construction) — 2.9x -> 2.9x. C2 makes curvature CONTINUOUS,
//      not SMALL, and what a person sees is the magnitude.
//   2. curvature-outlier fairing — no effect on the seam, damages real corners.
//
// WHAT IS LEFT TO TRY, and why it is different: both attempts operated on the CLOSED loop, after
// the join already exists. Blend the stroke's ENDS as it is closed instead — overlap the last few
// samples with the first few and average them — so the join is smooth by construction and there is
// never a spike to detect. That is a change to `closeOutline`, not to a fairing pass.
// ⚠ Whatever is tried, keep a DRAWN TRIANGLE in the fixtures. It is the control that says the fix
// distinguishes an artefact from an intention.

// ── THE THIRD ATTEMPT: IT WORKS, AND IT WAS NOT SHIPPED. ──────────────────────────────────────────
// The blend above was built exactly as this note asked — the last K points and the first K replaced
// by ONE run ramping from the tail's shape to the head's, smoothstep so the TANGENT matches and not
// only the position, K taken from PATH LENGTH so sampling density does not change how much curve is
// touched. It does what nothing before it did. Measured through the real chain
// (prepareOutline -> taubin x20 -> prepareOutline), worst curvature over mean:
//
//      gap 5% 3.1x -> 2.4x   gap 8% 4.4x -> 2.4x   gap 12% 5.6x -> 3.3x   long 2:1 gap 8% 10.0x -> 5.0x
//      TRIANGLE at corner 23.9x -> 24.2x    TRIANGLE mid-edge 24.6x -> 23.2x    SQUARE 12.5x -> 12.8x
//
// The three CONTROLS hold within 2% — it reshapes only the arc adjacent to the JOIN, so a
// deliberate corner survives wherever the pen started. On its own terms it is the fix.
//
// ⚠⚠ IT WAS NOT SHIPPED BECAUSE THE 2D NUMBER NO LONGER CORRESPONDS TO ANYTHING VISIBLE. This whole
// note was written when a seam was a crease a person could see. Measured on the SUBDIVIDED SURFACE
// — worst dihedral and edges past 20 degrees, twice-subdivided, which is what is on screen — across
// stroke roughness from a gentle wobble to heavy per-sample tremor, with and without a closing gap:
//
//      control (no blend)   worst dihedral 6.6 - 13.8 deg,  edges over 20 deg: ZERO, every fixture
//      with the blend       worst dihedral 6.1 - 13.0 deg,  edges over 20 deg: ZERO, every fixture
//
// Better in five fixtures, WORSE in three, all inside ~3 degrees, and never near the 20 degrees at
// which a crease reads. The causes that made the seam visible were removed elsewhere — the apex fan
// (p00000-190/191), the pole-free grid cap (195) and the curve fairing itself — and what remains is
// absorbed by subdivision. Shipping it would have added an option, a code path and a maintenance
// claim in exchange for a number no one looks at.
//
// ⚠ THE 2D CURVATURE RATIO IS A PROXY AND IT HAS NOW OUTLIVED ITS ORACLE. If the seam is ever
// reported again, measure the SURFACE first and only reopen this if edges past 20 degrees actually
// appear. The implementation is recoverable from this note; it is thirty lines.
// ⚠ AND A HARNESS WARNING PAID FOR TWICE: measuring taubin WITHOUT prepareOutline's resample ranks
// the candidates wrongly. A truncated stroke keeps its closing chord as one long straight edge, so
// discrete curvature at its ends is enormous for a reason the app never sees — gap 8% reads 14.9x
// instead of 4.4x, and two of the four candidates swap places. Measure the chain the app runs.
//
// TWO FURTHER VARIANTS BUILT AND REJECTED, so a fourth attempt does not repeat them:
//   3. BLEND ONLY THE ACTUAL OVERLAP — the wording of the note above. Fires only where the stroke
//      overshoots its own start; K came out 0 on every gap fixture. Right idea for an overshoot,
//      no idea at all for a gap.
//   4. DISTRIBUTE THE CLOSING GAP — walk each end toward the gap's midpoint by a ramp, so the
//      correction is proportional to the artefact and a corner (which has no gap) cannot be
//      touched. Elegant, and WORSE than doing nothing on every gap fixture (gap 8%: 4.4x -> 6.8x):
//      pulling the ends together sharpens the local turn.



/**
 * THE LOOPS WHERE A PER-VERTEX FIELD CROSSES A LEVEL, ACROSS A QUAD MESH.
 *
 * Marching quads. A region painted onto a surface has an edge, and that edge is the `level`
 * contour of the field — not the ring of mesh edges around the marked vertices. The difference is
 * measurable and it is not small: snapped to vertices the contour sits up to half an edge from
 * where the field actually crosses, and every quad contributes a right angle, so a fit through it
 * carries the mesh's staircase into the curve. Interpolated along each crossed edge it lands on
 * the crossing itself.
 *
 * ⚠ THE CHAIN IS KEYED ON THE EDGE, NOT ON THE POINT. Two quads sharing an edge compute the same
 * crossing from the same two field values, so the coordinates agree bit for bit — but only if the
 * key they are welded by is the pair of vertex indices. A spatial weld needs a tolerance, and a
 * tolerance is a number that is too small on a dense mesh and too large on a coarse one. Keyed by
 * edge there is no tolerance and no parameter: an edge is crossed once and belongs to exactly two
 * quads, so every loop closes by construction on a closed manifold.
 *
 * A quad with FOUR crossings is a saddle and the two ways of pairing them are both consistent with
 * its corners. Resolved by the quad's mean: above the level the marked region is the one that
 * connects through the middle, so the crossings pair in the order they appear around the quad;
 * below it they pair the other way. Either choice closes; the mean is the one that does not pinch
 * the marked side apart.
 *
 * Returns [{ pts, keys }] — closed loops, largest first, each an array of [x,y,z]. An open chain
 * cannot arise from a closed manifold; on a mesh with a boundary one can, and it is DROPPED rather
 * than closed across the hole, because closing it would invent an edge the field never crossed.
 */
export function fieldLoops(positions, quads, field, { level = 0.5 } = {}) {
  const nq = quads.length / 4;
  if (!nq) return [];
  const nv = positions.length / 3;
  const pointOf = new Map();          // edge key -> [x,y,z]
  const segs = [];                    // [keyA, keyB]
  const keyFor = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const crossingOn = (a, b) => {
    const k = keyFor(a, b);
    let p = pointOf.get(k);
    if (!p) {
      const fa = field[a], fb = field[b];
      const t = (level - fa) / (fb - fa);
      p = [positions[a*3] + (positions[b*3] - positions[a*3]) * t,
           positions[a*3+1] + (positions[b*3+1] - positions[a*3+1]) * t,
           positions[a*3+2] + (positions[b*3+2] - positions[a*3+2]) * t];
      pointOf.set(k, p);
    }
    return k;
  };
  const hitKeys = [];
  for (let f = 0; f < nq; f++) {
    const c = [quads[f*4], quads[f*4+1], quads[f*4+2], quads[f*4+3]];
    hitKeys.length = 0;
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += field[c[i]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      if ((field[a] >= level) !== (field[b] >= level)) hitKeys.push(crossingOn(a, b));
    }
    if (hitKeys.length === 2) segs.push([hitKeys[0], hitKeys[1]]);
    else if (hitKeys.length === 4) {
      if (sum / 4 >= level) { segs.push([hitKeys[0], hitKeys[1]]); segs.push([hitKeys[2], hitKeys[3]]); }
      else { segs.push([hitKeys[1], hitKeys[2]]); segs.push([hitKeys[3], hitKeys[0]]); }
    }
  }
  if (!segs.length) return [];
  const at = new Map();               // key -> segment indices touching it
  segs.forEach((s, i) => {
    for (const k of s) { const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const keys = [segs[start][0], segs[start][1]];
    let closed = false;
    for (;;) {
      const tail = keys[keys.length - 1];
      const cand = at.get(tail) || [];
      let next = -1;
      for (const i of cand) if (!used[i]) { next = i; break; }
      if (next < 0) break;
      used[next] = 1;
      const other = segs[next][0] === tail ? segs[next][1] : segs[next][0];
      if (other === keys[0]) { closed = true; break; }
      keys.push(other);
    }
    if (closed && keys.length >= 3) loops.push(keys);
  }
  return loops
    .map(keys => ({ keys, pts: keys.map(k => pointOf.get(k)) }))
    .sort((a, b) => b.pts.length - a.pts.length);
}
