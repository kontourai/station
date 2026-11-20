import {
  type ChildWorkItem,
  type ChildWorkKind,
  type ChildWorkRegistryState,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { BackgroundTaskEntry } from '../../contexts/background-tasks-store';
import { parseEpochMs } from '../../utils/parseEpochMs';

/**
 * #2459: the Agents pane's read of child work — Station delegates from the
 * session read model (`childWork.asChild`) and engine subagents from the
 * window's global registry — shaped for one row component, for one chat or
 * for every conversation.
 *
 * Pure: every lookup the pane owns (sessions, chat resolution, the tool card
 * a legacy subagent was spawned from) is passed in, so the rules below are
 * testable without a store. The rules are all about NOT inventing: a time
 * nobody reported renders absent, a parent edge nobody reported is not drawn,
 * and a control renders only from a wired seam.
 */

/** Global scope's own bound on the finished list (decision E). */
export const GLOBAL_FINISHED_LIMIT = 50;

export type ChildWorkScope = 'chat' | 'all';

/** Where a child came from, as the facts on hand say — never guessed. */
export type ChildWorkProvenance =
  /** Run under (or delegated from) a known session. */
  | { kind: 'conversation'; threadId: string; title?: string }
  /** Delegated from a parent task this Station has no session for. */
  | { kind: 'task'; taskId: string }
  /** A root delegate whose own turn was started from the CLI. */
  | { kind: 'cli' }
  /** A root delegate with no parent and no reported CLI origin. */
  | { kind: 'none' };

export type ChildWorkStopControl = 'delegate-interrupt' | 'provider-task-stop';

export interface ChildWorkRowModel {
  key: string;
  item: ChildWorkItem;
  title: string;
  provider?: string;
  /** Epoch ms, only when reported (or taken from the spawning tool card). */
  startedAtMs?: number;
  endedAtMs?: number;
  stop?: ChildWorkStopControl;
  /**
   * #2486: the engine's matrix says `stop` also ends the reporting session's
   * own active turn (no softer path exists) — a control offered this way
   * must say so, rather than a copy hardcoded the same for every engine.
   * Absent/false when `stop` is scoped exactly to the child (or when there
   * is no stop to offer at all).
   */
  stopEndsParentTurn?: boolean;
  provenance: ChildWorkProvenance;
  /** Indentation: reported nesting only. */
  level: number;
}

export interface ChildWorkListView {
  running: ChildWorkRowModel[];
  finished: ChildWorkRowModel[];
  /** Finished rows the scope's bound left out. */
  finishedOmitted: number;
}

/** The session read model's fields these selectors read. */
export interface ChildWorkSessionSource {
  threadId: string;
  provider?: string;
  conversationId?: string;
  displayTitle?: string;
  turnOrigin?: { latest: { reported: { surface: string } } };
  childWork?: { asChild?: ChildWorkItem };
}

export interface ChildWorkSelectorInput {
  sessions: readonly ChildWorkSessionSource[];
  /** The global engine-subagent registry. */
  engine: ChildWorkRegistryState;
  /** childWorkKey → when this window observed the settle (ordering only). */
  settledObservedAt?: Readonly<Record<string, number>>;
  /** A session thread → the open chat it belongs to, when one does. */
  chatKeyFor: (threadId: string) => string | undefined;
  /** The open chat's facts, for a reporter with no session row. */
  chatFacts?: (chatKey: string) => {
    provider?: string;
    title?: string;
    /** The project's display name, as the open chat records it. */
    project?: string;
    /** The id navigation opens this chat by (its conversation, else its key). */
    durableId?: string;
  };
  /**
   * A reporting session → the chat the background-tasks store bound it to
   * (`providerReporters`). The binding outlives the chat while its children
   * run, so a closed chat's subagents still group with its tool cards.
   */
  reporterChatOf?: (threadId: string) => string | undefined;
  /**
   * A delegate thread → the thread its bind event named as parent (the
   * background-tasks store's `delegateParents`), for per-chat nesting.
   */
  delegateParentOf?: (threadId: string) => string | undefined;
  /** A tool call's start (ms), for a legacy subagent with no `startedAt`. */
  toolCallStartedAt?: (toolCallId: string) => number | undefined;
}

function itemKey(item: ChildWorkItem): string {
  return JSON.stringify([item.producer, item.reporterThreadId, item.childId]);
}

function sessionIndex(sessions: readonly ChildWorkSessionSource[]) {
  return new Map(sessions.map((session) => [session.threadId, session]));
}

/** What chat membership reads: session rows and the open-chat lookup. */
export type ChatMembershipInput = Pick<
  ChildWorkSelectorInput,
  'sessions' | 'chatKeyFor'
>;

/**
 * The chat a session belongs to: its own id, else its durable conversation's
 * (a conversation's older execution child still resolves to its chat).
 */
function resolveChat(
  threadId: string,
  input: ChatMembershipInput,
  sessions: Map<string, ChildWorkSessionSource>,
): string | undefined {
  const direct = input.chatKeyFor(threadId);
  if (direct) return direct;
  const conversationId = sessions.get(threadId)?.conversationId;
  return conversationId ? input.chatKeyFor(conversationId) : undefined;
}

/** The engine a session runs on, from its row or its open chat. */
function providerIn(
  threadId: string,
  input: ChildWorkSelectorInput,
  sessions: Map<string, ChildWorkSessionSource>,
): string | undefined {
  const fromRow = sessions.get(threadId)?.provider;
  if (fromRow) return fromRow;
  const chatKey = resolveChat(threadId, input, sessions);
  return chatKey ? input.chatFacts?.(chatKey).provider : undefined;
}

function engineMatrix(provider: string | undefined) {
  return provider && Object.hasOwn(ENGINE_CAPABILITY_MATRICES, provider)
    ? ENGINE_CAPABILITY_MATRICES[provider]
    : undefined;
}

/**
 * Whether the engine's matrix cell wires a DIRECT per-task stop. A
 * `model-tool` stop is something only the model can invoke, so it is never a
 * button; an unknown engine wires nothing.
 */
function engineStopIsWired(provider: string | undefined): boolean {
  const cell = engineMatrix(provider)?.subagentControl;
  if (cell?.state !== 'wired') return false;
  const stop = cell.stop;
  return (
    stop.state === 'available' &&
    stop.invocation === 'client-request' &&
    stop.scope === 'per-task'
  );
}

/** Whether the engine's matrix says it reports nothing about subagents. */
function engineReportsNoSubagents(provider: string | undefined): boolean {
  return engineMatrix(provider)?.subagentObservability.state === 'none';
}

/** The matrix's reason when only some of this engine's connections report. */
function engineReportsPerConnection(
  provider: string | undefined,
): string | undefined {
  const cell = engineMatrix(provider)?.subagentObservability;
  return cell?.state === 'declared'
    ? cell.perConnection?.unobservedReason
    : undefined;
}

/**
 * #2486: whether the engine's own wired stop cell says the action also ends
 * the reporting session's own active turn (Codex: no softer path exists). A
 * per-engine declared fact, not a copy hardcoded the same for every engine —
 * an engine whose stop stays task-scoped (or is not wired at all) is false.
 */
function engineStopEndsParentTurn(provider: string | undefined): boolean {
  const cell = engineMatrix(provider)?.subagentControl;
  return (
    cell?.state === 'wired' &&
    cell.stop.state === 'available' &&
    cell.stop.endsParentTurn === true
  );
}

/**
 * The stop a row may render. Resume has no seam anywhere, so it is never
 * offered. A delegate's stop is a Station task API; an engine subagent's
 * needs BOTH the engine's wired cell and the child's own stop seam.
 */
export function controlsFor(
  item: ChildWorkItem,
  provider: string | undefined,
): ChildWorkStopControl | undefined {
  if (item.status !== 'running') return undefined;
  if (item.producer === 'station-delegate')
    return item.controls?.stop === 'delegate-interrupt'
      ? 'delegate-interrupt'
      : undefined;
  if (!engineStopIsWired(provider)) return undefined;
  return item.controls?.stop === 'provider-task-stop'
    ? 'provider-task-stop'
    : undefined;
}

/** A delegate's or subagent's provenance, from facts on hand only. */
export function provenanceFor(
  item: ChildWorkItem,
  input: ChildWorkSelectorInput,
): ChildWorkProvenance {
  return provenanceIn(item, input, sessionIndex(input.sessions));
}

function provenanceIn(
  item: ChildWorkItem,
  input: ChildWorkSelectorInput,
  sessions: Map<string, ChildWorkSessionSource>,
): ChildWorkProvenance {
  const conversation = (threadId: string): ChildWorkProvenance => {
    const row = sessions.get(threadId);
    const chatKey = resolveChat(threadId, input, sessions);
    const title =
      row?.displayTitle ??
      (chatKey ? input.chatFacts?.(chatKey).title : undefined);
    return { kind: 'conversation', threadId, ...(title ? { title } : {}) };
  };
  if (item.producer === 'engine-subagent')
    return conversation(item.reporterThreadId);
  const parentTaskId = item.parent?.taskId;
  if (parentTaskId) {
    if (
      sessions.has(parentTaskId) ||
      resolveChat(parentTaskId, input, sessions)
    )
      return conversation(parentTaskId);
    return { kind: 'task', taskId: parentTaskId };
  }
  const surface = sessions.get(item.reporterThreadId)?.turnOrigin?.latest
    .reported.surface;
  return surface === 'cli' ? { kind: 'cli' } : { kind: 'none' };
}

function titleFor(
  item: ChildWorkItem,
  sessions: Map<string, ChildWorkSessionSource>,
): string {
  if (item.title) return item.title;
  if (item.producer === 'station-delegate') {
    const displayTitle = sessions.get(item.childId)?.displayTitle;
    if (displayTitle) return displayTitle;
    return item.kindLabel
      ? `Delegated task — ${item.kindLabel}`
      : 'Delegated task';
  }
  return item.kindLabel ?? 'Subagent';
}

interface Candidate {
  row: ChildWorkRowModel;
  /** The row this one nests under, by a REPORTED edge. */
  parentKey?: string;
  sortTime?: number;
}

function delegateKey(threadId: string): string {
  return itemKey({
    producer: 'station-delegate',
    reporterThreadId: threadId,
    childId: threadId,
    status: 'running',
  });
}

function buildCandidates(input: ChildWorkSelectorInput): Candidate[] {
  const sessions = sessionIndex(input.sessions);
  const candidates: Candidate[] = [];
  const delegateThreads = new Set<string>();
  for (const session of input.sessions) {
    const asChild = session.childWork?.asChild;
    if (asChild?.producer === 'station-delegate')
      delegateThreads.add(asChild.childId);
  }
  const push = (item: ChildWorkItem, parentKey: string | undefined) => {
    const key = itemKey(item);
    const provider = providerIn(item.reporterThreadId, input, sessions);
    const stop = controlsFor(item, provider);
    // The contract carries depth only for a nesting the producer reported:
    // 1 is top level, N+1 is inside a depth-N child. Absent is not 1.
    const reportedDepth =
      item.producer === 'engine-subagent' && item.depth ? item.depth - 1 : 0;
    const startedAtMs =
      parseEpochMs(item.startedAt) ??
      (item.parent?.toolCallId
        ? input.toolCallStartedAt?.(item.parent.toolCallId)
        : undefined);
    const endedAtMs = parseEpochMs(item.endedAt);
    const stopEndsParentTurn =
      stop === 'provider-task-stop'
        ? engineStopEndsParentTurn(provider)
        : false;
    candidates.push({
      row: {
        key,
        item,
        title: titleFor(item, sessions),
        ...(provider ? { provider } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(endedAtMs !== undefined ? { endedAtMs } : {}),
        ...(stop ? { stop } : {}),
        ...(stopEndsParentTurn ? { stopEndsParentTurn } : {}),
        provenance: provenanceIn(item, input, sessions),
        level: reportedDepth,
      },
      ...(parentKey ? { parentKey } : {}),
      sortTime:
        item.status === 'running'
          ? startedAtMs
          : (endedAtMs ?? input.settledObservedAt?.[key] ?? startedAtMs),
    });
  };
  for (const session of input.sessions) {
    const asChild = session.childWork?.asChild;
    if (asChild?.producer !== 'station-delegate') continue;
    const parentTaskId = asChild.parent?.taskId;
    // A delegate of a delegate: the parent task IS that delegate's thread.
    push(
      asChild,
      parentTaskId && delegateThreads.has(parentTaskId)
        ? delegateKey(parentTaskId)
        : undefined,
    );
  }
  for (const item of Object.values(input.engine.items)) {
    if (item.producer !== 'engine-subagent') continue;
    // A subagent reported by a delegate's own session nests under that
    // delegate: the reporter IS the delegate. Nothing else is an edge.
    push(
      item,
      delegateThreads.has(item.reporterThreadId)
        ? delegateKey(item.reporterThreadId)
        : undefined,
    );
  }
  return candidates;
}

/** Orders a section as a tree: roots by time, each followed by its nest. */
function treeOrder(
  section: Candidate[],
  ascending: boolean,
): ChildWorkRowModel[] {
  const inSection = new Set(section.map((candidate) => candidate.row.key));
  const byParent = new Map<string, Candidate[]>();
  const roots: Candidate[] = [];
  for (const candidate of section) {
    if (candidate.parentKey && inSection.has(candidate.parentKey)) {
      const siblings = byParent.get(candidate.parentKey) ?? [];
      siblings.push(candidate);
      byParent.set(candidate.parentKey, siblings);
    } else roots.push(candidate);
  }
  const compare = (a: Candidate, b: Candidate) => {
    // Unknown times sort last either way rather than posing as "now".
    if (a.sortTime === undefined) return b.sortTime === undefined ? 0 : 1;
    if (b.sortTime === undefined) return -1;
    return ascending ? a.sortTime - b.sortTime : b.sortTime - a.sortTime;
  };
  const out: ChildWorkRowModel[] = [];
  const visit = (candidate: Candidate, baseLevel: number) => {
    out.push({ ...candidate.row, level: baseLevel + candidate.row.level });
    const nested = (byParent.get(candidate.row.key) ?? []).sort(compare);
    for (const child of nested)
      visit(child, baseLevel + candidate.row.level + 1);
  };
  for (const root of roots.sort(compare)) visit(root, 0);
  return out;
}

function toView(
  candidates: Candidate[],
  finishedLimit: number | undefined,
): ChildWorkListView {
  const running = candidates.filter(
    (candidate) => candidate.row.item.status === 'running',
  );
  const settled = candidates.filter(
    (candidate) => candidate.row.item.status !== 'running',
  );
  let finished = treeOrder(settled, false);
  let finishedOmitted = 0;
  if (finishedLimit !== undefined && finished.length > finishedLimit) {
    // Only delegates are trimmed. The session read model lists every
    // delegate ever run; engine subagents come from the registry, which is
    // already bounded. Trimming them here could hide a subagent that its
    // own chat still lists, and All must list everything a chat does.
    let excess = finished.length - finishedLimit;
    const kept: ChildWorkRowModel[] = [];
    for (let index = finished.length - 1; index >= 0; index -= 1) {
      const row = finished[index] as ChildWorkRowModel;
      if (excess > 0 && row.item.producer === 'station-delegate') {
        excess -= 1;
        finishedOmitted += 1;
      } else kept.push(row);
    }
    finished = kept.reverse();
  }
  return {
    running: treeOrder(running, true),
    finished,
    finishedOmitted,
  };
}

/** Every conversation's child work, running and recent (bounded). */
export function selectGlobalChildWork(
  input: ChildWorkSelectorInput,
): ChildWorkListView {
  return toView(buildCandidates(input), GLOBAL_FINISHED_LIMIT);
}

/**
 * The open chat a session thread names, or undefined — declining when more
 * than one chat would match rather than picking the first. The store's own
 * lookup takes the first chat whose current session or conversation id
 * matches; two open chats can carry one conversation id (an outbound-queue
 * projection creates a chat under its queue group's key with the
 * conversation id it recorded), and the first-match rule would then put one
 * chat's children and notices in the other.
 */
export function uniqueChatKey(
  chats: Readonly<
    Record<string, { currentSessionId?: string; conversationId?: string }>
  >,
  threadId: string,
): string | undefined {
  if (chats[threadId]) return threadId;
  const one = (matches: string[]) =>
    matches.length === 1 ? matches[0] : undefined;
  const byCurrent = Object.keys(chats).filter(
    (key) => chats[key]?.currentSessionId === threadId,
  );
  if (byCurrent.length > 0) return one(byCurrent);
  return one(
    Object.keys(chats).filter((key) => chats[key]?.conversationId === threadId),
  );
}

/**
 * The ONE rule for "this session thread belongs to this chat", shared by the
 * chat's child list and its subagent notice so the two cannot disagree: the
 * key itself (a thread with no chat still reads its own work, as
 * `useChatStoreKey` falls through), the chat the thread resolves to, or —
 * for a conversation's continuation session — the chat its durable
 * conversation resolves to.
 */
export function threadInChat(
  input: ChatMembershipInput,
  chatKey: string,
): (threadId: string | undefined) => boolean {
  const sessions = sessionIndex(input.sessions);
  return (threadId) =>
    threadId !== undefined &&
    (threadId === chatKey ||
      resolveChat(threadId, input, sessions) === chatKey);
}

/**
 * One chat's ENGINE subagents: those its own sessions reported, and those
 * reported by a delegate this chat launched (the delegate's bind event names
 * the chat as its parent — a reported edge). The chat's delegates themselves
 * are not here: per chat they render from the background-tasks store, live
 * and bounded exactly as the badge and the sheet read them.
 */
export function selectChatChildWork(
  input: ChildWorkSelectorInput,
  chatKey: string,
): ChildWorkListView {
  const inChat = threadInChat(input, chatKey);
  return toView(
    buildCandidates(input).filter((candidate) => {
      const item = candidate.row.item;
      if (item.producer !== 'engine-subagent') return false;
      return (
        inChat(item.reporterThreadId) ||
        inChat(input.delegateParentOf?.(item.reporterThreadId))
      );
    }),
    undefined,
  );
}

export interface ChildWorkEmptyState {
  label: string;
  description?: string;
}

/** What a chat's server said about its reporters' children. */
export type ChildWorkReporterObservability =
  | { kind: 'reported' }
  | { kind: 'not-reported'; reason: string };

/**
 * Whether to tell the reader this chat's subagents cannot appear, and in
 * whose words. The server's own view outranks the matrix: a reporter the
 * server says reports children is never called silent, and a server refusal
 * is shown with the server's reason rather than a sentence that might
 * contradict it ("does not report" when the truth is "Station does not map
 * them yet"). The matrix speaks only when the server has said nothing.
 */
export function subagentNoticeFor(options: {
  provider: string | undefined;
  observed: readonly ChildWorkReporterObservability[];
}): ChildWorkEmptyState | undefined {
  if (options.observed.some((entry) => entry.kind === 'reported'))
    return undefined;
  const refusal = options.observed.find(
    (entry): entry is { kind: 'not-reported'; reason: string } =>
      entry.kind === 'not-reported',
  );
  if (refusal)
    return {
      label: 'Subagents are not shown for this engine',
      description: refusal.reason,
    };
  if (engineReportsNoSubagents(options.provider))
    return {
      label: 'This engine does not report subagents',
      description:
        'Delegated tasks and tool calls from this chat still appear here.',
    };
  // Only some connections of this engine report (ACP): with nothing from
  // the server yet, "No subagents running" would be a claim nothing made.
  const unobserved = engineReportsPerConnection(options.provider);
  if (unobserved)
    return {
      label: 'Subagents are not shown for this engine',
      description: unobserved,
    };
  return undefined;
}

/**
 * Two empties that must not read alike: an engine whose subagents cannot
 * appear is not an engine reporting that none are running.
 */
export function emptyStateFor(options: {
  scope: ChildWorkScope;
  hasChat: boolean;
  subagentNotice?: ChildWorkEmptyState;
}): ChildWorkEmptyState {
  if (options.scope === 'all')
    return {
      label: 'No agent work yet',
      description:
        'Delegated tasks, subagents and tool calls from every chat appear here, including CLI work.',
    };
  if (!options.hasChat)
    return {
      label: 'Nothing here yet',
      description: 'Open a chat to see the work it set running.',
    };
  return options.subagentNotice ?? { label: 'No subagents running' };
}

/** One row in "All chats": a child-work row or a background-tasks card. */
export type AllChatsRow =
  | { kind: 'child'; row: ChildWorkRowModel }
  | {
      kind: 'task';
      entry: BackgroundTaskEntry;
      /**
       * The child-work kind a provider-task card stands for (the per-chat
       * Stop bridge), so it is counted as what it is, not as its card.
       */
      workKind?: ChildWorkKind;
    };

/** The work one chat set running, as "All chats" groups it. */
export interface AllChatsGroup {
  /**
   * The chat's store key when it is open; else the chat its reporting
   * session was bound to, else the conversation or session it resolves to.
   * Every row reaches this through one resolver, so a chat is one group.
   */
  key: string;
  /** No chat: delegates started from the CLI or a task with no session here. */
  outsideChat: boolean;
  current: boolean;
  title?: string;
  /** The project's display name, only when the open chat records one. */
  project?: string;
  /** What opens this chat: its durable id, else the conversation or session. */
  openThreadId?: string;
  running: AllChatsRow[];
  finished: AllChatsRow[];
}

export interface AllChatsView {
  groups: AllChatsGroup[];
  finishedOmitted: number;
}

const OUTSIDE_CHAT_GROUP = '\u0000outside-chat';
/** Delegates of delegates are followed this far up to their chat. */
const DELEGATE_CLIMB_LIMIT = 8;

/**
 * Whether a background-tasks card is listed beside child work: a tool call
 * that did not spawn a listed child, or a delegated task the session read
 * model does not already list. The per-chat pane applies the same rule.
 */
export function isListedTaskCard(
  entry: BackgroundTaskEntry,
  spawningToolCalls: ReadonlySet<string>,
  listedDelegates: ReadonlySet<string> = new Set(),
): boolean {
  if (entry.source === 'tool-event') return !spawningToolCalls.has(entry.id);
  if (entry.source === 'delegate-session')
    return !listedDelegates.has(entry.delegateThreadId ?? entry.id);
  return false;
}

/**
 * Every chat's work for "All chats", grouped by chat: the global child-work
 * view plus every chat's tool-call and delegated-task cards, so All lists
 * at least what each chat's own scope lists. The current chat's group leads,
 * then chats with running work, then the most recently active.
 *
 * A chat's title comes from the open chat, else from its session row. Its
 * project is the open chat's display name only: a session row carries a
 * slug (and a delegation's slug may be an unverified cross-machine match),
 * so a closed chat shows no project rather than a slug beside names.
 */
export function selectAllChatsWork(
  input: ChildWorkSelectorInput,
  view: ChildWorkListView,
  taskEntries: readonly BackgroundTaskEntry[],
  currentChatKey: string | undefined,
): AllChatsView {
  const sessions = sessionIndex(input.sessions);
  const delegateParent = (threadId: string): string | undefined => {
    const asChild = sessions.get(threadId)?.childWork?.asChild;
    const fromSession =
      asChild?.producer === 'station-delegate'
        ? asChild.parent?.taskId
        : undefined;
    return input.delegateParentOf?.(threadId) ?? fromSession;
  };
  // A delegate's work belongs to the chat that delegated it.
  const anchorOf = (threadId: string | undefined) => {
    let current = threadId;
    for (let step = 0; current && step < DELEGATE_CLIMB_LIMIT; step += 1) {
      const parent = delegateParent(current);
      if (!parent || parent === current) break;
      current = parent;
    }
    return current;
  };

  /** The ONE rule from a row's anchor thread to its chat's group key. */
  const chatGroupKey = (anchor: string) => {
    const target = input.reporterChatOf?.(anchor) ?? anchor;
    const chatKey = resolveChat(target, input, sessions);
    const session = sessions.get(target);
    return {
      key: chatKey ?? session?.conversationId ?? target,
      chatKey,
      session,
    };
  };

  type Group = AllChatsGroup & { latest: number };
  const groups = new Map<string, Group>();
  const groupFor = (anchor: string | undefined): Group => {
    if (!anchor) {
      const existing = groups.get(OUTSIDE_CHAT_GROUP);
      if (existing) return existing;
      const created: Group = {
        key: OUTSIDE_CHAT_GROUP,
        outsideChat: true,
        current: false,
        running: [],
        finished: [],
        latest: Number.NEGATIVE_INFINITY,
      };
      groups.set(OUTSIDE_CHAT_GROUP, created);
      return created;
    }
    const { key, chatKey, session } = chatGroupKey(anchor);
    const facts = chatKey ? input.chatFacts?.(chatKey) : undefined;
    const conversation = session?.conversationId
      ? sessions.get(session.conversationId)
      : undefined;
    const title =
      facts?.title ?? session?.displayTitle ?? conversation?.displayTitle;
    const project = facts?.project;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        outsideChat: false,
        current: currentChatKey !== undefined && key === currentChatKey,
        openThreadId: chatKey ? (facts?.durableId ?? chatKey) : key,
        running: [],
        finished: [],
        latest: Number.NEGATIVE_INFINITY,
      };
      groups.set(key, group);
    }
    if (!group.title && title) group.title = title;
    if (!group.project && project) group.project = project;
    return group;
  };
  const touch = (group: { latest: number }, time: number | undefined) => {
    if (time !== undefined && time > group.latest) group.latest = time;
  };

  const childAnchor = (row: ChildWorkRowModel) =>
    row.item.producer === 'station-delegate'
      ? anchorOf(row.item.parent?.taskId ?? delegateParent(row.item.childId))
      : anchorOf(row.item.reporterThreadId);

  const listedDelegates = new Set(
    [...view.running, ...view.finished]
      .filter((row) => row.item.producer === 'station-delegate')
      .map((row) => row.item.childId),
  );
  const spawningToolCalls = new Set<string>();
  for (const row of [...view.running, ...view.finished])
    if (row.item.parent?.toolCallId)
      spawningToolCalls.add(row.item.parent.toolCallId);
  for (const item of Object.values(input.engine.items))
    if (item.parent?.toolCallId) spawningToolCalls.add(item.parent.toolCallId);
  const cards = taskEntries.filter((entry) =>
    isListedTaskCard(entry, spawningToolCalls, listedDelegates),
  );

  // Section order within a group mirrors the per-chat pane: running cards
  // before running children, finished children before finished cards.
  const runningCards = cards
    .filter((entry) => entry.state === 'running')
    .sort(
      (a, b) =>
        (a.startedAt ?? Number.POSITIVE_INFINITY) -
        (b.startedAt ?? Number.POSITIVE_INFINITY),
    );
  for (const entry of runningCards) {
    const group = groupFor(anchorOf(entry.chatThreadId));
    group.running.push({ kind: 'task', entry });
    touch(group, entry.startedAt);
  }
  for (const row of view.running) {
    const group = groupFor(childAnchor(row));
    group.running.push({ kind: 'child', row });
    touch(group, row.startedAtMs);
  }
  for (const row of view.finished) {
    const group = groupFor(childAnchor(row));
    group.finished.push({ kind: 'child', row });
    touch(group, row.endedAtMs ?? row.startedAtMs);
  }
  const finishedCards = cards
    .filter((entry) => entry.state !== 'running')
    .sort(
      (a, b) =>
        (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0),
    );
  for (const entry of finishedCards) {
    const group = groupFor(anchorOf(entry.chatThreadId));
    group.finished.push({ kind: 'task', entry });
    touch(group, entry.endedAt ?? entry.startedAt);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.outsideChat !== b.outsideChat) return a.outsideChat ? 1 : -1;
    const aRunning = a.running.length > 0;
    if (aRunning !== b.running.length > 0) return aRunning ? -1 : 1;
    return b.latest - a.latest;
  });
  return {
    groups: ordered.map(({ latest: _latest, ...group }) => group),
    finishedOmitted: view.finishedOmitted,
  };
}

