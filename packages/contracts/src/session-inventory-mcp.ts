import {
  parseSessionInventoryGroupPage,
  parseSessionInventoryProjection,
  SESSION_INVENTORY_CURRENT_GROUP_IDS,
  SESSION_INVENTORY_GROUP_IDS,
  SESSION_INVENTORY_V1,
  SESSION_INVENTORY_V2,
  type SessionInventoryGroupId,
  type SessionInventoryGroupPage,
  type SessionInventoryProjection,
  type SessionInventoryScope,
  type SessionInventoryV2GroupId,
  type SessionInventoryV2GroupPage,
  type SessionInventoryV2Projection,
} from './session-inventory.js';
import { isStationBasisId } from './task-basis.js';

export const STATION_SESSION_INVENTORY_MCP_VERSION =
  'station.session-inventory-mcp/v1' as const;
export const STATION_SESSION_INVENTORY_MCP_V2_VERSION =
  'station.session-inventory-mcp/v2' as const;
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
export type StationSessionInventoryMcpV2Envelope =
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION;
      kind: 'projection';
      projection: SessionInventoryV2Projection;
    }
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION;
      kind: 'group-page';
      page: SessionInventoryV2GroupPage;
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
export type StationSessionInventoryMcpV2Input =
  | {
      /** Explicit discriminator: omitted input is permanently the v1 contract. */
      version: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION;
      operation: 'open';
      scope: SessionInventoryScope;
    }
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION;
      operation: 'page';
      scope: SessionInventoryScope;
      occurrenceId: string;
      groupId: SessionInventoryV2GroupId;
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
function parseInput<T extends string>(
  value: unknown,
  groups: readonly T[],
  version?: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.operation === 'open' &&
    Object.keys(item).length === (version ? 3 : 2) &&
    (!version || item.version === version) &&
    scope(item.scope)
  )
    return {
      ...(version ? { version } : {}),
      operation: 'open' as const,
      scope: item.scope,
    };
  if (
    item.operation === 'page' &&
    Object.keys(item).length === (version ? 6 : 5) &&
    (!version || item.version === version) &&
    scope(item.scope) &&
    typeof item.occurrenceId === 'string' &&
    /^[A-Za-z0-9_-]{24,128}$/.test(item.occurrenceId) &&
    typeof item.groupId === 'string' &&
    groups.includes(item.groupId as T) &&
    typeof item.continuationToken === 'string' &&
    item.continuationToken.length >= 16 &&
    item.continuationToken.length <= 1024
  )
    return {
      ...(version ? { version } : {}),
      operation: 'page' as const,
      scope: item.scope,
      occurrenceId: item.occurrenceId,
      groupId: item.groupId as T,
      continuationToken: item.continuationToken,
    };
  return null;
}
export function parseStationSessionInventoryMcpInput(
  value: unknown,
): StationSessionInventoryMcpInput | null {
  return parseInput(value, SESSION_INVENTORY_GROUP_IDS);
}
export function parseStationSessionInventoryMcpV2Input(
  value: unknown,
): StationSessionInventoryMcpV2Input | null {
  return parseInput(
    value,
    SESSION_INVENTORY_CURRENT_GROUP_IDS,
    STATION_SESSION_INVENTORY_MCP_V2_VERSION,
  ) as StationSessionInventoryMcpV2Input | null;
}

