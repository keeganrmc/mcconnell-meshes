// ⚠⚠⚠ VENDORED FROM PGON, AND CHANGED IN EXACTLY ONE PLACE.
// Source: Pgon's lift/lift.v00000-001.js.
// It ran on MASQ's GNM head first try and unmodified — 70,648 quads, F.coverage
// handed straight in as `mask`. The measurements are in MASQ_NOTES_TO_PGON.
//
// MASQ'S ONE CHANGE: `thicknessAt` / `offsetAt`, optional per-SOURCE-vertex
// arrays. Pgon's plate carries ONE thickness for the whole plate, so it has to
// be set for the worst hollow on the form or it folds there — measured on
// MASQ's head, 556 folded faces at a constant 2 mm against MASQ's own shell at
// 18, because MASQ clamps the wall per vertex against `k_min`. Every use of
// `o.thickness` and `o.offset` that places a POINT now reads the arrays when
// they are supplied; the ones that decide TOPOLOGY (the row count, whether the
// sheet is open) must stay scalar, or two vertices on one loop would disagree
// about how many rings the rim has.
// Everything else is Pgon's, including the comments. Do not reformat: a diff
// against the original is the only thing that keeps this honest.
// lift.v00000-001 — a masked region of a quad surface becomes a solid of its own.
//
// Pure geometry. No DOM, no stratum, no millimeters, no object list. It takes a quad mesh, a
// per-vertex mask and six numbers, and returns a quad mesh plus the measurements a panel needs to
// describe it. Everything that knows what a Pgon object is lives in index.html.
//
// THE SHELL IT BUILDS, when thickness > 0:
//
//     outer      P + n*(offset + thickness)      source winding
//     rim        rimRows rings between them      profile below
//     inner      P + n*offset                    source winding REVERSED
//
// so `offset` is the gap between the underside of the lift and the surface it came off, and
// `thickness` is the plate itself. At thickness 0 there is no inner shell and no rim: an open
// sheet at P + n*offset, which is a legitimate result and the only one with boundary edges.
//
// RIM PROFILE. Ring r of rimRows, s = r/rimRows, phi = s*pi:
//
//     height  offset + thickness/2 + (thickness/2)*cos(phi)
//     bulge   rim * (thickness/2) * sin(phi)      along the loop's outward in-surface direction
//
// s=0 lands on the outer boundary and s=1 on the inner, exactly, at any rim. rim=1 is a true
// semicircular bead of radius thickness/2; rim=0 is a straight wall. The bulge is zero at both
// ends whatever rim is, so the rim can never lift the plate off its own shells.
// ⚠ rim needs rimRows >= 2 to appear at all — with one row the only two rings ARE the two shells,
// where sin(phi) is 0. buildLift reports `rimVisible` so a panel can say so rather than showing a
// slider that does nothing.
//
// WHAT IS NOT MOVED. Interior vertices are the source's own positions displaced along the source's
// own normals and nothing else, so a lift at offset 0, thickness 0, border 0 is bit-identical to
// the masked part of the surface. Only boundary vertices relax, and only tangentially.

// Mask's own distance-based Grow and Shrink, imported rather than reimplemented: a margin here and
// a press of Grow there have to mean the same amount of surface, and two copies of that kernel is
// where they would stop meaning it.
import { dilate, erode } from '../deform/maskops.v00000-001.js';
import { fieldLoops } from '../outline/outline.v00000-001.js';

export const LIFT_DEFAULTS = {
  margin: 0,         // world units, signed: grows (+) or shrinks (-) the region along the surface
  border: 0,         // 0..1, tangential relaxation of the outline
  offset: 0,         // world units, signed: the gap under the plate
  thickness: 0.02,   // world units, >= 0; 0 is an open sheet
  rim: 0.5,          // 0..1, roundness of the rim profile
  directionSmooth: 8, // passes of smoothing on the OFFSET DIRECTION; costs nothing and moves nothing
};

// ⚠ COVERAGE WAS A SLIDER AND IS NOW A CONSTANT, because on a HARD mask it had four usable steps.
// A face is in when the mean of its four corner mask values reaches this, and on a mask made by a
// lasso, a box or Sharpen those four values are each exactly 0 or 1 — so the mean takes five values
// and every threshold between them selects the same faces. The control only ever did anything on a
// soft brush edge, and there it did the same job as a margin, worse: it moved the boundary by
// whatever the brush falloff happened to be rather than by a distance anyone asked for. `margin`
// replaces it and works on both, in millimeters, and it is stored on the feature so it re-forms.
//
// ⚠ IT SURVIVES AS AN OPTION, WITH NO CONTROL. Dropping the parameter as well as the slider would
// leave the gate unable to state a hand-built fixture exactly: on a quad grid, marking a 2x2 block
// of faces puts 1 on nine corners, so the faces just outside the block score exactly 0.5 and come
// in with it. A bowtie fixture built to touch at ONE vertex then arrives already merged, and the
// test that proves the pinch split works cannot be written. Callers pin it; the panel does not.
export const COVERAGE = 0.5;

// The rim's row count is DERIVED, not set. One global density, accuracy from the document — the
// same rule that keeps every other tool here free of a resolution control. A half-round bead of
// radius thickness/2 has an arc of pi*thickness/2; dividing by the surface's own median edge gives
// the number of rows that makes the rim's quads the same size as the quads around it, which is what
// makes the bead read as part of the surface rather than as a separately-tessellated collar.
export function rimRowsFor(thickness, medianEdge, rim) {
  if (!(rim > 0) || !(thickness > 0) || !(medianEdge > 0)) return 1;
  return Math.max(1, Math.min(LIFT_LIMITS.rimRowsMax, Math.round((Math.PI * thickness * 0.5) / medianEdge)));
}

export const LIFT_LIMITS = { rimRowsMax: 8, borderIterations: 8, foldSafety: 0.8 };

// How many times the rim is pulled onto the mask's own contour. See snapOutlineToContour.
export const SNAP_PASSES = 3;
// How many rows of quads share that move. One row absorbing all of it is a comb; see the note in
// snapOutlineToContour for the widths that set this.
export const SNAP_RINGS = 3;

// ------------------------------------------------------------------------------------------------
// SELECTION
// ------------------------------------------------------------------------------------------------

// A face is in when the MEAN of its four corner mask values reaches coverage. The mean rather than
// the minimum: a mask painted with a soft brush never reaches 1 at the outermost ring of vertices,
// so the minimum test loses a ring of faces at every coverage above the brush's own falloff and the
// lift reads as smaller than what is dimmed in the viewport.
export function faceSelection(quads, mask, coverage = COVERAGE) {
  const nf = quads.length / 4;
  const sel = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const m = (mask[quads[f * 4]] + mask[quads[f * 4 + 1]] + mask[quads[f * 4 + 2]] + mask[quads[f * 4 + 3]]) * 0.25;
    sel[f] = m >= coverage ? 1 : 0;
  }
  return sel;
}

