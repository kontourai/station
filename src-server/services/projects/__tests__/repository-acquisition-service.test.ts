import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as mutationLocks from '@kontourai/station-shared/lifecycle-events';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createRepositoryAcquisitionRoutes } from '../../../routes/projects/repository-acquisition-routes.js';
import * as gitExec from '../../../utils/git-exec.js';
import { execGitSync } from '../../../utils/git-exec.js';
import * as processGroup from '../../../utils/process-group-exec.js';
import {
  RepositoryAcquisitionInputError,
  RepositoryAcquisitionService,
} from '../repository-acquisition-service.js';

const makeTempDir = trackTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const home = makeTempDir('station-acquisition-');
  const source = join(home, 'mirror');
  execGitSync(['init', '--initial-branch=main', source]);
  writeFileSync(join(source, 'README.md'), 'first revision');
  execGitSync(['add', '.'], { cwd: source });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'seed',
    ],
    { cwd: source },
  );
  const commit = execGitSync(['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  })
    .toString()
    .trim();
  return {
    home,
    source,
    commit,
    service: new RepositoryAcquisitionService(home),
  };
}

test('a real clone pins content and duplicate requests retain it after the source branch moves', async () => {
  const f = fixture();
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.source,
    sourceRef: 'main',
  };
  const [first, duplicate] = await Promise.all([
    f.service.acquire(request),
    f.service.acquire(request),
  ]);
  expect(first.phase).toBe('ready');
  expect(duplicate).toEqual(first);
  expect(first.resolvedCommit).toBe(f.commit);
  expect(readFileSync(join(first.checkoutPath, 'README.md'), 'utf8')).toBe(
    'first revision',
  );
  writeFileSync(join(f.source, 'README.md'), 'second revision');
  execGitSync(['add', '.'], { cwd: f.source });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'move',
    ],
    { cwd: f.source },
  );
  const restarted = new RepositoryAcquisitionService(f.home);
  expect(await restarted.acquire(request)).toEqual(first);
  expect(
    execGitSync(['rev-parse', 'HEAD'], {
      cwd: first.checkoutPath,
      encoding: 'utf8',
    })
      .toString()
      .trim(),
  ).toBe(f.commit);
  await expect(
    restarted.acquire({ ...request, sourceRef: 'other' }),
  ).rejects.toThrow('different repository or ref');
});

test('failed acquisition is durable and an explicit retry uses a new directory without overwriting prior files', async () => {
  const f = fixture();
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.source,
    sourceRef: 'later',
  };
  const failed = await f.service.acquire(request);
  expect(failed.phase).toBe('failed');
  expect(failed.resolvedCommit).toBeUndefined();
  expect(
    new RepositoryAcquisitionService(f.home).get(request.requestId),
  ).toEqual(failed);
  execGitSync(['branch', 'later'], { cwd: f.source });
  expect(await f.service.acquire(request)).toEqual(failed);
  const retried = await f.service.acquire(request, true);
  expect(retried.phase).toBe('ready');
  expect(retried.checkoutPath).not.toBe(failed.checkoutPath);
  expect(retried.resolvedCommit).toBe(f.commit);
});

test('an interrupted receipt is held until explicit retry and the earlier checkout is preserved', async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), sourceUrl: f.source };
  const ready = await f.service.acquire(request);
  expect(ready.phase).toBe('ready');
  const operationPath = join(
    f.home,
    'repository-acquisitions',
    request.requestId,
    'operation.json',
  );
  const interrupted = {
    ...ready,
    phase: 'acquiring',
    resolvedCommit: undefined,
    canonicalRemote: undefined,
  };
  writeFileSync(operationPath, JSON.stringify(interrupted));
  writeFileSync(
    join(ready.checkoutPath, 'README.md'),
    'edits after acquisition',
  );
  const restarted = new RepositoryAcquisitionService(f.home);
  expect((await restarted.acquire(request)).phase).toBe('acquiring');
  const retry = await restarted.acquire(request, true);
  expect(retry.phase).toBe('ready');
  expect(readFileSync(join(ready.checkoutPath, 'README.md'), 'utf8')).toBe(
    'edits after acquisition',
  );
  expect(readFileSync(join(retry.checkoutPath, 'README.md'), 'utf8')).toBe(
    'first revision',
  );
  writeFileSync(operationPath, '{}');
  await expect(restarted.acquire(request, true)).rejects.toThrow(
    'receipt is corrupt',
  );
  expect(readFileSync(operationPath, 'utf8')).toBe('{}');
});

