import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';

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

type ScanResult = { indexed: number; alreadyIndexed: number; skipped: number };

// A Project created the way the app creates one, on the real file store (which
// refuses a stale revision), with the knowledge routes mounted where the
// runtime mounts them.
async function station(workingDirectory?: string) {
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(
    storage,
    new ProjectManifestStore(home, storage),
  );
  await projects.createProject({
    name: 'Alpha',
    slug: 'alpha',
    ...(workingDirectory ? { workingDirectory } : {}),
  });
  const vectors = vectorStore();
  const service = new KnowledgeService(
    () => vectors as never,
    () => ({
      id: 'test-embedding',
      displayName: 'Test embedding',
      dimensions: () => 3,
      embed: async (texts: string[]) => texts.map(() => [0, 0, 0]),
    }),
    home,
    storage,
  );
  const routes = new Hono().route(
    '/api/projects/:slug/knowledge',
    createKnowledgeRoutes(service),
  );
  const request = (path: string, init?: RequestInit) =>
    routes.request(`/api/projects/alpha/knowledge${path}`, init);
  const scan = async () => {
    const response = await request('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return {
      status: response.status,
      body: await readJson<{ data?: ScanResult; error?: unknown }>(response),
    };
  };
  const status = async () =>
    (
      await readJson<{
        data: { documentCount: number; totalChunks: number };
      }>(await request('/status'))
    ).data;
  const listed = async () =>
    (
      await readJson<{ data: Array<{ path: string; chunkCount: number }> }>(
        await request(''),
      )
    ).data;
  const namespaceIds = async () =>
    (
      await readJson<{ data: Array<{ id: string }> }>(
        await request('/namespaces'),
      )
    ).data.map((namespace) => namespace.id);
  return { scan, status, listed, namespaceIds };
}

function workspace() {
  const workingDirectory = join(home, 'workspace');
  mkdirSync(join(workingDirectory, 'src'), { recursive: true });
  writeFileSync(join(workingDirectory, 'README.md'), '# Alpha\n\nAbout.\n');
  writeFileSync(join(workingDirectory, 'notes.md'), '# Notes\n\nHello.\n');
  writeFileSync(join(workingDirectory, 'src', 'index.ts'), 'export {};\n');
  return workingDirectory;
}

// The Project knowledge page shows the scan's "Indexed N files" next to the
// status header and the document list, which it refetches after the scan.
// All three must count the same files.
test('Index directory reports the same files the status header and document list then read', async () => {
  const s = await station(workspace());
  const scanned = await s.scan();
  expect(scanned.status).toBe(200);
  expect(scanned.body.data).toEqual({
    indexed: 3,
    alreadyIndexed: 0,
    skipped: 0,
  });
  const status = await s.status();
  const listed = await s.listed();
  expect(status.documentCount).toBe(3);
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

test('indexing again reports the files as already indexed, not skipped', async () => {
  const s = await station(workspace());
  expect((await s.scan()).body.data?.indexed).toBe(3);
  const again = await s.scan();
  expect(again.status).toBe(200);
  expect(again.body.data).toEqual({
    indexed: 0,
    alreadyIndexed: 3,
    skipped: 0,
  });
  expect((await s.status()).documentCount).toBe(3);
});

test('two first scans at once both succeed and register the namespace once', async () => {
  const s = await station(workspace());
  const [first, second] = await Promise.all([s.scan(), s.scan()]);
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(
    (first.body.data?.indexed ?? 0) + (second.body.data?.indexed ?? 0),
  ).toBe(3);
  expect((await s.namespaceIds()).filter((id) => id === 'code')).toHaveLength(
    1,
  );
  expect((await s.status()).documentCount).toBe(3);
});

test('a scan with nothing to index registers no namespace', async () => {
  const s = await station(join(home, 'no-such-directory'));
  const scanned = await s.scan();
  expect(scanned.status).toBe(200);
  expect(scanned.body.data).toEqual({
    indexed: 0,
    alreadyIndexed: 0,
    skipped: 0,
  });
  expect(await s.namespaceIds()).not.toContain('code');
});
