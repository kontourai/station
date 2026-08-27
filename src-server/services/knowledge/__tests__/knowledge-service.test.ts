import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  knowledgeOps: { add: vi.fn() },
}));
vi.mock('@kontourai/station-contracts/knowledge', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@kontourai/station-contracts/knowledge')
    >();
  return {
    ...actual,
    BUILTIN_KNOWLEDGE_NAMESPACES: [
      { id: 'default', label: 'Default', behavior: 'rag' },
      { id: 'rules', label: 'Rules & Steering', behavior: 'inject' },
    ],
  };
});

const { KnowledgeService } = await import('../knowledge-service.js');
const { knowledgeOps } = await import('../../../telemetry/metrics.js');

function createMockStorageAdapter() {
  const projects = new Map<string, any>([
    ['test', { slug: 'test', name: 'Test', knowledgeNamespaces: [] }],
  ]);
  const replaceProject = vi.fn(async (project: any) => {
    projects.set(project.slug, project);
  });
  const setProject = (project: any) => projects.set(project.slug, project);
  return {
    getProject: vi.fn((slug: string) => {
      const p = projects.get(slug);
      if (!p) throw new Error('Not found');
      return { ...p };
    }),
    projectRevision: vi.fn((slug: string) => {
      const project = projects.get(slug);
      if (!project) throw new Error('Not found');
      return {
        value: { ...project },
        replace: replaceProject,
        remove: vi.fn(),
      };
    }),
    replaceProject,
    setProject,
  };
}

function createMockVectorDb() {
  const namespaces = new Map<string, any[]>();
  return {
    namespaceExists: vi.fn(async (ns: string) => namespaces.has(ns)),
    createNamespace: vi.fn(async (ns: string) => namespaces.set(ns, [])),
    addDocuments: vi.fn(async (ns: string, docs: any[]) => {
      const existing = namespaces.get(ns) ?? [];
      namespaces.set(ns, [...existing, ...docs]);
    }),
    deleteDocuments: vi.fn(async (ns: string, ids: string[]) => {
      const existing = namespaces.get(ns) ?? [];
      namespaces.set(
        ns,
        existing.filter((d) => !ids.includes(d.id)),
      );
    }),
    search: vi.fn(async () => []),
    getByMetadata: vi.fn(async () => []),
  };
}

function createMockEmbedding() {
  return {
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => new Array(1024).fill(0)),
    ),
  };
}

describe('KnowledgeService — namespace management', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('listNamespaces returns builtins without storage adapter', () => {
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
    );
    const ns = svc.listNamespaces('test');
    expect(ns.some((n) => n.id === 'default')).toBe(true);
    expect(ns.some((n) => n.id === 'rules')).toBe(true);
  });

  test('listNamespaces merges builtins with project namespaces', () => {
    const adapter = createMockStorageAdapter();
    adapter.setProject({
      slug: 'test',
      knowledgeNamespaces: [{ id: 'code', label: 'Code', behavior: 'rag' }],
    });
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    const ns = svc.listNamespaces('test');
    expect(ns.find((n) => n.id === 'default')).toBeDefined();
    expect(ns.find((n) => n.id === 'code')).toBeDefined();
  });

  test('registerNamespace adds to project', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await svc.registerNamespace('test', {
      id: 'docs',
      label: 'Docs',
      behavior: 'inject',
    } as any);
    expect(adapter.replaceProject).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeNamespaces: expect.arrayContaining([
          expect.objectContaining({ id: 'docs' }),
        ]),
      }),
    );
  });

  test('registerNamespace is idempotent', async () => {
    const adapter = createMockStorageAdapter();
    adapter.setProject({
      slug: 'test',
      knowledgeNamespaces: [{ id: 'docs', label: 'Docs', behavior: 'rag' }],
    });
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await svc.registerNamespace('test', {
      id: 'docs',
      label: 'Docs',
      behavior: 'rag',
    } as any);
    expect(adapter.replaceProject).not.toHaveBeenCalled();
  });

  test('removeNamespace removes custom namespace', async () => {
    const adapter = createMockStorageAdapter();
    adapter.setProject({
      slug: 'test',
      knowledgeNamespaces: [{ id: 'custom', label: 'Custom', behavior: 'rag' }],
    });
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await svc.removeNamespace('test', 'custom');
    expect(adapter.replaceProject).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeNamespaces: [],
      }),
    );
  });

  test('removeNamespace throws for builtin', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await expect(svc.removeNamespace('test', 'default')).rejects.toThrow(
      'built-in',
    );
  });

  test('updateNamespace modifies existing', async () => {
    const adapter = createMockStorageAdapter();
    adapter.setProject({
      slug: 'test',
      knowledgeNamespaces: [{ id: 'code', label: 'Code', behavior: 'rag' }],
    });
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await svc.updateNamespace('test', 'code', { label: 'Source Code' });
    expect(adapter.replaceProject).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeNamespaces: [
          expect.objectContaining({ id: 'code', label: 'Source Code' }),
        ],
      }),
    );
  });

  test('updateNamespace throws for unknown non-builtin', async () => {
    const adapter = createMockStorageAdapter();
    adapter.setProject({
      slug: 'test',
      knowledgeNamespaces: [],
    });
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
      adapter as any,
    );
    await expect(
      svc.updateNamespace('test', 'nonexistent', { label: 'X' }),
    ).rejects.toThrow('not found');
  });

  test('throws without storage adapter for write operations', async () => {
    const svc = new KnowledgeService(
      () => null,
      () => null,
      dir,
    );
    await expect(svc.registerNamespace('test', {} as any)).rejects.toThrow(
      'Storage adapter required',
    );
    await expect(svc.removeNamespace('test', 'x')).rejects.toThrow(
      'Storage adapter required',
    );
  });
});

