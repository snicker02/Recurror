// Recurror — recursive mirror drawing with splines. App wiring, tools, UI.
import { initPanelTabs } from './engine/tabs.js';
import { floodRegion, traceRegion, keyhole } from './engine/bucket.js';
import { Renderer } from './engine/renderer.js';
import { drawOverlay, viewPoint } from './engine/overlay.js';
import {
  newDocument, makeStroke, touch, normaliseDoc, serialise, History,
  defaultStyle, defaultFill, defaultShape, defaultLayer, nextRev, newId, syncGroup,
} from './engine/document.js';
import { defaultSym, defaultRec, allTransformsCached, mobInverse, mobApply, mobScaleAt, hyperbolicValid, copyLimit } from './engine/symmetry.js';
import { defaultWarp, warpActive, warpInverse, warpPoint, WARPS, WARP_LABELS } from './engine/warp.js';
import { simplify, nearestOnPolyline, pointInPolygon } from './engine/spline.js';
import { getSamples, isClosed, boundCircle } from './engine/geometry.js';
import { guidesCached, snapTo } from './engine/guides.js';

export const VERSION = '2.8.0';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const glCanvas = $('#gl');
const ovCanvas = $('#overlay');
const stage = $('#stage');
const octx = ovCanvas.getContext('2d');

let renderer = null;
let panelTabs = null;         // phone tab layout (engine/tabs.js)
try { renderer = new Renderer(glCanvas); }
catch (err) {
  const box = $('#glError');
  box.hidden = false;
  box.textContent = 'Recurror needs WebGL: ' + err.message;
  console.error(err);
}

let doc = newDocument();
const history = new History();
const tpl = {
  shape: defaultShape(), style: defaultStyle(), fill: defaultFill(),
  sym: defaultSym(doc.width, doc.height), rec: defaultRec(), warp: defaultWarp(),
};
const ui = { bucketCol: '#000000', bucketTol: 40, bucketGap: 3, bucketSym: true, bucketUnder: true, tool: 'draw', tapPoints: true, joinEnds: true, showGuides: true, snap: false, smooth: 2.5, stabilize: 0.3, exportScale: 1, transparent: false };
const view = { zoom: 1, panX: 0, panY: 0, dpr: 1, cssW: 1, cssH: 1 };

let selection = [];          // selected strokes
let primary = null;          // the one the panel shows
let hover = null;
let handleHot = -1;
let widthHot = -1;
let preview = null;
let penPoints = [];
let penCloseHot = false;
let cursor = null;
let snapShow = null;
let marquee = null;
let drag = null;
let spaceDown = false;
let dirty = true;
const pointers = new Map();
let pinch = null;
// Touch double-tap (mobile browsers do not reliably fire dblclick when touch-action is none).
let tapDown = null, lastTap = null, synthDblAt = -1e9;

const TAP_SLOP = 4;          // px: a press that moves less than this…
const TAP_MS = 400;          // …and lifts within this is a tap

const TPL_ROOTS = new Set(['shape', 'style', 'fill', 'sym', 'rec', 'warp']);
const GROUP_ROOTS = new Set(['sym', 'rec', 'warp']);
const MESH_ROOTS = new Set(['shape', 'style']);

const HINTS = {
  draw: 'Draw: drag to sketch · tap to place connected points (Enter / double-tap / right-click finishes, tap the first point to close) · [ ] width · S snap',
  pen: 'Pen: click control points · Enter / double-click / right-click to finish · click the first point to close · Backspace removes last',
  edit: 'Edit: click to select (Shift adds) · drag empty space to box-select · drag handles · Alt-click deletes a point · double-click inserts · Ctrl+G groups',
  width: 'Width: drag outward from a control point to set its width · Alt-click resets it to 1',
  center: 'Centre: click or drag to place the symmetry centre (snaps to artboard landmarks when Snap is on)',
  pan: 'Pan: drag to move the view · wheel to zoom',
  bucket: 'Bucket: click a closed area to fill it (fills go under the lines) · click a fill again to recolour it · Gap closes small breaks in the lines (K)',
};
const TOUCH_HINTS = {
  draw: 'Draw: drag to sketch · tap to place points, double-tap to finish · pinch to zoom',
  pen: 'Pen: tap control points · double-tap to finish · tap the first point to close',
  edit: 'Edit: tap to select · drag empty space to box-select · drag handles · double-tap a stroke to insert a point',
  width: 'Width: drag outward from a control point to set its width',
  center: 'Centre: tap or drag to place the symmetry centre',
  pan: 'Pan: drag to move · pinch to zoom',
  bucket: 'Bucket: tap a closed area to fill it · tap a fill to recolour it · pinch to zoom',
};
if (window.matchMedia && matchMedia('(pointer: coarse)').matches) Object.assign(HINTS, TOUCH_HINTS);

// presets reset the brush-shape modifiers first, so switching looks never inherits a leftover nib or dash
const SHAPE_RESET = { nibRatio: 1, jitter: 0, wobble: 0, dash: 'none', shadeEnds: 0, shadeEdge: 0, ink: 0 };
const PRESETS = {
  'Gilded tube': { mode: 'tube', colA: '#f2c46d', colB: '#c2410c', grad: 'along', width: 18, opacity: 1 },
  'Neon': { mode: 'neon', colA: '#22d3ee', colB: '#e879f9', grad: 'along', width: 22, glow: 1.2, taperStart: 0, taperEnd: 0, opacity: 1 },
  'Engraving': { mode: 'engrave', colA: '#e7e5e4', colB: '#a8a29e', grad: 'none', width: 30, lines: 8, opacity: 1 },
  'Silk ribbon': { mode: 'ribbon', colA: '#fda4af', colB: '#7c3aed', grad: 'none', twist: 0.5, width: 30, taperStart: 0.05, taperEnd: 0.05, opacity: 1 },
  'Chrome': { mode: 'chrome', colA: '#93c5fd', colB: '#78350f', grad: 'none', width: 20, opacity: 1 },
  'Ink': { mode: 'flat', colA: '#f5f5f4', colB: '#f5f5f4', grad: 'none', width: 6, pressure: 1, taperStart: 0.2, taperEnd: 0.4, opacity: 1 },
  'Celtic weave': { mode: 'tube', colA: '#fef3c7', colB: '#d97706', grad: 'none', width: 22, taperStart: 0, taperEnd: 0, overlap: 'weave', opacity: 1 },
  'Glow mist': { mode: 'glow', colA: '#60a5fa', colB: '#f472b6', grad: 'along', width: 60, glow: 0.6, opacity: 1 },
  'Enamel bevel': { mode: 'bevel', colA: '#34d399', colB: '#065f46', grad: 'across', width: 24, bevel: 0.5, opacity: 1 },
  'Airbrush': { mode: 'airbrush', colA: '#fef3c7', colB: '#fb923c', grad: 'along', width: 70, opacity: 0.5 },
  'Calligraphy': { mode: 'flat', colA: '#f5f5f4', colB: '#f5f5f4', grad: 'none', width: 26, nibRatio: 0.12, nibAngle: 40, pressure: 0.3, taperStart: 0.04, taperEnd: 0.08, opacity: 1 },
  'Brush pen': { mode: 'flat', colA: '#e7e5e4', colB: '#e7e5e4', grad: 'none', width: 16, pressure: 1, taperStart: 0.25, taperEnd: 0.45, jitter: 0.35, jitterScale: 40, opacity: 1 },
  'Rope': { mode: 'rope', colA: '#e9d5a1', colB: '#a16207', grad: 'none', width: 26, strands: 3, twist: 1.6, taperStart: 0, taperEnd: 0, opacity: 1 },
  'Pencil sketch': { mode: 'sketch', colA: '#d6d3d1', colB: '#d6d3d1', grad: 'none', width: 14, strands: 3, rough: 0.6, wobble: 0.25, wobbleScale: 160, taperStart: 0.1, taperEnd: 0.2, opacity: 0.9 },
  'Dry brush': { mode: 'drybrush', colA: '#f97316', colB: '#7c2d12', grad: 'along', width: 40, rough: 0.6, pressure: 0.5, taperStart: 0.05, taperEnd: 0.3, opacity: 1 },
  'Watercolour': { mode: 'watercolor', colA: '#60a5fa', colB: '#a78bfa', grad: 'along', width: 46, rough: 0.6, jitter: 0.3, jitterScale: 90, taperStart: 0.1, taperEnd: 0.2, opacity: 0.9 },
  'Pearls': { mode: 'tube', colA: '#f8fafc', colB: '#cbd5e1', grad: 'none', width: 20, dash: 'dot', dashGap: 26, taperStart: 0, taperEnd: 0, pressure: 0, opacity: 1 },
  'Dotted line': { mode: 'flat', colA: '#f5f5f4', colB: '#f5f5f4', grad: 'none', width: 7, dash: 'dot', dashGap: 14, taperStart: 0, taperEnd: 0, pressure: 0, opacity: 1 },
  'Dashed line': { mode: 'flat', colA: '#f5f5f4', colB: '#f5f5f4', grad: 'none', width: 6, dash: 'dash', dashLen: 26, dashGap: 14, taperStart: 0, taperEnd: 0, pressure: 0, cap: 'butt', opacity: 1 },
  'Neon outline': { mode: 'outline', colA: '#5eead4', colB: '#0ea5e9', grad: 'along', width: 26, outline: 0.28, taperStart: 0, taperEnd: 0, opacity: 1 },
  'Tangle strand': { mode: 'flat', colA: '#f7f5ef', colB: '#f7f5ef', grad: 'none', width: 34, pressure: 0, taperStart: 0, taperEnd: 0, cap: 'round', overlap: 'later',
    ink: 2.4, inkCol: '#0a0a0a', shadeEnds: 0.92, shadeLen: 1.5, shadeWhich: 'both', shadeEdge: 0.3, shadeSide: 0, shadeGrain: 0.3, shadeCol: '#2a2a2a', opacity: 1 },
  'Tangle tube': { mode: 'tube', colA: '#f5f5f4', colB: '#f5f5f4', grad: 'none', width: 30, pressure: 0, taperStart: 0, taperEnd: 0, cap: 'round', overlap: 'later',
    ink: 2, inkCol: '#0a0a0a', shadeEnds: 0.85, shadeLen: 1.2, shadeWhich: 'both', shadeEdge: 0, shadeSide: 0, shadeGrain: 0.3, shadeCol: '#1f1f1f', opacity: 1 },
  'Inked colour band': { mode: 'flat', colA: '#f472b6', colB: '#60a5fa', grad: 'along', width: 34, pressure: 0, taperStart: 0, taperEnd: 0, cap: 'round', overlap: 'later',
    ink: 2.4, inkCol: '#0a0a0a', shadeEnds: 0.6, shadeLen: 1.2, shadeWhich: 'both', shadeEdge: 0.25, shadeSide: 0, shadeGrain: 0.5, shadeCol: '#1e1b4b', opacity: 1 },
  'Cross stitch': { mode: 'stitch', colA: '#fca5a5', colB: '#b91c1c', grad: 'none', width: 18, stitchSpacing: 12, stitchSlant: 0.9, taperStart: 0, taperEnd: 0, opacity: 1 },
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
function resize() {
  const r = stage.getBoundingClientRect();
  view.cssW = Math.max(1, r.width);
  view.cssH = Math.max(1, r.height);
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [glCanvas, ovCanvas]) {
    c.width = Math.round(view.cssW * view.dpr);
    c.height = Math.round(view.cssH * view.dpr);
  }
  dirty = true;
}

