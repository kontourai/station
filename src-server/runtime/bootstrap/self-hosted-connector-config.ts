import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeRouteInvitationV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { stationConnectionSigningKeyId } from '@kontourai/station-shared/connection-proof';
import { calculateJwkThumbprint, importJWK } from 'jose';
import { SelfHostedBrokerClient } from '../../services/connections/self-hosted-broker-client.js';
import type { VirtualApplication } from '../../services/connections/virtual-application.js';
import { ConnectionKeyCandidateIssuer } from '../../services/ssh/connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../../services/ssh/connection-signing-key-store.js';
import { createSelfHostedBrokerPionRuntime } from './self-hosted-broker-pion-runtime.js';
import type {
  SelfHostedBrokerRuntime,
  SelfHostedBrokerStatus,
} from './self-hosted-broker-runtime.js';
import type { StationRuntimeOptions } from './station-runtime.js';

/**
 * Optional self-hosted relay connector startup wiring.
 *
 * Normal entrypoint opt-in only: `STATION_BROKER_CONFIG_FILE` carries ONLY an
 * absolute config path. No config means no broker, key, binary, or network
 * activity and unchanged default behavior. The loader performs readonly
 * private config reads before runtime construction; the returned factory
 * starts actual network/cleanup work only after normal protected runtime
 * activation, through the StationRuntime-owned connector lifecycle.
 */

const SELF_HOSTED_CONNECTOR_CONFIG_ENV = 'STATION_BROKER_CONFIG_FILE';
const SELF_HOSTED_CONNECTOR_CONFIG_VERSION =
  'station-self-hosted-connector/v1' as const;
const SELF_HOSTED_CONNECTOR_CREDENTIALS_VERSION =
  'station-self-hosted-broker-credentials/v1' as const;

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REF_BYTES = 64 * 1024;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{22}$/;
const CREDENTIAL_SECRET = /^[A-Za-z0-9_-]{43}$/;

interface SelfHostedConnectorFactory {
  readonly applicationOrigin: string;
  /** Local operator only. No credential or runtime handle crosses this seam. */
  issueNativeInvitation(
    prepare: unknown,
    signal: AbortSignal,
  ): Promise<SelfHostedBrokerNativeRouteInvitationV2>;
  /** Typed StationRuntimeOptions entries: spread both into normal
   * StationRuntime construction. The runtime owns the broker lifecycle
   * (awaited start, bounded shutdown); the entrypoint performs no
   * fire-and-forget start and keeps no separate broker handle. */
  readonly virtualApplication: NonNullable<
    StationRuntimeOptions['virtualApplication']
  >;
  readonly selfHostedBrokerConnector: NonNullable<
    StationRuntimeOptions['selfHostedBrokerConnector']
  >;
}

function fail(code: string): never {
  throw new Error(code);
}

interface ConnectorTrustOwner {
  current(): ApprovedStationConnectionTrust | null;
  isCurrent(value: ApprovedStationConnectionTrust): boolean;
}

/** Owner-bound live descriptor reads: full current-descriptor semantics
 * after async boundaries, never reference identity. A changed key fails
 * closed. Exported for focused tests; production use goes through the
 * loader factory. */
export function createConnectorTrustOwner(
  homeDir: string,
): ConnectorTrustOwner {
  const store = new ConnectionSigningKeyStore(homeDir);
  return {
    current: (): ApprovedStationConnectionTrust | null => {
      try {
        return store.readDescriptor();
      } catch {
        return null;
      }
    },
    isCurrent: (value: ApprovedStationConnectionTrust): boolean => {
      let live: ApprovedStationConnectionTrust | null;
      try {
        live = store.readDescriptor();
      } catch {
        return false;
      }
      return sameDescriptor(live, value);
    },
  };
}

function assertPrivateCustody(): void {
  if (process.platform === 'win32')
    fail('connector_config_custody_unsupported_on_windows');
  if (process.getuid === undefined)
    fail('connector_config_custody_unavailable');
}

