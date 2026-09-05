/**
 * archive#1194: the picker that binds Station's
 * built-in DEFAULT agent to an engine.
 *
 * Where it renders (and why that changed twice): it began as the first-run
 * modal behind `OnboardingGate`'s `setupBannerVariant` gate. archive#1359 retired
 * that call site — chat readiness no longer routes through a chooser — and
 * archive#1441 revived the component as the Settings "Change…" action
 * (`views/settings/BuiltinEngineRow.tsx`), which is now its ONE consumer.
 * That matters for the empty state below: the modal no longer appears on its
 * own, it appears because the user clicked a button, and a button that opens
 * nothing is worse than no button.
 *
 * Deliberately does NOT cover `station-voice` ( 2): Voice is a
 * speech-to-speech agent (`voice-session.ts`'s `IS2SProvider`, e.g. Nova
 * Sonic) that never reads an engine binding — "running Voice on Claude
 * Code/Codex" is a category error, not a real capability this picker can
 * honestly offer.
 *
 * Every capability judgement comes from
 * `@kontourai/station-contracts/engine-capability-matrix` via
 * `utils/engineBinding.ts` — the SAME matrix the agent editor's own engine
 * picker (archive#975, `AgentEditorBasicTab.tsx`) reads and the same one
 * `session-agent-resolution.ts` keys its station-control exemption on — so
 * this never hardcodes a per-engine-id branch and can never diverge from
 * what the resolver will accept.
 */

import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  controlPlaneCapableEngineNames,
  resolveBuiltinAgentEngineBinding,
} from '@kontourai/station-contracts/engine-capability-matrix';
import {
  useConfigQuery,
  useEngineConnectionsQuery,
  useQueryClient,
  useReconnectACPConnectionMutation,
  useUpdateConfigMutation,
} from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { useSystemStatus } from '../hooks/useSystemStatus';
import {
  capableEngineOptions,
  type EnginePickerOption,
  isStationChatReady,
  pendingObservationCopy,
  pendingObservationEngineOptions,
  readyEngineOptions,
} from '../utils/engineBinding';
import './EnginePicker.css';

/**
 * Only capable engines are ever offered (see `capableEngineOptions`), so
 * every row on screen carries the same capability — a per-row badge could
 * only ever read one value, which is noise that implies a contrast the
 * screen no longer has. The description still says what the engine can do.
 */
const CAPABILITY_DESCRIPTION =
  'Can operate Station — agents, skills, integrations, and jobs.';

/**
 * The sentence that names what to connect. Derived from the capability
 * matrix itself (`controlPlaneCapableEngineNames`), never written out
 * here: an engine gains or loses its place in this list the moment its
 * matrix cell changes, exactly as Codex did when archive#1195 shipped
 * `'url-token'`. A hardcoded sentence would have kept saying "Claude Code"
 * for weeks after Codex became capable.
 */
