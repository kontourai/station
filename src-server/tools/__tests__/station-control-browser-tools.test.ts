/**
 * The station-control browser tools (#90 #122/#123), as a model calls them:
 * every tool resolves the verified caller first and refuses, with a typed
 * reason and WITHOUT calling Station, when the caller cannot drive a browser;
 * a caller that passes reaches Station's browser-agent route carrying only
 * its credential, never an identity in the body.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerBrowserTools } from '../station-control-browser-tools.js';
import { StationControlToolRegistry } from '../station-control-mcp-server.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  type StationControlCaller,
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../station-control-shared.js';

process.env.STATION_API_BASE = 'http://browser-tools.test';

type Callback = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string }>;
}>;

function tools(): Map<string, { description: string; callback: Callback }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerBrowserTools(new StationControlToolRegistry(server));
  const registered = (server as unknown as Record<string, unknown>)
    ._registeredTools as Record<
    string,
    { description?: string; handler?: Callback; callback?: Callback }
  >;
  return new Map(
    Object.entries(registered).map(([name, tool]) => [
      name,
      {
        description: tool.description ?? '',
        callback: (tool.handler ?? tool.callback)!,
      },
    ]),
  );
}

const good: StationControlCaller = {
  sessionId: 'agent-session',
  assurance: 'bound',
  principal: stationControlCallerPrincipal(
    'human:local:operator',
    'session-owner',
  ),
  localProjectId: 'alpha',
  projectIdSource: 'session-record',
};

function run(
  caller: StationControlCaller | null,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = tools().get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return withStationControlCallerContext(
    { token: 'caller-token', resolve: () => caller },
    () => tool.callback(args),
  );
}

const parse = (result: Awaited<ReturnType<Callback>>) =>
  JSON.parse(result.content[0]!.text!) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('station-control browser tools', () => {
  test('the eleven tools are registered with concise descriptions', () => {
    const registered = tools();
    expect([...registered.keys()].sort()).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_navigate',
      'browser_open',
      'browser_press',
      'browser_resize',
      'browser_scroll',
      'browser_snapshot',
      'browser_status',
      'browser_type',
      'browser_wait_for',
    ]);
    for (const tool of registered.values())
      expect(tool.description.length).toBeLessThan(260);
  });

  test.each([
    ['no caller', null, 'caller-required'],
    [
      'a bearer-exposed credential',
      { ...good, assurance: 'bearer-exposed' as const },
      'caller-not-bound',
    ],
    [
      'an inferred principal',
      {
        ...good,
        principal: stationControlCallerPrincipal(
          'human:local:operator',
          'ownerless-single-operator',
        ),
      },
      'principal-unverified',
    ],
    [
      'a slug-lookup Project id',
      { ...good, projectIdSource: 'slug-lookup' as const },
      'project-unverified',
    ],
  ])(
    '%s is refused (%s) without calling Station',
    async (_label, caller, code) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const result = parse(
        await run(caller, 'browser_click', {
          browserSessionId: 'bs_x',
          x: 1,
          y: 1,
        }),
      );
      expect(result).toMatchObject({ ok: false, code });
      expect(String(result.message)).toMatch(
        /^Browser tools need a verified agent session/,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('a verified caller reaches the route with its credential, and no identity in the body', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, clicked: 'button "Go"' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = parse(
      await run(good, 'browser_click', { browserSessionId: 'bs_x', ref: 'e3' }),
    );
    expect(result).toEqual({ ok: true, clicked: 'button "Go"' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://browser-tools.test/api/browser-agent/click');
    expect(
      (init.headers as Record<string, string>)[
        STATION_CONTROL_CALLER_TOKEN_HEADER
      ],
    ).toBe('caller-token');
    expect(JSON.parse(String(init.body))).toEqual({
      browserSessionId: 'bs_x',
      target: { ref: 'e3' },
    });
  });

  test('a snapshot screenshot comes back as image content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              snapshot: '- button "Go" [ref=e1]',
              screenshot: {
                mimeType: 'image/jpeg',
                data: 'AAAA',
                width: 800,
                height: 600,
              },
            }),
          ),
      ),
    );
    const result = await run(good, 'browser_snapshot', {
      browserSessionId: 'bs_x',
      screenshot: true,
    });
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/jpeg',
    });
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      snapshot: '- button "Go" [ref=e1]',
      screenshot: { mimeType: 'image/jpeg', width: 800 },
    });
    expect(result.content[0]!.text).not.toContain('AAAA');
  });

  test('a Station without the browser route (hosted) says the browser is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('404 Not Found', { status: 404 })),
    );
    const result = parse(await run(good, 'browser_status', {}));
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
