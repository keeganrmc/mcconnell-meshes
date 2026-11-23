// THE CAGE EDITOR: MASQ's SuperB handles on a plate's cage. The outer sheet
// of the cage (plate.mjs: quads [0, sheetFaces) over vertices [0, sheetCount))
// is the surface a person picks — a corner, an edge or a face — and a drag on
// the selection lifts it along the selection's mean normal, the rings around
// it coming along on a soft falloff over `reachMM`.
//
// WHAT AN EDIT IS. The plate is rebuilt from the last and per-vertex fields
// on every change, so a cage position never survives: a lift is stored as
// RELIEF, millimetres per LAST vertex (cage vertex i on the outer sheet is
// last vertex cage.srcOf[i]; the inner sheet IS the last), and the app adds
// it into buildPlate's per-vertex `wall`. MASQ keeps cageRelief (the skin
// displaced) apart from cageWall (the solid thickened); a plate is always the
// solid case — its back stays on the last and only the outer sheet moves —
// so there is one field. Relief never goes under zero: a lift takes back
// only what a lift added (MASQ's floor for the solid).
//
// THE POINTER, with no modifier anywhere:
//   press on an unselected element      selects it (replacing the selection)
//   press on a selected element, still  extends it: a face adds the ring of
//                                       faces around the selection, an edge
//                                       takes its loop, a corner its faces
//   press on the selection, then move   lifts (the bead's arrowhead too)
//   press on nothing                    clears; the event passes through, so
//                                       the app's orbit takes it
// A press on the cage is stopped at the capture phase so the app's own
// pointer handlers on the same element never see it.
//
// mm throughout; the cage and the scene share the app's frame at the origin.

const CORNER_PX = 9, EDGE_PX = 8, BEAD_PX = 12, DRAG_PX = 3;
const BEAD_MM = 12, CONE_R = 2.2, CONE_H = 5.5;
const YELLOW = 0xfbec1a;                 // the app's cage yellow: the wire and the bead
const CREAM = 0xf2ede3;                  // the app's cream: the selection, legible on the yellow plate
const ekey = (u, v) => (u < v ? u * 4294967296 + v : v * 4294967296 + u);

/* an edge's loop on a quad sheet: straight on through every four-valent
 * vertex, stopping at a rim or a star; a rim edge's loop is its whole rim */
export function edgeLoop(T, edge) {
  const { star, valence, rims } = T;
  const k0 = ekey(edge[0], edge[1]);
  if ((star.get(k0) || []).length === 1) {
    for (const L of rims) {
      const n = L.length;
      for (let i = 0; i < n; i++) if ((L[i] === edge[0] && L[(i + 1) % n] === edge[1]) || (L[i] === edge[1] && L[(i + 1) % n] === edge[0])) return L.map((v, j) => [v, L[(j + 1) % n]]);
    }
  }
  const walk = (from, to) => {
    const out = [];
    let a = from, b = to;
    for (let n = 0; n < 100000; n++) {
      out.push([a, b]);
      if (valence[b] !== 4) break;
      const faces = star.get(ekey(a, b)) || [];
      let next = -1;
      for (const u of T.nb[b]) {
        if (u === a) continue;
        const fs = star.get(ekey(b, u)) || [];
        if (fs.some((f) => faces.includes(f))) continue;
        next = u; break;
      }
      if (next < 0) break;
      if (next === from) { out.push([b, next]); break; }
      a = b; b = next;
    }
    return out;
  };
  const fwd = walk(edge[0], edge[1]);
  if (fwd.length && fwd[fwd.length - 1][1] === edge[0]) return fwd;
  const back = walk(edge[1], edge[0]);
  return fwd.concat(back.slice(1));
}

/* the outer sheet's topology: neighbours, the faces at each edge, valence,
 * per-vertex normals (area-weighted), the rims */
