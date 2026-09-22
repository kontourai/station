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
 * FIXTURE FIDELITY: `SERVER_DRAFT` is the summary the server's own builder
 * (`buildOrchestrationSessionSummary`, lineage consulted) produced for the
 * event sequence the nightly home recorded for `grok-build:1790099828990` —
 * `session.started`, 31 `_x.ai` notifications, `session.configured`,
 * `policy.hooks-attached`, no turn. Captured by running that builder, not
 * imagined: note `lifecycleState: 'queued'` and `status: 'ready'`, which is
 * why the old fold called it "Ready" and filed it under Active now.
 * `SERVER_AFTER_FIRST_TURN` is the same builder's output once `turn.started`
 * lands.
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
