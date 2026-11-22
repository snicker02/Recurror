// Recurror — symmetry groups as lists of anti-Möbius maps.
//
// Every copy is f(z) = (a·w + b) / (c·w + d) with w = z or conj(z), z = x + iy in world space.
// Similarities (rotations, reflections, scalings, translations — every Euclidean symmetry,
// all 17 wallpaper groups) are the case c = 0. Hyperbolic tilings (Poincaré disk) and
// circle inversions need c ≠ 0. One representation, one shader path.

// ---------------------------------------------------------------------------
// complex + Möbius algebra
// ---------------------------------------------------------------------------
const C = (re, im = 0) => [re, im];
const cadd = (p, q) => [p[0] + q[0], p[1] + q[1]];
const csub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const cmul = (p, q) => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const cdiv = (p, q) => { const d = q[0] * q[0] + q[1] * q[1] || 1e-300; return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d]; };
const cconj = (p) => [p[0], -p[1]];
const cabs = (p) => Math.hypot(p[0], p[1]);
const cexp = (t) => [Math.cos(t), Math.sin(t)];

export const MOB_IDENT = Object.freeze({ a: C(1), b: C(0), c: C(0), d: C(1), conj: false });

function norm(M) {
  // scale so |ad − bc| = 1 (projective; keeps compositions well-conditioned)
  const det = csub(cmul(M.a, M.d), cmul(M.b, M.c));
  const k = Math.sqrt(cabs(det)) || 1;
  return { a: [M.a[0] / k, M.a[1] / k], b: [M.b[0] / k, M.b[1] / k], c: [M.c[0] / k, M.c[1] / k], d: [M.d[0] / k, M.d[1] / k], conj: M.conj };
}

/** F ∘ G */
export function mobCompose(F, G) {
  const g = F.conj ? { a: cconj(G.a), b: cconj(G.b), c: cconj(G.c), d: cconj(G.d) } : G;
  return norm({
    a: cadd(cmul(F.a, g.a), cmul(F.b, g.c)),
    b: cadd(cmul(F.a, g.b), cmul(F.b, g.d)),
    c: cadd(cmul(F.c, g.a), cmul(F.d, g.c)),
    d: cadd(cmul(F.c, g.b), cmul(F.d, g.d)),
    conj: F.conj !== G.conj,
  });
}

export function mobInverse(F) {
  const inv = { a: F.d, b: [-F.b[0], -F.b[1]], c: [-F.c[0], -F.c[1]], d: F.a };
  if (!F.conj) return norm({ ...inv, conj: false });
  return norm({ a: cconj(inv.a), b: cconj(inv.b), c: cconj(inv.c), d: cconj(inv.d), conj: true });
}

export function mobApply(F, x, y) {
  const w = F.conj ? [x, -y] : [x, y];
  const r = cdiv(cadd(cmul(F.a, w), F.b), cadd(cmul(F.c, w), F.d));
  return { x: r[0], y: r[1] };
}

/** |f'(z)| — the local conformal scale. */
export function mobScaleAt(F, x, y) {
  const w = F.conj ? [x, -y] : [x, y];
  const den = cadd(cmul(F.c, w), F.d);
  const det = csub(cmul(F.a, F.d), cmul(F.b, F.c));
  const dd = den[0] * den[0] + den[1] * den[1];
  return cabs(det) / Math.max(dd, 1e-300);
}

/** 2×2 Jacobian [j00 j01; j10 j11] (row-major) at (x, y). */
export function mobJacobian(F, x, y) {
  const w = F.conj ? [x, -y] : [x, y];
  const den = cadd(cmul(F.c, w), F.d);
  const det = csub(cmul(F.a, F.d), cmul(F.b, F.c));
  const k = cdiv(det, cmul(den, den));
  // multiplication by k: [k0 −k1; k1 k0]; conj input flips the y column
  return F.conj ? [k[0], k[1], k[1], -k[0]] : [k[0], -k[1], k[1], k[0]];
}

export function isAffine(F) { return cabs(F.c) < 1e-12 * Math.max(1, cabs(F.d)); }

/** Similarity affine [a,b,c,d,e,f] (x' = a x + c y + e, y' = b x + d y + f) → anti-Möbius. */
export function mobFromAffine(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det >= 0) return norm({ a: [m[0], m[1]], b: [m[4], m[5]], c: C(0), d: C(1), conj: false });
  return norm({ a: [m[0], m[1]], b: [m[4], m[5]], c: C(0), d: C(1), conj: true });
}

