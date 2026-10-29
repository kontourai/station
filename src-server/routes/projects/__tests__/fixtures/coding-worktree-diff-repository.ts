import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';

/** Test-only committed repository setup; deliberately imports no server runtime. */
export function codingDiffRepositoryFixture(directory: string) {
  const root = realpathSync(directory);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
  const put = (name: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  git(['init', '-q']);
  put('tracked.txt', 'original\n');
  put('.gitignore', 'ignored/\n');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@station.test',
    '-c',
    `core.hooksPath=${devNull}`,
    'commit',
    '-qm',
    'initial',
  ]);
  const state = () => ({
    index: readFileSync(join(root, '.git/index')).toString('hex'),
    status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  });
  return { root, git, put, state };
}

export const THREE_NEW_FILES = {
  'src/alpha.ts': 'export const alpha = 17;\n',
  'src/beta.ts': 'export const beta = 29;\n',
  'notes.md': '# Task result\n',
};
