/**
 * archive#1398 — the AI SDK model that executes a turn on a PEER
 * Station through slice 2's serving route
 * (`docs/design/inference-fleet.md` §3.2 Option A, §2.7, §10 OQ-8, §11 slice 3).
 *
 * One Dispatch candidate = one contributed model on one paired Station. This
 * model is what Dispatch's runtime registry invokes when it routes to that
 * candidate; it posts `POST /api/inference/completions` with the peer's
 * bearer credential and returns the buffered completion.
 *
 * **It is not `delegate_task`, and the shape enforces that.** No tools are
 * forwarded, no session is created, no filesystem path crosses, and no agent
 * slug is sent — the request body carries messages and sampling settings and
 * nothing else, because slice 2's `FleetInferenceCompletionRequest` has no
 * field for anything else. The agent loop, tools, files, and event record
 * stay here.
 *
 * **Buffered, and it says so (§2.7).** Relay has no native streaming and a
 * Dispatch-routed turn does not stream today, so v1 is scoped to
 * non-interactive work. `doStream` therefore does the only honest thing
 * available: it performs the same buffered completion and then emits it,
 * attaching a `compatibility` warning that names the behavior. What it must
 * never do is present that as live token streaming — the design says so of
 * Relay's own compatibility path in as many words, and the routing receipt
 * records `stream.capable: false` alongside.
 *
 * **A refusal is a named failure, never a silent fallback.** Every non-2xx
 * response carries slice 2's `FleetInferenceRefusal` code, and this model
 * throws {@link FleetInferenceRoutingError} carrying it. Dispatch records the
 * failed attempt; the envelope records the peer, the code, and — if a local
 * candidate then served the turn — that the turn fell back
 * (`fell-back-to-local`), which is exactly the transition §4.5's second
 * banned behavior forbids doing silently.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from '@ai-sdk/provider';
import type { ModelInvocationErrorCode } from '@kontourai/relay';
import { ModelInvocationError } from '@kontourai/relay';
import type {
  FleetInferenceCompletionRequest,
  FleetInferenceCompletionResponse,
  FleetInferenceMessage,
  FleetInferenceRefusal,
  FleetInferenceRefusalCode,
} from '@kontourai/station-contracts/fleet-inference';
import {
  FLEET_INFERENCE_LIMITS,
  FLEET_INFERENCE_ROUTE_PREFIX,
} from '@kontourai/station-contracts/fleet-inference';

/** The provider string every fleet candidate reports to the AI SDK. */
export const FLEET_INFERENCE_PROVIDER = 'station-fleet' as const;

/**
 * Wall-clock ceiling on one peer completion from THIS side. Deliberately
 * above the serving Station's own `completionDeadlineMs` so a peer that is
 * enforcing its ceiling gets to answer `completion-timeout` — a named
 * refusal a consumer can act on — rather than being cut off here and read as
 * a bare network failure.
 */
export const FLEET_COMPLETION_TIMEOUT_MS =
  FLEET_INFERENCE_LIMITS.completionDeadlineMs + 15_000;

/**
 * How each peer refusal is projected onto Relay's invocation-error vocabulary
 * (archive#1398 review, finding 2).
 *
 * `retryable` is `true` for EVERY entry, and that is a statement about
 * failover rather than about repeating this call. Dispatch's engine never
 * re-attempts the same candidate — the loop walks the candidate list once —
 * so `retryable` is read in exactly one place, `if (!typed.retryable &&
 * !plan.policy?.retryRuntimeFailures) break;`, where it means "is it worth
 * trying the NEXT candidate". A peer refusing to serve says nothing about the
 * next machine in the plan, so the answer is always yes.
 *
 * The `code` is the closest honest member of Relay's closed union, chosen so
 * the attempt row in the Dispatch receipt still carries a usable shape.
 * `ABORTED` is deliberately absent: the engine treats it as a terminal
 * abort for the whole turn, and a peer declining to serve is not the user
 * cancelling.
 */
const FLEET_REFUSAL_INVOCATION_CODE: Readonly<
  Record<
    FleetInferenceRefusalCode | 'peer-unreachable',
    ModelInvocationErrorCode
  >
