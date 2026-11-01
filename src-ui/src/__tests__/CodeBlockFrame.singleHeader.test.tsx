/**
 * @vitest-environment jsdom
 *
 * #4393 — after a rotation the dock's reading viewport was briefly ~41px tall,
 * and every code block measured against it repeated its whole header (language
 * and Copy) underneath, so each block showed two "text Copy" bars. Markdown's
 * own <pre> also wrapped the block's frame, nesting <pre> inside <pre>.
 *
 * jsdom has no layout, so the measured heights are explicit inputs here; the
 * real long-block geometry stays with tests/code-block-actions.spec.ts.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../highlight/highlight-client', () => ({
  highlightCode: () => new Promise<string>(() => {}),
}));

import { CodeBlockFrame } from '../components/chat/CodeBlockFrame';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';

let resizeCallbacks: (() => void)[] = [];
let blockHeight = 0;

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const height = this.classList.contains('code-block-body')
        ? blockHeight
        : 0;
      return {
        height,
        width: 300,
        top: 0,
        left: 0,
        bottom: height,
        right: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
  vi.stubGlobal('innerHeight', 1024);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderInViewport(viewportHeight: number, height: number) {
  blockHeight = height;
  const result = render(
    <div className="chat-messages" data-testid="viewport">
      <CodeBlockFrame lang="text" code={'a\nb\nc'} html={null} />
    </div>,
  );
  const viewport = screen.getByTestId('viewport');
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    value: viewportHeight,
  });
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
  return result;
}

describe('code block header after a viewport change', () => {
  test('a squeezed reading viewport does not repeat the header under a short block', () => {
    renderInViewport(41, 200);
    expect(screen.getAllByRole('button', { name: /Copy/ })).toHaveLength(1);
    expect(screen.getAllByText('text')).toHaveLength(1);
  });

  test('a block taller than the page still repeats Copy, without a second language header', () => {
    const { container } = renderInViewport(700, 900);
    expect(screen.getAllByRole('button', { name: /Copy/ })).toHaveLength(2);
    expect(screen.getAllByText('text')).toHaveLength(1);
    expect(
      container.querySelector('.code-block-actions--footer span'),
    ).toBeNull();
  });

  test('a language fence is not nested inside a second <pre>', () => {
    const { container } = render(
      <MarkdownRenderer>
        {'```python\nprint(1)\n```\n\n```\nplain\n```'}
      </MarkdownRenderer>,
    );
    const frame = container.querySelector('.code-block-frame');
    expect(frame).not.toBeNull();
    expect(frame?.closest('pre')).toBeNull();
    expect(container.querySelector('pre pre')).toBeNull();
    // A fence without a language keeps Markdown's plain <pre>.
    expect(
      [...container.querySelectorAll('pre')].map((pre) => pre.textContent),
    ).toEqual(['print(1)', 'plain\n']);
  });
});
