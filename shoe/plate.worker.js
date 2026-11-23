/* buildPlate off the main thread: the lift and two Catmull-Clark levels are
 * ~0.1 s on the 4,197-quad last and the dihedral measure another 0.1, and a
 * settle rebuilds it. One message in, one out, plain data both ways; the
 * client (createPlateWorker in plate.mjs) drops a result whose id is not the
 * latest asked. A sampler cannot cross postMessage, so a terrain arrives as
 * a descriptor — { kind, seed, scale } for relief.mjs's kinds, a
 * 'place:<key>' kind loading MASQ's heightfield here — and is resolved
 * before the build; opts.terrain (the terrain texture) names its place by
 * `key` and the place is fetched here the same way. */
import { buildPlate, terrainWall, resolveSampler, resolveTerrain } from './plate.mjs';
import { lastLandmarks } from './zones.mjs';

const io = { base: new URL('../assets/terrain/', import.meta.url).href };
let lmCache = { key: '', lm: null };
const fingerprint = (P) => { let h = P.length; for (let i = 0; i < P.length; i += Math.max(1, P.length >> 6)) h = (h * 31 + Math.round(P[i] * 100)) | 0; return P.length + ':' + h; };

self.onmessage = async (e) => {
  const { id, last, coverage, opts, terrainer } = e.data;
  try {
    const o = { ...(opts || {}) };
    if (o.terrain && o.terrain.key) o.terrain = await resolveTerrain(o.terrain, io);
    let plate = { ...o, landmarks: lmCache.lm || (last ? lastLandmarks(last) : null) };
    if (terrainer) {
      const key = fingerprint(last.positions);
      if (lmCache.key !== key) lmCache = { key, lm: lastLandmarks(last) };
      const t = { ...terrainer, ground: { ...(terrainer.ground || {}) }, terrain: { ...(terrainer.terrain || {}) } };
      t.ground.sample = await resolveSampler(t.ground.sample, io);
      t.terrain.sample = await resolveSampler(t.terrain.sample, io);
      const tw = terrainWall(last, coverage, lmCache.lm, t);
      if (!tw.ok) { self.postMessage({ id, ok: false, reason: tw.reason, message: tw.message }); return; }
      // the app's per-vertex wall over its dial (a cage lift, a colour) rides the terrain's thickness
      let wall = tw.thickness;
      if (terrainer.extraWall) { wall = Float32Array.from(tw.thickness); const ex = terrainer.extraWall; for (let i = 0; i < wall.length; i++) wall[i] += Math.max(0, ex[i] || 0); }
      const detail = t.ground && t.ground.detail != null ? t.ground.detail : (t.detail != null ? t.detail : (o.terrainDetail != null ? o.terrainDetail : 0));
      plate = { ...o, wall, directions: tw.directions, guard: false, rim: 0, minWall: t.minWall == null ? 0.4 : t.minWall, terrainWall: tw, terrainDetail: detail, landmarks: lmCache.lm };
      plate.terrainBand = tw.band; plate.terrainStats = { ...tw.stats, floor: tw.floor };
    }
    const r = buildPlate(last, coverage, plate);
    if (!r.ok) { self.postMessage({ id, ok: false, reason: r.reason, message: r.message, stats: r.stats || null }); return; }
    const out = {
      id, ok: true,
      cage: { positions: r.cage.positions, quads: r.cage.quads, srcOf: r.cage.srcOf, rims: r.cage.rims.map((L) => Array.from(L)), sheetCount: r.cage.sheetCount, sheetFaces: r.cage.sheetFaces },
      limit: { positions: r.limit.positions, quads: r.limit.quads, indices: r.limit.indices, normals: r.limit.normals, sheet: r.limit.sheet, perforated: !!r.limit.perforated, bore: r.limit.bore || null, from: r.limit.from || null, holes: r.limit.holes || null, roof: r.limit.roof || null, treadCurves: r.limit.treadCurves || null },
      wall: r.wall, gap: r.gap, coverage: r.coverage, directions: r.directions, pattern: r.pattern, texture: r.texture, skive: r.skive, puff: r.puff,
      terrain: plate.terrainBand ? { band: plate.terrainBand, ...plate.terrainStats } : null,
      stats: { ...r.stats, invertedAt: undefined },
    };
    // a punched plate has no quads (perforate.mjs) and may have no sheet: only what is there is transferred
    const transfer = [out.cage.positions, out.cage.quads, out.cage.srcOf, out.limit.positions, out.limit.quads, out.limit.indices, out.limit.normals, out.limit.sheet, out.limit.from, out.limit.roof, out.wall, out.gap].filter(Boolean).map((a) => a.buffer);
    for (const f of [out.pattern, out.texture, out.skive, out.puff && out.puff.wall]) if (f) transfer.push(f.buffer);
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, reason: 'error', message: String(err && err.message || err) });
  }
};
