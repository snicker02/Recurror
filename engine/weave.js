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

  const pairs = [];                    // [sA, sB, half-overlap at A, half-overlap at B]
  // Two strands crossing at angle θ overlap over a diamond whose half-length along a strand is
  // (other half width + own half width·|cos θ|) / sin θ — long at shallow crossings. The height
  // must hold its value over all of it, or the lower strand pokes through at the diamond's tips.
  const reach = (hwOther, hwOwn, cos) => {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const L = (hwOther + hwOwn * cos) / Math.max(sin, 0.12) + 0.5 * hwOwn;
    return Math.max(1.5 * hwOwn, Math.min(L, 12 * hwOwn));
  };
  const scan = (P, self, sc = 1) => {
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
          const ux = s1.x - s0.x, uy = s1.y - s0.y, vx = b.x - a.x, vy = b.y - a.y;
          const cos = Math.min(1, Math.abs(ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1));
          pairs.push([sa, sb, reach(maxHw * sc, maxHw, cos), reach(maxHw / sc, maxHw, cos)]);
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
    scan(P, false, Math.max(1e-3, mobScaleAt(m, cx, cy)));
  }
  if (!pairs.length) return { ...empty, plateau: Math.max(2 * maxHw, 3) };

  // cluster arc-length positions into nodes
  const tol = Math.max(0.25, maxHw * 0.15);
  const all = [];
  pairs.forEach(([a, b, ra, rb], i) => { all.push([a, i, 0, ra], [b, i, 1, rb]); });
  all.sort((p, q) => p[0] - q[0]);
  const nodeOf = new Int32Array(all.length);
  const nodeS = [], nodeR = [];
  const ends = new Array(pairs.length).fill(null).map(() => [0, 0]);
  let cur = -1, last = -Infinity, sum = 0, cnt = 0, rmax = 0;
  const flush = () => { if (cur >= 0) { nodeS[cur] = sum / cnt; nodeR[cur] = rmax; } };
  for (const [s, pi, side, rr] of all) {
    if (s - last > tol) { flush(); cur++; sum = 0; cnt = 0; rmax = 0; }
    sum += s; cnt++; last = s; rmax = Math.max(rmax, rr);
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

  const nodes = nodeS.map((s, i) => ({ s, h: (dsu.find(i)[1] ? -1 : 1) * (flip ? -1 : 1), r: Math.max(3, nodeR[i]) }));
  const plateau = Math.max(2 * maxHw, 3);
  const heightAt = (s) => {
    // nearest nodes left / right
    let lo = 0, hi = N - 1;
    if (s <= nodes[0].s) return nodes[0].h;
    if (s >= nodes[N - 1].s) return nodes[N - 1].h;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (nodes[mid].s <= s) lo = mid; else hi = mid; }
    const L = nodes[lo], Rn = nodes[hi];
    if (L.h === Rn.h) return L.h;
    const dl = s - L.s, dr = Rn.s - s, gap = Rn.s - L.s;
    let t;
    if (L.r + Rn.r < gap) {
      // each crossing holds its height over its whole overlap, ramping in between
      if (dl <= L.r) return L.h;
      if (dr <= Rn.r) return Rn.h;
      t = (dl - L.r) / (gap - L.r - Rn.r);
    } else {
      // overlaps run into each other: a ramp from crossing to crossing instead of a hard step, so
      // a strand passing from over one neighbour to under the next stays between their heights
      t = dl / Math.max(1e-6, gap);
    }
    return L.h + (Rn.h - L.h) * Math.max(0, Math.min(1, t));
  };
  return { nodes, plateau, crossings, alternations, alternationsKept: kept, total, heightAt };
}

// ---------------------------------------------------------------------------------------------
// Knot weave: every strand of a layer, and all their symmetric copies, woven together.
// Each source stroke keeps one height profile shared by its copies. A crossing between copy g of
// stroke A and copy h of stroke B is the crossing of A with copy g⁻¹h of B, so scanning each source
// stroke against every copy of every stroke of the layer finds them all. Hard constraint: the two
// strands at a crossing sit at opposite heights. Soft: crossings alternate along each strand.
// ---------------------------------------------------------------------------------------------

