import {
  getProject,
  getProjectCheckoutFreshness,
  listProjectLayouts,
  listProjects,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope,
} from './station-control-shared.js';

/**
 * The Project, with `checkoutFreshness` when the host answers it (the Stale
 * checkout warning preview is on), so an agent started in a Project can see
 * that its checkout is far behind. A freshness read that fails or is not
 * offered leaves the field out; it never fails the Project read.
 */
async function getProjectWithCheckoutFreshness(slug: string) {
  const apiBase = resolveControlApiBase();
  const options = controlRequestOptions();
  const project = await getProject(apiBase, slug, options);
  const checkoutFreshness = await getProjectCheckoutFreshness(
    apiBase,
    slug,
    options,
  ).catch(() => null);
  return checkoutFreshness ? { ...project, checkoutFreshness } : project;
}

/** Shared Project read registrations with caller-owned access. */
export function registerProjectReadTools(
  server: Pick<StationControlToolRegistry, 'tool'>,
  reads: {
    list(): Promise<unknown>;
    get(slug: string): Promise<unknown>;
    layouts?(slug: string): Promise<unknown>;
  } = {
    list: () => listProjects(resolveControlApiBase(), controlRequestOptions()),
    get: getProjectWithCheckoutFreshness,
    layouts: (slug) =>
      listProjectLayouts(
        resolveControlApiBase(),
        slug,
        controlRequestOptions(),
      ),
  },
) {
  server.tool('list_projects', 'List readable projects', {}, async () =>
    jsonToolResult(await toToolEnvelope(reads.list())),
  );
  server.tool(
    'get_project',
    // The outside-agent dispatch registers this same description and never
    // carries `checkoutFreshness`, so the description does not promise it.
    'Get project details',
    { slug: z.string() },
    async ({ slug }) => jsonToolResult(await toToolEnvelope(reads.get(slug))),
  );
  const layouts = reads.layouts;
  if (layouts) {
    server.tool(
      'list_project_layouts',
      'List layouts for a project',
      { slug: z.string() },
      async ({ slug }) => jsonToolResult(await toToolEnvelope(layouts(slug))),
    );
  }
}
