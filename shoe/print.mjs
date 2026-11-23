// The print platform: the stack stood on a printer's plate, the plate and its
// build-volume box as numbers the app draws, each piece's estimate from
// MASQ's slicer-checked model, and the project file a slicer opens.
//
// Frames and units. Pieces arrive in the app's frame: mm, Y up, X heel−/toe+,
// Z across. The plate frame is mm, Z up, the plate's centre at the origin
// (MASQ's stage draws the plate from −W/2 to W/2; a 3MF adds W/2, D/2).
//   soleDown  (x, y, z)app → (x, −z, y)plate   the sole's floor on z = 0
//   treadUp   (x, y, z)app → (x, z, −y)plate   the stack turned over about the
//             length axis: the topline (the highest app point) stands on z = 0,
//             the sole's floor is highest; heel/toe keep their x, the sides swap
// lift/masq/print/* takes mm already (unlike MASQ's metre modules), so no
// scale crosses this boundary; its worker door (print.worker.js meshToMM) is
// the one place that takes metres and is not used here. Its `up` is handed
// [0, 0, 1] on plate-frame meshes, so its own frame is the identity and its
// drop (dropToPlate) is each piece's own: every piece is estimated standing
// on the plate by itself, as a slicer prints an object; the picture shows the
// stack assembled, and supports() carries each piece's support back to where
// the piece stands in the stack.
//
// Materials: the FDM model runs on the profile's filament (tpu95a for every
// TPU grade — no softer-grade process exists, the card says so); the wall
// floor and the overhang angle are the material's; the support threshold
// handed to the model is 90° − overhang (the slicer measures from the plate).
// Resin has no oracle: an SLA card is volume × density and a layer count and
// says 'no data' for hours and support.

import { estimatePrint } from '../lift/masq/print/estimate.js';
import { makeProfile, printerProfiles } from '../lift/masq/print/profile.js';
import { bounds, volume, faceNormalsAreas, vertexNormalsAreas, rayThickness } from '../lift/masq/print/mesh.js';
import { projectSettings } from '../lift/masq/print/threemf.js';
import { makeZip } from '../lift/masq/exporters.js';

export const PROFILE_URL = new URL('../vendor/print/printers.json', import.meta.url);
export const MATERIALS_URL = new URL('../vendor/print/materials.json', import.meta.url);

/** plateMM = [W, D, H] (printers.json bedMM and heightMM); preset = the key in materials.json's printers (the model's watts and bed); table = the key in printers.json (the printer's machine, process, filaments and slicer preset names). */
export const PRINTERS = {
  kobra_s1_max: { name: 'Anycubic Kobra S1 Max', plateMM: [350, 350, 350], kind: 'fdm', preset: 'kobra_s1_max', table: 'kobra_s1_max', source: 'vendor/print/printers.json kobra_s1_max' },
  bambu_x1c: { name: 'Bambu Lab X1C', plateMM: [256, 256, 256], kind: 'fdm', preset: 'x1c', table: 'x1c', source: 'vendor/print/printers.json x1c' },
  form4: { name: 'Formlabs Form 4', plateMM: [200, 125, 210], kind: 'sla', preset: null, table: null, source: 'https://formlabs.com/3d-printers/form-4/tech-specs' },
};
export const PRINTER_DEFAULT = 'kobra_s1_max';
export const ORIENTATIONS = ['soleDown', 'treadUp'];
export const LAYER_MM = { fdm: [0.08, 0.12, 0.16, 0.2, 0.24, 0.28], sla: [0.05, 0.1] };

/**
 * densityGcm3 from the datasheet; wallFloorMM and overhangDeg (from vertical:
 * a surface leaning further than this needs support) from printed-footwear
 * design rules; filament = the key the FDM model runs on;
 * materialsKey = the price/CO2e row in materials.json. bridgeMM (FDM): the widest roof
 * printed over air without support before it sags (the Tread's grooves printed sole
 * down): a guess until a strip is printed.
 */
export const PRINT_MATERIALS = {
  pla: { name: 'PLA', process: 'fdm', bridgeMM: 10, densityGcm3: 1.24, wallFloorMM: 1.0, overhangDeg: 45, supportsOnFlexible: true, filament: 'pla', materialsKey: 'pla', timedAs: null,
    source: 'Bambu PLA Basic TDS: 1.24 g/cm³; 0.8–1.2 mm walls, 45° self-supporting' },
  tpu95: { name: 'TPU 95A', process: 'fdm', bridgeMM: 5, densityGcm3: 1.21, wallFloorMM: 1.5, overhangDeg: 45, supportsOnFlexible: false, filament: 'tpu95a', materialsKey: 'tpu95a', timedAs: null,
    source: 'Bambu TPU 95A HF TDS: 1.21 g/cm³; 1.5–2 mm walls for a shoe; supports bond and mark flexible surfaces' },
  tpu90: { name: 'TPU 90A', process: 'fdm', bridgeMM: 4, densityGcm3: 1.20, wallFloorMM: 2.0, overhangDeg: 45, supportsOnFlexible: false, filament: 'tpu95a', materialsKey: 'tpu95a', timedAs: 'TPU 95A',
    source: 'Bambu TPU 90A TDS: 1.20 g/cm³; softer walls sag, 2 mm; ≤ 30 mm/s direct drive' },
  tpu85: { name: 'TPU 85A', process: 'fdm', bridgeMM: 4, densityGcm3: 1.19, wallFloorMM: 2.0, overhangDeg: 45, supportsOnFlexible: false, filament: 'tpu95a', materialsKey: 'tpu95a', timedAs: 'TPU 95A',
    source: 'NinjaFlex 85A TDS: 1.19 g/cm³; as 90A' },
  tpu70: { name: 'TPU 70A', process: 'fdm', bridgeMM: 3, densityGcm3: 1.12, wallFloorMM: 2.0, overhangDeg: 40, supportsOnFlexible: false, filament: 'tpu95a', materialsKey: 'tpu95a', timedAs: 'TPU 95A',
    source: 'Filaflex 70A: 1.12 g/cm³; 2 mm+ walls, struts ≥ 1.5 mm; slow, direct drive, no retraction' },
  resin_hard: { name: 'Hard resin', process: 'sla', densityGcm3: 1.15, wallFloorMM: 1.0, overhangDeg: 10, supportsOnFlexible: true, filament: null, materialsKey: null, timedAs: null, priceUSDPerKg: 130,
    source: 'Formlabs Grey V5 / Tough 1500: ~1.15 g/cm³; 1.0 mm practical wall; unsupported overhang ≥ 10° from level and ≤ 5 mm; $149/L' },
  resin_elastomer: { name: 'Elastomer resin', process: 'sla', densityGcm3: 1.07, wallFloorMM: 1.5, overhangDeg: 0, supportsOnFlexible: true, filament: null, materialsKey: null, timedAs: null, priceUSDPerKg: 190,
    source: 'Formlabs Elastic 50A V2 / Flexible 80A: ~1.07 g/cm³; 1.5 mm so walls survive support removal; everything needs supports; $199/L' },
};
export const MATERIAL_DEFAULT = 'tpu95';

