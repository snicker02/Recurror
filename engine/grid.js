// Recurror — drawing grid: square, dots, isometric (triangular) or polar, centred on the artboard.
// It is a drawing aid only: drawn on the overlay, never rendered or exported, and independent of
// the symmetry. With Snap on, points snap to its intersections first, then onto its lines.

export const GRID_TYPES = ['square', 'dots', 'iso', 'polar'];

/** Grid settings from the document. */
export function gridOf(doc) {
  if (!doc.gridOn) return null;
  return {
    type: GRID_TYPES.includes(doc.gridType) ? doc.gridType : 'square',
    size: Math.max(2, +doc.gridSize || 64),            // major spacing (drawing units)
    sub: Math.max(1, Math.round(+doc.gridSub || 4)),   // minor divisions per major cell
    spokes: Math.max(4, Math.round(+doc.gridSpokes || 24)),
    ox: doc.width / 2, oy: doc.height / 2,
  };
}

const S3 = Math.sqrt(3) / 2;

/** Snap targets near (x, y): the nearest intersections, plus the lines through them. */
export function gridSnapTargets(g, x, y) {
  const points = [], lines = [];
  const m = g.size / g.sub;
  if (g.type === 'square' || g.type === 'dots') {
    const i0 = Math.round((x - g.ox) / m), j0 = Math.round((y - g.oy) / m);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) points.push({ x: g.ox + i * m, y: g.oy + j * m, kind: 'node' });
    if (g.type === 'square') {
      lines.push({ pts: [{ x: g.ox + i0 * m, y: y - 4 * m }, { x: g.ox + i0 * m, y: y + 4 * m }], kind: 'cell' });
      lines.push({ pts: [{ x: x - 4 * m, y: g.oy + j0 * m }, { x: x + 4 * m, y: g.oy + j0 * m }], kind: 'cell' });
    }
  } else if (g.type === 'iso') {
    // triangular lattice: a = (m, 0), b = (m/2, m·√3/2)
    const v = (y - g.oy) / (m * S3), u = (x - g.ox) / m - v / 2;
    const i0 = Math.round(u), j0 = Math.round(v);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      points.push({ x: g.ox + (i + j / 2) * m, y: g.oy + j * m * S3, kind: 'node' });
    }
    const P = { x: g.ox + (i0 + j0 / 2) * m, y: g.oy + j0 * m * S3 };
    for (const ang of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      const dx = Math.cos(ang) * 4 * m, dy = Math.sin(ang) * 4 * m;
      lines.push({ pts: [{ x: P.x - dx, y: P.y - dy }, { x: P.x + dx, y: P.y + dy }], kind: 'cell' });
    }
  } else {
    // polar: rings every minor step, spokes evenly round
    const dx = x - g.ox, dy = y - g.oy;
    const r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    const k0 = Math.round(r / m), step = 2 * Math.PI / g.spokes, a0 = Math.round(th / step);
    points.push({ x: g.ox, y: g.oy, kind: 'center' });
    for (let k = Math.max(1, k0 - 1); k <= k0 + 1; k++) for (let a = a0 - 1; a <= a0 + 1; a++) {
      points.push({ x: g.ox + Math.cos(a * step) * k * m, y: g.oy + Math.sin(a * step) * k * m, kind: 'node' });
    }
    if (k0 > 0) {
      const ring = [];
      for (let t = -6; t <= 6; t++) { const a = th + t * step / 4; ring.push({ x: g.ox + Math.cos(a) * k0 * m, y: g.oy + Math.sin(a) * k0 * m }); }
      lines.push({ pts: ring, kind: 'cell' });
    }
    lines.push({ pts: [{ x: g.ox, y: g.oy }, { x: g.ox + Math.cos(a0 * step) * (r + 4 * m), y: g.oy + Math.sin(a0 * step) * (r + 4 * m) }], kind: 'cell' });
  }
  return { points, lines };
}

/**
 * Draw the grid over the artboard. Minor lines fade out (and then majors) when they'd be closer
 * than a few pixels, so the grid never turns into a grey wash.
 */