test.each([
  'https://[broken/repo',
  'https://token@github.com/org/repo.git',
  'https://github.com/org/repo.git?token=private',
  'ext::sh -c touch marker',
  'file:///tmp/repo',
  'relative/repo',
])(
  'refuses unsupported or credential-bearing source %s before creating a receipt',
  async (sourceUrl) => {
    const f = fixture();
    const requestId = randomUUID();
    await expect(f.service.acquire({ requestId, sourceUrl })).rejects.toThrow(
      RepositoryAcquisitionInputError,
    );
    expect(f.service.get(requestId)).toBeNull();
  },
);

test('acquisition checks out repository bytes without running installed global filters', async () => {
  const f = fixture();
  const marker = join(f.home, 'filter-executed');
  writeFileSync(
    join(f.source, '.gitattributes'),
    'README.md filter=acquisition-review\n',
  );
  execGitSync(['add', '.'], { cwd: f.source });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'select installed filter',
    ],
    { cwd: f.source },
  );
  const config = join(f.home, 'global-config');
  writeFileSync(
    config,
    `[filter "acquisition-review"]\n  smudge = "touch '${marker}'; cat"\n`,
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  const acquired = await f.service.acquire({
    requestId: randomUUID(),
    sourceUrl: f.source,
  });
  expect(acquired.phase).toBe('ready');
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(join(acquired.checkoutPath, 'README.md'), 'utf8')).toBe(
    'first revision',
  );
});

test('monorepo acquisition retains the root receipt and verifies the selected starting directory again before creation', async () => {
  const f = fixture();
  mkdirSync(join(f.source, 'apps', 'web'), { recursive: true });
  writeFileSync(join(f.source, 'apps', 'web', 'README.md'), 'web application');
  execGitSync(['add', '.'], { cwd: f.source });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'monorepo',
    ],
    { cwd: f.source },
  );
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.source,
    subdirectory: 'apps/web',
  };
  const record = await f.service.acquire(request);
  expect(record.phase).toBe('ready');
  expect(record.workingDirectory).toBe(
    join(record.checkoutPath, 'apps', 'web'),
  );
  const selected = await f.service.projectSource(
    request.requestId,
    record.workingDirectory,
  );
  expect(selected.workingDirectory).toBe(record.workingDirectory);
  expect(selected.repositorySource.subdirectory).toBe('apps/web');
  const storage = new FileStorageAdapter(f.home);
  const now = new Date().toISOString();
  await storage.createProject({
    id: randomUUID(),
    slug: 'monorepo',
    name: 'Monorepo',
    createdAt: now,
    updatedAt: now,
    ...selected,
  });
  expect(
    new FileStorageAdapter(f.home).getProject('monorepo').repositorySource
      ?.subdirectory,
  ).toBe('apps/web');
  await expect(
    f.service.projectSource(request.requestId, record.checkoutPath),
  ).rejects.toThrow('no longer matches');
  rmSync(join(record.checkoutPath, 'apps', 'web'), { recursive: true });
  symlinkSync(f.source, join(record.checkoutPath, 'apps', 'web'), 'dir');
  await expect(f.service.projectSource(request.requestId)).rejects.toThrow(
    'subdirectory is unavailable',
  );
});

test.each([
  '../outside',
  '/absolute',
  'apps/../web',
  'apps\\web',
  '.git',
  'apps//web',
])(
  'rejects unsafe repository subdirectory %s before cloning',
  async (subdirectory) => {
    const f = fixture();
    await expect(
      f.service.acquire({
        requestId: randomUUID(),
        sourceUrl: f.source,
        subdirectory,
      }),
    ).rejects.toBeInstanceOf(RepositoryAcquisitionInputError);
  },
);

test('missing repository subdirectory leaves a durable failed acquisition instead of silently using the root', async () => {
  const f = fixture();
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.source,
    subdirectory: 'missing',
  };
  const record = await f.service.acquire(request);
  expect(record.phase).toBe('failed');
  expect(f.service.get(request.requestId)).toEqual(record);
});

test('durable cancellation wins against an in-flight clone and cannot be retried or bound after restart', async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), sourceUrl: f.source };
  const original = gitExec.execGit;
  let cloned!: () => void;
  let releaseClone!: () => void;
  const cloneObserved = new Promise<void>((resolve) => {
    cloned = resolve;
  });
  const holdClone = new Promise<void>((resolve) => {
    releaseClone = resolve;
  });
  vi.spyOn(gitExec, 'execGit').mockImplementation(async (args, options) => {
    const result = await original(args, options);
    if (args.includes('clone')) {
      cloned();
      await holdClone;
    }
    return result;
  });
  const pending = f.service.acquire(request);
  await cloneObserved;
  try {
    const otherProcess = new RepositoryAcquisitionService(f.home);
    const cancelled = await otherProcess.cancel(request.requestId);
    expect(cancelled?.phase).toBe('cancelled');
    expect(existsSync(join(cancelled!.checkoutPath, '.git'))).toBe(true);
  } finally {
    releaseClone();
    await pending;
  }
  expect((await pending).phase).toBe('cancelled');
  expect((await f.service.acquire(request, true)).phase).toBe('cancelled');
  const restarted = new RepositoryAcquisitionService(f.home);
  expect(restarted.get(request.requestId)?.phase).toBe('cancelled');
  await expect(restarted.projectSource(request.requestId)).rejects.toThrow(
    'Acquire and verify',
  );
  expect((await restarted.cancel(request.requestId))?.phase).toBe('cancelled');
});

