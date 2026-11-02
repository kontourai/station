import { describe, expect, it } from 'vitest';
import {
  Attr,
  DEFAULT_COLOR,
  type Frame,
  type RowCells,
} from '../../terminal-view/engine/frame';
import {
  cellPaint,
  ScreenModel,
  type TerminalTheme,
} from '../../terminal-view/render/screen-model';
import { contrast } from '../../terminal-view/theme';

function row(id: string, y: number, text: string): RowCells {
  const n = 4;
  const cps = new Uint32Array(n);
  [...text].forEach((c, i) => {
    cps[i] = c.codePointAt(0)!;
  });
  return {
    id,
    y,
    codepoints: cps,
    clusters: {},
    fg: new Uint32Array(n).fill(DEFAULT_COLOR),
    bg: new Uint32Array(n).fill(DEFAULT_COLOR),
    attrs: new Uint16Array(n),
    selection: null,
    wrapped: false,
  };
}

function frame(rowIds: string[], dirty: RowCells[], full = false): Frame {
  return {
    cols: 4,
    rows: rowIds.length,
    full,
    rowIds,
    dirty,
    cursor: null,
    colors: {
      background: 0,
      foreground: 0xffffff,
      cursor: null,
      palette: new Uint32Array(256),
    },
    scrollbar: { total: rowIds.length, offset: 0, length: rowIds.length },
    atBottom: true,
  };
}

describe('ScreenModel', () => {
  it('reuses clean rows by id and moves them with the scroll', () => {
    const model = new ScreenModel();
    expect(
      model.apply(
        frame(
          ['a', 'b', 'c'],
          [row('a', 0, 'one'), row('b', 1, 'two'), row('c', 2, 'thr')],
          true,
        ),
      ),
    ).toBe(true);
    const kept = model.rows[1];
    // Scrolled by one: b and c move up untouched, d is new.
    expect(model.apply(frame(['b', 'c', 'd'], [row('d', 2, 'fou')]))).toBe(
      true,
    );
    expect(model.lines()).toEqual(['two', 'thr', 'fou']);
    expect(model.rows[0]!.codepoints).toBe(kept!.codepoints);
    expect(model.rows[0]!.y).toBe(0);
    expect([...model.changed].sort()).toEqual([0, 1, 2]);
  });

  it('reports an incomplete frame when it never saw a clean row', () => {
    const model = new ScreenModel();
    model.apply(frame(['a'], [row('a', 0, 'x')], true));
    expect(model.apply(frame(['a', 'zz'], []))).toBe(false);
  });

  it('marks only rewritten rows as changed', () => {
    const model = new ScreenModel();
    model.apply(frame(['a', 'b'], [row('a', 0, 'x'), row('b', 1, 'y')], true));
    model.apply(frame(['a', 'b'], [row('b', 1, 'z')]));
    expect([...model.changed]).toEqual([1]);
  });
});

describe('cellPaint', () => {
  const light: TerminalTheme = {
    foreground: 0x24292f,
    background: 0xffffff,
    cursor: 0x0969da,
    cursorText: 0xffffff,
    selectionBackground: 0xcce1ff,
    selectionForeground: null,
    ansi: [],
    scheme: 'light',
  };
  const colors = {
    background: light.background,
    foreground: light.foreground,
    cursor: null,
    palette: new Uint32Array(256),
  };
  const cell = (fg: number, bg: number, attr = 0) => {
    const r = row('r', 0, 'a');
    r.fg[0] = fg;
    r.bg[0] = bg;
    r.attrs[0] = attr;
    return cellPaint(r, 0, colors, light);
  };

  // A Powerline segment on light: palette white, darkened for the white
  // surface, drawn on palette blue.
  it('holds text on its own background to 4.5:1', () => {
    const paint = cell(0x6e7781, 0x0969da);
    expect(paint.bg).toBe(0x0969da);
    expect(contrast(paint.fg, 0x0969da)).toBeGreaterThanOrEqual(4.5);
  });

  it('holds inverse text to 4.5:1 against the colour it inverts onto', () => {
    const paint = cell(0x2da44e, DEFAULT_COLOR, Attr.INVERSE);
    expect(paint.bg).toBe(0x2da44e);
    expect(contrast(paint.fg, 0x2da44e)).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves text on the terminal surface and faint text alone', () => {
    expect(cell(0x6e7781, DEFAULT_COLOR).fg).toBe(0x6e7781);
    const faint = cell(0x6e7781, 0x0969da, Attr.FAINT);
    expect(contrast(faint.fg, 0x0969da)).toBeLessThan(4.5);
  });
});