// Face-to-face across shared edges, as a flat CSR pair. Built from the quads alone so it needs no
// topology record and works on a patch as readily as on a whole object.
export function faceAdjacency(quads) {
  const nf = quads.length / 4;
  const edge = new Map();
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 4; e++) {
      const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
      const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const cur = edge.get(k);
      if (cur === undefined) edge.set(k, f);
      else if (typeof cur === 'number') edge.set(k, [cur, f]);
      else cur.push(f);
    }
  }
  const nbr = [];
  for (let f = 0; f < nf; f++) nbr.push([]);
  for (const v of edge.values()) {
    if (typeof v === 'number') continue;
    for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) if (i !== j) nbr[v[i]].push(v[j]);
  }
  const offset = new Int32Array(nf + 1);
  for (let f = 0; f < nf; f++) offset[f + 1] = offset[f] + nbr[f].length;
  const list = new Int32Array(offset[nf]);
  let w = 0;
  for (let f = 0; f < nf; f++) for (const g of nbr[f]) list[w++] = g;
  return { offset, list };
}

// Unconditional, not a setting. A face held to the selection by one edge is a spur that becomes a
// one-quad-wide tab in the lift, and a notch of one unselected face surrounded on three sides is a
// hole in the plate the size of one quad. Neither is ever what a mask meant, and the spur is also
// where a bowtie comes from. Runs to fixpoint, bounded.
export function despur(sel, adj, maxPasses = 6) {
  const nf = sel.length;
  let cur = sel, removed = 0, filled = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = cur.slice();
    let changed = 0;
    for (let f = 0; f < nf; f++) {
      let on = 0, deg = 0;
      for (let i = adj.offset[f]; i < adj.offset[f + 1]; i++) { deg++; if (cur[adj.list[i]]) on++; }
      // ⚠ on === 1, NOT on <= 1. A face with NO selected neighbor is an ISLAND — a stud, a
      // button, a rivet — and it is a legitimate lift of one quad. A face held on by exactly one
      // edge is a spur: it becomes a one-quad tab, and it is where a bowtie comes from.
      if (cur[f] && on === 1 && deg >= 2) { next[f] = 0; changed++; removed++; }
      else if (!cur[f] && on >= deg - 0 && deg >= 3 && on >= 3) { next[f] = 1; changed++; filled++; }
    }
    cur = next;
    if (!changed) break;
  }
  return { sel: cur, removed, filled };
}

// ------------------------------------------------------------------------------------------------
// THE PATCH
// ------------------------------------------------------------------------------------------------

// The selected faces as a mesh of their own, with srcVert[] mapping every new vertex back to the
// vertex it came from — which is what carries normals, and what makes an unmoved interior vertex
// provably unmoved.
export function extractPatch(positions, quads, sel) {
  const nf = sel.length;
  let count = 0;
  for (let f = 0; f < nf; f++) if (sel[f]) count++;
  if (!count) return null;
  const srcNv = positions.length / 3;
  const remap = new Int32Array(srcNv).fill(-1);
  const srcVert = [];
  const outQuads = new Int32Array(count * 4);
  let w = 0;
  for (let f = 0; f < nf; f++) {
    if (!sel[f]) continue;
    for (let e = 0; e < 4; e++) {
      const v = quads[f * 4 + e];
      if (remap[v] < 0) { remap[v] = srcVert.length; srcVert.push(v); }
      outQuads[w++] = remap[v];
    }
  }
  const nv = srcVert.length;
  const outPos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const s = srcVert[i] * 3;
    outPos[i * 3] = positions[s]; outPos[i * 3 + 1] = positions[s + 1]; outPos[i * 3 + 2] = positions[s + 2];
  }
  return { positions: outPos, quads: outQuads, srcVert: Int32Array.from(srcVert), nv, faces: count };
}

// A patch vertex touched by two face fans that meet only at that point — a bowtie — has two
// outgoing boundary half-edges, so the loop walk has a choice to make and whichever it takes leaves
// the other fan's boundary unwalked. Splitting the vertex per fan is the repair that keeps every
// selected face: the two pieces then lift as two shells that touch at nothing.
// ⚠ THE SPLIT IS ON THE PATCH, NOT THE SOURCE. srcVert grows with a duplicate entry, so both copies
// still carry the same source normal and the same source position.
function splitPinchVertices(patch) {
  const { quads } = patch;
  const nf = quads.length / 4;
  const facesAt = new Map();
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    const v = quads[f * 4 + e];
    let a = facesAt.get(v); if (!a) { a = []; facesAt.set(v, a); }
    a.push(f);
  }
  // edge -> faces, so "these two faces share an edge at v" is a lookup rather than a scan
  const edgeFaces = new Map();
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let l = edgeFaces.get(k); if (!l) { l = []; edgeFaces.set(k, l); }
    l.push(f);
  }
  const srcVert = Array.from(patch.srcVert);
  const pos = Array.from(patch.positions);
  let splits = 0;
  for (const [v, fs] of facesAt) {
    if (fs.length < 2) continue;
    const idx = new Map(fs.map((f, i) => [f, i]));
    const parent = fs.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    for (const f of fs) {
      for (let e = 0; e < 4; e++) {
        const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
        if (a !== v && b !== v) continue;
        const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        for (const g of (edgeFaces.get(k) || [])) if (idx.has(g)) uni(idx.get(f), idx.get(g));
      }
    }
    const groups = new Map();
    for (const f of fs) { const r = find(idx.get(f)); let g = groups.get(r); if (!g) { g = []; groups.set(r, g); } g.push(f); }
    if (groups.size < 2) continue;
    let first = true;
    for (const g of groups.values()) {
      if (first) { first = false; continue; }
      const nv2 = srcVert.length;
      srcVert.push(patch.srcVert[v]);
      pos.push(patch.positions[v * 3], patch.positions[v * 3 + 1], patch.positions[v * 3 + 2]);
      for (const f of g) for (let e = 0; e < 4; e++) if (quads[f * 4 + e] === v) quads[f * 4 + e] = nv2;
      splits++;
    }
  }
  patch.srcVert = Int32Array.from(srcVert);
  patch.positions = Float32Array.from(pos);
  patch.nv = srcVert.length;
  return splits;
}

// Boundary loops as ORDERED, DIRECTED half-edge chains. The direction is the one the patch's own
// faces induce, which is what makes the rim's winding fall out rather than being guessed at.
export function boundaryLoops(quads, nv) {
  const nf = quads.length / 4;
  const used = new Set();
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    used.add(quads[f * 4 + e] * 4294967296 + quads[f * 4 + (e + 1) % 4]);
  }
  const nextOf = new Map();   // a -> b for every boundary half-edge a->b
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
    if (!used.has(b * 4294967296 + a)) nextOf.set(a, b);
  }
  const loops = [];
  const seen = new Set();
  for (const start of nextOf.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start, guard = 0;
    while (v !== undefined && !seen.has(v) && guard++ <= nv + 4) { seen.add(v); loop.push(v); v = nextOf.get(v); }
    if (loop.length >= 3 && v === start) loops.push(loop);
  }
  return loops;
}

// ------------------------------------------------------------------------------------------------
// THE OUTLINE
// ------------------------------------------------------------------------------------------------

