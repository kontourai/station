import {
  buildStationSessionInventoryMcpAppResource,
  buildStationSessionInventoryMcpV2AppResource,
  STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
  STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_URI,
} from '@kontourai/station-basis-pane/session-inventory-mcp-app';
import {
  SESSION_INVENTORY_CURRENT_GROUP_IDS,
  SESSION_INVENTORY_GROUP_IDS,
} from '@kontourai/station-contracts/session-inventory';
import {
  parseStationSessionInventoryMcpEnvelope,
  parseStationSessionInventoryMcpNegotiatedInput,
  parseStationSessionInventoryMcpV2Envelope,
  STATION_SESSION_INVENTORY_MCP_V2_VERSION,
  type StationSessionInventoryMcpInput,
} from '@kontourai/station-contracts/session-inventory-mcp';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  isStationControlCallerCurrent,
} from './station-control-shared.js';

export const STATION_SESSION_INVENTORY_MCP_SERVER_ID = 'station-control';
export const STATION_SESSION_INVENTORY_MCP_TOOL_NAME = 'get_session_inventory';
export const STATION_SESSION_INVENTORY_MCP_TOOL_REF =
  'station-control/get_session_inventory';
export const STATION_SESSION_INVENTORY_MCP_RESOURCE_NAME =
  'station-session-inventory-v1';
export const STATION_SESSION_INVENTORY_MCP_META_KEY =
  'station.session-inventory-app/v1';
export const STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_NAME =
  'station-session-inventory-v2';
export const STATION_SESSION_INVENTORY_MCP_V2_META_KEY =
  'station.session-inventory-app/v2';

const MAX_RESOURCE_BYTES = 500 * 1024;
const MAX_STRUCTURED_CONTENT_BYTES = 120 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const identifier = z.string().min(1).max(512);
const scopeSchema = z.union([
  z
    .object({ kind: z.literal('whole-session'), sessionId: identifier })
    .strict(),
  z
    .object({
      kind: z.literal('current-answer'),
      sessionId: identifier,
      turnId: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal('kept-in-task'),
      sessionId: identifier,
      taskId: identifier,
    })
    .strict(),
]);
const pageSchema = z
  .object({
    operation: z.literal('page'),
    scope: scopeSchema,
    occurrenceId: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
    groupId: z.string().min(1).max(128),
    continuationToken: z.string().min(16).max(1024),
  })
  .strict();
export const stationSessionInventoryToolInputSchema = z.union([
  z.object({ operation: z.literal('open'), scope: scopeSchema }).strict(),
  pageSchema,
  z
    .object({
      version: z.literal(STATION_SESSION_INVENTORY_MCP_V2_VERSION),
      operation: z.literal('open'),
      scope: scopeSchema,
    })
    .strict(),
  pageSchema.extend({
    version: z.literal(STATION_SESSION_INVENTORY_MCP_V2_VERSION),
  }),
]);

let resource:
  | ReturnType<typeof buildStationSessionInventoryMcpAppResource>
  | undefined;
let v2Resource:
  | ReturnType<typeof buildStationSessionInventoryMcpV2AppResource>
  | undefined;

export function parseStationSessionInventoryToolInput(
  value: unknown,
): StationSessionInventoryMcpInput | null {
  const parsed = parseStationSessionInventoryMcpNegotiatedInput(value);
  return parsed?.version === STATION_SESSION_INVENTORY_MCP_V2_VERSION
    ? null
    : (parsed?.input ?? null);
}

export function buildStationSessionInventoryUnavailableToolResult(
  temporary = false,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: temporary
          ? 'Session inventory is temporarily unavailable.'
          : 'Session inventory is unavailable.',
      },
    ],
    isError: false,
  };
}

function endpoint(input: { scope: StationSessionInventoryMcpInput['scope'] }) {
  const { scope } = input;
  return scope.kind === 'kept-in-task'
    ? `/api/tasks/${encodeURIComponent(scope.taskId)}/sessions/${encodeURIComponent(scope.sessionId)}/inventory/app-read`
    : `/api/orchestration/sessions/${encodeURIComponent(scope.sessionId)}/inventory/app-read`;
}

