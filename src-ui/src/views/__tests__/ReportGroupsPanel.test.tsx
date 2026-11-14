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
  within,
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

test.each(['independent', 'flow'] as const)(
  'operator reads %s reports with crypto unavailable and preserves unknown accounting without executing work',
  async (mode) => {
    vi.stubGlobal('crypto', {});
    const displayedGroup: ReportGroupView = {
      ...group,
      topology:
        mode === 'flow'
          ? { kind: 'flow', runId: 'run-one' }
          : { kind: 'independent-advisory' },
    };
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
          groups: target.searchParams.has('afterGroupId')
            ? []
            : [displayedGroup],
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
    await screen.findByText(
      mode === 'flow' ? /Flow run-one/ : /Independent advisory/,
    );
    await screen.findByText('operator-report');
    expect(
      screen.getByText(/Accounting unresolved; reservation retained/),
    ).toBeTruthy();
    expect(screen.getByText(/Termination unconfirmed/)).toBeTruthy();
    expect(screen.queryByText(/untrusted/)).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Read report for reviewer' }),
    );
    expect(
      await screen.findByText('🚀<script>untrusted</script>'),
    ).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByText(/Reported model: reported-model/)).toBeTruthy();
    expect(requests.filter((path) => path.includes('/results/'))).toEqual([
      '/api/orchestration/report-groups/group-a/members/reviewer/results/invocation-one?afterOffset=0',
      '/api/orchestration/report-groups/group-a/members/reviewer/results/invocation-one?afterOffset=1',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Next report groups' }));
    await waitFor(() => {
      expect(screen.queryByText('operator-report')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Next report groups' }),
      ).toHaveProperty('disabled', true);
    });
    expect(requests.at(-1)).toBe(
      '/api/orchestration/report-groups?afterGroupId=group-a',
    );
  },
);

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
    expect(screen.getByText(/Reservation unconfirmed/)).toBeTruthy();
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

test.each(['requested', 'refused', 'authority-loss'] as const)(
  'operator cancellation is explicit and does not resend after %s',
  async (outcome) => {
    let settle!: (response: Response) => void;
    const sent: unknown[] = [];
    let canceled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          sent.push(JSON.parse(String(init.body)));
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return envelope({
          groups: [
            {
              ...group,
              cancellation: canceled ? 'requested' : 'none',
              authorityRevoked: false,
            },
          ],
          hasMore: false,
          nextGroupId: null,
        });
      }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
    const button = await screen.findByRole('button', {
      name: 'Request cancellation',
    });
    expect(sent).toEqual([]);
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => fireEvent.click(button));
    expect(sent).toEqual([
      { expectedRevision: 4, operationKey: expect.stringMatching(/^cancel:/) },
    ]);
    if (outcome === 'authority-loss') view.revoke();
    canceled = true;
    await act(async () =>
      settle(
        outcome === 'refused'
          ? new Response('{}', {
              status: 409,
              headers: { 'content-type': 'application/json' },
            })
          : envelope({
              replayed: false,
              revision: 5,
              cancellation: 'requested',
            }),
      ),
    );
    if (outcome === 'requested') {
      expect(
        await screen.findByText(
          /Cancellation requested\. Termination and accounting remain separately recorded/,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/Termination unconfirmed/)).toBeTruthy();
      expect(screen.queryByText(/Accounting reconciled/)).toBeNull();
    } else if (outcome === 'refused') {
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        'Cancellation outcome unknown. Read the latest group state before making another request.',
      );
      fireEvent.click(button);
    } else {
      expect(screen.queryByText(/Cancellation requested\./)).toBeNull();
      expect(screen.queryByText('operator-report')).toBeNull();
    }
    expect(sent).toHaveLength(1);
  },
);

test.each(['requested', 'pending', 'authority-loss'] as const)(
  'explicit cancellation receipt recovery retains the original key: %s',
  async (outcome) => {
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    let settle!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          sent.push({
            path: new URL(String(url)).pathname,
            body: JSON.parse(String(init.body)),
          });
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return envelope({ groups: [group], hasMore: false, nextGroupId: null });
      }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
    const key = await screen.findByRole('textbox', {
      name: 'Original cancellation operation key',
    });
    fireEvent.change(key, { target: { value: 'cancel:original' } });
    const check = screen.getByRole('button', {
      name: 'Check cancellation receipts',
    });
    fireEvent.click(check);
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => fireEvent.click(check));
    expect(sent).toEqual([
      {
        path: '/api/orchestration/report-groups/group-a/cancel/finalize',
        body: {
          cancelOperationKey: 'cancel:original',
          expectedRevision: 4,
          operationKey: expect.stringMatching(/^finalize:/),
        },
      },
    ]);
    if (outcome === 'authority-loss') view.revoke();
    await act(async () =>
      settle(
        envelope({
          replayed: false,
          revision: 5,
          cancellation: outcome === 'pending' ? 'pending' : 'requested',
        }),
      ),
    );
    if (outcome === 'authority-loss') {
      expect(
        screen.queryByText(/Cancellation requested\. Physical termination/),
      ).toBeNull();
      expect(screen.queryByText('operator-report')).toBeNull();
    } else {
      expect(
        await screen.findByText(
          new RegExp(
            `Cancellation ${outcome}\\. Physical termination and accounting remain separately recorded`,
          ),
        ),
      ).toBeTruthy();
      await act(async () => fireEvent.click(check));
      expect(screen.getByText(/Termination unconfirmed/)).toBeTruthy();
      expect(screen.queryByText(/Accounting reconciled/)).toBeNull();
    }
    expect(sent).toHaveLength(1);
  },
);

