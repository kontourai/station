import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkKey,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  THREAD_USAGE_TREE_MAX_DEPTH,
  THREAD_USAGE_TREE_MAX_NODES,
  type ThreadUsageNode,
  type ThreadUsageTree,
} from '@kontourai/station-contracts/thread-usage-tree';
import {
  buildThreadUsageTree,
  type ThreadUsageConversationSource,
  type ThreadUsageDelegateSource,
  type ThreadUsageSubagentSource,
} from '@kontourai/station-shared/thread-usage-tree';
import type {
  PersistedRuntimeEvent,
  UsageReceiptEventRow,
} from './event-store.js';
import type { SessionReadScope } from './orchestration-service.js';
import { usageReceiptsForEventRow } from './session-transcript-reads.js';

/**
 * Bound on the usage observations one tree read folds, across every
 * conversation in it. A tree past this is refused, never cut: a cut total
 * would read as complete.
 */
export const THREAD_USAGE_TREE_MAX_USAGE_EVENTS = 5_000;

export interface ThreadUsageTreeReadDeps {
  stationId: string;
  /**
   * The conversation read rule: every session in its lineage readable, so a
   * tree never discloses part of a conversation.
   */
  canReadConversation: (
    conversationId: string,
    authority: SessionReadScope,
  ) => boolean;
  /** The conversation's own session threads, in lineage order. */
  conversationThreadIds: (conversationId: string) => string[];
  listUsageReceiptEventsForThreads: (
    threadIds: readonly string[],
    limit: number,
  ) => UsageReceiptEventRow[];
  listChildWorkHistoryForThreads: (
    threadIds: readonly string[],
  ) => Map<string, PersistedRuntimeEvent[]>;
  listDelegatedSessionThreads: (
    parentTaskIds: readonly string[],
    limit: number,
  ) => Array<{ threadId: string; parentTaskId: string }>;
  /**
   * A delegated session as its parent's child work, from its own session
   * summary: undefined when the thread is not a delegate.
   */
  describeDelegate: (threadId: string) =>
    | {
        item: ChildWorkItem;
        provider?: string;
        title?: string;
        pairedStation: boolean;
      }
    | undefined;
  describeConversation: (threadIds: readonly string[]) => {
    provider?: string;
    title?: string;
  };
}

export type ThreadUsageTreeReadOutcome =
  | { status: 'found'; tree: ThreadUsageTree }
  | { status: 'not-found' }
  | {
      status: 'too-large';
      limit: 'nodes' | 'depth' | 'usage-events';
      max: number;
    };

class TreeTooLarge extends Error {
  constructor(
    readonly limit: 'nodes' | 'depth' | 'usage-events',
    readonly max: number,
  ) {
    super(`usage tree exceeds its ${limit} bound (${max})`);
  }
}

/**
 * Engine subagents the conversation's own sessions reported, folded through
 * the child-work contract's one reducer from their durable deltas (and the
 * legacy Claude tuples, through the contract's own translator). Unlike the
 * live projection this keeps children across a session's exit: their usage
 * happened either way.
 */
function foldSubagents(eventsByThread: Map<string, PersistedRuntimeEvent[]>): {
  subagents: ThreadUsageSubagentSource[];
  notReported?: string;
  omitted: number;
} {
  let registry = createEmptyChildWorkRegistry();
  const providerByReporter = new Map<string, string>();
  const seen = new Set<string>();
  for (const [threadId, events] of eventsByThread) {
    for (const row of events) {
      const event = row.payload;
      const delta: ChildWorkDelta | undefined =
        event.method === 'child-work.updated'
          ? event.delta
          : event.method === 'extension.notification'
            ? childWorkDeltaFromLegacyClaudeTaskNotification(event, threadId)
            : undefined;
      if (!delta) continue;
      const reporter =
        delta.kind === 'upsert'
          ? delta.item.reporterThreadId
          : delta.reporterThreadId;
      // A delta names its own reporter; one on another thread is not this
      // session's to count.
      if (reporter !== threadId) continue;
      providerByReporter.set(threadId, row.provider);
      if (delta.kind === 'upsert') seen.add(childWorkKey(delta.item));
      else if (delta.kind === 'settle') seen.add(childWorkKey(delta));
      else if (delta.kind === 'snapshot')
        for (const item of delta.running) seen.add(childWorkKey(item));
      registry = applyChildWorkDelta(registry, delta);
    }
  }
  const items = Object.values(registry.items).filter(
    (item) => item.producer === 'engine-subagent',
  );
  const retained = new Set(Object.keys(registry.items));
  const notReported = Object.values(registry.notReported)[0];
  return {
    subagents: items.map((item) => ({
      item,
      provider: providerByReporter.get(item.reporterThreadId),
    })),
    ...(notReported ? { notReported } : {}),
    omitted: [...seen].filter((key) => !retained.has(key)).length,
  };
}

