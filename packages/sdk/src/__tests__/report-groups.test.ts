import { afterEach, expect, test, vi } from 'vitest';
import {
  continueReportGroupReport,
  createReportGroup,
  finalizeReportGroupContinuation,
  finalizeReportGroupSync,
  listReportGroups,
  narrowReportGroupAfterInput,
  parseReportGroupInput,
  type ReportGroupContextSyncView,
  ReportGroupContinuationUnsupportedError,
  ReportGroupProtocolError,
  ReportGroupRecoveryUnsupportedError,
  readReportGroupEvents,
  readReportGroupResult,
  recoverReportGroupAccounting,
  subscribeReportGroupEvents,
  syncReportGroupAfterInput,
  syncReportGroupContext,
} from '../client/report-groups';

afterEach(() => vi.unstubAllGlobals());
const base = 'https://report.test';
function envelope(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
const page = {
  groupId: 'g',
  afterRevision: 0,
  nextRevision: 2,
  revision: 2,
  events: [
    { revision: 1, kind: 'command', commandKind: 'create' },
    { revision: 2, kind: 'returned' },
  ],
  unavailable: [],
  hasMore: false,
};
test.each([
  ['foreign group', { ...page, groupId: 'foreign' }],
  ['gap', { ...page, events: [page.events[1]] }],
  ['hidden remainder', { ...page, nextRevision: 1, events: [page.events[0]] }],
  [
    'nonadvancing page',
    { ...page, nextRevision: 0, events: [], hasMore: true },
  ],
  ['backwards', { ...page, events: [...page.events].reverse() }],
  ['cursor beyond journal', { ...page, revision: 1 }],
  ['private payload', { ...page, root: { credential: 'must refuse' } }],
])('report reader refuses %s without retry', async (_name, data) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope(data));
  vi.stubGlobal('fetch', fetch);
  await expect(readReportGroupEvents(base, 'g')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('report result reader binds identity and exact UTF-16 cursor before exposing text', async () => {
  const result = {
    kind: 'result',
    groupId: 'g',
    seatId: 'seat',
    invocationId: 'attempt',
    modelId: 'model',
    text: '😀',
    afterOffset: 4,
    nextOffset: 6,
    hasMore: false,
    usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope(result));
  vi.stubGlobal('fetch', fetch);
  expect(await readReportGroupResult(base, 'g', 'seat', 'attempt', 4)).toEqual(
    result,
  );
  fetch.mockImplementation(async () => envelope({ ...result, nextOffset: 5 }));
  await expect(
    readReportGroupResult(base, 'g', 'seat', 'attempt', 4),
  ).rejects.toThrow(ReportGroupProtocolError);
  fetch.mockImplementation(async () =>
    envelope({ ...result, invocationId: 'foreign' }),
  );
  await expect(
    readReportGroupResult(base, 'g', 'seat', 'attempt', 4),
  ).rejects.toThrow(ReportGroupProtocolError);
});
test('report create enforces canonical byte cap before any mutation', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  await expect(
    createReportGroup(base, {
      operationId: 'op',
      projectSlug: 'p',
      deadlineAt: 1,
      maxConcurrent: 1,
      budget: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
      members: Array.from({ length: 16 }, (_, i) => ({
        seatId: `s${i}`,
        agentId: 'a',
        brief: '😀'.repeat(16000),
        maxOutputTokens: 1,
      })),
    }),
  ).rejects.toThrow('byte limit');
  expect(fetch).not.toHaveBeenCalled();
});
test.each(['foreign-checkpoint', 'malformed-json'] as const)(
  'report stream refuses %s without delivering or reconnecting',
  async (variant) => {
    const frame = `event: report-group-events\nid: ${variant === 'foreign-checkpoint' ? 'group:g:2' : 'report:g:2'}\ndata: ${variant === 'malformed-json' ? '{' : JSON.stringify(page)}\n\n`;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(frame, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const onPage = vi.fn();
    let terminal: unknown;
    const stream = subscribeReportGroupEvents(base, 'g', 0, {
      onPage,
      onTerminal: (error) => {
        terminal = error;
      },
    });
    try {
      await stream.completed;
      expect(terminal).toBeInstanceOf(ReportGroupProtocolError);
      expect(onPage).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  },
);

const groupView = (groupId: string) => ({
  version: 'station.report-group/v1',
  groupId,
  operationId: 'op',
  revision: 0,
  topology: { kind: 'independent-advisory' },
  execution: 'idle',
  cancellation: 'none',
  authorityRevoked: false,
  acceptance: 'unassessed',
  members: [
    {
      seatId: 's',
      agentId: 'a',
      taskId: 'task',
      clientTurnId: 'turn',
      requestedModelId: 'model',
      attempts: [],
    },
  ],
});
test.each([
  { groups: [], hasMore: true, nextGroupId: null },
  { groups: [groupView('a')], hasMore: false, nextGroupId: 'a' },
  {
    groups: [groupView('a'), groupView('a')],
    hasMore: false,
    nextGroupId: null,
  },
  {
    groups: [groupView('b'), groupView('a')],
    hasMore: false,
    nextGroupId: null,
  },
  { groups: [groupView('a')], hasMore: true, nextGroupId: 'b' },
])(
  'report list refuses inconsistent membership/page cursor %j',
  async (value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => envelope(value)),
    );
    await expect(listReportGroups(base)).rejects.toThrow(
      ReportGroupProtocolError,
    );
  },
);
test('report list advances only through the last ordered member and refuses replay behind the requested cursor', async () => {
  const data = { groups: [groupView('b')], hasMore: true, nextGroupId: 'b' };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => envelope(data)),
  );
  expect(await listReportGroups(base, 'a')).toEqual(data);
  await expect(listReportGroups(base, 'b')).rejects.toThrow(
    ReportGroupProtocolError,
  );
});

