import type {
  ChildWorkItem,
  ChildWorkUsage,
} from '@kontourai/station-contracts/child-work';
import type {
  ThreadUsageEstimatedCost,
  ThreadUsageFigures,
  ThreadUsageNode,
  ThreadUsageRelation,
  ThreadUsageReportedCost,
  ThreadUsageTotal,
  ThreadUsageTree,
} from '@kontourai/station-contracts/thread-usage-tree';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { providerPromptCacheInclusivity } from './usage-fold.js';
import { reconcileUsageReceiptObservations } from './usage-rollup.js';

/**
 * How an engine's subagents relate to the usage its parent session reports,
 * per engine and per measurement. Each entry is backed by evidence about
 * that engine; an engine absent here is undeclared, and its subagents are
 * `not-reported` for both measurements. Never guess `added`: guessing wrong
 * double counts or invents usage, and nothing on screen would show it.
 *
 * - Claude Code. Tokens: the `result` message's `usage`, which is what the
 *   adapter records per turn, is documented in the Agent SDK's own typings
 *   as "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and
 *   auxiliary model calls". A measured run agrees: the main-loop cache writes
 *   on `result.usage` summed to exactly the main loop's own calls, and the
 *   subagent's 12,085 cache-write tokens appeared only in `modelUsage`. But the
 *   subagent's own `task_notification.usage.total_tokens` is not what it used:
 *   on recorded transcripts it equals its LAST request's input + output +
 *   cache read + cache write (164,465 reported for a subagent whose calls
 *   added up to 33,889 input + output and 7.5 million with cache). So the
 *   parent excludes it and the child's figure cannot be added: tokens are
 *   `not-reported`. Cost: `total_cost_usd` is documented to cover "the same
 *   query-pipeline calls as modelUsage", which includes Task subagents, and
 *   in the measured run it equalled `modelUsage`'s cost to the cent. Cost is
 *   `included-in-parent`.
 * - Codex. Each child is its own app-server thread with its own
 *   `thread/tokenUsage/updated`; the adapter routes it to the child and never
 *   to the parent. In the recorded codex-cli 0.155.1 collab captures the
 *   parent's cumulative `tokenUsage.total` is exactly the sum of its own
 *   `last` figures, with the child's tokens nowhere in it, and the child's
 *   `totalTokens` is the same input + output measure. Tokens are `added`.
 *   Codex reports no cost for a child: `not-reported`.
 * - Muse. A workflow child's `usage` (input and output tokens) rides on the
 *   parent's workflow item. In the recorded muse serve 1.3.0 captures the
 *   parent session's `cumulative` token figures are exactly the sum of its
 *   own per-call `session/tokenUsage` frames, without the child's. Tokens are
 *   `added`; no cost is reported for a child: `not-reported`.
 */
export const ENGINE_SUBAGENT_USAGE_RELATION: ReadonlyMap<
  string,
  ThreadUsageRelation
> = new Map<string, ThreadUsageRelation>([
  [
    'claude',
    {
      tokens: 'not-reported',
      cost: 'included-in-parent',
      reason:
        "Claude Code leaves subagents out of its per-turn token counts, and a subagent's own token count is the size of its last request, not what it used, so its tokens can't be added. Claude Code's reported cost already includes it.",
    },
  ],
  [
    'codex',
    {
      tokens: 'added',
      cost: 'not-reported',
      reason:
        "Codex runs each subagent as its own thread and counts its tokens there, not in the parent's, so they are added. Codex reports no cost for a subagent.",
    },
  ],
  [
    'muse',
    {
      tokens: 'added',
      cost: 'not-reported',
      reason:
        "Muse reports a workflow subagent's tokens separately from the parent session's, so they are added. Muse reports no cost for a subagent.",
    },
  ],
]);

/**
 * What a subagent's own reported token figure measures, per engine, from the
 * same evidence as {@link ENGINE_SUBAGENT_USAGE_RELATION}: `consumption` is
 * the tokens it used (input + output, the engine's own convention); Claude
 * Code's `total_tokens` is its last request's size. An undeclared engine's
 * figure is `unverified`. Only `consumption` may become `totalTokens`.
 */
