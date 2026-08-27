import { z } from 'zod';
import type { ZodTypeAny as ZodV3TypeAny } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  agentCreateSchema,
  agentUpdateSchema,
  appConfigUpdateSchema,
  integrationSchema,
  localSkillCreateSchema,
  localSkillUpdateSchema,
  pluginInstallSchema,
  pluginOverridesSchema,
  pluginPreviewSchema,
  registryInstallSchema,
  skillImportSchema,
  skillOutcomeSchema,
} from '../routes/schemas/schemas.js';

type HttpMethod = 'delete' | 'get' | 'post' | 'put';

type Operation = {
  operationId: string;
  requestBodySchema?: unknown;
  responseBodySchema?: unknown;
  summary: string;
  tags: string[];
  /**
   * Statuses this operation actually answers with, beyond the 200/400/500
   * every operation shares. Documenting only the shared three made the
   * generated document describe responses the routes do not have and omit the
   * ones they do — a partial import's 207, a command clash's 409 (review
   * finding 7).
   */
  responses?: Record<number, string>;
};

const JSON_CONTENT_TYPE = 'application/json';
const integrationUpdateSchema = integrationSchema.partial();
const unavailableFixSchema = z.object({
  kind: z.enum([
    'model-connection',
    'engine-disabled',
    'cli-missing',
    'connection-broken',
    'agent-configuration',
    'unknown',
    'policy',
    'none',
  ]),
  target: z.string().optional(),
});
const enrichedAgentSchema = z
  .object({ unavailableFix: unavailableFixSchema.optional() })
  .passthrough();
const agentCatalogResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(enrichedAgentSchema),
});

const FIRST_PASS_PATHS: Record<
  string,
  Partial<Record<HttpMethod, Operation>>
