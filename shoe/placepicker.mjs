// The place picker: a search field, a 2D hillshade of the fetched ground
// with the frame the sole's crop takes drawn on it and draggable, Width km,
// Bearing, Cut at (m) with Keep only the land, and a two-line readout.
// Built on shoe/places.mjs; styled with the app's own classes (label, .row,
// .sfRow, .val, presetbtn, ptog) so it drops into a sidebar drawer as-is.
//
// The view is a square raster viewKm = VIEW_X × the frame's width around
// the place, so the frame pans and turns on it without another fetch;
// a width that no longer fits (its diagonal past the view) refetches
// around the frame. Every change that moves the frame or the cut delivers
// a new patch: patchFromRaster on the frame, cutAt when the cut is on,
// placeFromPatch under custom:<lat>,<lon>,<wKm>, then onPatch(patch,
// record). Nominatim is asked on Enter or the Search press only.
//
//   createPlacePicker(container, { onPlace, onPatch, fetch, shoeSpanMM = 300,
//     widthKm = 12, maxRaster = 1024 })
//   → { el, search(q), goTo({ lat, lon, name, wKm }), setShoeSpanMM(mm),
//       setWidthKm(km), setBearing(deg), setCut(m, on), getState(), destroy() }

import {
  searchPlaces, fetchPatch, patchFromRaster, cutAt, trueScale, hillshade, placeFromPatch, patchKey,
  clamp, round1, mPerDegLat, mPerDegLon, KM_MIN, KM_MAX, GRID, SEA_M,
} from './places.mjs';

