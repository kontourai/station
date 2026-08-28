import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  listPlugins,
  PluginCollectionHttpError,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';

import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope as toPlatformEnvelope,
} from './station-control-shared.js';

/**
 * archive#167 Wave 3: `list_integrations`/`get_integration`/`create_integration`/
 * `delete_integration` now run through `@kontourai/station-sdk/client`'s
 * canonical `client/integrations.ts` fetchers instead of this file's own
 * inline `api()` calls, mirroring Wave 2B's approach. `apiBase` is resolved
 * once at module load (station-control is a long-lived MCP server process —
 * see the matching note in `station-control-agent-tools.ts` and archive#167 plan
 * Risk 3).
 *
 * `list_registry_integrations`/`install_registry_integration` are left on
 * the pre-#167 `api()` passthrough: no canonical `@kontourai/station-sdk/client`
 * fetcher exists for `GET /api/registry/integrations` or
 * `POST /api/registry/integrations/install` (Wave 1's audited triplication
 * table only named the 6 bare `/integrations` operations for
 * `client/integrations.ts` — the only registry-integrations consumer today,
 * `packages/sdk/src/query-domains/catalogRequests.ts`, resolves its own
 * `apiBase` via the React-coupled `_getApiBase()` singleton and is not part
 * of the portable `client/**` surface). Documented, narrow exception, same
 * class as `station-control-agent-tools.ts`'s `get_agent` and
 * `station-control-catalog-tools.ts`'s `uninstall_skill`.
 *
 * `list_providers`, `create_provider`, `install_plugin`,
 * `check_plugin_updates`, `update_plugin`, `remove_plugin` are untouched —
 * none are in the archive#167 audit's triplication table (providers/plugins have
 * their own separate CLI-gap findings, not duplication).
 */
// archive#1195: resolved fresh on every call (see station-control-shared.ts's
// `api()` doc comment) -- a module-load-time freeze here would be wrong once
// these same tool registrations are reachable from Station's own long-lived
// process (station-control-mcp-route.ts), not only a freshly-spawned stdio
// child whose env was already correct before the module ever loaded.
function controlApiBase(): string {
  return resolveControlApiBase();
}

async function listPluginEnvelope() {
  try {
    return {
      plugins: await listPlugins(controlApiBase(), controlRequestOptions()),
    };
  } catch (error) {
    if (error instanceof PluginCollectionHttpError) return error.envelope;
    throw error;
  }
}

export function registerPlatformTools(server: StationControlToolRegistry) {
  server.tool(
    'list_integrations',
    'List configured MCP tool servers',
    {},
    async () =>
      jsonToolResult(
        await toPlatformEnvelope(
          listIntegrations(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'get_integration',
    'Get integration details',
    { id: z.string() },
    async ({ id }) =>
      jsonToolResult(
        await toPlatformEnvelope(
          getIntegration(controlApiBase(), id, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'create_integration',
    'Create a new MCP tool server integration',
    {
      id: z.string().describe('Unique identifier'),
      displayName: z.string().optional(),
      description: z.string().optional(),
      transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio'),
      command: z.string().optional().describe('For stdio: command to run'),
      args: z
        .array(z.string())
        .optional()
        .describe('For stdio: command arguments'),
      endpoint: z.string().optional().describe('For sse/http: server URL'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment variables'),
    },
    async (params) =>
      jsonToolResult(
        await toPlatformEnvelope(
          createIntegration(
            controlApiBase(),
            { ...params, kind: 'mcp' },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'delete_integration',
    'Remove an integration',
    { id: z.string() },
    async ({ id }) =>
      jsonToolResult(
        await toPlatformEnvelope(
          deleteIntegration(controlApiBase(), id, controlRequestOptions()),
        ),
      ),
  );

  server.tool(
    'list_registry_integrations',
    'Browse available integrations from the registry',
    {},
    async () => jsonToolResult(await api('/api/registry/integrations')),
  );

  server.tool(
    'install_registry_integration',
    'Install an integration from the registry',
    { id: z.string() },
    async ({ id }) =>
      jsonToolResult(
        await api('/api/registry/integrations/install', {
          method: 'POST',
          body: JSON.stringify({ id }),
        }),
      ),
  );

  server.tool(
    'list_providers',
    'List LLM/embedding provider connections',
    {},
    async () => jsonToolResult(await api('/api/providers')),
  );

  server.tool(
    'create_provider',
    'Add a new provider connection',
    {
      type: z
        .string()
        .describe('Provider type: bedrock, ollama, openai-compat'),
      name: z.string(),
      config: z
        .record(z.string(), z.any())
        .describe('Provider-specific config (region, baseUrl, apiKey, etc.)'),
    },
    async (params) =>
      jsonToolResult(
        await api('/api/providers', {
          method: 'POST',
          body: JSON.stringify({
            ...params,
            id: crypto.randomUUID(),
            enabled: true,
            capabilities: ['llm'],
          }),
        }),
      ),
  );

  server.tool('list_plugins', 'List installed plugins', {}, async () =>
    jsonToolResult(await listPluginEnvelope()),
  );

  server.tool(
    'install_plugin',
    // archive#4288. It no longer installs, and the description no longer says
    // it does: a tool advertising a capability it cannot perform is its own
    // defect, and this one could not perform it honestly.
    'Explain how to install a plugin. This tool cannot install one: installing needs an approval a person gives on a preview, and this tool has no person in its loop.',
    {
      source: z
        .string()
        .describe('Plugin source — local path, git URL, or npm package'),
    },
    async ({ source }) =>
      // The alternative was a preview-then-install two-step, and it is the
      // wrong shape. `POST /install` takes the operator's decision as a
      // parameter: the derived permission set, the digest of the reviewed
      // bytes, the dependency ids. An agent can read all three back from
      // `POST /preview` and echo them into the install — which produces a
      // record saying an operator decided, when no operator saw anything.
      // That is a label nothing derives, on the one surface where a reader
      // has to be able to trust the word. There is no honest way for a tool
      // with no human in its loop to hold a decision, so it says so and names
      // where the decision can actually be taken.
      jsonToolResult({
        installed: false,
        source,
        reason: 'operator-approval-required',
        message:
          `Station did not install ${source}. A plugin install is approved before anything is written: ` +
          'the operator previews the source, reads the permissions and the parts that run in Station’s own page, ' +
          'and answers. Open the Plugins page in Station, paste this source, and install it from the preview — ' +
          'or run `station plugin install <source>` in a terminal, which prints the same disclosure and asks there.',
      }),
  );

  server.tool(
    'check_plugin_updates',
    'Check for available plugin updates',
    {},
    async () => jsonToolResult(await api('/api/plugins/check-updates')),
  );

  server.tool(
    'update_plugin',
    'Update an installed plugin',
    { name: z.string().describe('Plugin name') },
    async ({ name }) =>
      jsonToolResult(
        await api(`/api/plugins/${name}/update`, { method: 'POST' }),
      ),
  );

  server.tool(
    'remove_plugin',
    'Remove an installed plugin',
    { name: z.string().describe('Plugin name') },
    async ({ name }) =>
      jsonToolResult(await api(`/api/plugins/${name}`, { method: 'DELETE' })),
  );
}
