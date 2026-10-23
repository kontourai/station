import { agentId } from '@kontourai/station-contracts/agent-identity';
import { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { AgentService } from '../../services/agents/agent-service.js';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../../services/execution-target/execution-target-resolver.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { SessionCommandContext } from '../../services/orchestration/session-command-module.js';
import type {
  ProjectRoomAgentCapture,
  ProjectRoomAgentExecution,
} from '../../services/projects/project-room-agent-module.js';
import { canonicalPath } from '../../utils/path-containment.js';

/** Parent supplies server action authority and owner attribution; no Task or private-chat route participates. */
export function projectRoomAgentExecution(deps: {
  agents: Pick<AgentService, 'getAgent'>;
  executionTargets: ExecutionTargetResolverDependencies;
  sessions: Pick<
    OrchestrationService,
    'startSessionInternal' | 'dispatch' | 'readSession' | 'sessionQueries'
  >;
  authorityForOwner(ownerId: string): SessionReadAuthority;
  commandContext(ownerId: string): SessionCommandContext;
  assertExecutionRoot(capture: ProjectRoomAgentCapture): Promise<void>;
}): ProjectRoomAgentExecution {
  const definition = async (id: string, executionRoot: string) => {
    const spec = await deps.agents.getAgent(id);
    const target = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId(id),
        workspace: { kind: 'directory', cwd: executionRoot },
      },
      deps.executionTargets,
    );
    if (target.access.kind !== 'current')
      throw new Error('Project room Agent environment unavailable');
    return { spec, target };
  };
  const checkRoot = (capture: ProjectRoomAgentCapture, recheck: () => void) => {
    recheck();
    if (canonicalPath(capture.executionRoot) !== capture.executionRoot)
      throw new Error('Project room execution root changed');
  };
  return {
    async prepare(agentId, authority) {
      return {
        label: (await definition(agentId, authority.executionRoot)).spec.name,
      };
    },
    async launch(capture, recheck, refresh) {
      await deps.assertExecutionRoot(capture);
      const { target } = await definition(
        capture.agentId,
        capture.executionRoot,
      );
      await refresh?.();
      checkRoot(capture, recheck);
      const context = deps.commandContext(capture.requester.id);
      const receiverExecutionAdmission = {
        recheck: async () => {
          await deps.assertExecutionRoot(capture);
          await refresh?.();
          checkRoot(capture, recheck);
        },
      };
      const outcome = await deps.sessions.startSessionInternal(
        {
          type: 'start-session',
          input: {
            threadId: capture.sessionId,
            provider: target.provider,
            cwd: capture.executionRoot,
            persistSession: true,
            ...(target.modelId ? { modelId: target.modelId } : {}),
            ...(target.modelOptions
              ? { modelOptions: { ...target.modelOptions } }
              : {}),
            metadata: {
              userId: capture.requester.id,
              agentSlug: capture.agentId,
              executionAgentId: target.executionAgentId ?? capture.agentId,
              ...(target.engine.kind === 'connection'
                ? { connectionId: target.engine.connectionId }
                : {}),
              projectSlug: capture.scope.localProjectSlug,
            },
          },
        },
        {
          ...context,
          dispatchCwdAdmission: {
            recheck(directory) {
              checkRoot(capture, recheck);
              if (
                !directory ||
                canonicalPath(directory) !== capture.executionRoot
              )
                throw new Error('Project room execution root changed');
              return capture.executionRoot;
            },
          },
        },
        { commandId: capture.correlationId, receiverExecutionAdmission },
      );
      if (outcome.status !== 'accepted')
        throw new Error('Project room agent launch unavailable');
      checkRoot(capture, recheck);
      await deps.sessions.dispatch(
        {
          type: 'sendTurn',
          input: {
            threadId: capture.sessionId,
            input: capture.context,
            clientTurnId: capture.correlationId,
          },
        },
        context,
        { receiverExecutionAdmission },
      );
    },
    async answer(capture) {
      await deps.assertExecutionRoot(capture);
      const authority = deps.authorityForOwner(capture.requester.id);
      const session = await deps.sessions.readSession(
        capture.sessionId,
        authority,
      );
      if (!session) return null;
      const started = session.events.find(
        (e) =>
          e.method === 'turn.started' &&
          e.clientTurnId === capture.correlationId,
      );
      if (
        started?.turnId &&
        session.events.some(
          (e) =>
            e.turnId === started.turnId &&
            (e.method === 'turn.aborted' ||
              (e.method === 'runtime.error' &&
                !isDeferredRetriableTurnError(e))),
        )
      )
        return { failed: true };
      if (
        !started?.turnId ||
        !session.events.some(
          (e) =>
            e.method === 'turn.completed' &&
            e.turnId === started.turnId &&
            e.finishReason !== 'cancelled',
        )
      )
        return null;
      const answer = await deps.sessions.sessionQueries.readAssistantTurn(
        {
          type: 'assistant-turn',
          threadId: capture.sessionId,
          turnId: started.turnId,
        },
        authority,
      );
      if (answer.status !== 'found') return null;
      await deps.assertExecutionRoot(capture);
      const text = answer.message.parts
        .flatMap((p) => (p.type === 'text' ? [p.text] : []))
        .join('\n');
      return text.trim() ? { turnId: started.turnId, text } : null;
    },
    async cancel(capture) {
      await deps.sessions.dispatch(
        { type: 'interruptTurn', threadId: capture.sessionId },
        deps.commandContext(capture.requester.id),
      );
    },
  };
}
