// The print profile: one printer, one process (by layer height) and its
// filaments, read from MASQ's own table vendor/print/printers.json into the
// shape the estimator, the support raster and the export read. Units are in
// the field names (mm, mm/s, mm/s², g/cm³, s).
//
// A printer row carries a `processBase` and one entry per layer height under
// `processes` that overrides it. A printer with `otherLayersFrom` answers
// every layer height its default printer has: the named process with the
// layer height replaced (its name says so). A printer with
// `otherFilamentsFrom` takes the filaments it does not list from that
// printer. Shell counts: the profile's layers, or more when that many at this
// height is thinner than the profile's shell thickness.
//
// Everything a caller may lay over a profile (LastFirst sets
// process.infillDensity and process.supportThresholdDeg per piece) is a plain
// field, so `{...profile, process: {...profile.process, infillDensity}}` works.

export const PROFILE_URL = new URL('../../vendor/print/printers.json', import.meta.url);
/** The layer height a request without one gets on the default printer. */
export const LAYER_DEFAULT_MM = 0.2;

const sameMM = (a, b) => Math.abs(a - b) < 1e-9;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects; `basis` maps are not carried into the profile. */
function over(base, top) {
  const out = { ...base };
  for (const [k, v] of Object.entries(top || {})) {
    if (k === 'basis') continue;
    out[k] = isObj(v) && isObj(base[k]) ? over(base[k], v) : v;
  }
  return out;
}

function printerRow(json, printer) {
  const key = printer || json.defaultPrinter;
  const row = json.printers && json.printers[key];
  if (!row) throw new Error('no printer ' + key + ' in the table; it has ' + Object.keys(json.printers || {}).join(', '));
  return { key, row };
}

/** The layer heights a printer's table answers, mm, ascending. */
export function layerHeightsMM(json, printer) {
  const { row } = printerRow(json, printer);
  const own = Object.values(row.processes).map((p) => p.layerHeightMM);
  if (row.otherLayersFrom != null) {
    const def = json.printers[json.defaultPrinter];
    for (const p of Object.values(def.processes)) if (!own.some((h) => sameMM(h, p.layerHeightMM))) own.push(p.layerHeightMM);
  }
  return own.sort((a, b) => a - b);
}

function shellLayers(layers, thicknessMM, layerMM) {
  if (!(thicknessMM > 0)) return layers;
  return Math.max(layers, Math.ceil(thicknessMM / layerMM - 1e-9));
}

/** The process block at `layerMM` (the printer's default height when absent). */
function processAt(json, key, row, layerMM) {
  const heights = layerHeightsMM(json, key);
  const entries = Object.values(row.processes);
  const def = row.slicerPreset && row.slicerPreset.processByLayer || {};
  if (layerMM === undefined || layerMM === null) {
    const h = entries.some((p) => sameMM(p.layerHeightMM, LAYER_DEFAULT_MM)) ? LAYER_DEFAULT_MM : entries[0].layerHeightMM;
    return processAt(json, key, row, h);
  }
  if (!heights.some((h) => sameMM(h, layerMM))) throw new Error('no process at layer height ' + layerMM + ' mm; the profile has ' + heights.join(', '));
  const hit = entries.find((p) => sameMM(p.layerHeightMM, layerMM));
  if (hit) return { block: over(row.processBase, hit), name: def[String(hit.layerHeightMM)] || `${row.name} ${hit.layerHeightMM} mm` };
  const from = row.processes[row.otherLayersFrom];
  const name = def[row.otherLayersFrom] || `${row.name} ${from.layerHeightMM} mm`;
  return { block: over(over(row.processBase, from), { layerHeightMM: layerMM }), name: `${name} at ${layerMM} mm` };
}

function buildMachine(key, row) {
  const r = row.retract;
  return {
    key,
    name: row.name,
    bedMM: row.bedMM.slice(),
    heightMM: row.heightMM,
    nozzleMM: row.nozzleMM,
    maxSpeedMMs: { ...row.maxSpeedMMs },
    maxAccelMMs2: { ...row.maxAccelMMs2 },
    corner: JSON.parse(JSON.stringify(row.corner)),
    jerkMMs: { ...(row.corner.jerkMMs || {}) },
    retractMM: r.lengthMM,
    retractSpeedMMs: r.speedMMs,
    deretractSpeedMMs: r.deretractSpeedMMs,
    retractMinTravelMM: r.minTravelMM,
    retractOnLayerChange: !!r.onLayerChange,
    zHopMM: r.zHopMM,
    wipe: !!r.wipe,
    wipeDistanceMM: r.wipeDistanceMM,
    wipeSpeedFraction: r.wipeSpeedFraction,
    startEndGcodeS: row.startEndS,
    startGcodeFilamentMM: row.startFilamentMM,
  };
}

