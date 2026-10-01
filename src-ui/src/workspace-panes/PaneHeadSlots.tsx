import { createContext, useContext } from 'react';

/**
 * The head row a chromeless host draws over ONE occupant (the Coding
 * layout's side and lower panels, #3046 round): the host writes the pane's
 * name there as the row's heading, and offers the pane two places in the
 * same row for its own controls — `leading` right after the name (a tab
 * strip), `trailing` before the host's close (an add button). A pane that
 * reads a provider renders its controls into them through a portal and
 * draws no title row of its own, so a panel has one head and one heading.
 *
 * `null` element: the row has not mounted its slot yet (the first render).
 * No provider: the pane is on its own (a drill-in page, a dock region, a
 * layout) and keeps its own title row.
 */
export interface PaneHeadSlots {
  leading: HTMLElement | null;
  trailing: HTMLElement | null;
}

export const PaneHeadSlotsContext = createContext<PaneHeadSlots | null>(null);

export function usePaneHeadSlots(): PaneHeadSlots | null {
  return useContext(PaneHeadSlotsContext);
}
