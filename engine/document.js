// Recurror — document model, defaults, migration, history, serialisation.
import { defaultSym, defaultRec, WALLPAPER, FRIEZE } from './symmetry.js';
import { defaultWarp } from './warp.js';

export const FORMAT = 'recurror-doc';
export const LEGACY_FORMATS = ['strophe-doc'];
export const FORMAT_VERSION = 2;

let revCounter = 1;
export const nextRev = () => ++revCounter;
let idCounter = 1;
export const newId = (p = 's') => p + Date.now().toString(36) + (idCounter++).toString(36);

export function defaultStyle() {
  return {
    mode: 'tube', width: 18, colA: '#f2c46d', colB: '#c2410c', grad: 'along', gradPeriod: 160,
    opacity: 1, pressure: 0.7, taperStart: 0.12, taperEnd: 0.25, cap: 'round',
    twist: 0.35, lines: 7, bevel: 0.45, glow: 1, overlap: 'later', weaveFlip: false,
    // brush shape (any mode)
    nibAngle: 45, nibRatio: 1, jitter: 0, jitterScale: 60, wobble: 0, wobbleScale: 120,
    dash: 'none', dashLen: 30, dashGap: 18,
    // mode-specific
    strands: 3, rough: 0.5, outline: 0.3, stitchSpacing: 14, stitchSlant: 0.6,
    // graphite shading + ink outline (any mode)
    shadeEnds: 0, shadeUnder: 1, shadeLen: 1.5, shadeWhich: 'both', shadeEdge: 0, shadeSide: 0, shadeGrain: 0.35, shadeCol: '#262626',
    ink: 0, inkCol: '#000000',
    // realistic media: ink pooling, paper tooth, bristle brush, stamp brush
    pool: 0, tooth: 0.5,
    spread: 0, wetEdge: 0.6, bloom: 0.5, granulate: 0.5,      // wet watercolour (spread 0 = dry, fixed look)
    hairs: 18, dryness: 0.45, hairSpread: 0.5, hairBlend: 0.6,
    stampTip: 'round', stampImg: null, stampSpacing: 0.25, stampScatter: 0.3, stampRot: 0.5, stampSizeJit: 0.3, stampFlow: 0.6,
  };
}
export function defaultFill() {
  return { mode: 'none', colA: '#1e3a5f', colB: '#7dd3fc', opacity: 1, angle: 90, scale: 24, thick: 0.4, lit: false };
}
export function defaultShape() { return { spline: 'catmull', closed: false }; }
export function defaultLight() { return { az: 135, el: 40, ambient: 0.28, spec: 0.55, shine: 28, follow: false }; }
export function defaultLayer(name = 'Layer 1') { return { id: newId('L'), name, visible: true, locked: false, opacity: 1, blend: 'normal' }; }

