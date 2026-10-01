import type React from 'react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../hooks/useMenuFocus';
// The dismiss backdrop's button reset lives with the header's portalled menus,
// which is the same shape this one is: a full-viewport hit target that must not
// inherit the global button chrome.
import './header/HeaderMenu.css';
import './ActionOverflowMenu.css';

/**
 * One row of an overflow menu.
 *
 * `onSelect` is handed the MENU'S TRIGGER, not the row: a row that opens an
 * anchored surface (the Background tasks sheet, the session inventory) needs an
 * element that survives the menu closing, and the trigger is the only one in
 * this subtree that does. It is also where `SessionInventoryHost` stamps its
 * `focusFullBasis` handle, so a second activation reaches the same host rather
 * than opening a second one.
 */
export interface OverflowAction {
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
  /**
   * Why a disabled row cannot be used, shown under its label. A greyed-out row
   * with no explanation sends the reader looking for a cause the menu already
   * knows. It is the row's DESCRIPTION, not part of its accessible name:
   * callers and tests address a row by its label.
   */
  disabledReason?: string;
  /**
   * A destructive command. Painted in the danger colour and moved to the END
   * of the menu behind a separator, wherever the caller listed it: folding
   * Remove into a menu must not make it read like Export, and must not put it
   * under the pointer of someone aiming at the row above.
   */
  tone?: 'danger';
  onSelect: (trigger: HTMLElement) => void;
}

const MENU_GAP_PX = 6;
/** `.menu-row`'s height, which every row in this menu takes. */
const MENU_ROW_PX = 32;
/** `.menu-surface`'s `padding: var(--space-3)`, top and bottom. */
const MENU_PADDING_PX = 12;
/**
 * Room needed to open downward — derived from the rows this menu is actually
 * about to render, not from a constant that pins a row count some later change
 * would quietly outgrow. It does not have to equal the rendered height (which
 * is unknown before layout); it has to be right about which side has space.
 */
const roomNeededPx = (rowCount: number) =>
  rowCount * MENU_ROW_PX + MENU_PADDING_PX + MENU_GAP_PX;

/**
 * A `⋯` trigger and the menu of commands folded behind it.
 *
 * Born as the dock header's More menu (#1536 section F): that bar carried
 * thirteen controls in 40px and the conversation title got about one
 * character, so the commands that were not the dock's primary verbs moved
 * here. #3045 made it the one overflow for every action row — see
 * `ActionRow`, which is how a row outside the dock should reach it.
 *
 * Fixed-positioned in a portal rather than absolutely positioned beside its
 * trigger: the trigger sits at the top of a bottom dock, the top of a side
 * dock, in a 40px collapsed bar, in a detail header and in a list row, so
 * neither "always above" nor "always below" is on screen in every one of them,
 * and several of those ancestors clip. The trigger's own rect decides.
 */
