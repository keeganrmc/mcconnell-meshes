/* THE MASK AS A LIMIT SURFACE.
 *
 * `shell.js` clips the head's triangles at the coverage isoline and offsets
 * each vertex. That construction's smoothness ceiling IS the triangulation it
 * cut from — measured on one painted mask, triangles touching a clip crossing
 * turn 11x more than whole ones (24.3 deg median against 2.2) and are 4.7x
 * larger. No amount of fairing raises that ceiling, and five attempts to raise
 * it are recorded in the handoff.
 *
 * This builds the mask the other way: select whole QUADS, relax the outline
 * tangentially, snap it back onto the contour, offset it, roll a rim, and
 * subdivide the result. Same head, same paint, same fixture:
 *
 *     shell.js                      22,620 faces   p90 30.57 deg   13.1% over 20
 *     plate cage                    22,426         p90 23.26        11.1%
 *     plate + 1 Catmull-Clark       89,704         p90 10.13         4.7%
 *     plate + 2 Catmull-Clark      358,816         p90  4.82         0.5%
 *
 * The head those sit on measures p90 7.69, so one level matches the form and
 * two is smoother than it.
 *
 * ⚠ THE CONSTRUCTION IS PGON'S AND THE WALL IS MASQ'S, AND IT NEEDS BOTH.
 * Pgon's plate carries one thickness for the whole plate, so it must be set for
 * the worst hollow on the face: 556 folded faces at a constant 2 mm on this
 * head. MASQ clamps the wall per vertex against k_min and folds 18 with its own
 * shell. Pgon's construction reading MASQ's per-vertex wall folds ZERO — better
 * than either alone, which is the only reason this is worth the vendoring.
 *
 * ⚠ UNITS. MASQ's F.gap and F.thickness are MILLIMETRES; the lift works in the
 * mesh's own units, which here are METRES. The conversion happens once, in
 * `fieldsFor`, and nowhere else. This project has paid for a unit inversion.
 */
import { buildLift } from './lift/lift/lift.v00000-001.js';
import { buildTopology, subdivideCatmullClark, liftFieldToSubdivided } from './lift/meshkernel/meshkernel.v00000-002.js';

const MM = 0.001;

/* ⚠ TWO LEVELS, AND THE THIRD IS NOT WORTH ITS MEMORY. Each level quadruples
 * the face count; the second takes p90 from 10.13 to 4.82 and the head itself
 * is 7.69, so the surface is already past the form it sits on. A third would be
 * 1.4 million faces to chase a number nobody can see. */
export const PLATE_LEVELS = 2;

/* Per-SOURCE-vertex wall and gap in the mesh's units, plus the scalar the
 * topology needs. The scalar is the MEDIAN over the covered region rather than
 * the slider: the rim's row count has to be one number for the whole plate, and
 * the median is the gauge most of the rim actually has. */
export function fieldsFor(coverage, gap, thickness, threshold = 0.5) {
  const n = coverage.length;
  const thicknessAt = new Float32Array(n), offsetAt = new Float32Array(n);
  const covered = [];
  for (let i = 0; i < n; i++) {
    thicknessAt[i] = thickness[i] * MM;
    offsetAt[i] = gap[i] * MM;
    if (coverage[i] >= threshold) covered.push(thickness[i]);
  }
  covered.sort((a, b) => a - b);
  const medianMM = covered.length ? covered[covered.length >> 1] : 0;
  return { thicknessAt, offsetAt, medianThickness: medianMM * MM };
}

/**
 * mesh: { positions, quads, normals, mask }  — MASQ's subdivided head
 * fields: { gap, thickness } in MILLIMETRES, one per source vertex
 * Returns { ok, positions, quads, indices, stats } or { ok:false, reason, message }.
 */
