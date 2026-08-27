import {
  buildStationTaskBasisMcpAppResource,
  STATION_TASK_BASIS_MCP_RESOURCE_URI,
  STATION_TASK_BASIS_MCP_TOOL_NAME,
} from '@kontourai/station-basis-pane/task-basis-mcp-app';
import {
  STATION_BASIS_MCP_RESOURCE_URI,
  STATION_BASIS_MCP_SERVER_ID,
  STATION_BASIS_MCP_TOOL_NAME,
} from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import {
  isStationBasisId,
  parseStationBasisProjection,
} from '@kontourai/station-contracts/task-basis';
import { parseStationTaskBasisMcpPage } from '@kontourai/station-contracts/task-basis-mcp';
import { getAnswerBasis } from '@kontourai/station-sdk/answer-basis';
import { getTaskBasis } from '@kontourai/station-sdk/task-basis';
import {
  buildBasisPanelAppToolMeta,
  buildBasisPanelUiResource,
} from '@kontourai/surface/basis/mcp';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  controlRequestOptions,
  isStationControlCallerCurrent,
  resolveControlApiBase,
} from './station-control-shared.js';

export {
  STATION_BASIS_MCP_RESOURCE_URI,
  STATION_BASIS_MCP_SERVER_ID,
  STATION_BASIS_MCP_TOOL_NAME,
};

const MAX_RESOURCE_BYTES = 500 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const identifier = z.string().refine(isStationBasisId, {
  message: 'Basis identity must be bounded, well-formed UTF-8',
});
export const stationBasisToolInputSchema = z.union([
  z
    .object({
      scope: z.literal('answer'),
      sessionId: identifier,
      turnId: identifier,
    })
    .strict(),
  z
    .object({
      scope: z.literal('task-answer'),
      taskId: identifier,
      answerReferenceId: identifier,
    })
    .strict(),
]);
export type StationBasisToolInput = z.infer<typeof stationBasisToolInputSchema>;
let resource: ReturnType<typeof buildBasisPanelUiResource> | undefined;
let taskResource:
  | ReturnType<typeof buildStationTaskBasisMcpAppResource>
  | undefined;
const taskBasisAppInputSchema = z
  .object({
    taskId: identifier,
    continuationToken: z.string().min(16).max(256).optional(),
  })
  .strict();

export function parseStationBasisToolInput(
  value: unknown,
): StationBasisToolInput | null {
  const parsed = stationBasisToolInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildStationBasisUnavailableToolResult(temporary = false) {
  const model = buildBasisPanelViewModel(null);
  return {
    content: [
      {
        type: 'text' as const,
        text: `${model.standing.label}: ${temporary ? 'Temporarily unavailable.' : model.standing.description}`,
      },
    ],
    isError: false,
  };
}

export function buildStationBasisProjectionToolResult(value: unknown) {
  const projection = parseStationBasisProjection(value);
  if (!projection) return buildStationBasisUnavailableToolResult();
  const encoded = JSON.stringify(projection);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES)
    return buildStationBasisUnavailableToolResult();
  const model = buildBasisPanelViewModel(projection);
  return {
    content: [
      {
        type: 'text' as const,
        text: `${model.standing.label}: ${model.standing.description}`,
      },
    ],
    structuredContent: projection,
  };
}

export function registerBasisTools(registry: StationControlToolRegistry) {
  resource ??= buildBasisPanelUiResource(null, {
    uri: STATION_BASIS_MCP_RESOURCE_URI,
  });
  if (Buffer.byteLength(resource.resource.text, 'utf8') > MAX_RESOURCE_BYTES)
    throw new Error('Station Basis MCP App resource exceeds 500 KiB');
  registry.resource(
    'station-basis-v1',
    STATION_BASIS_MCP_RESOURCE_URI,
    resource.resource,
  );
  registry.appTool(
    STATION_BASIS_MCP_TOOL_NAME,
    'Read one exact authorized Station answer Basis projection.',
    stationBasisToolInputSchema,
    {
      _meta: {
        ...buildBasisPanelAppToolMeta(STATION_BASIS_MCP_RESOURCE_URI),
        ui: {
          resourceUri: STATION_BASIS_MCP_RESOURCE_URI,
          visibility: ['model'],
        },
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const projection =
          args.scope === 'answer'
            ? await getAnswerBasis(
                resolveControlApiBase(),
                args.sessionId,
                args.turnId,
                controlRequestOptions(),
              )
            : await getTaskBasis(resolveControlApiBase(), args.taskId, {
                answerReferenceId: args.answerReferenceId,
                request: controlRequestOptions(),
              });
        return buildStationBasisProjectionToolResult(projection);
      } catch (error) {
        const status = (error as { status?: number }).status;
        return buildStationBasisUnavailableToolResult(status === 503);
      }
    },
  );
  taskResource ??= buildStationTaskBasisMcpAppResource();
  if (Buffer.byteLength(taskResource.text, 'utf8') > MAX_RESOURCE_BYTES)
    throw new Error('Station Task Basis MCP App resource exceeds 500 KiB');
  registry.resource(
    'station-task-basis-v3',
    STATION_TASK_BASIS_MCP_RESOURCE_URI,
    taskResource,
  );
  registry.appTool(
    STATION_TASK_BASIS_MCP_TOOL_NAME,
    'Read the authorized Basis collection for one Station Task, one bounded page at a time.',
    taskBasisAppInputSchema,
    {
      _meta: {
        ...buildBasisPanelAppToolMeta(STATION_TASK_BASIS_MCP_RESOURCE_URI),
        ui: {
          resourceUri: STATION_TASK_BASIS_MCP_RESOURCE_URI,
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
      try {
        const body = await api(
          `/api/tasks/${encodeURIComponent(args.taskId)}/basis/app-read`,
          {
            method: 'POST',
            body: JSON.stringify(
              args.continuationToken
                ? { continuationToken: args.continuationToken }
                : {},
            ),
          },
        );
        const page = body?.success
          ? parseStationTaskBasisMcpPage(body.data)
          : null;
        const capability = body?.meta?.['station.task-basis-app/v1'];
        if (!isStationControlCallerCurrent()) {
          if (
            capability &&
            typeof capability.occurrenceId === 'string' &&
            /^[A-Za-z0-9_-]{24,128}$/.test(capability.occurrenceId)
          ) {
            await api(
              `/api/tasks/${encodeURIComponent(args.taskId)}/basis/app-read`,
              {
                method: 'DELETE',
                body: JSON.stringify({ occurrenceId: capability.occurrenceId }),
              },
            );
          }
          return buildStationBasisUnavailableToolResult();
        }
        if (!page || !capability || typeof capability.occurrenceId !== 'string')
          return buildStationBasisUnavailableToolResult();
        const result = {
          content: [
            { type: 'text' as const, text: 'Task Basis page available.' },
          ],
          structuredContent: page,
          _meta: {
            'station.task-basis-app/v1': {
              occurrenceId: capability.occurrenceId,
              ...(typeof capability.continuationToken === 'string'
                ? { continuationToken: capability.continuationToken }
                : {}),
            },
          },
        };
        return Buffer.byteLength(JSON.stringify(result), 'utf8') <=
          MAX_RESULT_BYTES
          ? result
          : buildStationBasisUnavailableToolResult();
      } catch {
        return buildStationBasisUnavailableToolResult(true);
      }
    },
  );
}
