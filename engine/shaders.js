// Recurror — GLSL ES 1.00 shaders (WebGL1).
import { warpGLSL } from './warp.js';

const PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

export const STROKE_MODES = {
  flat: 0, tube: 1, ribbon: 2, glow: 3, neon: 4, airbrush: 5, engrave: 6, bevel: 7, chrome: 8,
  rope: 9, sketch: 10, drybrush: 11, watercolor: 12, outline: 13, stitch: 14,
  bristle: 15, stamp: 16,
};
/** Translucent wash modes: drawn without per-copy depth ordering (they are meant to layer). */
export const SOFT_MODES = new Set([STROKE_MODES.airbrush, STROKE_MODES.watercolor]);
export const DASH_MODES = { none: 0, dash: 1, dot: 2 };
export const ADDITIVE_MODES = new Set([STROKE_MODES.glow, STROKE_MODES.neon]);
export const GRAD_MODES = { none: 0, along: 1, across: 2, center: 3, bands: 4 };
export const FILL_MODES = {
  none: 0, flat: 1, linear: 2, radial: 3, dome: 4,
  noise: 5, hatch: 6, cross: 7, dots: 8, cells: 9, marble: 10,
  // pattern fills (Recurror's own designs): ink in colour B, shaded like pencil work
  plait: 11, pebbles: 12, scallops: 13, orbs: 14, chevron: 15,
};
export const BLEND_MODES = { normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, add: 6, difference: 7 };

// Shared vertex-side mapping: world = warp(möbius(local)); J = Jwarp · Jmöbius
const MAP = `
attribute vec4 i_mA;        // per copy (instanced): a.re a.im b.re b.im
attribute vec4 i_mB;        // per copy: c.re c.im d.re d.im
attribute float i_conj;     // per copy: 1 = map acts on conj(z)
uniform mat3 u_view;
uniform float u_pxWorld;    // world units per device pixel
vec2 cmul(vec2 p, vec2 q) { return vec2(p.x * q.x - p.y * q.y, p.x * q.y + p.y * q.x); }
vec2 cdiv(vec2 p, vec2 q) { float d = max(dot(q, q), 1e-30); return vec2(p.x * q.x + p.y * q.y, p.y * q.x - p.x * q.y) / d; }
vec2 mobW(vec2 p) { return i_conj > 0.5 ? vec2(p.x, -p.y) : p; }
vec2 mobP(vec2 p) { vec2 w = mobW(p); return cdiv(cmul(i_mA.xy, w) + i_mA.zw, cmul(i_mB.xy, w) + i_mB.zw); }
mat2 mobJ(vec2 p) {
  vec2 w = mobW(p);
  vec2 den = cmul(i_mB.xy, w) + i_mB.zw;
  vec2 det = cmul(i_mA.xy, i_mB.zw) - cmul(i_mA.zw, i_mB.xy);
  vec2 k = cdiv(det, cmul(den, den));
  return i_conj > 0.5 ? mat2(k.x, k.y, k.y, -k.x) : mat2(k.x, k.y, -k.y, k.x);
}
` + warpGLSL;

export const PAPER = `
// ---- paper: one sheet under every stroke and fill (world coordinates) ----
uniform vec3 u_paper;        // type (0 none · 1 cold press · 2 hot press · 3 sketch · 4 canvas), grain size, strength
float pp_hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float pp_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pp_hash(i), pp_hash(i + vec2(1.0, 0.0)), u.x), mix(pp_hash(i + vec2(0.0, 1.0)), pp_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pp_cell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float F1 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 site = o + vec2(pp_hash(i + o), pp_hash(i + o + 19.19));
    F1 = min(F1, length(site - f));
  }
  return F1;
}
/** Paper height 0 (valley) … 1 (peak). */
float paperH(vec2 w) {
  int t = int(u_paper.x + 0.5);
  if (t == 0) return 0.5;
  vec2 p = w / max(u_paper.y, 0.5);
  if (t == 1) return clamp(0.62 * (1.0 - pp_cell(p * 0.55)) + 0.25 * pp_noise(p * 1.9) + 0.13 * pp_noise(p * 4.7), 0.0, 1.0);
  if (t == 2) return clamp(0.5 + 0.35 * (pp_noise(p * 0.8) - 0.5) + 0.25 * (pp_noise(p * 3.1) - 0.5), 0.0, 1.0);
  if (t == 3) return clamp(0.45 * pp_noise(vec2(p.x * 2.6, p.y * 1.1)) + 0.35 * pp_noise(p * 5.0) + 0.2 * pp_noise(p * 11.0), 0.0, 1.0);
  vec2 g = p * 0.9;                                   // canvas: an over-under thread weave
  float over = mod(floor(g.x) + floor(g.y), 2.0);
  float th = over > 0.5 ? 0.5 + 0.5 * cos(6.2832 * g.x) : 0.5 + 0.5 * cos(6.2832 * g.y);
  float thread = over > 0.5 ? sin(3.1416 * fract(g.y)) : sin(3.1416 * fract(g.x));
  return clamp(0.55 * thread + 0.15 * th + 0.3 * pp_noise(p * 3.7), 0.0, 1.0);
}
`;

export const strokeVS = MAP + `
attribute vec2 a_pos;
attribute vec2 a_ext;
attribute vec2 a_vc;
attribute vec2 a_tan;
attribute float a_hw;
attribute vec2 a_along;
attribute float a_weave;
attribute vec2 a_ink;         // (slowness of the pen, sharpness of the turn)

uniform float u_lightFollow;  // 1 = light lives in each copy's local frame
uniform float u_zOff;         // depth slice centre (recursion layering)
uniform float u_zScale;       // slice half-width; sign: + later part nearer, − earlier part nearer
uniform float u_weaveOn;      // 1 = depth from the weave height profile
attribute float i_idx;        // per copy: draw-order index in [0, 1)
uniform float u_softZ;        // 1 = translucent wash: one depth per copy, so a copy paints each pixel once

varying vec2 v_dc;
varying float v_hw;
varying float v_pad;
varying vec2 v_along;
varying vec2 v_T;
varying vec2 v_N;
varying vec2 v_cl;            // local (pre-copy) position, for crop-to-cell
varying vec2 v_ink;
varying vec2 v_wp;            // world position (the paper lives here)

void main() {
  vec2 w0 = mobP(a_pos);
  mat2 J = warpJ(w0) * mobJ(a_pos);
  float det = abs(J[0][0] * J[1][1] - J[1][0] * J[0][1]);
  float sl = sqrt(max(det, 1e-12));
  float pad = u_pxWorld / sl;                  // ~1 device pixel in local units
  float e = a_hw + pad;
  vec2 p = warpP(w0) + J * (a_ext * e);
  vec3 c = u_view * vec3(p, 1.0);
  float zv = u_weaveOn > 0.5 ? (-0.9 * a_weave + 0.05 * (1.0 - 2.0 * a_along.x)) : (1.0 - 2.0 * a_along.x);
  gl_Position = vec4(c.xy, u_softZ > 0.5 ? 0.999 - 1.998 * i_idx : u_zOff + u_zScale * zv, 1.0);
  v_dc = a_vc * e;
  v_cl = a_pos + a_ext * e;
  v_ink = a_ink;
  v_wp = p;
  v_hw = a_hw;
  v_pad = pad;
  v_along = a_along;
  vec2 T = a_tan;
  vec2 N = vec2(-T.y, T.x);
  if (u_lightFollow > 0.5) { v_T = T; v_N = N; }
  else { v_T = normalize(J * T); v_N = normalize(J * N); }
}
`;

