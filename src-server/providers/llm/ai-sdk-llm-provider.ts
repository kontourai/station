/**
 * Shared base for ai-sdk-backed LLM providers (Anthropic, Google, …).
 *
 * Chat and streaming go through ai-sdk's `streamText`, so we never hand-roll an
 * HTTP/SSE client — the same ai-sdk model the managed runtimes consume (VoltAgent
 * directly, Strands via VercelModel) backs the connection lifecycle too. A
 * subclass supplies only what genuinely differs between providers: the ai-sdk
 * model factory, the provider's model-listing call, and its prerequisite.
 */

import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { type LanguageModel, streamText } from 'ai';
import { resolveModelRequestOptions } from '../../runtime/frameworks/framework-model-factory.js';
import { throwIfAborted } from '../../utils/bounded-async.js';
import { providerHttpErrorStatus } from '../registries/catalog-http.js';
import type {
  ILLMProvider,
  LLMModel,
  LLMStreamChunk,
  LLMStreamOpts,
  ModelCatalogRequest,
} from './model-provider-types.js';

export interface AiSdkProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /**
   * archive#1994: provider-wire request-body defaults for completion calls
   * (see `AiSdkModelOptions.requestBodyDefaults`). Persisted on the
   * connection as `config.modelRequestOptions`.
   */
  modelRequestOptions?: Record<string, unknown>;
}

/**
 * archive#3545 review HIGH: `AiSdkLLMProvider.createStream` used to omit
 * `finishReason` from its `finish` chunk unconditionally, even though
 * ai-sdk's `StreamTextResult.finishReason` (`Promise<FinishReason>`,
 * `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`
 * per the installed `ai` package) is always available once the stream
 * settles. Fixing only `BedrockAdapter`'s `normalizeFinishReason` (this
 * issue's original fix) relocated the mislabel rather than removing it: with
 * absence collapsing to `'stop'` at the adapter, a genuine truncation
 * (`'length'`) or content-filter stop would ALSO have reported `'stop'` —
 * still a label nothing derives, just one line later. Mapping the real
 * ai-sdk vocabulary onto ours here, at the shared producer every
 * `AiSdkLLMProvider` subclass (Bedrock, Anthropic, Google, OpenAI-compat,
 * Ollama) inherits, is the actual root cause fix — the corrected
 * `finishReason` is now AVAILABLE TO every one of those subclasses and to
 * `FleetInferenceService` (which reads `chunk.finishReason` directly).
 * Availability is not the same as consumption: `BedrockAdapter.sendTurn`
 * reads it (that is this issue's actual subject), but as of this change
 * `OllamaAdapter.sendTurn` still does not — it never reads
 * `chunk.finishReason` and always defaults to `'stop'` regardless of what
 * the producer now supplies (tracked separately as archive#3588).
 *
 * `'length'` maps to our `'max-tokens'`; `'content-filter'`, `'error'`, and
 * any future/unrecognized string map to `'other'` — station's vocabulary has
 * no error-shaped terminal `finishReason`, so `'other'` is the only honest
 * target at this layer for any of them. `undefined` (the promise rejected,
 * or ai-sdk itself never resolved a value) stays `undefined` — absence must
 * still stay absence, exactly as archive#3545's original fix established one
 * layer up.
 *
 * archive#3586 (was archive#3545 review round 2 MEDIUM, corrected here): a
 * genuine mid-stream failure IS now guaranteed to surface as a thrown
 * `{ type: 'error' }` chunk rather than landing here as `reason: 'error'`.
 * `createStream` used to consume only `result.textStream` (whose transform
 * forwards `text-delta` parts and drops everything else, including `error`
 * parts — ai-sdk enqueues a mid-stream failure as an ordinary stream part;
 * `consumeStream`'s `onError` only fires when the READER throws, which a
 * settled-but-errored stream never does), so a mid-generation ai-sdk failure
 * used to reach this function as `rawFinishReason: 'error'`, fall into the
 * `default` arm below, map to `'other'`, and publish an ordinary
 * `turn.completed` — a failure indistinguishable from success. `createStream`
 * now consumes `result.fullStream` and translates an `error` part directly
 * into station's `{ type: 'error' }` chunk BEFORE this function ever runs for
 * that turn (see the `for await` loop above, which `return`s on that part
 * without reaching the finish-chunk code that calls this function). This
 * function's `default → 'other'` arm remains reachable only for a
 * `rawFinishReason` ai-sdk resolves to something outside `'stop' |
 * 'tool-calls' | 'length' | undefined` WITHOUT an `error` part having been
 * seen first (e.g. `'content-filter'`, ai-sdk's own `'other'`, or a future
 * value) — a well-formed unclassified terminal, not a dropped failure.
 */
