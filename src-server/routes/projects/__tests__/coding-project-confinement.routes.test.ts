/**
 * #2412, owner decision: every coding route that takes a client path is
 * confined to the named Project's folder (or a checkout git reports as a
 * registered worktree of its repository, verified back to it), by the
 * realpath containment commit and push already had (#2363). Real routes, real
 * filesystem: an outside folder, a symlink inside the Project that leads
 * out, and a request naming no Project are each refused on every route,
 * and a refused edit leaves the outside folder untouched.
 */
import {
  existsSync,
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
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

let root: string;
let project: string;
let outside: string;
let linkOut: string;
let worktree: string;

const OPERATOR: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator',
  authority: 'operator-credential',
  source: 'bearer',
};
const PAIRED_PHONE: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'phone',
  authority: 'device-credential',
  deviceId: 'phone',
  source: 'session',
  pairingSource: 'pairing-code',
};

function appAs(principal: RuntimeAuthenticatedRequestPrincipal) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
    bindRuntimeLocalOperator(c.req.raw);
    await next();
  });
  app.route(
    '/',
    createCodingRoutes(new FileTreeService(), {
      resolveProjectFolder: (slug) => (slug === 'acme' ? project : undefined),
    }),
  );
  return app;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'station-coding-confine-'));
  project = join(root, 'acme');
  outside = join(root, 'elsewhere');
  worktree = join(root, 'acme-worktrees', 'session-1');
  for (const dir of [project, outside]) {
    mkdirSync(dir, { recursive: true });
    execGitSync(['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'secret.txt'), `${dir}\n`);
    execGitSync(['add', 'secret.txt'], { cwd: dir });
    execGitSync(
      ['-c', 'user.name=t', '-c', 'user.email=t@t.dev', 'commit', '-qm', 'i'],
      { cwd: dir },
    );
  }
  linkOut = join(project, 'link-out');
  symlinkSync(outside, linkOut);
  // A real worktree session, registered by git itself.
  execGitSync(['worktree', 'add', '-q', '-b', 'session-1', worktree], {
    cwd: project,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

type Probe = {
  name: string;
  request: (
    app: Hono,
    path: string | undefined,
    slug: string | undefined,
  ) => Response | Promise<Response>;
};

function query(path: string | undefined, slug: string | undefined): string {
  const params = new URLSearchParams();
  if (slug) params.set('projectSlug', slug);
  if (path) params.set('path', path);
  return params.toString();
}

const get =
  (route: string, extra = ''): Probe['request'] =>
  (app, path, slug) =>
    app.request(`${route}?${query(path, slug)}${extra}`);

const post =
  (route: string, body: Record<string, unknown>): Probe['request'] =>
  (app, path, slug) =>
    app.request(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        ...(slug ? { projectSlug: slug } : {}),
        ...(path ? (route === '/exec' ? { cwd: path } : { path }) : {}),
      }),
    });

const PROBES: Probe[] = [
  { name: 'GET /files', request: get('/files') },
  { name: 'GET /files/search', request: get('/files/search', '&query=s') },
  {
    name: 'GET /files/content',
    request: get('/files/content', '&file=secret.txt'),
  },
  { name: 'GET /git/status', request: get('/git/status') },
  { name: 'GET /git/log', request: get('/git/log') },
  { name: 'GET /git/diff', request: get('/git/diff') },
  { name: 'GET /git/branches', request: get('/git/branches') },
  { name: 'GET /repos', request: get('/repos') },
  {
    name: 'POST /files/create',
    request: post('/files/create', { target: 'planted.txt', type: 'file' }),
  },
  {
    name: 'POST /files/rename',
    request: post('/files/rename', { from: 'secret.txt', to: 'moved.txt' }),
  },
  {
    name: 'POST /files/delete',
    request: post('/files/delete', { target: 'secret.txt' }),
  },
  {
    name: 'POST /git/checkout',
    request: post('/git/checkout', { branch: 'planted', create: true }),
  },
  {
    name: 'POST /exec',
    request: post('/exec', { command: 'touch exec-ran' }),
  },
];

/** What a refused request must have left in the outside folder. */
function outsideUntouched() {
  expect(readdirSync(outside).sort()).toEqual(['.git', 'secret.txt']);
  expect(
    execGitSync(['branch', '--list', 'planted'], {
      cwd: outside,
      encoding: 'utf-8',
    }),
  ).toBe('');
}

describe.each(PROBES)('$name is confined to the named Project', (probe) => {
  test('refuses a folder outside the Project', async () => {
    const res = await probe.request(appAs(OPERATOR), outside, 'acme');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      'outside-project',
    );
    outsideUntouched();
  });

  test('refuses a symlink inside the Project that leads outside it', async () => {
    const res = await probe.request(appAs(OPERATOR), linkOut, 'acme');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      'outside-project',
    );
    outsideUntouched();
  });

  test('refuses `..` out of the Project', async () => {
    const res = await probe.request(
      appAs(OPERATOR),
      `${project}/../elsewhere`,
      'acme',
    );
    expect(res.status).toBe(403);
    outsideUntouched();
  });

  test('refuses a request that names no Project', async () => {
    // A paired device: the operator in person may ask `/repos` about a
    // folder that is not a Project yet (below). `/exec` as the operator, so
    // the refusal is the missing Project rather than the missing grant.
    const caller = probe.name === 'POST /exec' ? OPERATOR : PAIRED_PHONE;
    const res = await probe.request(appAs(caller), outside, undefined);
    expect(res.status).toBe(400);
    outsideUntouched();
  });
});

describe('what the confinement admits', () => {
  test('a read inside the Project', async () => {
    const res = await appAs(OPERATOR).request(
      `/files/content?${query(project, 'acme')}&file=secret.txt`,
    );
    expect(res.status).toBe(200);
  });

  test("a worktree session's folder beside the Project", async () => {
    const res = await appAs(OPERATOR).request(
      `/git/status?${query(worktree, 'acme')}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.isRepo).toBe(true);
  });

  test('the New Project form asks about a folder with no Project, as the operator in person', async () => {
    const res = await appAs(OPERATOR).request(
      `/repos?${query(outside, undefined)}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.workspaceIsRepo).toBe(true);
  });

  test('but a paired device gets no answer about a folder outside every Project', async () => {
    const res = await appAs(PAIRED_PHONE).request(
      `/repos?${query(outside, undefined)}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      'project-required',
    );
  });

  test('a refused exec ran nothing', () => {
    expect(existsSync(join(outside, 'exec-ran'))).toBe(false);
  });
});
