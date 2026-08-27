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
 * A context observation is only useful as a pair: zero used tokens is valid,
 * while a zero, negative, or non-finite window cannot produce a percentage.
 */
export function isValidContextObservation(
  contextTokens: unknown,
  contextWindowTokens: unknown,
): contextTokens is number {
  return (
    typeof contextTokens === 'number' &&
    Number.isFinite(contextTokens) &&
    contextTokens >= 0 &&
    typeof contextWindowTokens === 'number' &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  );
}

/**
 * What ONE `token-usage.updated` event from a provider actually measures.
 *
 * - `per-turn` — the figures describe only the turn they are tagged with, so
 *   a session total is their sum and a turn total is the event itself.
 * - `session-cumulative` — the figures are a running session-to-date total
 *   that supersedes the previous event, so a session total is the latest
 *   value and there is NO honest per-turn reading of it.
 *
 * A provider absent from `PROVIDER_USAGE_SCOPE` is undeclared, and the two
 * consumers below disagree about what to do with that on purpose, because
 * the fail-safe direction is opposite for each:
 *
 * - The session fold (`foldUsageEvents`) treats undeclared as `per-turn`
 *   (sum). Wrong only for an undeclared cumulative reporter, and the error
 *   is a session total that is too high — visible, and the pre-existing
 *   behavior.
 * - The per-TURN envelope (`turn-provenance-fold.ts`) treats undeclared as
 *   a disclosed gap. Guessing `per-turn` there would print a brand-new
 *   adapter's session totals as a per-answer measurement with no signal at
 *   all that it was a guess — an invisible over-report, which is the one
 *   outcome the envelope must never produce.
 *
 * So: adding an adapter that emits usage requires declaring its scope here.
 * Until someone does, its per-answer usage reads as "scope undeclared", not
 * as a number.
 */
export type ProviderUsageScope = 'per-turn' | 'session-cumulative';

export const PROVIDER_USAGE_SCOPE: ReadonlyMap<string, ProviderUsageScope> =
  new Map<string, ProviderUsageScope>([
    ['claude', 'per-turn'],
    ['codex', 'session-cumulative'],
    // station#4197: both declared `per-turn` from the construction of their
    // own emission sites, not from protocol folklore. Each adapter publishes
    // exactly one `token-usage.updated` per completed turn, inside
    // `publishCompletion`, built from the finish chunk of THAT turn's single
    // ai-sdk `streamText` call (`AiSdkLLMProvider.createStream` populates
    // `chunk.usage` from `result.usage`, the per-call figure) — no
    // cross-turn accumulator exists in either adapter, unlike Codex's
    // protocol-side cumulative `tokenUsage.total`. Summing per-turn events
    // is therefore the only honest session total.
    ['bedrock', 'per-turn'],
    ['ollama', 'per-turn'],
  ]);

/** `undefined` means nobody has declared this provider's usage scope. */
export function providerUsageScope(
  provider: string,
): ProviderUsageScope | undefined {
  return PROVIDER_USAGE_SCOPE.get(provider);
}

/**
 * Providers whose `token-usage.updated` event reports a cumulative
 * session-to-date total that supersedes the previous event, rather than a
 * per-turn delta that must be summed to get a session total. Derived from
 * `PROVIDER_USAGE_SCOPE` so there is exactly one place to declare a
 * provider's semantics.
 *
 * This is not a guess: Codex's app-server protocol nests the figure as
 * `tokenUsage.total` (`src-server/providers/adapters/codex-adapter-notifications.ts`,
 * the `thread/tokenUsage/updated` case) — the adapter deliberately extracts
 * that `.total` sub-object, which the protocol defines as the
 * cumulative-since-thread-start count (the same notification also carries a
 * per-turn `lastTokenUsage` the adapter does not use). Claude Code's
 * `token-usage.updated` (`claude-adapter-events.ts`'s `result`-message
 * handler), by contrast, is built straight from that single query's own
 * `usage.input_tokens`/`usage.output_tokens` — scoped to that one turn, so
 * it must be summed across turns to reach a session total.
 *
 * Getting this wrong is not cosmetic: summing Codex's cumulative restatements
 * across turns would multiply a multi-turn session's reported usage instead
 * of reporting it once. Add a provider here only on the same kind of
 * confirmed protocol evidence — the safe default for an unlisted/future
 * provider is "sum" (treat each event as its own incremental contribution).
 *
 * Exported because the same fact decides a different question one layer up
 * (station#1410): a cumulative reporter's `token-usage.updated` carries a
 * SESSION total even though it is tagged with a turn id, so the per-turn
 * provenance envelope must refuse to present it as that turn's usage. One
 * declaration, two consumers — see `turn-provenance-fold.ts`.
 */
