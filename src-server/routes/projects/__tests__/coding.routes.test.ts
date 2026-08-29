import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  codingOps: { add: vi.fn() },
  fileTreeOps: { add: vi.fn() },
}));

const { createCodingRoutes } = await import('../coding.js');
const { FileTreeService } = await import(
  '../../../services/projects/file-tree-service.js'
);

describe('Coding Routes', () => {
  let fileTreeDir: string;

  beforeAll(() => {
    fileTreeDir = mkdtempSync(join(tmpdir(), 'station-coding-routes-'));
  });

  afterAll(() => {
    rmSync(fileTreeDir, { recursive: true, force: true });
  });

  test('GET /files returns file tree', async () => {
    const svc = new FileTreeService();
    const app = createCodingRoutes(svc);
    const body = await json(
      await app.request(`/files?path=${encodeURIComponent(fileTreeDir)}`),
    );
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /files returns 400 without path', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/files');
    expect(res.status).toBe(400);
  });

  test('GET /files returns 400 for nonexistent path', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/files?path=/nonexistent/xyz');
    expect(res.status).toBe(400);
  });

  test('GET /files/search returns 400 without query', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/files/search?path=/tmp');
    expect(res.status).toBe(400);
  });

  test('GET /files/content returns 400 without path', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/files/content');
    expect(res.status).toBe(400);
  });

  test('GET /files/content returns 400 without the file param', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/files/content?path=/tmp');
    expect(res.status).toBe(400);
  });

  test('GET /files/content returns 500 for a nonexistent workspace root', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request(
      '/files/content?path=/nonexistent&file=file.txt',
    );
    expect(res.status).toBe(500);
  });

  test('POST /exec never returns raw CLI stderr on a command failure', async () => {
    const app = createCodingRoutes(new FileTreeService());
    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command:
          'sh -c "printf \'https://provider.example.test/private?token=secret-value\\n\' >&2; exit 7"',
        cwd: '/tmp',
      }),
    });
    const body = await json(res);

    expect(body).toEqual({
      success: false,
      error: { code: 'command_failed', exitCode: 7 },
    });
    expect(JSON.stringify(body)).not.toContain('provider');
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  describe('git routes on a non-repo directory', () => {
    let nonRepoDir: string;

    beforeAll(() => {
      // A fresh temp dir under the OS tmp root is not a git work tree.
      nonRepoDir = mkdtempSync(join(tmpdir(), 'station-nonrepo-'));
    });

    afterAll(() => {
      rmSync(nonRepoDir, { recursive: true, force: true });
    });

    test('GET /git/status returns 200 with isRepo:false (no 400)', async () => {
      const app = createCodingRoutes(new FileTreeService());
      const res = await app.request(
        `/git/status?path=${encodeURIComponent(nonRepoDir)}`,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data.isRepo).toBe(false);
    });

    test('GET /git/log returns 200 with an empty list on a non-repo', async () => {
      const app = createCodingRoutes(new FileTreeService());
      const res = await app.request(
        `/git/log?path=${encodeURIComponent(nonRepoDir)}`,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });
  });
});
