/* ================================================================
   MESHKERNEL — v00000-002 — CPU PORT (critique §2/§1a)
   ================================================================
   v00000-001 ran subdivision + every brush/mask/gantry/stain op as
   WebGPU compute passes. Decided: invert that. Pgon's
   whole mission is reach across "most devices" for a free student
   tool, and every operation here is per-vertex or one-ring at
   mesh scales that top out in the tens of thousands of vertices —
   embarrassingly cheap in plain JS, milliseconds not frames. WebGPU
   compute bought nothing at this scale and made the exclusionary
   API mandatory while the universal one (a browser with JS) was
   never used. See Pgon_CRITIQUE_RESPONSE_v00000-001.txt.

   Most of v00000-001 was ALREADY plain JS with no GPU dependency —
   buildCubeSphere/buildSkullBase/buildTopology/computeQuadNormals/
   buildVertexNeighbors/closestPointOnMesh are copied here UNCHANGED
   (byte-identical logic, just re-homed into this file so callers
   only need one import). Only 5 functions actually touched a GPU
   device: subdivideCatmullClark and the four createXPass() brush/
   mask/gantry/stain compute factories. Those are the only ports
   below — same math, same function names, no `device` parameter,
   synchronous (no `await`, no GPU readback round-trip).

   Real multires (per-vertex tangent-space deltas that propagate
   across Subdiv-level switches — critique §1a, the actual mission-
   critical fix, not just the engine swap) is NOT in this file; it's
   a data-model change in index.html's strata management, layered on
   top of this CPU kernel.
   ================================================================ */

// The alpha sampler is IMPORTED rather than reimplemented here. Both brush twins
// need it, and a hand-copied bilinear fetch is exactly the kind of thing that drifts — the
// same argument that put focalExponent behind one shared helper.
import { sampleAlpha } from '../alphas/alphas.v00000-001.js';

// ---- Primitives -------------------------------------------------------------------------
// Every one of these is a QUAD mesh with welded, closed topology, because everything
// downstream assumes that: Catmull-Clark needs quads, the Strata ladder needs a closed
// surface, and Retopology's cage needs a known Euler characteristic. A primitive that
// arrived as a triangle soup would be a second-class citizen from the first frame.

// The shared cube cage: six N x N faces, welded along shared edges by position key. This is
// buildCubeSphere's own construction with the normalize-to-sphere step left out — factored so
// the two cannot drift, since the welding is the fiddly part and the projection is one line.
// ⚠ HOW CLOSE TWO CAGE VERTICES MUST BE TO COUNT AS ONE. This was 1e-4 and that was two orders of
// magnitude coarser than anything it protects against. The shared vertices it exists to merge are
// not near-misses: each face computes them as `n + u*s + v*t` over small integers and the same s,t,
// so the two faces meeting on an edge produce bit-identical values, and the projection on top is a
// pure function of those. The tolerance was only ever absorbing float noise that is not there.
//
// ⚠ AND ITS COARSENESS WAS A REAL COST SOMEWHERE ELSE. It set a floor on how fine any cage feature
// could be before the weld fused it — which is what forced buildCone's tip to stay blunt, since a
// tip disc smaller than the tolerance collapses into a degenerate face. Tightening it here is what
// lets a cone actually come to a point. Verified at 1e-8 across every primitive and density: all
// still weld to a closed manifold, and the sphere's vertex count is unchanged at 3,458, so nothing
// was relying on the slack. 1e-6 is what ships — a hundredfold tighter than before and still a
// hundredfold looser than the tightest value tested to work.
const CAGE_WELD = 1e-6;

function buildCubeCage(N, project) {
  const faceAxes = [
    { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
    { u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },
    { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
    { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
    { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
    { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
  ];
  const posMap = new Map(), positions = [], quads = [];
  const key = (x, y, z) => Math.round(x / CAGE_WELD) + '_' + Math.round(y / CAGE_WELD) + '_' + Math.round(z / CAGE_WELD);
  function vert(face, i, j) {
    const s = -1 + 2*i/N, t = -1 + 2*j/N;
    const { u, v, n } = face;
    const p = project(n[0] + u[0]*s + v[0]*t, n[1] + u[1]*s + v[1]*t, n[2] + u[2]*s + v[2]*t);
    const k = key(p[0], p[1], p[2]);
    let idx = posMap.get(k);
    if (idx === undefined) { idx = positions.length / 3; positions.push(p[0], p[1], p[2]); posMap.set(k, idx); }
    return idx;
  }
  for (const face of faceAxes) {
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      quads.push(vert(face, i, j), vert(face, i+1, j), vert(face, i+1, j+1), vert(face, i, j+1));
    }
  }
  return { positions: new Float32Array(positions), quads: new Uint32Array(quads) };
}

// A box. The cube cage with no projection at all — scaled to roughly match the sphere's
// footprint so switching primitives does not jump the camera.
// ⚠ EVERY PRIMITIVE TAKES ITS PROPORTIONS AS AN OPTIONS OBJECT WHOSE DEFAULTS ARE THE SHAPE THAT
// SHIPPED. Called with no options each of these returns exactly what it always did, to the bit —
// which is what lets a saved project made before the sliders existed reopen unchanged, and what
// keeps the existing call sites (the retopology cage, the fresh-boot ladder) out of the blast
// radius of a proportion slider.
export function buildBox(N, { width = 0.72, height = 0.72, depth = 0.72 } = {}) {
  return buildCubeCage(N, (x, y, z) => [x * width, y * height, z * depth]);
}

// A plane, as a THIN CLOSED SLAB rather than an open grid, and this is a real constraint rather
// than a shortcut. buildTopology throws on any edge with only one face — Catmull-Clark here
// assumes a closed manifold, and the whole Strata ladder is built on that. A zero-thickness sheet
// has a boundary at every edge, so supporting one honestly would mean boundary subdivision rules
// through the entire ladder rather than one more builder.
//
// It is also the version that can be PRINTED. A surface with no thickness is not a solid, and
// students here are taking work to 3D printers; a slab thin enough to read as a plane and thick
// enough to exist is the shape that survives that trip. The thickness floor is not cosmetic: the
// cage welds vertices by rounded position, so a slab thinner than the weld tolerance would fuse
// its own top and bottom faces into one degenerate sheet.
// A ROUNDED BOX. The six primitives before it could not make one: a box has hard corners, a sphere
// has none, and nothing sat between them — which is most manufactured objects.
//
// ⚠ ROUNDNESS IS A BLEND TOWARD A BALL, NOT A FILLET RADIUS, AND THE CONTROL IS NAMED FOR WHAT IT
// DOES. A true fillet is the Minkowski sum of a box and a ball: the flats stay flat at their full
// size and only a band of exactly radius r turns the corner. This interpolates every point of the
// cage toward its own normalized direction, so the flats bow slightly as roundness rises. It reads
// correctly and it is honest to drag, but a caller must not read the number as millimeters of
// corner radius — hence "Roundness" on the control rather than "Fillet", and a range that stops
// short of 1 where the shape would simply be the sphere primitive again under another name.
export function buildRoundedBox(N, { width = 0.72, height = 0.72, depth = 0.72, roundness = 0.35 } = {}) {
  const k = Math.max(0, Math.min(1, roundness));
  return buildCubeCage(N, (x, y, z) => {
    // On a cube cage max(|x|,|y|,|z|) is 1, so this length is never zero and needs no guard —
    // but one is kept anyway because buildCubeCage's contract does not promise that.
    const l = Math.hypot(x, y, z) || 1;
    return [
      (x * (1 - k) + (x / l) * k) * width,
      (y * (1 - k) + (y / l) * k) * height,
      (z * (1 - k) + (z / l) * k) * depth,
    ];
  });
}

export function buildPlane(N, { width = 0.95, depth = 0.95, thickness = 0.06 } = {}) {
  const t = Math.max(0.02, thickness);
  return buildCubeCage(N, (x, y, z) => [x * width, y * t, z * depth]);
}

// A cone, built by tapering the cylinder's own square-to-disc map along the height.
//
// ⚠ THE TIP NEVER CLOSES COMPLETELY, and that is a correctness bound rather than a preference. The
// cage welds by position, so a taper that reached exactly zero would fuse the entire top face into
// a single vertex: every top quad would have four identical corners and every quad touching the
// apex two, which is a degenerate face with no area and no normal — not a closed manifold with a
// point on it.
//
// ⚠ AND THE FLOOR IS DERIVED FROM A MEASUREMENT, NOT PICKED, because the bound depends on the cone
// rather than being a property of cones. What must not happen is two neighboring vertices of the
// tip disc rounding to the same weld key; their spacing is the cage's own step (2/N) scaled by the
// tip disc's radius, so the safe tip RISES with mesh density and falls as the cone gets wider.
//
// ⚠ IT WAS WRITTEN AS A CONSTANT FIRST AND WAS WRONG TWICE, which is why the number below comes
// from a sweep rather than from the argument. A flat 0.01 fused four quads at the shipping density
// and took the surface to genus -2. Deriving it but guessing the margin at ten times the weld
// tolerance then passed at N=24 and failed again at N=64. Binary-searching the true minimum across
// N in 8..96 and radius in 0.2..1.5 puts the required neighbor spacing at 1.4e-3 to 2.4e-3 —
// so the margin is TWENTY-FIVE times the weld tolerance, chosen above the worst case measured
// rather than at it, because what a floor is for is the densities nobody has tried yet.
export function buildCone(N, { radius = 0.70, height = 0.86, tip = 0.05 } = {}) {
  // ⚠ READS THE WELD TOLERANCE RATHER THAN RESTATING IT. A second copy of that number here is a
  // copy that goes stale the day the tolerance moves — and it did move, which is exactly how this
  // floor would have silently become forty times more conservative than it needs to be.
  const tipFloor = (40 * CAGE_WELD * N) / (2 * Math.max(1e-6, radius));
  const k = Math.max(tipFloor, tip);
  return buildCubeCage(N, (x, y, z) => {
    const u = x * Math.sqrt(Math.max(0, 1 - (z*z) / 2));
    const v = z * Math.sqrt(Math.max(0, 1 - (x*x) / 2));
    const up = (y + 1) / 2;              // 0 at the base, 1 at the tip
    const taper = 1 + (k - 1) * up;
    return [u * radius * taper, y * height, v * radius * taper];
  });
}

// A cylinder, as a DEFORMED BOX rather than a hand-built tube-plus-caps. The square-to-disc
// map below sends the cube's cross-section to a circle while leaving height alone, so the
// side becomes a tube and the top/bottom faces become genuine quad discs. Topology is correct
// BY CONSTRUCTION because nothing about it changed — the same argument buildSkullBase makes
// for displacing buildCubeSphere's own welded cage. Hand-building caps as a quad fan is where
// this normally goes wrong (a pole, a triangle, or a non-manifold seam).
export function buildCylinder(N, { radius = 0.62, height = 0.78 } = {}) {
  return buildCubeCage(N, (x, y, z) => {
    // Fernando/Shirley square-to-disc: exact at the axes, area-reasonable elsewhere.
    const u = x * Math.sqrt(Math.max(0, 1 - (z*z) / 2));
    const v = z * Math.sqrt(Math.max(0, 1 - (x*x) / 2));
    return [u * radius, y * height, v * radius];
  });
}

// A torus. NOT a deformed cube — it cannot be, and that is the point worth teaching: a torus
// is genus 1, so its Euler characteristic is 0 rather than 2, and Retopology's shrink-wrap
// cage (which can only wrap a genus-0 blob) will honestly refuse it. Pgon has explained that
// limit elsewhere without otherwise shipping a shape that demonstrates it.
//
// Built as a grid that wraps in BOTH directions, with modulo indices doing the welding —
// there are no seams to merge because the last row simply indexes the first.
export function buildTorus(ringSegs, tubeSegs, ringR = 0.62, tubeR = 0.26) {
  const positions = new Float32Array(ringSegs * tubeSegs * 3);
  const quads = new Uint32Array(ringSegs * tubeSegs * 4);
  for (let i = 0; i < ringSegs; i++) {
    const a = (i / ringSegs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < tubeSegs; j++) {
      const b = (j / tubeSegs) * Math.PI * 2, cb = Math.cos(b), sb = Math.sin(b);
      const idx = i * tubeSegs + j;
      positions[idx*3]     = (ringR + tubeR * cb) * ca;
      positions[idx*3 + 1] = tubeR * sb;
      positions[idx*3 + 2] = (ringR + tubeR * cb) * sa;
      const i2 = (i + 1) % ringSegs, j2 = (j + 1) % tubeSegs;
      const q = idx * 4;
      quads[q]     = i  * tubeSegs + j;
      quads[q + 1] = i2 * tubeSegs + j;
      quads[q + 2] = i2 * tubeSegs + j2;
      quads[q + 3] = i  * tubeSegs + j2;
    }
  }
  return { positions, quads };
}

export function buildCubeSphere(N, { radius = 1, squash = 1 } = {}) {
  const faceAxes = [
    { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },   // +X
    { u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },   // -X
    { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },   // +Y
    { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },   // -Y
    { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },    // +Z
    { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },  // -Z
  ];
  const posMap = new Map();
  const positions = [];
  const quads = [];
  // ⚠ THE SAME TOLERANCE AS THE SHARED CAGE, not a second copy of the number. buildCubeSphere
  // predates buildCubeCage and kept its own welding; the two had drifted to different values,
  // which meant "when are two vertices the same point" had two answers in one file.
  const key = (x, y, z) => Math.round(x / CAGE_WELD) + '_' + Math.round(y / CAGE_WELD) + '_' + Math.round(z / CAGE_WELD);
  function vert(face, i, j) {
    const s = -1 + 2 * i / N, t = -1 + 2 * j / N;
    const { u, v, n } = face;
    const x = n[0] + u[0] * s + v[0] * t, y = n[1] + u[1] * s + v[1] * t, z = n[2] + u[2] * s + v[2] * t;
    const l = Math.hypot(x, y, z);
    // Squash makes an ellipsoid of it — an egg, a lens, a head-shaped blank — without needing a
    // separate builder. Applied before the weld key so two vertices that land together are still
    // recognized as one.
    const px = (x / l) * radius, py = (y / l) * radius * squash, pz = (z / l) * radius;
    const k = key(px, py, pz);
    let idx = posMap.get(k);
    if (idx === undefined) { idx = positions.length / 3; positions.push(px, py, pz); posMap.set(k, idx); }
    return idx;
  }
  for (const face of faceAxes) {
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = vert(face, i, j), b = vert(face, i + 1, j), c = vert(face, i + 1, j + 1), d = vert(face, i, j + 1);
      quads.push(a, b, c, d);
    }
  }
  return { positions: new Float32Array(positions), quads: new Uint32Array(quads) };
}

export function buildSkullBase(N) {
  const base = buildCubeSphere(N);
  const nv = base.positions.length / 3;
  const positions = new Float32Array(nv * 3);
  const LANDMARKS = [
    { cx: 0.34, cy: 0.06, cz: 0.72, r: 0.42, s: -0.30 },
    { cx: -0.34, cy: 0.06, cz: 0.72, r: 0.42, s: -0.30 },
    { cx: 0.0, cy: 0.10, cz: 0.82, r: 0.20, s: 0.16 },
    { cx: 0.0, cy: 0.34, cz: 0.76, r: 0.50, s: 0.10 },
    { cx: 0.60, cy: -0.10, cz: 0.48, r: 0.32, s: 0.11 },
    { cx: -0.60, cy: -0.10, cz: 0.48, r: 0.32, s: 0.11 },
    { cx: 0.0, cy: -0.58, cz: 0.62, r: 0.42, s: 0.24 },
    { cx: 0.0, cy: -0.35, cz: 0.80, r: 0.22, s: -0.10 },
  ];
  for (let i = 0; i < nv; i++) {
    const px = base.positions[i*3], py = base.positions[i*3+1], pz = base.positions[i*3+2];
    let radiusScale = 1.0;
    for (const L of LANDMARKS) {
      const d = Math.hypot(px - L.cx, py - L.cy, pz - L.cz);
      if (d < L.r) { const t = 1 - d / L.r, falloff = t * t * (3 - 2 * t); radiusScale += L.s * falloff; }
    }
    let neckTaper = 1.0;
    if (py < -0.15 && pz < 0.3) { const t = Math.min(1, (-0.15 - py) / 0.6); neckTaper = 1 - 0.35 * t * t; }
    const r = radiusScale * neckTaper;
    const ex = 0.85, ey = 1.05, ez = 1.15;
    positions[i*3] = px * r * ex; positions[i*3+1] = py * r * ey; positions[i*3+2] = pz * r * ez;
  }
  return { positions, quads: base.quads };
}

// This used to dedup half-edges through `new Map()` keyed by
// `a+'_'+b`, and materialise `edges` as an array of {v0,v1,f0,f1} OBJECTS. Both halves of
// that were hard ceilings, not slowness:
//
//   * V8's Map (and Set) refuse to hold more than 2^24 = 16,777,216 entries. That is a limit
//     on ENTRY COUNT, not on key type — measured directly: numeric keys
//     throw at the identical count, and Set does too. So no hashmap variant escapes it; the
//     container itself had to go. A closed quad mesh has exactly 2 edges per quad, so the
//     ceiling landed at 8,388,608 quads — reachable with two Catmull-Clark levels on top of
//     a moderately dense base, i.e. inside this app's own working range, not a hypothetical.
//   * The edge objects themselves cost ~109MB of V8 heap at 7.1M quads, on top of the Map.
//
// Replaced by a counting sort into per-vertex buckets. Every half-edge is keyed by its LOWER
// endpoint, so the offset table is sized by VERTEX COUNT (a plain Uint32Array indexed by
// vertex id) rather than by entry count — that is the actual escape. Each bucket then holds
// only the half-edges incident to one vertex (mesh valence: single digits), so pairing them
// by their upper endpoint is a short linear scan, not a hash lookup.
//
// Two fidelity properties are preserved deliberately and are covered by
// _verify/topology_parity.mjs against a reference copy of the exact code above:
//   1. First occurrence sets f0; EVERY later occurrence overwrites f1 (last wins). That odd
//      behavior is what the original did on a non-manifold "3+ faces share one edge" mesh,
//      and it does NOT throw there. The counting sort is STABLE (the scatter preserves
//      original face-scan order within each bucket) and all copies of one edge necessarily
//      land in the same bucket, so the same face wins the same slot, byte for byte.
//   2. Open/non-manifold meshes still throw on the same condition (an edge left with f1 === -1).
// Edge INDEX ORDERING is free to change and does — verified before relying on it: bankwriter
// never serializes topo.edges/faceEdges, a BANK load always rebuilds topology fresh, and
// index.html never reads topo.edges at all (grep: the only readers are in this file).
//
// The output shape changes with it: `edges` becomes four parallel typed arrays plus
// `numEdges`. Measured at 7.1M quads: 12.5s -> 0.66s, and the ~109MB of edge objects becomes
// ~0MB of V8 heap.
export function buildTopology(quads, nv) {
  const nf = quads.length / 4;
  const heCount = nf * 4;

  // A half-edge is identified by its own flat index hei = f*4 + s, so `f` and `s` are
  // recoverable by shift/mask and nothing needs to be stored for them. Likewise (a,b) and
  // therefore lo/hi are two array reads away from `quads` at any point. The prototype kept
  // lo/hi/origA/origB/heFace/heCorner as six parallel arrays; recomputing instead drops
  // ~340MB of scratch at 7.1M quads for a handful of extra typed-array reads.

  // ---- Pass 1: bucket sizes, keyed by each half-edge's LOWER endpoint ----
  const bucketOffset = new Uint32Array(nv + 1);
  for (let f = 0; f < nf; f++) {
    const b = f * 4;
    const q0 = quads[b], q1 = quads[b+1], q2 = quads[b+2], q3 = quads[b+3];
    bucketOffset[(q0 < q1 ? q0 : q1) + 1]++;
    bucketOffset[(q1 < q2 ? q1 : q2) + 1]++;
    bucketOffset[(q2 < q3 ? q2 : q3) + 1]++;
    bucketOffset[(q3 < q0 ? q3 : q0) + 1]++;
  }
  for (let i = 0; i < nv; i++) bucketOffset[i + 1] += bucketOffset[i];

  // ---- Pass 2: stable scatter into those buckets. Stability is load-bearing: it is what
  // makes "first occurrence within the bucket" identical to "first occurrence in the
  // original face scan", which is what property 1 above depends on. ----
  const order = new Uint32Array(heCount);
  {
    const cursor = bucketOffset.slice(0, nv);
    for (let f = 0; f < nf; f++) {
      const b = f * 4;
      const q0 = quads[b], q1 = quads[b+1], q2 = quads[b+2], q3 = quads[b+3];
      order[cursor[q0 < q1 ? q0 : q1]++] = b;
      order[cursor[q1 < q2 ? q1 : q2]++] = b + 1;
      order[cursor[q2 < q3 ? q2 : q3]++] = b + 2;
      order[cursor[q3 < q0 ? q3 : q0]++] = b + 3;
    }
  }

  // ---- Pass 3: pair up half-edges inside each bucket by their UPPER endpoint ----
  // Capacity starts at the exact count for a closed 2-manifold (heCount/2) and GROWS if the
  // mesh turns out to be open or non-manifold. Growing matters for correctness, not just for
  // capacity: a typed-array write past the end is a silent no-op in JS, so a fixed
  // heCount/2 allocation on an open mesh would drop the overflowing edges' f1 slots, leave
  // them reading back as `undefined`, and make the `f1 === -1` throw below silently miss
  // them. (The prototype had exactly this hole; its open-grid test only passed because the
  // very first bucket happened to contain a boundary edge.)
  let edgeCap = (heCount >> 1) + 4;
  let edgeV0 = new Uint32Array(edgeCap), edgeV1 = new Uint32Array(edgeCap);
  let edgeF0 = new Uint32Array(edgeCap), edgeF1 = new Int32Array(edgeCap).fill(-1);
  const faceEdges = new Uint32Array(heCount);
  let numEdges = 0;
  // Reused across buckets; grown lazily to the largest valence actually seen.
  let scratchHi = new Uint32Array(32), scratchEi = new Uint32Array(32);

  for (let v = 0; v < nv; v++) {
    const start = bucketOffset[v], end = bucketOffset[v + 1];
    const n = end - start;
    if (n === 0) continue;
    if (n > scratchHi.length) { scratchHi = new Uint32Array(n); scratchEi = new Uint32Array(n); }
    let m = 0; // distinct edges opened so far in THIS bucket
    for (let i = start; i < end; i++) {
      const hei = order[i];
      const f = hei >>> 2, s = hei & 3;
      const a = quads[hei], b = quads[(f << 2) + ((s + 1) & 3)];
      const hiVal = a < b ? b : a;
      let found = -1;
      for (let j = 0; j < m; j++) if (scratchHi[j] === hiVal) { found = j; break; }
      if (found === -1) {
        if (numEdges === edgeCap) {
          const nc = edgeCap + (edgeCap >> 1) + 8;
          const a0 = new Uint32Array(nc); a0.set(edgeV0); edgeV0 = a0;
          const a1 = new Uint32Array(nc); a1.set(edgeV1); edgeV1 = a1;
          const a2 = new Uint32Array(nc); a2.set(edgeF0); edgeF0 = a2;
          const a3 = new Int32Array(nc).fill(-1); a3.set(edgeF1); edgeF1 = a3;
          edgeCap = nc;
        }
        const ei = numEdges++;
        edgeV0[ei] = a; edgeV1[ei] = b; edgeF0[ei] = f; edgeF1[ei] = -1;
        faceEdges[hei] = ei;
        scratchHi[m] = hiVal; scratchEi[m] = ei; m++;
      } else {
        const ei = scratchEi[found];
        edgeF1[ei] = f; // unconditional overwrite — last occurrence wins, exactly as before
        faceEdges[hei] = ei;
      }
    }
  }

  // ---- Same manifoldness check, same trigger condition, as the Map version ----
  // (The first OFFENDING edge reported can differ, since edge numbering is permuted — the
  // condition under which it throws is identical, which is the part anything depends on.)
  for (let ei = 0; ei < numEdges; ei++) {
    if (edgeF1[ei] === -1) throw new Error('buildTopology: non-manifold/open edge (v0=' + edgeV0[ei] + ' v1=' + edgeV1[ei] + ') — Catmull-Clark here assumes a closed manifold quad mesh.');
  }

  const vertFaceCount = new Uint32Array(nv);
  for (let f = 0; f < nf; f++) for (let s = 0; s < 4; s++) vertFaceCount[quads[f * 4 + s]]++;
  const vertFaceOffset = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) vertFaceOffset[i + 1] = vertFaceOffset[i] + vertFaceCount[i];
  const vertFaceList = new Uint32Array(vertFaceOffset[nv]);
  { const cursor = vertFaceOffset.slice(0, nv);
    for (let f = 0; f < nf; f++) for (let s = 0; s < 4; s++) { const vtx = quads[f * 4 + s]; vertFaceList[cursor[vtx]++] = f; } }

  const vertEdgeCount = new Uint32Array(nv);
  for (let e = 0; e < numEdges; e++) { vertEdgeCount[edgeV0[e]]++; vertEdgeCount[edgeV1[e]]++; }
  const vertEdgeOffset = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) vertEdgeOffset[i + 1] = vertEdgeOffset[i] + vertEdgeCount[i];
  const vertEdgeList = new Uint32Array(vertEdgeOffset[nv]);
  { const cursor = vertEdgeOffset.slice(0, nv);
    for (let e = 0; e < numEdges; e++) { vertEdgeList[cursor[edgeV0[e]]++] = e; vertEdgeList[cursor[edgeV1[e]]++] = e; } }

  return {
    edgeV0: edgeV0.subarray(0, numEdges), edgeV1: edgeV1.subarray(0, numEdges),
    edgeF0: edgeF0.subarray(0, numEdges), edgeF1: edgeF1.subarray(0, numEdges),
    numEdges, faceEdges, vertFaceOffset, vertFaceList, vertEdgeOffset, vertEdgeList,
  };
}

// ================================================================
// SPATIAL GRID
// ================================================================
// Before this there was NO spatial index anywhere in Pgon: applyBrush scanned all nv
// vertices on every pointermove sample to find the handful inside the brush radius, and
// computeQuadNormals rebuilt the entire normal buffer alongside it. Both are O(nv) per
// SAMPLE, so a stroke's cost scaled with the whole mesh instead of with the brush.
//
// A uniform hash grid with per-cell DOUBLY-LINKED lists in typed arrays. The doubly-linked
// choice is the load-bearing one: a CSR/counting-sort grid (Wall A's own technique, and
// cheaper to build) is expensive to MUTATE, and this structure must absorb an O(1)
// single-vertex move for every vertex a brush writes, every sample, so that the grid stays
// exact across a long unbounded drag (Tractor/Hook) without ever paying an O(nv) rebuild
// mid-stroke. That is the standard real-time broad-phase structure for exactly this reason.
//
// No Map/Set here either, but for a different reason than Wall A's: this one is sized by
// vertex count, so it would hit the same 2^24 ceiling. Typed arrays have no such limit.
export function buildSpatialGrid(positions, nv) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // A mesh containing a non-finite position (guarded against everywhere, but this runs on
  // whatever it is handed) would poison the extents; fall back to a unit box rather than
  // producing a grid whose cellSize is NaN and whose every query silently returns nothing.
  if (!Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ)) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
  const ex = Math.max(maxX - minX, 1e-6), ey = Math.max(maxY - minY, 1e-6), ez = Math.max(maxZ - minZ, 1e-6);
  // ~4 vertices per cell on average. A tuning heuristic only — query CORRECTNESS holds for
  // any positive cellSize (see gridQueryRadius's clamping note); this only sets how many
  // cells a query walks.
  const targetCells = Math.max(1, nv / 4);
  const cellSize = Math.cbrt((ex * ey * ez) / targetCells) || 1e-3;
  const gx = Math.max(1, Math.min(512, Math.ceil(ex / cellSize) + 1));
  const gy = Math.max(1, Math.min(512, Math.ceil(ey / cellSize) + 1));
  const gz = Math.max(1, Math.min(512, Math.ceil(ez / cellSize) + 1));
  const grid = {
    minX, minY, minZ, cellSize, gx, gy, gz, nv,
    head: new Int32Array(gx * gy * gz).fill(-1),
    next: new Int32Array(nv).fill(-1),
    prev: new Int32Array(nv).fill(-1),
    cellOf: new Int32Array(nv).fill(-1),
    // Counts vertices that have been MOVED outside the extents this grid was built for.
    // Not a correctness signal (clamping keeps queries exact regardless) — a QUALITY one:
    // once a drag has pulled geometry well outside the original box, those vertices all pile
    // into one boundary cell and queries near it stop being cheap. index.html rebuilds the
    // grid at the next stroke start when this is non-zero, which is already a lazy build point.
    outOfBounds: 0,
  };
  for (let i = 0; i < nv; i++) {
    const c = gridCellOf(grid, positions[i*3], positions[i*3+1], positions[i*3+2]);
    const oldHead = grid.head[c];
    grid.next[i] = oldHead; grid.prev[i] = -1;
    if (oldHead !== -1) grid.prev[oldHead] = i;
    grid.head[c] = i; grid.cellOf[i] = c;
  }
  return grid;
}

