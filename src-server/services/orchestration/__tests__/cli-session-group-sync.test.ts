import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Flow from '@kontourai/flow';
import { expect, test, vi } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type CliSessionGroupHost,
  CliSessionGroups,
} from '../cli-session-group.js';

vi.mock('@kontourai/flow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kontourai/flow')>();
  return { ...actual, loadRun: vi.fn(actual.loadRun) };
});

const temporary = trackTempDirs();

async function fixture() {
  const home = temporary('station-sync-owner-');
  const groups = new CliSessionGroups(
    home,
    (value) => z.string().parse(value),
    {},
  );
  const host: CliSessionGroupHost<string> = {
    assertCurrent() {},
    async prepareSync() {},
    async dispatch(_input, admission) {
      return {
        taskId: admission.sessionId,
        conversationId: admission.sessionId,
        sessionId: admission.sessionId,
        initialTurnId: 'initial',
      };
    },
    async observe(handle) {
      return {
        sessionId: handle.sessionId,
        status: 'completed',
        completedEvent: { eventId: 'initial-event', turnId: 'initial' },
      };
    },
    async interrupt() {},
  };
  const group = await groups.create(
    'owner',
    'create',
    {
      seats: [{ seatId: 'lead', needs: [], input: 'private brief' }],
      maxConcurrent: 1,
      deadlineAt: Date.now() + 60_000,
    },
    () => {},
  );
  await groups.run(group.groupId, 'owner', host, new AbortController().signal);
  const input = {
    operationId: 'sync-one',
    runId: 'run-one',
    content: 'complete folded result',
    deadlineAt: Date.now() + 60_000,
  };
  const readDisk = () =>
    JSON.parse(
      readFileSync(
        join(home, 'runtime', 'cli-session-groups', `${group.groupId}.json`),
        'utf8',
      ),
    );
  return { home, groups, group, host, input, readDisk };
}

test('reserves before effects, retries only the completed exact-text mismatch, and never replays either turn', async () => {
  const f = await fixture();
  const clientTurns: string[] = [];
  f.host.sync = vi.fn(async (handle, input) => {
    const member = f.readDisk().syncs[0].members[0];
    clientTurns.push(input.clientTurnId);
    expect(member).toMatchObject({
      status: 'unknown',
      attempts: clientTurns.length,
    });
    expect(input.prompt).toContain(f.input.content);
    return {
      sessionId: handle.sessionId,
      turnId: `sync-${clientTurns.length}`,
      terminalEventId: `terminal-${clientTurns.length}`,
      output:
        clientTurns.length === 1 ? 'ACK SYNC run-one\n' : 'ACK SYNC run-one',
      toolCalls: 0,
      nativeIdentityHash: `sha256:${'a'.repeat(64)}`,
    };
  });
  const result = await f.groups.sync(
    f.group.groupId,
    'owner',
    f.input,
    f.host,
    new AbortController().signal,
  );
  expect(result.contextSync).toMatchObject({
    status: 'acknowledged',
    contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    members: [
      {
        seatId: 'lead',
        attempts: 2,
        status: 'acknowledged',
        turnId: 'sync-2',
        terminalEventId: 'terminal-2',
      },
    ],
  });
  expect(new Set(clientTurns).size).toBe(2);
  const reopened = new CliSessionGroups(
    f.home,
    (value) => z.string().parse(value),
    {},
  );
  expect(
    (
      await reopened.sync(
        f.group.groupId,
        'owner',
        f.input,
        f.host,
        new AbortController().signal,
      )
    ).contextSync,
  ).toEqual(result.contextSync);
  expect(f.host.sync).toHaveBeenCalledTimes(2);
  await expect(
    reopened.sync(
      f.group.groupId,
      'owner',
      { ...f.input, content: 'changed' },
      f.host,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'group_conflict' });
  f.host.sync = vi.fn(async (handle) => ({
    sessionId: handle.sessionId,
    turnId: 'newer-sync',
    terminalEventId: 'newer-terminal',
    output: 'ACK SYNC run-two',
    toolCalls: 0,
    nativeIdentityHash: `sha256:${'a'.repeat(64)}`,
  }));
  const newer = await reopened.sync(
    f.group.groupId,
    'owner',
    {
      ...f.input,
      operationId: 'sync-two',
      runId: 'run-two',
      content: 'newer folded result',
    },
    f.host,
    new AbortController().signal,
  );
  expect(newer.contextSync?.operationId).toBe('sync-two');
  const olderReplay = await reopened.sync(
    f.group.groupId,
    'owner',
    f.input,
    f.host,
    new AbortController().signal,
  );
  expect(olderReplay.contextSync).toEqual(result.contextSync);
  expect((await reopened.view(f.group.groupId, 'owner')).contextSync).toEqual(
    newer.contextSync,
  );
  expect(f.host.sync).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(f.input.content);
  expect(
    (await reopened.events(f.group.groupId, 'owner', 0)).events.some(
      (event) => event.contextSync?.status === 'acknowledged',
    ),
  ).toBe(true);
});

