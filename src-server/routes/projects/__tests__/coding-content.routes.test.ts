import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { FileTreeService } from '../../../services/projects/file-tree-service.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createCodingRoutes } from '../coding.js';

const previewPlatform = vi.hoisted(() => ({ optionalOpenFlags: true }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NONBLOCK() {
        return previewPlatform.optionalOpenFlags
          ? actual.constants.O_NONBLOCK
          : undefined;
      },
      get O_NOFOLLOW() {
        return previewPlatform.optionalOpenFlags
          ? actual.constants.O_NOFOLLOW
          : undefined;
      },
    },
  };
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

/**
 * Integration test for the coding layout's content endpoints. It drives
 * real Hono routes + a real FileTreeService against a real
 * on-disk git project, and includes the `~`-path regression that was producing
 * corrupt paths like `<cwd>/~/dev/...`.
 */

// #2412: every read names its Project. `r` is the git project; `h` is the
// project under $HOME, configured tilde-literal the way the UI stores it.
let repo: string;
let homeProject: string; // lives under $HOME, to exercise `~` expansion
const resolveProjectFolder = (slug: string) =>
  slug === 'r'
    ? repo
    : slug === 'h'
      ? `~/${relative(homedir(), homeProject)}`
      : undefined;
const app = createCodingRoutes(new FileTreeService(), { resolveProjectFolder });

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as any };
}

