/**
 * #3391 delta review: the project list's run-location read must reach a
 * project's folder only through async `fs.promises`. A synchronous stat on a
 * mount that does not answer stops the whole server, so this runs the list
 * read with its DEFAULT folder reads (nothing injected) and watches the
 * synchronous `node:fs` calls for any that name the project's folder.
 */
import { randomUUID } from 'node:crypto';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    realpathSync: vi.fn(actual.realpathSync),
    statSync: vi.fn(actual.statSync),
  };
});

const { putProject } = await import(
  '../../../domain/__tests__/file-storage-test-helpers.js'
);
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { ProjectBindingsStore } = await import('../project-binding-store.js');
const { projectManifestPath } = await import('../project-manifest-store.js');
const { ProjectResourceResolver, resetRunLocationFolderChecksForTests } =
  await import('../project-resource-resolver.js');

const roots: string[] = [];
afterEach(() => {
  resetRunLocationFolderChecksForTests();
  for (const root of roots.splice(0))
    realFs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realFs.mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test('the list read never stats a project folder synchronously', async () => {
  const home = tempDir('station-run-location-default-home-');
  const folder = tempDir('station-run-location-default-folder-');
  realFs.mkdirSync(join(folder, 'packages', 'app'), { recursive: true });
  const adapter = new FileStorageAdapter(home);
  const now = new Date().toISOString();
  await putProject(adapter, {
    id: randomUUID(),
    slug: 'acme',
    name: 'Acme',
    workingDirectory: folder,
    createdAt: now,
    updatedAt: now,
  });
  // A selected execution root, so the read also resolves and stats it.
  realFs.writeFileSync(
    projectManifestPath(home, 'acme'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'prj_acme',
      repos: [{ kind: 'local-only', id: 'local:acme' }],
      executionRoot: { repoId: 'local:acme', path: 'packages/app' },
      createdAt: now,
      updatedAt: now,
    }),
  );
  const canonical = realFs.realpathSync.native(folder);
  vi.mocked(realFs.existsSync).mockClear();
  vi.mocked(realFs.realpathSync).mockClear();
  vi.mocked(realFs.statSync).mockClear();

  const locations = await new ProjectResourceResolver({
    homeDir: home,
    source: adapter,
    bindings: new ProjectBindingsStore(home),
    readRemotes: async () => {
      throw new Error('a list read must not read remotes');
    },
  }).describeProjectRunLocations(['acme']);

  // The read really went through the folder: it found the execution root.
  expect(locations.get('acme')).toEqual({
    kind: 'execution-root',
    path: join(canonical, 'packages', 'app'),
  });
  const touchesFolder = (call: unknown[]) =>
    typeof call[0] === 'string' &&
    (call[0].startsWith(folder) || call[0].startsWith(canonical));
  for (const sync of [
    realFs.existsSync,
    realFs.realpathSync,
    realFs.statSync,
  ] as const)
    expect(vi.mocked(sync).mock.calls.filter(touchesFolder)).toEqual([]);
});
