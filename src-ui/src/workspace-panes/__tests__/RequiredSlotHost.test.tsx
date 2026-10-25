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
  '%s reports selection refusal without mounting the default',
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
          defaultFailureReason="selection-refused"
          defaultContent={<UnavailableDefault />}
        />,
      );
      expect(
        screen.getByText(
          `${slot === 'home' ? 'Home' : 'Inbox/Chat'}’s layout needs a renderer this version doesn’t include. Choose ${slot === 'home' ? 'Close Home to leave Home' : 'Close this chat to open an empty Chat'}.`,
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
    let conversation: string | null = 'conversation-crash';
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
      return <p>{conversation ?? 'Empty Chat'}</p>;
    }
    try {
      render(
        <WorkspacePaneFrame
          instanceId={'chat' as WorkspacePaneInstanceId}
          paneName="Chat"
          readFailureContext={() => ({
            back: {
              label: 'Close this chat',
              onBack: () => {
                conversation = null;
              },
            },
          })}
        >
          <RequiredSlotHost slot="chat" defaultContent={<Broken />} />
        </WorkspacePaneFrame>,
      );
      expect(
        screen.getByRole('region', { name: 'Chat unavailable' }),
      ).toBeTruthy();
      expect(signal).not.toHaveBeenCalled();
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
      expect(signal).not.toHaveBeenCalled();
      // Chat’s Close clears the conversation, then remounts the empty Chat.
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: 'Close this chat' }),
        ),
      );
      expect(conversation).toBeNull();
      expect(signal).toHaveBeenCalledExactlyOnceWith({
        slot: 'chat',
        defaultFiller: 'builtin:workspace-chat',
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

test('three crashes more than one second after each mount still diagnose once', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const signal = vi.fn();
  const unsubscribe = subscribeRequiredSlotFailures(signal);
  function Surface() {
    const [failed, setFailed] = useState(false);
    if (failed) throw new Error('data arrived after one second');
    return (
      <button type="button" onClick={() => setFailed(true)}>
        Deliver failing data
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
    for (let catchCount = 1; catchCount <= 4; catchCount++) {
      act(() => vi.advanceTimersByTime(1_100));
      // Deliver data after act has flushed the timer advance, so an old health timer can run first.
      fireEvent.click(
        screen.getByRole('button', { name: 'Deliver failing data' }),
      );
      expect(
        screen.getByRole('region', { name: 'Home unavailable' }),
      ).toBeTruthy();
      expect(signal).toHaveBeenCalledTimes(catchCount < 3 ? 0 : 1);
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
      );
    }
    expect(signal).toHaveBeenCalledExactlyOnceWith({
      slot: 'home',
      defaultFiller: 'builtin:workspace-home',
      reason: 'repeated-render-failure',
    });
  } finally {
    unsubscribe();
  }
});
