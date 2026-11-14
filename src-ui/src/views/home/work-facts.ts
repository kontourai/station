import { ownedWorkUnknownReasons } from '@kontourai/station-contracts/session-attention';
import { taskAwaitsAnswer } from '@kontourai/station-contracts/task-memory';
import type {
  OrchestrationSessionSummary,
  TaskListRecord,
} from '@kontourai/station-sdk';
import type { ChatStationBindingV1 } from '../../connections/station-connection';
import { chatBelongsToStation } from '../../connections/station-state';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { serverWorkLive } from '../../utils/conversation-activity';
import {
  orchestrationLifecycleLabel,
  sessionAttentionKind,
} from '../../utils/session-state';
import { requestAttentionKind } from '../../utils/waiting-approvals';
import { groupDelegatedSessionRuns } from '../sessions/run-groups';
import type { HomeWorkItem } from './home-view-model';

/**
 * THE FACTS BEHIND A ROW'S STATUS WORDS (#3042), derived BESIDE the work
 * item rather than carried on it.
 *
 * `HomeWorkItem` is the workspace-home projection surface: adding a field to
 * it widens the Home role's projection record and drops every granted Home
 * back to the built-in until it is re-consented. These facts are therefore a
 * parallel record keyed by item id, the same shape as the hover card's
 * `gitLocation`: a host that holds the session and chat records derives them
 * with `buildWorkFacts` and hands them to the row.
 *
 * Status facts refine the item's own ladder. Recorded parent links affect
 * presentation only: a run sits in its most urgent member's lane, while
 * each member retains its own status and controls.
 */

/**
 * WHAT a `Needs attention` item is waiting on. Each kind is a fact the
 * server or the chat store already records; none is inferred from copy.
 *
 * - `approval`: an open approval, permission or confirmation request (the
 *   session's `review_pending` fold or `pendingReview` flag; a chat's
 *   `pendingApprovals`).
 * - `answer`: an open `input` request (`needs_input` reached through
 *   `input_requested`).
 * - `interrupted`: the turn was cut short by a restart and recovery parked
 *   the session on `needs_input` (`transitionReason: 'runtime_exit'`).
 * - `blocked`: the session's `blocked` state, or a durable Task's.
 * - `queued`: a send queued on this device while offline.
 * - `waiting`: owed something, kind not recorded.
 */
export type WorkAttentionKind =
  | 'approval'
  | 'answer'
  | 'interrupted'
  | 'blocked'
  | 'delivery-unconfirmed'
  | 'queued'
  | 'waiting';

/**
 * What the server's `ConversationTurnActivity` says is in flight. Copied,
 * never re-derived: the open turn's start, the most recently started tool
 * still running inside it, and the reported running child count.
 */
export interface WorkActivity {
  turnStartedAt?: string;
  toolName?: string;
  childWorkCount?: number;
}

export interface WorkFacts {
  chatBinding?: ChatStationBindingV1;
  /** Host-only detail reads and controls must not borrow a bound receiver ID. */
  hostDetails?: boolean;
  /** Recorded run root, resolved against this presentation's row identities. */
  runRootId?: string;
  station?: { id: string; label: string };
  attention?: WorkAttentionKind;
  activity?: WorkActivity;
  ownedWorkState?: NonNullable<
    OrchestrationSessionSummary['ownedWork']
  >['state'];
  ownedStopReasons?: readonly string[];
  /**
   * The conversation's open or latest turn is one the engine opened on its
   * own (a reply to background work), not a send: the open turn's trigger
   * while it runs, the summary's `latestTurnTrigger` after. A fact beside the
   * item, not an item field, so the Home role projection is unchanged.
   */
  engineOpenedTurn?: true;
}

export type WorkFactsById = ReadonlyMap<string, WorkFacts>;

/**
 * Most urgent first. An item reads ONE kind; this order decides which
 * survives when a chat and its session each recorded a different one.
 */
const WORK_ATTENTION_ORDER: readonly WorkAttentionKind[] = [
  'approval',
  'answer',
  'waiting',
  'delivery-unconfirmed',
  'queued',
  'blocked',
  'interrupted',
];

function moreUrgentAttention(
  left: WorkAttentionKind | undefined,
  right: WorkAttentionKind | undefined,
): WorkAttentionKind | undefined {
  if (!left || !right) return left ?? right;
  return WORK_ATTENTION_ORDER.indexOf(right) <
    WORK_ATTENTION_ORDER.indexOf(left)
    ? right
    : left;
}