test('cancelling a completed checkout refuses without revoking its verified receipt or deleting files', async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), sourceUrl: f.source };
  const ready = await f.service.acquire(request);
  await expect(f.service.cancel(request.requestId)).rejects.toThrow(
    'already available',
  );
  expect(f.service.get(request.requestId)).toEqual(ready);
  expect(readFileSync(join(ready.checkoutPath, 'README.md'), 'utf8')).toBe(
    'first revision',
  );
  expect(await f.service.cancel(randomUUID())).toBeNull();
});

test('cancellation rechecks authority after waiting for publication and leaves the receipt untouched on revocation', async () => {
  const f = fixture();
  const request = {
    requestId: randomUUID(),
    sourceUrl: f.source,
    sourceRef: 'missing',
  };
  const failed = await f.service.acquire(request);
  expect(failed.phase).toBe('failed');
  const release = await acquireFileMutationLockAsync(
    join(
      f.home,
      'repository-acquisitions',
      request.requestId,
      'publication.mutation',
    ),
  );
  let allowed = true;
  const cancellation = f.service.cancel(request.requestId, () => {
    if (!allowed) throw new Error('Authority ended');
  });
  allowed = false;
  await release();
  await expect(cancellation).rejects.toThrow('Authority ended');
  expect(f.service.get(request.requestId)).toEqual(failed);
});

test('matching retained checkouts are explicitly reverified without cloning and drift refuses without overwriting edits', async () => {
  const f = fixture();
  const acquired = await f.service.acquire({
    requestId: randomUUID(),
    sourceUrl: f.source,
    sourceRef: 'main',
  });
  const observed = vi.spyOn(gitExec, 'execGit');
  const candidates = await f.service.findReusable(
    { sourceUrl: f.source, sourceRef: 'main' },
    () => {},
  );
  expect(candidates.map((x) => x.request.requestId)).toEqual([
    acquired.request.requestId,
  ]);
  expect(
    await f.service.findReusable(
      { sourceUrl: f.source, sourceRef: 'other' },
      () => {},
    ),
  ).toEqual([]);
  expect(
    await f.service.findReusable(
      { sourceUrl: f.source, sourceRef: 'main', subdirectory: 'apps' },
      () => {},
    ),
  ).toEqual([]);
  const reused = await f.service.reuse(acquired.request.requestId, () => {});
  expect(reused.checkoutPath).toBe(acquired.checkoutPath);
  expect(reused.resolvedCommit).toBe(f.commit);
  expect(observed.mock.calls.some(([args]) => args.includes('clone'))).toBe(
    false,
  );
  writeFileSync(join(acquired.checkoutPath, 'README.md'), 'operator edits');
  await expect(
    f.service.reuse(acquired.request.requestId, () => {}),
  ).rejects.toThrow('changed or could not be verified');
  expect(readFileSync(join(acquired.checkoutPath, 'README.md'), 'utf8')).toBe(
    'operator edits',
  );
});

