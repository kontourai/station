/** @vitest-environment jsdom */

import type {
  AnalyticsSavedView,
  AnalyticsViewDefinition,
} from '@kontourai/station-contracts/analytics-views';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scope: {
    apiBase: 'https://station.example.test',
    authorityKey: 'alice',
    isCurrent: (): boolean => true,
  },
  views: [] as AnalyticsSavedView[],
  mutation: vi.fn(),
  queries: vi.fn(),
}));
const sourceId = '11234567-89ab-4cde-8fab-0123456789ab';
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => state.scope,
}));
vi.mock('@kontourai/station-sdk/private-insights-query', () => ({
  usePrivateInsightsInventory: () => ({
    sources: {
      data: [
        {
          id: sourceId,
          stationId: 'source-a',
          origin: 'https://source-a.example.test',
          ready: true,
          retainedCopy: true,
        },
      ],
      error: null,
      isFetching: false,
    },
    views: { data: state.views, error: null, isFetching: false },
  }),
  useSavedAnalyticsViewMutation: () => ({
    mutateAsync: state.mutation,
    isPending: false,
  }),
  usePrivateInsightsSyncWindow: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  exportSavedAnalyticsView: vi.fn(),
  usePrivateInsightsResult: (
    scope: unknown,
    id: string,
    input: unknown,
    selection: string,
  ) => {
    state.queries(id, input, selection);
    return {
      error: null,
      data: scope
        ? {
            phase: 'ready',
            indexId: 'index',
            validUntil: new Date(Date.now() + 100000).toISOString(),
            receivedAt: new Date().toISOString(),
            retainedCopy: true,
            asOf: { freshness: 'at-captured-source-head' },
            summary: {
              id: 'summary',
              phase: 'ready',
              scanned: 2,
              rows: [
                {
                  key: 'model:one',
                  stationId: 'source-a',
                  provider: 'claude',
                  inputTokens: 0,
                  pricingStatus: 'unpriced',
                  receiptCount: 1,
                  reportedCostBuckets: [
                    { amount: 1, currency: 'USD' },
                    { amount: 2, currency: 'EUR' },
                  ],
                },
                {
                  key: 'model:missing',
                  stationId: 'source-a',
                  provider: 'claude',
                  pricingStatus: 'unpriced',
                  receiptCount: 1,
                },
              ],
            },
            receipts: [],
          }
        : undefined,
      historical: undefined,
    };
  },
}));

vi.mock('./AnalyticsSourceSetup', () => ({ AnalyticsSourceSetup: () => null }));

import { PersonalInsights } from './PersonalInsights';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.views = [];
  state.mutation.mockReset();
  state.queries.mockReset();
  state.scope = {
    apiBase: 'https://station.example.test',
    authorityKey: 'alice',
    isCurrent: (): boolean => true,
  };
});
test('the mounted view saves scoped controls, restores a server definition, and hides results until changed selections are applied', async () => {
  const webCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
    subtle: webCrypto.subtle,
  });
  const definition: AnalyticsViewDefinition = {
    title: 'Cost trend',
    sources: [{ recipientId: sourceId }],
    range: { kind: 'relative', days: 14 },
    groupBy: 'model',
    measure: 'reportedCost',
    timeZone: 'UTC',
  };
  const saved: AnalyticsSavedView = {
    id: '21234567-89ab-4cde-8fab-0123456789ab',
    revision: 1,
    definition,
    updatedAt: new Date().toISOString(),
  };
  state.mutation.mockResolvedValue(saved);
  const view = render(<PersonalInsights />);
  fireEvent.change(screen.getByLabelText('View name'), {
    target: { value: 'Cost trend' },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: /source-a.example.test/ }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  await waitFor(() =>
    expect(state.mutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'create', definition }),
    ),
  );
  await screen.findByText('1 USD · 2 EUR');
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  expect((screen.getByLabelText('Measure') as HTMLSelectElement).value).toBe(
    'reportedCost',
  );
  fireEvent.change(screen.getByLabelText('Group by'), {
    target: { value: 'day' },
  });
  expect(screen.queryByText('1 USD · 2 EUR')).toBeNull();
  expect(
    screen.getByText('Apply the changed selection before displaying results.'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
  await screen.findByText('1 USD · 2 EUR');
  expect(
    state.queries.mock.calls.some(([, input]) => input.groupBy === 'day'),
  ).toBe(true);
  view.unmount();
  state.views = [saved];
  render(<PersonalInsights />);
  await waitFor(() =>
    expect((screen.getByLabelText('View name') as HTMLInputElement).value).toBe(
      'Cost trend',
    ),
  );
  await screen.findByText('1 USD · 2 EUR');
});
test('a changed principal or lost host authority does not retain another scope results', async () => {
  const definition: AnalyticsViewDefinition = {
    title: 'Alice private view',
    sources: [{ recipientId: sourceId }],
    range: { kind: 'relative', days: 7 },
    groupBy: 'model',
    measure: 'reportedCost',
    timeZone: 'UTC',
  };
  state.views = [
    {
      id: '21234567-89ab-4cde-8fab-0123456789ab',
      revision: 1,
      definition,
      updatedAt: new Date().toISOString(),
    },
  ];
  const view = render(<PersonalInsights />);
  await screen.findByText('1 USD · 2 EUR');
  state.scope = { ...state.scope, authorityKey: 'bob' };
  state.views = [];
  view.rerender(<PersonalInsights />);
  expect(screen.queryByText('1 USD · 2 EUR')).toBeNull();
  await waitFor(() =>
    expect((screen.getByLabelText('View name') as HTMLInputElement).value).toBe(
      'Personal usage',
    ),
  );
  state.scope = { ...state.scope, isCurrent: () => false };
  view.rerender(<PersonalInsights />);
  expect(screen.queryByLabelText('View name')).toBeNull();
});

test('measure controls use contract values and keep a reported zero separate from missing measurements', async () => {
  const definition: AnalyticsViewDefinition = {
    title: 'Tokens',
    sources: [{ recipientId: sourceId }],
    range: { kind: 'relative', days: 7 },
    groupBy: 'model',
    measure: 'reportedCost',
    timeZone: 'UTC',
  };
  state.views = [
    {
      id: '21234567-89ab-4cde-8fab-0123456789ab',
      revision: 1,
      definition,
      updatedAt: new Date().toISOString(),
    },
  ];
  render(<PersonalInsights />);
  await screen.findByText('1 USD · 2 EUR');
  fireEvent.change(screen.getByLabelText('Measure'), {
    target: { value: 'inputTokens' },
  });
  expect(screen.queryByText('1 USD · 2 EUR')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
  await screen.findByText('0');
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  expect((screen.getByLabelText('Measure') as HTMLSelectElement).value).toBe(
    'inputTokens',
  );
});
