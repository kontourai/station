/**
 * Bedrock LLM provider — an ai-sdk-backed connection.
 * Shared chat/stream logic lives in AiSdkLLMProvider; only the model factory,
 * model listing, prerequisite, and credential-based health check are
 * Bedrock-specific.
 */

import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import type { LanguageModel } from 'ai';
import { buildAiSdkLanguageModel } from '../../runtime/frameworks/framework-model-factory.js';
import {
  settleConcurrentWork,
  throwIfAborted,
} from '../../utils/bounded-async.js';
import { catalogLimit } from '../registries/catalog-http.js';
import { AiSdkLLMProvider } from './ai-sdk-llm-provider.js';
import { describeBedrockCatalogFailure } from './bedrock-catalog-failure.js';
import type { BedrockAuthMode } from './bedrock-credentials.js';
import { bedrockClientAuth } from './bedrock-credentials.js';
import {
  type InferenceProfile,
  listLaunchableBedrockSelectors,
} from './bedrock-models.js';
import type {
  LLMModel,
  LLMModelCatalog,
  ModelCatalogRequest,
} from './model-provider-types.js';

const BEDROCK_PROFILE_MAX_PAGES = 32;

async function listInferenceProfiles(options: {
  client: {
    send(command: unknown, options?: unknown): Promise<any>;
  };
  Command: new (input: { maxResults: number; nextToken?: string }) => unknown;
  requestOptions?: { abortSignal: AbortSignal };
  maxEntries: number;
}): Promise<InferenceProfile[]> {
  const profiles: InferenceProfile[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount >= BEDROCK_PROFILE_MAX_PAGES) {
      throw new Error('Bedrock inference profiles exceeded the page limit.');
    }
    pageCount += 1;
    const response = await options.client.send(
      new options.Command({
        maxResults: options.maxEntries - profiles.length,
        nextToken,
      }),
      options.requestOptions,
    );
    profiles.push(
      ...(response.inferenceProfileSummaries ?? [])
        .slice(0, options.maxEntries - profiles.length)
        .flatMap((profile: any) =>
          typeof profile?.inferenceProfileId === 'string'
            ? [
                {
                  inferenceProfileId: profile.inferenceProfileId,
                  inferenceProfileArn: profile.inferenceProfileArn ?? '',
                  inferenceProfileName: profile.inferenceProfileName ?? '',
                  type: profile.type ?? '',
                  status: profile.status ?? '',
                  models: Array.isArray(profile.models) ? profile.models : [],
                },
              ]
            : [],
        ),
    );
    const candidate = response.nextToken;
    if (candidate && seenTokens.has(candidate)) {
      throw new Error(
        'Bedrock inference profile pagination token did not advance.',
      );
    }
    if (candidate) seenTokens.add(candidate);
    nextToken = candidate;
  } while (nextToken && profiles.length < options.maxEntries);

  if (nextToken) {
    throw new Error('Bedrock inference profiles exceeded the entry limit.');
  }

  return profiles;
}

export interface BedrockLLMProviderConfig {
  region?: string;
  authMode?: BedrockAuthMode;
  profile?: string;
  apiKey?: string;
}

export class BedrockLLMProvider extends AiSdkLLMProvider {
  readonly id = 'bedrock';
  readonly displayName = 'Amazon Bedrock';
  readonly configuredModelFallback = 'deny' as const;
  private readonly region: string;
  private readonly authMode: BedrockAuthMode;
  private readonly profile?: string;
  private readonly bedrockApiKey?: string;

  constructor({
    region,
    authMode,
    profile,
    apiKey,
  }: BedrockLLMProviderConfig = {}) {
    super({});
    this.region = region || 'us-east-1';
    this.authMode = authMode ?? 'chain';
    this.profile = profile;
    this.bedrockApiKey = apiKey;
  }

  protected languageModel(modelId: string): LanguageModel {
    return buildAiSdkLanguageModel({
      type: 'bedrock',
      modelId,
      region: this.region,
      authMode: this.authMode,
      profile: this.profile,
      apiKey: this.bedrockApiKey,
    });
  }

