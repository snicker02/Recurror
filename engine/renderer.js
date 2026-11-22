// Recurror — WebGL1 renderer: layers → offscreen accumulation → screen / export.
import {
  strokeVS, strokeFS, fillVS, fillFS, quadVS, compFS, blitFS, paperVS, paperFS, wetBlurFS, wetFS,
  STROKE_MODES, ADDITIVE_MODES, SOFT_MODES, DASH_MODES, GRAD_MODES, FILL_MODES, BLEND_MODES,
} from './shaders.js';
import { buildStrokeMesh, buildFillMesh, isClosed, STROKE_STRIDE, FILL_STRIDE, dropSamples, getSamples, boundCircle, sampleRev } from './geometry.js';
import { allTransformsCached, transformsFor, mobApply, mobScaleAt, isAffine, setCopyLimit, cropDomain, symKey } from './symmetry.js';
import { warpActive, warpIndex } from './warp.js';
import { solveWeave, solveKnot } from './weave.js';
import { chainsCached } from './chains.js';
import { seedOf } from './noise.js';

export function hexToRgb(hex) {
  const h = String(hex || '#000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

/** Rotate the hue of an RGB triple (0..1) by deg degrees. */
export function hueRotate(rgb, deg) {
  if (!deg) return rgb;
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return rgb;
  const d = mx - mn;
  const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h / 6 + deg / 360) % 1 + 1) % 1;
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

function levelLooks(colA, colB, opacity, rec, levels) {
  const a = hexToRgb(colA), b = hexToRgb(colB), out = [];
  const on = rec && rec.mode !== 'off';
  for (let L = 0; L <= levels; L++) {
    const hue = on ? (+rec.hue || 0) * L : 0;
    const fade = on ? Math.pow(Math.max(0, Math.min(1, +rec.fade)), L) : 1;
    out.push({ a: hueRotate(a, hue), b: hueRotate(b, hue), o: opacity * fade });
  }
  return out;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');      // attribute 0 is always a real per-vertex array
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const uni = {}, att = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(p, i); uni[info.name] = gl.getUniformLocation(p, info.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); att[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, uni, att };
}

const PAPER_TYPES = { none: 0, cold: 1, hot: 2, sketch: 3, canvas: 4 };
function paperUniform(doc) {
  return [PAPER_TYPES[doc.paperType] || 0, Math.max(0.5, +doc.paperScale || 6), Math.max(0, Math.min(1, +(doc.paperStrength ?? 0.6)))];
}

/** Inverse of an affine view matrix (column-major 3×3). */
function invView(m) {
  const a = m[0], b = m[1], c = m[3], d = m[4], tx = m[6], ty = m[7];
  const det = a * d - b * c;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return new Float32Array([ia, ib, 0, ic, id, 0, -(ia * tx + ic * ty), -(ib * tx + id * ty), 1]);
}

/** Strokes drawn with depth-ordered overlaps (the ones a knot weaves). */
function isOrderedStyle(st) {
  const mode = STROKE_MODES[st.mode] ?? 0;
  return st.mode !== 'none' && st.opacity > 0 && !ADDITIVE_MODES.has(mode) && !SOFT_MODES.has(mode) && st.overlap !== 'blend';
}
function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/** A watercolour stroke whose wash spreads (painted wet, then simulated). */
const isWet = (s) => s.style.mode === 'watercolor' && (+s.style.spread || 0) > 0;

// ?noinst in the page URL forces the per-copy fallback path (used by the tests)
function o_noInstancing() { try { return /[?&]noinst\b/.test(location.search); } catch { return false; } }

const INST_STRIDE = 10;  // a.re a.im b.re b.im | c.re c.im d.re d.im | conj | draw-order index

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: false, stencil: false, depth: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.progStroke = program(gl, strokeVS, strokeFS);
    this.progFill = program(gl, fillVS, fillFS);
    this.progComp = program(gl, quadVS, compFS);
    this.progBlit = program(gl, quadVS, blitFS);
    this.progPaper = program(gl, paperVS, paperFS);
    this.progWetBlur = program(gl, quadVS, wetBlurFS);
    this.progWet = program(gl, quadVS, wetFS);
    // 1×1 placeholder bound when a stamp brush has no picture tip
    this.blankTip = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blankTip);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.tips = new Map();          // asset id → { tex } (picture tips for stamp brushes)
    this.onAsset = null;            // called when a picture tip finishes loading (the app redraws)
    this.meshes = new Map();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
    this.enabledAttribs = new Set();
    this.divisors = new Map();
    // one draw call per recursion level instead of one per copy; WebGL1 extension, near-universal
    this.inst = o_noInstancing() ? null : gl.getExtension('ANGLE_instanced_arrays');
    this.instBuf = gl.createBuffer();
    this.instData = new Float32Array(9 * 1024);
    setCopyLimit(this.inst ? 50000 : 4000);
    this.screenT = null;
    this.stats = { copiesDrawn: 0, copiesCulled: 0 };
  }

  // ---- render targets ---------------------------------------------------
  makeTarget(w, h, ds) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('Framebuffer incomplete (' + w + '×' + h + ')');
    return { tex, fbo };
  }

  makeTargets(w, h) {
    const gl = this.gl;
    const ds = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, w, h);
    return { w, h, ds, A: this.makeTarget(w, h, ds), B: null, L: null, W1: null, W2: null, W3: null };
  }

  ensureExtra(T) {
    if (!T.B) T.B = this.makeTarget(T.w, T.h, T.ds);
    if (!T.L) T.L = this.makeTarget(T.w, T.h, T.ds);
  }

  ensureWet(T) {
    for (const k of ['W1', 'W2', 'W3']) if (!T[k]) T[k] = this.makeTarget(T.w, T.h, T.ds);
  }

  freeTargets(T) {
    if (!T) return;
    const gl = this.gl;
    for (const k of ['A', 'B', 'L', 'W1', 'W2', 'W3']) if (T[k]) { gl.deleteFramebuffer(T[k].fbo); gl.deleteTexture(T[k].tex); }
    gl.deleteRenderbuffer(T.ds);
  }

  // ---- mesh cache -------------------------------------------------------
  mesh(stroke, ch = null) {
    const gl = this.gl;
    const fq = (q) => (q ? q.x.toFixed(3) + ',' + q.y.toFixed(3) : '-');
    const jk = ch ? `${ch.joinS ? 1 : 0}${ch.joinE ? 1 : 0}|${fq(ch.ts)}|${fq(ch.te)}` : '';
    let m = this.meshes.get(stroke.id);
    const srev = sampleRev(stroke);
    if (m && m.rev === srev && m.jk === jk) return m;
    if (!m) { m = { vbo: gl.createBuffer(), fillVbo: gl.createBuffer(), weaveVbo: gl.createBuffer(), weaveKey: '' }; this.meshes.set(stroke.id, m); }
    const sm = buildStrokeMesh(stroke, ch ? { s: ch.joinS, e: ch.joinE, ts: ch.ts, te: ch.te } : null);
    m.jk = jk;
    m.total = sm.total;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, sm.data, gl.STATIC_DRAW);
    m.data = sm.data;
    m.count = sm.count;
    m.maxHw = sm.maxHw;
    m.fill = null;
    m.weaveKey = '';
    if (isClosed(stroke)) {
      const fm = buildFillMesh(stroke);
      if (fm) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.fillVbo);
        gl.bufferData(gl.ARRAY_BUFFER, fm.data, gl.STATIC_DRAW);
        m.fill = fm;
      }
    }
    m.bound = boundCircle(stroke);
    m.rev = srev;
    return m;
  }

  /** A layer's strokes in order, or, for a knot layer, woven together: fills first, then the
   *  strands in three shared-depth passes (depth, interiors, edges), then anything not woven. */
  drawLayerStrokes(doc, layer, list, o) {
    const gl = this.gl;
    if (!layer.knot) { for (const s of list) this.drawStroke(doc, s, o); return; }
    const strands = list.filter((s) => isOrderedStyle(s.style));
    if (!strands.length) { for (const s of list) this.drawStroke(doc, s, o); return; }
    const knot = this.knotFor(doc, layer, strands);
    for (const s of list) this.drawStroke(doc, s, { ...o, only: 'fill' });
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    for (const pass of [1, 2, 3]) for (const s of strands) this.drawStroke(doc, s, { ...o, only: 'stroke', knot, knotPass: pass });
    for (const s of list) if (!isOrderedStyle(s.style)) this.drawStroke(doc, s, { ...o, only: 'stroke' });
  }

  /** Upload a knot strand's heights (from the layer-wide solution) as the weave attribute. */
  knotHeights(stroke, m, knot) {
    const key = 'knot|' + knot.key;
    if (m.weaveKey === key) return;
    const W = knot.sol.get(stroke.id);
    const h = new Float32Array(m.count);
    for (let i = 0; i < m.count; i++) h[i] = W.heightAt(m.data[i * STROKE_STRIDE + 10]);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.weaveVbo);
    gl.bufferData(gl.ARRAY_BUFFER, h, gl.STATIC_DRAW);
    m.weaveKey = key;
    m.weaveInfo = { crossings: W.crossings, nodes: W.nodes.length, alternations: 0, kept: 0 };
  }

  /** Solve (or reuse) the weave of a knot layer's strands. */
  knotFor(doc, layer, strands) {
    if (!this.knotCache) this.knotCache = new Map();
    const parts = [];
    const input = strands.map((s) => {
      const ch = this.chains ? this.chains.get(s.id) || null : null;
      const m = this.mesh(s, ch);
      const cropD = this.cropFor(doc, s);
      const xs = transformsFor(s.sym, s.rec, doc.width, doc.height, cropD ? { x: cropD.c[0], y: cropD.c[1] } : m.bound);
      parts.push(s.id + ':' + sampleRev(s) + ':' + xs.key + ':' + (s.style.weaveFlip ? 1 : 0) + ':' + m.maxHw.toFixed(3));
      return { id: s.id, samples: getSamples(s), closed: isClosed(s), xs, maxHw: m.maxHw, flip: !!s.style.weaveFlip };
    });
    const key = parts.join('|');
    const hit = this.knotCache.get(layer.id);
    if (hit && hit.full === key) return hit;
    const v = { full: key, key: layer.id + '#' + hashStr(key), sol: solveKnot(input) };
    this.knotCache.set(layer.id, v);
    return v;
  }

  weave(stroke, m, xs) {
    const st = stroke.style;
    const key = xs.key + '|' + (st.weaveFlip ? 1 : 0);
    if (m.weaveKey === key) return m.weaveInfo;
    const W = solveWeave(getSamples(stroke), isClosed(stroke), xs, m.maxHw, !!st.weaveFlip);
    const h = new Float32Array(m.count);
    for (let i = 0; i < m.count; i++) h[i] = W.heightAt(m.data[i * STROKE_STRIDE + 10]);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.weaveVbo);
    gl.bufferData(gl.ARRAY_BUFFER, h, gl.STATIC_DRAW);
    m.weaveKey = key;
    m.weaveInfo = { crossings: W.crossings, nodes: W.nodes.length, alternations: W.alternations, kept: W.alternationsKept };
    return m.weaveInfo;
  }

  prune(liveIds) {
    for (const [id, m] of this.meshes) {
      if (!liveIds.has(id)) {
        this.gl.deleteBuffer(m.vbo); this.gl.deleteBuffer(m.fillVbo); this.gl.deleteBuffer(m.weaveVbo);
        this.meshes.delete(id);
        dropSamples(id);
      }
    }
  }

  /** Enable exactly these attribute arrays; `instanced` ones advance per instance, the rest per vertex. */
  setAttribs(list, instanced = []) {
    const gl = this.gl;
    const ok = (l) => l !== undefined && l >= 0;
    const inst = new Set(instanced.filter(ok));
    const want = new Set(list.filter(ok).concat([...inst]));
    for (const loc of this.enabledAttribs) if (!want.has(loc)) gl.disableVertexAttribArray(loc);
    for (const loc of want) if (!this.enabledAttribs.has(loc)) gl.enableVertexAttribArray(loc);
    this.enabledAttribs = want;
    if (this.inst) {
      for (const loc of want) {
        const d = inst.has(loc) ? 1 : 0;
        if ((this.divisors.get(loc) || 0) !== d) { this.inst.vertexAttribDivisorANGLE(loc, d); this.divisors.set(loc, d); }
      }
    }
  }

  lightVec(doc) {
    const L = doc.light;
    const az = L.az * Math.PI / 180, el = L.el * Math.PI / 180;
    return [Math.cos(az) * Math.cos(el), -Math.sin(az) * Math.cos(el), Math.sin(el)];
  }

  // ---- frame ------------------------------------------------------------
  /**
   * @param o {viewMat, pxWorld, width, height, artRect:[x,y,w,h]|null, outside:[r,g,b,a],
   *           transparent, extra:[{stroke, layer}], target:'screen'|T, prune}
   * @returns the target set used (its A holds the final image)
   */
  render(doc, o) {
    const gl = this.gl;
    let T = o.target && o.target !== 'screen' ? o.target : null;
    if (!T) {
      if (!this.screenT || this.screenT.w !== o.width || this.screenT.h !== o.height) {
        this.freeTargets(this.screenT);
        this.screenT = this.makeTargets(o.width, o.height);
      }
      T = this.screenT;
    }
    this.stats = { copiesDrawn: 0, copiesCulled: 0 };
    this.chains = chainsCached(doc);
    if (doc.blendEnds === false) this.chains = null;
    gl.viewport(0, 0, T.w, T.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
    const scissor = () => {
      if (o.artRect) { gl.enable(gl.SCISSOR_TEST); gl.scissor(o.artRect[0], o.artRect[1], o.artRect[2], o.artRect[3]); }
      else gl.disable(gl.SCISSOR_TEST);
    };

    // accumulation starts as the background
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.A.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true); gl.depthMask(true); gl.stencilMask(0xff);
    if (o.transparent) gl.clearColor(0, 0, 0, 0);
    else { const bg = hexToRgb(doc.bg); gl.clearColor(bg[0], bg[1], bg[2], 1); }
    gl.clearDepth(1); gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.paperU = paperUniform(doc);
    if (!o.transparent && this.paperU[0] > 0) this.drawPaper(o, scissor);

    const live = new Set();
    for (const s of doc.strokes) live.add(s.id);
    const extra = o.extra || [];
    for (const e of extra) live.add(e.stroke.id);

    gl.enable(gl.BLEND);
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const list = doc.strokes.filter((s) => s.layer === layer.id && !s.hidden);
      for (const e of extra) if (e.layer === layer.id) list.push(e.stroke);
      if (!list.length) continue;
      const direct = (layer.blend || 'normal') === 'normal' && layer.opacity >= 0.999;
      // wet watercolour washes are painted and spread first, under the layer's other strokes
      const wet = list.filter(isWet);
      const dry = wet.length ? list.filter((s) => !isWet(s)) : list;
      const wetTex = wet.length ? this.paintWet(doc, wet, o, T, scissor) : null;
      if (direct) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.A.fbo);
        scissor();
        if (wetTex) this.blitOver(wetTex);
        this.drawLayerStrokes(doc, layer, dry, o);
      } else {
        this.ensureExtra(T);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.L.fbo);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        scissor();
        if (wetTex) this.blitOver(wetTex);
        this.drawLayerStrokes(doc, layer, dry, o);
        // composite L over A → B, then swap
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.B.fbo);
        scissor();
        const P = this.progComp;
        gl.useProgram(P.p);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.L.tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.A.tex);
        gl.uniform1i(P.uni.u_src, 0); gl.uniform1i(P.uni.u_dst, 1);
        gl.uniform1f(P.uni.u_opacity, Math.max(0, Math.min(1, layer.opacity)));
        gl.uniform1f(P.uni.u_blend, BLEND_MODES[layer.blend] ?? 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        this.setAttribs([P.att.a_pos]);
        gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.enable(gl.BLEND);
        const t = T.A; T.A = T.B; T.B = t;
      }
    }
    if (o.prune !== false) this.prune(live);

    if (!o.target || o.target === 'screen') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, o.width, o.height);
      gl.disable(gl.SCISSOR_TEST);
      const out = o.outside || [0, 0, 0, 0];
      gl.clearColor(out[0] * out[3], out[1] * out[3], out[2] * out[3], out[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      scissor();
      const P = this.progBlit;
      gl.useProgram(P.p);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.A.tex);
      gl.uniform1i(P.uni.u_src, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      this.setAttribs([P.att.a_pos]);
      gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.enable(gl.BLEND);
    }
    gl.disable(gl.SCISSOR_TEST);
    return T;
  }

  /** Upload the copies' Möbius coefficients (instanced path). */
  uploadInstances(list) {
    if (!this.inst) return;
    const n = list.length * INST_STRIDE;
    if (this.instData.length < n) this.instData = new Float32Array(Math.max(n, this.instData.length * 2));
    const d = this.instData;
    let o = 0;
    const inv = 1 / Math.max(1, list.length);
    list.forEach((t, i) => {
      const m = t.mob;
      d[o++] = m.a[0]; d[o++] = m.a[1]; d[o++] = m.b[0]; d[o++] = m.b[1];
      d[o++] = m.c[0]; d[o++] = m.c[1]; d[o++] = m.d[0]; d[o++] = m.d[1];
      d[o++] = m.conj ? 1 : 0;
      d[o++] = (i + 0.5) * inv;
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n), gl.DYNAMIC_DRAW);
  }

  /** Point the instance attributes at copy `first` of the uploaded list. */
  pointInstances(P, first) {
    const gl = this.gl, B = INST_STRIDE * 4, off = first * B;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.vertexAttribPointer(P.att.i_mA, 4, gl.FLOAT, false, B, off);
    gl.vertexAttribPointer(P.att.i_mB, 4, gl.FLOAT, false, B, off + 16);
    gl.vertexAttribPointer(P.att.i_conj, 1, gl.FLOAT, false, B, off + 32);
    if (P.att.i_idx !== undefined) gl.vertexAttribPointer(P.att.i_idx, 1, gl.FLOAT, false, B, off + 36);
  }

  /** Fallback path: one copy's coefficients as constant attribute values. */
  constInstance(P, mob, idx = 0) {
    const gl = this.gl;
    if (P.att.i_idx !== undefined) gl.vertexAttrib1f(P.att.i_idx, idx);
    gl.vertexAttrib4f(P.att.i_mA, mob.a[0], mob.a[1], mob.b[0], mob.b[1]);
    gl.vertexAttrib4f(P.att.i_mB, mob.c[0], mob.c[1], mob.d[0], mob.d[1]);
    gl.vertexAttrib1f(P.att.i_conj, mob.conj ? 1 : 0);
  }

  /**
   * Draw `count` vertices from `first` for each copy in list[a..b), which all share one level.
   * Instanced: one call (instance buffer already uploaded for `list`). Fallback: one call per copy.
   */
  drawRange(P, list, a, b, first, count) {
    if (b <= a) return;
    const gl = this.gl;
    if (this.inst) {
      this.pointInstances(P, a);
      this.inst.drawArraysInstancedANGLE(gl.TRIANGLES, first, count, b - a);
    } else {
      const inv = 1 / Math.max(1, list.length);
      for (let i = a; i < b; i++) { this.constInstance(P, list[i].mob, (i + 0.5) * inv); gl.drawArrays(gl.TRIANGLES, first, count); }
    }
  }

  cropFor(doc, s) {
    if (!s.sym || !s.sym.crop) return null;
    if (!this.cropCache) this.cropCache = new Map();
    const key = s.rev + '|' + symKey(s.sym, doc.width, doc.height) + '|' + s.sym.hR + '|' + (s.cropAt ? s.cropAt.x + ',' + s.cropAt.y : '');
    const hit = this.cropCache.get(s.id);
    if (hit && hit.key === key) return hit.D;
    const D = cropDomain(s.sym, getSamples(s), doc.width, doc.height, s.cropAt || null);
    if (this.cropCache.size > 2000) this.cropCache.clear();
    this.cropCache.set(s.id, { key, D });
    return D;
  }

  /** Paint a layer's wet washes into W1 and spread them (W1 → blur W2 → W3 → result W2). */
  paintWet(doc, wet, o, T, scissor) {
    const gl = this.gl;
    this.ensureWet(T);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.W1.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    scissor();
    for (const s of wet) this.drawStroke(doc, s, o);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
    let spread = 0, edge = 0, bloom = 0, gran = 0;
    for (const s of wet) {
      spread = Math.max(spread, +s.style.spread || 0);
      edge = Math.max(edge, +(s.style.wetEdge ?? 0.6));
      bloom = Math.max(bloom, +(s.style.bloom ?? 0.5));
      gran = Math.max(gran, +(s.style.granulate ?? 0.5));
    }
    const R = Math.max(1, spread / o.pxWorld);                 // the spread in pixels at this zoom
    const quad = (P) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      this.setAttribs([P.att.a_pos]);
      gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const PB = this.progWetBlur;
    gl.useProgram(PB.p);
    gl.uniform1i(PB.uni.u_src, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.W2.fbo);
    gl.bindTexture(gl.TEXTURE_2D, T.W1.tex);
    gl.uniform2f(PB.uni.u_step, R / 6 / T.w, 0);
    quad(PB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.W3.fbo);
    gl.bindTexture(gl.TEXTURE_2D, T.W2.tex);
    gl.uniform2f(PB.uni.u_step, 0, R / 6 / T.h);
    quad(PB);
    const P = this.progWet;
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.W2.fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.W1.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.W3.tex);
    gl.uniform1i(P.uni.u_src, 0); gl.uniform1i(P.uni.u_blur, 1);
    gl.uniformMatrix3fv(P.uni.u_invView, false, invView(o.viewMat));
    const pu = this.paperU || [0, 6, 0.6];
    gl.uniform3f(P.uni.u_paper, pu[0], pu[1], pu[2]);
    gl.uniform4f(P.uni.u_wet, edge, bloom, gran, spread);
    quad(P);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.enable(gl.BLEND);
    return T.W2.tex;
  }

  /** Draw a premultiplied texture over the bound target. */
  blitOver(tex) {
    const gl = this.gl, P = this.progBlit;
    gl.useProgram(P.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.uni.u_src, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    this.setAttribs([P.att.a_pos]);
    gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Multiply the paper's relief onto the background (artboard only). */
  drawPaper(o, scissor) {
    const gl = this.gl, P = this.progPaper;
    const inv = invView(o.viewMat);
    gl.useProgram(P.p);
    gl.uniformMatrix3fv(P.uni.u_invView, false, inv);
    gl.uniform3f(P.uni.u_paper, this.paperU[0], this.paperU[1], this.paperU[2]);
    gl.uniform1f(P.uni.u_pxw, o.pxWorld);
    scissor();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    this.setAttribs([P.att.a_pos]);
    gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Texture for a stamp brush's picture tip (alpha = the tip), loaded once from the document's assets. */
  tipTexture(doc, id) {
    if (!id || !doc.assets || !doc.assets[id]) return null;
    const hit = this.tips.get(id);
    if (hit) return hit.tex;
    const entry = { tex: null };
    this.tips.set(id, entry);
    const img = new Image();
    img.onload = () => {
      const gl = this.gl, N = 128;
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, N, N);
      const px = cx.getImageData(0, 0, N, N).data;
      // a picture with transparency uses its alpha; an opaque one uses its darkness
      let opaque = true;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { opaque = false; break; }
      const out = new Uint8Array(N * N * 4);
      for (let i = 0; i < N * N; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], al = px[i * 4 + 3];
        const v = opaque ? 255 - (0.299 * r + 0.587 * g + 0.114 * b) : al;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = v;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      entry.tex = tex;
      if (this.onAsset) this.onAsset();
    };
    img.src = doc.assets[id];
    return null;
  }

  /** Crop-to-cell uniforms (engine/symmetry.js cropDomain), cached per stroke revision and symmetry. */
  setCrop(P, doc, s) {
    const gl = this.gl;
    if (P.uni.u_clipMode === undefined) return;
    const D = this.cropFor(doc, s);
    if (!D) { gl.uniform1f(P.uni.u_clipMode, 0); return; }
    gl.uniform1f(P.uni.u_clipMode, D.mode);
    gl.uniform1f(P.uni.u_clipN, D.n);
    if (D.mode === 3) {
      gl.uniform2f(P.uni.u_clipO, D.origin[0], D.origin[1]);
      gl.uniformMatrix2fv(P.uni.u_clipBi, false, new Float32Array(D.inv));
      gl.uniform3f(P.uni.u_clipH0, D.h0[0], D.h0[1], D.h0[2]);
      gl.uniform3f(P.uni.u_clipH1, D.h1[0], D.h1[1], D.h1[2]);
    }
    gl.uniform2f(P.uni.u_clipC, D.c[0], D.c[1]);
    gl.uniform1f(P.uni.u_clipW0, D.w0);
    gl.uniform3fv(P.uni['u_clipP[0]'], D.sites);
  }

  setWarp(P, s) {
    const gl = this.gl;
    const w = s.warp;
    if (warpActive(w)) {
      gl.uniform1f(P.uni.u_warp, warpIndex(w.type));
      gl.uniform4f(P.uni.u_warpP, +s.sym.cx, +s.sym.cy, Math.max(1, +w.scale), Math.max(0, Math.min(1, +w.amount)));
      gl.uniform1f(P.uni.u_warpK, +w.strength);
    } else gl.uniform1f(P.uni.u_warp, 0);
  }

  /** Copies worth drawing: drop sub-pixel, exploded or far-off-canvas images. */
  visibleCopies(doc, s, m, xs, o) {
    const b = m.bound;
    const W = doc.width, H = doc.height, diag = Math.hypot(W, H);
    const warped = warpActive(s.warp);
    const out = [];
    for (const t of xs) {
      const k = mobScaleAt(t.mob, b.x, b.y);
      const rr = b.r * k;
      if (rr < o.pxWorld * 0.8 || !(k < 1e4)) { this.stats.copiesCulled++; continue; }
      if (!warped) {
        const c = mobApply(t.mob, b.x, b.y);
        if (c.x + rr < -diag * 0.05 || c.y + rr < -diag * 0.05 || c.x - rr > W + diag * 0.05 || c.y - rr > H + diag * 0.05) {
          if (isAffine(t.mob) || rr < diag * 4) { this.stats.copiesCulled++; continue; }
        }
      }
      const c = mobApply(t.mob, b.x, b.y);
      out.push({ mob: t.mob, level: t.level, cx: c.x, cy: c.y, r: rr * (isAffine(t.mob) ? 1.02 : 1.35) * (warped ? 1.8 : 1) });
    }
    this.stats.copiesDrawn += out.length;
    return out;
  }

  drawStroke(doc, s, o) {
    const gl = this.gl;
    if (!s.points.length) return;
    const ch = this.chains ? this.chains.get(s.id) || null : null;
    const m = this.mesh(s, ch);
    // a cropped stroke shows only its cell, so the copies are placed around that cell
    const cropD = this.cropFor(doc, s);
    const xsAll = transformsFor(s.sym, s.rec, doc.width, doc.height, cropD ? { x: cropD.c[0], y: cropD.c[1] } : m.bound);
    const levels = xsAll.levels || 0;
    const rec = s.rec;
    const layering = rec && rec.mode !== 'off' && levels > 0 ? rec.layer : 'mixed';
    let xs = this.visibleCopies(doc, s, m, xsAll, o);
    if (layering === 'below') xs = xs.slice().reverse();
    if (!xs.length) return;
    const light = this.lightVec(doc);
    const follow = doc.light.follow ? 1 : 0;
    const warped = warpActive(s.warp);

    // ---- fill: stencil even-odd, AA fringe outside, cover inside ----
    // Even-odd stencilling needs each copy on its own, so copies are drawn in batches whose image
    // circles don't overlap: one instanced call per batch and pass, still one copy's parity per pixel.
    const f = s.fill;
    if (o.only !== 'stroke' && m.fill && f && f.mode !== 'none' && f.opacity > 0) {
      const P = this.progFill;
      const fm = m.fill;
      const looks = levelLooks(f.colA, f.colB, f.opacity, rec, levels);
      const { order, batches } = this.fillBatches(xs, looks);
      gl.useProgram(P.p);
      this.uploadInstances(order);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.fillVbo);
      const B = FILL_STRIDE * 4;
      const instLocs = this.inst ? [P.att.i_mA, P.att.i_mB, P.att.i_conj] : [];
      this.setAttribs([P.att.a_pos, P.att.a_nrm, P.att.a_side], instLocs);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.fillVbo);
      gl.vertexAttribPointer(P.att.a_pos, 2, gl.FLOAT, false, B, 0);
      gl.vertexAttribPointer(P.att.a_nrm, 2, gl.FLOAT, false, B, 8);
      gl.vertexAttribPointer(P.att.a_side, 1, gl.FLOAT, false, B, 16);
      gl.uniformMatrix3fv(P.uni.u_view, false, o.viewMat);
      gl.uniform1f(P.uni.u_pxWorld, o.pxWorld);
      gl.uniform1f(P.uni.u_fmode, FILL_MODES[f.mode] ?? 1);
      gl.uniform1f(P.uni.u_angle, (f.angle || 0) * Math.PI / 180);
      gl.uniform4f(P.uni.u_bbox, fm.bbox[0], fm.bbox[1], fm.bbox[2], fm.bbox[3]);
      gl.uniform2f(P.uni.u_center, fm.center[0], fm.center[1]);
      gl.uniform1f(P.uni.u_radius, fm.radius);
      gl.uniform1f(P.uni.u_fscale, Math.max(0.5, +f.scale || 24));
      gl.uniform1f(P.uni.u_fthick, Math.max(0, Math.min(1, +f.thick)));
      gl.uniform1f(P.uni.u_flit, f.lit ? 1 : 0);
      gl.uniform3f(P.uni.u_light, light[0], light[1], light[2]);
      gl.uniform1f(P.uni.u_ambient, doc.light.ambient);
      gl.uniform1f(P.uni.u_spec, doc.light.spec);
      gl.uniform1f(P.uni.u_shine, doc.light.shine);
      gl.uniform1f(P.uni.u_lightFollow, follow);
      { const pu = this.paperU || [0, 6, 0.6]; gl.uniform3f(P.uni.u_paper, pu[0], pu[1], pu[2]); }
      this.setWarp(P, s);
      this.setCrop(P, doc, s);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0xff);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const bt of batches) {
        const lk = looks[bt.level] || looks[0];
        gl.uniform3f(P.uni.u_colA, lk.a[0], lk.a[1], lk.a[2]);
        gl.uniform3f(P.uni.u_colB, lk.b[0], lk.b[1], lk.b[2]);
        gl.uniform1f(P.uni.u_opacity, lk.o);
        const bent = warped || bt.bent;
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.uniform1f(P.uni.u_fringe, 0);
        this.drawRange(P, order, bt.a, bt.b, 0, fm.fanCount);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.uniform1f(P.uni.u_fringe, 1);
        this.drawRange(P, order, bt.a, bt.b, fm.fringeFirst, fm.fringeCount);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
        gl.uniform1f(P.uni.u_fringe, 0);
        if (bent) this.drawRange(P, order, bt.a, bt.b, fm.gridFirst, fm.gridCount);
        else this.drawRange(P, order, bt.a, bt.b, fm.quadFirst, fm.quadCount);
      }
      gl.disable(gl.STENCIL_TEST);
    }

    // ---- stroke ----
    const st = s.style;
    if (o.only === 'fill' || !m.count || st.mode === 'none' || st.opacity <= 0) return;
    const P = this.progStroke;
    gl.useProgram(P.p);
    const mode = STROKE_MODES[st.mode] ?? 0;
    const additive = ADDITIVE_MODES.has(mode);
    const soft = SOFT_MODES.has(mode) && st.overlap !== 'blend';
    const ordered = !additive && !SOFT_MODES.has(mode) && st.overlap !== 'blend';
    gl.uniform1f(P.uni.u_softZ, soft ? 1 : 0);
    // knot layer: every strand of the layer is woven with every other (heights from solveKnot)
    const knotted = ordered && o.knot && o.knot.sol.has(s.id);
    const weaving = knotted || (ordered && st.overlap === 'weave');
    if (knotted) this.knotHeights(s, m, o.knot);
    else if (weaving) this.weave(s, m, xsAll);

    this.uploadInstances(xs);
    const A = P.att, B = STROKE_STRIDE * 4;
    this.setAttribs([A.a_pos, A.a_ext, A.a_vc, A.a_tan, A.a_hw, A.a_along, A.a_ink].concat(weaving ? [A.a_weave] : []),
      this.inst ? [A.i_mA, A.i_mB, A.i_conj, A.i_idx] : []);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.vertexAttribPointer(A.a_pos, 2, gl.FLOAT, false, B, 0);
    gl.vertexAttribPointer(A.a_ext, 2, gl.FLOAT, false, B, 8);
    gl.vertexAttribPointer(A.a_vc, 2, gl.FLOAT, false, B, 16);
    gl.vertexAttribPointer(A.a_tan, 2, gl.FLOAT, false, B, 24);
    gl.vertexAttribPointer(A.a_hw, 1, gl.FLOAT, false, B, 32);
    gl.vertexAttribPointer(A.a_along, 2, gl.FLOAT, false, B, 36);
    gl.vertexAttribPointer(A.a_ink, 2, gl.FLOAT, false, B, 44);
    if (A.a_weave !== undefined && A.a_weave >= 0) {
      if (weaving) { gl.bindBuffer(gl.ARRAY_BUFFER, m.weaveVbo); gl.vertexAttribPointer(A.a_weave, 1, gl.FLOAT, false, 0, 0); }
      else gl.vertexAttrib1f(A.a_weave, 0);
    }
    const looks = levelLooks(st.colA, st.colB, st.opacity, rec, levels);
    gl.uniformMatrix3fv(P.uni.u_view, false, o.viewMat);
    gl.uniform1f(P.uni.u_pxWorld, o.pxWorld);
    gl.uniform1f(P.uni.u_mode, mode);
    gl.uniform1f(P.uni.u_grad, GRAD_MODES[st.grad] ?? 0);
    // a line that closes on itself (closed stroke, or a ring of touching strokes) must repeat
    // seamlessly: whole number of bands and of ribbon turns around it; along-gradient is mirrored
    const loop = isClosed(s) || !!(ch && ch.loop);
    const loopLen = Math.max(1e-3, ch ? ch.total : (m.total || 1));
    let period = Math.max(1, st.gradPeriod || 120), twist = +st.twist || 0;
    if (loop) {
      period = loopLen / Math.max(1, Math.round(loopLen / period));
      if (twist > 0) twist = Math.max(1, Math.round(twist * loopLen / 100)) * 100 / loopLen;
    }
    gl.uniform1f(P.uni.u_gradPeriod, period);
    // brush pattern: dashes / dots and stitch spacing also fit a whole number of repeats around a loop
    const fit = (len) => (loop ? loopLen / Math.max(1, Math.round(loopLen / Math.max(1e-3, len))) : len);
    const dashMode = DASH_MODES[st.dash] ?? 0;
    const dl = Math.max(0.5, +st.dashLen || 30), dg = Math.max(0, +st.dashGap || 0);
    const dk = dashMode ? fit(dl + dg) / (dl + dg) : 1;
    gl.uniform3f(P.uni.u_dash, dashMode, dl * dk, dg * dk);
    gl.uniform1f(P.uni.u_strands, Math.max(1, Math.min(8, Math.round(+st.strands || 3))));
    gl.uniform1f(P.uni.u_rough, Math.max(0, Math.min(1, +(st.rough ?? 0.5))));
    gl.uniform1f(P.uni.u_outline, Math.max(0.05, Math.min(0.95, +(st.outline ?? 0.3))));
    gl.uniform2f(P.uni.u_stitch, fit(Math.max(1, +st.stitchSpacing || 14)), +(st.stitchSlant ?? 0.6));
    gl.uniform1f(P.uni.u_seed, (seedOf(s.id || 'x') % 997) * 0.731);
    gl.uniform1f(P.uni.u_baseHw, Math.max(0.25, (+st.width || 18) * 0.5));
    {
      const pu = this.paperU || [0, 6, 0.6];
      gl.uniform3f(P.uni.u_paper, pu[0], pu[1], pu[2]);
      const TOOTH = { sketch: 1, drybrush: 1, bristle: 1, stamp: 1, watercolor: 1, airbrush: 0.8 };
      gl.uniform1f(P.uni.u_tooth, Math.max(0, Math.min(1.5, (st.tooth ?? 0.5) * 2 * (TOOTH[st.mode] ?? 0.3))));
      gl.uniform1f(P.uni.u_pool, Math.max(0, Math.min(1, +st.pool || 0)));
      gl.uniform4f(P.uni.u_bristle, Math.max(2, Math.min(64, Math.round(+st.hairs || 18))), +(st.dryness ?? 0.45), +(st.hairSpread ?? 0.5), +(st.hairBlend ?? 0.6));
      gl.uniform4f(P.uni.u_stamp, Math.max(0.03, +(st.stampSpacing ?? 0.25)), Math.max(0, +(st.stampScatter ?? 0.3)), +(st.stampRot ?? 0.5), +(st.stampSizeJit ?? 0.3));
      const TIPS = { round: 0, flat: 1, chalk: 2, sponge: 3, splatter: 4, image: 5 };
      let tip = TIPS[st.stampTip] ?? 0;
      const tex = tip === 5 ? this.tipTexture(doc, st.stampImg) : null;
      if (tip === 5 && !tex) tip = 0;
      gl.uniform3f(P.uni.u_stamp2, tip, Math.max(0.02, Math.min(1, +(st.stampFlow ?? 0.6))), tex ? 1 : 0);
      gl.uniform1f(P.uni.u_stampPad, st.mode === 'stamp' ? 1 + Math.max(0, +st.stampScatter || 0) + Math.max(0, +st.stampSizeJit || 0) * 0.5 : 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex || this.blankTip);
      gl.uniform1i(P.uni.u_tip, 2);
      gl.activeTexture(gl.TEXTURE0);
    }
    {
      const sc = hexToRgb(st.shadeCol || '#262626'), ic = hexToRgb(st.inkCol || '#000000'), which = st.shadeWhich || 'both';
      gl.uniform4f(P.uni.u_shade, +st.shadeEnds || 0, Math.max(0.5, (+st.shadeLen || 1.5) * (+st.width || 18)), +st.shadeEdge || 0, +(st.shadeGrain ?? 0.35));
      gl.uniform3f(P.uni.u_shade2, which !== 'end' ? 1 : 0, which !== 'start' ? 1 : 0, +st.shadeSide || 0);
      gl.uniform3f(P.uni.u_shadeCol, sc[0], sc[1], sc[2]);
      gl.uniform1f(P.uni.u_ink, Math.max(0, +st.ink || 0));
      gl.uniform3f(P.uni.u_inkCol, ic[0], ic[1], ic[2]);
    }
    gl.uniform1f(P.uni.u_loop, loop ? 1 : 0);
    gl.uniform3f(P.uni.u_light, light[0], light[1], light[2]);
    gl.uniform1f(P.uni.u_ambient, doc.light.ambient);
    gl.uniform1f(P.uni.u_spec, doc.light.spec);
    gl.uniform1f(P.uni.u_shine, doc.light.shine);
    gl.uniform1f(P.uni.u_twist, twist);
    gl.uniform1f(P.uni.u_lines, st.lines);
    gl.uniform1f(P.uni.u_bevel, st.bevel);
    gl.uniform1f(P.uni.u_glow, st.glow);
    gl.uniform1f(P.uni.u_lightFollow, follow);
    gl.uniform1f(P.uni.u_weaveOn, weaving ? 1 : 0);
    const own = Math.max(1e-3, m.total || 1);
    if (ch) {
      gl.uniform4f(P.uni.u_chain, ch.off, own, Math.max(own, ch.total), ch.rev ? 1 : 0);
      gl.uniform2f(P.uni.u_join, ch.joinS ? 1 : 0, ch.joinE ? 1 : 0);
    } else {
      gl.uniform4f(P.uni.u_chain, 0, own, own, 0);
      gl.uniform2f(P.uni.u_join, 0, 0);
    }
    this.setWarp(P, s);
    this.setCrop(P, doc, s);

    const sign = weaving ? 1 : (st.overlap === 'earlier' ? -1 : 1);
    const nL = levels + 1, slice = 1.998 / nL;
    const zFor = (L) => {
      if (layering === 'mixed') return [0, 0.999 * sign];
      const zc = layering === 'above' ? 0.999 - slice * (L + 0.5) : -0.999 + slice * (L + 0.5);
      return [zc, slice * 0.45 * sign];
    };
    // runs of copies sharing a recursion level → one (instanced) call each
    const runs = [];
    for (let i = 0; i < xs.length;) {
      let j = i + 1;
      while (j < xs.length && xs[j].level === xs[i].level) j++;
      runs.push([i, j, xs[i].level]);
      i = j;
    }
    const drawCopies = () => {
      for (const [a, b, L] of runs) {
        const lk = looks[L] || looks[0];
        if (lk.o <= 0.002) continue;
        const z = zFor(L);
        gl.uniform1f(P.uni.u_zOff, z[0]);
        gl.uniform1f(P.uni.u_zScale, z[1]);
        gl.uniform3f(P.uni.u_colA, lk.a[0], lk.a[1], lk.a[2]);
        gl.uniform3f(P.uni.u_colB, lk.b[0], lk.b[1], lk.b[2]);
        gl.uniform1f(P.uni.u_opacity, lk.o);
        this.drawRange(P, xs, a, b, 0, m.count);
      }
    };

    if (soft) {
      // translucent wash: each copy paints a pixel once (its own depth; equal depth fails LESS), copies
      // still layer over earlier copies. Interiors first, then AA edges, so an edge never blocks an interior.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.uniform1f(P.uni.u_pass, 1);
      drawCopies();
      gl.depthMask(false);
      gl.uniform1f(P.uni.u_pass, 2);
      drawCopies();
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
    } else if (!ordered) {
      gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(P.uni.u_pass, 0);
      drawCopies();
    } else if (knotted) {
      // one pass of the layer-wide knot: depth is shared by all its strands, cleared once per layer
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      if (o.knotPass === 1) {
        gl.depthMask(true);
        gl.uniform1f(P.uni.u_pass, 1);
        gl.colorMask(false, false, false, false);
        drawCopies();
        gl.colorMask(true, true, true, true);
      } else {
        gl.depthMask(false);
        gl.uniform1f(P.uni.u_pass, o.knotPass === 2 ? 1 : 2);
        drawCopies();
        gl.depthMask(true);
      }
      gl.disable(gl.DEPTH_TEST);
    } else {
      // depth prepass on fully covered pixels → interiors that won → AA fringes on top
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.uniform1f(P.uni.u_pass, 1);
      gl.colorMask(false, false, false, false);
      drawCopies();
      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      drawCopies();
      gl.uniform1f(P.uni.u_pass, 2);
      drawCopies();
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Order copies into fill batches: each batch shares a level and its copies' image circles are
   * pairwise disjoint, so per-copy even-odd stencilling survives a single instanced draw.
   */
  fillBatches(list, looks) {
    const order = [], batches = [];
    if (!this.inst) {
      list.forEach((t, i) => { if ((looks[t.level] || looks[0]).o > 0.002) { order.push(t); batches.push({ a: order.length - 1, b: order.length, level: t.level, bent: !isAffine(t.mob) }); } });
      return { order, batches };
    }
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && list[j].level === list[i].level) j++;
      const L = list[i].level;
      if ((looks[L] || looks[0]).o > 0.002) {
        const run = list.slice(i, j);
        const rs = run.map((t) => t.r).sort((p, q) => p - q);
        const cell = Math.max(1e-3, rs[rs.length >> 1] * 2);
        const groups = [];                       // {items, grid}
        for (const t of run) {
          const x0 = Math.floor((t.cx - t.r) / cell), x1 = Math.floor((t.cx + t.r) / cell);
          const y0 = Math.floor((t.cy - t.r) / cell), y1 = Math.floor((t.cy + t.r) / cell);
          const big = (x1 - x0 + 1) * (y1 - y0 + 1) > 64;
          let home = null;
          for (let g = 0; g < groups.length && g < 24 && !home; g++) {
            const G = groups[g];
            let clash = false;
            if (big) clash = G.items.some((u) => Math.hypot(u.cx - t.cx, u.cy - t.cy) < u.r + t.r);
            else {
              for (let y = y0; y <= y1 && !clash; y++) for (let x = x0; x <= x1 && !clash; x++) {
                const l = G.grid.get(x + ',' + y);
                if (l) for (const u of l) if (Math.hypot(u.cx - t.cx, u.cy - t.cy) < u.r + t.r) { clash = true; break; }
              }
              if (!clash) for (const u of G.bigs) if (Math.hypot(u.cx - t.cx, u.cy - t.cy) < u.r + t.r) { clash = true; break; }
            }
            if (!clash) home = G;
          }
          if (!home) { home = { items: [], grid: new Map(), bigs: [] }; groups.push(home); }
          home.items.push(t);
          if (big) home.bigs.push(t);
          else for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const k = x + ',' + y; let l = home.grid.get(k); if (!l) home.grid.set(k, l = []); l.push(t);
          }
        }
        for (const G of groups) {
          const a = order.length;
          for (const t of G.items) order.push(t);
          batches.push({ a, b: order.length, level: L, bent: G.items.some((t) => !isAffine(t.mob)) });
        }
      }
      i = j;
    }
    return { order, batches };
  }

  // ---- export -----------------------------------------------------------
  /** Raw RGBA of the whole artboard at W×H, rows top-down (paint bucket sampling). */
  renderPixels(doc, W, H) {
    const gl = this.gl;
    const T = this.makeTargets(W, H);
    try {
      const vm = new Float32Array([2 / doc.width, 0, 0, 0, 2 / doc.height, 0, -1, -1, 1]);
      const used = this.render(doc, { viewMat: vm, pxWorld: doc.width / W, width: W, height: H, artRect: null, transparent: false, target: T, prune: false });
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, used.A.fbo);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return px;
    } finally {
      this.freeTargets(T);
    }
  }

  exportCanvas(doc, scale, transparent) {
    const gl = this.gl;
    const fancy = doc.layers.some((l) => l.visible && ((l.blend || 'normal') !== 'normal' || l.opacity < 0.999));
    const limit = Math.min(this.maxDim, fancy ? 6144 : 8192);
    let w = Math.round(doc.width * scale), h = Math.round(doc.height * scale);
    if (Math.max(w, h) > limit) { const k = limit / Math.max(w, h); w = Math.floor(w * k); h = Math.floor(h * k); }
    const ss = Math.max(w, h) * 2 <= limit ? 2 : 1;
    const W = w * ss, H = h * ss;
    const T = this.makeTargets(W, H);
    let px;
    try {
      // y flipped so readPixels rows come out top-down
      const vm = new Float32Array([2 / doc.width, 0, 0, 0, 2 / doc.height, 0, -1, -1, 1]);
      const used = this.render(doc, { viewMat: vm, pxWorld: doc.width / W, width: W, height: H, artRect: null, transparent, target: T, prune: false });
      px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, used.A.fbo);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } finally {
      this.freeTargets(T);
    }
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a > 0 && a < 255) {
        const k = 255 / a;
        px[i] = Math.min(255, Math.round(px[i] * k));
        px[i + 1] = Math.min(255, Math.round(px[i + 1] * k));
        px[i + 2] = Math.min(255, Math.round(px[i + 2] * k));
      }
    }
    const big = document.createElement('canvas');
    big.width = W; big.height = H;
    big.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), W, H), 0, 0);
    if (ss === 1) return big;
    const outc = document.createElement('canvas');
    outc.width = w; outc.height = h;
    const c2 = outc.getContext('2d');
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(big, 0, 0, w, h);
    return outc;
  }
}
