/**
 * #3586: personal access tokens for account-tied people, through the
 * PRODUCTION composition (real `configureRuntimeRoutes`, real pairing-scope
 * enforcement, the real account-bound device gate, real Project membership
 * and real Station local accounts: sign-up, sign-in, disable and "sign out
 * everywhere" go through the same provider production loads).
 *
 * The only composition step done by hand is the one `station-runtime.ts`
 * does when local accounts load: installing their account directory on the
 * device pairing service. Account registration is admitted by a permissive
 * enrollment policy (registration is not under test); Project membership is
 * granted over the real invitation routes.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import {
  type LoadedLocalAccounts,
  loadLocalAccounts,
} from '../../../services/identity/local-account-runtime.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
} from '../../../utils/internal-api-token.js';
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

const ORIGIN = 'https://station.example.test';
const STATION_ID = 'account-token-fixture';
const GRANT = 'orchestration:read orchestration:operate';
const operatorApproval = { kind: 'presented-credential' } as const;

describe('account-tied personal access tokens over the production composition', () => {
  // Created first, so its after-hook removes the homes after the account
  // stores below have closed.
  const makeTempDir = trackTempDirs();
  const directories: string[] = [];
  const loaded: LoadedLocalAccounts[] = [];
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  const ambientOrigins = process.env.ALLOWED_ORIGINS;
  beforeEach(() => {
    const owned = makeTempDir('station-account-tokens-');
    directories.push(owned);
    mkdirSync(join(owned, 'home'));
    mkdirSync(join(owned, 'root'));
    mkdirSync(join(owned, 'data'));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
    process.env.ALLOWED_ORIGINS = ORIGIN;
  });
  afterEach(async () => {
    for (const accounts of loaded.splice(0)) await accounts.service.close();
    if (ambientHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = ambientHome;
    if (ambientRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = ambientRoot;
    if (ambientOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = ambientOrigins;
    vi.restoreAllMocks();
    directories.splice(0);
  });

  async function setup() {
    const owned = directories[directories.length - 1];
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();
    const storage = new FileStorageAdapter(homeDir);
    const manifests = new ProjectManifestStore(homeDir, storage);
    const projectService = new ProjectService(storage, manifests);
    const membership = createProjectMembershipRuntime(
      homeDir,
      STATION_ID,
      storage,
    );
    const localAccounts = await loadLocalAccounts(
      { publicOrigin: ORIGIN },
      { stationId: STATION_ID, homeDirectory: homeDir },
      { mayRegister: async () => true },
    );
    loaded.push(localAccounts);
    // What station-runtime.ts does once local accounts load.
    security.devicePairing.setAccountDirectory(localAccounts.accountDirectory);
    const issuer = localAccounts.accountDirectory.issuer;
    const applicationSessions = createApplicationSessionRuntime(
      homeDir,
      STATION_ID,
      localAccounts,
      (value: string) => security.devicePairing.identifyDevice(value),
    );

    const app = new Hono();
    let appConfig: Record<string, unknown> = {};
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks: membership.sharedTasks,
      deploymentAuthentication: localAccounts,
      localAccounts,
      applicationSessions,
      storageAdapter: storage,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({ ...appConfig }),
        mutateAppConfig: async (
          mutate: (current: Record<string, unknown>) => Record<string, unknown>,
        ) => {
          appConfig = { ...appConfig, ...mutate({ ...appConfig }) };
          return { ...appConfig };
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
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
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      environmentSecurityService: security,
      eventBus: new EventBus(),
      taskGraphService: { listTasks: () => [] },
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;

    const request = (path: string, init: RequestInit = {}, peer?: string) =>
      app.request(
        `${ORIGIN}${path}`,
        init,
        peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined,
      );
    const accountAuth = (path: string, body: unknown) =>
      localAccounts.service.handle(
        new Request(`${ORIGIN}/api/account-auth${path}`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
            'Content-Type': 'application/json',
            // Enrollment is admitted by the permissive policy above.
            'x-station-invitation': 'fixture-enrollment',
          },
          body: JSON.stringify(body),
        }),
        path,
      );

    /** A real local account, signed in: its id and session cookie. */
    const createAccount = async (username: string) => {
      const password = `${username} password 12345`;
      const registered = await accountAuth('/sign-up/username', {
        username,
        password,
      });
      expect(registered.status, await registered.clone().text()).toBe(200);
      const login = await accountAuth('/sign-in/username', {
        username,
        password,
      });
      expect(login.status, await login.clone().text()).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const account = localAccounts.administration
        .list()
        .find((entry) => entry.username === username);
      if (!account) throw new Error(`account ${username} was not created`);
      return {
        accountId: account.accountId,
        cookie,
        principalId: deploymentAccountPrincipal(
          issuer,
          account.accountId,
          username,
        ).id,
      };
    };

    /** An account-bound device for `account`, with its own credential. */
    const pairAccountDevice = (
      account: { accountId: string; principalId: string },
      name: string,
    ) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({ endpoint: ORIGIN, scope: GRANT });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        requesterPosition: 'unproven',
        source: 'same-origin',
        accountCandidate: {
          issuer,
          subject: account.accountId,
          displayName: name,
        },
        accountCandidateSessionId: 'candidate-proof',
        requireAccountBinding: true,
      });
      pairing.confirmRequest(
        pending.requestId,
        { ...operatorApproval },
        { principalId: account.principalId, kind: 'account' },
      );
      return pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }).credential;
    };

    const withHeaders =
      (headers: Record<string, string>) =>
      (init: RequestInit = {}): RequestInit => ({
        ...init,
        headers: {
          ...((init.headers as Record<string, string>) ?? {}),
          ...headers,
        },
      });
    const operator = withHeaders({
      Authorization: `Bearer ${operatorCredential}`,
    });
    /** A signed-in person: their account-bound device and session. */
    const person = async (username: string) => {
      const account = await createAccount(username);
      const credential = pairAccountDevice(account, `${username}-laptop`);
      return {
        ...account,
        device: withHeaders({
          Authorization: `Bearer ${credential}`,
          Cookie: account.cookie,
          Origin: ORIGIN,
        }),
      };
    };
    const owner = await person('owner');
    const ownerOperator = withHeaders({
      Authorization: `Bearer ${operatorCredential}`,
      Cookie: owner.cookie,
      Origin: ORIGIN,
    });

    /** The person makes a token from their own device (self-service). */
    const mintToken = async (
      device: (init?: RequestInit) => RequestInit,
      scope = 'orchestration:read',
    ) => {
      const minted = await request(
        '/api/access/tokens',
        device({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Script', scope }),
        }),
      );
      return minted;
    };
    const bearer = (secret: string) =>
      withHeaders({ Authorization: `Bearer ${secret}` });

    /** The owner shares `slug` and `member` joins as `role`. */
    const shareWith = async (
      slug: string,
      member: Awaited<ReturnType<typeof person>>,
      role: 'viewer' | 'admin',
    ) => {
      const project = await projectService.createProject({ name: slug, slug });
      const enabled = await request(
        `/api/projects/${slug}/access/enable`,
        ownerOperator({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localProjectId: project.id }),
        }),
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const scope = (await readJson<{ data: { scope: unknown } }>(enabled)).data
        .scope;
      const invited = await request(
        `/api/projects/${slug}/access/invitations`,
        ownerOperator({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope,
            email: null,
            role,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        }),
      );
      expect(invited.status, await invited.clone().text()).toBe(200);
      const token = (await readJson<{ data: { token: string } }>(invited)).data
        .token;
      const accepted = await request(
        '/api/account-auth/accept-invitation',
        member.device({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
      );
      expect(accepted.status, await accepted.clone().text()).toBe(200);
    };
    const slugs = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await readJson<{ data: { slug: string }[] }>(response);
      return body.data.map((project) => project.slug).sort();
    };

    return {
      security,
      localAccounts,
      request,
      operator,
      person,
      mintToken,
      bearer,
      shareWith,
      slugs,
      projectService,
    };
  }

  test('a member token reads its Project; a non-member token gets 404 and an empty catalogue', async () => {
    const h = await setup();
    const member = await h.person('member');
    const outsider = await h.person('outsider');
    await h.shareWith('demo', member, 'viewer');
    await h.projectService.createProject({ name: 'Private', slug: 'private' });

    const memberMint = await h.mintToken(member.device);
    expect(memberMint.status, await memberMint.clone().text()).toBe(201);
    const memberToken = h.bearer(
      (await readJson<{ secret: string }>(memberMint)).secret,
    );
    const outsiderMint = await h.mintToken(outsider.device);
    expect(outsiderMint.status, await outsiderMint.clone().text()).toBe(201);
    const outsiderToken = h.bearer(
      (await readJson<{ secret: string }>(outsiderMint)).secret,
    );

    const read = await h.request('/api/projects/demo', memberToken());
    expect(read.status, await read.clone().text()).toBe(200);
    const unshared = await h.request('/api/projects/private', memberToken());
    expect(unshared.status, await unshared.clone().text()).toBe(404);
    expect(
      await h.slugs(await h.request('/api/projects', memberToken())),
    ).toEqual(['demo']);

    const refused = await h.request('/api/projects/demo', outsiderToken());
    expect(refused.status, await refused.clone().text()).toBe(404);
    expect(
      await h.slugs(await h.request('/api/projects', outsiderToken())),
    ).toEqual([]);

    // The operator still reads every Project.
    expect(
      await h.slugs(await h.request('/api/projects', h.operator())),
    ).toEqual(['demo', 'private']);
  });

  test("a member token reads its Project's shared work; a non-member token gets 404", async () => {
    const h = await setup();
    const member = await h.person('member');
    const outsider = await h.person('outsider');
    await h.shareWith('demo', member, 'viewer');
    const tokenOf = async (device: (init?: RequestInit) => RequestInit) => {
      const minted = await h.mintToken(device);
      expect(minted.status, await minted.clone().text()).toBe(201);
      return h.bearer((await readJson<{ secret: string }>(minted)).secret);
    };
    const memberRead = await h.request(
      '/api/projects/demo/shared-work',
      (await tokenOf(member.device))(),
    );
    expect(memberRead.status, await memberRead.clone().text()).toBe(200);
    expect(await memberRead.json()).toMatchObject({ success: true, data: [] });
    const outsiderRead = await h.request(
      '/api/projects/demo/shared-work',
      (await tokenOf(outsider.device))(),
    );
    expect(outsiderRead.status, await outsiderRead.clone().text()).toBe(404);
  });

  test('a token acts as its account: the observed principal is the account principal', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    const observed = await h.request('/api/auth/authority', token());
    expect(observed.status, await observed.clone().text()).toBe(200);
    const body = await readJson<{ principal: { id: string } }>(observed);
    expect(body.principal.id).toBe(member.principalId);
  });

  test('disabling the account makes its token 401', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    expect((await h.request('/api/projects', token())).status).toBe(200);
    h.localAccounts.administration.setDisabled(member.accountId, true);
    const refused = await h.request('/api/projects', token());
    expect(refused.status, await refused.clone().text()).toBe(401);
  });

  test('signing the account out everywhere after the token was made makes it 401', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    expect((await h.request('/api/projects', token())).status).toBe(200);
    // The revocation is stamped in milliseconds; make it strictly later.
    await new Promise((settle) => setTimeout(settle, 5));
    h.localAccounts.administration.revokeSessions(member.accountId);
    const refused = await h.request('/api/projects', token());
    expect(refused.status, await refused.clone().text()).toBe(401);
  });

  test('re-enabling a disabled account does not revive tokens made before it was disabled', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    await new Promise((settle) => setTimeout(settle, 5));
    h.localAccounts.administration.setDisabled(member.accountId, true);
    h.localAccounts.administration.setDisabled(member.accountId, false);
    const refused = await h.request('/api/projects', token());
    expect(refused.status, await refused.clone().text()).toBe(401);
  });

  // Station has no account-deletion route; the account store's own user row
  // is what a deletion removes, so the test removes it there.
  test('a token for an account that no longer exists is 401', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    expect((await h.request('/api/projects', token())).status).toBe(200);
    const database = (
      h.localAccounts.administration as unknown as {
        database: import('node:sqlite').DatabaseSync;
      }
    ).database;
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare('DELETE FROM user WHERE id = ?').run(member.accountId);
    const refused = await h.request('/api/projects', token());
    expect(refused.status, await refused.clone().text()).toBe(401);
  });

  test('a token is refused, not served, once the account store is closed', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { secret } = await readJson<{ secret: string }>(minted);
    expect((await h.request('/api/projects', h.bearer(secret)())).status).toBe(
      200,
    );
    // The provider's own close, which closes its account database.
    await h.localAccounts.service.close();
    loaded.splice(loaded.indexOf(h.localAccounts), 1);
    // The token stops resolving (the standing read fails closed); the
    // request itself is answered by the closed authentication service.
    expect(h.security.identifyDevice(secret)).toBeNull();
    expect(h.security.verifyCredential(secret)).toBe(false);
    const refused = await h.request('/api/projects', h.bearer(secret)());
    expect(refused.status, await refused.clone().text()).toBe(503);
  });

  test('a token presented with another account cookie is an identity conflict', async () => {
    const h = await setup();
    const member = await h.person('member');
    const other = await h.person('other');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { secret } = await readJson<{ secret: string }>(minted);
    const conflicted = await h.request('/api/projects', {
      headers: {
        Authorization: `Bearer ${secret}`,
        Cookie: other.cookie,
        Origin: 'https://station.example.test',
      },
    });
    expect(conflicted.status, await conflicted.clone().text()).toBe(401);
    expect(await conflicted.json()).toEqual({
      error: { code: 'account_identity_conflict' },
    });
  });

  test('a token presented with its own account cookie, or behind a verified ingress identity, is an identity conflict', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { secret } = await readJson<{ secret: string }>(minted);
    const ownCookie = await h.request('/api/projects', {
      headers: {
        Authorization: `Bearer ${secret}`,
        Cookie: member.cookie,
        Origin: ORIGIN,
      },
    });
    expect(ownCookie.status, await ownCookie.clone().text()).toBe(401);
    expect(await ownCookie.json()).toEqual({
      error: { code: 'account_identity_conflict' },
    });
    // The loopback UI proxy's attested Tailscale identity, as it forwards it.
    const ingress = await h.request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
            JSON.stringify({
              provider: 'tailscale-serve',
              login: 'casey@example.test',
              displayName: 'Casey',
            }),
          ).toString('base64url'),
        },
      },
      '127.0.0.1',
    );
    expect(ingress.status, await ingress.clone().text()).toBe(401);
    expect(await ingress.json()).toEqual({
      error: { code: 'account_identity_conflict' },
    });
  });

  test('a token never takes the native Device receipt self-read shortcut', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    const receipt = await h.request(
      '/api/auth/native-device-bindings/0b9d3c3e-6a1f-4c2e-9d7a-2f1e8b6c4a10/receipt',
      token(),
    );
    expect(receipt.status, await receipt.clone().text()).toBe(403);
    expect(await receipt.json()).toEqual({
      error: { code: 'account_bound_device_route_forbidden' },
    });
  });

  test('a token is held to the narrowed account-bound allowlist', async () => {
    const h = await setup();
    const member = await h.person('member');
    await h.shareWith('demo', member, 'admin');
    const minted = await h.mintToken(
      member.device,
      'orchestration:read orchestration:operate',
    );
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    // The same person's device reads the Project's access as its admin.
    const deviceAccess = await h.request(
      '/api/projects/demo/access',
      member.device(),
    );
    expect(deviceAccess.status, await deviceAccess.clone().text()).toBe(200);

    // Each refusal names the layer that made it: the pairing-scope table
    // refuses tokens on the Project access leaves (`personalTokens:
    // 'refused'`) before the account-bound gate runs; the gate refuses the
    // rest. Both layers refuse the access leaves; only the first is seen.
    for (const [path, init, code] of [
      ['/api/agents', {}, 'account_bound_device_route_forbidden'],
      ['/api/projects/demo/access', {}, 'insufficient_scope'],
      [
        '/api/projects/demo/access/invitations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        'insufficient_scope',
      ],
      ['/api/access/tokens', {}, 'account_bound_device_route_forbidden'],
    ] as const) {
      const refused = await h.request(path, token(init as RequestInit));
      expect(refused.status, `${path}: ${await refused.clone().text()}`).toBe(
        403,
      );
      expect(await refused.json(), path).toEqual({ error: { code } });
    }
    // The account surface reads only account credentials: a token is not
    // a session there, so it cannot see or extend one.
    const session = await h.request('/api/account-auth/session', token());
    expect(session.status, await session.clone().text()).toBe(401);
    expect(await session.json()).toEqual({
      error: { code: 'authentication_required' },
    });
    const read = await h.request('/api/projects/demo', token());
    expect(read.status, await read.clone().text()).toBe(200);
  });

  test('People offers tokens for an account-tied person only while the account directory answers for them', async () => {
    const h = await setup();
    const member = await h.person('member');
    const canHold = async () => {
      const response = await h.request('/api/pairing/people', h.operator());
      expect(response.status, await response.clone().text()).toBe(200);
      const { people } = await readJson<{
        people: { principalId: string; canHoldTokens: boolean }[];
      }>(response);
      return people.find((entry) => entry.principalId === member.principalId)
        ?.canHoldTokens;
    };
    expect(await canHold()).toBe(true);
    const minted = await h.request(
      `/api/pairing/people/${encodeURIComponent(member.principalId)}/tokens`,
      h.operator({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ops', scope: 'orchestration:read' }),
      }),
    );
    expect(minted.status, await minted.clone().text()).toBe(201);
    h.security.devicePairing.setAccountDirectory(undefined);
    expect(await canHold()).toBe(false);
  });

  test('without an account directory, no token is made for an account-tied person and existing ones stop', async () => {
    const h = await setup();
    const member = await h.person('member');
    const minted = await h.mintToken(member.device);
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = h.bearer((await readJson<{ secret: string }>(minted)).secret);
    h.security.devicePairing.setAccountDirectory(undefined);
    const refused = await h.mintToken(member.device);
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: 'account_bound_person' },
    });
    const stale = await h.request('/api/projects', token());
    expect(stale.status, await stale.clone().text()).toBe(401);
  });
});
