// Recurror — WebGL1 renderer: layers → offscreen accumulation → screen / export.
import {
  strokeVS, strokeFS, fillVS, fillFS, quadVS, compFS, blitFS,
  STROKE_MODES, ADDITIVE_MODES, GRAD_MODES, FILL_MODES, BLEND_MODES,
} from './shaders.js';
import { buildStrokeMesh, buildFillMesh, isClosed, STROKE_STRIDE, FILL_STRIDE, dropSamples, getSamples, boundCircle, sampleRev } from './geometry.js';
import { allTransformsCached, mobApply, mobScaleAt, isAffine } from './symmetry.js';
import { warpActive, warpIndex } from './warp.js';
import { solveWeave } from './weave.js';
import { chainsCached } from './chains.js';

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
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const uni = {}, att = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(p, i); uni[info.name] = gl.getUniformLocation(p, info.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); att[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, uni, att };
}

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
    this.meshes = new Map();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
    this.enabledAttribs = new Set();
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
    return { w, h, ds, A: this.makeTarget(w, h, ds), B: null, L: null };
  }

  ensureExtra(T) {
    if (!T.B) T.B = this.makeTarget(T.w, T.h, T.ds);
    if (!T.L) T.L = this.makeTarget(T.w, T.h, T.ds);
  }

  freeTargets(T) {
    if (!T) return;
    const gl = this.gl;
    for (const k of ['A', 'B', 'L']) if (T[k]) { gl.deleteFramebuffer(T[k].fbo); gl.deleteTexture(T[k].tex); }
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

  setAttribs(list) {
    const gl = this.gl;
    const want = new Set(list.filter((l) => l !== undefined && l >= 0));
    for (const loc of this.enabledAttribs) if (!want.has(loc)) gl.disableVertexAttribArray(loc);
    for (const loc of want) if (!this.enabledAttribs.has(loc)) gl.enableVertexAttribArray(loc);
    this.enabledAttribs = want;
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
      if (direct) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.A.fbo);
        scissor();
        for (const s of list) this.drawStroke(doc, s, o);
      } else {
        this.ensureExtra(T);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.L.fbo);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        scissor();
        for (const s of list) this.drawStroke(doc, s, o);
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

  /** Per-copy transform uniforms. */
  setMob(P, mob) {
    const gl = this.gl;
    gl.uniform4f(P.uni.u_mA, mob.a[0], mob.a[1], mob.b[0], mob.b[1]);
    gl.uniform4f(P.uni.u_mB, mob.c[0], mob.c[1], mob.d[0], mob.d[1]);
    gl.uniform1f(P.uni.u_mConj, mob.conj ? 1 : 0);
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
      out.push(t);
    }
    this.stats.copiesDrawn += out.length;
    return out;
  }

  drawStroke(doc, s, o) {
    const gl = this.gl;
    if (!s.points.length) return;
    const ch = this.chains ? this.chains.get(s.id) || null : null;
    const m = this.mesh(s, ch);
    const xsAll = allTransformsCached(s.sym, s.rec, doc.width, doc.height);
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
    const f = s.fill;
    if (m.fill && f && f.mode !== 'none' && f.opacity > 0) {
      const P = this.progFill;
      const fm = m.fill;
      const looks = levelLooks(f.colA, f.colB, f.opacity, rec, levels);
      gl.useProgram(P.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.fillVbo);
      const B = FILL_STRIDE * 4;
      this.setAttribs([P.att.a_pos, P.att.a_nrm, P.att.a_side]);
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
      this.setWarp(P, s);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0xff);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      let curL = -1;
      for (const t of xs) {
        const lk = looks[t.level] || looks[0];
        if (lk.o <= 0.002) continue;
        if (t.level !== curL) {
          curL = t.level;
          gl.uniform3f(P.uni.u_colA, lk.a[0], lk.a[1], lk.a[2]);
          gl.uniform3f(P.uni.u_colB, lk.b[0], lk.b[1], lk.b[2]);
          gl.uniform1f(P.uni.u_opacity, lk.o);
        }
        this.setMob(P, t.mob);
        const bent = warped || !isAffine(t.mob);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.uniform1f(P.uni.u_fringe, 0);
        gl.drawArrays(gl.TRIANGLES, 0, fm.fanCount);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.uniform1f(P.uni.u_fringe, 1);
        gl.drawArrays(gl.TRIANGLES, fm.fringeFirst, fm.fringeCount);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
        gl.uniform1f(P.uni.u_fringe, 0);
        if (bent) gl.drawArrays(gl.TRIANGLES, fm.gridFirst, fm.gridCount);
        else gl.drawArrays(gl.TRIANGLES, fm.quadFirst, fm.quadCount);
      }
      gl.disable(gl.STENCIL_TEST);
    }

    // ---- stroke ----
    const st = s.style;
    if (!m.count || st.mode === 'none' || st.opacity <= 0) return;
    const P = this.progStroke;
    gl.useProgram(P.p);
    const mode = STROKE_MODES[st.mode] ?? 0;
    const additive = ADDITIVE_MODES.has(mode);
    const ordered = !additive && mode !== STROKE_MODES.airbrush && st.overlap !== 'blend';
    const weaving = ordered && st.overlap === 'weave';
    if (weaving) this.weave(s, m, xsAll);

    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    const A = P.att, B = STROKE_STRIDE * 4;
    this.setAttribs([A.a_pos, A.a_ext, A.a_vc, A.a_tan, A.a_hw, A.a_along].concat(weaving ? [A.a_weave] : []));
    gl.vertexAttribPointer(A.a_pos, 2, gl.FLOAT, false, B, 0);
    gl.vertexAttribPointer(A.a_ext, 2, gl.FLOAT, false, B, 8);
    gl.vertexAttribPointer(A.a_vc, 2, gl.FLOAT, false, B, 16);
    gl.vertexAttribPointer(A.a_tan, 2, gl.FLOAT, false, B, 24);
    gl.vertexAttribPointer(A.a_hw, 1, gl.FLOAT, false, B, 32);
    gl.vertexAttribPointer(A.a_along, 2, gl.FLOAT, false, B, 36);
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

    const sign = weaving ? 1 : (st.overlap === 'earlier' ? -1 : 1);
    const nL = levels + 1, slice = 1.998 / nL;
    const zFor = (L) => {
      if (layering === 'mixed') return [0, 0.999 * sign];
      const zc = layering === 'above' ? 0.999 - slice * (L + 0.5) : -0.999 + slice * (L + 0.5);
      return [zc, slice * 0.45 * sign];
    };
    const drawCopies = () => {
      let curL = -1;
      for (const t of xs) {
        const lk = looks[t.level] || looks[0];
        if (lk.o <= 0.002) continue;
        if (t.level !== curL) {
          curL = t.level;
          const z = zFor(t.level);
          gl.uniform1f(P.uni.u_zOff, z[0]);
          gl.uniform1f(P.uni.u_zScale, z[1]);
          gl.uniform3f(P.uni.u_colA, lk.a[0], lk.a[1], lk.a[2]);
          gl.uniform3f(P.uni.u_colB, lk.b[0], lk.b[1], lk.b[2]);
          gl.uniform1f(P.uni.u_opacity, lk.o);
        }
        this.setMob(P, t.mob);
        gl.drawArrays(gl.TRIANGLES, 0, m.count);
      }
    };

    if (!ordered) {
      gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(P.uni.u_pass, 0);
      drawCopies();
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

  // ---- export -----------------------------------------------------------
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
