import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { z } from 'zod';
import { allocateFreePortBlock } from '../../src-server/runtime/bootstrap/allocate-port-block.js';
import { loadSelfHostedBrokerConnectorConfig } from '../../src-server/runtime/bootstrap/self-hosted-connector-config.js';
import { ConnectionSigningKeyStore } from '../../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';

const NATIVE_FRESH_PUBLIC_BROKER = 'https://relay-test.kontourai.com';
const NATIVE_FRESH_LIFETIME_MS = 30 * 60 * 1000;
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const origin = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value);
const scope = z
  .object({
    stationId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    routingGeneration: z.literal(1),
    browserOrigin: origin,
  })
  .strict();
const signing = z
  .object({
    stationId: z.string().uuid(),
    enrollmentId: z.string().uuid(),
    generation: z.number().int().positive(),
    signingKey: z
      .object({
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: opaque,
        y: opaque,
      })
      .strict(),
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal('station-native-fresh-fixture/v1'),
    runId: z.string().uuid(),
    directory: z.string(),
    port: z.number().int().min(1025).max(65532),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    brokerOrigin: z.literal(NATIVE_FRESH_PUBLIC_BROKER),
    applicationOrigin: origin,
    scope,
    stationTrust: signing,
    lifetimeMs: z.literal(NATIVE_FRESH_LIFETIME_MS),
  })
  .strict();
export type NativeFreshFixturePlan = z.infer<typeof planSchema>;

/** Private regular files only; authority is never recovered from public stdout. */
export function readNativeFreshPrivateJson(path: string): unknown {
  assert(isAbsolute(path) && resolve(path) === path, 'fixture_path_invalid');
  const parent = lstatSync(dirname(path));
  const link = lstatSync(path);
  assert(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === process.getuid?.() &&
      (parent.mode & 0o077) === 0,
    'fixture_private_parent_required',
  );
  assert(
    link.isFile() &&
      !link.isSymbolicLink() &&
      link.nlink === 1 &&
      link.uid === process.getuid?.() &&
      (link.mode & 0o077) === 0 &&
      link.size <= 65536,
    'fixture_private_file_required',
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert(
      opened.dev === link.dev &&
        opened.ino === link.ino &&
        opened.isFile() &&
        opened.nlink === 1 &&
        opened.uid === process.getuid?.() &&
        (opened.mode & 0o077) === 0 &&
        opened.size <= 65536,
      'fixture_private_file_changed',
    );
    const bytes = Buffer.alloc(65537);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
      assert(size <= 65536, 'fixture_private_file_too_large');
    }
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export function loadNativeFreshFixturePlan(
  path: string,
): NativeFreshFixturePlan {
  const plan = planSchema.parse(readNativeFreshPrivateJson(path));
  assert(
    isAbsolute(plan.directory) &&
      resolve(plan.directory) === plan.directory &&
      dirname(path) === plan.directory,
    'fixture_owner_path_mismatch',
  );
  assert(
    ![3000, 3141].some((port) => port >= plan.port && port < plan.port + 4),
    'fixture_user_port_refused',
  );
  assert(
    plan.scope.stationId === plan.stationTrust.stationId &&
      plan.scope.enrollmentId === plan.stationTrust.enrollmentId &&
      plan.scope.browserOrigin === plan.applicationOrigin,
    'fixture_scope_mismatch',
  );
  return Object.freeze(plan);
}

export async function prepareNativeFreshFixture(
  directory: string,
  sourceRevision: string,
) {
  assert(
    isAbsolute(directory) && resolve(directory) === directory,
    'fixture_path_invalid',
  );
  mkdirSync(directory, { mode: 0o700 });
  assert(readdirSync(directory).length === 0, 'fixture_new_directory_required');
  const home = join(directory, 'home');
  mkdirSync(home, { mode: 0o700 });
  ensureStationHomeSchemaSync(home);
  const security = new EnvironmentSecurityService({ homeDir: home });
  const identity = await security.initialize();
  const stationTrust = await new ConnectionSigningKeyStore(home).initialize();
  assert(identity.environmentId === stationTrust.stationId);
  assert.equal(security.devicePairing.listDevices().length, 0);
  const runId = randomUUID();
  const applicationOrigin = `https://native-fixture-${runId}.invalid`;
  const plan = planSchema.parse({
    version: 'station-native-fresh-fixture/v1',
    runId,
    directory,
    sourceRevision,
    port: await allocateFreePortBlock('127.0.0.1'),
    brokerOrigin: NATIVE_FRESH_PUBLIC_BROKER,
    applicationOrigin,
    scope: {
      stationId: stationTrust.stationId,
      enrollmentId: stationTrust.enrollmentId,
      routingGeneration: 1,
      browserOrigin: applicationOrigin,
    },
    stationTrust,
    lifetimeMs: NATIVE_FRESH_LIFETIME_MS,
  });
  assert(
    ![3000, 3141].some((port) => port >= plan.port && port < plan.port + 4),
  );
  writeFileSync(
    join(directory, 'operator.json'),
    JSON.stringify({ credential: identity.credential }),
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan), {
    mode: 0o600,
    flag: 'wx',
  });
  return plan;
}

