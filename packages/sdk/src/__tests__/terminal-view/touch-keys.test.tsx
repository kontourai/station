/** @vitest-environment jsdom */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalView } from '../../terminal-view/TerminalView';

/**
 * The key row scrolls when a phone is too narrow for its eight keys, and says
 * so: `data-overflow` names the edge with keys past it, which the stylesheet
 * fades (the geometry suite, `TerminalKeyRow.geometry.test.tsx`, pins that).
 * jsdom has no layout, so the row's scroll box is given one here.
 */
let resized: (() => void)[] = [];

beforeEach(() => {
  resized = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // No engine here: the view renders its chrome around a failed start.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no engine in this test');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function layOut(
  row: HTMLElement,
  box: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  for (const [name, value] of Object.entries(box))
    Object.defineProperty(row, name, { configurable: true, value });
}

test('the key row names the edge that has more keys past it', async () => {
  render(<TerminalView session={null} touchKeys />);
  const row = screen.getByRole('toolbar', { name: 'Terminal keys' });

  layOut(row, { scrollWidth: 382, clientWidth: 382, scrollLeft: 0 });
  act(() => {
    for (const callback of resized) callback();
  });
  expect(row.dataset.overflow).toBe('none');

  layOut(row, { scrollWidth: 388, clientWidth: 312, scrollLeft: 0 });
  act(() => {
    for (const callback of resized) callback();
  });
  expect(row.dataset.overflow).toBe('end');

  layOut(row, { scrollWidth: 388, clientWidth: 312, scrollLeft: 40 });
  act(() => {
    row.dispatchEvent(new Event('scroll'));
  });
  expect(row.dataset.overflow).toBe('both');

  layOut(row, { scrollWidth: 388, clientWidth: 312, scrollLeft: 76 });
  act(() => {
    row.dispatchEvent(new Event('scroll'));
  });
  expect(row.dataset.overflow).toBe('start');
});
