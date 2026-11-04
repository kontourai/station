import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Mods } from '../../terminal-view/engine/abi';
import {
  Attr,
  DEFAULT_COLOR,
  type Frame,
  rowText,
} from '../../terminal-view/engine/frame';
import { TerminalEngine } from '../../terminal-view/engine/terminal-engine';
import { GhosttyVtModule } from '../../terminal-view/engine/wasm';

const wasmPath = fileURLToPath(
  new URL(
    '../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
    import.meta.url,
  ),
);
const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array | null) =>
  b ? new TextDecoder().decode(b) : null;

let module: WebAssembly.Module;
beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync(wasmPath));
});

const engines: TerminalEngine[] = [];
async function engine(cols = 20, rows = 5) {
  const replies: string[] = [];
  const bells: number[] = [];
  const titles: string[] = [];
  const vt = await GhosttyVtModule.instantiate(module);
  const e = new TerminalEngine(
    vt,
    { cols, rows, cellWidth: 8, cellHeight: 16 },
    {
      reply: (bytes) => replies.push(new TextDecoder().decode(bytes)),
      bell: () => bells.push(1),
      title: (title) => titles.push(title),
    },
  );
  engines.push(e);
  return { e, vt, replies, bells, titles };
}

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

function lines(frame: Frame): string[] {
  return frame.dirty.map(rowText);
}

