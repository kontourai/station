import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type {
  ChildUsageRelation,
  ThreadUsageEstimatedCost,
  ThreadUsageFigures,
  ThreadUsageNode,
  ThreadUsageReportedCost,
  ThreadUsageTree,
} from '@kontourai/station-contracts/thread-usage-tree';
import { useState } from 'react';
import { Button } from '../Button';
import { describeReadFailure } from '../state';
import './ThreadUsageBreakdown.css';

/**
 * A conversation's usage roll-up and its breakdown: own turns first, then
 * each child (engine subagent or delegated task) nested by depth, each with
 * its own tokens, cost, tool uses and duration, and in plain words whether
 * the total counts it. The total says when it is partial, and why.
 *
 * Cost buckets are listed side by side and never added together: one per
 * currency for engine-reported cost, one per currency and price snapshot for
 * Station's estimates.
 */

const RELATION_TEXT: Record<ChildUsageRelation, string> = {
  added: 'added to total',
  'included-in-parent': 'already in parent',
  'not-reported': 'not in total',
};

/**
 * `totalTokens` is input + output only. The dialog's own "Total" above adds
 * cache for engines where that is backed, so this figure says what it is.
 */
function formatTokens(value: number | undefined): string | undefined {
  return value === undefined
    ? undefined
    : `${value.toLocaleString()} input + output tokens`;
}

