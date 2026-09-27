import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  CreateInput,
  KitRecord,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeRecordRoutes } from '../knowledge-record-routes.js';
import { createKnowledgeStoreRoutes } from '../knowledge-store-routes.js';

let home: string;
const makeTempDir = trackTempDirs();
function storedBytes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path).toString('base64')];
      }),
  );
}
beforeEach(() => {
  home = makeTempDir('knowledge-create-identity-');
  vi.stubEnv('STATION_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test.each([
  ['kit-default-store', 'active'],
  ['kit-default-store', 'retired'],
  ['kit-obsidian-store', 'active'],
  ['kit-obsidian-store', 'retired'],
])(
  'create refuses an existing %s %s identity without replacing its history or links',
  async (adapterId, state) => {
    const store = new KnowledgeStoreProvider(new FileStorageAdapter(home));
    const app = new Hono();
    app.route(
      '/api/knowledge',
      createKnowledgeStoreRoutes({ store, dataDir: home }),
    );
    app.route('/api/knowledge', createKnowledgeRecordRoutes({ store }));
    const storeRoot = join(home, 'records-under-review');
    if (adapterId === 'kit-obsidian-store')
      mkdirSync(join(storeRoot, '.obsidian'), { recursive: true });
    const rootResponse = await app.request('/api/knowledge/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'personal' },
        adapterId,
        storeRoot,
      }),
    });
    expect(rootResponse.status).toBe(201);
    const { data: root } = await readJson<{ data: KnowledgeStoreRoot }>(
      rootResponse,
    );
    const path = `/api/knowledge/roots/${encodeURIComponent(root.id)}/records`;
    const create = (input: CreateInput) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    const base = {
      type: 'raw' as const,
      title: 'Evidence',
      body: 'Evidence body',
      category: 'engineering.identity',
      provenance: { agent: 'original-author' },
    };
    expect((await create({ ...base, id: 'original-target' })).status).toBe(201);
    expect((await create({ ...base, id: 'replacement-target' })).status).toBe(
      201,
    );
    expect(
      (
        await create({
          ...base,
          id: 'stable-record',
          aliases: ['engineering.identity/original'],
          links: [
            {
              target_id: 'original-target',
              kind: 'related',
              label: 'Original relationship',
            },
          ],
        })
      ).status,
    ).toBe(201);
    const adapter = await store.adapterFor(root.id);
    await adapter.update(
      'stable-record',
      { body: 'Reviewed original body' },
      { agent: 'reviewer', note: 'Preserve creation provenance' },
    );
    if (state === 'retired')
      await adapter.retire('stable-record', 'retired', {
        agent: 'curator',
        rationale: 'Keep historical evidence',
      });
    const before = (
      await readJson<{ data: KitRecord }>(
        await app.request(`${path}/stable-record`),
      )
    ).data;
    const beforeLinks = await adapter.getLinks('stable-record');
    const beforeBytes = storedBytes(storeRoot);
    const duplicate = await create({
      ...base,
      id: 'stable-record',
      type: 'concept',
      title: 'Replacement',
      body: 'Replacement body',
      aliases: ['engineering.identity/replacement'],
      provenance: { agent: 'replacement-author' },
      links: [
        {
          target_id: 'replacement-target',
          kind: 'related',
          label: 'Replacement relationship',
        },
      ],
    });
    const after = (
      await readJson<{ data: KitRecord }>(
        await app.request(`${path}/stable-record`),
      )
    ).data;
    expect({
      status: duplicate.status,
      record: after,
      links: await adapter.getLinks('stable-record'),
      originalAlias: await adapter.get('engineering.identity/original'),
      replacementAlias: await adapter.get('engineering.identity/replacement'),
    }).toEqual({
      status: 400,
      record: before,
      links: beforeLinks,
      originalAlias: before,
      replacementAlias: null,
    });
    expect(storedBytes(storeRoot)).toEqual(beforeBytes);
  },
);

