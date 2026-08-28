import { isDeepStrictEqual } from 'node:util';
import { Hono } from 'hono';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registryOwnsAgentAtHome } from '../../domain/agent-registry.js';
import { isExternalEngineBoundAgent } from '../../runtime/agents/agent-engine-classification.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { toolDefinitionOps } from '../../telemetry/metrics.js';
import {
  addToolSchema,
  errorMessage,
  getBody,
  param,
  updateAllowedSchema,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import { runtimeAgentKey } from './runtime-agent-identity.js';

type ToolWithDescription = { description?: string; [key: string]: any };

/**
 * archive#3158 — "Agent not found or not active" made the caller guess between
 * two answers with opposite remedies: nothing by this name exists (pick or
 * create a different agent) versus it exists but its runtime is down (wait for
 * startup, or repair whatever failed to initialize it).
 *
 * Existence is the union `AgentService.listAgents` projects: agents persisted
 * under the home dir PLUS the registry's default agents, which deliberately
 * have no on-disk file. Consulting only the persisted set would report the
 * built-in `station` agent as missing every time its runtime is down — the
 * exact case this distinction exists to name.
 *
 * Read on the failure path only, so a served request costs nothing extra.
 */
async function inactiveAgentFailure(
  ctx: RuntimeContext,
  slug: string,
): Promise<{
  error: string;
  status: 404 | 409 | 503;
  retryAfterSeconds?: number;
}> {
  // registryOwnsAgentAtHome, NOT loadOrCreateAgentRegistry. The latter is
  // write-capable — it seeds and saves a registry when none exists, and
  // throws AgentRegistryConflictError if the signature changes mid-read
  // (a concurrent engine-connection adopt/decline is enough). The outer
  // catch turns that into a 500, so the diagnosis path could fail with a
  // server error on exactly the request it exists to explain. This variant
  // is read-only and fails closed to `false` (archive#3158 review).
  const [persisted, ownedByRegistry] = await Promise.all([
    ctx.configLoader.listAgents(),
    registryOwnsAgentAtHome(ctx.configLoader.getProjectHomeDir(), slug),
  ]);
  const exists =
    ownedByRegistry || persisted.some((agent) => String(agent.slug) === slug);
  if (!exists) return { error: `Agent '${slug}' not found`, status: 404 };
  // "Not active" and "not active YET" are different answers, and reporting
  // the first for the second sent clients to a dead end after a create that
  // had simply outrun its activation deadline. 503 + Retry-After is the
  // honest shape: it is transient, and it says how long to wait.
  if (ctx.isAgentConfigurationActivationPending?.(slug)) {
    return {
      error: `Agent '${slug}' is activating; retry shortly`,
      status: 503,
      retryAfterSeconds: 1,
    };
  }
  // Activation was tried and abandoned. "Exists but is not active" is true
  // and useless — it is the sentence a user stares at with nothing to do.
  // Say what failed, so the editor can show it and offer a retry.
  const failure = ctx.getAgentActivationFailure?.(slug);
  if (failure) {
    return {
      error: `Agent '${slug}' could not be activated: ${failure.reason}`,
      status: 409,
    };
  }
  return { error: `Agent '${slug}' exists but is not active`, status: 409 };
}

export function createAgentToolRoutes(ctx: RuntimeContext) {
  const app = new Hono();

  // GET /:slug/tools
  app.get('/:slug/tools', async (c) => {
    try {
      const slug = param(c, 'slug');
      const runtimeSlug = runtimeAgentKey(slug);
      if (!ctx.activeAgents.get(runtimeSlug)) {
        // External engines own their tool loop. Their persisted definitions
        // are active for orchestration immediately, even though they never
        // appear in Station's VoltAgent map; expose their empty Station-tool
        // catalog instead of incorrectly returning 409 until a restart.
        try {
          const spec = await ctx.configLoader.loadAgent(slug);
          if (isExternalEngineBoundAgent(spec)) {
            return c.json({ success: true, data: [] });
          }
        } catch {
          // Preserve the precise existence/active diagnosis below.
        }
        const failure = await inactiveAgentFailure(ctx, slug);
        if (failure.retryAfterSeconds !== undefined) {
          c.header('Retry-After', String(failure.retryAfterSeconds));
        }
        return c.json({ success: false, error: failure.error }, failure.status);
      }

      const tools = ctx.agentTools.get(runtimeSlug) || [];
      const data = tools.map((tool: any) => {
        const mapping = ctx.toolNameMapping.get(tool.name);
        let parameters = tool.parameters;
        if (
          parameters &&
          typeof parameters === 'object' &&
          '_def' in parameters
        ) {
          try {
            parameters = zodToJsonSchema(parameters);
          } catch (e) {
            console.debug('Failed to convert Zod schema:', e);
          }
        }
        return {
          id: tool.id || tool.name,
          name: tool.name,
          originalName: mapping?.original || tool.name,
          server: mapping?.server || null,
          toolName: mapping?.tool || tool.name,
          description: tool.description,
          parameters,
        };
      });

      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // POST /:slug/tools
  app.post('/:slug/tools', validate(addToolSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const { toolId } = getBody(c);
      toolDefinitionOps.add(1, { op: 'add_tool' });
      const mutation = await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const agent = await ctx.configLoader.loadAgent(slug);
          const updated = agent.tools || {
            mcpServers: [],
            available: ['*'],
          };
          if (updated.mcpServers.includes(toolId)) return updated;
          updated.mcpServers.push(toolId);
          beginMutation();
          await ctx.configLoader.updateAgent(slug, { tools: updated });
          return updated;
        },
      );
      return c.json(
        {
          success: true,
          data: mutation.value.mcpServers,
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // DELETE /:slug/tools/:toolId
  app.delete('/:slug/tools/:toolId', async (c) => {
    try {
      const slug = param(c, 'slug');
      const toolId = param(c, 'toolId');
      toolDefinitionOps.add(1, { op: 'remove_tool' });
      const mutation = await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const agent = await ctx.configLoader.loadAgent(slug);
          const tools = agent.tools || { mcpServers: [] };
          if (!tools.mcpServers.includes(toolId)) return;
          tools.mcpServers = tools.mcpServers.filter(
            (entry) => entry !== toolId,
          );
          beginMutation();
          await ctx.configLoader.updateAgent(slug, { tools });
        },
      );
      return c.json(
        {
          success: true,
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // PUT /:slug/tools/allowed
  app.put('/:slug/tools/allowed', validate(updateAllowedSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const { allowed } = getBody(c);
      const mutation = await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const agent = await ctx.configLoader.loadAgent(slug);
          const updated = agent.tools || { mcpServers: [] };
          if (isDeepStrictEqual(updated.available, allowed)) return updated;
          updated.available = allowed;
          beginMutation();
          await ctx.configLoader.updateAgent(slug, { tools: updated });
          return updated;
        },
      );
      return c.json(
        {
          success: true,
          data: mutation.value,
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // GET /:slug/health
  app.get('/:slug/health', async (c) => {
    const slug = param(c, 'slug');
    const runtimeSlug = runtimeAgentKey(slug);
    const agent = ctx.activeAgents.get(runtimeSlug);

    if (!agent) {
      // The same `!activeAgents.get(...)` condition /tools answers, and the
      // same two causes behind it — so the same diagnosis. "Agent not found"
      // is not merely vague here, it is false whenever the agent exists and
      // its runtime is simply down, which is the answer a health check is
      // most often asked for.
      const failure = await inactiveAgentFailure(ctx, slug);
      return c.json(
        {
          success: false,
          healthy: false,
          error: failure.error,
          checks: { loaded: false },
        },
        failure.status,
      );
    }

    const checks: Record<string, boolean> = {
      loaded: true,
      hasModel: !!agent.model,
      hasMemory: ctx.memoryAdapters.has(runtimeSlug),
    };

    const spec = ctx.agentSpecs.get(runtimeSlug);
    const integrations: Array<{
      id: string;
      type: string;
      connected: boolean;
      error?: string;
      metadata?: any;
    }> = [];

    if (spec?.tools?.mcpServers?.length) {
      checks.integrationsConfigured = true;

      for (const entry of spec.tools.mcpServers) {
        const id = entry;
        const status = ctx.mcpConnectionStatus.get(id);
        const metadata = ctx.integrationMetadata.get(id);
        const agentTools = ctx.agentTools.get(runtimeSlug) || [];
        const serverTools = agentTools
          .filter((t) => t.name.startsWith(id.replace(/-/g, '')))
          .map((t) => {
            const mapping = ctx.toolNameMapping.get(t.name);
            return {
              name: t.name,
              originalName: mapping?.original || t.name,
              server: mapping?.server || null,
              toolName: mapping?.tool || t.name,
              description: (t as ToolWithDescription).description,
            };
          });

        integrations.push({
          id,
          type: metadata?.type || 'mcp',
          connected: status?.connected === true,
          error: status?.error,
          metadata: metadata
            ? {
                transport: metadata.transport,
                toolCount: metadata.toolCount,
                tools: serverTools,
              }
            : undefined,
        });
      }

      checks.integrationsConnected = integrations.every((i) => i.connected);
    }

    return c.json({
      success: true,
      healthy: Object.values(checks).every((v) => v),
      checks,
      integrations,
      status: ctx.agentStatus.get(runtimeSlug) || 'idle',
    });
  });

  return app;
}
