/**
 * #4306: the Station operator turns on Project sharing from a remote paired
 * Device with an operator passkey session and one fresh passkey confirmation
 * on the consent origin.
 *
 * Drives the REAL `configureRuntimeRoutes` (real `configureRuntimeHttp`
 * admission, real `projectMembershipAuthority`, real membership routes and
 * service, real pairing host routes for the transaction status read) and the
 * REAL consent listener, with a real `EnvironmentSecurityService`, a real
 * `OperatorSessionService` over a real passkey registry, and a software
 * authenticator producing real WebAuthn assertions. Nothing hand-sets an
 * authenticated principal.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeploymentAuthenticationResult } from '@kontourai/station-contracts/deployment-authentication';
import type { ProjectAccessAdministrationView } from '@kontourai/station-contracts/project-membership';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SoftwareAuthenticator } from '../../../__test-utils__/software-authenticator.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { FileStorageUnavailableError } from '../../../domain/project-file-transactions.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { ConsentTransactionStore } from '../../../services/consent/consent-transactions.js';
import { DeploymentAuthenticationService } from '../../../services/identity/deployment-authentication-service.js';
import { OperatorPasskeyEnrollmentService } from '../../../services/identity/operator-passkey-enrollment.js';
import { LazyOperatorPasskeyRegistry } from '../../../services/identity/operator-passkey-registry.js';
import {
  OPERATOR_SESSION_IDLE_MS,
  OperatorSessionService,
} from '../../../services/identity/operator-sessions.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createConsentApp } from '../../consent/consent-listener.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

function deepCallable(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === 'then' ? undefined : deepCallable(),
    apply: () => deepCallable(),
  });
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return deepCallable();
    },
  }) as T;
}

const APP = 'https://station.example.test';
const CONSENT = 'https://station.example.test:8443';
const STATION_ID = 'sharing-step-up-fixture';
const PHONE_SCOPE = 'orchestration:read orchestration:operate';

describe('remote Project sharing enable with operator passkey step-up (#4306)', () => {
  // Registered before the afterEach below, so it removes the directories
  // after the databases in them are closed.
  const makeTemp = trackTempDirs();
  const directories: string[] = [];
  const registries: LazyOperatorPasskeyRegistry[] = [];
  const closers: (() => Promise<void>)[] = [];
  const ambient = {
    home: process.env.STATION_HOME,
    root: process.env.STATION_ROOT,
    origins: process.env.ALLOWED_ORIGINS,
  };
  beforeEach(() => {
    const owned = makeTemp('station-sharing-step-up-');
    directories.push(owned);
    for (const name of ['home', 'root', 'data']) mkdirSync(join(owned, name));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
    process.env.ALLOWED_ORIGINS = APP;
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const registry of registries.splice(0)) registry.close();
    for (const [key, value] of [
      ['STATION_HOME', ambient.home],
      ['STATION_ROOT', ambient.root],
      ['ALLOWED_ORIGINS', ambient.origins],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    directories.splice(0);
  });

  async function setup(deploymentAuthentication?: {
    publicOrigin: string;
    service: DeploymentAuthenticationService;
  }) {
    const homeDir = join(directories[directories.length - 1], 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const clock = { now: Date.now() };
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();
    const storage = new FileStorageAdapter(homeDir);
    const projectService = new ProjectService(
      storage,
      new ProjectManifestStore(homeDir, storage),
    );
    const membership = createProjectMembershipRuntime(
      homeDir,
      STATION_ID,
      storage,
    );
    const registry = new LazyOperatorPasskeyRegistry(homeDir, () => clock.now);
    registries.push(registry);
    const channel = new ConsentChannelService({
      trustedOrigin: CONSENT,
      now: () => clock.now,
    });
    channel.markListening(8443);
    const sessions = new OperatorSessionService({
      registry,
      origin: CONSENT,
      now: () => clock.now,
      identifyDevice: (credential) => security.identifyDevice(credential),
      epoch: () =>
        security.pseudonymizePairingAuditSource('operator-session-epoch.v1'),
      available: () => channel.state().status === 'listening',
    });
    const enrollment = new OperatorPasskeyEnrollmentService({
      registry,
      origin: CONSENT,
      now: () => clock.now,
    });
    const consent = createConsentApp({
      channel,
      credentials: security,
      passkeys: enrollment,
      sessions,
    });
    const warn = vi.fn();
    const app = new Hono();
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks: undefined,
      deploymentAuthentication,
      localAccounts: undefined,
      applicationSessions: undefined,
      consentChannel: channel,
      operatorSessions: sessions,
      operatorPasskeys: enrollment,
      storageAdapter: storage,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({}),
      },
      logger: { debug() {}, info() {}, warn, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      environmentSecurityService: security,
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;
    closers.push(async () => {
      await result.projectRoomRuntime.close();
      membership.close();
    });

    const pair = (name: string, scope = PHONE_SCOPE) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({ endpoint: APP, scope });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        requesterPosition: 'unproven',
        source: 'pairing-code',
      });
      pairing.confirmRequest(pending.requestId, {
        kind: 'presented-credential',
      });
      return pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      });
    };
    const phone = pair('Owner phone');
    const project = await projectService.createProject({
      name: 'Shared work',
      slug: 'shared-work',
    });

    const deviceCookie = (credential: string) =>
      `__Host-station-device=${credential}`;
    /** App-origin request carrying the given cookie header. */
    const call = (
      path: string,
      cookie: string,
      init: { method?: string; body?: unknown } = {},
    ) =>
      app.request(`${APP}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          cookie,
          origin: APP,
          ...(init.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    const enable = (cookie: string, slug = project.slug, id = project.id) =>
      call(`/api/projects/${slug}/access/enable`, cookie, {
        method: 'POST',
        body: { localProjectId: id },
      });
    const enablement = async (cookie: string, slug = project.slug) => {
      const response = await call(
        `/api/projects/${slug}/access/enablement`,
        cookie,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { data: unknown }).data;
    };
    const consentHeaders = (cookie: string) => ({
      host: new URL(CONSENT).host,
      origin: CONSENT,
      cookie,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    });

    async function signIn(credential = phone.credential) {
      const authenticator = new SoftwareAuthenticator();
      const device = security.identifyDevice(credential)!;
      const opened = enrollment.createRequest({
        credential,
        deviceLabel: 'Owner phone',
        requester: {
          kind: 'paired-device',
          deviceId: device.id,
          pairedAt: clock.now,
          scope: device.scope,
        },
      });
      enrollment.confirm(opened.code, device.id);
      const registration = await enrollment.beginRegistration(
        opened.requestId,
        credential,
      );
      const passkey = await enrollment.finishRegistration(
        opened.requestId,
        credential,
        authenticator.register(registration, { origin: CONSENT }),
        'Primary',
      );
      const page = await consent.request('/operator/sign-in', {
        headers: {
          ...consentHeaders(deviceCookie(credential)),
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      });
      const nonce = (await page.text()).match(/data-nonce="([^"]+)"/)![1];
      const options = (await (
        await consent.request('/operator/sign-in/options', {
          method: 'POST',
          headers: consentHeaders(deviceCookie(credential)),
          body: JSON.stringify({ nonce }),
        })
      ).json()) as {
        ceremonyId: string;
        options: { challenge: string; rpId: string };
      };
      const done = await consent.request('/operator/sign-in/complete', {
        method: 'POST',
        headers: consentHeaders(deviceCookie(credential)),
        body: JSON.stringify({
          ceremonyId: options.ceremonyId,
          response: authenticator.authenticate(options.options, {
            origin: CONSENT,
          }),
        }),
      });
      expect(done.status, await done.clone().text()).toBe(200);
      const operatorCookie = done.headers.get('set-cookie')!.split(';')[0];
      return {
        authenticator,
        passkey,
        operatorCookie,
        cookie: `${deviceCookie(credential)}; ${operatorCookie}`,
      };
    }
    type Signed = Awaited<ReturnType<typeof signIn>>;

    async function review(signed: Signed, id: string) {
      const response = await consent.request(`/consent/${id}`, {
        headers: {
          ...consentHeaders(signed.cookie),
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      const nonce = html.match(/name="nonce" value="([^"]+)"/)![1];
      const options = JSON.parse(
        html
          .match(/data-options="([^"]+)"/)![1]
          .replaceAll('&quot;', '"')
          .replaceAll('&amp;', '&'),
      ) as { challenge: string; rpId: string };
      return { html, nonce, options };
    }
    let counter = 1;
    function decide(
      signed: Signed,
      id: string,
      rendered: { nonce: string; options: { challenge: string; rpId: string } },
      assertion: 'with' | 'without' = 'with',
    ) {
      counter += 1;
      return consent.request(`/consent/${id}/decide`, {
        method: 'POST',
        headers: consentHeaders(signed.cookie),
        body: JSON.stringify({
          nonce: rendered.nonce,
          ...(assertion === 'with'
            ? {
                response: signed.authenticator.authenticate(rendered.options, {
                  origin: CONSENT,
                  counter,
                }),
              }
            : {}),
        }),
      });
    }
    async function requestStepUp(signed: Signed) {
      const response = await enable(signed.cookie);
      expect(response.status, await response.clone().text()).toBe(202);
      const body = (await response.json()) as {
        status: string;
        transaction: { id: string; reviewUrl: string; expiresAt: number };
      };
      expect(body.status).toBe('step_up_required');
      return body.transaction;
    }
    /** Whether any Project is shared, read from the membership database itself. */
    const shared = () => {
      const db = new DatabaseSync(
        join(homeDir, 'security', 'project-membership.sqlite'),
        { readOnly: true },
      );
      try {
        return (
          (
            db.prepare('SELECT COUNT(*) AS n FROM shared_projects').get() as {
              n: number;
            }
          ).n > 0
        );
      } finally {
        db.close();
      }
    };

    return {
      app,
      clock,
      security,
      operatorCredential,
      membership,
      projectService,
      registry,
      channel,
      sessions,
      phone,
      project,
      pair,
      warn,
      call,
      enable,
      enablement,
      deviceCookie,
      signIn,
      review,
      decide,
      requestStepUp,
      shared,
    };
  }

  test('sharing refusal discloses only to a current admitted operator session', async () => {
    const h = await setup();
    const details = async (cookie: string) => {
      const response = await h.call(
        `/api/projects/${h.project.slug}/access`,
        cookie,
      );
      expect(response.status).toBe(403);
      return ((await response.json()) as { details: unknown }).details;
    };
    expect(await details(h.deviceCookie(h.phone.credential))).toEqual({
      sharing: 'undisclosed',
      canEnable: false,
    });
    const signed = await h.signIn();
    expect(await details(signed.cookie)).toEqual({
      sharing: 'off',
      canEnable: true,
    });
    const other = h.pair('Other phone');
    expect(
      await details(
        `${h.deviceCookie(other.credential)}; ${signed.operatorCookie}`,
      ),
    ).toEqual({ sharing: 'undisclosed', canEnable: false });
    h.clock.now += OPERATOR_SESSION_IDLE_MS + 1;
    expect(await details(signed.cookie)).toEqual({
      sharing: 'undisclosed',
      canEnable: false,
    });
    expect(h.shared()).toBe(false);
  });

  test('a signed-in operator Device enables sharing only after a fresh passkey confirmation, and owns it', async () => {
    const h = await setup();
    const signed = await h.signIn();
    expect(await h.enablement(signed.cookie)).toEqual({
      enable: 'operator-passkey',
    });
    const transaction = await h.requestStepUp(signed);
    expect(new URL(transaction.reviewUrl).origin).toBe(CONSENT);
    // Asking changed nothing.
    expect(h.shared()).toBe(false);
    const rendered = await h.review(signed, transaction.id);
    expect(rendered.html).toContain('Turn on Project sharing');
    expect(rendered.html).toContain(`human:device:${h.phone.device.id}`);
    const decided = await h.decide(signed, transaction.id, rendered);
    expect(decided.status, await decided.clone().text()).toBe(200);
    expect(await decided.json()).toMatchObject({ status: 'approved' });

    // The owner is the principal this Device resolves to, and it now
    // manages the Project through ordinary member authority.
    const view = await h.call(
      `/api/projects/${h.project.slug}/access`,
      h.deviceCookie(h.phone.credential),
    );
    expect(view.status, await view.clone().text()).toBe(200);
    const data = (
      (await view.json()) as { data: ProjectAccessAdministrationView }
    ).data;
    expect(data.members).toEqual([
      expect.objectContaining({
        principal: expect.objectContaining({
          id: `human:device:${h.phone.device.id}`,
        }),
        role: 'owner',
        status: 'active',
      }),
    ]);
    const status = await h.call(
      `/api/pairing/device-access-transactions/${transaction.id}`,
      signed.cookie,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: 'approved',
      effect: { projectSharing: 'enabled', slug: h.project.slug },
    });
    expect(h.warn).toHaveBeenCalledWith('Project sharing enabled', {
      event: 'station.project_sharing.enabled',
      actor: 'operator-passkey',
      localProjectId: h.project.id,
      transactionId: transaction.id,
    });
    // Replaying the same rendered nonce and a fresh assertion cannot commit again.
    const replay = await h.decide(signed, transaction.id, rendered);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'not_pending' });
  });

  test('a plain paired Device without an operator session is refused and offered sign-in', async () => {
    const h = await setup();
    const cookie = h.deviceCookie(h.phone.credential);
    expect(await h.enablement(cookie)).toEqual({
      enable: 'operator-sign-in',
      signInUrl: `${CONSENT}/operator/sign-in`,
    });
    const refused = await h.enable(cookie);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: 'project_access_forbidden' },
    });
    expect(h.shared()).toBe(false);
  });

  test("another paired Device presenting the operator's session cookie is refused", async () => {
    const h = await setup();
    const signed = await h.signIn();
    const other = h.pair('Other browser');
    const stolen = `${h.deviceCookie(other.credential)}; ${signed.operatorCookie}`;
    expect(await h.enablement(stolen)).toMatchObject({
      enable: 'operator-sign-in',
    });
    const refused = await h.enable(stolen);
    expect(refused.status).toBe(403);
    expect(h.shared()).toBe(false);
  });

  test('a Project owner without operator authority cannot enable sharing for another Project', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const transaction = await h.requestStepUp(signed);
    const rendered = await h.review(signed, transaction.id);
    expect((await h.decide(signed, transaction.id, rendered)).status).toBe(200);
    const other = await h.projectService.createProject({
      name: 'Second',
      slug: 'second',
    });
    // The same Device, now a Project owner, without its operator session.
    const ownerOnly = h.deviceCookie(h.phone.credential);
    const refused = await h.enable(ownerOnly, other.slug, other.id);
    expect(refused.status).toBe(403);
    expect(await h.enablement(ownerOnly, other.slug)).toMatchObject({
      enable: 'operator-sign-in',
    });
  });

  test('an approval without a passkey assertion, or after the review expired, applies nothing', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const first = await h.requestStepUp(signed);
    const rendered = await h.review(signed, first.id);
    const absent = await h.decide(signed, first.id, rendered, 'without');
    expect(absent.status).toBe(403);
    expect(await absent.json()).toEqual({ error: 'assertion_required' });
    expect(h.shared()).toBe(false);

    const second = await h.requestStepUp(signed);
    const late = await h.review(signed, second.id);
    h.clock.now = second.expiresAt + 1;
    const expired = await h.decide(signed, second.id, late);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: 'not_pending' });
    expect(h.shared()).toBe(false);
  });

  test('a revoked passkey or an expired session cannot request or confirm the enable', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const pending = await h.requestStepUp(signed);
    const rendered = await h.review(signed, pending.id);
    expect(h.registry.existing()!.revoke(signed.passkey.id)).toBe(true);
    const confirmed = await h.decide(signed, pending.id, rendered);
    // The consent listener no longer finds a live session for this browser.
    expect(confirmed.status).toBe(404);
    expect(await confirmed.json()).toEqual({ error: 'not_found' });
    expect(h.shared()).toBe(false);
    const after = await h.enable(signed.cookie);
    expect(after.status).toBe(403);

    const again = await h.signIn();
    h.clock.now += OPERATOR_SESSION_IDLE_MS;
    expect((await h.enable(again.cookie)).status).toBe(403);
    expect(h.shared()).toBe(false);
  });

  test('revoking the bound Device after review ends the request without applying it', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const pending = await h.requestStepUp(signed);
    const rendered = await h.review(signed, pending.id);
    h.security.devicePairing.revokeDevice(
      h.phone.device.id,
      'operator-credential',
    );
    const confirmed = await h.decide(signed, pending.id, rendered);
    expect(confirmed.status).toBe(404);
    expect(await confirmed.json()).toEqual({ error: 'not_found' });
    expect(h.shared()).toBe(false);
  });

  test('a passkey revoked after the assertion verified is refused at the mutation seam', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const pending = await h.requestStepUp(signed);
    const rendered = await h.review(signed, pending.id);
    // Lands between the verified assertion and the membership write: the
    // listener and the store have already accepted the passkey.
    const enable = h.membership.service.enable.bind(h.membership.service);
    const spy = vi
      .spyOn(h.membership.service, 'enable')
      .mockImplementationOnce(async (...args) => {
        h.registry.existing()!.revoke(signed.passkey.id);
        return enable(...args);
      });
    const confirmed = await h.decide(signed, pending.id, rendered);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toEqual({ error: 'session_ended' });
    expect(h.shared()).toBe(false);
    expect(h.warn).not.toHaveBeenCalledWith(
      'Project sharing enabled',
      expect.anything(),
    );
  });

  test('session revocation during the final account lookup refuses the write', async () => {
    let hook = async () => {};
    const service = new DeploymentAuthenticationService({
      version: 'station.authentication/v1',
      issuer: 'https://identity.example.test',
      displayName: 'Identity provider',
      sessionCookies: ['review_account'],
      endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
      authenticate: async () => {
        await hook();
        return {
          kind: 'authenticated',
          session: {
            subject: 'reviewed-person',
            displayName: 'reviewed-person',
            sessionId: 'review-session',
            authenticatedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            contacts: [],
          },
        };
      },
      handle: async () => new Response(null, { status: 204 }),
    });
    const h = await setup({ publicOrigin: APP, service });
    const signed = await h.signIn();
    const approving = await h.signIn();
    signed.cookie += '; review_account=valid';
    const transaction = await h.requestStepUp(signed);
    const rendered = await h.review(signed, transaction.id);
    let calls = 0;
    let revoked = false;
    const changed = vi.fn();
    const unsubscribe = h.membership.service.subscribe(changed);
    hook = async () => {
      if (++calls === 3) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        revoked = h.registry.existing()!.revoke(signed.passkey.id);
      }
    };
    const result = await h.decide(
      { ...signed, authenticator: approving.authenticator },
      transaction.id,
      rendered,
    );
    unsubscribe();
    expect(calls).toBe(3);
    expect(revoked).toBe(true);
    expect(result.status, await result.clone().text()).toBe(409);
    expect(await result.json()).toEqual({ error: 'session_ended' });
    expect(
      h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
    ).toBe('session_ended');
    expect(h.shared()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalledWith(
      'Project sharing enabled',
      expect.anything(),
    );
  });

  test('revoking a different approving passkey after verification refuses the write', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const approving = await h.signIn();
    const transaction = await h.requestStepUp(signed);
    const rendered = await h.review(signed, transaction.id);
    const enable = h.membership.service.enable.bind(h.membership.service);
    let revoked = false;
    const changed = vi.fn();
    const unsubscribe = h.membership.service.subscribe(changed);
    vi.spyOn(h.membership.service, 'enable').mockImplementationOnce(
      async (...args) => {
        revoked = h.registry.existing()!.revoke(approving.passkey.id);
        return enable(...args);
      },
    );
    const result = await h.decide(
      { ...signed, authenticator: approving.authenticator },
      transaction.id,
      rendered,
    );
    unsubscribe();
    expect(revoked).toBe(true);
    expect(result.status, await result.clone().text()).toBe(409);
    expect(await result.json()).toEqual({ error: 'target_changed' });
    expect(
      h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
    ).toBe('target_changed');
    const status = await h.call(
      `/api/pairing/device-access-transactions/${transaction.id}`,
      signed.cookie,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: 'target_changed' });
    expect(h.shared()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalledWith(
      'Project sharing enabled',
      expect.anything(),
    );
  });

  test.each([
    'replace-before-decision',
    'replace-before-enable',
    'remove',
  ] as const)(
    '%s closes the reviewed Project incarnation without sharing anything',
    async (change) => {
      const h = await setup();
      const signed = await h.signIn();
      const transaction = await h.requestStepUp(signed);
      const rendered = await h.review(signed, transaction.id);
      const changed = vi.fn();
      const unsubscribe = h.membership.service.subscribe(changed);
      const replace = async () => {
        await h.projectService.deleteProject(h.project.slug);
        if (change !== 'remove') {
          const replacement = await h.projectService.createProject({
            name: h.project.name,
            slug: h.project.slug,
          });
          expect(replacement.id).not.toBe(h.project.id);
        }
      };
      if (change === 'replace-before-enable') {
        const enable = h.membership.service.enable.bind(h.membership.service);
        vi.spyOn(h.membership.service, 'enable').mockImplementationOnce(
          async (...args) => {
            await replace();
            return enable(...args);
          },
        );
      } else {
        await replace();
      }
      const result = await h.decide(signed, transaction.id, rendered);
      unsubscribe();
      expect(result.status, await result.clone().text()).toBe(409);
      expect(await result.json()).toEqual({ error: 'target_changed' });
      expect(
        h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
      ).toBe('target_changed');
      const status = await h.call(
        `/api/pairing/device-access-transactions/${transaction.id}`,
        signed.cookie,
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ status: 'target_changed' });
      expect(h.shared()).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalledWith(
        'Project sharing enabled',
        expect.anything(),
      );
    },
  );

  test.each(
    [1, 3].flatMap((at) =>
      ['unavailable', 'invalid', 'owner-changed', 'device-revoked'].map(
        (outcome) => ({ at, outcome }),
      ),
    ),
  )(
    'authority $outcome at decision lookup $at preserves the proper terminal boundary',
    async ({ at, outcome }) => {
      let calls = 0;
      let armed = false;
      let invalidateDevice = () => {};
      const authenticated = (
        subject: string,
      ): DeploymentAuthenticationResult => ({
        kind: 'authenticated',
        session: {
          subject,
          displayName: subject,
          sessionId: 'review-session',
          authenticatedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          contacts: [],
        },
      });
      const service = new DeploymentAuthenticationService({
        version: 'station.authentication/v1',
        issuer: 'https://identity.example.test',
        displayName: 'Identity provider',
        sessionCookies: ['review_account'],
        endpoints: [
          { path: '/logout', methods: ['POST'], operation: 'logout' },
        ],
        authenticate: async () => {
          if (armed && ++calls >= at) {
            if (outcome === 'device-revoked') invalidateDevice();
            if (outcome === 'unavailable') return { kind: 'unavailable' };
            if (outcome === 'invalid')
              return { kind: 'invalid', reason: 'revoked' };
            if (outcome === 'owner-changed')
              return authenticated('different-person');
          }
          return authenticated('reviewed-person');
        },
        handle: async () => new Response(null, { status: 204 }),
      });
      const h = await setup({ publicOrigin: APP, service });
      const signed = await h.signIn();
      signed.cookie += '; review_account=valid';
      const transaction = await h.requestStepUp(signed);
      const rendered = await h.review(signed, transaction.id);
      invalidateDevice = () => {
        h.security.devicePairing.revokeDevice(
          h.phone.device.id,
          'operator-credential',
        );
      };
      const changed = vi.fn();
      const unsubscribe = h.membership.service.subscribe(changed);
      armed = true;
      const result = await h.decide(signed, transaction.id, rendered);
      unsubscribe();
      const reason =
        outcome === 'unavailable'
          ? 'commit_refused'
          : outcome === 'device-revoked'
            ? 'session_ended'
            : 'target_changed';
      const status = outcome === 'unavailable' ? 'pending' : reason;
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ error: reason });
      expect(
        h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
      ).toBe(status);
      expect(h.shared()).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      expect(h.warn).not.toHaveBeenCalledWith(
        'Project sharing enabled',
        expect.anything(),
      );
    },
  );

  test('unexpected storage unavailability keeps the sharing review pending', async () => {
    const h = await setup();
    const signed = await h.signIn();
    const transaction = await h.requestStepUp(signed);
    const rendered = await h.review(signed, transaction.id);
    vi.spyOn(h.membership.service, 'enable').mockRejectedValueOnce(
      new FileStorageUnavailableError('fixture storage failure'),
    );
    const result = await h.decide(signed, transaction.id, rendered);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'commit_refused' });
    expect(
      h.channel.store.get(h.channel.tenantId, transaction.id)?.status,
    ).toBe('pending');
    const status = await h.call(
      `/api/pairing/device-access-transactions/${transaction.id}`,
      signed.cookie,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: 'pending' });
    expect(h.shared()).toBe(false);
    expect(h.warn).not.toHaveBeenCalledWith(
      'Project sharing enabled',
      expect.anything(),
    );
  });

  test('the operator credential still enables directly, without a step-up', async () => {
    const h = await setup();
    const response = await h.app.request(
      `${APP}/api/projects/${h.project.slug}/access/enable`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.operatorCredential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ localProjectId: h.project.id }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      await (
        await h.app.request(
          `${APP}/api/projects/${h.project.slug}/access/enablement`,
          { headers: { Authorization: `Bearer ${h.operatorCredential}` } },
        )
      ).json(),
    ).toEqual({ success: true, data: { enable: 'direct' } });
  });

  test('the transaction store refuses a sharing enable without a passkey ceremony bound to a session', () => {
    expect(() =>
      new ConsentTransactionStore().create({
        tenantId: 'local',
        target: {
          kind: 'project-sharing-enable',
          subject: 'project-id',
          fingerprint: '{}',
        },
        description: {
          title: 'Turn on Project sharing',
          summary: 'x',
          items: [],
          approveLabel: 'Approve',
          denyLabel: 'Deny',
        },
        requester: { kind: 'plugin-ui', id: 'plugin' },
        rateKey: 'plugin',
        revalidateTarget: async () => null,
        commitApproval: async () => {},
      }),
    ).toThrow('operator_action_requires_passkey_ceremony');
  });
});
