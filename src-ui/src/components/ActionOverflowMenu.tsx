import type React from 'react';
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import { useMenuFocus } from '../hooks/useMenuFocus';
import { hostLayerOf, OverlayLayerContext } from './overlay-layer';
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
  /**
   * A checked row that is one of a set, where choosing it unchooses the
   * others (a merge method): `menuitemradio` rather than `menuitemcheckbox`.
   * Only read when `checked` is given.
   */
  exclusive?: boolean;
  /** Draw a separator above this row: the commands after a set of choices. */
  separatorBefore?: boolean;
  /** For a row that opens a surface of its own. */
  haspopup?: 'dialog';
  /**
   * For a row that shows or hides something that stays on the page — a
   * surface (`haspopup`) or a disclosed section ("Share devices…"). Emitted
   * as `aria-expanded` whenever it is given, with or without `haspopup`.
   */
  expanded?: boolean;
  /** Drawn in the row's 16px glyph slot. */
  glyph?: React.ReactNode;
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
   * knows. It is the row's DESCRIPTION (`aria-describedby`), not part of its
   * accessible name: callers and tests address a row by its label.
   *
   * A row with a reason is `aria-disabled`, NOT `disabled`: it stays in the
   * arrow-key order so a keyboard or screen-reader user can land on it and
   * hear why, and it refuses activation. A disabled row with NO reason has
   * nothing to say, so it keeps the native attribute and roving focus skips
   * it — the dock's rows rely on that.
   */
  disabledReason?: string;
  /**
   * A destructive command. Painted in the danger colour and moved to the END
   * of the menu behind a separator, wherever the caller listed it: folding
   * Remove into a menu must not make it read like Export, and must not put it
   * under the pointer of someone aiming at the row above.
   */
  tone?: 'danger';
  /**
   * The keyboard shortcut that runs this command elsewhere, e.g. "⌘G".
   * Announced as `aria-keyshortcuts` on the row, and shown at the row's end
   * on a fine pointer only: a keyboard hint on a touch screen is noise.
   */
  shortcut?: string;
  onSelect: (trigger: HTMLElement) => void;
}

/** "⌘G" → "Meta+G", the `aria-keyshortcuts` spelling; "Ctrl+G" stays. */
function ariaShortcut(shortcut: string): string {
  return shortcut.replace('⌘', 'Meta+');
}

