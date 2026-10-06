import {
  CUMULATIVE_USAGE_PROVIDERS,
  isValidContextObservation,
} from './usage-semantics.js';

export type { ProviderPromptCacheInclusivity } from '@kontourai/station-contracts/usage-stats';
export {
  type CacheAwareTokenComponents,
  CUMULATIVE_USAGE_PROVIDERS,
  cacheInclusivePromptTokens,
  cacheInclusiveTotalTokens,
  isValidContextObservation,
  PROVIDER_PROMPT_CACHE_INCLUSIVITY,
  PROVIDER_USAGE_SCOPE,
  type ProviderUsageScope,
  providerPromptCacheInclusivity,
  providerUsageScope,
} from './usage-semantics.js';

import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * Engine-agnostic usage/activity totals for one session (station#1299,
 * slice 1). Every value is a plain accumulation over the session's
 * persisted `CanonicalRuntimeEvent` stream.
 *
 * **Absent is not zero (station#3201).** Every measurement an engine may
 * or may not report is optional, and is present only when at least one
 * observation actually carried it. `inputTokens: undefined` means "no
 * engine event ever reported prompt tokens for this session"; `0` means an
 * engine reported zero. Collapsing the two is how a panel came to render
 * six invented numbers beside one real one, so consumers must keep them
 * apart all the way to the render — the same rule the per-turn envelope
 * already follows (`TurnProvenanceUsage` in
 * `@kontourai/station-contracts/turn-provenance`).
 *
 * `turns` and `toolCalls` are deliberately NOT optional: they count
 * `turn.completed`/`tool.completed` events, which Station observes for
 * itself rather than receiving as a provider measurement, so zero there is
 * a real count of zero completed turns.
 */
export interface SessionUsageAggregate {
  /** Sum/latest of reported prompt tokens; `undefined` = never reported. */
  inputTokens?: number;
  /** Sum/latest of reported completion tokens; `undefined` = never reported. */
  outputTokens?: number;
  /** `undefined` = neither a total nor any component was ever reported. */
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns: number;
  toolCalls: number;
  lastModelId?: string;
  /** Latest valid provider-reported context occupancy; never cumulative. */
  contextTokens?: number;
  /** Window paired with `contextTokens` in the same provider observation. */
  contextWindowTokens?: number;
  /**
   * Provider-reported cost in USD, carried verbatim — never recomputed
   * from tokens against a local price table, because the provider is the
   * authority on what it charged (station#1299 item 4). `undefined` means
   * the engine reported no cost; `0` would mean it reported zero.
   */
  reportedCostUsd?: number;
  /**
   * Provider id observed on the folded events (`event.provider`), or
   * `undefined` when the stream was empty. Lets a consumer say WHICH
   * engine failed to report a class of measurement instead of showing a
   * grid of dashes with no explanation.
   */
  provider?: string;
}

function emptyAggregate(): SessionUsageAggregate {
  return {
    turns: 0,
    toolCalls: 0,
  };
}

/**
 * What ONE `token-usage.updated` event's `reportedCostUsd` measures.
 *
 * This is a SEPARATE declaration from {@link PROVIDER_USAGE_SCOPE} — not
 * duplication — because one provider can report tokens and cost on the same
 * event with different scopes, and Claude Code does:
 *
 * - Its `usage.input_tokens`/`usage.output_tokens` on the `result` message
 *   are "MAIN AGENT LOOP ONLY … per-turn in streaming-input sessions" (the
 *   Agent SDK's own field docs), so tokens are `per-turn` and summed.
 * - Its `total_cost_usd` on the SAME message is documented as "cumulative
 *   estimated cost in USD for this `query()` call … each result carries the
 *   running total so far, so read the latest result rather than summing".
 *
 * Station's Claude adapter builds ONE `query()` per engine process and
 * pushes every turn into its open `AsyncUserMessageQueue`
 * (`claude-adapter.ts`'s `startTrackedSession`), so that running total spans
 * the whole process. What happens at the NEXT process depends on how it
 * started (station#3320, Agent SDK 0.3.278 `total_cost_usd` docs, confirmed
 * by a live probe):
 *
 * - A process started WITHOUT `resume` begins a new transcript, and its
 *   total starts again from zero, so the previous process's final figure is
 *   banked and summed.
 * - A process started WITH `resume` (idle parking, server restart, adoption)
 *   "continues from the total its transcript saved, when it has one": its
 *   first result already includes the earlier spend, so it SUPERSEDES the
 *   previous figure rather than adding to it. The adapter records this on
 *   `session.started` (see {@link sessionStartedResumedNativeSession}).
 *
 * The scope is named `engine-process-cumulative` because the reset boundary
 * is a non-resumed engine process start, never a turn. See
 * {@link CumulativeCostSegments} for the one derivation the session fold and
 * the usage receipts share.
 *
 * An unlisted provider defaults to `per-turn` (sum), matching
 * {@link PROVIDER_USAGE_SCOPE}'s fail-safe: the error direction is a total
 * that is visibly too high, not a silent under-report.
 */
export type ProviderCostScope = 'per-turn' | 'engine-process-cumulative';

export const PROVIDER_COST_SCOPE: ReadonlyMap<string, ProviderCostScope> =
  new Map<string, ProviderCostScope>([['claude', 'engine-process-cumulative']]);

/** `undefined` means nobody has declared this provider's cost scope. */
export function providerCostScope(
  provider: string,
): ProviderCostScope | undefined {
  return PROVIDER_COST_SCOPE.get(provider);
}

/**
 * `session.started` metadata key the Claude adapter sets to `true` when the
 * engine process was started by resuming an existing native transcript (the
 * SDK `resume` option). Its presence is a recorded fact, not an inference.
 */
export const NATIVE_SESSION_RESUMED_METADATA_KEY = 'nativeSessionResumed';

/**
 * Whether a `session.started` event records a resumed native transcript.
 *
 * Only an explicit `true` counts. Events written before station#3320 carry
 * no marker and read as NOT resumed, so their processes keep the earlier
 * per-process sum. That over-reports a resumed session's cost exactly as
 * before (a visible, too-high total) rather than guessing a continuation
 * and silently dropping a fresh process's spend.
 */
export function sessionStartedResumedNativeSession(event: {
  metadata?: Record<string, unknown>;
}): boolean {
  return event.metadata?.[NATIVE_SESSION_RESUMED_METADATA_KEY] === true;
}

/**
 * Splits one thread's `engine-process-cumulative` cost figures into
 * segments, each of which is ONE running total: the segment's latest figure
 * is its cost, and the session's cost is the sum over segments.
 *
 * A new segment opens when:
 *
 * - a `session.started` is NOT a resume — the new process starts from zero;
 * - a figure is LOWER than the running figure it would replace. A running
 *   total never decreases, so a lower figure cannot be a continuation: it is
 *   a reset (`/clear`), a resume whose transcript saved no total, or the
 *   zeroed figure a crashed or startup-error result carries (a resume of a
 *   missing transcript reports `0`, confirmed live). Banking the earlier
 *   figure keeps that spend instead of overwriting it with less.
 *
 * A resumed `session.started` opens nothing: the resumed process's figures
 * continue the previous running total (and are checked against it by the
 * rule above). An EQUAL figure stays in the segment: a resume handshake
 * result (`num_turns: 0`) restates the saved total unchanged.
 *
 * Known blind spots of this heuristic (the SDK reports no starting total):
 *
 * - A reset (`/clear`, or a resume whose transcript saved no total) whose
 *   FIRST figure is already above the previous running total reads as a
 *   continuation, so the spend before the reset is undercounted.
 * - A restated total slightly LOWER than the last live figure (a transcript
 *   that saved an earlier total than the one last reported) opens a new
 *   segment, so the restated part is overcounted.
 *
 * Shared by `foldUsageEvents` and the usage receipt reader
 * (`EventStore.listUsageReceiptEvents`), so the session total and the
 * receipt rollup can never disagree about which figures supersede which.
 * The segment key keeps the pre-station#3320 receipt identity (the count of
 * non-resumed process starts) when no reset was observed.
 */
export class CumulativeCostSegments {
  private epoch = 0;
  private resets = 0;
  private banked: number | undefined;
  private running: number | undefined;

  /** Records a `session.started`; `resumed` is the adapter's marker. */
  sessionStarted(resumed: boolean): void {
    if (resumed) return;
    this.bank();
    this.epoch += 1;
    this.resets = 0;
  }

  /** Records one usable figure and returns the key of its segment. */
  observe(figure: number): string {
    if (this.running !== undefined && figure < this.running) {
      this.bank();
      this.resets += 1;
    }
    this.running = figure;
    return this.resets === 0 ? `${this.epoch}` : `${this.epoch}.${this.resets}`;
  }

  /** Sum of every segment's latest figure; `undefined` when none observed. */
  total(): number | undefined {
    if (this.banked === undefined && this.running === undefined)
      return undefined;
    return (this.banked ?? 0) + (this.running ?? 0);
  }

  private bank(): void {
    if (this.running === undefined) return;
    this.banked = addOptional(this.banked, this.running);
    this.running = undefined;
  }
}

/**
 * A cost figure is only usable when it is a finite, non-negative number.
 * A negative or non-finite value is a broken observation, not a measurement
 * of zero, so it is dropped rather than folded in as `0`.
 */
export function isUsableCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A token figure this fold may accumulate: finite, non-negative, a real
 * number. Same contract as {@link isUsableCost} and the birth-site guards
 * (`tokenCount`, `usableTokenFigure`, `optionalNumber`).
 *
 * Birth-site guards remain the primary defence, and this is deliberately NOT
 * a silent backstop for them — see the drop notice at the call site. It
 * exists because the fold's input is the DURABLE event stream
 * (`listEventPayloads` → `eventStore.listEvents`), so it replays rows written
 * before those guards existed. Such a row cannot carry `NaN`/`Infinity`:
 * `JSON.stringify` writes both as `null`. `null` then passes an
 * `!== undefined` gate, and what happens next depends on the provider's
 * declared scope — both outcomes are harms this fold exists to prevent:
 *
 * - CUMULATIVE providers (codex) ASSIGN the figure, so `null` reaches
 *   `conversation-manager`'s `reportedTokenFigureIsBroken` and throws — a
 *   permanent 500 on that conversation's stats, on every read.
 * - PER-TURN providers (claude, bedrock, ollama, and the undeclared
 *   default) accumulate through `addOptional`, where `0 + null` coerces to
 *   `0` — a silent invented measurement rather than a throw.
 *
 * Treating the figure as ABSENT is what makes the historical row readable
 * again without inventing anything. Verified end-to-end against the real
 * sqlite event store for both branches.
 */
function isUsableTokenFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** What a dropped token figure reports: enough to find the producer. */
export interface DroppedUsageFigure {
  field: string;
  value: unknown;
  provider?: string;
  threadId?: string;
  turnId?: string;
}

/**
 * Returns the figure when usable, or `undefined` after REPORTING the drop.
 * Absent input is absent, not a drop — only a present-but-unusable value is
 * a producer defect worth surfacing.
 */
function usableTokenFigureOrDrop(
  value: number | undefined,
  field: string,
  event: { provider?: string; threadId?: string; turnId?: string },
  report?: (dropped: DroppedUsageFigure) => void,
): number | undefined {
  if (value === undefined) return undefined;
  if (isUsableTokenFigure(value)) return value;
  report?.({
    field,
    value,
    provider: event.provider,
    threadId: event.threadId,
    turnId: event.turnId,
  });
  return undefined;
}

/** Adds `value` to `current`, treating an absent `current` as "not yet seen". */
function addOptional(current: number | undefined, value: number): number {
  return (current ?? 0) + value;
}

function readSessionConfiguredModel(
  event: Extract<CanonicalRuntimeEvent, { method: 'session.configured' }>,
): string | undefined {
  const metadataModel = event.metadata?.effectiveModel;
  if (typeof metadataModel === 'string' && metadataModel) return metadataModel;
  if (typeof event.model === 'string' && event.model) return event.model;
  return undefined;
}

/** Retained record attribution, not a claim about the exact time of consumption. */
export interface UsageObservation extends CacheAwareTokenComponents {
  sourceEventId: string;
  recordedAt?: string;
  modelId?: string;
  provider?: string;
  principal?: PrincipalRef;
  messages: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
}

export interface SessionUsageObservationProjection {
  usage: SessionUsageAggregate;
  observations: UsageObservation[];
  unmeasuredCostTurns: number;
}

type AllocatedFigure =
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'reportedCostUsd';

/** Uses the same validated figures and scope decisions as the session fold. */
class UsageObservationCollector {
  private modelId?: string;
  private modelRevision = 0;
  private figures = new Map<AllocatedFigure, Map<string, UsageObservation>>();
  private previous = new Map<
    AllocatedFigure,
    {
      value: number;
      modelRevision: number;
      modelId?: string;
      principalId?: string;
    }
  >();
  private costSegments = new CumulativeCostSegments();
  private costSegment?: string;
  private committedCosts: UsageObservation[] = [];
  private activity: UsageObservation[] = [];
  private turnModels = new Map<string, string>();
  private turnUsageObservations = new Map<string, number>();
  private turnPrincipals = new Map<string, PrincipalRef>();
  private ambiguousPrincipalTurns = new Set<string>();
  private costTurns = new Set<string>();
  private completedTurns = new Set<string>();

  constructor(events: readonly CanonicalRuntimeEvent[]) {
    for (const event of events) {
      if (event.method === 'token-usage.updated' && event.turnId)
        this.turnUsageObservations.set(
          event.turnId,
          (this.turnUsageObservations.get(event.turnId) ?? 0) + 1,
        );
      if (event.method === 'turn.started' && isPrincipalRef(event.principal)) {
        const previous = this.turnPrincipals.get(event.turnId);
        if (previous && previous.id !== event.principal.id)
          this.ambiguousPrincipalTurns.add(event.turnId);
        this.turnPrincipals.set(event.turnId, event.principal);
      }
      if (event.method === 'turn.completed') {
        const model = event.metadata?.reportedModel;
        if (typeof model === 'string' && model)
          this.turnModels.set(event.turnId, model);
      }
    }
  }

  observe(event: CanonicalRuntimeEvent): void {
    if (event.method === 'session.configured') {
      const model = readSessionConfiguredModel(event);
      if (model && model !== this.modelId) {
        this.modelId = model;
        this.modelRevision += 1;
      }
    }
    if (event.method === 'session.started') {
      this.costSegments.sessionStarted(
        sessionStartedResumedNativeSession(event),
      );
    }
    if (event.method === 'turn.completed') {
      this.completedTurns.add(event.turnId);
      this.activity.push({ ...this.attribution(event), messages: 1 });
    }
  }

  private attribution(event: CanonicalRuntimeEvent): UsageObservation {
    return {
      sourceEventId: event.eventId,
      recordedAt: event.createdAt,
      provider: event.provider,
      modelId:
        (event.turnId &&
          (event.method !== 'token-usage.updated' ||
            this.turnUsageObservations.get(event.turnId) === 1) &&
          this.turnModels.get(event.turnId)) ||
        this.modelId,
      principal:
        event.turnId && !this.ambiguousPrincipalTurns.has(event.turnId)
          ? this.turnPrincipals.get(event.turnId)
          : undefined,
      messages: 0,
    };
  }

  figure(
    event: CanonicalRuntimeEvent,
    field: AllocatedFigure,
    value: number | undefined,
    cumulative: boolean,
  ): void {
    if (value === undefined) return;
    if (field === 'reportedCostUsd' && event.turnId)
      this.costTurns.add(event.turnId);
    let figures = this.figures.get(field);
    if (!figures) {
      figures = new Map();
      this.figures.set(field, figures);
    }
    if (field === 'reportedCostUsd' && cumulative) {
      const segment = this.costSegments.observe(value);
      if (this.costSegment !== undefined && segment !== this.costSegment) {
        for (const cost of figures.values()) this.committedCosts.push(cost);
        figures.clear();
        this.previous.delete(field);
      }
      this.costSegment = segment;
    }
    const previous = this.previous.get(field);
    const row = this.attribution(event);
    let amount = value;
    if (cumulative) {
      if (previous && value < previous.value) {
        // A corrected cumulative total cannot tell us which earlier records
        // to subtract from. Replace the distribution with an unallocated fact.
        figures.clear();
        delete row.recordedAt;
        delete row.modelId;
        delete row.principal;
      } else {
        amount = value - (previous?.value ?? 0);
        if (
          !previous ||
          previous.modelRevision !== this.modelRevision ||
          previous.modelId !== row.modelId
        ) {
          // Initial thread/process baselines and intervals crossing a model
          // change cannot establish a per-model or per-person consumption split.
          delete row.modelId;
          delete row.principal;
        }
        if (previous?.principalId !== row.principal?.id) delete row.principal;
      }
      this.previous.set(field, {
        value,
        modelRevision: this.modelRevision,
        modelId: this.attribution(event).modelId,
        principalId: this.attribution(event).principal?.id,
      });
    }
    figures.set(event.eventId, { ...row, [field]: amount });
  }

  finish(usage: SessionUsageAggregate): SessionUsageObservationProjection {
    return {
      usage,
      observations: [
        ...this.activity,
        ...this.committedCosts,
        ...Array.from(this.figures.values()).flatMap((figures) => [
          ...figures.values(),
        ]),
      ],
      unmeasuredCostTurns: [...this.completedTurns].filter(
        (turnId) => !this.costTurns.has(turnId),
      ).length,
    };
  }
}

/** One linear fold supplies canonical totals and their conservative record allocation. */
export function foldUsageObservationProjection(
  events: CanonicalRuntimeEvent[],
  onDroppedFigure?: (dropped: DroppedUsageFigure) => void,
): SessionUsageObservationProjection {
  const collector = new UsageObservationCollector(events);
  const usage = foldUsageEventsInner(events, onDroppedFigure, collector);
  return collector.finish(usage);
}

/**
 * Pure, deterministic fold of a durable `CanonicalRuntimeEvent` stream (the
 * orchestration EventStore) into session-level usage/activity totals.
 *
 * Engine-agnostic by construction: every provider's adapter publishes the
 * same canonical `token-usage.updated` / `turn.completed` / `tool.completed`
 * / `session.configured` events (see `packages/contracts/src/runtime-events.ts`),
 * so this reducer needs no per-adapter integration to light up a new engine
 * — it only reads events already being persisted today. No I/O, no
 * clock/random; output depends only on the input array.
 *
 * Field mapping:
 * - `inputTokens`/`outputTokens`/`totalTokens`/`cacheReadTokens`/
 *   `cacheWriteTokens` accumulate from `token-usage.updated` events
 *   (`promptTokens`/`completionTokens`/`totalTokens`/`cacheReadTokens`/
 *   `cacheWriteTokens` on the event). Most providers report a per-turn
 *   delta and are summed; Codex reports a cumulative running total and is
 *   replaced rather than summed — see `CUMULATIVE_USAGE_PROVIDERS`. A field
 *   no event ever carried stays `undefined` rather than defaulting to `0`
 *   (station#3201) — ACP, for instance, reports context occupancy and
 *   nothing else, so an ACP session honestly has no in/out/total figure.
 * - `reportedCostUsd` carries the provider's own cost verbatim, folded
 *   under `PROVIDER_COST_SCOPE` (which is NOT the token scope — see there).
 *   A cumulative reporter's figures are split by
 *   {@link CumulativeCostSegments}: a non-resumed restart sums one final
 *   figure per engine process, while a resumed process's figures supersede
 *   the running total they continue (station#3320), so neither a
 *   restatement nor a resumed process's carried-over spend is counted
 *   twice, and no earlier process's spend is discarded.
 * - `turns` counts `turn.completed` events (a turn that is aborted or
 *   errors before completing is not counted — mirrors what the legacy
 *   memory-store hook counted).
 * - `toolCalls` counts `tool.completed` events, regardless of `status`
 *   (success/error/cancelled/unresolved all count as a completed call,
 *   matching how the issue describes "every engine emits them").
 * - `lastModelId` is the last non-empty model carried by a
 *   `session.configured` event (`metadata.effectiveModel`, falling back to
 *   the event's own `model` field) — the latest one wins, matching how the
 *   shared `runtime-event-projection.ts` treats `session.configured` as a
 *   fallback model source.
 * - `contextTokens`/`contextWindowTokens` retain the last valid paired
 *   provider observation. They are not token usage and are never added to
 *   input, output, or total counters.
 *
 * Deliberately out of scope for this slice (station#1299's "fastest path"
 * items 1-3 only): cost/pricing, context-window sizing, and per-model
 * breakdowns — those are follow-up work the issue itself scopes separately
 * (architecture pieces C/D).
 */
export function foldUsageEvents(
  events: CanonicalRuntimeEvent[],
  onDroppedFigure?: (dropped: DroppedUsageFigure) => void,
): SessionUsageAggregate {
  return foldUsageEventsInner(events, onDroppedFigure);
}

function foldUsageEventsInner(
  events: CanonicalRuntimeEvent[],
  onDroppedFigure?: (dropped: DroppedUsageFigure) => void,
  observations?: UsageObservationCollector,
): SessionUsageAggregate {
  const aggregate = emptyAggregate();
  /** Running totals from `engine-process-cumulative` cost reporters. */
  const cumulativeCost = new CumulativeCostSegments();
  /** Sum of every `per-turn` (or undeclared) provider's reported cost. */
  let perTurnCostUsd: number | undefined;

  for (const event of events) {
    if (event.provider) aggregate.provider = event.provider;
    observations?.observe(event);
    switch (event.method) {
      case 'token-usage.updated': {
        // Producer boundaries own the malformed-figure signal, and every
        // live producer of this event guards: Claude with tokenCount, Codex
        // with extractTokenFigure, Bedrock and Ollama with usableTokenFigure,
        // the Claude transcript source with its own tokenCount, and ACP
        // publishes only the separately validated context pair. Keep those
        // exhaustive so a future producer defect stays visible upstream.
        //
        // This gate is not a replacement for them: it exists because the fold
        // replays DURABLE history, including rows written before those guards
        // existed (see isUsableTokenFigure). A dropped figure is reported, not
        // swallowed — silence here would hide exactly the producer defect the
        // birth-site guards are meant to surface.
        const cumulative = CUMULATIVE_USAGE_PROVIDERS.has(event.provider);
        const promptTokens = usableTokenFigureOrDrop(
          event.promptTokens,
          'promptTokens',
          event,
          onDroppedFigure,
        );
        const completionTokens = usableTokenFigureOrDrop(
          event.completionTokens,
          'completionTokens',
          event,
          onDroppedFigure,
        );
        // A total is reported outright, or derivable from whichever
        // components WERE reported. When none were, there is no total —
        // `0` here would be an invented measurement.
        const reportedTotal = usableTokenFigureOrDrop(
          event.totalTokens,
          'totalTokens',
          event,
          onDroppedFigure,
        );
        const totalTokens =
          reportedTotal ??
          (promptTokens !== undefined || completionTokens !== undefined
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : undefined);
        const cacheReadTokens = usableTokenFigureOrDrop(
          event.cacheReadTokens,
          'cacheReadTokens',
          event,
          onDroppedFigure,
        );
        const cacheWriteTokens = usableTokenFigureOrDrop(
          event.cacheWriteTokens,
          'cacheWriteTokens',
          event,
          onDroppedFigure,
        );

        observations?.figure(event, 'inputTokens', promptTokens, cumulative);
        observations?.figure(
          event,
          'outputTokens',
          completionTokens,
          cumulative,
        );
        observations?.figure(event, 'totalTokens', totalTokens, cumulative);
        observations?.figure(
          event,
          'cacheReadTokens',
          cacheReadTokens,
          cumulative,
        );
        observations?.figure(
          event,
          'cacheWriteTokens',
          cacheWriteTokens,
          cumulative,
        );
        observations?.figure(
          event,
          'reportedCostUsd',
          isUsableCost(event.reportedCostUsd)
            ? event.reportedCostUsd
            : undefined,
          providerCostScope(event.provider) === 'engine-process-cumulative',
        );

        if (promptTokens !== undefined) {
          aggregate.inputTokens = cumulative
            ? promptTokens
            : addOptional(aggregate.inputTokens, promptTokens);
        }
        if (completionTokens !== undefined) {
          aggregate.outputTokens = cumulative
            ? completionTokens
            : addOptional(aggregate.outputTokens, completionTokens);
        }
        if (totalTokens !== undefined) {
          aggregate.totalTokens = cumulative
            ? totalTokens
            : addOptional(aggregate.totalTokens, totalTokens);
        }
        if (cacheReadTokens !== undefined) {
          aggregate.cacheReadTokens = cumulative
            ? cacheReadTokens
            : addOptional(aggregate.cacheReadTokens, cacheReadTokens);
        }
        if (cacheWriteTokens !== undefined) {
          aggregate.cacheWriteTokens = cumulative
            ? cacheWriteTokens
            : addOptional(aggregate.cacheWriteTokens, cacheWriteTokens);
        }
        if (isUsableCost(event.reportedCostUsd)) {
          if (providerCostScope(event.provider) === 'engine-process-cumulative')
            cumulativeCost.observe(event.reportedCostUsd);
          else
            perTurnCostUsd = addOptional(perTurnCostUsd, event.reportedCostUsd);
        }
        if (
          isValidContextObservation(
            event.contextTokens,
            event.contextWindowTokens,
          )
        ) {
          aggregate.contextTokens = event.contextTokens;
          aggregate.contextWindowTokens = event.contextWindowTokens;
        } else if (
          event.contextWindowTokens === undefined &&
          typeof event.contextTokens === 'number' &&
          Number.isFinite(event.contextTokens) &&
          event.contextTokens >= 0
        ) {
          // Occupancy without a window: some engines report what they sent
          // but not how large the window is (Claude Code), so the window is
          // resolved from the model inventory one layer up. Both fields
          // move together — a later window-less observation must not be
          // read against an earlier engine-reported window, or the
          // percentage pairs two different moments.
          aggregate.contextTokens = event.contextTokens;
          aggregate.contextWindowTokens = undefined;
        }
        // An event carrying occupancy alongside an UNUSABLE window (zero,
        // negative, non-finite) is a broken observation, not a window-less
        // one, and is dropped whole — as before.
        break;
      }
      case 'session.started': {
        // A new engine process. Unless it resumed its native transcript,
        // a cumulative reporter's running cost total restarts from zero
        // here, so the previous process's figure is banked.
        cumulativeCost.sessionStarted(
          sessionStartedResumedNativeSession(event),
        );
        break;
      }
      case 'turn.completed': {
        aggregate.turns += 1;
        break;
      }
      case 'tool.completed': {
        // station#1558: an `unresolved` completion counts here like every
        // other status. This counter is a count of tool calls the session
        // MADE — it already includes calls that failed and calls that were
        // cancelled, neither of which produced a useful result either. The
        // unresolved one was dispatched to the engine exactly the same way;
        // only its outcome is unknown. Excluding it would make the number
        // disagree with the transcript, which shows the row, and with
        // `turn-provenance-fold.ts`, which counts the same event — and it
        // would quietly under-report sessions that ended mid-tool, the
        // exact population this status exists to make visible. What the
        // count must NOT be read as is "tool calls that produced a result";
        // the per-turn envelope's `succeeded`/`failed`/`cancelled`/
        // `unresolved` breakdown is where that distinction lives.
        aggregate.toolCalls += 1;
        break;
      }
      case 'session.configured': {
        const model = readSessionConfiguredModel(event);
        if (model) aggregate.lastModelId = model;
        break;
      }
      default:
        break;
    }
  }

  const cumulativeCostUsd = cumulativeCost.total();
  if (cumulativeCostUsd !== undefined || perTurnCostUsd !== undefined) {
    aggregate.reportedCostUsd =
      (cumulativeCostUsd ?? 0) + (perTurnCostUsd ?? 0);
  }

  return aggregate;
}
