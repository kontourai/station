/**
 * Partition-key cross-store-leakage regression — the DEDICATED suite for the
 * `store` partition-key behavior that ADR-0009 Probe A proved out under its
 * "SCOPED QUERY" heading (`docs/adr/0009-treat-knowledge-stores-as-canonical-and-index-as-derived.md`,
 * "SCOPED QUERY store=root:project-station" transcript block). `sqlite-vec-index-provider.test.ts`
 * already exercises `removeRoot`/scoped-search/`rebuildRoot` as *one case among many* CRUD
 * behaviors; this file's sole job is the leakage property itself, pushed harder than that
 * sibling suite does: every scoped-search probe here is deliberately built so the OTHER
 * root's record is the *global* nearest neighbor (score 1.0, distance 0) while the correctly-
 * scoped result is a strictly weaker match (score 0.6) — a same-magnitude tie (as used
 * elsewhere) could pass by accident if scoping were silently ignored, but a same-magnitude
 * global-nearest-neighbor exclusion cannot.
 *
 * Self-contained: no import from `./__fixtures__/corpus.ts` (owned by a sibling Wave 5 task) —
 * deterministic vectors are inlined here as plain literals so this suite has zero shared-file
 * coupling with parallel workers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeIndexEntry } from '@kontourai/station-contracts/knowledge-index';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

const ROOT_PERSONAL = 'root:personal';
const ROOT_PROJECT = 'root:project-station';

/** Query vector every scoped/unscoped search below is run against. */
const QUERY = [1, 0, 0, 0];

function entry(
  rootId: string,
  recordId: string,
  vector: number[],
  text = recordId,
): KnowledgeIndexEntry {
  return { rootId, recordId, chunkOrdinal: 0, text, vector, metadata: {} };
}

/**
 * The leakage-probe fixture: two roots, each holding a "primary" record and a
 * "secondary" record.
 *
 * - `project-primary` is identical to `QUERY` ([1,0,0,0]) — cosine distance 0,
 *   score 1.0. It is the **global nearest neighbor** for every query below.
 * - `personal-primary` is [0.6, 0.8, 0, 0] — cosine similarity 0.6 against
 *   `QUERY` (0.6*1 + 0.8*0 = 0.6, both unit vectors), a real but strictly
 *   weaker match than the project root's record.
 * - `personal-secondary`/`project-secondary` are orthogonal to `QUERY` (score 0),
 *   present only to give each root a second row for count/ordering assertions.
 *
 * This shape is the strongest leakage probe possible: a scoped search to
 * `root:personal` must surface its own (weaker) match while excluding a
 * record that is *globally* closer than anything in-scope — silently
 * ignoring the partition key would make the global winner appear first.
 */
function seedEntries(): KnowledgeIndexEntry[] {
  return [
    entry(ROOT_PERSONAL, 'personal-primary', [0.6, 0.8, 0, 0]),
    entry(ROOT_PERSONAL, 'personal-secondary', [0, 1, 0, 0]),
    entry(ROOT_PROJECT, 'project-primary', [1, 0, 0, 0]),
    entry(ROOT_PROJECT, 'project-secondary', [0, 0, 1, 0]),
  ];
}

