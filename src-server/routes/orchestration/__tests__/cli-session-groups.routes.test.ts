import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CliSessionGroupEventPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import type { TurnCompletedEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temporary = trackTempDirs();
type DispatchInput = {
  prompt: string;
  sessionId?: string;
  initialClientTurnId?: string;
  delegationGroupAdmission?: { assertCurrent(): void };
};

// Real HTTP handlers, durable group store and installed Flow scheduler. The member runtime is controlled here.
function fixture(home = temporary('station-cli-group-')) {
  const calls: DispatchInput[] = [];
  const failures: unknown[] = [];
  const statuses = new Map<string, string>();
  const terminalTurns = new Map<string, string>();
  const terminalMethods = new Map<string, 'runtime.error' | 'turn.aborted'>();
  const completedInitialTurns = new Set<string>();
  const cancelledInitialTurns = new Set<string>();
  const initialFinishReasons = new Map<
    string,
    TurnCompletedEvent['finishReason']
  >();
  const elidedRetryErrors = new Set<string>();
  const windowReads: string[] = [];
  let beforeDispatch: (input: DispatchInput) => Promise<void> = async () => {};
  let current = true;
  const delegateTask = vi.fn(async (input: DispatchInput) => {
    calls.push(input);
    await beforeDispatch(input);
    input.delegationGroupAdmission?.assertCurrent();
    const sessionId = input.sessionId!;
    return {
      taskId: sessionId,
      conversationId: sessionId,
      sessionId,
      initialTurnId: `turn:${sessionId}`,
    };
  });
  const observeDelegatedTask = vi.fn(
    async ({ taskId }: { taskId: string }) => ({
      taskId,
      sessionId: taskId,
      status: statuses.get(taskId) ?? 'completed',
    }),
  );
  const interruptDelegatedTask = vi.fn(
    async (_input: { taskId: string; turnId?: string }) => ({
      interruptOutcome: 'requested',
    }),
  );
  const app = createOrchestrationRoutes(
    {
      readSessionEventWindow: async (threadId: string) => {
        windowReads.push(threadId);
        return {
          events: [
            ...(elidedRetryErrors.has(threadId)
              ? [
                  {
                    elided: 'byte_limit',
                    event: {
                      eventId: `retry:${threadId}`,
                      provider: 'codex',
                      threadId,
                      turnId: `turn:${threadId}`,
                      method: 'runtime.error',
                    },
                  },
                ]
              : []),
            ...(statuses.get(threadId) &&
            statuses.get(threadId) !== 'completed' &&
            !completedInitialTurns.has(threadId) &&
            !terminalMethods.has(threadId)
              ? []
              : [
                  {
                    event: {
                      eventId: `event:${threadId}`,
                      threadId,
                      turnId: terminalTurns.get(threadId) ?? `turn:${threadId}`,
                      method: terminalMethods.get(threadId) ?? 'turn.completed',
                      finishReason: initialFinishReasons.has(threadId)
                        ? initialFinishReasons.get(threadId)
                        : cancelledInitialTurns.has(threadId)
                          ? 'cancelled'
                          : 'stop',
                    },
                  },
                ]),
          ],
        };
      },
    } as never,
    {
      cliSessionGroupHome: home,
      eventBus: new EventBus(),
      logger: {
        debug() {},
        warn(_message, meta) {
          failures.push(meta);
        },
        info() {},
      },
      getUserId: () => 'owner',
      callerBindingForRequest: (request) =>
        request.headers.get('fixture-binding') ?? 'credential-one',
      isRequestPrincipalCurrent: () => current,
      delegateTask,
      observeDelegatedTask,
      interruptDelegatedTask: interruptDelegatedTask as never,
    },
  );
  const request = (path: string, body?: unknown, options: RequestInit = {}) =>
    app.request(path, {
      ...options,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (
    members = [
      member('first'),
      member('second'),
      member('third', ['first', 'second']),
    ],
    maxConcurrent = 2,
    maxDispatches?: number,
  ) => {
    const body = {
      operationId: 'create-one',
      members,
      maxConcurrent,
      ...(maxDispatches === undefined ? {} : { maxDispatches }),
      deadlineAt: Date.now() + 60_000,
    };
    const response = await request('/session-groups', body);
    expect(response.status, await response.clone().text()).toBe(200);
    const group = ((await response.json()) as { data: CliSessionGroupView })
      .data;
    return { group, body };
  };
  return {
    app,
    failures,
    home,
    request,
    create,
    calls,
    statuses,
    terminalTurns,
    terminalMethods,
    completedInitialTurns,
    cancelledInitialTurns,
    initialFinishReasons,
    windowReads,
    elidedRetryErrors,
    delegateTask,
    observeDelegatedTask,
    interruptDelegatedTask,
    setBeforeDispatch: (work: typeof beforeDispatch) => {
      beforeDispatch = work;
    },
    revoke: () => {
      current = false;
    },
  };
}
function member(
  seatId: string,
  needs: string[] = [],
): {
  seatId: string;
  needs: string[];
  prompt: string;
  target: {
    agent: string;
    expectedEngine: { kind: string; connectionId: string };
    model?: { options: Record<string, unknown> };
  };
} {
  return {
    seatId,
    needs,
    prompt: `private brief for ${seatId}`,
    target: {
      agent: 'reviewer',
      expectedEngine: { kind: 'connection', connectionId: 'cli-engine' },
    },
  };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await predicate()).toBe(true), {
    timeout: 10_000,
    interval: 20,
  });
}
async function view(f: ReturnType<typeof fixture>, groupId: string) {
  const response = await f.request(`/session-groups/${groupId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: CliSessionGroupView }).data;
}

test('three seats follow real Flow claims and joins, supervise member completion, and disclose missing guarantees', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setBeforeDispatch(async (input) => {
    // The irreversible-boundary callback sees the actual committed intent and reserved identities.
    const files = (await import('node:fs')).readdirSync(
      join(f.home, 'runtime', 'cli-session-groups'),
    );
    const record = JSON.parse(
      readFileSync(
        join(
          f.home,
          'runtime',
          'cli-session-groups',
          files.find((name) => name.endsWith('.json'))!,
        ),
        'utf8',
      ),
    );
    expect(
      record.seats.find(
        (seat: { reservedSessionId: string }) =>
          seat.reservedSessionId === input.sessionId,
      ),
    ).toMatchObject({
      state: 'launch-intent',
      initialClientTurnId: input.initialClientTurnId,
    });
    if (!input.prompt.includes('third')) await held;
  });
  const { group } = await f.create();
  const running = f.request(`/session-groups/${group.groupId}/run`, {});
  await waitFor(() => f.calls.length === 2);
  const pending = await view(f, group.groupId);
  expect(pending.members.map((m) => m.state)).toEqual([
    'launch-intent',
    'launch-intent',
    'pending',
  ]);
  release();
  const response = await running;
  expect(response.status, await response.clone().text()).toBe(200);
  const final = ((await response.json()) as { data: CliSessionGroupView }).data;
  expect(f.failures).toEqual([]);
  expect(f.calls).toHaveLength(3);
  expect(final.flow?.status).toBe('completed');
  expect(final.members.map((m) => m.outcome)).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
  expect(new Set(f.calls.map((call) => call.sessionId)).size).toBe(3);
  expect(
    final.members.every(
      (m) => m.handle?.initialTurnId && m.claimId && m.initialClientTurnId,
    ),
  ).toBe(true);
  expect(final.guarantees).toMatchObject({
    authority: 'station-session',
    portableFlowLineage: 'unbound',
    dollarCap: 'unavailable',
    physicalAttemptCap: 'unavailable',
  });
  expect(JSON.stringify(final)).not.toContain('private brief');
  await f.request(`/session-groups/${group.groupId}/run`, {});
  expect(f.calls).toHaveLength(3);
  const historyResponse = await f.request(
    `/session-groups/${group.groupId}/events?afterRevision=0`,
  );
  const history = (
    (await historyResponse.json()) as { data: CliSessionGroupEventPage }
  ).data;
  expect(JSON.stringify(history)).not.toContain('private brief');
  expect(
    history.events
      .flatMap((event) => event.members)
      .filter((member) => member.outcome === 'completed'),
  ).toHaveLength(3);
  const reopened = fixture(f.home);
  const replay = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=0`,
  );
  expect(
    ((await replay.json()) as { data: CliSessionGroupEventPage }).data,
  ).toEqual(history);
  const empty = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=${history.nextRevision}`,
  );
  expect(
    ((await empty.json()) as { data: CliSessionGroupEventPage }).data.events,
  ).toEqual([]);
  expect(reopened.calls).toHaveLength(0);
}, 30_000);

test('legacy journals disclose a history gap, reject foreign cursors and cannot invent past events', async () => {
  const f = fixture();
  const { group } = await f.create([member('first')], 1);
  await f.request(`/session-groups/${group.groupId}/run`, {});
  const path = join(
    f.home,
    'runtime',
    'cli-session-groups',
    `${group.groupId}.json`,
  );
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  delete legacy.events;
  delete legacy.eventHistoryStart;
  writeFileSync(path, JSON.stringify(legacy));
  const reopened = fixture(f.home);
  const response = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=0`,
  );
  const page = ((await response.json()) as { data: CliSessionGroupEventPage })
    .data;
  expect(page.events).toEqual([]);
  expect(page.nextRevision).toBe(legacy.revision);
  expect(page.gap).toEqual({ availableFromRevision: legacy.revision + 1 });
  const foreign = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=0`,
    undefined,
    { headers: { 'fixture-binding': 'another-credential' } },
  );
  expect(foreign.status).toBe(404);
  const future = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=${legacy.revision + 1}`,
  );
  expect(future.status).toBe(409);
  const wrongDomain = await reopened.request(
    `/session-groups/${group.groupId}/events/stream`,
    undefined,
    { headers: { 'Last-Event-ID': 'cli-group:another-group:0' } },
  );
  expect(wrongDomain.status).toBe(409);
  expect(reopened.calls).toHaveLength(0);
});