function fitView() {
  const pad = 40;
  view.zoom = Math.max(0.02, Math.min((view.cssW - pad) / doc.width, (view.cssH - pad) / doc.height));
  view.panX = (view.cssW - doc.width * view.zoom) / 2;
  view.panY = (view.cssH - doc.height * view.zoom) / 2;
  dirty = true;
  updateStatus();
}

function screenPos(e) { const r = ovCanvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
function toWorld(sx, sy) { return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom }; }
function toScreen(x, y) { return { sx: x * view.zoom + view.panX, sy: y * view.zoom + view.panY }; }

function zoomAt(sx, sy, k) {
  const z = Math.max(0.02, Math.min(40, view.zoom * k));
  k = z / view.zoom;
  view.panX = sx - (sx - view.panX) * k;
  view.panY = sy - (sy - view.panY) * k;
  view.zoom = z;
  dirty = true;
  updateStatus();
}

// ---------------------------------------------------------------------------
// Layers / selection helpers
// ---------------------------------------------------------------------------
const layerById = (id) => doc.layers.find((l) => l.id === id);
const activeLayer = () => layerById(doc.activeLayer) || doc.layers[doc.layers.length - 1];
const editable = (s) => { const l = layerById(s.layer); return l && l.visible && !l.locked; };

/** Strokes in visual stacking order, topmost first. */
function strokesTopFirst() {
  const out = [];
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const L = doc.layers[li];
    for (let i = doc.strokes.length - 1; i >= 0; i--) if (doc.strokes[i].layer === L.id) out.push(doc.strokes[i]);
  }
  return out;
}

function activeSym() { return primary ? primary.sym : tpl.sym; }
function activeRec() { return primary ? primary.rec : tpl.rec; }
function activeWarp() { return primary ? primary.warp : tpl.warp; }

function setSelection(list, prim) {
  selection = list.filter((s, i, a) => s && a.indexOf(s) === i);
  primary = prim && selection.includes(prim) ? prim : selection[selection.length - 1] || null;
  if (primary) { loadTemplateFrom(primary); doc.activeLayer = primary.layer; }
  hover = null;
  refreshPanel();
  dirty = true;
}

function membersOf(s) { return s.group ? doc.strokes.filter((t) => t.group === s.group && editable(t)) : [s]; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function draw() {
  if (renderer) {
    const W = glCanvas.width, H = glCanvas.height;
    const z = view.zoom * view.dpr;
    const px = view.panX * view.dpr, py = view.panY * view.dpr;
    const viewMat = new Float32Array([2 * z / W, 0, 0, 0, -2 * z / H, 0, 2 * px / W - 1, 1 - 2 * py / H, 1]);
    const x0 = Math.max(0, Math.floor(px)), x1 = Math.min(W, Math.ceil(px + doc.width * z));
    const y0 = Math.max(0, Math.floor(py)), y1 = Math.min(H, Math.ceil(py + doc.height * z));
    const artRect = [x0, Math.max(0, H - y1), Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
    try {
      renderer.render(doc, {
        viewMat, pxWorld: 1 / z, width: W, height: H, artRect,
        outside: [0.043, 0.047, 0.059, 1], transparent: false,
        extra: preview ? [{ stroke: preview, layer: activeLayer().id }] : [],
      });
    } catch (err) { console.error(err); }
    updateLiveInfo();
  }
  const tool = effectiveTool();
  drawOverlay(octx, {
    view, doc, guides: ui.showGuides ? guidesCached(activeSym(), activeRec(), activeWarp(), doc.width, doc.height) : null,
    showGuides: ui.showGuides, selection, primary, hover, handleHot, widthHot,
    penPoints: penPoints.map((p) => viewPointTpl(p)), penCloseHot, cursor, tool, brushWidth: tpl.style.width,
    marquee, snap: snapShow,
  });
}

function viewPointTpl(p) { return warpActive(tpl.warp) ? warpPoint(tpl.warp, +tpl.sym.cx, +tpl.sym.cy, p.x, p.y) : p; }

function frame() {
  requestAnimationFrame(frame);
  if (!dirty) return;
  dirty = false;
  draw();
}

function effectiveTool() { return spaceDown ? 'pan' : ui.tool; }

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function commit() {
  history.push(doc);
  updateUndo();
  updateStatus();
  renderLayers();
}

function restore(d) {
  if (!d) return;
  const ids = selection.map((s) => s.id), pid = primary && primary.id;
  doc = d;
  const sel = doc.strokes.filter((s) => ids.includes(s.id));
  setSelection(sel, doc.strokes.find((s) => s.id === pid));
  updateUndo();
  updateStatus();
  renderLayers();
}

function updateUndo() {
  $('#btnUndo').disabled = !history.canUndo();
  $('#btnRedo').disabled = !history.canRedo();
}

// ---------------------------------------------------------------------------
// Panel binding
// ---------------------------------------------------------------------------
function getSource(root) {
  if (TPL_ROOTS.has(root)) return tpl[root];
  if (root === 'light') return doc.light;
  if (root === 'doc') return doc;
  if (root === 'ui') return ui;
  return null;
}

function readEl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range' || el.type === 'number') return parseFloat(el.value);
  if (el.tagName === 'SELECT' && el.dataset.bind === 'ui.exportScale') return parseFloat(el.value);
  return el.value;
}

function fmt(v, el) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const step = el && el.step ? String(el.step) : '';
  const dec = step.includes('.') ? Math.min(3, step.split('.')[1].length) : (step ? 0 : 2);
  return v.toFixed(Math.abs(v) >= 100 ? Math.min(dec, 1) : dec);
}

function setValue(path, v) {
  const [root, key] = path.split('.');
  const src = getSource(root);
  if (!src) return;
  src[key] = v;
  if (TPL_ROOTS.has(root)) {
    for (const s of selection) {
      s[root][key] = v;
      if (MESH_ROOTS.has(root)) touch(s);
    }
    if (GROUP_ROOTS.has(root)) {
      for (const gid of new Set(selection.map((s) => s.group).filter(Boolean))) {
        const g = doc.groups.find((x) => x.id === gid);
        if (!g) continue;
        g[root][key] = v;
        for (const s of doc.strokes) if (s.group === gid) s[root][key] = v;
      }
    }
  }
  if (root === 'ui' && key === 'snap' && !v) snapShow = null;
  updateVisibility();
  dirty = true;
}

function refreshPanel() {
  for (const el of $$('[data-bind]')) {
    const [root, key] = el.dataset.bind.split('.');
    const src = getSource(root);
    if (!src) continue;
    const v = src[key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = fmt(+v, el);
  }
  const ds = $('#docSize');
  ds.value = `${doc.width}x${doc.height}`;
  if (!ds.value) {
    const opt = document.createElement('option');
    opt.value = `${doc.width}x${doc.height}`; opt.textContent = `${doc.width} × ${doc.height}`;
    ds.appendChild(opt); ds.value = opt.value;
  }
  updateVisibility();
  updateSelectionInfo();
  updateInfo();
  renderLayers();
}

function updateVisibility() {
  for (const el of $$('[data-show]')) {
    el.hidden = !el.dataset.show.split('&').every((cond) => {
      const [path, list] = cond.split('=');
      const [root, key] = path.split('.');
      const src = getSource(root);
      return src && list.split('|').includes(String(src[key]));
    });
  }
}

function updateInfo() {
  const sym = activeSym(), rec = activeRec();
  const xs = allTransformsCached(sym, rec, doc.width, doc.height);
  const recEl = $('#recInfo');
  if (!rec || rec.mode === 'off') recEl.textContent = '';
  else {
    recEl.textContent = `${xs.length.toLocaleString()} copies per stroke across ${xs.levels + 1} level${xs.levels ? 's' : ''}.`;
    if (xs.capped) {
      const tip = sym.mode === 'wallpaper' ? 'larger cells, a smaller group or less depth'
        : sym.mode === 'hyperbolic' ? 'a lower tiling depth or less recursion depth' : 'less depth';
      recEl.textContent += ` Level ${xs.levels + 1} would need ${xs.needed.toLocaleString()} copies (limit ${copyLimit().toLocaleString()}) — try ${tip}.`;
    }
  }
  recEl.classList.toggle('warn', !!(rec && rec.mode !== 'off' && xs.capped));
  let t = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} per stroke`;
  if (sym.mode === 'hyperbolic') {
    const p = Math.round(sym.hp), q = Math.round(sym.hq);
    t = hyperbolicValid(p, q)
      ? `{${p},${q}}: ${p}-gons, ${q} meeting at each vertex · ${t}. Draw inside the disk.`
      : `{${p},${q}} isn't hyperbolic (needs 1/p + 1/q < 1/2) — using a larger q. ${t}.`;
  } else if (sym.mode === 'wallpaper') t = `Group ${sym.wp} · ${t} (copies cover the artboard).`;
  else if (sym.mode === 'inversion') t = `Reflections through ${Math.round(sym.invK)} circle(s)${+sym.invHub > 0 ? ' + hub' : ''} · ${t}.`;
  else t += '.';
  $('#symInfo').textContent = t;
}