function gridCellOf(grid, x, y, z) {
  let cx = Math.floor((x - grid.minX) / grid.cellSize);
  let cy = Math.floor((y - grid.minY) / grid.cellSize);
  let cz = Math.floor((z - grid.minZ) / grid.cellSize);
  if (!(cx >= 0)) cx = 0; else if (cx >= grid.gx) cx = grid.gx - 1; // `!(cx >= 0)` also catches NaN
  if (!(cy >= 0)) cy = 0; else if (cy >= grid.gy) cy = grid.gy - 1;
  if (!(cz >= 0)) cz = 0; else if (cz >= grid.gz) cz = grid.gz - 1;
  return cx + grid.gx * (cy + grid.gy * cz);
}

// Call after EVERY vertex a brush actually writes. O(1): a same-cell move is a single
// integer compare and returns immediately.
export function gridMoveVertex(grid, positions, v) {
  const x = positions[v*3], y = positions[v*3+1], z = positions[v*3+2];
  const rawX = Math.floor((x - grid.minX) / grid.cellSize);
  const rawY = Math.floor((y - grid.minY) / grid.cellSize);
  const rawZ = Math.floor((z - grid.minZ) / grid.cellSize);
  if (rawX < 0 || rawX >= grid.gx || rawY < 0 || rawY >= grid.gy || rawZ < 0 || rawZ >= grid.gz || !Number.isFinite(x + y + z)) grid.outOfBounds++;
  const newC = gridCellOf(grid, x, y, z);
  const oldC = grid.cellOf[v];
  if (newC === oldC) return;
  if (oldC !== -1) {
    const p = grid.prev[v], n = grid.next[v];
    if (p !== -1) grid.next[p] = n; else grid.head[oldC] = n;
    if (n !== -1) grid.prev[n] = p;
  }
  const oldHead = grid.head[newC];
  grid.next[v] = oldHead; grid.prev[v] = -1;
  if (oldHead !== -1) grid.prev[oldHead] = v;
  grid.head[newC] = v; grid.cellOf[v] = newC;
}

// Append every vertex in cells overlapping the query sphere's bounding box into `out`.
//
// THE SUPERSET GUARANTEE, which the whole bit-identical claim rests on: a vertex whose true
// distance to (cx,cy,cz) is < radius is ALWAYS returned, for any vertex position whatsoever
// — including one dragged far outside the extents the grid was built for. Both the vertex's
// stored cell and the query's index range are produced by clamping raw cell coordinates into
// [0, g-1], and clamping is monotone, so a raw coordinate that lies inside the raw query span
// still lies inside the clamped one. (The prototype clamped only the LOW end of the query
// span and only the HIGH end of the vertex coordinate, which left an empty loop range — and
// therefore silently missed vertices — whenever the brush worked outside the original box.
// A brush dragged past the extents is not a hypothetical: Tractor and Hook exist to do it.)
export function gridQueryRadius(grid, cx, cy, cz, radius, out) {
  out.length = 0;
  const cs = grid.cellSize;
  let ix0 = Math.floor((cx - radius - grid.minX) / cs), ix1 = Math.floor((cx + radius - grid.minX) / cs);
  let iy0 = Math.floor((cy - radius - grid.minY) / cs), iy1 = Math.floor((cy + radius - grid.minY) / cs);
  let iz0 = Math.floor((cz - radius - grid.minZ) / cs), iz1 = Math.floor((cz + radius - grid.minZ) / cs);
  if (!(ix0 >= 0)) ix0 = 0; if (ix0 > grid.gx - 1) ix0 = grid.gx - 1;
  if (!(ix1 >= 0)) ix1 = 0; if (ix1 > grid.gx - 1) ix1 = grid.gx - 1;
  if (!(iy0 >= 0)) iy0 = 0; if (iy0 > grid.gy - 1) iy0 = grid.gy - 1;
  if (!(iy1 >= 0)) iy1 = 0; if (iy1 > grid.gy - 1) iy1 = grid.gy - 1;
  if (!(iz0 >= 0)) iz0 = 0; if (iz0 > grid.gz - 1) iz0 = grid.gz - 1;
  if (!(iz1 >= 0)) iz1 = 0; if (iz1 > grid.gz - 1) iz1 = grid.gz - 1;
  const head = grid.head, next = grid.next, gxs = grid.gx, gys = grid.gy;
  for (let iz = iz0; iz <= iz1; iz++) for (let iy = iy0; iy <= iy1; iy++) {
    const rowBase = gxs * (iy + gys * iz);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let v = head[rowBase + ix]; v !== -1; v = next[v]) out.push(v);
    }
  }
  return out;
}

// Verify hook support: recompute every vertex's cell from its CURRENT position and report
// how many disagree with what the grid believes. Zero is the invariant; anything else means
// a position write bypassed gridMoveVertex, or a wholesale position replacement failed to
// invalidate the grid. See _verify/spatial_scope_guard.mjs.
export function gridConsistencyErrors(grid, positions, nv) {
  if (!grid || grid.nv !== nv) return -1;
  let bad = 0;
  for (let i = 0; i < nv; i++) if (grid.cellOf[i] !== gridCellOf(grid, positions[i*3], positions[i*3+1], positions[i*3+2])) bad++;
  return bad;
}

export function computeQuadNormals(positions, quads) {
  const nv = positions.length / 3, nf = quads.length / 4;
  const n = new Float32Array(nv * 3);
  const P = i => [positions[i*3], positions[i*3+1], positions[i*3+2]];
  for (let f = 0; f < nf; f++) {
    const ia = quads[f*4], ib = quads[f*4+1], ic = quads[f*4+2], id = quads[f*4+3];
    const a = P(ia), b = P(ib), c = P(ic), d = P(id);
    for (const [i0, i1, i2, p0, p1, p2] of [[ia, ib, ic, a, b, c], [ia, ic, id, a, c, d]]) {
      const ux = p1[0]-p0[0], uy = p1[1]-p0[1], uz = p1[2]-p0[2];
      const vx = p2[0]-p0[0], vy = p2[1]-p0[1], vz = p2[2]-p0[2];
      const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      for (const i of [i0, i1, i2]) { n[i*3] += nx; n[i*3+1] += ny; n[i*3+2] += nz; }
    }
  }
  for (let i = 0; i < nv; i++) { const o = i*3, l = Math.hypot(n[o], n[o+1], n[o+2]) || 1; n[o] /= l; n[o+1] /= l; n[o+2] /= l; }
  return n;
}

// The scoped twin of computeQuadNormals. Rewrites, IN PLACE,
// exactly the vertices whose normal can have changed because `touchedVerts` moved, and
// leaves every other entry of `normals` untouched. Returns the affected-vertex set so the
// caller can drive its own bufferSubData ranges from it.
//
// AFFECTED SET. A vertex u's normal is the sum over ALL faces incident to u. A face's
// contribution changes iff one of its four corners moved. So u is affected iff u SHARES A
// FACE with a touched vertex — not merely iff u itself moved. That is what the two nested
// expansions below compute, and it is why the set is a strict superset of `touchedVerts`.
//
// TWO REAL BUGS THIS SHAPE EXISTS TO AVOID, both caught by exact-equality testing rather
// than reasoned away:
//
//   1. Re-summing an affected vertex from only the CHANGED faces silently drops the
//      contributions of its other, untouched incident faces. A vertex is a corner of four
//      or more faces; one of them needing to change is enough to make the vertex affected,
//      but its normal is the sum over ALL of them. So the face set walked below is
//      faces(affected) — every face incident to any affected vertex, a 2-ring — and each
//      affected vertex therefore receives its complete incident-face sum.
//   2. Float truncation ORDER is load-bearing. computeQuadNormals does `n[i*3] += nx` into a
//      Float32Array, which rounds to float32 on EVERY add. Accumulating into a float64 local
//      and truncating once at the end is a different number. So are the same additions in a
//      different order — IEEE754 addition is not associative. The loop below therefore
//      accumulates straight into the Float32Array, and walks each vertex's incident faces in
//      ASCENDING face order, which is exactly the order the global `for (f = 0; f < nf; f++)`
//      loop would have reached them in. vertFaceList is already stored that way (buildTopology
//      fills it with an outer loop over ascending f), so no sort is needed — but the property
//      is relied upon, so it is stated here rather than left implicit.
//
// The per-corner membership triples below reproduce the global loop's counting exactly,
// including on a degenerate quad that lists one vertex at two corners: the global loop adds
// that triangle's contribution once per matching corner, and so does this.
export function computeQuadNormalsScoped(positions, quads, normals, touchedVerts, vertFaceOffset, vertFaceList) {
  // affected = every vertex sharing a face with a touched vertex
  const affected = new Set();
  for (const v of touchedVerts) {
    const off = vertFaceOffset[v], end = vertFaceOffset[v+1];
    for (let k = off; k < end; k++) { const f = vertFaceList[k]; for (let s = 0; s < 4; s++) affected.add(quads[f*4+s]); }
  }
  // ...and every face incident to any of those, walked in ASCENDING order so each affected
  // vertex accumulates in exactly the order the global loop would have given it. Iterating
  // FACES rather than (vertex, face) pairs computes each face's two cross products once
  // instead of once per affected corner — same numbers, same order, roughly a quarter of
  // the arithmetic.
  const faceSet = new Set();
  for (const v of affected) {
    const off = vertFaceOffset[v], end = vertFaceOffset[v+1];
    for (let k = off; k < end; k++) faceSet.add(vertFaceList[k]);
  }
  const faces = Array.from(faceSet); faces.sort((a, b) => a - b);

  for (const v of affected) { normals[v*3] = 0; normals[v*3+1] = 0; normals[v*3+2] = 0; }
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const ia = quads[f*4], ib = quads[f*4+1], ic = quads[f*4+2], id = quads[f*4+3];
    const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
    const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
    const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
    const dx = positions[id*3], dy = positions[id*3+1], dz = positions[id*3+2];
    // triangle 1 = (a, b, c), then triangle 2 = (a, c, d) — same split, same order, as the global loop
    {
      const ux = bx-ax, uy = by-ay, uz = bz-az, vx = cx-ax, vy = cy-ay, vz = cz-az;
      const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      if (affected.has(ia)) { normals[ia*3] += nx; normals[ia*3+1] += ny; normals[ia*3+2] += nz; }
      if (affected.has(ib)) { normals[ib*3] += nx; normals[ib*3+1] += ny; normals[ib*3+2] += nz; }
      if (affected.has(ic)) { normals[ic*3] += nx; normals[ic*3+1] += ny; normals[ic*3+2] += nz; }
    }
    {
      const ux = cx-ax, uy = cy-ay, uz = cz-az, vx = dx-ax, vy = dy-ay, vz = dz-az;
      const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      if (affected.has(ia)) { normals[ia*3] += nx; normals[ia*3+1] += ny; normals[ia*3+2] += nz; }
      if (affected.has(ic)) { normals[ic*3] += nx; normals[ic*3+1] += ny; normals[ic*3+2] += nz; }
      if (affected.has(id)) { normals[id*3] += nx; normals[id*3+1] += ny; normals[id*3+2] += nz; }
    }
  }
  for (const v of affected) {
    const o = v*3, l = Math.hypot(normals[o], normals[o+1], normals[o+2]) || 1;
    normals[o] /= l; normals[o+1] /= l; normals[o+2] /= l;
  }
  return affected;
}

// Shared Ericson-style closest-point-on-triangle-mesh search. `filterNormal`, when given,
// SKIPS a candidate triangle whose own (unnormalized, un-averaged — cheap, doesn't need
// per-vertex normals) face normal disagrees with it (dot <= 0) — added for layer/mask/
// color reprojection (a design review): a naive nearest-point search can land on
// the WRONG SHEET of a thin/folded surface right after heavy sculpting, which is exactly
// when a re-cage (Reflow/Retopology) tends to happen. `closestPointOnMesh`'s own existing
// callers (Reflow's position reprojection, Trim's mirror search) pass no filter, so their
// behavior is byte-for-byte unchanged by this refactor.
//
// The per-triangle arithmetic below is reached by TWO drivers — the
// full ascending scan (`list === null`, the original behavior) and an accelerated scan over a
// candidate list produced by buildTriGrid. They share this ONE function body deliberately:
// identical code is the only way "the accelerated path is bit-identical" stays a structural
// property instead of a claim that has to be re-argued every time someone edits either driver.
//
// `list`, when given, must be ASCENDING and duplicate-free. That is what makes the two drivers
// agree exactly, and the reason is worth stating because it is the whole correctness argument:
// the update rule is `dist2 < best` — STRICTLY less — so a full ascending scan returns the
// LOWEST-INDEXED triangle among all triangles attaining the minimum dist2. An ascending scan
// over any SUBSET that still contains every triangle attaining that minimum returns the same
// triangle, because the omitted ones could never have won the strict comparison. Ties are
// therefore not "handled" by a tolerance anywhere — they resolve to the same triangle by the
// same rule, on both paths. (See nearestTriangleAccel for why the candidate set is a
// guaranteed superset of the minimizers.)
function scanTriangles(point, positions, triIdx, filterNormal, list, listLen) {
  let best = Infinity, bestPoint = null, bestTri = null, bestBary = null;
  // Without a list, iterate exactly the flat indices the original `i += 3` loop reached —
  // including the ragged final iteration on a triIdx whose length is not a multiple of 3,
  // which reads `undefined` and produces a NaN dist2 that can never win. Reproduced rather
  // than tidied away so the two drivers cannot disagree even on malformed input.
  const n = list ? listLen : Math.ceil(triIdx.length / 3);
  for (let s = 0; s < n; s++) {
    const i = (list ? list[s] : s) * 3;
    const ia = triIdx[i], ib = triIdx[i + 1], ic = triIdx[i + 2];
    const iao = ia * 3, ibo = ib * 3, ico = ic * 3;
    const ax = positions[iao], ay = positions[iao + 1], az = positions[iao + 2];
    const bx = positions[ibo], by = positions[ibo + 1], bz = positions[ibo + 2];
    const cx = positions[ico], cy = positions[ico + 1], cz = positions[ico + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    if (filterNormal) {
      const fnx = aby*acz - abz*acy, fny = abz*acx - abx*acz, fnz = abx*acy - aby*acx;
      if (fnx*filterNormal[0] + fny*filterNormal[1] + fnz*filterNormal[2] <= 0) continue;
    }
    const apx = point[0] - ax, apy = point[1] - ay, apz = point[2] - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let px, py, pz, u, v, w;
    if (d1 <= 0 && d2 <= 0) { px = ax; py = ay; pz = az; u = 1; v = 0; w = 0; }
    else {
      const bpx = point[0] - bx, bpy = point[1] - by, bpz = point[2] - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { px = bx; py = by; pz = bz; u = 0; v = 1; w = 0; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); px = ax + t * abx; py = ay + t * aby; pz = az + t * abz; u = 1-t; v = t; w = 0; }
        else {
          const cpx = point[0] - cx, cpy = point[1] - cy, cpz = point[2] - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { px = cx; py = cy; pz = cz; u = 0; v = 0; w = 1; }
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); px = ax + t * acx; py = ay + t * acy; pz = az + t * acz; u = 1-t; v = 0; w = t; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); px = bx + t * (cx - bx); py = by + t * (cy - by); pz = bz + t * (cz - bz); u = 0; v = 1-t; w = t; }
              else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; px = ax + abx * v + acx * w; py = ay + aby * v + acy * w; pz = az + abz * v + acz * w; }
            }
          }
        }
      }
    }
    const dist2 = (point[0] - px) ** 2 + (point[1] - py) ** 2 + (point[2] - pz) ** 2;
    if (dist2 < best) { best = dist2; bestPoint = [px, py, pz]; bestTri = [ia, ib, ic]; bestBary = [u, v, w]; }
  }
  // `dist2` is added for the accelerated driver's pruning radius. It is the same `best` the
  // winning triangle produced, so it costs nothing and no caller is required to read it.
  return bestPoint ? { point: bestPoint, tri: bestTri, bary: bestBary, dist2: best } : null;
}

// ============================================================================================
// A TRIANGLE GRID, SO A NEAREST-POINT SEARCH STOPS BEING O(triangles).
//
// The defect: scanTriangles above visits EVERY triangle for EVERY query point. shrinkWrapCage
// queries once per cage vertex (3,458 at the app's BASE_N of 24), so wrapping a 300K-triangle
// import is ~1e9 triangle tests on the main thread — the app simply stops responding, with no
// progress and no cancel. The same function is also the whole of Reflow's detail reprojection
// and of the layer/mask/color reprojection in replaceStratumWithMesh, so accelerating it once
// pays off in four places.
//
// WHY A UNIFORM GRID AND NOT A BVH. Both were considered; the grid wins here on three counts
// that are specific to this codebase rather than general:
//   1. BUILD TIME IS NOT AMORTIZED AWAY. The structure is built once and queried a few
//      thousand times, not millions. A JS SAH-BVH over 300K triangles costs on the order of a
//      second to build — a large fraction of the budget it is supposed to save. This grid is a
//      counting sort: a handful of linear passes, no recursion, no per-node allocation, and it
//      measures 36ms at 300K triangles and 68ms at 442K.
//   2. THE INPUT IS ALREADY NORMALIZED. Every mesh that reaches these callers has been through
//      normalizeToUnitScale (import) or is a subdivision surface / SDF extraction — triangles
//      of broadly comparable size in a unit box, which is precisely the case a uniform grid
//      handles well and the case that makes a BVH's adaptivity moot.
//   3. IT MATCHES THE FILE. buildSpatialGrid is a uniform hash grid and buildTopology's
//      counting sort is already the idiom here. One structural vocabulary is worth something.
// The grid's known weakness — wildly unequal triangle sizes — is covered explicitly by the
// oversize list below rather than left as a silent cliff.
//
// THIS IS NOT THE VERTEX GRID. buildSpatialGrid indexes VERTICES and is maintained
// incrementally by gridMoveVertex so a brush footprint query stays exact across a long drag.
// This one indexes TRIANGLES, is built once against a static source mesh, and is never
// mutated. Forcing one structure to do both jobs would have made the mutable one carry
// insertion logic it never needs.
// ============================================================================================

const TRIGRID_MAX_DIM = 512;         // per-axis ceiling, so one very thin axis can't blow up on its own
const TRIGRID_MAX_CELLS = 1 << 22;   // 4,194,304 cells = a 16MB Uint32Array — the structure's memory floor
const TRIGRID_OVERSIZE_CELLS = 512;  // a triangle whose AABB covers more cells than this goes in the always-scanned list

