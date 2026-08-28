/**
 * EnginesStep — "which agents do you use?" (archive#3027; re-placed by the UX
 * audit's /).
 *
 * Every box the user ticks becomes one authored Agent through the SAME server
 * path the picker's per-row Enable uses — `POST /agents/materialize-engine`,
 * one find-or-create per engine, which is why a second confirm (or a second
 * device) adds no duplicate. This chapter builds no draft of its own
 * (`first-run-engines.ts` holds the shared derivations).
 *
 * WHERE THIS RENDERS. Inside `FirstRunHomeChapter`'s dialog, on Home. It used
 * to render its own fixed bottom-right card at `--layer-notice`, which is why
 * the audit found it painting over the Schedule run output and the Guidance
 * skill body, on whatever route the user happened to be on, ten seconds into
 * the session. This component now owns no chrome and no placement at all: the
 * shared `ResponsiveDialogSurface` owns both.
 *
 * The honesty rules, matching what the server will actually do:
 *
 * - **Only ready engines are offered a checkbox.** The catalog withholds the
*   `enable` signal for an engine whose connection is not enabled and ready,
*   so a tick there could not succeed. Those rows render as a state and a
*   reason, not as a control the user can operate — rather than as a
*   *disabled* control, which drops the reason out of the tab order.
 * - **Already-enabled engines are visible, not merely safe.** A device that
*   runs this chapter against a home that already has the Agents shows them
*   as `Ready — <engine>`, and creates nothing; and where one is materialised
*   anyway, the endpoint answers `created: false` and the report says
*   "already set up" rather than claiming the run made it.
 * - **A warned create is not a success.** The server returns 2xx for an Agent
*   that saved but cannot launch; that outcome is reported per engine and
*   must be dismissed by hand rather than sliding past.
 * - **One failure does not lose the rest.** The batch runs every selection and
*   reports per engine.
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { useMaterializeEngineAgentMutation } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import {
  useAgents,
  useAgentsLoaded,
  useAgentsSettled,
} from '../../contexts/AgentsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { hostActionCopy } from '../host-action/host-action-copy';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import './EnginesStep.css';
import {
  buildFirstRunEnableBatch,
  buildFirstRunEngineOptions,
  type FirstRunEnableOutcome,
  type FirstRunEngineOption,
  failedFirstRunEngineIds,
  firstRunEnableFailureOutcome,
  firstRunEnableOutcomeMessage,
  firstRunEnableSuccessOutcome,
  firstRunEngineRowLabel,
  summarizeFirstRunEnableOutcomes,
  unplannableFirstRunEngineOutcomes,
} from './first-run-engines';

/**
 * The chapter's CONTENT, and whether it can be trusted yet.
 *
 * `settled` no longer gates whether the chapter exists — that is
 * `resolveFirstRunOffer`'s job now, from a durable fact — so a flapping
 * `/api/system/status` can change what this list SAYS but can never make the
 * chapter appear or disappear. While it is unsettled the step renders its own
 * loading line in place of the list.
 */
export function useFirstRunEngineOptions(): {
  options: FirstRunEngineOption[];
  settled: boolean;
} {
  const { data: status, isLoading } = useSystemStatus();
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  const agentsSettled = useAgentsSettled();
// A FAILED agent catalog folds into "no options", never into "not settled":
// waiting forever would leave the chapter on its loading line, and building
// options without the catalog would offer engines that are already enabled.
  const options =
    agentsLoaded && status?.externalEngines
      ? buildFirstRunEngineOptions({
          engines: status.externalEngines,
          agents,
          devicePresentation: status.devicePresentation,
        })
      : [];
  return { options, settled: !isLoading && agentsSettled };
}

export interface EnginesStepProps {
  options: readonly FirstRunEngineOption[];
/**
 * Which machine is reading the chapter (archive#3843). The scan runs on the
* host, so every sentence about where Station looked has to name it —
* "this machine" is only true for someone sitting at the host.
*/
  devicePresentation?: DevicePresentation | undefined;
  selected: readonly string[];
  onToggle: (engineId: string, checked: boolean) => void;
  onConfirm: () => void;
/** "Not now" — defers the whole chapter, not just this step. */
  onDefer: () => void;
/** The engine catalog has not answered yet. */
  loading?: boolean;
/**
* How many creates the running batch is performing, or `null`/absent when
* no batch is running — the busy state and the announced count are ONE
 * value on purpose (archive#3027). They used to be
* two: `busy` came from the chapter, and the count was re-derived here from
* the current `options`, which shrinks as each create lands and flips its
* row to `enabled`. In a live region that RE-ANNOUNCES: "Setting up 2
* agents…", then "Setting up 1 agent…", while two were running the whole
* time. A count that cannot disagree with the batch is the fix.
*/
  runningBatchSize?: number | null;
/** Per-engine results of a finished batch, replacing the checklist. */
  outcomes?: readonly FirstRunEnableOutcome[] | null;
/** Dismiss the report and move on. Only offered when nothing FAILED. */
  onAcknowledge: () => void;
/** Run the batch again for the engines that failed. */
  onRetry: () => void;
/**
* Leave the run without the engines that failed. Distinct from
* `onAcknowledge` because it must NOT be recorded as a completed first run
 *  — the user is going on without what they asked for.
*/
  onGiveUp: () => void;
}