export function newDocument(w = 2048, h = 2048) {
  const L = defaultLayer();
  return { format: FORMAT, version: FORMAT_VERSION, width: w, height: h, bg: '#0e0f13', light: defaultLight(), layers: [L], activeLayer: L.id, groups: [], blendEnds: true,
    paperType: 'none', paperScale: 6, paperStrength: 0.6, assets: {},
    gridOn: false, gridType: 'square', gridSize: 64, gridSub: 4, gridSpokes: 24, strokes: [] };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

export function makeStroke(points, tpl, layer) {
  return {
    id: newId(), rev: nextRev(), layer, group: null,
    points: points.map((p) => ({ x: +p.x, y: +p.y, p: p.p ?? 1, w: p.w ?? 1, ...(p.s > 0 ? { s: +p.s } : {}) })),
    shape: clone(tpl.shape), style: clone(tpl.style), fill: clone(tpl.fill),
    sym: clone(tpl.sym), rec: clone(tpl.rec || defaultRec()), warp: clone(tpl.warp || defaultWarp()),
  };
}

export function touch(stroke) { stroke.rev = nextRev(); }

function num(v, d) { const n = +v; return Number.isFinite(n) ? n : d; }

/** v1 'tile' mode → wallpaper p1 / pmm. */
function migrateSym(sym, w, h) {
  const s = Object.assign(defaultSym(w, h), sym || {});
  if (s.mode === 'tile') { s.mode = 'wallpaper'; s.wp = sym.tileMirror ? 'pmm' : 'p1'; s.cellAngle = 90; }
  if (!WALLPAPER[s.wp]) s.wp = 'p6m';
  if (!FRIEZE[s.fr]) s.fr = 'p2mm';
  delete s.tileMirror;
  return s;
}

/** Fill in missing fields so older / hand-edited files load safely. */
export function normaliseDoc(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.strokes)) throw new Error('Not a Recurror document');
  const w = Math.max(64, Math.min(8192, num(raw.width, 2048)));
  const h = Math.max(64, Math.min(8192, num(raw.height, 2048)));
  const doc = newDocument(w, h);
  if (typeof raw.bg === 'string') doc.bg = raw.bg;
  doc.light = Object.assign(defaultLight(), raw.light || {});
  doc.blendEnds = raw.blendEnds !== false;
  if (['none', 'cold', 'hot', 'sketch', 'canvas'].includes(raw.paperType)) doc.paperType = raw.paperType;
  doc.paperScale = Math.max(0.5, Math.min(200, num(raw.paperScale, 6)));
  doc.paperStrength = Math.max(0, Math.min(1, num(raw.paperStrength, 0.6)));
  doc.gridOn = !!raw.gridOn;
  if (['square', 'dots', 'iso', 'polar'].includes(raw.gridType)) doc.gridType = raw.gridType;
  doc.gridSize = Math.max(2, Math.min(2048, num(raw.gridSize, 64)));
  doc.gridSub = Math.max(1, Math.min(16, Math.round(num(raw.gridSub, 4))));
  doc.gridSpokes = Math.max(4, Math.min(96, Math.round(num(raw.gridSpokes, 24))));
  // reference image: placement and look (the picture itself, ref.src, is kept outside the undo
  // history by the app and only written into saved files)
  if (raw.ref && typeof raw.ref === 'object') {
    const r = raw.ref;
    doc.ref = {
      visible: r.visible !== false, above: !!r.above,
      opacity: Math.max(0, Math.min(1, num(r.opacity, 0.5))),
      fx: num(r.fx, 0.5), fy: num(r.fy, 0.5), scale: Math.max(0.02, Math.min(20, num(r.scale, 1))),
      rot: Math.max(-180, Math.min(180, num(r.rot, 0))), aspect: Math.max(1e-3, num(r.aspect, 1)),
    };
    if (typeof r.src === 'string' && r.src.startsWith('data:image/')) doc.ref.src = r.src;
  }
  doc.assets = {};
  if (raw.assets && typeof raw.assets === 'object') for (const [k, v] of Object.entries(raw.assets)) if (typeof v === 'string' && v.startsWith('data:image/')) doc.assets[k] = v;
  if (Array.isArray(raw.layers) && raw.layers.length) {
    doc.layers = raw.layers.map((l, i) => Object.assign(defaultLayer('Layer ' + (i + 1)), l, { id: typeof l.id === 'string' ? l.id : newId('L') }));
  }
  const layerIds = new Set(doc.layers.map((l) => l.id));
  doc.activeLayer = layerIds.has(raw.activeLayer) ? raw.activeLayer : doc.layers[doc.layers.length - 1].id;
  doc.groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => g && typeof g.id === 'string').map((g) => ({
    id: g.id, sym: migrateSym(g.sym, w, h), rec: Object.assign(defaultRec(), g.rec || {}), warp: Object.assign(defaultWarp(), g.warp || {}),
  })) : [];
  const groupIds = new Set(doc.groups.map((g) => g.id));
  for (const s of raw.strokes) {
    if (!s || !Array.isArray(s.points) || !s.points.length) continue;
    doc.strokes.push({
      id: typeof s.id === 'string' ? s.id : newId(),
      rev: nextRev(),
      layer: layerIds.has(s.layer) ? s.layer : doc.layers[0].id,
      group: groupIds.has(s.group) ? s.group : null,
      points: s.points.map((p) => ({
        x: num(p.x, 0), y: num(p.y, 0), p: Math.max(0, Math.min(1, num(p.p, 1))), w: Math.max(0, Math.min(16, num(p.w, 1))),
        ...(num(p.s, 0) > 0 ? { s: Math.min(1, num(p.s, 0)) } : {}),
      })),
      shape: Object.assign(defaultShape(), s.shape || {}),
      style: Object.assign(defaultStyle(), s.style || {}),
      fill: Object.assign(defaultFill(), s.fill || {}),
      sym: migrateSym(s.sym, w, h),
      rec: Object.assign(defaultRec(), s.rec || {}),
      warp: Object.assign(defaultWarp(), s.warp || {}),
      ...(s.bucket ? { bucket: true } : {}),
      ...(s.cropAt && Number.isFinite(+s.cropAt.x) && Number.isFinite(+s.cropAt.y) ? { cropAt: { x: +s.cropAt.x, y: +s.cropAt.y } } : {}),
    });
  }
  const seen = new Set();
  for (const s of doc.strokes) { if (seen.has(s.id)) s.id = newId(); seen.add(s.id); }
  // members mirror their group's shared settings
  for (const g of doc.groups) syncGroup(doc, g);
  doc.groups = doc.groups.filter((g) => doc.strokes.some((s) => s.group === g.id));
  return doc;
}

