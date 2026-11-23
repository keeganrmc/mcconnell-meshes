/* A SuperB cage written to a .3dm as a Rhino SubD — the cage as the control
 * net, every rim crease as a crease, every softened one as a sharpness.
 *
 * rhino3dm (vendor/rhino3dm, 2.7 MB) is fetched the first time a .3dm is
 * asked for and never at boot. The released binding can only READ a SubD;
 * this build carries vendor/rhino3dm/subd_authoring.patch, which adds
 * addVertex / addFace4 / addFace / setEdgeCrease / setEdgeSharpness /
 * updateUnsetTagsAndSectorCoefficients. A build without them refuses by name
 * rather than writing a mesh and calling it a SubD.
 *
 * Crease weights are Unreason's scale (one level of sharpness per unit,
 * SUPERB_CREASE_LEVEL_SCALE = 3) and Rhino's sharpness is the same rule —
 * ON_SubDEdgeSharpness::Subdivided takes one off per level — so a weight
 * under the scale goes over as itself and a weight at the scale is a crease.
 * A naked edge is a crease whatever the map says; Rhino tags it so too.
 *
 * Frame: Rhino is Z-up and its Front view looks along +Y, so the head's
 * Y-up, faces-+Z design frame goes over as (x, y, z) -> (x, -z, y) — the
 * mask upright, facing the front view — the same stand-up the .unreason
 * takes. Units are millimetres, declared in the file.
 */
import { CREASE_SCALE } from './superbsolid.js';

let rhinoPromise = null;
export function loadRhino(opts = {}) {
  if (!rhinoPromise) {
    const base = opts.base || new URL('../vendor/rhino3dm/', import.meta.url).href;
    rhinoPromise = import(/* @vite-ignore */ base + 'rhino3dm.module.js')
      .then((m) => (m.default || m)({ locateFile: (f) => base + f }))
      .catch((e) => { rhinoPromise = null; throw e; });
  }
  return rhinoPromise;
}

/* what this binding can do — the refusal, named, when it cannot */
export function subdAuthoringMissing(rhino) {
  const p = rhino && rhino.SubD && rhino.SubD.prototype;
  const need = ['addVertex', 'addFace4', 'setEdgeCrease', 'setEdgeSharpness', 'updateUnsetTagsAndSectorCoefficients'];
  const missing = need.filter((n) => !p || typeof p[n] !== 'function');
  return missing.length ? `this rhino3dm build cannot author a SubD (no ${missing.join(', ')}) — rebuild it with vendor/rhino3dm/subd_authoring.patch` : null;
}

export const standUp = (v) => [v[0], -v[2], v[1]];

/* one SubD from one cage; returns { subd, creases, sharp, valid } */
export function cageToSubD(rhino, cage, opts = {}) {
  const subd = new rhino.SubD();
  const frame = opts.zUp === false ? (v) => v : standUp;
  /* a vertex no face uses is left out: OpenNURBS calls a SubD with one invalid */
  const used = new Uint8Array(cage.vertices.length);
  for (const f of cage.faces) for (const i of f) used[i] = 1;
  const ids = cage.vertices.map((v, i) => (used[i] ? subd.addVertex(frame(v)) : -1));
  if (ids.some((i, k) => used[k] && i < 0)) throw new Error('a cage vertex was refused');
  let faces = 0;
  for (const f of cage.faces) {
    const r = f.length === 4 ? subd.addFace4(ids[f[0]], ids[f[1]], ids[f[2]], ids[f[3]])
      : f.length === 3 ? subd.addFace4(ids[f[0]], ids[f[1]], ids[f[2]], -1)
      : typeof subd.addFace === 'function' ? subd.addFace(f.map((i) => ids[i])) : -1;
    if (r < 0) throw new Error(`cage face ${faces} (${f.length} sides) was refused`);
    faces++;
  }
  /* naked edges: creases by construction, whatever the map says */
  const count = new Map();
  for (const f of cage.faces) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length]; const key = a < b ? `${a}_${b}` : `${b}_${a}`; count.set(key, (count.get(key) || 0) + 1); }
  let creases = 0, sharp = 0;
  for (const [key, w] of Object.entries(cage.creases || {})) {
    if (!(w > 0) || count.get(key) !== 2) continue;
    const [a, b] = key.split('_').map(Number);
    if (w >= CREASE_SCALE - 1e-9) { if (subd.setEdgeCrease(ids[a], ids[b], true)) creases++; }
  }
  /* tags first — the update tags naked edges and every vertex from the
   * creases meeting there — then the sharpness, which the update would clear
   * from an untagged edge */
  subd.updateUnsetTagsAndSectorCoefficients();
  for (const [key, w] of Object.entries(cage.creases || {})) {
    if (!(w > 0) || w >= CREASE_SCALE - 1e-9 || count.get(key) !== 2) continue;
    const [a, b] = key.split('_').map(Number);
    if (subd.setEdgeSharpness(ids[a], ids[b], Math.min(4, w))) sharp++;
  }
  return { subd, creases, sharp, valid: subd.isValid, faces };
}

/* the mask's edge as a NURBS curve: a closed uniform periodic B-spline of
 * degree 2 through the outline's control points is exactly what the app
 * draws, and NurbsCurve.create(periodic, degree, points) is that curve */
export function curveToNurbs(rhino, curve, opts = {}) {
  const frame = opts.zUp === false ? (v) => v : standUp;
  const pts = new rhino.Point3dList();
  for (const c of curve.ctrl) { const q = frame(c); pts.add(q[0], q[1], q[2]); }
  return rhino.NurbsCurve.create(!!curve.closed, curve.degree || 2, pts);
}