let lastLive = '';
function updateLiveInfo() {
  const el = $('#weaveInfo');
  let txt = '';
  if (primary && primary.style.overlap === 'weave' && renderer) {
    const m = renderer.meshes.get(primary.id);
    if (m && m.weaveInfo) {
      const w = m.weaveInfo;
      txt = w.crossings
        ? `Weave: ${w.crossings} crossing pairs, over/under alternates at ${w.kept} of ${w.alternations} steps along the strand.`
        : 'Weave: this stroke and its copies don\'t cross yet.';
    }
  }
  if (txt !== lastLive) { lastLive = txt; el.textContent = txt; el.hidden = !txt; }
  const st = renderer ? renderer.stats : null;
  if (st) $('#stats').textContent = `${doc.strokes.length} strokes · ${st.copiesDrawn} copies drawn${st.copiesCulled ? ` (${st.copiesCulled} culled)` : ''} · ${doc.width}×${doc.height}`;
}

function updateSelectionInfo() {
  const info = $('#selInfo');
  const on = selection.length > 0;
  for (const b of $$('#selSection button')) b.disabled = !on;
  $('#moveLayer').disabled = !on;
  if (!on) { info.textContent = 'Nothing selected — Edit (V): click a stroke, Shift-click to add, drag to box-select. The panel edits the whole selection.'; return; }
  const g = primary && primary.group ? doc.groups.find((x) => x.id === primary.group) : null;
  const copies = allTransformsCached(primary.sym, primary.rec, doc.width, doc.height).length;
  info.textContent = `${selection.length} selected` + (g ? ` · grouped (${doc.strokes.filter((s) => s.group === g.id).length} strokes share symmetry/recursion/warp)` : '') +
    ` · primary has ${primary.points.length} points, ${copies} copies`;
  const ml = $('#moveLayer');
  ml.replaceChildren(...doc.layers.slice().reverse().map((l) => Object.assign(document.createElement('option'), { value: l.id, textContent: l.name })));
  ml.value = primary.layer;
}

function bindPanel() {
  for (const el of $$('[data-bind]')) {
    el.addEventListener('input', () => {
      const v = readEl(el);
      setValue(el.dataset.bind, v);
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = fmt(v, el);
      if (/^(sym|rec|warp)\./.test(el.dataset.bind)) { updateInfo(); updateSelectionInfo(); }
    });
    el.addEventListener('change', () => {
      if (el.dataset.bind.split('.')[0] !== 'ui') commit();
      dirty = true;
    });
  }
  const preset = $('#preset');
  for (const name of Object.keys(PRESETS)) preset.appendChild(Object.assign(document.createElement('option'), { value: name, textContent: name }));
  preset.addEventListener('change', () => {
    const p = PRESETS[preset.value];
    if (!p) return;
    Object.assign(tpl.style, SHAPE_RESET, p);
    for (const s of selection) { Object.assign(s.style, SHAPE_RESET, p); touch(s); }
    if (selection.length) commit();
    preset.value = '';
    refreshPanel();
  });
  $('#docSize').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    if (!w || !h) return;
    const oldCx = doc.width / 2, oldCy = doc.height / 2;
    doc.width = w; doc.height = h;
    if (Math.abs(tpl.sym.cx - oldCx) < 1 && Math.abs(tpl.sym.cy - oldCy) < 1) { tpl.sym.cx = w / 2; tpl.sym.cy = h / 2; }
    commit(); fitView(); refreshPanel();
  });
  $('#moveLayer').addEventListener('change', (e) => {
    for (const s of selection) s.layer = e.target.value;
    doc.activeLayer = e.target.value;
    commit(); refreshPanel();
  });
  const wt = $('#warpType');
  for (const w of WARPS) wt.appendChild(Object.assign(document.createElement('option'), { value: w, textContent: WARP_LABELS[w] }));
}

function loadTemplateFrom(s) {
  for (const k of TPL_ROOTS) tpl[k] = clone(s[k]);
}

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------
function renderLayers() {
  const box = $('#layersList');
  const rows = doc.layers.map((L) => {
    const row = document.createElement('div');
    row.className = 'layer' + (L.id === doc.activeLayer ? ' active' : '');
    const n = doc.strokes.filter((s) => s.layer === L.id).length;
    row.innerHTML = `<div class="top"><button class="eye${L.visible ? '' : ' off'}" title="Show / hide">👁</button><button class="lock${L.locked ? '' : ' off'}" title="Lock">🔒</button><span class="name"></span><span class="count">${n}</span></div>
      <div class="bot"><input type="range" min="0" max="1" step="0.01"><output></output><select>${['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add', 'difference'].map((b) => `<option value="${b}">${b}</option>`).join('')}</select></div>`;
    row.querySelector('.name').textContent = L.name;
    const op = row.querySelector('input'), out = row.querySelector('output'), bl = row.querySelector('select');
    op.value = L.opacity; out.textContent = Math.round(L.opacity * 100) + '%'; bl.value = L.blend || 'normal';
    row.addEventListener('click', (e) => {
      if (e.target.closest('input,select,button')) return;
      if (doc.activeLayer !== L.id) { doc.activeLayer = L.id; renderLayers(); }
    });
    row.querySelector('.eye').addEventListener('click', () => { L.visible = !L.visible; if (!L.visible) dropFromSelection(L.id); commit(); dirty = true; });
    row.querySelector('.lock').addEventListener('click', () => { L.locked = !L.locked; if (L.locked) dropFromSelection(L.id); commit(); });
    row.querySelector('.name').addEventListener('dblclick', (e) => {
      const span = e.currentTarget, inp = Object.assign(document.createElement('input'), { value: L.name });
      span.replaceChildren(inp); inp.focus(); inp.select();
      const done = () => { L.name = inp.value.trim() || L.name; commit(); };
      inp.addEventListener('keydown', (k) => { if (k.key === 'Enter') inp.blur(); if (k.key === 'Escape') { inp.value = L.name; inp.blur(); } k.stopPropagation(); });
      inp.addEventListener('blur', done);
    });
    op.addEventListener('input', () => { L.opacity = +op.value; out.textContent = Math.round(L.opacity * 100) + '%'; dirty = true; });
    op.addEventListener('change', () => commit());
    bl.addEventListener('change', () => { L.blend = bl.value; commit(); dirty = true; });
    return row;
  });
  box.replaceChildren(...rows);
}

