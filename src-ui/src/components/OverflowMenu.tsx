import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../hooks/useMenuFocus';
import { Button } from './Button';
import { CheckGlyph, MoreGlyph } from './icons/Glyph';
// The dismiss backdrop's button reset, shared with every portalled menu.
import './header/HeaderMenu.css';
import './OverflowMenu.css';

export interface OverflowMenuItem {
  key: string;
  label: string;
  /** Present for a toggle row (menuitemcheckbox); absent for a command. */
  checked?: boolean;
  /** A shortcut hint shown at the row's end, e.g. "⌘G". */
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

const MENU_GAP_PX = 6;
const MENU_ROW_PX = 32;
const MENU_PADDING_PX = 12;

/**
 * An icon ⋯ trigger that folds a surface's secondary commands into a menu.
 * The rows are `.menu-row`, so they take the shared coarse-pointer 44px floor
 * every Station menu has; the trigger is the shared icon Button. Portalled
 * and fixed-positioned from the trigger's own rect, opening upward when there
 * is no room below.
 */
export function OverflowMenu({
  label,
  items,
  className,
}: {
  /** The trigger's and the menu's accessible name, e.g. "More file actions". */
  label: string;
  items: readonly OverflowMenuItem[];
  className?: string;
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

  return (
    <>
      <Button
        ref={triggerRef}
        variant="icon"
        className={className}
        active={open}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const needed =
            items.length * MENU_ROW_PX + MENU_PADDING_PX + MENU_GAP_PX;
          setPosition(
            window.innerHeight - rect.bottom < needed
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
        <MoreGlyph />
      </Button>
      {open
        ? createPortal(
            <>
              <button
                type="button"
                tabIndex={-1}
                className="header-menu__dismiss-backdrop overflow-menu__backdrop"
                aria-label={`Close ${label.toLowerCase()}`}
                onClick={() => setOpen(false)}
              />
              <div
                ref={menuRef}
                className="menu-surface overflow-menu"
                role="menu"
                aria-label={label}
                tabIndex={-1}
                style={{ position: 'fixed', ...position }}
              >
                {items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="menu-row"
                    disabled={item.disabled}
                    {...(item.checked === undefined
                      ? { role: 'menuitem' as const }
                      : {
                          role: 'menuitemcheckbox' as const,
                          'aria-checked': item.checked,
                        })}
                    {...(item.shortcut
                      ? { 'aria-keyshortcuts': ariaShortcut(item.shortcut) }
                      : {})}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    <span className="menu-row__glyph" aria-hidden="true">
                      {item.checked ? <CheckGlyph /> : null}
                    </span>
                    {item.label}
                    {item.shortcut ? (
                      <span
                        className="overflow-menu__shortcut"
                        aria-hidden="true"
                      >
                        {item.shortcut}
                      </span>
                    ) : null}
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

/** "⌘G" → "Meta+G"; "Ctrl+G" stays. */
function ariaShortcut(shortcut: string): string {
  return shortcut.replace('⌘', 'Meta+');
}
