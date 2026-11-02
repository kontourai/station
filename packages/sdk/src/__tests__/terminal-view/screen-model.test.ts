import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOR,
  type Frame,
  type RowCells,
} from '../../terminal-view/engine/frame';
import { ScreenModel } from '../../terminal-view/render/screen-model';

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
