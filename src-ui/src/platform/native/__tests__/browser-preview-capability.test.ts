import { describe, expect, it } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import { WebNativePlatformAdapter } from '../web';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

const DESKTOP_REPORT = completeNativeCapabilityReport('macos', {
  'desktop-tray': { state: 'enabled' },
  haptics: { state: 'unsupported' },
  'local-browser-preview': { state: 'enabled' },
  'workspace-pane-pop-out': { state: 'enabled' },
});

function adapterReporting(payload: unknown) {
  return new TauriNativePlatformAdapter({
    invoke: async () => payload as never,
    listen: async () => () => {},
  });
}

describe('local browser preview host capability', () => {
  it('is unsupported in the web adapter', () => {
    const adapter = new WebNativePlatformAdapter();
    expect(adapter.capability('local-browser-preview')).toEqual({
      id: 'local-browser-preview',
      state: 'unsupported',
      reason:
        'Local browser previews require a reviewed native desktop host capability.',
    });
    return expect(
      adapter.openLocalBrowserPreview('http://localhost:5173/'),
    ).resolves.toMatchObject({
      status: 'unsupported',
      command: 'open-local-browser-preview',
    });
  });

  it('opens a generic pane window only after the native host reports support', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'native_capability_report') {
          return {
            platform: 'macos',
            capabilities: DESKTOP_REPORT.capabilities,
          } as never;
        }
        return undefined as never;
      },
      listen: async () => () => {},
    });
    const request = {
      projectId: 'project-uuid',
      projectSlug: 'project-route',
      layoutId: 'coding',
      descriptorId: 'pane:coding',
      instanceId: 'pane-instance',
    };

    await expect(
      adapter.openWorkspacePanePopOut(request),
    ).resolves.toMatchObject({
      status: 'unsupported',
      command: 'open-workspace-pane-pop-out',
    });
    await adapter.getCapabilityReport();
    await expect(adapter.openWorkspacePanePopOut(request)).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
    expect(calls.at(-1)).toEqual({
      command: 'open_workspace_pane_pop_out',
      args: { request },
    });

    await expect(
      new WebNativePlatformAdapter().openWorkspacePanePopOut(request),
    ).resolves.toMatchObject({
      status: 'unsupported',
      command: 'open-workspace-pane-pop-out',
      reason: 'Pane pop-out requires a supported native desktop host.',
    });
  });

  it('accepts a complete native desktop report and preserves its status', async () => {
    const adapter = adapterReporting({
      platform: 'macos',
      capabilities: DESKTOP_REPORT.capabilities,
      devBuild: false,
    });

    expect(await adapter.getCapabilityReport()).toMatchObject({
      status: 'ok',
    });
    expect(adapter.capability('local-browser-preview')).toEqual(
      DESKTOP_REPORT.capabilities.find(
        ({ id }) => id === 'local-browser-preview',
      ),
    );
  });

  it('rejects a report that omits the local browser-preview capability', async () => {
    const result = await adapterReporting({
      platform: 'macos',
      capabilities: DESKTOP_REPORT.capabilities.filter(
        ({ id }) => id !== 'local-browser-preview',
      ),
    }).getCapabilityReport();

    expect(result.status).toBe('error');
  });

  it('marks defaults unverified after a malformed report', async () => {
    const adapter = adapterReporting({ malformed: true });

    expect((await adapter.getCapabilityReport()).status).toBe('error');
    expect(adapter.capability('local-browser-preview')).toMatchObject({
      state: 'disabled',
      reportVerified: false,
    });
  });

  it('preserves typed native opener success and authority rejection', async () => {
    const calls: Array<{ command: string; url?: unknown }> = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, url: args?.url });
        if (command === 'native_capability_report') {
          return {
            platform: 'macos',
            capabilities: DESKTOP_REPORT.capabilities,
            devBuild: false,
          } as never;
        }
        if (
          args?.url === 'https://example.test/' ||
          args?.url === 'http://user:secret@localhost:5173/'
        ) {
          throw new Error(
            'Local preview URLs must use an exact loopback host.',
          );
        }
        return undefined as never;
      },
      listen: async () => () => {},
    });
    await adapter.getCapabilityReport();

    await expect(
      adapter.openLocalBrowserPreview('http://127.0.0.1:5173/'),
    ).resolves.toEqual({ status: 'ok', value: undefined });
    await expect(
      adapter.openLocalBrowserPreview('https://example.test/'),
    ).resolves.toMatchObject({
      status: 'error',
      command: 'open-local-browser-preview',
    });
    await expect(
      adapter.openLocalBrowserPreview('http://user:secret@localhost:5173/'),
    ).resolves.toMatchObject({
      status: 'error',
      command: 'open-local-browser-preview',
    });
    expect(calls).toEqual([
      { command: 'native_capability_report', url: undefined },
      { command: 'open_local_browser_preview', url: 'http://127.0.0.1:5173/' },
      { command: 'open_local_browser_preview', url: 'https://example.test/' },
      {
        command: 'open_local_browser_preview',
        url: 'http://user:secret@localhost:5173/',
      },
    ]);
  });

  it('admits browser previews only through native discovery before renderer creation', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'native_capability_report') {
          return {
            platform: 'macos',
            capabilities: DESKTOP_REPORT.capabilities,
          } as never;
        }
        if (command === 'discover_local_browser_preview_target') {
          return {
            status: 'issued',
            grantId: 'native-grant-1',
            expiresAtMs: 1_786_000_000_000,
          } as never;
        }
        return {
          status: 'rejected',
          code: 'grant-consumed',
          message: 'Station refused the already consumed preview grant.',
        } as never;
      },
      listen: async () => () => {},
    });
    await adapter.getCapabilityReport();

    await expect(
      adapter.discoverLocalBrowserPreviewTarget('http://127.0.0.1:5173/'),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        grantId: 'native-grant-1',
        expiresAtMs: 1_786_000_000_000,
        observation: { reachability: 'not-observed' },
      },
    });
    await expect(
      adapter.openLocalBrowserPreviewWindow('native-grant-1'),
    ).resolves.toEqual({
      status: 'error',
      command: 'open-local-browser-preview-window',
      code: 'grant-consumed',
      message: 'Station refused the already consumed preview grant.',
    });
    expect(calls.at(-2)).toEqual({
      command: 'discover_local_browser_preview_target',
      args: { url: 'http://127.0.0.1:5173/' },
    });
    expect(calls.at(-1)).toEqual({
      command: 'open_local_browser_preview_window',
      args: { grantId: 'native-grant-1' },
    });
  });

  it('preserves a bounded discovery refusal and never accepts a remote authority', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'native_capability_report') {
          return {
            platform: 'macos',
            capabilities: DESKTOP_REPORT.capabilities,
          } as never;
        }
        return {
          status: 'rejected',
          code: 'target-refused',
          message: 'The selected loopback server refused the connection.',
          observation: {
            reachability: 'refused',
            tls: 'not-applicable',
            navigation: 'not-observed',
            frame: 'not-applicable',
            renderer: 'not-created',
            title: 'not-observable',
            history: 'not-observable',
          },
        } as never;
      },
      listen: async () => () => {},
    });
    await adapter.getCapabilityReport();

    await expect(
      adapter.discoverLocalBrowserPreviewTarget('http://127.0.0.1:5173/'),
    ).resolves.toMatchObject({
      status: 'error',
      command: 'discover-local-browser-preview-target',
      code: 'target-refused',
      observation: { reachability: 'refused' },
    });
    expect(calls.at(-1)).toEqual({
      command: 'discover_local_browser_preview_target',
      args: { url: 'http://127.0.0.1:5173/' },
    });
  });
});
