/**
 * first-run-engines — every decision the "Which agents do you use?" chapter
 * makes, as pure functions (archive#3027).
 *
 * WHAT THE LISTING IS DERIVED FROM. `GET /api/system/status`'s
 * `externalEngines[]` projection, never the sibling `clis` map. `clis` is a
 * bare PATH probe whose own producer marks it diagnostic-only; each
 * `externalEngines` row is that producer's "CLI resolvable AND authenticated"
 * derivation, carries the `reason` when it is not, and carries the
 * `engineConnectionId` an authored Agent would have to bind to. A checklist
 * driven by `clis` would offer to enable an engine the server would then
 * refuse.
 *
 * WHAT THE ENABLE IS. The picker's Enable, unchanged: the same FIND
 * (`findAuthoredAgentForEngineConnection`) over the same binding, and the
 * same CREATE — `POST /agents/materialize-engine`, which resolves the
 * identity and the display name server-side from the registry projection.
 * This chapter is a BATCH of that one operation, not a second creation path.
 * That is load-bearing rather than tidy: while this chapter built its own
 * draft named "<engine> Agent", "Set up 2" produced rows the picker's own
 * Enable could not see as the same thing, and four engines ended up with
 * seven rows.
 *
 * `cannot_verify` counts as "worth showing" even with `detected: false`,
 * mirroring `onboardingGateUtils.setupBannerVariant`'s existing rule: an
 * adapter Station could not probe is an unknown, not an absence.
 */

import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type {
  DevicePresentation,
  ExternalEngineReadinessProjection,
} from '@kontourai/station-contracts/system-status';
import type { AgentData } from '../../contexts/AgentsContext';
import { selectGlobalContextAgents } from '../agent-selection-policy';
import { hostActionCopy } from '../host-action/host-action-copy';
import { findAuthoredAgentForEngineConnection } from '../modals/new-chat-modal-utils';

/**
 * - `available` — ready, addressable, and not enabled yet. The only state the
 *   chapter can act on.
 * - `enabled` — an authored Agent is already bound to this engine's
 *   connection. Rendered checked and locked so idempotency is *visible*, and
 *   excluded from every batch so a second device creates nothing.
 * - `blocked` — Station saw the engine (or could not verify it) but cannot
 *   enable it yet. Shown with its reason, never offered: the server withholds
 *   the alias row's `enable` signal for exactly these, so a click could not
 *   succeed.
 * - `undetected` — not found on this machine. Secondary, never checked.
 */
export type FirstRunEngineState =
  | 'available'
  | 'enabled'
  | 'blocked'
  | 'undetected';

export interface FirstRunEngineOption {
  engineId: string;
  name: string;
  engineConnectionId?: EngineConnectionId;
  state: FirstRunEngineState;
  /** Checked when the checklist opens. */
  defaultChecked: boolean;
  /** The user may change this row's checkbox. */
  selectable: boolean;
  /** Why this row reads the way it does. Absent only for a plain `available`. */
  note?: string;
}

export interface FirstRunEnablePlanItem {
  engineId: string;
  name: string;
  /** The only thing the create needs: the server names the Agent. */
  engineConnectionId: EngineConnectionId;
}

interface FirstRunEnableOutcomeBase {
  engineId: string;
  name: string;
  agentName: string;
}

export type FirstRunEnableOutcome =
  // `existing` is a SUCCESS, and separate from `created` because the report
  // states what happened: materialize-engine is find-or-create, so a second
  // device (or a second confirm) resolves to the Agent that is already there
  // and nothing was created. Reporting that as "set up as X" would be a
  // sentence about work this run did not do.
  | (FirstRunEnableOutcomeBase & { status: 'created' })
  | (FirstRunEnableOutcomeBase & { status: 'existing' })
  | (FirstRunEnableOutcomeBase & { status: 'warned'; warnings: string[] })
  | (FirstRunEnableOutcomeBase & { status: 'failed'; message: string });

