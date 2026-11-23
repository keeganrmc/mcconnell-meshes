// The print estimator's one entry point: a mesh in millimeters in the app's
// design frame, an orientation, a material, a printer and a support choice
// in; the card's numbers out. It composes the modules beside it:
//   mesh.js     the print frame (the export's rotation, then tilt and lean),
//               normals, the ray-cast wall for Thin
//   slice.js    the plane sweep and the raster
//   time.js     walls, skin, infill, travel and the cooling floor, timed by
//               the profile's speeds and the machine's motion limits
//   support.js  tree or normal support as a per-layer raster, always at the
//               0.5 mm cell where its fill constant was measured (the tree
//               envelope is cell-quantized: 58 g at 0.5, 39 g at 1.0 on the
//               mask dome up)
//   orient.js   the contact test and the orientation search
// and the tables: vendor/print/printers.json (every speed, width and
// filament constant, one process per layer height; profile.js reads it) and
// vendor/print/materials.json (price, CO2e, datasheet strength, wear text,
// printer presets).
//
// Layer height: `layerMM` in the options picks the process (profile.js
// withLayer); absent, the profile handed in is used as it is. The slice,
// the time model and the support raster all run at that process's layer
// and first-layer heights.
//
// Frame: `up` is the app's printUp, the mean of the head's outward normals
// under the mask, in the design frame. Tilt 0 / Lean 0 turns it to +z, the
// dome-up frame the export writes (src/exporters.js orientForPrint, handed
// the negated direction by the app), then Ry(lean)·Rx(tilt) as the plate
// shows it, then the drop onto z = 0.

import { slice } from './slice.js';
import { estimate as estimateTime } from './time.js';
import { estimateSupport, supportGrams } from './support.js';
import { contactFrom, scoreOrientation, candidates, sortRows, NAMED, BRIM_WIDTH_MM } from './orient.js';
import { frameFromUp, tiltLean, multiply, rotate, dropToPlate, faceNormalsAreas, vertexNormalsAreas, rayThickness, bounds } from './mesh.js';
import { makeProfile, printerProfiles, readTable, PROFILE_URL } from './profile.js';

export const MATERIALS_URL = new URL('../../vendor/print/materials.json', import.meta.url);
/** The support raster's cell: where SUPPORT_FILL was measured (support.js). */
export const SUPPORT_CELL_MM = 0.5;
/** The rim runs across layers where its tangent is within this of the plate normal. */
export const RIM_ACROSS_DEG = 30;
/** The shell is a stack of ribbons where its slope to the plate is under this. */
export const RIBBON_SLOPE_DEG = 25;
/** The card's honest bar: ±10% of the model's number. */
export const RANGE_FRACTION = 0.10;
/** The auto search: a coarse grid, then a finer one around its best. */
export const AUTO_COARSE_STEP_DEG = 30;
export const AUTO_FINE_STEP_DEG = 10;
export const AUTO_FINE_SPAN_DEG = 20;
export const AUTO_REFINE_TOP = 3;

async function readJSON(url) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(url, 'utf8'));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed: ' + r.status + ' ' + url);
  return r.json();
}

/**
 * The tables, once: the default printer's profile, the material table, and
 * every printer's own profile by key (a printer the table has no row for
 * falls back to the default profile in profileAt).
 * @returns {Promise<{profile: object, materials: object, printers: object}>}
 */
export async function loadTables({ profileUrl = PROFILE_URL, materialsUrl = MATERIALS_URL } = {}) {
  const [table, materials] = await Promise.all([readTable(profileUrl), readJSON(materialsUrl)]);
  return { profile: makeProfile(table), materials, printers: printerProfiles(table) };
}

/**
 * The print frame: the rotation taking `up` to +z (the dome-up frame), then
 * the tilt about x and the lean about y. Row-major 3×3 and the direction the
 * outer face faces in it.
 */
export function printFrame(up, tiltDeg = 0, leanDeg = 0) {
  const u = up && up.length === 3 ? up : [0, 0, -1];
  const F0 = frameFromUp([-u[0], -u[1], -u[2]]);
  const T = tiltLean(tiltDeg, leanDeg);
  return { M: multiply(T, F0), F0, T, outerDir: [T[2], T[5], T[8]] };
}

