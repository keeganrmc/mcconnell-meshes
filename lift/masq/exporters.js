/* MASQ — export. The shell, a sidecar, and two optional companions.
 *
 * WHAT EACH ONE IS FOR. The shell is the printable thing and is never
 * optional. The PATCH is the primitive a student takes to Rhino to do offset,
 * cap, fillet and boolean by hand, which is the assignment — so it is the
 * painted territory ON THE FACE, no gap, no thickness, no walls. The HEAD goes
 * with it because a mask has to be planned against the face it sits on, and
 * they will want that face beside their own scan to see the offset they
 * started from.
 *
 * TWO FRAMES, AND THE ARCHIVE HAS TO SAY WHICH IS WHICH. The OBJs are Z-UP,
 * stood up from GNM's Y-up design frame (standUp: x, −z, y) like the .3dm and
 * the .blend, so the head, scan, patch and masks land on one another. The STL alone is moved to
 * the PRINT frame — dome up, opening down, dropped onto z = 0 — because that
 * is a build plate and not a scene. buildSidecar writes the transform between
 * them, so the shell can be put back on the face in Rhino.
 *
 * UNITS. Everything inside the app is meters. Everything exported is
 * MILLIMETERS, because that is what a slicer and Rhino both expect and a
 * 0.34-unit head imports as dust. The conversion happens once, here.
 */

const MM = 1000;

/* ---------------------------------------------------------------- OBJ ------
 * OBJ takes arbitrary polygons, which is why the head and the patch use it and
 * why they are not the same kind of mesh.
 *
 * THE HEAD IS QUADS, GNM's OWN 17,662. That answers the spec's open question
 * with the data rather than a preference — the model is natively a quad mesh,
 * and Rhino's QuadRemesh, SubDFromMesh, offset and fillet all behave better on
 * the authored cage than on anything derived from it.
 *
 * THE PATCH IS TRIANGLES, AND CANNOT BE ANYTHING ELSE. Its boundary is the
 * coverage isoline, cut by marching triangles, so the faces along the rim are
 * clipped fragments of quads with three, four or five corners in no consistent
 * winding. Emitting the interior as quads and the rim as fragments would give
 * Rhino a mesh with two topologies in one object, which is worse for every
 * operation than a clean triangulation. The isoline is worth more than the
 * quads: a vertex-snapped boundary staircases at the 3.37 mm median edge.
 */
export function buildOBJ(positions, faces, name = 'masq', normals = null, colors = null) {
  const out = [];
  out.push('# ' + name + ' — MASQ. Units: millimeters.');
  if (colors) out.push('# Vertex colors: "v x y z r g b". Rhino and MeshLab read them; a');
  if (colors) out.push('# reader that does not simply stops after z.');
  out.push('o ' + name);
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    let v = 'v ' + (positions[i*3] * MM).toFixed(4) + ' ' +
                   (positions[i*3+1] * MM).toFixed(4) + ' ' +
                   (positions[i*3+2] * MM).toFixed(4);
    if (colors) v += ' ' + colors[i*3].toFixed(4) + ' ' + colors[i*3+1].toFixed(4) + ' ' + colors[i*3+2].toFixed(4);
    out.push(v);
  }
  if (normals) {
    for (let i = 0; i < n; i++) {
      out.push('vn ' + normals[i*3].toFixed(5) + ' ' + normals[i*3+1].toFixed(5) + ' ' + normals[i*3+2].toFixed(5));
    }
  }
  for (const f of faces) {
    let s = 'f';
    for (const v of f) s += normals ? ` ${v + 1}//${v + 1}` : ` ${v + 1}`;
    out.push(s);
  }
  return out.join('\n') + '\n';
}

/* ---------------------------------------------------------------- STL ------
 * Binary, because an ASCII STL of a 140k-triangle shell is ~30 MB of text and
 * every slicer reads binary. The 80-byte header is not a comment field in any
 * spec-compliant reader, so provenance goes in the sidecar, not here.
 */
