import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { tenantId } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createConversationForkContext,
  decodeCommittedNativeForkCreation,
  type NativeForkCommitInput,
  type NativeForkEffectClaim,
  type NativeForkSourceSeal,
  nativeForkHash,
} from '../conversation-fork-context.js';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventStore } from '../event-store.js';
import { runSessionStartWithBoundary } from '../session-turn-boundary.js';

const NOW = '2030-01-01T00:00:00.000Z';
const SOURCE_KEY = 'a'.repeat(64);
const CHILD_KEY = 'b'.repeat(64);
const BINDING_KEY = 'c'.repeat(64);

describe('native fork SQLite effect and publication ownership', () => {
  const temp = trackTempDirs();
  const stores = new Set<EventStore>();
  const peers = new Set<DatabaseSync>();
  afterEach(() => {
    vi.restoreAllMocks();
    for (const peer of peers) peer.close();
    peers.clear();
    for (const store of stores) store.close();
    stores.clear();
  });
  function fixture(
    options: {
      tenant?: boolean;
      project?: boolean;
      explicitOwned?: boolean;
    } = {},
  ) {
    const root = temp('station-native-fork-effect-');
    const path = join(root, 'events.sqlite');
    let store = new EventStore(path);
    stores.add(store);
    const sourceSession: ProviderSession = {
      provider: 'codex',
      threadId: 'source',
      status: 'ready',
      ...(options.explicitOwned
        ? { controlMode: 'station-owned' as const }
        : {}),
      ...(options.tenant
        ? {
            tenantExecutionContext: {
              tenantId: tenantId('tenant-one'),
              source: 'session' as const,
            },
          }
        : {}),
      cwd: root,
      resumeCursor: { nativeSessionId: 'source-native' },
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.upsertSession(sourceSession);
    store.claimNativeSessionIdentity(SOURCE_KEY, 'source');
    store.appendEvent({
      eventId: 'source-configured',
      provider: 'codex',
      threadId: 'source',
      sessionId: 'source',
      method: 'session.configured',
      cwd: root,
      createdAt: NOW,
      metadata: {
        userId: 'owner',
        agentSlug: 'codex',
        environmentId: 'local',
        ...(options.project ? { projectSlug: 'project-one' } : {}),
        nativeResumeBindingKey: BINDING_KEY,
      },
    });
    store.appendEvent({
      eventId: 'source-done',
      provider: 'codex',
      threadId: 'source',
      turnId: 'turn-one',
      method: 'turn.completed',
      finishReason: 'stop',
      createdAt: NOW,
    });
    const snapshot = createConversationForkContext({
      forkEventId: 'fork-event',
      sourceConversationId: 'source',
      sourceSessionId: 'source',
      sourceAgent: 'codex',
      targetConversationId: 'child',
      targetAgent: 'codex',
      ownerUserId: 'owner',
      ...(options.tenant ? { tenantId: 'tenant-one' } : {}),
      ...(options.project ? { projectSlug: 'project-one' } : {}),
      branchPointTurnId: 'turn-one',
      sourceTitle: 'Source',
      createdAt: NOW,
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Selected answer' }],
        },
      ],
    });
    store.reserveConversationForkContext(snapshot);
    const source: NativeForkSourceSeal = {
      sourceConversationId: 'source',
      sourceSessionId: 'source',
      selectedEventId: 'source-done',
      selectedTurnId: 'turn-one',
      headEventId: 'source-done',
      nativeIdentityKey: SOURCE_KEY,
      nativeResumeBindingKey: BINDING_KEY,
      provider: 'codex',
      environmentId: 'local',
      agentId: 'codex',
      cwd: root,
    };
    const forkEvent: CanonicalRuntimeEvent = {
      eventId: 'fork-event',
      provider: 'station',
      threadId: 'source',
      method: 'conversation.forked',
      sourceConversationId: 'source',
      targetConversationId: 'child',
      targetAgent: 'codex',
      sourceSessionId: 'source',
      branchPointTurnId: 'turn-one',
      forkedAt: NOW,
      createdAt: NOW,
      contextDigest: snapshot.digest,
      continuation: 'native',
    };
    const replay: CanonicalRuntimeEvent = {
      ...forkEvent,
      continuation: 'replay-seed',
    };
    const commit: NativeForkCommitInput = {
      startedEvent: {
        eventId: 'child-started',
        provider: 'codex',
        threadId: 'child',
        sessionId: 'child',
        method: 'session.started',
        createdAt: NOW,
        metadata: {
          userId: 'owner',
          agentSlug: 'codex',
          environmentId: 'local',
          nativeResumeBindingKey: BINDING_KEY,
          ...(options.project ? { projectSlug: 'project-one' } : {}),
          ...(options.tenant
            ? {
                tenantId: 'tenant-one',
                tenantExecutionContext: {
                  tenantId: 'tenant-one',
                  source: 'session',
                },
              }
            : {}),
        },
      },
      child: {
        ...sourceSession,
        threadId: 'child',
        resumeCursor: { nativeSessionId: 'child-native' },
      },
      configuredEvent: {
        eventId: 'child-configured',
        provider: 'codex',
        threadId: 'child',
        sessionId: 'child',
        method: 'session.configured',
        cwd: root,
        createdAt: NOW,
        metadata: {
          userId: 'owner',
          agentSlug: 'codex',
          environmentId: 'local',
          ...(options.project ? { projectSlug: 'project-one' } : {}),
          ...(options.tenant
            ? {
                tenantId: 'tenant-one',
                tenantExecutionContext: {
                  tenantId: 'tenant-one',
                  source: 'session',
                },
              }
            : {}),
          nativeResumeBindingKey: BINDING_KEY,
        },
      },
      forkEvent,
    };
    const peer = new DatabaseSync(path, { readOnly: true });
    peers.add(peer);
    return {
      peer,
      get store() {
        return store;
      },
      snapshot,
      source,
      commit,
      replay,
      reserve() {
        const result = store.reserveNativeForkEffect({
          targetId: 'child',
          contextDigest: snapshot.digest,
          source,
        });
        if (result.kind !== 'owner')
          throw new Error('Expected an actual native effect owner');
        return result.effect;
      },
      reopen() {
        store.close();
        stores.delete(store);
        store = new EventStore(path);
        stores.add(store);
      },
      observe(effect: NativeForkEffectClaim) {
        effect.observeChild(commit.child.resumeCursor, CHILD_KEY);
        store.claimNativeSessionIdentity(CHILD_KEY, 'child');
      },
    };
  }

  test('committed observation preserves later current state/cursor/history and performs zero writes or claim acquisition', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    effect.commit(f.commit);
    const laterCursor = { nativeSessionId: 'current-cursor', revision: 2 };
    f.store.upsertSession({
      ...f.commit.child,
      status: 'closed',
      resumeCursor: laterCursor,
      updatedAt: '2030-01-01T00:01:00.000Z',
    });
    f.store.appendEvent({
      eventId: 'later-answer',
      provider: 'codex',
      threadId: 'child',
      turnId: 'later-turn',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Later canonical progress',
      createdAt: '2030-01-01T00:01:00.000Z',
    });
    const append = vi.spyOn(f.store, 'appendEvent');
    const upsert = vi.spyOn(f.store, 'upsertSession');
    const reserve = vi.spyOn(f.store, 'reserveNativeForkEffect');
    const before = f.store['db']
      .prepare('SELECT total_changes() AS n')
      .get()?.n;
    const observed = f.store.observeCommittedNativeFork(
      'child',
      f.snapshot.digest,
    );
    expect(observed.kind).toBe('verified-creation');
    if (observed.kind !== 'verified-creation')
      throw new Error('Expected verified creation only');
    expect(observed.activation).toBe('unwired');
    expect(observed.creation.initialChild.resumeCursor).toEqual(
      f.commit.child.resumeCursor,
    );
    expect(observed.currentSession.status).toBe('closed');
    expect(observed.currentSession.resumeCursor).toEqual(laterCursor);
    expect(
      observed.currentProjectionEvents.some(
        (event) => event.eventId === 'later-answer',
      ),
    ).toBe(true);
    expect(observed.affected.threadIds).toEqual(
      expect.arrayContaining(['source', 'child']),
    );
    expect(f.store['db'].prepare('SELECT total_changes() AS n').get()?.n).toBe(
      before,
    );
    expect(append).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      f.peer
        .prepare(
          "SELECT status FROM provider_session_state WHERE thread_id='child'",
        )
        .get()?.status,
    ).toBe('closed');
  });

  test('COMMIT-then-throw can be observed without another fork or historical initialization insertion', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const exec = f.store['db'].exec.bind(f.store['db']);
    const fault = vi.spyOn(f.store['db'], 'exec').mockImplementation((sql) => {
      const result = exec(sql);
      if (sql === 'COMMIT') throw new Error('uncertain committed creation');
      return result;
    });
    expect(() => effect.commit(f.commit)).toThrow();
    fault.mockRestore();
    const before = f.store['db']
      .prepare('SELECT total_changes() AS n')
      .get()?.n;
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
    ).toBe('verified-creation');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    expect(f.store['db'].prepare('SELECT total_changes() AS n').get()?.n).toBe(
      before,
    );
  });

  test.each([
    'json',
    'outer-field',
    'method',
    'environment',
    'cursor',
    'order',
    'oversize',
  ] as const)(
    'strict creation observation refuses %s corruption without writing',
    (kind) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      effect.commit(f.commit);
      const record = f.store.readNativeForkEffect('child');
      if (!record?.commitJson) throw new Error('Expected retained receipt');
      if (kind === 'order')
        f.store['db']
          .prepare(
            "UPDATE orchestration_events SET global_sequence = global_sequence + 100000 WHERE id='child-started'",
          )
          .run();
      else {
        let json = record.commitJson;
        if (kind === 'json') json = '{';
        if (kind === 'oversize') json = ' '.repeat(2 * 1024 * 1024 + 1);
        if (kind === 'outer-field')
          json = JSON.stringify({ ...f.commit, unexpected: true });
        if (kind === 'method')
          json = JSON.stringify({
            ...f.commit,
            startedEvent: {
              ...f.commit.startedEvent,
              method: 'session.exited',
            },
          });
        if (kind === 'environment')
          json = JSON.stringify({
            ...f.commit,
            configuredEvent: {
              ...f.commit.configuredEvent,
              metadata: {
                ...f.commit.configuredEvent.metadata,
                environmentId: 'foreign',
              },
            },
          });
        if (kind === 'cursor')
          json = JSON.stringify({
            ...f.commit,
            child: {
              ...f.commit.child,
              resumeCursor: { nativeSessionId: 'forged' },
            },
          });
        f.store['db']
          .prepare(
            'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
          )
          .run(
            JSON.stringify({
              ...record,
              commitJson: json,
              commitDigest: nativeForkHash(json),
            }),
            'child',
          );
        if (['json', 'outer-field', 'method', 'oversize'].includes(kind))
          expect(() => decodeCommittedNativeForkCreation(json)).toThrow();
      }
      const before = f.store['db']
        .prepare('SELECT total_changes() AS n')
        .get()?.n;
      expect(
        f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
      ).toBe('unavailable');
      expect(
        f.store['db'].prepare('SELECT total_changes() AS n').get()?.n,
      ).toBe(before);
    },
  );

  test('canonical lineage beyond the finite observation boundary returns unbounded', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    effect.commit(f.commit);
    let prior = 'source';
    for (let index = 0; index < 256; index++) {
      prior = f.store.reserveNextConversationSession({
        conversationId: 'source',
        predecessorSessionId: prior,
        proposedSessionId: `source-next-${index}`,
        createdAt: NOW,
      }).lineage.sessionId;
    }
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest),
    ).toEqual({ kind: 'unavailable', reason: 'unbounded' });
  });

  test('read observation refuses caller uncommitted state and pending intents without granting execution', () => {
    const f = fixture();
    f.reserve();
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest),
    ).toEqual({ kind: 'pending' });
    f.store['db'].exec('BEGIN');
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
    ).toBe('unavailable');
    f.store['db'].exec('ROLLBACK');
    expect(f.store.observeCommittedNativeFork('', 'invalid').kind).toBe(
      'unavailable',
    );
  });

  function watch(f: ReturnType<typeof fixture>) {
    const notices: {
      kind: string;
      deferred?: boolean;
      inTransaction: boolean;
      sameChild: boolean;
      peerChild: boolean;
      peerReady: unknown;
      peerFact: boolean;
    }[] = [];
    const capture = (kind: string, deferred?: boolean) =>
      notices.push({
        kind,
        deferred,
        inTransaction: f.store['db'].isTransaction,
        sameChild: !!f.store.readSessionByThread('child'),
        peerChild: !!f.peer
          .prepare(
            "SELECT 1 FROM provider_session_state WHERE thread_id='child'",
          )
          .get(),
        peerReady: f.peer
          .prepare(
            "SELECT state FROM orchestration_conversation_fork_context WHERE target_conversation_id='child'",
          )
          .get()?.state,
        peerFact: !!f.peer
          .prepare("SELECT 1 FROM orchestration_events WHERE id='fork-event'")
          .get(),
      });
    const stop = f.store.observeCommits({
      eventCommitted: ({ event, deferred }) => capture(event.eventId, deferred),
      lineageChanged: () => capture('lineage'),
    });
    return { notices, stop };
  }
  function activity(f: ReturnType<typeof fixture>) {
    return new ConversationTurnActivityProjection({
      eventStore: f.store,
      readTurnProgress: () => undefined,
      readRunningChildWork: () => [],
      logger: { warn: vi.fn() },
    });
  }
  test('native observers see only the complete outer commit, in global started-configured-fork order with no repeat', async () => {
    const f = fixture();
    const projection = activity(f);
    try {
      expect(projection.readConversation('child').asOfSequence).toBe(0);
      const effect = f.reserve();
      const observed = watch(f);
      let insideActivity = -1;
      const append = f.store.appendEvent.bind(f.store);
      const barrier = vi
        .spyOn(f.store, 'appendEvent')
        .mockImplementation((event, outputs, participant) =>
          event.method === 'conversation.forked'
            ? append(event, outputs, () => {
                participant?.();
                expect(observed.notices).toEqual([]);
                insideActivity =
                  projection.readConversation('child').asOfSequence;
              })
            : append(event, outputs, participant),
        );
      await runSessionStartWithBoundary(
        f.store.sessionTurnBoundaryAuthority(),
        'child',
        async () => {
          f.observe(effect);
          return effect.commit(f.commit);
        },
        effect.sessionStart,
      );
      barrier.mockRestore();
      expect(insideActivity).toBe(0);
      expect(observed.notices.map((n) => n.kind)).toEqual([
        'lineage',
        'child-started',
        'child-configured',
        'fork-event',
      ]);
      for (const notice of observed.notices) {
        expect(notice.inTransaction).toBe(false);
        expect(notice.sameChild).toBe(true);
        expect(notice.peerChild).toBe(true);
        expect(notice.peerReady).toBe('ready');
        expect(notice.peerFact).toBe(true);
        if (notice.kind !== 'lineage') expect(notice.deferred).toBe(false);
      }
      expect(f.store.readGlobalSequence('child-started')).toBeLessThan(
        f.store.readGlobalSequence('child-configured')!,
      );
      expect(f.store.readGlobalSequence('child-configured')).toBeLessThan(
        f.store.readGlobalSequence('fork-event')!,
      );
      expect(projection.readConversation('child').asOfSequence).toBeGreaterThan(
        0,
      );
      const count = observed.notices.length;
      expect(effect.commit(f.commit)).toBe('already-committed');
      expect(observed.notices).toHaveLength(count);
      observed.stop();
    } finally {
      projection.dispose();
    }
  });

  test.each(['participant', 'before-commit', 'after-commit'] as const)(
    '%s failure releases no event or lineage observer notice',
    (failure) => {
      const f = fixture();
      const projection = activity(f);
      try {
        expect(projection.readConversation('child').asOfSequence).toBe(0);
        const effect = f.reserve();
        effect.sessionStart.beginInvocation(NOW);
        f.observe(effect);
        const observed = watch(f);
        const append = f.store.appendEvent.bind(f.store);
        const participantFault = vi
          .spyOn(f.store, 'appendEvent')
          .mockImplementation((event, outputs, participant) =>
            event.method === 'conversation.forked'
              ? append(event, outputs, () => {
                  participant?.();
                  expect(observed.notices).toEqual([]);
                  expect(
                    projection.readConversation('child').asOfSequence,
                  ).toBe(0);
                  if (failure === 'participant')
                    throw new Error('injected B1 participant failure');
                })
              : append(event, outputs, participant),
          );
        const exec = f.store['db'].exec.bind(f.store['db']);
        const commitFault = vi
          .spyOn(f.store['db'], 'exec')
          .mockImplementation((sql) => {
            if (sql === 'COMMIT' && failure !== 'participant') {
              expect(observed.notices).toEqual([]);
              if (failure === 'after-commit') exec(sql);
              throw new Error('injected B1 commit uncertainty');
            }
            return exec(sql);
          });
        expect(() => effect.commit(f.commit)).toThrow();
        participantFault.mockRestore();
        commitFault.mockRestore();
        expect(observed.notices).toEqual([]);
        expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe(
          'applied',
        );
        if (failure !== 'after-commit')
          expect(projection.readConversation('child').asOfSequence).toBe(0);
        observed.stop();
        f.reopen();
        expect(f.store.readNativeForkEffect('child')?.state).toBe(
          failure === 'after-commit' ? 'committed' : 'child-observed',
        );
        expect(f.store.hasEventId('child-started')).toBe(
          failure === 'after-commit',
        );
        expect(f.store.hasEventId('fork-event')).toBe(
          failure === 'after-commit',
        );
      } finally {
        projection.dispose();
      }
    },
  );

  test('native observer hold is cleared before reentrant callbacks and observer throws cannot fail a commit', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const seen: string[] = [];
    const stop = f.store.observeCommits({
      lineageChanged: () => {
        f.store.appendEvent({
          ...f.commit.configuredEvent,
          eventId: 'ordinary-reentrant',
        });
        throw new Error('observer only');
      },
      eventCommitted: ({ event, deferred }) => {
        seen.push(event.eventId);
        expect(deferred).toBe(false);
      },
    });
    expect(effect.commit(f.commit)).toBe('committed');
    expect(seen).toContain('ordinary-reentrant');
    expect(seen).toContain('child-started');
    stop();
  });

  test('ordinary caller-owned transaction retains its existing immediate deferred event notifications', () => {
    const f = fixture();
    const notices: boolean[] = [];
    const stop = f.store.observeCommits({
      eventCommitted: ({ deferred }) => notices.push(deferred),
    });
    f.store['db'].exec('BEGIN IMMEDIATE');
    f.store.appendEvent({
      ...f.commit.configuredEvent,
      eventId: 'ordinary-before-rollback',
    });
    expect(notices).toEqual([true]);
    f.store['db'].exec('ROLLBACK');
    expect(f.store.hasEventId('ordinary-before-rollback')).toBe(false);
    stop();
  });

  test.each(['event', 'lineage'] as const)(
    'unexpected %s notice fails native composition rather than escaping or being swallowed',
    (kind) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      const observed = watch(f);
      const upsert = f.store.upsertSession.bind(f.store);
      const fault = vi
        .spyOn(f.store, 'upsertSession')
        .mockImplementation((session) => {
          upsert(session);
          if (kind === 'event')
            f.store.appendEvent({
              ...f.commit.configuredEvent,
              eventId: 'foreign-event',
            });
          else upsert({ ...f.commit.child, threadId: 'foreign-child' });
        });
      expect(() => effect.commit(f.commit)).toThrow(/Unexpected/);
      fault.mockRestore();
      expect(observed.notices).toEqual([]);
      observed.stop();
      expect(f.store.readSessionByThread('child')).toBeUndefined();
      expect(f.store.hasEventId('foreign-event')).toBe(false);
      expect(f.store.readSessionByThread('foreign-child')).toBeUndefined();
    },
  );

  test.each([
    'thread',
    'provider',
    'owner',
    'environment',
    'Agent',
    'Project',
    'native-binding',
  ] as const)('started %s must match the complete native tuple', (field) => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const started = {
      ...f.commit.startedEvent,
      metadata: { ...f.commit.startedEvent.metadata },
    };
    if (field === 'thread') started.threadId = 'foreign';
    if (field === 'provider') started.provider = 'claude';
    const key = {
      thread: undefined,
      provider: undefined,
      owner: 'userId',
      environment: 'environmentId',
      Agent: 'agentSlug',
      Project: 'projectSlug',
      'native-binding': 'nativeResumeBindingKey',
    }[field];
    if (key) started.metadata[key] = 'foreign';
    expect(() =>
      effect.commit({ ...f.commit, startedEvent: started }),
    ).toThrow();
    expect(f.store.hasEventId('child-started')).toBe(false);
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'prepared',
    );
  });

  test.each([
    'prepared',
    'invoking',
    'child-observed',
    'indeterminate',
    'cleanup-pending',
  ] as const)(
    'old replay publication and deletion refuse %s native intent across reopen',
    (state) => {
      const f = fixture();
      const effect = f.reserve();
      if (state !== 'prepared')
        expect(effect.sessionStart.beginInvocation(NOW).kind).toBe('applied');
      if (state === 'child-observed') f.observe(effect);
      if (state === 'indeterminate') effect.indeterminate();
      if (state === 'cleanup-pending') effect.cleanupPending();
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow(/native fork/i);
      expect(() =>
        f.store.deleteUnstartedConversationForkContext('child'),
      ).toThrow(/native fork/i);
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(state);
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
      expect(f.store.hasEventId('fork-event')).toBe(false);
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow(/native fork/i);
    },
  );

  test('replay-ready cannot acquire native invocation ownership', () => {
    const f = fixture();
    f.store.publishConversationForkContext(f.replay, f.snapshot.digest);
    expect(() => f.reserve()).toThrow(/unpublished prepared/i);
    f.reopen();
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'ready',
    );
    expect(f.store.readNativeForkEffect('child')).toBeUndefined();
  });

  test('native commit co-publishes child lineage and exact receipt; conflicting repeats and old publishers refuse', () => {
    const f = fixture();
    const effect = f.reserve();
    expect(effect.sessionStart.beginInvocation(NOW).kind).toBe('applied');
    f.observe(effect);
    expect(effect.commit(f.commit)).toBe('committed');
    expect(effect.commit(f.commit)).toBe('already-committed');
    expect(() =>
      effect.commit({
        ...f.commit,
        child: { ...f.commit.child, status: 'closed' },
      }),
    ).toThrow(/binding conflicts/i);
    expect(() =>
      f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
    ).toThrow(/native fork/i);
    expect(() =>
      f.store.publishConversationForkContext(
        f.commit.forkEvent,
        f.snapshot.digest,
      ),
    ).toThrow(/native fork/i);
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('committed');
    expect(f.store.readSessionByThread('child')?.resumeCursor).toEqual(
      f.commit.child.resumeCursor,
    );
    expect(f.store.conversationForSession('child')?.conversationId).toBe(
      'child',
    );
    expect(f.store.nativeSessionBindingIdentity('child')).toBe(CHILD_KEY);
    expect(f.store.hasEventId('fork-event')).toBe(true);
  });

  test.each([
    { tenant: true, project: true, explicitOwned: true },
    { tenant: false, project: true, explicitOwned: false },
  ])(
    'native commit preserves matching recorded tenant and Project without minting authority: %j',
    (options) => {
      const f = fixture(options);
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      expect(effect.commit(f.commit)).toBe('committed');
      expect(effect.commit(f.commit)).toBe('already-committed');
      f.reopen();
      expect(
        f.store.readSessionByThread('child')?.tenantExecutionContext?.tenantId,
      ).toBe(options.tenant ? 'tenant-one' : undefined);
      expect(
        f.store.conversationForkContextSnapshot('child')?.projectSlug,
      ).toBe('project-one');
    },
  );

  function configuredPatch(
    input: NativeForkCommitInput,
    patch: Record<string, unknown>,
  ): NativeForkCommitInput {
    if (input.configuredEvent.method !== 'session.configured')
      throw new Error('Expected configured fixture');
    return {
      ...input,
      configuredEvent: {
        ...input.configuredEvent,
        metadata: { ...input.configuredEvent.metadata, ...patch },
      },
    };
  }
  const foreignBindings: {
    name: string;
    change(input: NativeForkCommitInput): NativeForkCommitInput;
  }[] = [
    {
      name: 'fork thread',
      change: (input) => ({
        ...input,
        forkEvent: { ...input.forkEvent, threadId: 'foreign' },
      }),
    },
    {
      name: 'fork provider',
      change: (input) => ({
        ...input,
        forkEvent: { ...input.forkEvent, provider: 'codex' },
      }),
    },
    {
      name: 'configured Session',
      change: (input) => {
        if (input.configuredEvent.method !== 'session.configured')
          throw new Error('Expected configured fixture');
        return {
          ...input,
          configuredEvent: { ...input.configuredEvent, sessionId: 'foreign' },
        };
      },
    },
    {
      name: 'configured cwd',
      change: (input) => {
        if (input.configuredEvent.method !== 'session.configured')
          throw new Error('Expected configured fixture');
        return {
          ...input,
          configuredEvent: { ...input.configuredEvent, cwd: '/foreign' },
        };
      },
    },
    {
      name: 'configured environment',
      change: (input) => configuredPatch(input, { environmentId: 'foreign' }),
    },
    {
      name: 'configured Agent',
      change: (input) => configuredPatch(input, { agentSlug: 'foreign' }),
    },
    {
      name: 'configured Project',
      change: (input) => configuredPatch(input, { projectSlug: 'foreign' }),
    },
    {
      name: 'configured tenant',
      change: (input) => configuredPatch(input, { tenantId: 'foreign' }),
    },
    {
      name: 'configured tenant context',
      change: (input) =>
        configuredPatch(input, {
          tenantExecutionContext: { tenantId: 'foreign', source: 'session' },
        }),
    },
    {
      name: 'configured native binding',
      change: (input) =>
        configuredPatch(input, { nativeResumeBindingKey: 'f'.repeat(64) }),
    },
    {
      name: 'configured native identity mismatch',
      change: (input) =>
        configuredPatch(input, { nativeResumeIdentity: 'mismatch' }),
    },
    {
      name: 'child tenant',
      change: (input) => ({
        ...input,
        child: {
          ...input.child,
          tenantExecutionContext: {
            tenantId: tenantId('foreign'),
            source: 'session',
          },
        },
      }),
    },
    {
      name: 'child attached control mode',
      change: (input) => ({
        ...input,
        child: { ...input.child, controlMode: 'read-only-attached' },
      }),
    },
  ];
  test.each(foreignBindings)(
    'first native commit refuses $name with zero publication and retained cursor',
    ({ change }) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      expect(() => effect.commit(change(f.commit))).toThrow();
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(
        'child-observed',
      );
      expect(f.store.readNativeForkEffect('child')?.cursorJson).toBe(
        JSON.stringify(f.commit.child.resumeCursor),
      );
      expect(f.store.readSessionByThread('child')).toBeUndefined();
      expect(f.store.conversationForSession('child')).toBeUndefined();
      expect(f.store.hasEventId('fork-event')).toBe(false);
      expect(f.store.hasEventId('child-configured')).toBe(false);
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
    },
  );

  test('native commit append failure rolls back child, lineage, ready and receipt while retaining observed cursor', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const append = f.store.appendEvent.bind(f.store);
    const fault = vi
      .spyOn(f.store, 'appendEvent')
      .mockImplementation((event, outputs, participant) => {
        if (event.method !== 'conversation.forked')
          return append(event, outputs, participant);
        return append(event, outputs, () => {
          participant?.();
          throw new Error('injected native publication failure');
        });
      });
    expect(() => effect.commit(f.commit)).toThrow(
      /injected native publication/i,
    );
    fault.mockRestore();
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('child-observed');
    expect(f.store.readNativeForkEffect('child')?.cursorJson).toBe(
      JSON.stringify(f.commit.child.resumeCursor),
    );
    expect(f.store.readSessionByThread('child')).toBeUndefined();
    expect(f.store.conversationForSession('child')).toBeUndefined();
    expect(f.store.hasEventId('child-configured')).toBe(false);
    expect(f.store.hasEventId('fork-event')).toBe(false);
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'prepared',
    );
  });

  test('rollback after raw boundary transition poisons the same retained wrapper before real helper reuse', async () => {
    const f = fixture();
    const effect = f.reserve();
    const wrapper = effect.sessionStart;
    const prepare = f.store['db'].prepare.bind(f.store['db']);
    const fault = vi
      .spyOn(f.store['db'], 'prepare')
      .mockImplementation((sql) => {
        if (
          sql.startsWith(
            'INSERT INTO orchestration_conversation_native_fork_effect',
          )
        )
          throw new Error('injected projection write failure');
        return prepare(sql);
      });
    expect(wrapper.beginInvocation(NOW).kind).not.toBe('applied');
    fault.mockRestore();
    expect(effect.sessionStart).toBe(wrapper);
    let invoked = 0;
    await expect(
      runSessionStartWithBoundary(
        f.store.sessionTurnBoundaryAuthority(),
        'child',
        async () => {
          invoked++;
        },
        wrapper,
      ),
    ).rejects.toThrow();
    expect(invoked).toBe(0);
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('prepared');
    expect(f.store.hasEventId('fork-event')).toBe(false);
  });

  test.each(['before-commit', 'after-commit'] as const)(
    '%s failure poisons retained admission even when SQL outcome differs',
    async (timing) => {
      const f = fixture();
      const effect = f.reserve();
      const wrapper = effect.sessionStart;
      const exec = f.store['db'].exec.bind(f.store['db']);
      const fault = vi
        .spyOn(f.store['db'], 'exec')
        .mockImplementation((sql) => {
          if (sql === 'COMMIT') {
            if (timing === 'after-commit') exec(sql);
            throw new Error('injected commit outcome uncertainty');
          }
          return exec(sql);
        });
      expect(wrapper.beginInvocation(NOW).kind).not.toBe('applied');
      fault.mockRestore();
      let invoked = 0;
      await expect(
        runSessionStartWithBoundary(
          f.store.sessionTurnBoundaryAuthority(),
          'child',
          async () => {
            invoked++;
          },
          wrapper,
        ),
      ).rejects.toThrow();
      expect(invoked).toBe(0);
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(
        timing === 'after-commit' ? 'invoking' : 'prepared',
      );
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
      expect(f.store.hasEventId('fork-event')).toBe(false);
    },
  );

  test('caller-owned outer transaction and consumed wrapper never admit a second effect', () => {
    const f = fixture();
    const effect = f.reserve();
    f.store['db'].exec('BEGIN IMMEDIATE');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    f.store['db'].exec('ROLLBACK');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    const g = fixture();
    const next = g.reserve();
    expect(next.sessionStart.beginInvocation(NOW).kind).toBe('applied');
    expect(next.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
  });

  test.each([
    { childIdentity: CHILD_KEY },
    { cursorDigest: CHILD_KEY },
    { cursorJson: '{}' },
    { state: 'committed' },
    { version: 2 },
    { extra: 'unrecognized' },
  ])(
    'partial or unknown retained receipt refuses reads and old publication: %j',
    (patch) => {
      const f = fixture();
      f.reserve();
      const record = f.store.readNativeForkEffect('child');
      f.store['db']
        .prepare(
          'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
        )
        .run(JSON.stringify({ ...record, ...patch }), 'child');
      expect(() => f.store.readNativeForkEffect('child')).toThrow();
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow();
      expect(f.store.hasEventId('fork-event')).toBe(false);
    },
  );

  test('cursor is write-once, corruption fails closed, and existing intent cannot acquire another handle', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    expect(
      f.store.reserveNativeForkEffect({
        targetId: 'child',
        contextDigest: f.snapshot.digest,
        source: f.source,
      }).kind,
    ).toBe('existing');
    expect(() =>
      effect.observeChild({ nativeSessionId: 'other' }, CHILD_KEY),
    ).toThrow(/receipt conflicts/i);
    f.store['db']
      .prepare(
        'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
      )
      .run('{"version":99}', 'child');
    expect(() => f.store.readNativeForkEffect('child')).toThrow();
    expect(() =>
      f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
    ).toThrow();
  });
});
