import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
  APPLICATION_SESSION_PROOF_TYPE,
  APPLICATION_SESSION_VERSION,
  type ApplicationSessionCapabilities,
  type ApplicationSessionChallenge,
  type ApplicationSessionContinuation,
} from '@kontourai/station-contracts/application-session';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { PAIRING_SCOPE_ORCHESTRATION_READ } from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { calculateJwkThumbprint, importJWK, jwtVerify } from 'jose';
import { z } from 'zod/v3';
import { parseStrictBearer } from '../../security/runtime-request-security.js';
import {
  type DeploymentAuthenticationService,
  deploymentAccountPrincipal,
  type ResolvedDeploymentAuthentication,
} from './deployment-authentication-service.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: opaque,
    y: opaque,
  })
  .strict();
const challengeRecord = z
  .object({
    deviceId: z.string(),
    origin: z.string(),
    key: publicKey,
    keyThumbprint: opaque,
    nonce: opaque,
    expiresAt: z.number(),
  })
  .strict();
const continuationRecord = challengeRecord
  .extend({
    issuer: z.string(),
    sessionId: z.string(),
    principalId: z.string(),
    authorityKey: z.string(),
    relayEnrollmentId: z.string().optional(),
    relayApprovalId: z.string().optional(),
    relayApprovedBy: z.string().optional(),
    relaySubject: z.string().optional(),
  })
  .strict();
type Continuation = z.infer<typeof continuationRecord>;
type Challenge = z.infer<typeof challengeRecord>;
type Authenticated = Extract<
  ResolvedDeploymentAuthentication,
  { kind: 'authenticated' }
>;

/** Private, read-only assertion returned only for one reserved relay Device. */
interface PendingRelayDeviceAssertion {
  deviceId: string;
  enrollmentId: string;
  issuer: string;
  subject: string;
  approvalId: string;
  approvedBy: string;
  scope: readonly string[];
}

const relayEnrollmentId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export class ApplicationSessionRefusal extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'invalid'
      | 'unavailable'
      | 'origin_forbidden'
      | 'rate_limited',
  ) {
    super(`Application session ${code}.`);
  }
}

