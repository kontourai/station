import {
  createHash,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isPairingScopeSubset,
  type PairedDevice,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { renameFileSyncRetrying } from '@kontourai/station-shared/fs-windows-compat';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';

const BINDINGS_SCHEMA_VERSION = 1 as const;
const BINDINGS_FILE = 'native-device-proof-bindings.json';
const PRIVATE_FILE_MODE = 0o600;
const MAX_BINDINGS = 4096;
const MAX_STORE_BYTES = 1024 * 1024;
const CLIENT_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const SURFACE_KEY_SET =
  'appIdentifier,channel,clientInstanceId,keyThumbprint,kind';

/**
 * Canonical full native installation surface. Every field is validated for
 * exact membership and canonical form; unknown fields and noncanonical
 * values are refused so a stored binding never interprets ambiguous input.
 */
export type NativeDeviceClientSurface = SelfHostedBrokerNativeClientSurfaceV2;

function isValidNativeClientSurface(
  value: unknown,
): value is NativeDeviceClientSurface {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const surface = value as Record<string, unknown>;
  return (
    Object.keys(surface).sort().join(',') === SURFACE_KEY_SET &&
    surface.kind === 'station-native' &&
    (surface.channel === 'dev' ||
      surface.channel === 'stable' ||
      surface.channel === 'beta' ||
      surface.channel === 'nightly') &&
    typeof surface.appIdentifier === 'string' &&
    APP_IDENTIFIER_PATTERN.test(surface.appIdentifier) &&
    typeof surface.clientInstanceId === 'string' &&
    CLIENT_INSTANCE_ID_PATTERN.test(surface.clientInstanceId) &&
    typeof surface.keyThumbprint === 'string' &&
    BASE64URL_32_PATTERN.test(surface.keyThumbprint)
  );
}

/** Exact field-wise equality; a binding answers only its full approved surface. */
function surfacesMatch(
  stored: NativeDeviceClientSurface,
  presented: NativeDeviceClientSurface,
): boolean {
  return (
    stored.kind === presented.kind &&
    stored.appIdentifier === presented.appIdentifier &&
    stored.channel === presented.channel &&
    stored.clientInstanceId === presented.clientInstanceId &&
    stored.keyThumbprint === presented.keyThumbprint
  );
}

/**
 * Canonical P-256 Elliptic-Curve public JWK. The private scalar (`d`) is
 * refused on input and never stored: this slice binds a *proof* public key,
 * and a stored private key would turn the sidecar into a bearer asset.
 */
export interface NativeDeviceProofPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** Why an active binding left the active state. */
export type NativeDeviceProofBindingRevocationReason =
  | 'operator-revoked'
  | 'replaced';

interface StoredBinding {
  readonly bindingId: string;
  readonly deviceProof: {
    readonly jwk: NativeDeviceProofPublicJwk;
    readonly thumbprint: string;
  };
  readonly deviceId: string;
  readonly stationId: string;
  readonly surface: NativeDeviceClientSurface;
  readonly createdAt: number;
  readonly approvedAt: number;
  readonly approvedBy: string;
  readonly deviceScopeAtApproval: string;
  state: 'active' | 'revoked';
  revokedAt?: number;
  revocationReason?: NativeDeviceProofBindingRevocationReason;
}

/** Server-side view of one binding. Public-key material only, by construction. */
export interface NativeDeviceProofBinding {
  readonly bindingId: string;
  readonly deviceProof: {
    readonly jwk: NativeDeviceProofPublicJwk;
    readonly thumbprint: string;
  };
  readonly deviceId: string;
  readonly stationId: string;
  /** Full separately approved native surface this binding is bound to. */
  readonly surface: NativeDeviceClientSurface;
  readonly createdAt: number;
  readonly approvedAt: number;
  readonly approvedBy: string;
  readonly deviceScopeAtApproval: string;
  readonly state: 'active' | 'revoked';
  readonly revokedAt?: number;
  readonly revocationReason?: NativeDeviceProofBindingRevocationReason;
}

/** UI-safe projection: identities and timestamps, never key or scope internals. */
export interface NativeDeviceProofBindingProjection {
  readonly bindingId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly thumbprint: string;
  readonly createdAt: number;
  readonly approvedAt: number;
  readonly state: 'active' | 'revoked';
}

/**
 * The exact, server-derived answer a future proof verifier consumes. Both the
 * binding and the Device scope are re-derived from Station state at read
 * time; nothing here accepts request-supplied fields as authority.
 */
export interface NativeDeviceProofBindingCurrent {
  readonly binding: NativeDeviceProofBinding;
  readonly device: { readonly id: string; readonly scope: string };
}

export class NativeDeviceProofBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'NativeDeviceProofBindingError';
  }
}

