import type { ProviderPromptCacheInclusivity } from '@kontourai/station-contracts/usage-stats';

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
    // Muse serve emits the usage of each model call, not its wire cumulative
    // field (MuseServeSession.onTokenUsage; captured session/tokenUsage frames).
    ['muse', 'per-turn'],
    // The attached OpenCode source sums the `step-finish` usage of one turn's
    // assistant messages and emits it once, when that turn closes
    // (`opencode-session-source.ts`), so each event is that turn's figure.
    ['opencode', 'per-turn'],
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
  // OpenCode stores step input with cache reads and writes already
  // subtracted (`Session.getUsage`: `input = inputTokens - cacheRead -
  // cacheWrite`, after AI SDK v6 made `inputTokens` cache-inclusive), and the
  // attached OpenCode source publishes no `totalTokens`.
  ['opencode', 'disjoint'],
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