export const strokeFS = PREC + PAPER + `
uniform float u_mode;
uniform float u_pool;        // ink pooling amount
uniform float u_tooth;       // how much this stroke catches on the paper (0 = not at all)
uniform vec4 u_bristle;      // hairs, dryness, spread on turns, colour blend
uniform vec4 u_stamp;        // spacing (× width), scatter, rotation jitter, size jitter
uniform vec3 u_stamp2;       // tip (0 round · 1 flat · 2 chalk · 3 sponge · 4 splatter · 5 image), flow, has image
uniform float u_stampPad;    // the strip is this much wider than the brush (room for scatter)
uniform sampler2D u_tip;
varying vec2 v_ink;
varying vec2 v_wp;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform float u_grad;
uniform float u_gradPeriod;
uniform float u_opacity;
uniform vec3 u_light;
uniform float u_ambient;
uniform float u_spec;
uniform float u_shine;
uniform float u_twist;
uniform float u_lines;
uniform float u_bevel;
uniform float u_glow;
uniform float u_pass;       // 0 = plain, 1 = fully covered pixels only, 2 = AA fringe only
uniform vec4 u_chain;       // (offset, own length, chain length, reversed) — touching strokes share one gradient
uniform vec2 u_join;        // (start linked, end linked): linked caps shade as tube continuation
uniform float u_loop;       // 1 = the line closes on itself: mirror the along-gradient so it has no seam
uniform vec3 u_dash;        // (0 none | 1 dash | 2 dot, dash length, gap) — local units, loop-fitted
uniform float u_strands;    // rope / sketch strand count
uniform float u_rough;      // sketch wobble, dry-brush dryness, watercolour grain
uniform float u_outline;    // outline rim thickness (fraction of the half width)
uniform vec2 u_stitch;      // (spacing, slant)
uniform float u_seed;       // per-stroke noise seed
uniform float u_baseHw;     // nominal half width (local): noise scales don't explode where the stroke tapers
uniform float u_softZ;      // 1 = translucent wash: interiors judged by geometric coverage
uniform vec4 u_shade;       // graphite shading: (end amount, end length (local), edge amount, grain)
uniform vec3 u_shade2;      // (shade start, shade end, side bias −1…1)
uniform vec3 u_shadeCol;
uniform float u_ink;        // ink outline width (local units, 0 = off)
uniform vec3 u_inkCol;

varying vec2 v_dc;
varying float v_hw;
varying float v_pad;
varying vec2 v_along;
varying vec2 v_T;
varying vec2 v_N;
varying vec2 v_cl;

uniform float u_clipN;      // crop to cell: number of sites / point operations
uniform float u_clipMode;   // 0 off · 1 Dirichlet cell · 3 wallpaper asymmetric unit
uniform vec2 u_clipC;       // the cell's own site
uniform float u_clipW0;     // its distance weight (1, or the hyperbolic factor)
uniform vec3 u_clipP[16];   // Dirichlet: neighbouring sites (x, y, weight) · wallpaper: ops (packed rotation, tx, ty)
uniform vec2 u_clipO;       // wallpaper: lattice origin, inverse basis, h⁻¹ rows (lattice coordinates)
uniform mat2 u_clipBi;
uniform vec3 u_clipH0;
uniform vec3 u_clipH1;
bool cropped(vec2 l) {
  if (u_clipMode < 0.5) return false;
  if (u_clipMode > 2.5) {
    vec2 f0 = u_clipBi * (l - u_clipO);
    vec2 f = vec2(dot(u_clipH0.xy, f0) + u_clipH0.z, dot(u_clipH1.xy, f0) + u_clipH1.z);
    const float E = 1e-5;
    if (f.x < -E || f.y < -E || f.x >= 1.0 + E || f.y >= 1.0 + E) return true;
    f = clamp(f, 0.0, 1.0 - 1e-7);
    for (int j = 0; j < 16; j++) {
      if (float(j) >= u_clipN) break;
      float k = u_clipP[j].x;
      float m11 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m10 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m01 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m00 = k - 1.0;
      vec2 g = vec2(m00 * f.x + m01 * f.y, m10 * f.x + m11 * f.y) + u_clipP[j].yz;
      g -= floor(g + E);                       // reduce into [0,1); a coordinate a hair below 1 wraps to 0
      if (g.y < f.y - E || (abs(g.y - f.y) <= E && g.x < f.x - E)) return true;
    }
    return false;
  }
  vec2 d = l - u_clipC;
  float d0 = dot(d, d) * u_clipW0;
  for (int j = 0; j < 16; j++) {
    if (float(j) >= u_clipN) break;
    vec2 e = l - u_clipP[j].xy;
    if (dot(e, e) * u_clipP[j].z < d0) return true;
  }
  return false;
}

vec3 shade(vec3 base, vec3 n) {
  float lam = max(dot(n, u_light), 0.0);
  vec3 r = reflect(-u_light, n);
  float sp = pow(max(r.z, 0.0), u_shine) * u_spec;
  return base * (u_ambient + (1.0 - u_ambient) * lam) + vec3(sp);
}

float hash1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash2(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float vnoise1(float x) { float i = floor(x), f = fract(x); return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}

// arc length along the whole chain of touching strokes
float chainS() { return u_chain.w > 0.5 ? u_chain.x + (u_chain.y - v_along.y) : u_chain.x + v_along.y; }

float gradT(vec2 q, float rn) {
  if (u_grad < 0.5) return 0.0;
  if (u_grad < 1.5) {
    float u = chainS() / max(u_chain.z, 1e-3);
    return u_loop > 0.5 ? 1.0 - abs(2.0 * u - 1.0) : u;   // loops: A → B halfway → back to A
  }
  if (u_grad < 2.5) return q.x * 0.5 + 0.5;
  if (u_grad < 3.5) return rn;
  float b = fract(chainS() / max(u_gradPeriod, 1.0));
  return 1.0 - abs(b * 2.0 - 1.0);
}

float tipShape(vec2 uv, float k) {
  int t = int(u_stamp2.x + 0.5);
  float r = length(uv);
  if (t == 0) return 1.0 - smoothstep(0.3, 1.0, r);
  if (t == 1) return 1.0 - smoothstep(0.7, 1.0, length(uv * vec2(3.2, 1.0)));
  if (t == 2) {
    float m = 1.0 - smoothstep(0.65, 1.0, r);
    float g = 0.6 * vnoise2(uv * 5.0 + k * 3.1) + 0.4 * vnoise2(uv * 13.0 - k * 1.7);
    return m * smoothstep(0.32, 0.62, g + 0.25 * (1.0 - r));
  }
  if (t == 3) {
    float m = 1.0 - smoothstep(0.7, 1.0, r);
    vec2 p = uv * 3.2 + k * 2.3, i = floor(p), f = fract(p);
    float F1 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      F1 = min(F1, length(o + vec2(hash2(i + o), hash2(i + o + 7.7)) - f));
    }
    return m * smoothstep(0.18, 0.34, F1);
  }
  if (t == 4) {
    float m = 0.0;
    for (int j = 0; j < 7; j++) {
      float fj = float(j);
      vec2 c = vec2(hash1(k * 3.1 + fj * 1.7), hash1(k * 5.3 + fj * 2.9)) * 1.6 - 0.8;
      float rad = 0.07 + 0.17 * hash1(k * 7.9 + fj * 4.1);
      m = max(m, 1.0 - smoothstep(rad * 0.75, rad, length(uv - c)));
    }
    return m;
  }
  if (any(greaterThan(abs(uv), vec2(1.0)))) return 0.0;
  return texture2D(u_tip, uv * 0.5 + 0.5).a;
}

void main() {
  if (cropped(v_cl)) discard;
  float hw = max(v_hw, 1e-4);
  float aa = max(v_pad, 1e-5);
  float r = length(v_dc);
  float edge = clamp((hw - r) / aa + 0.5, 0.0, 1.0);          // coverage keeps the round cap outline
  // a cap at a linked end is shaded as if the tube carried straight on (no dome at the join)
  float linked = v_dc.y < 0.0 ? u_join.x : (v_dc.y > 0.0 ? u_join.y : 0.0);
  vec2 q = vec2(v_dc.x, v_dc.y * (1.0 - linked)) / hw;
  float rn = min(length(q), 1.0);
  float sC = chainS();
  // dash pattern (any mode): dashes cut coverage; dots turn the stroke into a row of spheres
  float dashCov = 1.0;
  if (u_dash.x > 0.5 && v_dc.y == 0.0) {
    float P = max(u_dash.y + u_dash.z, 1e-3);
    float ph = mod(sC, P);
    if (u_dash.x < 1.5) {
      dashCov = clamp(min(ph, u_dash.y - ph) / aa + 0.5, 0.0, 1.0);
    } else {
      vec2 dd = vec2(v_dc.x, ph - 0.5 * P);
      r = length(dd);
      edge = clamp((hw - r) / aa + 0.5, 0.0, 1.0);
      // only whole dots: drop one that would be cut by an open end of the line
      float sc = sC - ph + 0.5 * P;
      if (u_loop < 0.5 && (sc - hw < 0.0 || sc + hw > u_chain.z)) edge = 0.0;
      q = dd / hw;
      rn = min(length(q), 1.0);
    }
  } else if (u_dash.x > 0.5) {
    dashCov = u_dash.x < 1.5 ? 1.0 : 0.0;   // caps: dashes keep them, dots replace them
  }
  vec3 base = mix(u_colA, u_colB, clamp(gradT(q, rn), 0.0, 1.0));
  vec2 lat = v_N * q.x + v_T * q.y;
  int mode = int(u_mode + 0.5);

  vec3 col = base;
  float a = edge;
  float geo = edge;            // geometric coverage (wash modes keep alpha and shape apart)

  if (mode == 1) {
    vec3 n = normalize(vec3(lat, sqrt(max(0.0, 1.0 - rn * rn))));
    col = shade(base, n);
  } else if (mode == 2) {
    float phi = chainS() * u_twist * 6.2831853 / 100.0;
    float cphi = cos(phi);
    float hwE = hw * max(abs(cphi), 0.06);
    a = clamp((hwE - abs(v_dc.x)) / aa + 0.5, 0.0, 1.0) * clamp(1.0 - abs(v_dc.y) * (1.0 - linked) / aa, 0.0, 1.0) * (linked > 0.5 ? edge : 1.0);
    vec3 n = normalize(vec3(v_N * sin(phi), cphi));
    if (n.z < 0.0) n = -n;
    vec3 face = cphi >= 0.0 ? base : u_colB;
    col = shade(face, n);
  } else if (mode == 3) {
    float g = exp(-3.2 * rn * rn) * (1.0 - smoothstep(0.8, 1.0, rn));
    a = g * edge * u_glow;
  } else if (mode == 4) {
    float core = 1.0 - smoothstep(0.12, 0.32, rn);
    float halo = exp(-4.0 * rn * rn) * (1.0 - smoothstep(0.85, 1.0, rn));
    col = mix(base, vec3(1.0), core * 0.85);
    a = clamp(core + halo * u_glow, 0.0, 1.0) * edge;
  } else if (mode == 5) {
    a = pow(1.0 - rn, 1.6) * edge;
  } else if (mode == 6) {
    vec3 n = normalize(vec3(lat, sqrt(max(0.0, 1.0 - rn * rn))));
    float lum = clamp(dot(shade(vec3(1.0), n), vec3(0.3333)), 0.0, 1.0);
    float f = q.x * u_lines * 0.5 + 0.5;
    float stripe = abs(fract(f) - 0.5) * 2.0;
    float sw = max(u_lines * aa / hw, 1e-3);
    float thr = clamp(1.0 - lum, 0.04, 0.98);
    float ink = clamp((thr - stripe) / sw + 0.5, 0.0, 1.0);
    a = ink * edge;
  } else if (mode == 7) {
    float s = smoothstep(1.0 - u_bevel, 1.0, rn);
    vec2 dir = rn > 1e-4 ? lat / rn : vec2(0.0);
    vec3 n = normalize(vec3(dir * s * 1.6, 1.0));
    col = shade(base, n);
  } else if (mode == 8) {
    vec3 n = normalize(vec3(lat, sqrt(max(0.0, 1.0 - rn * rn))));
    vec3 rv = reflect(vec3(0.0, 0.0, -1.0), n);
    float h = -rv.y;
    vec3 sky = mix(vec3(1.0), u_colA, smoothstep(0.0, 0.9, h));
    vec3 ground = mix(u_colB * 0.35, u_colB, smoothstep(-0.9, -0.05, h));
    col = h > 0.0 ? sky : ground;
    col = mix(ground, col, smoothstep(-0.03, 0.03, h));
    vec3 rl = reflect(-u_light, n);
    col += vec3(pow(max(rl.z, 0.0), u_shine) * u_spec);
  } else if (mode == 9) {
    // rope: N lit strands twisting round the centreline; the front-most strand wins each pixel
    float n = clamp(u_strands, 2.0, 8.0);
    float rs = min(0.62, 1.25 / n + 0.12);
    float R = 1.0 - rs;
    float phi = sC * max(u_twist, 0.05) * 6.2831853 / 100.0;
    float best = -2.0, t = 0.0, cov = 0.0, kk = 0.0;
    for (int k = 0; k < 8; k++) {
      if (float(k) >= n) break;
      float ang = phi + 6.2831853 * float(k) / n;
      float c = R * sin(ang), z = cos(ang);
      float dpx = (rs - abs(q.x - c)) * hw / aa;       // pixels inside this strand
      if (dpx > -0.5 && z > best) { best = z; t = (q.x - c) / rs; cov = clamp(dpx + 0.5, 0.0, 1.0); kk = float(k); }
    }
    t = clamp(t, -1.0, 1.0);
    vec3 nn = normalize(vec3(v_N * t * 0.9 + v_T * 0.35 * t * sign(sin(phi)), sqrt(max(0.0, 1.0 - t * t))));
    vec3 sc = u_grad < 0.5 ? mix(base, u_colB, mod(kk, 2.0) * 0.55) : base;
    col = shade(sc, nn) * (0.78 + 0.22 * (best * 0.5 + 0.5));
    a = cov * (v_dc.y == 0.0 || linked > 0.5 ? 1.0 : edge);
  } else if (mode == 10) {
    // pencil sketch: N thin wobbly lines across the width, occasionally broken
    float n = clamp(u_strands, 1.0, 8.0);
    float lw = max(0.55 * aa, 0.28 * hw / n);
    float cov = 0.0;
    for (int k = 0; k < 8; k++) {
      if (float(k) >= n) break;
      float fk = float(k);
      float off = (n > 1.0 ? ((fk + 0.5) / n * 2.0 - 1.0) * 0.78 : 0.0);
      off += u_rough * 0.35 * (vnoise1(sC / (u_baseHw * 3.0) + fk * 7.13 + u_seed) * 2.0 - 1.0);
      float d = abs(v_dc.x - off * hw);
      float line = clamp((lw - d) / aa + 0.5, 0.0, 1.0);
      line *= smoothstep(0.12, 0.3, vnoise1(sC / (u_baseHw * 9.0) + fk * 3.7 + u_seed * 1.3) + 0.35 * (1.0 - u_rough));
      cov = max(cov, line);
    }
    col = base * (0.9 + 0.1 * vnoise1(sC * 0.7 + u_seed));
    a = cov * (v_dc.y == 0.0 || linked > 0.5 ? 1.0 : 0.0);
  } else if (mode == 11) {
    // dry brush: bristle streaks parallel to the stroke, thinning out as the paint runs dry
    float streak = vnoise2(vec2(q.x * 9.0 + u_seed, sC / (u_baseHw * 5.0))) * 0.65 + vnoise2(vec2(q.x * 23.0 - u_seed, sC / (u_baseHw * 2.0))) * 0.35;
    float dry = u_rough * (0.25 + 0.75 * clamp(sC / max(u_chain.z, 1e-3), 0.0, 1.0));
    float thr = 0.12 + 0.7 * dry;
    float ragged = 1.0 - smoothstep(0.75, 1.0, rn + 0.18 * (vnoise2(vec2(sC / u_baseHw * 0.8, u_seed)) - 0.5) * u_rough);
    a = smoothstep(thr - 0.06, thr + 0.06, streak) * ragged * edge;
    col = base * (0.82 + 0.3 * streak);
  } else if (mode == 12) {
    // watercolour: translucent wash, darker pooled rim, paper grain, ragged edge
    float rag = 1.0 - 0.14 * u_rough * vnoise1(sC / (u_baseHw * 1.5) + u_seed);
    float re = rn / rag;
    float wet = clamp((hw * rag - r) / aa + 0.5, 0.0, 1.0);
    float rim = smoothstep(0.55, 0.98, re);
    float grain = vnoise2(gl_FragCoord.xy * 0.35 + u_seed) - 0.5;
    col = base * (1.0 - 0.38 * rim) * (1.0 + 0.2 * grain * u_rough);
    a = (0.42 + 0.38 * rim + 0.22 * grain * u_rough) * wet;
    geo = wet;
  } else if (mode == 13) {
    // outline: hollow stroke, the rim shaded as a small tube
    float th = clamp(u_outline, 0.05, 0.95);
    float inner = hw * (1.0 - th);
    a = edge * clamp((r - inner) / aa + 0.5, 0.0, 1.0);
    if (linked > 0.5) a = edge * clamp((abs(v_dc.x) - inner) / aa + 0.5, 0.0, 1.0);
    float rr = linked > 0.5 ? abs(v_dc.x) : r;
    float t = clamp((rr - (hw - th * hw * 0.5)) / (th * hw * 0.5), -1.0, 1.0);
    vec2 dir = rn > 1e-4 ? lat / rn : vec2(0.0);
    vec3 nn = normalize(vec3(dir * t, sqrt(max(0.0, 1.0 - t * t))));
    col = shade(base, nn);
  } else if (mode == 15) {
    // bristle brush: separate hairs, each with its own load of paint; they run dry at different
    // points and part on turns. Colours blend from A to B across the brush.
    float N = max(u_bristle.x, 2.0);
    float hx = clamp(v_dc.x / hw * 0.5 + 0.5, 0.0, 0.9999) * N;
    float hi = floor(hx);
    float ht = fract(hx) * 2.0 - 1.0;
    float load = 0.35 + 0.65 * hash1(hi * 7.31 + u_seed);
    float thick = (0.82 + 0.3 * hash1(hi * 3.17 + u_seed + 1.0)) * (1.0 - u_bristle.z * 0.6 * v_ink.y);
    float hair = clamp((thick - abs(ht)) / (aa * N / hw * 0.5 + 1e-3) + 0.5, 0.0, 1.0);
    float dryAt = u_chain.z * mix(1.4, 0.25, u_bristle.y) * (0.45 + 0.55 * load);
    float run = 1.0 - smoothstep(dryAt * 0.55, dryAt, sC);
    float streak = vnoise2(vec2(sC / max(u_baseHw * 0.35, 0.5), hi * 3.7 + u_seed));
    float paint = clamp(run * 1.6 - (1.0 - load) * 0.4 - streak * (1.0 - run) * 1.2, 0.0, 1.0);
    a = edge * hair * smoothstep(0.05, 0.35, paint);
    vec3 hc = mix(u_colA, u_colB, clamp(hx / N + (hash1(hi * 1.9 + u_seed) - 0.5) * 0.35, 0.0, 1.0));
    col = mix(base, hc, u_bristle.w) * (0.78 + 0.22 * sqrt(max(0.0, 1.0 - ht * ht)));
    col += vec3(0.08) * pow(max(0.0, 1.0 - abs(ht + 0.35) * 2.2), 3.0);
  } else if (mode == 16) {
    // stamp brush: a tip shape stamped along the path with spacing, scatter, rotation and size jitter
    float hT = hw / max(u_stampPad, 1.0);
    float bT = max(u_baseHw, 0.25);
    float sp = max(u_stamp.x * 2.0 * bT, 0.35);
    float sA = sC + v_dc.y * (1.0 - linked);
    float k0 = floor(sA / sp);
    float acc = 0.0;
    for (int i = -4; i <= 4; i++) {
      float k = k0 + float(i);
      float h1 = hash1(k * 1.37 + u_seed), h2 = hash1(k * 2.71 + u_seed + 3.0);
      float h3 = hash1(k * 5.13 + u_seed + 7.0), h4 = hash1(k * 7.70 + u_seed + 11.0);
      float cs = (k + 0.5) * sp + (h1 - 0.5) * sp * 0.8 * min(u_stamp.y, 1.0);
      if (u_loop < 0.5 && (cs < -0.5 * sp || cs > u_chain.z + 0.5 * sp)) continue;
      float sz = hT * max(0.1, 1.0 + (h3 - 0.5) * 2.0 * u_stamp.w);
      float co = (h2 - 0.5) * 2.0 * u_stamp.y * hT;
      vec2 d = vec2(sA - cs, v_dc.x - co) / max(sz, 1e-3);
      if (abs(d.x) > 1.5 || abs(d.y) > 1.5) continue;
      float rot = (h4 - 0.5) * 6.2832 * u_stamp.z;
      float c = cos(rot), sn = sin(rot);
      vec2 uv = vec2(c * d.x + sn * d.y, -sn * d.x + c * d.y);
      acc = 1.0 - (1.0 - acc) * (1.0 - clamp(tipShape(uv, k), 0.0, 1.0) * u_stamp2.y);
    }
    a = acc;
    geo = a;
  } else if (mode == 14) {
    // stitch: slanted marks across the stroke at a fixed spacing
    float P = max(u_stitch.x, 1e-3);
    float ph = mod(sC + q.x * hw * u_stitch.y, P);
    float d = min(ph, P - ph);
    float wdt = max(0.6 * aa, 0.18 * P);
    a = clamp((wdt - d) / aa + 0.5, 0.0, 1.0) * clamp((hw * 0.92 - abs(v_dc.x)) / aa + 0.5, 0.0, 1.0) * (v_dc.y == 0.0 || linked > 0.5 ? 1.0 : 0.0);
    vec3 nn = normalize(vec3(lat * 0.6, 1.0));
    col = shade(base, nn);
  }
  // Zentangle-style graphite shading, on top of any mode: darkest where the line ends (it tucks
  // under its neighbour), reaching further along the edges than down the middle, plus edge shading
  float ax = clamp(abs(v_dc.x) / hw, 0.0, 1.0);
  if (u_shade.x > 0.0 || u_shade.z > 0.0) {
    float kEnd = 0.0;
    if (u_shade.x > 0.0 && u_loop < 0.5) {
      float d = 1e9;
      if (u_shade2.x > 0.5) d = min(d, sC);
      if (u_shade2.y > 0.5) d = min(d, u_chain.z - sC);
      float L = max(u_shade.y, 1e-3);
      kEnd = u_shade.x * (1.0 - smoothstep(0.0, L, d - 0.6 * L * ax * ax));
    }
    float side = v_dc.x >= 0.0 ? 1.0 : -1.0;
    float kEdge = u_shade.z * smoothstep(0.25, 1.0, ax) * clamp(1.0 + u_shade2.z * side, 0.0, 1.0);
    float k = 1.0 - (1.0 - kEnd) * (1.0 - kEdge);
    if (u_shade.w > 0.0) {
      vec2 gp = vec2(sC, v_dc.x) * (2.5 / max(u_baseHw, 0.25)) + u_seed;
      float g = 0.65 * vnoise2(gp) + 0.35 * vnoise2(gp * 3.1 + 7.0);
      k *= mix(1.0, 0.45 + 1.1 * g, u_shade.w);
    }
    col = mix(col, u_shadeCol, clamp(k, 0.0, 1.0));
  }
  // ink pooling: the pen leaves more ink where it slows, on turns, along the edges and in the blots
  // where it lands and lifts
  if (u_pool > 0.0) {
    float k = 0.55 * v_ink.x + 0.45 * v_ink.y;
    float kEdge = smoothstep(0.55, 1.0, ax) * (0.3 + 0.7 * v_ink.x);
    float kEnd = 0.0;
    if (u_loop < 0.5) {
      float de = min(linked > 0.5 && v_dc.y < 0.0 ? 1e9 : sC, linked > 0.5 && v_dc.y > 0.0 ? 1e9 : u_chain.z - sC);
      if (u_join.x > 0.5) de = max(de, sC < u_chain.z * 0.5 ? 1e9 : de);
      kEnd = 1.0 - smoothstep(0.0, max(u_baseHw, 0.25) * 2.2, de);
    }
    float kk = clamp(u_pool * (k + 0.6 * kEdge + 0.7 * kEnd), 0.0, 1.0);
    col *= 1.0 - 0.6 * kk;
    a = min(1.0, a * (1.0 + 0.25 * kk));
  }
  // paper: dry media skip the valleys of the sheet, washes settle into them
  if (u_paper.x > 0.5 && u_tooth > 0.0) {
    float hgt = paperH(v_wp);
    float amt = clamp(u_tooth * u_paper.z, 0.0, 1.0);
    if (mode == 12 || mode == 5) {
      col *= 1.0 - 0.45 * amt * (1.0 - hgt);
      a *= mix(1.0, 0.7 + 0.6 * (1.0 - hgt), amt);
    } else {
      float load = 0.42 + 0.35 * clamp(v_hw / max(u_baseHw, 0.25), 0.0, 1.2);
      float keep = smoothstep(0.0, 0.28, hgt - (1.0 - load));
      a *= mix(1.0, keep, amt);
    }
  }
  // ink outline: a pen line along both edges and round the caps (not across a blended join)
  if (u_ink > 0.0) {
    float rr = linked > 0.5 ? abs(v_dc.x) : r;
    col = mix(col, u_inkCol, clamp((rr - (hw - u_ink)) / aa + 0.5, 0.0, 1.0));
  }

  a *= dashCov;
  geo *= dashCov;

  if (u_pass > 0.5) {
    bool interior = (u_softZ > 0.5 ? geo : a) >= 0.999;
    if (u_pass < 1.5) { if (!interior) discard; }
    else if (interior) discard;
  }
  a *= u_opacity;
  gl_FragColor = vec4(col * a, a);
}
`;

