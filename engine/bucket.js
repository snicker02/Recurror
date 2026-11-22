// Paint bucket: flood-fill a region of the rendered drawing and turn it into a vector fill.
//
// 1. floodRegion   — colour-matched flood fill on an RGBA image, with optional gap closing
//                    (gaps narrower than 2·gap px don't leak) and a small grow so the fill
//                    tucks under the surrounding lines instead of leaving a hairline.
// 2. traceRegion   — crack-following contour trace (outer boundary and holes), smoothed to edge
//                    midpoints and simplified.
// 3. keyhole       — joins every contour into one closed polygon with zero-width bridges. The
//                    renderer fills even-odd, so a bridge walked out and back cancels exactly
//                    and holes stay holes, while the result is still an ordinary editable stroke.

/** Two-pass 3-4 chamfer distance (in units of 1/3 px) to the nearest pixel where src[i] is set. */
function chamfer(src, W, H) {
  const INF = 1 << 28;
  const d = new Int32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v = d[i];
    if (v === 0) continue;
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) {
      v = Math.min(v, d[i - W] + 3);
      if (x > 0) v = Math.min(v, d[i - W - 1] + 4);
      if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
    }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    let v = d[i];
    if (v === 0) continue;
    if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < H - 1) {
      v = Math.min(v, d[i + W] + 3);
      if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
      if (x > 0) v = Math.min(v, d[i + W - 1] + 4);
    }
    d[i] = v;
  }
  return d;
}

/**
 * @param {Uint8Array} px  RGBA, rows top-down
 * @param {number} tol     max per-channel difference (0–255) from the seed colour
 * @param {number} gap     close gaps up to 2·gap px wide
 * @param {number} grow    extra px the finished region spreads under its border
 * @returns {{mask: Uint8Array, count: number, touchesEdge: boolean} | null}
 */
export function floodRegion(px, W, H, sx, sy, tol = 24, gap = 0, grow = 1.5) {
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const s = (sy * W + sx) * 4;
  const r0 = px[s], g0 = px[s + 1], b0 = px[s + 2], a0 = px[s + 3];
  const N = W * H;
  const block = new Uint8Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const d = Math.max(Math.abs(px[j] - r0), Math.abs(px[j + 1] - g0), Math.abs(px[j + 2] - b0), Math.abs(px[j + 3] - a0));
    block[i] = d > tol ? 1 : 0;
  }
  let pass = block;
  if (gap > 0) {
    const dist = chamfer(block, W, H);
    const lim = Math.round(gap * 3);
    pass = new Uint8Array(N);
    for (let i = 0; i < N; i++) pass[i] = dist[i] > lim ? 0 : 1;
    if (pass[sy * W + sx]) pass = block;          // seed sits in a narrow spot: no gap closing there
  }
  const mask = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0, count = 0, touchesEdge = false;
  stack[sp++] = sy * W + sx; mask[sy * W + sx] = 1;
  while (sp) {
    const i = stack[--sp];
    count++;
    const x = i % W, y = (i - x) / W;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;
    if (x > 0 && !mask[i - 1] && !pass[i - 1]) { mask[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < W - 1 && !mask[i + 1] && !pass[i + 1]) { mask[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && !mask[i - W] && !pass[i - W]) { mask[i - W] = 1; stack[sp++] = i - W; }
    if (y < H - 1 && !mask[i + W] && !pass[i + W]) { mask[i + W] = 1; stack[sp++] = i + W; }
  }
  const spread = (pass === block ? 0 : gap) + grow;
  if (spread > 0) {
    const dist = chamfer(mask, W, H);
    const lim = Math.round(spread * 3);
    for (let i = 0; i < N; i++) if (dist[i] <= lim) mask[i] = 1;
  }
  return { mask, count, touchesEdge };
}

function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[i], r = p[(i + 1) % n]; a += q.x * r.y - r.x * q.y; }
  return a / 2;
}

function rdpOpen(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1e-12;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const c = (dx * (P.y - A.y) - dy * (P.x - A.x));
      const d2 = (c * c) / L2;
      if (d2 > bd) { bd = d2; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function rdpClosed(pts, tol) {
  const n = pts.length;
  if (n < 8) return pts.slice();
  // split at the vertex farthest from vertex 0
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = rdpOpen(pts.slice(0, far + 1), tol);
  const b = rdpOpen(pts.slice(far).concat([pts[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/**
 * Contours of a binary mask, in pixel units (pixel (x, y) covers [x, x+1]×[y, y+1]).
 * @returns {Array<Array<{x,y}>>} closed loops (outer boundary and holes), smallest specks dropped
 */
export function traceRegion(mask, W, H, tol = 0.8, minArea = 6) {
  // work in the region's bounding box only
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return [];
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const inside = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && mask[(y + y0) * W + x + x0] === 1;
  const VW = bw + 1;
  // outgoing crack edges per vertex, walking with the region on the right: bit 1=E 2=S 4=W 8=N
  const out = new Uint8Array(VW * (bh + 1));
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) out[y * VW + x] |= 1;
    if (!inside(x + 1, y)) out[y * VW + x + 1] |= 2;
    if (!inside(x, y + 1)) out[(y + 1) * VW + x + 1] |= 4;
    if (!inside(x - 1, y)) out[(y + 1) * VW + x] |= 8;
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const loops = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    if (!out[v0]) continue;
    const verts = [];
    let v = v0, d = -1;
    while (out[v]) {
      const bits = out[v];
      let nd;
      if (d < 0) nd = [0, 1, 2, 3].find((k) => bits & (1 << k));
      else {
        const pref = [(d + 1) & 3, d, (d + 3) & 3];      // right turn first: diagonal pixels stay apart
        nd = pref.find((k) => bits & (1 << k));
        if (nd === undefined) break;
      }
      out[v] &= ~(1 << nd);
      const x = v % VW, y = (v - x) / VW;
      verts.push({ x, y });
      v = (y + DY[nd]) * VW + x + DX[nd];
      d = nd;
    }
    if (verts.length < 4) continue;
    // edge midpoints round off the staircase into proper diagonals
    const mids = verts.map((p, i) => { const q = verts[(i + 1) % verts.length]; return { x: (p.x + q.x) / 2 + x0, y: (p.y + q.y) / 2 + y0 }; });
    if (Math.abs(polyArea(mids)) < minArea) continue;
    const simp = rdpClosed(mids, tol);
    if (simp.length >= 3) loops.push(simp);
  }
  return loops;
}

/** One polygon from several loops via zero-width bridges (valid for even-odd filling). */
export function keyhole(loops) {
  if (!loops.length) return [];
  const sorted = loops.slice().sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  let poly = sorted[0].slice();
  for (let k = 1; k < sorted.length; k++) {
    const h = sorted[k];
    let bi = 0, bj = 0, bd = Infinity;
    const stepP = Math.max(1, Math.floor(poly.length / 400)), stepH = Math.max(1, Math.floor(h.length / 200));
    for (let i = 0; i < poly.length; i += stepP) for (let j = 0; j < h.length; j += stepH) {
      const d = (poly[i].x - h[j].x) ** 2 + (poly[i].y - h[j].y) ** 2;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    const ring = h.slice(bj).concat(h.slice(0, bj + 1));
    poly = poly.slice(0, bi + 1).concat(ring, [{ ...poly[bi] }], poly.slice(bi + 1));
  }
  return poly;
}
