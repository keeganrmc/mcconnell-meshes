// The shoe's SuperBs out to Unreason and Rhino, plain data in, text or bytes
// out. Every piece is one SuperB leaf (.unreason) or one SubD (.3dm); the
// last rides along as a reference mesh; closed outlines (the feather line,
// a topline, the last's bottom) go as PERIODIC DEGREE-3 NURBS on uniform
// knots with sixty-odd control points — what Rhino's Rebuild makes of a
// polyline — never as dense polylines.
//
// Frame and units at each boundary:
//   in    the app's frame, mm, Y up (X along the last, Z across)
//   out   Unreason and Rhino are Z-up, mm: (x, y, z) → (x, −z, y), MASQ's
//         stand-up, applied once here to every vertex, control point and
//         reference-mesh position. The OBJ stays in the app's frame.
//   decimate (MASQ) takes and returns METRES: scaled at its call, both ways.

import { decimate } from '../lift/masq/decimate.js';
import { cageToSubD, meshToRhino, curveToNurbs, subdAuthoringMissing, read3dmSubDs } from '../lift/masq/export3dm.js';
import { buildSuperBOBJ, UNREASON_MESH_TRIANGLES } from '../lift/masq/tosuperb.js';
import { fitPeriodicCubic, evalPeriodicCubic, periodicCubicRhinoLayout } from './curvefit.mjs';

export const standUp = (v) => [v[0], -v[2], v[1]];

// ── the last as a reference mesh (≤ 25,000 triangles, Unreason's cap) ─────
export function referenceMesh(positions, indices, maxTriangles = UNREASON_MESH_TRIANGLES) {
  const tris = indices.length / 3;
  if (tris <= maxTriangles) return { positions, indices, triangles: tris, decimated: false };
  const m = Float32Array.from(positions, (x) => x * 0.001);
  const d = decimate({ positions: m, indices: Uint32Array.from(indices), targetTriangles: maxTriangles, maxTriangles, maxErrorMM: 0.1 });
  return { positions: Float32Array.from(d.positions, (x) => x * 1000), indices: d.indices, triangles: d.indices.length / 3, decimated: true, stats: d.stats };
}

// ── a closed outline as the curve the exports carry ───────────────────────
// points: [[x,y,z]] in order round the loop (mm, app frame); n control points
export function outlineCurve(points, n = 64, name = 'outline') {
  const fit = fitPeriodicCubic(points, n);
  return { name, controlPoints: fit.controlPoints, degree: 3, periodic: true, rms: fit.rms, length: fit.length };
}
// a loop of piece vertex ids → the curve
export function loopCurve(positions, loop, n = 64, name = 'outline') {
  return outlineCurve(loop.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]), n, name);
}