export function buildSTL(positions, tris) {
  const n = tris.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  /* ASCII only. The header is 80 raw BYTES, so a multi-byte character written
   * through charCodeAt is truncated and lands as a stray glyph in every
   * slicer that shows it. */
  const header = 'MASQ binary STL - millimeters - see masq-README.txt beside this file';
  for (let i = 0; i < 80; i++) {
    const c = i < header.length ? header.charCodeAt(i) : 32;
    dv.setUint8(i, c < 128 ? c : 63);
  }
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = tris[t*3] * 3, b = tris[t*3+1] * 3, c = tris[t*3+2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b+1] - positions[a+1], uz = positions[b+2] - positions[a+2];
    const vx = positions[c] - positions[a], vy = positions[c+1] - positions[a+1], vz = positions[c+2] - positions[a+2];
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    dv.setFloat32(o, nx, true); dv.setFloat32(o+4, ny, true); dv.setFloat32(o+8, nz, true); o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, positions[i] * MM, true);
      dv.setFloat32(o+4, positions[i+1] * MM, true);
      dv.setFloat32(o+8, positions[i+2] * MM, true);
      o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------ ORIENT -------
 * Auto-orientation on the build plate, per MyFaceMask's precedent.
 *
 * A mask is a dish. Printed as designed — standing up, facing the viewer — it
 * is a tall overhanging shell needing support over its whole inner surface.
 * Laid with its opening DOWN it is self-supporting almost everywhere, which is
 * how a mask is printed in practice.
 *
 * So the rotation takes the mask's outward direction to -Z (dome up, opening
 * down), and the model is then dropped so its lowest point sits on z = 0.
 * Returns a NEW array; the app's own positions are never rotated, because
 * the viewport is not a build plate.
 *
 * The outward direction is `up` when given — the app passes the mean of the
 * HEAD's normals under the mask, one sheet — else the mean of the mesh's own
 * normals. On a closed shell that mean is the difference of two sheets:
 * measured on a full-face export, (0, 0, -0.032), 11,740 vertices facing up
 * against 12,932 down, and a puff or a rim wall moves it.
 */