function mounted(f: ReturnType<typeof fixture>, current: () => boolean) {
  const app = new Hono().route(
    '/',
    createRepositoryAcquisitionRoutes(f.home, current),
  );
  return {
    app,
    acquire: (request: { requestId: string; sourceUrl: string }) =>
      app.request('/repository-acquisitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
  };
}

test.each(['operation', 'publication'])(
  'mounted acquisition loses authority during %s lock wait without launching Git',
  async (lock) => {
    const f = fixture();
    const request = { requestId: randomUUID(), sourceUrl: f.source };
    const directory = join(
      f.home,
      'repository-acquisitions',
      request.requestId,
    );
    mkdirSync(directory, { recursive: true });
    const release = await acquireFileMutationLockAsync(
      join(directory, `${lock}.mutation`),
    );
    let allowed = true;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const originalLock = mutationLocks.acquireFileMutationLockAsync;
    vi.spyOn(mutationLocks, 'acquireFileMutationLockAsync').mockImplementation(
      (path, ...options) => {
        const pending = originalLock(path, ...options);
        if (path === join(directory, `${lock}.mutation`)) admitted();
        return pending;
      },
    );
    const route = mounted(f, () => allowed);
    const git = vi.spyOn(gitExec, 'execGit');
    const pending = route.acquire(request);
    await admission;
    allowed = false;
    await release();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(directory);
    expect(git).not.toHaveBeenCalled();
    expect(f.service.get(request.requestId)).toBeNull();
    allowed = true;
    const renewed = await route.acquire(request);
    expect(renewed.status).toBe(200);
    expect((await renewed.json()).data.phase).toBe('ready');
  },
);

test('mounted clone revocation preserves uncertain bytes and exact explicit retry recovers with renewed authority', async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), sourceUrl: f.source };
  let allowed = true;
  const route = mounted(f, () => allowed);
  const original = gitExec.execGit;
  let cloned!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>((resolve) => {
    cloned = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const git = vi
    .spyOn(gitExec, 'execGit')
    .mockImplementation(async (args, options) => {
      const result = await original(args, options);
      if (args.includes('clone')) {
        cloned();
        await hold;
      }
      return result;
    });
  const pending = route.acquire(request);
  await observed;
  allowed = false;
  resume();
  const refused = await pending;
  expect(refused.status).toBe(403);
  expect(await refused.text()).not.toContain(f.home);
  expect(git.mock.calls).toHaveLength(1);
  const uncertain = new RepositoryAcquisitionService(f.home).get(
    request.requestId,
  )!;
  expect(uncertain.phase).toBe('acquiring');
  expect(existsSync(join(uncertain.checkoutPath, '.git'))).toBe(true);
  expect(existsSync(join(uncertain.checkoutPath, 'README.md'))).toBe(false);
  expect(
    (await route.app.request(`/repository-acquisitions/${request.requestId}`))
      .status,
  ).toBe(403);
  expect(
    (
      await route.app.request(
        `/repository-acquisitions/${request.requestId}/retry`,
        { method: 'POST' },
      )
    ).status,
  ).toBe(403);
  allowed = true;
  const duplicate = await route.acquire(request);
  expect((await duplicate.json()).data).toEqual(uncertain);
  expect(git.mock.calls).toHaveLength(1);
  const recovered = await route.app.request(
    `/repository-acquisitions/${request.requestId}/retry`,
    { method: 'POST' },
  );
  const ready = (await recovered.json()).data;
  expect(ready.phase).toBe('ready');
  expect(ready.request).toEqual(request);
  expect(ready.attempt).toBe(2);
  expect(ready.resolvedCommit).toBe(f.commit);
  expect(ready.checkoutPath).not.toBe(uncertain.checkoutPath);
  expect(existsSync(join(uncertain.checkoutPath, '.git'))).toBe(true);
  expect(readFileSync(join(ready.checkoutPath, 'README.md'), 'utf8')).toBe(
    'first revision',
  );
});

test.each(['create', 'inspect', 'cancel', 'retry'])(
  'mounted %s metadata is withheld on revocation before body release',
  async (action) => {
    const f = fixture();
    let allowed = true;
    const route = mounted(f, () => allowed);
    const request = {
      requestId: randomUUID(),
      sourceUrl: f.source,
      sourceRef: 'missing',
    };
    if (action !== 'create') await f.service.acquire(request);
    const response =
      action === 'create'
        ? await route.acquire(request)
        : await route.app.request(
            `/repository-acquisitions/${request.requestId}${action === 'inspect' ? '' : `/${action}`}`,
            { method: action === 'inspect' ? 'GET' : 'POST' },
          );
    expect(response.status).toBe(200);
    allowed = false;
    await expect(response.text()).rejects.toThrow('authorization ended');
  },
);

test('mounted acquisition revocation during real Git credential setup prevents clone launch', async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), sourceUrl: f.source };
  let allowed = true;
  const route = mounted(f, () => allowed);
  const original = processGroup.runInProcessGroup;
  let setup!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>((resolve) => {
    setup = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const processes = vi
    .spyOn(processGroup, 'runInProcessGroup')
    .mockImplementation(async (file, args, options) => {
      try {
        return await original(file, args, options);
      } finally {
        if (args.includes('--get-regexp')) {
          setup();
          await hold;
        }
      }
    });
  const pending = route.acquire(request);
  await observed;
  allowed = false;
  resume();
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(f.home);
  expect(processes.mock.calls.some(([, args]) => args.includes('clone'))).toBe(
    false,
  );
  const record = f.service.get(request.requestId)!;
  expect(record.phase).toBe('acquiring');
  expect(existsSync(record.checkoutPath)).toBe(false);
});
