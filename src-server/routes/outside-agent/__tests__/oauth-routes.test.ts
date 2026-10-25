import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { outsideAgentReleaseGuard } from '../../../security/outside-agent-release-guard.js';
import { requiredExternalSurfaceCapability } from '../../../security/pairing-route-scopes.js';
import {
  OutsideAgentManagementService,
  type OutsideManagementAction,
} from '../../../services/outside-agent/management-service.js';
import { DAY, MINUTE } from '../../../services/outside-agent/oauth-records.js';
import { pkceChallenge } from '../../../services/outside-agent/oauth-registration.js';
import { createOutsideAgentOAuthServer } from '../oauth-routes.js';

const temp = trackTempDirs();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
const issuer = 'http://127.0.0.1:43141',
  resource = `${issuer}/mcp`,
  redirect = 'http://localhost:43198/callback';
const metadata = {
  application_type: 'native',
  redirect_uris: [redirect],
  client_name: '<Unverified>\u202e',
  token_endpoint_auth_method: 'none',
};
async function fixture(
  options: {
    issuer?: string;
    home?: string;
    peer?: string;
    checkServe?: () => Promise<'clear' | 'mapped' | 'unverifiable'>;
    trusted?: boolean;
    limits?: {
      grantsPerClient?: number;
      grants?: number;
      registrations?: number;
    };
  } = {},
) {
  const home = options.home ?? temp('outside-r3-');
  const clock = { now: 1_800_000_000_000 };
  const origin = options.issuer ?? issuer;
  const authority = { live: true, project: true };
  const actor = {
    kind: 'host' as const,
    id: 'host-cli',
    authorityRevision: 'epoch',
    delegatingPrincipalId: 'operator',
  };
  const service = OutsideAgentManagementService.open(
    home,
    {
      stationId: 'r3-isolated',
      bootId: randomBytes(16).toString('hex'),
      issuer: origin,
      now: () => clock.now,
      limits: options.limits,
    },
    {
      current: () => authority.live,
      projectExists: () => authority.project,
      resolveProject: (slug) =>
        slug === 'alpha' ? { id: 'project-alpha' } : null,
      describeProject: () => ({ name: 'Alpha', slug: 'alpha' }),
    },
  );
  const exposure = {
    issuer: origin,
    allowLoopbackHttp: true,
    hosted: false,
    ...(options.trusted
      ? {
          trustedTlsIngress: (c: import('hono').Context) => ({
            peerKey: c.req.header('test-verified-peer'),
          }),
        }
      : {}),
  };
  const server = await createOutsideAgentOAuthServer({
    store: service.store,
    validateGrant: (g) => service.validateGrant(g),
    exposure,
    checkServe: options.checkServe ?? (async () => 'clear'),
  });
  cleanups.push(() => {
    server.close();
    service.store.close();
  });
  const request = (
    path: string,
    init: RequestInit = {},
    transport: {
      peer?: string;
      rawHeaders?: string[];
      encrypted?: boolean;
    } = {},
  ) => {
    const headers = new Headers({ host: new URL(origin).host });
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const rawHeaders = transport.rawHeaders ?? [...headers].flat();
    return server.app.request(
      `${origin}${path}`,
      { ...init, headers },
      {
        incoming: {
          rawHeaders,
          socket: {
            remoteAddress: transport.peer ?? options.peer ?? '127.0.0.1',
            encrypted: transport.encrypted,
          },
        },
      },
    );
  };
  const post = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    });
  const register = async (extra: Record<string, unknown> = {}) => {
    const response = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...metadata, ...extra }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { client_id: string };
  };
  const commit = (action: OutsideManagementAction) =>
    service.commit(
      {
        action,
        fingerprint: service.review(action, actor).fingerprint,
        decisionId: randomBytes(24).toString('base64url'),
      },
      actor,
    );
  const start = async (
    clientId: string,
    extra: Record<string, string> = {},
    cookie?: string,
  ) => {
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect,
      resource: `${origin}/mcp`,
      state: 'original state & bytes',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      scope: 'station-control:read station-control:full',
      ...extra,
    });
    const response = await request(`/oauth/authorize?${params}`, {
      headers: cookie ? { cookie } : {},
    });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    const requestId = html.match(/name="request_id" value="([^"]+)"/)![1]!;
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    return {
      requestId,
      nonce,
      verifier,
      html,
      cookie: response.headers.get('set-cookie')!.split(';')[0]!,
      response,
    };
  };
  const approval = (
    id: string,
    expiresAt = clock.now + DAY,
    supersessions: {
      grantId: string;
      expectedVersion: number;
      expectedDigest: string;
    }[] = [],
  ) => {
    const row = service.list(actor).pending.find((r) => r.requestId === id)!;
    return commit({
      operation: 'approve',
      requestId: id,
      clientId: row.clientId,
      expectedRequestFingerprint: row.expectedRequestFingerprint,
      project: { kind: 'project', slug: 'alpha' },
      accessLevel: 'read-only',
      expiresAt,
      supersessions,
    });
  };
  const complete = (
    flow: Awaited<ReturnType<typeof start>>,
    headers: Record<string, string> = {},
  ) =>
    post(
      '/oauth/authorize/complete',
      { request_id: flow.requestId, nonce: flow.nonce },
      {
        cookie: flow.cookie,
        origin,
        'sec-fetch-site': 'same-origin',
        ...headers,
      },
    );
  const exchange = (
    clientId: string,
    code: string,
    verifier: string,
    extra: Record<string, string> = {},
  ) =>
    post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${origin}/mcp`,
      ...extra,
    });
  const activate = async (clientId: string, expiresAt = clock.now + DAY) => {
    const flow = await start(clientId);
    approval(flow.requestId, expiresAt);
    const result = await complete(flow);
    expect(result.status).toBe(303);
    const code = new URL(result.headers.get('location')!).searchParams.get(
      'code',
    )!;
    const response = await exchange(clientId, code, flow.verifier);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    const grant = service.store.access(tokens.access_token, `${origin}/mcp`);
    if (!grant)
      throw new Error('Token exchange did not activate its bound grant');
    return { flow, code, tokens, grant };
  };
  const refresh = (
    clientId: string,
    token: string,
    extra: Record<string, string> = {},
  ) =>
    post('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: token,
      resource: `${origin}/mcp`,
      ...extra,
    });
  return {
    home,
    clock,
    service,
    server,
    exposure,
    authority,
    actor,
    request,
    post,
    register,
    commit,
    start,
    approval,
    complete,
    exchange,
    activate,
    refresh,
  };
}

describe('outside OAuth HTTP protocol (R3 only)', () => {
  test('exact metadata, bounded public DCR, browser wait wakes on approval, completion auto-submits and activation waits for code exchange', async () => {
    const f = await fixture();
    const first = await f.request('/.well-known/oauth-protected-resource/mcp');
    expect(await first.json()).toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['station-control:read', 'station-control:full'],
      bearer_methods_supported: ['header'],
    });
    expect(
      await (await f.request('/.well-known/oauth-protected-resource')).json(),
    ).toEqual(
      await (
        await f.request('/.well-known/oauth-protected-resource/mcp')
      ).json(),
    );
    const as = await (
      await f.request('/.well-known/oauth-authorization-server')
    ).json();
    expect(as).toMatchObject({
      issuer,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(as).not.toHaveProperty('client_id_metadata_document_supported');
    const client = await f.register({ ignored: 'not authoritative' });
    expect(client).not.toHaveProperty('client_secret');
    expect(client).not.toHaveProperty('ignored');
    const flow = await f.start(client.client_id);
    expect(flow.response.headers.get('referrer-policy')).toBe('origin');
    expect(flow.html).toContain('&lt;Unverified&gt;');
    expect(flow.html).not.toContain('\u202e');
    expect(flow.html).toContain("document.querySelector('form').submit()");
    expect(flow.html).not.toMatch(/setTimeout|setInterval/);
    const pending = f.service.store.request(flow.requestId)!;
    expect(pending.expiresAt - pending.createdAt).toBe(10 * MINUTE);
    const status = f.request(
      `/oauth/authorize/status?request_id=${flow.requestId}`,
      { headers: { cookie: flow.cookie, 'sec-fetch-site': 'same-origin' } },
    );
    await Promise.resolve();
    f.approval(flow.requestId);
    expect(await (await status).json()).toEqual({
      status: 'approved-awaiting-exchange',
    });
    expect(f.service.store.grants()).toHaveLength(0);
    const completed = await f.complete(flow);
    expect(completed.status).toBe(303);
    const url = new URL(completed.headers.get('location')!);
    expect(url.searchParams.get('state')).toBe('original state & bytes');
    expect(url.searchParams.get('iss')).toBe(issuer);
    expect((await f.complete(flow)).status).toBe(400);
    const tokens = await f.exchange(
      client.client_id,
      url.searchParams.get('code')!,
      flow.verifier,
    );
    expect(tokens.headers.get('cache-control')).toBe('no-store');
    expect(await tokens.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'station-control:read',
    });
    expect(f.service.store.grants()).toHaveLength(1);
    expect((await f.request('/mcp')).status).toBe(404);
    const db = readFileSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    ).toString();
    expect(db).not.toContain(flow.cookie.split('=')[1]);
    expect(db).not.toContain(flow.verifier);
  });
  test.each(['plain', '', 's256'])(
    'PKCE S256 requirement refuses %s at authorize with no pending allocation',
    async (method) => {
      const f = await fixture();
      const client = await f.register();
      const p = new URLSearchParams({
        client_id: client.client_id,
        response_type: 'code',
        redirect_uri: redirect,
        state: 's',
        resource,
        code_challenge: pkceChallenge('a'.repeat(43)),
        code_challenge_method: method,
      });
      expect((await f.request(`/oauth/authorize?${p}`)).status).toBe(400);
      expect(f.service.store.pending()).toHaveLength(0);
    },
  );
  test.each(['', 'http://127.0.0.1:43142/mcp', `${resource}/`, `${resource}*`])(
    'resource %s refused on authorize, code and refresh without consuming credentials',
    async (badResource) => {
      const f = await fixture();
      const client = await f.register();
      const active = await f.activate(client.client_id);
      const p = new URLSearchParams({
        client_id: client.client_id,
        resource: badResource,
      });
      if (!badResource) p.delete('resource');
      expect(
        await (await f.request(`/oauth/authorize?${p}`)).json(),
      ).toMatchObject({ error: 'invalid_target' });
      expect(
        await (
          await f.exchange(
            client.client_id,
            active.code,
            active.flow.verifier,
            { resource: badResource },
          )
        ).json(),
      ).toMatchObject({ error: 'invalid_target' });
      expect(
        await (
          await f.refresh(client.client_id, active.tokens.refresh_token, {
            resource: badResource,
          })
        ).json(),
      ).toMatchObject({ error: 'invalid_target' });
      expect(f.service.store.grants()[0]!.state).toBe('active');
    },
  );
  test('repeated resource and duplicate form/JSON fields refuse, unsupported grants/auth and scopes never allocate', async () => {
    const f = await fixture();
    const client = await f.register();
    for (const path of ['/oauth/token', '/oauth/authorize']) {
      const p = new URLSearchParams({ resource, client_id: client.client_id });
      p.append('resource', resource);
      const response = path.endsWith('token')
        ? await f.request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: String(p),
          })
        : await f.request(`${path}?${p}`);
      expect(await response.json()).toMatchObject({ error: 'invalid_target' });
    }
    expect(
      (
        await f.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"redirect_uris":[],"redirect_uris":[]}',
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await f.post('/oauth/token', {
          resource,
          client_id: client.client_id,
          grant_type: 'password',
        })
      ).json(),
    ).toMatchObject({ error: 'unsupported_grant_type' });
    expect(
      await (
        await f.post('/oauth/token', {
          resource,
          client_id: client.client_id,
          grant_type: 'refresh_token',
          client_secret: 'no',
        })
      ).json(),
    ).toMatchObject({ error: 'invalid_client' });
    const p = new URLSearchParams({
      resource,
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: redirect,
      state: 's',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'operator',
    });
    expect(
      await (await f.request(`/oauth/authorize?${p}`)).json(),
    ).toMatchObject({ error: 'invalid_scope' });
  });
  test.each(['unknown', 'retired'])(
    '%s client stays on local recovery page and never trusts supplied callback',
    async (kind) => {
      const f = await fixture();
      const client = await f.register();
      if (kind === 'retired')
        f.service.store.retire(client.client_id, 'denied');
      const response = await f.request(
        `/oauth/authorize?${new URLSearchParams({ client_id: kind === 'unknown' ? 'missing' : client.client_id, resource, redirect_uri: 'https://attacker.test/callback' })}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      const html = await response.text();
      expect(html).toContain('claude mcp logout');
      expect(html).toContain('codex mcp logout');
      expect(html).not.toContain('attacker.test');
    },
  );
  test('budget refusal precedes domain storage and audit size never adds request scans', async () => {
    for (const events of [0, 99_000]) {
      const f = await fixture();
      const client = await f.register();
      const db = new DatabaseSync(
        join(f.home, 'authentication/outside-agent-oauth.sqlite'),
      );
      try {
        db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
          INSERT INTO outside_oauth_records SELECT 'event','seed-'||n,
          json_object('id','seed-'||n,'kind','requested','at',?,'deliveredAt',NULL,'stationId','r3-isolated') FROM seq WHERE ? > 0`).run(
          events,
          f.clock.now,
          events,
        );
        const sql: string[] = [];
        const prepare = DatabaseSync.prototype.prepare;
        const trace = vi
          .spyOn(DatabaseSync.prototype, 'prepare')
          .mockImplementation(function (this: DatabaseSync, query: string) {
            sql.push(query);
            return prepare.call(this, query);
          });
        const clientRead = vi.spyOn(f.service.store, 'client');
        const sweep = vi.spyOn(f.service.store, 'sweep');
        try {
          // Exercise allocation as well as unknown-client probes: audit admission must be O(1).
          const flow = await f.start(client.client_id);
          const wait = f.request(
            `/oauth/authorize/status?request_id=${flow.requestId}`,
            {
              headers: { cookie: flow.cookie, 'sec-fetch-site': 'same-origin' },
            },
          );
          await Promise.resolve();
          f.service.store.deny(flow.requestId, 1);
          expect((await wait).status).toBe(200);
          for (let i = 0; i < 9; i++)
            expect(
              (await f.request(`/oauth/authorize?client_id=missing-${i}`))
                .status,
            ).toBe(400);
          expect(
            sql.filter((query) =>
              /(?:FROM|DELETE FROM) outside_oauth_records WHERE kind='event'/.test(
                query,
              ),
            ),
          ).toEqual([]);
          clientRead.mockClear();
          sql.length = 0;
          for (let i = 0; i < 20; i++)
            expect(
              (await f.request(`/oauth/authorize?client_id=over-${i}`)).status,
            ).toBe(429);
          expect(clientRead).not.toHaveBeenCalled();
          expect(sweep).not.toHaveBeenCalled();
          expect(
            sql.filter((query) =>
              /outside_oauth_records|outside_oauth_audit_count/.test(query),
            ),
          ).toEqual([]);
        } finally {
          trace.mockRestore();
        }
        // Refilled admitted work must not read or prune the audit table either.
        f.clock.now += MINUTE;
        const scan = vi
          .spyOn(DatabaseSync.prototype, 'prepare')
          .mockImplementation(function (this: DatabaseSync, query: string) {
            expect(query).not.toMatch(
              /(?:FROM|DELETE FROM) outside_oauth_records WHERE kind='event'/,
            );
            return prepare.call(this, query);
          });
        try {
          await f.start(client.client_id);
        } finally {
          scan.mockRestore();
        }
      } finally {
        db.close();
      }
    }
  });
  test('distinct verified peers cannot fill budget storage after global refusal or lock out a legitimate client', async () => {
    const f = await fixture({ issuer: 'https://station.test', trusted: true });
    const client = await f.register();
    const db = new DatabaseSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    );
    try {
      for (let i = 0; i < 2100; i++) {
        const response = await f.request('/oauth/register', {
          method: 'POST',
          headers: {
            'test-verified-peer': `attacker-${i}`,
            'content-type': 'application/json',
          },
          body: '{}',
        });
        expect(response.status).toBe(i < 29 ? 400 : 429);
      }
      // Only globally admitted peers allocate rows, two per DCR peer.
      expect(
        Number(
          db.prepare('SELECT count(*) AS n FROM outside_oauth_budgets').get()!
            .n,
        ),
      ).toBeLessThanOrEqual(62);
      // A full supplementary table must evict an old key rather than refuse a fresh one.
      db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<4096)
        INSERT OR IGNORE INTO outside_oauth_budgets SELECT 'pressure-'||n,0,?,? FROM seq`).run(
        f.clock.now - MINUTE,
        f.clock.now + DAY,
      );
      // Seed exactly the real cap, retaining global rows already charged above.
      db.exec(
        'DELETE FROM outside_oauth_budgets WHERE rowid IN (SELECT rowid FROM outside_oauth_budgets ORDER BY rowid DESC LIMIT (SELECT max(0,count(*)-4096) FROM outside_oauth_budgets))',
      );
      const response = await f.request(
        `/oauth/authorize?client_id=${client.client_id}&resource=https://station.test/mcp`,
        { headers: { 'test-verified-peer': 'legitimate' } },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(
        Number(
          db.prepare('SELECT count(*) AS n FROM outside_oauth_budgets').get()!
            .n,
        ),
      ).toBe(4096);
    } finally {
      db.close();
    }
  });
  test.each([
    '/oauth/authorize/cb',
    '/oauth/authorize',
    '/oauth/other',
    '/%6fauth/authorize/cb',
    '/oaut%68',
    '/oauth/%FF',
  ])(
    'DCR refuses callback path %s that could receive the browser ticket',
    async (path) => {
      const f = await fixture();
      const response = await f.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...metadata,
          redirect_uris: [`http://127.0.0.1:43199${path}`],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(f.service.store.outbox()).toEqual([]);
    },
  );
  test('same-ticket authorize churn keeps audit usage constant', async () => {
    const f = await fixture();
    const client = await f.register();
    let flow = await f.start(client.client_id);
    const initial = f.service.store.diagnostics().retainedEvents;
    for (let i = 0; i < 12; i++) {
      f.clock.now += MINUTE;
      flow = await f.start(client.client_id, {}, flow.cookie);
    }
    expect(f.service.store.diagnostics().retainedEvents).toBe(initial);
  });
  test('ticket isolation and same-ticket replacement preserve independent logins', async () => {
    const f = await fixture();
    const client = await f.register();
    const first = await f.start(client.client_id),
      other = await f.start(client.client_id);
    const replacement = await f.start(client.client_id, {}, first.cookie);
    expect(f.service.store.request(first.requestId)!.state).toBe('replaced');
    expect(f.service.store.request(other.requestId)!.state).toBe('pending');
    expect(
      (
        await f.request(
          `/oauth/authorize/status?request_id=${other.requestId}`,
          {
            headers: { cookie: first.cookie, 'sec-fetch-site': 'same-origin' },
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await f.complete(replacement, {
          nonce: 'wrong',
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(
          '/oauth/authorize/complete',
          { request_id: replacement.requestId, nonce: 'wrong' },
          {
            cookie: replacement.cookie,
            origin: issuer,
            'sec-fetch-site': 'same-origin',
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `/oauth/authorize/status?request_id=${other.requestId}`,
          { headers: { cookie: other.cookie, 'sec-fetch-site': 'cross-site' } },
        )
      ).status,
    ).toBe(403);
    f.clock.now += 11 * MINUTE;
    expect(f.service.store.request(replacement.requestId)).toBeUndefined();
    expect(f.service.store.grants()).toHaveLength(0);
  });
  test('denial completes only once to stored redirect with issuer and unchanged state', async () => {
    const f = await fixture();
    const client = await f.register();
    const flow = await f.start(client.client_id);
    const row = f.service.list(f.actor).pending[0]!;
    f.commit({
      operation: 'deny',
      requestId: row.requestId,
      clientId: row.clientId,
      expectedRequestFingerprint: row.expectedRequestFingerprint,
    });
    const response = await f.complete(flow);
    expect(response.status).toBe(303);
    expect(
      new URL(response.headers.get('location')!).searchParams.get('error'),
    ).toBe('access_denied');
    expect((await f.complete(flow)).status).toBe(400);
    expect(f.service.store.grants()).toHaveLength(0);
  });
  test('strict refresh reuse revokes family AND grant before successor redemption, even over budget', async () => {
    const f = await fixture();
    const client = await f.register();
    const active = await f.activate(client.client_id);
    const nextResponse = await f.refresh(
      client.client_id,
      active.tokens.refresh_token,
    );
    expect(nextResponse.status).toBe(200);
    const next = (await nextResponse.json()) as {
      refresh_token: string;
      access_token: string;
    };
    // Exhaust issuance through the real token endpoint before replaying the immediate predecessor.
    let current = next.refresh_token,
      predecessor = active.tokens.refresh_token;
    for (let i = 0; i < 2; i++) {
      predecessor = current;
      const response = await f.refresh(client.client_id, current);
      expect(response.status).toBe(200);
      current = ((await response.json()) as { refresh_token: string })
        .refresh_token;
    }
    expect(
      await (await f.refresh(client.client_id, predecessor)).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()[0]).toMatchObject({
      state: 'revoked',
      reason: 'refresh_replay',
      version: 2,
    });
    expect(f.service.store.access(next.access_token, resource)).toBeUndefined();
    expect(
      await (await f.refresh(client.client_id, next.refresh_token)).json(),
    ).toMatchObject({ error: 'invalid_grant' });
  });
  test('unknown/wrong-client/wrong-verifier probes cannot revoke, bound code reuse does revoke', async () => {
    const f = await fixture();
    const client = await f.register();
    const other = await f.register();
    const active = await f.activate(client.client_id);
    for (const [id, code, verifier] of [
      [other.client_id, active.code, active.flow.verifier],
      [client.client_id, 'oac_unknown', active.flow.verifier],
      [client.client_id, active.code, 'b'.repeat(43)],
    ])
      expect(
        await (await f.exchange(id!, code!, verifier!)).json(),
      ).toMatchObject({ error: 'invalid_grant' });
    expect(
      await (
        await f.refresh(other.client_id, active.tokens.refresh_token)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()[0]!.state).toBe('active');
    expect(
      await (
        await f.exchange(client.client_id, active.code, active.flow.verifier)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()[0]).toMatchObject({
      state: 'revoked',
      reason: 'code_replay',
    });
  });
  test('five verifier failures consume the code; expired codes and final-five-minute activation refuse', async () => {
    const f = await fixture();
    const client = await f.register();
    const flow = await f.start(client.client_id);
    f.approval(flow.requestId);
    const completed = await f.complete(flow);
    const code = new URL(completed.headers.get('location')!).searchParams.get(
      'code',
    )!;
    for (let i = 0; i < 5; i++)
      expect(
        (await f.exchange(client.client_id, code, 'b'.repeat(43))).status,
      ).toBe(400);
    expect(
      (await f.exchange(client.client_id, code, flow.verifier)).status,
    ).toBe(400);
    f.clock.now += MINUTE;
    const ending = await f.start(client.client_id);
    f.approval(ending.requestId, f.clock.now + 5 * MINUTE);
    const endingCode = new URL(
      (await f.complete(ending)).headers.get('location')!,
    ).searchParams.get('code')!;
    f.clock.now += 1;
    expect(
      await (
        await f.exchange(client.client_id, endingCode, ending.verifier)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()).toHaveLength(0);
  });
  test('refresh final-five-minute refusal leaves the current token unconsumed and live authority loss ends grant', async () => {
    const f = await fixture();
    const client = await f.register();
    const active = await f.activate(client.client_id);
    f.clock.now += DAY - 4 * MINUTE;
    expect(
      await (
        await f.refresh(client.client_id, active.tokens.refresh_token)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()[0]!.state).toBe('active');
    expect(
      f.service.store.outbox().filter((e) => e.kind === 'terminal'),
    ).toHaveLength(0);
    f.commit({
      operation: 'change',
      grantId: active.grant.id,
      expectedVersion: 1,
      expectedDigest: f.service.store.grantDigest(active.grant),
      project: { kind: 'project', slug: 'alpha' },
      accessLevel: 'read-only',
      expiresAt: active.grant.createdAt + 2 * DAY,
    });
    expect(
      (await f.refresh(client.client_id, active.tokens.refresh_token)).status,
    ).toBe(200);
    const other = await fixture();
    const otherClient = await other.register();
    const live = await other.activate(otherClient.client_id);
    other.authority.live = false;
    expect(
      await (
        await other.refresh(otherClient.client_id, live.tokens.refresh_token)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(other.service.store.grants()[0]).toMatchObject({
      state: 'revoked',
      reason: 'authority',
    });
  });
  test('seven-day idle expires family AND grant through token admission and frees active capacity', async () => {
    const f = await fixture({ limits: { grantsPerClient: 1 } });
    const client = await f.register();
    const active = await f.activate(client.client_id, f.clock.now + 30 * DAY);
    f.clock.now += 7 * DAY;
    expect(
      await (
        await f.refresh(client.client_id, active.tokens.refresh_token)
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(f.service.store.grants()[0]).toMatchObject({
      state: 'expired',
      reason: 'idle',
      version: 2,
    });
    const again = await f.activate(client.client_id);
    expect(again.grant.state).toBe('active');
  });
  test('activation cap loser returns invalid_grant and supersession commits only at exchange', async () => {
    const f = await fixture({ limits: { grantsPerClient: 1 } });
    const client = await f.register();
    const active = await f.activate(client.client_id);
    const next = await f.start(client.client_id);
    f.approval(next.requestId);
    expect(f.service.store.grants()[0]!.state).toBe('active');
    const code = new URL(
      (await f.complete(next)).headers.get('location')!,
    ).searchParams.get('code')!;
    expect(
      await (await f.exchange(client.client_id, code, next.verifier)).json(),
    ).toMatchObject({ error: 'invalid_grant' });
    const replacing = await f.start(client.client_id);
    f.approval(replacing.requestId, f.clock.now + DAY, [
      {
        grantId: active.grant.id,
        expectedVersion: active.grant.version,
        expectedDigest: f.service.store.grantDigest(active.grant),
      },
    ]);
    expect(f.service.store.grants()[0]!.state).toBe('active');
    const replacementCode = new URL(
      (await f.complete(replacing)).headers.get('location')!,
    ).searchParams.get('code')!;
    expect(
      (await f.exchange(client.client_id, replacementCode, replacing.verifier))
        .status,
    ).toBe(200);
    expect(
      f.service.store.grants().filter((g) => g.state === 'active'),
    ).toHaveLength(1);
    expect(
      f.service.store.grants().find((g) => g.id === active.grant.id)!.reason,
    ).toBe('superseded');
  });
});

describe('exposure at every OAuth leaf', () => {
  const leaves = [
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/oauth/register'],
    ['GET', '/oauth/authorize'],
    ['GET', '/oauth/authorize/status'],
    ['POST', '/oauth/authorize/complete'],
    ['POST', '/oauth/token'],
    ['OPTIONS', '/oauth/register'],
    ['OPTIONS', '/oauth/token'],
  ];
  test.each([
    ['other127', '127.0.0.2', []],
    ['remote', '192.0.2.1', []],
    ['absent', '', []],
    ['forwarded', '127.0.0.1', ['Forwarded', '']],
    ['x-forwarded-for', '127.0.0.1', ['X-Forwarded-For', '']],
    ['x-forwarded-host', '127.0.0.1', ['X-Forwarded-Host', '127.0.0.1:43141']],
    ['real-ip', '127.0.0.1', ['X-Real-IP', '']],
    ['tailscale', '127.0.0.1', ['Tailscale-User-Login', 'operator']],
    ['proxy', '127.0.0.1', ['X-Station-Proxy-Version', '']],
    ['internal', '127.0.0.1', ['X-Station-Internal-Token', '']],
    ['identity', '127.0.0.1', ['X-Station-Ingress-Identity', '']],
    ['tenant', '127.0.0.1', ['X-Station-Internal-Tenant', '']],
    ['missing Host', '127.0.0.1', null],
    ['duplicate Host', '127.0.0.1', ['Host', '127.0.0.1:43141']],
    ['authority conflict', '127.0.0.1', [':authority', 'attacker.test']],
  ])(
    'loopback predicate refuses %s before discovery/allocation/verification',
    async (_label, peer, extra) => {
      const f = await fixture();
      const rawHeaders =
        extra === null ? [] : ['Host', '127.0.0.1:43141', ...extra];
      for (const [method, path] of leaves) {
        const response = await f.request(
          path!,
          { method },
          { peer, rawHeaders },
        );
        expect(response.status, `${method} ${path}`).toBe(404);
      }
      expect(f.service.store.pending()).toHaveLength(0);
      expect(f.service.store.outbox()).toHaveLength(0);
    },
  );
  test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'normalized direct peer %s discovers exact resource',
    async (peer) => {
      const f = await fixture();
      expect(
        (
          await f.request(
            '/.well-known/oauth-protected-resource/mcp',
            {},
            { peer },
          )
        ).status,
      ).toBe(200);
    },
  );
  test.each([
    '127.0.0.1:043141',
    '127.0.0.1:43141.',
    '127.0.0.1.',
    'LOCALHOST:43141',
    '127.000.000.001:43141',
  ])('Host %s is not an issuer alias', async (host) => {
    const f = await fixture();
    expect(
      (
        await f.request('/.well-known/oauth-authorization-server', {
          headers: { host },
        })
      ).status,
    ).toBe(404);
  });
  test('localhost refusal names R without redirect; port 80 requires omitted port; exact IPv6 Host works', async () => {
    const f = await fixture();
    const response = await f.request('/.well-known/oauth-protected-resource', {
      headers: { host: 'localhost:43141' },
    });
    expect(await response.json()).toMatchObject({
      error_description: expect.stringContaining(resource),
    });
    expect(response.headers.get('location')).toBeNull();
    const defaultPort = await fixture({ issuer: 'http://127.0.0.1' });
    expect(
      (await defaultPort.request('/.well-known/oauth-protected-resource'))
        .status,
    ).toBe(200);
    expect(
      (
        await defaultPort.request('/.well-known/oauth-protected-resource', {
          headers: { host: '127.0.0.1:80' },
        })
      ).status,
    ).toBe(404);
    const ipv6 = await fixture({ issuer: 'http://[::1]:43141' });
    expect(
      (
        await ipv6.request(
          '/.well-known/oauth-protected-resource',
          {},
          { peer: '::1' },
        )
      ).status,
    ).toBe(200);
  });
  test('a clear Serve result cannot recover routes until the sweep is healthy too', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => 'clear' as const);
    const f = await fixture({ checkServe: check });
    const sweep = vi.spyOn(f.service.store, 'sweep').mockImplementation(() => {
      throw new Error('storage failed');
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(
      (await f.request('/.well-known/oauth-protected-resource')).status,
    ).toBe(404);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (await f.request('/.well-known/oauth-protected-resource')).status,
    ).toBe(404);
    sweep.mockRestore();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (await f.request('/.well-known/oauth-protected-resource')).status,
    ).toBe(200);
  });
  test('startup refuses mapped or unverifiable Serve and periodic mapping closes waiting family', async () => {
    const f = await fixture();
    for (const state of ['mapped', 'unverifiable'] as const)
      await expect(
        createOutsideAgentOAuthServer({
          store: f.service.store,
          validateGrant: () => true,
          exposure: f.exposure,
          checkServe: async () => state,
        }),
      ).rejects.toThrow('Tailscale Serve');
    vi.useFakeTimers();
    let mapped = false;
    const p = await fixture({
      checkServe: async () => (mapped ? 'mapped' : 'clear'),
    });
    const client = await p.register();
    const flow = await p.start(client.client_id);
    await vi.advanceTimersByTimeAsync(10_000);
    const wait = p.request(
      `/oauth/authorize/status?request_id=${flow.requestId}`,
      { headers: { cookie: flow.cookie, 'sec-fetch-site': 'same-origin' } },
    );
    await Promise.resolve();
    mapped = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await wait).status).toBe(404);
    expect(
      (await p.request('/.well-known/oauth-protected-resource')).status,
    ).toBe(404);
  });
  test('release guard runs before OAuth store effects, hosted configuration and insecure remote issuers refuse', async () => {
    const f = await fixture();
    const app = new Hono();
    app.use('*', outsideAgentReleaseGuard);
    app.route('', f.server.app);
    for (const [method, path] of leaves)
      expect((await app.request(`${issuer}${path}`, { method })).status).toBe(
        404,
      );
    expect(f.service.store.outbox()).toHaveLength(0);
    await expect(
      createOutsideAgentOAuthServer({
        store: f.service.store,
        validateGrant: () => true,
        exposure: { ...f.exposure, hosted: true },
      }),
    ).rejects.toThrow('hosted');
    for (const origin of ['http://localhost:43141', 'http://192.168.1.1:43141'])
      await expect(
        createOutsideAgentOAuthServer({
          store: f.service.store,
          validateGrant: () => true,
          exposure: { ...f.exposure, issuer: origin },
        }),
      ).rejects.toThrow('HTTPS');
    for (const [method, path] of leaves)
      expect(
        requiredExternalSurfaceCapability('http', method!, path!)?.capability,
      ).toBe('public');
    expect(
      requiredExternalSurfaceCapability('http', 'GET', '/oauth/unknown')
        ?.capability,
    ).not.toBe('public');
  });
});

describe('registration, redirects, CORS and budgets', () => {
  test.each([
    { token_endpoint_auth_method: 'client_secret_basic' },
    { application_type: 'service' },
    { grant_types: ['client_credentials'] },
    { response_types: ['token'] },
    { redirect_uris: [] },
    { redirect_uris: Array(6).fill(redirect) },
    { client_name: 'x'.repeat(129) },
    { contacts: Array(4).fill('x@example.test') },
    { redirect_uris: ['https://attacker.test/callback'] },
    { redirect_uris: ['http://localhost.attacker.test/callback'] },
    { redirect_uris: ['http://127.0.0.2/callback'] },
    { redirect_uris: ['http://user@localhost:43198/callback'] },
    { redirect_uris: ['http://localhost:43198/callback#fragment'] },
    { redirect_uris: ['http://2130706433/callback'] },
    { redirect_uris: ['http://localhost:43198/callback%xx'] },
    { redirect_uris: ['custom:callback'] },
  ])(
    'DCR refuses incompatible or unsafe registration %j without state',
    async (extra) => {
      const f = await fixture();
      const response = await f.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...metadata, ...extra }),
      });
      expect(response.status).toBe(400);
      expect(f.service.store.outbox()).toHaveLength(0);
    },
  );
  test('DCR body ceiling and unapproved TTL produce a bounded recovery tombstone', async () => {
    const f = await fixture();
    expect(
      (
        await f.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...metadata, ignored: 'x'.repeat(16384) }),
        })
      ).status,
    ).toBe(400);
    const client = await f.register();
    f.clock.now += DAY;
    const response = await f.request(
      `/oauth/authorize?${new URLSearchParams({ resource, client_id: client.client_id })}`,
    );
    expect(await response.text()).toContain('Cancel the waiting login');
    expect(f.service.store.recovery(client.client_id)).toMatchObject({
      reason: 'expired',
    });
  });
  test.each([
    [
      'http://127.0.0.1:43198/callback?a=%20',
      'http://127.0.0.1:49999/callback?a=%20',
      true,
    ],
    ['http://[::1]:43198/callback', 'http://[::1]:49999/callback', true],
    [redirect, 'http://localhost:49999/callback', false],
    [redirect, 'http://127.0.0.1:43198/callback', false],
    [
      'http://127.0.0.1:43198/callback',
      'http://127.0.0.1:43198/callback/more',
      false,
    ],
    [
      'http://127.0.0.1:43198/callback?a=%20',
      'http://127.0.0.1:43198/callback?a=+',
      false,
    ],
    [
      'http://127.0.0.1:43198/callback',
      'http://127.0.0.1:43198/%63allback',
      false,
    ],
  ])(
    'redirect %s -> %s has only literal-IP port flexibility',
    async (registered, actual, allowed) => {
      const f = await fixture();
      const client = await f.register({ redirect_uris: [registered] });
      const params = new URLSearchParams({
        client_id: client.client_id,
        response_type: 'code',
        redirect_uri: actual,
        resource,
        state: 's',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      });
      const response = await f.request(`/oauth/authorize?${params}`);
      expect(response.status).toBe(allowed ? 200 : 400);
      expect(response.headers.get('location')).toBeNull();
    },
  );
  test('allowlisted web callback is visibly remote, exact at exchange, and removal cancels before completion', async () => {
    const f = await fixture();
    f.commit({
      operation: 'origin',
      policy: 'redirect',
      action: 'add',
      origin: 'https://callback.example.test',
      expectedRevision: 0,
    });
    const remote = 'https://callback.example.test/callback?a=%20';
    const client = await f.register({
      application_type: 'web',
      redirect_uris: [remote],
    });
    const flow = await f.start(client.client_id, { redirect_uri: remote });
    expect(flow.html).toContain(
      'sends access to https://callback.example.test, a remote site',
    );
    f.approval(flow.requestId);
    f.commit({
      operation: 'origin',
      policy: 'redirect',
      action: 'remove',
      origin: 'https://callback.example.test',
      expectedRevision: 1,
    });
    const response = await f.complete(flow);
    expect(response.status).not.toBe(303);
    expect(f.service.store.grants()).toHaveLength(0);
  });
  test('CORS is exact and operator-managed; no wildcard, credential substitution, or management preflight', async () => {
    const f = await fixture({
      issuer: 'https://station.example.test',
      trusted: true,
    });
    const register = () =>
      f.request('/oauth/register', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://browser.example.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Content-Type',
        },
      });
    expect((await register()).status).toBe(403);
    f.commit({
      operation: 'origin',
      policy: 'cors',
      action: 'add',
      origin: 'https://browser.example.test',
      expectedRevision: 0,
    });
    const accepted = await register();
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(
      'https://browser.example.test',
    );
    expect(accepted.headers.get('access-control-allow-credentials')).toBeNull();
    for (const origin of [
      'null',
      'https://sub.browser.example.test',
      'https://browser.example.test:444',
    ])
      expect(
        (
          await f.request('/.well-known/oauth-protected-resource', {
            headers: { origin, authorization: 'Bearer valid-does-not-help' },
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await f.request('/oauth/token', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://browser.example.test',
            'access-control-request-method': 'DELETE',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request('/oauth/token', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://browser.example.test',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'X-Station-Internal-Token',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request('/api/outside-agent/host/confirm', {
          method: 'OPTIONS',
          headers: { origin: 'https://browser.example.test' },
        })
      ).status,
    ).toBe(404);
    f.commit({
      operation: 'origin',
      policy: 'cors',
      action: 'remove',
      origin: 'https://browser.example.test',
      expectedRevision: 1,
    });
    expect((await register()).status).toBe(403);
  });
  test('persistent direct-peer daily budget survives reopening; global ceiling applies without verifiable identity', async () => {
    const f = await fixture();
    for (let i = 0; i < 50; i++) {
      await f.register();
      f.clock.now += MINUTE;
    }
    expect(
      (
        await f.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(metadata),
        })
      ).status,
    ).toBe(429);
    // A second connection/boot sees the same durable quota, rather than resetting admission.
    const reopened = await fixture({ home: f.home });
    reopened.clock.now = f.clock.now;
    expect(
      (
        await reopened.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(metadata),
        })
      ).status,
    ).toBe(429);
    const proxy = await fixture({
      issuer: 'https://station.example.test',
      trusted: true,
    });
    for (let i = 0; i < 30; i++) await proxy.register();
    const response = await proxy.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });
  test('five independent ticket requests survive a sixth refusal; other tickets cannot spend their per-client allowance', async () => {
    const f = await fixture({
      issuer: 'https://station.example.test',
      trusted: true,
    });
    const initial = await f.register({
      redirect_uris: ['http://127.0.0.1:43198/callback'],
    });
    const first = await f.start(initial.client_id, {
      redirect_uri: 'http://127.0.0.1:43198/callback',
    });
    for (let i = 1; i < 5; i++) {
      f.clock.now += MINUTE;
      const client = await f.register();
      await f.start(client.client_id, {}, first.cookie);
    }
    f.clock.now += MINUTE;
    const sixth = await f.register();
    const response = await f.request(
      `/oauth/authorize?${new URLSearchParams({ client_id: sixth.client_id, response_type: 'code', redirect_uri: redirect, resource: `${f.exposure.issuer}/mcp`, state: 's', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`,
      { headers: { cookie: first.cookie } },
    );
    expect(response.status).toBe(429);
    expect(f.service.store.pending()).toHaveLength(5);
    expect(f.service.store.request(first.requestId)!.state).toBe('pending');
  });
});
