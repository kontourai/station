import { useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { useRowProjectMarks } from '../../hooks/useRowProjectMarks';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { Button } from '../Button';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';
import { ErrorState, SkeletonList } from '../state';

export function RecentChatList({
  items,
  context,
  agents,
  workFacts,
  pending,
  error,
  onRetry,
  onOpen,
  onViewAll,
}: {
  items: HomeWorkItem[];
  context: string;
  agents: AgentData[];
  workFacts?: WorkFactsById;
  pending?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onOpen: (item: HomeWorkItem) => void;
  onViewAll: () => void;
}) {
  const now = useCoarseNow();
  const projectMarks = useRowProjectMarks();
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const recent = items
    .filter((item) =>
      context === '__global__'
        ? !item.projectSlug
        : item.projectSlug === context,
    )
    .filter((item) => item.chatSessionId || item.orchestrationThreadId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);
  // Nothing to continue is not a section: an empty draft shows the
  // composer alone, not a heading over a placeholder.
  if (!pending && !error && recent.length === 0) return null;
  return (
    <section className="chat-start__recent" aria-label="Continue working">
      <div className="chat-start__recent-heading">
        <h4>Continue working</h4>
        <Button variant="link" onClick={onViewAll}>
          View all
        </Button>
      </div>
      {pending && <SkeletonList count={2} label="Loading recent chats" />}
      {error && (
        <ErrorState
          variant="compact"
          title="Could not load recent chats"
          action={
            onRetry ? (
              <Button variant="link" onClick={onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      )}
      <ul>
        {recent.map((item) => (
          <li key={item.id}>
            <InboxRow
              item={item}
              isCurrent={false}
              isSnoozed={false}
              isOpenChat={false}
              now={now}
              agents={agents}
              facts={workFacts?.get(item.id)}
              chrome="touch"
              {...projectMarks(item)}
              onActivate={onOpen}
              detailsOpen={detailsFor === item.id}
              onDetailsOpenChange={(open) =>
                setDetailsFor(open ? item.id : null)
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
