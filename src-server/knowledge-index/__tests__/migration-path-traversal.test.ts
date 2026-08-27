/**
 * Path-traversal regression tests (SEC-1, `s201-knowledge-retrieval` remediation
 * pass). `migratePreIndexKnowledge` joins a caller-supplied `projectSlug` (and pre-index
 * directory names it discovers via `readdirSync`) into filesystem paths on both the
 * read side (`discoverPreIndexNamespaces`) and the write side
 * (`knowledgeStoreRootPathForNamespace` -> `kit-default-store`'s `mkdirSync`/
 * `writeFileSync`) — see `../path-safety.ts`'s module doc for the full threat model.
 * This suite proves:
 *   (1) a caller-supplied traversal-shaped `projectSlug` is rejected outright (throws),
 *       never silently no-op'd or reaching a filesystem call;
 *   (2) a crafted/traversal-shaped pre-index directory name discovered on disk is
 *       skipped, not crashed on, while legitimate sibling namespaces still migrate;
 *   (3) nothing is ever created outside the temp `dataDir` a test run owns.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { migratePreIndexKnowledge } from '../migrate-pre-index-knowledge.js';
import { isSafePathSegment } from '../path-safety.js';
import { SqliteVecIndexProvider } from '../sqlite-vec-index-provider.js';

class FakeRootPersistence {
  private roots: KnowledgeStoreRoot[] = [];

  listKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return this.roots.slice();
  }

  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): void {
    const idx = this.roots.findIndex((r) => r.id === root.id);
    if (idx >= 0) this.roots[idx] = root;
    else this.roots.push(root);
  }

  removeKnowledgeStoreRoot(id: string): void {
    const index = this.roots.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`Knowledge store root '${id}' not found`);
    this.roots.splice(index, 1);
  }
}

function deterministicVector(text: string, dim: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vec.push((seed / 0xffffffff) * 2 - 1);
  }
  return vec;
}

class StubEmbedder implements IEmbeddingProvider {
  readonly id = 'stub-embedder';
  readonly displayName = 'Deterministic stub embedder';
  constructor(private readonly dim: number) {}
  dimensions(): number {
    return this.dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

function seedNamespace(
  dataDir: string,
  projectSlug: string,
  namespace: string,
  doc: { id: string; filename: string; body: string },
) {
  const knowledgeDir = join(
    dataDir,
    'projects',
    projectSlug,
    'knowledge',
    namespace,
  );
  mkdirSync(join(knowledgeDir, 'files'), { recursive: true });
  writeFileSync(
    join(knowledgeDir, 'metadata.json'),
    JSON.stringify([
      {
        id: doc.id,
        filename: doc.filename,
        namespace,
        path: doc.filename,
        source: 'upload',
        chunkCount: 1,
        createdAt: new Date().toISOString(),
      },
    ]),
  );
  writeFileSync(join(knowledgeDir, 'files', doc.filename), doc.body);
}

/** Recursively list every path (relative to `root`) under `root`, or `[]` if `root`
 * doesn't exist — used to prove nothing new was created outside `dataDir`. */
