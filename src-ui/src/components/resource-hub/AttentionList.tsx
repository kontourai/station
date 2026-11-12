import { Button } from '../Button';
import { Empty } from '../state';
import { ResourceStatusBadge } from './ResourceStatusBadge';
import type { ResourceStatus } from './resource-status';
import './resource-hub.css';

export interface AttentionItem {
  id: string;
  title: string;
  /** Label and tone only: `sentence` says why, once. */
  status: Pick<ResourceStatus, 'label' | 'tone'>;
  sentence: string;
  action?: { label: string; onSelect: () => void };
}

/**
 * Resources the reader can fix: each one's status badge, one sentence and
 * at most one action. Presentation only — the feature decides what needs
 * attention and what its action does.
 */
export function AttentionList({
  label,
  items,
  emptyLabel,
}: {
  /** The list's accessible name. */
  label: string;
  items: readonly AttentionItem[];
  /** Shown instead of the list when nothing needs attention. */
  emptyLabel: string;
}) {
  if (!items.length) return <Empty variant="compact" label={emptyLabel} />;
  return (
    <ul className="attention-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="attention-list__item">
          <div className="attention-list__heading">
            <strong>{item.title}</strong>
            <ResourceStatusBadge status={item.status} />
          </div>
          <p>{item.sentence}</p>
          {item.action ? (
            <Button
              aria-label={`${item.action.label}: ${item.title}`}
              onClick={item.action.onSelect}
            >
              {item.action.label}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
