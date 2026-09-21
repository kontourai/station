/**
 * #485 receiver request-claim slice — the durable execution-domain owner.
 *
 * Store-level proof (no mocks of the store itself; the real file-backed
 * implementation in a temp dir):
 *
 * - reserve returns exactly ONE owner token; same key + same digest joins
 *   the existing claim; a different digest under the same key conflicts;
 * - bounded and fail-closed: at capacity NEW claims refuse and NOTHING is
 *   evicted (old and unresolved keys survive);
 * - malformed stores fail closed (corrupt JSON, wrong version, array
 *   records, key mismatch, non-digest, unknown state all throw — a claim
 *   is never silently forgotten);
 * - a crash before the atomic rename commit leaves no claim AND releases
 *   the lock (the next reserve succeeds);
 * - owner transitions need the reserve-time token; terminal states stick;
 * - the lookup projection is closed (no prompt/path/digest) and `none` is
 *   never a resend authorization;
 * - the intent digest is stable over key order and covers the RAW intent
 *   only — resolved facts cannot be in it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  delegationAttemptIntentDigest,
  FileDelegationAttemptClaimStore,
  projectDelegationAttemptClaim,
} from '../delegation-attempt-claim-store.js';

let dir: string;
let store: FileDelegationAttemptClaimStore;

const INTENT = {
  prompt: 'Ship the portable thing',
  target: {
    environment: { kind: 'current' },
    agent: 'planner',
    workspace: {
      kind: 'project-portable',
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    },
  },
} as const;

function digest(): string {
  return delegationAttemptIntentDigest({
    prompt: INTENT.prompt,
    target: INTENT.target,
  });
}

function reserveInput(key = 'dev-1:attempt-1', attemptId = 'attempt-1') {
  return {
    key,
    attemptId,
    callerDeviceId: 'dev-1',
    intentDigest: digest(),
    taskId: 'task:reserved-1',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-attempt-claims-'));
  store = new FileDelegationAttemptClaimStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reserve — one owner, joins, conflicts', () => {
  test('the first reserve creates with exactly one owner token', async () => {
    const outcome = await store.reserve(reserveInput());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.ownerToken.length).toBeGreaterThan(0);
    const record = await store.read('dev-1:attempt-1');
    expect(record).toMatchObject({
      key: 'dev-1:attempt-1',
      attemptId: 'attempt-1',
      callerDeviceId: 'dev-1',
      intentDigest: digest(),
      taskId: 'task:reserved-1',
      state: 'reserved',
    });
  });

  test('same key + same digest joins the existing claim (no second token)', async () => {
    await store.reserve(reserveInput());
    const outcome = await store.reserve({
      ...reserveInput(),
      taskId: 'task:someone-else-minted',
    });
    expect(outcome.kind).toBe('existing');
    if (outcome.kind !== 'existing') return;
    // The join names the ORIGINAL reserved task — the duplicate never
    // mints (and never launches) another effect.
    expect(outcome.record.taskId).toBe('task:reserved-1');
    expect(outcome.record.state).toBe('reserved');
  });

  test('same key + different digest is a conflict — the first claim stands', async () => {
    await store.reserve(reserveInput());
    const outcome = await store.reserve({
      ...reserveInput(),
      intentDigest: delegationAttemptIntentDigest({
        prompt: 'A DIFFERENT validated prompt',
        target: INTENT.target,
      }),
      taskId: 'task:intruder',
    });
    expect(outcome.kind).toBe('conflict');
    const record = await store.read('dev-1:attempt-1');
    expect(record?.taskId).toBe('task:reserved-1');
    expect(record?.state).toBe('reserved');
  });

  test('different caller grants are different keys (no cross-grant join)', async () => {
    await store.reserve(reserveInput());
    const outcome = await store.reserve({
      ...reserveInput('dev-2:attempt-1', 'attempt-1'),
      callerDeviceId: 'dev-2',
    });
    expect(outcome.kind).toBe('created');
  });
});

describe('bounded fail-closed capacity — nothing is ever evicted', () => {
  test('at capacity NEW claims refuse; old and unresolved keys survive', async () => {
    const tiny = new FileDelegationAttemptClaimStore(dir, { capacity: 2 });
    const first = await tiny.reserve(reserveInput('dev-1:a', 'a'));
    expect(first.kind).toBe('created');
    const second = await tiny.reserve({
      ...reserveInput('dev-1:b', 'b'),
      taskId: 'task:reserved-2',
    });
    expect(second.kind).toBe('created');
    // Mark the second claim unresolved — the state most tempting to evict.
    if (first.kind === 'created') {
      await tiny.bindAdmitted('dev-1:a', first.ownerToken, {
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      });
      await tiny.markUnresolved('dev-1:a', first.ownerToken);
    }
    const refused = await tiny.reserve({
      ...reserveInput('dev-1:c', 'c'),
      taskId: 'task:reserved-3',
    });
    expect(refused.kind).toBe('capacity');
    // Nothing was evicted: both retained keys still read back intact.
    expect((await tiny.read('dev-1:a'))?.state).toBe('unresolved');
    expect((await tiny.read('dev-1:b'))?.state).toBe('reserved');
    expect(await tiny.read('dev-1:c')).toBeUndefined();
  });
});

describe('malformed stores fail closed — never forget a claim', () => {
  function writeStoreFile(content: string) {
    writeFileSync(join(dir, 'delegation-attempt-claims.json'), content);
  }

  test('corrupt JSON throws on reserve and on read', async () => {
    writeStoreFile('{ this is not json {{{');
    await expect(store.reserve(reserveInput())).rejects.toThrow();
    await expect(store.read('dev-1:attempt-1')).rejects.toThrow();
  });

  test('wrong version throws', async () => {
    writeStoreFile(JSON.stringify({ version: 999, records: {} }));
    await expect(store.reserve(reserveInput())).rejects.toThrow(
      /version 999 is not supported/,
    );
  });

  test.each([
    ['array records', { version: 1, records: [] }],
    ['null records', { version: 1, records: null }],
    [
      'key mismatch',
      {
        version: 1,
        records: {
          'dev-1:attempt-1': {
            key: 'dev-1:someone-else',
            attemptId: 'attempt-1',
            callerDeviceId: 'dev-1',
            intentDigest: digest(),
            taskId: 'task:reserved-1',
            state: 'reserved',
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
        },
      },
    ],
    [
      'non-digest',
      {
        version: 1,
        records: {
          'dev-1:attempt-1': {
            key: 'dev-1:attempt-1',
            attemptId: 'attempt-1',
            callerDeviceId: 'dev-1',
            intentDigest: 'new-hash',
            taskId: 'task:reserved-1',
            state: 'reserved',
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
        },
      },
    ],
    [
      'unknown state',
      {
        version: 1,
        records: {
          'dev-1:attempt-1': {
            key: 'dev-1:attempt-1',
            attemptId: 'attempt-1',
            callerDeviceId: 'dev-1',
            intentDigest: digest(),
            taskId: 'task:reserved-1',
            state: 'executing',
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
        },
      },
    ],
  ])('%s refuses rather than forgetting', async (_label, ledger) => {
    writeStoreFile(JSON.stringify(ledger));
    await expect(store.reserve(reserveInput())).rejects.toThrow(/malformed/);
  });

  test('a missing store file is the honest empty ledger (nothing was ever accepted)', async () => {
    await expect(store.read('dev-1:attempt-1')).resolves.toBeUndefined();
    const outcome = await store.reserve(reserveInput());
    expect(outcome.kind).toBe('created');
  });
});

describe('crash before commit leaves no claim and releases the lock', () => {
  test('a beforeCommit fault throws, commits nothing, and the next reserve succeeds', async () => {
    let failNextCommit = true;
    const faulting = new FileDelegationAttemptClaimStore(dir, {
      beforeCommit: () => {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('simulated crash before rename commit');
        }
      },
    });
    await expect(faulting.reserve(reserveInput())).rejects.toThrow(
      /simulated crash/,
    );
    // No partial commit: the claim is absent…
    expect(await faulting.read('dev-1:attempt-1')).toBeUndefined();
    // …and the lock was released: the retry reserves cleanly.
    const retry = await faulting.reserve(reserveInput());
    expect(retry.kind).toBe('created');
  });
});

describe('owner transitions — the reserve token is the only writer', () => {
  test('bind → accept is the durable-effect path; terminal states stick', async () => {
    const created = await store.reserve(reserveInput());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const token = created.ownerToken;
    // The token is an issuance marker threaded server-internally (never
    // from a request), not a capability secret — the state machine is the
    // enforcement. An empty token is rejected outright…
    expect(
      await store.bindAdmitted('dev-1:attempt-1', '', {
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      }),
    ).toEqual({ kind: 'not-owner' });
    expect(
      await store.bindAdmitted('dev-1:attempt-1', token, {
        provider: 'station-agent',
        modelId: 'm-1',
        projectSlug: 'local',
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
        localProjectId: 'local-project-1',
      }),
    ).toEqual({ kind: 'applied' });
    // …accept only from admitted…
    expect(await store.markAccepted('dev-1:attempt-1', token)).toEqual({
      kind: 'applied',
    });
    // …and accepted is terminal: refuse/unresolve go stale, never flip.
    expect(await store.markRefused('dev-1:attempt-1', token)).toEqual({
      kind: 'stale',
    });
    expect(await store.markUnresolved('dev-1:attempt-1', token)).toEqual({
      kind: 'stale',
    });
    expect((await store.read('dev-1:attempt-1'))?.state).toBe('accepted');
  });

  test('a clean pre-effect refusal is terminal and keeps the tombstone', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(
      await store.markRefused('dev-1:attempt-1', created.ownerToken),
    ).toEqual({ kind: 'applied' });
    // Refused keys never transition again — not even to unresolved.
    expect(
      await store.markUnresolved('dev-1:attempt-1', created.ownerToken),
    ).toEqual({ kind: 'not-owner' });
    const record = await store.read('dev-1:attempt-1');
    expect(record?.state).toBe('refused');
    expect(record?.taskId).toBe('task:reserved-1');
  });

  test('an indeterminate invocation stays revisable-but-never-resendable', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(
      await store.markUnresolved('dev-1:attempt-1', created.ownerToken),
    ).toEqual({ kind: 'applied' });
    // Unresolved is not terminal-terminal: it stays exactly there (no
    // transition out is offered), and the owner token is spent — a later
    // mutation by anyone else is not-owner.
    expect(
      await store.markAccepted('dev-1:attempt-1', created.ownerToken),
    ).toEqual({ kind: 'stale' });
    expect((await store.read('dev-1:attempt-1'))?.state).toBe('unresolved');
  });

  test('transitions on an absent key are not-owner (never applied)', async () => {
    expect(await store.markAccepted('dev-1:ghost', 'token')).toEqual({
      kind: 'not-owner',
    });
    expect(await store.markRefused('dev-1:ghost', 'token')).toEqual({
      kind: 'not-owner',
    });
  });
});

describe('closed lookup projection — no raw intent ever leaves', () => {
  test('reserved/admitted project to preparing; accepted names the real task', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(projectDelegationAttemptClaim(undefined, 'attempt-1')).toEqual({
      attemptId: 'attempt-1',
      state: 'none',
    });
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({ attemptId: 'attempt-1', state: 'preparing' });
    await store.bindAdmitted('dev-1:attempt-1', created.ownerToken, {
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    });
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({ attemptId: 'attempt-1', state: 'preparing' });
    await store.markAccepted('dev-1:attempt-1', created.ownerToken);
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({
      attemptId: 'attempt-1',
      state: 'accepted',
      taskId: 'task:reserved-1',
    });
  });

  test('the projection carries no prompt, path, or digest', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    await store.bindAdmitted('dev-1:attempt-1', created.ownerToken, {
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    });
    await store.markAccepted('dev-1:attempt-1', created.ownerToken);
    const projection = projectDelegationAttemptClaim(
      await store.read('dev-1:attempt-1'),
      'attempt-1',
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('Ship the portable');
    expect(serialized).not.toContain('prj_shared');
    expect(serialized).not.toContain(digest());
  });
});

describe('intent digest — stable, RAW-only', () => {
  test('key order does not move the digest', () => {
    const a = delegationAttemptIntentDigest({
      prompt: INTENT.prompt,
      target: {
        workspace: INTENT.target.workspace,
        agent: INTENT.target.agent,
        environment: INTENT.target.environment,
      },
    });
    expect(a).toBe(digest());
  });

  test('resolved facts change nothing because they are never inputs', () => {
    // The digest function accepts ONLY prompt/target/parentTaskId — there
    // is no parameter for a resolved workspace or incarnation, so a
    // post-resolution fact cannot silently join the initial digest. The
    // admitted bind carries those facts under the same claim instead.
    expect(digest()).toMatch(/^[0-9a-f]{64}$/);
    const withParent = delegationAttemptIntentDigest({
      prompt: INTENT.prompt,
      target: INTENT.target,
      parentTaskId: 'task:parent',
    });
    expect(withParent).not.toBe(digest());
  });
});
