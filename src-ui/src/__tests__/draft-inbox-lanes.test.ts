import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { groupMobileActivity } from '../components/chat-dock/mobile-activity-groups';
import type { ChatUIState } from '../contexts/active-chats-state';
import { sessionStatusWord } from '../utils/session-state';
import { partitionHomeWorkItems } from '../views/home/home-lane-model';
import { buildHomeWorkItems } from '../views/home/home-view-model';
import { partitionSessionLanes } from '../views/sessions/sessions-lane-model';

/**
 * #2310 — a session nothing has been sent to is a Draft, and "Active now"
 * means actually active.
 *
 * FIXTURE PROVENANCE, stated exactly (review L2): `SERVER_DRAFT` has the
 * field SHAPE the server builder (`buildOrchestrationSessionSummary`, lineage
 * consulted) emits for a never-prompted ACP session — the fields it sets and
 * the states it folds to, notably `status: 'ready'` and
 * `lifecycleState: 'queued'`, which is why the old fold called it "Ready" and
 * filed it under Active now. It is hand-transcribed, not a byte capture:
 * `eventCount` and the timestamps are illustrative. The server-side test
 * (`session-draft-lifecycle.test.ts`) is where the builder itself runs
 * against the recorded event sequence.
 */
const THREAD = 'grok-build:1790099828990';
const NOW = Date.parse('2026-09-22T20:00:00.000Z');

const SERVER_DRAFT: OrchestrationSessionSummary = {
  provider: 'acp',
  threadId: THREAD,
  status: 'ready',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  createdAt: '2026-09-22T17:58:14.194Z',
  updatedAt: '2026-09-22T17:58:15.194Z',
  isLoaded: false,
  isPersisted: true,
  eventCount: 3,
  lifecycleState: 'queued',
  pendingReview: false,
  assignedAgentSlug:
    'grok-build' as OrchestrationSessionSummary['assignedAgentSlug'],
  projectSlug: 'example-project',
  conversationId: THREAD,
  environmentId: 'env-test',
  lastEventAt: '2026-09-22T17:58:14.534Z',
  lastEventMethod: 'policy.hooks-attached',
  effectiveModel: 'grok-4.7',
  effectiveModelOptions: {},
  requestedModel: 'grok-4.7',
  modelLaunchPlan: { kind: 'engine-selected', evidence: 'adapter-declared' },
  reportedModel: 'grok-4.7',
  hasActiveTurn: false,
  draft: true,
};

const SERVER_AFTER_FIRST_TURN: OrchestrationSessionSummary = {
  ...SERVER_DRAFT,
  lifecycleState: 'running',
  lastEventMethod: 'turn.started',
  hasActiveTurn: true,
  draft: false,
};

/**
 * A session with history and no open turn — the archive#1069 shape a restart
 * resume produces (`session.configured` re-attaches, `running`, no turn in
 * flight). The server says `draft: false`; it must stay in Active now.
 */
const SERVER_READY_WITH_HISTORY: OrchestrationSessionSummary = {
  ...SERVER_DRAFT,
  threadId: 'claude:1790000000000',
  conversationId: 'claude:1790000000000',
  provider: 'claude',
  lifecycleState: 'running',
  lastEventMethod: 'session.configured',
  hasActiveTurn: false,
  draft: false,
};

function inboxGroups(
  sessions: OrchestrationSessionSummary[],
  chats: Record<string, Partial<ChatUIState>> = {},
) {
  const items = buildHomeWorkItems({
    chats: chats as Record<string, ChatUIState>,
    sessions,
    agents: [],
  });
  const groups = groupMobileActivity(items, NOW, {});
  const idsIn = (id: string) =>
    groups.find((group) => group.id === id)?.items.map((item) => item.id) ?? [];
  return { items, groups, idsIn };
}

