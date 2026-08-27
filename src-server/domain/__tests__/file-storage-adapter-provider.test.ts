import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import {
  FileStorageAlreadyExistsError,
  FileStorageConflictError,
} from '../project-file-transactions.js';

const project = (slug = 'proj') => ({
  id: `project-${slug}`,
  slug,
  name: 'Proj',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const layout = (overrides: Record<string, unknown> = {}) => ({
  id: 'layout-1',
  projectSlug: 'proj',
  slug: 'kit-knowledge-1',
  type: 'knowledge',
  name: 'Knowledge',
  config: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('FileStorageAdapter provider updates', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'station-provider-file-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('serializes concurrent provider updates without losing either edit', async () => {
    const first = new FileStorageAdapter(directory);
    const second = new FileStorageAdapter(directory);
    await first.saveProviderConnection({
      id: 'initial',
      type: 'ollama',
    } as any);
    const path = join(directory, 'config', 'providers.json');

    await Promise.all([
      first.saveProviderConnection({ id: 'station', type: 'ollama' } as any),
      second.saveProviderConnection({ id: 'external', type: 'bedrock' } as any),
    ]);
    expect(
      JSON.parse(readFileSync(path, 'utf8')).map((row: any) => row.id),
    ).toEqual(expect.arrayContaining(['initial', 'station', 'external']));
  });

  test('creates a layout once with a safe slug and never overwrites a concurrent creator', async () => {
    const adapter = new FileStorageAdapter(directory);
    await adapter.createProject(project());
    const initial = layout();

    await adapter.createLayout('proj', initial);
    await expect(
      adapter.createLayout('proj', { ...initial, name: 'Replacement' }),
    ).rejects.toThrow("Layout 'kit-knowledge-1' already exists");
    expect(adapter.getLayout('proj', initial.slug).name).toBe('Knowledge');
    await expect(adapter.createLayout('../outside', initial)).rejects.toThrow(
      'Invalid project slug',
    );
    await expect(
      adapter.createLayout('proj', { ...initial, slug: '../outside' }),
    ).rejects.toThrow('Invalid layout slug');
  });

  test('rejects unsafe layout paths for every direct storage operation', async () => {
    const adapter = new FileStorageAdapter(directory);
    await adapter.createProject(project());
    const initial = layout({ slug: 'safe-layout', name: 'Safe' });
    await adapter.createLayout('proj', initial);
    expect(() => adapter.listLayouts('../outside')).toThrow(
      'Invalid project slug',
    );

    for (const unsafe of [
      '..',
      '.',
      '../secret',
      '%2e%2e',
      '%252e%252e',
      'a/b',
      'a\\b',
      'x\u0000y',
    ]) {
      expect(() => adapter.getLayout('proj', unsafe)).toThrow(
        'Invalid layout slug',
      );
      await expect(
        adapter
          .layoutRevision('proj', 'safe-layout')
          .replace({ ...initial, slug: unsafe } as any),
      ).rejects.toThrow('Invalid layout slug');
      await expect(adapter.deleteLayout('proj', unsafe)).rejects.toThrow(
        'Invalid layout slug',
      );
    }
    expect(adapter.getLayout('proj', 'safe-layout').name).toBe('Safe');
  });

  test('findLayoutsUsingAgent matches exact clean IDs only', async () => {
    const adapter = new FileStorageAdapter(directory) as any;
    await adapter.createProject(project());
    await adapter.createLayout('proj', {
      ...layout({
        id: 'layout-coding',
        slug: 'coding',
        type: 'coding',
        name: 'Coding',
      }),
      config: { defaultAgent: 'claude' },
    });
    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([
      { projectSlug: 'proj', layoutSlug: 'coding' },
    ]);

    expect(adapter.findLayoutsUsingAgent('codex')).toEqual([]);
  });
});

/**
 * 4-HOME-007: creating a project whose slug is taken is a NAME collision, not
 * a lost CAS race, and only a distinct type lets the route answer the two
 * differently. It stays a `FileStorageConflictError` so every existing
 * `instanceof` branch (and the 409 status map) is unchanged.
 */
describe('FileStorageAdapter project creation collisions', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'station-project-create-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('a taken project slug throws the already-exists type carrying that slug', async () => {
    const adapter = new FileStorageAdapter(directory);
    await adapter.createProject(project('audit-alpha') as any);

    const failure = await adapter
      .createProject(project('audit-alpha') as any)
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(FileStorageAlreadyExistsError);
    expect(failure).toBeInstanceOf(FileStorageConflictError);
    expect(
      (failure as InstanceType<typeof FileStorageAlreadyExistsError>).takenSlug,
    ).toBe('audit-alpha');
  });
});
