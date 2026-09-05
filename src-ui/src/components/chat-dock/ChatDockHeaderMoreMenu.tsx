import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
// The dismiss backdrop's button reset lives with the header's portalled menus,
// which is the same shape this one is: a full-viewport hit target that must not
// inherit the global button chrome.
import '../header/HeaderMenu.css';

/**
 * One row of the dock header's More menu.
 *
 * `onSelect` is handed the MENU'S TRIGGER, not the row: a row that opens an
 * anchored surface (the Background tasks sheet, the session inventory) needs an
 * element that survives the menu closing, and the trigger is the only one in
 * this subtree that does. It is also where `SessionInventoryHost` stamps its
 * `focusFullBasis` handle, so a second activation reaches the same host rather
 * than opening a second one.
 */
export interface DockMoreAction {
  key: string;
  label: string;
  /** Present for a toggle row; absent for a one-shot command. */
  checked?: boolean;
  /** For a row that opens a surface of its own. */
  haspopup?: 'dialog';
  expanded?: boolean;
  /**
   * A row whose command cannot be carried out yet — the session inventory
   * before its lazily loaded host has registered. Refusing is the point: a row
   * that looks pressable and does nothing is worse than one that says it is not
   * ready. `disabled` (not `aria-disabled`) so roving focus skips it too, since
   * `useMenuFocus`'s focusable query excludes a disabled button.
   */
  disabled?: boolean;
  onSelect: (trigger: HTMLElement) => void;
}

const MENU_GAP_PX = 6;
/** `.dock-placement-menu__item`'s height, which every row in this menu takes. */
const MENU_ROW_PX = 32;
/** `.dock-placement-menu`'s `padding: var(--space-1)`, top and bottom. */
const MENU_PADDING_PX = 4;
/**
 * Room needed to open downward — derived from the rows this menu is actually
 * about to render, not from a constant that pins a row count some later change
 * would quietly outgrow. It does not have to equal the rendered height (which
 * is unknown before layout); it has to be right about which side has space.
 */
const roomNeededPx = (rowCount: number) =>
  rowCount * MENU_ROW_PX + MENU_PADDING_PX + MENU_GAP_PX;

/**
 * The dock header's folded secondary commands (#1536 section F).
 *
 * The bar carried thirteen controls in 40px — a chat-settings gear, a chat-list
 * toggle, Background tasks, Session inventory, Copy thread ID, a bare ⌘D keycap
 * — and with a long project path the conversation title got about one
 * character. The commands that are not the dock's primary verbs live here now.
 *
 * Fixed-positioned in a portal rather than absolutely positioned in the header,
 * which is what `.dock-placement-menu` does: this header sits at the top of a
 * bottom dock, at the top of a side dock, and in a 40px collapsed bar, so
 * neither "always above" nor "always below" is on screen in every one of them.
 * The trigger's own rect decides.
 */
export function ChatDockHeaderMoreMenu({
  actions,
  triggerRef,
  badgeCount = 0,
  badgeLabel,
}: {
  actions: readonly DockMoreAction[];
  /**
   * The caller's anchor for a surface a row opens — `ChatDock`'s
   * `backgroundTasksTriggerRef`. Adopted rather than owned so the sheet keeps
   * anchoring to the control that opened it.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * Live work behind a folded row, surfaced on the trigger. Folding Background
   * tasks into this menu took its running-count badge off the bar with it, and
   * a count that only exists inside a closed menu is not a signal: nothing on
   * screen said work was running. Zero renders nothing rather than an empty
   * "0".
   */
  badgeCount?: number;
  /** What the count means, for the trigger's accessible name. */
  badgeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useMenuFocus<HTMLDivElement>(open, () => setOpen(false));

  const setTrigger = useCallback(
    (node: HTMLButtonElement | null) => {
      ownRef.current = node;
      if (triggerRef) triggerRef.current = node;
    },
    [triggerRef],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      ownRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (actions.length === 0) return null;

  /**
   * A menu holding ONE command is a second click for nothing: press ⋯, read a
   * list of one, press again. Derived from the row count rather than from a
   * guess about which state produces it — a collapsed dock with no chat open is
   * the live case (Chat settings is the only row that does not need a pane), but
   * any future single-row arrangement gets the same treatment.
   *
   * The row's own label, not a glyph: this control appears only when the row
   * that names it is the only thing folded, and an unlabelled icon is what
   * #1536 F set out to remove.
   */
  if (actions.length === 1) {
    const only = actions[0]!;
    return (
      <button
        ref={setTrigger}
        type="button"
        className="chat-dock__more-inline"
        disabled={only.disabled}
        title={only.label}
        onClick={(event) => {
          event.stopPropagation();
          const trigger = event.currentTarget;
          only.onSelect(trigger);
        }}
      >
        {only.label}
      </button>
    );
  }

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={`chat-dock__more-btn${open ? ' is-active' : ''}`}
        // The count is part of the NAME, not only a painted badge: the badge is
        // `aria-hidden` (it is a glyph for the same fact), so without this a
        // screen reader would hear no difference between an idle dock and one
        // with three background tasks running.
        aria-label={
          badgeCount > 0 && badgeLabel
            ? `More dock actions — ${badgeLabel}`
            : 'More dock actions'
        }
        title={
          badgeCount > 0 && badgeLabel
            ? `More dock actions — ${badgeLabel}`
            : 'More dock actions'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom;
          setPosition(
            below < roomNeededPx(actions.length)
              ? {
                  bottom: `${window.innerHeight - rect.top + MENU_GAP_PX}px`,
                  right: `${window.innerWidth - rect.right}px`,
                }
              : {
                  top: `${rect.bottom + MENU_GAP_PX}px`,
                  right: `${window.innerWidth - rect.right}px`,
                },
          );
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <span aria-hidden="true">⋯</span>
        {badgeCount > 0 && (
          <span className="chat-dock__more-badge" aria-hidden="true">
            {badgeCount}
          </span>
        )}
      </button>
      {open
        ? createPortal(
            <>
              {/* Geometry and layer live in `index.css` beside the menu's own
                  rule, derived from one token — see `.chat-dock__more-backdrop`.
                  `tabIndex={-1}`: it is a pointer convenience, and as a tab
                  stop it sat immediately before the menu in document order, so
                  Shift+Tab off the first row landed on it and `useMenuFocus`'s
                  focusout closed the menu. */}
              <button
                type="button"
                tabIndex={-1}
                className="header-menu__dismiss-backdrop chat-dock__more-backdrop"
                aria-label="Close more dock actions"
                onClick={() => setOpen(false)}
              />
              <div
                ref={menuRef}
                className="dock-placement-menu chat-dock__more-menu"
                role="menu"
                aria-label="More dock actions"
                tabIndex={-1}
                style={{ position: 'fixed', ...position }}
              >
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className="dock-placement-menu__item"
                    disabled={action.disabled}
                    {...(action.checked === undefined
                      ? { role: 'menuitem' as const }
                      : {
                          role: 'menuitemcheckbox' as const,
                          'aria-checked': action.checked,
                        })}
                    {...(action.haspopup
                      ? {
                          'aria-haspopup': action.haspopup,
                          'aria-expanded': Boolean(action.expanded),
                        }
                      : {})}
                    onClick={(event) => {
                      event.stopPropagation();
                      const trigger = ownRef.current;
                      setOpen(false);
                      if (trigger) action.onSelect(trigger);
                    }}
                  >
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