test.each([
  'returned',
  'flow',
  'refused',
  'authority-loss',
  'unmount',
] as const)(
  'paid report creation preserves explicit intent and never resends after %s',
  async (outcome) => {
    const sent: Record<string, unknown>[] = [];
    let settle!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          expect(new URL(String(url)).pathname).toBe(
            '/api/orchestration/report-groups',
          );
          sent.push(JSON.parse(String(init.body)));
          signal = init.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return envelope({ groups: [], hasMore: false, nextGroupId: null });
      }),
    );
    const view = mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Run an advisory report group' }),
    );
    const fill = (name: string, value: string) =>
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    fill('Project ID', 'project-one');
    fill('Resource ID (optional)', 'resource-one');
    fill('Aggregate input token limit', '10000');
    fill('Aggregate output token limit', '1000');
    fill('Aggregate inference cost limit (microdollars)', '50000');
    fill('Agent ID', 'review-agent');
    fill('Member brief', 'Inspect only the selected source.');
    fill('Member output token limit', '500');
    if (outcome === 'returned' || outcome === 'flow') {
      fireEvent.click(
        screen.getByRole('button', { name: 'Add report member' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Add report member' }),
      );
      const critic = within(
        screen.getByRole('group', { name: 'Report member 2' }),
      );
      fireEvent.change(critic.getByLabelText('Agent ID'), {
        target: { value: 'critic-agent' },
      });
      fireEvent.change(critic.getByLabelText('Member brief'), {
        target: { value: 'Find contrary evidence only.' },
      });
      fireEvent.change(critic.getByLabelText('Member output token limit'), {
        target: { value: '200' },
      });
      const verifier = within(
        screen.getByRole('group', { name: 'Report member 3' }),
      );
      fireEvent.change(verifier.getByLabelText('Agent ID'), {
        target: { value: 'verification-agent' },
      });
      fireEvent.change(verifier.getByLabelText('Member brief'), {
        target: { value: 'Verify the exact source independently.' },
      });
      fireEvent.change(verifier.getByLabelText('Member output token limit'), {
        target: { value: '250' },
      });
      fill('Concurrent reports', '2');
    }
    if (outcome === 'flow') {
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Use an existing Flow run' }),
      );
      fill('Flow run ID', 'flow-run');
      const stepInputs = screen.getAllByLabelText('Flow step ID');
      ['review-step', 'critic-step', 'verification-step'].forEach((value, i) =>
        fireEvent.change(stepInputs[i], { target: { value } }),
      );
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Reserve continuation for this Flow group',
        }),
      );
      fill('Maximum context operations', '4');
      fireEvent.submit(
        screen
          .getByRole('button', { name: 'Start paid reports' })
          .closest('form')!,
      );
      expect(sent).toHaveLength(0);
      expect(screen.getByRole('alert').textContent).toContain(
        'Check the source',
      );
      fill('Maximum context operations', '1');
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Use an existing Flow run' }),
      );
      expect(screen.getByLabelText('Flow run ID').matches(':disabled')).toBe(
        true,
      );
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Use an existing Flow run' }),
      );
      expect(screen.getByLabelText('Flow run ID')).toHaveProperty(
        'value',
        'flow-run',
      );
      expect(screen.getAllByLabelText('Flow step ID')[0]).toHaveProperty(
        'value',
        'review-step',
      );
    }
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    const start = screen.getByRole('button', { name: 'Start paid reports' });
    const submittedAt = Date.now();
    fireEvent.submit(start.closest('form')!);
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => fireEvent.click(start));
    expect(sent).toEqual([
      {
        operationId: expect.any(String),
        projectSlug: 'project-one',
        resourceId: 'resource-one',
        deadlineAt: expect.any(Number),
        maxConcurrent: outcome === 'returned' || outcome === 'flow' ? 2 : 1,
        ...(outcome === 'flow'
          ? {
              flow: {
                runId: 'flow-run',
                steps: {
                  'seat-1': 'review-step',
                  'seat-2': 'critic-step',
                  'seat-3': 'verification-step',
                },
              },
              continuation: {
                attemptsPerMember: 3,
                maxRounds: 3,
                maxSyncs: 1,
                maxRenewals: 0,
                maxEvaluations: 2,
                maxRecoveries: 0,
              },
            }
          : {}),
        budget: { inputTokens: 10000, outputTokens: 1000, costMicros: 50000 },
        members: [
          {
            seatId: 'seat-1',
            agentId: 'review-agent',
            brief: 'Inspect only the selected source.',
            maxOutputTokens: 500,
          },
          ...(outcome === 'returned' || outcome === 'flow'
            ? [
                {
                  seatId: 'seat-2',
                  agentId: 'critic-agent',
                  brief: 'Find contrary evidence only.',
                  maxOutputTokens: 200,
                },
                {
                  seatId: 'seat-3',
                  agentId: 'verification-agent',
                  brief: 'Verify the exact source independently.',
                  maxOutputTokens: 250,
                },
              ]
            : []),
        ],
      },
    ]);
    expect(Number(sent[0].deadlineAt) - submittedAt).toBeGreaterThanOrEqual(
      300000,
    );
    expect(Number(sent[0].deadlineAt) - Date.now()).toBeLessThanOrEqual(300000);
    const afterSubmit = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterSubmit);
    expect(afterSubmit.defaultPrevented).toBe(false);
    if (outcome === 'authority-loss') view.revoke();
    if (outcome === 'unmount') view.unmount();
    if (outcome === 'authority-loss' || outcome === 'unmount')
      expect(signal?.aborted).toBe(true);
    await act(async () =>
      settle(
        outcome === 'refused'
          ? new Response('{}', {
              status: 409,
              headers: { 'content-type': 'application/json' },
            })
          : envelope({
              replayed: false,
              group: { ...group, operationId: sent[0].operationId },
            }),
      ),
    );
    if (outcome === 'returned' || outcome === 'flow') {
      expect(
        await screen.findByText(
          /Report group group-a: returned\. Acceptance remains unassessed/,
        ),
      ).toBeTruthy();
    } else if (outcome === 'refused') {
      expect(await screen.findByText(/Report outcome unknown/)).toBeTruthy();
      await act(async () => fireEvent.click(start));
    } else {
      expect(screen.queryByText(/Report group group-a: returned/)).toBeNull();
    }
    expect(sent).toHaveLength(1);
  },
);