// Build a triangle index over (positions, triIdx). Returns null when there is nothing usable to
// index, which callers treat as "no acceleration available" and fall back to the full scan —
// never as an error, and never as an empty result.
//
// NON-FINITE TRIANGLES ARE OMITTED FROM THE INDEX, AND THAT IS EXACT, NOT AN APPROXIMATION. A
// triangle with any non-finite vertex coordinate can never win the full scan either: every
// branch of the closest-point cascade above is guarded by a comparison (`d1 <= 0`, `d3 >= 0`,
// `vc <= 0`, ...) that is false when its operand is NaN, so such a triangle always falls
// through to the final barycentric branch, whose `1 / (va + vb + vc)` is NaN or whose result
// overflows, and `NaN < best` / `Infinity < best` are both false for every value of `best`
// including the initial Infinity. So omitting them changes no result. (The accelerated path
// depends on the same structural fact, and _verify/accel_parity_guard.mjs re-measures it
// rather than assuming it survived the rewrite.)
export function buildTriGrid(positions, triIdx) {
  const nt = Math.ceil(triIdx.length / 3);
  if (nt <= 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let extSum = 0, usable = 0;
  for (let t = 0; t < nt; t++) {
    const ia = triIdx[t*3], ib = triIdx[t*3+1], ic = triIdx[t*3+2];
    const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
    const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
    const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
    if (!Number.isFinite(ax+ay+az+bx+by+bz+cx+cy+cz)) continue; // see the note above — exact, not a heuristic
    const tx0 = Math.min(ax, bx, cx), tx1 = Math.max(ax, bx, cx);
    const ty0 = Math.min(ay, by, cy), ty1 = Math.max(ay, by, cy);
    const tz0 = Math.min(az, bz, cz), tz1 = Math.max(az, bz, cz);
    if (tx0 < minX) minX = tx0; if (tx1 > maxX) maxX = tx1;
    if (ty0 < minY) minY = ty0; if (ty1 > maxY) maxY = ty1;
    if (tz0 < minZ) minZ = tz0; if (tz1 > maxZ) maxZ = tz1;
    extSum += (tx1-tx0) + (ty1-ty0) + (tz1-tz0);
    usable++;
  }
  if (usable === 0) return null; // every triangle degenerate — the full scan returns null anyway
  const meanExt0 = extSum / (usable * 3);

  // OUTLIER TRIANGLES ARE KEPT OUT OF THE EXTENTS, not just out of the cells. Measured on a
  // fixture that is exactly one stray face: a 27,648-triangle sphere plus a single 100-unit
  // ground plane. The grid's box then spans 100 units in two axes while the mesh anyone
  // actually queries spans 2, and with the cell budget fixed the sphere ends up about nine
  // cells across — a structure that indexes nothing. Rebuilding the extents without the
  // outliers (they go in the always-scanned oversize list either way) restored it.
  //
  // The rule is a factor off the MEAN triangle size, not an absolute threshold, so it is
  // scale-free; and it is abandoned entirely if it would exclude more than a small fraction of
  // the mesh, because at that point the size spread is the mesh's real character rather than a
  // stray face, and the full extents are the honest answer.
  const OUTLIER_FACTOR = 32;
  let outliers = 0;
  if (meanExt0 > 0) {
    for (let t = 0; t < nt; t++) {
      const ia = triIdx[t*3], ib = triIdx[t*3+1], ic = triIdx[t*3+2];
      const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
      const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
      const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
      if (!Number.isFinite(ax+ay+az+bx+by+bz+cx+cy+cz)) continue;
      const e = Math.max(Math.max(ax,bx,cx)-Math.min(ax,bx,cx), Math.max(ay,by,cy)-Math.min(ay,by,cy), Math.max(az,bz,cz)-Math.min(az,bz,cz));
      if (e > OUTLIER_FACTOR * meanExt0) outliers++;
    }
  }
  if (outliers > 0 && outliers <= Math.max(16, usable / 64)) {
    minX = minY = minZ = Infinity; maxX = maxY = maxZ = -Infinity;
    for (let t = 0; t < nt; t++) {
      const ia = triIdx[t*3], ib = triIdx[t*3+1], ic = triIdx[t*3+2];
      const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
      const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
      const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
      if (!Number.isFinite(ax+ay+az+bx+by+bz+cx+cy+cz)) continue;
      const tx0 = Math.min(ax,bx,cx), tx1 = Math.max(ax,bx,cx);
      const ty0 = Math.min(ay,by,cy), ty1 = Math.max(ay,by,cy);
      const tz0 = Math.min(az,bz,cz), tz1 = Math.max(az,bz,cz);
      if (Math.max(tx1-tx0, ty1-ty0, tz1-tz0) > OUTLIER_FACTOR * meanExt0) continue;
      if (tx0 < minX) minX = tx0; if (tx1 > maxX) maxX = tx1;
      if (ty0 < minY) minY = ty0; if (ty1 > maxY) maxY = ty1;
      if (tz0 < minZ) minZ = tz0; if (tz1 > maxZ) maxZ = tz1;
    }
    if (!Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ)) return null; // nothing but outliers
  }
  const ex = Math.max(maxX - minX, 1e-6), ey = Math.max(maxY - minY, 1e-6), ez = Math.max(maxZ - minZ, 1e-6);

  // CELL SIZE — measured, and the first version of this got it wrong in an instructive way.
  // Sizing by VOLUME (cbrt(bbox volume / triangle count), which is what buildSpatialGrid does
  // for vertices) is right for a point cloud filling a box and wrong for a triangle MESH,
  // because a mesh is a SURFACE: its triangles occupy a two-dimensional shell, so the cells
  // that actually contain anything number about area/cellSize², not volume/cellSize³. On a
  // 442,368-triangle subdivision sphere the volume heuristic produced ~37 triangles per
  // occupied cell and the accelerated search came out only 3x faster than the full scan —
  // an acceleration structure that barely accelerates.
  //
  // Sizing by the MEAN TRIANGLE EXTENT instead is the correct scale-free answer for a surface:
  // one cell per triangle-ish, so occupancy stays near constant no matter how dense the mesh
  // is. 2x the mean extent keeps most triangles inside one or two cells per axis, which bounds
  // insertions (a triangle is stored in every cell its AABB touches).
  let cellSize = meanExt0 * 2;
  if (!(cellSize > 0)) cellSize = Math.cbrt((ex * ey * ez) / Math.max(1, usable)) || 1e-3; // fully-degenerate/flat fallback
  // ...then coarsened, if needed, until the dense cell array fits a fixed ceiling. This is the
  // memory floor of the whole structure (4,194,304 cells = one 16MB Uint32Array) and it is a
  // deliberate cap rather than a computed size: Pgon's reference device is an iPad with a
  // 512MB working budget, and a structure that silently allocated hundreds of megabytes on a
  // dense import would trade one freeze for a different failure.
  let gx, gy, gz;
  for (let guard = 0; guard < 200; guard++) {
    gx = Math.max(1, Math.min(TRIGRID_MAX_DIM, Math.ceil(ex / cellSize) + 1));
    gy = Math.max(1, Math.min(TRIGRID_MAX_DIM, Math.ceil(ey / cellSize) + 1));
    gz = Math.max(1, Math.min(TRIGRID_MAX_DIM, Math.ceil(ez / cellSize) + 1));
    if (gx * gy * gz <= TRIGRID_MAX_CELLS) break;
    cellSize *= 1.26; // ~2x the cell count per step
  }
  const nCells = gx * gy * gz;

  const acc = { minX, minY, minZ, cellSize, gx, gy, gz, nt, usable, positionsRef: positions, triIdxRef: triIdx };
  const axisOf = (v, min, g) => { let c = Math.floor((v - min) / cellSize); if (!(c >= 0)) c = 0; else if (c >= g) c = g - 1; return c; };
  const hiX = minX + gx * cellSize, hiY = minY + gy * cellSize, hiZ = minZ + gz * cellSize;
  const insideGrid = (ax, ay, az, bx, by, bz, cx, cy, cz) =>
    Math.min(ax,bx,cx) >= minX && Math.max(ax,bx,cx) <= hiX &&
    Math.min(ay,by,cy) >= minY && Math.max(ay,by,cy) <= hiY &&
    Math.min(az,bz,cz) >= minZ && Math.max(az,bz,cz) <= hiZ;

  // Counting sort, same idiom as Wall A: pass 1 counts, prefix-sum, pass 2 fills. Triangle
  // AABB cell ranges are recomputed in pass 2 rather than cached — six extra arrays of length
  // nt would cost more memory than the arithmetic costs time.
  //
  // ONE array of cell offsets, not two. The usual counting sort keeps a separate write cursor,
  // which at this ceiling is a second 16MB allocation. Instead the prefix sum leaves each entry
  // holding its cell's END offset and pass 2 fills DOWNWARD (`cellTris[--cellStart[c]] = t`),
  // so when it finishes every entry holds its cell's START offset and cellStart[c+1] is
  // exactly where cell c ends. The only visible consequence is that triangles land in a cell in
  // descending order, which nothing depends on — the query sorts its candidates anyway.
  const cellStart = new Uint32Array(nCells + 1);
  const oversize = [];
  let inserts = 0;
  for (let t = 0; t < nt; t++) {
    const ia = triIdx[t*3], ib = triIdx[t*3+1], ic = triIdx[t*3+2];
    const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
    const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
    const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
    if (!Number.isFinite(ax+ay+az+bx+by+bz+cx+cy+cz)) continue;
    const x0 = axisOf(Math.min(ax,bx,cx), minX, gx), x1 = axisOf(Math.max(ax,bx,cx), minX, gx);
    const y0 = axisOf(Math.min(ay,by,cy), minY, gy), y1 = axisOf(Math.max(ay,by,cy), minY, gy);
    const z0 = axisOf(Math.min(az,bz,cz), minZ, gz), z1 = axisOf(Math.max(az,bz,cz), minZ, gz);
    const span = (x1-x0+1) * (y1-y0+1) * (z1-z0+1);
    // A single triangle spanning most of the grid (a ground plane under a small object, a
    // stray far-flung face) would otherwise be inserted into hundreds of thousands of cells.
    // Park it in a list that EVERY query scans: bounded memory, and still exactly correct —
    // an always-included candidate can only ever be a superset member.
    //
    // The containment test is a CORRECTNESS requirement, not a size heuristic. Once outliers
    // are excluded from the extents (above), a triangle can lie partly or wholly outside the
    // grid, and axisOf would then clamp its AABB into a boundary cell that does not contain its
    // closest point — which is exactly the assumption the superset guarantee rests on. Any
    // triangle not fully inside the grid box therefore goes to the always-scanned list.
    if (span > TRIGRID_OVERSIZE_CELLS || !insideGrid(ax,ay,az,bx,by,bz,cx,cy,cz)) { oversize.push(t); continue; }
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const rowBase = gx * (y + gy * z);
      for (let x = x0; x <= x1; x++) cellStart[rowBase + x]++;
    }
    inserts += span;
  }
  let run = 0;
  for (let c = 0; c < nCells; c++) { run += cellStart[c]; cellStart[c] = run; } // each entry now holds its cell's END offset
  cellStart[nCells] = run;
  const cellTris = new Uint32Array(inserts);
  for (let t = 0; t < nt; t++) {
    const ia = triIdx[t*3], ib = triIdx[t*3+1], ic = triIdx[t*3+2];
    const ax = positions[ia*3], ay = positions[ia*3+1], az = positions[ia*3+2];
    const bx = positions[ib*3], by = positions[ib*3+1], bz = positions[ib*3+2];
    const cx = positions[ic*3], cy = positions[ic*3+1], cz = positions[ic*3+2];
    if (!Number.isFinite(ax+ay+az+bx+by+bz+cx+cy+cz)) continue;
    const x0 = axisOf(Math.min(ax,bx,cx), minX, gx), x1 = axisOf(Math.max(ax,bx,cx), minX, gx);
    const y0 = axisOf(Math.min(ay,by,cy), minY, gy), y1 = axisOf(Math.max(ay,by,cy), minY, gy);
    const z0 = axisOf(Math.min(az,bz,cz), minZ, gz), z1 = axisOf(Math.max(az,bz,cz), minZ, gz);
    if ((x1-x0+1) * (y1-y0+1) * (z1-z0+1) > TRIGRID_OVERSIZE_CELLS || !insideGrid(ax,ay,az,bx,by,bz,cx,cy,cz)) continue;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const rowBase = gx * (y + gy * z);
      for (let x = x0; x <= x1; x++) cellTris[--cellStart[rowBase + x]] = t; // fill downward — see the note above
    }
  }
  acc.cellStart = cellStart;
  acc.cellTris = cellTris;
  acc.oversize = Uint32Array.from(oversize);
  // Query scratch, reused across every query so a few thousand searches allocate nothing.
  acc.stamp = new Int32Array(nt).fill(-1);
  acc.gen = 0;
  acc.cand = new Uint32Array(1024);
  acc.candLen = 0;
  acc.lastR = -1; // see nearestTriangleAccel — the previous query's achieved distance, a starting guess only
  return acc;
}

function triGridAddAll(acc, src, srcLen) {
  const stamp = acc.stamp, gen = acc.gen;
  let cand = acc.cand, len = acc.candLen;
  for (let k = 0; k < srcLen; k++) {
    const t = src[k];
    if (stamp[t] === gen) continue;
    stamp[t] = gen;
    if (len >= cand.length) { const g = new Uint32Array(cand.length * 2); g.set(cand); cand = g; acc.cand = g; }
    cand[len++] = t;
  }
  acc.candLen = len;
}

// Append every triangle registered in the inclusive cell box into acc.cand. Used only while the
// search is still hunting for its FIRST candidate, when there is no radius to work with yet.
function triGridCollectBox(acc, x0, x1, y0, y1, z0, z1) {
  const cellStart = acc.cellStart, cellTris = acc.cellTris, stamp = acc.stamp, gen = acc.gen;
  const gx = acc.gx, gy = acc.gy;
  let cand = acc.cand, len = acc.candLen;
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
    const rowBase = gx * (y + gy * z);
    for (let x = x0; x <= x1; x++) {
      const c = rowBase + x, e = cellStart[c + 1];
      for (let k = cellStart[c]; k < e; k++) {
        const t = cellTris[k];
        if (stamp[t] === gen) continue;
        stamp[t] = gen;
        if (len >= cand.length) { const g = new Uint32Array(cand.length * 2); g.set(cand); cand = g; acc.cand = g; }
        cand[len++] = t;
      }
    }
  }
  acc.candLen = len;
}

// Append every triangle registered in a cell whose AABB comes within `r` of (px,py,pz).
//
// A BALL, NOT A BOX, AND THE DIFFERENCE IS THE WHOLE PERFORMANCE STORY. The first working
// version of this search collected the axis-aligned BOX of half-width r and was measured at
// 723ms to wrap a 300K-triangle import — 25,000 triangles examined per cage vertex. The reason
// is geometric: r is the distance to the NEAREST surface point, so the ball of radius r touches
// the surface essentially only at that point, while the enclosing box of side 2r cuts a slab
// clean through the object and sweeps up a large fraction of it. Testing each cell against the
// ball instead reduces the collected surface to a cap of radius ~sqrt(2·r·cellSize) around the
// nearest point — on the measured fixture, about 25x fewer triangles.
//
// The per-cell test is exact (cell AABB min-distance, not center distance) and is folded into
// the loop bounds rather than evaluated per cell: fixing z leaves a budget for y, fixing y
// leaves a budget for x, so each row's x-run is computed directly from the remaining radius.
//
// BOUNDARY EXACTNESS. Deriving the x-run with floor() can drop a cell whose AABB is at distance
// EXACTLY r. That cannot cost a minimizer, because `r` reaching here is always the achieved
// distance inflated by (1 + 1e-6) + 1e-9: every triangle that could still win sits at a true
// distance strictly below r, so its cell's distance is strictly below r too, and strict
// inequality is not what floor() can round away. This is the same reasoning as the inflation
// note on nearestTriangleAccel, and the same reason the inflation is not a tolerance.
function triGridCollectBall(acc, px, py, pz, r) {
  if (!(r >= 0)) return;
  const cellStart = acc.cellStart, cellTris = acc.cellTris, stamp = acc.stamp, gen = acc.gen;
  const cs = acc.cellSize, gx = acc.gx, gy = acc.gy, gz = acc.gz;
  const minX = acc.minX, minY = acc.minY, minZ = acc.minZ;
  const rSq = r * r;
  const clampAxis = (c, g) => { if (!(c >= 0)) return 0; return c >= g ? g - 1 : c; };
  let z0 = clampAxis(Math.floor((pz - r - minZ) / cs), gz), z1 = clampAxis(Math.floor((pz + r - minZ) / cs), gz);
  let cand = acc.cand, len = acc.candLen;
  for (let z = z0; z <= z1; z++) {
    const zlo = minZ + z * cs, zhi = zlo + cs;
    const dz = pz < zlo ? zlo - pz : (pz > zhi ? pz - zhi : 0);
    const remZ = rSq - dz * dz;
    if (!(remZ >= 0)) continue;
    const ry = Math.sqrt(remZ);
    const y0 = clampAxis(Math.floor((py - ry - minY) / cs), gy), y1 = clampAxis(Math.floor((py + ry - minY) / cs), gy);
    for (let y = y0; y <= y1; y++) {
      const ylo = minY + y * cs, yhi = ylo + cs;
      const dy = py < ylo ? ylo - py : (py > yhi ? py - yhi : 0);
      const remY = remZ - dy * dy;
      if (!(remY >= 0)) continue;
      const rx = Math.sqrt(remY);
      const x0 = clampAxis(Math.floor((px - rx - minX) / cs), gx), x1 = clampAxis(Math.floor((px + rx - minX) / cs), gx);
      const rowBase = gx * (y + gy * z);
      for (let x = x0; x <= x1; x++) {
        const c = rowBase + x, e = cellStart[c + 1];
        for (let k = cellStart[c]; k < e; k++) {
          const t = cellTris[k];
          if (stamp[t] === gen) continue;
          stamp[t] = gen;
          if (len >= cand.length) { const g = new Uint32Array(cand.length * 2); g.set(cand); cand = g; acc.cand = g; }
          cand[len++] = t;
        }
      }
    }
  }
  acc.candLen = len;
}

// The accelerated driver. Returns exactly what a full scanTriangles would have returned.
//
// THE SUPERSET GUARANTEE, which is the entire correctness argument (same doctrine as
// gridQueryRadius's, restated for triangles):
//
//   * A triangle is registered in every cell its AABB overlaps, or else in the always-scanned
//     oversize list. So the closest point on triangle T — which lies inside T's AABB by
//     definition — sits in a cell that T is registered in.
//   * Therefore, if dist(point, T) <= r, that closest point lies within r of `point`, so the
//     cell holding it is a cell whose AABB comes within r of `point` — and it is a cell T is
//     registered in. Collecting every cell within r of `point` therefore collects T.
//   * The search below ends only once it has collected every cell within a radius rPrev that is
//     no smaller than the achieved distance. So the candidate set contains every triangle whose
//     dist2 is <= the minimum — every tied minimizer included.
//   * Every scan runs the SAME scanTriangles body over that set in ASCENDING triangle order, so
//     it lands on the same lowest-indexed minimizer the full scan would have.
//
// The radius is deliberately inflated by a hair (1 + 1e-6, plus an absolute 1e-9) before any
// cell arithmetic touches it. That is NOT a tolerance on the answer, and the distinction
// matters: it can only ever ADD candidates, and an extra candidate cannot change which triangle
// a strict-less ascending scan selects. Its only job is to make the cell arithmetic immune to
// rounding — sqrt() and the division by cellSize each carry a relative error near 1e-16, so a
// minimizer sitting exactly on a cell boundary at exactly the achieved distance can never be
// rounded out of the collected set by a margin ten orders of magnitude larger than the error.
// Papering over a tie with a tolerance would mean accepting a DIFFERENT triangle as close
// enough; this does the opposite — it widens the set that the exact rule is then applied to.
function nearestTriangleAccel(point, positions, triIdx, filterNormal, acc) {
  const px = point[0], py = point[1], pz = point[2];
  const cs = acc.cellSize, gx = acc.gx, gy = acc.gy, gz = acc.gz;
  const ax = (v, min, g) => { let c = Math.floor((v - min) / cs); if (!(c >= 0)) c = 0; else if (c >= g) c = g - 1; return c; };

  acc.gen++;
  if (acc.gen >= 0x7fffffff) { acc.stamp.fill(-1); acc.gen = 1; }
  acc.candLen = 0;
  triGridAddAll(acc, acc.oversize, acc.oversize.length);

  const cx = ax(px, acc.minX, gx), cy = ax(py, acc.minY, gy), cz = ax(pz, acc.minZ, gz);
  triGridCollectBox(acc, cx, cx, cy, cy, cz, cz); // the query's own cell, always

  // An upper bound on the distance from this point to ANY cell in the grid — the exact
  // termination test for "there is nothing left to collect", and cheaper than tracking a box.
  const fx = Math.max(Math.abs(px - acc.minX), Math.abs(px - (acc.minX + gx * cs)));
  const fy = Math.max(Math.abs(py - acc.minY), Math.abs(py - (acc.minY + gy * cs)));
  const fz = Math.max(Math.abs(pz - acc.minZ), Math.abs(pz - (acc.minZ + gz * cs)));
  const far = Math.hypot(fx, fy, fz);

  // FIRST GUESS FROM THE PREVIOUS QUERY. Measured, and worth the two lines: every caller of
  // this function walks a COHERENT set of query points — a cube-sphere cage in cage order, an
  // SDF extraction's vertices, a new stratum's vertices — so consecutive queries sit near each
  // other and their distances to the source surface barely change. Starting from a single cell
  // and doubling outward meant a cage vertex 13 cells from the surface paid five widening
  // rounds, each with its own scan, before it saw a single triangle. Seeding from the last
  // achieved distance usually gets there in one. It is purely a starting point: the loop's
  // termination rule below is unchanged by it, so a badly-wrong seed costs an extra round and
  // can never cost correctness.
  let rCollected = -1;
  let rTry = acc.lastR > 0 ? acc.lastR * 1.1 + cs : cs;

  // Two outcomes drive the loop. In both, every scan is over an ASCENDING, duplicate-free
  // candidate list, so whichever one the loop returns is already the answer a full ascending
  // scan would have given — there is no separate final pass. (TypedArray.sort is numeric by
  // default and sorts the underlying buffer in place, which is what the subarray view wants.)
  //
  //   hit !== null  — an achieved distance exists. If the ball already collected covers it, the
  //                   candidate set provably holds every triangle attaining the minimum and this
  //                   hit is final. Otherwise collect that ball and go round again — and since
  //                   adding candidates can only LOWER the achieved distance, the next round's
  //                   radius is inside the ball just collected, so this converges immediately.
  //   hit === null  — nothing in range yet, either because the neighborhood is empty or because
  //                   filterNormal rejected everything in it. There is no achieved distance to
  //                   work with, so grow the radius geometrically; once the collected radius
  //                   reaches `far` every indexed triangle has been scanned and null is the same
  //                   answer the full scan gives.
  //
  // The round cap is a guard, not a convergence requirement.
  for (let round = 0; round < 128; round++) {
    if (rTry > rCollected) { triGridCollectBall(acc, px, py, pz, rTry); rCollected = rTry; }
    const list = acc.cand.subarray(0, acc.candLen);
    list.sort();
    const hit = scanTriangles(point, positions, triIdx, filterNormal, list, acc.candLen);
    if (hit) {
      const r = Math.sqrt(hit.dist2) * (1 + 1e-6) + 1e-9;
      if (r <= rCollected || rCollected >= far) { acc.lastR = Math.sqrt(hit.dist2); return hit; }
      // Grow TOWARD r rather than jumping to it. r is only an upper bound at this stage, and
      // one far candidate can make it wildly pessimistic — a mesh with a single large stray
      // triangle (parked in the always-scanned oversize list, so every query sees it) would
      // otherwise make every query collect a ball reaching that triangle, i.e. most of the
      // grid. Measured on exactly that fixture: jumping to r cost 167ms where growing costs
      // 29ms, for identical output. Growth is geometric, so the round count stays logarithmic.
      rTry = Math.min(r, Math.max(cs, rCollected) * 3);
      continue;
    }
    if (rCollected >= far) return null;
    rTry = Math.min(far, Math.max(cs, rCollected * 3));
  }
  // Unreachable in practice. Falling back to the full scan rather than returning a
  // possibly-incomplete answer keeps the "slow but never wrong" contract that the stale-index
  // check above also relies on.
  return scanTriangles(point, positions, triIdx, filterNormal, null, 0);
}

// One entry point for both drivers. An `acc` built against different arrays than the ones
// handed in is IGNORED rather than trusted — a stale index is a silently-wrong-geometry bug,
// and falling back to the full scan is slow but never wrong.
function nearestTriangleOnMesh(point, positions, triIdx, filterNormal, acc) {
  if (acc && acc.positionsRef === positions && acc.triIdxRef === triIdx) {
    return nearestTriangleAccel(point, positions, triIdx, filterNormal, acc);
  }
  return scanTriangles(point, positions, triIdx, filterNormal, null, 0);
}

// nearestTriangleOnMesh's own `dist2 < best` search already
// guarantees this returns EITHER a fully-finite point OR null -- never a non-finite one. A
// degenerate candidate (zero-area triangle, a NaN vertex) produces a NaN or Infinite dist2,
// and `NaN < best`/`Infinity < best` are both false in JS regardless of iteration order or
// what `best` currently holds, so a corrupted candidate can never win the comparison and be
// selected. If EVERY candidate is degenerate, `best`/`bestPoint` simply never update and this
// returns null. That still leaves a real hole for callers: an unguarded `near[0]` on a null
// result throws, which is why shrinkWrapCage and Reflow's reprojection (index.html) both
// null-check this return before writing it into a position array -- see their own comments.
//
// `acc` is an OPTIONAL buildTriGrid index over the SAME (positions,
// triIdx) pair. Omitted, or built against different arrays, this is the identical full scan it
// always was. The null-vs-finite invariant above is unchanged on both paths and re-measured on
// both by _verify/accel_parity_guard.mjs rather than assumed to have survived.
export function closestPointOnMesh(point, positions, triIdx, acc) {
  const hit = nearestTriangleOnMesh(point, positions, triIdx, null, acc);
  return hit ? hit.point : null;
}

// Layer/mask/color reprojection across a re-cage: the same search, but also
// returns the source triangle + barycentric weights so a caller can interpolate ANY
// per-vertex field (not just positions) at the matched location, and optionally filters
// by normal agreement (see nearestTriangleOnMesh's own comment) to avoid a wrong-sheet
// match after heavy sculpting. Falls back to an unfiltered search if filtering finds
// nothing in range (a real, if rare, possibility on a small/simple mesh) rather than
// returning null and silently dropping the vertex's layer contribution.
export function closestPointBary(point, positions, triIdx, refNormal, acc) {
  return nearestTriangleOnMesh(point, positions, triIdx, refNormal, acc) || nearestTriangleOnMesh(point, positions, triIdx, null, acc);
}

// Barycentric-interpolate a per-vertex vec3 field (positions, a layer's displacement,
// color, ...) at the location closestPointBary matched.
export function interpolateVec3(hit, field) {
  const [ia, ib, ic] = hit.tri, [u, v, w] = hit.bary;
  return [
    field[ia*3]  *u + field[ib*3]  *v + field[ic*3]  *w,
    field[ia*3+1]*u + field[ib*3+1]*v + field[ic*3+1]*w,
    field[ia*3+2]*u + field[ib*3+2]*v + field[ic*3+2]*w,
  ];
}

// Same, for a scalar per-vertex field (mask).
export function interpolateScalar(hit, field) {
  const [ia, ib, ic] = hit.tri, [u, v, w] = hit.bary;
  return field[ia]*u + field[ib]*v + field[ic]*w;
}

// Reads the typed edgeV0/edgeV1 + numEdges that buildTopology
// returns, instead of iterating an array of edge objects. Same CSR result.
export function buildVertexNeighbors(topology, nv) {
  const { edgeV0, edgeV1, numEdges } = topology;
  const vnCount = new Uint32Array(nv);
  for (let e = 0; e < numEdges; e++) { vnCount[edgeV0[e]]++; vnCount[edgeV1[e]]++; }
  const vnOffset = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) vnOffset[i + 1] = vnOffset[i] + vnCount[i];
  const vnList = new Uint32Array(vnOffset[nv]);
  const cursor = vnOffset.slice(0, nv);
  for (let e = 0; e < numEdges; e++) { vnList[cursor[edgeV0[e]]++] = edgeV1[e]; vnList[cursor[edgeV1[e]]++] = edgeV0[e]; }
  return { vnOffset, vnList };
}

