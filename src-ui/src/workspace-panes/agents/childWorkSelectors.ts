import type {
  ChildWorkItem,
  ChildWorkRegistryState,
} from '@kontourai/station-contracts/child-work';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';

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
  /** Epoch ms, only when reported (or taken from the spawning tool card). */
  startedAtMs?: number;
  endedAtMs?: number;
  stop?: ChildWorkStopControl;
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
  chatFacts?: (chatKey: string) => { provider?: string; title?: string };
  /**
   * A delegate thread → the thread its bind event named as parent (the
   * background-tasks store's `delegateParents`), for per-chat nesting.
   */
  delegateParentOf?: (threadId: string) => string | undefined;
  /** A tool call's start (ms), for a legacy subagent with no `startedAt`. */
  toolCallStartedAt?: (toolCallId: string) => number | undefined;
}

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function itemKey(item: ChildWorkItem): string {
  return JSON.stringify([item.producer, item.reporterThreadId, item.childId]);
}

function sessionIndex(sessions: readonly ChildWorkSessionSource[]) {
  return new Map(sessions.map((session) => [session.threadId, session]));
}

/**
 * The chat a session belongs to: its own id, else its durable conversation's
 * (a conversation's older execution child still resolves to its chat).
 */
function resolveChat(
  threadId: string,
  input: ChildWorkSelectorInput,
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
      parseTime(item.startedAt) ??
      (item.parent?.toolCallId
        ? input.toolCallStartedAt?.(item.parent.toolCallId)
        : undefined);
    const endedAtMs = parseTime(item.endedAt);
    candidates.push({
      row: {
        key,
        item,
        title: titleFor(item, sessions),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(endedAtMs !== undefined ? { endedAtMs } : {}),
        ...(stop ? { stop } : {}),
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
    finishedOmitted = finished.length - finishedLimit;
    finished = finished.slice(0, finishedLimit);
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
  const sessions = sessionIndex(input.sessions);
  // The key itself is a thread id: a thread with no chat still reads its own
  // work (`useChatStoreKey`'s fall-through).
  const inChat = (threadId: string | undefined) =>
    threadId !== undefined &&
    (threadId === chatKey ||
      resolveChat(threadId, input, sessions) === chatKey);
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
        'Delegated tasks and tool calls from this conversation still appear here.',
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
        'Delegated tasks and engine subagents from every conversation appear here, including work started from the CLI.',
    };
  if (!options.hasChat)
    return {
      label: 'Nothing here yet',
      description: 'Open a chat to see the work it set running.',
    };
  return options.subagentNotice ?? { label: 'No subagents running' };
}
