import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { createBrowserAgentRoutes } from '../../../routes/browser-agent.js';
import { createDeviceAgentRoutes } from '../../../routes/device-agent.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { createBrowserPrincipalAuthorizer } from '../../../services/browser/browser-agent-authority.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import { bindCodexToolRequest } from '../codex-bound-request.js';
import { resolveStationControlCallerForRequest } from '../station-control-caller.js';
import { createCodexBoundToolServer } from '../station-control-in-process.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../station-control-mcp-token.js';

test('a copied request cannot use a Codex tool caller at the browser route', async () => {
  let current = true;
  let stolen: Request | undefined;
  const status = vi.fn(async () => ({
    ok: true,
    sessions: [],
    nextCursor: null,
  }));
  const resolveRecord = () => ({
    principal: { id: 'operator', source: 'session-owner' as const },
    localProjectId: 'project',
    projectIdSource: 'session-record' as const,
  });
  const browser = createBrowserAgentRoutes({
    isInternalRequest: () => true,
    resolveCaller: (request) =>
      resolveStationControlCallerForRequest(request, resolveRecord),
    authorizePrincipal: createBrowserPrincipalAuthorizer({
      isOperatorPrincipal: (id) => id === 'operator',
    }),
    automation: { status } as never,
    settings: { evaluateAllowed: () => false },
    browserReady: () => true,
    projectSlug: () => 'project',
    surfaceIdFor: () => undefined,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: 'test',
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  app.route('/api/browser-agent', browser);
  const server = await createCodexBoundToolServer({
    sessionId: 'session-a',
    resolveRecord,
    includeBrowser: true,
    includeDevices: false,
    isCurrent: () => current,
    dispatch: async (request) => {
      stolen = request.clone();
      return app.fetch(request);
    },
  });
  try {
    const result = (await server.call('browser_status', {}, () => current)) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0]!.text).ok).toBe(true);
    expect(status).toHaveBeenCalledOnce();
    const copied = await app.fetch(stolen!);
    expect(((await copied.json()) as { code: string }).code).toBe(
      'caller-required',
    );
    expect(status).toHaveBeenCalledOnce();
    const listener = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    if (!listener.listening) await once(listener, 'listening');
    try {
      const port = (listener.address() as AddressInfo).port;
      const headers = Object.fromEntries(stolen!.headers.entries());
      const child = spawn(
        process.execPath,
        [
          '-e',
          `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',async()=>{const x=JSON.parse(text);const r=await fetch(x.url,{method:'POST',headers:x.headers,body:'{}'});process.stdout.write(await r.text())})`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const output = new Promise<string>((resolve, reject) => {
        let text = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          text += chunk;
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve(text) : reject(new Error(`child exit ${code}`)),
        );
      });
      child.stdin.end(
        JSON.stringify({
          url: `http://127.0.0.1:${port}/api/browser-agent/status`,
          headers,
        }),
      );
      expect(JSON.parse(await output).code).toBe('caller-required');
      expect(status).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
    const tokenA = stolen!.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER)!;
    const tokenB = mintStationControlMcpToken(
      'session-b',
      'sdk-in-process',
      undefined,
      undefined,
      undefined,
      'codex-tools',
    ).token;
    try {
      const swapped = new Request('http://127.0.0.1/api/browser-agent/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: tokenB,
        },
        body: '{}',
      });
      bindCodexToolRequest(swapped, tokenA, () => true);
      expect(
        ((await (await app.fetch(swapped)).json()) as { code: string }).code,
      ).toBe('caller-required');
      expect(status).toHaveBeenCalledOnce();
    } finally {
      revokeStationControlMcpToken('session-b', 'codex-tools');
    }
    const successor = await createCodexBoundToolServer({
      sessionId: 'session-a',
      resolveRecord,
      includeBrowser: true,
      includeDevices: false,
      isCurrent: () => current,
      dispatch: async (request) => app.fetch(request),
    });
    try {
      const stale = new Request('http://127.0.0.1/api/browser-agent/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: tokenA,
        },
        body: '{}',
      });
      bindCodexToolRequest(stale, tokenA, () => true);
      expect(
        ((await (await app.fetch(stale)).json()) as { code: string }).code,
      ).toBe('caller-required');
      await server.close();
      const next = (await successor.call(
        'browser_status',
        {},
        () => current,
      )) as { content: { text: string }[] };
      expect(JSON.parse(next.content[0]!.text).ok).toBe(true);
      expect(status).toHaveBeenCalledTimes(2);
    } finally {
      await successor.close();
    }
    current = false;
    await expect(
      server.call('browser_status', {}, () => current),
    ).rejects.toThrow('bound-tool-refused');
    expect(status).toHaveBeenCalledTimes(2);
  } finally {
    await server.close();
  }
});

