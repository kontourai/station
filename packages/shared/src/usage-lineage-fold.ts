import {
  CONVERSATION_ENGINE_TOKEN_FIGURES,
  CONVERSATION_REPORTED_COST_UNITS_MAX,
  reportsEngineTokens,
} from '@kontourai/station-contracts/runtime';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  CUMULATIVE_USAGE_PROVIDERS,
  type DroppedUsageFigure,
  type EngineReportedCostTotal,
  foldUsageEvents,
  type SessionUsageAggregate,
} from './usage-fold.js';

/**
 * What one engine counted across a conversation's lineage (#5389). Its token
 * figures are on that engine's own scale (its tokenizer, its cache
 * accounting), so they are never added to another engine's.
 */
export interface EngineUsageAggregate {
  /** `event.provider` of the engine's Sessions. */
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns: number;
  toolCalls: number;
  /** The engine's own USD figure; `undefined` = it reported none. */
  reportedCostUsd?: number;
  /** The engine's costs in its own units, one total per unit. */
  reportedCosts?: EngineReportedCostTotal[];
  /** The latest model the engine's Sessions configured. */
  lastModelId?: string;
}

/** A conversation's usage: the Session fold's shape, plus each engine's. */
export interface LineageUsageAggregate extends SessionUsageAggregate {
  /** In the order the engines first ran; absent for a Session's own fold. */
  engines?: EngineUsageAggregate[];
}

const TOKEN_FIGURES = CONVERSATION_ENGINE_TOKEN_FIGURES;

/**
 * Where a cumulative provider records the native thread its running total
 * counts from, on `session.started` and `session.configured` metadata. Codex
 * writes `codexThreadId` (`codex-adapter.ts`): the thread it started, resumed
 * or forked. A resumed thread keeps its counter; a new thread starts at zero.
 */
const NATIVE_THREAD_METADATA_KEY: ReadonlyMap<string, string> = new Map([
  ['codex', 'codexThreadId'],
]);

/**
 * #5389: one conversation's usage from its execution Sessions' events, in
 * lineage order, kept per engine.
 *
 * Folding the whole lineage as one stream let a running total (Codex) be
 * assigned over what had been counted before it, whether by another engine
 * or by an earlier native thread of the same engine. So Sessions are grouped
 * into runs, each run is folded as one stream with {@link foldUsageEvents}
 * (exactly the Session fold), and runs are combined afterwards:
 *
 * - A provider that reports a running total (`CUMULATIVE_USAGE_PROVIDERS`)
 *   continues a run only on the same native thread: the Session's first
 *   recorded thread id equals an earlier run's last one. Codex writes its
 *   `nativeResumeIdentity: 'matched'` marker only when the thread it opened is
 *   the cursor's (the same id it records as `codexThreadId`), so a real
 *   resume always shows as equal ids. A different thread (a fresh context,
 *   another connection, a refused or dead cursor) starts a new run whose
 *   totals add to the engine's earlier runs. A Session that records no thread
 *   id (a failed start, or history from before this repository's reset)
 *   also starts a new run. Like a Claude Code process start without `nativeSessionResumed`,
 *   absence is read as "not resumed": the error direction is a total that is
 *   visibly too high, never a running total silently replacing spend.
 * - Every other provider continues the run of the Session before it when that
 *   Session ran the same engine. Its tokens add per turn either way, and its
 *   cost already splits at `session.started` by `nativeSessionResumed`, which
 *   keeps a resumed Claude Code cost total from being counted twice.
 *
 * Each engine's runs sum into its {@link EngineUsageAggregate}. The
 * conversation's own token figures are an engine's when it is the only one
 * that reported tokens ({@link reportsEngineTokens}), and absent when several
 * did: engines count tokens on different scales, and a sum would be a figure
 * no engine reported. Turns and tool calls (Station counts them) and costs
 * (per unit, never converted) are summed. Provider and MCP servers come from
 * the run that holds the newest Session, and the model from the newest run
 * that has one. Context occupancy comes from the newest run that has one
 * among the runs since the last engine change: another engine's context is
 * not the one the next turn sends, so an engine that has not reported context
 * yet has none rather than its predecessor's.
 *
 * A module of its own so the cached per-Session fold
 * (`USAGE_PROJECTION_VERSION`, pinned to `usage-fold.ts`) is not invalidated
 * by a change that does not touch it.
 */