test('a group stream stops on current-authority loss before publishing another retained revision', async () => {
  const f = fixture();
  const { group } = await f.create([member('first')], 1);
  const stop = new AbortController();
  const response = await f.request(
    `/session-groups/${group.groupId}/events/stream`,
    undefined,
    { signal: stop.signal },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let initial = '';
  const decoder = new TextDecoder();
  while (!initial.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done)
      throw new Error('Stream ended before its initial observation');
    initial += decoder.decode(chunk.value, { stream: true });
  }
  expect(initial).toContain('cli-group-events');
  f.revoke();
  const otherInstance = fixture(f.home);
  const cancelled = await otherInstance.request(
    `/session-groups/${group.groupId}/cancel`,
    {},
  );
  expect(cancelled.status).toBe(200);
  let tail = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      tail += decoder.decode(chunk.value, { stream: true });
    }
    expect(tail).toContain('event: unavailable');
    expect(tail).not.toContain('"revision":1');
  } finally {
    stop.abort();
    await reader.cancel();
  }
  expect(f.calls).toHaveLength(0);
}, 20_000);

test('a full retained journal cannot block cancellation and evicts with an explicit cursor gap', async () => {
  const f = fixture();
  const { group } = await f.create([member('first')], 1);
  const path = join(
    f.home,
    'runtime',
    'cli-session-groups',
    `${group.groupId}.json`,
  );
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.revision = 4096;
  record.cancelled = true;
  record.events = Array.from({ length: 4096 }, (_, index) => ({
    revision: index + 1,
    members: [],
    schedule: [],
    ...(index === 0 ? { cancelled: true } : {}),
  }));
  writeFileSync(path, JSON.stringify(record));
  const reopened = fixture(f.home);
  const cancelled = await reopened.request(
    `/session-groups/${group.groupId}/cancel`,
    {},
  );
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  const bytes = readFileSync(path);
  const retained = JSON.parse(bytes.toString('utf8'));
  expect(retained.events).toHaveLength(4096);
  expect(retained.eventHistoryStart).toBe(2);
  expect(retained.revision).toBe(4097);
  expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
  const response = await reopened.request(
    `/session-groups/${group.groupId}/events?afterRevision=0`,
  );
  const page = ((await response.json()) as { data: CliSessionGroupEventPage })
    .data;
  expect(page.gap).toEqual({ availableFromRevision: 2 });
  expect(page.events).toHaveLength(64);
  expect(page.events[0].revision).toBe(2);
  expect(page.hasMore).toBe(true);
  expect(reopened.calls).toHaveLength(0);
});