test.each(['ambiguous', 'tool-call'] as const)(
  'does not retry %s and discloses incomplete sync after reopening',
  async (mode) => {
    const f = await fixture();
    f.host.sync = vi.fn(async (handle) => {
      if (mode === 'ambiguous') throw new Error('possible provider effect');
      return {
        sessionId: handle.sessionId,
        turnId: 'sync-turn',
        terminalEventId: 'sync-terminal',
        output: 'ACK SYNC run-one',
        toolCalls: 1,
        nativeIdentityHash: `sha256:${'a'.repeat(64)}`,
      };
    });
    const result = await f.groups.sync(
      f.group.groupId,
      'owner',
      f.input,
      f.host,
      new AbortController().signal,
    );
    expect(result.contextSync).toMatchObject({
      status: 'incomplete',
      members: [
        { attempts: 1, status: mode === 'ambiguous' ? 'unknown' : 'failed' },
      ],
    });
    if (mode === 'ambiguous') {
      const interrupted = f.readDisk();
      interrupted.syncs[0].status = 'syncing';
      writeFileSync(
        join(
          f.home,
          'runtime',
          'cli-session-groups',
          `${f.group.groupId}.json`,
        ),
        JSON.stringify(interrupted),
      );
    }
    const reopened = new CliSessionGroups(
      f.home,
      (value) => z.string().parse(value),
      {},
    );
    const replay = await reopened.sync(
      f.group.groupId,
      'owner',
      f.input,
      f.host,
      new AbortController().signal,
    );
    expect(replay.supervision).toBe('not-running');
    expect(replay.contextSync?.status).toBe('incomplete');
    expect((await reopened.view(f.group.groupId, 'owner')).contextSync).toEqual(
      replay.contextSync,
    );
    expect(f.host.sync).toHaveBeenCalledOnce();
    await expect(
      reopened.sync(
        f.group.groupId,
        'foreign',
        f.input,
        f.host,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'group_not_found' });
    expect(f.host.sync).toHaveBeenCalledOnce();
  },
);

test('unsupported retained members refuse before any reserved sync attempt or provider effect', async () => {
  const f = await fixture();
  f.host.prepareSync = async () => {
    throw new Error('unsupported runtime');
  };
  f.host.sync = vi.fn();
  await expect(
    f.groups.sync(
      f.group.groupId,
      'owner',
      f.input,
      f.host,
      new AbortController().signal,
    ),
  ).rejects.toThrow('unsupported runtime');
  const result = await f.groups.view(f.group.groupId, 'owner');
  expect(result.contextSync).toMatchObject({
    status: 'incomplete',
    members: [{ status: 'pending', attempts: 0 }],
  });
  expect(f.host.sync).not.toHaveBeenCalled();
});

test('a current group view refuses a stored revision changed while its Flow read awaited', async () => {
  const f = await fixture();
  const actual =
    await vi.importActual<typeof import('@kontourai/flow')>('@kontourai/flow');
  const before = f.readDisk().revision;
  let changed = false;
  vi.mocked(Flow.loadRun).mockImplementation(async (...args) => {
    const run = await actual.loadRun(...args);
    if (!changed) {
      changed = true;
      await f.groups.cancel(f.group.groupId, 'owner', f.host);
    }
    return run;
  });
  try {
    await expect(
      f.groups.view(f.group.groupId, 'owner', undefined, {
        requireCurrent: true,
      }),
    ).rejects.toMatchObject({ code: 'group_snapshot_changed' });
    expect(changed).toBe(true);
    expect((await f.groups.view(f.group.groupId, 'owner')).revision).toBe(
      before + 1,
    );
  } finally {
    vi.mocked(Flow.loadRun).mockImplementation(actual.loadRun);
  }
});