export const GRID_MM = 50;
/** MASQ's stage colours (app.js printStageFor / printPlateLabel). */
export const STAGE_COLORS = { plate: 0x8c8278, grid: 0x5c5048, edges: 0xe0b46a, box: 0xe0b46a, over: 0xf0a060, label: 0xe0b46a, support: 0x9a948c, supportOpacity: 0.72, supportStaleOpacity: 0.3, thin: [0.95, 0.36, 0.18] };
/**
 * MASQ's layer-line shader as onBeforeCompile replacements on a
 * MeshStandardMaterial: a stripe at the layer pitch up the print frame's z,
 * 1.5 px wide by screen derivative, fading out where a layer is under two
 * pixels tall. The app is mm, so the vertex's z is the layer height's unit
 * as it is (MASQ multiplied metres by 1000 here). uLayerMM is the uniform
 * the app sets to the chosen layer height.
 */
export const LAYER_LINE_SHADER = {
  uniform: 'uLayerMM',
  vertex: [
    ['#include <common>', '#include <common>\nvarying float vLayerZ;'],
    ['#include <begin_vertex>', '#include <begin_vertex>\nvLayerZ = transformed.z;'],
  ],
  fragment: [
    ['#include <common>', '#include <common>\nvarying float vLayerZ; uniform float uLayerMM;'],
    ['#include <dithering_fragment>', `#include <dithering_fragment>
        { float h = vLayerZ / uLayerMM; float w = fwidth(h); float f = fract(h); float d = min(f, 1.0 - f);
          float line = 1.0 - smoothstep(0.0, max(w * 1.5, 0.02), d);
          float show = 1.0 - smoothstep(0.35, 0.6, w);
          gl_FragColor.rgb *= 1.0 - 0.22 * line * show; }`],
  ],
  cacheKey: 'printmask-layers',
};

// ── the plate frame ────────────────────────────────────────────────────────
/** Row-major 3×3 app → plate rotation for an orientation. */
export function plateRotation(orientation = 'soleDown') {
  if (orientation === 'treadUp') return [1, 0, 0, 0, 0, 1, 0, -1, 0];
  if (orientation !== 'soleDown') throw new Error('orientation is soleDown or treadUp, not ' + orientation);
  return [1, 0, 0, 0, 0, -1, 0, 1, 0];
}
function transform(positions, M, t) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = M[0] * x + M[1] * y + M[2] * z + t[0];
    out[i + 1] = M[3] * x + M[4] * y + M[5] * z + t[1];
    out[i + 2] = M[6] * x + M[7] * y + M[8] * z + t[2];
  }
  return out;
}
/* A graded piece's bands (graded infill: modifier volumes, app frame) ride with it: the same
 * rotation and translation, and for the pair's twin the same mirror in app z with the winding reversed. */
function placeBands(bands, M, t, mirror = false) {
  if (!bands || !bands.length) return null;
  return bands.map((b) => {
    let P = b.positions, I = b.indices;
    if (mirror) {
      P = Float32Array.from(P); for (let i = 2; i < P.length; i += 3) P[i] = -P[i];
      I = Uint32Array.from(I); for (let i = 0; i < I.length; i += 3) { const k = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = k; }
    }
    return { density: b.density, positions: transform(P, M, t), indices: I };
  });
}
const printerOf = (key) => { const p = PRINTERS[key || PRINTER_DEFAULT]; if (!p) throw new Error('no printer ' + key); return p; };
const materialOf = (key) => { const m = PRINT_MATERIALS[key || MATERIAL_DEFAULT]; if (!m) throw new Error('no print material ' + key); return m; };

/**
 * The stack on the plate: rotated into the plate frame, centred on the
 * plate in x and y, its floor on z = 0 (soleDown: `groundY`, the ground
 * plane the sole was built to, when given; else the stack's lowest point).
 * @param {Array<{name: string, positions: Float32Array, indices: Uint32Array|Uint16Array}>} pieces app frame, mm
 * @returns {{M: number[], t: number[], matrix4: number[], pieces: object[], bbox: object, overEdgeMM: number[], overTopMM: number, fits: boolean}}
 *   matrix4 is column-major for THREE.Matrix4.fromArray; overEdgeMM is [x, y]: by how much the stack is wider than the plate on that axis (0 when it is not); overTopMM likewise against the build height.
 */
