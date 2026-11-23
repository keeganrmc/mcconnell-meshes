import createQuadriFlow from './quadriflow.js';

let modulePromise = null;

export async function getQuadriFlowModule() {
  if (modulePromise) return modulePromise;
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    if (typeof globalThis.require === 'undefined') {
      const { createRequire } = await import('node:module');
      globalThis.require = createRequire(import.meta.url);
    }
    if (typeof globalThis.__dirname === 'undefined') {
      const { fileURLToPath } = await import('node:url');
      const { dirname } = await import('node:path');
      globalThis.__dirname = dirname(fileURLToPath(import.meta.url));
    }
  }
  modulePromise = createQuadriFlow({
    locateFile: (p) => new URL(p, import.meta.url).href,
    print: () => {},
    printErr: () => {}
  });
  return modulePromise;
}

/**
 * Runs QuadriFlow remeshing.
 * positions: Array of [x, y, z] or flat Float32/Float64 array
 * faces: Array of [v0, v1, v2] or [v0, v1, v2, v3]
 */
/* One call at a time, and a dead instance is dropped. The module keeps its
 * result in globals (_qf_out_*), so two calls in flight read each other's;
 * and a wasm abort (a trap inside the solver on a bad piece) leaves the
 * instance unusable — every later call threw until the page was reloaded.
 * After a trap the cached promise is cleared and the next call instantiates
 * afresh. */
let queue = Promise.resolve();
export function remeshToQuads(positions, faces, opts = {}) {
  const run = queue.then(() => (onPage() ? remeshInWorker(positions, faces, opts) : remeshToQuadsNow(positions, faces, opts)));
  queue = run.catch(() => {});
  return run;
}
/* On the page the solver runs in a worker (quadriflow.worker.js): it blocks
 * 1.3–1.6 s on a full face and 7.9 s on a ring mask remeshed whole, and on
 * the main thread every click waited that long. In node and inside the
 * worker itself it runs here. The same faces and seed give the same cage
 * either way; a worker that dies (a trap the engine did not catch) is
 * replaced on the next call and the error goes to the caller as before. */
const onPage = () => typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof document !== 'undefined';
let worker = null, nextId = 1;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./quadriflow.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id); if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data);
    else { const err = new Error(e.data.message); err.name = e.data.name || 'Error'; p.reject(err); }
  };
  worker.onerror = (e) => {
    const err = new Error('QuadriFlow worker: ' + (e.message || 'died'));
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    try { worker.terminate(); } catch (_) {}
    worker = null;
  };
  return worker;
}
async function remeshInWorker(positions, faces, opts) {
  let posF64;
  if (Array.isArray(positions) && positions.length > 0 && Array.isArray(positions[0])) {
    posF64 = new Float64Array(positions.length * 3);
    for (let i = 0; i < positions.length; i++) { posF64[i * 3] = positions[i][0]; posF64[i * 3 + 1] = positions[i][1]; posF64[i * 3 + 2] = positions[i][2]; }
  } else posF64 = new Float64Array(positions);
  const F = faces.map((f) => Array.from(f));
  const id = nextId++;
  const w = getWorker();
  const r = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, positions: posF64, faces: F, opts }, [posF64.buffer]); });
  const vertices = new Array(r.V.length / 3), out = new Array(r.F.length / 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = [r.V[i * 3], r.V[i * 3 + 1], r.V[i * 3 + 2]];
  for (let i = 0; i < out.length; i++) out[i] = [r.F[i * 4], r.F[i * 4 + 1], r.F[i * 4 + 2], r.F[i * 4 + 3]];
  return { vertices, faces: out, quadCount: out.length, vertexCount: vertices.length };
}
/* ⚠ AN exit() IS A DEAD INSTANCE TOO. QuadriFlow calls exit(0) on some
 * inputs; emscripten throws an ExitStatus ("Program terminated with
 * exit(0)"), which is not a RuntimeError, and every later call on that
 * instance throws the same line — opening a .masq with SuperB on remeshed
 * one piece into an exit and the SuperB never built again until a reload. */
