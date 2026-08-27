import type { LayoutTemplate } from '@kontourai/station-contracts/layout';
import { Hono } from 'hono';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { templateOps } from '../../telemetry/metrics.js';
import {
  errorMessage,
  getBody,
  param,
  templateCreateSchema,
  validate,
} from '../schemas/schemas.js';

const BUILTIN_AGENT_TEMPLATES = [
  {
    id: 'tpl-coding',
    type: 'agent',
    icon: '💻',
    label: 'Coding Assistant',
    description: 'Code generation, review, and debugging',
    source: 'built-in',
    form: {
      name: 'Coding Assistant',
      slug: 'coding-assistant',
      description: 'An AI coding assistant for development tasks',
      prompt:
        'You are a skilled software engineer. Help the user write, review, debug, and improve code. Be concise and provide working examples.',
    },
  },
  {
    id: 'tpl-research',
    type: 'agent',
    icon: '🔍',
    label: 'Research Agent',
    description: 'Information gathering and summarization',
    source: 'built-in',
    form: {
      name: 'Research Agent',
      slug: 'research-agent',
      description:
        'An AI research assistant for gathering and synthesizing information',
      prompt:
        'You are a thorough research assistant. Help the user find, analyze, and summarize information. Cite sources when possible and present findings clearly.',
    },
  },
  {
    id: 'tpl-chat',
    type: 'agent',
    icon: '💬',
    label: 'Chat',
    description: 'General-purpose conversational agent',
    source: 'built-in',
    form: {
      name: 'Chat',
      slug: 'chat',
      description: 'A general-purpose conversational AI assistant',
      prompt:
        'You are a helpful assistant. Answer questions clearly and concisely.',
    },
  },
];

export function createTemplateRoutes(storageAdapter: IStorageAdapter) {
  const app = new Hono();

  app.get('/', (c) => {
    try {
      templateOps.add(1, { op: 'list' });
      const stored = storageAdapter.listTemplates();
      const typeFilter = c.req.query('type');
      if (typeFilter === 'agent') {
        return c.json({ success: true, data: BUILTIN_AGENT_TEMPLATES });
      }
      return c.json({ success: true, data: stored });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.get('/:id', (c) => {
    try {
      const t = storageAdapter.getTemplate(param(c, 'id'));
      if (!t) return c.json({ success: false, error: 'Not found' }, 404);
      return c.json({ success: true, data: t });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.post('/', validate(templateCreateSchema), async (c) => {
    try {
      const body = getBody(c);
      const template: LayoutTemplate = {
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description,
        icon: body.icon,
        type: body.type,
        config: body.config ?? {},
        createdAt: new Date().toISOString(),
      };
      await storageAdapter.saveTemplate(template);
      templateOps.add(1, { op: 'apply' });
      return c.json({ success: true, data: template }, 201);
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.delete('/:id', async (c) => {
    try {
      await storageAdapter.deleteTemplate(param(c, 'id'));
      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  return app;
}