export function placeOnPlate(pieces, { printer = PRINTER_DEFAULT, orientation = 'soleDown', groundY = null, pair = false } = {}) {
  const pr = printerOf(printer), M = plateRotation(orientation);
  if (!pair) {
    const rotated = pieces.map((p) => transform(p.positions, M, [0, 0, 0]));
    const all = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const r of rotated) { const b = bounds(r); for (let k = 0; k < 3; k++) { if (b.min[k] < all.min[k]) all.min[k] = b.min[k]; if (b.max[k] > all.max[k]) all.max[k] = b.max[k]; } }
    const floorZ = orientation === 'soleDown' && Number.isFinite(groundY) ? groundY : all.min[2];
    const t = [-(all.min[0] + all.max[0]) / 2, -(all.min[1] + all.max[1]) / 2, -floorZ];
    const placed = pieces.map((p, i) => {
      const positions = transform(rotated[i], [1, 0, 0, 0, 1, 0, 0, 0, 1], t);
      return { name: p.name, positions, indices: p.indices, bbox: bounds(positions), bands: placeBands(p.bands, M, t) };
    });
    const min = all.min.map((v, k) => v + t[k]), max = all.max.map((v, k) => v + t[k]);
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const [W, D, H] = pr.plateMM;
    const overEdgeMM = [Math.max(0, size[0] - W), Math.max(0, size[1] - D)];
    const overTopMM = Math.max(0, size[2] - H);
    return {
      printer, orientation, pair: false, plateMM: pr.plateMM, M, t,
      matrix4: [M[0], M[3], M[6], 0, M[1], M[4], M[7], 0, M[2], M[5], M[8], 0, t[0], t[1], t[2], 1],
      pieces: placed, bbox: { min, max, size }, overEdgeMM, overTopMM,
      fits: overEdgeMM[0] === 0 && overEdgeMM[1] === 0 && overTopMM === 0,
    };
  }

  // A pair: original shoe and mirrored twin side-by-side along plate width (Y axis)
  const mirrorPiece = (p) => {
    const P = p.positions, nV = P.length;
    const Pmir = new Float32Array(nV);
    for (let i = 0; i < nV; i += 3) {
      Pmir[i] = P[i];
      Pmir[i + 1] = P[i + 1];
      Pmir[i + 2] = -P[i + 2]; // mirror across app's sagittal plane
    }
    const I = p.indices, nI = I.length;
    const Imir = (I instanceof Uint32Array) ? new Uint32Array(nI) : new Uint16Array(nI);
    for (let i = 0; i < nI; i += 3) {
      Imir[i] = I[i];
      Imir[i + 1] = I[i + 2];
      Imir[i + 2] = I[i + 1]; // reverse winding for outward normals
    }
    return { name: p.name + '_pair', positions: Pmir, indices: Imir, bandsOf: p.bands };
  };

  const pairPieces = pieces.map(mirrorPiece);
  const rotatedA = pieces.map((p) => transform(p.positions, M, [0, 0, 0]));
  const rotatedB = pairPieces.map((p) => transform(p.positions, M, [0, 0, 0]));

  const allA = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const r of rotatedA) { const b = bounds(r); for (let k = 0; k < 3; k++) { if (b.min[k] < allA.min[k]) allA.min[k] = b.min[k]; if (b.max[k] > allA.max[k]) allA.max[k] = b.max[k]; } }
  const allB = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const r of rotatedB) { const b = bounds(r); for (let k = 0; k < 3; k++) { if (b.min[k] < allB.min[k]) allB.min[k] = b.min[k]; if (b.max[k] > allB.max[k]) allB.max[k] = b.max[k]; } }

  const floorZ = orientation === 'soleDown' && Number.isFinite(groundY) ? groundY : Math.min(allA.min[2], allB.min[2]);
  const tZ = -floorZ;
  const tX = -((Math.min(allA.min[0], allB.min[0]) + Math.max(allA.max[0], allB.max[0])) / 2);

  const gap = 15; // 15 mm minimum slicer clearance between pair
  const widthA = allA.max[1] - allA.min[1];
  const widthB = allB.max[1] - allB.min[1];
  const totalY = widthA + gap + widthB;
  const midYA = (allA.min[1] + allA.max[1]) / 2;
  const midYB = (allB.min[1] + allB.max[1]) / 2;

  const tYA = -(totalY / 2) + (widthA / 2) - midYA;
  const tYB = +(totalY / 2) - (widthB / 2) - midYB;

  const placedA = pieces.map((p, i) => {
    const positions = transform(rotatedA[i], [1, 0, 0, 0, 1, 0, 0, 0, 1], [tX, tYA, tZ]);
    return { name: p.name, positions, indices: p.indices, bbox: bounds(positions), bands: placeBands(p.bands, M, [tX, tYA, tZ]) };
  });
  const placedB = pairPieces.map((p, i) => {
    const positions = transform(rotatedB[i], [1, 0, 0, 0, 1, 0, 0, 0, 1], [tX, tYB, tZ]);
    return { name: p.name, positions, indices: p.indices, bbox: bounds(positions), bands: placeBands(p.bandsOf, M, [tX, tYB, tZ], true) };
  });

  const placed = [...placedA, ...placedB];
  const min = [
    Math.min(allA.min[0], allB.min[0]) + tX,
    -totalY / 2,
    0
  ];
  const max = [
    Math.max(allA.max[0], allB.max[0]) + tX,
    totalY / 2,
    Math.max(allA.max[2], allB.max[2]) + tZ
  ];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const [W, D, H] = pr.plateMM;
  const overEdgeMM = [Math.max(0, size[0] - W), Math.max(0, size[1] - D)];
  const overTopMM = Math.max(0, size[2] - H);

  return {
    printer, orientation, pair: true, plateMM: pr.plateMM, M, t: [tX, 0, tZ],
    matrix4: [M[0], M[3], M[6], 0, M[1], M[4], M[7], 0, M[2], M[5], M[8], 0, tX, 0, tZ, 1],
    pieces: placed, bbox: { min, max, size }, overEdgeMM, overTopMM,
    fits: overEdgeMM[0] === 0 && overEdgeMM[1] === 0 && overTopMM === 0,
  };
}

