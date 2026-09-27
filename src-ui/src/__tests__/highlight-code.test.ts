/**
 * @vitest-environment jsdom
 *
 * archive#3354 — `highlightCode` itself: the client LRU, and the
 * main-thread fallback `createClient` selects when `Worker` is unavailable.
 * The behavioural test (chat-highlight-3354.test.tsx) mocks this module
 * wholesale, so without this file nothing executed the cache, the language
 * resolution, or the escaped-HTML fallback at all.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';

const getLoadedLanguages = vi.fn(() => ['ts', 'js']);
const codeToHtml = vi.fn((code: string, opts: { lang: string }) => {
  if (code.includes('THROW')) throw new Error('shiki blew up');
  return `<pre data-lang="${opts.lang}">${code}</pre>`;
});

// Every LRU miss runs the main-thread highlighter, which awaits `initShiki`
// first; a hit resolves from the cache without it. `codeToHtml` alone cannot
// tell the two apart, because the incremental session store beneath the
// highlighter also serves a repeat of the same code.
const initShiki = vi.fn(async () => ({ getLoadedLanguages, codeToHtml }));
vi.mock('../contexts/SyntaxHighlighterContext', () => ({
  initShiki: () => initShiki(),
}));

import { highlightCode } from '../highlight/highlight-client';

beforeAll(() => {
  // jsdom ships no Worker; pin that so the main-thread branch is the one
  // under test rather than an environment coincidence.
  vi.stubGlobal('Worker', undefined);
  expect(typeof Worker).toBe('undefined');
});

describe('highlightCode (station#3354)', () => {
  test('tokenizes through the main-thread fallback and caches the result', async () => {
    const first = await highlightCode('const cached = 1;', 'ts');
    expect(first).toBe('<pre data-lang="ts">const cached = 1;</pre>');

    const misses = initShiki.mock.calls.length;
    const second = await highlightCode('const cached = 1;', 'ts');
    expect(second).toBe(first);
    // Served from the LRU — the highlighter was not asked a second time.
    expect(initShiki.mock.calls.length).toBe(misses);
  });

  test('the key is content-addressed, so different code is a different entry', async () => {
    const inputs = [
      ['let distinct = 1;', 'ts'],
      ['let distinct = 2;', 'ts'],
      // …and the same code under a different language is its own entry too.
      ['let distinct = 1;', 'js'],
    ] as const;
    const start = initShiki.mock.calls.length;
    const expected = inputs.map(
      ([code, lang]) => `<pre data-lang="${lang}">${code}</pre>`,
    );
    for (const round of [1, 2]) {
      const results = [];
      for (const [code, lang] of inputs) {
        results.push(await highlightCode(code, lang));
      }
      expect(results, `round ${round}`).toEqual(expected);
      // Each input missed once and was highlighted; the second round hits.
      expect(initShiki.mock.calls.length, `round ${round}`).toBe(start + 3);
    }
  });

  test('an unloaded language resolves to text rather than failing', async () => {
    const html = await highlightCode('SELECT 1', 'brainfuck');
    expect(html).toBe('<pre data-lang="text">SELECT 1</pre>');
  });

  test('a highlighter throw degrades to escaped HTML, not raw markup', async () => {
    const html = await highlightCode('THROW <script>x</script>', 'ts');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
