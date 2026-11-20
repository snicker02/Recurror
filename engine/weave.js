// Recurror — weave (over/under interlace) solver.
//
// Every copy is congruent to the source stroke, so one height profile h(s) along the stroke's own
// arc length serves all copies. Crossings between the source and each copy (and its self-crossings)
// give pairs of arc-length positions (sA, sB) that must sit at opposite heights (hard constraint).
// Consecutive crossings along the strand should alternate over/under (soft constraint). A
// parity union-find adds every hard edge, then each alternation edge that does not contradict
// what is already fixed. The depth pass then turns h(s) into depth.
import { mobApply, mobScaleAt } from './symmetry.js';

class ParityDSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); this.x = new Uint8Array(n); }
  find(a) {
    let par = 0, r = a;
    const path = [];
    while (this.p[r] !== r) { path.push(r); par ^= this.x[r]; r = this.p[r]; }
    // path compression with parity fix-up
    let acc = par;
    for (const v of path) { const old = this.x[v]; this.x[v] = acc; this.p[v] = r; acc ^= old; }
    return [r, par];
  }
  /** require parity(a) xor parity(b) == d; returns false if that contradicts existing constraints */
  union(a, b, d) {
    const [ra, pa] = this.find(a), [rb, pb] = this.find(b);
    if (ra === rb) return (pa ^ pb) === d;
    this.p[ra] = rb; this.x[ra] = pa ^ pb ^ d;
    return true;
  }
}

function segInter(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return [t, u];
}

/**
 * @param samples local samples {x,y}
 * @param closed  whether the stroke is a closed loop
 * @param xs      transform entries (entry 0 = identity)
 * @param maxHw   max half width (local units)
 * @returns {{nodes: Array<{s,h}>, plateau, crossings, alternations, alternationsKept, heightAt(s)}}
 */
