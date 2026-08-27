/**
 * Ollama LLM provider — an ai-sdk-backed connection.
 * Chat/streaming go through the shared AiSdkLLMProvider (Ollama exposes an
 * OpenAI-compatible endpoint at `<baseUrl>/v1`, so the shared `buildAiSdkLanguageModel`
 * builds an OpenAI-compatible model for it). Only the model listing
 * (`GET <baseUrl>/api/tags`) and health check are Ollama-specific.
 */

import type { ModelInventoryLocality } from '@kontourai/station-contracts/model-inventory';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import type { LanguageModel } from 'ai';
import { DEFAULT_OLLAMA_BASE_URL } from '../../constants.js';
import { buildAiSdkLanguageModel } from '../../runtime/frameworks/framework-model-factory.js';
import { throwIfAborted } from '../../utils/bounded-async.js';
import {
  catalogLimit,
  ModelCatalogShapeError,
  readBoundedJson,
} from '../registries/catalog-http.js';
import { AiSdkLLMProvider } from './ai-sdk-llm-provider.js';
import { MODEL_CATALOG_TIMEOUT_MS } from './model-catalog.js';
import type {
  IEmbeddingProvider,
  LLMExecutionIdentity,
  LLMModel,
  LLMModelCatalog,
  ModelCatalogRequest,
} from './model-provider-types.js';

/**
 * station#1430: Ollama's bulk `/api/tags` listing (used for the base catalog
 * below) reports no capability info — just name/size/digest/details. Tool
 * support is only exposed per-model via `POST /api/show { model }`, whose
 * response carries a `capabilities` array (e.g. `["completion", "tools",
 * "vision"]`) added by ollama/ollama#10066 specifically so clients can see
 * what a model supports. `'tools'` in that array is a genuine provider-
 * reported fact, not a guess — this is the one real signal among this
 * repo's providers, so it is the one enrichment worth the extra requests.
 */
const OLLAMA_TOOLS_CAPABILITY = 'tools';

/**
 * Reserved time for the `/api/tags` request itself, before enrichment even
 * starts — `MODEL_CATALOG_TIMEOUT_MS` is a budget for the WHOLE
 * `listModelCatalog` call, not just the enrichment phase.
 */
const OLLAMA_TAGS_ALLOWANCE_MS = 400;

/**
 * Soft overall deadline for capability enrichment (station#1430 review,
 * H-1). DERIVED from `MODEL_CATALOG_TIMEOUT_MS`, not an independent number:
 * the outer `withCatalogTimeout` races the WHOLE `listModelCatalog` call
 * against `MODEL_CATALOG_TIMEOUT_MS`, and losing that race doesn't degrade
 * gracefully — it resolves with `null`, which `safeListModelCatalog` turns
 * into `fallbackCatalog`/`unavailableCatalog`, discarding the ENTIRE base
 * model list, not just the enrichment. This budget must therefore leave
 * headroom for `/api/tags` to actually complete first.
 */
const OLLAMA_CAPABILITY_BUDGET_MS =
  MODEL_CATALOG_TIMEOUT_MS - OLLAMA_TAGS_ALLOWANCE_MS;

/**
 * Per-model `/api/show` ceiling: generous for a local daemon, bounded so one
 * hung model can't stall the others. MUST NOT exceed the enrichment budget
 * (asserted below) — the invariant `enrichWithToolSupport` depends on: a
 * lookup is only ever STARTED when `now + this timeout <= deadline`, so the
 * LAST lookup to start still finishes no later than `deadline`. Without that
 * relationship, a call could start just before the deadline check and then
 * run for a further full timeout past it — exactly the H-1 defect (worst
 * case `BUDGET + TIMEOUT` instead of `BUDGET`), which had no `T_tags >= 0`
 * satisfying `T_tags + BUDGET + TIMEOUT <= MODEL_CATALOG_TIMEOUT_MS`.
 */
const OLLAMA_CAPABILITY_TIMEOUT_MS = 400;

/** Concurrent `/api/show` lookups in flight at once. */
const OLLAMA_CAPABILITY_CONCURRENCY = 6;

