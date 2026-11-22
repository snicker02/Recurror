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
};
/** Translucent wash modes: drawn without per-copy depth ordering (they are meant to layer). */
export const SOFT_MODES = new Set([STROKE_MODES.airbrush, STROKE_MODES.watercolor]);
export const DASH_MODES = { none: 0, dash: 1, dot: 2 };
export const ADDITIVE_MODES = new Set([STROKE_MODES.glow, STROKE_MODES.neon]);
export const GRAD_MODES = { none: 0, along: 1, across: 2, center: 3, bands: 4 };
export const FILL_MODES = {
  none: 0, flat: 1, linear: 2, radial: 3, dome: 4,
  noise: 5, hatch: 6, cross: 7, dots: 8, cells: 9, marble: 10,
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

export const strokeVS = MAP + `
attribute vec2 a_pos;
attribute vec2 a_ext;
attribute vec2 a_vc;
attribute vec2 a_tan;
attribute float a_hw;
attribute vec2 a_along;
attribute float a_weave;

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
  v_hw = a_hw;
  v_pad = pad;
  v_along = a_along;
  vec2 T = a_tan;
  vec2 N = vec2(-T.y, T.x);
  if (u_lightFollow > 0.5) { v_T = T; v_N = N; }
  else { v_T = normalize(J * T); v_N = normalize(J * N); }
}
`;

export const strokeFS = PREC + `
uniform float u_mode;
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

uniform float u_clipN;      // crop to cell: number of neighbouring sites (0 = off)
uniform vec2 u_clipC;       // the cell's own site
uniform float u_clipW0;     // its distance weight (1, or the hyperbolic factor)
uniform vec3 u_clipP[16];   // neighbouring sites (x, y, weight)
bool cropped(vec2 l) {
  if (u_clipN < 0.5) return false;
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
  v_side = a_side;
  v_pxl = pad;
  mat2 Ln = u_lightFollow > 0.5 ? mat2(1.0) : J * (1.0 / sl);
  v_l0 = Ln[0];
  v_l1 = Ln[1];
}
`;

export const fillFS = PREC + `
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

uniform float u_clipN;      // crop to cell: number of neighbouring sites (0 = off)
uniform vec2 u_clipC;       // the cell's own site
uniform float u_clipW0;     // its distance weight (1, or the hyperbolic factor)
uniform vec3 u_clipP[16];   // neighbouring sites (x, y, weight)
bool cropped(vec2 l) {
  if (u_clipN < 0.5) return false;
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
  }
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
  if (u_fringe > 0.5) a *= clamp(0.5 - abs(v_side), 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
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
