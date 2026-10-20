import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../components/IconButton';
import { ArrowLeftGlyph } from '../../components/icons/Glyph';
import { useMenuFocus } from '../../hooks/useMenuFocus';

/**
 * The Browser pane's `⋯` menu (#90): what a browser keeps out of its toolbar.
 * A row may carry a hint at its right end (a shortcut, or a current value),
 * and a row may open a sub-list in place (Viewport's presets), with a row to
 * go back.
 *
 * Built on the app's shared menu pieces: `useMenuFocus` (focus entry, arrow
 * roving for a `role="menu"`, focusout dismissal, focus return) and the
 * `.menu-surface` / `.menu-row` look every Station menu shares. Portalled
 * and fixed to the trigger's rect so a toolbar that clips cannot clip the
 * menu; it opens below the trigger, or above it when there is no room, and
 * is bounded to the viewport above the chat dock, with its own scroll.
 */

export interface BrowserMenuRadio {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type BrowserMenuItem =
  | {
      kind: 'action';
      id: string;
      label: string;
      glyph?: ReactNode;
      /** Right-aligned shortcut hint, e.g. "⇧⌘S". */
      hint?: string;
      /** The same shortcut for `aria-keyshortcuts`, e.g. "Meta+Shift+S". */
      hintKeys?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: 'list';
      id: string;
      label: string;
      glyph?: ReactNode;
      /** The current choice, shown at the row's right end. */
      hint?: string;
      disabled?: boolean;
      choices: BrowserMenuRadio[];
    }
  | { kind: 'separator'; id: string }
  | {
      kind: 'danger';
      id: string;
      label: string;
      glyph?: ReactNode;
      disabled?: boolean;
      onSelect: () => void;
    };

const GAP_PX = 4;
const EDGE_PX = 8;

function Row({
  glyph,
  label,
  hint,
}: {
  glyph?: ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <>
      <span className="menu-row__glyph" aria-hidden="true">
        {glyph ?? null}
      </span>
      <span className="browser-pane__menu-label">{label}</span>
      {hint ? (
        <span className="browser-pane__menu-hint" aria-hidden="true">
          {hint}
        </span>
      ) : null}
    </>
  );
}

export function BrowserOverflowMenu({
  label,
  items,
  children,
}: {
  /** The trigger's accessible name and tooltip, e.g. "More browser actions". */
  label: string;
  items: BrowserMenuItem[];
  /** The trigger's glyph. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /** A `list` row's id while its choices are shown in place. */
  const [listId, setListId] = useState<string | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setListId(null);
  };
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const shut = () => {
      setOpen(false);
      setListId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      shut();
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', shut);
    };
  }, [open]);

  // Entering or leaving a sub-list moves focus to its first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listId is the change key.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus();
  }, [listId]);

  // Placed from the trigger's own rect once the menu has a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listId changes the menu's height.
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menuElement = menuRef.current;
    const menu = menuElement?.getBoundingClientRect();
    if (!trigger || !menuElement || !menu) return;
    // The chat dock overlays the bottom of the viewport above every popover
    // (`--layer-dock`), so the menu's floor is the dock's top edge, not the
    // window's: on a landscape phone the last rows otherwise sit under it.
    const rootStyle = getComputedStyle(document.documentElement);
    const inset = (name: string) =>
      Number.parseFloat(rootStyle.getPropertyValue(name)) || 0;
    const viewportHeight =
      window.innerHeight -
      inset('--dock-slot-size') -
      inset('--visual-viewport-bottom-inset');
    const viewportTop = Math.max(
      EDGE_PX,
      document.querySelector('.app-toolbar')?.getBoundingClientRect().bottom ??
        0,
      document.querySelector('.banner-host')?.getBoundingClientRect().bottom ??
        0,
    );
    const below = viewportHeight - trigger.bottom - GAP_PX - EDGE_PX;
    const above = trigger.top - GAP_PX - viewportTop;
    const openUp = menu.height > below && above > below;
    const menuStyle = getComputedStyle(menuElement);
    const chromeHeight =
      (Number.parseFloat(menuStyle.paddingTop) || 0) +
      (Number.parseFloat(menuStyle.paddingBottom) || 0) +
      (Number.parseFloat(menuStyle.borderTopWidth) || 0) +
      (Number.parseFloat(menuStyle.borderBottomWidth) || 0);
    const maxHeight = Math.max(
      0,
      Math.min(
        viewportHeight - EDGE_PX - viewportTop,
        Math.max(above, below) < chromeHeight + 44
          ? viewportHeight - EDGE_PX - viewportTop
          : openUp
            ? above
            : below,
      ),
    );
    const height = Math.max(chromeHeight, Math.min(menu.height, maxHeight));
    setStyle({
      position: 'fixed',
      right: Math.max(EDGE_PX, window.innerWidth - trigger.right),
      top: Math.max(
        viewportTop,
        Math.min(
          openUp ? trigger.top - GAP_PX - height : trigger.bottom + GAP_PX,
          viewportHeight - EDGE_PX - height,
        ),
      ),
      maxHeight,
      maxWidth: `calc(100vw - ${EDGE_PX * 2}px)`,
    });
  }, [open, listId, menuRef]);

  useEffect(() => {
    if (!open || style.visibility === 'hidden') return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open, style.visibility, menuRef]);

  const list = items.find(
    (item): item is Extract<BrowserMenuItem, { kind: 'list' }> =>
      item.kind === 'list' && item.id === listId,
  );
  /**
   * Swap between the root list and a sub-list. Focus moves to the menu
   * itself first: the row that had it is about to unmount, and focus leaving
   * the menu is what closes it (`useMenuFocus`).
   */
  const showList = (id: string | null) => {
    menuRef.current?.focus();
    setListId(id);
  };
  const choose = (run: () => void) => {
    close();
    run();
  };

  return (
    <>
      <IconButton
        ref={triggerRef}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {children}
      </IconButton>
      {open
        ? createPortal(
            <>
              {/* A pointer convenience, not a tab stop (see ToolbarMenuSurface). */}
              <button
                type="button"
                tabIndex={-1}
                className="browser-pane__menu-backdrop"
                aria-label="Close menu"
                onPointerDown={(event) => event.preventDefault()}
                onPointerUp={close}
                onClick={close}
              />
              <div
                ref={menuRef}
                id={menuId}
                role="menu"
                aria-label={list ? list.label : label}
                tabIndex={-1}
                className="menu-surface browser-pane__menu"
                style={style}
              >
                {list ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Back from ${list.label}`}
                      className="menu-row browser-pane__menu-row"
                      onClick={() => showList(null)}
                    >
                      <Row glyph={<ArrowLeftGlyph />} label={list.label} />
                    </button>
                    {list.choices.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={choice.checked}
                        disabled={choice.disabled}
                        className="menu-row browser-pane__menu-row"
                        onClick={() => choose(choice.onSelect)}
                      >
                        <Row
                          glyph={choice.checked ? '✓' : undefined}
                          label={choice.label}
                        />
                      </button>
                    ))}
                  </>
                ) : (
                  items.map((item) =>
                    item.kind === 'separator' ? (
                      <hr
                        key={item.id}
                        className="browser-pane__menu-separator"
                      />
                    ) : item.kind === 'list' ? (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-label={
                          item.hint ? `${item.label}: ${item.hint}` : item.label
                        }
                        disabled={item.disabled}
                        className="menu-row browser-pane__menu-row"
                        onClick={() => showList(item.id)}
                      >
                        <Row
                          glyph={item.glyph}
                          label={item.label}
                          hint={item.hint}
                        />
                      </button>
                    ) : (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        aria-label={item.label}
                        aria-keyshortcuts={
                          item.kind === 'action' ? item.hintKeys : undefined
                        }
                        disabled={item.disabled}
                        className={`menu-row browser-pane__menu-row${item.kind === 'danger' ? ' browser-pane__menu-row--danger' : ''}`}
                        onClick={() => choose(item.onSelect)}
                      >
                        <Row
                          glyph={item.glyph}
                          label={item.label}
                          hint={item.kind === 'action' ? item.hint : undefined}
                        />
                      </button>
                    ),
                  )
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
