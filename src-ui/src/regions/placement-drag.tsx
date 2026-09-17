import { useRef, useState } from 'react';
import type { DockMode } from '../types';
import { regionLabel } from './region-model';

/**
 * How far the pointer travels before a press has become a drag, and the click
 * the browser turns its release into is dead wherever it lands. The same
 * number, and the same spelling, as `useLongPress` (`src-ui/src/hooks/
 * useLongPress.ts`): that file carries the Chromium measurement this rule
 * rests on — with pointer capture, a press dragged 350px off a control and
 * released there still fires `click` ON the control; without capture it fires
 * none — and its reasoning is not repeated here. Module-private for the same
 * reason it is there: a caller that needs a different tolerance is a caller
 * that needs a different gesture.
 */
const MOVE_TOLERANCE_PX = 8;

/**
 * The shell's one pointer-capture drag onto a dock region (#2185), shared so
 * that a second grabbable control does not bring a second, uncoordinated
 * gesture with it. The dock's grab (`DockPlacementControl`) moves the dock it
 * sits on; #2175's sidebar pill opens a pane. What they share is everything
 * geometry-free: the capture, the hit test against the fixed edge overlays,
 * the drop, and the rule for which release is a click and which is not.
 *
 * `onDrop` is the consumer's act for a release over one of `placements`;
 * `onClick` is its act for a plain press, and it is GATED here rather than
 * handed back raw so a consumer cannot forget to check the suppression — on a
 * pill whose click navigates, a forgotten check is a drag that routes the user
 * away.
 *
 * THE SUPPRESSION is movement-based, not hit-based. The rule this replaced
 * swallowed the click only when the pointer had passed OVER a target, so a
 * drag that wandered and released on empty space left the click alive; for the
 * dock that reopened a menu, for a navigating control it is a navigation
 * nobody asked for. Now, once the pointer has moved past `MOVE_TOLERANCE_PX`
 * from where it went down, the click is dead wherever it lands. A release over
 * a target is a completed drop and is dead too, whatever distance it took.
 *
 * The flag is cleared in two places and neither is an animation frame: in
 * `onClick` when it is consumed, and again at the next `pointerdown`. That is
 * `useLongPress`'s pair, kept because it is the shape proven against the
 * residue case — an engine that refuses `setPointerCapture` (jsdom does) plus
 * a release the element never sees reaches no click to clear the flag at, and
 * the next press must not inherit a swallowed activation. A `requestAnimationFrame`
 * clear, which this replaced, is a timer standing in for a state transition.
 *
 * Not `useLongPress` itself: that is a timer hook whose product is a hold, and
 * it owns `onContextMenu`; two hooks both claiming the pointer sequence would
 * be a collision, not reuse.
 */
export function usePlacementDrag({
  placements,
  onDrop,
  onClick,
  onDragStart,
}: {
  /** The placements a release can land on; anything else is a no-op. */
  placements: readonly DockMode[];
  onDrop: (placement: DockMode) => void;
  /** The plain press — not called for the click that ends a drag. */
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** A primary press began (the dock closes its menu here). */
  onDragStart?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<DockMode | null>(null);
  const suppressClick = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const placementAt = (x: number, y: number): DockMode | null => {
    const element = document.elementFromPoint(x, y);
    const value = element?.closest<HTMLElement>('[data-dock-placement-target]')
      ?.dataset.dockPlacementTarget;
    return value && placements.includes(value as DockMode)
      ? (value as DockMode)
      : null;
  };
  const finishDrag = () => {
    origin.current = null;
    setDragging(false);
    setHovered(null);
  };

  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // The second of the two clears: a flag the last press left standing
      // (its release never reached this element) must not swallow this one.
      suppressClick.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      // Optional-called: jsdom implements no pointer capture, and a real
      // engine can refuse an id it no longer considers active.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onDragStart?.();
      setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        suppressClick.current = true;
      }
      setHovered(placementAt(event.clientX, event.clientY));
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      if (!origin.current) return;
      const target = placementAt(event.clientX, event.clientY);
      if (target !== null) {
        suppressClick.current = true;
        onDrop(target);
      }
      finishDrag();
    },
    onPointerCancel: finishDrag,
    // The engine took the capture away mid-press (a system gesture, a
    // navigation). No release is coming to this element; a flag the movement
    // set stays up for the click that may still arrive, and the next
    // `pointerdown` clears it if none does.
    onLostPointerCapture: () => {
      if (origin.current) finishDrag();
    },
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (suppressClick.current) {
        // Exactly one click is swallowed; the first of the two clears.
        suppressClick.current = false;
        event.preventDefault();
        return;
      }
      onClick?.(event);
    },
  };

  return { dragging, hovered, handlers };
}

/**
 * The three fixed edge overlays a drag can land on, rendered by the consumer
 * only while `dragging`. `.dock-placement-target` is `position: fixed` in the
 * entry stylesheet (`index.css`), so this is correct from any mount point.
 * Hidden from assistive tech: the drag is the pointer's route, and every
 * consumer keeps a keyboard route of its own (the dock's menu, the pill's
 * context menu).
 */
export function DockPlacementTargets({
  placements,
  active,
}: {
  placements: readonly DockMode[];
  active: DockMode | null;
}) {
  return (
    <div
      className="dock-placement-targets"
      data-testid="dock-placement-targets"
      aria-hidden="true"
    >
      {placements.map((placement) => (
        <div
          key={placement}
          className={`dock-placement-target dock-placement-target--${placement}${
            active === placement ? ' dock-placement-target--active' : ''
          }`}
          data-dock-placement-target={placement}
        >
          {regionLabel(placement)}
        </div>
      ))}
    </div>
  );
}
