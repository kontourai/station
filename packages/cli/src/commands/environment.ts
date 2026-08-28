import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import {
  decodeDevicePairingPayload,
  encodeDevicePairingPayload,
  exchangeDevicePairing,
  requestCurrentStationAccess,
} from '@kontourai/station-connect/device-pairing';
import type {
  DevicePairingOffer,
  StationProfileCredentialRef,
  StationProfileSetupSource,
} from '@kontourai/station-contracts';
import {
  buildStationProofMessage,
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import QRCode from 'qrcode';
import {
  activeLocalStationPath,
  readActiveLocalStation,
} from './active-local-station.js';
import {
  type ApiBaseSource,
  configureApiCredential,
  describeApiError,
  parseCoreArgs,
  printJson,
  type ResolvedApiBase,
  requestJson,
  requirePositional,
  resolveApiBase,
  resolveApiBaseDetailed,
  withRequestTimeout,
} from './core-api.js';
import { DEFAULT_SERVER_PORT } from './helpers.js';
import {
  collectPairingFlags,
  pairingBooleanFlag,
  pairingValueFlag,
} from './pairing-flags.js';
import {
  assertCredentialTransportAllowed,
  getProfileCredentialStore,
  newPairingCredentialRef,
  type ProfileCredentialStore,
} from './profile-credentials.js';
import {
  assertValidProfileName,
  findProfile,
  isCredentialRefReferenced,
  normalizeProfileEndpoint,
  readProfileStore,
  registerPairedProfile,
  selectPairedProfileAsDefault,
  suggestProfileName,
} from './profile-store.js';
import {
  resolveTailscaleOfferEndpoint,
  type TailscaleOfferDependencies,
  type TailscaleOfferEndpoint,
} from './tailscale-serve.js';

/** Injectable device-pairing dependencies (real implementations by default). */
export interface AccessRequestDependencies {
  requestAccess?: typeof requestCurrentStationAccess;
  exchangePairing?: typeof exchangeDevicePairing;
  credentialStore?: ProfileCredentialStore;
  /** Sleep between exchange polls; injected so tests advance instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms; injected so tests control the timeout budget. */
  now?: () => number;
  /** Local device hostname; injected for a deterministic default device name. */
  hostname?: () => string;
  /** Records paired secret-free saved Station metadata; injected for isolated tests. */
  registerProfile?: typeof registerPairedProfile;
  /** Creates the one immutable keyring ref owned by this pairing attempt. */
  createCredentialRef?: (environmentId: string) => StationProfileCredentialRef;
  /** Test seam for deterministic transaction interleavings. */
  beforeRegisterProfile?: () => Promise<void>;
}

/** Injectable host-offer dependencies; production always uses local process state. */
export interface EnvironmentOfferDependencies {
  readActiveLocalStation?: typeof readActiveLocalStation;
  renderQr?: (payload: string) => Promise<string>;
  tailscale?: TailscaleOfferDependencies;
}

/** Default seconds the requester waits for host approval before giving up. */
const DEFAULT_PAIRING_TIMEOUT_SECONDS = 300;
/** Seconds between exchange polls while a request is still pending. */
const PAIRING_POLL_INTERVAL_SECONDS = 2;
const ACCESS_REQUEST_FLAGS = [
  'api-base',
  'station',
  'device-name',
  'timeout',
  'force',
] as const;

export interface EnvironmentSecuritySnapshot {
  schemaVersion: number;
  environmentId: string;
  credential: string;
}

export interface EnvironmentSecurityServiceLike {
  initialize(): Promise<EnvironmentSecuritySnapshot>;
  /** Reads a saved Station's existing identity without bootstrapping its home. */
  readExistingRecord(): Promise<EnvironmentSecuritySnapshot>;
  rotateCredential(): Promise<EnvironmentSecuritySnapshot>;
  resetEnvironment(): Promise<EnvironmentSecuritySnapshot>;
}

export type EnvironmentSecurityServiceFactory = (
  projectHome: string,
) => EnvironmentSecurityServiceLike;

/**
 * station#1123 slice 2: the CLI-visible shape of `PeerCredentialStore`
 * (`src-server/services/peers/peer-credential-store.ts`) — declared locally,
 * never imported from `src-server`, matching how `EnvironmentSecurityServiceLike`
 * above keeps this publishable package decoupled from the server's real
 * implementation. `summaryLike.credential` is deliberately absent: the store
 * never returns the secret back out through `upsert`/`list`.
 */
export interface PeerCredentialSummaryLike {
  environmentId: string;
  apiBase: string;
  scope: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PeerCredentialStoreLike {
  list(): PeerCredentialSummaryLike[];
  upsert(input: {
    environmentId: string;
    apiBase: string;
    scope: string;
    credential: string;
    label?: string;
  }): Promise<PeerCredentialSummaryLike>;
  remove(environmentId: string): Promise<boolean>;
}

export type PeerCredentialStoreFactory = (
  projectHome: string,
) => PeerCredentialStoreLike;

/**
 * station#1123 slice 2 review fix (MEDIUM, PR #1178): the CLI-visible shape
 * of `SshEnvironmentProfileStore` (`src-server/services/ssh/ssh-environment-
 * profile-store.ts`), declared locally for the same decoupling reason as
 * {@link PeerCredentialStoreLike} above. Used ONLY to warn `peers add` when
 * the `environmentId` being provisioned already has an SSH profile —
 * `resolveTarget` (`station-control-delegation.ts`) tries SSH first and
 * only falls back to a peer credential when no SSH profile matches, so a
 * credential provisioned for an SSH-known environment would otherwise be
 * silently unenforced (and the request would keep going over the SSH
 * tunnel with no Authorization header at all — full loopback trust, MORE
 * privileged than whatever scope the operator thought they were granting).
 */
export interface SshEnvironmentProfileSummaryLike {
  environmentId: string | null;
}

export interface SshEnvironmentProfileStoreLike {
  initialize(): Promise<void>;
  list(): readonly SshEnvironmentProfileSummaryLike[];
}

export type SshEnvironmentProfileStoreFactory = (
  projectHome: string,
) => SshEnvironmentProfileStoreLike;

/**
 * Fetches JSON from an operator endpoint. The result is deliberately `unknown`:
 * this seam performs no validation, so it cannot honestly promise a caller's
 * chosen shape. Every call site parses the payload before use.
 */
type OperatorJsonRequest = (
  apiBase: string,
  path: string,
  init?: RequestInit,
) => Promise<unknown>;

interface EnvironmentCommandDependencies {
  createService?: EnvironmentSecurityServiceFactory;
  /** station#1123 slice 2: local operator-only peer-credential provisioning. */
  createPeerCredentialStore?: PeerCredentialStoreFactory;
  /**
   * station#1123 slice 2 review fix (MEDIUM): SSH-profile awareness for the
   * `peers add` precedence warning. Optional — when omitted (e.g. an older
   * test harness), the warning is simply skipped rather than the command
   * failing; `./station`'s real wiring always provides it.
   */
  createSshEnvironmentProfileStore?: SshEnvironmentProfileStoreFactory;
  projectHome: string;
  request?: OperatorJsonRequest;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  isInteractive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Device-pairing overrides for `environment access request` (tests only). */
  pairing?: AccessRequestDependencies;
  /** Host-pairing offer overrides for deterministic CLI tests. */
  offer?: EnvironmentOfferDependencies;
}

const USAGE = `Usage:
  station environment show
  station environment credential show
  station environment credential rotate [--force]
  station environment reset [--force]
  station environment access list [--api-base=<loopback-url>|--station=<name>]
  station environment access approve [<request-id-or-offer-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]
  station environment access deny [<request-id-or-offer-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]
  station environment access request --api-base=<host-url> [--station=<name>] [--device-name=<name>] [--timeout=<seconds>] [--force]
  station environment offer [--tailscale] [--tailscale-serve-port=<port>] [--payload-only] [--advertise-url=<url>]
  station environment hosts [--api-base=<url>]
  station environment list [--api-base=<url>]
  station environment show <id> [--api-base=<url>]
  station environment add --ssh=<host> --project=<remote-path> [--name=<name>] [--remote-port=<n>] [--managed] [--api-base=<url>]
  station environment connect <id> [--api-base=<url>]
  station environment stop <id> [--api-base=<url>]
  station environment remove <id> [--api-base=<url>]
  station environment peers list
  station environment peers add --environment-id=<id> --api-base=<peer-url> --credential=<token> --scope=<space-delimited-scope> [--label=<name>]
  station environment peers remove <environment-id>`;

function usageError(): Error {
  return new Error(USAGE);
}

async function confirmDestructiveAction(
  force: boolean,
  action: string,
  dependencies: EnvironmentCommandDependencies,
): Promise<boolean> {
  if (force) return true;
  if (!dependencies.isInteractive) {
    throw new Error(
      `${action} is destructive and requires --force when stdin is non-interactive.`,
    );
  }
  if (!dependencies.confirm) {
    throw new Error(`${action} requires an interactive confirmation handler.`);
  }
  return dependencies.confirm(`${action}. Continue?`);
}

/**
 * Runs local operator-only environment identity and credential lifecycle
 * commands. The service is injected so the publishable CLI package does not
 * own or duplicate the server's security persistence implementation.
 */
export async function runEnvironmentCommand(
  args: string[],
  dependencies: EnvironmentCommandDependencies,
): Promise<void> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  // Keep stderr injectable as part of the command's explicit no-secret I/O
  // boundary even though expected command paths currently do not write to it.
  void stderr;

  if (args.length === 1 && args[0] === 'show') {
    const service = requireSecurityService(dependencies);
    const snapshot = await service.initialize();
    stdout(
      JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        environmentId: snapshot.environmentId,
        credential: 'configured',
      }),
    );
    return;
  }

  if (args.length === 2 && args[0] === 'credential' && args[1] === 'show') {
    const service = requireSecurityService(dependencies);
    const snapshot = await service.initialize();
    stdout(snapshot.credential);
    return;
  }

  const isRotation =
    args[0] === 'credential' &&
    args[1] === 'rotate' &&
    args.slice(2).every((arg) => arg === '--force') &&
    args.filter((arg) => arg === '--force').length <= 1;
  if (isRotation) {
    const service = requireSecurityService(dependencies);
    const confirmed = await confirmDestructiveAction(
      args.includes('--force'),
      'Rotate the Station environment credential',
      dependencies,
    );
    if (!confirmed) {
      stdout('Cancelled.');
      return;
    }
    const snapshot = await service.rotateCredential();
    stdout(snapshot.credential);
    return;
  }

  const isReset =
    args[0] === 'reset' &&
    args.slice(1).every((arg) => arg === '--force') &&
    args.filter((arg) => arg === '--force').length <= 1;
  if (isReset) {
    const service = requireSecurityService(dependencies);
    const confirmed = await confirmDestructiveAction(
      args.includes('--force'),
      'Reset the Station environment identity and credential',
      dependencies,
    );
    if (!confirmed) {
      stdout('Cancelled.');
      return;
    }
    const snapshot = await service.resetEnvironment();
    stdout(
      JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        environmentId: snapshot.environmentId,
        credential: 'rotated',
      }),
    );
    return;
  }

  if (await runAccessRequestCommand(args, dependencies)) return;
  if (await runEnvironmentOfferCommand(args, dependencies)) return;
  if (await runLocalAccessCommand(args, dependencies)) return;
  if (await runPeerCredentialCommand(args, dependencies)) return;
  if (await runSshEnvironmentCommand(args)) return;

  throw usageError();
}

