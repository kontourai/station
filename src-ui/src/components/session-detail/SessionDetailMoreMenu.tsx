import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import '../header/HeaderMenu.css';

export interface SessionDetailMenuAction {
  key: string;
  label: string;
  onSelect: () => void;
}

const MENU_GAP_PX = 6;
/** `.menu-row`'s fine-pointer height and `.menu-surface`'s block padding. */
const MENU_ROW_PX = 32;
const MENU_PADDING_PX = 12;

/**
 * The session detail header's secondary commands (Copy session ID, and for a
 * delegated task, Delegate subtask). Same primitives as the dock's More menu —
 * `.menu-surface` / `.menu-row`, `useMenuFocus` for focus entry, roving arrow
 * keys and return focus, and a portalled fixed box placed from the trigger's
 * own rect so the detail's scroll region cannot clip it.
 */
export function SessionDetailMoreMenu({
  actions,
  label = 'More session actions',
}: {
  actions: readonly SessionDetailMenuAction[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useMenuFocus<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="button button--secondary session-detail-more__trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom;
          const needed =
            actions.length * MENU_ROW_PX + MENU_PADDING_PX + MENU_GAP_PX;
          setPosition(
            below < needed
              ? {
                  bottom: `${window.innerHeight - rect.top + MENU_GAP_PX}px`,
                  right: `${Math.max(0, window.innerWidth - rect.right)}px`,
                }
              : {
                  top: `${rect.bottom + MENU_GAP_PX}px`,
                  right: `${Math.max(0, window.innerWidth - rect.right)}px`,
                },
          );
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open
        ? createPortal(
            <>
              <button
                type="button"
                tabIndex={-1}
                className="header-menu__dismiss-backdrop session-detail-more__backdrop"
                aria-label={`Close ${label.toLowerCase()}`}
                onClick={() => setOpen(false)}
              />
              <div
                ref={menuRef}
                className="menu-surface session-detail-more__menu"
                role="menu"
                aria-label={label}
                tabIndex={-1}
                style={{ position: 'fixed', ...position }}
              >
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    className="menu-row"
                    onClick={() => {
                      setOpen(false);
                      triggerRef.current?.focus();
                      action.onSelect();
                    }}
                  >
                    <span className="menu-row__glyph" aria-hidden="true" />
                    {action.label}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
