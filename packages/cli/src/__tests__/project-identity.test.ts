import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectPortableIdentity } from '@kontourai/station-contracts/project-identity';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runCoreCommand } from '../commands/core.js';

const identity: ProjectPortableIdentity = {
  schemaVersion: 1,
  id: 'prj_portable_cli',
  repos: [
    {
      id: 'github.com/example/project',
      kind: 'git',
      canonicalRemote: 'github.com/example/project',
      role: 'primary',
    },
  ],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const apiBase = 'https://target.example.test';
const credentials = [
  `--api-base=${apiBase}`,
  '--credential=fixture-project-owner',
];
const fetchMock = vi.fn<typeof fetch>();
const roots: string[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function response(slug = 'destination', portable = identity) {
  return Response.json({
    success: true,
    data: {
      identity: portable,
      association: {
        portableProjectId: portable.id,
        localProjectId: 'local-destination',
        localProjectSlug: slug,
      },
      outcome: 'created',
    },
  });
}
async function snapshot(value: unknown = identity) {
  const root = await mkdtemp(join(tmpdir(), 'station-identity-cli-'));
  roots.push(root);
  const file = join(root, 'identity.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

test.each(['identity', 'prepare-identity'])(
  '%s prints only the portable snapshot through the real SDK',
  async (action) => {
    fetchMock.mockResolvedValueOnce(response('source'));
    await runCoreCommand('projects', [action, 'source', ...credentials]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/api/projects/source/identity${action === 'prepare-identity' ? '/prepare' : ''}`,
      expect.objectContaining({
        method: action === 'identity' ? 'GET' : 'POST',
      }),
    );
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(identity, null, 2));
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      'local-destination',
    );
  },
);

test('execution-root reads an exact guard then sets the portable selection', async () => {
  const updated = {
    ...identity,
    executionRoot: { repoId: 'github.com/example/project', path: 'apps/web' },
  };
  fetchMock
    .mockResolvedValueOnce(response('source'))
    .mockResolvedValueOnce(response('source', updated));
  await runCoreCommand('projects', [
    'execution-root',
    'source',
    ...credentials,
    '--repo-id=github.com/example/project',
    '--path=apps/web',
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const mutation = fetchMock.mock.calls[1];
  expect(mutation?.[0]).toBe(
    `${apiBase}/api/projects/source/identity/execution-root`,
  );
  expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({
    expectedIdentity: identity,
    expectedLocalProjectId: 'local-destination',
    executionRoot: updated.executionRoot,
  });
});

test.each([
  ['--clear', '--path=apps/web'],
  ['--repo-id=git.example/acme/repo'],
  ['--path=apps/web'],
  ['--repo-id=github.com/example/project', '--path=../outside'],
])(
  'execution-root rejects invalid flag combination before network',
  async (...flags) => {
    await expect(
      runCoreCommand('projects', [
        'execution-root',
        'source',
        ...credentials,
        ...flags,
      ]),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test('execution-root refuses an unknown resource after the guarded read and before mutation', async () => {
  fetchMock.mockResolvedValueOnce(response('source'));
  await expect(
    runCoreCommand('projects', [
      'execution-root',
      'source',
      ...credentials,
      '--repo-id=github.com/example/other',
      '--path=apps/web',
    ]),
  ).rejects.toThrow('does not declare resource');
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each([undefined, '~/receiver/checkout', 'C:\\work\\project'])(
  'attachment keeps destination path %s on the destination',
  async (path) => {
    fetchMock.mockResolvedValueOnce(response());
    await runCoreCommand('projects', [
      'attach',
      'destination',
      ...credentials,
      '--name=Destination Project',
      `--identity-file=${await snapshot()}`,
      ...(path ? [`--target-workspace=${path}`] : []),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/api/projects/attach`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      slug: 'destination',
      name: 'Destination Project',
      identity,
      ...(path ? { workingDirectory: path } : {}),
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`endpoint=${apiBase}`),
    );
  },
);

test('attachment requires an explicit destination before reading the snapshot', async () => {
  await expect(
    runCoreCommand('projects', [
      'attach',
      'destination',
      '--credential=fixture-project-owner',
      '--name=Destination',
      '--identity-file=missing.json',
    ]),
  ).rejects.toThrow('Select the destination explicitly');
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  { ...identity, bindings: [{ path: '/private/checkout' }] },
  { ...identity, schemaVersion: 999 },
])(
  'invalid/private snapshot fields cannot reach the attachment API',
  async (value) => {
    await expect(
      runCoreCommand('projects', [
        'attach',
        'destination',
        ...credentials,
        '--name=Destination',
        `--identity-file=${await snapshot(value)}`,
      ]),
    ).rejects.toThrow('Invalid or unsupported portable Project identity');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test('a bounded file read rejects an oversized snapshot before HTTP', async () => {
  const file = await snapshot({ padding: 'x'.repeat(65537) });
  await expect(
    runCoreCommand('projects', [
      'attach',
      'destination',
      ...credentials,
      '--name=Destination',
      `--identity-file=${file}`,
    ]),
  ).rejects.toThrow('64 KiB');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an unsupported dry-run flag never performs a write', async () => {
  await expect(
    runCoreCommand('projects', [
      'attach',
      'destination',
      ...credentials,
      '--dry-run',
    ]),
  ).rejects.toThrow('Unsupported');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a receiver returning another portable identity cannot report success', async () => {
  fetchMock.mockResolvedValueOnce(
    response('destination', { ...identity, id: 'prj_other' }),
  );
  await expect(
    runCoreCommand('projects', [
      'attach',
      'destination',
      ...credentials,
      '--name=Destination',
      `--identity-file=${await snapshot()}`,
    ]),
  ).rejects.toThrow('cannot validate the Project attachment');
  expect(console.log).not.toHaveBeenCalled();
});
