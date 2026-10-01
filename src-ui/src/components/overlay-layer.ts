import { createContext } from 'react';

/**
 * The overlay a component is rendered INSIDE, as React sees it.
 *
 * A floating surface (a menu, a popover) has to open above whatever hosts its
 * trigger. DOM ancestry answers that only until something portals: a popover
 * opened from a dialog is mounted at `document.body`, so nothing in its DOM
 * ancestry says a dialog is underneath it. React context does cross a portal,
 * so each overlay surface provides one of these, linked to the overlay it was
 * itself opened from.
 */
export interface OverlayLayer {
  /** An element inside the overlay; its ancestors carry the overlay's z-index. */
  element: () => HTMLElement | null;
  parent: OverlayLayer | null;
}

export const OverlayLayerContext = createContext<OverlayLayer | null>(null);

function highestAncestorLayer(element: HTMLElement | null): number {
  let highest = 0;
  for (let node = element; node; node = node.parentElement) {
    const layer = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(layer) && layer > highest) highest = layer;
  }
  return highest;
}

/**
 * The highest z-index among everything that hosts `trigger`: its own DOM
 * ancestors (a dialog it sits in, on whatever layer that dialog uses —
 * including the system layer) and every overlay above it in the React tree
 * (a dialog its popover was opened from). 0 when nothing declares a layer,
 * which is also what an engine that computes no styles reports.
 *
 * Read from COMPUTED style, not from a list of known surfaces: a surface
 * written later, or one that takes a higher layer, is covered without this
 * knowing its name.
 */
export function hostLayerOf(
  trigger: HTMLElement,
  overlay: OverlayLayer | null,
): number {
  let highest = highestAncestorLayer(trigger);
  for (let layer = overlay; layer; layer = layer.parent) {
    highest = Math.max(highest, highestAncestorLayer(layer.element()));
  }
  return highest;
}
