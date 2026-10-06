import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRelayIceConfiguration } from '@kontourai/station-connect/relay-ice';
import {
  RELAY_ICE_CONFIGURATION_VERSION,
  RELAY_ICE_MAX_TTL_SECONDS,
  type RelayIceConfigurationV1,
  type RelayIceServerV1,
} from '@kontourai/station-contracts/relay-ice';

export interface BrokerIceAuthority
  extends Pick<RelayIceConfigurationV1, 'scope' | 'surface'> {
  readonly subject: string;
  /** Native credentials cannot outlive their installation routing grant. */
  readonly grantExpiresAt?: number;
  assertCurrent(): void;
}
export interface BrokerTurnProvider {
  issue(input: {
    ttlSeconds: number;
    usageKey: string;
    signal: AbortSignal;
  }): Promise<readonly RelayIceServerV1[]>;
}
export interface BrokerIcePolicy {
  ttlSeconds: number;
  /** Rolling 24-hour issuance attempts, including provider failures. */
  maxAttemptsPerDay: number;
  /** Rolling 10-minute issuance attempts per credential owner. */
  maxAttemptsPerSubject: number;
  maxConcurrent: number;
}
const DEFAULT_POLICY: Readonly<BrokerIcePolicy> = Object.freeze({
  ttlSeconds: 600,
  maxAttemptsPerDay: 100,
  maxAttemptsPerSubject: 4,
  maxConcurrent: 4,
});
const APPLICATION_ID = 0x53544943;

