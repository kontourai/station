import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { DiffCommentValidationError } from '../../../services/projects/diff-comment-service.js';
import {
  createDiffCommentRoutes,
  createDiffCommentsAggregateRoutes,
} from '../diff-comments.js';

const STORE_PATH = '/ws/.station/diff-comments.json';

const COMMENT = {
  id: 'c1',
  projectId: 'dev',
  filePath: 'src/foo.ts',
  side: 'additions' as const,
  lineNumber: 12,
  body: 'needs a guard',
  createdAt: '2026-06-28T00:00:00.000Z',
  updatedAt: '2026-06-28T00:00:00.000Z',
};

function createMockService(
  overrides: Partial<{
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    list: overrides.list ?? vi.fn().mockReturnValue([COMMENT]),
    create: overrides.create ?? vi.fn().mockReturnValue(COMMENT),
    delete: overrides.delete ?? vi.fn().mockReturnValue(true),
  };
}

function createApp(service = createMockService()) {
  const app = createDiffCommentRoutes(service as never, {
    resolveStorePath: (slug) => (slug === 'dev' ? STORE_PATH : undefined),
  });
  return { app, service };
}

async function request(
  app: ReturnType<typeof createApp>['app'],
  method: string,
  path: string,
  body?: unknown,
) {
  const { Hono } = await import('hono');
  const root = new Hono();
  root.route('/api/projects/:slug/diff-comments', app);
  const init: RequestInit =
    body !== undefined
      ? {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { method };
  return root.request(`http://localhost${path}`, init);
}

describe('diff comment routes', () => {
  test('GET lists comments for the project', async () => {
    const { app, service } = createApp();
    const res = await request(app, 'GET', '/api/projects/dev/diff-comments');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith(STORE_PATH, undefined);
  });

  test('GET passes the ?path filter through', async () => {
    const { app, service } = createApp();
    await request(
      app,
      'GET',
      '/api/projects/dev/diff-comments?path=src%2Ffoo.ts',
    );
    expect(service.list).toHaveBeenCalledWith(STORE_PATH, 'src/foo.ts');
  });

  test('POST creates a comment with the project as projectId', async () => {
    const { app, service } = createApp();
    const res = await request(app, 'POST', '/api/projects/dev/diff-comments', {
      filePath: 'src/foo.ts',
      side: 'additions',
      lineNumber: 12,
      body: 'needs a guard',
    });
    expect(res.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      STORE_PATH,
      expect.objectContaining({
        projectId: 'dev',
        filePath: 'src/foo.ts',
        side: 'additions',
        lineNumber: 12,
        body: 'needs a guard',
      }),
    );
  });

  test('POST rejects an invalid side with 400', async () => {
    const { app, service } = createApp();
    const res = await request(app, 'POST', '/api/projects/dev/diff-comments', {
      filePath: 'src/foo.ts',
      side: 'sideways',
      lineNumber: 12,
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  test('POST rejects an empty body with 400', async () => {
    const { app } = createApp();
    const res = await request(app, 'POST', '/api/projects/dev/diff-comments', {
      filePath: 'src/foo.ts',
      side: 'additions',
      lineNumber: 12,
      body: '   ',
    });
    expect(res.status).toBe(400);
  });

  test.each([
    ['an unsafe path', { filePath: '../outside.ts' }],
    ['an empty author id', { authorId: '' }],
  ])('POST returns 400 for %s', async (_label, override) => {
    const { app } = createApp(
      createMockService({
        create: vi.fn().mockImplementation(() => {
          throw new DiffCommentValidationError();
        }),
      }),
    );
    const res = await request(app, 'POST', '/api/projects/dev/diff-comments', {
      filePath: 'src/foo.ts',
      side: 'additions',
      lineNumber: 12,
      body: 'x',
      ...override,
    });

    expect(res.status).toBe(400);
    await expect(readJson(res)).resolves.toMatchObject({
      success: false,
      error: 'Invalid diff comment',
    });
  });

  test('DELETE removes a comment', async () => {
    const { app, service } = createApp();
    const res = await request(
      app,
      'DELETE',
      '/api/projects/dev/diff-comments/c1',
    );
    expect(res.status).toBe(200);
    expect(service.delete).toHaveBeenCalledWith(STORE_PATH, 'c1');
  });

  test('DELETE of a missing comment returns 404', async () => {
    const { app } = createApp(
      createMockService({ delete: vi.fn().mockReturnValue(false) }),
    );
    const res = await request(
      app,
      'DELETE',
      '/api/projects/dev/diff-comments/missing',
    );
    expect(res.status).toBe(404);
  });

  test('unknown project returns 404', async () => {
    const { app } = createApp();
    const res = await request(app, 'GET', '/api/projects/ghost/diff-comments');
    expect(res.status).toBe(404);
  });
});

describe('diff comment aggregate route', () => {
  test('GET lists comments across all project stores', async () => {
    const listAcross = vi.fn().mockReturnValue([COMMENT]);
    const listStorePaths = vi
      .fn()
      .mockReturnValue(['/a/.station/diff-comments.json']);
    const app = createDiffCommentsAggregateRoutes({ listAcross } as never, {
      listStorePaths,
    });
    const { Hono } = await import('hono');
    const root = new Hono();
    root.route('/api/diff-comments', app);

    const res = await root.request('http://localhost/api/diff-comments');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(listAcross).toHaveBeenCalledWith(['/a/.station/diff-comments.json']);
  });
});
