import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

// Passes through to the real filesystem unless a test arms one rejection, so
// the cases that can be driven for real stay real and only the errnos that
// cannot be produced portably (EACCES under a root test runner, EIO at all)
// are synthesized.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const { readdir } = await import('node:fs/promises');
const { createFsRoutes } = await import('../fs.js');

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('FS Routes', () => {
  test('GET /browse returns directories for home', async () => {
    const app = createFsRoutes();
    const body = await json(await app.request('/browse'));
    expect(body.data.path).toBeDefined();
    expect(Array.isArray(body.data.entries)).toBe(true);
  });
  test('GET /browse with explicit path', async () => {
    const app = createFsRoutes();
    const body = await json(await app.request('/browse?path=/tmp'));
    expect(body.data.path).toBe('/tmp');
  });

  // archive#3158 — the four cases below used to share one 404 reading "Path
  // not found or permission denied", which told a user on the project-creation
  // folder picker to check two unrelated things and gave the remedy for
  // neither. Each asserts its own cause; passing three of four is a fail.
  test('GET /browse reports a missing path as missing', async () => {
    const app = createFsRoutes();
    const res = await app.request('/browse?path=/nonexistent/path/xyz');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('Folder not found');
  });

  test('GET /browse reports an unreadable directory as permission denied', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('EACCES'));
    const app = createFsRoutes();
    const res = await app.request('/browse?path=/tmp');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe(
      'Permission denied reading this folder',
    );
  });

  test('GET /browse treats EPERM as permission denied too', async () => {
    // EPERM is the Windows spelling of the very case this split exists to
    // name, and deleting `case 'EPERM'` reddened nothing — the weakest point
    // in the suite (archive#3158 review). The guard runs on Windows CI.
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('EPERM'));
    const res = await createFsRoutes().request('/browse?path=/tmp');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe(
      'Permission denied reading this folder',
    );
  });

  test('GET /browse reports an over-long path as a bad request', async () => {
    // Client input, not a server fault. It used to fall to the default
    // branch: a 500 plus an error-level write into the durable server log,
    // for a pasted path.
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('ENAMETOOLONG'));
    const res = await createFsRoutes().request('/browse?path=/tmp');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('too long');
  });

  test('GET /browse reports an unusable path as a bad request, not a 500', async () => {
    // A NUL byte makes readdir throw a TypeError with ERR_INVALID_ARG_VALUE —
    // not an errno — so it reached the unclassified branch.
    const invalid = Object.assign(new TypeError('bad path'), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
    vi.mocked(readdir).mockRejectedValueOnce(invalid);
    const res = await createFsRoutes().request('/browse?path=/tmp');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('not valid');
  });

  test('GET /browse reports a file path as a file, not as missing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fs-routes-')), 'notes.txt');
    writeFileSync(file, 'x');
    const app = createFsRoutes();

    const res = await app.request(
      `/browse?path=${encodeURIComponent(join(file, 'child'))}`,
    );

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      'That path is a file, not a directory',
    );
  });

  test('GET /browse does not claim not-found for an unclassified failure', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('EIO'));
    const app = createFsRoutes();
    const res = await app.request('/browse?path=/tmp');
    expect(res.status).toBe(500);
    expect((await json(res)).error).toBe('Folder could not be read');
  });

  // Regression: `~/<subdir>` must expand the tilde to the home directory, not
  // resolve relative to cwd (which produced <cwd>/~/<subdir> and 404'd, killing
  // autocomplete for every path past the first segment). Bare `~` always worked;
  // the gap was the subpath case.
  test('GET /browse expands ~ in a subpath, not relative to cwd', async () => {
    const app = createFsRoutes();
    const home = await json(await app.request('/browse?path=~'));
    const firstDir = home.data.entries[0];
    expect(firstDir).toBeDefined();

    const body = await json(
      await app.request(`/browse?path=~/${encodeURIComponent(firstDir.name)}`),
    );
    expect(body.success).toBe(true);
    expect(body.data.path).toBe(join(homedir(), firstDir.name));
    expect(body.data.path).not.toContain('/~/');
  });
});
