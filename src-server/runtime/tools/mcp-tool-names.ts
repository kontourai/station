import type { Tool } from '@voltagent/core';
import type {
  MCPToolLoaderProvenance,
  MCPToolProvenanceGeneration,
} from '../../services/orchestration/mcp-tool-provenance.js';
import {
  normalizeToolName,
  parseToolName,
} from '../../utils/tool-name-normalizer.js';

export interface MCPToolNameMappingEntry {
  original: string;
  normalized: string;
  server: string | null;
  tool: string;
  /** Exact server-side identity issued during this runtime generation. */
  provenance?: MCPToolLoaderProvenance;
}

export function normalizeLoadedMCPTools(
  agentSlug: string,
  tools: Tool<any>[],
  toolNameMapping: Map<string, MCPToolNameMappingEntry>,
  toolNameReverseMapping: Map<string, string>,
  provenanceGeneration: MCPToolProvenanceGeneration,
  integrationId: string,
  loaderIdentity: (tool: Tool<any>) => {
    serverId: string;
    originalToolName: string;
  },
  logger: {
    debug: (message: string, payload?: Record<string, unknown>) => void;
  },
): Tool<any>[] {
  return tools.map((tool) => {
    const normalized = normalizeToolName(tool.name);
    const parsed = parseToolName(tool.name);
    const source = loaderIdentity(tool);
    const existing = toolNameMapping.get(normalized);
    if (
      existing &&
      (!existing.provenance ||
        existing.provenance.serverId !== source.serverId ||
        existing.provenance.originalToolName !== source.originalToolName ||
        existing.provenance.integrationId !== integrationId)
    ) {
      throw new Error(`MCP runtime tool name collision for '${normalized}'.`);
    }
    const provenance = provenanceGeneration.mint({
      serverId: source.serverId,
      originalToolName: source.originalToolName,
      runtimeName: normalized,
      integrationId,
    });
    const entry: MCPToolNameMappingEntry = Object.freeze({
      original: tool.name,
      normalized,
      server: parsed.server,
      tool: parsed.tool,
      provenance,
    });
    toolNameMapping.set(normalized, entry);
    toolNameReverseMapping.set(tool.name, normalized);

    if (normalized !== tool.name) {
      logger.debug('Tool name normalized', {
        agent: agentSlug,
        original: tool.name,
        normalized,
        server: parsed.server,
        tool: parsed.tool,
      });
    }

    const loaded = {
      ...tool,
      name: normalized,
    };
    // Symbols do not enter JSON/model tool descriptions, while enumerable
    // ownership lets Station's intentional object-spread wrappers preserve
    // this server-only handle through execution.
    Object.defineProperty(loaded, loadedMCPToolProvenance, {
      configurable: false,
      enumerable: true,
      value: provenance,
      writable: false,
    });
    return loaded;
  });
}

const loadedMCPToolProvenance = Symbol('station.loaded-mcp-tool-provenance');

export function getLoadedMCPToolProvenance(
  value: unknown,
): MCPToolLoaderProvenance | undefined {
  return value && typeof value === 'object'
    ? ((value as Record<PropertyKey, unknown>)[loadedMCPToolProvenance] as
        | MCPToolLoaderProvenance
        | undefined)
    : undefined;
}

/** Preserve the server-only handle when a framework materializes a new tool. */
export function copyLoadedMCPToolProvenance<T extends object>(
  source: unknown,
  target: T,
): T {
  const provenance = getLoadedMCPToolProvenance(source);
  if (!provenance) return target;
  Object.defineProperty(target, loadedMCPToolProvenance, {
    configurable: false,
    enumerable: true,
    value: provenance,
    writable: false,
  });
  return target;
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