// ================================================================
// CPU PORT — subdivideCatmullClark. Same 3-pass structure as the WGSL version
// (face points -> edge points -> vertex points), now 3 plain for-loops.
// Synchronous — no device, no readback. Signature drops `device`.
// ================================================================
export function subdivideCatmullClark(positions, quads, topology) {
  const nv = positions.length / 3, nf = quads.length / 4, ne = topology.numEdges;
  const { edgeV0, edgeV1, edgeF0, edgeF1 } = topology; // parallel typed arrays, not an array of {v0,v1,f0,f1} objects

  // ⚠ The highest-value guard target in this file -- this is the
  // base of the whole Strata hierarchy, so one non-finite vertex committed HERE propagates
  // into computeQuadNormals, every brush pass, and every level subdivided on top of this
  // one. Same shape as applyBrush's guard (compute into locals, one summed
  // Number.isFinite before the store), applied at THREE commit points instead of one,
  // because Catmull-Clark commits three kinds of new vertex, not one: face points and edge
  // points are copied straight into outPositions below with no corresponding "prior"
  // vertex to fall back to (they're brand new), so a failed check there falls back to the
  // Float32Array's own zero-init -- finite and inert, unable to spread further, but not a
  // meaningful position either. Vertex points (the newPositions loop) DO have a real prior
  // -- the same vertex's own pre-subdivision position (ox/oy/oz) -- so that's the fallback
  // there, matching applyBrush's "leaves the vertex at its PRIOR value" doctrine exactly.
  // Costed on a 55,296-quad top stratum: see _verify/kernel_finite_guard.mjs's timings.
  const facePoints = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    let sx = 0, sy = 0, sz = 0;
    for (let s = 0; s < 4; s++) {
      const vi = quads[f * 4 + s];
      sx += positions[vi*3]; sy += positions[vi*3+1]; sz += positions[vi*3+2];
    }
    const fpx = sx * 0.25, fpy = sy * 0.25, fpz = sz * 0.25;
    if (Number.isFinite(fpx + fpy + fpz)) { facePoints[f*3] = fpx; facePoints[f*3+1] = fpy; facePoints[f*3+2] = fpz; }
  }

  const edgeMidpoints = new Float32Array(ne * 3);
  const edgePoints = new Float32Array(ne * 3);
  for (let e = 0; e < ne; e++) {
    const v0 = edgeV0[e], v1 = edgeV1[e], f0 = edgeF0[e], f1 = edgeF1[e];
    const p0x = positions[v0*3], p0y = positions[v0*3+1], p0z = positions[v0*3+2];
    const p1x = positions[v1*3], p1y = positions[v1*3+1], p1z = positions[v1*3+2];
    const midx = (p0x+p1x)*0.5, midy = (p0y+p1y)*0.5, midz = (p0z+p1z)*0.5;
    // edgeMidpoints is deliberately left UNGUARDED here: it's a pure intermediate (never
    // written to outPositions itself), read only by the vertex-point loop's ravg below --
    // guarding it here would silently blend a wrong-but-finite 0 into that average instead
    // of the correct "skip this vertex, keep its prior position" the final guard gives it.
    // One guarded store per commit point, not per intermediate (see the block comment above).
    edgeMidpoints[e*3] = midx; edgeMidpoints[e*3+1] = midy; edgeMidpoints[e*3+2] = midz;
    // facePoints is already guaranteed finite by this point (guarded above), so the only
    // remaining corruption source feeding edgePoints -- which DOES get committed straight
    // into outPositions as its own new vertex -- is p0/p1 (the source mesh's own positions).
    const fp0x = facePoints[f0*3], fp0y = facePoints[f0*3+1], fp0z = facePoints[f0*3+2];
    const fp1x = facePoints[f1*3], fp1y = facePoints[f1*3+1], fp1z = facePoints[f1*3+2];
    const epx = (p0x+p1x+fp0x+fp1x)*0.25, epy = (p0y+p1y+fp0y+fp1y)*0.25, epz = (p0z+p1z+fp0z+fp1z)*0.25;
    if (Number.isFinite(epx + epy + epz)) { edgePoints[e*3] = epx; edgePoints[e*3+1] = epy; edgePoints[e*3+2] = epz; }
  }

  const newPositions = new Float32Array(nv * 3);
  for (let vi = 0; vi < nv; vi++) {
    const foff = topology.vertFaceOffset[vi], fend = topology.vertFaceOffset[vi+1], fcount = fend - foff;
    let favgx = 0, favgy = 0, favgz = 0;
    for (let k = foff; k < fend; k++) { const f = topology.vertFaceList[k]; favgx += facePoints[f*3]; favgy += facePoints[f*3+1]; favgz += facePoints[f*3+2]; }
    favgx /= fcount; favgy /= fcount; favgz /= fcount;

    const eoff = topology.vertEdgeOffset[vi], eend = topology.vertEdgeOffset[vi+1], ecount = eend - eoff;
    let ravgx = 0, ravgy = 0, ravgz = 0;
    for (let k = eoff; k < eend; k++) { const e = topology.vertEdgeList[k]; ravgx += edgeMidpoints[e*3]; ravgy += edgeMidpoints[e*3+1]; ravgz += edgeMidpoints[e*3+2]; }
    ravgx /= ecount; ravgy /= ecount; ravgz /= ecount;

    const n = fcount;
    const ox = positions[vi*3], oy = positions[vi*3+1], oz = positions[vi*3+2];
    const nx = (favgx + 2*ravgx + (n-3)*ox) / n;
    const ny = (favgy + 2*ravgy + (n-3)*oy) / n;
    const nz = (favgz + 2*ravgz + (n-3)*oz) / n;
    if (Number.isFinite(nx + ny + nz)) { newPositions[vi*3] = nx; newPositions[vi*3+1] = ny; newPositions[vi*3+2] = nz; }
    else { newPositions[vi*3] = ox; newPositions[vi*3+1] = oy; newPositions[vi*3+2] = oz; } // skip, don't heal: keep this vertex's own pre-subdivision position
  }

  // ---- new topology (pure combinatorics — unchanged from v00000-001) ----
  const outPositions = new Float32Array((nv + nf + ne) * 3);
  outPositions.set(newPositions, 0);
  outPositions.set(facePoints, nv * 3);
  outPositions.set(edgePoints, (nv + nf) * 3);

  const outQuads = new Uint32Array(nf * 4 * 4);
  for (let f = 0; f < nf; f++) {
    const v0 = quads[f*4], v1 = quads[f*4+1], v2 = quads[f*4+2], v3 = quads[f*4+3];
    const e01 = nv + nf + topology.faceEdges[f*4], e12 = nv + nf + topology.faceEdges[f*4+1];
    const e23 = nv + nf + topology.faceEdges[f*4+2], e30 = nv + nf + topology.faceEdges[f*4+3];
    const fp = nv + f;
    outQuads.set([v0, e01, fp, e30], f*16);
    outQuads.set([v1, e12, fp, e01], f*16+4);
    outQuads.set([v2, e23, fp, e12], f*16+8);
    outQuads.set([v3, e30, fp, e23], f*16+12);
  }

  return { positions: outPositions, quads: outQuads };
}

// ⚠ A PER-VERTEX FIELD, CARRIED UP ONE SUBDIVISION, EXACTLY AND WITHOUT A SPATIAL SEARCH.
// subdivideCatmullClark lays its output out in three blocks, and that layout is what makes this
// possible at all:
//     [0, nv)            the parent's own vertices, AT THE SAME INDICES
//     [nv, nv+nf)        one new vertex per parent FACE
//     [nv+nf, nv+nf+ne)  one new vertex per parent EDGE
// So a field defined on the parent extends to the child by copying the originals and averaging
// the corners of each face and the ends of each edge — which is exactly linear interpolation of
// the field over the parent's own connectivity.
//
// ⚠ WHY THIS EXISTS RATHER THAN REPROJECTING. The alternative is closestPointBary against the
// parent mesh, which is what Divide uses for mask and color, and it costs 4.6 SECONDS at 885K
// vertices — measured. This is O(nv + nf + ne) with no search, no accelerator and no tolerance,
// and it is EXACT rather than approximate because it uses the structural relationship the two
// levels already have instead of rediscovering it geometrically.
//
// ⚠ THE MAPPING IS STRUCTURAL, SO SCULPTING DOES NOT BREAK IT. Vertex indices come from the
// subdivision, not from where anything sits; a level that has been sculpted for an hour still has
// its parent's vertices at [0, nv). It is only invalidated by an operation that REPLACES the
// ladder — Remesh or Reflow — which is exactly when a field over the old ladder is meaningless
// anyway. The inverse direction needs no function: restricting a child field to its parent is
// `child.subarray(0, parentNv)`, since those entries ARE the parent's vertices.
export function liftFieldToSubdivided(field, quads, topology, nv) {
  const nf = quads.length / 4, ne = topology.numEdges;
  const { edgeV0, edgeV1 } = topology;
  const out = new Float32Array(nv + nf + ne);
  out.set(field.subarray ? field.subarray(0, nv) : field.slice(0, nv), 0);
  for (let f = 0; f < nf; f++) {
    out[nv + f] = (field[quads[f*4]] + field[quads[f*4+1]] + field[quads[f*4+2]] + field[quads[f*4+3]]) * 0.25;
  }
  for (let e = 0; e < ne; e++) {
    out[nv + nf + e] = (field[edgeV0[e]] + field[edgeV1[e]]) * 0.5;
  }
  return out;
}

// ================================================================
// CPU PORT — brush/mask/gantry/stain. Each factory takes no `device` and
// returns the same-shaped call interface as v00000-001 minus the GPU buffer
// arguments (positions/normals/mask/color/vn arrays are plain Float32Array/
// Uint32Array now, mutated in place — no vbuf/nbuf/bindGroup ceremony).
// Anneal/blur/stain-smooth still snapshot-then-write (a plain `.slice()`)
// since they read NEIGHBOR values — the data-race concern that motivated
// this in v00000-001 was about concurrent GPU threads, which doesn't apply
// to a single-threaded JS loop, but the snapshot is still semantically
// required: without it, an already-updated neighbor's NEW value would leak
// into a not-yet-processed vertex's average (order-dependent, wrong either
// way — CPU vs GPU changes the failure mode, not whether one is needed).
// ================================================================
// Hoisted to module scope: maskPass and stainPass need the SAME alpha
// sampling the brush pass uses. Sharing one implementation is the whole point — three copies
// of this across three passes is exactly the drift these helpers were written to prevent.
// ---- Focal Shift: brush hardness ----
// Maxon's own documented semantics, quoted rather than recalled: "a negative value will
// create a sharper edge, while a positive value will generate a softer, more gradual
// transition." Blender ships the same idea as a Falloff Curve "mapped from the center of
// the brush toward its borders"; Nomad as a falloff curve. All three treat it as an
// always-reachable control, not power-user trivia.
//
// Both kernel twins derive EVERY brush's profile from one normalized t = 1 - d/radius:
// the smoothstep dome reads it, and Crease/Hook's t^4 spike reads the same t. So remapping
// t once, before either consumer, modulates each brush's OWN shape instead of replacing it
// — one line rather than eight special cases, and Crease stays sharper than Build at every
// setting because the t^4 is still on top of the remap.
//
//     t' = t^p,   p = exp(K * focal),   focal in [-1, +1]
//
// focal < 0 -> p < 1 -> t pushed UP -> wider plateau, fast drop at the rim -> SHARPER edge.
// focal > 0 -> p > 1 -> narrower peak, fading to nothing -> SOFTER, more gradual.
//
// K DIFFERS BY SIDE, and that is measured rather than stylistic. With a single K = ln4 the
// slider is perceptually lopsided: measured on a real Build stroke (strength 0.5, radius
// 0.5), the ratio of displacement at 20-40% of the radius to displacement at the center
// moves 0.656 -> 0.962 going hard, but 0.656 -> 0.050 going soft — the soft end collapses
// into a needle that barely moves material, so most of that half of the slider's travel is
// unusable. Ending the soft side at p = 2 instead lands it at 0.305, an excursion of the
// same size as the hard side's, so both halves of the slider do comparable work.
//
//   focal -1 -> p = 1/4 : a broad, nearly flat disc that cuts off crisply at the rim
//   focal  0 -> p = 1   : today's smoothstep dome, exactly
//   focal +1 -> p = 2   : a feathered dome that fades to nothing well inside the rim
//
// At focal 0 the exponent is EXACTLY 1 and both callers branch around Math.pow entirely, so
// output is byte-identical to the pre-Phase-45 kernel. That is deliberate: the existing
// parity/integrity gates stay green by construction rather than by re-baselining them,
// which the house rule forbids anyway.
//
// Lives here as one shared helper, called by both twins, specifically so the two cannot
// drift on this math the way hand-synced twins otherwise do.
// ---- Alpha: the stamp that shapes what a brush deposits ----
// `frames[c]` is [uAxis, vAxis]: an orthonormal pair spanning the tangent plane at that
// symmetric copy's contact point, built screen-aligned by the caller. A vertex's offset
// from the brush center projects onto that pair to give (u,v) inside the brush disc in
// [-1,+1], remapped here to the bitmap's [0,1].
//
// Screen-aligned rather than stroke-aligned is a deliberate match to how ZBrush behaves:
// the stamp keeps a fixed orientation as the brush travels, which is what makes overlapping
// dabs of a pore or scale alpha accumulate into a texture instead of smearing into a streak.
//
// Returns exactly 1 when there is no alpha, and both callers multiply that 1 into their
// falloff — so with the default 'None' the arithmetic is bit-identical to pre-Phase-46.
// Shared by both twins for the same reason focalExponent is.
function alphaMultiplier(alphaTex, frames, c, px, py, pz, cx, cy, cz, radius) {
  if (!alphaTex || !frames) return 1;
  const fr = frames[c];
  if (!fr) return 1;
  const ax = px - cx, ay = py - cy, az = pz - cz;
  const u = (ax * fr[0][0] + ay * fr[0][1] + az * fr[0][2]) / radius;
  const v = (ax * fr[1][0] + ay * fr[1][1] + az * fr[1][2]) / radius;
  // `gain` restores the peak an otherwise-mostly-black stamp would silently cost — see
  // getAlpha's own comment for why it is an inverse square root capped at 3, not 1/mean.
  return sampleAlpha(alphaTex, u * 0.5 + 0.5, v * 0.5 + 0.5) * alphaTex.gain;
}

// ================================================================
// STRETCH CLAMP
// ================================================================
// MEASURED FIRST, because the failure does not look like what it is. Six heavy Build passes
// across a 55,298-vertex sphere produce a folded, torn-looking mess — and the
// mesh has ZERO inverted faces, ZERO collapsed edges, and an unchanged minimum face area. Nothing
// is degenerate in the usual sense. What actually happens:
//
//     max edge 0.0207 -> 0.1801     edge ratio 3.4 -> 29.9     mean edge barely moves
//
// The brush pulls a lobe out until the quads down its flank are stretched ~8.7x, and a hugely
// elongated, nearly flat quad is what passes through the neighboring surface and reads as a
// tear. So the right guard is not an inversion test (there is nothing to catch) — it is a limit
// on how far a single vertex may be pulled from its own neighbors.
//
// A displacement clamp was drafted, rejected, and FRONT-FACE MASKING shipped instead.
// That was the correct call for the mechanism it addressed (a thin feature's back side falling
// inside the brush sphere and being pushed toward its front). This is a different mechanism, and
// the two are complementary rather than alternatives.
//
// SOLVED IN CLOSED FORM, not by iteration. For a vertex at p moving by d, with a neighbor at n,
// edge length is |a + t*d| where a = p - n. Setting |a + t*d|^2 = cap^2 is a quadratic in t:
//
//     |d|^2 t^2 + 2(a.d) t + (|a|^2 - cap^2) = 0
//
// so the largest permitted t is one sqrt per neighbor — no bisection, no tuning, exact.
//
// The cap is max(limit, currentLength), which matters: an edge already over the limit must still
// be allowed to get SHORTER. Clamping on absolute length alone would freeze exactly the vertices
// a corrective Smooth stroke needs to move.
// ONE NEIGHBOR, and deliberately only one. The two brush twins store their pre-write snapshot
// differently — applyBrush keeps a dense positions.slice(), applyBrushScoped keeps a sparse
// snapVals array reached through a snapSlot map covering candidates union their one-ring — so a
// single shared function cannot do the neighbor ITERATION for both. Keeping only the arithmetic
// here puts the part that could silently drift in one place and leaves each twin doing the data
// access it already does everywhere else. scoped_stroke_parity demands EXACT array equality
// between the two, so this split is asserted rather than hoped about.
// CAPS STRETCH ONLY, and the reason it does not also enforce a minimum edge length is measured
// rather than assumed. Capping stretch works — the longest edge goes from 0.180 to 0.0635 — but it
// also takes the SHORTEST edge from 0.00603 to 0.00191, because a vertex held back at the cap sits
// beside vertices that were not held back and the edge between them compresses.
//
// A symmetric floor was implemented to fix that and MADE IT WORSE (0.00130). The failure is
// structural, not a tuning error: every vertex clamps its own displacement against the PRE-DAB
// snapshot, so within one dab both ends of an edge move and neither one's own test can see the
// other's motion. Preventing compression needs a pass that reasons about pairs after the fact —
// a different mechanism, out of scope here — so the floor was removed rather than shipped as a
// control that does nothing. The remaining compression is recorded as an honest limit.
//
// Length along the move is len(t) = |a + t*d|, convex in t, so the bound is one quadratic:
//
//     dd*t^2 + 2(a.d)*t + (|a|^2 - cap^2) = 0
//
// one sqrt per neighbor, exact, no bisection and nothing to tune.
function stretchT(px, py, pz, dx, dy, dz, nx, ny, nz, dd, limit) {
  const ax = px - nx, ay = py - ny, az = pz - nz;
  const aa = ax*ax + ay*ay + az*az;
  const ad = ax*dx + ay*dy + az*dz;
  // The cap is relaxed to whatever the edge already is, so an edge that starts out longer than
  // the limit may still SHORTEN — without that, a corrective Smooth stroke would be frozen
  // exactly where it is needed most.
  const cap2 = Math.max(limit*limit, aa);
  if (aa + 2*ad + dd <= cap2) return 1; // fine at full displacement
  const disc = ad*ad - dd*(aa - cap2);
  if (disc <= 0) return 0;
  const root = (-ad + Math.sqrt(disc)) / dd;
  return root < 0 ? 0 : (root > 1 ? 1 : root);
}


// How far along its displacement a vertex may travel before it comes within `sep` of the point
// (nx,ny,nz). The mirror image of stretchT above: that one keeps an EDGE from growing past a
// limit, this one keeps two unrelated pieces of surface from arriving on top of each other.
//
// Same relaxation as stretchT, for the same reason: the floor is lowered to whatever the gap
// ALREADY is when the two are closer than `sep` — without that, a surface that has already
// overlapped would be frozen exactly where a corrective stroke is needed most, and the guard
// would make the damage permanent instead of preventing it.
//
// Solving for the whole segment, not just its endpoint: |p + t*d - q|^2 >= floor^2 is a
// quadratic in t, and taking its FIRST root is what stops a fast sample from tunnelling
// through a thin wall and reporting itself clear on the far side.
function separationT(px, py, pz, dx, dy, dz, nx, ny, nz, dd, sep) {
  const ax = px - nx, ay = py - ny, az = pz - nz;
  const aa = ax*ax + ay*ay + az*az;
  // The floor RELAXES to the gap a pair already has, which is what stops an already-violating
  // pair being clamped to a standstill on every future dab.
  //
  // ⚠ KNOWN LIMIT: an already-interpenetrated surface cannot be smoothed back out with the guard
  // on. Repair means moving TOWARD the sheet you passed through, and distance to its vertices
  // falls before it rises, so a corrective stroke reads as an approach and returns t = 0.
  // Measured on a surface folded with the guard off (144 self-intersecting pairs), six Smooth
  // strokes: guard on 144 -> 144, guard off 144 -> 128. Not a freeze — 3,762 vertices still move.
  //
  // ⚠ Do NOT "fix" it by exempting already-inside pairs (`if (aa < sep*sep) return 1`): a vertex
  // that once comes within the floor is then exempt permanently and sails straight through —
  // measured 0 -> 254 crossings, worse than no guard at all.
  //
  // ⚠⚠ AND DO NOT REPLACE THIS WITH A SIGNED SIDE TEST. It was built and measured: signed distance to the blocker's tangent plane at both ends of the
  // displacement, clamping only when the sign flips, so approach is free and repair is free. On a
  // textured form it did exactly what it promised — the clamp rate fell from 33% to 3.8%, the guard
  // stopped driving the geometry. And it lost ALL the protection: on a smooth form it left 15
  // self-intersecting pairs, byte for byte what the guard being OFF leaves, where the distance
  // floor leaves 0.
  //
  // The reason is recorded twenty lines below, in the note forbidding an opposed-normal pre-test:
  // self-intersection here is sheets SHEARING PAST one another, not meeting head-on — 64% of real
  // violations have AGREEING normals. A vertex sliding past a sheet whose normal agrees with its
  // own never changes sides, so a side test cannot see the dominant failure mode at all. Any
  // redesign has to answer to that measurement first.
  //
  // ⚠⚠⚠ AND THE SWEPT TRIANGLE TEST THIS NOTE USED TO POINT AT DOES NOT WORK EITHER. Built and
  // measured, both ways round, because it is the obvious answer and it is wrong for a reason worth
  // knowing:
  //
  //   * Segment against the faces AS THEY STAND fires literally never — 0 hits in 6,968,801 tests
  //     while 15 self-intersections formed anyway. Every vertex under a dab moves at once, so no
  //     single segment crosses the geometry at test time; the interpenetration only exists once
  //     they have all arrived.
  //   * Segment against where those faces are GOING does fire (43 hits) and does help — fold-backs
  //     1 -> 0, max dihedral 90.1 -> 71.3, crossings 15 -> 6 against 15 unguarded. It still loses
  //     to this floor, which leaves 0, and costs ~7M triangle tests a stroke to do it.
  //
  // THAT is why a distance floor is the right mechanism here and not a placeholder for a better
  // one. It is conservative, and its conservatism is a stand-in for the thing an exact test cannot
  // have: where everything else will be when it gets there. An exact answer needs the destinations,
  // and the destinations depend on the answer.
  //
  // What is genuinely still open is the floor's COST, not its correctness: it asks about NEARNESS,
  // so on a detailed surface it fires on work that was never going to cross. Widening the geodesic
  // exclusion to RING_EXCLUDE rings halved that (63% of writes clamped -> 33%) with the protection
  // intact, and that is the axis that has actually paid. The next gain is probably more of the
  // same — a better answer to "is this my own surface" — rather than a better crossing test.
  const floor2 = Math.min(sep * sep, aa);
  const ad = ax*dx + ay*dy + az*dz;
  // Already clear at the far end AND never dipping below in between -> full displacement.
  if (aa + 2*ad + dd >= floor2) {
    const tStar = -ad / dd;                       // where the segment is nearest to q
    if (!(tStar > 0 && tStar < 1)) return 1;
    if (aa + 2*ad*tStar + dd*tStar*tStar >= floor2) return 1;
  }
  const disc = ad*ad - dd*(aa - floor2);
  if (disc <= 0) return 1;                        // never actually violates
  const t1 = (-ad - Math.sqrt(disc)) / dd;
  return t1 <= 0 ? 0 : (t1 >= 1 ? 1 : t1);
}

const FOCAL_K_HARD = Math.log(4); // focal -1 -> exponent 1/4
const FOCAL_K_SOFT = Math.log(2); // focal +1 -> exponent 2
function focalExponent(focal) {
  if (!Number.isFinite(focal)) return 1; // absent/garbage -> today's behavior, never NaN
  const f = Math.min(1, Math.max(-1, focal));
  if (f === 0) return 1;
  return Math.exp((f < 0 ? FOCAL_K_HARD : FOCAL_K_SOFT) * f);
}

// THE CUSTOM BRUSH'S FALLOFF (mode 8). `curve` is a lookup table of SIGNED strengths sampled at
// even distances from the brush center: index 0 is the center, the last index is the rim, and a
// value runs -1..+1. Positive pushes out along the normal, negative pushes in — so one dab can
// raise a mound AND cut a moat around it, which is the whole reason mode 8 exists rather than
// being a reshaped Build.
//
// ⚠ LINEAR interpolation between LUT samples, deliberately. index.html builds this table from the
// student's control points with whatever smoothing the Roundness control asks for; re-smoothing it
// here would be a SECOND shaping the editor cannot show, and the button preview (plotted from this
// same table) would stop being the curve the kernel reads.
//
// A missing/short table falls back to the smoothstep dome every other brush uses. That is not a
// silent substitution — index.html always supplies one, and its absence would mean mode 8 was
// dispatched by a caller that does not know about the curve at all, for which "behave like Build"
// is the only non-destructive answer available inside a per-vertex loop.
function curveSample(curve, u) {
  if (!curve || curve.length < 2) { const t = 1 - u; return t * t * (3 - 2 * t); }
  const uc = u <= 0 ? 0 : (u >= 1 ? 1 : u);
  const f = uc * (curve.length - 1);
  const i0 = Math.floor(f);
  if (i0 >= curve.length - 1) return curve[curve.length - 1];
  const g = f - i0;
  return curve[i0] * (1 - g) + curve[i0 + 1] * g;
}

// The modes front-face masking actually applies to: the ones that DEPOSIT along the surface
// normal, and so the only ones that can push two sides of a thin feature toward each other.
// EXPORTED because index.html must disable the Front faces button on every other brush — a lit
// button on Move or Smooth is the app promising a safety guarantee this line refuses to give it.
// Mode 8 (Custom) is here for the same reason as 0/3/4: it pushes along the normal, so it has a
// contact direction to mask against and the same thin-fin failure without one.
export const FRONT_FACE_MODES = new Set([0, 3, 4, 8]);

// CREASE'S LATERAL GATHER (mode 4). A crease brush is TWO superposed terms, not one: an inward
// push along -normal (the cut) AND a pull of the surrounding surface sideways toward the stroke
// (the gather). Three vendors document the pair, and Nomad states the failure mode of leaving the
// gather out — "deep creases ... will look jagged because not enough geo is pulled toward the
// crease to define the sides or the bottom of the crease accurately"
// (https://nomadsculpt.com/manual/tools). Blender's Crease is "Create sharp indents or ridges by
// pushing or pulling the mesh, while pinching the vertices together"
// (https://docs.blender.org/manual/en/latest/sculpt_paint/sculpting/brushes/crease.html), with the
// gather exposed as a Pinch factor over 0..1. Maxon's only published word on the ZBrush equivalent
// is that "the behavior of the Dam Standard brush is that it tries to pinch"
// (https://help.maxon.net/zbr/en-us/Content/html/user-guide/3d-modeling/cloth-simulation/cloth-brushes/cloth-brushes.html).
//
// 0.5 is Blender's own shipped default for the same control (crease_pinch_factor). It is used
// here as the value a caller that never mentions creasePinch gets, rather than 0: a caller that
// has not heard of the parameter must still get the brush this file defines, and 0 would be a
// silent downgrade to the inward-push-only brush that has no lateral term at all.
const CREASE_PINCH_DEFAULT = 0.5;