export const ENGINE_SUBAGENT_TOKEN_MEANING: ReadonlyMap<
  string,
  'consumption' | 'last-request'
> = new Map([
  ['claude', 'last-request'],
  ['codex', 'consumption'],
  ['muse', 'consumption'],
]);

export function engineSubagentUsageRelation(
  provider: string | undefined,
): ThreadUsageRelation {
  return (
    (provider ? ENGINE_SUBAGENT_USAGE_RELATION.get(provider) : undefined) ?? {
      tokens: 'not-reported',
      cost: 'not-reported',
      reason:
        "Station hasn't established whether this engine's session usage includes its subagents, so their usage isn't counted.",
    }
  );
}

/** A Station delegate is its own session with its own receipts. */
export const LOCAL_DELEGATE_USAGE_RELATION: ThreadUsageRelation = {
  tokens: 'added',
  cost: 'added',
  reason:
    'A delegated task runs as its own session with its own usage, so it is added.',
};

export const PAIRED_DELEGATE_USAGE_RELATION: ThreadUsageRelation = {
  tokens: 'not-reported',
  cost: 'not-reported',
  reason:
    'This delegated task ran on a paired Station, and its usage is recorded there, not here.',
};

export interface ThreadUsageSubagentSource {
  item: ChildWorkItem;
  /** The engine of the session that reported the subagent. */
  provider?: string;
}

export interface ThreadUsageConversationSource {
  conversationId: string;
  threadId?: string;
  title?: string;
  provider?: string;
  /** Receipts attributed to this conversation's own session threads. */
  receipts: readonly UsageReceipt[];
  subagents: readonly ThreadUsageSubagentSource[];
  subagentObservability?: ThreadUsageNode['subagents'];
  delegates: readonly ThreadUsageDelegateSource[];
  /**
   * Subagents the engine reported that the bounded child-work history no
   * longer holds (the fold keeps the newest settled ones per session).
   */
  omittedSubagentCount?: number;
  /**
   * Delegates Station launched from this conversation that run under an
   * owner the reader cannot read (#3323). Never read, named or figured; the
   * total is partial by them.
   */
  unreadableDelegateCount?: number;
}

export type ThreadUsageDelegateSource =
  | {
      location: 'local';
      item: ChildWorkItem;
      provider?: string;
      source: ThreadUsageConversationSource;
    }
  | { location: 'paired-station'; item: ChildWorkItem; provider?: string };

function validAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function addMeasured(current: number | undefined, next: number | undefined) {
  return validAmount(next) ? (current ?? 0) + next : current;
}

function addReportedCost(
  buckets: ThreadUsageReportedCost[],
  cost: ThreadUsageReportedCost,
) {
  if (!validAmount(cost.amount) || !cost.currency) return;
  const bucket = buckets.find((item) => item.currency === cost.currency);
  if (bucket) bucket.amount += cost.amount;
  else buckets.push({ amount: cost.amount, currency: cost.currency });
}

function sameEstimateBasis(
  left: ThreadUsageEstimatedCost,
  right: ThreadUsageEstimatedCost,
) {
  return (
    left.currency === right.currency &&
    left.pricingSnapshotId === right.pricingSnapshotId &&
    left.pricingSnapshotCapturedAt === right.pricingSnapshotCapturedAt &&
    left.pricingSnapshotSource === right.pricingSnapshotSource
  );
}

function addEstimatedCost(
  buckets: ThreadUsageEstimatedCost[],
  cost: ThreadUsageEstimatedCost,
) {
  if (!validAmount(cost.amount) || !cost.currency) return;
  const bucket = buckets.find((item) => sameEstimateBasis(item, cost));
  if (bucket) bucket.amount += cost.amount;
  else buckets.push({ ...cost });
}

