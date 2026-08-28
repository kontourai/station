/**
 * @vitest-environment jsdom
 *
 * Productionizes the archive#726's probe against the ChatDock
 * derivation path: active-chats-store.notify replaces the *whole*
 * `allChats` map object on every updateChat call for ANY session
 * (active-chats-store.ts), and useAllActiveChats (ActiveChatsContext.tsx)
 * is an unfiltered subscription to that map — so without a per-session
 * cache, a keystroke in one open tab rebuilds every open tab's ChatSession
 * (and its cloned messages array/objects), which is what made the primary
 * ChatDock surface (not just ACPChatPanel) flash while typing.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// A stable array/object reference across renders, matching real
// useAgents (backed by react-query, which returns the same cached
// reference when the query data hasn't changed) — a fresh literal here
// would defeat useDerivedSessions' per-session cache on every render for
// reasons that have nothing to do with production behavior.
const STABLE_AGENTS = [{ slug: 'agent-one', name: 'Agent One' }];

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => STABLE_AGENTS,
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { conversationsStore } from '../contexts/ConversationsContext';
import {
  dedupeOptimisticMessages,
  useDerivedSessions,
} from '../hooks/useDerivedSessions';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

function clearChats() {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
}

describe('useDerivedSessions — ChatDock identity stability (station#726)', () => {
  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION_A, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Session A',
    });
    activeChatsStore.initChat(SESSION_B, {
      agentSlug: 'agent-one',
      agentName: 'Agent One',
      title: 'Session B',
    });
  });

  afterEach(() => {
    // Unmount any still-subscribed hook (via own act-wrapped cleanup)
    // before mutating the store — otherwise removeChat's notify reaches
    // a mounted useSyncExternalStore subscriber outside of act.
    cleanup();
    clearChats();
  });

  test("(a) a composer-only keystroke in a session does not change that session's derived identity", () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const before = result.current.find((s) => s.id === SESSION_A)!;
    expect(before).toBeDefined();

    act(() => {
      activeChatsStore.updateChat(SESSION_A, { input: 'h' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_A, { input: 'he' });
    });
    act(() => {
      activeChatsStore.updateChat(SESSION_A, { input: 'hel' });
    });

    const after = result.current.find((s) => s.id === SESSION_A)!;
    expect(after).toBe(before);
  });

  test('uses the neutral New chat label when neither local nor persisted state names the conversation', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    act(() => {
      activeChatsStore.updateChat(SESSION_A, { title: undefined as any });
    });

    expect(
      result.current.find((session) => session.id === SESSION_A)?.title,
    ).toBe('New chat');
  });

  test("(b) a keystroke in one session does not change another session's derived identity", () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;
    expect(sessionBBefore).toBeDefined();

    act(() => {
      activeChatsStore.updateChat(SESSION_A, { input: 'typing in A' });
    });

    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test('(c) a genuine transcript change (new message) produces a new identity for only that session', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionABefore = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      });
    });

    const sessionAAfter = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;

    expect(sessionAAfter).not.toBe(sessionABefore);
    expect(sessionAAfter.messages).toHaveLength(1);
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test('(c) an attachments change produces a new identity carrying the attachment (Context panel reads it off the derived session)', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionABefore = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        attachments: [{ id: 'att-1', name: 'notes.md' } as never],
      });
    });

    const sessionAAfter = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;

    expect(sessionAAfter).not.toBe(sessionABefore);
    expect(sessionAAfter.attachments).toHaveLength(1);
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test('(c) a status change produces a new identity for only that session', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionABefore = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, { status: 'sending' });
    });

    const sessionAAfter = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;

    expect(sessionAAfter).not.toBe(sessionABefore);
    expect(sessionAAfter.status).toBe('sending');
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test('(c) a pendingApprovals change produces a new identity for only that session', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionABefore = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        pendingApprovals: ['approval-1'],
      });
    });

    const sessionAAfter = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;

    expect(sessionAAfter).not.toBe(sessionABefore);
    expect(sessionAAfter.pendingApprovals).toEqual(['approval-1']);
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test("(b, #760) an activityHint update on session A changes only A's derived identity, not B's", () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const sessionABefore = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBBefore = result.current.find((s) => s.id === SESSION_B)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        activityHint: { kind: 'thinking', detail: '~1.2k tokens' },
      });
    });

    const sessionAAfter = result.current.find((s) => s.id === SESSION_A)!;
    const sessionBAfter = result.current.find((s) => s.id === SESSION_B)!;

    expect(sessionAAfter).not.toBe(sessionABefore);
    expect(sessionAAfter.activityHint).toEqual({
      kind: 'thinking',
      detail: '~1.2k tokens',
    });
    expect(sessionBAfter).toBe(sessionBBefore);
  });

  test('the top-level sessions array identity is stable when no session changed', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const before = result.current;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, { input: 'unrelated keystroke' });
    });

    expect(result.current).toBe(before);
  });

  test('a live text delta does not rebuild a 4k-row settled transcript', () => {
    const settled = Array.from({ length: 4_000 }, (_, index) => ({
      id: `persisted-${index}`,
      role: 'assistant' as const,
      content: `completed markdown ${index}`,
      timestamp: index,
    }));
    activeChatsStore.updateChat(SESSION_A, {
      status: 'sending',
      orchestrationTurnOpen: true,
      openTurnId: 'turn-live',
      messages: settled,
      streamingMessage: { role: 'assistant', content: 'a' },
    });
    const { result } = renderHook(() => useDerivedSessions('', null, null));
    const before = result.current.find((session) => session.id === SESSION_A)!;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        streamingMessage: { role: 'assistant', content: 'ab' },
      });
    });

    const after = result.current.find((session) => session.id === SESSION_A)!;
    expect(after).toBe(before);
    expect(after.messages).toBe(before.messages);
    expect(after.messages).toHaveLength(4_000);
    expect(after.messages[3_999]).toBe(before.messages[3_999]);
  });

  test('station#1207/#1292: an ephemeral notice (e.g. the error-state Retry) carries `ephemeral: true` so it actually renders through EphemeralMessage, not the plain bubble', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    act(() => {
      activeChatsStore.addEphemeralMessage(SESSION_A, {
        role: 'system',
        content: 'Something went wrong: Retry',
        action: { label: 'Retry', handler: () => {} },
      });
    });

    const sessionA = result.current.find((s) => s.id === SESSION_A)!;
    const notice = sessionA.messages.find(
      (m) => m.content === 'Something went wrong: Retry',
    );
    expect(notice).toBeDefined();
    expect(notice?.ephemeral).toBe(true);
    // archive#1292: every notice also gets a real id/timestamp — never left
    // for the caller to assign (or omit).
    expect(typeof (notice as any)?.id).toBe('string');
    expect(typeof notice?.timestamp).toBe('number');
  });

  test('station#1292: an ephemeral notice sorts next to the transcript, never at timestamp 0 (ahead of everything)', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        messages: [
          { role: 'user', content: 'hello', timestamp: 1000 },
          { role: 'assistant', content: 'hi there', timestamp: 2000 },
        ],
      });
    });
    act(() => {
      activeChatsStore.addEphemeralMessage(SESSION_A, {
        role: 'system',
        content: 'Something went wrong: Retry',
      });
    });

    const sessionA = result.current.find((s) => s.id === SESSION_A)!;
    const contents = sessionA.messages.map((m) => m.content);
    expect(contents).toEqual([
      'hello',
      'hi there',
      'Something went wrong: Retry',
    ]);
  });

  test('the top-level sessions array identity changes when a session genuinely changes', () => {
    const { result } = renderHook(() => useDerivedSessions('', null, null));

    const before = result.current;

    act(() => {
      activeChatsStore.updateChat(SESSION_A, {
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      });
    });

    expect(result.current).not.toBe(before);
  });

  // A plan-like streaming answer mints a fresh planArtifact object per text
  // delta. That must re-derive the session (the plan panel reads the artifact
  // off it) but must NOT rebuild the transcript: buildSessionMessages reads
  // no plan-dependent field, so rebuilding it per token re-parses markdown for
  // every mounted transcript row over the whole turn.
  describe('planArtifact-only changes (station#3351)', () => {
    const planArtifact = (rawText: string) => ({
      source: 'assistant' as const,
      rawText,
      steps: [{ content: 'one', status: 'pending' as const }],
      updatedAt: '2026-08-19T00:00:00.000Z',
    });

    function seedTranscript() {
      activeChatsStore.updateChat(SESSION_A, {
        status: 'sending',
        messages: [
          { role: 'user', content: 'plan it', timestamp: 1 },
          { role: 'assistant', content: '- step one', timestamp: 2 },
        ],
      });
    }

    test('a planArtifact-only change reuses the built messages array by reference', () => {
      seedTranscript();
      const { result } = renderHook(() => useDerivedSessions('', null, null));
      const before = result.current.find((s) => s.id === SESSION_A)!;
      // "- step one" is itself plan-like ("step" keyword), so the fallback
      // derivation already produced an artifact before the explicit update.
      expect(before.planArtifact?.steps).toHaveLength(1);

      act(() => {
        activeChatsStore.updateChat(SESSION_A, {
          planArtifact: planArtifact('- step one\n- step two'),
        });
      });

      const after = result.current.find((s) => s.id === SESSION_A)!;
      // Session identity moves (the artifact is new)…
      expect(after).not.toBe(before);
      expect(after.planArtifact?.rawText).toBe('- step one\n- step two');
      // …but the transcript array and its rows keep their references.
      expect(after.messages).toBe(before.messages);
      expect(after.messages[0]).toBe(before.messages[0]);
    });

    test('a planArtifact change alongside a transcript change still rebuilds the messages', () => {
      seedTranscript();
      const { result } = renderHook(() => useDerivedSessions('', null, null));
      const before = result.current.find((s) => s.id === SESSION_A)!;

      act(() => {
        activeChatsStore.updateChat(SESSION_A, {
          planArtifact: planArtifact('- step one\n- step two'),
          messages: [
            ...activeChatsStore.getSnapshot()[SESSION_A]!.messages!,
            { role: 'assistant', content: '- step three', timestamp: 3 },
          ],
        });
      });

      const after = result.current.find((s) => s.id === SESSION_A)!;
      expect(after.messages).not.toBe(before.messages);
      expect(after.messages).toHaveLength(3);
    });

    // buildSessionMessages reads four inputs. The reuse path excludes ONLY
    // planArtifact — these pin that a change to each of the other three,
    // alongside a planArtifact change, still rebuilds. That exclusion set is
    // exactly where a future edit widening reuse too far would break.
    test('a planArtifact change alongside a status change still rebuilds the messages', () => {
      seedTranscript();
      const { result } = renderHook(() => useDerivedSessions('', null, null));
      const before = result.current.find((s) => s.id === SESSION_A)!;

      act(() => {
        activeChatsStore.updateChat(SESSION_A, {
          status: 'idle',
          planArtifact: planArtifact('- step one\n- step two'),
        });
      });

      const after = result.current.find((s) => s.id === SESSION_A)!;
      // 'sending' → 'idle' switches buildSessionMessages from the
      // optimistic-tagging branch to the dedupe branch — different output.
      expect(after.messages).not.toBe(before.messages);
    });

    test('a planArtifact change alongside an ephemeralMessages change still rebuilds the messages', () => {
      seedTranscript();
      const { result } = renderHook(() => useDerivedSessions('', null, null));
      const before = result.current.find((s) => s.id === SESSION_A)!;

      act(() => {
        activeChatsStore.updateChat(SESSION_A, {
          planArtifact: planArtifact('- step one\n- step two'),
        });
        activeChatsStore.addEphemeralMessage(SESSION_A, {
          role: 'system',
          content: 'Something went wrong: Retry',
        });
      });

      const after = result.current.find((s) => s.id === SESSION_A)!;
      expect(after.messages).not.toBe(before.messages);
      expect(
        after.messages.some((m) => m.content === 'Something went wrong: Retry'),
      ).toBe(true);
    });

    test('a planArtifact change alongside a backendMessages change still rebuilds the messages', () => {
      const CONVERSATION_ID = 'conv-plan-reuse';
      const MESSAGES_KEY = `messages:agent-one:${CONVERSATION_ID}`;
      activeChatsStore.updateChat(SESSION_A, {
        conversationId: CONVERSATION_ID,
        status: 'idle',
        messages: [{ role: 'user', content: 'plan it', timestamp: 1 }],
      });
      const { result, rerender } = renderHook(() =>
        useDerivedSessions('', null, null),
      );
      const before = result.current.find((s) => s.id === SESSION_A)!;
      const store = conversationsStore as unknown as {
        messages: Record<string, unknown[]>;
        notify: () => void;
      };
      // Seed the same backend transcript first so a later plan-only step
      // would legitimately qualify for reuse.
      store.messages[MESSAGES_KEY] = [
        { role: 'user', content: 'plan it', timestamp: 1 },
      ];
      act(() => {
        store.notify();
      });
      rerender();

      act(() => {
        activeChatsStore.updateChat(SESSION_A, {
          planArtifact: planArtifact('- step one\n- step two'),
        });
        store.messages[MESSAGES_KEY] = [
          { role: 'user', content: 'plan it', timestamp: 1 },
          { role: 'assistant', content: '- step one', timestamp: 2 },
        ];
        store.notify();
      });
      rerender();

      const after = result.current.find((s) => s.id === SESSION_A)!;
      expect(after.messages).not.toBe(before.messages);
      expect(after.messages).toHaveLength(2);
      delete store.messages[MESSAGES_KEY];
    });
  });
});

describe('dedupeOptimisticMessages (station#1293 — identity-based reconciliation, not count-based slicing)', () => {
  test('drops nothing when there is no backend transcript yet (first optimistic send)', () => {
    const local = [{ role: 'user', content: 'hello' }];
    expect(dedupeOptimisticMessages(local, [])).toEqual(local);
  });

  test('drops every local message once the backend has caught up (ordinary reconcile)', () => {
    const local = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const backend = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    expect(dedupeOptimisticMessages(local, backend)).toEqual([]);
  });

  // The exact archive#1293 bug: a client-only row with no backend counterpart (an
  // error bubble finalizeAssistantTurn appended, a queue-drain optimistic
  // append, …) shifts every subsequent index by one under the old
  // `slice(backendMessages.length)` — the real user message right after it
  // then re-renders even though the backend already has it.
  test('does not duplicate a real user message that lands right after a client-only row with no backend counterpart', () => {
    const local = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'a reply' },
      // Client-only: never reached the backend (e.g. a committed streaming
      // error, or a slash-command echo).
      { role: 'assistant', content: 'a client-only aside' },
      { role: 'user', content: 'second turn' },
    ];
    const backend = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'a reply' },
      { role: 'user', content: 'second turn' },
    ];

    const optimisticOnly = dedupeOptimisticMessages(local, backend);

    // Only the genuinely client-only row survives as "still optimistic" —
    // "second turn" is NOT re-appended since the backend already has it.
    expect(optimisticOnly).toEqual([
      { role: 'assistant', content: 'a client-only aside' },
    ]);
  });

  test('never collapses two genuinely repeated turns into one (multiset, not a boolean seen-set)', () => {
    const local = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
      { role: 'user', content: 'hi' },
    ];
    const backend = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ];

    // Only ONE "hi" is already on the backend — the second, distinct send of
    // the same text is still genuinely optimistic and must survive.
    expect(dedupeOptimisticMessages(local, backend)).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  test('a genuinely new optimistic message not yet on the backend is kept', () => {
    const local = [
      { role: 'user', content: 'first turn' },
      { role: 'user', content: 'not yet sent' },
    ];
    const backend = [{ role: 'user', content: 'first turn' }];

    expect(dedupeOptimisticMessages(local, backend)).toEqual([
      { role: 'user', content: 'not yet sent' },
    ]);
  });
});

describe('useDerivedSessions — end to end: no duplicate user bubble across a backend reconcile (station#1293)', () => {
  const SESSION_ID = 'session-dedupe-e2e';
  const AGENT_SLUG = 'agent-one';
  const CONVERSATION_ID = 'conv-dedupe-e2e';
  const MESSAGES_KEY = `messages:${AGENT_SLUG}:${CONVERSATION_ID}`;

  beforeEach(() => {
    clearChats();
    activeChatsStore.initChat(SESSION_ID, {
      agentSlug: AGENT_SLUG,
      agentName: 'Agent One',
      title: 'Dedupe e2e chat',
      conversationId: CONVERSATION_ID,
    });
  });

  afterEach(() => {
    cleanup();
    clearChats();
    // Reset the real conversationsStore singleton's seeded backend messages
    // so this test doesn't leak state into any other file sharing the
    // singleton.
    (
      conversationsStore as unknown as { messages: Record<string, unknown> }
    ).messages[MESSAGES_KEY] = undefined as never;
    delete (
      conversationsStore as unknown as { messages: Record<string, unknown> }
    ).messages[MESSAGES_KEY];
  });

  test('a locally-appended user message is not re-rendered once the same content lands on the backend', () => {
    activeChatsStore.updateChat(SESSION_ID, {
      status: 'idle',
      messages: [
        { role: 'user', content: 'what can you help me with?', timestamp: 1 },
      ],
    });

    const { result, rerender } = renderHook(() =>
      useDerivedSessions('', null, null),
    );
    const before = result.current.find((s) => s.id === SESSION_ID)!;
    expect(before.messages.map((m) => m.content)).toEqual([
      'what can you help me with?',
    ]);

    // The backend transcript now carries the exact same turn — simulating
    // fetchMessages landing after the optimistic append.
    act(() => {
      (
        conversationsStore as unknown as {
          messages: Record<string, unknown[]>;
          notify: () => void;
        }
      ).messages[MESSAGES_KEY] = [
        { role: 'user', content: 'what can you help me with?' },
      ];
      (conversationsStore as unknown as { notify: () => void }).notify();
    });
    rerender();

    const after = result.current.find((s) => s.id === SESSION_ID)!;
    // Exactly one bubble — never a duplicate.
    expect(after.messages.map((m) => m.content)).toEqual([
      'what can you help me with?',
    ]);
  });

  // Verifier-reproduced coverage blind spot: reverting buildSessionMessages
  // to the old `slice(backendMessages.length)` passed the ENTIRE pre-fix
  // suite, including the test above — a single already-matching backend
  // transcript never exercises the index-shift bug. This recreates the
  // scenario that actually distinguishes old vs new code: a client-only row
  // (no backend counterpart) sitting BETWEEN two real turns shifts every
  // subsequent index by one under the old positional slice, so the second
  // real turn (already on the backend) gets sliced into "optimistic" and
  // rendered a second time.
  test('a client-only aside between two real turns does not duplicate the second turn once the backend catches up', () => {
    activeChatsStore.updateChat(SESSION_ID, {
      status: 'idle',
      messages: [
        { role: 'user', content: 'first turn', timestamp: 1 },
        // Client-only: never lands on the backend (mirrors a committed
        // streaming-error aside, or a slash-command echo) — this is what
        // shifts every following index by one under the old slice.
        { role: 'assistant', content: 'a client-only aside', timestamp: 2 },
        { role: 'user', content: 'second turn', timestamp: 3 },
      ],
    });

    const { result, rerender } = renderHook(() =>
      useDerivedSessions('', null, null),
    );

    // The backend transcript now carries BOTH real turns (but never the
    // aside) — simulating fetchMessages landing after both optimistic
    // appends.
    act(() => {
      (
        conversationsStore as unknown as {
          messages: Record<string, unknown[]>;
          notify: () => void;
        }
      ).messages[MESSAGES_KEY] = [
        { role: 'user', content: 'first turn' },
        { role: 'user', content: 'second turn' },
      ];
      (conversationsStore as unknown as { notify: () => void }).notify();
    });
    rerender();

    const after = result.current.find((s) => s.id === SESSION_ID)!;
    const contents = after.messages.map((m) => m.content);
    // "second turn" must appear exactly once — the old slice-based merge
    // duplicated it here (backend[first, second] + local.slice(2) === a
    // SECOND "second turn").
    expect(contents.filter((c) => c === 'second turn')).toHaveLength(1);
    // The client-only aside is still present, appended once as the
    // genuinely optimistic remainder.
    expect(contents.filter((c) => c === 'a client-only aside')).toHaveLength(1);
    expect(contents.filter((c) => c === 'first turn')).toHaveLength(1);
    expect(after.messages).toHaveLength(3);
  });
});
