/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  EphemeralMessage,
  MarkdownLoadingProjection,
} from '../components/chat/EphemeralMessage';

// The HTML branch renders through a code-split sanitizer so DOMPurify stays out
// of the first-paint bundle. These pin what the split must preserve: the markup
// still arrives, and it still arrives sanitized.
describe('EphemeralMessage html content', () => {
  test('renders sanitized host HTML once the split sanitizer resolves', async () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'stats',
          content: '<div><strong>Tokens</strong>: 42</div>',
          contentType: 'html',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText('Tokens')).toBeTruthy();
    expect(document.querySelector('strong')?.textContent).toBe('Tokens');
  });

  test('strips script content from host HTML', async () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'hostile',
          content: '<p>safe</p><script>window.__pwned = true;</script>',
          contentType: 'html',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText('safe')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('MarkdownLoadingProjection', () => {
  test('scans an unterminated inline-link label once with a grammar-capped deque', () => {
    const source = '['.repeat(50_000);
    let inspectedCodePoints = 0;
    const stringIterator = String.prototype[Symbol.iterator];
    const iteratorSpy = vi
      .spyOn(String.prototype, Symbol.iterator)
      .mockImplementation(function (this: string) {
        const iterator = stringIterator.call(this);
        if (this.valueOf() !== source) return iterator;

        const inspectedIterator = {
          next() {
            const next = iterator.next();
            if (!next.done) inspectedCodePoints += 1;
            return next;
          },
          [Symbol.iterator]() {
            return this;
          },
          [Symbol.dispose]() {},
        };
        return inspectedIterator as ReturnType<typeof stringIterator>;
      });

    try {
      expect(MarkdownLoadingProjection({ source })).toBe(source);
    } finally {
      iteratorSpy.mockRestore();
    }
    expect(inspectedCodePoints).toBe(50_000);
  });

  test('falls back to a safe nested link after an overlong unmatched target', () => {
    const source = `[outer](${'a'.repeat(500)}[safe](https://example.com)`;
    render(<MarkdownLoadingProjection source={source} />);

    expect(
      screen.getByRole('link', { name: 'safe' }).getAttribute('href'),
    ).toBe('https://example.com/');
  });

  test('retains a safe link through arbitrary nested target overflows', () => {
    const source = `[outer](${'a'.repeat(500)}[middle](${'b'.repeat(500)}[safe](https://example.com)`;
    render(<MarkdownLoadingProjection source={source} />);

    expect(
      screen.getByRole('link', { name: 'safe' }).getAttribute('href'),
    ).toBe('https://example.com/');
  });

  test('bounds many nested candidates without losing the final safe link', () => {
    const source = `[outer](${Array.from(
      { length: 80 },
      () => `[candidate](${'x'.repeat(513)}`,
    ).join('')}[safe](https://example.com)`;
    render(<MarkdownLoadingProjection source={source} />);

    expect(
      screen.getByRole('link', { name: 'safe' }).getAttribute('href'),
    ).toBe('https://example.com/');
  });

  test('keeps the original bounded grammar and leftmost unsafe consumption', () => {
    const source =
      '[outer](javascript:[safe](https://example.com)) [label😀)](https://example.com/a]b)';
    render(<MarkdownLoadingProjection source={source} />);

    expect(screen.queryByRole('link', { name: 'safe' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'label😀)' }).getAttribute('href'),
    ).toBe('https://example.com/a]b');
  });

  test('keeps literal unmatched and unsafe Markdown source while projecting safe links', () => {
    const source =
      'prefix [unfinished and [unsafe](javascript:alert(1)) then [safe](https://example.com/docs)';
    render(<MarkdownLoadingProjection source={source} />);

    expect(
      screen.getByRole('link', { name: 'safe' }).getAttribute('href'),
    ).toBe('https://example.com/docs');
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
    expect(screen.getByText(/prefix \[unfinished and \[unsafe\]/)).toBeTruthy();
  });
});

describe('EphemeralMessage controls', () => {
  test('keeps a safe Markdown web link actionable while the renderer loads', () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'oauth',
          content:
            'Sign in: [Open authentication page](https://example.com/oauth)',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('link', { name: 'Open authentication page' })
        .getAttribute('href'),
    ).toBe('https://example.com/oauth');
  });

  test('does not make a non-web Markdown target actionable while the renderer loads', () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'unsafe-link',
          content: '[Do not open](javascript:alert(1))',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
  });

  test('dismiss and message actions are named non-submit buttons that preserve their callbacks', () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    render(
      <EphemeralMessage
        msg={{
          id: 'actionable',
          content: 'Connection failed',
          action: { label: 'Retry', handler: vi.fn() },
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={onDismiss}
        onAction={onAction}
      />,
    );

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    const action = screen.getByRole('button', { name: 'Retry' });
    expect(dismiss.getAttribute('type')).toBe('button');
    expect(action.getAttribute('type')).toBe('button');

    fireEvent.click(dismiss);
    fireEvent.click(action);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledOnce();
  });
});