/** Negotiate once at the tool/route seam; no discriminator is always v1. */
export function parseStationSessionInventoryMcpNegotiatedInput(value: unknown):
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_VERSION;
      input: StationSessionInventoryMcpInput;
    }
  | {
      version: typeof STATION_SESSION_INVENTORY_MCP_V2_VERSION;
      input: StationSessionInventoryMcpV2Input;
    }
  | null {
  const v2 = parseStationSessionInventoryMcpV2Input(value);
  if (v2)
    return { version: STATION_SESSION_INVENTORY_MCP_V2_VERSION, input: v2 };
  const v1 = parseStationSessionInventoryMcpInput(value);
  return v1
    ? { version: STATION_SESSION_INVENTORY_MCP_VERSION, input: v1 }
    : null;
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function projectionEnvelope<
  T extends SessionInventoryProjection | SessionInventoryV2Projection,
>(
  version: string,
  value: unknown,
  projection: T | null,
  expected: T['version'],
) {
  if (
    !plain(value) ||
    value.version !== version ||
    value.kind !== 'projection' ||
    Object.keys(value).length !== 3 ||
    !projection ||
    projection.version !== expected ||
    projection.groups.some((group) => group.continuation !== undefined)
  )
    return null;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    STATION_SESSION_INVENTORY_MCP_MAX_SERIALIZED_BYTES
    ? projection
    : null;
}
function pageEnvelope<
  T extends SessionInventoryGroupPage | SessionInventoryV2GroupPage,
>(version: string, value: unknown, page: T | null, expected: T['version']) {
  if (
    !plain(value) ||
    value.version !== version ||
    value.kind !== 'group-page' ||
    Object.keys(value).length !== 3 ||
    !page ||
    page.version !== expected ||
    page.group.continuation !== undefined
  )
    return null;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    STATION_SESSION_INVENTORY_MCP_MAX_SERIALIZED_BYTES
    ? page
    : null;
}
export function parseStationSessionInventoryMcpEnvelope(
  value: unknown,
): StationSessionInventoryMcpEnvelope | null {
  try {
    const projection =
      plain(value) && value.kind === 'projection'
        ? parseSessionInventoryProjection(value.projection)
        : null;
    const page =
      plain(value) && value.kind === 'group-page'
        ? parseSessionInventoryGroupPage(value.page)
        : null;
    const parsedProjection = projectionEnvelope(
      STATION_SESSION_INVENTORY_MCP_VERSION,
      value,
      projection as SessionInventoryProjection | null,
      SESSION_INVENTORY_V1,
    );
    if (parsedProjection)
      return {
        version: STATION_SESSION_INVENTORY_MCP_VERSION,
        kind: 'projection',
        projection: parsedProjection,
      };
    const parsedPage = pageEnvelope(
      STATION_SESSION_INVENTORY_MCP_VERSION,
      value,
      page as SessionInventoryGroupPage | null,
      SESSION_INVENTORY_V1,
    );
    return parsedPage
      ? {
          version: STATION_SESSION_INVENTORY_MCP_VERSION,
          kind: 'group-page',
          page: parsedPage,
        }
      : null;
  } catch {
    return null;
  }
}
export function parseStationSessionInventoryMcpV2Envelope(
  value: unknown,
): StationSessionInventoryMcpV2Envelope | null {
  try {
    const projection =
      plain(value) && value.kind === 'projection'
        ? parseSessionInventoryProjection(value.projection)
        : null;
    const page =
      plain(value) && value.kind === 'group-page'
        ? parseSessionInventoryGroupPage(value.page)
        : null;
    const parsedProjection = projectionEnvelope(
      STATION_SESSION_INVENTORY_MCP_V2_VERSION,
      value,
      projection as SessionInventoryV2Projection | null,
      SESSION_INVENTORY_V2,
    );
    if (parsedProjection)
      return {
        version: STATION_SESSION_INVENTORY_MCP_V2_VERSION,
        kind: 'projection',
        projection: parsedProjection,
      };
    const parsedPage = pageEnvelope(
      STATION_SESSION_INVENTORY_MCP_V2_VERSION,
      value,
      page as SessionInventoryV2GroupPage | null,
      SESSION_INVENTORY_V2,
    );
    return parsedPage
      ? {
          version: STATION_SESSION_INVENTORY_MCP_V2_VERSION,
          kind: 'group-page',
          page: parsedPage,
        }
      : null;
  } catch {
    return null;
  }
}
function withoutContinuation<
  T extends {
    groups?: readonly { continuation?: string }[];
    group?: { continuation?: string };
  },
>(value: T): T {
  return value.groups
    ? ({
        ...value,
        groups: value.groups.map(
          ({ continuation: _continuation, ...group }) => group,
        ),
      } as T)
    : ({
        ...value,
        group: (({ continuation: _continuation, ...group }) => group)(
          value.group!,
        ),
      } as T);
}
export function buildStationSessionInventoryMcpEnvelope(
  projection: unknown,
): StationSessionInventoryMcpEnvelope | null {
  const parsed = parseSessionInventoryProjection(projection);
  return parsed?.version === SESSION_INVENTORY_V1
    ? parseStationSessionInventoryMcpEnvelope({
        version: STATION_SESSION_INVENTORY_MCP_VERSION,
        kind: 'projection',
        projection: withoutContinuation(parsed),
      })
    : null;
}
export function buildStationSessionInventoryMcpV2Envelope(
  projection: unknown,
): StationSessionInventoryMcpV2Envelope | null {
  const parsed = parseSessionInventoryProjection(projection);
  return parsed?.version === SESSION_INVENTORY_V2
    ? parseStationSessionInventoryMcpV2Envelope({
        version: STATION_SESSION_INVENTORY_MCP_V2_VERSION,
        kind: 'projection',
        projection: withoutContinuation(parsed),
      })
    : null;
}
export function buildStationSessionInventoryMcpGroupPageEnvelope(
  page: unknown,
): StationSessionInventoryMcpEnvelope | null {
  const parsed = parseSessionInventoryGroupPage(page);
  return parsed?.version === SESSION_INVENTORY_V1
    ? parseStationSessionInventoryMcpEnvelope({
        version: STATION_SESSION_INVENTORY_MCP_VERSION,
        kind: 'group-page',
        page: withoutContinuation(parsed),
      })
    : null;
}
export function buildStationSessionInventoryMcpV2GroupPageEnvelope(
  page: unknown,
): StationSessionInventoryMcpV2Envelope | null {
  const parsed = parseSessionInventoryGroupPage(page);
  return parsed?.version === SESSION_INVENTORY_V2
    ? parseStationSessionInventoryMcpV2Envelope({
        version: STATION_SESSION_INVENTORY_MCP_V2_VERSION,
        kind: 'group-page',
        page: withoutContinuation(parsed),
      })
    : null;
}
