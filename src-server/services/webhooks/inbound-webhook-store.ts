import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  InboundWebhookConfiguration,
  InboundWebhookStartGrant,
  InboundWebhookToken,
} from '@kontourai/station-contracts/inbound-webhook';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import type {
  ReplayLedger,
  ReplayReservation,
  WebhookRefusalReason,
} from '@kontourai/telltale';
import { isNonEmptyString } from '../../utils/non-empty-string.js';

const CONFIG_FILE = 'inbound-webhooks.json';
const REPLAY_FILE = 'inbound-webhook-replays.json';
const AUDIT_FILE = 'inbound-webhook-audit.json';

/** Enough recent failures for operator diagnosis without creating an attacker-owned log. */
const INBOUND_WEBHOOK_AUDIT_MAX_ENTRIES = 256;
/**
 * Bounded durable replay keys; at five minutes this accommodates 2,000
 * requests/minute. Past it a reservation is refused, never evicted.
 */
const INBOUND_WEBHOOK_REPLAY_MAX_ENTRIES = 10_000;
/**
 * Review L2: an HMAC secret shorter than this is brute-forceable within the
 * cost of the requests it's meant to gate. Enforced at both `read()` and
 * `write()` so a hand-authored config with a weak secret fails closed rather
 * than being silently accepted the first time it's read.
 */
const INBOUND_WEBHOOK_MIN_SECRET_LENGTH = 32;

export class InboundWebhookConfigurationError extends Error {
  constructor(message = 'Inbound webhook configuration is unavailable.') {
    super(message);
    this.name = 'InboundWebhookConfigurationError';
  }
}

function isStartGrant(value: unknown): value is InboundWebhookStartGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    isNonEmptyString(grant.agentId) &&
    (grant.projectSlug === undefined || isNonEmptyString(grant.projectSlug))
  );
}

function isToken(value: unknown): value is InboundWebhookToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return (
    isNonEmptyString(token.id) &&
    isNonEmptyString(token.name) &&
    isNonEmptyString(token.secret) &&
    (token.revokedAt === undefined || isNonEmptyString(token.revokedAt)) &&
    (token.starts === undefined ||
      (Array.isArray(token.starts) && token.starts.every(isStartGrant)))
  );
}

function isConfiguration(value: unknown): value is InboundWebhookConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    config.schemaVersion === 1 &&
    (config.enabled === undefined || typeof config.enabled === 'boolean') &&
    (config.tokens === undefined ||
      (Array.isArray(config.tokens) && config.tokens.every(isToken)))
  );
}

function securityPath(homeDir: string, file: string): string {
  return join(homeDir, 'security', file);
}

function writePrivateJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // The shared durable writer owns the temporary (created O_EXCL, removed on
  // failure so no secret-bearing scratch file survives), the data fsync and
  // the directory fsync. `trailingNewline: false` keeps this file's existing
  // two-space document byte for byte.
  writeJsonDurably(path, value, { trailingNewline: false });
  chmodSync(path, 0o600);
}

/**
 * Review L2: throws a legible, actionable `InboundWebhookConfigurationError`
 * naming the offending token id and the floor the moment a shape-valid
 * configuration contains a secret under {@link INBOUND_WEBHOOK_MIN_SECRET_LENGTH}
 * characters. Runs after `isConfiguration` so every field it reads is
 * already known to be a non-empty string.
 */
function assertSecretFloor(configuration: InboundWebhookConfiguration): void {
  assertTokenIds(configuration);
  for (const token of configuration.tokens ?? []) {
    if (token.secret.length < INBOUND_WEBHOOK_MIN_SECRET_LENGTH) {
      throw new InboundWebhookConfigurationError(
        `Inbound webhook token "${token.id}" has a secret shorter than the required ${INBOUND_WEBHOOK_MIN_SECRET_LENGTH}-character floor. Rotate it to a longer secret.`,
      );
    }
  }
}

/** The documented token-id format, the one the request header must match. */
const INBOUND_WEBHOOK_TOKEN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Every token id must have the documented format and must not contain any
 * configured secret. Telltale redacts every secret it has verified with from
 * what it emits and logs, so an id holding a secret would read back as
 * another string (`ci-[redacted]`) and could shadow a different token, and
 * the audit would store the secret itself. A refused token is named by its
 * position, never by its id, so the message cannot echo a secret.
 */
function assertTokenIds(configuration: InboundWebhookConfiguration): void {
  const tokens = configuration.tokens ?? [];
  tokens.forEach((token, index) => {
    if (!INBOUND_WEBHOOK_TOKEN_ID.test(token.id)) {
      throw new InboundWebhookConfigurationError(
        `Inbound webhook token at position ${index + 1} has an id that is not 1 to 128 letters, digits, _ or -. Rename it.`,
      );
    }
    if (tokens.some((other) => token.id.includes(other.secret))) {
      throw new InboundWebhookConfigurationError(
        `Inbound webhook token at position ${index + 1} has an id that contains a webhook secret. Rename it and rotate that secret.`,
      );
    }
  });
}

