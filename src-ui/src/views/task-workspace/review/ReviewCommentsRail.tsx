import {
  matchesTaskReviewFilter,
  type TaskReviewCounts,
  type TaskReviewFilter,
  type TaskReviewThreadSummary,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/Button';
import { useCoarsePointer } from '../../../hooks/useCoarsePointer';
import { ReviewSendControl } from './ReviewSendControl';
import { ReviewThreadCard } from './ReviewThreadCard';
import { copyReviewThreadsForAgent } from './review-copy';
import {
  isReviewThreadSendable,
  type ReviewThreadActions,
} from './review-types';

export type ReviewFilter = TaskReviewFilter | 'all';
type RailThread = TaskReviewThreadView | TaskReviewThreadSummary;
export function ReviewCommentsRail({
  threads,
  counts,
  filter: controlledFilter,
  artifactKey,
  onFilterChange,
  renderThread,
  ...actions
}: ReviewThreadActions & {
  threads: readonly RailThread[];
  counts: TaskReviewCounts;
  filter?: ReviewFilter;
  artifactKey: string;
  onFilterChange?: (filter: ReviewFilter) => void;
  renderThread?: (thread: RailThread) => ReactNode;
}) {
  const coarse = useCoarsePointer();
  const [filters, setFilters] = useState<Record<string, ReviewFilter>>({});
  const filter = controlledFilter ?? filters[artifactKey] ?? 'open';
  const visible = threads.filter(
    (thread) =>
      thread.state === 'unavailable' ||
      filter === 'all' ||
      matchesTaskReviewFilter(thread, filter),
  );
  const sendableIds = visible
    .filter(
      (thread) =>
        thread.state !== 'unavailable' && isReviewThreadSendable(thread),
    )
    .map((thread) => thread.threadId);
  const copyForAgent = async (ids: readonly string[]) => {
    if (actions.onCopyForAgent) return actions.onCopyForAgent(ids);
    await copyReviewThreadsForAgent(
      threads.filter(
        (thread): thread is TaskReviewThreadView =>
          'events' in thread && ids.includes(thread.threadId),
      ),
    );
  };
  return (
    <aside
      className="review-rail"
      aria-label="Review comments"
      data-coarse-pointer={coarse || undefined}
    >
      <header>
        <div className="review-rail__controls">
          <fieldset className="review-filters" aria-label="Thread state">
            {(['open', 'outdated', 'resolved', 'all'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilters((previous) => ({
                    ...previous,
                    [artifactKey]: value,
                  }));
                  onFilterChange?.(value);
                }}
              >
                {
                  {
                    open: 'Open',
                    outdated: 'Outdated',
                    resolved: 'Resolved',
                    all: 'All',
                  }[value]
                }{' '}
                {(value === 'all'
                  ? counts.open + counts.outdated + counts.resolved
                  : counts[value]) > 0 && (
                  <span className="review-count">
                    {value === 'all'
                      ? counts.open + counts.outdated + counts.resolved
                      : counts[value]}
                  </span>
                )}
              </Button>
            ))}
          </fieldset>
          <ReviewSendControl
            ids={sendableIds}
            {...actions}
            onCopyForAgent={copyForAgent}
          />
        </div>
      </header>
      <div className="review-rail__threads">
        {threads.map((thread) => (
          <div key={thread.threadId} hidden={!visible.includes(thread)}>
            {renderThread ? (
              renderThread(thread)
            ) : 'events' in thread ? (
              <ReviewThreadCard
                thread={thread}
                {...actions}
                onCopyForAgent={copyForAgent}
              />
            ) : (
              <p role="status">Thread {thread.ordinal} is unavailable.</p>
            )}
          </div>
        ))}
        {visible.length === 0 && (
          <p className="review-empty">
            {filter === 'all' ? 'No comments yet' : `No ${filter} threads`}
          </p>
        )}
      </div>
      <footer className="review-hotkeys">
        <span>
          <kbd>C</kbd> Comment
        </span>
        <span>
          <kbd>⌥C</kbd> Send
        </span>
        <span>
          <kbd>J/K</kbd> Threads
        </span>
      </footer>
    </aside>
  );
}