test('report continuation parser preserves explicit finite limits and refuses implied authority', () => {
  const input = {
    operationId: 'op',
    projectSlug: 'p',
    flow: { runId: 'run', steps: { s: 's' } },
    deadlineAt: 1,
    maxConcurrent: 1,
    budget: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
    members: [
      { seatId: 's', agentId: 'a', brief: 'Report', maxOutputTokens: 1 },
    ],
    continuation: {
      attemptsPerMember: 3,
      maxRounds: 3,
      maxSyncs: 1,
      maxRenewals: 2,
      maxEvaluations: 2,
      maxRecoveries: 2,
    },
  };
  expect(parseReportGroupInput(input)).toEqual(input);
  for (const sent of [
    { ...input, flow: undefined },
    { ...input, continuation: { ...input.continuation, attemptsPerMember: 1 } },
    { ...input, continuation: { ...input.continuation, maxRenewals: 9 } },
    { ...input, continuation: { ...input.continuation, unbounded: true } },
  ])
    expect(() => parseReportGroupInput(sent)).toThrow();
  const { continuation: _continuation, ...legacy } = input;
  expect(parseReportGroupInput(legacy)).toEqual(legacy);
});

test('context-sync SDK keeps one explicit operation, admits receipt-only finalization and rejects contradictory ACK evidence', async () => {
  const command = {
    operationKey: 'sync-a',
    expectedRevision: 2,
    seatId: 's',
    flowHead: 'a'.repeat(64),
    text: '\0'.repeat(65_536),
  };
  const digest = `sha256:${'b'.repeat(64)}`;
  const syncView: ReportGroupContextSyncView = {
    operationKey: 'sync-a',
    seatId: 's',
    flowHead: command.flowHead,
    state: 'acknowledged',
    reason: 'exact_ack',
    preparedDigest: digest,
    attempts: [
      {
        invocationId: 'i',
        allocation: { inputTokens: 10, outputTokens: 10, costMicros: 20 },
        usage: { inputTokens: 1, outputTokens: 1, costMicros: 2 },
        accountingTerminal: true,
        terminal: {
          id: 'proof',
          domain: 'station.report-observation.v1',
          digest: `sha256:${'c'.repeat(64)}`,
        },
      },
    ],
  };
  const view = {
    ...groupView('g'),
    topology: { kind: 'flow', runId: 'run' },
    revision: 5,
    contextSyncs: [syncView],
    accounting: {
      invocationCount: 1,
      unsettledInvocations: 0,
      knownTerminalUsage: { inputTokens: 1, outputTokens: 1, costMicros: 2 },
      unsettledAllocation: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    envelope({ replayed: false, group: view }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    (await syncReportGroupContext(base, 'g', command)).group.contextSyncs?.[0]
      .state,
  ).toBe('acknowledged');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toContain('/g/sync');
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(command);
  const finalize = {
    operationKey: 'final-a',
    expectedRevision: 5,
    syncOperationKey: 'sync-a',
    preparedDigest: digest,
  };
  await finalizeReportGroupSync(base, 'g', finalize);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(finalize);
  const { text: _text, ...syncIdentity } = command;
  const inputCommand = { ...syncIdentity, renewalOperationKey: 'narrow-a' };
  await syncReportGroupAfterInput(base, 'g', inputCommand);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(String(fetch.mock.calls[2][0])).toContain('/g/input/sync');
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual(
    inputCommand,
  );
  const replacement = { ...inputCommand, text: 'replacement answer' };
  await expect(
    syncReportGroupAfterInput(base, 'g', replacement),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockImplementationOnce(async () =>
    envelope({
      replayed: false,
      group: {
        ...view,
        contextSyncs: [{ ...syncView, flowHead: 'c'.repeat(64) }],
      },
    }),
  );
  await expect(
    syncReportGroupAfterInput(base, 'g', inputCommand),
  ).rejects.toThrow(ReportGroupProtocolError);
  expect(syncView.attempts).not.toBeNull();
  syncView.attempts![0].usage = null;
  await expect(syncReportGroupContext(base, 'g', command)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(5);
});

test('input narrowing binds response group and refuses client-authored authority before HTTP', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    envelope({
      replayed: false,
      group: {
        ...groupView('g'),
        revision: 2,
        topology: { kind: 'flow', runId: 'run' },
      },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const command = { operationKey: 'narrow', expectedRevision: 1, seatId: 's' };
  expect((await narrowReportGroupAfterInput(base, 'g', command)).replayed).toBe(
    false,
  );
  expect(String(fetch.mock.calls[0][0])).toContain('/g/input/narrow');
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(command);
  for (const invalid of [
    { ...command, root: {} },
    { ...command, operationKey: 'x'.repeat(97) },
  ])
    await expect(
      narrowReportGroupAfterInput(base, 'g', invalid),
    ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () =>
    envelope({
      replayed: true,
      group: {
        ...groupView('foreign'),
        revision: 2,
        topology: { kind: 'flow', runId: 'run' },
      },
    }),
  );
  await expect(narrowReportGroupAfterInput(base, 'g', command)).rejects.toThrow(
    ReportGroupProtocolError,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('continued report SDK refuses caller text and foreign predecessor results without automatic resend', async () => {
  const command = {
    operationKey: 'again',
    expectedRevision: 0,
    seatId: 's',
    flowHead: 'a'.repeat(64),
    syncOperationKey: 'sync',
    previousInvocationId: 'original',
    retryRef: 'b'.repeat(64),
  };
  const view = {
    ...groupView('g'),
    topology: { kind: 'flow', runId: 'run' },
    members: [
      {
        ...groupView('g').members[0],
        attempts: [
          {
            invocationId: 'original',
            observation: null,
            terminal: null,
            allocation: null,
            usage: null,
            accountingTerminal: false,
          },
          {
            invocationId: 'next',
            observation: null,
            terminal: null,
            allocation: null,
            usage: null,
            accountingTerminal: false,
          },
        ],
      },
    ],
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    envelope({
      replayed: false,
      group: view,
      operationKey: command.operationKey,
      seatId: command.seatId,
      invocationId: 'next',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await continueReportGroupReport(base, 'g', command);
  expect(String(fetch.mock.calls[0][0])).toContain('/g/report');
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(command);
  const replacement = { ...command, text: 'replacement brief' };
  await expect(
    continueReportGroupReport(base, 'g', replacement),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () =>
    envelope({
      replayed: false,
      operationKey: command.operationKey,
      seatId: command.seatId,
      invocationId: 'next',
      group: {
        ...view,
        members: [
          {
            ...view.members[0],
            attempts: [
              { ...view.members[0].attempts[0], invocationId: 'foreign' },
            ],
          },
        ],
      },
    }),
  );
  await expect(continueReportGroupReport(base, 'g', command)).rejects.toThrow(
    ReportGroupProtocolError,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('accounting recovery refuses foreign identity, private fields and inconsistent outcomes without retry', async () => {
  const result = {
    groupId: 'g',
    seatId: 's',
    invocationId: 'i',
    operationKey: 'recover',
    replayed: false,
    status: 'settled',
    reason: 'exact-settlement',
    accounting: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
    receipt: {
      id: 'receipt',
      domain: 'recovery',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  };
  const sent = { seatId: 's', invocationId: 'i', operationKey: 'recover' };
  for (const changed of [
    { groupId: 'other' },
    { seatId: 'other' },
    { invocationId: 'other' },
    { operationKey: 'other' },
    { invocation: { private: true } },
    { status: 'held' },
    { accounting: null },
  ]) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      envelope({ ...result, ...changed }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      recoverReportGroupAccounting(base, 'g', sent),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope(result));
  vi.stubGlobal('fetch', fetch);
  await expect(recoverReportGroupAccounting(base, 'g', sent)).resolves.toEqual(
    result,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0];
  expect(String(request[0])).toBe(
    `${base}/api/orchestration/report-groups/g/accounting/recover`,
  );
  expect(JSON.parse(String(request[1]?.body))).toEqual(sent);
});
test('an older host reports unsupported recovery without retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response('Not Found', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    recoverReportGroupAccounting(base, 'g', {
      seatId: 's',
      invocationId: 'i',
      operationKey: 'recover',
    }),
  ).rejects.toBeInstanceOf(ReportGroupRecoveryUnsupportedError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('continuation finalization sends one exact operation and reports older hosts unsupported', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ success: false, code: 'not_found' }), {
        status: 404,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const input = {
    operationKey: 'final-1',
    expectedRevision: 7,
    continuationOperationKey: 'original-1',
  };
  await expect(
    finalizeReportGroupContinuation(base, 'group-1', input),
  ).rejects.toBeInstanceOf(ReportGroupContinuationUnsupportedError);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0]![0])).toBe(
    'https://report.test/api/orchestration/report-groups/group-1/continuation/finalize',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(input);
  await expect(
    finalizeReportGroupContinuation(base, 'group-1', {
      ...input,
      expectedRevision: -1,
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