test.each([0, 1, 2])(
  'reserved-start limit %i closes admission before another launcher call and survives reopen',
  async (limit) => {
    const f = fixture();
    const { group, body } = await f.create(
      [member('first'), member('second'), member('third')],
      2,
      limit,
    );
    await f.request(`/session-groups/${group.groupId}/run`, {});
    expect(f.calls).toHaveLength(limit);
    const final = await view(f, group.groupId);
    expect(final).toMatchObject({
      maxDispatches: limit,
      dispatchCount: limit,
      admissionClosed: 'dispatch-limit-exhausted',
    });
    expect(final.guarantees.dollarCap).toBe('unavailable');
    expect(
      final.members.filter((seat) => seat.state === 'pending'),
    ).toHaveLength(3 - limit);
    const page = await f.request(
      `/session-groups/${group.groupId}/events?afterRevision=0`,
    );
    expect(await page.text()).toContain('dispatch-limit-exhausted');
    const reopened = fixture(f.home);
    await reopened.request(`/session-groups/${group.groupId}/run`, {});
    expect(reopened.calls).toHaveLength(0);
    expect((await view(reopened, group.groupId)).dispatchCount).toBe(limit);
    expect(
      (
        await reopened.request('/session-groups', {
          ...body,
          maxDispatches: limit + 1,
        })
      ).status,
    ).toBe(409);
  },
  30_000,
);

