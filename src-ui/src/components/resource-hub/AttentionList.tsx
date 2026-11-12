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
  /**
   * The resource's own page. Its title links there, so an item with no fix
   * to name is never a dead end.
   */
  open?: { href: string; onOpen: () => void };
  action?: { label: string; onSelect: () => void };
}

/**
 * Resources the reader can fix: each one's title (a link to its page),
 * status badge, one sentence and at most one action. Presentation only — the feature decides what needs
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
            {item.open ? (
              <a
                className="attention-list__title"
                href={item.open.href}
                onClick={(event) => {
                  // A modified click keeps the browser's own behaviour.
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  item.open!.onOpen();
                }}
              >
                <strong>{item.title}</strong>
              </a>
            ) : (
              <strong>{item.title}</strong>
            )}
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
