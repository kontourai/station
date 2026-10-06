/**
 * A conversation's usage as a tree: its own turns, then every child that ran
 * under it (engine subagents and Station delegates, nested), plus one roll-up
 * total that says honestly what it does and does not contain.
 *
 * Read-only, provider-observed facts like `usage-rollup`: not an invoice, and
 * never billing or routing authority. Absent means not reported, never zero.
 *
 * Tokens and cost are judged separately, because one engine can report them
 * with different scopes. Claude Code is the case that forces this: the
 * per-turn token figures Station records exclude Task subagents, while the
 * reported cost on the same message includes them.
 */
import type { ChildWorkStatus } from './child-work.js';

/** Bound on nodes (the root included) one tree read may return. */
export const THREAD_USAGE_TREE_MAX_NODES = 200;
/** Bound on how deep Station delegates may nest below the root. */
export const THREAD_USAGE_TREE_MAX_DEPTH = 8;
/**
 * Bound on the delegate records one level of a tree read may examine,
 * readable or not. Reaching it refuses the read: the records past it were
 * never seen, so a total built without them could not say what it misses.
 */
export const THREAD_USAGE_TREE_MAX_DELEGATE_RECORDS = 1_000;

/**
 * How a child's usage relates to its parent's figures, for one measurement:
 *
 * - `added`: the parent's figure does not contain the child's, and the
 *   child's own figure means the same thing, so the total adds it.
 * - `included-in-parent`: the parent's figure already contains the child's,
 *   so it is shown in the breakdown and not added again.
 * - `not-reported`: the child's usage for this measurement is not available
 *   in a form the total can use, so the total is partial.
 */
export type ChildUsageRelation =
  | 'added'
  | 'included-in-parent'
  | 'not-reported';

export const CHILD_USAGE_RELATIONS: readonly ChildUsageRelation[] = [
  'added',
  'included-in-parent',
  'not-reported',
];

export interface ThreadUsageReportedCost {
  amount: number;
  currency: string;
}

export interface ThreadUsageEstimatedCost {
  amount: number;
  currency: string;
  pricingSnapshotId: string;
  pricingSnapshotCapturedAt?: string;
  pricingSnapshotSource?: string;
}

/**
 * One node's figures. Cost is kept as buckets: one per currency for reported
 * cost, one per currency and pricing snapshot for estimates. Buckets are never
 * summed with each other, and reported cost is never mixed with estimates.
 */
export interface ThreadUsageFigures {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Tokens used: `inputTokens + outputTokens` as the engine reported them,
   * or a subagent's own consumption total when that is all its engine
   * reports. Cache reads and writes are listed separately and are not added
   * to it; whether an engine's input figure already contains cached input is
   * the engine's own convention (see `ThreadUsageTotal.tokens.cacheInclusion`).
   */
  totalTokens?: number;
  /**
   * A subagent's token figure that is the size of its LAST request (input +
   * output + cache), not what it used. Shown, never added, never a
   * `totalTokens`.
   */
  lastRequestTokens?: number;
  /** A subagent's token figure whose meaning Station hasn't established. */
  unverifiedTokens?: number;
  /** The engines whose usage receipts these figures come from. */
  providers?: string[];
  reportedCost?: ThreadUsageReportedCost[];
  estimatedCost?: ThreadUsageEstimatedCost[];
  toolUses?: number;
  durationMs?: number;
}

export interface ThreadUsageRelation {
  tokens: ChildUsageRelation;
  cost: ChildUsageRelation;
  /** Plain-language reason for the two values, for display. */
  reason: string;
}

export type ThreadUsageNodeKind =
  | 'conversation'
  | 'engine-subagent'
  | 'station-delegate';

export interface ThreadUsageNode {
  kind: ThreadUsageNodeKind;
  /** Conversation id for a conversation or delegate; the child id for a subagent. */
  id: string;
  /** Session thread to open, for a conversation or a local delegate. */
  threadId?: string;
  title?: string;
  /** The producer's own name for the kind of child (e.g. a subagent type). */
  kindLabel?: string;
  /** The engine that produced (or reported) this node's usage. */
  provider?: string;
  status?: ChildWorkStatus;
  /**
   * 0 for the root. For a delegate, its level below the root. For an engine
   * subagent, the level its engine reported (1 for a top-level spawn) added
   * to the level of the conversation that reported it.
   */
  depth: number;
  /** A delegate running on a paired Station keeps its usage there. */
  location?: 'local' | 'paired-station';
  /** This node's own figures. Absent when nothing was reported. */
  own?: ThreadUsageFigures;
  /** How `own` relates to the parent. Absent on the root. */
  relation?: ThreadUsageRelation;
  /**
   * For a conversation or delegate: whether its engine reports subagents.
   * `not-reported` means any subagents it ran are invisible here.
   */
  subagents?:
    | { observability: 'reported' }
    | { observability: 'not-reported'; reason: string };
  children: ThreadUsageNode[];
}

export interface ThreadUsageTotal {
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Input + output tokens; cache reads and writes are not added. */
    totalTokens?: number;
    /**
     * Whether the summed input figures contain cached input, from each
     * contributing engine's declared convention: `excluded` (every engine
     * reports uncached input), `mixed` (two declared conventions that differ
     * were summed, so the total mixes measures) or `not-established` (any
     * other case, including an engine whose convention is unverified or
     * undeclared).
     */
    cacheInclusion?: 'excluded' | 'not-established' | 'mixed';
    /** The engines whose tokens are in the total. */
    providers?: string[];
    /** False when any child's tokens are `not-reported`. */
    complete: boolean;
  };
  cost: {
    reportedCost?: ThreadUsageReportedCost[];
    estimatedCost?: ThreadUsageEstimatedCost[];
    /** False when any child's cost is `not-reported`. */
    complete: boolean;
  };
  /** Why the total is partial, one plain-language line each. */
  partialReasons: string[];
}

export interface ThreadUsageTree {
  conversationId: string;
  root: ThreadUsageNode;
  total: ThreadUsageTotal;
  nodeCount: number;
}