export function orientForPrint(positions, normals, up = null, turn = null) {
  let mx = 0, my = 0, mz = 0;
  const n = positions.length / 3;
  if (up && up.length === 3 && Math.hypot(up[0], up[1], up[2]) > 1e-9) { mx = up[0]; my = up[1]; mz = up[2]; }
  else for (let i = 0; i < n; i++) { mx += normals[i*3]; my += normals[i*3+1]; mz += normals[i*3+2]; }
  let L = Math.hypot(mx, my, mz);
  if (L < 1e-9) return { positions: Float32Array.from(positions), rotated: false, matrix: [1,0,0,0,1,0,0,0,1], offset: [0,0,0] };
  mx /= L; my /= L; mz /= L;

  // rotation taking the mean normal to (0,0,-1)
  const tx = 0, ty = 0, tz = -1;
  let ax = my*tz - mz*ty, ay = mz*tx - mx*tz, az = mx*ty - my*tx;
  const s = Math.hypot(ax, ay, az), c = mx*tx + my*ty + mz*tz;
  const out = new Float32Array(positions.length);
  /* The rotation is returned as well as applied, because NORMALS have to be
   * rotated by it and must NOT be centerd or dropped by it — running a
   * direction vector through the whole transform zeroes it. */
  let M;
  if (s < 1e-9) {
    const k = c > 0 ? 1 : -1;
    M = [1, 0, 0, 0, k, 0, 0, 0, k];
    for (let i = 0; i < n; i++) {
      out[i*3] = positions[i*3]; out[i*3+1] = positions[i*3+1] * k; out[i*3+2] = positions[i*3+2] * k;
    }
  } else {
    ax /= s; ay /= s; az /= s;
    const ang = Math.atan2(s, c), C = Math.cos(ang), S = Math.sin(ang), t = 1 - C;
    const m = [
      t*ax*ax + C,    t*ax*ay - S*az, t*ax*az + S*ay,
      t*ax*ay + S*az, t*ay*ay + C,    t*ay*az - S*ax,
      t*ax*az - S*ay, t*ay*az + S*ax, t*az*az + C,
    ];
    M = m;
    for (let i = 0; i < n; i++) {
      const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
      out[i*3]   = m[0]*x + m[1]*y + m[2]*z;
      out[i*3+1] = m[3]*x + m[4]*y + m[5]*z;
      out[i*3+2] = m[6]*x + m[7]*y + m[8]*z;
    }
  }
  /* the student's orientation on top of the dome-up frame: a tilt about x
   * then a lean about y (src/print/mesh.js tiltLean), so Tilt 0 / Lean 0 is
   * the frame above and the STL stands as the Print mode showed it */
  if (turn && (turn.tiltDeg || turn.leanDeg)) {
    const rt = (turn.tiltDeg || 0) * Math.PI / 180, rl = (turn.leanDeg || 0) * Math.PI / 180;
    const ct = Math.cos(rt), st = Math.sin(rt), cl = Math.cos(rl), sl = Math.sin(rl);
    const R = [cl, sl*st, sl*ct, 0, ct, -st, -sl, cl*st, cl*ct];
    for (let i = 0; i < n; i++) {
      const x = out[i*3], y = out[i*3+1], z = out[i*3+2];
      out[i*3]   = R[0]*x + R[1]*y + R[2]*z;
      out[i*3+1] = R[3]*x + R[4]*y + R[5]*z;
      out[i*3+2] = R[6]*x + R[7]*y + R[8]*z;
    }
    const A = M, P = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P[r*3+c] = R[r*3]*A[c] + R[r*3+1]*A[3+c] + R[r*3+2]*A[6+c];
    M = P;
  }
  let minZ = Infinity, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { if (out[i*3+2] < minZ) minZ = out[i*3+2]; cx += out[i*3]; cy += out[i*3+1]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) { out[i*3] -= cx; out[i*3+1] -= cy; out[i*3+2] -= minZ; }
  /* The offset is RETURNED, not only applied. Without it the rotation alone
   * cannot put the shell back on the face, and a print-frame STL beside a
   * design-frame head is two objects a meter apart in Rhino. */
  return { positions: out, rotated: true, matrix: M, offset: [cx, cy, minZ] };
}

/* ------------------------------------------------------------ SHELLS -------
 * Keep the mask and drop the crumbs.
 *
 * A level set of a field sampled on a grid produces detached specks wherever
 * the solid pinches thinner than a cell — on this head that is the coverage
 * rim as it crosses the lips. Measured on a full-face mask at 1 mm cells:
 * 21 components, of which one is 99.89% of the mesh and the other twenty are
 * 0.108% between them, none more than 5.7 mm across and most under one.
 *
 * They are not a defect in the mesher; they are the truth about a solid that
 * is locally thinner than the sample spacing. They are also not printable:
 * a slicer turns a 0.1 mm island into a stray blob or silently drops it.
 *
 * THE COUNT IS RETURNED, NOT SWALLOWED. "Removed 20 fragments, 0.108% of the
 * surface" is a fact about the object in the box; a cleanup that reports
 * nothing is how a mask that fell into three pieces ships as one.
 */
