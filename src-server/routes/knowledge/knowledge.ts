import type { KnowledgeNamespaceConfig } from '@kontourai/station-contracts/knowledge';
import { Hono } from 'hono';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import type { ProviderService } from '../../services/connections/provider-service.js';
import type { KnowledgeService } from '../../services/knowledge/knowledge-service.js';
import {
  errorMessage,
  getBody,
  knowledgeNamespaceCreateSchema,
  knowledgeNamespaceUpdateSchema,
  param,
  validate,
} from '../schemas/schemas.js';
import { createCrossProjectKnowledgeRoutes as createCrossProjectKnowledgeRouteHandlers } from './knowledge-cross-project.js';
import { createKnowledgeDocumentRoutes } from './knowledge-document-routes.js';

// ── Per-project knowledge routes (mounted at /api/projects/:slug/knowledge) ──

export function createKnowledgeRoutes(knowledgeService: KnowledgeService) {
  const app = new Hono<{ Variables: { slug: string } }>();

  app.use('*', async (c, next) => {
    c.set('slug', c.req.param('slug') ?? '');
    await next();
  });

  // Namespace CRUD
  app.get('/namespaces', (c) => {
    try {
      const data = knowledgeService.listNamespaces(c.get('slug'));
      return c.json({ success: true, data });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.post(
    '/namespaces',
    validate(knowledgeNamespaceCreateSchema),
    async (c) => {
      try {
        const body = getBody(c) as KnowledgeNamespaceConfig;
        await knowledgeService.registerNamespace(c.get('slug'), body);
        return c.json({ success: true }, 201);
      } catch (e: unknown) {
        return c.json({ success: false, error: errorMessage(e) }, 500);
      }
    },
  );

  app.delete('/namespaces/:nsId', async (c) => {
    try {
      await knowledgeService.removeNamespace(c.get('slug'), param(c, 'nsId'));
      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.put(
    '/namespaces/:nsId',
    validate(knowledgeNamespaceUpdateSchema),
    async (c) => {
      try {
        const body = getBody(c);
        await knowledgeService.updateNamespace(
          c.get('slug'),
          param(c, 'nsId'),
          body,
        );
        return c.json({ success: true });
      } catch (e: unknown) {
        return c.json({ success: false, error: errorMessage(e) }, 500);
      }
    },
  );

  // Namespaced document routes: /ns/:namespace/*
  app.route(
    '/ns/:namespace',
    createKnowledgeDocumentRoutes(
      knowledgeService,
      (c) => c.get('slug') ?? c.req.param('slug'),
      (c) => c.req.param('namespace'),
    ),
  );

  // Default (backward-compat) document routes — no namespace = 'default'
  app.route(
    '/',
    createKnowledgeDocumentRoutes(
      knowledgeService,
      (c) => c.get('slug') ?? c.req.param('slug'),
      () => undefined,
    ),
  );

  return app;
}

// ── Cross-project knowledge routes (mounted at /api/knowledge) ──

export function createCrossProjectKnowledgeRoutes(
  knowledgeService: KnowledgeService,
  storageAdapter: IStorageAdapter,
  providerService: ProviderService,
) {
  return createCrossProjectKnowledgeRouteHandlers(
    knowledgeService,
    storageAdapter,
    providerService,
  );
}