test('an ambiguous start stays occupied across reopen and never authorizes another launch', async () => {
  const f = fixture();
  f.setBeforeDispatch(async () => {
    throw new Error('lost member acknowledgement');
  });
  const { group } = await f.create([member('first'), member('second')], 1, 1);
  await f.request(`/session-groups/${group.groupId}/run`, {});
  expect(f.calls).toHaveLength(1);
  expect(f.interruptDelegatedTask).not.toHaveBeenCalled();
  expect((await view(f, group.groupId)).admissionClosed).toBe(
    'dispatch-limit-exhausted',
  );
  const reopened = fixture(f.home);
  const response = await reopened.request(
    `/session-groups/${group.groupId}/run`,
    {},
  );
  expect(response.status).toBe(200);
  expect(reopened.calls).toHaveLength(0);
  expect(
    (await view(reopened, group.groupId)).members.map((m) => m.state),
  ).toEqual(['launch-intent', 'pending']);
}, 30_000);

test('cancel during asynchronous member setup refuses the final launch fence and closes admission', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  f.setBeforeDispatch(async (input) => {
    await held;
    input.delegationGroupAdmission!.assertCurrent();
    starts += 1;
  });
  const { group } = await f.create([member('first'), member('second')], 1);
  const running = f.request(`/session-groups/${group.groupId}/run`, {});
  await waitFor(() => f.calls.length === 1);
  await f.request(`/session-groups/${group.groupId}/cancel`, {});
  await running;
  expect(starts).toBe(0);
  release();
  await Promise.allSettled(
    f.delegateTask.mock.results.map((result) => result.value),
  );
  expect(starts).toBe(0);
  expect(f.calls).toHaveLength(1);
  const final = await view(f, group.groupId);
  expect(final.cancelled).toBe(true);
  expect(final.members.map((m) => m.state)).toEqual([
    'launch-intent',
    'pending',
  ]);
}, 30_000);