function strandInfo(st) {
  const { samples, closed } = st;
  const n = samples.length;
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = samples[i - 1], b = samples[i % n];
    cum[i] = cum[i - 1] + (i < n || closed ? Math.hypot(b.x - a.x, b.y - a.y) : 0);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of samples) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let R = 0;
  for (const p of samples) R = Math.max(R, Math.hypot(p.x - cx, p.y - cy));
  const segN = closed ? n : n - 1;
  const cell = Math.max(6, Math.min(64, (x1 - x0 + y1 - y0) / 24));
  const gx0 = Math.floor(x0 / cell) - 1, gy0 = Math.floor(y0 / cell) - 1;
  const GW = Math.floor(x1 / cell) - gx0 + 2, GH = Math.floor(y1 / cell) - gy0 + 2;
  const grid = new Map();
  for (let i = 0; i < segN; i++) {
    const a = samples[i], b = samples[(i + 1) % n];
    const ia = Math.floor(Math.min(a.x, b.x) / cell) - gx0, ib = Math.floor(Math.max(a.x, b.x) / cell) - gx0;
    const ja = Math.floor(Math.min(a.y, b.y) / cell) - gy0, jb = Math.floor(Math.max(a.y, b.y) / cell) - gy0;
    for (let j = ja; j <= jb; j++) for (let k = ia; k <= ib; k++) {
      const key = j * GW + k;
      let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(i);
    }
  }
  return { ...st, n, segN, cum, total: closed ? cum[n] : cum[n - 1], cx, cy, R, cell, gx0, gy0, GW, GH, grid, stamp: new Int32Array(Math.max(1, segN)).fill(-1), stampId: 0 };
}

/**
 * @param strands [{ id, samples, closed, xs (copies), maxHw, flip }]
 * @returns Map id → { heightAt(s), nodes, crossings }
 */
