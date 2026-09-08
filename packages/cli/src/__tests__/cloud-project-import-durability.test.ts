/**
 * The project-import REQUEST record's abort-before-network guarantee.
 *
 * `cloud-project-import.ts` writes that record with "Durable intent precedes
 * the network mutation": it exists so a crash or a lost reply leaves
 * something to reconcile AGAINST. The shared writer swallows a post-rename
 * directory-fsync failure -- correct for a caller that only needs the value
 * published, wrong here, because a record that may not survive the crash is
 * not intent that precedes anything. So the command fsyncs the directory
 * itself, unswallowed, and this proves the abort happens BEFORE the remote
 * mutation rather than after it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspacePackageKey,
  packWorkspace,
} from '@kontourai/station-shared/workspace-package';
import { afterEach, expect, test, vi } from 'vitest';

// The helper is faked process-wide (the export map points at the same source
// file the seam imports relatively, so one module id covers both), but it
// throws only for the directories in this set and delegates to the real
// helper otherwise. Two calls target `destination`: the seam's own, which
// throws and is SWALLOWED -- that is what leaves the caller-side call as the
// only observable -- and the caller's, which throws and propagates. Workspace
// extraction fsyncs only `destination/workspace` and below, so it never
// reaches the set and the injection cannot fire before the record is
// written.
const failingDirectories = vi.hoisted(() => new Set<string>());
vi.mock('@kontourai/station-shared/fs-windows-compat', async (original) => {
  const actual =
    await original<
      typeof import('@kontourai/station-shared/fs-windows-compat')
    >();
  return {
    ...actual,
    fsyncDirectorySync: (path: string, checkIdentity?: unknown) => {
      if (failingDirectories.has(path)) {
        throw Object.assign(new Error('EIO: i/o error, fsync'), {
          code: 'EIO',
        });
      }
      return actual.fsyncDirectorySync(
        path,
        checkIdentity as Parameters<typeof actual.fsyncDirectorySync>[1],
      );
    },
  };
});

import { runCloudCommand } from '../commands/cloud.js';

const roots: string[] = [];
afterEach(() => {
  failingDirectories.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-project-import-durable-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  const git = (args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.fsmonitor=false',
        '-C',
        source,
        ...args,
      ],
      { windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  git(['init', '--template=', '--initial-branch=main']);
  writeFileSync(join(source, 'file.txt'), 'original\n');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Initial',
  ]);
  writeFileSync(join(source, 'file.txt'), 'working\n');
  const keyFile = join(root, 'key');
  createWorkspacePackageKey(keyFile);
  const archive = join(root, 'archive');
  packWorkspace({
    workspace: source,
    keyFile,
    output: archive,
    sourcePaused: true,
  });
  const destination = join(root, 'imported');
  const targetPath = '/workspace/acme/workspace';
  const args = [
    'import-project',
    `--archive=${archive}`,
    `--key-file=${keyFile}`,
    `--destination=${destination}`,
    `--target-workspace=${targetPath}`,
    '--name=Acme',
    '--slug=acme',
    '--api-base=http://127.0.0.1:29876',
  ];
  vi.stubEnv('STATION_API_CREDENTIAL', 'synthetic-project-import-credential');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  return { root, destination, args, fetch };
}

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('a directory fsync failure on the request record aborts BEFORE the remote mutation', {
  timeout: 30000,
}, async () => {
  const f = fixture();
  // The pre-check that the slug is free is the only call that may happen.
  // A second call would be `createProject` -- the mutation this record is
  // supposed to precede.
  f.fetch.mockResolvedValueOnce(reply(null, 404)).mockImplementation(() => {
    throw new Error('createProject must not be reached');
  });
  failingDirectories.add(f.destination);

  await expect(runCloudCommand(f.args)).rejects.toThrow(/fsync/);

  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(
    f.fetch.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET'),
    'the only request made must be the read-only pre-check',
  ).toBe(true);
});
