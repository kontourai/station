/**
 * One terminal over libghostty-vt: the VT parser and screen state, the
 * render state that reports dirty rows, and the key, mouse, focus and paste
 * encoders. It runs inside the engine worker in the browser and directly in
 * headless tests. It never touches the DOM.
 *
 * Every pointer below is a number into the module's linear memory. Views
 * are re-read from {@link GhosttyVtModule.data} after each exported call,
 * because any call that allocates may grow (and so detach) the memory.
 */

import {
  CellData,
  CellsData,
  CellWide,
  CursorStyle,
  DecMode,
  FocusEvent,
  FormatterFormat,
  GestureEventOpt,
  GestureEventType,
  KeyAction,
  LAYOUT,
  Mods,
  MouseAction,
  MouseEncoderOpt,
  PointTag,
  RenderData,
  RenderDirty,
  Result,
  RowData,
  ScrollViewport,
  SearchData,
  SearchOpt,
  TerminalData,
  TerminalOpt,
} from './abi';
import {
  Attr,
  type CursorFrame,
  type CursorShape,
  DEFAULT_COLOR,
  type Frame,
  type RowCells,
} from './frame';
import { GHOSTTY_KEY_BY_CODE } from './keys.generated';
import { GhosttyVtError, type GhosttyVtModule } from './wasm';

export interface EngineSize {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export interface EngineTheme {
  foreground: number;
  background: number;
  cursor: number | null;
  /** 16 ANSI colours; the rest of the 256-colour palette stays default. */
  ansi: readonly number[];
  scheme: 'light' | 'dark';
}

export interface EngineEffects {
  /** Device replies (DA, DSR, mode reports) for the PTY. Live output only. */
  reply(bytes: Uint8Array): void;
  bell(): void;
  /** Untrusted program text (OSC 0/1/2). Display it as text, nothing more. */
  title(title: string): void;
}

export type KeyActionName = 'press' | 'release' | 'repeat';

export interface KeyInput {
  /** `KeyboardEvent.code`. */
  code: string;
  action: KeyActionName;
  /** {@link Mods} bits. */
  mods: number;
  /** Text the key produces without Ctrl/Alt applied (`KeyboardEvent.key`). */
  text: string;
  /** The key's code point without Shift, or 0. */
  unshifted: number;
  composing?: boolean;
}

export interface MouseInput {
  action: 'press' | 'release' | 'motion';
  /** 0 none, 1 left, 2 right, 3 middle, 4/5 wheel up/down. */
  button: number;
  /** Surface pixels from the grid's top-left corner. */
  x: number;
  y: number;
  mods: number;
}

export interface SearchState {
  total: number;
  selected: number;
}

const SCRATCH_BYTES = 4096;
const OUT_BYTES = 64 * 1024;
/**
 * Grapheme clusters are read into the output buffer past the style struct.
 * A cluster longer than this (pathological combining runs) renders blank
 * rather than overrunning the buffer.
 */
const CLUSTER_OFFSET = 1024;
const MAX_CLUSTER_CODEPOINTS = (OUT_BYTES - CLUSTER_OFFSET) / 4;

const SHAPE: Record<number, CursorShape> = {
  [CursorStyle.BAR]: 'bar',
  [CursorStyle.BLOCK]: 'block',
  [CursorStyle.UNDERLINE]: 'underline',
  [CursorStyle.BLOCK_HOLLOW]: 'block-hollow',
};

const KEY_ACTION: Record<KeyActionName, number> = {
  press: KeyAction.PRESS,
  release: KeyAction.RELEASE,
  repeat: KeyAction.REPEAT,
};

const MOUSE_ACTION = {
  press: MouseAction.PRESS,
  release: MouseAction.RELEASE,
  motion: MouseAction.MOTION,
} as const;

const L = LAYOUT;

function packRgb(view: DataView, ptr: number): number {
  return (
    (view.getUint8(ptr) << 16) |
    (view.getUint8(ptr + 1) << 8) |
    view.getUint8(ptr + 2)
  );
}

function hex64(view: DataView, ptr: number): string {
  return (
    view.getBigUint64(ptr, true).toString(16) +
    ':' +
    view.getBigUint64(ptr + 8, true).toString(16)
  );
}

export class TerminalEngine {
  private readonly term: number;
  private readonly renderState: number;
  private readonly rowIterator: number;
  private readonly rowCells: number;
  private readonly keyEncoder: number;
  private readonly keyEvent: number;
  private readonly mouseEncoder: number;
  private readonly mouseEvent: number;
  private readonly gesture: number;
  /** Fixed scratch region for out-parameters and small structs. */
  private readonly scratch: number;
  /** Encoder output and text transfer buffer. */
  private readonly out: number;
  private readonly callbacks: number[] = [];
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private search = 0;
  private replaying = false;
  private size: EngineSize;
  private scheme: 'light' | 'dark' = 'dark';
  private disposed = false;
  private forceFull = true;

