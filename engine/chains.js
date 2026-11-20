// Recurror — end-to-end chains of separate strokes, so touching ends blend at render time.
//
// Open strokes on the same layer whose endpoints touch (identity copy, after warp) are linked into
// chains. Each stroke learns where it sits along its chain (offset, its own length, chain length,
// whether it runs backwards) and which of its ends are linked. The renderer uses that to run the
// gradient / bands / ribbon twist continuously through the joins, skip tapering at linked ends,
// and shade linked end caps as tube continuation rather than a dome.
import { getSamples, isClosed } from './geometry.js';
import { warpActive, warpPoint, warpInverse } from './warp.js';

function arcLength(samples) {
  let L = 0;
  for (let i = 1; i < samples.length; i++) L += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  return L;
}

const view = (s, p) => (warpActive(s.warp) ? warpPoint(s.warp, +s.sym.cx, +s.sym.cy, p.x, p.y) : p);

/**
 * @returns Map strokeId → { off, len, total, rev, joinS, joinE, chain }   (lengths in local units)
 */
export function computeChains(doc) {
  const out = new Map();
  for (const s of doc.strokes) { s._ghosts = null; s._ghostKey = ''; }
  const ends = [];                                   // {s, which: 0 start | 1 end, x, y, w}
  for (const s of doc.strokes) {
    if (isClosed(s) || s.points.length < 2) continue;
    const a = s.points[0], b = s.points[s.points.length - 1];
    const va = view(s, a), vb = view(s, b);
    ends.push({ s, which: 0, x: va.x, y: va.y, w: s.style.width * (a.w ?? 1) });
    ends.push({ s, which: 1, x: vb.x, y: vb.y, w: s.style.width * (b.w ?? 1) });
  }
  // candidate links: different strokes, same layer, endpoints within tolerance; closest first
  const cand = [];
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const A = ends[i], B = ends[j];
    if (A.s === B.s || A.s.layer !== B.s.layer) continue;
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    const tol = Math.max(2, 0.4 * Math.min(A.w, B.w));
    if (d <= tol) cand.push([d, i, j]);
  }
  cand.sort((p, q) => p[0] - q[0]);
  const link = new Map();                            // endpoint index → endpoint index
  for (const [, i, j] of cand) if (!link.has(i) && !link.has(j)) { link.set(i, j); link.set(j, i); }
  if (!link.size) return out;

  // ghost tangents: each linked end borrows the neighbour's next control point (in this stroke's frame)
  const unview = (s, w) => (warpActive(s.warp) ? warpInverse(s.warp, +s.sym.cx, +s.sym.cy, w.x, w.y) : w);
  for (const [i, j] of link) {
    const A = ends[i], B = ends[j];
    const side = A.which === 0 ? 's' : 'e';
    A.s._ghosts = A.s._ghosts || {};
    // both ends meet exactly at their midpoint
    const m = unview(A.s, { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    A.s._ghosts['p' + side] = { x: m.x, y: m.y };
    if (A.s.shape.spline !== 'catmull') continue;
    const bp = B.s.points, k = B.which === 0 ? Math.min(1, bp.length - 1) : Math.max(0, bp.length - 2);
    const g = unview(A.s, view(B.s, bp[k]));
    A.s._ghosts[side] = { x: g.x, y: g.y };
  }
  const f = (q) => (q ? q.x.toFixed(3) + ',' + q.y.toFixed(3) : '-');
  for (const s of doc.strokes) if (s._ghosts) {
    const g = s._ghosts;
    s._ghostKey = [f(g.s), f(g.e), f(g.ps), f(g.pe)].join('|');
  }
  // neighbour samples across each join (samples now reflect the ghosts above)
  const tans = new Map();
  for (const [i, j] of link) {
    const A = ends[i], B = ends[j];
    const sb = getSamples(B.s);
    if (sb.length < 2) continue;
    const q = sb[B.which === 0 ? 1 : sb.length - 2];
    const t = unview(A.s, view(B.s, q));
    if (!tans.has(A.s)) tans.set(A.s, {});
    tans.get(A.s)[A.which === 0 ? 'ts' : 'te'] = { x: t.x, y: t.y };
  }

  const idx = new Map();                             // stroke → [startIdx, endIdx]
  ends.forEach((e, k) => { if (!idx.has(e.s)) idx.set(e.s, [-1, -1]); idx.get(e.s)[e.which] = k; });
  const seen = new Set();
  const walk = (first, enterWhich, loop = false) => {
    // enterWhich: the end of `first` that is the chain's free (or cut) end
    const chain = [];
    let s = first, inWhich = enterWhich;
    while (s && !seen.has(s)) {
      seen.add(s);
      const outWhich = 1 - inWhich;
      chain.push({ s, rev: inWhich === 1 });
      const k = idx.get(s)[outWhich];
      const nk = link.get(k);
      if (nk === undefined) break;
      s = ends[nk].s; inWhich = ends[nk].which;
    }
    let total = 0;
    const lens = chain.map((c) => { const L = arcLength(getSamples(c.s)); total += L; return L; });
    let off = 0;
    chain.forEach((c, i) => {
      const [si, ei] = idx.get(c.s);
      const tn = tans.get(c.s) || {};
      out.set(c.s.id, { off, len: lens[i], total, rev: c.rev, joinS: link.has(si), joinE: link.has(ei), chain: chain.length, ts: tn.ts || null, te: tn.te || null, loop });
      off += lens[i];
    });
  };
  // open chains: start from a stroke with a free end
  for (const [s, [si, ei]] of idx) {
    if (seen.has(s)) continue;
    const freeS = !link.has(si), freeE = !link.has(ei);
    if ((freeS || freeE) && (link.has(si) || link.has(ei))) walk(s, freeS ? 0 : 1);
  }
  // loops: cut anywhere
  for (const [s, [si, ei]] of idx) if (!seen.has(s) && link.has(si) && link.has(ei)) walk(s, 0, true);
  return out;
}

let cacheKey = '', cacheVal = new Map();
export function chainsCached(doc) {
  let key = '';
  for (const s of doc.strokes) {
    if (s.points.length < 2) continue;
    key += s.id + ':' + s.rev + ':' + s.layer + ':' + (s.shape.closed ? 1 : 0) + ':' + s.style.width + ':' +
      (warpActive(s.warp) ? JSON.stringify(s.warp) + s.sym.cx + ',' + s.sym.cy : '') + '|';
  }
  key += doc.blendEnds === false ? 'off' : 'on';
  if (key !== cacheKey) { cacheKey = key; cacheVal = doc.blendEnds === false ? clearChains(doc) : computeChains(doc); }
  return cacheVal;
}

function clearChains(doc) {
  for (const s of doc.strokes) { s._ghosts = null; s._ghostKey = ''; }
  return new Map();
}
