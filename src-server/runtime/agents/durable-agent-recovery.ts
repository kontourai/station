import type { AgentTurnLease } from '@kontourai/agent-runtime';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { StationAgentAdapter } from '../../providers/adapters/station-agent-adapter.js';
import { runtimeAgentKey } from '../../services/agents/runtime-agent-identity.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { builtinStationAgentSpec } from '../../services/orchestration/session-agent-resolution.js';
import type { Logger } from '../../utils/logger.js';
import { runWithAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import {
  createNativeExecutionWorkspace,
  runWithNativeExecutionWorkspace,
} from '../conversation/native-execution-workspace.js';
import {
  createElicitationCallback,
  createStreamingPipeline,
  writeSSEChunk,
} from '../conversation/stream-orchestrator.js';
import { stripOutputDeclarationHandles } from '../native-output-declaration.js';
import {
  closeNativeOutputTurnContext,
  runWithNativeOutputTurnContext,
} from '../native-output-turn-grant.js';
import { InjectableStream } from '../streaming/InjectableStream.js';
import type { MCPToolNameMappingEntry } from '../tools/mcp-tool-names.js';
import type { createAgentHooks } from './agent-hooks.js';
import {
  createDurableFrameKeys,
  encodeDurableAgentFrame,
} from './durable-agent-lifecycle.js';
import type { stationAgentRuntimeOwner } from './durable-agent-owner.js';
import { bindDurableApprovalObserver } from './durable-agent-tools.js';

/** Rebuilds host scopes around the existing framework loop after a fenced takeover. */
export function configureDurableAgentRecovery(options: {
  owner: ReturnType<typeof stationAgentRuntimeOwner>;
  adapter: StationAgentAdapter;
  orchestration: OrchestrationService;
  preview: FeaturePreviewSelector;
  approvalRegistry: ApprovalRegistry;
  agentHooks?: Map<string, unknown>;
  agentSpecs: Map<string, AgentSpec>;
  toolNameMapping: Map<string, unknown>;
  logger: Logger;
}) {
  const { owner, adapter, orchestration } = options;
  const failed = (error: unknown) =>
    options.logger.error('Durable Station turn failed', { error });
  owner.configure({
    preview: options.preview,
    recoveryReady: (input) =>
      !!input.correlation &&
      adapter.canRecoverDurableTurn(
        input.correlation.sessionId,
        input.correlation.turnId,
      ),
    reconcile: (input, turnId) => {
      if (!input.correlation || !input.kernelInvocationId)
        throw new Error('The original invocation is unavailable.');
      const threadId = input.correlation.sessionId;
      adapter.beginDurableRecovery(threadId, turnId, input.kernelInvocationId);
      if (
        input.startEvent &&
        !orchestration.publishDurableStationEvent(input.startEvent)
      )
        throw new Error('The recorded start was not persisted.');
      for (const frame of owner.frames(threadId, turnId))
        adapter.observeDurableWire(
          threadId,
          turnId,
          encodeDurableAgentFrame(turnId, frame),
          input.kernelInvocationId,
        );
      adapter.reconcileDurableTerminal(
        threadId,
        turnId,
        input.kernelInvocationId,
      );
    },
    failed,
    authorize: async (input) => {
      if (!input.correlation) return;
      if (typeof input.options.userId !== 'string')
        throw new Error('The durable user is unavailable.');
      await orchestration.authorizeDurableStationTurn({
        threadId: input.correlation.sessionId,
        turnId: input.correlation.turnId,
        userId: input.options.userId,
        workspaceRoot: input.workspaceRoot,
      });
    },
    onApproval: (input, id) => {
      if (input.correlation)
        adapter.reconcileDurableApproval(
          input.correlation.sessionId,
          input.correlation.turnId,
          id,
          input.kernelInvocationId,
        );
    },
    onWire: (input, turnId, wire) => {
      if (input.correlation)
        adapter.observeDurableWire(
          input.correlation.sessionId,
          turnId,
          wire,
          input.kernelInvocationId,
        );
    },
  });
  const finalizers = new WeakMap<AgentTurnLease, () => void>();
  owner.registerRecovery(
    async (lease) => {
      const input = owner.descriptor(lease.input);
      const { conversationId, invocationId: turnId } = lease.key;
      if (
        !input.correlation ||
        !input.kernelInvocationId ||
        !input.startEvent ||
        typeof input.options.userId !== 'string'
      )
        throw new Error(
          'Recovery requires the recorded native invocation identity.',
        );
      if (!adapter.canRecoverDurableTurn(conversationId, turnId))
        throw new Error('The native Session is not ready for recovery.');
      adapter.beginDurableRecovery(
        conversationId,
        turnId,
        input.kernelInvocationId,
      );
      if (!orchestration.publishDurableStationEvent(input.startEvent))
        throw new Error('The original turn start could not be persisted.');
      const workspace = createNativeExecutionWorkspace(input.workspaceRoot);
      const nativeOutput = input.nativeOutput
        ? await orchestration.recoverDurableNativeOutput({
            facts: input.nativeOutput,
            userId: input.options.userId,
            configurationLease: input.definition,
            current: () => owner.isCurrent(lease),
          })
        : undefined;
      const injections = new InjectableStream();
      const spec =
        options.agentSpecs.get(runtimeAgentKey(input.slug)) ??
        builtinStationAgentSpec(input.slug);
      if (!spec)
        throw new Error('The original agent configuration is unavailable.');
      const elicitation = createElicitationCallback(
        spec,
        options.toolNameMapping as Map<string, MCPToolNameMappingEntry>,
        options.approvalRegistry,
        injections,
        options.logger,
        () => conversationId,
        conversationId,
      );
      const hooks = options.agentHooks?.get(runtimeAgentKey(input.slug)) as
        | ReturnType<typeof createAgentHooks>
        | undefined;
      const release = hooks?.registerApprovalRequester(
        conversationId,
        async (tool) =>
          !!(await elicitation({ type: 'tool-approval', ...tool })),
      );
      finalizers.set(lease, () => {
        release?.();
        workspace.close();
        if (nativeOutput) closeNativeOutputTurnContext(nativeOutput);
      });
      bindDurableApprovalObserver(lease, (id) =>
        adapter.reconcileDurableApproval(
          conversationId,
          turnId,
          id,
          input.kernelInvocationId,
        ),
      );
      for (const frame of owner.frames(conversationId, turnId))
        adapter.observeDurableWire(
          conversationId,
          turnId,
          encodeDurableAgentFrame(turnId, frame),
          input.kernelInvocationId,
        );
      const frameKey = createDurableFrameKeys();
      const replay = () =>
        runWithNativeExecutionWorkspace(workspace, () =>
          owner.replay(lease, async (result) => {
            const pipeline = createStreamingPipeline(lease.signal, undefined, {
              slug: input.slug,
              conversationId,
              userId: input.options.userId as string,
              traceId: String(input.options.traceId ?? turnId),
            });
            const writer = {
              write: async (wire: string) => {
                if (JSON.parse(wire.slice(6)).type === 'finish') return;
                const frame = await lease.frame(frameKey(wire), wire);
                adapter.observeDurableWire(
                  conversationId,
                  turnId,
                  encodeDurableAgentFrame(turnId, frame),
                  input.kernelInvocationId,
                );
              },
            };
            for await (const chunk of pipeline.run(
              stripOutputDeclarationHandles(injections.wrap(result.fullStream)),
            )) {
              if (chunk.type === 'error')
                throw new Error(
                  'The recovered model outcome is indeterminate.',
                );
              await writeSSEChunk(writer, chunk);
            }
            await pipeline.finalize();
          }),
        );
      await runWithAuthorizedTurnCorrelation(
        input.correlation,
        () =>
          nativeOutput
            ? runWithNativeOutputTurnContext(nativeOutput, replay)
            : replay(),
        undefined,
        undefined,
        input.mcpPromptOrigin,
      );
    },
    failed,
    (lease) => {
      try {
        adapter.reconcileDurableTerminal(
          lease.key.conversationId,
          lease.key.invocationId,
          owner.descriptor(lease.input).kernelInvocationId,
        );
      } finally {
        finalizers.get(lease)?.();
        finalizers.delete(lease);
      }
    },
  );
}
