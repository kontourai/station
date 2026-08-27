/**
 * @vitest-environment jsdom
 *
 * station#3354 — `highlightCode` itself: the client LRU, and the
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

vi.mock('../contexts/SyntaxHighlighterContext', () => ({
  initShiki: async () => ({ getLoadedLanguages, codeToHtml }),
}));

import {
  highlightCacheSize,
  highlightCode,
} from '../highlight/highlight-client';

beforeAll(() => {
  // jsdom ships no Worker; pin that so the main-thread branch is the one
  // under test rather than an environment coincidence.
  vi.stubGlobal('Worker', undefined);
  expect(typeof Worker).toBe('undefined');
});

describe('highlightCode (station#3354)', () => {
  test('tokenizes through the main-thread fallback and caches the result', async () => {
    const before = highlightCacheSize();
    const first = await highlightCode('const cached = 1;', 'ts');
    expect(first).toBe('<pre data-lang="ts">const cached = 1;</pre>');
    expect(highlightCacheSize()).toBe(before + 1);

    const calls = codeToHtml.mock.calls.length;
    const second = await highlightCode('const cached = 1;', 'ts');
    expect(second).toBe(first);
    // Served from the LRU — the highlighter was not asked a second time.
    expect(codeToHtml.mock.calls.length).toBe(calls);
    expect(highlightCacheSize()).toBe(before + 1);
  });

  test('the key is content-addressed, so different code is a different entry', async () => {
    const before = highlightCacheSize();
    await highlightCode('let distinct = 1;', 'ts');
    await highlightCode('let distinct = 2;', 'ts');
    expect(highlightCacheSize()).toBe(before + 2);
    // …and the same code under a different language is its own entry too.
    await highlightCode('let distinct = 1;', 'js');
    expect(highlightCacheSize()).toBe(before + 3);
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
