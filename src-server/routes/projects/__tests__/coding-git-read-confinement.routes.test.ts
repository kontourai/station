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
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { CheckpointRefStore } from '../../../services/checkpoints/checkpoint-ref-store.js';
import { GitReviewWorkspaceSource } from '../../../services/evidence/git-review-workspace-source.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { gitDirectoryInsideProject } from '../../../services/projects/git-directory-confinement.js';
import { readProjectRepository } from '../../../services/projects/git-read-repository.js';
import { WorktreeProvisioningService } from '../../../services/projects/worktree-provisioning-service.js';
import { execGit } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT';
const OUTSIDE_BRANCH = 'outside-only-branch';
const OUTSIDE_SUBJECT = 'outside-only-commit-subject';
const OUTSIDE_AUTHOR = 'Outside Only Author';
/** A second branch of the outside repository, holding one more file. */
const OUTSIDE_SIDE_BRANCH = `${OUTSIDE_BRANCH}-side`;
const SIDE_SECRET = 'SIDE-BRANCH-SECRET-CONTENT';

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
  const outside = repo(
    join(root, 'operator-other'),
    { 'secret.txt': `${SECRET}\n` },
    {
      branch: OUTSIDE_BRANCH,
      subject: OUTSIDE_SUBJECT,
      author: OUTSIDE_AUTHOR,
    },
  );
  git(outside, ['checkout', '-q', '-b', OUTSIDE_SIDE_BRANCH]);
  writeFileSync(join(outside, 'side-secret.txt'), `${SIDE_SECRET}\n`);
  git(outside, ['add', '-A']);
  git(outside, ['commit', '-q', '-m', 'side']);
  git(outside, ['checkout', '-q', OUTSIDE_BRANCH]);
  return outside;
}

/** The routes, called by the operator in person (so `/exec` is allowed). */
function app() {
  const mounted = new Hono();
  mounted.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'credential',
      credential: 'operator',
      authority: 'operator-credential',
      source: 'bearer',
    });
    bindRuntimeLocalOperator(c.req.raw);
    await next();
  });
  mounted.route(
    '/',
    createCodingRoutes(new FileTreeService(), {
      resolveProjectFolder: (slug) => (slug === 'acme' ? project : undefined),
      // Commit is the operator's act; these requests are the operator's.
      visibility: {
        resolvePrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          kind: 'human',
          display: 'Operator',
        }),
      },
    }),
  );
  return mounted;
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectSlug: 'acme', ...body }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

