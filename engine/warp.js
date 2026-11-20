// Recurror — non-affine warps applied after the symmetry map (JWildfire-style variations).
// The JS functions and the GLSL source below implement identical formulas: the GPU draws
// with the GLSL, while hit-testing, snapping and the overlay use the JS.
//
// q = (p − centre) / scale;  p' = centre + scale · V(q);  result = mix(p, p', amount)

export const WARPS = [
  'none', 'swirl', 'twirl', 'spherical', 'bubble', 'eyefish', 'sinusoidal',
  'horseshoe', 'waves', 'cylinder', 'power', 'ripple', 'pinch',
];
export const WARP_LABELS = {
  none: 'None', swirl: 'Swirl', twirl: 'Twirl (centre only)', spherical: 'Spherical', bubble: 'Bubble',
  eyefish: 'Eyefish', sinusoidal: 'Sinusoidal', horseshoe: 'Horseshoe', waves: 'Waves', cylinder: 'Cylinder',
  power: 'Power zⁿ', ripple: 'Ripple', pinch: 'Pinch / bulge',
};

export function defaultWarp() { return { type: 'none', amount: 1, scale: 500, strength: 1 }; }

export function warpActive(w) { return !!w && w.type !== 'none' && w.amount > 0; }

function V(type, x, y, k) {
  const r2 = x * x + y * y, r = Math.sqrt(r2);
  switch (type) {
    case 'swirl': { const t = r2 * k, s = Math.sin(t), c = Math.cos(t); return [x * s - y * c, x * c + y * s]; }
    case 'twirl': { const t = k * Math.exp(-r2), s = Math.sin(t), c = Math.cos(t); return [x * c - y * s, x * s + y * c]; }
    case 'spherical': { const f = 1 / (r2 * k + 1e-4); return [x * f, y * f]; }
    case 'bubble': { const f = 4 / (r2 * k + 4); return [x * f, y * f]; }
    case 'eyefish': { const f = 2 / (r * k + 1); return [x * f, y * f]; }
    case 'sinusoidal': { const kk = Math.max(0.05, k); return [Math.sin(x * kk) / kk, Math.sin(y * kk) / kk]; }
    case 'horseshoe': { const f = 1 / (r + 1e-4); return [(x - y) * (x + y) * f, 2 * x * y * f]; }
    case 'waves': return [x + 0.2 * k * Math.sin(4 * y), y + 0.2 * k * Math.sin(4 * x)];
    case 'cylinder': { const kk = Math.max(0.05, k); return [Math.sin(x * kk) / kk, y]; }
    case 'power': {
      const n = Math.max(2, Math.min(6, Math.round(k + 1)));
      let zr = x, zi = y;
      for (let i = 1; i < n; i++) { const t = zr * x - zi * y; zi = zr * y + zi * x; zr = t; }
      return [zr, zi];
    }
    case 'ripple': { const f = r > 1e-6 ? (r + 0.08 * k * Math.sin(r * 12)) / r : 1; return [x * f, y * f]; }
    case 'pinch': { const e = 1 + 0.5 * k, f = r > 1e-6 ? Math.pow(r, e - 1) : 0; return [x * f, y * f]; }
    default: return [x, y];
  }
}

/** Forward warp of a world point. */
export function warpPoint(w, cx, cy, x, y) {
  if (!warpActive(w)) return { x, y };
  const S = Math.max(1, +w.scale || 500);
  const v = V(w.type, (x - cx) / S, (y - cy) / S, +w.strength);
  const a = Math.max(0, Math.min(1, +w.amount));
  return { x: x + (cx + S * v[0] - x) * a, y: y + (cy + S * v[1] - y) * a };
}

