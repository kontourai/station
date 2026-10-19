/**
 * Telemetry producer tokens: the one credential admitted on Station's
 * telemetry ingest routes (`POST /v1/agent-events`, `/v1/traces`,
 * `/v1/logs`) and nowhere else.
 *
 * A producer is an external process on this machine (or, when its token
 * says so, elsewhere) that only ever WRITES monitoring rows: Flow Agents'
 * Codex/Claude Code telemetry hooks are the first. A paired-device bearer or
 * personal access token would grant it far more than that, and the per-boot
 * local grant rotates on every restart, so producers get their own class.
 *
 * Modelled on `personal-token-store.ts`: secrets are never stored (each
 * record keeps the sha256 of its secret, compared in constant time); writes
 * are atomic, owner-only and made under a cross-process lock from a fresh
 * read; an unsafe or unreadable file authenticates nobody. Unlike personal
 * tokens, an expired record is KEPT until the operator revokes it, so the
 * producer is told its token expired (403) rather than that it never existed
 * (401), and `list` shows it as expired.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

export const TELEMETRY_PRODUCERS_FILE = 'telemetry-producers.json';
/** Stored producers, active or expired. Creating one more is refused. */
export const TELEMETRY_PRODUCER_LIMIT = 32;
/** The longest expiry a token may be created with. */
export const TELEMETRY_PRODUCER_MAX_EXPIRY_DAYS = 3650;
/**
 * The secret prefix. Distinct from personal access tokens (`stp_`) and from
 * paired-device credentials (no prefix), so secret scanners can name it and
 * the two never collide.
 */
const TELEMETRY_PRODUCER_TOKEN_PREFIX = 'sti_';
const SECRET_PATTERN = /^sti_[A-Za-z0-9_-]{43}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const RECORD_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `lastUsedAt` is bookkeeping; one write per minute per producer is enough. */
const TOUCH_INTERVAL_MS = 60_000;

export interface StoredTelemetryProducer {
  name: string;
  credentialHash: string;
  createdAt: number;
  expiresAt: number | null;
  allowRemote: boolean;
  lastUsedAt: number | null;
}

interface StoredProducers {
  version: typeof RECORD_VERSION;
  producers: StoredTelemetryProducer[];
}

/** Whether `candidate` has the shape of a producer secret. Shape proves nothing. */
export function isTelemetryProducerSecret(candidate: string): boolean {
  return SECRET_PATTERN.test(candidate);
}

function isTelemetryProducerName(candidate: unknown): boolean {
  return typeof candidate === 'string' && NAME_PATTERN.test(candidate);
}

/**
 * The producer the auth boundary admitted for one request, as a Hono context
 * variable: later middleware may rebuild `c.req.raw` (the mutation budget
 * re-reads the body), so the Request object is not a stable key. Written
 * only by `runtime-http.ts` after the token, expiry and locality checks
 * passed; read by the ingest handlers to attribute the rows they write.
 */
const ADMITTED_TELEMETRY_PRODUCER_VAR = 'stationTelemetryProducer';

interface ContextVariables {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function bindAdmittedTelemetryProducer(
  context: unknown,
  name: string,
): void {
  (context as ContextVariables).set(ADMITTED_TELEMETRY_PRODUCER_VAR, name);
}

export function admittedTelemetryProducer(
  context: unknown,
): string | undefined {
  const value = (context as ContextVariables).get(
    ADMITTED_TELEMETRY_PRODUCER_VAR,
  );
  return typeof value === 'string' ? value : undefined;
}

/** What the auth boundary needs from the store. */
export type TelemetryProducerAuthority = Pick<
  TelemetryProducerStore,
  'usable' | 'find' | 'isExpired' | 'touch'
>;

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function isRecord(value: unknown): value is StoredTelemetryProducer {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isTelemetryProducerName(record.name) &&
    typeof record.credentialHash === 'string' &&
    typeof record.createdAt === 'number' &&
    (record.expiresAt === null || typeof record.expiresAt === 'number') &&
    typeof record.allowRemote === 'boolean' &&
    (record.lastUsedAt === null || typeof record.lastUsedAt === 'number')
  );
}

