import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test as baseTest, expect, vi } from 'vitest';

const test = baseTest.skipIf(process.platform === 'win32');

import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { OperatorSetupService } from '../operator-setup-service.js';
import { createProjectSessionDirectoryResolver } from '../project-session-directory.js';

const makeTempDir = trackTempDirs();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture() {
  const home = makeTempDir('station-operator-setup-');
  const cwd = join(home, 'checkout');
  mkdirSync(cwd);
  execGitSync(['init', '--initial-branch=main', cwd]);
  writeFileSync(join(cwd, 'recipe.txt'), 'first input');
  execGitSync(['add', '.'], { cwd });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd },
  );
  const storage = new FileStorageAdapter(home);
  const project = {
    id: randomUUID(),
    slug: 'setup',
    name: 'Setup',
    workingDirectory: cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await storage.createProject(project);
  const directory = createProjectSessionDirectoryResolver(home, storage);
  const context = async () => ({
    projectId: storage.getProject('setup').id,
    cwd: (await directory('setup'))!,
  });
  const service = new OperatorSetupService(
    home,
    context,
    () => storage.getProject('setup').id,
  );
  const command = (script: string) =>
    `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
  const request = {
    id: randomUUID(),
    expectedProjectId: project.id,
    command: command("require('fs').appendFileSync('effect.txt','once\\n')"),
    inputPaths: ['recipe.txt', 'absent.lock'],
  };
  return { home, cwd, service, request, context, command, storage, project };
}

test('preview has no effect; concurrent confirmation runs once and restart retains the actual exit outcome', async () => {
  const f = await fixture();
  const current = vi.fn();
  const preview = await f.service.preview('setup', f.request, current);
  expect(preview).toMatchObject({
    phase: 'previewed',
    cwd: realpathSync(f.cwd),
  });
  expect(preview.inputs[1]).toEqual({ path: 'absent.lock', sha256: null });
  expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false);
  const outcomes = await Promise.all([
    f.service.run('setup', f.request.id, current),
    f.service.run('setup', f.request.id, current),
  ]);
  expect(outcomes.map((r) => r.phase)).toEqual(['succeeded', 'succeeded']);
  expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8')).toBe('once\n');
  const restarted = new OperatorSetupService(
    f.home,
    f.context,
    () => f.storage.getProject('setup').id,
  );
  expect(await restarted.run('setup', f.request.id, current)).toMatchObject({
    phase: 'succeeded',
    exitCode: 0,
  });
  expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8')).toBe('once\n');
  writeFileSync(join(f.cwd, 'recipe.txt'), 'later agent edit');
  expect(await restarted.get('setup', f.request.id, current)).toMatchObject({
    phase: 'stale',
  });
  await restarted.run('setup', f.request.id, current);
  expect(readFileSync(join(f.cwd, 'recipe.txt'), 'utf8')).toBe(
    'later agent edit',
  );
  expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8')).toBe('once\n');
});

test.each(['input', 'head', 'missing-input-created'] as const)(
  'changed %s refuses a stale preview without setup or file rollback',
  async (kind) => {
    const f = await fixture();
    await f.service.preview('setup', f.request, () => {});
    if (kind === 'input')
      writeFileSync(join(f.cwd, 'recipe.txt'), 'agent edit');
    else if (kind === 'missing-input-created')
      writeFileSync(join(f.cwd, 'absent.lock'), 'new dependency input');
    else
      execGitSync(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'new source',
        ],
        { cwd: f.cwd },
      );
    expect(await f.service.run('setup', f.request.id, () => {})).toMatchObject({
      phase: 'stale',
    });
    expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false);
    if (kind === 'input')
      expect(readFileSync(join(f.cwd, 'recipe.txt'), 'utf8')).toBe(
        'agent edit',
      );
  },
);

test('a failed command retains partial effects and does not rerun on retry', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    command: f.command(
      "require('fs').appendFileSync('effect.txt','partial');process.exit(7)",
    ),
  };
  await f.service.preview('setup', request, () => {});
  expect(await f.service.run('setup', request.id, () => {})).toMatchObject({
    phase: 'failed',
    exitCode: 7,
  });
  expect(
    await new OperatorSetupService(
      f.home,
      f.context,
      () => f.storage.getProject('setup').id,
    ).run('setup', request.id, () => {}),
  ).toMatchObject({ phase: 'failed', exitCode: 7 });
  expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8')).toBe('partial');
});

test('a retained started receipt has an uncertain outcome after process ownership is lost and cannot replay', async () => {
  const f = await fixture();
  const preview = await f.service.preview('setup', f.request, () => {});
  writeFileSync(
    join(f.home, 'operator-setup', `${preview.id}.json`),
    JSON.stringify({ ...preview, phase: 'running' }),
  );
  const restarted = new OperatorSetupService(
    f.home,
    f.context,
    () => f.storage.getProject('setup').id,
  );
  expect(await restarted.run('setup', preview.id, () => {})).toMatchObject({
    phase: 'uncertain',
  });
  expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false);
});

test('changed Project identity or withdrawn authority cannot launch a reviewed command', async () => {
  const f = await fixture();
  await f.service.preview('setup', f.request, () => {});
  await expect(
    f.service.run('setup', f.request.id, () => {
      throw new Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  await f.storage.deleteProject(f.project.slug);
  await f.storage.createProject({ ...f.project, id: randomUUID() });
  await expect(f.service.run('setup', f.request.id, () => {})).rejects.toThrow(
    'Project identity changed',
  );
  expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false);
});

test('setup retires same-group background writers when the reviewed shell exits', async () => {
  const f = await fixture();
  const child = f.command(
    "require('fs').writeFileSync('child-ready',String(process.pid));setTimeout(()=>require('fs').writeFileSync('late-effect','escaped deadline'),600)",
  );
  const request = {
    ...f.request,
    command: `${child} & while [ ! -f child-ready ]; do sleep 0.01; done`,
  };
  await f.service.preview('setup', request, () => {});
  expect(await f.service.run('setup', request.id, () => {})).toMatchObject({
    phase: 'succeeded',
  });
  expect(existsSync(join(f.cwd, 'child-ready'))).toBe(true);
  await new Promise((done) => setTimeout(done, 800));
  expect(existsSync(join(f.cwd, 'late-effect'))).toBe(false);
});

test('a setup-created FIFO is refused as an input rather than blocking outcome inspection', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    command: 'rm recipe.txt && mkfifo recipe.txt',
  };
  await f.service.preview('setup', request, () => {});
  expect(await f.service.run('setup', request.id, () => {})).toMatchObject({
    phase: 'succeeded',
  });
  expect(await f.service.get('setup', request.id, () => {})).toMatchObject({
    phase: 'stale',
  });
  await expect(
    f.service.preview('setup', { ...request, id: randomUUID() }, () => {}),
  ).rejects.toThrow('regular files');
});

test('serialized UTF-8 admission preserves readable receipts and rejects oversized escaped previews before any effect', async () => {
  const f = await fixture();
  const good = await f.service.preview('setup', f.request, () => {});
  const original = readFileSync(
    join(f.home, 'operator-setup', `${good.id}.json`),
  );
  const input = `${'\u0001'.repeat(180)}/${'\u0002'.repeat(180)}/input.txt`;
  mkdirSync(join(f.cwd, '\u0001'.repeat(180), '\u0002'.repeat(180)), {
    recursive: true,
  });
  writeFileSync(join(f.cwd, input), 'small file');
  const request = {
    ...f.request,
    id: randomUUID(),
    inputPaths: Array.from({ length: 32 }, () => input),
  };
  await expect(f.service.preview('setup', request, () => {})).rejects.toThrow(
    'too large to retain safely',
  );
  expect(existsSync(join(f.home, 'operator-setup', `${request.id}.json`))).toBe(
    false,
  );
  expect(
    readFileSync(join(f.home, 'operator-setup', `${good.id}.json`)),
  ).toEqual(original);
  expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false);
  expect(await f.service.get('setup', good.id, () => {})).toMatchObject({
    phase: 'previewed',
  });
});