// ── a perforated piece's holes, as cutters ────────────────────────────────
/* A SuperB is the UNPUNCHED piece: a 3 mm hole is about half a cage edge, and
 * holes sit one or two edges apart, so they cannot be cut into the cage. Each
 * punched hole (perforate.mjs `cuts`: where its axis meets the inner sheet and
 * leaves the outer, the axis n, the radius r, app frame) rides along instead:
 * an exact circle on the outer surface (.unreason) and a capped cylinder
 * through the wall (.3dm), overshooting both sheets so a boolean cuts clean.
 * In Rhino: ToNURBS the SubD, then BooleanDifference with the perforations. */
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vunit = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function frameAbout(n) {
  const t = vunit(vcross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [t, vcross(n, t)];
}
// a hole in the export frame (Z up): its axis from below the inner sheet to past the outer
export function holeCutter(h) {
  const inner = standUp(h.inner), outer = standUp(h.outer), n = vunit(standUp(h.n));
  const over = Math.max(0.6, 0.5 * h.r), depth = vlen(vsub(outer, inner));
  const base = [inner[0] - n[0] * over, inner[1] - n[1] * over, inner[2] - n[2] * over];
  return { center: outer, base, n, r: h.r, height: depth + 2 * over, depth };
}
// the exact circle: degree 2, nine points, the corners weighted √½ (Unreason's
// ctrlPts are [x, y, z, w] with x, y, z NOT multiplied by w)
export function circleCurve(center, n, r) {
  const [t, b] = frameAbout(n), s = Math.SQRT1_2, at = (c, d) => [center[0] + r * (c * t[0] + d * b[0]), center[1] + r * (c * t[1] + d * b[1]), center[2] + r * (c * t[2] + d * b[2])];
  const ring = [[1, 0, 1], [1, 1, s], [0, 1, 1], [-1, 1, s], [-1, 0, 1], [-1, -1, s], [0, -1, 1], [1, -1, s], [1, 0, 1]];
  const ctrlPts = ring.map(([c, d, w]) => [...at(c, d), w]);
  const samples = []; for (let k = 0; k <= 32; k++) { const a = 2 * Math.PI * k / 32; samples.push(at(Math.cos(a), Math.sin(a))); }
  return { degree: 2, knots: [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4], ctrlPts, samples, through: samples.filter((_, k) => k % 4 === 0 && k < 32) };
}

// ── .unreason ─────────────────────────────────────────────────────────────
/* pieces: [{ name, cage:{vertices, faces, creases}, holes? }] (holes: perforate.mjs cuts). opts.last: {positions,
 * indices} (the reference mesh); opts.curves: [{ name, controlPoints }];
 * opts.points: [{ name, p:[x,y,z] }]. Records are Unreason's own leaf
 * snapshots (MASQ's buildUnreasonDocument writes the same SuperB and
 * referenceMesh records; this one holds several pieces and cubic curves). */
// The tread's groove curves as point runs standing up (z up), whatever the list holds: a run breaks at a point that is
// not finite, drops a point on top of the last, and is kept only with two points or more (a polyline OpenNURBS calls
// valid). Typed arrays or plain ones; anything else in the list is skipped.
export function treadRuns(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const flat of list) {
    if (!flat || !(ArrayBuffer.isView(flat) || Array.isArray(flat))) continue;
    let run = [];
    const flush = () => { if (run.length >= 2) out.push(run); run = []; };
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const x = +flat[i], y = +flat[i + 1], z = +flat[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { flush(); continue; }
      const q = standUp([x, y, z]), l = run[run.length - 1];
      if (l && Math.hypot(q[0] - l[0], q[1] - l[1], q[2] - l[2]) < 1e-6) continue;
      run.push(q);
    }
    flush();
  }
  return out;
}