export function solveWeave(samples, closed, xs, maxHw, flip = false) {
  const n = samples.length;
  const empty = { nodes: [], plateau: 1, crossings: 0, alternations: 0, alternationsKept: 0, heightAt: () => 0 };
  if (n < 2) return empty;
  const segN = closed ? n : n - 1;
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = samples[i - 1], b = samples[i % n];
    cum[i] = cum[i - 1] + (i < n || closed ? Math.hypot(b.x - a.x, b.y - a.y) : 0);
  }
  const total = closed ? cum[n] : cum[n - 1];

  // bounding circle + grid of source segments
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of samples) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let R0 = 0;
  for (const p of samples) R0 = Math.max(R0, Math.hypot(p.x - cx, p.y - cy));
  const cell = Math.max(6, Math.min(64, (x1 - x0 + y1 - y0) / 24));
  const gx0 = Math.floor(x0 / cell) - 1, gy0 = Math.floor(y0 / cell) - 1;
  const GW = Math.floor(x1 / cell) - gx0 + 2, GH = Math.floor(y1 / cell) - gy0 + 2;
  const grid = new Map();
  const addSeg = (i) => {
    const a = samples[i], b = samples[(i + 1) % n];
    const ia = Math.floor(Math.min(a.x, b.x) / cell) - gx0, ib = Math.floor(Math.max(a.x, b.x) / cell) - gx0;
    const ja = Math.floor(Math.min(a.y, b.y) / cell) - gy0, jb = Math.floor(Math.max(a.y, b.y) / cell) - gy0;
    for (let j = ja; j <= jb; j++) for (let k = ia; k <= ib; k++) {
      const key = j * GW + k;
      let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(i);
    }
  };
  for (let i = 0; i < segN; i++) addSeg(i);
  const stamp = new Int32Array(segN).fill(-1);
  let stampId = 0;

  const pairs = [];                    // [sA, sB]
  const scan = (P, self) => {
    for (let k = 0; k < segN; k++) {
      const a = P[k], b = P[(k + 1) % n];
      if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
      const ia = Math.floor(Math.min(a.x, b.x) / cell) - gx0, ib = Math.floor(Math.max(a.x, b.x) / cell) - gx0;
      const ja = Math.floor(Math.min(a.y, b.y) / cell) - gy0, jb = Math.floor(Math.max(a.y, b.y) / cell) - gy0;
      if (ib < 0 || jb < 0 || ia >= GW || ja >= GH) continue;
      stampId++;
      for (let j = Math.max(0, ja); j <= Math.min(GH - 1, jb); j++) for (let c = Math.max(0, ia); c <= Math.min(GW - 1, ib); c++) {
        const l = grid.get(j * GW + c);
        if (!l) continue;
        for (const i of l) {
          if (stamp[i] === stampId) continue;
          stamp[i] = stampId;
          if (self) {
            if (i >= k) continue;                                  // each unordered pair once
            if (k - i <= 1 || (closed && i === 0 && k === segN - 1)) continue;   // adjacent
          }
          const s0 = samples[i], s1 = samples[(i + 1) % n];
          const r = segInter(s0.x, s0.y, s1.x, s1.y, a.x, a.y, b.x, b.y);
          if (!r) continue;
          const sa = cum[i] + r[0] * (cum[i + 1] - cum[i]);
          const sb = cum[k] + r[1] * (cum[k + 1] - cum[k]);
          pairs.push([sa, sb]);
        }
      }
    }
  };

  scan(samples, true);
  let tested = 0;
  for (let j = 1; j < xs.length && tested < 1500; j++) {
    const m = xs[j].mob;
    const c = mobApply(m, cx, cy);
    const rj = R0 * mobScaleAt(m, cx, cy) * 1.6 + 1;
    if (Math.hypot(c.x - cx, c.y - cy) > R0 + rj + 2 * maxHw) continue;
    tested++;
    const P = samples.map((p) => mobApply(m, p.x, p.y));
    scan(P, false);
  }
  if (!pairs.length) return { ...empty, plateau: Math.max(2 * maxHw, 3) };

  // cluster arc-length positions into nodes
  const tol = Math.max(0.25, maxHw * 0.15);
  const all = [];
  pairs.forEach(([a, b], i) => { all.push([a, i, 0], [b, i, 1]); });
  all.sort((p, q) => p[0] - q[0]);
  const nodeOf = new Int32Array(all.length);
  const nodeS = [];
  const ends = new Array(pairs.length).fill(null).map(() => [0, 0]);
  let cur = -1, last = -Infinity, sum = 0, cnt = 0;
  const flush = () => { if (cur >= 0) nodeS[cur] = sum / cnt; };
  for (const [s, pi, side] of all) {
    if (s - last > tol) { flush(); cur++; sum = 0; cnt = 0; }
    sum += s; cnt++; last = s;
    ends[pi][side] = cur;
  }
  flush();
  const N = nodeS.length;
  const dsu = new ParityDSU(N);
  let crossings = 0;
  for (const [na, nb] of ends) if (na !== nb) { dsu.union(na, nb, 1); crossings++; }
  let alternations = 0, kept = 0;
  const alt = (a, b) => { alternations++; if (dsu.union(a, b, 1)) kept++; };
  for (let i = 0; i + 1 < N; i++) alt(i, i + 1);
  if (closed && N > 2) alt(N - 1, 0);

  const nodes = nodeS.map((s, i) => ({ s, h: (dsu.find(i)[1] ? -1 : 1) * (flip ? -1 : 1) }));
  const plateau = Math.max(2 * maxHw, 3);
  const heightAt = (s) => {
    // nearest nodes left / right
    let lo = 0, hi = N - 1;
    if (s <= nodes[0].s) return nodes[0].h;
    if (s >= nodes[N - 1].s) return nodes[N - 1].h;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (nodes[mid].s <= s) lo = mid; else hi = mid; }
    const L = nodes[lo], Rn = nodes[hi];
    const dl = s - L.s, dr = Rn.s - s;
    if (dl <= plateau || dr <= plateau) return dl <= dr ? L.h : Rn.h;
    const t = (s - L.s - plateau) / Math.max(1e-6, Rn.s - L.s - 2 * plateau);
    return L.h + (Rn.h - L.h) * Math.max(0, Math.min(1, t));
  };
  return { nodes, plateau, crossings, alternations, alternationsKept: kept, total, heightAt };
}
