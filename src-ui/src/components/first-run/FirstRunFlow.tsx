/**
 * FirstRunFlow — the guided tour (archive#2652 chapter 4).
 *
 * WHAT THIS IS NOW, AND WHAT IT WAS. This used to be the whole guided run:
 * connect → "which agents do you use?" → about you → tour, all four chapters
 * rendered as fixed bottom-right cards at `--layer-notice` from an app-level
 * mount, on whatever route the user happened to be on. The UX audit (RT-02,
 * SHELL-12) found both halves of that broken — the run either never started or
 * started ten seconds into someone's work, and the cards occluded page content
 * and out-stacked modal scrims. The questions moved to `FirstRunHomeChapter`,
 * which renders on Home as a real dialog and is gated by a durable fact about
 * the home rather than by whether a session saw the connect launcher.
 *
 * What is left here is the part that is genuinely cross-route BY DESIGN: the
 * tour anchors `Coachmark`s over real surfaces and navigates to each one by
 * the canonical path the step derives from the routing module. It is entered
 * on purpose — from the command palette's "Take the tour", or from the chapter
 * handing off when it completes — never on a probe, a timer or a boot.
 *
 * Mounted beside `CommandPalette` in `DeferredAppOverlays`: the tour needs the
 * same tree the palette has so a palette action can drive it.
 *
 * Progress is persisted on every step (`firstRunStore`), so closing the app
 * mid-tour resumes where it stopped rather than restarting or disappearing.
 *
 * Focus (archive#2652): the run captures the return target when it
 * is *asked for* — before its own surface mounts — and restores it when the
 * run ends, using the shared `captureReturnFocus`/`restoreReturnFocus`
 * helpers. Capture/restore live here rather than in `Coachmark` deliberately:
 * the coachmark unmounts and remounts on every step (`key={step.id}`), so a
 * per-coachmark restore would fire on each step transition and fight the
 * tour's own navigation. One capture per run, one restore per run.
 */

import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useShowSurface } from '../../contexts/RegionModelContext';
import { Coachmark } from './Coachmark';
import {
  firstRunStore,
  isKnownFirstRunChapter,
  resolveResumePoint,
  resolveTourEntryPoint,
  START_FIRST_RUN_TOUR_EVENT,
  useFirstRunProgress,
} from './first-run-store';
import { FIRST_RUN_TOUR_STEPS, tourStepPath } from './tour-steps';