  async listModelCatalog(
    options?: ModelCatalogRequest,
  ): Promise<LLMModelCatalog> {
    try {
      const {
        BedrockClient,
        ListFoundationModelsCommand,
        ListInferenceProfilesCommand,
      } = await import('@aws-sdk/client-bedrock');
      const client = new BedrockClient({
        region: this.region,
        ...bedrockClientAuth({
          authMode: this.authMode,
          profile: this.profile,
          apiKey: this.bedrockApiKey,
        }),
      });
      const discoveryController = new AbortController();
      const abortFromCaller = () =>
        discoveryController.abort(options?.signal?.reason);
      throwIfAborted(options?.signal);
      options?.signal?.addEventListener('abort', abortFromCaller, {
        once: true,
      });
      const requestOptions = { abortSignal: discoveryController.signal };
      const maxEntries = catalogLimit(options);
      const [modelsResponse, profiles] = await settleConcurrentWork(
        [
          client.send(new ListFoundationModelsCommand({}), requestOptions),
          listInferenceProfiles({
            client,
            Command: ListInferenceProfilesCommand,
            requestOptions,
            maxEntries,
          }),
        ],
        (error) => {
          if (!discoveryController.signal.aborted) {
            discoveryController.abort(error);
          }
        },
      ).finally(() =>
        options?.signal?.removeEventListener('abort', abortFromCaller),
      );
      const discoveredModels = listLaunchableBedrockSelectors(
        modelsResponse.modelSummaries ?? [],
        profiles,
      ).map(({ selector, model, profile }) => ({
        id: selector,
        name: profile?.inferenceProfileName || model.modelName || selector,
        supportsVision: model.inputModalities?.includes('IMAGE'),
        // archive#1430: deliberately no `supportsTools` here, not an
        // oversight. Checked both `FoundationModelSummary` (this call) and
        // `FoundationModelDetails` (`GetFoundationModelCommand`) in the
        // installed `@aws-sdk/client-bedrock` (v3.1095.0) type definitions —
        // neither carries a tool/function-calling capability field, only
        // modality, streaming, customization, inference-type, and lifecycle
        // metadata. `ListImportedModelsCommand`'s `instructSupported` is the
        // one boolean anywhere in this client that's adjacent in spirit, but
        // it only covers imported custom models (not the foundation models
        // this catalog lists) and it means "supports the Converse API
        // shape," not "supports tool_choice/toolConfig" — mapping it to
        // `supportsTools` would be a false claim, not a real signal. AWS's
        // per-model-family tool-support table is documentation, not an API
        // response, so it fails the honesty bar this issue sets (static
        // knowledge is not a truthful source). Revisit if Bedrock's
        // discovery API ever adds a real field.
      }));
      return {
        source: 'live',
        models: discoveredModels.slice(0, maxEntries),
        ...(discoveredModels.length > maxEntries ? { truncated: true } : {}),
      };
    } catch (error) {
      throwIfAborted(options?.signal);
      // `source: 'unavailable'` is the signal callers act on; an unconfigured
      // Bedrock must not print on every catalog request.
      //
      // archive#3654: it used to be the ONLY signal. The error was discarded here, so
      // no `reason` and no `reasonKind` ever left this method — and
      // `recordModelCatalogDiscovery` writes no receipt at all without them,
      // which is why a Bedrock connection read "Saved — not verified" whatever
      // had actually happened. AWS SDK errors carry no HTTP status field, so
      // they are classified by their own vocabulary and redacted of the
      // account/principal identity AWS echoes back.
      return {
        source: 'unavailable',
        models: [],
        ...describeBedrockCatalogFailure(error),
      };
    }
  }

  async listModels(options?: ModelCatalogRequest): Promise<LLMModel[]> {
    return (await this.listModelCatalog(options)).models;
  }

  /**
   * Whether AWS answered — the inherited contract, restored deliberately
   * (archive#3654).
   *
   * This class used to override `healthCheck` with the credential resolution
   * below, and `testConnection` short-circuits to a PASSED check receipt when
   * `healthCheck` is true. So "a credential resolved on this laptop" was
   * recorded as a check that passed, and rendered as a verified connection,
   * without a single request leaving the machine — a state word nothing
   * observed. It also meant the classified catalogue outcome this change adds
   * could never be reached in the common case, because the short-circuit fired
   * first.
   *
   * Credential resolution is still exactly what `getPrerequisites` reports,
   * which is the question it was answering all along: prerequisites are about
   * this device's setup, health is about the provider.
   */
  async healthCheck(options?: { signal?: AbortSignal }): Promise<boolean> {
    return (await this.listModels(options)).length >= 1;
  }

  /** Whether credentials for this connection resolve on this device. */
  private async credentialsResolve(): Promise<boolean> {
    try {
      if (this.authMode === 'api-key') {
        return Boolean(this.bedrockApiKey?.trim());
      }
      const creds =
        this.authMode === 'profile' && this.profile
          ? fromIni({ profile: this.profile })
          : fromNodeProviderChain();
      await creds();
      return true;
    } catch {
      // The boolean return is the signal. An unconfigured Bedrock is the
      // expected state for a default install, so a health check that finds no
      // credentials must not print on every probe.
      return false;
    }
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    const hasCreds = await this.credentialsResolve();
    return [
      {
        id: 'bedrock',
        name: 'Bedrock Credentials',
        description: 'AWS credentials with Bedrock model access',
        status: hasCreds ? 'installed' : 'missing',
        category: 'required',
        installGuide: {
          steps: ['Configure AWS credentials with Bedrock access'],
          links: [
            'https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html',
          ],
        },
      },
    ];
  }
}