// affine helpers (similarities, used while building Euclidean groups)
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const IDENT = [1, 0, 0, 1, 0, 0];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (r) => { const c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
const scale = (k) => [k, 0, 0, k, 0, 0];
const reflect = (r) => { const c = Math.cos(2 * r), s = Math.sin(2 * r); return [c, s, s, -c, 0, 0]; };
const about = (cx, cy, m) => mul(translate(cx, cy), mul(m, translate(-cx, -cy)));

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------
export const SYM_MODES = ['none', 'mirror', 'rotate', 'kaleido', 'spiral', 'frieze', 'wallpaper', 'hyperbolic', 'inversion'];
export const MAX_TOTAL = 4000;          // cap for a base group (lattice cells, hyperbolic tiles, inversion words)
let COPY_LIMIT = MAX_TOTAL;             // cap for group × recursion (raised when the renderer can instance)
export function setCopyLimit(n) { COPY_LIMIT = Math.max(MAX_TOTAL, n | 0); allCache.clear(); }
export function copyLimit() { return COPY_LIMIT; }
const POINT_MODES = new Set(['none', 'mirror', 'rotate', 'kaleido', 'spiral']);

export function defaultSym(w = 2048, h = 2048) {
  return {
    mode: 'kaleido', n: 6, angle: 90, cx: w / 2, cy: h / 2,
    ratio: 0.92, steps: 24,
    // wallpaper
    wp: 'p6m', tileDX: 256, tileDY: 256, cellAngle: 75,
    // frieze (strip patterns): group, repeat length, strip direction (degrees, 0 = left to right)
    fr: 'p2mm', frLen: 220, frAngle: 0,
    // hyperbolic {p,q}
    hp: 7, hq: 3, hR: Math.min(w, h) * 0.46, hRefl: true, hDepth: 40,
    // circle inversion
    invK: 4, invD: Math.min(w, h) * 0.26, invR: Math.min(w, h) * 0.16, invHub: 0, invDepth: 3, invRing: true,
    // crop each copy to its own cell of the symmetry (no overlap across the boundaries)
    crop: false,
  };
}

export function defaultRec() {
  return { mode: 'off', depth: 2, scale: 0.4, offset: 420, angle: 90, twist: 0, fade: 1, hue: 0, layer: 'mixed' };
}

const entry = (mob, level = 0) => ({ mob, level, flip: mob.conj });

// ---------------------------------------------------------------------------
// 17 wallpaper groups (operations in fractional lattice coordinates)
// [m00, m01, m10, m11, tx, ty]: x' = m00 x + m01 y + tx, y' = m10 x + m11 y + ty
// ---------------------------------------------------------------------------
const I = [1, 0, 0, 1, 0, 0], P2 = [-1, 0, 0, -1, 0, 0];
const Mx = [-1, 0, 0, 1, 0, 0], My = [1, 0, 0, -1, 0, 0];
const R4 = [0, -1, 1, 0, 0, 0], R4i = [0, 1, -1, 0, 0, 0];
const D1 = [0, 1, 1, 0, 0, 0], D2 = [0, -1, -1, 0, 0, 0];
const R3 = [0, -1, 1, -1, 0, 0], R3i = [-1, 1, -1, 0, 0, 0];
const R6 = [1, -1, 1, 0, 0, 0], R6i = [0, 1, -1, 1, 0, 0];
const half = (o, tx, ty) => [o[0], o[1], o[2], o[3], tx, ty];

export const WALLPAPER = {
  p1: { lattice: 'oblique', ops: [I] },
  p2: { lattice: 'oblique', ops: [I, P2] },
  pm: { lattice: 'rect', ops: [I, Mx] },
  pg: { lattice: 'rect', ops: [I, half(Mx, 0, 0.5)] },
  cm: { lattice: 'rect', ops: [I, Mx], centred: true },
  pmm: { lattice: 'rect', ops: [I, P2, Mx, My] },
  pmg: { lattice: 'rect', ops: [I, P2, half(Mx, 0.5, 0), half(My, 0.5, 0)] },
  pgg: { lattice: 'rect', ops: [I, P2, half(Mx, 0.5, 0.5), half(My, 0.5, 0.5)] },
  cmm: { lattice: 'rect', ops: [I, P2, Mx, My], centred: true },
  p4: { lattice: 'square', ops: [I, P2, R4, R4i] },
  p4m: { lattice: 'square', ops: [I, P2, R4, R4i, Mx, My, D1, D2] },
  p4g: { lattice: 'square', ops: [I, P2, R4, R4i, half(Mx, 0.5, 0.5), half(My, 0.5, 0.5), half(D1, 0.5, 0.5), half(D2, 0.5, 0.5)] },
  p3: { lattice: 'hex', ops: [I, R3, R3i] },
  p3m1: { lattice: 'hex', ops: [I, R3, R3i, D2, [-1, 1, 0, 1, 0, 0], [1, 0, 1, -1, 0, 0]] },
  p31m: { lattice: 'hex', ops: [I, R3, R3i, D1, [1, -1, 0, -1, 0, 0], [-1, 0, -1, 1, 0, 0]] },
  p6: { lattice: 'hex', ops: [I, R3, R3i, P2, R6i, R6] },
  p6m: { lattice: 'hex', ops: [I, R3, R3i, P2, R6i, R6, D2, [-1, 1, 0, 1, 0, 0], [1, 0, 1, -1, 0, 0], D1, [1, -1, 0, -1, 0, 0], [-1, 0, -1, 1, 0, 0]] },
};
export const WALLPAPER_NAMES = Object.keys(WALLPAPER);

/** Lattice basis vectors a, b (world units) for a group + cell settings. */
export function latticeBasis(sym) {
  const g = WALLPAPER[sym.wp] || WALLPAPER.p1;
  const W = Math.max(8, +sym.tileDX || 256), H = Math.max(8, +sym.tileDY || 256);
  switch (g.lattice) {
    case 'square': return { a: [W, 0], b: [0, -W] };
    case 'hex': return { a: [W, 0], b: [-W / 2, -W * Math.sqrt(3) / 2] };
    case 'rect': return { a: [W, 0], b: [0, -H] };
    default: { // oblique
      const g2 = Math.max(30, Math.min(150, +sym.cellAngle || 75)) * Math.PI / 180;
      return { a: [W, 0], b: [H * Math.cos(g2), -H * Math.sin(g2)] };
    }
  }
}

function wallpaperTransforms(sym, w, h) {
  const g = WALLPAPER[sym.wp] || WALLPAPER.p1;
  const { a, b } = latticeBasis(sym);
  const cx = +sym.cx, cy = +sym.cy;
  const B = [a[0], a[1], b[0], b[1], 0, 0];               // fractional → world (linear)
  const det = a[0] * b[1] - a[1] * b[0];
  const Bi = [b[1] / det, -a[1] / det, -b[0] / det, a[0] / det, 0, 0];
  // ops in world coordinates (about the lattice origin at the centre)
  const opsW = [];
  const cents = g.centred ? [[0, 0], [0.5, 0.5]] : [[0, 0]];
  for (const ct of cents) {
    for (const o of g.ops) {
      const R = [o[0], o[2], o[1], o[3], 0, 0];              // column-major affine
      const L = mul(B, mul(R, Bi));
      const t = [a[0] * (o[4] + ct[0]) + b[0] * (o[5] + ct[1]), a[1] * (o[4] + ct[0]) + b[1] * (o[5] + ct[1])];
      opsW.push(mul(translate(cx + t[0], cy + t[1]), mul([L[0], L[1], L[2], L[3], 0, 0], translate(-cx, -cy))));
    }
  }
  // lattice translations covering the artboard (+1 cell margin)
  let fx0 = Infinity, fx1 = -Infinity, fy0 = Infinity, fy1 = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const dx = px - cx, dy = py - cy;
    const fx = Bi[0] * dx + Bi[2] * dy, fy = Bi[1] * dx + Bi[3] * dy;
    fx0 = Math.min(fx0, fx); fx1 = Math.max(fx1, fx); fy0 = Math.min(fy0, fy); fy1 = Math.max(fy1, fy);
  }
  const cells = [];
  for (let j = Math.floor(fy0) - 1; j <= Math.ceil(fy1) + 1; j++)
    for (let i = Math.floor(fx0) - 1; i <= Math.ceil(fx1) + 1; i++) cells.push([i, j]);
  // nearest cells first so a cap trims the outside
  cells.sort((p, q) => (p[0] * p[0] + p[1] * p[1]) - (q[0] * q[0] + q[1] * q[1]));
  const out = [];
  for (const [i, j] of cells) {
    const T = translate(a[0] * i + b[0] * j, a[1] * i + b[1] * j);
    for (const op of opsW) {
      if (out.length >= MAX_TOTAL) return out;
      out.push(mul(T, op));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hyperbolic {p,q}: reflection group of the (π/p, π/q, π/2) triangle in the Poincaré disk
// ---------------------------------------------------------------------------
export function hyperbolicValid(p, q) { return 1 / p + 1 / q < 0.5 - 1e-9; }

/** Fundamental triangle: mirrors x-axis, line at angle π/p, circle (d, 0) radius r. */
export function hyperbolicTriangle(p, q) {
  const A = Math.PI / p, Bq = Math.PI / q;
  const d = Math.cos(Bq) / Math.sqrt(Math.cos(Bq) ** 2 - Math.sin(A) ** 2);
  const r = d * Math.sin(A) / Math.cos(Bq);
  const t = d * Math.cos(A) - Math.sqrt(d * d * Math.cos(A) ** 2 - 1);  // p-gon vertex distance
  return { A, d, r, edgeMid: d - r, vertex: [t * Math.cos(A), t * Math.sin(A)] };
}

function hyperbolicDiskGroup(p, q, maxDepth, reflections) {
  const { A, d } = hyperbolicTriangle(p, q);
  const g1 = { a: C(1), b: C(0), c: C(0), d: C(1), conj: true };                    // z̄
  const g2 = { a: cexp(2 * A), b: C(0), c: C(0), d: C(1), conj: true };             // e^{2iA} z̄
  const g3 = norm({ a: C(d), b: C(-1), c: C(1), d: C(-d), conj: true });            // inversion in circle
  const gens = [g1, g2, g3];
  const tri = hyperbolicTriangle(p, q);
  const t0 = [(tri.edgeMid + tri.vertex[0]) / 3, tri.vertex[1] / 3];
  const key = (z) => Math.round(z.x * 2e6) + ',' + Math.round(z.y * 2e6);
  const seen = new Map();
  const out = [MOB_IDENT];
  seen.set(key({ x: t0[0], y: t0[1] }), true);
  let frontier = [{ m: MOB_IDENT, last: -1 }];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      for (let gi = 0; gi < 3; gi++) {
        if (gi === f.last) continue;
        const m = mobCompose(f.m, gens[gi]);          // neighbour triangle of f.m(F)
        const z = mobApply(m, t0[0], t0[1]);
        if (Math.hypot(z.x, z.y) > 0.9965) continue;
        const k = key(z);
        if (seen.has(k)) continue;
        seen.set(k, true);
        out.push(m);
        next.push({ m, last: gi });
        if (out.length >= MAX_TOTAL * 2) { frontier = []; break; }
      }
      if (!frontier.length) break;
    }
    frontier = next;
  }
  return reflections ? out : out.filter((m) => !m.conj);
}

function hyperbolicTransforms(sym) {
  let p = Math.max(3, Math.round(sym.hp)), q = Math.max(3, Math.round(sym.hq));
  if (!hyperbolicValid(p, q)) q = Math.max(q, Math.floor(2 * p / (p - 2)) + 1);
  const R = Math.max(16, +sym.hR || 900), cx = +sym.cx, cy = +sym.cy;
  const rot = -(+sym.angle || 0) * Math.PI / 180 + Math.PI / 2;  // angle 90 → one mirror vertical
  const S = norm({ a: cmul(C(R), cexp(rot)), b: C(cx, cy), c: C(0), d: C(1), conj: false });
  const Si = mobInverse(S);
  const disk = hyperbolicDiskGroup(p, q, Math.max(1, Math.min(200, Math.round(sym.hDepth || 40))), sym.hRefl !== false);
  return disk.slice(0, MAX_TOTAL).map((m) => mobCompose(S, mobCompose(m, Si)));
}

export function hyperbolicFrame(sym) {
  let p = Math.max(3, Math.round(sym.hp)), q = Math.max(3, Math.round(sym.hq));
  const valid = hyperbolicValid(p, q);
  if (!valid) q = Math.max(q, Math.floor(2 * p / (p - 2)) + 1);
  const R = Math.max(16, +sym.hR || 900), cx = +sym.cx, cy = +sym.cy;
  const rot = -(+sym.angle || 0) * Math.PI / 180 + Math.PI / 2;
  const S = norm({ a: cmul(C(R), cexp(rot)), b: C(cx, cy), c: C(0), d: C(1), conj: false });
  return { p, q, valid, R, S, tri: hyperbolicTriangle(p, q) };
}

// ---------------------------------------------------------------------------
// circle inversion: group generated by inversions in a ring of circles (+ optional hub)
// ---------------------------------------------------------------------------
export function inversionCircles(sym) {
  const k = Math.max(1, Math.min(12, Math.round(sym.invK)));
  const D = +sym.invD || 0, r = Math.max(4, +sym.invR || 100);
  const a0 = -(+sym.angle || 0) * Math.PI / 180;
  const out = [];
  if (k === 1 && D === 0) out.push({ x: +sym.cx, y: +sym.cy, r });
  else for (let i = 0; i < k; i++) {
    const a = a0 + 2 * Math.PI * i / k;
    out.push({ x: +sym.cx + D * Math.cos(a), y: +sym.cy + D * Math.sin(a), r });
  }
  if (+sym.invHub > 0) out.push({ x: +sym.cx, y: +sym.cy, r: +sym.invHub });
  return out;
}

/** Inversion in circle (C, r):  z ↦ C + r² / conj(z − C). */
export function inversionMob(cx, cy, r) {
  const Cc = C(cx, cy);
  return norm({ a: Cc, b: C(r * r - (cx * cx + cy * cy)), c: C(1), d: cconj([-cx, -cy]), conj: true });
}

function inversionTransforms(sym, w, h) {
  const circles = inversionCircles(sym);
  const gens = circles.map((c) => inversionMob(c.x, c.y, c.r));
  const maxDepth = Math.max(1, Math.min(8, Math.round(sym.invDepth || 3)));
  const diag = Math.hypot(w, h);
  const ref = { x: +sym.cx + 0.37 * diag * 0.1, y: +sym.cy + 0.29 * diag * 0.1 };
  const key = (m) => { const a = mobApply(m, ref.x, ref.y), b = mobApply(m, ref.x + 17, ref.y - 11); return [a.x, a.y, b.x, b.y].map((v) => Math.round(v * 100)).join(','); };
  const out = [MOB_IDENT];
  const seen = new Set([key(MOB_IDENT)]);
  let frontier = [{ m: MOB_IDENT, last: -1 }];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      for (let gi = 0; gi < gens.length; gi++) {
        if (gi === f.last) continue;
        const m = mobCompose(gens[gi], f.m);
        const s = mobScaleAt(m, +sym.cx, +sym.cy);
        if (!(s > 1e-4 && s < 1e4)) continue;
        const k = key(m);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(m);
        next.push({ m, last: gi });
        if (out.length >= MAX_TOTAL) { frontier = []; break; }
      }
      if (!frontier.length) break;
    }
    frontier = next;
  }
  // The ring's rotations permute the circles, so ⟨inversions, R⟩ = {Rʲ ∘ w}: a symmetric figure.
  const k = Math.max(1, Math.min(12, Math.round(sym.invK)));
  if (sym.invRing === false || k < 2 || !(+sym.invD > 0)) return out;
  const full = [];
  for (let j = 0; j < k; j++) {
    const R = mobFromAffine(about(+sym.cx, +sym.cy, rotate(2 * Math.PI * j / k)));
    for (const m of out) {
      if (full.length >= MAX_TOTAL) return full;
      full.push(j === 0 ? m : mobCompose(R, m));
    }
  }
  return full;
}

