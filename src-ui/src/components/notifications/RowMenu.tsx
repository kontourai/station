import {
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { MoreGlyph } from '../icons/Glyph';
import './RowMenu.css';

export interface RowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Items sharing a group render under that group's heading. */
  group?: string;
  /** A secondary line under the label, e.g. the exact time a snooze ends. */
  hint?: string;
}

/**
 * A row's secondary actions (snooze, dismiss) behind one ⋯ button beside its
 * time, so every row has the same quiet corner and its footer holds only the
 * row's real decisions.
 *
 * The menu renders INSIDE the row with fixed positioning: inside, so the
 * tray's click-outside handler sees a click in it as a click in the tray;
 * fixed, so the tray's scroll container cannot clip it. A WAI-ARIA menu:
 * arrow keys rove, Escape closes back to the trigger without closing the
 * tray around it.
 */
export function RowMenu({
  items,
  label = 'More actions',
}: {
  items: readonly RowMenuItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  /**
   * Place the fixed menu under its trigger (above, when the row is the last
   * one in view), and keep it there: a scroll of the list under it moves the
   * menu with its row rather than closing it — a tap that focuses the
   * trigger can itself scroll the tray a few pixels.
   */
  const place = () => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    if (trigger.bottom < 0 || trigger.top > window.innerHeight) {
      setOpen(false);
      return;
    }
    const height = menuRef.current?.getBoundingClientRect().height ?? 0;
    const below = trigger.bottom + 4;
    const top =
      below + height > window.innerHeight - 8
        ? Math.max(8, trigger.top - 4 - height)
        : below;
    setPosition({ top, right: window.innerWidth - trigger.right });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `place` reads refs only
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `place` reads refs only
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      // Without preventScroll the focus scrolls the tray, and the scroll
      // listener below would close the menu it just opened.
      ?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onScrollOrResize = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      place();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onScrollOrResize);
    document.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      entries[(next + entries.length) % entries.length]?.focus();
    };
    if (event.key === 'Escape') {
      // Close this menu only — not the tray it sits in.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(entries.length - 1);
    else if (event.key === 'Tab') setOpen(false);
  };

  const groups: { name?: string; items: RowMenuItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  return (
    <span className="row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="row-menu__trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreGlyph />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="row-menu__menu"
          style={
            position
              ? { top: position.top, right: position.right }
              : { visibility: 'hidden' }
          }
          onKeyDown={onMenuKeyDown}
        >
          {groups.map((group, groupIndex) => {
            const headingId = group.name
              ? `${menuId}-group-${groupIndex}`
              : undefined;
            return (
              <Fragment key={group.items[0]?.id}>
                {groupIndex > 0 ? <hr className="row-menu__separator" /> : null}
                {group.name ? (
                  <div id={headingId} className="row-menu__heading">
                    {group.name}
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="row-menu__item"
                    aria-describedby={headingId}
                    disabled={item.disabled}
                    onClick={() => {
                      // Back to the trigger: if the action leaves the row in
                      // place (a failed snooze), focus must not fall to body.
                      close(true);
                      item.onSelect();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.hint ? (
                      <span className="row-menu__hint">
                        <span className="sr-only">, </span>
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                ))}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
