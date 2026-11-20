/**
 * Station-run engine sign-in and managed install routes behind the real
 * runtime auth boundary (pairing route table plus handlers): who may start a
 * Kiro sign-in, read its code, sign out and install, and what the sign-in
 * view shows. The OIDC endpoints are a local stub; nothing is installed.
 */
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  PAIRING_SCOPE_ENGINE_LOGIN,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { engineLaunchFactsFor } from '../../../services/acp/acp-engine-descriptors.js';
import { resetEngineAuthStatus } from '../../../services/acp/engine-auth-status.js';
import { EngineSignInService } from '../../../services/acp/engine-sign-in.js';
import { startOidcStub } from '../../../services/engine-host-auth/__tests__/fixtures/oidc-stub.js';
import {
  EngineHostAuthService,
  registerEngineHostAuth,
} from '../../../services/engine-host-auth/service.js';
import {
  defaultManagedInstallDeps,
  ManagedInstaller,
  registerManagedInstaller,
} from '../../../services/engines/managed-install.js';
import { KAS_INSTALL_DEFINITION } from '../../../services/engines/managed-install-pins.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import { createLogger } from '../../../utils/logger.js';
import { createACPSignInRoutes } from '../acp-sign-in.js';

const makeTempDir = trackTempDirs();

const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(async () => {
  clearAll();
  resetEngineAuthStatus();
  registerEngineHostAuth(null);
  registerManagedInstaller(null);
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const BUNDLE: ACPConnectionConfig = {
  id: 'kiro-kas-bundle',
  name: 'Kiro (KAS, no CLI)',
  command: managedRuntimeCommand('kiro-kas'),
  args: [],
  enabled: true,
};
const CLI: ACPConnectionConfig = {
  id: 'kiro',
  name: 'Kiro CLI',
  command: 'kiro-cli',
  args: ['acp', '--agent-engine', 'v2'],
  enabled: true,
};

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('engine-host-auth-routes-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stub = await startOidcStub();
  cleanups.push(() => stub.close());
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security-home'),
  });
  const operator = await security.initialize();
  const pair = (name: string) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
  };
  const setScope = (deviceId: string, scopes: readonly string[]) =>
    security.devicePairing.setDeviceScope(deviceId, [...scopes] as never, {
      kind: 'presented-credential',
    });

  const home = join(root, 'home');
  // A free local port stands in for Kiro's allowlisted callback ports.
  const callbackPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const hostAuth = new EngineHostAuthService({
    homeDir: home,
    policy: () => 'allowed',
    endpoints: stub.endpoints,
    // Nothing here is fetched: the social exchange is never reached.
    social: {
      portalUrl: 'https://portal.example.test',
      serviceUrl: 'https://service.example.test',
    },
    socialCallbackPorts: [callbackPort],
    launchFacts: engineLaunchFactsFor,
    schedule: () => () => undefined,
  });
  registerEngineHostAuth(hostAuth);
  const fetches: string[] = [];
  const installer = new ManagedInstaller(home, [KAS_INSTALL_DEFINITION], {
    ...defaultManagedInstallDeps(),
    platform: 'darwin',
    arch: 'arm64',
    // Nothing is downloaded: the install stays in progress.
    fetch: ((url: string) => {
      fetches.push(String(url));
      return new Promise(() => undefined);
    }) as typeof fetch,
  });
  registerManagedInstaller(installer);

  const acpJson = JSON.stringify({ connections: [BUNDLE, CLI] });
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({
      name: 'engine-host-auth-routes-test',
      level: 'error',
    }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.route(
    '/acp',
    createACPSignInRoutes({
      ctx: {
        configLoader: {
          loadACPConfig: async () => JSON.parse(acpJson),
        } as never,
      },
      service: new EngineSignInService({ terminal: null }),
    }),
  );
  const call = async (
    credential: string,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    env?: unknown,
  ) => {
    const res = await app.request(
      `/acp/connections/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };
  return {
    operator,
    pair,
    setScope,
    call,
    stub,
    hostAuth,
    installer,
    fetches,
    callbackPort,
  };
}

describe.runIf(process.platform !== 'win32')(
  'Station-run engine sign-in routes',
  () => {
    test('the view shows Station owning the bundle sign-in and its install; the kiro-cli engine has neither', async () => {
      const f = await fixture();
      const bundle = await f.call(
        f.operator.credential,
        'GET',
        'kiro-kas-bundle/sign-in',
      );
      expect(bundle.status).toBe(200);
      expect(bundle.body.data.status).toMatchObject({
        state: 'unauthenticated',
        source: 'station-vault',
        checkable: false,
      });
      // `app.request` has no socket: the caller reads as off this computer.
      expect(bundle.body.data.hostAuth).toEqual({
        status: { owner: 'station', state: 'signed-out', issueCount24h: 0 },
        identities: ['builder-id', 'identity-center'],
        socialSignIn: 'needs-browser-on-host',
        policy: 'allowed',
        install: {
          installId: 'kiro-kas',
          version: '0.66.104',
          state: { kind: 'not-installed' },
        },
        allowed: { install: true },
      });
      const cli = await f.call(f.operator.credential, 'GET', 'kiro/sign-in');
      expect(cli.body.data.hostAuth).toBeUndefined();
    });

    test('a standard device can neither start nor read a sign-in; engine:login can, and only for an engine Station signs in', async () => {
      const f = await fixture();
      const phone = f.pair('Phone');
      const refused = await f.call(
        phone.credential,
        'POST',
        'kiro-kas-bundle/host-auth/login',
        {
          identity: 'builder-id',
        },
      );
      expect(refused.status).toBe(403);
      expect(
        (
          await f.call(
            phone.credential,
            'GET',
            'kiro-kas-bundle/host-auth/login',
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call(
            phone.credential,
            'POST',
            'kiro-kas-bundle/host-auth/sign-out',
          )
        ).status,
      ).toBe(403);
      expect(f.stub.requests).toEqual([]);

      f.setScope(phone.device.id, [
        ...PAIRING_SCOPE_PRESETS.standard,
        PAIRING_SCOPE_ENGINE_LOGIN,
      ]);
      const started = await f.call(
        phone.credential,
        'POST',
        'kiro-kas-bundle/host-auth/login',
        {
          identity: 'builder-id',
        },
      );
      expect(started.status).toBe(200);
      expect(started.body.data).toMatchObject({
        phase: 'awaiting-approval',
        userCode: 'ABCD-EFGH',
      });
      const read = await f.call(
        phone.credential,
        'GET',
        'kiro-kas-bundle/host-auth/login',
      );
      expect(read.body.data.phase).toBe('awaiting-approval');
      const cancelled = await f.call(
        phone.credential,
        'DELETE',
        'kiro-kas-bundle/host-auth/login',
      );
      expect(cancelled.body.data.phase).toBe('cancelled');

      const cli = await f.call(
        phone.credential,
        'POST',
        'kiro/host-auth/login',
        {
          identity: 'builder-id',
        },
      );
      expect(cli.status).toBe(409);
    });

    test('an agent request cannot start a sign-in or install, even on the operator credential', async () => {
      const f = await fixture();
      const agent = {
        [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL,
      };
      expect(
        (
          await f.call(
            f.operator.credential,
            'POST',
            'kiro-kas-bundle/host-auth/login',
            { identity: 'builder-id' },
            agent,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call(
            f.operator.credential,
            'POST',
            'kiro-kas-bundle/managed-install',
            { consent: true },
            agent,
          )
        ).status,
      ).toBe(403);
      expect(f.stub.requests).toEqual([]);
      expect(f.fetches).toEqual([]);
    });

    test('install needs operate and explicit consent, and reports progress', async () => {
      const f = await fixture();
      const reader = f.pair('Reader');
      f.setScope(reader.device.id, PAIRING_SCOPE_PRESETS['read-only']);
      expect(
        (
          await f.call(
            reader.credential,
            'POST',
            'kiro-kas-bundle/managed-install',
            { consent: true },
          )
        ).status,
      ).toBe(403);
      const noConsent = await f.call(
        f.operator.credential,
        'POST',
        'kiro-kas-bundle/managed-install',
        {
          consent: 'yes',
        },
      );
      expect(noConsent.status).toBe(400);
      expect(f.fetches).toEqual([]);
      const started = await f.call(
        f.operator.credential,
        'POST',
        'kiro-kas-bundle/managed-install',
        {
          consent: true,
        },
      );
      expect(started.status).toBe(200);
      expect(started.body.data).toMatchObject({
        kind: 'installing',
        receivedBytes: 0,
      });
      expect(f.fetches).toEqual([
        'https://kas.crew.kiro.dev/kas/0.66.104/manifest.json',
      ]);
      const cli = await f.call(
        f.operator.credential,
        'POST',
        'kiro/managed-install',
        {
          consent: true,
        },
      );
      expect(cli.status).toBe(409);
    });

    /** A browser on this computer: a loopback socket that addressed loopback. */
    const ON_HOST = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const LOCAL_HOST = { Host: '127.0.0.1:3141' };

    test('Google and GitHub sign-in is offered only to a browser on the Station computer', async () => {
      const f = await fixture();
      const local = await f.call(
        f.operator.credential,
        'GET',
        'kiro-kas-bundle/sign-in',
        undefined,
        LOCAL_HOST,
        ON_HOST,
      );
      expect(local.body.data.hostAuth.identities).toEqual([
        'builder-id',
        'identity-center',
        'social',
      ]);
      expect(local.body.data.hostAuth).not.toHaveProperty('socialSignIn');

      // Loopback, but forwarded from elsewhere (a reverse proxy, a tunnel).
      const forwarded = await f.call(
        f.operator.credential,
        'GET',
        'kiro-kas-bundle/sign-in',
        undefined,
        { ...LOCAL_HOST, 'X-Forwarded-For': '203.0.113.7' },
        ON_HOST,
      );
      expect(forwarded.body.data.hostAuth.identities).toEqual([
        'builder-id',
        'identity-center',
      ]);
      expect(forwarded.body.data.hostAuth.socialSignIn).toBe(
        'needs-browser-on-host',
      );
    });

    test('a social sign-in from a browser elsewhere is refused before any port is bound; on the host it starts', async () => {
      const f = await fixture();
      const remote = await f.call(
        f.operator.credential,
        'POST',
        'kiro-kas-bundle/host-auth/login',
        { identity: 'social' },
      );
      expect(remote.status).toBe(409);
      expect(remote.body).toMatchObject({
        success: false,
        code: 'social-sign-in-needs-browser-on-host',
      });
      expect(
        f.hostAuth.login({
          connectionId: 'kiro-kas-bundle',
          credentialProfileRef: 'default',
        }),
      ).toBe(undefined);

      const local = await f.call(
        f.operator.credential,
        'POST',
        'kiro-kas-bundle/host-auth/login',
        { identity: 'social' },
        LOCAL_HOST,
        ON_HOST,
      );
      expect(local.status).toBe(200);
      expect(local.body.data.phase).toBe('awaiting-approval');
      const link = new URL(local.body.data.authorizationUrl);
      expect(link.origin).toBe('https://portal.example.test');
      expect(link.searchParams.get('redirect_uri')).toBe(
        `http://localhost:${f.callbackPort}`,
      );
      const cancelled = await f.call(
        f.operator.credential,
        'DELETE',
        'kiro-kas-bundle/host-auth/login',
        undefined,
        LOCAL_HOST,
        ON_HOST,
      );
      expect(cancelled.body.data.phase).toBe('cancelled');
    });
  },
);