/**
 * build3dm(rhino, objects) -> { bytes, report }
 * objects: [{ name, cage, layer, color: {r,g,b} }] and/or [{ name, curve: {ctrl, closed, degree}, layer, color }]
 */
/* a triangle or quad mesh as a Rhino mesh, stood up like the SubD: positions
 * flat in mm, faces as index arrays (3 or 4), colours flat 0..1 or null */
export function meshToRhino(rhino, mesh, opts = {}) {
  const frame = opts.zUp === false ? (v) => v : standUp;
  const M = new rhino.Mesh();
  const P = mesh.positions, n = P.length / 3, V = M.vertices();
  for (let i = 0; i < n; i++) { const v = frame([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); V.add(v[0], v[1], v[2]); }
  const F = M.faces();
  let faces = 0;
  for (const f of mesh.faces) {
    if (f.length === 4) F.addQuadFace(f[0], f[1], f[2], f[3]);
    else if (f.length === 3) F.addTriFace(f[0], f[1], f[2]);
    else continue;
    faces++;
  }
  if (mesh.colors && mesh.colors.length === n * 3) {
    const C = M.vertexColors(), c = mesh.colors;
    for (let i = 0; i < n; i++) C.add(Math.round(c[i * 3] * 255), Math.round(c[i * 3 + 1] * 255), Math.round(c[i * 3 + 2] * 255));
  }
  return { mesh: M, vertices: n, faces, coloured: !!(mesh.colors && mesh.colors.length === n * 3) };
}

export function build3dm(rhino, objects, opts = {}) {
  const missing = subdAuthoringMissing(rhino);
  if (missing) throw new Error(missing);
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
  const layers = new Map();
  const layerIndex = (name, color) => {
    if (layers.has(name)) return layers.get(name);
    const l = new rhino.Layer();
    l.name = name;
    /* a missing alpha writes ZERO — a layer Rhino cannot shade */
    l.color = { r: color.r, g: color.g, b: color.b, a: 255 };
    const idx = doc.layers().add(l);
    layers.set(name, idx);
    return idx;
  };
  const report = [];
  for (const o of objects) {
    if (o.curve) {
      const nc = curveToNurbs(rhino, o.curve, opts);
      if (!nc || !nc.isValid) throw new Error(`${o.name}: OpenNURBS calls the curve invalid`);
      const attrs = new rhino.ObjectAttributes();
      attrs.name = o.name;
      attrs.layerIndex = layerIndex(o.layer || 'MASQ curves', o.color || { r: 235, g: 200, b: 90 });
      const id = doc.objects().add(nc, attrs);
      if (!id) throw new Error(`${o.name}: the object table refused the curve`);
      report.push({ name: o.name, curve: true, points: o.curve.ctrl.length, closed: !!o.curve.closed });
      continue;
    }
    if (o.mesh) {
      const m = meshToRhino(rhino, o.mesh, opts);
      const attrs = new rhino.ObjectAttributes();
      attrs.name = o.name;
      attrs.layerIndex = layerIndex(o.layer || o.name, o.color || { r: 200, g: 190, b: 180 });
      const id = doc.objects().add(m.mesh, attrs);
      if (!id) throw new Error(`${o.name}: the object table refused the mesh`);
      report.push({ name: o.name, mesh: true, vertices: m.vertices, faces: m.faces, coloured: m.coloured });
      continue;
    }
    const built = cageToSubD(rhino, o.cage, opts);
    if (!built.valid) throw new Error(`${o.name}: OpenNURBS calls the SubD invalid`);
    const attrs = new rhino.ObjectAttributes();
    attrs.name = o.name;
    attrs.layerIndex = layerIndex(o.layer || o.name, o.color || { r: 60, g: 140, b: 130 });
    const id = doc.objects().add(built.subd, attrs);
    if (!id) throw new Error(`${o.name}: the object table refused the SubD`);
    report.push({ name: o.name, faces: built.faces, creases: built.creases, sharp: built.sharp });
  }
  return { bytes: doc.toByteArray(), report };
}

/* the round trip a gate reads: what the file holds, by OpenNURBS's reading */
export function read3dmSubDs(rhino, bytes) {
  const doc = rhino.File3dm.fromByteArray(bytes);
  const out = [];
  const T = doc.objects();
  for (let i = 0; i < T.count; i++) {
    const o = T.get(i), g = o.geometry();
    if (g.objectType === rhino.ObjectType.Curve) { out.push({ name: o.attributes().name, kind: 'curve', closed: g.isClosed, periodic: g.isPeriodic, degree: g.degree, points: g.points ? g.points.count : null }); continue; }
    if (g.objectType === rhino.ObjectType.Mesh) { const v0 = g.vertices().count ? g.vertices().get(0) : null; out.push({ name: o.attributes().name, kind: 'mesh', vertices: g.vertices().count, faces: g.faces().count, quads: g.faces().quadCount, colours: g.vertexColors().count, first: v0 ? [v0[0], v0[1], v0[2]] : null, layer: doc.layers().get(o.attributes().layerIndex).name }); continue; }
    if (g.objectType !== rhino.ObjectType.SubD) { out.push({ name: o.attributes().name, kind: 'not a SubD' }); continue; }
    const E = g.edges();
    let creases = 0, sharp = 0, naked = 0, n = 0;
    let e = E.first();
    while (e && n < E.count) { n++; if (e.faceCount === 1) naked++; else if (e.isCrease) creases++; if (e.isSharp) sharp++; if (n >= E.count) break; e = E.next(); }
    out.push({ name: o.attributes().name, kind: 'SubD', faces: g.faceCount, vertices: g.vertexCount, edges: g.edgeCount, interiorCreases: creases, sharp, naked, solid: g.isSolid, units: doc.settings().modelUnitSystem });
  }
  return out;
}