export function groupOf(doc, s) { return s && s.group ? doc.groups.find((g) => g.id === s.group) || null : null; }

export function syncGroup(doc, g) {
  for (const s of doc.strokes) if (s.group === g.id) {
    s.sym = clone(g.sym); s.rec = clone(g.rec); s.warp = clone(g.warp); touch(s);
  }
}

/** Document as JSON. opts.refSrc: also write the reference picture (saved files, not undo history). */
export function serialise(doc, opts = {}) {
  return JSON.stringify({
    format: FORMAT, version: FORMAT_VERSION, width: doc.width, height: doc.height, bg: doc.bg, light: doc.light,
    layers: doc.layers, activeLayer: doc.activeLayer, groups: doc.groups, blendEnds: doc.blendEnds !== false,
    paperType: doc.paperType || 'none', paperScale: doc.paperScale ?? 6, paperStrength: doc.paperStrength ?? 0.6,
    gridOn: !!doc.gridOn, gridType: doc.gridType || 'square', gridSize: doc.gridSize ?? 64, gridSub: doc.gridSub ?? 4, gridSpokes: doc.gridSpokes ?? 24,
    ...(doc.ref ? { ref: Object.assign({}, doc.ref, opts.refSrc ? { src: opts.refSrc } : {}, opts.refSrc ? {} : { src: undefined }) } : {}),
    // only the pictures a stroke still uses
    assets: Object.fromEntries(Object.entries(doc.assets || {}).filter(([k]) => doc.strokes.some((s) => s.style.stampImg === k))),
    strokes: doc.strokes.map((s) => ({
      id: s.id, layer: s.layer, group: s.group || null,
      points: s.points.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), p: +p.p.toFixed(3), w: +(p.w ?? 1).toFixed(3), ...(p.s > 0 ? { s: +p.s.toFixed(2) } : {}) })),
      shape: s.shape, style: s.style, fill: s.fill, sym: s.sym, rec: s.rec, warp: s.warp,
      ...(s.bucket ? { bucket: true } : {}),
      ...(s.cropAt ? { cropAt: s.cropAt } : {}),
    })),
  });
}

export class History {
  constructor(limit = 120) { this.stack = []; this.index = -1; this.limit = limit; }
  reset(doc) { this.stack = [serialise(doc)]; this.index = 0; }
  push(doc) {
    const snap = serialise(doc);
    if (this.stack[this.index] === snap) return false;
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }
  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.stack.length - 1; }
  undo() { if (!this.canUndo()) return null; this.index--; return normaliseDoc(JSON.parse(this.stack[this.index])); }
  redo() { if (!this.canRedo()) return null; this.index++; return normaliseDoc(JSON.parse(this.stack[this.index])); }
}
