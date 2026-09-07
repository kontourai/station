import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StationProfile } from '@kontourai/station-contracts';
import { PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH } from '@kontourai/station-contracts/environment-security';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureApiCredential,
  parseCoreArgs,
  requestJson,
  resolveApiBaseDetailed,
} from '../commands/core-api.js';
import {
  createLocalSelfHealCredentialResolver,
  isLoopbackSelfAuthEndpoint,
  selfAuthorizeLocalProfile,
} from '../commands/local-self-auth.js';
import {
  type ProfileCredentialStore,
  resetProfileCredentialStoreForTests,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { findProfile, upsertProfile } from '../commands/profile-store.js';

let root: string;
let home: string;
let serviceHome: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;

/**
 * The EXACT bytes the server's `writeLocalGrantSecretFile`
 * (`src-server/runtime/routes/runtime-routes.ts`) produces: 32 random bytes
 * as base64url, written with no trailing newline, file mode 0600.
 */
function writeSecretBytes(baseDir: string, secret: string): void {
  mkdirSync(join(baseDir, 'runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(join(baseDir, 'runtime', 'local-grant.secret'), secret, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function writeRealLocalGrantSecret(baseDir: string): string {
  const secret = randomBytes(32).toString('base64url');
  writeSecretBytes(baseDir, secret);
  return secret;
}

function memoryCredentialStore(): ProfileCredentialStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (ref) => values.get(ref.id),
    set: (ref, credential) => void values.set(ref.id, credential),
    delete: (ref) => void values.delete(ref.id),
    status: (ref) => (values.has(ref.id) ? 'available' : 'missing'),
  };
}

interface StubStation {
  server: Server;
  port: number;
  origin: string;
  secret: string;
  issuedCredentials: string[];
  localGrantRequests: Array<Record<string, unknown>>;
  authenticatedAgentRequests: string[];
  close: () => Promise<void>;
}

/**
 * A loopback stand-in for the server's local-grant exchange route, answering
 * with the real route's wire shapes: 403 `{"error":"local_grant_forbidden"}`
 * for a wrong secret (`runtime-routes.ts` keeps every refusal
 * indistinguishable under that one code) and the bearer exchange response
 * `{environmentId, device, credential}` on success. Also serves an
 * authenticated `/api/agents` so the self-heal test exercises the real
 * request path end to end.
 */
async function startStubStation(): Promise<StubStation> {
  const secret = randomBytes(32).toString('base64url');
  const issuedCredentials: string[] = [];
  const localGrantRequests: Array<Record<string, unknown>> = [];
  const authenticatedAgentRequests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (
        request.method === 'POST' &&
        request.url === PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH
      ) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          secret?: string;
        };
        localGrantRequests.push(body as Record<string, unknown>);
        if (body.secret !== secret) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'local_grant_forbidden' }));
          return;
        }
        const credential = `issued-${randomUUID()}`;
        issuedCredentials.push(credential);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            environmentId: 'env-local-stub',
            device: {
              id: randomUUID(),
              name: 'stub device',
              scope: 'chat',
              kind: 'device',
              createdAt: Date.now(),
            },
            credential,
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/api/agents') {
        const authorization = request.headers.authorization;
        if (
          !authorization ||
          !issuedCredentials.includes(authorization.replace('Bearer ', ''))
        ) {
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              success: false,
              error: { code: 'authentication_required' },
            }),
          );
          return;
        }
        authenticatedAgentRequests.push(authorization);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: [] }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address !== 'object')
    throw new Error('stub Station failed to bind');
  const port = address.port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    secret,
    issuedCredentials,
    localGrantRequests,
    authenticatedAgentRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function localProfile(
  endpoint: string,
  overrides: Partial<StationProfile> = {},
): StationProfile {
  const profile = upsertProfile({
    name: 'kontour',
    endpoint,
    setupSource: 'local',
    configurationState: 'configured',
    localService: {
      instanceId: 'stable',
      baseDir: serviceHome,
      serverPort: 43199,
      uiPort: 43198,
    },
    makeDefault: true,
    force: true,
    ...overrides,
  }).profile;
  return profile;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'station-local-self-auth-'));
  home = join(root, 'instances', 'stable');
  // Outside the shared profile root: an arbitrary directory entry there
  // would (correctly) block first-run profile-store genesis.
  serviceHome = mkdtempSync(join(tmpdir(), 'station-local-service-home-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = root;
  delete process.env.STATION_TARGET;
  delete process.env.STATION_API_CREDENTIAL;
});