export function foldLineageUsageEvents(
  sessions: readonly (readonly CanonicalRuntimeEvent[])[],
  onDroppedFigure?: (dropped: DroppedUsageFigure) => void,
): LineageUsageAggregate {
  const runs = groupRuns(sessions);
  if (runs.length === 0) return foldUsageEvents([]);
  const folds = runs.map(({ provider, events, newestSession }) => ({
    provider,
    newestSession,
    usage: foldUsageEvents(events, onDroppedFigure),
  }));
  const engines = new Map<string, EngineUsageAggregate>();
  for (const { provider, usage } of folds) {
    const engine = engines.get(provider) ?? {
      provider,
      turns: 0,
      toolCalls: 0,
    };
    engines.set(provider, addRunUsage(engine, usage));
  }
  const perEngine = [...engines.values()];
  // A Session can continue an earlier run that is not the last one (a Codex
  // resume of an older thread), so runs are ordered by their newest Session.
  const aggregate = latestFigures(
    [...folds].sort((a, b) => a.newestSession - b.newestSession),
  );
  for (const engine of perEngine) addEngineToConversation(aggregate, engine);
  const counted = perEngine.filter(reportsEngineTokens);
  if (counted.length === 1)
    for (const field of TOKEN_FIGURES) {
      const value = counted[0]![field];
      if (value !== undefined) aggregate[field] = value;
    }
  aggregate.engines = perEngine;
  return aggregate;
}

interface UsageRun {
  provider: string;
  events: CanonicalRuntimeEvent[];
  lastThread?: string;
  /** Position in the lineage of the newest Session the run holds. */
  newestSession: number;
}

/** Sessions grouped into runs, by the rules on {@link foldLineageUsageEvents}. */
function groupRuns(
  sessions: readonly (readonly CanonicalRuntimeEvent[])[],
): UsageRun[] {
  const runs: UsageRun[] = [];
  for (const [position, events] of sessions.entries()) {
    // The Session's engine as its own fold names it: the newest event's.
    let provider: string | undefined;
    for (const event of events) if (event.provider) provider = event.provider;
    if (!provider) continue;
    let run: UsageRun | undefined;
    let threads: string[] = [];
    if (CUMULATIVE_USAGE_PROVIDERS.has(provider)) {
      // Thread ids come from NATIVE_THREAD_METADATA_KEY; a cumulative
      // provider with no key there records none, so each of its Sessions
      // starts a run and every Session sums (the fail-safe direction).
      threads = nativeThreads(events, provider);
      run = runOnThread(runs, provider, threads[0]);
    } else if (runs[runs.length - 1]?.provider === provider) {
      run = runs[runs.length - 1];
    }
    if (run) {
      run.events.push(...events);
      run.newestSession = position;
    } else {
      run = { provider, events: [...events], newestSession: position };
      runs.push(run);
    }
    if (threads.length > 0) run.lastThread = threads[threads.length - 1];
  }
  return runs;
}

/** The newest earlier run of this engine whose last thread is `thread`. */
function runOnThread(
  runs: readonly UsageRun[],
  provider: string,
  thread: string | undefined,
): UsageRun | undefined {
  if (thread === undefined) return undefined;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.provider === provider && run.lastThread === thread) return run;
  }
  return undefined;
}

/**
 * The latest figures, by the rules on {@link foldLineageUsageEvents}; `runs`
 * are in the order of their newest Session.
 */
