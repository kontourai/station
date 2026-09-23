import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  listPlugins,
  PluginCollectionHttpError,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';

import {
  pluginValidateResult,
  refusePluginValidateSource,
} from '../services/plugins/plugin-validate-source.js';
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
 * `check_plugin_updates`, `update_plugin`, `remove_plugin` stay on `api()` —
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

/**
 * The agent and conversation a proposing call came from. Stamped by
 * `mcp-manager.ts` for Station's own agents (overwriting anything the model
 * wrote); an external engine may supply or omit it. The route honours it
 * only for Station's internal caller class, and only as display provenance.
 */
const sourceContextSchema = z
  .object({
    agentSlug: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .optional();

/**
 * Says plainly what happened: a proposal exists, nothing was changed. The
 * route's own envelope is kept whole so a refusal (cap, unknown plugin, bad
 * source) reads exactly as the route wrote it.
 */
function proposalToolResult(
  response: unknown,
  kind: 'install' | 'update' | 'remove',
) {
  const envelope = (response ?? {}) as {
    success?: boolean;
    deduplicated?: boolean;
    proposal?: { id?: string };
  };
  const changed =
    kind === 'install'
      ? { installed: false }
      : kind === 'update'
        ? { updated: false }
        : { removed: false };
  if (envelope.success !== true) return { ...changed, ...envelope };
  return {
    ...changed,
    ...envelope,
    message: envelope.deduplicated
      ? 'This change was already proposed and is still open. A person completes it from Plugins; nothing was changed.'
      : 'Proposed. A person sees this in Needs attention and completes it from Plugins; nothing was changed yet. Tell them what you proposed and why.',
  };
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
    // defect, and this one could not perform it honestly. #2323 S5 keeps it
    // refusing rather than turning it into a proposing alias: an agent that
    // called a tool named "install" and got success would report the plugin
    // installed. It now names the tool that does what it can: propose.
    'Explain how to get a plugin installed. This tool cannot install one: a person approves every install on a preview. Call propose_plugin_install to ask a person to install it.',
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
      // where the decision can actually be taken. (#2323 S5: the route now
      // refuses this caller class too, so the refusal no longer rests on
      // this tool alone.)
      jsonToolResult({
        installed: false,
        source,
        reason: 'operator-approval-required',
        message:
          `Station did not install ${source}. A plugin install is approved by a person before anything is written. ` +
          'Call propose_plugin_install with this source and a rationale: the person sees the proposal in Needs attention, ' +
          'reviews the preview (permissions and the parts that run in Station’s own page), and installs it from there.',
      }),
  );

  server.tool(
    'propose_plugin_install',
    // #2323 S5. The agent's half of "agent proposes, person installs". It
    // records an ask and nothing else: the person completes it through the
    // ordinary preview → consent → install flow, and nothing this returns
    // can be echoed into `/install` as a decision.
    'Ask a person to install a plugin. Records a proposal the person sees in Needs attention; they review the install preview and install it themselves. Nothing is installed by this call. Local folders (absolute path) or git URLs. Run validate_plugin first for a local folder.',
    {
      source: z
        .string()
        .min(1)
        .describe(
          'Absolute path to the local plugin folder (containing plugin.json), or a git URL',
        ),
      rationale: z
        .string()
        .min(1)
        .max(2000)
        .describe('Why this plugin should be installed, for the person'),
      _sourceContext: sourceContextSchema,
    },
    async ({ source, rationale, _sourceContext }) =>
      jsonToolResult(
        proposalToolResult(
          await api('/api/plugin-proposals', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'install',
              source: source.trim(),
              rationale,
              ...(_sourceContext ? { _sourceContext } : {}),
            }),
          }),
          'install',
        ),
      ),
  );

  server.tool(
    'validate_plugin',
    // #2323 S1. The authoring half of the install story: an agent that wrote
    // a plugin can check it here before asking a person to install it. The
    // route returns diagnostics and a contribution summary and nothing an
    // install could consume as a decision (no content digest, no grant
    // revision), so this does not reopen the door `install_plugin` closes.
    // It is auto-approved as read-only, so it takes LOCAL folders only: a git
    // URL would make it a network fetch on an agent's say-so. The route
    // refuses those too; refusing here as well means no request is made.
    'Check a local plugin folder for authoring errors without installing it: the manifest, its Workspace Panes, prompt-file safety, and conflicts with what is already installed. Returns diagnostics. Local folders only (an absolute path); it refuses git URLs and network paths, and it does not resolve dependencies, install, or build the bundle. A person installs from Plugins → Install plugin after reviewing the preview. Read the station-docs topic `plugin-authoring` for the format.',
    {
      source: z
        .string()
        .min(1)
        .describe(
          'Absolute path to the local plugin folder (the one containing plugin.json)',
        ),
    },
    async ({ source }) => {
      // The route's own refusal, applied here so a refused source makes no
      // request at all; same codes and the same result shape either way.
      // Trimmed first, as the route's request schema trims, so a padded
      // source gets the route's code rather than a tool-only one.
      const trimmed = source.trim();
      const refused = refusePluginValidateSource(trimmed);
      if (refused) {
        return jsonToolResult(pluginValidateResult(trimmed, [refused]));
      }
      return jsonToolResult(
        await api('/api/plugins/validate', {
          method: 'POST',
          body: JSON.stringify({ source: trimmed }),
        }),
      );
    },
  );

  server.tool(
    'check_plugin_updates',
    'Check for available plugin updates',
    {},
    async () => jsonToolResult(await api('/api/plugins/check-updates')),
  );

  server.tool(
    'update_plugin',
    // #2323 S5 (owner decision 3): an update pulls new code into Station, so
    // it is a person's decision like an install. This records a proposal;
    // `POST /api/plugins/:name/update` refuses this caller class.
    'Ask a person to update an installed plugin. Records a proposal the person sees in Needs attention; they run the update from Plugins. Nothing is updated by this call.',
    {
      name: z.string().describe('Plugin name'),
      rationale: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('Why it should be updated, for the person'),
      _sourceContext: sourceContextSchema,
    },
    async ({ name, rationale, _sourceContext }) =>
      jsonToolResult(
        proposalToolResult(
          await api('/api/plugin-proposals', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'update',
              pluginName: name,
              rationale:
                rationale?.trim() || 'An agent asked to update this plugin.',
              ...(_sourceContext ? { _sourceContext } : {}),
            }),
          }),
          'update',
        ),
      ),
  );

  server.tool(
    'remove_plugin',
    // #2323 S5 (owner decision 3): same path as update.
    'Ask a person to remove an installed plugin. Records a proposal the person sees in Needs attention; they confirm the removal in Plugins. Nothing is removed by this call.',
    {
      name: z.string().describe('Plugin name'),
      rationale: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('Why it should be removed, for the person'),
      _sourceContext: sourceContextSchema,
    },
    async ({ name, rationale, _sourceContext }) =>
      jsonToolResult(
        proposalToolResult(
          await api('/api/plugin-proposals', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'remove',
              pluginName: name,
              rationale:
                rationale?.trim() || 'An agent asked to remove this plugin.',
              ...(_sourceContext ? { _sourceContext } : {}),
            }),
          }),
          'remove',
        ),
      ),
  );
}
