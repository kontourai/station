/**
 * Anthropic (Claude) LLM provider — an ai-sdk-backed connection.
 * Shared chat/stream/health logic lives in AiSdkLLMProvider; only the model
 * factory, model listing, and prerequisite are Anthropic-specific.
 */

import type { Prerequisite } from '@kontourai/station-contracts/tool';
import type { LanguageModel } from 'ai';
import { buildAiSdkLanguageModel } from '../../runtime/frameworks/framework-model-factory.js';
import { throwIfAborted } from '../../utils/bounded-async.js';
import {
  catalogLimit,
  createCatalogByteBudget,
  DEFAULT_MODEL_CATALOG_MAX_PAGES,
  ModelCatalogShapeError,
  readBoundedJson,
} from '../registries/catalog-http.js';
import { AiSdkLLMProvider } from './ai-sdk-llm-provider.js';
import { classifyCatalogFailure } from './model-catalog.js';
import type {
  LLMModel,
  LLMModelCatalog,
  ModelCatalogRequest,
} from './model-provider-types.js';

export class AnthropicLLMProvider extends AiSdkLLMProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  protected languageModel(modelId: string): LanguageModel {
    return buildAiSdkLanguageModel({
      type: 'anthropic',
      modelId,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      ...(this.modelRequestOptions
        ? { requestBodyDefaults: this.modelRequestOptions }
        : {}),
    });
  }

  async listModelCatalog(
    options?: ModelCatalogRequest,
  ): Promise<LLMModelCatalog> {
    if (!this.apiKey) return { source: 'unavailable', models: [] };
    try {
      const base = this.baseUrl ?? 'https://api.anthropic.com';
      const limit = catalogLimit(options);
      const byteBudget = createCatalogByteBudget(options);
      const seenCursors = new Set<string>();
      const models: LLMModel[] = [];
      let afterId: string | undefined;

      for (let page = 0; page < DEFAULT_MODEL_CATALOG_MAX_PAGES; page += 1) {
        const url = new URL(`${base.replace(/\/$/, '')}/v1/models`);
        url.searchParams.set('limit', String(limit - models.length));
        if (afterId) url.searchParams.set('after_id', afterId);
        const res = await fetch(url.toString(), {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: options?.signal,
        });
        const data = await readBoundedJson(res, options, byteBudget);
        if (
          !data ||
          typeof data !== 'object' ||
          !Array.isArray((data as { data?: unknown }).data)
        ) {
          throw new ModelCatalogShapeError(
            'Anthropic returned an invalid model catalog.',
          );
        }
        const catalog = data as {
          data: Array<{ id?: unknown; display_name?: unknown }>;
          has_more?: unknown;
          last_id?: unknown;
        };
        // station#1430: no `supportsTools` here — Anthropic's `GET
        // /v1/models` response objects are `{ id, type, display_name,
        // created_at }` (verified against the live API shape). It reports no
        // capability field, so there is nothing truthful to read; every
        // Claude model does in fact support tool use, but asserting that
        // from a hardcoded model-family table is exactly the static
        // knowledge the honesty bar excludes, not a provider-reported fact.
        // Leave it `undefined` (unknown) unless Anthropic's catalog ever
        // reports this itself.
        const pageModels = catalog.data.flatMap((model) =>
          typeof model?.id === 'string'
            ? [
                {
                  id: model.id,
                  name:
                    typeof model.display_name === 'string'
                      ? model.display_name
                      : model.id,
                },
              ]
            : [],
        );
        const remaining = limit - models.length;
        models.push(...pageModels.slice(0, remaining));
        if (models.length >= limit) {
          const truncated =
            catalog.has_more === true || pageModels.length > remaining;
          return {
            source: 'live',
            models,
            ...(truncated ? { truncated: true } : {}),
          };
        }
        if (catalog.has_more !== true) {
          return { source: 'live', models };
        }
        if (
          typeof catalog.last_id !== 'string' ||
          catalog.last_id.length === 0 ||
          seenCursors.has(catalog.last_id)
        ) {
          throw new ModelCatalogShapeError(
            'Anthropic returned a non-advancing model cursor.',
          );
        }
        seenCursors.add(catalog.last_id);
        afterId = catalog.last_id;
      }
      throw new ModelCatalogShapeError(
        'Anthropic model catalog exceeded the page limit.',
      );
    } catch (error) {
      throwIfAborted(options?.signal);
      // The reason is CARRIED, not logged. A transport message can echo a
      // credential-bearing header, so it stays out of the log and reaches
      // only a consumer that redacts against the connection's own config
      // (`ConnectionService.describeModelCheckFailure`). Discarding it
      // entirely is what left "Connection failed" with no reason and no HTTP
      // code anywhere in the product (station RT-06).
      console.debug('Failed to list Anthropic models.');
      return {
        source: 'unavailable',
        models: [],
        ...(error instanceof Error && error.message
          ? {
              reason: error.message,
              reasonKind: classifyCatalogFailure(error),
            }
          : {}),
      };
    }
  }

  async listModels(options?: ModelCatalogRequest): Promise<LLMModel[]> {
    return (await this.listModelCatalog(options)).models;
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    return [
      {
        id: 'anthropic-api-key',
        name: 'Anthropic API Key',
        description: 'API key with access to Claude models',
        status: this.apiKey ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: ['Create an Anthropic API key and add it to this connection'],
          links: ['https://console.anthropic.com/settings/keys'],
        },
      },
    ];
  }
}
