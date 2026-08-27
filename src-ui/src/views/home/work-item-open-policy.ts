import type { HomeWorkItem } from './home-view-model';

/**
 * station#1297: what clicking/selecting a `HomeWorkItem` should do, decided
 * once from the item's own shape rather than three divergent per-surface
 * branches (`ChatDockInboxPanel` branched on `chatSessionId`,
 * `MobileTaskSwitcher` on `kind === 'chat'`, `HomeView.continueWork` on kind
 * with a third destination — none of them a product rule, just an accident
 * of which field happened to be populated).
 *
 * - `'focus'` — the item is already a live, in-memory chat tab
 *   (`chatSessionId` only exists for rows built from the active-chats
 *   store); switch to it.
 * - `'rehydrate'` — no live tab, but the item names a session Station can
 *   reopen (`orchestrationThreadId` + `agentSlug`, and the session is not
 *   `'read-only-attached'`): reopen it into the chat overlay via
 *   `useOpenConversation`/`openConversation`.
 * - `'navigate'` — a session Station cannot rehydrate (no `agentSlug` on
 *   the item, or `controlMode === 'read-only-attached'`): fall back to the
 *   Activity page, same as today.
 * - `'none'` — nothing actionable on this item (e.g. a bare Durable Task
 *   row with no correlated session/chat) — callers that give Task rows
 *   their own destination (see `HomeView.continueWork`) branch on `kind`
 *   before reaching this policy at all.
 */
export type WorkItemOpenAction =
  | { kind: 'focus'; chatSessionId: string }
  | {
      kind: 'rehydrate';
      conversationId: string;
      agentSlug: string;
      projectSlug?: string;
      projectName?: string;
      model?: string;
      /** Authoritative inventory timestamp used to anchor untimestamped
       * persisted messages during a cold-cache reopen. */
      conversationUpdatedAt?: string;
      /** Fallback navigation target if the rehydrate attempt fails (e.g. the
       *  agent was deleted after the session was created). */
      threadId: string;
    }
  | { kind: 'navigate'; threadId: string }
  | { kind: 'none' };

/**
 * Resolve a `HomeWorkItem` to the single open action every dock-owned
 * surface should agree on. Pure and side-effect-free — see `openWorkItem`
 * for the executor used by surfaces with direct callback access, and
 * `HomeView.continueWork` for a surface that instead dispatches
 * the shared open-chat focus action (it lives outside the ChatDock subtree that owns
 * `openConversation`).
 */
export function resolveWorkItemOpenAction(
  item: HomeWorkItem,
): WorkItemOpenAction {
  if (item.chatSessionId) {
    return { kind: 'focus', chatSessionId: item.chatSessionId };
  }
  if (!item.orchestrationThreadId) {
    return { kind: 'none' };
  }
  return resolveConversationOpenAction({
    threadId: item.orchestrationThreadId,
    agentSlug: item.agentSlug,
    controlMode: item.controlMode,
    projectSlug: item.projectSlug,
    // station#1312 review (cosmetic): a project-less session must not carry
    // a display name at all, or the fallback renders as a bogus project
    // badge in `ChatDockTabBar`. Mirrors `useChatDockActiveChatSync`'s
    // `conversation.projectSlug ?? undefined` (it doesn't even have a
    // project display name to consider).
    //
    // station#3227 A3: this read `item.projectSlug ? item.projectLabel : …`
    // back when `projectLabel` was exactly `projectSlug` whenever the slug
    // existed. `projectLabel` is now the canonical `sessionProjectLabel`,
    // which for a session carrying BOTH a delegated and a local slug returns
    // the delegated one plus its caveat ("station (unverified name match)")
    // — a sentence, correct on a row pill, wrong inside a tab badge. Reading
    // the raw slug the guard already tested is byte-identical to the old
    // behaviour and cannot pick up a caveat.
    projectName: item.projectSlug,
    model: item.model,
    conversationId: item.conversationId,
    conversationUpdatedAt: item.conversationUpdatedAt,
  });
}

/**
 * A session named directly rather than by a `HomeWorkItem` — the shape the
 * project page's Live work section (station#3202) has, because it renders
 * `OrchestrationSessionSummary`s straight out of the Sessions lane model
 * rather than Home's merged work list.
 */
export interface ConversationOpenSubject {
  threadId: string;
  /** Durable conversation identity when a handoff child differs from its thread. */
  conversationId?: string;
  agentSlug?: string;
  controlMode?: string;
  projectSlug?: string;
  projectName?: string;
  model?: string;
  conversationUpdatedAt?: string;
}

/**
 * The rehydrate-vs-navigate half of the policy, for a caller that already
 * knows it is holding an orchestration session and not a live chat tab.
 *
 * Split out rather than copied (station#3202). `resolveWorkItemOpenAction`
 * above now delegates to it, so "can Station reopen this, or must it hand you
 * to /activity?" is decided in exactly one place — the whole point of
 * station#1297, which existed because three surfaces had each branched their
 * own way.
 */
export function resolveConversationOpenAction(
  subject: ConversationOpenSubject,
): WorkItemOpenAction {
  const canRehydrate =
    Boolean(subject.agentSlug) && subject.controlMode !== 'read-only-attached';
  if (!canRehydrate) {
    return { kind: 'navigate', threadId: subject.threadId };
  }
  return {
    kind: 'rehydrate',
    conversationId: subject.conversationId ?? subject.threadId,
    agentSlug: subject.agentSlug!,
    projectSlug: subject.projectSlug,
    projectName: subject.projectName,
    model: subject.model,
    ...(subject.conversationUpdatedAt
      ? { conversationUpdatedAt: subject.conversationUpdatedAt }
      : {}),
    threadId: subject.threadId,
  };
}

