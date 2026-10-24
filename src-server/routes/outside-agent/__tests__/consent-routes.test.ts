import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  OUTSIDE_TEST_APP,
  OUTSIDE_TEST_CONSENT,
  outsideConsentFixture,
} from '../../../__test-utils__/outside-agent-consent-fixture.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { registerConsentRoutes } from '../../../runtime/consent/consent-listener.js';
import {
  isLeafScopeDeclared,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import type { ConsentDecisionAuthority } from '../../../services/consent/consent-transactions.js';
import { ConsentTransactionStore } from '../../../services/consent/consent-transactions.js';
import type { OutsideManagementAction } from '../../../services/outside-agent/management-service.js';
import { DAY } from '../../../services/outside-agent/oauth-records.js';

const temp = trackTempDirs();
type Harness = Awaited<ReturnType<typeof outsideConsentFixture>>;
const open: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of open.splice(0)) h.close();
});
async function fixture() {
  const h = await outsideConsentFixture(temp('outside-r2b-'));
  open.push(h);
  return h;
}
const kinds = [
  'approve',
  'deny',
  'revoke',
  'change',
  'redirect-add',
  'redirect-remove',
  'cors-add',
  'cors-remove',
] as const;
type Kind = (typeof kinds)[number];
function actionFor(h: Harness, kind: Kind): OutsideManagementAction {
  if (kind === 'approve' || kind === 'deny') {
    const action = h.approval(h.start());
    if (action.operation !== 'approve') throw new Error('approval fixture');
    return kind === 'approve'
      ? action
      : {
          operation: 'deny',
          requestId: action.requestId,
          clientId: action.clientId,
          expectedRequestFingerprint: action.expectedRequestFingerprint,
        };
  }
  if (kind === 'change' || kind === 'revoke') {
    const { grant } = h.activate();
    const base = {
      grantId: grant.grantId,
      expectedVersion: grant.version,
      expectedDigest: grant.digest,
    };
    return kind === 'revoke'
      ? { operation: 'revoke', ...base }
      : {
          operation: 'change',
          ...base,
          project: { kind: 'project', slug: 'beta' },
          accessLevel: 'read-only',
          expiresAt: h.clock.now + 2 * DAY,
        };
  }
  const policy = kind.startsWith('redirect') ? 'redirect' : 'cors';
  if (kind.endsWith('remove'))
    h.hostCommit({
      operation: 'origin',
      policy,
      action: 'add',
      origin: 'https://client.example.test',
      expectedRevision: h.management.store.policy(policy).revision,
    });
  return {
    operation: 'origin',
    policy,
    action: kind.endsWith('remove') ? 'remove' : 'add',
    origin: 'https://client.example.test',
    expectedRevision: h.management.store.policy(policy).revision,
  };
}
async function create(h: Harness, action: OutsideManagementAction) {
  const response = await h.request(action);
  expect(response.status).toBe(202);
  const body = (await response.json()) as {
    status: string;
    transaction: { id: string; reviewUrl: string };
  };
  expect(body.status).toBe('step_up_required');
  expect(body.transaction.reviewUrl).toBe(
    `${OUTSIDE_TEST_CONSENT}/consent/${body.transaction.id}`,
  );
  return { id: body.transaction.id, ...(await h.review(body.transaction.id)) };
}
function snapshot(h: Harness) {
  return {
    requests: h.management.store.pending().map((r) => r.request),
    grants: h.management.store.grants(),
    redirect: h.management.store.policy('redirect'),
    cors: h.management.store.policy('cors'),
  };
}
function assertEffect(h: Harness, action: OutsideManagementAction) {
  if (action.operation === 'approve') {
    expect(h.management.store.request(action.requestId)?.state).toBe(
      'approved',
    );
    expect(h.management.store.grants()).toHaveLength(0);
  } else if (action.operation === 'deny')
    expect(h.management.store.request(action.requestId)?.state).toBe('denied');
  else if (action.operation === 'revoke')
    expect(
      h.management.store.grants().find((g) => g.id === action.grantId)?.state,
    ).toBe('revoked');
  else if (action.operation === 'change')
    expect(
      h.management.store.grants().find((g) => g.id === action.grantId),
    ).toMatchObject({
      version: action.expectedVersion + 1,
      selection: {
        projectScope: { kind: 'project', projectId: 'project-beta' },
        expiresAt: action.expiresAt,
      },
    });
  else if (action.operation === 'origin')
    expect(h.management.store.policy(action.policy)).toMatchObject({
      revision: action.expectedRevision + 1,
      origins: action.action === 'add' ? ['https://client.example.test'] : [],
    });
}
function alterState(h: Harness, action: OutsideManagementAction) {
  if (action.operation === 'approve' || action.operation === 'deny')
    h.management.store.deny(
      action.requestId,
      h.management.store.request(action.requestId)!.version,
    );
  else if (action.operation === 'revoke' || action.operation === 'change')
    h.management.store.revoke(action.grantId, action.expectedVersion);
  else if (action.operation === 'origin')
    h.hostCommit({
      ...action,
      action: 'add',
      origin: 'https://other.example.test',
    });
}
const sign = (h: Harness, page: Awaited<ReturnType<typeof create>>) =>
  h.enrolled.authenticator.authenticate(page.options, {
    origin: OUTSIDE_TEST_CONSENT,
    counter: 2,
  });

