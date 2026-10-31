import { useEffect } from 'react';
import type { ChatLiveUsage } from '../../contexts/active-chats-state';
import { useStats } from '../../contexts/StatsContext';
import { getContextWindowColor } from './utils';
import './ContextPercentage.css';

/** What the context share of one conversation is derived from. */
export interface ContextPercentageSource {
  agentSlug: string;
  conversationId: string;
  apiBase: string;
  messageCount?: number;
  /** A current provider observation can update the meter before refetch. */
  liveUsage?: Pick<ChatLiveUsage, 'contextTokens' | 'contextWindowTokens'>;
}

interface ContextPercentageProps extends ContextPercentageSource {
  onClick?: () => void;
  /** Server-owned policy/result, supplied by the existing stats/composer owner. */
  compaction?: { threshold: number; state: string };
}

function contextPercentage(
  contextTokens: number | undefined,
  contextWindowTokens: number | undefined,
): number | undefined {
  if (
    typeof contextTokens !== 'number' ||
    !Number.isFinite(contextTokens) ||
    contextTokens < 0 ||
    typeof contextWindowTokens !== 'number' ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }
  return Math.round((contextTokens / contextWindowTokens) * 10_000) / 100;
}

/**
 * The share of the context window a conversation uses, or `null` while it is
 * unknown: a current provider observation first, then the stats read (which
 * refetches as messages arrive). One derivation for the composer's meter and
 * the phone's Actions sheet, so the two can never disagree.
 */
export function useContextPercentage({
  agentSlug,
  conversationId,
  apiBase,
  messageCount,
  liveUsage,
}: ContextPercentageSource): number | null {
  const { stats, refetch } = useStats(agentSlug, conversationId, apiBase, true);
  useEffect(() => {
    if (messageCount !== undefined && messageCount > 0) {
      refetch();
    }
  }, [messageCount, refetch]);
  return (
    contextPercentage(
      liveUsage?.contextTokens,
      liveUsage?.contextWindowTokens,
    ) ??
    contextPercentage(stats?.contextWindowPercentage, 100) ??
    null
  );
}

/**
 * The composer's context meter: a short track and the rounded share of the
 * context window used. It sits in the composer's meta row beside the model it
 * measures; the exact figure is the tooltip, the breakdown is the stats panel
 * it opens.
 *
 * The track has its own width. It used to be `flex: 1` inside a shrink-to-fit
 * button, so it resolved to 0px and the meter read "Context:  (4.0%)".
 */
export function ContextPercentage({
  agentSlug,
  conversationId,
  apiBase,
  messageCount,
  liveUsage,
  onClick,
  compaction,
}: ContextPercentageProps) {
  const percentage = useContextPercentage({
    agentSlug,
    conversationId,
    apiBase,
    messageCount,
    liveUsage,
  });

  if (percentage === null) return null;

  const label = `Context ${percentage.toFixed(1)}% used${compaction ? ` · Compaction ${compaction.state} at ${compaction.threshold}%` : ''}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="context-meter"
      aria-label={label}
      title={label}
    >
      <span className="context-meter__track" aria-hidden="true">
        <span
          className="context-meter__fill"
          style={{
            transform: `scaleX(${Math.min(percentage, 100) / 100})`,
            background: getContextWindowColor(percentage),
          }}
        />
      </span>
      <span className="context-meter__value" aria-hidden="true">
        {Math.round(percentage)}%
      </span>
    </button>
  );
}
