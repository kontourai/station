import {
  type AgentHostAdapter,
  createInProcessHostAdapter,
  createStrandsAdapter,
  createVoltAgentAdapter,
  type HostCapabilities,
  type LifecycleEvent,
  type LifecycleOutcome,
} from '@kontourai/conduit';
import type {
  IAgentHooks,
  InvocationContext,
  ToolCallContext,
} from '../types.js';

type StationFrameworkKind = 'strands' | 'voltagent';

const unavailableInstall = Object.freeze({
  skill: 'unavailable',
  agent: 'unavailable',
  hook: 'unavailable',
  prompt: 'unavailable',
  command: 'unavailable',
  context: 'unavailable',
} as const);

/** Station's existing IAgentHooks projection, narrower than each host's full API. */
const stationFrameworkCapabilities: HostCapabilities = Object.freeze({
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

/**
 * Station's IAgentHooks projection as a Conduit in-process host adapter.
 *
 * Built by Conduit's own factory rather than hand-assembled: Conduit 0.8's
 * `probeHostConformance` only runs its inert (I/O-free) install path for
 * adapters a Conduit factory created, and refuses any other adapter with
 * `UnsafeConformanceProbeError` (`no-inert-install`). The factory also applies
 * Station's narrower capabilities to every outcome, so an unavailable phase
 * projects to `observe` and a `modelContext` is stripped on every phase (this
 * seam has no context-injection channel). The underlying framework adapter
 * still projects first, so a framework limit narrower than Station's survives.
 * Every install kind is `unavailable` and no `installAsset` is supplied:
 * Station registers no assets through this seam.
 */
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

  return createInProcessHostAdapter({
    id: `station-${framework}`,
    capabilities: stationFrameworkCapabilities,
    applyOutcome: (event, outcome) => host.project(event, outcome),
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
    // Context measurement observes a generation; it grants no Conduit lifecycle action.
    afterModelGeneration: hooks.afterModelGeneration,
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
    endInvocation: hooks.endInvocation
      ? (invocation) => hooks.endInvocation!(invocation)
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
