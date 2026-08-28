import {
  buildStationSessionInventoryMcpAppResource,
  STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
} from '@kontourai/station-basis-pane/session-inventory-mcp-app';
import { SESSION_INVENTORY_GROUP_IDS } from '@kontourai/station-contracts/session-inventory';
import {
  parseStationSessionInventoryMcpEnvelope,
  parseStationSessionInventoryMcpInput,
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

const MAX_RESOURCE_BYTES = 500 * 1024;
const MAX_STRUCTURED_CONTENT_BYTES = 120 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const identifier = z.string().min(1).max(512);
export const stationSessionInventoryToolInputSchema = z.union([
  z
    .object({
      operation: z.literal('open'),
      scope: z.union([
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
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page'),
      scope: z.union([
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
      ]),
      occurrenceId: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
      groupId: z.string().min(1).max(128),
      continuationToken: z.string().min(16).max(1024),
    })
    .strict(),
]);

let resource:
  | ReturnType<typeof buildStationSessionInventoryMcpAppResource>
  | undefined;

export function parseStationSessionInventoryToolInput(
  value: unknown,
): StationSessionInventoryMcpInput | null {
  return parseStationSessionInventoryMcpInput(value);
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

function endpoint(input: StationSessionInventoryMcpInput) {
  const { scope } = input;
  return scope.kind === 'kept-in-task'
    ? `/api/tasks/${encodeURIComponent(scope.taskId)}/sessions/${encodeURIComponent(scope.sessionId)}/inventory/app-read`
    : `/api/orchestration/sessions/${encodeURIComponent(scope.sessionId)}/inventory/app-read`;
}

function validCapability(value: unknown): value is {
  occurrenceId: string;
  continuations: readonly { groupId: string; continuationToken: string }[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const capability = value as Record<string, unknown>;
  return (
    typeof capability.occurrenceId === 'string' &&
    /^[A-Za-z0-9_-]{24,128}$/.test(capability.occurrenceId) &&
    Array.isArray(capability.continuations) &&
    capability.continuations.length <= SESSION_INVENTORY_GROUP_IDS.length &&
    capability.continuations.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).groupId === 'string' &&
        SESSION_INVENTORY_GROUP_IDS.includes(
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
  if (Buffer.byteLength(resource.text, 'utf8') > MAX_RESOURCE_BYTES)
    throw new Error(
      'Station Session inventory MCP App resource exceeds 500 KiB',
    );
  registry.resource(
    STATION_SESSION_INVENTORY_MCP_RESOURCE_NAME,
    STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
    resource,
  );
  registry.appTool(
    STATION_SESSION_INVENTORY_MCP_TOOL_NAME,
    'Read one authorized Station Session inventory projection or bounded group page.',
    stationSessionInventoryToolInputSchema,
    {
      _meta: {
        ui: {
          resourceUri: STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
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
      const input = parseStationSessionInventoryMcpInput(args);
      if (!input) return buildStationSessionInventoryUnavailableToolResult();
      const path = endpoint(input);
      try {
        const body = await api(path, {
          method: 'POST',
          body: JSON.stringify(input),
        });
        const envelope = body?.success
          ? parseStationSessionInventoryMcpEnvelope(body.data)
          : null;
        const capability = body?.meta?.[STATION_SESSION_INVENTORY_MCP_META_KEY];
        if (!isStationControlCallerCurrent()) {
          if (validCapability(capability))
            await api(path, {
              method: 'DELETE',
              body: JSON.stringify({ occurrenceId: capability.occurrenceId }),
            });
          return buildStationSessionInventoryUnavailableToolResult();
        }
        if (!envelope || !validCapability(capability))
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
            [STATION_SESSION_INVENTORY_MCP_META_KEY]: {
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