// ── the stage ──────────────────────────────────────────────────────────────
/**
 * What the app draws, plate frame (z up; the app lies the group down with
 * rotation.x = −π/2 as MASQ does): the plate as a W × D rectangle centred on
 * the origin just under z = 0, grid lines every 50 mm through the centre,
 * the plate's four edges, and the build volume's twelve edges (four
 * verticals and the top square at z = H). Line lists are flat xyz pairs.
 */
export function stageGeometry(printer = PRINTER_DEFAULT) {
  const pr = printerOf(printer), [W, D, H] = pr.plateMM;
  const seg = (a, b) => [a[0], a[1], a[2], b[0], b[1], b[2]];
  const edges = [];
  edges.push(...seg([-W / 2, -D / 2, 0], [W / 2, -D / 2, 0]), ...seg([W / 2, -D / 2, 0], [W / 2, D / 2, 0]), ...seg([W / 2, D / 2, 0], [-W / 2, D / 2, 0]), ...seg([-W / 2, D / 2, 0], [-W / 2, -D / 2, 0]));
  const grid = [];
  for (let x = -Math.floor(W / (2 * GRID_MM)) * GRID_MM; x <= W / 2 + 1e-9; x += GRID_MM) grid.push(...seg([x, -D / 2, 0.1], [x, D / 2, 0.1]));
  for (let y = -Math.floor(D / (2 * GRID_MM)) * GRID_MM; y <= D / 2 + 1e-9; y += GRID_MM) grid.push(...seg([-W / 2, y, 0.1], [W / 2, y, 0.1]));
  const box = [];
  const c = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    box.push(...seg([a[0], a[1], 0], [a[0], a[1], H]), ...seg([a[0], a[1], H], [b[0], b[1], H]));
  }
  return {
    printer, name: pr.name, kind: pr.kind, plateMM: pr.plateMM, gridMM: GRID_MM,
    plate: { w: W, d: D, z: -0.2 },
    plateEdges: Float32Array.from(edges), grid: Float32Array.from(grid), box: Float32Array.from(box),
    label: { text: `${pr.name} · ${W} × ${D} × ${H} mm`, at: [-W / 2 + 4, -D / 2 + 4, 0.3], widthMM: W * 0.6 },
    colors: STAGE_COLORS,
  };
}
/** The corner label with the placement read in: over the edge / over the top by how much. */
export function plateLabel(placement) {
  const pr = printerOf(placement.printer), [W, D, H] = pr.plateMM;
  const over = [];
  const [ox, oy] = placement.overEdgeMM;
  if (ox > 0 || oy > 0) over.push(`over the edge by ${Math.max(ox, oy).toFixed(0)} mm`);
  if (placement.overTopMM > 0) over.push(`over the top by ${placement.overTopMM.toFixed(0)} mm`);
  return { text: `${pr.name} · ${W} × ${D} × ${H} mm${over.length ? ' — ' + over.join(', ') : ''}`, over: over.length > 0 };
}

// ── the tables ─────────────────────────────────────────────────────────────
async function readJSON(src) {
  if (src && typeof src === 'object' && !(src instanceof URL)) return src;
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(src, 'utf8'));
  }
  const r = await fetch(src);
  if (!r.ok) throw new Error('fetch failed: ' + r.status + ' ' + src);
  return r.json();
}
/**
 * The estimator's tables: printers.json (every printer's machine, processes,
 * filaments and slicer preset names) and materials.json (price, CO2e,
 * printer watts). Each may be a URL or the parsed json; the defaults read
 * vendor/print/ from disk under node, by fetch in a browser. A printer's
 * missing filaments come from the table's default printer (printers.json
 * otherFilamentsFrom).
 */
export async function loadPrintProfile({ profile = PROFILE_URL, materials = MATERIALS_URL } = {}) {
  const [table, mats] = await Promise.all([readJSON(profile), readJSON(materials)]);
  return { table, profile: makeProfile(table), materials: mats, printers: printerProfiles(table) };
}

// ── the wall check ─────────────────────────────────────────────────────────
/**
 * The piece's thinnest wall: the ray-cast wall under every vertex (mesh.js
 * rayThickness), read at the area-weighted 1st percentile so one pinched
 * vertex does not speak for the piece; and the share of the surface under
 * the floor.
 */
/** A wall within this of its floor is at the floor, not under it (a 1.0 mm shell reads 0.994). */
export const AT_FLOOR_MM = 0.02;
export function thinnestWall(piece, floorMM) {
  const P = piece.positions, I = piece.indices instanceof Uint32Array ? piece.indices : Uint32Array.from(piece.indices);
  const face = faceNormalsAreas(P, I), vert = vertexNormalsAreas(P, I, face);
  const th = rayThickness(P, I, vert.normals, Math.max(floorMM * 4, 10));
  const n = th.length, order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => th[a] - th[b]);
  let A = 0; for (let i = 0; i < n; i++) A += vert.areas[i];
  let acc = 0, thinnestMM = th[order[0]] || 0, under = 0;
  for (let k = 0; k < n; k++) {
    const v = order[k]; acc += vert.areas[v];
    if (acc >= 0.01 * A) { thinnestMM = th[v]; break; }
  }
  for (let v = 0; v < n; v++) if (th[v] < floorMM) under += vert.areas[v];
  return { thinnestMM, floorMM, underFraction: A > 0 ? under / A : 0, thin: thinnestMM < floorMM - AT_FLOOR_MM };
}

// ── the body ───────────────────────────────────────────────────────────────
/**
 * A body as the slicer lays it: the core at `infill` (solid 1, hollow 0,
 * lattice infillPct) inside the walls. Two arithmetics, each said on its
 * card:
 *   FDM  the model's own — walls and top/bottom shells at the profile's
 *        loops, the core at infill; linear in infill (measured on a
 *        100 × 50 × 20 box: 1.00 / 0.58 / 0.31 / 0.13 at 100 / 50 / 20 / 0 %).
 *        The body's wallMM asks for `loops` of the profile's inner width;
 *        that goes to the 3MF as wall_loops and is NOT timed: the model's
 *        core classification breaks past its profile's loops (4 loops at
 *        100 % read 70 % of solid on the box), so it runs at the profile's.
 *   SLA  volume × density × factor, factor = fw + (1 − fw) × infill with
 *        fw = min(1, area × wallMM / volume), the walls' share of the solid.
 */
