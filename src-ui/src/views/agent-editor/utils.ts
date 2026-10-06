import {
  mcpToolIdentities,
  selectedMcpTools,
} from '@kontourai/station-shared/mcp-tool-selection';
import type { Tool } from '../../types';
import type { AgentFormData } from './types';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildSystemPromptPrompt(form: AgentFormData): string {
  return `Write a system prompt for an AI agent named "${form.name}"${form.description ? ` described as: "${form.description}"` : ''}. Be specific and actionable. Output only the system prompt text.`;
}

export function getIntegrationToolKey(
  integrationId: string,
  tool: Pick<Tool, 'toolName' | 'name'>,
): string {
  return `${integrationId}_${tool.toolName || tool.name}`;
}

export function removeIntegration(
  form: AgentFormData,
  integrationId: string,
): AgentFormData {
  const prefix = `${integrationId}_`;
  const servers = new Set(form.tools.mcpServers);
  servers.delete(integrationId);
  return {
    ...form,
    toolsAvailableEdited: true,
    tools: {
      ...form.tools,
      mcpServers: [...servers],
      available: effectiveAgentToolPatterns(form).filter(
        (entry) => !entry.startsWith(prefix),
      ),
      autoApprove: form.tools.autoApprove.filter(
        (entry) => !entry.startsWith(prefix),
      ),
      unattendedAutoApprove: form.tools.unattendedAutoApprove.filter(
        (entry) => !entry.startsWith(prefix),
      ),
    },
  };
}

export function toggleIntegrationAutoApprove(
  form: AgentFormData,
  integrationId: string,
): AgentFormData {
  const prefix = `${integrationId}_`;
  const autoApprove = new Set(form.tools.autoApprove);
  if (autoApprove.has(`${prefix}*`)) {
    for (const entry of [...autoApprove]) {
      if (entry.startsWith(prefix)) {
        autoApprove.delete(entry);
      }
    }
  } else {
    autoApprove.add(`${prefix}*`);
  }
  return {
    ...form,
    tools: {
      ...form.tools,
      autoApprove: [...autoApprove],
    },
  };
}

function effectiveAgentToolPatterns(form: AgentFormData): string[] {
  if (form.tools.available.length > 0) return form.tools.available;
  return form.toolsOriginal?.available === undefined &&
    !form.toolsAvailableEdited
    ? ['*']
    : [];
}

export function addIntegration(
  form: AgentFormData,
  integrationId: string,
): AgentFormData {
  if (form.tools.mcpServers.includes(integrationId)) return form;
  const patterns = effectiveAgentToolPatterns(form);
  return {
    ...form,
    toolsAvailableEdited: true,
    tools: {
      ...form.tools,
      mcpMode:
        form.tools.mcpMode ??
        (form.toolsOriginal?.mcpServers === undefined ? 'add' : undefined),
      mcpServers: [...form.tools.mcpServers, integrationId],
      available: patterns.includes('*')
        ? [...form.tools.mcpServers, integrationId].map((id) => `${id}_*`)
        : [...patterns, `${integrationId}_*`],
    },
  };
}

export function canonicalAgentToolPatterns(
  form: AgentFormData,
  catalogs: Record<string, Tool[]>,
): string[] {
  const patterns = effectiveAgentToolPatterns(form);
  if (patterns.includes('*')) return patterns;
  const canonical = new Set<string>();
  for (const id of form.tools.mcpServers) {
    const tools = catalogs[id];
    if (!tools) continue;
    const selected = selectedMcpTools(
      id,
      tools.map((tool) => tool.toolName || tool.name),
      patterns,
      form.tools.mcpServers,
    );
    for (const name of selected === undefined ? ['*'] : selected)
      canonical.add(`${id}_${name}`);
  }
  for (const pattern of patterns) {
    if (
      !Object.entries(catalogs).some(
        ([id, tools]) =>
          pattern.startsWith(`${id}_`) ||
          pattern.startsWith(`${id}/`) ||
          tools.some((tool) =>
            mcpToolIdentities(id, tool.toolName || tool.name).some(
              (identity) =>
                identity === pattern ||
                (pattern.endsWith('*') &&
                  identity.startsWith(pattern.slice(0, -1))),
            ),
          ),
      )
    )
      canonical.add(pattern);
  }
  return [...canonical];
}

export function selectIntegrationTools(
  form: AgentFormData,
  integrationId: string,
  names: string[] | 'all',
  catalogs: Record<string, Tool[]> = {},
): AgentFormData {
  const canonical = canonicalAgentToolPatterns(form, catalogs);
  const normalized = {
    ...form,
    tools: { ...form.tools, available: canonical },
  };
  const added = addIntegration(normalized, integrationId);
  const prefix = `${integrationId}_`;
  const patterns = effectiveAgentToolPatterns(added);
  const existing = patterns.includes('*')
    ? added.tools.mcpServers.map((id) => `${id}_*`)
    : patterns;
  const available = existing.filter((entry) => !entry.startsWith(prefix));
  available.push(...(names === 'all' ? [`${prefix}*`] : names));
  return {
    ...added,
    toolsAvailableEdited: true,
    tools: {
      ...added.tools,
      available,
      autoApprove: [
        ...new Set(
          added.tools.autoApprove.flatMap((entry) => {
            if (names !== 'all' && entry === `${prefix}*`) return names;
            return !entry.startsWith(prefix) ||
              names === 'all' ||
              names.includes(entry)
              ? [entry]
              : [];
          }),
        ),
      ],
    },
  };
}

export function toggleIntegrationToolEnabled(
  form: AgentFormData,
  integrationId: string,
  toolKey: string,
  tools: Tool[],
  catalogs: Record<string, Tool[]> = { [integrationId]: tools },
): AgentFormData {
  const patterns = canonicalAgentToolPatterns(form, catalogs);
  const all = patterns.includes('*') || patterns.includes(`${integrationId}_*`);
  const enabled = new Set(
    all
      ? tools.map((tool) => getIntegrationToolKey(integrationId, tool))
      : patterns.filter((entry) => entry.startsWith(`${integrationId}_`)),
  );
  if (enabled.has(toolKey)) enabled.delete(toolKey);
  else enabled.add(toolKey);
  return selectIntegrationTools(form, integrationId, [...enabled], catalogs);
}

export function toggleIntegrationToolAutoApprove(
  form: AgentFormData,
  integrationId: string,
  toolKey: string,
  tools: Tool[],
): AgentFormData {
  const prefix = `${integrationId}_`;
  const autoApprove = new Set(form.tools.autoApprove);
  if (autoApprove.has(`${prefix}*`)) {
    autoApprove.delete(`${prefix}*`);
    for (const tool of tools) {
      const key = getIntegrationToolKey(integrationId, tool);
      if (key !== toolKey) {
        autoApprove.add(key);
      }
    }
  } else if (autoApprove.has(toolKey)) {
    autoApprove.delete(toolKey);
  } else {
    autoApprove.add(toolKey);
  }

  return {
    ...form,
    tools: {
      ...form.tools,
      autoApprove: [...autoApprove],
    },
  };
}
