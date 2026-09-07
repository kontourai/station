// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { createHighlighter } = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
}));
vi.mock('shiki', () => ({ createHighlighter }));
beforeEach(() => {
  vi.resetModules();
  createHighlighter.mockReset();
});
afterEach(cleanup);
const instance = {
  getLoadedLanguages: () => ['typescript'],
  codeToHtml: () => '<pre>highlighted</pre>',
};

test('keeps Home idle and initializes only for a real consumer, then publishes readiness', async () => {
  const { SyntaxHighlighterProvider, useSyntaxHighlighter } = await import(
    '../contexts/SyntaxHighlighterContext'
  );
  let finish!: (value: typeof instance) => void;
  createHighlighter.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  function Consumer() {
    const highlighter = useSyntaxHighlighter();
    return (
      <div
        data-testid="code"
        data-ready={highlighter.ready}
        dangerouslySetInnerHTML={{
          __html: highlighter.highlight('<unsafe>', 'typescript'),
        }}
      />
    );
  }
  const { rerender } = render(
    <SyntaxHighlighterProvider>
      <p>Home</p>
    </SyntaxHighlighterProvider>,
  );
  await act(async () => {});
  expect(createHighlighter).not.toHaveBeenCalled();
  rerender(
    <SyntaxHighlighterProvider>
      <Consumer />
    </SyntaxHighlighterProvider>,
  );
  await act(async () => {});
  expect(createHighlighter).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('code').textContent).toBe('<unsafe>');
  expect(screen.getByTestId('code').getAttribute('data-ready')).toBe('false');
  await act(async () => {
    finish(instance);
  });
  expect(screen.getByTestId('code').getAttribute('data-ready')).toBe('true');
  expect(screen.getByText('highlighted')).toBeTruthy();
});

test('rejects all concurrent waiters on failure and allows a later initialization retry', async () => {
  const { initShiki } = await import('../contexts/SyntaxHighlighterContext');
  createHighlighter
    .mockRejectedValueOnce(new Error('load failed'))
    .mockResolvedValueOnce(instance);
  const results = await Promise.allSettled([initShiki(), initShiki()]);
  expect(results.map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ]);
  expect(createHighlighter).toHaveBeenCalledTimes(1);
  await expect(initShiki()).resolves.toBe(instance);
  expect(createHighlighter).toHaveBeenCalledTimes(2);
});