test('revocation during Project authorization prevents the browser effect', async () => {
  let current = true;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const status = vi.fn(async () => ({
    ok: true,
    sessions: [],
    nextCursor: null,
  }));
  const resolveRecord = () => ({
    principal: { id: 'operator', source: 'session-owner' as const },
    localProjectId: 'project',
    projectIdSource: 'session-record' as const,
  });
  const browser = createBrowserAgentRoutes({
    isInternalRequest: () => true,
    resolveCaller: (request) =>
      resolveStationControlCallerForRequest(request, resolveRecord),
    authorizePrincipal: async () => {
      enter();
      await gate;
      return { kind: 'operator' };
    },
    automation: { status } as never,
    settings: { evaluateAllowed: () => false },
    browserReady: () => true,
    projectSlug: () => 'project',
    surfaceIdFor: () => undefined,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: 'test',
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  app.route('/api/browser-agent', browser);
  const server = await createCodexBoundToolServer({
    sessionId: 'revocation-race',
    resolveRecord,
    includeBrowser: true,
    includeDevices: false,
    isCurrent: () => current,
    dispatch: async (request) => app.fetch(request),
  });
  try {
    const result = server.call('browser_status', {}, () => current);
    await entered;
    current = false;
    release();
    await result;
    expect(status).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

test('revocation during Project authorization prevents the device effect', async () => {
  let current = true;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = vi.fn(async () => ({
    ok: true,
    hosts: [],
    devices: [],
    sessions: [],
  }));
  const resolveRecord = () => ({
    principal: { id: 'operator', source: 'session-owner' as const },
    localProjectId: 'project',
    projectIdSource: 'session-record' as const,
  });
  const device = createDeviceAgentRoutes({
    isInternalRequest: () => true,
    resolveCaller: (request) =>
      resolveStationControlCallerForRequest(request, resolveRecord),
    authorizePrincipal: async () => {
      enter();
      await gate;
      return { kind: 'operator' };
    },
    agentAccessEnabled: () => true,
    shares: { list: () => [] } as never,
    automation: { list } as never,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: 'test',
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  app.route('/api/device-agent', device);
  const server = await createCodexBoundToolServer({
    sessionId: 'device-revocation-race',
    resolveRecord,
    includeBrowser: false,
    includeDevices: true,
    isCurrent: () => current,
    dispatch: async (request) => app.fetch(request),
  });
  try {
    const result = server.call('device_list', {}, () => current);
    await entered;
    current = false;
    release();
    await result;
    expect(list).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

test('an expired tool credential tells the Session to restart before execution', async () => {
  const now = vi.spyOn(Date, 'now');
  const start = Date.now();
  now.mockReturnValue(start);
  const dispatch = vi.fn(async () => new Response('{}'));
  const server = await createCodexBoundToolServer({
    sessionId: 'expires-session',
    includeBrowser: true,
    includeDevices: false,
    isCurrent: () => true,
    dispatch,
  });
  try {
    now.mockReturnValue(start + 12 * 60 * 60 * 1000 + 1);
    await expect(server.call('browser_status', {}, () => true)).rejects.toThrow(
      'bound-tool-session-restart-required',
    );
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await server.close();
    now.mockRestore();
  }
});