function dropFromSelection(layerId) {
  if (selection.some((s) => s.layer === layerId)) setSelection(selection.filter((s) => s.layer !== layerId), primary && primary.layer !== layerId ? primary : null);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function setTool(t) {
  if (penPoints.length && !((ui.tool === 'pen' || ui.tool === 'draw') && (t === 'pen' || t === 'draw'))) finishPen(false);
  const was = ui.tool;
  ui.tool = t;
  updateVisibility();
  if (t === 'bucket' && was !== 'bucket' && panelTabs && document.body.classList.contains('tabbed')) panelTabs.show($('#bucketSection'));
  for (const b of $$('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
  hover = null; handleHot = -1; widthHot = -1; snapShow = null;
  updateCursorClass();
  $('#hint').textContent = HINTS[t] || '';
  dirty = true;
}

function flashHint(msg) {
  const h = $('#hint');
  h.textContent = msg;
  h.style.color = '#fbbf24';
  clearTimeout(flashHint.t);
  flashHint.t = setTimeout(() => { h.style.color = ''; h.textContent = HINTS[ui.tool] || ''; }, 2200);
}

function updateCursorClass() {
  const t = effectiveTool();
  ovCanvas.className = '';
  if (t === 'pan') ovCanvas.classList.add(drag && drag.kind === 'pan' ? 'panning' : 'pan');
  else if (t === 'edit') ovCanvas.classList.add(hover && handleHot < 0 ? 'move' : 'edit');
  else if (t === 'width') ovCanvas.classList.add('width');
  else if (t === 'bucket') ovCanvas.classList.add('bucket');
}

function makePreview(points, overrides = {}) {
  const s = makeStroke(points, tpl, activeLayer().id);
  s.id = '__preview';
  Object.assign(s.shape, overrides);
  return s;
}

/** World → pre-warp position for a stroke whose warp is w (identity copy). */
function unwarp(warp, sym, x, y, guess) {
  return warpActive(warp) ? warpInverse(warp, +sym.cx, +sym.cy, x, y, guess) : { x, y };
}

function warpScaleAt(warp, sym, x, y) {
  if (!warpActive(warp)) return 1;
  const h = Math.max(1e-2, warp.scale * 1e-4), cx = +sym.cx, cy = +sym.cy;
  const f = warpPoint(warp, cx, cy, x, y), fx = warpPoint(warp, cx, cy, x + h, y), fy = warpPoint(warp, cx, cy, x, y + h);
  return Math.sqrt(Math.abs(((fx.x - f.x) * (fy.y - f.y) - (fy.x - f.x) * (fx.y - f.y)) / (h * h)));
}

const invCache = new WeakMap();
function inverses(xs) {
  let v = invCache.get(xs);
  if (!v) { v = xs.map((t) => mobInverse(t.mob)); invCache.set(xs, v); }
  return v;
}

const boundCache = new Map();
function bound(s) {
  const c = boundCache.get(s.id);
  if (c && c.rev === s.rev) return c.b;
  const b = boundCircle(s);
  boundCache.set(s.id, { rev: s.rev, b });
  return b;
}

/** Hit test across every copy of every editable stroke, topmost first. */
function hitTest(wx, wy, slopPx = 5) {
  const slop = slopPx / view.zoom;
  for (const s of strokesTopFirst()) {
    if (!editable(s)) continue;
    const xs = allTransformsCached(s.sym, s.rec, doc.width, doc.height);
    const inv = inverses(xs);
    let pre = { x: wx, y: wy }, ws = 1;
    if (warpActive(s.warp)) {
      pre = unwarp(s.warp, s.sym, wx, wy);
      const back = warpPoint(s.warp, +s.sym.cx, +s.sym.cy, pre.x, pre.y);
      if (Math.hypot(back.x - wx, back.y - wy) > 2 / view.zoom) continue;
      ws = warpScaleAt(s.warp, s.sym, pre.x, pre.y) || 1;
    }
    const b = bound(s);
    const closed = isClosed(s);
    const hasFill = closed && s.fill.mode !== 'none' && s.fill.opacity > 0;
    let wmax = 1;
    for (const p of s.points) wmax = Math.max(wmax, p.w ?? 1);
    const hwLocal = s.style.mode === 'none' ? 0 : s.style.width * 0.5 * wmax;
    const sm = getSamples(s);
    for (let k = 0; k < xs.length; k++) {
      const l = mobApply(inv[k], pre.x, pre.y);
      const sc = mobScaleAt(xs[k].mob, l.x, l.y) * ws;
      if (!(sc > 1e-9)) continue;
      const tol = hwLocal + slop / sc;
      if (Math.hypot(l.x - b.x, l.y - b.y) > b.r + tol) continue;
      const near = nearestOnPolyline(sm, l.x, l.y, closed);
      if (near.d <= tol || (hasFill && pointInPolygon(sm, l.x, l.y))) return { stroke: s, k, inv: inv[k], near, body: near.d <= tol };
    }
  }
  return null;
}

function handleAt(sx, sy) {
  if (!primary) return -1;
  let best = -1, bd = 9;
  primary.points.forEach((p, i) => {
    const v = viewPoint(primary, p.x, p.y), s = toScreen(v.x, v.y);
    const d = Math.hypot(s.sx - sx, s.sy - sy);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Width-tool target: the handle whose width ring (or centre) is nearest the cursor. */
function widthHandleAt(sx, sy) {
  if (!primary) return -1;
  let best = -1, bd = 10;
  primary.points.forEach((p, i) => {
    const v = viewPoint(primary, p.x, p.y), s = toScreen(v.x, v.y);
    const d = Math.hypot(s.sx - sx, s.sy - sy), r = primary.style.width * 0.5 * (p.w ?? 1) * view.zoom;
    const dd = Math.min(d, Math.abs(d - r));
    if (dd < bd) { bd = dd; best = i; }
  });
  return best;
}

// ---- snapping ----
function snapWorld(x, y, kind = 'guides') {
  if (!ui.snap) { snapShow = null; return { x, y }; }
  let hit;
  if (kind === 'artboard') {
    const W = doc.width, H = doc.height, pts = [];
    for (const fx of [0, 1 / 3, 0.5, 2 / 3, 1]) for (const fy of [0, 1 / 3, 0.5, 2 / 3, 1]) pts.push({ x: W * fx, y: H * fy, kind: 'node' });
    hit = snapTo({ points: pts, lines: [] }, x, y, 12 / view.zoom);
  } else {
    hit = snapTo(guidesCached(activeSym(), activeRec(), activeWarp(), doc.width, doc.height), x, y, 10 / view.zoom);
  }
  snapShow = hit;
  return hit ? { x: hit.x, y: hit.y } : { x, y };
}

// ---- joining strokes end-to-end ----
const JOIN_PX = 10;

/** Nearest open-stroke endpoint (identity copy, on the active layer) within JOIN_PX of a world point. */
function findJoin(x, y, exclude = null) {
  if (!ui.joinEnds) return null;
  const lid = activeLayer().id;
  let best = null, bd = JOIN_PX / view.zoom;
  for (const s of doc.strokes) {
    if (s === exclude || s.layer !== lid || !editable(s) || isClosed(s) || !s.points.length) continue;
    const a = s.points[0], b = s.points[s.points.length - 1];
    for (const [which, q] of [['end', b], ['start', a]]) {
      const v = viewPoint(s, q.x, q.y), d = Math.hypot(v.x - x, v.y - y);
      if (d < bd) { bd = d; best = { stroke: s, which, x: v.x, y: v.y }; }
    }
  }
  return best;
}

/** Re-express world points in a stroke's own (pre-warp) frame. */
function toLocalOf(s, wpts) {
  let guess;
  return wpts.map((w) => { const l = unwarp(s.warp, s.sym, w.x, w.y, guess); guess = l; return { x: l.x, y: l.y, p: w.p ?? 1, w: w.w ?? 1 }; });
}

const worldOf = (s, pts) => pts.map((p) => ({ ...viewPoint(s, p.x, p.y), p: p.p ?? 1, w: p.w ?? 1 }));

/**
 * Commit freshly drawn points (template-local). If the first / last point lands on an open stroke's
 * endpoint, the new points extend that stroke (or bridge two strokes, or close a loop) so the spline
 * and its gradient run continuously through the join.
 */
function commitStroke(localPts, forceClosed = false) {
  if (!localPts.length) return;
  const world = localPts.map((p) => ({ ...viewPointTpl(p), p: p.p ?? 1, w: p.w ?? 1 }));
  const startJ = forceClosed ? null : findJoin(world[0].x, world[0].y);
  const endJ = forceClosed || world.length < 2 ? null : findJoin(world[world.length - 1].x, world[world.length - 1].y);
  if (!startJ && !endJ) {
    if (localPts.length < 1) return;
    const s = makeStroke(localPts, tpl, activeLayer().id);
    s.shape.closed = forceClosed ? true : tpl.shape.closed;
    if (localPts.length < 3) s.shape.closed = false;
    doc.strokes.push(s);
    commit();
    return s;
  }
  let base;
  if (startJ) {
    base = startJ.stroke;
    // S: the new path in world space, starting next to base's joined endpoint and running outward
    let S = world.slice(1);
    let close = false;
    if (endJ && endJ.stroke === base && endJ.which !== startJ.which && base.points.length + S.length >= 3) {
      S = S.slice(0, -1); close = true;                               // came back to its other end → loop
    } else if (endJ && endJ.stroke !== base) {
      const other = endJ.stroke;
      S = S.slice(0, -1).concat(worldOf(other, endJ.which === 'end' ? other.points.slice().reverse() : other.points));
      removeStrokes([other]);
    }
    if (!S.length && !close) { dirty = true; return base; }          // a tap on the endpoint itself
    // keep the base stroke's own direction (and so its gradient): append at its end, prepend at its start
    if (startJ.which === 'end') base.points.push(...toLocalOf(base, S));
    else base.points.unshift(...toLocalOf(base, S.slice().reverse()));
    if (close) base.shape.closed = true;
  } else {
    base = endJ.stroke;
    const lead = world.slice(0, -1);
    if (endJ.which === 'start') base.points.unshift(...toLocalOf(base, lead));
    else base.points.push(...toLocalOf(base, lead.slice().reverse()));
  }
  touch(base);
  commit();
  flashHint('Joined into one continuous stroke — its gradient now runs through the join.');
  return base;
}

function removeStrokes(list) {
  doc.strokes = doc.strokes.filter((s) => !list.includes(s));
  pruneGroups();
  if (selection.some((s) => list.includes(s))) setSelection(selection.filter((s) => !list.includes(s)), null);
}

/** Show the join ring when the cursor is over a joinable endpoint. Returns the join, if any. */
function joinHover(w) {
  const j = findJoin(w.x, w.y);
  if (j) snapShow = { x: j.x, y: j.y, kind: 'join', onLine: false };
  return j;
}

// ---- freehand ----
function beginDraw(w, e, sx, sy) {
  const j = findJoin(w.x, w.y);
  const sw = j ? { x: j.x, y: j.y } : snapWorld(w.x, w.y);
  const p = pressureOf(e);
  const l = unwarp(tpl.warp, tpl.sym, sw.x, sw.y);
  drag = { kind: 'draw', raw: [{ x: l.x, y: l.y, p }], smooth: { x: sw.x, y: sw.y }, snapped: !!snapShow, s0: { sx, sy }, t0: performance.now(), maxMove: 0 };
  preview = makePreview(drag.raw, { spline: 'linear', closed: false });
}

function extendDraw(w, e) {
  const sm = drag.smooth;
  const k = 1 - ui.stabilize;
  sm.x += (w.x - sm.x) * k;
  sm.y += (w.y - sm.y) * k;
  const last = drag.raw[drag.raw.length - 1];
  const lastV = viewPointTpl(last);
  if (Math.hypot(sm.x - lastV.x, sm.y - lastV.y) * view.zoom < 1.5) return;
  const l = unwarp(tpl.warp, tpl.sym, sm.x, sm.y, last);
  drag.raw.push({ x: l.x, y: l.y, p: pressureOf(e) });
  preview.points = (drag.chain || []).concat(drag.raw);
  preview.rev = nextRev();
}

function endDraw() {
  const raw = drag.raw;
  endDraw.chain = drag.chain || null;
  drag = null;
  preview = null;
  if (!raw.length) return;
  if (ui.snap && raw.length > 1) {
    const lastV = viewPointTpl(raw[raw.length - 1]);
    const sw = snapWorld(lastV.x, lastV.y);
    if (snapShow) { const l = unwarp(tpl.warp, tpl.sym, sw.x, sw.y, raw[raw.length - 1]); raw[raw.length - 1] = { ...raw[raw.length - 1], x: l.x, y: l.y }; }
    snapShow = null;
  }
  const chain = drag && drag.chain ? drag.chain : (endDraw.chain || []);
  endDraw.chain = null;
  let pts = raw.length > 2 ? simplify(raw, Math.max(0.15, ui.smooth) / view.zoom) : raw.slice();
  pts = chain.concat(pts);
  commitStroke(pts);
  dirty = true;
}

function pressureOf(e) {
  if (e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5)) return Math.max(0.05, e.pressure || 0.5);
  return 1;
}

// ---- pen ----
function penClick(w, sx, sy) {
  if (penPoints.length >= 3) {
    const f0 = viewPointTpl(penPoints[0]), f = toScreen(f0.x, f0.y);
    if (Math.hypot(f.sx - sx, f.sy - sy) < 10) { finishPen(true); return; }
  }
  const j = findJoin(w.x, w.y);
  const sw = j ? { x: j.x, y: j.y } : snapWorld(w.x, w.y);
  const l = unwarp(tpl.warp, tpl.sym, sw.x, sw.y, penPoints[penPoints.length - 1]);
  penPoints.push({ x: l.x, y: l.y, p: 1, w: 1 });
  updatePenPreview();
}

function updatePenPreview() {
  if (!penPoints.length) { preview = null; dirty = true; return; }
  let pts = penPoints.slice();
  if (cursor && !penCloseHot) {
    const c = snapShow ? { x: snapShow.x, y: snapShow.y } : cursor;
    const l = unwarp(tpl.warp, tpl.sym, c.x, c.y, penPoints[penPoints.length - 1]);
    pts = pts.concat([{ x: l.x, y: l.y, p: 1 }]);
  }
  preview = makePreview(pts, penCloseHot ? { closed: true } : { closed: false });
  dirty = true;
}

function finishPen(forceClosed) {
  const pts = [];
  for (const p of penPoints) {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) * view.zoom > 3) pts.push(p);
  }
  penPoints = []; preview = null; penCloseHot = false; snapShow = null;
  if (pts.length >= 2) commitStroke(pts, forceClosed);
  dirty = true;
}

function cancelPen() { penPoints = []; preview = null; penCloseHot = false; snapShow = null; dirty = true; }

function canDrawHere() {
  const L = activeLayer();
  if (!L.visible) { flashHint(`Layer “${L.name}” is hidden — show it or pick another layer to draw.`); return false; }
  if (L.locked) { flashHint(`Layer “${L.name}” is locked — unlock it or pick another layer to draw.`); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Pointer events
// ---------------------------------------------------------------------------
function onPointerDown(e) {
  if (!renderer) return;
  ovCanvas.focus({ preventScroll: true });
  const { sx, sy } = screenPos(e);
  pointers.set(e.pointerId, { sx, sy, type: e.pointerType });
  tapDown = (e.pointerType === 'touch' && pointers.size === 1) ? { sx, sy, t: performance.now() } : null;

  if (e.pointerType === 'touch' && pointers.size === 2) {
    if (drag && drag.kind === 'draw') preview = null;
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy), mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
    dirty = true;
    return;
  }
  if (pointers.size > 1) return;

  const w = toWorld(sx, sy);
  const tool = effectiveTool();
  ovCanvas.setPointerCapture(e.pointerId);

  if (e.button === 1 || tool === 'pan') { drag = { kind: 'pan', sx, sy }; updateCursorClass(); e.preventDefault(); return; }
  if (e.button === 2) { if ((tool === 'pen' || tool === 'draw') && penPoints.length) finishPen(false); return; }

  switch (tool) {
    case 'draw': if (canDrawHere()) beginDraw(w, e, sx, sy); break;
    case 'pen': if (canDrawHere()) penClick(w, sx, sy); break;
    case 'bucket': if (canDrawHere()) bucketFill(w); break;
    case 'center': setCenter(snapWorld(w.x, w.y, 'artboard')); drag = { kind: 'center' }; break;
    case 'width': {
      let h = widthHandleAt(sx, sy);
      if (h < 0) {
        const hit = hitTest(w.x, w.y);
        if (hit) { setSelection(membersOf(hit.stroke), hit.stroke); }
        break;
      }
      if (e.altKey) { primary.points[h].w = 1; touch(primary); commit(); break; }
      drag = { kind: 'width', idx: h, moved: false };
      break;
    }
    case 'edit': {
      const h = handleAt(sx, sy);
      if (h >= 0) {
        if (e.altKey) {
          if (primary.points.length > 2) { primary.points.splice(h, 1); touch(primary); commit(); }
          handleHot = -1;
        } else drag = { kind: 'handle', idx: h, moved: false };
        break;
      }
      const hit = hitTest(w.x, w.y);
      if (hit) {
        const members = membersOf(hit.stroke);
        if (e.shiftKey) {
          const inSel = selection.includes(hit.stroke);
          setSelection(inSel ? selection.filter((s) => !members.includes(s)) : selection.concat(members), inSel ? primary : hit.stroke);
          break;
        }
        if (!selection.includes(hit.stroke)) setSelection(members, hit.stroke);
        else if (primary !== hit.stroke) { primary = hit.stroke; loadTemplateFrom(primary); refreshPanel(); }
        const s = hit.stroke;
        const pre = unwarp(s.warp, s.sym, w.x, w.y);
        drag = {
          kind: 'move', stroke: s, inv: hit.inv, start: mobApply(hit.inv, pre.x, pre.y), lastPre: pre,
          orig: selection.map((t) => ({ s: t, pts: t.points.map((p) => ({ ...p })) })), moved: false,
        };
      } else {
        drag = { kind: 'marquee', x0: w.x, y0: w.y, additive: e.shiftKey, moved: false };
      }
      updateCursorClass();
      break;
    }
  }
  dirty = true;
}

function onPointerMove(e) {
  const { sx, sy } = screenPos(e);
  const pr = pointers.get(e.pointerId);
  if (pr) { pr.sx = sx; pr.sy = sy; }

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
    const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
    view.panX += mx - pinch.mx; view.panY += my - pinch.my;
    if (pinch.d > 0) zoomAt(mx, my, d / pinch.d);
    pinch = { d, mx, my };
    dirty = true;
    return;
  }

  const w = toWorld(sx, sy);
  cursor = w;

  if (drag) {
    switch (drag.kind) {
      case 'pan':
        view.panX += sx - drag.sx; view.panY += sy - drag.sy;
        drag.sx = sx; drag.sy = sy;
        break;
      case 'draw': {
        drag.maxMove = Math.max(drag.maxMove, Math.hypot(sx - drag.s0.sx, sy - drag.s0.sy));
        // a real drag while tapped points are pending: commit them, carry on freehand
        if (penPoints.length && drag.maxMove >= TAP_SLOP) {
          drag.chain = penPoints.slice();
          penPoints = []; penCloseHot = false;
          preview = makePreview(drag.chain.concat(drag.raw), { spline: 'linear', closed: false });
        }
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ce of (evs.length ? evs : [e])) { const p = screenPos(ce); extendDraw(toWorld(p.sx, p.sy), ce); }
        break;
      }
      case 'handle': {
        const p = primary.points[drag.idx];
        const sw = snapWorld(w.x, w.y);
        const l = unwarp(primary.warp, primary.sym, sw.x, sw.y, p);
        p.x = l.x; p.y = l.y;
        drag.moved = true;
        touch(primary);
        break;
      }
      case 'width': {
        const p = primary.points[drag.idx];
        const v = viewPoint(primary, p.x, p.y);
        const ws = warpScaleAt(primary.warp, primary.sym, p.x, p.y) || 1;
        p.w = Math.max(0, Math.min(12, Math.hypot(w.x - v.x, w.y - v.y) / ws / Math.max(0.25, primary.style.width * 0.5)));
        drag.moved = true;
        touch(primary);
        break;
      }
      case 'move': {
        const s = drag.stroke;
        const pre = unwarp(s.warp, s.sym, w.x, w.y, drag.lastPre);
        drag.lastPre = pre;
        const l = mobApply(drag.inv, pre.x, pre.y);
        const dx = l.x - drag.start.x, dy = l.y - drag.start.y;
        for (const o of drag.orig) { o.s.points.forEach((p, i) => { p.x = o.pts[i].x + dx; p.y = o.pts[i].y + dy; }); touch(o.s); }
        drag.moved = true;
        break;
      }
      case 'marquee':
        drag.x1 = w.x; drag.y1 = w.y;
        drag.moved = drag.moved || Math.hypot(w.x - drag.x0, w.y - drag.y0) * view.zoom > 3;
        marquee = drag.moved ? { x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y } : null;
        break;
      case 'center': setCenter(snapWorld(w.x, w.y, 'artboard')); break;
    }
    dirty = true;
    return;
  }

  const tool = effectiveTool();
  if (tool === 'edit') {
    const h = handleAt(sx, sy);
    // hover hit-testing walks every copy: throttle it (big wallpaper / hyperbolic sets run to 50k copies)
    const now = performance.now();
    if (h < 0 && now - (onPointerMove.lastHit || 0) < 40) { dirty = true; return; }
    onPointerMove.lastHit = now;
    const hv = h >= 0 ? primary : (hitTest(w.x, w.y) || {}).stroke || null;
    if (h !== handleHot || hv !== hover) { handleHot = h; hover = hv; updateCursorClass(); }
  } else if (tool === 'width') {
    widthHot = widthHandleAt(sx, sy);
  } else if (tool === 'pen') {
    let hot = false;
    if (penPoints.length >= 3) { const f0 = viewPointTpl(penPoints[0]), f = toScreen(f0.x, f0.y); hot = Math.hypot(f.sx - sx, f.sy - sy) < 10; }
    penCloseHot = hot;
    if (!hot) { snapWorld(w.x, w.y); joinHover(w); } else snapShow = null;
    updatePenPreview();
  } else if (tool === 'draw') {
    if (penPoints.length) {
      let hot = false;
      if (penPoints.length >= 3) { const f0 = viewPointTpl(penPoints[0]), f = toScreen(f0.x, f0.y); hot = Math.hypot(f.sx - sx, f.sy - sy) < 10; }
      penCloseHot = hot;
      if (!hot) { snapWorld(w.x, w.y); joinHover(w); } else snapShow = null;
      updatePenPreview();
    } else { snapWorld(w.x, w.y); joinHover(w); }
  } else if (tool === 'center') {
    snapWorld(w.x, w.y, 'artboard');
  }
  dirty = true;
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; tapDown = null; return; }
  if (e.type === 'pointerup' && e.pointerType === 'touch' && tapDown && pointers.size === 0) {
    const { sx, sy } = screenPos(e), now = performance.now();
    if (Math.hypot(sx - tapDown.sx, sy - tapDown.sy) < 10 && now - tapDown.t < 300) {
      if (lastTap && now - lastTap.t < 350 && Math.hypot(sx - lastTap.sx, sy - lastTap.sy) < 30) {
        lastTap = null;
        queueMicrotask(() => { synthDblAt = performance.now(); onDblClick(e, true); });
      } else lastTap = { sx, sy, t: now };
    } else lastTap = null;
  }
  tapDown = null;
  if (!drag) return;
  switch (drag.kind) {
    case 'draw': {
      const isTap = ui.tapPoints && drag.maxMove < TAP_SLOP && performance.now() - drag.t0 < TAP_MS;
      if (isTap) {
        const s0 = drag.s0;
        drag = null; preview = null; snapShow = null;
        penClick(toWorld(s0.sx, s0.sy), s0.sx, s0.sy);
      } else endDraw();
      break;
    }
    case 'handle': case 'move': case 'width': if (drag.moved) commit(); drag = null; break;
    case 'center': commit(); drag = null; break;
    case 'marquee': {
      const d = drag; drag = null; marquee = null;
      if (!d.moved) { if (!d.additive) setSelection([], null); break; }
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      const picked = [];
      for (const s of doc.strokes) {
        if (!editable(s)) continue;
        const sm = getSamples(s);
        const step = Math.max(1, Math.floor(sm.length / 64));
        for (let i = 0; i < sm.length; i += step) {
          const v = viewPoint(s, sm[i].x, sm[i].y);
          if (v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1) { picked.push(...membersOf(s)); break; }
        }
      }
      setSelection(d.additive ? selection.concat(picked) : picked, picked[picked.length - 1]);
      break;
    }
    default: drag = null;
  }
  snapShow = ui.snap && ['draw', 'pen', 'center'].includes(effectiveTool()) ? snapShow : null;
  updateCursorClass();
  dirty = true;
}

function onDblClick(e, synthetic = false) {
  if (!synthetic && performance.now() - synthDblAt < 500) return; // already handled as a touch double-tap
  const { sx, sy } = screenPos(e);
  const tool = effectiveTool();
  if (tool === 'pen' || (tool === 'draw' && penPoints.length)) { if (penPoints.length) finishPen(false); return; }
  if (tool === 'edit' && primary) {
    const w = toWorld(sx, sy);
    const pre = unwarp(primary.warp, primary.sym, w.x, w.y);
    const sm = getSamples(primary);
    const near = nearestOnPolyline(sm, pre.x, pre.y, isClosed(primary));
    if (near.index < 0 || near.d * view.zoom > 10) return;
    const seg = sm[near.index].seg ?? 0, src = sm[near.index];
    primary.points.splice(seg + 1, 0, { x: near.x, y: near.y, p: src.p ?? 1, w: src.w ?? 1 });
    touch(primary);
    commit();
    dirty = true;
  }
}

function onWheel(e) {
  e.preventDefault();
  const { sx, sy } = screenPos(e);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey || !e.shiftKey) zoomAt(sx, sy, Math.exp(-dy * 0.0015));
  else { view.panX -= dy; dirty = true; }
}

