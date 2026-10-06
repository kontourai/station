import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  createKnowledgeRoot,
  getKnowledgeGraph,
  getKnowledgeRecord,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  REVIEW_LEDGER_INDEX,
  recordFile,
  serializeLedgerIndex,
  serializeRecordFile,
} from '../../../scripts/lib/review-ledger-store.mjs';
import { FileStorageAdapter } from '../../../src-server/domain/file-storage-adapter.ts';
import { KnowledgeStoreProvider } from '../../../src-server/knowledge-store/knowledge-store-provider.ts';
import { createKnowledgeRecordRoutes } from '../../../src-server/routes/knowledge/knowledge-record-routes.ts';
import { createKnowledgeStoreRoutes } from '../../../src-server/routes/knowledge/knowledge-store-routes.ts';
import {
  exportRepositoryKnowledge,
  validateKnowledgeSnapshot,
} from '../graph.mjs';
import {
  ingestKnowledgeSnapshot,
  isolatedOrigin,
  recallKnowledgeSnapshot,
} from '../ingest.mjs';

let directory;
let servers;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const token = 'isolated-knowledge-test-credential';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'station-repository-graph-'));
  servers = [];
  vi.stubEnv('STATION_HOME', join(directory, 'home'));
});
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const root = join(directory, 'repo');
  mkdirSync(root);
  const put = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const modules =
    '# Modules\n\n## Shared language\n\nVocabulary.\n\n## Index\n\nNavigation.\n\n## Alpha\n\nReads exact records.\n\n~~~md\n## Beta\n~~~\n\n[Owner](../../src-server/alpha.js) [Test](../../tests/alpha.test.js) [Decision](../adr/alpha.md) [Issue](https://github.com/kontourai/station/issues/9999)\n\n## Beta\n\nPreserves uncertain work.\n';
  put('docs/architecture/module-map.md', modules);
  put(
    'docs/learn/atlas.json',
    JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'work',
          title: 'Work',
          summary: 'Recorded purpose',
          modules: ['Alpha', 'Beta'],
          docs: ['docs/adr/alpha.md'],
          questions: ['Where is Alpha explained?'],
        },
      ],
    }),
  );
  put('src-server/alpha.js', 'export const value = 1;\n');
  put('tests/alpha.test.js', '// A reference is not a passing test receipt.\n');
  put('docs/adr/alpha.md', '# Decision\n\nRecorded rationale.\n');
  put(REVIEW_LEDGER_INDEX, serializeLedgerIndex({}));
  put(
    recordFile('docs/architecture/module-map.md'),
    serializeRecordFile({
      path: 'docs/architecture/module-map.md',
      kind: 'current',
      state: 'partial',
      summary: 'Fixture review.',
      limits: 'Fixture only.',
      document: { digest: sha(modules), revision: 'a'.repeat(40) },
      sources: [
        {
          path: 'src-server/alpha.js',
          digest: sha('export const value = 1;\n'),
          revision: 'a'.repeat(40),
        },
        {
          path: '.kontourai/private-advisory.md',
          digest: sha('PRIVATE MATERIAL'),
          revision: 'a'.repeat(40),
        },
      ],
      checks: [],
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    ],
  ])
    execFileSync('git', args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'pipe',
    });
  put('.kontourai/private-advisory.md', 'PRIVATE MATERIAL');
  return { root, put };
}

