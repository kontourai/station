/**
 * Google (Gemini) LLM provider — an ai-sdk-backed connection.
 * Shared chat/stream/health logic lives in AiSdkLLMProvider; only the model
 * factory, model listing, and prerequisite are Google-specific.
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

export class GoogleLLMProvider extends AiSdkLLMProvider {
  readonly id = 'google';
  readonly displayName = 'Google';

  protected languageModel(modelId: string): LanguageModel {
    return buildAiSdkLanguageModel({
      type: 'google',
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
      const base = this.baseUrl ?? 'https://generativelanguage.googleapis.com';
      const limit = catalogLimit(options);
      const byteBudget = createCatalogByteBudget(options);
      const seenPageTokens = new Set<string>();
      const result: LLMModel[] = [];
      let pageToken: string | undefined;

      for (let page = 0; page < DEFAULT_MODEL_CATALOG_MAX_PAGES; page += 1) {
        const url = new URL(`${base.replace(/\/$/, '')}/v1beta/models`);
        url.searchParams.set('pageSize', String(limit - result.length));
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const res = await fetch(url.toString(), {
          signal: options?.signal,
          headers: { 'x-goog-api-key': this.apiKey },
        });
        const data = await readBoundedJson(res, options, byteBudget);
        if (
          !data ||
          typeof data !== 'object' ||
          !Array.isArray((data as { models?: unknown }).models)
        ) {
          throw new ModelCatalogShapeError(
            'Google returned an invalid model catalog.',
          );
        }
        const catalog = data as {
          models: Array<{
            name?: unknown;
            displayName?: unknown;
            supportedGenerationMethods?: unknown;
          }>;
          nextPageToken?: unknown;
        };
        // station#1430: no `supportsTools` here — Google's `GET
        // /v1beta/models` entries carry `supportedGenerationMethods` (used
        // below to filter to chat-capable models) plus token limits and
        // sampling defaults, but no explicit function-calling/tool-use
        // capability field. `generateContent` support does not by itself
        // mean tool support (not every `generateContent`-capable Gemini
        // model accepts `tools` in its request), so inferring it from that
        // filter would be a guess dressed as a fact. Leave it `undefined`
        // (unknown) unless Google's catalog ever reports this itself.
        const pageModels = catalog.models
          .filter(
            (model) =>
              Array.isArray(model.supportedGenerationMethods) &&
              model.supportedGenerationMethods.includes('generateContent'),
          )
          .flatMap((model) => {
            if (typeof model.name !== 'string') return [];
            const id = model.name.replace(/^models\//, '');
            return [
              {
                id,
                name:
                  typeof model.displayName === 'string'
                    ? model.displayName
                    : id,
              },
            ];
          });
        const remaining = limit - result.length;
        result.push(...pageModels.slice(0, remaining));
        if (result.length >= limit) {
          const truncated =
            catalog.nextPageToken !== undefined ||
            pageModels.length > remaining;
          return {
            source: 'live',
            models: result,
            ...(truncated ? { truncated: true } : {}),
          };
        }
        if (catalog.nextPageToken === undefined) {
          return { source: 'live', models: result };
        }
        if (
          typeof catalog.nextPageToken !== 'string' ||
          catalog.nextPageToken.length === 0 ||
          seenPageTokens.has(catalog.nextPageToken)
        ) {
          throw new ModelCatalogShapeError(
            'Google returned a non-advancing model page token.',
          );
        }
        seenPageTokens.add(catalog.nextPageToken);
        pageToken = catalog.nextPageToken;
      }
      throw new ModelCatalogShapeError(
        'Google model catalog exceeded the page limit.',
      );
    } catch (error) {
      throwIfAborted(options?.signal);
      // The reason is CARRIED, not logged. A transport message can echo a
      // credential-bearing header, so it stays out of the log and reaches
      // only a consumer that redacts against the connection's own config
      // (`ConnectionService.describeModelCheckFailure`). Discarding it
      // entirely is what left "Connection failed" with no reason and no HTTP
      // code anywhere in the product (station RT-06).
      console.debug('Failed to list Google models.');
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
        id: 'google-api-key',
        name: 'Google API Key',
        description: 'Google Generative AI (Gemini) API key',
        status: this.apiKey ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: [
            'Create a Google Generative AI API key and add it to this connection',
          ],
          links: ['https://aistudio.google.com/app/apikey'],
        },
      },
    ];
  }
}