// HOW FAR ONE DAB MAY DRAG A VERTEX SIDEWAYS, as a fraction of its distance to the dab center.
//
// ⚠ WITHOUT THIS CEILING THE SLIDER REVERSES ABOVE ITS MIDDLE, measured: groove compression
// (mean edge length across the center line, after over before) ran 1.008 / 0.775 / 0.590 / 0.621
// / 0.788 / 0.993 at Pinch 0 / 0.25 / 0.5 / 0.6 / 0.75 / 0.9. Harder pinch, LESS crease, over the
// whole top half of the travel. The cause is the interaction with buildupTaper: an uncapped
// gather approaches 1 near the center of the dome, so a single dab drops a vertex almost exactly
// onto the stroke, that one jump spends the whole of CREASE_CAP_FRAC's budget, and the taper then
// shuts the brush — cut included — down for the rest of the stroke. The brush choked precisely
// where it was asked to work hardest.
//
// A gather is supposed to accumulate over a stroke, not complete in one dab; Blender's does, its
// per-dab term being a small fraction that many dabs sum. Capping the step restores that, and it
// is a CEILING rather than a rescaling so the useful lower half of the slider is untouched — the
// value below is under the point where the reversal begins, so everything from 0 to that point
// behaves exactly as it did before this constant existed.
const CREASE_PINCH_STEP = 0.12;

// A dab that carries no drag at all. Module-level so the per-vertex loop never allocates one.
// How often the guard actually bound, and how many vertices it was offered. The design question
// for the separation floor is not "does it prevent crossings" but "how often does it fire on work
// that was never going to cross", and that cannot be answered without counting. Reset by the
// caller at the start of a stroke.
let clampBound = 0, clampOffered = 0;
export function separationClampStats() { return { bound: clampBound, offered: clampOffered }; }
export function resetSeparationClampStats() { clampBound = 0; clampOffered = 0; }

// How many rings of a vertex's own surface the separation guard treats as ITSELF.
//
// This is the number the guard's whole character turns on, and at 2 it behaved like two different
// tools: on a textured form it created harder features beneath the surface and was far too
// sensitive about what it was used on. Measured:
//
//                       clamp rate on a textured form   crossings on a smooth form
//   2 rings (before)             63.1%                      0   (15 unguarded)
//   4 rings (now)                33.3%                      0
//
// On a smooth form nothing outside your two-ring is ever within the floor, so the guard never fired
// and was invisible and free. On a form with detail the surface folds back, so a vertex's OWN
// geometry three and four rings away sits inside the floor and reads as an intruder — the guard
// bound on two writes in three and froze vertices mid-stroke, which is what those harder
// features are.
// It prevented nothing for it: 943 crossings against 835 with the guard off entirely.
//
// 4 keeps every bit of protection that works — a smooth form still ends at zero crossings where
// unguarded work reaches 15 — and halves the false positives. The cost is the walk, ~40 vertices
// instead of ~12, and only for vertices the guard already had in hand.
//
// ⚠ THIS DOES NOT MAKE THE GUARD RIGHT, it makes it less wrong. It still binds on a third of writes
// over heavy detail, because a proximity floor cannot express "would this move CROSS something",
// only "is this near something". The real answer is a swept test against nearby triangles instead
// of a separation shell. _probe_separation_shell.mjs holds the numbers that argue for it.
const RING_EXCLUDE = 4;

const ZERO_DRAG = [0, 0, 0];

// ---- The direction a DEPOSIT brush pushes ---------------------------------------------------
// Build pushed every vertex along ITS OWN normal — byte for byte the expression Inflate uses, at a
// different gain. Displacing a curved surface along its own local normals is a normal OFFSET, and
// an offset does not merely move points, it changes their SPACING: spreading them where the
// surface is convex, crowding them where it is concave, in proportion to curvature times distance.
// The distorted spacing then feeds the next dab, so the error compounds. That is why a Build
// stroke went from smooth to less smooth the longer it was worked, and why six ordinary strokes
// could drive the surface through itself.
//
// Measured over eight passes of one arc, before: high-frequency roughness per unit height climbed
// 3.1x, and after the height had PLATEAUED at lap 3 the surface went on roughening a further 51%
// while gaining nothing at all. ~1,300 vertices were still moving on lap 8 — deposition had not
// stopped, it was redistributing.
//
// One direction per dab — the mean normal over the dab's footprint, from the same fit Flatten uses
// — makes each dab a translation of a patch, and translating a patch cannot change its shape. This
// is Blender's Area sculpt-normal and ZBrush's ClayBuildup. Per-vertex normals stay INFLATE's
// behavior, deliberately: that is the difference between the two brushes, and until now they were
// the same formula at two gains.
//
// WHAT IT BOUGHT, all measured:
//   high-frequency roughness per unit height, lap 8   0.0294 -> 0.0102
//   the runaway, laps 5-8 (the reported symptom)       +19%  -> +0.6%, i.e. it settles
//   self-intersections, ordinary work, GUARD OFF       130   -> 0
//   height reached over eight laps                     4.84  -> 9.68 mean edges (it now builds)
//   crest curvature, lap 8, normalized                 -1.283 -> -0.965
//   flat-top fraction across the eight laps            0.158 -> 0.143 (LESS flat, not more)
//
// The crest number is the cost and it is a real one: the ridge's normalized section is broader,
// because the divergence that roughened the surface is the same divergence that sharpened the
// crest. It is not the flat-top failure — that is flatFrac, which improves — and the ridge is also
// half again as tall, so in absolute curvature the loss is about 16% rather than 25%.
//
// ⚠ FIVE OTHER FIXES WERE BUILT AND MEASURED AND NONE OF THEM WORKED: averaging the normal over a
// one-ring, six diffusion passes, 1/cos tilt compensation, extra hardness, and tangential
// relaxation of the spacing. Each either bought almost nothing or destroyed the crest outright.
// _probe_deposit_normal.mjs carries the whole table; read it before trying any of them again.
// ⚠ THE DAB'S HIT NORMAL FIRST, AND SYMMETRY IS THE REASON. Averaging the footprint gives the same
// answer to three figures, but it is not mirror-EXACT: the mean depends on exactly which vertices
// fall inside the radius, and one vertex sitting an ulp either side of that boundary moves the
// average. Under a mirror that showed up as 1.3e-4 of asymmetry where spatial_scope_guard requires
// 1e-6 — invisible on screen, and still a symmetric stroke that is not symmetric. hitNormals for
// the mirrored copies are produced by carrying the original through the same transform, so they
// are exact by construction, and the value is the surface normal at the dab center, which is what
// the footprint mean was approximating anyway.
//
// The footprint fit stays as the fallback for callers that pass no hit normals — the synthetic
// two-sheet fixtures in overlap_guard drive applyBrushScoped directly with hitNormals: null — and
// the vertex's own normal is the last resort, never a zero vector, which would freeze the brush
// silently rather than fail loudly.
function depositNormal(hitNormals, planes, bestC, normals, i) {
  const hn = hitNormals && hitNormals[bestC];
  if (hn) return hn;
  const pl = planes && planes[bestC];
  if (pl && pl.count > 0) return [pl.nx, pl.ny, pl.nz];
  return [normals[i*3], normals[i*3+1], normals[i*3+2]];
}


// SWIRL (mode 9) — ZBrush ships this as "Twist". Maxon's three sliders give the mechanism away:
// Twist Rate is "orbital speed around the brush during application", Radius "controls the falloff
// of the twist rate", and Centrifugal is "how much of the surface will be pulled or pushed as the
// twisting is happening". So it is an orbit about the contact normal whose ANGLE varies with
// distance, plus a separable radial term.
//
// ⚠ THE FALLOFF IS THE ENTIRE DEFORMATION, not a softening of one. Rotate every vertex under the
// brush by the SAME angle and you have applied a rigid motion: thousands of vertices move, every
// "did the surface change?" test passes, and the shape is identical. What deforms the surface is
// that the inner vertices orbit FURTHER than the outer ones, shearing the patch into a spiral. A
// gate for this brush has to assert the angular GRADIENT across the footprint; asserting
// displacement certifies the version that does nothing.
//
// TWIST RATE IS NOT A SECOND SLIDER HERE, deliberately. ZBrush separates Twist Rate from brush
// intensity; in this kernel the angle is `strength * SWIRL_TURN * falloff`, so Strength already
// IS the rate — shipping both would be two knobs multiplying into one quantity, and a student
// would have no way to tell which one was doing the work. Centrifugal is genuinely independent
// (it changes the radius, not the angle) and is exposed.
const SWIRL_TURN = 0.9;   // radians of orbit at full strength, dead center, one dab. ~52°: a
                          // single dab reads as a definite turn, and the taper still leaves the
                          // rim near-still, which is where the shear comes from.

// The handedness of this symmetric copy: +1 if it was placed by a rotation, -1 if a reflection.
// ⚠ A MIRRORED ROTATION RUNS BACKWARDS, and nothing else in this kernel has had to care. Every
// other brush moves along a vector, and a mirrored vector is just a mirrored vector; an orbit is
// a PSEUDOvector, so the mirror image of a clockwise swirl is an anticlockwise one. Apply the
// same signed angle on both sides of an X-mirror and you get a rotated copy where the student
// asked for a mirror image — the two halves of the face swirl the same way round.
// Derived rather than plumbed: `frames` already carries a tangent pair per copy, mirrored and
// spun by whichever transform placed it (it has to be, or stamped alphas would come out
// un-flipped), so sign((u x v) . n) reports the handedness of every copy — mirrors, glides,
// point-group reflections — with no new array to keep in step at four construction sites.
export function swirlChirality(frames, hitNormals, c) {
  const fr = frames && frames[c], hn = hitNormals && hitNormals[c];
  if (!fr || !fr[0] || !fr[1] || !hn) return 1;
  const [u, v] = fr;
  const cx = u[1]*v[2] - u[2]*v[1], cy = u[2]*v[0] - u[0]*v[2], cz = u[0]*v[1] - u[1]*v[0];
  const dot = cx*hn[0] + cy*hn[1] + cz*hn[2];
  return dot < 0 ? -1 : 1;
}

// One orbit step, shared by applyBrush and applyBrushScoped so the two paths cannot drift.
// Writes into `out`. `ax,ay,az` must be unit length (a contact normal always is).
// The radial vector is projected into the tangent plane FIRST, which is what makes the two terms
// separable: a rotation about the axis preserves |r| exactly, so `gain` is the only thing that can
// change the distance from the axis, and Centrifugal can be measured on its own.
const SWIRL_OUT = [0, 0, 0];
function swirlStep(px, py, pz, cx, cy, cz, ax, ay, az, ang, gain) {
  let rx = px - cx, ry = py - cy, rz = pz - cz;
  const along = rx*ax + ry*ay + rz*az;
  rx -= ax*along; ry -= ay*along; rz -= az*along;
  // r is now perpendicular to the axis, so Rodrigues collapses to r cos + (axis x r) sin —
  // the (axis . r) term is zero by construction and is not computed.
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const kx = ay*rz - az*ry, ky = az*rx - ax*rz, kz = ax*ry - ay*rx;
  SWIRL_OUT[0] = cx + ax*along + (rx*ca + kx*sa) * gain;
  SWIRL_OUT[1] = cy + ay*along + (ry*ca + ky*sa) * gain;
  SWIRL_OUT[2] = cz + az*along + (rz*ca + kz*sa) * gain;
  return SWIRL_OUT;
}


// ⚠ THE GATHER PULLS ACROSS THE STROKE, NEVER ALONG IT — and that projection is what makes the
// difference between a groove and a smear. The gather used to pull each vertex toward its own
// nearest DAB CENTER. A dab center is a point, so "toward it" has a component running down the
// length of the stroke as well as into it, and successive dabs pull the same vertex toward
// different points along that length. Measured on a 221,184-quad sphere at the shipped default:
//
//                                    toward the center point     across the stroke
//   share of motion running ALONG the stroke     0.584                  0.064
//   groove-floor roughness down its own length   0.081                  0.032   (0.030 = no gather)
//   per-vertex tearing, in mean edges            0.096                  0.044   (0.004 = no gather)
//   edges ACROSS the groove, after/before        0.665                  0.511   (lower is a wall)
//   edges ALONG the groove, after/before         0.857                  1.015   (1.0 is no bunching)
//   half-depth width, in brush radii             0.313                  0.250
//   mean depth at the center line               -0.025                 -0.048   (-0.048 = no gather)
//
// The last two rows are the ones a person sees. Dragging material along the groove both widened
// the mark and spent it: every vertex's own lateral travel counts toward buildupTaper, so the
// along-stroke drag consumed the cut's budget and the groove came out HALF as deep as the same
// brush with the gather switched off — while neighboring vertices reached that ceiling at
// different moments, which is a torn floor rather than an evenly shallow one. Confining the
// gather to across restores the full depth without touching the taper.
//
// THE TAPER STAYS ON TOTAL DISPLACEMENT, and that was tested rather than assumed: measuring it on
// the cut's depth alone — so the gather could not spend the cut's budget — let the lateral term
// run unchecked and blew the groove open (per-vertex tearing 0.61, half-width 0.69 radii, and the
// across-groove edges STRETCHING to 1.10 instead of compressing). The taper is what bounds the
// gather; it is only the along-stroke component that must not be fed into it.
//
// The direction comes from `dragDeltas`, which the kernel already carries per symmetric copy and
// which getSymmetryCopies already mirrors and rotates — so a mirrored crease gathers across its
// own mirrored stroke, with no new plumbing and no new signature. With no direction at all — a
// single stamped dab, a click, the drag-rect stamp, all of which pass a zero drag — the
// projection is skipped and the gather is radial. That is the same formula with the line
// degenerated to a point, not a special case: a lone dab's crease is a round pit, and every
// direction out of it is across. A freehand stroke never takes that path, because the first dab
// lands on the first pointermove and already has a delta.

// DISTANCE FROM A VERTEX TO THE PATH ONE DAB SWEPT, rather than to where the dab ended.
//
// Used only to shape buildupTaper's ceiling, never the falloff.
//
// ⚠ THE REASON IS SAMPLE-RATE INDEPENDENCE. A stroke's mark is swept, so the shape it converges
// to is the brush profile of the distance to the PATH. Measured from the dab CENTER instead, a
// crest vertex's best-ever profile is the dome read at HALF THE DAB SPACING rather than at zero,
// so the ceiling a stroke converges to moves with how densely the pointer happened to be sampled.
// index.html already scales each dab by distThisSample precisely so that a fast drag and a slow
// one lay down the same amount over the same path; a ceiling that drifted with the sample rate
// would undo that guarantee from the other end. Here the two forms coincide by construction: a
// vertex on the path is at distance zero from it however far apart the samples fell.
//
// On a densely-sampled stroke the two are indistinguishable — along-crest roughness 0.0631 against
// 0.0629 — which is why the probe could not separate them and the arithmetic has to.
//
// A dab with no drag (a click, the drag-rect stamp) degenerates to the point, which is the right
// answer for a dab that swept nothing. dSeg is never greater than the distance to the center, so
// this ceiling is never tighter than the center form's.
function sweptDistance(px, py, pz, cx, cy, cz, dx, dy, dz) {
  const L2 = dx*dx + dy*dy + dz*dz;
  if (L2 <= 0) return Math.hypot(px-cx, py-cy, pz-cz);
  const ax = cx - dx, ay = cy - dy, az = cz - dz;   // where this dab started
  let tt = ((px-ax)*dx + (py-ay)*dy + (pz-az)*dz) / L2;
  if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
  return Math.hypot(px - (ax + dx*tt), py - (ay + dy*tt), pz - (az + dz*tt));
}