type TurnActivity = NonNullable<
  OrchestrationSessionSummary['conversationActivity']
>;

/**
 * `threadId` names the execution the row stands for. The conversation's
 * record is shared by every child's summary, so the open turn's start and
 * tool are reported only when that turn is on THIS thread, and the running
 * child count only when this thread is the one the server would continue
 * (the gate `orchestrationLifecycleLabel` applies before it says Running).
 * A stuck earlier child must not borrow the current child's turn or its
 * sub-agents.
 */
function workActivityFrom(
  activity: TurnActivity | undefined,
  threadId: string | undefined,
): WorkActivity | undefined {
  if (!activity) return undefined;
  const openTurn =
    activity.openTurn &&
    (threadId === undefined || activity.openTurn.threadId === threadId)
      ? activity.openTurn
      : undefined;
  const toolName = openTurn ? activity.runningTools?.at(-1)?.name : undefined;
  const childWorkCount =
    threadId === undefined || activity.currentThreadId === threadId
      ? activity.runningChildWork?.count
      : undefined;
  if (!openTurn && !childWorkCount) return undefined;
  return {
    ...(openTurn ? { turnStartedAt: openTurn.startedAt } : {}),
    ...(toolName ? { toolName } : {}),
    ...(childWorkCount ? { childWorkCount } : {}),
  };
}

/**
 * What a chat is waiting on, from the same three facts `chatLifecycleLabel`
 * reads for `Needs attention`, most specific first; `undefined` when the
 * chat holds none of them. `orchestrationStatus: 'awaiting-approval'` is the
 * coarse process status both an approval and a question map to, so alone it
 * says only "waiting".
 */
function chatAttentionKind(chat: ChatUIState): WorkAttentionKind | undefined {
  // Requests still waiting on the user, not every one open on the server: an
  // answered one waits on the engine (utils/waiting-approvals).
  const requestKind = requestAttentionKind(chat);
  if (requestKind) return requestKind;
  if (
    chat.outboundQueuedTurns?.some(
      (turn) =>
        turn.status === 'may-have-started' ||
        (turn.status === 'invoking' && turn.awaitingLookup),
    )
  )
    return 'delivery-unconfirmed';
  if (chat.status === 'queued') return 'queued';
  if (chat.orchestrationStatus === 'awaiting-approval') return 'waiting';
  return undefined;
}

interface WorkFactSources {
  items: readonly HomeWorkItem[];
  chats?: Readonly<Record<string, ChatUIState>>;
  sessions?: readonly OrchestrationSessionSummary[];
  tasks?: readonly TaskListRecord[];
  /** Same shape `buildHomeWorkItems` takes; keyed back by the item's id. */
  remoteEnvironments?: readonly {
    environmentId: string;
    sessions: readonly OrchestrationSessionSummary[];
  }[];
}

/**
 * Derives each item's facts from the records the item was built from: its
 * session by `orchestrationThreadId` (or, for a remote row, by the same
 * namespaced id the item carries), its chat by `chatSessionId`, its durable
 * Task by id. An item with no record here gets no entry, and its row says
 * only what its label says.
 */
