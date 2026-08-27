import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';
import { fromIni } from '@aws-sdk/credential-providers';
import { raceWithSignal } from '../../utils/bounded-async.js';
import type { BedrockAuthMode } from './bedrock-credentials.js';
import { bedrockClientAuth } from './bedrock-credentials.js';
import { isBedrockRegionId } from './bedrock-region.js';

export interface BedrockModel {
  modelId: string;
  modelArn: string;
  modelName: string;
  providerName: string;
  inputModalities: string[];
  outputModalities: string[];
  responseStreamingSupported: boolean;
  customizationsSupported: string[];
  inferenceTypesSupported: string[];
}

export interface InferenceProfile {
  inferenceProfileId: string;
  inferenceProfileArn: string;
  inferenceProfileName: string;
  type: string;
  status: string;
  models: Array<{ modelArn?: string }>;
}

export interface ModelPricing {
  modelId: string;
  provider?: string;
  inputTokenPrice?: number; // per 1K tokens
  outputTokenPrice?: number; // per 1K tokens
  region: string;
  feature: string; // "On-demand Inference", "Batch Inference", etc.
}

const BEDROCK_CATALOG_MAX_ENTRIES = 1000;
const BEDROCK_PROFILE_MAX_PAGES = 32;
const BEDROCK_PRICING_MAX_PAGES = 32;
const BEDROCK_PRICING_MAX_ENTRIES = 1000;
const BEDROCK_PRICING_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BEDROCK_PRICING_MAX_CACHE_KEYS = 32;
const BEDROCK_PRICING_MAX_INFLIGHT_REGIONS = 8;
const BEDROCK_PRICING_TIMEOUT_MS = 30_000;
const BEDROCK_REGION_CATALOG_MAX_KEYS = 32;
const BEDROCK_CACHE_TTL_MS = 15 * 60 * 1000;
export function normalizeBedrockRegion(region: string): string {
  const normalized = region.trim();
  // station#1557 review round 2: the grammar lives in `bedrock-region.ts`
  // alongside the resolver, so the module that discards a malformed
  // `AWS_REGION` and the module that throws on one cannot drift apart.
  if (!isBedrockRegionId(normalized)) {
    throw new Error('Bedrock region must be a valid bounded AWS region id.');
  }
  return normalized;
}

interface TimedCache<T> {
  value: T;
  observedAt: number;
}

interface PricingFlight {
  controller: AbortController;
  epoch: number;
  pending: Promise<ModelPricing[]>;
}

function cloneModels(models: readonly BedrockModel[]): BedrockModel[] {
  return models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    outputModalities: [...model.outputModalities],
    customizationsSupported: [...model.customizationsSupported],
    inferenceTypesSupported: [...model.inferenceTypesSupported],
  }));
}

function cloneProfiles(
  profiles: readonly InferenceProfile[],
): InferenceProfile[] {
  return profiles.map((profile) => ({
    ...profile,
    models: profile.models.map((model) => ({ ...model })),
  }));
}

function foundationModelIdFromArn(modelArn?: string): string | null {
  if (!modelArn) return null;
  const marker = 'foundation-model/';
  const markerIndex = modelArn.lastIndexOf(marker);
  return markerIndex >= 0 ? modelArn.slice(markerIndex + marker.length) : null;
}

export function bedrockProfileFoundationModelId(
  profile: Pick<InferenceProfile, 'models'>,
): string | null {
  const modelIds = profile.models.map(({ modelArn }) =>
    foundationModelIdFromArn(modelArn),
  );
  if (modelIds.length === 0 || modelIds.some((modelId) => modelId === null)) {
    return null;
  }
  const uniqueModelIds = new Set(modelIds);
  return uniqueModelIds.size === 1 ? (modelIds[0] ?? null) : null;
}

export function isLaunchableBedrockFoundationModel(model: {
  outputModalities?: readonly string[];
  responseStreamingSupported?: boolean;
}): boolean {
  return (
    model.responseStreamingSupported === true &&
    model.outputModalities?.includes('TEXT') === true
  );
}

interface BedrockFoundationSummary {
  modelId?: string;
  modelArn?: string;
  modelName?: string;
  inputModalities?: readonly string[];
  outputModalities?: readonly string[];
  responseStreamingSupported?: boolean;
  inferenceTypesSupported?: readonly string[];
}

interface BedrockProfileSummary {
  inferenceProfileId: string;
  inferenceProfileName?: string;
  status: string;
  models: Array<{ modelArn?: string }>;
}

