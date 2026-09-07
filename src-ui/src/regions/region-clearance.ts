import type { DockSlotGeometry } from '../hooks/dock-slot-geometry';
import type { DockRegionId } from './region-model';

type ClearanceVariable = `--region-${DockRegionId}-size` | '--dock-slot-size';

/**
 * One writer for every shell-clearance CSS variable (archive#3902/#3929 pin
 * exactly one). Each rendered region reports its own geometry, keyed by the
 * region it renders — including the legacy single-shell mount, which has no
 * `RegionModelProvider` above it but still knows its placement
 * (useDockShellChrome.ts).
 *
 * `--dock-slot-size` is the surviving pre-#928 alias: it names the space the
 * dock takes along the BOTTOM edge, which is one number whatever else is
 * occupied. Five stylesheets and one measuring component read it (index.css,
 * OnboardingGate, SplitPaneLayout, GlobalVoiceButton, SettingsView and
 * Coachmark.tsx), and `dock-bottom-clearance.test.ts` pins this file as its
 * only writer.
 *
 * Its side-width counterpart is retired (#1374; the spelling lives
 * once, in `placement-vocabulary.test.ts`, which keeps it from coming
 * back): one name cannot carry two side widths, and while it existed it
 * made one side's width the DECLARED fallback for the other. A probe over
 * these stylesheets shows what that renders — a left grid track and a left
 * banner inset of 260px, the right dock's width — though reaching it needs
 * a `[data-region]` in the DOM while its per-region variable is unwritten,
 * and the writer's layout effect runs in the same commit as the mutation,
 * so no mount is known to have rendered it. A wrong-side fallback is worth
 * removing whether or not anything reached it. Side
 * widths are `--region-left-size` and `--region-right-size`, and a reader
 * that means "the side width" reads the side it means.
 */
export function createRegionClearanceWriter(root: HTMLElement) {
  const reports = new Map<DockRegionId, DockSlotGeometry>();

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
    // A side report's `size` is 0 (dock-slot-geometry.ts), so this is the
    // bottom occupant's height when there is one and 0 otherwise. The
    // emptiness guard is not decoration: `Math.max()` of nothing is
    // -Infinity, which would publish `-Infinitypx` on the last unmount.
    write(
      '--dock-slot-size',
      reports.size === 0
        ? undefined
        : (bottom?.size ??
            Math.max(...[...reports.values()].map(({ size }) => size))),
    );
  };

  return {
    report(regionId: DockRegionId, geometry: DockSlotGeometry | null): void {
      if (geometry === null) reports.delete(regionId);
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
  regionId: DockRegionId,
  geometry: DockSlotGeometry | null,
): void {
  defaultWriter?.report(regionId, geometry);
}