/**
 * What a list of rows holds, by kind, for a section or group heading. One
 * noun per thing, whatever list it came from:
 * - agents: engine subagents and delegated tasks;
 * - commands: background shell commands a turn left running (Claude's
 *   backgrounded Bash, `workKind: 'command'`);
 * - monitors: background monitors (`workKind: 'monitor'`);
 * - tools: tool calls in a turn, Bash included. A Bash call that leaves a
 *   background command is listed once, as that command: its spawning tool
 *   call is not listed (`isListedTaskCard`).
 */
export interface WorkCounts {
  agents: number;
  commands: number;
  monitors: number;
  tools: number;
}

export function countWork(rows: readonly AllChatsRow[]): WorkCounts {
  const counts: WorkCounts = { agents: 0, commands: 0, monitors: 0, tools: 0 };
  const add = (kind: ChildWorkKind) => {
    if (kind === 'agent') counts.agents += 1;
    else if (kind === 'monitor') counts.monitors += 1;
    else counts.commands += 1;
  };
  for (const row of rows) {
    if (row.kind === 'child') add(childWorkKindOf(row.row.item));
    else if (row.workKind) add(row.workKind);
    else if (row.entry.kind === 'agent') counts.agents += 1;
    else counts.tools += 1;
  }
  return counts;
}

/** "3 agents · 1 command · 9 tools"; an empty kind is left out. */
export function workCountLabel(counts: WorkCounts): string {
  const part = (count: number, one: string, many: string) =>
    count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  return [
    ...part(counts.agents, 'agent', 'agents'),
    ...part(counts.commands, 'command', 'commands'),
    ...part(counts.monitors, 'monitor', 'monitors'),
    ...part(counts.tools, 'tool', 'tools'),
  ].join(' · ');
}