> = {
  '/config/app': {
    get: {
      operationId: 'getAppConfig',
      summary: 'Get application configuration',
      tags: ['config'],
    },
    put: {
      operationId: 'updateAppConfig',
      requestBodySchema: appConfigUpdateSchema,
      summary: 'Update application configuration',
      tags: ['config'],
    },
  },
  '/agents': {
    get: {
      operationId: 'listAgents',
      responseBodySchema: agentCatalogResponseSchema,
      summary: 'List enriched agents',
      tags: ['agents'],
    },
    post: {
      operationId: 'createAgent',
      requestBodySchema: agentCreateSchema,
      summary: 'Create an agent',
      tags: ['agents'],
    },
  },
  '/agents/{slug}': {
    put: {
      operationId: 'updateAgent',
      requestBodySchema: agentUpdateSchema,
      summary: 'Update an agent',
      tags: ['agents'],
    },
    delete: {
      operationId: 'deleteAgent',
      summary: 'Delete an agent',
      tags: ['agents'],
    },
  },
  '/integrations': {
    get: {
      operationId: 'listIntegrations',
      summary: 'List integrations',
      tags: ['integrations'],
    },
    post: {
      operationId: 'createIntegration',
      requestBodySchema: integrationSchema,
      summary: 'Create or update an integration',
      tags: ['integrations'],
    },
  },
  '/integrations/{id}': {
    get: {
      operationId: 'getIntegration',
      summary: 'Get an integration',
      tags: ['integrations'],
    },
    put: {
      operationId: 'updateIntegration',
      requestBodySchema: integrationUpdateSchema,
      summary: 'Update an integration',
      tags: ['integrations'],
    },
    delete: {
      operationId: 'deleteIntegration',
      summary: 'Delete an integration',
      tags: ['integrations'],
    },
  },
  '/integrations/{id}/reconnect': {
    post: {
      operationId: 'reconnectIntegration',
      summary: 'Reconnect an integration',
      tags: ['integrations'],
    },
  },
  '/api/skills': {
    get: {
      operationId: 'listSkills',
      summary: 'List installed skills',
      tags: ['skills'],
    },
  },
  '/api/skills/{name}': {
    get: {
      operationId: 'getSkill',
      summary: 'Get a skill (resolves a legacy identifier)',
      tags: ['skills'],
    },
    put: {
      operationId: 'updateSkill',
      requestBodySchema: localSkillUpdateSchema,
      summary: 'Update a local skill, including its command and variables',
      tags: ['skills'],
      responses: {
        409: 'Read-only skill, or a command word another skill already holds',
      },
    },
    delete: {
      operationId: 'deleteSkill',
      summary: 'Remove an installed skill',
      tags: ['skills'],
    },
  },
  '/api/skills/local': {
    post: {
      operationId: 'createLocalSkill',
      requestBodySchema: localSkillCreateSchema,
      summary: 'Create a local skill package',
      tags: ['skills'],
      responses: {
        201: 'Created',
        409: 'A command word another skill already holds',
      },
    },
  },
  '/api/skills/import': {
    post: {
      operationId: 'importSkills',
      requestBodySchema: skillImportSchema,
      summary: 'Import markdown files as local skills',
      tags: ['skills'],
      responses: {
        201: 'Every file imported',
        207: 'Per-file results; at least one file did not import',
      },
    },
  },
  '/api/skills/{name}/run': {
    post: {
      operationId: 'trackSkillRun',
      summary: 'Track a skill run',
      tags: ['skills'],
      responses: {
        404: 'No skill answers to that name or legacy identifier',
        503: 'Usage counters are unreadable; they were left untouched',
      },
    },
  },
  '/api/skills/{name}/outcome': {
    post: {
      operationId: 'recordSkillOutcome',
      requestBodySchema: skillOutcomeSchema,
      summary: 'Record skill outcome quality',
      tags: ['skills'],
      responses: {
        404: 'No skill answers to that name or legacy identifier',
        503: 'Usage counters are unreadable; they were left untouched',
      },
    },
  },
  '/api/registry/plugins': {
    get: {
      operationId: 'listRegistryPlugins',
      summary: 'List available registry plugins',
      tags: ['registry'],
    },
  },
  '/api/registry/plugins/installed': {
    get: {
      operationId: 'listInstalledRegistryPlugins',
      summary: 'List installed registry plugins',
      tags: ['registry'],
    },
  },
  '/api/registry/plugins/install': {
    post: {
      operationId: 'installRegistryPlugin',
      requestBodySchema: registryInstallSchema,
      summary: 'Install a plugin from the registry',
      tags: ['registry'],
    },
  },
  '/api/registry/plugins/{id}': {
    delete: {
      operationId: 'uninstallRegistryPlugin',
      summary: 'Uninstall a registry plugin',
      tags: ['registry'],
    },
  },
  '/api/plugins': {
    get: {
      operationId: 'listPlugins',
      summary: 'List installed plugins',
      tags: ['plugins'],
    },
  },
  '/api/plugins/preview': {
    post: {
      operationId: 'previewPluginInstall',
      requestBodySchema: pluginPreviewSchema,
      summary: 'Preview a plugin before install',
      tags: ['plugins'],
    },
  },
  '/api/plugins/install': {
    post: {
      operationId: 'installPlugin',
      requestBodySchema: pluginInstallSchema,
      summary: 'Install a plugin from a source',
      tags: ['plugins'],
    },
  },
  '/api/plugins/check-updates': {
    get: {
      operationId: 'checkPluginUpdates',
      summary: 'Check installed plugins for updates',
      tags: ['plugins'],
    },
  },
  '/api/plugins/{name}/update': {
    post: {
      operationId: 'updatePlugin',
      summary: 'Update an installed plugin',
      tags: ['plugins'],
    },
  },
  '/api/plugins/{name}': {
    delete: {
      operationId: 'deletePlugin',
      summary: 'Delete an installed plugin',
      tags: ['plugins'],
    },
  },
  '/api/plugins/reload': {
    post: {
      operationId: 'reloadPlugins',
      summary: 'Reload installed plugin providers',
      tags: ['plugins'],
    },
  },
  '/api/plugins/{name}/providers': {
    get: {
      operationId: 'getPluginProviders',
      summary: 'Get provider state for a plugin',
      tags: ['plugins'],
    },
  },
  '/api/plugins/{name}/overrides': {
    get: {
      operationId: 'getPluginOverrides',
      summary: 'Get plugin override state',
      tags: ['plugins'],
    },
    put: {
      operationId: 'updatePluginOverrides',
      requestBodySchema: pluginOverridesSchema,
      summary: 'Update plugin override state',
      tags: ['plugins'],
    },
  },
};

