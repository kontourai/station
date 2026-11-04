/**
 * A Station published through a local `tailscale serve` mapping to its own
 * listener accepts a peer/browser access request addressed to that published
 * HTTPS origin with no `ALLOWED_ORIGINS` entry.
 *
 * Field failure (0.1.11-nightly.2499): a desktop sidecar on 127.0.0.1:38141,
 * published as `https://<node>.ts.net:3773`, answered every peer enrollment
 * with `403 origin_forbidden`. The sender presents the receiver's apiBase as
 * `Origin`; the runtime origin gate compared it only with the static
 * allow-list, and the pairing check's same-origin fallback cannot match
 * because Serve terminates TLS and the API sees plain HTTP.
 *
 * This drives the REAL `configureRuntimeRoutes` composition, so both runtime
 * origin gates and the pairing route's own check are on the path. Only the
 * `tailscale` executable is faked, at `execFile`, so the production resolver,
 * its parser and its cache all run.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_PROTOCOL_HEADER,
  DEFAULT_GRANT_PAIRING_SCOPE,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const makeTempDir = trackTempDirs();
const NODE = 'station.example.ts.net';
const PUBLISHED = `https://${NODE}:3773`;

const tailscale = vi.hoisted(() => ({
  /** `undefined` = the executable is not installed. */
  status: undefined as string | undefined,
  serve: undefined as string | undefined,
  calls: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = ((
    executable: string,
    args: readonly string[],
    ...rest: unknown[]
  ) => {
    if (!/(^|[\\/])tailscale$/i.test(executable)) {
      return (actual.execFile as (...values: unknown[]) => unknown)(
        executable,
        args,
        ...rest,
      );
    }
    tailscale.calls += 1;
    const callback = rest.at(-1) as (
      error: (Error & { code?: unknown }) | null,
      stdout: string,
    ) => void;
    const stdout = args[0] === 'status' ? tailscale.status : tailscale.serve;
    queueMicrotask(() => {
      if (stdout === undefined) {
        callback(Object.assign(new Error('absent'), { code: 'ENOENT' }), '');
      } else {
        callback(null, stdout);
      }
    });
    return undefined;
  }) as typeof actual.execFile;
  return { ...actual, execFile };
});

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

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

/** `tailscale status --json`, trimmed to the fields the resolver reads. */
const STATUS_JSON = JSON.stringify({
  Self: { DNSName: `${NODE}.`, Online: true },
});

/** `tailscale serve status --json` for one HTTPS listener. */
function serveJson(input: {
  authority?: string;
  handlers: Record<string, unknown>;
  funnel?: boolean;
}): string {
  const authority = input.authority ?? `${NODE}:3773`;
  return JSON.stringify({
    TCP: { [authority.slice(authority.lastIndexOf(':') + 1)]: { HTTPS: true } },
    Web: { [authority]: { Handlers: input.handlers } },
    ...(input.funnel ? { AllowFunnel: { [authority]: true } } : {}),
  });
}

// Each harness gets its own port: the production resolver is memoized per
// port with a 30-second cache, so a shared port would reuse a prior lookup.
let nextPort = 41_730;

const OPERATOR_TOKEN = 'operator-token-for-account-sharing';