function capableEngineSentence(): string {
  const names = controlPlaneCapableEngineNames();
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface EnginePickerProps {
  /** Called after a choice is successfully saved. */
  onChosen: () => void;
  /** Called when the user dismisses without choosing. */
  onDismiss: () => void;
  /**
   * archive#settings-revamp: the Settings "Change…" action
   * (`views/settings/BuiltinEngineRow.tsx`) overrides this copy so the modal
   * reads as a deliberate re-configuration rather than first-run framing.
   * The none-capable panel below keeps its own title and description — there
   * is nothing to choose there, so a "choose an engine" title supplied by
   * any call site would be a false promise.
   */
  eyebrow?: string;
  title?: string;
  description?: string;
  /**
   * archive#settings-revamp: when provided, the
   * picker calls this with the chosen connectionId (then `onChosen`)
   * instead of PATCHing `builtinAgentEngineConnectionId` itself. The
   * Settings "Change…" row (`views/settings/BuiltinEngineRow.tsx`) passes
   * this so the choice flows into SettingsView's own batched draft/dirty-
   * state/Save/Discard cycle — without it, the picker's own immediate save
   * would land server-side, but the page's dirty-draft re-sync guard skips
   * adopting fresh server data while the user has unsaved edits, so the
   * NEXT Save would silently overwrite the just-made choice back to the
   * stale draft value.
   */
  onSelect?: (connectionId: EngineConnectionId | null) => void;
}

export function EnginePicker({
  onChosen,
  onDismiss,
  eyebrow = 'First run',
  title = 'Choose what powers your default assistant',
  description = 'Station found more than one ready option. Choose one for your default assistant.',
  onSelect,
}: EnginePickerProps) {
  const { data: status } = useSystemStatus();
  const { data: connections = [] } = useEngineConnectionsQuery();
  const { data: config } = useConfigQuery();
  const updateConfig = useUpdateConfigMutation();

  const stationChatReady = status ? isStationChatReady(status) : false;
  const readyOptions = readyEngineOptions({ stationChatReady, connections });
  // Owner directive (archive#1194): offer ONLY engines that can actually
  // power the assistant. Chat readiness is already decoupled from this
  // choice (archive#1263), so the only thing this modal binds is the ability to
  // operate Station — and an engine that cannot carry `station-control`
  // would deliver an assistant that responds and cannot do the one thing it
  // exists for.
  const options = capableEngineOptions(readyOptions);
  // archive#1549: ready engines Station has a reviewed mechanism for but has
  // never observed. Listed and explained, never offered as a radio — see
  // `pendingObservationEngineOptions`.
  const pendingOptions = pendingObservationEngineOptions(readyOptions);
  const readyExternalEngines = options
    .filter(
      (
        option,
      ): option is EnginePickerOption & {
        connectionId: NonNullable<EnginePickerOption['connectionId']>;
      } => option.connectionId !== null,
    )
    .map((option) => ({
      connectionId: option.connectionId,
      matrix: option.matrix,
      // archive#1549: the observation MUST travel with the
      // matrix here. `resolveBuiltinAgentEngineBinding` re-derives capability
      // from (matrix, observation) rather than trusting the caller's filter,
      // so dropping it would make this picker offer a row it then refuses to
      // resolve — rendering a user's own verified engine unselected and
      // saving `null` (Station) over a working binding on confirm.
      controlPlaneObservation: option.controlPlaneObservation,
    }));

  const explicitConnectionId = (config as AppConfig | undefined)
    ?.builtinAgentEngineConnectionId;
  const defaultBinding = resolveBuiltinAgentEngineBinding({
    explicitConnectionId,
    stationChatReady,
    readyExternalEngines,
  });
  const computedDefaultId = defaultBinding?.connectionId ?? null;

  const [selectedId, setSelectedId] = useState<
    EngineConnectionId | null | undefined
  >(undefined);
  const resolvedSelectedId =
    selectedId !== undefined ? selectedId : computedDefaultId;

  // archive#1549: opening the picker is the moment the user asks the
  // question, so it is the moment to go and answer it. Probing is already
  // this connection's own standing job (the ACP probe runs a
  // spawn+initialize cycle on a cadence); this only asks for one now, so a
  // row that says "not checked yet" can resolve in place while the modal is
  // open instead of making the user close it and come back.
  //
  // Scoped to rows that are ACTUALLY unresolved and fired ONCE per
  // connection per mount: a probe is a real child process, and re-firing it
  // on every render (or for connections whose answer is already known)
  // would turn an explanation into a spawn loop.
  // `mutateAsync`, NOT `mutate` with an `onSettled` option:
  // a `useMutation` observer holds ONE options slot and ONE current mutation,
  // so a second `mutate(...)` in the same pass overwrites the first's
  // callbacks and detaches its observer — with two unobserved connections,
  // only the LAST one's settle handler would ever run and the other row would
  // read "Checking…" forever, asserting an answer was coming when nothing was
  // in flight. `mutateAsync` returns the promise for THAT call, so the
  // bookkeeping is genuinely per connection. It is also referentially stable,
  // unlike the mutation object, so the effect is not re-run per state change.
  const { mutateAsync: probeConnection } = useReconnectACPConnectionMutation();
  const queryClient = useQueryClient();
  const probedRef = useRef<Set<string>>(new Set());
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const pendingIds = pendingOptions
    .map((option) => option.connectionId)
    .filter((id): id is EngineConnectionId => id !== null)
    .join(',');
  useEffect(() => {
    if (!pendingIds) return;
    for (const id of pendingIds.split(',')) {
      if (probedRef.current.has(id)) continue;
      probedRef.current.add(id);
      setCheckingIds((current) =>
        current.includes(id) ? current : [...current, id],
      );
      // Success and failure land in the same place on purpose: either the
      // probe produced an observation (and the refreshed connection list
      // resolves the row) or it did not (and the row honestly goes back to
      // "not checked yet"). Neither outcome may leave the row spinning, so
      // the cleanup hangs off `finally`, never off the success path.
      void Promise.resolve(probeConnection(id))
        .catch(() => undefined)
        .finally(() => {
          void queryClient.invalidateQueries({
            queryKey: ['connections', 'runtimes'],
          });
          setCheckingIds((current) => current.filter((each) => each !== id));
        });
    }
  }, [pendingIds, probeConnection, queryClient]);

  // archive#1549: the not-yet-observed rows, shared by both panels below.
  // Rendered as plain rows with no `<input type="radio">` — the absence of a
  // control IS the honesty: there is nothing to choose here yet, and a
  // disabled radio would still assert the row belongs to the same set of
  // answers as the selectable ones.
  const pendingRows =
    pendingOptions.length === 0 ? null : (
      <section
        className="engine-picker__options"
        data-testid="engine-picker-pending-observation"
        aria-label="Engines Station is still checking"
      >
        {pendingOptions.map((option) => (
          <div
            key={option.connectionId ?? option.name}
            className="engine-picker__option engine-picker__option--pending"
            data-testid={`engine-picker-pending-${option.connectionId ?? option.name}`}
          >
            <div className="engine-picker__option-body">
              <div className="engine-picker__option-name">{option.name}</div>
              <div className="engine-picker__option-detail">
                {pendingObservationCopy(
                  option.name,
                  option.connectionId !== null &&
                    checkingIds.includes(option.connectionId),
                )}
              </div>
            </div>
          </div>
        ))}
      </section>
    );

  if (options.length === 0) {
    // Nothing to choose from. This is a REACHABLE steady state once
    // incapable engines are filtered out — an engine can be connected and
    // ready and still be unable to run the assistant — and the only way in
    // here is a deliberate click on "Change…". Rendering null would leave
    // that button silently doing nothing, and the owner rejected greying it
    // out for the same reason: the user is left to discover elsewhere why
    // the assistant never appeared. So the modal opens and explains.
    //
    // Nothing is persisted from this panel. The state resolves by itself the
    // moment an engine's matrix cell gains a station-control delivery
    // mechanism (exactly how Codex went from excluded to offered when archive#1195
    // shipped `'url-token'`), and any saved choice must still be sitting
    // there untouched when it does.
    // archive#1549: a not-yet-observed engine has NOT been judged incapable,
    // so it must not appear in the "can chat, but it can't operate Station"
    // sentence — that sentence is a verdict, and Station has not reached one.
    // It gets its own row below instead.
    const incapableNames = readyOptions
      .filter((option) => option.capability !== 'observation-required')
      .map((option) => option.name);
    const capableNames = capableEngineSentence();
    return (
      <div className="engine-picker" data-testid="engine-picker">
        <div className="engine-picker__backdrop" />
        <div
          className="engine-picker__panel"
          data-testid="engine-picker-none-capable"
          role="dialog"
          aria-labelledby="engine-picker-title"
        >
          <div className="engine-picker__eyebrow">{eyebrow}</div>
          <div className="engine-picker__header">
            <div className="engine-picker__title" id="engine-picker-title">
              {pendingOptions.length > 0
                ? 'No connected engine can run the built-in assistant yet'
                : 'No connected engine can run the built-in assistant'}
            </div>
            <button
              type="button"
              aria-label="Dismiss engine picker"
              onClick={onDismiss}
              className="engine-picker__dismiss"
            >
              ×
            </button>
          </div>
          {/*
            MERGE (#1644 x #1547 AC5). Both descriptions speak about
            `incapableNames`, so both sit behind this branch's guard rather
            than only the first: on a panel whose one unresolved engine is
            still mid-check, `incapableNames` is empty and the zero-engine
            wording ("You have no engine connected yet…", "An engine that
            can't run the built-in assistant still gets Station's
            documentation…") would be describing a verdict Station has not
            reached. Gating one and not the other would keep half of a
            two-sentence claim on screen with its premise removed.
*/}
          {(incapableNames.length > 0 || pendingOptions.length === 0) && (
            <>
              <div className="engine-picker__description">
                {incapableNames.length === 0
                  ? 'You have no engine connected yet, so nothing can run the built-in assistant — the assistant that operates Station for you: creating agents, running jobs, changing settings.'
                  : incapableNames.length === 1
                    ? `${incapableNames[0]} can chat, but it can't operate Station — creating agents, running jobs, changing settings — so it can't run the built-in assistant.`
                    : `Your connected engines (${incapableNames.join(', ')}) can chat, but none of them can operate Station — creating agents, running jobs, changing settings — so none of them can run the built-in assistant.`}
              </div>
              {/* archive#1547. Restored, and this time it has a producer:
                  the ACP adapter now delivers the credential-free
                  `station-docs` server on every ACP session (acp-adapter.ts),
                  which is exactly the engine class that can never carry
                  `station-control` and so can never run the built-in
                  assistant. The first shipping of this sentence was reverted
                  at 5a61adbf because nothing delivered the server to a
                  non-`station` agent — an engine that answers confidently
                  while silently unable to is the assert-then-retract failure
                  delivery-protocol §6 forbids, and a claim with no producer
                  is the same defect arriving through the copy.

                  Each variant is scoped to what actually ships. The
                  zero-engine variant deliberately says "an engine that can't
                  run the built-in assistant" rather than "any engine you
                  connect": a CAPABLE engine gets documentation by way of the
                  built-in assistant itself, not by this grant, so the broader
                  sentence would be making a claim about a delivery path that
                  does not exist for it. */}
              <div className="engine-picker__description">
                {incapableNames.length === 0
                  ? "An engine that can't run the built-in assistant still gets Station's documentation, so it can explain how Station works, answer questions about it, and help you plan — it just can't create agents, run jobs, or change settings."
                  : incapableNames.length === 1
                    ? `${incapableNames[0]} still gets Station's documentation, so it can explain how Station works, answer questions about it, and help you plan — it just can't create agents, run jobs, or change settings.`
                    : "They still get Station's documentation, so they can explain how Station works, answer questions about it, and help you plan — they just can't create agents, run jobs, or change settings."}
              </div>
            </>
          )}
          {pendingRows}
          {pendingOptions.length > 0 && (
            // Without this, the only call to action on a panel whose one
            // unresolved engine is mid-check would be "go connect a different
            // engine" — true, but the wrong thing to tell that user.
            <div className="engine-picker__description">
              This panel updates on its own if Station finds one of them can run
              the assistant.
            </div>
          )}
          <div className="engine-picker__description">
            Engines that can run it today: {capableNames}. Add one in
            Connections, then come back here.
          </div>
          <button
            type="button"
            className="engine-picker__primary"
            onClick={onDismiss}
          >
            Got it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="engine-picker" data-testid="engine-picker">
      <div className="engine-picker__backdrop" />
      <div
        className="engine-picker__panel"
        role="dialog"
        aria-labelledby="engine-picker-title"
      >
        <div className="engine-picker__eyebrow">{eyebrow}</div>
        <div className="engine-picker__header">
          <div className="engine-picker__title" id="engine-picker-title">
            {title}
          </div>
          <button
            type="button"
            aria-label="Dismiss engine picker"
            onClick={onDismiss}
            className="engine-picker__dismiss"
          >
            ×
          </button>
        </div>
        <div className="engine-picker__description">{description}</div>

        <div className="engine-picker__options" role="radiogroup">
          {options.map((option) => {
            const optionKey = option.connectionId ?? 'station';
            const isSelected = resolvedSelectedId === option.connectionId;
            return (
              <label
                key={optionKey}
                className={`engine-picker__option${
                  isSelected ? ' engine-picker__option--selected' : ''
                }`}
              >
                <input
                  type="radio"
                  name="engine-picker-option"
                  value={optionKey}
                  checked={isSelected}
                  onChange={() => setSelectedId(option.connectionId)}
                />
                <div className="engine-picker__option-body">
                  <div className="engine-picker__option-name">
                    {option.name}
                  </div>
                  <div className="engine-picker__option-detail">
                    {CAPABILITY_DESCRIPTION}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {pendingRows}

        <button
          type="button"
          className="engine-picker__primary"
          // UX audit 2026-09-05 A7: with two or more capable external
          // engines and no Station model provider, the resolver has no
          // default (`resolveBuiltinAgentEngineBinding` returns null when the
          // choice is ambiguous), so no radio is preselected. An enabled
          // primary in that state saved `builtinAgentEngineConnectionId:
          // null` while reading "Saving…", left the built-in assistant
          // unrunnable, and the wizard moved on as if a choice had been made.
          //
          // `null` is only "nothing chosen" when NO row carries it. When a
          // Station model provider is chat-ready, `readyEngineOptions` offers
          // a "Station" row whose value IS null, and an explicit Station
          // binding is a sticky first-class config value — so the guard asks
          // whether a null row is on offer, not whether null is selected.
          // It reads `options` (the array that renders the radios) rather
          // than `stationChatReady`, so the guard can never disagree with
          // the rows on screen if the Station row's derivation changes.
          disabled={
            updateConfig.isPending ||
            (resolvedSelectedId === null &&
              !options.some((option) => option.connectionId === null))
          }
          onClick={() => {
            if (onSelect) {
              // route the choice through the caller's own
              // draft/save cycle — no network mutation here.
              onSelect(resolvedSelectedId);
              onChosen();
              return;
            }
            updateConfig.mutate(
              { builtinAgentEngineConnectionId: resolvedSelectedId },
              { onSuccess: onChosen },
            );
          }}
        >
          {updateConfig.isPending ? 'Saving…' : 'Use this engine'}
        </button>
        <button
          type="button"
          className="engine-picker__secondary"
          onClick={onDismiss}
        >
          Decide later
        </button>
      </div>
    </div>
  );
}