function parseDevicePairingOffer(value: unknown): DevicePairingOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Station returned an invalid device pairing offer.');
  }
  const offer = value as Partial<DevicePairingOffer>;
  if (
    typeof offer.protocolVersion !== 'number' ||
    typeof offer.environmentId !== 'string' ||
    typeof offer.offerId !== 'string' ||
    typeof offer.challenge !== 'string' ||
    typeof offer.endpoint !== 'string' ||
    typeof offer.scope !== 'string' ||
    typeof offer.expiresAt !== 'number'
  ) {
    throw new Error('Station returned an invalid device pairing offer.');
  }
  const payload = encodeDevicePairingPayload(offer as DevicePairingOffer);
  if (!decodeDevicePairingPayload(payload)) {
    throw new Error('Station returned an unusable device pairing offer.');
  }
  return offer as DevicePairingOffer;
}

async function renderTerminalQr(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'M',
  });
}

interface EnvironmentOfferInvocation {
  tailscale: boolean;
  tailscaleServePort?: number;
  payloadOnly: boolean;
  advertiseUrl?: string;
}

interface VerifiedLocalOfferHost {
  apiBase: string;
  snapshot: EnvironmentSecuritySnapshot;
  request: OperatorJsonRequest;
}

function parseEnvironmentOfferInvocation(
  args: string[],
): EnvironmentOfferInvocation | null {
  const normalizedArgs = normalizeEnvironmentArgsForParsing(args);
  const tailscaleFlags = normalizedArgs.filter(
    (arg) => arg === '--tailscale' || arg.startsWith('--tailscale='),
  );
  const servePortFlags = normalizedArgs.filter(
    (arg) =>
      arg === '--tailscale-serve-port' ||
      arg.startsWith('--tailscale-serve-port='),
  );
  if (tailscaleFlags.length > 1 || servePortFlags.length > 1) {
    throw usageError();
  }
  const parsed = parseCoreArgs(normalizedArgs);
  if (parsed.positionals[0] !== 'offer') return null;
  if (
    parsed.positionals.length !== 1 ||
    !allowedFlags(parsed.flags, [
      'tailscale',
      'tailscale-serve-port',
      'payload-only',
      'advertise-url',
    ]) ||
    (parsed.flags.tailscale !== undefined && parsed.flags.tailscale !== true) ||
    (parsed.flags['payload-only'] !== undefined &&
      parsed.flags['payload-only'] !== true)
  ) {
    throw usageError();
  }
  const advertiseUrl = parsed.flags['advertise-url'];
  const tailscaleServePort = parsed.flags['tailscale-serve-port'];
  if (
    tailscaleServePort !== undefined &&
    (!parsed.flags.tailscale ||
      typeof tailscaleServePort !== 'string' ||
      !/^[1-9][0-9]*$/.test(tailscaleServePort) ||
      !Number.isSafeInteger(Number(tailscaleServePort)) ||
      Number(tailscaleServePort) > 65535)
  ) {
    throw usageError();
  }
  if (advertiseUrl !== undefined) {
    if (
      typeof advertiseUrl !== 'string' ||
      new URL(advertiseUrl).origin !== advertiseUrl
    ) {
      throw usageError();
    }
  }
  return {
    tailscale: parsed.flags.tailscale === true,
    ...(tailscaleServePort !== undefined
      ? { tailscaleServePort: Number(tailscaleServePort) }
      : {}),
    payloadOnly: parsed.flags['payload-only'] === true,
    ...(advertiseUrl ? { advertiseUrl } : {}),
  };
}

/**
 * Resolve and authenticate the local listener before any publication change
 * or credential-bearing request. Keeping this phase whole makes the security
 * ordering structural rather than dependent on call-site interleaving.
 */