for (const kind of kinds)
  describe(`${kind} passkey target (#4115 R2b)`, () => {
    test('assertion for A cannot commit B; own assertion commits once and replay has no effect', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const a = await create(h, action);
      const b = await create(h, action);
      const before = snapshot(h);
      const wrong = await h.decide(b.id, b.nonce, sign(h, a));
      expect(wrong.status).toBe(409);
      expect(await wrong.json()).toEqual({ error: 'authority_required' });
      expect(snapshot(h)).toEqual(before);
      const renewed = { id: b.id, ...(await h.review(b.id)) };
      const assertion = sign(h, renewed);
      const success = await h.decide(b.id, renewed.nonce, assertion);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ status: 'approved' });
      assertEffect(h, action);
      const committed = snapshot(h);
      expect((await h.decide(b.id, renewed.nonce, assertion)).status).toBe(409);
      expect(snapshot(h)).toEqual(committed);
      const transaction = h.channel.store.get('local', b.id)!;
      expect(transaction.effect).not.toHaveProperty('secret');
      expect(JSON.stringify(transaction)).not.toMatch(
        /oac_|oat_|ort_|private-oauth-state/,
      );
      expect(h.channel.store.auditTrail('local', b.id).at(-1)?.event).toBe(
        'decision-refused',
      );
    });
    test('expired review refuses without a domain effect', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const page = await create(h, action);
      const assertion = sign(h, page);
      const before = snapshot(h);
      h.clock.now += 5 * 60_000;
      const response = await h.decide(page.id, page.nonce, assertion);
      expect(response.status).toBe(409);
      expect(h.channel.store.get('local', page.id)?.status).toBe('expired');
      expect(snapshot(h)).toEqual(before);
    });
    test('expected-state mismatch closes permanently with target_changed and a closed audit event', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const page = await create(h, action);
      alterState(h, action);
      const before = snapshot(h);
      const response = await h.decide(page.id, page.nonce, sign(h, page));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'target_changed' });
      expect(snapshot(h)).toEqual(before);
      expect(h.channel.store.get('local', page.id)?.status).toBe(
        'target_changed',
      );
      expect(h.channel.store.auditTrail('local', page.id)).toContainEqual(
        expect.objectContaining({ event: 'closed', detail: 'target_changed' }),
      );
      expect(h.channel.store.renderReview('local', page.id)).toMatchObject({
        ok: false,
        reason: 'not_pending',
      });
    });
    test('server-side cancellation ends the review without applying its action', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const page = await create(h, action);
      const before = snapshot(h);
      const response = await h.decide(page.id, page.nonce, undefined, 'deny');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'denied' });
      expect(h.channel.store.get('local', page.id)?.status).toBe('denied');
      expect(snapshot(h)).toEqual(before);
      expect((await h.decide(page.id, page.nonce, sign(h, page))).status).toBe(
        409,
      );
    });
    test('session ended after revalidation cannot commit and closes terminally', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const page = await create(h, action);
      const before = snapshot(h);
      const original = h.management.review.bind(h.management);
      vi.spyOn(h.management, 'review').mockImplementationOnce(
        (input, actor) => {
          const result = original(input, actor);
          h.sessions.signOut(h.signed.secret, h.device.credential);
          return result;
        },
      );
      const response = await h.decide(page.id, page.nonce, sign(h, page));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'session_ended' });
      expect(snapshot(h)).toEqual(before);
      expect(h.channel.store.get('local', page.id)?.status).toBe(
        'session_ended',
      );
      expect(h.channel.store.auditTrail('local', page.id)).toContainEqual(
        expect.objectContaining({ event: 'closed', detail: 'session_ended' }),
      );
    });
    test('host proof, Device, raw operator and every generic consent authority cannot decide', async () => {
      const h = await fixture();
      const action = actionFor(h, kind);
      const page = await create(h, action);
      const before = snapshot(h);
      for (const authority of [
        'operator-credential',
        'device-consent-scope',
        'consent-session',
        'native-host',
        'operator-session',
      ] satisfies ConsentDecisionAuthority[]) {
        expect(
          await h.channel.store.decide(
            'local',
            page.id,
            'approved',
            page.nonce,
            authority,
            {
              sessionId: h.signed.session.sessionId,
              verify: async () => h.enrolled.passkey.id,
            },
          ),
        ).toMatchObject({ ok: false, reason: 'authority_required' });
      }
      for (const credential of [
        h.local.credential,
        h.other.credential,
        h.operator,
      ]) {
        const response = await h.consent.request(`/consent/${page.id}/decide`, {
          method: 'POST',
          headers: {
            host: new URL(OUTSIDE_TEST_CONSENT).host,
            origin: OUTSIDE_TEST_CONSENT,
            cookie: `__Host-station-device=${credential}`,
            'x-station-host-proof': 'private-test-host-proof',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            nonce: page.nonce,
            decision: 'approve',
            response: sign(h, page),
          }),
        });
        expect(response.status).toBe(404);
      }
      const secret = h.channel.store.decisionSessionSecretFor(
        'local',
        page.id,
      )!;
      const response = await h.consent.request(`/consent/${page.id}/decide`, {
        method: 'POST',
        headers: {
          host: new URL(OUTSIDE_TEST_CONSENT).host,
          origin: OUTSIDE_TEST_CONSENT,
          cookie: `station-consent=${secret}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          nonce: page.nonce,
          decision: 'approve',
          response: sign(h, page),
        }),
      });
      expect(response.status).toBe(404);
      expect(snapshot(h)).toEqual(before);
      expect(() =>
        new ConsentTransactionStore().create({
          tenantId: 'local',
          target: h.channel.store.get('local', page.id)!.target,
          description: h.channel.store.get('local', page.id)!.description,
          requester: { kind: 'host', id: 'host' },
          rateKey: 'host',
          revalidateTarget: async () => null,
          commitApproval: async () => {},
        }),
      ).toThrow('operator_action_requires_passkey_ceremony');
    });
  });

test('approval review binds selected Project/expiry/supersession and client metadata to the same host canonical target', async () => {
  const h = await fixture();
  const old = h.activate();
  const flow = h.start();
  const action = h.approval(flow);
  if (action.operation !== 'approve') throw new Error('fixture');
  const page = await create(h, action);
  expect(page.html).toContain('&lt;Client&gt;');
  expect(page.html).not.toContain('\u202e');
  expect(page.html).toContain('not proof of identity');
  expect(page.html).toContain(flow.comparisonCode);
  expect(page.html).toContain('Unselected matching grant');
  expect(page.html).toContain('This installation will keep its access.');
  const base = h.channel.store.get('local', page.id)!.target.fingerprint;
  for (const variant of [
    { ...action, project: { kind: 'global' } },
    { ...action, expiresAt: h.clock.now + 2 * DAY },
    {
      ...action,
      supersessions: [
        {
          grantId: old.grant.grantId,
          expectedVersion: old.grant.version,
          expectedDigest: old.grant.digest,
        },
      ],
    },
  ]) {
    const changed = await create(h, variant as OutsideManagementAction);
    expect(
      h.channel.store.get('local', changed.id)!.target.fingerprint,
    ).not.toBe(base);
  }
  const target = JSON.parse(base);
  expect(target).toMatchObject({
    clientId: h.client.id,
    redirectUri: flow.request.redirectUri,
    requestedScopes: ['station-control:full', 'station-control:read'],
    selectedScopes: ['station-control:read'],
    selectedAccessLevel: 'read-only',
    resource: `${OUTSIDE_TEST_APP}/mcp`,
    projectScope: { kind: 'project', projectId: 'project-alpha' },
    supersededGrants: [],
  });
  expect(
    h.management.review(action, {
      ...h.hostActor,
      kind: 'operator-passkey',
      id: h.enrolled.passkey.id,
    }).fingerprint,
  ).toBe(base);
});

test('Project slug reuse after review refuses at the actual passkey commit', async () => {
  const h = await fixture();
  const action = h.approval(h.start());
  const page = await create(h, action);
  h.projects.set('alpha', 'replacement-project');
  const response = await h.decide(page.id, page.nonce, sign(h, page));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'target_changed' });
  expect(h.management.store.grants()).toHaveLength(0);
});

test('remote callback warning and explicit supersession remain intent-only until code exchange', async () => {
  const h = await fixture();
  const old = h.activate();
  h.hostCommit({
    operation: 'origin',
    policy: 'redirect',
    action: 'add',
    origin: 'https://client.example.test',
    expectedRevision: 0,
  });
  const client = h.management.store.register({
    application_type: 'web',
    client_name: '<Client>',
    software_id: 'test-client',
    redirect_uris: ['https://client.example.test/callback'],
  });
  const flow = h.start(client.id, 'https://client.example.test/callback');
  const action = h.approval(flow);
  if (action.operation !== 'approve') throw new Error('fixture');
  action.supersessions = [
    {
      grantId: old.grant.grantId,
      expectedVersion: old.grant.version,
      expectedDigest: old.grant.digest,
    },
  ];
  const page = await create(h, action);
  expect(page.html).toContain(
    'sends access to https://client.example.test, a remote site',
  );
  expect(page.html).toContain(
    'This will disconnect this installation when the new login completes.',
  );
  expect(page.html).not.toContain('Full access permits');
  expect((await h.decide(page.id, page.nonce, sign(h, page))).status).toBe(200);
  expect(h.channel.store.get('local', page.id)?.effect?.status).toBe(
    'approved-awaiting-exchange',
  );
  expect(
    h.management.store.access(old.tokens.accessToken, `${OUTSIDE_TEST_APP}/mcp`)
      ?.id,
  ).toBe(old.grant.grantId);
  const code = h.management.store.complete(
    flow.request.id,
    flow.ticket,
    flow.nonce,
  );
  const tokens = h.management.store.exchange({
    code: code.code,
    clientId: client.id,
    redirectUri: flow.request.redirectUri,
    resource: flow.request.resource,
    verifier: flow.verifier,
  });
  expect(
    h.management.store.access(
      old.tokens.accessToken,
      `${OUTSIDE_TEST_APP}/mcp`,
    ),
  ).toBeUndefined();
  expect(
    h.management.store.access(tokens.accessToken, `${OUTSIDE_TEST_APP}/mcp`)
      ?.selection.actor,
  ).toMatchObject({ kind: 'operator-passkey', id: h.enrolled.passkey.id });
  const grant = h.management
    .list(h.hostActor)
    .grants.find((g) => g.clientId === client.id)!;
  for (const operation of ['revoke', 'change'] as const) {
    const base = {
      grantId: grant.grantId,
      expectedVersion: grant.version,
      expectedDigest: grant.digest,
    };
    const next: OutsideManagementAction =
      operation === 'revoke'
        ? { operation, ...base }
        : {
            operation,
            ...base,
            project: { kind: 'global' },
            expiresAt: h.clock.now + DAY,
            accessLevel: 'read-only',
          };
    expect((await create(h, next)).html).toContain(
      'sends access to https://client.example.test, a remote site',
    );
  }
});

test('explicitly selected grants are disclosed even when software metadata does not match', async () => {
  const h = await fixture();
  const old = h.activate();
  const client = h.management.store.register({
    application_type: 'native',
    client_name: 'Different software',
    redirect_uris: ['http://127.0.0.1:43498/callback'],
  });
  const action = h.approval(h.start(client.id));
  if (action.operation !== 'approve') throw new Error('fixture');
  action.supersessions = [
    {
      grantId: old.grant.grantId,
      expectedVersion: old.grant.version,
      expectedDigest: old.grant.digest,
    },
  ];
  const page = await create(h, action);
  expect(page.html).toContain(old.grant.clientId);
  expect(page.html).toContain('Selected supersession');
  expect(page.html).toContain(
    'This will disconnect this installation when the new login completes.',
  );
});

test('strict route inputs, 32 KiB cap, origin and initiating-session isolation precede any consent mutation', async () => {
  const h = await fixture();
  const action = h.approval(h.start());
  for (const extra of [
    { origin: 'https://evil.example.test', 'sec-fetch-site': 'same-origin' },
    { origin: OUTSIDE_TEST_APP, 'sec-fetch-site': 'cross-site' },
  ])
    expect((await h.request(action, extra)).status).toBe(403);
  const path = h.pathFor(action);
  for (const body of [
    JSON.stringify({ action, extra: true }),
    JSON.stringify({ action: { ...action, accessLevel: 'full' } }),
    `{"action":${JSON.stringify(action)},"action":${JSON.stringify(action)}}`,
  ]) {
    expect(
      (
        await h.api.request(path, {
          method: 'POST',
          headers: {
            cookie: h.cookie,
            origin: OUTSIDE_TEST_APP,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await h.request(action, {
        cookie: `__Host-station-device=${h.other.credential}`,
      })
    ).status,
  ).toBe(403);
  const oversized = await h.api.request(path, {
    method: 'POST',
    headers: {
      cookie: h.cookie,
      origin: OUTSIDE_TEST_APP,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, padding: 'x'.repeat(32768) }),
  });
  expect(oversized.status).toBe(413);
  const page = await create(h, action);
  const deniedOrigin = await h.consent.request(`/consent/${page.id}/decide`, {
    method: 'POST',
    headers: {
      host: new URL(OUTSIDE_TEST_CONSENT).host,
      cookie: h.cookie,
      origin: OUTSIDE_TEST_APP,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      nonce: page.nonce,
      decision: 'approve',
      response: sign(h, page),
    }),
  });
  expect(deniedOrigin.status).toBe(403);
  const largeDecision = await h.consent.request(`/consent/${page.id}/decide`, {
    method: 'POST',
    headers: {
      host: new URL(OUTSIDE_TEST_CONSENT).host,
      cookie: h.cookie,
      origin: OUTSIDE_TEST_CONSENT,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(32768) }),
  });
  expect(largeDecision.status).toBe(413);
  expect(h.channel.store.get('local', page.id)?.status).toBe('pending');
  const inventory = await h.api.request('/api/outside-agent/clients', {
    headers: { cookie: h.cookie },
  });
  expect(JSON.stringify(await inventory.json())).not.toContain(
    h.management.store.pending()[0]!.comparisonCode,
  );
  expect(
    (
      await h.api.request(`/api/outside-agent/transactions/${page.id}`, {
        headers: { cookie: `__Host-station-device=${h.other.credential}` },
      })
    ).status,
  ).toBe(403);
});

test('compiled guard refuses new consent review/decision routes with no nonce, audit or domain writes', async () => {
  const h = await fixture();
  for (const kind of kinds) {
    const action = actionFor(h, kind);
    const page = await create(h, action);
    const before = snapshot(h);
    const audit = [...h.channel.store.auditTrail('local', page.id)];
    const assertion = sign(h, page);
    for (const spelling of [`/consent/${page.id}`, `/%63onsent/${page.id}`]) {
      expect(
        (
          await h.releasedConsent.request(
            `${OUTSIDE_TEST_CONSENT}${spelling}`,
            {
              headers: {
                host: new URL(OUTSIDE_TEST_CONSENT).host,
                cookie: h.cookie,
                'sec-fetch-mode': 'navigate',
                'sec-fetch-dest': 'document',
              },
            },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await h.releasedConsent.request(
            `${OUTSIDE_TEST_CONSENT}${spelling}/decide`,
            {
              method: 'POST',
              headers: {
                host: new URL(OUTSIDE_TEST_CONSENT).host,
                origin: OUTSIDE_TEST_CONSENT,
                cookie: h.cookie,
                'sec-fetch-site': 'same-origin',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                nonce: page.nonce,
                decision: 'approve',
                response: assertion,
              }),
            },
          )
        ).status,
      ).toBe(404);
    }
    expect(h.channel.store.auditTrail('local', page.id)).toEqual(audit);
    expect(snapshot(h)).toEqual(before);
    expect(
      (
        await h.releasedApi.request(h.pathFor(action), {
          method: 'POST',
          headers: {
            cookie: h.cookie,
            origin: OUTSIDE_TEST_APP,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ action }),
        })
      ).status,
    ).toBe(404);
  }
});

test('every literal outside consent route has an explicit declared scope; consent listener keeps its existing leaves', async () => {
  const h = await fixture();
  for (const route of h.api.routes.filter((r) => r.method !== 'ALL')) {
    expect(
      requiredPairingScope(route.method, route.path),
      `${route.method} ${route.path}`,
    ).toBe('access:manage');
    expect(
      isLeafScopeDeclared(route.method, route.path),
      `${route.method} ${route.path}`,
    ).toBe(true);
  }
  const listener = new Hono();
  registerConsentRoutes(listener, {
    channel: h.channel,
    credentials: h.security,
    sessions: h.sessions,
  });
  expect(
    listener.routes.some(
      (r) => r.method === 'POST' && r.path === '/consent/:id/decide',
    ),
  ).toBe(true);
});

for (const policy of ['redirect', 'cors'] as const)
  test(`${policy} policy revision alone invalidates an otherwise identical review`, async () => {
    const h = await fixture();
    const action: OutsideManagementAction = {
      operation: 'origin',
      policy,
      action: 'add',
      origin: 'https://client.example.test',
      expectedRevision: 0,
    };
    const page = await create(h, action);
    h.hostCommit({
      operation: 'origin',
      policy,
      action: 'add',
      origin: 'https://other.example.test',
      expectedRevision: 0,
    });
    h.hostCommit({
      operation: 'origin',
      policy,
      action: 'remove',
      origin: 'https://other.example.test',
      expectedRevision: 1,
    });
    expect(h.management.store.policy(policy)).toMatchObject({
      origins: [],
      revision: 2,
    });
    const response = await h.decide(page.id, page.nonce, sign(h, page));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'target_changed' });
    expect(h.management.store.policy(policy)).toMatchObject({
      origins: [],
      revision: 2,
    });
  });
