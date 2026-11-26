// Recurror — stroke and fill tessellation (local / pre-symmetry space).
import { sampleSpline } from './spline.js';
import { strokeNoise, seedOf } from './noise.js';

// Stroke vertex layout (floats):
//   a_pos(2) a_ext(2) a_vc(2) a_tan(2) a_hw(1) a_along(2)  = 11
//   a_ink(2): slowness of the pen, sharpness of the turn
//   a_clip(4): two half-planes (c0 + c1·e ≥ 0 keeps the pixel, e = drawn half width) that cut the
//              legs of a sharp corner along its bisector
export const STROKE_STRIDE = 17;
const NO_CLIP = 1e7;
// a polyline corner sharper than this is built as two legs meeting on the bisector (exact miter)
const SHARP_TURN = 20 * Math.PI / 180, MITER_LIMIT = 4;

const sampleCache = new Map();

/** Memoised dense samples for a stroke (keyed by id + rev). */
export function getSamples(stroke) {
  const gk = stroke._ghostKey || '';
  const c = sampleCache.get(stroke.id);
  if (c && c.rev === stroke.rev && c.gk === gk) return c.samples;
  const samples = sampleSpline(stroke.points, stroke.shape.spline, stroke.shape.closed, 2, stroke._ghosts || null);
  sampleCache.set(stroke.id, { rev: stroke.rev, gk, samples });
  return samples;
}

/** Revision that also changes when a stroke's ghost (neighbour) tangents change. */
export const sampleRev = (stroke) => stroke.rev + '/' + (stroke._ghostKey || '');

export function dropSamples(id) { sampleCache.delete(id); }

export function isClosed(stroke) { return !!stroke.shape.closed && stroke.points.length >= 3; }

