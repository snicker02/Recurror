// Recurror — similarity transforms of whole strokes (scale / rotate / move about a pivot).
//
// A stroke's look is its points (pre-symmetry, pre-warp) plus everything that places its copies:
// the symmetry centre, angles and lattice / strip / disc sizes, the recursion offset and angle, and
// the warp scale. Mapping all of them by the same similarity S (p → P + k·R(φ)·(p − P), then + t)
// maps every copy by S as well, so the drawing scales and rotates as one, copies included. Lengths
// in the style (width, dashes, jitter / wobble scales, ink, wet spread, gradient period, fill
// pattern scale) scale with it, so a stroke looks the same, only bigger.
//
// Angles are degrees, counter-clockwise on screen; the world is y-down, so a screen rotation by φ
// (clockwise for φ > 0 in these coordinates) lowers each stored angle by φ.

const RADIAL_WARPS = new Set(['none', 'swirl', 'twirl', 'spherical', 'bubble', 'eyefish', 'ripple', 'pinch']);
const STYLE_LENGTHS = ['width', 'dashLen', 'dashGap', 'jitterScale', 'wobbleScale', 'stitchSpacing', 'ink', 'spread', 'gradPeriod'];

/** Can these strokes be rotated exactly? Wallpaper lattices have no orientation, and only radial warps turn with the drawing. */
export function canRotate(strokes) {
  return strokes.every((s) => s.sym.mode !== 'wallpaper' && (!s.warp || !(s.warp.amount > 0) || RADIAL_WARPS.has(s.warp.type)));
}

/** The similarity as a function: rotate by phi (radians) and scale by k about P, then shift by t. */
export function similarity(P, k, phi, t = { x: 0, y: 0 }) {
  const c = Math.cos(phi) * k, s = Math.sin(phi) * k;
  const f = (x, y) => {
    const dx = x - P.x, dy = y - P.y;
    return { x: P.x + c * dx - s * dy + t.x, y: P.y + s * dx + c * dy + t.y };
  };
  f.k = k; f.phi = phi;
  return f;
}

const deg = (r) => r * 180 / Math.PI;
const wrap = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return Math.round(a * 1e6) / 1e6; };

/** Map a symmetry / recursion / warp triple (the parts a group shares with its strokes) in place. */
export function transformPlacement(sym, rec, warp, S) {
  const k = S.k, dA = deg(S.phi);
  if (sym) {
    const c = S(+sym.cx, +sym.cy);
    sym.cx = c.x; sym.cy = c.y;
    if (dA) { sym.angle = wrap((+sym.angle || 0) - dA); sym.frAngle = wrap((+sym.frAngle || 0) - dA); }
    for (const key of ['tileDX', 'tileDY', 'frLen', 'hR', 'invD', 'invR', 'invHub']) if (Number.isFinite(+sym[key])) sym[key] = +sym[key] * k;
  }
  if (rec) {
    if (Number.isFinite(+rec.offset)) rec.offset = +rec.offset * k;
    if (dA) rec.angle = wrap((+rec.angle || 0) - dA);
  }
  if (warp && Number.isFinite(+warp.scale)) warp.scale = +warp.scale * k;
}

/** Map one stroke in place by the similarity S. */
export function transformStroke(s, S) {
  const k = S.k, dA = deg(S.phi);
  for (const p of s.points) { const q = S(p.x, p.y); p.x = q.x; p.y = q.y; }
  if (s.cropAt) s.cropAt = S(s.cropAt.x, s.cropAt.y);
  transformPlacement(s.sym, s.rec, s.warp, S);
  const st = s.style;
  for (const key of STYLE_LENGTHS) if (Number.isFinite(+st[key])) st[key] = +st[key] * k;
  if (dA && Number.isFinite(+st.nibAngle)) st.nibAngle = wrap(+st.nibAngle - dA);
  if (s.fill) {
    if (Number.isFinite(+s.fill.scale)) s.fill.scale = +s.fill.scale * k;
    if (dA && Number.isFinite(+s.fill.angle)) s.fill.angle = wrap(+s.fill.angle - dA);
  }
}

/** Deep copy of the parts transformStroke changes, and the way back (for live dragging). */
export function snapshot(s) {
  return JSON.parse(JSON.stringify({ points: s.points, cropAt: s.cropAt || null, sym: s.sym, rec: s.rec, warp: s.warp, style: s.style, fill: s.fill }));
}
export function restore(s, snap) {
  s.points.forEach((p, i) => Object.assign(p, snap.points[i]));
  if (snap.cropAt) s.cropAt = { ...snap.cropAt }; else delete s.cropAt;
  for (const key of ['sym', 'rec', 'warp', 'style', 'fill']) if (s[key]) Object.assign(s[key], snap[key]);
}