const STATE_ORDER: Record<FirstRunEngineState, number> = {
  available: 0,
  enabled: 1,
  blocked: 2,
  undetected: 3,
};

/**
 * Why an engine is not ready, in the chapter's voice. Deliberately does not
 * claim installation: `reason` is orthogonal to `detected`, so wording like
 * "installed, but…" would be a fabricated observation for a row that only
 * reported `disabled`.
 */
function notReadyNote(engine: ExternalEngineReadinessProjection): string {
  switch (engine.reason) {
    case 'sign_in_required':
      return `Sign in to ${engine.name} to use it here.`;
    case 'disabled':
      return `${engine.name} is turned off in Connections.`;
    case 'cannot_verify':
      return `Station could not verify ${engine.name} is ready.`;
    case 'missing_prerequisites':
      return `${engine.name} needs its setup finished first.`;
    default:
      return `${engine.name} is not ready yet.`;
  }
}

function toOption(
  engine: ExternalEngineReadinessProjection,
  agents: AgentData[],
  devicePresentation: DevicePresentation | undefined,
): FirstRunEngineOption {
  const base = {
    engineId: engine.engineId as string,
    name: engine.name,
    ...(engine.engineConnectionId
      ? { engineConnectionId: engine.engineConnectionId }
      : {}),
  };
  const existing = engine.engineConnectionId
    ? findAuthoredAgentForEngineConnection(agents, engine.engineConnectionId)
    : undefined;
  if (existing) {
    return {
      ...base,
      state: 'enabled',
      defaultChecked: true,
      selectable: false,
      note: engine.ready
        ? `Already set up as “${existing.name}”.`
        : `Already set up as “${existing.name}”. ${notReadyNote(engine)}`,
    };
  }
  if (engine.ready) {
    // Ready but unaddressable: the registry holds no public
    // EngineConnectionId for this adapter, so there is nothing an Agent could
    // bind to. Show it rather than dropping the row — a silently missing
    // engine is indistinguishable from one Station never supported.
    if (!engine.engineConnectionId) {
      return {
        ...base,
        state: 'blocked',
        defaultChecked: false,
        selectable: false,
        note: `Station has no connection for ${engine.name} yet.`,
      };
    }
    return {
      ...base,
      state: 'available',
      defaultChecked: true,
      selectable: true,
    };
  }
  if (engine.detected || engine.reason === 'cannot_verify') {
    return {
      ...base,
      state: 'blocked',
      defaultChecked: false,
      selectable: false,
      note: notReadyNote(engine),
    };
  }
  return {
    ...base,
    state: 'undetected',
    defaultChecked: false,
    selectable: false,
    // archive#3843: "this machine" is the HOST's machine. On a paired device that
    // sentence is a claim about the wrong computer, so the note names the
    // host and says where the CLI would have to be installed. It still claims
    // nothing about installation state — see `notReadyNote`'s restraint.
    note: hostActionCopy('engine-missing', devicePresentation),
  };
}

/**
 * One option per engine the server reported, ordered actionable-first.
 * `Array.prototype.sort` is stable, so the producer's own order survives
 * inside each group.
 *
 * The FIND runs over the GLOBAL-context scope, never the raw catalog — the
 * same rule `NewChatModal.handleEnable` applies for the same reason (archive#3027
 *), stated once in `selectGlobalContextAgents`. First run has no project
 * context, so a project-OWNED Agent is out of scope here: counting one would
 * render "Already set up as X" for an Agent this context cannot reach, while
 * the global picker still offers Enable for that very engine.
 */
export function buildFirstRunEngineOptions({
  engines,
  agents,
  devicePresentation,
}: {
  engines: readonly ExternalEngineReadinessProjection[];
  agents: AgentData[];
  /**
   * Which machine is reading the checklist. Absent means the server has not
   * said, and the rows then read the way they always have — no device is
   * claimed from nothing.
   */
  devicePresentation?: DevicePresentation | undefined;
}): FirstRunEngineOption[] {
  const scopedAgents = selectGlobalContextAgents(agents);
  return engines
    .map((engine) => toOption(engine, scopedAgents, devicePresentation))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}