async function verifyLocalOfferHost(
  dependencies: EnvironmentCommandDependencies,
): Promise<VerifiedLocalOfferHost> {
  const activeLocal =
    dependencies.offer?.readActiveLocalStation ?? readActiveLocalStation;
  // The offer must discover the listener belonging to the resolved lifecycle
  // home, not whichever channel happened to be selected when this module was
  // loaded. Stable/beta installs deliberately have separate homes.
  const apiBase = activeLocal({
    path: activeLocalStationPath(dependencies.projectHome),
  });
  if (!apiBase || !isLoopbackApiBase(apiBase)) {
    throw new Error(
      'No running local Station was discovered. Start this Station first, then rerun `station environment offer` from its host.',
    );
  }

  const request = dependencies.request ?? requestBareJson;
  const snapshot = await requireSecurityService(dependencies).initialize();
  const handshake = await request(apiBase, '/.well-known/station/v1');
  if (
    !handshake ||
    typeof handshake !== 'object' ||
    Array.isArray(handshake) ||
    (handshake as { environmentId?: unknown }).environmentId !==
      snapshot.environmentId
  ) {
    throw new Error(
      'The discovered loopback listener does not match this Station home. Check STATION_HOME and restart the local Station before offering a pairing code.',
    );
  }

  const nonce = randomBytes(32).toString('base64url');
  const proof = await request(apiBase, PUBLIC_STATION_PROOF_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
      nonce,
    }),
  });
  if (!verifyLocalStationProof(snapshot, nonce, proof)) {
    throw new Error(
      'The loopback listener could not prove it owns this Station environment. No pairing offer was created and no credential was sent.',
    );
  }
  return { apiBase, snapshot, request };
}

async function resolveEnvironmentOfferPublication(
  invocation: EnvironmentOfferInvocation,
  host: VerifiedLocalOfferHost,
  dependencies: EnvironmentCommandDependencies,
): Promise<TailscaleOfferEndpoint | undefined> {
  if (!invocation.tailscale) return undefined;
  return resolveTailscaleOfferEndpoint({
    localApiBase: host.apiBase,
    environmentId: host.snapshot.environmentId,
    servePort: invocation.tailscaleServePort,
    dependencies: dependencies.offer?.tailscale,
  });
}

async function mintEnvironmentPairingOffer(
  host: VerifiedLocalOfferHost,
  publication: TailscaleOfferEndpoint | undefined,
  advertiseUrl?: string,
): Promise<DevicePairingOffer> {
  try {
    return parseDevicePairingOffer(
      await host.request(host.apiBase, '/api/pairing/offers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.snapshot.credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: advertiseUrl ?? publication?.endpoint ?? host.apiBase,
        }),
      }),
    );
  } catch (error) {
    if (publication?.configured) {
      throw new Error(
        `Pairing offer creation failed after Tailscale HTTPS Serve was configured. To undo this mapping, run \`tailscale serve --https=${new URL(publication.endpoint).port || '443'} off\`. ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

function formatEnvironmentOfferOutput(input: {
  offer: DevicePairingOffer;
  payload: string;
  qr: string;
  publication?: TailscaleOfferEndpoint;
}): string {
  const endpoint = new URL(input.offer.endpoint).origin;
  const expires = new Date(input.offer.expiresAt).toISOString();
  return [
    'Station device pairing offer',
    `Endpoint: ${endpoint}`,
    `Expires: ${expires}`,
    input.publication
      ? `Reachability: published privately on this tailnet as ${input.publication.endpoint}.`
      : 'Reachability: this offer uses loopback, so a phone cannot reach it directly. Use a reviewed reachable endpoint through the existing Connections UI.',
    'Payload (one-time pairing offer; scan or paste into Join):',
    input.payload,
    'Terminal QR:',
    input.qr,
    ...(input.publication
      ? [
          'Tailscale teardown (manual only; the offer expiry does not change Serve):',
          `  tailscale serve --https=${new URL(input.publication.endpoint).port || '443'} off`,
        ]
      : []),
  ].join('\n');
}

/**
 * Host-side pairing offer orchestrator. Discovery/proof, optional publication,
 * credential-bearing mint, and presentation remain separate phases so tests
 * can pin both their behavior and their security ordering.
 */
async function runEnvironmentOfferCommand(
  args: string[],
  dependencies: EnvironmentCommandDependencies,
): Promise<boolean> {
  const invocation = parseEnvironmentOfferInvocation(args);
  if (!invocation) return false;
  const host = await verifyLocalOfferHost(dependencies);
  const publication = await resolveEnvironmentOfferPublication(
    invocation,
    host,
    dependencies,
  );
  const offer = await mintEnvironmentPairingOffer(
    host,
    publication,
    invocation.advertiseUrl,
  );
  const payload = encodeDevicePairingPayload(offer);
  if (invocation.payloadOnly) {
    (dependencies.stdout ?? console.log)(payload);
    return true;
  }
  const renderQr = dependencies.offer?.renderQr ?? renderTerminalQr;
  const qr = await renderQr(payload);
  (dependencies.stdout ?? console.log)(
    formatEnvironmentOfferOutput({
      offer,
      payload,
      qr,
      publication,
    }),
  );
  return true;
}

/**
 * station#1123 slice 2 review fix (MEDIUM, PR #1178): `resolveTarget`
 * (`station-control-delegation.ts`) tries SSH first and only ever falls
 * back to the peer-credential store's own `'peer'`-kind resolution (a
 * different apiBase, a different connection) when NO SSH profile matches
 * the environmentId. This is a loud, non-blocking warning rather than a
 * hard refusal — SSH-then-peer precedence is a disclosed, deliberate
 * ordering (see `resolveTarget`'s own comment), and slice 8 is where that
 * ordering itself may change; provisioning ahead of that landing is
 * legitimate. Best-effort: skipped (never throws) when no SSH-store
 * factory is injected, or when the SSH-side lookup itself fails.
 *
 * station#1123 slice 3 update: the credential provisioned here is no
 * longer unenforced in this case. `connectSshTarget` now also fetches this
 * same store entry and attaches its `Authorization: Bearer` header to
 * requests over the SSH tunnel, so its scope IS what governs access there
 * (the credential requirement in `runtime-http.ts` is what makes that
 * enforceable). SSH precedence now means only "connection routing (the
 * apiBase/tunnel) comes from the SSH profile, not from this credential's
 * own `apiBase` field" — narrower than "not enforced at all", so the
 * message below is retargeted rather than removed.
 */
async function warnIfSshProfileTakesPrecedence(
  environmentId: string,
  dependencies: EnvironmentCommandDependencies,
  stderr: (value: string) => void,
): Promise<void> {
  if (!dependencies.createSshEnvironmentProfileStore) return;
  try {
    const sshStore = dependencies.createSshEnvironmentProfileStore(
      dependencies.projectHome,
    );
    await sshStore.initialize();
    const hasSshProfile = sshStore
      .list()
      .some((profile) => profile.environmentId === environmentId);
    if (hasSshProfile) {
      stderr(
        `Warning: environment '${environmentId}' already has a saved SSH profile. ` +
          "delegate_task connects via the SSH tunnel, not this credential's apiBase " +
          '— but the credential IS attached to and scope-enforced on that SSH-tunneled ' +
          'connection (station#1123 slice 3). Only the apiBase you set here is ignored ' +
          'while the SSH profile exists.',
      );
    }
  } catch {
    // Best-effort advisory only — never block provisioning on this check.
  }
}

/**
 * station#1123 slice 2: local operator-only peer-credential provisioning —
 * the same `EnvironmentSecurityServiceFactory` injection pattern `show`/
 * `credential rotate`/`reset` already use above, operating directly against
 * the server's home-directory JSON store (`PeerCredentialStore`). No new
 * HTTP route or `ConfigureRuntimeRoutesContext` wiring, and it works with
 * the server stopped, matching those existing local admin commands. Slice
 * 4's mutual pairing exchange protocol supersedes this manual path
 * entirely — do not build on top of it.
 */
async function runPeerCredentialCommand(
  args: string[],
  dependencies: EnvironmentCommandDependencies,
): Promise<boolean> {
  const parsed = parseCoreArgs(normalizeEnvironmentArgsForParsing(args));
  if (parsed.positionals[0] !== 'peers') return false;
  const action = parsed.positionals[1];
  if (!['list', 'add', 'remove'].includes(action ?? '')) {
    throw usageError();
  }
  if (!dependencies.createPeerCredentialStore) {
    throw new Error(
      'Peer credential commands require the Station repository launcher (./station).',
    );
  }
  const store = dependencies.createPeerCredentialStore(
    dependencies.projectHome,
  );
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;

  if (action === 'list') {
    if (
      parsed.positionals.length !== 2 ||
      Object.keys(parsed.flags).length > 0
    ) {
      throw usageError();
    }
    stdout(JSON.stringify({ peers: store.list() }));
    return true;
  }

  if (action === 'add') {
    if (
      parsed.positionals.length !== 2 ||
      !allowedFlags(parsed.flags, [
        'environment-id',
        'api-base',
        'credential',
        'scope',
        'label',
      ])
    ) {
      throw usageError();
    }
    const environmentId = requireValueFlag(parsed.flags, 'environment-id');
    await warnIfSshProfileTakesPrecedence(environmentId, dependencies, stderr);
    const record = await store.upsert({
      environmentId,
      apiBase: requireValueFlag(parsed.flags, 'api-base'),
      credential: requireValueFlag(parsed.flags, 'credential'),
      scope: requireValueFlag(parsed.flags, 'scope'),
      ...(typeof parsed.flags.label === 'string'
        ? { label: parsed.flags.label }
        : {}),
    });
    stdout(JSON.stringify(record));
    return true;
  }

  // action === 'remove'
  if (parsed.positionals.length !== 3 || Object.keys(parsed.flags).length > 0) {
    throw usageError();
  }
  const removed = await store.remove(parsed.positionals[2]);
  stdout(JSON.stringify({ removed }));
  return true;
}

interface PairingRequestView {
  requestId: string;
  // Optional: older Station builds and existing test fixtures may omit it.
  // When present it lets `access approve`/`access deny` accept either id
  // that `access list` prints.
  offerId?: string;
  deviceName: string;
  source: 'same-origin' | 'pairing-code' | 'tailnet';
  requester?: {
    provider: 'tailscale-serve';
    login: string;
    displayName?: string;
  };
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'confirmed' | 'denied';
}

async function requestBareJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(
    `${apiBase}${path}`,
    withRequestTimeout({ ...init, redirect: 'error' }),
  );
  let value: unknown;
  try {
    value = await readBoundedJson(response);
  } catch {
    throw new Error(
      response.ok
        ? 'Station returned a malformed JSON response.'
        : `Station request failed with HTTP ${response.status}.`,
    );
  }
  if (!response.ok) {
    throw new Error(describeBareJsonFailure(response.status, value));
  }
  return value as T;
}

/**
 * The local pairing routes intentionally use bare JSON rather than the
 * product's usual `{ success, data }` envelope. Preserve their explicit
 * server-side error when it is available: an operator approving a phone from
 * the host must be able to distinguish a rejected request from a server fault
 * without reproducing the command through curl. Keep arbitrary response data
 * out of the terminal; only the bounded string error is actionable here.
 */
function describeBareJsonFailure(status: number, value: unknown): string {
  const error =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { error?: unknown }).error
      : undefined;
  if (typeof error !== 'string' || error.trim().length === 0) {
    return `Station request failed with HTTP ${status}.`;
  }
  // `terminalSafeText` prevents a compromised/failed peer from writing
  // control or bidi characters into the approving host's terminal. Bound the
  // diagnostic too: the response reader caps bytes, but an all-text payload
  // would otherwise still consume an unhelpful amount of terminal output.
  return `Station request failed with HTTP ${status}: ${terminalSafeText(error).slice(0, 512)}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel();
      throw new Error('Response body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function terminalSafeText(value: string): string {
  return Array.from(value, (character) => {
    if (!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) return character;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    }
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  }).join('');
}

/**
 * station#4515 review M2: a handshake's `environmentId` comes from whatever
 * process answered on the resolved loopback port — attacker-controlled, not
 * a value this process minted. It gets interpolated into error text a
 * terminal renders, so it needs the same control/bidi stripping
 * `terminalSafeText` already applies to other untrusted strings this file
 * prints (device names, pairing error bodies), plus a length bound like
 * `describeBareJsonFailure`'s error-text cap — a hostile listener can return
 * an arbitrarily long string.
 */
function sanitizeUntrustedEnvironmentId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '(missing)';
  return terminalSafeText(value).slice(0, 128);
}

function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => terminalSafeText(character),
  );
}

