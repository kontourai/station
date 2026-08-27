import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { useEffect, useRef, useState } from 'react';
import { ambientDockOccupantChoices } from './ambientDockOccupants';

/**
 * The dock-slot header's occupant picker (station#4090, epic #4142 M5).
 *
 * Replaces the old fixed "return to Chat" action: with three dockable panes a
 * two-pane vocabulary was already wrong, so the header names the CURRENT
 * occupant (the descriptor's `name`, never a raw id — #3971) and opens a menu
 * of every pane the ambient slot admits. Chat is not special here — it is one
 * of the list.
 *
 * The list is `ambientDockOccupantChoices()` — the derivation over the render
 * table and the admission fold — read here rather than passed in, so no
 * caller can substitute a curated array.
 *
 * Menu grammar is `DockPlacementControl`'s, deliberately: Escape closes and
 * returns focus to the trigger, a pointer press outside closes, and choosing
 * closes (choosing is also leaving — focus returns to the trigger rather than
 * to whatever the removed item's neighbour happened to be). Choosing the
 * current occupant is a no-op that closes the menu.
 */
export function DockOccupantPicker({
  current,
  onChoose,
}: {
  current: WorkspacePaneDescriptor;
  onChoose: (
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [menuOpen]);

  const choices = ambientDockOccupantChoices();

  return (
    <div className="dock-occupant-picker">
      <button
        ref={triggerRef}
        type="button"
        className="dock-occupant-picker__trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Docked pane: ${current.name}`}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span>{current.name}</span>
        <span aria-hidden="true" className="dock-occupant-picker__caret">
          ⌄
        </span>
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          className="dock-placement-menu dock-occupant-menu"
          role="menu"
          aria-label="Docked pane"
        >
          {choices.map((choice) => (
            <button
              key={choice.descriptor.id}
              type="button"
              role="menuitemradio"
              aria-checked={choice.descriptor.id === current.id}
              className={`dock-placement-menu__item${
                choice.descriptor.id === current.id
                  ? ' dock-placement-menu__item--active'
                  : ''
              }`}
              onClick={() => {
                // The current occupant is already placed: choosing it again
                // is a no-op that closes the menu, not a replace that churns
                // the persisted document.
                if (choice.descriptor.id !== current.id)
                  onChoose(choice.descriptor, choice.instance);
                setMenuOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {choice.descriptor.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
