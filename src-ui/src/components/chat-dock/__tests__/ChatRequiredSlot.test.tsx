/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

// Inject the resolver's default-failed result at the actual Chat entry point.
// No Chat hooks execute: a failed required filler must not be mounted.
vi.mock('@kontourai/station-contracts/required-slots', async (original) => {
  const contracts =
    await original<
      typeof import('@kontourai/station-contracts/required-slots')
    >();
  return {
    ...contracts,
    resolveRequiredSlot: (slot: 'home' | 'chat') => ({
      state: 'safe-mode',
      slot,
      defaultFiller: contracts.REQUIRED_SLOT_DEFAULTS[slot],
      safeMode: true,
    }),
  };
});

import { subscribeRequiredSlotFailures } from '../../../workspace-panes/requiredSlotRecovery';
import { ChatWorkspacePane } from '../ChatDock';

test('the actual shared Inbox/Chat caller obeys required-slot failure and publishes the recovery signal', () => {
  const signal = vi.fn();
  const unsubscribe = subscribeRequiredSlotFailures(signal);
  expect(() =>
    render(
      <ChatWorkspacePane
        placement="fullscreen"
        projectSlug="project"
        layoutSlug="coding"
      />,
    ),
  ).not.toThrow();
  expect(screen.getByText('Inbox/Chat is unavailable')).toBeTruthy();
  expect(signal).toHaveBeenCalledOnce();
  unsubscribe();
});