/** Numerical inverse (Newton with finite-difference Jacobian). Returns the best preimage found. */
export function warpInverse(w, cx, cy, x, y, guess) {
  if (!warpActive(w)) return { x, y };
  let p = guess ? { ...guess } : { x, y };
  const h = Math.max(1e-3, (+w.scale || 500) * 1e-4);
  for (let it = 0; it < 24; it++) {
    const f = warpPoint(w, cx, cy, p.x, p.y);
    const ex = f.x - x, ey = f.y - y;
    if (ex * ex + ey * ey < 1e-6) break;
    const fx = warpPoint(w, cx, cy, p.x + h, p.y), fy = warpPoint(w, cx, cy, p.x, p.y + h);
    const j00 = (fx.x - f.x) / h, j10 = (fx.y - f.y) / h, j01 = (fy.x - f.x) / h, j11 = (fy.y - f.y) / h;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) break;
    let dx = (j11 * ex - j01 * ey) / det, dy = (-j10 * ex + j00 * ey) / det;
    const step = Math.hypot(dx, dy), lim = (+w.scale || 500) * 0.25;
    if (step > lim) { dx *= lim / step; dy *= lim / step; }
    p = { x: p.x - dx, y: p.y - dy };
  }
  return p;
}

export function warpIndex(type) { return Math.max(0, WARPS.indexOf(type)); }

// GLSL: same formulas. u_warp = index in WARPS, u_warpP = (cx, cy, scale, amount), u_warpK = strength.
export const warpGLSL = `
uniform float u_warp;
uniform vec4 u_warpP;
uniform float u_warpK;

vec2 warpV(vec2 q) {
  float k = u_warpK;
  float r2 = dot(q, q);
  float r = sqrt(r2);
  int t = int(u_warp + 0.5);
  if (t == 1) { float a = r2 * k; float s = sin(a), c = cos(a); return vec2(q.x * s - q.y * c, q.x * c + q.y * s); }
  if (t == 2) { float a = k * exp(-r2); float s = sin(a), c = cos(a); return vec2(q.x * c - q.y * s, q.x * s + q.y * c); }
  if (t == 3) { return q / (r2 * k + 1e-4); }
  if (t == 4) { return q * (4.0 / (r2 * k + 4.0)); }
  if (t == 5) { return q * (2.0 / (r * k + 1.0)); }
  if (t == 6) { float kk = max(0.05, k); return sin(q * kk) / kk; }
  if (t == 7) { float f = 1.0 / (r + 1e-4); return vec2((q.x - q.y) * (q.x + q.y) * f, 2.0 * q.x * q.y * f); }
  if (t == 8) { return vec2(q.x + 0.2 * k * sin(4.0 * q.y), q.y + 0.2 * k * sin(4.0 * q.x)); }
  if (t == 9) { float kk = max(0.05, k); return vec2(sin(q.x * kk) / kk, q.y); }
  if (t == 10) {
    int n = int(clamp(floor(k + 1.0 + 0.5), 2.0, 6.0));
    vec2 z = q;
    for (int i = 1; i < 6; i++) { if (i >= n) break; z = vec2(z.x * q.x - z.y * q.y, z.x * q.y + z.y * q.x); }
    return z;
  }
  if (t == 11) { float f = r > 1e-6 ? (r + 0.08 * k * sin(r * 12.0)) / r : 1.0; return q * f; }
  if (t == 12) { float e = 1.0 + 0.5 * k; float f = r > 1e-6 ? pow(r, e - 1.0) : 0.0; return q * f; }
  return q;
}

vec2 warpP(vec2 p) {
  if (u_warp < 0.5) return p;
  float S = max(1.0, u_warpP.z);
  vec2 c = u_warpP.xy;
  vec2 v = warpV((p - c) / S);
  return mix(p, c + S * v, clamp(u_warpP.w, 0.0, 1.0));
}

// Jacobian of the warp (central differences), columns = d/dx, d/dy
mat2 warpJ(vec2 p) {
  if (u_warp < 0.5) return mat2(1.0);
  float h = max(1e-3, u_warpP.z * 1e-3);
  vec2 dx = (warpP(p + vec2(h, 0.0)) - warpP(p - vec2(h, 0.0))) / (2.0 * h);
  vec2 dy = (warpP(p + vec2(0.0, h)) - warpP(p - vec2(0.0, h))) / (2.0 * h);
  return mat2(dx, dy);
}
`;
