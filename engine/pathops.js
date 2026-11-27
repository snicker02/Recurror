// Recurror — path operations on a stroke's sampled centre line (local, pre-symmetry coordinates):
// cutting by an eraser, parallel offsets (echo lines), simplification back to control points.
// Pure functions: arrays of { x, y, p, w } in, arrays out.

const lerp = (a, b, t) => a + (b - a) * t;
const lerpPt = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), p: lerp(a.p ?? 1, b.p ?? 1, t), w: lerp(a.w ?? 1, b.w ?? 1, t) });
const strip = (q) => ({ x: q.x, y: q.y, p: q.p ?? 1, w: q.w ?? 1 });

/** Distance from point p to segment ab. */
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Inside any capsule (a swept eraser circle: segment a→b, radius r)? */
const inCapsules = (caps, x, y) => caps.some((c) => distSeg(x, y, c.ax, c.ay, c.bx, c.by) < c.r);

/**
 * Cut a polyline where it passes through any of the capsules. Returns null when nothing is cut;
 * otherwise the pieces that remain (each ≥ 2 points; may be empty when everything was erased).
 * Cut ends are found by bisection, so they lie on the eraser's edge, not on a sample.
 */
export function cutByCapsules(S, closed, caps, minLen = 0.5) {
  if (!S.length || !caps.length) return null;
  // quick reject: no sample within reach of any capsule
  const reach = Math.max(...caps.map((c) => c.r));
  let any = false;
  for (const c of caps) {
    const minx = Math.min(c.ax, c.bx) - c.r - reach, maxx = Math.max(c.ax, c.bx) + c.r + reach;
    const miny = Math.min(c.ay, c.by) - c.r - reach, maxy = Math.max(c.ay, c.by) + c.r + reach;
    if (S.some((q) => q.x >= minx && q.x <= maxx && q.y >= miny && q.y <= maxy)) { any = true; break; }
  }
  if (!any) return null;
  const pts = closed && S.length > 2 ? S.concat([S[0]]) : S.slice();
  const minR = Math.min(...caps.map((c) => c.r));
  // walk each segment in steps of ≤ r/3, tracking inside/outside; refine every switch by bisection
  const runs = [];            // kept runs: arrays of points
  let cur = null, cutAny = false;
  const inside = (q) => inCapsules(caps, q.x, q.y);
  let prevIn = inside(pts[0]);
  if (!prevIn) cur = [strip(pts[0])]; else cutAny = true;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(L / Math.max(1e-3, minR / 3)));
    let tPrev = 0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const q = lerpPt(a, b, t);
      const qIn = inside(q);
      if (qIn !== prevIn) {
        let lo = tPrev, hi = t;               // boundary between lo (prevIn) and hi (qIn)
        for (let it = 0; it < 22; it++) { const m = (lo + hi) / 2; if (inside(lerpPt(a, b, m)) === prevIn) lo = m; else hi = m; }
        const e = lerpPt(a, b, prevIn ? hi : lo);
        if (prevIn) cur = [e];                 // leaving the eraser: a new run starts
        else { cur.push(e); runs.push(cur); cur = null; cutAny = true; }
      }
      if (!qIn && k === n && cur) cur.push(strip(b));
      prevIn = qIn; tPrev = t;
    }
  }
  if (cur) runs.push(cur);
  if (!cutAny) return null;
  // a loop cut open: the run through the seam joins its two ends
  if (closed && runs.length >= 2 && !inside(pts[0])) {
    const first = runs.shift(), last = runs.pop();
    runs.push(last.concat(first.slice(1)));
  }
  const len = (r) => { let s = 0; for (let i = 1; i < r.length; i++) s += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y); return s; };
  return runs.map((r) => dedupe(r)).filter((r) => r.length >= 2 && len(r) >= minLen);
}

function dedupe(r) {
  const out = [];
  for (const q of r) { const l = out[out.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-6) out.push(q); }
  return out;
}

/** Ramer–Douglas–Peucker simplification (keeps endpoints; attributes ride along). */
export function simplifyRDP(P, tol) {
  if (P.length < 3) return P.slice();
  const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distSeg(P[i].x, P[i].y, P[a].x, P[a].y, P[b].x, P[b].y)
        + Math.abs((P[i].w ?? 1) - lerp(P[a].w ?? 1, P[b].w ?? 1, (i - a) / (b - a))) * 4 * tol;   // keep width changes
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return P.filter((_, i) => keep[i]);
}

/**
 * Offset a polyline sideways by d (left of the direction of travel for d > 0), with miter joins
 * (limited), and drop the folds that appear where d exceeds the local bend radius.
 * Returns pieces (arrays of points); a closed line gives one closed loop when it stays clean.
 */