export interface LaunchableBedrockSelector<
  TModel extends BedrockFoundationSummary = BedrockFoundationSummary,
  TProfile extends BedrockProfileSummary = BedrockProfileSummary,
> {
  selector: string;
  model: TModel;
  profile: TProfile | null;
}

export function listLaunchableBedrockSelectors<
  TModel extends BedrockFoundationSummary,
  TProfile extends BedrockProfileSummary,
>(
  models: readonly TModel[],
  profiles: readonly TProfile[],
): Array<LaunchableBedrockSelector<TModel, TProfile>> {
  const selectors = new Map<
    string,
    LaunchableBedrockSelector<TModel, TProfile>
  >();
  for (const model of models) {
    if (
      model.modelId &&
      isLaunchableBedrockFoundationModel(model) &&
      model.inferenceTypesSupported?.includes('ON_DEMAND')
    ) {
      selectors.set(model.modelId, {
        selector: model.modelId,
        model,
        profile: null,
      });
    }
  }
  for (const profile of profiles) {
    if (profile.status !== 'ACTIVE') continue;
    const modelId = bedrockProfileFoundationModelId(profile);
    const model = models.find((candidate) => candidate.modelId === modelId);
    if (!model || !isLaunchableBedrockFoundationModel(model)) continue;
    if (!selectors.has(profile.inferenceProfileId)) {
      selectors.set(profile.inferenceProfileId, {
        selector: profile.inferenceProfileId,
        model,
        profile,
      });
    }
  }
  return [...selectors.values()].sort((left, right) =>
    left.selector.localeCompare(right.selector),
  );
}

export function resolveLaunchableBedrockSelector(
  modelId: string,
  models: readonly BedrockModel[],
  profiles: readonly InferenceProfile[],
): string {
  const selectors = listLaunchableBedrockSelectors(models, profiles);
  const exact = selectors.find((candidate) => candidate.selector === modelId);
  if (exact) return exact.selector;

  const model = models.find((candidate) => candidate.modelId === modelId);
  if (!model) {
    throw new Error(
      `Bedrock selector '${modelId}' is not present in AWS launchability evidence.`,
    );
  }
  if (!isLaunchableBedrockFoundationModel(model)) {
    throw new Error(
      `Bedrock model '${modelId}' is not streaming and text-capable.`,
    );
  }
  const matchingProfiles = selectors.filter(
    (candidate) =>
      candidate.profile !== null && candidate.model.modelId === model.modelId,
  );
  if (matchingProfiles.length > 1) {
    throw new Error(
      `Bedrock model '${modelId}' has multiple matching inference profiles; configure an exact profile selector.`,
    );
  }
  if (matchingProfiles.length === 1) {
    return matchingProfiles[0]!.selector;
  }
  throw new Error(
    `Bedrock model '${modelId}' has no launchable AWS invocation selector.`,
  );
}

export class BedrockModelCatalog {
  private bedrockClient: BedrockClient;
  private pricingClient: PricingClient;
  private modelsCache: TimedCache<BedrockModel[]> | null = null;
  private profilesCache: TimedCache<InferenceProfile[]> | null = null;
  private pricingCache = new Map<string, TimedCache<ModelPricing[]>>();
  private readonly pricingInflight = new Map<string, PricingFlight>();
  private pricingEpoch = 0;
  private readonly regionalCatalogs = new Map<string, BedrockModelCatalog>();
  private readonly now: () => number;
  private readonly authMode: BedrockAuthMode;
  private readonly profile?: string;
  private readonly apiKey?: string;
  /**
   * The AWS Pricing API has no bearer-token auth scheme (unlike Bedrock's
   * own control/runtime APIs), so an `api-key` connection cannot
   * authenticate against it at all. Rather than silently querying Pricing
   * under the default credential chain — a different, unintended AWS
   * principal than the one this catalog otherwise represents (MED, review
   * fix round) — pricing lookups are gated off with a clear error for that
   * mode. `profile` mode threads the same SigV4 credentials Pricing does
   * support.
   */
  private readonly pricingUnavailableReason: string | null;
  readonly region: string;

