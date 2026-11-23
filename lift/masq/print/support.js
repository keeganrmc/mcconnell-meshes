// Support as a per-layer raster.
//
// The mesh is in millimeters, in its print orientation, z up, on z = 0. Every
// cell center of an xy grid is ray-cast along +z against the triangles whose
// xy box covers it; the sorted crossings per column (height, the normal's z,
// which sheet) are kept and exported: they are the oracle the per-layer
// raster is gated against. The model occupies a column at height z when the
// nearest crossing below z faces down (the ray entered the solid there).
//
// An overhang is a down-facing crossing with more than one layer of air
// under it on a surface within support_threshold_angle of HORIZONTAL
// (n·up < −cos thr). Measured on Bambu Studio 02.08 with 2 mm and 6 mm
// plates leaning 20°–80° from vertical at 0.12, 0.20 and 0.28 mm layers and
// on the 80 mm hemisphere: at threshold 30 a plate at 58° from vertical gets
// nothing and one at 60° gets 14 g, at every layer height; the hemisphere's
// support region is the cap within 32° of the pole (_verify/fixtures/print/
// lean*.stl, tools/print/lean.sh).
//
// Tree supports are counted from the tree itself (treeChains): tips on a
// lattice of tree_support_branch_distance under every overhang region as it
// enters, carried down slab by slab leaning toward their crowd at
// tree_support_branch_angle, merging where they touch, the radius from the
// tip's diameter growing at tree_support_branch_diameter_angle per mm of
// drop and area-summed at a merge; each branch is one wall of
// support_line_width (the slicer's branches are single hollow loops at every
// radius seen, 3 mm to 12 mm), the first layer on the plate is solid over the
// feet dilated by tree_support_brim_width. Nothing is fitted.
//
// Normal supports are the pillars under the overhang cells down to the plate
// or the model, flagged from VERTICAL (n·up < −sin thr) and filled at
// SUPPORT_FILL: a rule and a constant fitted to Bambu 01.09's three mask rows
// (mask-full-face.support.json). The lean plates contradict the rule (a 50°
// plate reads 8 g against the slicer's 0) and the slicer's mask pillars stand
// largely where nothing is overhead (the on-chin gcode under
// tools/print/lean.sh) — the normal regime's mechanism is open.
//
// Both regimes also run the erosion envelope below (a region's margin shrinks
// by h·tan(branchAngle) per layer, never under the trunk radius, the model
// cuts what it meets); the tree's envelope is what the slabs, and so the
// tips, are read from.
import { faceNormalsAreas } from './mesh.js';

/**
 * Constants read from tools/print/process.json (0.20mm Standard @BBL X1C).
 */
export const PROFILE = Object.freeze({
  layerMM: 0.2,
  lineWidthMM: 0.42,               // support_line_width
  basePatternSpacingMM: 2.5,       // support_base_pattern_spacing
  interfaceSpacingMM: 0.5,         // support_interface_spacing
  interfaceTopLayers: 2,           // support_interface_top_layers
  interfaceBottomLayers: 2,        // support_interface_bottom_layers
  topZDistanceMM: 0.2,             // support_top_z_distance
  bottomZDistanceMM: 0.2,          // support_bottom_z_distance
  thresholdDeg: 30,                // support_threshold_angle, from vertical
  branchAngleDeg: 45,              // tree_support_branch_angle
  branchDiameterMM: 2,             // tree_support_branch_diameter
  tipDiameterMM: 0.8,              // tree_support_tip_diameter
  branchDistanceMM: 5,             // tree_support_branch_distance
  branchDiameterAngleDeg: 5,       // tree_support_branch_diameter_angle
  brimWidthMM: 3,                  // tree_support_brim_width
  initialLayerMM: 0.2,             // initial_layer_print_height
  filamentDensity: 1.26,           // pla.json filament_density, g/cm³
});
/** The trunk a tree never grows past, mm (the slicers' widest trunks). */
export const TRUNK_MAX_RADIUS_MM = 7;

/**
 * The line fill of the NORMAL envelope below the interface, fitted at 0.5 mm
 * cells against Bambu Studio 01.09.05.51's normal-support grams on the
 * full-face mask in three orientations (_verify/fixtures/print/
 * mask-full-face.support.json, tools/print/oracle_support.sh): −16%..+22%.
 * The profile's base pattern is 0.42 mm lines at 2.5 mm, 0.168. The tree is
 * not filled: its grams are its drawn branches.
 */
export const SUPPORT_FILL = 0.08;
/** The interface layers: 0.42 mm lines at 0.5 mm spacing, capped at the plan's 80%. */
export const INTERFACE_FILL = 0.8;
/**
 * The first support layer on the plate is solid: measured 0.21 mm of filament
 * per mm² over a 0.2 mm layer on the bridge fixture, both regimes.
 */
export const PLATE_FILL = 1;

const NEG = -1e9;

/**
 * Sorted crossings per column of an xy grid over the mesh.
 * @param {{positions: Float32Array, indices: Uint32Array|Uint16Array}} mesh  mm
 * @param {object} [opts]
 * @param {number} [opts.cellMM]
 * @param {number[]} [opts.outerDir]  the direction the mask's outer face faces,
 *   in this frame; a crossing is "outer" when its triangle's normal has a
 *   positive dot with it
 * @returns {{nx:number, ny:number, x0:number, y0:number, cellMM:number, cells:number,
 *   start:Int32Array, z:Float64Array, nz:Float32Array, outer:Uint8Array,
 *   minZ:number, maxZ:number, triCount:number}}
 */
