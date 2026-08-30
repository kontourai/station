/** @vitest-environment jsdom */

import { useConnections } from '@kontourai/station-connect';
import {
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  NativeBrowserPreviewGrantResponse,
  NativeBrowserPreviewWindowResponse,
  NativePlatformAdapter,
} from '../../platform/native';
import { completeNativeCapabilityReport } from '../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import { TauriNativePlatformAdapter } from '../../platform/native/tauri';

const mocks = vi.hoisted(() => ({
  boundIdentity: {
    state: 'resolved' as const,
    project: { id: 'project-uuid-1', slug: 'project-slug' },
  },
  nativePlatformPromise: Promise.resolve({
    capability: () => ({
      id: 'local-browser-preview',
      state: 'enabled' as const,
      reason: 'fixture',
    }),
    openLocalBrowserPreview: vi.fn().mockResolvedValue({
      status: 'ok',
      value: undefined,
    }),
  } as never) as Promise<NativePlatformAdapter>,
  profile: {
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  },
  nativeProfileStorage: {
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => 'fixture-profile',
    makeDefault: async () => {
      throw new Error('No saved native Station is configured by this fixture.');
    },
    authorizeActiveConnection: async () => false,
  },
}));

vi.mock('../../platform/native', () => ({
  get nativePlatformPromise() {
    return mocks.nativePlatformPromise;
  },
}));

vi.mock('../../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => mocks.nativeProfileStorage,
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => mocks.profile,
}));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => mocks.boundIdentity,
}));

import { ApiBaseProvider } from '../../contexts/ApiBaseContext';
import { createBrowserPreviewPaneInstance } from '../browserPreviewPaneInstance';
import { writeBrowserPreviewPaneState } from '../browserPreviewPaneStateStorage';

const state = {
  version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
  projectId: 'project-uuid-1',
  requestedUrl: 'http://127.0.0.1:4173/',
  viewportPreference: 'responsive' as const,
  updatedAt: '2026-08-09T12:00:00.000Z',
};

const observation = {
  reachability: 'reachable' as const,
  tls: 'not-applicable' as const,
  navigation: 'not-observed' as const,
  frame: 'not-applicable' as const,
  renderer: 'not-created' as const,
  title: 'not-observable' as const,
  history: 'not-observable' as const,
};

const DESKTOP_REPORT = completeNativeCapabilityReport('macos', {
  'desktop-tray': { state: 'enabled' },
  haptics: { state: 'unsupported' },
  'local-browser-preview': { state: 'enabled' },
  'workspace-pane-pop-out': { state: 'enabled' },
});
type NativeBrowserPreviewGrantBridgeCall = (
  value: string,
) => Promise<NativeBrowserPreviewGrantResponse>;
type NativeBrowserPreviewWindowBridgeCall = (
  value: string,
) => Promise<NativeBrowserPreviewWindowResponse>;

async function nativeDesktopPreviewPlatform({
  discoverLocalBrowserPreviewTarget,
  openLocalBrowserPreviewWindow,
}: {
  discoverLocalBrowserPreviewTarget: ReturnType<
    typeof vi.fn<NativeBrowserPreviewGrantBridgeCall>
  >;
  openLocalBrowserPreviewWindow: ReturnType<
    typeof vi.fn<NativeBrowserPreviewWindowBridgeCall>
  >;
}): Promise<NativePlatformAdapter> {
  const adapter = new TauriNativePlatformAdapter({
    invoke: async (command, args) => {
      if (command === 'native_capability_report') {
        return {
          platform: 'macos',
          capabilities: DESKTOP_REPORT.capabilities,
          devBuild: false,
        } as never;
      }
      if (command === 'discover_local_browser_preview_target') {
        return discoverLocalBrowserPreviewTarget(args?.url as string) as never;
      }
      if (command === 'open_local_browser_preview_window') {
        return openLocalBrowserPreviewWindow(args?.grantId as string) as never;
      }
      return undefined as never;
    },
    listen: async () => () => {},
  });
  const report = await adapter.getCapabilityReport();
  if (report.status !== 'ok') {
    throw new Error('Fixture native capability report was not accepted.');
  }
  return adapter;
}

function ConnectionProbe() {
  const { connections } = useConnections();
  return (
    <output data-testid="connection-ids">
      {connections.map((connection) => connection.id).join(',')}
    </output>
  );
}

afterEach(() => {
  window.localStorage.clear();
  mocks.boundIdentity = {
    state: 'resolved',
    project: { id: 'project-uuid-1', slug: 'project-slug' },
  };
  mocks.profile = {
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  };
});

/**
 * BrowserPreviewWorkspacePane imports the native promise once. Reload the
 * pane module after each fixture installs its exact native adapter so a
 * settled promise from an earlier test cannot race the next discovery flow.
 */
beforeEach(() => {
  vi.resetModules();
});

async function loadBrowserPreviewWorkspacePane() {
  return import('../BrowserPreviewWorkspacePane');
}

