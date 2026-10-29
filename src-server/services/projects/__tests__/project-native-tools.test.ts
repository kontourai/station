import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { expect, test, vi } from 'vitest';
import { createProjectNativeToolLoader } from '../project-native-tools.js';

test('native Project delivery discovers only stores bound to its durable identity, including after a rename', async () => {
  const project: ProjectConfig = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'new-name',
    name: 'Research',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  };
  const root: KnowledgeStoreRoot = {
    id: 'root:project-old-name',
    projectId: project.id,
    scope: { kind: 'project', projectSlug: 'old-name' },
    adapterId: 'kit-default-store',
    storeRoot: '/managed/store',
    displayName: 'Research documents',
    createdAt: project.createdAt,
  };
  let roots: KnowledgeStoreRoot[] = [root];
  const spec: AgentSpec = {
    name: 'Reader',
    prompt: '',
    tools: { mcpServers: [] },
  };
  const load = vi.fn(async () => []);
  const resolve = createProjectNativeToolLoader({
    agentSpecs: new Map([['reader', spec]]),
    getProject: () => project,
    listRoots: async () => roots,
    loadTools: load,
  });
  await resolve('reader', project.slug);
  expect(load).toHaveBeenCalledWith(
    'reader',
    expect.objectContaining({
      tools: expect.objectContaining({ mcpServers: ['station-knowledge'] }),
    }),
  );
  load.mockClear();
  roots = [
    {
      ...root,
      projectId: '22222222-2222-4222-8222-222222222222',
      scope: { kind: 'project', projectSlug: project.slug },
    },
    {
      ...root,
      id: 'legacy',
      projectId: undefined,
      scope: { kind: 'project', projectSlug: project.slug },
    },
  ];
  expect(await resolve('reader', project.slug)).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});
