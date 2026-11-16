/**
 * #5067: a Session reads its Project's Library: the files people added and
 * the files the Project's Tasks kept. Every engine with station-control gets
 * the same two tools, so an uploaded file reaches any Session in the Project
 * without being copied into its workspace.
 *
 * Authority never comes from arguments. The REST side
 * (`routes/projects/project-library-routes.ts`) reads the Project Station
 * recorded for the verified caller's Session when it started.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const LIBRARY_API_PATH = '/api/orchestration/station-control/project-library';

const LIST_DESCRIPTION =
  "List your Project's Library: files people added (`kind: upload`, named by `relativePath`) and files the Project's Tasks kept (`kind: task-output`, named by `outputId`, with the Task that kept it, or `task.state: orphaned` when that Task was deleted). Read one with `read_project_library_file`. Fails with `no_project` when this session was not started in a Project.";

const READ_DESCRIPTION =
  "Read one file from your Project's Library. Pass `path` (an upload's `relativePath`) or `outputId` (a Task output), never both. Text comes back as `text`; anything else as `base64`. Both stop at 256 KiB (`truncated: true`).";

export function registerProjectLibraryTools(
  registry: StationControlToolRegistry,
) {
  registry.tool('list_project_library', LIST_DESCRIPTION, {}, async () =>
    jsonToolResult(await api(LIBRARY_API_PATH)),
  );
  registry.tool(
    'read_project_library_file',
    READ_DESCRIPTION,
    {
      path: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe("An upload's relativePath from list_project_library."),
      outputId: z
        .string()
        .min(1)
        .max(240)
        .optional()
        .describe("A Task output's outputId from list_project_library."),
    },
    async (args) => {
      const query = new URLSearchParams();
      if (args.path !== undefined) query.set('path', args.path);
      if (args.outputId !== undefined) query.set('outputId', args.outputId);
      return jsonToolResult(
        await api(`${LIBRARY_API_PATH}/file?${query.toString()}`),
      );
    },
  );
}
