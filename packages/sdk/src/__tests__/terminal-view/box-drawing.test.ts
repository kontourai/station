import { describe, expect, it } from 'vitest';
import {
  drawGlyph,
  isDrawnGlyph,
} from '../../terminal-view/render/box-drawing';

/** Rasterizes fillRect calls into a coverage grid. */
function raster(cp: number, width = 9, height = 18) {
  const grid = Array.from({ length: height }, () =>
    new Array<number>(width).fill(0),
  );
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1)
        for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1)
          grid[yy]![xx] = 1;
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    ellipse() {},
    closePath() {},
    fill() {},
    stroke() {},
  };
  expect(drawGlyph(ctx as never, cp, { width, height })).toBe(true);
  return grid;
}

const column = (grid: number[][], x: number) => grid.map((row) => row[x]!);

describe('renderer-drawn box glyphs', () => {
  it('runs horizontal lines edge to edge so neighbours join without a seam', () => {
    for (const cp of [0x2500, 0x2501, 0x253c, 0x252c]) {
      const grid = raster(cp);
      const row = grid.findIndex((r) => r[0] === 1);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(grid[row]![8]).toBe(1);
      expect(grid[row]!.every((v) => v === 1)).toBe(true);
    }
  });

  it('runs vertical lines top to bottom', () => {
    for (const cp of [0x2502, 0x2503, 0x253c, 0x251c]) {
      const grid = raster(cp);
      const x = grid[0]!.indexOf(1);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(column(grid, x).every((v) => v === 1)).toBe(true);
    }
  });

  it('draws double lines as two parallel strokes', () => {
    const grid = raster(0x2550);
    const rows = grid.map((r) => r.every((v) => v === 1));
    expect(rows.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    const first = rows.indexOf(true);
    expect(rows[first + 1]).toBe(false);
  });

  it('fills the full block and the lower half exactly', () => {
    expect(
      raster(0x2588)
        .flat()
        .every((v) => v === 1),
    ).toBe(true);
    const half = raster(0x2584);
    expect(
      half
        .slice(0, 9)
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
    expect(
      half
        .slice(9)
        .flat()
        .every((v) => v === 1),
    ).toBe(true);
  });

  it('covers the drawn ranges and leaves text to the font', () => {
    expect(isDrawnGlyph(0x2500)).toBe(true);
    expect(isDrawnGlyph(0xe0b0)).toBe(true);
    expect(isDrawnGlyph(0x41)).toBe(false);
  });
});