export function createBrushPass() {
  // Modes 3-6 sit on top of the original three (critique §3, the brush octet). Each is
  // ~30 lines once the falloff/snapshot kernel already exists. Two falloff SHAPES are used, not
  // just one: the original smoothstep (round, dome-like — Build/Move/Smooth/Inflate/
  // Pinch/Flatten) and a sharper pow(t,4) spike (Crease) — a real brush needs more than
  // one curve or every mode reads as the same push with a different label.
  // Mode 7 (Hook/SnakeHook) reuses the
  // pow(t,4) spike falloff on top of Tractor's own drag mechanic — a genuine third
  // combination (sharp falloff + drag, not push), not just an 8th coat of paint.
  // ⚠ X/Y/Z/RADIAL MIRROR: the signature takes `centers`/`dragDeltas` ARRAYS rather than a
  // single `center`/`dragDelta` — one entry per symmetric copy (length 1 when symmetry is
  // off). This is the fix for a real bug: a single-center shape calls applyBrush once per
  // copy, each one a full, independent, SEQUENTIAL write to the same positions array — a
  // vertex sitting inside multiple copies' footprints (guaranteed near a radial mirror's
  // own rotation axis at N>=3) got hit by every one of them, compounding displacement up
  // to Nx at exactly the seam that should be cleanest. Fixed by finding, per vertex, the
  // SINGLE nearest copy and applying only its contribution once — never summed, never
  // sequential-and-compounding, regardless of how many copies overlap.
  // COLLISION AVOIDANCE: `hitNormals` (parallel to `centers`) + `collisionAvoidance` add
  // FRONT-FACE MASKING — the real centerpiece a design review identified, rather than the
  // displacement clamp first drafted. `applyBrush`
  // used to select vertices by pure distance to `center`; on a thin feature (the tentacle-
  // garbage case), the surface's BACK side falls inside the same brush sphere as the
  // front, so both sides got pushed toward each other — that IS the actual mechanism
  // behind the self-intersecting garbage that tuning strength/spacing can only work around.
  // Scoped to modes 0/3/4 (Build/Inflate/Crease) only — the
  // "deposit along the normal" brushes, the ones actually prone to this failure mode
  // (Move/Hook follow real cursor motion, Smooth/Pinch/Flatten converge toward a target,
  // neither can push two sides of a thin feature toward each other the way a normal-push
  // brush can). Matches ZBrush's own BackfaceMask / Blender's "Front Faces Only" / Nomad
  // Sculpt's on-by-default equivalent — a real, standard technique, not invented here.
  // NON-FINITE GUARDS: without them nothing in this file checks isFinite/isNaN anywhere, and
  // a single NaN reaching any of the eight write branches is committed straight into the live
  // position array, where it is unrecoverable (the next
  // sample's snapshot, the Laplacian neighbor average, the Flatten plane accumulation and
  // computeQuadNormals all read it back and spread it). Measured, not assumed: a harness
  // injecting one corrupted normal/mask/drag/strength produced 900-165,894 non-finite
  // position components on a 55,298-vertex mesh pre-guard. The guard shape is deliberately
  // ONE check on the summed candidate displacement per WRITTEN vertex, not nine component
  // checks: if any of the three is NaN or +/-Inf the sum is non-finite too (+Inf + -Inf is
  // NaN, still non-finite), so one Number.isFinite is exactly as strong as three and costs
  // ~1% of a call instead of ~10%. Vertices the brush never touches pay nothing — the
  // check lives after the existing radius/front-face `continue`s, not before them.
  function applyBrush(positions, normals, vnOffset, vnList, mask, nv, { mode, centers, radius, strength, dragDeltas, hitNormals, collisionAvoidance, strokeBaseline, strokeShapeMax, focal, alphaTex, frames, stretchLimit, curve, creasePinch, centrifugal, recallTarget, recallValid }) {
    // Cheap per-CALL entry guard (once, not per vertex): a non-finite radius or strength
    // makes EVERY vertex's displacement non-finite, so there is nothing worth computing.
    // radius <= 0 is already a no-op today (the `d < bestD` test can never pass with
    // bestD initialized to 0 or less), so returning here is behavior-neutral, not new.
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return;
    const snap = positions.slice();
    const nc = centers.length;
    const focalPow = focalExponent(focal); // once per call, not per vertex
    const useFrontFaceMask = collisionAvoidance && hitNormals && FRONT_FACE_MODES.has(mode);
    const swirlChir = mode === 9 ? centers.map((_, c) => swirlChirality(frames, hitNormals, c)) : null;
    // Real ClayBuildup samples the surface UNDER the stroke INCLUDING the current
    // stroke's own height — that's what makes repeated passes over the same spot
    // self-limit instead of piling up indefinitely (confirmed against Pixologic's own
    // brush docs, not assumed). `strokeBaseline` is the mesh's position array from the
    // moment the CURRENT stroke started (pointerdown), so "how far has this vertex
    // already moved this stroke" is a real measured quantity, not a guess.
    //
    // ⚠ ALSO APPLIED TO CREASE (mode 4), with a tighter cap. It is a feel change to a shipped
    // brush, and the evidence for it is that the DEFAULT Crease shreds a mesh into
    // self-intersecting shards after very little work. Crease is a deposit brush — it pushes a
    // fixed amount
    // along -normal per dab with nothing that converges — so like Build it accumulates without
    // limit; unlike Build it had no taper at all, which is the whole bug.
    //
    // Crease's cap is HALF Build's. A crease is a groove, not a mound: cutting half a brush
    // radius deep is already past anything legible and past where the groove's opposite walls
    // start colliding. Move/Smooth/Pinch/Flatten/Hook stay exempt and are still correct to be
    // — each is either bounded by real motion or converges toward a target, so none of them
    // can run away this way.
    const BUILDUP_CAP_FRAC = 0.5;  // Build/Inflate/Custom: how much one stroke may pile on one spot
    const CREASE_CAP_FRAC  = 0.25; // Crease: half that — a groove deeper self-collides
    // Clamped once per call, not per vertex. See CREASE_PINCH_DEFAULT for why an absent value is
    // the default rather than 0.
    //
    // SQUARED, following Blender, whose crease.cc computes its gather strength as
    // `crease_correction = brush.crease_pinch_factor * brush.crease_pinch_factor`. The square is
    // what keeps Crease reading as a CUT at the middle of the slider: the gather's reach is the
    // distance to the dab center, which is a whole brush radius out at the rim, so an unsquared
    // factor makes the sideways term outrun the cut and the brush turns into Pinch with a dent.
    // Squared, the default sits a little under the cut's own depth, and the top of the slider is
    // still reachable when a hard edge needs it.
    const pinchRaw = Number.isFinite(creasePinch)
      ? (creasePinch < 0 ? 0 : (creasePinch > 1 ? 1 : creasePinch))
      : CREASE_PINCH_DEFAULT;
    const pinchAmt = pinchRaw * pinchRaw;
    // ⚠ THE CEILING IS THE MARK'S OWN SHAPE, NOT ONE NUMBER FOR THE WHOLE FOOTPRINT — and that
    // is the difference between a mound and a plateau.
    //
    // Measured on the shipped defaults (Build, size 0.16, strength 1, 55,296 quads), one
    // continuous stroke scrubbed back and forth over the same arc eight times — the stroke a
    // person actually makes, and the only one in which `built` gets anywhere near the ceiling.
    // With a flat cap the crest's dimensionless curvature ran -1.19 -> -0.88 over the whole mark
    // and -0.85 -> -0.17 over its first half: the mark stops being a dome and levels off, because
    // every vertex under the footprint converges on the SAME height and the falloff only decides
    // how fast it gets there. That is the flat top, and it is NOT the ceiling being hit abruptly:
    // no vertex ever reaches it (max built/cap 0.962 after eight laps, zero vertices at the cap),
    // because 1-smoothstep already approaches zero asymptotically. Softening the approach further
    // would not have moved the crest at all. It is the ceiling being the same number everywhere.
    //
    // With the ceiling scaled by the shape, the surface the taper drives toward IS the dab's own
    // dome. The bound is strictly TIGHTER than before at every vertex except the exact center, so
    // nothing about the runaway protection three earlier builds paid for is weakened.
    //
    // ⚠ AND IT MUST BE THE HIGH-WATER SHAPE, NOT THIS DAB'S. Scaling by the CURRENT dab's falloff
    // was tried first and scalloped the crest at the dab spacing: once a vertex has built up to
    // its dome height, every dab not centered exactly on it offers a lower ceiling, reads as
    // over-ceiling, and deposits nothing — so material only ever lands at dab centers, and the
    // along-crest roughness went 0.032 -> 0.105. `strokeShapeMax` is the largest shape this vertex
    // has seen from ANY dab this stroke, which for a swept stroke is the dab profile at its own
    // closest approach; that brings it back to 0.063. A caller that passes no array gets the
    // current dab's shape, which is the same thing for the single-dab stamp paths and is why they
    // need no array.
    //
    // The shape itself comes from sweptDistance rather than from the distance to the dab center —
    // see that function for why.
    //
    // Crease (mode 4) passes no shape and keeps the flat ceiling deliberately. Its taper governs
    // a CUT and a lateral GATHER together, and the two have different footprints: scaling the
    // ceiling by the cut's narrow t^4 would shut the gather down out where the gather does its
    // work, which is exactly the starved groove wall the gather exists to prevent.
    const buildupTaper = (i, capFrac = BUILDUP_CAP_FRAC, shape) => {
      if (!strokeBaseline) return 1;
      const bx = strokeBaseline[i*3], by = strokeBaseline[i*3+1], bz = strokeBaseline[i*3+2];
      const built = Math.hypot(positions[i*3]-bx, positions[i*3+1]-by, positions[i*3+2]-bz);
      let sh = 1;
      if (shape !== undefined) {
        // Magnitude: mode 8's curve is SIGNED (a welt cuts as well as builds), and a ceiling is
        // a distance.
        sh = shape < 0 ? -shape : shape;
        if (strokeShapeMax) {
          if (sh > strokeShapeMax[i]) strokeShapeMax[i] = sh; else sh = strokeShapeMax[i];
        }
      }
      const cap = radius * capFrac * sh;
      if (cap <= 0) return 1; // shape 0 deposits nothing anyway; returning 1 keeps this NaN-free
      const t = Math.min(1, built / cap);
      return 1 - t*t*(3-2*t); // smoothstep taper to 0 as this stroke's own buildup nears the cap
    };

    // Flatten (mode 6) needs an average PLANE (position + normal) over the brush's
    // footprint before it can push anything — one accumulation pass PER COPY (each
    // symmetric copy has its own local plane), using the same snapshot every other mode
    // reads from. Modes 0-5 don't need this and skip straight to the main loop.
    // Flatten always needs the fit. Build needs it only as a FALLBACK, for callers that pass no hit
    // normals — so it is not computed on the interactive path, where hitNormals is always present
    // and the fit would be an O(candidates x dabs) scan whose result is thrown away.
    const planes = (mode === 6 || ((mode === 0 || mode === 9) && !hitNormals)) ? centers.map(([cx, cy, cz]) => {
      let pcx = 0, pcy = 0, pcz = 0, pnx = 0, pny = 0, pnz = 1, count = 0;
      for (let i = 0; i < nv; i++) {
        const px = snap[i*3], py = snap[i*3+1], pz = snap[i*3+2];
        const d = Math.hypot(px-cx, py-cy, pz-cz);
        if (d >= radius) continue;
        pcx += px; pcy += py; pcz += pz;
        pnx += normals[i*3]; pny += normals[i*3+1]; pnz += normals[i*3+2];
        count++;
      }
      if (count > 0) {
        pcx /= count; pcy /= count; pcz /= count;
        const nl = Math.hypot(pnx, pny, pnz) || 1;
        pnx /= nl; pny /= nl; pnz /= nl;
      }
      return { cx: pcx, cy: pcy, cz: pcz, nx: pnx, ny: pny, nz: pnz, count };
    }) : null;

    for (let i = 0; i < nv; i++) {
      const px = snap[i*3], py = snap[i*3+1], pz = snap[i*3+2];
      // find the SINGLE nearest symmetric copy affecting this vertex — see the function-
      // level comment above for why this must never be "apply every copy that's in range."
      let bestC = -1, bestD = radius;
      for (let c = 0; c < nc; c++) {
        const [ccx, ccy, ccz] = centers[c];
        const d = Math.hypot(px-ccx, py-ccy, pz-ccz);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (bestC === -1) continue;
      // Front-face masking: skip a vertex whose own normal opposes the brush's contact
      // normal at this copy — the surface facing AWAY from where the brush actually
      // touched (a thin feature's back side) never gets pushed, so the two sides can't be
      // driven into each other. A plain dot-product test, no new data structures.
      if (useFrontFaceMask) {
        const hn = hitNormals[bestC];
        if (hn && (normals[i*3]*hn[0] + normals[i*3+1]*hn[1] + normals[i*3+2]*hn[2]) <= 0) continue;
      }
      const [cx, cy, cz] = centers[bestC];
      const dragDelta = dragDeltas ? dragDeltas[bestC] : null;
      const d = bestD;
      // Focal Shift remaps t before ANY consumer reads it — see focalExponent.
      // The `=== 1` branch is what makes the default byte-identical to the old kernel.
      const t = focalPow === 1 ? 1 - d/radius : Math.pow(1 - d/radius, focalPow), sm = t*t*(3-2*t);
      const aMul = alphaMultiplier(alphaTex, frames, bestC, px, py, pz, cx, cy, cz, radius);
      const falloff = sm * (1 - mask[i]) * aMul;
      // The shape buildupTaper measures its ceiling against: the mode's own profile, read at the
      // distance to the path this dab SWEPT rather than to where it ended. Computed only for the
      // three modes whose taper reads a shape, and only while a stroke baseline exists — without
      // one the taper returns 1 before it ever looks at a shape.
      let ceilShape;
      if (strokeBaseline && (mode === 0 || mode === 3 || mode === 8)) {
        const dd = dragDelta || ZERO_DRAG;
        const dSeg = sweptDistance(px, py, pz, cx, cy, cz, dd[0], dd[1], dd[2]);
        if (mode === 8) {
          ceilShape = curveSample(curve, dSeg / radius) * (1 - mask[i]) * aMul;
        } else {
          const tS = focalPow === 1 ? 1 - dSeg/radius : Math.pow(1 - dSeg/radius, focalPow);
          ceilShape = tS*tS*(3-2*tS) * (1 - mask[i]) * aMul;
        }
      }
      // Every mode computes its candidate position into wx/wy/wz and sets
      // `write`, instead of storing straight into `positions`. One guarded store at the
      // bottom of the loop replaces eight unguarded ones — same arithmetic, same order,
      // byte-identical output on finite input (proved by SHA-256 of the whole position
      // buffer across a 64-sample stroke in all 8 modes), but a non-finite result now
      // leaves the vertex at its PRIOR value instead of poisoning it permanently.
      let wx = 0, wy = 0, wz = 0, write = false;
      if (mode === 0) { // Accrete (ClayBuildup) — deposit along the normal, self-limiting
        const s0 = strength * falloff * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        const dn = depositNormal(hitNormals, planes, bestC, normals, i);
        wx = px + dn[0] * s0;
        wy = py + dn[1] * s0;
        wz = pz + dn[2] * s0;
        write = true;
      } else if (mode === 1) { // Tractor (Move) — follow the drag directly
        wx = px + dragDelta[0] * falloff;
        wy = py + dragDelta[1] * falloff;
        wz = pz + dragDelta[2] * falloff;
        write = true;
      } else if (mode === 2) { // Anneal (Smooth) — Laplacian relax toward the neighbor average
        const off = vnOffset[i], end = vnOffset[i+1];
        if (end > off) {
          let ax = 0, ay = 0, az = 0;
          for (let k = off; k < end; k++) { const nb = vnList[k]; ax += snap[nb*3]; ay += snap[nb*3+1]; az += snap[nb*3+2]; }
          const cnt = end - off; ax /= cnt; ay /= cnt; az /= cnt;
          const s = Math.min(1, Math.max(0, strength * falloff));
          wx = px + (ax-px) * s;
          wy = py + (ay-py) * s;
          wz = pz + (az-pz) * s;
          write = true;
        }
      } else if (mode === 3) { // Inflate — pushes each vertex along ITS OWN normal, and that is
        // now the whole difference from Accrete rather than a gain: Accrete moves every vertex
        // under a dab along one direction, the normal at the dab's center (see depositNormal),
        // so a dab translates a patch. Per-vertex normals make a curved surface diverge as it is
        // offset, which is what makes this swell like a balloon instead of building like clay —
        // and also what lets it fold a thin form onto itself, so it is the brush the separation
        // guard still has real work to do for.
        //
        // ⚠ The comment that stood here predicted the opposite: that Inflate might one day take
        // "an averaged-region normal instead of per-vertex". That change happened, to ACCRETE, and
        // per-vertex is deliberately kept here. Do not "finish" it by giving Inflate the dab
        // normal — the two brushes would collapse back into one, which brush_identity_guard
        // asserts against and which is the state they were in for the app's whole life.
        //
        // index.html still withholds Accrete's clay-deposit boost from this mode; it shares the
        // buildup taper for the same reason Accrete needs one.
        const s3 = strength * falloff * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        wx = px + normals[i*3]   * s3;
        wy = py + normals[i*3+1] * s3;
        wz = pz + normals[i*3+2] * s3;
        write = true;
      } else if (mode === 4) { // Crease — a narrow inward CUT plus a wide lateral GATHER.
        // TWO TERMS ON TWO DIFFERENT FALLOFFS, and the pairing is the whole brush:
        //
        //   the cut     t^4, tall and narrow — a groove, not a dome
        //   the gather  smoothstep, the round dome every other brush uses
        //
        // The gather is deliberately the WIDER of the two. Its job is to bring surface from
        // outside the groove INTO it, so a footprint no wider than the cut would have nothing
        // to fetch and the groove's walls would stay as sparse as the cut left them — which is
        // exactly the jaggedness Nomad describes when the lateral term is missing (see
        // CREASE_PINCH_DEFAULT). Sharpening the cut with Softness therefore narrows the groove
        // without starving its walls.
        //
        // Re-measured after the gather was confined to across the stroke, because a wide term is
        // exactly what a crease must not have if it widens the mark: running the gather on the
        // cut's own narrow t^4 instead left the half-depth width UNCHANGED at 0.25 radii and
        // pulled 11% less material into the walls (across-groove edges 0.561 against 0.511). The
        // wide falloff no longer widens anything, because width came from the along-stroke drag,
        // not from the footprint — so it is kept, and now it only does the job it claims to.
        //
        // The gather does NOT read `strength`, and that is not an oversight. Strength is the
        // depth of the cut and Pinch is the width of the gather — the same two-control split
        // Blender ships as Strength/Pinch and Nomad as Offset factor/Pinch factor. It is also
        // what makes Alt-invert behave: the cut flips to a raised ridge while the gather still
        // gathers, so an inverted Crease is a CRISP ridge rather than a soft welt. Blender takes
        // the absolute value of its own strength for the same reason.
        //
        // ⚠ pinchAmt === 0 REPRODUCES THE PRE-GATHER KERNEL BIT FOR BIT: g is then exactly 0,
        // and `px + tan*0` is px for every finite px, so the surviving expression is the old
        // one unchanged. The gate leans on that as its control.
        const taper = buildupTaper(i, CREASE_CAP_FRAC);
        const sharp = t*t*t*t;
        const creaseFalloff = sharp * (1 - mask[i]) * aMul * taper;
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const tcx = cx - px, tcy = cy - py, tcz = cz - pz;
        const nDot = tcx*nx + tcy*ny + tcz*nz;
        // TWO projections, and both are load-bearing. Tangential first, so the gather slides
        // material across the SURFACE instead of dragging it off; then across the STROKE, so it
        // pulls into the groove instead of down its length — see CREASE_PINCH_STEP for the
        // measurements that separate the two.
        let gx = tcx - nx*nDot, gy = tcy - ny*nDot, gz = tcz - nz*nDot;
        if (dragDelta) {
          const dl = Math.hypot(dragDelta[0], dragDelta[1], dragDelta[2]);
          // ⚠ MEASURED AGAINST THE BRUSH'S OWN SCALE, not against zero. A hit point raycast twice
          // at a near-stationary pointer differs by numerical noise, and normalizing that yields a
          // direction pointing anywhere at all — which would make "across the stroke" a different
          // arbitrary line every dab, i.e. the chatter this projection exists to remove, arriving
          // by another door. Below the floor there is no stroke direction to speak of and the
          // gather falls back to radial, which is the correct answer for a dab that is not moving.
          if (dl > radius * 1e-4) {
            const ax = dragDelta[0]/dl, ay = dragDelta[1]/dl, az = dragDelta[2]/dl;
            const an = ax*nx + ay*ny + az*nz;
            let ux = ax - nx*an, uy = ay - ny*an, uz = az - nz*an;
            const ul = Math.hypot(ux, uy, uz);
            if (ul > 1e-9) {
              ux /= ul; uy /= ul; uz /= ul;
              const al = gx*ux + gy*uy + gz*uz;
              gx -= ux*al; gy -= uy*al; gz -= uz*al;
            }
          }
        }
        const g = Math.min(CREASE_PINCH_STEP, Math.max(0, pinchAmt * sm * (1 - mask[i]) * aMul * taper));
        wx = px + gx * g - nx * strength * creaseFalloff;
        wy = py + gy * g - ny * strength * creaseFalloff;
        wz = pz + gz * g - nz * strength * creaseFalloff;
        write = true;
      } else if (mode === 5) { // Pinch — gather material toward the brush's center LINE,
        // not along the normal at all: project the vector-to-center onto the local
        // TANGENT plane (remove the normal component) and pull the vertex partway along
        // that tangential direction, sharpening whatever edge sits under the brush.
        // Clamp floor is -1, not 0, for Alt-invert: a negative `strength` (Alt
        // held) needs to survive this clamp to produce Pinch's real inverse — spreading
        // AWAY from center instead of gathering toward it — the same real ZBrush/Blender
        // Alt/Ctrl-Pinch behavior, not a no-op.
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const tcx = cx - px, tcy = cy - py, tcz = cz - pz;
        const nDot = tcx*nx + tcy*ny + tcz*nz;
        const tanX = tcx - nx*nDot, tanY = tcy - ny*nDot, tanZ = tcz - nz*nDot;
        const s = Math.min(1, Math.max(-1, strength * falloff));
        wx = px + tanX * s;
        wy = py + tanY * s;
        wz = pz + tanZ * s;
        write = true;
      } else if (mode === 6 && planes[bestC].count > 0) { // Flatten — project toward the
        // brush footprint's own average plane (position+normal accumulated above, per
        // symmetric copy), the standard ZBrush Flatten behavior: push high points down,
        // pull low points up, toward one shared reference plane rather than each vertex's
        // own normal.
        const pl = planes[bestC];
        const toV_X = px - pl.cx, toV_Y = py - pl.cy, toV_Z = pz - pl.cz;
        const signedDist = toV_X*pl.nx + toV_Y*pl.ny + toV_Z*pl.nz;
        const s = Math.min(1, Math.max(0, strength * falloff));
        wx = px - pl.nx * signedDist * s;
        wy = py - pl.ny * signedDist * s;
        wz = pz - pl.nz * signedDist * s;
        write = true;
      } else if (mode === 7) { // Hook (ZBrush SnakeHook / Blender Snake Hook)
        // — the SAME "follow the drag directly" mechanic as
        // Tractor/Move (mode 1), but with Crease's own narrow t^4 falloff (line 361) in
        // place of the round smoothstep dome every other drag-style brush uses. That's
        // the actual, real distinction both ZBrush and Blender ship this as a SEPARATE
        // brush from their own Move/Grab for: Move translates a whole rounded region
        // rigidly, Hook concentrates the same drag into a tight point, so repeated
        // stroke samples stretch a thin tapered appendage out of the surface (a horn,
        // tendril, spike) instead of shifting a broad area. Not a stronger pull — a
        // narrower one.
        const sharp = t*t*t*t;
        const hookFalloff = sharp * (1 - mask[i]) * aMul;
        wx = px + dragDelta[0] * hookFalloff;
        wy = py + dragDelta[1] * hookFalloff;
        wz = pz + dragDelta[2] * hookFalloff;
        write = true;
      } else if (mode === 8) { // Custom — the falloff profile is AUTHORED, not derived.
        // Deposits along the normal like Build, but reads its dome from `curve` instead of
        // smoothstep. Note what it deliberately does NOT read: `t`, and therefore `focal`. The
        // curve already maps distance to strength over its whole domain, so bending the distance
        // first would be a second reshaping the student never asked for and the editor cannot
        // draw. index.html makes Softness visibly unavailable on this brush for that reason.
        // The signed value is what makes a welt possible: `s8` simply goes negative near the rim
        // and the same normal-push line cuts instead of builds. buildupTaper measures the
        // MAGNITUDE of this stroke's own displacement, so it caps a groove exactly as it caps a
        // mound and no separate handling for the negative half is needed or wanted.
        const s8 = strength * curveSample(curve, d / radius) * (1 - mask[i]) * aMul * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        wx = px + normals[i*3]   * s8;
        wy = py + normals[i*3+1] * s8;
        wz = pz + normals[i*3+2] * s8;
        write = true;
      } else if (mode === 9) { // Swirl (ZBrush Twist) — orbit about the contact normal, at an
        // angle that FALLS OFF with distance. See swirlStep for why the falloff is the whole
        // deformation and why the angle carries the copy's handedness.
        const ax = depositNormal(hitNormals, planes, bestC, normals, i);
        const ang = strength * SWIRL_TURN * falloff * swirlChir[bestC];
        const gain = 1 + (centrifugal || 0) * strength * falloff;
        const o = swirlStep(px, py, pz, cx, cy, cz, ax[0], ax[1], ax[2], ang, gain);
        wx = o[0]; wy = o[1]; wz = o[2];
        write = true;
      } else if (mode === 10) { // Recall — blend toward a per-vertex TARGET this vertex once held.
        // ⚠ CONVERGING, NOT DEPOSITING — the same family as Smooth and Flatten. `strength*falloff`
        // is the FRACTION of the way to the target that one dab covers, so repeated passes
        // approach the target and cannot overshoot it. No buildupTaper and no ceiling: the target
        // is a real position this vertex actually held, and arriving at it exactly IS the feature.
        // ⚠ `recallValid[i] !== 1` means this vertex has no past distinct from its present, and it
        // is SKIPPED rather than blended toward itself. A zero-move write still enters `touched`,
        // is journalled, and is credited to the active layer — so "no history here" would leave
        // a record indistinguishable from an edit.
        if (recallValid && recallValid[i] === 1) {
          const f = Math.min(1, Math.max(0, strength * falloff));
          wx = px + (recallTarget[i*3]     - px) * f;
          wy = py + (recallTarget[i*3 + 1] - py) * f;
          wz = pz + (recallTarget[i*3 + 2] - pz) * f;
          write = true;
        }
      }
      // THE guard. One summed finiteness test, not nine component tests —
      // see the function-level comment. A vertex that fails it keeps whatever value it
      // already had; the brush simply has no effect there this sample, which is the only
      // recoverable outcome (a NaN written here can never be undone by a later stroke,
      // because every subsequent read — snapshot, Laplacian average, Flatten plane,
      // computeQuadNormals — propagates it outward instead of healing it).
      // STRETCH CLAMP, applied to the finished displacement so it governs every mode
      // uniformly rather than being threaded through eight separate formulas. Off (0/undefined)
      // it is one comparison per written vertex and changes nothing.
      if (write && stretchLimit > 0) {
        const dx = wx - px, dy = wy - py, dz = wz - pz;
        const dd = dx*dx + dy*dy + dz*dz;
        if (dd > 0) {
          let ts = 1;
          for (let k = vnOffset[i], end = vnOffset[i+1]; k < end; k++) {
            const nb = vnList[k];
            const t1 = stretchT(px, py, pz, dx, dy, dz, snap[nb*3], snap[nb*3+1], snap[nb*3+2], dd, stretchLimit);
            if (t1 < ts) ts = t1;
            if (ts <= 0) break;
          }
          if (ts < 1) { wx = px + dx * ts; wy = py + dy * ts; wz = pz + dz * ts; }
        }
      }
      if (write && Number.isFinite(wx + wy + wz)) {
        positions[i*3]   = wx;
        positions[i*3+1] = wy;
        positions[i*3+2] = wz;
      }
    }
  }
  // ================================================================
  // applyBrushScoped
  // ================================================================
  // Identical per-vertex arithmetic to applyBrush above, restructured to loop over spatial-
  // grid CANDIDATES instead of `for (let i = 0; i < nv; i++)`. Requirement is not "close" —
  // it is EXACT array equality against applyBrush across all eight modes over a full stroke
  // (see _verify/scoped_stroke_parity.mjs). Everything below that looks fussy is in service
  // of that, and each piece has a reason:
  //
  //   * ASCENDING candidate order. The unscoped loop visits vertices 0..nv-1, so any pass
  //     that ACCUMULATES across vertices (Flatten's plane fit) sums float contributions in
  //     that order. Float addition is not associative, so a different visiting order gives a
  //     numerically-equivalent but bit-different plane. candSorted is sorted for this reason.
  //   * THE SNAPSHOT COVERS CANDIDATES UNION THEIR EXACT ONE-RING. Anneal (mode 2) reads
  //     NEIGHBOR positions, and a neighbor can sit just outside the brush radius while still
  //     feeding a vertex inside it. The full-array `positions.slice()` the unscoped kernel
  //     takes exists precisely to stop an already-written neighbor's NEW value leaking into a
  //     not-yet-processed vertex's average — a genuine order-dependent data race that an
  //     earlier phase fixed deliberately. The scoped snapshot reproduces it by walking the
  //     real vn adjacency, so the covered set is exact by construction, not a radius guess.
  //   * Set/Map ARE used here, unlike Wall A. That is not an inconsistency: Wall A's Map was
  //     sized by TOTAL MESH EDGE COUNT and hit V8's 2^24 entry ceiling. Every container here
  //     is sized by BRUSH FOOTPRINT — bounded by radius, not by mesh size — and in the worst
  //     imaginable case (a radius swallowing the whole mesh) still bounded by nv, which is
  //     itself far below that ceiling for any mesh this kernel can hold.
  //
  // Returns { touched }: the ascending list of vertices actually WRITTEN this call. The
  // caller uses it for gridMoveVertex, for computeQuadNormalsScoped, and for its own
  // bufferSubData ranges.
  const snapSlot = new Map(); // vertex -> slot in snapVals; cleared and reused per call
  let snapVals = new Float32Array(3 * 4096);
  // Module-level so it survives across samples and is grown at most once per mesh size. Declared
  // outside the function for that reason alone; nothing else reads it.
  let ring2Stamp = null;
  // ⚠ MONOTONIC ACROSS CALLS, and must stay module-level. The stamp array persists, so a counter
  // that reset per call would reuse marks 1,2,3… and a vertex still carrying a stale mark reads
  // as in-ring and is skipped — a false exclusion that silently weakens the guard.
  let ring2Mark = 0;
  // Overlap-guard deferral buffers. The guard cannot apply its clamp inside the candidate loop
  // any more — the factor has to be blended across the ring first (see THE BLEND below) — so each
  // vertex's landing point and its raw factor are parked here and applied in a second pass.
  // Indexed by CANDIDATE INDEX (position in candSorted), except gSlotCi which is indexed by
  // snapshot slot. Allocated on first guarded call and grown, never shrunk; only entries gWrote
  // marked this call are ever read, so stale contents are unreachable rather than merely unlikely.
  let gTs = null, gTs2 = null, gWx = null, gWy = null, gWz = null, gSl = null, gWrote = null;
  // Snapshot slot -> candidate index, and the CSR of each candidate's ring in candidate-index
  // space. The blend runs a dozen passes over the ring, and resolving vnList through snapSlot
  // inside them was 76% of the guard's cost; resolved once, the passes touch only typed arrays.
  let gSlotCi = null, gNbOff = null, gNb = null;
  function applyBrushScoped(positions, normals, vnOffset, vnList, mask, nv, { mode, centers, radius, strength, dragDeltas, hitNormals, collisionAvoidance, strokeBaseline, strokeShapeMax, focal, alphaTex, frames, stretchLimit, selfCollide, meanEdge, curve, creasePinch, centrifugal, recallTarget, recallValid }, grid) {
    // meanEdge: the global figure `selfCollide` was derived from, so the guard can recover the
    // FRACTION the caller meant and re-apply it against each vertex's own local spacing.
    // curve: mode 8's authored falloff table — see applyBrush's mode 8.
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return { touched: [] };
    const nc = centers.length;
    const focalPow = focalExponent(focal); // once per call, not per vertex
    const useFrontFaceMask = collisionAvoidance && hitNormals && FRONT_FACE_MODES.has(mode);
    const swirlChir = mode === 9 ? centers.map((_, c) => swirlChirality(frames, hitNormals, c)) : null;

    // ---- candidates: union of the grid query over every symmetric copy ----
    const candSet = new Set();
    const qout = [];
    const nearOut = [];   // reused by the overlap guard; never allocated per vertex
    // TWO-RING EXCLUSION, by stamp rather than by Set: ring2Stamp[v] === ring2Mark means v is
    // within two edges of the vertex being guarded. A stamp array clears in O(1) by bumping the
    // mark, which matters because this is rebuilt for every guarded vertex — a Set would allocate
    // and clear ~150 entries per sample, on a path that runs a hundred thousand times a session.
    // Grown, never shrunk: a remesh can lower nv and the extra entries are simply unused, while
    // a subdivide raises it and must not read past the end. Reallocating zeroes the array, which
    // is safe at any time precisely because 0 is never a live mark (the counter is bumped BEFORE
    // its first use below).
    if (!ring2Stamp || ring2Stamp.length < nv) ring2Stamp = new Int32Array(nv);
    // Int32 overflow after ~2.1 billion guarded vertices would wrap to negative and could then
    // collide with stale marks. Cheap to make impossible rather than argue about.
    if (ring2Mark > 2000000000) { ring2Stamp.fill(0); ring2Mark = 0; }
    for (let c = 0; c < nc; c++) {
      const cc = centers[c];
      gridQueryRadius(grid, cc[0], cc[1], cc[2], radius, qout);
      for (let k = 0; k < qout.length; k++) candSet.add(qout[k]);
    }
    if (candSet.size === 0) return { touched: [] };

    // ---- snapshot: candidates UNION their exact one-ring (see the note above) ----
    snapSlot.clear();
    let slots = 0;
    const need = (candSet.size * 12) | 0; // generous first estimate; grown below if the ring is bigger
    if (snapVals.length < need * 3) snapVals = new Float32Array(Math.max(need * 3, snapVals.length * 2));
    const addSnap = (v) => {
      if (snapSlot.has(v)) return;
      if ((slots + 1) * 3 > snapVals.length) { const g = new Float32Array(snapVals.length * 2); g.set(snapVals); snapVals = g; }
      snapVals[slots*3] = positions[v*3]; snapVals[slots*3+1] = positions[v*3+1]; snapVals[slots*3+2] = positions[v*3+2];
      snapSlot.set(v, slots); slots++;
    };
    for (const v of candSet) addSnap(v);
    for (const v of candSet) { const off = vnOffset[v], end = vnOffset[v+1]; for (let k = off; k < end; k++) addSnap(vnList[k]); }

    const candSorted = Array.from(candSet); candSorted.sort((a, b) => a - b);

    // The guard's second pass needs somewhere to park every candidate's displacement. Sized and
    // cleared only when the guard is actually on: with it off this whole path costs one compare.
    const nCand = candSorted.length;
    const guarding = selfCollide > 0;
    if (guarding) {
      if (!gTs || gTs.length < nCand) {
        const cap = Math.max(nCand, 4096);
        gTs = new Float32Array(cap); gTs2 = new Float32Array(cap);
        // The LANDING POINT, at full doubles. Storing the displacement in float32 instead put a
        // rounding step between `w` and `p + d`, which broke the bit-identity C1 asserts for a stroke
        // with nothing to collide with.
        gWx = new Float64Array(cap); gWy = new Float64Array(cap); gWz = new Float64Array(cap);
        gSl = new Int32Array(cap); gWrote = new Uint8Array(cap);
        gSlotCi = new Int32Array(cap); gNbOff = new Int32Array(cap + 1);
      }
      if (!gNb) gNb = new Int32Array(4096);
      gWrote.fill(0, 0, nCand);
      // -1 is "no candidate in this slot". Cleared every call: a stale index from a larger
      // previous call would put an unrelated vertex in some other vertex's ring.
      gSlotCi.fill(-1, 0, nCand);
    }

    const BUILDUP_CAP_FRAC = 0.5;  // Build/Inflate/Custom: how much one stroke may pile on one spot
    const CREASE_CAP_FRAC  = 0.25; // Crease: half that — a groove deeper self-collides
    // Clamped once per call, not per vertex. See CREASE_PINCH_DEFAULT for why an absent value is
    // the default rather than 0.
    //
    // SQUARED, following Blender, whose crease.cc computes its gather strength as
    // `crease_correction = brush.crease_pinch_factor * brush.crease_pinch_factor`. The square is
    // what keeps Crease reading as a CUT at the middle of the slider: the gather's reach is the
    // distance to the dab center, which is a whole brush radius out at the rim, so an unsquared
    // factor makes the sideways term outrun the cut and the brush turns into Pinch with a dent.
    // Squared, the default sits a little under the cut's own depth, and the top of the slider is
    // still reachable when a hard edge needs it.
    const pinchRaw = Number.isFinite(creasePinch)
      ? (creasePinch < 0 ? 0 : (creasePinch > 1 ? 1 : creasePinch))
      : CREASE_PINCH_DEFAULT;
    const pinchAmt = pinchRaw * pinchRaw;
    // Shape-scaled ceiling with a per-stroke high-water mark, identical to applyBrush's — see
    // that copy for why a flat ceiling levels a mound into a plateau, why the ceiling has to be
    // the high-water shape rather than this dab's, and for the measurements.
    const buildupTaper = (i, capFrac = BUILDUP_CAP_FRAC, shape) => {
      if (!strokeBaseline) return 1;
      const bx = strokeBaseline[i*3], by = strokeBaseline[i*3+1], bz = strokeBaseline[i*3+2];
      const built = Math.hypot(positions[i*3]-bx, positions[i*3+1]-by, positions[i*3+2]-bz);
      let sh = 1;
      if (shape !== undefined) {
        sh = shape < 0 ? -shape : shape;
        if (strokeShapeMax) {
          if (sh > strokeShapeMax[i]) strokeShapeMax[i] = sh; else sh = strokeShapeMax[i];
        }
      }
      const cap = radius * capFrac * sh;
      if (cap <= 0) return 1;
      const t = Math.min(1, built / cap);
      return 1 - t*t*(3-2*t);
    };

    // Flatten's plane fit — the unscoped kernel's full-nv accumulation, restricted to the
    // same candidate set. No one-ring needed: it only reads vertices inside the radius, and
    // the grid query is a guaranteed superset of those (see gridQueryRadius).
    // Flatten always needs the fit. Build needs it only as a FALLBACK, for callers that pass no hit
    // normals — so it is not computed on the interactive path, where hitNormals is always present
    // and the fit would be an O(candidates x dabs) scan whose result is thrown away.
    const planes = (mode === 6 || ((mode === 0 || mode === 9) && !hitNormals)) ? centers.map(([cx, cy, cz]) => {
      let pcx = 0, pcy = 0, pcz = 0, pnx = 0, pny = 0, pnz = 1, count = 0;
      for (let ci = 0; ci < candSorted.length; ci++) {
        const i = candSorted[ci], sl = snapSlot.get(i) * 3;
        const px = snapVals[sl], py = snapVals[sl+1], pz = snapVals[sl+2];
        const d = Math.hypot(px-cx, py-cy, pz-cz);
        if (d >= radius) continue;
        pcx += px; pcy += py; pcz += pz;
        pnx += normals[i*3]; pny += normals[i*3+1]; pnz += normals[i*3+2];
        count++;
      }
      if (count > 0) { pcx /= count; pcy /= count; pcz /= count; const nl = Math.hypot(pnx, pny, pnz) || 1; pnx /= nl; pny /= nl; pnz /= nl; }
      return { cx: pcx, cy: pcy, cz: pcz, nx: pnx, ny: pny, nz: pnz, count };
    }) : null;

    const touched = [];
    for (let ci = 0; ci < candSorted.length; ci++) {
      const i = candSorted[ci], sl = snapSlot.get(i) * 3;
      const px = snapVals[sl], py = snapVals[sl+1], pz = snapVals[sl+2];
      let bestC = -1, bestD = radius;
      for (let c = 0; c < nc; c++) {
        const cc = centers[c];
        const d = Math.hypot(px-cc[0], py-cc[1], pz-cc[2]);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (bestC === -1) continue;
      if (useFrontFaceMask) {
        const hn = hitNormals[bestC];
        if (hn && (normals[i*3]*hn[0] + normals[i*3+1]*hn[1] + normals[i*3+2]*hn[2]) <= 0) continue;
      }
      const [cx, cy, cz] = centers[bestC];
      const dragDelta = dragDeltas ? dragDeltas[bestC] : null;
      const d = bestD;
      // Identical remap to applyBrush's, via the same shared focalExponent helper.
      const t = focalPow === 1 ? 1 - d/radius : Math.pow(1 - d/radius, focalPow), sm = t*t*(3-2*t);
      const aMul = alphaMultiplier(alphaTex, frames, bestC, px, py, pz, cx, cy, cz, radius);
      const falloff = sm * (1 - mask[i]) * aMul;
      // The shape buildupTaper measures its ceiling against: the mode's own profile, read at the
      // distance to the path this dab SWEPT rather than to where it ended. Computed only for the
      // three modes whose taper reads a shape, and only while a stroke baseline exists — without
      // one the taper returns 1 before it ever looks at a shape.
      let ceilShape;
      if (strokeBaseline && (mode === 0 || mode === 3 || mode === 8)) {
        const dd = dragDelta || ZERO_DRAG;
        const dSeg = sweptDistance(px, py, pz, cx, cy, cz, dd[0], dd[1], dd[2]);
        if (mode === 8) {
          ceilShape = curveSample(curve, dSeg / radius) * (1 - mask[i]) * aMul;
        } else {
          const tS = focalPow === 1 ? 1 - dSeg/radius : Math.pow(1 - dSeg/radius, focalPow);
          ceilShape = tS*tS*(3-2*tS) * (1 - mask[i]) * aMul;
        }
      }
      let wx = 0, wy = 0, wz = 0, write = false;
      if (mode === 0) {
        const s0 = strength * falloff * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        const dn = depositNormal(hitNormals, planes, bestC, normals, i);
        wx = px + dn[0]*s0; wy = py + dn[1]*s0; wz = pz + dn[2]*s0; write = true;
      } else if (mode === 1) {
        wx = px + dragDelta[0]*falloff; wy = py + dragDelta[1]*falloff; wz = pz + dragDelta[2]*falloff; write = true;
      } else if (mode === 2) {
        const off = vnOffset[i], end = vnOffset[i+1];
        if (end > off) {
          let ax = 0, ay = 0, az = 0;
          for (let k = off; k < end; k++) {
            const nb = vnList[k], ns = snapSlot.get(nb) * 3;
            ax += snapVals[ns]; ay += snapVals[ns+1]; az += snapVals[ns+2];
          }
          const cnt = end - off; ax /= cnt; ay /= cnt; az /= cnt;
          const s = Math.min(1, Math.max(0, strength * falloff));
          wx = px + (ax-px)*s; wy = py + (ay-py)*s; wz = pz + (az-pz)*s; write = true;
        }
      } else if (mode === 3) {
        const s3 = strength * falloff * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        wx = px + normals[i*3]*s3; wy = py + normals[i*3+1]*s3; wz = pz + normals[i*3+2]*s3; write = true;
      } else if (mode === 4) { // Crease — cut plus gather; see applyBrush's mode 4 for the pairing.
        const taper = buildupTaper(i, CREASE_CAP_FRAC);
        const sharp = t*t*t*t, creaseFalloff = sharp * (1 - mask[i]) * aMul * taper;
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const tcx = cx - px, tcy = cy - py, tcz = cz - pz;
        const nDot = tcx*nx + tcy*ny + tcz*nz;
        let gx = tcx - nx*nDot, gy = tcy - ny*nDot, gz = tcz - nz*nDot;
        if (dragDelta) {
          const dl = Math.hypot(dragDelta[0], dragDelta[1], dragDelta[2]);
          // ⚠ MEASURED AGAINST THE BRUSH'S OWN SCALE, not against zero. A hit point raycast twice
          // at a near-stationary pointer differs by numerical noise, and normalizing that yields a
          // direction pointing anywhere at all — which would make "across the stroke" a different
          // arbitrary line every dab, i.e. the chatter this projection exists to remove, arriving
          // by another door. Below the floor there is no stroke direction to speak of and the
          // gather falls back to radial, which is the correct answer for a dab that is not moving.
          if (dl > radius * 1e-4) {
            const ax = dragDelta[0]/dl, ay = dragDelta[1]/dl, az = dragDelta[2]/dl;
            const an = ax*nx + ay*ny + az*nz;
            let ux = ax - nx*an, uy = ay - ny*an, uz = az - nz*an;
            const ul = Math.hypot(ux, uy, uz);
            if (ul > 1e-9) {
              ux /= ul; uy /= ul; uz /= ul;
              const al = gx*ux + gy*uy + gz*uz;
              gx -= ux*al; gy -= uy*al; gz -= uz*al;
            }
          }
        }
        const g = Math.min(CREASE_PINCH_STEP, Math.max(0, pinchAmt * sm * (1 - mask[i]) * aMul * taper));
        wx = px + gx*g - nx*strength*creaseFalloff;
        wy = py + gy*g - ny*strength*creaseFalloff;
        wz = pz + gz*g - nz*strength*creaseFalloff; write = true;
      } else if (mode === 5) {
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const tcx = cx-px, tcy = cy-py, tcz = cz-pz;
        const nDot = tcx*nx + tcy*ny + tcz*nz;
        const tanX = tcx - nx*nDot, tanY = tcy - ny*nDot, tanZ = tcz - nz*nDot;
        const s = Math.min(1, Math.max(-1, strength * falloff));
        wx = px + tanX*s; wy = py + tanY*s; wz = pz + tanZ*s; write = true;
      } else if (mode === 6 && planes[bestC].count > 0) {
        const pl = planes[bestC];
        const toV_X = px-pl.cx, toV_Y = py-pl.cy, toV_Z = pz-pl.cz;
        const signedDist = toV_X*pl.nx + toV_Y*pl.ny + toV_Z*pl.nz;
        const s = Math.min(1, Math.max(0, strength * falloff));
        wx = px - pl.nx*signedDist*s; wy = py - pl.ny*signedDist*s; wz = pz - pl.nz*signedDist*s; write = true;
      } else if (mode === 7) {
        const sharp = t*t*t*t, hookFalloff = sharp * (1 - mask[i]) * aMul;
        wx = px + dragDelta[0]*hookFalloff; wy = py + dragDelta[1]*hookFalloff; wz = pz + dragDelta[2]*hookFalloff; write = true;
      } else if (mode === 8) { // Custom — see applyBrush's mode 8 for why `t`/`focal` are not read.
        const s8 = strength * curveSample(curve, d / radius) * (1 - mask[i]) * aMul * buildupTaper(i, BUILDUP_CAP_FRAC, ceilShape);
        wx = px + normals[i*3]*s8; wy = py + normals[i*3+1]*s8; wz = pz + normals[i*3+2]*s8; write = true;
      } else if (mode === 9) { // Swirl — same call as applyBrush's mode 9; the math lives in
        // swirlStep so the interactive and scoped paths cannot drift apart.
        const ax = depositNormal(hitNormals, planes, bestC, normals, i);
        const o = swirlStep(px, py, pz, cx, cy, cz, ax[0], ax[1], ax[2],
          strength * SWIRL_TURN * falloff * swirlChir[bestC],
          1 + (centrifugal || 0) * strength * falloff);
        wx = o[0]; wy = o[1]; wz = o[2]; write = true;
      } else if (mode === 10) { // Recall — blend toward a per-vertex TARGET this vertex once held.
        // ⚠ CONVERGING, NOT DEPOSITING — the same family as Smooth and Flatten. `strength*falloff`
        // is the FRACTION of the way to the target that one dab covers, so repeated passes
        // approach the target and cannot overshoot it. No buildupTaper and no ceiling: the target
        // is a real position this vertex actually held, and arriving at it exactly IS the feature.
        // ⚠ `recallValid[i] !== 1` means this vertex has no past distinct from its present, and it
        // is SKIPPED rather than blended toward itself. A zero-move write still enters `touched`,
        // is journalled, and is credited to the active layer — so "no history here" would leave
        // a record indistinguishable from an edit.
        if (recallValid && recallValid[i] === 1) {
          const f = Math.min(1, Math.max(0, strength * falloff));
          wx = px + (recallTarget[i*3]     - px) * f;
          wy = py + (recallTarget[i*3 + 1] - py) * f;
          wz = pz + (recallTarget[i*3 + 2] - pz) * f;
          write = true;
        }
      }
      // STRETCH CLAMP, applied to the finished displacement so it governs every mode
      // uniformly rather than being threaded through eight separate formulas. Off (0/undefined)
      // it is one comparison per written vertex and changes nothing.
      if (write && stretchLimit > 0) {
        const dx = wx - px, dy = wy - py, dz = wz - pz;
        const dd = dx*dx + dy*dy + dz*dz;
        if (dd > 0) {
          let ts = 1;
          for (let k = vnOffset[i], end = vnOffset[i+1]; k < end; k++) {
            const nb = vnList[k], ns = snapSlot.get(nb) * 3;
            const t1 = stretchT(px, py, pz, dx, dy, dz, snapVals[ns], snapVals[ns+1], snapVals[ns+2], dd, stretchLimit);
            if (t1 < ts) ts = t1;
            if (ts <= 0) break;
          }
          if (ts < 1) { wx = px + dx * ts; wy = py + dy * ts; wz = pz + dz * ts; }
        }
      }
      // OVERLAP GUARD. Sits after the stretch clamp deliberately: both are one-sided limits on
      // the finished displacement, so they compose without either needing to know about the
      // other, and neither has to be threaded through eight separate mode formulas.
      //
      // A vertex's OWN neighboring surface must never block it — otherwise a Smooth stroke on a
      // flat plane clamps itself to a standstill. That exclusion is topological, by the two-ring
      // stamp below, and it must stay topological: it also covers the quad DIAGONAL corner, which
      // shares a face but is NOT in the edge-based one-ring buildVertexNeighbors returns.
      //
      // ⚠ DEFERRED, NOT APPLIED HERE. The factor computed below governs one vertex, and applying
      // it on the spot is the whole defect: it stopped one vertex at 20% of its travel beside a
      // neighbor at 100%, and that cliff is a crag. Everything below only MEASURES; the blend
      // and the write happen after the loop.
      if (guarding && write && Number.isFinite(wx + wy + wz)) {
        const dx = wx - px, dy = wy - py, dz = wz - pz;
        const dd = dx*dx + dy*dy + dz*dz;
        let ts = 1;
        if (dd > 0) {
          // Query the SEGMENT, centered on its midpoint — the smallest sphere that contains the
          // whole path, so separationT's first-root solve can actually see a wall the vertex
          // passes through. This was capped at the landing point before, which made that solve
          // decorative: a blocker beyond the cap was never returned, and one 0.5 drag put five
          // vertices straight through with the guard on. The midpoint form is also CHEAPER than
          // the capped landing-point query it replaces (|d|/2 + sep against sep + |d|), so the
          // O(nv^2) hang that motivated the cap does not come back with it.
          const half = Math.sqrt(dd) * 0.5;
          const mx = px + dx * 0.5, my = py + dy * 0.5, mz = pz + dz * 0.5;
          // Stamp this vertex's two-ring. Bumping the mark invalidates the previous vertex's
          // stamps without touching the array.
          ring2Mark++;
          ring2Stamp[i] = ring2Mark;
          // ⚠ THE FLOOR IS LOCAL, NOT GLOBAL. `selfCollide` arrives as a fraction of the mesh's
          // GLOBAL mean edge, and a quadball's spacing is not uniform: measured on the shipped
          // starting form, the smallest local mean edge is 0.00603 against a global mean of
          // 0.01496 — 40% — so a floor set from the global mean spans 3.2 local rings near the
          // cube corners. That reaches past the two-ring exclusion into the vertex's OWN
          // neighboring surface, which it then treats as a collision and clamps. The visible
          // result is the guard misbehaving on an untouched form, worst where the quads are
          // smallest. Scaling by each vertex's own ring makes the test mean the same thing
          // everywhere on the mesh.
          let localSum = 0, localCnt = 0;
          // ⚠ THE EXCLUSION IS GEODESIC, AND ITS DEPTH IS WHY THE GUARD BEHAVED SO DIFFERENTLY ON A
          // DETAILED FORM THAN ON A SMOOTH ONE. A self-collision is surface that is FAR along the
          // mesh but CLOSE in space; anything a short walk away is your own neighborhood however
          // near it gets. Excluding only the two-ring is enough on a smooth surface, where a vertex
          // three edges away is also three edges away in space — but on a creased or textured one
          // the surface folds back, so your own geometry three and four rings away sits well inside
          // the floor and reads as an intruder. Measured on a textured form the guard bound on 63%
          // of writes at two rings, and prevented nothing for it: 943 crossings against 835 with the
          // guard off entirely. Walking out to RING_EXCLUDE rings is what tells the two cases apart.
          ring2Stamp[i] = ring2Mark;
          let frontier = [i];
          for (let depth = 0; depth < RING_EXCLUDE; depth++) {
            const next = [];
            for (let fi = 0; fi < frontier.length; fi++) {
              const v = frontier[fi];
              for (let m = vnOffset[v], e2 = vnOffset[v+1]; m < e2; m++) {
                const nb = vnList[m];
                if (ring2Stamp[nb] === ring2Mark) continue;
                ring2Stamp[nb] = ring2Mark;
                next.push(nb);
                // The local edge mean comes from the FIRST ring only — it is a measure of this
                // vertex's own spacing, and averaging a wider walk would blur exactly the local
                // scale the floor is meant to track.
                if (depth === 0) {
                  const nbs = snapSlot.get(nb);
                  if (nbs !== undefined) {
                    const q = nbs * 3;
                    localSum += Math.hypot(px - snapVals[q], py - snapVals[q+1], pz - snapVals[q+2]);
                    localCnt++;
                  }
                }
              }
            }
            frontier = next;
          }
          // No resolvable ring (a lone vertex, or neighbors outside the scoped snapshot) leaves
          // the caller's global figure rather than inventing one.
          const sepHere = (localCnt && meanEdge > 0) ? (selfCollide / meanEdge) * (localSum / localCnt) : selfCollide;
          gridQueryRadius(grid, mx, my, mz, half + sepHere, nearOut);
          for (let k = 0; k < nearOut.length; k++) {
            const j = nearOut[k];
            if (j === i) continue;
            // ⚠ DO NOT REINSTATE AN OPPOSED-NORMAL PRE-TEST (`nd > -0.25` and skip). It looks like
            // a free rejection of the vertex's own sheet, and it makes the guard inert: over a
            // finished sculpt only 19% of genuinely violating pairs had opposing normals and 64%
            // AGREED, because self-intersection here is sheets SHEARING past one another, not
            // meeting head-on. It rejected 98.4% of true violations — 216 clamps in 99,700
            // opportunities, and guard-on geometry bit-identical to guard-off on a Build stroke.
            if (ring2Stamp[j] === ring2Mark) continue;
            const t1 = separationT(px, py, pz, dx, dy, dz, positions[j*3], positions[j*3+1], positions[j*3+2], dd, sepHere);
            if (t1 < ts) ts = t1;
            if (ts <= 0) break;
          }
          // ⚠ DO NOT REINTRODUCE A TANGENTIAL SLIDE HERE. Dropping the approaching component and
          // keeping the rest looks like the cure for a zero-clamp freeze; it is shear, and shear
          // is how sculpted sheets fold through one another. Measured on six overlapping deposit
          // strokes at tier 5: 21 self-intersecting triangle pairs with it, 0 without — and on a
          // single clean stroke 14 with it against 0 either way, i.e. it created folds in
          // geometry that had none.
        }
        clampOffered++; if (ts < 0.999) clampBound++;
        gWrote[ci] = 1; gTs[ci] = ts; gWx[ci] = wx; gWy[ci] = wy; gWz[ci] = wz;
        gSl[ci] = sl; gSlotCi[sl / 3] = ci;
      } else if (write && Number.isFinite(wx + wy + wz)) {
        positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz;
        touched.push(i);
      }
    }

    // ---- THE BLEND, then the guarded write ----
    // ⚠ THIS IS WHAT MAKES THE GUARD SHIPPABLE, and it is not a polish step. separationT is a
    // step function of a vertex's own surroundings: a vertex with a blocker inside the floor
    // returns ~0 while the neighbor one edge away, with no blocker, returns 1. Applying those
    // raw leaves a cliff between adjacent vertices, and a cliff in the displacement IS a crag —
    // one that made the guard WORSE than no guard on the measure a user actually sees. Six
    // overlapping strokes at tier 5, counting edges whose dihedral exceeds 90 degrees: 233 with
    // the raw clamp, 117 with the guard off, 0 with the blend. Removing this puts that back.
    //
    // Two limits, both applied as a MINIMUM against the factor a vertex already has, so the blend
    // can only ever slow a vertex down. That one-sidedness is load-bearing: every vertex still
    // stops at or before the separation bound it solved for itself, so section B's guarantees
    // (nothing passes the wall, it stops AT the floor) survive the blend untouched.
    //   RING_SLOPE  bounds the first difference — no vertex may travel more than this much
    //               further than its slowest neighbor. Propagates a hard stop outward as a ramp.
    //   the mean    rounds that ramp's corners. The slope limit alone leaves a kink where the
    //               ramp meets the free surface, and a kink repeated over a stroke's dabs is a
    //               crease; a slope limit is a bound on the first derivative only.
    // Jacobi (double-buffered), not in-place, so the result does not depend on candidate order.
    if (guarding) {
      // Ring, in candidate-index space, of every candidate that actually wrote. A neighbor that
      // is not itself a moving candidate is left OUT rather than counted as free — treating a
      // stationary rim as permission to travel is what the slope limit exists to prevent.
      let w = 0;
      for (let ci = 0; ci < nCand; ci++) {
        gNbOff[ci] = w;
        if (!gWrote[ci]) continue;
        const i = candSorted[ci];
        for (let k = vnOffset[i], end = vnOffset[i+1]; k < end; k++) {
          const sn = snapSlot.get(vnList[k]);
          if (sn === undefined || sn >= nCand) continue;
          const cj = gSlotCi[sn];
          if (cj < 0 || !gWrote[cj]) continue;
          if (w >= gNb.length) { const g = new Int32Array(gNb.length * 2); g.set(gNb); gNb = g; }
          gNb[w++] = cj;
        }
      }
      gNbOff[nCand] = w;

      const RING_SLOPE = 0.10, BLEND_PASSES = 12;
      for (let p = 0; p < BLEND_PASSES; p++) {
        for (let ci = 0; ci < nCand; ci++) {
          if (!gWrote[ci]) continue;
          const own = gTs[ci];
          let cur = own, mn = 1, sum = 0;
          const k0 = gNbOff[ci], k1 = gNbOff[ci+1];
          for (let k = k0; k < k1; k++) {
            const v = gTs[gNb[k]];
            if (v < mn) mn = v;
            sum += v;
          }
          if (k1 > k0) {
            const lip = mn + RING_SLOPE;
            if (lip < cur) cur = lip;
            const lap = 0.5 * (own + sum / (k1 - k0));
            if (lap < cur) cur = lap;
          }
          gTs2[ci] = cur;
        }
        const sw = gTs; gTs = gTs2; gTs2 = sw;
      }

      for (let ci = 0; ci < nCand; ci++) {
        if (!gWrote[ci]) continue;
        const sl = gSl[ci], ts = gTs[ci], i = candSorted[ci];
        let wx = gWx[ci], wy = gWy[ci], wz = gWz[ci];
        // ts === 1 writes the landing point UNTOUCHED rather than reconstructing it from p + d*1,
        // which is what keeps a stroke with nothing to collide with bit-identical to the same
        // stroke with the guard off (C1). The blend leaves an all-clear neighborhood at exactly 1.
        if (ts !== 1) {
          const px = snapVals[sl], py = snapVals[sl+1], pz = snapVals[sl+2];
          wx = px + (wx - px) * ts; wy = py + (wy - py) * ts; wz = pz + (wz - pz) * ts;
        }
        if (!Number.isFinite(wx + wy + wz)) continue;   // same skip-don't-heal rule as the plain path
        positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz;
        touched.push(i);                                 // candSorted is ascending, so touched stays ascending
      }
    }
    return { touched };
  }

  return { applyBrush, applyBrushScoped };
}

export function createMaskPass() {
  // ⚠ mask[] is read back by EVERY subsequent brush call (applyBrush
  // scales its falloff by `1 - mask[i]`), so a single NaN written here doesn't just corrupt
  // one paint stroke -- it silently poisons every future stroke that ever touches that
  // vertex again, through a completely different code path. That makes this array a higher-
  // leverage guard target than its "just a scalar" size suggests. Same shape throughout:
  // paint gets applyBrush's cheap per-call entry guard (radius/strength); every
  // write gets a single Number.isFinite check before committing, falling back to the
  // vertex's PRIOR mask value (skip, don't heal -- same doctrine as applyBrush).
  function paint(mask, positions, nv, { center, radius, strength, erase, alphaTex, frame }) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return;
    const [cx, cy, cz] = center;
    for (let i = 0; i < nv; i++) {
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d >= radius) continue;
      const t = 1 - d/radius, falloff = t*t*(3-2*t)
        // The alpha shapes a mask stroke the same way it shapes a sculpt one.
        // `frame` is a single copy's own [uAxis, vAxis]; alphaMultiplier takes an ARRAY of
        // frames indexed by copy, so wrap it — these passes take one center per call and
        // handle symmetry by being called once per copy.
        * alphaMultiplier(alphaTex, frame ? [frame] : null, 0, positions[i*3], positions[i*3+1], positions[i*3+2], center[0], center[1], center[2], radius);
      const delta = erase ? -strength*falloff : strength*falloff;
      const v = Math.min(1, Math.max(0, mask[i] + delta));
      if (Number.isFinite(v)) mask[i] = v;
    }
  }
  // The scoped twin of paint, the same treatment the sculpt path gets.
  // Requirement is EXACT Float32Array equality
  // against paint over a full stroke, not closeness; see _verify/scoped_paint_parity.mjs.
  //
  // This one is genuinely simpler than applyBrushScoped, and it is worth saying why rather than
  // leaving the absence of machinery looking like an oversight: a mask paint reads ONLY the
  // vertex's own position and its own prior mask value, and writes only its own mask value. No
  // neighbor is read and nothing accumulates across vertices, so there is no snapshot to take
  // and no visiting-order requirement — the arithmetic for a given vertex is identical whenever
  // it is visited.
  //
  // The grid query is a guaranteed SUPERSET of the vertices within `radius` (see
  // gridQueryRadius), and every candidate outside the radius takes the same `continue` the full
  // loop takes. So the set of vertices written, and the value written to each, are identical.
  //
  // The CANDIDATE list is deliberately NOT sorted; only `touched` is, at the end. Measured: the
  // grid returns roughly twice as many candidates as end up inside the radius, and a comparator
  // sort over the larger list cost more than the arithmetic it feeds. Sorting `touched` is not
  // optional though — uploadMeshBufferRuns requires an ascending, duplicate-free list, the same
  // contract applyBrushScoped's own return honors.
  const maskQueryScratch = []; // reused across calls — a stroke is hundreds of samples
  // ⚠⚠⚠ FRONT FACES ONLY. A dab is selected by DISTANCE alone, and distance goes straight through a
  // wall: on a skull, whose vault is a few millimetres of bone, a brush painted on the forehead
  // reached the ENDOCRANIAL surface behind it and masked the inside of the braincase. The lift then
  // carried the whole interior out as part of the plate. Reported as "mask is leaking into the
  // brain of this skull. FRONT FACE ONLY ALWAYS."
  // ⚠ THE TEST IS AGAINST THE SURFACE, NOT THE CAMERA. The normal at the contact against the normal
  // at the vertex — the two disagree by 180° across a wall and by much less across any crease or
  // fold, so a deep concavity still paints and the far side of a shell does not. Camera-facing
  // would answer the same question for one view and a different one after an orbit; this is a
  // property of the form.
  // ⚠ AND IT IS INERT WHERE THERE IS NO SECOND SURFACE. Two points can only fail this while lying
  // within one brush radius of each other, so on a solid form nothing within reach ever disagrees
  // and not a vertex changes hands.
  function paintScoped(mask, positions, nv, { center, radius, strength, erase, alphaTex, frame, normals, normal }, grid) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return [];
    const [cx, cy, cz] = center;
    const facing = (normals && normal) ? normal : null;
    const cand = gridQueryRadius(grid, cx, cy, cz, radius, maskQueryScratch);
    const touched = [];
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci];
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d >= radius) continue;
      if (facing && (normals[i*3]*facing[0] + normals[i*3+1]*facing[1] + normals[i*3+2]*facing[2]) <= 0) continue;
      const t = 1 - d/radius, falloff = t*t*(3-2*t)
        // The alpha shapes a mask stroke the same way it shapes a sculpt one.
        // `frame` is a single copy's own [uAxis, vAxis]; alphaMultiplier takes an ARRAY of
        // frames indexed by copy, so wrap it — these passes take one center per call and
        // handle symmetry by being called once per copy.
        * alphaMultiplier(alphaTex, frame ? [frame] : null, 0, positions[i*3], positions[i*3+1], positions[i*3+2], center[0], center[1], center[2], radius);
      const delta = erase ? -strength*falloff : strength*falloff;
      const v = Math.min(1, Math.max(0, mask[i] + delta));
      // `touched` is the vertices actually WRITTEN: a skipped write leaves the GPU buffer already
      // correct, and uploading it would be work for nothing.
      if (Number.isFinite(v)) { mask[i] = v; touched.push(i); }
    }
    touched.sort((a, b) => a - b);
    return touched;
  }
  // ⚠ PASSES, BECAUSE ONE RING IS SUB-PIXEL ON A DENSE MESH. This ran exactly one one-ring
  // average, whatever the mesh — so at the base cage it visibly softened a mask edge and at
  // subdivision 4, where a real sculpt lives, it moved the boundary by less than a pixel and the
  // button read as doing nothing. That is the same density bug Grow had, and the two belong to
  // ONE piece of work: the mask boundary should be
  // adjustable in small amounts, in both directions, at any resolution.
  //
  // ⚠ ITERATING IS LEGITIMATE HERE AND WAS NOT FOR GROW, which is worth stating because the two
  // sit side by side. Repeated MAX over a ring dilates by the shape of that ring and converges to
  // a grid-aligned square. Repeated AVERAGING converges to a Gaussian — isotropic — so passes are
  // the right instrument for a blur and were the wrong one for a dilation.
  function blur(mask, vnOffset, vnList, nv, passes = 1) {
    for (let p = 0; p < Math.max(1, passes); p++) {
      const snap = mask.slice();
      for (let i = 0; i < nv; i++) {
        const off = vnOffset[i], end = vnOffset[i+1];
        if (end > off) {
          let avg = 0;
          for (let k = off; k < end; k++) avg += snap[vnList[k]];
          avg /= (end - off);
          const v = snap[i] * 0.5 + avg * 0.5;
          if (Number.isFinite(v)) mask[i] = v;
        }
      }
    }
  }
  function sharpen(mask, nv) { for (let i = 0; i < nv; i++) { const v = Math.min(1, Math.max(0, 0.5 + (mask[i]-0.5)*1.6)); if (Number.isFinite(v)) mask[i] = v; } }
  function invert(mask, nv) { for (let i = 0; i < nv; i++) { const v = 1 - mask[i]; if (Number.isFinite(v)) mask[i] = v; } }
  function clear(mask, nv) { mask.fill(0, 0, nv); } // always finite (a literal 0) -- no guard needed, nothing to fire on
  return {
    paint: (maskBuf, positionsArr, nv, params) => paint(maskBuf, positionsArr, nv, params),
    paintScoped: (maskBuf, positionsArr, nv, params, grid) => paintScoped(maskBuf, positionsArr, nv, params, grid),
    // vnOffset/vnList kept in the call signature (unused by sharpen/invert/clear) purely to
    // keep every caller in index.html uniform with v00000-001's shape — no bind-group
    // constraint forces this on CPU, but changing 4 call sites for no behavioral gain isn't
    // worth the diff.
    blur: (maskBuf, vnOffset, vnList, nv, passes) => blur(maskBuf, vnOffset, vnList, nv, passes),
    sharpen: (maskBuf, vnOffset, vnList, nv) => sharpen(maskBuf, nv),
    invert: (maskBuf, vnOffset, vnList, nv) => invert(maskBuf, nv),
    clear: (maskBuf, vnOffset, vnList, nv) => clear(maskBuf, nv),
  };
}