> = {
  'peer-unreachable': 'PROVIDER_UNAVAILABLE',
  'contribution-disabled': 'PROVIDER_UNAVAILABLE',
  'model-not-contributed': 'PROVIDER_UNAVAILABLE',
  'model-unavailable': 'PROVIDER_UNAVAILABLE',
  'contribution-unavailable': 'PROVIDER_UNAVAILABLE',
  'capacity-exhausted': 'RATE_LIMITED',
  'completion-timeout': 'PROVIDER_UNAVAILABLE',
  'request-abandoned': 'PROVIDER_UNAVAILABLE',
  'execution-failed': 'RUNTIME_FAILURE',
  'streaming-unsupported': 'INVALID_REQUEST',
  'request-invalid': 'INVALID_REQUEST',
  'request-too-large': 'INVALID_REQUEST',
};

/**
 * A fleet routing attempt that did not produce a completion. Carries the
 * peer's own refusal code when there was one, so the envelope can name the
 * state instead of reporting "it failed".
 *
 * ### Why it extends `ModelInvocationError` (slice 5.5 review, finding 2)
 *
 * It used to extend plain `Error` with a `refusalCode` field and no `code` or
 * `retryable`. Dispatch's `normalizeInvocationError` honors only an error
 * that IS a `ModelInvocationError`, or a duck-typed object carrying a `code`
 * from its closed set AND a boolean `retryable`; anything else collapses to
 * `RUNTIME_FAILURE` with `retryable: false`. So every fleet refusal — a peer
 * that was simply unreachable, or that had turned contribution off — read to
 * the engine as a hard, non-retryable runtime fault and BROKE the failover
 * loop instead of advancing to the next candidate.
 *
 * The consequence was not a degraded message, it was a dead honesty state:
 * `fell-back-to-local` requires a fleet attempt to fail and a local candidate
 * to then succeed, and the loop could never reach the local candidate. §4.5's
 * second banned behavior is falling back silently; slice 3 built the state to
 * name that, and nothing in production could produce it. The only coverage was
 * an envelope-level test with a hand-built `attempts` array, which is exactly
 * why the gap survived — the fixture asserted a receipt shape the engine could
 * not actually emit.
 *
 * This predates the 0.5.0 bump: dispatch 0.2.0's catch block is
 * `error instanceof ModelInvocationError ? error : new
 * ModelInvocationError('RUNTIME_FAILURE', ..., false)`, the same outcome by a
 * shorter path. It is a slice 3 defect the bump made legible, not a
 * regression the bump introduced.
 */
export class FleetInferenceRoutingError extends ModelInvocationError {
  readonly environmentId: string;
  readonly modelId: string;
  readonly refusalCode: FleetInferenceRefusalCode | 'peer-unreachable';

  constructor(input: {
    environmentId: string;
    modelId: string;
    refusalCode: FleetInferenceRefusalCode | 'peer-unreachable';
    message: string;
  }) {
    super(
      FLEET_REFUSAL_INVOCATION_CODE[input.refusalCode] ??
        'PROVIDER_UNAVAILABLE',
      input.message,
      // See FLEET_REFUSAL_INVOCATION_CODE: this is "try the next candidate",
      // not "call this peer again".
      true,
    );
    this.name = 'FleetInferenceRoutingError';
    this.environmentId = input.environmentId;
    this.modelId = input.modelId;
    this.refusalCode = input.refusalCode;
  }
}

export interface FleetInferenceModelOptions {
  environmentId: string;
  environmentLabel: string | null;
  apiBase: string;
  credential: string;
  modelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Flattens the AI SDK's prompt into the serve route's three roles.
 *
 * Tool parts are dropped rather than translated, and that is the contract,
 * not a limitation to fix later: slice 2's request shape has no `tools`
 * field and its service never passes tools to a provider, so a tool part
 * arriving here means a caller tried to route a tool-using turn to a surface
 * that cannot run tools. Dropping it silently would produce a subtly wrong
 * completion, so this throws instead — a named failure beats a plausible
 * answer built from a truncated prompt.
 */
export function toFleetMessages(
  prompt: LanguageModelV3Prompt,
): FleetInferenceMessage[] {
  const messages: FleetInferenceMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'tool') {
      throw new Error(
        'Fleet inference serves model completions only; a tool result cannot be routed to a peer Station.',
      );
    }
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content });
      continue;
    }
    const text = message.content
      .map((part) => {
        if (part.type === 'text') return part.text;
        throw new Error(
          `Fleet inference serves text completions only; a '${part.type}' part cannot be routed to a peer Station.`,
        );
      })
      .join('');
    messages.push({ role: message.role, content: text });
  }
  return messages;
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function usageFrom(
  response: FleetInferenceCompletionResponse,
): LanguageModelV3Usage {
  const usage = emptyUsage();
  if (!response.usage) return usage;
  usage.inputTokens.total = response.usage.inputTokens;
  usage.outputTokens.total = response.usage.outputTokens;
  usage.outputTokens.text = response.usage.outputTokens;
  return usage;
}

