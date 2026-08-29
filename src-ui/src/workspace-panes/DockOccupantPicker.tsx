import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { useEffect, useRef, useState } from 'react';
import { resolveViewFromPath } from '../app-shell/routing';
import { shouldMaximizeOnOccupantChoice } from '../components/chat-dock/mobile-chrome';
import { useNavigation } from '../contexts/NavigationContext';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  ambientDockOccupantChoices,
  ambientDockOccupantRouteViewType,
} from './ambientDockOccupants';

/**
 * The dock-slot header's occupant picker (archive#4090).
 *
 * Replaces the old fixed "return to Chat" action: with three dockable panes a
 * two-pane vocabulary was already wrong, so the header names the CURRENT
 * occupant (the descriptor's `name`, never a raw id — archive#3971) and opens a menu
 * of every pane the ambient slot admits. Chat is not special here — it is one
 * of the list.
 *
 * The list is `ambientDockOccupantChoices` — the derivation over the render
 * table and the admission fold — read here rather than passed in, so no
 * caller can substitute a curated array.
 *
 * Menu grammar is `DockPlacementControl`'s, deliberately: Escape closes and
 * returns focus to the trigger, a pointer press outside closes, and choosing
 * closes (choosing is also leaving — focus returns to the trigger rather than
 * to whatever the removed item's neighbour happened to be). Choosing the
 * current occupant is a no-op that closes the menu.
 *
 * station#520 (review round 2, M3): this is also the mobile
 * dock-and-empty contract's SECOND entry point, not just
 * `WorkspacePaneDockAction`'s "Dock this pane". Picking Home here while the
 * main area is ALREADY `/` reproduces the exact same stranding "Dock this
 * pane" refuses — the main area becomes Home's away-state placeholder with
 * nothing else behind it. `shouldMaximizeOnOccupantChoice` derives that
 * from the live route (`useNavigation().pathname` +
 * `resolveViewFromPath` + `ambientDockOccupantRouteViewType`) and routes
 * through `onChooseAsOnlyContent` (the mobile-maximizing action) instead of
 * the plain `onChoose` when it matches.
 */
export function DockOccupantPicker({
  current,
  onChoose,
  onChooseAsOnlyContent,
}: {
  current: WorkspacePaneDescriptor;
  onChoose: (
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ) => void;
  /**
   * station#520: the SAME action `WorkspacePaneDockAction` uses
   * (`dockPaneAsOnlyContent` on `WorkspacePaneDockContext`) — maximizes the
   * dock on mobile rather than preserving whatever snap it already had.
   * Called instead of `onChoose` exactly when
   * `shouldMaximizeOnOccupantChoice` says the picked pane's own route is
   * the one the main area is already showing.
   */
  onChooseAsOnlyContent: (
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const { pathname } = useNavigation();

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
        {/* station#524: a dedicated class so a host with less room (the
            mobile chat header) can bound and ellipsize the current
            occupant's name instead of forcing the row wider — matching the
            treatment the mobile project-switcher trigger already gets. Only
            the caret is `aria-hidden`; this name is the trigger's visible
            label text, already covered by the `aria-label` above. */}
        <span className="dock-occupant-picker__label">{current.name}</span>
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
                if (choice.descriptor.id !== current.id) {
                  // station#520 (review round 2, M3): route through the
                  // maximizing action exactly when picking this occupant
                  // would strand the main area behind it — the picked
                  // pane's own route is the one already on screen.
                  if (
                    shouldMaximizeOnOccupantChoice(
                      isMobile,
                      resolveViewFromPath(pathname).type,
                      ambientDockOccupantRouteViewType(choice.descriptor),
                    )
                  ) {
                    onChooseAsOnlyContent(choice.descriptor, choice.instance);
                  } else {
                    onChoose(choice.descriptor, choice.instance);
                  }
                }
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
