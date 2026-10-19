import {
  getPersonalBoard,
  listPersonalLayouts,
  proposePersonalBoard,
} from '@kontourai/station-sdk/client';
import { personalBoardSlugSchema } from '@kontourai/station-sdk/personal-board';
import {
  fromJsonSchema,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { personalBoardProposalSchema } from '../routes/schemas/schema-definitions/personal-board.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope,
} from './station-control-shared.js';

export function registerPersonalBoardTools(server: StationControlToolRegistry) {
  server.tool(
    'list_personal_boards',
    'List the current person’s saved Personal Boards. These are dashboards in the sidebar, separate from Task/session board faces.',
    {},
    async () =>
      jsonToolResult(
        await toToolEnvelope(
          listPersonalLayouts(resolveControlApiBase(), controlRequestOptions()),
        ),
      ),
  );
  server.tool(
    'get_personal_board',
    'Read a Personal Board’s saved definition, pending proposal and revision. Read before proposing an edit; preserve sections the person did not ask to change.',
    { slug: z.string().min(1) },
    async ({ slug }) =>
      jsonToolResult(
        await toToolEnvelope(
          getPersonalBoard(
            resolveControlApiBase(),
            slug,
            controlRequestOptions(),
          ),
        ),
      ),
  );
  const proposalInput = personalBoardProposalSchema.extend({
    slug: personalBoardSlugSchema,
  });
  server.toolWithSchema(
    'propose_personal_board',
    'Propose a Personal Board dashboard or an edit. Use revision:null only for a new unique slug; edits require get_personal_board’s revision. Supports live tasks, attention, recent-work, projects, notes and links. Live sections read current authorized Station sources; do not put invented live data in notes. This saves a proposal, not a published dashboard. Return /boards/<slug> to the person and ask them to Preview and Apply in Station. Never claim it was applied.',
    fromJsonSchema(zodToJsonSchema(proposalInput) as JsonSchemaType),
    async (raw) => {
      const { slug, ...input } = proposalInput.parse(raw);
      const result = await toToolEnvelope(
        proposePersonalBoard(
          resolveControlApiBase(),
          slug,
          input,
          controlRequestOptions(),
        ),
      );
      return jsonToolResult({
        ...result,
        openPath: `/boards/${encodeURIComponent(slug)}`,
        state: result.success
          ? 'proposed'
          : result.outcome === 'indeterminate'
            ? 'unconfirmed'
            : 'refused',
      });
    },
  );
}
