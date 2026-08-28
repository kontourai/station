/**
 * @vitest-environment jsdom
 */

import { setClientCredentialResolver } from '@kontourai/station-sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginRegistry } from '../core/PluginRegistry';
import { log } from '../utils/logger';

const ORIGIN = 'http://127.0.0.1:3141';

describe('PluginRegistry remote authentication', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.head
      .querySelectorAll('[data-station-plugin]')
      .forEach((node) => node.remove());
    document.head
      .querySelectorAll('[data-station-csp-nonce]')
      .forEach((node) => node.remove());
    delete (window as any).__station_ai_plugins;
    delete (window as any).__STATION_CSP_NONCE__;
    delete (window as any).__pluginActivationCount;
    delete (window as any).__pluginDisposalCount;
  });

  test('authenticates plugin inventory, CSS, and JavaScript bundle requests', async () => {
    // `ORIGIN` is cross-origin to this document, which is the desktop shell's
    // shape: the bundle URL is not admitted by `script-src 'self'`, so its
    // bytes are still fetched and executed under the shell nonce. The nonce
    // now comes only from the marker element Tauri rewrites — a page global
    // claiming to hold it is ignored (archive#4287).
    (window as any).__STATION_CSP_NONCE__ = 'a-global-any-plugin-could-read';
    const marker = document.createElement('script');
    marker.nonce = 'fixture-csp-nonce';
    marker.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(marker);
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'demo-layout', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('.demo {}');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ][]) {
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer remote-plugin-credential',
      );
    }
    expect(
      document.head.querySelector<HTMLScriptElement>(
        'script[data-station-plugin]',
      )?.nonce,
    ).toBe('fixture-csp-nonce');
  });

  test('registers a remote browser declaration without executing bundle bytes', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        plugins: [
          {
            name: 'remote-layout',
            version: '1.0.0',
            hasBundle: true,
            layout: { slug: 'remote-panel' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const registry = new PluginRegistry();
    registry.setApiBase('https://station.example.test');

    await expect(registry.reload()).resolves.toBe('ready');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.head.querySelector('[data-station-plugin]')).toBeNull();
    expect(registry.hasLayout('remote-panel')).toBe(true);
    expect((window as any).__station_ai_plugins).toBeUndefined();
  });

  test('uses the native platform adapter to reject an unapproved remote bundle', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new PluginRegistry(
      Promise.resolve({ platform: 'tauri' as const }),
    );
    registry.setApiBase('https://station.example.test');

    await expect(registry.reload()).resolves.toBe('degraded');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registry.getLoadStatus().failure).toBe('remote-isolation');
  });

  test('loads remote bundles only with explicit connection consent', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/api/plugins')) {
        return Response.json({
          plugins: [
            { name: 'remote-layout', version: '1.0.0', hasBundle: true },
          ],
        });
      }
      if (url.endsWith('/bundle.css')) return new Response('');
      if (url.endsWith('/bundle.js')) return new Response('void 0;');
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new PluginRegistry(
      Promise.resolve({ platform: 'tauri' as const }),
    );
    registry.setApiBase('https://station.example.test', 'profile-a', {
      allowRemoteBundles: true,
    });

    await expect(registry.reload()).resolves.toBe('degraded');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(registry.getLoadStatus().failure).toBe('bundle-load-failure');
  });

  test('binds a trusted layout to its exact local contribution, not its component name', async () => {
    const OwnerPanel = () => null;
    const DifferentPanel = () => null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return Response.json({
            plugins: [
              { name: 'trusted-owner', version: '1.2.3', hasBundle: true },
              { name: 'different-owner', version: '9.9.9', hasBundle: true },
            ],
          });
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      }),
    );
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLScriptElement) {
        const owner = node.dataset.stationPlugin?.includes('trusted-owner')
          ? 'trusted-owner'
          : 'different-owner';
        (window as any).__station_ai_plugins = {
          ...(window as any).__station_ai_plugins,
          [owner]: {
            components:
              owner === 'trusted-owner'
                ? {
                    'owner-panel': OwnerPanel,
                    'colliding-panel': OwnerPanel,
                  }
                : { 'colliding-panel': DifferentPanel },
          },
        };
      }
      return appendChild(node);
    });

    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await expect(registry.reload()).resolves.toBe('ready');
    const contribution = {
      id: 'plugin:trusted-owner:review',
      version: '1.2.3',
      sourceIdentity: {
        id: 'trusted-owner',
        kind: 'local' as const,
        source: 'plugins/trusted-owner',
      },
      provenance: { origin: 'plugin' as const, pluginId: 'trusted-owner' },
    };

    expect(registry.getTrustedLayout('owner-panel', contribution)).toBe(
      OwnerPanel,
    );
    // The later owner has the same component name, so the bound contribution
    // must not receive that different component.
    expect(
      registry.getTrustedLayout('colliding-panel', contribution),
    ).toBeNull();
    expect(
      registry.getTrustedLayout('owner-panel', {
        ...contribution,
        sourceIdentity: {
          ...contribution.sourceIdentity,
          kind: 'remote',
          source: 'https://plugins.example.test/trusted-owner',
        },
      }),
    ).toBeNull();
    expect(
      registry.getTrustedLayout('owner-panel', {
        ...contribution,
        version: '1.2.4',
      }),
    ).toBeNull();
  });

  test('clears stale exports before reload so a missing replacement export is degraded', async () => {
    let bundleLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return Response.json({
            plugins: [{ name: 'stale-layout', hasBundle: true }],
          });
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) {
          bundleLoads += 1;
          if (bundleLoads === 1) {
            (window as any).__station_ai_plugins = {
              'stale-layout': { default: () => null },
            };
          }
          return new Response('void 0;');
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    await expect(registry.reload()).resolves.toBe('ready');
    expect(registry.hasLayout('stale-layout')).toBe(true);

    await expect(registry.reload()).resolves.toBe('degraded');
    expect(registry.hasLayout('stale-layout')).toBe(false);
    expect(registry.getLoadStatus()).toEqual({
      state: 'degraded',
      failedPluginNames: ['stale-layout'],
      failure: 'bundle-load-failure',
    });
  });

  test('reports a missing plugin CSS bundle as a degraded extension failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return Response.json({
            plugins: [{ name: 'unstyled-layout', hasBundle: true }],
          });
        }
        if (url.endsWith('/bundle.css')) {
          return new Response('not found', { status: 404 });
        }
        return new Response('void 0;');
      }),
    );
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    await expect(registry.reload()).resolves.toBe('degraded');
    expect(registry.getLoadStatus()).toEqual({
      state: 'degraded',
      failedPluginNames: ['unstyled-layout'],
      failure: 'bundle-load-failure',
    });
  });

  test('invalidates a local plugin load across a local-remote-local Station switch', async () => {
    const cssGate = new Promise<void>(() => {});
    let notifyCssRequested!: () => void;
    const cssRequested = new Promise<void>((resolve) => {
      notifyCssRequested = resolve;
    });
    const requested: string[] = [];
    let cssRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requested.push(url);
        if (url === `${ORIGIN}/api/plugins`) {
          return Response.json({
            plugins: [{ name: 'stale-local-plugin', hasBundle: true }],
          });
        }
        if (url.endsWith('/bundle.css')) {
          cssRequests += 1;
          notifyCssRequested();
          if (cssRequests === 1) {
            await Promise.race([
              cssGate,
              new Promise<never>((_resolve, reject) => {
                init?.signal?.addEventListener(
                  'abort',
                  () => reject(new DOMException('Aborted', 'AbortError')),
                  { once: true },
                );
              }),
            ]);
          }
          return new Response('.stale {}');
        }
        return new Response('void 0;');
      }),
    );
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    const initializing = registry.reload();
    await cssRequested;
    registry.setApiBase('https://station.example.test');
    registry.setApiBase(ORIGIN);
    const queuedReload = registry.reload();
    await Promise.all([initializing, queuedReload]);

    expect(requested).toEqual([
      `${ORIGIN}/api/plugins`,
      `${ORIGIN}/api/plugins/stale-local-plugin/bundle.css`,
      `${ORIGIN}/api/plugins`,
      `${ORIGIN}/api/plugins/stale-local-plugin/bundle.css`,
      `${ORIGIN}/api/plugins/stale-local-plugin/bundle.js`,
    ]);
    expect(registry.listLayouts()).toEqual([]);
  });

  test('uses the replacement credential on a later reload', async () => {
    let credential = 'expired-credential';
    setClientCredentialResolver(() => ({ credential, origin: ORIGIN }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(new Response(JSON.stringify({ plugins: [] }))),
    );
    vi.stubGlobal('fetch', fetchMock);
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    await registry.initialize();
    credential = 'replacement-credential';
    await registry.reload();

    expect(
      new Headers(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
      ).get('Authorization'),
    ).toBe('Bearer expired-credential');
    expect(
      new Headers(
        (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers,
      ).get('Authorization'),
    ).toBe('Bearer replacement-credential');
  });

  test('disposes an activated plugin before reload removes its bundle', async () => {
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'activated-plugin', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      }),
    );
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLScriptElement) {
        (window as any).__station_ai_plugins = {
          ...(window as any).__station_ai_plugins,
          'activated-plugin': {
            activate() {
              (window as any).__pluginActivationCount =
                ((window as any).__pluginActivationCount ?? 0) + 1;
              return () => {
                (window as any).__pluginDisposalCount =
                  ((window as any).__pluginDisposalCount ?? 0) + 1;
              };
            },
          },
        };
      }
      return appendChild(node);
    });
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    await registry.initialize();
    await registry.reload();

    expect((window as any).__pluginActivationCount).toBe(2);
    expect((window as any).__pluginDisposalCount).toBe(1);
  });

  test('serializes concurrent reloads so every activation retains one disposer', async () => {
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'activated-plugin', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      }),
    );
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLScriptElement) {
        (window as any).__station_ai_plugins = {
          'activated-plugin': {
            activate() {
              (window as any).__pluginActivationCount =
                ((window as any).__pluginActivationCount ?? 0) + 1;
              return () => {
                (window as any).__pluginDisposalCount =
                  ((window as any).__pluginDisposalCount ?? 0) + 1;
              };
            },
          },
        };
      }
      return appendChild(node);
    });
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    const first = registry.reload();
    const second = registry.reload();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect((window as any).__pluginActivationCount).toBe(3);
    expect((window as any).__pluginDisposalCount).toBe(2);
  });

  test('runs a trailing reload when inventory changes during bundle loading', async () => {
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    let inventoryRequestCount = 0;
    let bundleRequestCount = 0;
    let releaseReloadBundle!: () => void;
    const reloadBundleGate = new Promise<void>((resolve) => {
      releaseReloadBundle = resolve;
    });
    let notifyReloadBundleRequested!: () => void;
    const reloadBundleRequested = new Promise<void>((resolve) => {
      notifyReloadBundleRequested = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          inventoryRequestCount += 1;
          return new Response(
            JSON.stringify({
              plugins:
                inventoryRequestCount < 3
                  ? [{ name: 'activated-plugin', hasBundle: true }]
                  : [],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) {
          bundleRequestCount += 1;
          if (bundleRequestCount === 2) {
            notifyReloadBundleRequested();
            await reloadBundleGate;
          }
          return new Response('void 0;');
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLScriptElement) {
        (window as any).__station_ai_plugins = {
          'activated-plugin': {
            activate() {
              (window as any).__pluginActivationCount =
                ((window as any).__pluginActivationCount ?? 0) + 1;
              return () => {
                (window as any).__pluginDisposalCount =
                  ((window as any).__pluginDisposalCount ?? 0) + 1;
              };
            },
          },
        };
      }
      return appendChild(node);
    });
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    const first = registry.reload();
    await reloadBundleRequested;
    const second = registry.reload();
    expect(second).toBe(first);
    releaseReloadBundle();
    await first;

    expect(inventoryRequestCount).toBe(3);
    expect(registry.listLayouts()).toEqual([]);
    expect((window as any).__pluginActivationCount).toBe(2);
    expect((window as any).__pluginDisposalCount).toBe(2);
  });

  test('does not log provider authorization when plugin activation throws', async () => {
    const authorizationCanary = 'signed-provider-token-canary';
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'throwing-plugin', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('');
        if (url.endsWith('/bundle.js')) {
          (window as any).__station_ai_plugins = {
            'throwing-plugin': {
              activate() {
                throw new Error(authorizationCanary);
              },
            },
          };
          return new Response('void 0;');
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const logSpy = vi.spyOn(log, 'api');
    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);

    await registry.initialize();

    expect(registry.listLayouts()).toEqual([]);
    expect(logSpy.mock.calls.flat().map(String).join('\n')).not.toContain(
      authorizationCanary,
    );
  });

  test("uses Tauri's injected document nonce when the server nonce is unavailable", async () => {
    const tauriScript = document.createElement('script');
    tauriScript.nonce = 'tauri-injected-nonce';
    tauriScript.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(tauriScript);
    setClientCredentialResolver(() => ({
      credential: 'remote-plugin-credential',
      origin: ORIGIN,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'demo-layout', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('.demo {}');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      }),
    );

    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    expect(
      document.head.querySelector<HTMLScriptElement>(
        'script[data-station-plugin]',
      )?.nonce,
    ).toBe('tauri-injected-nonce');
  });
});
