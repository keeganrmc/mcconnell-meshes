// The print-time and filament model. Input: the slices of a mesh in its
// print pose (slice.js) and a profile (profile.js). Output: seconds per
// toolpath feature, the cooling floor, grams and metres.
//
// Per layer the toolpaths are not drawn; their lengths and corner counts are
// measured from the layer's polygons and raster, then timed with the
// machine's motion rules:
//
//   walls      `wallLoops` loops per contour, loop i centred at d_i inside
//              the contour (half the outer line, then one line spacing per
//              loop). The local ribbon width W at each contour segment is the
//              distance to the opposite side along the inward normal; loop i
//              exists along that segment while d_i < W/2. The outer loop is
//              timed along the contour's own vertices; the inner loops by the
//              same walk at their own speed, scaled by their length.
//   overhang   the part of each outer-wall segment's line that hangs past the
//              layer below, as a share of the line width, in quarter-width
//              bands; each band runs at the profile's speed for it.
//   gap fill   the ribbon left between the facing last loops where it is too
//              narrow for the interior fill: a single line down its middle.
//   interior   the area inside the walls, split by the raster: top (nothing
//              above), bridge (nothing below, or solid over sparse), bottom
//              (the first layer), internal solid (within the shell layers of
//              a top or a bottom) and sparse. Line length = area / spacing
//              (sparse: × density × the pattern's factor); the lines are
//              zig-zags of the region's mean chord (Cauchy: π·A/P), each line
//              ending in a turn.
//   travel     one retracted move per island, per interior region and per gap
//              run, plus the layer change: retract, z-hop up and down, the
//              move, de-retract.
//
// Line spacing and cross-section: the rounded-rectangle bead, spacing =
// w − h(1 − π/4), area = h × spacing (Prusa Knowledge Base, "Extrusion
// width"). A bridge line is round, of the nozzle's diameter.
//
// Motion: every run of moves is timed with a trapezoidal velocity profile
// (accelerate, cruise, decelerate; a triangle when too short), entry and
// exit speeds limited at each junction and made reachable by a backward and
// a forward pass (Klipper docs, "Kinematics": look-ahead). Junction rule: the
// per-axis jerk rule (Marlin docs, "Classic Jerk") or junction deviation
// (Marlin docs, "Junction Deviation"; Klipper's square corner velocity),
// chosen by the printer row. Chords of a curve whose turn is under
// ARC_TURN_DEG are one smooth path, limited by the centripetal acceleration
// v ≤ √(a·r).
//
// Speeds: the process's speed per feature, capped by the filament's maximum
// volumetric flow (v ≤ flow / area) and the machine's axis limit.
//
// Cooling floor: a layer faster than the filament's minimum layer time has
// its adjustable moves (all but overhang walls, bridges and travel) slowed,
// fastest first, toward one common speed no lower than the filament's
// minimum speed, until the layer takes the minimum time ("slow printing down
// for better layer cooling", Prusa Knowledge Base, "Cooling").

import { cellAt } from './slice.js';

/** The kind-(c) coefficients, fitted by tools/print/fit_time.mjs. */
export const FIT = Object.freeze({
  /** a vertex turning less than this joins its chords into one curve */
  ARC_TURN_DEG: 3.93,
  /** mean infill line length, × the region's mean chord */
  LINE_CHORD_FACTOR: 0.658,
  /** the ribbon between the last loops is gap fill under this many line spacings, interior fill above */
  GAP_MAX_SPACINGS: 1.5,
  /** a gap narrower than this (mm) is left empty */
  GAP_MIN_MM: 0.1,
  /** travel length per event, × the layer's bounding-box diagonal */
  TRAVEL_DIAG_FRACTION: 0.294,
  /** retracted travels per gap-fill run and per interior region */
  TRAVEL_PER_RUN: 0.421,
  /** sparse line length per (area × density / spacing), by pattern */
  PATTERN_FACTOR: { grid: 1.0, gyroid: 1.0, rectilinear: 1.0, line: 1.0, cubic: 1.0, honeycomb: 1.0, triangles: 1.0 },
  /** the span (mm, each side of a vertex) a path's direction and curvature are read over */
  SMOOTH_MM: 0.5,
  /** the speed a run starts from rest at, × the corner rule's 90° speed */
  START_SPEED_FACTOR: 1.3,
  /** the speed at a zig-zag line's turn, × the corner rule's 90° speed */
  TURN_SPEED_FACTOR: 1.385,
  /** interior narrower than this (mm, between the last loops) is filled along the walls */
  CONCENTRIC_MAX_MM: 10,
  /** 1: a cell within a cell of a sloping exposure counts as within the shells' reach; 0: only the cell's own column */
  SHELL_REACH_ERODE: 1,
  /** overhang under this (mm) counts as supported */
  OVERHANG_GRACE_MM: 0,
  /** under this layer height a partly overhung outer line is banded by the share its slope gives at this height */
  OVERHANG_REF_LAYER_MM: 0.165,
});

