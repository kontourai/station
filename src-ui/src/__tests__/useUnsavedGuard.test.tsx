/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';

function Harness() {
  const [dirty, setDirty] = useState(true);
  const [tick, setTick] = useState(0);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);

  return (
    <>
      <button type="button" onClick={() => guard(() => undefined)}>
        Trigger Guard
      </button>
      <button type="button" onClick={() => setDirty(false)}>
        Mark Clean
      </button>
      {/* Stands in for any ordinary host re-render — an SSE query
          invalidation, a poll, a parent state change. */}
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        Re-render Host
      </button>
      <span data-testid="tick">{tick}</span>
      <DiscardModal />
    </>
  );
}

function CleanTransitionProbe({ observations }: { observations: boolean[] }) {
  const [dirty, setDirty] = useState(true);
  useUnsavedGuard(dirty);

  useLayoutEffect(() => {
    if (dirty) return;
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    observations.push(beforeUnload.defaultPrevented);
  }, [dirty, observations]);

  return (
    <button type="button" onClick={() => setDirty(false)}>
      Commit clean state
    </button>
  );
}

describe('useUnsavedGuard', () => {
  test('dismisses the discard modal when the form becomes clean', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger Guard' }));
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mark Clean' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('removes the browser guard before clean-state layout effects observe the commit', () => {
    const observations: boolean[] = [];
    render(<CleanTransitionProbe observations={observations} />);

    fireEvent.click(screen.getByRole('button', { name: 'Commit clean state' }));

    expect(observations).toEqual([false]);
  });

  test('does not access browser globals during server rendering', () => {
    expect(() =>
      renderToStaticMarkup(<CleanTransitionProbe observations={[]} />),
    ).not.toThrow();
  });

  test('owns Escape instead of letting the parent view handle the same event', () => {
    const parentEscapeHandler = vi.fn();
    window.addEventListener('keydown', parentEscapeHandler);
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger Guard' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.keyDown(cancel, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parentEscapeHandler).not.toHaveBeenCalled();
    window.removeEventListener('keydown', parentEscapeHandler);
  });

  // Review of archive#1138 found the migration reintroduced archive#1110's defect here, on
  // the one call site CLAUDE.md makes mandatory. `DiscardModal` was declared
  // inline in the hook, so it was a new component TYPE per host render: React
  // remounted the dialog, the unmounting instance's cleanup scheduled an rAF
  // focus restore, and that stale restore then pulled focus to the trigger
  // BEHIND the still-open dialog — after which Escape no longer closed it,
  // because the trap's keydown is panel-scoped.
  //
  // The re-render is not exotic. `useServerEvents` invalidates the query keys
  // backing every one of the six adopting views on ordinary SSE traffic.
  test('a host re-render while the discard dialog is open does not move focus behind it', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Trigger Guard' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Re-render Host' }));
    expect(screen.getByTestId('tick').textContent).toBe('1');

    // The stale restore is scheduled in a requestAnimationFrame by the
    // unmounting instance's cleanup, so it lands AFTER the remounted instance
    // has focused Cancel. Asserting synchronously here reads the intermediate
    // state and passes against the defect — this test was inert until it
    // waited for the frame.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => setTimeout(r, 0));
    });

    const dialog = screen.getByRole('dialog');
    expect(
      dialog.contains(document.activeElement),
      `focus left the dialog for ${(document.activeElement as HTMLElement)?.textContent ?? 'nothing'}`,
    ).toBe(true);

    //.and Escape still closes it from wherever focus actually landed.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
