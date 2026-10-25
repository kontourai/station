/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  REQUIRED_SLOT_SAFE_MODE_EVENT,
  RequiredSlotHost,
} from '../RequiredSlotHost';

afterEach(() => vi.restoreAllMocks());

test.each(['home', 'chat'] as const)(
  '%s resolves live availability, override removal and render failure to its default',
  (slot) => {
    const safeMode = vi.fn();
    window.addEventListener(REQUIRED_SLOT_SAFE_MODE_EVENT, safeMode);
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
      window.removeEventListener(REQUIRED_SLOT_SAFE_MODE_EVENT, safeMode);
    }
  },
);

test.each(['home', 'chat'] as const)(
  '%s reports a default render failure without executing it again',
  (slot) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signals: unknown[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) signals.push(event.detail);
    };
    window.addEventListener(REQUIRED_SLOT_SAFE_MODE_EVENT, listener);
    try {
      function BrokenDefault(): never {
        throw new Error('injected default failure');
      }
      const view = render(
        <RequiredSlotHost slot={slot} defaultContent={<BrokenDefault />} />,
      );
      expect(
        screen.getByText(
          'The default surface failed. Station recovery is required.',
        ),
      ).toBeTruthy();
      expect(signals).toEqual([
        { slot, defaultFiller: `builtin:workspace-${slot}` },
      ]);
      act(() =>
        view.rerender(
          <RequiredSlotHost slot={slot} defaultContent={<BrokenDefault />} />,
        ),
      );
      expect(signals).toHaveLength(1);
    } finally {
      window.removeEventListener(REQUIRED_SLOT_SAFE_MODE_EVENT, listener);
    }
  },
);
