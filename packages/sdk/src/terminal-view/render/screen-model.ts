/**
 * The UI thread's copy of the visible screen, rebuilt from engine frames.
 * Clean rows arrive as ids only and are taken from the previous screen, so
 * a frame costs what changed, not the whole grid.
 */

import {
  Attr,
  type CursorFrame,
  DEFAULT_COLOR,
  type Frame,
  type FrameColors,
  type RowCells,
  type Scrollbar,
} from '../engine/frame';

export interface TerminalTheme {
  foreground: number;
  background: number;
  cursor: number;
  /** Text drawn under a block cursor. */
  cursorText: number;
  selectionBackground: number;
  /** `null` keeps each cell's own foreground inside the selection. */
  selectionForeground: number | null;
  ansi: readonly number[];
  scheme: 'light' | 'dark';
}

export class ScreenModel {
  cols = 0;
  rows: RowCells[] = [];
  cursor: CursorFrame | null = null;
  colors: FrameColors | null = null;
  scrollbar: Scrollbar = { total: 0, offset: 0, length: 0 };
  atBottom = true;
  /** Rows (by viewport index) replaced by the last applied frame. */
  changed = new Set<number>();
  /** Bumped on every applied frame. */
  version = 0;

  /**
   * Applies a frame. Returns false when the frame named a clean row this
   * model does not hold (it missed a frame); the caller must ask the engine
   * for a full frame.
   */
  apply(frame: Frame): boolean {
    const previous = new Map(this.rows.map((row) => [row.id, row]));
    const dirty = new Map(frame.dirty.map((row) => [row.id, row]));
    const next: RowCells[] = [];
    this.changed = new Set();
    let complete = true;
    frame.rowIds.forEach((id, y) => {
      const fresh = dirty.get(id);
      const kept = previous.get(id);
      const row = fresh ?? kept;
      if (!row) {
        complete = false;
        return;
      }
      // A clean row may have moved: keep its cells, update its position.
      const placed = row.y === y ? row : { ...row, y };
      if (fresh || !kept || kept.y !== y || frame.cols !== this.cols)
        this.changed.add(y);
      next.push(placed);
    });
    this.cols = frame.cols;
    this.rows = next;
    if (
      this.cursor?.y !== frame.cursor?.y &&
      this.cursor &&
      this.cursor.y < next.length
    )
      this.changed.add(this.cursor.y);
    if (frame.cursor) this.changed.add(frame.cursor.y);
    this.cursor = frame.cursor;
    this.colors = frame.colors;
    this.scrollbar = frame.scrollbar;
    this.atBottom = frame.atBottom;
    this.version += 1;
    return complete;
  }

  /** Visible text, row by row, as a sighted user sees it. */
  lines(): string[] {
    return this.rows.map((row) => {
      let text = '';
      for (let x = 0; x < row.codepoints.length; x += 1) {
        const wide = (row.attrs[x]! & Attr.WIDE_MASK) >> Attr.WIDE_SHIFT;
        if (wide === 2 || wide === 3) continue;
        const cp = row.codepoints[x]!;
        text += row.clusters[x] ?? (cp === 0 ? ' ' : String.fromCodePoint(cp));
      }
      return text.replace(/\s+$/u, '');
    });
  }
}

export interface CellPaint {
  fg: number;
  /** `null` draws nothing: the terminal background shows through. */
  bg: number | null;
  text: string;
  codepoint: number;
  bold: boolean;
  italic: boolean;
  /** Number of columns the glyph covers (1 or 2); 0 for a wide tail. */
  span: number;
  underline: number;
  strikethrough: boolean;
  overline: boolean;
  hyperlink: boolean;
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, shift: number) => (c >> shift) & 0xff;
  const lerp = (shift: number) =>
    Math.round(ch(a, shift) * (1 - t) + ch(b, shift) * t) << shift;
  return lerp(16) | lerp(8) | lerp(0);
}

/** Resolves what one cell paints: colours after inverse, faint and selection. */
export function cellPaint(
  row: RowCells,
  x: number,
  colors: FrameColors,
  theme: TerminalTheme,
): CellPaint {
  const attr = row.attrs[x]!;
  const wide = (attr & Attr.WIDE_MASK) >> Attr.WIDE_SHIFT;
  let fg = row.fg[x] === DEFAULT_COLOR ? colors.foreground : row.fg[x]!;
  let bg: number | null = row.bg[x] === DEFAULT_COLOR ? null : row.bg[x]!;
  if (attr & Attr.INVERSE) {
    const back = bg ?? colors.background;
    bg = fg;
    fg = back;
  }
  if (attr & Attr.FAINT) fg = mix(fg, bg ?? colors.background, 0.5);
  const selected =
    row.selection !== null && x >= row.selection[0] && x <= row.selection[1];
  if (selected) {
    bg = theme.selectionBackground;
    if (theme.selectionForeground !== null) fg = theme.selectionForeground;
  }
  const cp = row.codepoints[x]!;
  const invisible = (attr & Attr.INVISIBLE) !== 0;
  return {
    fg,
    bg,
    codepoint: invisible ? 0 : cp,
    text:
      invisible || cp === 0
        ? ''
        : (row.clusters[x] ?? String.fromCodePoint(cp)),
    bold: (attr & Attr.BOLD) !== 0,
    italic: (attr & Attr.ITALIC) !== 0,
    span: wide === 1 ? 2 : wide === 2 || wide === 3 ? 0 : 1,
    underline: (attr & Attr.UNDERLINE_MASK) >> Attr.UNDERLINE_SHIFT,
    strikethrough: (attr & Attr.STRIKETHROUGH) !== 0,
    overline: (attr & Attr.OVERLINE) !== 0,
    hyperlink: (attr & Attr.HYPERLINK) !== 0,
  };
}