const DEG = Math.PI / 180;
const spacingOf = (w, h) => w - h * (1 - Math.PI / 4);

/* ---------- motion ---------- */

/** Seconds for one move of length L from entry speed u to exit speed w, cruise V, acceleration a. */
export function moveSeconds(L, u, w, V, a) {
  if (!(L > 0)) return 0;
  if (V <= 0) return 0;
  u = Math.min(u, V); w = Math.min(w, V);
  const dAcc = (V * V - u * u) / (2 * a), dDec = (V * V - w * w) / (2 * a);
  if (dAcc + dDec <= L) return (V - u) / a + (V - w) / a + (L - dAcc - dDec) / V;
  const vp = Math.sqrt(Math.max(0, (2 * a * L + u * u + w * w) / 2));
  return Math.max(0, (vp - u) / a) + Math.max(0, (vp - w) / a);
}

/** The speed allowed through a corner turning by `turn` radians (0 = straight). */
function cornerSpeed(corner, turn, a) {
  if (turn < 1e-9) return Infinity;
  if (corner.rule === 'deviation') {
    const dev = corner.deviationMM != null ? corner.deviationMM
      : (corner.squareCornerMMs || 5) ** 2 * (Math.SQRT2 - 1) / a;
    const c = Math.cos(turn / 2);
    if (c < 1e-9) return 0;
    return Math.sqrt(a * dev * c / (1 - c));
  }
  const jerk = corner.jerkMMs ? Math.min(corner.jerkMMs.x, corner.jerkMMs.y) : 9;
  return jerk / (2 * Math.sin(turn / 2));
}

/**
 * A closed or open run of segments: lengths L, cruise speeds V, the speed
 * limit at each inner junction J (J[i] between segment i−1 and i; J[0]
 * unused), one acceleration, and the speed at both ends. Returns the seconds
 * per segment in `out` and their sum.
 */
function runSeconds(n, L, V, J, a, vEnds, out) {
  const e = runSeconds.e.length >= n ? runSeconds.e : (runSeconds.e = new Float64Array(n * 2));
  // exit limit of segment i = the junction into i+1
  for (let i = 0; i < n - 1; i++) e[i] = Math.min(J[i + 1], V[i], V[i + 1]);
  e[n - 1] = Math.min(vEnds, V[n - 1]);
  for (let i = n - 2; i >= 0; i--) { const lim = Math.sqrt(e[i + 1] * e[i + 1] + 2 * a * L[i + 1]); if (e[i] > lim) e[i] = lim; }
  let u = Math.min(vEnds, V[0]), total = 0;
  for (let i = 0; i < n; i++) {
    const lim = Math.sqrt(u * u + 2 * a * L[i]);
    if (e[i] > lim) e[i] = lim;
    const t = moveSeconds(L[i], u, e[i], V[i], a);
    if (out) out[i] = t;
    total += t;
    u = e[i];
  }
  return total;
}
runSeconds.e = new Float64Array(1024);

/** n identical zig-zag lines of length ℓ joined by connectors of length s turning 90° twice. */
function zigzagSeconds(totalLength, lineMM, s, V, a, vTurn) {
  if (!(totalLength > 0)) return 0;
  const n = Math.max(1, totalLength / Math.max(lineMM, 1e-3));
  const per = moveSeconds(Math.min(lineMM, totalLength), vTurn, vTurn, V, a) + moveSeconds(s, vTurn, vTurn, V, a);
  return n * per;
}

/* ---------- per-layer geometry ---------- */

/** A segment grid over one layer's loops, for short ray casts. */
function segmentGrid(loops, cell) {
  let nSeg = 0;
  for (const q of loops) nSeg += q.length >> 1;
  const ax = new Float64Array(nSeg), ay = new Float64Array(nSeg), bx = new Float64Array(nSeg), by = new Float64Array(nSeg);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, s = 0;
  for (const q of loops) {
    const m = q.length;
    for (let i = 0; i < m; i += 2) {
      const j = (i + 2) % m;
      ax[s] = q[i]; ay[s] = q[i + 1]; bx[s] = q[j]; by[s] = q[j + 1]; s++;
      if (q[i] < x0) x0 = q[i]; if (q[i] > x1) x1 = q[i];
      if (q[i + 1] < y0) y0 = q[i + 1]; if (q[i + 1] > y1) y1 = q[i + 1];
    }
  }
  if (!nSeg) return null;
  x0 -= cell; y0 -= cell;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 2), ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 2);
  const count = new Int32Array(nx * ny + 1);
  const span = (k, f) => {
    const i0 = Math.floor((Math.min(ax[k], bx[k]) - x0) / cell), i1 = Math.floor((Math.max(ax[k], bx[k]) - x0) / cell);
    const j0 = Math.floor((Math.min(ay[k], by[k]) - y0) / cell), j1 = Math.floor((Math.max(ay[k], by[k]) - y0) / cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * nx + i);
  };
  for (let k = 0; k < nSeg; k++) span(k, (c) => { count[c + 1]++; });
  for (let c = 0; c < nx * ny; c++) count[c + 1] += count[c];
  const fill = count.slice(0, nx * ny), items = new Int32Array(count[nx * ny]);
  for (let k = 0; k < nSeg; k++) span(k, (c) => { items[fill[c]++] = k; });
  return { cell, x0, y0, nx, ny, start: count, items, ax, ay, bx, by, n: nSeg, w: x1 - x0, h: y1 - y0, stamp: new Int32Array(nSeg), tick: 0 };
}

