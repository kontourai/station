import { Hono } from 'hono';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import type { ProviderService } from '../../services/connections/provider-service.js';
import type { KnowledgeService } from '../../services/knowledge/knowledge-service.js';
import {
  errorMessage,
  getBody,
  knowledgeSearchSchema,
  validate,
} from '../schemas/schemas.js';

export function createCrossProjectKnowledgeRoutes(
  knowledgeService: KnowledgeService,
  storageAdapter: IStorageAdapter,
  providerService: ProviderService,
) {
  const app = new Hono();

  app.get('/status', async (c) => {
    try {
      const connections = providerService.listProviderConnections();
      // The one in use (turned on), else a configured one that is turned off,
      // so a reader can say "turned off" rather than "none".
      const configured = (capability: 'vectordb' | 'embedding') => {
        const all = connections.filter((connection) =>
          connection.capabilities.includes(capability),
        );
        return all.find((connection) => connection.enabled) ?? all[0] ?? null;
      };
      const vectorDbConn = configured('vectordb');
      const embeddingConn = configured('embedding');

      const projects = storageAdapter.listProjects();
      let totalDocuments = 0;
      let totalChunks = 0;
      for (const project of projects) {
        const docs = await knowledgeService.listDocuments(project.slug);
        totalDocuments += docs.length;
        totalChunks += docs.reduce((sum, doc) => sum + doc.chunkCount, 0);
      }

      return c.json({
        success: true,
        data: {
          vectorDb: vectorDbConn
            ? {
                id: vectorDbConn.id,
                name: vectorDbConn.name,
                type: vectorDbConn.type,
                enabled: vectorDbConn.enabled,
              }
            : null,
          embedding: embeddingConn
            ? {
                id: embeddingConn.id,
                name: embeddingConn.name,
                type: embeddingConn.type,
                enabled: embeddingConn.enabled,
              }
            : null,
          stats: { totalDocuments, totalChunks, projectCount: projects.length },
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/search', validate(knowledgeSearchSchema), async (c) => {
    try {
      const { query, topK = 5, namespace } = getBody(c);
      const projects = storageAdapter.listProjects();
      const allResults: Array<{ projectSlug: string; results: any[] }> = [];

      for (const project of projects) {
        const results = await knowledgeService.searchDocuments(
          project.slug,
          query,
          topK,
          namespace,
        );
        if (results.length > 0) {
          allResults.push({ projectSlug: project.slug, results });
        }
      }

      return c.json({ success: true, data: allResults });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