export function createGantryPass() {
  // No internal snapshot needed: Gantry only ever reads a vertex's OWN position (never a
  // neighbor's), so in-place rotation is safe. index.html resets `positions` to the
  // pre-drag snapshot itself before every call (non-compounding live preview), same as
  // v00000-001's caller-side contract.
  // Cheap per-CALL entry guard on the 7 scalars that scale every
  // touched vertex (axisOrigin/axisDir/angle) -- same rationale as applyBrush's radius/
  // strength guard: a non-finite value in any of them makes EVERY vertex's
  // rotation non-finite, so there's nothing worth computing per-vertex. `positions` is
  // reset to a pre-drag snapshot by the caller before every call (index.html's
  // updateStroke, gantryRotate branch), so the per-vertex guard's fallback -- simply not
  // writing -- already leaves that vertex at a valid, current value; no explicit "prior"
  // needs to be captured the way subdivideCatmullClark's newPositions loop does.
  function rotate(positions, mask, nv, { axisOrigin, axisDir, angle }) {
    if (!Number.isFinite(angle) || !Number.isFinite(axisDir[0]+axisDir[1]+axisDir[2]) || !Number.isFinite(axisOrigin[0]+axisOrigin[1]+axisOrigin[2])) return;
    const len = Math.hypot(axisDir[0], axisDir[1], axisDir[2]) || 1;
    const kx = axisDir[0]/len, ky = axisDir[1]/len, kz = axisDir[2]/len;
    const [ox, oy, oz] = axisOrigin;
    for (let i = 0; i < nv; i++) {
      const w = 1 - mask[i];
      if (w <= 0.0001) continue; // masked (Passivate-protected): stays exactly put
      const ang = angle * w;
      const c = Math.cos(ang), s = Math.sin(ang);
      const vx = positions[i*3]-ox, vy = positions[i*3+1]-oy, vz = positions[i*3+2]-oz;
      const dot = kx*vx + ky*vy + kz*vz;
      const crx = ky*vz - kz*vy, cry = kz*vx - kx*vz, crz = kx*vy - ky*vx;
      const rx = vx*c + crx*s + kx*dot*(1-c);
      const ry = vy*c + cry*s + ky*dot*(1-c);
      const rz = vz*c + crz*s + kz*dot*(1-c);
      const wx = ox + rx, wy = oy + ry, wz = oz + rz;
      if (Number.isFinite(wx + wy + wz)) { positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz; }
    }
  }
  // Per critique §3 ("gizmo translate/rotate/scale, not rotate only"): the same
  // two-drag Gantry gesture (draw axis, then a second drag) now also drives Translate
  // (slide the unmasked region along the axis DIRECTION, matching ZBrush Transpose's own
  // "move along the line" convention) and Scale (uniform scale from the axis ORIGIN).
  // Same caller-side contract as rotate: no internal snapshot, index.html resets
  // `positions` to the pre-drag snapshot before every call.
  function translate(positions, mask, nv, { axisOrigin, axisDir, distance }) {
    if (!Number.isFinite(distance) || !Number.isFinite(axisDir[0]+axisDir[1]+axisDir[2])) return; // entry guard, same shape as rotate's above
    const len = Math.hypot(axisDir[0], axisDir[1], axisDir[2]) || 1;
    const kx = axisDir[0]/len, ky = axisDir[1]/len, kz = axisDir[2]/len;
    for (let i = 0; i < nv; i++) {
      const w = 1 - mask[i];
      if (w <= 0.0001) continue;
      const d = distance * w;
      const wx = positions[i*3] + kx * d, wy = positions[i*3+1] + ky * d, wz = positions[i*3+2] + kz * d;
      if (Number.isFinite(wx + wy + wz)) { positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz; }
    }
  }
  function scaleOp(positions, mask, nv, { axisOrigin, scale }) {
    if (!Number.isFinite(scale) || !Number.isFinite(axisOrigin[0]+axisOrigin[1]+axisOrigin[2])) return; // entry guard, same shape as rotate's above
    const [ox, oy, oz] = axisOrigin;
    for (let i = 0; i < nv; i++) {
      const w = 1 - mask[i];
      if (w <= 0.0001) continue;
      const s = 1 + (scale - 1) * w; // masked verts get scale 1 (no-op), unmasked get the full factor
      const wx = ox + (positions[i*3]-ox)   * s;
      const wy = oy + (positions[i*3+1]-oy) * s;
      const wz = oz + (positions[i*3+2]-oz) * s;
      if (Number.isFinite(wx + wy + wz)) { positions[i*3] = wx; positions[i*3+1] = wy; positions[i*3+2] = wz; }
    }
  }
  return { rotate, translate, scale: scaleOp };
}

