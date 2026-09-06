/**
 * FirstRunHomeChapter — the guided first run, as one chapter with a surface of
 * its own (UX audit RT-02, SHELL-12).
 *
 * THREE THINGS THIS FIXES, and where each used to live:
 *
 * 1. **WHEN.** Activation was `sawSetupLauncher` in `FirstRunFlow` — a session
 *    that saw the connect launcher. The launcher's visibility comes from
 *    `/api/system/status`, so on a machine with `claude`/`codex` installed the
 *    engines were ready on first paint, the launcher never appeared, and the
 *    run never happened at all. When that probe flapped to `cannot_verify`
 *    instead, the run DID start — ten seconds into whatever the user was
 *    doing. Activation is now `resolveFirstRunOffer` over a durable fact about
 *    the home, so it cannot depend on a probe, on load, or on timing.
 *
 * 2. **WHERE.** The chapters rendered as fixed bottom-right cards at
 *    `--layer-notice`, on every route, above modal scrims and the command
 *    palette. This renders inside Home (`HomeView`) and nowhere else, as a
 *    `ResponsiveDialogSurface` — the same chrome the New Project modal uses,
 *    at `--layer-dialog`, with its scrim, focus trap and Escape handling.
 *    Leaving Home ends the render; there is nothing left to follow the user.
 *
 * 3. **HOW IT ENDS.** "Not now" is a decision and is written down, so the
 *    chapter does not re-open by itself; Home keeps a card offering it until
 *    it is completed. Completing it writes the same durable fact and hands off
 *    to New Chat, or to the tour when explicitly chosen. New Chat owns
 *    readiness, Agent/Model selection, and the current workspace context.
 */

import type { UserProfileSettings } from '@kontourai/station-contracts/user-profile';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useConfig,
  useConfigActions,
  useConfigSettled,
} from '../../contexts/ConfigContext';
import {
  firstRunChapterPresence,
  useOnboardingSetupState,
} from '../../contexts/onboarding-setup-store';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import {
  dismissUsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
  useUsageTelemetryDisclosureState,
} from '../UsageTelemetryDisclosure';
import { AboutYouStep } from './AboutYouStep';
import {
  FirstRunEnginesChapter,
  useFirstRunEngineOptions,
} from './EnginesStep';
import {
  FIRST_RUN_COMPLETED,
  FIRST_RUN_DEFERRED,
  resolveFirstRunOffer,
} from './first-run-gate';
import './FirstRunHomeChapter.css';
import {
  firstRunStore,
  requestFirstRunTour,
  useFirstRunProgress,
} from './first-run-store';

const loadFirstRunEnginePicker = () =>
  import('../EnginePicker').then((module) => ({
    default: module.EnginePicker,
  }));

/**
 * The run's steps, in order.
 *
 * `disclosure` is here rather than in a modal of its own because it is part of
 * onboarding: `OnboardingGate` mounts the standalone
 * `<UsageTelemetryDisclosure firstRun />` after its children, so on a fresh
 * home it landed at `--layer-dialog` ON TOP of this chapter — two modals on
 * the first screen a person ever sees. `shouldRenderUsageTelemetryDisclosure`
 * withholds that modal while this home is `pending`; this step is where the
 * same disclosure, the same acknowledgement and the same "Not now" live
 * instead.
 */
type ChapterStep = 'disclosure' | 'engines' | 'about-you';

/**
 * The run WITHOUT the disclosure, for a home that has already acknowledged it
 * (or whose host cannot answer for it). The step counter reads from whichever
 * of these two the run actually opened with, so "Step 1 of 3" is never a
 * promise of a step that will not happen.
 */
const CHAPTER_STEPS: ChapterStep[] = ['engines', 'about-you'];
const CHAPTER_STEPS_WITH_DISCLOSURE: ChapterStep[] = [
  'disclosure',
  ...CHAPTER_STEPS,
];

const STEP_TITLES: Record<ChapterStep, string> = {
  disclosure: 'What Station sends',
  engines: 'Which agents do you use?',
  'about-you': 'Two questions, and the next answer is tuned to you',
};

/**
 * Home's durable way back into a run that was deferred — and the reason "Not
 * now" is safe to click.
 *
 * A CARD IN THE PAGE, not a floating one: the audit's whole complaint about
 * the previous surface was that it owned pixels it had no claim to. This one
 * scrolls with Home and occludes nothing.
 */
function FirstRunHomeCard({ onOpen }: { onOpen: () => void }) {
  return (
    // A <p>, not a heading: this card renders ABOVE Home's own <h1>, and a
    // heading there either outranks the page title or lands out of order.
    // `aria-label` gives the region its name without inventing a level.
    <section
      className="first-run-home-card"
      aria-label="Finish setting up Station"
      data-testid="first-run-home-card"
    >
      <div>
        <p className="first-run-home-card__title">Finish setting up Station</p>
        <p className="first-run-home-card__body">
          Pick the agent CLIs you use and tell Station how you like your
          answers. Two minutes, and you can change everything later.
        </p>
      </div>
      <button
        type="button"
        className="editor-btn editor-btn--primary"
        onClick={onOpen}
      >
        Set up Station
      </button>
    </section>
  );
}

