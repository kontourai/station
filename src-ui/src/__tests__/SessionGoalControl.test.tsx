/** @vitest-environment jsdom */
import type { SessionGoalRead } from '@kontourai/station-contracts/session-goal';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  enabled: true,
  authority: 'owner',
  mutate: vi.fn(),
  refetch: vi.fn(),
  query: {
    data: undefined as SessionGoalRead | undefined,
    isFetching: false,
    isPending: false,
    error: null as Error | null,
  },
  mutationPending: false,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: fixtures.authority,
  }),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(fixtures.enabled ? ['session-goals'] : []),
}));
vi.mock('@kontourai/station-sdk/session-goals', () => ({
  useSessionGoalQuery: () => ({ ...fixtures.query, refetch: fixtures.refetch }),
  useSessionGoalMutation: () => ({
    mutateAsync: fixtures.mutate,
    isPending: fixtures.mutationPending,
  }),
}));

import { SessionGoalControl } from '../components/chat/SessionGoalControl';

const available: SessionGoalRead = {
  state: 'available',
  capability: {
    implementation: 'engine',
    operations: ['read', 'set', 'pause', 'clear'],
    maxObjectiveChars: 4000,
    tokenBudget: 'enforced-by-implementation',
    completion: 'implementation-reported',
    saveState: 'paused',
  },
  goal: {
    objective: 'Finish the migration',
    status: 'paused',
    tokenBudget: 40000,
    tokensUsed: 120,
    timeUsedSeconds: 7,
  },
};

beforeEach(() => {
  fixtures.enabled = true;
  fixtures.authority = 'owner';
  fixtures.mutationPending = false;
  fixtures.query = {
    data: available,
    isFetching: false,
    isPending: false,
    error: null,
  };
  fixtures.mutate.mockReset();
  fixtures.refetch.mockReset();
});
afterEach(() => vi.clearAllMocks());

test('the preview gate removes all goal controls', () => {
  fixtures.enabled = false;
  render(<SessionGoalControl sessionId="session" />);
  expect(screen.queryByRole('region', { name: 'Session goal' })).toBeNull();
  expect(fixtures.mutate).not.toHaveBeenCalled();
});

test('editing uses the shared typed operation and saves paused without a resume action', async () => {
  fixtures.mutate.mockResolvedValue({ state: 'applied', goal: available.goal });
  render(<SessionGoalControl sessionId="session" />);
  expect(screen.getByText(/120 tokens used/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
  fireEvent.change(screen.getByLabelText('Objective'), {
    target: { value: 'Keep the context useful' },
  });
  fireEvent.change(screen.getByLabelText('Token budget (optional)'), {
    target: { value: '2500' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save paused goal' }));
  await waitFor(() =>
    expect(fixtures.mutate).toHaveBeenCalledExactlyOnceWith({
      operation: 'set',
      objective: 'Keep the context useful',
      tokenBudget: 2500,
    }),
  );
  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent',
    'Goal updated.',
  );
});

test('an uncertain mutation stays visible without retrying', async () => {
  fixtures.mutate.mockResolvedValue({ state: 'indeterminate' });
  render(<SessionGoalControl sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
  expect(await screen.findByRole('status')).toHaveProperty(
    'textContent',
    'The outcome is unconfirmed. Refresh and inspect before trying again.',
  );
  expect(fixtures.mutate).toHaveBeenCalledTimes(1);
});

test('an authority change retires the captured edit draft', () => {
  const view = render(<SessionGoalControl sessionId="session" />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
  fireEvent.change(screen.getByLabelText('Objective'), {
    target: { value: 'Private unsent draft' },
  });
  fixtures.authority = 'different-owner';
  view.rerender(<SessionGoalControl sessionId="session" />);
  expect(screen.queryByDisplayValue('Private unsent draft')).toBeNull();
  expect(fixtures.mutate).not.toHaveBeenCalled();
});

test('loading and refused observations do not leave actionable stale goal controls', () => {
  fixtures.query = {
    data: undefined,
    isFetching: true,
    isPending: false,
    error: null,
  };
  const view = render(<SessionGoalControl sessionId="session" />);
  expect(screen.queryByRole('button', { name: 'Edit goal' })).toBeNull();
  fixtures.query = {
    data: { state: 'unsupported' },
    isFetching: false,
    isPending: false,
    error: null,
  };
  view.rerender(<SessionGoalControl sessionId="session" />);
  expect(
    screen.getByText('Session goals are not available here.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear goal' })).toBeNull();
});
