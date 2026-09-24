import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

/**
 * Full integration test for the coding git-ops endpoints. NOTHING is mocked:
 * each test drives the real Hono route against a real on-disk git repo (with a
 * real bare remote) and asserts the actual git state via `git` itself.
 */

// The git endpoints never touch FileTreeService, so a bare stub is sufficient.
// Commit and push are operator-only and act on the Project's own folder
// (#2363); `coding-git-security.routes.test.ts` covers those refusals.
let repo: string;
const app = createCodingRoutes({} as unknown as FileTreeService, {
  resolveProjectFolder: (slug) => (slug === 'acme' ? repo : undefined),
  visibility: {
    resolvePrincipal: () => ({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      kind: 'human',
      display: 'Operator',
    }),
  },
});

function git(cwd: string, ...args: string[]): string {
  return (execGitSync(args, { cwd, encoding: 'utf-8' }) as string).trim();
}

async function post(path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('coding git-ops routes (real git, no mocks)', () => {
  let bare: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'station-gitops-repo-'));
    bare = mkdtempSync(join(tmpdir(), 'station-gitops-bare-'));
    execGitSync(['init', '--bare'], { cwd: bare });

    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@station.dev');
    git(repo, 'config', 'user.name', 'Station Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'initial');
    git(repo, 'branch', '-M', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  test('checkout creates and switches a branch — HEAD really moves', async () => {
    const created = await post('/git/checkout', {
      path: repo,
      branch: 'feature',
      create: true,
    });
    expect(created.status).toBe(200);
    expect(created.json.success).toBe(true);
    expect(created.json.data.branch).toBe('feature');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');

    const back = await post('/git/checkout', { path: repo, branch: 'main' });
    expect(back.json.success).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  test('commit stages and commits — a real commit lands', async () => {
    const before = Number(git(repo, 'rev-list', '--count', 'HEAD'));
    writeFileSync(join(repo, 'file.txt'), 'change\n');

    const res = await post('/git/commit', {
      projectSlug: 'acme',
      message: 'add file.txt',
    });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(git(repo, 'rev-list', '--count', 'HEAD'))).toBe(before + 1);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('add file.txt');
  });

  test('push to a local-path remote is refused before git runs (#2363)', async () => {
    // A push to a local path runs the TARGET repository's hooks. The bare
    // remote here is a local path, so the route refuses it by address.
    const res = await post('/git/push', {
      projectSlug: 'acme',
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    });
    expect(res.status).toBe(409);
    expect(res.json.success).toBe(false);
    expect(res.json.code).toBe('remote-unsupported-transport');

    expect(() =>
      execGitSync(
        ['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/main'],
        { encoding: 'utf-8', stdio: 'pipe' },
      ),
    ).toThrow();
  });

  test('checkout of a non-existent branch fails with 400 (no state change)', async () => {
    const head = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const res = await post('/git/checkout', {
      path: repo,
      branch: 'does-not-exist',
    });
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(head);
  });
});
