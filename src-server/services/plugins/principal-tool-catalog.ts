/**
 * #3279: the tool catalog of an integration whose credentials belong to
 * people rather than the Station instance.
 *
 * An instance integration lists its tools at Agent load with the shared
 * credential. A person-owned integration has no credential to list with at
 * load time: Agent load is not a turn and acts for no one, and borrowing any
 * one person's token to list would use their account for someone else's
 * Agent. Instead, a person's own successful connection records the tool
 * schemas here, and Agent load builds tools from this snapshot; every call
 * still connects with the calling turn's own credential.
 *
 * The snapshot is schema metadata, never a credential. It is bound to the
 * resource identity it was listed from, so an endpoint change reads as "no
 * catalog" rather than offering another server's tools.
 */
import { join } from 'node:path';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';
import {
  readJsonFile,
  writeJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import type { MCPToolInfo } from '@kontourai/station-shared/mcp';

const MAX_TOOLS = 200;
const MAX_BYTES = 512 * 1024;
const LABEL = 'Connected-account tool catalog';

export interface PrincipalToolCatalogEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: Record<string, unknown>;
  ui?: { resourceUri: string };
}

interface PrincipalToolCatalogDocument {
  schemaVersion: 1;
  resource: string;
  tools: PrincipalToolCatalogEntry[];
}

function catalogPath(homeDir: string, serverId: string): string {
  if (!isSafeToolServerId(serverId))
    throw new Error('Invalid connected-account catalog server id');
  return join(homeDir, 'integrations', serverId, 'principal-catalog.json');
}

function entryOf(value: unknown): PrincipalToolCatalogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== 'string' ||
    record.name.length === 0 ||
    record.name.length > 256
  )
    return undefined;
  const meta =
    record._meta &&
    typeof record._meta === 'object' &&
    !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : undefined;
  const ui =
    record.ui &&
    typeof record.ui === 'object' &&
    typeof (record.ui as { resourceUri?: unknown }).resourceUri === 'string'
      ? { resourceUri: (record.ui as { resourceUri: string }).resourceUri }
      : undefined;
  return {
    name: record.name,
    ...(typeof record.description === 'string'
      ? { description: record.description }
      : {}),
    ...(record.inputSchema !== undefined
      ? { inputSchema: record.inputSchema }
      : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * The recorded catalog for this exact resource, or `undefined` when none was
 * recorded, it is unreadable, or it was listed from a different endpoint.
 */
export function readPrincipalToolCatalog(
  homeDir: string,
  serverId: string,
  resource: string,
): PrincipalToolCatalogEntry[] | undefined {
  let document: Partial<PrincipalToolCatalogDocument> | undefined;
  try {
    document = readJsonFile<Partial<PrincipalToolCatalogDocument> | undefined>(
      catalogPath(homeDir, serverId),
      undefined,
      { maxBytes: MAX_BYTES, label: LABEL },
    );
  } catch {
    return undefined;
  }
  if (
    document?.schemaVersion !== 1 ||
    document.resource !== resource ||
    !Array.isArray(document.tools) ||
    document.tools.length > MAX_TOOLS
  )
    return undefined;
  const tools: PrincipalToolCatalogEntry[] = [];
  for (const candidate of document.tools) {
    const entry = entryOf(candidate);
    if (!entry) return undefined;
    tools.push(entry);
  }
  return tools;
}

export function principalToolCatalogExists(
  homeDir: string,
  serverId: string,
  resource: string,
): boolean {
  return readPrincipalToolCatalog(homeDir, serverId, resource) !== undefined;
}

/**
 * Records the catalog a person's own connection listed. Returns whether the
 * stored catalog changed, so the caller can reload Agents only when needed.
 * Oversized catalogs are refused rather than truncated.
 */
export async function writePrincipalToolCatalog(
  homeDir: string,
  serverId: string,
  resource: string,
  tools: readonly MCPToolInfo[],
): Promise<boolean> {
  if (tools.length > MAX_TOOLS)
    throw new Error('Connected-account tool catalog exceeds the tool limit');
  const document: PrincipalToolCatalogDocument = {
    schemaVersion: 1,
    resource,
    tools: tools.map((tool) => ({
      name: tool.originalName,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      ...(tool.inputSchema !== undefined
        ? { inputSchema: tool.inputSchema }
        : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
      ...(tool.ui ? { ui: { resourceUri: tool.ui.resourceUri } } : {}),
    })),
  };
  const current = readPrincipalToolCatalog(homeDir, serverId, resource);
  if (
    current &&
    JSON.stringify(current) === JSON.stringify(document.tools.map(entryOf))
  )
    return false;
  await writeJsonFile(catalogPath(homeDir, serverId), document, {
    maxBytes: MAX_BYTES,
    label: LABEL,
  });
  return true;
}

/** Stored entries as the connection-shaped tool records the loader expects. */
export function principalCatalogToolInfos(
  serverId: string,
  entries: readonly PrincipalToolCatalogEntry[],
): MCPToolInfo[] {
  return entries.map((entry) => ({
    name: `${serverId}_${entry.name}`,
    originalName: entry.name,
    serverId,
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
    ...(entry.inputSchema !== undefined
      ? { inputSchema: entry.inputSchema }
      : {}),
    ...(entry._meta ? { _meta: entry._meta } : {}),
    ...(entry.ui ? { ui: entry.ui } : {}),
  }));
}
