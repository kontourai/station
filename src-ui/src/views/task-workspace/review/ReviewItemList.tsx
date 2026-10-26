import type {
  TaskReviewArtifactKind,
  TaskReviewItem,
} from '@kontourai/station-contracts/task-review';
import { Fragment, type ReactNode } from 'react';
import { Button } from '../../../components/Button';
import {
  CameraGlyph,
  DocumentGlyph,
  InboxGlyph,
  MessageGlyph,
} from '../../../components/icons/Glyph';
import { useReviewContext } from './ReviewContext';
import { sameReviewArtifact } from './review-types';

const icons: Record<TaskReviewArtifactKind, typeof DocumentGlyph> = {
  plan: DocumentGlyph,
  summary: DocumentGlyph,
  output: InboxGlyph,
  answer: MessageGlyph,
  capture: CameraGlyph,
};

export function ReviewItemList({
  items,
  selectedItemId,
  selectedKind,
  onSelectItem,
  captureAction,
}: {
  items: readonly TaskReviewItem[];
  captureAction?: ReactNode;
  selectedItemId?: string;
  selectedKind?: TaskReviewArtifactKind;
  onSelectItem: (item: TaskReviewItem) => void;
}) {
  const review = useReviewContext();
  return (
    <nav className="review-items" aria-label="Review items">
      {items
        .filter((item) => item.kind !== 'capture')
        .map((item) => {
          const Icon = icons[item.kind];
          const count = item.counts.open;
          const selected =
            item.id === selectedItemId && item.kind === selectedKind;
          const outline =
            selected &&
            item.status === 'available' &&
            review?.outline &&
            sameReviewArtifact(review.outline.artifact, item.artifact)
              ? review.outline.headings
              : [];
          return (
            <Fragment key={`${item.kind}:${item.id}`}>
              <Button
                aria-label={`${item.label}${count > 0 ? `, ${count} open threads` : ''}`}
                size="sm"
                variant="ghost"
                className="review-items__item"
                aria-current={
                  item.id === selectedItemId && item.kind === selectedKind
                    ? 'true'
                    : undefined
                }
                title={
                  item.status === 'unavailable' && item.kind === 'summary'
                    ? 'No Brief yet. The agent can record a Task summary.'
                    : undefined
                }
                disabled={item.status === 'unavailable'}
                onClick={() => onSelectItem(item)}
              >
                <Icon />
                <span>{item.label}</span>
                {count > 0 && <span className="review-count">{count}</span>}
              </Button>
              {outline.length > 0 && (
                <nav className="review-outline" aria-label="Document outline">
                  {outline.map((heading) => (
                    <Button
                      key={heading.id}
                      size="sm"
                      variant="ghost"
                      aria-label={`${heading.label}${heading.count > 0 ? `, ${heading.count} open threads` : ''}`}
                      onClick={() => {
                        const node = document.getElementById(heading.id);
                        node?.scrollIntoView?.({ block: 'start' });
                        node?.setAttribute('tabindex', '-1');
                        node?.focus();
                      }}
                    >
                      <span>{heading.label}</span>
                      {heading.count > 0 && (
                        <span className="review-count">{heading.count}</span>
                      )}
                    </Button>
                  ))}
                </nav>
              )}
            </Fragment>
          );
        })}
      <div className="review-items__screens">
        <span>Screens</span>
        {captureAction}
      </div>
      {items
        .filter((item) => item.kind === 'capture')
        .map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant="ghost"
            className="review-items__item"
            aria-current={
              item.id === selectedItemId && selectedKind === 'capture'
                ? 'true'
                : undefined
            }
            onClick={() => onSelectItem(item)}
          >
            <CameraGlyph />
            <span>{item.label}</span>
            {item.counts.open > 0 && (
              <span className="review-count">{item.counts.open}</span>
            )}
          </Button>
        ))}
    </nav>
  );
}
