/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useExitTransition } from '../hooks/useExitTransition';

/**
 * station#3309. The dock's inbox panel stays mounted for its exit beat, and
 * the ONE branch that cannot live in CSS is reduced motion: a stylesheet can
 * hide an exiting element, it cannot decline to keep it in the tree. These
 * exercise the hook's real timers against a real `matchMedia`.
 */

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function Probe({ open }: { open: boolean }) {
  const { mounted, exiting } = useExitTransition(open, 200);
  return (
    <div data-testid="probe" data-mounted={mounted} data-exiting={exiting} />
  );
}

function state() {
  const node = document.querySelector('[data-testid="probe"]');
  return {
    mounted: node?.getAttribute('data-mounted'),
    exiting: node?.getAttribute('data-exiting'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useExitTransition', () => {
  test('keeps the surface mounted for the exit budget, then drops it', () => {
    const { rerender } = render(<Probe open={true} />);
    expect(state()).toEqual({ mounted: 'true', exiting: 'false' });

    rerender(<Probe open={false} />);
    expect(state()).toEqual({ mounted: 'true', exiting: 'true' });

    // Still mounted one frame short of the budget — the magnitude matters:
    // an implementation that unmounted immediately would already read false.
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(state().mounted).toBe('true');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(state()).toEqual({ mounted: 'false', exiting: 'false' });
  });

  test('reduced motion unmounts synchronously — no invisible element left behind', () => {
    setReducedMotion(true);
    const { rerender } = render(<Probe open={true} />);

    rerender(<Probe open={false} />);
    // No timer advance at all: the element is gone in the same commit.
    expect(state()).toEqual({ mounted: 'false', exiting: 'false' });
  });

  test('reopening during an exit cancels the pending unmount', () => {
    const { rerender } = render(<Probe open={true} />);
    rerender(<Probe open={false} />);
    expect(state().exiting).toBe('true');

    rerender(<Probe open={true} />);
    expect(state()).toEqual({ mounted: 'true', exiting: 'false' });

    // The cancelled timer must not fire later and unmount a surface the user
    // has since reopened.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(state()).toEqual({ mounted: 'true', exiting: 'false' });
  });

  test('a surface that was never open does not animate an exit on mount', () => {
    render(<Probe open={false} />);
    expect(state()).toEqual({ mounted: 'false', exiting: 'false' });
  });
});