/** What the summed input figures mean, in words; absent with no total. */
function describeCacheInclusion(
  tokens: ThreadUsageTree['total']['tokens'],
): string | undefined {
  const engines = (tokens.providers ?? [])
    .map((provider) => engineDisplayLabel(provider as EngineId) ?? provider)
    .join(', ');
  switch (tokens.cacheInclusion) {
    case 'excluded':
      return 'Cache reads and writes are not included.';
    case 'not-established':
      return (tokens.providers?.length ?? 0) > 1
        ? `Cache reads and writes are not added. It isn't established whether these engines (${engines}) count cached input the same way.`
        : `Cache reads and writes are not added. It isn't established whether ${engines} counts cached input inside its input figure.`;
    case 'mixed':
      return `Adds engines that count cached input differently (${engines}), so this sum mixes two measures.`;
    default:
      return undefined;
  }
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,
    }).format(amount);
  } catch {
    // A currency code Intl does not know is still shown, never dropped.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatCostBuckets(
  reported: readonly ThreadUsageReportedCost[] | undefined,
  estimated: readonly ThreadUsageEstimatedCost[] | undefined,
): string | undefined {
  const parts = [
    ...(reported ?? []).map(
      (bucket) => `${formatMoney(bucket.amount, bucket.currency)} reported`,
    ),
    ...(estimated ?? []).map(
      (bucket) => `~${formatMoney(bucket.amount, bucket.currency)} estimated`,
    ),
  ];
  // Listed side by side, never joined with "+": these amounts are not
  // summable with each other.
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function figureParts(own: ThreadUsageFigures | undefined): string[] {
  if (!own) return ['nothing reported'];
  return [
    formatTokens(own.totalTokens),
    own.lastRequestTokens !== undefined
      ? `last request ${own.lastRequestTokens.toLocaleString()} tokens (not its usage)`
      : undefined,
    own.unverifiedTokens !== undefined
      ? `${own.unverifiedTokens.toLocaleString()} tokens reported (meaning not established)`
      : undefined,
    formatCostBuckets(own.reportedCost, own.estimatedCost),
    own.toolUses !== undefined
      ? `${own.toolUses} tool ${own.toolUses === 1 ? 'use' : 'uses'}`
      : undefined,
    formatDuration(own.durationMs),
  ].filter((part): part is string => part !== undefined);
}

function describeRelation(node: ThreadUsageNode): string | undefined {
  const relation = node.relation;
  if (!relation) return undefined;
  if (relation.tokens === relation.cost)
    return `Usage ${RELATION_TEXT[relation.tokens]}`;
  return `Tokens ${RELATION_TEXT[relation.tokens]}, cost ${RELATION_TEXT[relation.cost]}`;
}

function nodeLabel(node: ThreadUsageNode): string {
  if (node.depth === 0) return 'This conversation (own turns)';
  const kind =
    node.kind === 'station-delegate'
      ? node.location === 'paired-station'
        ? 'Delegated task on a paired Station'
        : 'Delegated task'
      : 'Subagent';
  return node.title ? `${kind}: ${node.title}` : kind;
}

function flatten(node: ThreadUsageNode): ThreadUsageNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function BreakdownRow({ node }: { node: ThreadUsageNode }) {
  const relation = describeRelation(node);
  const notCounted =
    node.relation &&
    (node.relation.tokens === 'not-reported' ||
      node.relation.cost === 'not-reported');
  return (
    <li
      className="thread-usage-breakdown__row"
      style={{ '--thread-usage-level': node.depth } as React.CSSProperties}
      data-kind={node.kind}
    >
      <div className="thread-usage-breakdown__row-head">
        <span className="thread-usage-breakdown__label">{nodeLabel(node)}</span>
        {node.kindLabel && (
          <span className="thread-usage-breakdown__kind">{node.kindLabel}</span>
        )}
      </div>
      <div className="thread-usage-breakdown__figures">
        {figureParts(node.own).join(' · ')}
      </div>
      {relation && (
        <div
          className="thread-usage-breakdown__relation"
          data-partial={notCounted ? 'true' : undefined}
        >
          {relation}. {node.relation?.reason}
        </div>
      )}
      {node.subagents?.observability === 'not-reported' && (
        <div className="thread-usage-breakdown__note">
          Subagents not reported: {node.subagents.reason}
        </div>
      )}
    </li>
  );
}

export function ThreadUsageBreakdown({
  tree,
  isLoading,
  error,
}: {
  tree: ThreadUsageTree | undefined;
  isLoading?: boolean;
  error?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  if (isLoading)
    return (
      <section className="thread-usage-breakdown" aria-busy="true">
        <h4 className="thread-usage-breakdown__title">Usage with children</h4>
        <div className="thread-usage-breakdown__note">Reading usage…</div>
      </section>
    );
  if (error)
    return (
      <section className="thread-usage-breakdown">
        <h4 className="thread-usage-breakdown__title">Usage with children</h4>
        <div className="thread-usage-breakdown__note">
          Unable to read usage: {describeReadFailure(error)}
        </div>
      </section>
    );
  if (!tree) return null;
  const { total } = tree;
  const tokens = formatTokens(total.tokens.totalTokens);
  const cacheNote = describeCacheInclusion(total.tokens);
  const cost = formatCostBuckets(
    total.cost.reportedCost,
    total.cost.estimatedCost,
  );
  const partial = !total.tokens.complete || !total.cost.complete;
  const rows = flatten(tree.root);
  return (
    <section
      className="thread-usage-breakdown"
      aria-labelledby="thread-usage-breakdown-title"
    >
      <h4
        id="thread-usage-breakdown-title"
        className="thread-usage-breakdown__title"
      >
        Usage with children
      </h4>
      <div className="thread-usage-breakdown__total">
        <span>Total: {tokens ?? 'tokens not reported'}</span>
        <span>{cost ?? 'cost not reported'}</span>
        {partial && (
          <span className="thread-usage-breakdown__partial">Partial</span>
        )}
      </div>
      {cacheNote && (
        <div className="thread-usage-breakdown__note">{cacheNote}</div>
      )}
      {total.partialReasons.length > 0 && (
        <ul className="thread-usage-breakdown__reasons">
          {total.partialReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        variant="secondary"
        className="thread-usage-breakdown__toggle"
        aria-expanded={expanded}
        aria-controls="thread-usage-breakdown-rows"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Hide breakdown' : `Show breakdown (${rows.length})`}
      </Button>
      {expanded && (
        <ul
          id="thread-usage-breakdown-rows"
          className="thread-usage-breakdown__rows"
        >
          {rows.map((node, index) => (
            // A child id is unique only within the session that reported it.
            <BreakdownRow
              key={`${index}:${node.kind}:${node.id}`}
              node={node}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
