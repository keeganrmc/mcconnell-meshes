/* buildLatticeMesh off the main thread: the field is sampled over the piece's
 * whole box and marched, seconds on a midsole. One message in, one out:
 * { id, positions, indices, sheet, volumeCm3, opts } → { id, ok, positions,
 * indices, stats } with the buffers transferred. */
import { buildLatticeMesh } from './lattice.mjs';

self.onmessage = (e) => {
  const { id, positions, indices, sheet, volumeCm3, opts, landmarks } = e.data;
  try {
    const r = buildLatticeMesh({ positions, indices, sheet, stats: { volumeCm3 }, landmarks: landmarks || opts?.landmarks }, opts || {});
    if (!r.ok) { self.postMessage({ id, ok: false, reason: r.reason || 'error' }); return; }
    self.postMessage({ id, ok: true, positions: r.positions, indices: r.indices, stats: r.stats }, [r.positions.buffer, r.indices.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, reason: String(err && err.message || err) });
  }
};