// ---------------------------------------------------------------------------
// Euclidean point groups (as before) → Möbius
// ---------------------------------------------------------------------------
function euclidTransforms(sym, w, h) {
  const out = [IDENT];
  const cx = +sym.cx, cy = +sym.cy;
  const n = Math.max(1, Math.min(64, Math.round(sym.n)));
  const ang = (+sym.angle || 0) * Math.PI / 180;
  const axis = -ang;
  switch (sym.mode) {
    case 'mirror': out.push(about(cx, cy, reflect(axis))); break;
    case 'rotate': for (let k = 1; k < n; k++) out.push(about(cx, cy, rotate(2 * Math.PI * k / n))); break;
    case 'kaleido': {
      const R = reflect(axis);
      for (let k = 0; k < n; k++) {
        const rot = rotate(2 * Math.PI * k / n);
        if (k > 0) out.push(about(cx, cy, rot));
        out.push(about(cx, cy, mul(rot, R)));
      }
      break;
    }
    case 'spiral': {
      const steps = Math.max(1, Math.min(MAX_TOTAL, Math.round(sym.steps)));
      const ratio = Math.max(0.2, Math.min(1.5, +sym.ratio || 1));
      for (let k = 1; k < steps; k++) {
        const s = Math.pow(ratio, k);
        if (s < 1e-3 || s > 1e3) break;
        out.push(about(cx, cy, mul(rotate(2 * Math.PI * k / n), scale(s))));
      }
      break;
    }
    case 'wallpaper': return wallpaperTransforms(sym, w, h);
    case 'frieze': return friezeTransforms(sym, w, h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7 frieze groups. In the strip frame (u along the strip, v across it) every operation is
// u' = su·u + tu·L, v' = sv·v: translations by L, plus mirrors across (su = −1), the mirror along
// the centre line (sv = −1), glides (sv = −1, tu = ½) and half turns (su = sv = −1).
// ---------------------------------------------------------------------------
export const FRIEZE = {
  p1: { label: 'p1 · hop (translation)', ops: [[1, 1, 0]] },
  p11g: { label: 'p11g · step (glide)', ops: [[1, 1, 0], [1, -1, 0.5]] },
  p1m1: { label: 'p1m1 · sidle (mirrors across)', ops: [[1, 1, 0], [-1, 1, 0]] },
  p11m: { label: 'p11m · jump (mirror along)', ops: [[1, 1, 0], [1, -1, 0]] },
  p2: { label: 'p2 · spinning hop (half turns)', ops: [[1, 1, 0], [-1, -1, 0]] },
  p2mg: { label: 'p2mg · spinning sidle', ops: [[1, 1, 0], [-1, 1, 0], [1, -1, 0.5], [-1, -1, 0.5]] },
  p2mm: { label: 'p2mm · spinning jump', ops: [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0]] },
};

const FRIEZE_ACROSS = 1e5;   // the pseudo-lattice's cell across the strip: wider than any drawing
/** Frieze as a lattice: a across the strip (one huge cell), b one repeat along it. */
export function friezeLattice(sym) {
  const { e1, e2, L } = friezeFrame(sym);
  return { a: [e2[0] * FRIEZE_ACROSS, e2[1] * FRIEZE_ACROSS], b: [e1[0] * L, e1[1] * L] };
}

/** Strip frame: unit vector along the strip, unit vector across it, repeat length. */
export function friezeFrame(sym) {
  const A = (+sym.frAngle || 0) * Math.PI / 180;
  const e1 = [Math.cos(A), -Math.sin(A)], e2 = [Math.sin(A), Math.cos(A)];   // e2 = e1 turned a quarter (down for a level strip)
  return { e1, e2, L: Math.max(8, +sym.frLen || 220) };
}

function friezeTransforms(sym, w, h) {
  const g = FRIEZE[sym.fr] || FRIEZE.p1;
  const { e1, e2, L } = friezeFrame(sym);
  const cx = +sym.cx, cy = +sym.cy;
  // F = [e1 e2] (column-major), op = F diag(su, sv) Fᵀ about the centre, then tu·L along e1
  const opsW = g.ops.map(([su, sv, tu]) => {
    const m00 = su * e1[0] * e1[0] + sv * e2[0] * e2[0], m01 = su * e1[0] * e1[1] + sv * e2[0] * e2[1];
    const m11 = su * e1[1] * e1[1] + sv * e2[1] * e2[1];
    const Lm = [m00, m01, m01, m11, 0, 0];
    return mul(translate(cx + e1[0] * tu * L, cy + e1[1] * tu * L), mul(Lm, translate(-cx, -cy)));
  });
  let t0 = Infinity, t1 = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const t = ((px - cx) * e1[0] + (py - cy) * e1[1]) / L;
    t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  const ns = [];
  for (let n = Math.floor(t0) - 1; n <= Math.ceil(t1) + 1; n++) ns.push(n);
  ns.sort((a, b) => Math.abs(a) - Math.abs(b));
  const out = [];
  for (const n of ns) {
    const T = translate(e1[0] * n * L, e1[1] * n * L);
    for (const op of opsW) { if (out.length >= MAX_TOTAL) return out; out.push(mul(T, op)); }
  }
  return out;
}

/** Base symmetry group as Möbius entries (entry 0 is the identity). */
export function symTransforms(sym, w, h) {
  if (!sym || sym.mode === 'none') return [entry(MOB_IDENT)];
  let mobs;
  if (sym.mode === 'hyperbolic') mobs = hyperbolicTransforms(sym);
  else if (sym.mode === 'inversion') mobs = inversionTransforms(sym, w, h);
  else mobs = euclidTransforms(sym, w, h).map(mobFromAffine);
  // guarantee identity first
  const idx = mobs.findIndex((m) => isIdentity(m));
  if (idx > 0) { const t = mobs[idx]; mobs.splice(idx, 1); mobs.unshift(t); }
  else if (idx < 0) mobs.unshift(MOB_IDENT);
  return mobs.map((m) => entry(m, 0));
}

function isIdentity(m) {
  if (m.conj) return false;
  const p = mobApply(m, 3.7, 1.3), q = mobApply(m, -2.1, 5.9);
  return Math.abs(p.x - 3.7) + Math.abs(p.y - 1.3) + Math.abs(q.x + 2.1) + Math.abs(q.y - 5.9) < 1e-6;
}

// ---------------------------------------------------------------------------
// recursion
// ---------------------------------------------------------------------------
/** The recursion map M: p → c + off + s·R(twist)·(p − c). */
export function recMap(sym, rec) {
  const cx = +sym.cx, cy = +sym.cy;
  const a = (+rec.angle || 0) * Math.PI / 180;
  const off = +rec.offset || 0;
  const ox = Math.cos(a) * off, oy = -Math.sin(a) * off;
  const k = Math.max(0.02, Math.min(1.5, +rec.scale || 0.5));
  const tw = -(+rec.twist || 0) * Math.PI / 180;
  return mobFromAffine(mul(translate(cx + ox, cy + oy), mul(mul(rotate(tw), scale(k)), translate(-cx, -cy))));
}

/** Group elements that fix the point (x, y) — the local symmetry the recursion branches with. */
function stabiliser(base, x, y) {
  const tol = 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  const K = base.filter((e) => { const p = mobApply(e.mob, x, y); return Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol; }).map((e) => e.mob);
  return K.length ? K : [MOB_IDENT];
}

/**
 * Base group combined with recursion; entries ascend by level, entry 0 = identity.
 * Array carries .levels and .capped.
 *
 * Point groups (none / mirror / rotational / kaleidoscope / spiral) — finite, centred:
 *   nest   level L = Mᴸ ∘ g                 branch  level L = (g·M)ᴸ ∘ g
 * Infinite / large groups (wallpaper, hyperbolic, inversion) — recursion builds the motif first,
 * then the group places it, so every tile gets the recursive motif:
 *   nest   level L = g ∘ Mᴸ                 branch  level L = g ∘ (M ∘ k)ᴸ,  k ∈ K = stabiliser of the centre
 * (For a finite group about its centre K = G and the branch formula reduces to the point-group one.)
 */
export function allTransforms(sym, rec, w, h) {
  const limit = COPY_LIMIT;
  const base = symTransforms(sym, w, h);
  const out = base.slice();
  out.levels = 0; out.capped = false;
  if (!rec || rec.mode === 'off' || !(rec.depth >= 1)) return out;
  const depth = Math.max(1, Math.min(8, Math.round(rec.depth)));
  const M = recMap(sym, rec);
  if (POINT_MODES.has(sym.mode)) {
    if (rec.mode === 'nest') {
      let ML = MOB_IDENT;
      for (let L = 1; L <= depth; L++) {
        if (out.length + base.length > limit) { out.capped = true; out.needed = out.length + base.length; break; }
        ML = mobCompose(M, ML);
        for (const b of base) out.push(entry(mobCompose(ML, b.mob), L));
        out.levels = L;
      }
    } else {
      const kids = base.map((b) => mobCompose(b.mob, M));
      let prev = base;
      for (let L = 1; L <= depth; L++) {
        if (out.length + prev.length * kids.length > limit) { out.capped = true; out.needed = out.length + prev.length * kids.length; break; }
        const next = [];
        for (const k of kids) for (const e of prev) next.push(entry(mobCompose(k, e.mob), L));
        for (const e of next) out.push(e);
        prev = next;
        out.levels = L;
      }
    }
    return out;
  }
  // motif-first: R_L is the level-L recursion of the motif; the group places every element of it
  const K = rec.mode === 'branch' ? stabiliser(base, +sym.cx, +sym.cy) : [MOB_IDENT];
  let R = [MOB_IDENT];
  for (let L = 1; L <= depth; L++) {
    const next = [];
    for (const r of R) for (const k of K) next.push(mobCompose(r, mobCompose(M, k)));
    if (out.length + base.length * next.length > limit) { out.capped = true; out.needed = out.length + base.length * next.length; break; }
    for (const g of base) for (const r of next) out.push(entry(mobCompose(g.mob, r), L));
    R = next;
    out.levels = L;
  }
  return out;
}

/** Centres of the level-1 children (recursion anchors). */
export function childCentres(sym, rec, w, h) {
  if (!rec || rec.mode === 'off') return [];
  const M = recMap(sym, rec);
  const c = mobApply(M, +sym.cx, +sym.cy);
  if (rec.mode === 'nest') return [c];
  return symTransforms(sym, w, h).slice(0, 400).map((t) => mobApply(t.mob, c.x, c.y));
}

export function symKey(sym, w, h) {
  if (!sym || sym.mode === 'none') return 'none';
  const k = [sym.mode, sym.cx, sym.cy, sym.angle, w, h];
  switch (sym.mode) {
    case 'mirror': break;
    case 'rotate': case 'kaleido': k.push(sym.n); break;
    case 'spiral': k.push(sym.n, sym.ratio, sym.steps); break;
    case 'wallpaper': k.push(sym.wp, sym.tileDX, sym.tileDY, sym.cellAngle); break;
    case 'frieze': k.push(sym.fr, sym.frLen, sym.frAngle); break;
    case 'hyperbolic': k.push(sym.hp, sym.hq, sym.hR, sym.hRefl, sym.hDepth); break;
    case 'inversion': k.push(sym.invK, sym.invD, sym.invR, sym.invHub, sym.invDepth, sym.invRing); break;
  }
  return k.join('|');
}

export function recKey(rec) {
  return rec && rec.mode !== 'off' ? [rec.mode, rec.depth, rec.scale, rec.offset, rec.angle, rec.twist].join('|') : 'off';
}

const allCache = new Map();
export function allTransformsCached(sym, rec, w, h) {
  const k = symKey(sym, w, h) + '#' + recKey(rec) + '#' + (rec && rec.mode !== 'off' ? sym.cx + ',' + sym.cy : '') + '#' + COPY_LIMIT;
  let v = allCache.get(k);
  if (!v) {
    v = allTransforms(sym, rec, w, h);
    v.key = k;
    if (allCache.size > 96) allCache.clear();
    allCache.set(k, v);
  }
  return v;
}

/**
 * Copies for one stroke. The wallpaper list covers the artboard for a motif near the lattice origin;
 * a stroke drawn n cells away would leave the far side of the artboard empty. Since the lattice
 * translation T_n is in the group, g∘T_−n runs over the same group, and maps the stroke (= T_n of a
 * motif near the origin) exactly where g maps that motif. So the list is shifted by the stroke's
 * cell. (With recursion the motif maps don't commute with T_n, so the list is used as it is.)
 * @param anchor {x, y} centre of the stroke's bound
 */
const shiftCache = new Map();
export function transformsFor(sym, rec, w, h, anchor) {
  const xs = allTransformsCached(sym, rec, w, h);
  if (!sym || (sym.mode !== 'wallpaper' && sym.mode !== 'frieze') || (rec && rec.mode !== 'off') || !anchor) return xs;
  const { a, b } = sym.mode === 'frieze' ? friezeLattice(sym) : latticeBasis(sym);
  const det = a[0] * b[1] - a[1] * b[0];
  const dx = anchor.x - +sym.cx, dy = anchor.y - +sym.cy;
  const ni = Math.round((b[1] * dx - b[0] * dy) / det), nj = Math.round((-a[1] * dx + a[0] * dy) / det);
  if (!ni && !nj) return xs;
  const k = xs.key + '@' + ni + ',' + nj;
  let v = shiftCache.get(k);
  if (!v) {
    const T = { a: C(1), b: C(-(a[0] * ni + b[0] * nj), -(a[1] * ni + b[1] * nj)), c: C(0), d: C(1), conj: false };
    v = xs.map((t) => entry(mobCompose(t.mob, T), t.level));
    v.levels = xs.levels; v.capped = xs.capped; v.needed = xs.needed; v.key = k;
    if (shiftCache.size > 256) shiftCache.clear();
    shiftCache.set(k, v);
  }
  return v;
}

// ---- crop to cell -----------------------------------------------------------------------------
export const CROP_MODES = new Set(['mirror', 'rotate', 'kaleido', 'frieze', 'wallpaper', 'hyperbolic']);
export const CROP_SITES = 16;

/**
 * Cell of the identity copy, as a Dirichlet domain: the points nearer to a site c than to any
 * image g(c). For a group of isometries the images of that cell tile the plane (or the hyperbolic
 * disk) without overlap, and its walls fall on the mirrors. Distances are Euclidean, or hyperbolic
 * for {p,q} — where comparing |x−c|²/(R²−|c−O|²) is exact, since the x term cancels.
 * c is where the stroke starts (moved off any mirror or rotation centre), so a stroke is kept in the
 * cell it was started in. For plain rotations c is turned to the middle of its guide wedge, so the
 * cut falls on the guide rays.
 * @param pts local points of the stroke (samples or control points)
 * @returns {{c:[number,number], w0:number, sites:Float32Array, n:number} | null}
 */
export function cropDomain(sym, pts, w, h, anchor = null) {
  if (!sym || !sym.crop || !CROP_MODES.has(sym.mode) || !pts || !pts.length) return null;
  const base = symTransforms(sym, w, h);
  if (base.length < 2) return null;
  const hyp = sym.mode === 'hyperbolic';
  const ox = +sym.cx, oy = +sym.cy, R2 = hyp ? Math.max(16, +sym.hR || 900) ** 2 : 0;
  const wt = (x, y) => (hyp ? 1 / Math.max(1e-6, R2 - (x - ox) ** 2 - (y - oy) ** 2) : 1);
  const scale = Math.max(w, h);
  const eps = Math.max(0.25, scale * 1e-4);
  const imagesOf = (x, y) => base.slice(1).map((t) => mobApply(t.mob, x, y));
  const generic = (x, y) => {
    if (hyp && (x - ox) ** 2 + (y - oy) ** 2 >= R2 * 0.999) return false;
    for (const q of imagesOf(x, y)) if (Number.isFinite(q.x) && Math.hypot(q.x - x, q.y - y) < eps) return false;
    return true;
  };
  let c = null;
  // an explicit anchor (a bucket fill's click point) picks the cell when it's usable
  if (anchor && Number.isFinite(anchor.x) && generic(anchor.x, anchor.y)) c = { x: anchor.x, y: anchor.y };
  // otherwise start a little way along the stroke, so a stroke begun exactly on a wall, corner or centre
  // belongs to the cell it heads into
  let i0 = 0;
  while (i0 < pts.length - 1 && Math.hypot(pts[i0].x - pts[0].x, pts[i0].y - pts[0].y) < 1.5) i0++;
  const step = Math.max(1, Math.floor(pts.length / 64));
  for (let i = i0; i < pts.length && !c; i += step) if (generic(pts[i].x, pts[i].y)) c = { x: pts[i].x, y: pts[i].y };
  if (!c && generic(pts[0].x, pts[0].y)) c = { x: pts[0].x, y: pts[0].y };
  if (!c) {
    // every sample sits on a mirror / centre: nudge off it
    const p = pts[0];
    for (let k = 1; k <= 24 && !c; k++) {
      const a = k * 2.399963, r = eps * 2 * k;
      if (generic(p.x + r * Math.cos(a), p.y + r * Math.sin(a))) c = { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
    }
  }
  if (!c) return null;
  if (sym.mode === 'rotate') {
    const n = Math.max(1, Math.round(sym.n)), ang = (+sym.angle || 0) * Math.PI / 180, wedge = 2 * Math.PI / n;
    const r = Math.hypot(c.x - ox, c.y - oy);
    const phi = Math.atan2(-(c.y - oy), c.x - ox);
    const k = Math.floor((phi - ang) / wedge);
    const mid = ang + (k + 0.5) * wedge;
    c = { x: ox + r * Math.cos(mid), y: oy - r * Math.sin(mid) };
  }
  if (sym.mode === 'wallpaper' || sym.mode === 'frieze') {
    // Guide-aligned asymmetric unit. In lattice coordinates (u along a, v along b) the canonical
    // cell D0 holds, of every orbit, the one point in [0,1)² whose images under the group's point
    // operations (mod the lattice) have the smallest v, then the smallest u. Its walls are lattice
    // lines, mirrors and lines through rotation centres: p1 is the whole cell, p2 the half v < ½,
    // pm the half on one side of the mirror, p4 a quarter triangle, and so on. Each orbit has exactly
    // one such point, so its images tile with no overlap and no gap. The stroke's own cell is the
    // image of D0 that holds the start point: a pixel is kept when h⁻¹ of it lies in D0.
    let a, b, ops, oxL = ox, oyL = oy;
    if (sym.mode === 'frieze') {
      // the same machinery with a pseudo-lattice: first axis across the strip (one huge cell, the
      // strip centre at its middle), second axis along it. "Smallest along, then smallest across"
      // puts the cuts on the repeat lines, mirrors and half-turn centres of the strip.
      ({ a, b } = friezeLattice(sym));
      oxL = ox - a[0] / 2; oyL = oy - a[1] / 2;
      ops = (FRIEZE[sym.fr] || FRIEZE.p1).ops.map(([su, sv, tu]) => [sv, 0, 0, su, sv < 0 ? 1 : 0, tu]);
    } else {
      ({ a, b } = latticeBasis(sym));
      const g = WALLPAPER[sym.wp] || WALLPAPER.p1;
      const cents = g.centred ? [[0, 0], [0.5, 0.5]] : [[0, 0]];
      ops = [];
      for (const ct of cents) for (const o of g.ops) ops.push([o[0], o[1], o[2], o[3], o[4] + ct[0], o[5] + ct[1]]);
    }
    const det = a[0] * b[1] - a[1] * b[0];
    const Bi = [b[1] / det, -a[1] / det, -b[0] / det, a[0] / det];
    const apply = (o, f) => [o[0] * f[0] + o[1] * f[1] + o[4], o[2] * f[0] + o[3] * f[1] + o[5]];
    const red = (f) => [f[0] - Math.floor(f[0]), f[1] - Math.floor(f[1])];
    const less = (p, q) => p[1] < q[1] - 1e-9 || (Math.abs(p[1] - q[1]) <= 1e-9 && p[0] < q[0] - 1e-9);
    const dx = c.x - oxL, dy = c.y - oyL;
    const fc = [Bi[0] * dx + Bi[2] * dy, Bi[1] * dx + Bi[3] * dy];
    // h⁻¹ = (lattice shift) ∘ op, chosen so that h⁻¹(c) is c's canonical representative
    let best = null;
    for (const o of ops) {
      const q = apply(o, fc), n = [-Math.floor(q[0]), -Math.floor(q[1])];
      const r = [q[0] + n[0], q[1] + n[1]];
      if (!best || less(r, best.r)) best = { r, h: [o[0], o[1], o[2], o[3], o[4] + n[0], o[5] + n[1]] };
    }
    const sites = new Float32Array(CROP_SITES * 3);
    ops.slice(0, CROP_SITES).forEach((o, i) => {
      // rotation part has entries in {-1, 0, 1}: pack it as one base-3 number
      sites[i * 3] = (o[0] + 1) * 27 + (o[1] + 1) * 9 + (o[2] + 1) * 3 + (o[3] + 1);
      sites[i * 3 + 1] = o[4]; sites[i * 3 + 2] = o[5];
    });
    const h = best.h;
    return { mode: 3, c: [c.x, c.y], w0: 1, sites, n: Math.min(CROP_SITES, ops.length), origin: [oxL, oyL],
      basis: [a[0], a[1], b[0], b[1]], inv: Bi, h0: [h[0], h[1], h[4]], h1: [h[2], h[3], h[5]] };
  }
  const w0 = wt(c.x, c.y);
  const imgs = imagesOf(c.x, c.y)
    .filter((q) => Number.isFinite(q.x) && Math.hypot(q.x - c.x, q.y - c.y) >= eps * 0.5)
    .map((q) => ({ x: q.x, y: q.y, w: wt(q.x, q.y) }))
    .map((q) => ({ ...q, d: ((q.x - c.x) ** 2 + (q.y - c.y) ** 2) * (hyp ? q.w * w0 : 1) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, CROP_SITES);
  const sites = new Float32Array(CROP_SITES * 3);
  imgs.forEach((q, i) => { sites[i * 3] = q.x; sites[i * 3 + 1] = q.y; sites[i * 3 + 2] = q.w; });
  return { mode: 1, c: [c.x, c.y], w0, sites, n: imgs.length };
}

/** CPU twin of the shaders' cropped(): does the local point (x, y) lie in the crop cell D? */
export function cropKeeps(D, x, y) {
  if (!D) return true;
  if (D.mode === 3) {
    const E = 1e-5, B = D.inv;
    const ux = x - D.origin[0], uy = y - D.origin[1];
    const f0 = [B[0] * ux + B[2] * uy, B[1] * ux + B[3] * uy];
    const f = [D.h0[0] * f0[0] + D.h0[1] * f0[1] + D.h0[2], D.h1[0] * f0[0] + D.h1[1] * f0[1] + D.h1[2]];
    if (f[0] < -E || f[1] < -E || f[0] >= 1 + E || f[1] >= 1 + E) return false;
    for (let j = 0; j < D.n; j++) {
      let k = D.sites[j * 3];
      const m11 = (k % 3) - 1; k = Math.floor(k / 3 + 0.01);
      const m10 = (k % 3) - 1; k = Math.floor(k / 3 + 0.01);
      const m01 = (k % 3) - 1; k = Math.floor(k / 3 + 0.01);
      const m00 = k - 1;
      let gx = m00 * f[0] + m01 * f[1] + D.sites[j * 3 + 1], gy = m10 * f[0] + m11 * f[1] + D.sites[j * 3 + 2];
      gx -= Math.floor(gx + E); gy -= Math.floor(gy + E);
      if (gy < f[1] - E || (Math.abs(gy - f[1]) <= E && gx < f[0] - E)) return false;
    }
    return true;
  }
  const d0 = ((x - D.c[0]) ** 2 + (y - D.c[1]) ** 2) * D.w0;
  for (let j = 0; j < D.n; j++) {
    const ex = x - D.sites[j * 3], ey = y - D.sites[j * 3 + 1];
    if ((ex * ex + ey * ey) * D.sites[j * 3 + 2] < d0) return false;
  }
  return true;
}