export function ActionOverflowMenu({
  actions,
  triggerRef,
  badgeCount = 0,
  badgeLabel,
  label,
  inlineSingle = false,
  triggerClassName = 'action-overflow__trigger',
}: {
  actions: readonly OverflowAction[];
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
  /**
   * The trigger's and the menu's accessible name. REQUIRED: the trigger shows
   * only `⋯`, so this is the only name it has, and two of these on one page
   * ("More skill actions", "More actions for Studio Mac") must be told apart.
   */
  label: string;
  /**
   * Render a menu of ONE command as that command's own labelled button — the
   * dock header's behaviour, where a list of one is a second click for
   * nothing. Off by default: beside an `ActionRow`'s two labelled actions an
   * inlined third is exactly the row #3045 removes.
   */
  inlineSingle?: boolean;
  /** The `⋯` trigger's class. The dock passes its own 28px bar control. */
  triggerClassName?: string;
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

  /**
   * Close whenever the row count changes the branch that OWNS the menu.
   *
   * The two early returns below (no rows, one row rendered inline) unmount the
   * portal without touching this state, so collapsing the dock with the menu
   * open — which takes every pane command away and leaves Chat settings alone —
   * left `open` true behind an inline button. Re-expanding then re-opened a menu
   * nobody pressed, positioned from a trigger rect measured before the collapse.
   * `RegionToolbarControls` guards its own branch changes the same way.
   *
   * On the count, not on a branch boolean: the count is what both early returns
   * and the anchor's `roomNeededPx` are derived from, so a future third branch
   * cannot slip past this.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row count is this effect's trigger, not a value it reads.
  useEffect(() => {
    setOpen(false);
  }, [actions.length]);

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
  if (inlineSingle && actions.length === 1) {
    const only = actions[0]!;
    const inlineName =
      badgeCount > 0 && badgeLabel
        ? `${only.label} — ${badgeLabel}`
        : undefined;
    return (
      <button
        ref={setTrigger}
        type="button"
        className="chat-dock__more-inline"
        disabled={only.disabled}
        // Everything the row would have carried in the menu carries here: a row
        // that opens a surface of its own still says so, a toggle still reports
        // its state, and live work behind it is still visible. Folding a command
        // into one control must not drop what the control promised.
        {...(only.haspopup
          ? {
              'aria-haspopup': only.haspopup,
              'aria-expanded': Boolean(only.expanded),
            }
          : {})}
        {...(only.checked === undefined
          ? {}
          : { 'aria-pressed': only.checked })}
        {...(inlineName ? { 'aria-label': inlineName } : {})}
        title={inlineName ?? only.label}
        onClick={(event) => {
          event.stopPropagation();
          const trigger = event.currentTarget;
          only.onSelect(trigger);
        }}
      >
        {only.label}
        {badgeCount > 0 && (
          <span className="chat-dock__more-badge" aria-hidden="true">
            {badgeCount}
          </span>
        )}
      </button>
    );
  }

  // Destructive rows last, behind a separator — see `OverflowAction.tone`.
  const safe = actions.filter((action) => action.tone !== 'danger');
  const ordered = [
    ...safe,
    ...actions.filter((action) => action.tone === 'danger'),
  ];
  const triggerName =
    badgeCount > 0 && badgeLabel ? `${label} — ${badgeLabel}` : label;

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={`${triggerClassName}${open ? ' is-active' : ''}`}
        // The count is part of the NAME, not only a painted badge: the badge is
        // `aria-hidden` (it is a glyph for the same fact), so without this a
        // screen reader would hear no difference between an idle dock and one
        // with three background tasks running.
        aria-label={triggerName}
        title={triggerName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom;
          setPosition(
            below < roomNeededPx(ordered.length)
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
                aria-label={`Close ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
                // Stopped for the same reason every row stops it: the portal
                // leaves the DOM subtree but not the React tree, so without
                // this a click-away on a card's menu also clicks the card.
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                }}
              />
              {/* The class names are the dock's because the RULES are: a
                  body-portalled, fixed menu that must outrank the dock is the
                  same layer problem wherever its trigger sits, and
                  `menu-primitive.cascade.test.tsx` measures these selectors. */}
              <div
                ref={menuRef}
                className="menu-surface dock-placement-menu chat-dock__more-menu"
                role="menu"
                aria-label={label}
                tabIndex={-1}
                style={{ position: 'fixed', ...position }}
              >
                {ordered.map((action, index) => (
                  <Fragment key={action.key}>
                    {action.tone === 'danger' &&
                      index === safe.length &&
                      safe.length > 0 && (
                        <hr className="action-overflow__separator" />
                      )}
                    <button
                      type="button"
                      className={
                        action.tone === 'danger'
                          ? 'menu-row action-overflow__row--danger'
                          : 'menu-row'
                      }
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
                      {...(action.disabled && action.disabledReason
                        ? {
                            'aria-label': action.label,
                            'aria-description': action.disabledReason,
                          }
                        : {})}
                      onClick={(event) => {
                        event.stopPropagation();
                        const trigger = ownRef.current;
                        setOpen(false);
                        if (trigger) action.onSelect(trigger);
                      }}
                    >
                      {/* The glyph slot every `.menu-row` reserves. These rows
                          carry no glyph today, and reserving it anyway is what
                          keeps their labels on the same x as the rows of the
                          header's own menus (#1552 D4). */}
                      <span className="menu-row__glyph" aria-hidden="true" />
                      {action.disabled && action.disabledReason ? (
                        <span className="action-overflow__row-text">
                          {action.label}
                          <span className="action-overflow__reason">
                            {action.disabledReason}
                          </span>
                        </span>
                      ) : (
                        action.label
                      )}
                    </button>
                  </Fragment>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
