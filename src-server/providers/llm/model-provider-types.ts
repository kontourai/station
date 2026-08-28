import type {
  ModelInventoryExecutionIdentity,
  ModelInventoryFreshness,
} from '@kontourai/station-contracts/model-inventory';
import type {
  ModelOptionCapabilities,
  Prerequisite,
  ToolDef,
} from '@kontourai/station-contracts/tool';

export type LLMExecutionIdentity = ModelInventoryExecutionIdentity;

export interface LLMModel {
  id: string;
  name: string;
  contextWindow?: number;
  /**
   * archive#1430: whether this specific model genuinely reports tool-call
   * (function-calling) support through the provider's own discovery API —
   * never a hardcoded per-model-family table. Each provider adapter's
   * `listModelCatalog`/`listModels` sets this only when its own catalog
   * response carries a real capability signal (see each adapter's own
   * comment for what it checked and why); every other adapter leaves it
   * `undefined` on purpose. `undefined` here means "unknown," not "false" —
   * `launchable-model-inventory.ts`'s `unanimous()` folds it to a `null`
   * `toolSurface` rather than a false negative.
   */
  supportsTools?: boolean;
  supportsVision?: boolean;
  capabilities?: ModelOptionCapabilities;
}

export interface ModelCatalogRequest {
  signal?: AbortSignal;
  maxEntries?: number;
  maxResponseBytes?: number;
  /**
   * archive#1430 (review, H-2): opts a caller OUT of any per-model
   * capability enrichment (currently: `OllamaLLMProvider`'s `/api/show`
   * `supportsTools` lookups) a provider adapter's `listModelCatalog` may do
   * beyond its base bulk listing call. Default is enrichment ON — every
   * existing caller (the inventory-building path via `safeListModelCatalog`,
   * routes, `discoverModelConnections`) keeps today's enriched behavior
   * unchanged. Set this when the caller only needs model ids/names to
   * validate or resolve a selector (e.g. `OllamaAdapter.resolveModelId`, on
   * every session start and model switch) and will never read the
   * capability fields — that hot, unbounded-frequency path must not pay for
   * (or be stalled by) lookups whose result it discards. A provider with no
   * enrichment step of its own is free to ignore this field entirely.
   */
  skipCapabilityEnrichment?: boolean;
}

export interface LLMModelCatalog {
  source: Extract<ModelInventoryFreshness, 'live' | 'built-in'> | 'unavailable';
  models: LLMModel[];
  /** True when a bounded entry limit omitted additional provider results. */
  truncated?: boolean;
  /**
   * Why an `unavailable` catalog is unavailable, in the provider's own words
   * (`Model catalog request failed with HTTP 401.`, a network error, a
   * malformed response). Carried, never logged: a transport message can echo
   * a credential-bearing header, so a consumer that shows this must redact
   * against the connection's own config first. Absent means the provider does
   * not report one — which is a different fact from "no reason".
   */
  reason?: string;
  /**
   * How the provider answered, when it answered at all. `refused` is a
   * credential/authorization rejection; `no-catalog` means the endpoint is
   * reachable but exposes no usable catalog (404/405/501, or a body that is
   * not a catalog) — a distinction that decides whether the connection is
   * broken or merely catalog-less (station RT-06 delta review H1).
   * `unreachable` is a transport failure. Absent when the provider did not
   * answer at all (a timeout or an abort).
   */
  reasonKind?: 'refused' | 'no-catalog' | 'unreachable';
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
}

