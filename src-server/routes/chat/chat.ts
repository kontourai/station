/**
 * Chat Routes - POST /:slug/chat SSE streaming endpoint
 * Extracted from station-runtime.ts lines 1940-2800
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  engineConnectionId,
  isStationAgentIdentity,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { Hono } from 'hono';
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { resolveMaxSteps } from '../../constants.js';
import {
  INTERNAL_TURN_CORRELATION_HEADER,
  readAuthorizedTurnCorrelationHandoff,
  readNativeOutputRelayCompanion,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import {
  captureRuntimeConfigurationLease,
  RuntimeConfigurationConflictError,
  type RuntimeConfigurationLease,
  requireCurrentRuntimeConfiguration,
  runtimeConfigurationLeaseIsCurrent,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import {
  createStationEngineAvailabilityReader,
  ManagedModelUnavailableError,
  type StationEngineAvailabilitySource,
} from '../../runtime/plugins/runtime-provider-resolution.js';
import type { RuntimeContext } from '../../runtime/types.js';
import type { ConnectionService } from '../../services/connections/connection-service.js';
import { chatErrors } from '../../telemetry/metrics.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  isTrustedInternalApiToken,
} from '../../utils/internal-api-token.js';
import {
  isHonestlyAvailableConnectedAgent,
  type RuntimeConnectionSummary,
} from '../agents/enriched-agents.js';
import { resolveRuntimeAgent } from '../agents/runtime-agent-resolver.js';
import {
  chatSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import { resolveChatAgentModelOverride } from './chat-model-override.js';
import {
  logDebugChatImages,
  streamPrimaryAgentChat,
} from './chat-primary-stream.js';
import {
  type ChatMessage,
  prepareChatRequest,
} from './chat-request-preparation.js';
import { getChatTurnDedupStore } from './chat-turn-dedup.js';

/**
 * archive#977: `RuntimeContext` has no `connectionService` (agent/runtime
 * connections — Claude Code/Codex/ACP) — only `providerService` (model/LLM
 * connections, used by the pre-existing Station-engine availability lens
 * below). Adding it here (rather than widening the shared `RuntimeContext`
 * used by every route module) keeps the blast radius to this route: the
 * field is optional, so any caller/test that omits it just gets the
 * pre-existing behavior (no honesty check, same as before this fix).
 */
type ChatRuntimeContext = RuntimeContext & {
  connectionService?: Pick<ConnectionService, 'listRuntimeConnections'>;
  listAgents?: () => Promise<
    Array<{
      slug: string;
      name: string;
      execution?: { agentConnectionId?: string };
    }>
  >;
  getDefaultAgentIds?: () => Promise<ReadonlySet<string>>;
  /**
   * #1536 D8 delta review DM1: the LIVE inputs the shared availability reader
   * needs. `RuntimeContext.appConfig` is the snapshot the process booted with,
   * so this route answered 409 "Multiple enabled LLM provider connections
   * require an explicit default" until restart, while the New Chat picker and
   * the inbox — reading live config through the same reader — had already
   * cleared. Threaded in here rather than widening the shared context, exactly
   * as `connectionService` above; optional so a caller that omits them falls
   * back to the boot snapshot it used before.
   */
  getLiveAppConfig?: () => AppConfig;
  checkGatedModelConnectionIds?: () => ReadonlyMap<
    string,
    'failed' | 'unreachable'
  >;
};

/**
 * Honest response for an Agent whose spec is bound to a
 * ready external engine connection (Claude Code, Codex, or a plugin ACP
 * connection). Before this fix such an agent was reported "not currently
 * launchable" — a false negative: the reload lifecycle (archive#954/#977)
 * deliberately never builds a Station-engine agent for it, but it is
 * launchable through orchestration via its bound engine. archive#3027: the
 * signposted orchestration path itself now refuses a spec-less engine
 * default, so the message states the authored-Agent requirement rather than
 * promising a route that would answer 400 for the same alias. Exported so
 * tests assert the exact wording, mirroring `ACP_CHAT_REDIRECT_MESSAGE`.
 */
export function externalEngineChatRedirectMessage(agentSlug: string): string {
  return (
    `Agent '${agentSlug}' is bound to an external engine connection and is driven ` +
    'through POST /api/orchestration/chat with an Environment + Agent target, not the per-Agent /chat route; ' +
    'starting a session there requires an authored Agent definition — enable this engine by creating an Agent for it; ' +
    'see docs/reference/session-api.md'
  );
}

