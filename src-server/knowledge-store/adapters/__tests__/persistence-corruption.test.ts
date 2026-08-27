import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreCorruptionError } from '../../errors.js';
import { KitDefaultStoreAdapter } from '../default-store.js';
import { KitObsidianStoreAdapter } from '../obsidian-store.js';

const roots: string[] = [];

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

const input = {
  id: 'record-00000001',
  type: 'raw' as const,
  title: 'Record',
  body: 'body',
  category: 'engineering',
  provenance: { agent: 'test' },
};

describe('knowledge persisted schema policy', () => {
  test('a malformed authoritative default record is corruption, not an empty result', async () => {
    const storeRoot = root('knowledge-default-corrupt-');
    const adapter = new KitDefaultStoreAdapter({ storeRoot });
    await adapter.create(input);
    writeFileSync(
      join(storeRoot, 'records', `${input.id}.md`),
      '---\nid: record-00000001\n---\nbody',
      'utf8',
    );

    await expect(adapter.get(input.id)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
  });

  test('default record filename identity cannot be redirected by tampered frontmatter', async () => {
    const storeRoot = root('knowledge-default-identity-');
    const adapter = new KitDefaultStoreAdapter({ storeRoot });
    await adapter.create(input);
    const path = join(storeRoot, 'records', `${input.id}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        `id: ${input.id}`,
        'id: record-00000002',
      ),
    );

    await expect(
      adapter.update(input.id, { title: 'Wrong target' }, { agent: 'test' }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    expect(readFileSync(path, 'utf8').includes('title: Wrong target')).toBe(
      false,
    );
  });

  test.each([
    [
      'provenance',
      (raw: string) =>
        raw.replace('  agent: test', '  agent: test\n  source_ids: invalid'),
    ],
    [
      'mutation log',
      (raw: string) =>
        raw.replace(
          'mutation_log: []',
          'mutation_log:\n  - op: update\n    at: not-a-date\n    agent: test',
        ),
    ],
  ])('default record rejects malformed nested %s', async (_label, tamper) => {
    const storeRoot = root('knowledge-default-nested-');
    const adapter = new KitDefaultStoreAdapter({ storeRoot });
    await adapter.create(input);
    const path = join(storeRoot, 'records', `${input.id}.md`);
    writeFileSync(path, tamper(readFileSync(path, 'utf8')));

    await expect(adapter.get(input.id)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
  });

  test('Obsidian path metadata is authoritative and fails closed when malformed', async () => {
    const storeRoot = root('knowledge-obsidian-path-corrupt-');
    const adapter = new KitObsidianStoreAdapter({ storeRoot });
    await adapter.create(input);
    writeFileSync(join(storeRoot, 'path-index.json'), '{}', 'utf8');

    await expect(adapter.get(input.id)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
  });

  test('Obsidian path-index identity cannot be redirected by tampered frontmatter', async () => {
    const storeRoot = root('knowledge-obsidian-identity-');
    const adapter = new KitObsidianStoreAdapter({ storeRoot });
    await adapter.create(input);
    const index = JSON.parse(
      readFileSync(join(storeRoot, 'path-index.json'), 'utf8'),
    ) as { by_id: Record<string, { path: string }> };
    const path = join(storeRoot, index.by_id[input.id].path);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        `id: ${input.id}`,
        'id: record-00000002',
      ),
    );

    await expect(
      adapter.update(input.id, { title: 'Wrong target' }, { agent: 'test' }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    expect(readFileSync(path, 'utf8').includes('title: Wrong target')).toBe(
      false,
    );
  });

  test('Obsidian derived graph corruption requires and survives explicit reindex', async () => {
    const storeRoot = root('knowledge-obsidian-graph-corrupt-');
    const adapter = new KitObsidianStoreAdapter({ storeRoot });
    await adapter.create(input);
    writeFileSync(join(storeRoot, 'graph-index.json'), '{', 'utf8');

    await expect(adapter.getLinks(input.id)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
    await expect(adapter.reindex()).resolves.toMatchObject({ records: 1 });
    expect(
      JSON.parse(readFileSync(join(storeRoot, 'graph-index.json'), 'utf8')),
    ).toMatchObject({ schema_version: '1.0' });
  });
});
