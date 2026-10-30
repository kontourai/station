/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import { useProjectWorkspaceFilePreviewQuery } from '../query-domains/workspaceProjects';
import {
  downloadProjectWorkspaceFilePreview,
  readProjectWorkspaceVisualFile,
  WorkspaceVisualFileError,
} from '../workspace-file-preview';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('Workspace file preview query', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  test('uses the project-bound preview endpoint and preserves the typed result', async () => {
    _setApiBase('https://station.example.test');
    const preview = {
      path: 'src/main.ts',
      status: 'ready' as const,
      renderKind: 'source' as const,
      sizeBytes: 12,
      mimeType: 'text/plain',
      content: 'export {};',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: preview }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useProjectWorkspaceFilePreviewQuery('alpha', { path: 'src/main.ts' }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.data).toEqual(preview));
    expect(fetch).toHaveBeenCalledWith(
      'https://station.example.test/api/projects/alpha/file-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'src/main.ts' }),
      }),
    );
  });

  test('preserves the Project path and inclusive line range in the preview request', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              path: 'src/main.ts',
              status: 'ready',
              renderKind: 'source',
              lineRange: { start: 8, end: 12 },
              content: 'exact range',
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(
      () =>
        useProjectWorkspaceFilePreviewQuery('alpha', {
          path: 'src/main.ts',
          lineRange: { start: 8, end: 12 },
        }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      'https://station.example.test/api/projects/alpha/file-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          path: 'src/main.ts',
          lineRange: { start: 8, end: 12 },
        }),
      }),
    );
  });

  test('uses the authenticated POST attachment handoff with a JSON body, never a query path', async () => {
    _setApiBase('https://station.example.test');
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<h1>download</h1>'));
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
    }));

    await expect(
      downloadProjectWorkspaceFilePreview('alpha', 'docs/guide.html'),
    ).resolves.toEqual({
      filename: 'guide.html',
      bytes: new Uint8Array(Buffer.from('<h1>download</h1>')),
    });

    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://station.example.test/api/projects/alpha/file-preview/download',
    );
    expect(url).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ path: 'docs/guide.html' }));
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Station-Client-Origin')).toBe('1;unknown');
    expect(headers.has('Authorization')).toBe(false);
  });
});

describe('readProjectWorkspaceVisualFile failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function failureFor(response: Response) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const error = await readProjectWorkspaceVisualFile(
      'https://station.example.test',
      'alpha',
      '/work/alpha/shot.png',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceVisualFileError);
    return error as WorkspaceVisualFileError;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  test('a 401 is unauthorized, not an unavailable file', async () => {
    const error = await failureFor(
      json(401, { success: false, error: 'Authentication required' }),
    );
    expect(error.reason).toBe('unauthorized');
    expect(error.status).toBe(401);
  });

  test('a 403 without a refusal reason is unauthorized; with one it is the refusal', async () => {
    expect(
      (await failureFor(json(403, { success: false, error: 'Forbidden' })))
        .reason,
    ).toBe('unauthorized');
    expect(
      (
        await failureFor(
          json(403, { success: false, reason: 'outside-project' }),
        )
      ).reason,
    ).toBe('outside-project');
  });

  test('a 5xx, even a non-JSON one, is a server error', async () => {
    const error = await failureFor(
      new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    expect(error.reason).toBe('server-error');
  });

  test.each([
    [404, 'missing'],
    [404, 'no-workspace'],
    [415, 'unsupported-type'],
    [413, 'too-large'],
    [422, 'unreadable'],
  ] as const)('a %i naming %s keeps that reason', async (status, reason) => {
    expect(
      (await failureFor(json(status, { success: false, reason }))).reason,
    ).toBe(reason);
  });

  test('a reason paired with the wrong status, or an older host 404, is not believed', async () => {
    expect(
      (await failureFor(json(404, { success: false, reason: 'too-large' })))
        .reason,
    ).toBe('unavailable');
    expect(
      (
        await failureFor(
          json(404, {
            success: false,
            error: 'This visual file is unavailable in this Project.',
          }),
        )
      ).reason,
    ).toBe('unavailable');
  });
});
