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
import { downloadProjectWorkspaceFilePreview } from '../workspace-file-preview';

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
