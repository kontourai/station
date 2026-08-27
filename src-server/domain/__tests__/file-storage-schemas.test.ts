import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';

function project(): ProjectConfig {
  return {
    id: 'project-1',
    slug: 'acme',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function layout(): LayoutConfig {
  return {
    id: 'layout-1',
    projectSlug: 'acme',
    slug: 'coding',
    type: 'coding',
    name: 'Coding',
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('FileStorageAdapter persisted schemas', () => {
  let home: string;
  let adapter: FileStorageAdapter;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'station-file-schema-'));
    adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('rejects a Layout whose path identity or unknown fields disagree', async () => {
    await adapter.createLayout('acme', layout());
    const path = join(home, 'projects', 'acme', 'layouts', 'coding.json');
    writeFileSync(
      path,
      JSON.stringify({ ...layout(), projectSlug: 'other' }),
      'utf8',
    );
    expect(() => adapter.getLayout('acme', 'coding')).toThrow(
      'identity does not match',
    );

    writeFileSync(
      path,
      JSON.stringify({ ...layout(), surprise: true }),
      'utf8',
    );
    expect(() => adapter.listLayouts('acme')).toThrow(
      'Project storage contains an invalid record',
    );
  });

  test('does not omit a Project whose record is an unreadable shape', () => {
    const path = join(home, 'projects', 'acme', 'project.json');
    rmSync(path);
    mkdirSync(path);

    expect(() => adapter.listProjects()).toThrow(
      'Project storage is unavailable',
    );
  });

  test('normalizes the one known legacy Layout omission without accepting extras', async () => {
    await adapter.createLayout('acme', layout());
    const path = join(home, 'projects', 'acme', 'layouts', 'coding.json');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    delete persisted.config;
    writeFileSync(path, JSON.stringify(persisted), 'utf8');
    expect(adapter.getLayout('acme', 'coding').config).toEqual({});
  });

  test('rejects unknown conversation and document fields on read and write', async () => {
    const conversation = {
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Conversation',
      agentSlug: 'station',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await adapter.saveConversation(conversation);
    await expect(
      adapter.saveConversation({ ...conversation, surprise: true } as any),
    ).rejects.toThrow('surprise');
    const conversations = join(home, 'projects', 'acme', 'conversations.json');
    writeFileSync(
      conversations,
      JSON.stringify([{ ...conversation, surprise: true }]),
    );
    expect(() => adapter.listConversations('acme')).toThrow('surprise');

    const document = {
      id: 'document-1',
      projectId: 'project-1',
      filename: 'readme.md',
      mimeType: 'text/markdown',
      size: 12,
      source: 'upload' as const,
      chunkCount: 1,
      status: 'embedded' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await adapter.saveDocument(document);
    const documents = join(
      home,
      'projects',
      'acme',
      'documents',
      'metadata.json',
    );
    writeFileSync(documents, JSON.stringify([{ ...document, surprise: true }]));
    expect(() => adapter.listDocuments('acme')).toThrow('surprise');
  });

  test('rejects unknown template and knowledge-root fields before mutation', async () => {
    await expect(
      adapter.saveTemplate({
        id: 'template-1',
        name: 'Template',
        type: 'coding',
        config: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        surprise: true,
      } as any),
    ).rejects.toThrow('surprise');

    await expect(
      adapter.saveKnowledgeStoreRoot({
        id: 'root-1',
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'default',
        storeRoot: join(home, 'knowledge'),
        displayName: 'Knowledge',
        createdAt: '2026-01-01T00:00:00.000Z',
        surprise: true,
      } as any),
    ).rejects.toThrow('surprise');
  });
});