function subagentObservability(
  provider: string | undefined,
  notReported: string | undefined,
): ThreadUsageNode['subagents'] {
  if (notReported)
    return { observability: 'not-reported', reason: notReported };
  const cell = provider
    ? ENGINE_CAPABILITY_MATRICES[provider]?.subagentObservability
    : undefined;
  if (cell?.state === 'none')
    return { observability: 'not-reported', reason: cell.reason };
  if (cell?.state === 'declared') return { observability: 'reported' };
  return undefined;
}

/**
 * One conversation's usage tree: its own sessions' receipts, the subagents
 * those sessions reported, and the delegated tasks Station launched from it,
 * recursively. Each conversation is authorized whole; a delegate the reader
 * may not read is counted as missing and never described.
 */
export function readThreadUsageTree(
  deps: ThreadUsageTreeReadDeps,
  conversationId: string,
  authority: SessionReadAuthority,
): ThreadUsageTreeReadOutcome {
  if (!deps.canReadConversation(conversationId, authority))
    return { status: 'not-found' };
  let nodes = 0;
  let usageEvents = 0;
  const visited = new Set<string>();
  const countNodes = (count: number) => {
    nodes += count;
    if (nodes > THREAD_USAGE_TREE_MAX_NODES)
      throw new TreeTooLarge('nodes', THREAD_USAGE_TREE_MAX_NODES);
  };

  const readConversation = (
    id: string,
    depth: number,
  ): ThreadUsageConversationSource => {
    if (depth > THREAD_USAGE_TREE_MAX_DEPTH)
      throw new TreeTooLarge('depth', THREAD_USAGE_TREE_MAX_DEPTH);
    visited.add(id);
    countNodes(1);
    const threadIds = [...new Set([id, ...deps.conversationThreadIds(id)])];
    const remaining = THREAD_USAGE_TREE_MAX_USAGE_EVENTS - usageEvents;
    const rows = deps.listUsageReceiptEventsForThreads(
      threadIds,
      remaining + 1,
    );
    usageEvents += rows.length;
    if (usageEvents > THREAD_USAGE_TREE_MAX_USAGE_EVENTS)
      throw new TreeTooLarge(
        'usage-events',
        THREAD_USAGE_TREE_MAX_USAGE_EVENTS,
      );
    const receipts = rows.flatMap((row) =>
      usageReceiptsForEventRow(row, deps.stationId),
    );
    const folded = foldSubagents(
      deps.listChildWorkHistoryForThreads(threadIds),
    );
    countNodes(folded.subagents.length);
    const described = deps.describeConversation(threadIds);
    const delegates: ThreadUsageDelegateSource[] = [];
    let hiddenDelegateCount = 0;
    const found = deps.listDelegatedSessionThreads(
      [id],
      THREAD_USAGE_TREE_MAX_NODES - nodes + 1,
    );
    for (const { threadId } of found) {
      if (visited.has(threadId)) continue;
      if (!deps.canReadConversation(threadId, authority)) {
        hiddenDelegateCount += 1;
        continue;
      }
      const delegate = deps.describeDelegate(threadId);
      if (!delegate) continue;
      if (delegate.pairedStation) {
        countNodes(1);
        visited.add(threadId);
        delegates.push({
          location: 'paired-station',
          item: delegate.item,
          ...(delegate.provider ? { provider: delegate.provider } : {}),
        });
        continue;
      }
      delegates.push({
        location: 'local',
        item: delegate.item,
        ...(delegate.provider ? { provider: delegate.provider } : {}),
        source: readConversation(threadId, depth + 1),
      });
    }
    const observability = subagentObservability(
      described.provider,
      folded.notReported,
    );
    return {
      conversationId: id,
      threadId: threadIds.at(-1) ?? id,
      ...(described.title ? { title: described.title } : {}),
      ...(described.provider ? { provider: described.provider } : {}),
      receipts,
      subagents: folded.subagents,
      ...(observability ? { subagentObservability: observability } : {}),
      delegates,
      ...(hiddenDelegateCount > 0 ? { hiddenDelegateCount } : {}),
      ...(folded.omitted > 0 ? { omittedSubagentCount: folded.omitted } : {}),
    };
  };

  try {
    return {
      status: 'found',
      tree: buildThreadUsageTree(readConversation(conversationId, 0)),
    };
  } catch (error) {
    if (error instanceof TreeTooLarge)
      return { status: 'too-large', limit: error.limit, max: error.max };
    throw error;
  }
}