  constructor(
    region: string = 'us-east-1',
    options?: {
      now?: () => number;
      authMode?: BedrockAuthMode;
      profile?: string;
      apiKey?: string;
    },
  ) {
    this.region = normalizeBedrockRegion(region);
    this.authMode = options?.authMode ?? 'chain';
    this.profile = options?.profile;
    this.apiKey = options?.apiKey;
    // Validates the mode/field pairing (throws on a misconfigured
    // profile/api-key connection) before either client is constructed.
    this.bedrockClient = new BedrockClient({
      region: this.region,
      ...bedrockClientAuth({
        authMode: this.authMode,
        profile: this.profile,
        apiKey: this.apiKey,
      }),
    });
    if (this.authMode === 'api-key') {
      this.pricingUnavailableReason =
        'Bedrock pricing lookups are not available in "api-key" auth mode — the AWS Pricing API has no bearer-token equivalent.';
      this.pricingClient = new PricingClient({ region: 'us-east-1' }); // Pricing API only in us-east-1
    } else if (this.authMode === 'profile') {
      this.pricingUnavailableReason = null;
      this.pricingClient = new PricingClient({
        region: 'us-east-1', // Pricing API only in us-east-1
        credentials: fromIni({ profile: this.profile! }),
      });
    } else {
      this.pricingUnavailableReason = null;
      this.pricingClient = new PricingClient({ region: 'us-east-1' }); // Pricing API only in us-east-1
    }
    this.now = options?.now ?? Date.now;
  }

  forRegion(region: string): BedrockModelCatalog {
    const normalized = normalizeBedrockRegion(region);
    if (normalized === this.region) return this;
    const cached = this.regionalCatalogs.get(normalized);
    if (cached) {
      this.regionalCatalogs.delete(normalized);
      this.regionalCatalogs.set(normalized, cached);
      return cached;
    }
    while (this.regionalCatalogs.size >= BEDROCK_REGION_CATALOG_MAX_KEYS) {
      const oldest = this.regionalCatalogs.keys().next().value;
      if (oldest === undefined) break;
      this.regionalCatalogs.get(oldest)?.dispose();
      this.regionalCatalogs.delete(oldest);
    }
    const catalog = new BedrockModelCatalog(normalized, {
      now: this.now,
      authMode: this.authMode,
      profile: this.profile,
      apiKey: this.apiKey,
    });
    this.regionalCatalogs.set(normalized, catalog);
    return catalog;
  }

  async listModels(options?: {
    signal?: AbortSignal;
  }): Promise<BedrockModel[]> {
    if (this.isFresh(this.modelsCache))
      return cloneModels(this.modelsCache.value);
    this.modelsCache = null;

    try {
      const command = new ListFoundationModelsCommand({});
      const response = await this.bedrockClient.send(
        command,
        options?.signal ? { abortSignal: options.signal } : undefined,
      );
      const summaries = response.modelSummaries || [];
      if (summaries.length > BEDROCK_CATALOG_MAX_ENTRIES) {
        throw new Error('Bedrock foundation models exceeded the entry limit.');
      }

      const models = summaries.map((model) => ({
        modelId: model.modelId!,
        modelArn: model.modelArn!,
        modelName: model.modelName!,
        providerName: model.providerName!,
        inputModalities: model.inputModalities || [],
        outputModalities: model.outputModalities || [],
        responseStreamingSupported: model.responseStreamingSupported || false,
        customizationsSupported: model.customizationsSupported || [],
        inferenceTypesSupported: model.inferenceTypesSupported || [],
      }));
      this.modelsCache = { value: models, observedAt: this.now() };
    } catch (error: any) {
      // If credentials are missing or invalid, return empty array instead of failing
      if (
        error.name === 'CredentialsProviderError' ||
        error.$metadata?.httpStatusCode === 403
      ) {
        return [];
      }
      throw error;
    }

    return cloneModels(this.modelsCache?.value ?? []);
  }