/** Does the ray (dx, dy) cross segment k into the solid (the solid is on each segment's left)? */
function entersAt(g, k, dx, dy) {
  return (-(g.by[k] - g.ay[k])) * dx + (g.bx[k] - g.ax[k]) * dy > 0;
}

/** The nearest crossing of the ray p + t·d (|d| = 1, 0 < t ≤ tMax) with the grid's segments, skipping `skip`; Infinity when none. */
function castRay(g, px, py, dx, dy, tMax, skip) {
  if (!g) return Infinity;
  const c = g.cell;
  let i = Math.floor((px - g.x0) / c), j = Math.floor((py - g.y0) / c);
  const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity, tdy = dy !== 0 ? Math.abs(c / dy) : Infinity;
  let tx = dx !== 0 ? ((dx > 0 ? (i + 1) * c : i * c) + g.x0 - px) / dx : Infinity;
  let ty = dy !== 0 ? ((dy > 0 ? (j + 1) * c : j * c) + g.y0 - py) / dy : Infinity;
  let best = Infinity;
  castRay.hit = -1;
  const tick = ++g.tick;
  for (let guard = 0; guard < 64; guard++) {
    if (i >= 0 && j >= 0 && i < g.nx && j < g.ny) {
      const cIdx = j * g.nx + i;
      for (let q = g.start[cIdx]; q < g.start[cIdx + 1]; q++) {
        const k = g.items[q];
        if (k === skip || g.stamp[k] === tick) continue;
        g.stamp[k] = tick;
        const ex = g.bx[k] - g.ax[k], ey = g.by[k] - g.ay[k];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const qx = g.ax[k] - px, qy = g.ay[k] - py;
        const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
        if (t > 1e-6 && t <= tMax && u >= 0 && u <= 1 && t < best) { best = t; castRay.hit = k; }
      }
    }
    const tNext = Math.min(tx, ty);
    if (tNext > Math.min(tMax, best)) break;
    if (tx < ty) { tx += tdx; i += stepI; } else { ty += tdy; j += stepJ; }
  }
  return best;
}

/* ---------- raster helpers ---------- */

function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function count(bits) { let n = 0; for (let i = 0; i < bits.length; i++) if (bits[i]) n += popcount32(bits[i]); return n; }

/** Cells whose four neighbours are also set (one-cell erosion), row-major packed rows. */
function erode(bits, rows, words, out) {
  for (let r = 0; r < rows; r++) {
    const b = r * words;
    for (let w = 0; w < words; w++) {
      const v = bits[b + w];
      if (!v) { out[b + w] = 0; continue; }
      const left = (v << 1) | (w > 0 ? bits[b + w - 1] >>> 31 : 0);
      const right = (v >>> 1) | (w + 1 < words ? (bits[b + w + 1] & 1) << 31 : 0);
      const up = r + 1 < rows ? bits[b + words + w] : 0, down = r > 0 ? bits[b - words + w] : 0;
      out[b + w] = v & left & right & up & down;
    }
  }
  return out;
}

/** Cells set or next to a set cell (one-cell dilation). */
function dilate(bits, rows, words, out) {
  for (let r = 0; r < rows; r++) {
    const b = r * words;
    for (let w = 0; w < words; w++) {
      const v = bits[b + w];
      const left = (v << 1) | (w > 0 ? bits[b + w - 1] >>> 31 : 0);
      const right = (v >>> 1) | (w + 1 < words ? (bits[b + w + 1] & 1) << 31 : 0);
      const up = r + 1 < rows ? bits[b + words + w] : 0, down = r > 0 ? bits[b - words + w] : 0;
      out[b + w] = v | left | right | up | down;
    }
  }
  return out;
}

