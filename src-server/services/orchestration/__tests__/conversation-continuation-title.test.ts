import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * #1536 B4 — "a conversation's title is re-derived from the LAST user message
 * every turn", reproduced from the audit home's own `orchestration.sqlite`.
 *
 * WHAT ACTUALLY HAPPENS. Turn 2, sent while turn 1 was still running, is
 * dispatched onto a CONTINUATION CHILD Session: a new thread id
 * `<root>:session:<uuid>` minted by `reserveNextConversationSession`. So
 * `orchestration_conversation_history` holds two rows for one conversation,
 * and — the part every consumer tripped over —
 * `buildOrchestrationSessionSummary` folds ONE thread's events, so the child's
 * `displayTitle` is the SECOND thing the person said. Every surface that
 * titles a session from it (Home's "Continue most recent work", the dock rail,
 * the open-chats list, via `utils/sessionDisplay.ts`'s `sessionTitle`) renamed
 * the conversation each turn.
 *
 * Two further facts this pins, both measured rather than assumed:
 *  - `listConversationHistoryPage` was ALREADY right about the title (its
 *    `root_title` window prefers the conversation's earliest Session), so the
 *    sidebar conversation list was never the defect. It is pinned here anyway,
 *    because the child row's own title now feeds it.
 *  - it was NOT right about `createdAt`: the child's `upsertSession` wrote its
 *    own start time onto the ROOT's history row, so `MIN(created_at)` returned
 *    the LATEST child's time and every continuation made the conversation look
 *    newly created.
 */

const makeTempDir = trackTempDirs();

const ROOT = 'claude:1788628457157';
const CHILD = `${ROOT}:session:3329a9d6-acde-4143-8421-b0b99bf6f0da`;
const OWNER = 'human:local:operator';
const TURN_ONE = 'Reply with exactly: TURN ONE OK';
const TURN_TWO = 'Reply with exactly: TURN TWO OK';

const ROOT_CREATED = '2026-09-05T17:14:40.000Z';
const CHILD_CREATED = '2026-09-05T17:14:45.000Z';
const LAST_UPDATED = '2026-09-05T17:14:46.774Z';

describe('a continuation child never renames its conversation (#1536 B4)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = makeTempDir('continuation-title-');
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
  });

  /** The exact two-thread shape the audit home recorded. */
  function seedTwoTurnConversation(): void {
    store.upsertSession({
      provider: 'claude',
      threadId: ROOT,
      status: 'ready',
      createdAt: ROOT_CREATED,
      updatedAt: LAST_UPDATED,
    } as never);
    store.appendEvent({
      eventId: 'root-started',
      provider: 'claude',
      threadId: ROOT,
      createdAt: ROOT_CREATED,
      method: 'session.started',
      sessionId: ROOT,
      metadata: { userId: OWNER, agentSlug: 'claude' },
    } as never);
    store.appendEvent({
      eventId: 'root-turn',
      provider: 'claude',
      threadId: ROOT,
      createdAt: '2026-09-05T17:14:40.500Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: TURN_ONE,
    } as never);

    // Turn 2 arrived while turn 1 was running, so it is dispatched onto a
    // reserved successor Session rather than the root thread.
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD,
      createdAt: CHILD_CREATED,
    });
    store.upsertSession({
      provider: 'claude',
      threadId: CHILD,
      status: 'ready',
      createdAt: CHILD_CREATED,
      updatedAt: LAST_UPDATED,
    } as never);
    store.appendEvent({
      eventId: 'child-started',
      provider: 'claude',
      threadId: CHILD,
      createdAt: CHILD_CREATED,
      method: 'session.started',
      sessionId: CHILD,
      metadata: { userId: OWNER, agentSlug: 'claude' },
    } as never);
    store.appendEvent({
      eventId: 'child-turn',
      provider: 'claude',
      threadId: CHILD,
      createdAt: '2026-09-05T17:14:45.500Z',
      method: 'turn.started',
      turnId: 'turn-2',
      prompt: TURN_TWO,
    } as never);
  }

  /** What every session-titling surface reads, for the thread on screen. */
  function displayTitleFor(threadId: string): string | undefined {
    const conversationFirstPromptedTurn =
      store.conversationRootFirstPromptedTurn(threadId)?.payload;
    return buildOrchestrationSessionSummary({
      persisted: {
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: ROOT_CREATED,
        updatedAt: LAST_UPDATED,
      } as never,
      events: store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload),
      ...(conversationFirstPromptedTurn
        ? { conversationFirstPromptedTurn }
        : {}),
      answerability: { answerable: false } as never,
    }).displayTitle;
  }

  test('the child thread folds only its own events, which start at the second prompt', () => {
    seedTwoTurnConversation();

    // The mechanism, stated so a later reader does not have to rediscover it:
    // nothing is wrong with the fold — the child genuinely has one turn, and
    // it is turn TWO.
    expect(
      store
        .listSessionProjectionEvents(CHILD)
        .filter((event) => event.method === 'turn.started')
        .map((event) => (event.payload as { prompt?: string }).prompt),
    ).toEqual([TURN_TWO]);
  });

  test("titles the child session from the CONVERSATION's first prompt, not its own", () => {
    seedTwoTurnConversation();

    expect(displayTitleFor(CHILD)).toBe(TURN_ONE);
    expect(displayTitleFor(CHILD)).not.toBe(TURN_TWO);
    // The root is unchanged: it already folds its own first turn, and the
    // derivation deliberately returns nothing for it rather than answering the
    // same question twice.
    expect(store.conversationRootFirstPromptedTurn(ROOT)).toBeUndefined();
    expect(displayTitleFor(ROOT)).toBe(TURN_ONE);
  });

  test('the child batch answers the same as the per-thread read', () => {
    seedTwoTurnConversation();

    const batched = store.conversationRootFirstPromptedTurnForThreads([
      ROOT,
      CHILD,
    ]);
    expect(batched.get(CHILD)?.id).toBe(
      store.conversationRootFirstPromptedTurn(CHILD)?.id,
    );
    // A root thread is absent from the batch too, not present-and-null.
    expect(batched.has(ROOT)).toBe(false);
  });

  test('lists ONE conversation, titled by its first prompt and created when it was', () => {
    seedTwoTurnConversation();

    const page = store.listConversationHistoryPage({
      ownerUserId: OWNER,
      limit: 20,
    });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      conversationId: ROOT,
      title: TURN_ONE,
      // The child's upsert used to stamp CHILD_CREATED here.
      createdAt: ROOT_CREATED,
      updatedAt: LAST_UPDATED,
    });
  });

  test("the child's own history row carries the conversation's title", () => {
    seedTwoTurnConversation();

    // Read the ROW, not the projection over it: the list's `root_title` window
    // is a second line of defence, and asserting through the list would pass
    // whether or not this row is right — which is the whole point of writing
    // it. No public per-row reader exists, so open the same file the store
    // just wrote.
    const database = new DatabaseSync(join(dir, 'orchestration.sqlite'), {
      readOnly: true,
    });
    try {
      const titles = database
        .prepare(
          `SELECT thread_id, title, created_at
           FROM orchestration_conversation_history
           ORDER BY created_at ASC, thread_id ASC`,
        )
        .all() as Array<{
        thread_id: string;
        title: string | null;
        created_at: string;
      }>;

      expect(titles).toEqual([
        { thread_id: ROOT, title: TURN_ONE, created_at: ROOT_CREATED },
        { thread_id: CHILD, title: TURN_ONE, created_at: CHILD_CREATED },
      ]);
    } finally {
      database.close();
    }
  });
  test('the rebuilt conversation index retains the captured human title', () => {
    const title = 'Where should preference state live?';
    store.upsertSession({
      provider: 'claude',
      threadId: ROOT,
      status: 'ready',
      createdAt: ROOT_CREATED,
      updatedAt: LAST_UPDATED,
    });
    store.appendEvent({
      eventId: 'room-start',
      provider: 'claude',
      threadId: ROOT,
      sessionId: ROOT,
      method: 'session.started',
      createdAt: ROOT_CREATED,
      metadata: { userId: OWNER, agentSlug: 'claude', delegationTitle: title },
    });
    store.appendEvent({
      eventId: 'room-turn',
      provider: 'claude',
      threadId: ROOT,
      turnId: 'room-turn',
      method: 'turn.started',
      createdAt: ROOT_CREATED,
      prompt: `${title}\n\n---\n# Task brief: Private context`,
    });
    expect(store.conversationTitle([ROOT])).toBe(title);
    store.close();
    const projection = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    projection.exec(
      'DELETE FROM orchestration_conversation_history; DELETE FROM orchestration_conversation_history_upgrade;',
    );
    projection.close();
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    expect(store.conversationTitle([ROOT])).toBe(title);
  });
});

