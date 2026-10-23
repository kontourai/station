import { useEffect } from 'react';
import { useStats } from '../../contexts/StatsContext';
import { getContextWindowColor } from './utils';
import './ContextPercentage.css';

interface ContextPercentageProps {
  agentSlug: string;
  conversationId: string;
  apiBase: string;
  messageCount?: number;
  /** A current provider observation can update the meter before refetch. */
  liveUsage?: {
    contextTokens?: number;
    contextWindowTokens?: number;
  };
  onClick?: () => void;
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
}: ContextPercentageProps) {
  const { stats, refetch } = useStats(agentSlug, conversationId, apiBase, true);
  const percentage =
    contextPercentage(
      liveUsage?.contextTokens,
      liveUsage?.contextWindowTokens,
    ) ??
    contextPercentage(stats?.contextWindowPercentage, 100) ??
    null;

  useEffect(() => {
    if (messageCount !== undefined && messageCount > 0) {
      refetch();
    }
  }, [messageCount, refetch]);

  if (percentage === null) return null;

  const label = `Context ${percentage.toFixed(1)}% used`;
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
