/**
 * What each row paints, independent of the drawing API: background and
 * decoration rectangles and glyph runs, in device pixels relative to the
 * row's top edge. Row objects are immutable per frame, so plans are cached
 * by row identity and reused while the row stays clean.
 */

import type { FrameColors, RowCells } from '../engine/frame';
import type { CellMetrics } from './glyph-atlas';
import {
  cellPaint,
  type ScreenModel,
  type TerminalTheme,
} from './screen-model';

export interface RectOp {
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
  alpha: number;
}

export interface GlyphOp {
  /** Cell top-left, device pixels. */
  x: number;
  y: number;
  text: string;
  codepoint: number;
  span: number;
  bold: boolean;
  italic: boolean;
  color: number;
}

export interface RowPaint {
  rects: RectOp[];
  glyphs: GlyphOp[];
}

export interface Overlay {
  focused: boolean;
  /** Whether a blinking cursor is in its visible phase. */
  cursorOn: boolean;
  /** Cells to underline as a hovered link: [y, x0, x1] inclusive. */
  link: readonly [number, number, number] | null;
}

function decorationThickness(metrics: CellMetrics): number {
  return Math.max(1, Math.round(metrics.height / 18));
}

function underlineRects(
  kind: number,
  x: number,
  width: number,
  color: number,
  metrics: CellMetrics,
  out: RectOp[],
): void {
  const t = decorationThickness(metrics);
  const y = Math.min(metrics.height - t, metrics.baseline + t);
  if (kind === 2) {
    out.push({ x, y, width, height: t, color, alpha: 1 });
    out.push({
      x,
      y: Math.min(metrics.height - t, y + t * 2),
      width,
      height: t,
      color,
      alpha: 1,
    });
    return;
  }
  if (kind === 3 || kind === 4 || kind === 5) {
    // Curly, dotted and dashed underlines as evenly spaced segments.
    const dash = kind === 5 ? t * 3 : t;
    for (let dx = 0; dx < width; dx += dash * 2)
      out.push({
        x: x + dx,
        y,
        width: Math.min(dash, width - dx),
        height: t,
        color,
        alpha: 1,
      });
    return;
  }
  out.push({ x, y, width, height: t, color, alpha: 1 });
}

export function paintRow(
  row: RowCells,
  colors: FrameColors,
  theme: TerminalTheme,
  metrics: CellMetrics,
): RowPaint {
  const rects: RectOp[] = [];
  const glyphs: GlyphOp[] = [];
  const cw = metrics.width;
  const ch = metrics.height;
  const t = decorationThickness(metrics);
  let run: RectOp | null = null;
  for (let x = 0; x < row.codepoints.length; x += 1) {
    const paint = cellPaint(row, x, colors, theme);
    if (paint.bg !== null) {
      // Merge adjacent cells of one background into a single rectangle.
      if (run && run.color === paint.bg && run.x + run.width === x * cw)
        run.width += cw;
      else {
        run = {
          x: x * cw,
          y: 0,
          width: cw,
          height: ch,
          color: paint.bg,
          alpha: 1,
        };
        rects.push(run);
      }
    } else run = null;
    if (paint.span === 0) continue;
    if (paint.text && paint.text !== ' ')
      glyphs.push({
        x: x * cw,
        y: 0,
        text: paint.text,
        codepoint: paint.codepoint,
        span: paint.span,
        bold: paint.bold,
        italic: paint.italic,
        color: paint.fg,
      });
    const width = cw * paint.span;
    if (paint.underline)
      underlineRects(paint.underline, x * cw, width, paint.fg, metrics, rects);
    if (paint.strikethrough)
      rects.push({
        x: x * cw,
        y: Math.round(ch / 2),
        width,
        height: t,
        color: paint.fg,
        alpha: 1,
      });
    if (paint.overline)
      rects.push({
        x: x * cw,
        y: 0,
        width,
        height: t,
        color: paint.fg,
        alpha: 1,
      });
  }
  return { rects, glyphs };
}

const cache = new WeakMap<RowCells, { key: string; paint: RowPaint }>();

export function cachedRowPaint(
  row: RowCells,
  colors: FrameColors,
  theme: TerminalTheme,
  metrics: CellMetrics,
  cacheKey: string,
): RowPaint {
  const hit = cache.get(row);
  if (hit && hit.key === cacheKey) return hit.paint;
  const paint = paintRow(row, colors, theme, metrics);
  cache.set(row, { key: cacheKey, paint });
  return paint;
}

/** Cursor and hovered-link marks drawn over the rows. */
export function overlayPaint(
  model: ScreenModel,
  theme: TerminalTheme,
  metrics: CellMetrics,
  overlay: Overlay,
): RowPaint {
  const rects: RectOp[] = [];
  const glyphs: GlyphOp[] = [];
  const cw = metrics.width;
  const ch = metrics.height;
  const t = decorationThickness(metrics);
  const colors = model.colors;
  if (overlay.link && colors) {
    const [y, x0, x1] = overlay.link;
    rects.push({
      x: x0 * cw,
      y: y * ch + Math.min(ch - t, metrics.baseline + t),
      width: (x1 - x0 + 1) * cw,
      height: t,
      color: colors.foreground,
      alpha: 1,
    });
  }
  const cursor = model.cursor;
  if (!cursor?.visible || !colors) return { rects, glyphs };
  if (cursor.blinking && overlay.focused && !overlay.cursorOn)
    return { rects, glyphs };
  const color = colors.cursor ?? theme.cursor;
  const cx = (cursor.wideTail ? cursor.x - 1 : cursor.x) * cw;
  const cy = cursor.y * ch;
  const row = model.rows[cursor.y];
  const span =
    row && cursor.x < row.codepoints.length
      ? Math.max(
          1,
          cellPaint(
            row,
            cursor.wideTail ? cursor.x - 1 : cursor.x,
            colors,
            theme,
          ).span,
        )
      : 1;
  const width = cw * span;
  // An unfocused terminal shows a hollow block, so focus is visible at a glance.
  const shape = overlay.focused ? cursor.shape : 'block-hollow';
  const bar = Math.max(t, Math.round(metrics.dpr * 2));
  if (shape === 'bar')
    rects.push({ x: cx, y: cy, width: bar, height: ch, color, alpha: 1 });
  else if (shape === 'underline')
    rects.push({
      x: cx,
      y: cy + ch - bar,
      width,
      height: bar,
      color,
      alpha: 1,
    });
  else if (shape === 'block-hollow') {
    rects.push({ x: cx, y: cy, width, height: t, color, alpha: 1 });
    rects.push({ x: cx, y: cy + ch - t, width, height: t, color, alpha: 1 });
    rects.push({ x: cx, y: cy, width: t, height: ch, color, alpha: 1 });
    rects.push({
      x: cx + width - t,
      y: cy,
      width: t,
      height: ch,
      color,
      alpha: 1,
    });
  } else {
    rects.push({ x: cx, y: cy, width, height: ch, color, alpha: 1 });
    if (row) {
      const paint = cellPaint(
        row,
        cursor.wideTail ? cursor.x - 1 : cursor.x,
        colors,
        theme,
      );
      if (paint.text && paint.text !== ' ')
        glyphs.push({
          x: cx,
          y: cy,
          text: paint.text,
          codepoint: paint.codepoint,
          span: Math.max(1, paint.span),
          bold: paint.bold,
          italic: paint.italic,
          color: theme.cursorText,
        });
    }
  }
  return { rects, glyphs };
}
