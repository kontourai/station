// UNWIRED(#4115): private R1 store; R2 composes domain decisions and R6 qualifies exposure.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  ACCESS_TTL,
  CODE_TTL,
  DAY,
  GRANT_TTL,
  type GrantSelection,
  IDLE_TTL,
  MINUTE,
  OutsideOAuthRefusal,
  PENDING_TTL,
  type Records,
  recordSchemas,
  type Supersession,
  selectionSchema,
} from './oauth-records.js';
import {
  acceptedMetadata,
  equalHash,
  matchesRedirect,
  metadataDigest,
  nameLabel,
  pkceChallenge,
  redirectPermitted,
  secretHash,
  selectedScopeDigest,
} from './oauth-registration.js';

// Owner-selected ceiling; the colocated store tests pin the default diagnostic to this literal.
const AUDIT_CAP = 100_000;
const DEFAULT_LIMITS = {
  registrations: 100,
  grants: 100,
  grantsPerClient: 5,
  pending: 50,
  pendingPerTicket: 5,
  pendingPerClientTicket: 3,
  pendingPerPeer: 5,
  registrationsPerDay: 500,
  tombstones: 20_000,
  audit: AUDIT_CAP,
};
type Limits = typeof DEFAULT_LIMITS;
type Kind = keyof Records;
type LiveReview = {
  request: Records['request'];
  intent: Records['intent'];
  client: Records['client'];
};
export interface OutsideOAuthStoreOptions {
  stationId: string;
  bootId: string;
  issuer: string;
  /** R2 supplies a synchronous live authority/Project/policy check, inside the write lock. */
  validateReview: (review: LiveReview) => boolean;
  now?: () => number;
  limits?: Partial<Limits>;
}
interface StartRequest {
  clientId: string;
  redirectUri: string;
  resource: string;
  state: string;
  challenge: string;
  scopes?: string[];
  ticket?: string;
  peer?: string;
}
interface Exchange {
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  verifier: string;
  admitted?: boolean;
}
const random = (prefix = '') => prefix + randomBytes(32).toString('base64url');
const invalid = () => new OutsideOAuthRefusal('invalid_grant');

