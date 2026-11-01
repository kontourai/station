import { describe, expect, it } from 'vitest';
import {
  Attr,
  DEFAULT_COLOR,
  type RowCells,
} from '../../terminal-view/engine/frame';
import { findLinks, safeHttpUrl } from '../../terminal-view/links';

/** A row as the engine reports it; wide characters take two cells. */
function row(text: string): RowCells {
  const cps: number[] = [];
  const attrs: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const wide =
      cp >= 0x1100 && /\p{scx=Han}|\p{Emoji_Presentation}/u.test(char);
    cps.push(cp);
    attrs.push(wide ? 1 << Attr.WIDE_SHIFT : 0);
    if (wide) {
      cps.push(0);
      attrs.push(2 << Attr.WIDE_SHIFT);
    }
  }
  const n = cps.length;
  return {
    id: 'r',
    y: 0,
    codepoints: Uint32Array.from(cps),
    clusters: {},
    fg: new Uint32Array(n).fill(DEFAULT_COLOR),
    bg: new Uint32Array(n).fill(DEFAULT_COLOR),
    attrs: Uint16Array.from(attrs),
    selection: null,
    wrapped: false,
  };
}

describe('terminal links', () => {
  it('finds http(s) URLs and trims trailing punctuation', () => {
    const [link] = findLinks(row('see https://example.com/a?b=1). ok'));
    expect(link?.target).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b=1',
    });
    expect(link?.start).toBe(4);
  });

  it('never links other schemes', () => {
    expect(
      findLinks(row('javascript:alert(1) file:///etc/passwd data:text/html,x')),
    ).toEqual([]);
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('maps file:line:col to an editor target', () => {
    const links = findLinks(row('error at src/app/main.ts:12:7 and ./x.py:3'));
    expect(links.map((l) => l.target)).toEqual([
      { kind: 'path', path: 'src/app/main.ts', line: 12, column: 7 },
      { kind: 'path', path: './x.py', line: 3 },
    ]);
  });

  it('reports cell columns past wide characters', () => {
    const [link] = findLinks(row('漢字 https://a.test'));
    // Two wide characters cover four cells, then a space.
    expect(link?.start).toBe(5);
    expect(link?.end).toBe(5 + 'https://a.test'.length - 1);
  });
});
