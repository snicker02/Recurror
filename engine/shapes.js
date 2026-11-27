// Recurror — shape tool geometry. A drag from a to b (world, before symmetry) becomes control
// points for an ordinary stroke, so shapes get the brush, symmetry, recursion, knots and editing.

export const SHAPES = ['line', 'rect', 'ellipse', 'polygon', 'star', 'spiral', 'arc'];

const P = (x, y) => ({ x, y, p: 1, w: 1 });

/**
 * Points for a shape.
 *   o.fromCenter — the drag starts at the centre (ellipse, polygon, star, spiral are always centred)
 *   o.constrain  — square / circle / 15° steps
 *   o.sides, o.inner (star inner radius as a fraction), o.turns (spiral), o.sweep (arc, degrees)
 * Returns { points, spline, closed }.
 */
export function shapePoints(kind, a, b, o = {}) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (kind === 'line') {
    if (o.constrain) { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12), L = Math.hypot(dx, dy); dx = Math.cos(ang) * L; dy = Math.sin(ang) * L; }
    return { points: [P(a.x, a.y), P(a.x + dx, a.y + dy)], spline: 'linear', closed: false };
  }
  if (kind === 'rect') {
    if (o.constrain) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    let x0 = a.x, y0 = a.y, x1 = a.x + dx, y1 = a.y + dy;
    if (o.fromCenter) { x0 = a.x - dx; y0 = a.y - dy; }
    return { points: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], spline: 'linear', closed: true };
  }
  if (kind === 'ellipse') {
    let rx = Math.abs(dx), ry = Math.abs(dy), cx = a.x, cy = a.y;
    if (!o.fromCenter) { rx /= 2; ry /= 2; cx = a.x + dx / 2; cy = a.y + dy / 2; }
    if (o.constrain) rx = ry = Math.max(rx, ry);
    // 16 points through which a closed Catmull-Rom runs within 0.1 % of the true ellipse
    const n = 16, pts = [];
    for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; pts.push(P(cx + rx * Math.cos(t), cy + ry * Math.sin(t))); }
    return { points: pts, spline: 'catmull', closed: true };
  }
  // the rest are centred on a, sized and turned by the drag
  let R = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  if (o.constrain) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
  if (kind === 'polygon' || kind === 'star') {
    const n = Math.max(3, Math.round(o.sides || (kind === 'star' ? 5 : 6)));
    const inner = Math.max(0.05, Math.min(0.95, o.inner ?? 0.45));
    const pts = [];
    const k = kind === 'star' ? 2 * n : n;
    for (let i = 0; i < k; i++) {
      const r = kind === 'star' && i % 2 ? R * inner : R;
      const t = ang + i / k * Math.PI * 2;
      pts.push(P(a.x + r * Math.cos(t), a.y + r * Math.sin(t)));
    }
    return { points: pts, spline: 'linear', closed: true };
  }
  if (kind === 'spiral') {
    const turns = Math.max(0.25, o.turns ?? 3), per = 12, n = Math.max(4, Math.ceil(turns * per));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, t = ang + f * turns * Math.PI * 2;   // Archimedean: r grows evenly with the turn
      pts.push(P(a.x + R * f * Math.cos(t), a.y + R * f * Math.sin(t)));
    }
    return { points: pts, spline: 'catmull', closed: false };
  }
  if (kind === 'arc') {
    const sweep = (o.sweep ?? 180) * Math.PI / 180;
    const n = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 8)) + 1), pts = [];
    for (let i = 0; i < n; i++) { const t = ang + sweep * i / (n - 1); pts.push(P(a.x + R * Math.cos(t), a.y + R * Math.sin(t))); }
    return { points: pts, spline: 'catmull', closed: false };
  }
  throw new Error('unknown shape ' + kind);
}
