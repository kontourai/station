import { resolve } from 'node:path';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import type { TurnProvenanceContextInjection } from '@kontourai/station-contracts/turn-provenance-context';
import type { RuntimeContext } from '../../runtime/types.js';
import {
  type AgentPolicyService,
  getAgentPolicyService,
} from '../../services/agents/agent-policy-service.js';
import { stationWorkflowActorKey } from '../../services/evidence/orchestration-workflow-sidecar.js';
import { expandTilde } from '../../utils/paths.js';
import { errorMessage } from '../schemas/schemas.js';
import { injectUserProfileContext } from './chat-context.js';
import {
  approxInjectedTokens,
  boundContextSources,
} from './chat-context-injection.js';

export interface ChatMessage {
  role: string;
  parts?: Array<{
    type: string;
    text?: string;
    url?: string;
    mediaType?: string;
  }>;
}

interface PrepareChatRequestContext {
  ctx: Pick<
    RuntimeContext,
    | 'providerService'
    | 'knowledgeService'
    | 'feedbackService'
    | 'storageAdapter'
    | 'logger'
    | 'activeAgents'
    // station#2652: read-only, for the first-run `[USER PROFILE]` block.
    // `chat.ts` already passes the full context, and `RuntimeContext.appConfig`
    // is re-assigned on every config reload, so this stays fresh without a
    // per-turn file read.
    | 'appConfig'
  >;
  slug: string;
  input: string | ChatMessage[];
  options: Record<string, any>;
  projectSlug?: string;
  /** Test seam; defaults to the shared service. */
  agentPolicyService?: AgentPolicyService;
}

