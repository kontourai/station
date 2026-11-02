/**
 * The render data that crosses from the engine worker to the UI thread.
 * Only rows the render state reports dirty carry cells; every other row is
 * named by its stable id so the UI can reuse what it already has.
 */

/** Packed `0xRRGGBB`; {@link DEFAULT_COLOR} means "the theme's default". */
export const DEFAULT_COLOR = 0x1000000;

export const Attr = {
  BOLD: 1 << 0,
  ITALIC: 1 << 1,
  FAINT: 1 << 2,
  BLINK: 1 << 3,
  INVERSE: 1 << 4,
  INVISIBLE: 1 << 5,
  STRIKETHROUGH: 1 << 6,
  OVERLINE: 1 << 7,
  /** Three bits: a `GHOSTTY_SGR_UNDERLINE_*` value. */
  UNDERLINE_SHIFT: 8,
  UNDERLINE_MASK: 0b111 << 8,
  /** Two bits: a `GhosttyCellWide` value. */
  WIDE_SHIFT: 11,
  WIDE_MASK: 0b11 << 11,
  HYPERLINK: 1 << 13,
} as const;

export interface RowCells {
  /** Stable row identity across frames (the render state's row id). */
  readonly id: string;
  /** Viewport row index. */
  readonly y: number;
  /** One base code point per column; 0 is an empty cell. */
  readonly codepoints: Uint32Array;
  /** Whole grapheme clusters for columns with more than one code point. */
  readonly clusters: Readonly<Record<number, string>>;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  readonly attrs: Uint16Array;
  /** Inclusive selected column range on this row, if any. */
  readonly selection: readonly [number, number] | null;
  /** True when this row soft-wraps into the next one. */
  readonly wrapped: boolean;
}

export type CursorShape = 'bar' | 'block' | 'underline' | 'block-hollow';

export interface CursorFrame {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly blinking: boolean;
  readonly shape: CursorShape;
  readonly wideTail: boolean;
}

export interface FrameColors {
  readonly background: number;
  readonly foreground: number;
  /** `null` when the program has not chosen a cursor colour. */
  readonly cursor: number | null;
  /** 256 packed colours. */
  readonly palette: Uint32Array;
}

export interface Scrollbar {
  readonly total: number;
  readonly offset: number;
  readonly length: number;
}

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  /** True when every row is present in {@link dirty}. */
  readonly full: boolean;
  /** Row ids in viewport order, top to bottom. */
  readonly rowIds: readonly string[];
  readonly dirty: readonly RowCells[];
  readonly cursor: CursorFrame | null;
  readonly colors: FrameColors;
  readonly scrollbar: Scrollbar;
  /** True when the viewport shows the live (bottom) area. */
  readonly atBottom: boolean;
}

/** Transferable buffers of a frame, for `postMessage`. */
export function frameTransferables(frame: Frame): ArrayBuffer[] {
  const out: ArrayBuffer[] = [frame.colors.palette.buffer as ArrayBuffer];
  for (const row of frame.dirty) {
    out.push(
      row.codepoints.buffer as ArrayBuffer,
      row.fg.buffer as ArrayBuffer,
      row.bg.buffer as ArrayBuffer,
      row.attrs.buffer as ArrayBuffer,
    );
  }
  return out;
}

/** The visible text of a row: wide-character tails and trailing blanks dropped. */
export function rowText(row: RowCells): string {
  let text = '';
  for (let x = 0; x < row.codepoints.length; x += 1) {
    const wide = (row.attrs[x]! & Attr.WIDE_MASK) >> Attr.WIDE_SHIFT;
    if (wide === 2 || wide === 3) continue;
    const cluster = row.clusters[x];
    const cp = row.codepoints[x]!;
    text += cluster ?? (cp === 0 ? ' ' : String.fromCodePoint(cp));
  }
  return text.replace(/\s+$/u, '');
}
