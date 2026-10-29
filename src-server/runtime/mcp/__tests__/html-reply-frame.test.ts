import { runInNewContext } from 'node:vm';
import { buildHtmlReplyProxyDocument } from '@kontourai/station-shared/html-reply-document';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  mcpUiFrameServeTotal: { add: vi.fn() },
}));
const { createMcpUiFrameApp } = await import('../mcp-ui-frame-server.js');

function proxy() {
  const userActivation = { isActive: false };
  const parent = { postMessage: vi.fn() };
  const child = {
    title: '',
    sandbox: { value: '' },
    srcdoc: '',
    referrerPolicy: '',
    contentWindow: { postMessage: vi.fn() },
    addEventListener: vi.fn(),
    remove: vi.fn(),
  };
  let receive: (event: {
    source: unknown;
    origin: string;
    data: unknown;
  }) => void = () => {
    throw new Error('No listener');
  };
  const append = vi.fn();
  const doc = buildHtmlReplyProxyDocument(['https://station.example']);
  const script = doc.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error('Missing proxy bootstrap');
  runInNewContext(script, {
    parent,
    navigator: { userActivation },
    URL,
    TextEncoder,
    document: { createElement: () => child, body: { append } },
    addEventListener: (_type: string, callback: typeof receive) => {
      receive = callback;
    },
  });
  const dispatch = (
    data: unknown,
    origin = 'https://station.example',
    source: unknown = parent,
  ) => receive({ data, origin, source });
  return { parent, child, append, dispatch, userActivation };
}

describe('HTML reply sandbox bridge', () => {
  test('repeats readiness only for its authenticated parent after the iframe load handshake', () => {
    const p = proxy();
    p.parent.postMessage.mockClear();
    p.dispatch({ type: 'html-reply-connect' }, 'https://evil.example');
    expect(p.parent.postMessage).not.toHaveBeenCalled();
    p.dispatch({ type: 'html-reply-connect' });
    expect(p.parent.postMessage).toHaveBeenCalledWith(
      { type: 'html-reply-ready' },
      'https://station.example',
    );
  });

  test('serves only a fixed frame on the existing isolated listener', async () => {
    const app = createMcpUiFrameApp({
      frameAncestors: ['https://station.example'],
    });
    const response = await app.request('/html-reply/frame');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors https://station.example; frame-src 'none'",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await app.request('/images/secret.png')).status).toBe(404);
    expect(
      (await createMcpUiFrameApp().request('/html-reply/frame')).headers.get(
        'content-security-policy',
      ),
    ).toContain("frame-ancestors 'none'");
  });
  test('authenticates the host and puts restrictive CSP before authored HTML', () => {
    const p = proxy();
    p.dispatch(
      { type: 'html-reply-load', html: '<script>evil()</script>' },
      'https://evil.example',
    );
    expect(p.append).not.toHaveBeenCalled();
    p.dispatch({ type: 'html-reply-load', html: '<script>chart()</script>' });
    expect(p.append).toHaveBeenCalledWith(p.child);
    expect(p.child.sandbox.value).toBe('allow-scripts');
    expect(p.child.srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(
      p.child.srcdoc.indexOf('chart()'),
    );
    expect(p.child.srcdoc).toContain(
      "connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });
  test('forwards theme updates and only bounded web link requests, never tool requests', () => {
    const p = proxy();
    p.dispatch({ type: 'html-reply-load', html: '<h1>Chart</h1>' });
    p.dispatch({
      type: 'html-reply-theme',
      tokens: { background: '#fff' },
      theme: 'light',
    });
    expect(p.child.contentWindow.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'html-reply-theme',
        tokens: { background: '#fff' },
        theme: 'light',
      },
      '*',
    );
    p.parent.postMessage.mockClear();
    p.dispatch(
      { jsonrpc: '2.0', method: 'tools/call' },
      'null',
      p.child.contentWindow,
    );
    p.dispatch(
      { type: 'html-reply-link', url: 'javascript:alert(1)' },
      'null',
      p.child.contentWindow,
    );
    expect(p.parent.postMessage).not.toHaveBeenCalled();
    p.dispatch(
      { type: 'html-reply-link', url: 'https://example.com/' },
      'null',
      p.child.contentWindow,
    );
    expect(p.parent.postMessage).not.toHaveBeenCalled();
    p.userActivation.isActive = true;
    p.dispatch(
      { type: 'html-reply-link', url: 'javascript:alert(1)' },
      'null',
      p.child.contentWindow,
    );
    p.dispatch(
      {
        type: 'html-reply-link',
        url: 'https://example.com/' + 'x'.repeat(2048),
      },
      'null',
      p.child.contentWindow,
    );
    expect(p.parent.postMessage).not.toHaveBeenCalled();
    p.dispatch(
      { type: 'html-reply-link', url: 'https://example.com/' },
      'null',
      p.child.contentWindow,
    );
    expect(p.parent.postMessage).toHaveBeenCalledWith(
      { type: 'html-reply-link', url: 'https://example.com/' },
      'https://station.example',
    );
  });
});
