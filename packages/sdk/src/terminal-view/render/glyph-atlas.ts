/**
 * Cell metrics and a glyph atlas. Each glyph is rasterized once into a
 * cell-sized tile (two cells for wide characters) as white coverage, and the
 * renderer tints it. Box drawing, blocks and Powerline separators are drawn
 * procedurally into their tiles so they meet their neighbours without seams.
 */

import { drawGlyph, isDrawnGlyph } from './box-drawing';

export interface FontSpec {
  family: string;
  /** CSS pixels. */
  size: number;
  lineHeight: number;
}

export interface CellMetrics {
  /** Device pixels per CSS pixel. */
  dpr: number;
  /** Cell size in device pixels (integers). */
  width: number;
  height: number;
  /** Baseline offset from the cell top, device pixels. */
  baseline: number;
  /** Cell size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  font: FontSpec;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function fontString(
  font: FontSpec,
  dpr: number,
  bold = false,
  italic = false,
): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${font.size * dpr}px ${font.family}`;
}

export function measureCell(font: FontSpec, dpr: number): CellMetrics {
  const ctx = makeCanvas(8, 8).getContext('2d') as Canvas2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.font = fontString(font, dpr);
  const m = ctx.measureText('W');
  const ascent = m.fontBoundingBoxAscent || font.size * dpr * 0.8;
  const descent = m.fontBoundingBoxDescent || font.size * dpr * 0.2;
  const width = Math.max(1, Math.round(m.width));
  const height = Math.max(1, Math.ceil((ascent + descent) * font.lineHeight));
  const baseline = Math.round((height - (ascent + descent)) / 2 + ascent);
  return {
    dpr,
    width,
    height,
    baseline,
    cssWidth: width / dpr,
    cssHeight: height / dpr,
    font,
  };
}

export interface AtlasGlyph {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Colour emoji keep their own colours instead of being tinted. */
  colored: boolean;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}|️/u;

export class GlyphAtlas {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private readonly ctx: Canvas2D;
  private readonly glyphs = new Map<string, AtlasGlyph>();
  private cursorX = 0;
  private cursorY = 0;
  /** Bumped when the atlas is cleared; renderers rebuild cached geometry. */
  generation = 0;
  /** Union of tiles written since the last {@link takeDirty}. */
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null =
    null;

  constructor(
    private metrics: CellMetrics,
    readonly size = 2048,
  ) {
    this.canvas = makeCanvas(size, size);
    const ctx = this.canvas.getContext('2d', {
      willReadFrequently: true,
    }) as Canvas2D | null;
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  setMetrics(metrics: CellMetrics): void {
    this.metrics = metrics;
    this.reset();
  }

  reset(): void {
    this.glyphs.clear();
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.cursorX = 0;
    this.cursorY = 0;
    this.generation += 1;
    this.dirty = { x0: 0, y0: 0, x1: this.size, y1: this.size };
  }

  takeDirty(): { x: number; y: number; width: number; height: number } | null {
    const d = this.dirty;
    this.dirty = null;
    return d
      ? { x: d.x0, y: d.y0, width: d.x1 - d.x0, height: d.y1 - d.y0 }
      : null;
  }

  /**
   * The tile for a glyph, rasterizing it on first use. Returns null when the
   * atlas is full; the caller resets it and redraws the frame.
   */
  glyph(
    text: string,
    codepoint: number,
    span: number,
    bold: boolean,
    italic: boolean,
  ): AtlasGlyph | null {
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}${span}|${text}`;
    const found = this.glyphs.get(key);
    if (found) return found;
    const width = this.metrics.width * Math.max(1, span);
    const height = this.metrics.height;
    if (this.cursorX + width > this.size) {
      this.cursorX = 0;
      this.cursorY += height;
    }
    if (this.cursorY + height > this.size) return null;
    const x = this.cursorX;
    const y = this.cursorY;
    this.cursorX += width;

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.translate(x, y);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    const drawn =
      isDrawnGlyph(codepoint) &&
      text.length <= 2 &&
      drawGlyph(ctx, codepoint, { width, height });
    if (!drawn) {
      ctx.font = fontString(this.metrics.font, this.metrics.dpr, bold, italic);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, 0, this.metrics.baseline);
    }
    ctx.restore();

    const glyph: AtlasGlyph = {
      x,
      y,
      width,
      height,
      colored: !drawn && PICTOGRAPHIC.test(text),
    };
    this.glyphs.set(key, glyph);
    const d = this.dirty;
    this.dirty = d
      ? {
          x0: Math.min(d.x0, x),
          y0: Math.min(d.y0, y),
          x1: Math.max(d.x1, x + width),
          y1: Math.max(d.y1, y + height),
        }
      : { x0: x, y0: y, x1: x + width, y1: y + height };
    return glyph;
  }

  imageData(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): ImageData {
    return this.ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  }
}
