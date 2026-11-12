import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  KnowledgeStoreConflictError,
  KnowledgeStoreCorruptionError,
} from '../../../knowledge-store/errors.js';
import {
  buildKnowledgeDirectoryTree,
  listKnowledgeDocuments,
  scanKnowledgeDirectories,
} from '../knowledge-filesystem.js';
import { applyKnowledgeScanPatterns } from '../knowledge-scan-utils.js';
import {
  mutateKnowledgeDocuments,
  saveKnowledgeMeta,
} from '../knowledge-storage.js';

describe('knowledge-filesystem helpers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-filesystem-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('bounds hostile repeated-glob patterns (station#2384)', () => {
    const file = join(dir, 'source.ts');
    const startedAt = performance.now();
    expect(
      applyKnowledgeScanPatterns([file], dir, ['**'.repeat(50_000)]),
    ).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test('listKnowledgeDocuments filters by path, tags, and metadata', async () => {
    const storageDir = join(dir, 'default');
    await saveKnowledgeMeta({ storageDir, dataDir: dir, projectSlug: 'test' }, [
      {
        id: 'doc-1',
        filename: 'docs/guide.md',
        namespace: 'default',
        path: 'docs/guide.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        metadata: { tags: ['planning'], owner: 'ops' },
      },
      {
        id: 'doc-2',
        filename: 'notes/todo.md',
        namespace: 'default',
        path: 'notes/todo.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-02T00:00:00.000Z',
        metadata: { tags: ['research'], owner: 'eng' },
      },
    ]);

    const docs = await listKnowledgeDocuments({
      projectSlug: 'test',
      namespace: 'default',
      filter: {
        pathPrefix: 'docs/',
        tags: ['planning'],
        metadata: { owner: 'ops' },
      },
      dataDir: dir,
      listNamespaces: () => [
        { id: 'default', label: 'Default', behavior: 'rag' },
      ],
      resolveStorageDir: () => storageDir,
    });

    expect(docs).toEqual([
      expect.objectContaining({
        id: 'doc-1',
        filename: 'docs/guide.md',
      }),
    ]);
  });

  test('buildKnowledgeDirectoryTree returns nested file counts', async () => {
    const storageDir = join(dir, 'default');
    mkdirSync(join(storageDir, 'files', 'docs'), { recursive: true });
    writeFileSync(join(storageDir, 'files', 'docs', 'guide.md'), '# Guide');
    writeFileSync(join(storageDir, 'files', 'root.md'), '# Root');
    await saveKnowledgeMeta({ storageDir, dataDir: dir, projectSlug: 'test' }, [
      {
        id: 'doc-1',
        filename: 'docs/guide.md',
        namespace: 'default',
        path: 'docs/guide.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'doc-2',
        filename: 'root.md',
        namespace: 'default',
        path: 'root.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const tree = await buildKnowledgeDirectoryTree({
      projectSlug: 'test',
      namespace: 'default',
      dataDir: dir,
      resolveStorageDir: () => storageDir,
    });

    expect(tree).toEqual(
      expect.objectContaining({
        type: 'directory',
        path: '.',
        fileCount: 2,
      }),
    );
    expect(tree.children?.map((child) => child.name)).toEqual([
      'docs',
      'root.md',
    ]);
    expect(tree.children?.[0]).toEqual(
      expect.objectContaining({
        type: 'directory',
        fileCount: 1,
      }),
    );
    expect(tree.children?.[0]?.children?.[0]).toEqual(
      expect.objectContaining({
        type: 'file',
        doc: expect.objectContaining({ id: 'doc-1' }),
      }),
    );
    expect(tree.children?.[0]?.children?.[0]).not.toHaveProperty('document');
  });

  test('directory tree refuses symlinked entries instead of returning partial authority', async () => {
    const storageDir = join(dir, 'default');
    mkdirSync(join(storageDir, 'files'), { recursive: true });
    symlinkSync(dir, join(storageDir, 'files', 'outside'));

    await expect(
      buildKnowledgeDirectoryTree({
        projectSlug: 'test',
        namespace: 'default',
        dataDir: dir,
        resolveStorageDir: () => storageDir,
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
  });

  test('legacy metadata participates in the authoritative transaction read set', async () => {
    const storageDir = join(dir, 'projects', 'test', 'knowledge', 'default');
    const legacyDir = join(dir, 'projects', 'test', 'documents');
    const legacyPath = join(legacyDir, 'metadata-default.json');
    mkdirSync(legacyDir, { recursive: true });
    const initial = [
      {
        id: 'legacy-1',
        filename: 'legacy.md',
        namespace: 'default',
        path: 'legacy.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    writeFileSync(legacyPath, JSON.stringify(initial));

    await expect(
      mutateKnowledgeDocuments(
        {
          storageDir,
          dataDir: dir,
          projectSlug: 'test',
          namespace: 'default',
          operation: 'legacy-race',
        },
        (transaction) => {
          const observed = transaction.metadata();
          writeFileSync(
            legacyPath,
            JSON.stringify([{ ...initial[0], filename: 'changed.md' }]),
          );
          transaction.replaceMetadata(observed);
        },
      ),
    ).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
  });

  test('malformed authoritative metadata fails closed instead of becoming an empty list', async () => {
    const storageDir = join(dir, 'default');
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, 'metadata.json'), '{}');

    await expect(
      listKnowledgeDocuments({
        projectSlug: 'test',
        namespace: 'default',
        dataDir: dir,
        listNamespaces: () => [],
        resolveStorageDir: () => storageDir,
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
  });

  test.each([
    [
      'duplicate ids',
      [
        { id: 'doc-1', path: 'a.md' },
        { id: 'doc-1', path: 'b.md' },
      ],
    ],
    [
      'duplicate paths',
      [
        { id: 'doc-1', path: 'a.md' },
        { id: 'doc-2', path: 'a.md' },
      ],
    ],
    ['namespace mismatch', [{ id: 'doc-1', path: 'a.md', namespace: 'other' }]],
    ['path traversal', [{ id: 'doc-1', path: '../outside.md' }]],
    ['absolute path', [{ id: 'doc-1', path: '/outside.md' }]],
  ])('rejects relational metadata corruption: %s', async (_label, entries) => {
    const storageDir = join(dir, 'default');
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(
      join(storageDir, 'metadata.json'),
      JSON.stringify(
        entries.map((entry) => ({
          filename: entry.path,
          namespace: 'default',
          source: 'upload',
          chunkCount: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          ...entry,
        })),
      ),
    );

    await expect(
      listKnowledgeDocuments({
        projectSlug: 'test',
        namespace: 'default',
        dataDir: dir,
        listNamespaces: () => [],
        resolveStorageDir: () => storageDir,
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
  });

  test('scanKnowledgeDirectories respects include and exclude patterns', async () => {
    const workingDirectory = join(dir, 'workspace');
    mkdirSync(join(workingDirectory, 'src'), { recursive: true });
    mkdirSync(join(workingDirectory, 'docs'), { recursive: true });
    writeFileSync(
      join(workingDirectory, 'src', 'keep.ts'),
      'export const keep = true;\n',
    );
    writeFileSync(
      join(workingDirectory, 'src', 'skip.ts'),
      'export const skip = true;\n',
    );
    writeFileSync(join(workingDirectory, 'docs', 'guide.md'), '# guide\n');

    const uploadDocument = vi.fn(async () => ({}));
    const result = await scanKnowledgeDirectories({
      projectSlug: 'test',
      namespace: 'code',
      extensions: ['ts', '.md'],
      includePatterns: ['src/**'],
      excludePatterns: ['**/skip.ts'],
      storageAdapter: {
        getProject: () => ({
          slug: 'test',
          name: 'Test',
          workingDirectory,
        }),
      } as any,
      getNamespaceConfig: () => undefined,
      uploadDocument,
    });

    expect(result).toEqual({ indexed: 1, skipped: 0 });
    expect(uploadDocument).toHaveBeenCalledWith(
      'test',
      'src/keep.ts',
      'export const keep = true;\n',
      'directory-scan',
      'code',
    );
  });

  /** Scans `workingDirectory` for `.md` files and records what it uploads. */
  async function scanWorkspace(
    workingDirectory: string,
    includePatterns?: string[],
  ) {
    const uploaded: string[] = [];
    const result = await scanKnowledgeDirectories({
      projectSlug: 'test',
      namespace: 'code',
      extensions: ['md'],
      includePatterns,
      storageAdapter: {
        getProject: () => ({
          slug: 'test',
          name: 'Test',
          workingDirectory,
        }),
      } as any,
      getNamespaceConfig: () => undefined,
      uploadDocument: async (_projectSlug, filename) => {
        uploaded.push(filename);
        return {};
      },
    });
    return { result, uploaded: uploaded.sort() };
  }

  test('scanKnowledgeDirectories applies the file cap after the include patterns, not before', async () => {
    const workingDirectory = join(dir, 'workspace');
    mkdirSync(workingDirectory, { recursive: true });
    // 300 extension matches, more than the scan's cap of 200, of which every
    // other one is included. Interleaved by name so that no directory order
    // lists all the included files first.
    const included: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const name = `${String(index).padStart(3, '0')}-${
        index % 2 === 0 ? 'keep' : 'drop'
      }.md`;
      writeFileSync(join(workingDirectory, name), '# note\n');
      if (index % 2 === 0) included.push(name);
    }

    const { result, uploaded } = await scanWorkspace(workingDirectory, [
      '*-keep.md',
    ]);

    expect(result).toEqual({ indexed: 150, skipped: 0 });
    expect(uploaded).toEqual(included);
  });

  test('scanKnowledgeDirectories does not index through symbolic links', async () => {
    const workingDirectory = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'secret.md'), '# outside file\n');
    writeFileSync(join(outside, 'nested', 'deep.md'), '# outside tree\n');
    writeFileSync(join(workingDirectory, 'inside.md'), '# inside\n');
    symlinkSync(
      join(outside, 'secret.md'),
      join(workingDirectory, 'linked-file.md'),
    );
    symlinkSync(outside, join(workingDirectory, 'linked-directory'));

    const { result, uploaded } = await scanWorkspace(workingDirectory);

    expect(result).toEqual({ indexed: 1, skipped: 0 });
    expect(uploaded).toEqual(['inside.md']);
  });
});
