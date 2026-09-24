/**
 * #2363: the coding git routes over the real handlers and real git.
 *
 * A Project folder can be written by people other than the operator, and
 * these routes run git in it as the operator. Each plant is first proven
 * LIVE with plain git (a green result must not come from a plant that never
 * fires), then driven through the route the product calls.
 *
 * The one stub is `resolvePrincipal`, which is how a test says who is
 * calling. "The remote" is a bare repository in a temp folder, reached
 * through an `insteadOf` in a throwaway GLOBAL git config (the operator's
 * own configuration, which applies by design), so the route validates an
 * ordinary https address while the push really lands somewhere this test
 * can read. `testOnlyAllowFileTransport` lets that one rewrite through.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { createCodingRoutes } from '../coding.js';

const OPERATOR: PrincipalRef = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
};
const COLLABORATOR = humanPrincipal('device', 'collaborator', 'Collaborator');
const REMOTE_URL = 'https://git.example.test/acme/pulse.git';

let root: string;
let project: string;
let bare: string;
let marker: string;

/** Plain git, NOT Station's runner. */
function plain(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 20_000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

function plant(name: string): string {
  const script = join(root, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho ${name} >> '${marker}'\nexit 0\n`);
  chmodSync(script, 0o755);
  return script;
}

function ran(): string[] {
  return existsSync(marker)
    ? readFileSync(marker, 'utf-8').split('\n').filter(Boolean)
    : [];
}

function clearMarker(): void {
  rmSync(marker, { force: true });
}

function head(repo = project): string {
  return plain(repo, ['rev-parse', 'HEAD']);
}

function bareHead(branch = 'main'): string {
  return plain(bare, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
}

function makeApp() {
  return createCodingRoutes({} as unknown as FileTreeService, {
    resolveProjectFolder: (slug) => (slug === 'acme' ? project : undefined),
    visibility: {
      resolvePrincipal: (c) =>
        c.req.header('x-test-caller') === 'collaborator'
          ? COLLABORATOR
          : OPERATOR,
    },
    testOnlyAllowFileTransport: true,
  });
}

async function post(
  path: string,
  body: Record<string, unknown>,
  caller: 'operator' | 'collaborator' = 'operator',
) {
  const res = await makeApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-caller': caller },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function status(path = project) {
  const res = await makeApp().request(
    `/git/status?projectSlug=acme&path=${encodeURIComponent(path)}`,
  );
  return { status: res.status, json: (await res.json()) as any };
}

async function read(route: 'diff' | 'status', path = project) {
  const res = await makeApp().request(
    `/git/${route}?projectSlug=acme&path=${encodeURIComponent(path)}`,
  );
  return { status: res.status, json: (await res.json()) as any };
}

function installHook(dir: string, name: string): void {
  const target = join(dir, name);
  writeFileSync(target, readFileSync(plant(name)));
  chmodSync(target, 0o755);
}

/** New mtime, same content: git must refresh (and may rewrite) the index. */
function stir(file: string): void {
  utimesSync(
    file,
    new Date(),
    new Date(Date.now() + 5_000 + Math.random() * 60_000),
  );
}

/**
 * Processes whose working directory is inside `dir`, by `lsof` (macOS and
 * Linux). A git blocked on a FIFO include sits in the repository.
 */
function processesInside(dir: string): number[] {
  let output = '';
  try {
    output = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '+c', '0'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? '';
  }
  const pids: number[] = [];
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (
      line.startsWith('n') &&
      (line.slice(1) === dir || line.slice(1).startsWith(`${dir}/`))
    )
      pids.push(pid);
  }
  return pids.filter((candidate) => candidate !== process.pid);
}

/** Replaces `path` with a symbolic link to `target`. */
function swapForLink(path: string, target: string): void {
  rmSync(path, { force: true });
  symlinkSync(target, path);
}

/** The operator's other repository, outside the Project. */
function otherRepository(): string {
  const other = join(root, 'operator-other');
  if (existsSync(other)) return other;
  mkdirSync(other);
  plain(other, ['init', '-q', '-b', 'main']);
  writeFileSync(join(other, 'work.txt'), 'operator work\n');
  plain(other, ['add', '.']);
  plain(other, ['commit', '-q', '-m', 'operator work']);
  return other;
}

/** A repository whose working tree is dirty, ready to commit. */
function dirty(file = 'change.txt', content = 'change\n'): void {
  writeFileSync(join(project, file), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'station-coding-git-')));
  project = join(root, 'project');
  bare = join(root, 'remote.git');
  marker = join(root, 'ran.log');
  const global = join(root, 'global.gitconfig');
  writeFileSync(
    global,
    [
      '[user]',
      '\tname = Station Operator',
      '\temail = operator@station.test',
      '[init]',
      '\tdefaultBranch = main',
      `[url "file://${bare}"]`,
      `\tinsteadOf = ${REMOTE_URL}`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'system.gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_SYSTEM', join(root, 'system.gitconfig'));

  plain(root, ['init', '-q', '--bare', bare]);
  mkdirSync(project);
  plain(project, ['init', '-q', '-b', 'main']);
  writeFileSync(join(project, 'README.md'), '# project\n');
  plain(project, ['add', '-A']);
  plain(project, ['commit', '-q', '-m', 'initial']);
  plain(project, ['remote', 'add', 'origin', REMOTE_URL]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'coding git routes: repo-local config (#2363)',
  () => {
    test('a planted core.fsmonitor does not run when the Project page reads status', async () => {
      plain(project, ['config', 'core.fsmonitor', plant('fsmonitor')]);
      plain(project, ['status', '--porcelain']);
      expect(ran(), 'control: plain git runs the plant').toContain('fsmonitor');
      clearMarker();

      const res = await status();
      expect(res.status).toBe(200);
      expect(res.json.data.isRepo).toBe(true);
      expect(ran()).toEqual([]);
    });

    test('planted hooks do not run on status', async () => {
      for (const hook of ['pre-commit', 'post-index-change', 'post-checkout']) {
        const target = join(project, '.git', 'hooks', hook);
        writeFileSync(target, readFileSync(plant(hook)));
        chmodSync(target, 0o755);
      }
      // Same content, new mtime: status refreshes the stat data and, unless
      // told not to, rewrites the index, which runs post-index-change.
      const touch = () =>
        utimesSync(
          join(project, 'README.md'),
          new Date(),
          new Date(Date.now() + 10_000 + Math.random() * 10_000),
        );
      touch();
      plain(project, ['status', '--porcelain']);
      expect(ran(), 'control: plain git status runs the plant').toEqual([
        'post-index-change',
      ]);
      clearMarker();
      touch();

      const res = await status();
      expect(res.status).toBe(200);
      expect(ran()).toEqual([]);
    });

    test('a locally defined filter driver is refused on status and commit, and never runs', async () => {
      writeFileSync(join(project, '.gitattributes'), '*.txt filter=evil\n');
      writeFileSync(join(project, 'notes.txt'), 'hello\n');
      plain(project, ['add', '.gitattributes', 'notes.txt']);
      plain(project, ['commit', '-q', '-m', 'attributes']);
      plain(project, [
        'config',
        'filter.evil.clean',
        `sh -c 'echo clean >> ${marker}; cat'`,
      ]);
      // Same size, new content and mtime: status cannot decide from the
      // stat data and must hash the file, through the filter.
      writeFileSync(join(project, 'notes.txt'), 'HELLO\n');
      utimesSync(
        join(project, 'notes.txt'),
        new Date(),
        new Date(Date.now() + 5000),
      );
      plain(project, ['status', '--porcelain']);
      expect(ran(), 'control: plain git status runs the filter').toContain(
        'clean',
      );
      clearMarker();

      const read = await status();
      expect(read.status).toBe(409);
      expect(read.json.code).toBe('repository-config-refused');
      expect(read.json.keys).toEqual(['filter.evil.clean']);

      const before = head();
      const commit = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'should not land',
      });
      expect(commit.status).toBe(409);
      expect(commit.json.keys).toEqual(['filter.evil.clean']);
      expect(commit.json.error).toContain('.git/config');
      expect(head()).toBe(before);
      expect(ran()).toEqual([]);
    });

    test('a repo-local insteadOf to ext:: with protocol.ext.allow is refused on push and runs nothing', async () => {
      // Its own host: the operator's global rewrite of REMOTE_URL is longer,
      // so it would win over a local rewrite of the same prefix.
      plain(project, [
        'config',
        'remote.origin.url',
        'https://evil.example.test/acme/pulse.git',
      ]);
      plain(project, [
        'config',
        `url.ext::sh -c echo% ext% >>% ${marker}% #.insteadOf`,
        'https://evil.example.test/',
      ]);
      plain(project, ['config', 'protocol.ext.allow', 'always']);
      plain(project, ['ls-remote', 'origin']);
      expect(ran(), 'control: plain git runs the plant').toContain('ext');
      clearMarker();

      const res = await post('/git/push', {
        projectSlug: 'acme',
        setUpstream: true,
      });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('repository-config-refused');
      expect(res.json.keys).toEqual([
        `url.ext::sh -c echo% ext% >>% ${marker}% #.insteadof`,
      ]);
      expect(ran()).toEqual([]);
      expect(bareHead()).toBe('');
    });

    test('a repo-local core.sshCommand or credential helper is refused on push, and nothing runs', async () => {
      plain(project, ['config', 'core.sshCommand', plant('ssh')]);
      plain(project, ['config', 'credential.helper', `!${plant('helper')}`]);

      const res = await post('/git/push', { projectSlug: 'acme' });
      expect(res.status).toBe(409);
      expect(res.json.keys).toEqual(['core.sshcommand', 'credential.helper']);
      expect(ran()).toEqual([]);
      expect(bareHead()).toBe('');
    });

    test('the diff the Diff panel reads on mount runs no planted index hook', async () => {
      installHook(join(project, '.git', 'hooks'), 'post-index-change');
      stir(join(project, 'README.md'));
      plain(project, ['diff']);
      expect(ran(), 'control: plain git diff runs the plant').toEqual([
        'post-index-change',
      ]);
      clearMarker();

      stir(join(project, 'README.md'));
      const res = await read('diff');
      expect(res.status).toBe(200);
      expect(ran()).toEqual([]);
    });

    test("a nested repository's own clean filter does not run on status or diff", async () => {
      const sub = join(project, 'sub');
      mkdirSync(sub);
      plain(sub, ['init', '-q', '-b', 'main']);
      writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(sub, 's'), 'x\n');
      plain(sub, ['add', '.']);
      plain(sub, ['commit', '-q', '-m', 'sub']);
      plain(sub, [
        'config',
        'filter.evil.clean',
        `sh -c 'echo nested >> ${marker}; cat'`,
      ]);
      plain(project, ['add', 'sub']);
      plain(project, ['commit', '-q', '-m', 'gitlink']);
      stir(join(sub, 's'));
      plain(project, ['status', '--porcelain']);
      expect(
        ran(),
        'control: plain git status enters the nested repo',
      ).toContain('nested');
      clearMarker();

      for (const route of ['status', 'diff'] as const) {
        stir(join(sub, 's'));
        const res = await read(route);
        expect(res.status, route).toBe(200);
        expect(ran(), route).toEqual([]);
      }
    });

    test('checkout runs no planted post-checkout hook, and refuses a name that is not a branch', async () => {
      installHook(join(project, '.git', 'hooks'), 'post-checkout');
      const checkout = (branch: string, create?: boolean) =>
        post('/git/checkout', {
          projectSlug: 'acme',
          path: project,
          branch,
          create,
        });

      const created = await checkout('feature', true);
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      const back = await checkout('main');
      expect(back.status).toBe(200);
      expect(plain(project, ['branch', '--show-current'])).toBe('main');
      expect(ran()).toEqual([]);

      dirty('README.md', '# unsaved edit\n');
      for (const name of ['.', '-f', '--orphan=x', 'a..b', '@{-1}']) {
        const res = await checkout(name);
        expect(res.status, name).toBe(400);
        expect(res.json.code).toBe('invalid-branch');
      }
      expect(readFileSync(join(project, 'README.md'), 'utf-8')).toBe(
        '# unsaved edit\n',
      );
      expect(plain(project, ['branch', '--show-current'])).toBe('main');
    });

    test('an include of a named pipe answers 504 on status, log and branches, and leaves no git behind', async () => {
      const fifo = join(root, 'never.gitconfig');
      execFileSync('mkfifo', [fifo]);
      plain(project, ['config', 'include.path', fifo]);
      const app = makeApp();
      try {
        for (const route of ['status', 'log', 'branches']) {
          const started = Date.now();
          const res = await app.request(
            `/git/${route}?projectSlug=acme&path=${encodeURIComponent(project)}`,
          );
          const json = (await res.json()) as { code?: string };
          expect(res.status, route).toBe(504);
          expect(json.code, route).toBe('git-timeout');
          expect(Date.now() - started, route).toBeLessThan(25_000);
        }
        // The deadline stopped git: nothing is left working in the repo.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(processesInside(root)).toEqual([]);
      } finally {
        for (const pid of processesInside(root)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        rmSync(fifo, { force: true });
      }
    }, 120_000);

    test('ordinary repositories pass: gh-cloned, husky, VS Code and branch settings', async () => {
      plain(project, ['config', 'remote.origin.gh-resolved', 'base']);
      plain(project, ['config', 'core.hooksPath', '.husky/_']);
      plain(project, [
        'config',
        'branch.main.vscode-merge-base',
        'origin/main',
      ]);
      plain(project, ['config', 'branch.main.pushRemote', 'origin']);
      plain(project, ['config', 'branch.main.rebase', 'true']);
      plain(project, ['config', 'core.fsmonitor', 'true']);
      dirty();

      expect((await status()).status).toBe(200);
      const commit = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'ordinary',
      });
      expect(commit.status).toBe(200);
      const push = await post('/git/push', {
        projectSlug: 'acme',
        setUpstream: true,
      });
      expect(push.status, JSON.stringify(push.json)).toBe(200);
      expect(bareHead()).toBe(head());
    });

    test('a real `git clone` of a local bare repository passes the config check', async () => {
      plain(project, ['push', '-q', bare, 'main']);
      rmSync(project, { recursive: true, force: true });
      plain(root, ['clone', '-q', bare, project]);
      writeFileSync(join(project, 'cloned.txt'), 'x\n');

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'from a clone',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(plain(project, ['log', '-1', '--format=%s'])).toBe('from a clone');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'coding git routes: commit (#2363)',
  () => {
    test('the pre-commit hook runs on the operator commit (owner decision)', async () => {
      const hook = join(project, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, readFileSync(plant('pre-commit')));
      chmodSync(hook, 0o755);
      dirty();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'with hook',
      });
      expect(res.status).toBe(200);
      expect(res.json.data.sha).toBe(head());
      expect(ran()).toEqual(['pre-commit']);
    });

    test('a .git file pointing at a repository outside the Project is refused for commit and push, and nothing is written there', async () => {
      const other = join(root, 'operator-other');
      mkdirSync(other);
      plain(other, ['init', '-q', '-b', 'main']);
      writeFileSync(join(other, 'work.txt'), 'operator work\n');
      plain(other, ['add', '.']);
      plain(other, ['commit', '-q', '-m', 'operator work']);
      plain(other, ['remote', 'add', 'origin', REMOTE_URL]);
      const otherHead = head(other);
      rmSync(join(project, '.git'), { recursive: true, force: true });
      writeFileSync(join(project, '.git'), `gitdir: ${join(other, '.git')}\n`);
      writeFileSync(join(project, 'member.txt'), 'member payload\n');

      const commit = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'routine commit',
      });
      expect(commit.status).toBe(403);
      expect(commit.json.code).toBe('git-dir-outside-project');
      const push = await post('/git/push', { projectSlug: 'acme' });
      expect(push.status).toBe(403);
      expect(head(other)).toBe(otherHead);
      expect(plain(other, ['status', '--porcelain'])).toBe('');
      expect(bareHead()).toBe('');
    });

    test("a .git file borrowing ANOTHER checkout's worktree entry is refused (the back-pointer does not name this folder)", async () => {
      const other = join(root, 'operator-other');
      mkdirSync(other);
      plain(other, ['init', '-q', '-b', 'main']);
      writeFileSync(join(other, 'work.txt'), 'operator work\n');
      plain(other, ['add', '.']);
      plain(other, ['commit', '-q', '-m', 'operator work']);
      plain(other, [
        'worktree',
        'add',
        '-q',
        '-b',
        'lane',
        join(root, 'operator-lane'),
      ]);
      const laneHead = plain(other, ['rev-parse', 'lane']);
      rmSync(join(project, '.git'), { recursive: true, force: true });
      writeFileSync(
        join(project, '.git'),
        `gitdir: ${join(other, '.git', 'worktrees', 'operator-lane')}\n`,
      );
      writeFileSync(join(project, 'member.txt'), 'member payload\n');

      const commit = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'routine commit',
      });
      expect(commit.status).toBe(403);
      expect(commit.json.code).toBe('git-dir-outside-project');
      expect(plain(other, ['rev-parse', 'lane'])).toBe(laneHead);
    });

    test("a real .git whose objects, refs and index link into another repository is refused (the reviewer's layout)", async () => {
      const other = otherRepository();
      const otherHead = head(other);
      rmSync(join(project, '.git'), { recursive: true, force: true });
      mkdirSync(join(project, '.git'));
      writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(
        join(project, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n',
      );
      for (const entry of ['objects', 'refs', 'index']) {
        symlinkSync(join(other, '.git', entry), join(project, '.git', entry));
      }
      writeFileSync(join(project, 'member.txt'), 'member payload\n');

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'routine commit',
      });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('git-dir-outside-project');
      expect(head(other)).toBe(otherHead);
    });

    test.each([
      'objects',
      'refs',
      'packed-refs',
      'index',
      'HEAD',
      'logs',
      'config',
      'config.worktree',
      'commondir',
      'worktrees',
      'info',
      'hooks',
      'shallow',
      'modules',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
      'objects/info',
      'objects/pack',
    ])('a linked .git/%s is refused', async (entry) => {
      const other = otherRepository();
      const target = join(project, '.git', entry);
      // Link to the other repository's SAME entry where it has one, so git
      // keeps working through the link and only the containment check can
      // refuse it. `commondir` names that repository (then the common-dir
      // check refuses it too).
      let linkTo = join(other, '.git', entry);
      if (entry === 'commondir') {
        linkTo = join(other, 'commondir-target');
        writeFileSync(linkTo, `${join(other, '.git')}\n`);
      } else if (!existsSync(linkTo)) {
        linkTo = join(other, '.git', 'description');
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(target, '..'), { recursive: true });
      symlinkSync(linkTo, target);
      dirty();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: entry,
      });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('git-dir-outside-project');
    });

    test.each([
      [
        "a loose ref (refs/heads/main) linked to another repository's branch",
        (other: string) =>
          swapForLink(
            join(project, '.git', 'refs', 'heads', 'main'),
            join(other, '.git', 'refs', 'heads', 'main'),
          ),
      ],
      [
        'a linked pack file in a real objects/pack',
        (other: string) =>
          symlinkSync(
            join(other, '.git', 'description'),
            join(
              project,
              '.git',
              'objects',
              'pack',
              'pack-0000000000000000000000000000000000000000.pack',
            ),
          ),
      ],
      [
        'a linked fan-out directory in a real objects',
        (other: string) =>
          symlinkSync(
            join(other, '.git', 'objects'),
            join(project, '.git', 'objects', 'ab'),
          ),
      ],
      [
        'a legacy symbolic-link HEAD (core.preferSymlinkRefs) into its own refs',
        () => swapForLink(join(project, '.git', 'HEAD'), 'refs/heads/main'),
      ],
    ])(
      '%s is refused, and commit and push run no git past the check',
      async (_name, plantLink) => {
        const other = otherRepository();
        for (const hook of ['pre-commit', 'pre-push']) {
          installHook(join(project, '.git', 'hooks'), hook);
        }
        plantLink(other);
        dirty();

        const commit = await post('/git/commit', {
          projectSlug: 'acme',
          message: 'x',
        });
        expect(commit.status).toBe(403);
        expect(commit.json.code).toBe('git-dir-outside-project');
        // The refusal names what it found.
        expect(commit.json.error).toMatch(/\.git\/\S+ is a symbolic link/);
        const push = await post('/git/push', { projectSlug: 'acme' });
        expect(push.status).toBe(403);
        // The operator's own hooks would have run had commit or push got past
        // the check; neither did, and nothing reached the remote.
        expect(ran()).toEqual([]);
        expect(bareHead()).toBe('');
      },
    );

    test('a .git/hooks link that stays inside the Project is allowed (a common layout)', async () => {
      mkdirSync(join(project, 'scripts', 'hooks'), { recursive: true });
      rmSync(join(project, '.git', 'hooks'), { recursive: true, force: true });
      symlinkSync('../scripts/hooks', join(project, '.git', 'hooks'));
      dirty();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'hooks live in the repo',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    });

    test('a .git/hooks link leading outside the Project is refused, and the message names it', async () => {
      const outside = join(root, 'shared-hooks');
      mkdirSync(outside);
      rmSync(join(project, '.git', 'hooks'), { recursive: true, force: true });
      symlinkSync(outside, join(project, '.git', 'hooks'));
      dirty();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'x',
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toContain('.git/hooks is a symbolic link');
    });

    test.each(['alternates', 'http-alternates'])(
      'an objects/info/%s file is refused',
      async (name) => {
        const other = otherRepository();
        writeFileSync(
          join(project, '.git', 'objects', 'info', name),
          `${join(other, '.git', 'objects')}\n`,
        );
        dirty();
        const res = await post('/git/commit', {
          projectSlug: 'acme',
          message: name,
        });
        expect(res.status).toBe(403);
        expect(res.json.code).toBe('git-dir-outside-project');
      },
    );

    test('a genuine linked worktree as the Project folder is accepted', async () => {
      const main = join(root, 'main-checkout');
      plain(root, [
        'clone',
        '-q',
        '--no-local',
        '-c',
        'protocol.file.allow=always',
        project,
        main,
      ]);
      rmSync(project, { recursive: true, force: true });
      plain(main, ['worktree', 'add', '-q', '-b', 'lane', project]);
      dirty();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'in a worktree',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(plain(main, ['log', '-1', '--format=%s', 'lane'])).toBe(
        'in a worktree',
      );
    });

    test('commits the Project folder, and a repository inside it the toolbar selected', async () => {
      const nested = join(project, 'packages', 'inner');
      mkdirSync(nested, { recursive: true });
      plain(nested, ['init', '-q', '-b', 'main']);
      writeFileSync(join(nested, 'a.txt'), 'a\n');

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        path: nested,
        message: 'inner',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(plain(nested, ['log', '-1', '--format=%s'])).toBe('inner');
    });

    test('a path outside the Project is refused, and that repository is untouched', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      plain(outside, ['init', '-q', '-b', 'main']);
      writeFileSync(join(outside, 'a.txt'), 'a\n');

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        path: outside,
        message: 'outside',
      });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('outside-project');
      expect(plain(outside, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toBe(
        '',
      );
    });

    test('a symbolic link inside the Project that leads outside is refused', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      plain(outside, ['init', '-q', '-b', 'main']);
      writeFileSync(join(outside, 'a.txt'), 'a\n');
      execFileSync('ln', ['-s', outside, join(project, 'link')]);

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        path: join(project, 'link'),
        message: 'via link',
      });
      expect(res.status).toBe(403);
      expect(plain(outside, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toBe(
        '',
      );
    });

    test('a request without a Project, or for an unknown one, is refused', async () => {
      dirty();
      const before = head();
      const missing = await post('/git/commit', {
        path: project,
        message: 'no project',
      });
      expect(missing.status).toBe(400);
      const unknown = await post('/git/commit', {
        projectSlug: 'nope',
        path: project,
        message: 'unknown project',
      });
      expect(unknown.status).toBe(409);
      expect(unknown.json.code).toBe('no-working-directory');
      expect(head()).toBe(before);
    });

    test('a non-operator is refused commit and push', async () => {
      dirty();
      const before = head();
      const commit = await post(
        '/git/commit',
        { projectSlug: 'acme', message: 'not mine' },
        'collaborator',
      );
      expect(commit.status).toBe(403);
      const push = await post(
        '/git/push',
        { projectSlug: 'acme' },
        'collaborator',
      );
      expect(push.status).toBe(403);
      expect(head()).toBe(before);
      expect(bareHead()).toBe('');
    });

    test('.env and a file holding a PEM private key are refused by name, and nothing is staged', async () => {
      writeFileSync(join(project, '.env'), 'TOKEN=abc\n');
      writeFileSync(
        join(project, 'notes.txt'),
        `notes\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n`,
      );
      writeFileSync(join(project, 'fine.txt'), 'fine\n');
      const before = head();

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'secrets',
      });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('secrets');
      expect(res.json.files).toEqual([
        { path: '.env', reason: 'environment file' },
        { path: 'notes.txt', reason: 'contains a private key' },
      ]);
      expect(res.json.error).toContain('.env');
      expect(res.json.error).toContain('notes.txt');
      expect(head()).toBe(before);
      expect(plain(project, ['diff', '--cached', '--name-only'])).toBe('');
    });

    test('deleting a tracked secret-looking file is not refused', async () => {
      writeFileSync(join(project, '.env'), 'TOKEN=abc\n');
      plain(project, ['add', '-f', '.env']);
      plain(project, ['commit', '-q', '-m', 'oops']);
      rmSync(join(project, '.env'));

      const res = await post('/git/commit', {
        projectSlug: 'acme',
        message: 'remove the secret',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(plain(project, ['ls-files', '.env'])).toBe('');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'coding git routes: push (#2363)',
  () => {
    test('pushes the current branch to the validated URL and records the upstream', async () => {
      const res = await post('/git/push', {
        projectSlug: 'acme',
        setUpstream: true,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.data.remote).toBe('origin');
      expect(bareHead()).toBe(head());
      expect(plain(project, ['rev-parse', 'origin/main'])).toBe(head());
      expect(plain(project, ['config', 'branch.main.remote'])).toBe('origin');
      expect(plain(project, ['config', 'branch.main.merge'])).toBe(
        'refs/heads/main',
      );
    });

    test.each([
      ['ext::sh -c touch% /tmp/station-2363-pwned', 'remote-malformed'],
      ['ext::sh', 'remote-unsupported-transport'],
      ['file:///tmp/station-2363.git', 'remote-unsupported-transport'],
      ['/tmp/station-2363.git', 'remote-unsupported-transport'],
      ['-oProxyCommand=id', 'remote-unsupported-transport'],
      [
        'https://user:secret@git.example.test/acme/pulse.git',
        'remote-credentials-in-url',
      ],
      ['https://127.0.0.1/acme/pulse.git', 'remote-local-host'],
      ['git@localhost:acme/pulse.git', 'remote-local-host'],
    ])(
      'refuses a remote of %j as %s, and pushes nothing',
      async (url, code) => {
        plain(project, ['config', 'remote.origin.url', url]);

        const res = await post('/git/push', { projectSlug: 'acme' });
        expect(res.status).toBe(409);
        expect(res.json.code).toBe(code);
        expect(res.json.error).not.toContain('secret');
        expect(bareHead()).toBe('');
      },
    );

    test('the pre-push hook runs on the operator push (as in a terminal)', async () => {
      installHook(join(project, '.git', 'hooks'), 'pre-push');
      const res = await post('/git/push', { projectSlug: 'acme' });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(ran()).toEqual(['pre-push']);
      expect(bareHead()).toBe(head());
    });

    test('a remote NAMED by the validated address cannot redirect the push', async () => {
      const evil = join(root, 'evil.git');
      plain(root, ['init', '-q', '--bare', evil]);
      plain(project, [
        'config',
        `remote.${REMOTE_URL}.pushurl`,
        `file://${evil}`,
      ]);

      const res = await post('/git/push', { projectSlug: 'acme' });
      expect(res.status).toBe(409);
      expect(res.json.keys).toEqual([`remote.${REMOTE_URL}.pushurl`]);
      expect(
        plain(evil, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']),
      ).toBe('');
      expect(bareHead()).toBe('');
    });

    test('a remote nickname with a slash (team/fork) is an ordinary remote and pushes', async () => {
      plain(project, ['remote', 'add', 'team/fork', REMOTE_URL]);
      const res = await post('/git/push', {
        projectSlug: 'acme',
        remote: 'team/fork',
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(bareHead()).toBe(head());
    });

    test('an option-looking remote name or branch is refused as a bad request', async () => {
      const name = await post('/git/push', {
        projectSlug: 'acme',
        remote: '--receive-pack=touch /tmp/x',
      });
      expect(name.status).toBe(400);
      expect(name.json.code).toBe('invalid-remote-name');
      const branch = await post('/git/push', {
        projectSlug: 'acme',
        branch: '--force',
      });
      expect(branch.status).toBe(400);
      expect(branch.json.code).toBe('invalid-branch');
      expect(bareHead()).toBe('');
    });
  },
);