export function FirstRunHomeChapter() {
  const config = useConfig();
  const { updateConfig, recordFirstRunDecision } = useConfigActions();
  const configSettled = useConfigSettled();
  const offer = resolveFirstRunOffer(config?.firstRun);
  const progress = useFirstRunProgress();
  const { options, settled } = useFirstRunEngineOptions();
  // The RAW probe answer, not `isBlockingFullScreen`  Once this
  // chapter is open the launcher is suppressed, so `isBlockingFullScreen` is
  // false BECAUSE of us — gating our own open on it would be circular.
  const { launcherWouldShow } = useOnboardingSetupState();
  // Only to know whether the LAUNCHER question has been answered IN THIS
  // SESSION — see the auto-open effect.
  //
  // `isFetching`, not `isLoading`: `['system-status']` is a persisted query
  // (`lib/queryPersistence.ts`), so a boot has the PREVIOUS session's answer
  // before the network says anything, and a restored query has data and is
  // therefore never "loading". Reading that as settled opened the chapter on
  // last session's "chat is ready" and left this session's launcher rendering
  // underneath its scrim, with "Continue Without Setup" unclickable — caught
  // by the first-run E2E bucket after main's merge. It still goes false on an
  // ERROR, so a status query that fails lets the run open rather than
  // stranding it, which is the RT-02 failure mode.
  const { isFetching: systemStatusUnconfirmed } = useSystemStatus();
  // Whether this run has a disclosure to make. The SAME query the standalone
  // modal reads (React Query dedupes on the key), so the two cannot disagree
  // about whether there is anything outstanding. `data` is only read for the
  // inventory revision a dismissal is recorded against.
  const {
    settled: disclosureSettled,
    outstanding: disclosureOutstanding,
    data: disclosureData,
  } = useUsageTelemetryDisclosureState();

  const [open, setOpen] = useState(false);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const [steps, setSteps] = useState<ChapterStep[]>(CHAPTER_STEPS);
  const [step, setStep] = useState<ChapterStep>('engines');
  const [saving, setSaving] = useState(false);
  const completionInFlight = useRef(false);
  const completionGeneration = useRef(0);
  useEffect(
    () => () => {
      completionGeneration.current += 1;
    },
    [],
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  // Opening decides the run's shape ONCE, from an answered disclosure query.
  // Deciding it per render would let the counter change under the reader, and
  // deciding it from an unanswered query would either skip a disclosure that
  // was outstanding or promise a step that is not coming.
  const openChapter = useCallback(() => {
    const plan = disclosureOutstanding
      ? CHAPTER_STEPS_WITH_DISCLOSURE
      : CHAPTER_STEPS;
    const resumedStep =
      progress.chapter === 'about-you'
        ? 'about-you'
        : progress.chapter === 'engines'
          ? 'engines'
          : plan[0];
    setSteps(plan);
    setStep(resumedStep);
    setSaveError(null);
    setOpen(true);
  }, [disclosureOutstanding, progress.chapter]);

  // Auto-open is a ONE-SHOT per mount, latched on a ref rather than driven by
  // `offer.autoOpen` every render. Without the latch, closing the dialog while
  // the durable write is still in flight would re-open it on the very next
  // render — `firstRun.status` is still `pending` until the PUT lands and the
  // config query refetches.
  //
  // THE CONNECT LAUNCHER STILL GOES FIRST, and this is the ONLY thing it
  // decides. `OnboardingGate`'s launcher covers the screen on a Station with
  // nothing configured, and `ProjectNewViewGate` already suppresses its own
  // modal for the same reason — stacking a second overlay on top of it is a
  // redundant interruption. This is NOT the old `sawSetupLauncher` rule
  // returning: that rule decided WHETHER the run ever happened, from a probe,
  // and answered "never" on a machine with a CLI installed. This decides only
  // WHEN, within one page load, an already-decided run opens; the durable fact
  // still says it must. And it can only ever DELAY an open: the latch means a
  // launcher that re-appears later (the probe flapping back to
  // `cannot_verify`) cannot close a chapter that is already up, so presence
  // never toggles.
  //
  // AND ONLY FROM A CONFIRMED READ. `['config']` is persisted to IndexedDB, so
  // a boot renders the PREVIOUS session's snapshot before the network answers
  // which still says `pending` for a run that was deferred moments earlier.
  // Auto-opening from that put the chapter back over a decision the user had
  // already made (observed live, intermittently). Rendering the Home CARD from
  // the restored copy is fine and stays: it offers, it does not interrupt.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (
      autoOpened.current ||
      !offer.autoOpen ||
      launcherWouldShow ||
      progress.deferred === true ||
      progress.chapter === 'tour' ||
      progress.chapter === 'done'
    )
      return;
    if (!configSettled) return;
    // `launcherWouldShow` is FALSE while the status query is unconfirmed —
    // both while it is in flight (`!!status && …`) and while it is showing a
    // RESTORED answer from the previous session. Firing on either answered the
    // launcher question before it had been asked for this session: the chapter
    // opened, and the launcher then rendered UNDER its scrim, which made
    // "Continue Without Setup" unclickable (caught by the first-run E2E
    // bucket, twice — once for each of those two cases).
    if (systemStatusUnconfirmed) return;
    // AND ONLY ONCE THE DISCLOSURE QUERY HAS ANSWERED. It decides whether the
    // run is two steps or three, and the header says which — opening on an
    // unanswered query would print a step count that is about to change. The
    // wait is bounded by the query's own retry budget (~10s of 503s on a cold
    // boot, then an error, which answers as "nothing to disclose").
    if (!disclosureSettled) return;
    autoOpened.current = true;
    openChapter();
  }, [
    offer.autoOpen,
    launcherWouldShow,
    configSettled,
    systemStatusUnconfirmed,
    disclosureSettled,
    progress.deferred,
    progress.chapter,
    openChapter,
  ]);

  // Publish whether this chapter owns the screen, so the launcher can stand
  // down while it does — ONE decision, made in one place, instead of two
  // overlays each deriving their own answer from the same flapping probe
  //  The cleanup matters as much as the set: leaving Home, or the
  // route unmounting mid-chapter, must hand the screen back.
  useEffect(() => {
    firstRunChapterPresence.set(open || enginePickerOpen);
  }, [enginePickerOpen, open]);
  useEffect(() => () => firstRunChapterPresence.set(false), []);

  const writeStatus = useCallback(
    (next: 'skipped' | 'completed') => {
      // Fire-and-forget with an explicit catch: the DIALOG closing is the
      // user's decision and must not wait on the network. A failed write
      // leaves the home `pending`, so the chapter is offered again on the next
      // load — the honest outcome, and strictly better than a UI that says
      // "saved" over a write that did not land.
      //
      // A dedicated transition endpoint, not the config write: the
      // server decides whether the move is legal and stamps when it happened,
      // so neither this browser nor any other caller of the generic route can
      // re-arm a home or claim a completion.
      void recordFirstRunDecision(
        next === 'completed' ? FIRST_RUN_COMPLETED : FIRST_RUN_DEFERRED,
      ).catch(() => undefined);
    },
    [recordFirstRunDecision],
  );

  // This run has already been resolved by THIS chapter instance.
  //
  // Load-bearing, and found by the E2E bucket: a completed run recorded a
  // `skipped` write immediately AFTER its `completed` one, and last write wins
  // on the server, so a finished run persisted as deferred. Something on the
  // teardown path reaches `onClose` — `dialog-history` closes the top entry on
  // a `popstate`, and completing navigates (it starts the tour) before that
  // entry's deferred cleanup runs, which fits — but the exact path does not
  // change the rule: a run is decided once, and a deferral cannot follow the
  // decision. The status guard below could not carry this on its own, because
  // the config refetch has not landed yet and the record still reads
  // `pending`.
  const decided = useRef(false);

  const defer = useCallback(() => {
    completionGeneration.current += 1;
    // Closing the run while the DISCLOSURE step is in front of the reader is
    // the same decision as that step's own "Not now", and must leave the same
    // record. Without it, the `skipped` write below flips the home off
    // `pending`, `OnboardingGate` mounts the standalone disclosure modal on
    // every route, and the just-closed dialog re-appears over `/agents` —
    // the #765 B1 escalation, reproduced live.
    if (step === 'disclosure') {
      dismissUsageTelemetryDisclosure(disclosureData?.inventoryRevision);
    }
    setOpen(false);
    if (decided.current) return;
    // Device settings are synchronous and durable. Record a resumable snooze
    // before the asynchronous server transition so a reload cannot race a
    // restored `pending` config snapshot and re-block the UI. This is not
    // terminal completion: the Home card continues to offer the saved chapter.
    firstRunStore.defer();
    // Only from `pending`: re-writing `skipped` on every close of a
    // re-opened, already-deferred chapter would move `skippedAt` to mean
    // "the last time this dialog was closed", which is not what it says.
    if (config?.firstRun?.status !== 'pending') return;
    decided.current = true;
    writeStatus('skipped');
  }, [
    step,
    disclosureData?.inventoryRevision,
    config?.firstRun?.status,
    writeStatus,
  ]);

  /**
   * The user is leaving the run without engines that FAILED to materialise
   *
   *
   * Recorded as a DEFERRAL, never a completion. The chapter offered to set up
   * the engines they picked and did not; calling that "completed" would be the
   * label-with-nothing-behind-it this whole change exists to remove, and it
   * would take the Home card away — the one remaining route back to the
   * engines they still do not have. `skipped` keeps the card, so the run
   * stays on offer until it genuinely finishes.
   */
  const giveUp = useCallback(() => {
    completionGeneration.current += 1;
    firstRunStore.defer();
    setOpen(false);
    if (decided.current) return;
    if (config?.firstRun?.status !== 'pending') return;
    decided.current = true;
    writeStatus('skipped');
  }, [config?.firstRun?.status, writeStatus]);

  const complete = useCallback(
    (destination: 'chat' | 'tour') => {
      decided.current = true;
      if (destination === 'tour') firstRunStore.enterChapter('tour');
      else firstRunStore.finish();
      setOpen(false);
      writeStatus('completed');
      if (destination === 'tour') requestFirstRunTour();
      else window.dispatchEvent(new Event('station:open-new-chat'));
    },
    [writeStatus],
  );

  const continueToAboutYou = useCallback(() => {
    firstRunStore.enterChapter('about-you');
    setStep('about-you');
    setEnginePickerOpen(false);
    setOpen(true);
  }, []);

  const continueAfterEngineSetup = useCallback(() => {
    // Engine materialization answers "which harnesses should be available?";
    // it does not answer the separate role question "which one powers
    // Station?". Ask that question while first run already owns the screen,
    // and only when no explicit choice (including explicit Station/null) has
    // been recorded. EnginePicker is shared with Settings so capability
    // filtering and persistence stay single-sourced.
    if (config?.builtinAgentEngineConnectionId === undefined) {
      setOpen(false);
      setEnginePickerOpen(true);
      return;
    }
    continueToAboutYou();
  }, [config?.builtinAgentEngineConnectionId, continueToAboutYou]);

  if (!offer.offered) return null;

  return (
    <>
      <FirstRunHomeCard onOpen={openChapter} />
      {open ? (
        <ResponsiveDialogSurface
          onClose={defer}
          ariaLabelledBy="first-run-chapter-title"
          overlayClassName="first-run-chapter__overlay"
          panelClassName="first-run-chapter"
        >
          <ResponsiveDialogHeader
            title={
              <span id="first-run-chapter-title">{STEP_TITLES[step]}</span>
            }
            subtitle={`Step ${steps.indexOf(step) + 1} of ${steps.length}`}
            closeLabel="Close setup"
            onClose={defer}
          />
          {step === 'disclosure' ? (
            <UsageTelemetryDisclosureStep
              onAdvance={() => {
                firstRunStore.enterChapter('engines');
                setStep('engines');
              }}
              onDefer={defer}
            />
          ) : step === 'engines' ? (
            <FirstRunEnginesChapter
              options={options}
              // The chapter is already on screen; this only says whether the
              // LIST can be trusted yet (a flapping status probe changes
              // the list's contents, never the chapter's presence).
              loading={!settled}
              onDone={() => {
                continueAfterEngineSetup();
              }}
              onDefer={defer}
              onGiveUp={giveUp}
            />
          ) : (
            <AboutYouStep
              initial={config?.userProfile}
              saving={saving}
              error={saveError}
              onComplete={async (
                profile: UserProfileSettings | undefined,
                destination: 'chat' | 'tour',
              ) => {
                // Both exits save intentional answers before navigation. The
                // ref also guards two activations before React disables them.
                if (completionInFlight.current) return;
                completionInFlight.current = true;
                const generation = ++completionGeneration.current;
                setSaving(true);
                setSaveError(null);
                try {
                  if (profile) await updateConfig({ userProfile: profile });
                  // A close, Back, or route unmount during the write cancels
                  // navigation, even when those answers are successfully saved.
                  if (generation !== completionGeneration.current) return;
                  complete(destination);
                } catch (error) {
                  if (generation !== completionGeneration.current) return;
                  setSaveError(
                    error instanceof Error
                      ? `Station could not save your answers: ${error.message}`
                      : 'Station could not save your answers.',
                  );
                } finally {
                  completionInFlight.current = false;
                  setSaving(false);
                }
              }}
            />
          )}
        </ResponsiveDialogSurface>
      ) : null}
      {enginePickerOpen ? (
        <LazyBoundary
          load={loadFirstRunEnginePicker}
          componentProps={{
            eyebrow: 'Set up Station',
            title: 'Choose what powers Station',
            description:
              'Choose the engine that runs the Station agent. Station Control and Station Docs stay attached to the role.',
            onChosen: continueToAboutYou,
            onDismiss: continueToAboutYou,
          }}
          pending={null}
        />
      ) : null}
    </>
  );
}
