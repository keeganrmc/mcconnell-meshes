// The Ground form: a sole lofted from the last's feather line down to a floor,
// with a sidewall relief that is full at the floor and gone by a height —
// the Terrainer. Below the feather line the piece is a loft in rings; above
// it (the sidewall band, up to `bandHeight` or a painted coverage) it is an
// offset shell of the last along its normals. The inner sheet is the last
// itself, at `gap` (the walls of any layers under this one), so the interior
// is exactly the surface it sits on.
//
//   feather line ─┬─ band outer sheet (last + gap + wall + relief, along n)
//                 │
//   ring 0 ───────┴─ = the band's outer feather loop
//   ring 1..M        (x,z) = feather + m·(offset(t) + relief(u,h)), y → floor
//   floor cap        y = floor + contact(x,z); heel pad and ball pad at 0
//
// Frame: the app's (X along, Y up, Z across). mm. The last's lowest point is
// its tread; the ground is `stack` below it; this layer's floor is `stop`
// above the ground (0 for the bottom layer of a stack).

import { featherField, buildAdjacency, smoothField, refineAtIsoline, triangleSides, boundaryLoops, loopArcParam, meshClosure, signedVolume, meshArea } from './meshcut.mjs';
import { capPolygon, polygonArea } from './floor.mjs';
import { regionShell, stripBetween, distanceFrom } from './shell.mjs';

export const GROUND_DEFAULTS = {
  stack: 30,          // mm from the tread to the ground
  stop: 0,            // mm above the ground where this layer's floor is
  edge: 6,            // mm the sidewall stands out from the feather line at the floor
  draft: 'straight',  // 'straight' | 'flared' | 'undercut'
  rings: 24,          // rings from the feather line to the floor
  chartMM: 2.5,       // spacing of the chart's points around the footprint
  bandHeight: 0,      // mm the sole climbs the side above the feather line (0 = sole only)
  wall: 2,            // mm base wall of the band above the feather
  taper: 3,           // mm over which the band's wall fades to the rim
  gap: 0,             // per-vertex or number: what the sole sits on, over the last
  soleSet: null,      // Uint8Array over the substrate: the sole given outright (a piece grown on another piece's floor)
  bandGap: null,      // number: what the band sits on above the feather (an upper's wall); null = gap
  relief: null,       // { amp, top, sample(u,v)→0..1, tilesU, tilesV }
  tread: null,        // { depth, sample(u,v)→0..1, summits } the floor's relief: a range hanging under the foot, summits DOWN on the ground.
                      // depth = how far the valleys rise toward the foot (a groove tread at 3 mm, a mountain range at the stack);
                      // summits = the share of the range levelled flat to the ground as the contact (0.15 = the top 15 % of the heights)
  contact: { toeRocker: 8, heelBevel: 4, waistRise: 0, ballFrac: 0.68, padHalf: 15, heelFrac: 0.25, gridMM: 5 },
};

// smoothstep 1 → 0 over [0, top]
function fallOff(h, top) { if (top <= 0) return h <= 0 ? 1 : 0; const t = Math.max(0, Math.min(1, h / top)); return 1 - t * t * (3 - 2 * t); }

function draftShape(kind, t) {
  if (kind === 'flared') return t * t;               // stays in, then bells out at the floor
  if (kind === 'undercut') return Math.sin(Math.PI * t); // out at mid-height, back under at the floor
  return t;                                          // straight
}