export function buildOpenApiSpec() {
  const schemas = collectSchemas();

  return {
    openapi: '3.1.0',
    info: {
      title: 'Station API',
      version: '0.1.0',
      description:
        'Generated OpenAPI for the first-pass Station portability route set.',
    },
    paths: Object.fromEntries(
      Object.entries(FIRST_PASS_PATHS).map(
        ([path, operations]): [string, PathItem] => {
          const item: PathItem = Object.fromEntries(
            Object.entries(operations).map(([method, operation]) => [
              method,
              buildOperation(operation),
            ]),
          );
          // Derived from the template itself rather than hand-listed per
          // operation, so a templated path can never ship without the required
          // parameter an OpenAPI validator demands — including the pre-existing
          const parameters = pathParameters(path);
          if (parameters.length > 0) item.parameters = parameters;
          return [path, item];
        },
      ),
    ),
    components: {
      schemas,
    },
  };
}

function buildOperation(operation: Operation) {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    tags: operation.tags,
    ...(operation.requestBodySchema
      ? {
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: schemaRef(operation.requestBodySchema),
              },
            },
          },
        }
      : {}),
    responses: {
      200: {
        description: 'Success',
        ...(operation.responseBodySchema
          ? {
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: schemaRef(operation.responseBodySchema),
                },
              },
            }
          : {}),
      },
      400: {
        description: 'Validation or request error',
      },
      500: {
        description: 'Server error',
      },
      ...Object.fromEntries(
        Object.entries(operation.responses ?? {}).map(
          ([status, description]) => [status, { description }],
        ),
      ),
    },
  };
}

interface PathParameter {
  name: string;
  in: 'path';
  required: true;
  schema: { type: 'string' };
}

type PathItem = {
  parameters?: PathParameter[];
} & Partial<Record<HttpMethod, ReturnType<typeof buildOperation>>>;

/** The `{name}`-style segments of a path template, as OpenAPI parameters. */
function pathParameters(path: string): PathParameter[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function collectSchemas() {
  const entries = {
    AppConfigUpdate: appConfigUpdateSchema,
    AgentCreate: agentCreateSchema,
    AgentCatalogResponse: agentCatalogResponseSchema,
    AgentUpdate: agentUpdateSchema,
    Integration: integrationSchema,
    IntegrationUpdate: integrationUpdateSchema,
    PluginInstall: pluginInstallSchema,
    PluginOverrides: pluginOverridesSchema,
    PluginPreview: pluginPreviewSchema,
    RegistryInstall: registryInstallSchema,
    SkillCreate: localSkillCreateSchema,
    SkillImport: skillImportSchema,
    SkillOutcome: skillOutcomeSchema,
    SkillUpdate: localSkillUpdateSchema,
  } as const;

  return Object.fromEntries(
    Object.entries(entries).map(([name, schema]) => [
      name,
      // The catalog response is a passthrough projection. Keep the registry
      // heterogeneous at this OpenAPI boundary rather than forcing every
      // registered schema through the narrower object-union inference.
      zodToJsonSchema(schema as unknown as ZodV3TypeAny, name),
    ]),
  );
}

function schemaRef(schema: unknown) {
  const lookup = new Map<unknown, string>([
    [appConfigUpdateSchema, 'AppConfigUpdate'],
    [agentCreateSchema, 'AgentCreate'],
    [agentCatalogResponseSchema, 'AgentCatalogResponse'],
    [agentUpdateSchema, 'AgentUpdate'],
    [integrationSchema, 'Integration'],
    [integrationUpdateSchema, 'IntegrationUpdate'],
    [pluginInstallSchema, 'PluginInstall'],
    [pluginOverridesSchema, 'PluginOverrides'],
    [pluginPreviewSchema, 'PluginPreview'],
    [registryInstallSchema, 'RegistryInstall'],
    [localSkillCreateSchema, 'SkillCreate'],
    [skillImportSchema, 'SkillImport'],
    [skillOutcomeSchema, 'SkillOutcome'],
    [localSkillUpdateSchema, 'SkillUpdate'],
  ]);

  const name = lookup.get(schema);
  if (!name) {
    throw new Error('Unknown schema reference requested for OpenAPI build');
  }

  return { $ref: `#/components/schemas/${name}` };
}