function validCapability(
  value: unknown,
  v2 = false,
): value is {
  occurrenceId: string;
  continuations: readonly { groupId: string; continuationToken: string }[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const capability = value as Record<string, unknown>;
  return (
    typeof capability.occurrenceId === 'string' &&
    /^[A-Za-z0-9_-]{24,128}$/.test(capability.occurrenceId) &&
    Array.isArray(capability.continuations) &&
    capability.continuations.length <=
      (v2 ? SESSION_INVENTORY_CURRENT_GROUP_IDS : SESSION_INVENTORY_GROUP_IDS)
        .length &&
    capability.continuations.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).groupId === 'string' &&
        (v2
          ? SESSION_INVENTORY_CURRENT_GROUP_IDS
          : SESSION_INVENTORY_GROUP_IDS
        ).includes(
          (entry as Record<string, unknown>)
            .groupId as (typeof SESSION_INVENTORY_GROUP_IDS)[number],
        ) &&
        typeof (entry as Record<string, unknown>).continuationToken ===
          'string' &&
        /^[A-Za-z0-9_-]{24,128}$/.test(
          (entry as Record<string, unknown>).continuationToken as string,
        ),
    )
  );
}

export function registerSessionInventoryTools(
  registry: StationControlToolRegistry,
) {
  resource ??= buildStationSessionInventoryMcpAppResource();
  v2Resource ??= buildStationSessionInventoryMcpV2AppResource();
  if (Buffer.byteLength(resource.text, 'utf8') > MAX_RESOURCE_BYTES)
    throw new Error(
      'Station Session inventory MCP App resource exceeds 500 KiB',
    );
  registry.resource(
    STATION_SESSION_INVENTORY_MCP_RESOURCE_NAME,
    STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
    resource,
  );
  if (Buffer.byteLength(v2Resource.text, 'utf8') > MAX_RESOURCE_BYTES)
    throw new Error(
      'Station Session inventory MCP App v2 resource exceeds 500 KiB',
    );
  registry.resource(
    STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_NAME,
    STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_URI,
    v2Resource,
  );
  registry.appTool(
    STATION_SESSION_INVENTORY_MCP_TOOL_NAME,
    'Read one authorized Station Session inventory projection or bounded group page.',
    stationSessionInventoryToolInputSchema,
    {
      _meta: {
        ui: {
          // New discovery selects v2; callers with omitted discriminator keep
          // receiving the frozen v1 envelope through this same tool.
          resourceUri: STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const negotiated = parseStationSessionInventoryMcpNegotiatedInput(args);
      if (!negotiated)
        return buildStationSessionInventoryUnavailableToolResult();
      const input = negotiated.input;
      const path = endpoint(input);
      try {
        const body = await api(path, {
          method: 'POST',
          body: JSON.stringify(input),
        });
        const v2 =
          negotiated.version === STATION_SESSION_INVENTORY_MCP_V2_VERSION;
        const envelope = body?.success
          ? v2
            ? parseStationSessionInventoryMcpV2Envelope(body.data)
            : parseStationSessionInventoryMcpEnvelope(body.data)
          : null;
        const metaKey = v2
          ? STATION_SESSION_INVENTORY_MCP_V2_META_KEY
          : STATION_SESSION_INVENTORY_MCP_META_KEY;
        const capability = body?.meta?.[metaKey];
        if (!isStationControlCallerCurrent()) {
          if (validCapability(capability, v2))
            await api(path, {
              method: 'DELETE',
              body: JSON.stringify({ occurrenceId: capability.occurrenceId }),
            });
          return buildStationSessionInventoryUnavailableToolResult();
        }
        if (!envelope || !validCapability(capability, v2))
          return buildStationSessionInventoryUnavailableToolResult();
        if (
          Buffer.byteLength(JSON.stringify(envelope), 'utf8') >
          MAX_STRUCTURED_CONTENT_BYTES
        )
          return buildStationSessionInventoryUnavailableToolResult();
        const result = {
          content: [
            { type: 'text' as const, text: 'Session inventory available.' },
          ],
          structuredContent: envelope,
          _meta: {
            [metaKey]: {
              occurrenceId: capability.occurrenceId,
              continuations: capability.continuations,
            },
          },
        };
        return Buffer.byteLength(JSON.stringify(result), 'utf8') <=
          MAX_RESULT_BYTES
          ? result
          : buildStationSessionInventoryUnavailableToolResult();
      } catch {
        return buildStationSessionInventoryUnavailableToolResult(true);
      }
    },
  );
}
