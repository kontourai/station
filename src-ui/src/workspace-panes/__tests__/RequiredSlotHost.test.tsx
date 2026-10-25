/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RequiredSlotHost } from '../RequiredSlotHost';
import { subscribeRequiredSlotFailures } from '../requiredSlotRecovery';

afterEach(() => vi.restoreAllMocks());

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
  '%s reports load or selection refusal without mounting the default',
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
          'The default surface failed. Station recovery is required.',
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