export function columnCrossings(mesh, { cellMM = 0.5, outerDir = [0, 0, 1] } = {}) {
  const { positions: P, indices: I } = mesh;
  const tCount = I.length / 3;
  if (!(cellMM > 0)) throw new Error('cellMM must be positive');
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
    if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
  }
  if (!(bx0 <= bx1)) throw new Error('empty mesh');
  const c = cellMM;
  // One pad cell each side so a triangle on the box edge sits in a column.
  const x0 = bx0 - c, y0 = by0 - c;
  const nx = Math.ceil((bx1 - bx0) / c) + 2, ny = Math.ceil((by1 - by0) / c) + 2;
  const cells = nx * ny;
  const { normals, areas } = faceNormalsAreas(P, I);
  const od = outerDir;

  // Hit records, then a counting sort by column.
  let cap = tCount * 4;
  let hCol = new Int32Array(cap), hZ = new Float64Array(cap), hNz = new Float32Array(cap), hOuter = new Uint8Array(cap);
  let nh = 0;
  const grow = () => {
    cap *= 2;
    const a = new Int32Array(cap); a.set(hCol); hCol = a;
    const b = new Float64Array(cap); b.set(hZ); hZ = b;
    const d = new Float32Array(cap); d.set(hNz); hNz = d;
    const e = new Uint8Array(cap); e.set(hOuter); hOuter = e;
  };
  const EPS = 1e-9;
  for (let t = 0; t < tCount; t++) {
    if (areas[t] === 0) continue;
    const nzT = normals[t * 3 + 2];
    if (nzT === 0) continue;                 // vertical: covers no column
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, cc = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const bx = P[b] - ax, by = P[b + 1] - ay, bz = P[b + 2] - az;
    const cx = P[cc] - ax, cy = P[cc + 1] - ay, cz = P[cc + 2] - az;
    const den = bx * cy - by * cx;
    if (den === 0) continue;
    const outer = (normals[t * 3] * od[0] + normals[t * 3 + 1] * od[1] + nzT * od[2]) > 0 ? 1 : 0;
    const minx = Math.min(ax, P[b], P[cc]), maxx = Math.max(ax, P[b], P[cc]);
    const miny = Math.min(ay, P[b + 1], P[cc + 1]), maxy = Math.max(ay, P[b + 1], P[cc + 1]);
    const i0 = Math.max(0, Math.floor((minx - x0) / c - 0.5)), i1 = Math.min(nx - 1, Math.ceil((maxx - x0) / c - 0.5));
    const j0 = Math.max(0, Math.floor((miny - y0) / c - 0.5)), j1 = Math.min(ny - 1, Math.ceil((maxy - y0) / c - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * c - ay;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * c - ax;
        const l1 = (px * cy - py * cx) / den;
        const l2 = (bx * py - by * px) / den;
        // Inclusive on the edges: a column on a shared edge is answered by
        // both triangles and the duplicate is dropped after the sort.
        if (l1 < -EPS || l2 < -EPS || l1 + l2 > 1 + EPS) continue;
        if (nh === cap) grow();
        hCol[nh] = j * nx + i; hZ[nh] = az + l1 * bz + l2 * cz; hNz[nh] = nzT; hOuter[nh] = outer; nh++;
      }
    }
  }
  const start = new Int32Array(cells + 1);
  for (let h = 0; h < nh; h++) start[hCol[h] + 1]++;
  for (let k = 0; k < cells; k++) start[k + 1] += start[k];
  const order = new Int32Array(nh);
  const cursor = Int32Array.from(start.subarray(0, cells));
  for (let h = 0; h < nh; h++) order[cursor[hCol[h]]++] = h;
  // Sort each column by z, then drop the same-sign duplicates a shared edge
  // or vertex produces.
  const z = new Float64Array(nh), nz = new Float32Array(nh), outerA = new Uint8Array(nh);
  const start2 = new Int32Array(cells + 1);
  let w = 0;
  const tmp = [];
  for (let k = 0; k < cells; k++) {
    tmp.length = 0;
    for (let e = start[k]; e < start[k + 1]; e++) tmp.push(order[e]);
    // At a tie an exit sorts before an entry, so two solids that share a
    // face (a leg under a deck) stay inside across it.
    tmp.sort((p, q) => (hZ[p] - hZ[q]) || ((hNz[q] < 0 ? -1 : 1) - (hNz[p] < 0 ? -1 : 1)));
    let lastZ = NaN, lastS = 0;
    for (const h of tmp) {
      const s = hNz[h] < 0 ? -1 : 1;
      if (s === lastS && Math.abs(hZ[h] - lastZ) < 1e-6) continue;
      z[w] = hZ[h]; nz[w] = hNz[h]; outerA[w] = hOuter[h]; w++;
      lastZ = hZ[h]; lastS = s;
    }
    start2[k + 1] = w;
  }
  return { nx, ny, x0, y0, cellMM: c, cells, start: start2, z: z.subarray(0, w), nz: nz.subarray(0, w),
    outer: outerA.subarray(0, w), minZ: bz0, maxZ: bz1, triCount: tCount };
}

/**
 * The model's occupancy per layer as a bitset: word (k * wpl + (cell >> 5)),
 * bit (cell & 31), layer centers at (k + ½)h. Built from the crossings by the
 * sign rule.
 */
export function occupancyBitset(cols, layerMM, layers) {
  const wpl = (cols.cells + 31) >> 5;
  const bits = new Uint32Array(wpl * layers);
  const { start, z, nz, cells } = cols;
  // The layer centres with a down-facing crossing nearest below them: from
  // each entry up to the next crossing (or the top when none follows).
  for (let p = 0; p < cells; p++) {
    const s = start[p], e = start[p + 1];
    const word = p >> 5, bit = (1 << (p & 31)) >>> 0;
    for (let i = s; i < e; i++) {
      if (nz[i] >= 0) continue;
      const k0 = Math.max(0, Math.ceil(z[i] / layerMM - 0.5));
      const k1 = i + 1 < e ? Math.min(layers, Math.ceil(z[i + 1] / layerMM - 0.5)) : layers;
      for (let k = k0; k < k1; k++) bits[k * wpl + word] |= bit;
    }
  }
  return { bits, wpl, layers };
}

