// The estimate off the main thread: ~10 s a shoe. One in flight; a stale
// result is dropped by id where it lands (the app keeps the last id).
import { estimate, loadPrintProfile } from './print.mjs';
let tablesP = null;
self.onmessage = async (e) => {
  const { id, pieces, opts } = e.data;
  try {
    if (!tablesP) tablesP = loadPrintProfile();
    const tables = await tablesP;
    const est = estimate(pieces.map((p) => ({ name: p.name, positions: p.positions, indices: p.indices })), { ...opts, tables });
    // the placement's positions are large; the app has its own
    for (const p of est.placement.pieces) { delete p.positions; delete p.indices; }
    self.postMessage({ id, ok: true, est });
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