export function bodyPlan(body, { innerWidthMM = 0.45, profileLoops = 2, areaMM2 = 0, volumeMM3 = 0 } = {}) {
  const kind = (body && body.kind) || 'solid';
  const isLattice = kind.startsWith('lattice');
  if (!['solid', 'hollow', 'infill'].includes(kind) && !isLattice) throw new Error('body.kind is solid, hollow, infill or lattice, not ' + kind);
  const wallMM = body && body.wallMM > 0 ? body.wallMM : 2;
  const cellMM = body && body.cellMM > 0 ? body.cellMM : 12;
  const infill = kind === 'solid' ? 1 : kind === 'hollow' ? 0 : Math.max(0, Math.min(1, ((body && body.infillPct) ?? 20) / 100));
  const infillPct = Math.round(infill * 100);
  const loops = kind === 'solid' ? profileLoops : Math.max(1, Math.round(wallMM / innerWidthMM));
  const fw = kind === 'solid' ? 1 : volumeMM3 > 0 ? Math.min(1, areaMM2 * wallMM / volumeMM3) : 1;
  const factor = fw + (1 - fw) * infill;
  const patternName = isLattice ? (kind.replace(/^lattice_?/, '') || 'gyroid') : kind === 'infill' ? "the slicer's gyroid" : kind;
  const fdmLine = kind === 'solid' ? `solid: the profile's ${profileLoops} walls, the core at 100 %`
    : `${kind}: the profile's ${profileLoops} walls + top/bottom shells + the core at ${infillPct} % (${patternName}${isLattice ? `, cell ${cellMM} mm` : ''}), as the slicer lays it; ${wallMM} mm walls = ${loops} loops in the 3MF, not timed`;
  const slaLine = kind === 'solid' ? 'solid: volume × density'
    : `${kind}: walls ${wallMM} mm are ${fw.toFixed(2)} of the solid, the core at ${infillPct} % (${patternName}) — mass = solid × (${fw.toFixed(2)} + ${(1 - fw).toFixed(2)} × ${infill.toFixed(2)}) = solid × ${factor.toFixed(2)}`;
  return { kind, wallMM, cellMM, infill, infillPct, loops, profileLoops, wallShare: fw, factor, fdmLine, slaLine };
}

/** The printer's own profile from printers.json, else the table's default printer's. */
function profileBase(tables, pr) {
  return pr.table && tables.printers[pr.table] ? tables.printers[pr.table] : tables.profile;
}
/** The profile at the layer with the body's infill and the material's overhang laid over its process. */
function profileFor(tables, pr, layerMM, plan, material) {
  const at = profileBase(tables, pr).withLayer(layerMM);
  const process = { ...at.process, infillDensity: plan.infill, supportThresholdDeg: 90 - material.overhangDeg };
  return { ...at, process };
}

// ── the estimate ───────────────────────────────────────────────────────────
/**
 * Per piece and in total: grams, hours, cost, support grams, the thinnest
 * wall against the material's floor. FDM: MASQ's estimatePrint on the piece
 * standing alone on the plate (its `up` the plate normal), the body as
 * slicer settings. SLA: volume × density × the body's factor, a layer count,
 * 'no data' for hours and support.
 * @param {object} opts printer, orientation, groundY, layerMM, support ('tree'|'normal'|'none'),
 *   materials {pieceName: key} or one key for all, bodies {pieceName: body} or one body, tables (loadPrintProfile), cellMM
 */