export function nativeFreshFixtureEnvironment(
  plan: NativeFreshFixturePlan,
  connectorPath: string,
) {
  assert(
    dirname(connectorPath) === plan.directory,
    'fixture_connector_path_mismatch',
  );
  const config = z
    .object({
      version: z.literal('station-self-hosted-connector/v1'),
      brokerOrigin: z.literal(plan.brokerOrigin),
      applicationOrigin: z.literal(plan.applicationOrigin),
      nativeClient: z
        .object({
          kind: z.literal('station-native-registry'),
          maxPeers: z.number().int().min(1).max(4).optional(),
        })
        .strict(),
      turn: z.object({ source: z.literal('broker') }).strict(),
      credentialsPath: z.string(),
      pionExecutable: z.string(),
      certificatePath: z.string(),
      privateKeyPath: z.string(),
      maxPeers: z.number().int().min(1).max(4),
      maxPeerLifetimeMs: z.literal(120000),
    })
    .strict()
    .parse(readNativeFreshPrivateJson(connectorPath));
  for (const path of [
    config.credentialsPath,
    config.pionExecutable,
    config.certificatePath,
    config.privateKeyPath,
  ])
    assert(
      dirname(path) === plan.directory && isAbsolute(path),
      'fixture_resource_owner_mismatch',
    );
  const credentials = z
    .object({
      version: z.literal('station-self-hosted-broker-credentials/v1'),
      scope,
      bundle: z.unknown(),
    })
    .strict()
    .parse(readNativeFreshPrivateJson(config.credentialsPath));
  assert.deepEqual(
    credentials.scope,
    plan.scope,
    'fixture_credentials_scope_mismatch',
  );
  const artifact = z
    .object({
      version: z.literal('station-native-pion-artifact/v1'),
      sourceRevision: z.literal(plan.sourceRevision),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .parse(
      readNativeFreshPrivateJson(join(plan.directory, 'pion-artifact.json')),
    );
  const executableInfo = lstatSync(config.pionExecutable);
  assert(
    executableInfo.size <= 128 * 1024 * 1024 &&
      executableInfo.nlink === 1 &&
      executableInfo.isFile() &&
      !executableInfo.isSymbolicLink() &&
      executableInfo.uid === process.getuid?.() &&
      (executableInfo.mode & 0o077) === 0 &&
      (executableInfo.mode & 0o100) !== 0,
    'fixture_pion_private_executable_required',
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(config.pionExecutable))
      .digest('hex'),
    artifact.sha256,
    'fixture_pion_digest_mismatch',
  );
  const home = join(plan.directory, 'home');
  const liveTrust = new ConnectionSigningKeyStore(home).readDescriptor();
  assert.deepEqual(
    liveTrust,
    plan.stationTrust,
    'fixture_station_trust_changed',
  );
  const env = {
    STATION_HOME: home,
    STATION_ROOT: join(plan.directory, 'station-root'),
    STATION_HOST: '127.0.0.1',
    PORT: String(plan.port),
    STATION_INSTANCE: `relay-native-fresh-${plan.runId}`,
    STATION_INSTANCE_ID: `relay-native-fresh-${plan.runId}`,
    STATION_BOOT_ID: randomUUID(),
    STATION_BUILD_SHA: plan.sourceRevision,
    STATION_STDOUT_HANDSHAKE: '1',
    STATION_LOCAL_ACCOUNTS: '1',
    STATION_PROJECT_SHARING: '1',
    STATION_NATIVE_DEVICE_PROOF_PILOT: '1',
    STATION_NATIVE_ENROLLMENT_PILOT: '1',
    STATION_AUTHENTICATION_ORIGIN: plan.applicationOrigin,
    STATION_AUTHENTICATION_BROWSER_ORIGINS: `${plan.applicationOrigin},http://127.0.0.1:${plan.port}`,
    ALLOWED_ORIGINS: `${plan.applicationOrigin},http://127.0.0.1:${plan.port}`,
    STATION_BROKER_CONFIG_FILE: connectorPath,
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  assert(
    loadSelfHostedBrokerConnectorConfig({ homeDir: home, env }),
    'fixture_connector_unavailable',
  );
  return env;
}

/** Disposable child diagnostic guard; Pion's native networking is separately constrained by its relay configuration. */
export function installNativeFreshNodeNetworkGuard(
  plan: NativeFreshFixturePlan,
) {
  const original = Socket.prototype.connect;
  Socket.prototype.connect = new Proxy(original, {
    apply(target, receiver, input: unknown[]) {
      const args: unknown[] = Array.isArray(input[0]) ? input[0] : input;
      const first = args[0];
      const options =
        first && typeof first === 'object'
          ? z
              .object({
                host: z.string().optional(),
                hostname: z.string().optional(),
                port: z.union([z.string(), z.number()]),
                path: z.unknown().optional(),
              })
              .passthrough()
              .parse(first)
          : {
              port: first,
              host: typeof args[1] === 'string' ? args[1] : 'localhost',
              path: undefined,
              hostname: undefined,
            };
      const host = options.host ?? options.hostname ?? 'localhost';
      const port = Number(options.port);
      assert(
        !options.path &&
          ((host === 'relay-test.kontourai.com' && port === 443) ||
            (['127.0.0.1', 'localhost', '::1'].includes(host) &&
              port >= plan.port &&
              port < plan.port + 4)),
        'fixture_node_destination_refused',
      );
      return Reflect.apply(target, receiver, input);
    },
  });
}

async function boundedJson(response: Response) {
  assert(response.body, 'fixture_response_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      assert(size <= 65536, 'fixture_response_too_large');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  assert(response.ok, `fixture_http_refused_${response.status}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function nativeFreshOperatorRequest(
  plan: NativeFreshFixturePlan,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
) {
  assert(
    path.startsWith('/api/') &&
      !path.includes('?') &&
      !path.includes('#') &&
      !path.includes('\\'),
    'fixture_operator_path_refused',
  );
  const operator = z
    .object({ credential: opaque })
    .strict()
    .parse(readNativeFreshPrivateJson(join(plan.directory, 'operator.json')));
  return boundedJson(
    await fetch(`http://127.0.0.1:${plan.port}${path}`, {
      method,
      headers: {
        Origin: `http://127.0.0.1:${plan.port}`,
        Authorization: `Bearer ${operator.credential}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }),
  );
}

/** Exact owned scope only; already-issued TURN credentials are TTL-bound, not declared remotely revoked. */
export async function cleanupNativeFreshBrokerGrants(
  plan: NativeFreshFixturePlan,
) {
  const cleanupSignal = AbortSignal.timeout(20000);
  const credential = z
    .object({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/u), secret: opaque })
    .strict();
  const bundle = z
    .object({
      version: z.literal('station-self-hosted-broker-credentials/v1'),
      scope,
      bundle: z.object({ connector: credential, routing: credential }).strict(),
    })
    .strict()
    .parse(
      readNativeFreshPrivateJson(
        join(plan.directory, 'broker-credentials.json'),
      ),
    );
  assert.deepEqual(bundle.scope, plan.scope);
  const post = async (
    path: '/native/grants/list' | '/native/grants/revoke',
    extra: Record<string, unknown> = {},
  ) =>
    boundedJson(
      await fetch(`${plan.brokerOrigin}/broker/v1${path}`, {
        method: 'POST',
        headers: {
          Origin: plan.applicationOrigin,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bundle.bundle.routing.secret}`,
          'X-Broker-Credential-Id': bundle.bundle.routing.id,
        },
        body: JSON.stringify({ scope: plan.scope, ...extra }),
        redirect: 'error',
        signal: cleanupSignal,
      }),
    );
  const grants = z
    .array(
      z
        .object({
          grantId: z.string().min(1).max(128),
          revokedAt: z.number().nullable(),
          expiresAt: z.number(),
        })
        .passthrough(),
    )
    .max(256)
    .parse(await post('/native/grants/list'));
  for (const grant of grants.filter(
    (value) => value.revokedAt === null && value.expiresAt > Date.now(),
  ))
    z.object({ revoked: z.literal(true) })
      .strict()
      .parse(await post('/native/grants/revoke', { grantId: grant.grantId }));
  return {
    runId: plan.runId,
    nativeRoutingGrantsRevoked: true,
    outstandingTurnCredentialsExpireNoLaterThan: Date.now() + 600000,
  };
}
