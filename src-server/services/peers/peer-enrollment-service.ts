import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  CLIENT_PROTOCOL_HEADER,
  PAIRING_SCOPE_PRESETS,
  type PeerEnrollment,
  type PeerEnrollmentInput,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  PeerCredentialMutationAuthorizationError,
  type PeerCredentialStore,
} from './peer-credential-store.js';

const DELEGATION_SCOPE = PAIRING_SCOPE_PRESETS.delegation.join(' ');
const MAX_RESPONSE_BYTES = 16_384;
const OFFER_ID = /^[A-Za-z0-9_-]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_ENROLLMENTS = 32;
const RETENTION_MS = 15 * 60_000;
const STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'connected',
  'denied',
  'expired',
  'unavailable',
  'identity-changed',
  'failed',
  'outcome-unknown',
  'persistence-failed',
  'cancelled',
]);

type EnrollmentState = {
  view: PeerEnrollment;
  offerId?: string;
  proof?: string;
  requestId?: string;
  credential?: string;
  flight?: Promise<PeerEnrollment>;
  phase?: 'requesting' | 'exchanging';
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControls(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function enrollmentOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Invalid Station address');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use a bare Station http(s) address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const [a, b] = host.split('.').map(Number);
  const privateIp =
    isIP(host) === 4 &&
    (a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127));
  const localHost =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local');
  if (url.protocol === 'http:' && !privateIp && !localHost)
    throw new Error('Public Station addresses require HTTPS');
  return url.origin;
}

/** Durable mutation ownership serializes each exchange; proofs and bearers stay server-side. */
export class PeerEnrollmentService {
  readonly #states = new Map<string, EnrollmentState>();

