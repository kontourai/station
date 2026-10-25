import type {
  TaskReviewArtifactRef,
  TaskReviewCurrentArtifact,
  TaskReviewFilter,
  TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { Button } from '../../../components/Button';
import { OutboxGlyph } from '../../../components/icons/Glyph';
import { ReviewThreadCard } from './ReviewThreadCard';
import { type ReviewThreadActions, reviewThreadState } from './review-state';

export function ReviewCommentsRail({
  threads,
  currentArtifact,
  filter,
  onFilterChange,
  selectedThreadIds,
  onSelectionChange,
  onSend,
  sending = false,
  ...actions
}: ReviewThreadActions & {
  threads: readonly TaskReviewThreadView[];
  currentArtifact: (
    artifact: TaskReviewArtifactRef,
  ) => TaskReviewCurrentArtifact;
  filter: TaskReviewFilter;
  onFilterChange: (filter: TaskReviewFilter) => void;
  selectedThreadIds: readonly string[];
  onSelectionChange: (threadIds: readonly string[]) => void;
  onSend: (threadIds: readonly string[]) => void;
  sending?: boolean;
}) {
  const rows = threads.map((thread) => {
    const current = currentArtifact(thread.artifact);
    return { thread, current, ...reviewThreadState(thread, current) };
  });
  const counts = { open: 0, outdated: 0, resolved: 0 };
  for (const row of rows) counts[row.filter]++;
  const sendableIds = rows
    .filter(
      (row) =>
        row.base === 'open' &&
        row.filter === 'open' &&
        selectedThreadIds.includes(row.thread.threadId),
    )
    .map((row) => row.thread.threadId);

  return (
    <aside className="review-rail" aria-label="Review comments">
      <header className="review-rail__toolbar">
        <fieldset className="review-filters" aria-label="Thread state">
          {(['open', 'outdated', 'resolved'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant="ghost"
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              {
                { open: 'Open', outdated: 'Outdated', resolved: 'Resolved' }[
                  value
                ]
              }{' '}
              {counts[value]}
            </Button>
          ))}
        </fieldset>
        <Button
          size="sm"
          variant="primary"
          disabled={sendableIds.length === 0}
          pending={sending}
          onClick={() => onSend(sendableIds)}
        >
          <OutboxGlyph />
          Send {sendableIds.length}
        </Button>
      </header>
      <div className="review-rail__threads">
        {rows.map((row) => (
          <div key={row.thread.threadId} hidden={row.filter !== filter}>
            <ReviewThreadCard
              thread={row.thread}
              current={row.current}
              selected={selectedThreadIds.includes(row.thread.threadId)}
              onSelect={(selected) =>
                onSelectionChange(
                  selected
                    ? [...new Set([...selectedThreadIds, row.thread.threadId])]
                    : selectedThreadIds.filter(
                        (id) => id !== row.thread.threadId,
                      ),
                )
              }
              {...actions}
            />
          </div>
        ))}
        {counts[filter] === 0 && (
          <p className="review-empty">No {filter} threads</p>
        )}
      </div>
    </aside>
  );
}
