// Paint on a substrate: a coverage field 0..1 per vertex whose 0.5 contour is
// a region's boundary. MASQ's brush, in mm, over any triangle mesh:
//
// - the geodesic walk BOUNDS the brush (a stroke on the vamp cannot paint
//   through to the sole), the falloff is measured straight to the dab path
//   (isotropic, never longer than the walk);
// - a stroke is the UNION of its dabs (max), the eraser the min against
//   1 − fall — a sum would scallop the 0.5 crossing;
// - hardness moves the band's WIDTH and never the 0.5 crossing: the band is
//   centred at half the radius, from the knee (two edges) to the full radius.
//
// A laid region (a chip) writes the same kind of field from a signed
// distance, so the chip and the brush meet on equal terms.

export const EDGES_ACROSS_BAND = 4;

export function createSubstrate(positions, indices, normals) {
  const V = positions.length / 3;
  const deg = new Uint32Array(V + 1);
  const pairs = [];
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3];
    pairs.push(a, b, b, a);
  }
  // CSR adjacency, deduplicated
  const sets = Array.from({ length: V }, () => new Set());
  for (let i = 0; i < pairs.length; i += 2) sets[pairs[i]].add(pairs[i + 1]);
  let total = 0; for (let v = 0; v < V; v++) { deg[v] = total; total += sets[v].size; } deg[V] = total;
  const nbr = new Uint32Array(total);
  const lens = [];
  for (let v = 0; v < V; v++) { let k = deg[v]; for (const w of sets[v]) { nbr[k++] = w; if (w > v) lens.push(Math.hypot(positions[w * 3] - positions[v * 3], positions[w * 3 + 1] - positions[v * 3 + 1], positions[w * 3 + 2] - positions[v * 3 + 2])); } }
  lens.sort((a, b) => a - b);
  const edgeMM = lens.length ? lens[lens.length >> 1] : 1;
  return { positions, indices, normals, V, off: deg, nbr, edgeMM };
}

// vertices within `radius` mm of the seeds, walking edges; Map v → distance
export function geodesic(sub, seeds, radius) {
  const { positions: pos, off, nbr } = sub;
  const seen = new Map(), q = [];
  for (const v of seeds) if (!seen.has(v)) { seen.set(v, 0); q.push(v); }
  let head = 0;
  while (head < q.length) {
    const v = q[head++], d = seen.get(v);
    for (let k = off[v]; k < off[v + 1]; k++) {
      const w = nbr[k];
      const nd = d + Math.hypot(pos[w * 3] - pos[v * 3], pos[w * 3 + 1] - pos[v * 3 + 1], pos[w * 3 + 2] - pos[v * 3 + 2]);
      if (nd >= radius) continue;
      if (seen.has(w) && seen.get(w) <= nd) continue;
      seen.set(w, nd); q.push(w);
    }
  }
  return seen;
}

// squared distance from a point to a polyline (flat xyz)
export function distToPath2(P, x, y, z) {
  if (P.length < 6) { const dx = x - P[0], dy = y - P[1], dz = z - P[2]; return dx * dx + dy * dy + dz * dz; }
  let best = Infinity;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
    const vx = bx - ax, vy = by - ay, vz = bz - az, l2 = vx * vx + vy * vy + vz * vz;
    let t = l2 > 0 ? ((x - ax) * vx + (y - ay) * vy + (z - az) * vz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x - (ax + vx * t), dy = y - (ay + vy * t), dz = z - (az + vz * t);
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

// One dab (or a segment of dabs). seeds: vertex indices the dab lands on;
// path: the dab polyline (flat xyz), or null for the seeds' own positions.
// sign +1 paints, −1 erases. hardness 0..100. paintable: per-vertex 0/1 or null.
export function paintAt(sub, field, seeds, radius, { sign = 1, hardness = 50, path = null, paintable = null } = {}) {
  const { positions: pos } = sub;
  const seen = geodesic(sub, seeds, radius);
  const P = path && path.length >= 3 ? path : Float32Array.from(seeds.flatMap((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]));
  const a = 0.5 * radius;
  const knee = Math.min(a, (EDGES_ACROSS_BAND / 2) * sub.edgeMM);
  const band = knee + (1 - hardness / 100) * (a - knee);
  let touched = 0;
  for (const [v] of seen) {
    if (paintable && paintable[v] < 0.5) continue;
    const d = Math.sqrt(distToPath2(P, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
    const t = Math.max(0, Math.min(1, (a + band - d) / (2 * band)));
    const fall = t * t * (3 - 2 * t);
    const before = field[v];
    field[v] = sign > 0 ? Math.max(before, fall) : Math.min(before, 1 - fall);
    if (field[v] !== before) touched++;
  }
  return touched;
}

// Lay a region from a signed distance (mm, > 0 inside): the same band the
// brush writes, two edges across, so a laid rim and a painted rim are alike.
// mode 'set' replaces the field; 'add' unions; 'cut' subtracts.
export function layRegion(sub, field, signed, mode = 'set') {
  const half = (EDGES_ACROSS_BAND / 2) * sub.edgeMM;
  for (let v = 0; v < sub.V; v++) {
    const t = Math.max(0, Math.min(1, (signed[v] + half) / (2 * half)));
    const f = t * t * (3 - 2 * t);
    if (mode === 'set') field[v] = f;
    else if (mode === 'add') field[v] = Math.max(field[v], f);
    else field[v] = Math.min(field[v], 1 - f);
  }
}

export function packField(field) {
  const u = new Uint16Array(field.length);
  for (let i = 0; i < field.length; i++) u[i] = Math.round(Math.max(0, Math.min(1, field[i])) * 65535);
  let s = ''; const b = new Uint8Array(u.buffer);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unpackField(text, V) {
  const s = atob(text), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  const n = V ? Math.min(V, b.length >> 1) : b.length >> 1;
  const u = new Uint16Array(b.buffer, 0, n);
  const f = new Float32Array(V || n);
  for (let i = 0; i < u.length; i++) f[i] = u[i] / 65535;
  return f;
}
