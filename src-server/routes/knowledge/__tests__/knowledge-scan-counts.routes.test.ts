import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  knowledgeOps: { add: vi.fn() },
}));

const { createKnowledgeRoutes } = await import('../knowledge.js');
const { KnowledgeService } = await import(
  '../../../services/knowledge/knowledge-service.js'
);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'knowledge-scan-counts-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// The project store the scan resolves the working directory from, and the one
// a namespace registration writes back to.
function projectStore(workingDirectory: string) {
  let project: Record<string, unknown> = {
    slug: 'alpha',
    name: 'Alpha',
    workingDirectory,
    knowledgeNamespaces: [],
  };
  return {
    getProject: (slug: string) => {
      if (slug !== 'alpha') throw new Error(`Project '${slug}' not found`);
      return { ...project };
    },
    projectRevision: () => ({
      value: { ...project },
      replace: async (next: Record<string, unknown>) => {
        project = next;
      },
      remove: async () => {},
    }),
  };
}

function vectorStore() {
  const namespaces = new Map<string, unknown[]>();
  return {
    namespaceExists: async (ns: string) => namespaces.has(ns),
    createNamespace: async (ns: string) => void namespaces.set(ns, []),
    addDocuments: async (ns: string, docs: unknown[]) =>
      void namespaces.set(ns, [...(namespaces.get(ns) ?? []), ...docs]),
    deleteDocuments: async () => {},
    search: async () => [],
    getByMetadata: async () => [],
  };
}

// The Project knowledge page shows the scan's "Indexed N files" next to the
// status header and the document list, which it refetches after the scan.
// All three must count the same files.
test('Index directory reports the same files the status header and document list then read', async () => {
  const workingDirectory = join(home, 'workspace');
  mkdirSync(join(workingDirectory, 'src'), { recursive: true });
  writeFileSync(join(workingDirectory, 'README.md'), '# Alpha\n\nAbout.\n');
  writeFileSync(join(workingDirectory, 'notes.md'), '# Notes\n\nHello.\n');
  writeFileSync(join(workingDirectory, 'src', 'index.ts'), 'export {};\n');
  const vectors = vectorStore();
  const service = new KnowledgeService(
    () => vectors as never,
    () => ({
      id: 'test-embedding',
      displayName: 'Test embedding',
      dimensions: () => 3,
      embed: async (texts: string[]) => texts.map(() => [0, 0, 0]),
    }),
    join(home, 'station'),
    projectStore(workingDirectory) as never,
  );
  // Mounted where the runtime mounts it, so the project slug comes from the path.
  const routes = new Hono().route(
    '/api/projects/:slug/knowledge',
    createKnowledgeRoutes(service),
  );
  const app = {
    request: (path: string, init?: RequestInit) =>
      routes.request(`/api/projects/alpha/knowledge${path}`, init),
  };

  const scan = await app.request('/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(scan.status).toBe(200);
  const scanned = (
    await readJson<{ data: { indexed: number; skipped: number } }>(scan)
  ).data;
  expect(scanned).toEqual({ indexed: 3, skipped: 0 });

  const status = (
    await readJson<{
      data: { documentCount: number; totalChunks: number };
    }>(await app.request('/status'))
  ).data;
  const listed = (
    await readJson<{ data: Array<{ path: string; chunkCount: number }> }>(
      await app.request(''),
    )
  ).data;
  expect(status.documentCount).toBe(scanned.indexed);
  expect(listed.map((doc) => doc.path).sort()).toEqual([
    'README.md',
    'notes.md',
    join('src', 'index.ts'),
  ]);
  expect(status.totalChunks).toBe(
    listed.reduce((sum, doc) => sum + doc.chunkCount, 0),
  );
  expect(status.totalChunks).toBeGreaterThan(0);
});
