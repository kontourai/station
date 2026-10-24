import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { runOutsideClientsCommand } from '../../../../packages/cli/src/commands/outside-clients.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { installStationEnvelopeMarker } from '../../../runtime/bootstrap/runtime-http.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  OutsideAgentManagementService,
  type OutsideManagementAction,
} from '../../../services/outside-agent/management-service.js';
import { DAY } from '../../../services/outside-agent/oauth-records.js';
import { pkceChallenge } from '../../../services/outside-agent/oauth-registration.js';
import { registerOutsideAgentHostRoutes } from '../host-routes.js';

const temp = trackTempDirs();
const opened: OutsideAgentManagementService[] = [];
afterEach(() => {
  for (const service of opened.splice(0)) service.store.close();
});
const issuer = 'https://station.test';
const redirectUri = 'http://127.0.0.1:43197/callback';
const actor = {
  kind: 'host' as const,
  id: 'host-channel',
  authorityRevision: 'boot-1',
  delegatingPrincipalId: 'operator',
};
const routes = [
  ['GET', '/api/outside-agent/clients'],
  ['GET', '/api/outside-agent/redirect-origins'],
  ['GET', '/api/outside-agent/cors-origins'],
  ['POST', '/api/outside-agent/host/review'],
  ['POST', '/api/outside-agent/host/confirm'],
  ['POST', '/api/outside-agent/host/deny'],
  ['POST', '/api/outside-agent/host/register'],
  ['POST', '/api/outside-agent/grants/grant/change'],
  ['POST', '/api/outside-agent/grants/grant/revoke'],
  ['POST', '/api/outside-agent/redirect-origins/change'],
  ['POST', '/api/outside-agent/cors-origins/change'],
] as const;
function fixture(released = false) {
  let now = 1_800_000_000_000;
  let authority = true;
  const projects = new Map([
    ['alpha', 'project-a'],
    ['beta', 'project-b'],
  ]);
  const home = temp('outside-r2a-');
  const service = OutsideAgentManagementService.open(
    home,
    { stationId: 'station', bootId: 'boot-1', issuer, now: () => now },
    {
      current: (candidate) =>
        authority &&
        candidate.authorityRevision === 'boot-1' &&
        candidate.delegatingPrincipalId === 'operator',
      resolveProject: (slug) =>
        projects.has(slug) ? { id: projects.get(slug)! } : null,
      projectExists: (id) => [...projects.values()].includes(id),
    },
  );
  opened.push(service);
  const app = new Hono();
  if (released) installStationEnvelopeMarker(app);
  // Isolated non-distributable composition: bind the same authenticated principal facts as HTTP admission.
  app.use('*', async (c, next) => {
    const credential = c.req.header('authorization')?.replace('Bearer ', '');
    if (credential) {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential,
        source: 'bearer',
        authority:
          credential === 'session'
            ? 'operator-session'
            : credential === 'operator'
              ? 'operator-credential'
              : 'device-credential',
        ...(credential === 'local' || credential === 'bootstrap'
          ? {
              locality: 'home-possession',
              mintKind: credential === 'local' ? 'local-grant' : 'ui-bootstrap',
            }
          : {}),
      });
      bindRuntimeLocalOperator(c.req.raw);
    }
    await next();
  });
  registerOutsideAgentHostRoutes(app, {
    service,
    localGrantSecret: 'current-boot-secret',
    actor,
  });
  const send = async (
    path: string,
    value?: unknown,
    credential = 'local',
    proof: string | null = 'current-boot-secret',
    extra: Record<string, string> = {},
  ) => {
    const response = await app.request(`${issuer}${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(proof === null ? {} : { 'x-station-host-proof': proof }),
        ...extra,
        'Content-Type': 'application/json',
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const client = service.store.register({
    application_type: 'native',
    client_name: 'Lookalike\u202e\u001b',
    software_id: 'test',
    redirect_uris: [redirectUri],
  });
  const start = (clientId = client.id, callback = redirectUri) => {
    const verifier = randomBytes(32).toString('base64url');
    const flow = service.store.start({
      clientId,
      redirectUri: callback,
      resource: `${issuer}/mcp`,
      state: 'private-state',
      challenge: pkceChallenge(verifier),
      scopes: ['station-control:read', 'station-control:full'],
    });
    return { ...flow, verifier };
  };
  const action = (flow: ReturnType<typeof start>): OutsideManagementAction => {
    const row = service
      .list(actor)
      .pending.find((row) => row.requestId === flow.request.id)!;
    return {
      operation: 'approve',
      requestId: flow.request.id,
      clientId: row.clientId,
      expectedRequestFingerprint: row.expectedRequestFingerprint,
      project: { kind: 'project', slug: 'alpha' },
      accessLevel: 'read-only',
      expiresAt: now + DAY,
      supersessions: [],
    };
  };
  const commit = async (
    action: unknown,
    path: string,
    decisionId = randomBytes(32).toString('base64url'),
  ) => {
    const reviewed = await send('/api/outside-agent/host/review', { action });
    expect(reviewed.status).toBe(200);
    return send(path, {
      action,
      fingerprint: z.object({ fingerprint: z.string() }).parse(reviewed.body)
        .fingerprint,
      decisionId,
    });
  };
  const exchange = (flow: ReturnType<typeof start>) => {
    const complete = service.store.complete(
      flow.request.id,
      flow.ticket,
      flow.nonce,
    );
    return service.store.exchange({
      code: complete.code,
      clientId: flow.request.clientId,
      redirectUri: flow.request.redirectUri,
      resource: `${issuer}/mcp`,
      verifier: flow.verifier,
    });
  };
  const cli = async (
    args: string[],
    confirm: ((question: string) => Promise<boolean>) | null = async () => true,
  ) => {
    const output: string[] = [];
    await runOutsideClientsCommand(args, {
      write: (line) => output.push(line),
      confirm: confirm ?? undefined,
      now: () => now,
      openChannel: async () => ({
        request: async (path, init) => {
          const result = await send(
            path,
            init?.body ? JSON.parse(String(init.body)) : undefined,
          );
          if (result.status !== 200) throw new Error(JSON.stringify(result));
          return result.body;
        },
      }),
    });
    return output.join('\n');
  };
  return {
    service,
    home,
    app,
    send,
    start,
    action,
    commit,
    exchange,
    cli,
    projects,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    endAuthority: () => {
      authority = false;
    },
  };
}

test('every host route refuses non-host credentials, raw operator/session without step-up, missing and prior-boot proof before domain work', async () => {
  const f = fixture();
  const before = f.service.store.outbox();
  for (const [method, path] of routes) {
    expect(requiredPairingScope(method, path)).toBe('access:manage');
    for (const credential of [
      '',
      'anonymous',
      'device',
      'operator',
      'session',
      'bootstrap',
      'internal',
      'outside-token',
    ]) {
      expect(
        (await f.send(path, method === 'GET' ? undefined : {}, credential))
          .status,
        `${method} ${path} ${credential}`,
      ).toBe(403);
    }
    for (const proof of [null, 'prior-boot-secret'])
      expect(
        (await f.send(path, method === 'GET' ? undefined : {}, 'local', proof))
          .status,
      ).toBe(403);
    expect(
      (
        await f.send(
          path,
          method === 'GET' ? undefined : {},
          'local',
          'current-boot-secret',
          { Origin: issuer },
        )
      ).status,
    ).toBe(403);
  }
  expect(f.service.store.outbox()).toEqual(before);
});

test('released composition refuses every actual host route with valid host proof and zero outside writes', async () => {
  const f = fixture(true);
  const before = f.service.store.outbox();
  for (const [method, path] of routes)
    expect(
      (await f.send(path, method === 'GET' ? undefined : {})).status,
      `${method} ${path}`,
    ).toBe(404);
  expect(f.service.store.outbox()).toEqual(before);
});

test('host CLI lists comparison code/details and approves by ID; approval records intent, exchange activates and only explicit supersessions disconnect', async () => {
  const f = fixture();
  const first = f.start();
  const output = await f.cli(['list']);
  expect(output).toContain(first.comparisonCode);
  expect(output).toContain(first.request.id);
  expect(output).toContain(redirectUri);
  expect(output).toContain('station-control:full');
  expect(output).not.toContain('private-state');
  expect(output).not.toContain('ticketHash');
  expect(output).not.toContain(first.ticket);
  expect(output).not.toContain('\\u202e');
  const result = await f.cli([
    'approve',
    first.request.id,
    '--project=alpha',
    '--expires-in=1d',
  ]);
  expect(result).toContain('approved-awaiting-exchange');
  expect(result).toContain('Lookalike');
  expect(result).toContain('softwareId');
  expect(result).not.toContain('\\u202e');
  expect(f.service.store.grants()).toEqual([]);
  const issued = f.exchange(first);
  const second = f.start();
  const approve = f.action(second);
  const reviewed = f.service.review(approve, actor);
  expect(reviewed.supersessionCandidates).toMatchObject([
    { grantId: issued.grant.id, selected: false, match: 'unverified' },
  ]);
  const selected = {
    grantId: issued.grant.id,
    expectedVersion: issued.grant.version,
    expectedDigest: f.service.store.grantDigest(issued.grant),
  };
  // A separate new request supersedes only a reviewed same-Project grant.
  const third = f.start();
  await f.cli([
    'approve',
    third.request.id,
    '--project=alpha',
    '--expires-in=1d',
    `--supersede=${selected.grantId}:${selected.expectedVersion}:${selected.expectedDigest}`,
  ]);
  expect(
    f.service.store.access(issued.accessToken, `${issuer}/mcp`),
  ).toBeDefined();
  f.exchange(third);
  expect(
    f.service.store.access(issued.accessToken, `${issuer}/mcp`),
  ).toBeUndefined();
  expect(
    f.service.store.grants().find((g) => g.id === issued.grant.id)?.reason,
  ).toBe('superseded');
});

test('comparison codes cannot select a request or enter route decisions; unknown fields and full selection refuse', async () => {
  const f = fixture();
  const flow = f.start();
  await expect(
    f.cli(['approve', flow.comparisonCode, '--global']),
  ).rejects.toThrow('Comparison codes');
  for (const action of [
    { ...f.action(flow), requestId: flow.comparisonCode },
    { ...f.action(flow), code: flow.comparisonCode },
    { ...f.action(flow), accessLevel: 'full' },
  ])
    expect(
      (await f.send('/api/outside-agent/host/review', { action })).status,
    ).toBe(400);
  expect(f.service.store.request(flow.request.id)?.state).toBe('pending');
});

test('deny, stable registration, grant change/revoke and both exact-origin policies execute through host CLI and routes', async () => {
  const f = fixture();
  const denied = f.start();
  await f.cli(['deny', denied.request.id]);
  expect(f.service.store.request(denied.request.id)?.state).toBe('denied');
  expect(
    await f.cli([
      'register',
      '--name=Stable installation',
      `--redirect-uri=${redirectUri}`,
    ]),
  ).toContain('Stable public client ID');
  expect(
    await f.cli(['redirect-origins', 'add', 'https://BÜCHER.example.:443']),
  ).toContain('changed');
  expect(await f.cli(['redirect-origins', 'list'])).toContain(
    'https://xn--bcher-kva.example',
  );
  expect(
    await f.cli(['cors-origins', 'add', 'https://browser.example:443/']),
  ).toContain('changed');
  expect(await f.cli(['cors-origins', 'list'])).toContain(
    'https://browser.example',
  );
  await f.cli(['cors-origins', 'remove', 'https://browser.example']);
  const flow = f.start();
  await f.cli([
    'approve',
    flow.request.id,
    '--project=alpha',
    '--expires-in=2d',
  ]);
  const old = f.exchange(flow);
  f.advance(60_000);
  await f.cli(['change', old.grant.id, '--project=beta']);
  expect(
    f.service.store.grants().find((g) => g.id === old.grant.id)?.expiresAt,
  ).toBe(old.grant.expiresAt);
  expect(
    f.service.store.access(old.accessToken, `${issuer}/mcp`),
  ).toBeUndefined();
  expect(
    f.service.store.grants().find((g) => g.id === old.grant.id),
  ).toMatchObject({
    reason: 'changed',
    selection: { projectScope: { projectId: 'project-b' } },
  });
  const next = f.start();
  await f.cli(['approve', next.request.id, '--global', '--expires-in=1d']);
  const active = f.exchange(next);
  await f.cli(['revoke', active.grant.id]);
  expect(
    f.service.store.access(active.accessToken, `${issuer}/mcp`),
  ).toBeUndefined();
  expect(
    f.service.store.outbox().some((event) => event.kind === 'policy-changed'),
  ).toBe(true);
});

test('redirect removal atomically cancels pending and revokes active remote grants', async () => {
  const f = fixture();
  await f.cli(['redirect-origins', 'add', 'https://remote.example']);
  const client = f.service.store.register({
    redirect_uris: ['https://remote.example/callback'],
    client_name: 'Remote',
  });
  const flow = f.start(client.id, 'https://remote.example/callback');
  const action = f.action(flow);
  expect(f.service.review(action, actor).warning).toBe(
    'sends access to https://remote.example, a remote site',
  );
  expect(
    (await f.commit(action, '/api/outside-agent/host/confirm')).status,
  ).toBe(200);
  const issued = f.exchange(flow);
  const pending = f.start(client.id, 'https://remote.example/callback');
  await f.cli(['redirect-origins', 'remove', 'https://remote.example']);
  expect(
    f.service.store.access(issued.accessToken, `${issuer}/mcp`),
  ).toBeUndefined();
  expect(f.service.store.request(pending.request.id)?.state).toBe('denied');
  expect(() =>
    f.service.store.register({
      redirect_uris: ['https://remote.example/callback'],
    }),
  ).toThrow('invalid_request');
});

test.each([
  '*',
  'https://*.example',
  'https://example.com/path',
  'https://example.com?',
  'https://example.com#',
  'http://example.com',
  'https://user@example.com',
  'https://@example.com',
  'https://example.com..',
  'https://foo..example',
  'https:example.com',
  'https://example.com\\@evil.com',
  'null',
  'https://%65xample.com',
  'https://127.1',
  'https://2130706433',
  'https://0x7f000001',
])('origin input %s cannot widen an allowlist', async (origin) => {
  const f = fixture();
  expect(
    (
      await f.send('/api/outside-agent/host/review', {
        action: {
          operation: 'origin',
          policy: 'redirect',
          action: 'add',
          origin,
          expectedRevision: 0,
        },
      })
    ).status,
  ).toBe(409);
  expect(f.service.store.policy('redirect').origins).toEqual([]);
});

test('stale fingerprints, Project deletion, authority loss, altered selections and decision replay never apply a second mutation', async () => {
  const f = fixture();
  const flow = f.start();
  const action = f.action(flow);
  const review = f.service.review(action, actor);
  const decisionId = randomBytes(32).toString('base64url');
  expect(() =>
    f.service.commit(
      {
        action: { ...action, project: { kind: 'global' } },
        fingerprint: review.fingerprint,
        decisionId,
      },
      actor,
    ),
  ).toThrow('target_changed');
  f.projects.delete('alpha');
  expect(() =>
    f.service.commit(
      { action, fingerprint: review.fingerprint, decisionId },
      actor,
    ),
  ).toThrow('target_changed');
  f.projects.set('alpha', 'project-a');
  const effect = f.service.commit(
    { action, fingerprint: review.fingerprint, decisionId },
    actor,
  );
  expect(
    f.service.commit(
      { action, fingerprint: review.fingerprint, decisionId },
      actor,
    ),
  ).toEqual(effect);
  expect(
    f.service.store.outbox().filter((event) => event.kind === 'approved'),
  ).toHaveLength(1);
  f.endAuthority();
  expect(() => f.exchange(flow)).toThrow('invalid_grant');
  expect(f.service.store.grants()).toEqual([]);
});

test('unredeemed intent expires without disconnecting old grant and stale policy reviews fail', async () => {
  const f = fixture();
  const first = f.start();
  await f.cli(['approve', first.request.id, '--global', '--expires-in=1d']);
  const active = f.exchange(first);
  const next = f.start();
  const action = f.action(next);
  const review = f.service.review(action, actor);
  await f.cli(['redirect-origins', 'add', 'https://new.example']);
  expect(() =>
    f.service.commit(
      {
        action,
        fingerprint: review.fingerprint,
        decisionId: randomBytes(32).toString('base64url'),
      },
      actor,
    ),
  ).toThrow('target_changed');
  await f.cli([
    'approve',
    next.request.id,
    '--global',
    '--expires-in=1d',
    `--supersede=${active.grant.id}:${active.grant.version}:${f.service.store.grantDigest(active.grant)}`,
  ]);
  f.advance(11 * 60_000);
  f.service.store.sweep();
  expect(
    f.service.store.access(active.accessToken, `${issuer}/mcp`),
  ).toBeDefined();
});

test('bounded strict JSON rejects duplicate escaped fields, content types and oversized bodies before allocation', async () => {
  const f = fixture();
  const before = f.service.store.outbox();
  for (const body of [
    '{"action":{"operation":"register","name":"first","\\u006eame":"second","redirectUri":"http://127.0.0.1:43197/callback"}}',
    '{"action":{},"action":{}}',
  ]) {
    const response = await f.app.request(
      `${issuer}/api/outside-agent/host/review`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer local',
          'x-station-host-proof': 'current-boot-secret',
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    expect(response.status).toBe(400);
  }
  const large = await f.send('/api/outside-agent/host/review', {
    action: 'x'.repeat(50 * 1024),
  });
  expect(large.status).toBe(413);
  expect(f.service.store.outbox()).toEqual(before);
});

test('host request budgets are bounded before allocating registration or review state', async () => {
  const f = fixture();
  for (let i = 0; i < 120; i++)
    expect((await f.send('/api/outside-agent/cors-origins')).status).toBe(200);
  const response = await f.send('/api/outside-agent/host/review', {
    action: { operation: 'register', name: 'limited', redirectUri },
  });
  expect(response.status).toBe(429);
  f.advance(60_000);
  expect((await f.send('/api/outside-agent/cors-origins')).status).toBe(200);
});

test('shared projections retain comparison codes for H only and durable policies reopen at the same revision', async () => {
  const f = fixture();
  const flow = f.start();
  expect(
    f.service
      .list({ ...actor, kind: 'operator-passkey' })
      .pending.find((row) => row.requestId === flow.request.id)?.comparisonCode,
  ).toBeNull();
  await f.cli(['cors-origins', 'add', 'https://EXAMPLE.com.:443']);
  const peer = OutsideAgentManagementService.open(
    f.home,
    { ...f.service.store.options, now: f.now },
    f.service.authority,
  );
  opened.push(peer);
  expect(f.service.store.policy('cors')).toEqual({
    kind: 'cors',
    revision: 1,
    origins: ['https://example.com'],
  });
  // A second connection reads the committed policy, without replaying a decision.
  expect(peer.store.policy('cors')).toEqual(f.service.store.policy('cors'));
});

test('noninteractive host approval binds exact client/fingerprint and explicit empty supersession without guessing', async () => {
  const f = fixture();
  const flow = f.start();
  const row = f.service
    .list(actor)
    .pending.find((row) => row.requestId === flow.request.id)!;
  await expect(
    f.cli(
      [
        'approve',
        flow.request.id,
        '--global',
        `--client-id=${row.clientId}`,
        `--request-fingerprint=${'0'.repeat(64)}`,
        '--supersede=none',
      ],
      null,
    ),
  ).rejects.toThrow('Request or client changed');
  expect(f.service.store.request(flow.request.id)?.state).toBe('pending');
  const output = await f.cli(
    [
      'approve',
      flow.request.id,
      '--global',
      `--client-id=${row.clientId}`,
      `--request-fingerprint=${row.expectedRequestFingerprint}`,
      '--supersede=none',
    ],
    null,
  );
  expect(output).toContain('approved-awaiting-exchange');
  expect(f.service.store.grants()).toEqual([]);
});

test('JSON review treats escaped quotes, braces and backslashes in untrusted labels as data', async () => {
  const f = fixture();
  const output = await f.cli([
    'register',
    '--name=Installation "{label}" \\ text',
    `--redirect-uri=${redirectUri}`,
  ]);
  expect(output).toContain('registered');
});
