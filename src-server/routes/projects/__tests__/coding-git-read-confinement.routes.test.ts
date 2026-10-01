/**
 * The coding git READ routes (status, log, diff, branches, repos) over the
 * real handlers and real git.
 *
 * A Project's folders are member-writable, and git discovers its repository
 * from the folder it runs in. Each plant below makes plain git in a Project
 * folder read ANOTHER repository of the host's; that is asserted first (a
 * green result must not come from a plant that never fires), and then the
 * route is driven and must answer with nothing of that repository's.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { createCodingRoutes } from '../coding.js';

const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT';
const OUTSIDE_BRANCH = 'outside-only-branch';
const OUTSIDE_SUBJECT = 'outside-only-commit-subject';
const OUTSIDE_AUTHOR = 'Outside Only Author';

const READ_ROUTES = ['status', 'log', 'diff', 'branches', 'repos'] as const;
type ReadRoute = (typeof READ_ROUTES)[number];

const makeTempDir = trackTempDirs();
let root: string;
/** The Project's working directory, as the routes resolve slug `acme`. */
let project: string;

/** Plain git, NOT Station's runner. Throws when git fails. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    windowsHide: true,
  }).trim();
}

/** A repository at `dir` on `branch` holding `files` in one commit. */
function repo(
  dir: string,
  files: Record<string, string>,
  { branch = 'main', subject = 'initial', author = 'Station Operator' } = {},
): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, ['add', '-A']);
  git(dir, [
    'commit',
    '-q',
    `--author=${author} <author@station.test>`,
    '-m',
    subject,
  ]);
  return dir;
}

/** The operator's other repository, outside the Project. */
function outsideRepository(): string {
  return repo(
    join(root, 'operator-other'),
    { 'secret.txt': `${SECRET}\n` },
    {
      branch: OUTSIDE_BRANCH,
      subject: OUTSIDE_SUBJECT,
      author: OUTSIDE_AUTHOR,
    },
  );
}

function app() {
  return createCodingRoutes({} as unknown as FileTreeService, {
    resolveProjectFolder: (slug) => (slug === 'acme' ? project : undefined),
  });
}

