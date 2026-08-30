import { describe, expect, test } from 'vitest';
import {
  boundedToolResultText,
  boundTailFragment,
  fullToolResultText,
  TOOL_RESULT_TAIL_CHARS,
} from '../components/chat/bounded-tool-result';

/**
 * station#330 unit coverage for the properties the rendered-DOM tests cannot
 * see: what the collector ALLOCATES, and what it does at the truncation
 * boundaries. The component test pins the rendered projection; these pin the
 * cost and the edges.
 */
describe('bounded tool result — allocation', () => {
  test('a huge fragment is sliced to the tail budget BEFORE any concatenation', () => {
    // The dominant real shape: file contents / command output arriving as one
    // unescaped string. Concatenating it onto the tail first would materialize
    // the whole payload — the exact allocation this collector exists to avoid.
    // NOTE ON POWER: this pins the helper's contract, NOT its call site.
    // Reverting `append` to `(this.tail + value).slice(-512)` produces
    // byte-identical output, so nothing here would red — only the allocation
    // differs, and ESM makes spying on a same-module call ineffective. The
    // binding is held by review; do not read a green run as proof of it.
    const huge = 'x'.repeat(2_000_000);
    expect(boundTailFragment(huge)).toHaveLength(TOOL_RESULT_TAIL_CHARS);
    expect(boundTailFragment('short')).toBe('short');

    const bounded = boundedToolResultText({ output: huge });
    expect(bounded.truncated).toBe(true);
    expect(bounded.tail.length).toBeLessThanOrEqual(TOOL_RESULT_TAIL_CHARS);
    expect(bounded.head.length + bounded.tail.length).toBeLessThan(4_000);
  });

  test('the head/tail projection stays bounded across many small fragments', () => {
    const many = Array.from({ length: 20_000 }, (_, index) => `row-${index}`);
    const bounded = boundedToolResultText(many);
    expect(bounded.head.length + bounded.tail.length).toBeLessThan(4_000);
    expect(bounded.withheldBytes).toBeGreaterThan(100_000);
  });
});

describe('bounded tool result — boundaries', () => {
  test('does not split a surrogate pair at either boundary', () => {
    const emoji = '\u{1f600}';
    const payload = `${'a'.repeat(2_999)}${emoji}${'b'.repeat(4_000)}${emoji}${'c'.repeat(400)}`;
    const bounded = boundedToolResultText(payload);

    const lastHead = bounded.head.charCodeAt(bounded.head.length - 1);
    const firstTail = bounded.tail.charCodeAt(0);
    expect(lastHead >= 0xd800 && lastHead <= 0xdbff).toBe(false);
    expect(firstTail >= 0xdc00 && firstTail <= 0xdfff).toBe(false);
    expect(`${bounded.head}${bounded.tail}`).not.toContain('�');
  });

  test('withheld bytes stay exact after a boundary trim', () => {
    const payload = `${'a'.repeat(2_999)}\u{1f600}${'b'.repeat(5_000)}`;
    const bounded = boundedToolResultText(payload);
    const total = Buffer.byteLength(payload, 'utf8');
    const retained =
      Buffer.byteLength(bounded.head, 'utf8') +
      Buffer.byteLength(bounded.tail, 'utf8');
    expect(retained + bounded.withheldBytes).toBe(total);
  });
});

describe('full reveal', () => {
  test('falls back to the projection rather than throwing on a cyclic result', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    // Unreachable over the SSE wire today, but the preview tolerates it, so
    // the reveal must not throw where the preview succeeded.
    expect(() => fullToolResultText(cyclic)).not.toThrow();
    expect(fullToolResultText(cyclic)).toContain('loop');
  });
});