/** Bounded nofollow read of a private regular file; never logs contents. */
function readPrivateFile(path: string, maxBytes: number, code: string): Buffer {
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch {
    fail(code);
  }
  if (!link!.isFile() || link!.isSymbolicLink() || link!.nlink !== 1)
    fail(code);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.size > maxBytes ||
      status.dev !== link.dev ||
      status.ino !== link.ino ||
      status.uid !== process.getuid!() ||
      (status.mode & 0o077) !== 0
    )
      fail(code);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) fail(code);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('connector_config_'))
      throw error;
    return fail(code);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Close failures carry no path or contents; custody already verified.
      }
    }
  }
}

function assertPrivateParent(path: string, code: string): void {
  let parent: Stats;
  try {
    parent = lstatSync(dirname(path));
  } catch {
    fail(code);
  }
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid!() ||
    (parent.mode & 0o077) !== 0
  )
    fail(code);
}

function canonicalOrigin(value: unknown, code: string): string {
  if (typeof value !== 'string') fail(code);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    fail(code);
  }
  const loopback =
    url!.hostname === '127.0.0.1' ||
    url!.hostname === '[::1]' ||
    url!.hostname === 'localhost';
  if (
    url!.origin !== value ||
    url!.pathname !== '/' ||
    url!.search !== '' ||
    url!.hash !== '' ||
    !(url!.protocol === 'https:' || (url!.protocol === 'http:' && loopback))
  )
    fail(code);
  return value as string;
}

function assertAbsoluteRef(value: unknown, code: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    fail(code);
  return value as string;
}

function sameDescriptor(
  live: ApprovedStationConnectionTrust | null,
  value: ApprovedStationConnectionTrust,
): boolean {
  return (
    live !== null &&
    live.stationId === value.stationId &&
    live.enrollmentId === value.enrollmentId &&
    live.generation === value.generation &&
    live.signingKey.kty === value.signingKey.kty &&
    live.signingKey.crv === value.signingKey.crv &&
    live.signingKey.x === value.signingKey.x &&
    live.signingKey.y === value.signingKey.y
  );
}

interface ValidatedRef {
  path: string;
  bytes: Buffer;
}

function loadPrivateRef(path: string, code: string): ValidatedRef {
  assertAbsoluteRef(path, code);
  assertPrivateParent(path, 'connector_config_parent_untrusted');
  return { path, bytes: readPrivateFile(path, MAX_REF_BYTES, code) };
}

async function nativePrepareSurface(
  value: unknown,
  brokerOrigin: string,
  stationId: string,
  enrollmentId: string,
): Promise<SelfHostedBrokerNativeClientSurfaceV2> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('connector_native_prepare_invalid');
  const p = value as Record<string, unknown>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    Object.keys(p).sort().join(',') !==
      'appIdentifier,brokerOrigin,channel,clientInstanceId,enrollmentId,keyThumbprint,profileName,publicKey,stationId' ||
    typeof p.profileName !== 'string' ||
    !p.profileName ||
    p.profileName.length > 256 ||
    p.brokerOrigin !== brokerOrigin ||
    p.stationId !== stationId ||
    p.enrollmentId !== enrollmentId ||
    typeof p.appIdentifier !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(p.appIdentifier) ||
    !['dev', 'stable', 'beta', 'nightly'].includes(p.channel as string) ||
    typeof p.clientInstanceId !== 'string' ||
    !uuid.test(p.clientInstanceId) ||
    typeof p.keyThumbprint !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.keyThumbprint) ||
    !p.publicKey ||
    typeof p.publicKey !== 'object' ||
    Array.isArray(p.publicKey)
  )
    fail('connector_native_prepare_invalid');
  const key = p.publicKey as Record<string, unknown>;
  if (
    Object.keys(key).sort().join(',') !== 'crv,kty,x,y' ||
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y)
  )
    fail('connector_native_prepare_invalid');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: key.x as string,
    y: key.y as string,
  };
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: p.appIdentifier as string,
    channel: p.channel as SelfHostedBrokerNativeClientSurfaceV2['channel'],
    clientInstanceId: p.clientInstanceId as string,
    keyThumbprint: p.keyThumbprint as string,
  };
  try {
    await importJWK(jwk, 'ES256');
    if ((await calculateJwkThumbprint(jwk)) !== surface.keyThumbprint)
      fail('connector_native_prepare_invalid');
  } catch {
    fail('connector_native_prepare_invalid');
  }
  return surface;
}