test('running and needs-input members occupy a seat until observed terminal; disconnect requests interruption without asserting a stop', async () => {
  const f = fixture();
  f.setBeforeDispatch(async (input) => {
    f.statuses.set(input.sessionId!, 'needs_input');
  });
  const { group } = await f.create([member('first'), member('second')], 1);
  const abort = new AbortController();
  const running = f.request(
    `/session-groups/${group.groupId}/run`,
    {},
    { signal: abort.signal },
  );
  await waitFor(() => f.observeDelegatedTask.mock.calls.length > 0);
  await waitFor(() => f.calls.length === 1);
  const firstSessionId = f.calls[0].sessionId!;
  await waitFor(
    async () =>
      (await view(f, group.groupId)).members[0].attention?.kind ===
      'needs-input',
  );
  const blockedRevision = (await view(f, group.groupId)).revision;
  await delay(300);
  expect((await view(f, group.groupId)).revision).toBe(blockedRevision);
  expect(f.calls).toHaveLength(1);
  f.statuses.set(firstSessionId, 'running');
  await waitFor(
    async () =>
      (await view(f, group.groupId)).members[0].attention === undefined,
  );
  abort.abort();
  await running;
  expect(f.interruptDelegatedTask).toHaveBeenCalled();
  expect(f.interruptDelegatedTask.mock.calls.at(-1)?.[0]).toMatchObject({
    taskId: firstSessionId,
    turnId: `turn:${firstSessionId}`,
  });
  expect((await view(f, group.groupId)).members.map((m) => m.state)).toEqual([
    'started',
    'pending',
  ]);
}, 30_000);

test('the accepted initial completion closes its Flow step while a later conversation turn is still running', async () => {
  const f = fixture();
  f.setBeforeDispatch(async (input) => {
    f.statuses.set(input.sessionId!, 'running');
    f.completedInitialTurns.add(input.sessionId!);
  });
  const { group } = await f.create(
    [member('first'), member('second', ['first'])],
    1,
  );
  const abort = new AbortController();
  const run = f.request(
    `/session-groups/${group.groupId}/run`,
    {},
    { signal: abort.signal },
  );
  try {
    await waitFor(
      async () => (await view(f, group.groupId)).flow?.status === 'completed',
    );
    await run;
    expect(f.calls).toHaveLength(2);
    expect(f.interruptDelegatedTask).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    await run;
  }
}, 10_000);

test('a canceled initial completion is retained as canceled and cannot satisfy the required successor', async () => {
  const f = fixture();
  f.setBeforeDispatch(async (input) => {
    f.cancelledInitialTurns.add(input.sessionId!);
  });
  const { group } = await f.create(
    [member('first'), member('second', ['first'])],
    1,
  );
  await f.request(`/session-groups/${group.groupId}/run`, {});
  const observed = await view(f, group.groupId);
  expect(f.calls).toHaveLength(1);
  expect(observed.members[0].outcome).toBe('canceled');
  expect(observed.members[0].terminalEvent?.turnId).toBe(
    observed.members[0].handle?.initialTurnId,
  );
  expect(observed.members[1].state).toBe('pending');
  expect(observed.flow?.status).not.toBe('completed');
});

