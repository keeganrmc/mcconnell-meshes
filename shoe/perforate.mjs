/* PERFORATIONS — round holes punched through a BUILT piece (broguing, vents, a breathing quarter).
 *
 * Why not Openings: Openings cut the coverage on the last's own grid, about 5 mm an edge on the US 12.5
 * fixture, so a strap is held at 12.4 mm and a 3 mm brogue hole cannot exist there. The built plate's outer
 * sheet runs about 1.2 mm an edge, so a hole is cut there instead, through both sheets, with a bore wall.
 *
 * A hole is a RECORD: a point on the last (a vertex) and a radius. It is laid out from the piece's region
 * (a field of holes, or a brogue row a set distance in from a rim) and re-punched after every rebuild; a
 * record whose patch the build moved under a rim, onto another hole, or off a disk is LEFT OUT and named,
 * never moved.
 *
 * The punch, per hole:
 *   1. a ray along the last's normal from just inside the last meets the inner sheet, then the outer;
 *   2. on each sheet, the faces of that sheet within r + 1.6 edges of the hit, connected to the hit face,
 *      make a patch; it must be a disk (one boundary loop), star-shaped about the hit in the hole's own
 *      plane, and clear of the hole by 15% of r;
 *   3. the patch is re-laid as a ring: its own boundary outside, a circle of K points at radius r inside
 *      (each lifted onto the patch, so the cut sits on the surface), zipped together by angle;
 *   4. the two circles (same angles, same frame) are joined by a bore wall of quads.
 * The result is closed and consistently wound when the input was; the gate checks that, and the volume.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Möller–Trumbore: t along the ray, or Infinity
function rayTri(o, d, a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det, s = sub(o, a), u = dot(s, p) * inv; if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const q = cross(s, e1), v = dot(d, q) * inv; if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const t = dot(e2, q) * inv; return t > 1e-9 ? t : Infinity;
}

/* The holes laid on the last. `region` is the piece's coverage on the last (>= 0.5 inside), `sd` its signed
 * distance to the rim in mm (negative inside, plate.mjs signedDistanceToContour), `P` the last's positions.
 *   kind 'field':  a dart throw over the region at `pitch`, kept `border` mm in from every rim;
 *   kind 'brogue': one row `offset` mm in from the rim, holes `pitch` apart along it.
 *   opt.mask:      a field per last vertex (a paint channel); holes only where it is >= 0.5 — pierce where painted.
 * Deterministic for a seed. Returns [{ v, r }]. */
export function layHoles(P, region, sd, opt = {}) {
  const V = P.length / 3, r = Math.max(0.3, opt.radius || 1.5), pitch = Math.max(2.2 * r, opt.pitch || 6);
  const kind = opt.kind || 'field', border = opt.border != null ? opt.border : 6, offset = opt.offset != null ? opt.offset : 8;
  let a = (opt.seed || 1) * 2654435761 >>> 0 || 1;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cand = [];
  for (let v = 0; v < V; v++) {
    if (!(region[v] >= 0.5)) continue;
    if (opt.mask && !(opt.mask[v] >= 0.5)) continue;
    const d = -sd[v];
    if (kind === 'brogue' ? Math.abs(d - offset) <= 0.75 * pitch / 2 + 1.5 : d >= border + r) cand.push(v);
  }
  // brogue: the band's vertices nearest the offset line first, so the row sits on it; field: a shuffle
  if (kind === 'brogue') cand.sort((p, q) => Math.abs(-sd[p] - offset) - Math.abs(-sd[q] - offset));
  else for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
  const cell = pitch, grid = new Map(), key = (x, y, z) => x + ',' + y + ',' + z, out = [];
  for (const v of cand) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let near = false;
    for (let i = -1; i <= 1 && !near; i++) for (let j = -1; j <= 1 && !near; j++) for (let k = -1; k <= 1 && !near; k++) {
      const l = grid.get(key(gx + i, gy + j, gz + k)); if (!l) continue;
      for (const w of l) if (Math.hypot(P[w * 3] - x, P[w * 3 + 1] - y, P[w * 3 + 2] - z) < pitch) { near = true; break; }
    }
    if (near) continue;
    const kk = key(gx, gy, gz); (grid.get(kk) || grid.set(kk, []).get(kk)).push(v);
    out.push({ v, r });
    if (out.length >= (opt.max || 600)) break;
  }
  return out;
}

