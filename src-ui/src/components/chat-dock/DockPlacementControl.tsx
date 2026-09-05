import { useEffect, useRef, useState } from 'react';
import type { DockMode } from '../../types';

const LABELS: Record<DockMode, string> = {
  left: 'Left',
  bottom: 'Bottom',
  right: 'Right',
};

/** The one placement chooser shared by the pointer and keyboard paths. */
export function DockPlacementChoices({
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
          {LABELS[placement]}
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
  const [dragging, setDragging] = useState(false);
  const [hoveredPlacement, setHoveredPlacement] = useState<DockMode | null>(
    null,
  );
  const suppressClick = useRef(false);
  const grabRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  const placementAt = (x: number, y: number): DockMode | null => {
    const element = document.elementFromPoint(x, y);
    const value = element?.closest<HTMLElement>('[data-dock-placement-target]')
      ?.dataset.dockPlacementTarget;
    return value && availablePlacements.includes(value as DockMode)
      ? (value as DockMode)
      : null;
  };
  const finishDrag = () => {
    setDragging(false);
    setHoveredPlacement(null);
  };

  return (
    <>
      <button
        ref={grabRef}
        type="button"
        className="chat-dock__placement-grab"
        aria-label="Move the dock"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          if (!suppressClick.current) setMenuOpen((open) => !open);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setMenuOpen(false);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const target = placementAt(event.clientX, event.clientY);
          setHoveredPlacement(target);
          if (target !== null) suppressClick.current = true;
        }}
        onPointerUp={(event) => {
          if (!dragging) return;
          const target = placementAt(event.clientX, event.clientY);
          if (target !== null) {
            suppressClick.current = true;
            onPlacementChange(target);
          }
          finishDrag();
          requestAnimationFrame(() => {
            suppressClick.current = false;
          });
        }}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          if (dragging) finishDrag();
        }}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          className="menu-surface dock-placement-menu"
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
        <div
          className="dock-placement-targets"
          data-testid="dock-placement-targets"
          aria-hidden="true"
        >
          {availablePlacements.map((placement) => (
            <div
              key={placement}
              className={`dock-placement-target dock-placement-target--${placement}${
                hoveredPlacement === placement
                  ? ' dock-placement-target--active'
                  : ''
              }`}
              data-dock-placement-target={placement}
            >
              {LABELS[placement]}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
