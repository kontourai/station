import type { DockSlotGeometry } from '../hooks/dock-slot-geometry';
import type { DockRegionId } from './region-model';

const MANAGED_VARIABLES = [
  '--region-left-size',
  '--region-right-size',
  '--region-bottom-size',
  '--dock-slot-size',
  '--chat-dock-width',
] as const;

export function createRegionClearanceWriter(root: HTMLElement) {
  const reports = new Map<DockRegionId, DockSlotGeometry>();
  let legacyReport: DockSlotGeometry | null = null;

  const write = (name: (typeof MANAGED_VARIABLES)[number], value?: number) => {
    if (value === undefined) root.style.removeProperty(name);
    else if (name === '--dock-slot-size')
      root.style.setProperty('--dock-slot-size', `${value}px`);
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
    // This alias is legacy; the region grid reads the per-region variables.
    write('--chat-dock-width', right?.width ?? left?.width ?? undefined);
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