export function EnginesStep({
  options,
  devicePresentation,
  selected,
  onToggle,
  onConfirm,
  onDefer,
  loading,
  runningBatchSize,
  outcomes,
  onAcknowledge,
  onRetry,
  onGiveUp,
}: EnginesStepProps) {
  const busy = runningBatchSize !== null && runningBatchSize !== undefined;
  const listed = options.filter((option) => option.state !== 'undetected');
  const undetected = options.filter((option) => option.state === 'undetected');
  const selectedCount = options.filter(
    (option) => option.selectable && selected.includes(option.engineId),
  ).length;

// The report is where the run's outcome lives, so it takes focus when it
// arrives — otherwise the user's focus is still on a control that has just
// been replaced, and the only account of what happened is off-screen for a
// keyboard or screen-reader user.
  const reportRef = useRef<HTMLUListElement>(null);
  const hasOutcomes = Boolean(outcomes);
  useEffect(() => {
    if (hasOutcomes) reportRef.current?.focus();
  }, [hasOutcomes]);

// ONE live region, present from first render in every phase, whose text
// changes. A `role="status"` node inserted with its content already in it is
// not reliably announced across screen readers, and batch progress that
// lives only in a disabled button's label is not announced at all.
//
// The count is the BATCH's own size, fixed when the batch started — never
// `selectedCount`, which is recomputed from options that change underneath
// a running batch.
  const statusMessage = busy
    ? `Setting up ${runningBatchSize} ${runningBatchSize === 1 ? 'agent' : 'agents'}…`
    : outcomes
      ? summarizeFirstRunEnableOutcomes(outcomes).message
      : '';

  return (
    <div className="first-run-engines" data-testid="first-run-engines">
      <p
        className="first-run-engines__status"
        role="status"
        data-testid="first-run-engines-status"
      >
        {statusMessage}
      </p>

      {outcomes ? (
        <>
          <ul
            aria-label="What Station set up"
            className="first-run-engines__report"
            data-testid="first-run-engines-report"
            ref={reportRef}
            tabIndex={-1}
          >
            {outcomes.map((outcome) => (
              <li
                className="first-run-engines__report-item"
                data-status={outcome.status}
                key={outcome.engineId}
              >
                {firstRunEnableOutcomeMessage(outcome)}
              </li>
            ))}
          </ul>
{/* A batch with a FAILURE has not done what the chapter offered to
              do, so it does not get a single "Continue" that walks on as if it
              had (review H1). The two honest exits are: try the ones that
              failed again, or go on WITHOUT them — and the second one is not a
              completed first run, which is why it is a different callback and
              not this one with a different label. Warnings are not failures:
              a warned create saved, so it keeps the plain acknowledgement. */}
          {failedFirstRunEngineIds(outcomes).length > 0 ? (
            <ResponsiveSurfaceActions className="first-run-chapter__actions">
              <button
                type="button"
                className="editor-btn"
                data-testid="first-run-engines-give-up"
                onClick={onGiveUp}
              >
                Continue without them
              </button>
              <button
                type="button"
                className="editor-btn editor-btn--primary"
                data-testid="first-run-engines-retry"
                onClick={onRetry}
              >
                Try again
              </button>
            </ResponsiveSurfaceActions>
          ) : (
            <ResponsiveSurfaceActions className="first-run-chapter__actions">
              <button
                type="button"
                className="editor-btn editor-btn--primary"
                onClick={onAcknowledge}
              >
                Continue
              </button>
            </ResponsiveSurfaceActions>
          )}
        </>
      ) : (
        <>
{/* The lede describes a list, so it renders only when there IS one.
              Shown above an empty or still-loading list it asserts "Station
              found these on this machine" about nothing — caught in the live
              screenshot of the loading state. */}
          {!loading && listed.length > 0 ? (
            <p className="first-run-chapter__lede">
              {hostActionCopy('engine-scan', devicePresentation)}
            </p>
          ) : null}

          {loading ? (
            <p
              className="first-run-engines__loading"
              data-testid="first-run-engines-loading"
            >
              {hostActionCopy('engine-scan-pending', devicePresentation)}
            </p>
          ) : listed.length === 0 ? (
            <p
              className="first-run-engines__loading"
              data-testid="first-run-engines-none"
            >
{/* States what STATION reported, not what is on the machine.
                  `externalEngines` is empty on a home with no engine
                  connections even where the CLIs are installed (seen live on a
                  fresh temp home with claude and codex both on PATH), so
                  "Station found no agent CLIs on this machine" would be a
                  claim the data does not support. */}
              Station has no agent engines to offer here yet — you can connect
              one any time from Connections.
            </p>
          ) : (
            <ul className="first-run-engines__list">
              {listed.map((option) => (
                <li
                  className="first-run-engines__row"
                  data-state={option.state}
                  data-testid={`first-run-engine-${option.engineId}`}
                  key={option.engineId}
                >
{/* A row Station cannot act on renders as a STATE, never as
                      a disabled control: a disabled input is skipped in the
                      tab order, and the row's note carries the only account of
                      why it reads the way it does. The shared `Checkbox` is
                      therefore only ever mounted for a row that can genuinely
                      be ticked. */}
                  {option.selectable ? (
                    <Checkbox
                      checked={selected.includes(option.engineId)}
                      disabled={busy}
                      onChange={(checked) => onToggle(option.engineId, checked)}
                    >
                      <span className="first-run-engines__name">
                        {firstRunEngineRowLabel(option)}
                      </span>
                    </Checkbox>
                  ) : (
                    <span className="first-run-engines__name">
                      {firstRunEngineRowLabel(option)}
                    </span>
                  )}
                  {option.note ? (
                    <span className="first-run-engines__note">
                      {option.note}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {undetected.length > 0 ? (
// Secondary and collapsed: naming what Station also supports is
// worth one line, but an unchecked list of things the user does
// not have must never compete with the ones they do.
            <details className="first-run-engines__more">
              <summary>Station also works with</summary>
              <ul className="first-run-engines__list">
                {undetected.map((option) => (
                  <li
                    className="first-run-engines__row first-run-engines__row--muted"
                    data-testid={`first-run-engine-${option.engineId}`}
                    key={option.engineId}
                  >
                    <span className="first-run-engines__name">
                      {firstRunEngineRowLabel(option)}
                    </span>
                    {option.note ? (
                      <span className="first-run-engines__note">
                        {option.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <ResponsiveSurfaceActions className="first-run-chapter__actions">
{/* "Not now" stays live during the batch: the user asking to move
                on is not a state we get to refuse, and this chapter may never
                block Home. */}
            <Button variant="secondary" onClick={onDefer}>
              Not now
            </Button>
{/* `aria-disabled`, not `disabled`: the running batch's own
                progress is announced from this control's label and the live
                region above it, and a `disabled` button drops keyboard focus
                to <body> at exactly the moment there is something to hear.
                The second activation is refused in the handler (and again by
                the chapter's in-flight ref). */}
            <Button
              variant="primary"
              aria-busy={busy}
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                onConfirm();
              }}
            >
              {busy
                ? 'Setting up…'
                : selectedCount > 0
                  ? `Set up ${selectedCount}`
                  : 'Continue'}
            </Button>
          </ResponsiveSurfaceActions>
        </>
      )}
    </div>
  );
}

/**
 * The chapter's engine step: selection state, the batch, and the report.
 */
export function FirstRunEnginesChapter({
  options,
  loading,
  onDone,
  onDefer,
  onGiveUp,
}: {
  options: readonly FirstRunEngineOption[];
  loading?: boolean;
/** Every engine the user asked for was materialised (or none was asked for). */
  onDone: () => void;
/** "Not now" — the run is deferred before anything was attempted. */
  onDefer: () => void;
/**
* The user is going on without engines that FAILED to materialise. Separate
* from `onDone` because the run did not do what it offered to do, so it may
 * not be recorded as completed 
*/
  onGiveUp: () => void;
}) {
  const materializeEngineAgent = useMaterializeEngineAgentMutation();
// The same status query `useFirstRunEngineOptions` already reads — one
// request, one derivation, and the row notes and the chapter's own
// sentences therefore cannot name two different machines.
  const devicePresentation = useDevicePresentation();
// Seeded ONCE, from the first answer that actually has rows in it, and never
// again after the user has touched a box.
//
// Three failures, and each one has been live:
//
// - Deriving it every render re-ticks a box the user cleared, so it is
//   seeded, not derived.
// - Seeding on the first render seeds from an empty catalog, because the
//   chapter no longer waits for `settled` before mounting.
// - Seeding on the first SETTLED render is not enough either:
//   `/api/system/status` answers `externalEngines: []` in one window and the
//   real rows in the next, and an empty settled answer latched the seed at
//   `[]`. Every ready engine then rendered unticked and the primary action
//   read "Continue" over three enable-able engines — seen in the live
//   screenshot of a fresh temp home.
//
// `options.length` is the right condition rather than `settled` because it
// is the thing being seeded FROM. An engine catalog that is genuinely empty
// seeds nothing, which is the same outcome either way.
  const [selected, setSelected] = useState<string[]>([]);
  const seeded = useRef(false);
  const userTouched = useRef(false);
  useEffect(() => {
    if (seeded.current || userTouched.current || loading) return;
    if (options.length === 0) return;
    seeded.current = true;
    setSelected(
      options.filter((option) => option.defaultChecked).map((o) => o.engineId),
    );
  }, [loading, options]);

// The batch's own size while it runs, `null` otherwise. One value carries
// both "a batch is running" and "how many creates it is performing", so the
// announcement cannot drift from the work.
  const [runningBatchSize, setRunningBatchSize] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<FirstRunEnableOutcome[] | null>(
    null,
  );
// Ref, not just state: two activations in one frame both read the
// pre-render state (same guard the picker's Enable uses).
  const inFlight = useRef(false);

// Named `runBatch`, not `confirm`: a local `confirm` shadows
// `window.confirm`, which the repo's no-native-dialog guardrail scans for
// by name — and the shadowing is genuinely ambiguous to the next reader.
//
// `engineIds` is the retry seam: a retry re-plans from the CURRENT options
// for the engines that failed only, so an engine that succeeded in the first
// pass is excluded by `buildFirstRunEnableBatch`'s own `selectable` rule
// (its row is `enabled` now) rather than by a second bookkeeping list.
  const runBatch = async (
    engineIds: readonly string[],
    knownNames?: ReadonlyMap<string, string>,
  ) => {
    if (inFlight.current) return;
    const plan = buildFirstRunEnableBatch(options, engineIds);
// Asked for, and not even attemptable. `plan.length === 0` used to mean
// "nothing was requested" and took the completing exit — but it is also
// what a REQUESTED engine that has left the catalog produces, so a retry
// whose failed engine had gone away completed the run over it. The two
// are separated here: no request at all still finishes; a request this
// batch cannot plan is a failure, and failures never complete a run.
    const unresolved = unplannableFirstRunEngineOutcomes(
      options,
      engineIds,
      knownNames,
    );
    if (plan.length === 0) {
      if (unresolved.length === 0) {
        onDone();
        return;
      }
      setOutcomes(unresolved);
      return;
    }
    inFlight.current = true;
    setRunningBatchSize(plan.length);
    const results: FirstRunEnableOutcome[] = [];
    for (const item of plan) {
      try {
// Sequential on purpose: these are read-modify-write creates against
// one agent store, and a partial failure must leave the remaining
// selections still attempted rather than aborting the batch.
        const { data, created, warnings } =
          await materializeEngineAgent.mutateAsync(item.engineConnectionId);
        results.push(
          firstRunEnableSuccessOutcome(
            item,
            (data as { name?: string })?.name ?? item.name,
            created,
            warnings,
          ),
        );
      } catch (error) {
        results.push(firstRunEnableFailureOutcome(item, error));
      }
    }
    inFlight.current = false;
    setRunningBatchSize(null);
// The ones that could not be planned are reported beside the ones that
// ran: a batch is answerable for everything it was asked for, not only
// for the calls it managed to make.
    const report = [...results, ...unresolved];
    if (!summarizeFirstRunEnableOutcomes(report).needsAcknowledgement) {
      onDone();
      return;
    }
    setOutcomes(report);
  };

  const retryFailed = () => {
    const failed = outcomes ? failedFirstRunEngineIds(outcomes) : [];
    if (failed.length === 0) return;
// Carried forward so an engine that has since left the catalog is still
// named the way the report just named it.
    const knownNames = new Map(
      (outcomes ?? []).map((outcome) => [outcome.engineId, outcome.name]),
    );
    setOutcomes(null);
    void runBatch(failed, knownNames);
  };

  return (
    <EnginesStep
      options={options}
      devicePresentation={devicePresentation}
      loading={loading}
      selected={selected}
      runningBatchSize={runningBatchSize}
      outcomes={outcomes}
      onToggle={(engineId, checked) => {
        userTouched.current = true;
        setSelected((current) =>
          checked
            ? current.includes(engineId)
              ? current
              : [...current, engineId]
            : current.filter((id) => id !== engineId),
        );
      }}
      onConfirm={() => void runBatch(selected)}
      onDefer={onDefer}
      onAcknowledge={onDone}
      onRetry={retryFailed}
      onGiveUp={onGiveUp}
    />
  );
}
