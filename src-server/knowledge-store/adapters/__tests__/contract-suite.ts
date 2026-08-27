/**
 * Shared `KnowledgeStoreAdapter` contract-test suite (store-contract.md §6/§A.5/§B.4/
 * §H) — run against BOTH Station-owned Kit-format adapters (`kit-default-store`,
 * `kit-obsidian-store`) so a behavioral guarantee proven here holds identically
 * regardless of which adapter backs a root. This is the test-level expression of the
 * design doc's dual-adapter dogfood requirement (AC1's "per-adapter... round-trip"
 * language, made literal by construction rather than by two independently-maintained
 * copies of the same assertions).
 *
 * Deliberately excluded from this shared suite (kept adapter-specific, in each
 * adapter's own `*.contract.test.ts`): on-disk file/path shape assertions
 * (`records/<id>.md` vs. category-path-routed vault layout), `reindex()` /
 * corrupt-index self-heal logging assertions (adapter-internal index filenames
 * differ), and anything that depends on a specific physical file location. Also
 * excluded on a grounded, documented basis (Addendum L §L.6, store-contract.md:1543-
 * 1546 — the dispositive text — read alongside Addendum J.3; see the
 * s200-knowledge-store deliver.md Wave-2 notes and the Wave-2 code review's A.7-vs-J.3
 * adjudication for the full citation trail): a superseded record's presence in
 * `listByType`/`listByCategory` after `supersede`, since the two adapters diverge here
 * BY DESIGN (`kit-default-store` leaves the file in place — status untouched, so it
 * remains listed; `kit-obsidian-store` archives the file — the Kit's own reference
 * adapter does the same, and §L.6 names the default-store's listing inclusion as an
 * adapter-specific "additional guarantee," not a store-wide contract). The store-
 * contract's actual cross-adapter guarantee for supersession is `get(id)` +
 * `getLinks(id).reverse`, both asserted below, which do hold identically across both
 * adapters.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreAdapter } from '@kontourai/station-contracts/knowledge-store';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

export interface ContractSuiteOptions {
  /** Adapters that route by category-as-path (Obsidian) can't accept dotted collision
   * ids sharing an 8-char prefix in the SAME slug-path test the way the flat
   * `records/<id>.md` layout can — both adapters support explicit caller ids
   * regardless, so this is always exercised; no option needed today. Reserved for
   * future adapter-specific suite toggles. */
  label: string;
  createAdapter: (
    storeRoot: string,
  ) => KnowledgeStoreAdapter | Promise<KnowledgeStoreAdapter>;
  /**
   * Resolve the absolute on-disk path of a record's `.md` file, given the store root
   * and record id. Adapter-specific because physical layout differs (`kit-default-
   * store`'s flat `records/<id>.md` vs. `kit-obsidian-store`'s category-path-routed
   * vault layout resolved via its `path-index.json`). Required only by the
   * unknown-frontmatter-key/unknown-type round-trip pinning test below (M1, Wave-2
   * review) — every other shared-suite test goes through the public adapter API only.
   */
  findRecordFilePath: (dir: string, id: string) => string;
}

/**
 * Registers a `describe` block (via vitest's globals) exercising the adapter-agnostic
 * `KnowledgeStoreAdapter` contract against a real `mkdtempSync(tmpdir())` store per
 * test. Call from within an adapter's own `*.contract.test.ts` file.
 */