afterEach(() => {
  setClientCredentialResolver(undefined);
  resetProfileCredentialStoreForTests();
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
  rmSync(serviceHome, { recursive: true, force: true });
});

describe('isLoopbackSelfAuthEndpoint', () => {
  it('accepts only IP-literal loopback origins', () => {
    expect(isLoopbackSelfAuthEndpoint('http://127.0.0.1:3141')).toBe(true);
    expect(isLoopbackSelfAuthEndpoint('http://127.0.0.2:3141')).toBe(true);
    expect(isLoopbackSelfAuthEndpoint('http://[::1]:3141')).toBe(true);
    // A resolvable NAME is a name service's answer, not a network position.
    expect(isLoopbackSelfAuthEndpoint('http://localhost:3141')).toBe(false);
    expect(isLoopbackSelfAuthEndpoint('http://192.0.2.10:3141')).toBe(false);
    expect(isLoopbackSelfAuthEndpoint('https://station.example')).toBe(false);
    expect(isLoopbackSelfAuthEndpoint('not a url')).toBe(false);
  });
});

describe('selfAuthorizeLocalProfile', () => {
  it('exchanges the real secret bytes for a durable credential and persists it the way pairing does', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      const store = memoryCredentialStore();
      const profile = localProfile(stub.origin);

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: store,
        resolveHostname: () => 'testhost',
      });

      expect(outcome.status).toBe('authorized');
      // The wire request carried the exact on-disk secret and the pairing
      // request shape the server's route requires.
      expect(stub.localGrantRequests).toEqual([
        {
          secret: stub.secret,
          deviceName: 'testhost CLI',
          clientInstanceId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        },
      ]);
      const saved = findProfile('kontour');
      expect(saved?.credentialRef?.id).toMatch(/^local-grant:/);
      expect(saved?.environmentId).toBe('env-local-stub');
      expect(saved?.configurationState).toBe('configured');
      // The minted supersession identity is persisted verbatim.
      expect(saved?.clientInstanceId).toBe(
        (stub.localGrantRequests[0] as { clientInstanceId: string })
          .clientInstanceId,
      );
      expect(store.values.get(saved!.credentialRef!.id)).toBe(
        stub.issuedCredentials[0],
      );
    } finally {
      await stub.close();
    }
  });

  it('reuses a persisted clientInstanceId so the server supersedes the displaced grant', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      const existingId = randomUUID();
      const profile = localProfile(stub.origin, {
        clientInstanceId: existingId,
      });

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: memoryCredentialStore(),
      });

      expect(outcome.status).toBe('authorized');
      expect(stub.localGrantRequests[0]).toMatchObject({
        clientInstanceId: existingId,
      });
      expect(findProfile('kontour')?.clientInstanceId).toBe(existingId);
    } finally {
      await stub.close();
    }
  });

  it('never self-authorizes a non-loopback endpoint, even with a readable secret', async () => {
    writeRealLocalGrantSecret(serviceHome);
    const store = memoryCredentialStore();
    const fetchSpy = vi.fn();
    const profile = localProfile('http://192.0.2.10:43199');

    const outcome = await selfAuthorizeLocalProfile(profile, {
      credentialStore: store,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(outcome.status).toBe('ineligible');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.values.size).toBe(0);
    expect(findProfile('kontour')?.credentialRef).toBeUndefined();
  });

  it('never self-authorizes a name-resolved localhost endpoint', async () => {
    writeRealLocalGrantSecret(serviceHome);
    const fetchSpy = vi.fn();
    const profile = localProfile('http://localhost:43199');

    const outcome = await selfAuthorizeLocalProfile(profile, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(outcome.status).toBe('ineligible');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a profile with no installed local service', async () => {
    const fetchSpy = vi.fn();
    const profile = localProfile('http://127.0.0.1:43199', {
      localService: undefined,
    });

    const outcome = await selfAuthorizeLocalProfile(profile, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(outcome.status).toBe('ineligible');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a missing secret without contacting the Station', async () => {
    const fetchSpy = vi.fn();
    const profile = localProfile('http://127.0.0.1:43199');

    const outcome = await selfAuthorizeLocalProfile(profile, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('local-grant.secret'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces the server refusal code and persists nothing on a refused exchange', async () => {
    const stub = await startStubStation();
    try {
      // A DIFFERENT boot's secret: real bytes, wrong value — the server
      // route answers every wrong proof with local_grant_forbidden.
      writeRealLocalGrantSecret(serviceHome);
      const store = memoryCredentialStore();
      const profile = localProfile(stub.origin);

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: store,
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('local_grant_forbidden'),
      });
      expect(store.values.size).toBe(0);
      expect(findProfile('kontour')?.credentialRef).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('reports unreachable when nothing answers on the loopback endpoint', async () => {
    writeRealLocalGrantSecret(serviceHome);
    // Ephemeral port that nothing listens on: bind, learn the port, close.
    const stub = await startStubStation();
    await stub.close();
    const profile = localProfile(stub.origin);

    const outcome = await selfAuthorizeLocalProfile(profile, {
      credentialStore: memoryCredentialStore(),
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('could not reach'),
    });
  });

  it('refuses the commit and rolls back when the binding changes during the keyring write', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      const store = memoryCredentialStore();
      const profile = localProfile(stub.origin);
      // The keyring write is where a real OS prompt can block for minutes.
      // Deterministically land the user's concurrent
      // `station stations edit kontour https://edited.example` inside that
      // exact window.
      const promptingStore = {
        ...store,
        set: (ref: { id: string }, credential: string) => {
          store.set(ref as never, credential);
          upsertProfile({
            name: 'kontour',
            endpoint: 'https://edited.example',
            force: true,
          });
        },
      };

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: promptingStore as never,
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('credential was rolled back'),
      });
      // No stranded keyring entry.
      expect(store.values.size).toBe(0);
      // The user's edit won, byte for byte untouched by the refused commit.
      const edited = findProfile('kontour');
      expect(edited?.endpoint).toBe('https://edited.example');
      expect(edited?.credentialRef).toBeUndefined();
      expect(edited?.configurationState).toBe('unconfigured');
    } finally {
      await stub.close();
    }
  });

  it('reads the secret with the desktop parity checks: trims a trailing newline', async () => {
    const stub = await startStubStation();
    try {
      // A hand-inspected or editor-saved secret file may gain a newline; the
      // desktop trims before exchanging, and so does the CLI.
      writeSecretBytes(serviceHome, `${stub.secret}\n`);
      const outcome = await selfAuthorizeLocalProfile(
        localProfile(stub.origin),
        {
          credentialStore: memoryCredentialStore(),
        },
      );
      expect(outcome.status).toBe('authorized');
      expect(stub.localGrantRequests[0]).toMatchObject({ secret: stub.secret });
    } finally {
      await stub.close();
    }
  });

  it('refuses a secret of implausible length without contacting the Station', async () => {
    writeSecretBytes(serviceHome, 'short');
    const fetchSpy = vi.fn();
    const outcome = await selfAuthorizeLocalProfile(
      localProfile('http://127.0.0.1:43199'),
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('unexpected length'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a non-absolute local service base directory without reading anything', async () => {
    const fetchSpy = vi.fn();
    const outcome = await selfAuthorizeLocalProfile(
      localProfile('http://127.0.0.1:43199', {
        localService: {
          instanceId: 'stable',
          baseDir: 'relative/station-home',
          serverPort: 43199,
          uiPort: 43198,
        },
      }),
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('invalid base directory'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discloses an unconfirmed retirement of the displaced credential ref', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      const store = memoryCredentialStore();
      const profile = localProfile(stub.origin, {
        credentialRef: { kind: 'station-bearer', id: 'stale-ref' },
      });
      store.values.set('stale-ref', 'stale-credential');
      const stubbornStore = {
        ...store,
        delete: (ref: { id: string }) => {
          if (ref.id === 'stale-ref') throw new Error('keyring busy');
          store.delete(ref as never);
        },
      };

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: stubbornStore as never,
      });

      expect(outcome).toMatchObject({
        status: 'authorized',
        warning:
          'The new Station binding is active, but retirement of the replaced credential could not be confirmed.',
      });
    } finally {
      await stub.close();
    }
  });

  it('rolls the keyring entry back when the metadata commit fails', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      const store = memoryCredentialStore();
      const profile = localProfile(stub.origin);
      // Poison the metadata write with the same lock the store's own writer
      // honors, so the failure is the real writer's failure.
      const config = join(root, 'config');
      mkdirSync(config, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(config, 'profiles.json.lock'),
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: Date.now() })}\n`,
        { mode: 0o600 },
      );

      const outcome = await selfAuthorizeLocalProfile(profile, {
        credentialStore: store,
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('credential was rolled back'),
      });
      expect(store.values.size).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

describe('createLocalSelfHealCredentialResolver', () => {
  it('heals the #1098 state: a credential-less local profile authorizes the first request', async () => {
    const stub = await startStubStation();
    try {
      writeSecretBytes(serviceHome, stub.secret);
      setProfileCredentialStore(memoryCredentialStore());
      localProfile(stub.origin);

      const parsed = parseCoreArgs([]);
      const resolved = resolveApiBaseDetailed(parsed);
      expect(resolved.station).toBe('kontour');
      expect(configureApiCredential(parsed, resolved.apiBase)).toBe(true);

      // The full enforcement path: the SDK resolver performs the exchange
      // before attaching auth, so the very first request succeeds.
      const agents = await requestJson(resolved.apiBase, '/api/agents');
      expect(agents).toEqual([]);
      expect(stub.authenticatedAgentRequests).toEqual([
        `Bearer ${stub.issuedCredentials[0]}`,
      ]);
      // And the heal is durable: the profile now carries the credential ref.
      expect(findProfile('kontour')?.credentialRef?.id).toMatch(
        /^local-grant:/,
      );
    } finally {
      await stub.close();
    }
  });

  it('attempts the exchange once per process, not once per request', async () => {
    const stub = await startStubStation();
    try {
      // Wrong secret on disk: every exchange refuses.
      writeRealLocalGrantSecret(serviceHome);
      setProfileCredentialStore(memoryCredentialStore());
      localProfile(stub.origin);
      const resolver = createLocalSelfHealCredentialResolver(
        'kontour',
        stub.origin,
      );
      expect(resolver).toBeDefined();

      expect(await resolver!()).toBeUndefined();
      expect(await resolver!()).toBeUndefined();
      expect(stub.localGrantRequests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it('installs no resolver for a non-loopback profile', () => {
    writeRealLocalGrantSecret(serviceHome);
    localProfile('http://192.0.2.10:43199');
    expect(
      createLocalSelfHealCredentialResolver(
        'kontour',
        'http://192.0.2.10:43199',
      ),
    ).toBeUndefined();

    const parsed = parseCoreArgs([]);
    const resolved = resolveApiBaseDetailed(parsed);
    expect(configureApiCredential(parsed, resolved.apiBase)).toBe(false);
  });

  it('installs no resolver for a binding setup local did not create', () => {
    writeRealLocalGrantSecret(serviceHome);
    localProfile('http://127.0.0.1:43199', { setupSource: 'manual' });
    expect(
      createLocalSelfHealCredentialResolver(
        'kontour',
        'http://127.0.0.1:43199',
      ),
    ).toBeUndefined();
    // Restoring the setup-local provenance re-arms healing.
    localProfile('http://127.0.0.1:43199');
    expect(
      createLocalSelfHealCredentialResolver(
        'kontour',
        'http://127.0.0.1:43199',
      ),
    ).toBeDefined();
  });

  it('installs no resolver when the secret file does not exist', () => {
    localProfile('http://127.0.0.1:43199');
    expect(
      createLocalSelfHealCredentialResolver(
        'kontour',
        'http://127.0.0.1:43199',
      ),
    ).toBeUndefined();
  });

  it('installs no resolver when the resolved origin is not the profile endpoint', () => {
    writeRealLocalGrantSecret(serviceHome);
    localProfile('http://127.0.0.1:43199');
    expect(
      createLocalSelfHealCredentialResolver(
        'kontour',
        'http://127.0.0.1:43200',
      ),
    ).toBeUndefined();
  });
});