export function estimate(pieces, opts = {}) {
  const pr = printerOf(opts.printer), printer = opts.printer || PRINTER_DEFAULT;
  const layerMM = opts.layerMM || (pr.kind === 'sla' ? 0.1 : 0.2);
  const placement = placeOnPlate(pieces, { printer, orientation: opts.orientation, groundY: opts.groundY, pair: opts.pair });
  const matKey = (p) => {
    const baseName = (p.name || 'piece').replace(/_pair$/, '');
    return typeof opts.materials === 'string' ? opts.materials : (opts.materials && (opts.materials[baseName] || opts.materials[p.name])) || MATERIAL_DEFAULT;
  };
  const bodyOf = (p) => {
    const baseName = (p.name || 'piece').replace(/_pair$/, '');
    return opts.bodies && (opts.bodies.kind ? opts.bodies : (opts.bodies[baseName] || opts.bodies[p.name])) || { kind: 'solid' };
  };
  const rows = [];
  for (const p of placement.pieces) {
    const material = materialOf(matKey(p)), mesh = { positions: p.positions, indices: p.indices instanceof Uint32Array ? p.indices : Uint32Array.from(p.indices) };
    const vol = Math.abs(volume(mesh)), face = faceNormalsAreas(mesh.positions, mesh.indices);
    let area = 0; for (let i = 0; i < face.areas.length; i++) area += face.areas[i];
    const thin = thinnestWall(mesh, material.wallFloorMM);
    const lines = [];
    if (thin.thin) lines.push(`${p.name}: thinnest wall ${thin.thinnestMM.toFixed(2)} mm under ${material.name}'s ${material.wallFloorMM} mm floor`);
    const notes = [];
    const basePlan = (pr.kind === 'sla' || material.process === 'sla')
      ? bodyPlan(bodyOf(p), { areaMM2: area, volumeMM3: vol })
      : (opts.tables ? bodyPlan(bodyOf(p), { innerWidthMM: profileBase(opts.tables, pr).process.widthMM.inner, profileLoops: profileBase(opts.tables, pr).process.wallLoops, areaMM2: area, volumeMM3: vol }) : bodyPlan(bodyOf(p), { areaMM2: area, volumeMM3: vol }));

    // what the slicer will meet: an open piece, a stack past the box
    let openEdges = 0;
    const edgeMap = new Map();
    const I = mesh.indices;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i], b = I[i + 1], c = I[i + 2];
      const e0 = a < b ? (a * 4294967296 + b) : (b * 4294967296 + a);
      const e1 = b < c ? (b * 4294967296 + c) : (c * 4294967296 + b);
      const e2 = c < a ? (c * 4294967296 + a) : (a * 4294967296 + c);
      edgeMap.set(e0, (edgeMap.get(e0) || 0) + 1);
      edgeMap.set(e1, (edgeMap.get(e1) || 0) + 1);
      edgeMap.set(e2, (edgeMap.get(e2) || 0) + 1);
    }
    for (const [, cnt] of edgeMap) if (cnt === 1) openEdges++;
    if (openEdges > 0) {
      const msg = `an open piece (${openEdges} boundary edges)`;
      notes.push(msg);
      lines.push(`${p.name}: ${msg}`);
    }

    if (!placement.fits) {
      const msg = opts.pair ? 'a pair that does not fit as two' : 'a piece past the box';
      notes.push(msg);
      lines.push(`${p.name}: ${msg}`);
    }

    const row = { name: p.name, material: matKey(p), materialName: material.name, process: material.process, volumeCm3: vol / 1000, areaCm2: area / 100, bboxMM: p.bbox.size, thin, lines, notes };
    if (pr.kind === 'sla' || material.process === 'sla') {
      const plan = basePlan;
      const grams = vol / 1000 * material.densityGcm3 * plan.factor;
      const price = material.priceUSDPerKg || 0;
      Object.assign(row, {
        body: plan, grams: { model: grams, support: null, total: grams }, hours: null, costUSD: grams / 1000 * price, pricePerKg: price,
        layers: Math.ceil(p.bbox.size[2] / layerMM), heightMM: p.bbox.size[2], layerMM, supportGeometry: null, noData: ['hours', 'support'],
        lines: [...lines, `${material.name}: no data — grams are volume × ${material.densityGcm3} g/cm³${plan.kind === 'solid' ? '' : ' × ' + plan.factor.toFixed(2)}, ${Math.ceil(p.bbox.size[2] / layerMM)} layers at ${layerMM} mm; hours and support: no data`, plan.slaLine],
      });
      if (pr.kind === 'fdm') row.lines.push(`${material.name} is a resin; ${pr.name} is FDM`);
    } else {
      if (!opts.tables) throw new Error('estimate needs tables (loadPrintProfile) for an FDM printer');
      const base = profileBase(opts.tables, pr).process;
      const plan = basePlan;
      const profile = profileFor(opts.tables, pr, layerMM, plan, material);
      const support = opts.support || 'tree';
      const r = estimatePrint(mesh, {
        profile, materials: opts.tables.materials, up: [0, 0, 1], material: material.filament, printer: pr.preset, support,
        cellMM: opts.cellMM > 0 ? opts.cellMM : 1.0, wallMM: material.wallFloorMM, supportSlabMM: 2,
      });
      Object.assign(row, {
        body: plan, grams: r.grams, hours: r.seconds.total / 3600, seconds: r.seconds, costUSD: r.costUSD, pricePerKg: r.pricePerKg,
        layers: r.layers, heightMM: r.heightMM, layerMM: r.layerMM, processName: r.processName, co2e: r.co2e,
        supportGeometry: r.supportGeometry, support, ms: r.msEstimate,
      });
      row.lines.push(plan.fdmLine);
      if (material.timedAs) row.lines.push(`${material.name}: timed as ${material.timedAs} — no ${material.name} process in the profile`);
      if (!material.supportsOnFlexible && support !== 'none') row.lines.push(`${material.name}: supports bond and mark it — design support-free`);
    }
    rows.push(row);
  }
  const total = rows.reduce((s, r) => ({
    grams: s.grams + r.grams.total, hours: s.hours === null || r.hours === null ? null : s.hours + r.hours, costUSD: s.costUSD + r.costUSD,
    supportGrams: r.grams.support === null || s.supportGrams === null ? null : s.supportGrams + r.grams.support,
  }), { grams: 0, hours: 0, costUSD: 0, supportGrams: 0 });
  const thinPieces = rows.filter((r) => r.thin.thin).map((r) => r.name);
  const notedPieces = rows.filter((r) => r.notes && r.notes.length).map((r) => r.name);
  const estNotes = Array.from(new Set([
    ...rows.flatMap((r) => r.notes || []),
    ...(!placement.fits ? [opts.pair ? 'a pair that does not fit as two' : 'a piece past the box'] : [])
  ]));
  const est = { printer, printerName: pr.name, kind: pr.kind, orientation: placement.orientation, layerMM, placement, pieces: rows, total, thin: thinPieces, notes: estNotes, notedPieces, noData: pr.kind === 'sla' ? ['hours', 'support'] : [] };
  est.supports = supports(est);
  return est;
}
/**
 * The support the estimate grew, per piece, in the stack's plate frame:
 * MASQ's slabs (normal: discs [x, y, r, n] per slab z0..z1; tree: branch
 * tips) and tree chains ([x, y, z, r] points, top down), moved from the
 * piece's own drop (offsetMM, estimate.js) to where the piece stands in the
 * stack. The app draws them as MASQ does: a cylinder per disc per slab, a
 * tapered tube per chain, a pad under every foot on the plate.
 */