function mapAiSdkFinishReason(
  reason: string | undefined,
): 'stop' | 'tool-calls' | 'max-tokens' | 'other' | undefined {
  switch (reason) {
    case 'stop':
    case 'tool-calls':
      return reason;
    case 'length':
      return 'max-tokens';
    case undefined:
      return undefined;
    default:
      return 'other';
  }
}

/**
 * archive#4197: a reported token figure is usable only when it is a finite,
 * non-negative number — the same convention the fold's consumers enforce
 * (`reportedTokenFigureIsBroken` in `conversation-manager.ts`). A `NaN` or
 * negative value is a broken observation and is dropped per-field, never
 * coerced to `0` (archive#3201: absent is not zero).
 */
function usableTokenFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * archive#4197: maps ai-sdk's `LanguageModelUsage` (the installed `ai`
 * package's shape: flat `inputTokens`/`outputTokens`/`totalTokens` plus
 * `inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}` and
 * `raw`) onto `LLMStreamChunk['usage']`. Structural rather than typed
 * against `LanguageModelUsage` so a mocked or partial result degrades to
 * absence instead of a crash. Returns `undefined` — not `{}` and not zeros
 * — when the result carries nothing usable at all, so "the SDK reported no
 * usage" stays distinguishable from "the SDK reported usage of zero".
 */