/* Punch `holes` ([{ v, r }], v a last vertex) through a built plate.
 *   mesh:   { positions, indices, faceSheet, attrs } — triangles; faceSheet a label per triangle carried onto the
 *           faces that replace it; attrs { name: per-vertex array } carried too (a circle point takes its patch's)
 *   last:   { positions, normals } — where each hole stands and which way it goes
 * Returns { positions, indices, faceSheet, punched: [i…], skipped: [{ i, reason }] }. */
export function perforate(mesh, last, holes, opt = {}) {
  const P = Array.from(mesh.positions), I = Array.from(mesh.indices), S = mesh.faceSheet ? Array.from(mesh.faceSheet) : new Array(mesh.indices.length / 3).fill(0);
  const attrs = Object.fromEntries(Object.entries(mesh.attrs || {}).filter(([, a]) => a && a.length === mesh.positions.length / 3).map(([k, a]) => [k, Array.from(a)]));
  let attrFrom = 0;   // the vertex whose attributes a new point copies (set per patch)
  const alive = new Array(I.length / 3).fill(1);   // grows with every face a hole adds
  const isBore = new Array(I.length / 3).fill(0);   // 1 on a bore wall's triangles (the display splits their normals)
  const LP = last.positions, LN = last.normals;
  const pt = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const addV = (p) => { P.push(p[0], p[1], p[2]); for (const a of Object.values(attrs)) a.push(a[attrFrom]); return P.length / 3 - 1; };
  const addT = (a, b, c, s, bore) => { I.push(a, b, c); S.push(s); alive.push(1); isBore.push(bore ? 1 : 0); return I.length / 3 - 1; };
  // a coarse face grid, rebuilt lazily: new faces are appended to it as they are made
  let edge = 0; { let n = 0; for (let t = 0; t < I.length / 3 && n < 4000; t += 7) { edge += Math.hypot(...sub(pt(I[t * 3]), pt(I[t * 3 + 1]))); n++; } edge /= Math.max(1, n); }
  const cell = Math.max(2, edge * 4), grid = new Map(), gk = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const index = (t) => { const c = [0, 1, 2].map((k) => (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3); const k = gk(c[0], c[1], c[2]); (grid.get(k) || grid.set(k, []).get(k)).push(t); };
  for (let t = 0; t < I.length / 3; t++) index(t);
  const near = (p, R) => { const out = [], n = Math.ceil(R / cell); const [cx, cy, cz] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (let k = -n; k <= n; k++) { const l = grid.get(`${cx + i},${cy + j},${cz + k}`); if (l) for (const t of l) if (alive[t]) out.push(t); } return out; };
  const punched = [], skipped = [], cuts = [];
  const frameOf = (n) => { const a = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]; const t = norm(cross(n, a)); return [t, cross(n, t)]; };

  /* one sheet's cut: returns { ring: [vertex ids of the circle, by angle], remove: [faces], add: [[a,b,c]], sheet } or { reason } */
  const cutSheet = (H, face, n, t, b, r, K) => {
    // the plate's per-face sheet tag is not inner/outer (both sheets along one ray can carry the same tag), so
    // the patch is what is CONNECTED to the hit face within the radius: the two sheets meet only at the rim
    const sheet = S[face], R = r + 1.6 * edge;
    const inR = (v) => { const d = sub(pt(v), H); const x = dot(d, t), y = dot(d, b); return Math.hypot(x, y) <= R && Math.abs(dot(d, n)) < R; };
    const cands = new Set(near(H, R + edge).filter((f) => inR(I[f * 3]) && inR(I[f * 3 + 1]) && inR(I[f * 3 + 2])));
    if (!cands.has(face)) return { reason: 'the hole is on a face too large or too bent to cut' };
    // the patch: faces connected to the hit face through shared edges
    const ek = (a, c) => (a < c ? a + ':' + c : c + ':' + a), byEdge = new Map();
    for (const f of cands) for (let k = 0; k < 3; k++) { const e = ek(I[f * 3 + k], I[f * 3 + (k + 1) % 3]); (byEdge.get(e) || byEdge.set(e, []).get(e)).push(f); }
    const patch = new Set([face]), q = [face];
    while (q.length) { const f = q.pop(); for (let k = 0; k < 3; k++) for (const g of byEdge.get(ek(I[f * 3 + k], I[f * 3 + (k + 1) % 3])) || []) if (!patch.has(g)) { patch.add(g); q.push(g); } }
    // a wider pool, for growing the patch where its border notches
    const pool = new Set(near(H, R + 4 * edge).filter((f) => { const ok = (v) => { const d = sub(pt(v), H); return Math.hypot(dot(d, t), dot(d, b)) <= R + 3 * edge && Math.abs(dot(d, n)) < R; }; return ok(I[f * 3]) && ok(I[f * 3 + 1]) && ok(I[f * 3 + 2]); }));
    const byVert = new Map(); for (const f of pool) for (let k = 0; k < 3; k++) { const v = I[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
    const ang = (v) => { const d = sub(pt(v), H); return Math.atan2(dot(d, b), dot(d, t)); };
    const rad = (v) => { const d = sub(pt(v), H); return Math.hypot(dot(d, t), dot(d, b)); };
    // the boundary: directed edges used once, walked into loops; then, per pass, the vertices where the border
    // steps backwards in angle take their pool faces into the patch (a notch filled), at most four passes
    const boundary = () => {
      const use = new Map();
      for (const f of patch) for (let k = 0; k < 3; k++) { const e = ek(I[f * 3 + k], I[f * 3 + (k + 1) % 3]); use.set(e, (use.get(e) || 0) + 1); }
      const next = new Map();
      for (const f of patch) for (let k = 0; k < 3; k++) { const a = I[f * 3 + k], c = I[f * 3 + (k + 1) % 3]; if (use.get(ek(a, c)) === 1) { if (next.has(a)) return { reason: 'the patch around it pinches' }; next.set(a, c); } }
      const loops = [], seen = new Set();
      for (const s0 of next.keys()) { if (seen.has(s0)) continue; const L = []; let v = s0; while (!seen.has(v)) { seen.add(v); L.push(v); v = next.get(v); if (v === undefined) return { reason: 'the patch around it is open' }; } loops.push(L); }
      if (loops.length !== 1) return { reason: loops.length > 1 ? 'too close to another hole or an opening' : 'no patch' };
      const B = loops[0], A = B.map(ang);
      let turn = 0; const back = [];
      for (let i = 0; i < A.length; i++) { let d = A[(i + 1) % A.length] - A[i]; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; turn += d; if (d * Math.sign(turn || 1) <= 0) back.push(B[i], B[(i + 1) % B.length]); }
      return { B, turn, back };
    };
    let bnd = boundary();
    for (let pass = 0; pass < 4 && bnd.B; pass++) {
      const dir0 = bnd.turn > 0 ? 1 : -1, A = bnd.B.map(ang), back = [];
      for (let i = 0; i < A.length; i++) { let d = A[(i + 1) % A.length] - A[i]; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; if (d * dir0 <= 0) back.push(bnd.B[i], bnd.B[(i + 1) % A.length]); }
      if (!back.length) break;
      let grew = false; for (const v of back) for (const f of byVert.get(v) || []) if (!patch.has(f)) { patch.add(f); grew = true; }
      if (!grew) break;
      bnd = boundary();
    }
    if (!bnd.B) return { reason: bnd.reason };
    const B = bnd.B;
    let minR = Infinity; for (const v of B) minR = Math.min(minR, rad(v));
    if (minR < 1.15 * r) return { reason: 'too near a rim or another hole' };
    let turn = 0, mono = 0; const A = B.map(ang);
    for (let i = 0; i < A.length; i++) { let d = A[(i + 1) % A.length] - A[i]; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; turn += d; mono += d > 0 ? 1 : d < 0 ? -1 : 0; }
    const dir = turn > 0 ? 1 : -1;
    if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 0.3 || Math.abs(mono) !== A.length) return { reason: 'the patch is not star-shaped about the hole' };
    // which way the sheet's faces wind about n (outer and inner sheets face opposite ways)
    let wind = 0; for (const f of patch) { const [a, c, d] = [0, 1, 2].map((k) => pt(I[f * 3 + k])); wind += dot(cross(sub(c, a), sub(d, a)), n); }
    const wsgn = wind > 0 ? 1 : -1;
    // the circle, lifted onto the patch: each point onto the face whose projection holds it
    const ring = [];
    for (let k = 0; k < K; k++) {
      const th = 2 * Math.PI * k / K, x = r * Math.cos(th), y = r * Math.sin(th);
      let lifted = null;
      for (const f of patch) {
        const v3 = [0, 1, 2].map((m) => pt(I[f * 3 + m])), uv = v3.map((p) => { const d = sub(p, H); return [dot(d, t), dot(d, b)]; });
        const d0 = (uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[2][0] - uv[0][0]) * (uv[1][1] - uv[0][1]); if (Math.abs(d0) < 1e-14) continue;
        const l1 = ((x - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[2][0] - uv[0][0]) * (y - uv[0][1])) / d0, l2 = ((uv[1][0] - uv[0][0]) * (y - uv[0][1]) - (x - uv[0][0]) * (uv[1][1] - uv[0][1])) / d0;
        if (l1 >= -1e-6 && l2 >= -1e-6 && l1 + l2 <= 1 + 1e-6) { lifted = [0, 1, 2].map((m) => v3[0][m] + l1 * (v3[1][m] - v3[0][m]) + l2 * (v3[2][m] - v3[0][m])); break; }
      }
      if (!lifted) return { reason: 'the circle leaves the patch' };
      ring.push(lifted);
    }
    // the zipper, both loops running the same way by angle (counter-clockwise about n), starting at the angle nearest 0
    const Bc = dir > 0 ? B.slice() : B.slice().reverse();
    let s = 0; for (let i = 1; i < Bc.length; i++) if (((ang(Bc[i]) + 2 * Math.PI) % (2 * Math.PI)) < ((ang(Bc[s]) + 2 * Math.PI) % (2 * Math.PI))) s = i;
    const Bo = Bc.slice(s).concat(Bc.slice(0, s));
    attrFrom = B[0];
    const ringIds = ring.map((p) => addV(p));
    const unwrap = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const aB = Bo.map((v) => unwrap(ang(v))), aC = ringIds.map((_, k) => 2 * Math.PI * k / K);
    // every zipper triangle (boundary, circle, next) runs clockwise about n by construction; the sheet's own
    // winding decides once for the whole patch, so no sliver is oriented on its own (that left crossed edges)
    const add = []; let i = 0, k = 0;
    const tri = (a, c, d) => { add.push(wsgn > 0 ? [a, d, c] : [a, c, d]); };
    while (i < Bo.length || k < K) {
      const nb = i < Bo.length ? (i + 1 < Bo.length ? aB[i + 1] : aB[0] + 2 * Math.PI) : Infinity;
      const nc = k < K ? (k + 1 < K ? aC[k + 1] : 2 * Math.PI) : Infinity;
      const bi = Bo[i % Bo.length], ck = ringIds[k % K];
      if (nb <= nc) { tri(bi, ck, Bo[(i + 1) % Bo.length]); i++; } else { tri(bi, ck, ringIds[(k + 1) % K]); k++; }
    }
    return { ring: ringIds, remove: [...patch], add, sheet };
  };

  holes.forEach((h, hi) => {
    const L = [LP[h.v * 3], LP[h.v * 3 + 1], LP[h.v * 3 + 2]];
    let n = norm([LN[h.v * 3], LN[h.v * 3 + 1], LN[h.v * 3 + 2]]);
    const r = h.r, K = Math.max(12, Math.min(48, Math.ceil(2 * Math.PI * r / (0.45 * edge))));
    // the two sheets along the normal, from just inside the last. A last wound the other way has its normals
    // inward (the app's built last is, the saved fixture is not): the ray then finds nothing, and runs the other way
    const reach = 40, sheetsAlong = (dir) => {
      const o = [L[0] - dir[0], L[1] - dir[1], L[2] - dir[2]], hits = [];
      for (const f of near(L, reach)) { const tt = rayTri(o, dir, pt(I[f * 3]), pt(I[f * 3 + 1]), pt(I[f * 3 + 2])); if (tt < reach) hits.push([tt, f]); }
      hits.sort((p, q) => p[0] - q[0]);
      // the second sheet is at least a fraction of the wall beyond the first (opt.wallMM a number; the app's wall is a
      // per-vertex array, which once made this NaN and every hole 'not over the piece')
      const w = Number.isFinite(opt.wallMM) ? opt.wallMM : 1.8;
      const first = hits[0], second = first && hits.find(([tt]) => tt > first[0] + Math.min(0.2, 0.25 * w));
      return first && second ? { o, first, second } : null;
    };
    let along = sheetsAlong(n);
    if (!along) { const m = [-n[0], -n[1], -n[2]]; along = sheetsAlong(m); if (along) n = m; }
    if (!along) { skipped.push({ i: hi, reason: 'not over the piece' }); return; }
    const { o, first, second } = along;
    const Hin = [o[0] + n[0] * first[0], o[1] + n[1] * first[0], o[2] + n[2] * first[0]];
    const Hout = [o[0] + n[0] * second[0], o[1] + n[1] * second[0], o[2] + n[2] * second[0]];
    const [t, b] = frameOf(n);
    const P0 = P.length, I0 = I.length, S0 = S.length;
    const cin = cutSheet(Hin, first[1], n, t, b, r, K);
    const cout = cin.ring ? cutSheet(Hout, second[1], n, t, b, r, K) : null;
    if (!cin.ring || !cout || !cout.ring) { P.length = P0; for (const a of Object.values(attrs)) a.length = P0 / 3; I.length = I0; S.length = S0; alive.length = I0 / 3; isBore.length = I0 / 3; skipped.push({ i: hi, reason: (cin.reason || cout.reason) }); return; }
    // the patches' removals must not overlap (a thin wall's two patches never share faces; a guard all the same)
    for (const f of cin.remove) alive[f] = 0; for (const f of cout.remove) alive[f] = 0;
    const startT = I.length / 3;
    for (const c of [cin, cout]) for (const [a, d, e] of c.add) addT(a, d, e, c.sheet);
    // the bore: quads between the circles, wound against the inner ring's own edges so every edge is used once
    // each way (a ring edge the inner patch runs a→c, the bore runs c→a)
    const inDir = new Set(); for (const [x, y, z] of cin.add) { inDir.add(x + '>' + y); inDir.add(y + '>' + z); inDir.add(z + '>' + x); }
    const forward = inDir.has(cin.ring[0] + '>' + cin.ring[1 % K]);
    for (let k = 0; k < K; k++) {
      const a = cin.ring[k], c = cin.ring[(k + 1) % K], d = cout.ring[(k + 1) % K], e = cout.ring[k];
      if (forward) { addT(c, a, e, S[first[1]], 1); addT(c, e, d, S[first[1]], 1); } else { addT(a, c, d, S[first[1]], 1); addT(a, d, e, S[first[1]], 1); }
    }
    for (let f = startT; f < I.length / 3; f++) index(f);
    punched.push(hi);
    // the hole as a cutter for the exports that cannot carry it (a SuperB is the unpunched piece): its axis from
    // where it meets the inner sheet to where it leaves the outer, and its radius
    cuts.push({ i: hi, inner: Hin, outer: Hout, n, r });
  });
  // drop the removed faces and the vertices nothing uses
  const keepT = []; for (let t = 0; t < I.length / 3; t++) if (alive[t]) keepT.push(t);
  // survivors keep their order (a cage vertex i stays ahead of every vertex after it) and `from` names each one's
  // index before the cut, so the cage's per-vertex maps (cage.srcOf over [0, sheetCount)) still find their vertex
  const used = new Int32Array(P.length / 3).fill(-1); let nv = 0;
  for (const t of keepT) for (let k = 0; k < 3; k++) used[I[t * 3 + k]] = 1;
  const from = []; for (let v = 0; v < used.length; v++) if (used[v] > 0) { used[v] = nv++; from.push(v); }
  const positions = new Float32Array(nv * 3); for (let v = 0; v < used.length; v++) if (used[v] >= 0) { positions[used[v] * 3] = P[v * 3]; positions[used[v] * 3 + 1] = P[v * 3 + 1]; positions[used[v] * 3 + 2] = P[v * 3 + 2]; }
  const indices = new Uint32Array(keepT.length * 3), faceSheet = new Float32Array(keepT.length), bore = new Uint8Array(keepT.length);
  keepT.forEach((t, j) => { for (let k = 0; k < 3; k++) indices[j * 3 + k] = used[I[t * 3 + k]]; faceSheet[j] = S[t]; bore[j] = isBore[t]; });
  const attrsOut = {};
  for (const [k, a] of Object.entries(attrs)) { const src = mesh.attrs[k], o = new src.constructor(nv); for (let v = 0; v < used.length; v++) if (used[v] >= 0) o[used[v]] = a[v]; attrsOut[k] = o; }
  return { positions, indices, faceSheet, bore, attrs: attrsOut, from: Int32Array.from(from), punched, skipped, cuts, edgeMM: edge };
}
