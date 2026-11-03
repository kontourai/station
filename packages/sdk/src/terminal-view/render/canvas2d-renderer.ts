/**
 * Canvas 2D fallback for browsers without WebGL2, or after WebGL fails.
 * It draws the same paint plan: rows that changed since the last frame are
 * repainted, and the cursor row is repainted for the cursor overlay.
 */

import { drawGlyph, isDrawnGlyph } from './box-drawing';
import { type CellMetrics, fontString } from './glyph-atlas';
import type { TerminalRenderer } from './renderer';
import {
  cachedRowPaint,
  type GlyphOp,
  type Overlay,
  overlayPaint,
  type RectOp,
} from './row-paint';
import type { ScreenModel, TerminalTheme } from './screen-model';

const css = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

export class Canvas2dRenderer implements TerminalRenderer {
  readonly kind = 'canvas2d' as const;
  private readonly ctx: CanvasRenderingContext2D;
  private metrics: CellMetrics | null = null;
  private theme: TerminalTheme | null = null;
  private themeVersion = 0;
  /** Viewport rows painted with a stale overlay (cursor, link) last frame. */
  private overlayRows = new Set<number>();
  private painted = new Map<number, unknown>();
  private suspended = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  resize(cols: number, rows: number, metrics: CellMetrics): void {
    this.metrics = metrics;
    this.canvas.width = Math.max(1, cols * metrics.width);
    this.canvas.height = Math.max(1, rows * metrics.height);
    this.canvas.style.width = `${(cols * metrics.width) / metrics.dpr}px`;
    this.canvas.style.height = `${(rows * metrics.height) / metrics.dpr}px`;
    this.painted.clear();
  }

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.themeVersion += 1;
    this.painted.clear();
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    this.painted.clear();
  }

  private rect(r: RectOp, top: number): void {
    this.ctx.globalAlpha = r.alpha;
    this.ctx.fillStyle = css(r.color);
    this.ctx.fillRect(r.x, r.y + top, r.width, r.height);
    this.ctx.globalAlpha = 1;
  }

  private glyph(g: GlyphOp, top: number, metrics: CellMetrics): void {
    const ctx = this.ctx;
    const width = metrics.width * g.span;
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.x, g.y + top, width, metrics.height);
    ctx.clip();
    ctx.fillStyle = css(g.color);
    ctx.strokeStyle = css(g.color);
    ctx.translate(g.x, g.y + top);
    if (
      !(
        isDrawnGlyph(g.codepoint) &&
        drawGlyph(ctx, g.codepoint, { width, height: metrics.height })
      )
    ) {
      ctx.font = fontString(metrics.font, metrics.dpr, g.bold, g.italic);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(g.text, 0, metrics.baseline);
    }
    ctx.restore();
  }

  render(model: ScreenModel, overlay: Overlay): void {
    const metrics = this.metrics;
    const theme = this.theme;
    const colors = model.colors;
    if (!metrics || !theme || !colors || this.suspended) return;
    const key = `${this.themeVersion}:${metrics.width}x${metrics.height}`;
    const over = overlayPaint(model, theme, metrics, overlay);
    const overRows = new Set<number>();
    for (const r of over.rects) overRows.add(Math.floor(r.y / metrics.height));
    const repaint = new Set([...this.overlayRows, ...overRows]);

    model.rows.forEach((row, y) => {
      const identity = `${key}:${colors.background}`;
      if (
        this.painted.get(y) === row &&
        !repaint.has(y) &&
        this.painted.get(-1 - y) === identity
      )
        return;
      const top = y * metrics.height;
      this.ctx.fillStyle = css(colors.background);
      this.ctx.fillRect(0, top, this.canvas.width, metrics.height);
      const paint = cachedRowPaint(row, colors, theme, metrics, key);
      for (const r of paint.rects) this.rect(r, top);
      for (const g of paint.glyphs) this.glyph(g, top, metrics);
      this.painted.set(y, row);
      this.painted.set(-1 - y, identity);
    });
    for (const r of over.rects) this.rect(r, 0);
    for (const g of over.glyphs) this.glyph(g, 0, metrics);
    this.overlayRows = overRows;
  }

  dispose(): void {
    this.painted.clear();
  }
}