/** Account proof augments an existing approved Device credential; it never grants Device scope. */
export class ApplicationSessionService {
  private readonly admitted = new WeakMap<Request, string>();
  private closed = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly authentication: DeploymentAuthenticationService,
    private readonly stationId: string,
    private readonly requestOrigin: string,
    private readonly identifyDevice: (
      credential: string,
    ) => PairedDevice | null,
    private readonly origins: readonly string[] = [requestOrigin],
    private readonly now: () => number = Date.now,
    private readonly resolvePendingRelayDevice?: (
      deviceId: string,
      enrollmentId: string,
    ) => PendingRelayDeviceAssertion | null,
    private readonly resolveActiveRelayDevice?: (
      deviceId: string,
      enrollmentId: string,
    ) => PendingRelayDeviceAssertion | null,
  ) {
    if (!stationId.trim() || new URL(requestOrigin).origin !== requestOrigin)
      throw new ApplicationSessionRefusal('unavailable');
    this.transaction(() => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (tables.length) {
        if (
          tables.length !== 4 ||
          !tables.every(
            (row) =>
              typeof row.name === 'string' &&
              [
                'application_session_authority',
                'application_session_challenges',
                'application_sessions',
                'application_session_proofs',
              ].includes(row.name),
          )
        )
          throw new ApplicationSessionRefusal('unavailable');
        const authority = db
          .prepare(
            'SELECT version, station_id FROM application_session_authority WHERE singleton=1',
          )
          .get();
        if (authority?.version !== 1 || authority.station_id !== stationId)
          throw new ApplicationSessionRefusal('unavailable');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS application_session_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, station_id TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS application_session_challenges (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS application_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS application_session_proofs (token_hash TEXT NOT NULL, jti TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(token_hash,jti)) STRICT;
        CREATE INDEX IF NOT EXISTS application_challenge_expiry ON application_session_challenges(expires_at);
        CREATE INDEX IF NOT EXISTS application_session_expiry ON application_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS application_proof_expiry ON application_session_proofs(expires_at);`);
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS application_session_relay_authority ON application_sessions(json_extract(record, '$.authorityKey')) WHERE json_extract(record, '$.relayEnrollmentId') IS NOT NULL",
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS application_session_relay_enrollment ON application_sessions(json_extract(record, '$.relayEnrollmentId')) WHERE json_extract(record, '$.relayEnrollmentId') IS NOT NULL",
      );
      const row = db
        .prepare(
          'SELECT version, station_id FROM application_session_authority WHERE singleton=1',
        )
        .get();
      if (!row)
        db.prepare(
          'INSERT INTO application_session_authority VALUES (1,1,?)',
        ).run(stationId);
      else if (row.version !== 1 || row.station_id !== stationId)
        throw new ApplicationSessionRefusal('unavailable');
    });
  }
  capabilities(): ApplicationSessionCapabilities {
    const capabilities = this.authentication.sessionReferenceCapabilities();
    return {
      version: APPLICATION_SESSION_VERSION,
      cookieExchange: capabilities.verify,
      virtualLogin: capabilities.verify && capabilities.login,
      proofAlgorithm: 'ES256',
      stationId: this.stationId,
      requestOrigin: this.requestOrigin,
    };
  }
  async challenge(
    request: Request,
    key: unknown,
  ): Promise<ApplicationSessionChallenge> {
    if (!this.capabilities().cookieExchange)
      throw new ApplicationSessionRefusal('unsupported');
    const device = this.device(request);
    const origin = this.origin(request);
    const parsed = publicKey.parse(key);
    await importJWK(parsed, 'ES256');
    const keyThumbprint = await calculateJwkThumbprint(parsed);
    this.device(request, device.id);
    const challengeId = randomBytes(32).toString('base64url');
    const value: Challenge = {
      deviceId: device.id,
      origin,
      key: parsed,
      keyThumbprint,
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 120_000,
    };
    this.transaction(() => {
      this.prune();
      const total = this.db
        .prepare('SELECT count(*) AS n FROM application_session_challenges')
        .get()?.n;
      if (typeof total !== 'number' || total >= 1000)
        throw new ApplicationSessionRefusal('unavailable');
      this.db
        .prepare('INSERT INTO application_session_challenges VALUES (?,?,?)')
        .run(digest(challengeId), value.expiresAt, JSON.stringify(value));
    });
    return {
      version: APPLICATION_SESSION_VERSION,
      challengeId,
      nonce: value.nonce,
      expiresAt: new Date(value.expiresAt).toISOString(),
      stationId: this.stationId,
      requestOrigin: this.requestOrigin,
    };
  }
  async establish(
    request: Request,
    input: { challengeId: string; proof: string },
    login?: Request,
  ): Promise<ApplicationSessionContinuation> {
    if (
      !this.capabilities().cookieExchange ||
      (login && !this.capabilities().virtualLogin)
    )
      throw new ApplicationSessionRefusal('unsupported');
    const id = digest(opaque.parse(input.challengeId));
    const row = this.db
      .prepare('SELECT record FROM application_session_challenges WHERE id=?')
      .get(id);
    const challenge = this.parse(row?.record, challengeRecord);
    this.device(request, challenge.deviceId);
    if (
      this.origin(request) !== challenge.origin ||
      challenge.expiresAt <= this.now()
    )
      throw new ApplicationSessionRefusal('invalid');
    await this.proof(
      request,
      input.proof,
      challenge,
      login ? 'login' : 'exchange',
    );
    this.transaction(() => {
      if (
        this.db
          .prepare(
            'DELETE FROM application_session_challenges WHERE id=? AND expires_at>?',
          )
          .run(id, this.now()).changes !== 1
      )
        throw new ApplicationSessionRefusal('invalid');
    });
    const account = this.account(
      login
        ? await this.authentication.loginVirtualSession(login)
        : await this.authentication.authenticate(request),
    );
    const current = this.account(
      await this.authentication.verifySessionReference(
        account.session.sessionId,
        request.signal,
      ),
    );
    if (
      current.principal.id !== account.principal.id ||
      current.issuer !== account.issuer
    )
      throw new ApplicationSessionRefusal('invalid');
    this.device(request, challenge.deviceId, current.principal.id);
    return this.issue(challenge, current);
  }

  /**
   * Trusted relay coordinator only. Pending provider identity and the exact
   * reserved Device are independently rechecked before one proof-bound
   * continuation is persisted. This method has no route adapter.
   */
  async issuePendingRelayContinuation(input: {
    enrollmentId: string;
    deviceId: string;
    providerSessionId: string;
    issuer: string;
    subject: string;
    approvalId: string;
    approvedBy: string;
    authorityKey: string;
    stationId: string;
    clientOrigin: string;
    key: unknown;
    keyThumbprint: string;
    nonce: string;
    expiresAt: number;
    signal: AbortSignal;
  }): Promise<ApplicationSessionContinuation> {
    if (this.closed || input.signal.aborted)
      throw new ApplicationSessionRefusal('unavailable');
    const enrollmentId = relayEnrollmentId.parse(input.enrollmentId);
    const deviceId = z.string().uuid().parse(input.deviceId);
    const authorityKey = z.string().uuid().parse(input.authorityKey);
    const issuerAssertion = z.string().min(1).max(512).parse(input.issuer);
    const subjectAssertion = z.string().min(1).max(2048).parse(input.subject);
    const approvalId = z.string().uuid().parse(input.approvalId);
    const approvedBy = z.string().min(1).max(512).parse(input.approvedBy);
    const station = z.string().min(1).parse(input.stationId);
    const origin = z.string().url().parse(input.clientOrigin);
    const key = publicKey.parse(input.key);
    const keyThumbprint = await calculateJwkThumbprint(key);
    if (
      station !== this.stationId ||
      new URL(origin).origin !== origin ||
      !this.origins.includes(origin) ||
      keyThumbprint !== opaque.parse(input.keyThumbprint) ||
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt <= this.now()
    )
      throw new ApplicationSessionRefusal('invalid');
    await importJWK(key, 'ES256');

    const authentication = this.authentication;
    if (!authentication.pendingEnrollmentCapabilities().available)
      throw new ApplicationSessionRefusal('unsupported');
    const pending = await authentication.verifyPendingEnrollment(
      enrollmentId,
      input.providerSessionId,
      input.signal,
    );
    if (pending.kind === 'unavailable')
      throw new ApplicationSessionRefusal('unavailable');
    const providerIssuer = authentication.describe().issuer;
    if (
      pending.kind !== 'pending' ||
      pending.session.enrollmentId !== enrollmentId ||
      pending.session.sessionId !== input.providerSessionId ||
      pending.session.subject !== subjectAssertion ||
      providerIssuer !== issuerAssertion
    )
      throw new ApplicationSessionRefusal('invalid');

    const expiresAt = Math.min(
      input.expiresAt,
      Date.parse(pending.session.expiresAt),
      this.now() + 15 * 60_000,
    );
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
      throw new ApplicationSessionRefusal('invalid');
    const record: Continuation = {
      deviceId,
      origin,
      key,
      keyThumbprint,
      nonce: opaque.parse(input.nonce),
      expiresAt,
      issuer: providerIssuer,
      sessionId: pending.session.sessionId,
      principalId: deploymentAccountPrincipal(
        providerIssuer,
        pending.session.subject,
        pending.session.displayName,
      ).id,
      authorityKey,
      relayEnrollmentId: enrollmentId,
      relayApprovalId: approvalId,
      relayApprovedBy: approvedBy,
      relaySubject: pending.session.subject,
    };
    const assertion = this.resolvePendingRelayDevice?.(deviceId, enrollmentId);
    this.assertPendingRelayDevice(
      assertion,
      deviceId,
      enrollmentId,
      providerIssuer,
      pending.session.subject,
      approvalId,
      approvedBy,
    );
    const credential = randomBytes(32).toString('base64url');
    this.transaction(() => {
      if (input.signal.aborted || this.closed)
        throw new ApplicationSessionRefusal('unavailable');
      this.assertPendingRelayDevice(
        this.resolvePendingRelayDevice?.(deviceId, enrollmentId),
        deviceId,
        enrollmentId,
        providerIssuer,
        pending.session.subject,
        approvalId,
        approvedBy,
      );
      if (
        this.db
          .prepare(
            "SELECT 1 FROM application_sessions WHERE json_extract(record, '$.authorityKey')=?",
          )
          .get(authorityKey)
      )
        throw new ApplicationSessionRefusal('invalid');
      if (
        this.db
          .prepare(
            "SELECT 1 FROM application_sessions WHERE json_extract(record, '$.relayEnrollmentId')=?",
          )
          .get(enrollmentId)
      )
        throw new ApplicationSessionRefusal('invalid');
      this.prune();
      const count = this.db
        .prepare('SELECT count(*) AS n FROM application_sessions')
        .get()?.n;
      if (typeof count !== 'number' || count >= 10_000)
        throw new ApplicationSessionRefusal('unavailable');
      this.db
        .prepare('INSERT INTO application_sessions VALUES (?,?,?)')
        .run(digest(credential), expiresAt, JSON.stringify(record));
    });
    return {
      version: APPLICATION_SESSION_VERSION,
      credential,
      authorityKey,
      stationId: this.stationId,
      deviceId,
      principal: deploymentAccountPrincipal(
        providerIssuer,
        pending.session.subject,
        pending.session.displayName,
      ),
      requestOrigin: this.requestOrigin,
      clientOrigin: origin,
      keyThumbprint,
      nonce: record.nonce,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async authenticate(
    request: Request,
  ): Promise<ResolvedDeploymentAuthentication> {
    try {
      const token = request.headers.get(APPLICATION_SESSION_HEADER);
      const signed = request.headers.get(APPLICATION_SESSION_PROOF_HEADER);
      if (!token || !signed) throw new ApplicationSessionRefusal('invalid');
      const hash = digest(opaque.parse(token));
      const record = this.read(hash);
      this.device(request, record.deviceId, record.principalId);
      if (this.origin(request) !== record.origin)
        throw new ApplicationSessionRefusal('invalid');
      const fingerprint = digest(
        JSON.stringify([
          token,
          signed,
          request.method,
          request.url,
          request.headers.get('Authorization'),
          request.headers.get('Origin'),
        ]),
      );
      if (this.admitted.get(request) !== fingerprint) {
        const jti = await this.proof(request, signed, record, 'request', token);
        this.transaction(() => {
          this.read(hash);
          this.prune();
          const count = this.db
            .prepare('SELECT count(*) AS n FROM application_session_proofs')
            .get()?.n;
          if (typeof count !== 'number' || count >= 100_000)
            throw new ApplicationSessionRefusal('unavailable');
          if (
            this.db
              .prepare(
                'INSERT OR IGNORE INTO application_session_proofs VALUES (?,?,?)',
              )
              .run(hash, jti, this.now() + 120_000).changes !== 1
          )
            throw new ApplicationSessionRefusal('invalid');
        });
        this.admitted.set(request, fingerprint);
      }
      const result = this.account(
        await this.authentication.verifySessionReference(
          record.sessionId,
          request.signal,
        ),
      );
      this.read(hash);
      this.device(request, record.deviceId, record.principalId);
      if (
        result.principal.id !== record.principalId ||
        result.issuer !== record.issuer ||
        request.signal.aborted
      )
        throw new ApplicationSessionRefusal('invalid');
      return {
        ...result,
        session: {
          ...result.session,
          expiresAt: new Date(
            Math.min(Date.parse(result.session.expiresAt), record.expiresAt),
          ).toISOString(),
        },
      };
    } catch (error) {
      return error instanceof z.ZodError ||
        (error instanceof ApplicationSessionRefusal &&
          error.code !== 'unavailable' &&
          error.code !== 'unsupported')
        ? { kind: 'invalid', reason: 'invalid-credential' }
        : { kind: 'unavailable' };
    }
  }
  transferRequest(source: Request, replacement: Request): void {
    const fingerprint = this.admitted.get(source);
    if (
      fingerprint &&
      source.url === replacement.url &&
      source.method === replacement.method &&
      source.headers.get(APPLICATION_SESSION_HEADER) ===
        replacement.headers.get(APPLICATION_SESSION_HEADER) &&
      source.headers.get(APPLICATION_SESSION_PROOF_HEADER) ===
        replacement.headers.get(APPLICATION_SESSION_PROOF_HEADER) &&
      source.headers.get('Authorization') ===
        replacement.headers.get('Authorization') &&
      source.headers.get('Origin') === replacement.headers.get('Origin')
    )
      this.admitted.set(replacement, fingerprint);
  }
  async renew(request: Request): Promise<ApplicationSessionContinuation> {
    const account = this.account(await this.authenticate(request));
    const hash = digest(request.headers.get(APPLICATION_SESSION_HEADER)!);
    const current = this.read(hash);
    // Refresh the source expiry, not the short continuation expiry projected on the request.
    const source = this.account(
      await this.authentication.verifySessionReference(
        current.sessionId,
        request.signal,
      ),
    );
    const live = this.read(hash);
    this.device(request, live.deviceId, account.principal.id);
    if (
      source.principal.id !== live.principalId ||
      source.issuer !== live.issuer
    )
      throw new ApplicationSessionRefusal('invalid');
    return this.issue(
      live,
      source,
      live.authorityKey,
      live.relayEnrollmentId ? hash : undefined,
    );
  }
  async revoke(request: Request): Promise<void> {
    const account = this.account(await this.authenticate(request));
    const hash = digest(request.headers.get(APPLICATION_SESSION_HEADER)!);
    const record = this.read(hash);
    await this.authentication.revokeSessionReference(
      account.session.sessionId,
      request.signal,
    );
    this.db
      .prepare(
        "DELETE FROM application_sessions WHERE json_extract(record, '$.authorityKey')=?",
      )
      .run(record.authorityKey);
  }
  /** Server recovery only: remove one never-committed relay continuation authority. */
  discardUncommittedAuthority(
    authorityKey: string,
    enrollmentId: string,
  ): number {
    if (this.closed) throw new ApplicationSessionRefusal('unavailable');
    if (!/^[0-9a-f-]{36}$/i.test(authorityKey))
      throw new ApplicationSessionRefusal('invalid');
    return Number(
      this.db
        .prepare(
          "DELETE FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
        )
        .run(authorityKey, relayEnrollmentId.parse(enrollmentId)).changes,
    );
  }

  /** Verify one inert continuation still matches a pending Device and approval. */
  verifyPendingRelayContinuation(input: {
    authorityKey: string;
    enrollmentId: string;
    deviceId: string;
    issuer: string;
    subject: string;
    approvalId: string;
    approvedBy: string;
    clientOrigin: string;
    keyThumbprint: string;
  }): boolean {
    return this.verifyRelayContinuation(input, this.resolvePendingRelayDevice);
  }

  /** Verify the same continuation and grant after the exact Device activates. */
  async verifyActiveRelayContinuation(input: {
    authorityKey: string;
    enrollmentId: string;
    deviceId: string;
    clientOrigin: string;
    keyThumbprint: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (this.closed || input.signal.aborted) return false;
    const parsed = z
      .object({
        authorityKey: z.string().uuid(),
        enrollmentId: relayEnrollmentId,
        deviceId: z.string().uuid(),
        clientOrigin: z.string().url(),
        keyThumbprint: opaque,
      })
      .safeParse(input);
    if (!parsed.success) return false;
    const row = this.db
      .prepare(
        "SELECT record FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
      )
      .get(input.authorityKey, input.enrollmentId);
    if (typeof row?.record !== 'string') return false;
    const persistedRecord = row.record;
    let raw: unknown;
    try {
      raw = JSON.parse(persistedRecord);
    } catch {
      return false;
    }
    const continuation = continuationRecord.safeParse(raw);
    if (
      !continuation.success ||
      continuation.data.expiresAt <= this.now() ||
      continuation.data.authorityKey !== parsed.data.authorityKey ||
      continuation.data.relayEnrollmentId !== parsed.data.enrollmentId ||
      continuation.data.deviceId !== parsed.data.deviceId ||
      continuation.data.origin !== parsed.data.clientOrigin ||
      continuation.data.keyThumbprint !== parsed.data.keyThumbprint ||
      !continuation.data.relayApprovalId ||
      !continuation.data.relayApprovedBy
    )
      return false;
    const assertion = this.resolveActiveRelayDevice?.(
      parsed.data.deviceId,
      parsed.data.enrollmentId,
    );
    try {
      this.assertPendingRelayDevice(
        assertion,
        parsed.data.deviceId,
        parsed.data.enrollmentId,
        continuation.data.issuer,
        continuation.data.relaySubject!,
        continuation.data.relayApprovalId,
        continuation.data.relayApprovedBy,
      );
    } catch {
      return false;
    }
    const active = await this.authentication.verifySessionReference(
      continuation.data.sessionId,
      input.signal,
    );
    if (this.closed || input.signal.aborted || active.kind !== 'authenticated')
      return false;
    if (
      active.issuer !== continuation.data.issuer ||
      active.session.subject !== continuation.data.relaySubject
    )
      return false;
    const currentRow = this.db
      .prepare(
        "SELECT record FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
      )
      .get(parsed.data.authorityKey, parsed.data.enrollmentId);
    if (
      currentRow?.record !== persistedRecord ||
      continuation.data.expiresAt <= this.now()
    )
      return false;
    const currentDevice = this.resolveActiveRelayDevice?.(
      parsed.data.deviceId,
      parsed.data.enrollmentId,
    );
    try {
      this.assertPendingRelayDevice(
        currentDevice,
        parsed.data.deviceId,
        parsed.data.enrollmentId,
        continuation.data.issuer,
        continuation.data.relaySubject!,
        continuation.data.relayApprovalId,
        continuation.data.relayApprovedBy,
      );
    } catch {
      return false;
    }
    return !this.closed && !input.signal.aborted;
  }

  private verifyRelayContinuation(
    input: {
      authorityKey: string;
      enrollmentId: string;
      deviceId: string;
      issuer: string;
      subject: string;
      approvalId: string;
      approvedBy: string;
      clientOrigin: string;
      keyThumbprint: string;
    },
    resolveDevice:
      | ApplicationSessionService['resolvePendingRelayDevice']
      | ApplicationSessionService['resolveActiveRelayDevice'],
  ): boolean {
    if (this.closed) return false;
    const parsed = z
      .object({
        authorityKey: z.string().uuid(),
        enrollmentId: relayEnrollmentId,
        deviceId: z.string().uuid(),
        issuer: z.string().min(1).max(512),
        subject: z.string().min(1).max(2048),
        approvalId: z.string().uuid(),
        approvedBy: z.string().min(1).max(512),
        clientOrigin: z.string().url(),
        keyThumbprint: opaque,
      })
      .safeParse(input);
    if (!parsed.success) return false;
    const row = this.db
      .prepare(
        "SELECT record FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
      )
      .get(parsed.data.authorityKey, parsed.data.enrollmentId);
    if (typeof row?.record !== 'string') return false;
    let raw: unknown;
    try {
      raw = JSON.parse(row.record);
    } catch {
      return false;
    }
    const continuation = continuationRecord.safeParse(raw);
    if (
      !continuation.success ||
      continuation.data.expiresAt <= this.now() ||
      continuation.data.authorityKey !== parsed.data.authorityKey ||
      continuation.data.relayEnrollmentId !== parsed.data.enrollmentId ||
      continuation.data.deviceId !== parsed.data.deviceId ||
      continuation.data.issuer !== parsed.data.issuer ||
      continuation.data.relaySubject !== parsed.data.subject ||
      continuation.data.relayApprovalId !== parsed.data.approvalId ||
      continuation.data.relayApprovedBy !== parsed.data.approvedBy ||
      continuation.data.origin !== parsed.data.clientOrigin ||
      continuation.data.keyThumbprint !== parsed.data.keyThumbprint
    )
      return false;
    const assertion = resolveDevice?.(
      parsed.data.deviceId,
      parsed.data.enrollmentId,
    );
    try {
      this.assertPendingRelayDevice(
        assertion,
        parsed.data.deviceId,
        parsed.data.enrollmentId,
        parsed.data.issuer,
        parsed.data.subject,
        parsed.data.approvalId,
        parsed.data.approvedBy,
      );
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private async issue(
    challenge: Challenge | Continuation,
    account: Authenticated,
    authorityKey: string = randomUUID(),
    rotateRelayTokenHash?: string,
  ): Promise<ApplicationSessionContinuation> {
    const relayEnrollmentId =
      'relayEnrollmentId' in challenge
        ? challenge.relayEnrollmentId
        : undefined;
    if (!!relayEnrollmentId !== !!rotateRelayTokenHash)
      throw new ApplicationSessionRefusal('invalid');
    const credential = randomBytes(32).toString('base64url');
    const keyThumbprint = challenge.keyThumbprint;
    const expiresAt = Math.min(
      this.now() + 15 * 60_000,
      Date.parse(account.session.expiresAt),
    );
    const record: Continuation = {
      ...challenge,
      expiresAt,
      issuer: account.issuer,
      sessionId: account.session.sessionId,
      principalId: account.principal.id,
      authorityKey,
      keyThumbprint,
      nonce: randomBytes(32).toString('base64url'),
    };
    this.transaction(() => {
      this.prune();
      if (rotateRelayTokenHash && relayEnrollmentId) {
        const previousRow = this.db
          .prepare(
            'SELECT record FROM application_sessions WHERE token_hash=? AND expires_at>? ',
          )
          .get(rotateRelayTokenHash, this.now());
        const previous = this.parse(previousRow?.record, continuationRecord);
        if (
          previous.relayEnrollmentId !== relayEnrollmentId ||
          previous.authorityKey !== authorityKey ||
          previous.deviceId !== record.deviceId ||
          previous.issuer !== record.issuer ||
          previous.principalId !== record.principalId ||
          // verifySessionReference refuses a changed sessionId as a conflicting identity.
          previous.sessionId !== record.sessionId ||
          previous.keyThumbprint !== record.keyThumbprint ||
          previous.nonce !== challenge.nonce ||
          previous.relayApprovalId !== record.relayApprovalId ||
          previous.relayApprovedBy !== record.relayApprovedBy ||
          previous.relaySubject !== record.relaySubject
        )
          throw new ApplicationSessionRefusal('invalid');
        if (
          this.db
            .prepare(
              "DELETE FROM application_sessions WHERE token_hash=? AND json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
            )
            .run(rotateRelayTokenHash, authorityKey, relayEnrollmentId)
            .changes !== 1
        )
          throw new ApplicationSessionRefusal('invalid');
        this.db
          .prepare('DELETE FROM application_session_proofs WHERE token_hash=?')
          .run(rotateRelayTokenHash);
      }
      const count = this.db
        .prepare('SELECT count(*) AS n FROM application_sessions')
        .get()?.n;
      if (typeof count !== 'number' || count >= 10_000)
        throw new ApplicationSessionRefusal('unavailable');
      this.db
        .prepare('INSERT INTO application_sessions VALUES (?,?,?)')
        .run(digest(credential), expiresAt, JSON.stringify(record));
    });
    return {
      version: APPLICATION_SESSION_VERSION,
      credential,
      authorityKey,
      stationId: this.stationId,
      deviceId: record.deviceId,
      principal: account.principal,
      requestOrigin: this.requestOrigin,
      clientOrigin: record.origin,
      keyThumbprint,
      nonce: record.nonce,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  private read(hash: string): Continuation {
    if (this.closed) throw new ApplicationSessionRefusal('unavailable');
    const row = this.db
      .prepare(
        'SELECT record FROM application_sessions WHERE token_hash=? AND expires_at>?',
      )
      .get(hash, this.now());
    const value = this.parse(row?.record, continuationRecord);
    if (value.expiresAt <= this.now())
      throw new ApplicationSessionRefusal('invalid');
    return value;
  }
  private async proof(
    request: Request,
    proof: string,
    record: Challenge,
    purpose: 'request' | 'exchange' | 'login',
    credential?: string,
  ): Promise<string> {
    if (proof.length > 4096 || request.signal.aborted)
      throw new ApplicationSessionRefusal('invalid');
    try {
      const key = await importJWK(record.key, 'ES256');
      const { payload, protectedHeader } = await jwtVerify(proof, key, {
        algorithms: ['ES256'],
        typ: APPLICATION_SESSION_PROOF_TYPE,
        maxTokenAge: 60,
        clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
      z.object({
        alg: z.literal('ES256'),
        typ: z.literal(APPLICATION_SESSION_PROOF_TYPE),
      })
        .strict()
        .parse(protectedHeader);
      const claims = z
        .object({
          v: z.literal(APPLICATION_SESSION_VERSION),
          stationId: z.string(),
          purpose: z.enum(['request', 'exchange', 'login']),
          nonce: opaque,
          htm: z.string(),
          htu: z.string(),
          ath: opaque.optional(),
          jti: z.string().min(22).max(128),
          iat: z.number().int(),
        })
        .strict()
        .parse(payload);
      const url = new URL(request.url);
      const target = this.requestOrigin + url.pathname + url.search;
      if (
        claims.stationId !== this.stationId ||
        claims.purpose !== purpose ||
        claims.nonce !== record.nonce ||
        claims.htm !== request.method ||
        claims.htu !== target ||
        claims.ath !== (credential ? digest(credential) : undefined)
      )
        throw new ApplicationSessionRefusal('invalid');
      return claims.jti;
    } catch {
      throw new ApplicationSessionRefusal('invalid');
    }
  }
  private device(
    request: Request,
    expected?: string,
    principalId?: string,
  ): PairedDevice {
    if (this.closed || request.signal.aborted)
      throw new ApplicationSessionRefusal('unavailable');
    const bearer = parseStrictBearer(
      request.headers.get('Authorization') ?? undefined,
    );
    const device = bearer ? this.identifyDevice(bearer) : null;
    if (device?.kind !== 'device' || (expected && device.id !== expected))
      throw new ApplicationSessionRefusal('invalid');
    const binding = device.principalBinding;
    const accountBinding =
      binding && 'kind' in binding && binding.kind === 'account'
        ? binding
        : undefined;
    const ingressBinding =
      binding && !('kind' in binding) ? binding : undefined;
    const bindingPrincipalId = accountBinding
      ? deploymentAccountPrincipal(
          accountBinding.issuer,
          accountBinding.subject,
          accountBinding.displayName,
        ).id
      : ingressBinding
        ? humanPrincipal(
            ingressBinding.provider,
            ingressBinding.subject,
            ingressBinding.subject,
          ).id
        : undefined;
    if (bindingPrincipalId && principalId && bindingPrincipalId !== principalId)
      throw new ApplicationSessionRefusal('invalid');
    return device;
  }
  private origin(request: Request): string {
    const origin = request.headers.get('Origin');
    if (!origin || !this.origins.includes(origin))
      throw new ApplicationSessionRefusal('origin_forbidden');
    return origin;
  }
  private account(value: ResolvedDeploymentAuthentication): Authenticated {
    if (value.kind !== 'authenticated')
      throw new ApplicationSessionRefusal(
        value.kind === 'unavailable' ? 'unavailable' : 'invalid',
      );
    return value;
  }
  private assertPendingRelayDevice(
    assertion: PendingRelayDeviceAssertion | null | undefined,
    deviceId: string,
    enrollmentId: string,
    issuer: string,
    subject: string,
    approvalId: string,
    approvedBy: string,
  ): asserts assertion is PendingRelayDeviceAssertion {
    if (
      !assertion ||
      assertion.deviceId !== deviceId ||
      assertion.enrollmentId !== enrollmentId ||
      assertion.issuer !== issuer ||
      assertion.subject !== subject ||
      assertion.approvalId !== approvalId ||
      assertion.approvedBy !== approvedBy ||
      assertion.scope.length !== 1 ||
      assertion.scope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ
    )
      throw new ApplicationSessionRefusal('invalid');
  }
  private parse<T extends z.ZodTypeAny>(value: unknown, schema: T): z.infer<T> {
    if (value === undefined) throw new ApplicationSessionRefusal('invalid');
    if (typeof value !== 'string')
      throw new ApplicationSessionRefusal('unavailable');
    try {
      return schema.parse(JSON.parse(value));
    } catch {
      throw new ApplicationSessionRefusal('unavailable');
    }
  }
  private prune() {
    for (const table of [
      'application_session_challenges',
      'application_sessions',
      'application_session_proofs',
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE expires_at<=?`)
        .run(this.now());
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
