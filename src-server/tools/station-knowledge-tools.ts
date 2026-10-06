import {
  createKnowledgeRecord,
  getKnowledgeRecord,
  listKnowledgeRecordsByType,
  listKnowledgeRoots,
  searchKnowledgeIndex,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  getStationControlCaller,
  jsonToolResult,
  resolveControlApiBase,
  StationControlCallerRequiredError,
  toToolEnvelope,
} from './station-control-shared.js';

const rootId = z.string().min(1).max(300);
const recordId = z.string().min(1).max(200);
const recordType = z.enum(['raw', 'compiled', 'concept', 'snapshot', 'person']);

function registerKnowledgeSearchTool(server: StationControlToolRegistry) {
  server.tool(
    'search_knowledge',
    'Search accessible Knowledge records. Requires a configured embedding connection.',
    {
      query: z.string().min(1),
      rootIds: z.array(rootId).optional(),
      topK: z.number().int().positive().optional(),
    },
    async (input) =>
      jsonToolResult(
        await toToolEnvelope(
          searchKnowledgeIndex(
            resolveControlApiBase(),
            input,
            controlRequestOptions(),
          ),
        ),
      ),
  );
}

export function registerKnowledgeDataTools(server: StationControlToolRegistry) {
  server.tool(
    'list_knowledge_roots',
    'List accessible Knowledge stores.',
    {},
    async () =>
      jsonToolResult(
        await toToolEnvelope(
          listKnowledgeRoots(
            resolveControlApiBase(),
            controlRequestOptions(),
          ).then((roots) =>
            roots.map(({ id, displayName, scope, adapterId }) => ({
              id,
              displayName,
              scope,
              adapterId,
            })),
          ),
        ),
      ),
  );

  server.tool(
    'list_knowledge_records',
    'List accessible records of one type in a Knowledge store.',
    { rootId, type: recordType },
    async ({ rootId, type }) =>
      jsonToolResult(
        await toToolEnvelope(
          listKnowledgeRecordsByType(
            resolveControlApiBase(),
            rootId,
            type,
            undefined,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'get_knowledge_record',
    'Read one accessible Knowledge record by its exact ID.',
    { rootId, id: recordId },
    async ({ rootId, id }) =>
      jsonToolResult(
        await toToolEnvelope(
          getKnowledgeRecord(
            resolveControlApiBase(),
            rootId,
            id,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'add_knowledge_record',
    'Capture a new raw Knowledge record in an accessible writable store. Existing records are never replaced.',
    {
      rootId,
      title: z.string().min(1),
      body: z.string().min(1),
      category: z.string().min(1).default('notes'),
      tags: z.array(z.string()).optional(),
      sourceIds: z.array(recordId).optional(),
    },
    async ({ rootId, title, body, category, tags, sourceIds }) => {
      const caller = await getStationControlCaller();
      if (!caller) throw new StationControlCallerRequiredError();
      return jsonToolResult(
        await toToolEnvelope(
          createKnowledgeRecord(
            resolveControlApiBase(),
            rootId,
            {
              type: 'raw',
              title,
              body,
              category,
              tags,
              provenance: {
                agent: 'station-knowledge',
                ...(caller.assurance === 'bound'
                  ? { session_id: caller.sessionId }
                  : {}),
                note: `Captured through ${caller.assurance} MCP custody.`,
                ...(sourceIds ? { source_ids: sourceIds } : {}),
              },
            },
            controlRequestOptions(),
          ),
        ),
      );
    },
  );

  registerKnowledgeSearchTool(server);
}