describe('SqliteVecIndexProvider partition-key cross-store-leakage regression (ADR-0009 Probe A "SCOPED QUERY")', () => {
  let dir: string;
  let provider: SqliteVecIndexProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'partition-scoping-'));
    provider = new SqliteVecIndexProvider({ dbPath: join(dir, 'index.db') });
  });

  afterEach(() => {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('sanity: the other root record really is the unscoped global nearest neighbor', async () => {
    await provider.upsert(seedEntries());

    const unscoped = await provider.search(QUERY, { topK: 1 });

    expect(unscoped).toHaveLength(1);
    expect(unscoped[0].recordId).toBe('project-primary');
    expect(unscoped[0].rootId).toBe(ROOT_PROJECT);
    expect(unscoped[0].score).toBeCloseTo(1, 5);
  });

  test('scoped search to root:personal returns zero entries referencing root:project-station, even though project-primary is the global nearest neighbor', async () => {
    await provider.upsert(seedEntries());

    const scoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PERSONAL],
    });

    expect(scoped.map((h) => h.recordId)).not.toContain('project-primary');
    expect(scoped.map((h) => h.recordId)).not.toContain('project-secondary');
    expect(scoped.every((h) => h.rootId === ROOT_PERSONAL)).toBe(true);
    // The scoped top hit is the weaker in-scope match, NOT the excluded global winner.
    expect(scoped[0].recordId).toBe('personal-primary');
    expect(scoped[0].score).toBeCloseTo(0.6, 5);
    expect(scoped[0].score).toBeLessThan(1);
  });

  test('scoped search to root:project-station returns zero entries referencing root:personal (symmetric leakage check)', async () => {
    await provider.upsert(seedEntries());

    const scoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PROJECT],
    });

    expect(scoped.map((h) => h.recordId)).not.toContain('personal-primary');
    expect(scoped.map((h) => h.recordId)).not.toContain('personal-secondary');
    expect(scoped.every((h) => h.rootId === ROOT_PROJECT)).toBe(true);
    expect(scoped[0].recordId).toBe('project-primary');
    expect(scoped[0].score).toBeCloseTo(1, 5);
  });

  test('unscoped search is eligible to return both roots, correctly ranked by true similarity', async () => {
    await provider.upsert(seedEntries());

    const unscoped = await provider.search(QUERY, { topK: 10 });

    const rootIdsSeen = new Set(unscoped.map((h) => h.rootId));
    expect(rootIdsSeen.has(ROOT_PERSONAL)).toBe(true);
    expect(rootIdsSeen.has(ROOT_PROJECT)).toBe(true);
    expect(unscoped).toHaveLength(4);
    // Global ranking: project-primary (1.0) > personal-primary (0.6) > the two
    // orthogonal secondaries (0), which is exactly the ranking a leaking scope
    // check would also produce for the top two — the earlier tests are what
    // prove scoping is actually applied, not just that ranking is sane.
    expect(unscoped[0].recordId).toBe('project-primary');
    expect(unscoped[1].recordId).toBe('personal-primary');
  });

  test('removeRoot(root:personal) drops only that partition — counts and searches both confirm', async () => {
    await provider.upsert(seedEntries());

    await provider.removeRoot(ROOT_PERSONAL);

    expect((await provider.stats(ROOT_PERSONAL)).chunks).toBe(0);
    expect((await provider.stats(ROOT_PROJECT)).chunks).toBe(2);

    const personalScoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PERSONAL],
    });
    expect(personalScoped).toEqual([]);

    const projectScoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PROJECT],
    });
    expect(projectScoped.map((h) => h.recordId).sort()).toEqual([
      'project-primary',
      'project-secondary',
    ]);

    // Unscoped search now only has the surviving root's records to find.
    const unscoped = await provider.search(QUERY, { topK: 10 });
    expect(unscoped.every((h) => h.rootId === ROOT_PROJECT)).toBe(true);
    expect(unscoped).toHaveLength(2);
  });

  /**
   * Rebuild-shaped cross-contamination guard. Full end-to-end `rebuildRoot`
   * (real `KnowledgeStoreProvider` root walk + chunk + embed) is already
   * covered by `sqlite-vec-index-provider.test.ts`'s two `rebuildRoot` tests,
   * and its recall-equivalence property (incrementally-built vs.
   * rebuilt-from-scratch, same ranked ids) is the dedicated subject of the
   * sibling `lossless-rebuild.test.ts` worker task — constructing a second
   * real store-root fixture here would duplicate both without adding
   * leakage-specific coverage. What this test adds is the *partition*
   * angle: `rebuildRoot`'s own implementation is delete-the-root's-rows-then-
   * reinsert (see `sqlite-vec-index-provider.ts`'s `writeEntries`/
   * `deleteRootRows`), so re-deriving one root via that exact
   * remove-then-upsert sequence and asserting the other root's partition is
   * bit-for-bit unchanged throughout is a faithful, lightweight regression
   * for "rebuild must not cross-contaminate other roots' partitions".
   */
  test('rebuild-style re-derivation (removeRoot + re-upsert) of root:project-station leaves root:personal untouched', async () => {
    await provider.upsert(seedEntries());

    // Simulate rebuildRoot's internal delete-then-reinsert for ONE root only,
    // deriving different vectors/text (as a real re-embed would produce).
    await provider.removeRoot(ROOT_PROJECT);
    await provider.upsert([
      entry(ROOT_PROJECT, 'project-primary-v2', [1, 0, 0, 0], 'rebuilt text'),
    ]);

    // root:personal's partition must be exactly as it was before the other
    // root's "rebuild" — same count, same records, same scores.
    expect((await provider.stats(ROOT_PERSONAL)).chunks).toBe(2);
    const personalScoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PERSONAL],
    });
    expect(personalScoped.map((h) => h.recordId)).toEqual([
      'personal-primary',
      'personal-secondary',
    ]);
    expect(personalScoped[0].score).toBeCloseTo(0.6, 5);
    expect(personalScoped.every((h) => h.rootId === ROOT_PERSONAL)).toBe(true);

    // Sanity: the rebuilt root reflects only the new derivation.
    const projectScoped = await provider.search(QUERY, {
      topK: 5,
      rootIds: [ROOT_PROJECT],
    });
    expect(projectScoped.map((h) => h.recordId)).toEqual([
      'project-primary-v2',
    ]);
  });
});
