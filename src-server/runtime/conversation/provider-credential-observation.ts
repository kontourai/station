// UNWIRED(#91): no production caller/authority/runtime composition; credential-source evidence only.
import { createHash, randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ObservationFailure =
  | 'authorization_unavailable'
  | 'unsupported_source'
  | 'observation_unavailable'
  | 'observation_obsolete'
  | 'durability_unconfirmed';
export class ProviderCredentialObservationError extends Error {
  constructor(readonly code: ObservationFailure) {
    super(`Provider credential observation refused: ${code}`);
    this.name = 'ProviderCredentialObservationError';
  }
}

/** This port is an EXISTING SERVER local-grant owner, not a client/config value.
 * Its implementation must use isBoundLocalGrantMintedOperator plus current
 * ingress principal authorization, and supply the actual host-context owner.
 * This module issues no grant and has no default/boolean approval callback.
 */
export interface CurrentLocalGrantObservationOwner {
  requireCurrentLocalGrant(request: Request): Readonly<{
    principalCredential: string;
    hostContextId: string;
    privateHostContextWitness: string;
    assertCurrent(): void;
  }>;
}
export interface ProviderCredentialObservationSources {
  authority: CurrentLocalGrantObservationOwner;
  /** Actual FileStorageAdapter, pointed at this same canonical home. */
  adapter: {
    listProviderConnections(): Array<{
      id: string;
      type: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
  };
  captureConfigurationFence(): () => void;
  captureRuntimeFence(): () => void;
}
export interface ProviderCredentialObservation {
  readonly observationId: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly kind: 'credential-source-observation';
}

const sdkCredentialBrand = Symbol('observed SDK provider credential');
export type ObservedSdkProviderCredential = Readonly<{
  [sdkCredentialBrand]: true;
}>;
type SdkCredentialValue = Readonly<{
  provider: 'anthropic' | 'google';
  connectionId: string;
  connectionRevision: string;
  credentialRevision: string;
  hostContextId: string;
  apiKey: string;
}>;
const sdkCredentials = new WeakMap<
  ObservedSdkProviderCredential,
  { request: Request; read: () => SdkCredentialValue }
>();

/** Private preparation/SDK seam; a serialized observation or caller-supplied key cannot enter it. */
export function readObservedSdkProviderCredential(
  credential: ObservedSdkProviderCredential,
  expectedProvider: 'anthropic' | 'google',
  expectedRequest?: Request,
): SdkCredentialValue {
  const state = sdkCredentials.get(credential);
  if (!state) fail('observation_unavailable');
  if (expectedRequest !== undefined && state.request !== expectedRequest)
    fail('authorization_unavailable');
  try {
    const value = state.read();
    if (value.provider !== expectedProvider) fail('unsupported_source');
    return value;
  } catch (error) {
    if (error instanceof ProviderCredentialObservationError) throw error;
    return fail('observation_unavailable');
  }
}

type DirectoryWitness = { dev: string; ino: string; uid: string; mode: string };
type FileWitness = DirectoryWitness & {
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  sha256: string;
};
type SourceWitness = {
  home: DirectoryWitness;
  config: DirectoryWitness;
  file: FileWitness;
  selectedConnectionSha256: string;
  staticKeySha256: string;
};
type PrivateRecord = {
  schema: 2;
  observationId: string;
  observedAtMs: number;
  expiresAtMs: number;
  connectionId: string;
  principalCredentialSha256: string;
  hostContextId: string;
  privateHostContextWitness: string;
  source: SourceWitness;
};
type Fences = { configuration: () => void; runtime: () => void };
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 16384;
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const STORE_PATH = ['security', 'provider-credential-observations-v1'] as const;
function fail(code: ObservationFailure): never {
  throw new ProviderCredentialObservationError(code);
}
function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}
function string(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control bytes in private observation identifiers.
    /[\u0000-\u001f]/u.test(value)
  )
    fail('unsupported_source');
  return value;
}
function count(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    fail('unsupported_source');
  return value;
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail('unsupported_source');
  return value as Record<string, unknown>;
}
function identity(stat: Stats): DirectoryWitness {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(stat.mode),
  };
}
function directory(path: string, privateMode: boolean): DirectoryWitness {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0
  )
    fail('unsupported_source');
  return identity(stat);
}
function signature(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(':');
}
function privateRegularFile(
  path: string,
  maxBytes: number,
  privateMode: boolean,
): { bytes: Buffer; witness: FileWitness } {
  let fd: number | undefined;
  try {
    const beforePath = lstatSync(path, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink())
      fail('unsupported_source');
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      before.size > BigInt(maxBytes) ||
      (Number(before.mode) & (privateMode ? 0o077 : 0o022)) !== 0 ||
      signature(before) !== signature(beforePath)
    )
      fail('unsupported_source');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const read = readSync(fd, buffer, length, maxBytes + 1 - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      length > maxBytes ||
      BigInt(length) !== after.size ||
      signature(after) !== signature(before) ||
      signature(afterPath) !== signature(after)
    )
      fail('unsupported_source');
    const bytes = buffer.subarray(0, length);
    return {
      bytes,
      witness: {
        dev: String(after.dev),
        ino: String(after.ino),
        uid: String(after.uid),
        mode: String(after.mode),
        size: String(after.size),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs),
        birthtimeNs: String(after.birthtimeNs),
        sha256: sha(bytes),
      },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseProviders(
  bytes: Buffer,
  selectedId: string,
): { selectedConnectionSha256: string; staticKeySha256: string } {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length > 4096)
    fail('unsupported_source');
  // FileStorageAdapter accepts the outer array; this observer additionally
  // refuses ambiguous identities or non-static credentials for its own record.
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      fail('unsupported_source');
    const row = entry as Record<string, unknown>;
    const id = string(row.id);
    if (seen.has(id)) fail('unsupported_source');
    seen.add(id);
    if (id === selectedId) selected = row;
  }
  if (
    // biome-ignore lint/complexity/useOptionalChain: Retain the reviewed explicit missing-selection guard.
    !selected ||
    selected.enabled !== true ||
    (selected.type !== 'anthropic' && selected.type !== 'google') ||
    !Array.isArray(selected.capabilities) ||
    !selected.capabilities.includes('llm') ||
    selected.config === null ||
    typeof selected.config !== 'object' ||
    Array.isArray(selected.config)
  )
    fail('unsupported_source');
  const config = selected.config as Record<string, unknown>;
  const apiKey = string(config.apiKey, 16384);
  if (apiKey.trim().length === 0) fail('unsupported_source');
  return {
    selectedConnectionSha256: sha(canonical(selected)),
    staticKeySha256: sha(apiKey),
  };
}
function parseRecord(bytes: Buffer): PrivateRecord {
  const parsed = object(JSON.parse(bytes.toString('utf8')), [
    'schema',
    'observationId',
    'observedAtMs',
    'expiresAtMs',
    'connectionId',
    'principalCredentialSha256',
    'hostContextId',
    'privateHostContextWitness',
    'source',
  ]);
  if (
    parsed.schema !== 2 ||
    !ID.test(string(parsed.observationId)) ||
    !SHA.test(string(parsed.principalCredentialSha256)) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(string(parsed.privateHostContextWitness))
  )
    fail('unsupported_source');
  count(parsed.observedAtMs);
  count(parsed.expiresAtMs);
  if (Number(parsed.expiresAtMs) <= Number(parsed.observedAtMs))
    fail('unsupported_source');
  string(parsed.connectionId);
  string(parsed.hostContextId);
  const source = object(parsed.source, [
    'home',
    'config',
    'file',
    'selectedConnectionSha256',
    'staticKeySha256',
  ]);
  for (const key of ['home', 'config']) {
    const entry = object(source[key], ['dev', 'ino', 'uid', 'mode']);
    for (const value of Object.values(entry))
      if (!/^\d{1,30}$/u.test(string(value))) fail('unsupported_source');
  }
  const file = object(source.file, [
    'dev',
    'ino',
    'uid',
    'mode',
    'size',
    'mtimeNs',
    'ctimeNs',
    'birthtimeNs',
    'sha256',
  ]);
  for (const [key, value] of Object.entries(file)) {
    if (
      key === 'sha256'
        ? !SHA.test(string(value))
        : !/^\d{1,30}$/u.test(string(value))
    )
      fail('unsupported_source');
  }
  for (const key of ['selectedConnectionSha256', 'staticKeySha256'])
    if (!SHA.test(string(source[key]))) fail('unsupported_source');
  return parsed as PrivateRecord;
}

