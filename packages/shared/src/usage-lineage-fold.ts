import { CONVERSATION_REPORTED_COST_UNITS_MAX } from '@kontourai/station-contracts/runtime';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
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

const TOKEN_FIGURES = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;

/**
 * #5389: one conversation's usage from its execution Sessions' events, in
 * lineage order, kept per engine.
 *
 * Folding the whole lineage as one stream let an engine that reports a
 * running total (Codex) assign it over what a per-turn engine (Claude Code)
 * had summed. So consecutive Sessions of one engine are folded as one stream
 * (a run) with {@link foldUsageEvents}, and runs are combined afterwards:
 *
 * - Within a run the stream is folded exactly as before. A successor resumes
 *   its predecessor's native transcript only when both ran the same engine
 *   (`continuationLaunchContext` in `conversation-lineage.ts`), and a resumed
 *   Codex thread's running total, or Claude Code's resumed cost, already
 *   includes the predecessor's usage; folding each Session alone and adding
 *   them would count it twice.
 * - A different engine between two runs reset the provider cursor, so the
 *   later run started a new native conversation and its figures add to the
 *   earlier run's.
 *
 * Each engine's runs sum into its {@link EngineUsageAggregate}. The
 * conversation's own token figures are an engine's when it is the only one
 * that reported tokens, and absent when several did: engines count tokens on
 * different scales, and a sum would be a figure no engine reported. Turns and
 * tool calls (Station counts them) and costs (per unit, never converted) are
 * summed. The latest figures (model, context, MCP servers, provider) come from
 * the newest run that has one, as the single-stream fold gave them.
 *
 * A module of its own so the cached per-Session fold
 * (`USAGE_PROJECTION_VERSION`, pinned to `usage-fold.ts`) is not invalidated
 * by a change that does not touch it.
 */
export function foldLineageUsageEvents(
  sessions: readonly (readonly CanonicalRuntimeEvent[])[],
  onDroppedFigure?: (dropped: DroppedUsageFigure) => void,
): LineageUsageAggregate {
  const runs: { provider: string; events: CanonicalRuntimeEvent[] }[] = [];
  for (const events of sessions) {
    // The Session's engine as its own fold names it: the newest event's.
    let provider: string | undefined;
    for (const event of events) if (event.provider) provider = event.provider;
    if (!provider) continue;
    const last = runs[runs.length - 1];
    if (last?.provider === provider) last.events.push(...events);
    else runs.push({ provider, events: [...events] });
  }
  if (runs.length === 0) return foldUsageEvents([]);

  const folds = runs.map(({ provider, events }) => ({
    provider,
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

  const latest = folds[folds.length - 1]!.usage;
  const newest = (key: keyof SessionUsageAggregate) => {
    for (let index = folds.length - 1; index >= 0; index -= 1)
      if (folds[index]!.usage[key] !== undefined) return folds[index]!.usage;
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
  const context = newest('contextTokens');
  if (context) {
    aggregate.contextTokens = context.contextTokens;
    aggregate.contextWindowTokens = context.contextWindowTokens;
  }
  const percent = newest('contextPercent')?.contextPercent;
  if (percent !== undefined) aggregate.contextPercent = percent;

  const perEngine = [...engines.values()];
  for (const engine of perEngine) {
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
  const counted = perEngine.filter((engine) =>
    TOKEN_FIGURES.some((field) => engine[field] !== undefined),
  );
  if (counted.length === 1)
    for (const field of TOKEN_FIGURES) {
      const value = counted[0]![field];
      if (value !== undefined) aggregate[field] = value;
    }
  aggregate.engines = perEngine;
  return aggregate;
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