const OPERATOR_AUTHORITY_TOKEN = Symbol(
  'native-device-proof.operator-authority',
);

/**
 * In-process approval context factory for a future trusted operator seam.
 * The factory checks the operator principal ID and rejects raw request data;
 * it does not authenticate a caller. The route must verify a current operator
 * credential and an explicit approval action before calling this method.
 */
export class NativeDeviceProofOperatorAuthority {
  approve(input: {
    operatorPrincipalId: string;
    approvalId?: string;
    approvedAt?: number;
  }): NativeDeviceProofOperatorApprovalContext {
    if (input.operatorPrincipalId !== LOCAL_OPERATOR_PRINCIPAL_ID) {
      throw new NativeDeviceProofBindingError('operator_unauthorized');
    }
    return new NativeDeviceProofOperatorApprovalContext({
      token: OPERATOR_AUTHORITY_TOKEN,
      operatorPrincipalId: input.operatorPrincipalId,
      approvalId: input.approvalId ?? randomUUID(),
      approvedAt: input.approvedAt ?? Date.now(),
    });
  }
}

class NativeDeviceProofOperatorApprovalContext {
  readonly operatorPrincipalId: string;
  readonly approvalId: string;
  readonly approvedAt: number;
  #intact = true;

  constructor(init: {
    token: symbol;
    operatorPrincipalId: string;
    approvalId: string;
    approvedAt: number;
  }) {
    if (init.token !== OPERATOR_AUTHORITY_TOKEN) {
      throw new NativeDeviceProofBindingError('invalid_operator_approval');
    }
    this.operatorPrincipalId = init.operatorPrincipalId;
    this.approvalId = init.approvalId;
    this.approvedAt = init.approvedAt;
  }

  /** One approval authorizes exactly one service mutation. */
  consume(): void {
    if (!this.#intact) {
      throw new NativeDeviceProofBindingError('operator_approval_reused');
    }
    this.#intact = false;
  }
}

/** Narrow view of {@link DevicePairingService} this service depends on. */
export interface NativeDeviceProofPairingSource {
  environmentId(): string;
  listDevices(): PairedDevice[];
}

interface BindingStoreFile {
  readonly schemaVersion: number;
  readonly bindings: StoredBinding[];
}

function isValidStoredJwk(value: unknown): value is NativeDeviceProofPublicJwk {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const jwk = value as Record<string, unknown>;
  if (
    Object.keys(jwk).sort().join(',') !== 'crv,kty,x,y' ||
    !(
      jwk.kty === 'EC' &&
      jwk.crv === 'P-256' &&
      typeof jwk.x === 'string' &&
      BASE64URL_32_PATTERN.test(jwk.x) &&
      typeof jwk.y === 'string' &&
      BASE64URL_32_PATTERN.test(jwk.y)
    )
  )
    return false;
  try {
    const exported = createPublicKey({ key: jwk, format: 'jwk' }).export({
      format: 'jwk',
    }) as {
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    };
    return (
      exported.kty === 'EC' &&
      exported.crv === 'P-256' &&
      exported.x === jwk.x &&
      exported.y === jwk.y
    );
  } catch {
    return false;
  }
}

function privateSidecarStatus(path: string): 'missing' | 'valid' {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new NativeDeviceProofBindingError('store_unavailable');
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.size > MAX_STORE_BYTES ||
    (process.platform !== 'win32' &&
      ((status.mode & 0o777) !== PRIVATE_FILE_MODE ||
        status.uid !== process.getuid?.()))
  )
    throw new NativeDeviceProofBindingError('store_unavailable');
  return 'valid';
}

function cloneBinding(stored: StoredBinding): NativeDeviceProofBinding {
  return structuredClone({
    ...stored,
    deviceProof: { ...stored.deviceProof, jwk: { ...stored.deviceProof.jwk } },
    surface: { ...stored.surface },
  });
}

/** RFC 7638 SHA-256 thumbprint over the canonical P-256 member set. */
function p256Thumbprint(jwk: NativeDeviceProofPublicJwk): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return createHash('sha256').update(canonical).digest('base64url');
}