function privateLedger(path: string): {
  db: DatabaseSync;
  assertCurrent(): void;
} {
  if (!isAbsolute(path) || process.getuid === undefined)
    throw new Error('ice_custody_refused');
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error('ice_custody_refused');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const pinnedFile = lstatSync(path);
  for (const candidate of [
    path,
    `${path}-journal`,
    `${path}-wal`,
    `${path}-shm`,
  ]) {
    try {
      const info = lstatSync(candidate);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error('ice_custody_refused');
    } catch (error) {
      if (
        candidate === path ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error;
    }
  }
  const assertCurrent = () => {
    const current = lstatSync(path);
    const directory = lstatSync(dirname(path));
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.uid !== process.getuid!() ||
      (current.mode & 0o077) !== 0 ||
      current.dev !== pinnedFile.dev ||
      current.ino !== pinnedFile.ino ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid!() ||
      (directory.mode & 0o077) !== 0 ||
      directory.dev !== parent.dev ||
      directory.ino !== parent.ino
    )
      throw new Error('ice_custody_refused');
  };
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    assertCurrent();
    const application = (
      db.prepare('PRAGMA application_id').get() as { application_id: number }
    ).application_id;
    const version = (
      db.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version;
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    if (
      !(
        (application === 0 && version === 0 && tables.length === 0) ||
        (application === APPLICATION_ID &&
          version === 1 &&
          tables.length === 1 &&
          tables[0]?.name === 'ice_attempts')
      )
    )
      throw new Error('ice_custody_refused');
    db.exec(`CREATE TABLE IF NOT EXISTS ice_attempts(at INTEGER NOT NULL, subject TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ice_attempt_subject ON ice_attempts(subject, at);
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
    return { db, assertCurrent };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Durable issuance limits are not a provider bandwidth or spending cap. */
export class BrokerIceService {
  readonly #db: DatabaseSync;
  readonly #assertLedgerCurrent: () => void;
  readonly #policy: Readonly<BrokerIcePolicy>;
  readonly #abort = new AbortController();
  readonly #cache = new Map<string, RelayIceConfigurationV1>();
  #active = 0;
  #closed = false;
  constructor(
    ledgerPath: string,
    private readonly provider: BrokerTurnProvider,
    policy: Partial<BrokerIcePolicy> = {},
    private readonly now = () => Date.now(),
  ) {
    const merged = { ...DEFAULT_POLICY, ...policy };
    if (
      !Number.isInteger(merged.ttlSeconds) ||
      merged.ttlSeconds < 120 ||
      merged.ttlSeconds > RELAY_ICE_MAX_TTL_SECONDS ||
      !Number.isInteger(merged.maxAttemptsPerDay) ||
      merged.maxAttemptsPerDay < 1 ||
      merged.maxAttemptsPerDay > 100 ||
      !Number.isInteger(merged.maxAttemptsPerSubject) ||
      merged.maxAttemptsPerSubject < 1 ||
      merged.maxAttemptsPerSubject > 4 ||
      !Number.isInteger(merged.maxConcurrent) ||
      merged.maxConcurrent < 1 ||
      merged.maxConcurrent > 4
    )
      throw new Error('ice_policy_invalid');
    this.#policy = Object.freeze(merged);
    const ledger = privateLedger(ledgerPath);
    this.#db = ledger.db;
    this.#assertLedgerCurrent = ledger.assertCurrent;
  }
  #reserve(subject: string, now: number) {
    this.#assertLedgerCurrent();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db
        .prepare('DELETE FROM ice_attempts WHERE at<?')
        .run(now - 86_400_000);
      const count = this.#db
        .prepare(
          'SELECT count(*) AS total, sum(CASE WHEN subject=? AND at>? THEN 1 ELSE 0 END) AS subject FROM ice_attempts',
        )
        .get(subject, now - 600_000) as {
        total: number;
        subject: number | null;
      };
      if (
        count.total >= this.#policy.maxAttemptsPerDay ||
        (count.subject ?? 0) >= this.#policy.maxAttemptsPerSubject
      )
        throw new Error('ice_issuance_limit');
      this.#db
        .prepare('INSERT INTO ice_attempts(at,subject) VALUES(?,?)')
        .run(now, subject);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  async issue(
    authority: BrokerIceAuthority,
    callerSignal: AbortSignal,
  ): Promise<RelayIceConfigurationV1> {
    if (this.#closed) throw new Error('ice_unavailable');
    this.#assertLedgerCurrent();
    callerSignal.throwIfAborted();
    authority.assertCurrent();
    const issuedAt = this.now();
    const usageKey = createHash('sha256')
      .update(
        JSON.stringify([
          authority.subject,
          authority.scope.stationId,
          authority.scope.enrollmentId,
          authority.scope.routingGeneration,
          authority.surface?.kind,
          authority.surface?.appIdentifier,
          authority.surface?.channel,
          authority.surface?.clientInstanceId,
          authority.surface?.keyThumbprint,
        ]),
      )
      .digest('hex');
    for (const [key, value] of this.#cache) {
      if (value.expiresAt < issuedAt + 120_000) this.#cache.delete(key);
    }
    const cached = this.#cache.get(usageKey);
    if (
      cached &&
      (authority.grantExpiresAt === undefined ||
        cached.expiresAt <= authority.grantExpiresAt)
    ) {
      authority.assertCurrent();
      const verifiedAt = this.now();
      if (cached.expiresAt >= verifiedAt + 120_000)
        return parseRelayIceConfiguration(cached, authority, verifiedAt);
      this.#cache.delete(usageKey);
    }
    if (this.#active >= this.#policy.maxConcurrent)
      throw new Error('ice_issuance_limit');
    const ttlSeconds = Math.min(
      this.#policy.ttlSeconds,
      authority.grantExpiresAt === undefined
        ? this.#policy.ttlSeconds
        : Math.floor((authority.grantExpiresAt - issuedAt) / 1000),
    );
    if (ttlSeconds < 120) throw new Error('ice_authority_expiring');

    this.#reserve(usageKey, issuedAt);
    this.#active++;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('ice_provider_timeout')),
      10_000,
    );
    const signal = AbortSignal.any([
      callerSignal,
      timeout.signal,
      this.#abort.signal,
    ]);
    try {
      const operation = Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return this.provider.issue({ ttlSeconds, usageKey, signal });
        })
        .finally(() => {
          this.#active--;
        });
      // Observe late settlements even when a provider cannot cancel its work.
      const iceServers = await new Promise<readonly RelayIceServerV1[]>(
        (resolve, reject) => {
          const aborted = () => reject(new Error('ice_unavailable'));
          signal.addEventListener('abort', aborted, { once: true });
          operation
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted))
            .catch(() => {});
          if (signal.aborted) aborted();
        },
      );
      signal.throwIfAborted();
      authority.assertCurrent();
      this.#assertLedgerCurrent();
      const receipt = parseRelayIceConfiguration(
        {
          version: RELAY_ICE_CONFIGURATION_VERSION,
          scope: authority.scope,
          ...(authority.surface ? { surface: authority.surface } : {}),
          iceTransportPolicy: 'relay',
          issuedAt,
          expiresAt: issuedAt + ttlSeconds * 1000,
          iceServers,
        },
        authority,
        this.now(),
      );
      if (this.#cache.size >= this.#policy.maxAttemptsPerDay) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      this.#cache.set(usageKey, receipt);
      return receipt;
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'broker_credential_refused',
          'ice_authority_expiring',
          'relay_ice_configuration_invalid',
        ].includes(error.message)
      )
        throw error;
      throw new Error('ice_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#cache.clear();
    this.#db.close();
  }
}
