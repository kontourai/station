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
import { afterEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import { runStartupMigrations } from '../migration.js';

describe('runStartupMigrations', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('renames the built-in vectordb connection to Station Built-In', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-test-'));
    const storageAdapter = new FileStorageAdapter(tempDir);
    await storageAdapter.saveProviderConnection({
      id: 'lancedb-builtin',
      type: 'lancedb',
      name: 'LanceDB (built-in)',
      config: { dataDir: join(tempDir, 'vectordb') },
      enabled: true,
      capabilities: ['vectordb'],
    });

    await runStartupMigrations(tempDir);

    const providers = storageAdapter.listProviderConnections();
    expect(
      providers.find((connection) => connection.id === 'lancedb-builtin'),
    ).toEqual(
      expect.objectContaining({
        name: 'Station Built-In',
      }),
    );
  });

  test('a fresh home with no layouts and no projects boots with zero projects', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-fresh-test-'));

    await runStartupMigrations(tempDir);

    expect(existsSync(join(tempDir, 'projects'))).toBe(false);
  });

  test('a home with legacy layouts and no projects dir still migrates to Default', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-legacy-test-'));
    const legacyLayoutDir = join(tempDir, 'layouts', 'coding');
    mkdirSync(legacyLayoutDir, { recursive: true });
    writeFileSync(
      join(legacyLayoutDir, 'layout.json'),
      JSON.stringify({
        name: 'Coding',
        slug: 'coding',
        icon: 'code',
        description: 'Legacy coding layout',
        tabs: [{ id: 'workspace' }],
        defaultAgent: 'station',
        availableAgents: ['station'],
      }),
      'utf8',
    );

    await runStartupMigrations(tempDir);

    expect(
      existsSync(join(tempDir, 'projects', 'default', 'project.json')),
    ).toBe(true);
    expect(
      existsSync(
        join(tempDir, 'projects', 'default', 'layouts', 'coding.json'),
      ),
    ).toBe(true);
  });

  test('a home with an existing projects dir is never mutated, regardless of layouts content', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-existing-test-'));
    const customProjectDir = join(tempDir, 'projects', 'custom');
    mkdirSync(customProjectDir, { recursive: true });
    writeFileSync(
      join(customProjectDir, 'project.json'),
      JSON.stringify({
        id: 'custom-id',
        name: 'Custom',
        slug: 'custom',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const legacyLayoutDir = join(tempDir, 'layouts', 'coding');
    mkdirSync(legacyLayoutDir, { recursive: true });
    writeFileSync(
      join(legacyLayoutDir, 'layout.json'),
      JSON.stringify({
        name: 'Coding',
        slug: 'coding',
        icon: 'code',
        description: 'Legacy coding layout',
        tabs: [{ id: 'workspace' }],
        defaultAgent: 'station',
        availableAgents: ['station'],
      }),
      'utf8',
    );
    const projectsDir = join(tempDir, 'projects');
    const before = readdirSync(projectsDir, { recursive: true }).sort();

    await runStartupMigrations(tempDir);

    const after = readdirSync(projectsDir, { recursive: true }).sort();
    expect(after).toEqual(before);
    expect(existsSync(join(projectsDir, 'default'))).toBe(false);
  });

  test('a pre-placed project directory is discoverable via listProjects (provisioning contract)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'migration-preplaced-test-'));
    const customProjectDir = join(tempDir, 'projects', 'custom');
    mkdirSync(customProjectDir, { recursive: true });
    writeFileSync(
      join(customProjectDir, 'project.json'),
      JSON.stringify({
        id: 'custom-id',
        name: 'Custom',
        slug: 'custom',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    await runStartupMigrations(tempDir);

    const projects = new FileStorageAdapter(tempDir).listProjects();
    expect(projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: 'custom' })]),
    );
  });

  test('rejects a provider config larger than the persisted input budget', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'provider-config-test-'));
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'providers.json'),
      JSON.stringify([{ id: 'x'.repeat(2 * 1024 * 1024) }]),
      'utf8',
    );

    expect(() =>
      new FileStorageAdapter(tempDir).listProviderConnections(),
    ).toThrow('provider config exceeds the byte limit');
  });

  test('projects plugin identity and tab count into layout metadata', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-metadata-test-'));
    const layoutsDir = join(tempDir, 'projects', 'demo', 'layouts');
    mkdirSync(layoutsDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'projects', 'demo', 'project.json'),
      JSON.stringify({
        id: 'project-1',
        slug: 'demo',
        name: 'Demo',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    writeFileSync(
      join(layoutsDir, 'coding.json'),
      JSON.stringify({
        id: 'layout-1',
        projectSlug: 'demo',
        type: 'chat',
        name: 'Coding',
        slug: 'coding',
        config: {
          plugin: 'coding-starter',
          tabs: [{ id: 'workspace' }, { id: 'diff' }],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    expect(new FileStorageAdapter(tempDir).listLayouts('demo')).toEqual([
      expect.objectContaining({
        plugin: 'coding-starter',
        tabCount: 2,
      }),
    ]);
  });
});