test.each(['acknowledged', 'refused', 'authority-loss', 'unmount'] as const)(
  'explicit paid context uses the displayed revision and never resends after %s',
  async (outcome) => {
    let displayed: ReportGroupView = {
      ...group,
      authorityRevoked: false,
      cancellation: 'none',
      topology: { kind: 'flow', runId: 'flow-one' },
      contextSyncAllowance: { maximumOperations: 1, recordedOperations: 0 },
      accounting: {
        invocationCount: 1,
        unsettledInvocations: 1,
        knownTerminalUsage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        unsettledAllocation: {
          inputTokens: 10,
          outputTokens: 5,
          costMicros: 100,
        },
      },
    };
    let settle!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const sent: { path: string; command: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (new URL(String(url)).pathname.endsWith('/context-checkpoint'))
          return envelope({
            groupId: group.groupId,
            seatId: 'reviewer',
            revision: 4,
            flowHead: 'a'.repeat(64),
          });
        if (init?.method === 'POST') {
          sent.push({
            path: new URL(String(url)).pathname,
            command: JSON.parse(String(init.body)),
          });
          signal = init.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return envelope({
          groups: [displayed],
          hasMore: false,
          nextGroupId: null,
        });
      }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Send updated report context',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Read current Flow checkpoint' }),
    );
    await screen.findByText(/Current Flow checkpoint read for reviewer/);
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Private context text' }),
      { target: { value: 'PRIVATE_SYNC_CONTEXT' } },
    );
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    const send = screen.getByRole('button', {
      name: 'Send paid context request',
    });
    fireEvent.click(send);
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.click(send);
    expect(sent).toEqual([
      {
        path: '/api/orchestration/report-groups/group-a/sync',
        command: {
          operationKey: expect.stringMatching(/^context:/),
          expectedRevision: 4,
          seatId: 'reviewer',
          flowHead: 'a'.repeat(64),
          text: 'PRIVATE_SYNC_CONTEXT',
        },
      },
    ]);
    if (outcome === 'authority-loss') view.revoke();
    if (outcome === 'unmount') view.unmount();
    if (outcome === 'unmount' || outcome === 'authority-loss')
      await waitFor(() => expect(signal?.aborted).toBe(true));
    displayed = {
      ...displayed,
      revision: 7,
      contextSyncAllowance: { maximumOperations: 1, recordedOperations: 1 },
      contextSyncs: [
        {
          operationKey: String(sent[0].command.operationKey),
          seatId: 'reviewer',
          flowHead: 'a'.repeat(64),
          state: 'acknowledged',
          reason: 'exact_ack',
          preparedDigest: `sha256:${'b'.repeat(64)}`,
          attempts: [
            {
              invocationId: 'sync-one',
              allocation: { inputTokens: 10, outputTokens: 5, costMicros: 100 },
              usage: { inputTokens: 2, outputTokens: 1, costMicros: 21 },
              accountingTerminal: true,
              terminal: {
                id: 'terminal-sync',
                domain: 'station.report-observation.v1',
                digest: `sha256:${'c'.repeat(64)}`,
              },
            },
          ],
        },
      ],
      accounting: {
        invocationCount: 2,
        unsettledInvocations: 1,
        knownTerminalUsage: { inputTokens: 2, outputTokens: 1, costMicros: 21 },
        unsettledAllocation: {
          inputTokens: 10,
          outputTokens: 5,
          costMicros: 100,
        },
      },
    };
    await act(async () =>
      settle(
        outcome === 'refused'
          ? new Response('{}', { status: 409 })
          : envelope({ replayed: false, group: displayed }),
      ),
    );
    if (outcome === 'acknowledged') {
      expect(
        await screen.findByText(/Exact context ACK retained/),
      ).toBeTruthy();
      expect(
        screen.getByText(/All invocations, including context sync: 2/),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Unsettled allocations: 10 input tokens, 5 output tokens, 100 inference microdollars/,
        ),
      ).toBeTruthy();
      expect(
        view.client.getQueryData([
          'report-groups',
          'https://report-ui.test',
          'operator-one',
          null,
        ]),
      ).toMatchObject({ groups: [displayed] });
    } else if (outcome === 'refused') {
      expect(await screen.findByText(/Context outcome unknown/)).toBeTruthy();
      fireEvent.click(send);
    } else {
      expect(screen.queryByText(/Exact context ACK retained/)).toBeNull();
      expect(
        view.client
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.data === undefined),
      ).toBe(true);
    }
    expect(sent).toHaveLength(1);
  },
);