export function solveKnot(strands) {
  const S = strands.filter((s) => s.samples.length >= 2).map(strandInfo);
  const out = new Map();
  for (const s of strands) out.set(s.id, { heightAt: () => 0, underAt: () => 1e4, unders: [], nodes: [], crossings: 0 });
  if (!S.length) return out;
  const reach = (hwOther, hwOwn, cos) => {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const L = (hwOther + hwOwn * cos) / Math.max(sin, 0.12) + 0.5 * hwOwn;
    return Math.max(1.5 * hwOwn, Math.min(L, 12 * hwOwn));
  };
  const pairs = [];   // [ia, sa, ib, sb, ra, rb]
  for (let ai = 0; ai < S.length; ai++) {
    const A = S[ai];
    for (let bi = 0; bi < S.length; bi++) {
      const B = S[bi];
      let tested = 0;
      for (let j = 0; j < B.xs.length && tested < 1500; j++) {
        const m = B.xs[j].mob;
        const self = ai === bi && j === 0;
        const c = mobApply(m, B.cx, B.cy);
        const sc = Math.max(1e-3, mobScaleAt(m, B.cx, B.cy));
        if (Math.hypot(c.x - A.cx, c.y - A.cy) > A.R + B.R * sc * 1.6 + 2 * (A.maxHw + B.maxHw)) continue;
        tested++;
        const P = B.samples.map((p) => mobApply(m, p.x, p.y));
        for (let k = 0; k < B.segN; k++) {
          const a = P[k], b = P[(k + 1) % B.n];
          if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
          const ia = Math.floor(Math.min(a.x, b.x) / A.cell) - A.gx0, ib = Math.floor(Math.max(a.x, b.x) / A.cell) - A.gx0;
          const ja = Math.floor(Math.min(a.y, b.y) / A.cell) - A.gy0, jb = Math.floor(Math.max(a.y, b.y) / A.cell) - A.gy0;
          if (ib < 0 || jb < 0 || ia >= A.GW || ja >= A.GH) continue;
          A.stampId++;
          for (let r = Math.max(0, ja); r <= Math.min(A.GH - 1, jb); r++) for (let cc = Math.max(0, ia); cc <= Math.min(A.GW - 1, ib); cc++) {
            const l = A.grid.get(r * A.GW + cc);
            if (!l) continue;
            for (const i of l) {
              if (A.stamp[i] === A.stampId) continue;
              A.stamp[i] = A.stampId;
              if (self) {
                if (i >= k) continue;
                if (k - i <= 1 || (A.closed && i === 0 && k === A.segN - 1)) continue;
              }
              const s0 = A.samples[i], s1 = A.samples[(i + 1) % A.n];
              const rr = segInter(s0.x, s0.y, s1.x, s1.y, a.x, a.y, b.x, b.y);
              if (!rr) continue;
              const sa = A.cum[i] + rr[0] * (A.cum[i + 1] - A.cum[i]);
              const sb = B.cum[k] + rr[1] * (B.cum[k + 1] - B.cum[k]);
              const ux = s1.x - s0.x, uy = s1.y - s0.y, vx = b.x - a.x, vy = b.y - a.y;
              const lu = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
              const dot = (ux * vx + uy * vy) / lu, crs = (ux * vy - uy * vx) / lu;
              const cos = Math.min(1, Math.abs(dot));
              // where the other strand's edges cross this one, for shading where a strand passes
              // under: in this strand's (arc length s, lateral x) the other's centre line is
              // s = s0 + x·cot, and it covers ±hwOther/|sin| along s about it
              const sin = Math.max(0.12, Math.abs(crs)), cot = dot / (Math.abs(crs) < 1e-6 ? 1e-6 : crs);
              const cotC = Math.max(-8.3, Math.min(8.3, cot));
              const orient = m.conj ? -1 : 1;
              pairs.push([ai, sa, bi, sb, reach(B.maxHw * sc, A.maxHw, cos), reach(A.maxHw / sc, B.maxHw, cos),
                cotC, B.maxHw * sc / sin, -orient * cotC, A.maxHw / sc / sin]);
            }
          }
        }
      }
    }
  }
  // cluster each strand's crossing positions into nodes
  const per = S.map(() => []);
  pairs.forEach(([ai, sa, bi, sb, ra, rb], p) => { per[ai].push([sa, p, 0, ra]); per[bi].push([sb, p, 1, rb]); });
  const ends = pairs.map(() => [0, 0]);
  const nodeBase = [], nodeS = [], nodeR = [], nodeStrand = [];
  S.forEach((A, ai) => {
    const list = per[ai].sort((p, q) => p[0] - q[0]);
    const tol = Math.max(0.25, A.maxHw * 0.15);
    nodeBase[ai] = nodeS.length;
    let last = -Infinity, sum = 0, cnt = 0, rmax = 0, cur = -1;
    const flush = () => { if (cur >= 0) { nodeS[cur] = sum / cnt; nodeR[cur] = rmax; nodeStrand[cur] = ai; } };
    for (const [s, p, side, rr] of list) {
      if (s - last > tol) { flush(); cur = nodeS.length; nodeS.push(0); nodeR.push(0); nodeStrand.push(ai); sum = 0; cnt = 0; rmax = 0; }
      sum += s; cnt++; last = s; rmax = Math.max(rmax, rr);
      ends[p][side] = cur;
    }
    flush();
  });
  const N = nodeS.length;
  const dsu = new ParityDSU(N);
  let crossings = 0;
  for (const [na, nb] of ends) if (na !== nb) { dsu.union(na, nb, 1); crossings++; }
  // alternation along each strand
  S.forEach((A, ai) => {
    const b0 = nodeBase[ai], b1 = ai + 1 < S.length ? nodeBase[ai + 1] : N;
    for (let i = b0; i + 1 < b1; i++) dsu.union(i, i + 1, 1);
    if (A.closed && b1 - b0 > 2) dsu.union(b1 - 1, b0, 1);
  });
  // the crossings each strand passes under (h < 0 at its node), with the over strand's footprint
  const unders = S.map(() => []);
  const hOf = (node) => (dsu.find(node)[1] ? -1 : 1) * (S[nodeStrand[node]].flip ? -1 : 1);
  pairs.forEach(([ai, sa, bi, sb, , , cA, oA, cB, oB], p) => {
    const [na, nb] = ends[p];
    if (na === nb) return;
    if (hOf(na) < 0) unders[ai].push({ s: sa, c: cA, o: oA });
    if (hOf(nb) < 0) unders[bi].push({ s: sb, c: cB, o: oB });
  });
  S.forEach((A, ai) => {
    const b0 = nodeBase[ai], b1 = ai + 1 < S.length ? nodeBase[ai + 1] : N;
    const nodes = [];
    for (let i = b0; i < b1; i++) nodes.push({ s: nodeS[i], h: (dsu.find(i)[1] ? -1 : 1) * (A.flip ? -1 : 1), r: Math.max(3, nodeR[i]) });
    const M = nodes.length;
    const heightAt = (s) => {
      if (!M) return 0;
      if (s <= nodes[0].s) return nodes[0].h;
      if (s >= nodes[M - 1].s) return nodes[M - 1].h;
      let lo = 0, hi = M - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (nodes[mid].s <= s) lo = mid; else hi = mid; }
      const L = nodes[lo], Rn = nodes[hi];
      if (L.h === Rn.h) return L.h;
      const dl = s - L.s, dr = Rn.s - s, gap = Rn.s - L.s;
      let t;
      if (L.r + Rn.r < gap) {
        if (dl <= L.r) return L.h;
        if (dr <= Rn.r) return Rn.h;
        t = (dl - L.r) / (gap - L.r - Rn.r);
      } else t = dl / Math.max(1e-6, gap);
      return L.h + (Rn.h - L.h) * Math.max(0, Math.min(1, t));
    };
    // distance along the strand from (s, x) to the nearest edge of a strand passing over it
    // (negative inside the covered part): where "end shading" starts when a strand goes under
    const U = unders[ai], T = A.total;
    const underAt = (s, x) => {
      let d = 1e4;
      for (const u of U) {
        let ds = s - u.s - x * u.c;
        if (A.closed && T > 0) ds -= T * Math.round(ds / T);
        d = Math.min(d, Math.abs(ds) - u.o);
      }
      return d;
    };
    out.set(A.id, { heightAt, underAt, unders: U, nodes, crossings: nodes.length });
  });
  return out;
}