describe('KnowledgeService — file-first document operations', () => {
  let dir: string;
  let vectorDb: ReturnType<typeof createMockVectorDb>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-test-'));
    vectorDb = createMockVectorDb();
    embedding = createMockEmbedding();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('uploadDocument writes file to disk first', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const meta = await svc.uploadDocument(
      'test',
      'test.md',
      '# Hello\n\nWorld',
    );
    expect(meta.path).toBe('test.md');
    expect(meta.id).toBeDefined();

    // File should exist on disk
    const filePath = join(
      dir,
      'projects',
      'test',
      'knowledge',
      'default',
      'files',
      'test.md',
    );
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Hello\n\nWorld');
  });

  test('derived vector publication observes committed file and metadata authority', async () => {
    const storageDir = join(dir, 'projects', 'test', 'knowledge', 'default');
    vectorDb.addDocuments.mockImplementationOnce(async (_namespace, docs) => {
      expect(
        readFileSync(join(storageDir, 'files', 'ordered.md'), 'utf8'),
      ).toBe('# Authoritative');
      const metadata = JSON.parse(
        readFileSync(join(storageDir, 'metadata.json'), 'utf8'),
      );
      expect(metadata).toEqual([
        expect.objectContaining({
          id: docs[0].metadata.docId,
          contentHash: docs[0].metadata.contentHash,
        }),
      ]);
    });
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );

    await svc.uploadDocument('test', 'ordered.md', '# Authoritative');
    expect(vectorDb.addDocuments).toHaveBeenCalledTimes(1);
  });

  test('uploadDocument returns its committed result when metric observation fails', async () => {
    vi.mocked(knowledgeOps.add).mockImplementationOnce(() => {
      throw new Error('observer unavailable');
    });
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );

    await expect(
      svc.uploadDocument('test', 'observed.md', '# Committed'),
    ).resolves.toEqual(expect.objectContaining({ filename: 'observed.md' }));
  });

  test('uploadDocument parses frontmatter into metadata', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const content = '---\ntitle: Test\ntags: [a, b]\n---\n# Body';
    const meta = await svc.uploadDocument('test', 'note.md', content);
    expect(meta.metadata?.title).toBe('Test');
    expect(meta.metadata?.tags).toEqual(['a', 'b']);
  });

  test('uploadDocument chunks body only, not frontmatter', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const content = '---\ntitle: Secret\n---\n# Body content';
    await svc.uploadDocument('test', 'note.md', content);
    // Embedding should be called with body only
    const embeddedTexts = embedding.embed.mock.calls[0][0];
    expect(embeddedTexts.every((t: string) => !t.includes('Secret'))).toBe(
      true,
    );
    expect(embeddedTexts.some((t: string) => t.includes('Body content'))).toBe(
      true,
    );
  });

  test('getDocumentContent reads from disk', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const meta = await svc.uploadDocument('test', 'test.md', '# Hello');
    const content = await svc.getDocumentContent('test', meta.id, 'default');
    expect(content).toBe('# Hello');
  });

  test('legacy metadata without a content hash cannot authorize vector reconstruction', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const meta = await svc.uploadDocument('test', 'legacy.md', '# Authority');
    const storageDir = join(dir, 'projects', 'test', 'knowledge', 'default');
    const metadataPath = join(storageDir, 'metadata.json');
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete persisted[0].contentHash;
    writeFileSync(metadataPath, JSON.stringify(persisted));
    rmSync(join(storageDir, 'files', 'legacy.md'));

    await expect(
      svc.getDocumentContent('test', meta.id, 'default'),
    ).rejects.toThrow(/until its derived index is rebuilt/);
  });

  test('deleteDocument removes file from disk', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const meta = await svc.uploadDocument('test', 'test.md', '# Hello');
    const filePath = join(
      dir,
      'projects',
      'test',
      'knowledge',
      'default',
      'files',
      'test.md',
    );
    expect(existsSync(filePath)).toBe(true);

    await svc.deleteDocument('test', meta.id, 'default');
    expect(existsSync(filePath)).toBe(false);

    const docs = await svc.listDocuments('test', 'default');
    expect(docs).toHaveLength(0);
  });

  test('updateDocument preserves ID and re-indexes', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const meta = await svc.uploadDocument('test', 'test.md', '# Hello');
    const updated = await svc.updateDocument(
      'test',
      meta.id,
      { content: '# Updated', metadata: { status: 'enhanced' } },
      'default',
    );
    expect(updated.id).toBe(meta.id);
    expect(updated.updatedAt).toBeDefined();
    expect(updated.metadata?.status).toBe('enhanced');

    // File on disk should be updated with frontmatter
    const filePath = join(
      dir,
      'projects',
      'test',
      'knowledge',
      'default',
      'files',
      'test.md',
    );
    const fileContent = readFileSync(filePath, 'utf-8');
    expect(fileContent).toContain('status: enhanced');
    expect(fileContent).toContain('# Updated');
  });

  test('upload provider failure leaves committed authority available for derived repair', async () => {
    vectorDb.addDocuments.mockRejectedValueOnce(
      new Error('vector unavailable'),
    );
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );

    const uploaded = await svc.uploadDocument(
      'test',
      'failed.md',
      '# Committed authority',
    );
    const storageDir = join(dir, 'projects', 'test', 'knowledge', 'default');
    expect(readFileSync(join(storageDir, 'files', 'failed.md'), 'utf8')).toBe(
      '# Committed authority',
    );
    expect(await svc.listDocuments('test', 'default')).toEqual([
      expect.objectContaining({
        id: uploaded.id,
        contentHash: expect.any(String),
      }),
    ]);
  });

  test('update provider failure cannot roll back committed authoritative content', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const original = await svc.uploadDocument('test', 'stable.md', '# Stable');
    const storageDir = join(dir, 'projects', 'test', 'knowledge', 'default');
    vectorDb.deleteDocuments.mockRejectedValueOnce(
      new Error('vector unavailable'),
    );

    const updated = await svc.updateDocument(
      'test',
      original.id,
      { content: '# Authoritative update' },
      'default',
    );
    expect(readFileSync(join(storageDir, 'files', 'stable.md'), 'utf8')).toBe(
      '# Authoritative update',
    );
    expect(updated.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('delete provider failure cannot restore deleted authoritative content', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const original = await svc.uploadDocument('test', 'stable.md', '# Stable');
    vectorDb.deleteDocuments.mockRejectedValueOnce(
      new Error('vector unavailable'),
    );

    await svc.deleteDocument('test', original.id, 'default');
    await expect(
      svc.getDocumentContent('test', original.id, 'default'),
    ).rejects.toThrow(`Document '${original.id}' not found`);
    expect(await svc.listDocuments('test', 'default')).toEqual([]);
  });

  test('serializes a concurrent update and delete without restoring stale document state', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const original = await svc.uploadDocument('test', 'race.md', '# Original');
    let releaseUpdate!: () => void;
    const updateMayFinish = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateReachedProvider!: () => void;
    const updateAtProvider = new Promise<void>((resolve) => {
      updateReachedProvider = resolve;
    });
    vectorDb.deleteDocuments.mockImplementationOnce(async () => {
      updateReachedProvider();
      await updateMayFinish;
    });

    const update = svc.updateDocument(
      'test',
      original.id,
      { content: '# Updated' },
      'default',
    );
    await updateAtProvider;
    const deletion = svc.deleteDocument('test', original.id, 'default');
    releaseUpdate();

    await update;
    await deletion;
    expect(await svc.listDocuments('test', 'default')).toEqual([]);
    expect(
      existsSync(
        join(
          dir,
          'projects',
          'test',
          'knowledge',
          'default',
          'files',
          'race.md',
        ),
      ),
    ).toBe(false);
  });

  test('listDocuments with filter', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    await svc.uploadDocument('test', 'a.md', '---\ntags: [planning]\n---\n# A');
    await svc.uploadDocument('test', 'b.md', '---\ntags: [research]\n---\n# B');

    const all = await svc.listDocuments('test', 'default');
    expect(all).toHaveLength(2);

    const filtered = await svc.listDocuments('test', 'default', {
      tags: ['planning'],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filename).toBe('a.md');
  });

  test('getDirectoryTree returns hierarchy', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    await svc.uploadDocument('test', 'test.md', '# Hello');
    const tree = await svc.getDirectoryTree('test', 'default');
    expect(tree.type).toBe('directory');
    expect(tree.fileCount).toBe(1);
    expect(tree.children?.some((c) => c.name === 'test.md')).toBe(true);
  });

  test('uploaded documents appear in listDocuments without explicit namespace', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    await svc.uploadDocument('test', 'readme.md', '# Hello World');
    const allDocs = await svc.listDocuments('test');
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].filename).toBe('readme.md');
    expect(allDocs[0].namespace).toBe('default');
  });

  test('uploading a .md file stores and retrieves content correctly', async () => {
    const svc = new KnowledgeService(
      () => vectorDb as any,
      () => embedding as any,
      dir,
    );
    const content =
      '# My Notes\n\n- item 1\n- item 2\n\n## Section\n\nSome text here.';
    const meta = await svc.uploadDocument('test', 'notes.md', content);
    expect(meta.chunkCount).toBeGreaterThan(0);

    const retrieved = await svc.getDocumentContent('test', meta.id, 'default');
    expect(retrieved).toBe(content);

    const docs = await svc.listDocuments('test', 'default');
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(meta.id);
  });
});