export function keepLargestShell(positions, indices) {
  const n = positions.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let t = 0; t < indices.length; t += 3) { union(indices[t], indices[t+1]); union(indices[t+1], indices[t+2]); }

  const size = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
  let best = -1, bestN = -1;
  for (const [r, c] of size) if (c > bestN) { bestN = c; best = r; }
  if (best < 0) return { positions: new Float32Array(0), indices: new Uint32Array(0), components: 0, removed: 0, removedFraction: 0 };

  const remap = new Int32Array(n).fill(-1);
  const keptPos = [];
  for (let i = 0; i < n; i++) {
    if (find(i) !== best) continue;
    remap[i] = keptPos.length / 3;
    keptPos.push(positions[i*3], positions[i*3+1], positions[i*3+2]);
  }
  const keptIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (remap[indices[t]] < 0) continue;                 // a whole triangle or none
    keptIdx.push(remap[indices[t]], remap[indices[t+1]], remap[indices[t+2]]);
  }
  return {
    positions: Float32Array.from(keptPos),
    indices: Uint32Array.from(keptIdx),
    components: size.size,
    removed: size.size - 1,
    removedFraction: n ? (n - bestN) / n : 0,
  };
}

/* Rotate directions by an orientForPrint matrix. Separate from the positions
 * path on purpose: no centring, no drop, and re-normalized. */
export function rotateNormals(normals, M) {
  const out = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i+1], z = normals[i+2];
    let a = M[0]*x + M[1]*y + M[2]*z, b = M[3]*x + M[4]*y + M[5]*z, c = M[6]*x + M[7]*y + M[8]*z;
    const L = Math.hypot(a, b, c) || 1;
    out[i] = a / L; out[i+1] = b / L; out[i+2] = c / L;
  }
  return out;
}

/* ------------------------------------------------------------ SIDECAR ------
 * The spec cites EXPORT-SIDECAR-SPEC_v00000-001, which does not exist on disk
 * anywhere in the suite, so this defines it: everything needed to reproduce
 * the export, including the GNM identity coefficients, so the head itself is
 * reconstructable from the sidecar alone rather than only from the save file.
 */
