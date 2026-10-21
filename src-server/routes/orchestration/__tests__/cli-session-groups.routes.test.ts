import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
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
  const interruptDelegatedTask = vi.fn(async () => ({
    interruptOutcome: 'requested',
  }));
  const app = createOrchestrationRoutes(
    {
      readSessionEventWindow: async (threadId: string) => {
        windowReads.push(threadId);
        return {
          events:
            statuses.get(threadId) && statuses.get(threadId) !== 'completed'
              ? []
              : [
                  {
                    event: {
                      eventId: `event:${threadId}`,
                      threadId,
                      turnId: terminalTurns.get(threadId) ?? `turn:${threadId}`,
                      method: 'turn.completed',
                    },
                  },
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
  ) => {
    const body = {
      operationId: 'create-one',
      members,
      maxConcurrent,
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
    windowReads,
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
async function waitFor(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), {
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
}, 30_000);

test('an ambiguous start stays occupied across reopen and never authorizes another launch', async () => {
  const f = fixture();
  f.setBeforeDispatch(async () => {
    throw new Error('lost member acknowledgement');
  });
  const { group } = await f.create([member('first'), member('second')], 1);
  await f.request(`/session-groups/${group.groupId}/run`, {});
  expect(f.calls).toHaveLength(1);
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
  await delay(300);
  expect(f.calls).toHaveLength(1);
  abort.abort();
  await running;
  expect(f.interruptDelegatedTask).toHaveBeenCalled();
  expect((await view(f, group.groupId)).members.map((m) => m.state)).toEqual([
    'started',
    'pending',
  ]);
}, 30_000);

test('failed prerequisites do not release downstream seats', async () => {
  const f = fixture();
  f.setBeforeDispatch(async (input) => {
    f.statuses.set(input.sessionId!, 'failed');
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
}, 30_000);

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
    ],
    1,
  );
  await f.request(`/session-groups/${group.groupId}/run`, {});
  expect(f.calls).toHaveLength(0);
  expect((await view(f, group.groupId)).members[0]?.state).toBe(
    'launch-intent',
  );
  expect((await view(f, group.groupId)).members[0]?.dispatchFailure).toEqual({
    status: 403,
    code: 'approval-full-access-not-granted',
  });
}, 30_000);

test('a completed snapshot from a different provider turn cannot release a dependent seat', async () => {
  const f = fixture();
  f.setBeforeDispatch(async (input) => {
    f.terminalTurns.set(input.sessionId!, 'unrelated-turn');
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
    expect((await view(f, group.groupId)).members.map((m) => m.state)).toEqual([
      'started',
      'pending',
    ]);
    f.terminalTurns.clear();
    f.setBeforeDispatch(async () => {});
    await running;
    expect(f.calls).toHaveLength(2);
    expect((await view(f, group.groupId)).flow?.status).toBe('completed');
  } finally {
    abort.abort();
    await running;
  }
}, 30_000);
