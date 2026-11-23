// The .3mf the Print section hands to a slicer, and a reader for .3mf
// meshes.
//
// Package (3MF Core Specification; OPC, ECMA-376 Part 2): [Content_Types].xml,
// _rels/.rels pointing at 3D/3dmodel.model by the 3MF "3dmodel" relationship,
// and the model: millimetres, one <object type="model"> per part, one build
// item per object. The mesh is written in the print frame, dropped onto z = 0
// and centred on the printer's plate; the translation is baked into the
// vertices, written to four decimals.
//
// Slicer settings are named, not embedded. Two optional carriers, both in the
// slicer project layout under Metadata/:
//   model_settings.config    per-object <metadata key value> overrides: the
//                            layer height, support on/off and its type, and
//                            per object (several parts) the wall count and
//                            sparse infill density;
//   project_settings.config  the printer, process and filament preset names,
//                            the layer height, support on/off and type, and
//                            the list of keys that differ from the named
//                            presets. Nothing else: no G-code, no machine
//                            limits, no speeds.
// `Application` is the app that wrote the file.
import { makeZip } from '../exporters.js';

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f4 = (v) => { const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };

/** The keys project_settings.config may carry. */
export const PROJECT_KEYS = Object.freeze(['printer_settings_id', 'print_settings_id', 'filament_settings_id', 'layer_height', 'enable_support', 'support_type', 'different_settings_to_system']);

const SUPPORT_TYPE = { tree: 'tree(auto)', normal: 'normal(auto)' };

function objectSettings(support, layerMM, extra = {}) {
  const kv = [];
  if (layerMM > 0) kv.push(['layer_height', String(layerMM)]);
  if (support) {
    kv.push(['enable_support', support === 'none' ? '0' : '1']);
    if (support !== 'none') kv.push(['support_type', SUPPORT_TYPE[support]]);
  }
  if (extra.wallLoops != null) kv.push(['wall_loops', String(extra.wallLoops)]);
  if (extra.infillDensity != null) kv.push(['sparse_infill_density', Math.round(extra.infillDensity * 100) + '%']);
  return kv;
}

/** The minimal project settings: preset names, the chosen settings, and which keys differ from the presets. */
export function projectSettings({ preset = {}, layerMM, support = 'tree' } = {}) {
  const out = {};
  if (preset.printer) out.printer_settings_id = preset.printer;
  if (preset.process) out.print_settings_id = preset.process;
  if (preset.filament) out.filament_settings_id = [preset.filament];
  if (layerMM > 0) out.layer_height = String(layerMM);
  out.enable_support = support === 'none' ? '0' : '1';
  if (support !== 'none') out.support_type = SUPPORT_TYPE[support] || SUPPORT_TYPE.tree;
  const changed = ['enable_support', 'layer_height', 'support_type'].filter((k) => k in out);
  out.different_settings_to_system = [changed.join(';'), '', ''];
  return out;
}

/**
 * @param {{positions: Float32Array, indices: Uint32Array}|null} meshMM  one part (or pass opts.objects)
 * @param {object} opts
 * @param {string} [opts.name]            the object's name
 * @param {number[]} [opts.plateMM]       [W, D]; the parts are centred on it
 * @param {number} [opts.layerMM]
 * @param {'tree'|'normal'|'none'} [opts.support]
 * @param {{printer?: string, process?: string, filament?: string}} [opts.preset]  slicer preset names
 * @param {string} [opts.application]     the Application metadata
 * @param {boolean} [opts.objectSettings]  write Metadata/model_settings.config (default true)
 * @param {boolean} [opts.projectSettings] write Metadata/project_settings.config (default true when a preset is named)
 * @param {boolean} [opts.plain]           geometry only (an SLA printer): no settings files
 * @param {Array<{name: string, positions: Float32Array, indices: Uint32Array, wallLoops?: number, infillDensity?: number}>} [opts.objects]
 * @param {object} [opts.extraModelAttrs]  extra namespace attributes and metadata on <model> (diagnostic variants)
 * @returns {{zip: Uint8Array, files: string[], centre: number[], objects: number}}
 */
