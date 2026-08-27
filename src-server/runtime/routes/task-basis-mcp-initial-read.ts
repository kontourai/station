import { parseTaskTurnReference } from '@kontourai/station-contracts';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { McpUiCallDeps } from '../../routes/agents/tools.js';
import type { TaskBasisQueryModule } from '../../services/projects/task-basis-module.js';
import {
  buildStationBasisProjectionToolResult,
  buildStationBasisUnavailableToolResult,
  parseStationBasisToolInput,
  STATION_BASIS_MCP_SERVER_ID,
  STATION_BASIS_MCP_TOOL_NAME,
} from '../../tools/station-control-basis-tools.js';

type TaskReferenceGraph = {
  readTaskTurnReferenceScope(taskId: string): { projectId: string } | null;
  readTaskTurnReferenceLinks(
    taskId: string,
  ): readonly { id: unknown; targetId: unknown }[] | null;
};

/**
 * Reauthorizes a Task Basis MCP result after its owner read. The public MCP
 * route owns tool discovery and body validation; this seam owns only the
 * private Task/session facts that can change while the query is pending.
 */
export function createTaskBasisMcpInitialRead(input: {
  taskBasis: TaskBasisQueryModule;
  taskGraph: TaskReferenceGraph;
  authorityForRequest(request: Request): SessionReadAuthority;
  isRequestPrincipalCurrent(request: Request): boolean;
  canReadSession(sessionId: string, authority: SessionReadAuthority): boolean;
}): NonNullable<McpUiCallDeps['readInitialMcpAppResult']> {
  return async ({ serverId, toolName, arguments: rawArguments, request }) => {
    if (
      serverId !== STATION_BASIS_MCP_SERVER_ID ||
      toolName !== STATION_BASIS_MCP_TOOL_NAME
    )
      return undefined;
    const toolInput = parseStationBasisToolInput(rawArguments);
    if (toolInput?.scope !== 'task-answer') return undefined;
    const authority = input.authorityForRequest(request);
    if (authority.mode === 'hosted')
      return buildStationBasisUnavailableToolResult(true);
    const taskScope = input.taskGraph.readTaskTurnReferenceScope(
      toolInput.taskId,
    );
    const taskLinks = input.taskGraph.readTaskTurnReferenceLinks(
      toolInput.taskId,
    );
    const selectedLinks = taskLinks?.filter(
      (link) => link.id === toolInput.answerReferenceId,
    );
    if (
      !taskScope ||
      !taskLinks ||
      !selectedLinks ||
      selectedLinks.length === 0 ||
      selectedLinks.some(
        (link) => !parseTaskTurnReference(String(link.targetId)),
      )
    )
      return buildStationBasisUnavailableToolResult();
    const outcome = await input.taskBasis.read({
      taskId: toolInput.taskId,
      answerReferenceId: toolInput.answerReferenceId,
      authority,
    });
    const currentScope = input.taskGraph.readTaskTurnReferenceScope(
      toolInput.taskId,
    );
    const currentLinks = input.taskGraph.readTaskTurnReferenceLinks(
      toolInput.taskId,
    );
    const sameLinks =
      currentLinks !== null &&
      currentLinks !== undefined &&
      currentLinks.length === taskLinks.length &&
      currentLinks.every(
        (link, index) =>
          link.id === taskLinks[index]?.id &&
          link.targetId === taskLinks[index]?.targetId,
      );
    const sessionsCurrent = selectedLinks.every((link) => {
      const tuple = parseTaskTurnReference(String(link.targetId));
      return tuple !== null && input.canReadSession(tuple.sessionId, authority);
    });
    if (
      !input.isRequestPrincipalCurrent(request) ||
      currentScope?.projectId !== taskScope.projectId ||
      !sameLinks ||
      !sessionsCurrent
    )
      return buildStationBasisUnavailableToolResult();
    return outcome.status === 'found'
      ? buildStationBasisProjectionToolResult(outcome.data)
      : buildStationBasisUnavailableToolResult(
          outcome.status === 'unavailable',
        );
  };
}
