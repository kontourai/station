/**
 * @vitest-environment jsdom
 *
 * #2093 — `useHighlightedHtml` keeps the previous highlight up while the next
 * one resolves (no plain-`<pre>` flash per flush) and coalesces bursts: while
 * a highlight is in flight only the latest code is remembered, so
 * intermediate flushes never reach the worker.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const resolvers: Array<(html: string) => void> = [];
const rejecters: Array<(err: Error) => void> = [];
const highlightCode = vi.fn(
  (code: string, lang: string) =>
    new Promise<string>((resolve, reject) => {
      // Language-tagged so a stale answer for a previous language is
      // distinguishable from the current one.
      resolvers.push(() => resolve(`<lang:${lang}>${code}</lang:${lang}>`));
      rejecters.push(reject);
    }),
);

vi.mock('../highlight/highlight-client', () => ({ highlightCode }));

const triggerHaptic = vi.fn();
vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: (...args: unknown[]) => triggerHaptic(...args),
}));

import { markdownCodeComponents } from '../components/chat/HighlightedCodeBlock';

const Code = markdownCodeComponents.code;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // mockClear, NOT restoreAllMocks: restore wipes the vi.mock factory
  // implementation this file depends on across tests.
  highlightCode.mockClear();
  resolvers.length = 0;
  rejecters.length = 0;
});

function bodyHtml(container: HTMLElement): string {
  const body = container.querySelector('.code-block-body');
  if (!body) throw new Error('no code-block body rendered');
  return body.innerHTML;
}

describe('streaming code highlight (#2093)', () => {
  // HighlightedCodeBlock strips one trailing newline before requesting.
  const requested = (code: string) => code.replace(/\n$/, '');

  test('the previous highlight stays up while the next one resolves', async () => {
    const v1 = 'const a = 1;\n';
    const v2 = 'const a = 1;\nconst b = 2;\n';
    const { container, rerender } = render(
      <Code className="language-ts">{v1}</Code>,
    );
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1));
    resolvers.shift()?.('');
    await waitFor(() =>
      expect(bodyHtml(container)).toContain(
        `<lang:ts>${requested(v1)}</lang:ts>`,
      ),
    );

    // Next flush arrives while its highlight is still pending: no plain
    // <pre> flash — the old highlight stays until the replacement lands.
    rerender(<Code className="language-ts">{v2}</Code>);
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(2));
    expect(container.querySelector('.code-block-body pre')).toBeNull();
    expect(bodyHtml(container)).toContain(
      `<lang:ts>${requested(v1)}</lang:ts>`,
    );

    resolvers.shift()?.('');
    await waitFor(() => expect(bodyHtml(container)).toContain(requested(v2)));
  });

  test('a burst costs one in-flight plus one pending request', async () => {
    const v1 = 'const a = 1;\n';
    const v2 = 'const a = 1;\nconst b = 2;\n';
    const v3 = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const { rerender } = render(<Code className="language-ts">{v1}</Code>);
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1));

    // Two flushes land before the first highlight resolves: v2 is superseded
    // while queued and must never reach the worker.
    rerender(<Code className="language-ts">{v2}</Code>);
    rerender(<Code className="language-ts">{v3}</Code>);
    resolvers.shift()?.('');
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(2));
    expect(highlightCode.mock.calls.map((call) => call[0])).toEqual([
      requested(v1),
      requested(v3),
    ]);
  });

  test('a late answer for a previous language never lands on the block', async () => {
    const { container, rerender } = render(
      <Code className="language-ts">{'const a = 1;\n'}</Code>,
    );
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1));

    // The fence label changes while the first highlight is still pending.
    rerender(<Code className="language-js">{'const a = 1;\n'}</Code>);
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(2));
    expect(highlightCode.mock.calls.map((call) => call[1])).toEqual([
      'ts',
      'js',
    ]);

    // The current language answers first, then the retired one lands late:
    // the late answer must be ignored.
    resolvers[1]?.('');
    await waitFor(() =>
      expect(bodyHtml(container)).toContain('<lang:js>const a = 1;</lang:js>'),
    );
    resolvers[0]?.('');
    await waitFor(() =>
      expect(bodyHtml(container)).toContain('<lang:js>const a = 1;</lang:js>'),
    );
    expect(bodyHtml(container)).not.toContain('<lang:ts>');
  });

  test('a rejected highlight falls back to the plain <pre> with current code', async () => {
    const { container, rerender } = render(
      <Code className="language-ts">{'const a = 1;\n'}</Code>,
    );
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1));
    resolvers.shift()?.('');
    await waitFor(() =>
      expect(bodyHtml(container)).toContain('<lang:ts>const a = 1;</lang:ts>'),
    );

    rerender(
      <Code className="language-ts">{'const a = 1;\nconst b = 2;\n'}</Code>,
    );
    await waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(2));
    // Drop the first request's rejecter (already resolved above) and fail the
    // second, still-pending request.
    rejecters.shift();
    rejecters.shift()?.(new Error('worker wedged'));
    await waitFor(() =>
      expect(container.querySelector('.code-block-body pre')).not.toBeNull(),
    );
    expect(bodyHtml(container)).toContain('const b = 2;');
  });
});