describe('Draft sessions are not "Active now" (#2310)', () => {
  test('the recorded never-prompted session is a Draft, listed under Drafts', () => {
    const { items, idsIn } = inboxGroups([SERVER_DRAFT]);
    expect(items[0]?.lifecycleLabel).toBe('Draft');
    expect(idsIn('active')).toEqual([]);
    expect(idsIn('drafts')).toEqual([THREAD]);
    expect(sessionStatusWord(SERVER_DRAFT)).toBe('Draft');
  });

  test('a session with history and no open turn stays in Active now', () => {
    const { idsIn } = inboxGroups([SERVER_READY_WITH_HISTORY]);
    expect(idsIn('active')).toEqual([SERVER_READY_WITH_HISTORY.threadId]);
    expect(idsIn('drafts')).toEqual([]);
    expect(sessionStatusWord(SERVER_READY_WITH_HISTORY)).toBe('Ready');
  });

  test('the first turn promotes the same row into Active now as Running', () => {
    const { items, idsIn } = inboxGroups([SERVER_AFTER_FIRST_TURN]);
    expect(items[0]?.lifecycleLabel).toBe('Running');
    expect(idsIn('active')).toEqual([THREAD]);
    expect(idsIn('drafts')).toEqual([]);
  });

  test('an absent draft field is not a Draft claim', () => {
    const { draft: _draft, ...undecided } = SERVER_DRAFT;
    const { items, idsIn } = inboxGroups([undecided]);
    expect(items[0]?.lifecycleLabel).toBe('Ready');
    expect(idsIn('active')).toEqual([THREAD]);
  });

  test('a Draft that failed or is waiting on the user keeps the more specific state', () => {
    const failed = { ...SERVER_DRAFT, lifecycleState: 'failed' as const };
    const waiting = {
      ...SERVER_DRAFT,
      threadId: 'grok-build:2',
      conversationId: 'grok-build:2',
      lifecycleState: 'needs_input' as const,
    };
    const { items } = inboxGroups([failed, waiting]);
    expect(
      Object.fromEntries(items.map((item) => [item.id, item.lifecycleLabel])),
    ).toEqual({ [THREAD]: 'Failed', 'grok-build:2': 'Needs attention' });
  });

  describe('a turn the user has already submitted never hides as a Draft', () => {
    // The open chat's store key IS the thread id for an eagerly created
    // session (`${agentSlug}:${Date.now()}`), so the chat row and the
    // server row fold into one conversation row.
    test('optimistic send (status sending) reads Running in Active now', () => {
      const { items, idsIn } = inboxGroups([SERVER_DRAFT], {
        [THREAD]: {
          agentSlug: 'grok-build',
          status: 'sending',
          orchestrationStatus: 'running',
          createdAt: Date.parse('2026-09-22T17:58:14.000Z'),
          messages: [],
        },
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.lifecycleLabel).toBe('Running');
      expect(idsIn('active')).toEqual([THREAD]);
    });

    test('an offline-queued first message reads Needs attention in Active now', () => {
      const { items, idsIn } = inboxGroups([SERVER_DRAFT], {
        [THREAD]: {
          agentSlug: 'grok-build',
          status: 'queued',
          orchestrationStatus: 'running',
          createdAt: Date.parse('2026-09-22T17:58:14.000Z'),
          messages: [],
        },
      });
      expect(items[0]?.lifecycleLabel).toBe('Needs attention');
      expect(idsIn('active')).toEqual([THREAD]);
    });

    test('an idle open chat on a Draft session defers to the server: Draft', () => {
      const { items, idsIn } = inboxGroups([SERVER_DRAFT], {
        [THREAD]: {
          agentSlug: 'grok-build',
          status: 'idle',
          orchestrationStatus: 'running',
          createdAt: Date.parse('2026-09-22T17:58:14.000Z'),
          messages: [],
        },
      });
      expect(items[0]?.lifecycleLabel).toBe('Draft');
      expect(idsIn('drafts')).toEqual([THREAD]);
    });
  });

  // #2310 review H1: the sending device. Opening a Draft marks the chat
  // started, so the first send used to leave the session list cache alone;
  // once the turn finished the chat read 'Recent' (not locally actionable)
  // and the stale server Draft won the merge — real work filed as a Draft.
  // Driven through the real merge, one state per step, with the server
  // summary deliberately NOT refreshed at any step.
  test('open a Draft, send, turn completes: the row never falls back into Drafts', () => {
    const chatKey = 'grok-build:1790100000000';
    const opened: Partial<ChatUIState> = {
      agentSlug: 'grok-build',
      conversationId: THREAD,
      currentSessionId: THREAD,
      orchestrationSessionStarted: true,
      status: 'idle',
      createdAt: Date.parse('2026-09-22T19:00:00.000Z'),
      messages: [],
    };
    const userMessage = {
      role: 'user',
      content: 'first prompt',
      timestamp: Date.parse('2026-09-22T19:00:05.000Z'),
    };
    const sending: Partial<ChatUIState> = {
      ...opened,
      status: 'sending',
      orchestrationStatus: 'running',
      messages: [userMessage] as ChatUIState['messages'],
    };
    const completed: Partial<ChatUIState> = {
      ...opened,
      status: 'idle',
      orchestrationStatus: 'running',
      messages: [
        userMessage,
        {
          role: 'assistant',
          content: 'done',
          timestamp: Date.parse('2026-09-22T19:00:09.000Z'),
        },
      ] as ChatUIState['messages'],
    };
    const step = (chat: Partial<ChatUIState>) => {
      const { items, idsIn } = inboxGroups([SERVER_DRAFT], {
        [chatKey]: chat,
      });
      expect(items).toHaveLength(1);
      return { label: items[0]?.lifecycleLabel, drafts: idsIn('drafts') };
    };

    expect(step(opened)).toEqual({ label: 'Draft', drafts: [THREAD] });
    expect(step(sending)).toEqual({ label: 'Running', drafts: [] });
    const after = step(completed);
    expect(after.drafts).toEqual([]);
    expect(after.label).not.toBe('Draft');
  });

  // Review M1: the recorded grok thread's sends were refused and nothing
  // started. The server folds that to Failed with a send_refused reason; the
  // row leaves Active now through the terminal lane and says why.
  test('a refused first send is Failed with its reason, not a Draft and not active', () => {
    const refused: OrchestrationSessionSummary = {
      ...SERVER_DRAFT,
      lifecycleState: 'failed',
      draft: false,
      terminalAttribution: {
        kind: 'send_refused',
        detail:
          'Sending the first message failed before anything started. Nothing ran in this session.',
      },
    };
    const { items, idsIn } = inboxGroups([refused]);
    expect(items[0]?.lifecycleLabel).toBe('Failed');
    expect(items[0]?.failureNotice).toContain('first message failed');
    expect(idsIn('active')).toEqual([]);
    expect(idsIn('drafts')).toEqual([]);
    // A terminal lane: "Just finished" while it lingers, "Earlier" after
    // (this fixture is two hours old, so Earlier).
    expect([...idsIn('settled'), ...idsIn('earlier')]).toEqual([THREAD]);
  });

  test('Home and the Sessions list file the Draft the same way', () => {
    const items = buildHomeWorkItems({
      chats: {},
      sessions: [SERVER_DRAFT, SERVER_READY_WITH_HISTORY],
      agents: [],
    });
    const partition = partitionHomeWorkItems({
      items,
      now: NOW,
      snoozedUntil: new Map(),
      terminalSince: new Map(),
    });
    expect(partition.active.map((item) => item.id)).toEqual([
      SERVER_READY_WITH_HISTORY.threadId,
    ]);
    expect(partition.drafts?.map((item) => item.id)).toEqual([THREAD]);

    const lanes = partitionSessionLanes({
      sessions: [SERVER_DRAFT, SERVER_READY_WITH_HISTORY],
      agents: [],
      now: NOW,
    });
    expect(
      Object.fromEntries(
        lanes.map((lane) => [
          lane.id,
          lane.sessions.map((session) => session.threadId),
        ]),
      ),
    ).toEqual({
      activeNow: [SERVER_READY_WITH_HISTORY.threadId],
      drafts: [THREAD],
    });
  });
});
