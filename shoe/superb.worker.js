/* pieceToSuperB off the main thread: QuadriFlow's wasm blocks 0.8 s on the
 * footie and 0.9 s on the sole, and the closure another second. No window
 * here, so MASQ's engine calls the wasm directly. One message in, one out,
 * plain data both ways (packPiece / packResult); the client drops a result
 * whose id is not the latest asked. */
import { pieceToSuperB, packResult } from './superb.mjs';

self.onmessage = async (e) => {
  const { id, piece, substrate, opts } = e.data;
  try {
    const r = packResult(await pieceToSuperB(piece, substrate, opts || {}));
    const transfer = r.ok ? [r.V.buffer, r.F.buffer, r.limit.positions.buffer, r.limit.normals.buffer, r.limit.indices.buffer] : [];
    self.postMessage({ id, ...r }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, reason: 'error', detail: String(err && err.message || err) });
  }
};
