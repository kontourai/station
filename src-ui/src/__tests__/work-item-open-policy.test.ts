import { describe, expect, it, vi } from 'vitest';
import type { HomeWorkItem } from '../views/home/home-view-model';
import { buildOrchestrationItems } from '../views/home/home-view-model';
import {
  focusChatEventDetailForAction,
  openWorkItem,
  resolveWorkItemOpenAction,
  workItemOpenFailureMessage,
} from '../views/home/work-item-open-policy';

function baseItem(overrides: Partial<HomeWorkItem> = {}): HomeWorkItem {
  return {
    id: 'item-1',
    kind: 'orchestration',
    kindLabel: 'Session',
    title: 'Some session',
    projectLabel: 'station',
    agentLabel: 'Claude Code',
    modelLabel: 'Sonnet',
    updatedAt: Date.now(),
    lifecycleLabel: 'Ready',
    ...overrides,
  };
}

describe('resolveWorkItemOpenAction (station#1297)', () => {
  it('focuses an existing live tab, regardless of any other field', () => {
    const item = baseItem({
      kind: 'chat',
      chatSessionId: 'chat-1',
      orchestrationThreadId: 'thread-1',
      agentSlug: 'claude-code',
      controlMode: 'read-only-attached',
    });
    expect(resolveWorkItemOpenAction(item)).toEqual({
      kind: 'focus',
      chatSessionId: 'chat-1',
    });
  });

  it('rehydrates a session with a resolvable agent and no live tab', () => {
    const item = baseItem({
      orchestrationThreadId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: 'station',
// archive#3227 A3: this fixture read `projectLabel: 'Station'` — a
// capitalised display name distinct from the slug, which
// `buildSessionWorkItem` has never emitted for a session item (its
// label was `session.projectSlug` verbatim). The fixture-vs-reality gap
// is why it was the only thing holding `projectName` to the LABEL
// rather than to the slug. Now that the label is the canonical
// `sessionProjectLabel`, which can carry a caveat clause, the fixture
// says what the producer actually produces.
      projectLabel: 'station',
      controlMode: 'station-owned',
      conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
    });
    expect(resolveWorkItemOpenAction(item)).toEqual({
      kind: 'rehydrate',
      conversationId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: 'station',
      projectName: 'station',
      model: undefined,
      conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
      threadId: 'thread-1',
    });
  });

  it('rehydrates a handoff child through its durable conversation identity', () => {
    const item = baseItem({
      id: 'conversation-1',
      conversationId: 'conversation-1',
      orchestrationThreadId: 'claude-child-execution',
      orchestrationThreadIds: [
        'codex-predecessor-execution',
        'claude-child-execution',
      ],
      agentSlug: 'claude-code',
      controlMode: 'station-owned',
    });

    expect(resolveWorkItemOpenAction(item)).toMatchObject({
      kind: 'rehydrate',
      conversationId: 'conversation-1',
      threadId: 'claude-child-execution',
    });
  });

/**
* archive#3227 A3, the discriminating case — built through the real
* producer rather than a hand-written item, because the defect this guards
* is only reachable via what `buildSessionWorkItem` emits.
*
* The server sets a session's top-level `projectSlug` FROM
* `delegation.projectSlug` when there is one
* (`orchestration-session-state.ts`), so a delegated session carries both,
* and `sessionProjectLabel` qualifies the delegated one with its join
* caveat. That caveat is a sentence — right on a row pill, wrong inside a
* chat-dock tab badge, which is what `projectName` becomes. The tab badge
* must get the bare slug.
*/
  it('never carries a project-join caveat into the rehydrated tab badge', () => {
    const [item] = buildOrchestrationItems(
      [
        {
          threadId: 'thread-delegated',
          provider: 'claude',
          status: 'ready',
          controlMode: 'station-owned',
          isLoaded: true,
          isPersisted: true,
          eventCount: 0,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
          answerability: { answerable: true },
          projectSlug: 'station',
          assignedAgentSlug: 'claude-code',
          delegation: {
            taskId: 'task-1',
            projectSlug: 'station',
            projectSlugJoin: 'unverified-cross-machine',
          },
        },
      ] as never,
      [],
    );

// The row itself still says the whole truth.
    expect(item.projectLabel).toBe('station (unverified name match)');

    const action = resolveWorkItemOpenAction(item);
    expect(action.kind).toBe('rehydrate');
    expect(action).toMatchObject({
      projectSlug: 'station',
      projectName: 'station',
    });
  });

 // archive#1312 (cosmetic): `projectLabel` falls back to the
// literal string 'No project' for a project-less session
// (`buildSessionWorkItem`) — forwarding it unconditionally as
// `projectName` would render a bogus "No project" badge in
// `ChatDockTabBar`. Omit both when there's no real `projectSlug`.
  it('omits projectName/projectSlug when rehydrating a project-less session', () => {
    const item = baseItem({
      orchestrationThreadId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: undefined,
      projectLabel: 'No project',
      controlMode: 'station-owned',
    });
    expect(resolveWorkItemOpenAction(item)).toEqual({
      kind: 'rehydrate',
      conversationId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: undefined,
      projectName: undefined,
      threadId: 'thread-1',
    });
  });

  it('navigates instead of rehydrating a read-only-attached session', () => {
    const item = baseItem({
      orchestrationThreadId: 'thread-1',
      agentSlug: 'claude-code',
      controlMode: 'read-only-attached',
    });
    expect(resolveWorkItemOpenAction(item)).toEqual({
      kind: 'navigate',
      threadId: 'thread-1',
    });
  });

  it('navigates instead of rehydrating when no agent is known for the session', () => {
    const item = baseItem({
      orchestrationThreadId: 'thread-1',
      controlMode: 'station-owned',
    });
    expect(resolveWorkItemOpenAction(item)).toEqual({
      kind: 'navigate',
      threadId: 'thread-1',
    });
  });

  it('resolves to none for a row with neither a live tab nor a session', () => {
    const item = baseItem({ kind: 'task' });
    expect(resolveWorkItemOpenAction(item)).toEqual({ kind: 'none' });
  });
});