/** The bit for (layer k, cell p). */
export function occupied(occ, k, p) {
  if (k < 0 || k >= occ.layers) return false;
  return (occ.bits[k * occ.wpl + (p >> 5)] & (1 << (p & 31))) !== 0;
}

/** The highest model layer below k in column p from the bitset, −1 for the plate. */
export function firstModelBelow(occ, k, p) {
  for (let j = k - 1; j >= 0; j--) if (occupied(occ, j, p)) return j;
  return -1;
}

/**
 * The highest model layer below layer k in column p from the crossing list,
 * −1 for the plate: walking down from layer k−1, a layer center whose nearest
 * crossing below faces down is inside the model; one whose nearest crossing
 * below faces up is above the model's exit, and the search jumps to the last
 * layer center under that exit.
 */
export function firstModelBelowFromCrossings(cols, layerMM, k, p) {
  const { start, z, nz } = cols;
  const s = start[p];
  let i = start[p + 1] - 1;
  let j = k - 1;
  while (j >= 0) {
    const zj = (j + 0.5) * layerMM;
    while (i >= s && z[i] > zj) i--;
    if (i < s) return -1;
    if (nz[i] < 0) return j;
    j = Math.min(j - 1, Math.ceil(z[i] / layerMM - 0.5) - 1);
  }
  return -1;
}

/**
 * Exact Euclidean distance (mm) from every cell to the nearest cell where
 * source[p] is nonzero, or to the outside of the grid, on a nx × ny grid at
 * cell c. Felzenszwalb–Huttenlocher, rows then columns, on squared distances.
 */
