import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type CliSessionGroupHost,
  CliSessionGroups,
} from '../cli-session-group.js';

const temporary = trackTempDirs();
type Sync = NonNullable<CliSessionGroupHost<string>['sync']>;
const nativeIdentityHash = `sha256:${'a'.repeat(64)}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function fixture(seatCount = 1) {
  const home = temporary('station-sync-owner-');
  const open = () => new CliSessionGroups(home, (input) => String(input), {});
  const groups = open();
  const host: CliSessionGroupHost<string> = {
    assertCurrent() {},
    assertStopCurrent() {},
    async prepareSync() {},
    async dispatch(_input, admission) {
      admission.assertCurrent();
      return {
        taskId: admission.sessionId,
        conversationId: admission.sessionId,
        sessionId: admission.sessionId,
        initialTurnId: `initial-${admission.sessionId}`,
      };
    },
    async observe(handle) {
      return {
        sessionId: handle.sessionId,
        status: 'completed',
        completedEvent: {
          eventId: `terminal-${handle.sessionId}`,
          turnId: handle.initialTurnId!,
        },
      };
    },
    async interrupt() {},
  };
  const group = await groups.create(
    'owner',
    'create',
    {
      seats: Array.from({ length: seatCount }, (_, index) => ({
        seatId: `member-${index}`,
        needs: [],
        input: 'initial group brief',
      })),
      maxConcurrent: 1,
      deadlineAt: Date.now() + 60_000,
    },
    host.assertCurrent,
  );
  await groups.run(group.groupId, 'owner', host, new AbortController().signal);
  const input = {
    operationId: 'sync-one',
    runId: 'run-one',
    content: 'private folded result',
    deadlineAt: Date.now() + 60_000,
  };
  const root = join(home, 'runtime', 'cli-session-groups');
  const prefix = `${group.groupId}.json`;
  const readBytes = () => readFileSync(join(root, prefix), 'utf8');
  return {
    groupId: group.groupId,
    groups,
    open,
    host,
    input,
    root,
    prefix,
    readBytes,
    readDisk: () => JSON.parse(readBytes()),
    sync: (signal = new AbortController().signal) =>
      groups.sync(group.groupId, 'owner', input, host, signal),
  };
}

function receipt(
  handle: Parameters<Sync>[0],
  turnId: string,
  output = 'ACK SYNC run-one',
) {
  return {
    sessionId: handle.sessionId,
    turnId,
    terminalEventId: `terminal-${turnId}`,
    nativeIdentityHash,
    output,
    toolCalls: 0,
  };
}

test('preflight cannot replace the captured context or ACK identity', async () => {
  const f = await fixture();
  const original = { ...f.input };
  f.host.prepareSync = async () => {
    f.input.operationId = 'changed-operation';
    f.input.content = 'changed borrowed context';
    f.input.runId = 'changed-run';
    f.input.deadlineAt = 1;
  };
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    expect(input.prompt).toContain('ACK SYNC run-one');
    expect(input.prompt).toMatch(/\n\nprivate folded result$/);
    return receipt(handle, 'new-turn');
  });
  f.host.sync = send;

  const result = await f.sync();
  expect(result.contextSync).toMatchObject({
    operationId: original.operationId,
    runId: original.runId,
    contentHash: `sha256:${createHash('sha256').update(original.content).digest('hex')}`,
    status: 'acknowledged',
    members: [{ attempts: 1, status: 'acknowledged', turnId: 'new-turn' }],
  });
  expect(send).toHaveBeenCalledOnce();
  expect(f.readBytes()).not.toContain(original.content);
  expect(JSON.stringify(result)).not.toContain(original.content);
});

test('all members must pass preflight before an operation or attempt is published', async () => {
  const f = await fixture(2);
  const before = f.readBytes();
  const prepare = vi.fn(async () => {});
  prepare
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('member runtime is unavailable'));
  f.host.prepareSync = prepare;
  const send = vi.fn<Sync>();
  f.host.sync = send;

  await expect(f.sync()).rejects.toThrow('member runtime is unavailable');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
  expect(f.readBytes()).toBe(before);
});

test('reserves attempts before effects and retries one definite no-tool text mismatch', async () => {
  const f = await fixture();
  const clientTurns: string[] = [];
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    clientTurns.push(input.clientTurnId);
    const attempt = clientTurns.length;
    expect(f.readDisk().syncs[0].members[0]).toMatchObject({
      status: 'unknown',
      attempts: attempt,
    });
    return receipt(
      handle,
      `sync-turn-${attempt}`,
      attempt === 1 ? 'ACK SYNC run-one\n' : 'ACK SYNC run-one',
    );
  });
  f.host.sync = send;
  const first = await f.sync();
  expect(first.contextSync).toMatchObject({
    status: 'acknowledged',
    members: [
      {
        status: 'acknowledged',
        attempts: 2,
        turnId: 'sync-turn-2',
        terminalEventId: 'terminal-sync-turn-2',
      },
    ],
  });
  expect(new Set(clientTurns).size).toBe(2);
  expect(send).toHaveBeenCalledTimes(2);

  f.host.sync = async (handle) =>
    receipt(handle, 'other-turn', 'ACK SYNC run-two');
  const newer = await f.groups.sync(
    f.groupId,
    'owner',
    {
      ...f.input,
      operationId: 'sync-two',
      runId: 'run-two',
      content: 'new folded result',
    },
    f.host,
    new AbortController().signal,
  );
  expect(newer.contextSync?.operationId).toBe('sync-two');
  const beforeReplay = f.readBytes();
  const reopened = f.open();
  const replay = await reopened.sync(
    f.groupId,
    'owner',
    { ...f.input, deadlineAt: 1 },
    { ...f.host, prepareSync: undefined, sync: undefined },
    new AbortController().signal,
  );
  expect(replay.supervision).toBe('not-running');
  expect(replay.contextSync).toEqual(first.contextSync);
  expect((await reopened.view(f.groupId, 'owner')).contextSync).toEqual(
    newer.contextSync,
  );
  await expect(
    reopened.sync(
      f.groupId,
      'owner',
      { ...f.input, content: 'different' },
      f.host,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'group_conflict' });
  await expect(
    reopened.sync(
      f.groupId,
      'other-owner',
      f.input,
      f.host,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'group_not_found' });
  expect(f.readBytes()).toBe(beforeReplay);
});

test.each([
  'uncertain',
  'foreign-session',
  'initial-turn',
  'tool-call',
] as const)('does not retry a %s result', async (kind) => {
  const f = await fixture();
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    if (kind === 'uncertain') throw new Error('provider result was lost');
    return {
      ...receipt(
        handle,
        kind === 'initial-turn' ? handle.initialTurnId! : 'known-turn',
      ),
      ...(kind === 'foreign-session' ? { sessionId: 'other' } : {}),
      ...(kind === 'tool-call' ? { toolCalls: 1 } : {}),
    };
  });
  f.host.sync = send;
  const result = await f.sync();
  expect(result.contextSync).toMatchObject({
    status: 'incomplete',
    members: [
      { attempts: 1, status: kind === 'tool-call' ? 'failed' : 'unknown' },
    ],
  });
  const before = f.readBytes();
  const reopened = f.open();
  expect(
    (
      await reopened.sync(
        f.groupId,
        'owner',
        f.input,
        f.host,
        new AbortController().signal,
      )
    ).contextSync,
  ).toEqual(result.contextSync);
  if (kind !== 'tool-call') {
    await expect(
      reopened.sync(
        f.groupId,
        'owner',
        { ...f.input, operationId: 'another-operation' },
        f.host,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'group_sync_unavailable' });
  }
  expect(f.readBytes()).toBe(before);
  expect(send).toHaveBeenCalledOnce();
});

test('a later attempt cannot claim the terminal evidence from its prior mismatch', async () => {
  const f = await fixture();
  let attempts = 0;
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    return receipt(
      handle,
      'first-terminal-turn',
      ++attempts === 1 ? 'ordinary mismatched result' : 'ACK SYNC run-one',
    );
  });
  f.host.sync = send;
  const outcome = await f.sync();
  expect(send).toHaveBeenCalledTimes(2);
  expect(outcome.contextSync).toMatchObject({
    status: 'incomplete',
    members: [
      {
        status: 'unknown',
        attempts: 2,
        turnId: 'first-terminal-turn',
        terminalEventId: 'terminal-first-terminal-turn',
      },
    ],
  });
});

test('stops an attempt publication if the credential expires after staging', async () => {
  const f = await fixture();
  let staged = false;
  f.host.assertCurrent = () => {
    if (staged) throw new Error('sync credential revoked after staging');
    const candidate = readdirSync(f.root).find(
      (name) => name.startsWith(`${f.prefix}.`) && name.endsWith('.tmp'),
    );
    if (!candidate) return;
    const attempted = JSON.parse(readFileSync(join(f.root, candidate), 'utf8'));
    if (attempted.syncs?.[0].members[0].attempts === 1) {
      staged = true;
      throw new Error('sync credential revoked after staging');
    }
  };
  const send = vi.fn<Sync>();
  f.host.sync = send;

  await expect(f.sync()).rejects.toThrow(
    'sync credential revoked after staging',
  );
  expect(staged).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect((await f.groups.view(f.groupId, 'owner')).contextSync).toMatchObject({
    status: 'incomplete',
    members: [{ attempts: 0, status: 'pending' }],
  });
  expect(readdirSync(f.root).some((name) => name.endsWith('.tmp'))).toBe(false);
});

test('retains the exact owned receipt even when response authority is withdrawn', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let current = true;
  f.host.assertCurrent = () => {
    if (!current) throw new Error('sync credential revoked');
  };
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    controller.abort();
    current = false;
    return receipt(handle, 'acknowledged-before-withdrawal');
  });
  f.host.sync = send;

  await expect(f.sync(controller.signal)).rejects.toThrow(
    'sync credential revoked',
  );
  await vi.waitFor(async () => {
    expect((await f.open().view(f.groupId, 'owner')).contextSync).toMatchObject(
      {
        status: 'acknowledged',
        members: [
          {
            attempts: 1,
            status: 'acknowledged',
            turnId: 'acknowledged-before-withdrawal',
          },
        ],
      },
    );
  });
  expect(send).toHaveBeenCalledOnce();
});

test('replay during a held attempt observes its reservation without starting or writing work', async () => {
  const f = await fixture();
  const started = deferred();
  const release = deferred();
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    started.resolve();
    await release.promise;
    return receipt(handle, 'only-turn');
  });
  f.host.sync = send;
  const running = f.sync();
  try {
    await Promise.race([
      started.promise,
      running.then(() => {
        throw new Error('Sync ended before reserving a turn');
      }),
    ]);
    const bytes = f.readBytes();
    const replay = await f.sync();
    expect(replay).toMatchObject({
      supervision: 'not-running',
      contextSync: {
        status: 'incomplete',
        operationId: f.input.operationId,
        members: [{ attempts: 1, status: 'unknown' }],
      },
    });
    expect(f.readBytes()).toBe(bytes);
    expect(send).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await running;
  }
  expect((await running).contextSync?.status).toBe('acknowledged');
});

test('an expired caller returns before a held attempt and its late receipt admits no retry', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  const send = vi.fn<Sync>(async (handle, input) => {
    input.assertCurrent();
    started.resolve();
    await release.promise;
    return receipt(
      handle,
      'late-exact-turn',
      'Completed without tools but mismatched',
    );
  });
  f.host.sync = send;
  let callerReturned = false;
  const caller = f
    .sync(controller.signal)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .then((result) => {
      callerReturned = true;
      return result;
    });
  try {
    await Promise.race([
      started.promise,
      caller.then(() => {
        throw new Error('Sync ended before reserving a turn');
      }),
    ]);
    controller.abort();
    await vi.waitFor(() => expect(callerReturned).toBe(true));
    expect(await caller).toMatchObject({
      error: { code: 'group_sync_interrupted' },
    });

    const beforeReplay = f.readBytes();
    expect(await f.sync()).toMatchObject({
      supervision: 'not-running',
      contextSync: {
        status: 'incomplete',
        members: [{ attempts: 1, status: 'unknown' }],
      },
    });
    expect(f.readBytes()).toBe(beforeReplay);
    await expect(
      f.groups.run(f.groupId, 'owner', f.host, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'group_unavailable' });
  } finally {
    release.resolve();
    await caller;
  }

  await vi.waitFor(async () => {
    expect(await f.groups.view(f.groupId, 'owner')).toMatchObject({
      supervision: 'not-running',
      contextSync: {
        status: 'incomplete',
        members: [
          {
            attempts: 1,
            status: 'failed',
            turnId: 'late-exact-turn',
            terminalEventId: 'terminal-late-exact-turn',
            toolCalls: 0,
          },
        ],
      },
    });
  });
  expect(send).toHaveBeenCalledOnce();
});
