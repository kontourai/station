import { type ReactNode, useId } from 'react';
import './people.css';

/**
 * One person in a `PersonList`: their name, an optional identity badge, a
 * meta line, and the controls that act on them, with an optional body that
 * opens beneath.
 *
 * With `onToggle` the name and meta are a native toggle button (Enter and
 * Space are the platform's) carrying `aria-expanded` and, while open,
 * `aria-controls`. The `actions` are siblings of that button, never nested
 * in it: a control inside the button would be invalid and its clicks would
 * toggle the row. A `pinned` row stays open and refuses to close, because
 * collapsing would unmount work the reader has not finished.
 */
export function PersonRow({
  principalId,
  name,
  badge,
  meta,
  actions,
  status,
  body,
  open: wantsOpen = false,
  onToggle,
  pinned = false,
  pinnedReason,
  className,
}: {
  principalId: string;
  name: string;
  /** Inline after the name, for how this person is identified. */
  badge?: ReactNode;
  meta: ReactNode;
  /** Controls on the row's line, outside the toggle. */
  actions?: ReactNode;
  /** Always shown beneath the row's line: errors and notices about the row. */
  status?: ReactNode;
  /** Shown while open. Needs `onToggle` to ever open. */
  body?: ReactNode;
  /** What the reader (or a default) asked for. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Keeps the row open and refuses the toggle, saying `pinnedReason`. */
  pinned?: boolean;
  pinnedReason?: string;
  className?: string;
}) {
  const id = useId();
  const expandable = onToggle !== undefined;
  const open = expandable && (wantsOpen || pinned);
  const nameNode = (
    <span className="person-row__name" title={name}>
      {name}
    </span>
  );
  const nameLine = badge ? (
    <span className="person-row__name-line">
      {nameNode}
      {badge}
    </span>
  ) : (
    nameNode
  );
  const text = (
    <>
      {nameLine}
      <span className="person-row__meta">{meta}</span>
    </>
  );
  return (
    <li
      className={['person-row', open ? 'person-row--open' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      data-principal-id={principalId}
    >
      <div className="person-row__header">
        {expandable ? (
          <button
            type="button"
            className="person-row__toggle"
            aria-expanded={open}
            aria-controls={open ? `${id}-body` : undefined}
            aria-disabled={pinned || undefined}
            title={pinned ? pinnedReason : undefined}
            onClick={() => {
              if (!pinned) onToggle(!open);
            }}
          >
            <span className="person-row__chevron" aria-hidden="true">
              ▸
            </span>
            <span className="person-row__text">{text}</span>
          </button>
        ) : (
          <div className="person-row__static">
            <span className="person-row__text">{text}</span>
          </div>
        )}
        {actions}
      </div>
      {status}
      {open && (
        <div className="person-row__body" id={`${id}-body`}>
          {body}
        </div>
      )}
    </li>
  );
}