  async listInferenceProfiles(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<InferenceProfile[]> {
    const maxEntries = Math.min(
      BEDROCK_CATALOG_MAX_ENTRIES,
      Math.max(
        1,
        Math.floor(options?.maxEntries ?? BEDROCK_CATALOG_MAX_ENTRIES),
      ),
    );
    if (this.isFresh(this.profilesCache)) {
      return cloneProfiles(this.profilesCache.value.slice(0, maxEntries));
    }
    this.profilesCache = null;

    try {
      const profiles: InferenceProfile[] = [];
      const seenTokens = new Set<string>();
      let nextToken: string | undefined;
      let pageCount = 0;
      do {
        if (pageCount >= BEDROCK_PROFILE_MAX_PAGES) {
          throw new Error(
            'Bedrock inference profiles exceeded the page limit.',
          );
        }
        pageCount += 1;
        const command = new ListInferenceProfilesCommand({
          maxResults: maxEntries - profiles.length,
          nextToken,
        });
        const response = await this.bedrockClient.send(
          command,
          options?.signal ? { abortSignal: options.signal } : undefined,
        );
        profiles.push(
          ...(response.inferenceProfileSummaries || [])
            .slice(0, maxEntries - profiles.length)
            .map((profile) => ({
              inferenceProfileId: profile.inferenceProfileId!,
              inferenceProfileArn: profile.inferenceProfileArn!,
              inferenceProfileName: profile.inferenceProfileName!,
              type: profile.type!,
              status: profile.status!,
              models: profile.models || [],
            })),
        );
        const candidate = response.nextToken;
        if (candidate && seenTokens.has(candidate)) {
          throw new Error(
            'Bedrock inference profile pagination token did not advance.',
          );
        }
        if (candidate) seenTokens.add(candidate);
        nextToken = candidate;
      } while (nextToken && profiles.length < maxEntries);

      if (nextToken) {
        throw new Error('Bedrock inference profiles exceeded the entry limit.');
      }

      this.profilesCache = { value: profiles, observedAt: this.now() };
      return cloneProfiles(profiles.slice(0, maxEntries));
    } catch (error: any) {
      // If credentials are missing or invalid, return empty array instead of failing
      if (
        error.name === 'CredentialsProviderError' ||
        error.$metadata?.httpStatusCode === 403
      ) {
        return [];
      }
      throw error;
    }
  }

  async getModelPricing(
    region: string = 'us-east-1',
    options?: { signal?: AbortSignal },
  ): Promise<ModelPricing[]> {
    if (this.pricingUnavailableReason) {
      throw new Error(this.pricingUnavailableReason);
    }
    const cacheKey = normalizeBedrockRegion(region);
    const cached = this.pricingCache.get(cacheKey);
    if (this.isFresh(cached)) {
      this.pricingCache.delete(cacheKey);
      this.pricingCache.set(cacheKey, cached);
      return cached.value.map((item) => ({ ...item }));
    }
    this.pricingCache.delete(cacheKey);

    const existing = this.pricingInflight.get(cacheKey);
    if (existing) {
      return (await raceWithSignal(existing.pending, options?.signal)).map(
        (item) => ({ ...item }),
      );
    }
    if (this.pricingInflight.size >= BEDROCK_PRICING_MAX_INFLIGHT_REGIONS) {
      throw new Error('Bedrock pricing concurrency limit exceeded.');
    }
    const controller = new AbortController();
    const epoch = this.pricingEpoch;
    const timeout = setTimeout(
      () => controller.abort(new Error('Bedrock pricing discovery timed out.')),
      BEDROCK_PRICING_TIMEOUT_MS,
    );
    const pending = this.fetchModelPricing(
      cacheKey,
      controller.signal,
      epoch,
    ).finally(() => clearTimeout(timeout));
    const flight = { controller, epoch, pending };
    this.pricingInflight.set(cacheKey, flight);
    void pending.then(
      () => {
        if (this.pricingInflight.get(cacheKey) === flight) {
          this.pricingInflight.delete(cacheKey);
        }
      },
      () => {
        if (this.pricingInflight.get(cacheKey) === flight) {
          this.pricingInflight.delete(cacheKey);
        }
      },
    );
    return (await raceWithSignal(pending, options?.signal)).map((item) => ({
      ...item,
    }));
  }

  private async fetchModelPricing(
    cacheKey: string,
    signal: AbortSignal,
    epoch: number,
  ): Promise<ModelPricing[]> {
    const pricing: ModelPricing[] = [];
    const pricingIndex = new Map<string, ModelPricing>();
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    let pageCount = 0;
    let entryCount = 0;
    let responseBytes = 0;

    do {
      if (pageCount >= BEDROCK_PRICING_MAX_PAGES) {
        throw new Error('Bedrock pricing exceeded the page limit.');
      }
      pageCount += 1;
      const command = new GetProductsCommand({
        ServiceCode: 'AmazonBedrock',
        Filters: [
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: cacheKey },
          {
            Type: 'TERM_MATCH',
            Field: 'productFamily',
            Value: 'Amazon Bedrock',
          },
        ],
        MaxResults: 100,
        NextToken: nextToken,
      });

      const response = await raceWithSignal(
        this.pricingClient.send(command, { abortSignal: signal }),
        signal,
      );

      for (const priceItem of response.PriceList || []) {
        if (typeof priceItem !== 'string') {
          throw new Error('Bedrock pricing returned an invalid product entry.');
        }
        entryCount += 1;
        responseBytes += Buffer.byteLength(priceItem);
        if (entryCount > BEDROCK_PRICING_MAX_ENTRIES) {
          throw new Error('Bedrock pricing exceeded the entry limit.');
        }
        if (responseBytes > BEDROCK_PRICING_MAX_RESPONSE_BYTES) {
          throw new Error('Bedrock pricing exceeded the response byte limit.');
        }
        const product = JSON.parse(priceItem);
        const attrs = product.product?.attributes;
        const terms = product.terms?.OnDemand;

        if (!attrs || !terms) continue;

        const model = attrs.model;
        const provider = attrs.provider;
        const inferenceType = attrs.inferenceType;
        const feature = attrs.feature;

        if (!model) continue;

        // Extract price from terms
        const termKey = Object.keys(terms)[0];
        const priceDimensions = terms[termKey]?.priceDimensions;
        if (!priceDimensions) continue;

        const dimensionKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = priceDimensions[dimensionKey]?.pricePerUnit?.USD;
        const price = pricePerUnit ? parseFloat(pricePerUnit) : undefined;

        // Map inference type to input/output
        const pricingKey = `${model}\u0000${feature ?? ''}`;
        const existing = pricingIndex.get(pricingKey);

        if (existing) {
          if (inferenceType?.includes('Output')) {
            existing.outputTokenPrice = price;
          } else if (inferenceType?.includes('Input')) {
            existing.inputTokenPrice = price;
          }
        } else {
          const item = {
            modelId: model,
            provider,
            inputTokenPrice: inferenceType?.includes('Input')
              ? price
              : undefined,
            outputTokenPrice: inferenceType?.includes('Output')
              ? price
              : undefined,
            region: cacheKey,
            feature: feature || 'On-demand Inference',
          };
          pricing.push(item);
          pricingIndex.set(pricingKey, item);
        }
      }

      const candidate = response.NextToken;
      if (candidate && seenTokens.has(candidate)) {
        throw new Error('Bedrock pricing pagination token did not advance.');
      }
      if (candidate) seenTokens.add(candidate);
      nextToken = candidate;
    } while (nextToken);

    if (signal.aborted || epoch !== this.pricingEpoch) {
      throw (
        signal.reason ?? new Error('Bedrock pricing discovery was invalidated.')
      );
    }
    while (this.pricingCache.size >= BEDROCK_PRICING_MAX_CACHE_KEYS) {
      const oldest = this.pricingCache.keys().next().value;
      if (oldest === undefined) break;
      this.pricingCache.delete(oldest);
    }
    this.pricingCache.set(cacheKey, {
      value: pricing,
      observedAt: this.now(),
    });
    return pricing;
  }