/**
 * The row's own sentence, derived from its state rather than written once and
 * reused for every state ( : the card rendered "Already set up
 * as X" beside an unticked box and a "Set up 2" button on two routes seconds
 * apart, so the copy and the state were separately authored and disagreed).
 *
 * One function, four states, no free text at the call site — the row cannot
 * say something the option does not support.
 */
export function firstRunEngineRowLabel(option: FirstRunEngineOption): string {
  switch (option.state) {
    case 'enabled':
      return `Ready — ${option.name}`;
    case 'available':
      return `Enable ${option.name}`;
    default:
      return option.name;
  }
}

/**
 * Whether the chapter has anything to say at all. A machine where Station
 * found nothing gets no card: a list of engines the user does not have is a
 * nag, and Connect has already handled "you have nothing configured".
 */
export function firstRunEngineChapterHasWork(
  options: readonly FirstRunEngineOption[],
): boolean {
  return options.some((option) => option.state !== 'undetected');
}

/**
 * The creates a confirm would perform. `selectable` — not the selection set —
 * is what gates an item: an already-enabled row renders CHECKED, so a
 * selection set alone cannot tell "the user asked for this" from "this
 * already exists", and creating for the latter is exactly the duplicate a
 * second device must never produce.
 */
export function buildFirstRunEnableBatch(
  options: readonly FirstRunEngineOption[],
  selectedEngineIds: readonly string[],
): FirstRunEnablePlanItem[] {
  const selected = new Set(selectedEngineIds);
  const plan: FirstRunEnablePlanItem[] = [];
  for (const option of options) {
    if (!option.selectable || !option.engineConnectionId) continue;
    if (!selected.has(option.engineId)) continue;
    plan.push({
      engineId: option.engineId,
      name: option.name,
      engineConnectionId: option.engineConnectionId,
    });
  }
  return plan;
}

/**
 * The engines a batch was ASKED for and cannot even ATTEMPT (review :
 * the empty-plan shortcut).
 *
 * `buildFirstRunEnableBatch` plans from the CURRENT catalog, so a requested
 * engine that has left it — dropped from `externalEngines`, flipped to
 * `blocked` by a flapping probe, or found to have no addressable connection —
 * simply produces no plan entry. The batch then had NOTHING to run and called
 * the "everything the user asked for exists" exit, which walks on to the
 * questions and records `completed`. On a retry that is the exact defect
 * again by another door: the engine that failed is the one most likely to
 * have gone away, and losing it silently is how a run completes over work it
 * never did.
 *
 * An `enabled` row is deliberately NOT reported here: it has no plan entry
 * because the Agent already exists, which is the second-device case and a
 * genuine resolution. Everything else is stated as a failure, carrying the
 * row's own reason where the catalog still has one rather than a guess.
 */
export function unplannableFirstRunEngineOutcomes(
  options: readonly FirstRunEngineOption[],
  requestedEngineIds: readonly string[],
  /**
   * Display names already known for these engines — a retry's own previous
   * report. An engine that has left the catalog takes its name with it, and
   * "codex: could not be set up" puts a raw id in front of a person; the name
   * the report ALREADY used for that engine is both better copy and a truer
   * statement, because it is what the user was told a moment ago.
   */
  knownNames?: ReadonlyMap<string, string>,
): FirstRunEnableOutcome[] {
  const planned = new Set(
    buildFirstRunEnableBatch(options, requestedEngineIds).map(
      (item) => item.engineId,
    ),
  );
  const seen = new Set<string>();
  const unresolved: FirstRunEnableOutcome[] = [];
  for (const engineId of requestedEngineIds) {
    if (planned.has(engineId) || seen.has(engineId)) continue;
    seen.add(engineId);
    const option = options.find((candidate) => candidate.engineId === engineId);
    if (option?.state === 'enabled') continue;
    const name = option?.name ?? knownNames?.get(engineId) ?? engineId;
    unresolved.push({
      engineId,
      name,
      // No server ever named an Agent for this engine, so the engine's own
      // name stands in rather than a name nothing created.
      agentName: name,
      status: 'failed',
      message: option?.note ?? 'Station is no longer offering it here.',
    });
  }
  return unresolved;
}

