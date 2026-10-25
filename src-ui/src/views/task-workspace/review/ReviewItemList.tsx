import type {
  TaskReviewArtifactKind,
  TaskReviewItem,
} from '@kontourai/station-contracts/task-review';
import { Button } from '../../../components/Button';
import {
  CameraGlyph,
  DocumentGlyph,
  InboxGlyph,
  MessageGlyph,
} from '../../../components/icons/Glyph';

const groups = [
  { kind: 'plan', label: 'Plan', Icon: DocumentGlyph },
  { kind: 'summary', label: 'Brief', Icon: DocumentGlyph },
  { kind: 'output', label: 'Outputs', Icon: InboxGlyph },
  { kind: 'answer', label: 'Answers', Icon: MessageGlyph },
  { kind: 'capture', label: 'Screens', Icon: CameraGlyph },
] satisfies {
  kind: TaskReviewArtifactKind;
  label: string;
  Icon: typeof DocumentGlyph;
}[];

export function ReviewItemList({
  items,
  selectedItemId,
  selectedKind,
  onSelectItem,
  captureSrc,
}: {
  items: readonly TaskReviewItem[];
  selectedItemId?: string;
  selectedKind?: TaskReviewArtifactKind;
  onSelectItem: (item: TaskReviewItem) => void;
  captureSrc?: (captureId: string) => string | undefined;
}) {
  return (
    <nav className="review-items" aria-label="Review items">
      {items.map((item) => {
        const { Icon } = groups.find((group) => group.kind === item.kind)!;
        const count =
          item.counts.open + item.counts.outdated + item.counts.resolved;
        return (
          <Button
            key={`${item.kind}:${item.id}`}
            aria-label={`${item.label}, ${count} threads`}
            size="sm"
            variant="ghost"
            className="review-items__item"
            active={item.id === selectedItemId && item.kind === selectedKind}
            aria-current={
              item.id === selectedItemId && item.kind === selectedKind
                ? 'true'
                : undefined
            }
            disabled={item.status === 'unavailable'}
            onClick={() => onSelectItem(item)}
          >
            {item.kind === 'capture' && captureSrc?.(item.id) ? (
              <img
                className="review-items__thumbnail"
                src={captureSrc(item.id)}
                alt=""
              />
            ) : (
              <Icon />
            )}
            <span>{item.label}</span>
            <span className="review-count" title={`${count} threads`}>
              {count}
            </span>
          </Button>
        );
      })}
    </nav>
  );
}
