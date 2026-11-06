import { type FoldGeometry, sameFoldGeometry } from './foldGeometry';

/**
 * The one place the crease lives. Sources publish here; layouts read it
 * through `useFoldSplit` (element-relative) or, for CSS that only needs the
 * document-level fact, through what `applyFoldGeometryToDocument` writes:
 *
 * - `data-fold-posture="folded|flat"` and `data-fold-axis="vertical|horizontal"`
 *   on `<html>`, present only while a crease is known;
 * - `--station-hinge-x`, `--station-hinge-y`, `--station-hinge-width`,
 *   `--station-hinge-height` (CSS pixels of the layout viewport), the
 *   `env(viewport-segment-*)`-like values Safari does not provide.
 *
 * With no crease every attribute and property is removed, so a layout that
 * reads them falls back to exactly what it did before.
 */

let current: FoldGeometry | null = null;
const listeners = new Set<() => void>();

export function getFoldGeometry(): FoldGeometry | null {
  return current;
}

export function subscribeFoldGeometry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const HINGE_PROPERTIES = {
  x: '--station-hinge-x',
  y: '--station-hinge-y',
  width: '--station-hinge-width',
  height: '--station-hinge-height',
} as const;

export function applyFoldGeometryToDocument(
  geometry: FoldGeometry | null,
  root: HTMLElement = document.documentElement,
): void {
  if (!geometry) {
    delete root.dataset.foldPosture;
    delete root.dataset.foldAxis;
    for (const property of Object.values(HINGE_PROPERTIES))
      root.style.removeProperty(property);
    return;
  }
  root.dataset.foldPosture = geometry.posture;
  root.dataset.foldAxis = geometry.axis;
  for (const [key, property] of Object.entries(HINGE_PROPERTIES)) {
    root.style.setProperty(
      property,
      `${Math.round(geometry.hinge[key as keyof typeof HINGE_PROPERTIES])}px`,
    );
  }
}

export function publishFoldGeometry(next: FoldGeometry | null): void {
  if (sameFoldGeometry(current, next)) return;
  current = next;
  if (typeof document !== 'undefined') applyFoldGeometryToDocument(next);
  for (const listener of listeners) listener();
}
