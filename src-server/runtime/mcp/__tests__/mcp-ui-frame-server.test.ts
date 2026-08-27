import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  mcpUiFrameServeTotal: { add: vi.fn() },
}));

const {
  buildMcpAppsSandboxProxyDocument,
  createMcpUiFrameApp,
  resolveMcpUiFrameAncestors,
} = await import('../mcp-ui-frame-server.js');

interface ProxyFrame {
  title: string;
  sandbox: { value: string };
  allow?: string;
  srcdoc?: string;
  contentWindow: { postMessage: ReturnType<typeof vi.fn> };
}

interface ProxyMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

function runProxyDocument(frameAncestors: readonly string[] = []) {
  let messageListener: ((event: ProxyMessageEvent) => void) | undefined;
  let mountedFrame: ProxyFrame | undefined;
  const parent = { postMessage: vi.fn() };
  const app = {
    replaceChildren: vi.fn((frame: ProxyFrame) => {
      mountedFrame = frame;
    }),
  };
  const document = {
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe('iframe');
      return {
        title: '',
        sandbox: { value: '' },
        contentWindow: { postMessage: vi.fn() },
      } satisfies ProxyFrame;
    }),
    getElementById: vi.fn((id: string) => {
      expect(id).toBe('app');
      return app;
    }),
  };
  const window = {
    parent,
    addEventListener: vi.fn(
      (type: string, listener: (event: ProxyMessageEvent) => void) => {
        expect(type).toBe('message');
        messageListener = listener;
      },
    ),
  };
  const html = buildMcpAppsSandboxProxyDocument(
    'behavior-test',
    frameAncestors,
  );
  const script = html.match(
    /<script nonce="behavior-test">([\s\S]*?)<\/script>/,
  )?.[1];
  if (!script) throw new Error('sandbox proxy script was not emitted');
  runInNewContext(script, { document, URL, window });

  return {
    parent,
    dispatch: (event: ProxyMessageEvent) => {
      expect(messageListener).toBeDefined();
      messageListener?.(event);
    },
    mountedFrame: () => mountedFrame,
  };
}