export function supports(est) {
  const out = [];
  for (const r of est.pieces) {
    const g = r.supportGeometry;
    if (!g || !g.slabs || !g.slabs.length) { out.push({ name: r.name, offsetMM: [0, 0, 0], slabs: [], chains: [] }); continue; }
    const [ox, oy, oz] = g.offsetMM;
    const slabs = g.slabs.map((s) => ({
      z0: s.z0 + oz, z1: s.z1 + oz,
      discs: s.discs ? s.discs.map(([x, y, rr, n]) => [x + ox, y + oy, rr, n]) : undefined,
      branches: s.branches ? s.branches.map(([x, y, tip, zc]) => [x + ox, y + oy, tip, zc]) : undefined,
    }));
    const chains = (g.chains || []).map((ch) => ch.map(([x, y, z, rr]) => [x + ox, y + oy, z + oz, rr]));
    out.push({ name: r.name, offsetMM: g.offsetMM, slabs, chains });
  }
  return out;
}

// ── the project file ───────────────────────────────────────────────────────
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SUPPORT_TYPE = { tree: 'tree(auto)', normal: 'normal(auto)' };

/** The slicer preset names printers.json gives a printer at a layer height and material ({} when it has no row). */
export function presetNames(tables, printer, layerMM, materialKey) {
  const pr = printerOf(printer), row = pr.table && tables && tables.table && tables.table.printers[pr.table];
  const sp = row && row.slicerPreset;
  if (!sp) return {};
  const mat = materialOf(materialKey);
  const out = { printer: sp.printer };
  const proc = (sp.processByLayer || {})[String(layerMM)] || (row.otherLayersFrom != null ? (sp.processByLayer || {})[row.otherLayersFrom] : undefined);
  if (proc) out.process = proc;
  const fil = mat.filament && (sp.filamentByMaterial || {})[mat.filament];
  if (fil) out.filament = fil;
  return out;
}

/**
 * A 3MF (3MF Core, plus the Production extension for a graded piece) with
 * one object per piece, mm, z up, the stack as placeOnPlate stands it,
 * moved to the plate's middle (a slicer's plate runs 0..W). Slicer
 * settings are named, not embedded:
 *   Metadata/model_settings.config   per object: layer height, support on/off
 *     and its type, the body's wall loops and sparse infill density, the
 *     finish's fuzzy-skin keys; a graded band is a modifier part carrying its
 *     own sparse infill density;
 *   Metadata/project_settings.config the printer, process and filament preset
 *     names from printers.json, the layer height, support, and the keys that
 *     differ from the presets (threemf.js projectSettings). No machine limits,
 *     speeds or G-code.
 * `Application` is the app that wrote the file. The Form 4 gets a plain 3MF:
 * the model file and the machine's name in its metadata, no settings.
 * @returns {{zip: Uint8Array, entries: object[], when: Date, settings: object|null, objects: object[], placement: object, layout: 'slicer'|'plain'}}
 */
// a fuzzy-skin number as the slicer may take it: finite, inside the Fuzz control's typed range, else the default
const fuzzClamp = (v, def, lo, hi) => { const x = +v; return Number.isFinite(x) && x > 0 ? Math.min(hi, Math.max(lo, x)) : def; };
export function make3MF(pieces, opts = {}) {
  const pr = printerOf(opts.printer), printer = opts.printer || PRINTER_DEFAULT;
  const placement = placeOnPlate(pieces, { printer, orientation: opts.orientation, groundY: opts.groundY, pair: opts.pair });
  const [W, D] = pr.plateMM;
  const name = opts.name || 'lastfirst';
  const when = opts.when || new Date();
  const application = opts.application || 'LastFirst';
  const meshOf = (P, I) => {
    const nV = P.length / 3, nT = I.length / 3, v = new Array(nV), t = new Array(nT);
    for (let k = 0; k < nV; k++) v[k] = `<vertex x="${(P[k * 3] + W / 2).toFixed(4)}" y="${(P[k * 3 + 1] + D / 2).toFixed(4)}" z="${P[k * 3 + 2].toFixed(4)}"/>`;
    for (let k = 0; k < nT; k++) t[k] = `<triangle v1="${I[k * 3]}" v2="${I[k * 3 + 1]}" v3="${I[k * 3 + 2]}"/>`;
    return { vertices: nV, triangles: nT, v, t };
  };
  const slicer = pr.kind === 'fdm';
  /* A graded piece (bands, FDM only) is one object of components in /3D/Objects: the piece as its
   * normal_part and each band a modifier_part carrying its sparse_infill_density. Every other piece
   * is an inline mesh. Ids run over both files so none repeats. */
  let nextId = 1;
  const objects = placement.pieces.map((p) => {
    const m = meshOf(p.positions, p.indices);
    if (!(slicer && p.bands && p.bands.length)) return { id: nextId++, name: p.name, ...m };
    const parts = [{ id: nextId++, subtype: 'normal_part', name: p.name, ...m }];
    for (const [k, b] of p.bands.entries()) parts.push({ id: nextId++, subtype: 'modifier_part', name: `${p.name} ${b.density}% infill (band ${k + 1})`, density: b.density, ...meshOf(b.positions, b.indices) });
    return { id: nextId++, name: p.name, vertices: m.vertices, triangles: m.triangles, parts };
  });
  const graded = objects.some((o) => o.parts);
  const PARTS = '/3D/Objects/lastfirst_parts.model';
  const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const meshXML = (o) => `  <object id="${o.id}"${o.name && !o.subtype ? ` name="${xmlEsc(o.name)}"` : ''} type="model">
   <mesh>
    <vertices>
${o.v.join('\n')}
    </vertices>
    <triangles>
${o.t.join('\n')}
    </triangles>
   </mesh>
  </object>`;
  if (slicer && opts.bodies) {
    const base = opts.tables ? profileBase(opts.tables, pr).process : null;
    const inner = base ? base.widthMM.inner : 0.45, loops = base ? base.wallLoops : 2;
    for (const o of objects) {
      const baseName = o.name.replace(/_pair$/, '');
      const b = opts.bodies.kind ? opts.bodies : (opts.bodies[baseName] || opts.bodies[o.name]);
      if (b) o.plan = bodyPlan(b, { innerWidthMM: inner, profileLoops: loops });
    }
  }
  // a finish per piece (opts.finishes[name] = { fuzzy: { thicknessMM, pointMM } }): the slicer's fuzzy skin on that
  // object's outer walls. It jitters perimeters only, so it roughens a piece's sides, never a flat top or bottom.
  if (slicer && opts.finishes) for (const o of objects) { const nm = o.name.replace(/_pair$/, ''), f = Object.prototype.hasOwnProperty.call(opts.finishes, nm) ? opts.finishes[nm] : null; if (f && f.fuzzy && typeof f.fuzzy === 'object') o.fuzzy = f.fuzzy; }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}"${graded ? ` xmlns:p="${PROD}" requiredextensions="p"` : ''}>
 <metadata name="Application">${xmlEsc(application)}</metadata>
 <metadata name="Title">${xmlEsc(name)}</metadata>
 <metadata name="Designer">LastFirst</metadata>
 <metadata name="Description">${xmlEsc(`${pr.name} · ${placement.orientation}`)}</metadata>
 <metadata name="CreationDate">${when.toISOString().slice(0, 10)}</metadata>
 <resources>