  constructor(
    private readonly vt: GhosttyVtModule,
    size: EngineSize,
    private readonly effects: EngineEffects,
    options: { scrollbackBytes?: number } = {},
  ) {
    this.size = { ...size };
    this.scratch = vt.calloc(SCRATCH_BYTES);
    this.out = vt.calloc(OUT_BYTES);
    // (allocator, *out, cols, rows): the slot sits between the arguments.
    this.term = vt.constructWith(
      'ghostty_terminal_new',
      [0],
      [size.cols, size.rows],
    );
    this.renderState = vt.construct('ghostty_render_state_new', 0);
    this.rowIterator = vt.construct('ghostty_render_state_row_iterator_new', 0);
    this.rowCells = vt.construct('ghostty_render_state_row_cells_new', 0);
    this.keyEncoder = vt.construct('ghostty_key_encoder_new', 0);
    this.keyEvent = vt.construct('ghostty_key_event_new', 0);
    this.mouseEncoder = vt.construct('ghostty_mouse_encoder_new', 0);
    this.mouseEvent = vt.construct('ghostty_mouse_event_new', 0);
    this.gesture = vt.construct('ghostty_selection_gesture_new', 0);

    if (options.scrollbackBytes !== undefined) {
      this.vt.data().setUint32(this.scratch, options.scrollbackBytes, true);
      this.setOpt(TerminalOpt.SCROLLBACK_MAX_BYTES, this.scratch);
    }
    this.installEffects();
    this.resize(size);
  }

  // ─── construction helpers ────────────────────────────────────────────────

  private setOpt(option: number, value: number): void {
    this.vt.check('ghostty_terminal_set', this.term, option, value);
  }

  private installEffects(): void {
    const fn = (
      callback: (...args: number[]) => unknown,
      params: number,
      result: boolean,
    ) => {
      const index = this.vt.addFunction(callback, {
        params: Array.from({ length: params }, () => 'i32' as const),
        results: result ? ['i32'] : [],
      });
      this.callbacks.push(index);
      return index;
    };

    // (terminal, userdata, data, len)
    this.setOpt(
      TerminalOpt.WRITE_PTY,
      fn(
        (_t, _u, data, len) => {
          // Replies to journal replay belong to a terminal that no longer
          // exists; writing them now would type junk at the live prompt.
          if (this.replaying || !len) return;
          this.effects.reply(this.vt.readBytes(data!, len!));
        },
        4,
        false,
      ),
    );
    this.setOpt(
      TerminalOpt.BELL,
      fn(
        () => {
          if (!this.replaying) this.effects.bell();
        },
        2,
        false,
      ),
    );
    this.setOpt(
      TerminalOpt.TITLE_CHANGED,
      fn(
        () => {
          this.effects.title(this.title());
        },
        2,
        false,
      ),
    );
    // (terminal, userdata, *out_attrs) -> bool
    this.setOpt(
      TerminalOpt.DEVICE_ATTRIBUTES,
      fn(
        (_t, _u, out) => {
          this.writeDeviceAttributes(out!);
          return 1;
        },
        3,
        true,
      ),
    );
    this.setOpt(
      TerminalOpt.SIZE,
      fn(
        (_t, _u, out) => {
          const view = this.vt.data();
          const f = L.GhosttySizeReportSize.fields;
          view.setUint16(out! + f.rows, this.size.rows, true);
          view.setUint16(out! + f.columns, this.size.cols, true);
          view.setUint32(out! + f.cell_width, this.size.cellWidth, true);
          view.setUint32(out! + f.cell_height, this.size.cellHeight, true);
          return 1;
        },
        3,
        true,
      ),
    );
    this.setOpt(
      TerminalOpt.COLOR_SCHEME,
      fn(
        (_t, _u, out) => {
          this.vt.data().setInt32(out!, this.scheme === 'dark' ? 1 : 0, true);
          return 1;
        },
        3,
        true,
      ),
    );
  }

  /**
   * DA1 as a VT220-class terminal with ANSI colour; DA2 as type 1. Station
   * answers itself rather than claiming another product's identity.
   */
  private writeDeviceAttributes(out: number): void {
    const view = this.vt.data();
    const p = out + L.GhosttyDeviceAttributes.fields.primary;
    const pf = L.GhosttyDeviceAttributesPrimary.fields;
    const features = [22];
    view.setUint16(p + pf.conformance_level, 62, true);
    features.forEach((feature, i) =>
      view.setUint16(p + pf.features + i * 2, feature, true),
    );
    view.setUint32(p + pf.num_features, features.length, true);
    const s = out + L.GhosttyDeviceAttributes.fields.secondary;
    view.setUint16(s, 1, true);
    view.setUint16(s + 2, 10, true);
    view.setUint16(s + 4, 0, true);
    view.setUint32(out + L.GhosttyDeviceAttributes.fields.tertiary, 0, true);
  }

  // ─── input from the PTY ──────────────────────────────────────────────────

  /**
   * Feeds PTY output. `replay` marks journal output from before this view
   * attached: it updates the screen but detaches the reply writer and bell.
   */
  write(bytes: Uint8Array, mode: 'live' | 'replay' = 'live'): void {
    this.assertLive();
    if (bytes.length === 0) return;
    this.replaying = mode === 'replay';
    try {
      for (let offset = 0; offset < bytes.length; offset += OUT_BYTES) {
        const chunk = bytes.subarray(offset, offset + OUT_BYTES);
        this.vt.writeBytes(this.out, chunk);
        this.vt.call(
          'ghostty_terminal_vt_write',
          this.term,
          this.out,
          chunk.length,
        );
      }
    } finally {
      this.replaying = false;
    }
  }

