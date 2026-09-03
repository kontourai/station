import type { DockSlotGeometry } from '../hooks/dock-slot-geometry';
import type { DockRegionId } from './region-model';

type ClearanceVariable =
  | `--region-${DockRegionId}-size`
  | '--dock-slot-size'
  | '--chat-dock-width';

/**
 * One writer for every shell-clearance CSS variable (archive#3902/#3929 pin
 * exactly one). Each rendered region reports its own geometry; `null`
 * regionId is the legacy single-shell path (`regionId === undefined` in
 * useDockShellChrome.ts). `--dock-slot-size`/`--chat-dock-width` are the
 * pre-#928 aliases still read by index.css and BannerHost.css.
 */
export function createRegionClearanceWriter(root: HTMLElement) {
  const reports = new Map<DockRegionId, DockSlotGeometry>();
  let legacyReport: DockSlotGeometry | null = null;

  const write = (name: ClearanceVariable, value?: number) => {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, `${value}px`);
  };

  const apply = () => {
    const left = reports.get('left');
    const right = reports.get('right');
    const bottom = reports.get('bottom');

    write('--region-left-size', left?.width ?? undefined);
    write('--region-right-size', right?.width ?? undefined);
    write('--region-bottom-size', bottom?.size);

    if (reports.size === 0) {
      write('--dock-slot-size', legacyReport?.size);
      write('--chat-dock-width', legacyReport?.width ?? undefined);
      return;
    }

    write(
      '--dock-slot-size',
      bottom?.size ??
        Math.max(...[...reports.values()].map(({ size }) => size)),
    );
    // The alias names ONE side width. With both sides occupied there is no
    // single width to name, so it is withheld rather than guessed and its
    // readers fall back; the region grid reads the per-region variables.
    const side = left && right ? undefined : (left ?? right);
    write('--chat-dock-width', side?.width ?? undefined);
  };

  return {
    report(
      regionId: DockRegionId | null,
      geometry: DockSlotGeometry | null,
    ): void {
      if (regionId === null) legacyReport = geometry;
      else if (geometry === null) reports.delete(regionId);
      else reports.set(regionId, geometry);
      apply();
    },
  };
}

const defaultWriter =
  typeof document === 'undefined'
    ? null
    : createRegionClearanceWriter(document.documentElement);

export function reportRegionClearance(
  regionId: DockRegionId | null,
  geometry: DockSlotGeometry | null,
): void {
  defaultWriter?.report(regionId, geometry);
}