const VIEW_X = 2;            // the view's width in frame widths
const KM_UI_MAX = 100;       // the Width slider's top; the field takes LoAm's 400
const CSS = `
.pp label{margin-top:8px}
.pp .pp-search input{flex:1 1 auto;min-width:0;background:var(--panel2);color:var(--cream);border:1px solid var(--line);border-radius:4px;padding:5px 6px;font-size:12px}
.pp .pp-search .presetbtn{flex:0 0 auto;padding:6px 10px}
.pp .pp-results{display:flex;flex-direction:column;gap:3px;margin-top:4px}
.pp .pp-results:empty{display:none}
.pp .pp-results .presetbtn{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:5px 8px}
.pp .pp-results .presetbtn small{color:var(--dim);margin-left:6px}
.pp .pp-msg{font-size:10.5px;color:var(--dim);padding:4px 2px}
.pp .pp-map{display:block;width:100%;aspect-ratio:1;margin-top:8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);touch-action:none;cursor:grab}
.pp .pp-map.drag{cursor:grabbing}
.pp .pp-cut{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.pp .pp-cut .sfRow{width:100%}
.pp .pp-read+.pp-read{margin-bottom:10px}
.pp .pp-read{margin-top:4px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp .pp-read.dim{color:var(--dim)}
`;
let cssIn = false;
function ensureCss() {
  if (cssIn || typeof document === 'undefined') return;
  cssIn = true;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
}
const el = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function createPlacePicker(container, opts = {}) {
  ensureCss();
  const onPlace = opts.onPlace || (() => {}), onPatch = opts.onPatch || (() => {});
  const fetchOpt = opts.fetch || null, maxRaster = opts.maxRaster || 1024;
  const st = {
    shoeSpanMM: opts.shoeSpanMM || 300, place: null,
    view: null,                                     // { lat, lon, km, raster, shade: ImageData, grid, minM, maxM }
    frame: { lat: 0, lon: 0, wKm: opts.widthKm || 12, bearingDeg: 0 },
    cutOn: false, cutM: 0, patch: null, record: null, busy: null, fetching: null,
  };

  // ── DOM ──
  const root = el('div', 'pp');
  const lab = (t) => { const l = el('label'); l.textContent = t; return l; };
  const searchRow = el('div', 'row pp-search');
  const q = el('input', '', { type: 'text', placeholder: 'A place', title: 'Type a place, press Enter', autocomplete: 'off', spellcheck: 'false' });
  const go = el('button', 'presetbtn', { type: 'button', title: 'Ask OpenStreetMap for the place' }); go.textContent = 'Search';
  searchRow.append(q, go);
  const results = el('div', 'pp-results');
  const map = el('canvas', 'pp-map', { width: GRID, height: GRID, title: 'Drag the frame to move the crop' });
  const sf = (min, max, step, val, unit, title) => {
    const row = el('div', 'sfRow', { title });
    const r = el('input', '', { type: 'range', min, max, step, value: val }), n = el('input', '', { type: 'number', min, max, step, value: val });
    row.append(r, n);
    if (unit) { const u = el('span', 'val'); u.textContent = unit; u.style.flex = 'none'; row.append(u); }
    return { row, r, n };
  };
  const width = sf(1, KM_UI_MAX, 0.5, st.frame.wKm, 'km', 'How much ground the sole takes across');
  width.n.min = KM_MIN; width.n.max = KM_MAX;
  const bearing = sf(0, 359, 1, 0, '°', 'The compass direction up the crop');
  const cutWrap = el('div', 'pp-cut');
  const cut = sf(0, 9000, 10, 0, 'm', 'The contour the cut follows');
  const keep = el('button', 'ptog', { type: 'button', title: 'Flatten everything below the contour' }); keep.textContent = 'Keep only the land';
  cutWrap.append(cut.row, keep);
  const line1 = el('div', 'val pp-read dim'), line2 = el('div', 'val pp-read dim');
  line1.textContent = 'Search a place, or pick one.'; line2.textContent = '';
  root.append(lab('Place'), searchRow, results, map, lab('Width'), width.row, lab('Bearing'), bearing.row, lab('Cut at'), cutWrap, line1, line2);
  container.appendChild(root);
  const ctx = map.getContext('2d');

  // ── search ──
  let searching = false;
  async function search(text) {
    const s = String(text == null ? q.value : text).trim();
    if (!s || searching) return [];
    searching = true; go.disabled = true;
    results.replaceChildren(msg('Searching…'));
    let found = [];
    try {
      found = await searchPlaces(s, { limit: 8, fetch: fetchOpt || undefined });
      results.replaceChildren();
      if (!found.length) results.append(msg('Nothing found.'));
      for (const it of found) {
        const b = el('button', 'presetbtn', { type: 'button', title: it.displayName.slice(0, 80) });
        b.textContent = it.name;
        if (it.kind) { const k = el('small'); k.textContent = it.kind; b.append(k); }
        b.addEventListener('click', () => { results.replaceChildren(); goTo(it); });
        results.append(b);
      }
    } catch (e) { results.replaceChildren(msg(e && e.soft ? 'Search is unreachable right now.' : 'Search is unreachable right now.')); }
    searching = false; go.disabled = false;
    return found;
  }
  function msg(t) { const m = el('div', 'pp-msg'); m.textContent = t; return m; }
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  go.addEventListener('click', () => search());

  // ── the view and the frame ──
  function goTo(it) {
    st.place = { name: it.name || it.displayName || `${(+it.lat).toFixed(3)}, ${(+it.lon).toFixed(3)}`, lat: +it.lat, lon: +it.lon };
    // a result's own frame (LoAm's goTo: its box × 1.10) when it is a place with extent; a peak's box is metres wide and keeps the width
    const own = Math.max(it.wKm || 0, it.hKm || 0);
    if (own >= 2) setWidthKm(clamp(own, KM_MIN, KM_MAX), false);
    st.frame.lat = st.place.lat; st.frame.lon = st.place.lon;
    onPlace(st.place);
    return fetchView(st.place.lat, st.place.lon);
  }
  let fetchId = 0;
  async function fetchView(lat, lon) {
    const id = ++fetchId;
    const km = clamp(st.frame.wKm * VIEW_X, KM_MIN, KM_MAX);
    say(line1, st.place ? st.place.name : `${lat.toFixed(3)}, ${lon.toFixed(3)}`, true); say(line2, 'Sampling terrain…', true);
    map.style.opacity = '0.5';
    try {
      const p = await fetchPatch({ lat, lon, wKm: km, hKm: km }, { maxRaster, fetch: fetchOpt || undefined, onProgress: ({ done, total }) => { if (id === fetchId) say(line2, `Sampling terrain… ${done}/${total}`, true); } });
      if (id !== fetchId) return null;
      st.view = { lat, lon, km, raster: p.raster, grid: p.grid, minM: p.minM, maxM: p.maxM, tiles: p.tiles, failed: p.failed, shade: null };
      // the frame stays where it was if it still fits the new view, else it recentres
      if (!frameFits()) { st.frame.lat = lat; st.frame.lon = lon; }
      map.style.opacity = '';
      deliver();
      return p;
    } catch (e) {
      if (id !== fetchId) return null;
      map.style.opacity = '';
      say(line2, 'The terrain is unreachable right now.', true);
      return null;
    }
  }
  // the frame's centre in view px (256 across the view), and back
  const frameCentrePx = () => {
    const v = st.view, kmPx = GRID / v.km;
    const E = (st.frame.lon - v.lon) * mPerDegLon(v.lat) / 1000, N = (st.frame.lat - v.lat) * mPerDegLat / 1000;
    return [GRID / 2 + E * kmPx, GRID / 2 - N * kmPx];
  };
  const setFrameCentrePx = (x, y) => {
    const v = st.view, kmPx = GRID / v.km;
    const half = st.frame.wKm * kmPx / 2 * (Math.abs(Math.sin(st.frame.bearingDeg * Math.PI / 180)) + Math.abs(Math.cos(st.frame.bearingDeg * Math.PI / 180)));
    x = clamp(x, half, GRID - half); y = clamp(y, half, GRID - half);
    st.frame.lon = v.lon + (x - GRID / 2) / kmPx * 1000 / mPerDegLon(v.lat);
    st.frame.lat = v.lat - (y - GRID / 2) / kmPx * 1000 / mPerDegLat;
  };
  const frameFits = () => st.view && st.frame.wKm * Math.SQRT2 <= st.view.km * 1.001;

  function draw() {
    ctx.clearRect(0, 0, GRID, GRID);
    const v = st.view;
    if (!v) { ctx.fillStyle = '#8a8380'; ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText('No ground yet', GRID / 2, GRID / 2); return; }
    if (!v.shade) {
      const per = (v.maxM - v.minM) / 65535 || 1;
      const cutQ = st.cutOn ? Math.round(clamp((st.cutLevel() - v.minM) / per, -1, 65535)) : -1;
      v.shade = new ImageData(hillshade(v.grid, GRID, GRID, { cellM: v.km * 1000 / GRID, spanM: v.maxM - v.minM, cutQ }), GRID, GRID);
    }
    ctx.putImageData(v.shade, 0, 0);
    // the frame: the sole's crop, turned by the bearing, north mark at its top
    const [cx, cy] = frameCentrePx(), s = st.frame.wKm * GRID / v.km;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(st.frame.bearingDeg * Math.PI / 180);   // bearing 90 turns the frame's up to the east, clockwise on the canvas
    ctx.fillStyle = 'rgba(28,26,20,0.13)';
    ctx.beginPath(); ctx.rect(-GRID, -GRID, 2 * GRID, 2 * GRID); ctx.rect(-s / 2, -s / 2, s, s); ctx.fill('evenodd');
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(28,26,20,0.7)'; ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.lineWidth = 2; ctx.strokeStyle = '#fbec1a'; ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.beginPath(); ctx.moveTo(0, -s / 2); ctx.lineTo(0, -s / 2 - 6); ctx.stroke();
    ctx.restore();
  }
  st.cutLevel = () => (st.view ? clamp(st.cutM, SEA_M, Math.max(SEA_M, st.view.maxM - 1)) : st.cutM);

  // ── the drag ──
  let drag = null;
  const toMap = (e) => { const r = map.getBoundingClientRect(); return [(e.clientX - r.left) * GRID / r.width, (e.clientY - r.top) * GRID / r.height]; };
  map.addEventListener('pointerdown', (e) => {
    if (!st.view || e.button !== 0) return;
    const [x, y] = toMap(e), [cx, cy] = frameCentrePx();
    drag = { dx: cx - x, dy: cy - y, moved: false };
    map.setPointerCapture(e.pointerId); map.classList.add('drag'); e.preventDefault();
  });
  map.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = toMap(e);
    setFrameCentrePx(x + drag.dx, y + drag.dy); drag.moved = true; draw();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const moved = drag.moved; drag = null; map.classList.remove('drag');
    try { map.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) deliver();
  };
  map.addEventListener('pointerup', endDrag); map.addEventListener('pointercancel', endDrag);

  // ── controls ──
  const pair = ({ r, n }, apply, onCommit) => {
    r.addEventListener('input', () => { n.value = r.value; apply(+r.value, false); });
    r.addEventListener('change', () => { apply(+r.value, true); if (onCommit) onCommit(); });
    n.addEventListener('change', () => { const v = clamp(+n.value || 0, +n.min, +n.max); n.value = v; r.value = clamp(v, +r.min, +r.max); apply(v, true); if (onCommit) onCommit(); });
  };
  function setWidthKm(km, commit = true) {
    km = clamp(round1(+km || KM_MIN), KM_MIN, KM_MAX);
    st.frame.wKm = km; width.r.value = clamp(km, +width.r.min, +width.r.max); width.n.value = km;
    if (!commit) return;
    if (st.view && !frameFits()) fetchView(st.frame.lat, st.frame.lon);
    else if (st.view) { const [x, y] = frameCentrePx(); setFrameCentrePx(x, y); deliver(); }
  }
  function setBearing(deg, commit = true) {
    deg = ((Math.round(+deg || 0) % 360) + 360) % 360;
    st.frame.bearingDeg = deg; bearing.r.value = deg; bearing.n.value = deg;
    if (st.view) { const [x, y] = frameCentrePx(); setFrameCentrePx(x, y); if (commit) deliver(); else draw(); }
  }
  function setCut(m, on = st.cutOn, commit = true) {
    st.cutM = Math.max(0, +m || 0); st.cutOn = !!on;
    cut.r.value = st.cutM; cut.n.value = st.cutM; keep.classList.toggle('on', st.cutOn);
    if (st.view) { st.view.shade = null; if (commit) deliver(); else draw(); }
  }
  pair(width, (v, commit) => { if (commit) setWidthKm(v); else { st.frame.wKm = clamp(v, KM_MIN, KM_MAX); if (st.view) draw(); } });
  pair(bearing, (v, commit) => setBearing(v, commit));
  pair(cut, (v, commit) => setCut(v, st.cutOn, commit));
  keep.addEventListener('click', () => setCut(st.cutM, !st.cutOn));

  // ── deliver ──
  function deliver() {
    const v = st.view; if (!v) return;
    const f = st.frame;
    let patch = patchFromRaster(v.raster, { lat: f.lat, lon: f.lon, wKm: f.wKm, hKm: f.wKm, bearingDeg: f.bearingDeg });
    let cutInfo = null;
    if (st.cutOn) {
      cutInfo = cutAt(patch.grid, patch.minM, patch.maxM, st.cutM);
      patch = { ...patch, grid: cutInfo.grid, cut: { cutM: cutInfo.cutM, landFrac: cutInfo.landFrac, flattened: cutInfo.flattened }, reliefM: patch.maxM - Math.min(patch.maxM, cutInfo.cutM) };
      st.cutM = cutInfo.cutM; cut.r.value = st.cutM; cut.n.value = st.cutM;
    }
    // the slider's top is this ground's highest point once there is ground
    cut.r.max = Math.max(10, Math.ceil(patch.maxM / 10) * 10);
    st.patch = patch;
    st.record = placeFromPatch(patch, patchKey(patch), { label: st.place ? st.place.name : patchKey(patch) });
    draw();
    readout();
    onPatch(patch, st.record);
  }
  function readout() {
    const p = st.patch, f = st.frame;
    if (!p) return;
    const name = st.place ? st.place.name : `${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}`;
    say(line1, `${name} · ${fmt(f.wKm, f.wKm < 10 ? 1 : 0)} km across · ${fmt(p.reliefM)} m relief`);
    const sc = trueScale(f.wKm, st.shoeSpanMM);
    say(line2, `${sc.text} at ${fmt(st.shoeSpanMM)} mm` + (p.cut ? ` · cut at ${fmt(p.cut.cutM)} m · ${fmt(p.cut.landFrac * 100)}% land` : ` · ${fmt(p.metresPerSample)} m/sample`) + (p.failed ? ` · ${p.failed} tiles missing` : ''));
  }
  function say(node, text, dim = false) { node.textContent = text; node.classList.toggle('dim', dim); }

  draw();
  return {
    el: root, search, goTo, setWidthKm, setBearing, setCut,
    setShoeSpanMM(mm) { st.shoeSpanMM = Math.max(1, +mm || 1); readout(); },
    refetch() { return st.view ? fetchView(st.frame.lat, st.frame.lon) : Promise.resolve(null); },
    getState() { return { place: st.place, frame: { ...st.frame }, cutOn: st.cutOn, cutM: st.cutM, view: st.view ? { lat: st.view.lat, lon: st.view.lon, km: st.view.km, tiles: st.view.tiles, minM: st.view.minM, maxM: st.view.maxM } : null, patch: st.patch, record: st.record, shoeSpanMM: st.shoeSpanMM, readout: [line1.textContent, line2.textContent] }; },
    destroy() { fetchId++; root.remove(); },
  };
}