function parsePairingRequest(value: unknown): PairingRequestView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Station returned an invalid device access request.');
  }
  const request = value as Partial<PairingRequestView>;
  if (
    typeof request.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId) ||
    (request.offerId !== undefined &&
      (typeof request.offerId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(request.offerId))) ||
    typeof request.deviceName !== 'string' ||
    request.deviceName.length === 0 ||
    request.deviceName.length > 64 ||
    !['same-origin', 'pairing-code', 'tailnet'].includes(
      request.source ?? '',
    ) ||
    !Number.isFinite(request.createdAt) ||
    !Number.isFinite(request.expiresAt) ||
    !['pending', 'confirmed', 'denied'].includes(request.status ?? '')
  ) {
    throw new Error('Station returned an invalid device access request.');
  }
  if (
    request.source === 'tailnet' &&
    (request.requester?.provider !== 'tailscale-serve' ||
      typeof request.requester.login !== 'string' ||
      request.requester.login.length === 0 ||
      request.requester.login.length > 254 ||
      (request.requester.displayName !== undefined &&
        (typeof request.requester.displayName !== 'string' ||
          request.requester.displayName.length === 0 ||
          request.requester.displayName.length > 128)))
  ) {
    throw new Error('Station returned an invalid device access request.');
  }
  if (request.source !== 'tailnet' && request.requester !== undefined) {
    throw new Error('Station returned an invalid device access request.');
  }
  return request as PairingRequestView;
}

function parsePairingRequestList(value: unknown): PairingRequestView[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Station returned an invalid device access request list.');
  }
  const requests = (value as { requests?: unknown }).requests;
  if (!Array.isArray(requests) || requests.length > 128) {
    throw new Error('Station returned an invalid device access request list.');
  }
  return requests.map(parsePairingRequest);
}

function verifyLocalStationProof(
  snapshot: EnvironmentSecuritySnapshot,
  nonce: string,
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (
    proof.protocolVersion !== STATION_PROOF_PROTOCOL_VERSION ||
    proof.environmentId !== snapshot.environmentId ||
    proof.nonce !== nonce ||
    typeof proof.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(proof.signature)
  ) {
    return false;
  }
  const expected = createHmac(
    'sha256',
    Buffer.from(snapshot.credential, 'base64url'),
  )
    .update(buildStationProofMessage(snapshot.environmentId, nonce))
    .digest();
  const received = Buffer.from(proof.signature, 'base64url');
  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}

