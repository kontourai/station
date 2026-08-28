import {
  SESSION_INVENTORY_MAX_SERIALIZED_BYTES,
  SESSION_INVENTORY_GROUP_IDS,
  parseSessionInventoryGroupPage,
  parseSessionInventoryProjection,
  type SessionInventoryGroupId,
  type SessionInventoryGroupPage,
  type SessionInventoryProjection,
  type SessionInventoryScope,
} from './session-inventory.js';
import { isStationBasisId } from './task-basis.js';

export const STATION_SESSION_INVENTORY_MCP_VERSION =
  'station.session-inventory-mcp/v1' as const;
export const STATION_SESSION_INVENTORY_MCP_MAX_SERIALIZED_BYTES = 120 * 1024;

export type StationSessionInventoryMcpEnvelope =
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_VERSION;
      kind: 'projection';
      projection: SessionInventoryProjection;
    }
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_VERSION;
      kind: 'group-page';
      page: SessionInventoryGroupPage;
    };
export type StationSessionInventoryMcpInput =
  | { operation: 'open'; scope: SessionInventoryScope }
  | {
      operation: 'page';
      scope: SessionInventoryScope;
      occurrenceId: string;
      groupId: SessionInventoryGroupId;
      continuationToken: string;
    };

function scope(value: unknown): value is SessionInventoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.sessionId === 'string' &&
    isStationBasisId(item.sessionId) &&
    ((item.kind === 'whole-session' && Object.keys(item).length === 2) ||
      (item.kind === 'current-answer' &&
        Object.keys(item).length === 3 &&
        typeof item.turnId === 'string' &&
        isStationBasisId(item.turnId)) ||
      (item.kind === 'kept-in-task' &&
        Object.keys(item).length === 3 &&
        typeof item.taskId === 'string' &&
        isStationBasisId(item.taskId)))
  );
}

export function parseStationSessionInventoryMcpInput(
  value: unknown,
): StationSessionInventoryMcpInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.operation === 'open' &&
    Object.keys(item).length === 2 &&
    scope(item.scope)
  )
    return { operation: 'open', scope: item.scope };
  if (
    item.operation === 'page' &&
    Object.keys(item).length === 5 &&
    scope(item.scope) &&
    typeof item.occurrenceId === 'string' &&
    /^[A-Za-z0-9_-]{24,128}$/.test(item.occurrenceId) &&
    typeof item.groupId === 'string' &&
    SESSION_INVENTORY_GROUP_IDS.includes(
      item.groupId as SessionInventoryGroupId,
    ) &&
    typeof item.continuationToken === 'string' &&
    item.continuationToken.length >= 16 &&
    item.continuationToken.length <= 1024
  )
    return {
      operation: 'page',
      scope: item.scope,
      occurrenceId: item.occurrenceId,
      groupId: item.groupId as SessionInventoryGroupId,
      continuationToken: item.continuationToken,
    };
  return null;
}

/** Closed model-visible envelope: opaque page continuations belong only in MCP metadata. */
export function parseStationSessionInventoryMcpEnvelope(
  value: unknown,
): StationSessionInventoryMcpEnvelope | null {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return null;
    const record = value as Record<string, unknown>;
    if (record.version !== STATION_SESSION_INVENTORY_MCP_VERSION) return null;
    const projection =
      record.kind === 'projection' && Object.keys(record).length === 3
        ? parseSessionInventoryProjection(record.projection)
        : null;
    const page =
      record.kind === 'group-page' && Object.keys(record).length === 3
        ? parseSessionInventoryGroupPage(record.page)
        : null;
    if (
      (!projection && !page) ||
      projection?.groups.some((group) => group.continuation !== undefined) ||
      page?.group.continuation !== undefined
    )
      return null;
    const envelope = projection
      ? {
          version: STATION_SESSION_INVENTORY_MCP_VERSION,
          kind: 'projection' as const,
          projection,
        }
      : {
          version: STATION_SESSION_INVENTORY_MCP_VERSION,
          kind: 'group-page' as const,
          page: page!,
        };
    return new TextEncoder().encode(JSON.stringify(envelope)).byteLength <=
      STATION_SESSION_INVENTORY_MCP_MAX_SERIALIZED_BYTES
      ? envelope
      : null;
  } catch {
    return null;
  }
}

export function buildStationSessionInventoryMcpEnvelope(
  projection: unknown,
): StationSessionInventoryMcpEnvelope | null {
  const parsed = parseSessionInventoryProjection(projection);
  if (!parsed) return null;
  return parseStationSessionInventoryMcpEnvelope({
    version: STATION_SESSION_INVENTORY_MCP_VERSION,
    kind: 'projection',
    projection: {
      ...parsed,
      groups: parsed.groups.map(
        ({ continuation: _continuation, ...group }) => group,
      ),
    },
  });
}

/** Parses a model-visible single group page; opaque continuations live in `_meta`. */
export function parseStationSessionInventoryMcpGroupPage(
  value: unknown,
): SessionInventoryGroupPage | null {
  const page = parseSessionInventoryGroupPage(value);
  return page?.group.continuation === undefined ? page : null;
}

export function buildStationSessionInventoryMcpGroupPageEnvelope(
  page: unknown,
): StationSessionInventoryMcpEnvelope | null {
  const parsed = parseSessionInventoryGroupPage(page);
  if (!parsed) return null;
  return parseStationSessionInventoryMcpEnvelope({
    version: STATION_SESSION_INVENTORY_MCP_VERSION,
    kind: 'group-page',
    page: {
      ...parsed,
      group: (({ continuation: _continuation, ...group }) => group)(
        parsed.group,
      ),
    },
  });
}
