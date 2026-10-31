import { useEffect } from 'react';
import type { ChatLiveUsage } from '../../contexts/active-chats-state';
import { useStats } from '../../contexts/StatsContext';
import { Button } from '../Button';
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
 * Context usage beside Send. The ring contains the rounded percentage;
 * its tooltip names the exact share and activation opens conversation stats.
 */
export function ContextPercentage({
  agentSlug,
  conversationId,
  apiBase,
  messageCount,
  liveUsage,
  onClick,
}: ContextPercentageProps) {
  const percentage = useContextPercentage({
    agentSlug,
    conversationId,
    apiBase,
    messageCount,
    liveUsage,
  });

  if (percentage === null) return null;

  const label = `Context ${percentage.toFixed(1)}% used`;
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={!onClick}
      className="context-meter"
      aria-label={label}
      title={label}
    >
      <svg
        className="context-meter__ring"
        viewBox="0 0 40 40"
        aria-hidden="true"
      >
        <circle className="context-meter__track" cx="20" cy="20" r="17" />
        <circle
          className="context-meter__fill"
          cx="20"
          cy="20"
          r="17"
          pathLength="100"
          strokeDasharray={`${Math.min(percentage, 100)} 100`}
          style={{ stroke: getContextWindowColor(percentage) }}
        />
      </svg>
      <span className="context-meter__value" aria-hidden="true">
        {Math.round(percentage)}%
      </span>
    </Button>
  );
}