function normalizeAiSdkUsage(value: unknown): LLMStreamChunk['usage'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const details =
    typeof usage.inputTokenDetails === 'object' &&
    usage.inputTokenDetails !== null
      ? (usage.inputTokenDetails as Record<string, unknown>)
      : undefined;
  const normalized: NonNullable<LLMStreamChunk['usage']> = {};
  if (usableTokenFigure(usage.inputTokens)) {
    normalized.inputTokens = usage.inputTokens;
  }
  if (usableTokenFigure(usage.outputTokens)) {
    normalized.outputTokens = usage.outputTokens;
  }
  if (usableTokenFigure(usage.totalTokens)) {
    normalized.totalTokens = usage.totalTokens;
  }
  if (details && usableTokenFigure(details.cacheReadTokens)) {
    normalized.cacheReadTokens = details.cacheReadTokens;
  }
  if (details && usableTokenFigure(details.cacheWriteTokens)) {
    normalized.cacheWriteTokens = details.cacheWriteTokens;
  }
  if (typeof usage.raw === 'object' && usage.raw !== null) {
    normalized.raw = usage.raw;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export abstract class AiSdkLLMProvider implements ILLMProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  readonly abortSettlement = 'await' as const;
  protected readonly apiKey?: string;
  protected readonly baseUrl?: string;
  protected readonly modelRequestOptions?: Record<string, unknown>;

  constructor({ apiKey, baseUrl, modelRequestOptions }: AiSdkProviderConfig) {
    this.apiKey = AiSdkLLMProvider.clean(apiKey);
    this.baseUrl = AiSdkLLMProvider.clean(baseUrl);
    this.modelRequestOptions = resolveModelRequestOptions({
      modelRequestOptions,
    });
  }

  private static clean(value?: string): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  /** Build the ai-sdk language model for a given model id. */
  protected abstract languageModel(modelId: string): LanguageModel;

  abstract listModels(options?: ModelCatalogRequest): Promise<LLMModel[]>;
  abstract getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]>;

  async *createStream(opts: LLMStreamOpts): AsyncIterable<LLMStreamChunk> {
    try {
      // archive#3598: this object is built with a typed base literal plus
      // plain `if`-guarded property ASSIGNMENT for the optional fields,
      // deliberately NOT the conditional-spread idiom
      // (`...(x !== undefined ? { field: x } : {})`) the previous code used.
      // That idiom is exactly how `maxTokens` (station's own `LLMStreamOpts`
      // field name, not ai-sdk's — the real `streamText`/`CallSettings`
      // field is `maxOutputTokens`) went unnoticed: TypeScript's
      // excess-property check only fires on an object literal's own
      // directly-written properties, and a property contributed through a
      // spread — even a spread merged into a variable with an explicit
      // type annotation — is exempt from that check (confirmed empirically:
      // reintroducing `maxTokens` via the conditional-spread form here typechecks
      // clean under `Parameters<typeof streamText>[0]`, while the assignment
      // form below reports `TS2339: Property 'maxTokens' does not exist`).
      // Plain property assignment (`streamTextOptions.foo = value`) is
      // checked as an ordinary property write against the target's declared
      // type regardless of freshness, so it DOES catch a misnamed field at
      // compile time. Do not convert this back to a conditional spread.
      const streamTextOptions: Parameters<typeof streamText>[0] = {
        model: this.languageModel(opts.model),
        messages: opts.messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
        })),
        abortSignal: opts.signal,
      };
      if (opts.temperature !== undefined) {
        streamTextOptions.temperature = opts.temperature;
      }
      if (opts.maxTokens !== undefined) {
        streamTextOptions.maxOutputTokens = opts.maxTokens;
      }
      const result = streamText(streamTextOptions);

      // archive#3586: consume `result.fullStream`, not `result.textStream`.
      // `textStream`'s own transform (`node_modules/ai/dist/index.mjs`)
      // enqueues ONLY `text-delta` parts — an `error` part is enqueued like
      // any other stream part (never thrown), so an ai-sdk failure used to
      // vanish here in total: the loop just ran out of text-delta parts and
      // fell through to the ordinary post-loop finish handling below, which
      // then awaited `result.finishReason` (already resolved to `'error'`,
      // mapped by `mapAiSdkFinishReason`'s default arm to `'other'`) and
      // yielded a normal `finish` chunk — a failed generation reaching every
      // adapter indistinguishable from a genuine success. That population is
      // NOT limited to a failure mid-generation: a REQUEST-TIME failure
      // (e.g. a 401 from the provider's `doStream`, before any text-delta
      // ever arrives) previously yielded nothing on `textStream`, then a
      // bare `finish` chunk with no `finishReason`/`reportedModel` at all —
      // `turn.completed`, published for a request that never produced any
      // output. Same shape for ai-sdk's own `NoOutputGeneratedError` (the
      // stream settles having emitted no content and no explicit `error`
      // part — `node_modules/ai/dist/index.mjs`'s `flush()` synthesizes one:
      // `!hasReceivedTerminalChunk && !hasReceivedOutputChunk` enqueues
      // `{type:'error', error: new NoOutputGeneratedError(...)}`). Both are
      // now `start | error` → station's `{type:'error'}` → `runtime.error`,
      // the same as a mid-stream failure, via the identical branch below —
      // this is arguably the larger fix in this change (it spans every
      // provider family this base class serves, not only turns that got as
      // far as emitting text) and had no dedicated issue or test before
      // `ai-sdk-llm-provider.test.ts`'s "a request-time failure with no
      // text-delta at all" case.
      //
      // `fullStream` exposes the raw part union (`TextStreamPart<TOOLS>`,
      // `node_modules/ai/dist/index.d.ts`): `text-start`/`text-end`/
      // `text-delta`, `reasoning-*`, `tool-input-*`, `source`, `file`,
      // `tool-call`/`tool-result`/`tool-error`/`tool-output-denied`,
      // `start-step`/`finish-step`, `start`/`finish`/`abort`/`error`/`raw`.
      // This loop forwards exactly two of them, matching what `textStream`
      // already forwarded plus the one this issue adds:
      //   - `text-delta` → station's `{ type: 'text-delta' }` chunk, reading
      //     `part.text` (fullStream's text-delta part shape, NOT `.content`
      //     — `textStream`'s transform enqueued the extracted string
      //     directly, this loop must extract it itself).
      //   - `error` → station's existing `{ type: 'error' }` chunk, then
      //     `return` immediately — not `continue`: a real ai-sdk failure
      //     still enqueues `finish-step`/`finish` parts AFTER the `error`
      //     part (`flush()` runs regardless, with `stepFinishReason` set to
      //     `'error'`), so draining the rest of the stream would let the
      //     post-loop finish-chunk code construct and yield an ordinary
      //     `finish` chunk right after the error chunk — a stream that
      //     already reported failure must not also publish a completion.
      //     Every current consumer of `createStream()` — `BedrockAdapter`,
      //     `OllamaAdapter`, `FleetInferenceService` — throws (or sets a
      //     failure flag and breaks) on `chunk.type === 'error'`; this makes
      //     that path reachable for the first time rather than inventing a
      //     new one. (archive#3596: `OllamaAdapter` did NOT have this path
      //     when archive#3586 first landed — an omission that made this
      //     producer change actively harmful for Ollama specifically, since
      //     `return` guarantees no `finish` chunk follows an error, so the
      //     adapter's `finishReason` stayed `undefined` and
      //     `publishCompletion`'s `?? 'stop'` default republished a
      //     truthful-looking `'stop'` for a FAILED turn — and `'stop'` has
      //     clear authority, so a failed turn would have erased its own
      //     recorded auth failure. Closed in the same change as
      //     archive#3586, not left as a follow-up.)
      // Every other part type is silently dropped, exactly as `textStream`
      // silently dropped everything but `text-delta` before this change —
      // in particular `tool-call`/`tool-result`, though already members of
      // station's `LLMStreamChunk['type']` vocabulary, are NOT started here.
      // This is not a claim about what any consumer expects: `streamText` is
      // invoked above with no `tools` option, and ai-sdk cannot produce
      // `tool-call`/`tool-input-*`/`tool-result`/`tool-error`/
      // `tool-output-denied` parts for a call that supplies no tools — those
      // part types are unreachable from this call site by construction, not
      // merely unforwarded by choice.
      for await (const part of result.fullStream) {
        if (opts.signal?.aborted) break;
        if (part.type === 'text-delta') {
          yield { type: 'text-delta', content: part.text };
          continue;
        }
        if (part.type === 'error') {
          const status = providerHttpErrorStatus(part.error);
          yield {
            type: 'error',
            error: String(part.error),
            ...(status === undefined ? {} : { errorStatus: status }),
          };
          return;
        }
      }
      // archive#1182: surfaced unconditionally here — see
      // `LLMStreamChunk.reportedModel`'s docblock. Whether this value is
      // trustworthy as a genuine runtime observation (vs. the provider's
      // ai-sdk implementation just echoing the request) is a per-provider
      // fact the ADAPTER must have independently verified before treating
      // it as a `reportedModel`; this shared base class makes no such claim.
      const response = await Promise.resolve(result.response).catch(
        () => undefined,
      );
      const responseModelId =
        typeof response?.modelId === 'string' && response.modelId.trim()
          ? response.modelId.trim()
          : undefined;
      // archive#3545: if ai-sdk's own `finishReason` promise rejects (e.g.
      // an abort tore down the stream before it settled), treat that
      // identically to a stream that never reported one — `undefined`, not a
      // thrown error and not a guessed vocabulary member. This mirrors
      // `result.response`'s handling immediately above. A caller processing
      // an aborted stream never reaches the point of trusting this value
      // either way: `BedrockAdapter.sendTurn`'s per-chunk
      // `controller.signal.aborted` re-check (bedrock-adapter.ts, just
      // before each chunk is handled) throws before an aborted turn's finish
      // chunk — whatever `finishReason` it carries — can reach
      // `publishCompletion`; this producer-level fallback is a second,
      // independent guard against the promise itself hanging or rejecting,
      // not a replacement for that check.
      const rawFinishReason = await Promise.resolve(result.finishReason)
        .then((value) => (typeof value === 'string' ? value : undefined))
        .catch(() => undefined);
      const finishReason = mapAiSdkFinishReason(rawFinishReason);
      // archive#4197: ai-sdk resolves the call's token usage on
      // `result.usage` (the final step's `LanguageModelUsage`) — awaited
      // with the same reject-to-undefined handling as `response` and
      // `finishReason` above. `result.usage` rather than
      // `result.totalUsage` on purpose: `totalUsage` is rebuilt through
      // `addLanguageModelUsage`, which drops the provider-wire `raw`
      // object the adapters need for presence-gating cache claims (see
      // `LLMStreamChunk.usage`'s docblock), while the step usage is
      // `asLanguageModelUsage(chunk.usage)` verbatim, `raw` included.
      // Every `createStream` call here is single-step (no `tools` option),
      // so the two are numerically identical.
      const usage = normalizeAiSdkUsage(
        await Promise.resolve(result.usage).catch(() => undefined),
      );
      yield {
        type: 'finish',
        ...(finishReason ? { finishReason } : {}),
        ...(responseModelId ? { reportedModel: responseModelId } : {}),
        ...(usage ? { usage } : {}),
      };
    } catch (e) {
      const status = providerHttpErrorStatus(e);
      yield {
        type: 'error',
        error: String(e),
        ...(status === undefined ? {} : { errorStatus: status }),
      };
    }
  }

  async healthCheck(options?: { signal?: AbortSignal }): Promise<boolean> {
    try {
      return (await this.listModels(options)).length >= 1;
    } catch (e) {
      throwIfAborted(options?.signal);
      console.debug(`Failed to check ${this.id} provider health:`, e);
      return false;
    }
  }
}