describe('MCP Apps sandbox proxy', () => {
  test('serves the isolated proxy and reserved lifecycle', async () => {
    const app = createMcpUiFrameApp({
      frameAncestors: ['https://station.example.test'],
    });
    const response = await app.request('/mcp-ui/proxy', {
      headers: { referer: 'https://station.example.test/layout' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://station.example.test',
    );
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin',
    );
    expect(response.headers.get('set-cookie')).toBeNull();

    const html = await response.text();
    expect(html).toContain('ui/notifications/sandbox-proxy-ready');
    expect(html).toContain('ui/notifications/sandbox-resource-ready');
    expect(html).toContain('event.source === window.parent');
    expect(html).toContain('event.source === inner.contentWindow');
    expect(html).toContain("startsWith('ui/notifications/sandbox-')");
    expect(html).toContain('replaceChildren(frame)');
  });

  test('allows a configured opaque Tauri parent with a blank referrer', () => {
    const harness = runProxyDocument(['tauri://localhost']);

    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-proxy-ready',
        params: {},
      },
      '*',
    );

    harness.dispatch({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          html: '<main>trusted host payload</main>',
          sandbox:
            'allow-scripts allow-same-origin allow-popups allow-top-navigation',
          permissions: {
            camera: {},
            microphone: true,
            geolocation: {},
            clipboardWrite: {},
            midi: {},
          },
        },
      },
      origin: 'null',
      source: harness.parent,
    });

    const frame = harness.mountedFrame();
    expect(frame?.sandbox.value).toBe('allow-scripts');
    expect(frame?.allow).toBe('camera; geolocation; clipboard-write');
    expect(frame?.allow).not.toContain('microphone');
    expect(frame?.allow).not.toContain('midi');

    const appMessage = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'example' },
    };
    harness.dispatch({
      data: appMessage,
      origin: 'null',
      source: frame?.contentWindow,
    });
    expect(harness.parent.postMessage).toHaveBeenCalledWith(appMessage, '*');
  });

  test('emits and accepts nothing without a configured frame parent', () => {
    const harness = runProxyDocument();
    expect(harness.parent.postMessage).not.toHaveBeenCalled();

    harness.dispatch({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<main>must not mount</main>' },
      },
      origin: 'https://station.example.test',
      source: harness.parent,
    });
    expect(harness.mountedFrame()).toBeUndefined();
    expect(harness.parent.postMessage).not.toHaveBeenCalled();
  });

  test('does not accept an opaque parent or emit a wildcard without configured Tauri', () => {
    const harness = runProxyDocument(['https://station.example.test']);
    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ui/notifications/sandbox-proxy-ready',
      }),
      'https://station.example.test',
    );
    expect(harness.parent.postMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      '*',
    );

    harness.dispatch({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<main>opaque attacker payload</main>' },
      },
      origin: 'null',
      source: harness.parent,
    });
    expect(harness.mountedFrame()).toBeUndefined();
  });

  test('binds an exact configured HTTP parent without a referrer', () => {
    const harness = runProxyDocument(['https://station.example.test']);
    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ui/notifications/sandbox-proxy-ready',
      }),
      'https://station.example.test',
    );

    harness.dispatch({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<main>accepted configured parent</main>' },
      },
      origin: 'https://station.example.test',
      source: harness.parent,
    });
    expect(harness.mountedFrame()?.srcdoc).toContain(
      'accepted configured parent',
    );
  });

  test('rejects a mismatched parent origin before it can load a resource', () => {
    const harness = runProxyDocument(['https://station.example.test']);
    expect(harness.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ui/notifications/sandbox-proxy-ready',
      }),
      'https://station.example.test',
    );

    harness.dispatch({
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<main>attacker payload</main>' },
      },
      origin: 'https://attacker.example.test',
      source: harness.parent,
    });
    expect(harness.mountedFrame()).toBeUndefined();
    expect(harness.parent.postMessage).toHaveBeenCalledTimes(1);
  });

  test('uses a fresh script nonce for each proxy document', async () => {
    const app = createMcpUiFrameApp();
    const first = await (await app.request('/mcp-ui/proxy')).text();
    const second = await (await app.request('/mcp-ui/proxy')).text();
    expect(first).not.toBe(second);
  });

  test('serves the isolated plugin frame with the proxy header regime and a fresh nonce', async () => {
    const app = createMcpUiFrameApp({
      frameAncestors: ['https://station.example.test'],
    });
    const first = await app.request('/plugin-host/frame');
    const second = await app.request('/plugin-host/frame');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://station.example.test',
    );
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect(first.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin',
    );
    expect(await first.text()).not.toBe(await second.text());
  });

  test('fails closed when no Station frame ancestor is configured', async () => {
    const app = createMcpUiFrameApp();
    const response = await app.request('/mcp-ui/proxy');
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'",
    );
  });

  test('builds exact configured Station UI origins for framing', () => {
    expect(
      resolveMcpUiFrameAncestors({
        port: 3141,
        host: 'station.example.test',
        additionalOrigins: [
          'https://remote.example.test/path',
          'not an origin',
          'javascript:alert(1)',
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'http://localhost:3141',
        'http://127.0.0.1:3141',
        'http://[::1]:3141',
        'tauri://localhost',
        'https://tauri.localhost',
        'http://tauri.localhost',
        'http://station.example.test:3141',
        'https://station.example.test:3141',
        'https://remote.example.test',
      ]),
    );
  });

  test('serves nothing else from the sandbox origin', async () => {
    const app = createMcpUiFrameApp();
    expect((await app.request('/')).status).toBe(404);
    expect((await app.request('/api/agents')).status).toBe(404);
    expect((await app.request('/mcp-ui/frame')).status).toBe(404);
    expect((await app.request('/plugin-host/anything.js')).status).toBe(404);
  });
});