async function obsidianFixture() {
  const store = new KnowledgeStoreProvider(new FileStorageAdapter(home));
  const app = new Hono();
  app.route(
    '/api/knowledge',
    createKnowledgeStoreRoutes({ store, dataDir: home }),
  );
  app.route('/api/knowledge', createKnowledgeRecordRoutes({ store }));
  const storeRoot = join(home, 'vault');
  mkdirSync(join(storeRoot, '.obsidian'), { recursive: true });
  const response = await app.request('/api/knowledge/roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: { kind: 'personal' },
      adapterId: 'kit-obsidian-store',
      storeRoot,
    }),
  });
  expect(response.status).toBe(201);
  const { data: root } = await readJson<{ data: KnowledgeStoreRoot }>(response);
  const base: CreateInput = {
    id: 'stable-record',
    type: 'raw',
    title: 'Evidence',
    body: 'Original body',
    category: 'engineering.identity',
    provenance: { agent: 'original-author' },
    aliases: ['engineering.identity/original'],
  };
  const create = (input: CreateInput) =>
    app.request(`/api/knowledge/roots/${encodeURIComponent(root.id)}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  expect((await create(base)).status).toBe(201);
  const adapter = await store.adapterFor(root.id);
  await adapter.update(
    'stable-record',
    { body: 'Reviewed original body' },
    { agent: 'reviewer', note: 'Preserve history' },
  );
  return {
    adapter,
    create,
    base,
    storeRoot,
    indexPath: join(storeRoot, 'path-index.json'),
    recordPath: join(storeRoot, 'engineering/identity/sources/evidence.md'),
  };
}

test.each([
  ['absent', 400],
  ['absent-renamed', 400],
  ['retired-absent', 400],
  ['omitted', 400],
  ['dangling', 503],
  ['corrupt-json', 503],
  ['corrupt-mapping', 503],
  ['missing-id', 503],
  ['corrupt-record', 503],
  ['archived-absent', 400],
] as const)(
  'Obsidian create preserves physical authority for %s',
  async (scenario, expectedStatus) => {
    const fixture = await obsidianFixture();
    const { adapter, create, base, storeRoot, indexPath, recordPath } = fixture;
    if (scenario === 'retired-absent')
      await adapter.retire('stable-record', 'retired', {
        agent: 'curator',
        rationale: 'Keep history',
      });
    if (scenario === 'archived-absent') {
      expect(
        (
          await create({
            ...base,
            id: 'successor',
            title: 'Successor',
            aliases: [],
          })
        ).status,
      ).toBe(201);
      await adapter.supersede('successor', ['stable-record'], {
        agent: 'curator',
        rationale: 'Keep source history',
      });
    }
    const original = await adapter.get('stable-record');
    expect(original?.provenance.agent).toBe('original-author');
    if (scenario.includes('absent')) rmSync(indexPath);
    if (
      scenario === 'omitted' ||
      scenario === 'dangling' ||
      scenario === 'corrupt-mapping'
    ) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      const path = index.by_id['stable-record'].path;
      delete index.by_path[path];
      if (scenario === 'omitted') delete index.by_id['stable-record'];
      if (scenario === 'dangling') {
        index.by_id['stable-record'].path = 'missing.md';
        index.by_path['missing.md'] = 'stable-record';
      }
      writeFileSync(indexPath, JSON.stringify(index));
    }
    if (scenario === 'corrupt-json') writeFileSync(indexPath, '{corrupt');
    if (scenario === 'missing-id') {
      const before = readFileSync(recordPath, 'utf8');
      const withoutId = before.replace(/^id: stable-record\n/m, '');
      expect(withoutId).not.toBe(before);
      writeFileSync(recordPath, withoutId);
    }
    if (scenario === 'corrupt-record')
      writeFileSync(recordPath, '---\nid: [broken\n---\nOriginal body');
    const before = storedBytes(storeRoot);
    const duplicate = await create({
      ...base,
      title: scenario === 'absent-renamed' ? 'Replacement' : 'Evidence',
      body: 'Replacement body',
      provenance: { agent: 'replacement-author' },
      aliases: ['engineering.identity/replacement'],
    });
    expect(duplicate.status).toBe(expectedStatus);
    expect(storedBytes(storeRoot)).toEqual(before);
  },
);

test('Obsidian create refuses an unindexed destination and still admits a distinct new identity', async () => {
  const { create, base, storeRoot } = await obsidianFixture();
  const note = join(storeRoot, 'engineering/identity/sources/personal-note.md');
  writeFileSync(note, '# A personal note without Kit metadata\n');
  const before = storedBytes(storeRoot);
  expect(
    (
      await create({
        ...base,
        id: 'new-record',
        title: 'Personal note',
        aliases: [],
      })
    ).status,
  ).toBe(503);
  expect(storedBytes(storeRoot)).toEqual(before);
  expect(
    (
      await create({
        ...base,
        id: 'new-record',
        title: 'Distinct title',
        aliases: [],
      })
    ).status,
  ).toBe(201);
  expect(readFileSync(note, 'utf8')).toBe(
    '# A personal note without Kit metadata\n',
  );
});

test.each([
  'ordinary note without frontmatter',
  '---\n---\nordinary note with empty frontmatter',
  '---\n\n---\nordinary note with blank frontmatter',
])('Obsidian create preserves an unrelated ordinary note: %j', async (text) => {
  const { create, base, storeRoot } = await obsidianFixture();
  const note = join(storeRoot, 'ordinary.md');
  writeFileSync(note, text);
  expect(
    (await create({ ...base, id: 'new-record', title: 'New', aliases: [] }))
      .status,
  ).toBe(201);
  expect(readFileSync(note, 'utf8')).toBe(text);
});

test.each([
  '---\nid: possible-owner\n',
  '---\r\nid: possible-owner\r\n---\r\nOriginal body',
  '\uFEFF---\nid: possible-owner\n---\nOriginal body',
])(
  'Obsidian create refuses uncertain unindexed frontmatter without publication: %j',
  async (text) => {
    const { create, base, storeRoot } = await obsidianFixture();
    writeFileSync(join(storeRoot, 'broken.md'), text);
    const before = storedBytes(storeRoot);
    expect(
      (await create({ ...base, id: 'new-record', title: 'New', aliases: [] }))
        .status,
    ).toBe(503);
    expect(storedBytes(storeRoot)).toEqual(before);
  },
);

test('Obsidian create refuses an oversized physical identity inspection without changing bytes', async () => {
  const { create, base, storeRoot } = await obsidianFixture();
  writeFileSync(
    join(storeRoot, 'oversized.md'),
    Buffer.alloc(16 * 1024 * 1024 + 1, 'a'),
  );
  const before = storedBytes(storeRoot);
  expect(
    (await create({ ...base, id: 'new-record', title: 'New', aliases: [] }))
      .status,
  ).toBe(503);
  expect(storedBytes(storeRoot)).toEqual(before);
});

test.each(['entries', 'total-bytes'] as const)(
  'Obsidian create refuses the physical identity %s bound without publication',
  async (bound) => {
    const { create, base, storeRoot } = await obsidianFixture();
    if (bound === 'entries') {
      for (let index = 0; index < 10_000; index += 1)
        writeFileSync(join(storeRoot, `note-${index}.txt`), '');
    } else {
      const bytes = Buffer.alloc(16 * 1024 * 1024, 'a');
      for (let index = 0; index < 4; index += 1)
        writeFileSync(join(storeRoot, `note-${index}.md`), bytes);
    }
    const digests = () =>
      Object.fromEntries(
        readdirSync(storeRoot, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const path = join(entry.parentPath, entry.name);
            return [
              path,
              createHash('sha256').update(readFileSync(path)).digest('hex'),
            ];
          }),
      );
    const before = digests();
    expect(
      (await create({ ...base, id: 'new-record', title: 'New', aliases: [] }))
        .status,
    ).toBe(503);
    expect(digests()).toEqual(before);
  },
  30_000,
);
