// Plane-sweep slicer for the print estimator. A closed triangle mesh in
// millimeters, z up, becomes one section per layer at z_k = (k + ½) h: closed
// polygons (outer loops counterclockwise, holes clockwise), their signed area,
// contour length, island count, and a packed-bit raster of the solid at cell c.
//
// Each crossing edge of the mesh is intersected once (edge id → one point) and
// every crossing triangle references two of those points, so on a closed
// manifold each point has one segment in and one out and the loops close by
// construction; an open chain can only come from an open mesh, and is counted.

/**
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh
 * @param {{layerHeightMM?: number, firstLayerHeightMM?: number, cellMM?: number, marginMM?: number}} [opt]
 * @returns {Slices}
 */
export function slice(mesh, opt = {}) {
  const h = opt.layerHeightMM ?? 0.2;
  const h0 = opt.firstLayerHeightMM ?? h;
  const c = opt.cellMM ?? 0.5;
  const margin = opt.marginMM ?? 2;
  const P = mesh.positions, T = mesh.indices;
  const nV = P.length / 3, nT = T.length / 3;

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const grid = {
    cellMM: c,
    x0: minX - margin, y0: minY - margin,
    cols: Math.ceil((maxX - minX + 2 * margin) / c), rows: Math.ceil((maxY - minY + 2 * margin) / c),
  };
  grid.words = (grid.cols + 31) >> 5;

  // layer planes: layer 0 at h0/2, then h0 + (k - ½) h
  const zOf = (k) => k === 0 ? minZ + h0 / 2 : minZ + h0 + (k - 0.5) * h;
  const nLayers = Math.max(0, Math.ceil((maxZ - minZ - h0) / h - 1e-9) + 1);
  const layerOfZ = (z) => z < minZ + h0 ? 0 : Math.floor((z - minZ - h0) / h) + 1;

  // triangles bucketed by the layers their z range spans
  const zMin = new Float32Array(nT), zMax = new Float32Array(nT);
  const counts = new Uint32Array(nLayers + 1);
  for (let t = 0; t < nT; t++) {
    const a = T[t * 3] * 3 + 2, b = T[t * 3 + 1] * 3 + 2, d = T[t * 3 + 2] * 3 + 2;
    const lo = Math.min(P[a], P[b], P[d]), hi = Math.max(P[a], P[b], P[d]);
    zMin[t] = lo; zMax[t] = hi;
    const k0 = Math.max(0, layerOfZ(lo)), k1 = Math.min(nLayers - 1, layerOfZ(hi));
    for (let k = k0; k <= k1; k++) if (zOf(k) > lo && zOf(k) <= hi) counts[k + 1]++;
  }
  for (let k = 0; k < nLayers; k++) counts[k + 1] += counts[k];
  const bucket = new Uint32Array(counts[nLayers]);
  const fill = counts.slice(0, nLayers);
  for (let t = 0; t < nT; t++) {
    const k0 = Math.max(0, layerOfZ(zMin[t])), k1 = Math.min(nLayers - 1, layerOfZ(zMax[t]));
    for (let k = k0; k <= k1; k++) if (zOf(k) > zMin[t] && zOf(k) <= zMax[t]) bucket[fill[k]++] = t;
  }

  const layers = [];
  const edgePoint = new Map();
  for (let k = 0; k < nLayers; k++) {
    const z = zOf(k);
    edgePoint.clear();
    const px = [], py = [];
    const segFrom = [], segTo = [];
    // an edge u→v (winding order) crosses upward when z_u < z <= z_v; the
    // section segment runs from the triangle's downward crossing to its upward
    // one, which keeps the solid on the left
    const pointOf = (u, v) => {
      const key = u < v ? u * nV + v : v * nV + u;
      let id = edgePoint.get(key);
      if (id !== undefined) return id;
      const zu = P[u * 3 + 2], zv = P[v * 3 + 2];
      const t = (z - zu) / (zv - zu);
      id = px.length;
      px.push(P[u * 3] + (P[v * 3] - P[u * 3]) * t);
      py.push(P[u * 3 + 1] + (P[v * 3 + 1] - P[u * 3 + 1]) * t);
      edgePoint.set(key, id);
      return id;
    };
    for (let i = counts[k]; i < counts[k + 1]; i++) {
      const t = bucket[i];
      const v0 = T[t * 3], v1 = T[t * 3 + 1], v2 = T[t * 3 + 2];
      const b0 = P[v0 * 3 + 2] < z, b1 = P[v1 * 3 + 2] < z, b2 = P[v2 * 3 + 2] < z;
      let up = -1, down = -1;
      if (b0 !== b1) { if (b0) up = pointOf(v0, v1); else down = pointOf(v0, v1); }
      if (b1 !== b2) { if (b1) up = pointOf(v1, v2); else down = pointOf(v1, v2); }
      if (b2 !== b0) { if (b2) up = pointOf(v2, v0); else down = pointOf(v2, v0); }
      if (up < 0 || down < 0) continue;
      segFrom.push(down); segTo.push(up);
    }
    layers.push(buildLayer(k, z, px, py, segFrom, segTo, grid));
  }
  return { layers, grid, layerHeightMM: h, firstLayerHeightMM: h0, bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

function buildLayer(k, z, px, py, segFrom, segTo, grid) {
  const n = px.length;
  const next = new Int32Array(n).fill(-1);
  const indeg = new Uint8Array(n);
  let doubled = 0;
  for (let s = 0; s < segFrom.length; s++) {
    if (next[segFrom[s]] !== -1) doubled++;
    next[segFrom[s]] = segTo[s];
    indeg[segTo[s]]++;
  }
  const seen = new Uint8Array(n);
  const loops = [];
  let openChains = doubled;
  // closed loops: walk from any unvisited point with in-degree 1
  for (let s = 0; s < n; s++) {
    if (seen[s] || next[s] < 0 || indeg[s] !== 1) continue;
    const pts = [];
    let i = s, closed = false;
    while (i >= 0 && !seen[i]) {
      seen[i] = 1; pts.push(px[i], py[i]);
      i = next[i];
      if (i === s) { closed = true; break; }
    }
    if (closed) loops.push(Float64Array.from(pts)); else openChains++;
  }
  for (let s = 0; s < n; s++) if (!seen[s] && (next[s] >= 0 || indeg[s])) openChains++;

  let area = 0, length = 0, islands = 0;
  const loopArea = new Float64Array(loops.length);
  for (let L = 0; L < loops.length; L++) {
    const q = loops[L];
    let a = 0, len = 0;
    for (let i = 0, m = q.length; i < m; i += 2) {
      const j = (i + 2) % m;
      a += q[i] * q[j + 1] - q[j] * q[i + 1];
      len += Math.hypot(q[j] - q[i], q[j + 1] - q[i + 1]);
    }
    a *= 0.5;
    loopArea[L] = a; area += a; length += len;
    if (a > 0) islands++;
  }
  const raster = rasterize(loops, grid);
  return { k, z, loops, loopArea, area, contourLength: length, islands, openChains, raster };
}

/** Even-odd scanline fill of the loops at the cell centres, packed 32 cells per word, row-major. */
export function rasterize(loops, grid) {
  const { cellMM: c, x0, y0, cols, rows, words } = grid;
  const bits = new Uint32Array(rows * words);
  const rowX = new Array(rows);
  for (const q of loops) {
    for (let i = 0, m = q.length; i < m; i += 2) {
      const j = (i + 2) % m;
      let ax = q[i], ay = q[i + 1], bx = q[j], by = q[j + 1];
      if (ay === by) continue;
      if (ay > by) { let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
      // rows whose centre y lies in [ay, by)
      const r0 = Math.max(0, Math.ceil((ay - y0) / c - 0.5)), r1 = Math.min(rows - 1, Math.ceil((by - y0) / c - 0.5) - 1);
      for (let r = r0; r <= r1; r++) {
        const yc = y0 + (r + 0.5) * c;
        const x = ax + (bx - ax) * (yc - ay) / (by - ay);
        (rowX[r] || (rowX[r] = [])).push(x);
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    const xs = rowX[r];
    if (!xs) continue;
    xs.sort((a, b) => a - b);
    const base = r * words;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] - x0) / c - 0.5)), c1 = Math.min(cols - 1, Math.ceil((xs[i + 1] - x0) / c - 0.5) - 1);
      for (let col = c0; col <= c1; col++) bits[base + (col >> 5)] |= 1 << (col & 31);
    }
  }
  return bits;
}

export function popcount(bits) {
  let n = 0;
  for (let i = 0; i < bits.length; i++) {
    let v = bits[i];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
}

/** Is the cell holding (x, y) set. */
export function cellAt(bits, grid, x, y) {
  const col = Math.floor((x - grid.x0) / grid.cellMM), row = Math.floor((y - grid.y0) / grid.cellMM);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return false;
  return (bits[row * grid.words + (col >> 5)] >>> (col & 31) & 1) === 1;
}

/**
 * @typedef {{k: number, z: number, loops: Float64Array[], loopArea: Float64Array, area: number,
 *   contourLength: number, islands: number, openChains: number, raster: Uint32Array}} Layer
 * @typedef {{layers: Layer[], grid: {cellMM: number, x0: number, y0: number, cols: number, rows: number, words: number},
 *   layerHeightMM: number, firstLayerHeightMM: number, bounds: {min: number[], max: number[]}}} Slices
 */