class NativeDeviceProofBindingStore {
  readonly #filePath: string;

  constructor(homeDir: string) {
    this.#filePath = join(homeDir, 'security', BINDINGS_FILE);
  }

  /** Strict load: corruption and version drift fail closed, never to empty. */
  load(): StoredBinding[] {
    if (privateSidecarStatus(this.#filePath) === 'missing') {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#filePath, 'utf8'));
    } catch {
      throw new NativeDeviceProofBindingError('store_unavailable');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'bindings,schemaVersion' ||
      (parsed as BindingStoreFile).schemaVersion !== BINDINGS_SCHEMA_VERSION ||
      !Array.isArray((parsed as BindingStoreFile).bindings) ||
      (parsed as BindingStoreFile).bindings.length > MAX_BINDINGS
    ) {
      throw new NativeDeviceProofBindingError('store_unavailable');
    }
    const bindings: StoredBinding[] = [];
    const activePairs = new Set<string>();
    const bindingIds = new Set<string>();
    for (const raw of (parsed as BindingStoreFile).bindings) {
      if (!this.#isValidStoredBinding(raw)) {
        throw new NativeDeviceProofBindingError('store_unavailable');
      }
      if (bindingIds.has(raw.bindingId))
        throw new NativeDeviceProofBindingError('store_unavailable');
      bindingIds.add(raw.bindingId);
      if (raw.state === 'active') {
        const pair = JSON.stringify([
          raw.deviceId,
          raw.surface.clientInstanceId,
        ]);
        if (activePairs.has(pair))
          throw new NativeDeviceProofBindingError('store_unavailable');
        activePairs.add(pair);
      }
      bindings.push(raw);
    }
    return bindings;
  }

  persist(bindings: StoredBinding[]): void {
    if (bindings.length > MAX_BINDINGS)
      throw new NativeDeviceProofBindingError('store_unavailable');
    const file: BindingStoreFile = {
      schemaVersion: BINDINGS_SCHEMA_VERSION,
      bindings,
    };
    const body = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_STORE_BYTES)
      throw new NativeDeviceProofBindingError('store_unavailable');
    mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(this.#filePath));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()))
    )
      throw new NativeDeviceProofBindingError('store_unavailable');
    // Refuse an unsafe existing target before publishing a replacement.
    privateSidecarStatus(this.#filePath);
    const tempPath = `${this.#filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      writeFileSync(fd, body);
      fsyncSync(fd);
      if (process.platform !== 'win32') fchmodSync(fd, PRIVATE_FILE_MODE);
      closeSync(fd);
      fd = undefined;
      renameFileSyncRetrying(tempPath, this.#filePath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tempPath, { force: true });
    }
  }

  #isValidStoredBinding(raw: unknown): raw is StoredBinding {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return false;
    const b = raw as Record<string, unknown>;
    return (
      Object.keys(b).sort().join(',') ===
        (b.state === 'active'
          ? 'approvedAt,approvedBy,bindingId,createdAt,deviceId,deviceProof,deviceScopeAtApproval,state,stationId,surface'
          : 'approvedAt,approvedBy,bindingId,createdAt,deviceId,deviceProof,deviceScopeAtApproval,revocationReason,revokedAt,state,stationId,surface') &&
      typeof b.bindingId === 'string' &&
      BINDING_ID_PATTERN.test(b.bindingId) &&
      typeof b.deviceProof === 'object' &&
      b.deviceProof !== null &&
      !Array.isArray(b.deviceProof) &&
      Object.keys(b.deviceProof).sort().join(',') === 'jwk,thumbprint' &&
      isValidStoredJwk((b.deviceProof as { jwk?: unknown } | undefined)?.jwk) &&
      typeof (b.deviceProof as { thumbprint?: unknown }).thumbprint ===
        'string' &&
      (b.deviceProof as { thumbprint: string }).thumbprint ===
        p256Thumbprint(
          (b.deviceProof as { jwk: NativeDeviceProofPublicJwk }).jwk,
        ) &&
      typeof b.deviceId === 'string' &&
      typeof b.stationId === 'string' &&
      isValidNativeClientSurface(b.surface) &&
      Number.isSafeInteger(b.createdAt) &&
      Number.isSafeInteger(b.approvedAt) &&
      b.approvedBy === LOCAL_OPERATOR_PRINCIPAL_ID &&
      typeof b.deviceScopeAtApproval === 'string' &&
      parsePairingScope(b.deviceScopeAtApproval) !== null &&
      (b.state === 'active' || b.state === 'revoked') &&
      (b.state === 'active' ||
        (Number.isSafeInteger(b.revokedAt) &&
          (b.revocationReason === 'operator-revoked' ||
            b.revocationReason === 'replaced')))
    );
  }
}

export class NativeDeviceProofBindingService {
  readonly #store: NativeDeviceProofBindingStore;
  readonly #pairing: NativeDeviceProofPairingSource;
  readonly #now: () => number;

  constructor(options: {
    homeDir: string;
    pairing: NativeDeviceProofPairingSource;
    now?: () => number;
  }) {
    this.#store = new NativeDeviceProofBindingStore(options.homeDir);
    this.#pairing = options.pairing;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Create (or replace) the native Device proof binding for one approved
   * native installation surface on an already-approved Device grant. The
   * full surface (kind, appIdentifier, channel, clientInstanceId, route-key
   * thumbprint) is the approved identity; the Device proof key must be
   * distinct from that surface's route key. Requires an explicit operator
   * approval context minted by {@link NativeDeviceProofOperatorAuthority}.
   * The future route must establish that authority independently of a saved
   * profile, broker route grant, account session, or legacy Device bearer.
   */
  createBinding(input: {
    deviceId: string;
    surface: NativeDeviceClientSurface;
    jwk: NativeDeviceProofPublicJwk;
    approval: NativeDeviceProofOperatorApprovalContext;
  }): NativeDeviceProofBinding {
    if (!(input.approval instanceof NativeDeviceProofOperatorApprovalContext)) {
      throw new NativeDeviceProofBindingError('invalid_operator_approval');
    }
    input.approval.consume();
    const surface = this.#validatedSurface(input.surface);
    const jwk = this.#validatedPublicJwk(input.jwk);
    if (
      timingSafeEqual(
        Buffer.from(p256Thumbprint(jwk)),
        Buffer.from(surface.keyThumbprint),
      )
    ) {
      throw new NativeDeviceProofBindingError('device_key_matches_route_key');
    }
    const device = this.#activeDevice(input.deviceId);
    const stationId = this.#pairing.environmentId();
    if (typeof stationId !== 'string' || stationId.length === 0) {
      throw new NativeDeviceProofBindingError('station_unavailable');
    }
    const bindings = structuredClone(this.#store.load());
    const now = this.#now();
    for (const existing of bindings) {
      if (
        existing.state === 'active' &&
        existing.deviceId === input.deviceId &&
        existing.surface.clientInstanceId === surface.clientInstanceId
      ) {
        existing.state = 'revoked';
        existing.revokedAt = now;
        existing.revocationReason = 'replaced';
      }
    }
    const binding: StoredBinding = {
      bindingId: randomUUID(),
      deviceProof: { jwk, thumbprint: p256Thumbprint(jwk) },
      deviceId: input.deviceId,
      stationId,
      surface,
      createdAt: now,
      approvedAt: input.approval.approvedAt,
      approvedBy: input.approval.operatorPrincipalId,
      deviceScopeAtApproval: device.scope,
      state: 'active',
    };
    bindings.push(binding);
    this.#store.persist(bindings);
    return cloneBinding(binding);
  }

  revokeBinding(input: {
    deviceId: string;
    surface: NativeDeviceClientSurface;
    approval: NativeDeviceProofOperatorApprovalContext;
    reason?: NativeDeviceProofBindingRevocationReason;
  }): NativeDeviceProofBinding[] {
    if (!(input.approval instanceof NativeDeviceProofOperatorApprovalContext)) {
      throw new NativeDeviceProofBindingError('invalid_operator_approval');
    }
    input.approval.consume();
    const surface = this.#validatedSurface(input.surface);
    const bindings = structuredClone(this.#store.load());
    const now = this.#now();
    const revoked: NativeDeviceProofBinding[] = [];
    for (const existing of bindings) {
      if (
        existing.state === 'active' &&
        existing.deviceId === input.deviceId &&
        surfacesMatch(existing.surface, surface)
      ) {
        existing.state = 'revoked';
        existing.revokedAt = now;
        existing.revocationReason = input.reason ?? 'operator-revoked';
        revoked.push(cloneBinding(existing));
      }
    }
    if (revoked.length === 0) {
      throw new NativeDeviceProofBindingError('binding_not_found');
    }
    this.#store.persist(bindings);
    return revoked;
  }

  /**
   * Exact current binding for a Device plus its full approved native surface,
   * re-derived from Station state. The presented surface must match the
   * approved surface exactly — every field, including the route-key
   * thumbprint. Returns null — never a stale or reconstructed answer — when
   * the binding is absent, revoked, on a revoked or missing Device, paired
   * against a different Station, on any surface mismatch, or the Device's
   * scope no longer covers the scope the binding was approved under.
   */
  currentBinding(input: {
    deviceId: string;
    surface: NativeDeviceClientSurface;
  }): NativeDeviceProofBindingCurrent | null {
    if (!isValidNativeClientSurface(input.surface)) return null;
    const stationId = this.#pairing.environmentId();
    const binding = this.#store
      .load()
      .find(
        (candidate) =>
          candidate.state === 'active' &&
          candidate.deviceId === input.deviceId &&
          surfacesMatch(candidate.surface, input.surface),
      );
    if (!binding) return null;
    if (binding.stationId !== stationId) return null;
    const device = this.#activeDeviceOrNull(input.deviceId);
    if (!device) return null;
    if (!isPairingScopeSubset(binding.deviceScopeAtApproval, device.scope)) {
      return null;
    }
    return {
      binding: cloneBinding(binding),
      device: { id: device.id, scope: device.scope },
    };
  }

  /** Verifier-side lookup that refuses to proceed without a current binding. */
  requireCurrentBinding(input: {
    deviceId: string;
    surface: NativeDeviceClientSurface;
  }): NativeDeviceProofBindingCurrent {
    const current = this.currentBinding(input);
    if (!current)
      throw new NativeDeviceProofBindingError('binding_unavailable');
    return current;
  }

  /** Compare a presented proof key's thumbprint against the bound key. */
  thumbprintMatches(
    current: NativeDeviceProofBindingCurrent,
    jwk: NativeDeviceProofPublicJwk,
  ): boolean {
    const candidate = Buffer.from(
      p256Thumbprint(this.#validatedPublicJwk(jwk)),
    );
    const bound = Buffer.from(current.binding.deviceProof.thumbprint);
    return (
      candidate.length === bound.length && timingSafeEqual(candidate, bound)
    );
  }

  projectionOf(
    binding: NativeDeviceProofBinding,
  ): NativeDeviceProofBindingProjection {
    return {
      bindingId: binding.bindingId,
      deviceId: binding.deviceId,
      clientInstanceId: binding.surface.clientInstanceId,
      thumbprint: binding.deviceProof.thumbprint,
      createdAt: binding.createdAt,
      approvedAt: binding.approvedAt,
      state: binding.state,
    };
  }

  #validatedSurface(
    surface: NativeDeviceClientSurface,
  ): NativeDeviceClientSurface {
    if (!isValidNativeClientSurface(surface)) {
      throw new NativeDeviceProofBindingError('invalid_native_surface');
    }
    return { ...surface };
  }

  #activeDevice(deviceId: string): PairedDevice {
    const device = this.#activeDeviceOrNull(deviceId);
    if (!device) throw new NativeDeviceProofBindingError('device_not_active');
    return device;
  }

  #activeDeviceOrNull(deviceId: string): PairedDevice | null {
    const device = this.#pairing
      .listDevices()
      .find((candidate) => candidate.id === deviceId);
    if (!device || device.revokedAt !== null) return null;
    if (parsePairingScope(device.scope) === null) return null;
    return device;
  }

  #validatedPublicJwk(
    jwk: NativeDeviceProofPublicJwk,
  ): NativeDeviceProofPublicJwk {
    if (!isValidStoredJwk(jwk)) {
      throw new NativeDeviceProofBindingError('invalid_proof_jwk');
    }
    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    } catch {
      throw new NativeDeviceProofBindingError('invalid_proof_jwk');
    }
    const exported = key.export({ format: 'jwk' }) as {
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    };
    if (
      exported.kty !== 'EC' ||
      exported.crv !== 'P-256' ||
      typeof exported.x !== 'string' ||
      typeof exported.y !== 'string' ||
      exported.x !== jwk.x ||
      exported.y !== jwk.y
    ) {
      throw new NativeDeviceProofBindingError('invalid_proof_jwk');
    }
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  }
}