export function buildUnreasonDocument(pieces, opts = {}) {
  const objects = [];
  const id = () => objects.length + 1;
  for (const p of pieces) {
    const creases = Array.isArray(p.cage.creases) ? {} : (p.cage.creases || {});
    objects.push({
      id: id(), name: p.name || `piece-${objects.length + 1}`, layerId: 0,
      leaf: { type: 'SuperB', superbCage: { vertices: p.cage.vertices.map(standUp), faces: p.cage.faces, creases }, superbSourceCommand: 'tosubd', superbFacets: null },
    });
  }
  for (const c of opts.curves || []) {
    const C = c.controlPoints.map(standUp), n = C.length;
    const layout = periodicCubicRhinoLayout(C);
    /* the knot vector in full (points + degree + 1), uniform: −3 .. n + 3;
     * the curve's domain is [0, n] and it closes on itself */
    const knots = []; for (let k = -3; k <= n + 3; k++) knots.push(k);
    const samples = [], through = [];
    for (let k = 0; k < n * 4; k++) samples.push(evalPeriodicCubic(C, k / 4));
    samples.push(samples[0].slice());
    for (let k = 0; k < 24; k++) through.push(evalPeriodicCubic(C, k * n / 24));
    objects.push({
      id: id(), name: c.name || `curve-${objects.length + 1}`, layerId: 0,
      leaf: {
        type: 'SketchCurve', crv: { degree: 3, knots, ctrlPts: layout.points.map((q) => [q[0], q[1], q[2], 1]) },
        sketchSamples: samples.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
        sketchPoints: through.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
        sketchGenerated: false, sketchExtracted: false, sketchClosed: true, sketchDegree: 3, sketchControlNet: false, annotationColor: null,
      },
    });
  }
  for (const pt of opts.points || []) {
    const q = standUp(pt.p);
    objects.push({ id: id(), name: pt.name || `point-${objects.length + 1}`, layerId: 0, leaf: { type: 'Point', point: { x: q[0], y: q[1], z: q[2] } } });
  }
  // a perforated piece's holes: a circle each on the outer surface, on their own layer
  let holeCount = 0;
  for (const p of pieces) (p.holes || []).forEach((h, k) => {
    const c = holeCutter(h), crv = circleCurve(c.center, c.n, c.r);
    objects.push({
      id: id(), name: `${p.name || 'piece'} hole ${k + 1}`, layerId: 1,
      leaf: {
        type: 'SketchCurve', crv: { degree: 2, knots: crv.knots, ctrlPts: crv.ctrlPts },
        sketchSamples: crv.samples.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
        sketchPoints: crv.through.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
        sketchGenerated: false, sketchExtracted: false, sketchClosed: true, sketchDegree: 2, sketchControlNet: false, annotationColor: null,
      },
    });
    holeCount++;
  });
  // the outsole's Tread: each groove's centreline (or contour) a polyline (degree 1) on '<piece> tread'
  const treadLayers = [];
  for (const p of pieces) { const runs = treadRuns(p.treadCurves); if (!runs.length) continue;
    const layerId = 2 + treadLayers.length; treadLayers.push(`${p.name || 'piece'} tread`);
    runs.forEach((pts, k) => {
      const knots = [0]; for (let i = 0; i < pts.length; i++) knots.push(i); knots.push(pts.length - 1);
      objects.push({
        id: id(), name: `${p.name || 'piece'} groove ${k + 1}`, layerId,
        leaf: {
          type: 'SketchCurve', crv: { degree: 1, knots, ctrlPts: pts.map((q) => [q[0], q[1], q[2], 1]) },
          sketchSamples: pts.map((q) => ({ x: q[0], y: q[1], z: q[2] })), sketchPoints: pts.map((q) => ({ x: q[0], y: q[1], z: q[2] })),
          sketchGenerated: false, sketchExtracted: false, sketchClosed: false, sketchDegree: 1, sketchControlNet: false, annotationColor: null,
        },
      });
    });
  }
  let reference = null;
  if (opts.last && opts.last.positions && opts.last.indices) {
    reference = referenceMesh(opts.last.positions, opts.last.indices);
    const P = reference.positions, T = reference.indices, positions = new Array(P.length / 3), triangles = new Array(T.length / 3);
    for (let k = 0; k < positions.length; k++) positions[k] = standUp([P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
    for (let k = 0; k < triangles.length; k++) triangles[k] = [T[k * 3], T[k * 3 + 1], T[k * 3 + 2]];
    objects.push({
      id: id(), name: opts.lastName || 'last', layerId: 0,
      referenceMesh: { positions, triangles, faces: [], mask: null, detectedBodyCount: 1, importUnit: 'mm', scaleLocked: true, placementFrame: null, toSuperBOptions: null },
      sourceTag: reference.decimated ? `decimated to ${reference.triangles} triangles` : null,
    });
  }
  const doc = {
    format: 'unreason-document', version: 1, app: 'LastFirst', savedAt: new Date().toISOString(),
    document: { v: 1, nextId: objects.length + 1, currentLayerId: 0, objects, documentSettings: { superbRefinementLevel: opts.refinementLevel ?? 2 } },
  };
  if (holeCount || treadLayers.length) doc.document.layers = [
    { id: 0, name: 'Default', color: '#8a8d90', parentId: null, visible: true, locked: false },
    { id: 1, name: 'perforations', color: '#d9534f', parentId: null, visible: true, locked: false },
    ...treadLayers.map((name, k) => ({ id: 2 + k, name, color: '#e0a030', parentId: null, visible: true, locked: false })),
  ];
  return JSON.stringify(doc, null, reference ? 0 : 2);
}

// ── .3dm ──────────────────────────────────────────────────────────────────
/* The patched rhino3dm (vendor/rhino3dm, SubD authoring). In a browser the
 * ES module and its wasm are fetched from `base` (default: vendor/rhino3dm/
 * beside the app); in node the CommonJS copy of the same build is required.
 * Loaded once. */
let rhinoPromise = null;
export function loadRhino3dm(opts = {}) {
  if (rhinoPromise) return rhinoPromise;
  const inNode = typeof process !== 'undefined' && process.versions && process.versions.node && typeof window === 'undefined';
  rhinoPromise = (async () => {
    if (inNode) {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      return require('../vendor/rhino3dm/rhino3dm.cjs')();
    }
    const base = opts.base || new URL('../vendor/rhino3dm/', import.meta.url).href;
    const m = await import(/* @vite-ignore */ base + 'rhino3dm.module.js');
    return (m.default || m)({ locateFile: (f) => base + f });
  })().catch((e) => { rhinoPromise = null; throw e; });
  return rhinoPromise;
}

/* pieces: [{ name, cage, layer?, color?, holes? }] (holes: perforate.mjs cuts); opts.last {positions, indices};
 * opts.curves [{ name, controlPoints, layer? }] (periodic cubic from the
 * unique control points — rhino3dm's NurbsCurve.create(true, 3, points)
 * wraps them itself); opts.points [{ name, p, layer? }]. Millimetres, Z up. */
export async function build3dm(pieces, opts = {}) {
  const rhino = opts.rhino || await loadRhino3dm(opts);
  const missing = subdAuthoringMissing(rhino);
  if (missing) throw new Error(missing);
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
  const layers = new Map();
  const layerIndex = (name, color) => {
    if (layers.has(name)) return layers.get(name);
    const l = new rhino.Layer();
    l.name = name;
    l.color = { r: color.r, g: color.g, b: color.b, a: 255 };
    const idx = doc.layers().add(l);
    layers.set(name, idx);
    return idx;
  };
  const attrs = (name, layer, color) => { const a = new rhino.ObjectAttributes(); a.name = name; a.layerIndex = layerIndex(layer, color); return a; };
  const report = [], skipped = [];
  /* opts.skipInvalid: a piece whose SubD OpenNURBS rejects is left out (with its holes and grooves) and named in
     `skipped`; the rest are written */
  pieces = pieces.filter((p) => {
    const built = cageToSubD(rhino, p.cage, {});
    if (built.valid) { p._subd = built; return true; }
    if (!opts.skipInvalid) throw new Error(`${p.title || p.name}: OpenNURBS calls the SubD invalid`);
    skipped.push({ name: p.name, title: p.title || p.name, reason: 'Rhino rejects its SubD' });
    return false;
  });
  if (!pieces.length && skipped.length) throw new Error(skipped.map((k) => `${k.title}: ${k.reason}`).join('; '));
  for (const p of pieces) {
    const built = p._subd; delete p._subd;
    const id = doc.objects().add(built.subd, attrs(p.name, p.layer || p.name, p.color || { r: 120, g: 60, b: 200 }));
    if (!id) throw new Error(`${p.name}: the object table refused the SubD`);
    report.push({ name: p.name, kind: 'SubD', faces: built.faces, creases: built.creases, sharp: built.sharp });
  }
  // a perforated piece's holes: a capped cylinder each, through the wall, on `<piece> perforations`
  for (const p of pieces) (p.holes || []).forEach((h, k) => {
    const c = holeCutter(h), [t, b] = frameAbout(c.n), circle = new rhino.Circle([0, 0, 0], c.r);
    circle.plane = { origin: c.base, xAxis: t, yAxis: b, zAxis: c.n };
    const brep = new rhino.Cylinder(circle, c.height).toBrep(true, true);
    if (!brep || !brep.isSolid) throw new Error(`${p.name} hole ${k + 1}: OpenNURBS made no closed cylinder`);
    const id = doc.objects().add(brep, attrs(`${p.name} hole ${k + 1}`, `${p.name} perforations`, { r: 217, g: 83, b: 79 }));
    if (!id) throw new Error(`${p.name} hole ${k + 1}: the object table refused the cylinder`);
    report.push({ name: `${p.name} hole ${k + 1}`, kind: 'cutter', r: c.r, height: c.height });
  });
  // the outsole's Tread: each groove's centreline (or contour) a polyline curve on '<piece> tread'
  for (const p of pieces) treadRuns(p.treadCurves).forEach((pts, k) => {
    const pl = new rhino.Polyline(pts.length); for (const q of pts) pl.add(q[0], q[1], q[2]);
    const crv = pl.toPolylineCurve ? pl.toPolylineCurve() : new rhino.PolylineCurve(pts);
    if (!crv || !crv.isValid) throw new Error(`${p.name} groove ${k + 1}: OpenNURBS calls the polyline invalid`);
    const id = doc.objects().add(crv, attrs(`${p.name} groove ${k + 1}`, `${p.name} tread`, { r: 224, g: 160, b: 48 }));
    if (!id) throw new Error(`${p.name} groove ${k + 1}: the object table refused the curve`);
    report.push({ name: `${p.name} groove ${k + 1}`, kind: 'groove', points: pts.length });
  });
  for (const c of opts.curves || []) {
    const nc = curveToNurbs(rhino, { ctrl: c.controlPoints, closed: true, degree: 3 }, {});
    if (!nc || !nc.isValid) throw new Error(`${c.name}: OpenNURBS calls the curve invalid`);
    const id = doc.objects().add(nc, attrs(c.name, c.layer || c.name, c.color || { r: 235, g: 200, b: 90 }));
    if (!id) throw new Error(`${c.name}: the object table refused the curve`);
    report.push({ name: c.name, kind: 'curve', points: c.controlPoints.length, degree: nc.degree, periodic: nc.isPeriodic });
  }
  for (const pt of opts.points || []) {
    const q = standUp(pt.p);
    const id = doc.objects().addPoint([q[0], q[1], q[2]], attrs(pt.name, pt.layer || 'points', pt.color || { r: 235, g: 235, b: 235 }));
    if (!id) throw new Error(`${pt.name}: the object table refused the point`);
    report.push({ name: pt.name, kind: 'point' });
  }
  if (opts.last && opts.last.positions && opts.last.indices) {
    const ref = referenceMesh(opts.last.positions, opts.last.indices);
    const faces = new Array(ref.indices.length / 3);
    for (let k = 0; k < faces.length; k++) faces[k] = [ref.indices[k * 3], ref.indices[k * 3 + 1], ref.indices[k * 3 + 2]];
    const m = meshToRhino(rhino, { positions: ref.positions, faces }, {});
    const id = doc.objects().add(m.mesh, attrs(opts.lastName || 'last', 'last', { r: 200, g: 190, b: 180 }));
    if (!id) throw new Error('the object table refused the last');
    report.push({ name: opts.lastName || 'last', kind: 'mesh', vertices: m.vertices, faces: m.faces, decimated: ref.decimated });
  }
  return { bytes: doc.toByteArray(), report, skipped };
}

/* what a .3dm holds, by OpenNURBS's reading: MASQ's read3dmSubDs, which
 * lists SubDs, meshes and curves */
export async function read3dm(bytes, opts = {}) {
  const rhino = opts.rhino || await loadRhino3dm(opts);
  return read3dmSubDs(rhino, bytes);
}

// ── OBJ: one quad cage, the app's frame, mm ───────────────────────────────
export function buildOBJ(piece) {
  return buildSuperBOBJ(piece.cage, piece.name || 'lastfirst_superb');
}