export interface LLMStreamOpts {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMStreamChunk {
  type: 'text-delta' | 'tool-call' | 'tool-result' | 'finish' | 'error';
  content?: string;
  toolCall?: { id: string; name: string; arguments: unknown };
  toolResult?: { id: string; result: unknown };
  finishReason?: string;
  /**
   * archive#4197: token usage as ai-sdk reported it for this call, populated
   * on the `finish` chunk by `AiSdkLLMProvider.createStream` from
   * `result.usage` (`LanguageModelUsage` in the installed `ai` package —
   * `result.usage` and NOT `result.totalUsage`, because `totalUsage` is
   * rebuilt through `addLanguageModelUsage`, which drops the `raw` field
   * this shape deliberately carries; with no `tools` option every
   * `createStream` call is single-step, so the two are numerically equal).
   *
   * Every field is optional because absence is a real state (archive#3201:
   * absent is not zero). A field the SDK resolved to `undefined`, `NaN`, or
   * a negative number is DROPPED, never coerced to `0`.
   *
   * **The normalized cache fields here can be SDK-invented zeros.** Both
   * installed provider families this base class serves coerce an
   * unreported wire field to `0` during normalization
   * (`@ai-sdk/amazon-bedrock`'s `convertBedrockUsage`:
   * `usage.cacheReadInputTokens ?? 0`; `@ai-sdk/openai-compatible`'s
   * `convertOpenAICompatibleChatUsage`:
   * `prompt_tokens_details?.cached_tokens ?? 0`), so a `0` in
   * `cacheReadTokens`/`cacheWriteTokens` does not prove the engine reported
   * one. `raw` is the presence channel: it is the provider-wire usage
   * object verbatim (`LanguageModelUsage.raw`), and an ADAPTER that knows
   * its own provider's wire shape must gate any cache CLAIM it publishes on
   * the field actually appearing there — see
   * `adapters/ai-sdk-reported-usage.ts`.
   */
  usage?: {
    /**
     * ai-sdk's normalized input total. NOTE: for Bedrock this is
     * cache-INCLUSIVE by SDK construction (`convertBedrockUsage` computes
     * `total: inputTokens + cacheRead + cacheWrite`), and for
     * OpenAI-compatible endpoints it is the wire `prompt_tokens`, which the
     * same SDK asserts includes `cached_tokens` (it derives `noCache` by
     * subtraction). Consumers that publish inclusivity-labeled figures must
     * derive from `raw` instead.
     */
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** `LanguageModelUsage.raw` — the provider-wire usage object, verbatim. */
    raw?: unknown;
  };
  error?: string;
  /**
   * The HTTP status the provider attached to a failed turn, when it attached
   * one (ai-sdk's `APICallError.statusCode`, and anything else carrying a
   * numeric `statusCode`/`status`).
   *
   * Station RT-06 delta2 review M2: an explicit Test Connection's chat probe
   * has to say which failure it saw — 401/403 is the provider refusing these
   * credentials, 404 is this model not existing on this endpoint — and both
   * used to collapse into one "refused" claim. Absent means the failure
   * carried no status, which is a different fact from "status 0": a consumer
   * must not invent a classification for it.
   */
  errorStatus?: number;
  /**
   * archive#1182: ai-sdk's `StreamTextResult.response.modelId` — "the ID of
   * the response model that was used to generate the response," per the
   * `ai` package's own doc comment. Populated on `finish` ONLY by providers
   * whose adapter has verified this genuinely reflects the API response
   * body (not just the request echoed back) — see each `ILLMProvider`
   * implementation's own doc note. `AiSdkLLMProvider.createStream` always
   * sets this from `result.response` when ai-sdk supplies a string; a
   * consuming adapter must independently confirm the honesty of its own
   * provider's value before surfacing it as a `reportedModel` — do not
   * assume symmetry across providers.
   */
  reportedModel?: string;
}

export interface ILLMProvider {
  readonly id: string;
  readonly displayName: string;
  /** Whether configured selectors may substitute for unavailable discovery. */
  readonly configuredModelFallback?: 'allow' | 'deny';
  /**
   * What an ANSWERED but empty catalogue means for this provider (archive#3653
   * review, HIGH). Absent — the default — is `'no-models'`: the endpoint
   * enumerated, and enumerated nothing, which is an authoritative statement
   * that it serves no models. Anthropic's adapter pins exactly that
   * distinction (`{source:'live', models: []}` vs `source:'unavailable'`), and
   * `recordModelCatalogDiscovery` reads it the same way; an account whose last
   * model entitlement is removed converges to `[]` and must not keep launching
   * a stale configured selector.
   *
   * `'no-catalog'` is a declaration that this instance's empty list carries no
   * such statement — it is indistinguishable from an endpoint that simply does
   * not enumerate. Only then may a configured selector stand in for the
   * missing enumeration.
   *
   * Delta review HIGH-1: this is a capability of the adapter INSTANCE, not of
   * its class. `OpenAICompatLLMProvider` serves both api.openai.com (which
   * enumerates authoritatively) and a localhost llama.cpp (which may not), so
   * it derives this per connection from the endpoint it was built for. Every
   * reader still asks the instance rather than looking up a provider name.
   */
  readonly emptyCatalogMeaning?: 'no-models' | 'no-catalog';
  /** Provider guarantees its catalog promise settles after abort. */
  readonly abortSettlement?: 'await';
  /** Evidence-scoping identity declared by the adapter; absence is unknown. */
  readonly execution?: LLMExecutionIdentity;
  /** Optional provenance-preserving catalog surface for providers with fallbacks. */
  listModelCatalog?(options?: ModelCatalogRequest): Promise<LLMModelCatalog>;
  listModels(options?: ModelCatalogRequest): Promise<LLMModel[]>;
  createStream(opts: LLMStreamOpts): AsyncIterable<LLMStreamChunk>;
  supportsStreaming?(): boolean;
  supportsToolCalling?(): boolean;
  healthCheck?(options?: { signal?: AbortSignal }): Promise<boolean>;
  getPrerequisites?(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]>;
}

export interface IEmbeddingProvider {
  readonly id: string;
  readonly displayName: string;
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  healthCheck?(options?: { signal?: AbortSignal }): Promise<boolean>;
  getPrerequisites?(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]>;
}

export interface VectorDocument {
  id: string;
  vector: number[];
  text: string;
  metadata: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface IVectorDbProvider {
  readonly id: string;
  readonly displayName: string;
  createNamespace(namespace: string): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  namespaceExists(namespace: string): Promise<boolean>;
  addDocuments(namespace: string, docs: VectorDocument[]): Promise<void>;
  deleteDocuments(namespace: string, docIds: string[]): Promise<void>;
  search(
    namespace: string,
    query: number[],
    topK: number,
    threshold?: number,
  ): Promise<VectorSearchResult[]>;
  getByMetadata(
    namespace: string,
    key: string,
    value: string,
  ): Promise<VectorSearchResult[]>;
  count(namespace: string): Promise<number>;
}