export const fillVS = MAP + `
attribute vec2 a_pos;
attribute vec2 a_nrm;       // fringe strip: outward-ish normal (zero for fan / cover)
attribute float a_side;     // fringe strip: −1 … +1 across the 2-px band
uniform float u_lightFollow;
varying vec2 v_local;
varying float v_side;
varying float v_pxl;
varying vec2 v_l0;
varying vec2 v_l1;
varying vec2 v_wp;
void main() {
  vec2 w0 = mobP(a_pos);
  mat2 J = warpJ(w0) * mobJ(a_pos);
  float det = abs(J[0][0] * J[1][1] - J[1][0] * J[0][1]);
  float sl = sqrt(max(det, 1e-12));
  float pad = u_pxWorld / sl;
  vec2 off = a_nrm * (a_side * pad);
  vec2 p = warpP(w0) + J * off;
  vec3 c = u_view * vec3(p, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
  v_local = a_pos + off;
  v_wp = p;
  v_side = a_side;
  v_pxl = pad;
  mat2 Ln = u_lightFollow > 0.5 ? mat2(1.0) : J * (1.0 / sl);
  v_l0 = Ln[0];
  v_l1 = Ln[1];
}
`;

export const fillFS = PREC + PAPER + `
varying vec2 v_wp;
uniform float u_fmode;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform float u_opacity;
uniform float u_angle;
uniform vec4 u_bbox;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_fscale;     // texture scale (local units per repeat)
uniform float u_fthick;     // line thickness / contrast 0..1
uniform float u_flit;       // 1 = apply dome lighting
uniform float u_fringe;     // 1 = drawing the anti-aliased edge band
uniform vec3 u_light;
uniform float u_ambient;
uniform float u_spec;
uniform float u_shine;
varying vec2 v_local;
varying float v_side;
varying float v_pxl;
varying vec2 v_l0;
varying vec2 v_l1;

uniform float u_clipN;      // crop to cell: number of sites / point operations
uniform float u_clipMode;   // 0 off · 1 Dirichlet cell · 3 wallpaper asymmetric unit
uniform vec2 u_clipC;       // the cell's own site
uniform float u_clipW0;     // its distance weight (1, or the hyperbolic factor)
uniform vec3 u_clipP[16];   // Dirichlet: neighbouring sites (x, y, weight) · wallpaper: ops (packed rotation, tx, ty)
uniform vec2 u_clipO;       // wallpaper: lattice origin, inverse basis, h⁻¹ rows (lattice coordinates)
uniform mat2 u_clipBi;
uniform vec3 u_clipH0;
uniform vec3 u_clipH1;
bool cropped(vec2 l) {
  if (u_clipMode < 0.5) return false;
  if (u_clipMode > 2.5) {
    vec2 f0 = u_clipBi * (l - u_clipO);
    vec2 f = vec2(dot(u_clipH0.xy, f0) + u_clipH0.z, dot(u_clipH1.xy, f0) + u_clipH1.z);
    const float E = 1e-5;
    if (f.x < -E || f.y < -E || f.x >= 1.0 + E || f.y >= 1.0 + E) return true;
    f = clamp(f, 0.0, 1.0 - 1e-7);
    for (int j = 0; j < 16; j++) {
      if (float(j) >= u_clipN) break;
      float k = u_clipP[j].x;
      float m11 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m10 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m01 = mod(k, 3.0) - 1.0; k = floor(k / 3.0 + 0.01);
      float m00 = k - 1.0;
      vec2 g = vec2(m00 * f.x + m01 * f.y, m10 * f.x + m11 * f.y) + u_clipP[j].yz;
      g -= floor(g + E);                       // reduce into [0,1); a coordinate a hair below 1 wraps to 0
      if (g.y < f.y - E || (abs(g.y - f.y) <= E && g.x < f.x - E)) return true;
    }
    return false;
  }
  vec2 d = l - u_clipC;
  float d0 = dot(d, d) * u_clipW0;
  for (int j = 0; j < 16; j++) {
    if (float(j) >= u_clipN) break;
    vec2 e = l - u_clipP[j].xy;
    if (dot(e, e) * u_clipP[j].z < d0) return true;
  }
  return false;
}

float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.97;
}
float lineInk(float y, float px) {           // y in repeat units, px = repeat units per pixel
  float d = abs(fract(y + 0.5) - 0.5);
  return clamp((u_fthick * 0.5 - d) / max(px, 1e-4) + 0.5, 0.0, 1.0);
}

// ---- pattern fills ---------------------------------------------------------------------------
// q in repeat units, px = repeat units per pixel. Each returns the colour; A = paper/body, B = ink.
float inkLine(float dist, float px) {           // anti-aliased pen line centred on dist = 0
  float lw = 0.012 + 0.05 * u_fthick;
  return clamp((lw - abs(dist)) / max(px, 1e-4) + 0.5, 0.0, 1.0);
}
vec3 graphite(vec3 c, float k, vec2 q) {        // pencil shading toward colour B, with a little grain
  float g = 0.75 + 0.5 * vnoise(q * 23.0);
  return mix(c, u_colB, clamp(k * g, 0.0, 1.0) * 0.85);
}
// Plaitwork: two families of ribbons, alternately over and under; each ribbon darkens where it dives.
vec3 patPlait(vec2 q, float px) {
  float bw = 0.30;
  float hy = abs(fract(q.y) - 0.5), vx = abs(fract(q.x) - 0.5);
  bool inH = hy < bw, inV = vx < bw;
  float par = mod(floor(q.x) + floor(q.y), 2.0);
  if (!inH && !inV) return mix(u_colB, u_colA, 0.08);
  bool hTop = inH && (!inV || par < 0.5);
  float across = hTop ? hy : vx;                       // distance from the ribbon's centre line
  float along = hTop ? q.x : q.y;                       // position along it
  float row = hTop ? floor(q.y) : floor(q.x);
  // nearest crossing where this ribbon goes under: parity of (crossing column + row) = 1 for H
  float k0 = floor(along);
  float dUnder = 9.0;
  for (int i = -1; i <= 1; i++) {
    float k = k0 + float(i);
    float under = mod(k + row, 2.0);
    if ((hTop && under > 0.5) || (!hTop && under < 0.5)) dUnder = min(dUnder, abs(along - (k + 0.5)) - bw);
  }
  vec3 c = graphite(u_colA, 1.0 - smoothstep(0.0, 0.45, dUnder - 0.35 * (across / bw) * (across / bw) * 0.3), q);
  c = graphite(c, smoothstep(0.55, 1.0, across / bw) * 0.35, q);
  float edge = inkLine(across - bw, px);
  float tuck = dUnder < 0.02 ? 1.0 : inkLine(dUnder, px);
  return mix(c, u_colB, max(edge, tuck));
}
// Pebbles: rounded stones packed in a Voronoi layout, each lit from the top left.
vec3 patPebbles(vec2 q, float px) {
  vec2 i = floor(q), f = fract(q);
  float F1 = 8.0, F2 = 8.0; vec2 c1 = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 site = o + 0.15 + hash2(i + o) * 0.7;
    float dd = length(site - f);
    if (dd < F1) { F2 = F1; F1 = dd; c1 = site - f; } else if (dd < F2) F2 = dd;
  }
  float gap = (F2 - F1) * 0.5;                           // distance to the cell wall
  float rim = 0.025 + 0.035 * u_fthick;
  if (gap < rim) return mix(u_colB, u_colA, 0.06);
  float inner = clamp((gap - rim) / 0.3, 0.0, 1.0);
  vec2 L = normalize(vec2(-0.6, -0.8));
  float lit = dot(normalize(-c1 + 1e-4), L);            // which side of the stone faces the light
  vec3 c = graphite(u_colA, (1.0 - inner) * 0.8 * (0.6 - 0.4 * lit), q);
  c = mix(c, vec3(1.0), smoothstep(0.75, 1.0, inner) * 0.25 * max(lit, 0.0));
  return mix(c, u_colB, inkLine(gap - rim, px));
}
// Scallops: rows of shell scales; each row tucks under the row above, shaded where it disappears.
vec3 patScallops(vec2 q, float px) {
  float R = 0.62;
  float j0 = floor(q.y / 0.5);
  for (int dj = -2; dj <= 0; dj++) {                    // the upper row (smaller j) lies on top
    float j = j0 + float(dj);
    float off = mod(j, 2.0) * 0.5;
    for (int di = -1; di <= 1; di++) {
      float ci = floor(q.x - off) + float(di) + 0.5 + off;
      vec2 d = q - vec2(ci, j * 0.5);
      float r = length(d);
      if (r < R && d.y >= 0.0) {
        vec3 c = graphite(u_colA, (1.0 - smoothstep(0.0, 0.3, d.y)) * 0.75, q);
        float ink = max(inkLine(r - R, px), max(inkLine(r - R * 0.7, px) * 0.7, inkLine(r - R * 0.42, px) * 0.5));
        return mix(c, u_colB, ink);
      }
    }
  }
  return mix(u_colB, u_colA, 0.08);
}
// Orb rings: a hex grid of orbs with concentric rings and a crescent of shading.
vec3 patOrbs(vec2 q, float px) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(q, s) - s * 0.5, b = mod(q + s * 0.5, s) - s * 0.5;
  vec2 d = dot(a, a) < dot(b, b) ? a : b;
  float r = length(d);
  float R = 0.46;
  if (r > R) return mix(u_colB, u_colA, 0.08);
  vec3 c = graphite(u_colA, smoothstep(0.0, R, length(d - vec2(-0.12, -0.14))) * 0.7, q);
  float rings = 0.0;
  for (int k = 1; k <= 3; k++) rings = max(rings, inkLine(r - R * float(k) / 3.6, px) * (1.0 - 0.2 * float(k)));
  return mix(c, u_colB, max(inkLine(r - R, px), rings));
}
// Chevron folds: a zigzag ribbon folded back and forth, alternate panels in shadow.
vec3 patChevron(vec2 q, float px) {
  float z = abs(fract(q.x) - 0.5) * 2.0;                // 0 at the folds' centre line, 1 at the creases
  float y = q.y + z * 0.5;
  float band = floor(y), fy = fract(y);
  float side = step(0.5, fract(q.x));                    // left or right face of the fold
  vec3 c = graphite(u_colA, (side > 0.5 ? 0.45 : 0.0) + 0.35 * (1.0 - smoothstep(0.0, 0.5, fy)) * side, q);
  if (mod(band, 2.0) > 0.5) c = mix(c, u_colB, 0.08);
  float crease = inkLine((fract(q.x) - 0.5) * 0.6, px) * 0.6;
  return mix(c, u_colB, max(inkLine(fy, px), max(inkLine(fy - 1.0, px), crease)));
}

void main() {
  if (cropped(v_local)) discard;
  int mode = int(u_fmode + 0.5);
  vec3 col = u_colA;
  vec2 d = v_local - u_center;
  float ca = cos(u_angle), sa = sin(u_angle);
  vec2 q = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) / max(u_fscale, 1e-3);
  float px = v_pxl / max(u_fscale, 1e-3);
  if (mode == 2) {
    vec2 dir = vec2(cos(u_angle), -sin(u_angle));
    vec2 ext = (u_bbox.zw - u_bbox.xy) * 0.5;
    float h = max(abs(dir.x) * ext.x + abs(dir.y) * ext.y, 1e-3);
    vec2 mid = (u_bbox.xy + u_bbox.zw) * 0.5;
    col = mix(u_colA, u_colB, clamp(dot(v_local - mid, dir) / h * 0.5 + 0.5, 0.0, 1.0));
  } else if (mode == 3 || mode == 4) {
    col = mix(u_colA, u_colB, clamp(length(d) / u_radius, 0.0, 1.0));
  } else if (mode == 5) {
    float c = mix(0.5, 0.03, u_fthick);
    col = mix(u_colA, u_colB, smoothstep(0.5 - c, 0.5 + c, fbm(q)));
  } else if (mode == 6) {
    col = mix(u_colB, u_colA, lineInk(q.y, px));
  } else if (mode == 7) {
    col = mix(u_colB, u_colA, max(lineInk(q.y, px), lineInk(q.x, px)));
  } else if (mode == 8) {
    vec2 g = vec2(q.x + 0.5 * floor(q.y), q.y);            // offset rows
    vec2 cell = fract(g) - 0.5;
    float ink = clamp((u_fthick * 0.5 - length(cell)) / max(px, 1e-4) + 0.5, 0.0, 1.0);
    col = mix(u_colB, u_colA, ink);
  } else if (mode == 9) {
    vec2 i = floor(q), f = fract(q);
    float F1 = 8.0, F2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      float dd = length(o + hash2(i + o) * 0.85 + 0.075 - f);
      if (dd < F1) { F2 = F1; F1 = dd; } else if (dd < F2) F2 = dd;
    }
    float border = 1.0 - clamp((F2 - F1 - u_fthick * 0.25) / max(px * 2.0, 1e-4) + 0.5, 0.0, 1.0);
    vec3 base = mix(u_colB, u_colA, clamp(F1 * 0.9, 0.0, 1.0));
    col = mix(base, u_colA * 0.3, border);
  } else if (mode == 10) {
    float t = 0.5 + 0.5 * sin((q.x + fbm(q * 1.5) * (1.5 + 6.0 * u_fthick)) * 3.14159);
    col = mix(u_colA, u_colB, t);
  } else if (mode == 11) col = patPlait(q, px);
  else if (mode == 12) col = patPebbles(q, px);
  else if (mode == 13) col = patScallops(q, px);
  else if (mode == 14) col = patOrbs(q, px);
  else if (mode == 15) col = patChevron(q, px);
  if (mode == 4 || u_flit > 0.5) {
    vec2 rq = d / max(u_radius, 1e-3);
    float rr = min(dot(rq, rq), 1.0);
    vec2 lq = mat2(v_l0, v_l1) * rq;
    vec3 n = normalize(vec3(lq, sqrt(1.0 - rr) + 0.05));
    float lam = max(dot(n, u_light), 0.0);
    vec3 r = reflect(-u_light, n);
    float sp = pow(max(r.z, 0.0), u_shine) * u_spec;
    col = col * (u_ambient + (1.0 - u_ambient) * lam) + vec3(sp);
  }
  float a = u_opacity;
  if (u_paper.x > 0.5) col *= 1.0 - 0.18 * u_paper.z * (0.6 - paperH(v_wp));
  if (u_fringe > 0.5) a *= clamp(0.5 - abs(v_side), 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

// Paper relief on the background: a multiply pass, lit from the top left.
export const paperVS = `
attribute vec2 a_pos;
uniform mat3 u_invView;
varying vec2 v_wp;
void main() {
  v_wp = (u_invView * vec3(a_pos, 1.0)).xy;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
export const paperFS = PREC + PAPER + `
varying vec2 v_wp;
uniform float u_pxw;          // world units per pixel
void main() {
  float e = max(u_paper.y * 0.35, u_pxw);
  float h = paperH(v_wp);
  float hx = paperH(v_wp + vec2(e, 0.0)) - h, hy = paperH(v_wp + vec2(0.0, e)) - h;
  float lit = clamp(0.5 + 1.6 * (-hx - hy), 0.0, 1.0);          // light from the top left
  float k = 1.0 - u_paper.z * (0.16 * (1.0 - lit) + 0.08 * (1.0 - h));
  gl_FragColor = vec4(vec3(k), 1.0);
}
`;

// Layer compositing (premultiplied in, premultiplied out; W3C separable blend modes)
export const quadVS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;
export const compFS = PREC + `
uniform sampler2D u_src;
uniform sampler2D u_dst;
uniform float u_opacity;
uniform float u_blend;
varying vec2 v_uv;
vec3 blendFn(vec3 cb, vec3 cs, int m) {
  if (m == 1) return cb * cs;
  if (m == 2) return cb + cs - cb * cs;
  if (m == 3) return mix(2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), step(0.5, cb));
  if (m == 4) return min(cb, cs);
  if (m == 5) return max(cb, cs);
  if (m == 6) return min(cb + cs, vec3(1.0));
  if (m == 7) return abs(cb - cs);
  return cs;
}
void main() {
  vec4 s = texture2D(u_src, v_uv) * u_opacity;
  vec4 d = texture2D(u_dst, v_uv);
  vec3 cs = s.a > 1e-5 ? s.rgb / s.a : vec3(0.0);
  vec3 cb = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0);
  vec3 B = blendFn(cb, cs, int(u_blend + 0.5));
  vec3 co = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B;
  gl_FragColor = vec4(co, s.a + d.a - s.a * d.a);
}
`;
export const blitFS = PREC + `
uniform sampler2D u_src;
varying vec2 v_uv;
void main() { gl_FragColor = texture2D(u_src, v_uv); }
`;
