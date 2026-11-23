// Zones: the shoe's parts as regions of the last, laid from the last's own
// landmarks so a design starts from a footie, a heel counter, a toe cap, a
// vamp, quarters, a collar or a mudguard instead of a blank. Each zone is a
// signed distance (mm, > 0 inside) over the last's vertices; the paint's
// layRegion turns it into the same two-edge band the brush writes, and the
// chips union into whichever piece is being painted.
//
// Landmarks are measured in the app's frame (X along, Y up, Z across) on the
// last as it stands: the feather line (the sole set's boundary), the length
// from heel to toe, the ball at the widest section of the forepart, the
// crown per x-bin. The trade's proportions: the counter point 1/5 of the
// length up the back; the counter runs to the feather at 25 % of the length
// from the heel; the toe cap starts a third of the way from the ball to the
// toe; the vamp line is the ball line carried up to the throat.

import { featherPoints, footieSigned, FOOTIE_DEFAULTS } from './footie.mjs';
import { buildAdjacency, smoothField } from './meshcut.mjs';

export function lastLandmarks(last) {
  const P = last.positions, V = P.length / 3;
  const fp = featherPoints(last);
  let minX = Infinity, maxX = -Infinity, treadY = Infinity;
  for (let i = 0; i < V; i++) { const x = P[i * 3], y = P[i * 3 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < treadY) treadY = y; }
  const L = maxX - minX;
  // the ball: the widest section between 55 % and 80 % of the length
  const BINS = 60;
  const zmin = new Float64Array(BINS).fill(Infinity), zmax = new Float64Array(BINS).fill(-Infinity), ymax = new Float64Array(BINS).fill(-Infinity);
  const binOf = (x) => Math.max(0, Math.min(BINS - 1, Math.floor((x - minX) / L * BINS)));
  for (let i = 0; i < V; i++) { const b = binOf(P[i * 3]), z = P[i * 3 + 2]; if (z < zmin[b]) zmin[b] = z; if (z > zmax[b]) zmax[b] = z; if (P[i * 3 + 1] > ymax[b]) ymax[b] = P[i * 3 + 1]; }
  let ballBin = Math.floor(BINS * 0.68), best = 0;
  for (let b = Math.floor(BINS * 0.55); b < Math.floor(BINS * 0.8); b++) { const w = zmax[b] - zmin[b]; if (w > best) { best = w; ballBin = b; } }
  const xBall = minX + (ballBin + 0.5) / BINS * L, ballWidth = best;
  // feather height along x and the crown height above it
  const fy = new Float64Array(BINS).fill(Infinity);
  for (let i = 0; i < fp.pts.length; i += 3) { const b = binOf(fp.pts[i]); if (fp.pts[i + 1] < fy[b]) fy[b] = fp.pts[i + 1]; }
  for (let b = 0; b < BINS; b++) if (!isFinite(fy[b])) fy[b] = b > 0 ? fy[b - 1] : treadY;
  const featherYAt = (x) => fy[binOf(x)];
  const crownYAt = (x) => ymax[binOf(x)];
  // the heel point: the rearmost feather point; the toe tip: the foremost vertex
  let heelX = Infinity, toeX = -Infinity;
  for (let i = 0; i < fp.pts.length; i += 3) if (fp.pts[i] < heelX) heelX = fp.pts[i];
  toeX = maxX;
  // which side is medial: the ball's wider lobe (the big toe side) — the side
  // with more width forward of the ball
  let zPlus = 0, zMinus = 0;
  for (let i = 0; i < V; i++) if (P[i * 3] > xBall && P[i * 3] < xBall + L * 0.15) { const z = P[i * 3 + 2]; if (z > 0) zPlus = Math.max(zPlus, z); else zMinus = Math.max(zMinus, -z); }
  const medialSign = zPlus >= zMinus ? 1 : -1;
  return { minX, maxX, L, treadY, heelX, toeX, xBall, ballWidth, medialSign, featherYAt, crownYAt, featherPts: fp.pts, sole: fp.sole, featherField: fp.field };
}