export function createChatRoutes(ctx: ChatRuntimeContext) {
  const app = new Hono();

  app.post('/:slug/chat', validate(chatSchema), async (c) => {
    const slug = param(c, 'slug');
    const plugin = c.req.header(STATION_PLUGIN_HEADER) || '';
    // Only Station's authenticated loopback relay may carry an orchestration
    // coordinate into the model-facing request. A direct caller's header is
    // ignored even when it has a syntactically valid payload, so an external
    // request cannot manufacture a fleet-operation join.
    const trustedRelay = isTrustedInternalApiToken(
      c.req.header(INTERNAL_API_TOKEN_HEADER),
    );
    const relayHandoff = c.req.header(INTERNAL_TURN_CORRELATION_HEADER);
    const turnCorrelation = trustedRelay
      ? readAuthorizedTurnCorrelationHandoff(relayHandoff)
      : undefined;
    const nativeOutputRelay = trustedRelay
      ? readNativeOutputRelayCompanion(relayHandoff)
      : undefined;

    try {
      const {
        input,
        ambientContext,
        options: rawOptions = {},
        projectSlug,
      } = getBody(c);
      const configurationLease = captureRuntimeConfigurationLease(ctx);
      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      const nativeOutputGrant = nativeOutputRelay?.issueForRuntimeConfiguration(
        configurationLease,
        () => runtimeConfigurationLeaseIsCurrent(ctx, configurationLease),
      );

      const {
        options,
        resolvedProviderConn,
        injectContext,
        ragContext: preparedRagContext,
        contextInjection,
      } = await prepareChatRequest({
        ctx,
        slug,
        input,
        options: rawOptions,
        projectSlug,
      });
      requireCurrentRuntimeConfiguration(ctx, configurationLease);
      const ragContext = preparedRagContext;

      logDebugChatImages(ctx.logger, input as string | ChatMessage[]);

      const { model: requestedModel, ...restOptions } = options;
      let modelOverride = requestedModel;

      const runtimeAgent = await resolveRuntimeChatAgent({
        ctx,
        slug,
      });
      let agent = runtimeAgent.agent;
      let overrideAlreadyHandled = false;
      if (!agent) {
        if (modelOverride) {
          const launched = await launchPersistedAgentWithOverride({
            ctx,
            slug,
            modelOverride,
            providerConnection: resolvedProviderConn,
            configurationLease,
          });
          if (launched) {
            agent = launched.agent;
            modelOverride = launched.resolvedModelId;
            overrideAlreadyHandled = true;
          }
        }
        if (!agent) {
          // A persisted agent that exists on disk but isn't active was almost
          // certainly dropped at registration because its model wouldn't
          // resolve. Return a specific 409 with that reason instead of a bare
          // 404 "Agent not found", so the CLI can print something actionable
          // rather than implying the agent doesn't exist (#chat).
          const unavailableReason = await resolveUnavailablePersistedAgent(
            ctx,
            slug,
          );
          if (unavailableReason) {
            if (unavailableReason.kind === 'redirect') {
              return c.json(
                {
                  success: false,
                  error: externalEngineChatRedirectMessage(slug),
                },
                409,
              );
            }
            return c.json(
              { success: false, error: unavailableReason.reason },
              409,
            );
          }
          return c.json({ success: false, error: 'Agent not found' }, 404);
        }
      }

      if (!overrideAlreadyHandled && !runtimeAgent.handledModelOverride) {
        const modelOverrideResult = await resolveChatAgentModelOverride({
          ctx,
          slug,
          modelOverride,
          agent,
          providerConnection: resolvedProviderConn,
          configurationLease,
        });
        if (modelOverrideResult.error) {
          const status = (modelOverrideResult.status || 500) as 400 | 409 | 500;
          return c.json(
            {
              success: false,
              error: modelOverrideResult.error,
            },
            status,
          );
        }
        agent = modelOverrideResult.agent;
        modelOverride = modelOverrideResult.resolvedModelId ?? modelOverride;
      }

      return streamPrimaryAgentChat({
        c,
        ctx,
        slug,
        plugin,
        input: input as string | ChatMessage[],
        ambientContext,
        restOptions,
        injectContext,
        ragContext,
        contextInjection,
        modelOverride,
        agent,
        configurationLease,
        projectSlug,
        // archive#1224 (offline): per-home-dir singleton so a replay
        // of the same clientTurnId (retry, or a flushed offline-queue turn)
        // is recognized even after a server restart — see chat-turn-dedup.ts.
        dedupStore: getChatTurnDedupStore(ctx.orchestrationEventStore),
        turnCorrelation,
        ...(nativeOutputGrant ? { nativeOutputGrant } : {}),
      });
    } catch (error: unknown) {
      ctx.logger.error('Chat error', { error });
      chatErrors.add(1, { agent: slug, plugin });
      const errMsg = errorMessage(error);
      const isCredentialError =
        errMsg.includes('credential') ||
        errMsg.includes('accessKeyId') ||
        errMsg.includes('secretAccessKey');
      const status =
        error instanceof RuntimeConfigurationConflictError
          ? 409
          : isCredentialError
            ? 401
            : 500;
      return c.json({ success: false, error: errMsg }, status);
    }
  });

  return app;
}

