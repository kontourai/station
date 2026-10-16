import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { codingDiffFixture } from '../../../routes/projects/__tests__/fixtures/coding-worktree-diff.js';
import { readProjectRepository } from '../git-read-repository.js';
import { readWorkspaceDiff } from '../workspace-diff-service.js';
import type { WorkspaceFilePreviewFsPort } from '../workspace-file-preview-service.js';

const makeTempDir = trackTempDirs();
const fixture = () => codingDiffFixture(makeTempDir('station-diff-safety-'));
const fsPort: WorkspaceFilePreviewFsPort = {
  noFollow: constants.O_NOFOLLOW,
  lstat: lstatSync,
  realpath: realpathSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};
async function patch(f: ReturnType<typeof fixture>) {
  const response = await f.request();
  const body = (await response.json()) as {
    success: boolean;
    data?: { diff: string };
    error?: string;
  };
  return { response, body };
}

describe('bounded worktree additions', () => {
  test('clean stays empty; tracked unstaged bytes stay compatible; staged-only stays excluded; ignored files stay excluded', async () => {
    const f = fixture();
    expect((await patch(f)).body.data?.diff).toBe('');
    f.put('tracked.txt', 'staged\n');
    f.git(['add', 'tracked.txt']);
    expect((await patch(f)).body.data?.diff).toBe('');
    f.put('tracked.txt', 'unstaged\n');
    f.put('ignored/.env', 'secret ignored\n');
    writeFileSync(join(f.root, '.git/info/exclude'), 'private.txt\n');
    f.put('private.txt', 'private excluded\n');
    const before = f.state();
    expect((await patch(f)).body.data?.diff).toBe(
      f.git(['diff', '--no-color']),
    );
    expect(f.state()).toEqual(before);
  });

  test('literal quoted, newline, Unicode and shell-looking names parse as distinct additions, including no final newline', async () => {
    const f = fixture();
    const names =
      process.platform === 'win32'
        ? ['日本語.txt', 'space name.txt']
        : [
            'quote".txt',
            'line\nbreak.txt',
            '日本語.txt',
            '$(touch owned).txt',
            'control' + String.fromCharCode(1) + '.txt',
            'separator' + String.fromCharCode(0x2028) + '.txt',
          ];
    for (const name of names)
      f.put(name, `literal ${name.replaceAll('\n', ' ')} content`);
    const { body } = await patch(f);
    expect(body.success).toBe(true);
    const files = parsePatchFiles(body.data!.diff).flatMap(
      (part) => part.files,
    );
    expect(files.map((file) => file.name).sort()).toEqual(names.sort());
    expect(files.every((file) => file.hunks.length === 1)).toBe(true);
    expect(body.data!.diff).toContain('\\ No newline at end of file');
    expect(
      f
        .git(['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .sort(),
    ).toEqual(names.sort());
  });

  test('empty and binary additions are real parseable file entries without invented text', async () => {
    const f = fixture();
    f.put('empty.txt', '');
    f.put('binary.dat', Buffer.from([0, 1, 255]));
    const { body } = await patch(f);
    expect(body.success).toBe(true);
    const files = parsePatchFiles(body.data!.diff).flatMap(
      (part) => part.files,
    );
    expect(files.map((file) => file.name).sort()).toEqual([
      'binary.dat',
      'empty.txt',
    ]);
    expect(files.every((file) => file.type === 'new')).toBe(true);
    expect(body.data!.diff).toContain(
      'Binary files /dev/null and b/binary.dat differ',
    );
    expect(files.every((file) => file.hunks.length === 0)).toBe(true);
  });

  test.each(['oversized', 'count', 'total', 'output', 'listing'] as const)(
    'refuses the entire public read on %s overflow',
    async (kind) => {
      const f = fixture();
      f.put('valid.txt', 'do not return a partial patch\n');
      if (kind === 'oversized')
        f.put('large.txt', Buffer.alloc(256 * 1024 + 1, 65));
      if (kind === 'count')
        for (let i = 0; i < 128; i++) f.put(`file-${i}.txt`, 'x');
      if (kind === 'total')
        for (let i = 0; i < 9; i++)
          f.put(`file-${i}.txt`, Buffer.alloc(256 * 1024, 65));
      if (kind === 'output')
        f.put('tracked.txt', 'x\n'.repeat(2 * 1024 * 1024));
      if (kind === 'listing')
        for (let i = 0; i < 300; i++) f.put(`${i}-${'x'.repeat(220)}`, 'x');
      const before = f.state();
      const { response, body } = await patch(f);
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Worktree diff unavailable:');
      expect(body.data).toBeUndefined();
      expect(f.state()).toEqual(before);
    },
  );

  test.each([
    'symlink',
    'hardlink',
    ...(process.platform === 'win32' ? [] : (['fifo'] as const)),
    'credential',
  ] as const)(
    'refuses %s entries rather than reporting no changes',
    async (kind) => {
      const f = fixture();
      const outside = join(
        realpathSync(makeTempDir('station-diff-outside-')),
        'secret.txt',
      );
      writeFileSync(outside, 'outside secret\n');
      if (kind === 'symlink') symlinkSync(outside, join(f.root, 'entry.txt'));
      if (kind === 'hardlink') linkSync(outside, join(f.root, 'entry.txt'));
      if (kind === 'fifo')
        execFileSync('mkfifo', [join(f.root, 'entry.txt')], {
          windowsHide: true,
          timeout: 5000,
        });
      if (kind === 'credential') f.put('.env.local', 'credential secret\n');
      const { response, body } = await patch(f);
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.data).toBeUndefined();
      expect(body.error).not.toContain('outside secret');
      expect(body.error).not.toContain('credential secret');
    },
  );

  test.skipIf(process.platform === 'win32').each([false, true])(
    'malformed nested git marker refuses a FIFO even with ordinary sibling=%s',
    async (withSibling) => {
      const f = fixture();
      f.put('sub/.git', '');
      execFileSync('mkfifo', [join(f.root, 'sub/entry.pipe')], {
        windowsHide: true,
        timeout: 5000,
      });
      if (withSibling)
        f.put('sub/new.txt', 'must not return a partial patch\n');
      const before = f.state();
      const { response, body } = await patch(f);
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.data).toBeUndefined();
      expect(body.error).toContain('Worktree diff unavailable:');
      expect(f.state()).toEqual(before);
    },
  );

  test('indexed submodule contents are never entered even with an invalid marker', async () => {
    const f = fixture();
    f.git([
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${f.git(['rev-parse', 'HEAD']).trim()},sub`,
    ]);
    f.put('sub/.git', 'not a valid gitfile');
    f.put('sub/.env', 'submodule contents must not be read\n');
    const state = () => ({
      index: readFileSync(join(f.root, '.git/index')).toString('hex'),
      status: f.git([
        'status',
        '--porcelain=v1',
        '-z',
        '--ignore-submodules=all',
      ]),
    });
    const before = state();
    const { response, body } = await patch(f);
    expect(response.status).toBe(200);
    expect(body.data?.diff).toBe('');
    expect(state()).toEqual(before);
  });

  test.each([
    'file-symlink',
    'parent-swap',
    'grow',
    'hardlink-after-open',
  ] as const)(
    'rejects %s during descriptor read, including without O_NOFOLLOW',
    async (kind) => {
      const f = fixture();
      f.put('sub/new.txt', 'public\n');
      const outside = realpathSync(makeTempDir('station-diff-race-'));
      writeFileSync(join(outside, 'new.txt'), 'outside secret\n');
      let changed = false;
      const port: WorkspaceFilePreviewFsPort = {
        ...fsPort,
        noFollow: 0,
        open: (path, flags) => {
          if (kind === 'file-symlink') {
            rmSync(path);
            symlinkSync(join(outside, 'new.txt'), path);
          }
          const descriptor = openSync(path, flags);
          if (kind === 'hardlink-after-open')
            linkSync(path, join(outside, 'linked.txt'));
          return descriptor;
        },
        read: (...args) => {
          if (!changed) {
            changed = true;
            if (kind === 'parent-swap') {
              renameSync(join(f.root, 'sub'), join(f.root, 'saved'));
              symlinkSync(outside, join(f.root, 'sub'));
            }
            if (kind === 'grow')
              writeFileSync(
                join(f.root, 'sub/new.txt'),
                'more data than was observed\n',
              );
          }
          return readSync(...args);
        },
      };
      await expect(
        readProjectRepository(f.root, f.root, {}, (repository) =>
          readWorkspaceDiff(repository, port),
        ),
      ).rejects.toThrow('Worktree diff unavailable:');
    },
  );
});