function sheetTopology(cage) {
  const nv = cage.sheetCount, nf = cage.sheetFaces, Q = cage.quads, X = cage.positions;
  const nbSet = Array.from({ length: nv }, () => new Set());
  const star = new Map();
  const N = new Float32Array(nv * 3);
  for (let f = 0; f < nf; f++) {
    const a = Q[f * 4], b = Q[f * 4 + 1], c = Q[f * 4 + 2], d = Q[f * 4 + 3];
    const q = [a, b, c, d];
    for (let k = 0; k < 4; k++) {
      const u = q[k], v = q[(k + 1) % 4];
      nbSet[u].add(v); nbSet[v].add(u);
      const key = ekey(u, v); let l = star.get(key); if (!l) star.set(key, l = []); l.push(f);
    }
    const ux = X[c * 3] - X[a * 3], uy = X[c * 3 + 1] - X[a * 3 + 1], uz = X[c * 3 + 2] - X[a * 3 + 2];
    const vx = X[d * 3] - X[b * 3], vy = X[d * 3 + 1] - X[b * 3 + 1], vz = X[d * 3 + 2] - X[b * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of q) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
  }
  for (let i = 0; i < nv; i++) { const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
  const nb = nbSet.map((s) => Int32Array.from(s));
  const valence = new Int32Array(nv); for (let i = 0; i < nv; i++) valence[i] = nb[i].length;
  const rims = (cage.rims || []).map((L) => Array.from(L));
  const rimSet = new Set(); for (const L of rims) for (const v of L) rimSet.add(v);
  return { nv, nf, nb, star, valence, normals: N, rims, rimSet };
}

function dotTexture(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 32, 32);
  g.beginPath(); g.arc(16, 16, 13, 0, Math.PI * 2); g.fillStyle = '#f2ede3'; g.fill();
  g.lineWidth = 3; g.strokeStyle = '#0c0b0a'; g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/**
 * createCageEditor({ THREE, scene, camera, dom, getCage, getLast, onChange })
 *   setCage(cage, fields?)      the plate's cage as the worker returns it; the selection is kept by srcOf
 *   enable(on) / enabled
 *   reachMM, stepMM, selection (a Set of outer-sheet cage vertex ids, read-only)
 *   lift(mm) grow() shrink() loop() smooth() clearSelection() clearEdits()
 *   getFields() → { relief } (the live arrays) · setFields(f) (silent) · snapshot() · restore(s) (fires onChange)
 *   onChange(fields) after every edit · dispose()
 */
export function createCageEditor({ THREE, scene, camera, dom, getCage, getLast, onChange }) {
  const getCam = () => (typeof camera === 'function' ? camera() : camera);
  let cage = null, T = null, view = null, enabled = false;
  let faces = new Set(), edges = [], corner = -1;
  const selection = new Set();
  let relief = null;
  const dials = { reachMM: 12, stepMM: 1 };
  let drag = null, press = null, frame = null;

  /* ---- the field ---- */
  const V = () => { const l = getLast && getLast(); return l && l.positions ? l.positions.length / 3 : 0; };
  const fieldsReady = () => {
    const n = V();
    if (!relief || relief.length !== n) { const f = new Float32Array(n); if (relief) f.set(relief.subarray(0, Math.min(n, relief.length))); relief = f; }
  };
  const fields = () => { fieldsReady(); return { relief }; };
  const changed = () => { if (onChange) onChange(fields()); };

  /* ---- overlays ---- */
  const group = new THREE.Group(); group.name = 'cageedit'; group.visible = false;
  const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: YELLOW, transparent: true, opacity: 0.35 }));
  wire.renderOrder = 20;
  const faceHi = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: CREAM, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide }));
  faceHi.renderOrder = 28; faceHi.visible = false;
  const edgeHi = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: CREAM, depthTest: false, transparent: true, opacity: 1 }));
  edgeHi.renderOrder = 29; edgeHi.visible = false;
  const dot = dotTexture(THREE);
  const corners = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: dot, size: 11, sizeAttenuation: false, depthTest: false, transparent: true, alphaTest: 0.4 }));
  corners.renderOrder = 30; corners.visible = false;
  const grabbed = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: dot, size: 17, sizeAttenuation: false, depthTest: false, transparent: true, alphaTest: 0.4 }));
  grabbed.renderOrder = 31; grabbed.visible = false;
  const bead = new THREE.Group(); bead.visible = false;
  const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: YELLOW, depthTest: false, transparent: true, opacity: 0.9 }));
  stem.renderOrder = 31;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(CONE_R, CONE_H, 14), new THREE.MeshBasicMaterial({ color: YELLOW, depthTest: false, transparent: true, opacity: 0.95 }));
  cone.renderOrder = 32;
  bead.add(stem); bead.add(cone);
  group.add(wire, faceHi, edgeHi, corners, grabbed, bead);
  scene.add(group);
  /* the outer sheet triangulated, raycast only; never drawn */
  const pickMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  pickMesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

  const setPos = (obj, arr) => {
    const g = obj.geometry;
    const at = g.getAttribute('position');
    if (at && at.array.length === arr.length) { at.array.set(arr); at.needsUpdate = true; }
    else g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.setDrawRange(0, arr.length / 3);
    g.computeBoundingSphere();
  };
  const p3 = (i) => [view[i * 3], view[i * 3 + 1], view[i * 3 + 2]];

  function rebuildSheet() {
    if (!cage) { wire.visible = false; return; }
    const nf = T.nf, Q = cage.quads;
    const wi = new Uint32Array(nf * 8), ti = new Uint32Array(nf * 6);
    for (let f = 0; f < nf; f++) {
      const a = Q[f * 4], b = Q[f * 4 + 1], c = Q[f * 4 + 2], d = Q[f * 4 + 3];
      wi.set([a, b, b, c, c, d, d, a], f * 8);
      ti.set([a, b, c, a, c, d], f * 6);
    }
    setPos(wire, view); wire.geometry.setIndex(new THREE.BufferAttribute(wi, 1)); wire.geometry.setDrawRange(0, nf * 8);
    setPos(pickMesh, view); pickMesh.geometry.setIndex(new THREE.BufferAttribute(ti, 1)); pickMesh.geometry.setDrawRange(0, nf * 6);
    pickMesh.geometry.boundingBox = null; pickMesh.geometry.computeBoundingSphere();
    wire.visible = true;
  }
  function refreshView() {
    if (!cage) return;
    const at = wire.geometry.getAttribute('position'); if (at) { at.array.set(view); at.needsUpdate = true; }
    const pt = pickMesh.geometry.getAttribute('position'); if (pt) { pt.array.set(view); pt.needsUpdate = true; pickMesh.geometry.computeBoundingSphere(); }
    drawSelection();
  }
  function selectionFrame() {
    if (!cage || !selection.size) return null;
    const c = [0, 0, 0], n = [0, 0, 0];
    for (const vi of selection) { for (let k = 0; k < 3; k++) { c[k] += view[vi * 3 + k]; n[k] += T.normals[vi * 3 + k]; } }
    for (let k = 0; k < 3; k++) c[k] /= selection.size;
    const l = Math.hypot(n[0], n[1], n[2]) || 1; for (let k = 0; k < 3; k++) n[k] /= l;
    return { c, n };
  }
  function drawSelection() {
    const show = enabled && cage && selection.size > 0;
    if (!show) { faceHi.visible = edgeHi.visible = corners.visible = grabbed.visible = bead.visible = false; frame = null; return; }
    if (faces.size) {
      const p = new Float32Array(faces.size * 18); let o = 0;
      for (const fi of faces) { const q = [cage.quads[fi * 4], cage.quads[fi * 4 + 1], cage.quads[fi * 4 + 2], cage.quads[fi * 4 + 3]]; for (const v of [q[0], q[1], q[2], q[0], q[2], q[3]]) { p.set(p3(v), o); o += 3; } }
      setPos(faceHi, p); faceHi.visible = true;
    } else faceHi.visible = false;
    if (edges.length) {
      const p = new Float32Array(edges.length * 6);
      edges.forEach(([u, v], i) => { p.set(p3(u), i * 6); p.set(p3(v), i * 6 + 3); });
      setPos(edgeHi, p); edgeHi.visible = true;
    } else edgeHi.visible = false;
    const p = new Float32Array(selection.size * 3); let o = 0;
    for (const vi of selection) { p.set(p3(vi), o); o += 3; }
    setPos(corners, p); corners.visible = true;
    if (corner >= 0) { setPos(grabbed, Float32Array.from(p3(corner))); grabbed.visible = true; } else grabbed.visible = false;
    frame = selectionFrame();
    const { c, n } = frame;
    const tip = [c[0] + n[0] * BEAD_MM, c[1] + n[1] * BEAD_MM, c[2] + n[2] * BEAD_MM];
    stem.geometry.setFromPoints([new THREE.Vector3(...c), new THREE.Vector3(...tip)]);
    cone.position.set(tip[0], tip[1], tip[2]);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], n[1], n[2]));
    bead.visible = true;
  }

  /* ---- the selection ---- */
  function syncSelection() {
    selection.clear();
    if (!cage) return;
    for (const fi of faces) for (let k = 0; k < 4; k++) selection.add(cage.quads[fi * 4 + k]);
    for (const [u, v] of edges) { selection.add(u); selection.add(v); }
    if (corner >= 0) { selection.clear(); selection.add(corner); }
  }
  function isSelected(hit) {
    if (hit.kind === 'face') return faces.has(hit.index);
    if (hit.kind === 'edge') { const k = ekey(hit.edge[0], hit.edge[1]); return edges.some((e) => ekey(e[0], e[1]) === k); }
    if (hit.kind === 'corner') return corner === hit.index;
    return false;
  }
  function applySelection(hit) {
    if (hit.kind === 'corner') corner = hit.index;
    else {
      corner = -1; faces = new Set(); edges = [];
      if (hit.kind === 'face') faces.add(hit.index);
      if (hit.kind === 'edge') edges.push(hit.edge.slice());
    }
    syncSelection(); drawSelection();
  }
  /* the faces around the selection's vertices */
  const facesTouching = (vs) => { const out = new Set(); for (let f = 0; f < T.nf; f++) for (let k = 0; k < 4; k++) if (vs.has(cage.quads[f * 4 + k])) { out.add(f); break; } return out; };
  function grow(dir) {
    if (!cage || !selection.size) return;
    if (corner >= 0 || (!faces.size && edges.length)) {
      faces = facesTouching(new Set(selection)); corner = -1; edges = [];
    } else if (dir > 0) {
      for (const f of facesTouching(new Set(selection))) faces.add(f);
    } else {
      const count = new Map();
      for (const fi of faces) for (let k = 0; k < 4; k++) { const v = cage.quads[fi * 4 + k]; count.set(v, (count.get(v) || 0) + 1); }
      const all = new Map();
      for (let f = 0; f < T.nf; f++) for (let k = 0; k < 4; k++) { const v = cage.quads[f * 4 + k]; all.set(v, (all.get(v) || 0) + 1); }
      const rim = new Set([...count].filter(([v, c]) => c < all.get(v)).map(([v]) => v));
      faces = new Set([...faces].filter((fi) => ![0, 1, 2, 3].some((k) => rim.has(cage.quads[fi * 4 + k]))));
    }
    syncSelection(); drawSelection();
  }
  function loop() {
    if (!cage || !edges.length) return [];
    const seen = new Set(), out = [];
    for (const e of edges) for (const le of edgeLoop(T, e)) { const k = ekey(le[0], le[1]); if (!seen.has(k)) { seen.add(k); out.push(le); } }
    edges = out; corner = -1; faces = new Set();
    syncSelection(); drawSelection();
    return out.map((e) => e.slice());
  }
  function extend(hit) { if (hit.kind === 'edge') loop(); else grow(1); }
  function clearSelection() { faces = new Set(); edges = []; corner = -1; syncSelection(); drawSelection(); }
  /* the selection carried to a new cage by the last vertex under each corner */
  function remapSelection(oldCage, newCage) {
    if (!oldCage || !selection.size) { faces = new Set(); edges = []; corner = -1; syncSelection(); return; }
    const bySrc = new Map(); for (let i = 0; i < newCage.sheetCount; i++) bySrc.set(newCage.srcOf[i], i);
    const map = (v) => { const j = bySrc.get(oldCage.srcOf[v]); return j === undefined ? -1 : j; };
    const faceOf = new Map();
    for (let f = 0; f < newCage.sheetFaces; f++) faceOf.set([0, 1, 2, 3].map((k) => newCage.quads[f * 4 + k]).sort((a, b) => a - b).join('_'), f);
    const nf = new Set();
    for (const fi of faces) { const q = [0, 1, 2, 3].map((k) => map(oldCage.quads[fi * 4 + k])); if (q.some((v) => v < 0)) continue; const f = faceOf.get(q.sort((a, b) => a - b).join('_')); if (f !== undefined) nf.add(f); }
    faces = nf;
    edges = edges.map(([u, v]) => [map(u), map(v)]).filter(([u, v]) => u >= 0 && v >= 0);
    corner = corner >= 0 ? map(corner) : -1;
    syncSelection();
  }

  /* ---- picking ---- */
  const rectOf = () => dom.getBoundingClientRect();
  const screen = (p, rect) => { const v = new THREE.Vector3(p[0], p[1], p[2]).project(getCam()); return [(v.x * 0.5 + 0.5) * rect.width + rect.left, (-v.y * 0.5 + 0.5) * rect.height + rect.top, v.z]; };
  const segDist = (px, py, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9; const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)); return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)); };
  function pick(px, py, noCorner) {
    if (!cage) return null;
    const rect = rectOf();
    if (bead.visible) { const [bx, by] = screen([cone.position.x, cone.position.y, cone.position.z], rect); if (Math.hypot(px - bx, py - by) < BEAD_PX) return { kind: 'bead' }; }
    ndc.x = ((px - rect.left) / rect.width) * 2 - 1; ndc.y = -((py - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, getCam());
    const hits = ray.intersectObject(pickMesh, false);
    if (!hits.length) {
      /* just outside a rim: the nearest rim edge that faces the camera */
      const dir = getCam().getWorldDirection(new THREE.Vector3());
      let best = null, bd = EDGE_PX;
      for (const L of T.rims) for (let k = 0; k < L.length; k++) {
        const u = L[k], v = L[(k + 1) % L.length];
        const a = screen(p3(u), rect), b = screen(p3(v), rect); if (a[2] > 1 || b[2] > 1) continue;
        const d = segDist(px, py, a, b); if (d >= bd) continue;
        const N = T.normals, f = (N[u * 3] + N[v * 3]) * dir.x + (N[u * 3 + 1] + N[v * 3 + 1]) * dir.y + (N[u * 3 + 2] + N[v * 3 + 2]) * dir.z;
        if (f > 0.3) continue;
        bd = d; best = [u, v];
      }
      return best ? { kind: 'edge', edge: best } : null;
    }
    const fi = Math.floor(hits[0].faceIndex / 2);
    if (!(fi >= 0 && fi < T.nf)) return null;
    const q = [cage.quads[fi * 4], cage.quads[fi * 4 + 1], cage.quads[fi * 4 + 2], cage.quads[fi * 4 + 3]];
    let best = -1, bd = noCorner ? 0 : CORNER_PX;
    for (const vi of q) { if (!selection.has(vi)) continue; const [sx, sy] = screen(p3(vi), rect); const d = Math.hypot(px - sx, py - sy); if (d < bd) { bd = d; best = vi; } }
    if (best >= 0) return { kind: 'corner', index: best };
    /* an edge within EDGE_PX and in the outer third of the quad's width on
     * screen; a thin quad's middle is still its face */
    const S4 = q.map((v) => screen(p3(v), rect));
    const D = [0, 1, 2, 3].map((k) => segDist(px, py, S4[k], S4[(k + 1) % 4]));
    let bestK = -1; bd = EDGE_PX;
    for (let k = 0; k < 4; k++) if (D[k] < bd && D[k] < 0.35 * (D[k] + D[(k + 2) % 4])) { bd = D[k]; bestK = k; }
    if (bestK >= 0) return { kind: 'edge', edge: [q[bestK], q[(bestK + 1) % 4]] };
    return { kind: 'face', index: fi };
  }

  /* ---- the lift ---- */
  /* the weight of each outer-sheet vertex under a lift: 1 on the selection,
   * (1 − (d/R)²)² over the geodesic distance d along the sheet's edges out
   * to reachMM, nothing beyond */
  function reachWeights() {
    const w = new Map(); if (!cage) return w;
    const R = Math.max(0, dials.reachMM);
    const dist = new Float64Array(T.nv).fill(Infinity);
    const heap = [];
    for (const vi of selection) { dist[vi] = 0; heap.push([0, vi]); }
    while (heap.length) {
      let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [d, u] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      if (d > dist[u]) continue;
      for (const v of T.nb[u]) {
        const l = Math.hypot(view[v * 3] - view[u * 3], view[v * 3 + 1] - view[u * 3 + 1], view[v * 3 + 2] - view[u * 3 + 2]);
        const nd = d + l; if (nd < dist[v] && nd < R) { dist[v] = nd; heap.push([nd, v]); }
      }
    }
    for (let i = 0; i < T.nv; i++) { const d = dist[i]; if (d === 0) w.set(i, 1); else if (d < R) w.set(i, (1 - (d / R) ** 2) ** 2); }
    return w;
  }
  /* the lowest a lift may go: no selected vertex under its base */
  function liftFloor() { fieldsReady(); let m = Infinity; for (const vi of selection) m = Math.min(m, relief[cage.srcOf[vi]]); return -(isFinite(m) ? m : 0); }
  function writeLift(mm, weights) {
    fieldsReady();
    for (const [vi, w] of weights) { const s = cage.srcOf[vi]; if (s < 0 || s >= relief.length) continue; relief[s] = Math.max(0, relief[s] + mm * w); }
  }
  function lift(mm) {
    if (!cage || !selection.size || !(Math.abs(mm) > 1e-9)) return 0;
    mm = Math.max(liftFloor(), mm);
    writeLift(mm, reachWeights());
    changed();
    return mm;
  }
  function previewLift(mm, weights) {
    view.set(cage.positions.subarray(0, T.nv * 3));
    for (const [vi, w] of weights) for (let k = 0; k < 3; k++) view[vi * 3 + k] += T.normals[vi * 3 + k] * mm * w;
    refreshView();
  }
  /* the relief over the selection relaxed toward its neighbours, a half
   * step along the sheet's edges; the field's smooth, since positions are
   * rebuilt from it */
  function smooth() {
    if (!cage || !selection.size) return;
    fieldsReady();
    const next = new Map();
    for (const vi of selection) {
      const s = cage.srcOf[vi]; let sum = 0, n = 0;
      for (const u of T.nb[vi]) { const t = cage.srcOf[u]; if (t >= 0) { sum += relief[t]; n++; } }
      if (n) next.set(s, 0.5 * (relief[s] + sum / n));
    }
    for (const [s, v] of next) relief[s] = Math.max(0, v);
    changed();
  }
  function clearEdits() { fieldsReady(); relief.fill(0); changed(); }

  /* ---- the pointer ---- */
  const claim = (e) => { e.preventDefault(); e.stopImmediatePropagation(); try { dom.setPointerCapture(e.pointerId); } catch (_) {} };
  function startDrag(e) {
    if (!frame) return;
    const rect = rectOf(), { c, n } = frame;
    const o = screen(c, rect), t = screen([c[0] + n[0] * 10, c[1] + n[1] * 10, c[2] + n[2] * 10], rect);
    let ax = t[0] - o[0], ay = t[1] - o[1];
    let len = Math.hypot(ax, ay);
    /* a normal pointing at the camera foreshortens to nothing on screen, and
     * a pixel of drag would be metres of lift: the stem's screen length is
     * floored at half of what 10 mm across the view measures at that depth */
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(getCam().quaternion);
    const r = screen([c[0] + right.x * 10, c[1] + right.y * 10, c[2] + right.z * 10], rect);
    const across = Math.hypot(r[0] - o[0], r[1] - o[1]);
    if (len < 1e-6) { ax = 0; ay = -1; len = 1e-6; }
    else { ax /= len; ay /= len; }
    len = Math.max(len, 0.5 * across);
    drag = { x: e.clientX, y: e.clientY, ax, ay, len, mm: 0, floor: liftFloor(), weights: reachWeights(), moved: false, pointerId: e.pointerId };
  }
  function moveDrag(e) {
    const d = drag;
    if (!d.moved) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return; d.moved = true; }
    /* screen motion on the stem's own direction, 1:1 in world millimetres */
    let mm = ((e.clientX - d.x) * d.ax + (e.clientY - d.y) * d.ay) * 10 / d.len;
    mm = Math.max(d.floor, mm);
    d.mm = mm;
    previewLift(mm, d.weights);
  }
  function endDrag() {
    const d = drag; drag = null; if (!d) return;
    view.set(cage.positions.subarray(0, T.nv * 3));
    if (d.moved && Math.abs(d.mm) > 1e-6) { writeLift(d.mm, d.weights); refreshView(); changed(); }
    else refreshView();
  }
  const onDown = (e) => {
    if (!enabled || e.button !== 0 || !cage) return;
    const hit = pick(e.clientX, e.clientY, false);
    if (!hit) { if (selection.size) clearSelection(); return; }
    claim(e);
    if (hit.kind === 'bead') { press = null; startDrag(e); return; }
    const already = isSelected(hit);
    if (!already) applySelection(hit);
    press = { hit, already };
    startDrag(e);
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopImmediatePropagation();
    moveDrag(e);
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopImmediatePropagation();
    const moved = drag.moved, p = press; press = null;
    endDrag();
    try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!moved && p && p.already) extend(p.hit);
  };
  dom.addEventListener('pointerdown', onDown, true);
  dom.addEventListener('pointermove', onMove, true);
  dom.addEventListener('pointerup', onUp, true);
  dom.addEventListener('pointercancel', onUp, true);

  /* ---- the controller ---- */
  function setCage(next, f) {
    if (f) setFields(f);
    if (drag) { drag = null; press = null; }
    const old = cage;
    cage = next && next.sheetCount > 0 && next.sheetFaces > 0 ? next : null;
    if (!cage) { T = null; view = null; faces = new Set(); edges = []; corner = -1; syncSelection(); wire.visible = false; drawSelection(); return; }
    T = sheetTopology(cage);
    view = Float32Array.from(cage.positions.subarray(0, T.nv * 3));
    if (old && old !== cage) remapSelection(old, cage); else syncSelection();
    rebuildSheet();
    drawSelection();
  }
  function setFields(f) {
    const n = V();
    relief = new Float32Array(n);
    if (f && f.relief) relief.set(f.relief.subarray(0, Math.min(n, f.relief.length)));
  }
  function enable(on) {
    enabled = !!on;
    group.visible = enabled;
    if (enabled && !cage && getCage) { const c = getCage(); if (c) setCage(c); }
    if (!enabled) { if (drag) { drag = null; press = null; if (cage) { view.set(cage.positions.subarray(0, T.nv * 3)); refreshView(); } } }
    drawSelection();
  }
  function dispose() {
    dom.removeEventListener('pointerdown', onDown, true);
    dom.removeEventListener('pointermove', onMove, true);
    dom.removeEventListener('pointerup', onUp, true);
    dom.removeEventListener('pointercancel', onUp, true);
    scene.remove(group);
    for (const o of [wire, faceHi, edgeHi, corners, grabbed, stem, cone, pickMesh]) { o.geometry.dispose(); o.material.dispose(); }
    dot.dispose();
    cage = null; T = null; view = null;
  }

  return {
    setCage, setFields, getFields: fields, enable, dispose,
    setCamera: (c) => { camera = c; },
    get enabled() { return enabled; },
    get cage() { return cage; },
    get selection() { return selection; },
    get faces() { return faces; },
    get edges() { return edges; },
    get reachMM() { return dials.reachMM; }, set reachMM(v) { dials.reachMM = Math.max(0, +v || 0); },
    get stepMM() { return dials.stepMM; }, set stepMM(v) { dials.stepMM = +v || 0; },
    lift, grow: () => grow(1), shrink: () => grow(-1), loop, smooth, clearSelection, clearEdits,
    snapshot: () => { fieldsReady(); return { relief: Float32Array.from(relief) }; },
    restore: (s) => { setFields(s); changed(); },
    /* the pick and the frame, for a gate */
    pickAt: (x, y) => pick(x, y, false),
    frame: () => frame,
    weights: reachWeights,
  };
}
