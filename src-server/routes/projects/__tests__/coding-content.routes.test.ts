import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

/**
 * Integration test for the coding layout's content endpoints. Nothing is
 * mocked: it drives the real Hono routes + a real FileTreeService against a real
 * on-disk git project, and includes the `~`-path regression that was producing
 * corrupt paths like `<cwd>/~/dev/...`.
 */

const app = createCodingRoutes(new FileTreeService());

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as any };
}

describe('coding content routes — real git project (no mocks)', () => {
  let repo: string;
  let homeProject: string; // lives under $HOME, to exercise `~` expansion

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'station-coding-repo-'));
    const g = (...args: string[]) => execGitSync(args, { cwd: repo });
    g('init');
    g('config', 'user.email', 't@t.dev');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# Hello Station\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    g('add', '-A');
    g('commit', '-m', 'init');
    // Leave an uncommitted change so git status has something to report.
    writeFileSync(join(repo, 'README.md'), '# Hello Station\n\nedited\n');

    homeProject = mkdtempSync(join(homedir(), '.station-coding-test-'));
    writeFileSync(join(homeProject, 'marker.txt'), 'found via tilde\n');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeProject, { recursive: true, force: true });
  });

  test('lists the file tree of a real project', async () => {
    const res = await get(`/files?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    const tree = JSON.stringify(res.json.data);
    expect(tree).toContain('README.md');
    expect(tree).toContain('src');
  });

  test('reads file content via a workspace-relative path', async () => {
    // `path` is the workspace root; `file` is relative to it — exactly what the
    // file tree emits. README.md does NOT exist under process.cwd(), so this
    // would blank out if the endpoint resolved against the server cwd (the bug
    // that made the previewer render nothing).
    const res = await get(
      `/files/content?path=${encodeURIComponent(repo)}&file=README.md`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.content).toContain('Hello Station');
    expect(res.json.data.content).toContain('edited');
  });

  test('reads a nested workspace-relative path', async () => {
    const res = await get(
      `/files/content?path=${encodeURIComponent(repo)}&file=${encodeURIComponent('src/index.ts')}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.content).toContain('export const x = 1');
  });

  test('requires the relative file param', async () => {
    const res = await get(`/files/content?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
  });

  test('rejects a file path that escapes the workspace', async () => {
    const res = await get(
      `/files/content?path=${encodeURIComponent(repo)}&file=${encodeURIComponent('../../../../etc/passwd')}`,
    );
    expect(res.status).toBe(500);
    expect(res.json.success).toBe(false);
  });

  test('rejects a symlinked file that would expose content outside the workspace', async () => {
    const outside = join(repo, '..', `station-coding-secret-${Date.now()}.txt`);
    writeFileSync(outside, 'outside secret');
    symlinkSync(outside, join(repo, 'outside-link.txt'));

    const res = await get(
      `/files/content?path=${encodeURIComponent(repo)}&file=outside-link.txt`,
    );
    expect(res.status).toBe(500);
    expect(res.json.success).toBe(false);
    expect(res.json.error).toContain('Symlink target is not allowed');
    rmSync(outside, { force: true });
  });

  test('reports real git status (branch + dirty file)', async () => {
    const res = await get(`/git/status?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(200);
    expect(res.json.data.isRepo).toBe(true);
    expect(res.json.data.branch).toBeTruthy();
    expect(res.json.data.staged + res.json.data.unstaged).toBeGreaterThan(0);
  });

  test('REGRESSION: a `~` path expands to $HOME, not `<cwd>/~/...`', async () => {
    const tilde = `~/${relative(homedir(), homeProject)}`;
    const res = await get(`/files?path=${encodeURIComponent(tilde)}`);
    // If `~` were not expanded, validatePath would resolve to `<cwd>/~/...`,
    // which doesn't exist, and the request would 400.
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(JSON.stringify(res.json.data)).toContain('marker.txt');
  });

  test('the corrupt `<cwd>/~/...` path (old bug output) is rejected', async () => {
    const corrupt = `${process.cwd()}/~/dev/does-not-exist`;
    const res = await get(`/files?path=${encodeURIComponent(corrupt)}`);
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
  });
});
