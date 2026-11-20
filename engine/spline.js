// Recurror — spline evaluation, simplification and distance helpers.
// Points are {x, y, p, w}: p = pressure in [0,1], w = per-point width multiplier (default 1).

const EPS = 1e-6;

function lerp(a, b, t) { return a + (b - a) * t; }
const W = (p) => (p.w ?? 1);

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

// Centripetal Catmull-Rom (alpha = 0.5) via the Barry–Goldman pyramid.
function catmullPoint(p0, p1, p2, p3, t) {
  const t0 = 0;
  const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), EPS);
  const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), EPS);
  const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), EPS);
  const tt = lerp(t1, t2, t);
  const A1x = ((t1 - tt) * p0.x + (tt - t0) * p1.x) / (t1 - t0);
  const A1y = ((t1 - tt) * p0.y + (tt - t0) * p1.y) / (t1 - t0);
  const A2x = ((t2 - tt) * p1.x + (tt - t1) * p2.x) / (t2 - t1);
  const A2y = ((t2 - tt) * p1.y + (tt - t1) * p2.y) / (t2 - t1);
  const A3x = ((t3 - tt) * p2.x + (tt - t2) * p3.x) / (t3 - t2);
  const A3y = ((t3 - tt) * p2.y + (tt - t2) * p3.y) / (t3 - t2);
  const B1x = ((t2 - tt) * A1x + (tt - t0) * A2x) / (t2 - t0);
  const B1y = ((t2 - tt) * A1y + (tt - t0) * A2y) / (t2 - t0);
  const B2x = ((t3 - tt) * A2x + (tt - t1) * A3x) / (t3 - t1);
  const B2y = ((t3 - tt) * A2y + (tt - t1) * A3y) / (t3 - t1);
  return {
    x: ((t2 - tt) * B1x + (tt - t1) * B2x) / (t2 - t1),
    y: ((t2 - tt) * B1y + (tt - t1) * B2y) / (t2 - t1),
  };
}

// Uniform cubic B-spline basis.
function bsplinePoint(p0, p1, p2, p3, t) {
  const it = 1 - t, t2 = t * t, t3 = t2 * t;
  const b0 = it * it * it / 6;
  const b1 = (3 * t3 - 6 * t2 + 4) / 6;
  const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  const b3 = t3 / 6;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
    p: b0 * p0.p + b1 * p1.p + b2 * p2.p + b3 * p3.p,
    w: b0 * W(p0) + b1 * W(p1) + b2 * W(p2) + b3 * W(p3),
  };
}

function segSteps(a, b, step) {
  return Math.max(2, Math.min(128, Math.ceil(dist(a, b) / step)));
}

function pushSample(out, x, y, p, seg, w = 1) {
  const last = out[out.length - 1];
  if (last && Math.abs(last.x - x) < 1e-4 && Math.abs(last.y - y) < 1e-4) return;
  out.push({ x, y, p, seg, w });
}

/**
 * Sample a spline into a dense polyline.
 * @param {Array<{x,y,p}>} pts control points
 * @param {'catmull'|'bspline'|'linear'} type
 * @param {boolean} closed
 * @param {number} step approximate world-space sample spacing
 * @returns {Array<{x,y,p,seg}>} samples; seg = index of the control segment
 *          (segment i runs from control point i to i+1).
 *          For closed curves the first sample is NOT repeated at the end.
 */