function isLoopbackApiBase(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Human phrase for where a resolved target came from. `ResolvedApiBase
 * .source`/`printResolvedTarget` print the raw `ApiBaseSource` enum value
 * verbatim (e.g. `source=station-flag`) for diagnostics; this is an
 * independent, prose vocabulary for the error/confirmation text below, not a
 * mirror of that one.
 */
const API_BASE_SOURCE_LABEL: Record<ApiBaseSource, string> = {
  'api-base-flag': '--api-base',
  'station-flag': '--station',
  'station-env': 'STATION_TARGET',
  'project-station': 'project Station selection',
  'default-station': 'default Station',
  'active-local': 'active local Station',
  loopback: 'loopback fallback',
};

/**
 * station#4515 review M6: names what an approve/deny actually acted on — a
 * default-profile approve previously said only "device access for X?", never
 * naming the Station a script's `station stations use` or project selection
 * silently pointed it at.
 */
function describeResolvedTargetForHuman(resolved: ResolvedApiBase): string {
  // `API_BASE_SOURCE_LABEL` is typed as `Record<ApiBaseSource, string>`, so
  // every source this function can see is exhaustively covered at compile
  // time — no runtime fallback is reachable.
  const sourceLabel = API_BASE_SOURCE_LABEL[resolved.source];
  return resolved.station
    ? `Station "${resolved.station}" (${sourceLabel})`
    : `${resolved.apiBase} (${sourceLabel})`;
}

/**
 * station#4515 review L9: the direct-invocation remedy printed in an error
 * must not bake in `--force` as if scripted use were the only option — an
 * interactive shell gets a confirmation prompt instead. `list` needs neither
 * a request id nor a force guard at all.
 */
function suggestDirectAccessInvocation(
  action: string,
  apiBase: string,
): string {
  const base = `station environment access ${action} --api-base=${apiBase}`;
  if (action === 'list') return `${base}.`;
  return (
    `${base} <request-id>. Interactively this prompts for confirmation; ` +
    'pass --force only for non-interactive/scripted use.'
  );
}

function accessRequestLabel(request: PairingRequestView): string {
  const identity =
    request.source === 'tailnet' && request.requester
      ? `, verified Tailscale user ${JSON.stringify(
          terminalSafeText(
            request.requester.displayName ?? request.requester.login,
          ),
        )}`
      : '';
  return `${JSON.stringify(terminalSafeText(request.deviceName))} (${request.source}${identity})`;
}

/**
 * Formats a pairing request for `access list` output. Leads with the device
 * name and the requesting user's identity (when known) so an operator never
 * has to cross-reference an id to tell requests apart, then trails with the
 * ids and timing metadata needed to act on the request.
 */
function pairingRequestListEntry(
  request: PairingRequestView,
): Record<string, unknown> {
  const requestedBy =
    request.source === 'tailnet' && request.requester
      ? (request.requester.displayName ?? request.requester.login)
      : undefined;
  return {
    deviceName: request.deviceName,
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    status: request.status,
    source: request.source,
    requestId: request.requestId,
    ...(request.offerId !== undefined ? { offerId: request.offerId } : {}),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function allowedFlags(
  flags: Record<string, string | boolean>,
  names: readonly string[],
): boolean {
  return Object.keys(flags).every((name) => names.includes(name));
}

function pairingErrorSignal(error: unknown): {
  code?: string;
  status?: number;
} {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; status?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      status: typeof record.status === 'number' ? record.status : undefined,
    };
  }
  return {};
}

function defaultDeviceName(resolveHostname: () => string): string {
  const base = `${resolveHostname()} CLI`.trim() || 'Station CLI';
  return Array.from(base).slice(0, 64).join('');
}

export interface PairSavedStationInput {
  endpoint: string;
  name?: string;
  deviceName?: string;
  timeoutSeconds?: number;
  /** Re-pair an already credentialed binding. */
  force?: boolean;
  /** Setup's deliberate default-selection boundary. */
  makeDefault?: boolean;
  setupSource?: StationProfileSetupSource;
  /** `stations edit` or an explicit --force authorized a target replacement. */
  allowEndpointReplacement?: boolean;
}

export interface PairSavedStationDependencies
  extends AccessRequestDependencies {
  stdout?: (value: string) => void;
}

export interface PairSavedStationResult {
  profile: ReturnType<typeof registerPairedProfile>['profile'];
  alreadyPaired: boolean;
}

/**
 * The sole requester-side pairing transaction. It deliberately leaves the
 * current named binding alone until the host approves, the new immutable
 * keyring entry is durable, and one metadata commit succeeds.
 */
export async function pairSavedStation(
  input: PairSavedStationInput,
  dependencies: PairSavedStationDependencies = {},
): Promise<PairSavedStationResult> {
  const stdout = dependencies.stdout ?? console.log;
  const requestAccess =
    dependencies.requestAccess ?? requestCurrentStationAccess;
  const exchange = dependencies.exchangePairing ?? exchangeDevicePairing;
  const credentialStore =
    dependencies.credentialStore ?? getProfileCredentialStore();
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const resolveHostname = dependencies.hostname ?? hostname;
  const registerProfile = dependencies.registerProfile ?? registerPairedProfile;
  const createCredentialRef =
    dependencies.createCredentialRef ?? newPairingCredentialRef;
  const origin = normalizeProfileEndpoint(input.endpoint);
  assertCredentialTransportAllowed(origin);

  if (input.name !== undefined) assertValidProfileName(input.name);
  const deviceName = input.deviceName ?? defaultDeviceName(resolveHostname);
  if (deviceName.trim().length === 0 || deviceName.length > 64) {
    throw new Error('--device-name must be 1-64 characters.');
  }
  const timeoutSeconds =
    input.timeoutSeconds ?? DEFAULT_PAIRING_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout must be a positive whole number of seconds.');
  }
  const initialStore = readProfileStore();
  const initialProfile = input.name
    ? initialStore.profiles.find(
        (profile) => profile.name.toLowerCase() === input.name!.toLowerCase(),
      )
    : initialStore.profiles.find((profile) => profile.endpoint === origin);
  if (
    initialProfile &&
    initialProfile.endpoint !== origin &&
    !input.force &&
    !input.allowEndpointReplacement
  ) {
    throw new Error(
      `Station "${initialProfile.name}" points at ${initialProfile.endpoint}; refusing to replace its credential binding with ${origin}. Use station stations edit ${initialProfile.name} ${origin} --pair, or rerun with --force.`,
    );
  }
  // Snapshot the exact named binding before the approval wait. Registration
  // compares it under the profile-store CAS, so a stale approval cannot erase
  // a newer edit, forget, or credential refresh.
  const name = input.name ?? initialProfile?.name ?? suggestProfileName(origin);
  const existingCredential =
    initialProfile?.endpoint === origin && initialProfile.credentialRef
      ? credentialStore.get(initialProfile.credentialRef)
      : undefined;
  if (existingCredential && !input.force) {
    const profile = input.makeDefault
      ? selectPairedProfileAsDefault(
          initialProfile!,
          initialStore.defaultProfile,
        )
      : initialProfile!;
    stdout(
      `Already paired with ${origin} as Station "${profile.name}". Re-pair with --force.`,
    );
    return { profile, alreadyPaired: true };
  }

  let access: Awaited<ReturnType<typeof requestCurrentStationAccess>>;
  try {
    access = await requestAccess({ endpoint: origin, deviceName, origin });
  } catch (error) {
    const { code } = pairingErrorSignal(error);
    throw new Error(
      `Could not request device access from ${origin}: ${describeApiError(
        code ?? (error instanceof Error ? error.message : error),
        'the host rejected the pairing request',
      )}`,
    );
  }
  const { offerId, proof, requestId } = access;
  if (
    typeof offerId !== 'string' ||
    typeof proof !== 'string' ||
    typeof requestId !== 'string'
  ) {
    throw new Error(
      `Unexpected access-request response from ${origin}: missing pending-exchange fields (offerId/proof/requestId).`,
    );
  }
  stdout(
    `Requested device access to ${origin} as "${deviceName}".\n` +
      `Request id: ${requestId}\n` +
      'Waiting for approval on the host… ' +
      `Approve it there with: station environment access approve ${requestId} --force`,
  );

  const timeoutMs = timeoutSeconds * 1000;
  const intervalMs = PAIRING_POLL_INTERVAL_SECONDS * 1000;
  const started = now();
  let result: Awaited<ReturnType<typeof exchangeDevicePairing>> | undefined;
  while (result === undefined) {
    try {
      result = await exchange({ endpoint: origin, offerId, proof, requestId });
    } catch (error) {
      const { code, status } = pairingErrorSignal(error);
      if (code === 'request_denied' || status === 403) {
        throw new Error(
          `The host denied device access for request ${requestId}.`,
        );
      }
      if (code === 'offer_expired' || status === 410) {
        throw new Error(
          'The pairing offer expired before it was approved. Rerun to start a new request.',
        );
      }
      if (code !== 'request_not_confirmed' && status !== 409) {
        throw new Error(
          `Pairing exchange failed: ${describeApiError(
            code ?? (error instanceof Error ? error.message : error),
            'unexpected pairing error',
          )}`,
        );
      }
      if (now() - started >= timeoutMs) {
        const retry = input.name
          ? `station stations pair ${input.name}`
          : `station environment access request --api-base=${origin}`;
        throw new Error(
          `Timed out after ${timeoutSeconds}s waiting for the host to approve request ${requestId}. ` +
            `Approve it on the host, then rerun: ${retry}.`,
        );
      }
      await sleep(intervalMs);
    }
  }
  if (!result.credential) {
    throw new Error(
      'The host completed pairing without issuing a bearer credential.',
    );
  }

  const credentialRef = createCredentialRef(result.environmentId);
  try {
    credentialStore.set(credentialRef, result.credential);
  } catch (error) {
    try {
      credentialStore.delete(credentialRef);
    } catch (rollbackError) {
      throw new Error(
        `Could not store the new pairing credential (${(error as Error).message}); credential rollback also failed (${(rollbackError as Error).message}).`,
      );
    }
    throw new Error(
      `Could not store the new pairing credential; the existing Station binding was preserved: ${(error as Error).message}`,
    );
  }
  let registration: ReturnType<typeof registerProfile>;
  try {
    await dependencies.beforeRegisterProfile?.();
    registration = registerProfile(origin, {
      name,
      environmentId: result.environmentId,
      credentialRef,
      ...(initialProfile ? { expectedProfile: initialProfile } : {}),
      ...(input.makeDefault
        ? { expectedDefaultProfile: initialStore.defaultProfile }
        : {}),
      makeDefault: input.makeDefault,
      allowEndpointReplacement:
        input.allowEndpointReplacement === true || input.force === true,
      setupSource: input.setupSource,
      now: now(),
    });
  } catch (error) {
    try {
      credentialStore.delete(credentialRef);
    } catch (rollbackError) {
      throw new Error(
        `Saved Station metadata write failed (${(error as Error).message}); credential rollback also failed (${(rollbackError as Error).message}).`,
      );
    }
    throw error;
  }
  const previousRef = registration.previousProfile?.credentialRef;
  let cleanupCompleted = true;
  try {
    if (
      previousRef &&
      previousRef.id !== credentialRef.id &&
      !isCredentialRefReferenced(previousRef)
    ) {
      credentialStore.delete(previousRef);
    }
  } catch {
    // The pairing metadata commit is already durable. Preserve that success
    // and the new keyring ref; a later cleanup failure only retains the old
    // opaque ref until the credential store/profile metadata is healthy.
    cleanupCompleted = false;
  }
  stdout(
    `Paired with ${origin} (environment ${sanitizeUntrustedEnvironmentId(result.environmentId)}). ` +
      `Credential stored in the OS credential store. Saved as Station "${registration.profile.name}".`,
  );
  if (!cleanupCompleted) {
    stdout(
      'The new Station binding is active, but retirement of the replaced credential could not be confirmed.',
    );
  }
  return { profile: registration.profile, alreadyPaired: false };
}

