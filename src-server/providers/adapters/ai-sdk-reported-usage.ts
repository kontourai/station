/**
 * station#4197: derives the `token-usage.updated` fields the Bedrock and
 * Ollama adapters publish from the `LLMStreamChunk['usage']` their shared
 * producer (`AiSdkLLMProvider.createStream`) now populates on the finish
 * chunk.
 *
 * Why this is not a straight copy of the normalized figures: ai-sdk's
 * normalization COERCES unreported cache wire fields to `0`
 * (`@ai-sdk/amazon-bedrock`'s `convertBedrockUsage`:
 * `usage.cacheReadInputTokens ?? 0`; `@ai-sdk/openai-compatible`'s
 * `convertOpenAICompatibleChatUsage`:
 * `prompt_tokens_details?.cached_tokens ?? 0`). Publishing those zeros
 * would put an invented measurement on the durable event stream — the
 * station#4198 defect class, and the exact inverse of the absence-direction
 * lie this issue fixes. So each derivation here reads the provider-wire
 * usage object (`usage.raw`, carried verbatim by the producer) and includes
 * a cache field ONLY when the wire actually carried it. Only what the
 * engine reported is reported.
 *
 * Neither derivation emits `totalTokens`. For Bedrock the wire
 * `totalTokens` field exists but nothing in the installed SDK states
 * whether it includes the cache fields, and the `'disjoint'` inclusivity
 * declared for `bedrock` in `PROVIDER_PROMPT_CACHE_INCLUSIVITY`
 * (`@kontourai/station-shared/usage-fold`) requires any reported total to
 * EXCLUDE them — omitting it keeps the declaration honest, and
 * `foldUsageEvents` derives `prompt + completion` (cache-exclusive) from
 * the components either way. Ollama's `total_tokens` is likewise just
 * `prompt + completion` restated; the fold's derivation says the same
 * thing without an extra claim on the wire.
 */

import type { TokenUsageUpdatedEvent } from '@kontourai/station-contracts/runtime-events';
import type { LLMStreamChunk } from '../llm/model-provider-types.js';

/** The subset of `token-usage.updated` fields these adapters can back. */
export type ReportedTokenUsageFields = Pick<
  TokenUsageUpdatedEvent,
  'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

/**
 * A reported token figure is usable only when it is a finite, non-negative
 * number — the same convention `conversation-manager.ts`'s
 * `reportedTokenFigureIsBroken` enforces one layer up. Broken figures are
 * dropped per-field, never coerced to `0`.
 */
function usableTokenFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Bedrock: the wire usage object is the Converse/ConverseStream `usage`
 * (`@ai-sdk/amazon-bedrock`'s zod schema: `{ inputTokens, outputTokens,
 * totalTokens?, cacheReadInputTokens?, cacheWriteInputTokens?,
 * cacheDetails? }`). `promptTokens` is the wire `inputTokens` — the
 * engine's own cache-EXCLUSIVE figure (the SDK's `convertBedrockUsage`
 * maps it to `noCache` and derives its inclusive total by ADDING the cache
 * fields to it) — which is what backs the `'disjoint'` inclusivity
 * declaration for `bedrock`. The normalized `chunk.usage.inputTokens`
 * (cache-inclusive by that same SDK construction) is deliberately not
 * published under that declaration.
 *
 * Fallback: if the wire object is ever absent or shapeless (an SDK
 * normalization change — today `raw` is always set whenever Bedrock
 * reported usage at all), the normalized input/output figures are
 * published WITHOUT any cache field. That keeps this issue's primary
 * defect (usage silently discarded) fixed under SDK drift, and with no
 * cache field on the event no consumer performs a cache-inclusive sum, so
 * the degraded prompt figure (then cache-inclusive) can never double-count
 * — the error direction is a visible, disclosed approximation, not an
 * invisible one.
 */
export function bedrockReportedUsage(
  usage: LLMStreamChunk['usage'],
): ReportedTokenUsageFields | undefined {
  if (!usage) return undefined;
  const wire = asRecord(usage.raw);
  const fields: ReportedTokenUsageFields = {};
  const promptFromWire =
    wire !== undefined && usableTokenFigure(wire.inputTokens);
  if (promptFromWire) {
    fields.promptTokens = wire.inputTokens as number;
  } else if (usableTokenFigure(usage.inputTokens)) {
    fields.promptTokens = usage.inputTokens;
  }
  if (wire && usableTokenFigure(wire.outputTokens)) {
    fields.completionTokens = wire.outputTokens;
  } else if (usableTokenFigure(usage.outputTokens)) {
    fields.completionTokens = usage.outputTokens;
  }
  // Cache claims come ONLY from the wire object: presence there is the one
  // signal that the engine reported the field (the normalized values are
  // `?? 0`-coerced by the SDK). A reported `0` — a cold cache with caching
  // active reports `cacheReadInputTokens: 0` — is kept, honestly, as a
  // reported zero.
  //
  // AND only when the prompt figure itself came from the wire branch: the
  // normalized fallback prompt figure is cache-INCLUSIVE by SDK
  // construction (`convertBedrockUsage` total), so cache fields riding
  // beside it would be counted twice by every 'disjoint' consumer
  // (`cacheInclusivePromptTokens`) — the invisible double-count the
  // declaration exists to prevent. A degraded prompt figure therefore
  // ships alone (review MEDIUM, station#4197).
  if (promptFromWire && usableTokenFigure(wire.cacheReadInputTokens)) {
    fields.cacheReadTokens = wire.cacheReadInputTokens;
  }
  if (promptFromWire && usableTokenFigure(wire.cacheWriteInputTokens)) {
    fields.cacheWriteTokens = wire.cacheWriteInputTokens;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Ollama (OpenAI-compatible wire): the wire usage object is the chat
 * completion `usage` (`{ prompt_tokens?, completion_tokens?,
 * total_tokens?, prompt_tokens_details?: { cached_tokens? } }`). The
 * normalized `chunk.usage.inputTokens`/`outputTokens` ARE the wire
 * `prompt_tokens`/`completion_tokens` verbatim
 * (`convertOpenAICompatibleChatUsage` sets `total: promptTokens`), so they
 * are published as-is. `cacheReadTokens` is presence-gated on the wire's
 * `prompt_tokens_details.cached_tokens` — Ollama's endpoint does not emit
 * that object today, and an SDK-invented `0` must not become a reported
 * measurement if that ever changes half-way. No `cacheWriteTokens`: the
 * OpenAI-compatible wire has no such field at all.
 *
 * No inclusivity entry is declared for `ollama` in
 * `PROVIDER_PROMPT_CACHE_INCLUSIVITY`: the installed SDK's subtraction
 * (`noCache: promptTokens - cacheReadTokens`) asserts the OpenAI-style
 * `prompt_tokens` INCLUDES cached tokens, but that is a statement about
 * the OpenAI wire vocabulary, not evidence about Ollama's own accounting —
 * and with cache fields presence-gated off a detail object Ollama does not
 * emit, there is nothing an inclusivity declaration would change.
 * Undeclared refuses cache-inclusive sums, which is the honest posture.
 */
export function ollamaReportedUsage(
  usage: LLMStreamChunk['usage'],
): ReportedTokenUsageFields | undefined {
  if (!usage) return undefined;
  const wire = asRecord(usage.raw);
  const fields: ReportedTokenUsageFields = {};
  // The SDK coerces an absent wire figure to 0 (`prompt_tokens ?? 0`), so
  // when the wire object is in hand each headline figure is presence-gated
  // on ITS wire field — an SDK-invented 0 must not become a reported
  // measurement (review MEDIUM, station#4197). Without a wire object the
  // normalized figures are the only signal and are published as-is (the
  // primary defect stays fixed under raw-shape drift; zeros then remain a
  // disclosed SDK approximation).
  // `typeof === 'number'`, not `!== undefined`: the wire schema is
  // `nullish`, so an explicit `"prompt_tokens": null` is the OTHER spelling
  // of absence — the SDK coerces it to 0 exactly like a missing key
  // (delta-review MEDIUM, station#4197).
  const promptReported =
    wire === undefined || typeof wire.prompt_tokens === 'number';
  const completionReported =
    wire === undefined || typeof wire.completion_tokens === 'number';
  if (promptReported && usableTokenFigure(usage.inputTokens)) {
    fields.promptTokens = usage.inputTokens;
  }
  if (completionReported && usableTokenFigure(usage.outputTokens)) {
    fields.completionTokens = usage.outputTokens;
  }
  const wireDetails = wire ? asRecord(wire.prompt_tokens_details) : undefined;
  if (wireDetails && usableTokenFigure(wireDetails.cached_tokens)) {
    fields.cacheReadTokens = wireDetails.cached_tokens;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}
