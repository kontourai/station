import type {
  MCPToolUICsp,
  MCPToolUIPermissions,
} from '@kontourai/station-shared/mcp';

export type MCPAppsToolAudience = 'model' | 'app';

export class MCPAppsToolAccessError extends Error {
  constructor(serverId: string, toolName: string) {
    super(`MCP Apps tool '${toolName}' is not available from '${serverId}'`);
    this.name = 'MCPAppsToolAccessError';
  }
}

export interface MCPAppsUiMetadata {
  resourceUri?: string;
  visibility?: MCPAppsToolAudience[];
  csp?: MCPToolUICsp;
  permissions?: MCPToolUIPermissions;
}

/**
 * Read the stable MCP Apps metadata shape. Nested `_meta.ui` is canonical.
 * The flat resource pointer remains an input-only compatibility fallback for
 * deployed Apps servers that predate the nested extension metadata.
 */
export function extractMCPAppsToolMetadata(tool: unknown): MCPAppsUiMetadata {
  if (!isRecord(tool)) return {};
  const meta = recordField(tool, '_meta');
  const nestedUi = recordField(meta, 'ui');

  return {
    resourceUri:
      stringField(nestedUi, 'resourceUri') ??
      stringField(meta, 'ui/resourceUri'),
    visibility: visibilityField(nestedUi),
  };
}

/**
 * MCP Apps defaults an omitted visibility declaration to both audiences.
 * Explicit declarations are capabilities, so malformed or empty arrays grant
 * neither audience rather than silently broadening access.
 */
export function isMCPAppsToolVisibleTo(
  tool: unknown,
  audience: MCPAppsToolAudience,
): boolean {
  if (!isRecord(tool)) return false;
  const meta = recordField(tool, '_meta');
  const ui = recordField(meta, 'ui');
  if (!ui || !Object.hasOwn(ui, 'visibility')) return true;
  const visibility = visibilityField(ui);
  return visibility?.includes(audience) ?? false;
}

/** Resource-content policy is authoritative over tool-level hints. */
export function extractMCPAppsResourceMetadata(
  content: unknown,
): MCPAppsUiMetadata {
  if (!isRecord(content)) return {};
  const meta = recordField(content, '_meta');
  const ui = recordField(meta, 'ui');
  return ui ? extractPolicy(ui) : {};
}

function extractPolicy(ui: Record<string, unknown> | undefined): {
  csp?: MCPToolUICsp;
  permissions?: MCPToolUIPermissions;
} {
  if (!ui) return {};

  const rawCsp = recordField(ui, 'csp');
  const csp = rawCsp
    ? {
        connectDomains: stringArray(rawCsp, 'connectDomains'),
        resourceDomains: stringArray(rawCsp, 'resourceDomains'),
        frameDomains: stringArray(rawCsp, 'frameDomains'),
        baseUriDomains: stringArray(rawCsp, 'baseUriDomains'),
      }
    : undefined;

  const rawPermissions = recordField(ui, 'permissions');
  const permissions = rawPermissions
    ? {
        camera: objectField(rawPermissions, 'camera'),
        microphone: objectField(rawPermissions, 'microphone'),
        geolocation: objectField(rawPermissions, 'geolocation'),
        clipboardWrite: objectField(rawPermissions, 'clipboardWrite'),
      }
    : undefined;

  return {
    csp: csp && Object.values(csp).some(Boolean) ? csp : undefined,
    permissions:
      permissions && Object.values(permissions).some(Boolean)
        ? permissions
        : undefined,
  };
}

function visibilityField(
  ui: Record<string, unknown> | undefined,
): MCPAppsToolAudience[] | undefined {
  const value = ui?.visibility;
  if (!Array.isArray(value)) return undefined;
  if (
    value.some(
      (entry) =>
        typeof entry !== 'string' || (entry !== 'model' && entry !== 'app'),
    )
  ) {
    return undefined;
  }
  return value as MCPAppsToolAudience[];
}

function stringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return strings.length > 0 ? strings : undefined;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function objectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return recordField(record, key);
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
