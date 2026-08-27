import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

const { createWorkspacePanePreviewRoutes } = await import(
  '../workspace-pane-previews.js'
);

describe('Workspace Pane preview routes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function appFor(workingDirectory: string) {
    const app = new Hono();
    app.route(
      '/:slug/file-preview',
      createWorkspacePanePreviewRoutes({
        getProject: vi.fn((slug: string) => {
          if (slug !== 'alpha') throw new Error('Not found');
          return { workingDirectory };
        }),
      } as any),
    );
    return app;
  }

  test('reads only from the route project working directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    writeFileSync(join(workspace, 'readme.txt'), 'inside');
    const response = await appFor(workspace).request('/alpha/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'readme.txt' }),
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      path: 'readme.txt',
      status: 'ready',
      content: 'inside',
    });
    expect(JSON.stringify(body)).not.toContain(workspace);
  });

  test.each([
    ['guide.html', '<script>nope()</script>'],
    ['guide.pdf', '%PDF-1.7 bounded attachment'],
  ])(
    'serves %s only as a bounded POST attachment, never a trusted document',
    async (path, content) => {
      const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
      tempDirs.push(workspace);
      writeFileSync(join(workspace, path), content);
      const response = await appFor(workspace).request(
        '/alpha/file-preview/download',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/octet-stream',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe('sandbox');
      expect(await response.text()).toBe(content);
    },
  );

  test('encodes unusual attachment names with RFC 5987 escaping and no raw CRLF', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    const path = "odd'()*\r\nSet-Cookie: nope.html";
    writeFileSync(join(workspace, path), '<h1>bounded</h1>');

    const response = await appFor(workspace).request(
      '/alpha/file-preview/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      },
    );

    const disposition = response.headers.get('content-disposition');
    expect(response.status).toBe(200);
    expect(disposition).toBe(
      "attachment; filename*=UTF-8''odd%27%28%29%2A%0D%0ASet-Cookie%3A%20nope.html",
    );
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  test('refuses non-HTML/PDF download requests without exposing a file path', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'not a browser handoff');
    const response = await appFor(workspace).request(
      '/alpha/file-preview/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'notes.txt' }),
      },
    );

    expect(response.status).toBe(404);
    expect(JSON.stringify(await json(response))).not.toContain(workspace);
  });

  test('does not accept attachment paths in a GET query', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    writeFileSync(join(workspace, 'guide.html'), '<b>not a GET</b>');

    const response = await appFor(workspace).request(
      '/alpha/file-preview/download?path=guide.html',
    );

    expect(response.status).toBe(404);
  });

  test('masks bad paths and unavailable projects without exposing host details', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    const app = appFor(workspace);
    const invalid = await app.request('/alpha/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../secret.txt' }),
    });
    const absent = await app.request('/missing/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'readme.txt' }),
    });

    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toEqual({
      success: false,
      error: 'Invalid file preview path',
    });
    expect(absent.status).toBe(404);
    expect(JSON.stringify(await json(absent))).not.toContain(workspace);
  });

  test('rejects malformed preview requests at the transport boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    const response = await appFor(workspace).request('/alpha/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'readme.txt',
        lineRange: { start: 4, end: 3 },
      }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Invalid file preview request',
    });
  });

  test('rejects a caller-supplied root rather than treating it as filesystem authority', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-preview-route-'));
    tempDirs.push(workspace);
    const response = await appFor(workspace).request('/alpha/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'readme.txt', root: '/tmp' }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      success: false,
      error: 'Validation failed',
    });
  });
});