function setCenter(w) {
  tpl.sym.cx = w.x; tpl.sym.cy = w.y;
  for (const s of selection) { s.sym.cx = w.x; s.sym.cy = w.y; }
  for (const gid of new Set(selection.map((s) => s.group).filter(Boolean))) {
    const g = doc.groups.find((x) => x.id === gid);
    if (g) { g.sym.cx = w.x; g.sym.cy = w.y; for (const s of doc.strokes) if (s.group === gid) { s.sym.cx = w.x; s.sym.cy = w.y; } }
  }
  dirty = true;
}

// ---------------------------------------------------------------------------
// Dialogs (native confirm/alert and script downloads are blocked in sandboxed hosts)
// ---------------------------------------------------------------------------
function dialog(title, bodyNodes, buttons) {
  const m = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(...bodyNodes);
  const bar = $('#modalBtns'); bar.replaceChildren();
  return new Promise((resolve) => {
    const close = (v) => { m.hidden = true; resolve(v); };
    for (const b of buttons) {
      const el = b.href ? Object.assign(document.createElement('a'), { href: b.href, download: b.download || '', className: 'button', textContent: b.label })
        : Object.assign(document.createElement('button'), { textContent: b.label, className: b.cls || '' });
      el.addEventListener('click', () => { if (b.onClick) b.onClick(el); if (b.value !== undefined) close(b.value); });
      bar.appendChild(el);
    }
    m.onclick = (e) => { if (e.target === m) close(false); };
    m.hidden = false;
  });
}
const para = (t) => Object.assign(document.createElement('p'), { textContent: t });
const ask = (title, text, okLabel = 'OK') => dialog(title, [para(text)], [{ label: 'Cancel', value: false }, { label: okLabel, value: true, cls: 'primary' }]);
const notify = (title, text) => dialog(title, [para(text)], [{ label: 'OK', value: true }]);