export function buildGround(last, options = {}) {
  const o = { ...GROUND_DEFAULTS, ...options, contact: { ...GROUND_DEFAULTS.contact, ...(options.contact || {}) } };
  const { positions: P0, indices: I0 } = last;
  const V0 = P0.length / 3;
  const cl0 = meshClosure(I0);
  if (cl0.doubledEdges || cl0.boundaryEdges) return { ok: false, reason: 'mesh', detail: `the last is not a closed manifold: ${cl0.doubledEdges} doubled edges, ${cl0.boundaryEdges} boundary edges` };

  // 1. the feather line, cut into the mesh; normals ride along
  const ff = featherField(P0, I0, o.soleSet ? { soleSet: o.soleSet } : {});
  const gap0 = typeof o.gap === 'number' ? new Float32Array(V0).fill(o.gap) : o.gap;
  const r1 = refineAtIsoline(P0, I0, ff.field, [{ stride: 3, data: ff.normals, unit: true }, { stride: 1, data: gap0 }]);
  let P = r1.positions, I = r1.indices, feather = r1.values, N = r1.attrs[0].data, gap = r1.attrs[1].data;
  let V = P.length / 3;

  // the feather loop's height along X, for the band's height reference
  const sideOf = triangleSides(I, feather);
  const soleUse = Array.from(sideOf, (s) => s < 0);
  const fLoops = boundaryLoops(I, soleUse);
  if (fLoops.length !== 1) return { ok: false, reason: 'feather', detail: `${fLoops.length} feather loops` };
  const featherLoop0 = fLoops[0];

  // 2. the band above the feather: by coverage if given, else by height
  let cov;
  if (o.coverage) {
    // coverage was painted on the ORIGINAL vertices; carry it through the cut
    const c1 = refineAtIsoline(P0, I0, ff.field, [{ stride: 1, data: o.coverage }]).attrs[0].data;
    cov = new Float64Array(V); for (let i = 0; i < V; i++) cov[i] = c1[i] - 0.5;
  } else {
    cov = new Float64Array(V);
    // nearest feather vertex in XZ gives the local feather height
    const fx = featherLoop0.map((i) => P[i * 3]), fz = featherLoop0.map((i) => P[i * 3 + 2]), fy = featherLoop0.map((i) => P[i * 3 + 1]);
    for (let i = 0; i < V; i++) {
      if (feather[i] <= 0) { cov[i] = 1; continue; }
      let best = 0, bd = Infinity;
      for (let k = 0; k < fx.length; k++) { const d = (P[i * 3] - fx[k]) ** 2 + (P[i * 3 + 2] - fz[k]) ** 2; if (d < bd) { bd = d; best = k; } }
      cov[i] = fy[best] + o.bandHeight - P[i * 3 + 1];
    }
    // the nearest-feather-vertex reference steps along the loop; smooth the
    // field so the rim is one curve, holding the sole side where it is
    const adj1 = buildAdjacency(I, V);
    const sm = smoothField(cov, adj1, 6);
    for (let i = 0; i < V; i++) if (feather[i] > 0) cov[i] = sm[i];
  }
  const r2 = refineAtIsoline(P, I, cov, [{ stride: 3, data: N, unit: true }, { stride: 1, data: gap }, { stride: 1, data: feather }]);
  P = r2.positions; I = r2.indices; cov = r2.values; N = r2.attrs[0].data; gap = r2.attrs[1].data; feather = r2.attrs[2].data; V = P.length / 3;
  const T = I.length / 3;
  const fside = triangleSides(I, feather), cside = triangleSides(I, cov);
  const inSole = new Array(T), inBand = new Array(T);
  for (let t = 0; t < T; t++) { inSole[t] = fside[t] < 0; inBand[t] = fside[t] > 0 && cside[t] > 0; }
  const bandLoops = boundaryLoops(I, inBand);
  const soleLoops = boundaryLoops(I, inSole);
  if (soleLoops.length !== 1) return { ok: false, reason: 'feather', detail: `${soleLoops.length} feather loops after the band cut` };
  // the loft attaches along the feather line; its projection must be a simple
  // curve. A last whose ball mass overhangs its footbed folds it back on
  // itself, and a loft on a folded curve is a self-crossing sole.
  {
    const L = soleLoops[0], n = L.length, poly = L.map((i) => [P[i * 3], P[i * 3 + 2]]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let folds = 0;
    for (let i = 0; i < n && folds < 4; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = poly[i], b = poly[(i + 1) % n], c = poly[j], d2 = poly[(j + 1) % n];
      if (cross(a, b, c) * cross(a, b, d2) < 0 && cross(c, d2, a) * cross(c, d2, b) < 0) { folds++; break; }
    }
    if (folds) return { ok: false, reason: 'fold', detail: `the feather line folds back on itself in plan at ${folds}+ places — the last's underside overhangs its footbed` };
  }
  // the band's loops: the one made of feather vertices is the feather loop; the rest are rims
  const isFeatherV = (i) => Math.abs(feather[i]) < 1e-9;
  let featherLoop = null; const rimLoops = [];
  for (const L of bandLoops) { if (L.every(isFeatherV)) featherLoop = L; else rimLoops.push(L); }
  if (o.bandHeight <= 0 && !o.coverage) featherLoop = null;
  const hasBand = !!featherLoop;
  // with no band the loft starts from the sole's own boundary, run the other way round
  const loop = hasBand ? featherLoop : soleLoops[0].slice().reverse();
  const K = loop.length;

  // 3. stance and floor
  let treadY = Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < V; i++) { const y = P[i * 3 + 1]; if (y < treadY) treadY = y; }
  const groundY = treadY - o.stack, floorY = groundY + o.stop;

  // 4. per-vertex wall for the band: base wall tapering to the rim, plus relief
  const { u: uLoop } = loopArcParam(P, loop);
  const uOf = new Float64Array(V).fill(-1);
  loop.forEach((i, k) => { uOf[i] = uLoop[k]; });
  const fx = loop.map((i) => P[i * 3]), fz = loop.map((i) => P[i * 3 + 2]);
  const nearestU = (x, z) => { let best = 0, bd = Infinity; for (let k = 0; k < K; k++) { const d = (x - fx[k]) ** 2 + (z - fz[k]) ** 2; if (d < bd) { bd = d; best = k; } } return uLoop[best]; };
  const relief = (u, h) => {
    if (!o.relief || !o.relief.amp) return 0;
    const r = o.relief, s = r.sample(((u * (r.tilesU || 1)) % 1 + 1) % 1, (((h / Math.max(1, o.stack)) * (r.tilesV || 1)) % 1 + 1) % 1);
    return r.amp * fallOff(h, r.top) * (s - 0.5) * 2;
  };
  // gaps: the sole sits on what is under it (`gap`); the band sits on what is
  // under it there (`bandGap`, the upper's wall when one exists). Feather
  // vertices carry both, and a step strip joins the two inner sheets.
  const soleGap = (i) => gap[i];
  const bandGap = typeof o.bandGap === 'number' ? () => o.bandGap : (i) => gap[i];

  // 5. assemble. One output vertex table.
  const table = { out: [], idx: [] };
  const { out, idx } = table;
  const push = (x, y, z) => { out.push(x, y, z); return out.length / 3 - 1; };
  // the sole's inner sheet, reversed
  const innerSole = new Int32Array(V).fill(-1);
  for (let t = 0; t < T; t++) if (inSole[t]) for (let e = 0; e < 3; e++) {
    const i = I[t * 3 + e]; if (innerSole[i] >= 0) continue;
    const g = soleGap(i);
    innerSole[i] = push(P[i * 3] + N[i * 3] * g, P[i * 3 + 1] + N[i * 3 + 1] * g, P[i * 3 + 2] + N[i * 3 + 2] * g);
  }
  for (let t = 0; t < T; t++) if (inSole[t]) idx.push(innerSole[I[t * 3]], innerSole[I[t * 3 + 2]], innerSole[I[t * 3 + 1]]);
  // the band: a shell with the feather loop left open
  let band = null, rimLoopsOut = [];
  if (hasBand) {
    const rimDist = distanceFrom(P, I, inBand, rimLoops.flat());
    const wallOf = (i) => {
      const tp = o.taper > 0 ? Math.min(1, rimDist[i] / o.taper) : 1;
      const h = P[i * 3 + 1] - floorY;
      const u = uOf[i] >= 0 ? uOf[i] : nearestU(P[i * 3], P[i * 3 + 2]);
      return Math.max(1.2, (o.wall + relief(u, h)) * tp); // never under a printable wall at the rim
    };
    band = regionShell(P, I, N, inBand, bandGap, wallOf, (L) => L.every(isFeatherV), table);
    for (const L of band.loops) if (L.open) {
      // step between the sole's inner feather ring and the band's inner feather ring
      stripBetween(L.loop.map((i) => band.innerOf[i]), L.loop.map((i) => innerSole[i]), idx);
    } else rimLoopsOut.push(L.outer);
  }

  // 6. the loft. ring 0 = the loop's outer vertices (band) or inner (no band)
  const ring0 = loop.map((i) => (hasBand ? band.outerOf[i] : innerSole[i]));
  // 2D outward normals of the loop in XZ
  const area = polygonArea(loop.map((i) => [P[i * 3], P[i * 3 + 2]]));
  // The feather line is a surface curve; its projection can zigzag (a lumpy
  // side, a cut that grazes vertices). Ring 0 is exact; from ring 2 the base
  // curve is a smoothed copy of the projection, so the floor outline is one
  // simple curve and the loft between is the ledge.
  const base = new Float64Array(K * 2);
  for (let k = 0; k < K; k++) { base[k * 2] = P[loop[k] * 3]; base[k * 2 + 1] = P[loop[k] * 3 + 2]; }
  let sm = Float64Array.from(base);
  for (let pass = 0; pass < 24; pass++) {
    const nx = new Float64Array(K * 2);
    for (let k = 0; k < K; k++) {
      const a = (k + K - 1) % K, b = (k + 1) % K;
      nx[k * 2] = (sm[a * 2] + sm[k * 2] + sm[b * 2]) / 3; nx[k * 2 + 1] = (sm[a * 2 + 1] + sm[k * 2 + 1] + sm[b * 2 + 1]) / 3;
    }
    sm = nx;
  }
  // The tangent is taken between points at least `reach` mm away along the
  // loop on each side, not the immediate neighbours: the isoline cut leaves
  // segments of 0.03 mm next to segments of 6 mm, and a normal read off a
  // 0.03 mm segment points anywhere, which folds the offset ring.
  const m = new Float64Array(K * 2);
  const reach = 3;
  const chord = (i, j) => Math.hypot(P[loop[i] * 3] - P[loop[j] * 3], P[loop[i] * 3 + 2] - P[loop[j] * 3 + 2]);
  for (let k = 0; k < K; k++) {
    let ka = (k + K - 1) % K, kb = (k + 1) % K;
    for (let s = 1; s < K / 4 && chord(k, ka) < reach; s++) ka = (k + K - s) % K;
    for (let s = 1; s < K / 4 && chord(k, kb) < reach; s++) kb = (k + s) % K;
    let tx = sm[kb * 2] - sm[ka * 2], tz = sm[kb * 2 + 1] - sm[ka * 2 + 1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    // rotate the tangent by 90° toward the outside: sign from the loop's turn
    const s = area > 0 ? 1 : -1;
    m[k * 2] = tz * s; m[k * 2 + 1] = -tx * s;
  }
  const off0 = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const i = loop[k], r = ring0[k];
    off0[k] = (out[r * 3] - P[i * 3]) * m[k * 2] + (out[r * 3 + 2] - P[i * 3 + 2]) * m[k * 2 + 1];
  }
  const y0 = ring0.map((r) => out[r * 3 + 1]);
  // Rings 1..M are the chart: Kc points at uniform arc length, so the loft's
  // quads are even, the floor outline is simple, and (θ, h) is a real chart.
  // Ring 0 keeps the mesh's own K vertices; a zipper joins the two.
  const { length: loopLen } = loopArcParam(P, loop);
  const Kc = Math.max(48, Math.round(loopLen / (o.chartMM || 2.5)));
  const at = (arr, stride, u) => { // linear interpolation around the loop by arc parameter
    let k = 0; while (k + 1 < K && uLoop[k + 1] <= u) k++;
    const k2 = (k + 1) % K, u1 = uLoop[k], u2 = k2 === 0 ? 1 : uLoop[k2];
    const f = u2 > u1 ? (u - u1) / (u2 - u1) : 0;
    const r = new Array(stride);
    for (let c = 0; c < stride; c++) r[c] = arr[k * stride + c] + (arr[k2 * stride + c] - arr[k * stride + c]) * f;
    return r;
  };
  const cBase = new Float64Array(Kc * 2), cM = new Float64Array(Kc * 2), cOff0 = new Float64Array(Kc), cY0 = new Float64Array(Kc), cU = new Float64Array(Kc);
  for (let q = 0; q < Kc; q++) {
    const u = q / Kc; cU[q] = u;
    const b = at(sm, 2, u), mm = at(m, 2, u), l = Math.hypot(mm[0], mm[1]) || 1;
    cBase[q * 2] = b[0]; cBase[q * 2 + 1] = b[1]; cM[q * 2] = mm[0] / l; cM[q * 2 + 1] = mm[1] / l;
    cOff0[q] = at(off0, 1, u)[0]; cY0[q] = at(y0, 1, u)[0];
  }
  // the floor's relief, sampled on the floor's own chart (x along, z across),
  // from the chart's extents so the rings above can share it
  let fminX = Infinity, fmaxX = -Infinity, fminZ = Infinity, fmaxZ = -Infinity;
  for (let q = 0; q < Kc; q++) { const x = cBase[q * 2] + cM[q * 2] * o.edge, z = cBase[q * 2 + 1] + cM[q * 2 + 1] * o.edge; if (x < fminX) fminX = x; if (x > fmaxX) fmaxX = x; if (z < fminZ) fminZ = z; if (z > fmaxZ) fmaxZ = z; }
  const L = fmaxX - fminX;
  const tread = (x, z) => {
    if (!o.tread || !(o.tread.depth > 0)) return 0;
    const u = (x - fminX) / Math.max(1, L), v = (z - fminZ) / Math.max(1, fmaxZ - fminZ);
    const sv = o.tread.sample(u, v), summits = Math.max(0.02, Math.min(0.98, o.tread.summits ?? 0.55));
    // heights ≥ (1 − summits) are the summits: levelled to the ground with a
    // short shoulder; below them the range rises toward the foot by depth
    const level = 1 - summits, shoulder = 0.06;
    const t = Math.max(0, Math.min(1, (level - sv) / (level || 1e-6)));
    const edge = Math.max(0, Math.min(1, (level + shoulder - sv) / shoulder)); // 1 in the valleys, 0 on the summits
    const rise = t * t * (3 - 2 * t);
    return o.tread.depth * Math.min(rise, edge * edge * (3 - 2 * edge));
  };
  const rings = [];
  const quads = [];
  for (let j = 1; j <= o.rings; j++) {
    const t = j / o.rings;
    const ring = new Array(Kc);
    for (let q = 0; q < Kc; q++) {
      const y = cY0[q] + (floorY - cY0[q]) * t;
      const h = y - floorY;
      const off = Math.max(1, cOff0[q] + (o.edge - cOff0[q]) * draftShape(o.draft, t) + relief(cU[q], h));
      const x = cBase[q * 2] + cM[q * 2] * off, z = cBase[q * 2 + 1] + cM[q * 2 + 1] * off;
      // the range reaches the silhouette: the bottom third of the rings lift with the floor's relief
      const w = Math.max(0, Math.min(1, (t - 0.66) / 0.34)), lift = tread(x, z) * w * w * (3 - 2 * w);
      ring[q] = push(x, Math.min(y + lift, cY0[q] - 1), z);
    }
    if (j === 1) {
      // zipper ring 0 (K, params uLoop) to ring 1 (Kc, params cU), both from u = 0
      let a = 0, b = 0;
      while (a < K || b < Kc) {
        const ua = a < K ? uLoop[(a + 1) % K] || 1 : 2, ub = b < Kc ? (b + 1) / Kc : 2;
        const A = ring0[a % K], A2 = ring0[(a + 1) % K], B = ring[b % Kc], B2 = ring[(b + 1) % Kc];
        if (a < K && (ua <= ub || b >= Kc)) { idx.push(A2, A, B); a++; }
        else { idx.push(A, B, B2); b++; }
      }
    } else {
      const prev = rings[rings.length - 1];
      for (let q = 0; q < Kc; q++) {
        const a = prev[q], b = prev[(q + 1) % Kc], a2 = ring[q], b2 = ring[(q + 1) % Kc];
        idx.push(b, a, a2); idx.push(b, a2, b2);
        quads.push(b, a, a2, b2);
      }
    }
    rings.push(ring);
  }

  // 7. the floor cap, with the contact profile
  const floorRing = rings[rings.length - 1];
  const poly = floorRing.map((r) => [out[r * 3], out[r * 3 + 2]]);
  const cap = capPolygon(poly, o.tread && o.tread.depth > 0 ? Math.min(o.contact.gridMM, 3) : o.contact.gridMM);
  if (cap.missingEdges.length) return { ok: false, reason: 'floor', detail: `${cap.missingEdges.length} outline edges missing from the cap` };
  const c = o.contact;
  const xBall = fminX + L * c.ballFrac, xHeelPad = fminX + L * c.heelFrac;
  const contact = (x) => {
    if (x >= xBall + c.padHalf) { const s = (x - xBall - c.padHalf) / Math.max(1, fmaxX - xBall - c.padHalf); return c.toeRocker * s * s; }
    if (x <= fminX + c.heelBevel * 3) { const s = (fminX + c.heelBevel * 3 - x) / (c.heelBevel * 3); return c.heelBevel * s * s; }
    if (x > xHeelPad && x < xBall - c.padHalf) { const s = (x - xHeelPad) / (xBall - c.padHalf - xHeelPad); return c.waistRise * Math.sin(Math.PI * s) ** 2; }
    return 0;
  };
  const capIdx = new Int32Array(cap.points.length);
  for (let k = 0; k < cap.points.length; k++) {
    if (k < cap.outlineCount) { capIdx[k] = floorRing[k]; continue; }
    const [x, z] = cap.points[k];
    capIdx[k] = push(x, floorY + contact(x) + tread(x, z), z);
  }
  // the loft's last ring runs one way; the cap's boundary must run the other
  const want = -Math.sign(area) || 1; // sign of the reversed polygon's area in (x, z)
  for (const tri of cap.triangles) {
    const [a, b, cc] = tri;
    const ax = cap.points[a][0], az = cap.points[a][1], bx = cap.points[b][0], bz = cap.points[b][1], cx = cap.points[cc][0], cz = cap.points[cc][1];
    const s = Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
    if (s === want) idx.push(capIdx[a], capIdx[b], capIdx[cc]); else idx.push(capIdx[a], capIdx[cc], capIdx[b]);
  }

  const positions = Float32Array.from(out), indices = Uint32Array.from(idx);
  const closure = meshClosure(indices);
  let volume = signedVolume(positions, indices);
  if (volume < 0) { // whole thing inside out: flip once
    for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
    volume = -volume;
  }
  return {
    ok: true, positions, indices, quads: Uint32Array.from(quads),
    loops: { feather: ring0, floor: floorRing, rims: rimLoopsOut },
    floorCap: { ring: floorRing, interior: Array.from(capIdx).filter((v, k) => k >= cap.outlineCount) },
    stats: { vertices: positions.length / 3, triangles: indices.length / 3, treadY, groundY, floorY, K, rings: o.rings, hasBand, ...closure, volumeCm3: volume / 1000, areaCm2: meshArea(positions, indices) / 100, floorLength: L },
  };
}