export function loadSelfHostedBrokerConnectorConfig(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  observeStatus?: (status: SelfHostedBrokerStatus) => void;
}): SelfHostedConnectorFactory | null {
  const env = options?.env ?? process.env;
  const configPath = env[SELF_HOSTED_CONNECTOR_CONFIG_ENV];
  if (!configPath) return null;
  assertPrivateCustody();
  if (!isAbsolute(configPath) || configPath.includes('\0'))
    fail('connector_config_path_not_absolute');
  assertPrivateParent(configPath, 'connector_config_parent_untrusted');
  let raw: unknown;
  try {
    raw = JSON.parse(
      readPrivateFile(
        configPath,
        MAX_CONFIG_BYTES,
        'connector_config_unreadable',
      ).toString('utf8'),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('connector_config_'))
      throw error;
    fail('connector_config_invalid');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('connector_config_invalid');
  const config = raw as Record<string, unknown>;
  const allowed = new Set([
    'applicationOrigin',
    'brokerOrigin',
    'certificatePath',
    'credentialsPath',
    'maxPeerLifetimeMs',
    'maxPeers',
    'pionExecutable',
    'privateKeyPath',
    'turn',
    'version',
  ]);
  const required = [
    'applicationOrigin',
    'brokerOrigin',
    'certificatePath',
    'credentialsPath',
    'pionExecutable',
    'privateKeyPath',
    'turn',
    'version',
  ];
  if (
    config.version !== SELF_HOSTED_CONNECTOR_CONFIG_VERSION ||
    !required.every((key) => key in config) ||
    !Object.keys(config).every((key) => allowed.has(key))
  )
    fail('connector_config_invalid');
  const brokerOrigin = canonicalOrigin(
    config.brokerOrigin,
    'connector_config_origin_invalid',
  );
  // Explicit application target; never substituted from browserOrigin/brokerOrigin.
  const applicationOrigin = canonicalOrigin(
    config.applicationOrigin,
    'connector_config_origin_invalid',
  );
  const maxPeers =
    config.maxPeers === undefined ? 8 : (config.maxPeers as number);
  const maxPeerLifetimeMs =
    config.maxPeerLifetimeMs === undefined
      ? 300_000
      : (config.maxPeerLifetimeMs as number);
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1 || maxPeers > 32)
    fail('connector_config_peer_limit_invalid');
  if (
    !Number.isSafeInteger(maxPeerLifetimeMs) ||
    maxPeerLifetimeMs < 1_000 ||
    maxPeerLifetimeMs > 86_400_000
  )
    fail('connector_config_peer_lifetime_invalid');
  const turn = config.turn as Record<string, unknown>;
  if (
    !turn ||
    typeof turn !== 'object' ||
    Array.isArray(turn) ||
    Object.keys(turn).sort().join(',') !== 'password,url,username' ||
    typeof turn.url !== 'string' ||
    turn.url.length === 0 ||
    turn.url.length > 4096 ||
    !(turn.url.startsWith('turn:') || turn.url.startsWith('turns:')) ||
    typeof turn.username !== 'string' ||
    turn.username.length === 0 ||
    turn.username.length > 512 ||
    typeof turn.password !== 'string' ||
    turn.password.length === 0 ||
    turn.password.length > 1024
  )
    fail('connector_config_turn_invalid');

  const credentialsRef = loadPrivateRef(
    config.credentialsPath as string,
    'connector_config_credentials_unreadable',
  );
  let credentials: unknown;
  try {
    credentials = JSON.parse(credentialsRef.bytes.toString('utf8'));
  } catch {
    fail('connector_config_credentials_invalid');
  }
  if (
    !credentials ||
    typeof credentials !== 'object' ||
    Array.isArray(credentials) ||
    Object.keys(credentials as Record<string, unknown>)
      .sort()
      .join(',') !== 'bundle,scope,version'
  )
    fail('connector_config_credentials_invalid');
  const record = credentials as {
    version: unknown;
    scope: unknown;
    bundle: unknown;
  };
  if (record.version !== SELF_HOSTED_CONNECTOR_CREDENTIALS_VERSION)
    fail('connector_config_credentials_version');
  const bundle = record.bundle as Record<string, unknown>;
  const credentialShape = (
    value: unknown,
  ): value is { id: string; secret: string } => {
    const candidate = value as Record<string, unknown>;
    return (
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(candidate).sort().join(',') === 'id,secret' &&
      typeof candidate.id === 'string' &&
      CREDENTIAL_ID.test(candidate.id) &&
      typeof candidate.secret === 'string' &&
      CREDENTIAL_SECRET.test(candidate.secret)
    );
  };
  if (
    !bundle ||
    typeof bundle !== 'object' ||
    Object.keys(bundle).sort().join(',') !== 'connector,routing' ||
    !credentialShape(bundle.connector) ||
    !credentialShape(bundle.routing)
  )
    fail('connector_config_credentials_invalid');
  const scope = record.scope as Record<string, unknown>;
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).sort().join(',') !==
      'browserOrigin,enrollmentId,routingGeneration,stationId' ||
    typeof scope.stationId !== 'string' ||
    typeof scope.enrollmentId !== 'string' ||
    !Number.isSafeInteger(scope.routingGeneration) ||
    (scope.routingGeneration as number) < 1
  )
    fail('connector_config_scope_invalid');
  // Routing generation is independent from signing generation: never compared.
  canonicalOrigin(scope.browserOrigin, 'connector_config_scope_invalid');

  const homeDir = options?.homeDir;
  if (!homeDir || !isAbsolute(homeDir)) fail('connector_config_home_invalid');
  // Readonly descriptor check before construction: exact Station/enrollment
  // match, current key only. A changed key fails closed via isCurrent below.
  const store = new ConnectionSigningKeyStore(homeDir);
  let descriptor: ApprovedStationConnectionTrust | null;
  try {
    descriptor = store.readDescriptor();
  } catch {
    fail('connector_config_signing_unavailable');
  }
  if (
    !descriptor ||
    descriptor.stationId !== scope.stationId ||
    descriptor.enrollmentId !== scope.enrollmentId
  )
    fail('connector_config_scope_mismatch');

  const certificateRef = loadPrivateRef(
    config.certificatePath as string,
    'connector_config_certificate_unreadable',
  );
  const keyRef = loadPrivateRef(
    config.privateKeyPath as string,
    'connector_config_key_unreadable',
  );
  try {
    const certificate = new X509Certificate(certificateRef.bytes);
    const privateKey = createPrivateKey(keyRef.bytes);
    const certKey = Buffer.from(
      certificate.publicKey.export({ format: 'der', type: 'spki' }),
    );
    const derived = Buffer.from(
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
    );
    if (certKey.length !== derived.length || !certKey.equals(derived))
      fail('connector_config_cert_mismatch');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('connector_config_'))
      throw error;
    fail('connector_config_cert_invalid');
  }

  const executable = assertAbsoluteRef(
    config.pionExecutable,
    'connector_config_executable_invalid',
  );
  // Installed binaries may be root-owned and immutable under a managed
  // prefix; custody requires current-user or root ownership, regular file,
  // executable, and never group/world writable. The parent dir check below
  // stays private-current-user only for secrets; an installed root-owned
  // binary keeps its managed parent without a 0700 requirement.
  let exe: Stats;
  try {
    exe = lstatSync(executable);
  } catch {
    fail('connector_config_executable_untrusted');
  }
  const exeUid = exe!.uid;
  const me = process.getuid!();
  if (
    !exe!.isFile() ||
    exe!.isSymbolicLink() ||
    exe!.nlink !== 1 ||
    !(exeUid === me || exeUid === 0) ||
    (exe!.mode & 0o022) !== 0 ||
    (exe!.mode & 0o111) === 0
  )
    fail('connector_config_executable_untrusted');

  // Snapshot all scalar config and owner references; the factory closure reads
  // only these locals, never mutable inputs.
  const snapshot = Object.freeze({
    brokerOrigin,
    applicationOrigin,
    scope: Object.freeze({
      stationId: scope.stationId as string,
      enrollmentId: scope.enrollmentId as string,
      routingGeneration: scope.routingGeneration as number,
      browserOrigin: scope.browserOrigin as string,
    }),
    connectorCredential: Object.freeze({
      ...(bundle.connector as { id: string; secret: string }),
    }),
    executable,
    certificatePem: certificateRef.bytes.toString('utf8'),
    privateKeyPem: keyRef.bytes.toString('utf8'),
    turn: Object.freeze({
      url: turn.url as string,
      username: turn.username as string,
      password: turn.password as string,
    }),
    maxPeers,
    maxPeerLifetimeMs,
    homeDir,
  });

  const routingClient = new SelfHostedBrokerClient(
    brokerOrigin,
    snapshot.scope,
    bundle.routing as { id: string; secret: string },
  );
  const trustOwner = createConnectorTrustOwner(homeDir);
  return {
    applicationOrigin: snapshot.applicationOrigin,
    async issueNativeInvitation(prepare, signal) {
      signal.throwIfAborted();
      const trust = trustOwner.current();
      if (
        !trust ||
        trust.stationId !== snapshot.scope.stationId ||
        trust.enrollmentId !== snapshot.scope.enrollmentId
      )
        fail('connector_config_signing_unavailable');
      const surface = await nativePrepareSurface(
        prepare,
        brokerOrigin,
        trust.stationId,
        trust.enrollmentId,
      );
      const signingKeyId = await stationConnectionSigningKeyId(trust);
      await routingClient.requireOnline(signal);
      if (!trustOwner.isCurrent(trust))
        fail('connector_config_signing_unavailable');
      const invitation = await routingClient.issueNativeInvitation(
        surface,
        signingKeyId,
        trust.generation,
        signal,
      );
      await routingClient.requireOnline(signal);
      if (!trustOwner.isCurrent(trust))
        fail('connector_config_signing_unavailable');
      signal.throwIfAborted();
      return invitation;
    },
    virtualApplication: {
      origin: snapshot.applicationOrigin,
      ready: () => {},
    },
    selfHostedBrokerConnector: {
      create: (application: VirtualApplication) =>
        factoryCreateRuntime(snapshot, application, options?.observeStatus),
    },
  };
}