/* ⚠⚠⚠ THE RIM IS QUANTISED TO THE QUAD LATTICE AND THE MASK'S EDGE IS NOT. `faceSelection` takes a
 * face when the MEAN of its four corners reaches coverage, so the patch's boundary can only run
 * along whole quad edges — while the edge a person painted is the 0.5 crossing, interpolated ALONG
 * each crossed edge, landing between vertices. Measured on a soft analytic cap: the mask's own
 * contour turns 1.84 degrees per point and the unfaired rim turns 48.97, walking 70% further around
 * the same shape. That is a right-angle staircase, and it is what "the lifted object is jaggier
 * than the selection" is a picture of.
 *
 * ⚠ MORE RESOLUTION CANNOT FIX IT. The step is always exactly one quad, so a finer mesh shrinks the
 * steps and the contour they are measured against in the same proportion. The ratio does not move.
 *
 * ⚠ AND THE OUTLINE SMOOTHER CANNOT EITHER, WHICH IS WHY IT IS NOT THE ANSWER. Swept 0 to 1 it does
 * all its work by 0.15 — 48.97 deg to 18.23, the ring from 70% too long to 11% — and then saturates:
 * 9.47, 9.35, 9.11, 9.63 across the rest of its range, with the perimeter flat at 8-11% long. It is
 * relaxing vertices that still have to pass through the lattice, so there is a floor at about five
 * times the line that was painted, and no setting reaches under it.
 *
 * So the rim is MOVED ONTO the contour before anything is smoothed. Then there is no staircase, and
 * the smoother is a shape control rather than a repair.
 *
 * ⚠⚠ CROSS-TRACK ONLY, AND A NEAREST-POINT SNAP IS THE WRONG MOVE. The staircase is a zig-zag
 * PERPENDICULAR to the loop; the along-loop component of a nearest-point move is what slides two
 * boundary vertices onto the same place and leaves a zero-length edge in a rim that has to stay
 * watertight. Removing only the perpendicular component takes the staircase out and leaves the
 * spacing along the loop as it was.
 * ⚠ AND THE NORMAL COMPONENT COMES OUT TOO, on the same argument relaxOutline already makes: the
 * move stays in the surface, so the rim cannot cut into the form it came off.
 * ⚠ SIMULTANEOUS, FROM THE ORIGINAL POSITIONS, so the result does not depend on which end of the
 * loop the walk started at.
 */
function snapOutlineToContour(positions, normals, loops, contour, medianEdge, passes = SNAP_PASSES, ring = null) {
  if (!contour || !contour.length || !(medianEdge > 0)) return { moved: 0, snapped: 0, capped: 0, passes: 0 };
  // A hash over the contour's segments, so a boundary vertex asks about the few segments near it
  // rather than about all of them. The move is capped at one edge, so one ring of cells reaches
  // everything that can win.
  const cell = Math.max(medianEdge * 2, 1e-9);
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x/cell)},${Math.floor(y/cell)},${Math.floor(z/cell)}`;
  const segs = [];
  for (const L of contour) {
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length];
      const si = segs.length;
      segs.push([a, b]);
      // Both endpoints, so a segment longer than a cell is still found from either end.
      for (const q of [a, b]) {
        const k = key(q[0], q[1], q[2]);
        let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(si);
      }
    }
  }
  const cap = medianEdge;
  let snapped = 0, capped = 0, moved = 0;
  // ⚠⚠ ITERATED, BECAUSE THE FIRST PASS IS READING THE LOOP'S DIRECTION OFF THE STAIRCASE. The
  // cross-track direction comes from prev->next, and on a zig-zag that vector is the average of two
  // steps that disagree — so the first pass removes most of the zig and mis-aims the rest. After it
  // the ring is smooth enough to estimate from. Measured on a soft cap, turn per vertex with the
  // smoother OFF: one pass 8.49 deg, three 3.31, six 3.13, against the mask's own contour at 1.84.
  // Three is where it stops paying.
  for (let pass = 0; pass < passes; pass++) {
  const target = new Float64Array(positions.length);
  const has = new Uint8Array(positions.length / 3);
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const v = loop[i], p = loop[(i + n - 1) % n], q = loop[(i + 1) % n];
      const x = positions[v*3], y = positions[v*3+1], z = positions[v*3+2];
      // nearest point on the contour, within one cell ring
      let bd = Infinity, bx = 0, by = 0, bz = 0;
      const ci = Math.floor(x/cell), cj = Math.floor(y/cell), ck = Math.floor(z/cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${ci+dx},${cj+dy},${ck+dz}`);
        if (!list) continue;
        for (const si of list) {
          const a = segs[si][0], b = segs[si][1];
          const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
          const L2 = ux*ux + uy*uy + uz*uz;
          let t = L2 > 0 ? ((x-a[0])*ux + (y-a[1])*uy + (z-a[2])*uz) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a[0]+ux*t, py = a[1]+uy*t, pz = a[2]+uz*t;
          const d = (px-x)**2 + (py-y)**2 + (pz-z)**2;
          if (d < bd) { bd = d; bx = px; by = py; bz = pz; }
        }
      }
      if (bd === Infinity) continue;
      let dx = bx - x, dy = by - y, dz = bz - z;
      // along the loop
      let tx = positions[q*3] - positions[p*3], ty = positions[q*3+1] - positions[p*3+1], tz = positions[q*3+2] - positions[p*3+2];
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-12) {
        tx /= tl; ty /= tl; tz /= tl;
        const dt = dx*tx + dy*ty + dz*tz;
        dx -= dt*tx; dy -= dt*ty; dz -= dt*tz;
      }
      // out of the surface
      const nx = normals[v*3], ny = normals[v*3+1], nz = normals[v*3+2];
      const dn = dx*nx + dy*ny + dz*nz;
      dx -= dn*nx; dy -= dn*ny; dz -= dn*nz;
      const len = Math.hypot(dx, dy, dz);
      if (len > cap && len > 0) { const k = cap/len; dx *= k; dy *= k; dz *= k; capped++; }
      target[v*3] = dx; target[v*3+1] = dy; target[v*3+2] = dz; has[v] = 1;
      snapped++; moved += Math.min(len, cap);
    }
  }
  // ⚠⚠⚠ UNFINISHED, AND SAYING SO HERE RATHER THAN IN A COMMIT MESSAGE NOBODY WILL READ. The rim
  // loop is smooth — mean turn 2.27 deg against the contour's 1.84, perimeter within 0.007% — and
  // the SURFACE still combs, which is what a person actually sees. The fringe is the row of quads
  // behind the rim: each boundary vertex goes to its own nearest point on the contour, neighbours
  // move by different amounts, and one row absorbs all of it. Row width spread, narrowest to
  // widest: 1.12x before the snap, 1.80x after, 1.40x with the two passes below. Better and not
  // fixed. Everything measured on the LOOP is blind to it by construction.
  // ⚠ THE MOVE IS SMOOTHED ALONG THE LOOP FIRST, which is half of what the row needs.
  // A staircase alternates in and out by up to a whole edge, so neighbouring boundary vertices need
  // genuinely different corrections — and applying them as computed leaves the row of quads behind
  // the rim alternating in width, which is what a person sees. What the row needs is the LOW
  // frequency of the correction, which is the real drift onto the contour, without its alternating
  // component, which is the staircase being described one vertex at a time.
  // ⚠ SMOOTHING THE MOVE, NOT THE POSITIONS. Relaxing positions is what relaxOutline does and it
  // pulls a closed loop inward on every pass; the mean of a move field is preserved by averaging
  // it, so the boundary still arrives where the contour is.
  for (const loop of loops) {
    const m = loop.length;
    if (m < 5) continue;
    for (let it = 0; it < 2; it++) {
      const cp = new Float64Array(m * 3);
      for (let i = 0; i < m; i++) {
        const a = loop[(i - 1 + m) % m], b = loop[i], c = loop[(i + 1) % m];
        for (let d = 0; d < 3; d++) cp[i*3+d] = (target[a*3+d] + 2*target[b*3+d] + target[c*3+d]) / 4;
      }
      for (let i = 0; i < m; i++) for (let d = 0; d < 3; d++) target[loop[i]*3+d] = cp[i*3+d];
    }
  }

  // ⚠⚠ AND THEN SHARED INWARD, because even a smooth correction applied to one ring alone is a step
  // across the row behind it.
  // Each boundary vertex goes to its own nearest point on the contour, so neighbours move by
  // different amounts — and if only the boundary moves, the single row of quads behind it absorbs
  // every one of those differences. Measured on a soft cap, the width of that row: 1.12x spread
  // from narrowest to widest before the snap, 1.80x after. A row of alternating widths is a comb,
  // and it is what you SEE, while the loop running along its tip stays smooth and every measurement
  // taken on the loop — mean turn 2.27 deg, perimeter within 0.007% — says the rim is fine. It is.
  // The rim was never the thing that looked wrong.
  // Spread over SNAP_RINGS rings with a linear falloff, the same correction lands as a gentle shear
  // across a few rows instead of a step across one. The interior slides TANGENTIALLY — the move
  // already has its normal component removed — so the plate still lies on the form; what changes is
  // where its vertices sit on it, which is sampling and not shape.
  const rings = ring ? SNAP_RINGS : 0;
  if (rings > 0) {
    const w = new Float32Array(positions.length / 3);
    let front = [];
    for (let v = 0; v < has.length; v++) if (has[v]) { w[v] = 1; front.push(v); }
    for (let r = 1; r <= rings && front.length; r++) {
      const fall = 1 - r / (rings + 1);
      const next = [];
      for (const v of front) {
        for (let k = ring.offset[v]; k < ring.offset[v + 1]; k++) {
          const u = ring.list[k];
          if (has[u] || w[u] > 0) continue;
          w[u] = fall; next.push(u);
        }
      }
      // A ring is claimed whole before the next one starts, so a vertex takes the weight of the
      // ring it FIRST belongs to rather than of whichever neighbour reached it.
      for (const u of next) has[u] = 2;
      front = next;
    }
    // Each carried vertex takes the average of the moves of its already-moved neighbours, scaled by
    // its ring's falloff — so a bulge in the boundary carries inward as a bulge rather than as a
    // spike at one vertex.
    for (let r = 1; r <= rings; r++) {
      for (let v = 0; v < has.length; v++) {
        if (has[v] !== 2 || w[v] === 0 || w[v] === 1) continue;
        let ax = 0, ay = 0, az = 0, cnt = 0;
        for (let k = ring.offset[v]; k < ring.offset[v + 1]; k++) {
          const u = ring.list[k];
          if (w[u] <= w[v]) continue;
          ax += target[u*3]; ay += target[u*3+1]; az += target[u*3+2]; cnt++;
        }
        if (!cnt) continue;
        target[v*3] = (ax / cnt) * w[v]; target[v*3+1] = (ay / cnt) * w[v]; target[v*3+2] = (az / cnt) * w[v];
      }
    }
  }
  for (let v = 0; v < has.length; v++) {
    if (!has[v]) continue;
    positions[v*3] += target[v*3]; positions[v*3+1] += target[v*3+1]; positions[v*3+2] += target[v*3+2];
  }
  }
  return { moved, snapped, capped, passes, meanMove: snapped ? moved / snapped : 0 };
}

