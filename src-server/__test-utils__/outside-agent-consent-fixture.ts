import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { registerOutsideAgentConsentRoutes } from '../routes/outside-agent/consent-routes.js';
import { registerOutsideAgentHostRoutes } from '../routes/outside-agent/host-routes.js';
import { installStationEnvelopeMarker } from '../runtime/bootstrap/runtime-http.js';
import {
  createConsentApp,
  registerConsentRoutes,
} from '../runtime/consent/consent-listener.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../security/runtime-request-security.js';
import { ConsentChannelService } from '../services/consent/consent-channel.js';
import { OperatorPasskeyEnrollmentService } from '../services/identity/operator-passkey-enrollment.js';
import { LazyOperatorPasskeyRegistry } from '../services/identity/operator-passkey-registry.js';
import {
  OperatorSessionService,
  parseOperatorSessionCookie,
} from '../services/identity/operator-sessions.js';
import { OutsideAgentConsentService } from '../services/outside-agent/consent-service.js';
import {
  OutsideAgentManagementService,
  type OutsideManagementAction,
} from '../services/outside-agent/management-service.js';
import { DAY } from '../services/outside-agent/oauth-records.js';
import { pkceChallenge } from '../services/outside-agent/oauth-registration.js';
import { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import { SoftwareAuthenticator } from './software-authenticator.js';

export const OUTSIDE_TEST_APP = 'https://station.example.test';
export const OUTSIDE_TEST_CONSENT = 'https://station.example.test:43443';
const redirectUri = 'http://127.0.0.1:43498/callback';

/** Isolated non-distributable composition: real private stores, enrollment/session and assertion verification.
 * Runtime admission's principal stamp is the fixture boundary; the release guard is exercised separately.
 */
export async function outsideConsentFixture(home: string) {
  const clock = { now: 1_800_000_000_000 };
  const security = new EnvironmentSecurityService({
    homeDir: home,
    now: () => clock.now,
  });
  const operator = await security.initialize();
  const pairing = security.devicePairing;
  const pair = (name: string, scope = 'orchestration:read', local = false) => {
    const offer = pairing.createOffer({ endpoint: OUTSIDE_TEST_APP, scope });
    const pending = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      source: 'pairing-code',
      requesterPosition: 'unproven',
    });
    pairing.confirmRequest(pending.requestId, { kind: 'presented-credential' });
    const exchanged = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
      ...(local
        ? {
            locality: 'home-possession' as const,
            mintKind: 'local-grant' as const,
          }
        : {}),
    });
    return {
      credential: exchanged.credential,
      device: { id: exchanged.device.id, scope: exchanged.device.scope },
    };
  };
  const device = pair('Review browser');
  const other = pair('Other browser', 'access:manage consent:decide');
  const local = pair('Host CLI', 'access:manage', true);
  const registry = new LazyOperatorPasskeyRegistry(home, () => clock.now);
  let authorityRevision = 'epoch-1';
  const sessions = new OperatorSessionService({
    registry,
    origin: OUTSIDE_TEST_CONSENT,
    now: () => clock.now,
    identifyDevice: (credential) => security.identifyDevice(credential),
    epoch: () => authorityRevision,
  });
  const enrollment = new OperatorPasskeyEnrollmentService({
    registry,
    origin: OUTSIDE_TEST_CONSENT,
    now: () => clock.now,
  });
  const enroll = async () => {
    const authenticator = new SoftwareAuthenticator();
    const request = enrollment.createRequest({
      credential: device.credential,
      deviceLabel: 'Review browser',
      requester: {
        kind: 'paired-device',
        deviceId: device.device.id,
        pairedAt: clock.now,
        scope: device.device.scope,
      },
    });
    enrollment.confirm(request.code, device.device.id);
    const options = await enrollment.beginRegistration(
      request.requestId,
      device.credential,
    );
    const passkey = await enrollment.finishRegistration(
      request.requestId,
      device.credential,
      authenticator.register(options, { origin: OUTSIDE_TEST_CONSENT }),
      'Review key',
    );
    return { authenticator, passkey };
  };
  const enrolled = await enroll();
  const login = await sessions.options(
    sessions.renderNonce(device.credential),
    device.credential,
  );
  const signed = await sessions.complete(
    login.ceremonyId,
    device.credential,
    enrolled.authenticator.authenticate(login.options, {
      origin: OUTSIDE_TEST_CONSENT,
    }),
  );
  const cookie = `__Host-station-device=${device.credential}; __Host-station-operator=${signed.secret}`;
  const channel = new ConsentChannelService({
    trustedOrigin: OUTSIDE_TEST_CONSENT,
    now: () => clock.now,
  });
  channel.markListening(43443);
  const projects = new Map([
    ['alpha', 'project-alpha'],
    ['beta', 'project-beta'],
  ]);
  const projectNames = new Map([
    ['project-alpha', 'Alpha workspace'],
    ['project-beta', 'Beta workspace'],
  ]);
  const hostActor = {
    kind: 'host' as const,
    id: 'host-cli',
    authorityRevision,
    delegatingPrincipalId: 'operator',
  };
  const management = OutsideAgentManagementService.open(
    home,
    {
      stationId: 'isolated-r2b',
      bootId: 'test-boot',
      issuer: OUTSIDE_TEST_APP,
      now: () => clock.now,
    },
    {
      current: (actor) =>
        actor.authorityRevision === authorityRevision &&
        actor.delegatingPrincipalId === 'operator' &&
        (actor.kind === 'host' ||
          registry.existing()?.get(actor.id)?.revokedAt === null),
      resolveProject: (slug) =>
        projects.has(slug) ? { id: projects.get(slug)! } : null,
      projectExists: (id) => [...projects.values()].includes(id),
      describeProject: (id) => {
        const slug = [...projects].find(
          ([, projectId]) => projectId === id,
        )?.[0];
        return slug ? { name: projectNames.get(id) ?? slug, slug } : null;
      },
    },
  );
  const adapter = new OutsideAgentConsentService(
    management,
    channel,
    (_session, passkeyId) => ({
      kind: 'operator-passkey',
      id: passkeyId,
      authorityRevision,
      delegatingPrincipalId: 'operator',
    }),
  );
  const api = new Hono();
  api.use('*', async (c, next) => {
    const secret = parseOperatorSessionCookie(c.req.header('cookie'));
    const credential = c.req
      .header('cookie')
      ?.match(/__Host-station-device=([^;]+)/)?.[1];
    const session =
      secret && credential ? sessions.resolve(secret, credential) : null;
    if (session && secret && credential)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential,
        source: 'session',
        authority: 'operator-session',
        operatorSession: {
          sessionId: session.sessionId,
          passkeyId: session.passkeyId,
          boundDeviceId: session.boundDeviceId,
          expiresAt: session.expiresAt,
          idleExpiresAt: session.lastUsedAt + 15 * 60_000,
          isCurrent: () => !!sessions.resolve(secret, credential),
        },
      });
    else {
      const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
      if (bearer) {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          credential: bearer,
          source: 'bearer',
          authority: security.verifyOperatorCredential(bearer)
            ? 'operator-credential'
            : 'device-credential',
          ...(bearer === local.credential
            ? { locality: 'home-possession', mintKind: 'local-grant' }
            : {}),
        });
        bindRuntimeLocalOperator(c.req.raw);
      }
    }
    await next();
  });
  registerOutsideAgentConsentRoutes(api, {
    service: adapter,
    appOrigin: OUTSIDE_TEST_APP,
  });
  registerOutsideAgentHostRoutes(api, {
    service: management,
    localGrantSecret: 'private-test-host-proof',
    actor: hostActor,
  });
  const consent = new Hono();
  registerConsentRoutes(consent, { channel, credentials: security, sessions });
  const releasedConsent = createConsentApp({
    channel,
    credentials: security,
    sessions,
  });
  const releasedApi = new Hono();
  installStationEnvelopeMarker(releasedApi);
  registerOutsideAgentConsentRoutes(releasedApi, {
    service: adapter,
    appOrigin: OUTSIDE_TEST_APP,
  });
  const client = management.store.register({
    application_type: 'native',
    client_name: '<Client>\u202e',
    software_id: 'test-client',
    redirect_uris: [redirectUri],
  });
  const start = (clientId = client.id, callback = redirectUri) => {
    const verifier = randomBytes(32).toString('base64url');
    return {
      ...management.store.start({
        clientId,
        redirectUri: callback,
        resource: `${OUTSIDE_TEST_APP}/mcp`,
        state: 'private-oauth-state',
        challenge: pkceChallenge(verifier),
        scopes: ['station-control:read', 'station-control:full'],
      }),
      verifier,
    };
  };
  const approval = (
    flow: ReturnType<typeof start>,
  ): OutsideManagementAction => ({
    operation: 'approve',
    requestId: flow.request.id,
    clientId: flow.request.clientId,
    expectedRequestFingerprint: management
      .list(hostActor)
      .pending.find((r) => r.requestId === flow.request.id)!
      .expectedRequestFingerprint,
    project: { kind: 'project', slug: 'alpha' },
    accessLevel: 'read-only',
    expiresAt: clock.now + DAY,
    supersessions: [],
  });
  const hostCommit = (action: OutsideManagementAction) =>
    management.commit(
      {
        action,
        fingerprint: management.review(action, hostActor).fingerprint,
        decisionId: randomBytes(32).toString('base64url'),
      },
      hostActor,
    );
  const activate = () => {
    const flow = start();
    hostCommit(approval(flow));
    const completed = management.store.complete(
      flow.request.id,
      flow.ticket,
      flow.nonce,
    );
    const tokens = management.store.exchange({
      code: completed.code,
      clientId: client.id,
      redirectUri,
      resource: `${OUTSIDE_TEST_APP}/mcp`,
      verifier: flow.verifier,
    });
    return { flow, tokens, grant: management.list(hostActor).grants.at(-1)! };
  };
  const pathFor = (action: OutsideManagementAction) =>
    action.operation === 'approve' || action.operation === 'deny'
      ? `/api/outside-agent/requests/${action.requestId}/${action.operation === 'approve' ? 'approval' : 'denial'}`
      : action.operation === 'change' || action.operation === 'revoke'
        ? `/api/outside-agent/grants/${action.grantId}/${action.operation}`
        : action.operation === 'origin'
          ? `/api/outside-agent/${action.policy}-origins/change`
          : '/api/outside-agent/host/register';
  const request = (
    action: OutsideManagementAction,
    extra: Record<string, string> = {},
  ) =>
    api.request(`${OUTSIDE_TEST_APP}${pathFor(action)}`, {
      method: 'POST',
      headers: {
        cookie,
        origin: OUTSIDE_TEST_APP,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify({ action }),
    });
  const review = async (id: string) => {
    const response = await consent.request(
      `${OUTSIDE_TEST_CONSENT}/consent/${id}`,
      {
        headers: {
          host: new URL(OUTSIDE_TEST_CONSENT).host,
          cookie,
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      },
    );
    const html = await response.text();
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    const encoded = html.match(/data-options="([^"]+)"/)?.[1];
    if (!nonce || !encoded)
      throw new Error(`Review failed (${response.status}): ${html}`);
    const options: { challenge: string; rpId: string } = JSON.parse(
      encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    );
    return { html, nonce, options };
  };
  const decide = (
    id: string,
    nonce: string,
    response?: ReturnType<SoftwareAuthenticator['authenticate']>,
    decision = 'approve',
  ) =>
    consent.request(`${OUTSIDE_TEST_CONSENT}/consent/${id}/decide`, {
      method: 'POST',
      headers: {
        host: new URL(OUTSIDE_TEST_CONSENT).host,
        origin: OUTSIDE_TEST_CONSENT,
        cookie,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ nonce, decision, response }),
    });
  return {
    home,
    clock,
    security,
    operator,
    device,
    other,
    local,
    registry,
    sessions,
    enrollment,
    enrolled,
    enroll,
    signed,
    cookie,
    channel,
    projects,
    projectNames,
    management,
    adapter,
    api,
    consent,
    releasedConsent,
    releasedApi,
    hostActor,
    client,
    start,
    approval,
    hostCommit,
    activate,
    pathFor,
    request,
    review,
    decide,
    rotate: () => {
      authorityRevision = 'epoch-2';
    },
    close: () => {
      management.store.close();
      registry.close();
    },
  };
}