export function distanceToSource(source, nx, ny, c, out) {
  const n = nx * ny;
  const INF = 1e20;
  const f = new Float64Array(Math.max(nx, ny) + 2);
  const d = new Float64Array(Math.max(nx, ny) + 2);
  const v = new Int32Array(Math.max(nx, ny) + 3);
  const zz = new Float64Array(Math.max(nx, ny) + 4);
  const g = out || new Float32Array(n);
  const dt1 = (m) => {
    // f[0..m+1] with f[0] = f[m+1] = 0 (the border is a source); returns d.
    let k = 0; v[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (let q = 1; q <= m + 1; q++) {
      let s;
      for (;;) {
        const r = v[k];
        s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
        if (s > zz[k]) break;
        k--;
      }
      k++; v[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q <= m + 1; q++) {
      while (zz[k + 1] < q) k++;
      const r = v[k];
      d[q] = (q - r) * (q - r) + f[r];
    }
  };
  // Rows: squared distance along x to a source in the row (the border counts).
  for (let j = 0; j < ny; j++) {
    f[0] = 0; f[nx + 1] = 0;
    for (let i = 0; i < nx; i++) f[i + 1] = source[j * nx + i] ? 0 : INF;
    dt1(nx);
    for (let i = 0; i < nx; i++) g[j * nx + i] = d[i + 1];
  }
  // Columns: combine.
  for (let i = 0; i < nx; i++) {
    f[0] = 0; f[ny + 1] = 0;
    for (let j = 0; j < ny; j++) f[j + 1] = g[j * nx + i];
    dt1(ny);
    for (let j = 0; j < ny; j++) g[j * nx + i] = Math.sqrt(d[j + 1]) * c;
  }
  return g;
}

/**
 * Exact Euclidean distance (mm) from cell p to the nearest cell where
 * source[p] is nonzero or to the outside of the grid: Chebyshev rings out
 * from p until a ring cannot beat the best. The same number as
 * distanceToSource at p; for a few cells it is far cheaper than a transform
 * of the whole grid.
 */
export function distanceToSourceAt(source, nx, ny, c, p) {
  const i = p % nx, j = (p - i) / nx;
  if (source[p]) return 0;
  let best2 = Infinity;
  for (let k = 1; k * k < best2; k++) {
    const jLo = j - k, jHi = j + k, iLo = i - k, iHi = i + k;
    for (let dj = -k; dj <= k; dj++) {
      const jj = j + dj;
      const inRow = jj >= 0 && jj < ny;
      // the ring's left and right columns
      if (iLo < 0 || !inRow || source[jj * nx + iLo]) { const d2 = k * k + dj * dj; if (d2 < best2) best2 = d2; }
      if (iHi >= nx || !inRow || source[jj * nx + iHi]) { const d2 = k * k + dj * dj; if (d2 < best2) best2 = d2; }
    }
    for (let di = -k + 1; di <= k - 1; di++) {
      const ii = i + di;
      const inCol = ii >= 0 && ii < nx;
      // the ring's bottom and top rows
      if (jLo < 0 || !inCol || source[jLo * nx + ii]) { const d2 = k * k + di * di; if (d2 < best2) best2 = d2; }
      if (jHi >= ny || !inCol || source[jHi * nx + ii]) { const d2 = k * k + di * di; if (d2 < best2) best2 = d2; }
    }
  }
  return Math.fround(Math.sqrt(best2) * c);   // as distanceToSource stores it
}

/**
 * The ring search of distanceToSourceAt with the sources read off the live
 * state instead of a filled array: a cell is a source when it is model, or
 * when it is neither support (F > 0) nor entering at this layer.
 */
function ringDistance(entering, stamp, F, occBits, occBase, nx, ny, c, p) {
  const i = p % nx, j = (p - i) / nx;
  const isSource = (q) => (occBits[occBase + (q >> 5)] & (1 << (q & 31))) !== 0 || (F[q] <= 0 && entering[q] !== stamp);
  let best2 = Infinity;
  for (let k = 1; k * k < best2; k++) {
    const jLo = j - k, jHi = j + k, iLo = i - k, iHi = i + k;
    for (let dj = -k; dj <= k; dj++) {
      const jj = j + dj;
      const inRow = jj >= 0 && jj < ny;
      if (iLo < 0 || !inRow || isSource(jj * nx + iLo)) { const d2 = k * k + dj * dj; if (d2 < best2) best2 = d2; }
      if (iHi >= nx || !inRow || isSource(jj * nx + iHi)) { const d2 = k * k + dj * dj; if (d2 < best2) best2 = d2; }
    }
    for (let di = -k + 1; di <= k - 1; di++) {
      const ii = i + di;
      const inCol = ii >= 0 && ii < nx;
      if (jLo < 0 || !inCol || isSource(jLo * nx + ii)) { const d2 = k * k + di * di; if (d2 < best2) best2 = d2; }
      if (jHi >= ny || !inCol || isSource(jHi * nx + ii)) { const d2 = k * k + di * di; if (d2 < best2) best2 = d2; }
    }
  }
  return Math.fround(Math.sqrt(best2) * c);   // as the transform stores it
}

/**
 * The support estimate, both regimes.
 * @param {{positions: Float32Array, indices: Uint32Array|Uint16Array}} mesh  mm, print frame
 * @param {object} [opts]
 * @param {number} [opts.cellMM]
 * @param {number} [opts.layerMM]
 * @param {number[]} [opts.outerDir]
 * @param {object} [opts.profile]
 * @param {boolean} [opts.tree]  skip the tree loop when false
 */
/**
 * The regions of a cell mask (8-connected, test(p) true for a support cell)
 * as discs: centroid, the radius of the same area, the cell count. The
 * drawing of a layer of support — a column per region, merged where the
 * erosion merged them.
 */
function regionDiscs(test, nx, ny, c, i0, i1, j0, j1, seen, stamp, marks = null, fresh = null) {
  const discs = [], stack = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const s0 = j * nx + i;
    if (seen[s0] === stamp || !test(s0)) continue;
    let n = 0, sx = 0, sy = 0, own = false, anyFresh = false;
    stack.length = 0; stack.push(s0); seen[s0] = stamp;
    while (stack.length) {
      const p = stack.pop(); n++;
      if (marks && marks.has(p)) own = true;
      if (fresh && !anyFresh && fresh(p)) anyFresh = true;
      const pi = p % nx, pj = (p - pi) / nx;
      sx += pi; sy += pj;
      for (let dj = -1; dj <= 1; dj++) {
        const qj = pj + dj; if (qj < 0 || qj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const qi = pi + di; if (qi < 0 || qi >= nx) continue;
          const q = qj * nx + qi;
          if (seen[q] !== stamp && test(q)) { seen[q] = stamp; stack.push(q); }
        }
      }
    }
    /* a region under six cells (1.5 mm² at 0.5 mm) is the erosion's
     * crumbs, not a column: 278 of 5,578 on the full face, not drawn */
    if (n >= 6) discs.push([(sx / n + 0.5) * c, (sy / n + 0.5) * c, Math.sqrt(n * c * c / Math.PI), n, own, anyFresh]);
  }
  return discs;
}

/**
 * The tree's branches through a layer: the support cells sampled on a
 * lattice of `pitchMM` (a branch every pitch, as the slicer spaces them
 * inside the envelope), plus the centroid of any region the lattice misses
 * (a twig). Points in the grid's frame, [x, y].
 */
function branchPoints(test, fresh, contact, nx, ny, c, i0, i1, j0, j1, pitchMM, seen, stamp) {
  const P = Math.max(2, Math.round(pitchMM / c)), half = P >> 1, pts = [];
  const hit = new Set();
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (i % P !== half || j % P !== half) continue;
    const p = j * nx + i;
    if (!test(p)) continue;
    const f = fresh(p);
    pts.push([(i + 0.5) * c, (j + 0.5) * c, f ? 1 : 0, f ? contact(p) : -1]);
    hit.add(p);
  }
  // regions no lattice point fell in: one branch at the centroid, a tip if
  // any of its cells is fresh
  for (const [x, y, , n, own, anyFresh] of regionDiscs(test, nx, ny, c, i0, i1, j0, j1, seen, stamp, hit, fresh)) {
    if (own || n < 6) continue;
    const p = Math.floor(y / c) * nx + Math.floor(x / c);
    pts.push([x, y, anyFresh ? 1 : 0, anyFresh ? contact(p) : -1]);
  }
  return pts;
}

