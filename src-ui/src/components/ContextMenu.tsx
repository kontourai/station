import { Fragment, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextMenuPoint } from '../hooks/useContextMenuGesture';
import { useMenuFocus } from '../hooks/useMenuFocus';
import './header/HeaderMenu.css';
// The separator and danger-row rules are the overflow menu's; same family.
import './ActionOverflowMenu.css';
import './ContextMenu.css';

export interface ContextMenuAction {
  key: string;
  label: string;
  tone?: 'danger';
  onSelect: () => void;
}

/** Keeps the menu's edge this far inside the viewport. */
const VIEWPORT_GUTTER_PX = 8;

/**
 * Where a menu opened from `item` goes: the gesture's point when it had one,
 * otherwise (the keyboard's context-menu key) just under the item's start.
 */
export function contextMenuAnchor(
  item: HTMLElement,
  point: ContextMenuPoint | null,
): ContextMenuPoint {
  if (point) return point;
  const rect = item.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/**
 * A menu opened AT A POINT — a right-click or a hold on something that has no
 * `⋯` of its own (a file in the tree, a link). An item that does have a `⋯`
 * opens that instead (`ActionOverflowMenu`'s `handleRef`), so the two never
 * show different rows for one thing.
 *
 * The panel and rows are the menu family's (`.menu-surface`, `.menu-row`), the
 * backdrop is the portalled menus' click-away button, and focus enters and
 * returns through `useMenuFocus`. Only placement is its own: at the point,
 * pulled back inside the viewport once it has a measured size.
 */
export function ContextMenu({
  at,
  label,
  actions,
  onClose,
}: {
  at: ContextMenuPoint;
  /** The menu's accessible name ("Actions for app.ts"). */
  label: string;
  actions: readonly ContextMenuAction[];
  onClose: () => void;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  const [position, setPosition] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const box = menuRef.current?.getBoundingClientRect();
    // jsdom lays nothing out; keep the point rather than "correct" from 0x0.
    if (!box || (box.width === 0 && box.height === 0)) {
      setPosition({ left: at.x, top: at.y });
      return;
    }
    const maxLeft = window.innerWidth - VIEWPORT_GUTTER_PX - box.width;
    const maxTop = window.innerHeight - VIEWPORT_GUTTER_PX - box.height;
    setPosition({
      left: Math.max(VIEWPORT_GUTTER_PX, Math.min(at.x, maxLeft)),
      // Flip above the point when there is no room below it, as a native
      // menu does, rather than sliding up over the thing clicked.
      top:
        at.y <= maxTop ? at.y : Math.max(VIEWPORT_GUTTER_PX, at.y - box.height),
    });
  }, [at.x, at.y, menuRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const safe = actions.filter((action) => action.tone !== 'danger');
  const ordered = [
    ...safe,
    ...actions.filter((action) => action.tone === 'danger'),
  ];

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        className="header-menu__dismiss-backdrop context-menu__backdrop"
        aria-label="Close menu"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        // A second right-click away from the menu closes it, as a native
        // menu does, instead of reaching the app-wide guard.
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="menu-surface context-menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={position}
      >
        {ordered.map((action, index) => (
          <Fragment key={action.key}>
            {action.tone === 'danger' &&
              index === safe.length &&
              safe.length > 0 && <hr className="action-overflow__separator" />}
            <button
              type="button"
              role="menuitem"
              className={`menu-row${action.tone === 'danger' ? ' action-overflow__row--danger' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          </Fragment>
        ))}
      </div>
    </>,
    document.body,
  );
}