test('prepared context publication sends only the retained digest and preserves unknown accounting', async () => {
  const prepared: ReportGroupView = {
    ...group,
    topology: { kind: 'flow', runId: 'flow-one' },
    contextSyncAllowance: { maximumOperations: 1, recordedOperations: 1 },
    contextSyncs: [
      {
        operationKey: 'original-sync',
        seatId: 'reviewer',
        flowHead: 'a'.repeat(64),
        state: 'prepared',
        reason: 'execution_incomplete',
        preparedDigest: `sha256:${'b'.repeat(64)}`,
        attempts: [
          {
            invocationId: 'sync-unknown',
            allocation: { inputTokens: 10, outputTokens: 5, costMicros: 100 },
            usage: null,
            accountingTerminal: false,
            terminal: null,
          },
        ],
      },
    ],
  };
  const sent: unknown[] = [];
  const released: ReportGroupView = {
    ...prepared,
    revision: 5,
    contextSyncs: prepared.contextSyncs?.map((sync) => ({
      ...sync,
      state: 'incomplete',
    })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        expect(new URL(String(url)).pathname).toBe(
          '/api/orchestration/report-groups/group-a/sync/finalize',
        );
        sent.push(JSON.parse(String(init.body)));
        return envelope({ replayed: false, group: released });
      }
      return envelope({
        groups: [sent.length ? released : prepared],
        hasMore: false,
        nextGroupId: null,
      });
    }),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show report groups' }));
  const publish = await screen.findByRole('button', {
    name: 'Publish retained sync receipt',
  });
  fireEvent.click(publish);
  fireEvent.click(publish);
  await screen.findByText(/Context sync incomplete/);
  expect(sent).toEqual([
    {
      operationKey: expect.stringMatching(/^sync-receipt:/),
      expectedRevision: 4,
      syncOperationKey: 'original-sync',
      preparedDigest: `sha256:${'b'.repeat(64)}`,
    },
  ]);
  expect(
    screen.queryByRole('button', { name: 'Send updated report context' }),
  ).toBeNull();
  expect(
    screen.getByText(/sync-unknown: Usage unresolved; allocation retained/),
  ).toBeTruthy();
});