export const CUMULATIVE_USAGE_PROVIDERS: ReadonlySet<string> = new Set<string>(
  [...PROVIDER_USAGE_SCOPE.entries()]
    .filter(([, scope]) => scope === 'session-cumulative')
    .map(([provider]) => provider),
);

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
 * Station's Claude adapter builds ONE `query()` per session and pushes every
 * turn into its open `AsyncUserMessageQueue`
 * (`claude-adapter.ts`'s `startTrackedSession`), so that running total spans
 * the whole session — until the session is restarted or resumed, which
 * builds a NEW `query()` whose total starts again from zero. That is why the
 * scope is named `engine-process-cumulative` rather than
 * "session-cumulative": the reset boundary is the engine process, and the
 * fold sees it as a `session.started` event. Summing across those restarts
 * (and only across them) is what reconstructs the session's real cost.
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
 * Whether a provider's reported prompt (`promptTokens`) figure INCLUDES the
 * cache fields it reports beside it — i.e. whether
 * `input + cacheRead + cacheWrite` is an honest prompt-side sum or a
 * double-count. This is a THIRD declaration alongside
 * {@link PROVIDER_USAGE_SCOPE} and {@link PROVIDER_COST_SCOPE} — not
 * duplication — because it answers a different question about the same
 * event: scope says how figures accumulate across events; inclusivity says
 * what one event's prompt figure already contains.
 *
 * - `'disjoint'` — the prompt figure EXCLUDES the cache fields, AND any
 *   reported `totalTokens` excludes them too (consumers rely on both: the
 *   prompt-side sum, and relabeling/summing on top of the reported total —
 *   a provider whose total already includes cache must NOT be declared
 *   `'disjoint'` even if its prompt figure is cache-exclusive, or
 *   `cacheInclusiveTotalTokens` double-counts invisibly). So the tokens
 *   actually put in front of the model are
 *   `input + cacheRead + cacheWrite`, and summing them is backed. Claude:
 *   the adapter builds `promptTokens` from the Agent SDK result's
 *   `usage.input_tokens`, which carries the Messages API usage shape where
 *   `input_tokens` excludes `cache_creation_input_tokens` and
 *   `cache_read_input_tokens` — the same reading the adapter's own context
 *   occupancy derivation already depends on
 *   (`claude-adapter-events.ts`: "the uncached prompt plus what was read
 *   from and written to the cache").
 * - `'subset'` — the cache figures are already counted INSIDE the prompt
 *   figure, so the prompt figure is itself cache-inclusive and adding cache
 *   to it double-counts. No current provider is declared this. Nothing
 *   compile-forces consumers to branch on it: every current consumer is an
 *   equality test against `'disjoint'`, so a future subset reporter takes
 *   the unsummed branch — safe (no double-count; the provider's own figures
 *   render, components disclosed), just not a bespoke rendering.
 * - `'unverified'` — nobody has confirmed either reading against protocol
 *   evidence. Codex: its `tokenUsage.total.cachedInputTokens` is PLAUSIBLY
 *   a subset of `inputTokens` (the OpenAI-style
 *   `prompt_tokens_details.cached_tokens` is), but the app-server protocol
 *   source is not in this repo and nothing here has verified it
 *   (station#4196 keeps that verification open). `'unverified'` is an
 *   EXPLICIT union member rather than an absent entry so "declared unknown"
 *   stays distinguishable from "nobody has declared anything" — both refuse
 *   the sum, but only the former is a considered answer.
 *
 * A provider absent from the map is UNDECLARED (`undefined`). For summing
 * purposes consumers treat `undefined`, `'unverified'`, and `'subset'`
 * identically: never sum. Refusing the sum fails safe in the visible
 * direction — a figure labeled as no more than it is — whereas guessing
 * `'disjoint'` for a subset reporter would double-count invisibly, which is
 * the one outcome a usage label must never produce (station#4196's 212x
 * under-report is the disjoint-side twin of that failure).
 */
export type ProviderPromptCacheInclusivity =
  | 'disjoint'
  | 'subset'
  | 'unverified';

export const PROVIDER_PROMPT_CACHE_INCLUSIVITY: ReadonlyMap<
  string,
  ProviderPromptCacheInclusivity
> = new Map<string, ProviderPromptCacheInclusivity>([
  ['claude', 'disjoint'],
  ['codex', 'unverified'],
  // station#4197, Bedrock: `'disjoint'` is backed by the installed SDK's own
  // encoding of the Converse wire protocol, plus what the adapter actually
  // publishes. `@ai-sdk/amazon-bedrock`'s `convertBedrockUsage`
  // (node_modules/@ai-sdk/amazon-bedrock/dist/index.mjs) maps the wire
  // `usage.inputTokens` to `noCache` and derives its inclusive figure by
  // ADDING `cacheReadInputTokens`/`cacheWriteInputTokens` to it
  // (`total: inputTokens + cacheReadTokens + cacheWriteTokens`) — an
  // explicit vendor statement that Bedrock's `inputTokens` EXCLUDES both
  // cache fields. The Bedrock adapter's `token-usage.updated` publishes
  // exactly those wire figures (`bedrockReportedUsage`,
  // src-server/providers/adapters/ai-sdk-reported-usage.ts): `promptTokens`
  // is the wire `inputTokens`, cache fields ride only when the wire carried
  // them, and NO `totalTokens` is ever published (the wire `totalTokens`'
  // inclusivity is not stated by the SDK, so the fold's own
  // cache-exclusive `prompt + completion` derivation stands instead) —
  // satisfying both halves of the `'disjoint'` contract above.
  //
  // Ollama is deliberately NOT declared: the OpenAI-compatible SDK's
  // subtraction (`noCache: promptTokens - cacheReadTokens`) is a statement
  // about the OpenAI wire vocabulary, not evidence about Ollama's own
  // accounting, and the Ollama adapter presence-gates `cacheReadTokens` on
  // a `prompt_tokens_details` object Ollama's endpoint does not emit today
  // — undeclared refuses the sum, which is the honest posture until real
  // Ollama-side evidence exists.
  ['bedrock', 'disjoint'],
]);

/** `undefined` means nobody has declared this provider's cache inclusivity. */
export function providerPromptCacheInclusivity(
  provider: string | undefined,
): ProviderPromptCacheInclusivity | undefined {
  return provider === undefined
    ? undefined
    : PROVIDER_PROMPT_CACHE_INCLUSIVITY.get(provider);
}

/** The token components a cache-inclusive derivation reads. */
export interface CacheAwareTokenComponents {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Shared guard for the two derivations below: a cache-inclusive sum exists
 * only when (a) the provider's inclusivity is declared `'disjoint'` — the
 * only declaration that BACKS adding cache to the prompt figure — and (b) at
 * least one cache field was actually reported. When no cache field was ever
 * observed there is nothing to add and no summed CLAIM to make; the plain
 * figures already say everything that was measured (absent is not zero —
 * station#3201).
 */
function backsCacheInclusiveSum(
  provider: string | undefined,
  usage: CacheAwareTokenComponents,
): boolean {
  return (
    providerPromptCacheInclusivity(provider) === 'disjoint' &&
    (usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined)
  );
}

/**
 * Prompt-side tokens actually put in front of the model —
 * `input + cacheRead + cacheWrite` — or `undefined` when the declared
 * inclusivity does not back that sum (or no cache field was reported, so
 * there is nothing to add). Absent components contribute nothing, mirroring
 * how `foldUsageEvents` derives a total from whichever components were
 * reported.
 *
 * This is the DERIVATION behind any label claiming cache-inclusive sent
 * tokens; a surface that renders such a total without going through here
 * (or an equivalent inclusivity check) is asserting a property nothing
 * computes.
 */
export function cacheInclusivePromptTokens(
  provider: string | undefined,
  usage: CacheAwareTokenComponents,
): number | undefined {
  if (!backsCacheInclusiveSum(provider, usage)) return undefined;
  // A "prompt total" with no reported input figure would be a cache-only
  // number claiming totality — refuse rather than silently understate.
  if (usage.inputTokens === undefined) return undefined;
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * Whole-session (or whole-turn) tokens including cache —
 * `(total ?? input + output) + cacheRead + cacheWrite` — under the same
 * inclusivity gate as {@link cacheInclusivePromptTokens}. For a `'disjoint'`
 * provider the reported/derived `totalTokens` is `input + output` and
 * excludes cache, so this is the honest headline figure; for every other
 * declaration (or none) it returns `undefined` and the caller keeps the
 * provider's own figures unsummed.
 */
export function cacheInclusiveTotalTokens(
  provider: string | undefined,
  usage: CacheAwareTokenComponents,
): number | undefined {
  if (!backsCacheInclusiveSum(provider, usage)) return undefined;
  const base =
    usage.totalTokens ??
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  // No base figure at all means a cache-only number would be claiming to be
  // the session total — refuse rather than silently understate.
  if (base === undefined) return undefined;
  return base + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * A cost figure is only usable when it is a finite, non-negative number.
 * A negative or non-finite value is a broken observation, not a measurement
 * of zero, so it is dropped rather than folded in as `0`.
 */
function isUsableCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
 *   A cumulative reporter's running total is committed at each
 *   `session.started`, so a session that was restarted or resumed sums one
 *   final figure per engine process instead of double-counting restatements
 *   within a process or discarding an earlier process's spend.
 * - `turns` counts `turn.completed` events (a turn that is aborted or
 *   errors before completing is not counted — mirrors what the legacy
 *   memory-store hook counted).
 * - `toolCalls` counts `tool.completed` events, regardless of `status`
 *   (success/error/cancelled all count as a completed call, matching how
 *   the issue describes "every engine emits them").
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
): SessionUsageAggregate {
  const aggregate = emptyAggregate();
  /** Cost committed by engine processes that have already been superseded. */
  let committedCostUsd: number | undefined;
  /** Cost reported by the engine process currently being folded. */
  let currentProcessCostUsd: number | undefined;

  for (const event of events) {
    if (event.provider) aggregate.provider = event.provider;
    switch (event.method) {
      case 'token-usage.updated': {
        const cumulative = CUMULATIVE_USAGE_PROVIDERS.has(event.provider);
        const promptTokens = event.promptTokens;
        const completionTokens = event.completionTokens;
        // A total is reported outright, or derivable from whichever
        // components WERE reported. When none were, there is no total —
        // `0` here would be an invented measurement.
        const totalTokens =
          event.totalTokens ??
          (promptTokens !== undefined || completionTokens !== undefined
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : undefined);

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
        if (event.cacheReadTokens !== undefined) {
          aggregate.cacheReadTokens = cumulative
            ? event.cacheReadTokens
            : addOptional(aggregate.cacheReadTokens, event.cacheReadTokens);
        }
        if (event.cacheWriteTokens !== undefined) {
          aggregate.cacheWriteTokens = cumulative
            ? event.cacheWriteTokens
            : addOptional(aggregate.cacheWriteTokens, event.cacheWriteTokens);
        }
        if (isUsableCost(event.reportedCostUsd)) {
          currentProcessCostUsd =
            providerCostScope(event.provider) === 'engine-process-cumulative'
              ? event.reportedCostUsd
              : addOptional(currentProcessCostUsd, event.reportedCostUsd);
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
        // A new engine process: a cumulative reporter's running cost total
        // restarts from zero here, so bank what the previous process
        // reported before the next event overwrites it.
        if (currentProcessCostUsd !== undefined) {
          committedCostUsd = addOptional(
            committedCostUsd,
            currentProcessCostUsd,
          );
          currentProcessCostUsd = undefined;
        }
        break;
      }
      case 'turn.completed': {
        aggregate.turns += 1;
        break;
      }
      case 'tool.completed': {
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

  if (committedCostUsd !== undefined || currentProcessCostUsd !== undefined) {
    aggregate.reportedCostUsd =
      (committedCostUsd ?? 0) + (currentProcessCostUsd ?? 0);
  }

  return aggregate;
}
