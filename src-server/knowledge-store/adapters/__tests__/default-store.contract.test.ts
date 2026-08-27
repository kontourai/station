import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KitDefaultStoreAdapter } from '../default-store.js';
import { runAdapterContractSuite } from './contract-suite.js';

// Spy on the shared logger factory so the corrupt-index self-heal test below can
// assert a warning breadcrumb was emitted (default-store.ts's module-level `logger`),
// without depending on pino's real transport/formatting. `vi.hoisted` is required
// because `vi.mock` factories are hoisted above normal `const`s.
const { loggerWarnSpy } = vi.hoisted(() => ({ loggerWarnSpy: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// The adapter-agnostic behavioral contract (create/update/link/propose/apply/reject/
// supersede/retire round-trips, MISSING_EVIDENCE/NOT_FOUND/AMBIGUOUS_ID/SLUG_CONFLICT,
// Addendum H identity resolution) is shared with `kit-obsidian-store` — see
// `contract-suite.ts`. This file keeps only what is genuinely specific to the
// `records/<id>.md` + `graph-index.json` + `alias-index.json` flat layout: on-disk
// fixture proof, `reindex()`, and corrupt-index self-heal/logging.
runAdapterContractSuite({
  label: 'kit-default-store',
  createAdapter: (storeRoot) => new KitDefaultStoreAdapter({ storeRoot }),
  findRecordFilePath: (dir, id) => join(dir, 'records', `${id}.md`),
});

describe('KitDefaultStoreAdapter — on-disk fixture proof (store-contract.md §9 / §5.1 / Addendum H.5)', () => {
  let dir: string;
  let adapter: KitDefaultStoreAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-default-store-fixture-'));
    adapter = new KitDefaultStoreAdapter({ storeRoot: dir });
    loggerWarnSpy.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('record files are literal YAML-frontmatter + markdown, parseable by a plain YAML reader', async () => {
    const id = await adapter.create({
      type: 'compiled',
      title: 'Fixture record',
      body: 'Body text with a [[wikilink-target]] reference.',
      category: 'engineering.fixtures',
      tags: ['fixture', 'proof'],
      aliases: ['engineering.fixtures/proof-record'],
      provenance: { agent: 'fixture-agent', note: 'contract fixture' },
    });

    const filePath = join(dir, 'records', `${id}.md`);
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf-8');

    expect(raw.startsWith('---\n')).toBe(true);
    const end = raw.indexOf('\n---\n', 4);
    expect(end).toBeGreaterThan(0);
    const frontmatterText = raw.slice(4, end);
    const body = raw.slice(end + 5).replace(/^\n+/, '');

    const frontmatter = yaml.load(frontmatterText) as Record<string, unknown>;

    expect(frontmatter).toMatchObject({
      id,
      type: 'compiled',
      title: 'Fixture record',
      category: 'engineering.fixtures',
      tags: ['fixture', 'proof'],
      aliases: ['engineering.fixtures/proof-record'],
      status: 'active',
      provenance: { agent: 'fixture-agent', note: 'contract fixture' },
    });
    expect(typeof frontmatter.created_at).toBe('string');
    expect(typeof frontmatter.updated_at).toBe('string');
    expect(Array.isArray(frontmatter.links)).toBe(true);
    expect(Array.isArray(frontmatter.mutation_log)).toBe(true);
    expect(body).toBe('Body text with a [[wikilink-target]] reference.');

    expect(frontmatter.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_id: 'wikilink-target',
          kind: 'related',
        }),
      ]),
    );
  });

  test('graph-index.json matches the §5.1 schema shape on disk', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const b = await adapter.create({
      type: 'compiled',
      title: 'B',
      body: 'b',
      category: 'engineering',
      links: [{ target_id: a, kind: 'source' }],
      provenance: { agent: 'agent-1', source_ids: [a] },
    });

    const graphPath = join(dir, 'graph-index.json');
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));

    expect(graph).toMatchObject({
      schema_version: '1.0',
      forward: { [b]: [{ target_id: a, kind: 'source' }] },
      reverse: { [a]: [{ source_id: b, kind: 'source' }] },
    });
  });

  test('alias-index.json matches the Addendum H.5 schema shape on disk', async () => {
    const id = await adapter.create({
      type: 'concept',
      title: 'Aliased',
      body: 'b',
      category: 'engineering',
      aliases: ['engineering/aliased-concept'],
      provenance: { agent: 'agent-1' },
    });

    const aliasPath = join(dir, 'alias-index.json');
    expect(existsSync(aliasPath)).toBe(true);
    const index = JSON.parse(readFileSync(aliasPath, 'utf-8'));

    expect(index).toEqual({
      schema_version: '1.0',
      by_slug: { 'engineering/aliased-concept': id },
    });
  });

  test('reindex() rebuilds both indexes from records when they are deleted', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      aliases: ['engineering/a-record'],
      provenance: { agent: 'agent-1' },
    });
    const b = await adapter.create({
      type: 'compiled',
      title: 'B',
      body: 'b',
      category: 'engineering',
      links: [{ target_id: a, kind: 'source' }],
      provenance: { agent: 'agent-1' },
    });

    rmSync(join(dir, 'graph-index.json'));
    rmSync(join(dir, 'alias-index.json'));

    const result = await adapter.reindex();
    expect(result.records).toBe(2);
    expect(result.links).toBe(1);

    const links = await adapter.getLinks(b);
    expect(links.forward).toEqual([{ target_id: a, kind: 'source' }]);
    const bySlug = await adapter.get('engineering/a-record');
    expect(bySlug?.id).toBe(a);
  });

  test('corrupt (unparsable) graph-index.json self-heals AND logs a warning breadcrumb', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const b = await adapter.create({
      type: 'compiled',
      title: 'B',
      body: 'b',
      category: 'engineering',
      links: [{ target_id: a, kind: 'source' }],
      provenance: { agent: 'agent-1' },
    });

    writeFileSync(join(dir, 'graph-index.json'), '{ not valid json', 'utf-8');

    expect(loggerWarnSpy).not.toHaveBeenCalled();

    const links = await adapter.getLinks(b);
    expect(links.forward).toEqual([{ target_id: a, kind: 'source' }]);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('graph-index.json failed to parse'),
      expect.objectContaining({ path: join(dir, 'graph-index.json') }),
    );

    const healed = JSON.parse(
      readFileSync(join(dir, 'graph-index.json'), 'utf-8'),
    );
    expect(healed.forward[b]).toEqual([{ target_id: a, kind: 'source' }]);
  });

  test('corrupt (unparsable) graph-index.json self-heals through a normal write op (link()) and logs exactly once — proves the log is wired to loadGraph() itself, not incidental to reindex()/rebuildIndexes() re-parsing the file a second time', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const b = await adapter.create({
      type: 'compiled',
      title: 'B',
      body: 'b',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    writeFileSync(join(dir, 'graph-index.json'), '{ not valid json', 'utf-8');

    expect(loggerWarnSpy).not.toHaveBeenCalled();

    await adapter.link(b, [{ target_id: a, kind: 'source' }], {
      agent: 'agent-1',
    });

    const graphWarnCalls = loggerWarnSpy.mock.calls.filter(([message]) =>
      String(message).includes('graph-index.json failed to parse'),
    );
    expect(graphWarnCalls).toHaveLength(1);
    expect(graphWarnCalls[0][1]).toEqual(
      expect.objectContaining({ path: join(dir, 'graph-index.json') }),
    );

    const healed = JSON.parse(
      readFileSync(join(dir, 'graph-index.json'), 'utf-8'),
    );
    expect(healed.forward[b]).toEqual([{ target_id: a, kind: 'source' }]);
  });

  test('corrupt (unparsable) alias-index.json logs a warning breadcrumb and falls back safely', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    writeFileSync(join(dir, 'alias-index.json'), '{ not valid json', 'utf-8');

    expect(loggerWarnSpy).not.toHaveBeenCalled();

    const record = await adapter.get(a);
    expect(record?.id).toBe(a);

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('alias-index.json failed to parse'),
      expect.objectContaining({ path: join(dir, 'alias-index.json') }),
    );
  });

  // Wave-3 fast-follow (code-review new finding, Wave 2 review pass 4): closes the
  // gap where `appendUniqueLinks`'s sanitization only fired on link-touching
  // mutations, so a metadata-only mutation (e.g. `retire()`, which spreads
  // `...record` untouched) would carry forward an already-bad, legacy/
  // externally-authored `KitLink.label` on disk indefinitely instead of ever
  // cleaning it up at rest. `writeRecord` now sanitizes unconditionally on every
  // persisted write, regardless of which mutation produced the record.
  test('a legacy newline-label already on disk is sanitized on the very next write, even through a metadata-only mutation (retire) that never touches links itself', async () => {
    const targetId = await adapter.create({
      type: 'concept',
      title: 'Link target',
      body: 'target body',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const sourceId = await adapter.create({
      type: 'concept',
      title: 'Legacy label source',
      body: 'Original body.',
      category: 'engineering',
      links: [
        {
          target_id: targetId,
          kind: 'related',
          label: 'SAFE_PLACEHOLDER_LABEL',
        },
      ],
      provenance: { agent: 'agent-1' },
    });

    // Hand-tamper the on-disk frontmatter to simulate a legacy/externally-authored
    // record whose label predates write-time sanitization — bypasses the adapter's
    // own sanitize-on-write path entirely (same fixture technique as the
    // sentinel-collision tests in `obsidian-store.contract.test.ts`).
    const filePath = join(dir, 'records', `${sourceId}.md`);
    const maliciousLabel = 'evil\nlabel\nwith\nnewlines';
    const tampered = readFileSync(filePath, 'utf-8').replace(
      'label: SAFE_PLACEHOLDER_LABEL',
      `label: ${JSON.stringify(maliciousLabel)}`,
    );
    writeFileSync(filePath, tampered, 'utf-8');

    // Confirm the tamper actually landed on disk with a real embedded newline
    // before exercising the fix (otherwise this test would pass vacuously).
    const beforeRaw = readFileSync(filePath, 'utf-8');
    const beforeFrontmatter = yaml.load(
      beforeRaw.slice(4, beforeRaw.indexOf('\n---\n', 4)),
    ) as { links: Array<{ label?: string }> };
    expect(beforeFrontmatter.links[0].label).toBe(maliciousLabel);

    loggerWarnSpy.mockClear();
    // retire() is a metadata-only mutation: it spreads `...record` (including the
    // tampered, unsanitized `links`) untouched except for `status`/`updated_at`/
    // `mutation_log` — it never calls `appendUniqueLinks`/`mergeLinks` itself.
    await adapter.retire(sourceId, 'retired', {
      agent: 'agent-1',
      rationale: 'no longer relevant',
    });

    const afterRaw = readFileSync(filePath, 'utf-8');
    const afterFrontmatter = yaml.load(
      afterRaw.slice(4, afterRaw.indexOf('\n---\n', 4)),
    ) as { links: Array<{ label?: string }>; status: string };
    expect(afterFrontmatter.status).toBe('retired');
    expect(afterFrontmatter.links[0].label).toBe('evil label with newlines');
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('embedded line break'),
      expect.objectContaining({
        original: maliciousLabel,
        sanitized: 'evil label with newlines',
      }),
    );

    // The record's public shape reflects the same sanitized label — not merely the
    // on-disk bytes.
    const record = await adapter.get(sourceId);
    expect(record?.links?.[0].label).toBe('evil label with newlines');
  });
});