/**
 * Read on every request: token revocation and the global off switch therefore
 * take effect before the next request is admitted, without a restart/cache.
 */
export class InboundWebhookConfigurationStore {
  constructor(private readonly homeDir: string) {}

  read(): InboundWebhookConfiguration {
    const path = securityPath(this.homeDir, CONFIG_FILE);
    if (!existsSync(path)) return { schemaVersion: 1 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isConfiguration(parsed)) throw new Error('invalid shape');
      assertSecretFloor(parsed);
      return structuredClone(parsed);
    } catch (error) {
      // A weak-secret refusal already carries its own legible, specific
      // message (review L2); only a generic parse/shape failure collapses
      // to the fail-closed default message.
      if (error instanceof InboundWebhookConfigurationError) throw error;
      throw new InboundWebhookConfigurationError();
    }
  }

  write(configuration: InboundWebhookConfiguration): void {
    if (!isConfiguration(configuration)) {
      throw new InboundWebhookConfigurationError();
    }
    assertSecretFloor(configuration);
    writePrivateJson(securityPath(this.homeDir, CONFIG_FILE), configuration);
  }
}

type ReplayEntry = {
  key: string;
  expiresAt: number;
  /**
   * Absent on entries written before the Telltale ledger; they are migrated
   * as they are read (see {@link migrateLegacyEntry}).
   */
  state?: 'reserved' | 'delivered';
  token?: string;
};

function readReplayEntries(path: string): ReplayEntry[] {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('invalid replay ledger');
  if (
    !value.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as ReplayEntry;
      return (
        typeof candidate.key === 'string' &&
        typeof candidate.expiresAt === 'number' &&
        Number.isFinite(candidate.expiresAt) &&
        (candidate.state === undefined ||
          candidate.state === 'reserved' ||
          candidate.state === 'delivered') &&
        (candidate.token === undefined || typeof candidate.token === 'string')
      );
    })
  ) {
    throw new Error('invalid replay ledger');
  }
  return (value as ReplayEntry[]).map(migrateLegacyEntry);
}

/**
 * Before the Telltale ledger, an entry was claimed once the request was
 * accepted and kept while `expiresAt > now`, with `expiresAt` the last fresh
 * instant (`max(now, signedAt) + window`, freshness inclusive). Telltale's
 * `expiresAt` is the first instant the key is free again, so an old entry
 * moves one millisecond later. The next write stores it with a `state`, so
 * it is never moved twice. Without this, the identical request at exactly
 * `signedAt + window` would still be fresh and no longer held (#4837).
 */
function migrateLegacyEntry(entry: ReplayEntry): ReplayEntry {
  if (entry.state !== undefined) return entry;
  return { key: entry.key, expiresAt: entry.expiresAt + 1, state: 'delivered' };
}

/**
 * Durable replay ledger behind Telltale's webhook source (its `ReplayLedger`
 * binding). A corrupt, unwritable or full ledger throws, which Telltale
 * answers with `policy_unavailable`, so replay protection is never silently
 * removed.
 *
 * Atomicity: each method is one synchronous read, decision and write of the
 * file, with nothing awaited in between, so within the one server that owns
 * a Station home no other request can interleave. `extend`, `commit` and
 * `release` compare the owner token in that same step. A ledger shared by
 * several processes would need a cross-process lock and fencing; Station's
 * supported shape is one server per home. Every method settles synchronously.
 */
export class InboundWebhookReplayStore implements ReplayLedger {
  constructor(private readonly homeDir: string) {}