async function composedHarness() {
  const port = nextPort++;
  const homeDir = makeTempDir('station-serve-origin-');
  mkdirSync(join(homeDir, 'config'), { mode: 0o700 });
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const requestAccess = vi.fn((input: { endpoint: string }) => ({
    requestId: 'request-1',
    endpoint: input.endpoint,
  }));
  const context = deepStub({
    projectMembership: undefined,
    // #4305 Project sharing setting, so the sign-in origin picker is mounted.
    accountSharing: () => ({
      lockedBy: [],
      active: {
        projectSharing: false,
        localAccounts: false,
        externalProvider: false,
      },
    }),
    accountSharingPreview: {
      select: <T>(branches: { enabled: () => T }) => branches.enabled(),
    },
    projectSharedTasks: undefined,
    deploymentAuthentication: undefined,
    localAccounts: undefined,
    applicationSessions: undefined,
    app: new Hono(),
    port,
    appConfig: {},
    getLiveAppConfig: () => ({}),
    configLoader: {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: () => ({}),
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
    orchestrationEventStore: deepStub({
      sessionTurnBoundaryAuthority: () => ({
        reconcile: () => ({ kind: 'available', interrupted: [] }),
      }),
    }),
    taskGraphService: { listTasks: () => [] },
    projectService: { listProjects: () => [], getProject: () => undefined },
    environmentSecurityService: deepStub({
      verifyCredential: (credential: string) => credential === OPERATOR_TOKEN,
      authorizeCredential: (credential: string) =>
        credential === OPERATOR_TOKEN,
      verifyOperatorCredential: (credential: string) =>
        credential === OPERATOR_TOKEN,
      resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      identifyDevice: () => undefined,
      credentialLocality: () => 'home-possession',
      credentialMintKind: () => 'operator',
      devicePairing: deepStub({ requestAccess }),
    }),
  });
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  const result = await configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  await result.kitLifecycleReady;

  /**
   * What a peer Station's enrollment sends through Serve: the published
   * origin as `Origin`, arriving as plain HTTP from the loopback daemon with
   * the tailnet Host preserved.
   */
  const accessRequest = (origin: string) =>
    Promise.resolve(
      context.app.request(
        `http://${NODE}:3773${PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH}`,
        {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            [CLIENT_PROTOCOL_HEADER]: String(STATION_COMPAT_PROTOCOL_VERSION),
          },
          body: JSON.stringify({ deviceName: 'Peer', kind: 'delegation' }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      ),
    );
  /** The operator's read of the sign-in origins the picker offers. */
  const sharingOrigins = async () => {
    const response = await context.app.request(
      'http://localhost/api/operator/account-sharing',
      { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return (
      JSON.parse(text) as {
        data: { origins: { origin: string; unavailable?: string }[] };
      }
    ).data.origins;
  };
  return {
    port,
    requestAccess,
    accessRequest,
    sharingOrigins,
    shutdown: () => result.deviceToolchainService?.shutdown(),
  };
}

async function expectOriginForbidden(response: Response) {
  expect(response.status).toBe(403);
  const body = (await response.json()) as { error: unknown };
  const code =
    typeof body.error === 'object' && body.error !== null
      ? (body.error as { code?: unknown }).code
      : body.error;
  expect(code).toBe('origin_forbidden');
}

describe('runtime routes: own Tailscale Serve origin admits pairing access requests', () => {
  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    tailscale.status = undefined;
    tailscale.serve = undefined;
    tailscale.calls = 0;
  });

  test('the HTTPS origin Serve maps to this listener reaches the pairing service', async () => {
    tailscale.status = STATUS_JSON;
    const h = await composedHarness();
    tailscale.serve = serveJson({
      handlers: { '/': { Proxy: `http://127.0.0.1:${h.port}` } },
    });
    try {
      const response = await h.accessRequest(PUBLISHED);
      expect(response.status).toBe(202);
      expect(h.requestAccess).toHaveBeenCalledTimes(1);
      // The endpoint is the daemon-published origin, not the plain-HTTP URL.
      expect(h.requestAccess.mock.calls[0]?.[0].endpoint).toBe(PUBLISHED);
    } finally {
      await h.shutdown();
    }
  });

  test.each([
    {
      name: 'a mapping published for another node',
      origin: 'https://other.example.ts.net:3773',
      serve: (port: number) =>
        serveJson({
          authority: 'other.example.ts.net:3773',
          handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } },
        }),
    },
    {
      name: 'a mapping to a different local port',
      origin: PUBLISHED,
      serve: (port: number) =>
        serveJson({
          handlers: { '/': { Proxy: `http://127.0.0.1:${port + 500}` } },
        }),
    },
    {
      name: 'the plain-HTTP spelling of the published origin',
      origin: `http://${NODE}:3773`,
      serve: (port: number) =>
        serveJson({ handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } }),
    },
    {
      name: 'a published origin with Funnel enabled',
      origin: PUBLISHED,
      serve: (port: number) =>
        serveJson({
          handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } },
          funnel: true,
        }),
    },
    {
      name: 'a published origin that also serves another service',
      origin: PUBLISHED,
      serve: (port: number) =>
        serveJson({
          handlers: {
            '/': { Proxy: `http://127.0.0.1:${port}` },
            '/other/': { Proxy: 'http://127.0.0.1:5000' },
          },
        }),
    },
    {
      name: 'a published origin with static content beside Station',
      origin: PUBLISHED,
      serve: (port: number) =>
        serveJson({
          handlers: {
            '/': { Proxy: `http://127.0.0.1:${port}` },
            '/files/': { Path: '/srv/files' },
          },
        }),
    },
  ])('refuses $name', async ({ origin, serve }) => {
    tailscale.status = STATUS_JSON;
    const h = await composedHarness();
    tailscale.serve = serve(h.port);
    try {
      await expectOriginForbidden(await h.accessRequest(origin));
      expect(h.requestAccess).not.toHaveBeenCalled();
    } finally {
      await h.shutdown();
    }
  });

  test('explicit ALLOWED_ORIGINS still admits without Tailscale, and only that origin', async () => {
    process.env.ALLOWED_ORIGINS = PUBLISHED;
    const h = await composedHarness();
    try {
      // A non-tailnet foreign origin is refused before any Tailscale lookup
      // (this runs first, so no cached lookup can hide a spawn).
      await expectOriginForbidden(
        await h.accessRequest('https://attacker.example'),
      );
      expect(tailscale.calls).toBe(0);
      expect((await h.accessRequest(PUBLISHED)).status).toBe(202);
      expect(h.requestAccess).toHaveBeenCalledTimes(1);
      await expectOriginForbidden(
        await h.accessRequest('https://elsewhere.example.ts.net:3773'),
      );
      expect(h.requestAccess).toHaveBeenCalledTimes(1);
    } finally {
      await h.shutdown();
    }
  });
});

