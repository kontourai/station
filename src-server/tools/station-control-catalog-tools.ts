import {
  fetchRegistrySkills,
  fetchSystemSkills,
  installRegistrySkill,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope as toCatalogEnvelope,
} from './station-control-shared.js';

function controlApiBase(): string {
  return resolveControlApiBase();
}

export function registerCatalogTools(server: StationControlToolRegistry) {
  server.tool('list_skills', 'List locally installed skills', {}, async () =>
    jsonToolResult(
      await toCatalogEnvelope(
        fetchSystemSkills(controlApiBase(), controlRequestOptions()),
      ),
    ),
  );
  server.tool(
    'list_registry_skills',
    'List skills available from the registry',
    {},
    async () =>
      jsonToolResult(
        await toCatalogEnvelope(
          fetchRegistrySkills(controlApiBase(), controlRequestOptions()),
        ),
      ),
  );
  server.tool(
    'install_skill',
    'Install a skill from the registry',
    { id: z.string() },
    async ({ id }) => {
      try {
        return jsonToolResult(
          await installRegistrySkill(
            controlApiBase(),
            id,
            controlRequestOptions(),
          ),
        );
      } catch (error) {
        return jsonToolResult({
          success: false,
          message: error instanceof Error ? error.message : 'Install failed',
        });
      }
    },
  );
  server.tool(
    'uninstall_skill',
    'Uninstall a skill',
    { id: z.string() },
    async ({ id }) =>
      jsonToolResult(
        await api(`/api/registry/skills/${id}`, { method: 'DELETE' }),
      ),
  );
  // Mirrors what `PUT /api/skills/:name` accepts (`localSkillUpdateSchema`).
  // A narrower tool is not a safer tool — it is a tool that cannot reach the
  // route's own refusals: without `command`/`variables` an agent could never
  // provoke the 409 a read-only skill answers with, so that behaviour was
  // unreachable and untested through this boundary (review M2).
  server.tool(
    'update_skill',
    'Update a local skill: body, description, category, tags, agent/global binding, command declaration, or variable metadata. `newName` renames it.',
    {
      name: z.string(),
      newName: z.string().optional(),
      body: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      agent: z.string().optional(),
      global: z.boolean().optional(),
      command: z
        .object({
          enabled: z.boolean(),
          name: z.string().optional(),
          global: z.boolean().optional(),
        })
        .optional(),
      variables: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            default: z.string().optional(),
          }),
        )
        .optional(),
      // Stamped by `mcp-manager.ts` for an agent-authored call, and honoured
      // only because `api()` carries the internal token. Declared so the
      // injection is part of the contract rather than an undeclared extra.
      _sourceContext: z
        .object({
          kind: z.enum(['agent', 'plugin', 'user', 'asset']),
          agentSlug: z.string().optional(),
          conversationId: z.string().optional(),
        })
        .optional(),
    },
    async ({ name, newName, ...rest }) =>
      jsonToolResult(
        await api(`/api/skills/${encodeURIComponent(name)}`, {
          method: 'PUT',
          // `name` is the ROUTE key; a rename travels as `newName` so a plain
          // update can never rename the skill to itself-by-accident.
          body: JSON.stringify(
            newName === undefined ? rest : { ...rest, name: newName },
          ),
        }),
      ),
  );
  server.tool(
    'track_skill_run',
    'Record that a skill was used',
    { name: z.string() },
    async ({ name }) =>
      jsonToolResult(
        await api(`/api/skills/${encodeURIComponent(name)}/run`, {
          method: 'POST',
        }),
      ),
  );
  server.tool(
    'record_skill_outcome',
    'Record a skill outcome',
    { name: z.string(), outcome: z.enum(['success', 'failure']) },
    async ({ name, outcome }) =>
      jsonToolResult(
        await api(`/api/skills/${encodeURIComponent(name)}/outcome`, {
          method: 'POST',
          body: JSON.stringify({ outcome }),
        }),
      ),
  );
}
