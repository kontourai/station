import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  DockPlacementTargets,
  usePlacementDrag,
} from '../../regions/placement-drag';
import { regionLabel } from '../../regions/region-model';
import type { DockMode } from '../../types';

/** The one placement chooser shared by the pointer and keyboard paths. */
function DockPlacementChoices({
  availablePlacements,
  effectivePlacement,
  onSelect,
}: {
  availablePlacements: readonly DockMode[];
  effectivePlacement: DockMode;
  onSelect: (placement: DockMode) => void;
}) {
  return (
    <>
      {availablePlacements.map((placement) => (
        <button
          key={placement}
          type="button"
          role="menuitemradio"
          aria-checked={effectivePlacement === placement}
          // No `--active` modifier: `.menu-row[aria-checked="true"]` styles the
          // pressed segment from the state already declared beside it, so the
          // paint cannot disagree with the ARIA.
          className="menu-row"
          onClick={() => onSelect(placement)}
        >
          <span className="menu-row__glyph" aria-hidden="true" />
          {regionLabel(placement)}
        </button>
      ))}
    </>
  );
}

/**
 * Direct manipulation without changing the dock's shell position in the DOM.
 * The parent owns persistence and effective-placement derivation; this surface
 * only requests an available placement.
 */
export function DockPlacementControl({
  availablePlacements,
  effectivePlacement,
  onPlacementChange,
}: {
  availablePlacements: readonly DockMode[];
  effectivePlacement: DockMode;
  onPlacementChange: (placement: DockMode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The drag is the shell's shared gesture (#2185); what stays here is the
  // dock's own act for it — MOVE this dock — the menu, and the fold rule.
  const { dragging, hovered, handlers } = usePlacementDrag({
    placements: availablePlacements,
    onDrop: onPlacementChange,
    onClick: () => setMenuOpen((open) => !open),
    onDragStart: () => setMenuOpen(false),
  });
  const grabRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>();

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const anchor = grabRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      const naturalHeight = menu.scrollHeight + box.height - menu.clientHeight;
      const above = Math.max(0, rect.top - 8);
      const below = Math.max(0, window.innerHeight - rect.bottom - 8);
      const opensBelow = below >= naturalHeight || below >= above;
      const available = opensBelow ? below : above;
      const height = Math.min(naturalHeight, available);
      const parent = (menu.offsetParent ??
        menu.parentElement) as HTMLElement | null;
      const parentTop = parent?.getBoundingClientRect().top ?? 0;
      const top =
        (opensBelow ? rect.bottom + 4 : rect.top - 4 - height) - parentTop;
      setMenuPosition((current) =>
        current?.top === top && current.maxHeight === available
          ? current
          : { top, bottom: 'auto', maxHeight: available, overflowY: 'auto' },
      );
    };
    update();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (grabRef.current) observer?.observe(grabRef.current);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuOpen]);

  // A menu you cannot leave is worse than no menu. Escape returns focus to the
  // control that opened it — a menu that closes while focus stays on a
  // now-hidden item strands the keyboard user somewhere with nothing to read.
  // A pointer press outside closes it too, which is what every other menu in
  // this shell does and therefore what someone will try.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenuOpen(false);
      grabRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (grabRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [menuOpen]);

  // Follow S2's decision: a phone has one placement and therefore no control.
  if (availablePlacements.length <= 1) return null;

  return (
    <>
      <button
        ref={grabRef}
        type="button"
        className="chat-dock__placement-grab"
        aria-label="Move the dock"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        {...handlers}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          className="menu-surface dock-placement-menu"
          style={menuPosition}
          role="menu"
          aria-label="Dock placement"
        >
          <DockPlacementChoices
            availablePlacements={availablePlacements}
            effectivePlacement={effectivePlacement}
            onSelect={(placement) => {
              onPlacementChange(placement);
              setMenuOpen(false);
              // Choosing is also leaving: focus goes back to the control that
              // opened the menu rather than to whatever the removed item's
              // neighbour happened to be.
              grabRef.current?.focus();
            }}
          />
        </div>
      ) : null}
      {dragging ? (
        <DockPlacementTargets
          placements={availablePlacements}
          active={hovered}
        />
      ) : null}
    </>
  );
}