describe('runtime routes: the sign-in origin picker reads the same origin policy', () => {
  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.STATION_UI_PORT;
    tailscale.status = undefined;
    tailscale.serve = undefined;
    tailscale.calls = 0;
  });

  /** Serve on the node's default HTTPS port, proxying to the UI listener. */
  function uiServe(uiPort: number, funnel = false) {
    return serveJson({
      authority: `${NODE}:443`,
      handlers: { '/': { Proxy: `http://127.0.0.1:${uiPort}` } },
      funnel,
    });
  }

  test("offers this Station's own Serve origin as selectable with no ALLOWED_ORIGINS entry", async () => {
    const uiPort = nextPort + 5_000;
    process.env.STATION_UI_PORT = String(uiPort);
    tailscale.status = STATUS_JSON;
    tailscale.serve = uiServe(uiPort);
    const h = await composedHarness();
    try {
      expect(await h.sharingOrigins()).toContainEqual({
        origin: `https://${NODE}`,
        sources: ['tailscale-serve'],
      });
    } finally {
      await h.shutdown();
    }
  });

  test('a Serve origin with Funnel on is listed but not selectable', async () => {
    const uiPort = nextPort + 5_000;
    process.env.STATION_UI_PORT = String(uiPort);
    tailscale.status = STATUS_JSON;
    tailscale.serve = uiServe(uiPort, true);
    const h = await composedHarness();
    try {
      expect(await h.sharingOrigins()).toContainEqual({
        origin: `https://${NODE}`,
        sources: ['tailscale-serve'],
        unavailable: 'not-a-browser-origin',
      });
    } finally {
      await h.shutdown();
    }
  });
});
