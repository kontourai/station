/**
 * #2412 review: which checkouts beside a Project the coding routes reach.
 * Not a folder NAME (`<project>-worktrees`), but what git reports as a
 * registered worktree of the Project's repository, each verified back to
 * that repository through its own `.git`. Real git, real routes.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

let root: string;
let simpleProject: string;
let customWorktree: string;
let unrelatedSibling: string;
let outside: string;
let mono: string;
let monoProject: string;
let monoWorktree: string;
let forged: string;
let foreignWorktree: string;

function git(cwd: string, ...args: string[]) {
  return execGitSync(args, { cwd, encoding: 'utf-8' }) as string;
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git(dir, 'add', '-A');
  git(
    dir,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t.dev',
    'commit',
    '-qm',
    'i',
  );
}

const app = () => {
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
      resolveProjectFolder: (slug) =>
        slug === 'simple'
          ? simpleProject
          : slug === 'app'
            ? monoProject
            : undefined,
    }),
  );
  return mounted;
};

const read = async (slug: string, path: string) =>
  (await app().request(
    `/git/status?projectSlug=${slug}&path=${encodeURIComponent(path)}`,
  )) as Response;

const create = async (slug: string, path: string, target: string) =>
  (await app().request('/files/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectSlug: slug, path, target, type: 'file' }),
  })) as Response;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'station-coding-reach-'));

  // A Project whose worktree policy put a session somewhere custom.
  simpleProject = join(root, 'simple');
  initRepo(simpleProject);
  customWorktree = join(root, 'custom-base', 'session-a');
  git(
    simpleProject,
    'worktree',
    'add',
    '-q',
    '-b',
    'session-a',
    customWorktree,
  );
  // A folder that merely HAS the sibling name, never registered.
  unrelatedSibling = join(root, 'simple-worktrees', 'not-a-session');
  initRepo(unrelatedSibling);
  outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(outside, join(customWorktree, 'link-out'));

  // A Project that is one folder of a larger repository.
  mono = join(root, 'mono');
  initRepo(mono);
  monoProject = join(mono, 'packages', 'app');
  mkdirSync(monoProject, { recursive: true });
  writeFileSync(join(monoProject, 'index.ts'), 'export {};\n');
  monoWorktree = join(root, 'mono-worktrees', 'session-b');
  git(mono, 'worktree', 'add', '-q', '-b', 'session-b', monoWorktree);

  // A registration written straight into .git, claiming a folder whose own
  // .git does not lead back.
  forged = join(root, 'forged');
  initRepo(forged);
  const entry = join(simpleProject, '.git', 'worktrees', 'forged');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'gitdir'), `${join(forged, '.git')}\n`);
  writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(entry, 'commondir'), '../..\n');

  // The same forgery naming a LINKED checkout: a real worktree, but of a
  // different repository, so its `.git` file leads there, not back here.
  const foreign = join(root, 'foreign');
  initRepo(foreign);
  foreignWorktree = join(root, 'foreign-wt');
  git(foreign, 'worktree', 'add', '-q', '-b', 'f', foreignWorktree);
  const linkedEntry = join(simpleProject, '.git', 'worktrees', 'forged-linked');
  mkdirSync(linkedEntry, { recursive: true });
  writeFileSync(
    join(linkedEntry, 'gitdir'),
    `${join(foreignWorktree, '.git')}\n`,
  );
  writeFileSync(join(linkedEntry, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(linkedEntry, 'commondir'), '../..\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('registered worktrees of the Project repository', () => {
  test('a worktree under a custom base dir is read and edited', async () => {
    expect((await read('simple', customWorktree)).status).toBe(200);
    const res = await create('simple', customWorktree, 'made-here.txt');
    expect(res.status).toBe(200);
  });

  test('an unrelated folder that merely has the <project>-worktrees name is refused', async () => {
    const res = await read('simple', unrelatedSibling);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      'outside-project',
    );
  });

  test('a symlink inside a registered worktree that leads outside still fails closed', async () => {
    expect(
      (await read('simple', join(customWorktree, 'link-out'))).status,
    ).toBe(403);
    expect(
      (await create('simple', join(customWorktree, 'link-out'), 'planted.txt'))
        .status,
    ).toBe(403);
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  test('a registration the repository wrote for a folder whose .git does not lead back is refused', async () => {
    // Plain git does list it: the refusal is Station's reverse check.
    expect(git(simpleProject, 'worktree', 'list', '--porcelain')).toContain(
      forged,
    );
    expect((await read('simple', forged)).status).toBe(403);
  });

  test('a registration naming a linked checkout of ANOTHER repository is refused', async () => {
    expect(git(simpleProject, 'worktree', 'list', '--porcelain')).toContain(
      foreignWorktree,
    );
    expect((await read('simple', foreignWorktree)).status).toBe(403);
  });
});

describe('a Project that is one folder of a larger repository', () => {
  test('its session worktree (derived from the repository root) is read and edited', async () => {
    expect((await read('app', monoWorktree)).status).toBe(200);
    expect((await create('app', monoWorktree, 'session.txt')).status).toBe(200);
  });

  test("the Task workspace's repository root above the Project is readable", async () => {
    const res = await read('app', mono);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.isRepo).toBe(true);
    const diff = await app().request(
      `/git/diff?projectSlug=app&path=${encodeURIComponent(mono)}`,
    );
    expect(diff.status).toBe(200);
  });

  test('but nothing above the Project is edited or run in', async () => {
    expect((await create('app', mono, 'above.txt')).status).toBe(403);
    const exec = await app().request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectSlug: 'app',
        cwd: mono,
        command: 'touch ran-above',
      }),
    });
    expect(exec.status).toBe(403);
    expect(readdirSync(mono).sort()).toEqual(['.git', 'README.md', 'packages']);
  });
});