/**
 * Returns a concrete "not launchable" reason when `slug` names a persisted
 * agent that exists on disk but isn't currently active (registered) — the
 * signal for a 409 instead of a 404. Returns `null` when the slug names no
 * persisted agent (a genuine 404) or when the store can't be read. Reuses the
 * shared, network-free model-resolution probe so the reason matches what the
 * registration path swallowed; falls back to a generic message when the spec
 * resolves yet the agent still isn't active (#chat).
 */
/**
 * This route's inputs to the shared availability reader (#1536 D8 delta review
 * DM1). Exported because the MAPPING is what was wrong: the reader was correct
 * everywhere and this route fed it `RuntimeContext.appConfig`, the snapshot the
 * process booted with, so `/chat` answered 409 "Multiple enabled LLM provider
 * connections require an explicit default" until restart while the picker and
 * the inbox had already cleared. A test can now assert this adapter agrees with
 * the others rather than reaching through the HTTP surface for it.
 *
 * The `??` fallbacks preserve the pre-DM1 behaviour for a caller that threads
 * neither field — an older wiring, or a test — rather than making them
 * required and breaking it.
 */
export function chatStationEngineAvailabilitySource(
  ctx: ChatRuntimeContext,
): StationEngineAvailabilitySource {
  return {
    getLiveAppConfig: () => ctx.getLiveAppConfig?.() ?? ctx.appConfig,
    providerService: {
      listProviderConnections: () =>
        ctx.providerService.listProviderConnections(),
    },
    connectionService: {
      checkGatedModelConnectionIds: () =>
        ctx.checkGatedModelConnectionIds?.() ?? new Map(),
    },
  };
}

async function resolveUnavailablePersistedAgent(
  ctx: ChatRuntimeContext,
  slug: string,
): Promise<
  { kind: 'redirect' } | { kind: 'unavailable'; reason: string } | null
> {
  let spec: Awaited<ReturnType<typeof ctx.configLoader.loadAgent>> | undefined;
  try {
    spec = await ctx.configLoader.loadAgent(slug);
  } catch {
    spec = undefined;
  }

  // Registry defaults are real Agents but intentionally have no authored
  // Agent file. Resolve their explicit runtime binding from the same
  // registry-aware catalog used by GET /api/agents.
  //
  // The reserved Station identity goes through the same door even when its
  // file DOES load (archive#3662 delta H3): its engine binding lives on the
  // per-boot runtime projection and never on the record, and `ctx.listAgents`
  // is `AgentService.listAgents` — where that projection is applied. Reading
  // the file alone made this path answer "not currently launchable" for a
  // home whose Station identity is running on Codex, instead of the
  // external-engine redirect the honesty check below exists to give.
  if (
    (!spec || isStationAgentIdentity(slug)) &&
    ctx.listAgents &&
    ctx.getDefaultAgentIds
  ) {
    const defaults = await ctx.getDefaultAgentIds();
    const registryDefault = defaults.has(slug)
      ? await resolveRuntimeAgent(slug, {
          listAgents: ctx.listAgents,
          getDefaultAgentIds: ctx.getDefaultAgentIds,
        })
      : undefined;
    if (registryDefault) {
      const execution = registryDefault.execution?.agentConnectionId
        ? {
            ...registryDefault.execution,
            agentConnectionId: engineConnectionId(
              registryDefault.execution.agentConnectionId,
            ),
          }
        : undefined;
      spec = spec
        ? { ...spec, execution }
        : {
            name: registryDefault.name,
            prompt: '',
            execution,
          };
    }
  }

  if (!spec) {
    return null;
  }

  // archive#977: reuse the exact same honesty check `GET /api/agents`
  // applies (`enriched-agents.ts`'s `isHonestlyAvailableConnectedAgent`)
  // rather than re-deriving (and potentially diverging from) the same
  // rule here. Fails open on any lookup error or a missing
  // `connectionService` (older wiring/tests) — falls through to the
  // pre-existing Station-engine-only lens below, never fabricates a
  // redirect for an agent that might genuinely be Station-engine
  // unavailable.
  if (ctx.connectionService) {
    try {
      const connections = await ctx.connectionService.listRuntimeConnections();
      const runtimeConnectionsById = new Map<string, RuntimeConnectionSummary>(
        connections.map((connection) => [
          connection.id,
          {
            id: connection.id,
            type: connection.type,
            name: connection.name,
            status: connection.status,
            enabled: connection.enabled,
            engineId: parseEngineId(connection.config.engineId),
          },
        ]),
      );
      if (isHonestlyAvailableConnectedAgent(spec, runtimeConnectionsById)) {
        return { kind: 'redirect' };
      }
    } catch {
      // Fall through to the Station-engine lens below.
    }
  }

  // Delta review DM1: the one reader every availability surface goes through,
  // on live inputs. This site was the sixth caller and the last one still
  // building the call itself.
  const reason = createStationEngineAvailabilityReader(
    chatStationEngineAvailabilitySource(ctx),
  )(spec);
  return {
    kind: 'unavailable',
    reason: reason ?? `Agent '${slug}' is not currently launchable.`,
  };
}

