import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  codingOps: { add: vi.fn() },
  fileTreeOps: { add: vi.fn() },
}));

const { createCodingRoutes } = await import('../coding.js');
const { FileTreeService } = await import(
  '../../../services/projects/file-tree-service.js'
);

let project: string;
let nonRepoDir: string;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'station-coding-project-'));
  // A fresh temp dir under the OS tmp root is not a git work tree.
  nonRepoDir = mkdtempSync(join(tmpdir(), 'station-nonrepo-'));
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(nonRepoDir, { recursive: true, force: true });
});

/** The routes for Project `p`, whose folder is `root`. */
function appFor(root = project) {
  return createCodingRoutes(new FileTreeService(), {
    resolveProjectFolder: (slug) => (slug === 'p' ? root : undefined),
  });
}

/** Mounted behind the principal the auth boundary stamps for the operator
 * credential, which `/exec` requires of a caller without a grant. */
function asOperator(app: Hono) {
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
  mounted.route('/', app);
  return mounted;
}

describe('Coding Routes', () => {
  test('GET /files returns file tree', async () => {
    const body = await json(
      await appFor().request(
        `/files?projectSlug=p&path=${encodeURIComponent(project)}`,
      ),
    );
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /files refuses a request that names no Project', async () => {
    const res = await appFor().request(
      `/files?path=${encodeURIComponent(project)}`,
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('project-required');
  });

  test('GET /files returns 409 for a nonexistent path', async () => {
    const res = await appFor().request(
      `/files?projectSlug=p&path=${encodeURIComponent(join(project, 'nope'))}`,
    );
    expect(res.status).toBe(409);
  });

  test('GET /files/search returns 400 without query', async () => {
    const res = await appFor().request('/files/search?projectSlug=p');
    expect(res.status).toBe(400);
  });

  test('GET /files/search preserves the data array and adds scan metadata', async () => {
    const body = await json(
      await appFor().request('/files/search?projectSlug=p&query=&maxResults=2'),
    );
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.scanTruncated).toBe('boolean');
  });

  test('GET /files/content refuses a request that names no Project', async () => {
    const res = await appFor().request('/files/content?file=x.txt');
    expect(res.status).toBe(400);
  });

  test('GET /files/content returns 400 without the file param', async () => {
    const res = await appFor().request('/files/content?projectSlug=p');
    expect(res.status).toBe(400);
  });

  test('GET /files/content answers 409 for a nonexistent workspace root', async () => {
    const res = await appFor('/nonexistent').request(
      '/files/content?projectSlug=p&file=file.txt',
    );
    expect(res.status).toBe(409);
  });

  test('POST /exec never returns raw CLI stderr on a command failure', async () => {
    const res = await asOperator(appFor()).request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectSlug: 'p',
        command:
          'sh -c "printf \'https://provider.example.test/private?token=secret-value\\n\' >&2; exit 7"',
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
    test('GET /git/status returns 200 with isRepo:false (no 400)', async () => {
      const res = await appFor(nonRepoDir).request(
        `/git/status?projectSlug=p&path=${encodeURIComponent(nonRepoDir)}`,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data.isRepo).toBe(false);
    });

    test('GET /git/log returns 200 with an empty list on a non-repo', async () => {
      const res = await appFor(nonRepoDir).request(
        `/git/log?projectSlug=p&path=${encodeURIComponent(nonRepoDir)}`,
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });
  });
});