async function service({
  failAfterSecondCreate = false,
  rateLimitFirstCreate = false,
} = {}) {
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  const store = new KnowledgeStoreProvider(new FileStorageAdapter(home));
  const app = new Hono();
  let creates = 0;
  let fail = failAfterSecondCreate;
  let limitedAt;
  let admittedAfterLimit;
  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`)
      return c.json({ success: false }, 401);
    if (
      c.req.method === 'POST' &&
      /\/records$/.test(c.req.path) &&
      rateLimitFirstCreate &&
      limitedAt === undefined
    ) {
      limitedAt = performance.now();
      c.header('Retry-After', '1');
      return c.json({ error: { code: 'rate_limited' } }, 429);
    }
    if (
      c.req.method === 'POST' &&
      /\/records$/.test(c.req.path) &&
      limitedAt !== undefined &&
      admittedAfterLimit === undefined
    )
      admittedAfterLimit = performance.now();
    await next();
    if (
      c.req.method === 'POST' &&
      /\/records$/.test(c.req.path) &&
      ++creates === 2 &&
      fail
    ) {
      fail = false;
      c.res = c.json(
        { success: false, error: 'Injected lost response after durable write' },
        503,
      );
    }
  });
  app.route(
    '/api/knowledge',
    createKnowledgeStoreRoutes({ store, dataDir: home }),
  );
  app.route('/api/knowledge', createKnowledgeRecordRoutes({ store }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  servers.push(server);
  if (!server.listening)
    await new Promise((resolve) => server.once('listening', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const options = {
    credential: token,
    credentialOrigin: apiBase,
    requireCredential: true,
  };
  return {
    apiBase,
    options,
    store,
    creates: () => creates,
    limitWait: () => admittedAfterLimit - limitedAt,
  };
}

test('exports deterministic scoped provenance without untracked content or invented module dependencies', () => {
  const { root, put } = repository();
  const one = validateKnowledgeSnapshot(exportRepositoryKnowledge({ root }));
  expect(exportRepositoryKnowledge({ root })).toEqual(one);
  expect(one.counts.modules).toBe(2);
  expect(JSON.stringify(one)).not.toContain('PRIVATE MATERIAL');
  expect(JSON.stringify(one)).not.toContain('.kontourai/private');
  const alpha = one.records.find((record) => record.title === 'Alpha');
  const beta = one.records.find((record) => record.title === 'Beta');
  const owner = one.records.find(
    (record) => record.title === 'src-server/alpha.js',
  );
  expect(alpha.links).toContainEqual(
    expect.objectContaining({ target_id: owner.id, kind: 'references-source' }),
  );
  expect(beta.links.some((link) => link.target_id === owner.id)).toBe(false);
  put('src-server/alpha.js', 'export const value = 2;\n');
  const changed = exportRepositoryKnowledge({ root });
  expect(changed.inputDigest).not.toBe(one.inputDigest);
  expect(
    changed.inputs.find((input) => input.path === 'src-server/alpha.js'),
  ).toMatchObject({ matchesRevision: false, existsAtRevision: true });
  expect(changed.records.flatMap((record) => record.links)).toContainEqual(
    expect.objectContaining({
      label: 'Whole-document review dependency: changed-or-missing',
    }),
  );
  expect(alpha.body).toContain('Historical reason for addition is unknown');
});

test('exports path-only dependencies without presenting stored digest approval', () => {
  const { root, put } = repository();
  const file = recordFile('docs/architecture/module-map.md');
  const record = JSON.parse(readFileSync(join(root, file), 'utf8'));
  delete record.document;
  record.sources = record.sources.map((source) => source.path);
  put(file, serializeRecordFile(record));
  put(
    REVIEW_LEDGER_INDEX,
    serializeLedgerIndex({ version: 3, coverageBaseline: 'a'.repeat(40) }),
  );
  const graph = validateKnowledgeSnapshot(exportRepositoryKnowledge({ root }));
  expect(graph.records.flatMap((record) => record.links)).toContainEqual(
    expect.objectContaining({
      label: 'Whole-document review dependency: recorded-dependency',
    }),
  );
  expect(JSON.stringify(graph)).toContain(
    'history-derived-not-judged-by-export',
  );
  expect(JSON.stringify(graph)).not.toContain('matches-recorded-digest');
});

test('refuses missing module owners, symlinked references and altered exported payloads', () => {
  const { root, put } = repository();
  const snapshot = exportRepositoryKnowledge({ root });
  snapshot.records[0].body = 'invented rationale';
  expect(() => validateKnowledgeSnapshot(snapshot)).toThrow('payload digest');
  put('docs/architecture/module-map.md', '# Modules\n');
  expect(() => exportRepositoryKnowledge({ root })).toThrow('Unknown module');
  put(
    'docs/architecture/module-map.md',
    '# Modules\n\n## Alpha\n\n[Owner](../../src-server/alpha.js)\n\n## Beta\n\nPurpose.\n',
  );
  rmSync(join(root, 'src-server/alpha.js'));
  symlinkSync(join(directory, 'outside'), join(root, 'src-server/alpha.js'));
  expect(() => exportRepositoryKnowledge({ root })).toThrow(/symlink/);
});

test.each([
  [
    'inputs',
    (value) => {
      value.inputs[0].digest = '0'.repeat(64);
    },
  ],
  [
    'missing inputs',
    (value) => {
      delete value.inputs;
    },
  ],
  [
    'record count',
    (value) => {
      value.counts.records += 1;
    },
  ],
  [
    'edge count',
    (value) => {
      value.counts.edges += 1;
    },
  ],
  [
    'module count',
    (value) => {
      value.counts.modules += 1;
    },
  ],
  [
    'omission count',
    (value) => {
      value.counts.omittedReferences = -1;
    },
  ],
])('rejects altered %s before importing', async (_name, alter) => {
  const { root } = repository();
  const snapshot = exportRepositoryKnowledge({ root });
  alter(snapshot);
  await expect(
    ingestKnowledgeSnapshot({
      snapshot,
      apiBase: 'http://127.0.0.1:43521',
      rootId: 'root:project-repository-graph',
      credential: token,
      apply: true,
    }),
  ).rejects.toThrow(/Snapshot (input digest|counts)/);
});

test('refuses duplicate atlas groups through the canonical catalog contract', () => {
  const { root, put } = repository();
  const group = {
    id: 'work',
    title: 'Work',
    summary: 'Purpose',
    questions: ['Why?'],
    docs: ['docs/adr/alpha.md'],
  };
  put(
    'docs/learn/atlas.json',
    JSON.stringify({
      version: 1,
      groups: [
        { ...group, modules: ['Alpha'] },
        { ...group, modules: ['Beta'] },
      ],
    }),
  );
  expect(() => exportRepositoryKnowledge({ root })).toThrow(
    'duplicate learning group',
  );
});

test('refuses pacing faster than four writes per second before connecting', async () => {
  const { root } = repository();
  await expect(
    ingestKnowledgeSnapshot({
      snapshot: exportRepositoryKnowledge({ root }),
      apiBase: 'http://127.0.0.1:43521',
      rootId: 'root:project-repository-graph',
      credential: token,
      paceMilliseconds: 0,
      apply: true,
    }),
  ).rejects.toThrow('Invalid ingestion pacing');
});

test('uses real SDK/HTTP routes and file adapters for dry-run, partial-write recovery, idempotence, update history and recall', async () => {
  const { root: repo, put } = repository();
  const snapshot = exportRepositoryKnowledge({ root: repo });
  const host = await service({ failAfterSecondCreate: true });
  const root = await createKnowledgeRoot(
    host.apiBase,
    {
      scope: { kind: 'project', projectSlug: 'repository-graph' },
      adapterId: 'kit-default-store',
      displayName: 'Station repository graph dogfood',
    },
    host.options,
  );
  const input = {
    snapshot,
    apiBase: host.apiBase,
    rootId: root.id,
    credential: token,
  };
  expect(await ingestKnowledgeSnapshot(input)).toMatchObject({
    outcome: 'dry-run',
    wouldCreate: snapshot.records.length,
  });
  expect(host.creates()).toBe(0);
  await expect(
    ingestKnowledgeSnapshot({ ...input, apply: true }),
  ).rejects.toThrow('Ingestion incomplete after 1 confirmed creates');
  expect(
    await ingestKnowledgeSnapshot({ ...input, apply: true }),
  ).toMatchObject({
    outcome: 'verified',
    existing: 2,
    created: snapshot.records.length - 2,
    recordsVerified: snapshot.records.length,
    edgesVerified: snapshot.records.reduce(
      (count, record) => count + record.links.length,
      0,
    ),
  });
  expect(
    await ingestKnowledgeSnapshot({ ...input, apply: true }),
  ).toMatchObject({ created: 0, unchanged: snapshot.records.length });
  const recall = await recallKnowledgeSnapshot({ ...input, query: 'Alpha' });
  expect(recall.outcome).toBe('recalled');
  expect(
    recall.results.find((record) => record.title === 'Alpha').outgoing,
  ).toContainEqual(
    expect.objectContaining({
      kind: 'references-source',
      title: 'src-server/alpha.js',
    }),
  );
  expect(
    await recallKnowledgeSnapshot({ ...input, query: 'no-such-module' }),
  ).toMatchObject({ outcome: 'no-answer' });
  put('src-server/alpha.js', 'export const value = 3;\n');
  const updated = exportRepositoryKnowledge({ root: repo });
  expect(
    await ingestKnowledgeSnapshot({ ...input, snapshot: updated, apply: true }),
  ).toMatchObject({
    outcome: 'verified',
    retainedOtherSnapshots: snapshot.records.length,
  });
  const oldAlpha = snapshot.records.find((record) => record.title === 'Alpha');
  expect(
    (await getKnowledgeRecord(host.apiBase, root.id, oldAlpha.id, host.options))
      .mutation_log,
  ).toContainEqual(
    expect.objectContaining({
      op: 'link',
      agent: 'station.repository-knowledge-graph',
    }),
  );
  expect(
    await getKnowledgeRecord(host.apiBase, root.id, oldAlpha.id, host.options),
  ).toMatchObject({ body: oldAlpha.body, provenance: oldAlpha.provenance });
  const restarted = await service();
  expect(
    (await getKnowledgeGraph(restarted.apiBase, root.id, restarted.options))
      .nodes.length,
  ).toBe(snapshot.records.length + updated.records.length);
  expect(
    await ingestKnowledgeSnapshot({
      ...input,
      apiBase: restarted.apiBase,
      snapshot: updated,
      apply: true,
    }),
  ).toMatchObject({ created: 0 });
  const adapter = await restarted.store.adapterFor(root.id);
  await adapter.update(
    oldAlpha.id,
    { body: 'An independent edit' },
    { agent: 'fixture-editor' },
  );
  await expect(
    ingestKnowledgeSnapshot({
      ...input,
      apiBase: restarted.apiBase,
      apply: true,
    }),
  ).rejects.toThrow('No overwrite was attempted');
}, 30_000);

test('refuses default/shared destinations before mutation', async () => {
  for (const origin of [
    'http://127.0.0.1:3141',
    'http://localhost:3000',
    'https://example.test:43521',
    'http://127.0.0.1:43521/path',
  ])
    expect(() => isolatedOrigin(origin)).toThrow('isolated');
  const { root: repo } = repository();
  const host = await service();
  const root = await createKnowledgeRoot(
    host.apiBase,
    { scope: { kind: 'personal' }, adapterId: 'kit-default-store' },
    host.options,
  );
  await expect(
    ingestKnowledgeSnapshot({
      snapshot: exportRepositoryKnowledge({ root: repo }),
      apiBase: host.apiBase,
      rootId: root.id,
      credential: token,
      apply: true,
    }),
  ).rejects.toThrow('dedicated Project root');
  expect(host.creates()).toBe(0);
});

test('honors HTTP Retry-After and reconciles the exact record before retrying a refused write', async () => {
  const { root: repo } = repository();
  const snapshot = exportRepositoryKnowledge({ root: repo });
  const host = await service({ rateLimitFirstCreate: true });
  const root = await createKnowledgeRoot(
    host.apiBase,
    {
      scope: { kind: 'project', projectSlug: 'repository-graph' },
      adapterId: 'kit-default-store',
      displayName: 'Station repository graph dogfood',
    },
    host.options,
  );
  const result = await ingestKnowledgeSnapshot({
    snapshot,
    apiBase: host.apiBase,
    rootId: root.id,
    credential: token,
    apply: true,
  });
  expect(result).toMatchObject({
    outcome: 'verified',
    created: snapshot.records.length,
    admission: { rateLimitWaits: 1, retryAfterMilliseconds: 1000 },
  });
  expect(host.limitWait()).toBeGreaterThanOrEqual(1000);
  expect(host.creates()).toBe(snapshot.records.length);
}, 30_000);
