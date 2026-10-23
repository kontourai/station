/**
 * station#3413 part B: the work-claim store over the orchestration database
 * the runtime opens (a real `EventStore`), and the `listActiveClaims` read API
 * a Task brief composes. Time is the store's injected clock, so expiry is
 * exact rather than slept for.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import {
  createActiveWorkClaimReader,
  type WorkClaimSessionState,
  workClaimSessionEnded,
} from '../work-claims.js';

const makeTempDir = trackTempDirs();
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const P1 = { kind: 'project', id: 'project-1-id' } as const;
const P2 = { kind: 'project', id: 'project-2-id' } as const;
const GLOBAL = { kind: 'global' } as const;

describe('work claims (#3413 B)', () => {
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function setup(maxActivePerClaimant = 3) {
    const eventStore = new EventStore(
      join(makeTempDir('work-claims-'), 'orchestration.sqlite'),
    );
    stores.push(eventStore);
    let now = T0;
    // The store the runtime composes, with the test's clock.
    const store = eventStore.createWorkClaimStore({
      maxActivePerClaimant,
      now: () => now,
    });
    return {
      store,
      eventStore,
      advance: (seconds: number) => {
        now += seconds * 1000;
      },
    };
  }

  const base = {
    paths: [] as string[],
    ttlSeconds: 600,
  };

  test('the runtime factory opens the same table: a claim it writes is read back', () => {
    const { eventStore } = setup();
    const runtime = eventStore.createWorkClaimStore({
      maxActivePerClaimant: 2,
    });
    const made = runtime.claim({
      ...base,
      claimant: { sessionId: 's1' },
      scope: P1,
      workItemRef: '#1',
    });
    expect(made.kind).toBe('claimed');
    expect(
      runtime.listUnexpired({ scope: P1 }).map((claim) => claim.workItemRef),
    ).toEqual(['#1']);
  });

  test('a claim is not a lock: two Sessions claim the same item and both stand', () => {
    const { store } = setup();
    const a = store.claim({
      ...base,
      claimant: { sessionId: 's1' },
      scope: P1,
      workItemRef: 'kontourai/station#3413',
      note: 'tests',
    });
    const b = store.claim({
      ...base,
      claimant: { sessionId: 's2' },
      scope: P1,
      workItemRef: 'kontourai/station#3413',
      note: 'docs',
    });
    expect([a.kind, b.kind]).toEqual(['claimed', 'claimed']);
    expect(
      store
        .listUnexpired({ scope: P1 })
        .map((claim) => [claim.sessionId, claim.note])
        .sort(),
    ).toEqual([
      ['s1', 'tests'],
      ['s2', 'docs'],
    ]);
  });

  test('expires at its TTL, and a renewal moves the expiry from now', () => {
    const { store, advance } = setup();
    const made = store.claim({
      ...base,
      claimant: { sessionId: 's1' },
      scope: P1,
      workItemRef: '#1',
    });
    if (made.kind !== 'claimed') throw new Error('not claimed');
    expect(made.claim.expiresAt).toBe(new Date(T0 + 600_000).toISOString());
    advance(599);
    expect(store.listUnexpired({ scope: P1 })).toHaveLength(1);
    const renewed = store.renew(made.claim.claimId, { sessionId: 's1' }, 300);
    expect(renewed).toMatchObject({
      kind: 'renewed',
      claim: {
        renewedAt: new Date(T0 + 599_000).toISOString(),
        expiresAt: new Date(T0 + 899_000).toISOString(),
      },
    });
    advance(299);
    expect(store.listUnexpired({ scope: P1 })).toHaveLength(1);
    advance(1);
    // Exactly at its expiry it is gone, and a renewal is refused, not a revival.
    expect(store.listUnexpired({ scope: P1 })).toEqual([]);
    expect(
      store.renew(made.claim.claimId, { sessionId: 's1' }, 300),
    ).toMatchObject({ kind: 'not_active' });
  });

  test('release ends it with a note; releasing twice is refused as not active', () => {
    const { store } = setup();
    const made = store.claim({
      ...base,
      claimant: { sessionId: 's1' },
      scope: P1,
      paths: ['src/a.ts'],
    });
    if (made.kind !== 'claimed') throw new Error('not claimed');
    expect(
      store.release(made.claim.claimId, { sessionId: 's1' }, 'handing off'),
    ).toMatchObject({
      kind: 'released',
      claim: { releaseNote: 'handing off', releasedAt: expect.any(String) },
    });
    expect(store.listUnexpired({ scope: P1 })).toEqual([]);
    expect(
      store.release(made.claim.claimId, { sessionId: 's1' }),
    ).toMatchObject({ kind: 'not_active' });
    expect(
      store.renew(made.claim.claimId, { sessionId: 's1' }, 60),
    ).toMatchObject({
      kind: 'not_active',
    });
  });

  test('only its claimant, or a later Session of its conversation, may renew or release it', () => {
    const { store } = setup();
    const made = store.claim({
      ...base,
      claimant: { sessionId: 's1', conversationId: 'conv-1' },
      scope: P1,
      workItemRef: '#1',
    });
    if (made.kind !== 'claimed') throw new Error('not claimed');
    const id = made.claim.claimId;
    // Another Session, or one with a different conversation, reads not found.
    expect(store.renew(id, { sessionId: 's2' }, 60).kind).toBe('not_found');
    expect(
      store.release(id, { sessionId: 's2', conversationId: 'conv-2' }).kind,
    ).toBe('not_found');
    expect(store.renew('claim_unknown', { sessionId: 's1' }, 60).kind).toBe(
      'not_found',
    );
    // The conversation's next Session holds it.
    expect(
      store.renew(id, { sessionId: 's1-next', conversationId: 'conv-1' }, 60)
        .kind,
    ).toBe('renewed');
    expect(store.listUnexpired({ scope: P1 })).toHaveLength(1);
  });

  test('claiming an item it already holds renews that claim; the active count is bounded with a refusal', () => {
    const { store, advance } = setup(2);
    const claimant = { sessionId: 's1' };
    const first = store.claim({
      ...base,
      claimant,
      scope: P1,
      workItemRef: '#1',
      note: 'one',
    });
    advance(10);
    const again = store.claim({
      ...base,
      claimant,
      scope: P1,
      workItemRef: '#1',
      note: 'one, revised',
      paths: ['src/x.ts'],
    });
    if (first.kind !== 'claimed' || again.kind !== 'claimed')
      throw new Error('not claimed');
    expect(again.claim).toMatchObject({
      claimId: first.claim.claimId,
      note: 'one, revised',
      paths: ['src/x.ts'],
      claimedAt: first.claim.claimedAt,
      expiresAt: new Date(T0 + 610_000).toISOString(),
    });
    expect(
      store.claim({ ...base, claimant, scope: P1, paths: ['src/y.ts'] }).kind,
    ).toBe('claimed');
    // Two active: the third is refused, not dropped or evicting the oldest.
    expect(
      store.claim({ ...base, claimant, scope: P1, workItemRef: '#3' }),
    ).toEqual({ kind: 'too_many', max: 2 });
    expect(store.listUnexpired({ scope: P1 })).toHaveLength(2);
    // Releasing one frees a slot.
    store.release(first.claim.claimId, claimant);
    expect(
      store.claim({ ...base, claimant, scope: P1, workItemRef: '#3' }).kind,
    ).toBe('claimed');
  });

  test('listActiveClaims: one Project or the global space, optionally one Task, never an ended Session', async () => {
    const { store } = setup();
    store.claim({
      ...base,
      claimant: { sessionId: 'p1-task' },
      scope: P1,
      taskId: 'task-1',
      workItemRef: '#1',
    });
    store.claim({
      ...base,
      claimant: { sessionId: 'p1-free' },
      scope: P1,
      workItemRef: '#2',
    });
    store.claim({
      ...base,
      claimant: { sessionId: 'p1-ended', conversationId: 'conv-ended' },
      scope: P1,
      taskId: 'task-1',
      workItemRef: '#3',
    });
    store.claim({
      ...base,
      claimant: { sessionId: 'p2-task' },
      scope: P2,
      taskId: 'task-1',
      workItemRef: '#4',
    });
    store.claim({
      ...base,
      claimant: { sessionId: 'g' },
      scope: GLOBAL,
      workItemRef: '#5',
    });
    const states = new Map<string, WorkClaimSessionState>([
      ['p1-task', { status: 'ready', lifecycleState: 'idle' }],
      ['p1-free', { status: 'running', lifecycleState: 'running' }],
      ['conv-ended', { status: 'closed' }],
      ['p2-task', { status: 'ready' }],
      ['g', { status: 'ready' }],
    ]);
    const asked: string[][] = [];
    const reader = createActiveWorkClaimReader({
      store,
      readSessionStates: async (claims) => {
        asked.push(claims.map((claim) => claim.sessionId).sort());
        return states;
      },
    });
    const refs = async (query: Parameters<typeof reader.listActiveClaims>[0]) =>
      (await reader.listActiveClaims(query))
        .map((claim) => claim.workItemRef)
        .sort();
    expect(await refs({ projectId: P1.id })).toEqual(['#1', '#2']);
    expect(await refs({ projectId: P1.id, taskId: 'task-1' })).toEqual(['#1']);
    expect(await refs({ projectId: P2.id, taskId: 'task-1' })).toEqual(['#4']);
    expect(await refs({ projectId: null })).toEqual(['#5']);
    expect(await refs({ projectId: 'unknown' })).toEqual([]);
    // Liveness is read only for the scope's own claims.
    expect(asked[0]).toEqual(['p1-ended', 'p1-free', 'p1-task']);
  });

  test('a Session has ended when closed, dead, completed or unknown; idle, failed and canceled Sessions are live', () => {
    expect(
      [
        undefined,
        { status: 'closed' },
        { status: 'dead' },
        { status: 'ready', lifecycleState: 'completed' },
        { status: 'ready', lifecycleState: 'idle' },
        { status: 'running', lifecycleState: 'running' },
        { status: 'error', lifecycleState: 'failed' },
        { status: 'ready', lifecycleState: 'canceled' },
      ].map(workClaimSessionEnded),
    ).toEqual([true, true, true, true, false, false, false, false]);
  });
});