export async function prepareChatRequest(
  context: PrepareChatRequestContext,
): Promise<{
  options: Record<string, any>;
  resolvedProviderConn: ProviderConnectionConfig | null;
  injectContext: string | null;
  ragContext: string | null;
  /**
   * station#2649: what this preparation actually composed, recorded block by
   * block AS each string is built (one derivation per block — the receipt
   * cannot name context this function did not inject). The stream layer adds
   * its own conversation-feedback block and emits the finished record.
   */
  contextInjection: TurnProvenanceContextInjection;
}> {
  const options = { ...context.options };
  let resolvedProviderConn: ProviderConnectionConfig | null = null;
  const contextInjection: TurnProvenanceContextInjection = {};

  // Resolve provider-managed bindings even for an already-active Station
  // agent. The route passes the resolved connection and model into
  // resolveChatAgentModelOverride(), which rebuilds a temporary agent through
  // the common model factory while retaining the original tools. Skipping this
  // for active agents makes a session override visible in the UI but inert at
  // execution time.
  if (options.providerManagedFallback) {
    try {
      const resolved = await context.ctx.providerService.resolveProvider({
        conversationProviderId:
          typeof options.providerId === 'string'
            ? options.providerId
            : undefined,
        conversationModel:
          typeof options.providerModel === 'string'
            ? options.providerModel
            : typeof options.model === 'string'
              ? options.model
              : undefined,
        projectSlug: context.projectSlug,
        // station#1288: the station-agent relay (station-agent-adapter.ts's
        // sendTurn) has a model override but no providerId to pair with it —
        // neither ProviderSessionStartInput nor ProviderSendTurnInput carries
        // one. Let a lone model apply against the same default connection
        // the no-override path below would pick, instead of the pairing
        // guard's "must be supplied together" rejection.
        allowModelOnlyFallback: true,
      });
      if (resolved.model) {
        options.model = resolved.model;
      }
      if (resolved.providerId) {
        options.providerId = resolved.providerId;
      }
      if (resolved.providerId) {
        const connections =
          context.ctx.providerService.listProviderConnections();
        resolvedProviderConn =
          connections.find(
            (connection) => connection.id === resolved.providerId,
          ) ?? null;
      }
    } catch (err: unknown) {
      if (options.providerManagedFallback) {
        throw err;
      }
      context.ctx.logger.warn('Failed to resolve chat provider', {
        projectSlug: context.projectSlug,
        error: errorMessage(err),
      });
    }
  }

  let injectContext: string | null = null;
  if (context.projectSlug) {
    try {
      injectContext = await context.ctx.knowledgeService.getInjectContext(
        context.projectSlug,
      );
      if (injectContext) {
        contextInjection.projectRules = {
          approxTokens: approxInjectedTokens(injectContext),
        };
      }
    } catch (err: unknown) {
      context.ctx.logger.debug('Inject context retrieval failed', {
        projectSlug: context.projectSlug,
        error: errorMessage(err),
      });
    }
  }

  let ragContext: string | null = null;
  if (context.projectSlug) {
    try {
      const userMessage = extractChatUserText(context.input);
      if (userMessage) {
        const ragDetailed =
          await context.ctx.knowledgeService.getRAGContextDetailed(
            context.projectSlug,
            userMessage,
          );
        if (ragDetailed) {
          ragContext = ragDetailed.context;
          contextInjection.knowledge = {
            chunkCount: ragDetailed.chunkCount,
            ...boundContextSources(ragDetailed.sources),
            approxTokens: approxInjectedTokens(ragDetailed.context),
          };
        }
      }
    } catch (err: unknown) {
      context.ctx.logger.debug('RAG context retrieval failed', {
        projectSlug: context.projectSlug,
        error: errorMessage(err),
      });
    }
  }

  const feedbackGuidelines =
    context.ctx.feedbackService.getBehaviorGuidelinesDetailed();
  if (feedbackGuidelines) {
    ragContext = ragContext
      ? `${ragContext}\n\n${feedbackGuidelines.text}`
      : feedbackGuidelines.text;
    contextInjection.guidelines = {
      reinforce: feedbackGuidelines.reinforce,
      avoid: feedbackGuidelines.avoid,
      approxTokens: approxInjectedTokens(feedbackGuidelines.text),
    };
  }

  // Flow Agents workflow-steering (S3): managed agents get the canonical
  // ambient steering for the project workspace's `.flow-agents` state,
  // composed exactly like the feedback guidelines above. Fail-open.
  if (context.projectSlug) {
    try {
      const project = context.ctx.storageAdapter.getProject(
        context.projectSlug,
      );
      // EXPAND: this reaches flowAgentsRoot(cwd) -> statSync, and the opt-in
      // check is FAIL-OPEN — a `~/…` path threw, was read as "not opted in", and
      // Flow-Agents steering was silently never injected into any chat context
      // for a tilde-configured project (station#3155). Nothing surfaced.
      const workspaceCwd = project?.workingDirectory
        ? resolve(expandTilde(project.workingDirectory))
        : undefined;
      if (workspaceCwd) {
        const policyService =
          context.agentPolicyService ??
          getAgentPolicyService(context.ctx.logger);
        const conversationId =
          typeof options.conversationId === 'string' && options.conversationId
            ? options.conversationId
            : undefined;
        const steering = policyService.steeringContext(
          {
            cwd: workspaceCwd,
            ...(conversationId
              ? { actorKey: stationWorkflowActorKey(conversationId) }
              : {}),
          },
          { runtimeKind: 'managed' },
        );
        if (steering) {
          ragContext = ragContext ? `${ragContext}\n\n${steering}` : steering;
          contextInjection.workflowSteering = {
            approxTokens: approxInjectedTokens(steering),
          };
        }
      }
    } catch (err: unknown) {
      context.ctx.logger.debug('Workflow steering context skipped', {
        projectSlug: context.projectSlug,
        error: errorMessage(err),
      });
    }
  }

  // station#2652 chapter 2: the first-run "About you" answers, composed like
  // every block above. Returns `ragContext` unchanged when the user skipped
  // the questions — see `injectUserProfileContext` for why no default User Profile
  // is ever substituted, and why this reaches Station's engine only.
  ragContext = injectUserProfileContext(
    context.ctx.appConfig?.userProfile,
    ragContext,
  );

  return {
    options,
    resolvedProviderConn,
    injectContext,
    ragContext,
    contextInjection,
  };
}

export function extractChatUserText(input: string | ChatMessage[]): string {
  if (typeof input === 'string') {
    return input;
  }

  if (!Array.isArray(input)) {
    return '';
  }

  return (
    input
      .find((message) => message.role === 'user')
      ?.parts?.find((part) => part.type === 'text')?.text || ''
  );
}
