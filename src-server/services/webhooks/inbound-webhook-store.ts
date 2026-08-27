import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  InboundWebhookConfiguration,
  InboundWebhookStartGrant,
  InboundWebhookToken,
} from '@kontourai/station-contracts/inbound-webhook';

const CONFIG_FILE = 'inbound-webhooks.json';
const REPLAY_FILE = 'inbound-webhook-replays.json';
const AUDIT_FILE = 'inbound-webhook-audit.json';

/** Enough recent failures for operator diagnosis without creating an attacker-owned log. */
export const INBOUND_WEBHOOK_AUDIT_MAX_ENTRIES = 256;
/** Bounded durable replay keys; at five minutes this accommodates 2,000 requests/minute. */
export const INBOUND_WEBHOOK_REPLAY_MAX_ENTRIES = 10_000;
/**
 * Review L2: an HMAC secret shorter than this is brute-forceable within the
 * cost of the requests it's meant to gate. Enforced at both `read()` and
 * `write()` so a hand-authored config with a weak secret fails closed rather
 * than being silently accepted the first time it's read.
 */
export const INBOUND_WEBHOOK_MIN_SECRET_LENGTH = 32;

export class InboundWebhookConfigurationError extends Error {
  constructor(message = 'Inbound webhook configuration is unavailable.') {
    super(message);
    this.name = 'InboundWebhookConfigurationError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Do not hide the original write failure.
      }
    }
  }
}

/**
 * Review L2: throws a legible, actionable `InboundWebhookConfigurationError`
 * naming the offending token id and the floor the moment a shape-valid
 * configuration contains a secret under {@link INBOUND_WEBHOOK_MIN_SECRET_LENGTH}
 * characters. Runs after `isConfiguration` so every field it reads is
 * already known to be a non-empty string.
 */
function assertSecretFloor(configuration: InboundWebhookConfiguration): void {
  for (const token of configuration.tokens ?? []) {
    if (token.secret.length < INBOUND_WEBHOOK_MIN_SECRET_LENGTH) {
      throw new InboundWebhookConfigurationError(
        `Inbound webhook token "${token.id}" has a secret shorter than the required ${INBOUND_WEBHOOK_MIN_SECRET_LENGTH}-character floor. Rotate it to a longer secret.`,
      );
    }
  }
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

type ReplayEntry = { key: string; expiresAt: number };

function readReplayEntries(path: string): ReplayEntry[] {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('invalid replay ledger');
  if (
    !value.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as ReplayEntry).key === 'string' &&
        typeof (entry as ReplayEntry).expiresAt === 'number' &&
        Number.isFinite((entry as ReplayEntry).expiresAt),
    )
  ) {
    throw new Error('invalid replay ledger');
  }
  return value as ReplayEntry[];
}

/** Durable nonce ledger. A corrupt ledger fails closed so replay protection is never silently removed. */
export class InboundWebhookReplayStore {
  constructor(private readonly homeDir: string) {}

  claim(key: string, expiresAt: number, now: number): 'claimed' | 'replayed' {
    const path = securityPath(this.homeDir, REPLAY_FILE);
    let entries: ReplayEntry[];
    try {
      entries = readReplayEntries(path).filter(
        (entry) => entry.expiresAt > now,
      );
      if (entries.some((entry) => entry.key === key)) return 'replayed';
      entries.push({ key, expiresAt });
      writePrivateJson(
        path,
        entries.slice(-INBOUND_WEBHOOK_REPLAY_MAX_ENTRIES),
      );
      return 'claimed';
    } catch {
      throw new InboundWebhookConfigurationError();
    }
  }
}

export type InboundWebhookAuditReason =
  | 'disabled'
  | 'unknown_token'
  | 'revoked_token'
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'replay'
  | 'forbidden_start'
  | 'malformed_request'
  | 'rate_limited'
  | 'policy_unavailable';

/**
 * Review M2/M3: two outcomes beyond a single-request refusal reason.
 * `accepted` durably binds a successful start's token id to its started
 * conversation (M3). `unauthenticated_flood` is one AGGREGATED entry
 * standing in for many individually-suppressed refusals recorded once the
 * unauthenticated-attempt budget trips (M2) — see
 * `InboundWebhookNoiseAggregator` in `inbound-webhooks.ts`.
 */
export type InboundWebhookAuditOutcome =
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
   * this to at most one write per flush interval (see
   * `InboundWebhookNoiseAggregator`) is what stops a rotating-token-id flood
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
