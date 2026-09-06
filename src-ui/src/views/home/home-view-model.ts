import { parseEngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { unanswerableRequestNotice } from '@kontourai/station-contracts/orchestration';
import type {
  OrchestrationSessionSummary,
  SessionControlMode,
  TaskRecord,
} from '@kontourai/station-sdk';
import type { ChatUIState } from '../../contexts/active-chats-state';
import type { AgentSummary } from '../../types';
import type { HomeLifecycleLabel } from '../../utils/lifecycle-priority';
import {
  LIFECYCLE_PRIORITY,
  moreImportantLifecycle,
} from '../../utils/lifecycle-priority';
import { modelIdentityLabel } from '../../utils/modelCapabilities';
import {
  activeTurnProgress,
  orchestrationLifecycleLabel,
} from '../../utils/session-state';
import { sessionProjectLabel, sessionTitle } from '../../utils/sessionDisplay';

export interface HomeWorkItem {
  id: string;
  /** Durable conversation identity when this row represents one. */
  conversationId?: string;
  kind: 'task' | 'chat' | 'orchestration' | 'remote-session';
  kindLabel: 'Durable Task' | 'Direct chat' | 'Session' | 'Remote session';
  title: string;
  projectLabel: string;
  agentLabel: string;
  modelLabel: string;
  /** Conversation's reported model, preserved for reopen rather than display only. */
  model?: string;
  /** Present only when this row is represented by the canonical conversation inventory. */
  conversationUpdatedAt?: string;
  /** Epoch ms of the inventory version the current user has opened. */
  acknowledgedAt?: number;
  /** Compact display-only working-directory hint for orchestration rows. */
  cwdLabel?: string;
  /**
   * archive#4054: copied verbatim from the server's watchdog projection.
   * Home intentionally does not compare `lastEventAt` with the current time:
   * the watchdog's progress vocabulary is narrower than canonical activity.
   */
  turnProgress?: OrchestrationSessionSummary['turnProgress'];
  updatedAt: number;
  lifecycleLabel: HomeLifecycleLabel;
  /**
   * archive#1783: the observation behind an `'Unanswerable'` lifecycle
   * label — which arm fired, which process observed it, and when. Set only
   * for an observed negative; a bare label with no basis is the
   * label-vs-derivation defect ADR 0012's negative arm carries `observedBy`/
   * `observedAt` to prevent.
   */
  unanswerableNotice?: string;
  /**
   * The compact explanation behind a Failed or Stopped label. Chat refusals
   * retain their existing server-authored sentence; orchestration sessions
   * carry only the server-derived terminal attribution detail. Raw
   * `blockedReason` remains excluded because it can contain adapter output.
   */
  failureNotice?: string;
  chatSessionId?: string;
  orchestrationThreadId?: string;
  /**
   * Execution lineage folded into this one conversation-owned row. The inbox
   * never renders each member as another chat; detail/open surfaces retain
   * these exact server session ids for provenance.
   */
  orchestrationThreadIds?: readonly string[];
  taskSessionId?: string;
  /**
   * The agent this row is bound to, when one is named.
   *
   * archive#1297 introduced it for `'orchestration'` items
   * (`session.assignedAgentSlug`), so a row-open policy could rehydrate the
   * session into the chat overlay (`useOpenConversation`/`openConversation`)
   * instead of revealing Activity purely because no in-memory chat
   * tab happens to exist for it yet. Its docblock then said "never set on a
   * `'chat'` item", which described that need, not a hazard: a chat item
   * always carries `chatSessionId`, and `resolveWorkItemOpenAction` returns
   * `'focus'` on that field before it ever reads this one.
   *
   * A chat item now sets it too, because Home's rows draw an agent icon and
   * the SLUG is the only fact that resolves one — `agentLabel` is a display
   * string that may be an engine name, a bare slug or `'Agent not
   * reported'`. Carrying the slug is not a second derivation of the label;
   * it is the fact the label was derived from. The open policy is unaffected
   * in both directions, and `work-item-open-policy.test.ts` pins that a chat
   * item carrying an `agentSlug` still resolves to `'focus'`.
   */
  agentSlug?: string;
  /**
   * The project slug backing this row, distinct from `projectLabel` (a
   * display string that also covers the no-project fallback and
   * `sessionProjectLabel`'s ambiguity caveats).
   *
   * archive#1297 threaded it from an `'orchestration'` item into
   * `openConversation` so a rehydrated session keeps its project context. A
   * `'chat'` item now carries its own (`chat.projectSlug`) for the same
   * reason `agentSlug` does: Home's activity chart can only offer a project
   * destination for a row whose items agree on a real slug, and a display
   * label cannot be turned back into one.
   */
  projectSlug?: string;
  /**
   * archive#1297: an `'orchestration'` item's `session.controlMode`. A
   * `'read-only-attached'` session is followed from an external source
   * Station does not own the runtime for — it cannot be rehydrated into the
   * chat overlay, so the row-open policy reveals Activity for it
   * even when `agentSlug` is present.
   */
  controlMode?: SessionControlMode;
  /**
   * archive#1097: set only on a `'remote-session'` item — the connected
   * SSH environment it was read from. Never set on a local item, and a
   * remote item never sets `chatSessionId`/`taskSessionId`/
   * `orchestrationThreadId` either — see `buildRemoteSessionItems`'s
   * docblock for why that keeps remote items structurally unable to alias
   * with a local item under `home-lane-model.ts`'s `withStableIds`.
   */
  environmentId?: string;
  environmentLabel?: string;
}

/** @deprecated Use HomeWorkItem for new Home surfaces. */
export type HomeTaskItem = HomeWorkItem;

export function chatTaskSessionId(task: HomeWorkItem): string {
  return task.chatSessionId ?? task.id;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function latestChatTimestamp(chat: ChatUIState): number {
  // archive#1795: seeded with the chat's own creation time, not a literal
  // 0. A chat with no messages yet (neither array populated) used to bottom
  // out the reduce at 0, sorting it dead last and rendering as epoch-age
  // ("20668d") in "Earlier" — see the `ChatUIState.createdAt` doc comment
  // for why that stamp is a stable creation floor rather than a live
  // `Date.now` read here (which would re-inflate recency on every
  // render, the archive#1311 bug). `createdAt` is optional only for
  // pre-archive#1795 persisted/test fixtures that never carried it; those already
  // have real message timestamps once they have any messages at all, so
  // falling back to 0 there changes nothing.
  const latestMessageTimestamp = [
    ...(chat.messages ?? []),
    ...(chat.ephemeralMessages ?? []),
  ].reduce(
    (latest, message) => Math.max(latest, timestamp(message.timestamp)),
    chat.createdAt ?? 0,
  );
  // archive#1295: an in-flight streaming turn is the most recent activity a
  // chat can have, but `streamingMessage` carries no timestamp of its own
  // (it is replaced wholesale by each delta, not appended to `messages`
  // until finalize) — without this, a chat streaming right now could still
  // sort behind one that merely finished a while ago.
  if (chat.streamingMessage) {
    return Math.max(latestMessageTimestamp, Date.now());
  }
  return latestMessageTimestamp;
}

/**
 * The agent a row is attributed to.
 *
 * When nothing resolves — no cached name, no assigned slug, i.e. exactly the
 * attached/external population — this falls back to the ENGINE's product name
 * from `engineDisplayLabel`, the one place Station turns a provider id
 * into engine vocabulary.
 *
 * archive#3227 A4: this used to reach a PRIVATE second provider table that
 * disagreed with that one on four ids — `muse` read "Muse" against the
 * canonical "Muse Code", and `station-agent`/`bedrock`/`ollama` each read
 * after their own id ("Station Agent", "Bedrock", "Ollama") where the
 * canonical table names all three "Station", because Bedrock and Ollama are
 * Model connections Station's own engine executes through. A Home row
 * therefore said "Bedrock" beside a Station engine icon (`sessionIconAgent`
 * already read the canonical table) while the sessions list said "Station".
 * A fifth disagreement was not in the audit and is the worst of them: the
 * private table Title-Cased any unrecognised id into an invented product name
 * ("unknown-plugin" -> "Unknown Plugin"), where the canonical table returns
 * `null` precisely so callers show the identifier they actually observed
 * rather than dress an unknown adapter up as some engine it might not be.
 * This now matches `sessionIconAgent`'s fallback exactly.
 */
function safeAgentLabel({
  slug,
  name,
  provider,
}: {
  slug?: string;
  name?: string;
  provider?: string;
}): string {
  if (name?.trim()) return name;
  if (slug) {
    const engineId = parseEngineId(slug);
    return (engineId && engineDisplayLabel(engineId)) ?? slug;
  }
  if (!provider) return 'Agent not reported';
  const engineId = parseEngineId(provider);
  return (engineId && engineDisplayLabel(engineId)) ?? provider;
}

/**
 * archive#1097: one connected SSH environment's remote orchestration
 * sessions, as returned by the server's `/api/environments/ssh/sessions`
 * aggregation endpoint (`useRemoteSessionsQuery`, `@kontourai/station-sdk`).
 */
export interface RemoteHomeEnvironmentSessions {
  environmentId: string;
  environmentName: string;
  sessions: OrchestrationSessionSummary[];
}

/**
 * Turns a model id into what a person reads. Supplied by a caller that holds
 * the model catalog (Home does, via `useModelPickerCatalogQuery`); the default
 * has no catalog and therefore prettifies the id rather than inventing a name
 * what it must never do is hand back the bare internal id, which is the
 * defect archive#3391 records.
 */
export type ResolveModelLabel = (modelId: string | null | undefined) => string;

export const defaultResolveModelLabel: ResolveModelLabel = (modelId) =>
  modelIdentityLabel(modelId);

export function buildHomeWorkItems({
  chats,
  sessions,
  tasks = [],
  agents,
  remoteEnvironments = [],
  chatItems: suppliedChatItems,
  currentSessionIdByConversation = new Map<string, string>(),
  resolveModelLabel = defaultResolveModelLabel,
}: {
  chats: Record<string, ChatUIState>;
  sessions: OrchestrationSessionSummary[];
  tasks?: TaskRecord[];
  agents: AgentSummary[];
  /**
   * archive#1097: optional remote-session read augmentation, never a
   * precondition — omitting it (or passing `[]`, its default) returns
   * exactly the local-only result `mergeHomeWorkItems` always produced
   * (the local-first invariant). Callers fetch this independently of
   * `sessions`/`tasks` (see `HomeView.tsx`) so a slow/unreachable remote
   * environment can never delay or gate the local list.
   */
  remoteEnvironments?: RemoteHomeEnvironmentSessions[];
  chatItems?: HomeWorkItem[];
  resolveModelLabel?: ResolveModelLabel;
  currentSessionIdByConversation?: ReadonlyMap<string, string>;
}): HomeWorkItem[] {
  // Sessions carry the server's turn fold; the chat store only carries a
  // coarse process status, so chat items borrow the fold for any session they
  // correlate with (see buildActiveChatTaskItems).
  const chatItems =
    suppliedChatItems ??
    buildActiveChatTaskItems({ chats, agents, sessions, resolveModelLabel });
  const taskItems = tasks.map(buildDurableTaskItem);
  const orchestrationItems = buildOrchestrationItems(
    sessions,
    agents,
    resolveModelLabel,
  );
  const localItems = mergeHomeWorkItems(
    taskItems,
    chatItems,
    orchestrationItems,
    tasks,
    currentSessionIdByConversation,
  );
  if (remoteEnvironments.length === 0) return localItems;
  // Remote items never participate in `mergeHomeWorkItems`'s chat/task/
  // session correlation — they have no local chat or durable Task to
  // correlate with — so they are appended and the combined list is
  // re-sorted by the same recency comparator `mergeHomeWorkItems` already
  // used (a stable, deterministic total order, so this changes nothing
  // about the local-only ordering above).
  const remoteItems = buildRemoteSessionItems(
    remoteEnvironments,
    agents,
    resolveModelLabel,
  );
  return [...localItems, ...remoteItems].sort(compareTaskRecency);
}

function buildSessionWorkItem(
  session: OrchestrationSessionSummary,
  agents: AgentSummary[],
  id: string,
  resolveModelLabel: ResolveModelLabel,
  /** Set only for a remote session — see `HomeWorkItem.environmentId`'s docblock. */
  provenance?: { environmentId: string; environmentLabel: string },
): HomeWorkItem {
  const resolvedAgentLabel = safeAgentLabel({
    slug: session.assignedAgentSlug,
    name: agents.find((agent) => agent.slug === session.assignedAgentSlug)
      ?.name,
    provider: session.provider,
  });
  const cwdLabel = session.cwd
    ?.trim()
    .split(/[/\\]+/)
    .filter(Boolean)
    .slice(-2)
    .join('/');
  const lifecycleLabel = orchestrationLifecycleLabel(session);
  // archive#1783: the serving Station's own observation, read off the
  // summary's required decoration (ADR 0012) and never recomputed here.
  //
  // BOUND TO THE LABEL, both directions. The first version computed this
  // unconditionally, so every normally-finished detached session rendered
  // `✓ Done` with "Unanswerable by the serving Station (the session cannot
  // resume)" underneath it — the review's blocking finding, and the exact
  // shape the field's own docstring warns about. The notice exists to say
  // WHY the row reads `'Unanswerable'`; where it does not, there is nothing
  // to explain. `home-view-model.test.ts` pins the iff in both directions.
  const unanswerableNotice =
    lifecycleLabel === 'Unanswerable'
      ? unanswerableRequestNotice(session.answerability, {
          provider: session.provider,
        })
      : null;
  // `terminalAttribution.detail` is already a bounded first-line projection
  // from the server. Home does not read `blockedReason` or infer a cause from
  // lifecycle/transport state, because either can be raw or misleading.
  const failureNotice =
    lifecycleLabel === 'Failed' || lifecycleLabel === 'Stopped'
      ? session.terminalAttribution?.detail
      : undefined;
  return {
    id,
    ...(session.conversationId
      ? { conversationId: session.conversationId }
      : {}),
    kind: provenance ? 'remote-session' : 'orchestration',
    kindLabel: provenance ? 'Remote session' : 'Session',
    // archive#3227 A2: `sessionTitle` is the one name a session is listed
    // under, and its contract is that no branch may return a raw thread id.
    // Home carried a private copy with a different taskId regex that
    // Title-Cased the result ("Delegated Review" against the canonical
    // "Worker task · delegated review") and fell back to `${agentLabel} task`
    // so one attached Claude session read "Claude Code task" on Home and
    // "Claude Code session" one click away in the list.
    title: sessionTitle(session),
    // archive#3227 A3: `session.projectSlug || 'No project'` DROPPED
    // `delegation.projectSlug` entirely and, worse, rendered the literal
    // "No project" for an AMBIGUOUS session — a claim
    // `packages/contracts/src/orchestration.ts` explicitly forbids, because
    // "no project" and "too many projects" are different facts.
    // `sessionProjectLabel` is the helper every other project-naming surface
    // already reads. `null` (nothing known at all) is the only case that
    // still folds to Home's own copy, which is a display fallback for an
    // absent value rather than a second derivation of it.
    projectLabel: sessionProjectLabel(session) ?? 'No project',
    agentLabel: resolvedAgentLabel,
    // `model` is only the adapter's direct session field. A restored
    // orchestration row can instead carry its durable resolved identity in
    // `effectiveModel`; prefer it so a completed chat does not lose its
    // selected model merely because the local tab was discarded on reload.
    modelLabel: resolveModelLabel(
      session.reportedModel ?? session.effectiveModel ?? session.model,
    ),
    model: session.reportedModel ?? session.effectiveModel ?? session.model,
    ...(cwdLabel ? { cwdLabel: `…/${cwdLabel}` } : {}),
    turnProgress: activeTurnProgress(session),
    updatedAt: Math.max(
      timestamp(session.updatedAt),
      timestamp(session.lastEventAt),
      timestamp(session.createdAt),
    ),
    lifecycleLabel,
    // The basis behind an `'Unanswerable'` chip. Carried on the item rather
    // than recomputed at render so the row and the label come from one read
    // of one decoration.
    ...(unanswerableNotice ? { unanswerableNotice } : {}),
    ...(failureNotice ? { failureNotice } : {}),
    // Deliberately NOT set for a remote item: `orchestrationThreadId` here
    // is the same raw `session.threadId` a LOCAL orchestration item also
    // uses as an identity key (see `home-lane-model.ts`'s
    // `identityKeysFor`). A remote Station's threadId is a UUID from a
    // disjoint keyspace, but structurally guaranteeing "can never collide"
    // means never emitting that raw value as an identity key from a
    // remote item at all — only the already-namespaced `id`
    // (`remote:<environmentId>:<threadId>`, see `buildRemoteSessionItems`)
    // is exposed. A remote item's `agentSlug`/`projectSlug`/`controlMode`
    // are similarly inert — the row-open policy never reaches its
    // rehydrate branch without `orchestrationThreadId` — but are still
    // carried for a local item so it can be rehydrated (archive#1297).
    agentSlug: session.assignedAgentSlug,
    projectSlug: session.projectSlug,
    controlMode: session.controlMode,
    ...(provenance
      ? {
          environmentId: provenance.environmentId,
          environmentLabel: provenance.environmentLabel,
        }
      : { orchestrationThreadId: session.threadId }),
  };
}

/**
 * The one adapter from an orchestration session to a lane-partitionable work
 * item. Exported for the Sessions list (archive#3027 lanes), which groups the
 * SAME sessions by state through `home-lane-model.ts`'s
 * `partitionHomeWorkItems` — a second classifier over the same sessions is
 * exactly how two surfaces come to disagree about whether a session is still
 * running. Home's own lane wiring is unchanged; this is a visibility change,
 * not a behaviour one.
 */
export function buildOrchestrationItems(
  sessions: OrchestrationSessionSummary[],
  agents: AgentSummary[],
  resolveModelLabel: ResolveModelLabel = defaultResolveModelLabel,
): HomeWorkItem[] {
  return sessions.map((session) =>
    buildSessionWorkItem(session, agents, session.threadId, resolveModelLabel),
  );
}

/**
 * archive#1097: every remote item's `id` is namespaced
 * (`remote:<environmentId>:<threadId>`) — distinct from every local id
 * shape (`task:*` durable Tasks aside, a local chat/session id is a bare
 * conversationId/threadId, never `remote:`-prefixed) — so a remote item can
 * never alias a local item's stable identity in
 * `home-lane-model.ts`'s `withStableIds`, and therefore can never inherit
 * or disturb a local row's position in the active lane ( ordering
 * invariant, extended to this new source).
 */
function remoteWorkItemId(environmentId: string, threadId: string): string {
  return `remote:${environmentId}:${threadId}`;
}

function buildRemoteSessionItems(
  remoteEnvironments: readonly RemoteHomeEnvironmentSessions[],
  agents: AgentSummary[],
  resolveModelLabel: ResolveModelLabel,
): HomeWorkItem[] {
  return remoteEnvironments.flatMap(
    ({ environmentId, environmentName, sessions }) =>
      sessions.map((session) =>
        buildSessionWorkItem(
          session,
          agents,
          remoteWorkItemId(environmentId, session.threadId),
          resolveModelLabel,
          { environmentId, environmentLabel: environmentName },
        ),
      ),
  );
}

function mergeHomeWorkItems(
  taskItems: HomeWorkItem[],
  chatItems: HomeWorkItem[],
  orchestrationItems: HomeWorkItem[],
  tasks: TaskRecord[],
  currentSessionIdByConversation: ReadonlyMap<string, string>,
): HomeWorkItem[] {
  const taskIdBySessionId = new Map(
    tasks
      .filter((task) => task.sessionId)
      .map((task) => [task.sessionId!, task.id]),
  );

  const combined = new Map<string, HomeWorkItem>();
  for (const item of taskItems) {
    combined.set(`task:${item.id}`, item);
  }
  // Resolve execution lineage before merging local tab recency. Opening a tab
  // stamps local activity newer than every persisted Session; merging that
  // timestamp into a predecessor first would make it defeat its own child.
  for (const item of [...orchestrationItems, ...chatItems]) {
    if (isPersistedTaskCorrelation(item, taskIdBySessionId)) {
      continue;
    }
    const key = localConversationIdentity(item);
    const existing = combined.get(key);
    if (!existing) {
      combined.set(
        key,
        item.conversationId && item.kind !== 'remote-session'
          ? { ...item, id: key }
          : item,
      );
      continue;
    }
    const chat = latestChatItem(existing, item);
    const orchestration = latestOrchestrationItem(
      existing,
      item,
      currentSessionIdByConversation.get(
        existing.conversationId ?? item.conversationId ?? '',
      ),
    );
    // archive#1297 note: a merged row is based on `chat` (spread
    // below) and does not need the orchestration variant's `controlMode` —
    // a merged row always keeps `chatSessionId` (chat items always carry
    // it), so `resolveWorkItemOpenAction` (`work-item-open-policy.ts`) takes
    // the `'focus'` branch immediately and never reaches the fields that
    // only matter for the `'rehydrate'` branch.
    //
    // `agentSlug`/`projectSlug` were dropped here for that same reason, and
    // that stopped being harmless once Home started DISPLAYING them: the row
    // draws the agent's icon and the activity chart offers the project. The
    // missing agent slug may fall back to the orchestration record, but two
    // populated, different slugs are conflicting identity claims. The row
    // must carry no agent slug in that case: an icon cannot honestly name an
    // executor Station cannot derive. This remains inert for the open policy.
    const newest = item.updatedAt > existing.updatedAt ? item : existing;
    // A local error/actionable queue is still a current user-visible fact,
    // even if the server execution has not caught up. Otherwise the newest
    // execution owns this conversation's status: predecessor sessions must
    // not keep a completed/failed chip after a later handoff child runs.
    const mergedLifecycleLabel =
      chat && isLocalActionableLifecycle(chat)
        ? moreImportantLifecycle(
            chat.lifecycleLabel,
            orchestration?.lifecycleLabel ?? newest.lifecycleLabel,
          )
        : (orchestration?.lifecycleLabel ?? newest.lifecycleLabel);
    // archive#3724: the notice's iff contract must survive the
    // merge. The spread carried the CHAT side's notice regardless of which
    // side's label won — an errored chat under a winning 'Needs attention'
    // kept failure prose beneath a non-Failed chip. Recompute against the
    // winner: present iff the merged label is Failed or Stopped, from
    // whichever side recorded one.
    const mergedFailureNotice =
      mergedLifecycleLabel === 'Failed' || mergedLifecycleLabel === 'Stopped'
        ? (chat?.failureNotice ?? orchestration?.failureNotice)
        : undefined;
    const lineage = mergedExecutionLineage(existing, item);
    const display = orchestration ?? chat ?? newest;
    combined.set(key, {
      ...display,
      id: key,
      // A chat's title is the durable conversation projection. The current
      // execution can supply Agent/model/status without replacing it with a
      // child-session fallback such as "Claude Code session" after handoff.
      title:
        chat?.title && chat.title !== 'New chat' ? chat.title : display.title,
      ...(existing.conversationId || item.conversationId
        ? { conversationId: existing.conversationId ?? item.conversationId }
        : {}),
      kind: chat ? 'chat' : display.kind,
      kindLabel: chat ? 'Direct chat' : display.kindLabel,
      ...(chat ? { chatSessionId: chat.chatSessionId } : {}),
      updatedAt: Math.max(existing.updatedAt, item.updatedAt),
      lifecycleLabel: mergedLifecycleLabel,
      failureNotice: mergedFailureNotice,
      orchestrationThreadId: orchestration?.orchestrationThreadId,
      ...(lineage.length > 0 ? { orchestrationThreadIds: lineage } : {}),
      // A handoff's newest server execution is the only authoritative answer
      // to "who/model/status is this conversation on now?". The local chat
      // copy remains for focus/open continuity, not as a competing executor.
      agentSlug:
        lineage.length > 1
          ? (orchestration?.agentSlug ?? chat?.agentSlug)
          : mergeSingleExecutionAgentSlug(chat, orchestration),
      agentLabel:
        lineage.length > 1
          ? (orchestration?.agentLabel ??
            chat?.agentLabel ??
            display.agentLabel)
          : display.agentLabel,
      model: orchestration?.model ?? chat?.model,
      modelLabel:
        orchestration?.modelLabel ?? chat?.modelLabel ?? display.modelLabel,
      projectSlug: orchestration?.projectSlug ?? chat?.projectSlug,
      projectLabel:
        orchestration?.projectLabel ??
        chat?.projectLabel ??
        display.projectLabel,
      turnProgress: orchestration?.turnProgress,
    });
  }
  return [...combined.values()].sort(compareTaskRecency);
}

/** Local conversations fold by their server-issued identity, never by an
 * execution Session id. Remote rows retain their existing namespace. */
function localConversationIdentity(item: HomeWorkItem): string {
  if (item.kind === 'remote-session') return `remote:${item.id}`;
  return item.conversationId ?? item.id;
}

function latestChatItem(
  left: HomeWorkItem,
  right: HomeWorkItem,
): HomeWorkItem | undefined {
  const chats = [left, right].filter((item) => item.kind === 'chat');
  return chats.reduce<HomeWorkItem | undefined>(
    (latest, item) =>
      !latest || item.updatedAt > latest.updatedAt ? item : latest,
    undefined,
  );
}

type MergeItem = HomeWorkItem & { currentSessionId?: string };

function latestOrchestrationItem(
  left: MergeItem,
  right: MergeItem,
  currentSessionId?: string,
): MergeItem | undefined {
  const sessions = [left, right].filter(
    (item) => item.kind === 'orchestration' || item.orchestrationThreadId,
  );
  return sessions.reduce<MergeItem | undefined>((latest, item) => {
    if (!latest || item.updatedAt > latest.updatedAt) return item;
    if (item.updatedAt < latest.updatedAt) return latest;
    const itemIsCurrent = item.orchestrationThreadId === currentSessionId;
    const latestIsCurrent = latest.orchestrationThreadId === currentSessionId;
    if (itemIsCurrent !== latestIsCurrent) return itemIsCurrent ? item : latest;
    if (
      LIFECYCLE_PRIORITY[item.lifecycleLabel] !==
      LIFECYCLE_PRIORITY[latest.lifecycleLabel]
    ) {
      return LIFECYCLE_PRIORITY[item.lifecycleLabel] >
        LIFECYCLE_PRIORITY[latest.lifecycleLabel]
        ? item
        : latest;
    }
    return (item.orchestrationThreadId ?? item.id) <
      (latest.orchestrationThreadId ?? latest.id)
      ? item
      : latest;
  }, undefined);
}

function mergedExecutionLineage(
  left: HomeWorkItem,
  right: HomeWorkItem,
): string[] {
  return [
    ...new Set(
      [
        ...(left.orchestrationThreadIds ?? []),
        left.orchestrationThreadId,
        ...(right.orchestrationThreadIds ?? []),
        right.orchestrationThreadId,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

function isLocalActionableLifecycle(item: HomeWorkItem): boolean {
  return [
    'Failed',
    'Needs attention',
    // A local send precedes the server's first state event. Preserve that
    // current optimistic turn instead of letting a prior Ready projection
    // hide it.
    'Running',
  ].includes(item.lifecycleLabel);
}

function mergeSingleExecutionAgentSlug(
  chat: HomeWorkItem | undefined,
  orchestration: HomeWorkItem | undefined,
): string | undefined {
  if (!chat) return orchestration?.agentSlug;
  if (!orchestration) return chat.agentSlug;
  if (!chat.agentSlug) return orchestration.agentSlug;
  if (!orchestration.agentSlug) return chat.agentSlug;
  return chat.agentSlug === orchestration.agentSlug
    ? chat.agentSlug
    : undefined;
}

/** @deprecated Use buildHomeWorkItems for new Home surfaces. */
export const buildHomeTaskItems = buildHomeWorkItems;

function isPersistedTaskCorrelation(
  item: HomeWorkItem,
  taskIdBySessionId: Map<string, string>,
): boolean {
  if (item.kind === 'chat') {
    return (
      taskIdBySessionId.has(item.id) ||
      taskIdBySessionId.has(chatTaskSessionId(item))
    );
  }
  return (
    item.kind === 'orchestration' &&
    taskIdBySessionId.has(item.orchestrationThreadId ?? item.id)
  );
}

function buildDurableTaskItem(task: TaskRecord): HomeWorkItem {
  return {
    id: task.id,
    kind: 'task',
    kindLabel: 'Durable Task',
    title: task.title,
    projectLabel: task.projectId || 'Project unavailable',
    agentLabel: task.agentId || 'Agent unavailable',
    modelLabel: 'Model unavailable',
    updatedAt: timestamp(task.updatedAt),
    lifecycleLabel: taskLifecycleLabel(task),
    taskSessionId: task.sessionId,
  };
}

function taskLifecycleLabel(task: TaskRecord): HomeWorkItem['lifecycleLabel'] {
  if (task.status === 'blocked') return 'Needs attention';
  if (task.status === 'in_progress') return 'Running';
  if (task.status === 'done') return 'Completed';
  if (task.status === 'canceled') return 'Stopped';
  return 'Ready';
}

/**
 * Recency comparator used to seed *initial* ordering. Exported for
 * `home-lane-model.ts`, which uses it only to order items that are new to
 * the active lane among themselves — the lane's stable order otherwise never
 * re-sorts by recency (archive#1099).
 */
export function compareTaskRecency(
  left: HomeWorkItem,
  right: HomeWorkItem,
): number {
  return (
    right.updatedAt - left.updatedAt ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * `chat.orchestrationStatus` is written straight from `session.state-changed`,
 * whose `to` is the provider's coarse *process* status — 'running' there means
 * the runtime is attached, not that a turn is in flight (the same conflation
 * archive#1074 fixed on the orchestration-item side). Left ungated it re-introduces a
 * stale "Running" here, and `moreImportantLifecycle` prefers the higher
 * priority when the two items merge, so the chat copy would silently override
 * the orchestration copy's correct "Ready".
 *
 * `chat.status === 'sending'` stays an independent trigger on purpose: it is
 * set by the local send and cleared by the turn finalizer (archive#1005), so it
 * covers the window between the user pressing send and the server's first
 * turn event, which the fold cannot yet know about.
 */
/**
 * The reason behind a chat row's `'Failed'` chip, from the SAME state the
 * label reads (archive#3688). Preference order is specificity: a recorded
 * drain refusal (`queuedMessageFailure.message`, already user-shaped and
 * persisted) over the raw send error, which is better than nothing but may
 * name internals — it is shown as the basis for the chip, not as new copy.
 */
function chatFailureNotice(chat: ChatUIState): string | null {
  return chat.queuedMessageFailure?.message?.trim() || null;
}

/**
 * #765 A2: the per-correlation-key fold of the server session summaries.
 * `hasActiveTurn` keeps its archive#1075 meaning; `failed` carries the
 * server's own `lifecycleState === 'failed'` fold so a turn the server
 * already recorded as failed cannot keep rendering "Active" off local
 * composer state alone. `updatedAt` picks the NEWEST execution child when a
 * durable conversation spans several sessions — the conversation-keyed entry
 * must describe the current child, not the long-completed root session that
 * happens to share the conversation's id.
 */
interface ChatSessionCorrelation {
  hasActiveTurn: boolean;
  failed: boolean;
  updatedAt: string;
}

function chatLifecycleLabel(
  chat: ChatUIState,
  sessionId: string,
  turnByThread: Map<string, ChatSessionCorrelation>,
): HomeWorkItem['lifecycleLabel'] {
  // Mirrors mergeHomeWorkItems' own key (`chat.conversationId || id`) exactly:
  // the store key is a fallback for a MISSING conversationId, never a second
  // guess when a present one simply doesn't correlate. Retrying the store key
  // there could borrow an unrelated session's fold for a chat the merge would
  // never pair with it (archive#1075).
  const correlationKey = chat.conversationId || sessionId;
  const correlated = turnByThread.get(correlationKey);
  if (chat.status === 'error' || chat.orchestrationStatus === 'failed') {
    return 'Failed';
  }
  if (
    chat.pendingApprovals?.length ||
    // archive#1224 (offline): a queued (offline) turn needs an
    // actionable label — it won't resolve on its own without the connection
    // coming back.
    chat.status === 'queued' ||
    chat.orchestrationStatus === 'awaiting-approval'
  )
    return 'Needs attention';
  if (chat.status === 'sending') return 'Running';
  // #765 A2: the server recorded this conversation's current session as
  // failed and no newer local activity (send/approval above) supersedes it.
  // Before this branch a chat whose client store missed the `runtime.error`
  // (dropped SSE, other device, reload) stayed on the local-state fallbacks
  // below and read "Active" while the server said failed.
  if (correlated?.failed) return 'Failed';
  if (chat.orchestrationStatus !== 'running') return 'Recent';
  // No correlated session means no better signal than the chat store itself —
  // notably chats on non-orchestration send paths, which never have one.
  if (!correlated) return 'Running';
  return correlated.hasActiveTurn ? 'Running' : 'Recent';
}

export function buildActiveChatTaskItems({
  chats,
  agents,
  sessions = [],
  resolveModelLabel = defaultResolveModelLabel,
}: {
  chats: Record<string, ChatUIState>;
  agents: AgentSummary[];
  /**
   * Optional: when a chat correlates with an orchestration session, that
   * session's `hasActiveTurn` fold decides whether the chat is "Running".
   * Callers without session data (the project sidebar) keep the previous
   * chat-only behaviour.
   */
  sessions?: OrchestrationSessionSummary[];
  resolveModelLabel?: ResolveModelLabel;
}): HomeWorkItem[] {
  const turnByThread = new Map<string, ChatSessionCorrelation>();
  for (const session of sessions) {
    const entry: ChatSessionCorrelation = {
      hasActiveTurn: session.hasActiveTurn === true,
      failed: session.lifecycleState === 'failed',
      updatedAt: session.updatedAt,
    };
    turnByThread.set(session.threadId, entry);
    // #765 A2: a durable conversation's chats correlate by conversationId,
    // but the summary whose threadId EQUALS the conversation id is the root
    // execution session — long stopped once continuation children exist.
    // Key the conversation to its newest child so the chip reflects the
    // session actually running (or actually failed) now.
    if (session.conversationId) {
      const current = turnByThread.get(session.conversationId);
      if (!current || session.updatedAt.localeCompare(current.updatedAt) >= 0) {
        turnByThread.set(session.conversationId, entry);
      }
    }
  }
  const items = Object.entries(chats).map<MergeItem>(([id, chat]) => {
    const agentLabel = safeAgentLabel({
      slug: chat.agentSlug,
      name:
        chat.agentName ||
        agents.find((agent) => agent.slug === chat.agentSlug)?.name,
    });
    return {
      id: chat.conversationId || id,
      ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
      kind: 'chat' as const,
      kindLabel: 'Direct chat' as const,
      // Match the dock session-title convention (useDerivedSessions):
      // untitled chats read "<Agent> Chat", not the bare agent name —
      // title is not persisted across reloads, so this fallback is the
      // steady-state name for rehydrated sessions.
      title: chat.title?.trim() || (agentLabel ? `${agentLabel} Chat` : 'Task'),
      projectLabel: chat.projectName || chat.projectSlug || 'No project',
      agentLabel,
      modelLabel: resolveModelLabel(chat.orchestrationModel || chat.model),
      // archive#3391: the id itself, not only its label — the label is a
      // derivation of this, and a consumer that needs the model (reopen)
      // must not have to parse a display string back into one.
      model: chat.orchestrationModel || chat.model,
      updatedAt: latestChatTimestamp(chat),
      lifecycleLabel: chatLifecycleLabel(chat, id, turnByThread),
      // Bound to the label in both directions, like unanswerableNotice: a
      // notice may exist only under a 'Failed' chip, and a 'Failed' chip
      // shows its reason whenever one was recorded.
      ...(chatLifecycleLabel(chat, id, turnByThread) === 'Failed' &&
      chatFailureNotice(chat)
        ? { failureNotice: chatFailureNotice(chat) as string }
        : {}),
      chatSessionId: id,
      ...(chat.currentSessionId
        ? { currentSessionId: chat.currentSessionId }
        : {}),
      // Identity facts, not display ones — see the field docblocks. Both
      // are inert for the open policy (`chatSessionId` above short-circuits
      // it) and are read by Home's row icon and its activity chart.
      ...(chat.agentSlug ? { agentSlug: chat.agentSlug } : {}),
      ...(chat.projectSlug ? { projectSlug: chat.projectSlug } : {}),
    };
  });
  // A handoff replaces the execution Session while retaining one durable
  // Conversation. Every consumer of this adapter must therefore see the
  // newest child identity, never an arbitrary predecessor map entry.
  return [
    ...items
      .reduce((current, item) => {
        const key = item.conversationId ?? item.id;
        const prior = current.get(key);
        const itemIsCurrentChild = item.currentSessionId === item.chatSessionId;
        const priorIsCurrentChild =
          prior?.currentSessionId === prior?.chatSessionId;
        if (
          !prior ||
          item.updatedAt > prior.updatedAt ||
          (item.updatedAt === prior.updatedAt &&
            (itemIsCurrentChild !== priorIsCurrentChild
              ? itemIsCurrentChild
              : LIFECYCLE_PRIORITY[item.lifecycleLabel] >
                  LIFECYCLE_PRIORITY[prior.lifecycleLabel] ||
                (LIFECYCLE_PRIORITY[item.lifecycleLabel] ===
                  LIFECYCLE_PRIORITY[prior.lifecycleLabel] &&
                  (item.chatSessionId ?? item.id) <
                    (prior.chatSessionId ?? prior.id))))
        ) {
          current.set(key, item);
        }
        return current;
      }, new Map<string, MergeItem>())
      .values(),
  ]
    .map(({ currentSessionId: _currentSessionId, ...item }) => item)
    .sort(compareTaskRecency);
}