async function read(route: ReadRoute, path: string) {
  const res = await app().request(
    `${route === 'repos' ? '/repos' : `/git/${route}`}?projectSlug=acme&path=${encodeURIComponent(path)}`,
  );
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

/** Nothing of the outside repository, and no host path, in a response. */
function expectNothingFromOutside(text: string, outsideHead: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(OUTSIDE_BRANCH);
  expect(text).not.toContain(OUTSIDE_SUBJECT);
  expect(text).not.toContain(OUTSIDE_AUTHOR);
  expect(text).not.toContain(outsideHead.slice(0, 7));
}

/**
 * What a refused folder answers. Status, log, diff and branches refuse the
 * request; the repository listing still lists the folder, without a branch.
 */
function expectRefused(
  route: ReadRoute,
  response: Awaited<ReturnType<typeof read>>,
): void {
  if (route === 'repos') {
    expect(response.status).toBe(200);
    expect(response.json.data.repos).toHaveLength(1);
    expect(response.json.data.repos[0].branch).toBe('');
    return;
  }
  expect(response.status).toBe(409);
  expect(response.json.success).toBe(false);
  expect(response.json.code).toBe('git-dir-outside-project');
  // The reason names entries relative to `.git`, never where they lead.
  expect(response.text).not.toContain(root);
}

beforeEach(() => {
  root = realpathSync(makeTempDir('station-coding-git-read-'));
  const global = join(root, 'global.gitconfig');
  writeFileSync(
    global,
    '[user]\n\tname = Station Operator\n\temail = operator@station.test\n',
  );
  writeFileSync(join(root, 'system.gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_SYSTEM', join(root, 'system.gitconfig'));
  project = join(root, 'project');
  return () => vi.unstubAllEnvs();
});

/**
 * Each plant turns `<project>/sub` into a folder where plain git reads the
 * outside repository. Returns the planted folder and the outside HEAD.
 */
const PLANTS: Record<string, () => { folder: string; outsideHead: string }> = {
  'a .git FILE naming an outside repository': () => {
    const outside = outsideRepository();
    repo(project, { 'README.md': '# project\n' });
    const folder = join(project, 'sub');
    mkdirSync(folder);
    writeFileSync(join(folder, '.git'), `gitdir: ${join(outside, '.git')}\n`);
    return { folder, outsideHead: git(outside, ['rev-parse', 'HEAD']) };
  },
  'a symlinked .git': () => {
    const outside = outsideRepository();
    repo(project, { 'README.md': '# project\n' });
    const folder = join(project, 'sub');
    mkdirSync(folder);
    symlinkSync(join(outside, '.git'), join(folder, '.git'));
    return { folder, outsideHead: git(outside, ['rev-parse', 'HEAD']) };
  },
  "alternates borrowing an outside repository's objects": () => {
    const outside = outsideRepository();
    const outsideHead = git(outside, ['rev-parse', 'HEAD']);
    repo(project, { 'README.md': '# project\n' });
    const folder = join(project, 'sub');
    mkdirSync(folder);
    // A real git directory of the member's own, whose objects are the
    // outside repository's and whose branch and index name its commit.
    git(folder, ['init', '-q', '-b', OUTSIDE_BRANCH]);
    writeFileSync(
      join(folder, '.git', 'objects', 'info', 'alternates'),
      `${join(outside, '.git', 'objects')}\n`,
    );
    git(folder, ['update-ref', `refs/heads/${OUTSIDE_BRANCH}`, outsideHead]);
    git(folder, ['read-tree', 'HEAD']);
    return { folder, outsideHead };
  },
  "loose objects linked one by one to an outside repository's": () =>
    linkedObjects((outsideObject, ownObject) => {
      mkdirSync(dirname(ownObject), { recursive: true });
      symlinkSync(outsideObject, ownObject);
    }),
  "fan-out directories linked to an outside repository's": () =>
    linkedObjects((outsideObject, ownObject) => {
      if (!existsSync(dirname(ownObject))) {
        symlinkSync(dirname(outsideObject), dirname(ownObject));
      }
    }),
};

/**
 * `<project>/sub` as a real git directory of the member's own whose branch
 * and index name the outside repository's commit, with each object that
 * commit needs (the commit, its tree, the file) reached through `link`.
 */
function linkedObjects(
  link: (outsideObject: string, ownObject: string) => void,
): { folder: string; outsideHead: string } {
  const outside = outsideRepository();
  const outsideHead = git(outside, ['rev-parse', 'HEAD']);
  repo(project, { 'README.md': '# project\n' });
  const folder = join(project, 'sub');
  mkdirSync(folder);
  git(folder, ['init', '-q', '-b', OUTSIDE_BRANCH]);
  for (const object of [
    outsideHead,
    git(outside, ['rev-parse', 'HEAD^{tree}']),
    git(outside, ['rev-parse', 'HEAD:secret.txt']),
  ]) {
    const path = join('.git', 'objects', object.slice(0, 2), object.slice(2));
    link(join(outside, path), join(folder, path));
  }
  git(folder, ['update-ref', `refs/heads/${OUTSIDE_BRANCH}`, outsideHead]);
  git(folder, ['read-tree', 'HEAD']);
  return { folder, outsideHead };
}

describe.skipIf(process.platform === 'win32')(
  'coding git reads: a planted .git that leads to another repository',
  () => {
    describe.each(Object.keys(PLANTS))('%s', (name) => {
      test('control: plain git in that folder reads the outside repository', () => {
        const { folder, outsideHead } = PLANTS[name]();
        expect(git(folder, ['rev-parse', 'HEAD'])).toBe(outsideHead);
        expect(git(folder, ['log', '-1', '--format=%an|%s'])).toBe(
          `${OUTSIDE_AUTHOR}|${OUTSIDE_SUBJECT}`,
        );
        expect(git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
          OUTSIDE_BRANCH,
        );
        expect(git(folder, ['branch', '--format=%(refname:short)'])).toContain(
          OUTSIDE_BRANCH,
        );
        // The tracked file is absent from this folder, so its content shows
        // as a deletion.
        expect(git(folder, ['status', '--porcelain'])).toContain('secret.txt');
        expect(git(folder, ['diff'])).toContain(`-${SECRET}`);
      });

      test.each(READ_ROUTES)('%s answers with nothing of it', async (route) => {
        const { folder, outsideHead } = PLANTS[name]();

        const response = await read(route, folder);

        expectRefused(route, response);
        expectNothingFromOutside(response.text, outsideHead);
      });
    });

    describe('a planted repository whose core.worktree steers discovery above the Project', () => {
      const OPERATOR_BRANCH = 'operator-only-branch';
      const OPERATOR_SUBJECT = 'operator-only-commit-subject';
      const PLANTED_BRANCH = 'planted-branch';

      /**
       * The operator's repository holds a file at the path the Project's
       * folder would have if the work tree started one folder too high. A
       * member-written repository inside the Project claims that higher
       * folder as its work tree, so discovery from it lands above the
       * Project, where a read is otherwise allowed.
       */
      function plantAbove(): { folder: string; above: string } {
        const higher = repo(
          join(root, 'higher'),
          { 'proj/sub/secret.txt': `${SECRET}\n` },
          { branch: OPERATOR_BRANCH, subject: OPERATOR_SUBJECT },
        );
        const above = join(higher, 'a');
        project = join(above, 'proj');
        // The member's own repository, with a branch of its own, so every
        // route has something to report if it reads this pairing.
        const folder = repo(
          join(project, 'sub'),
          { 'own.txt': 'own\n' },
          { branch: PLANTED_BRANCH },
        );
        git(folder, ['config', 'core.worktree', above]);
        return { folder, above };
      }

      test('control: plain git in that folder reports a work tree above the Project', () => {
        const { folder, above } = plantAbove();
        expect(git(folder, ['rev-parse', '--show-toplevel'])).toBe(above);
      });

      test.each(READ_ROUTES)('%s refuses it', async (route) => {
        const { folder } = plantAbove();

        const response = await read(route, folder);

        expectRefused(route, response);
        expect(response.text).not.toContain(SECRET);
        expect(response.text).not.toContain(OPERATOR_BRANCH);
        expect(response.text).not.toContain(OPERATOR_SUBJECT);
        expect(response.text).not.toContain(PLANTED_BRANCH);
      });
    });

    test('a `.git` flipped between the member’s own repository and a link to an outside one never leaks it', async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      repo(project, { 'README.md': '# project\n' });
      const folder = repo(
        join(project, 'sub'),
        { 'own.txt': 'own\n' },
        { subject: 'member work' },
      );
      writeFileSync(
        join(folder, '.git-file'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      // Both states are live: the member's own repository, then the link.
      expect(git(folder, ['log', '-1', '--format=%s'])).toBe('member work');
      renameSync(join(folder, '.git'), join(folder, '.git-real'));
      renameSync(join(folder, '.git-file'), join(folder, '.git'));
      expect(git(folder, ['log', '-1', '--format=%s'])).toBe(OUTSIDE_SUBJECT);
      expect(git(folder, ['diff'])).toContain(`-${SECRET}`);
      renameSync(join(folder, '.git'), join(folder, '.git-file'));
      renameSync(join(folder, '.git-real'), join(folder, '.git'));

      const flips = join(root, 'flips');
      const flipper = spawn(
        'sh',
        [
          '-c',
          `i=0; while :; do
             mv .git .git-real && mv .git-file .git
             mv .git .git-file && mv .git-real .git
             i=$((i+1)); echo $i > '${flips}'
           done`,
        ],
        { cwd: folder, stdio: 'ignore' },
      );
      const answers: Record<string, number> = {};
      try {
        for (let request = 0; request < 25; request += 1) {
          for (const route of ['diff', 'log', 'status', 'branches'] as const) {
            const response = await read(route, folder);
            expectNothingFromOutside(response.text, outsideHead);
            answers[response.status] = (answers[response.status] ?? 0) + 1;
          }
        }
      } finally {
        flipper.kill('SIGKILL');
      }
      // The flipper really ran against these requests.
      expect(Number(readFileSync(flips, 'utf-8'))).toBeGreaterThan(50);
      expect(
        Object.keys(answers).length,
        JSON.stringify(answers),
      ).toBeGreaterThan(0);
    }, 180_000);

    describe('a planted partial clone whose missing object would be fetched', () => {
      test.each(READ_ROUTES)(
        '%s runs no credential helper and connects nowhere',
        async (route) => {
          let connections = 0;
          const server = createServer((socket) => {
            connections += 1;
            socket.destroy();
          });
          await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
          );
          const { port } = server.address() as { port: number };
          const marker = join(root, 'helper-ran');
          try {
            repo(project, { 'README.md': '# project\n' });
            const blob = git(project, ['rev-parse', 'HEAD:README.md']);
            writeFileSync(join(project, 'README.md'), '# edited\n');
            rmSync(
              join(project, '.git', 'objects', blob.slice(0, 2), blob.slice(2)),
            );
            for (const [key, value] of [
              ['core.repositoryformatversion', '1'],
              ['extensions.partialClone', 'origin'],
              ['remote.origin.promisor', 'true'],
              ['remote.origin.url', `https://u@127.0.0.1:${port}/x.git`],
              ['http.proactiveAuth', 'basic'],
              [
                'credential.helper',
                `!touch '${marker}'; echo username=u; echo password=p`,
              ],
            ]) {
              git(project, ['config', key, value]);
            }

            const response = await read(route, project);
            await new Promise((resolve) => setTimeout(resolve, 150));

            expect(existsSync(marker), 'the planted helper ran').toBe(false);
            expect(connections).toBe(0);
            if (route !== 'repos') {
              expect(response.status).toBe(409);
              expect(response.json.code).toBe('repository-config-refused');
              expect(response.json.keys).toEqual(
                expect.arrayContaining([
                  'credential.helper',
                  'extensions.partialclone',
                  'remote.origin.promisor',
                ]),
              );
            }

            // Control, last (it creates the marker): plain git does both.
            await new Promise<void>((resolve) => {
              spawn('git', ['diff'], { cwd: project, stdio: 'ignore' }).on(
                'close',
                () => resolve(),
              );
            });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(existsSync(marker), 'control: plain git runs it').toBe(true);
            expect(connections, 'control: plain git connects').toBeGreaterThan(
              0,
            );
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
    });

    test("a .git planted at the Project's root does not make an outside repository's checkout a readable worktree", async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      mkdirSync(project);
      writeFileSync(
        join(project, '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      // Live: from the Project's folder, git lists the outside checkout as
      // a worktree of "its" repository.
      expect(git(project, ['worktree', 'list', '--porcelain'])).toContain(
        `worktree ${outside}`,
      );

      for (const route of READ_ROUTES) {
        const response = await read(route, outside);
        expectRefused(route, response);
        expectNothingFromOutside(response.text, outsideHead);
      }
    });

    test('a planted .git inside a registered session worktree is not read', async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      repo(project, { 'README.md': '# project\n' });
      const session = join(root, 'sessions', 'one');
      git(project, ['worktree', 'add', '-q', '-b', 'session-one', session]);
      const folder = join(session, 'sub');
      mkdirSync(folder);
      writeFileSync(join(folder, '.git'), `gitdir: ${join(outside, '.git')}\n`);
      expect(git(folder, ['rev-parse', 'HEAD'])).toBe(outsideHead);

      for (const route of READ_ROUTES) {
        const response = await read(route, folder);
        expect(response.status, route).toBe(200);
        expectNothingFromOutside(response.text, outsideHead);
      }
      expect((await read('status', folder)).json.data).toEqual({
        isRepo: false,
      });
    });

    test('a session worktree is not read while the Project repository borrows outside objects', async () => {
      const outside = outsideRepository();
      repo(project, { 'README.md': '# project\n' });
      const session = join(root, 'sessions', 'one');
      git(project, ['worktree', 'add', '-q', '-b', 'session-one', session]);
      expect((await read('log', session)).status).toBe(200);
      writeFileSync(
        join(project, '.git', 'objects', 'info', 'alternates'),
        `${join(outside, '.git', 'objects')}\n`,
      );

      for (const route of ['status', 'log', 'diff', 'branches'] as const) {
        const response = await read(route, session);
        expect(response.status, route).toBe(409);
        expect(response.json.code).toBe('git-dir-outside-project');
      }
    });
  },
);

describe('coding git reads: repositories that are the Project’s own', () => {
  /** Every read route against `folder`, a checkout on `branch`. */
  async function expectReads(
    folder: string,
    expected: { top: string; branch: string; subject: string; change: string },
  ): Promise<void> {
    const status = await read('status', folder);
    expect(status.status).toBe(200);
    expect(status.json.data).toMatchObject({
      isRepo: true,
      repoRoot: expected.top,
      branch: expected.branch,
      lastCommit: { message: expected.subject },
    });
    expect(status.json.data.changes.join('\n')).toContain(expected.change);

    const log = await read('log', folder);
    expect(log.status).toBe(200);
    expect(log.json.data[0].message).toBe(expected.subject);

    const diff = await read('diff', folder);
    expect(diff.status).toBe(200);
    expect(diff.json.data.diff).toContain(`b/${expected.change}`);

    const branches = await read('branches', folder);
    expect(branches.status).toBe(200);
    expect(branches.json.data).toContainEqual(
      expect.objectContaining({ name: expected.branch, current: true }),
    );
  }

  test('an ordinary repository', async () => {
    repo(project, { 'README.md': '# project\n' }, { subject: 'project work' });
    writeFileSync(join(project, 'README.md'), '# project, edited\n');
    mkdirSync(join(project, 'src'));

    const expected = {
      top: project,
      branch: 'main',
      subject: 'project work',
      change: 'README.md',
    };
    await expectReads(project, expected);
    // A folder inside it reads the same repository.
    await expectReads(join(project, 'src'), expected);
    expect((await read('repos', project)).json.data).toMatchObject({
      workspaceIsRepo: true,
      repos: [{ root: project, relativePath: '.', branch: 'main' }],
    });
  });

  test('a nested repository inside a multi-repo Project', async () => {
    const alpha = repo(
      join(project, 'alpha'),
      { 'a.txt': 'a\n' },
      { branch: 'alpha-branch', subject: 'alpha work' },
    );
    repo(
      join(project, 'beta'),
      { 'b.txt': 'b\n' },
      { branch: 'beta-branch', subject: 'beta work' },
    );
    writeFileSync(join(alpha, 'a.txt'), 'a, edited\n');

    // The Project's folder itself is not a repository.
    expect((await read('status', project)).json.data).toEqual({
      isRepo: false,
    });
    expect((await read('log', project)).json.data).toEqual([]);
    expect((await read('diff', project)).json.data).toEqual({ diff: '' });
    expect((await read('branches', project)).json.data).toEqual([]);

    await expectReads(alpha, {
      top: alpha,
      branch: 'alpha-branch',
      subject: 'alpha work',
      change: 'a.txt',
    });
    const repos = (await read('repos', project)).json.data.repos;
    expect(
      repos
        .map((row: { name: string; branch: string }) => [row.name, row.branch])
        .sort(),
    ).toEqual([
      ['alpha', 'alpha-branch'],
      ['beta', 'beta-branch'],
    ]);
  });

  test('a Project that is a genuine linked worktree of a repository elsewhere', async () => {
    const main = repo(join(root, 'main-checkout'), { 'README.md': '# main\n' });
    git(main, ['worktree', 'add', '-q', '-b', 'linked-branch', project]);
    writeFileSync(join(project, 'README.md'), '# linked, edited\n');

    await expectReads(project, {
      top: project,
      branch: 'linked-branch',
      subject: 'initial',
      change: 'README.md',
    });
    expect((await read('repos', project)).json.data.repos).toMatchObject([
      { root: project, branch: 'linked-branch' },
    ]);
  });

  test('a registered session worktree beside the Project', async () => {
    repo(project, { 'README.md': '# project\n' }, { subject: 'project work' });
    const session = join(root, 'sessions', 'one');
    git(project, ['worktree', 'add', '-q', '-b', 'session-one', session]);
    writeFileSync(join(session, 'README.md'), '# session, edited\n');

    await expectReads(session, {
      top: session,
      branch: 'session-one',
      subject: 'project work',
      change: 'README.md',
    });
    expect((await read('repos', session)).json.data.repos).toMatchObject([
      { root: session, branch: 'session-one' },
    ]);
  });

  test('the repository that contains the Project from above', async () => {
    const mono = repo(
      join(root, 'mono'),
      { 'packages/app/index.ts': 'export {};\n' },
      { branch: 'mono-branch', subject: 'mono work' },
    );
    project = join(mono, 'packages', 'app');
    writeFileSync(join(project, 'index.ts'), 'export const edited = 1;\n');

    const expected = {
      top: mono,
      branch: 'mono-branch',
      subject: 'mono work',
      change: 'packages/app/index.ts',
    };
    await expectReads(project, expected);
    // And the repository root itself, which a Task's workspace names.
    await expectReads(mono, expected);
  });
});