export function buildWorkFacts({
  items,
  chats = {},
  sessions = [],
  tasks = [],
  remoteEnvironments = [],
}: WorkFactSources): Map<string, WorkFacts> {
  const sessionByThread = new Map(
    sessions.map((session) => [session.threadId, session]),
  );
  const remoteSessionById = new Map<string, OrchestrationSessionSummary>(
    remoteEnvironments.flatMap(({ environmentId, sessions: remote }) =>
      remote.map(
        (session) =>
          [`remote:${environmentId}:${session.threadId}`, session] as const,
      ),
    ),
  );
  const blockedTaskIds = new Set(
    tasks.filter((task) => task.status === 'blocked').map((task) => task.id),
  );
  // #4003: a Task with an open Task-memory question owes a person an answer.
  const answerTaskIds = new Set(
    tasks.filter(taskAwaitsAnswer).map((task) => task.id),
  );
  const facts = new Map<string, WorkFacts>();
  for (const item of items) {
    const session =
      item.kind === 'remote-session'
        ? remoteSessionById.get(item.id)
        : item.orchestrationThreadId
          ? sessionByThread.get(item.orchestrationThreadId)
          : undefined;
    const chat = item.chatSessionId ? chats[item.chatSessionId] : undefined;
    const entry: WorkFacts = {
      chatBinding: chat?.stationBinding,
      hostDetails:
        item.kind !== 'remote-session' && (!chat || chatBelongsToStation(chat)),
    };
    if (chat?.stationBinding && chat.stationBinding.affinity.kind !== 'host')
      entry.station = {
        id: chat.stationBinding.environmentId,
        label: chat.stationBinding.stationName,
      };
    if (
      session?.delegation?.environmentKind === 'peer' &&
      session.delegation.environmentId
    ) {
      entry.station = {
        id: session.delegation.environmentId,
        label:
          session.delegation.environmentName ??
          session.delegation.environmentId,
      };
    }
    if (
      session &&
      (session.conversationActivity?.openTurn
        ? session.conversationActivity.openTurn.trigger === 'provider'
        : session.latestTurnTrigger === 'provider')
    )
      entry.engineOpenedTurn = true;
    if (item.lifecycleLabel === 'Needs attention') {
      const attention = moreUrgentAttention(
        moreUrgentAttention(
          session && orchestrationLifecycleLabel(session) === 'Needs attention'
            ? sessionAttentionKind(session, chat?.answeredApprovals)
            : undefined,
          chat ? chatAttentionKind(chat) : undefined,
        ),
        moreUrgentAttention(
          item.kind === 'task' && answerTaskIds.has(item.id)
            ? 'answer'
            : undefined,
          item.kind === 'task' && blockedTaskIds.has(item.id)
            ? 'blocked'
            : undefined,
        ),
      );
      if (attention) entry.attention = attention;
    }
    if (item.lifecycleLabel === 'Running') {
      if (session?.ownedWork) {
        entry.ownedWorkState = session.ownedWork.state;
        entry.ownedStopReasons = ownedWorkUnknownReasons(session.ownedWork);
      }
      const activity =
        workActivityFrom(session?.conversationActivity, session?.threadId) ??
        // The chat's own copy of the server record; a turn a Stop receipt
        // already settled is not reported as still open.
        (chat && serverWorkLive(chat) === true
          ? workActivityFrom(
              chat.conversationActivity?.openTurn?.turnId ===
                chat.stopSettledTurnId
                ? { ...chat.conversationActivity!, openTurn: undefined }
                : chat.conversationActivity,
              undefined,
            )
          : undefined);
      if (activity) entry.activity = activity;
    }
    if (Object.keys(entry).length > 0) facts.set(item.id, entry);
  }
  const itemByThread = new Map<string, HomeWorkItem>();
  for (const item of items) {
    if (item.kind === 'remote-session') continue;
    for (const threadId of item.orchestrationThreadIds ??
      (item.orchestrationThreadId ? [item.orchestrationThreadId] : [])) {
      itemByThread.set(threadId, item);
    }
  }
  for (const presentation of groupDelegatedSessionRuns(sessions)) {
    if (presentation.kind !== 'run') continue;
    const root = itemByThread.get(presentation.run.parent.threadId);
    if (!root) continue;
    for (const member of presentation.run.members.slice(1)) {
      const child = itemByThread.get(member.threadId);
      if (!child || child.id === root.id) continue;
      facts.set(child.id, { ...facts.get(child.id), runRootId: root.id });
    }
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskItems = items.filter((item) => item.kind === 'task');
  for (const item of items) {
    if (item.kind === 'task' || item.kind === 'remote-session') continue;
    const identities = new Set([
      item.id,
      item.chatSessionId,
      item.conversationId,
      item.orchestrationThreadId,
      ...(item.orchestrationThreadIds ?? []),
    ]);
    const owners = taskItems.filter((candidate) =>
      [
        candidate.taskSessionId,
        ...(taskById.get(candidate.id)?.workChatConversationIds ?? []),
      ].some((id) => id !== undefined && identities.has(id)),
    );
    if (owners.length === 1)
      facts.set(item.id, { ...facts.get(item.id), runRootId: owners[0].id });
    else if (owners.length > 1) {
      const entry = { ...facts.get(item.id) };
      delete entry.runRootId;
      facts.set(item.id, entry);
    }
  }
  return facts;
}