function factoryCreateRuntime(
  snapshot: {
    brokerOrigin: string;
    applicationOrigin: string;
    scope: {
      stationId: string;
      enrollmentId: string;
      routingGeneration: number;
      browserOrigin: string;
    };
    connectorCredential: { id: string; secret: string };
    executable: string;
    certificatePem: string;
    privateKeyPem: string;
    turn: { url: string; username: string; password: string };
    maxPeers: number;
    maxPeerLifetimeMs: number;
    homeDir: string;
  },
  application: VirtualApplication,
  observeStatus?: (status: SelfHostedBrokerStatus) => void,
): SelfHostedBrokerRuntime {
  const store = new ConnectionSigningKeyStore(snapshot.homeDir);
  const trust = createConnectorTrustOwner(snapshot.homeDir);
  const issuer = store.createIssuer((binding) => {
    let live: ApprovedStationConnectionTrust | null;
    try {
      live = store.readDescriptor();
    } catch {
      return false;
    }
    return (
      !!live &&
      live.stationId === binding.stationId &&
      live.enrollmentId === binding.enrollmentId &&
      live.generation === binding.generation
    );
  });
  return createSelfHostedBrokerPionRuntime(
    {
      brokerOrigin: snapshot.brokerOrigin,
      applicationOrigin: snapshot.applicationOrigin,
      scope: { ...snapshot.scope },
      connectorCredential: { ...snapshot.connectorCredential },
      executable: snapshot.executable,
      certificatePem: snapshot.certificatePem,
      privateKeyPem: snapshot.privateKeyPem,
      turn: { ...snapshot.turn },
      trust,
      issuer,
      candidateIssuer: new ConnectionKeyCandidateIssuer(store),
      heartbeatMs: 5_000,
      renewMs: 10_000,
      pollMs: 1_000,
      maxPeerLifetimeMs: snapshot.maxPeerLifetimeMs,
      maxPeers: snapshot.maxPeers,
      observeStatus,
    },
    application,
  );
}