export function buildPlate(mesh, fields, opts = {}) {
  const f = fieldsFor(mesh.mask, fields.gap, fields.thickness, opts.threshold);
  /* ⚠ A MASK WITH NOTHING IN IT IS NOT AN ERROR HERE. buildLift refuses it with
   * a sentence meant for a person; that sentence is the caller's to show or to
   * swallow, so it is passed through rather than turned into a throw. */
  const out = buildLift(mesh, {
    thickness: f.medianThickness,
    offset: opts.offset != null ? opts.offset : 0,
    thicknessAt: f.thicknessAt,
    offsetAt: f.offsetAt,
    rim: opts.rim != null ? opts.rim : 0.5,
    border: opts.border != null ? opts.border : 0.5,
    margin: opts.margin || 0,
    /* 32, not Pgon's 8. It smooths the offset DIRECTION and never its amount,
     * and on this mesh it is worth folds: 647 at 8, 556 at 32, 439 at 64.
     * Measured cost, asked a 1.0 mm gap point-to-triangle against the source:
     * 0.977 mm at 8 and 0.967 at 32, never further. */
    directionSmooth: opts.directionSmooth != null ? opts.directionSmooth : 32,
    adjacency: opts.adjacency,
  });
  if (!out.ok) return out;
  let positions = out.positions, quads = out.quads;

  /* ⚠⚠ A PASSENGER RIDES THE LADDER, IT IS NOT LOOKED UP AGAIN.
   * MASQ stains the mask by what moves underneath it, so the motion map has to
   * reach every vertex of a plate whose vertices are not the head's. The
   * geometric answer — nearest head vertex per plate vertex — measured 669 ms
   * at two levels, and the meshkernel's own note prices it at 4.6 SECONDS on a
   * bigger mesh. The structural answer is free: seed the passenger on the CAGE
   * through `srcOf`, then carry it up with the same face/edge averaging the
   * subdivision itself uses. Exact, O(nv+nf+ne), no search. */
  const seed = (field) => {
    if (!field || !out.srcOf) return null;
    const r = new Float32Array(out.srcOf.length);
    for (let i = 0; i < out.srcOf.length; i++) { const sv = out.srcOf[i]; r[i] = sv >= 0 ? field[sv] : 0; }
    return r;
  };
  let rider = seed(opts.extra);
  /* two more passengers, carried the same way (the colours' tint) */
  let rider2 = seed(opts.extra2), rider3 = seed(opts.extra3);

  const levels = opts.levels != null ? opts.levels : PLATE_LEVELS;
  let reached = 0;
  for (let i = 0; i < levels; i++) {
    /* ⚠ buildTopology THROWS ON ANYTHING BUT A CLOSED MANIFOLD, which is a
     * useful refusal and a bad crash. A plate that cannot be subdivided is
     * still a plate; hand back the cage and say which level it reached. */
    try {
      const nv = positions.length / 3;
      const topo = buildTopology(quads, nv);
      const sub = subdivideCatmullClark(positions, quads, topo);
      if (!sub || !sub.positions || !sub.quads) break;
      /* ⚠ BEFORE quads IS REASSIGNED. liftFieldToSubdivided reads the PARENT's
       * faces and edges; handing it the child's would index past the field. */
      if (rider) rider = liftFieldToSubdivided(rider, quads, topo, nv);
      if (rider2) rider2 = liftFieldToSubdivided(rider2, quads, topo, nv);
      if (rider3) rider3 = liftFieldToSubdivided(rider3, quads, topo, nv);
      positions = sub.positions; quads = sub.quads;
      reached++;
    } catch (_) { break; }
  }

  return {
    ok: true,
    positions,
    quads,
    indices: quadsToTriangles(quads),
    extra: rider,
    extra2: rider2, extra3: rider3,
    stats: { ...out.stats, levels: reached, askedLevels: levels,
             cageFaces: out.quads.length / 4, faces: quads.length / 4 },
  };
}

/* ⚠ THE DIAGONAL IS THE SAME ONE EVERY TIME, and it has to be: two triangles
 * built from one quad by different diagonals do not share an edge, and the
 * renderer's vertex normals then crease along a line nothing in the geometry
 * put there. */
export function quadsToTriangles(quads) {
  const nf = quads.length / 4;
  const idx = new Uint32Array(nf * 6);
  for (let f = 0; f < nf; f++) {
    const a = quads[f * 4], b = quads[f * 4 + 1], c = quads[f * 4 + 2], d = quads[f * 4 + 3];
    idx[f * 6] = a; idx[f * 6 + 1] = b; idx[f * 6 + 2] = c;
    idx[f * 6 + 3] = a; idx[f * 6 + 4] = c; idx[f * 6 + 5] = d;
  }
  return idx;
}

/* Mean dihedral across shared quad edges, in degrees — the measure every
 * comparison in this file's header was made with. Exported because a gate that
 * computes its own version of the number is a second definition of smooth. */
export function dihedralStats(positions, quads) {
  const nf = quads.length / 4;
  const nrm = (f) => {
    const a = quads[f * 4] * 3, b = quads[f * 4 + 1] * 3, c = quads[f * 4 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    return [nx / L, ny / L, nz / L];
  };
  const key = new Map();
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 4; e++) {
      const a = quads[f * 4 + e], b = quads[f * 4 + (e + 1) % 4];
      const k = (a < b ? a : b) * 8388608 + (a < b ? b : a);
      let l = key.get(k); if (!l) { l = []; key.set(k, l); }
      l.push(f);
    }
  }
  const d = [];
  for (const fs of key.values()) {
    if (fs.length !== 2) continue;
    const n1 = nrm(fs[0]), n2 = nrm(fs[1]);
    let x = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    x = x < -1 ? -1 : x > 1 ? 1 : x;
    d.push(Math.acos(x) * 180 / Math.PI);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  let over = 0; for (const v of d) if (v > 20) over++;
  return {
    edges: d.length,
    median: d[d.length >> 1],
    p90: d[Math.floor(d.length * 0.9)],
    max: d[d.length - 1],
    over20: over / d.length,
  };
}