export function createStainPass() {
  // Color is a vec3 field, so its guarded store follows applyBrush's
  // own shape exactly -- compute the candidate triple into locals, one summed
  // Number.isFinite before committing all three components together (never two-of-three).
  // Both entry points get the same cheap per-call radius/strength guard as maskPass.paint.
  function paint(color, positions, vnOffset, vnList, nv, { center, radius, strength, color: swatch, alphaTex, frame }) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return;
    const [cx, cy, cz] = center;
    for (let i = 0; i < nv; i++) {
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d >= radius) continue;
      const t = 1 - d/radius;
      // Alpha applies to Paint's DEPOSIT, and deliberately NOT to its Smooth
      // variant a few lines below. An alpha shapes what you lay down; smoothing relaxes
      // what is already there, and stamping a relaxation would just make it patchy.
      const aMul = alphaMultiplier(alphaTex, frame ? [frame] : null, 0, positions[i*3], positions[i*3+1], positions[i*3+2], center[0], center[1], center[2], radius);
      const falloff = Math.min(1, Math.max(0, t*t*(3-2*t) * strength * aMul));
      const r = color[i*3]   + (swatch[0]-color[i*3])   * falloff;
      const g = color[i*3+1] + (swatch[1]-color[i*3+1]) * falloff;
      const b = color[i*3+2] + (swatch[2]-color[i*3+2]) * falloff;
      if (Number.isFinite(r + g + b)) { color[i*3] = r; color[i*3+1] = g; color[i*3+2] = b; }
    }
  }
  function smooth(color, positions, vnOffset, vnList, nv, { center, radius, strength }) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return;
    const snap = color.slice();
    const [cx, cy, cz] = center;
    for (let i = 0; i < nv; i++) {
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d >= radius) continue;
      const t = 1 - d/radius;
      const falloff = Math.min(1, Math.max(0, t*t*(3-2*t) * strength));
      const off = vnOffset[i], end = vnOffset[i+1];
      if (end > off) {
        let ax = 0, ay = 0, az = 0;
        for (let k = off; k < end; k++) { const nb = vnList[k]; ax += snap[nb*3]; ay += snap[nb*3+1]; az += snap[nb*3+2]; }
        const cnt = end - off; ax /= cnt; ay /= cnt; az /= cnt;
        const r = snap[i*3]   + (ax-snap[i*3])   * falloff;
        const g = snap[i*3+1] + (ay-snap[i*3+1]) * falloff;
        const b = snap[i*3+2] + (az-snap[i*3+2]) * falloff;
        if (Number.isFinite(r + g + b)) { color[i*3] = r; color[i*3+1] = g; color[i*3+2] = b; }
      }
    }
  }
  // The scoped twins. Same requirement as everywhere in this family:
  // EXACT Float32Array equality against the full-loop versions, proved over a real stroke in
  // _verify/scoped_paint_parity.mjs, not argued from the code's shape.
  //
  // paintScoped is per-vertex independent, exactly like maskPass.paintScoped — see that
  // function's note for why no snapshot is needed there and why the candidate list is unsorted.
  const stainQueryScratch = [];
  // Same front-face rule as the mask pass, for the same reason: colour painted on one side of a
  // thin wall was landing on the other.
  function paintScoped(color, positions, vnOffset, vnList, nv, { center, radius, strength, color: swatch, alphaTex, frame, normals, normal }, grid) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return [];
    const [cx, cy, cz] = center;
    const cand = gridQueryRadius(grid, cx, cy, cz, radius, stainQueryScratch);
    const touched = [];
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci];
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d >= radius) continue;
      if (normals && normal && (normals[i*3]*normal[0] + normals[i*3+1]*normal[1] + normals[i*3+2]*normal[2]) <= 0) continue;
      const t = 1 - d/radius;
      // Alpha applies to Paint's DEPOSIT, and deliberately NOT to its Smooth
      // variant a few lines below. An alpha shapes what you lay down; smoothing relaxes
      // what is already there, and stamping a relaxation would just make it patchy.
      const aMul = alphaMultiplier(alphaTex, frame ? [frame] : null, 0, positions[i*3], positions[i*3+1], positions[i*3+2], center[0], center[1], center[2], radius);
      const falloff = Math.min(1, Math.max(0, t*t*(3-2*t) * strength * aMul));
      const r = color[i*3]   + (swatch[0]-color[i*3])   * falloff;
      const g = color[i*3+1] + (swatch[1]-color[i*3+1]) * falloff;
      const b = color[i*3+2] + (swatch[2]-color[i*3+2]) * falloff;
      if (Number.isFinite(r + g + b)) { color[i*3] = r; color[i*3+1] = g; color[i*3+2] = b; touched.push(i); }
    }
    touched.sort((a, b) => a - b);
    return touched;
  }
  // smooth DOES read neighbors, so it needs a snapshot, for the same reason applyBrushScoped's
  // Anneal mode needs one: the full-array `color.slice()` the unscoped version takes exists to
  // stop an already-smoothed neighbor's NEW color leaking into a not-yet-processed vertex's
  // average — a genuine order-dependent data race that the snapshot exists to prevent.
  //
  // THERE IS NO SNAPSHOT HERE AT ALL, and that is the point. What the full loop's snapshot
  // actually guarantees is that every read sees a PRE-CALL value. The scoped version gets the
  // same guarantee for free by separating reading from writing: it computes every new color into
  // a small staging buffer first, and only then commits them. Nothing in `color` changes while
  // anything is being read from it, so every read is a pre-call read by construction — no
  // membership test, no copy of the neighborhood, nothing to get subtly wrong.
  //
  // Two earlier versions are worth recording because each was wrong in a different way and the
  // measurements are what settled it:
  //   * Snapshotting candidates UNION their exact one-ring (mirroring applyBrushScoped's shape)
  //     is CORRECT but cost ~8,000 Map entries per sample against a 55,298-vertex stratum, which
  //     made the scoped kernel SLOWER than the O(nv) loop it was replacing.
  //   * Snapshotting only the write set is correct too — a vertex outside the write set is never
  //     modified, so reading it live is already a pre-call read — and thirteen times smaller,
  //     but still paid a Map lookup per neighbor and only reached 1.9x.
  // Staging the output reaches 4.7x and needs no argument about which vertices are covered.
  // (_verify/scoped_paint_parity.mjs's discrimination control is therefore the same loop reading
  // and writing `color` in place, which is the real bug and does diverge.)
  let outVals = new Float32Array(3 * 4096);
  const smoothQueryScratch = [];
  function smoothScoped(color, positions, vnOffset, vnList, nv, { center, radius, strength }, grid) {
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(strength)) return [];
    const [cx, cy, cz] = center;
    const cand = gridQueryRadius(grid, cx, cy, cz, radius, smoothQueryScratch);
    if (cand.length === 0) return [];

    // PASS 1 — the write set. `touched` derives from it and must come out ascending.
    const inR = [];
    for (let ci = 0; ci < cand.length; ci++) {
      const i = cand[ci];
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      if (d < radius) inR.push(i);
    }
    if (inR.length === 0) return [];
    inR.sort((a, b) => a - b);
    if (inR.length * 3 > outVals.length) outVals = new Float32Array(Math.max(inR.length * 3, outVals.length * 2));

    // PASS 2 — compute into the staging buffer. `color` is untouched throughout, so every read
    // is a pre-call read. Same accumulation order over the same values as the unscoped loop, so
    // the float sums are bit-identical: IEEE addition is not associative and a re-ordered ring
    // would be a different number, which is why the ring is walked, not rebuilt.
    for (let ci = 0; ci < inR.length; ci++) {
      const i = inR[ci];
      const off = vnOffset[i], end = vnOffset[i+1];
      if (end <= off) { outVals[ci*3] = NaN; continue; } // marks "the full loop writes nothing here either"
      const d = Math.hypot(positions[i*3]-cx, positions[i*3+1]-cy, positions[i*3+2]-cz);
      const t = 1 - d/radius;
      const falloff = Math.min(1, Math.max(0, t*t*(3-2*t) * strength));
      let ax = 0, ay = 0, az = 0;
      for (let k = off; k < end; k++) { const nb = vnList[k]; ax += color[nb*3]; ay += color[nb*3+1]; az += color[nb*3+2]; }
      const cnt = end - off; ax /= cnt; ay /= cnt; az /= cnt;
      outVals[ci*3]   = color[i*3]   + (ax-color[i*3])   * falloff;
      outVals[ci*3+1] = color[i*3+1] + (ay-color[i*3+1]) * falloff;
      outVals[ci*3+2] = color[i*3+2] + (az-color[i*3+2]) * falloff;
    }

    // PASS 3 — commit, with the same per-vertex finite guard the full loop applies. A NaN in
    // slot 0 from an isolated vertex (no neighbors) fails that guard, which is exactly the
    // "write nothing" the full loop's `if (end > off)` produces for the same vertex.
    const touched = [];
    for (let ci = 0; ci < inR.length; ci++) {
      const r = outVals[ci*3], g = outVals[ci*3+1], b = outVals[ci*3+2];
      if (!Number.isFinite(r + g + b)) continue;
      const i = inR[ci];
      color[i*3] = r; color[i*3+1] = g; color[i*3+2] = b;
      touched.push(i);
    }
    return touched;
  }
  return {
    paint: (colorBuf, positionsArr, vnOffset, vnList, nv, params) => paint(colorBuf, positionsArr, vnOffset, vnList, nv, { ...params, color: params.color }),
    smooth: (colorBuf, positionsArr, vnOffset, vnList, nv, params) => smooth(colorBuf, positionsArr, vnOffset, vnList, nv, params),
    paintScoped: (colorBuf, positionsArr, vnOffset, vnList, nv, params, grid) => paintScoped(colorBuf, positionsArr, vnOffset, vnList, nv, { ...params, color: params.color }, grid),
    smoothScoped: (colorBuf, positionsArr, vnOffset, vnList, nv, params, grid) => smoothScoped(colorBuf, positionsArr, vnOffset, vnList, nv, params, grid),
  };
}

// ================================================================
// TRIANGLES TO QUADS — the deterministic bridge, for when the solver cannot
// ================================================================
// ⚠ THIS IS NOT A REPLACEMENT FOR quadRemesh AND MUST NOT BECOME ONE. QuadriFlow routes quads that
// follow a form's own flow, which is what you want for anything you intend to sculpt; this does not
// route anything. It exists for the one case QuadriFlow structurally cannot take: a surface of very
// high genus. A 120-cell Voronoi cage bakes to genus ~200 — two hundred handles — and the solver
// failed at its indexmap phase on every target tried (12,376 / 6,188 / 3,094 quads: solver-failed,
// timeout, solver-failed) after about fifty seconds. No target works, because the difficulty is the
// topology rather than the size.
//
// The construction is the one Catmull-Clark already applies to any non-quad face: split each
// triangle at its centroid, joining that centroid to the three edge midpoints, giving three quads.
// It always succeeds, it is deterministic, and it needs no solver. The cost is exactly 3x the face
// count, and the result subdivides cleanly afterwards precisely because it is the subdivision rule's
// own output.
//
// ⚠ EDGE MIDPOINTS MUST BE SHARED, or the result is three-quads-per-triangle floating apart with a
// crack along every original edge — a mesh that looks right until it is smoothed or exported. The
// edge map is the whole reason this is forty lines rather than ten.
export function trianglesToQuads(positions, triIdx) {
  const nv = positions.length / 3, nt = triIdx.length / 3;
  const out = [];                                  // grown, then copied once
  for (let i = 0; i < positions.length; i++) out.push(positions[i]);
  const midOf = new Map();                         // "a:b" (a<b) -> vertex index
  const edgeMid = (a, b) => {
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let m = midOf.get(k);
    if (m !== undefined) return m;
    m = out.length / 3;
    out.push((positions[a*3] + positions[b*3]) / 2,
             (positions[a*3+1] + positions[b*3+1]) / 2,
             (positions[a*3+2] + positions[b*3+2]) / 2);
    midOf.set(k, m);
    return m;
  };
  const quads = new Uint32Array(nt * 12);          // 3 quads x 4 corners per triangle
  let q = 0;
  for (let f = 0; f < nt; f++) {
    const a = triIdx[f*3], b = triIdx[f*3+1], c = triIdx[f*3+2];
    const ab = edgeMid(a, b), bc = edgeMid(b, c), ca = edgeMid(c, a);
    const ctr = out.length / 3;
    out.push((positions[a*3] + positions[b*3] + positions[c*3]) / 3,
             (positions[a*3+1] + positions[b*3+1] + positions[c*3+1]) / 3,
             (positions[a*3+2] + positions[b*3+2] + positions[c*3+2]) / 3);
    // Wound consistently with the source triangle, so face normals do not alternate.
    quads[q++] = a;  quads[q++] = ab; quads[q++] = ctr; quads[q++] = ca;
    quads[q++] = b;  quads[q++] = bc; quads[q++] = ctr; quads[q++] = ab;
    quads[q++] = c;  quads[q++] = ca; quads[q++] = ctr; quads[q++] = bc;
  }
  return { positions: new Float32Array(out), quads, addedVerts: out.length / 3 - nv };
}