/** The outside repository's branch, branch list and HEAD commit. */
function outsideState(outside: string): string {
  return [
    git(outside, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(outside, ['for-each-ref', '--format=%(refname) %(objectname)']),
    git(outside, ['status', '--porcelain']),
  ].join('\n');
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
             i=$((i+1)); echo $i > '${flips}.next' && mv '${flips}.next' '${flips}'
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
      // The flipper really alternated under these requests (each response
      // was checked for the outside repository's markers as it arrived).
      expect(Number(readFileSync(flips, 'utf-8'))).toBeGreaterThan(50);
      // Both states were served: the member's own repository was read, and
      // the link was refused.
      expect(answers['200'] ?? 0, JSON.stringify(answers)).toBeGreaterThan(0);
      expect(answers['409'] ?? 0, JSON.stringify(answers)).toBeGreaterThan(0);
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
              // The helper is what is refused; being a partial clone is not.
              expect(response.json.keys).toEqual(['credential.helper']);
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

    test('a partial clone with no helper of its own is read, and a read needing an unfetched object says so without fetching', async () => {
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as { port: number };
      try {
        repo(project, { 'README.md': '# project\n' }, { subject: 'cloned' });
        const blob = git(project, ['rev-parse', 'HEAD:README.md']);
        writeFileSync(join(project, 'README.md'), '# edited\n');
        rmSync(
          join(project, '.git', 'objects', blob.slice(0, 2), blob.slice(2)),
        );
        for (const [key, value] of [
          ['core.repositoryformatversion', '1'],
          ['extensions.partialClone', 'origin'],
          ['remote.origin.promisor', 'true'],
          ['remote.origin.partialclonefilter', 'blob:none'],
          ['remote.origin.url', `https://127.0.0.1:${port}/x.git`],
        ]) {
          git(project, ['config', key, value]);
        }

        const status = await read('status', project);
        expect(status.status).toBe(200);
        expect(status.json.data).toMatchObject({
          isRepo: true,
          branch: 'main',
          lastCommit: { message: 'cloned' },
        });
        expect((await read('log', project)).json.data[0].message).toBe(
          'cloned',
        );
        expect((await read('branches', project)).status).toBe(200);
        // The diff needs the committed file, which is not here.
        const diff = await read('diff', project);
        expect(diff.status).toBe(409);
        expect(diff.json.code).toBe('object-not-available');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(connections).toBe(0);

        // Control: plain git fetches it (and so connects).
        await new Promise<void>((resolve) => {
          spawn('git', ['diff'], { cwd: project, stdio: 'ignore' }).on(
            'close',
            () => resolve(),
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(connections, 'control: plain git connects').toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    describe('checkout through a planted .git', () => {
      test.each([
        'a .git FILE naming an outside repository',
        'a symlinked .git',
      ])(
        'control: with %s, plain git checkout moves the outside repository and writes its files here',
        (name) => {
          const { folder } = PLANTS[name]();
          const outside = join(root, 'operator-other');
          git(folder, ['checkout', '-q', '-f', OUTSIDE_SIDE_BRANCH]);
          expect(git(outside, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
            OUTSIDE_SIDE_BRANCH,
          );
          expect(readFileSync(join(folder, 'side-secret.txt'), 'utf-8')).toBe(
            `${SIDE_SECRET}\n`,
          );
        },
      );

      test.each(Object.keys(PLANTS))(
        '%s: checkout is refused and the outside repository is untouched',
        async (name) => {
          const { folder } = PLANTS[name]();
          const outside = join(root, 'operator-other');
          const before = outsideState(outside);

          for (const body of [
            { branch: OUTSIDE_SIDE_BRANCH },
            { branch: OUTSIDE_BRANCH },
            { branch: 'made-by-member', create: true },
          ]) {
            const response = await post('/git/checkout', {
              path: folder,
              ...body,
            });
            expect(response.status, JSON.stringify(body)).toBe(409);
            expect(response.json.code).toBe('git-dir-outside-project');
            expect(response.text).not.toContain(root);
          }

          expect(outsideState(outside)).toBe(before);
          expect(existsSync(join(folder, 'secret.txt'))).toBe(false);
          expect(existsSync(join(folder, 'side-secret.txt'))).toBe(false);
        },
      );

      test('a planted repository whose core.worktree names a folder above the Project: checkout writes nothing there', async () => {
        const higher = repo(join(root, 'higher'), {
          'README.md': '# higher\n',
        });
        const above = join(higher, 'a');
        project = join(above, 'proj');
        // The member's own repository, with a branch holding one more file.
        const folder = repo(join(project, 'sub'), { 'own.txt': 'own\n' });
        git(folder, ['checkout', '-q', '-b', 'escape']);
        writeFileSync(join(folder, 'escape.txt'), 'escaped\n');
        git(folder, ['add', '-A']);
        git(folder, ['commit', '-q', '-m', 'escape']);
        git(folder, ['checkout', '-q', 'main']);
        git(folder, ['config', 'core.worktree', above]);

        const response = await post('/git/checkout', {
          path: folder,
          branch: 'escape',
        });

        expect(response.status).toBe(409);
        expect(response.json.code).toBe('git-dir-outside-project');
        expect(existsSync(join(above, 'escape.txt'))).toBe(false);
        expect(git(folder, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');

        // Control, last: plain git writes the branch's file above the Project.
        git(folder, ['checkout', '-q', '-f', 'escape']);
        expect(existsSync(join(above, 'escape.txt'))).toBe(true);
      });

      test('an ordinary repository, a session worktree and a repository above the Project still check out', async () => {
        repo(project, { 'README.md': '# project\n' });
        git(project, ['branch', 'feature']);
        const session = join(root, 'sessions', 'one');
        git(project, ['worktree', 'add', '-q', '-b', 'session-one', session]);

        const switched = await post('/git/checkout', {
          path: project,
          branch: 'feature',
        });
        expect(switched.status, switched.text).toBe(200);
        expect(switched.json.data.branch).toBe('feature');
        expect(git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
          'feature',
        );
        const created = await post('/git/checkout', {
          path: session,
          branch: 'session-two',
          create: true,
        });
        expect(created.status, created.text).toBe(200);
        expect(git(session, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
          'session-two',
        );

        const mono = repo(join(root, 'mono'), {
          'packages/app/index.ts': 'export {};\n',
        });
        git(mono, ['branch', 'mono-feature']);
        project = join(mono, 'packages', 'app');
        const inMono = await post('/git/checkout', {
          path: project,
          branch: 'mono-feature',
        });
        expect(inMono.status, inMono.text).toBe(200);
        expect(git(mono, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
          'mono-feature',
        );
      });
    });

    describe("a .git planted at the Project's root, naming an outside repository", () => {
      /** Returns the outside repository, which git now lists as a worktree. */
      function plantAtRoot(): string {
        const outside = outsideRepository();
        mkdirSync(project);
        writeFileSync(
          join(project, '.git'),
          `gitdir: ${join(outside, '.git')}\n`,
        );
        // Live: from the Project's folder, git lists the outside checkout
        // as a worktree of "its" repository.
        expect(git(project, ['worktree', 'list', '--porcelain'])).toContain(
          `worktree ${outside}`,
        );
        return outside;
      }

      test('no file route or command reaches that repository', async () => {
        const outside = plantAtRoot();
        const before = outsideState(outside);
        const refusals = [
          await read('status', outside),
          await (async () => {
            const res = await app().request(
              `/files/content?projectSlug=acme&path=${encodeURIComponent(outside)}&file=secret.txt`,
            );
            const text = await res.text();
            return { status: res.status, text, json: JSON.parse(text) as any };
          })(),
          await (async () => {
            const res = await app().request(
              `/files?projectSlug=acme&path=${encodeURIComponent(outside)}`,
            );
            const text = await res.text();
            return { status: res.status, text, json: JSON.parse(text) as any };
          })(),
          await post('/files/create', {
            path: outside,
            target: 'planted.txt',
            type: 'file',
          }),
          await post('/files/rename', {
            path: outside,
            from: 'secret.txt',
            to: 'moved.txt',
          }),
          await post('/files/delete', { path: outside, target: 'secret.txt' }),
          await post('/git/checkout', {
            path: outside,
            branch: OUTSIDE_SIDE_BRANCH,
          }),
          await post('/exec', { cwd: outside, command: 'touch ran-here' }),
        ];

        for (const refusal of refusals) {
          expect(refusal.status, refusal.text).toBe(403);
          expect(refusal.json.code).toBe('outside-project');
          expect(refusal.text).not.toContain(SECRET);
        }
        expect(outsideState(outside)).toBe(before);
        expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
        expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
        expect(existsSync(join(outside, 'ran-here'))).toBe(false);
      });

      test.each(READ_ROUTES)(
        '%s of that repository is refused',
        async (route) => {
          const outside = plantAtRoot();
          const outsideHead = git(outside, ['rev-parse', 'HEAD']);

          const response = await read(route, outside);

          expect(response.status).toBe(403);
          expect(response.json.code).toBe('outside-project');
          expectNothingFromOutside(response.text, outsideHead);
        },
      );
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
        expect(response.status, route).toBe(403);
        // The Project's repository is not its own, so it has no worktrees.
        expect(response.json.code).toBe('outside-project');
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
    // Its repository's other checkouts are still its registered worktrees:
    // the main checkout is read, edited and run in.
    const content = await app().request(
      `/files/content?projectSlug=acme&path=${encodeURIComponent(main)}&file=README.md`,
    );
    expect(((await content.json()) as any).data.content).toBe('# main\n');
    expect(
      (
        await post('/files/create', {
          path: main,
          target: 'n.txt',
          type: 'file',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post('/exec', { cwd: main, command: 'touch ran-here' })).status,
    ).toBe(200);
    expect(existsSync(join(main, 'ran-here'))).toBe(true);
    writeFileSync(join(main, 'README.md'), '# main, edited\n');
    await expectReads(main, {
      top: main,
      branch: 'main',
      subject: 'initial',
      change: 'README.md',
    });
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

describe.skipIf(process.platform === 'win32')(
  'readProjectRepository: the repository changes while it is read',
  () => {
    /** The member's own repository in `<project>/sub`, and the outside one. */
    function ownRepository(): { folder: string; outside: string } {
      const outside = outsideRepository();
      repo(project, { 'README.md': '# project\n' });
      const folder = repo(
        join(project, 'sub'),
        { 'own.txt': 'own\n' },
        { subject: 'member work' },
      );
      return { folder, outside };
    }

    const subject = async (repository: { top: string; repoArgs: string[] }) =>
      (
        await execGit([...repository.repoArgs, 'log', '-1', '--format=%s'], {
          cwd: repository.top,
        })
      ).stdout.trim();

    test('a .git swapped for a link during the read and put back afterwards: the output is discarded', async () => {
      const { folder, outside } = ownRepository();
      writeFileSync(
        join(folder, '.git-file'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      const seen: string[] = [];

      const result = await readProjectRepository(
        project,
        folder,
        {},
        async (repository) => {
          renameSync(join(folder, '.git'), join(folder, '.git-real'));
          renameSync(join(folder, '.git-file'), join(folder, '.git'));
          try {
            const read = await subject(repository);
            seen.push(read);
            return read;
          } finally {
            renameSync(join(folder, '.git'), join(folder, '.git-file'));
            renameSync(join(folder, '.git-real'), join(folder, '.git'));
          }
        },
      );

      // Live: every read went through the link, to the outside repository.
      expect(seen).toEqual([OUTSIDE_SUBJECT, OUTSIDE_SUBJECT, OUTSIDE_SUBJECT]);
      expect(result).toEqual({
        ok: false,
        state: 'refused',
        reason: '.git kept changing while Station read it',
      });
    });

    test('alternates planted during the read and removed afterwards: the output is discarded', async () => {
      const { folder, outside } = ownRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      const alternates = join(folder, '.git', 'objects', 'info', 'alternates');
      const seen: string[] = [];

      const result = await readProjectRepository(
        project,
        folder,
        {},
        async (repository) => {
          writeFileSync(alternates, `${join(outside, '.git', 'objects')}\n`);
          try {
            const read = (
              await execGit(
                [
                  ...repository.repoArgs,
                  'cat-file',
                  '-p',
                  `${outsideHead}:secret.txt`,
                ],
                { cwd: repository.top },
              )
            ).stdout.trim();
            seen.push(read);
            return read;
          } finally {
            rmSync(alternates);
          }
        },
      );

      expect(seen).toEqual([SECRET, SECRET, SECRET]);
      expect(result.ok).toBe(false);
    });

    test('a folder ABOVE the repository swapped during the read and put back afterwards: the output is discarded', async () => {
      const outside = outsideRepository();
      repo(project, { 'README.md': '# project\n' });
      const folder = repo(
        join(project, 'x', 'repo'),
        { 'own.txt': 'own\n' },
        { subject: 'member work' },
      );
      mkdirSync(join(project, 'x.evil', 'repo'), { recursive: true });
      writeFileSync(
        join(project, 'x.evil', 'repo', '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      const seen: string[] = [];

      const result = await readProjectRepository(
        project,
        folder,
        {},
        async (repository) => {
          renameSync(join(project, 'x'), join(project, 'x.own'));
          renameSync(join(project, 'x.evil'), join(project, 'x'));
          try {
            // Plain git by the same path: what the swap makes it name.
            seen.push(git(folder, ['log', '-1', '--format=%s']));
            return subject(repository).catch(() => 'failed');
          } finally {
            renameSync(join(project, 'x'), join(project, 'x.evil'));
            renameSync(join(project, 'x.own'), join(project, 'x'));
          }
        },
      );

      // Live: by that path git read the outside repository, every time.
      expect(seen).toEqual([OUTSIDE_SUBJECT, OUTSIDE_SUBJECT, OUTSIDE_SUBJECT]);
      expect(result).toEqual({
        ok: false,
        state: 'refused',
        reason: '.git kept changing while Station read it',
      });
    });

    test('config rewritten in place during the read to name programs: none runs, and the output is discarded', async () => {
      repo(project, {
        'a.txt': 'one\n',
        '.gitattributes': '*.txt diff=evil filter=evil\n',
      });
      writeFileSync(join(project, 'a.txt'), 'two\n');
      const marker = join(root, 'ran.log');
      const program = join(root, 'program.sh');
      writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, {
        mode: 0o755,
      });
      const config = join(project, '.git', 'config');
      const clean = readFileSync(config, 'utf-8');
      const hostile = `${clean}[diff]\n\texternal = ${program}\n[diff "evil"]\n\ttextconv = ${program}\n\tcommand = ${program}\n[filter "evil"]\n\tclean = ${program}\n\tsmudge = ${program}\n`;
      const ran = () =>
        existsSync(marker)
          ? readFileSync(marker, 'utf-8').split('\n').filter(Boolean).length
          : 0;
      let reads = 0;

      const result = await readProjectRepository(
        project,
        project,
        {},
        async (repository) => {
          reads += 1;
          // In place, as a member holding the file open would: no rename.
          // Clean again afterwards, so each attempt starts from a config
          // Station accepts and meets the hostile one only while git runs.
          const attributes = join(project, '.git', 'info', 'attributes');
          writeFileSync(config, hostile);
          writeFileSync(attributes, '*.txt diff=evil filter=evil\n');
          writeFileSync(join(project, 'a.txt'), `two ${reads}\n`);
          try {
            const options = { cwd: repository.top, env: repository.repoEnv };
            await execGit(
              [...repository.repoArgs, 'status', '--porcelain'],
              options,
            );
            return (await execGit([...repository.repoArgs, 'diff'], options))
              .stdout;
          } finally {
            writeFileSync(config, clean);
            rmSync(attributes);
          }
        },
      );

      expect(ran(), 'a program the rewritten config names ran').toBe(0);
      // The rewrite was noticed, and what was read is not returned.
      expect(reads).toBe(3);
      expect(result.ok).toBe(false);
      // Control: plain git, reading the repository's own config, runs it.
      writeFileSync(config, hostile);
      git(project, ['diff']);
      expect(ran(), 'control: plain git runs the program').toBeGreaterThan(0);
    });

    test('a change during the first read only: the read is repeated and the second answer is returned', async () => {
      const { folder } = ownRepository();
      let reads = 0;

      const result = await readProjectRepository(
        project,
        folder,
        {},
        async (repository) => {
          reads += 1;
          if (reads === 1) {
            git(folder, ['commit', '-q', '--allow-empty', '-m', 'second']);
          }
          return subject(repository);
        },
      );

      expect(reads).toBe(2);
      expect(result).toEqual({ ok: true, top: folder, value: 'second' });
    });

    test('nothing changes: one read, returned', async () => {
      const { folder } = ownRepository();
      let reads = 0;

      const result = await readProjectRepository(
        project,
        folder,
        {},
        async (repository) => {
          reads += 1;
          return subject(repository);
        },
      );

      expect(reads).toBe(1);
      expect(result).toEqual({ ok: true, top: folder, value: 'member work' });
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a nested repository (submodule) is never entered or reported',
  () => {
    /**
     * The Project repository with a nested repository `sub` recorded at an
     * older commit than it is at, and the Project's own `diff.submodule`
     * asking git to show what changed INSIDE it (which makes git run git
     * there). `sub`'s own config and git directory are the member's.
     */
    function nested(): { sub: string; marker: string } {
      repo(project, { 'README.md': '# project\n' });
      const sub = repo(join(project, 'sub'), { 'f.txt': 'one\n' });
      const recorded = git(sub, ['rev-parse', 'HEAD']);
      writeFileSync(join(sub, 'f.txt'), 'two\n');
      git(sub, ['commit', '-q', '-am', 'second']);
      git(project, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${recorded},sub`,
      ]);
      git(project, ['commit', '-q', '-m', 'record sub']);
      git(project, ['config', 'diff.submodule', 'diff']);
      const marker = join(root, 'ran.log');
      const program = join(root, 'program.sh');
      writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\n`, {
        mode: 0o755,
      });
      git(sub, ['config', 'diff.external', program]);
      return { sub, marker };
    }

    test('its own diff program does not run, and nothing from inside it is shown', async () => {
      const { marker } = nested();

      for (const route of ['diff', 'status', 'log'] as const) {
        const response = await read(route, project);
        expect(response.status, route).toBe(200);
        expect(response.text).not.toMatch(/Submodule|Subproject/);
      }
      expect((await read('diff', project)).json.data.diff).toBe('');
      expect(existsSync(marker), 'the nested program ran').toBe(false);

      // Control, last: plain git runs the nested repository's program.
      git(project, ['diff']);
      expect(existsSync(marker), 'control: plain git runs it').toBe(true);
    });

    test("a nested .git file naming an outside repository does not disclose that repository's commit", async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      repo(project, { 'README.md': '# project\n' });
      const recorded = git(project, ['rev-parse', 'HEAD']);
      mkdirSync(join(project, 'sub2'));
      writeFileSync(
        join(project, 'sub2', '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      git(project, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${recorded},sub2`,
      ]);
      git(project, ['commit', '-q', '-m', 'record sub2']);
      // Live: plain git names the outside repository's commit.
      expect(git(project, ['diff'])).toContain(
        `+Subproject commit ${outsideHead}`,
      );

      for (const route of ['diff', 'status', 'log', 'branches'] as const) {
        const response = await read(route, project);
        expect(response.status, route).toBe(200);
        expectNothingFromOutside(response.text, outsideHead);
      }
    });

    test('Commit does not record a nested repository, so its commit id is not published', async () => {
      const outside = outsideRepository();
      const outsideHead = git(outside, ['rev-parse', 'HEAD']);
      repo(project, { 'README.md': '# project\n' });
      mkdirSync(join(project, 'sub2'));
      writeFileSync(
        join(project, 'sub2', '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      writeFileSync(join(project, 'change.txt'), 'change\n');
      // Live: plain `git add` would record the outside repository's commit.
      expect(git(project, ['add', '-A', '-n', '.'])).toContain("add 'sub2/'");

      const response = await post('/git/commit', { message: 'change' });

      expect(response.status, response.text).toBe(200);
      const tree = git(project, ['ls-tree', '-r', 'HEAD']);
      expect(tree).toContain('change.txt');
      expect(tree).not.toContain('sub2');
      expect(tree).not.toContain(outsideHead);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  "other services that run git in a Project's folder",
  () => {
    /** A Project whose root `.git` names the outside repository. */
    function plantedProject(): string {
      const outside = outsideRepository();
      mkdirSync(project);
      writeFileSync(
        join(project, '.git'),
        `gitdir: ${join(outside, '.git')}\n`,
      );
      // Live: git in the Project's folder is in the outside repository.
      expect(git(project, ['log', '-1', '--format=%s'])).toBe(OUTSIDE_SUBJECT);
      return outside;
    }

    test('worktree provisioning creates no branch in, and checks nothing out of, an outside repository', async () => {
      const outside = plantedProject();
      const before = outsideState(outside);

      await expect(
        new WorktreeProvisioningService().provision({
          repoPath: project,
          threadId: 'session-planted',
          providerKind: 'codex',
          isolation: { mode: 'worktree' },
        }),
      ).rejects.toThrow(/not the Project's own/);

      expect(outsideState(outside)).toBe(before);
      expect(existsSync(`${project}-worktrees`)).toBe(false);
    });

    test('an independent review does not check out or read an outside repository', async () => {
      const outside = plantedProject();
      const head = git(outside, ['rev-parse', OUTSIDE_SIDE_BRANCH]);
      const base = git(outside, ['rev-parse', OUTSIDE_BRANCH]);
      const before = outsideState(outside);
      const source = new GitReviewWorkspaceSource(
        { workspace: () => project },
        join(root, 'review-workspaces'),
      );

      await expect(
        source.open({
          kind: 'git-range',
          projectSlug: 'acme',
          baseRevision: base,
          headRevision: head,
        }),
      ).rejects.toThrow(/not the Project's own/);

      expect(outsideState(outside)).toBe(before);
      expect(
        git(outside, ['worktree', 'list', '--porcelain']).match(/^worktree /gm),
      ).toHaveLength(1);
    });

    test('a checkpoint capture writes nothing into an outside repository', async () => {
      const outside = plantedProject();
      const refs = () => git(outside, ['for-each-ref']);
      const before = refs();

      const result = await new CheckpointRefStore().capture({
        repoDir: project,
        threadId: 'thread-planted',
        checkpointId: 'cp-planted',
        kind: 'baseline',
        turnId: 'turn-planted',
      });

      expect(result).toMatchObject({
        status: 'degraded',
        reason: 'not_a_git_repository',
      });
      expect(refs()).toBe(before);
    });

    test('each of them still works in an ordinary Project repository', async () => {
      repo(project, { 'module.ts': 'export const value = 1;\n' });
      const base = git(project, ['rev-parse', 'HEAD']);
      writeFileSync(join(project, 'module.ts'), 'export const value = 2;\n');
      git(project, ['commit', '-q', '-am', 'second']);
      const head = git(project, ['rev-parse', 'HEAD']);

      const metadata = await new WorktreeProvisioningService().provision({
        repoPath: project,
        threadId: 'session-ordinary',
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      });
      expect(metadata?.path && existsSync(metadata.path)).toBe(true);

      const workspace = await new GitReviewWorkspaceSource(
        { workspace: () => project },
        join(root, 'review-workspaces'),
      ).open({
        kind: 'git-range',
        projectSlug: 'acme',
        baseRevision: base,
        headRevision: head,
      });
      expect(
        readFileSync(join(workspace.root, 'module.ts'), 'utf-8'),
      ).toContain('value = 2');
      await workspace.close();

      const captured = await new CheckpointRefStore().capture({
        repoDir: project,
        threadId: 'thread-ordinary',
        checkpointId: 'cp-ordinary',
        kind: 'baseline',
        turnId: 'turn-ordinary',
      });
      expect(captured.status).toBe('captured');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'gitDirectoryInsideProject',
  () => {
    test('a linked worktree whose pointers are relative paths is accepted', async () => {
      const main = repo(join(root, 'main-checkout'), {
        'README.md': '# main\n',
      });
      git(main, ['worktree', 'add', '-q', '-b', 'linked-branch', project]);
      // As `git worktree add --relative-paths` writes them.
      const entry = join(main, '.git', 'worktrees', 'project');
      writeFileSync(
        join(project, '.git'),
        'gitdir: ../main-checkout/.git/worktrees/project\n',
      );
      writeFileSync(join(entry, 'gitdir'), '../../../../project/.git\n');
      expect(git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
        'linked-branch',
      );

      expect((await gitDirectoryInsideProject(project, project)).verdict).toBe(
        'linked-worktree',
      );
      expect((await read('status', project)).json.data).toMatchObject({
        isRepo: true,
        branch: 'linked-branch',
      });
    });

    test('a git directory with more entries than the walk will check is refused, for refs and for objects', async () => {
      repo(project, { 'README.md': '# project\n' });
      for (let branch = 0; branch < 12; branch += 1) {
        git(project, ['branch', `b${branch}`]);
      }
      const generous = { entries: 50_000, objectEntries: 2_000_000 };
      expect(
        (
          await gitDirectoryInsideProject(project, project, {
            limits: generous,
          })
        ).verdict,
      ).toBe('inside');

      expect(
        await gitDirectoryInsideProject(project, project, {
          limits: { ...generous, entries: 20 },
        }),
      ).toEqual({
        verdict: 'outside',
        reason: '.git holds more than 20 entries to check',
      });
      expect(
        await gitDirectoryInsideProject(project, project, {
          limits: { ...generous, objectEntries: 3 },
        }),
      ).toEqual({
        verdict: 'outside',
        reason: '.git holds more than 3 entries to check',
      });
    });

    test('unchanged notices a folder above the repository renamed away and back; sameIdentity allows a commit and notices another .git', async () => {
      repo(project, { 'README.md': '# project\n' });
      const folder = repo(join(project, 'x', 'repo'), { 'own.txt': 'own\n' });
      const verdict = await gitDirectoryInsideProject(folder, project);
      if (verdict.verdict === 'outside') throw new Error(verdict.reason);
      expect(await verdict.unchanged()).toBe(true);

      renameSync(join(project, 'x'), join(project, 'x.away'));
      renameSync(join(project, 'x.away'), join(project, 'x'));
      expect(await verdict.unchanged()).toBe(false);
      expect(await verdict.sameIdentity()).toBe(true);

      git(folder, ['commit', '-q', '--allow-empty', '-m', 'second']);
      expect(await verdict.sameIdentity()).toBe(true);

      renameSync(join(folder, '.git'), join(folder, '.git-real'));
      mkdirSync(join(folder, '.git'));
      expect(await verdict.sameIdentity()).toBe(false);
    });
  },
);
