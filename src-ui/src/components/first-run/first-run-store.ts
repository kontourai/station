/**
 * first-run-store — where the guided first run got to on this device
 * (archive#2652).
 *
 * Module-singleton over `deviceSettingsStore`, mirroring
 * `contexts/onboarding-setup-store.ts` exactly: `getSnapshot` reads the device
 * store live on every call (so an import or a cross-tab change is never stale)
 * and the constructor forwards the device store's own notifications to this
 * store's `useSyncExternalStore` subscribers.
 *
 * What is NOT here: the About-you answers. Those are server-scope
 * (`AppConfig.userProfile`) because Station's engine reads them at turn time.
 * This store holds only progress — which chapter, which tour step — which is a
 * property of this browser/app install, like `onboardingSetupDismissed`.
 */

import {
  DEFAULT_FIRST_RUN_PROGRESS,
  type FirstRunChapter,
  type FirstRunProgress,
} from '@kontourai/station-contracts/device-settings';
import { useSyncExternalStore } from 'react';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { FIRST_RUN_TOUR_STEPS, tourStepIndexForId } from './tour-steps';

type Listener = () => void;

/**
 * Every chapter THIS build can render.
 *
 * `firstRunProgress` is a composite device setting persisted verbatim, so a
 * chapter written by a newer Station survives a downgrade byte-for-byte. This
 * build then renders nothing for it — `FirstRunFlow` switches on the chapter
 * directly and falls through every branch — which is a dead first run with no
 * way out, because the connect→next transition only fires from `connect`.
 * `resolveResumePoint`'s documented "restart rather than crash" fallback was
 * inert against that: nothing read its `chapter`.
 *
 * Declared as an exhaustive record rather than a hand-written list: adding a
 * chapter to `FirstRunChapter` without adding it here fails typecheck, so this
 * cannot silently fall behind the union it guards.
 */
const KNOWN_FIRST_RUN_CHAPTERS: Record<FirstRunChapter, true> = {
  connect: true,
  engines: true,
  'about-you': true,
  tour: true,
  done: true,
};

/**
 * `Object.hasOwn`, never `in` : `in` walks the prototype
 * chain, so `'toString'`, `'constructor'`, `'valueOf'` and `'__proto__'` all
 * read as known chapters. That is reachable — `firstRunProgress` is a
 * composite device setting with no shape validator, so Settings Import
 * accepts any plain object — and it restores exactly the dead first run this
 * guard exists to remove.
 */
export function isKnownFirstRunChapter(
  chapter: string | undefined,
): chapter is FirstRunChapter {
  return (
    chapter !== undefined && Object.hasOwn(KNOWN_FIRST_RUN_CHAPTERS, chapter)
  );
}

/** Where a resume or a re-trigger should put the user. */
export interface FirstRunResumePoint {
  chapter: FirstRunChapter;
  /** Only meaningful when `chapter === 'tour'`. */
  stepIndex: number;
}

/**
 * Resolve where to (re)enter the first run from persisted progress.
 *
 * - A partial run resumes at the chapter it stopped in, and a partial tour at
 *   the step it stopped on — that is what "skipping persists progress" buys.
 * - A finished run re-entered on purpose (the command-palette action) restarts
 *   the tour from its first step, because there is nothing left to resume and
 *   dropping someone on the last coachmark of a tour they asked to see again
 *   is not a resume.
 * - An unrecognised chapter (written by a newer Station, then downgraded)
 *   restarts rather than crashing or inventing a position.
 */
export function resolveResumePoint(
  progress: FirstRunProgress | null | undefined,
): FirstRunResumePoint {
  const chapter = progress?.chapter;
  switch (chapter) {
    case 'connect':
    case 'engines':
    case 'about-you':
      return { chapter, stepIndex: 0 };
    case 'tour':
      return {
        chapter: 'tour',
        stepIndex: tourStepIndexForId(progress?.tourStepId),
      };
    case 'done':
      return { chapter: 'tour', stepIndex: 0 };
    default:
      return { chapter: DEFAULT_FIRST_RUN_PROGRESS.chapter, stepIndex: 0 };
  }
}

/**
 * Where the explicit "Take the tour" action should land
 *
 * Distinct from `resolveResumePoint` on purpose. That rule answers "continue
 * the guided run where it stopped", which for a run abandoned at the questions
 * means the questions. This one answers a command the user typed whose label
 * says *tour* — so it opens the tour, resuming the step only when the tour is
 * genuinely what was interrupted. An action that reopens a form the user
 * declined is the action lying about what it does.
 */
export function resolveTourEntryPoint(
  progress: FirstRunProgress | null | undefined,
): FirstRunResumePoint {
  return {
    chapter: 'tour',
    stepIndex:
      progress?.chapter === 'tour'
        ? tourStepIndexForId(progress.tourStepId)
        : 0,
  };
}

class FirstRunStore {
  private listeners = new Set<Listener>();

  constructor() {
    deviceSettingsStore.subscribe(() => this.notify());
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FirstRunProgress =>
    deviceSettingsStore.get('firstRunProgress');

  /** Move to a chapter, clearing any tour position that no longer applies. */
  enterChapter = (chapter: FirstRunChapter) => {
    const current = this.getSnapshot();
    if (current.chapter === chapter && chapter !== 'tour') return;
    deviceSettingsStore.set('firstRunProgress', { chapter });
  };

  /** Record the tour step the user is looking at, so leaving resumes here. */
  recordTourStep = (stepId: string) => {
    const current = this.getSnapshot();
    if (current.chapter === 'tour' && current.tourStepId === stepId) return;
    deviceSettingsStore.set('firstRunProgress', {
      chapter: 'tour',
      tourStepId: stepId,
    });
  };

  /**
   * The run is over — by finishing it or by skipping out of it. Both persist
   * the same way on purpose: a skip is a decision, and re-asking someone who
   * already said no is how first-run experiences get resented.
   */
  finish = () => {
    const current = this.getSnapshot();
    const lastStepId = FIRST_RUN_TOUR_STEPS[FIRST_RUN_TOUR_STEPS.length - 1].id;
    if (current.chapter === 'done') return;
    deviceSettingsStore.set('firstRunProgress', {
      chapter: 'done',
      tourStepId: current.tourStepId ?? lastStepId,
    });
  };

  reset = () => {
    deviceSettingsStore.reset('firstRunProgress');
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

export const firstRunStore = new FirstRunStore();

export function useFirstRunProgress(): FirstRunProgress {
  return useSyncExternalStore(
    firstRunStore.subscribe,
    firstRunStore.getSnapshot,
    firstRunStore.getSnapshot,
  );
}

/** Cross-tree trigger, matching the repo's `open-command-palette` idiom. */
export const START_FIRST_RUN_TOUR_EVENT = 'station-start-first-run-tour';

export function requestFirstRunTour(): void {
  window.dispatchEvent(new CustomEvent(START_FIRST_RUN_TOUR_EVENT));
}
