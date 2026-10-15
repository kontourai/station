import {
  mcpToolApprovalKey,
  mcpToolIdentities,
  resolveAuthoredToolApproval,
} from '@kontourai/station-shared/mcp-tool-selection';
import type { Tool } from '../../types';
import type { AgentFormData } from './types';
import { getIntegrationToolKey, setIntegrationToolApproval } from './utils';

export function AgentToolApproval({
  form,
  setForm,
  integrationId,
  tool,
  tools,
  engineId,
  disabled,
}: {
  form: AgentFormData;
  setForm: React.Dispatch<React.SetStateAction<AgentFormData>>;
  integrationId: string;
  tool: Tool;
  tools: Tool[];
  engineId: string;
  disabled?: boolean;
}) {
  if (!['station', 'claude'].includes(engineId))
    return <span className="editor-hint">Engine controlled</span>;
  const name = tool.toolName || tool.name;
  const value =
    resolveAuthoredToolApproval(
      mcpToolIdentities(integrationId, name),
      form.tools.autoApprove,
      form.tools.askBeforeUse,
      mcpToolApprovalKey(integrationId, name),
    ) ?? 'default';
  return (
    <select
      className="editor-select agent-tool-picker__approval"
      aria-label={`Approval for ${tool.title || name}`}
      value={value}
      disabled={disabled}
      onChange={(event) =>
        setForm((current) =>
          setIntegrationToolApproval(
            current,
            integrationId,
            getIntegrationToolKey(integrationId, tool),
            event.target.value === 'always' ? 'always' : 'ask',
            tools,
          ),
        )
      }
    >
      {value === 'default' && <option value="default">Engine default</option>}
      <option value="ask">Ask me</option>
      <option value="always">Always allow</option>
    </select>
  );
}
