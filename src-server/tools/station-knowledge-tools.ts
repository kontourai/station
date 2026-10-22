import {
  createKnowledgeRecord,
  getKnowledgeRecord,
  listKnowledgeRecordsByType,
  listKnowledgeRoots,
  listProjectS3Objects,
  listProjectS3Sources,
  readProjectS3Object,
  searchKnowledgeIndex,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';
import { projectS3SourcesEnabled } from '../services/projects/project-s3-sources.js';
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
  if (projectS3SourcesEnabled()) {
    const projectSlug = z.string().min(1).max(200);
    const sourceId = z.string().uuid();
    server.tool(
      'list_project_s3_sources',
      'List read-only S3 prefixes explicitly attached to an accessible Project.',
      { projectSlug },
      async ({ projectSlug }) =>
        jsonToolResult(
          await toToolEnvelope(
            listProjectS3Sources(
              resolveControlApiBase(),
              projectSlug,
              controlRequestOptions(),
            ),
          ),
        ),
    );
    server.tool(
      'list_project_s3_objects',
      'Read one bounded S3 listing page within an attached prefix. A page is not complete bucket coverage. Follow continuation explicitly.',
      { projectSlug, sourceId, cursor: z.string().max(4096).optional() },
      async ({ projectSlug, sourceId, cursor }) =>
        jsonToolResult(
          await toToolEnvelope(
            listProjectS3Objects(
              resolveControlApiBase(),
              projectSlug,
              sourceId,
              cursor,
              controlRequestOptions(),
            ),
          ),
        ),
    );
    server.tool(
      'read_project_s3_object',
      'Read one listed Markdown/text S3 object (at most 256 KiB), pinned to its ETag. Cite the returned object/version identity. Never writes to S3.',
      {
        projectSlug,
        sourceId,
        key: z.string().min(1).max(1024),
        etag: z.string().min(1).max(200),
      },
      async ({ projectSlug, sourceId, key, etag }) =>
        jsonToolResult(
          await toToolEnvelope(
            readProjectS3Object(
              resolveControlApiBase(),
              projectSlug,
              sourceId,
              key,
              etag,
              controlRequestOptions(),
            ),
          ),
        ),
    );
  }
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