function latestFigures(
  runs: readonly { provider: string; usage: SessionUsageAggregate }[],
): LineageUsageAggregate {
  const { provider: engine, usage: latest } = runs[runs.length - 1]!;
  const newest = (
    key: keyof SessionUsageAggregate,
    sinceEngineChange = false,
  ) => {
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index]!;
      if (sinceEngineChange && run.provider !== engine) return undefined;
      if (run.usage[key] !== undefined) return run.usage;
    }
    return undefined;
  };
  const aggregate: LineageUsageAggregate = {
    turns: 0,
    toolCalls: 0,
    ...(latest.provider ? { provider: latest.provider } : {}),
    ...(latest.engineMcp ? { engineMcp: latest.engineMcp } : {}),
  };
  const model = newest('lastModelId')?.lastModelId;
  if (model) aggregate.lastModelId = model;
  const context = newest('contextTokens', true);
  if (context) {
    aggregate.contextTokens = context.contextTokens;
    aggregate.contextWindowTokens = context.contextWindowTokens;
  }
  const percent = newest('contextPercent', true)?.contextPercent;
  if (percent !== undefined) aggregate.contextPercent = percent;
  return aggregate;
}

/** Counts and costs that are one scale across engines. */
function addEngineToConversation(
  aggregate: LineageUsageAggregate,
  engine: EngineUsageAggregate,
): void {
  aggregate.turns += engine.turns;
  aggregate.toolCalls += engine.toolCalls;
  if (engine.reportedCostUsd !== undefined)
    aggregate.reportedCostUsd = addOptional(
      aggregate.reportedCostUsd,
      engine.reportedCostUsd,
    );
  if (engine.reportedCosts)
    aggregate.reportedCosts = addReportedCosts(
      aggregate.reportedCosts,
      engine.reportedCosts,
    );
}

/**
 * The native thread ids a Session recorded, in order, without repeats. One
 * Session recording two ids is unreachable while native-session ownership
 * refuses a resume that opened a different thread (`codex-adapter.ts`); were
 * it to happen, the Session's own fold would still assign the second thread's
 * total over the first's, so that usage would be dropped there.
 */
function nativeThreads(
  events: readonly CanonicalRuntimeEvent[],
  provider: string,
): string[] {
  const key = NATIVE_THREAD_METADATA_KEY.get(provider);
  if (!key) return [];
  const threads: string[] = [];
  for (const event of events) {
    if (
      event.provider !== provider ||
      (event.method !== 'session.started' &&
        event.method !== 'session.configured')
    )
      continue;
    const thread = event.metadata?.[key];
    if (
      typeof thread === 'string' &&
      thread.length > 0 &&
      threads[threads.length - 1] !== thread
    )
      threads.push(thread);
  }
  return threads;
}

function addOptional(current: number | undefined, value: number): number {
  return (current ?? 0) + value;
}

/** One run's fold added to its engine's running figures. */
function addRunUsage(
  engine: EngineUsageAggregate,
  usage: SessionUsageAggregate,
): EngineUsageAggregate {
  const next: EngineUsageAggregate = {
    ...engine,
    turns: engine.turns + usage.turns,
    toolCalls: engine.toolCalls + usage.toolCalls,
  };
  for (const field of TOKEN_FIGURES) {
    const value = usage[field];
    if (value !== undefined) next[field] = addOptional(engine[field], value);
  }
  if (usage.reportedCostUsd !== undefined)
    next.reportedCostUsd = addOptional(
      engine.reportedCostUsd,
      usage.reportedCostUsd,
    );
  if (usage.reportedCosts)
    next.reportedCosts = addReportedCosts(
      engine.reportedCosts,
      usage.reportedCosts,
    );
  if (usage.lastModelId) next.lastModelId = usage.lastModelId;
  return next;
}

/**
 * Per-unit sums, never converted, in first-seen order; a unit past
 * CONVERSATION_REPORTED_COST_UNITS_MAX is refused, as the fold refuses it.
 */
function addReportedCosts(
  current: readonly EngineReportedCostTotal[] | undefined,
  added: readonly EngineReportedCostTotal[],
): EngineReportedCostTotal[] {
  const byUnit = new Map(
    (current ?? []).map(({ unit, amount }) => [unit, amount]),
  );
  for (const { unit, amount } of added) {
    if (
      !byUnit.has(unit) &&
      byUnit.size >= CONVERSATION_REPORTED_COST_UNITS_MAX
    )
      continue;
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + amount);
  }
  return [...byUnit].map(([unit, amount]) => ({ unit, amount }));
}
