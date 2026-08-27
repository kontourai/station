/**
 * tour-steps — the anchored coachmark tour that teaches why evidence sits
 * beside work (station#2652 chapter 3).
 *
 * Two rules this module exists to hold:
 *
 * 1. **No step spells a route.** Each step names the canonical surface as a
 *    `NavigationView`, and `tourStepPath` derives the path through
 *    `getPathForView` — the same helper `OnboardingGate`, the header, and the
 *    sidebar already navigate with. Post-#2678 the repo has exactly one
 *    spelling per surface plus a central retirement table
 *    (`getLegacyPathRedirect`); a tour that hardcoded `/connections/models`
 *    would still "work" via that redirect and would quietly reintroduce the
 *    retired name. `__tests__/tour-steps.test.ts` asserts every derived path
 *    against the routing module for exactly this reason.
 *
 * 2. **Every anchor is a real surface.** `anchor` is a `data-first-run-anchor`
 *    value present in shipped UI, not a coordinate or a synthetic panel the
 *    tour renders for itself. When the element is genuinely absent (a surface
 *    still loading, a host that does not render the sidebar), `Coachmark`
 *    falls back to an unanchored card rather than pointing at nothing.
 */

import { getPathForView } from '../../app-shell/routing';
import type { NavigationView } from '../../types';

export interface FirstRunTourStep {
  id: string;
  title: string;
  /** One sentence. Why the evidence is here, not what the button does. */
  body: string;
  /** The canonical surface this step is about. */
  view: NavigationView;
  /** `data-first-run-anchor` value on that surface. */
  anchor: string;
}

export const FIRST_RUN_ANCHOR_ATTRIBUTE = 'data-first-run-anchor';

export const FIRST_RUN_TOUR_STEPS = [
  {
    id: 'review-queue',
    title: 'Decisions are part of the record',
    body: 'Work that needs your approval stops here, and the decision you make is kept with the run that asked for it — so later you can see not just what happened, but who let it.',
    view: { type: 'review-queue' },
    anchor: 'review-queue',
  },
  {
    id: 'activity',
    title: 'Every run keeps its own evidence',
    body: 'Each session holds the events that produced its result, so an answer can be traced back to the work behind it instead of being taken on trust.',
    view: { type: 'activity' },
    // The Activity page root, via `SplitPaneLayout`'s `firstRunAnchor` prop:
    // the surface no longer has a sidebar entry (it moved under Home), and
    // `SessionsView` renders a bare `SplitPaneLayout` with no root element of
    // its own to hang the attribute on. The layout root is present whether or
    // not any session exists yet.
    anchor: 'activity',
  },
  {
    id: 'schedule',
    title: 'Unattended work is held to the same standard',
    body: 'A scheduled job produces the same evidence as work you start yourself, because nobody is watching it — which is exactly when a receipt matters most.',
    view: { type: 'schedule' },
    anchor: 'schedule',
  },
  {
    id: 'command-palette',
    title: 'Everything is one keystroke away',
    body: 'The command palette reaches every surface here, including this tour — press it whenever you want to come back and look at the evidence again.',
    view: { type: 'home' },
    anchor: 'command-palette',
  },
] as const satisfies readonly FirstRunTourStep[];

export type FirstRunTourStepId = (typeof FIRST_RUN_TOUR_STEPS)[number]['id'];

/**
 * The canonical path for a step's surface, derived — never spelled here.
 *
 * `null` only for a view type `getPathForView` cannot serialize (`not-found`),
 * which is a step-authoring mistake the test suite fails on rather than a
 * runtime state to paper over with a fallback route.
 */
export function tourStepPath(step: FirstRunTourStep): string | null {
  return getPathForView(step.view);
}

/**
 * Index of a persisted step id, or `0` when the id is absent or names a step
 * that no longer exists. A retired id resumes at the start of the tour; it
 * never resolves to "somewhere near where that used to be", because a guessed
 * position is indistinguishable from a real one to the person reading it.
 */
/**
 * station#3280 review finding 1: `tourStepId` is DURABLE resume state
 * (device-settings.ts), so a step rename must keep every previously
 * persisted id resolving to the renamed step — not silently to step 0.
 */
const PERSISTED_TOUR_STEP_ALIASES: Readonly<Record<string, string>> = {
  sessions: 'activity',
};

export function tourStepIndexForId(id: string | undefined): number {
  if (!id) return 0;
  const canonical = PERSISTED_TOUR_STEP_ALIASES[id] ?? id;
  const index = FIRST_RUN_TOUR_STEPS.findIndex((step) => step.id === canonical);
  return index >= 0 ? index : 0;
}