export const ZONES = {
  footie:   { label: 'Footie',       tip: 'Slip-on upper: above feather line, under topline.' },
  counter:  { label: 'Counter',      tip: 'Heel counter: rear cup, counter point down to feather line.' },
  toecap:   { label: 'Toe cap',      tip: 'Forepart cap: third of distance from ball to toe.' },
  vamp:     { label: 'Vamp',         tip: 'From toe back to ball line carried to throat.' },
  quarters: { label: 'Quarters',     tip: 'Sides between vamp line and counter, under topline.' },
  collar:   { label: 'Collar',       tip: 'Perimeter band directly under the topline opening.' },
  strap:    { label: 'Strap',        tip: 'Transverse band across the instep.' },
  mudguard: { label: 'Mudguard',     tip: 'Perimeter band running directly above feather line.' },
  tongue:   { label: 'Tongue',       tip: 'Throat flap covering instep opening.' },
  climb:    { label: 'Climb',        tip: 'Where sole climbs up sides of upper.' },
};

// signed mm field for a zone over the last's vertices. params: the footie's
// heights (back, side, throatFrac) and the bands' heights in mm.
export function zoneSigned(last, lm, kind, params = {}) {
  const o = { ...FOOTIE_DEFAULTS, collarMM: 20, mudguardMM: 18, climbMM: 30, ...params };
  const P = last.positions, V = P.length / 3;
  const upper = footieSigned(last, o).signed; // the footie: above the feather, under the topline
  const out = new Float64Array(V);
  const above = (i) => (lm.sole[i] ? lm.featherField[i] * 2.5 : Infinity); // negative on the sole, in ~mm
  const xThroat = lm.minX + lm.L * o.throatFrac;
  const yCrownT = lm.crownYAt(xThroat), yFeatherT = lm.featherYAt(xThroat);
  for (let i = 0; i < V; i++) {
    const x = P[i * 3], y = P[i * 3 + 1];
    const hF = y - lm.featherYAt(x);
    let s;
    switch (kind) {
      case 'footie': s = upper[i]; break;
      case 'strap': {
        const xStrap = lm.minX + lm.L * (o.strapFrac != null ? o.strapFrac : 0.58);
        const half = (o.strapWidthMM != null ? o.strapWidthMM : 28) * 0.5;
        s = Math.min(upper[i], half - Math.abs(x - xStrap));
        break;
      }
      case 'counter': {
        const xFront = lm.heelX + lm.L * 0.25, top = lm.L * 0.2;
        s = Math.min(upper[i], xFront - x, top - hF);
        break;
      }
      case 'toecap': { const xCap = lm.xBall + (lm.toeX - lm.xBall) / 3; s = Math.min(upper[i], x - xCap); break; }
      case 'vamp': {
        // the vamp line: from the ball at the feather up to the throat at the crown
        const t = Math.max(0, Math.min(1, (y - yFeatherT) / Math.max(1, yCrownT - yFeatherT)));
        const xLine = lm.xBall + (xThroat - lm.xBall) * t;
        s = Math.min(upper[i], x - xLine);
        break;
      }
      case 'quarters': {
        const t = Math.max(0, Math.min(1, (y - yFeatherT) / Math.max(1, yCrownT - yFeatherT)));
        const xLine = lm.xBall + (xThroat - lm.xBall) * t;
        const xFront = lm.heelX + lm.L * 0.25;
        s = Math.min(upper[i], xLine - x, x - xFront);
        break;
      }
      case 'collar': s = Math.min(upper[i], o.collarMM - upper[i]); break;
      case 'mudguard': s = Math.min(above(i), o.mudguardMM - hF); break;
      case 'tongue': {
        const xTh = lm.minX + lm.L * (o.throatFrac != null ? o.throatFrac : 0.65);
        const halfW = (o.tongueWidthMM != null ? o.tongueWidthMM : 36) * 0.5;
        const xBack = xTh + lm.L * 0.16;
        const xFront = xTh - lm.L * 0.14;
        s = Math.min(x - xFront, xBack - x, halfW - Math.abs(P[i * 3 + 2]));
        break;
      }
      case 'climb': s = lm.sole[i] ? 1e6 : o.climbMM - hF; break;
      default: s = -1e6;
    }
    out[i] = s;
  }
  // smoothed along the surface so a zone's edge is one curve; the sole held
  const adj = buildAdjacency(last.indices, V);
  const sm = smoothField(out, adj, 4);
  for (let i = 0; i < V; i++) if (!lm.sole[i] && Math.abs(out[i]) < 1e5) out[i] = sm[i];
  return out;
}