describe('BrowserPreviewWorkspacePane', () => {
  test('restores metadata into an external-action-ready projection and delegates to the native host', async () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    )!;
    writeBrowserPreviewPaneState(window.localStorage, instance.stateKey, state);
    const openLocalBrowserPreview = vi.fn().mockResolvedValue({
      status: 'ok',
      value: undefined,
    });
    mocks.nativePlatformPromise = Promise.resolve({
      capability: () => ({
        id: 'local-browser-preview',
        state: 'enabled' as const,
        reason: 'fixture',
      }),
      openLocalBrowserPreview,
    } as never);
    const { BrowserPreviewWorkspacePane } =
      await loadBrowserPreviewWorkspacePane();

    render(
      <BrowserPreviewWorkspacePane
        descriptor={WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );

    expect(screen.queryByTitle('Local browser preview')).toBeNull();
    expect(
      await screen.findByText(/Ready to open this local preview/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open externally' }));
    await waitFor(() => {
      expect(openLocalBrowserPreview).toHaveBeenCalledWith(
        'http://127.0.0.1:4173/',
      );
    });
  });

  test('rejects a restored occurrence whose bound canonical project differs', async () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    )!;
    writeBrowserPreviewPaneState(window.localStorage, instance.stateKey, state);
    const { BrowserPreviewWorkspacePane } =
      await loadBrowserPreviewWorkspacePane();

    mocks.boundIdentity = {
      state: 'resolved',
      project: { id: 'project-uuid-2', slug: 'project-slug' },
    };
    render(
      <BrowserPreviewWorkspacePane
        descriptor={WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );

    expect(
      screen.getByText('This pane’s saved contents are missing'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Station either can’t find them or they belong to a different pane.',
      ),
    ).toBeTruthy();
  });

  test('discovers a native-owned target then launches the desktop renderer without a connection endpoint', async () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    )!;
    writeBrowserPreviewPaneState(window.localStorage, instance.stateKey, state);
    const openLocalBrowserPreviewWindow = vi
      .fn<NativePlatformAdapter['openLocalBrowserPreviewWindow']>()
      .mockResolvedValue({
        status: 'ok',
        value: {
          sessionId: '0123456789abcdef0123456789abcdef',
          observation: {
            ...observation,
            navigation: 'policy-installed' as const,
            renderer: 'created-unverified' as const,
          },
        },
      });
    const discoverLocalBrowserPreviewTarget = vi
      .fn<NativePlatformAdapter['discoverLocalBrowserPreviewTarget']>()
      .mockResolvedValue({
        status: 'ok',
        value: {
          grantId: 'native-grant-1',
          expiresAtMs: 1_786_000_000_000,
          observation,
        },
      });
    mocks.nativePlatformPromise = Promise.resolve({
      capability: () => ({
        id: 'local-browser-preview',
        state: 'enabled' as const,
        reason: 'fixture',
      }),
      openLocalBrowserPreview: vi.fn(),
      discoverLocalBrowserPreviewTarget,
      openLocalBrowserPreviewWindow,
    } as never);
    const { BrowserPreviewWorkspacePane } =
      await loadBrowserPreviewWorkspacePane();

    render(
      <BrowserPreviewWorkspacePane
        descriptor={WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR}
        instance={instance}
      />,
    );
    const discoverButton = await screen.findByRole('button', {
      name: 'Discover local server',
    });
    await waitFor(() =>
      expect(discoverButton).toHaveProperty('disabled', false),
    );
    fireEvent.click(discoverButton);
    await waitFor(() => {
      expect(discoverLocalBrowserPreviewTarget).toHaveBeenCalledWith(
        'http://127.0.0.1:4173/',
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Open in desktop preview',
        }),
      ).toHaveProperty('disabled', false);
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in desktop preview' }),
    );
    await waitFor(() => {
      expect(openLocalBrowserPreviewWindow).toHaveBeenCalledWith(
        'native-grant-1',
      );
    });
  });

  test('composes under the production ApiBaseProvider without fabricating a managed-loopback connection', async () => {
    const instance = createBrowserPreviewPaneInstance(
      state,
      'project-uuid-1',
      '0123456789abcdef0123456789abcdef',
    )!;
    writeBrowserPreviewPaneState(window.localStorage, instance.stateKey, state);
    const discoverLocalBrowserPreviewTarget = vi
      .fn<NativeBrowserPreviewGrantBridgeCall>()
      .mockResolvedValue({
        status: 'issued',
        grantId: 'native-grant-2',
        expiresAtMs: 1_786_000_000_000,
        observation,
      });
    const openLocalBrowserPreviewWindow = vi
      .fn<NativeBrowserPreviewWindowBridgeCall>()
      .mockResolvedValue({
        status: 'opened',
        sessionId: 'native-grant-2',
        observation: {
          ...observation,
          navigation: 'policy-installed' as const,
          renderer: 'created-unverified' as const,
        },
      });
    mocks.profile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
      isDevBuild: false,
    };
    mocks.nativePlatformPromise = nativeDesktopPreviewPlatform({
      discoverLocalBrowserPreviewTarget,
      openLocalBrowserPreviewWindow,
    });
    const { BrowserPreviewWorkspacePane } =
      await loadBrowserPreviewWorkspacePane();

    render(
      <ApiBaseProvider>
        <ConnectionProbe />
        <BrowserPreviewWorkspacePane
          descriptor={WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR}
          instance={instance}
        />
      </ApiBaseProvider>,
    );

    expect(
      (await screen.findByTestId('connection-ids')).textContent,
    ).not.toContain('managed-loopback');
    const discoverButton = await screen.findByRole('button', {
      name: 'Discover local server',
    });
    await waitFor(() =>
      expect(discoverButton).toHaveProperty('disabled', false),
    );
    fireEvent.click(discoverButton);
    await waitFor(() => {
      expect(discoverLocalBrowserPreviewTarget).toHaveBeenCalledWith(
        'http://127.0.0.1:4173/',
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Open in desktop preview',
        }),
      ).toHaveProperty('disabled', false);
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in desktop preview' }),
    );
    await waitFor(() => {
      expect(openLocalBrowserPreviewWindow).toHaveBeenCalledWith(
        'native-grant-2',
      );
    });
  });
});
