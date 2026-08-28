import {
  BedrockClient,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';
import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { Hono } from 'hono';
import { listAwsProfiles } from '../../providers/llm/aws-profiles.js';
import {
  type BedrockAuthConfig,
  bedrockClientAuth,
} from '../../providers/llm/bedrock-credentials.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import { bedrockOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { errorMessage, param } from '../schemas/schemas.js';

const logger = createLogger({ name: 'models' });

/**
 * What `GET /capabilities` describes, stated on the response rather than left
 * to the route's name (archive#3373).
 *
 * `source` is the only catalogue this route has ever projected: Bedrock's
 * `ListFoundationModels`. It has no row for a Claude Code, Codex, ACP, or
 * Ollama model, so a model missing from `data` is not evidence that the model
 * lacks a capability — it is evidence that this catalogue does not describe it.
 *
 * `complete` says whether that one catalogue was actually enumerated.
 * `complete: false` means `data` is UNKNOWN, not empty: the AWS call was
 * refused (no credentials) and nothing was learned. A consumer that treats an
 * absent row as "unsupported" must first check `complete`, or it reports an
 * unqueryable Bedrock as "no model supports images".
 */
export interface ModelCapabilitiesEnvelope {
  success: true;
  data: unknown[];
  source: 'bedrock';
  complete: boolean;
  warning?: string;
}

export interface ModelsRouteDeps {
  /**
   * A Bedrock connection's configured auth (archive#3399). Without it this
   * route always consulted the default AWS credential chain, so a user who
   * configured a named profile or an API key had capability discovery answered
   * by credentials inference never uses.
   *
   * The catalogue is one global answer, so this is one connection's auth — the
   * caller picks which. It cannot be per-connection the way inference is,
   * because this route is never asked about a particular connection.
   *
   * Optional so a caller with no connection store still gets chain behaviour.
   */
  getBedrockAuth?: () => BedrockAuthConfig | Promise<BedrockAuthConfig>;

  /**
   * The stored application config. Required rather than optional
   * (archive#1557): this route used to read `process.env.AWS_REGION` alone,
   * so the catalogue a user picked models from could come from a different
   * region than the one Settings displayed and the inference path used.
   * Making the config a mandatory dependency is what stops a future caller
   * from re-forking the resolution.
   */
  getAppConfig: () => AppConfig | Promise<AppConfig>;
}

export function createModelsRoutes(deps: ModelsRouteDeps) {
  const app = new Hono();

  // Cache for model data (refresh every hour)
  let modelCatalogCache: unknown = null;
  let modelCatalogCacheTimestamp = 0;
  let modelCatalogCacheRegion: string | null = null;
  let modelCapabilitiesCache: unknown[] | null = null;
  let modelCapabilitiesCacheTimestamp = 0;
  let modelCapabilitiesCacheRegion: string | null = null;
  const CACHE_TTL = 60 * 60 * 1000; // 1 hour

  /**
   * The catalogue is region-specific, so the region is part of the cache
   * identity. Without it a region change would keep serving the previous
   * region's models for up to an hour while every other surface reported the
   * new one — the same disagreement archive#1557 exists to remove, just time-delayed.
   */
  const currentAuth = async (): Promise<BedrockAuthConfig> => {
    try {
      return (await deps.getBedrockAuth?.()) ?? {};
    } catch {
      // A connection store that cannot answer must not take the catalogue
      // down with it; the default chain is the honest fallback.
      return {};
    }
  };

  const currentRegion = async (): Promise<string> => {
    const appConfig = await deps.getAppConfig();
    return resolveBedrockRegion({
      configRegion: appConfig?.region,
      env: process.env,
    }).region;
  };

  app.get('/', async (c) => {
    try {
      const region = await currentRegion();
      if (
        modelCatalogCache &&
        modelCatalogCacheRegion === region &&
        Date.now() - modelCatalogCacheTimestamp < CACHE_TTL
      ) {
        return c.json({ success: true, data: modelCatalogCache });
      }

      bedrockOps.add(1, { op: 'list_models' });
      const bedrockClient = new BedrockClient({
        region,
        ...bedrockClientAuth(await currentAuth()),
      });
      const modelsResponse = await bedrockClient.send(
        new ListFoundationModelsCommand({}),
      );
      const models = (modelsResponse.modelSummaries || []).filter(
        (model) =>
          model.modelLifecycle?.status === 'ACTIVE' ||
          model.modelLifecycle?.status === 'LEGACY',
      );

      modelCatalogCache = models;
      modelCatalogCacheTimestamp = Date.now();
      modelCatalogCacheRegion = region;

      return c.json({ success: true, data: models });
    } catch (error: unknown) {
      // Absent credentials is an expected state, not a failure — the route
      // already answers it with a 200 and a warning. Classify before logging
      // so an unconfigured Bedrock does not emit an ERROR with a stack on
      // every catalog fetch; only a genuine failure is worth that.
      if (
        (error instanceof Error && error.name === 'CredentialsProviderError') ||
        errorMessage(error)?.includes('credentials')
      ) {
        logger.debug(
          'Model catalog unavailable: AWS credentials not configured',
        );
        return c.json(
          {
            success: true,
            data: [],
            warning: 'AWS credentials not configured',
          },
          200,
        );
      }

      logger.error('Error fetching model catalog', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/aws-profiles', async (c) => {
    try {
      bedrockOps.add(1, { op: 'list_aws_profiles' });
      const result = await listAwsProfiles();
      return c.json({ success: true, data: result });
    } catch (error: unknown) {
      logger.error('Error listing AWS profiles', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * Bedrock foundation-model capabilities. Despite the path, this is not a
   * universal model-capability index — see {@link ModelCapabilitiesEnvelope}
   * for what `source` and `complete` commit to.
   */
  app.get('/capabilities', async (c) => {
    try {
      const region = await currentRegion();
      // Return cached data if fresh AND from the region in effect now
      if (
        modelCapabilitiesCache &&
        modelCapabilitiesCacheRegion === region &&
        Date.now() - modelCapabilitiesCacheTimestamp < CACHE_TTL
      ) {
        return c.json({
          success: true,
          data: modelCapabilitiesCache,
          source: 'bedrock',
          complete: true,
        } satisfies ModelCapabilitiesEnvelope);
      }
      bedrockOps.add(1, { op: 'list_capabilities' });
      const bedrockClient = new BedrockClient({
        region,
        ...bedrockClientAuth(await currentAuth()),
      });

      // Fetch model capabilities
      const modelsResponse = await bedrockClient.send(
        new ListFoundationModelsCommand({}),
      );
      const models = modelsResponse.modelSummaries || [];

      // Build capabilities map (include LEGACY models as they still work)
      const capabilities = models
        .filter(
          (m) =>
            m.modelLifecycle?.status === 'ACTIVE' ||
            m.modelLifecycle?.status === 'LEGACY',
        )
        .map((model) => ({
          modelId: model.modelId,
          modelName: model.modelName,
          provider: model.providerName,
          inputModalities: model.inputModalities || [],
          outputModalities: model.outputModalities || [],
          supportsStreaming: model.responseStreamingSupported,
          supportsImages: ((model.inputModalities as string[]) || []).includes(
            'IMAGE',
          ),
          supportsVideo: ((model.inputModalities as string[]) || []).includes(
            'VIDEO',
          ),
          supportsAudio:
            ((model.inputModalities as string[]) || []).includes('AUDIO') ||
            ((model.inputModalities as string[]) || []).includes('SPEECH'),
          lifecycleStatus: model.modelLifecycle?.status,
        }));

      modelCapabilitiesCache = capabilities;
      modelCapabilitiesCacheTimestamp = Date.now();
      modelCapabilitiesCacheRegion = region;

      return c.json({
        success: true,
        data: capabilities,
        source: 'bedrock',
        complete: true,
      } satisfies ModelCapabilitiesEnvelope);
    } catch (error: unknown) {
      // Classify BEFORE logging, the way the sibling catalog route does
      // (archive#3399). Absent credentials is the expected state on most
      // hosts, and the composer's attachment gate hits this route on mount —
      // an ERROR with a stack every time buries the failures worth reading.
      // `complete: false` is what carries the difference between "Bedrock
      // reported no such model" and "Bedrock was never asked".
      if (
        (error instanceof Error && error.name === 'CredentialsProviderError') ||
        errorMessage(error)?.includes('credentials')
      ) {
        logger.debug(
          'Model capabilities unavailable: AWS credentials not configured',
        );
        return c.json(
          {
            success: true,
            data: [],
            source: 'bedrock',
            complete: false,
            warning: 'AWS credentials not configured',
          } satisfies ModelCapabilitiesEnvelope,
          200,
        );
      }

      logger.error('Error fetching model capabilities', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/pricing/:modelId', async (c) => {
    try {
      const modelId = param(c, 'modelId');
      // An explicit `?region=` still wins — it is the caller asking about a
      // specific region, not a second opinion about which one is in effect.
      const region = c.req.query('region') || (await currentRegion());
      bedrockOps.add(1, { op: 'get_pricing' });
      // Extract model name from modelId (e.g., "anthropic.claude-3-7-sonnet-20250219-v1:0" -> "Claude 3.7 Sonnet")
      const pricingClient = new PricingClient({ region: 'us-east-1' }); // Pricing API only in us-east-1

      const response = await pricingClient.send(
        new GetProductsCommand({
          ServiceCode: 'AmazonBedrock',
          MaxResults: 100,
          Filters: [{ Field: 'regionCode', Value: region, Type: 'TERM_MATCH' }],
        }),
      );

      const priceList = response.PriceList || [];
      const modelPricing: {
        modelId: string;
        region: string;
        inputTokenPrice: number | null;
        outputTokenPrice: number | null;
        currency: string;
      } = {
        modelId,
        region,
        inputTokenPrice: null,
        outputTokenPrice: null,
        currency: 'USD',
      };

      // Parse pricing data
      for (const priceItem of priceList) {
        const data = JSON.parse(priceItem);
        const attrs = data.product?.attributes || {};

        // Match by model name or ID
        if (
          attrs.model &&
          modelId
            .toLowerCase()
            .includes(attrs.model.toLowerCase().replace(/\s+/g, '-'))
        ) {
          const terms = data.terms?.OnDemand || {};
          const termKey = Object.keys(terms)[0];
          if (termKey) {
            const dimensions = terms[termKey].priceDimensions || {};
            const dimKey = Object.keys(dimensions)[0];
            if (dimKey) {
              const price = parseFloat(
                dimensions[dimKey].pricePerUnit?.USD || '0',
              );

              if (attrs.inferenceType?.includes('input')) {
                modelPricing.inputTokenPrice = price;
              } else if (attrs.inferenceType?.includes('output')) {
                modelPricing.outputTokenPrice = price;
              }
            }
          }
        }
      }

      return c.json({ success: true, data: modelPricing });
    } catch (error: unknown) {
      logger.error('Error fetching model pricing', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
