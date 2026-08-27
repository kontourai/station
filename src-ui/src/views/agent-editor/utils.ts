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
    tools: {
      ...form.tools,
      mcpServers: [...servers],
      available: form.tools.available.filter(
        (entry) => !entry.startsWith(prefix),
      ),
      autoApprove: form.tools.autoApprove.filter(
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

export function toggleIntegrationToolEnabled(
  form: AgentFormData,
  integrationId: string,
  toolKey: string,
  tools: Tool[],
): AgentFormData {
  const prefix = `${integrationId}_`;
  const available = new Set(form.tools.available);
  const hasExplicit = [...available].some((entry) => entry.startsWith(prefix));

  if (!hasExplicit || available.has(`${prefix}*`)) {
    available.delete(`${prefix}*`);
    if (!hasExplicit) {
      for (const tool of tools) {
        const key = getIntegrationToolKey(integrationId, tool);
        if (key !== toolKey) {
          available.add(key);
        }
      }
    } else {
      for (const tool of tools) {
        const key = getIntegrationToolKey(integrationId, tool);
        if (key !== toolKey) {
          available.add(key);
        }
      }
    }
  } else if (available.has(toolKey)) {
    available.delete(toolKey);
  } else {
    available.add(toolKey);
  }

  const autoApprove = new Set(form.tools.autoApprove);
  if (!available.has(toolKey)) {
    autoApprove.delete(toolKey);
  }

  return {
    ...form,
    tools: {
      ...form.tools,
      available: [...available],
      autoApprove: [...autoApprove],
    },
  };
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
