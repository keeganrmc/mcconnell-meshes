// The floor of a sole: a closed footprint polygon filled with a triangle cap
// that has interior vertices, so the ground face can carry a contact profile
// (pads that touch, a rocker that does not) and later a tread.
//
// Interior points on a grid at `spacing`, kept a half-spacing clear of the
// outline so no sliver forms against it; Bowyer–Watson Delaunay over outline
// plus interior; triangles whose centroid falls outside the polygon dropped
// (the waist is the only concavity a footprint has, and it is shallow).
// Every outline edge is asserted present — a missing one is returned in
// `missingEdges`, and the caller treats that as a refusal.

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Bowyer–Watson. pts: [[x,y],...]. Returns triangles as index triples, CCW.
export function delaunay(pts) {
  const n = pts.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const d = Math.max(maxX - minX, maxY - minY) * 20, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const P = pts.map((p) => [p[0], p[1]]);
  P.push([cx - d, cy - d], [cx + d, cy - d], [cx, cy + d]);
  // triangle: {a,b,c, x,y,r2} with circumcircle
  const circ = (a, b, c) => {
    const ax = P[a][0], ay = P[a][1], bx = P[b][0], by = P[b][1], cx2 = P[c][0], cy2 = P[c][1];
    const D = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
    if (Math.abs(D) < 1e-12) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy2) + (bx * bx + by * by) * (cy2 - ay) + (cx2 * cx2 + cy2 * cy2) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx2 - bx) + (bx * bx + by * by) * (ax - cx2) + (cx2 * cx2 + cy2 * cy2) * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [circ(n, n + 1, n + 2)];
  // insert in a spatially sorted order: fewer bad triangles per step
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => (pts[i][0] - pts[j][0]) || (pts[i][1] - pts[j][1]));
  for (const i of order) {
    const px = P[i][0], py = P[i][1];
    const bad = [], keep = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 ? bad : keep).push(t);
    const edgeCount = new Map();
    const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
    for (const t of bad) for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) { const k = key(a, b); edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }
    for (const t of bad) for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      if (edgeCount.get(key(a, b)) !== 1) continue;
      const nt = circ(a, b, i);
      if (nt) keep.push(nt);
    }
    tris = keep;
  }
  const out = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    // CCW
    const ax = P[t.a][0], ay = P[t.a][1], bx = P[t.b][0], by = P[t.b][1], cx2 = P[t.c][0], cy2 = P[t.c][1];
    const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    out.push(area >= 0 ? [t.a, t.b, t.c] : [t.a, t.c, t.b]);
  }
  return out;
}

// poly: [[x,y],...] closed outline in order. Returns points (outline first, in
// the given order, then interior) and CCW triangles over them.
export function capPolygon(poly, spacing) {
  const n = poly.length;
  const pts = poly.map((p) => [p[0], p[1]]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const clear = spacing * 0.5;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) for (let x = minX + spacing / 2; x < maxX; x += spacing) {
    if (!pointInPolygon(x, y, poly)) continue;
    let ok = true;
    for (let i = 0, j = n - 1; i < n && ok; j = i++) if (distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]) < clear) ok = false;
    if (ok) pts.push([x, y]);
  }
  const all = delaunay(pts);
  const tris = [];
  for (const t of all) {
    const cx = (pts[t[0]][0] + pts[t[1]][0] + pts[t[2]][0]) / 3, cy = (pts[t[0]][1] + pts[t[1]][1] + pts[t[2]][1]) / 3;
    if (pointInPolygon(cx, cy, poly)) tris.push(t);
  }
  // every outline edge must be an edge of the cap
  const edges = new Set();
  const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (const t of tris) { edges.add(key(t[0], t[1])); edges.add(key(t[1], t[2])); edges.add(key(t[2], t[0])); }
  const missingEdges = [];
  for (let i = 0; i < n; i++) if (!edges.has(key(i, (i + 1) % n))) missingEdges.push(i);
  return { points: pts, triangles: tris, outlineCount: n, missingEdges };
}