let lastBlobUrl = null;
function download(blob, name, preview) {
  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  const url = lastBlobUrl = URL.createObjectURL(blob);
  const nodes = [];
  if (preview) nodes.push(Object.assign(document.createElement('img'), { src: url, alt: name }));
  nodes.push(para(`${name} · ${(blob.size / 1024).toFixed(0)} KB`));
  nodes.push(para(preview ? 'If the download button does nothing here, right-click the image and choose "Save image as".' : 'If the download button does nothing here, use Copy and paste into a .json file.'));
  const btns = [{ label: 'Download', href: url, download: name }];
  if (!preview) btns.push({ label: 'Copy', onClick: async (el) => { try { await navigator.clipboard.writeText(await blob.text()); el.textContent = 'Copied'; } catch { el.textContent = 'Copy blocked'; } } });
  btns.push({ label: 'Close', value: true });
  dialog(preview ? 'Export ready' : 'Save document', nodes, btns);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function loadDoc(d) {
  doc = d;
  setSelection([], null);
  history.reset(doc);
  updateUndo(); fitView(); renderLayers();
}

const actions = {
  async new() {
    if (doc.strokes.length && !(await ask('New drawing', 'Start a new drawing? Unsaved strokes will be lost.', 'New'))) return;
    const w = doc.width, h = doc.height;
    tpl.sym.cx = w / 2; tpl.sym.cy = h / 2;
    loadDoc(newDocument(w, h));
  },
  open() { $('#fileInput').click(); },
  save() { download(new Blob([serialise(doc)], { type: 'application/json' }), `recurror-${stamp()}.json`); },
  async demo() {
    if (doc.strokes.length && !(await ask('Load demo', 'Replace the current drawing with the demo?', 'Replace'))) return;
    const d = buildDemo();
    tpl.sym = clone(d.strokes[0].sym);
    loadDoc(d);
  },
  undo() { restore(history.undo()); },
  redo() { restore(history.redo()); },
  fit() { fitView(); },
  clear() {
    const L = activeLayer();
    if (!doc.strokes.some((s) => s.layer === L.id)) return;
    doc.strokes = doc.strokes.filter((s) => s.layer !== L.id);
    pruneGroups();
    setSelection(selection.filter((s) => s.layer !== L.id), null);
    commit();
  },
  export() {
    if (!renderer) return;
    try {
      const c = renderer.exportCanvas(doc, ui.exportScale, ui.transparent);
      c.toBlob((b) => b && download(b, `recurror-${c.width}x${c.height}-${stamp()}.png`, true), 'image/png');
    } catch (err) { notify('Export failed', err.message); console.error(err); }
    dirty = true;
  },
  centerArt() { setCenter({ x: doc.width / 2, y: doc.height / 2 }); if (selection.length) commit(); },
  symAll() {
    if (!doc.strokes.length) return;
    for (const s of doc.strokes) { s.sym = clone(tpl.sym); s.rec = clone(tpl.rec); s.warp = clone(tpl.warp); }
    for (const g of doc.groups) { g.sym = clone(tpl.sym); g.rec = clone(tpl.rec); g.warp = clone(tpl.warp); }
    commit(); refreshPanel();
  },
  group() {
    if (!selection.length) return;
    const g = { id: newId('g'), sym: clone(primary.sym), rec: clone(primary.rec), warp: clone(primary.warp) };
    doc.groups.push(g);
    for (const s of selection) s.group = g.id;
    syncGroup(doc, g);
    pruneGroups();
    commit(); refreshPanel();
  },
  ungroup() {
    if (!selection.some((s) => s.group)) return;
    for (const s of selection) s.group = null;
    pruneGroups();
    commit(); refreshPanel();
  },
  dup() {
    if (!selection.length) return;
    const off = 24 / view.zoom;
    const gmap = new Map();
    for (const gid of new Set(selection.map((s) => s.group).filter(Boolean))) {
      const all = doc.strokes.filter((s) => s.group === gid);
      if (all.every((s) => selection.includes(s))) {
        const g = clone(doc.groups.find((x) => x.id === gid));
        g.id = newId('g'); doc.groups.push(g); gmap.set(gid, g.id);
      }
    }
    const copies = [];
    for (const s of selection) {
      const c = clone(s);
      c.id = newId(); c.rev = nextRev(); c.group = s.group ? gmap.get(s.group) || null : null;
      c.points.forEach((p) => { p.x += off; p.y += off; });
      doc.strokes.splice(doc.strokes.indexOf(s) + 1 + copies.filter((x) => x.src === s).length, 0, c);
      copies.push(c);
    }
    setSelection(copies, copies[copies.length - 1]);
    commit();
  },
  raise() { moveSel(1); },
  lower() { moveSel(-1); },
  del() {
    if (!selection.length) return;
    doc.strokes = doc.strokes.filter((s) => !selection.includes(s));
    pruneGroups();
    setSelection([], null);
    commit();
  },
  join() {
    const open = selection.filter((s) => !isClosed(s) && s.points.length);
    if (open.length < 2) { flashHint('Select two or more open strokes to join.'); return; }
    const base = primary && open.includes(primary) ? primary : open[0];
    let cur = worldOf(base, base.points);
    let rest = open.filter((s) => s !== base);
    const eq = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
    while (rest.length) {
      // nearest endpoint pairing between the chain and any remaining stroke
      let best = null;
      const head = cur[0], tail = cur[cur.length - 1];
      for (const s of rest) {
        const w = worldOf(s, s.points), a = w[0], b = w[w.length - 1];
        for (const [d, at, pts] of [
          [Math.hypot(a.x - tail.x, a.y - tail.y), 'tail', w], [Math.hypot(b.x - tail.x, b.y - tail.y), 'tail', w.slice().reverse()],
          [Math.hypot(b.x - head.x, b.y - head.y), 'head', w], [Math.hypot(a.x - head.x, a.y - head.y), 'head', w.slice().reverse()],
        ]) if (!best || d < best.d) best = { d, at, pts, s };
      }
      if (best.at === 'tail') cur = cur.concat(eq(best.pts[0], tail) ? best.pts.slice(1) : best.pts);
      else cur = (eq(best.pts[best.pts.length - 1], head) ? best.pts.slice(0, -1) : best.pts).concat(cur);
      rest = rest.filter((s) => s !== best.s);
    }
    base.points = toLocalOf(base, cur);
    touch(base);
    removeStrokes(open.filter((s) => s !== base));
    setSelection([base], base);
    commit();
  },
  resetWidths() {
    for (const s of selection) { s.points.forEach((p) => { p.w = 1; }); touch(s); }
    if (selection.length) commit();
  },
  selectAll() {
    setSelection(doc.strokes.filter((s) => editable(s) && s.layer === activeLayer().id), null);
  },
  layerAdd() {
    const L = defaultLayer('Layer ' + (doc.layers.length + 1));
    doc.layers.splice(doc.layers.indexOf(activeLayer()) + 1, 0, L);
    doc.activeLayer = L.id;
    commit(); refreshPanel();
  },
  async layerDel() {
    if (doc.layers.length < 2) { flashHint('A drawing needs at least one layer.'); return; }
    const L = activeLayer();
    const n = doc.strokes.filter((s) => s.layer === L.id).length;
    if (n && !(await ask('Delete layer', `Delete “${L.name}” and its ${n} stroke${n === 1 ? '' : 's'}?`, 'Delete'))) return;
    const i = doc.layers.indexOf(L);
    doc.layers.splice(i, 1);
    doc.strokes = doc.strokes.filter((s) => s.layer !== L.id);
    pruneGroups();
    doc.activeLayer = doc.layers[Math.max(0, i - 1)].id;
    setSelection(selection.filter((s) => s.layer !== L.id), null);
    commit();
  },
  layerUp() { moveLayer(1); },
  layerDown() { moveLayer(-1); },
  layerDup() {
    const L = activeLayer();
    const N = Object.assign(clone(L), { id: newId('L'), name: L.name + ' copy' });
    doc.layers.splice(doc.layers.indexOf(L) + 1, 0, N);
    const copies = freshCopies(doc.strokes.filter((s) => s.layer === L.id), N.id);
    doc.strokes.push(...copies);
    doc.activeLayer = N.id;
    setSelection([], null);
    commit(); refreshPanel(); dirty = true;
  },
  layerMerge() {
    const L = activeLayer(), i = doc.layers.indexOf(L);
    if (i === 0) { flashHint('Nothing below to merge into — this is the bottom layer.'); return; }
    const B = doc.layers[i - 1];
    if (B.locked) { flashHint(`Layer “${B.name}” is locked — unlock it to merge into it.`); return; }
    const styled = (L.blend || 'normal') !== 'normal' || L.opacity < 0.999 || !L.visible;
    const up = doc.strokes.filter((s) => s.layer === L.id);
    doc.strokes = doc.strokes.filter((s) => s.layer !== L.id).concat(up);   // stays above the lower layer's strokes
    for (const s of up) s.layer = B.id;
    doc.layers.splice(i, 1);
    doc.activeLayer = B.id;
    commit(); refreshPanel(); dirty = true;
    flashHint(styled ? `Merged into “${B.name}” — the upper layer's opacity, blend mode or visibility didn't carry over.` : `Merged into “${B.name}”.`);
  },
  layerSolo() {
    const L = activeLayer(), others = doc.layers.filter((x) => x !== L);
    if (!others.length) return;
    if (L.visible && others.every((x) => !x.visible)) for (const x of others) x.visible = true;
    else { for (const x of others) { x.visible = false; dropFromSelection(x.id); } L.visible = true; }
    commit(); dirty = true;
  },
  layerRename() {
    const name = $('#layersList .layer.active .name');
    if (name) name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  },
  copy() {
    const L = activeLayer();
    const src = selection.length ? selection.slice() : doc.strokes.filter((s) => s.layer === L.id);
    if (!src.length) { flashHint('Nothing to copy — select strokes, or copy a layer that has strokes.'); return false; }
    const order = new Map(doc.strokes.map((s, i) => [s, i]));
    src.sort((a, b) => order.get(a) - order.get(b));
    const gids = new Set(src.map((s) => s.group).filter(Boolean));
    clipboard = { strokes: clone(src), groups: clone(doc.groups.filter((g) => gids.has(g.id))) };
    try { localStorage.setItem('recurror.clip', JSON.stringify(clipboard)); } catch { /* storage full or unavailable */ }
    flashHint(`Copied ${src.length} stroke${src.length === 1 ? '' : 's'}${selection.length ? '' : ` (all of “${L.name}”)`} · Ctrl+V pastes into the active layer`);
    return true;
  },
  cut() {
    const L = activeLayer();
    if (L.locked) { flashHint(`Layer “${L.name}” is locked.`); return; }
    const had = selection.length;
    if (!actions.copy()) return;
    if (had) { actions.del(); return; }
    doc.strokes = doc.strokes.filter((s) => s.layer !== L.id);
    pruneGroups(); setSelection([], null); commit(); dirty = true;
  },
  paste() {
    let clip = clipboard;
    if (!clip) { try { clip = JSON.parse(localStorage.getItem('recurror.clip') || 'null'); } catch { clip = null; } }
    if (!clip || !Array.isArray(clip.strokes) || !clip.strokes.length) { flashHint('Clipboard is empty — copy strokes or a layer first (Ctrl+C).'); return; }
    if (!canDrawHere()) return;
    const L = activeLayer();
    const tmp = normaliseDoc({ format: 'recurror-doc', version: 2, width: doc.width, height: doc.height, layers: [{ id: L.id, name: L.name }], activeLayer: L.id, groups: clip.groups || [], strokes: clip.strokes });
    const gmap = new Map();
    for (const g of tmp.groups) { const n = Object.assign(clone(g), { id: newId('g') }); doc.groups.push(n); gmap.set(g.id, n.id); }
    const copies = tmp.strokes.map((s) => Object.assign(s, { id: newId(), rev: nextRev(), layer: L.id, group: s.group ? gmap.get(s.group) || null : null }));
    doc.strokes.push(...copies);
    setSelection(copies, copies[copies.length - 1]);
    commit(); dirty = true;
    flashHint(`Pasted ${copies.length} stroke${copies.length === 1 ? '' : 's'} into “${L.name}”.`);
  },
};

let clipboard = null;

/** Copies of strokes for another layer: new ids, and their groups duplicated so the copies stay independent. */
function freshCopies(src, layerId) {
  const gmap = new Map();
  for (const gid of new Set(src.map((s) => s.group).filter(Boolean))) {
    const g = doc.groups.find((x) => x.id === gid);
    if (!g) continue;
    const n = Object.assign(clone(g), { id: newId('g') });
    doc.groups.push(n); gmap.set(gid, n.id);
  }
  return src.map((s) => Object.assign(clone(s), { id: newId(), rev: nextRev(), layer: layerId, group: s.group ? gmap.get(s.group) || null : null }));
}

// ---------------------------------------------------------------------------
// Paint bucket: flood-fill the rendered drawing, trace the region, store it as a vector fill
// ---------------------------------------------------------------------------
function bucketFill(w) {
  if (!(w.x >= 0 && w.y >= 0 && w.x <= doc.width && w.y <= doc.height)) { flashHint('The bucket fills areas inside the artboard.'); return; }
  const L = activeLayer();
  const hit = hitTest(w.x, w.y, 0);
  if (hit && hit.stroke.bucket) {
    hit.stroke.fill.colA = ui.bucketCol; touch(hit.stroke); commit(); dirty = true;
    return;
  }
  if (hit && hit.body && hit.stroke.style.mode !== 'none') {
    const st = hit.stroke.style;
    st.colA = st.colB = ui.bucketCol; touch(hit.stroke);
    if (selection.includes(hit.stroke)) refreshPanel();
    commit(); dirty = true;
    return;
  }
  const S = Math.min(2, 2400 / Math.max(doc.width, doc.height));
  const W = Math.max(8, Math.round(doc.width * S)), H = Math.max(8, Math.round(doc.height * S));
  const kx = W / doc.width, ky = H / doc.height;
  let px;
  try { px = renderer.renderPixels(doc, W, H); } catch (err) { flashHint('Bucket failed: ' + err.message); return; }
  const f = floodRegion(px, W, H, w.x * kx, w.y * ky, ui.bucketTol, ui.bucketGap * kx, 2);
  if (!f || f.count < 4) { flashHint('Nothing to fill there.'); return; }
  const poly = keyhole(traceRegion(f.mask, W, H, 0.8)).map((p) => ({ x: p.x / kx, y: p.y / ky }));
  if (poly.length < 3) { flashHint('That area is too small to fill.'); return; }
  const sym = clone(tpl.sym);
  if (!ui.bucketSym) sym.mode = 'none';
  const t = {
    shape: { spline: 'linear', closed: true },
    style: Object.assign(clone(tpl.style), { mode: 'none' }),
    fill: Object.assign(clone(tpl.fill), { mode: 'flat', colA: ui.bucketCol, opacity: 1, lit: false }),
    sym, rec: defaultRec(), warp: defaultWarp(),
  };
  const s = makeStroke(poly, t, L.id);
  s.bucket = true;
  // on a line's own body: colour the line itself (its shading and ink stay on top of the new colour);
  // inside a shape's fill: a new fill just above that shape; in an empty area: under all the layer's lines
  let at = -1;
  if (hit && hit.stroke.layer === L.id) at = doc.strokes.indexOf(hit.stroke) + 1;
  else if (ui.bucketUnder) at = doc.strokes.findIndex((x) => x.layer === L.id);
  if (at >= 0 && at < doc.strokes.length) doc.strokes.splice(at, 0, s); else doc.strokes.push(s);
  commit(); dirty = true;
  if (f.touchesEdge) flashHint('Filled — the area reached the artboard edge. If it spilled through a gap, undo and raise Gap.');
}

function pruneGroups() { doc.groups = doc.groups.filter((g) => doc.strokes.some((s) => s.group === g.id)); }

function moveLayer(d) {
  const i = doc.layers.indexOf(activeLayer()), j = i + d;
  if (j < 0 || j >= doc.layers.length) return;
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  commit(); dirty = true;
}

function moveSel(d) {
  if (!selection.length) return;
  const order = doc.strokes.slice();
  const sel = new Set(selection);
  const idx = order.map((s, i) => i).filter((i) => sel.has(order[i]));
  if (d > 0) idx.reverse();
  for (const i of idx) {
    const s = order[i];
    let j = i + d;
    while (j >= 0 && j < order.length && order[j].layer !== s.layer) j += d;
    if (j < 0 || j >= order.length || sel.has(order[j])) continue;
    order.splice(i, 1);
    order.splice(j, 0, s);
  }
  doc.strokes = order;
  commit(); updateSelectionInfo(); dirty = true;
}

function updateStatus() {
  $('#zoom').textContent = Math.round(view.zoom * 100) + '%';
}

// ---------------------------------------------------------------------------
// Demo drawing
// ---------------------------------------------------------------------------
export function buildDemo() {
  const d = newDocument(2048, 2048);
  d.bg = '#0d0e14';
  d.layers[0].name = 'Base';
  const glowL = defaultLayer('Glow');
  glowL.blend = 'screen';
  d.layers.push(glowL);
  d.activeLayer = d.layers[0].id;
  const C = 1024;
  const polar = (r, a, p = 1) => ({ x: C + r * Math.cos(a), y: C + r * Math.sin(a), p });
  const mk = (pts, shape, style, fill, sym, layer = d.layers[0].id, extra = {}) => {
    const t = {
      shape: Object.assign(defaultShape(), shape), style: Object.assign(defaultStyle(), style), fill: Object.assign(defaultFill(), fill),
      sym: Object.assign(defaultSym(2048, 2048), sym), rec: Object.assign(defaultRec(), extra.rec || {}), warp: Object.assign(defaultWarp(), extra.warp || {}),
    };
    d.strokes.push(makeStroke(pts, t, layer));
  };
  // textured dome petals
  mk([polar(150, 0), polar(330, -0.22), polar(520, 0), polar(330, 0.22)], { closed: true },
    { mode: 'bevel', width: 6, colA: '#e2e8f0', colB: '#94a3b8', grad: 'none', taperStart: 0, taperEnd: 0, bevel: 0.6 },
    { mode: 'cells', colA: '#38bdf8', colB: '#0c2a4a', scale: 22, thick: 0.5, lit: true }, { mode: 'kaleido', n: 8, angle: 0 });
  // woven gilded tendrils
  const tend = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; tend.push(polar(90 + t * 760, 0.38 + Math.sin(t * 7) * 0.12, 1 - t * 0.6)); }
  mk(tend, {}, { mode: 'tube', width: 22, colA: '#fde68a', colB: '#b45309', grad: 'along', overlap: 'weave' }, {}, { mode: 'kaleido', n: 8, angle: 0 });
  // twisting ribbon spiral
  mk([polar(260, 1.1), polar(340, 1.5), polar(300, 1.9)], {},
    { mode: 'ribbon', width: 26, colA: '#fda4af', colB: '#6d28d9', grad: 'none', twist: 1.4, taperStart: 0.1, taperEnd: 0.1 },
    {}, { mode: 'spiral', n: 12, ratio: 0.955, steps: 60, angle: 0 });
  // engraved ring
  mk([polar(620, 0), polar(640, 0.4), polar(620, 0.785)], {},
    { mode: 'engrave', width: 34, colA: '#e7e5e4', colB: '#a8a29e', grad: 'none', lines: 8, taperStart: 0.15, taperEnd: 0.15 },
    {}, { mode: 'rotate', n: 8 });
  // neon halo on the screen-blended layer
  mk([polar(900, 0.02), polar(930, 0.157), polar(900, 0.29)], {},
    { mode: 'neon', width: 16, colA: '#22d3ee', colB: '#e879f9', grad: 'along', taperStart: 0, taperEnd: 0, glow: 1.1 },
    {}, { mode: 'rotate', n: 20 }, glowL.id);
  return d;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function onKeyDown(e) {
  const tag = (e.target && e.target.tagName) || '';
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(e.target.type)) || tag === 'TEXTAREA';
  if (typing) return;
  if (!$('#modal').hidden) { if (e.key === 'Escape') $('#modal').click(); return; }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? actions.redo() : actions.undo(); }
    else if (k === 'y') { e.preventDefault(); actions.redo(); }
    else if (k === 's') { e.preventDefault(); actions.save(); }
    else if (k === 'o') { e.preventDefault(); actions.open(); }
    else if (k === 'e') { e.preventDefault(); actions.export(); }
    else if (k === 'd') { e.preventDefault(); actions.dup(); }
    else if (k === 'a') { e.preventDefault(); actions.selectAll(); }
    else if (k === 'g') { e.preventDefault(); e.shiftKey ? actions.ungroup() : actions.group(); }
    else if (k === 'j') { e.preventDefault(); actions.join(); }
    else if (k === 'c') { e.preventDefault(); actions.copy(); }
    else if (k === 'x') { e.preventDefault(); actions.cut(); }
    else if (k === 'v') { e.preventDefault(); actions.paste(); }
    return;
  }
  if (tag === 'SELECT') return;
  switch (e.key) {
    case ' ': if (!spaceDown) { spaceDown = true; updateCursorClass(); dirty = true; } e.preventDefault(); break;
    case 'Escape': if (penPoints.length) cancelPen(); else if (selection.length) setSelection([], null); break;
    case 'Enter': if ((ui.tool === 'pen' || ui.tool === 'draw') && penPoints.length) finishPen(false); break;
    case 'Delete': case 'Backspace':
      if ((ui.tool === 'pen' || ui.tool === 'draw') && penPoints.length) { penPoints.pop(); updatePenPreview(); }
      else actions.del();
      e.preventDefault(); break;
    case 'PageUp': actions.raise(); e.preventDefault(); break;
    case 'PageDown': actions.lower(); e.preventDefault(); break;
    case '[': case ']': {
      const f = e.key === ']' ? 1.18 : 1 / 1.18;
      setValue('style.width', Math.max(0.5, Math.min(200, +(tpl.style.width * f).toFixed(1))));
      refreshPanel(); if (selection.length) commit();
      break;
    }
    default:
      if (k === 'b') setTool('draw');
      else if (k === 'p') setTool('pen');
      else if (k === 'v' || k === 'e') setTool('edit');
      else if (k === 'w') setTool('width');
      else if (k === 'c') setTool('center');
      else if (k === 'h') setTool('pan');
      else if (k === 'k') setTool('bucket');
      else if (k === 'f') fitView();
      else if (k === 'g') { ui.showGuides = !ui.showGuides; refreshPanel(); dirty = true; }
      else if (k === 's') { ui.snap = !ui.snap; if (!ui.snap) snapShow = null; refreshPanel(); dirty = true; }
  }
}

