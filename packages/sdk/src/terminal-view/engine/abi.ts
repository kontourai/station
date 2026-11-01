/**
 * libghostty-vt C ABI facts the engine depends on, written from Ghostty's
 * public headers for wasm32 (pointers and size_t are 4 bytes, C enums are
 * `int`, bool is one byte). The layout manifest test compares every struct
 * below with the pinned module's own `ghostty_type_json()` report, so a
 * revision bump that moves a field fails before it can misread memory.
 */

export const Result = {
  SUCCESS: 0,
  OUT_OF_MEMORY: -1,
  INVALID_VALUE: -2,
  OUT_OF_SPACE: -3,
  NO_VALUE: -4,
} as const;

export const TerminalOpt = {
  USERDATA: 0,
  WRITE_PTY: 1,
  BELL: 2,
  TITLE_CHANGED: 5,
  SIZE: 6,
  COLOR_SCHEME: 7,
  DEVICE_ATTRIBUTES: 8,
  COLOR_FOREGROUND: 11,
  COLOR_BACKGROUND: 12,
  COLOR_CURSOR: 13,
  COLOR_PALETTE: 14,
  SELECTION: 21,
  SCROLLBACK_MAX_BYTES: 27,
  RESET: 43,
} as const;

export const TerminalData = {
  COLS: 1,
  ROWS: 2,
  ACTIVE_SCREEN: 6,
  SCROLLBAR: 9,
  MOUSE_TRACKING: 11,
  TITLE: 12,
  SELECTION: 31,
  VIEWPORT_ACTIVE: 32,
  MODE: 37,
} as const;

export const ScrollViewport = {
  TOP: 0,
  BOTTOM: 1,
  DELTA: 2,
  ROW: 3,
} as const;

export const RenderData = {
  COLS: 1,
  ROWS: 2,
  DIRTY: 3,
  ROW_ITERATOR: 4,
  CURSOR: 18,
  COLORS: 19,
} as const;

export const RenderDirty = { FALSE: 0, PARTIAL: 1, FULL: 2 } as const;

export const RowData = {
  DIRTY: 1,
  RAW: 2,
  CELLS: 3,
  SELECTION: 4,
  VIEWPORT_Y: 6,
  ID: 7,
} as const;

export const CellsData = {
  RAW: 1,
  STYLE: 2,
  GRAPHEMES_LEN: 3,
  GRAPHEMES_BUF: 4,
  BG_COLOR: 5,
  FG_COLOR: 6,
  HAS_STYLING: 8,
} as const;

export const CellData = {
  WIDE: 3,
  HAS_HYPERLINK: 7,
} as const;

export const CellWide = {
  NARROW: 0,
  WIDE: 1,
  SPACER_TAIL: 2,
  SPACER_HEAD: 3,
} as const;

export const CursorStyle = {
  BAR: 0,
  BLOCK: 1,
  UNDERLINE: 2,
  BLOCK_HOLLOW: 3,
} as const;

export const KeyAction = { RELEASE: 0, PRESS: 1, REPEAT: 2 } as const;

export const Mods = {
  SHIFT: 1 << 0,
  CTRL: 1 << 1,
  ALT: 1 << 2,
  SUPER: 1 << 3,
  CAPS_LOCK: 1 << 4,
  NUM_LOCK: 1 << 5,
} as const;

export const MouseAction = { PRESS: 0, RELEASE: 1, MOTION: 2 } as const;
export const MouseEncoderOpt = { SIZE: 2, ANY_BUTTON_PRESSED: 3 } as const;
export const FocusEvent = { GAINED: 0, LOST: 1 } as const;
export const FormatterFormat = { PLAIN: 0 } as const;

export const SearchOpt = {
  NEEDLE: 0,
  SELECT_NEXT: 1,
  SELECT_PREV: 2,
} as const;
export const SearchData = {
  STATUS: 0,
  TOTAL_MATCHES: 2,
  SELECTED_INDEX: 3,
  SELECTED_MATCH: 4,
} as const;

export const PointTag = { ACTIVE: 0, VIEWPORT: 1, SCREEN: 2 } as const;

export const GestureEventType = {
  PRESS: 0,
  RELEASE: 1,
  DRAG: 2,
} as const;
export const GestureEventOpt = {
  REF: 0,
  POSITION: 1,
  TIME_NS: 3,
  GEOMETRY: 8,
} as const;

