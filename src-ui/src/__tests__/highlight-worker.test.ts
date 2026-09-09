// @vitest-environment jsdom

/**
 * The chat highlight worker, driven through its real message handler with a
 * real Shiki highlighter — no mocked tokenizer, because the property under
 * test is that tokenization still happens after the engine changed.
 *
 * The worker used to build its highlighter from the `shiki` root entry, which
 * defaults to the Oniguruma WebAssembly engine and so downloaded a 622 KB
 * (230 KB gzipped) wasm module before the first code block could be styled.
 * It now builds on `shiki/core` with the JavaScript RegExp engine that is
 * already in this bundle. Both halves are asserted: that the JS engine is what
 * the highlighter was constructed with, and that what comes back out is real
 * tokenization rather than escaped plain text.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { createJavaScriptRegexEngineSpy } = vi.hoisted(() => ({
  createJavaScriptRegexEngineSpy: vi.fn(),
}));

vi.mock('shiki/engine/javascript', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('shiki/engine/javascript')>();
  return {
    ...actual,
    createJavaScriptRegexEngine: (...args: unknown[]) => {
      createJavaScriptRegexEngineSpy(...args);
      return (
        actual.createJavaScriptRegexEngine as (...a: unknown[]) => unknown
      )(...args);
    },
  };
});

type WorkerResponse = { id: number; html?: string; error?: string };

async function loadWorker() {
  const posted: WorkerResponse[] = [];
  let handler: ((event: MessageEvent) => void) | undefined;
  vi.stubGlobal('self', {
    addEventListener: (_type: string, next: (event: MessageEvent) => void) => {
      handler = next;
    },
    postMessage: (message: WorkerResponse) => {
      posted.push(message);
    },
  });
  vi.resetModules();
  await import('../highlight/highlight-worker');
  if (!handler) throw new Error('the worker registered no message handler');
  const send = async (request: { id: number; code: string; lang: string }) => {
    handler?.({ data: request } as MessageEvent);
    await vi.waitFor(() =>
      expect(posted.some((message) => message.id === request.id)).toBe(true),
    );
    return posted.find(
      (message) => message.id === request.id,
    ) as WorkerResponse;
  };
  return { send };
}

describe('chat highlight worker', () => {
  beforeEach(() => {
    createJavaScriptRegexEngineSpy.mockClear();
  });

  test('tokenizes a TypeScript snippet on the JavaScript regex engine', async () => {
    const { send } = await loadWorker();

    const response = await send({
      id: 1,
      code: 'const answer: number = 42;',
      lang: 'typescript',
    });

    expect(response.error).toBeUndefined();
    expect(createJavaScriptRegexEngineSpy).toHaveBeenCalledWith({
      forgiving: true,
    });
    // Real tokenization, not the escaped-source fallback: `const` and the
    // numeric literal carry distinct colours from Shiki's theme.
    const html = response.html ?? '';
    expect(html).toContain('shiki');
    const constColour = html.match(
      /<span style="color:(#[0-9A-Fa-f]{6})">\s*const\b/,
    )?.[1];
    const numberColour = html.match(
      /<span style="color:(#[0-9A-Fa-f]{6})">\s*42\b/,
    )?.[1];
    expect(constColour).toBeTruthy();
    expect(numberColour).toBeTruthy();
    expect(constColour).not.toBe(numberColour);
  }, 30_000);

  test('loads a language outside the preload list on demand', async () => {
    const { send } = await loadWorker();

    const response = await send({
      id: 2,
      code: 'puts "hello"',
      lang: 'ruby',
    });

    expect(response.error).toBeUndefined();
    expect(response.html ?? '').toMatch(/<span style="color:#[0-9A-Fa-f]{6}">/);
  }, 30_000);

  test('falls back to plain text for a fence label that names no language', async () => {
    const { send } = await loadWorker();

    const response = await send({
      id: 3,
      code: 'not really code',
      lang: 'definitely-not-a-language',
    });

    expect(response.error).toBeUndefined();
    expect(response.html ?? '').toContain('not really code');
  }, 30_000);
});