function smooth01(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Per-sample half widths (pressure × taper × per-point width). Also returns cumulative length. */
export function halfWidths(stroke, samples, closed, join = null) {
  const st = stroke.style;
  const n = samples.length;
  const cum = new Float32Array(n + 1);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  let total = cum[n - 1];
  if (closed && n > 1) { cum[n] = total + Math.hypot(samples[0].x - samples[n - 1].x, samples[0].y - samples[n - 1].y); total = cum[n]; }
  const hw = new Float32Array(n);
  const base = Math.max(0.05, st.width * 0.5);
  const pAmt = st.pressure;
  // brush shape: calligraphy nib (width follows the pen direction) and width jitter
  const nibR = Math.max(0.03, Math.min(1, st.nibRatio ?? 1));
  const nibA = -((st.nibAngle ?? 45) * Math.PI / 180);          // visual CCW, world y down
  const jit = Math.max(0, Math.min(1, st.jitter ?? 0));
  const jScale = Math.max(2, st.jitterScale ?? 60);
  const seed = seedOf(stroke.id || 'x');
  const env = brushEnvelope(stroke, cum, total, closed, join);
  for (let i = 0; i < n; i++) {
    const p = samples[i].p ?? 1;
    let f = 1 - pAmt + pAmt * p;
    if (nibR < 1 && n > 1) {
      const a = samples[Math.max(0, i - 1)], b = samples[Math.min(n - 1, i + 1)];
      const th = Math.atan2(b.y - a.y, b.x - a.x);
      f *= nibR + (1 - nibR) * Math.abs(Math.sin(th - nibA));
    }
    if (jit > 0) f *= Math.max(0.05, 1 + jit * 0.85 * env[i] * strokeNoise(cum[i], jScale, seed, closed ? total : 0));
    // skip tapering on strokes shorter than their own width (dots, tiny flicks)
    if (!closed && total > st.width) {
      const u = cum[i] / total;
      // no taper at an end that touches another stroke (it continues there)
      if (!(join && join.s)) f *= Math.max(0.02, smooth01(0, st.taperStart, u));
      if (!(join && join.e)) f *= Math.max(0.02, smooth01(0, st.taperEnd, 1 - u));
    }
    hw[i] = base * Math.max(0.02, f) * Math.max(0, samples[i].w ?? 1);
  }
  // ink pooling: a small blot where the pen lands and lifts (not at an end that joins another stroke)
  const pool = Math.max(0, Math.min(1, st.pool ?? 0));
  if (pool > 0 && !closed && n > 1 && total > st.width) {
    const R = Math.max(1, base * 1.6);
    for (let i = 0; i < n; i++) {
      let bump = 0;
      if (!(join && join.s)) bump = Math.max(bump, 0.55 * Math.exp(-((cum[i] / R) ** 2)));
      if (!(join && join.e)) bump = Math.max(bump, 0.4 * Math.exp(-(((total - cum[i]) / R) ** 2)));
      // the blot is a round pool of ink: at least this wide, however the line tapers there
      hw[i] = Math.max(hw[i] * (1 + 0.5 * pool * bump), base * 1.25 * pool * bump);
    }
  }
  return { hw, cum, total };
}

/** 1 along the stroke, easing to 0 within ~2 widths of an end that links to another stroke. */
function brushEnvelope(stroke, cum, total, closed, join) {
  const n = cum.length - 1, env = new Float32Array(Math.max(n, 1)).fill(1);
  if (closed || !join || (!join.s && !join.e)) return env;
  const W = Math.max(4, stroke.style.width * 2);
  for (let i = 0; i < n; i++) {
    if (join.s) env[i] = Math.min(env[i], smooth01(0, W, cum[i]));
    if (join.e) env[i] = Math.min(env[i], smooth01(0, W, total - cum[i]));
  }
  return env;
}

/** Wobble: displace the centreline along its normal with seeded noise (hand-drawn feel). */
function wobbled(stroke, S, cum, total, closed, join) {
  const st = stroke.style;
  const amt = Math.max(0, Math.min(1, st.wobble ?? 0));
  if (!(amt > 0) || S.length < 3) return S;
  const scale = Math.max(4, st.wobbleScale ?? 120);
  const seed = seedOf(stroke.id || 'x') + 7919;
  const env = brushEnvelope(stroke, cum, total, closed, join);
  const m = S.length, A = st.width * 0.6 * amt;
  return S.map((p, i) => {
    const a = closed ? S[(i - 1 + m) % m] : S[Math.max(0, i - 1)], b = closed ? S[(i + 1) % m] : S[Math.min(m - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const d = A * env[i] * strokeNoise(cum[i], scale, seed, closed ? total : 0);
    return { ...p, x: p.x - ty * d, y: p.y + tx * d };
  });
}

/**
 * Build triangle-list vertex data for a stroke body (+ round caps).
 * @returns {{data: Float32Array, count: number, maxHw: number}}
 */
export function buildStrokeMesh(stroke, join = null) {
  const samples = getSamples(stroke);
  const closed = isClosed(stroke);
  const n = samples.length;
  if (n === 0) return { data: new Float32Array(0), count: 0, maxHw: 0 };

  // Single point: emit a dot (two caps back to back).
  let S = samples;
  if (n === 1) S = [samples[0], { x: samples[0].x + 0.01, y: samples[0].y, p: samples[0].p }];
  const m = S.length;
  const { hw, cum, total } = halfWidths(stroke, S, closed && n > 2, join);
  // wobble moves the drawn centreline only; arc lengths stay those of the spline (gradients, dashes, chains)
  S = wobbled(stroke, S, cum, total, closed && n > 2, join);
  // stamp brushes scatter their stamps sideways: the strip is widened to hold them
  const stampPad = stroke.style.mode === 'stamp' ? 1 + Math.max(0, +stroke.style.stampScatter || 0) + Math.max(0, +stroke.style.stampSizeJit || 0) * 0.5 : 1;
  if (stampPad !== 1) for (let i = 0; i < m; i++) hw[i] *= stampPad;
  let maxHw = 0;
  for (let i = 0; i < m; i++) maxHw = Math.max(maxHw, hw[i]);
  // ink attribute per sample: how slowly the pen moved here (recorded while drawing) and how sharp
  // the turn is (relative to the stroke width)
  const slow = new Float32Array(m), turn = new Float32Array(m);
  {
    const P = stroke.points;
    if (P.some((p) => p.s > 0)) {
      for (let i = 0; i < m; i++) {
        const k = Math.max(0, Math.min(P.length - 1, S[i].seg ?? 0));
        const a = P[k], b = P[Math.min(P.length - 1, k + 1)];
        const da = Math.hypot(S[i].x - a.x, S[i].y - a.y), db = Math.hypot(S[i].x - b.x, S[i].y - b.y);
        const t = da + db > 1e-9 ? da / (da + db) : 0;
        slow[i] = (a.s || 0) * (1 - t) + (b.s || 0) * t;
      }
    }
  }

  const ringS = closed && n > 2;
  // Sharp corners (polyline vertices): the shared miter vertex would fold the inner edge and bend
  // the lateral coordinate (inked notches, edge-shading seams). Instead each leg runs straight to the
  // corner and on to the miter tip, and is cut along the bisector; the legs tile the corner exactly.
  const nibR0 = Math.max(0.03, Math.min(1, stroke.style.nibRatio ?? 1));
  const sharp = new Array(m).fill(null);
  if (n > 2 && nibR0 >= 1) for (let i = ringS ? 0 : 1; i < (ringS ? m : m - 1); i++) {
    const p = S[(i - 1 + m) % m], c = S[i], q = S[(i + 1) % m];
    let ix = c.x - p.x, iy = c.y - p.y, ox = q.x - c.x, oy = q.y - c.y;
    const il = Math.hypot(ix, iy), ol = Math.hypot(ox, oy);
    if (il < 1e-6 || ol < 1e-6) continue;
    ix /= il; iy /= il; ox /= ol; oy /= ol;
    const th = Math.acos(Math.max(-1, Math.min(1, ix * ox + iy * oy)));
    if (th < SHARP_TURN) continue;
    let bx = ix + ox, by = iy + oy;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) { bx = -iy; by = ix; } else { bx /= bl; by /= bl; }
    sharp[i] = { ix, iy, ox, oy, bx, by, th, ext: Math.min(MITER_LIMIT, Math.tan(th / 2)) * 1.02 + 0.02 };
  }
  // tangents & miters
  const tx = new Float32Array(m), ty = new Float32Array(m);
  const mx = new Float32Array(m), my = new Float32Array(m);
  // inner-edge limit at tight bends: the inner side may not extrude past the centre of curvature,
  // otherwise the strip folds into bow-ties (notches in solid modes, double-painted fans in washes)
  const inner = new Int8Array(m), innerK = new Float32Array(m).fill(1);
  const ringM = closed && n > 2;
  const at = (j) => (ringM ? S[((j % m) + m) % m] : S[Math.max(0, Math.min(m - 1, j))]);
  for (let i = 0; i < m; i++) {
    // a sharp corner is built from straight legs; the bend estimate must not reach across it
    if (sharp[i] || (ringM || i > 0) && sharp[(i - 1 + m) % m] || (ringM || i < m - 1) && sharp[(i + 1) % m]) continue;
    const a = at(i - 2), b = S[i], c = at(i + 2);
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) continue;
    const rho = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * Math.hypot(c.x - a.x, c.y - a.y) / (2 * Math.abs(cr));
    inner[i] = cr > 0 ? 1 : -1;
    innerK[i] = rho;                                  // radius for now; turned into a factor below
  }
  for (let i = 0; i < m; i++) {
    let prev, next;
    if (closed && n > 2) { prev = S[(i - 1 + m) % m]; next = S[(i + 1) % m]; }
    else {
      prev = S[Math.max(0, i - 1)]; next = S[Math.min(m - 1, i + 1)];
      // a linked end borrows the neighbour's sample across the join, so both strokes build the
      // shared vertex from the same three points (identical tangent, miter and position)
      if (i === 0 && join && join.ts) prev = join.ts;
      if (i === m - 1 && join && join.te) next = join.te;
    }
    // incoming / outgoing segment directions
    let ix = S[i].x - prev.x, iy = S[i].y - prev.y;
    let ox = next.x - S[i].x, oy = next.y - S[i].y;
    let il = Math.hypot(ix, iy), ol = Math.hypot(ox, oy);
    if (il < 1e-9) { ix = ox; iy = oy; il = ol; }
    if (ol < 1e-9) { ox = ix; oy = iy; ol = il; }
    if (il < 1e-9) { ix = ox = 1; iy = oy = 0; il = ol = 1; }
    ix /= il; iy /= il; ox /= ol; oy /= ol;
    let ax = ix + ox, ay = iy + oy;
    let al = Math.hypot(ax, ay);
    if (al < 1e-6) { ax = ox; ay = oy; al = 1; }
    ax /= al; ay /= al;
    tx[i] = ax; ty[i] = ay;
    // normal = perp(tangent) = (-ty, tx); miter scale vs segment normal
    const nx = -ay, ny = ax;
    const segNx = -oy, segNy = ox;
    const dd = Math.max(nx * segNx + ny * segNy, 1 / 3);
    mx[i] = nx / dd; my[i] = ny / dd;
    if (inner[i]) turn[i] = Math.min(1, 1.6 * hw[i] / Math.max(1e-6, innerK[i]));
    if (inner[i]) {
      const reach = hw[i] * Math.hypot(mx[i], my[i]);
      innerK[i] = reach > 0 ? Math.min(1, 0.9 * innerK[i] / reach) : 1;
    }
  }

  const ring = closed && n > 2;
  const segs = ring ? m : m - 1;
  // linked ends on Catmull-Rom strokes continue with matching tangents into the neighbour: no cap there
  const smoothJoin = stroke.shape.spline === 'catmull';
  const roundCaps = !ring && stroke.style.cap !== 'butt' && n > 1;
  const capS = roundCaps && !(join && join.s && smoothJoin);
  const capE = roundCaps && !(join && join.e && smoothJoin);
  const capCount = n === 1 && !ring && stroke.style.cap !== 'butt' ? 2 : (capS ? 1 : 0) + (capE ? 1 : 0);

  const nSharp = sharp.filter(Boolean).length;
  // Each corner's bisector cuts every segment within reach of it: the legs overlap on the inside of
  // the bend for hw·tan(θ/2) along each leg (several samples on a finely sampled polyline).
  const reachOf = (i) => hw[i] * (Math.min(50, Math.tan(sharp[i].th / 2)) * 1.05 + 1);
  const Tlen = cum[ringS ? m : m - 1] || 0;
  const nextSharp = new Int32Array(m).fill(-1), prevSharp = new Int32Array(m).fill(-1);
  if (nSharp) {
    let last = -1;
    for (let pass = 0; pass < (ringS ? 2 : 1); pass++) for (let i = m - 1; i >= 0; i--) { if (sharp[i]) last = i; if (nextSharp[i] < 0) nextSharp[i] = last; }
    last = -1;
    for (let pass = 0; pass < (ringS ? 2 : 1); pass++) for (let i = 0; i < m; i++) { if (sharp[i]) last = i; if (prevSharp[i] < 0) prevSharp[i] = last; }
  }
  const arc = (from, to) => { let d = cum[to] - cum[from]; if (ringS && d < 0) d += Tlen; return d; };
  const vertCount = segs * 6 + capCount * 6 + nSharp * 12;
  const data = new Float32Array(vertCount * STROKE_STRIDE);
  let o = 0;
  const totalLen = Math.max(total, 1e-6);

  // clip half-planes for a vertex at (px, py) + ext·e: keep where sgn·dot(p − c, B) ≥ 0
  let clipA = null, clipB = null;
  const clipOf = (cl, px, py, ex, ey) => {
    if (!cl) return [NO_CLIP, 0];
    const c = S[cl.i], k = cl.sgn;
    return [k * ((px - c.x) * cl.bx + (py - c.y) * cl.by), k * (ex * cl.bx + ey * cl.by)];
  };
  const putRaw = (px, py, extX, extY, side, capC, tX, tY, h, len, sl, tu) => {
    data[o++] = px; data[o++] = py;
    data[o++] = extX; data[o++] = extY;
    data[o++] = side; data[o++] = capC;
    data[o++] = tX; data[o++] = tY;
    data[o++] = h;
    data[o++] = len / totalLen; data[o++] = len;
    data[o++] = sl; data[o++] = tu;
    const a = clipOf(clipA, px, py, extX, extY), b = clipOf(clipB, px, py, extX, extY);
    data[o++] = a[0]; data[o++] = a[1]; data[o++] = b[0]; data[o++] = b[1];
  };
  const put = (i, side, capC, extX, extY, uOverride, tX = tx[i], tY = ty[i]) => {
    const s = S[i];
    const len = uOverride !== undefined ? uOverride : cum[i];
    putRaw(s.x, s.y, extX, extY, side, capC, tX, tY, hw[i], len, slow[i], turn[i]);
  };
  // calligraphy nib: each side is offset along the fixed nib (normal + (cos/f)·tangent), giving the
  // slanted swept-pen envelope; the perpendicular reach stays exactly hw, so edge anti-aliasing holds
  const nibR = Math.max(0.03, Math.min(1, stroke.style.nibRatio ?? 1));
  const nibA = -((stroke.style.nibAngle ?? 45) * Math.PI / 180);
  const ux = Math.cos(nibA), uy = Math.sin(nibA);
  const slide = new Float32Array(m);
  if (nibR < 1) for (let i = 0; i < m; i++) {
    const nx = -ty[i], ny = tx[i];
    let sn = ux * nx + uy * ny, c = ux * tx[i] + uy * ty[i];
    if (sn < 0) { sn = -sn; c = -c; }
    slide[i] = c / (nibR + (1 - nibR) * sn);
  }
  const body = (i, side, len) => {
    const k = side === inner[i] && nibR >= 1 ? innerK[i] : 1;   // the swept nib envelope doesn't fold like a round brush
    put(i, side, 0, (mx[i] * k + tx[i] * slide[i]) * side, (my[i] * k + ty[i] * slide[i]) * side, len);
  };

  for (let k = 0; k < segs; k++) {
    const a = k, b = (k + 1) % m;
    const la = cum[a];
    const lb = (ring && b === 0) ? cum[m] : cum[b];
    if (!sharp[a] && !sharp[b]) {
      // within reach of a corner on either side: keep to its side of the bisector
      const j = nextSharp[b], i = prevSharp[a];
      clipB = j >= 0 && arc(b, j) <= reachOf(j) ? { i: j, bx: sharp[j].bx, by: sharp[j].by, sgn: -1 } : null;
      clipA = i >= 0 && arc(i, a) <= reachOf(i) ? { i, bx: sharp[i].bx, by: sharp[i].by, sgn: 1 } : null;
      body(a, -1, la); body(a, 1, la); body(b, 1, lb);
      body(a, -1, la); body(b, 1, lb); body(b, -1, lb);
      continue;
    }
    // a leg of a sharp corner: square to the segment at that end, cut on the corner's bisector
    let sx = S[b].x - S[a].x, sy = S[b].y - S[a].y;
    const sl = Math.hypot(sx, sy) || 1; sx /= sl; sy /= sl;
    const nx = -sy, ny = sx;
    {
      const i = sharp[a] ? a : prevSharp[a], j = sharp[b] ? b : nextSharp[b];
      clipA = i >= 0 && (i === a || arc(i, a) <= reachOf(i)) ? { i, bx: sharp[i].bx, by: sharp[i].by, sgn: 1 } : null;
      clipB = j >= 0 && (j === b || arc(b, j) <= reachOf(j)) ? { i: j, bx: sharp[j].bx, by: sharp[j].by, sgn: -1 } : null;
    }
    const end = (i, side, len) => sharp[i] ? put(i, side, 0, nx * side, ny * side, len, sx, sy) : body(i, side, len);
    end(a, -1, la); end(a, 1, la); end(b, 1, lb);
    end(a, -1, la); end(b, 1, lb); end(b, -1, lb);
  }
  // the legs carry on past each sharp corner to its miter tip (each keeps its own side of the bisector)
  for (let i = 0; i < m; i++) {
    const c = sharp[i];
    if (!c) continue;
    const len = i === 0 && ring ? cum[m] : cum[i];
    for (const [dx, dy, sgn, l2] of [[c.ix, c.iy, -1, len], [-c.ox, -c.oy, 1, i === 0 && ring ? 0 : cum[i]]]) {
      const tX = sgn < 0 ? c.ix : c.ox, tY = sgn < 0 ? c.iy : c.oy, nx = -tY, ny = tX;
      const E = c.ext * hw[i];
      clipA = { i, bx: c.bx, by: c.by, sgn }; clipB = null;
      const v = (side, far) => putRaw(S[i].x + (far ? dx * E : 0), S[i].y + (far ? dy * E : 0), nx * side, ny * side, side, 0, tX, tY, hw[i], l2, slow[i], turn[i]);
      v(-1, 0); v(1, 0); v(1, 1);
      v(-1, 0); v(1, 1); v(-1, 1);
    }
  }
  clipA = clipB = null;

  if (capCount) {
    const cap = (i, dir) => {
      // dir = -1 for start cap (extends backwards), +1 for end cap
      const Tx = tx[i], Ty = ty[i], Nx = -Ty, Ny = Tx;
      const v = (side, c) => put(i, side, c, Nx * side + Tx * c, Ny * side + Ty * c);
      v(-1, 0); v(1, 0); v(1, dir);
      v(-1, 0); v(1, dir); v(-1, dir);
    };
    if (capS || n === 1) cap(0, -1);
    if (capE || n === 1) cap(m - 1, 1);
  }
  return { data, count: vertCount, maxHw, total };
}

export const FILL_STRIDE = 5;   // a_pos(2) a_nrm(2) a_side(1)
const GRID = 24;

/**
 * Fill geometry, all in one interleaved buffer:
 *   fan    — triangle fan from sample 0 (stencil even-odd)
 *   quad   — bounding quad cover (affine copies)
 *   grid   — GRID×GRID cover (Möbius / warped copies, so the cover bends with the map)
 *   fringe — 2-px band straddling the outline (edge anti-aliasing, drawn outside the stencil)
 */
export function buildFillMesh(stroke) {
  const samples = getSamples(stroke);
  const n = samples.length;
  if (n < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i], b = samples[(i + 1) % n];
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
    const cr = a.x * b.y - b.x * a.y;
    area += cr; cx += (a.x + b.x) * cr; cy += (a.y + b.y) * cr;
  }
  if (Math.abs(area) > 1e-6) { cx /= 3 * area; cy /= 3 * area; }
  else { cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; }
  cx = Math.min(x1, Math.max(x0, cx)); cy = Math.min(y1, Math.max(y0, cy));
  let radius = 1e-3;
  for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(samples[i].x - cx, samples[i].y - cy));

  const fanCount = (n - 2) * 3, quadCount = 6, gridCount = GRID * GRID * 6, fringeCount = n * 6;
  const data = new Float32Array((fanCount + quadCount + gridCount + fringeCount) * FILL_STRIDE);
  let o = 0;
  const put = (x, y, nx = 0, ny = 0, side = 0) => { data[o++] = x; data[o++] = y; data[o++] = nx; data[o++] = ny; data[o++] = side; };
  const p0 = samples[0];
  for (let i = 1; i < n - 1; i++) { put(p0.x, p0.y); put(samples[i].x, samples[i].y); put(samples[i + 1].x, samples[i + 1].y); }
  const pad = 2;
  const qx0 = x0 - pad, qy0 = y0 - pad, qx1 = x1 + pad, qy1 = y1 + pad;
  const quadFirst = fanCount;
  put(qx0, qy0); put(qx1, qy0); put(qx1, qy1); put(qx0, qy0); put(qx1, qy1); put(qx0, qy1);
  const gridFirst = quadFirst + quadCount;
  const gx = (i) => qx0 + (qx1 - qx0) * i / GRID, gy = (j) => qy0 + (qy1 - qy0) * j / GRID;
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    put(gx(i), gy(j)); put(gx(i + 1), gy(j)); put(gx(i + 1), gy(j + 1));
    put(gx(i), gy(j)); put(gx(i + 1), gy(j + 1)); put(gx(i), gy(j + 1));
  }
  // fringe band: unit miter normals at each outline vertex
  const fringeFirst = gridFirst + gridCount;
  const nx = new Float32Array(n), ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = samples[(i - 1 + n) % n], b = samples[i], c = samples[(i + 1) % n];
    let ix = b.x - a.x, iy = b.y - a.y, ox = c.x - b.x, oy = c.y - b.y;
    const il = Math.hypot(ix, iy) || 1, ol = Math.hypot(ox, oy) || 1;
    ix /= il; iy /= il; ox /= ol; oy /= ol;
    let tx = ix + ox, ty = iy + oy;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) { tx = ox; ty = oy; } else { tx /= tl; ty /= tl; }
    const dd = Math.max(-ty * -oy + tx * ox, 0.5);    // miter, clamped at 2×
    nx[i] = -ty / dd; ny[i] = tx / dd;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = samples[i], b = samples[j];
    put(a.x, a.y, nx[i], ny[i], -1); put(a.x, a.y, nx[i], ny[i], 1); put(b.x, b.y, nx[j], ny[j], 1);
    put(a.x, a.y, nx[i], ny[i], -1); put(b.x, b.y, nx[j], ny[j], 1); put(b.x, b.y, nx[j], ny[j], -1);
  }
  return { data, fanCount, quadFirst, quadCount, gridFirst, gridCount, fringeFirst, fringeCount, bbox: [x0, y0, x1, y1], center: [cx, cy], radius };
}

/** Local bounding circle (centre, radius) of a stroke's samples incl. width. */
export function boundCircle(stroke) {
  const sm = getSamples(stroke);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let r = 0;
  for (const p of sm) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
  let wmax = 1;
  for (const p of stroke.points) wmax = Math.max(wmax, p.w ?? 1);
  const st = stroke.style;
  const stamp = st.mode === 'stamp' ? 1 + Math.max(0, +st.stampScatter || 0) + Math.max(0, +st.stampSizeJit || 0) * 0.5 : 1;
  return { x: cx, y: cy, r: r + st.width * (0.5 * wmax * stamp * (1 + 0.85 * (st.jitter ?? 0)) * (1 + 0.8 * (st.pool ?? 0)) + 0.6 * (st.wobble ?? 0)) };
}