// Taubin lambda/mu along each loop, tangentially. Plain Laplacian shrinks a closed curve on every
// pass — the unsmoothing step is what lets `border` mean "rounder" instead of "smaller", and the
// returned perimeter ratio is what proves it did.
// ⚠ TANGENTIAL ONLY. The normal component of every step is removed, so a relaxed outline stays on
// the surface to first order and the rim does not cut into the form it came off. The step is also
// capped at 45% of the shorter incident edge, which is what stops a tight corner collapsing.
function relaxOutline(positions, normals, loops, border) {
  const iterations = Math.round(Math.max(0, Math.min(1, border)) * LIFT_LIMITS.borderIterations);
  const before = loopPerimeter(positions, loops);
  if (!iterations) return { moved: 0, perimeterRatio: 1, iterations: 0 };
  const LAM = 0.5, MU = -0.53;
  let moved = 0;
  for (let it = 0; it < iterations * 2; it++) {
    const w = (it % 2) ? MU : LAM;
    const delta = new Float32Array(positions.length);
    for (const loop of loops) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const v = loop[i], p = loop[(i + n - 1) % n], q = loop[(i + 1) % n];
        let dx = (positions[p * 3] + positions[q * 3]) * 0.5 - positions[v * 3];
        let dy = (positions[p * 3 + 1] + positions[q * 3 + 1]) * 0.5 - positions[v * 3 + 1];
        let dz = (positions[p * 3 + 2] + positions[q * 3 + 2]) * 0.5 - positions[v * 3 + 2];
        const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
        dx *= w; dy *= w; dz *= w;
        const len = Math.hypot(dx, dy, dz);
        const cap = 0.45 * Math.min(dist3(positions, v, p), dist3(positions, v, q));
        if (len > cap && len > 0) { const k = cap / len; dx *= k; dy *= k; dz *= k; }
        delta[v * 3] = dx; delta[v * 3 + 1] = dy; delta[v * 3 + 2] = dz;
      }
    }
    for (const loop of loops) for (const v of loop) {
      positions[v * 3] += delta[v * 3]; positions[v * 3 + 1] += delta[v * 3 + 1]; positions[v * 3 + 2] += delta[v * 3 + 2];
      moved += Math.hypot(delta[v * 3], delta[v * 3 + 1], delta[v * 3 + 2]);
    }
  }
  const after = loopPerimeter(positions, loops);
  return { moved, perimeterRatio: before > 0 ? after / before : 1, iterations };
}

function dist3(P, a, b) { return Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]); }
function loopPerimeter(P, loops) {
  let s = 0;
  for (const loop of loops) for (let i = 0; i < loop.length; i++) s += dist3(P, loop[i], loop[(i + 1) % loop.length]);
  return s;
}