function compactFigures(
  figures: ThreadUsageFigures,
): ThreadUsageFigures | undefined {
  const next: ThreadUsageFigures = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
    'lastRequestTokens',
    'unverifiedTokens',
    'toolUses',
    'durationMs',
  ] as const) {
    if (figures[key] !== undefined) next[key] = figures[key];
  }
  if (figures.providers?.length) next.providers = figures.providers;
  if (figures.reportedCost?.length) next.reportedCost = figures.reportedCost;
  if (figures.estimatedCost?.length) next.estimatedCost = figures.estimatedCost;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * A conversation's own figures from its receipts, reconciled exactly as the
 * usage rollup reconciles them: a repeated receipt id is one fact observed
 * again (a cumulative restatement, a cost restated every turn), never a
 * second billable event.
 */
export function threadUsageFiguresFromReceipts(
  receipts: readonly UsageReceipt[],
): ThreadUsageFigures | undefined {
  const latest = reconcileUsageReceiptObservations(receipts);
  const figures: ThreadUsageFigures = {};
  const reportedCost: ThreadUsageReportedCost[] = [];
  const estimatedCost: ThreadUsageEstimatedCost[] = [];
  const providers = new Set<string>();
  for (const receipt of latest.values()) {
    if (validAmount(receipt.inputTokens) || validAmount(receipt.outputTokens))
      providers.add(receipt.provider);
    figures.inputTokens = addMeasured(figures.inputTokens, receipt.inputTokens);
    figures.outputTokens = addMeasured(
      figures.outputTokens,
      receipt.outputTokens,
    );
    figures.cacheReadTokens = addMeasured(
      figures.cacheReadTokens,
      receipt.cacheReadTokens,
    );
    figures.cacheWriteTokens = addMeasured(
      figures.cacheWriteTokens,
      receipt.cacheWriteTokens,
    );
    if (receipt.reportedCost)
      addReportedCost(reportedCost, receipt.reportedCost);
    if (receipt.estimatedCost) {
      const estimate = receipt.estimatedCost;
      addEstimatedCost(estimatedCost, {
        amount: estimate.amount,
        currency: estimate.currency,
        pricingSnapshotId: estimate.pricingSnapshotId,
        ...(estimate.pricingSnapshotObservedAt
          ? { pricingSnapshotCapturedAt: estimate.pricingSnapshotObservedAt }
          : {}),
        ...(estimate.pricingSnapshotSource
          ? { pricingSnapshotSource: estimate.pricingSnapshotSource }
          : {}),
      });
    }
  }
  if (figures.inputTokens !== undefined || figures.outputTokens !== undefined) {
    figures.totalTokens =
      (figures.inputTokens ?? 0) + (figures.outputTokens ?? 0);
  }
  figures.reportedCost = reportedCost;
  figures.estimatedCost = estimatedCost;
  figures.providers = [...providers].sort();
  return compactFigures(figures);
}

/**
 * A subagent's own figures, as its engine reported them on child work. Its
 * token figure lands where its declared meaning says: only consumption is a
 * `totalTokens`.
 */
export function threadUsageFiguresFromChildWork(
  usage: ChildWorkUsage | undefined,
  provider: string | undefined,
): ThreadUsageFigures | undefined {
  if (!usage) return undefined;
  const meaning = provider
    ? ENGINE_SUBAGENT_TOKEN_MEANING.get(provider)
    : undefined;
  const tokens = validAmount(usage.totalTokens) ? usage.totalTokens : undefined;
  return compactFigures({
    ...(tokens !== undefined
      ? meaning === 'consumption'
        ? { totalTokens: tokens, providers: [provider!] }
        : meaning === 'last-request'
          ? { lastRequestTokens: tokens }
          : { unverifiedTokens: tokens }
      : {}),
    ...(validAmount(usage.toolUses) ? { toolUses: usage.toolUses } : {}),
    ...(validAmount(usage.durationMs) ? { durationMs: usage.durationMs } : {}),
  });
}

function childBase(item: ChildWorkItem) {
  return {
    ...(item.title ? { title: item.title } : {}),
    ...(item.kindLabel ? { kindLabel: item.kindLabel } : {}),
    status: item.status,
  };
}