  resize(size: EngineSize): void {
    this.assertLive();
    const changedGrid =
      size.cols !== this.size.cols || size.rows !== this.size.rows;
    this.size = { ...size };
    this.vt.check(
      'ghostty_terminal_resize',
      this.term,
      size.cols,
      size.rows,
      size.cellWidth,
      size.cellHeight,
    );
    const view = this.vt.data();
    const s = this.scratch;
    const f = L.GhosttyMouseEncoderSize.fields;
    this.vt.bytes().fill(0, s, s + L.GhosttyMouseEncoderSize.size);
    view.setUint32(s + f.size, L.GhosttyMouseEncoderSize.size, true);
    view.setUint32(s + f.screen_width, size.cols * size.cellWidth, true);
    view.setUint32(s + f.screen_height, size.rows * size.cellHeight, true);
    view.setUint32(s + f.cell_width, size.cellWidth, true);
    view.setUint32(s + f.cell_height, size.cellHeight, true);
    this.vt.call(
      'ghostty_mouse_encoder_setopt',
      this.mouseEncoder,
      MouseEncoderOpt.SIZE,
      s,
    );
    if (changedGrid) this.forceFull = true;
  }

  setTheme(theme: EngineTheme): void {
    this.assertLive();
    this.scheme = theme.scheme;
    const view = () => this.vt.data();
    const rgb = (ptr: number, color: number) => {
      const v = view();
      v.setUint8(ptr, (color >> 16) & 0xff);
      v.setUint8(ptr + 1, (color >> 8) & 0xff);
      v.setUint8(ptr + 2, color & 0xff);
    };
    rgb(this.scratch, theme.foreground);
    this.setOpt(TerminalOpt.COLOR_FOREGROUND, this.scratch);
    rgb(this.scratch, theme.background);
    this.setOpt(TerminalOpt.COLOR_BACKGROUND, this.scratch);
    if (theme.cursor === null) this.setOpt(TerminalOpt.COLOR_CURSOR, 0);
    else {
      rgb(this.scratch, theme.cursor);
      this.setOpt(TerminalOpt.COLOR_CURSOR, this.scratch);
    }
    // Start from Ghostty's default 256 colours, then lay the theme's ANSI 16
    // over them. The palette is 768 bytes; it lives in the output buffer.
    this.vt.call('ghostty_color_palette_default', this.out);
    theme.ansi.slice(0, 16).forEach((color, i) => rgb(this.out + i * 3, color));
    this.setOpt(TerminalOpt.COLOR_PALETTE, this.out);
    this.forceFull = true;
  }

  // ─── reading ─────────────────────────────────────────────────────────────

  private terminalGet(data: number, out: number): number {
    return this.vt.call('ghostty_terminal_get', this.term, data, out);
  }

  title(): string {
    const s = this.scratch;
    if (this.terminalGet(TerminalData.TITLE, s) !== Result.SUCCESS) return '';
    const view = this.vt.data();
    const ptr = view.getUint32(s + L.GhosttyString.fields.ptr, true);
    const len = view.getUint32(s + L.GhosttyString.fields.len, true);
    return len ? this.decoder.decode(this.vt.readBytes(ptr, len)) : '';
  }

  mode(mode: number): boolean {
    const s = this.scratch;
    const view = this.vt.data();
    view.setUint16(
      s + L.GhosttyTerminalModeConfig.fields.mode,
      mode & 0x7fff,
      true,
    );
    view.setUint8(s + L.GhosttyTerminalModeConfig.fields.value, 0);
    if (this.terminalGet(TerminalData.MODE, s) !== Result.SUCCESS) return false;
    return (
      this.vt.data().getUint8(s + L.GhosttyTerminalModeConfig.fields.value) !==
      0
    );
  }

  mouseTracking(): boolean {
    const s = this.scratch;
    this.vt.data().setUint8(s, 0);
    if (this.terminalGet(TerminalData.MOUSE_TRACKING, s) !== Result.SUCCESS)
      return false;
    return this.vt.data().getUint8(s) !== 0;
  }

  /**
   * Snapshot of what changed since the last frame, or `null` when nothing
   * did. Rows whose dirty flag is clear are listed by id only.
   */
  frame(): Frame | null {
    this.assertLive();
    const vt = this.vt;
    const s = this.scratch;
    vt.check('ghostty_render_state_update', this.renderState, this.term);
    vt.check('ghostty_render_state_get', this.renderState, RenderData.DIRTY, s);
    const dirty = vt.data().getInt32(s, true);
    if (dirty === RenderDirty.FALSE && !this.forceFull) return null;
    const full = dirty === RenderDirty.FULL || this.forceFull;

    vt.check('ghostty_render_state_get', this.renderState, RenderData.COLS, s);
    vt.check(
      'ghostty_render_state_get',
      this.renderState,
      RenderData.ROWS,
      s + 2,
    );
    let view = vt.data();
    const cols = view.getUint16(s, true);
    const rows = view.getUint16(s + 2, true);

    const cursor = this.readCursor();
    const colors = this.readColors();
    const scrollbar = this.readScrollbar();

    // Point the reusable iterator at this update's rows.
    view = vt.data();
    view.setUint32(s, this.rowIterator, true);
    vt.check(
      'ghostty_render_state_get',
      this.renderState,
      RenderData.ROW_ITERATOR,
      s,
    );

    const rowIds: string[] = [];
    const dirtyRows: RowCells[] = [];
    let y = 0;
    while (
      vt.call('ghostty_render_state_row_iterator_next', this.rowIterator)
    ) {
      vt.check('ghostty_render_state_row_get', this.rowIterator, RowData.ID, s);
      const id = hex64(vt.data(), s);
      rowIds.push(id);
      let rowDirty = full;
      if (!rowDirty) {
        vt.check(
          'ghostty_render_state_row_get',
          this.rowIterator,
          RowData.DIRTY,
          s,
        );
        rowDirty = vt.data().getUint8(s) !== 0;
      }
      if (rowDirty) dirtyRows.push(this.readRow(id, y, cols));
      y += 1;
    }

    vt.check('ghostty_render_state_clean', this.renderState);
    this.forceFull = false;
    return {
      cols,
      rows,
      full,
      rowIds,
      dirty: dirtyRows,
      cursor,
      colors,
      scrollbar,
      atBottom: scrollbar.offset + scrollbar.length >= scrollbar.total,
    };
  }

