/**
 * station#3354 — the CommonMark fence scanner behind "don't highlight until
 * the fence closes". Pure function; every case here pins a pairing rule the
 * streaming split depends on.
 */
import { describe, expect, test } from 'vitest';
import { splitOpenFence } from '../components/chat/open-fence';

describe('splitOpenFence (station#3354)', () => {
  test('no fences — everything closed', () => {
    const r = splitOpenFence('hello **world**\n');
    expect(r.openTail).toBeNull();
    expect(r.closed).toBe('hello **world**\n');
  });

  test('closed backtick fence — everything closed', () => {
    const md = 'before\n```ts\nconst a = 1;\n```\nafter\n';
    const r = splitOpenFence(md);
    expect(r.openTail).toBeNull();
    expect(r.closed).toBe(md);
  });

  test('unclosed trailing fence — split out with lang', () => {
    const md = 'intro\n```python\ndef f():\n    pass';
    const r = splitOpenFence(md);
    expect(r.closed).toBe('intro\n');
    expect(r.openTail).toEqual({ code: 'def f():\n    pass', lang: 'python' });
  });

  test('closed block followed by unclosed fence — only the tail is open', () => {
    const md = '```js\nlet a;\n```\ntext\n```rust\nfn main() {';
    const r = splitOpenFence(md);
    expect(r.closed).toBe('```js\nlet a;\n```\ntext\n');
    expect(r.openTail).toEqual({ code: 'fn main() {', lang: 'rust' });
  });

  test('fence as very first line, unclosed — closed part is empty', () => {
    const r = splitOpenFence('```ts\nconst x = 2;');
    expect(r.closed).toBe('');
    expect(r.openTail).toEqual({ code: 'const x = 2;', lang: 'ts' });
  });

  test('no info string — lang undefined', () => {
    const r = splitOpenFence('```\nplain code');
    expect(r.openTail).toEqual({ code: 'plain code', lang: undefined });
  });

  test('tilde fences pair with tildes only', () => {
    expect(splitOpenFence('~~~js\nlet b;\n~~~\ndone').openTail).toBeNull();
    const mixed = splitOpenFence('~~~js\nlet b;\n```');
    expect(mixed.openTail?.code).toBe('let b;\n```');
  });

  test('closer must be at least as long as the opener', () => {
    expect(
      splitOpenFence('````\ncode with ``` inside\n````').openTail,
    ).toBeNull();
    expect(splitOpenFence('````\nstill open\n```').openTail).not.toBeNull();
  });

  test('backtick in a backtick fence info string disqualifies the opener', () => {
    const md = '``` bad`info\nnot a fence closer below\n```';
    // The first line is plain text; the ``` line OPENS a fence that never
    // closes, so the tail is open from that line.
    const r = splitOpenFence(md);
    expect(r.openTail).toEqual({ code: '', lang: undefined });
    expect(r.closed).toBe('``` bad`info\nnot a fence closer below\n');
  });

  test('up to three leading spaces of indentation count', () => {
    expect(splitOpenFence('   ```ts\nx').openTail?.lang).toBe('ts');
    // Four spaces disqualify that line as an OPENER (the pattern is
    // `^( {0,3})`, so it cannot match at all) — but the later bare ``` line
    // is itself a valid opener, so the scanner still ends inside a fence.
    // This is one input's scanner semantics, nothing more: `openTail` is
    // non-null here because of the UNINDENTED third line, not because the
    // indented fence was seen. The blind spot itself is pinned below, in
    // "a fence indented four or more spaces is not recognised".
    const r = splitOpenFence('    ```ts\nx\n```');
    expect(r.openTail).toEqual({ code: '', lang: undefined });
  });

  test('closing fence may carry trailing spaces', () => {
    expect(splitOpenFence('```ts\nx\n```   ').openTail).toBeNull();
  });

  test('a flush that ends ON the opening fence line keeps its language', () => {
    // The frame is labelled from `lang`; reading the header as '' here made
    // the first flush of every block announce itself as `text`.
    expect(splitOpenFence('intro\n```ts')).toEqual({
      closed: 'intro\n',
      openTail: { code: '', lang: 'ts' },
    });
    expect(splitOpenFence('```python')).toEqual({
      closed: '',
      openTail: { code: '', lang: 'python' },
    });
    // No info string on that line still means no language.
    expect(splitOpenFence('```').openTail).toEqual({
      code: '',
      lang: undefined,
    });
  });

  describe('CRLF line endings are scanned, not skipped', () => {
    test('an unclosed CRLF fence is reported OPEN', () => {
      const r = splitOpenFence('intro\r\n```js\r\nconst a = 1;\r\n');
      expect(r.openTail).toEqual({
        code: 'const a = 1;\n',
        lang: 'js',
      });
      expect(r.closed).toBe('intro\n');
    });

    test('a closed CRLF fence is reported CLOSED', () => {
      const r = splitOpenFence('```js\r\nconst a = 1;\r\n```\r\nafter\r\n');
      expect(r.openTail).toBeNull();
      expect(r.closed).toBe('```js\nconst a = 1;\n```\nafter\n');
    });

    test('a lone-CR (classic Mac) fence is scanned too', () => {
      expect(splitOpenFence('```ts\rlet a;').openTail).toEqual({
        code: 'let a;',
        lang: 'ts',
      });
    });

    test('LF-only input is returned byte-identical', () => {
      const md = 'a\n```ts\nb\n```\nc\n';
      expect(splitOpenFence(md).closed).toBe(md);
    });
  });

  describe('disclosed blind spots — reported CLOSED while really open', () => {
    // These pin the documented limits in open-fence.ts. They are NOT the
    // desired behaviour: each returns `openTail: null` for markdown whose
    // fence is still open, which is the direction that costs highlighting
    // churn. Pinned so a future container-aware scanner shows up as a
    // deliberate change to these expectations.
    test('a fence inside a blockquote is not recognised', () => {
      expect(splitOpenFence('> ```js\n> const a = 1;\n').openTail).toBeNull();
    });

    test('a fence indented four or more spaces is not recognised', () => {
      expect(
        splitOpenFence('- item\n\n    ```js\n    const a = 1;\n').openTail,
      ).toBeNull();
    });
  });

  test('streaming growth: same block, flush by flush', () => {
    // What the scanner sees across 80ms flushes of one turn.
    const f1 = splitOpenFence('```ts\nconst');
    expect(f1.openTail?.code).toBe('const');
    const f2 = splitOpenFence('```ts\nconst a =');
    expect(f2.openTail?.code).toBe('const a =');
    const f3 = splitOpenFence('```ts\nconst a = 1;\n```');
    expect(f3.openTail).toBeNull();
    expect(f3.closed).toBe('```ts\nconst a = 1;\n```');
  });
});
