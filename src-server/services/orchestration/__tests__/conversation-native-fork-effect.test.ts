import { join } from 'node:path';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createConversationForkContext,
  type NativeForkCommitInput,
  type NativeForkEffectClaim,
  type NativeForkSourceSeal,
} from '../conversation-fork-context.js';
import { EventStore } from '../event-store.js';
import { runSessionStartWithBoundary } from '../session-turn-boundary.js';

const NOW = '2030-01-01T00:00:00.000Z';
const SOURCE_KEY = 'a'.repeat(64);
const CHILD_KEY = 'b'.repeat(64);

describe('native fork SQLite effect and publication ownership', () => {
  const temp = trackTempDirs();
  const stores = new Set<EventStore>();
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.clear();
  });
  function fixture() {
    const root = temp('station-native-fork-effect-');
    const path = join(root, 'events.sqlite');
    let store = new EventStore(path);
    stores.add(store);
    const sourceSession: ProviderSession = {
      provider: 'codex',
      threadId: 'source',
      status: 'ready',
      cwd: root,
      resumeCursor: { nativeSessionId: 'source-native' },
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.upsertSession(sourceSession);
    store.claimNativeSessionIdentity(SOURCE_KEY, 'source');
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
        },
      },
      forkEvent,
    };
    return {
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
