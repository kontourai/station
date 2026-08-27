import {
  STATION_TASK_BASIS_MCP_TOOL_NAME,
  STATION_TASK_BASIS_MCP_TOOL_REF,
} from '@kontourai/station-basis-pane/task-basis-mcp-app';
import { resolveWorkspaceBasisMcpPaneOccurrence } from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import { useMemo } from 'react';
import { MCPToolUIFrame } from '../components/mcp-ui/MCPToolUIFrame';
import type { BuiltinWorkspacePaneProps } from './builtinWorkspacePaneRegistry';
import { trackMcpAppDisplayModeDecision } from './mcpAppDisplayModeTelemetry';
import type { WorkspacePaneHostPanePresentation } from './WorkspacePaneHostTabs';

export function BasisMcpWorkspacePane({
  descriptor,
  instance,
  presentation,
}: {
  descriptor?: BuiltinWorkspacePaneProps['descriptor'];
  instance: BuiltinWorkspacePaneProps['instance'];
  presentation?: WorkspacePaneHostPanePresentation;
}) {
  const instanceKey = JSON.stringify(instance);
  const occurrence = useMemo(
    () =>
      resolveWorkspaceBasisMcpPaneOccurrence(
        JSON.parse(instanceKey) as BuiltinWorkspacePaneProps['instance'],
      ),
    [instanceKey],
  );
  const component = useMemo(
    () =>
      occurrence?.descriptor.renderer.kind === 'mcp-tool-ui'
        ? occurrence.descriptor.renderer
        : null,
    [occurrence],
  );
  const basisReadSession = useMemo(() => {
    const taskId = instance.boundContext?.taskId;
    return component?.ref === STATION_TASK_BASIS_MCP_TOOL_REF && taskId
      ? {
          serverId: 'station-control' as const,
          toolName: STATION_TASK_BASIS_MCP_TOOL_NAME as 'get_task_basis',
          taskId,
        }
      : undefined;
  }, [component?.ref, instance.boundContext?.taskId]);
  if (
    !occurrence ||
    (descriptor && descriptor.id !== occurrence.descriptor.id) ||
    !component
  )
    return <section role="alert">Basis App identity is unavailable.</section>;
  return (
    <MCPToolUIFrame
      component={component}
      basisReadSession={basisReadSession}
      paneIdentity={{
        descriptorId: instance.descriptorId,
        instanceId: instance.instanceId,
        stateKey: instance.stateKey,
      }}
      currentDisplayMode={presentation?.displayMode}
      hostAvailableDisplayModes={presentation?.availableDisplayModes}
      onRequestDisplayMode={presentation?.requestDisplayMode}
      onDisplayModeDecision={trackMcpAppDisplayModeDecision}
    />
  );
}
