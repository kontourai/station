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
  "List your Project's Library: uploads by relativePath, Task-kept files by outputId (orphaned when their Task was deleted).";

const READ_DESCRIPTION =
  'Read one Library file by path or outputId. Returns text or base64, up to 256 KiB.';

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
      path: z.string().min(1).max(1024).optional(),
      outputId: z.string().min(1).max(240).optional(),
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