/**
 * #4266: a thread showed the title "Continue". A low-content prompt never
 * names a conversation while a later prompt says something, and it never
 * replaces a real title.
 */
describe('low-content prompts keep the previous title (#4266)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = makeTempDir('low-content-title-');
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
  });

  function startThread(threadId: string, createdAt = ROOT_CREATED): void {
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt,
      updatedAt: LAST_UPDATED,
    } as never);
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      createdAt,
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: OWNER, agentSlug: 'claude' },
    } as never);
  }

  let turn = 0;
  function prompt(threadId: string, text: string): void {
    turn += 1;
    store.appendEvent({
      eventId: `${threadId}-turn-${turn}`,
      provider: 'claude',
      threadId,
      createdAt: `2026-09-05T17:15:${String(turn).padStart(2, '0')}.000Z`,
      method: 'turn.started',
      turnId: `turn-${turn}`,
      prompt: text,
    } as never);
  }

  function storedRow(threadId: string) {
    const database = new DatabaseSync(join(dir, 'orchestration.sqlite'), {
      readOnly: true,
    });
    try {
      return database
        .prepare(
          `SELECT title, title_source FROM orchestration_conversation_history
           WHERE thread_id = ?`,
        )
        .get(threadId);
    } finally {
      database.close();
    }
  }

  function displayTitle(threadId: string): string | undefined {
    const conversationFirstPromptedTurn =
      store.conversationRootFirstPromptedTurn(threadId)?.payload;
    return buildOrchestrationSessionSummary({
      persisted: {
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: ROOT_CREATED,
        updatedAt: LAST_UPDATED,
      } as never,
      events: store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload),
      ...(conversationFirstPromptedTurn
        ? { conversationFirstPromptedTurn }
        : {}),
      answerability: { answerable: false } as never,
    }).displayTitle;
  }

  test('["Continue", "Fix the dock header"] is titled "Fix the dock header" in the summary and the history row', () => {
    startThread(ROOT);
    prompt(ROOT, 'Continue');
    expect(storedRow(ROOT)).toEqual({
      title: 'Continue',
      title_source: 'prompt',
    });
    prompt(ROOT, 'Fix the dock header');

    expect(displayTitle(ROOT)).toBe('Fix the dock header');
    expect(storedRow(ROOT)).toEqual({
      title: 'Fix the dock header',
      title_source: 'prompt',
    });
    expect(
      store.listConversationHistoryPage({ ownerUserId: OWNER, limit: 20 })
        .records[0],
    ).toMatchObject({ title: 'Fix the dock header', titleSource: 'prompt' });
  });

  test('a meaningful first prompt is kept when a later prompt is "Continue"', () => {
    startThread(ROOT);
    prompt(ROOT, 'Fix the dock header');
    prompt(ROOT, 'Continue');
    prompt(ROOT, 'Refactor the composer');

    expect(displayTitle(ROOT)).toBe('Fix the dock header');
    expect(storedRow(ROOT)).toEqual({
      title: 'Fix the dock header',
      title_source: 'prompt',
    });
  });

  test('a lone low-content prompt still titles the thread when nothing better exists', () => {
    startThread(ROOT);
    prompt(ROOT, 'Continue');
    expect(displayTitle(ROOT)).toBe('Continue');
  });

  test('a continuation child opening with "Continue" keeps the conversation title', () => {
    startThread(ROOT);
    prompt(ROOT, 'Fix the dock header');
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD,
      createdAt: CHILD_CREATED,
    });
    startThread(CHILD, CHILD_CREATED);
    prompt(CHILD, 'Continue the task from where it stopped.');

    expect(displayTitle(CHILD)).toBe('Fix the dock header');
    expect(storedRow(CHILD)).toEqual({
      title: 'Fix the dock header',
      title_source: 'prompt',
    });
  });

  test('a stored "Continue" root title yields to a later Session\'s real title at read time', () => {
    // The root said only "Continue"; the conversation said what it was about
    // in its continuation child, whose row the root's title cannot reach.
    startThread(ROOT);
    prompt(ROOT, 'Continue');
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD,
      createdAt: CHILD_CREATED,
    });
    startThread(CHILD, CHILD_CREATED);
    prompt(CHILD, 'Fix the dock header');

    expect(storedRow(ROOT)).toEqual({
      title: 'Continue',
      title_source: 'prompt',
    });
    const page = store.listConversationHistoryPage({
      ownerUserId: OWNER,
      limit: 20,
    });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      conversationId: ROOT,
      title: 'Fix the dock header',
    });
    expect(store.conversationTitle([ROOT, CHILD])).toBe('Fix the dock header');
  });

  test('a generated title replaces only a prompt-derived title, and a later prompt never replaces it', () => {
    startThread(ROOT);
    prompt(ROOT, 'Continue');
    expect(
      store.recordGeneratedConversationTitle(ROOT, 'Dock header fix'),
    ).toBe(true);
    prompt(ROOT, 'Fix the dock header');
    expect(storedRow(ROOT)).toEqual({
      title: 'Dock header fix',
      title_source: 'generated',
    });
    // A second generation is refused by the row's own guard.
    expect(store.recordGeneratedConversationTitle(ROOT, 'Other')).toBe(false);
  });

  test('a start-supplied title is never replaced by a generated one', () => {
    store.upsertSession({
      provider: 'claude',
      threadId: ROOT,
      status: 'ready',
      createdAt: ROOT_CREATED,
      updatedAt: LAST_UPDATED,
    } as never);
    store.appendEvent({
      eventId: 'delegated-start',
      provider: 'claude',
      threadId: ROOT,
      createdAt: ROOT_CREATED,
      method: 'session.started',
      sessionId: ROOT,
      metadata: {
        userId: OWNER,
        agentSlug: 'claude',
        delegationTitle: 'Review the release notes',
      },
    } as never);
    prompt(ROOT, 'Review the release notes\n\n---\nbrief');
    expect(storedRow(ROOT)).toEqual({
      title: 'Review the release notes',
      title_source: 'provider',
    });
    expect(store.recordGeneratedConversationTitle(ROOT, 'Generated')).toBe(
      false,
    );
    expect(store.conversationTitleGenerationCandidate(ROOT)).toBeUndefined();
  });
});
