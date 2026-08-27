import { useEffect } from 'react';
import { useConversationStatus } from '../../contexts/ConversationsContext';
import { useStats } from '../../contexts/StatsContext';
import { getContextWindowColor } from './utils';

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

export function ContextPercentage({
  agentSlug,
  conversationId,
  apiBase,
  messageCount,
  liveUsage,
  onClick,
}: ContextPercentageProps) {
  const { stats, refetch } = useStats(agentSlug, conversationId, apiBase, true);
  const { status } = useConversationStatus(agentSlug, conversationId);
  const percentage =
    contextPercentage(
      liveUsage?.contextTokens,
      liveUsage?.contextWindowTokens,
    ) ??
    contextPercentage(stats?.contextWindowPercentage, 100) ??
    null;
  const isActive = status !== 'idle';

  useEffect(() => {
    if (messageCount !== undefined && messageCount > 0) {
      refetch();
    }
  }, [messageCount, refetch]);

  if (percentage === null) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="context-indicator"
      style={{
        pointerEvents: onClick ? 'auto' : 'none',
        cursor: onClick ? 'pointer' : 'default',
        background: 'rgba(var(--accent-primary-rgb, 0, 102, 204), 0.08)',
        transition: 'background 0.2s',
        border: 'none',
        width: '100%',
        padding: 0,
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.background =
            'rgba(var(--accent-primary-rgb, 0, 102, 204), 0.2)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background =
          'rgba(var(--accent-primary-rgb, 0, 102, 204), 0.08)';
      }}
    >
      <div className="context-indicator-content">
        <span>Context:</span>
        <div
          style={{
            flex: 1,
            maxWidth: '80px',
            height: '3px',
            background: 'var(--border-primary)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.min(percentage, 100)}%`,
              height: '100%',
              background: getContextWindowColor(percentage),
              transition: 'width 0.3s',
            }}
          />
        </div>
        <span>({(percentage ?? 0).toFixed(1)}%)</span>
        {isActive && (
          <span
            style={{
              fontSize: '8px',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          >
            ●
          </span>
        )}
      </div>
    </button>
  );
}
