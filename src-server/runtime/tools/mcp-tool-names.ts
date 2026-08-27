import type { Tool } from '@voltagent/core';
import {
  normalizeToolName,
  parseToolName,
} from '../../utils/tool-name-normalizer.js';

export interface MCPToolNameMappingEntry {
  original: string;
  normalized: string;
  server: string | null;
  tool: string;
}

export function normalizeLoadedMCPTools(
  agentSlug: string,
  tools: Tool<any>[],
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
  toolNameReverseMapping: Map<string, string>,
  logger: {
    debug: (message: string, payload?: Record<string, unknown>) => void;
  },
): Tool<any>[] {
  return tools.map((tool) => {
    const normalized = normalizeToolName(tool.name);

    if (normalized !== tool.name) {
      const parsed = parseToolName(tool.name);
      toolNameMapping.set(normalized, {
        original: tool.name,
        normalized,
        server: parsed.server,
        tool: parsed.tool,
      });
      toolNameReverseMapping.set(tool.name, normalized);

      logger.debug('Tool name normalized', {
        agent: agentSlug,
        original: tool.name,
        normalized,
        server: parsed.server,
        tool: parsed.tool,
      });
    }

    return {
      ...tool,
      name: normalized,
    };
  });
}

export function matchesToolPattern(
  toolName: string,
  patterns: string[],
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
): boolean {
  const mapping = toolNameMapping.get(toolName);
  const originalName = mapping?.original || toolName;

  for (const pattern of patterns) {
    if (pattern === toolName || pattern === originalName) return true;

    if (pattern.endsWith('_*')) {
      const prefix = pattern.slice(0, -2);
      if (
        toolName.startsWith(`${prefix}_`) ||
        originalName.startsWith(`${prefix}_`)
      ) {
        return true;
      }
    }

    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (
        toolName.startsWith(`${prefix}_`) ||
        toolName.startsWith(`${prefix}/`) ||
        originalName.startsWith(`${prefix}_`) ||
        originalName.startsWith(`${prefix}/`)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function getOriginalToolName(
  normalizedName: string,
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
): string {
  const mapping = toolNameMapping.get(normalizedName);
  return mapping?.original || normalizedName;
}

export function getNormalizedToolName(
  originalName: string,
  toolNameReverseMapping: Map<string, string>,
): string {
  return toolNameReverseMapping.get(originalName) || originalName;
}
