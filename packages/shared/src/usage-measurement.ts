import type { ConversationStatsResponse } from '@kontourai/station-contracts/runtime';

/**
 * ONE representation of "nobody measured this", for every surface
 * (station#3201). The rule is a single sentence: **a measurement is
 * `undefined` when it was never reported, and a number — including `0` —
 * when it was.** It holds from the fold (`SessionUsageAggregate`) through
 * the wire (`ConversationStatsResponse`) to the render, and the helpers
 * below are the only place a surface should turn absence into text.
 *
 * This lives in `@kontourai/station-shared`, not in the one panel that
 * currently renders it, because several surfaces read session usage — the
 * conversation stats modal, the background-task row, and (still on its own
 * substrate) profile analytics. When each invents its own fallback they
 * disagree under one label, which is the defect class this work exists to
 * close, not a style preference.
 *
 * It is a MODULE OF ITS OWN rather than part of `usage-fold.ts` for a
 * measured reason: `usage-fold` is reachable from the UI's eager graph, so
 * folding these strings into it put ~640 gzipped bytes of render-only code
 * in the entry chunk (`scripts/ui-bundle-budget.json`). One home, imported
 * only by the surfaces that render — DRY without the eager weight.
 */
export const UNREPORTED_MEASUREMENT_TEXT = '—';

/** `undefined` -> the shared dash; any reported number -> that number. */
export function formatMeasuredTokens(value: number | undefined): string {
  return value === undefined
    ? UNREPORTED_MEASUREMENT_TEXT
    : value.toLocaleString();
}

/** `undefined` -> the shared dash; a reported `0` -> `$0.0000`, honestly. */
export function formatMeasuredCostUsd(value: number | undefined): string {
  return value === undefined
    ? UNREPORTED_MEASUREMENT_TEXT
    : `$${value.toFixed(4)}`;
}

/**
 * The measurement state of one session, in the shape every surface can
 * supply — `SessionUsageAggregate` and `ConversationStatsResponse` differ
 * in field NAMES (`reportedCostUsd` vs `estimatedCost`), so each caller
 * maps its own two or three fields in rather than this growing two
 * overloads that could drift.
 */
export interface SessionMeasurementView {
  /**
   * `engine-events` — folded from what an engine reported, so an absent
   * field is a question nobody asked. `station-memory` — Station's own
   * accounting, where absence is a recorded zero and there is nothing to
   * disclose.
   */
  source: 'station-memory' | 'engine-events';
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  contextTokens?: number;
}

/**
 * Which CLASSES of measurement this session has none of — derived from the
 * fields that actually came back absent, never from a per-engine capability
 * list. A hardcoded "Claude reports cost, ACP does not" table in a surface
 * is the same defect as a hardcoded price table: it is a label that drifts
 * from what the engine did on this session (a Claude turn that crashed
 * reports no cost either).
 *
 * Empty for a `station-memory` view, and empty when everything was
 * reported.
 */
export function unreportedMeasurementClasses(
  view: SessionMeasurementView,
): string[] {
  if (view.source !== 'engine-events') return [];
  const classes: string[] = [];
  if (
    view.inputTokens === undefined &&
    view.outputTokens === undefined &&
    view.totalTokens === undefined
  ) {
    classes.push('token counts');
  }
  if (view.costUsd === undefined) classes.push('cost');
  if (view.contextTokens === undefined) classes.push('context usage');
  return classes;
}

/**
 * The one sentence a surface shows instead of an unexplained grid of
 * dashes: which engine, and which classes it reported nothing for.
 *
 * `resolveEngineLabel` is injected rather than imported so this stays the
 * single sentence while the single engine-name map stays wherever it
 * already lives (`engineLabelForProvider`, `src-ui/src/utils/sessionDisplay.ts`)
 * — one derivation each, neither duplicated. An unknown provider falls back
 * to its raw id, because an identifier actually observed on the session
 * beats an invented product name.
 */
export function describeUnreportedMeasurements(
  view: SessionMeasurementView,
  resolveEngineLabel: (provider: string) => string | null,
): string | null {
  const classes = unreportedMeasurementClasses(view);
  if (classes.length === 0) return null;
  const engine =
    (view.provider ? resolveEngineLabel(view.provider) : null) ??
    view.provider ??
    'This session’s engine';
  const listed =
    classes.length === 1
      ? classes[0]
      : `${classes.slice(0, -1).join(', ')} or ${classes[classes.length - 1]}`;
  return `${engine} did not report ${listed} for this session. Station shows only what the engine measured — it does not estimate these.`;
}

/**
 * Map a conversation-stats RESPONSE onto the view above. The only thing
 * this mapping owns is the field-name difference — `estimatedCost` on the
 * wire is the provider's `reportedCostUsd` in the fold — so no surface
 * re-derives "what did this engine fail to report" from the wire shape.
 */
export function conversationStatsMeasurementView(
  stats: Pick<
    ConversationStatsResponse,
    | 'inputTokens'
    | 'outputTokens'
    | 'totalTokens'
    | 'estimatedCost'
    | 'contextTokens'
    | 'measurement'
  >,
): SessionMeasurementView {
  return {
    source: stats.measurement?.source ?? 'station-memory',
    provider: stats.measurement?.provider,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    totalTokens: stats.totalTokens,
    costUsd: stats.estimatedCost,
    contextTokens: stats.contextTokens,
  };
}