// The in-surface direction pointing AWAY from the patch at each boundary vertex: normal cross loop
// tangent, with the sign fixed by the face the boundary half-edge belongs to. Nothing here assumes
// the patch is convex or planar.
function outwardDirections(patch, loop, normals) {
  const P = patch.positions, n = loop.length;
  const out = new Float32Array(n * 3);
  // centroid of the loop's own one-ring inside the patch, used only to fix the sign
  for (let i = 0; i < n; i++) {
    const v = loop[i], p = loop[(i + n - 1) % n], q = loop[(i + 1) % n];
    let tx = P[q * 3] - P[p * 3], ty = P[q * 3 + 1] - P[p * 3 + 1], tz = P[q * 3 + 2] - P[p * 3 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
    // ⚠ t x n, NOT n x t. boundaryLoops returns the loop in the direction the faces induce, which
    // for an outward normal runs anticlockwise seen from outside; n x t then points INTO the patch
    // and a rounded rim comes out as a groove that holds LESS than a straight wall. Caught by the
    // volume comparison in E5, not by any topology check — the groove closes perfectly.
    out[i * 3] = ty * nz - tz * ny;
    out[i * 3 + 1] = tz * nx - tx * nz;
    out[i * 3 + 2] = tx * ny - ty * nx;
    const l = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) || 1;
    out[i * 3] /= l; out[i * 3 + 1] /= l; out[i * 3 + 2] /= l;
  }
  return out;
}


// ------------------------------------------------------------------------------------------------
// THE OFFSET DIRECTION — where a lift on a face actually goes wrong
// ------------------------------------------------------------------------------------------------
//
// Two measured facts govern every offset of a surface outwards, both the opposite of the first
// reasonable guess, both found building MASQ's mask shell against a scanned head:
//
// 1. A CONVEX radius r goes to r + d and can never fold. A CONCAVE radius goes to r - d and folds
//    the moment d > r. So the hollows are where a lift self-intersects — the eye sockets, the
//    nostril wings, the inside of a knee — and giving them MORE clearance makes it worse, not
//    better. Measured on a full-face mask at a 1 mm gap: 2,607 inverted faces at uniform offset,
//    3,027 with 3 mm of extra hollow clearance, rising monotonically.
//
// 2. The governing curvature is k_min, the MOST concave principal direction, not the mean. In a
//    crease one principal curvature is large and the other near zero, so H = (k1+k2)/2 reads the
//    radius as TWICE what it is. Limiting by 1/|H| cut inversions 25%; by 1/|k_min|, 53%.
//
// So `foldOffset` below is derived from k_min, and `stats.inverted` counts what the build actually
// produced rather than trusting the derivation. Both numbers are reported RAW: a clamp whose
// derivation is never printed beside it is documentation, not a rule.

// The most concave normal curvature at each vertex, from the one-ring:
//     k_n(j) = -2 * (n_i . (p_j - p_i)) / |p_j - p_i|^2
//
// ⚠ THE MINUS SIGN IS THE WHOLE TEST. Without it a unit sphere with OUTWARD normals reads
// k_n = -1/R everywhere, so the most convex plate in existence reports a finite fold offset and the
// guard fires on the one case that can never fold. Measured: a cube-sphere cap read "folds at
// 0.657" before the sign was fixed and Infinity after. Signed so that convex is POSITIVE, which is
// the usual convention and the one the rest of this comment assumes.
// which is the standard discrete normal-curvature estimate in the direction of neighbor j.
// The MINIMUM over j is k_min, negative where the surface is concave. No shape operator needed:
// the minimum over the ring is the quantity the fold test wants, directly.
function minNormalCurvature(positions, normals, quads, nv) {
  const ring = vertexRing(quads, nv);
  const k = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    let lo = 0;
    for (let a = ring.offset[i]; a < ring.offset[i + 1]; a++) {
      const j = ring.list[a];
      const dx = positions[j * 3] - positions[i * 3], dy = positions[j * 3 + 1] - positions[i * 3 + 1], dz = positions[j * 3 + 2] - positions[i * 3 + 2];
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 < 1e-20) continue;
      const kn = -2 * (normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * dz) / l2;
      if (kn < lo) lo = kn;
    }
    k[i] = lo;
  }
  return k;
}

// The outward displacement at which the most concave place on the patch starts to fold.
// Infinity when nothing is concave, which is the honest answer for a convex plate.
function foldOffset(kmin, safety = LIFT_LIMITS.foldSafety) {
  let worst = 0;
  for (let i = 0; i < kmin.length; i++) if (kmin[i] < worst) worst = kmin[i];
  return worst < 0 ? safety / -worst : Infinity;
}

function vertexRing(quads, nv) {
  const set = [];
  for (let i = 0; i < nv; i++) set.push(new Set());
  for (let f = 0; f < quads.length / 4; f++) for (let e = 0; e < 4; e++) {
    const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
    set[a].add(b); set[b].add(a);
  }
  const offset = new Int32Array(nv + 1);
  for (let i = 0; i < nv; i++) offset[i + 1] = offset[i] + set[i].size;
  const list = new Int32Array(offset[nv]);
  let w = 0;
  for (let i = 0; i < nv; i++) for (const j of set[i]) list[w++] = j;
  return { offset, list };
}

// ⚠ SMOOTH THE DIRECTION, NEVER THE SURFACE. A mesh that arrived by midpoint subdivision is still
// piecewise linear, so its normal field carries the coarse cage's facets; offsetting along normals
// a fraction of a degree apart turns those facets into visible RIDGES, worst where the offset is
// largest and the curvature lowest. Averaging the DIRECTIONS fixes it and cannot shrink anything:
// no offset distance changes, no vertex moves, no boundary shifts. Measured on the reference face,
// mean dihedral across the offset surface 7.65 degrees at 0 passes, 5.68 at 12, covered area
// identical. Catmull-Clark would smooth the surface instead — and MOVE it, which is the one thing a
// parametric lift may not do.
function smoothDirections(dirs, ring, nv, passes) {
  if (!passes) return dirs;
  let cur = dirs;
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(cur.length);
    for (let i = 0; i < nv; i++) {
      let x = cur[i * 3], y = cur[i * 3 + 1], z = cur[i * 3 + 2], n = 1;
      for (let a = ring.offset[i]; a < ring.offset[i + 1]; a++) {
        const j = ring.list[a];
        x += cur[j * 3]; y += cur[j * 3 + 1]; z += cur[j * 3 + 2]; n++;
      }
      const l = Math.hypot(x, y, z) || 1;
      next[i * 3] = x / l; next[i * 3 + 1] = y / l; next[i * 3 + 2] = z / l;
    }
    cur = next;
  }
  return cur;
}