function conversationNode(
  source: ThreadUsageConversationSource,
  depth: number,
): ThreadUsageNode {
  const subagentNodes: ThreadUsageNode[] = source.subagents
    .filter(({ item }) => item.producer === 'engine-subagent')
    .map(({ item, provider }) => {
      const own = threadUsageFiguresFromChildWork(item.usage, provider);
      return {
        kind: 'engine-subagent' as const,
        id: item.childId,
        ...childBase(item),
        ...(provider ? { provider } : {}),
        depth: depth + (item.depth ?? 1),
        ...(own ? { own } : {}),
        relation: engineSubagentUsageRelation(provider),
        children: [],
      };
    });
  const delegateNodes: ThreadUsageNode[] = source.delegates.map((delegate) => {
    if (delegate.location === 'paired-station') {
      return {
        kind: 'station-delegate' as const,
        id: delegate.item.childId,
        ...childBase(delegate.item),
        ...(delegate.provider ? { provider: delegate.provider } : {}),
        depth: depth + 1,
        location: 'paired-station' as const,
        relation: PAIRED_DELEGATE_USAGE_RELATION,
        children: [],
      };
    }
    const node = conversationNode(delegate.source, depth + 1);
    return {
      ...node,
      kind: 'station-delegate' as const,
      ...childBase(delegate.item),
      ...(node.title && !delegate.item.title ? { title: node.title } : {}),
      location: 'local' as const,
      relation: LOCAL_DELEGATE_USAGE_RELATION,
    };
  });
  const own = threadUsageFiguresFromReceipts(source.receipts);
  return {
    kind: 'conversation',
    id: source.conversationId,
    ...(source.threadId ? { threadId: source.threadId } : {}),
    ...(source.title ? { title: source.title } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    depth,
    ...(own ? { own } : {}),
    ...(source.subagentObservability
      ? { subagents: source.subagentObservability }
      : {}),
    children: [...subagentNodes, ...delegateNodes],
  };
}

function addFiguresToTotal(
  total: ThreadUsageTotal,
  own: ThreadUsageFigures,
  tokenProviders: Set<string>,
) {
  const tokens = total.tokens;
  tokens.inputTokens = addMeasured(tokens.inputTokens, own.inputTokens);
  tokens.outputTokens = addMeasured(tokens.outputTokens, own.outputTokens);
  tokens.cacheReadTokens = addMeasured(
    tokens.cacheReadTokens,
    own.cacheReadTokens,
  );
  tokens.cacheWriteTokens = addMeasured(
    tokens.cacheWriteTokens,
    own.cacheWriteTokens,
  );
  tokens.totalTokens = addMeasured(tokens.totalTokens, own.totalTokens);
  if (own.totalTokens !== undefined)
    for (const provider of own.providers ?? []) tokenProviders.add(provider);
}

/**
 * Sums of input figures mean one thing only when every summed engine counts
 * cached input the same way. `mixed` is claimed only from two DECLARED
 * conventions that differ (`disjoint` beside `subset`); an `unverified` or
 * undeclared engine is unknown, not different, so with one present the
 * answer is `not-established`.
 */
function cacheInclusion(
  providers: ReadonlySet<string>,
): NonNullable<ThreadUsageTotal['tokens']['cacheInclusion']> {
  const conventions = [...providers].map((provider) =>
    providerPromptCacheInclusivity(provider),
  );
  if (conventions.includes('disjoint') && conventions.includes('subset'))
    return 'mixed';
  return conventions.every((convention) => convention === 'disjoint')
    ? 'excluded'
    : 'not-established';
}

function addCostToTotal(total: ThreadUsageTotal, own: ThreadUsageFigures) {
  for (const cost of own.reportedCost ?? []) {
    total.cost.reportedCost ??= [];
    addReportedCost(total.cost.reportedCost, cost);
  }
  for (const cost of own.estimatedCost ?? []) {
    total.cost.estimatedCost ??= [];
    addEstimatedCost(total.cost.estimatedCost, cost);
  }
}

/**
 * The roll-up. A node's figures join the total for a measurement only when
 * its relation for that measurement is `added` and its parent's figures for
 * that measurement are themselves in the total. `included-in-parent` is shown
 * and skipped; `not-reported` makes the total partial and says why.
 */
export function rollUpThreadUsage(
  root: ThreadUsageNode,
  omittedSubagents = 0,
  unreadableDelegates = 0,
): ThreadUsageTotal {
  const tokenProviders = new Set<string>();
  const total: ThreadUsageTotal = {
    tokens: { complete: true },
    cost: { complete: true },
    partialReasons: [],
  };
  const missing = new Map<string, number>();
  const note = (line: string) =>
    missing.set(line, (missing.get(line) ?? 0) + 1);
  const visit = (
    node: ThreadUsageNode,
    parentTokens: boolean,
    parentCost: boolean,
  ) => {
    const relation = node.relation;
    const tokens = relation
      ? parentTokens && relation.tokens === 'added'
      : true;
    const cost = relation ? parentCost && relation.cost === 'added' : true;
    const tokensMissing = relation?.tokens === 'not-reported';
    const costMissing = relation?.cost === 'not-reported';
    if (tokensMissing) total.tokens.complete = false;
    if (costMissing) total.cost.complete = false;
    if (relation && (tokensMissing || costMissing))
      note(
        `${tokensMissing && costMissing ? 'Usage' : tokensMissing ? 'Tokens' : 'Cost'} not counted: ${relation.reason}`,
      );
    if (node.own && tokens) addFiguresToTotal(total, node.own, tokenProviders);
    if (node.own && cost) addCostToTotal(total, node.own);
    // A child included in its parent is in the total exactly when its
    // parent is, so its own children inherit that, not a fresh "counted".
    for (const child of node.children)
      visit(
        child,
        tokens || (parentTokens && relation?.tokens === 'included-in-parent'),
        cost || (parentCost && relation?.cost === 'included-in-parent'),
      );
  };
  visit(root, true, true);
  for (const [line, count] of missing)
    total.partialReasons.push(count > 1 ? `${line} (${count} children)` : line);
  if (total.tokens.totalTokens !== undefined && tokenProviders.size > 0) {
    total.tokens.providers = [...tokenProviders].sort();
    total.tokens.cacheInclusion = cacheInclusion(tokenProviders);
  }
  if (omittedSubagents > 0) {
    total.tokens.complete = false;
    total.cost.complete = false;
    total.partialReasons.push(
      `${omittedSubagents} earlier ${omittedSubagents === 1 ? 'subagent is' : 'subagents are'} past the kept history and not shown.`,
    );
  }
  if (unreadableDelegates > 0) {
    total.tokens.complete = false;
    total.cost.complete = false;
    total.partialReasons.push(
      `${unreadableDelegates} delegated ${unreadableDelegates === 1 ? 'task runs' : 'tasks run'} under an owner you can't read, so ${unreadableDelegates === 1 ? 'its' : 'their'} usage is not counted.`,
    );
  }
  return total;
}

function countNodes(node: ThreadUsageNode): number {
  return node.children.reduce((sum, child) => sum + countNodes(child), 1);
}

function sumOverTree(
  source: ThreadUsageConversationSource,
  read: (source: ThreadUsageConversationSource) => number | undefined,
): number {
  return source.delegates.reduce(
    (sum, delegate) =>
      sum +
      (delegate.location === 'local' ? sumOverTree(delegate.source, read) : 0),
    read(source) ?? 0,
  );
}

/** Pure: the same sources give the same tree and total anywhere. */
export function buildThreadUsageTree(
  source: ThreadUsageConversationSource,
): ThreadUsageTree {
  const root = conversationNode(source, 0);
  return {
    conversationId: source.conversationId,
    root,
    total: rollUpThreadUsage(
      root,
      sumOverTree(source, (item) => item.omittedSubagentCount),
      sumOverTree(source, (item) => item.unreadableDelegateCount),
    ),
    nodeCount: countNodes(root),
  };
}
