/** @vitest-environment jsdom */

import {
  WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
  type WorkspaceBrowserPreviewState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { BrowserPreviewPane } from '../BrowserPreviewPane';

const PREVIEW: WorkspaceBrowserPreviewState = {
  contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
  requestedUrl: 'http://localhost:5173/',
  currentUrl: 'http://localhost:5173/',
  status: 'external-action-ready',
  historyCapability: 'unavailable',
  viewportPreference: 'responsive',
  updatedAt: '2026-08-02T12:00:00.000Z',
};

describe('BrowserPreviewPane', () => {
  test('derives the favicon from the current origin and re-keys it on navigation', () => {
    const { rerender } = render(
      <BrowserPreviewPane
        preview={PREVIEW}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
      />,
    );

    const initialFavicon = document.querySelector(
      '.browser-preview-pane__favicon-image',
    );
    expect(initialFavicon?.getAttribute('src')).toBe(
      'http://localhost:5173/favicon.ico',
    );

    fireEvent.error(initialFavicon as Element);
    expect(
      document.querySelector('.browser-preview-pane__favicon-glyph'),
    ).not.toBeNull();

    rerender(
      <BrowserPreviewPane
        preview={{
          ...PREVIEW,
          requestedUrl: 'http://127.0.0.1:4173/dashboard',
          currentUrl: 'http://127.0.0.1:4173/dashboard',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
      />,
    );

    expect(
      document
        .querySelector('.browser-preview-pane__favicon-image')
        ?.getAttribute('src'),
    ).toBe('http://127.0.0.1:4173/favicon.ico');
    expect(
      document.querySelector('.browser-preview-pane__favicon-glyph'),
    ).toBeNull();
  });

  test.each(['', 'about:blank'])(
    'does not render a favicon for an empty preview state: %s',
    (currentUrl) => {
      render(
        <BrowserPreviewPane
          preview={{ ...PREVIEW, requestedUrl: currentUrl, currentUrl }}
          onOpenExternal={vi.fn()}
        />,
      );

      expect(
        document.querySelector('.browser-preview-pane__favicon'),
      ).toBeNull();
    },
  );

  test('opens an external-action-ready target without mounting an uninspectable frame', async () => {
    const onOpenExternal = vi.fn().mockResolvedValue({
      status: 'ok',
      value: undefined,
    });
    render(
      <BrowserPreviewPane preview={PREVIEW} onOpenExternal={onOpenExternal} />,
    );

    expect(screen.queryByTitle('Local browser preview')).toBeNull();
    expect(screen.getByText(/cannot prove/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open externally' }));

    await waitFor(() => {
      expect(onOpenExternal).toHaveBeenCalledWith('http://localhost:5173/');
    });
    expect(screen.getByRole('status').textContent).toContain('Ready to open');
  });

  test('never mounts an invalid URL or offers it as an external target', () => {
    const onOpenExternal = vi.fn();
    render(
      <BrowserPreviewPane
        preview={{ ...PREVIEW, currentUrl: 'https://example.test/' }}
        onOpenExternal={onOpenExternal.mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
      />,
    );

    expect(screen.queryByTitle('Local browser preview')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('refused');
    expect(
      screen.queryByRole('button', { name: 'Open externally' }),
    ).toBeNull();
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  test('does not claim or enable the external action when the host marks it unavailable', () => {
    const onOpenExternal = vi.fn().mockResolvedValue({
      status: 'ok',
      value: undefined,
    });
    render(
      <BrowserPreviewPane
        preview={{ ...PREVIEW, status: 'unavailable' }}
        onOpenExternal={onOpenExternal}
        unavailableReason="The desktop native action is unavailable."
      />,
    );

    expect(screen.queryByTitle('Local browser preview')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Open externally' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByText(/desktop native action is unavailable/i),
    ).toBeTruthy();
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  test.each(['https://example.test/', 'http://user:secret@localhost:5173/'])(
    'refuses unsafe edits before they reach the persistence owner: %s',
    (unsafeAddress) => {
      const onChangeAddress = vi.fn(() => true);
      render(
        <BrowserPreviewPane
          preview={PREVIEW}
          onOpenExternal={vi.fn().mockResolvedValue({
            status: 'ok',
            value: undefined,
          })}
          onChangeAddress={onChangeAddress}
        />,
      );

      fireEvent.change(screen.getByLabelText('Preview address'), {
        target: { value: unsafeAddress },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Use local address' }),
      );

      expect(onChangeAddress).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toContain('allowed local');
    },
  );

  test('shows a typed native opener failure', async () => {
    render(
      <BrowserPreviewPane
        preview={{
          ...PREVIEW,
          requestedUrl: 'http://127.0.0.1:5173/',
          currentUrl: 'http://127.0.0.1:5173/',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'error',
          command: 'open-local-browser-preview',
          message: 'No system browser is available.',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open externally' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'No system browser is available.',
    );
  });

  test('shows a typed desktop renderer rejection without claiming reachability', async () => {
    const observation = {
      reachability: 'reachable' as const,
      tls: 'not-applicable' as const,
      navigation: 'not-observed' as const,
      frame: 'not-applicable' as const,
      renderer: 'not-created' as const,
      title: 'not-observable' as const,
      history: 'not-observable' as const,
    };
    const onDiscoverNativeTarget = vi.fn().mockResolvedValue({
      status: 'ok',
      value: {
        grantId: 'native-grant-1',
        expiresAtMs: 1_786_000_000_000,
        observation,
      },
    });
    const onOpenNativeWindow = vi.fn().mockResolvedValue({
      status: 'error',
      command: 'open-local-browser-preview-window',
      code: 'renderer-unavailable',
      message: 'The native WebView cannot be created.',
    });
    render(
      <BrowserPreviewPane
        preview={{
          ...PREVIEW,
          requestedUrl: 'http://127.0.0.1:5173/',
          currentUrl: 'http://127.0.0.1:5173/',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
        onDiscoverNativeTarget={onDiscoverNativeTarget}
        onOpenNativeWindow={onOpenNativeWindow}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Discover local server' }),
    );
    await waitFor(() => {
      expect(onDiscoverNativeTarget).toHaveBeenCalledWith(
        'http://127.0.0.1:5173/',
      );
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in desktop preview' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The native WebView cannot be created.',
    );
    expect(
      screen.getByRole('button', { name: 'Open in desktop preview' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByText(/separate untrusted window, not an in-pane frame/i),
    ).toBeTruthy();
  });

  test('requires rediscovery after a consumed grant fails, then clears the next successful grant', async () => {
    const observation = {
      reachability: 'reachable' as const,
      tls: 'not-applicable' as const,
      navigation: 'not-observed' as const,
      frame: 'not-applicable' as const,
      renderer: 'not-created' as const,
      title: 'not-observable' as const,
      history: 'not-observable' as const,
    };
    const onDiscoverNativeTarget = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          grantId: 'failed-grant',
          expiresAtMs: 1_786_000_000_000,
          observation,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          grantId: 'fresh-grant',
          expiresAtMs: 1_786_000_000_001,
          observation,
        },
      });
    const onOpenNativeWindow = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'error',
        command: 'open-local-browser-preview-window',
        code: 'renderer-unavailable',
        message: 'The native WebView cannot be created.',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          sessionId: 'fresh-grant',
          observation: {
            ...observation,
            navigation: 'policy-installed' as const,
            renderer: 'created-unverified' as const,
          },
        },
      });
    render(
      <BrowserPreviewPane
        preview={{
          ...PREVIEW,
          requestedUrl: 'http://127.0.0.1:5173/',
          currentUrl: 'http://127.0.0.1:5173/',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
        onDiscoverNativeTarget={onDiscoverNativeTarget}
        onOpenNativeWindow={onOpenNativeWindow}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Discover local server' }),
    );
    const openButton = screen.getByRole('button', {
      name: 'Open in desktop preview',
    });
    await waitFor(() => expect(openButton).toHaveProperty('disabled', false));
    fireEvent.click(openButton);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The native WebView cannot be created.',
    );
    expect(openButton).toHaveProperty('disabled', true);

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry local-server discovery' }),
    );
    await waitFor(() => expect(openButton).toHaveProperty('disabled', false));
    fireEvent.click(openButton);
    await waitFor(() =>
      expect(onOpenNativeWindow).toHaveBeenLastCalledWith('fresh-grant'),
    );
    await waitFor(() => expect(openButton).toHaveProperty('disabled', true));
  });

  test('clears a consumed grant when the native renderer invocation rejects', async () => {
    const observation = {
      reachability: 'reachable' as const,
      tls: 'not-applicable' as const,
      navigation: 'not-observed' as const,
      frame: 'not-applicable' as const,
      renderer: 'not-created' as const,
      title: 'not-observable' as const,
      history: 'not-observable' as const,
    };
    const onOpenNativeWindow = vi
      .fn()
      .mockRejectedValue(new Error('renderer invocation failed'));
    render(
      <BrowserPreviewPane
        preview={{
          ...PREVIEW,
          requestedUrl: 'http://127.0.0.1:5173/',
          currentUrl: 'http://127.0.0.1:5173/',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
        onDiscoverNativeTarget={vi.fn().mockResolvedValue({
          status: 'ok',
          value: {
            grantId: 'rejected-grant',
            expiresAtMs: 1_786_000_000_000,
            observation,
          },
        })}
        onOpenNativeWindow={onOpenNativeWindow}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Discover local server' }),
    );
    const openButton = screen.getByRole('button', {
      name: 'Open in desktop preview',
    });
    await waitFor(() => expect(openButton).toHaveProperty('disabled', false));
    fireEvent.click(openButton);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not create the desktop Browser Preview',
    );
    expect(openButton).toHaveProperty('disabled', true);
  });

  test('discards a discovery completion for an address that is no longer current', async () => {
    let resolveDiscovery:
      | ((value: {
          status: 'ok';
          value: {
            grantId: string;
            expiresAtMs: number;
            observation: {
              reachability: 'reachable';
              tls: 'not-applicable';
              navigation: 'not-observed';
              frame: 'not-applicable';
              renderer: 'not-created';
              title: 'not-observable';
              history: 'not-observable';
            };
          };
        }) => void)
      | undefined;
    const onDiscoverNativeTarget = vi.fn(
      () =>
        new Promise<{
          status: 'ok';
          value: {
            grantId: string;
            expiresAtMs: number;
            observation: {
              reachability: 'reachable';
              tls: 'not-applicable';
              navigation: 'not-observed';
              frame: 'not-applicable';
              renderer: 'not-created';
              title: 'not-observable';
              history: 'not-observable';
            };
          };
        }>((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    const onOpenNativeWindow = vi.fn();
    const initialPreview = {
      ...PREVIEW,
      requestedUrl: 'http://127.0.0.1:5173/',
      currentUrl: 'http://127.0.0.1:5173/',
    };
    const { rerender } = render(
      <BrowserPreviewPane
        preview={initialPreview}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
        onDiscoverNativeTarget={onDiscoverNativeTarget}
        onOpenNativeWindow={onOpenNativeWindow}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Discover local server' }),
    );
    rerender(
      <BrowserPreviewPane
        preview={{
          ...initialPreview,
          requestedUrl: 'http://127.0.0.1:4173/',
          currentUrl: 'http://127.0.0.1:4173/',
        }}
        onOpenExternal={vi.fn().mockResolvedValue({
          status: 'ok',
          value: undefined,
        })}
        onDiscoverNativeTarget={onDiscoverNativeTarget}
        onOpenNativeWindow={onOpenNativeWindow}
      />,
    );
    resolveDiscovery?.({
      status: 'ok',
      value: {
        grantId: 'stale-grant',
        expiresAtMs: 1_786_000_000_000,
        observation: {
          reachability: 'reachable',
          tls: 'not-applicable',
          navigation: 'not-observed',
          frame: 'not-applicable',
          renderer: 'not-created',
          title: 'not-observable',
          history: 'not-observable',
        },
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open in desktop preview' }),
      ).toHaveProperty('disabled', true);
    });
    expect(screen.queryByText(/native host reached/i)).toBeNull();
    expect(onOpenNativeWindow).not.toHaveBeenCalled();
  });
});
