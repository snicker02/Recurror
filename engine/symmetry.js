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
export const SYM_MODES = ['none', 'mirror', 'rotate', 'kaleido', 'spiral', 'wallpaper', 'hyperbolic', 'inversion'];
export const MAX_TOTAL = 4000;

export function defaultSym(w = 2048, h = 2048) {
  return {
    mode: 'kaleido', n: 6, angle: 90, cx: w / 2, cy: h / 2,
    ratio: 0.92, steps: 24,
    // wallpaper
    wp: 'p6m', tileDX: 256, tileDY: 256, cellAngle: 75,
    // hyperbolic {p,q}
    hp: 7, hq: 3, hR: Math.min(w, h) * 0.46, hRefl: true, hDepth: 40,
    // circle inversion
    invK: 4, invD: Math.min(w, h) * 0.26, invR: Math.min(w, h) * 0.16, invHub: 0, invDepth: 3, invRing: true,
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

/**
 * Base group combined with recursion; entries ascend by level, entry 0 = identity.
 * Array carries .levels and .capped.
 */
export function allTransforms(sym, rec, w, h) {
  const base = symTransforms(sym, w, h);
  const out = base.slice();
  out.levels = 0; out.capped = false;
  if (!rec || rec.mode === 'off' || !(rec.depth >= 1)) return out;
  const depth = Math.max(1, Math.min(8, Math.round(rec.depth)));
  const M = recMap(sym, rec);
  if (rec.mode === 'nest') {
    let ML = MOB_IDENT;
    for (let L = 1; L <= depth; L++) {
      if (out.length + base.length > MAX_TOTAL) { out.capped = true; break; }
      ML = mobCompose(M, ML);
      for (const b of base) out.push(entry(mobCompose(ML, b.mob), L));
      out.levels = L;
    }
  } else {
    const kids = base.map((b) => mobCompose(b.mob, M));
    let prev = base;
    for (let L = 1; L <= depth; L++) {
      if (out.length + prev.length * kids.length > MAX_TOTAL) { out.capped = true; break; }
      const next = [];
      for (const k of kids) for (const e of prev) next.push(entry(mobCompose(k, e.mob), L));
      for (const e of next) out.push(e);
      prev = next;
      out.levels = L;
    }
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
  const k = symKey(sym, w, h) + '#' + recKey(rec) + '#' + (rec && rec.mode !== 'off' ? sym.cx + ',' + sym.cy : '');
  let v = allCache.get(k);
  if (!v) {
    v = allTransforms(sym, rec, w, h);
    v.key = k;
    if (allCache.size > 96) allCache.clear();
    allCache.set(k, v);
  }
  return v;
}