/** The mesh in the print frame: rotated by printFrame and dropped onto z = 0. */
export function orientMesh(mesh, up, tiltDeg = 0, leanDeg = 0) {
  const f = printFrame(up, tiltDeg, leanDeg);
  const d = dropToPlate(rotate(mesh.positions, f.M));
  return { positions: d.positions, indices: mesh.indices, offset: d.offset, ...f };
}

/** The profile at opts.layerMM, the printer's own when the tables carry one, or the one handed in. */
function profileAt(opts) {
  const p = opts.printers && opts.printer && opts.printers[opts.printer] ? opts.printers[opts.printer] : opts.profile;
  if (opts.layerMM === undefined || opts.layerMM === null) return p;
  if (!(opts.layerMM > 0)) throw new Error('layerMM must be a positive number, not ' + opts.layerMM);
  return p.withLayer ? p.withLayer(opts.layerMM) : p;
}

/** support.js's constants read off the vendor profile instead of its own table. */
function supportProfile(profile) {
  const P = profile.process;
  return {
    layerMM: P.layerHeightMM, lineWidthMM: P.widthMM.support, basePatternSpacingMM: P.supportSpacingMM,
    interfaceTopLayers: P.supportInterfaceTopLayers, interfaceBottomLayers: P.supportInterfaceBottomLayers,
    topZDistanceMM: P.supportTopZDistanceMM, thresholdDeg: P.supportThresholdDeg,
    branchAngleDeg: P.treeBranchAngleDeg, branchDiameterMM: P.treeBranchDiameterMM,
    tipDiameterMM: P.treeTipDiameterMM, branchDistanceMM: P.treeBranchDistanceMM, branchDiameterAngleDeg: P.treeBranchDiameterAngleDeg,
    brimWidthMM: P.treeBrimWidthMM, initialLayerMM: P.initialLayerMM,
  };
}

/** Area centroid of the surface in xy, for the tip-over test. */
function areaCentroidXY(positions, indices, areas) {
  let cx = 0, cy = 0, A = 0;
  for (let t = 0; t < areas.length; t++) {
    const a = areas[t]; if (a === 0) continue;
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    cx += a * (positions[i0] + positions[i1] + positions[i2]) / 3;
    cy += a * (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
    A += a;
  }
  return A > 0 ? [cx / A, cy / A] : [0, 0];
}

/**
 * Seconds per gram of support: the slice with support less the slice
 * without, over the support's grams (_verify/fixtures/print/
 * mask-full-face.support.json). Tree: Bambu Studio 02.08.03.66 on the mask
 * in three orientations and the lean plates, 404–550 s/g, the mean; its
 * branches are small hollow loops printed at their own speeds, so a gram of
 * tree costs 3× a gram of normal. Normal: 01.09.05.51 on the mask dome up,
 * (29419 − 12079) / 168.96.
 */
export const SUPPORT_SECONDS_PER_GRAM = Object.freeze({ tree: 470, normal: 102.6 });

function supportSeconds(regime, support, grams) {
  return regime ? grams * SUPPORT_SECONDS_PER_GRAM[support] : 0;
}

/** The rim outline is read in this many bearings; the crest's vertex jitter (±half a wall) over a 3° chord stays far under RIM_ACROSS_DEG. */
const RIM_BINS = 120;

/**
 * The rim, and how much of it runs across layers. The rim is the opening's
 * edge: seen from a point in the cavity behind the mask (the outline's
 * centre, half the height under the plate, in the dome-up frame), the shell
 * is a bowl and its rim is the vertex of largest polar angle in each bearing
 * around the axis. Those vertices, smoothed over three bearings, are a
 * closed polyline; its tangents are turned into the print frame and the
 * length whose tangent is within RIM_ACROSS_DEG of the plate normal is
 * summed. Dome up the rim lies flat; on the chin the cheek sides run
 * vertically; a hemisphere on its side has a third of its rim across.
 */
function rimAcrossMM(domeUpPositions, T) {
  const n = domeUpPositions.length / 3;
  if (n < 3) return { rimMM: 0, rimLengthMM: 0, points: [] };
  let cx = 0, cy = 0, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    cx += domeUpPositions[i * 3]; cy += domeUpPositions[i * 3 + 1];
    const z = domeUpPositions[i * 3 + 2];
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  cx /= n; cy /= n;
  const cz = zMin - 0.5 * (zMax - zMin);
  const widest = new Float64Array(RIM_BINS).fill(-Infinity), who = new Int32Array(RIM_BINS).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = domeUpPositions[i * 3] - cx, y = domeUpPositions[i * 3 + 1] - cy, z = domeUpPositions[i * 3 + 2] - cz;
    const polar = Math.atan2(Math.hypot(x, y), z);
    const b = ((Math.atan2(y, x) / (2 * Math.PI) + 1) * RIM_BINS) % RIM_BINS | 0;
    if (polar > widest[b]) { widest[b] = polar; who[b] = i; }
  }
  const raw = [];
  for (let b = 0; b < RIM_BINS; b++) if (who[b] >= 0) { const i = who[b] * 3; raw.push([domeUpPositions[i], domeUpPositions[i + 1], domeUpPositions[i + 2]]); }
  const m = raw.length;
  if (m < 3) return { rimMM: 0, rimLengthMM: 0, points: [] };
  const pts = [];
  for (let i = 0; i < m; i++) {
    const a = raw[(i + m - 1) % m], b = raw[i], c = raw[(i + 1) % m];
    const x = (a[0] + b[0] + c[0]) / 3, y = (a[1] + b[1] + c[1]) / 3, z = (a[2] + b[2] + c[2]) / 3;
    pts.push([T[0] * x + T[1] * y + T[2] * z, T[3] * x + T[4] * y + T[5] * z, T[6] * x + T[7] * y + T[8] * z]);
  }
  const cosA = Math.cos(RIM_ACROSS_DEG * Math.PI / 180);
  let across = 0, total = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L === 0) continue;
    total += L;
    if (Math.abs(dz) / L >= cosA) across += L;
  }
  return { rimMM: across, rimLengthMM: total, points: pts };
}