export function offsetPolyline(S, closed, d, miterLimit = 4) {
  const n = S.length;
  if (n < 2 || !d) return [S.map(strip)];
  const P = closed ? S.slice() : S;
  const m = P.length;
  const segN = [];
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const a = P[i], b = P[(i + 1) % m];
    let dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    segN.push({ nx: dy, ny: -dx, tx: dx, ty: dy });   // left normal in y-down screen terms
  }
  const out = [];
  for (let i = 0; i < m; i++) {
    const prev = closed ? segN[(i - 1 + segN.length) % segN.length] : segN[i - 1];
    const next = closed ? segN[i % segN.length] : segN[i];
    let nx, ny;
    if (!prev) { nx = next.nx; ny = next.ny; }
    else if (!next) { nx = prev.nx; ny = prev.ny; }
    else {
      nx = prev.nx + next.nx; ny = prev.ny + next.ny;
      const l = Math.hypot(nx, ny);
      if (l < 1e-6) { nx = next.nx; ny = next.ny; }
      else {
        nx /= l; ny /= l;
        const c = nx * next.nx + ny * next.ny;          // cos(half turn)
        const k = Math.min(miterLimit, 1 / Math.max(1e-3, c));
        nx *= k; ny *= k;
      }
    }
    out.push({ x: P[i].x + nx * d, y: P[i].y + ny * d, p: P[i].p ?? 1, w: P[i].w ?? 1 });
  }
  // A point of the echo is real only if it is at least |d| from every part of the source line;
  // the points of a fold (an inward corner, a bend tighter than |d|) are closer than that to some
  // other part. Drop those, then cut out what crossings remain.
  const ad = Math.abs(d) * (1 - 1e-6) - 1e-9;
  const srcSegs = closed ? m : m - 1;
  const minDist = (q) => {
    let best = Infinity;
    for (let i = 0; i < srcSegs && best >= ad; i++) {
      const a = P[i], b = P[(i + 1) % m];
      best = Math.min(best, distSeg(q.x, q.y, a.x, a.y, b.x, b.y));
    }
    return best;
  };
  const kept = out.filter((q) => minDist(q) >= ad);
  if (kept.length < (closed ? 3 : 2)) return [];
  out.length = 0; out.push(...kept);
  if (!closed) {
    const P1 = removeLoops(out, false);
    return P1.length >= 2 ? [P1] : [];
  }
  // a closed line: cut the loops out, then check the result still runs the same way round with a
  // real area (an inward echo wider than the shape turns inside out and vanishes)
  const P1 = removeLoops(out, true);
  const a0 = polyArea(P), a1 = polyArea(P1);
  if (P1.length < 3 || Math.sign(a1) !== Math.sign(a0) || Math.abs(a1) < 1e-6 * Math.abs(a0)) return [];
  P1.closed = true;
  return [P1];
}

/**
 * Remove the loops an offset forms at tight bends and inward corners: wherever the path crosses
 * itself, the stretch between the two crossing segments is cut out and replaced by the crossing
 * point (for a closed path, whichever way round the loop is shorter).
 */
function removeLoops(P, closed) {
  let Q = P.slice();
  for (let guard = 0; guard < 400; guard++) {
    const n = Q.length;
    if (n < 4) break;
    const segs = closed ? n : n - 1;
    // a grid of segment boxes keeps this near-linear
    const cell = Math.max(1e-6, bboxSpan(Q) / Math.max(8, Math.sqrt(segs)));
    const grid = new Map();
    for (let i = 0; i < segs; i++) {
      const a = Q[i], b = Q[(i + 1) % n];
      const x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx + ',' + gy; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
      }
    }
    let best = null;
    for (const l of grid.values()) {
      for (let u = 0; u < l.length; u++) for (let v = u + 1; v < l.length; v++) {
        const i = Math.min(l[u], l[v]), j = Math.max(l[u], l[v]);
        if (j - i < 2 || (closed && i === 0 && j === segs - 1)) continue;
        const h = segX(Q[i], Q[(i + 1) % n], Q[j], Q[(j + 1) % n]);
        if (!h) continue;
        const inner = j - i, outer = closed ? segs - inner : Infinity;
        const span = Math.min(inner, outer);
        if (!best || span < best.span) best = { i, j, h, span, wrap: outer < inner };
      }
    }
    if (!best) break;
    const { i, j, h, wrap } = best;
    Q = wrap ? [h].concat(Q.slice(i + 1, j + 1)) : Q.slice(0, i + 1).concat([h], Q.slice(j + 1));
  }
  return Q;
}

function bboxSpan(Q) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of Q) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return Math.max(x1 - x0, y1 - y0);
}

/** Crossing of segments ab and cd; half-open ([0, 1)) so a crossing at a shared vertex counts once. */
function segX(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < -1e-9 || t >= 1 - 1e-9 || u < -1e-9 || u >= 1 - 1e-9) return null;
  return lerpPt(a, b, Math.max(0, t));
}

/** Point in polygon (even-odd). */
export function pointInPoly(P, x, y) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Signed area (positive = clockwise on screen, y down). */
export function polyArea(P) {
  let a = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j].x * P[i].y - P[i].x * P[j].y);
  return a / 2;
}
