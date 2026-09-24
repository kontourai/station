/**
 * #485 receiver request-claim slice — the durable execution-domain owner.
 *
 * Store-level proof (no mocks of the store itself; the real file-backed
 * implementation in a temp dir):
 *
 * - reserve returns exactly ONE owner secret; same tuple + same digest
 *   joins the existing claim; a different digest under the same tuple
 *   conflicts;
 * - the storage key is the unambiguous length-prefixed tuple
 *   (colon-containing device/attempt ids can never collide across grants);
 * - bounded and fail-closed: at capacity NEW claims refuse and NOTHING is
 *   evicted (old and unresolved keys survive);
 * - malformed stores fail closed (corrupt JSON, a PRESENT null/falsy
 *   non-ledger, wrong version, array records, non-tuple keys, key/identity
 *   mismatch, non-digest, bad verifier, unknown state, and states without
 *   their required evidence all throw — a claim is never silently
 *   forgotten, and a present falsy file is never an empty ledger);
 * - a crash before the atomic rename commit leaves no claim AND releases
 *   the lock (the next reserve succeeds);
 * - owner transitions recompute the persisted verifier on EVERY transition:
 *   wrong/random/empty/other-claim tokens are not-owner with no mutation,
 *   on every store instance sharing the file; the secret itself is never
 *   persisted;
 * - session-started is NOT acceptance: accept requires the real initial
 *   turn id from the dispatch, from session-started only;
 * - the lookup projection is closed (no prompt/path/digest/verifier/turn
 *   identity) and `none` is never a resend authorization; every known
 *   claim keeps its reserved task reference for reconciliation, and
 *   `accepted` names the exact task AND turn;
 * - the intent digest is stable over key order and covers the RAW intent
 *   only — resolved facts cannot be in it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  delegationAttemptClaimKey,
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

function claimKey(deviceId = 'dev-1', attemptId = 'attempt-1'): string {
  return delegationAttemptClaimKey(deviceId, attemptId);
}

function reserveInput(deviceId = 'dev-1', attemptId = 'attempt-1') {
  return {
    key: claimKey(deviceId, attemptId),
    attemptId,
    callerDeviceId: deviceId,
    intentDigest: digest(),
    taskId: 'task:reserved-1',
  };
}

const ADMITTED_FACTS = {
  portableProjectId: 'prj_shared',
  resourceId: 'git.example/acme/repo',
} as const;

function validRecord(
  deviceId = 'dev-1',
  attemptId = 'attempt-1',
  overrides: Record<string, unknown> = {},
) {
  return {
    key: claimKey(deviceId, attemptId),
    attemptId,
    callerDeviceId: deviceId,
    intentDigest: digest(),
    taskId: 'task:reserved-1',
    initialClientTurnId: 'initial-client-turn-1',
    ownerVerifier: 'a'.repeat(64),
    state: 'reserved',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function writeLedger(ledger: unknown) {
  writeFileSync(
    join(dir, 'delegation-attempt-claims.json'),
    typeof ledger === 'string' ? ledger : JSON.stringify(ledger),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-attempt-claims-'));
  store = new FileDelegationAttemptClaimStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tuple keys — unambiguous across grants', () => {
  test('length-prefixing separates what a naive colon-join collides', () => {
    expect(delegationAttemptClaimKey('a:b', 'c')).not.toBe(
      delegationAttemptClaimKey('a', 'b:c'),
    );
    expect(() => delegationAttemptClaimKey('', 'a')).toThrow();
    expect(() => delegationAttemptClaimKey('a', '')).toThrow();
  });

  test('two colon-containing tuples with identical intent never coalesce', async () => {
    const first = await store.reserve(reserveInput('a:b', 'c'));
    expect(first.kind).toBe('created');
    // Naive `${deviceId}:${attemptId}` would join BOTH tuples to `a:b:c`.
    const second = await store.reserve({
      ...reserveInput('a', 'b:c'),
      taskId: 'task:reserved-other',
    });
    expect(second.kind).toBe('created');
    const recordA = await store.read(claimKey('a:b', 'c'));
    const recordB = await store.read(claimKey('a', 'b:c'));
    expect(recordA?.taskId).toBe('task:reserved-1');
    expect(recordB?.taskId).toBe('task:reserved-other');
    expect(recordA?.callerDeviceId).toBe('a:b');
    expect(recordB?.attemptId).toBe('b:c');
    // A redelivery of the first tuple joins the FIRST claim only.
    const join = await store.reserve(reserveInput('a:b', 'c'));
    expect(join.kind).toBe('existing');
    if (join.kind !== 'existing') return;
    expect(join.record.taskId).toBe('task:reserved-1');
  });

  test('reserve with a key that is not the tuple throws and writes nothing', async () => {
    await expect(
      store.reserve({
        ...reserveInput(),
        key: 'dev-1:attempt-1',
      }),
    ).rejects.toThrow(/does not match the caller\/attempt tuple/);
    expect(await store.read(claimKey())).toBeUndefined();
  });
});

describe('reserve — one owner, joins, conflicts', () => {
  test('the first reserve creates with exactly one owner secret', async () => {
    const outcome = await store.reserve(reserveInput());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.ownerToken.length).toBeGreaterThan(0);
    expect(outcome.initialClientTurnId.length).toBeGreaterThan(0);
    const record = await store.read(claimKey());
    expect(record).toMatchObject({
      key: claimKey(),
      attemptId: 'attempt-1',
      callerDeviceId: 'dev-1',
      intentDigest: digest(),
      taskId: 'task:reserved-1',
      state: 'reserved',
      initialClientTurnId: outcome.initialClientTurnId,
    });
    // The secret itself is never persisted — only its verifier is.
    const raw = readFileSync(
      join(dir, 'delegation-attempt-claims.json'),
      'utf8',
    );
    expect(raw).not.toContain(outcome.ownerToken);
    expect(record?.ownerVerifier).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same tuple + same digest joins the existing claim (no second token)', async () => {
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

  test('same tuple + different digest is a conflict — the first claim stands', async () => {
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
    const record = await store.read(claimKey());
    expect(record?.taskId).toBe('task:reserved-1');
    expect(record?.state).toBe('reserved');
  });

  test('different caller grants are different tuples (no cross-grant join)', async () => {
    await store.reserve(reserveInput());
    const outcome = await store.reserve({
      ...reserveInput('dev-2', 'attempt-1'),
      callerDeviceId: 'dev-2',
    });
    expect(outcome.kind).toBe('created');
  });
});

describe('bounded fail-closed capacity — nothing is ever evicted', () => {
  test('at capacity NEW claims refuse; old and unresolved keys survive', async () => {
    const tiny = new FileDelegationAttemptClaimStore(dir, { capacity: 2 });
    const first = await tiny.reserve(reserveInput('dev-1', 'a'));
    expect(first.kind).toBe('created');
    const second = await tiny.reserve({
      ...reserveInput('dev-1', 'b'),
      taskId: 'task:reserved-2',
    });
    expect(second.kind).toBe('created');
    // Mark the first claim unresolved — the state most tempting to evict.
    if (first.kind === 'created') {
      await tiny.bindAdmitted(claimKey('dev-1', 'a'), first.ownerToken, {
        ...ADMITTED_FACTS,
      });
      await tiny.markUnresolved(claimKey('dev-1', 'a'), first.ownerToken);
    }
    const refused = await tiny.reserve({
      ...reserveInput('dev-1', 'c'),
      taskId: 'task:reserved-3',
    });
    expect(refused.kind).toBe('capacity');
    // Nothing was evicted: both retained keys still read back intact.
    expect((await tiny.read(claimKey('dev-1', 'a')))?.state).toBe('unresolved');
    expect((await tiny.read(claimKey('dev-1', 'b')))?.state).toBe('reserved');
    expect(await tiny.read(claimKey('dev-1', 'c'))).toBeUndefined();
  });
});

describe('malformed stores fail closed — never forget a claim', () => {
  test('corrupt JSON throws on reserve and on read', async () => {
    writeLedger('{ this is not json {{{');
    await expect(store.reserve(reserveInput())).rejects.toThrow();
    await expect(store.read(claimKey())).rejects.toThrow();
  });

  test.each([
    ['null', 'null'],
    ['false', 'false'],
    ['zero', '0'],
    ['empty string', '""'],
    ['top-level array', '[]'],
  ])(
    'a PRESENT %s file is malformation, never an empty ledger',
    async (_label, content) => {
      writeLedger(content);
      // A present falsy file must NOT read as "no claims" (which would
      // permit a duplicate execution): it fails closed instead, and the
      // file is left untouched for inspection — never rewritten empty.
      await expect(store.read(claimKey())).rejects.toThrow(/malformed/);
      await expect(store.reserve(reserveInput())).rejects.toThrow(/malformed/);
      expect(
        readFileSync(join(dir, 'delegation-attempt-claims.json'), 'utf8'),
      ).toBe(content);
    },
  );

  test('wrong version throws', async () => {
    writeLedger({ version: 999, records: {} });
    await expect(store.reserve(reserveInput())).rejects.toThrow(
      /version 999 is not supported/,
    );
  });

  test.each([
    ['array records', { version: 2, records: [] }],
    ['null records', { version: 2, records: null }],
    [
      'key mismatch',
      {
        version: 2,
        records: {
          [claimKey()]: {
            ...validRecord(),
            key: claimKey('dev-1', 'someone-else'),
          },
        },
      },
    ],
    [
      'naive-joined key instead of the tuple',
      {
        version: 2,
        records: {
          'dev-1:attempt-1': {
            ...validRecord(),
            key: 'dev-1:attempt-1',
          },
        },
      },
    ],
    [
      'moved record under a colliding key',
      {
        version: 2,
        // A valid tuple key for ('a:b','c') holding a record whose own
        // identity is ('a','b:c') — the naive join of both is `a:b:c`.
        [delegationAttemptClaimKey('a:b', 'c')]: {
          ...validRecord('a', 'b:c'),
          key: delegationAttemptClaimKey('a:b', 'c'),
        },
      },
    ],
    [
      'non-digest',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), intentDigest: 'new-hash' },
        },
      },
    ],
    [
      'bad owner verifier',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), ownerVerifier: 'not-a-verifier' },
        },
      },
    ],
    [
      'missing owner verifier',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), ownerVerifier: undefined },
        },
      },
    ],
    [
      'missing client-turn identity',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), initialClientTurnId: '' },
        },
      },
    ],
    [
      'unknown state',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), state: 'executing' },
        },
      },
    ],
    [
      'admitted state without admitted facts',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), state: 'admitted' },
        },
      },
    ],
    [
      'session-started state without admitted facts',
      {
        version: 2,
        records: {
          [claimKey()]: { ...validRecord(), state: 'session-started' },
        },
      },
    ],
    [
      'accepted state without the initial turn id',
      {
        version: 2,
        records: {
          [claimKey()]: {
            ...validRecord(),
            state: 'accepted',
            admitted: { ...ADMITTED_FACTS },
          },
        },
      },
    ],
    [
      'admitted facts without the required portable identity',
      {
        version: 2,
        records: {
          [claimKey()]: {
            ...validRecord(),
            state: 'admitted',
            admitted: { ...ADMITTED_FACTS, resourceId: '' },
          },
        },
      },
    ],
  ])('%s refuses rather than forgetting', async (_label, ledger) => {
    writeLedger(ledger);
    await expect(store.reserve(reserveInput())).rejects.toThrow(/malformed/);
  });

  test('a missing store file is the honest empty ledger (nothing was ever accepted)', async () => {
    await expect(store.read(claimKey())).resolves.toBeUndefined();
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
    expect(await faulting.read(claimKey())).toBeUndefined();
    // …and the lock was released: the retry reserves cleanly.
    const retry = await faulting.reserve(reserveInput());
    expect(retry.kind).toBe('created');
  });
});

describe('owner transitions — the persisted verifier checks every token', () => {
  test('bind → session-started → accept is the durable-effect path; terminal states stick', async () => {
    const created = await store.reserve(reserveInput());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const token = created.ownerToken;
    // An empty token is rejected outright…
    expect(
      await store.bindAdmitted(claimKey(), '', { ...ADMITTED_FACTS }),
    ).toEqual({ kind: 'not-owner' });
    expect(
      await store.bindAdmitted(claimKey(), token, {
        provider: 'station-agent',
        modelId: 'm-1',
        projectSlug: 'local',
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
        localProjectId: 'local-project-1',
      }),
    ).toEqual({ kind: 'applied' });
    // …a started session is NOT acceptance: accept from admitted is stale…
    expect(await store.markAccepted(claimKey(), token, 'turn-1')).toEqual({
      kind: 'stale',
    });
    // …acceptance without the real turn id throws (never invented)…
    await expect(store.markSessionStarted(claimKey(), token)).resolves.toEqual({
      kind: 'applied',
    });
    await expect(store.markAccepted(claimKey(), token, '')).rejects.toThrow(
      /requires the real initial turn id/,
    );
    expect(await store.markAccepted(claimKey(), token, 'turn-1')).toEqual({
      kind: 'applied',
    });
    expect((await store.read(claimKey()))?.initialTurnId).toBe('turn-1');
    // …and accepted is terminal: refuse/unresolve go stale-or-worse, never flip.
    expect(await store.markRefused(claimKey(), token)).toEqual({
      kind: 'stale',
    });
    expect(await store.markUnresolved(claimKey(), token)).toEqual({
      kind: 'stale',
    });
    expect((await store.read(claimKey()))?.state).toBe('accepted');
  });

  test('wrong, random, empty, and other-claim tokens are not-owner with NO mutation', async () => {
    const createdA = await store.reserve(reserveInput('dev-1', 'a'));
    const createdB = await store.reserve(reserveInput('dev-1', 'b'));
    if (createdA.kind !== 'created' || createdB.kind !== 'created') return;
    const before = await store.read(claimKey('dev-1', 'a'));
    for (const bad of [
      'wrong-token',
      'a'.repeat(64),
      '',
      createdB.ownerToken,
    ]) {
      expect(
        await store.bindAdmitted(claimKey('dev-1', 'a'), bad, {
          ...ADMITTED_FACTS,
        }),
      ).toEqual({ kind: 'not-owner' });
      expect(await store.markUnresolved(claimKey('dev-1', 'a'), bad)).toEqual({
        kind: 'not-owner',
      });
    }
    // No mutation whatsoever: same state, same updatedAt.
    const after = await store.read(claimKey('dev-1', 'a'));
    expect(after?.state).toBe(before?.state);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    // The true owner still works.
    expect(
      await store.bindAdmitted(claimKey('dev-1', 'a'), createdA.ownerToken, {
        ...ADMITTED_FACTS,
      }),
    ).toEqual({ kind: 'applied' });
  });

  test('ownership verifies across concurrent store instances sharing the file', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    const sibling = new FileDelegationAttemptClaimStore(dir);
    // The sibling instance never saw the secret — but the verifier is
    // durable, so the true token applies there and a wrong one does not.
    expect(
      await sibling.bindAdmitted(claimKey(), created.ownerToken, {
        ...ADMITTED_FACTS,
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      await sibling.markSessionStarted(claimKey(), 'random-wrong-token'),
    ).toEqual({ kind: 'not-owner' });
    expect(
      await sibling.markSessionStarted(claimKey(), created.ownerToken),
    ).toEqual({ kind: 'applied' });
    expect(
      await store.markAccepted(claimKey(), created.ownerToken, 'turn-9'),
    ).toEqual({ kind: 'applied' });
  });

  test('a clean pre-effect refusal is terminal and keeps the tombstone', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(await store.markRefused(claimKey(), created.ownerToken)).toEqual({
      kind: 'applied',
    });
    // Refused keys never transition again — not even to unresolved.
    expect(await store.markUnresolved(claimKey(), created.ownerToken)).toEqual({
      kind: 'not-owner',
    });
    const record = await store.read(claimKey());
    expect(record?.state).toBe('refused');
    expect(record?.taskId).toBe('task:reserved-1');
  });

  test('post-start refusal is stale: a started session cannot be refused away', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    await store.bindAdmitted(claimKey(), created.ownerToken, {
      ...ADMITTED_FACTS,
    });
    await store.markSessionStarted(claimKey(), created.ownerToken);
    // The session exists — a clean pre-effect refusal would be dishonest.
    expect(await store.markRefused(claimKey(), created.ownerToken)).toEqual({
      kind: 'stale',
    });
    // …but the unknown turn fate still resolves to unresolved.
    expect(await store.markUnresolved(claimKey(), created.ownerToken)).toEqual({
      kind: 'applied',
    });
    expect((await store.read(claimKey()))?.state).toBe('unresolved');
  });

  test('an indeterminate invocation stays revisable-but-never-resendable', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(await store.markUnresolved(claimKey(), created.ownerToken)).toEqual({
      kind: 'applied',
    });
    // Unresolved is not terminal-terminal: it stays exactly there (no
    // transition out is offered), and a non-owner mutation is not-owner.
    expect(
      await store.markAccepted(claimKey(), created.ownerToken, 'turn-1'),
    ).toEqual({ kind: 'stale' });
    expect(await store.markAccepted(claimKey(), 'wrong', 'turn-1')).toEqual({
      kind: 'not-owner',
    });
    expect((await store.read(claimKey()))?.state).toBe('unresolved');
  });

  test('transitions on an absent key are not-owner (never applied)', async () => {
    expect(
      await store.markAccepted(claimKey('dev-1', 'ghost'), 'token', 'turn-1'),
    ).toEqual({
      kind: 'not-owner',
    });
    expect(
      await store.markRefused(claimKey('dev-1', 'ghost'), 'token'),
    ).toEqual({
      kind: 'not-owner',
    });
  });
});

describe('closed lookup projection — no raw intent ever leaves', () => {
  test('reserved/admitted/session-started project to preparing WITH the reserved task reference', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    expect(projectDelegationAttemptClaim(undefined, 'attempt-1')).toEqual({
      attemptId: 'attempt-1',
      state: 'none',
    });
    expect(
      projectDelegationAttemptClaim(await store.read(claimKey()), 'attempt-1'),
    ).toEqual({
      attemptId: 'attempt-1',
      state: 'preparing',
      taskId: 'task:reserved-1',
    });
    await store.bindAdmitted(claimKey(), created.ownerToken, {
      ...ADMITTED_FACTS,
    });
    expect(
      projectDelegationAttemptClaim(await store.read(claimKey()), 'attempt-1'),
    ).toEqual({
      attemptId: 'attempt-1',
      state: 'preparing',
      taskId: 'task:reserved-1',
    });
    // A started session alone is NOT an accepted work request.
    await store.markSessionStarted(claimKey(), created.ownerToken);
    expect(
      projectDelegationAttemptClaim(await store.read(claimKey()), 'attempt-1'),
    ).toEqual({
      attemptId: 'attempt-1',
      state: 'preparing',
      taskId: 'task:reserved-1',
    });
    await store.markAccepted(claimKey(), created.ownerToken, 'turn-1');
    expect(
      projectDelegationAttemptClaim(await store.read(claimKey()), 'attempt-1'),
    ).toEqual({
      attemptId: 'attempt-1',
      state: 'accepted',
      taskId: 'task:reserved-1',
      turnId: 'turn-1',
    });
  });

  test('unresolved/refused keep the reserved reference for reconciliation', async () => {
    const refused = await store.reserve(reserveInput('dev-1', 'r'));
    if (refused.kind !== 'created') return;
    await store.markRefused(claimKey('dev-1', 'r'), refused.ownerToken);
    expect(
      projectDelegationAttemptClaim(
        await store.read(claimKey('dev-1', 'r')),
        'r',
      ),
    ).toEqual({ attemptId: 'r', state: 'refused', taskId: 'task:reserved-1' });
    const pending = await store.reserve(reserveInput('dev-1', 'u'));
    if (pending.kind !== 'created') return;
    await store.markUnresolved(claimKey('dev-1', 'u'), pending.ownerToken);
    expect(
      projectDelegationAttemptClaim(
        await store.read(claimKey('dev-1', 'u')),
        'u',
      ),
    ).toEqual({
      attemptId: 'u',
      state: 'unresolved',
      taskId: 'task:reserved-1',
    });
  });

  test('the projection carries no prompt, path, digest, verifier, or turn identity', async () => {
    const created = await store.reserve(reserveInput());
    if (created.kind !== 'created') return;
    await store.bindAdmitted(claimKey(), created.ownerToken, {
      ...ADMITTED_FACTS,
    });
    await store.markSessionStarted(claimKey(), created.ownerToken);
    await store.markAccepted(claimKey(), created.ownerToken, 'turn-1');
    const record = await store.read(claimKey());
    const projection = projectDelegationAttemptClaim(record, 'attempt-1');
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('Ship the portable');
    expect(serialized).not.toContain('prj_shared');
    expect(serialized).not.toContain(digest());
    // Owner verifier and client-turn identity never leave the store.
    expect(serialized).not.toContain(record?.ownerVerifier ?? 'impossible');
    expect(serialized).not.toContain(
      record?.initialClientTurnId ?? 'impossible',
    );
    expect(serialized).not.toContain(created.ownerToken);
  });

  test('two colon-separated grants with identical accepted intent disclose nothing cross-grant', async () => {
    for (const [device, attempt] of [
      ['a:b', 'c'],
      ['a', 'b:c'],
    ] as const) {
      const created = await store.reserve({
        ...reserveInput(device, attempt),
        taskId: `task:${device}-${attempt}`,
      });
      if (created.kind !== 'created') return;
      await store.bindAdmitted(claimKey(device, attempt), created.ownerToken, {
        ...ADMITTED_FACTS,
      });
      await store.markSessionStarted(
        claimKey(device, attempt),
        created.ownerToken,
      );
      await store.markAccepted(
        claimKey(device, attempt),
        created.ownerToken,
        `turn-${device}-${attempt}`,
      );
    }
    // Each tuple's lookup names ONLY its own task and turn.
    expect(
      projectDelegationAttemptClaim(
        await store.read(claimKey('a:b', 'c')),
        'c',
      ),
    ).toEqual({
      attemptId: 'c',
      state: 'accepted',
      taskId: 'task:a:b-c',
      turnId: 'turn-a:b-c',
    });
    expect(
      projectDelegationAttemptClaim(
        await store.read(claimKey('a', 'b:c')),
        'b:c',
      ),
    ).toEqual({
      attemptId: 'b:c',
      state: 'accepted',
      taskId: 'task:a-b:c',
      turnId: 'turn-a-b:c',
    });
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