export function runAdapterContractSuite(options: ContractSuiteOptions): void {
  const { label, createAdapter, findRecordFilePath } = options;

  describe(`${label} — shared KnowledgeStoreAdapter contract (store-contract.md §6/§A.5/§B.4/§H)`, () => {
    let dir: string;
    let adapter: KnowledgeStoreAdapter;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), `${label}-contract-`));
      adapter = await createAdapter(dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test('creates a raw → compiled → concept chain with source/example links', async () => {
      const rawId = await adapter.create({
        type: 'raw',
        title: 'Customer call transcript',
        body: 'The customer said the onboarding flow was confusing.',
        category: 'engineering.onboarding',
        provenance: { agent: 'ingest-agent' },
      });

      const compiledId = await adapter.create({
        type: 'compiled',
        title: 'Onboarding confusion summary',
        body: 'Users report onboarding is confusing.',
        category: 'engineering.onboarding',
        links: [{ target_id: rawId, kind: 'source' }],
        provenance: { agent: 'compile-agent', source_ids: [rawId] },
      });

      const conceptId = await adapter.create({
        type: 'concept',
        title: 'Onboarding friction',
        body: 'Friction points encountered during first-run setup.',
        category: 'engineering.onboarding',
        links: [{ target_id: compiledId, kind: 'example' }],
        provenance: { agent: 'concept-agent' },
      });

      const compiled = await adapter.get(compiledId);
      expect(compiled?.links).toEqual([{ target_id: rawId, kind: 'source' }]);

      const concept = await adapter.get(conceptId);
      expect(concept?.links).toEqual([
        { target_id: compiledId, kind: 'example' },
      ]);

      const compiledLinks = await adapter.getLinks(compiledId);
      expect(compiledLinks.forward).toEqual([
        { target_id: rawId, kind: 'source' },
      ]);
      const rawLinks = await adapter.getLinks(rawId);
      expect(rawLinks.reverse).toEqual([
        { source_id: compiledId, kind: 'source' },
      ]);

      const conceptLinks = await adapter.getLinks(conceptId);
      expect(conceptLinks.forward).toEqual([
        { target_id: compiledId, kind: 'example' },
      ]);
      const compiledReverse = await adapter.getLinks(compiledId);
      expect(compiledReverse.reverse).toEqual([
        { source_id: conceptId, kind: 'example' },
      ]);
    });

    test('does not enforce compiled -> source link presence at create (adapter is permissive per §8; category/type/body/agent ARE enforced)', async () => {
      await expect(
        adapter.create({
          type: 'compiled',
          title: 'No source yet',
          body: 'placeholder',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        }),
      ).resolves.toEqual(expect.any(String));
    });

    test('create rejects missing/invalid required fields with MISSING_EVIDENCE', async () => {
      const base = {
        type: 'raw' as const,
        title: 'T',
        body: 'B',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      };

      await expect(
        adapter.create({ ...base, type: undefined as any }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, type: 'invalid-type' as any }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, title: '' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
      await expect(adapter.create({ ...base, body: '' })).rejects.toMatchObject(
        {
          code: 'MISSING_EVIDENCE',
        },
      );
      await expect(
        adapter.create({ ...base, category: '' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
      await expect(
        adapter.create({ ...base, category: 'Bad Category!' }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, provenance: { agent: '' } }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    });

    // M1 (Wave-2 review): this pinning test was previously default-store-only
    // (`default-store.contract.test.ts`) despite proving an adapter-agnostic
    // guarantee. Moved here so BOTH `kit-default-store` and `kit-obsidian-store` run
    // it — see `findRecordFilePath` on `ContractSuiteOptions` for the adapter-specific
    // file-location lookup this test needs (the guarantee itself is not adapter-
    // specific; only where the `.md` file lives on disk is).
    test('preserves unknown frontmatter keys and unknown type strings on round-trip (never dropped on rewrite)', async () => {
      // Forward-compat tenet (Open Knowledge Format v0.1 alignment, design-input note): a
      // conforming reader/writer must tolerate and PRESERVE fields/type strings it doesn't
      // recognize — never silently drop them on a rewrite. Simulate a record written by some
      // future producer (a foreign top-level key + a not-yet-canonical `type`) by writing the
      // file directly (bypassing this adapter's own `create()`, which validates `type` against
      // the CURRENT known set — that validation is a write-time contract gate for NEW Station-
      // authored records, not a read-time filter).
      const id = await adapter.create({
        type: 'raw',
        title: 'Forward-compat fixture',
        body: 'original body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findRecordFilePath(dir, id);
      const before = readFileSync(filePath, 'utf-8');
      const endIdx = before.indexOf('\n---\n', 4);
      const frontmatter = yaml.load(before.slice(4, endIdx)) as Record<
        string,
        unknown
      >;
      frontmatter.type = 'future-record-type';
      frontmatter.custom_future_field = 'preserved-value';
      const bodyText = before.slice(endIdx + 5).replace(/^\n+/, '');
      writeFileSync(
        filePath,
        `---\n${yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd()}\n---\n\n${bodyText}`,
        'utf-8',
      );

      const read = await adapter.get(id);
      expect(read?.type).toBe('future-record-type');
      expect(
        (read as unknown as Record<string, unknown>).custom_future_field,
      ).toBe('preserved-value');

      const listed = await adapter.listByType('future-record-type' as any);
      expect(listed.find((r) => r.id === id)).toBeDefined();

      await adapter.update(id, { title: 'Renamed' }, { agent: 'agent-1' });
      const after = await adapter.get(id);
      expect(after?.type).toBe('future-record-type');
      expect(
        (after as unknown as Record<string, unknown>).custom_future_field,
      ).toBe('preserved-value');
      expect(after?.title).toBe('Renamed');

      // Re-resolve the file path AFTER update() — an adapter that routes by
      // title/category (Obsidian) may have moved the file when the title changed;
      // `kit-default-store`'s flat `records/<id>.md` path is stable either way.
      const filePathAfter = findRecordFilePath(dir, id);
      const raw = readFileSync(filePathAfter, 'utf-8');
      const end2 = raw.indexOf('\n---\n', 4);
      const fm2 = yaml.load(raw.slice(4, end2)) as Record<string, unknown>;
      expect(fm2.custom_future_field).toBe('preserved-value');
      expect(fm2.type).toBe('future-record-type');
    });

    test('update requires an existing record, evidence.agent, and >=1 mutable field', async () => {
      const id = await adapter.create({
        type: 'raw',
        title: 'T',
        body: 'B',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.update('nonexistent-id', { title: 'x' }, { agent: 'agent-1' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        adapter.update(id, { title: 'x' }, {} as any),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });

      await expect(
        adapter.update(id, {}, { agent: 'agent-1' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });

      await adapter.update(
        id,
        { title: 'Updated title' },
        { agent: 'agent-1' },
      );
      const updated = await adapter.get(id);
      expect(updated?.title).toBe('Updated title');
      expect(updated?.mutation_log?.at(-1)).toMatchObject({
        op: 'update',
        agent: 'agent-1',
      });
    });

    test('link is idempotent and rejects unknown source/target', async () => {
      const a = await adapter.create({
        type: 'raw',
        title: 'A',
        body: 'a',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const b = await adapter.create({
        type: 'raw',
        title: 'B',
        body: 'b',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await adapter.link(a, [{ target_id: b, kind: 'related' }], {
        agent: 'agent-1',
      });
      await adapter.link(a, [{ target_id: b, kind: 'related' }], {
        agent: 'agent-1',
      });
      const links = await adapter.getLinks(a);
      expect(links.forward).toEqual([{ target_id: b, kind: 'related' }]);

      await expect(
        adapter.link('nonexistent', [{ target_id: b, kind: 'related' }], {
          agent: 'agent-1',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adapter.link(a, [{ target_id: 'nonexistent', kind: 'related' }], {
          agent: 'agent-1',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adapter.link(a, [], { agent: 'agent-1' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
    });

    test('propose → apply gates a concept body change through a proposes link; reject leaves it unchanged', async () => {
      const concept = await adapter.create({
        type: 'concept',
        title: 'Concept A',
        body: 'Original definition',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence for the proposal',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.propose(concept, proposer, { agent: 'agent-1' } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.propose(concept, proposer, {
        agent: 'agent-1',
        proposal: 'Broaden the definition',
      });

      await expect(
        adapter.apply(concept, proposer, {
          agent: 'agent-1',
          new_body: 'Broadened definition',
        } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.apply(concept, proposer, {
        agent: 'agent-1',
        new_body: 'Broadened definition',
        rationale: 'Field evidence supports it',
      });

      const updatedConcept = await adapter.get(concept);
      expect(updatedConcept?.body).toBe('Broadened definition');

      const proposer2 = await adapter.create({
        type: 'raw',
        title: 'Second proposal source',
        body: 'more evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.propose(concept, proposer2, {
        agent: 'agent-1',
        proposal: 'Narrow it back',
      });
      await adapter.reject(concept, proposer2, {
        agent: 'agent-1',
        reason: 'Not enough evidence',
      });
      const afterReject = await adapter.get(concept);
      expect(afterReject?.body).toBe('Broadened definition');

      await expect(
        adapter.apply(concept, 'nonexistent-proposer', {
          agent: 'agent-1',
          new_body: 'x',
          rationale: 'y',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // propose/apply/reject: concept_id must resolve to a `concept`-typed record
    // (store-contract.md §6.4/§6.5/§6.6: "concept_id does not exist or is not of type
    // 'concept'." — a wrong-type-but-existing id must reject with MISSING_EVIDENCE).

    test('propose rejects when concept_id resolves to a non-concept record', async () => {
      const notAConcept = await adapter.create({
        type: 'raw',
        title: 'Just a raw record',
        body: 'not a concept',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.propose(notAConcept, proposer, {
          agent: 'agent-1',
          proposal: 'Broaden the definition',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    });

    test('apply rejects when concept_id resolves to a non-concept record', async () => {
      const notAConcept = await adapter.create({
        type: 'compiled',
        title: 'Just a compiled record',
        body: 'not a concept',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.link(
        proposer,
        [{ target_id: notAConcept, kind: 'proposes' }],
        { agent: 'agent-1' },
      );

      await expect(
        adapter.apply(notAConcept, proposer, {
          agent: 'agent-1',
          new_body: 'x',
          rationale: 'y',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    });

    test('reject rejects when concept_id resolves to a non-concept record', async () => {
      const notAConcept = await adapter.create({
        type: 'snapshot',
        title: 'Just a snapshot record',
        body: 'not a concept',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.link(
        proposer,
        [{ target_id: notAConcept, kind: 'proposes' }],
        { agent: 'agent-1' },
      );

      await expect(
        adapter.reject(notAConcept, proposer, {
          agent: 'agent-1',
          reason: 'Not applicable',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    });

    test('propose rejects a nonexistent concept_id with NOT_FOUND', async () => {
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.propose('nonexistent-concept', proposer, {
          agent: 'agent-1',
          proposal: 'Broaden the definition',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('reject rejects a nonexistent concept_id with NOT_FOUND', async () => {
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.reject('nonexistent-concept', proposer, {
          agent: 'agent-1',
          reason: 'Not applicable',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // supersede (Addendum A.5/A.6) — the cross-adapter guarantee (Addendum L §L.6,
    // store-contract.md:1543-1546, read alongside J.3) is `get`/
    // `getLinks(...).reverse`, NOT listByType/listByCategory inclusion (see the file
    // header note for why that's deliberately excluded from this shared suite).

    test('supersede never deletes; superseded records remain gettable with a reverse supersedes link', async () => {
      const oldCompiled = await adapter.create({
        type: 'compiled',
        title: 'Old summary',
        body: 'stale content',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const newCompiled = await adapter.create({
        type: 'compiled',
        title: 'New summary',
        body: 'fresh content',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.supersede(newCompiled, [oldCompiled], {
          agent: 'agent-1',
        } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.supersede(newCompiled, [oldCompiled], {
        agent: 'agent-1',
        rationale: 'Newer data supersedes the old summary',
      });

      const old = await adapter.get(oldCompiled);
      expect(old).not.toBeNull();
      expect(old?.body).toBe('stale content');
      expect(old?.mutation_log?.some((e) => e.op === 'superseded-by')).toBe(
        true,
      );

      const oldLinks = await adapter.getLinks(oldCompiled);
      expect(oldLinks.reverse).toEqual(
        expect.arrayContaining([
          { source_id: newCompiled, kind: 'supersedes' },
        ]),
      );

      await expect(
        adapter.supersede(newCompiled, [], {
          agent: 'agent-1',
          rationale: 'x',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.supersede('nonexistent', [oldCompiled], {
          agent: 'agent-1',
          rationale: 'x',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // retire (Addendum B.2/B.4/B.5) — status-based working-set exclusion is identical
    // across both adapters (neither archives on retire; only supersede archives).

    test('retire enforces the status transition table and working-set exclusion', async () => {
      const id = await adapter.create({
        type: 'compiled',
        title: 'To retire',
        body: 'content',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.retire(id, 'retired', { agent: 'agent-1' } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.retire(id, 'implemented', {
          agent: 'agent-1',
          rationale: 'shipped',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.retire(id, 'implemented', {
        agent: 'agent-1',
        rationale: 'shipped',
        implementedByRef: 'PR#123',
      });
      let record = await adapter.get(id);
      expect(record?.status).toBe('implemented');

      await adapter.retire(id, 'retired', {
        agent: 'agent-1',
        rationale: 'fully done',
      });
      record = await adapter.get(id);
      expect(record?.status).toBe('retired');

      await expect(
        adapter.retire(id, 'implemented', {
          agent: 'agent-1',
          rationale: 'x',
          implementedByRef: 'y',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      const listed = await adapter.listByType('compiled');
      expect(listed.find((r) => r.id === id)).toBeUndefined();
      const listedWithRetired = await adapter.listByType('compiled', {
        includeRetired: true,
      });
      expect(listedWithRetired.find((r) => r.id === id)).toBeDefined();

      const byCategory = await adapter.listByCategory('engineering');
      expect(byCategory.find((r) => r.id === id)).toBeUndefined();
      const byCategoryWithRetired = await adapter.listByCategory(
        'engineering',
        {
          includeRetired: true,
        },
      );
      expect(byCategoryWithRetired.find((r) => r.id === id)).toBeDefined();

      expect(record?.provenance.agent).toBe('agent-1');
    });

    test('retire on a direct active -> retired transition also succeeds', async () => {
      const id = await adapter.create({
        type: 'concept',
        title: 'Direct retire',
        body: 'content',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.retire(id, 'retired', {
        agent: 'agent-1',
        rationale: 'obsolete',
      });
      const record = await adapter.get(id);
      expect(record?.status).toBe('retired');
    });

    test('listByCategory supports exact and prefix matching', async () => {
      await adapter.create({
        type: 'concept',
        title: 'API concept',
        body: 'b',
        category: 'engineering.api',
        provenance: { agent: 'agent-1' },
      });
      await adapter.create({
        type: 'concept',
        title: 'REST concept',
        body: 'b',
        category: 'engineering.api.rest',
        provenance: { agent: 'agent-1' },
      });
      await adapter.create({
        type: 'concept',
        title: 'Unrelated',
        body: 'b',
        category: 'design',
        provenance: { agent: 'agent-1' },
      });

      const exact = await adapter.listByCategory('engineering.api');
      expect(exact).toHaveLength(1);

      const prefixed = await adapter.listByCategory('engineering.api', {
        prefix: true,
      });
      expect(prefixed).toHaveLength(2);
    });

    describe('Addendum H — identity resolution', () => {
      test('resolves by exact id', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Exact id test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const record = await adapter.get(id);
        expect(record?.id).toBe(id);
      });

      test('resolves by slug alias and survives a category restructure', async () => {
        const id = await adapter.create({
          type: 'concept',
          title: 'Slug test',
          body: 'b',
          category: 'decision.strategy',
          aliases: ['decision.strategy/2026-07-05-gtm-direction'],
          provenance: { agent: 'agent-1' },
        });

        const bySlug = await adapter.get(
          'decision.strategy/2026-07-05-gtm-direction',
        );
        expect(bySlug?.id).toBe(id);

        await adapter.update(
          id,
          { category: 'decision.gtm' },
          { agent: 'agent-1' },
        );
        const stillResolves = await adapter.get(
          'decision.strategy/2026-07-05-gtm-direction',
        );
        expect(stillResolves?.id).toBe(id);
        expect(stillResolves?.category).toBe('decision.gtm');
      });

      test('aliases are append-only across update calls', async () => {
        const id = await adapter.create({
          type: 'concept',
          title: 'Append-only aliases',
          body: 'b',
          category: 'engineering',
          aliases: ['engineering/first-alias'],
          provenance: { agent: 'agent-1' },
        });
        await adapter.update(
          id,
          { aliases: ['engineering/second-alias'] },
          { agent: 'agent-1' },
        );
        const record = await adapter.get(id);
        expect(record?.aliases).toEqual(
          expect.arrayContaining([
            'engineering/first-alias',
            'engineering/second-alias',
          ]),
        );
        expect(await adapter.get('engineering/first-alias')).toMatchObject({
          id,
        });
        expect(await adapter.get('engineering/second-alias')).toMatchObject({
          id,
        });
      });

      test('a slug already owned by a different record is SLUG_CONFLICT', async () => {
        await adapter.create({
          type: 'concept',
          title: 'Owner',
          body: 'b',
          category: 'engineering',
          aliases: ['engineering/shared-slug'],
          provenance: { agent: 'agent-1' },
        });
        await expect(
          adapter.create({
            type: 'concept',
            title: 'Collider',
            body: 'b',
            category: 'engineering',
            aliases: ['engineering/shared-slug'],
            provenance: { agent: 'agent-1' },
          }),
        ).rejects.toMatchObject({ code: 'SLUG_CONFLICT' });
      });

      test('resolves an unambiguous >=8-char id prefix', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Prefix test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const prefix = id.slice(0, 8);
        const record = await adapter.get(prefix);
        expect(record?.id).toBe(id);
      });

      test('a sub-8-char handle never prefix-matches (resolves to null, not a match)', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Short handle test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const shortHandle = id.slice(0, 4);
        const record = await adapter.get(shortHandle);
        expect(record).toBeNull();
      });

      test('an ambiguous id prefix throws AMBIGUOUS_ID with .matches', async () => {
        const sharedPrefix = 'aaaaaaaa';
        const idA = `${sharedPrefix}-1111-4111-8111-111111111111`;
        const idB = `${sharedPrefix}-2222-4222-8222-222222222222`;
        await adapter.create({
          id: idA,
          type: 'raw',
          title: 'A',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        await adapter.create({
          id: idB,
          type: 'raw',
          title: 'B',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });

        await expect(adapter.get(sharedPrefix)).rejects.toMatchObject({
          code: 'AMBIGUOUS_ID',
          matches: expect.arrayContaining([idA, idB]),
        });
        await expect(adapter.getLinks(sharedPrefix)).rejects.toMatchObject({
          code: 'AMBIGUOUS_ID',
        });
      });

      test('an unresolved handle returns null from get and empty arrays from getLinks', async () => {
        expect(
          await adapter.get('00000000-0000-0000-0000-000000000000'),
        ).toBeNull();
        const links = await adapter.getLinks(
          '00000000-0000-0000-0000-000000000000',
        );
        expect(links).toEqual({ forward: [], reverse: [] });
      });
    });
  });
}