export function FirstRunFlow() {
  const progress = useFirstRunProgress();
  const { navigate } = useNavigation();
  const showSurface = useShowSurface();

  // `active` is state, not derived from `progress`, precisely so a finished
  // tour stays finished until someone explicitly asks for it again. A cold
  // boot that stopped mid-tour resumes it; every other chapter value means
  // the tour is not what is on screen.
  const [active, setActive] = useState(() => progress.chapter === 'tour');
  const [stepIndex, setStepIndex] = useState(
    () => resolveResumePoint(progress).stepIndex,
  );
  const lastNavigatedStep = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const restoreFrameRef = useRef<number | null>(null);
  // Discard a scheduled restore if this component goes away before the frame
  // runs, matching `CommandPalette`'s cancel-on-cleanup.
  useEffect(
    () => () => {
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
    },
    [],
  );

  /**
   * Capture the return target at the moment the tour is *asked* for — before
   * our own surface mounts and focuses itself, which is why this cannot be
   * done in an effect.
   *
   * WHAT THIS ACTUALLY CAPTURES (archive#2652). We are
   * usually invoked FROM an overlay: `CommandPalette.runCommand` is `close;
   * command.run;`, and `close` is a batched `setOpen(false)` that has not
   * flushed when `run` calls us — so `document.activeElement` is still the
   * palette's own `<input>`, which unmounts a tick later. At restore time
   * `applyReturnFocus` skips that disconnected node and walks to the nearest
   * surviving ancestor. That is the shared module's documented "sensible
   * substitute" tier, not the archive#1126 focus-to-body defect, and the palette
   * separately restores the true trigger on its own close. Started from a
   * persistent control, we do return to that control exactly.
   *
   * The capture reads `activeRef` and runs in the event handler, NOT inside a
   * `setActive` updater. A state updater must be pure — React may invoke it
   * twice under StrictMode and calls it during render, so capturing there
   * would read `document.activeElement` at an unpredictable moment.
   */
  const activeRef = useRef(active);
  activeRef.current = active;
  const beginRun = useCallback((next: () => void) => {
    if (!activeRef.current) returnFocusRef.current = captureReturnFocus();
    activeRef.current = true;
    setActive(true);
    next();
  }, []);

  // Downgrade safety (archive#2652). `firstRunProgress` is a
  // composite device setting persisted verbatim, so a chapter written by a
  // newer Station survives a downgrade — and this build renders nothing for
  // it. `resolveResumePoint`'s documented "restart rather than crash"
  // fallback could not help while nothing read its chapter; this is what
  // reads it.
  useEffect(() => {
    if (isKnownFirstRunChapter(progress.chapter)) return;
    firstRunStore.enterChapter(resolveResumePoint(progress).chapter);
  }, [progress]);

  // The only way in: `requestFirstRunTour`, from the command palette or from
  // `FirstRunHomeChapter` completing. The action says "Take the tour", so it
  // opens the TOUR — `resolveTourEntryPoint`, not the general resume rule,
  // which would reopen a chapter the user already left.
  useEffect(() => {
    const start = () => {
      const entry = resolveTourEntryPoint(firstRunStore.getSnapshot());
      beginRun(() => {
        firstRunStore.enterChapter(entry.chapter);
        setStepIndex(entry.stepIndex);
        // a previous run left this pinned to the step it ended on,
        // so re-entry at that same step would skip its own navigation and
        // render an unanchored coachmark over whatever page the user is on.
        lastNavigatedStep.current = null;
      });
    };
    window.addEventListener(START_FIRST_RUN_TOUR_EVENT, start);
    return () => window.removeEventListener(START_FIRST_RUN_TOUR_EVENT, start);
  }, [beginRun]);

  const inTour = active && progress.chapter === 'tour';
  const step = inTour ? FIRST_RUN_TOUR_STEPS[stepIndex] : undefined;

  // Take the user to the surface a step is about, then let `Coachmark` find
  // the anchor there. Navigating once per step (not per render) keeps the tour
  // from fighting a user who clicks something else on the page.
  useEffect(() => {
    if (!step) return;
    if (lastNavigatedStep.current === step.id) return;
    lastNavigatedStep.current = step.id;
    firstRunStore.recordTourStep(step.id);
    if ('surface' in step && step.surface) {
      showSurface(step.surface);
      return;
    }
    const path = tourStepPath(step);
    // `null` means the step names a view the router cannot serialize — an
    // authoring mistake the tour tests fail on. Skip the navigation rather
    // than sending the user to a guessed route.
    if (path) navigate(path);
  }, [step, navigate, showSurface]);

  const endRun = useCallback(() => {
    firstRunStore.finish();
    setActive(false);
    lastNavigatedStep.current = null;
    const chain = returnFocusRef.current;
    returnFocusRef.current = [];
    if (chain.length > 0) restoreFrameRef.current = restoreReturnFocus(chain);
  }, []);

  if (!step) return null;

  return (
    <Coachmark
      key={step.id}
      anchor={step.anchor}
      title={step.title}
      body={step.body}
      stepNumber={stepIndex + 1}
      stepCount={FIRST_RUN_TOUR_STEPS.length}
      isLastStep={stepIndex === FIRST_RUN_TOUR_STEPS.length - 1}
      onNext={() => {
        if (stepIndex === FIRST_RUN_TOUR_STEPS.length - 1) {
          endRun();
          return;
        }
        setStepIndex(stepIndex + 1);
      }}
      onBack={() => setStepIndex(Math.max(0, stepIndex - 1))}
      onSkip={endRun}
    />
  );
}