// How many faces the offset actually turned inside out, by comparing each face's own normal before
// and after. A COUNT of the defect itself, rather than a prediction of it.
function invertedFaces(srcPositions, quads, outPositions) {
  const fn = (P, f) => {
    const a = quads[f * 4] * 3, b = quads[f * 4 + 1] * 3, c = quads[f * 4 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let n = 0;
  const which = [];
  for (let f = 0; f < quads.length / 4; f++) {
    const A = fn(srcPositions, f), B = fn(outPositions, f);
    if (A[0] * B[0] + A[1] * B[1] + A[2] * B[2] <= 0) { n++; if (which.length < 32) which.push(f); }
  }
  invertedFaces.last = which;          // the first few, for a reader locating them
  return n;
}

// ------------------------------------------------------------------------------------------------
// BUILD
// ------------------------------------------------------------------------------------------------

/**
 * mesh: { positions, quads, normals, mask }   opts: LIFT_DEFAULTS
 * Returns { ok, positions, quads, stats } or { ok:false, reason, message }.
 */
export function buildLift(mesh, opts = {}) {
  const o = { coverage: COVERAGE, ...LIFT_DEFAULTS, ...opts };
  o.thickness = Math.max(0, o.thickness);
  o.rim = Math.max(0, Math.min(1, o.rim));
  const { positions, quads, normals } = mesh;
  /* MASQ: per-vertex wall and gap, indexed by SOURCE vertex. Absent, every
   * reader falls back to the scalar and this file behaves exactly as Pgon's. */
  const TH_A = o.thicknessAt, OF_A = o.offsetAt;
  const THv = (src) => (TH_A ? TH_A[src] : o.thickness);
  const OFv = (src) => (OF_A ? OF_A[src] : o.offset);
  let mask = mesh.mask;
  if (!quads || !quads.length) return { ok: false, reason: 'no-quads', message: 'Lift builds from quads. This level is a triangle mesh — Remesh it first.' };

  // ⚠ THE MARGIN MOVES THE MASK, NOT THE THRESHOLD, and it uses the SAME distance-based kernel
  // Mask's own Grow and Shrink use — imported rather than reimplemented, so a margin of 2 mm and two
  // presses of Grow cannot come to mean different amounts of surface. The kernel measures real
  // distance across the surface, so the margin is the same amount of form at every subdivision
  // level; a ring count would be the grid's answer rather than the document's.
  if (o.margin) {
    const ring = mesh.ring || vertexRing(quads, positions.length / 3);
    mask = o.margin > 0
      ? dilate(mask, ring.offset, ring.list, positions.length / 3, o.margin, positions)
      : erode(mask, ring.offset, ring.list, positions.length / 3, -o.margin, positions);
  }
  const sel0 = faceSelection(quads, mask, o.coverage);
  // ⚠ ADJACENCY MAY BE HANDED IN. It is a property of the TOPOLOGY alone — a sculpt stroke moves
  // vertices and cannot change it — and it is the one part of this build that costs a Map entry per
  // face of the WHOLE source mesh rather than of the patch. A caller re-forming a plate on every
  // stroke keeps it; a caller that hands in a stale one has changed the topology and is wrong about
  // more than this, so it is checked against the face count rather than trusted.
  const adj = (opts.adjacency && opts.adjacency.offset && opts.adjacency.offset.length === quads.length / 4 + 1)
    ? opts.adjacency : faceAdjacency(quads);
  const clean = despur(sel0, adj);
  let picked = 0; for (let i = 0; i < clean.sel.length; i++) if (clean.sel[i]) picked++;
  if (!picked) {
    const any = sel0.some ? false : false;
    let raw = 0; for (let i = 0; i < sel0.length; i++) if (sel0[i]) raw++;
    return { ok: false, reason: 'empty-selection',
      message: raw ? `That region came to ${raw} face${raw === 1 ? '' : 's'}, each held on by a single edge. Paint more, or raise Margin.`
                   : (o.margin < 0 ? `Margin took the whole region away. Raise it, or paint more.` : `Nothing is masked yet — drag on the form first.`) };
  }

  const patch = extractPatch(positions, quads, clean.sel);
  const splits = splitPinchVertices(patch);
  const rawN = new Float32Array(patch.nv * 3);
  for (let i = 0; i < patch.nv; i++) {
    const s = patch.srcVert[i] * 3;
    rawN[i * 3] = normals[s]; rawN[i * 3 + 1] = normals[s + 1]; rawN[i * 3 + 2] = normals[s + 2];
  }
  const ring = vertexRing(patch.quads, patch.nv);
  // ⚠ THE FOLD TEST USES THE RAW NORMALS, THE DISPLACEMENT USES THE SMOOTHED ONES. Smoothing the
  // direction is what removes offset ridges; measuring curvature against a smoothed normal field
  // would flatter the very creases the test exists to find.
  const kmin = minNormalCurvature(patch.positions, rawN, patch.quads, patch.nv);
  const safeAt = foldOffset(kmin);
  const pn = smoothDirections(rawN, ring, patch.nv, Math.max(0, Math.round(o.directionSmooth)));
  const loops = boundaryLoops(patch.quads, patch.nv);
  if (!loops.length) {
    // the mask covered the whole closed form: there is no rim to build and the plate is the form
    return { ok: false, reason: 'no-boundary',
      message: 'The mask covers the whole closed surface, so there is no outline to lift along. Unmask a region, or use Offset on the object itself.' };
  }
  const onLoop = new Uint8Array(patch.nv);
  for (const l of loops) for (const v of l) onLoop[v] = 1;
  // ⚠ THE CONTOUR IS MARCHED FROM THE MASK THE SELECTION ACTUALLY USED — the margin has already
  // moved it, so marching the caller's original field would put the rim on a line the plate is not
  // built to. Same array, same level, one source.
  const patchEdge = medianEdgeOf(patch.positions, patch.quads);
  const contour = fieldLoops(positions, quads, mask, { level: o.coverage }).map(L => L.pts);
  const snap = snapOutlineToContour(patch.positions, pn, loops, contour, patchEdge,
                                    o.snapPasses != null ? o.snapPasses : SNAP_PASSES, ring);
  const outline = relaxOutline(patch.positions, pn, loops, o.border);

  const openSheet = o.thickness <= 0;
  const medianEdge = patchEdge;
  const rimRows = rimRowsFor(o.thickness, medianEdge, o.rim);
  const rings = openSheet ? 0 : rimRows;
  const nOuter = patch.nv;
  const loopIdx = new Map();          // patch vertex -> {loop, i}
  loops.forEach((l, li) => l.forEach((v, i) => loopIdx.set(v, [li, i])));

  const outPos = [];
  /* MASQ: which SOURCE vertex each cage vertex came from, -1 for none.
   * A caller carrying a per-vertex field onto the plate — MASQ rides the motion
   * map on it — otherwise has to rediscover the relationship geometrically, and
   * a nearest-vertex lookup over the SUBDIVIDED plate measured 669 ms against
   * 4 ms for the grid it needs. The structural answer is free and exact.
   * Rim vertices take the source of the loop vertex they were spun from. */
  const srcOf = [];
  let srcTag = -1;
  const outPos_push = (x, y, z) => { outPos.push(x, y, z); srcOf.push(srcTag); return outPos.length / 3 - 1; };
  const push = outPos_push;
  const P = patch.positions;
  // outer shell
  for (let i = 0; i < patch.nv; i++) {
    const sv = patch.srcVert[i];
    srcTag = sv;
    const h = OFv(sv) + THv(sv);
    push(P[i * 3] + pn[i * 3] * h, P[i * 3 + 1] + pn[i * 3 + 1] * h, P[i * 3 + 2] + pn[i * 3 + 2] * h);
  }
  srcTag = -1;
  const outQuads = [];
  for (let f = 0; f < patch.quads.length / 4; f++) {
    outQuads.push(patch.quads[f * 4], patch.quads[f * 4 + 1], patch.quads[f * 4 + 2], patch.quads[f * 4 + 3]);
  }

  // Measured on the shell that was actually built, beside the offset the curvature says is safe.
  // The requested reach is printed with it: a clamp reported without its raw derivation is a
  // sentence nobody can check.
  const reach = o.offset + o.thickness;
  const inverted = invertedFaces(patch.positions, patch.quads, Float32Array.from(outPos.slice(0, patch.nv * 3)));
  let stats = { snap, faces: patch.faces, splits, loops: loops.length, despurRemoved: clean.removed, despurFilled: clean.filled,
                outlineIterations: outline.iterations, perimeterRatio: outline.perimeterRatio,
                rimVisible: !openSheet && rimRows >= 2 && o.rim > 0, rimRows, medianEdge, openSheet,
                reach, foldsAt: safeAt, inverted, invertedAt: invertedFaces.last, directionSmooth: Math.max(0, Math.round(o.directionSmooth)) };

  if (!openSheet) {
    // inner shell, reversed
    const innerBase = outPos.length / 3;
    for (let i = 0; i < patch.nv; i++) {
      srcTag = patch.srcVert[i];
      const h = OFv(srcTag);
      push(P[i * 3] + pn[i * 3] * h, P[i * 3 + 1] + pn[i * 3 + 1] * h, P[i * 3 + 2] + pn[i * 3 + 2] * h);
    }
    srcTag = -1;
    for (let f = 0; f < patch.quads.length / 4; f++) {
      outQuads.push(innerBase + patch.quads[f * 4 + 3], innerBase + patch.quads[f * 4 + 2],
                    innerBase + patch.quads[f * 4 + 1], innerBase + patch.quads[f * 4]);
    }
    // rim: rings 1..rings-1 are new, ring 0 is the outer shell and ring `rings` is the inner
    for (let li = 0; li < loops.length; li++) {
      const loop = loops[li], n = loop.length;
      const dirs = outwardDirections(patch, loop, pn);
      const ringIdx = [];
      ringIdx.push(loop.slice());                                   // ring 0 = outer
      for (let r = 1; r < rings; r++) {
        const s = r / rings, phi = s * Math.PI;
        /* MASQ: the scalar `h` and `b` that stood here are computed per vertex
         * inside the loop now. Left out rather than left unused, so nothing
         * reads a scalar that no longer decides anything. */
        const ring = [];
        for (let i = 0; i < n; i++) {
          const v = loop[i], sv = patch.srcVert[v];
          srcTag = sv;
          /* MASQ: the bead's own section follows the wall at THIS vertex, so a
           * rim that thins into a crease rolls at the gauge it actually has.
           * `s` and `phi` are the ring's, so every vertex of a ring is the same
           * way round its own bead and the quads stay planar-ish. */
          const tv = THv(sv), hv = OFv(sv) + tv * 0.5 + (tv * 0.5) * Math.cos(phi);
          const bv = o.rim * (tv * 0.5) * Math.sin(phi);
          ring.push(push(P[v * 3] + pn[v * 3] * hv + dirs[i * 3] * bv,
                         P[v * 3 + 1] + pn[v * 3 + 1] * hv + dirs[i * 3 + 1] * bv,
                         P[v * 3 + 2] + pn[v * 3 + 2] * hv + dirs[i * 3 + 2] * bv));
        }
        ringIdx.push(ring);
      }
      ringIdx.push(loop.map(v => innerBase + v));                   // ring `rings` = inner
      for (let r = 0; r < rings; r++) {
        const A = ringIdx[r], B = ringIdx[r + 1];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          // ⚠ THE RING EDGE MUST RUN j -> i, NOT i -> j. boundaryLoops returns the loop in the
          // direction the patch's own faces induce, so the outer shell already uses the half-edge
          // loop[i] -> loop[j]; a neighboring face across that edge has to use the REVERSE or the
          // surface is not consistently oriented. The same argument at the far end lands on the
          // inner shell, whose winding is reversed, so one ordering serves every ring.
          outQuads.push(A[j], A[i], B[i], B[j]);
        }
      }
    }
  }

  const P2 = Float32Array.from(outPos);
  const Q2 = Int32Array.from(outQuads);
  // ⚠ ORIENT BY THE NORMALS, NOT BY THE SOURCE'S WINDING. The offset direction is what defines
  // which side is out, and a caller whose winding disagrees with its normal field would otherwise
  // get a shell built inside-out that is closed, manifold, one piece and passes every count.
  let reoriented = false;
  if (faceNormalSign(P2, Q2, pn, patch.nv) < 0) {
    for (let f = 0; f < Q2.length / 4; f++) { const t = Q2[f * 4 + 1]; Q2[f * 4 + 1] = Q2[f * 4 + 3]; Q2[f * 4 + 3] = t; }
    reoriented = true;
  }
  stats.reoriented = reoriented;
  const inv = liftInvariants(P2, Q2);
  stats = { ...stats, ...inv, verts: P2.length / 3, quads: Q2.length / 4 };
  if (!openSheet && inv.openEdges) {
    return { ok: false, reason: 'not-closed', stats,
      message: `The lift came out with ${inv.openEdges} open edge${inv.openEdges === 1 ? '' : 's'} where it should be closed.` };
  }
  if (inv.inconsistent) {
    return { ok: false, reason: 'not-oriented', stats,
      message: `The lift came out with ${inv.inconsistent} edge${inv.inconsistent === 1 ? '' : 's'} whose two faces disagree about which side is out.` };
  }
  for (let i = 0; i < P2.length; i++) if (!Number.isFinite(P2[i])) {
    return { ok: false, reason: 'non-finite', stats, message: 'The lift produced a coordinate that is not a number.' };
  }
  /* MASQ: srcOf rides out with the geometry — see the note beside `push`. */
  return { ok: true, positions: P2, quads: Q2, srcOf: Int32Array.from(srcOf), stats };
}

// Sum over the outer shell of (winding normal . offset direction). Summed rather than sampled: one
// face can be degenerate or non-planar, a whole shell cannot be wrong about which way it faces.
function faceNormalSign(P, Q, dirs, nOuterVerts) {
  let acc = 0;
  for (let f = 0; f < Q.length / 4; f++) {
    const a = Q[f * 4], b = Q[f * 4 + 1], c = Q[f * 4 + 2];
    if (a >= nOuterVerts || b >= nOuterVerts || c >= nOuterVerts) continue;   // outer shell only
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    acc += nx * dirs[a * 3] + ny * dirs[a * 3 + 1] + nz * dirs[a * 3 + 2];
  }
  return acc;
}

// ------------------------------------------------------------------------------------------------
// MEASUREMENT
// ------------------------------------------------------------------------------------------------

// The median edge length of a quad patch — the document's own unit, and what the rim row count is
// measured against. Median rather than mean: one long edge at a pole would drag a mean.
export function medianEdgeOf(positions, quads) {
  const L = [];
  for (let f = 0; f < quads.length / 4; f++) for (let e = 0; e < 4; e++) {
    const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
    if (a < b) L.push(Math.hypot(positions[a*3]-positions[b*3], positions[a*3+1]-positions[b*3+1], positions[a*3+2]-positions[b*3+2]));
  }
  if (!L.length) return 0;
  L.sort((x, y) => x - y);
  return L[L.length >> 1];
}

export function liftInvariants(positions, quads) {
  const nf = quads.length / 4, nv = positions.length / 3;
  // ⚠⚠ THE UNDIRECTED COUNT CANNOT SEE AN INCONSISTENT ORIENTATION, AND THAT IS HOW A REVERSED RIM
  // SHIPPED. A shell whose rim is wound backwards uses every edge exactly twice, so it reads as
  // closed, manifold and one piece — every count green — while its volume comes out at a third of
  // the truth with the wrong sign. The directed count is the test: in a consistently oriented
  // surface each edge appears once as a->b and once as b->a, so a pair going the SAME way is a
  // seam. Planted and confirmed red before this line was written.
  const use = new Map(), dir = new Map();
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    use.set(k, (use.get(k) || 0) + 1);
    const dk = a * 4294967296 + b;
    dir.set(dk, (dir.get(dk) || 0) + 1);
  }
  let openEdges = 0, nonManifoldEdges = 0, inconsistent = 0;
  for (const n of use.values()) { if (n === 1) openEdges++; else if (n > 2) nonManifoldEdges++; }
  for (const n of dir.values()) if (n > 1) inconsistent++;
  // components over the vertex graph
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let f = 0; f < nf; f++) for (let e = 0; e < 4; e++) {
    const a = find(quads[f * 4 + e]), b = find(quads[f * 4 + (e + 1) % 4]);
    if (a !== b) parent[a] = b;
  }
  const roots = new Set(); for (let i = 0; i < nv; i++) roots.add(find(i));
  let degenerate = 0;
  for (let f = 0; f < nf; f++) {
    const a = quads[f * 4], b = quads[f * 4 + 1], c = quads[f * 4 + 2], d = quads[f * 4 + 3];
    if (a === b || b === c || c === d || d === a || a === c || b === d) degenerate++;
  }
  return { openEdges, nonManifoldEdges, inconsistent, components: roots.size, degenerate };
}