export function make3MF(meshMM, opts = {}) {
  const parts = opts.objects && opts.objects.length ? opts.objects : [{ name: opts.name || 'part', positions: meshMM.positions, indices: meshMM.indices }];
  const [W, D] = opts.plateMM || [256, 256];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) {
    const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z;
  }
  const tx = W / 2 - (x0 + x1) / 2, ty = D / 2 - (y0 + y1) / 2, tz = -z0;
  const app = opts.application || 'MASQ';
  const marks = opts.extraModelAttrs || {};
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  const ns = Object.entries(marks.namespaces || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  xml.push(`<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${ns}>`);
  const meta = [['Title', opts.name || parts[0].name], ['Designer', opts.designer || ''], ['CreationDate', opts.date || ''], ['Application', app], ...(marks.metadata || [])];
  for (const [k, v] of meta) xml.push(` <metadata name="${esc(k)}">${esc(v)}</metadata>`);
  xml.push(' <resources>');
  parts.forEach((p, n) => {
    xml.push(`  <object id="${n + 1}" name="${esc(p.name)}" type="model">`);
    xml.push('   <mesh>');
    xml.push('    <vertices>');
    const P = p.positions, lines = [];
    for (let i = 0; i < P.length; i += 3) lines.push(`     <vertex x="${f4(P[i] + tx)}" y="${f4(P[i + 1] + ty)}" z="${f4(P[i + 2] + tz)}"/>`);
    xml.push(lines.join('\n'));
    xml.push('    </vertices>');
    xml.push('    <triangles>');
    const I = p.indices, tl = [];
    for (let i = 0; i < I.length; i += 3) tl.push(`     <triangle v1="${I[i]}" v2="${I[i + 1]}" v3="${I[i + 2]}"/>`);
    xml.push(tl.join('\n'));
    xml.push('    </triangles>');
    xml.push('   </mesh>');
    xml.push('  </object>');
  });
  xml.push(' </resources>');
  xml.push(' <build>');
  parts.forEach((p, n) => xml.push(`  <item objectid="${n + 1}"/>`));
  xml.push(' </build>');
  xml.push('</model>');

  const files = [];
  const entries = [];
  const add = (name, data) => { entries.push({ name, data: typeof data === 'string' ? enc.encode(data) : data }); files.push(name); };
  const writeObject = !opts.plain && opts.objectSettings !== false;
  const writeProject = !opts.plain && (opts.projectSettings ?? !!(opts.preset && (opts.preset.printer || opts.preset.process)));
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    + ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    + ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    + (writeObject || writeProject ? ' <Default Extension="config" ContentType="text/xml"/>\n' : '')
    + '</Types>\n');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    + ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n');
  add('3D/3dmodel.model', xml.join('\n') + '\n');
  if (writeObject) {
    const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
    parts.forEach((p, n) => {
      cfg.push(`  <object id="${n + 1}">`);
      cfg.push(`    <metadata key="name" value="${esc(p.name)}"/>`);
      cfg.push('    <metadata key="extruder" value="1"/>');
      for (const [k, v] of objectSettings(opts.support, opts.layerMM, p)) cfg.push(`    <metadata key="${k}" value="${esc(v)}"/>`);
      cfg.push(`    <part id="${n + 1}" subtype="normal_part">`);
      cfg.push(`      <metadata key="name" value="${esc(p.name)}"/>`);
      cfg.push('    </part>');
      cfg.push('  </object>');
    });
    cfg.push('</config>');
    add('Metadata/model_settings.config', cfg.join('\n') + '\n');
  }
  if (writeProject) add('Metadata/project_settings.config', JSON.stringify(projectSettings({ preset: opts.preset, layerMM: opts.layerMM, support: opts.support || 'tree' }), null, 2) + '\n');
  return { zip: makeZip(entries), files, centre: [tx, ty, tz], objects: parts.length };
}

/* ---------- reading ---------- */