export function drawGrid(ctx, g, view, W, H) {
  const { zoom, panX, panY } = view;
  const X = (x) => x * zoom + panX, Y = (y) => y * zoom + panY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(X(0), Y(0), W * zoom, H * zoom);
  ctx.clip();
  ctx.setLineDash([]);
  const m = g.size / g.sub;
  const minorOn = m * zoom >= 7, majorOn = g.size * zoom >= 5;
  const minorCol = 'rgba(148,163,184,0.16)', majorCol = 'rgba(148,163,184,0.36)';
  // visible artboard part in world units
  const cw = ctx.canvas.width / (view.dpr || 1), ch = ctx.canvas.height / (view.dpr || 1);
  const x0 = Math.max(0, -panX / zoom), x1 = Math.min(W, (cw - panX) / zoom);
  const y0 = Math.max(0, -panY / zoom), y1 = Math.min(H, (ch - panY) / zoom);
  const line = (ax, ay, bx, by) => { ctx.moveTo(Math.round(X(ax)) + 0.5, Math.round(Y(ay)) + 0.5); ctx.lineTo(Math.round(X(bx)) + 0.5, Math.round(Y(by)) + 0.5); };
  const pass = (col, width, each) => { ctx.strokeStyle = col; ctx.lineWidth = width; ctx.beginPath(); each(); ctx.stroke(); };
  if (g.type === 'square') {
    const grid = (step, skipMajor) => {
      const i0 = Math.floor((x0 - g.ox) / step), i1 = Math.ceil((x1 - g.ox) / step);
      const j0 = Math.floor((y0 - g.oy) / step), j1 = Math.ceil((y1 - g.oy) / step);
      for (let i = i0; i <= i1; i++) { if (skipMajor && i % g.sub === 0) continue; const x = g.ox + i * step; line(x, y0, x, y1); }
      for (let j = j0; j <= j1; j++) { if (skipMajor && j % g.sub === 0) continue; const y = g.oy + j * step; line(x0, y, x1, y); }
    };
    if (minorOn && g.sub > 1) pass(minorCol, 1, () => grid(m, true));
    if (majorOn) pass(majorCol, 1, () => grid(g.size, false));
  } else if (g.type === 'dots') {
    const step = minorOn ? m : (majorOn ? g.size : 0);
    if (step) {
      const i0 = Math.floor((x0 - g.ox) / step), i1 = Math.ceil((x1 - g.ox) / step);
      const j0 = Math.floor((y0 - g.oy) / step), j1 = Math.ceil((y1 - g.oy) / step);
      const k = Math.round(g.size / step);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) < 60000) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const major = (i % k === 0) && (j % k === 0);
        ctx.fillStyle = major ? 'rgba(203,213,225,0.7)' : 'rgba(148,163,184,0.45)';
        const r = major ? 1.8 : 1.1;
        ctx.fillRect(X(g.ox + i * step) - r, Y(g.oy + j * step) - r, 2 * r, 2 * r);
      }
    }
  } else if (g.type === 'iso') {
    // three families of lines at 0°, 60° and 120°, spaced m·√3/2 apart
    const fam = (step, skipMajor) => {
      const d = step * S3, R = Math.hypot(x1 - x0, y1 - y0) + step;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (const ang of [0, Math.PI / 3, 2 * Math.PI / 3]) {
        const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
        const c0 = (cx - g.ox) * nx + (cy - g.oy) * ny;
        const k0 = Math.floor((c0 - R) / d), k1 = Math.ceil((c0 + R) / d);
        for (let k = k0; k <= k1; k++) {
          if (skipMajor && k % g.sub === 0) continue;
          const px = g.ox + nx * k * d, py = g.oy + ny * k * d;
          const t = (cx - px) * ux + (cy - py) * uy;
          line(px + ux * (t - R), py + uy * (t - R), px + ux * (t + R), py + uy * (t + R));
        }
      }
    };
    if (minorOn && g.sub > 1) pass(minorCol, 1, () => fam(m, true));
    if (majorOn) pass(majorCol, 1, () => fam(g.size, false));
  } else {
    const R = Math.max(Math.hypot(x0 - g.ox, y0 - g.oy), Math.hypot(x1 - g.ox, y0 - g.oy), Math.hypot(x0 - g.ox, y1 - g.oy), Math.hypot(x1 - g.ox, y1 - g.oy));
    const rings = (step, skipMajor) => {
      for (let k = 1; k * step <= R; k++) {
        if (skipMajor && k % g.sub === 0) continue;
        ctx.moveTo(X(g.ox) + k * step * zoom, Y(g.oy));
        ctx.arc(X(g.ox), Y(g.oy), k * step * zoom, 0, Math.PI * 2);
      }
    };
    if (minorOn && g.sub > 1) pass(minorCol, 1, () => rings(m, true));
    if (majorOn) pass(majorCol, 1, () => {
      rings(g.size, false);
      for (let a = 0; a < g.spokes; a++) {
        const th = a * 2 * Math.PI / g.spokes;
        line(g.ox, g.oy, g.ox + Math.cos(th) * R, g.oy + Math.sin(th) * R);
      }
    });
  }
  ctx.restore();
}