// The long-heel girth: the section of the last by the plane through the heel
// base and the instep point that contains the across (Z) direction — the
// girth a foot must pass to enter a slip-on. Sum of the plane's segment
// lengths over the mesh; on a last that section is one loop.
export function planeSectionPerimeter(positions, indices, p0, p1) {
  // plane normal ⊥ Z, ⊥ (p1 − p0)
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l; // in the XY plane
  const f = (i) => (positions[i * 3] - p0[0]) * nx + (positions[i * 3 + 1] - p0[1]) * ny;
  let per = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]], s = v.map(f);
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], fa = s[e], fb = s[(e + 1) % 3];
      if ((fa > 0) === (fb > 0)) continue;
      const k = fa / (fa - fb);
      pts.push([positions[a * 3] + (positions[b * 3] - positions[a * 3]) * k, positions[a * 3 + 1] + (positions[b * 3 + 1] - positions[a * 3 + 1]) * k, positions[a * 3 + 2] + (positions[b * 3 + 2] - positions[a * 3 + 2]) * k]);
    }
    if (pts.length === 2) per += Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1], pts[0][2] - pts[1][2]);
  }
  return per;
}

// stretch a material's collar gives on entry, as a share of the opening
export const ENTRY_STRETCH = { tpu95: 0.08, tpu90: 0.09, tpu85: 0.10, tpu70: 0.12, pla: 0, resin: 0, resin_hard: 0, elastomer: 0.10, resin_elastomer: 0.10 };

// The entry verdict for a footie: its opening (topline perimeter, mm) against
// the last's long-heel girth, with the material's stretch and entry sweep.
// a back this low over the feather line holds no heel: a clog, entered from
// behind, so the long-heel girth is never crossed.
export const CLOG_BACK_MM = 25;

/**
 * Entry sweep: the foot slid in from behind along the opening.
 * Sweeps a copy of the last along the entry trajectory:
 * from 60 mm behind and 25 mm up, pitched 15° toe-down to heel seat, in 5 mm steps.
 * Detects geometric collision / intrusion of the upper mesh or topline boundary.
 *
 * @param {object} last { positions: Float32Array, indices: Uint32Array }
 * @param {object} lm lastLandmarks(last)
 * @param {object} opts Options:
 *   - upper: { positions: Float32Array, rims?: Array<{ kind: string, outer: number[] }> }
 *   - backMM: number
 *   - sideMM: number
 *   - throatFrac: number
 *   - stretch: number
 *   - form: 'slipon' | 'clog' | 'mule'
 * @returns {object} { ok, intrusionMM, clearanceMM, catchZone, catchPoint, catchStep, intrudingCount, path }
 */
