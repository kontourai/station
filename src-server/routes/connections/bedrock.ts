/**
 * Bedrock Routes - model catalog, pricing, and validation
 */

import type { AppConfig } from '@kontourai/station-contracts/config';
import { Hono } from 'hono';
import {
  type BedrockModelCatalog,
  listLaunchableBedrockSelectors,
  normalizeBedrockRegion,
} from '../../providers/llm/bedrock-models.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';
import { bedrockOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { assertBoundedJsonResponse } from '../chat/bounded-response.js';
import { errorMessage, param } from '../schemas/schemas.js';

async function listLaunchableBedrockRouteModels(
  modelCatalog: BedrockModelCatalog,
  signal?: AbortSignal,
) {
  const [models, profiles] = await Promise.all([
    modelCatalog.listModels({ signal }),
    modelCatalog.listInferenceProfiles({ signal }),
  ]);
  return listLaunchableBedrockSelectors(models, profiles).map(
    ({ model, profile }) =>
      profile
        ? {
            ...model,
            modelId: profile.inferenceProfileId,
            modelArn: profile.inferenceProfileArn,
            modelName: profile.inferenceProfileName || model.modelName,
            inferenceTypesSupported: [],
            isInferenceProfile: true,
            profileType: profile.type,
            status: profile.status,
          }
        : model,
  );
}

export function createBedrockRoutes(
  getModelCatalog: () => BedrockModelCatalog | undefined,
  appConfig: AppConfig,
  logger: Logger,
) {
  const app = new Hono();

  // List all available Bedrock models
  app.get('/models', async (c) => {
    try {
      const modelCatalog = getModelCatalog();
      if (!modelCatalog) {
        return c.json(
          { success: false, error: 'Model catalog not initialized' },
          500,
        );
      }
      bedrockOps.add(1, { op: 'list_models' });
      const combinedModels = await listLaunchableBedrockRouteModels(
        modelCatalog,
        c.req.raw.signal,
      );

      return c.json(
        assertBoundedJsonResponse(
          { success: true, data: combinedModels },
          'Bedrock model catalog',
        ),
      );
    } catch (error: unknown) {
      logger.error('Failed to list Bedrock models', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get pricing for Bedrock models
  app.get('/pricing', async (c) => {
    try {
      const modelCatalog = getModelCatalog();
      if (!modelCatalog) {
        return c.json(
          { success: false, error: 'Model catalog not initialized' },
          500,
        );
      }
      let region: string;
      try {
        // station#1557 round 3: an explicit `?region=` still wins — that is the
        // caller asking about a specific region, not a second opinion about
        // which one applies. Everything below it is the shared resolution.
        region = normalizeBedrockRegion(
          c.req.query('region') ||
            resolveBedrockRegion({
              configRegion: appConfig.region,
              env: process.env,
            }).region,
        );
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
      bedrockOps.add(1, { op: 'get_pricing' });
      const pricing = await modelCatalog.getModelPricing(region, {
        signal: c.req.raw.signal,
      });
      return c.json(
        assertBoundedJsonResponse(
          { success: true, data: pricing },
          'Bedrock pricing',
        ),
      );
    } catch (error: unknown) {
      logger.error('Failed to get Bedrock pricing', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Validate a model ID
  app.get('/models/:modelId/validate', async (c) => {
    try {
      const modelCatalog = getModelCatalog();
      if (!modelCatalog) {
        return c.json(
          { success: false, error: 'Model catalog not initialized' },
          500,
        );
      }
      const modelId = param(c, 'modelId');
      bedrockOps.add(1, { op: 'validate_model' });
      const isValid = await modelCatalog.validateModelId(modelId);
      return c.json({ success: true, data: { modelId, isValid } });
    } catch (error: unknown) {
      logger.error('Failed to validate model ID', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get model details
  app.get('/models/:modelId', async (c) => {
    try {
      const modelCatalog = getModelCatalog();
      if (!modelCatalog) {
        return c.json(
          { success: false, error: 'Model catalog not initialized' },
          500,
        );
      }
      const modelId = param(c, 'modelId');
      bedrockOps.add(1, { op: 'get_model' });
      const models = await listLaunchableBedrockRouteModels(
        modelCatalog,
        c.req.raw.signal,
      );
      const model = models.find((m) => m.modelId === modelId);

      if (!model) {
        return c.json({ success: false, error: 'Model not found' }, 404);
      }

      return c.json(
        assertBoundedJsonResponse(
          { success: true, data: model },
          'Bedrock model detail',
        ),
      );
    } catch (error: unknown) {
      logger.error('Failed to get model details', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