/**
 * When a persisted agent failed to register because its default model
 * couldn't resolve against the live provider catalog, but the user has
 * selected a model override in the chat picker, launch a temp agent with
 * that override. This makes the picker the actual resolution path instead
 * of dead code for an unregistered agent.
 *
 * Returns `{ agent, resolvedModelId }` on success, or `null` when the
 * override also fails to validate (the caller falls through to the
 * specific `unavailableReason`).
 */
async function launchPersistedAgentWithOverride({
  ctx,
  slug,
  modelOverride,
  providerConnection,
  configurationLease,
}: {
  ctx: ChatRuntimeContext;
  slug: string;
  modelOverride: string;
  providerConnection:
    | import('@kontourai/station-contracts/tool').ProviderConnectionConfig
    | null
    | undefined;
  configurationLease: RuntimeConfigurationLease;
}): Promise<{ agent: unknown; resolvedModelId: string } | null> {
  let spec: Awaited<ReturnType<typeof ctx.configLoader.loadAgent>> | undefined;
  try {
    spec = await ctx.configLoader.loadAgent(slug);
  } catch {
    return null;
  }
  if (!spec) return null;

  const appConfig = ctx.appConfig;
  try {
    const model = await ctx.framework.createModel(
      {
        ...spec,
        execution: {
          ...spec.execution,
          modelId: modelOverride,
          ...(providerConnection?.id
            ? { modelConnectionId: providerConnection.id }
            : {}),
        },
      } as AgentSpec,
      {
        appConfig,
        projectHomeDir: ctx.configLoader.getProjectHomeDir(),
        modelCatalog: ctx.modelCatalog,
        listProviderConnections: () =>
          ctx.providerService.listProviderConnections(),
        dispatchEvidenceSource: ctx.dispatchEvidenceSource,
        logger: ctx.logger,
      },
    );
    requireCurrentRuntimeConfiguration(ctx, configurationLease);

    const memoryAdapter = new FileMemoryAdapter({
      projectHomeDir: ctx.configLoader.getProjectHomeDir(),
      usageAggregator: ctx.usageAggregator,
    });
    const agent = await ctx.framework.createTempAgent({
      name: slug,
      instructions: () => {
        const parts = [
          appConfig.systemPrompt
            ? ctx.replaceTemplateVariables(appConfig.systemPrompt)
            : '',
          spec.prompt ? ctx.replaceTemplateVariables(spec.prompt) : '',
        ].filter(Boolean);
        return parts.join('\n\n');
      },
      model,
      tools: [],
      maxSteps: resolveMaxSteps({
        defaultMaxTurns: appConfig.defaultMaxTurns,
      }),
      memoryAdapter,
    });
    requireCurrentRuntimeConfiguration(ctx, configurationLease);
    ctx.memoryAdapters.set(slug, memoryAdapter);

    return { agent, resolvedModelId: modelOverride };
  } catch (error) {
    if (error instanceof ManagedModelUnavailableError) return null;
    if (error instanceof RuntimeConfigurationConflictError) throw error;
    ctx.logger.debug('Override launch failed for persisted agent', {
      slug,
      modelOverride,
      error,
    });
    return null;
  }
}

async function resolveRuntimeChatAgent({
  ctx,
  slug,
}: {
  ctx: RuntimeContext;
  slug: string;
}) {
  return {
    agent:
      slug === 'station'
        ? ctx.activeAgents.get('default')
        : ctx.activeAgents.get(slug),
    handledModelOverride: false,
  };
}