function listAllPaths(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('migratePreIndexKnowledge — path traversal (SEC-1)', () => {
  let dataDir: string;
  let canaryParentDir: string;
  let indexDbDir: string;
  let persistence: FakeRootPersistence;
  let store: KnowledgeStoreProvider;
  let indexProvider: SqliteVecIndexProvider;
  let embedder: StubEmbedder;

  beforeEach(() => {
    // `dataDir` is nested one level inside `canaryParentDir` so a `projectSlug` of
    // `../<marker>` would (if unvalidated) resolve to a sibling of `dataDir` itself —
    // a location this suite can directly assert stays untouched.
    canaryParentDir = mkdtempSync(
      join(tmpdir(), 'migration-traversal-parent-'),
    );
    dataDir = join(canaryParentDir, 'station-home');
    mkdirSync(dataDir, { recursive: true });
    indexDbDir = mkdtempSync(join(tmpdir(), 'migration-traversal-index-'));
    persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
    indexProvider = new SqliteVecIndexProvider({
      dbPath: join(indexDbDir, 'index.db'),
    });
    embedder = new StubEmbedder(4);
  });

  afterEach(() => {
    indexProvider.close();
    rmSync(canaryParentDir, { recursive: true, force: true });
    rmSync(indexDbDir, { recursive: true, force: true });
  });

  test('isSafePathSegment rejects traversal-shaped values and accepts ordinary slugs', () => {
    expect(isSafePathSegment('acme')).toBe(true);
    expect(isSafePathSegment('Acme-Project_1.0')).toBe(true);
    expect(isSafePathSegment('../../../evil')).toBe(false);
    expect(isSafePathSegment('..')).toBe(false);
    expect(isSafePathSegment('foo/../bar')).toBe(false);
    expect(isSafePathSegment('foo/bar')).toBe(false);
    expect(isSafePathSegment('foo\\bar')).toBe(false);
    expect(isSafePathSegment('')).toBe(false);
    expect(isSafePathSegment(undefined)).toBe(false);
  });

  test("a caller-supplied traversal projectSlug is rejected (throws), never silently no-op'd", async () => {
    const maliciousSlug = '../../../evil';

    await expect(
      migratePreIndexKnowledge(
        { dataDir, store, indexProvider, embedder },
        { projectSlug: maliciousSlug },
      ),
    ).rejects.toThrow(/projectSlug/i);

    // No K2 store root was ever created as a side effect of the rejected call.
    expect(await store.listRoots()).toEqual([]);
    // Nothing was created anywhere outside (or inside) dataDir as a result.
    expect(listAllPaths(dataDir)).toEqual([]);
    expect(existsSync(join(canaryParentDir, 'evil'))).toBe(false);
  });

  test('a crafted pre-index directory name containing ".." is skipped during discovery, not thrown on — legitimate sibling namespaces still migrate', async () => {
    // Legitimate namespace — must still migrate despite a hostile sibling directory.
    seedNamespace(dataDir, 'acme', 'default', {
      id: 'pre-index-doc-1',
      filename: 'pre-index.md',
      body: 'legitimate pre-index content',
    });

    // Crafted project-slug-shaped directory name containing a traversal substring.
    // Not an actual OS-level escape (POSIX filenames can't contain `/`), but exactly
    // the class of untrusted `readdirSync` entry `isSafePathSegment` must reject —
    // defense in depth against this value ever reaching a `join()` call.
    const craftedProjectDir = join(dataDir, 'projects', 'evil..project');
    mkdirSync(join(craftedProjectDir, 'knowledge', 'default', 'files'), {
      recursive: true,
    });
    writeFileSync(
      join(craftedProjectDir, 'knowledge', 'default', 'metadata.json'),
      JSON.stringify([
        {
          id: 'crafted-doc',
          filename: 'crafted.md',
          namespace: 'default',
          path: 'crafted.md',
          source: 'upload',
          chunkCount: 1,
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    writeFileSync(
      join(craftedProjectDir, 'knowledge', 'default', 'files', 'crafted.md'),
      'crafted content',
    );

    // Crafted NAMESPACE directory name (under a legitimate project slug) containing
    // the same traversal substring.
    const craftedNamespaceDir = join(
      dataDir,
      'projects',
      'acme',
      'knowledge',
      'evil..namespace',
    );
    mkdirSync(join(craftedNamespaceDir, 'files'), { recursive: true });
    writeFileSync(
      join(craftedNamespaceDir, 'metadata.json'),
      JSON.stringify([
        {
          id: 'crafted-ns-doc',
          filename: 'crafted-ns.md',
          namespace: 'evil..namespace',
          path: 'crafted-ns.md',
          source: 'upload',
          chunkCount: 1,
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    writeFileSync(
      join(craftedNamespaceDir, 'files', 'crafted-ns.md'),
      'crafted namespace content',
    );

    const result = await migratePreIndexKnowledge({
      dataDir,
      store,
      indexProvider,
      embedder,
    });

    // Only the legitimate namespace was migrated; the two crafted directory names
    // were skipped during discovery rather than crashing the whole run.
    expect(result.documentsMigrated).toBe(1);
    expect(result.namespacesProcessed).toEqual(['project-acme']);
    expect(result.namespaceResults.every((r) => r.status === 'ok')).toBe(true);

    const roots = await store.listRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].scope).toEqual({ kind: 'project', projectSlug: 'acme' });

    // Nothing was created outside dataDir.
    expect(existsSync(join(canaryParentDir, 'evil..project'))).toBe(false);
  });
});
