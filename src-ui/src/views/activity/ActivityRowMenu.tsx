import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFixedMenuPlacement } from '../../hooks/useFixedMenuPlacement';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMenuTriggerToggle } from '../../hooks/useMenuTriggerToggle';
import './ActivityRowMenu.css';

export interface ActivityRowAction {
  id: string;
  label: string;
  /** Runs after the menu closes, so a dialog it opens owns focus cleanly. */
  onSelect: (trigger: HTMLButtonElement | null) => void;
  tone?: 'danger';
}

/** Twin of `.activity-row-menu__panel`'s `min-width`. */
const MENU_MIN_WIDTH_PX = 200;
const MENU_ROW_PX = 44;

/**
 * The Activity row's ONE trailing control: a "⋯" that opens a `role="menu"`
 * of the row's actions. The same primitives as `TurnActionsMenu` —
 * `useMenuFocus` (initial focus, arrow/Home/End roving, dismissal on focus
 * leaving, return focus) and `useMenuTriggerToggle` (the trigger can close
 * what it opened, #2081) — portalled to the document with a fixed box so the
 * list pane's scroll container cannot clip it.
 */
export function ActivityRowMenu({
  itemTitle,
  actions,
}: {
  itemTitle: string;
  actions: readonly ActivityRowAction[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const describedById = useId();
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);

  const { position, place } = useFixedMenuPlacement(triggerRef, open, {
    preferredSide: 'below',
    minWidthPx: MENU_MIN_WIDTH_PX,
    rowPx: MENU_ROW_PX,
    rowCount: actions.length,
  });

  const triggerProps = useMenuTriggerToggle(
    open,
    () => {
      place();
      setOpen(true);
    },
    close,
  );

  if (actions.length === 0) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="activity-row-menu__trigger"
        // A short name, with the row's title as its DESCRIPTION: the trigger
        // directly follows its row, and a name repeating the title would
        // compete with the row button itself for the same words.
        aria-label="More actions"
        aria-describedby={describedById}
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <span id={describedById} hidden>
        {itemTitle}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu-surface activity-row-menu__panel"
            style={position}
            role="menu"
            aria-label={`Actions for ${itemTitle}`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          >
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className={`menu-row${action.tone === 'danger' ? ' activity-row-menu__item--danger' : ''}`}
                onClick={() => {
                  const trigger = triggerRef.current;
                  close();
                  action.onSelect(trigger);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
