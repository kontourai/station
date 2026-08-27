import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

/**
 * Integration test for multi-repo / nested-repo discovery + per-path repo
 * resolution. Nothing is mocked: real git repos on disk, driven through the
 * real Hono routes. Covers the case where the opened folder is NOT itself a
 * repo but contains several.
 */

const app = createCodingRoutes(new FileTreeService());

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as any };
}

function initRepo(dir: string, branch: string) {
  mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => execGitSync(args, { cwd: dir });
  g('init');
  g('config', 'user.email', 't@t.dev');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), `# ${branch}\n`);
  g('add', '-A');
  g('commit', '-m', 'init');
  g('branch', '-M', branch);
}

describe('coding multi-repo discovery (real git, no mocks)', () => {
  let workspace: string;

  beforeAll(() => {
    // A workspace that is NOT itself a repo but contains several.
    workspace = mkdtempSync(join(tmpdir(), 'station-multirepo-'));
    initRepo(join(workspace, 'repo-a'), 'main');
    initRepo(join(workspace, 'repo-b'), 'develop');
    initRepo(join(workspace, 'group', 'repo-c'), 'feature'); // one level deeper
    mkdirSync(join(workspace, 'just-files'));
    writeFileSync(join(workspace, 'just-files', 'x.txt'), 'x\n');
    // node_modules must be skipped by the scan even though it has subdirs.
    mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  });

  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test('discovers every nested repo under a non-repo workspace', async () => {
    const res = await get(`/repos?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(200);
    expect(res.json.data.workspaceIsRepo).toBe(false);
    const byName = Object.fromEntries(
      res.json.data.repos.map((r: any) => [r.name, r]),
    );
    expect(Object.keys(byName).sort()).toEqual(['repo-a', 'repo-b', 'repo-c']);
    expect(byName['repo-a'].branch).toBe('main');
    expect(byName['repo-b'].branch).toBe('develop');
    expect(byName['repo-c'].branch).toBe('feature');
    expect(byName['repo-c'].relativePath).toBe(join('group', 'repo-c'));
  });

  test('a workspace that IS a repo reports itself as the single repo', async () => {
    const res = await get(
      `/repos?path=${encodeURIComponent(join(workspace, 'repo-a'))}`,
    );
    expect(res.json.data.workspaceIsRepo).toBe(true);
    expect(res.json.data.repos).toHaveLength(1);
    expect(res.json.data.repos[0].name).toBe('repo-a');
    expect(res.json.data.repos[0].branch).toBe('main');
  });

  test('git status resolves the CONTAINING repo for a nested path', async () => {
    const repoB = join(workspace, 'repo-b');
    mkdirSync(join(repoB, 'src'));
    writeFileSync(join(repoB, 'src', 'a.ts'), 'export const a = 1;\n');

    const res = await get(
      `/git/status?path=${encodeURIComponent(join(repoB, 'src'))}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.isRepo).toBe(true);
    // repoRoot is the nested repo, not the workspace (--show-toplevel realpath).
    expect(res.json.data.repoRoot).toBe(realpathSync(repoB));
    expect(res.json.data.branch).toBe('develop');
  });

  test('the non-repo workspace root reports isRepo=false', async () => {
    const res = await get(`/git/status?path=${encodeURIComponent(workspace)}`);
    expect(res.json.data.isRepo).toBe(false);
  });

  test('git diff on a non-repo workspace returns empty (not an error)', async () => {
    const res = await get(`/git/diff?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data.diff).toBe('');
  });

  test('git branches on a non-repo workspace returns [] (not an error)', async () => {
    const res = await get(
      `/git/branches?path=${encodeURIComponent(workspace)}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data).toEqual([]);
  });
});