/**
 * A materialize call that resolved. `agentName` is the name the SERVER gave
 * the row, not a name this chapter predicted: the call is find-or-create, so
 * on a second device it reports the Agent that already exists — which is what
 * `created` distinguishes, straight from the endpoint's own answer rather
 * than guessed from the catalog. `warnings` is not decoration: the server
 * returns 2xx for an Agent that saved but cannot launch, so a warned create
 * reported as plain success would be a false statement about what the user
 * now has.
 */
export function firstRunEnableSuccessOutcome(
  item: FirstRunEnablePlanItem,
  agentName: string,
  created: boolean,
  warnings?: string[],
): FirstRunEnableOutcome {
  const base = {
    engineId: item.engineId,
    name: item.name,
    agentName,
  };
  if (warnings?.length) return { ...base, status: 'warned', warnings };
  return { ...base, status: created ? 'created' : 'existing' };
}

export function firstRunEnableFailureOutcome(
  item: FirstRunEnablePlanItem,
  error: unknown,
): FirstRunEnableOutcome {
  return {
    engineId: item.engineId,
    name: item.name,
    // A failed create has no server-assigned name to report, so the engine's
    // own name stands in rather than a name nothing ever created.
    agentName: item.name,
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * States what was OBSERVED, which is a successful save — not readiness.
 * "ready as X" was an overclaim: readiness is a different computation
 * (system-status `externalEngines.ready` from a prerequisites probe, or the
 * connection-derived availability the picker reads), the two can disagree for
 * a degraded/unprobed/auth-failed connection, and neither was consulted here.
 */
export function firstRunEnableOutcomeMessage(
  outcome: FirstRunEnableOutcome,
): string {
  switch (outcome.status) {
    case 'created':
      return `${outcome.name}: set up as “${outcome.agentName}”.`;
    case 'existing':
      return `${outcome.name}: already set up as “${outcome.agentName}”.`;
    case 'warned':
      return `${outcome.name}: ${outcome.warnings.join(' ')}`;
    default:
      return `${outcome.name}: could not be set up. ${outcome.message}`;
  }
}

/**
 * The engines a confirm tried to enable and could NOT
 *
 * The distinction this carries is the whole point: `created`, `existing` and
 * `warned` all mean the Agent is materialised — a warned create is a 2xx save
 * that cannot launch yet, which is a state the user now HAS — while `failed`
 * means the engine the user asked for does not exist. A run that ends on a non-empty
 * list here has not done what it said it would, so it may not be recorded as
 * completed.
 */
export function failedFirstRunEngineIds(
  outcomes: readonly FirstRunEnableOutcome[],
): string[] {
  return outcomes
    .filter((outcome) => outcome.status === 'failed')
    .map((outcome) => outcome.engineId);
}

/**
 * `needsAcknowledgement` is the read-me gate: a batch that produced only
 * clean creates has nothing for the user to act on and may advance the run
 * silently; a warning or a failure must be shown and dismissed by hand.
 */
export function summarizeFirstRunEnableOutcomes(
  outcomes: readonly FirstRunEnableOutcome[],
): { needsAcknowledgement: boolean; message: string } {
  const created = outcomes.filter((o) => o.status === 'created').length;
  const existing = outcomes.filter((o) => o.status === 'existing').length;
  const warned = outcomes.filter((o) => o.status === 'warned').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} set up`);
  if (existing > 0) parts.push(`${existing} already set up`);
  if (warned > 0) parts.push(`${warned} saved with warnings`);
  if (failed > 0) parts.push(`${failed} could not be set up`);
  return {
    needsAcknowledgement: warned + failed > 0,
    message: parts.length > 0 ? `${parts.join(' · ')}.` : 'Nothing to set up.',
  };
}