/**
 * station#1297: the shared open-chat focus action's payload
 * (dispatched by `HomeView.continueWork` and `ProjectSidebar`, both outside
 * the `ChatDock` subtree that owns `openConversation`/`focusSession`).
 * `ChatDock`'s listener used to read only `sessionId` and silently drop the
 * event when that id wasn't a live tab — the same "rehydrate vs navigate"
 * accident as the inbox, just one hop further away. The optional fields
 * mirror the `'rehydrate'`/`'navigate'` branches of `WorkItemOpenAction` so
 * the listener can fall through instead of no-oping.
 */
export interface FocusChatEventDetail {
  sessionId?: string;
  conversationId?: string;
  agentSlug?: string;
  projectSlug?: string;
  projectName?: string;
  model?: string;
  conversationUpdatedAt?: string;
  threadId?: string;
}

/** Build the shared focus-action detail for a resolved action, or
 *  `null` for `'none'` (nothing to request). */
export function focusChatEventDetailForAction(
  action: WorkItemOpenAction,
): FocusChatEventDetail | null {
  switch (action.kind) {
    case 'focus':
      return { sessionId: action.chatSessionId };
    case 'rehydrate':
      return {
        conversationId: action.conversationId,
        agentSlug: action.agentSlug,
        projectSlug: action.projectSlug,
        projectName: action.projectName,
        model: action.model,
        ...(action.conversationUpdatedAt
          ? { conversationUpdatedAt: action.conversationUpdatedAt }
          : {}),
        threadId: action.threadId,
      };
    case 'navigate':
      return { threadId: action.threadId };
    case 'none':
      return null;
  }
}

export interface WorkItemOpenHandlers {
  onFocusChat: (chatSessionId: string) => void;
  /** Mirrors `useChatDockActions`' `openConversation` — resolves `false`
   *  when the row's agent no longer exists, in which case the executor
   *  falls back to `onOpenSession`. */
  onOpenConversation: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
    conversationUpdatedAt?: string,
  ) => Promise<boolean> | boolean | undefined;
  onOpenSession: (threadId: string) => void;
  /**
   * station#3687: whether the agent catalog has resolved successfully at
   * least once (`useAgentsLoaded`). `openConversation`'s `false` means "the
   * agent does not exist" ONLY once the catalog has answered — while it is
   * pending or failed, `useAgents()` supplies the shared empty array and
   * EVERY rehydrate resolves `false`, which used to bounce every inbox click
   * to `/activity`. Absent means "unknown", which is treated as loaded so
   * existing callers keep the #801 fallback.
   */
  agentsLoaded?: boolean;
}

/**
 * What actually happened to a click, so the caller can be honest about it —
 * acknowledge and stay quiet on a real open, explain a degraded catalog, and
 * say why a row has no open action instead of a silent dead click (the four
 * seams of station#3687's report that live at this layer).
 */
export type WorkItemOpenOutcome =
  /** Focused, opened, or navigated — the row did what a click promises. */
  | 'opened'
  /** The row's agent no longer exists; landed on `/activity` (#801). */
  | 'fallback'
  /** The agent catalog has not answered yet — nothing was navigated. */
  | 'catalog-pending'
  /** The row deliberately has no open action (durable task, remote session). */
  | 'none';

/**
 * Execute the resolved action for a surface with direct callback access
 * (`ChatDockInboxPanel`, `MobileTaskSwitcher` — both rendered inside
 * `ChatDock`, which owns `openConversation`). Awaits the rehydrate attempt
 * so a stale/deleted agent still lands the user on `/activity` instead of a
 * silent no-op (station#801's rule, extended to this seam).
 */
export async function openWorkItem(
  item: HomeWorkItem,
  handlers: WorkItemOpenHandlers,
): Promise<WorkItemOpenOutcome> {
  const action = resolveWorkItemOpenAction(item);
  switch (action.kind) {
    case 'focus':
      handlers.onFocusChat(action.chatSessionId);
      return 'opened';
    case 'rehydrate': {
      const opened = action.conversationUpdatedAt
        ? await handlers.onOpenConversation(
            action.conversationId,
            action.agentSlug,
            action.projectSlug,
            action.projectName,
            action.model,
            action.conversationUpdatedAt,
          )
        : await handlers.onOpenConversation(
            action.conversationId,
            action.agentSlug,
            action.projectSlug,
            action.projectName,
            action.model,
          );
      if (opened === false) {
        // station#3687 seam 1: `false` from an unanswered catalog is not
        // "this agent was deleted" — it is "nothing is known yet". Bouncing
        // the user to /activity on that reading turned every inbox click
        // into a teleport while a query was merely pending.
        if (handlers.agentsLoaded === false) {
          return 'catalog-pending';
        }
        handlers.onOpenSession(action.threadId);
        return 'fallback';
      }
      return 'opened';
    }
    case 'navigate':
      handlers.onOpenSession(action.threadId);
      return 'opened';
    case 'none':
      return 'none';
  }
}

/**
 * The user-presentable reason a click opened nothing. Every branch states
 * only what the outcome derivation established — a remote session genuinely
 * lives elsewhere, a durable task row has no transcript to open, and a
 * pending catalog is a wait, not a failure.
 */
export function workItemOpenFailureMessage(
  item: HomeWorkItem,
  outcome: Extract<WorkItemOpenOutcome, 'catalog-pending' | 'none'>,
): string {
  if (outcome === 'catalog-pending') {
    return 'Still loading your agents — try this item again in a moment.';
  }
  if (item.kind === 'remote-session') {
    const where = item.environmentLabel
      ? `on ${item.environmentLabel}`
      : 'on another Station';
    return `This session lives ${where}. Open it there to continue.`;
  }
  return 'This item has nothing to open from the inbox.';
}
