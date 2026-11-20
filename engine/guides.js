// Recurror — symmetry guides as world-space geometry (post-warp). Shared by the overlay and snapping.
import { latticeBasis, WALLPAPER, hyperbolicFrame, symTransforms, mobApply, inversionCircles, childCentres } from './symmetry.js';
import { warpPoint, warpActive } from './warp.js';

const seg = (a, b, n) => { const out = []; for (let i = 0; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }); return out; };

/**
 * @returns {{lines: Array<{pts, kind}>, points: Array<{x, y, kind}>}}
 * kinds: mirror · ray · cell · circle · geo (hyperbolic edges) · centre · anchor · node
 */
export function buildGuides(sym, rec, warp, W, H) {
  const lines = [], points = [];
  if (!sym) return { lines, points };
  const cx = +sym.cx, cy = +sym.cy, c = { x: cx, y: cy };
  const diag = Math.hypot(W, H);
  const ang = (+sym.angle || 0) * Math.PI / 180;
  const n = Math.max(1, Math.round(sym.n));
  const dir = (a) => ({ x: Math.cos(a), y: -Math.sin(a) });
  const full = (a, kind) => { const d = dir(a); lines.push({ pts: seg({ x: cx - d.x * diag, y: cy - d.y * diag }, { x: cx + d.x * diag, y: cy + d.y * diag }, 96), kind }); };
  const ray = (a, kind) => { const d = dir(a); lines.push({ pts: seg(c, { x: cx + d.x * diag, y: cy + d.y * diag }, 64), kind }); };
  points.push({ x: cx, y: cy, kind: 'centre' });

  switch (sym.mode) {
    case 'mirror': full(ang, 'mirror'); break;
    case 'rotate': for (let k = 0; k < n; k++) ray(ang + 2 * Math.PI * k / n, 'ray'); break;
    case 'kaleido': for (let k = 0; k < n; k++) full(ang + Math.PI * k / n, 'mirror'); break;
    case 'spiral': {
      for (let k = 0; k < n; k++) ray(ang + 2 * Math.PI * k / n, 'ray');
      const ratio = Math.max(0.2, Math.min(1.5, +sym.ratio || 1)), pts = [];
      for (let i = 0; i <= 400; i++) {
        const t = (i / 400) * Math.min(sym.steps, 200), r = 200 * Math.pow(ratio, t), a = (2 * Math.PI * t) / n - ang;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      lines.push({ pts, kind: 'ray' });
      break;
    }
    case 'wallpaper': {
      const { a, b } = latticeBasis(sym);
      const det = a[0] * b[1] - a[1] * b[0];
      let f0 = Infinity, f1 = -Infinity, g0 = Infinity, g1 = -Infinity;
      for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const dx = px - cx, dy = py - cy, fx = (b[1] * dx - b[0] * dy) / det, fy = (-a[1] * dx + a[0] * dy) / det;
        f0 = Math.min(f0, fx); f1 = Math.max(f1, fx); g0 = Math.min(g0, fy); g1 = Math.max(g1, fy);
      }
      const I0 = Math.floor(f0) - 1, I1 = Math.ceil(f1) + 1, J0 = Math.floor(g0) - 1, J1 = Math.ceil(g1) + 1;
      const P = (i, j) => ({ x: cx + a[0] * i + b[0] * j, y: cy + a[1] * i + b[1] * j });
      if ((I1 - I0) * (J1 - J0) < 6000) {
        for (let i = I0; i <= I1; i++) lines.push({ pts: seg(P(i, J0), P(i, J1), (J1 - J0) * 4), kind: 'cell' });
        for (let j = J0; j <= J1; j++) lines.push({ pts: seg(P(I0, j), P(I1, j), (I1 - I0) * 4), kind: 'cell' });
        const hex = WALLPAPER[sym.wp] && WALLPAPER[sym.wp].lattice === 'hex';
        for (let j = J0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
          points.push({ ...P(i, j), kind: 'node' });
          points.push({ ...P(i + 0.5, j + 0.5), kind: 'node' });
          points.push({ ...P(i + 0.5, j), kind: 'node' }, { ...P(i, j + 0.5), kind: 'node' });
          if (hex) points.push({ ...P(i + 2 / 3, j + 1 / 3), kind: 'node' }, { ...P(i + 1 / 3, j + 2 / 3), kind: 'node' });
        }
      }
      break;
    }
    case 'hyperbolic': {
      const fr = hyperbolicFrame(sym);
      const circ = [];
      for (let i = 0; i <= 128; i++) { const t = i / 128 * Math.PI * 2; circ.push({ x: cx + fr.R * Math.cos(t), y: cy + fr.R * Math.sin(t) }); }
      lines.push({ pts: circ, kind: 'circle' });
      // fundamental triangle edges in disk coordinates
      const T = fr.tri, edges = [];
      edges.push(seg({ x: 0, y: 0 }, { x: T.edgeMid, y: 0 }, 12));
      edges.push(seg({ x: 0, y: 0 }, { x: T.vertex[0], y: T.vertex[1] }, 12));
      const a0 = Math.PI, a1 = Math.atan2(T.vertex[1], T.vertex[0] - T.d), arc = [];
      for (let i = 0; i <= 12; i++) { const t = a0 + (a1 - a0) * i / 12; arc.push({ x: T.d + T.r * Math.cos(t), y: T.r * Math.sin(t) }); }
      edges.push(arc);
      const xs = symTransforms(sym, W, H).slice(0, 900);
      const seen = new Set();
      for (const t of xs) {
        for (const e of edges) {
          const pts = e.map((p) => { const w = mobApply(fr.S, p.x, p.y); return mobApply(t.mob, w.x, w.y); });
          const k = Math.round((pts[0].x + pts[pts.length - 1].x) * 10) + ',' + Math.round((pts[0].y + pts[pts.length - 1].y) * 10);
          if (seen.has(k)) continue;
          seen.add(k);
          lines.push({ pts, kind: 'geo' });
        }
        const o = mobApply(t.mob, cx, cy);
        const v0 = mobApply(fr.S, T.vertex[0], T.vertex[1]), v = mobApply(t.mob, v0.x, v0.y);
        if (Math.hypot(o.x - cx, o.y - cy) < fr.R * 0.97) points.push({ ...o, kind: 'node' });
        if (Math.hypot(v.x - cx, v.y - cy) < fr.R * 0.97) points.push({ ...v, kind: 'node' });
      }
      break;
    }
    case 'inversion': {
      for (const ci of inversionCircles(sym)) {
        const pts = [];
        for (let i = 0; i <= 96; i++) { const t = i / 96 * Math.PI * 2; pts.push({ x: ci.x + ci.r * Math.cos(t), y: ci.y + ci.r * Math.sin(t) }); }
        lines.push({ pts, kind: 'circle' });
        points.push({ x: ci.x, y: ci.y, kind: 'node' });
      }
      break;
    }
  }
  for (const p of childCentres(sym, rec, W, H)) points.push({ x: p.x, y: p.y, kind: 'anchor' });

  // dedupe points
  const uniq = new Map();
  for (const p of points) {
    const k = Math.round(p.x * 4) + ',' + Math.round(p.y * 4);
    const prev = uniq.get(k);
    if (!prev || rank(p.kind) > rank(prev.kind)) uniq.set(k, p);
  }
  let pts = [...uniq.values()];
  if (warpActive(warp)) {
    const wp = (p) => ({ ...p, ...warpPoint(warp, cx, cy, p.x, p.y) });
    for (const l of lines) l.pts = l.pts.map(wp);
    pts = pts.map(wp);
  }
  return { lines, points: pts };
}
const rank = (k) => ({ centre: 3, anchor: 2, node: 1 }[k] || 0);

const cache = { key: '', g: null };
export function guidesCached(sym, rec, warp, W, H) {
  const key = JSON.stringify([sym, rec && rec.mode !== 'off' ? rec : 0, warp && warp.type !== 'none' ? warp : 0, W, H]);
  if (cache.key !== key) { cache.key = key; cache.g = buildGuides(sym, rec, warp, W, H); }
  return cache.g;
}

/**
 * Snap a world point to guide points (preferred) or guide lines.
 * @param tolWorld tolerance in world units
 * @returns {{x, y, kind, onLine}|null}
 */
export function snapTo(g, x, y, tolWorld, extraPoints = []) {
  let best = null, bd = tolWorld * 1.4;
  for (const p of g.points.concat(extraPoints)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = { x: p.x, y: p.y, kind: p.kind, onLine: false }; }
  }
  if (best) return best;
  bd = tolWorld;
  for (const l of g.lines) {
    const P = l.pts;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
      const qx = a.x + dx * t, qy = a.y + dy * t, d = Math.hypot(qx - x, qy - y);
      if (d < bd) { bd = d; best = { x: qx, y: qy, kind: l.kind, onLine: true }; }
    }
  }
  return best;
}
