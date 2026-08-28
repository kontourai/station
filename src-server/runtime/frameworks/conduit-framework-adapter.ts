import {
  type AgentHostAdapter,
  createStrandsAdapter,
  createVoltAgentAdapter,
  type HostCapabilities,
  type LifecycleEvent,
  type LifecycleOutcome,
  type PortableAsset,
} from '@kontourai/conduit';
import type {
  IAgentHooks,
  InvocationContext,
  ToolCallContext,
} from '../types.js';

export type StationFrameworkKind = 'strands' | 'voltagent';

const unavailableInstall = Object.freeze({
  skill: 'unavailable',
  agent: 'unavailable',
  hook: 'unavailable',
  prompt: 'unavailable',
  command: 'unavailable',
  context: 'unavailable',
} as const);

/** Station's existing IAgentHooks projection, narrower than each host's full API. */
export function stationFrameworkCapabilities(
  _framework: StationFrameworkKind,
): HostCapabilities {
  return Object.freeze({
    lifecycle: Object.freeze({
      'session-start': 'unavailable',
      'before-model': 'unavailable',
      'before-tool': 'native',
      'after-tool': 'native',
      stop: 'approximated',
    }),
    contextInjection: 'unavailable',
    blocking: 'native',
    install: unavailableInstall,
  });
}

export function createStationFrameworkConduitAdapter(
  framework: StationFrameworkKind,
): AgentHostAdapter {
  const bridge = {
    applyOutcome: async (_event: LifecycleEvent, outcome: LifecycleOutcome) =>
      outcome,
  };
  const host =
    framework === 'strands'
      ? createStrandsAdapter(bridge)
      : createVoltAgentAdapter(bridge);
  const capabilities = stationFrameworkCapabilities(framework);

  return Object.freeze({
    id: `station-${framework}`,
    capabilities: () => capabilities,
    install: (assets: readonly PortableAsset[]) => host.install(assets),
    project: async (event: LifecycleEvent, outcome: LifecycleOutcome) => {
      if (capabilities.lifecycle[event.phase] === 'unavailable') {
        return Object.freeze({
          decision: 'observe',
          reason: `Station IAgentHooks does not expose ${event.phase}`,
        });
      }
      const projected = await host.project(event, outcome);
      // Station's IAgentHooks projection has no context-injection channel on
      // any phase (`contextInjection: 'unavailable'` above), but the
      // underlying strands/voltagent host adapter projects with the HOST's
      // own capabilities, which do admit context injection — so a
      // `modelContext` echoed through here would claim an influence this
      // seam does not deliver. Conduit 0.6.0's `context-<phase>` conformance
      // probes catch exactly that; strip it, mirroring conduit's own
      // projectLifecycleOutcome semantics.
      if (projected.modelContext !== undefined) {
        return Object.freeze({
          ...projected,
          modelContext: undefined,
          reason:
            projected.reason ??
            'Station IAgentHooks cannot inject model context',
        });
      }
      return projected;
    },
  });
}

function lifecycleEvent(
  phase: LifecycleEvent['phase'],
  invocation: InvocationContext,
  context?: Readonly<Record<string, unknown>>,
): LifecycleEvent {
  return {
    phase,
    sessionId:
      invocation.conversationId ?? invocation.traceId ?? invocation.agentSlug,
    context: { agentSlug: invocation.agentSlug, ...context },
  };
}

/**
 * Projects Station's existing hooks through Conduit without registering a
 * second hook layer. Station still evaluates approvals, policy, usage, memory,
 * and canonical events; Conduit only characterizes the host influence.
 */
export function conformAgentHooks(
  framework: StationFrameworkKind,
  hooks?: IAgentHooks,
): IAgentHooks | undefined {
  if (!hooks) return undefined;
  const adapter = createStationFrameworkConduitAdapter(framework);
  return {
    beforeToolCall: hooks.beforeToolCall
      ? async (tool, invocation) => {
          const decision = await hooks.beforeToolCall!(tool, invocation);
          // Any non-`true` result is a denial (archive#1834): a
          // ToolCallDenial object is truthy, so never branch on truthiness.
          const allowed = decision === true;
          const projected = await adapter.project(
            lifecycleEvent('before-tool', invocation, {
              toolName: tool.toolName,
              toolCallId: tool.toolCallId,
            }),
            {
              decision: allowed ? 'allow' : 'deny',
              reason: allowed
                ? undefined
                : typeof decision === 'object'
                  ? decision.reason
                  : 'Station policy denied tool execution',
            },
          );
          // Pass the station denial through unchanged so its reason survives
          // to the framework adapter's surfaced error.
          if (!allowed) return decision;
          return projected.decision !== 'deny';
        }
      : undefined,
    afterToolCall: hooks.afterToolCall
      ? (tool, result, invocation) => {
          hooks.afterToolCall!(tool, result, invocation);
          void adapter.project(
            lifecycleEvent('after-tool', invocation, toolContext(tool)),
            { decision: 'observe' },
          );
        }
      : undefined,
    afterInvocation: hooks.afterInvocation
      ? async (context) => {
          await hooks.afterInvocation!(context);
          await adapter.project(
            lifecycleEvent('stop', context.invocation, {
              toolCallCount: context.toolCallCount,
              failed: Boolean(context.error),
            }),
            { decision: 'observe' },
          );
        }
      : undefined,
  };
}

function toolContext(tool: ToolCallContext): Readonly<Record<string, unknown>> {
  return { toolName: tool.toolName, toolCallId: tool.toolCallId };
}