export function sampleSpline(pts, type, closed, step = 2, ghosts = null) {
  // linked ends: move the end control points onto the shared join point
  if (ghosts && (ghosts.ps || ghosts.pe) && pts.length > 1) {
    pts = pts.slice();
    if (ghosts.ps) pts[0] = { ...pts[0], x: ghosts.ps.x, y: ghosts.ps.y };
    if (ghosts.pe) pts[pts.length - 1] = { ...pts[pts.length - 1], x: ghosts.pe.x, y: ghosts.pe.y };
  }
  const n = pts.length;
  const out = [];
  if (n === 0) return out;
  if (n === 1) { out.push({ x: pts[0].x, y: pts[0].y, p: pts[0].p ?? 1, seg: 0, w: W(pts[0]) }); return out; }
  const P = (i) => pts[((i % n) + n) % n];
  const isClosed = closed && n >= 3;
  const segCount = isClosed ? n : n - 1;

  if (type === 'linear' || n === 2) {
    for (let i = 0; i < segCount; i++) {
      const a = P(i), b = P(i + 1);
      const steps = segSteps(a, b, step * 4);
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        pushSample(out, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.p, b.p, t), i, lerp(W(a), W(b), t));
      }
    }
    if (!isClosed) { const e = P(n - 1); pushSample(out, e.x, e.y, e.p, n - 2, W(e)); }
    return out;
  }

  if (type === 'bspline') {
    // Open: triple the end points so the curve is clamped to them.
    let ctrl;
    if (isClosed) ctrl = [];
    else ctrl = [pts[0], pts[0], ...pts, pts[n - 1], pts[n - 1]];
    const cnt = isClosed ? n : ctrl.length - 3;
    const C = isClosed ? (i) => P(i) : (i) => ctrl[i];
    for (let i = 0; i < cnt; i++) {
      const p0 = isClosed ? C(i - 1) : C(i);
      const p1 = isClosed ? C(i) : C(i + 1);
      const p2 = isClosed ? C(i + 1) : C(i + 2);
      const p3 = isClosed ? C(i + 2) : C(i + 3);
      const steps = segSteps(p1, p2, step);
      // map back to an original control segment index for insertion
      const seg = isClosed ? i : Math.max(0, Math.min(n - 2, i - 1));
      for (let k = 0; k < steps; k++) {
        const q = bsplinePoint(p0, p1, p2, p3, k / steps);
        pushSample(out, q.x, q.y, q.p, seg, q.w);
      }
    }
    if (!isClosed) { const e = pts[n - 1]; pushSample(out, e.x, e.y, e.p, n - 2, W(e)); }
    return out;
  }

  // Catmull-Rom (centripetal)
  for (let i = 0; i < segCount; i++) {
    const p1 = P(i), p2 = P(i + 1);
    let p0, p3;
    if (isClosed) { p0 = P(i - 1); p3 = P(i + 2); }
    else {
      // ghosts: the neighbouring stroke's next point, so a touching stroke continues with C1 tangents
      p0 = i === 0 ? (ghosts && ghosts.s ? ghosts.s : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y }) : P(i - 1);
      p3 = i + 2 > n - 1 ? (ghosts && ghosts.e ? ghosts.e : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y }) : P(i + 2);
    }
    const steps = segSteps(p1, p2, step);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const q = catmullPoint(p0, p1, p2, p3, t);
      // smoothstep pressure between the two controls
      const s = t * t * (3 - 2 * t);
      pushSample(out, q.x, q.y, lerp(p1.p, p2.p, s), i, lerp(W(p1), W(p2), s));
    }
  }
  if (!isClosed) { const e = P(n - 1); pushSample(out, e.x, e.y, e.p, n - 2, W(e)); }
  return out;
}

/** Ramer–Douglas–Peucker simplification (keeps pressure of retained points). */
export function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const A = pts[a], B = pts[b];
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i].x, pts[i].y, A.x, A.y, B.x, B.y);
      // pressure changes also count as detail worth keeping
      const dp = Math.abs(pts[i].p - lerp(A.p, B.p, (i - a) / (b - a))) * 8;
      const dd = d + dp * dp;
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

export function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Nearest point on a polyline. Returns {d, index, t, x, y}. */
export function nearestOnPolyline(samples, x, y, closed) {
  let best = { d: Infinity, index: -1, t: 0, x: 0, y: 0 };
  const n = samples.length;
  if (n === 1) {
    best.d = Math.hypot(samples[0].x - x, samples[0].y - y);
    best.index = 0; best.x = samples[0].x; best.y = samples[0].y;
    return best;
  }
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = samples[i], b = samples[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + dx * t, qy = a.y + dy * t;
    const d = Math.hypot(qx - x, qy - y);
    if (d < best.d) best = { d, index: i, t, x: qx, y: qy };
  }
  return best;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(samples, x, y) {
  let inside = false;
  for (let i = 0, j = samples.length - 1; i < samples.length; j = i++) {
    const a = samples[i], b = samples[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
