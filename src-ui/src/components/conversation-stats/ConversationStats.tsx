import { useEffect } from 'react';
import { useStats } from '../../contexts/StatsContext';
import { LazyBoundary } from '../LazyBoundary';

// The stats panel is opened from a toolbar toggle and closed most of the time,
// so its body loads on first open rather than riding the first-paint bundle.
/**
 * The server writes conversation stats from a turn-end hook, several awaits
 * after the transcript row the client counts, so the two are unordered: a
 * refresh driven by message count alone can land before the write and leave
 * the previous turn's tokens on screen until the next message. The query owns
 * this poll, which is why it is not a second `setInterval` beside it — it is
 * inert while the panel is closed (`enabled: isVisible`) and paused while the
 * tab is hidden (React Query's `refetchIntervalInBackground` default).
 */
const STATS_REFRESH_MS = 2_000;

const loadConversationStatsModal = () =>
  import('./ConversationStatsModal').then((m) => ({
    default: m.ConversationStatsModal,
  }));

interface ConversationStatsProps {
  agentSlug: string;
  conversationId: string;
  apiBase: string;
  isVisible: boolean;
  onToggle: () => void;
  messageCount?: number;
}

export function ConversationStats({
  agentSlug,
  conversationId,
  apiBase,
  isVisible,
  onToggle,
  messageCount,
}: ConversationStatsProps) {
  // Same defect shape as SHELL-09's SkillsView: `useStats` already derives a
  // loading flag and this discarded it for a hardcoded `false`, so the modal's
  // own `isLoading ? <Loading> : <stats>` branch could never take its loading
  // arm and rendered zeroed stats as settled fact.
  const {
    stats,
    error,
    refetch,
    loading: isLoading,
  } = useStats(agentSlug, conversationId, apiBase, isVisible, STATS_REFRESH_MS);

  // The message count is the trigger that reflects the conversation; the poll
  // above is what covers the window in which the server has not written the
  // turn's stats yet. Both are refreshes of one query, not two caches.
  useEffect(() => {
    if (messageCount !== undefined && messageCount > 0) {
      refetch();
    }
  }, [messageCount, refetch]);

  useEffect(() => {
    if (!isVisible) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onToggle();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isVisible, onToggle]);

  if (!isVisible) return null;

  return (
    <LazyBoundary
      load={loadConversationStatsModal}
      componentProps={{
        isVisible,
        isLoading,
        stats,
        error,
        onRetry: () => void refetch(),
        onToggle,
      }}
      pending={null}
    />
  );
}

export { ContextPercentage } from './ContextPercentage';