  /** Forces the next {@link frame} to carry every row (e.g. after context loss). */
  invalidate(): void {
    this.forceFull = true;
  }

  private readCursor(): CursorFrame | null {
    const vt = this.vt;
    const s = this.scratch;
    const f = L.GhosttyRenderStateCursor.fields;
    vt.bytes().fill(0, s, s + L.GhosttyRenderStateCursor.size);
    vt.data().setUint32(s, L.GhosttyRenderStateCursor.size, true);
    vt.check(
      'ghostty_render_state_get',
      this.renderState,
      RenderData.CURSOR,
      s,
    );
    const view = vt.data();
    if (!view.getUint8(s + f.viewport_has_value)) return null;
    return {
      x: view.getUint16(s + f.viewport_x, true),
      y: view.getUint16(s + f.viewport_y, true),
      visible: view.getUint8(s + f.visible) !== 0,
      blinking: view.getUint8(s + f.blinking) !== 0,
      wideTail: view.getUint8(s + f.wide_tail) !== 0,
      shape: SHAPE[view.getInt32(s + f.visual_style, true)] ?? 'block',
    };
  }

  private readColors(): Frame['colors'] {
    const vt = this.vt;
    const ptr = this.out;
    const f = L.GhosttyRenderStateColors.fields;
    vt.bytes().fill(0, ptr, ptr + L.GhosttyRenderStateColors.size);
    vt.data().setUint32(ptr, L.GhosttyRenderStateColors.size, true);
    vt.check(
      'ghostty_render_state_get',
      this.renderState,
      RenderData.COLORS,
      ptr,
    );
    const view = vt.data();
    const palette = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1)
      palette[i] = packRgb(view, ptr + f.palette + i * 3);
    return {
      background: packRgb(view, ptr + f.background),
      foreground: packRgb(view, ptr + f.foreground),
      cursor: view.getUint8(ptr + f.cursor_has_value)
        ? packRgb(view, ptr + f.cursor)
        : null,
      palette,
    };
  }

  private readScrollbar(): Frame['scrollbar'] {
    const s = this.scratch;
    const f = L.GhosttyTerminalScrollbar.fields;
    if (this.terminalGet(TerminalData.SCROLLBAR, s) !== Result.SUCCESS)
      return { total: this.size.rows, offset: 0, length: this.size.rows };
    const view = this.vt.data();
    return {
      total: Number(view.getBigUint64(s + f.total, true)),
      offset: Number(view.getBigUint64(s + f.offset, true)),
      length: Number(view.getBigUint64(s + f.len, true)),
    };
  }