  async validateModelId(modelId: string): Promise<boolean> {
    const [models, profiles] = await Promise.all([
      this.listModels(),
      this.listInferenceProfiles(),
    ]);
    try {
      resolveLaunchableBedrockSelector(modelId, models, profiles);
      return true;
    } catch {
      return false;
    }
  }

  async getModelInfo(modelId: string): Promise<BedrockModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.modelId === modelId);
  }

  async resolveModelId(modelId: string): Promise<string> {
    try {
      const [models, profiles] = await Promise.all([
        this.listModels(),
        this.listInferenceProfiles(),
      ]);
      return resolveLaunchableBedrockSelector(modelId, models, profiles);
    } catch (error) {
      console.debug('Failed to resolve model via inference profile lookup.');
      throw error;
    }
  }

  clearCache() {
    this.pricingEpoch += 1;
    for (const flight of this.pricingInflight.values()) {
      flight.controller.abort(
        new Error('Bedrock pricing discovery was invalidated.'),
      );
    }
    this.pricingInflight.clear();
    this.modelsCache = null;
    this.profilesCache = null;
    this.pricingCache.clear();
    for (const catalog of this.regionalCatalogs.values()) catalog.clearCache();
    this.regionalCatalogs.clear();
  }

  dispose(): void {
    const regionalCatalogs = [...this.regionalCatalogs.values()];
    this.clearCache();
    for (const catalog of regionalCatalogs) catalog.dispose();
    this.bedrockClient.destroy();
    this.pricingClient.destroy();
  }

  private isFresh<T>(
    cache: TimedCache<T> | null | undefined,
  ): cache is TimedCache<T> {
    return Boolean(
      cache && this.now() - cache.observedAt < BEDROCK_CACHE_TTL_MS,
    );
  }
}
