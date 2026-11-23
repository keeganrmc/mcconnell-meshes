// The submission checks off the page: the join, the reading, the carry onto their last. A grown shoe's Check is tens
// of seconds of geometry (shoe/union.mjs, shoe/zcheck.mjs); in the page it froze the app for that long.
// In:  { id, shoeP, shoeI, lastP, lastI, tplP, tplI }  (Float64/Float32 + Uint32; APP frame; the template may be null)
// Out: { id, ok, joined, stats, self, sheets: { labels, P, I, collar, split, islands }, over: { area, list },
//        fit: { P, before, after, alignRms, self } | null }   or { id, ok: false, error }
import * as ZC from './zcheck.mjs';
import { unionSolid } from './union.mjs';

self.onmessage = (e) => {
  const { id, shoeP, shoeI, lastP, lastI, tplP, tplI } = e.data;
  try {
    let shoe = ZC.weld(shoeP, shoeI, 1e-4), joined = null;
    const st0 = ZC.meshStats(shoe.P, shoe.I);
    if (st0.shells > 1){
      let h = 0.75, u = null;
      for (let k = 0; k < 4; k++){ u = unionSolid([shoe], { h }); if ((84 + 50 * u.I.length / 3) / 1048576 <= 48) break; h *= 1.08; }
      shoe = { P: Float64Array.from(u.P), I: u.I }; joined = { pieces: st0.shells, h: u.stats.h, ms: u.stats.ms, triangles: u.I.length / 3 };
    }
    const stats = ZC.meshStats(shoe.P, shoe.I);
    const si = ZC.selfIntersections(shoe.P, shoe.I, { cap: 50 });
    const ourQ = ZC.lastQuery(lastP, lastI);
    const sh = ZC.sheets(shoe.P, shoe.I, ourQ);
    const skip = new Uint8Array(sh.labels.length); for (let t = 0; t < skip.length; t++) skip[t] = sh.labels[t] !== 2 ? 1 : 0;
    const over = ZC.overhang(sh.P, sh.I, { deg: 120, maxDeg: 45, skip, collect: true });
    let fit = null;
    if (tplP){
      const r = ZC.retarget({ shoeP: sh.P, shoeI: sh.I, ourLastP: lastP, ourLastI: lastI, theirLastP: tplP, theirLastI: tplI, inside: ZC.insideVertices(sh, sh.P.length / 3) });
      const self2 = ZC.selfIntersections(r.P, sh.I, { cap: 50 });
      fit = { P: r.P, before: r.before, after: r.after, alignRms: r.align.rms, self: { count: self2.count, capped: self2.capped } };
    }
    const msg = { id, ok: true, joined, stats, self: { count: si.count, capped: si.capped },
      sheets: { labels: sh.labels, P: sh.P, I: sh.I, collar: sh.collar, split: sh.split, islands: sh.islands.length },
      over: { area: over.area, list: Uint32Array.from(over.list) }, fit };
    const transfer = [msg.sheets.labels.buffer, msg.sheets.P.buffer, msg.sheets.I.buffer, msg.over.list.buffer];
    if (fit) transfer.push(fit.P.buffer);
    self.postMessage(msg, transfer);
  } catch (err){ self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