  private readRow(id: string, y: number, cols: number): RowCells {
    const vt = this.vt;
    const s = this.scratch;
    const codepoints = new Uint32Array(cols);
    const fg = new Uint32Array(cols).fill(DEFAULT_COLOR);
    const bg = new Uint32Array(cols).fill(DEFAULT_COLOR);
    const attrs = new Uint16Array(cols);
    const clusters: Record<number, string> = {};

    // Row-level facts: soft wrap and the selected span.
    vt.check('ghostty_render_state_row_get', this.rowIterator, RowData.RAW, s);
    const rawRow = vt.data().getBigUint64(s, true);
    vt.data().setUint8(s, 0);
    vt.call('ghostty_row_get', rawRow, 1 /* GHOSTTY_ROW_DATA_WRAP */, s);
    const wrapped = vt.data().getUint8(s) !== 0;

    let selection: [number, number] | null = null;
    const sel = L.GhosttyRenderStateRowSelection;
    vt.data().setUint32(s, sel.size, true);
    if (
      vt.call(
        'ghostty_render_state_row_get',
        this.rowIterator,
        RowData.SELECTION,
        s,
      ) === Result.SUCCESS
    ) {
      const view = vt.data();
      selection = [
        view.getUint16(s + sel.fields.start_x, true),
        view.getUint16(s + sel.fields.end_x, true),
      ];
    }

    vt.data().setUint32(s, this.rowCells, true);
    vt.check(
      'ghostty_render_state_row_get',
      this.rowIterator,
      RowData.CELLS,
      s,
    );

    const style = this.out;
    const sf = L.GhosttyStyle.fields;
    for (let x = 0; x < cols; x += 1) {
      if (!vt.call('ghostty_render_state_row_cells_next', this.rowCells)) break;
      let attr = 0;

      vt.check(
        'ghostty_render_state_row_cells_get',
        this.rowCells,
        CellsData.RAW,
        s,
      );
      const raw = vt.data().getBigUint64(s, true);
      vt.check('ghostty_cell_get', raw, CellData.WIDE, s);
      const wide = vt.data().getInt32(s, true);
      attr |= (wide << Attr.WIDE_SHIFT) & Attr.WIDE_MASK;
      vt.check('ghostty_cell_get', raw, CellData.HAS_HYPERLINK, s);
      if (vt.data().getUint8(s)) attr |= Attr.HYPERLINK;

      if (wide !== CellWide.SPACER_TAIL && wide !== CellWide.SPACER_HEAD) {
        vt.check(
          'ghostty_render_state_row_cells_get',
          this.rowCells,
          CellsData.GRAPHEMES_LEN,
          s,
        );
        const length = vt.data().getUint32(s, true);
        if (length > 0 && length <= MAX_CLUSTER_CODEPOINTS) {
          const count = length;
          const buf = this.out + CLUSTER_OFFSET;
          vt.check(
            'ghostty_render_state_row_cells_get',
            this.rowCells,
            CellsData.GRAPHEMES_BUF,
            buf,
          );
          const view = vt.data();
          const first = view.getUint32(buf, true);
          codepoints[x] = first;
          if (count > 1) {
            let text = '';
            for (let i = 0; i < count; i += 1)
              text += String.fromCodePoint(view.getUint32(buf + i * 4, true));
            clusters[x] = text;
          }
        }
      }

      vt.check(
        'ghostty_render_state_row_cells_get',
        this.rowCells,
        CellsData.HAS_STYLING,
        s,
      );
      const styled = vt.data().getUint8(s) !== 0;
      if (styled) {
        vt.data().setUint32(style, L.GhosttyStyle.size, true);
        vt.check(
          'ghostty_render_state_row_cells_get',
          this.rowCells,
          CellsData.STYLE,
          style,
        );
        const view = vt.data();
        if (view.getUint8(style + sf.bold)) attr |= Attr.BOLD;
        if (view.getUint8(style + sf.italic)) attr |= Attr.ITALIC;
        if (view.getUint8(style + sf.faint)) attr |= Attr.FAINT;
        if (view.getUint8(style + sf.blink)) attr |= Attr.BLINK;
        if (view.getUint8(style + sf.inverse)) attr |= Attr.INVERSE;
        if (view.getUint8(style + sf.invisible)) attr |= Attr.INVISIBLE;
        if (view.getUint8(style + sf.strikethrough)) attr |= Attr.STRIKETHROUGH;
        if (view.getUint8(style + sf.overline)) attr |= Attr.OVERLINE;
        attr |=
          ((view.getInt32(style + sf.underline, true) & 0b111) <<
            Attr.UNDERLINE_SHIFT) &
          Attr.UNDERLINE_MASK;
        if (
          vt.call(
            'ghostty_render_state_row_cells_get',
            this.rowCells,
            CellsData.FG_COLOR,
            s,
          ) === Result.SUCCESS
        )
          fg[x] = packRgb(vt.data(), s);
      }
      // A background can come from the cell content itself (erase with a
      // colour) as well as from its style, so ask regardless of styling.
      if (
        vt.call(
          'ghostty_render_state_row_cells_get',
          this.rowCells,
          CellsData.BG_COLOR,
          s,
        ) === Result.SUCCESS
      )
        bg[x] = packRgb(vt.data(), s);
      attrs[x] = attr;
    }
    return { id, y, codepoints, clusters, fg, bg, attrs, selection, wrapped };
  }

  // ─── encoders ────────────────────────────────────────────────────────────

  /** PTY bytes for a key, or null when the key produces none. */
  encodeKey(input: KeyInput): Uint8Array | null {
    this.assertLive();
    const key = GHOSTTY_KEY_BY_CODE[input.code] ?? 0;
    const vt = this.vt;
    const textBytes = this.encoder.encode(input.text);
    const textPtr = this.scratch + 64;
    if (textBytes.length > 256) return null;
    vt.writeBytes(textPtr, textBytes);
    vt.call(
      'ghostty_key_encoder_setopt_from_terminal',
      this.keyEncoder,
      this.term,
    );
    vt.call(
      'ghostty_key_event_set_action',
      this.keyEvent,
      KEY_ACTION[input.action],
    );
    vt.call('ghostty_key_event_set_key', this.keyEvent, key);
    vt.call('ghostty_key_event_set_mods', this.keyEvent, input.mods);
    // Shift is consumed when it chose the produced text (`A` vs `a`).
    const consumed = textBytes.length > 0 ? input.mods & Mods.SHIFT : 0;
    vt.call('ghostty_key_event_set_consumed_mods', this.keyEvent, consumed);
    vt.call(
      'ghostty_key_event_set_composing',
      this.keyEvent,
      input.composing ? 1 : 0,
    );
    vt.call(
      'ghostty_key_event_set_utf8',
      this.keyEvent,
      textPtr,
      textBytes.length,
    );
    vt.call(
      'ghostty_key_event_set_unshifted_codepoint',
      this.keyEvent,
      input.unshifted,
    );
    return this.encodeInto((buf, cap, written) =>
      vt.call(
        'ghostty_key_encoder_encode',
        this.keyEncoder,
        this.keyEvent,
        buf,
        cap,
        written,
      ),
    );
  }

