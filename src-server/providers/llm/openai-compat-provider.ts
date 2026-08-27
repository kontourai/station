/**
 * OpenAI-compatible LLM provider — an ai-sdk-backed connection.
 * Shared chat/stream logic lives in AiSdkLLMProvider; only the model factory and
 * model listing (`GET {baseUrl}/models`) are provider-specific.
 */

import {
  type OpenAICompatCatalogSemantics,
  openAICompatCatalogSemantics,
} from '@kontourai/station-contracts/openai-compat-catalog-semantics';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import type { LanguageModel } from 'ai';
import { buildAiSdkLanguageModel } from '../../runtime/frameworks/framework-model-factory.js';
import {
  catalogLimit,
  ModelCatalogShapeError,
  readBoundedJson,
} from '../registries/catalog-http.js';
import { AiSdkLLMProvider } from './ai-sdk-llm-provider.js';
import type {
  IEmbeddingProvider,
  LLMModel,
  ModelCatalogRequest,
} from './model-provider-types.js';

export class OpenAICompatLLMProvider extends AiSdkLLMProvider {
  readonly id = 'openai-compat';
  readonly displayName = 'OpenAI-Compatible';
  /*
   * station#3653: "OpenAI-compatible" is a family of servers, not one
   * product. A great many of them (llama.cpp, vLLM front-ends, LM Studio,
   * small self-hosted routers) answer `GET /models` with `{"data":[]}` while
   * serving chat perfectly well on a model id the operator names, and this
   * adapter's own `healthCheck` note below already treats an empty list as
   * "no catalogue" rather than "no models" for them.
   *
   * Delta review HIGH-1: declaring that on the CLASS was too wide. OpenAI,
   * OpenRouter, Groq, Fireworks, xAI, Mistral and the rest of the product's
   * cloud presets all reach this same class, and their catalogues ARE
   * authoritative — an account whose last entitlement is revoked converges to
   * `[]`, and the class-wide flag would have kept launching the stale
   * configured selector. So the meaning is per INSTANCE, derived from the
   * endpoint this connection actually points at
   * (`openAICompatCatalogSemantics`), and the resolver still reads it as an
   * adapter-instance capability rather than looking up a name.
   */
  readonly emptyCatalogMeaning: OpenAICompatCatalogSemantics;

  constructor({
    baseUrl,
    apiKey,
    modelRequestOptions,
  }: {
    baseUrl: string;
    apiKey?: string;
    modelRequestOptions?: Record<string, unknown>;
  }) {
    super({ apiKey, baseUrl, modelRequestOptions });
    this.emptyCatalogMeaning = openAICompatCatalogSemantics(baseUrl);
  }

  protected languageModel(modelId: string): LanguageModel {
    return buildAiSdkLanguageModel({
      type: 'openai-compat',
      modelId,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      ...(this.modelRequestOptions
        ? { requestBodyDefaults: this.modelRequestOptions }
        : {}),
    });
  }

  private listHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listModels(options?: ModelCatalogRequest): Promise<LLMModel[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.listHeaders(),
      signal: options?.signal,
    });
    const data = await readBoundedJson(res, options);
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { data?: unknown }).data)
    ) {
      throw new ModelCatalogShapeError(
        'OpenAI-compatible endpoint returned an invalid catalog.',
      );
    }
    // station#1430: no `supportsTools` here — the OpenAI `GET /v1/models`
    // response shape (and every OpenAI-compatible server this adapter
    // targets, since "OpenAI-compatible" means it mirrors this exact
    // envelope) is `{ id, object, created, owned_by }`. There is no
    // capability field to read; a per-model-family guess from the id string
    // would be exactly the hardcoded static knowledge the honesty bar rules
    // out, not a provider-reported fact. Leave it `undefined` (unknown)
    // rather than guess.
    return (data as { data: Array<{ id?: unknown }> }).data
      .slice(0, catalogLimit(options))
      .flatMap((model) =>
        typeof model?.id === 'string' ? [{ id: model.id, name: model.id }] : [],
      );
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    return [
      {
        id: 'openai-compat-base-url',
        name: 'OpenAI-Compatible Endpoint',
        description: 'Base URL for an OpenAI-compatible API',
        status: this.baseUrl ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Configure the base URL (and optional API key) for the endpoint',
          ],
          links: [],
        },
      },
    ];
  }

  // No `healthCheck` override on purpose (delta2 review H1). This class used
  // to answer `res.ok` on `GET {baseUrl}/models` — a status line, not a
  // catalogue — so any endpoint that returned 200 with an empty list, an HTML
  // error page, or `{}` was "healthy", and `testConnection` recorded a passed
  // check straight off that boolean without ever asking the classified
  // catalogue/chat probe. That manufactured "Ready" from a response that
  // established no model and no chat endpoint. `AiSdkLLMProvider.healthCheck`
  // (the inherited one) derives the same boolean from this class's own
  // `listModels`: a body that parses as an OpenAI catalogue envelope AND
  // carries at least one model. Everything else — empty list, non-catalogue
  // body, 404 on the catalogue route, transport failure — now answers false,
  // which is what routes the explicit test into `probeModelConnection`'s
  // classified catalogue outcome and, when the catalogue simply is not there,
  // the one-token chat probe that is the only evidence able to earn Ready.
}

export class OpenAICompatEmbeddingProvider implements IEmbeddingProvider {
  readonly id = 'openai-compat-embedding';
  readonly displayName = 'OpenAI-Compatible Embeddings';
  private baseUrl: string;
  private model: string;
  private headers: Record<string, string>;

  constructor({
    baseUrl,
    apiKey,
    model = 'text-embedding-3-small',
  }: { baseUrl: string; apiKey?: string; model?: string }) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }

  dimensions(): number {
    return 1536;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers,
      });
      return res.ok;
    } catch (e) {
      console.debug(
        'Failed to check OpenAI-compat embedding provider health:',
        e,
      );
      return false;
    }
  }
}
