import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildKnowledgeInjectContext,
  buildKnowledgeRagContextDetailed,
} from '../knowledge-context.js';
import { saveKnowledgeMeta } from '../knowledge-storage.js';

describe('knowledge-context helpers', () => {
  test('buildKnowledgeRagContextDetailed formats only results above threshold, and its receipt names only those', () => {
    const result = buildKnowledgeRagContextDetailed(
      [
        {
          score: 0.81,
          text: 'Useful chunk',
          metadata: { filename: 'guide.md' },
        },
        {
          score: 0.55,
          text: 'Second useful chunk',
          metadata: { filename: 'guide.md' },
        },
        {
          score: 0.12,
          text: 'Low value chunk',
          metadata: { filename: 'ignored.md' },
        },
      ],
      0.25,
    );

    expect(result?.context).toContain('<project_knowledge>');
    expect(result?.context).toContain('Useful chunk');
    expect(result?.context).not.toContain('Low value chunk');
    expect(result?.context).toContain('guide.md');
    // archive#2649: the receipt describes the SAME `relevant` array that
    // built the string — the dropped chunk is named nowhere, and a repeated
    // filename is one distinct source across two chunks.
    expect(result?.chunkCount).toBe(2);
    expect(result?.sources).toEqual(['guide.md']);
  });

  test('buildKnowledgeInjectContext reconstructs document text grouped by namespace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-context-'));
    await saveKnowledgeMeta(join(dir, 'rules'), [
      {
        id: 'doc-1',
        filename: 'rules.md',
        namespace: 'rules',
        path: 'rules.md',
        source: 'upload',
        chunkCount: 2,
        contentHash: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      },
    ]);

    const context = await buildKnowledgeInjectContext({
      projectSlug: 'test',
      namespaces: [{ id: 'rules', label: 'Rules', behavior: 'inject' }],
      dataDir: dir,
      resolveStorageDir: () => join(dir, 'rules'),
      vectorDb: {
        namespaceExists: async () => true,
        search: async () => [
          {
            text: 'Second chunk',
            metadata: {
              docId: 'doc-1',
              contentHash: 'a'.repeat(64),
              chunkIndex: 1,
              filename: 'rules.md',
            },
          },
          {
            text: 'First chunk',
            metadata: {
              docId: 'doc-1',
              contentHash: 'a'.repeat(64),
              chunkIndex: 0,
              filename: 'rules.md',
            },
          },
        ],
      },
      embeddingProvider: {
        embed: async () => [[0, 0, 0]],
      },
    });

    expect(context).toContain('<project_rules>');
    expect(context).toContain('<rules_rules>');
    expect(context).toContain('First chunk\n\nSecond chunk');

    rmSync(dir, { recursive: true, force: true });
  });

  test('excludes vector text that does not match authoritative content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-context-authority-'));
    await saveKnowledgeMeta(join(dir, 'rules'), [
      {
        id: 'doc-1',
        filename: 'rules.md',
        namespace: 'rules',
        path: 'rules.md',
        source: 'upload',
        chunkCount: 1,
        contentHash: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      },
    ]);

    const context = await buildKnowledgeInjectContext({
      projectSlug: 'test',
      namespaces: [{ id: 'rules', label: 'Rules', behavior: 'inject' }],
      dataDir: dir,
      resolveStorageDir: () => join(dir, 'rules'),
      vectorDb: {
        namespaceExists: async () => true,
        search: async () => [
          {
            text: 'Uncommitted vector text',
            metadata: {
              docId: 'doc-1',
              contentHash: 'b'.repeat(64),
              chunkIndex: 0,
              filename: 'rules.md',
            },
          },
        ],
      },
      embeddingProvider: { embed: async () => [[0, 0, 0]] },
    });

    expect(context).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('legacy authority without a content hash cannot inject vector text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-context-legacy-'));
    await saveKnowledgeMeta(join(dir, 'rules'), [
      {
        id: 'legacy',
        filename: 'legacy.md',
        namespace: 'rules',
        path: 'legacy.md',
        source: 'upload',
        chunkCount: 1,
        createdAt: new Date().toISOString(),
      },
    ]);

    const context = await buildKnowledgeInjectContext({
      projectSlug: 'test',
      namespaces: [{ id: 'rules', label: 'Rules', behavior: 'inject' }],
      dataDir: dir,
      resolveStorageDir: () => join(dir, 'rules'),
      vectorDb: {
        namespaceExists: async () => true,
        search: async () => [
          {
            text: 'Stale legacy vector',
            metadata: {
              docId: 'legacy',
              chunkIndex: 0,
              filename: 'legacy.md',
            },
          },
        ],
      },
      embeddingProvider: { embed: async () => [[0, 0, 0]] },
    });

    expect(context).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