/**
 * Maps the serve route's own stop reason onto the SDK's unified vocabulary,
 * carrying the provider's raw reason through in `raw`.
 *
 * `response-bound` — the serving Station's own character ceiling truncated
 * the answer — becomes `length`, not `stop`. Slice 2 separated the two
 * precisely so "the model stopped" and "this Station's ceiling stopped it"
 * stay distinguishable; collapsing them here is how a truncated answer would
 * read as a complete one on the consumer.
 */
function finishReasonFrom(
  completion: FleetInferenceCompletionResponse,
): LanguageModelV3FinishReason {
  return {
    unified: completion.stop === 'response-bound' ? 'length' : 'stop',
    raw: completion.finishReason ?? undefined,
  };
}

/**
 * The warning attached to every fleet result. `compatibility`, not
 * `unsupported`: the completion IS produced, it is simply produced by
 * buffering rather than streaming, and the AI SDK's own vocabulary has a
 * word for that. §2.7 is explicit that this must not be described as live
 * token streaming, so the sentence says what happened.
 */
function bufferedWarning(environmentLabel: string): SharedV3Warning {
  return {
    type: 'compatibility',
    feature: 'streaming',
    details: `This turn was generated on ${environmentLabel} and returned in full when it finished. It is buffered, not live token streaming.`,
  };
}

export function createFleetInferenceModel(
  options: FleetInferenceModelOptions,
): LanguageModelV3 {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FLEET_COMPLETION_TIMEOUT_MS;
  const label = options.environmentLabel ?? options.environmentId;

  async function complete(
    callOptions: LanguageModelV3CallOptions,
  ): Promise<FleetInferenceCompletionResponse> {
    const body: FleetInferenceCompletionRequest = {
      model: options.modelId,
      messages: toFleetMessages(callOptions.prompt),
      ...(callOptions.maxOutputTokens !== undefined
        ? { maxOutputTokens: callOptions.maxOutputTokens }
        : {}),
      ...(callOptions.temperature !== undefined
        ? { temperature: callOptions.temperature }
        : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortOuter = () => controller.abort();
    callOptions.abortSignal?.addEventListener('abort', abortOuter);

    let response: Response;
    try {
      response = await fetchImpl(
        `${options.apiBase}${FLEET_INFERENCE_ROUTE_PREFIX}/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new FleetInferenceRoutingError({
        environmentId: options.environmentId,
        modelId: options.modelId,
        refusalCode: 'peer-unreachable',
        message: `${label} did not answer this fleet completion (${error instanceof Error ? error.name : 'transport failure'}).`,
      });
    } finally {
      clearTimeout(timer);
      callOptions.abortSignal?.removeEventListener('abort', abortOuter);
    }

    if (!response.ok) {
      let refusal: FleetInferenceRefusal | undefined;
      try {
        refusal = (
          (await response.json()) as { refusal?: FleetInferenceRefusal }
        ).refusal;
      } catch {
        refusal = undefined;
      }
      throw new FleetInferenceRoutingError({
        environmentId: options.environmentId,
        modelId: options.modelId,
        refusalCode: refusal?.code ?? 'execution-failed',
        // The peer's own sentence is safe to relay: slice 2 guarantees a
        // refusal `message` is one sentence, never an upstream error string.
        message: refusal?.message ?? `${label} refused this fleet completion.`,
      });
    }

    const payload = (await response.json()) as {
      completion?: FleetInferenceCompletionResponse;
    };
    if (
      !payload?.completion ||
      typeof payload.completion.content !== 'string'
    ) {
      throw new FleetInferenceRoutingError({
        environmentId: options.environmentId,
        modelId: options.modelId,
        refusalCode: 'execution-failed',
        message: `${label} returned a fleet completion this Station could not read.`,
      });
    }
    return payload.completion;
  }

  return {
    specificationVersion: 'v3',
    provider: FLEET_INFERENCE_PROVIDER,
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(
      callOptions: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> {
      const completion = await complete(callOptions);
      return {
        content: [{ type: 'text', text: completion.content }],
        finishReason: finishReasonFrom(completion),
        usage: usageFrom(completion),
        warnings: [bufferedWarning(label)],
      };
    },

    async doStream(
      callOptions: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3StreamResult> {
      const completion = await complete(callOptions);
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [bufferedWarning(label)] },
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: completion.content },
        { type: 'text-end', id: '0' },
        {
          type: 'finish',
          finishReason: finishReasonFrom(completion),
          usage: usageFrom(completion),
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
