// Recurror — 2D overlay: guides, selection, handles, tool feedback.
import { drawGrid } from './grid.js';
import { getSamples, isClosed } from './geometry.js';
import { warpPoint, warpActive } from './warp.js';

const KIND_STYLE = {
  mirror: ['rgba(251,191,36,0.42)', []],
  ray: ['rgba(125,211,252,0.32)', [6, 6]],
  cell: ['rgba(125,211,252,0.22)', []],
  circle: ['rgba(251,191,36,0.5)', []],
  geo: ['rgba(167,139,250,0.30)', []],
};

/** Map a stroke-local point through the stroke's warp (identity copy). */
export function viewPoint(stroke, x, y) {
  return warpActive(stroke.warp) ? warpPoint(stroke.warp, +stroke.sym.cx, +stroke.sym.cy, x, y) : { x, y };
}

/**
 * @param s {view, doc, guides, showGuides, selection[], primary, hover, handleHot, penPoints, penCloseHot,
 *           cursor, tool, brushWidth, marquee, snap, widthHot}
 */
export function drawOverlay(ctx, s) {
  const { zoom, panX, panY, dpr } = s.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const X = (x) => x * zoom + panX, Y = (y) => y * zoom + panY;
  const W = s.doc.width, H = s.doc.height;

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(Math.round(X(0)) + 0.5, Math.round(Y(0)) + 0.5, Math.round(W * zoom), Math.round(H * zoom));

  if (s.grid) drawGrid(ctx, s.grid, s.view, W, H);
  if (s.showGuides && s.guides) drawGuides(ctx, s.guides, X, Y, s.tool === 'center');

  if (s.hover && !s.selection.includes(s.hover)) outline(ctx, s.hover, X, Y, 'rgba(125,211,252,0.55)', []);
  for (const st of s.selection) outline(ctx, st, X, Y, st === s.primary ? 'rgba(125,211,252,0.95)' : 'rgba(125,211,252,0.6)', [4, 4]);

  if (s.xbox) drawXformBox(ctx, s.xbox, X, Y);

  const pr = s.primary;
  if (pr && (s.tool === 'edit' || s.tool === 'width')) {
    const pts = pr.points.map((p) => viewPoint(pr, p.x, p.y));
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    if (isClosed(pr)) ctx.closePath();
    ctx.stroke();
    if (s.tool === 'width') {
      pr.points.forEach((p, i) => {
        const r = Math.max(2, pr.style.width * 0.5 * (p.w ?? 1) * zoom);
        ctx.strokeStyle = s.widthHot === i ? '#f472b6' : 'rgba(244,114,182,0.55)';
        ctx.lineWidth = s.widthHot === i ? 2 : 1.25;
        ctx.beginPath(); ctx.arc(X(pts[i].x), Y(pts[i].y), r, 0, Math.PI * 2); ctx.stroke();
      });
    }
    pts.forEach((p, i) => {
      const hot = s.handleHot === i || s.widthHot === i;
      const r = hot ? 5.5 : 4;
      ctx.fillStyle = hot ? '#7dd3fc' : '#0e0f13';
      ctx.strokeStyle = i === 0 ? '#fbbf24' : '#7dd3fc';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(X(p.x) - r, Y(p.y) - r, r * 2, r * 2); ctx.fill(); ctx.stroke();
    });
  }

  if ((s.tool === 'pen' || s.tool === 'draw') && s.penPoints && s.penPoints.length) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    s.penPoints.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    if (s.cursor) ctx.lineTo(X(s.cursor.x), Y(s.cursor.y));
    ctx.stroke();
    ctx.setLineDash([]);
    s.penPoints.forEach((p, i) => {
      const hot = i === 0 && s.penCloseHot;
      ctx.fillStyle = hot ? '#fbbf24' : '#0e0f13';
      ctx.strokeStyle = i === 0 ? '#fbbf24' : '#e5e7eb';
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), hot ? 6 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }

  if (s.marquee) {
    const m = s.marquee;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(125,211,252,0.9)';
    ctx.fillStyle = 'rgba(125,211,252,0.08)';
    const x0 = X(Math.min(m.x0, m.x1)), y0 = Y(Math.min(m.y0, m.y1));
    ctx.fillRect(x0, y0, Math.abs(m.x1 - m.x0) * zoom, Math.abs(m.y1 - m.y0) * zoom);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(m.x1 - m.x0) * zoom, Math.abs(m.y1 - m.y0) * zoom);
    ctx.setLineDash([]);
  }

  if (s.snap) {
    ctx.strokeStyle = s.snap.kind === 'join' ? '#fbbf24' : '#34d399';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (s.snap.onLine) { ctx.moveTo(X(s.snap.x) - 6, Y(s.snap.y) - 6); ctx.lineTo(X(s.snap.x) + 6, Y(s.snap.y) + 6); ctx.moveTo(X(s.snap.x) + 6, Y(s.snap.y) - 6); ctx.lineTo(X(s.snap.x) - 6, Y(s.snap.y) + 6); }
    else ctx.arc(X(s.snap.x), Y(s.snap.y), 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (s.cursor && (s.tool === 'draw' || s.tool === 'pen') && s.brushWidth) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(X(s.cursor.x), Y(s.cursor.y), Math.max(1.5, s.brushWidth * 0.5 * zoom), 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Selection transform box: corner squares scale, the round knob above it rotates. */
export function xformHandles(b, X, Y, coarse = false) {
  const x0 = X(b.x0), x1 = X(b.x1), y0 = Y(b.y0), y1 = Y(b.y1);
  const pad = 6;
  const L = Math.min(x0, x1) - pad, R = Math.max(x0, x1) + pad, T = Math.min(y0, y1) - pad, B = Math.max(y0, y1) + pad;
  const out = { box: [L, T, R, B], corners: [[L, T], [R, T], [R, B], [L, B]], size: coarse ? 14 : 9 };
  if (b.rot) out.rot = [(L + R) / 2, T - (coarse ? 34 : 26)];
  return out;
}

function drawXformBox(ctx, b, X, Y) {
  const h = xformHandles(b, X, Y, b.coarse);
  const [L, T, R, B] = h.box;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(253,186,116,0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(L) + 0.5, Math.round(T) + 0.5, Math.round(R - L), Math.round(B - T));
  ctx.setLineDash([]);
  if (h.rot) {
    ctx.beginPath(); ctx.moveTo((L + R) / 2, T); ctx.lineTo(h.rot[0], h.rot[1]); ctx.stroke();
    ctx.beginPath(); ctx.arc(h.rot[0], h.rot[1], h.size / 2 + 1, 0, Math.PI * 2);
    ctx.fillStyle = b.hot === 'rot' ? '#fdba74' : '#1c1917'; ctx.fill();
    ctx.strokeStyle = '#fdba74'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  h.corners.forEach(([x, y], i) => {
    const r = h.size / 2;
    ctx.fillStyle = b.hot === i ? '#fdba74' : '#1c1917';
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.strokeStyle = '#fdba74'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
  });
  if (b.label) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(253,186,116,0.95)';
    ctx.fillText(b.label, L, B + 15);
  }
  ctx.restore();
}

function outline(ctx, stroke, X, Y, color, dash) {
  const sm = getSamples(stroke);
  if (sm.length < 2) return;
  const warped = warpActive(stroke.warp);
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  const step = warped && sm.length > 400 ? 2 : 1;
  for (let i = 0; i < sm.length; i += step) {
    const p = warped ? viewPoint(stroke, sm[i].x, sm[i].y) : sm[i];
    i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y));
  }
  if (isClosed(stroke)) ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawGuides(ctx, g, X, Y, emphasise) {
  ctx.save();
  ctx.lineWidth = 1;
  for (const l of g.lines) {
    const st = KIND_STYLE[l.kind] || KIND_STYLE.ray;
    ctx.strokeStyle = st[0];
    ctx.setLineDash(st[1]);
    ctx.beginPath();
    l.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const p of g.points) {
    const x = X(p.x), y = Y(p.y);
    if (p.kind === 'centre') {
      ctx.strokeStyle = emphasise ? '#fbbf24' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = emphasise ? 2 : 1.25;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12);
      ctx.stroke();
    } else if (p.kind === 'anchor') {
      ctx.strokeStyle = 'rgba(244,114,182,0.85)';
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(125,211,252,0.45)';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
  ctx.restore();
}