describe('openWorkItem', () => {
  it('calls onFocusChat for a live tab', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn();
    const onOpenSession = vi.fn();
    const outcome = await openWorkItem(
      baseItem({ kind: 'chat', chatSessionId: 'chat-1' }),
      {
        onFocusChat,
        onOpenConversation,
        onOpenSession,
      },
    );
    expect(outcome).toBe('opened');
    expect(onFocusChat).toHaveBeenCalledWith('chat-1');
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('calls onOpenConversation for a rehydratable session', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn().mockResolvedValue(true);
    const onOpenSession = vi.fn();
    await openWorkItem(
      baseItem({
        orchestrationThreadId: 'thread-1',
        agentSlug: 'claude-code',
        projectSlug: 'station',
        model: 'conversation-model',
        conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
      }),
      { onFocusChat, onOpenConversation, onOpenSession },
    );
    expect(onOpenConversation).toHaveBeenCalledWith(
      'thread-1',
      'claude-code',
      'station',
      'station',
      'conversation-model',
      '2020-06-15T12:00:00.000Z',
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('falls back to onOpenSession when the rehydrate attempt reports failure', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn().mockResolvedValue(false);
    const onOpenSession = vi.fn();
    const outcome = await openWorkItem(
      baseItem({ orchestrationThreadId: 'thread-1', agentSlug: 'gone' }),
      { onFocusChat, onOpenConversation, onOpenSession, agentsLoaded: true },
    );
    expect(outcome).toBe('fallback');
    expect(onOpenSession).toHaveBeenCalledWith('thread-1');
  });

// archive#3687 seam 1: `false` from openConversation means "agent deleted"
// ONLY once the catalog has answered. While it is pending or failed, every
// rehydrate resolves false — and this used to bounce EVERY inbox click to
// /activity during a loading blip.
  it('reports catalog-pending instead of bouncing to /activity while agents have not loaded', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn().mockResolvedValue(false);
    const onOpenSession = vi.fn();
    const outcome = await openWorkItem(
      baseItem({ orchestrationThreadId: 'thread-1', agentSlug: 'claude' }),
      { onFocusChat, onOpenConversation, onOpenSession, agentsLoaded: false },
    );
    expect(outcome).toBe('catalog-pending');
// The whole point: nothing navigated.
    expect(onOpenSession).not.toHaveBeenCalled();
  });

 // Absent means unknown, which keeps the archive#801 fallback for existing callers
// a loading gate must be opted into with a real derivation, never
// defaulted on.
  it('keeps the #801 fallback when agentsLoaded is not supplied', async () => {
    const onOpenSession = vi.fn();
    const outcome = await openWorkItem(
      baseItem({ orchestrationThreadId: 'thread-1', agentSlug: 'gone' }),
      {
        onFocusChat: vi.fn(),
        onOpenConversation: vi.fn().mockResolvedValue(false),
        onOpenSession,
      },
    );
    expect(outcome).toBe('fallback');
    expect(onOpenSession).toHaveBeenCalledWith('thread-1');
  });

  it('calls onOpenSession directly for a read-only-attached session', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn();
    const onOpenSession = vi.fn();
    await openWorkItem(
      baseItem({
        orchestrationThreadId: 'thread-1',
        agentSlug: 'claude-code',
        controlMode: 'read-only-attached',
      }),
      { onFocusChat, onOpenConversation, onOpenSession },
    );
    expect(onOpenSession).toHaveBeenCalledWith('thread-1');
    expect(onOpenConversation).not.toHaveBeenCalled();
  });

  it('reports none for an item with no actionable session — a silent dead click is the defect (station#3687 seam 3)', async () => {
    const onFocusChat = vi.fn();
    const onOpenConversation = vi.fn();
    const onOpenSession = vi.fn();
    const outcome = await openWorkItem(baseItem({ kind: 'task' }), {
      onFocusChat,
      onOpenConversation,
      onOpenSession,
    });
    expect(outcome).toBe('none');
    expect(onFocusChat).not.toHaveBeenCalled();
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

describe('workItemOpenFailureMessage (station#3687 seam 3)', () => {
  it('names where a remote session actually lives', () => {
    expect(
      workItemOpenFailureMessage(
        baseItem({
          kind: 'remote-session',
          environmentLabel: 'Living Room Mac',
        }),
        'none',
      ),
    ).toBe('This session lives on Living Room Mac. Open it there to continue.');
    expect(
      workItemOpenFailureMessage(baseItem({ kind: 'remote-session' }), 'none'),
    ).toBe('This session lives on another Station. Open it there to continue.');
  });

  it('says a pending catalog is a wait, not a failure', () => {
    expect(
      workItemOpenFailureMessage(baseItem({ kind: 'chat' }), 'catalog-pending'),
    ).toMatch(/still loading/i);
  });

  it('says a durable task row has nothing to open', () => {
    expect(workItemOpenFailureMessage(baseItem({ kind: 'task' }), 'none')).toBe(
      'This item has nothing to open from the inbox.',
    );
  });
});

describe('focusChatEventDetailForAction', () => {
  it('carries only sessionId for a focus action', () => {
    expect(
      focusChatEventDetailForAction({ kind: 'focus', chatSessionId: 'c1' }),
    ).toEqual({ sessionId: 'c1' });
  });

  it('carries the full rehydrate payload for a rehydrate action', () => {
    expect(
      focusChatEventDetailForAction({
        kind: 'rehydrate',
        conversationId: 'thread-1',
        agentSlug: 'claude-code',
        projectSlug: 'station',
        projectName: 'Station',
        conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
        threadId: 'thread-1',
      }),
    ).toEqual({
      conversationId: 'thread-1',
      agentSlug: 'claude-code',
      projectSlug: 'station',
      projectName: 'Station',
      conversationUpdatedAt: '2020-06-15T12:00:00.000Z',
      threadId: 'thread-1',
    });
  });

  it('carries only threadId for a navigate action', () => {
    expect(
      focusChatEventDetailForAction({ kind: 'navigate', threadId: 't1' }),
    ).toEqual({ threadId: 't1' });
  });

  it('returns null for none', () => {
    expect(focusChatEventDetailForAction({ kind: 'none' })).toBeNull();
  });
});