test.each(['other', undefined] as const)(
  'an initial completion with unproven finish reason %s cannot release a dependent seat',
  async (reason) => {
    const f = fixture();
    f.setBeforeDispatch(async (input) => {
      f.initialFinishReasons.set(input.sessionId!, reason);
    });
    const { group } = await f.create(
      [member('first'), member('second', ['first'])],
      1,
    );
    const abort = new AbortController();
    const run = f.request(
      `/session-groups/${group.groupId}/run`,
      {},
      { signal: abort.signal },
    );
    try {
      await waitFor(() => f.windowReads.length > 1 || f.calls.length > 1);
      const observed = await view(f, group.groupId);
      expect(f.calls).toHaveLength(1);
      expect(observed.members.map((member) => member.state)).toEqual([
        'started',
        'pending',
      ]);
      expect(observed.members[0].outcome).toBeUndefined();
      expect(observed.flow?.status).not.toBe('completed');
    } finally {
      abort.abort();
      await run;
    }
  },
);

test.each(['max-tokens', 'tool-calls'] as const)(
  'a provider-proven %s initial completion still releases the Flow join',
  async (reason) => {
    const f = fixture();
    f.setBeforeDispatch(async (input) => {
      f.initialFinishReasons.set(input.sessionId!, reason);
    });
    const { group } = await f.create(
      [member('first'), member('second', ['first'])],
      1,
    );
    await f.request(`/session-groups/${group.groupId}/run`, {});
    expect(f.calls).toHaveLength(2);
    expect((await view(f, group.groupId)).flow?.status).toBe('completed');
  },
);

test.each([
  ['failed', 'runtime.error'],
  ['canceled', 'turn.aborted'],
] as const)(
  '%s initial-turn terminals do not release downstream seats',
  async (status, method) => {
    const f = fixture();
    f.setBeforeDispatch(async (input) => {
      f.statuses.set(input.sessionId!, status);
      f.terminalMethods.set(input.sessionId!, method);
    });
    const { group } = await f.create(
      [member('first'), member('second', ['first'])],
      1,
    );
    await f.request(`/session-groups/${group.groupId}/run`, {});
    expect(f.calls).toHaveLength(1);
    expect((await view(f, group.groupId)).members.map((m) => m.state)).toEqual([
      'terminal',
      'pending',
    ]);
  },
  30_000,
);

test('operation replay is inert, conflicting intent refuses, and another credential cannot read the group', async () => {
  const f = fixture();
  const { group, body } = await f.create();
  const replay = await f.request('/session-groups', body);
  expect(replay.status).toBe(200);
  expect(
    ((await replay.json()) as { data: CliSessionGroupView }).data.groupId,
  ).toBe(group.groupId);
  expect(
    (await f.request('/session-groups', { ...body, maxConcurrent: 1 })).status,
  ).toBe(409);
  expect(
    (
      await f.request(`/session-groups/${group.groupId}`, undefined, {
        headers: { 'fixture-binding': 'other-credential' },
      })
    ).status,
  ).toBe(404);
  const listed = await f.request('/session-groups');
  expect(
    (
      (await listed.json()) as { data: { groups: CliSessionGroupView[] } }
    ).data.groups.map((value) => value.groupId),
  ).toEqual([group.groupId]);
  const foreign = await f.request('/session-groups', undefined, {
    headers: { 'fixture-binding': 'other-credential' },
  });
  expect(
    ((await foreign.json()) as { data: { groups: CliSessionGroupView[] } }).data
      .groups,
  ).toEqual([]);
  f.revoke();
  expect(
    (await f.request(`/session-groups/${group.groupId}/run`, {})).status,
  ).toBe(403);
  expect(f.calls).toHaveLength(0);
});