const isTrap = (e) => (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) || (e && e.name === 'ExitStatus')
  || /abort|unreachable|out of bounds|memory access|Aborted|terminated with exit/i.test(String(e && e.message));
async function remeshToQuadsNow(positions, faces, opts = {}) {
  const M = await getQuadriFlowModule();

  // 1. Pack positions as Float64Array
  let posF64;
  if (Array.isArray(positions) && positions.length > 0 && Array.isArray(positions[0])) {
    posF64 = new Float64Array(positions.length * 3);
    for (let i = 0; i < positions.length; i++) {
      posF64[i * 3] = positions[i][0];
      posF64[i * 3 + 1] = positions[i][1];
      posF64[i * 3 + 2] = positions[i][2];
    }
  } else {
    posF64 = new Float64Array(positions);
  }
  const nv = (posF64.length / 3) | 0;

  // 2. Convert faces to triangles Int32Array
  const trisList = [];
  for (const f of faces) {
    if (f.length === 3) {
      trisList.push(f[0], f[1], f[2]);
    } else if (f.length === 4) {
      trisList.push(f[0], f[1], f[2]);
      trisList.push(f[0], f[2], f[3]);
    }
  }
  const tris = new Int32Array(trisList);
  const nf = (tris.length / 3) | 0;

  const target = opts.targetQuads || 150;
  const preserveSharp = opts.preserveSharp ? 1 : 0;
  const preserveBoundary = opts.preserveBoundary !== false ? 1 : 0;
  const adaptiveScale = opts.adaptiveScale ? 1 : 0;
  const minimumCostFlow = opts.minimumCostFlow ? 1 : 0;
  const aggressiveSat = opts.aggressiveSat ? 1 : 0;
  const seed = (opts.seed | 0) || 0;

  let pPtr = M._malloc(nv * 3 * 8);
  let tPtr = M._malloc(nf * 3 * 4);
  if (!pPtr || !tPtr) {
    if (pPtr) M._free(pPtr);
    if (tPtr) M._free(tPtr);
    throw new Error('QuadriFlow malloc failed: out of memory');
  }

  try {
    M.HEAPF64.set(posF64, pPtr >> 3);
    M.HEAP32.set(tris, tPtr >> 2);

    const rc = M._qf_remesh(
      pPtr, nv, tPtr, nf, target,
      preserveSharp, preserveBoundary, adaptiveScale,
      minimumCostFlow, aggressiveSat, seed
    );

    M._free(pPtr); pPtr = 0;
    M._free(tPtr); tPtr = 0;

    if (rc !== 0) {
      M._qf_reset();
      throw new Error(`QuadriFlow remesher returned error code ${rc}`);
    }

    const onv = M._qf_out_nv();
    const onf = M._qf_out_nf();
    const vp = M._qf_out_verts() >> 3;
    const fp = M._qf_out_quads() >> 2;

    const outPos = new Float64Array(M.HEAPF64.subarray(vp, vp + onv * 3));
    const outQuads = new Int32Array(M.HEAP32.subarray(fp, fp + onf * 4));
    M._qf_reset();

    const vertices = [];
    for (let i = 0; i < onv; i++) {
      vertices.push([outPos[i * 3], outPos[i * 3 + 1], outPos[i * 3 + 2]]);
    }

    const outFaces = [];
    for (let i = 0; i < onf; i++) {
      outFaces.push([
        outQuads[i * 4],
        outQuads[i * 4 + 1],
        outQuads[i * 4 + 2],
        outQuads[i * 4 + 3]
      ]);
    }

    return {
      vertices,
      faces: outFaces,
      quadCount: onf,
      vertexCount: onv
    };
  } catch (e) {
    if (isTrap(e)) { modulePromise = null; }
    else { if (pPtr) { try { M._free(pPtr); } catch (_) {} } if (tPtr) { try { M._free(tPtr); } catch (_) {} } }
    throw e;
  }
}
