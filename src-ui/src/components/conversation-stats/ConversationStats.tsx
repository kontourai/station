import { useEffect } from 'react';
import { useStats } from '../../contexts/StatsContext';
import { LazyBoundary } from '../LazyBoundary';

// The stats panel is opened from a toolbar toggle and closed most of the time,
// so its body loads on first open rather than riding the first-paint bundle.
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
  } = useStats(agentSlug, conversationId, apiBase, isVisible);

  // One refresh trigger, not two. The transcript's message count is what
  // actually moves these numbers, and it already drives a refetch; the
  // two-second interval that sat beside it re-read the same endpoint on a
  // schedule nothing in the conversation was tied to.
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