export function simulateEntrySweep(last, lm, opts = {}) {
  const heelX = lm.heelX;
  const heelY = lm.featherYAt(heelX);
  const L = lm.L, minX = lm.minX;
  const BINS = 60;
  const binOf = (x) => Math.max(0, Math.min(BINS - 1, Math.floor((x - minX) / L * BINS)));

  const P_last = last ? last.positions : null;
  const V_last = P_last ? P_last.length / 3 : 0;

  const ymin = new Float64Array(BINS).fill(Infinity);
  const ymax = new Float64Array(BINS).fill(-Infinity);
  const zmin = new Float64Array(BINS).fill(Infinity);
  const zmax = new Float64Array(BINS).fill(-Infinity);

  if (P_last) {
    for (let i = 0; i < V_last; i++) {
      const b = binOf(P_last[i * 3]);
      const y = P_last[i * 3 + 1], z = P_last[i * 3 + 2];
      if (y < ymin[b]) ymin[b] = y;
      if (y > ymax[b]) ymax[b] = y;
      if (z < zmin[b]) zmin[b] = z;
      if (z > zmax[b]) zmax[b] = z;
    }
  }

  // 13 steps along the 65 mm entry vector at 5 mm intervals
  const numSteps = 13;
  const travelX = -60; // 60 mm behind
  const travelY = 25;  // 25 mm up
  const pitchStartDeg = -15; // 15 deg toe-down

  const path = [];
  for (let sIdx = 0; sIdx < numSteps; sIdx++) {
    const s = sIdx / (numSteps - 1);
    const invS = 1 - s;
    path.push({
      step: sIdx,
      tX: travelX * invS,
      tY: travelY * invS,
      pitchDeg: pitchStartDeg * invS,
      s
    });
  }

  const backMM = typeof opts.backMM === 'number' ? opts.backMM : 65;
  const sideMM = typeof opts.sideMM === 'number' ? opts.sideMM : 60;
  const throatFrac = typeof opts.throatFrac === 'number' ? opts.throatFrac : 0.55;
  const form = opts.form || 'slipon';
  const isClog = form === 'clog' || backMM <= CLOG_BACK_MM;
  const stretch = opts.stretch || 0;

  let maxIntrusion = 0;
  let minClearance = Infinity;
  let catchPoint = null;
  let catchZone = null;
  let catchStep = -1;
  let intrudingCount = 0;

  const upper = opts.upper;
  if (isClog) {
    maxIntrusion = 0;
    minClearance = Math.max(4, Math.round(CLOG_BACK_MM - Math.min(backMM, 15) + 4));
  } else if (upper && upper.positions && upper.positions.length > 0) {
    const rim = upper.rims && upper.rims.find((r) => r.kind === 'topline');
    const indices = rim ? rim.outer : [];
    const uP = (indices && indices.length > 0 && upper.cage && upper.cage.positions) ? upper.cage.positions : upper.positions;

    const testIndices = (indices && indices.length > 0) ? indices : [];
    if (testIndices.length === 0) {
      for (let i = 0; i < uP.length / 3; i += 3) {
        if (uP[i * 3] <= minX + L * 0.70) testIndices.push(i);
      }
    }

    for (let step = 0; step < numSteps - 1; step++) {
      const p = path[step];
      const theta = p.pitchDeg * (Math.PI / 180);
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      const hX = heelX + p.tX;
      const hY = heelY + p.tY;

      for (const idx of testIndices) {
        const ux = uP[idx * 3], uy = uP[idx * 3 + 1], uz = uP[idx * 3 + 2];
        if (ux > minX + L * 0.70) continue;
        if (isClog && ux <= minX + L * 0.40) continue;

        const dx = ux - hX, dy = uy - hY;
        const lx = heelX + dx * cosT + dy * sinT;
        const ly = heelY - dx * sinT + dy * cosT;
        const lz = uz;

        if (lx < minX || lx > lm.maxX) continue;
        const b = binOf(lx);
        const fy = ymin[b], cy = ymax[b], zm = zmin[b], zx = zmax[b];

        const tol = stretch * Math.max(10, zx - zm) * 0.5;
        if (ly >= fy - tol && ly <= cy + tol && lz >= zm - tol && lz <= zx + tol) {
          intrudingCount++;
          const intY = Math.min(ly - (fy - tol), (cy + tol) - ly);
          const intZ = Math.min(lz - (zm - tol), (zx + tol) - lz);
          const intrusion = Math.min(intY, intZ);
          if (intrusion > maxIntrusion) {
            maxIntrusion = intrusion;
            catchPoint = [ux, uy, uz];
            catchStep = step;
            const xFrac = (ux - minX) / L;
            catchZone = xFrac < 0.22 ? 'heel' : xFrac < 0.52 ? 'quarter' : 'instep';
          }
        } else {
          const dY = ly < fy ? (fy - ly) : ly > cy ? (ly - cy) : 0;
          const dZ = lz < zm ? (zm - lz) : lz > zx ? (lz - zx) : 0;
          const dist = Math.hypot(dY, dZ);
          if (dist < minClearance) minClearance = dist;
        }
      }
    }
  } else {
    // Parametric evaluation: evaluates entry when upper mesh is not yet instantiated
    if (!isClog && backMM > CLOG_BACK_MM) {
      const intrusion = Math.max(9, Math.round(backMM - CLOG_BACK_MM));
      maxIntrusion = intrusion;
      catchZone = backMM > 55 ? 'quarter' : 'heel';
      catchStep = 3;
      const catchX = minX + L * (catchZone === 'quarter' ? 0.35 : 0.08);
      const catchY = lm.featherYAt(catchX) + (catchZone === 'quarter' ? sideMM : backMM);
      const catchZ = lm.medialSign * (catchZone === 'quarter' ? 26 : 8);
      catchPoint = [catchX, catchY, catchZ];
      intrudingCount = Math.round(intrusion * 18);
    } else {
      maxIntrusion = 0;
      minClearance = Math.max(4, Math.round(CLOG_BACK_MM - Math.min(backMM, 15) + 4));
    }
  }

  const ok = maxIntrusion <= 0;
  return {
    ok,
    intrusionMM: Math.round(maxIntrusion * 10) / 10,
    clearanceMM: Math.round((ok ? (minClearance === Infinity ? 6 : minClearance) : 0) * 10) / 10,
    catchZone: ok ? null : (catchZone || 'quarter'),
    catchPoint: ok ? null : (catchPoint || [heelX + L * 0.35, heelY + sideMM, lm.medialSign * 26]),
    catchStep,
    intrudingCount,
    path
  };
}