/**
 * @param {{positions: Float32Array, indices: Uint32Array}} meshMM  design frame, millimeters
 * @param {object} opts
 * @param {import('./profile.js').Profile} opts.profile
 * @param {object} opts.materials  vendor/print/materials.json
 * @param {number[]} [opts.up]  the app's printUp
 * @param {number} [opts.tiltDeg]
 * @param {number} [opts.leanDeg]
 * @param {string} [opts.material]  a key of the profile's filaments
 * @param {string} [opts.printer]  a key of materials.printers
 * @param {'tree'|'normal'|'none'} [opts.support]
 * @param {number} [opts.layerMM]  the layer height; one the profile carries a process for
 * @param {number} [opts.cellMM]  the slicer's raster; the support runs at SUPPORT_CELL_MM regardless
 * @param {number} [opts.wallMM]  the student's minimum wall, the Thin threshold
 * @param {number} [opts.pricePerKg]  the student's price; 0 or absent reads the table's
 */
export function estimatePrint(meshMM, opts) {
  const t0 = performance.now();
  const { materials } = opts;
  if (!opts.profile || !materials) throw new Error('estimatePrint needs the profile and the material table');
  const profile = profileAt(opts);
  const material = opts.material || 'pla', printer = opts.printer || 'x1c', support = opts.support || 'tree';
  const cellMM = opts.cellMM > 0 ? opts.cellMM : 0.5, wallMM = opts.wallMM > 0 ? opts.wallMM : 1.65;
  const F = profile.filaments[material];
  if (!F) throw new Error('no filament ' + material);
  const mat = materials.materials[material];
  if (!mat) throw new Error('no material ' + material);
  const pr = materials.printers[printer];
  if (!pr) throw new Error('no printer ' + printer);
  if (!['tree', 'normal', 'none'].includes(support)) throw new Error('support is tree, normal or none, not ' + support);
  const P = profile.process, M = profile.machine;
  const ms = {};
  const lap = (key, since) => { const now = performance.now(); ms[key] = Math.round(now - since); return now; };

  // the print frame
  let t = t0;
  const o = orientMesh(meshMM, opts.up, opts.tiltDeg || 0, opts.leanDeg || 0);
  const mesh = { positions: o.positions, indices: o.indices };
  const bb = bounds(o.positions);
  t = lap('orient', t);

  // walls, skin, infill, travel, the floor
  const slices = slice(mesh, { layerHeightMM: P.layerHeightMM, firstLayerHeightMM: P.firstLayerHeightMM, cellMM });
  t = lap('slice', t);
  const time = estimateTime(slices, profile, material);
  t = lap('time', t);

  // support and contact from one raster
  const sup = estimateSupport(mesh, { cellMM: SUPPORT_CELL_MM, layerMM: P.layerHeightMM, outerDir: o.outerDir, profile: supportProfile(profile), tree: support === 'tree',
    slabMM: opts.supportSlabMM > 0 ? opts.supportSlabMM : 0 });
  const regime = support === 'tree' ? sup.tree : support === 'normal' ? sup.normal : null;
  const supportG = regime ? supportGrams(regime, { density: F.densityGcm3 }) : 0;
  t = lap('support', t);
  const face = faceNormalsAreas(o.positions, o.indices);
  const contact = contactFrom(sup, areaCentroidXY(o.positions, o.indices, face.areas));
  const stable = contact.hullWidthMM >= BRIM_WIDTH_MM * 4 && contact.centroidInside;
  t = lap('contact', t);

  // Thin: the outer face's vertices whose wall is under the student's minimum
  const vert = vertexNormalsAreas(o.positions, o.indices, face);
  const thick = rayThickness(o.positions, o.indices, vert.normals, Math.max(wallMM * 4, 10));
  const od = o.outerDir;
  let faceArea = 0, thinArea = 0;
  for (let v = 0; v < vert.areas.length; v++) {
    if (vert.normals[v * 3] * od[0] + vert.normals[v * 3 + 1] * od[1] + vert.normals[v * 3 + 2] * od[2] <= 0) continue;
    faceArea += vert.areas[v];
    if (thick[v] < wallMM) thinArea += vert.areas[v];
  }
  t = lap('thin', t);

  // Layers: the rim across layers, the outer face as a stack of ribbons
  const domeUp = rotate(meshMM.positions, o.F0);
  const rim = rimAcrossMM(domeUp, o.T);
  const cosRibbon = Math.cos(RIBBON_SLOPE_DEG * Math.PI / 180);
  let cheekArea = 0;
  for (let f = 0; f < face.areas.length; f++) {
    const nx = face.normals[f * 3], ny = face.normals[f * 3 + 1], nz = face.normals[f * 3 + 2];
    if (nx * od[0] + ny * od[1] + nz * od[2] <= 0) continue;
    if (Math.abs(nz) >= cosRibbon) cheekArea += face.areas[f];
  }
  t = lap('layers', t);

  // seconds: the time model's keys folded to the card's, the cooling floor its own part
  const S = time.totals.seconds;
  let walls = S.outerWall + S.innerWall + S.overhang, skin = S.top + S.bottom + S.bridge, infill = S.gap + S.solid + S.sparse;
  const adjustable = walls - S.overhang + skin - S.bridge + infill;
  const floor = Math.min(S.floor, adjustable);
  if (adjustable > 0) {
    const k = floor / adjustable;
    walls -= (walls - S.overhang) * k; skin -= (skin - S.bridge) * k; infill -= infill * k;
  }
  const travel = S.travel + S.retract;
  const supportS = supportSeconds(regime, support, supportG);
  const startEnd = M.startEndGcodeS;
  const total = walls + skin + infill + travel + floor + supportS + startEnd;

  // grams, metres, cost, CO2e
  const flowArea = Math.PI * (F.diameterMM / 2) ** 2;
  const gramsModel = time.totals.grams, gramsTotal = gramsModel + supportG;
  const metres = time.totals.metres + supportG / (F.densityGcm3 * flowArea);
  const price = opts.pricePerKg > 0 ? opts.pricePerKg : mat.priceUSDPerKg;
  const hours = total / 3600;
  const electricityKg = pr.printingW * hours / 1000 * materials.electricityKgCO2ePerKWh;
  const ef = mat.co2eKgPerKg;
  const filamentKg = gramsTotal / 1000 * ef.mid;
  const zxy = mat.tensileMPa.z / mat.tensileMPa.xy;

  const result = {
    seconds: { total, walls, skin, infill, support: supportS, travel, floor, startEnd },
    secondsRange: [total * (1 - RANGE_FRACTION), total * (1 + RANGE_FRACTION)],
    grams: { model: gramsModel, support: supportG, total: gramsTotal },
    metres,
    costUSD: gramsTotal / 1000 * price,
    pricePerKg: price,
    co2e: { filamentKg, electricityKg, total: filamentKg + electricityKg, lo: gramsTotal / 1000 * ef.lo + electricityKg, hi: gramsTotal / 1000 * ef.hi + electricityKg, kWh: pr.printingW * hours / 1000 },
    supportFootprintMM2: { outer: regime ? regime.footprintOuterMM2 : 0, inner: regime ? regime.footprintInnerMM2 : 0 },
    /* the support drawn: slabs of discs in the print frame (mm, before the
     * drop's offset is undone), the offset beside them */
    supportGeometry: regime && regime.slabs ? { offsetMM: o.offset, slabs: regime.slabs, slabMM: opts.supportSlabMM, chains: regime.chains || null } : null,
    supportMM3: regime ? regime.envelopeMM3 : 0,
    contact: { stable, rimMM: contact.rimMM, spots: contact.components, brim: !stable, areaMM2: contact.areaMM2, hullWidthMM: contact.hullWidthMM },
    layers: time.totals.layers,
    heightMM: time.totals.heightMM,
    bboxMM: bb.size,
    fitsPlate: bb.size[0] <= pr.bedMM[0] && bb.size[1] <= pr.bedMM[1] && bb.size[2] <= pr.bedMM[2],
    plateMM: pr.bedMM,
    thin: { fractionOfFace: faceArea > 0 ? thinArea / faceArea : 0, mm2: thinArea, wallMM, faceMM2: faceArea },
    layersAcross: {
      rimMM: rim.rimMM, rimLengthMM: rim.rimLengthMM, cheekAreaMM2: cheekArea,
      note: `${rim.rimMM.toFixed(0)} mm of rim runs within ${RIM_ACROSS_DEG}° of the layer normal; ${(cheekArea / 100).toFixed(0)} cm² of the outer face lies under ${RIBBON_SLOPE_DEG}° to the plate, a stack of ribbons`,
    },
    materialLines: [
      mat.wear,
      `${mat.name} across layers: ${Math.round(zxy * 100)}% of in plane (datasheet ${mat.tensileMPa.z} / ${mat.tensileMPa.xy} MPa)`,
    ],
    material, printer, support, tiltDeg: opts.tiltDeg || 0, leanDeg: opts.leanDeg || 0, cellMM,
    layerMM: P.layerHeightMM, processName: P.name,
    ms,
    msEstimate: 0,
  };
  result.msEstimate = Math.round(performance.now() - t0);
  return result;
}