export type TelemetryProducerErrorCode =
  | 'invalid_request'
  | 'producer_exists'
  | 'producer_limit_reached'
  | 'producers_unavailable';

export class TelemetryProducerError extends Error {
  constructor(
    readonly code: TelemetryProducerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TelemetryProducerError';
  }
}

interface LoadedProducers {
  /** False when the file is unsafe or unreadable: nothing authenticates. */
  usable: boolean;
  producers: StoredTelemetryProducer[];
}

export class TelemetryProducerStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #now: () => number;
  #cache: { key: string; loaded: LoadedProducers } | undefined;
  /** Bounded by the store's record limit: one entry per producer touched. */
  readonly #touchedAt = new Map<string, number>();

  constructor(options: { securityDir: string; now?: () => number }) {
    this.#directory = options.securityDir;
    this.#path = join(options.securityDir, TELEMETRY_PRODUCERS_FILE);
    this.#now = options.now ?? Date.now;
  }

  now(): number {
    return this.#now();
  }

  /** Whether the file can be trusted. An untrusted file admits no producer. */
  usable(): boolean {
    return this.#current().usable;
  }

  /**
   * The stored producer whose secret is `candidate`, compared in constant
   * time; expired records included (the caller distinguishes them).
   */
  find(candidate: string): StoredTelemetryProducer | undefined {
    if (!isTelemetryProducerSecret(candidate)) return undefined;
    const candidateHash = digest(candidate);
    let match: StoredTelemetryProducer | undefined;
    for (const producer of this.#current().producers) {
      const stored = Buffer.from(producer.credentialHash, 'base64url');
      if (
        stored.length === candidateHash.length &&
        timingSafeEqual(candidateHash, stored)
      )
        match = producer;
    }
    return match ? structuredClone(match) : undefined;
  }

  isExpired(producer: Pick<StoredTelemetryProducer, 'expiresAt'>): boolean {
    return producer.expiresAt !== null && producer.expiresAt <= this.#now();
  }

  list(): StoredTelemetryProducer[] {
    const loaded = this.#current();
    if (!loaded.usable)
      throw new TelemetryProducerError(
        'producers_unavailable',
        'The telemetry producer record is unsafe or unreadable.',
      );
    return loaded.producers.map((producer) => structuredClone(producer));
  }

  /**
   * Records a new producer and returns its secret, the only time it exists.
   * The name must be unused and the store below its bound; both are decided
   * under the lock, so two processes cannot both pass.
   */
  async create(input: {
    name: string;
    allowRemote: boolean;
    expiresInDays: number | null;
  }): Promise<{ producer: StoredTelemetryProducer; secret: string }> {
    if (!isTelemetryProducerName(input.name))
      throw new TelemetryProducerError(
        'invalid_request',
        'A producer name is 1-63 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit.',
      );
    if (
      input.expiresInDays !== null &&
      (!Number.isInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > TELEMETRY_PRODUCER_MAX_EXPIRY_DAYS)
    )
      throw new TelemetryProducerError(
        'invalid_request',
        `expiresInDays must be a whole number from 1 through ${TELEMETRY_PRODUCER_MAX_EXPIRY_DAYS}.`,
      );
    const createdAt = this.#now();
    const secret = `${TELEMETRY_PRODUCER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const producer: StoredTelemetryProducer = {
      name: input.name,
      credentialHash: digest(secret).toString('base64url'),
      createdAt,
      expiresAt:
        input.expiresInDays === null
          ? null
          : createdAt + input.expiresInDays * DAY_MS,
      allowRemote: input.allowRemote,
      lastUsedAt: null,
    };
    await this.#mutate((producers) => {
      if (producers.some((held) => held.name === input.name))
        throw new TelemetryProducerError(
          'producer_exists',
          `A telemetry producer named "${input.name}" already exists. Revoke it first or choose another name.`,
        );
      if (producers.length >= TELEMETRY_PRODUCER_LIMIT)
        throw new TelemetryProducerError(
          'producer_limit_reached',
          `At most ${TELEMETRY_PRODUCER_LIMIT} telemetry producers can exist. Revoke one first.`,
        );
      return [...producers, producer];
    });
    return { producer: structuredClone(producer), secret };
  }

  /** Removes one producer; `false` when no producer has that name. */
  async revoke(name: string): Promise<boolean> {
    let found = false;
    await this.#mutate((producers) =>
      producers.filter((producer) => {
        if (producer.name !== name) return true;
        found = true;
        this.#touchedAt.delete(producer.credentialHash);
        return false;
      }),
    );
    return found;
  }

  /**
   * Records use, at most once per {@link TOUCH_INTERVAL_MS}. Never awaited on
   * the request path: a contended lock must not hold up ingest, and a failed
   * write must not refuse an event.
   */
  touch(producer: StoredTelemetryProducer): void {
    const at = this.#now();
    // The in-memory mark stops a burst that arrives before the first write
    // lands from queueing one locked rewrite per request.
    const last = Math.max(
      producer.lastUsedAt ?? Number.NEGATIVE_INFINITY,
      this.#touchedAt.get(producer.credentialHash) ?? Number.NEGATIVE_INFINITY,
    );
    if (at - last < TOUCH_INTERVAL_MS) return;
    this.#touchedAt.set(producer.credentialHash, at);
    void this.#mutate((producers) =>
      producers.map((held) =>
        held.name === producer.name &&
        held.credentialHash === producer.credentialHash
          ? { ...held, lastUsedAt: at }
          : held,
      ),
    ).catch(() => {});
  }

  /** The file as it is now, re-read whenever it changed. */
  #current(): LoadedProducers {
    let key: string;
    try {
      const status = statSync(this.#path);
      key = `${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
    } catch {
      return { usable: !existsSync(this.#path), producers: [] };
    }
    if (this.#cache?.key === key) return this.#cache.loaded;
    const loaded = this.#load();
    this.#cache = { key, loaded };
    return loaded;
  }

  #load(): LoadedProducers {
    if (!existsSync(this.#path)) return { usable: true, producers: [] };
    try {
      const status = lstatSync(this.#path);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          (status.mode & 0o777) !== PRIVATE_FILE_MODE)
      )
        return { usable: false, producers: [] };
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as {
        version?: unknown;
        producers?: unknown;
      };
      if (
        parsed.version !== RECORD_VERSION ||
        !Array.isArray(parsed.producers) ||
        !parsed.producers.every(isRecord)
      )
        return { usable: false, producers: [] };
      return { usable: true, producers: parsed.producers };
    } catch {
      return { usable: false, producers: [] };
    }
  }

  /**
   * Applies `update` to a fresh read under the cross-process lock. Refuses
   * to write over a file it cannot trust, which would discard its records.
   */
  async #mutate(
    update: (producers: StoredTelemetryProducer[]) => StoredTelemetryProducer[],
  ): Promise<void> {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(
      `${this.#path}.mutation`,
    );
    try {
      const loaded = this.#load();
      if (!loaded.usable)
        throw new TelemetryProducerError(
          'producers_unavailable',
          'The telemetry producer record is unsafe or unreadable.',
        );
      this.#write(update(loaded.producers));
    } finally {
      await release();
      this.#cache = undefined;
    }
  }

  #write(producers: StoredTelemetryProducer[]): void {
    const record: StoredProducers = { version: RECORD_VERSION, producers };
    const candidate = `${this.#path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, 'wx', PRIVATE_FILE_MODE);
      writeFileSync(descriptor, JSON.stringify(record), { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(candidate, this.#path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(candidate, { force: true });
    }
  }
}