/** Drops sparse regions (4-connected) under `minCells` cells into `solid`. */
function smallSparseToSolid(sparse, solid, rows, words, cols, minCells) {
  if (!(minCells > 1)) return;
  const seen = new Uint8Array(rows * cols);
  const stack = [];
  const get = (r, c) => (sparse[r * words + (c >> 5)] >>> (c & 31)) & 1;
  for (let r = 0; r < rows; r++) for (let w = 0; w < words; w++) {
    let v = sparse[r * words + w];
    while (v) {
      const bit = 31 - Math.clz32(v & -v);
      v &= v - 1;
      const c0 = (w << 5) + bit;
      if (c0 >= cols || seen[r * cols + c0]) continue;
      const comp = [];
      stack.push(r * cols + c0); seen[r * cols + c0] = 1;
      while (stack.length) {
        const p = stack.pop(); comp.push(p);
        if (comp.length >= minCells) { stack.length = 0; break; }
        const pr = (p / cols) | 0, pc = p - pr * cols;
        if (pc > 0 && !seen[p - 1] && get(pr, pc - 1)) { seen[p - 1] = 1; stack.push(p - 1); }
        if (pc + 1 < cols && !seen[p + 1] && get(pr, pc + 1)) { seen[p + 1] = 1; stack.push(p + 1); }
        if (pr > 0 && !seen[p - cols] && get(pr - 1, pc)) { seen[p - cols] = 1; stack.push(p - cols); }
        if (pr + 1 < rows && !seen[p + cols] && get(pr + 1, pc)) { seen[p + cols] = 1; stack.push(p + cols); }
      }
      if (comp.length < minCells) for (const p of comp) {
        const pr = (p / cols) | 0, pc = p - pr * cols, idx = pr * words + (pc >> 5), m = 1 << (pc & 31);
        sparse[idx] &= ~m; solid[idx] |= m;
      }
    }
  }
}

/* ---------- the model ---------- */

const KEYS = ['outerWall', 'innerWall', 'overhang', 'gap', 'solid', 'top', 'bottom', 'bridge', 'sparse', 'travel', 'retract'];
const ADJUSTABLE = { outerWall: 1, innerWall: 1, gap: 1, solid: 1, top: 1, bottom: 1, sparse: 1 };

/**
 * @param {import('./slice.js').Slices} slices
 * @param {object} profile  profile.js
 * @param {string} filamentKey
 * @param {{overhang?: boolean, flowCap?: boolean, cooling?: boolean, arcs?: boolean, fit?: object}} [opt]
 */