/** Hash-only custody. BEGIN IMMEDIATE is the mutation gate across all connections/processes. */
export class OutsideAgentGrantStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #limits: Limits;
  readonly #resource: string;
  readonly #volatile = new Map<
    string,
    { state: string; comparisonCode: string }
  >();
  readonly #changes = new EventEmitter();
  #requestChanged = false;
  #decisionInProgress = false;
  get #origins(): readonly string[] {
    return this.policy('redirect').origins;
  }
  private constructor(
    db: DatabaseSync,
    readonly options: OutsideOAuthStoreOptions,
  ) {
    if (
      !options.stationId ||
      !options.bootId ||
      !options.issuer ||
      new URL(options.issuer).origin !== options.issuer
    )
      throw new Error('Outside OAuth requires canonical instance binding');
    this.options = Object.freeze({ ...options });
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#resource = `${options.issuer}/mcp`;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
      if (
        !Number.isInteger(this.#limits[key]) ||
        this.#limits[key] < 1 ||
        this.#limits[key] > DEFAULT_LIMITS[key]
      )
        throw new Error('Outside OAuth limits may only be lowered');
    }
    if (this.#limits.registrationsPerDay * 30 >= this.#limits.tombstones)
      throw new Error('Outside OAuth tombstone reservation invariant violated');
    db.exec(`CREATE TABLE IF NOT EXISTS outside_oauth_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(kind, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS outside_oauth_state ON outside_oauth_records(kind, json_extract(data, '$.state'));
    CREATE INDEX IF NOT EXISTS outside_oauth_request_code ON outside_oauth_records(kind, json_extract(data, '$.requestId'));
    CREATE INDEX IF NOT EXISTS outside_oauth_expiry ON outside_oauth_records(kind, json_extract(data, '$.expiresAt'));
    CREATE INDEX IF NOT EXISTS outside_oauth_retention ON outside_oauth_records(kind, json_extract(data, '$.retainUntil'));
    CREATE UNIQUE INDEX IF NOT EXISTS outside_oauth_approval_decision ON outside_oauth_records(json_extract(data, '$.decisionId')) WHERE kind='event' AND json_extract(data, '$.kind')='approved';
    CREATE TABLE IF NOT EXISTS outside_oauth_binding (id INTEGER PRIMARY KEY CHECK(id=1), station TEXT NOT NULL, issuer TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS outside_oauth_terminal_immutable
    BEFORE UPDATE ON outside_oauth_records
    WHEN OLD.kind='grant' AND json_extract(OLD.data, '$.state')!='active' AND NEW.data!=OLD.data
    BEGIN SELECT RAISE(ABORT, 'Outside OAuth terminal grant is immutable'); END;`);
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS outside_oauth_audit_count (
      id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO outside_oauth_audit_count SELECT 1,count(*) FROM outside_oauth_records WHERE kind='event';
    CREATE TRIGGER IF NOT EXISTS outside_oauth_event_added AFTER INSERT ON outside_oauth_records WHEN NEW.kind='event'
    BEGIN UPDATE outside_oauth_audit_count SET n=n+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS outside_oauth_event_deleted AFTER DELETE ON outside_oauth_records WHEN OLD.kind='event'
    BEGIN UPDATE outside_oauth_audit_count SET n=n-1 WHERE id=1; END;
    CREATE TABLE IF NOT EXISTS outside_oauth_budgets (
      id TEXT PRIMARY KEY, remaining REAL NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS outside_oauth_budget_expiry ON outside_oauth_budgets(expires);
    CREATE INDEX IF NOT EXISTS outside_oauth_budget_age ON outside_oauth_budgets(updated);
    COMMIT;`);
    const check = db.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok')
      throw new Error('Outside OAuth storage corrupt');
    db.prepare(
      'INSERT OR IGNORE INTO outside_oauth_binding VALUES(1, ?, ?)',
    ).run(options.stationId, options.issuer);
    const binding = db
      .prepare('SELECT station, issuer FROM outside_oauth_binding WHERE id=1')
      .get();
    if (
      binding?.station !== options.stationId ||
      binding.issuer !== options.issuer
    )
      throw new Error(
        'Outside OAuth instance/issuer changed: explicit credential reset required',
      );
  }
  static open(
    home: string,
    options: OutsideOAuthStoreOptions,
  ): OutsideAgentGrantStore {
    const db = openPrivateSqlite(
      join(home, 'authentication', 'outside-agent-oauth.sqlite'),
      'Outside agent OAuth',
    );
    try {
      return new OutsideAgentGrantStore(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.#volatile.clear();
    this.#changes.emit('change');
    this.#changes.removeAllListeners();
    this.#db.close();
  }

  #get<K extends Kind>(kind: K, id: string): Records[K] | undefined {
    const row = this.#db
      .prepare('SELECT data FROM outside_oauth_records WHERE kind=? AND id=?')
      .get(kind, id);
    return row ? this.#decode(kind, row.data) : undefined;
  }
  #decode<K extends Kind>(kind: K, data: unknown): Records[K] {
    if (typeof data !== 'string')
      throw new Error('Outside OAuth storage corrupt');
    // Schemas refuse malformed persisted state before it can confer authority.
    return recordSchemas[kind].parse(JSON.parse(data)) as Records[K];
  }
  #all<K extends Kind>(kind: K): Records[K][] {
    return this.#db
      .prepare('SELECT data FROM outside_oauth_records WHERE kind=?')
      .all(kind)
      .map((row) => this.#decode(kind, row.data));
  }
  #put<K extends Kind>(kind: K, id: string, data: Records[K]): void {
    recordSchemas[kind].parse(data);
    if (
      kind === 'request' ||
      kind === 'grant' ||
      kind === 'family' ||
      kind === 'policy'
    )
      this.#requestChanged = true;
    this.#db
      .prepare(
        'INSERT INTO outside_oauth_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, id, JSON.stringify(data));
  }
  #delete(kind: Kind, id: string): void {
    this.#db
      .prepare('DELETE FROM outside_oauth_records WHERE kind=? AND id=?')
      .run(kind, id);
  }
  #write<T>(operation: () => T | OutsideOAuthRefusal): T {
    if (this.#decisionInProgress) {
      const nested = operation();
      if (nested instanceof OutsideOAuthRefusal) throw nested;
      return nested;
    }
    this.#requestChanged = false;
    this.#db.exec('BEGIN IMMEDIATE');
    let result: T | OutsideOAuthRefusal;
    try {
      result = operation();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    if (this.#requestChanged) {
      this.#requestChanged = false;
      queueMicrotask(() => this.#changes.emit('change'));
    }
    if (result instanceof OutsideOAuthRefusal) throw result;
    return result;
  }
  /** Wake protocol waiters after committed request, grant, family or policy transitions. */
  onRequestChange(listener: () => void): () => void {
    this.#changes.on('change', listener);
    return () => this.#changes.off('change', listener);
  }
  /** B is a credential only for this request's status, never for inventory or approval. */
  browserRequest(id: string, ticket: string) {
    const request = this.request(id);
    if (
      !request ||
      !equalHash(request.ticketHash, secretHash('ticket', ticket))
    )
      return undefined;
    return request;
  }
  refreshFamily(
    token: string,
    clientId: string,
    resource: string,
  ): string | undefined {
    const row = this.#get('refresh', secretHash('refresh', token));
    return row?.clientId === clientId && row.resource === resource
      ? row.familyId
      : undefined;
  }
  /** Persistent bounded buckets. Refusal never charges or allocates any key. */
  chargeBudgets(
    budgets: readonly {
      key: string;
      capacity: number;
      period: number;
      refill?: boolean;
    }[],
  ): boolean {
    return this.#write(() => {
      const now = this.#now();
      const charges: { id: string; remaining: number; expires: number }[] = [];
      const globalKeys = [
        'register:global',
        'register:global:day',
        'authorize:global',
        'code:global',
        'refresh:global',
      ];
      const protectedIds = globalKeys.map((key) => secretHash('budget', key));
      const ordered = [...budgets].sort(
        (a, b) =>
          Number(globalKeys.includes(b.key)) -
          Number(globalKeys.includes(a.key)),
      );
      for (const budget of ordered) {
        const id = secretHash('budget', budget.key);
        const previous = this.#db
          .prepare(
            'SELECT remaining, updated FROM outside_oauth_budgets WHERE id=? AND expires>?',
          )
          .get(id, now);
        const updated = Number(previous?.updated ?? now);
        const remaining = !previous
          ? budget.capacity
          : budget.refill === false
            ? Math.floor(updated / budget.period) ===
              Math.floor(now / budget.period)
              ? Number(previous.remaining)
              : budget.capacity
            : Math.min(
                budget.capacity,
                Number(previous.remaining) +
                  ((now - updated) * budget.capacity) / budget.period,
              );
        if (remaining < 1) return false;
        charges.push({
          id,
          remaining: remaining - 1,
          expires:
            budget.refill === false
              ? (Math.floor(now / budget.period) + 1) * budget.period
              : now + budget.period,
        });
      }
      // Admission and charging share the write transaction; refused work writes no buckets.
      this.#db
        .prepare('DELETE FROM outside_oauth_budgets WHERE expires<=?')
        .run(now);
      for (const { id, remaining, expires } of charges) {
        if (
          !this.#db
            .prepare('SELECT 1 FROM outside_oauth_budgets WHERE id=?')
            .get(id) &&
          Number(
            this.#db
              .prepare('SELECT count(*) AS n FROM outside_oauth_budgets')
              .get()?.n,
          ) >= 4096
        ) {
          // Keep global quota evidence; pressure only evicts the oldest supplementary bucket.
          this.#db
            .prepare(`DELETE FROM outside_oauth_budgets WHERE id IN (
            SELECT id FROM outside_oauth_budgets WHERE id NOT IN (${protectedIds.map(() => '?').join(',')})
            ORDER BY updated,rowid LIMIT 1
          )`)
            .run(...protectedIds);
        }
        this.#db
          .prepare(
            'INSERT INTO outside_oauth_budgets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET remaining=excluded.remaining, updated=excluded.updated, expires=excluded.expires',
          )
          .run(id, remaining, now, expires);
      }
      return true;
    });
  }
  #pruneAudit(): void {
    this.#db
      .prepare(
        "DELETE FROM outside_oauth_records WHERE kind='event' AND json_extract(data,'$.deliveredAt') IS NOT NULL AND json_extract(data,'$.at')<=?",
      )
      .run(this.#now() - 90 * DAY);
  }
  #auditCount(): number {
    return Number(
      this.#db
        .prepare('SELECT n FROM outside_oauth_audit_count WHERE id=1')
        .get()?.n,
    );
  }
  #requireAuditCapacity(): void {
    if (this.#auditCount() >= this.#limits.audit)
      throw new OutsideOAuthRefusal('audit_capacity');
  }
  diagnostics() {
    return this.#write(() => {
      this.#pruneAudit();
      const retainedEvents = this.#auditCount();
      return {
        auditCapacity: this.#limits.audit,
        retainedEvents,
        undeliveredEvents: Number(
          this.#db
            .prepare(
              "SELECT count(*) AS n FROM outside_oauth_records WHERE kind='event' AND json_extract(data,'$.deliveredAt') IS NULL",
            )
            .get()?.n,
        ),
        admissionClosed: retainedEvents >= this.#limits.audit,
        health:
          retainedEvents >= this.#limits.audit
            ? 'audit_capacity'
            : retainedEvents >= this.#limits.audit * 0.8
              ? 'audit_pressure'
              : 'ok',
      };
    });
  }
  #event(
    kind: Records['event']['kind'],
    fields: Pick<
      Records['event'],
      | 'clientId'
      | 'requestId'
      | 'grantId'
      | 'decisionId'
      | 'version'
      | 'before'
      | 'after'
      | 'reason'
      | 'actor'
      | 'projectScope'
      | 'accessLevel'
    > = {},
  ): void {
    // Only terminal/request-ended/retired events are exempt after saturation.
    // Every path that creates live state must still require audit capacity.
    if (!['terminal', 'request-ended', 'retired', 'decision'].includes(kind))
      this.#requireAuditCapacity();
    const id = random();
    this.#put('event', id, {
      id,
      kind,
      at: this.#now(),
      deliveredAt: null,
      stationId: this.options.stationId,
      ...fields,
    });
  }
  #liveClient(id: string): Records['client'] {
    const client = this.#get('client', id);
    if (!client) throw new OutsideOAuthRefusal('invalid_client');
    return client;
  }
  register(metadata: unknown): Records['client'] {
    return this.#write(() => {
      this.#expireLive();
      const accepted = acceptedMetadata(metadata, this.#origins);
      const clients = this.#all('client');
      const day = Math.floor(this.#now() / DAY);
      const quota = this.#get('quota', String(day)) ?? { day, count: 0 };
      if (
        quota.count >= this.#limits.registrationsPerDay ||
        clients.filter((c) => !this.#active().some((g) => g.clientId === c.id))
          .length >= this.#limits.registrations ||
        clients.length + this.#all('tombstone').length >=
          this.#limits.tombstones
      )
        throw new OutsideOAuthRefusal('capacity');
      const id = random();
      const client: Records['client'] = {
        id,
        version: 1,
        metadata: accepted,
        digest: metadataDigest(accepted),
        createdAt: this.#now(),
        lastGrantAt: null,
      };
      this.#put('client', id, client);
      this.#put('quota', String(day), { day, count: quota.count + 1 });
      this.#event('registration', { clientId: id });
      return client;
    });
  }
  client(id: string): Records['client'] | undefined {
    return this.#write(() => {
      const client = this.#get('client', id);
      if (
        client &&
        (client.lastGrantAt ?? client.createdAt) +
          (client.lastGrantAt === null ? DAY : 30 * DAY) <=
          this.#now()
      ) {
        this.#expireLive();
        return this.#get('client', id);
      }
      return client;
    });
  }
  recovery(id: string): Records['tombstone'] | undefined {
    return this.#write(() => {
      const row = this.#get('tombstone', id);
      if (row && row.expiresAt <= this.#now()) {
        this.#delete('tombstone', id);
        return undefined;
      }
      return row;
    });
  }
  start(input: StartRequest) {
    if (input.resource !== this.#resource)
      throw new OutsideOAuthRefusal('invalid_target');
    if (
      Buffer.byteLength(input.state) < 1 ||
      Buffer.byteLength(input.state) > 1024 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)
    )
      throw new OutsideOAuthRefusal('invalid_request');
    const requested = input.scopes ?? ['station-control:read'];
    if (
      !requested.length ||
      requested.some(
        (s) => !['station-control:read', 'station-control:full'].includes(s),
      )
    )
      throw new OutsideOAuthRefusal('invalid_scope');
    const scopes: Records['request']['scopes'] = requested.includes(
      'station-control:full',
    )
      ? ['station-control:read', 'station-control:full']
      : ['station-control:read'];
    let ticket = input.ticket ?? random();
    let ticketHash = secretHash('ticket', ticket);
    const nonce = random();
    let comparisonCode = String(
      randomBytes(4).readUInt32BE() % 1_000_000,
    ).padStart(6, '0');
    const result = this.#write(() => {
      this.#expireLive();
      const client = this.#liveClient(input.clientId);
      if (
        !redirectPermitted(
          input.redirectUri,
          client.metadata.application_type,
          this.#origins,
        ) ||
        !client.metadata.redirect_uris.some((uri) =>
          matchesRedirect(input.redirectUri, uri),
        )
      )
        throw new OutsideOAuthRefusal('invalid_request');
      let binding = this.#get('ticket', ticketHash);
      if (
        input.ticket &&
        (!binding || this.#now() + PENDING_TTL + CODE_TTL > binding.expiresAt)
      ) {
        if (this.#pending().some((r) => r.ticketHash === ticketHash)) {
          throw new OutsideOAuthRefusal('capacity');
        }
        ticket = random();
        ticketHash = secretHash('ticket', ticket);
        binding = undefined;
      }
      binding ??= {
        hash: ticketHash,
        createdAt: this.#now(),
        expiresAt: this.#now() + 30 * MINUTE,
      };
      if (this.#now() + PENDING_TTL + CODE_TTL > binding.expiresAt)
        throw new OutsideOAuthRefusal('capacity');
      const live = this.#pending();
      while (
        live.some(
          (r) => r.comparisonHash === secretHash('comparison', comparisonCode),
        )
      )
        comparisonCode = String(
          randomBytes(4).readUInt32BE() % 1_000_000,
        ).padStart(6, '0');
      const replace = live.filter(
        (r) =>
          r.ticketHash === ticketHash &&
          r.clientId === client.id &&
          r.redirectUri === input.redirectUri,
      );
      const remaining = live.filter(
        (r) => !replace.some((old) => old.id === r.id),
      );
      const ticketRequests = remaining.filter(
        (r) => r.ticketHash === ticketHash,
      );
      if (
        remaining.length >= this.#limits.pending ||
        ticketRequests.length >= this.#limits.pendingPerTicket ||
        ticketRequests.filter((r) => r.clientId === client.id).length >=
          this.#limits.pendingPerClientTicket ||
        (input.peer &&
          remaining.filter((r) => r.peer === input.peer).length >=
            this.#limits.pendingPerPeer)
      )
        throw new OutsideOAuthRefusal('capacity');
      this.#requireAuditCapacity();
      for (const old of replace) this.#endRequest(old, 'replaced');
      const id = random();
      const request: Records['request'] = {
        id,
        bootId: this.options.bootId,
        version: 1,
        clientId: client.id,
        registrationDigest: client.digest,
        ticketHash,
        comparisonHash: secretHash('comparison', comparisonCode),
        nonceHash: secretHash('nonce', nonce),
        stateDigest: secretHash('state', input.state),
        challenge: input.challenge,
        redirectUri: input.redirectUri,
        resource: this.#resource,
        scopes,
        peer: input.peer ?? null,
        createdAt: this.#now(),
        expiresAt: this.#now() + PENDING_TTL,
        state: 'pending',
      };
      this.#put('ticket', ticketHash, binding);
      this.#put('request', id, request);
      if (!replace.length || replace.some((old) => old.state !== 'pending'))
        this.#event('requested', { requestId: id, clientId: client.id });
      return request;
    });
    this.#volatile.set(result.id, { state: input.state, comparisonCode });
    return { request: result, ticket, nonce, comparisonCode };
  }
  #pending(): Records['request'][] {
    return this.#db
      .prepare(
        "SELECT data FROM outside_oauth_records WHERE kind='request' AND json_extract(data,'$.state') IN ('pending','approved','coded')",
      )
      .all()
      .map((row) => this.#decode('request', row.data));
  }
  request(id: string): Records['request'] | undefined {
    return this.#write(() => {
      const request = this.#get('request', id);
      if (request && ['pending', 'approved', 'coded'].includes(request.state)) {
        const code = this.#db
          .prepare(
            "SELECT data FROM outside_oauth_records WHERE kind='code' AND json_extract(data,'$.requestId')=? AND json_extract(data,'$.familyId') IS NULL",
          )
          .get(id);
        const deadline = code
          ? this.#decode('code', code.data).expiresAt
          : request.expiresAt;
        if (deadline <= this.#now() || request.bootId !== this.options.bootId) {
          this.#endRequest(request, 'expired');
          if (request.createdAt + PENDING_TTL + CODE_TTL <= this.#now()) {
            this.#delete('request', id);
            this.#volatile.delete(id);
            return undefined;
          }
          return this.#get('request', id);
        }
      }
      return request;
    });
  }
  #endRequest(
    request: Records['request'],
    state: 'replaced' | 'expired' | 'denied',
  ): void {
    this.#put('request', request.id, {
      ...request,
      state,
      version: request.version + 1,
    });
    for (const intent of this.#all('intent').filter(
      (i) => i.requestId === request.id,
    ))
      this.#delete('intent', intent.id);
    this.#db
      .prepare(
        "DELETE FROM outside_oauth_records WHERE kind='code' AND json_extract(data,'$.requestId')=? AND json_extract(data,'$.familyId') IS NULL",
      )
      .run(request.id);
    if (state !== 'replaced' || request.state !== 'pending')
      this.#event('request-ended', {
        requestId: request.id,
        clientId: request.clientId,
        reason: state,
      });
  }
  approve(input: {
    decisionId: string;
    requestId: string;
    expectedVersion: number;
    registrationDigest: string;
    selection: GrantSelection;
    supersessions: Supersession[];
  }): Records['intent'] {
    const selection = selectionSchema.parse(input.selection);
    return this.#write(() => {
      this.#expireLive();
      const prior = this.#get('intent', input.decisionId);
      if (prior) {
        if (
          prior.requestId !== input.requestId ||
          prior.requestVersion !== input.expectedVersion ||
          prior.registrationDigest !== input.registrationDigest ||
          JSON.stringify(prior.selection) !== JSON.stringify(selection) ||
          JSON.stringify(prior.supersessions) !==
            JSON.stringify(input.supersessions)
        )
          throw new OutsideOAuthRefusal('target_changed');
        return prior;
      }
      const request = this.#get('request', input.requestId);
      if (
        request?.state !== 'pending' ||
        request.version !== input.expectedVersion ||
        request.registrationDigest !== input.registrationDigest ||
        selection.expiresAt > this.#now() + GRANT_TTL ||
        selection.expiresAt < this.#now() + 5 * MINUTE ||
        input.supersessions.length !==
          new Set(input.supersessions.map((s) => s.grantId)).size
      )
        throw new OutsideOAuthRefusal('target_changed');
      const client = this.#liveClient(request.clientId);
      const intent: Records['intent'] = {
        id: input.decisionId,
        requestId: request.id,
        requestVersion: request.version,
        registrationDigest: client.digest,
        selection,
        supersessions: [...input.supersessions].sort((a, b) =>
          a.grantId.localeCompare(b.grantId),
        ),
        createdAt: this.#now(),
      };
      recordSchemas.intent.parse(intent);
      if (
        this.options.validateReview(
          structuredClone({ request, intent, client }),
        ) !== true ||
        !this.#supersessionsValid(intent, request)
      )
        throw new OutsideOAuthRefusal('target_changed');
      this.#put('intent', intent.id, intent);
      this.#put('request', request.id, {
        ...request,
        state: 'approved',
        version: request.version + 1,
      });
      this.#event('approved', {
        actor: intent.selection.actor,
        projectScope: intent.selection.projectScope,
        accessLevel: intent.selection.accessLevel,
        decisionId: intent.id,
        requestId: request.id,
        clientId: client.id,
      });
      return intent;
    });
  }
  complete(requestId: string, ticket: string, nonce: string) {
    return this.#write(() => {
      this.#expireLive();
      this.#requireAuditCapacity();
      const request = this.#get('request', requestId);
      const volatile = this.#volatile.get(requestId);
      if (
        !request ||
        !volatile ||
        request.state !== 'approved' ||
        request.expiresAt <= this.#now() ||
        !equalHash(request.ticketHash, secretHash('ticket', ticket)) ||
        !equalHash(request.nonceHash, secretHash('nonce', nonce))
      )
        throw invalid();
      const intent = this.#all('intent').find(
        (i) => i.requestId === request.id,
      );
      const client = this.#liveClient(request.clientId);
      if (
        !intent ||
        client.digest !== request.registrationDigest ||
        !redirectPermitted(
          request.redirectUri,
          client.metadata.application_type,
          this.#origins,
        ) ||
        !this.options.validateReview(
          structuredClone({ request, intent, client }),
        )
      )
        throw invalid();
      const code = random('oac_');
      const hash = secretHash('code', code);
      this.#put('code', hash, {
        hash,
        requestId,
        requestVersion: request.version + 1,
        intentId: intent.id,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        challenge: request.challenge,
        expiresAt: this.#now() + CODE_TTL,
        failures: 0,
        familyId: null,
        retainUntil: this.#now() + CODE_TTL,
      });
      this.#put('request', requestId, {
        ...request,
        state: 'coded',
        version: request.version + 1,
      });
      return { code, state: volatile.state, redirectUri: request.redirectUri };
    });
  }
  completeDenial(requestId: string, ticket: string, nonce: string) {
    return this.#write(() => {
      this.#expireLive();
      const request = this.#get('request', requestId);
      const volatile = this.#volatile.get(requestId);
      if (
        !request ||
        !volatile ||
        request.state !== 'denied' ||
        request.expiresAt <= this.#now() ||
        !equalHash(request.ticketHash, secretHash('ticket', ticket)) ||
        !equalHash(request.nonceHash, secretHash('nonce', nonce))
      )
        throw invalid();
      const client = this.#liveClient(request.clientId);
      if (
        !redirectPermitted(
          request.redirectUri,
          client.metadata.application_type,
          this.#origins,
        )
      )
        throw invalid();
      this.#volatile.delete(requestId);
      return { state: volatile.state, redirectUri: request.redirectUri };
    });
  }
  #supersessionsValid(
    intent: Records['intent'],
    request: Records['request'],
  ): boolean {
    return intent.supersessions.every((old) => {
      const grant = this.#get('grant', old.grantId);
      return (
        grant &&
        grant.state === 'active' &&
        grant.version === old.expectedVersion &&
        equalHash(this.grantDigest(grant), old.expectedDigest) &&
        grant.resource === request.resource &&
        grant.selection.delegatingPrincipalId ===
          intent.selection.delegatingPrincipalId &&
        selectedScopeDigest(grant.selection.projectScope) ===
          selectedScopeDigest(intent.selection.projectScope)
      );
    });
  }
  grantDigest(grant: Records['grant']): string {
    // Refresh usage does not change the authority reviewed for supersession.
    const { lastUsedAt: _lastUsedAt, ...authority } =
      recordSchemas.grant.parse(grant);
    return secretHash('grant', JSON.stringify(authority));
  }
  exchange(input: Exchange) {
    return this.#write(() => {
      this.#expireLive();
      const hash = secretHash('code', input.code);
      const code = this.#get('code', hash);
      if (
        !code ||
        code.clientId !== input.clientId ||
        code.resource !== input.resource ||
        code.redirectUri !== input.redirectUri ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
      )
        return invalid();
      if (
        !equalHash(
          secretHash('challenge', pkceChallenge(input.verifier)),
          secretHash('challenge', code.challenge),
        )
      ) {
        if (!code.familyId) {
          const failures = code.failures + 1;
          if (failures >= 5) this.#delete('code', hash);
          else this.#put('code', hash, { ...code, failures });
        }
        return invalid();
      }
      if (code.familyId) {
        const family = this.#get('family', code.familyId);
        if (family) this.#terminal(family.grantId, 'revoked', 'code_replay');
        return invalid();
      }
      if (input.admitted === false) return new OutsideOAuthRefusal('capacity');
      const request = this.#get('request', code.requestId);
      const intent = this.#get('intent', code.intentId);
      if (
        !request ||
        !intent ||
        code.expiresAt <= this.#now() ||
        request.bootId !== this.options.bootId ||
        request.state !== 'coded' ||
        request.version !== code.requestVersion ||
        intent.requestVersion + 2 !== code.requestVersion ||
        intent.selection.expiresAt - this.#now() < 5 * MINUTE
      )
        return invalid();
      const client = this.#liveClient(code.clientId);
      if (
        client.digest !== request.registrationDigest ||
        client.digest !== intent.registrationDigest ||
        !redirectPermitted(
          request.redirectUri,
          client.metadata.application_type,
          this.#origins,
        ) ||
        this.options.validateReview(
          structuredClone({ request, intent, client }),
        ) !== true ||
        !this.#supersessionsValid(intent, request)
      ) {
        this.#endRequest(request, 'denied');
        return invalid();
      }
      const selected = new Set(intent.supersessions.map((s) => s.grantId));
      const resulting = this.#active().filter((g) => !selected.has(g.id));
      if (
        resulting.length >= this.#limits.grants ||
        resulting.filter((g) => g.clientId === client.id).length >=
          this.#limits.grantsPerClient
      ) {
        this.#endRequest(request, 'denied');
        return invalid();
      }
      const id = random();
      const familyId = random();
      const grant: Records['grant'] = {
        id,
        version: 1,
        state: 'active',
        reason: null,
        clientId: client.id,
        registrationDigest: client.digest,
        redirectUri: request.redirectUri,
        issuer: this.options.issuer,
        resource: this.#resource,
        stationId: this.options.stationId,
        requestedScopes: request.scopes,
        selection: intent.selection,
        familyId,
        createdAt: this.#now(),
        lastUsedAt: this.#now(),
        expiresAt: intent.selection.expiresAt,
      };
      for (const old of intent.supersessions)
        this.#terminal(old.grantId, 'revoked', 'superseded');
      this.#put('grant', id, grant);
      const family: Records['family'] = {
        id: familyId,
        grantId: id,
        state: 'active',
        lastUsedAt: this.#now(),
        sequence: 0,
      };
      this.#put('family', familyId, family);
      this.#put('code', hash, {
        ...code,
        familyId,
        retainUntil: grant.expiresAt + ACCESS_TTL,
      });
      this.#put('request', request.id, {
        ...request,
        state: 'active',
        version: request.version + 1,
      });
      this.#put('client', client.id, { ...client, lastGrantAt: this.#now() });
      const tokens = this.#tokens(grant, family);
      this.#event('activated', {
        actor: intent.selection.actor,
        projectScope: intent.selection.projectScope,
        accessLevel: intent.selection.accessLevel,
        decisionId: intent.id,
        requestId: request.id,
        clientId: client.id,
        grantId: id,
        version: 1,
      });
      return { ...tokens, grant };
    });
  }
  #tokens(grant: Records['grant'], family: Records['family']) {
    const accessToken = random('oat_');
    const refreshToken = random('ort_');
    const accessHash = secretHash('access', accessToken);
    const refreshHash = secretHash('refresh', refreshToken);
    const expiresAt = Math.min(this.#now() + ACCESS_TTL, grant.expiresAt);
    this.#put('access', accessHash, {
      hash: accessHash,
      grantId: grant.id,
      familyId: family.id,
      version: grant.version,
      clientId: grant.clientId,
      issuer: grant.issuer,
      stationId: grant.stationId,
      resource: grant.resource,
      subject: grant.selection.delegatingPrincipalId,
      scopes: grant.selection.scopes,
      expiresAt,
    });
    this.#put('refresh', refreshHash, {
      hash: refreshHash,
      grantId: grant.id,
      familyId: family.id,
      clientId: grant.clientId,
      resource: grant.resource,
      sequence: family.sequence,
      issuedAt: this.#now(),
      usedAt: null,
      retainUntil: grant.expiresAt + ACCESS_TTL,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor((expiresAt - this.#now()) / 1000),
      scopes: [...grant.selection.scopes],
    };
  }
  rotate(input: {
    refreshToken: string;
    clientId: string;
    resource: string;
    admitted?: boolean;
    validateGrant?: (grant: Records['grant']) => boolean;
  }) {
    return this.#write(() => {
      this.#expireLive();
      const hash = secretHash('refresh', input.refreshToken);
      const token = this.#get('refresh', hash);
      if (
        !token ||
        token.clientId !== input.clientId ||
        token.resource !== input.resource
      )
        return invalid();
      const grant = this.#get('grant', token.grantId);
      const family = this.#get('family', token.familyId);
      if (
        !grant ||
        !family ||
        grant.state !== 'active' ||
        family.state !== 'active' ||
        grant.familyId !== family.id
      )
        return invalid();
      if (token.usedAt !== null) {
        this.#terminal(grant.id, 'revoked', 'refresh_replay');
        return invalid();
      }
      if (input.validateGrant && !input.validateGrant(structuredClone(grant))) {
        this.#terminal(grant.id, 'revoked', 'authority');
        return invalid();
      }
      if (input.admitted === false) return new OutsideOAuthRefusal('capacity');
      if (
        grant.expiresAt - this.#now() < 5 * MINUTE ||
        token.sequence !== family.sequence
      )
        return invalid();
      this.#requireAuditCapacity();
      this.#put('refresh', hash, { ...token, usedAt: this.#now() });
      const next = {
        ...family,
        lastUsedAt: this.#now(),
        sequence: family.sequence + 1,
      };
      this.#put('family', family.id, next);
      const current = { ...grant, lastUsedAt: this.#now() };
      this.#put('grant', grant.id, current);
      const response = this.#tokens(current, next);
      return response;
    });
  }
  #active(): Records['grant'][] {
    return this.#db
      .prepare(
        "SELECT data FROM outside_oauth_records WHERE kind='grant' AND json_extract(data,'$.state')='active'",
      )
      .all()
      .map((row) => this.#decode('grant', row.data));
  }
  #terminal(
    id: string,
    state: 'revoked' | 'expired',
    reason: NonNullable<Records['grant']['reason']>,
  ): void {
    const grant = this.#get('grant', id);
    if (grant?.state !== 'active') return;
    const family = this.#get('family', grant.familyId);
    if (!family) throw new Error('Outside OAuth family missing');
    this.#put('family', family.id, { ...family, state });
    this.#put('grant', id, {
      ...grant,
      state,
      reason,
      version: grant.version + 1,
    });
    this.#db
      .prepare(
        "DELETE FROM outside_oauth_records WHERE kind='access' AND json_extract(data,'$.grantId')=?",
      )
      .run(id);
    const client = this.#get('client', grant.clientId);
    if (client && !this.#active().some((g) => g.clientId === client.id))
      this.#put('client', client.id, { ...client, lastGrantAt: this.#now() });
    this.#event('terminal', {
      actor: grant.selection.actor,
      projectScope: grant.selection.projectScope,
      accessLevel: grant.selection.accessLevel,
      grantId: id,
      clientId: grant.clientId,
      version: grant.version + 1,
      reason,
    });
  }
  revoke(grantId: string, expectedVersion: number): void {
    this.#write(() => {
      this.#expireLive();
      const grant = this.#get('grant', grantId);
      if (grant?.state !== 'active' || grant.version !== expectedVersion)
        throw new OutsideOAuthRefusal('target_changed');
      this.#terminal(grantId, 'revoked', 'revoked');
    });
  }
  /** Returns live selection, including host changes, for existing tokens. R4 must re-admit dispatch/stream work against this version. */
  access(token: string, resource: string): Records['grant'] | undefined {
    return this.#write(() => {
      this.#expireLive();
      const access = this.#get('access', secretHash('access', token));
      if (
        !access ||
        access.resource !== resource ||
        access.issuer !== this.options.issuer ||
        access.stationId !== this.options.stationId ||
        access.expiresAt <= this.#now()
      )
        return undefined;
      const grant = this.#get('grant', access.grantId);
      const family = this.#get('family', access.familyId);
      return grant?.state === 'active' &&
        family?.state === 'active' &&
        access.version <= grant.version &&
        grant.familyId === family.id
        ? grant
        : undefined;
    });
  }
  grants(): Records['grant'][] {
    return this.#write(() => {
      this.#expireLive();
      return this.#all('grant');
    });
  }
  /** Shared synchronous decision span: expected-state reads, mutation and outbox are atomic. */
  decide<T>(operation: () => T): T {
    return this.#write(() => {
      this.#decisionInProgress = true;
      try {
        return operation();
      } finally {
        this.#decisionInProgress = false;
      }
    });
  }
  decision(id: string): Records['decision'] | undefined {
    return this.#get('decision', id);
  }
  recordDecision(decision: Records['decision']): void {
    if (!this.#decisionInProgress) throw new Error('Decision lock required');
    this.#put('decision', decision.id, decision);
    this.#event('decision', {
      decisionId: decision.id,
      actor: decision.actor,
      reason: String(decision.effect.status),
    });
  }
  pending() {
    return this.#write(() => {
      this.#expireLive();
      return this.#pending().map((request) => ({
        request,
        comparisonCode: this.#volatile.get(request.id)?.comparisonCode ?? null,
      }));
    });
  }
  deny(requestId: string, expectedVersion: number): void {
    this.#write(() => {
      this.#expireLive();
      const request = this.#get('request', requestId);
      if (request?.state !== 'pending' || request.version !== expectedVersion)
        throw new OutsideOAuthRefusal('target_changed');
      this.#endRequest(request, 'denied');
    });
  }
  change(
    grantId: string,
    expectedVersion: number,
    expectedDigest: string,
    selection: GrantSelection,
  ): void {
    this.#write(() => {
      this.#expireLive();
      const grant = this.#get('grant', grantId);
      if (
        grant?.state !== 'active' ||
        grant.version !== expectedVersion ||
        !equalHash(this.grantDigest(grant), expectedDigest)
      )
        throw new OutsideOAuthRefusal('target_changed');
      const next = selectionSchema.parse(selection);
      if (
        next.delegatingPrincipalId !== grant.selection.delegatingPrincipalId ||
        !next.scopes.every((scope) => grant.requestedScopes.includes(scope)) ||
        next.expiresAt < this.#now() + 5 * MINUTE ||
        next.expiresAt > grant.createdAt + GRANT_TTL
      )
        throw new OutsideOAuthRefusal('target_changed');
      this.#requireAuditCapacity();
      const changed = {
        ...grant,
        version: grant.version + 1,
        selection: next,
        expiresAt: next.expiresAt,
      };
      this.#put('grant', grantId, changed);
      this.#event('changed', {
        actor: next.actor,
        projectScope: next.projectScope,
        accessLevel: next.accessLevel,
        grantId,
        clientId: grant.clientId,
        version: changed.version,
        before: { version: grant.version, selection: grant.selection },
        after: { version: changed.version, selection: next },
      });
    });
  }
  policy(kind: 'redirect' | 'cors'): Records['policy'] {
    return this.#get('policy', kind) ?? { kind, revision: 0, origins: [] };
  }
  changePolicy(
    kind: 'redirect' | 'cors',
    operation: 'add' | 'remove',
    origin: string,
    expectedRevision: number,
  ): void {
    this.#write(() => {
      this.#expireLive();
      const policy = this.policy(kind);
      if (
        policy.revision !== expectedRevision ||
        policy.origins.includes(origin) !== (operation === 'remove')
      )
        throw new OutsideOAuthRefusal('target_changed');
      const origins =
        operation === 'add'
          ? [...policy.origins, origin].sort()
          : policy.origins.filter((value) => value !== origin);
      if (origins.length > 100) throw new OutsideOAuthRefusal('capacity');
      this.#put('policy', kind, {
        kind,
        revision: policy.revision + 1,
        origins,
      });
      if (kind === 'redirect' && operation === 'remove') {
        for (const request of this.#pending())
          if (new URL(request.redirectUri).origin === origin)
            this.#endRequest(request, 'denied');
        for (const grant of this.#active())
          if (new URL(grant.redirectUri).origin === origin)
            this.#terminal(grant.id, 'revoked', 'redirect_origin_removed');
      }
      this.#event('policy-changed', {
        reason: kind,
        version: policy.revision + 1,
      });
    });
  }
  sweep(): void {
    this.#write(() => this.#sweep());
  }
  #sweep(): void {
    this.#expireLive();
    this.#pruneAudit();
    const now = this.#now();
    this.#pruneHistory(now);
  }
  #expireLive(): void {
    const now = this.#now();
    // The active set and pending set have hard caps; token/history cleanup uses indexed SQL.
    for (const grant of this.#active()) {
      const family = this.#get('family', grant.familyId);
      if (family?.state !== 'active')
        throw new Error('Outside OAuth active family corrupt');
      if (grant.expiresAt <= now)
        this.#terminal(grant.id, 'expired', 'absolute');
      else if (family.lastUsedAt + IDLE_TTL <= now)
        this.#terminal(grant.id, 'expired', 'idle');
    }
    for (const request of this.#pending()) {
      const code = this.#db
        .prepare(
          "SELECT data FROM outside_oauth_records WHERE kind='code' AND json_extract(data,'$.requestId')=? AND json_extract(data,'$.familyId') IS NULL",
        )
        .get(request.id);
      const deadline = code
        ? this.#decode('code', code.data).expiresAt
        : request.expiresAt;
      if (deadline <= now || request.bootId !== this.options.bootId)
        this.#endRequest(request, 'expired');
    }
    const active = this.#active();
    const pending = this.#pending();
    for (const client of this.#all('client')) {
      if (
        !active.some((g) => g.clientId === client.id) &&
        !pending.some((r) => r.clientId === client.id) &&
        (client.lastGrantAt ?? client.createdAt) +
          (client.lastGrantAt === null ? DAY : 30 * DAY) <=
          now
      )
        this.#retire(client, 'expired');
    }
  }
  #pruneHistory(now: number): void {
    this.#db
      .prepare(
        "DELETE FROM outside_oauth_records WHERE kind='decision' AND json_extract(data,'$.createdAt')<=?",
      )
      .run(now - 90 * DAY);
    for (const kind of ['code', 'refresh'] as const)
      this.#db
        .prepare(
          "DELETE FROM outside_oauth_records WHERE rowid IN (SELECT rowid FROM outside_oauth_records WHERE kind=? AND json_extract(data,'$.retainUntil')<=? LIMIT 100)",
        )
        .run(kind, now);
    for (const kind of ['access', 'ticket', 'tombstone'] as const)
      this.#db
        .prepare(
          "DELETE FROM outside_oauth_records WHERE rowid IN (SELECT rowid FROM outside_oauth_records WHERE kind=? AND json_extract(data,'$.expiresAt')<=? LIMIT 100)",
        )
        .run(kind, now);
    this.#db
      .prepare(
        "DELETE FROM outside_oauth_records WHERE kind='quota' AND json_extract(data,'$.day')<?",
      )
      .run(Math.floor(now / DAY) - 30);
    for (const row of this.#db
      .prepare(
        "SELECT data FROM outside_oauth_records WHERE kind='request' AND json_extract(data,'$.state') NOT IN ('pending','approved','coded') AND json_extract(data,'$.createdAt')<=? LIMIT 100",
      )
      .all(now - PENDING_TTL - CODE_TTL)) {
      const request = this.#decode('request', row.data);
      if (
        !['pending', 'approved', 'coded'].includes(request.state) &&
        request.createdAt + PENDING_TTL + CODE_TTL <= now
      ) {
        this.#delete('request', request.id);
        for (const intent of this.#all('intent').filter(
          (i) => i.requestId === request.id,
        ))
          this.#delete('intent', intent.id);
      }
    }
    for (const id of this.#volatile.keys()) {
      const request = this.#get('request', id);
      if (
        !request ||
        !['pending', 'approved', 'coded', 'denied'].includes(request.state) ||
        request.expiresAt <= now
      )
        this.#volatile.delete(id);
    }
    for (const row of this.#db
      .prepare(
        "SELECT data FROM outside_oauth_records WHERE kind='grant' AND json_extract(data,'$.state')!='active' AND json_extract(data,'$.expiresAt')<=? LIMIT 100",
      )
      .all(now - 90 * DAY)) {
      const grant = this.#decode('grant', row.data);
      this.#delete('family', grant.familyId);
      this.#delete('grant', grant.id);
    }
  }
  retire(clientId: string, reason: 'denied' | 'revoked'): void {
    this.#write(() => {
      this.#expireLive();
      const client = this.#liveClient(clientId);
      if (
        this.#active().some((g) => g.clientId === clientId) ||
        this.#pending().some((r) => r.clientId === clientId)
      )
        throw new OutsideOAuthRefusal('target_changed');
      this.#retire(client, reason);
    });
  }
  #retire(
    client: Records['client'],
    reason: Records['tombstone']['reason'],
  ): void {
    this.#put('tombstone', client.id, {
      id: client.id,
      label: nameLabel(client.metadata.client_name ?? ''),
      reason,
      expiresAt: this.#now() + 30 * DAY,
    });
    this.#delete('client', client.id);
    this.#event('retired', { clientId: client.id, reason });
  }
  /** Delivery is at-least-once; the audit consumer deduplicates immutable event IDs. */
  outbox(limit = 100): Records['event'][] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new OutsideOAuthRefusal('invalid_request');
    return this.#write(() =>
      this.#db
        .prepare(
          "SELECT data FROM outside_oauth_records WHERE kind='event' AND json_extract(data,'$.deliveredAt') IS NULL ORDER BY json_extract(data,'$.at'),id LIMIT ?",
        )
        .all(limit)
        .map((row) => this.#decode('event', row.data)),
    );
  }
  acknowledge(eventId: string): void {
    this.#write(() => {
      const event = this.#get('event', eventId);
      if (event && event.deliveredAt === null)
        this.#put('event', eventId, { ...event, deliveredAt: this.#now() });
    });
  }
}