async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('this runtime cannot inflate a zip entry');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The zip's entries by name: {name: () => Promise<Uint8Array>}. */
export function readZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip: no end-of-directory record');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let e = 0; e < n; e++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    const data = u8.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    out[name] = method === 0 ? async () => data : method === 8 ? () => inflateRaw(data) : async () => { throw new Error('zip method ' + method); };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ATTR = new Map();
const attr = (tag, name) => {
  let re = ATTR.get(name);
  if (!re) ATTR.set(name, re = new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
  const m = re.exec(tag);
  return m ? m[1] : null;
};
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** A 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors: p' = p·M). */
const parseT = (s) => { if (!s) return IDENT; const v = s.trim().split(/\s+/).map(Number); return v.length === 12 && v.every(Number.isFinite) ? v : IDENT; };
const mulT = (A, B) => {   // A then B
  const r = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = A[9] * B[j] + A[10] * B[3 + j] + A[11] * B[6 + j] + B[9 + j];
  return r;
};

/** Objects of one model part: id → {mesh?: {v: number[], t: number[]}, components?: [{path, objectid, T}]}. */
function parseModel(text) {
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(text))) {
    const id = attr(m[1], 'id'), body = m[2];
    const o = {};
    const mi = body.indexOf('<mesh');
    if (mi >= 0) {
      const v = [], t = [];
      const vr = /<vertex\b([^>]*)\/?>/g;
      let q;
      vr.lastIndex = mi;
      while ((q = vr.exec(body))) v.push(+attr(q[1], 'x'), +attr(q[1], 'y'), +attr(q[1], 'z'));
      const tr = /<triangle\b([^>]*)\/?>/g;
      tr.lastIndex = mi;
      while ((q = tr.exec(body))) t.push(+attr(q[1], 'v1'), +attr(q[1], 'v2'), +attr(q[1], 'v3'));
      o.mesh = { v, t };
    }
    const cr = /<component\b([^>]*)\/?>/g;
    let c;
    const comps = [];
    while ((c = cr.exec(body))) comps.push({ path: attr(c[1], 'p:path'), objectid: attr(c[1], 'objectid'), T: parseT(attr(c[1], 'transform')) });
    if (comps.length) o.components = comps;
    objects.set(id, o);
  }
  const items = [];
  const ir = /<item\b([^>]*)\/?>/g;
  const build = text.indexOf('<build');
  if (build >= 0) { ir.lastIndex = build; let it; while ((it = ir.exec(text))) items.push({ objectid: attr(it[1], 'objectid'), T: parseT(attr(it[1], 'transform')) }); }
  return { objects, items };
}

/**
 * Every build item's mesh, in the plate's frame (component and item
 * transforms applied), merged into one mesh.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{positions: Float32Array, indices: Uint32Array}>}
 */
export async function read3MFMesh(bytes) {
  const zip = readZip(bytes);
  const dec = new TextDecoder();
  const parts = new Map();
  const partOf = async (path) => {
    const key = (path || '/3D/3dmodel.model').replace(/^\//, '');
    if (!parts.has(key)) {
      const get = zip[key];
      if (!get) throw new Error('the 3mf has no ' + key);
      parts.set(key, parseModel(dec.decode(await get())));
    }
    return parts.get(key);
  };
  const root = await partOf(null);
  const pos = [], idx = [];
  const emit = async (part, id, T, depth) => {
    if (depth > 8) throw new Error('3mf components nest too deep');
    const o = part.objects.get(id);
    if (!o) throw new Error('3mf object ' + id + ' is missing');
    if (o.mesh) {
      const base = pos.length / 3, v = o.mesh.v;
      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        pos.push(x * T[0] + y * T[3] + z * T[6] + T[9], x * T[1] + y * T[4] + z * T[7] + T[10], x * T[2] + y * T[5] + z * T[8] + T[11]);
      }
      for (const t of o.mesh.t) idx.push(base + t);
    }
    if (o.components) for (const c of o.components) await emit(c.path ? await partOf(c.path) : part, c.objectid, mulT(c.T, T), depth + 1);
  };
  for (const it of root.items) await emit(root, it.objectid, it.T, 0);
  if (!root.items.length) for (const id of root.objects.keys()) await emit(root, id, IDENT, 0);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