/** POSIX/current-UID credential SOURCE observations only. Every operation needs
 * current local-grant authority. Observation DTOs contain no provider credential.
 * A private opaque SDK lease can supply its witnessed key to the SDK owner;
 * it issues no grant, catalog/tariff qualification or entitlement. Same-UID/root tampering
 * and filesystem rollback require stronger external authority and are NOT solved.
 */
export class ProviderCredentialObservationStore {
  readonly #home: string;
  readonly #store: string;
  readonly #sources: ProviderCredentialObservationSources;
  readonly #liveFences = new Map<string, Fences>();
  readonly #now: () => number;

  constructor(
    projectHomeDir: string,
    sources: ProviderCredentialObservationSources,
    now: () => number = Date.now,
  ) {
    if (
      process.platform === 'win32' ||
      typeof process.getuid !== 'function' ||
      !constants.O_NOFOLLOW
    )
      fail('unsupported_source');
    this.#home = resolve(projectHomeDir);
    this.#store = join(this.#home, ...STORE_PATH);
    this.#sources = sources;
    this.#now = now;
  }

  #authorization(request: Request) {
    try {
      const lease = this.#sources.authority.requireCurrentLocalGrant(request);
      string(lease.principalCredential, 16384);
      string(lease.hostContextId);
      lease.assertCurrent();
      if (!/^[A-Za-z0-9_-]{43}$/u.test(lease.privateHostContextWitness))
        fail('authorization_unavailable');
      return lease;
    } catch {
      return fail('authorization_unavailable');
    }
  }
  #fences(): Fences {
    return {
      configuration: this.#sources.captureConfigurationFence(),
      runtime: this.#sources.captureRuntimeFence(),
    };
  }
  #checkHome(): void {
    if (realpathSync(this.#home) !== this.#home) fail('unsupported_source');
    const uid = process.getuid!();
    for (let path = dirname(this.#home); ; path = dirname(path)) {
      const parent = lstatSync(path);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (parent.uid !== uid && parent.uid !== 0) ||
        ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)
      )
        fail('unsupported_source');
      if (path === dirname(path)) break;
    }
    directory(this.#home, true);
    directory(join(this.#home, 'config'), false);
  }
  #checkStore(): void {
    this.#checkHome();
    directory(join(this.#home, 'security'), true);
    directory(this.#store, true);
  }
  #ensureStore(): void {
    this.#checkHome();
    let parent = this.#home;
    for (const segment of STORE_PATH) {
      const path = join(parent, segment);
      try {
        mkdirSync(path, { mode: 0o700 });
        this.#syncDirectory(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      directory(path, true);
      parent = path;
    }
  }
  #syncDirectory(path: string): void {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  #observe(connectionId: string): SourceWitness {
    this.#checkHome();
    const home = directory(this.#home, true);
    const config = directory(join(this.#home, 'config'), false);
    const file = privateRegularFile(
      join(this.#home, 'config', 'providers.json'),
      MAX_BYTES,
      false,
    );
    const selected = parseProviders(file.bytes, connectionId);
    const adapter = this.#sources.adapter.listProviderConnections();
    // The source witness must describe the very selection exposed by the real
    // FileStorageAdapter, not another home, stale cached row or injected key.
    if (
      sha(canonical(adapter)) !==
      sha(canonical(JSON.parse(file.bytes.toString('utf8'))))
    )
      fail('observation_obsolete');
    const confirmed = privateRegularFile(
      join(this.#home, 'config', 'providers.json'),
      MAX_BYTES,
      false,
    );
    if (canonical(file.witness) !== canonical(confirmed.witness))
      fail('observation_obsolete');
    if (
      canonical(home) !== canonical(directory(this.#home, true)) ||
      canonical(config) !==
        canonical(directory(join(this.#home, 'config'), false))
    )
      fail('observation_obsolete');
    return { home, config, file: file.witness, ...selected };
  }
  #persist(name: string, value: unknown): void {
    this.#checkStore();
    const temporary = join(this.#store, `${randomUUID()}.tmp`);
    const destination = join(this.#store, name);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_RECORD_BYTES) fail('unsupported_source');
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      // Link is no-replace atomic publication; readers reject the temporary
      // nlink=2 window. The temporary name is removed before the receipt.
      linkSync(temporary, destination);
      unlinkSync(temporary);
      fsyncSync(fd);
      this.#syncDirectory(this.#store);
    } catch {
      fail('durability_unconfirmed');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  #record(id: string): PrivateRecord {
    if (!ID.test(id)) fail('observation_unavailable');
    this.#checkStore();
    try {
      lstatSync(join(this.#store, `${id}.revoked`));
      fail('observation_obsolete');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const record = parseRecord(
      privateRegularFile(
        join(this.#store, `${id}.json`),
        MAX_RECORD_BYTES,
        true,
      ).bytes,
    );
    if (record.observationId !== id) fail('observation_unavailable');
    return record;
  }

  capture(
    request: Request,
    connectionId: string,
    lifetimeMs = 15 * 60 * 1000,
  ): ProviderCredentialObservation {
    const authority = this.#authorization(request);
    try {
      string(connectionId);
      count(lifetimeMs);
      if (lifetimeMs < 1 || lifetimeMs > 60 * 60 * 1000)
        fail('unsupported_source');
      const fences = this.#fences();
      fences.configuration();
      fences.runtime();
      this.#ensureStore();
      const source = this.#observe(connectionId);
      const now = count(this.#now());
      const expires = count(now + lifetimeMs);
      authority.assertCurrent();
      fences.configuration();
      fences.runtime();
      const record: PrivateRecord = {
        schema: 2,
        observationId: randomUUID(),
        observedAtMs: now,
        expiresAtMs: expires,
        connectionId,
        principalCredentialSha256: sha(authority.principalCredential),
        hostContextId: authority.hostContextId,
        privateHostContextWitness: authority.privateHostContextWitness,
        source,
      };
      this.#persist(`${record.observationId}.json`, record);
      if (canonical(this.#observe(connectionId)) !== canonical(source))
        fail('observation_obsolete');
      authority.assertCurrent();
      fences.configuration();
      fences.runtime();
      this.#liveFences.set(record.observationId, fences);
      return Object.freeze({
        observationId: record.observationId,
        observedAtMs: now,
        expiresAtMs: expires,
        kind: 'credential-source-observation',
      });
    } catch (error) {
      if (error instanceof ProviderCredentialObservationError) throw error;
      return fail('observation_unavailable');
    }
  }

  revalidate(
    request: Request,
    observationId: string,
  ): ProviderCredentialObservation {
    const authority = this.#authorization(request);
    try {
      const operation = this.#fences();
      operation.configuration();
      operation.runtime();
      const record = this.#record(observationId);
      if (
        record.principalCredentialSha256 !==
          sha(authority.principalCredential) ||
        record.hostContextId !== authority.hostContextId ||
        record.privateHostContextWitness !== authority.privateHostContextWitness
      )
        fail('authorization_unavailable');
      const now = count(this.#now());
      if (now < record.observedAtMs || now >= record.expiresAtMs)
        fail('observation_obsolete');
      const live = this.#liveFences.get(observationId);
      live?.configuration();
      live?.runtime();
      if (
        canonical(this.#observe(record.connectionId)) !==
        canonical(record.source)
      )
        fail('observation_obsolete');
      // Confirm no revocation/replacement became visible during the source read.
      if (canonical(this.#record(observationId)) !== canonical(record))
        fail('observation_obsolete');
      // Existence after an interrupted publish is not a durability receipt.
      // Confirm both the already-fsynced record and its directory on replay.
      const fd = openSync(
        join(this.#store, `${observationId}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(fd);
        this.#syncDirectory(this.#store);
      } catch {
        fail('durability_unconfirmed');
      } finally {
        closeSync(fd);
      }
      operation.configuration();
      operation.runtime();
      authority.assertCurrent();
      this.#liveFences.set(observationId, live ?? operation);
      return Object.freeze({
        observationId,
        observedAtMs: record.observedAtMs,
        expiresAtMs: record.expiresAtMs,
        kind: 'credential-source-observation',
      });
    } catch (error) {
      if (error instanceof ProviderCredentialObservationError) throw error;
      return fail('observation_unavailable');
    }
  }

  captureSdkCredential(
    request: Request,
    connectionId: string,
    lifetimeMs = 15 * 60 * 1000,
  ): ObservedSdkProviderCredential {
    const observation = this.capture(request, connectionId, lifetimeMs);
    const read = (): SdkCredentialValue => {
      if (request.signal.aborted) fail('authorization_unavailable');
      this.revalidate(request, observation.observationId);
      const record = this.#record(observation.observationId);
      const selected = this.#sources.adapter
        .listProviderConnections()
        .find((row) => row.id === record.connectionId);
      if (
        !selected ||
        (selected.type !== 'anthropic' && selected.type !== 'google') ||
        sha(canonical(selected)) !== record.source.selectedConnectionSha256
      )
        fail('observation_obsolete');
      const baseUrl =
        selected.type === 'anthropic'
          ? 'https://api.anthropic.com/v1'
          : 'https://generativelanguage.googleapis.com/v1beta';
      if (
        selected.config.baseUrl !== undefined &&
        selected.config.baseUrl !== baseUrl
      )
        fail('unsupported_source');
      if (selected.config.baseURL !== undefined) fail('unsupported_source');
      const apiKey = string(selected.config.apiKey, 16384);
      if (sha(apiKey) !== record.source.staticKeySha256)
        fail('observation_obsolete');
      const result: SdkCredentialValue = {
        provider: selected.type,
        connectionId: record.connectionId,
        connectionRevision: record.source.selectedConnectionSha256,
        credentialRevision: record.source.staticKeySha256,
        hostContextId: record.hostContextId,
        apiKey,
      };
      Object.defineProperty(result, 'apiKey', { enumerable: false });
      Object.freeze(result);
      this.revalidate(request, observation.observationId);
      if (request.signal.aborted) fail('authorization_unavailable');
      return result;
    };
    read();
    const credential: ObservedSdkProviderCredential = Object.freeze({
      [sdkCredentialBrand]: true,
    });
    sdkCredentials.set(credential, { request, read });
    return credential;
  }

  revoke(request: Request, observationId: string): void {
    this.revalidate(request, observationId);
    const authority = this.#authorization(request);
    authority.assertCurrent();
    this.#persist(`${observationId}.revoked`, { schema: 1, observationId });
    authority.assertCurrent();
    this.#liveFences.delete(observationId);
  }
}
