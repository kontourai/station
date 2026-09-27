import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateInput,
  KitRecord,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeRecordRoutes } from '../knowledge-record-routes.js';
import { createKnowledgeStoreRoutes } from '../knowledge-store-routes.js';

let home: string;
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
  home = mkdtempSync(join(tmpdir(), 'knowledge-create-identity-'));
  vi.stubEnv('STATION_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
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
