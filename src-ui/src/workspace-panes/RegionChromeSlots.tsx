import { createContext, useContext } from 'react';
import type { OverflowAction } from '../components/ActionOverflowMenu';

/**
 * The region's own commands (move the shown pane, add a pane, maximize), as
 * rows a pane can fold into its own overflow menu. A pane that does so calls
 * `absorb` while it shows them, and the bar drops its separate buttons for
 * the same commands, so the bar holds one overflow rather than a menu plus
 * three icons. A pane that does not absorb them leaves the bar's buttons as
 * they are.
 */
export interface RegionMenu {
  actions: readonly OverflowAction[];
  /** Claims the rows for the pane's menu; returns the release. */
  absorb: () => () => void;
}

/**
 * The two places in a region's chrome bar where the SELECTED pane's own
 * toolbar content renders (#2046 2b): `leading` sits after the tab strip in
 * the bar's title cluster (Chat's identity, context meter and project
 * context), `trailing` before the region controls in its actions cluster
 * (Chat's session counter, unread badge and More menu). A pane renders into
 * them through a portal, so the dock keeps ONE chrome bar — the region's —
 * rather than stacking a pane bar under it (#1064 and #3309 both spent a row
 * on exactly that, and the row was transcript space).
 *
 * `null` element: the bar has not mounted its slot yet (the first render), or
 * this region renders no bar (a coarse device shows Chat's own mobile header
 * instead). No provider at all: the pane is not inside a region host — the
 * full-screen Chat placement — and renders its toolbar as its own bar.
 */
export interface RegionChromeSlots {
  leading: HTMLElement | null;
  trailing: HTMLElement | null;
  /**
   * The bar already names the pane (the Coding layout's breadcrumb carries
   * the conversation's title, #3046): the pane omits its own identity from
   * `leading` and keeps its labelled actions icon-only, named and tipped,
   * so the title appears once and the bar stays within the button cap.
   */
  namesPane?: boolean;
  /** Absent outside a region host (the Coding workbench's bar). */
  regionMenu?: RegionMenu;
}

export const RegionChromeSlotsContext = createContext<RegionChromeSlots | null>(
  null,
);

export function useRegionChromeSlots(): RegionChromeSlots | null {
  return useContext(RegionChromeSlotsContext);
}