// Signed volume via the divergence theorem, triangulating each quad on its 0-2 diagonal. Zero for
// an open sheet, which is the point: it is what separates "a plate" from "a surface".
export function liftVolume(positions, quads) {
  let v = 0;
  const tri = (a, b, c) => {
    v += (positions[a * 3] * (positions[b * 3 + 1] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3 + 1])
        - positions[a * 3 + 1] * (positions[b * 3] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3])
        + positions[a * 3 + 2] * (positions[b * 3] * positions[c * 3 + 1] - positions[b * 3 + 1] * positions[c * 3])) / 6;
  };
  for (let f = 0; f < quads.length / 4; f++) {
    const a = quads[f * 4], b = quads[f * 4 + 1], c = quads[f * 4 + 2], d = quads[f * 4 + 3];
    tri(a, b, c); tri(a, c, d);
  }
  return v;
}

// ------------------------------------------------------------------------------------------------
// THE MASK AS A STORED PARAMETER
// ------------------------------------------------------------------------------------------------
//
// A live lift re-evaluates whenever the surface under it moves, so the mask it was drawn with stops
// being tooling and becomes a parameter: without it, clearing the mask to do something else would
// silently reshape or empty the lift. Stored as a SNAPSHOT, never a reference to the live mask.
//
// ⚠ THE VERTEX COUNT IS STORED WITH IT AND CHECKED, NOT REINTERPRETED. The snapshot is per-vertex,
// so it is valid exactly as long as vertex identity is. Divide and sculpt strokes keep it; Remesh,
// Rebuild and Add detail build a new vertex set and the stored indices then address a topology that
// no longer exists. One integer and one comparison is the whole guard.
//
// 8-bit quantized, run-length encoded when that is smaller than a quarter of the raw array and
// base64 otherwise, because a soft brush leaves a gradient whose runs are length 1.

