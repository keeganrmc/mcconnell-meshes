/* QuadriFlow off the main thread. The wasm solver blocks for 1.3–1.6 s on a
 * full face and 7.9 s on a ring mask remeshed whole; run on the page that
 * held every click for as long. The engine module runs here as it does in
 * node — no window, so remeshToQuads calls the wasm directly. */
import { remeshToQuads } from './quadriflow_engine.js';

self.onmessage = async (e) => {
  const { id, positions, faces, opts } = e.data;
  try {
    const r = await remeshToQuads(positions, faces, opts);
    const V = new Float64Array(r.vertices.length * 3);
    for (let i = 0; i < r.vertices.length; i++) { V[i * 3] = r.vertices[i][0]; V[i * 3 + 1] = r.vertices[i][1]; V[i * 3 + 2] = r.vertices[i][2]; }
    const F = new Int32Array(r.faces.length * 4);
    for (let i = 0; i < r.faces.length; i++) { F[i * 4] = r.faces[i][0]; F[i * 4 + 1] = r.faces[i][1]; F[i * 4 + 2] = r.faces[i][2]; F[i * 4 + 3] = r.faces[i][3]; }
    self.postMessage({ id, ok: true, V, F }, [V.buffer, F.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err && err.message || err), name: err && err.name });
  }
};