  encodeMouse(input: MouseInput): Uint8Array | null {
    this.assertLive();
    const vt = this.vt;
    vt.call(
      'ghostty_mouse_encoder_setopt_from_terminal',
      this.mouseEncoder,
      this.term,
    );
    vt.call(
      'ghostty_mouse_event_set_action',
      this.mouseEvent,
      MOUSE_ACTION[input.action],
    );
    if (input.button > 0)
      vt.call('ghostty_mouse_event_set_button', this.mouseEvent, input.button);
    else vt.call('ghostty_mouse_event_clear_button', this.mouseEvent);
    vt.call('ghostty_mouse_event_set_mods', this.mouseEvent, input.mods);
    const pos = this.scratch + 32;
    const view = vt.data();
    view.setFloat32(pos + L.GhosttyMousePosition.fields.x, input.x, true);
    view.setFloat32(pos + L.GhosttyMousePosition.fields.y, input.y, true);
    vt.call('ghostty_mouse_event_set_position', this.mouseEvent, pos);
    return this.encodeInto((buf, cap, written) =>
      vt.call(
        'ghostty_mouse_encoder_encode',
        this.mouseEncoder,
        this.mouseEvent,
        buf,
        cap,
        written,
      ),
    );
  }

  /** Focus report, only when the program enabled focus events (mode 1004). */
  encodeFocus(focused: boolean): Uint8Array | null {
    this.assertLive();
    if (!this.mode(DecMode.FOCUS_EVENT)) return null;
    return this.encodeInto((buf, cap, written) =>
      this.vt.call(
        'ghostty_focus_encode',
        focused ? FocusEvent.GAINED : FocusEvent.LOST,
        buf,
        cap,
        written,
      ),
    );
  }

  /** Paste bytes: bracketed when the program asked (mode 2004). */
  encodePaste(text: string): Uint8Array {
    this.assertLive();
    const data = this.encoder.encode(text);
    const vt = this.vt;
    const bracketed = this.mode(DecMode.BRACKETED_PASTE);
    const capacity = data.length * 2 + 64;
    const input = vt.alloc(Math.max(1, data.length));
    const output = vt.alloc(capacity);
    try {
      vt.writeBytes(input, data);
      const written = this.scratch;
      vt.check(
        'ghostty_paste_encode',
        input,
        data.length,
        bracketed ? 1 : 0,
        output,
        capacity,
        written,
      );
      return vt.readBytes(output, vt.data().getUint32(written, true));
    } finally {
      vt.free(output, capacity);
      vt.free(input, Math.max(1, data.length));
    }
  }

  private encodeInto(
    encode: (buf: number, capacity: number, written: number) => number,
  ): Uint8Array | null {
    const written = this.scratch + 8;
    this.vt.data().setUint32(written, 0, true);
    const result = encode(this.out, OUT_BYTES, written);
    if (result !== Result.SUCCESS) {
      if (result === Result.NO_VALUE) return null;
      throw new GhosttyVtError('encode', result);
    }
    const length = this.vt.data().getUint32(written, true);
    return length ? this.vt.readBytes(this.out, length) : null;
  }

  // ─── viewport ────────────────────────────────────────────────────────────

  scroll(target: { delta: number } | { row: number } | 'top' | 'bottom'): void {
    this.assertLive();
    const s = this.scratch;
    const f = L.GhosttyTerminalScrollViewport.fields;
    const view = this.vt.data();
    this.vt.bytes().fill(0, s, s + L.GhosttyTerminalScrollViewport.size);
    if (target === 'top') view.setInt32(s + f.tag, ScrollViewport.TOP, true);
    else if (target === 'bottom')
      view.setInt32(s + f.tag, ScrollViewport.BOTTOM, true);
    else if ('delta' in target) {
      view.setInt32(s + f.tag, ScrollViewport.DELTA, true);
      view.setInt32(s + f.value, Math.trunc(target.delta), true);
    } else {
      view.setInt32(s + f.tag, ScrollViewport.ROW, true);
      view.setUint32(s + f.value, Math.max(0, Math.trunc(target.row)), true);
    }
    // wasm32 passes a by-value struct of this size indirectly.
    this.vt.call('ghostty_terminal_scroll_viewport', this.term, s);
  }

  /** Clears the screen and scrollback the way `clear` + `ESC[3J` would. */
  clear(): void {
    this.write(this.encoder.encode('\x1b[H\x1b[2J\x1b[3J'), 'replay');
  }

  // ─── selection ───────────────────────────────────────────────────────────

  private gridRef(x: number, y: number, out: number): boolean {
    const point = this.scratch + 128;
    const view = this.vt.data();
    this.vt.bytes().fill(0, point, point + L.GhosttyPoint.size);
    view.setInt32(point + L.GhosttyPoint.fields.tag, PointTag.VIEWPORT, true);
    const c = point + L.GhosttyPoint.fields.value;
    view.setUint16(c + L.GhosttyPointCoordinate.fields.x, x, true);
    view.setUint32(c + L.GhosttyPointCoordinate.fields.y, y, true);
    view.setUint32(out, L.GhosttyGridRef.size, true);
    return (
      this.vt.call('ghostty_terminal_grid_ref', this.term, point, out) ===
      Result.SUCCESS
    );
  }