export function encodeMask(mask) {
  const nv = mask.length;
  const q = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) q[i] = Math.max(0, Math.min(255, Math.round(mask[i] * 255)));
  const rle = [];
  let i = 0;
  while (i < nv) {
    const v = q[i]; let n = 1;
    while (i + n < nv && q[i + n] === v && n < 65535) n++;
    rle.push(v, n); i += n;
  }
  if (rle.length <= nv / 4) return { nv, enc: 'rle', data: rle };
  let s = '';
  for (let k = 0; k < nv; k += 4096) s += String.fromCharCode.apply(null, q.subarray(k, Math.min(nv, k + 4096)));
  return { nv, enc: 'b64', data: btoa(s) };
}

export function decodeMask(rec) {
  if (!rec || !rec.nv) return null;
  const out = new Float32Array(rec.nv);
  if (rec.enc === 'rle') {
    let w = 0;
    for (let k = 0; k + 1 < rec.data.length; k += 2) {
      const v = rec.data[k] / 255, n = rec.data[k + 1];
      for (let j = 0; j < n && w < rec.nv; j++) out[w++] = v;
    }
    return out;
  }
  const bin = atob(rec.data);
  for (let i = 0; i < rec.nv && i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}

// How far the live mask has drifted from the one a lift was made with, in faces rather than in
// vertices — faces are what the lift is built out of, so this is the number that predicts what
// re-clipping would change.
export function maskDrift(quads, oldMask, newMask, coverage) {
  const a = faceSelection(quads, oldMask, coverage), b = faceSelection(quads, newMask, coverage);
  let added = 0, removed = 0;
  for (let f = 0; f < a.length; f++) { if (!a[f] && b[f]) added++; else if (a[f] && !b[f]) removed++; }
  return { added, removed, same: added === 0 && removed === 0 };
}

// Recovery when the vertex count HAS changed: take each new vertex's value from the nearest old
// vertex. Approximate at the boundary and faithful to intent, and the caller is expected to say so
// before running it rather than doing it silently.
export function resampleMask(oldPositions, oldMask, newPositions) {
  const nvNew = newPositions.length / 3, nvOld = oldMask.length;
  const out = new Float32Array(nvNew);
  // uniform grid over the old points, cell ~ the old mean spacing
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nvOld; i++) for (let a = 0; a < 3; a++) {
    const v = oldPositions[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v;
  }
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const dim = Math.max(1, Math.min(64, Math.round(Math.cbrt(nvOld) )));
  const cell = span / dim;
  const key = (x, y, z) => `${x}|${y}|${z}`;
  const grid = new Map();
  const cellOf = (p, i) => [Math.floor((p[i * 3] - mn[0]) / cell), Math.floor((p[i * 3 + 1] - mn[1]) / cell), Math.floor((p[i * 3 + 2] - mn[2]) / cell)];
  for (let i = 0; i < nvOld; i++) {
    const c = cellOf(oldPositions, i), k = key(c[0], c[1], c[2]);
    let l = grid.get(k); if (!l) { l = []; grid.set(k, l); }
    l.push(i);
  }
  for (let i = 0; i < nvNew; i++) {
    const c = cellOf(newPositions, i);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= dim && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const l = grid.get(key(c[0] + dx, c[1] + dy, c[2] + dz));
        if (!l) continue;
        for (const j of l) {
          const d = (newPositions[i * 3] - oldPositions[j * 3]) ** 2
                  + (newPositions[i * 3 + 1] - oldPositions[j * 3 + 1]) ** 2
                  + (newPositions[i * 3 + 2] - oldPositions[j * 3 + 2]) ** 2;
          if (d < bestD) { bestD = d; best = j; }
        }
      }
    }
    out[i] = best >= 0 ? oldMask[best] : 0;
  }
  return out;
}