export function estimateSupport(mesh, opts = {}) {
  const c = opts.cellMM ?? 0.5;
  const pr = { ...PROFILE, ...(opts.profile || {}) };
  const h = opts.layerMM ?? pr.layerMM;
  const cols = columnCrossings(mesh, { cellMM: c, outerDir: opts.outerDir || [0, 0, 1] });
  const K = Math.max(1, Math.ceil(cols.maxZ / h));
  const occ = occupancyBitset(cols, h, K);
  const { nx, ny, cells, start, z, nz, outer } = cols;
  const thr = pr.thresholdDeg * Math.PI / 180;
  const gapTop = Math.round(pr.topZDistanceMM / h), gapBottom = Math.round(pr.bottomZDistanceMM / h);
  const cellArea = c * c;

  // Pillars: per overhang crossing under `cut` (a down-facing crossing with
  // nz below it), the support layers under it and where it lands. Grouped by
  // top layer for the tree loop.
  const pillarsUnder = (cut) => {
    const pTop = [], pBottom = [], pCell = [], pLand = [];   // land: 0 plate, 1 outer, 2 inner
    let overhangCells = 0;
    for (let p = 0; p < cells; p++) {
      for (let i = start[p]; i < start[p + 1]; i++) {
        if (nz[i] >= cut) continue;
        const onPlate = i === start[p];
        const zPrev = onPlate ? 0 : z[i - 1];
        if (z[i] - zPrev <= h) continue;
        const kEnter = Math.ceil(z[i] / h - 0.5);
        const kTop = Math.min(K - 1, kEnter - 1 - gapTop);
        const kBottom = onPlate ? 0 : Math.ceil(zPrev / h - 0.5) + gapBottom;
        overhangCells++;
        if (kTop < kBottom) continue;
        pTop.push(kTop); pBottom.push(kBottom); pCell.push(p);
        pLand.push(onPlate ? 0 : (outer[i - 1] ? 1 : 2));
      }
    }
    return { pTop, pBottom, pCell, pLand, overhangMM2: overhangCells * cellArea };
  };
  // normal: the fitted rule, from vertical; tree: the measured one, from horizontal
  const N = pillarsUnder(-Math.sin(thr));
  const overhangMM2 = N.overhangMM2;

  // Normal: the pillars as they are.
  const normal = { envelopeMM3: 0, baseMM3: 0, interfaceMM3: 0, plateMM3: 0, footprintOuterMM2: 0, footprintInnerMM2: 0, plateMM2: 0, cells: 0 };
  // Interface thickness in mm: the profile's layers at the profile's layer
  // height, whatever layer the raster runs at.
  const ifaceTopMM = pr.interfaceTopLayers * pr.layerMM, ifaceBottomMM = pr.interfaceBottomLayers * pr.layerMM;
  for (let q = 0; q < N.pTop.length; q++) {
    const len = N.pTop[q] - N.pBottom[q] + 1;
    const L = len * h;
    const iface = Math.min(L, ifaceTopMM + (N.pLand[q] !== 0 ? ifaceBottomMM : 0));
    const plate = N.pLand[q] === 0 ? Math.min(L - iface, pr.layerMM) : 0;
    normal.cells += len;
    normal.interfaceMM3 += iface * cellArea;
    normal.plateMM3 += plate * cellArea;
    normal.baseMM3 += (L - iface - plate) * cellArea;
    if (N.pLand[q] === 0) normal.plateMM2 += cellArea;
    else if (N.pLand[q] === 1) normal.footprintOuterMM2 += cellArea;
    else normal.footprintInnerMM2 += cellArea;
  }
  normal.envelopeMM3 = normal.baseMM3 + normal.interfaceMM3 + normal.plateMM3;

  let plateContactCells = 0;
  for (let p = 0; p < cells; p++) if (occupied(occ, 0, p)) plateContactCells++;

  // The drawing: every `slabMM` of height, the regions of that layer's
  // support as discs, in the mesh's own frame (x, y from the grid's origin).
  const gx0 = cols.x0 ?? 0, gy0 = cols.y0 ?? 0;
  if (opts.slabMM > 0) {
    const every = Math.max(1, Math.round(opts.slabMM / h)), seenN = new Int32Array(cells);
    const slabOf = (k, discs) => ({ z0: k * h, z1: Math.min(K, k + every) * h, discs: discs.map(([x, y, r, n]) => [x + gx0, y + gy0, r, n]) });
    // Normal: the pillar cells at layer k, by connectivity.
    const cover = new Int32Array(cells);
    normal.slabs = [];
    for (let k = 0; k < K; k += every) {
      cover.fill(0);
      let any = false, bi0 = nx, bi1 = -1, bj0 = ny, bj1 = -1;
      for (let q = 0; q < N.pTop.length; q++) {
        if (k < N.pBottom[q] || k > N.pTop[q]) continue;
        const p = N.pCell[q]; cover[p] = 1; any = true;
        const i = p % nx, j = (p - i) / nx;
        if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
      }
      if (!any) continue;
      normal.slabs.push(slabOf(k, regionDiscs((p) => cover[p] === 1, nx, ny, c, bi0, bi1, bj0, bj1, seenN, k + 1)));
    }
  }

  const out = {
    cellMM: c, layerMM: h, layers: K, heightMM: cols.maxZ, columns: cols, occupancy: occ,
    overhangMM2, plateContactMM2: plateContactCells * cellArea, pillars: N.pTop.length,
    normal, tree: null,
  };
  if (opts.tree === false) return out;

  // Tree: top down, from its own overhang set, always in slabs (the tips
  // are read off them).
  const { pTop, pBottom, pCell, overhangMM2: treeOverhangMM2 } = pillarsUnder(-Math.cos(thr) + 1e-4);
  const slabEvery = Math.max(1, Math.round((opts.slabMM > 0 ? opts.slabMM : 2) / h));
  const seen = new Int32Array(cells);
  const byTop = new Int32Array(K + 1);
  for (let q = 0; q < pTop.length; q++) byTop[pTop[q] + 1]++;
  for (let k = 0; k < K; k++) byTop[k + 1] += byTop[k];
  const order = new Int32Array(pTop.length);
  { const cur = Int32Array.from(byTop.subarray(0, K)); for (let q = 0; q < pTop.length; q++) order[cur[pTop[q]]++] = q; }

  const r = h * Math.tan(pr.branchAngleDeg * Math.PI / 180);
  const Rt = pr.branchDiameterMM / 2;
  const F = new Float32Array(cells).fill(NEG);
  const roof = new Float32Array(cells);      // interface thickness still to lay under a cell's overhang, mm
  const src = new Uint8Array(cells);
  const entering = new Int32Array(cells);    // stamped k + 1 for the cells entering at layer k
  const dist = new Float32Array(cells);
  const label = new Int32Array(cells).fill(-1);
  const regionMax = [];
  const stack = new Int32Array(cells);
  const tree = { envelopeMM3: 0, baseMM3: 0, interfaceMM3: 0, plateMM3: 0, footprintOuterMM2: 0, footprintInnerMM2: 0, plateMM2: 0, cells: 0, slabs: [], overhangMM2: treeOverhangMM2 };
  let prevSlab = null;
  const interfaceBelowMM = ifaceBottomMM + gapBottom * h;
  const cd = c * Math.SQRT2;
  const occBits = occ.bits, wpl = occ.wpl;
  // The box of cells carrying support, inclusive [i0, i1, j0, j1]; every
  // pass runs over it (grown by the spread's reach) and nothing outside it
  // is ever above NEG. Empty when i0 > i1.
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, maxF = 0;
  for (let k = K - 1; k >= 0; k--) {
    const occBase = k * wpl;
    // Regions (8-connected) and each one's inradius, the largest margin in it.
    regionMax.length = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const s0 = j * nx + i;
      if (F[s0] <= 0 || label[s0] >= 0) continue;
      const id = regionMax.length; let mx = 0, top = 0;
      stack[top++] = s0; label[s0] = id;
      while (top) {
        const p = stack[--top];
        if (F[p] > mx) mx = F[p];
        const pi = p % nx, pj = (p - pi) / nx;
        const jLo = pj > 0 ? -1 : 0, jHi = pj < ny - 1 ? 1 : 0, iLo = pi > 0 ? -1 : 0, iHi = pi < nx - 1 ? 1 : 0;
        for (let dj = jLo; dj <= jHi; dj++) {
          const row = (pj + dj) * nx + pi;
          for (let di = iLo; di <= iHi; di++) {
            const q = row + di;
            if (F[q] > 0 && label[q] < 0) { label[q] = id; stack[top++] = q; }
          }
        }
      }
      regionMax.push(mx);
    }
    // Erode by r, but a region never goes below the trunk's inradius: its
    // margins shift so the inradius becomes max(Rt, inradius − r).
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = j * nx + i;
      if (F[p] <= 0) { F[p] = NEG; continue; }
      const I = regionMax[label[p]];
      label[p] = -1;
      F[p] += Math.max(Rt, I - r) - I;
      if (F[p] <= 0) F[p] = NEG;
    }
    // A margin raised above what its neighbors carry spreads as a disc: the
    // lower envelope of cones, two chamfer passes over the box grown by the
    // largest margin's reach.
    const reach = Math.ceil(maxF / c) + 1;
    const gi0 = Math.max(0, i0 - reach), gi1 = Math.min(nx - 1, i1 + reach), gj0 = Math.max(0, j0 - reach), gj1 = Math.min(ny - 1, j1 + reach);
    for (let j = gj0; j <= gj1; j++) for (let i = gi0; i <= gi1; i++) {
      const p = j * nx + i; let m = F[p];
      if (i > 0 && F[p - 1] - c > m) m = F[p - 1] - c;
      if (j > 0) {
        if (F[p - nx] - c > m) m = F[p - nx] - c;
        if (i > 0 && F[p - nx - 1] - cd > m) m = F[p - nx - 1] - cd;
        if (i < nx - 1 && F[p - nx + 1] - cd > m) m = F[p - nx + 1] - cd;
      }
      F[p] = m;
    }
    for (let j = gj1; j >= gj0; j--) for (let i = gi1; i >= gi0; i--) {
      const p = j * nx + i; let m = F[p];
      if (i < nx - 1 && F[p + 1] - c > m) m = F[p + 1] - c;
      if (j < ny - 1) {
        if (F[p + nx] - c > m) m = F[p + nx] - c;
        if (i < nx - 1 && F[p + nx + 1] - cd > m) m = F[p + nx + 1] - cd;
        if (i > 0 && F[p + nx - 1] - cd > m) m = F[p + nx - 1] - cd;
      }
      F[p] = m;
    }
    i0 = gi0; i1 = gi1; j0 = gj0; j1 = gj1;
    // New overhang cells enter with the inside distance of the union.
    const q0 = byTop[k], q1 = byTop[k + 1];
    if (q1 > q0) {
      for (let q = q0; q < q1; q++) {
        const p = pCell[order[q]], i = p % nx, j = (p - i) / nx;
        if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      }
      // Sources: the cells that are neither support nor entering; model
      // cells are sources too, so a region beside a wall measures its
      // distance to the wall. A wide entry takes the whole-grid transform,
      // a narrow one a ring search per cell (the same distance).
      let fresh = 0;
      for (let q = q0; q < q1; q++) { const p = pCell[order[q]]; if (F[p] <= 0 && (occBits[occBase + (p >> 5)] & (1 << (p & 31))) === 0) fresh++; }
      if (fresh > 0) {
        const wide = fresh * 64 > cells;
        if (wide) {
          for (let p = 0; p < cells; p++) src[p] = (F[p] > 0 || (occBits[occBase + (p >> 5)] & (1 << (p & 31))) !== 0) ? 0 : 1;
          for (let q = q0; q < q1; q++) src[pCell[order[q]]] = 0;
          for (let p = 0; p < cells; p++) if ((occBits[occBase + (p >> 5)] & (1 << (p & 31))) !== 0) src[p] = 1;
          distanceToSource(src, nx, ny, c, dist);
        } else {
          for (let q = q0; q < q1; q++) entering[pCell[order[q]]] = k + 1;
        }
        for (let q = q0; q < q1; q++) {
          const p = pCell[order[q]];
          if (F[p] > 0) continue;
          const d = wide ? dist[p] : ringDistance(entering, k + 1, F, occBits, occBase, nx, ny, c, p);
          F[p] = Math.max(d - c * 0.5, c * 0.5);
        }
      }
      for (let q = q0; q < q1; q++) roof[pCell[order[q]]] = ifaceTopMM;
    }
    // The model cuts; then count.
    const zk = (k + 0.5) * h;
    let ni0 = nx, ni1 = -1, nj0 = ny, nj1 = -1;
    maxF = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = j * nx + i;
      if (F[p] <= -c * 0.5) { F[p] = NEG; roof[p] = 0; continue; }
      if ((occBits[occBase + (p >> 5)] & (1 << (p & 31))) !== 0) { F[p] = NEG; roof[p] = 0; continue; }
      // The cell's covered fraction from its margin: a straight boundary at
      // signed distance F from the center covers ½ + F/c of the cell.
      const frac = Math.min(1, 0.5 + F[p] / c);
      if (F[p] <= 0) F[p] = NEG;
      else { if (i < ni0) ni0 = i; if (i > ni1) ni1 = i; if (j < nj0) nj0 = j; if (j > nj1) nj1 = j; if (F[p] > maxF) maxF = F[p]; }
      tree.cells += frac;
      let ifaceMM = Math.min(h, roof[p]);
      roof[p] -= ifaceMM;
      let plateMM = 0;
      // Landing and the bottom interface, from the crossing list.
      let ci = start[p + 1] - 1;
      while (ci >= start[p] && z[ci] > zk) ci--;
      if (ci < start[p]) {
        if (k === 0) { tree.plateMM2 += cellArea * frac; plateMM = Math.min(h - ifaceMM, pr.layerMM); }
      } else if (nz[ci] > 0) {
        const kExit = Math.ceil(z[ci] / h - 0.5) - 1;
        const below = k - kExit;
        if ((below - 0.5) * h <= interfaceBelowMM) ifaceMM = h;
        if (below === gapBottom + 1) {
          if (outer[ci]) tree.footprintOuterMM2 += cellArea * frac; else tree.footprintInnerMM2 += cellArea * frac;
        }
      }
      tree.interfaceMM3 += ifaceMM * cellArea * frac;
      tree.plateMM3 += plateMM * cellArea * frac;
      tree.baseMM3 += (h - ifaceMM - plateMM) * cellArea * frac;
    }
    i0 = ni0; i1 = ni1; j0 = nj0; j1 = nj1;
    if (k % slabEvery === 0 && i0 <= i1) {
      /* a cell is a TIP where it was not support at the slab above (a new
       * overhang entering); the branch draw starts branches only there */
      /* a tip's contact: the model's underside above the cell (the first
       * down-facing crossing above this layer) less the top gap, so the
       * drawn tip touches where the interface is laid */
      const contact = (p) => { for (let ci = start[p]; ci < start[p + 1]; ci++) if (z[ci] > zk && nz[ci] < 0) return z[ci] - pr.topZDistanceMM; return -1; };
      const pts = branchPoints((p) => F[p] > 0, (p) => !prevSlab || prevSlab[p] === 0, contact, nx, ny, c, i0, i1, j0, j1, pr.branchDistanceMM, seen, K + k + 1);
      tree.slabs.push({ z0: k * h, z1: Math.min(K, k + slabEvery) * h, branches: pts.map(([x, y, tip, zc]) => [x + gx0, y + gy0, tip, zc]) });
      if (!prevSlab) prevSlab = new Uint8Array(cells); else prevSlab.fill(0);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const p = j * nx + i; if (F[p] > 0) prevSlab[p] = 1; }
    }
  }
  tree.slabs.reverse();
  tree.envelopeMM3 = tree.baseMM3 + tree.interfaceMM3 + tree.plateMM3;
  tree.chains = treeChains(tree.slabs, pr);
  Object.assign(tree, treeMaterial(tree.chains, pr));
  out.tree = tree;
  return out;
}