// INVARIANT (station#1430 review, H-1): a lookup must be able to both START
// and FINISH inside the enrichment budget, or enrichment would either never
// attempt a single lookup (if this were silently violated the other way) or
// — the actual historical bug — overrun the budget by up to a full timeout
// per call that started right at its edge. Thrown at module load (these are
// fixed constants, never runtime-configurable) so the two numbers can never
// drift apart unnoticed the way the original 900ms/800ms pair did.
if (OLLAMA_CAPABILITY_TIMEOUT_MS > OLLAMA_CAPABILITY_BUDGET_MS) {
  throw new Error(
    'OLLAMA_CAPABILITY_TIMEOUT_MS must not exceed OLLAMA_CAPABILITY_BUDGET_MS — ' +
      'otherwise no /api/show lookup could ever satisfy the "starts only if ' +
      'it can finish in time" rule enrichWithToolSupport depends on.',
  );
}

export class OllamaLLMProvider extends AiSdkLLMProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';
  readonly execution: LLMExecutionIdentity;
  private readonly nativeBaseUrl: string;

  constructor({
    baseUrl = DEFAULT_OLLAMA_BASE_URL,
    locality = 'unknown',
  }: { baseUrl?: string; locality?: ModelInventoryLocality } = {}) {
    super({ baseUrl });
    this.nativeBaseUrl = baseUrl;
    this.execution = {
      runtime: { id: 'ollama', version: null },
      adapter: { id: 'station-ollama', version: null },
      locality,
    };
  }

  protected languageModel(modelId: string): LanguageModel {
    return buildAiSdkLanguageModel({
      type: 'ollama',
      modelId,
      baseUrl: this.nativeBaseUrl,
    });
  }

  async listModelCatalog(
    options?: ModelCatalogRequest,
  ): Promise<LLMModelCatalog> {
    // station#1430 review, H-1 residual: captured BEFORE the `/api/tags`
    // fetch, not before enrichment. The enrichment deadline below is
    // anchored to this timestamp — not to whenever enrichment happens to
    // start — so the "never overruns the outer catalog budget" property
    // holds for ANY `/api/tags` latency, not just latency under
    // `OLLAMA_TAGS_ALLOWANCE_MS`. A slow (or loaded-daemon-slow) `/api/tags`
    // now simply leaves LESS room for enrichment — down to none, at which
    // point enrichment is skipped entirely rather than compounding the
    // delay — instead of enrichment silently assuming tags was fast and
    // adding its own budget on top.
    const catalogStartedAt = Date.now();
    const response = await fetch(`${this.nativeBaseUrl}/api/tags`, {
      signal: options?.signal,
    });
    const data = await readBoundedJson(response, options);
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { models?: unknown }).models)
    ) {
      throw new ModelCatalogShapeError(
        'Ollama returned an invalid model catalog.',
      );
    }
    const models = (
      data as { models: Array<{ name?: unknown }> }
    ).models.flatMap((model) =>
      typeof model?.name === 'string'
        ? [{ id: model.name, name: model.name }]
        : [],
    );
    const maxEntries = catalogLimit(options);
    const bounded = models.slice(0, maxEntries);
    // station#1430 review, H-2: enrichment is for the capability-consuming
    // (inventory) path only — a caller that just needs to validate/resolve a
    // model id (`OllamaAdapter.resolveModelId`, on every session start and
    // model switch) has no use for `supportsTools` and must not pay for
    // `/api/show` calls it will never read. Opt-out, not opt-in: every
    // existing caller of this method (including `safeListModelCatalog`, the
    // genuine inventory path) keeps today's enriched behavior unless it says
    // otherwise.
    const enriched = options?.skipCapabilityEnrichment
      ? bounded
      : await this.enrichWithToolSupport(
          bounded,
          options?.signal,
          catalogStartedAt + OLLAMA_CAPABILITY_BUDGET_MS,
        );
    return {
      source: 'live',
      models: enriched,
      ...(models.length > maxEntries ? { truncated: true } : {}),
    };
  }

  /**
   * Best-effort `supportsTools` enrichment via `POST /api/show` (station#1430).
   * Never blocks or fails the base catalog: a model whose lookup errors,
   * times out, or is skipped because the overall budget elapsed simply keeps
   * `supportsTools` unset (honestly unknown), same as before this method
   * existed.
   *
   * The budget-safety property (station#1430 review, H-1 + H-1 residual):
   * `deadline` is an ABSOLUTE timestamp — `catalogStartedAt +
   * OLLAMA_CAPABILITY_BUDGET_MS`, computed by the caller BEFORE the
   * `/api/tags` fetch — not `Date.now() + BUDGET` computed here at
   * enrichment start. Anchoring to catalog start (not enrichment start)
   * makes the whole-call bound hold for any `/api/tags` latency: a slow tags
   * response eats directly into the SAME budget enrichment draws from,
   * rather than enrichment getting a fresh, tags-latency-blind budget on
   * top of however long tags already took.
   *
   * On top of that, a lookup is only ever STARTED when there is still enough
   * of the budget left for its own timeout to complete (`now +
   * OLLAMA_CAPABILITY_TIMEOUT_MS <= deadline`) — not merely "the deadline
   * hasn't passed yet." That distinction is the original H-1 fix: checking
   * only `Date.now() >= deadline` before starting allows a lookup to begin
   * one tick before the deadline and then run for a FULL further timeout,
   * so the worst case was `BUDGET + TIMEOUT`, not `BUDGET`. With the "can it
   * still finish in time" check, the LAST lookup to start does so at
   * `now <= deadline - TIMEOUT` and finishes by `now + TIMEOUT <= deadline`
   * — so the whole enrichment phase is bounded by reaching `deadline`,
   * period, regardless of how many models are queued, how slow `/api/tags`
   * was, or how slow/hung any individual `/api/show` call is.
   */
  private async enrichWithToolSupport(
    models: readonly LLMModel[],
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<LLMModel[]> {
    if (models.length === 0) return [];
    const results: LLMModel[] = [...models];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        // H-1: refuse to START a lookup unless it can also FINISH inside the
        // budget — see the invariant assertion at module load and the
        // docblock above.
        if (Date.now() + OLLAMA_CAPABILITY_TIMEOUT_MS > deadline) return;
        const index = nextIndex++;
        if (index >= models.length) return;
        const model = models[index]!;
        const capabilities = await this.fetchModelCapabilities(
          model.id,
          signal,
        );
        if (capabilities) {
          results[index] = {
            ...model,
            supportsTools: capabilities.includes(OLLAMA_TOOLS_CAPABILITY),
          };
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(OLLAMA_CAPABILITY_CONCURRENCY, models.length) },
        () => worker(),
      ),
    );
    return results;
  }

  /**
   * One model's `capabilities` array from `POST /api/show`, or `null` when
   * the lookup fails, times out, or the response is not the expected shape —
   * `null` is the caller's "leave unknown" signal, never coerced to "no
   * tools."
   */
  private async fetchModelCapabilities(
    modelName: string,
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Ollama capability lookup timed out.')),
      OLLAMA_CAPABILITY_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${this.nativeBaseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const capabilities = (data as { capabilities?: unknown })?.capabilities;
      return Array.isArray(capabilities) &&
        capabilities.every((entry) => typeof entry === 'string')
        ? (capabilities as string[])
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async listModels(options?: ModelCatalogRequest): Promise<LLMModel[]> {
    return (await this.listModelCatalog(options)).models;
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    const available = await this.healthCheck(options);
    return [
      {
        id: 'ollama-server',
        name: 'Ollama server',
        description: 'Ollama must be running locally (ollama serve).',
        status: available ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Install Ollama from https://ollama.com',
            'Run `ollama serve` to start the server',
            'Pull a model: `ollama pull llama3.2`',
          ],
          links: ['https://ollama.com'],
        },
      },
    ];
  }

  async healthCheck(options?: { signal?: AbortSignal }): Promise<boolean> {
    try {
      const res = await fetch(`${this.nativeBaseUrl}/api/tags`, {
        signal: options?.signal,
      });
      return res.ok;
    } catch (e) {
      throwIfAborted(options?.signal);
      console.debug('Failed to check Ollama LLM provider health:', e);
      return false;
    }
  }
}

export class OllamaEmbeddingProvider implements IEmbeddingProvider {
  readonly id = 'ollama-embedding';
  readonly displayName = 'Ollama Embeddings';
  private baseUrl: string;
  private model: string;

  constructor({
    baseUrl = DEFAULT_OLLAMA_BASE_URL,
    model = 'nomic-embed-text',
  }: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  dimensions(): number {
    return 768;
  }

  async healthCheck(options?: { signal?: AbortSignal }): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: options?.signal,
      });
      return res.ok;
    } catch (e) {
      throwIfAborted(options?.signal);
      console.debug('Failed to check Ollama embedding provider health:', e);
      return false;
    }
  }
}