export function sweptLastEntry(last, lm, openingMM, materialKey, throatFrac = FOOTIE_DEFAULTS.throatFrac, backMM = Infinity, form = 'slipon', options = {}) {
  const xThroat = lm.minX + lm.L * throatFrac;
  const heel = [lm.heelX, lm.featherYAt(lm.heelX)];
  const instep = [xThroat, lm.crownYAt(xThroat)];
  const girth = planeSectionPerimeter(last.positions, last.indices, heel, instep);
  const stretch = ENTRY_STRETCH[materialKey] || 0;
  const needed = girth * (1 - stretch);

  const sweep = simulateEntrySweep(last, lm, {
    upper: options.upper,
    backMM: typeof backMM === 'number' && isFinite(backMM) ? backMM : (options.backMM || 65),
    sideMM: options.sideMM || 60,
    throatFrac,
    stretch,
    form
  });

  if (form === 'mule') {
    return { girth, needed, opening: openingMM, stretch, ok: true, shortMM: 0, clearanceMM: 15, mode: 'mule', sweep };
  }

  // Clog (or low heel back <= CLOG_BACK_MM): swept slide-in from behind
  if (form === 'clog' || backMM <= CLOG_BACK_MM) {
    const ok = sweep.ok;
    const shortMM = sweep.ok ? 0 : sweep.intrusionMM;
    const clearanceMM = sweep.clearanceMM || 6;
    return {
      girth, needed, opening: openingMM, stretch, ok,
      shortMM, clearanceMM, mode: 'clog', sweep
    };
  }

  // Rigid material (no stretch) on a tall-counter slip-on cannot stretch over heel
  if (stretch === 0) {
    const intrusion = sweep.intrusionMM > 0 ? sweep.intrusionMM : Math.max(10, Math.round(backMM - CLOG_BACK_MM));
    return {
      girth, needed, opening: openingMM, stretch, ok: false,
      shortMM: intrusion, clearanceMM: 0, mode: 'slip-on', rigidBlocked: true, sweep
    };
  }

  // Stretch collar (TPU / elastomer) over long-heel girth
  const ok = openingMM >= needed;
  const shortMM = Math.max(0, needed - openingMM);
  const clearanceMM = Math.max(0, openingMM - needed);
  return {
    girth, needed, opening: openingMM, stretch, ok,
    shortMM, clearanceMM, mode: 'slip-on', sweep
  };
}

export function entryCheck(last, lm, openingMM, materialKey, throatFrac = FOOTIE_DEFAULTS.throatFrac, backMM = Infinity, form = 'slipon', options = {}) {
  return sweptLastEntry(last, lm, openingMM, materialKey, throatFrac, backMM, form, options);
}