/**
 * The tree's branches, top down, from the slabs' tips: a chain per branch as
 * [x, y, z, r] points, in the slabs' frame. A tip starts at its contact on
 * the model. Each slab down a branch leans toward the weight of the branches
 * within 16 mm (n / (1 + d)) by up to 0.6 of the slab's lean at the branch
 * angle, must still find a lattice point of the envelope within reach below
 * (else it lands on the model or the plate there), and two whose radii come
 * within 1.5 mm merge at their weighted mean. The radius: the branch
 * diameter's half at the tip, the diameter growing at tan(branch diameter
 * angle) per mm of drop, area-summed at a merge, capped at
 * TRUNK_MAX_RADIUS_MM (the slicer's lone branch 50 mm under its tip is a
 * 3–4 mm ring; its trunk of four is 12 mm). Every fresh lattice point starts a tip unless a branch
 * already stands on it.
 * @param {Array<{z0:number, z1:number, branches:number[][]}>} slabs  bottom first
 */
export function treeChains(slabs, profile = PROFILE) {
  const pr = { ...PROFILE, ...profile };
  const chains = [];
  if (!slabs || !slabs.length || !slabs[0].branches) return chains;
  const slabMM = slabs[0].z1 - slabs[0].z0;
  const lean = slabMM * Math.tan(pr.branchAngleDeg * Math.PI / 180);
  const reach = pr.branchDistanceMM * Math.SQRT1_2 + lean + 1;
  /* the branch diameter's angle: the DIAMETER grows tan(angle) per mm of drop */
  const grow = Math.tan(pr.branchDiameterAngleDeg * Math.PI / 180) / 2;
  const rTip = pr.branchDiameterMM / 2, rMax = TRUNK_MAX_RADIUS_MM;
  /* a tip starts at its contact when that is within the slab above it, else at the slab's top */
  const start = (x, y, z, zc) => ({ x, y, n: 1, r: rTip, path: [[x, y, zc > z && zc < z + slabMM ? zc : z, rTip]] });
  const close = (b, x, y, z) => { b.path.push([x, y, z, b.r]); if (b.path.length >= 2) chains.push(b.path); };
  const top = slabs[slabs.length - 1];
  let live = top.branches.map(([x, y, , zc]) => start(x, y, top.z1, zc));
  for (let k = slabs.length - 1; k >= 0; k--) {
    const sl = slabs[k];
    if (k === 0) { for (const b of live) close(b, b.x, b.y, sl.z0); break; }
    const lattice = slabs[k - 1].branches, zb = slabs[k - 1].z1;
    const moved = [];
    for (const b of live) {
      let tx = b.x, ty = b.y, wx = 0, wy = 0, w = 0;
      for (const o of live) { if (o === b) continue; const d2 = (o.x - b.x) ** 2 + (o.y - b.y) ** 2; if (d2 > 256) continue; const wt = o.n / (1 + Math.sqrt(d2)); wx += o.x * wt; wy += o.y * wt; w += wt; }
      if (w > 0) { const gx = wx / w - b.x, gy = wy / w - b.y, d = Math.hypot(gx, gy); if (d > 0.5) { const st = Math.min(lean * 0.6, d / 2); tx += gx / d * st; ty += gy / d * st; } }
      let inside = false;
      for (let j = 0; j < lattice.length && !inside; j++) { const ex = tx - lattice[j][0], ey = ty - lattice[j][1]; if (ex * ex + ey * ey < reach * reach) inside = true; }
      if (!inside) { close(b, b.x, b.y, sl.z0); continue; }
      moved.push({ b, tx, ty });
    }
    const next = [];
    for (const { b, tx, ty } of moved) {
      b.r = Math.min(rMax, b.r + grow * slabMM);
      let host = null;
      for (const o of next) { const d = Math.hypot(o.x - tx, o.y - ty); if (d < b.r + o.r + 1.5) { host = o; break; } }
      if (host) {
        const w = host.n + b.n; host.x = (host.x * host.n + tx * b.n) / w; host.y = (host.y * host.n + ty * b.n) / w; host.n = w;
        host.r = Math.min(rMax, Math.hypot(host.r, b.r));
        host.path[host.path.length - 1] = [host.x, host.y, zb, host.r];
        close(b, host.x, host.y, zb);
      } else { b.x = tx; b.y = ty; b.path.push([tx, ty, zb, b.r]); next.push(b); }
    }
    for (let j = 0; j < lattice.length; j++) {
      if (!lattice[j][2]) continue;
      let near = false;
      for (const o of next) { const d = o.r + rTip + 1; if ((o.x - lattice[j][0]) ** 2 + (o.y - lattice[j][1]) ** 2 < d * d) { near = true; break; } }
      if (!near) next.push(start(lattice[j][0], lattice[j][1], zb, lattice[j][3]));
    }
    live = next;
  }
  return chains;
}