const MENU_GAP_PX = 6;
/** The closest the menu may sit to a viewport edge. */
const VIEWPORT_GUTTER_PX = 8;
/** `.menu-row`'s fine-pointer height: the estimate used before layout. */
const MENU_ROW_PX = 32;
/** `.menu-surface`'s `padding: var(--space-3)`, top and bottom. */
const MENU_PADDING_PX = 12;
/**
 * Room the menu is GUESSED to need, for the first paint only — the menu has
 * not been laid out when the trigger is pressed. `placeMenu` replaces the
 * guess with the measured height before that paint is shown, which is what
 * makes rows of other heights (a 44px touch row, a two-line reason row) land
 * on the correct side.
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
  triggerText,
  reserveGlyphColumn = false,
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
  /**
   * A visible word beside the `⋯`, for a trigger that stands ALONE. A bare
   * glyph with nothing next to it does not say there is anything behind it.
   * `ActionRow` passes the first word of `label` when it has no labelled
   * action of its own, so the accessible name (`label`) always begins with
   * what is shown (WCAG 2.5.3). A direct caller must keep that true: the word
   * has to appear in `label`.
   */
  triggerText?: string;
  /**
   * Keep the 16px glyph slot on every row even when no row has a glyph. The
   * dock passes this: its menu sits beside the header's menus, and the slot
   * is what puts their labels on one x (#1552 D4). Elsewhere an always-empty
   * slot is just an unexplained left indent, so the default reserves it only
   * when some row has a glyph.
   */
  reserveGlyphColumn?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const coarse = useCoarsePointer();
  const [position, setPosition] = useState<React.CSSProperties>({});
  /** The menu's z-index when its host outranks the default; see `placeMenu`. */
  const [layer, setLayer] = useState<number | null>(null);
  const overlay = useContext(OverlayLayerContext);
  const reasonIdPrefix = useId();
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
   * Put the menu where it fits, from MEASURED geometry.
   *
   * Vertical: below the trigger when its full height fits there, otherwise on
   * whichever side has more room. Either way the menu's height is capped to
   * that side's room and it scrolls inside, so its top edge can never leave
   * the viewport — a seven-row menu flipped above a trigger 150px down used
   * to run off the top.
   *
   * Horizontal: right edge on the trigger's right edge, which suits the dock
   * and a detail header. A row that starts at the left of a card or a phone
   * screen has less room there than the menu is wide; then it is anchored to
   * the trigger's left edge, and pulled back in if that overruns the right.
   *
   * Run before paint on open, and again on scroll and resize while open: the
   * menu is `position: fixed`, so without that it stays put while the row it
   * belongs to scrolls away underneath it. If the trigger has scrolled out of
   * the viewport altogether the menu closes: a menu pinned to an edge with
   * nothing visibly attached to it belongs to nothing.
   *
   * LAYER, decided here too. The menu's own layer (`--layer-navigation`) is
   * below a dialog's, so a menu whose trigger is hosted by anything on a
   * higher layer opened BEHIND its host. It takes the layer just above
   * whatever hosts the trigger — read from the trigger's real stacking
   * context (`hostLayerOf`), not from "is there a dialog ancestor": that
   * missed a popover portalled out of a dialog, and a dialog on the system
   * layer. Its backdrop stays one step below it, above the host.
   */
  const placeMenu = useCallback(() => {
    const menu = menuRef.current;
    const trigger = ownRef.current;
    if (!menu || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    // jsdom lays nothing out; keep the press-time position rather than
    // "correcting" it from a 0x0 box.
    if (box.width === 0 && box.height === 0) return;
    if (
      anchor.bottom < 0 ||
      anchor.top > window.innerHeight ||
      anchor.right < 0 ||
      anchor.left > window.innerWidth
    ) {
      setOpen(false);
      return;
    }
    const hostLayer = hostLayerOf(trigger, overlay);
    const ownLayer = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--layer-navigation',
      ),
      10,
    );
    // +2: the backdrop takes +1, between the host and the menu.
    setLayer(
      Number.isFinite(ownLayer) && hostLayer >= ownLayer - 1
        ? hostLayer + 2
        : null,
    );
    // `scrollHeight` is the content's height even while `max-height` clips it.
    const natural = menu.scrollHeight + (box.height - menu.clientHeight);
    const roomBelow =
      window.innerHeight - anchor.bottom - MENU_GAP_PX - VIEWPORT_GUTTER_PX;
    const roomAbove = anchor.top - MENU_GAP_PX - VIEWPORT_GUTTER_PX;
    const openUp = natural > roomBelow && roomAbove > roomBelow;
    const next: React.CSSProperties = openUp
      ? {
          bottom: `${window.innerHeight - anchor.top + MENU_GAP_PX}px`,
          maxHeight: `${Math.max(roomAbove, MENU_ROW_PX)}px`,
        }
      : {
          top: `${anchor.bottom + MENU_GAP_PX}px`,
          maxHeight: `${Math.max(roomBelow, MENU_ROW_PX)}px`,
        };
    const maxLeft = window.innerWidth - VIEWPORT_GUTTER_PX - box.width;
    if (anchor.right - box.width >= VIEWPORT_GUTTER_PX) {
      next.right = `${window.innerWidth - anchor.right}px`;
    } else {
      next.left = `${Math.max(VIEWPORT_GUTTER_PX, Math.min(anchor.left, maxLeft))}px`;
    }
    setPosition((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
  }, [menuRef, overlay]);

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
    // One placement per frame however many scroll events arrive in it.
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        placeMenu();
      });
    };
    const onScroll = (event: Event) => {
      // The menu scrolling INSIDE itself (it is height-capped) moves nothing
      // it is anchored to.
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      schedule();
    };
    window.addEventListener('resize', schedule);
    // Capture: the scroller is usually an ancestor pane, not the window, and
    // scroll does not bubble.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, placeMenu, menuRef]);

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
  const hasGlyphColumn =
    reserveGlyphColumn || actions.some((action) => action.glyph);
  const triggerName =
    badgeCount > 0 && badgeLabel ? `${label} — ${badgeLabel}` : label;

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={`${triggerText ? 'button button--secondary button--small action-overflow__trigger--labelled' : triggerClassName}${open ? ' is-active' : ''}`}
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
        {triggerText}
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
                style={layer === null ? undefined : { zIndex: layer - 1 }}
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
                style={{
                  position: 'fixed',
                  overflowY: 'auto',
                  ...position,
                  ...(layer === null ? {} : { zIndex: layer }),
                }}
              >
                {ordered.map((action, index) => {
                  // See `OverflowAction.disabledReason`: a row that explains
                  // itself stays reachable; one that cannot does not.
                  const explained = Boolean(
                    action.disabled && action.disabledReason,
                  );
                  const reasonId = `${reasonIdPrefix}${action.key}-reason`;
                  return (
                    <Fragment key={action.key}>
                      {((action.tone === 'danger' &&
                        index === safe.length &&
                        safe.length > 0) ||
                        (action.separatorBefore && index > 0)) && (
                        <hr className="action-overflow__separator" />
                      )}
                      <button
                        type="button"
                        className={`menu-row${action.tone === 'danger' ? ' action-overflow__row--danger' : ''}${explained ? ' action-overflow__row--explained' : ''}`}
                        disabled={action.disabled && !explained}
                        {...(explained
                          ? {
                              'aria-disabled': true,
                              // The name is the label alone; the reason is
                              // the description, not a suffix of the name.
                              'aria-label': action.label,
                              'aria-describedby': reasonId,
                            }
                          : {})}
                        {...(action.checked === undefined
                          ? { role: 'menuitem' as const }
                          : {
                              role: action.exclusive
                                ? ('menuitemradio' as const)
                                : ('menuitemcheckbox' as const),
                              'aria-checked': action.checked,
                            })}
                        {...(action.haspopup
                          ? { 'aria-haspopup': action.haspopup }
                          : {})}
                        {...(action.expanded === undefined && !action.haspopup
                          ? {}
                          : { 'aria-expanded': Boolean(action.expanded) })}
                        {...(action.shortcut
                          ? {
                              'aria-keyshortcuts': ariaShortcut(
                                action.shortcut,
                              ),
                            }
                          : {})}
                        onClick={(event) => {
                          event.stopPropagation();
                          // Refused, and the menu stays open on the row that
                          // says why.
                          if (explained) return;
                          const trigger = ownRef.current;
                          setOpen(false);
                          if (trigger) action.onSelect(trigger);
                        }}
                      >
                        {hasGlyphColumn && (
                          <span className="menu-row__glyph" aria-hidden="true">
                            {action.glyph}
                          </span>
                        )}
                        {explained ? (
                          <span className="action-overflow__row-text">
                            <span>{action.label}</span>
                            <span
                              id={reasonId}
                              className="action-overflow__reason"
                            >
                              {action.disabledReason}
                            </span>
                          </span>
                        ) : (
                          action.label
                        )}
                        {action.shortcut && !coarse ? (
                          // Decoration: the row's name is its label, and the
                          // shortcut is already `aria-keyshortcuts`.
                          <span
                            className="action-overflow__shortcut"
                            aria-hidden="true"
                          >
                            {action.shortcut}
                          </span>
                        ) : null}
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