/**
 * Requester-side device pairing: obtains a bearer credential from a remote
 * Station host over its public pairing endpoints, then stores it keyed by
 * host origin so a later `station chat --api-base=<host>` authenticates
 * automatically. This is the mirror of the host-side `access approve`: here
 * the CLI is the device asking to be let in.
 *
 * Approval is detected by attempting the exchange on a bounded interval: the
 * host answers `request_not_confirmed` (HTTP 409) while the operator has not
 * approved yet, `request_denied` (403) if they reject it, and returns the
 * bearer credential once approved. The command polls until approval, denial,
 * offer expiry, or `--timeout` — it never busy-spins.
 */
async function runAccessRequestCommand(
  args: string[],
  dependencies: EnvironmentCommandDependencies,
): Promise<boolean> {
  const normalizedArgs = normalizeEnvironmentArgsForParsing(args);
  const parsed = parseCoreArgs(normalizedArgs);
  if (
    parsed.positionals[0] !== 'access' ||
    parsed.positionals[1] !== 'request'
  ) {
    return false;
  }
  if (
    parsed.positionals.length !== 2 ||
    !allowedFlags(parsed.flags, ACCESS_REQUEST_FLAGS)
  ) {
    throw usageError();
  }
  const pairingFlags = collectPairingFlags(
    normalizedArgs,
    ACCESS_REQUEST_FLAGS,
  );

  const apiBaseFlag = pairingValueFlag(pairingFlags, 'api-base');
  if (apiBaseFlag === undefined) {
    throw new Error(
      'station environment access request requires --api-base=<host-url> — the remote Station you want to pair with.',
    );
  }
  const stationFlag = pairingValueFlag(pairingFlags, 'station');
  if (stationFlag !== undefined) assertValidProfileName(stationFlag);
  const deviceName = pairingValueFlag(pairingFlags, 'device-name');
  const timeout = pairingValueFlag(pairingFlags, 'timeout');
  const force = pairingBooleanFlag(pairingFlags, 'force');
  // Here `--station` names the saved Station that a successful direct pairing
  // will create; it is not a second target selector beside `--api-base`.
  const apiBase = resolveApiBase({
    ...parsed,
    flags: {
      ...Object.fromEntries(
        Object.entries(parsed.flags).filter(([name]) => name !== 'station'),
      ),
      ...(parsed.flags.verbose === true ? { verbose: true } : {}),
    },
  });
  await pairSavedStation(
    {
      endpoint: apiBase,
      ...(typeof stationFlag === 'string' ? { name: stationFlag } : {}),
      ...(deviceName !== undefined ? { deviceName } : {}),
      ...(timeout !== undefined ? { timeoutSeconds: Number(timeout) } : {}),
      force,
    },
    { ...dependencies.pairing, stdout: dependencies.stdout },
  );
  return true;
}