  /**
   * One step of a pointer selection. Ghostty's gesture state machine owns
   * click counting (word on double click, line on triple click).
   */
  selectionGesture(
    type: 'press' | 'drag' | 'release',
    cell: { x: number; y: number },
    pixel: { x: number; y: number },
    timeMs: number,
  ): void {
    this.assertLive();
    const vt = this.vt;
    const eventType =
      type === 'press'
        ? GestureEventType.PRESS
        : type === 'drag'
          ? GestureEventType.DRAG
          : GestureEventType.RELEASE;
    const handle = vt.constructWith(
      'ghostty_selection_gesture_event_new',
      [0],
      [eventType],
    );
    try {
      const ref = this.scratch + 160;
      const hasRef = this.gridRef(cell.x, cell.y, ref);
      if (hasRef)
        vt.check(
          'ghostty_selection_gesture_event_set',
          handle,
          GestureEventOpt.REF,
          ref,
        );
      if (type !== 'release') {
        const pos = this.scratch + 192;
        const view = vt.data();
        view.setFloat64(pos + L.GhosttySurfacePosition.fields.x, pixel.x, true);
        view.setFloat64(pos + L.GhosttySurfacePosition.fields.y, pixel.y, true);
        vt.check(
          'ghostty_selection_gesture_event_set',
          handle,
          GestureEventOpt.POSITION,
          pos,
        );
        const geometry = this.scratch + 224;
        const g = L.GhosttySelectionGestureGeometry.fields;
        view.setUint32(geometry + g.columns, this.size.cols, true);
        view.setUint32(geometry + g.cell_width, this.size.cellWidth, true);
        view.setUint32(geometry + g.padding_left, 0, true);
        view.setUint32(
          geometry + g.screen_height,
          this.size.rows * this.size.cellHeight,
          true,
        );
        vt.check(
          'ghostty_selection_gesture_event_set',
          handle,
          GestureEventOpt.GEOMETRY,
          geometry,
        );
        const time = this.scratch + 248;
        vt.data().setBigUint64(time, BigInt(Math.round(timeMs * 1e6)), true);
        vt.check(
          'ghostty_selection_gesture_event_set',
          handle,
          GestureEventOpt.TIME_NS,
          time,
        );
      }
      // Press and drag need a cell; a release may land outside the grid.
      if (!hasRef && type !== 'release') return;
      const selection = this.out;
      vt.data().setUint32(selection, L.GhosttySelection.size, true);
      const result = vt.call(
        'ghostty_selection_gesture_event',
        this.gesture,
        this.term,
        handle,
        selection,
      );
      if (result === Result.SUCCESS)
        this.setOpt(TerminalOpt.SELECTION, selection);
    } finally {
      vt.call('ghostty_selection_gesture_event_free', handle);
    }
  }

  selectAll(): void {
    this.assertLive();
    const selection = this.out;
    this.vt.data().setUint32(selection, L.GhosttySelection.size, true);
    this.vt.check('ghostty_terminal_select_all', this.term, selection);
    this.setOpt(TerminalOpt.SELECTION, selection);
  }

  clearSelection(): void {
    this.assertLive();
    this.setOpt(TerminalOpt.SELECTION, 0);
  }

  /** The selected text, unwrapped and trimmed, or '' when nothing is selected. */
  selectionText(): string {
    this.assertLive();
    const vt = this.vt;
    const selection = this.scratch + 256;
    vt.data().setUint32(selection, L.GhosttySelection.size, true);
    if (this.terminalGet(TerminalData.SELECTION, selection) !== Result.SUCCESS)
      return '';
    const options = this.scratch + 320;
    const f = L.GhosttyTerminalSelectionFormatOptions.fields;
    vt.bytes().fill(
      0,
      options,
      options + L.GhosttyTerminalSelectionFormatOptions.size,
    );
    const view = vt.data();
    view.setUint32(
      options + f.size,
      L.GhosttyTerminalSelectionFormatOptions.size,
      true,
    );
    view.setInt32(options + f.emit, FormatterFormat.PLAIN, true);
    view.setUint8(options + f.unwrap, 1);
    view.setUint8(options + f.trim, 1);
    view.setUint32(options + f.selection, selection, true);
    return this.allocText((outPtr, outLen) =>
      vt.call(
        'ghostty_terminal_selection_format_alloc',
        this.term,
        0,
        options,
        outPtr,
        outLen,
      ),
    );
  }

  /**
   * Plain text of the whole terminal (scrollback and screen) from the
   * emulator's rows. The accessibility mirror reads this, so cursor-addressed
   * redraws show what a sighted user sees, not the raw byte stream.
   */
  plainText(): string {
    this.assertLive();
    const vt = this.vt;
    const options = this.scratch + 320;
    const f = L.GhosttyFormatterTerminalOptions.fields;
    const extra = options + f.extra;
    vt.bytes().fill(
      0,
      options,
      options + L.GhosttyFormatterTerminalOptions.size,
    );
    const view = vt.data();
    view.setUint32(
      options + f.size,
      L.GhosttyFormatterTerminalOptions.size,
      true,
    );
    view.setInt32(options + f.emit, FormatterFormat.PLAIN, true);
    view.setUint8(options + f.unwrap, 0);
    view.setUint8(options + f.trim, 1);
    view.setUint32(extra, L.GhosttyFormatterTerminalExtra.size, true);
    view.setUint32(
      extra + L.GhosttyFormatterTerminalExtra.fields.screen,
      L.GhosttyFormatterScreenExtra.size,
      true,
    );
    const formatter = vt.constructWith(
      'ghostty_formatter_terminal_new',
      [0],
      [this.term, options],
    );
    try {
      return this.allocText((outPtr, outLen) =>
        vt.call('ghostty_formatter_format_alloc', formatter, 0, outPtr, outLen),
      );
    } finally {
      vt.call('ghostty_formatter_free', formatter);
    }
  }

