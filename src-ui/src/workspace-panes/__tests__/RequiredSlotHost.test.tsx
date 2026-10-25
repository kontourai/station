/** @vitest-environment jsdom */
import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RequiredSlotHost } from '../RequiredSlotHost';
import { subscribeRequiredSlotFailures } from '../requiredSlotRecovery';
import { WorkspacePaneFrame } from '../WorkspacePaneFrame';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each(['home', 'chat'] as const)(
  '%s resolves live availability, override removal and render failure to its default',
  (slot) => {
    const safeMode = vi.fn();
    const unsubscribe = subscribeRequiredSlotFailures(safeMode);
    try {
      const props = {
        slot,
        defaultContent: <p>Default surface</p>,
        override: {
          id: 'replacement:1',
          available: true,
          content: <p>Replacement surface</p>,
        },
      };
      const view = render(<RequiredSlotHost {...props} />);
      expect(screen.getByText('Replacement surface')).toBeTruthy();
      view.rerender(
        <RequiredSlotHost
          {...props}
          override={{ ...props.override, available: false }}
        />,
      );
      expect(screen.getByText('Default surface')).toBeTruthy();
      expect(screen.queryByText('Replacement surface')).toBeNull();
      view.rerender(<RequiredSlotHost {...props} />);
      expect(screen.getByText('Replacement surface')).toBeTruthy();
      view.rerender(<RequiredSlotHost {...props} override={undefined} />);
      expect(screen.getByText('Default surface')).toBeTruthy();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      function Broken(): never {
        throw new Error('injected override failure');
      }
      view.rerender(
        <RequiredSlotHost
          {...props}
          override={{ ...props.override, content: <Broken /> }}
        />,
      );
      expect(screen.getByText('Default surface')).toBeTruthy();
      expect(safeMode).not.toHaveBeenCalled();
      // A new installation/consent identity recovers instead of caching the failure.
      view.rerender(
        <RequiredSlotHost
          {...props}
          override={{ ...props.override, id: 'replacement:2' }}
        />,
      );
      expect(screen.getByText('Replacement surface')).toBeTruthy();
    } finally {
      unsubscribe();
    }
  },
);

test.each(['home', 'chat'] as const)(
  '%s reports load failure without mounting the default',
  (slot) => {
    const signal = vi.fn();
    const unsubscribe = subscribeRequiredSlotFailures(signal);
    try {
      function UnavailableDefault(): never {
        throw new Error('must not mount an unavailable default');
      }
      const view = render(
        <RequiredSlotHost
          slot={slot}
          defaultAvailable={false}
          defaultContent={<UnavailableDefault />}
        />,
      );
      expect(
        screen.getByText(
          `The built-in ${slot === 'home' ? 'Home' : 'Inbox/Chat'} surface could not be loaded.`,
        ),
      ).toBeTruthy();
      expect(signal).toHaveBeenCalledExactlyOnceWith({
        slot,
        defaultFiller: `builtin:workspace-${slot}`,
        reason: 'unavailable',
      });
      // This renderer notification cannot be forged through the removed window event.
      window.dispatchEvent(
        new CustomEvent('station:required-slot-safe-mode', {
          detail: { slot },
        }),
      );
      expect(signal).toHaveBeenCalledTimes(1);
      view.rerender(
        <RequiredSlotHost
          slot={slot}
          defaultContent={<p>Default restored</p>}
        />,
      );
      expect(screen.getByText('Default restored')).toBeTruthy();
    } finally {
      unsubscribe();
    }
  },
);

test.each(['passive effect', 'layout effect', 'first update'] as const)(
  'three %s crashes reach the diagnostic through a real frame',
  async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signal = vi.fn();
    const unsubscribe = subscribeRequiredSlotFailures(signal);
    function Broken() {
      const [updated, setUpdated] = useState(false);
      useLayoutEffect(() => {
        if (phase === 'layout effect') throw new Error(phase);
      }, []);
      useEffect(() => {
        if (phase === 'passive effect') throw new Error(phase);
        if (phase === 'first update') setUpdated(true);
      }, []);
      if (updated) throw new Error(phase);
      return <p>First commit</p>;
    }
    try {
      render(
        <WorkspacePaneFrame
          instanceId={'home' as WorkspacePaneInstanceId}
          paneName="Home"
          readFailureContext={() => ({
            back: { label: 'Close Home', onBack: () => undefined },
          })}
        >
          <RequiredSlotHost slot="home" defaultContent={<Broken />} />
        </WorkspacePaneFrame>,
      );
      expect(
        screen.getByRole('region', { name: 'Home unavailable' }),
      ).toBeTruthy();
      expect(signal).not.toHaveBeenCalled();
      // A cancelled health timer must not erase a catch while the frame shows failure.
      act(() => vi.advanceTimersByTime(2_000));
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
      expect(signal).not.toHaveBeenCalled();
      // Close also remounts in this frame; count catches rather than claiming explicit retries.
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Close Home' })),
      );
      expect(signal).toHaveBeenCalledExactlyOnceWith({
        slot: 'home',
        defaultFiller: 'builtin:workspace-home',
        reason: 'repeated-render-failure',
      });
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
      expect(signal).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  },
);

test.each([999, 1000])(
  'a mounted default resets catches only after surviving one second (%i ms)',
  async (healthyMs) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signal = vi.fn();
    const unsubscribe = subscribeRequiredSlotFailures(signal);
    let broken = true;
    function Surface() {
      const [failed, setFailed] = useState(false);
      if (broken || failed) throw new Error('early update failure');
      return (
        <button type="button" onClick={() => setFailed(true)}>
          Fail after commit
        </button>
      );
    }
    try {
      render(
        <WorkspacePaneFrame
          instanceId={'home' as WorkspacePaneInstanceId}
          paneName="Home"
        >
          <RequiredSlotHost slot="home" defaultContent={<Surface />} />
        </WorkspacePaneFrame>,
      );
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
      expect(signal).not.toHaveBeenCalled();
      broken = false;
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
      act(() => vi.advanceTimersByTime(healthyMs));
      fireEvent.click(
        screen.getByRole('button', { name: 'Fail after commit' }),
      );
      expect(signal).toHaveBeenCalledTimes(healthyMs < 1000 ? 1 : 0);
      if (healthyMs === 1000) {
        broken = true;
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
        );
        expect(signal).not.toHaveBeenCalled();
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
        );
        expect(signal).toHaveBeenCalledTimes(1);
      }
    } finally {
      unsubscribe();
    }
  },
);