/** The time model alone for one orientation: the print frame, the slice, the layers. */
function timeFor(meshMM, opts, tiltDeg, leanDeg) {
  const P = opts.profile.process;
  const o = orientMesh(meshMM, opts.up, tiltDeg, leanDeg);
  const slices = slice({ positions: o.positions, indices: o.indices }, { layerHeightMM: P.layerHeightMM, firstLayerHeightMM: P.firstLayerHeightMM, cellMM: opts.cellMM > 0 ? opts.cellMM : 0.5 });
  return estimateTime(slices, opts.profile, opts.material || 'pla');
}

/**
 * The ranking, one candidate per step so a worker can yield between them.
 * Yields {step, of, name} after each candidate; returns {rows}: the four
 * named orientations in order, then auto, each with tree and normal support
 * grams at the fitted raster, the time estimate at opts.cellMM (the model
 * plus the chosen support), the outer-face footprint, the height and whether
 * it stands. Auto is the winner under opts.objective ('support' | 'cost' |
 * 'finish', as orient.js sorts) among the named four and a coarse grid
 * refined around its best, the finalists re-scored at the fitted raster.
 */
export function* rankPrint(meshMM, opts) {
  const profile = profileAt(opts);
  opts = { ...opts, profile };
  const P = profile.process;
  const material = opts.material || 'pla', support = opts.support || 'tree';
  const F = profile.filaments[material];
  if (!F) throw new Error('no filament ' + material);
  const frame0 = printFrame(opts.up, 0, 0);
  const domeUp = { positions: rotate(meshMM.positions, frame0.F0), indices: meshMM.indices };
  const sp = supportProfile(profile), density = F.densityGcm3;
  const fine = { cellMM: SUPPORT_CELL_MM, layerMM: P.layerHeightMM, profile: sp, density };
  const coarse = { cellMM: 2, layerMM: 1, profile: sp, density };
  const rowOf = (name, score) => {
    const time = timeFor(meshMM, opts, score.tiltDeg, score.leanDeg);
    const regime = support === 'tree' ? score.tree : support === 'normal' ? score.normal : null;
    const S = time.totals.seconds;
    let seconds = profile.machine.startEndGcodeS + supportSeconds(regime, support, support === 'tree' ? score.supportTreeG : score.supportNormalG);
    for (const k of Object.keys(S)) if (k !== 'floor') seconds += S[k];
    return {
      name, tiltDeg: score.tiltDeg, leanDeg: score.leanDeg,
      supportGrams: { tree: score.supportTreeG, normal: score.supportNormalG },
      seconds, footprintOuterMM2: score.footprintOuterMM2, footprintInnerMM2: score.footprintInnerMM2,
      heightMM: score.heightMM, stable: !score.unstable, cost: score.cost,
    };
  };
  const named = NAMED.map((n) => ({ ...n }));
  const grid = candidates(AUTO_COARSE_STEP_DEG).filter((c) => !c.name);
  const of = named.length + grid.length + 1;
  let step = 0;
  const rows = [], namedScores = [];
  for (const cand of named) {
    const score = scoreOrientation(domeUp, cand, fine);
    namedScores.push(score);
    rows.push(rowOf(cand.name, score));
    yield { step: ++step, of, name: cand.name };
  }
  // auto: the coarse grid, a finer grid around its best, then the top few and the named four at the fitted raster
  const objective = opts.objective || 'support';
  const scored = [], seen = new Set(named.map((n) => n.tiltDeg + '/' + n.leanDeg));
  const scoreCoarse = (tiltDeg, leanDeg) => {
    const key = tiltDeg + '/' + leanDeg;
    if (seen.has(key)) return;
    seen.add(key);
    scored.push({ ...scoreOrientation(domeUp, { name: '', tiltDeg, leanDeg }, coarse), index: scored.length });
  };
  for (const cand of grid) { scoreCoarse(cand.tiltDeg, cand.leanDeg); yield { step: ++step, of, name: 'auto' }; }
  for (const b of sortRows(scored, objective).slice(0, AUTO_REFINE_TOP)) {
    for (let dt = -AUTO_FINE_SPAN_DEG; dt <= AUTO_FINE_SPAN_DEG; dt += AUTO_FINE_STEP_DEG) for (let dl = -AUTO_FINE_SPAN_DEG; dl <= AUTO_FINE_SPAN_DEG; dl += AUTO_FINE_STEP_DEG) {
      const tilt = b.tiltDeg + dt, lean = b.leanDeg + dl;
      if (tilt >= -180 && tilt <= 180 && lean >= -90 && lean <= 90) scoreCoarse(tilt, lean);
    }
  }
  const finals = sortRows(scored, objective).slice(0, AUTO_REFINE_TOP).map((r, index) => ({ ...scoreOrientation(domeUp, { name: '', tiltDeg: r.tiltDeg, leanDeg: r.leanDeg }, fine), index }));
  namedScores.forEach((sc, i) => finals.push({ ...sc, index: finals.length + i }));
  const win = sortRows(finals, objective)[0];
  rows.push(win.name ? { ...rows[named.findIndex((n) => n.name === win.name)], name: 'auto' } : rowOf('auto', win));
  yield { step: ++step, of, name: 'auto' };
  return { rows, layerMM: P.layerHeightMM };
}
