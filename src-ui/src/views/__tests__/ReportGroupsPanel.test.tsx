/** @vitest-environment jsdom */
import type { ReportGroupView } from '@kontourai/station-contracts/report-group';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReportGroupsPanel } from '../ReportGroupsPanel';

const group: ReportGroupView = {
  version: 'station.report-group/v1',
  groupId: 'group-a',
  operationId: 'operator-report',
  revision: 4,
  topology: { kind: 'independent-advisory' },
  execution: 'returned',
  cancellation: 'pending',
  authorityRevoked: true,
  acceptance: 'unassessed',
  members: [
    {
      seatId: 'reviewer',
      agentId: 'review-agent',
      taskId: 'task-one',
      clientTurnId: 'turn-one',
      requestedModelId: 'configured-model',
      attempts: [
        {
          invocationId: 'invocation-one',
          observation: {
            id: 'observation',
            domain: 'station.report',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          terminal: null,
          allocation: { inputTokens: 10, outputTokens: 5, costMicros: 100 },
          usage: null,
          accountingTerminal: false,
        },
      ],
    },
  ],
};
const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'content-type': 'application/json' },
  });
const resultPage = (text: string, afterOffset: number, hasMore: boolean) => ({
  kind: 'result',
  groupId: group.groupId,
  seatId: 'reviewer',
  invocationId: 'invocation-one',
  text,
  modelId: 'reported-model',
  afterOffset,
  nextOffset: afterOffset + text.length,
  hasMore,
  usage: { inputTokens: 4, outputTokens: 2, costMicros: 42 },
});

function mount() {
  let current = true;
  const scope = {
    apiBase: 'https://report-ui.test',
    authorityKey: 'operator-one',
    isCurrent: () => current,
  };
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    credential: 'controlled-credential',
    requestAuthority: scope,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={client}>
      <ReportGroupsPanel scope={scope} />
    </QueryClientProvider>
  );
  const view = render(element());
  return {
    ...view,
    client,
    revoke() {
      current = false;
      view.rerender(element());
    },
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test('operator reads paginated reports through scoped SDK queries without promoting unknown accounting or executing work', async () => {
  const requests: string[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const target = new URL(String(url));
      requests.push(target.pathname + target.search);
      if (target.pathname.endsWith('/results/invocation-one'))
        return envelope(
          target.searchParams.get('afterOffset') === '0'
            ? resultPage('\ud83d', 0, true)
            : resultPage('\ude80<script>untrusted</script>', 1, false),
        );
      return envelope({
        groups: target.searchParams.has('afterGroupId') ? [] : [group],
        hasMore: !target.searchParams.has('afterGroupId'),
        nextGroupId: target.searchParams.has('afterGroupId')
          ? null
          : group.groupId,
      });
    },
  );
  vi.stubGlobal('fetch', fetch);
  const view = mount();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
  await screen.findByText('operator-report');
  expect(
    screen.getByText(/Accounting unresolved; reservation retained/),
  ).toBeTruthy();
  expect(screen.getByText(/Termination unconfirmed/)).toBeTruthy();
  expect(screen.queryByText(/untrusted/)).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Read report for reviewer' }),
  );
  expect(await screen.findByText('🚀<script>untrusted</script>')).toBeTruthy();
  expect(view.container.querySelector('script')).toBeNull();
  expect(screen.getByText(/Reported model: reported-model/)).toBeTruthy();
  expect(requests.filter((path) => path.includes('/results/'))).toEqual([
    '/api/orchestration/report-groups/group-a/members/reviewer/results/invocation-one?afterOffset=0',
    '/api/orchestration/report-groups/group-a/members/reviewer/results/invocation-one?afterOffset=1',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Next report groups' }));
  await screen.findByText('No retained report groups.');
  expect(requests.at(-1)).toBe(
    '/api/orchestration/report-groups?afterGroupId=group-a',
  );
});

test.each([false, true])(
  'authority loss hides reports with unconfirmed reservations (accounting terminal %s)',
  async (accountingTerminal) => {
    let settle!: (response: Response) => void;
    let pendingSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/results/')) {
          pendingSignal = init?.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return Promise.resolve(
          envelope({
            groups: [
              {
                ...group,
                members: group.members.map((member) => ({
                  ...member,
                  attempts: member.attempts.map((attempt) => ({
                    ...attempt,
                    allocation: null,
                    accountingTerminal,
                  })),
                })),
              },
            ],
            hasMore: false,
            nextGroupId: null,
          }),
        );
      }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
    await screen.findByText('operator-report');
    expect(screen.queryByText(/Accounting reconciled/)).toBeNull();
    if (accountingTerminal)
      expect(
        screen.getByText(/Accounting terminal recorded; usage unknown/),
      ).toBeTruthy();
    expect(
      screen.getByText(/No accounting reservation confirmed/),
    ).toBeTruthy();
    expect(screen.queryByText(/reservation retained/)).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Read report for reviewer' }),
    );
    await waitFor(() => expect(pendingSignal).toBeDefined());
    view.revoke();
    expect(screen.queryByText('operator-report')).toBeNull();
    await waitFor(() => expect(pendingSignal?.aborted).toBe(true));
    await act(async () => {
      settle(envelope(resultPage('PRIVATE_LATE_REPORT', 0, false)));
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Station authority changed',
    );
    expect(screen.queryByText('PRIVATE_LATE_REPORT')).toBeNull();
    const cached = view.client
      .getQueryCache()
      .findAll({ queryKey: ['report-group-result'] });
    expect(cached.every((query) => query.state.data === undefined)).toBe(true);
  },
);