describe('TerminalEngine over libghostty-vt', () => {
  it('snapshots rows with text and styles', async () => {
    const { e } = await engine();
    e.write(text('plain \x1b[1;31mbold red\x1b[0m\r\n\x1b[4;44munder\x1b[0m'));
    const frame = e.frame()!;
    expect(frame.full).toBe(true);
    expect(frame.rowIds).toHaveLength(5);
    expect(lines(frame).slice(0, 2)).toEqual(['plain bold red', 'under']);
    const [first, second] = frame.dirty;
    expect(first!.attrs[6]! & Attr.BOLD).toBeTruthy();
    expect(first!.fg[6]).not.toBe(DEFAULT_COLOR);
    expect(first!.fg[6]).toBe(frame.colors.palette[1]);
    expect(first!.fg[0]).toBe(DEFAULT_COLOR);
    expect(
      (second!.attrs[0]! & Attr.UNDERLINE_MASK) >> Attr.UNDERLINE_SHIFT,
    ).toBe(1);
    expect(second!.bg[0]).toBe(frame.colors.palette[4]);
    expect(frame.cursor).toMatchObject({ x: 5, y: 1, visible: true });
  });

  it('sends only dirty rows, with stable ids for the rest', async () => {
    const { e } = await engine();
    e.write(text('one\r\ntwo\r\nthree'));
    const first = e.frame()!;
    expect(e.frame()).toBeNull();
    e.write(text('\x1b[2;1Hchanged'));
    const next = e.frame()!;
    expect(next.full).toBe(false);
    expect(next.rowIds).toEqual(first.rowIds);
    expect(next.dirty.map((row) => row.y)).toContain(1);
    expect(next.dirty.map((row) => row.y)).not.toContain(0);
    expect(rowText(next.dirty.find((row) => row.y === 1)!)).toBe('changed');
  });

  it('marks wide characters and their spacer tails', async () => {
    const { e } = await engine();
    e.write(text('a漢b'));
    const row = e.frame()!.dirty[0]!;
    const wide = (x: number) =>
      (row.attrs[x]! & Attr.WIDE_MASK) >> Attr.WIDE_SHIFT;
    expect([wide(0), wide(1), wide(2), wide(3)]).toEqual([0, 1, 2, 0]);
    expect(rowText(row)).toBe('a漢b');
  });

  it('answers device queries on live output', async () => {
    const { e, replies } = await engine();
    e.write(text('\x1b[c'));
    e.write(text('\x1b[6n'));
    expect(replies.join('').startsWith('\x1b[?62;22c')).toBe(true);
    expect(replies.join('')).toContain('\x1b[1;1R');
  });

  it('detaches replies and bells while replaying a journal', async () => {
    const { e, replies, bells } = await engine();
    e.write(text('old\x1b[c\x1b[6n\x07'), 'replay');
    expect(replies).toEqual([]);
    expect(bells).toEqual([]);
    // The replayed text still renders.
    expect(lines(e.frame()!)[0]).toBe('old');
    // Live output after the replay is answered again.
    e.write(text('\x1b[c\x07'));
    expect(replies).toHaveLength(1);
    expect(bells).toHaveLength(1);
  });

  it('keeps program titles as untrusted text', async () => {
    const { e, titles } = await engine();
    e.write(text('\x1b]0;<img src=x onerror=alert(1)>\x07'));
    expect(titles).toEqual(['<img src=x onerror=alert(1)>']);
    expect(e.title()).toBe('<img src=x onerror=alert(1)>');
  });

  it('encodes keys through the terminal modes', async () => {
    const { e } = await engine();
    const key = (code: string, textValue = '', mods = 0) =>
      decode(
        e.encodeKey({
          code,
          action: 'press',
          mods,
          text: textValue,
          unshifted: textValue.toLowerCase().codePointAt(0) ?? 0,
        }),
      );
    expect(key('Enter')).toBe('\r');
    expect(key('KeyC', 'c', Mods.CTRL)).toBe('\x03');
    expect(key('ArrowUp')).toBe('\x1b[A');
    e.write(text('\x1b[?1h')); // DECCKM: application cursor keys
    expect(key('ArrowUp')).toBe('\x1bOA');
    expect(key('KeyA', 'A', Mods.SHIFT)).toBe('A');
  });

  it('brackets pastes only when the program asked', async () => {
    const { e } = await engine();
    expect(decode(e.encodePaste('ls\n'))).not.toContain('\x1b[200~');
    e.write(text('\x1b[?2004h'));
    expect(decode(e.encodePaste('ls'))).toBe('\x1b[200~ls\x1b[201~');
  });

  it('reports focus only in focus-event mode', async () => {
    const { e } = await engine();
    expect(e.encodeFocus(true)).toBeNull();
    e.write(text('\x1b[?1004h'));
    expect(decode(e.encodeFocus(true))).toBe('\x1b[I');
    expect(decode(e.encodeFocus(false))).toBe('\x1b[O');
  });

  it('encodes mouse reports in SGR mode', async () => {
    const { e } = await engine();
    expect(e.mouseTracking()).toBe(false);
    e.write(text('\x1b[?1000h\x1b[?1006h'));
    expect(e.mouseTracking()).toBe(true);
    // Cell (2, 1) at 8x16 pixels.
    const press = decode(
      e.encodeMouse({
        action: 'press',
        button: 1,
        x: 2 * 8 + 1,
        y: 16 + 1,
        mods: 0,
      }),
    );
    expect(press).toBe('\x1b[<0;3;2M');
  });

  it('keeps the accessible text equal to the rendered rows after cursor-addressed redraws', async () => {
    const { e } = await engine(20, 4);
    e.write(text('first line\r\nsecond\r\nthird'));
    // A full-screen program redraws in place: no newlines in the bytes.
    e.write(
      text(
        '\x1b[2;1H\x1b[2KREWRITTEN\x1b[1;7HXY\x1b[4;1Hstatus 50%\x1b[4;8H90',
      ),
    );
    const frame = e.frame()!;
    const rendered = frame.dirty.map(rowText);
    const mirror = e.plainText().split('\n');
    expect(rendered).toEqual([
      'first XYne',
      'REWRITTEN',
      'third',
      'status 90%',
    ]);
    expect(mirror.slice(-4)).toEqual(rendered);
  });

  it('includes scrollback in the accessible text', async () => {
    const { e } = await engine(10, 2);
    e.write(text('a\r\nb\r\nc\r\nd'));
    expect(e.plainText().split('\n')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('finds text in scrollback and selects the match', async () => {
    const { e } = await engine(20, 2);
    e.write(text('needle one\r\nhay\r\nhay\r\nneedle two\r\nhay'));
    const state = e.find('needle');
    expect(state.total).toBe(2);
    expect(state.selected).toBeGreaterThanOrEqual(0);
    expect(e.selectionText()).toBe('needle');
    const after = e.find('needle', 'next');
    expect(after.selected).not.toBe(state.selected);
    expect(e.find('', 'same').total).toBe(0);
  });

  it('selects all and copies unwrapped text', async () => {
    const { e } = await engine(10, 3);
    e.write(text('0123456789abc\r\nnext'));
    e.selectAll();
    expect(e.selectionText()).toBe('0123456789abc\nnext');
    e.clearSelection();
    expect(e.selectionText()).toBe('');
  });

  it('reads OSC 8 hyperlinks from cells', async () => {
    const { e } = await engine();
    e.write(
      text('\x1b]8;;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ plain'),
    );
    const row = e.frame()!.dirty[0]!;
    expect(row.attrs[0]! & Attr.HYPERLINK).toBeTruthy();
    expect(row.attrs[6]! & Attr.HYPERLINK).toBeFalsy();
    expect(e.hyperlinkAt(1, 0)).toBe('https://example.com/x');
    expect(e.hyperlinkAt(6, 0)).toBeNull();
  });

  it('scrolls the viewport and reports the scrollbar', async () => {
    const { e } = await engine(10, 2);
    e.write(text('1\r\n2\r\n3\r\n4\r\n5'));
    expect(e.frame()!.atBottom).toBe(true);
    e.scroll('top');
    const top = e.frame()!;
    expect(top.atBottom).toBe(false);
    expect(top.scrollbar.offset).toBe(0);
    expect(top.dirty.map(rowText)).toEqual(['1', '2']);
    e.scroll('bottom');
    expect(e.frame()!.atBottom).toBe(true);
  });

  it('survives memory growth across a large write', async () => {
    const { e, vt } = await engine(80, 24);
    const before = vt.exports.memory.buffer.byteLength;
    const line = `${'x'.repeat(79)}\r\n`;
    e.write(text(line.repeat(20_000)));
    expect(vt.exports.memory.buffer.byteLength).toBeGreaterThan(before);
    e.write(text('\x1b[2J\x1b[Hafter growth'));
    expect(lines(e.frame()!)[0]).toBe('after growth');
  });
});