/**
 * The material in a tree: every branch one wall of support_line_width (a
 * branch thinner than two lines is solid), plus the solid first layer on the
 * plate over the feet dilated by the brim width (a union on a 1 mm raster).
 * @returns {{materialMM3:number, branchMM3:number, plateMM3:number, plateMM2:number, feet:number}}
 */
export function treeMaterial(chains, profile = PROFILE) {
  const pr = { ...PROFILE, ...profile };
  const w = pr.lineWidthMM;
  const area = (r) => Math.min(Math.PI * r * r, 2 * Math.PI * r * w);
  let branchMM3 = 0;
  const feet = [];
  for (const path of chains) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      branchMM3 += area((a[3] + b[3]) / 2) * L;
    }
    const last = path[path.length - 1];
    if (last[2] < 1e-6) feet.push([last[0], last[1], last[3] + pr.brimWidthMM]);
  }
  let plateMM2 = 0;
  if (feet.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y, r] of feet) { if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r; if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r; }
    const nx = Math.ceil(x1 - x0) + 1, ny = Math.ceil(y1 - y0) + 1;
    const hit = new Uint8Array(nx * ny);
    for (const [x, y, r] of feet) {
      const i0 = Math.max(0, Math.floor(x - r - x0)), i1 = Math.min(nx - 1, Math.ceil(x + r - x0)), j0 = Math.max(0, Math.floor(y - r - y0)), j1 = Math.min(ny - 1, Math.ceil(y + r - y0));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const dx = x0 + i + 0.5 - x, dy = y0 + j + 0.5 - y; if (dx * dx + dy * dy <= r * r) hit[j * nx + i] = 1; }
    }
    for (let q = 0; q < hit.length; q++) plateMM2 += hit[q];
  }
  const plateMM3 = plateMM2 * pr.initialLayerMM;
  return { materialMM3: branchMM3 + plateMM3, branchMM3, plateMM3, plateMM2, feet: feet.length };
}

/**
 * Grams for one regime: a tree's drawn material, or a normal envelope's base
 * at the line fill with the interface layers and the plate layer at theirs,
 * times the filament density.
 */
export function supportGrams(regime, { fill = SUPPORT_FILL, interfaceFill = INTERFACE_FILL, plateFill = PLATE_FILL, density = PROFILE.filamentDensity } = {}) {
  if (regime.materialMM3 != null) return regime.materialMM3 * density / 1000;
  return (regime.baseMM3 * fill + regime.interfaceMM3 * interfaceFill + regime.plateMM3 * plateFill) * density / 1000;
}
