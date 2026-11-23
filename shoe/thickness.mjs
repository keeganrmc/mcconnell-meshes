// THICKNESS COLOURS and the GAP BRUSH — MASQ's, over the last's vertices.
//
// Three colours, each a territory of its own (a 0..1 field, its 0.5 isoline
// the edge, like the region) with a wall in mm; where none is painted the wall
// is the dial's. A stroke in one colour takes the others down under it, so a
// vertex carries one colour. The transition between colours is Blend's,
// re-profiled live from each colour's isoline (a smoothstep of the signed
// distance over the mesh's own band plus Blend) — not the brush's hardness.
// A patterned colour runs from its wall (Low) to High by the plate's own
// pattern field, fading to Low toward the region's rim over Falloff.
//
// The gap brush paints a 0..1 field; the piece stands off the last by the
// Gap dial plus the field times the gap brush's mm — room for a foot where
// the last is tight, a sock's thickness, a sole's bed.

import { quadsOfLast, quadAdjacency, signedDistanceToContour, patternWall, smoothDirections } from './plate.mjs';
import { vertexNormals } from './meshcut.mjs';
import { EDGES_ACROSS_BAND } from './paint.mjs';

export const COLOURS = ['c1', 'c2', 'c3'];
export const COLOUR_RGB = [[0.93, 0.36, 0.28], [0.27, 0.62, 0.93], [0.36, 0.78, 0.42]];

const smoothstep = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// the last's quad adjacency, cached by the caller per topology
export function thicknessContext(last) {
  const q = quadsOfLast(last.indices);
  if (!q.ok) return null;
  const adj = quadAdjacency(last.positions, q.quads);
  const dirs = smoothDirections(vertexNormals(last.positions, last.indices), adj, 4);
  return { adj, quads: q.quads, dirs };
}

// weights per painted colour (classes: which colours are present), clamped to
// sum to one; `rest` is the dial's share
export function colourWeights(fields, ctx, positions, blendMM) {
  const V = ctx.adj.V, present = [];
  for (let c = 0; c < COLOURS.length; c++) { const f = fields[c]; if (!f) continue; for (let i = 0; i < V; i++) if (f[i] >= 0.5) { present.push(c); break; } }
  if (!present.length) return null;
  const band = EDGES_ACROSS_BAND * ctx.adj.edgeMM;   // the crispest edge the mesh carries: Blend 0
  const width = band + Math.max(0, blendMM || 0);
  const w = present.map((c) => {
    const sd = signedDistanceToContour(fields[c], ctx.adj, positions);
    const wk = new Float32Array(V);
    for (let i = 0; i < V; i++) wk[i] = smoothstep(0.5 - sd[i] / width);   // sd is negative inside
    return wk;
  });
  const rest = new Float32Array(V);
  for (let i = 0; i < V; i++) { let s = 0; for (const wk of w) s += wk[i]; if (s > 1) { for (const wk of w) wk[i] /= s; s = 1; } rest[i] = 1 - s; }
  return { classes: present, w, rest };
}

/* The wall per vertex for a piece: the dial's wall where no colour is,
 * each colour's wall (flat, or Low→High by its pattern) where it is, blended
 * over Blend. `colours[c] = { mm, kind, hiMM, scaleMM, angleDeg, seed }`.
 * Returns { wall, tint: { amount, index } } — the tint is what the last shows. */
export function pieceWall(last, region, fields, ctx, opts) {
  const V = ctx.adj.V, P = last.positions;
  const base = opts.wallMM, wall = new Float32Array(V).fill(base);
  const tint = { amount: new Float32Array(V), index: new Float32Array(V) };
  const W = colourWeights(fields, ctx, P, opts.blendMM);
  if (!W) return { wall, tint, classes: [] };
  const inRegion = new Uint8Array(V); for (let i = 0; i < V; i++) inRegion[i] = region[i] >= 0.5 ? 1 : 0;
  const sd = signedDistanceToContour(region, ctx.adj, P);
  for (let i = 0; i < V; i++) wall[i] = base * W.rest[i];
  W.classes.forEach((c, k) => {
    const col = opts.colours[c] || {}, lo = Math.max(opts.minWall || 0.4, col.mm == null ? base : col.mm), wk = W.w[k];
    let pat = null;
    if (col.kind && col.kind !== 'flat' && col.kind !== 'none' && col.hiMM > lo) {
      pat = patternWall(inRegion, sd, { kind: col.kind, hiMM: col.hiMM - lo, scaleMM: col.scaleMM, angleDeg: col.angleDeg, seed: col.seed, smoothMM: 2, falloffMM: opts.falloffMM == null ? 6 : opts.falloffMM }, { positions: P, normals: ctx.dirs, adj: ctx.adj });
    }
    for (let i = 0; i < V; i++) {
      if (wk[i] <= 0) continue;
      wall[i] += wk[i] * (lo + (pat ? pat[i] : 0));
      tint.amount[i] += wk[i];
      tint.index[i] += wk[i] * (c + 1);
    }
  });
  for (let i = 0; i < V; i++) if (tint.amount[i] > 0) tint.index[i] /= tint.amount[i];
  return { wall, tint, classes: W.classes };
}

// the gap per vertex: the dial plus the brushed field times the brush's mm
export function pieceGap(V, gapField, gapMM, gapBrushMM, extra) {
  const gap = new Float32Array(V);
  for (let i = 0; i < V; i++) gap[i] = Math.max(0, gapMM || 0) + (gapField ? gapField[i] * Math.max(0, gapBrushMM || 0) : 0) + (extra ? (typeof extra === 'number' ? extra : extra[i]) : 0);
  return gap;
}

// a colour stroke takes the other colours down under it: the dab's field is
// the max-union the brush wrote; the others take min(other, 1 − dab)
export function yieldOtherColours(fields, painted, dabBefore, dabAfter) {
  const V = dabAfter.length;
  for (let c = 0; c < fields.length; c++) {
    if (c === painted || !fields[c]) continue;
    const f = fields[c];
    for (let i = 0; i < V; i++) { const rose = dabAfter[i] - dabBefore[i]; if (rose > 0) f[i] = Math.min(f[i], 1 - dabAfter[i]); }
  }
}
