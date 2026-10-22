import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';
import {
  RepositoryAcquisitionInputError,
  RepositoryAcquisitionService,
} from '../repository-acquisition-service.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-acquisition-'));
  roots.push(home);
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
  }).trim();
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
    }).trim(),
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
