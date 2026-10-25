import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import {
  outsideMcpFixture as fixture,
  issuer,
  outsideMcpPayload as payload,
  protocols,
} from '../../../__test-utils__/outside-agent-mcp-fixture.js';
import { mintStationControlMcpToken } from '../../../runtime/mcp/station-control-mcp-token.js';
import { outsideAgentReleaseGuard } from '../../../security/outside-agent-release-guard.js';
import { requiredExternalSurfaceCapability } from '../../../security/pairing-route-scopes.js';
import { DAY } from '../../../services/outside-agent/oauth-records.js';
import { OutsideAgentGrantStore } from '../../../services/outside-agent/oauth-store.js';

const resource = `${issuer}/mcp`;

describe('outside-agent MCP transport and live authority', () => {
  test('anonymous GET before initialize challenges with resource metadata; no cookie/query/internal/device substitution', async () => {
    const f = await fixture();
    const token = f.grant().accessToken;
    const internal = mintStationControlMcpToken('session', 'url-token').token;
    for (const init of [
      {},
      { headers: { cookie: `access_token=${token}` } },
      { headers: { authorization: `Bearer ${internal}` } },
      { headers: { authorization: 'Bearer device-credential' } },
    ]) {
      const response = await f.request('/mcp', init);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="station-control:read"${'authorization' in (init.headers ?? {}) ? ', error="invalid_token"' : ''}`,
      );
    }
    expect((await f.request(`/mcp?token=${token}`)).status).toBe(401);
    expect(f.source.listProjects).not.toHaveBeenCalled();
  });

  test.each(protocols)(
    '%s negotiates, lists only R4a reads, calls scoped tools, and survives unknown-method/tool errors',
    async (version) => {
      const f = await fixture(),
        tokens = f.grant();
      const { session, response } = await f.initialize(
        tokens.accessToken,
        version,
      );
      expect((await payload(response)).result.protocolVersion).toBe(version);
      const listed = await payload(
        await f.rpc(tokens.accessToken, 'tools/list', {}, session, version),
      );
      expect(
        listed.result.tools.map((t: { name: string }) => t.name).sort(),
      ).toEqual(['get_project', 'list_projects']);
      for (const method of ['server/discover', 'future/method']) {
        const response = await f.rpc(
          tokens.accessToken,
          method,
          {},
          session,
          version,
        );
        expect(response.status).toBe(200);
        expect((await payload(response)).error.code).toBe(-32601);
      }
      for (const name of [
        'send_message',
        'navigate_to',
        'get_task_basis',
        'future_tool',
        'get_Project',
      ]) {
        const response = await f.rpc(
          tokens.accessToken,
          'tools/call',
          { name, arguments: {} },
          session,
          version,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('www-authenticate')).toBeNull();
        expect((await payload(response)).error).toMatchObject({
          code: -32602,
          message: 'Unknown tool',
        });
      }
      const list = await payload(
        await f.rpc(
          tokens.accessToken,
          'tools/call',
          { name: 'list_projects' },
          session,
          version,
        ),
      );
      expect(
        JSON.parse(list.result.content[0].text).data.map(
          (p: { id: string }) => p.id,
        ),
      ).toEqual(['id-alpha']);
      const own = await payload(
        await f.rpc(
          tokens.accessToken,
          'tools/call',
          { name: 'get_project', arguments: { slug: 'alpha' } },
          session,
          version,
        ),
      );
      expect(JSON.parse(own.result.content[0].text).data.id).toBe('id-alpha');
      f.source.getProject.mockClear();
      const foreign = await payload(
        await f.rpc(
          tokens.accessToken,
          'tools/call',
          { name: 'get_project', arguments: { slug: 'foreign' } },
          session,
          version,
        ),
      );
      expect(foreign.result.isError).toBe(true);
      expect(foreign.result.content[0].text).not.toContain('id-foreign');
      expect(f.source.getProject).not.toHaveBeenCalled();
      for (const args of [
        { slug: 'alpha', _userId: null },
        { slug: 'alpha', sessionId: 'foreign' },
        { slug: 'alpha', navigate: false },
      ])
        expect(
          (
            await payload(
              await f.rpc(
                tokens.accessToken,
                'tools/call',
                { name: 'get_project', arguments: args },
                session,
                version,
              ),
            )
          ).error.code,
        ).toBe(-32602);
      expect(
        (
          await f.request('/mcp', {
            method: 'DELETE',
            headers: {
              authorization: `Bearer ${tokens.accessToken}`,
              'mcp-session-id': session,
              'mcp-protocol-version': version,
            },
          })
        ).status,
      ).toBe(200);
    },
  );

  test('global is explicit and cannot read a Project; deleted/reused slug never retargets a grant', async () => {
    const f = await fixture();
    const global = f.grant(true),
      project = f.grant();
    const g = await f.initialize(global.accessToken),
      p = await f.initialize(project.accessToken);
    await g.response.text();
    await p.response.text();
    const result = await payload(
      await f.rpc(
        global.accessToken,
        'tools/call',
        { name: 'list_projects' },
        g.session,
      ),
    );
    expect(JSON.parse(result.result.content[0].text).data).toEqual([]);
    expect(
      (
        await payload(
          await f.rpc(
            global.accessToken,
            'tools/call',
            { name: 'get_project', arguments: { slug: 'alpha' } },
            g.session,
          ),
        )
      ).result.isError,
    ).toBe(true);
    f.projects[0] = { ...f.projects[0]!, id: 'replacement-id' };
    expect(
      (await f.rpc(project.accessToken, 'tools/list', {}, p.session)).status,
    ).toBe(401);
  });

  test.each(['revoke', 'narrow', 'expiry', 'authority'] as const)(
    '%s after read but before outward emission suppresses content, including across store connections',
    async (action) => {
      const f = await fixture(),
        tokens = f.grant();
      const { session, response } = await f.initialize(tokens.accessToken);
      await response.text();
      const held = await f.rpc(
        tokens.accessToken,
        'tools/call',
        { name: 'get_project', arguments: { slug: 'alpha' } },
        session,
      );
      const other = OutsideAgentGrantStore.open(f.home, { ...f.store.options });
      try {
        const grant = other.access(tokens.accessToken, resource)!;
        if (action === 'revoke') other.revoke(grant.id, grant.version);
        if (action === 'narrow')
          other.change(grant.id, grant.version, other.grantDigest(grant), {
            ...grant.selection,
            projectScope: { kind: 'global' },
          });
        if (action === 'expiry') f.clock.now += DAY;
        if (action === 'authority') f.authority.live = false;
        expect(await held.text()).toBe('');
        const next = await f.rpc(tokens.accessToken, 'tools/list', {}, session);
        expect(next.status).not.toBe(200);
        if (action === 'narrow') {
          const fresh = await f.initialize(tokens.accessToken);
          await fresh.response.text();
          const list = await payload(
            await f.rpc(
              tokens.accessToken,
              'tools/call',
              { name: 'list_projects' },
              fresh.session,
            ),
          );
          expect(JSON.parse(list.result.content[0].text).data).toEqual([]);
        }
      } finally {
        other.close();
      }
    },
  );

  test('SSE responses, GET and resume are authenticated and grant/family/version-bound', async () => {
    const f = await fixture(),
      a = f.grant(),
      b = f.grant();
    const { session, response } = await f.initialize(
      a.accessToken,
      '2025-11-25',
      'text/event-stream, application/json',
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    const cursor = /^id: (.+)$/m.exec(text)![1]!;
    const headers = {
      authorization: `Bearer ${a.accessToken}`,
      accept: 'text/event-stream',
      'mcp-session-id': session,
      'mcp-protocol-version': '2025-11-25',
      'last-event-id': cursor,
    };
    const resumed = await f.request('/mcp', { headers });
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain('station-outside-agent');
    expect(
      (
        await f.request('/mcp', {
          headers: { ...headers, authorization: `Bearer ${b.accessToken}` },
        })
      ).status,
    ).toBe(404);
    const open = await f.request('/mcp', {
      headers: { ...headers, 'last-event-id': '' },
    });
    expect(open.status).toBe(200);
    const reader = open.body!.getReader(),
      waiting = reader.read();
    const grant = f.store.access(a.accessToken, resource)!;
    f.store.revoke(grant.id, grant.version);
    expect((await waiting).done).toBe(true);
    expect((await f.request('/mcp', { headers })).status).toBe(401);
  });

  test('valid token with wrong stored audience is refused at the real resource', async () => {
    const f = await fixture(),
      tokens = f.grant();
    const db = new DatabaseSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    );
    try {
      db.prepare(
        "UPDATE outside_oauth_records SET data=json_set(data,'$.resource',?) WHERE kind='access'",
      ).run(`${issuer}/mcp/station-control`);
    } finally {
      db.close();
    }
    const response = await f.rpc(tokens.accessToken, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'audience-test', version: '1' },
    });
    expect(response.status).toBe(401);
    expect(f.source.listProjects).not.toHaveBeenCalled();
  });

  test('unsupported versions and malformed bodies refuse; per-grant session capacity precedes domain work', async () => {
    const f = await fixture(),
      tokens = f.grant();
    expect(
      (
        await f.rpc(tokens.accessToken, 'initialize', {
          protocolVersion: '2026-07-28',
        })
      ).status,
    ).toBe(400);
    const first = await f.initialize(tokens.accessToken);
    await first.response.text();
    expect(
      (
        await f.rpc(
          tokens.accessToken,
          'tools/list',
          {},
          first.session,
          '2025-03-26',
        )
      ).status,
    ).toBe(400);
    for (let i = 1; i < 5; i++)
      await (await f.initialize(tokens.accessToken)).response.text();
    const sixth = await f.rpc(tokens.accessToken, 'initialize', {
      protocolVersion: '2025-11-25',
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('1');
    expect(f.source.listProjects).not.toHaveBeenCalled();
    const tooLarge = await f.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
        'content-length': '1048577',
      },
      body: '{}',
    });
    expect(tooLarge.status).toBe(413);
  });

  test.each(['/mcp', '/mcp/', '/%6dcp', '/mcp%2f', '//mcp'])(
    'ingress and compiled refusal own %s before tool work',
    async (path) => {
      const f = await fixture(),
        tokens = f.grant();
      for (const raw of [
        { peer: '127.0.0.2' },
        { extra: ['X-Forwarded-For', ''] },
        { extra: ['X-Station-Internal-Token', ''] },
        { extra: ['Host', 'attacker.test'] },
      ])
        expect(
          (
            await f.request(
              path,
              { headers: { authorization: `Bearer ${tokens.accessToken}` } },
              raw,
            )
          ).status,
        ).toBeOneOf([401, 404]);
      const app = new Hono();
      app.use('*', outsideAgentReleaseGuard);
      app.route('', f.server.app);
      expect(
        (
          await app.request(`${issuer}${path}`, {
            headers: { authorization: `Bearer ${tokens.accessToken}` },
          })
        ).status,
      ).toBe(404);
      expect(f.source.listProjects).not.toHaveBeenCalled();
    },
  );
});

test('exact outside capability leaves do not reclassify internal or VoltAgent routes', () => {
  for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS'])
    expect(
      requiredExternalSurfaceCapability('http', method, '/mcp'),
    ).toMatchObject({ capability: 'outside-mcp-token', match: 'exact' });
  for (const path of [
    '/mcp/',
    '/mcp/servers',
    '/mcp/servers/example',
    '/mcp/example/mcp',
    '/mcp/station-control',
    '/mcp/oauth-proxy/example',
  ])
    expect(
      requiredExternalSurfaceCapability('http', 'POST', path)?.capability,
    ).not.toBe('outside-mcp-token');
});

test('ten pending MCP requests exhaust the grant budget before an eleventh can perform domain work', async () => {
  const f = await fixture(),
    tokens = f.grant();
  const initialized = await f.initialize(tokens.accessToken);
  await initialized.response.text();
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  const headers = {
    authorization: `Bearer ${tokens.accessToken}`,
    'content-type': 'application/json',
    'mcp-session-id': initialized.session,
    'mcp-protocol-version': '2025-11-25',
  };
  for (let i = 0; i < 10; i++) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodies.push(controller);
      },
    });
    pending.push(
      Promise.resolve(
        f.request('/mcp', {
          method: 'POST',
          headers,
          body,
          duplex: 'half',
        } as RequestInit),
      ),
    );
  }
  // Each request reaches its real body read before the next microtask checkpoint.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const refused = await f.rpc(
    tokens.accessToken,
    'tools/call',
    { name: 'list_projects' },
    initialized.session,
  );
  expect(refused.status).toBe(429);
  expect(f.source.listProjects).not.toHaveBeenCalled();
  for (const body of bodies) body.close();
  for (const response of await Promise.all(pending)) {
    expect(response.status).toBe(400);
    await response.text();
  }
  const recovered = await payload(
    await f.rpc(
      tokens.accessToken,
      'tools/call',
      { name: 'list_projects' },
      initialized.session,
    ),
  );
  expect(JSON.parse(recovered.result.content[0].text).data).toHaveLength(1);
});

test('CORS origin removal closes its live browser stream while native sessions retain their grant', async () => {
  const f = await fixture(),
    tokens = f.grant();
  const origin = 'https://browser.example.test';
  f.store.changePolicy('cors', 'add', origin, 0);
  const preflight = await f.request('/mcp', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  const initialize = await f.request('/mcp', {
    method: 'POST',
    headers: {
      origin,
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'browser', version: '1' },
      },
    }),
  });
  expect(initialize.status).toBe(200);
  await initialize.text();
  const browser = await f.request('/mcp', {
    headers: {
      origin,
      authorization: `Bearer ${tokens.accessToken}`,
      accept: 'text/event-stream',
      'mcp-session-id': initialize.headers.get('mcp-session-id')!,
      'mcp-protocol-version': '2025-11-25',
    },
  });
  const reader = browser.body!.getReader(),
    waiting = reader.read();
  f.store.changePolicy('cors', 'remove', origin, 1);
  expect((await waiting).done).toBe(true);
  expect(
    (
      await f.request('/mcp', {
        headers: { origin, authorization: `Bearer ${tokens.accessToken}` },
      })
    ).status,
  ).toBe(403);
  const native = await f.initialize(tokens.accessToken);
  await native.response.text();
});

test('dispatch catalog refuses a schema-valid hidden navigation callback before its HTTP effect', async () => {
  const f = await fixture(),
    tokens = f.grant();
  const initialized = await f.initialize(tokens.accessToken);
  await initialized.response.text();
  const egress = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ success: true }));
  const response = await f.rpc(
    tokens.accessToken,
    'tools/call',
    { name: 'navigate_to', arguments: { path: '/projects/foreign' } },
    initialized.session,
  );
  expect(response.status).toBe(200);
  expect((await payload(response)).error).toMatchObject({
    code: -32602,
    message: 'Unknown tool',
  });
  expect(egress).not.toHaveBeenCalled();
});

test('unknown methods before initialize return HTTP 200 method-not-found without allocating a session', async () => {
  const f = await fixture(),
    tokens = f.grant();
  for (let i = 1; i <= 6; i++) {
    const response = await f.rpc(
      tokens.accessToken,
      i % 2 ? 'server/discover' : 'future/method',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await payload(response)).toMatchObject({
      jsonrpc: '2.0',
      id: i,
      error: { code: -32601, message: 'Method not found' },
    });
  }
  expect(f.source.listProjects).not.toHaveBeenCalled();
  const initialized = await f.initialize(tokens.accessToken);
  await initialized.response.text();
});

test('literal-loopback localhost alias names the configured resource without redirect or domain work', async () => {
  const f = await fixture();
  const response = await f.request('/mcp', {
    headers: { host: 'localhost:43141' },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'invalid_request',
    error_description: expect.stringContaining(resource),
  });
  expect(response.headers.get('location')).toBeNull();
  expect(f.source.listProjects).not.toHaveBeenCalled();
});

test.each([
  ['text/plain', 'application/json, text/event-stream', 415],
  ['application/json', 'application/json', 406],
])(
  'pre-initialize unknown methods retain transport header validation (%s, %s)',
  async (contentType, accept, status) => {
    const f = await fixture(),
      tokens = f.grant();
    const response = await f.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': contentType,
        accept,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
      }),
    });
    expect(response.status).toBe(status);
    expect(f.source.listProjects).not.toHaveBeenCalled();
  },
);

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('MCP request did not finish after session end')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each(
  (['revoke', 'narrow', 'delete'] as const).flatMap((action) =>
    [
      'application/json, text/event-stream',
      'text/event-stream, application/json',
    ].map((accept) => ({ action, accept })),
  ),
)(
  '$action finishes in-flight calls and releases capacity ($accept)',
  async ({ action, accept }) => {
    const f = await fixture(),
      tokens = f.grant();
    // Ten successive ends catch a leaked request reservation at the grant ceiling.
    for (let i = 0; i < (action === 'revoke' ? 1 : 10); i++) {
      const { session, response } = await f.initialize(
        tokens.accessToken,
        protocols[1],
        accept,
      );
      await response.text();
      let deletion: Promise<Response> | undefined;
      f.source.getProject.mockImplementationOnce(() => {
        const grant = f.store.access(tokens.accessToken, resource)!;
        if (action === 'revoke') f.store.revoke(grant.id, grant.version);
        if (action === 'narrow')
          f.store.change(grant.id, grant.version, f.store.grantDigest(grant), {
            ...grant.selection,
            expiresAt: grant.expiresAt - 1000,
          });
        if (action === 'delete')
          deletion = Promise.resolve(
            f.request('/mcp', {
              method: 'DELETE',
              headers: {
                authorization: `Bearer ${tokens.accessToken}`,
                'mcp-session-id': session,
                'mcp-protocol-version': protocols[1]!,
              },
            }),
          );
        return f.projects[0]!;
      });
      const ended = await promptly(
        Promise.resolve(
          f.rpc(
            tokens.accessToken,
            'tools/call',
            { name: 'get_project', arguments: { slug: 'alpha' } },
            session,
            protocols[1],
            accept,
          ),
        ).then(async (result) => ({
          status: result.status,
          body: await result.text(),
        })),
      );
      if (accept.startsWith('application/json')) {
        expect(ended.status).toBe(404);
        expect(JSON.parse(ended.body).error.message).toBe('Session not found');
      } else {
        expect(ended.status).toBeOneOf([200, 404]);
        expect(ended.body).not.toContain('id-alpha');
      }
      if (deletion) expect((await promptly(deletion)).status).toBe(200);
    }
    if (action === 'revoke')
      expect((await f.rpc(tokens.accessToken, 'ping')).status).toBe(401);
    else {
      const fresh = await f.initialize(
        tokens.accessToken,
        protocols[1],
        accept,
      );
      await fresh.response.text();
      const result = await payload(
        await f.rpc(
          tokens.accessToken,
          'tools/call',
          { name: 'get_project', arguments: { slug: 'alpha' } },
          fresh.session,
          protocols[1],
          accept,
        ),
      );
      expect(JSON.parse(result.result.content[0].text).data.id).toBe(
        'id-alpha',
      );
    }
  },
);

test('junk bearer ingress is bounded before access or CORS reads; refused floods do no writes or sweeps', async () => {
  const f = await fixture();
  const access = vi.spyOn(f.store, 'access');
  const policy = vi.spyOn(f.store, 'policy');
  const junk = `oat_${'x'.repeat(43)}`;
  for (let i = 0; i < 120; i++)
    expect(
      (
        await f.request('/mcp', {
          headers: { authorization: `Bearer ${junk}` },
        })
      ).status,
    ).toBe(401);
  access.mockClear();
  policy.mockClear();
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  for (let i = 0; i < 20; i++) {
    const refused = await f.request('/mcp', {
      headers: { authorization: `Bearer ${junk}`, origin: 'https://junk.test' },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
  }
  expect(access).not.toHaveBeenCalled();
  expect(policy).not.toHaveBeenCalled();
  expect(
    prepare.mock.calls.every(([sql]) =>
      /^SELECT .*outside_oauth_budgets/.test(sql),
    ),
  ).toBe(true);
  expect(
    exec.mock.calls.every(([sql]) =>
      ['BEGIN IMMEDIATE', 'COMMIT'].includes(sql),
    ),
  ).toBe(true);
});

test('access and the one-second session recheck read without a write lock or expiry sweep', async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    tokens = f.grant();
  const initialized = await f.initialize(tokens.accessToken);
  await initialized.response.text();
  const other = new DatabaseSync(
    join(f.home, 'authentication/outside-agent-oauth.sqlite'),
  );
  try {
    other.exec('BEGIN IMMEDIATE');
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const access = vi.spyOn(f.store, 'access');
    expect(f.store.access(tokens.accessToken, resource)?.state).toBe('active');
    access.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(access).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(
      true,
    );
    // Expired access is refused even before the periodic lifecycle owner writes its terminal state.
    f.clock.now += DAY;
    expect(f.store.access(tokens.accessToken, resource)).toBeUndefined();
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});

test('reinitialize returns a clean JSON-RPC error and the session remains usable', async () => {
  const f = await fixture(),
    tokens = f.grant();
  const { session, response } = await f.initialize(tokens.accessToken);
  await response.text();
  const repeated = await f.rpc(tokens.accessToken, 'initialize', {}, session);
  expect(repeated.status).toBe(400);
  expect(await repeated.json()).toMatchObject({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Session already initialized' },
  });
  expect(
    (await payload(await f.rpc(tokens.accessToken, 'ping', {}, session)))
      .result,
  ).toEqual({});
});