${objects.map((o) => o.parts ? `  <object id="${o.id}" name="${xmlEsc(o.name)}" type="model">
   <components>
${o.parts.map((q) => `    <component p:path="${PARTS}" objectid="${q.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('\n')}
   </components>
  </object>` : meshXML(o)).join('\n')}
 </resources>
 <build>
${objects.map((o) => `  <item objectid="${o.id}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>`).join('\n')}
 </build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
${slicer ? ' <Default Extension="config" ContentType="text/xml"/>\n' : ''}</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  const entries = [{ name: '[Content_Types].xml', data: contentTypes }, { name: '_rels/.rels', data: rels }, { name: '3D/3dmodel.model', data: model }];
  if (graded) entries.push({ name: '3D/_rels/3dmodel.model.rels', data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="${PARTS}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
` }, { name: PARTS.slice(1), data: `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:p="${PROD}" requiredextensions="p">
 <resources>
${objects.filter((o) => o.parts).flatMap((o) => o.parts).map(meshXML).join('\n')}
 </resources>
 <build/>
</model>
` });
  let settings = null;
  if (slicer) {
    const layerMM = opts.layerMM || 0.2, support = opts.support || 'tree';
    const matKey = typeof opts.materials === 'string' ? opts.materials : (opts.materials && opts.materials[pieces[0].name]) || MATERIAL_DEFAULT;
    const objectKeys = (o) => {
      const kv = [['layer_height', String(layerMM)], ['enable_support', support === 'none' ? '0' : '1']];
      if (support !== 'none') kv.push(['support_type', SUPPORT_TYPE[support] || SUPPORT_TYPE.tree]);
      if (o.plan) kv.push(['wall_loops', String(o.plan.loops)], ['sparse_infill_density', `${o.plan.infillPct}%`]);
      if (o.fuzzy) kv.push(['fuzzy_skin', 'external'], ['fuzzy_skin_thickness', fuzzClamp(o.fuzzy.thicknessMM, 0.3, 0.05, 1.5).toFixed(2)], ['fuzzy_skin_point_distance', fuzzClamp(o.fuzzy.pointMM, 0.8, 0.1, 5).toFixed(2)]);
      return kv;
    };
    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${objects.map((o) => `  <object id="${o.id}">
    <metadata key="name" value="${xmlEsc(o.name)}"/>
    <metadata key="extruder" value="1"/>
${objectKeys(o).map(([k, v]) => `    <metadata key="${k}" value="${xmlEsc(v)}"/>\n`).join('')}${(o.parts || [{ id: o.id, subtype: 'normal_part', name: o.name }]).map((q) => `    <part id="${q.id}" subtype="${q.subtype}">
      <metadata key="name" value="${xmlEsc(q.name)}"/>
${q.density != null ? `      <metadata key="sparse_infill_density" value="${q.density}%"/>\n` : ''}    </part>`).join('\n')}
  </object>`).join('\n')}
</config>
`;
    settings = projectSettings({ preset: presetNames(opts.tables, printer, layerMM, matKey), layerMM, support });
    entries.push({ name: 'Metadata/model_settings.config', data: modelSettings }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings, null, 2) + '\n' });
  }
  /* the stored zip is built on first read: the app writes pack3MF's deflated one, and a shoe's stored model runs to hundreds of MB */
  let zip = null;
  return { get zip() { return zip || (zip = makeZip(entries, when)); }, entries, when, settings, objects: objects.map(({ id, name: n, vertices, triangles, plan }) => ({ id, name: n, vertices, triangles, body: plan ? { loops: plan.loops, infillPct: plan.infillPct } : null })), placement, layout: slicer ? 'slicer' : 'plain' };
}

// ── the packed file ────────────────────────────────────────────────────────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function deflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/**
 * make3MF's entries as a zip with the model files deflated (method 8) and
 * the small XML stored: a shoe's model text shrinks about tenfold. Readers
 * that take 3MF take deflate (OPC requires it); read3MFMesh inflates it.
 * @param {{entries: Array<{name: string, data: string|Uint8Array}>, when?: Date}} made  make3MF's result
 * @returns {Promise<Uint8Array>}
 */
export async function pack3MF({ entries, when = new Date() }) {
  const enc = new TextEncoder(), parts = [], central = [];
  const dosTime = ((when.getHours() & 31) << 11) | ((when.getMinutes() & 63) << 5) | ((when.getSeconds() >> 1) & 31);
  const dosDate = (((when.getFullYear() - 1980) & 127) << 9) | (((when.getMonth() + 1) & 15) << 5) | (when.getDate() & 31);
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const deflate = /\.model$/.test(e.name);
    const body = deflate ? await deflateRaw(raw) : raw, method = deflate ? 8 : 0, crc = crc32(raw);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, name.length, true);
    lh.set(name, 30); parts.push(lh, body);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    ch.set(name, 46); central.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const b of [...parts, ...central, end]) { out.set(b, p); p += b.length; }
  return out;
}