/** DEC private modes Station reads. */
export const DecMode = {
  BRACKETED_PASTE: 2004,
  FOCUS_EVENT: 1004,
} as const;

export const UNDERLINE_NONE = 0;

/** A struct layout: total size, and byte offset of each field Station reads. */
export interface StructLayout {
  readonly size: number;
  readonly fields: Readonly<Record<string, number>>;
}

export const LAYOUT = {
  GhosttyString: { size: 8, fields: { ptr: 0, len: 4 } },
  GhosttyColorRgb: { size: 3, fields: { r: 0, g: 1, b: 2 } },
  GhosttyStyleColor: { size: 16, fields: { tag: 0, value: 8 } },
  GhosttyStyle: {
    size: 72,
    fields: {
      size: 0,
      fg_color: 8,
      bg_color: 24,
      underline_color: 40,
      bold: 56,
      italic: 57,
      faint: 58,
      blink: 59,
      inverse: 60,
      invisible: 61,
      strikethrough: 62,
      overline: 63,
      underline: 64,
    },
  },
  GhosttyRenderStateCursor: {
    size: 20,
    fields: {
      size: 0,
      viewport_has_value: 4,
      viewport_x: 6,
      viewport_y: 8,
      wide_tail: 10,
      visible: 11,
      blinking: 12,
      password_input: 13,
      visual_style: 16,
    },
  },
  GhosttyRenderStateColors: {
    size: 784,
    fields: {
      size: 0,
      background: 4,
      foreground: 7,
      cursor: 10,
      cursor_has_value: 13,
      palette: 14,
    },
  },
  GhosttyRenderStateRowId: { size: 16, fields: { bits: 0 } },
  GhosttyRenderStateRowSelection: {
    size: 8,
    fields: { size: 0, start_x: 4, end_x: 6 },
  },
  GhosttyTerminalScrollbar: {
    size: 24,
    fields: { total: 0, offset: 8, len: 16 },
  },
  GhosttyTerminalModeConfig: { size: 4, fields: { mode: 0, value: 2 } },
  GhosttyTerminalScrollViewport: { size: 24, fields: { tag: 0, value: 8 } },
  GhosttyMousePosition: { size: 8, fields: { x: 0, y: 4 } },
  GhosttyMouseEncoderSize: {
    size: 36,
    fields: {
      size: 0,
      screen_width: 4,
      screen_height: 8,
      cell_width: 12,
      cell_height: 16,
      padding_top: 20,
      padding_bottom: 24,
      padding_right: 28,
      padding_left: 32,
    },
  },
  GhosttyGridRef: { size: 12, fields: { size: 0, node: 4, x: 8, y: 10 } },
  GhosttySelection: {
    size: 32,
    fields: { size: 0, start: 4, end: 16, rectangle: 28 },
  },
  GhosttyPoint: { size: 24, fields: { tag: 0, value: 8 } },
  GhosttyPointCoordinate: { size: 8, fields: { x: 0, y: 4 } },
  GhosttyTerminalSelectionFormatOptions: {
    size: 16,
    fields: { size: 0, emit: 4, unwrap: 8, trim: 9, selection: 12 },
  },
  GhosttyFormatterTerminalOptions: {
    size: 40,
    fields: { size: 0, emit: 4, unwrap: 8, trim: 9, extra: 12, selection: 36 },
  },
  GhosttyFormatterTerminalExtra: { size: 24, fields: { size: 0, screen: 12 } },
  GhosttyFormatterScreenExtra: { size: 12, fields: { size: 0 } },
  GhosttyDeviceAttributes: {
    size: 148,
    fields: { primary: 0, secondary: 136, tertiary: 144 },
  },
  GhosttyDeviceAttributesPrimary: {
    size: 136,
    fields: { conformance_level: 0, features: 2, num_features: 132 },
  },
  GhosttySizeReportSize: {
    size: 12,
    fields: { rows: 0, columns: 2, cell_width: 4, cell_height: 8 },
  },
  GhosttySelectionGestureGeometry: {
    size: 16,
    fields: { columns: 0, cell_width: 4, padding_left: 8, screen_height: 12 },
  },
  GhosttySurfacePosition: { size: 16, fields: { x: 0, y: 8 } },
} as const satisfies Record<string, StructLayout>;
