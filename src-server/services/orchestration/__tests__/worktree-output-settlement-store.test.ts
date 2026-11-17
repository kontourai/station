import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorktreeOutputSettlement } from '@kontourai/station-contracts/workspace-isolation';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { WORKTREE_OUTPUT_SETTLEMENTS_MIGRATION } from '../../../domain/migrations/029-worktree-output-settlements.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function setup() {
  const path = join(makeTempDir('worktree-settlement-store-'), 'orch.sqlite');
  const events = new EventStore(path);
  closers.push(async () => {
    await events.close();
  });
  return { path, store: events.worktreeOutputSettlementStore() };
}

const record = (
  overrides: Partial<WorktreeOutputSettlement> = {},
): WorktreeOutputSettlement => ({
  sessionId: 'session-a',
  state: 'settled',
  outcome: 'kept',
  actor: { kind: 'person', id: 'human:test:owner' },
  requestKey: 'kept-1',
  repoPath: '/repo',
  worktreePath: '/repo-worktrees/session-a',
  branch: 'station/session/session-a',
  baseRef: 'HEAD',
  baseCommit: 'b'.repeat(40),
  headCommit: 'c'.repeat(40),
  evidence: { containingCommit: 'd'.repeat(40) },
  requestedAt: '2026-11-11T00:00:00.000Z',
  settledAt: '2026-11-11T00:00:00.000Z',
  ...overrides,
});

describe('worktree output settlement store over real orchestration SQLite (#4771)', () => {
  test('a second insert for a Session finds the first and changes nothing', () => {
    const { store } = setup();
    const first = store.insert({ requestDigest: 'sha256:a', record: record() });
    expect(first.kind).toBe('inserted');

    const second = store.insert({
      requestDigest: 'sha256:b',
      record: record({
        outcome: 'discarded',
        requestKey: 'discard-1',
        actor: { kind: 'person', id: 'human:test:other' },
        evidence: { removedWorktree: true, removedBranch: true },
      }),
    });

    expect(second).toEqual({ kind: 'exists', stored: first.stored });
    expect(store.read('session-a')).toEqual(first.stored);
  });

  test('a settled record cannot be settled again, abandoned, updated or deleted', () => {
    const { path, store } = setup();
    const { stored } = store.insert({
      requestDigest: 'sha256:a',
      record: record(),
    });
    expect(() =>
      store.settlePending({
        sessionId: 'session-a',
        requestKey: 'kept-1',
        evidence: {},
        settledAt: '2026-11-12T00:00:00.000Z',
      }),
    ).toThrow(/No pending/);
    store.abandonPending('session-a', 'kept-1');
    expect(store.read('session-a')).toEqual(stored);

    // Another connection writing to the table directly meets the triggers.
    const raw = new DatabaseSync(path);
    closers.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "UPDATE worktree_output_settlements SET outcome = 'discarded' WHERE session_id = ?",
        )
        .run('session-a'),
    ).toThrow(/final/);
    expect(() =>
      raw
        .prepare('DELETE FROM worktree_output_settlements WHERE session_id = ?')
        .run('session-a'),
    ).toThrow(/final/);
    expect(store.read('session-a')).toEqual(stored);
  });

  test('a pending discard is settled once by its own request key, or abandoned', () => {
    const { store } = setup();
    const pending = record({
      state: 'pending',
      outcome: 'discarded',
      requestKey: 'discard-1',
      evidence: { acceptedUncommittedLoss: false },
    });
    delete pending.settledAt;
    store.insert({ requestDigest: 'sha256:a', record: pending });
    expect(() =>
      store.settlePending({
        sessionId: 'session-a',
        requestKey: 'discard-other',
        evidence: {},
        settledAt: '2026-11-12T00:00:00.000Z',
      }),
    ).toThrow(/No pending/);

    store.abandonPending('session-a', 'discard-1');
    expect(store.read('session-a')).toBeUndefined();

    store.insert({ requestDigest: 'sha256:a', record: pending });
    const settled = store.settlePending({
      sessionId: 'session-a',
      requestKey: 'discard-1',
      evidence: { removedWorktree: true, removedBranch: true },
      settledAt: '2026-11-12T00:00:00.000Z',
    });
    expect(settled.record).toMatchObject({
      state: 'settled',
      outcome: 'discarded',
      evidence: { removedWorktree: true, removedBranch: true },
      settledAt: '2026-11-12T00:00:00.000Z',
    });
  });

  test('the schema refuses a pending row for anything but a discard', () => {
    const { store } = setup();
    const pendingKept = record({ state: 'pending' });
    delete pendingKept.settledAt;
    expect(() =>
      store.insert({ requestDigest: 'sha256:a', record: pendingKept }),
    ).toThrow(/CHECK constraint/);
    expect(store.read('session-a')).toBeUndefined();
  });
});

describe('a database made by the first build of migration 029 (#4771)', () => {
  test('gains the owner column on open, and a pending intent keeps its owner', async () => {
    const path = join(makeTempDir('worktree-settlement-old-'), 'orch.sqlite');
    const firstBuild = WORKTREE_OUTPUT_SETTLEMENTS_MIGRATION.replace(
      /^\s*owner_json .*\n/m,
      '',
    );
    expect(firstBuild).not.toContain('owner_json');
    const old = new DatabaseSync(path);
    old.exec(firstBuild);
    old.close();

    const events = new EventStore(path);
    closers.push(async () => {
      await events.close();
    });
    const store = events.worktreeOutputSettlementStore();
    const owner = {
      id: 'writer',
      pid: 4242,
      identityKind: 'exact',
      birth: 'birth-1',
    } as const;
    const pending = record({
      state: 'pending',
      outcome: 'discarded',
      requestKey: 'discard-1',
      evidence: {},
    });
    delete pending.settledAt;
    expect(
      store.insert({ requestDigest: 'sha256:a', owner, record: pending }).kind,
    ).toBe('inserted');
    expect(store.read('session-a')?.owner).toEqual(owner);
  });

  test('a malformed stored owner is dropped, never judged', () => {
    const { path, store } = setup();
    const pending = record({
      state: 'pending',
      outcome: 'discarded',
      requestKey: 'discard-1',
      evidence: {},
    });
    delete pending.settledAt;
    store.insert({ requestDigest: 'sha256:a', record: pending });
    const raw = new DatabaseSync(path);
    closers.push(() => raw.close());
    raw
      .prepare(
        'UPDATE worktree_output_settlements SET owner_json = ? WHERE session_id = ?',
      )
      .run(
        JSON.stringify({ id: 'x', pid: -1, identityKind: 'exact' }),
        'session-a',
      );
    expect(store.read('session-a')?.owner).toBeUndefined();
  });
});