function buildProcess(p, name) {
  const h = p.layerHeightMM;
  const s = p.speedMMs, a = p.accelMMs2, w = p.widthMM, sup = p.support;
  return {
    name,
    layerHeightMM: h,
    firstLayerHeightMM: p.firstLayerHeightMM,
    widthMM: { outer: w.outer, inner: w.inner, infill: w.sparse, solid: w.solid, top: w.top, first: w.first, support: w.support },
    wallLoops: p.wallLoops,
    topLayers: shellLayers(p.topShellLayers, p.topShellThicknessMM, h),
    bottomLayers: shellLayers(p.bottomShellLayers, p.bottomShellThicknessMM, h),
    infillDensity: p.infillDensity,
    infillPattern: p.infillPattern,
    infillWallOverlap: p.infillWallOverlap,
    minSparseAreaMM2: p.minSparseAreaMM2,
    infillAnchorMM: p.infillAnchorMM,
    onlyOneWallTop: !!p.onlyOneWallTop,
    speedMMs: {
      outer: s.outer, inner: s.inner, infill: s.sparse, solid: s.solid, top: s.top, bridge: s.bridge, gap: s.gap,
      first: s.first, firstInfill: s.firstInfill, travel: s.travel, support: s.support, supportInterface: s.supportInterface,
      overhangTotally: s.overhangTotally,
    },
    /** by unsupported quarter of the line width; 0 = the wall's own speed */
    overhangSpeedMMs: p.overhangSpeedMMs.slice(),
    overhangSpeedOn: !!p.overhangSpeedOn,
    smallPerimeterSpeedMMs: p.smallPerimeterSpeedFraction * s.outer,
    smallPerimeterThresholdMM: p.smallPerimeterThresholdMM,
    accelMMs2: { default: a.default, outer: a.outer || a.default, inner: a.inner || a.default, first: a.first || a.default, top: a.top || a.default, travel: a.travel || a.default, infill: a.sparse || a.default },
    seamGap: p.seamGapFraction,
    resolutionMM: p.resolutionMM,
    supportThresholdDeg: sup.thresholdDeg,
    supportSpacingMM: sup.baseSpacingMM,
    supportInterfaceTopLayers: sup.interfaceTopLayers,
    supportInterfaceBottomLayers: sup.interfaceBottomLayers,
    supportTopZDistanceMM: sup.topZDistanceMM,
    treeBranchAngleDeg: sup.branchAngleDeg,
    treeBranchDiameterMM: sup.branchDiameterMM,
    treeTipDiameterMM: sup.tipDiameterMM,
    treeBranchDistanceMM: sup.branchDistanceMM,
    treeBranchDiameterAngleDeg: sup.branchDiameterAngleDeg,
    treeBrimWidthMM: sup.brimWidthMM,
    initialLayerMM: p.firstLayerHeightMM,
  };
}

function buildFilaments(json, row, machine) {
  const merged = {};
  if (row.otherFilamentsFrom) Object.assign(merged, json.printers[row.otherFilamentsFrom].filaments);
  Object.assign(merged, row.filaments);
  const out = {};
  for (const [key, f] of Object.entries(merged)) {
    out[key] = {
      key,
      name: f.name,
      type: f.name,
      densityGcm3: f.densityGcm3,
      diameterMM: f.diameterMM,
      costPerKg: f.costPerKg,
      flowRatio: f.flowRatio,
      maxFlowMM3s: f.maxFlowMM3s,
      slowDownOn: !!f.slowDownOn,
      slowDownLayerTimeS: f.minLayerTimeS,
      slowDownMinSpeedMMs: f.minSpeedMMs,
      retractMM: f.retractMM != null ? f.retractMM : machine.retractMM,
      retractSpeedMMs: f.retractSpeedMMs != null ? f.retractSpeedMMs : machine.retractSpeedMMs,
    };
  }
  return out;
}

/**
 * @param {object} json  vendor/print/printers.json
 * @param {{printer?: string, layerMM?: number, siblings?: Map<number, object>}} [opts]
 */
export function makeProfile(json, opts = {}) {
  const { key, row } = printerRow(json, opts.printer);
  const { block, name } = processAt(json, key, row, opts.layerMM);
  const machine = buildMachine(key, row);
  const process = buildProcess(block, name);
  const filaments = buildFilaments(json, row, machine);
  const preset = row.slicerPreset || {};
  const siblings = opts.siblings || new Map();
  const profile = {
    source: `${row.name}: ${name}`,
    printer: key,
    machine, process, filaments, filamentKeys: Object.keys(filaments),
    layerHeightsMM: layerHeightsMM(json, key),
    slicerPreset: { app: preset.app || '', printer: preset.printer || '', process: name, filamentByMaterial: { ...(preset.filamentByMaterial || {}) } },
    /** The profile at another layer height from the same table; each is built once. */
    withLayer(layerMM) {
      if (layerMM === undefined || layerMM === null || sameMM(layerMM, process.layerHeightMM)) return profile;
      let sib = siblings.get(layerMM);
      if (!sib) { sib = makeProfile(json, { printer: key, layerMM, siblings }); siblings.set(layerMM, sib); }
      return sib;
    },
  };
  siblings.set(process.layerHeightMM, profile);
  return profile;
}

/** Every printer the table carries, each at its default layer height: {key: profile}. */
export function printerProfiles(json) {
  const out = {};
  for (const key of Object.keys(json.printers)) out[key] = makeProfile(json, { printer: key });
  return out;
}

export async function readTable(url = PROFILE_URL) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(url, 'utf8'));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('profile fetch failed: ' + r.status);
  return r.json();
}

/**
 * Loads the table (from disk under node, by fetch in a browser) and builds
 * the default printer's profile, or `opts.printer`'s.
 */
export async function loadProfile(url = PROFILE_URL, opts = {}) {
  return makeProfile(await readTable(url), opts);
}
