/** @vitest-environment jsdom */
import type { UsageStats } from '@kontourai/station-contracts/usage-stats';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  current: true,
  data: undefined as { stationId: string; stats: UsageStats } | undefined,
  error: null as Error | null,
}));
vi.mock('@kontourai/station-sdk/station-usage-query', () => ({
  useStationUsageQuery: () => ({
    data: state.data,
    error: state.error,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'local',
    isCurrent: () => state.current,
  }),
}));

import { StationHttpError } from '@kontourai/station-sdk';
import { StationUsagePanel } from './StationUsagePanel';

test('operator breakdown preserves measured zero, unknown attribution, and hides cached usage on lost authority', () => {
  state.current = true;
  state.error = null;
  state.data = {
    stationId: 'local',
    stats: {
      lifetime: {
        totalMessages: 2,
        totalConversations: 1,
        totalInputTokens: 10,
        totalOutputTokens: 0,
        totalCost: 0,
        uniqueAgents: [],
      },
      byAgent: {},
      byDate: {},
      byModel: {},
      byProvider: {
        codex: {
          messages: 1,
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 25,
          cost: 0,
          tokenReports: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
        },
      },
      byPrincipal: {},
      unallocated: {
        date: { messages: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
        model: { messages: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
        principal: { messages: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
        provider: { messages: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
      },
    },
  };
  const view = render(<StationUsagePanel />);
  fireEvent.click(screen.getByRole('button', { name: 'View station usage' }));
  fireEvent.click(screen.getByText('Tokens & costs'));
  const provider = screen.getByRole('row', { name: /^codex/ });
  expect(
    within(provider)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['1', '10', '0', '25', '—', '—', '—']);
  expect(
    screen.getByRole('row', { name: /^Unknown \/ unallocated/ }).textContent,
  ).toContain('——');
  fireEvent.change(screen.getByRole('combobox', { name: 'Breakdown' }), {
    target: { value: 'principal' },
  });
  expect(
    within(
      screen.getByRole('list', { name: 'Recorded activity breakdown' }),
    ).getByText('Unknown / unallocated'),
  ).toBeTruthy();
  state.error = new StationHttpError(403, 'denied');
  view.rerender(<StationUsagePanel />);
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText('Conversations')).toBeNull();
  expect(
    screen.queryByRole('list', { name: 'Recorded activity breakdown' }),
  ).toBeNull();
  expect(screen.getByText(/Local operator access is required/)).toBeTruthy();
  state.error = null;
  state.current = false;
  view.rerender(<StationUsagePanel />);
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText('Conversations')).toBeNull();
  expect(
    screen.queryByRole('list', { name: 'Recorded activity breakdown' }),
  ).toBeNull();
  view.unmount();
  state.current = true;
  state.data = undefined;
});