export function buildSidecar(info) {
  const L = [];
  const row = (k, v) => L.push(k.padEnd(22) + v);
  L.push('MASQ export');
  L.push('='.repeat(64));
  L.push('');
  L.push('Every mesh in this archive is in MILLIMETERS.');
  L.push('');
  if (info.name) row('mask', info.name);
  row('app version', info.version);
  row('exported', info.date);
  /* ⚠ THE SIZE THE HEAD WAS AT, OR THE MESHES ARE UNITLESS. A student who
   * typed a caliper reading has a mask for a real face and nothing else in the
   * archive would say so; one who did not has GNM's own head, which is a
   * particular size and not a standard. */
  if (info.scaleK !== undefined) {
    row('head size', info.scaleMM > 0
      ? `${info.scaleMM} mm across ${String(info.scaleFrom).toLowerCase()}  (x${info.scaleK.toFixed(4)} of the model)`
      : 'as GNM models it (no caliper reading given)');
  }
  if (info.rimMM !== undefined) {
    row('rim', info.rimMM > 0
      ? `drawn to a ${info.rimMM} mm radius, clamped to half the local wall`
      : 'cut square, no bead');
  }
  if (info.measures && info.measures.length) {
    L.push('');
    L.push('THE FACE THIS MASK WAS MADE ON');
    for (const m of info.measures) L.push('  ' + (m.label + ' (' + m.landmark + ')').padEnd(30) + m.mm.toFixed(1) + ' mm');
  }
  if (info.terrains && info.terrains.length) {
    L.push('');
    L.push('TERRAIN — real ground laid over the mask as its pattern');
    for (const t of info.terrains) L.push('  ' + t.who.padEnd(12) + `${t.label} (${t.region}), ${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}; ${t.spanKM} km across the mask's circle (zoom ${t.zoom}×), rotation ${t.rotationDeg}°, ${t.depthMM} mm at the highest ground, curve ${t.curve}`);
  }
  L.push('');
  L.push('FILES');
  for (const f of info.files) L.push('  ' + f.name.padEnd(24) + f.note);
  L.push('');
  L.push('FRAMES — READ THIS BEFORE YOU IMPORT');
  L.push('  The OBJ files share ONE frame and the STL does not.');
  L.push('');
  L.push('    masq-patch.obj / masq-head.obj   Z-UP, millimeters, like every OBJ here,');
  L.push('                                     the .3dm and the .blend. The patch lies on');
  L.push('                                     the head; import both, the mask is on the face.');
  L.push('    masq-superb-clearance.obj        Z-UP, millimeters: the mask as an');
  L.push('                                     all-quad SubD cage OFF the skin by the gap,');
  L.push('                                     never inside the head. What the app shows.');
  L.push('    masq-superb-solid.obj            The same, thickened OUTWARD from that sheet');
  L.push('                                     into a closed all-quad cage: inner sheet,');
  L.push('                                     outer sheet, a rim wall. An OBJ carries no');
  L.push('                                     crease; the .unreason and .3dm do.');
  L.push('    masq-superb-skin.obj             The one sheet ON the skin — OffsetSubD\'s');
  L.push('                                     input. Lands on masq-patch.obj.');
  L.push('    masq-superb-*.unreason           Each cage as an Unreason3D document, stood');
  L.push('                                     up in its Z-up frame: Open it there and it');
  L.push('                                     is an editable SuperB.');
  L.push('    masq-rhino.3dm                   EVERYTHING, Z-up like the .unreason (the');
  L.push('                                     front view sees the face), millimeters, a');
  L.push('                                     layer each: the scan, the head, the mask\'s');
  L.push('                                     edge curves, the MeshMask as shown, and the');
  L.push('                                     SuperB as a SubD when one is made. Rim');
  L.push('                                     creases are SubD creases; a softened rim is');
  L.push('                                     edge sharpness (0-3). Open it and it is all');
  L.push('                                     in place.');
  L.push('    masq-scan.obj                    Z-UP, like every OBJ: the scan lands on the');
  L.push('                                     head and the SubD as imported.');
  L.push('    masq-shell.stl                   PRINT frame. Rotated dome-up, opening');
  L.push('                                     down, centered in x and y, dropped to');
  L.push('                                     sit on z = 0.');
  L.push('');
  if (info.printMatrix) {
    const M = info.printMatrix, T = info.printOffset;
    L.push('  The export applied  p_stl = M p_obj - offset,  M row-major, p_obj in');
    L.push('  the OBJs\' Z-up frame. To put it back on the face:  p_obj = transpose(M) (p_stl');
    L.push('  + offset) — add the offset FIRST, then rotate. M is orthonormal, so');
    L.push('  the transpose is the inverse.');
    for (let r = 0; r < 3; r++) {
      L.push('    ' + [0,1,2].map((c) => M[r*3+c].toFixed(6).padStart(10)).join(' '));
    }
    L.push('    offset (mm)  ' + T.map((x) => x.toFixed(3).padStart(10)).join(' '));
    L.push('');
  }
  L.push('  The OBJs are already Z-up: import them with Rhino\'s and Blender\'s');
  L.push('  defaults, no Y-to-Z mapping. OBJ carries no units; these are millimeters,');
  L.push('  so tell the importer mm (Blender reads OBJ numbers as meters: scale 0.001).');
  L.push('');
  L.push('MASK');
  row('gap (nominal)', info.gapMM.toFixed(2) + ' mm');
  row('thickness (slider)', info.thickMM.toFixed(2) + ' mm');
  if (info.wallMinMM !== undefined) {
    /* The slider is what was ASKED for. The fold guard thins the wall wherever
     * the face turns tighter than the offset, so the shell that shipped is
     * thinner than the slider over an unknown fraction of itself, and a
     * sidecar reporting only the slider misstates the object in the box. */
    row('wall AS BUILT', info.wallMinMM.toFixed(2) + ' – ' + info.wallMaxMM.toFixed(2) + ' mm');
  }
  row('minimum wall (floor)', info.wallMM.toFixed(2) + ' mm');
  if (info.light) row('light edges', `+${info.light.mm.toFixed(1)} mm in shadow, hardness ${info.light.hard}%, from (${info.light.x.toFixed(2)}, ${info.light.y.toFixed(2)})`);
  if (info.puff) {
    /* the pillow as built: its height per piece (capped at twice the piece's
     * depth), and how much of it the fold guard held */
    row('puff', `${info.puff.mm.toFixed(1)} mm asked, profile ${info.puff.profile}%; built ` + info.puff.pieces.map((pc) => `${pc.heightMM.toFixed(1)} mm over a piece ${pc.dmaxMM.toFixed(0)} mm deep` + (pc.capped ? ' (capped)' : '')).join(', ') + (info.puff.covered ? `; the fold guard held it on ${Math.round(100 * info.puff.held / info.puff.covered)}% of the mask` : ''));
  }
  row('coverage threshold', info.threshold.toFixed(2));
  row('symmetry', info.symmetry ? 'on' : 'off');
  row('covered vertices', String(info.covered));
  row('inverted faces', String(info.inverted));
  if (info.inverted > 0) {
    L.push('');
    L.push('  ⚠ This shell contains ' + info.inverted + ' inverted faces — places where the');
    L.push('    outward offset folded through itself. They are usually the eyelid');
    L.push('    creases, the alar creases and the lip corners, where the surface');
    /* ⚠ THE ADVICE WAS BACKWARDS, AND IT SHIPPED IN EVERY ARCHIVE WHOSE SHELL
     * HAS A FOLD, WHICH IS MOST OF THEM. An outward offset takes a convex
     * radius r to r+d and a CONCAVE radius to r-d, so more clearance in a
     * crease is more folding. That is the whole reason the Hollow tightening
     * control exists, and the app's own README states it with the measurement:
     * 2,607 inverted uniform against 1,857 with 3 mm of tightening. */
    L.push('    curves tighter than the offset distance. TIGHTENING the gap in');
    L.push('    those hollows clears them, or thinning the wall there: an outward');
    L.push('    offset shrinks a concave radius, so more clearance in a crease is');
    L.push('    more folding, not less.');
    L.push('    NOTE the detector is blind to doubly curved pits — a nostril or a');
    L.push('    dimple tighter than the offset in EVERY direction is not counted.');
    L.push('');
    /* ⚠ AND WHETHER THE STL CARRIES THE FOLD DEPENDS ON THE EXPORT. This said
     * "the STL is this mesh, folds and all" unconditionally, and forty lines
     * below the PRINT section says the opposite — the default is a level set,
     * which cannot pass through itself. The count above is a fact about the
     * mesh you were shown either way; whether it reached the file is not. */
    if (info.printable) {
      L.push('    THE STL IS NOT THIS MESH: it is a level set at ' +
             info.printable.cellMM.toFixed(2) + ' mm, which cannot pass through');
      L.push('    itself. The count above is what the preview showed you, and the');
      L.push('    fold is where the mask is tight against the face.');
    } else {
      L.push('    AND THE STL IS THIS MESH, FOLDS AND ALL — you exported the mask as');
      L.push('    shown. Slicers differ on a self-intersecting solid: most repair it');
      L.push('    silently, some produce a hole. Clear the folds in the app, take');
      L.push('    the level set, or repair on import.');
    }
  }
  L.push('');
  L.push('HEAD');
  L.push('  Google GNM v3.0, Apache-2.0. See NOTICES.txt.');
  row('identity preset', info.identity || 'mean');
  row('expression preset', info.expression || 'neutral');
  if (info.headNote) L.push('  ' + info.headNote);
  if (info.scanNote) { L.push(''); L.push('SCAN'); L.push('  ' + info.scanNote); }
  L.push('');
  L.push('  identity coefficients (' + info.idCoeffs.length + '), so this head is');
  L.push('  reproducible from this file alone:');
  for (let i = 0; i < info.idCoeffs.length; i += 8) {
    L.push('    ' + Array.from(info.idCoeffs.slice(i, i + 8)).map((x) => x.toFixed(5).padStart(9)).join(' '));
  }
  L.push('');
  L.push('  This model was trained using binary gender categories and four broad');
  L.push('  demographic groups, which do not represent the range of human faces.');
  L.push('  Any sizing conclusion drawn from this head inherits that limit.');
  L.push('');
  L.push('PRINT');
  if (info.printable) {
    const p = info.printable;
    row('printable shell', 'a LEVEL SET at ' + p.cellMM.toFixed(2) + ' mm');
    row('triangles', p.triangles.toLocaleString());
    if (p.decimated) {
      row('reduced from', p.decimated.from.toLocaleString() + ' by quadric collapse');
      row('deviation', 'at most ' + p.decimated.maxErrorMM.toFixed(4) + ' mm');
      L.push('  A uniform grid spends its triangles at a fixed rate whether the surface');
      L.push('  is flat or not. The reduction removes the ones a flat region did not');
      L.push('  need, and refuses any collapse that would reverse a triangle or make');
      L.push('  the mesh non-manifold — so it is still watertight and still cannot');
      L.push('  pass through itself.');
    }
    L.push('  The STL is not the mesh on screen. That one is the head offset along');
    L.push('  its normals, which folds wherever the face turns tighter than the');
    L.push('  offset; this is the zero set of a distance field, which cannot pass');
    L.push('  through itself and carries the full wall into a crease.');
    if (p.fragments > 0) {
      L.push('  ' + p.fragments + ' detached fragment' + (p.fragments === 1 ? '' : 's') +
             ' removed, ' + (p.fragmentFraction * 100).toFixed(3) + '% of the surface —');
      L.push('  the rim pinching thinner than one cell, usually where it crosses a lip.');
    }
    if (p.thinWall > 0) {
      L.push('');
      L.push('  ⚠ THE THINNEST WALL IS ' + p.thinWall.toFixed(2) + ' mm AND THE CELL IS ' +
             p.cellMM.toFixed(2) + ' mm.');
      L.push('    A wall under two cells cannot be resolved: the inner and outer');
      L.push('    surfaces fuse there and the mask is locally solid rather than');
      L.push('    hollow. Choose a finer cell, or raise the minimum wall.');
    }
  } else {
    row('printable shell', 'the mask AS SHOWN — the offset mesh, folds and all');
    if (info.rigid) {
      L.push('  Exported from a FROZEN mask. A level set is built against the head as it');
      L.push('  stands, and a frozen shell belongs to the posture it was frozen on, so');
      L.push('  meshing one against the other would describe a mask that never existed.');
    }
  }
  row('orientation', info.oriented ? 'auto: dome up, opening down on z=0' : 'as designed');
  L.push('  The shell is laid opening-down because a mask printed standing up is a');
  L.push('  tall overhanging dish needing support across its whole inner surface.');
  L.push('');
  if (info.terrainAttribution) {
    L.push('');
    L.push('TERRAIN DATA ATTRIBUTION');
    for (const line of info.terrainAttribution) L.push('  ' + line);
  }
  return L.join('\n');
}

/* ---------------------------------------------------------------- ZIP ------
 * Store-only (no deflate). One archive keeps the sidecar attached to the
 * meshes it describes; three separate downloads get separated within a day.
 */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* The entries carry the moment of export as their DOS time and date, in
 * local time — a zip with no date unpacks to files "created" 1 January 1980.
 * `when` fixes the moment (the tests hand a constant so two exports of one
 * document compare equal). */
export function makeZip(entries, when = new Date()) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const dosTime = ((when.getHours() & 31) << 11) | ((when.getMinutes() & 63) << 5) | ((when.getSeconds() >> 1) & 31);
  const dosDate = (((when.getFullYear() - 1980) & 127) << 9) | (((when.getMonth() + 1) & 15) << 5) | (when.getDate() & 31);
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30);
    parts.push(lh, data);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);

  let total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  for (const b of central) { out.set(b, p); p += b.length; }
  out.set(end, p);
  return out;
}

export { buildUnreasonDocument, buildSuperBOBJ } from './tosuperb.js';