async function runLocalAccessCommand(
  args: string[],
  dependencies: EnvironmentCommandDependencies,
): Promise<boolean> {
  const parsed = parseCoreArgs(normalizeEnvironmentArgsForParsing(args));
  if (parsed.positionals[0] !== 'access') return false;

  const action = parsed.positionals[1];
  if (!['list', 'approve', 'deny'].includes(action ?? '')) {
    throw usageError();
  }
  // Validate the complete command shape before resolving a profile, reading a
  // local credential, or contacting a listener. A malformed action must never
  // have observable security-service or network effects.
  if (
    action === 'list' &&
    (parsed.positionals.length !== 2 ||
      !allowedFlags(parsed.flags, ['api-base', 'station']))
  ) {
    throw usageError();
  }
  if (
    action !== 'list' &&
    (parsed.positionals.length > 3 ||
      !allowedFlags(parsed.flags, ['api-base', 'station', 'latest', 'force']) ||
      (parsed.flags.latest !== undefined && parsed.flags.latest !== true) ||
      (parsed.flags.force !== undefined && parsed.flags.force !== true))
  ) {
    throw usageError();
  }
  const explicitId = action === 'list' ? undefined : parsed.positionals[2];
  const useLatest = action !== 'list' && parsed.flags.latest === true;
  if (explicitId && useLatest) {
    throw new Error('Provide a request id or --latest, not both.');
  }
  // station#4515: `resolveApiBaseDetailed` (unlike the bare `resolveApiBase`
  // these verbs used to call) also names the saved Station a target resolved
  // through — from an explicit `--station=<name>`, but equally from
  // STATION_TARGET, a project selection, or the default Station. All of
  // those already routed through a named profile before this fix; everything
  // below applies uniformly to every one of them, not only the flag.
  const resolved = resolveApiBaseDetailed(parsed);
  const apiBase = resolved.apiBase;
  const targetProfile = resolved.station
    ? findProfile(resolved.station)
    : undefined;
  if (!isLoopbackApiBase(apiBase)) {
    throw new Error(
      targetProfile
        ? `Station "${targetProfile.name}" targets ${apiBase}, which is not a loopback address. ` +
            'Environment-security commands (access list/approve/deny) operate only on a Station ' +
            'running on this same machine, so a script can never approve device access on a Station ' +
            "it merely has network reach to. Run this command directly on that Station's host, " +
            `or pass a Station saved with a loopback (127.0.0.1 or [::1]) endpoint.`
        : `Local access approval requires a loopback --api-base, but this resolved to ${apiBase}. ` +
            'Run this command on the Station host or over SSH, and pass an explicit ' +
            `--api-base=http://127.0.0.1:${DEFAULT_SERVER_PORT} if a remote Station is your default.`,
    );
  }
  // station#4515 review H1: what actually grants trust for a profile-addressed
  // target is `localService.baseDir` — the exact Station home `station setup
  // local` recorded, which lets the security service below read THAT home's
  // own operator credential instead of this process's unrelated default one.
  // A profile with no recorded local service (e.g. paired rather than
  // installed by this CLI) has no such home to read, so refuse up front with
  // an honest reason instead of proceeding to a cryptographic proof that can
  // only fail and, when it fails, would misleadingly blame "the listener"
  // for a problem that is really "this saved Station's home is unknown".
  if (targetProfile && !targetProfile.localService?.baseDir) {
    throw new Error(
      `Station "${targetProfile.name}" has no recorded local home. It was saved by pairing ` +
        '(or `stations add`), not `station setup local`, so this saved Station does not record ' +
        "the home directory environment-security commands need in order to read that Station's " +
        "own operator credential from disk. Set STATION_HOME to that Station's home directory, " +
        `then run: ${suggestDirectAccessInvocation(action, apiBase)}`,
    );
  }
  const request = dependencies.request ?? requestBareJson;
  const serviceProjectHome =
    targetProfile?.localService?.baseDir ?? dependencies.projectHome;
  const service = requireSecurityService({
    ...dependencies,
    projectHome: serviceProjectHome,
  });
  const snapshot = targetProfile?.localService?.baseDir
    ? await readSavedStationRecord(
        service,
        targetProfile.name,
        targetProfile.localService.baseDir,
      )
    : await service.initialize();
  const handshake = await request(apiBase, '/.well-known/station/v1');
  // station#4515 review NEW-3: an explicit, standalone shape rejection —
  // mirrors the sibling check in `verifyLocalOfferHost` above
  // (`!handshake || typeof handshake !== 'object' || Array.isArray(handshake)`)
  // rather than folding a malformed handshake to `handshakeEnvironmentId =
  // undefined` and relying on it happening to differ from
  // `snapshot.environmentId`. That fold alone would treat a malformed or
  // missing handshake as a MATCH if `snapshot.environmentId` were ever
  // itself empty/undefined — a defensive property this file's error paths
  // should never depend on the security service to uphold.
  const handshakeIsWellFormed =
    Boolean(handshake) &&
    typeof handshake === 'object' &&
    !Array.isArray(handshake);
  const handshakeEnvironmentId = handshakeIsWellFormed
    ? (handshake as { environmentId?: unknown }).environmentId
    : undefined;
  // station#4515 review H1: the ORIGINAL comparison — the loopback listener
  // must match the identity actually read from the resolved home — is
  // unchanged. What changed is which home gets resolved (above): a profile
  // with a recorded `localService.baseDir` resolves to THAT Station's own
  // home rather than this process's default one, so the comparison now
  // succeeds for the Station actually being addressed. `targetProfile
  // .environmentId` (the value pairing recorded) is never itself the trust
  // boundary; it only enriches the error below when it has drifted from
  // what the resolved home currently reports.
  if (
    !handshakeIsWellFormed ||
    handshakeEnvironmentId !== snapshot.environmentId
  ) {
    const advertised = sanitizeUntrustedEnvironmentId(handshakeEnvironmentId);
    if (targetProfile) {
      const staleNote =
        targetProfile.environmentId !== undefined &&
        targetProfile.environmentId !== snapshot.environmentId
          ? ` This saved Station's own pairing record (environment ${targetProfile.environmentId}) ` +
            "is also out of date relative to its home's current environment — most likely its " +
            'identity was reset or re-provisioned since it was paired; re-pair or re-provision ' +
            'this saved Station to refresh it.'
          : '';
      throw new Error(
        `Station "${targetProfile.name}" targets ${apiBase}, but the loopback listener there ` +
          `advertised environment ${advertised}, not the environment (${snapshot.environmentId}) ` +
          `its recorded home currently owns. The loopback listener there is not the Station ` +
          `saved as "${targetProfile.name}".${staleNote} Set STATION_HOME to that Station's ` +
          `home directory, then run: ${suggestDirectAccessInvocation(action, apiBase)}`,
      );
    }
    throw new Error(
      'The loopback Station identity does not match this local Station home. Check STATION_HOME, STATION_PORT, and --api-base.',
    );
  }
  const nonce = randomBytes(32).toString('base64url');
  const proof = await request(apiBase, PUBLIC_STATION_PROOF_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
      nonce,
    }),
  });
  if (!verifyLocalStationProof(snapshot, nonce, proof)) {
    throw new Error(
      targetProfile
        ? `The loopback listener for Station "${targetProfile.name}" (${apiBase}) could not ` +
            'prove it owns this Station environment. No credential was sent.'
        : 'The loopback listener could not prove it owns this Station environment. No credential was sent.',
    );
  }
  const operatorHeaders = {
    Authorization: `Bearer ${snapshot.credential}`,
  };
  const requestOperatorJson = (path: string, init?: RequestInit) =>
    request(apiBase, path, {
      ...init,
      headers: { ...operatorHeaders, ...(init?.headers ?? {}) },
    });

  if (action === 'list') {
    const requests = parsePairingRequestList(
      await requestOperatorJson('/api/pairing/requests'),
    );
    (dependencies.stdout ?? console.log)(
      terminalSafeJson({ requests: requests.map(pairingRequestListEntry) }),
    );
    return true;
  }

  const actionable = parsePairingRequestList(
    await requestOperatorJson('/api/pairing/requests'),
  )
    .filter((candidate) =>
      action === 'approve'
        ? candidate.status === 'pending'
        : candidate.status === 'pending' || candidate.status === 'confirmed',
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  if (
    useLatest &&
    actionable[0] &&
    actionable[1]?.createdAt === actionable[0].createdAt
  ) {
    throw new Error(
      'The newest access request is ambiguous. Use access list and provide the exact request id.',
    );
  }
  const selected = explicitId
    ? actionable.find(
        (candidate) =>
          candidate.requestId === explicitId ||
          candidate.offerId === explicitId,
      )
    : useLatest
      ? actionable[0]
      : actionable.length === 1
        ? actionable[0]
        : undefined;
  if (!selected) {
    if (explicitId) {
      throw new Error(`No actionable access request matches ${explicitId}.`);
    }
    if (actionable.length === 0) {
      throw new Error('There are no actionable device access requests.');
    }
    throw new Error(
      'Multiple access requests are waiting. Use access list, then provide a request id or --latest.',
    );
  }

  const force = parsed.flags.force === true;
  if (!force) {
    if (!dependencies.isInteractive) {
      const rerunTarget =
        typeof parsed.flags.station === 'string'
          ? ` --station=${parsed.flags.station}`
          : typeof parsed.flags['api-base'] === 'string'
            ? ` --api-base=${parsed.flags['api-base']}`
            : '';
      throw new Error(
        `${action === 'approve' ? 'Approving' : 'Denying'} device access requires --force when stdin is non-interactive, ` +
          `so a script can never silently grant a stranger's device access to this Station without a human confirming ` +
          `${accessRequestLabel(selected)} first. Rerun: station environment access ${action} ${selected.requestId} --force${rerunTarget}`,
      );
    }
    if (!dependencies.confirm) {
      throw new Error(
        'Device access approval requires an interactive confirmation handler.',
      );
    }
    const confirmed = await dependencies.confirm(
      `${action === 'approve' ? 'Approve' : 'Deny'} device access for ${accessRequestLabel(selected)} ` +
        `on ${describeResolvedTargetForHuman(resolved)}?`,
    );
    if (!confirmed) {
      (dependencies.stdout ?? console.log)('Cancelled.');
      return true;
    }
  }

  const path = `/api/pairing/requests/${encodeURIComponent(selected.requestId)}${
    action === 'approve' ? '/confirm' : ''
  }`;
  const updated = parsePairingRequest(
    await requestOperatorJson(path, {
      method: action === 'approve' ? 'POST' : 'DELETE',
    }),
  );
  const expectedStatus = action === 'approve' ? 'confirmed' : 'denied';
  if (
    updated.requestId !== selected.requestId ||
    updated.deviceName !== selected.deviceName ||
    updated.source !== selected.source ||
    updated.status !== expectedStatus
  ) {
    throw new Error('Station returned a mismatched access-request result.');
  }
  (dependencies.stdout ?? console.log)(
    terminalSafeJson({
      requestId: updated.requestId,
      deviceName: updated.deviceName,
      source: updated.source,
      status: updated.status,
      // station#4515 review M6: names what this mutation actually acted on
      // — nested under its own key so it can never collide with the pairing
      // request's own `source` field above (same-origin/pairing-code/tailnet).
      station: {
        name: resolved.station ?? null,
        apiBase,
        resolvedVia: resolved.source,
      },
    }),
  );
  return true;
}