  readonly #directory: string;
  constructor(
    private readonly store: PeerCredentialStore,
    private readonly stationName: string,
    home: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.#directory = join(home, 'security', 'peer-enrollments');
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.#directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o777) !== 0o700)
    )
      throw new Error('Unsafe peer enrollment directory');
  }

  #readState(id: string): EnrollmentState {
    const path = join(this.#directory, `${id}.json`);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > MAX_RESPONSE_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
    )
      throw new Error('Unsafe peer enrollment record');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let parsed: unknown;
    try {
      const opened = fstatSync(fd);
      if (
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.nlink !== 1
      )
        throw new Error('Peer enrollment record changed while reading');
      parsed = JSON.parse(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
    if (
      !record(parsed) ||
      !record(parsed.view) ||
      parsed.view.id !== id ||
      typeof parsed.view.expiresAt !== 'number' ||
      typeof parsed.view.apiBase !== 'string' ||
      typeof parsed.view.environmentId !== 'string' ||
      typeof parsed.view.status !== 'string' ||
      !STATUSES.has(parsed.view.status) ||
      !Number.isSafeInteger(parsed.view.expiresAt) ||
      (parsed.view.label !== null && typeof parsed.view.label !== 'string') ||
      (parsed.view.error !== undefined &&
        typeof parsed.view.error !== 'string') ||
      Object.keys(parsed.view).some(
        (key) =>
          ![
            'id',
            'apiBase',
            'environmentId',
            'label',
            'status',
            'expiresAt',
            'error',
          ].includes(key),
      ) ||
      Object.keys(parsed).some(
        (key) =>
          ![
            'view',
            'offerId',
            'proof',
            'requestId',
            'credential',
            'phase',
          ].includes(key),
      ) ||
      ['offerId', 'proof', 'requestId', 'credential'].some(
        (key) => parsed[key] !== undefined && typeof parsed[key] !== 'string',
      ) ||
      (parsed.phase !== undefined &&
        parsed.phase !== 'requesting' &&
        parsed.phase !== 'exchanging')
    )
      throw new Error('Invalid peer enrollment record');
    const state = parsed as EnrollmentState;
    enrollmentOrigin(state.view.apiBase);
    return state;
  }

  async #exclusive<T>(
    authorize: () => boolean,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
    const release = await acquireFileMutationLockAsync(
      `${this.#directory}.mutation`,
    );
    try {
      if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
      this.#states.clear();
      for (const file of readdirSync(this.#directory)) {
        if (/^[a-f0-9-]{36}\.json$/.test(file)) {
          const state = this.#readState(file.slice(0, -5));
          this.#states.set(state.view.id, state);
        }
      }
      this.#prune();
      return await operation();
    } finally {
      await release();
    }
  }

  #save(state: EnrollmentState, reserve = false) {
    const { flight: _flight, ...persisted } = state;
    const payload = JSON.stringify(persisted);
    if (Buffer.byteLength(payload, 'utf8') > MAX_RESPONSE_BYTES)
      throw new Error('Peer enrollment record too large');
    const directory = lstatSync(this.#directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o777) !== 0o700)
    )
      throw new Error('Unsafe peer enrollment directory');
    const path = join(this.#directory, `${state.view.id}.json`);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
      )
        throw new Error('Unsafe peer enrollment record');
    }
    const temporary = reserve
      ? path
      : join(this.#directory, `${state.view.id}.${randomUUID()}.tmp`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (process.platform !== 'win32') fchmodSync(fd, 0o600);
      writeFileSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (!reserve) renameSync(temporary, path);
      fsyncDirectorySync(this.#directory);
    } finally {
      if (!reserve) rmSync(temporary, { force: true });
    }
  }

  #isSaved(state: EnrollmentState): boolean {
    if (!state.credential) return false;
    const saved = this.store.get(state.view.environmentId);
    return (
      saved?.credential === state.credential &&
      saved.apiBase === state.view.apiBase &&
      saved.scope === DELEGATION_SCOPE
    );
  }

  async get(id: string, authorize: () => boolean): Promise<PeerEnrollment> {
    if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
    if (!UUID.test(id)) throw new Error('Invalid enrollment id');
    const release = await acquireFileMutationLockAsync(
      `${this.#directory}.mutation`,
    );
    try {
      if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
      const path = join(this.#directory, `${id}.json`);
      if (!existsSync(path)) throw new Error('Enrollment unavailable');
      const state = this.#readState(id);
      if (this.#isSaved(state))
        return { ...state.view, status: 'connected', error: undefined };
      if (state.phase)
        return {
          ...state.view,
          status: 'outcome-unknown',
          error:
            'A previous remote operation has no receipt; cancel locally and reconcile the receiver grant before starting again',
        };
      return { ...state.view };
    } finally {
      await release();
    }
  }

  async #request(
    origin: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; value: unknown }> {
    const response = await fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        [CLIENT_PROTOCOL_HEADER]: String(STATION_COMPAT_PROTOCOL_VERSION),
        ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (
      response.headers.get('content-length') &&
      Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error('Station response too large');
    }
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            throw new Error('Station response too large');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return {
      status: response.status,
      value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
  }

  #prune() {
    for (const [id, state] of this.#states) {
      if (!state.flight && state.view.expiresAt + RETENTION_MS < Date.now()) {
        this.#states.delete(id);
        rmSync(join(this.#directory, `${id}.json`), { force: true });
      }
    }
  }

  async start(
    input: PeerEnrollmentInput,
    authorize: () => boolean,
  ): Promise<PeerEnrollment> {
    return this.#exclusive(authorize, () => this.#start(input, authorize));
  }

  async #start(
    input: PeerEnrollmentInput,
    authorize: () => boolean,
  ): Promise<PeerEnrollment> {
    if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
    const origin = enrollmentOrigin(input.apiBase);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        input.id,
      )
    )
      throw new Error('Invalid enrollment id');
    const existing = this.#states.get(input.id);
    if (existing) {
      if (
        existing.view.apiBase !== origin ||
        existing.view.environmentId !== input.environmentId ||
        existing.view.label !== (input.label?.trim() || null)
      )
        throw new Error('Enrollment id belongs to another intent');
      if (existing.phase)
        return this.#finish(
          existing,
          'outcome-unknown',
          'A previous remote operation ended without a receipt; reconcile the receiver grant',
        );
      return { ...existing.view };
    }
    if (
      typeof input.environmentId !== 'string' ||
      !input.environmentId.trim() ||
      input.environmentId.length > 200 ||
      hasControls(input.environmentId) ||
      (input.label !== undefined &&
        (typeof input.label !== 'string' ||
          input.label.length > 64 ||
          hasControls(input.label)))
    )
      throw new Error('Invalid Station identity or label');
    this.#prune();
    if (this.#states.size >= MAX_ENROLLMENTS)
      throw new Error('Too many retained enrollments');
    const state: EnrollmentState = {
      view: {
        id: input.id,
        apiBase: origin,
        environmentId: input.environmentId,
        label: input.label?.trim() || null,
        status: 'pending',
        expiresAt: Date.now() + RETENTION_MS,
      },
    };
    state.phase = 'requesting';
    this.#save(state, true);
    this.#states.set(state.view.id, state);
    try {
      const handshake = await this.#request(
        origin,
        PUBLIC_STATION_HANDSHAKE_PATH,
      );
      if (
        handshake.status !== 200 ||
        parsePublicStationHandshake(handshake.value)?.environmentId !==
          input.environmentId
      )
        return this.#finish(state, 'identity-changed');
      if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
      const requested = await this.#request(
        origin,
        PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
        { deviceName: this.stationName.slice(0, 64), kind: 'delegation' },
      );
      const value = requested.value;
      if (!authorize()) {
        this.#finish(
          state,
          'outcome-unknown',
          'Local authority changed after the receiver request',
        );
        throw new PeerCredentialMutationAuthorizationError();
      }
      if (
        requested.status !== 202 ||
        !record(value) ||
        value.kind !== 'delegation' ||
        value.environmentId !== input.environmentId ||
        typeof value.offerId !== 'string' ||
        !OFFER_ID.test(value.offerId) ||
        typeof value.proof !== 'string' ||
        !SECRET.test(value.proof) ||
        typeof value.requestId !== 'string' ||
        !UUID.test(value.requestId) ||
        typeof value.expiresAt !== 'number' ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= Date.now() ||
        value.expiresAt > Date.now() + RETENTION_MS
      )
        return this.#finish(
          state,
          'failed',
          'Receiver did not accept a peer request',
        );
      state.offerId = value.offerId;
      state.proof = value.proof;
      state.requestId = value.requestId;
      state.view.expiresAt = value.expiresAt;
      state.phase = undefined;
      this.#save(state);
      return { ...state.view };
    } catch (error) {
      if (error instanceof PeerCredentialMutationAuthorizationError)
        throw error;
      return this.#finish(
        state,
        'outcome-unknown',
        'The receiver may have recorded this request; check it before trying again',
      );
    }
  }

  #finish(
    state: EnrollmentState,
    status: PeerEnrollment['status'],
    error?: string,
  ): PeerEnrollment {
    state.phase = undefined;
    state.view.status = status;
    state.view.error = error;
    state.proof = undefined;
    state.credential = undefined;
    this.#save(state);
    return { ...state.view };
  }

  async cancel(id: string, authorize: () => boolean): Promise<PeerEnrollment> {
    return this.#exclusive(authorize, () => this.#cancel(id, authorize));
  }

  #cancel(id: string, authorize: () => boolean): PeerEnrollment {
    if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
    const state = this.#states.get(id);
    if (!state)
      throw new Error(
        'Enrollment unavailable; this Station may have restarted',
      );
    if (this.#isSaved(state)) this.#finish(state, 'connected');
    if (state.view.status === 'connected')
      throw new Error('Remove the saved peer connection to disconnect it');
    return this.#finish(
      state,
      'cancelled',
      'Local enrollment cancelled; revoke any approved grant on the receiver',
    );
  }

  async complete(
    id: string,
    authorize: () => boolean,
  ): Promise<PeerEnrollment> {
    return this.#exclusive(authorize, async () => {
      const state = this.#states.get(id);
      if (!state)
        throw new Error(
          'Enrollment unavailable; this Station may have restarted',
        );
      if (this.#isSaved(state)) return this.#finish(state, 'connected');
      if (state.phase)
        return this.#finish(
          state,
          'outcome-unknown',
          'A previous exchange ended without a receipt; reconcile the receiver grant before starting again',
        );
      return this.#complete(state, authorize);
    });
  }

  async #complete(
    state: EnrollmentState,
    authorize: () => boolean,
  ): Promise<PeerEnrollment> {
    if (state.phase === 'requesting') return { ...state.view };
    if (!['pending', 'persistence-failed'].includes(state.view.status))
      return { ...state.view };
    if (
      Date.now() >=
      state.view.expiresAt + (state.credential ? RETENTION_MS : 0)
    )
      return this.#finish(state, 'expired');
    if (!state.credential) {
      try {
        const handshake = await this.#request(
          state.view.apiBase,
          PUBLIC_STATION_HANDSHAKE_PATH,
        );
        if (
          handshake.status !== 200 ||
          parsePublicStationHandshake(handshake.value)?.environmentId !==
            state.view.environmentId
        )
          return this.#finish(state, 'identity-changed');
        if (!authorize()) throw new PeerCredentialMutationAuthorizationError();
        state.phase = 'exchanging';
        this.#save(state);
        const response = await this.#request(
          state.view.apiBase,
          PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
          {
            offerId: state.offerId,
            proof: state.proof,
            requestId: state.requestId,
          },
        );
        const value = response.value;
        if (
          record(value) &&
          value.error === 'request_not_confirmed' &&
          response.status === 409
        ) {
          state.phase = undefined;
          this.#save(state);
          return { ...state.view };
        }
        if (
          record(value) &&
          value.error === 'request_denied' &&
          response.status === 403
        )
          return this.#finish(state, 'denied');
        if (
          record(value) &&
          value.error === 'offer_expired' &&
          response.status === 410
        )
          return this.#finish(state, 'expired');
        if (record(value) && value.error === 'offer_unavailable')
          return this.#finish(state, 'unavailable');
        state.proof = undefined;
        if (
          response.status !== 200 ||
          !record(value) ||
          value.environmentId !== state.view.environmentId ||
          !record(value.device) ||
          value.device.kind !== 'delegation' ||
          value.device.scope !== DELEGATION_SCOPE ||
          typeof value.credential !== 'string' ||
          !SECRET.test(value.credential)
        )
          return this.#finish(
            state,
            'failed',
            'Receiver did not issue the requested peer grant',
          );
        state.credential = value.credential;
        state.phase = undefined;
        state.view.status = 'persistence-failed';
        this.#save(state);
      } catch (error) {
        if (error instanceof PeerCredentialMutationAuthorizationError)
          throw error;
        return this.#finish(
          state,
          'outcome-unknown',
          'Exchange outcome is unknown; check or revoke the receiver grant before starting again',
        );
      }
    }
    const issuedCredential = state.credential;
    try {
      await this.store.upsert(
        {
          environmentId: state.view.environmentId,
          apiBase: state.view.apiBase,
          credential: state.credential,
          scope: DELEGATION_SCOPE,
          ...(state.view.label ? { label: state.view.label } : {}),
        },
        authorize,
      );
      return this.#finish(state, 'connected');
    } catch (error) {
      state.credential = issuedCredential;
      state.view.status = 'persistence-failed';
      state.view.error =
        'Grant issued but not saved locally; retry saving before expiry or revoke it on the receiver';
      this.#save(state);
      if (error instanceof PeerCredentialMutationAuthorizationError)
        throw error;
      return { ...state.view };
    }
  }
}
