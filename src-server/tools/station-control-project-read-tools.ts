import { getProject, listProjects } from '@kontourai/station-sdk/client';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope,
} from './station-control-shared.js';

/** Shared callbacks; the outside adapter supplies scoped domain reads, never internal credentials. */
export function registerProjectReadTools(
  server: Pick<StationControlToolRegistry, 'tool'>,
  reads: { list(): Promise<unknown>; get(slug: string): Promise<unknown> } = {
    list: () => listProjects(resolveControlApiBase(), controlRequestOptions()),
    get: (slug) =>
      getProject(resolveControlApiBase(), slug, controlRequestOptions()),
  },
) {
  server.tool('list_projects', 'List readable projects', {}, async () =>
    jsonToolResult(await toToolEnvelope(reads.list())),
  );
  server.tool(
    'get_project',
    'Get project details',
    { slug: z.string() },
    async ({ slug }) => jsonToolResult(await toToolEnvelope(reads.get(slug))),
  );
}