function requireSecurityService(
  dependencies: EnvironmentCommandDependencies,
): EnvironmentSecurityServiceLike {
  if (!dependencies.createService) {
    throw new Error(
      'Environment security commands require the Station repository launcher (./station).',
    );
  }
  return dependencies.createService(dependencies.projectHome);
}

function savedStationErrorValue(value: string, limit: number): string {
  return JSON.stringify(terminalSafeText(value).slice(0, limit));
}

/**
 * A saved profile chooses an existing Station home, not a bootstrap target.
 * Keep the underlying refusal as the cause for callers/diagnostics while the
 * terminal-facing message bounds both profile-controlled values.
 */
async function readSavedStationRecord(
  service: EnvironmentSecurityServiceLike,
  name: string,
  homeDir: string,
): Promise<EnvironmentSecuritySnapshot> {
  try {
    return await service.readExistingRecord();
  } catch (error) {
    throw new Error(
      `Saved Station ${savedStationErrorValue(name, 128)} recorded home ${savedStationErrorValue(homeDir, 512)} cannot be read without changing it. ` +
        'Re-run `station setup local` or fix this saved Station.',
      { cause: error },
    );
  }
}

export function normalizeEnvironmentArgsForParsing(args: string[]): string[] {
  const valueFlags = new Set([
    '--ssh',
    '--project',
    '--name',
    '--remote-port',
    '--api-base',
    '--credential',
    '--device-name',
    '--timeout',
    '--station',
    '--environment-id',
    '--scope',
    '--label',
    '--advertise-url',
    '--tailscale-serve-port',
  ]);
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (valueFlags.has(value) && next && !next.startsWith('--')) {
      normalized.push(`${value}=${next}`);
      index += 1;
    } else {
      normalized.push(value);
    }
  }
  return normalized;
}

function requireValueFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${name} requires a non-empty value.`);
  }
  return value;
}

interface SshEnvironmentApiView {
  profile: {
    id: string;
    name: string;
    verifiedProjectPath?: string | null;
  };
  state: { phase: string; localUrl?: string; action?: string };
}

async function connectEnvironment(
  apiBase: string,
  id: string,
): Promise<SshEnvironmentApiView> {
  return (await requestJson<SshEnvironmentApiView>(
    apiBase,
    `/api/environments/ssh/${encodeURIComponent(id)}/connect`,
    { method: 'POST' },
  )) as SshEnvironmentApiView;
}

async function runSshEnvironmentCommand(args: string[]): Promise<boolean> {
  const parsed = parseCoreArgs(normalizeEnvironmentArgsForParsing(args));
  const action = parsed.positionals[0];
  if (
    !['hosts', 'list', 'show', 'add', 'connect', 'stop', 'remove'].includes(
      action ?? '',
    )
  ) {
    return false;
  }
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);

  if (action === 'hosts') {
    printJson(await requestJson(apiBase, '/api/environments/ssh/hosts'));
    return true;
  }
  if (action === 'list') {
    printJson(await requestJson(apiBase, '/api/environments/ssh'));
    return true;
  }
  if (action === 'show' && !parsed.positionals[1]) return false;
  if (action === 'add') {
    const remotePort = parsed.flags['remote-port'];
    const data = await requestJson(apiBase, '/api/environments/ssh', {
      method: 'POST',
      body: JSON.stringify({
        hostAlias: requireValueFlag(parsed.flags, 'ssh'),
        remoteProjectPath: requireValueFlag(parsed.flags, 'project'),
        ...(typeof parsed.flags.name === 'string'
          ? { name: parsed.flags.name }
          : {}),
        ...(typeof remotePort === 'string'
          ? { remotePort: Number(remotePort) }
          : {}),
        ...(parsed.flags.managed === true ? { launchMode: 'managed' } : {}),
      }),
    });
    printJson(data);
    return true;
  }

  const id = requirePositional(parsed, 1, 'environment id');
  if (action === 'show') {
    printJson(
      await requestJson(
        apiBase,
        `/api/environments/ssh/${encodeURIComponent(id)}`,
      ),
    );
    return true;
  }
  if (action === 'connect') {
    printJson(await connectEnvironment(apiBase, id));
    return true;
  }
  if (action === 'stop') {
    printJson(
      await requestJson(
        apiBase,
        `/api/environments/ssh/${encodeURIComponent(id)}/disconnect`,
        { method: 'POST' },
      ),
    );
    return true;
  }
  if (action === 'remove') {
    printJson(
      await requestJson(
        apiBase,
        `/api/environments/ssh/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    );
    return true;
  }
  return false;
}
