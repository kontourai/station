import type {
  OrchestrationSessionSummary,
  TaskRecord,
} from '@kontourai/station-sdk';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { serverWorkLive } from '../../utils/conversation-activity';
import {
  orchestrationLifecycleLabel,
  sessionAttentionKind,
} from '../../utils/session-state';
import { requestsWaitingOnUser } from '../../utils/waiting-approvals';
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
 * They only ever REFINE the words inside the lane the item's own
 * `lifecycleLabel` already decided (see `workStatus`): each fact is read
 * only under the label it explains, so a fact can never contradict the lane.
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
  attention?: WorkAttentionKind;
  activity?: WorkActivity;
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
  if (requestsWaitingOnUser(chat).length > 0) return 'approval';
  if (chat.status === 'queued') return 'queued';
  if (chat.orchestrationStatus === 'awaiting-approval') return 'waiting';
  return undefined;
}

interface WorkFactSources {
  items: readonly HomeWorkItem[];
  chats?: Readonly<Record<string, ChatUIState>>;
  sessions?: readonly OrchestrationSessionSummary[];
  tasks?: readonly TaskRecord[];
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
  const facts = new Map<string, WorkFacts>();
  for (const item of items) {
    const session =
      item.kind === 'remote-session'
        ? remoteSessionById.get(item.id)
        : item.orchestrationThreadId
          ? sessionByThread.get(item.orchestrationThreadId)
          : undefined;
    const chat = item.chatSessionId ? chats[item.chatSessionId] : undefined;
    const entry: WorkFacts = {};
    if (item.lifecycleLabel === 'Needs attention') {
      const attention = moreUrgentAttention(
        moreUrgentAttention(
          session && orchestrationLifecycleLabel(session) === 'Needs attention'
            ? sessionAttentionKind(session)
            : undefined,
          chat ? chatAttentionKind(chat) : undefined,
        ),
        item.kind === 'task' && blockedTaskIds.has(item.id)
          ? 'blocked'
          : undefined,
      );
      if (attention) entry.attention = attention;
    }
    if (item.lifecycleLabel === 'Running') {
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
  return facts;
}