  private allocText(
    format: (outPtr: number, outLen: number) => number,
  ): string {
    const outPtr = this.scratch + 400;
    const outLen = this.scratch + 404;
    const view = this.vt.data();
    view.setUint32(outPtr, 0, true);
    view.setUint32(outLen, 0, true);
    const result = format(outPtr, outLen);
    if (result !== Result.SUCCESS) return '';
    const ptr = this.vt.data().getUint32(outPtr, true);
    const len = this.vt.data().getUint32(outLen, true);
    try {
      return len ? this.decoder.decode(this.vt.readBytes(ptr, len)) : '';
    } finally {
      if (ptr) this.vt.call('ghostty_free', 0, ptr, len);
    }
  }

  /** The OSC 8 hyperlink URI at a viewport cell, if the program set one. */
  hyperlinkAt(x: number, y: number): string | null {
    this.assertLive();
    const ref = this.scratch + 160;
    if (!this.gridRef(x, y, ref)) return null;
    const written = this.scratch + 8;
    const cap = 4096;
    const result = this.vt.call(
      'ghostty_grid_ref_hyperlink_uri',
      ref,
      this.out,
      cap,
      written,
    );
    if (result !== Result.SUCCESS) return null;
    const len = this.vt.data().getUint32(written, true);
    return len ? this.decoder.decode(this.vt.readBytes(this.out, len)) : null;
  }

  // ─── search ──────────────────────────────────────────────────────────────

  /**
   * Sets the find needle (empty clears it), runs the search to completion
   * and selects the first match. Matches are selections, so the match shows
   * through the ordinary selection highlight.
   */
  find(
    needle: string,
    direction: 'next' | 'prev' | 'same' = 'same',
  ): SearchState {
    this.assertLive();
    const vt = this.vt;
    if (!this.search)
      this.search = vt.constructWith('ghostty_search_new', [0], [this.term]);
    if (direction === 'same') {
      const bytes = this.encoder.encode(needle);
      const text = vt.alloc(Math.max(1, bytes.length));
      try {
        vt.writeBytes(text, bytes);
        const str = this.scratch + 448;
        vt.data().setUint32(str + L.GhosttyString.fields.ptr, text, true);
        vt.data().setUint32(
          str + L.GhosttyString.fields.len,
          bytes.length,
          true,
        );
        vt.check(
          'ghostty_search_set',
          this.search,
          SearchOpt.NEEDLE,
          bytes.length ? str : 0,
        );
      } finally {
        vt.free(text, Math.max(1, bytes.length));
      }
      if (!needle) {
        this.clearSelection();
        return { total: 0, selected: -1 };
      }
    }
    vt.check('ghostty_search_run', this.search);
    if (direction !== 'same' || this.searchState().selected < 0) {
      // The select options take a NULL value (reserved by the C API).
      vt.call(
        'ghostty_search_set',
        this.search,
        direction === 'prev' ? SearchOpt.SELECT_PREV : SearchOpt.SELECT_NEXT,
        0,
      );
    }
    const state = this.searchState();
    const match = this.scratch + 256;
    vt.data().setUint32(match, L.GhosttySelection.size, true);
    if (
      vt.call(
        'ghostty_search_get',
        this.search,
        SearchData.SELECTED_MATCH,
        match,
      ) === Result.SUCCESS
    )
      this.setOpt(TerminalOpt.SELECTION, match);
    return state;
  }

  private searchState(): SearchState {
    const s = this.scratch + 456;
    const view = this.vt.data();
    view.setUint32(s, 0, true);
    view.setInt32(s + 4, -1, true);
    this.vt.call(
      'ghostty_search_get',
      this.search,
      SearchData.TOTAL_MATCHES,
      s,
    );
    const index = this.vt.call(
      'ghostty_search_get',
      this.search,
      SearchData.SELECTED_INDEX,
      s + 4,
    );
    const v = this.vt.data();
    return {
      total: v.getUint32(s, true),
      selected: index === Result.SUCCESS ? v.getUint32(s + 4, true) : -1,
    };
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  private assertLive(): void {
    if (this.disposed) throw new Error('TerminalEngine is disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const vt = this.vt;
    if (this.search) vt.call('ghostty_search_free', this.search);
    vt.call('ghostty_selection_gesture_free', this.gesture, this.term);
    vt.call('ghostty_mouse_event_free', this.mouseEvent);
    vt.call('ghostty_mouse_encoder_free', this.mouseEncoder);
    vt.call('ghostty_key_event_free', this.keyEvent);
    vt.call('ghostty_key_encoder_free', this.keyEncoder);
    vt.call('ghostty_render_state_row_cells_free', this.rowCells);
    vt.call('ghostty_render_state_row_iterator_free', this.rowIterator);
    vt.call('ghostty_render_state_free', this.renderState);
    vt.call('ghostty_terminal_free', this.term);
    for (const index of this.callbacks) vt.removeFunction(index);
    vt.free(this.out, OUT_BYTES);
    vt.free(this.scratch, SCRATCH_BYTES);
  }
}
