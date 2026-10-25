import {
  matchesTaskReviewFilter,
  type TaskReviewCounts,
  type TaskReviewFilter,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { ResponsiveSurfaceActions } from '../../../components/ResponsiveDialogSurface';
import { ReviewSendControl } from './ReviewSendControl';
import { ReviewThreadCard } from './ReviewThreadCard';
import { copyReviewThreadsForAgent } from './review-copy';
import type { ReviewThreadActions } from './review-types';

export type ReviewFilter = TaskReviewFilter | 'all';
export function ReviewCommentsRail({
  threads,
  counts,
  filter: controlledFilter,
  artifactKey,
  onFilterChange,
  selectedThreadIds,
  onSelectionChange,
  ...actions
}: ReviewThreadActions & {
  threads: readonly TaskReviewThreadView[];
  counts: TaskReviewCounts;
  filter?: ReviewFilter;
  artifactKey: string;
  onFilterChange?: (filter: ReviewFilter) => void;
  selectedThreadIds: readonly string[];
  onSelectionChange: (threadIds: readonly string[]) => void;
}) {
  const [filters, setFilters] = useState<Record<string, ReviewFilter>>({});
  const filter = controlledFilter ?? filters[artifactKey] ?? 'open';
  const sendableIds = threads
    .filter(
      (thread) =>
        (thread.baseState === 'open' || thread.baseState === 'agent-replied') &&
        matchesTaskReviewFilter(thread, 'open') &&
        selectedThreadIds.includes(thread.threadId),
    )
    .map((thread) => thread.threadId);
  const visible = threads.filter(
    (thread) => filter === 'all' || matchesTaskReviewFilter(thread, filter),
  );
  const copyForAgent = async (ids: readonly string[]) => {
    if (actions.onCopyForAgent) return actions.onCopyForAgent(ids);
    await copyReviewThreadsForAgent(
      threads.filter((thread) => ids.includes(thread.threadId)),
    );
  };
  return (
    <aside className="review-rail" aria-label="Review comments">
      <header>
        <ResponsiveSurfaceActions className="review-rail__controls">
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
                <span className="review-count">
                  {value === 'all'
                    ? counts.open + counts.outdated + counts.resolved
                    : counts[value]}
                </span>
              </Button>
            ))}
          </fieldset>
          <ReviewSendControl
            ids={sendableIds}
            {...actions}
            onCopyForAgent={copyForAgent}
            bulk
          />
        </ResponsiveSurfaceActions>
      </header>
      <div className="review-rail__threads">
        {threads.map((thread) => (
          <div key={thread.threadId} hidden={!visible.includes(thread)}>
            <ReviewThreadCard
              thread={thread}
              selected={selectedThreadIds.includes(thread.threadId)}
              onSelect={(selected) =>
                onSelectionChange(
                  selected
                    ? [...new Set([...selectedThreadIds, thread.threadId])]
                    : selectedThreadIds.filter((id) => id !== thread.threadId),
                )
              }
              {...actions}
              onCopyForAgent={copyForAgent}
            />
          </div>
        ))}
        {visible.length === 0 && (
          <p className="review-empty">
            {filter === 'all' ? 'No comments yet' : `No ${filter} threads`}
          </p>
        )}
      </div>
    </aside>
  );
}