test('group launch retains the ordinary full-access refusal instead of calling the delegate directly', async () => {
  const f = fixture();
  const full = member('first');
  const { group } = await f.create(
    [
      {
        ...full,
        target: {
          ...full.target,
          model: { options: { approvalMode: 'never' } },
        },
      },
      member('dependent', ['first']),
    ],
    1,
  );
  await f.request(`/session-groups/${group.groupId}/run`, {});
  expect(f.calls).toHaveLength(0);
  const refused = await view(f, group.groupId);
  expect(refused.members.map((seat) => seat.state)).toEqual([
    'terminal',
    'pending',
  ]);
  expect(refused.members[0]?.outcome).toBe('failed');
  expect(refused.members[0]?.handle).toBeUndefined();
  expect(refused.members[0]?.terminalEvent).toBeUndefined();
  expect(f.interruptDelegatedTask).not.toHaveBeenCalled();
  expect((await view(f, group.groupId)).members[0]?.dispatchFailure).toEqual({
    status: 403,
    code: 'approval-full-access-not-granted',
  });
  const reopened = fixture(f.home);
  await reopened.request(`/session-groups/${group.groupId}/run`, {});
  expect(reopened.calls).toHaveLength(0);
  expect((await view(reopened, group.groupId)).members).toEqual(
    refused.members,
  );
}, 30_000);

test.each(['completed', 'failed', 'canceled'])(
  'a %s snapshot without the initial-turn terminal cannot release its seat',
  async (status) => {
    const f = fixture();
    f.setBeforeDispatch(async (input) => {
      f.terminalTurns.set(input.sessionId!, 'unrelated-turn');
      f.elidedRetryErrors.add(input.sessionId!);
      f.statuses.set(input.sessionId!, status);
    });
    const { group } = await f.create(
      [member('first'), member('second', ['first'])],
      1,
    );
    const abort = new AbortController();
    const running = f.request(
      `/session-groups/${group.groupId}/run`,
      {},
      { signal: abort.signal },
    );
    try {
      await waitFor(() => f.windowReads.length > 0);
      await delay(300);
      expect(f.calls).toHaveLength(1);
      expect(
        (await view(f, group.groupId)).members.map((m) => m.state),
      ).toEqual(['started', 'pending']);
      f.terminalTurns.clear();
      f.statuses.clear();
      f.setBeforeDispatch(async () => {});
      await running;
      expect(f.calls).toHaveLength(2);
      expect((await view(f, group.groupId)).flow?.status).toBe('completed');
    } finally {
      abort.abort();
      await running;
    }
  },
  30_000,
);

test('group inventory pages do not lose credential-owned records or expose private briefs', async () => {
  const f = fixture();
  const { body } = await f.create([member('one')], 1);
  const expected = new Set<string>();
  const first = await f.request('/session-groups');
  for (const group of (
    (await first.json()) as { data: { groups: CliSessionGroupView[] } }
  ).data.groups)
    expected.add(group.groupId);
  for (let i = 1; i <= 16; i += 1) {
    const created = await f.request('/session-groups', {
      ...body,
      operationId: `page-${i}`,
    });
    expect(created.status).toBe(200);
    expected.add(
      ((await created.json()) as { data: CliSessionGroupView }).data.groupId,
    );
  }
  const page = await f.request('/session-groups');
  const pageText = await page.text();
  const one = JSON.parse(pageText) as {
    data: {
      groups: CliSessionGroupView[];
      hasMore: boolean;
      nextGroupId: string;
    };
  };
  expect(one.data.groups).toHaveLength(16);
  expect(one.data.hasMore).toBe(true);
  expect(pageText).not.toContain('private brief');
  const next = await f.request(
    `/session-groups?afterGroupId=${encodeURIComponent(one.data.nextGroupId)}`,
  );
  const two = (await next.json()) as {
    data: {
      groups: CliSessionGroupView[];
      hasMore: boolean;
      nextGroupId: string | null;
    };
  };
  expect(two.data.groups).toHaveLength(1);
  expect(two.data.hasMore).toBe(false);
  expect(two.data.nextGroupId).toBeNull();
  expect(
    new Set(
      [...one.data.groups, ...two.data.groups].map((group) => group.groupId),
    ),
  ).toEqual(expected);
  expect(f.calls).toHaveLength(0);
}, 30_000);