function onKeyUp(e) { if (e.key === ' ') { spaceDown = false; updateCursorClass(); dirty = true; } }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  $('#ver').textContent = 'v' + VERSION;
  ovCanvas.tabIndex = 0;
  bindPanel();
  for (const b of $$('[data-act]')) b.addEventListener('click', () => actions[b.dataset.act] && actions[b.dataset.act]());
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = normaliseDoc(JSON.parse(await f.text()));
      tpl.sym.cx = d.width / 2; tpl.sym.cy = d.height / 2;
      loadDoc(d);
    } catch (err) { notify('Could not open file', err.message); }
  });

  ovCanvas.addEventListener('pointerdown', onPointerDown);
  ovCanvas.addEventListener('pointermove', onPointerMove);
  ovCanvas.addEventListener('pointerup', onPointerUp);
  ovCanvas.addEventListener('pointercancel', onPointerUp);
  ovCanvas.addEventListener('pointerleave', () => { if (!drag) { cursor = null; snapShow = null; if (ui.tool === 'pen') updatePenPreview(); dirty = true; } });
  ovCanvas.addEventListener('dblclick', onDblClick);
  ovCanvas.addEventListener('wheel', onWheel, { passive: false });
  ovCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { spaceDown = false; updateCursorClass(); });

  panelTabs = initPanelTabs($('#panel'));
  new ResizeObserver(() => resize()).observe(stage);
  resize();
  fitView();
  history.reset(doc);
  refreshPanel();
  updateUndo();
  setTool('draw');
  if (renderer) {
    glCanvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    glCanvas.addEventListener('webglcontextrestored', () => { try { renderer = new Renderer(glCanvas); dirty = true; } catch (err) { console.error(err); } });
  }
  requestAnimationFrame(frame);

  // test / automation hook
  window.recurror = {
    get doc() { return doc; }, set doc(d) { loadDoc(d); }, tpl, ui, view, actions, setTool, VERSION, normaliseDoc, bucketAt: (x, y) => bucketFill({ x, y }),
    get selection() { return selection; }, select: (ids) => setSelection(doc.strokes.filter((s) => ids.includes(s.id)), null),
    get stats() { return renderer && renderer.stats; },
    redraw: () => { dirty = true; draw(); },
  };
}

boot();