  /**
   * Takes `key` until `expiresAt`, the first instant the key is free again
   * (Telltale passes the first instant the request is stale, so freshness and
   * replay share one boundary, #4837). A full ledger refuses rather than
   * evicting a live key, which would reopen that key's replay window.
   */
  reserve(key: string, expiresAt: number, now: number): ReplayReservation {
    return this.#mutate<ReplayReservation>((entries) => {
      const live = entries.filter((entry) => now < entry.expiresAt);
      if (live.some((entry) => entry.key === key))
        return { result: { outcome: 'replayed' } };
      if (live.length >= INBOUND_WEBHOOK_REPLAY_MAX_ENTRIES)
        throw new Error('replay ledger full of live keys');
      const token = randomUUID();
      live.push({ key, expiresAt, state: 'reserved', token });
      return {
        write: live,
        result: { outcome: 'reserved', token },
      };
    });
  }

  extend(key: string, token: string, expiresAt: number, now: number): boolean {
    return this.#mutate((entries) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (
        entry?.token !== token ||
        entry.state !== 'reserved' ||
        now >= entry.expiresAt
      )
        return { result: false };
      entry.expiresAt = Math.max(entry.expiresAt, expiresAt);
      return { write: entries, result: true };
    });
  }

  commit(key: string, token: string): boolean {
    return this.#mutate((entries) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (entry?.token !== token) return { result: false };
      entry.state = 'delivered';
      return { write: entries, result: true };
    });
  }

  release(key: string, token: string): boolean {
    return this.#mutate((entries) => {
      const index = entries.findIndex(
        (candidate) =>
          candidate.key === key &&
          candidate.token === token &&
          candidate.state === 'reserved',
      );
      if (index < 0) return { result: false };
      entries.splice(index, 1);
      return { write: entries, result: true };
    });
  }

  #mutate<T>(
    decide: (entries: ReplayEntry[]) => { write?: ReplayEntry[]; result: T },
  ): T {
    const path = securityPath(this.homeDir, REPLAY_FILE);
    try {
      const { write, result } = decide(readReplayEntries(path));
      if (write) writePrivateJson(path, write);
      return result;
    } catch {
      throw new InboundWebhookConfigurationError();
    }
  }
}

/**
 * Every refusal Telltale's webhook source makes, plus the one Station makes
 * after Telltale accepted a request: a start the token's grants forbid.
 */
export type InboundWebhookAuditReason =
  | WebhookRefusalReason
  | 'forbidden_start';

/**
 * Review M2/M3: two outcomes beyond a single-request refusal reason.
 * `accepted` durably binds a successful start's token id to its started
 * conversation (M3). `unauthenticated_flood` is one AGGREGATED entry
 * standing in for many individually-suppressed refusals recorded once the
 * unauthenticated-attempt budget trips (M2); Telltale's webhook source
 * aggregates them and writes through the audit binding.
 */
type InboundWebhookAuditOutcome =
  | InboundWebhookAuditReason
  | 'accepted'
  | 'unauthenticated_flood';

type AuditEntry = {
  at: string;
  reason: InboundWebhookAuditOutcome;
  tokenId?: string;
  /** M3: the conversation a successful `accepted` entry started. */
  conversationId?: string;
  /** M2: how many suppressed refusals one `unauthenticated_flood` entry represents. */
  count?: number;
};

/** Bounded local audit; it deliberately contains no payload, nonce, or secret. */
export class InboundWebhookAuditStore {
  constructor(private readonly homeDir: string) {}

  record(reason: InboundWebhookAuditReason, tokenId: string | undefined): void {
    this.write({ reason, tokenId });
  }

  /**
   * Review M3: the one durable record binding a webhook token id to the
   * conversation it started. Without this, an accepted start is visible only
   * as an OTel counter — invisible without an OTLP endpoint, and never
   * answering "which sessions did this token start?" from disk.
   */
  recordSuccess(tokenId: string, conversationId: string): void {
    this.write({ reason: 'accepted', tokenId, conversationId });
  }

  /**
   * Review M2: one aggregated entry standing in for `count` suppressed
   * refusals that arrived after the unauthenticated budget tripped. Keeping
   * this to at most one write per flush interval (Telltale's webhook source
   * aggregates, at most once a minute) is what stops a rotating-token-id flood
   * from evicting earlier, more diagnostically useful entries out of the
   * bounded 256-entry ring buffer.
   */
  recordAggregatedNoise(count: number): void {
    if (count <= 0) return;
    this.write({ reason: 'unauthenticated_flood', count });
  }

  private write(entry: {
    reason: InboundWebhookAuditOutcome;
    tokenId?: string;
    conversationId?: string;
    count?: number;
  }): void {
    const path = securityPath(this.homeDir, AUDIT_FILE);
    try {
      const current = existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as unknown)
        : [];
      const entries = Array.isArray(current)
        ? current.filter(
            (candidate): candidate is AuditEntry =>
              !!candidate &&
              typeof candidate === 'object' &&
              typeof (candidate as AuditEntry).at === 'string' &&
              typeof (candidate as AuditEntry).reason === 'string',
          )
        : [];
      entries.push({
        at: new Date().toISOString(),
        reason: entry.reason,
        ...(entry.tokenId ? { tokenId: entry.tokenId } : {}),
        ...(entry.conversationId
          ? { conversationId: entry.conversationId }
          : {}),
        ...(entry.count !== undefined ? { count: entry.count } : {}),
      });
      writePrivateJson(path, entries.slice(-INBOUND_WEBHOOK_AUDIT_MAX_ENTRIES));
    } catch {
      // Authentication remains fail-closed; a disk failure cannot become a
      // second request failure oracle or expose attacker-controlled content.
    }
  }

  read(): readonly AuditEntry[] {
    const path = securityPath(this.homeDir, AUDIT_FILE);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