export function estimate(slices, profile, filamentKey, opt = {}) {
  const useOverhang = opt.overhang !== false, useFlowCap = opt.flowCap !== false, useCooling = opt.cooling !== false, useArcs = opt.arcs !== false;
  const fit = { ...FIT, ...(opt.fit || {}) };
  const M = profile.machine, P = profile.process, F = profile.filaments[filamentKey];
  if (!F) throw new Error('no filament ' + filamentKey + ' in the profile; it has ' + profile.filamentKeys.join(', '));
  const h = slices.layerHeightMM, h0 = slices.firstLayerHeightMM;
  const nozzle = M.nozzleMM;
  const corner = M.corner || { rule: 'jerk', jerkMMs: M.jerkMMs };
  const vAxis = Math.min(M.maxSpeedMMs.x, M.maxSpeedMMs.y);
  const aMax = M.maxAccelMMs2.extruding || Math.min(M.maxAccelMMs2.x, M.maxAccelMMs2.y);
  const aTravelMax = M.maxAccelMMs2.travel || aMax;
  const flow = F.maxFlowMM3s;
  const cap = (v, area) => Math.min(v, vAxis, useFlowCap && flow > 0 && area > 0 ? flow / area : Infinity);
  const acc = (a) => Math.min(a || P.accelMMs2.default, aMax);
  const ovSpeeds = P.overhangSpeedMMs, ovTotal = P.speedMMs.overhangTotally;
  const arcTurn = fit.ARC_TURN_DEG * DEG;
  const turn90 = (a) => cornerSpeed(corner, Math.PI / 2, a);

  const grid = slices.grid, rows = grid.rows, words = grid.words, cols = grid.cols, cellA = grid.cellMM * grid.cellMM;
  const nW = rows * words;
  const dilA = new Uint32Array(nW), dilB = new Uint32Array(nW);
  const tmpE = new Uint32Array(nW), clsSolid = new Uint32Array(nW), clsTop = new Uint32Array(nW), clsBridge = new Uint32Array(nW);
  let sparsePrev = new Uint32Array(nW), sparseNow = new Uint32Array(nW);
  const layersIn = slices.layers;
  const K = layersIn.length;
  // the occupancy shrunk by a cell: a cell near a sloping exposure is within the shells' reach
  const eroded = fit.SHELL_REACH_ERODE ? layersIn.map((L) => erode(L.raster, rows, words, new Uint32Array(nW))) : layersIn.map((L) => L.raster);
  const minSparseCells = P.minSparseAreaMM2 > 0 ? Math.ceil(P.minSparseAreaMM2 / cellA) : 0;
  const patternFactor = fit.PATTERN_FACTOR[P.infillPattern] ?? 1;

  const totals = Object.fromEntries(KEYS.map((k) => [k, 0]));
  totals.floor = 0;
  let volume = 0, retractEvents = 0, layersPrinted = 0, topZ = 0;
  const volByKey = { outerWall: 0, overhang: 0, innerWall: 0, gap: 0, top: 0, solid: 0, sparse: 0, bottom: 0, bridge: 0 };
  const outLayers = [];
  let gPrev = null;
  const segBuf = { L: new Float64Array(256), V: new Float64Array(256), J: new Float64Array(256), T: new Float64Array(256), ov: new Uint8Array(256) };
  const grow = (n) => { if (segBuf.L.length < n) { const m = n * 2; segBuf.L = new Float64Array(m); segBuf.V = new Float64Array(m); segBuf.J = new Float64Array(m); segBuf.T = new Float64Array(m); segBuf.ov = new Uint8Array(m); } };

  for (let k = 0; k < K; k++) {
    const layer = layersIn[k];
    const loops = layer.loops.filter((q) => q.length >= 6);
    if (!loops.length) { gPrev = null; continue; }
    const first = k === 0;
    const hk = first ? h0 : h;
    // widths and speeds for this layer
    const wO = first ? P.widthMM.first : P.widthMM.outer, wI = first ? P.widthMM.first : P.widthMM.inner;
    const sO = spacingOf(wO, hk), sI = spacingOf(wI, hk);
    const wS = first ? P.widthMM.first : P.widthMM.solid, wT = first ? P.widthMM.first : P.widthMM.top, wSp = first ? P.widthMM.first : P.widthMM.infill;
    const sS = spacingOf(wS, hk), sT = spacingOf(wT, hk), sSp = spacingOf(wSp, hk);
    const loopsN = Math.max(1, P.wallLoops | 0);
    const d = new Float64Array(loopsN);
    d[0] = wO / 2;
    for (let i = 1; i < loopsN; i++) d[i] = d[i - 1] + (i === 1 ? (sO + sI) / 2 : sI);
    const band = d[loopsN - 1] + (loopsN > 1 ? sI : sO) / 2;
    const gapMax = fit.GAP_MAX_SPACINGS * sI;
    const vOuter = cap(first ? P.speedMMs.first : P.speedMMs.outer, hk * sO);
    const vInner = cap(first ? P.speedMMs.first : P.speedMMs.inner, hk * sI);
    const aOuter = acc(first ? P.accelMMs2.first : P.accelMMs2.outer), aInner = acc(first ? P.accelMMs2.first : P.accelMMs2.inner);
    const vSolidLine = cap(first ? P.speedMMs.firstInfill : P.speedMMs.solid, hk * spacingOf(first ? P.widthMM.first : P.widthMM.solid, hk));

    const g = segmentGrid(loops, 1.0);
    const rayMax = 2 * (band + gapMax) + 0.5;
    const sec = Object.fromEntries(KEYS.map((key) => [key, 0]));
    const len = { outerWall: 0, innerWall: 0, overhang: 0, gap: 0, solid: 0, top: 0, bottom: 0, sparse: 0, bridge: 0 };
    let lenInnerTotal = 0, gapArea = 0, gapRuns = 0, interiorRuns = 0, bandArea = 0, interiorEdge = 0;
    let netArea = 0, narrowArea = 0, concTime = 0, concLen = 0;
    let segIndex = 0;

    for (const q of loops) {
      const m = q.length >> 1;
      grow(m + 1);
      const { L, V, J, T, ov } = segBuf;
      let loopLen = 0, innerLen = 0, narrowLen = 0;
      let inGap = false, inInt = false, firstGap = false, firstInt = false;
      let area2 = 0;
      for (let s = 0; s < m; s++) {
        const i = s * 2, j = ((s + 1) % m) * 2;
        const ax = q[i], ay = q[i + 1], bx = q[j], by = q[j + 1];
        area2 += ax * by - bx * ay;
        const ex = bx - ax, ey = by - ay, l = Math.hypot(ex, ey);
        L[s] = l; loopLen += l;
        if (l < 1e-9) { V[s] = vOuter; ov[s] = 0; segIndex++; continue; }
        const nx = -ey / l, ny = ex / l;          // inward: the solid is on the left
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const W = castRay(g, mx, my, nx, ny, rayMax, segIndex);
        // walls along this segment
        let last = -1;
        for (let w = 0; w < loopsN; w++) if (d[w] < W / 2) last = w;
        for (let w = 1; w <= last; w++) innerLen += l;
        const lastHalf = last < 0 ? 0 : d[last] + (last === 0 ? sO : sI) / 2;
        const left = W / 2 - lastHalf;
        let isGap = false, isInt = false;
        if (last === loopsN - 1 && 2 * left > gapMax) {
          isInt = true;
          bandArea += band * l;
          if (W - 2 * band < fit.CONCENTRIC_MAX_MM) { narrowArea += left * l; narrowLen += l; } else interiorEdge += l;
        } else {
          bandArea += Math.min(W / 2, lastHalf) * l;
          if (2 * left > fit.GAP_MIN_MM) { isGap = true; gapArea += left * l; len.gap += l / 2; }
        }
        if (s === 0) { firstGap = isGap; firstInt = isInt; }
        if (isGap && !inGap) gapRuns++;
        if (isInt && !inInt) interiorRuns++;
        inGap = isGap; inInt = isInt;
        // overhang of the outer line past the layer below
        let share = 0;
        if (useOverhang && !first && P.overhangSpeedOn) {
          // is the contour point outside the layer below, and by how much along the inward normal
          if (!gPrev) share = 1.5;
          else {
            const fwd = castRay(gPrev, mx, my, nx, ny, wO * 1.5, -1);
            if (fwd !== Infinity) share = entersAt(gPrev, castRay.hit, nx, ny) ? Math.max(0, fwd - fit.OVERHANG_GRACE_MM) / wO : 0;
            else {
              const back = castRay(gPrev, mx, my, -nx, -ny, 4 * wO, -1);
              if (back !== Infinity) share = entersAt(gPrev, castRay.hit, -nx, -ny) ? 1.5 : 0;
              else share = cellAt(layersIn[k - 1].raster, grid, mx + nx * wO / 2, my + ny * wO / 2) ? 0 : 1.5;
            }
          }
        }
        let v = vOuter, band4 = 0;
        // a partly overhung line is banded by its share, and below the reference layer height by the share the same slope gives there; a fully overhung one by its own
        const sharePart = share * Math.max(1, fit.OVERHANG_REF_LAYER_MM / hk);
        if (share >= 1 || sharePart > 0.1) {
          band4 = share >= 1 ? 5 : 1 + Math.min(3, Math.floor(Math.min(sharePart, 0.999) * 4));
          const sp = band4 === 5 ? ovTotal : ovSpeeds[band4 - 1];
          if (sp > 0) v = Math.min(v, cap(sp, hk * sO));
        }
        V[s] = v; ov[s] = share >= 1 && v < vOuter ? 1 : 0;
        segIndex++;
      }
      if (m > 1 && inGap && firstGap) gapRuns--;
      if (m > 1 && inInt && firstInt) interiorRuns--;
      netArea += area2 / 2;
      // junction limits at each vertex: the turn between the path's directions over SMOOTH_MM either side
      // (a path is printed from its contour simplified to that scale), the curve's radius over the same span
      const span = fit.SMOOTH_MM;
      for (let s = 0; s < m; s++) {
        let back = s, lb = 0, fwd = s, lf = 0;
        for (let g = 0; g < m - 1 && (lb < span || g === 0); g++) { back = (back + m - 1) % m; lb += L[back]; }
        for (let g = 0; g < m - 1 && (lf < span || g === 0); g++) { lf += L[fwd]; fwd = (fwd + 1) % m; }
        const i0 = back * 2, i1 = s * 2, i2 = fwd * 2;
        const ux = q[i1] - q[i0], uy = q[i1 + 1] - q[i0 + 1], vx = q[i2] - q[i1], vy = q[i2 + 1] - q[i1 + 1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        if (lu < 1e-9 || lv < 1e-9) { J[s] = Infinity; continue; }
        const cosT = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
        const turn = Math.acos(cosT);
        if (useArcs && turn < arcTurn) J[s] = turn < 1e-6 ? Infinity : Math.sqrt(aOuter * ((lu + lv) / 2) / turn);
        else J[s] = cornerSpeed(corner, turn, aOuter);
      }
      const vStart = fit.START_SPEED_FACTOR * turn90(aOuter);
      // outer loop, walked along the contour
      runSeconds(m, L, V, J, aOuter, vStart, T);
      for (let s = 0; s < m; s++) {
        if (ov[s]) { sec.overhang += T[s]; len.overhang += L[s]; } else { sec.outerWall += T[s]; len.outerWall += L[s]; }
      }
      // inner loops: the same walk at their speed, scaled by their length
      if (innerLen > 0) {
        for (let s = 0; s < m; s++) V[s] = vInner;
        if (aInner !== aOuter) for (let s = 0; s < m; s++) if (J[s] !== Infinity) J[s] *= Math.sqrt(aInner / aOuter);
        const t = runSeconds(m, L, V, J, aInner, fit.START_SPEED_FACTOR * turn90(aInner), null);
        sec.innerWall += t * innerLen / Math.max(loopLen, 1e-9);
        len.innerWall += innerLen;
        lenInnerTotal += innerLen;
      }
      // narrow interior filled along the walls: the same walk at the solid speed
      if (narrowLen > 0) {
        for (let s = 0; s < m; s++) V[s] = vSolidLine;
        const aS = acc(first ? P.accelMMs2.first : P.accelMMs2.default), aJ = innerLen > 0 ? aInner : aOuter;
        if (aS !== aJ) for (let s = 0; s < m; s++) if (J[s] !== Infinity) J[s] *= Math.sqrt(aS / aJ);
        const t = runSeconds(m, L, V, J, aS, fit.START_SPEED_FACTOR * turn90(aS), null);
        concTime += t * narrowLen / Math.max(loopLen, 1e-9);
        concLen += narrowLen;
      }
    }

    // gap fill: one line down the middle of each gap run
    if (len.gap > 0) {
      const gw = Math.max(0.05, gapArea * 2 / Math.max(len.gap * 2, 1e-9));
      const vGap = cap(first ? P.speedMMs.first : P.speedMMs.gap, hk * gw);
      const aGap = acc(first ? P.accelMMs2.first : P.accelMMs2.default);
      const runs = Math.max(1, gapRuns);
      const vT = turn90(aGap);
      sec.gap += runs * moveSeconds(len.gap / runs, vT, vT, vGap, aGap);
    }

    // the interior, split by the raster
    const areaInt = Math.max(0, Math.abs(netArea) - bandArea - gapArea) + interiorEdge * P.infillWallOverlap * sI;
    const occ = layer.raster;
    let fTop = 0, fBottom = 0, fBridge = 0, fSolid = 0, fSparse = 0;
    sparseNow.fill(0);
    if (first) {
      fBottom = 1;
    } else {
      const above = (j) => (k + j < K ? eroded[k + j] : null);
      const below = (j) => (k - j >= 0 ? eroded[k - j] : null);
      const Tn = P.topLayers, Bn = P.bottomLayers;
      const below1 = k > 0 ? dilate(layersIn[k - 1].raster, rows, words, dilB) : null, above1 = k + 1 < K ? dilate(layersIn[k + 1].raster, rows, words, dilA) : null;
      for (let i = 0; i < nW; i++) {
        const o = occ[i];
        if (!o) { clsSolid[i] = clsTop[i] = clsBridge[i] = 0; continue; }
        const top = o & ~(above1 ? above1[i] : 0);
        const bridge = o & ~top & ~(below1 ? below1[i] : 0);
        let reach = 0;
        for (let j = 1; j <= Tn; j++) { const r = above(j); reach |= ~(r ? r[i] : 0); }
        for (let j = 1; j <= Bn; j++) { const r = below(j); reach |= r ? ~r[i] : (k - j < 0 ? -1 : 0); }
        const solid = o & ~top & ~bridge & reach;
        const sparse = o & ~top & ~bridge & ~solid;
        clsTop[i] = top; clsBridge[i] = bridge; clsSolid[i] = solid; sparseNow[i] = sparse;
      }
      smallSparseToSolid(sparseNow, clsSolid, rows, words, cols, minSparseCells);
      // solid laid over sparse is bridged
      erode(sparsePrev, rows, words, tmpE);
      for (let i = 0; i < nW; i++) {
        const ib = clsSolid[i] & tmpE[i];
        if (ib) { clsSolid[i] &= ~ib; clsBridge[i] |= ib; }
      }
      // fractions over the cells inside the walls (one-cell erosion), or all cells when none are
      erode(occ, rows, words, tmpE);
      let nE = count(tmpE);
      const pick = nE > 0 ? tmpE : occ;
      if (!nE) nE = count(occ);
      if (nE > 0) {
        let nt = 0, nb = 0, ns = 0, np = 0;
        for (let i = 0; i < nW; i++) {
          const m = pick[i];
          if (!m) continue;
          if (clsTop[i] & m) nt += popcount32(clsTop[i] & m);
          if (clsBridge[i] & m) nb += popcount32(clsBridge[i] & m);
          if (clsSolid[i] & m) ns += popcount32(clsSolid[i] & m);
          if (sparseNow[i] & m) np += popcount32(sparseNow[i] & m);
        }
        const tot = nt + nb + ns + np;
        if (tot > 0) { fTop = nt / tot; fBridge = nb / tot; fSolid = ns / tot; fSparse = np / tot; } else fSolid = 1;
      } else fSolid = 1;
    }
    { const t = sparsePrev; sparsePrev = sparseNow; sparseNow = t; }

    // the narrow part (filled along the walls) and the wide part (zig-zag lines of the region's mean chord)
    const narrow = Math.min(areaInt, narrowArea), wide = areaInt - narrow;
    const chord = wide > 0 ? fit.LINE_CHORD_FACTOR * Math.PI * wide / Math.max(interiorEdge, 1e-6) : 0;
    const concPerMM = concLen > 0 ? concTime / concLen : 0;
    const fill = (key, area, spacing, lineFactor, speed, a, areaLine) => {
      if (!(area > 0)) return;
      const length = area / spacing * lineFactor;
      len[key] += length;
      const vv = cap(speed, areaLine);
      const nShare = areaInt > 0 ? narrow / areaInt : 0;
      if (nShare > 0 && concPerMM > 0) sec[key] += length * nShare * concPerMM * Math.max(1, vSolidLine / vv);
      if (nShare < 1) sec[key] += zigzagSeconds(length * (1 - nShare), Math.max(chord, spacing), spacing, vv, a, fit.TURN_SPEED_FACTOR * turn90(a));
    };
    const aDef = acc(first ? P.accelMMs2.first : P.accelMMs2.default);
    const bridgeLineArea = Math.PI * nozzle * nozzle / 4;
    if (first) {
      fill('bottom', areaInt * fBottom, spacingOf(P.widthMM.first, hk), 1, P.speedMMs.firstInfill, acc(P.accelMMs2.first), hk * spacingOf(P.widthMM.first, hk));
    } else {
      fill('top', areaInt * fTop, sT, 1, P.speedMMs.top, acc(P.accelMMs2.top), hk * sT);
      fill('bridge', areaInt * fBridge, nozzle, 1, P.speedMMs.bridge, aDef, bridgeLineArea);
      fill('solid', areaInt * fSolid, sS, 1, P.speedMMs.solid, aDef, hk * sS);
      fill('sparse', areaInt * fSparse, sSp, P.infillDensity * patternFactor, P.speedMMs.infill, acc(P.accelMMs2.infill), hk * sSp);
    }

    // volume
    const v = {
      outerWall: len.outerWall * hk * sO, overhang: len.overhang * hk * sO, innerWall: len.innerWall * hk * sI, gap: gapArea * hk,
      top: len.top * sT * hk, solid: len.solid * sS * hk, sparse: len.sparse * sSp * hk, bottom: areaInt * fBottom * hk, bridge: len.bridge * bridgeLineArea,
    };
    for (const key in v) { volume += v[key]; volByKey[key] += v[key]; }

    // travel
    const events = loops.length > 0 ? layer.islands + fit.TRAVEL_PER_RUN * (gapRuns + interiorRuns) + 1 : 0;
    const diag = g ? Math.hypot(g.w, g.h) : 0;
    const hop = Math.max(0, M.zHopMM || 0);
    const zA = Math.min(M.maxAccelMMs2.z || 500, 1e9), zV = M.maxSpeedMMs.z || 10;
    const tHop = hop > 0 ? 2 * moveSeconds(hop, 0, 0, zV, zA) : 0;
    const dist = fit.TRAVEL_DIAG_FRACTION * diag / Math.max(1, Math.sqrt(events));
    const aT = Math.min(acc(first ? P.accelMMs2.first : P.accelMMs2.travel), aTravelMax);
    const vTr = Math.min(P.speedMMs.travel, vAxis);
    const tMove = moveSeconds(Math.max(dist, M.retractMinTravelMM || 0), 0, 0, vTr, aT);
    // with wipe on, the retraction happens during the wipe move; the de-retraction stands alone
    const retr = F.retractMM > 0 ? (M.wipe ? 0 : F.retractMM / F.retractSpeedMMs) + F.retractMM / (M.deretractSpeedMMs || F.retractSpeedMMs) : 0;
    sec.travel += events * (tMove + tHop);
    sec.retract += events * retr;
    retractEvents += events;

    // the cooling floor
    let layerSec = 0;
    for (const key of KEYS) layerSec += sec[key];
    let floor = 0;
    if (useCooling && F.slowDownOn && F.slowDownLayerTimeS > 0 && layerSec < F.slowDownLayerTimeS) {
      const keys = Object.keys(ADJUSTABLE).filter((key) => sec[key] > 0 && len[key] > 0);
      const fixed = layerSec - keys.reduce((s, key) => s + sec[key], 0);
      const timeAt = (Vc) => fixed + keys.reduce((s, key) => s + Math.max(sec[key], len[key] / Vc), 0);
      const vMin = Math.max(F.slowDownMinSpeedMMs || 1, 1);
      let lo = vMin, hi = Math.max(vMin, ...keys.map((key) => len[key] / sec[key]));
      let Vc = hi;
      if (timeAt(lo) <= F.slowDownLayerTimeS) Vc = lo;
      else {
        for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (timeAt(mid) > F.slowDownLayerTimeS) lo = mid; else hi = mid; }
        Vc = lo;
      }
      for (const key of keys) {
        const t = Math.max(sec[key], len[key] / Vc);
        floor += t - sec[key];
        sec[key] = t;
      }
      layerSec += floor;
    }

    for (const key of KEYS) totals[key] += sec[key];
    totals.floor += floor;
    layersPrinted++;
    topZ = layer.z;
    outLayers.push({ k, z: layer.z, seconds: sec, layerSeconds: layerSec, floor, retracts: events, areaInteriorMM2: areaInt });
    gPrev = g;
  }

  const crossFil = Math.PI * (F.diameterMM / 2) ** 2;
  const filamentMM3 = volume * F.flowRatio + (M.startGcodeFilamentMM || 0) * crossFil;
  const grams = filamentMM3 * F.densityGcm3 / 1000;
  let modelSeconds = 0;
  for (const key of KEYS) modelSeconds += totals[key];
  return {
    layers: outLayers,
    totals: {
      layers: layersPrinted,
      heightMM: layersPrinted ? topZ + (layersPrinted === 1 ? h0 : h) / 2 - (slices.bounds ? slices.bounds.min[2] : 0) : 0,
      seconds: totals,
      modelSeconds,
      totalSeconds: modelSeconds + (M.startEndGcodeS || 0),
      volumeMM3: volume,
      filamentMM3,
      grams,
      metres: filamentMM3 / crossFil / 1000,
      cost: grams / 1000 * (F.costPerKg || 0),
      retractEvents,
      gramsByFeature: Object.fromEntries(Object.entries(volByKey).map(([key, mm3]) => [key, mm3 * F.flowRatio * F.densityGcm3 / 1000])),
    },
  };
}
