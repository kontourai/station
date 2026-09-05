import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspacePackageKey,
  packWorkspace,
} from '@kontourai/station-shared/workspace-package';
import { afterEach, expect, test, vi } from 'vitest';
import { runCloudCommand } from '../commands/cloud.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-project-import-'));
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
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  return { root, source, destination, args, targetPath, fetch, log };
}
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('imports real Git bytes then creates and reads back a target Project using the existing SDK', {
  timeout: 30000,
}, async () => {
  const f = fixture();
  const project = {
    id: 'new-target-id',
    slug: 'acme',
    workingDirectory: f.targetPath,
  };
  f.fetch
    .mockResolvedValueOnce(reply(null, 404))
    .mockImplementationOnce(async (_url, init) => {
      const intent = JSON.parse(
        readFileSync(
          join(f.destination, 'workspace-project-request.json'),
          'utf8',
        ),
      );
      expect(intent.project).toEqual(JSON.parse(init!.body as string));
      expect(intent.project).toEqual({
        name: 'Acme',
        slug: 'acme',
        workingDirectory: f.targetPath,
        defaultWorkspaceIsolation: 'shared',
      });
      expect(new Headers(init!.headers).get('Authorization')).toBe(
        'Bearer synthetic-project-import-credential',
      );
      return reply(project, 201);
    })
    .mockResolvedValueOnce(reply(project));
  await runCloudCommand(f.args);
  const receipt = JSON.parse(
    readFileSync(
      join(f.destination, 'workspace-project-registration.json'),
      'utf8',
    ),
  );
  expect(receipt).toMatchObject({
    status: 'registered',
    project: { id: 'new-target-id', slug: 'acme' },
    executionAuthorityTransferred: false,
    targetFilesystemVerification: 'required',
  });
  expect(
    readFileSync(join(f.destination, 'workspace', 'file.txt'), 'utf8'),
  ).toBe('working\n');
  expect(readFileSync(join(f.source, 'file.txt'), 'utf8')).toBe('working\n');
  expect(JSON.stringify(receipt)).not.toContain(
    'synthetic-project-import-credential',
  );
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

test.each([401, 403, 500])(
  'refuses target preflight HTTP %s before creating an import',
  { timeout: 30000 },
  async (status) => {
    const f = fixture();
    f.fetch.mockResolvedValue(reply(null, status));
    await expect(runCloudCommand(f.args)).rejects.toThrow();
    expect(existsSync(f.destination)).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);

test('a slug collision never imports files or overwrites a Project', {
  timeout: 30000,
}, async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(reply({ id: 'existing' }));
  await expect(runCloudCommand(f.args)).rejects.toThrow('already exists');
  expect(existsSync(f.destination)).toBe(false);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test.each(['lost-reply', 'race', 'wrong-readback', 'rewritten-remote-path'])(
  'preserves bytes and intent after %s with no retry or success receipt',
  { timeout: 30000 },
  async (failure) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(null, 404));
    if (failure === 'lost-reply')
      f.fetch.mockRejectedValueOnce(new Error('sensitive upstream body'));
    else if (failure === 'race')
      f.fetch.mockResolvedValueOnce(reply(null, 409));
    else
      f.fetch
        .mockResolvedValueOnce(
          reply(
            { id: 'created', slug: 'acme', workingDirectory: f.targetPath },
            201,
          ),
        )
        .mockResolvedValueOnce(
          reply({
            id: failure === 'rewritten-remote-path' ? 'created' : 'other',
            slug: 'acme',
            workingDirectory:
              failure === 'rewritten-remote-path'
                ? '~/workspace/acme/workspace'
                : f.targetPath,
          }),
        );
    await expect(runCloudCommand(f.args)).rejects.toThrow(
      'registration is unconfirmed',
    );
    expect(
      readFileSync(join(f.destination, 'workspace', 'file.txt'), 'utf8'),
    ).toBe('working\n');
    const request = readFileSync(
      join(f.destination, 'workspace-project-request.json'),
      'utf8',
    );
    expect(request).not.toContain('sensitive upstream body');
    expect(
      existsSync(join(f.destination, 'workspace-project-registration.json')),
    ).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(
      ['wrong-readback', 'rewritten-remote-path'].includes(failure) ? 3 : 2,
    );
  },
);

test('requires an explicit target and absolute server path', {
  timeout: 30000,
}, async () => {
  const f = fixture();
  await expect(
    runCloudCommand(f.args.filter((arg) => !arg.startsWith('--api-base='))),
  ).rejects.toThrow('explicitly');
  await expect(
    runCloudCommand(
      f.args.map((arg) =>
        arg.startsWith('--target-workspace=')
          ? '--target-workspace=relative'
          : arg,
      ),
    ),
  ).rejects.toThrow('absolute');
  await expect(
    runCloudCommand(
      f.args.map((arg) => (arg.startsWith('--api-base=') ? '--api-base' : arg)),
    ),
  ).rejects.toThrow('--api-base');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(existsSync(f.destination)).toBe(false);
});