describe('coding content routes — real git project', () => {
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
    const res = await get(
      `/files?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    const tree = JSON.stringify(res.json.data);
    expect(tree).toContain('README.md');
    expect(tree).toContain('src');
  });

  test.each([
    'depth=NaN',
    'depth=Infinity',
    'depth=-1',
    'depth=1.5',
    'depth=11',
    'depth=',
    'maxEntries=NaN',
    'maxEntries=Infinity',
    'maxEntries=0',
    'maxEntries=-1',
    'maxEntries=1.5',
    'maxEntries=5001',
    'maxEntries=',
  ])('refuses invalid tree bounds: %s', async (query) => {
    const result = await get(`/files?projectSlug=r&${query}`);
    expect(result.status).toBe(400);
    expect(result.json.success).toBe(false);
    expect(result.json.error).toContain('integer');
  });

  test('accepts boundary options, caps the tree, and excludes symlink entries', async () => {
    const link = join(repo, 'inside-link.txt');
    symlinkSync('README.md', link);
    try {
      const shallow = await get('/files?projectSlug=r&depth=0&maxEntries=1');
      expect(shallow.status).toBe(200);
      expect(shallow.json.data).toHaveLength(1);
      const deep = await get('/files?projectSlug=r&depth=10&maxEntries=5000');
      expect(deep.status).toBe(200);
      expect(deep.json.data).toContainEqual(
        expect.objectContaining({
          name: 'src',
          children: [expect.objectContaining({ name: 'index.ts' })],
        }),
      );
      expect(
        deep.json.data.map((entry: { name: string }) => entry.name),
      ).not.toContain('inside-link.txt');
    } finally {
      rmSync(link);
    }
  });

  test('reads file content via a workspace-relative path', async () => {
    // `path` is the workspace root; `file` is relative to it — exactly what the
    // file tree emits. README.md does NOT exist under process.cwd(), so this
    // would blank out if the endpoint resolved against the server cwd (the bug
    // that made the previewer render nothing).
    const res = await get(
      `/files/content?projectSlug=r&path=${encodeURIComponent(repo)}&file=README.md`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.content).toContain('Hello Station');
    expect(res.json.data.content).toContain('edited');
  });

  test('previews exactly 2 MiB and refuses max+1 with an actionable typed error', async () => {
    const path = join(repo, 'preview-limit.txt');
    const content = 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(path, content);
    const accepted = await get(
      '/files/content?projectSlug=r&file=preview-limit.txt',
    );
    expect(accepted.status).toBe(200);
    expect(accepted.json.data.content).toBe(content);
    writeFileSync(path, `${content}x`);
    const refused = await get(
      '/files/content?projectSlug=r&file=preview-limit.txt',
    );
    expect(refused.status).toBe(413);
    expect(refused.json).toEqual({
      success: false,
      code: 'file-too-large',
      error: expect.stringContaining('2 MiB'),
    });
    expect(refused.json.error).toContain('Open it in an editor');
  });

  test('refuses binary previews and reads changed text on the next request', async () => {
    const path = join(repo, 'preview-binary.txt');
    writeFileSync(path, Buffer.from([65, 0, 66]));
    const refused = await get(
      '/files/content?projectSlug=r&file=preview-binary.txt',
    );
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('binary-file');
    writeFileSync(path, 'now text');
    const accepted = await get(
      '/files/content?projectSlug=r&file=preview-binary.txt',
    );
    expect(accepted.json.data.content).toBe('now text');
  });

  test('a small preview does not allocate the full content budget', async () => {
    writeFileSync(join(repo, 'small-preview.txt'), 'small text');
    const allocations = vi.spyOn(Buffer, 'alloc');
    try {
      const result = await get(
        '/files/content?projectSlug=r&file=small-preview.txt',
      );
      expect(result.status).toBe(200);
      expect(result.json.data.content).toBe('small text');
      expect(allocations.mock.calls.length).toBeGreaterThan(0);
      expect(
        Math.max(...allocations.mock.calls.map(([size]) => size)),
      ).toBeLessThanOrEqual(8192);
    } finally {
      allocations.mockRestore();
    }
  });

  test.each([1024 * 1024, 2 * 1024 * 1024 + 1])(
    'detects file growth after stat without truncating %i bytes',
    async (size) => {
      const path = join(repo, 'growing-preview.txt');
      writeFileSync(path, 'X');
      const suffix = 'g'.repeat(size - 1);
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      let grew = false;
      vi.mocked(asyncFs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
          const snapshot = await stat(options);
          if (!grew) {
            grew = true;
            appendFileSync(path, suffix);
          }
          return snapshot;
        });
        return handle;
      });
      try {
        const result = await get(
          '/files/content?projectSlug=r&file=growing-preview.txt',
        );
        expect(grew).toBe(true);
        if (size > 2 * 1024 * 1024) {
          expect(result.status).toBe(413);
          expect(result.json.code).toBe('file-too-large');
          expect(result.json.data).toBeUndefined();
        } else {
          expect(result.status).toBe(200);
          expect(result.json.data.content).toBe(`X${suffix}`);
        }
      } finally {
        vi.mocked(asyncFs.open).mockImplementation(actual.open);
      }
    },
  );

  async function expectNonRegularRefusal(file: string) {
    const target = realpathSync(join(repo, file));
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let attemptedOpen = false;
    vi.mocked(asyncFs.open).mockImplementation(async (...args) => {
      if (args[0] === target) {
        attemptedOpen = true;
        throw new Error('Non-regular fixture reached open');
      }
      return actual.open(...args);
    });
    try {
      const result = await get(
        `/files/content?projectSlug=r&file=${encodeURIComponent(file)}`,
      );
      expect(result.status).toBe(400);
      expect(result.json.code).toBe('not-a-file');
      expect(attemptedOpen).toBe(false);
      expect(
        (await get('/files/content?projectSlug=r&file=README.md')).status,
      ).toBe(200);
    } finally {
      vi.mocked(asyncFs.open).mockImplementation(actual.open);
    }
  }

  test('refuses a directory before opening it', async () => {
    await expectNonRegularRefusal('src');
  });

  test.skipIf(process.platform === 'win32')(
    'refuses a real FIFO before open can block the request',
    async () => {
      const path = join(repo, 'preview.fifo');
      execFileSync('mkfifo', [path], { windowsHide: true });
      try {
        await expectNonRegularRefusal('preview.fifo');
      } finally {
        rmSync(path, { force: true });
      }
    },
  );

  test('previews regular files when optional platform open flags are unavailable', async () => {
    previewPlatform.optionalOpenFlags = false;
    try {
      const result = await get('/files/content?projectSlug=r&file=README.md');
      expect(result.status).toBe(200);
      expect(result.json.data.content).toBe('# Hello Station\n\nedited\n');
    } finally {
      previewPlatform.optionalOpenFlags = true;
    }
  });

  test.skipIf(process.platform === 'win32')(
    'refuses a FIFO swapped in after path checks without blocking open',
    async () => {
      const path = join(repo, 'swapped-preview.txt');
      writeFileSync(path, 'regular before open');
      const target = realpathSync(path);
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      let swapped = false;
      vi.mocked(asyncFs.open).mockImplementation(async (...args) => {
        if (args[0] === target) {
          rmSync(path);
          execFileSync('mkfifo', [path], { windowsHide: true });
          swapped = true;
          // Keep the negative control from leaving a blocking open in the worker.
          if (
            typeof args[1] !== 'number' ||
            !(args[1] & constants.O_NONBLOCK)
          ) {
            throw new Error('FIFO preview attempted a blocking open');
          }
        }
        return actual.open(...args);
      });
      try {
        const result = await get(
          '/files/content?projectSlug=r&file=swapped-preview.txt',
        );
        expect(swapped).toBe(true);
        expect(result.status).toBe(400);
        expect(result.json.code).toBe('not-a-file');
        expect(result.json.data).toBeUndefined();
      } finally {
        vi.mocked(asyncFs.open).mockImplementation(actual.open);
        rmSync(path, { force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'refuses a symlink swapped in after path checks',
    async () => {
      const path = join(repo, 'swapped-link.txt');
      writeFileSync(path, 'regular before open');
      const target = realpathSync(path);
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      let swapped = false;
      vi.mocked(asyncFs.open).mockImplementation(async (...args) => {
        if (args[0] === target) {
          rmSync(path);
          symlinkSync(join(repo, 'README.md'), path);
          swapped = true;
        }
        return actual.open(...args);
      });
      try {
        const result = await get(
          '/files/content?projectSlug=r&file=swapped-link.txt',
        );
        expect(swapped).toBe(true);
        expect(result.status).toBe(500);
        expect(result.json.success).toBe(false);
        expect(result.json.data).toBeUndefined();
      } finally {
        vi.mocked(asyncFs.open).mockImplementation(actual.open);
        rmSync(path, { force: true });
      }
    },
  );

  test('a missing preview keeps the established status and an actionable typed relative-path error', async () => {
    const result = await get('/files/content?projectSlug=r&file=missing.txt');
    expect(result.status).toBe(500);
    expect(result.json).toEqual({
      success: false,
      code: 'not-found',
      error: 'Not found: missing.txt',
    });
  });

  test('reads a nested workspace-relative path', async () => {
    const res = await get(
      `/files/content?projectSlug=r&path=${encodeURIComponent(repo)}&file=${encodeURIComponent('src/index.ts')}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.content).toContain('export const x = 1');
  });

  test('requires the relative file param', async () => {
    const res = await get(
      `/files/content?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
  });

  test('rejects a file path that escapes the workspace', async () => {
    const res = await get(
      `/files/content?projectSlug=r&path=${encodeURIComponent(repo)}&file=${encodeURIComponent('../../../../etc/passwd')}`,
    );
    expect(res.status).toBe(500);
    expect(res.json.success).toBe(false);
  });

  test('rejects a symlinked file that would expose content outside the workspace', async () => {
    const outside = join(repo, '..', `station-coding-secret-${Date.now()}.txt`);
    writeFileSync(outside, 'outside secret');
    symlinkSync(outside, join(repo, 'outside-link.txt'));

    const res = await get(
      `/files/content?projectSlug=r&path=${encodeURIComponent(repo)}&file=outside-link.txt`,
    );
    expect(res.status).toBe(500);
    expect(res.json.success).toBe(false);
    expect(res.json.error).toContain('Symlink target is not allowed');
    rmSync(outside, { force: true });
  });

  test('reports real git status (branch + dirty file)', async () => {
    const res = await get(
      `/git/status?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.isRepo).toBe(true);
    expect(res.json.data.branch).toBeTruthy();
    expect(res.json.data.staged + res.json.data.unstaged).toBeGreaterThan(0);
  });

  /**
   * #1536 G5: Push had no fact to gate on, so it was live in a checkout with
   * nowhere to push and the only way to find that out was to press it.
   */
  test('observes whether the checkout has a remote to push to', async () => {
    const before = await get(
      `/git/status?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    expect(before.json.data.remote).toBe('absent');

    execGitSync(['remote', 'add', 'origin', 'https://example.test/a/b.git'], {
      cwd: repo,
    });
    const after = await get(
      `/git/status?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    expect(after.json.data.remote).toBe('present');

    execGitSync(['remote', 'remove', 'origin'], { cwd: repo });
  });

  /**
   * Review L10: the third state. `unknown` means the read could not answer, and
   * folding it into `absent` would disable Push on no evidence — the
   * distinction `checkout-remote-reader.ts` exists to keep.
   *
   * Driven through the injected reader, because no filesystem state reaches it
   * from here: every way of breaking `.git/config` (a directory in its place,
   * a syntax error, mode 000) also fails `git rev-parse
   * --is-inside-work-tree`, so this route's own `isInsideWorkTree` gate answers
   * `isRepo: false` before the remote read happens. The refusal path is still
   * live — a timeout, a git binary that goes away between the two calls — it
   * just is not reachable by breaking the config.
   */
  test('reports a refused remote read as unknown, never absent', async () => {
    const refusing = createCodingRoutes(new FileTreeService(), {
      resolveProjectFolder,
      readRemotes: async () => ({
        ok: false as const,
        reason: 'git could not be run',
      }),
    });
    const res = await refusing.request(
      `/git/status?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data.isRepo).toBe(true);
    expect(json.data.remote).toBe('unknown');
  });

  test('a successful read of zero remotes is absent, not unknown', async () => {
    const empty = createCodingRoutes(new FileTreeService(), {
      resolveProjectFolder,
      readRemotes: async () => ({ ok: true as const, remotes: [] }),
    });
    const res = await empty.request(
      `/git/status?projectSlug=r&path=${encodeURIComponent(repo)}`,
    );
    const json = (await res.json()) as any;

    expect(json.data.remote).toBe('absent');
  });

  test('REGRESSION: a `~` path expands to $HOME, not `<cwd>/~/...`', async () => {
    const tilde = `~/${relative(homedir(), homeProject)}`;
    const res = await get(
      `/files?projectSlug=h&path=${encodeURIComponent(tilde)}`,
    );
    // If `~` were not expanded (in the request path or the Project's stored
    // folder), it would resolve to `<cwd>/~/...`, which doesn't exist, and
    // the request would be refused.
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(JSON.stringify(res.json.data)).toContain('marker.txt');
  });

  test('the corrupt `<cwd>/~/...` path (old bug output) is rejected', async () => {
    const corrupt = `${process.cwd()}/~/dev/does-not-exist`;
    const res = await get(
      `/files?projectSlug=r&path=${encodeURIComponent(corrupt)}`,
    );
    expect(res.status).toBe(409);
    expect(res.json.success).toBe(false);
  });
});
