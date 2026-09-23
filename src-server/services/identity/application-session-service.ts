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
  type ApplicationSessionCookieAdoption,
} from '@kontourai/station-contracts/application-session';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
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
const cookieAdoptionBinding = z
  .object({
    parentCredentialHash: opaque,
    issuer: z.string(),
    sessionId: z.string(),
    principalId: z.string(),
  })
  .strict();
const challengeRecord = z
  .object({
    deviceId: z.string(),
    aliasId: z.string().uuid().optional(),
    adoption: cookieAdoptionBinding.optional(),
    adoptionId: z.string().uuid().optional(),
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
  })
  .strict();
type Continuation = z.infer<typeof continuationRecord>;
type Challenge = z.infer<typeof challengeRecord>;
type Authenticated = Extract<
  ResolvedDeploymentAuthentication,
  { kind: 'authenticated' }
>;
type RelayAliasIssue = {
  aliasId: string;
  credential: string;
  deviceId: string;
  expiresAt: number;
};
export type ApplicationSessionCookieAdoptionCallbacks = {
  readSecureDeviceCookie: (request: Request) => string | undefined;
  issueAlias: (
    parentCredential: string,
    deviceId: string,
    aliasId: string,
  ) => RelayAliasIssue;
  revokeAlias: (deviceId: string, aliasId: string) => boolean;
};

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
    private readonly credentialAliasId: (
      credential: string,
    ) => string | undefined = () => undefined,
    private readonly adoption?: ApplicationSessionCookieAdoptionCallbacks,
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
        const tableNames = tables.map((row) => row.name);
        const requiredTables = [
          'application_session_authority',
          'application_session_challenges',
          'application_sessions',
          'application_session_proofs',
        ];
        if (
          (tables.length !== 4 && tables.length !== 5) ||
          !tableNames.every(
            (name) =>
              typeof name === 'string' &&
              [...requiredTables, 'application_session_adoptions'].includes(
                name,
              ),
          ) ||
          !requiredTables.every((name) => tableNames.includes(name))
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
        CREATE TABLE IF NOT EXISTS application_session_adoptions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, alias_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','issued','active','revoking'))) STRICT;
        CREATE INDEX IF NOT EXISTS application_challenge_expiry ON application_session_challenges(expires_at);
        CREATE INDEX IF NOT EXISTS application_session_expiry ON application_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS application_proof_expiry ON application_session_proofs(expires_at);
        CREATE INDEX IF NOT EXISTS application_adoption_expiry ON application_session_adoptions(expires_at);`);
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
    this.recoverInterruptedAdoptions();
  }
  capabilities(): ApplicationSessionCapabilities {
    const capabilities = this.authentication.sessionReferenceCapabilities();
    return {
      version: APPLICATION_SESSION_VERSION,
      cookieExchange: capabilities.verify,
      cookieAdoption:
        capabilities.verify &&
        this.adoption !== undefined &&
        new URL(this.requestOrigin).protocol === 'https:',
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
    const aliasId = this.currentAliasId(request);
    const adoptionId = this.activeAdoptionId(device.id, aliasId);
    const origin = this.origin(request);
    const parsed = publicKey.parse(key);
    await importJWK(parsed, 'ES256');
    const keyThumbprint = await calculateJwkThumbprint(parsed);
    this.device(request, device.id);
    this.assertAdoptionBinding(device.id, aliasId, adoptionId);
    const challengeId = randomBytes(32).toString('base64url');
    const value: Challenge = {
      deviceId: device.id,
      ...(aliasId ? { aliasId } : {}),
      ...(adoptionId ? { adoptionId } : {}),
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
  async cookieAdoptionChallenge(
    request: Request,
    key: unknown,
  ): Promise<ApplicationSessionChallenge> {
    if (!this.capabilities().cookieAdoption)
      throw new ApplicationSessionRefusal('unsupported');
    const origin = this.cookieAdoptionOrigin(request);
    const { credential, device } = this.cookieDevice(request);
    if (this.credentialAliasId(credential) !== undefined)
      throw new ApplicationSessionRefusal('invalid');
    const account = await this.currentProviderSession(request);
    this.deviceCredential(credential, device.id, account.principal.id);
    const parsed = publicKey.parse(key);
    await importJWK(parsed, 'ES256');
    const keyThumbprint = await calculateJwkThumbprint(parsed);
    const current = await this.currentProviderSession(request);
    if (
      current.session.sessionId !== account.session.sessionId ||
      current.issuer !== account.issuer ||
      current.principal.id !== account.principal.id
    )
      throw new ApplicationSessionRefusal('invalid');
    const latest = this.cookieDevice(request);
    if (
      latest.device.id !== device.id ||
      digest(latest.credential) !== digest(credential)
    )
      throw new ApplicationSessionRefusal('invalid');
    this.deviceCredential(credential, device.id, current.principal.id);
    const challengeId = randomBytes(32).toString('base64url');
    const value: Challenge = {
      deviceId: device.id,
      origin,
      key: parsed,
      keyThumbprint,
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 120_000,
      adoption: {
        parentCredentialHash: digest(credential),
        issuer: current.issuer,
        sessionId: current.session.sessionId,
        principalId: current.principal.id,
      },
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
    this.assertAlias(request, challenge.aliasId);
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
    this.assertAlias(request, challenge.aliasId);
    this.assertAdoptionBinding(
      challenge.deviceId,
      challenge.aliasId,
      challenge.adoptionId,
    );
    return this.issue(challenge, current);
  }
  async completeCookieAdoption(
    request: Request,
    input: { challengeId: string; proof: string },
  ): Promise<ApplicationSessionCookieAdoption> {
    if (!this.capabilities().cookieAdoption || !this.adoption)
      throw new ApplicationSessionRefusal('unsupported');
    const id = digest(opaque.parse(input.challengeId));
    const row = this.db
      .prepare('SELECT record FROM application_session_challenges WHERE id=?')
      .get(id);
    const challenge = this.parse(row?.record, challengeRecord);
    const binding = challenge.adoption;
    if (!binding || challenge.expiresAt <= this.now())
      throw new ApplicationSessionRefusal('invalid');
    this.cookieAdoptionOrigin(request);
    const { credential, device } = this.cookieDevice(request);
    if (
      device.id !== challenge.deviceId ||
      digest(credential) !== binding.parentCredentialHash ||
      this.credentialAliasId(credential) !== undefined
    )
      throw new ApplicationSessionRefusal('invalid');
    const account = await this.currentProviderSession(request);
    if (
      account.session.sessionId !== binding.sessionId ||
      account.issuer !== binding.issuer ||
      account.principal.id !== binding.principalId
    )
      throw new ApplicationSessionRefusal('invalid');
    await this.proof(request, input.proof, challenge, 'adopt-cookie');
    const current = await this.currentProviderSession(request);
    if (
      current.session.sessionId !== binding.sessionId ||
      current.issuer !== binding.issuer ||
      current.principal.id !== binding.principalId
    )
      throw new ApplicationSessionRefusal('invalid');
    const latestDevice = this.cookieDevice(request);
    if (
      latestDevice.device.id !== device.id ||
      latestDevice.credential !== credential
    )
      throw new ApplicationSessionRefusal('invalid');
    this.deviceCredential(credential, device.id, current.principal.id);

    const adoptionId = randomUUID();
    const aliasId = randomUUID();
    const expiresAt = this.now() + 30 * 24 * 60 * 60_000 + 60_000;
    this.transaction(() => {
      if (
        this.db
          .prepare(
            'DELETE FROM application_session_challenges WHERE id=? AND expires_at>?',
          )
          .run(id, this.now()).changes !== 1
      )
        throw new ApplicationSessionRefusal('invalid');
      this.db
        .prepare('INSERT INTO application_session_adoptions VALUES (?,?,?,?,?)')
        .run(adoptionId, device.id, aliasId, expiresAt, 'prepared');
    });

    let alias: RelayAliasIssue | undefined;
    try {
      alias = this.adoption.issueAlias(credential, device.id, aliasId);
      if (
        alias.aliasId !== aliasId ||
        alias.deviceId !== device.id ||
        alias.expiresAt <= this.now() ||
        alias.expiresAt > expiresAt
      )
        throw new ApplicationSessionRefusal('unavailable');
      this.transaction(() => {
        if (
          this.db
            .prepare(
              "UPDATE application_session_adoptions SET expires_at=? WHERE id=? AND state='prepared' AND alias_id=?",
            )
            .run(alias!.expiresAt, adoptionId, aliasId).changes !== 1
        )
          throw new ApplicationSessionRefusal('unavailable');
      });
      const afterMint = await this.currentProviderSession(request);
      if (
        afterMint.session.sessionId !== binding.sessionId ||
        afterMint.issuer !== binding.issuer ||
        afterMint.principal.id !== binding.principalId
      )
        throw new ApplicationSessionRefusal('invalid');
      const cookieDevice = this.cookieDevice(request);
      this.deviceCredential(
        cookieDevice.credential,
        device.id,
        afterMint.principal.id,
      );
      if (cookieDevice.credential !== credential)
        throw new ApplicationSessionRefusal('invalid');
      const { adoption: _binding, ...continuationChallenge } = challenge;
      const continuation = await this.issue(
        { ...continuationChallenge, aliasId },
        afterMint,
        randomUUID(),
        adoptionId,
      );
      return {
        version: APPLICATION_SESSION_VERSION,
        aliasCredential: alias.credential,
        aliasId,
        aliasExpiresAt: new Date(alias.expiresAt).toISOString(),
        continuation,
      };
    } catch (error) {
      try {
        this.adoption.revokeAlias(device.id, alias?.aliasId ?? aliasId);
        this.removeAdoption(adoptionId);
      } catch {
        // Retain the prepared/issued journal for startup compensation.
        throw new ApplicationSessionRefusal('unavailable');
      }
      if (error instanceof ApplicationSessionRefusal) throw error;
      throw new ApplicationSessionRefusal('unavailable');
    }
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
      this.assertAlias(request, record.aliasId);
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
      this.assertAlias(request, record.aliasId);
      if (
        result.principal.id !== record.principalId ||
        result.issuer !== record.issuer ||
        request.signal.aborted
      )
        throw new ApplicationSessionRefusal('invalid');
      this.markAdoptionActive(record);
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
    this.read(hash);
    this.device(request, current.deviceId, account.principal.id);
    this.assertAlias(request, current.aliasId);
    if (
      source.principal.id !== current.principalId ||
      source.issuer !== current.issuer
    )
      throw new ApplicationSessionRefusal('invalid');
    return this.issue(current, source, current.authorityKey);
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
  async revokeAlias(request: Request): Promise<{ revoked: true }> {
    if (!this.adoption) throw new ApplicationSessionRefusal('unsupported');
    this.account(await this.authenticate(request));
    const hash = digest(request.headers.get(APPLICATION_SESSION_HEADER)!);
    const record = this.read(hash);
    this.device(request, record.deviceId, record.principalId);
    this.assertAlias(request, record.aliasId);
    const aliasId = record.aliasId;
    const adoptionId = record.adoptionId;
    if (!aliasId || !adoptionId)
      throw new ApplicationSessionRefusal('unsupported');
    this.transaction(() => {
      if (
        this.db
          .prepare(
            "UPDATE application_session_adoptions SET state='revoking' WHERE id=? AND device_id=? AND alias_id=? AND state='active'",
          )
          .run(adoptionId, record.deviceId, aliasId).changes !== 1
      )
        throw new ApplicationSessionRefusal('invalid');
    });
    try {
      if (!this.adoption.revokeAlias(record.deviceId, aliasId))
        throw new ApplicationSessionRefusal('unavailable');
      this.removeAdoption(adoptionId);
    } catch (error) {
      if (error instanceof ApplicationSessionRefusal) throw error;
      throw new ApplicationSessionRefusal('unavailable');
    }
    return { revoked: true };
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private async issue(
    challenge: Challenge,
    account: Authenticated,
    authorityKey: string = randomUUID(),
    adoptionId?: string,
  ): Promise<ApplicationSessionContinuation> {
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
      ...(adoptionId ? { adoptionId } : {}),
    };
    this.transaction(() => {
      this.prune();
      const count = this.db
        .prepare('SELECT count(*) AS n FROM application_sessions')
        .get()?.n;
      if (typeof count !== 'number' || count >= 10_000)
        throw new ApplicationSessionRefusal('unavailable');
      this.db
        .prepare('INSERT INTO application_sessions VALUES (?,?,?)')
        .run(digest(credential), expiresAt, JSON.stringify(record));
      if (adoptionId !== undefined) {
        if (!record.aliasId) throw new ApplicationSessionRefusal('unavailable');
        if (
          this.db
            .prepare(
              "UPDATE application_session_adoptions SET state='issued' WHERE id=? AND device_id=? AND alias_id=? AND state='prepared'",
            )
            .run(adoptionId, record.deviceId, record.aliasId).changes !== 1
        )
          throw new ApplicationSessionRefusal('unavailable');
      }
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
    purpose: 'request' | 'exchange' | 'login' | 'adopt-cookie',
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
          purpose: z.enum(['request', 'exchange', 'login', 'adopt-cookie']),
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
    if (!bearer) throw new ApplicationSessionRefusal('invalid');
    return this.deviceCredential(bearer, expected, principalId);
  }
  private deviceCredential(
    credential: string,
    expected?: string,
    principalId?: string,
  ): PairedDevice {
    if (this.closed) throw new ApplicationSessionRefusal('unavailable');
    const device = this.identifyDevice(credential);
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
  private cookieAdoptionOrigin(request: Request): string {
    if (
      this.closed ||
      request.signal.aborted ||
      request.method !== 'POST' ||
      new URL(this.requestOrigin).protocol !== 'https:' ||
      request.headers.get('Origin') !== this.requestOrigin ||
      request.headers.has('Authorization') ||
      request.headers.has(APPLICATION_SESSION_HEADER) ||
      request.headers.has(APPLICATION_SESSION_PROOF_HEADER)
    )
      throw new ApplicationSessionRefusal('origin_forbidden');
    return this.requestOrigin;
  }
  private cookieDevice(request: Request): {
    credential: string;
    device: PairedDevice;
  } {
    if (!this.adoption) throw new ApplicationSessionRefusal('unsupported');
    const credential = this.adoption.readSecureDeviceCookie(request);
    if (!credential) throw new ApplicationSessionRefusal('invalid');
    const device = this.deviceCredential(credential);
    if (this.credentialAliasId(credential) !== undefined)
      throw new ApplicationSessionRefusal('invalid');
    return { credential, device };
  }
  private async currentProviderSession(
    request: Request,
  ): Promise<Authenticated> {
    const observed = this.account(
      await this.authentication.authenticate(request),
    );
    const current = this.account(
      await this.authentication.verifySessionReference(
        observed.session.sessionId,
        request.signal,
      ),
    );
    if (
      current.session.sessionId !== observed.session.sessionId ||
      current.issuer !== observed.issuer ||
      current.principal.id !== observed.principal.id
    )
      throw new ApplicationSessionRefusal('invalid');
    return current;
  }
  private removeAdoption(adoptionId: string): void {
    this.transaction(() => {
      const sessions = this.db
        .prepare(
          "SELECT token_hash FROM application_sessions WHERE json_extract(record, '$.adoptionId')=?",
        )
        .all(adoptionId);
      for (const session of sessions)
        this.db
          .prepare('DELETE FROM application_session_proofs WHERE token_hash=?')
          .run(session.token_hash);
      this.db
        .prepare(
          "DELETE FROM application_sessions WHERE json_extract(record, '$.adoptionId')=?",
        )
        .run(adoptionId);
      this.db
        .prepare('DELETE FROM application_session_adoptions WHERE id=?')
        .run(adoptionId);
    });
  }
  private recoverInterruptedAdoptions(): void {
    const pending = this.db
      .prepare(
        "SELECT id, device_id, alias_id FROM application_session_adoptions WHERE state IN ('prepared','issued','revoking') ORDER BY id",
      )
      .all();
    if (pending.length && !this.adoption)
      throw new ApplicationSessionRefusal('unavailable');
    for (const row of pending) {
      if (
        typeof row.id !== 'string' ||
        typeof row.device_id !== 'string' ||
        typeof row.alias_id !== 'string'
      )
        throw new ApplicationSessionRefusal('unavailable');
      try {
        this.adoption!.revokeAlias(row.device_id, row.alias_id);
        this.removeAdoption(row.id);
      } catch {
        throw new ApplicationSessionRefusal('unavailable');
      }
    }
  }
  private currentAliasId(request: Request): string | undefined {
    const bearer = parseStrictBearer(
      request.headers.get('Authorization') ?? undefined,
    );
    if (!bearer) return undefined;
    const aliasId = this.credentialAliasId(bearer);
    if (aliasId !== undefined && !z.string().uuid().safeParse(aliasId).success)
      throw new ApplicationSessionRefusal('invalid');
    return aliasId;
  }
  private assertAlias(request: Request, expected?: string): void {
    if (this.currentAliasId(request) !== expected)
      throw new ApplicationSessionRefusal('invalid');
  }
  private activeAdoptionId(
    deviceId: string,
    aliasId?: string,
  ): string | undefined {
    if (!aliasId || !this.adoption) return undefined;
    const row = this.db
      .prepare(
        "SELECT id FROM application_session_adoptions WHERE device_id=? AND alias_id=? AND state IN ('issued','active') AND expires_at>?",
      )
      .get(deviceId, aliasId, this.now());
    if (row === undefined) return undefined;
    if (typeof row.id !== 'string')
      throw new ApplicationSessionRefusal('unavailable');
    return row.id;
  }
  private assertAdoptionBinding(
    deviceId: string,
    aliasId: string | undefined,
    expectedAdoptionId: string | undefined,
  ): void {
    if (this.activeAdoptionId(deviceId, aliasId) !== expectedAdoptionId)
      throw new ApplicationSessionRefusal('invalid');
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
      'application_session_adoptions',
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE expires_at<=?`)
        .run(this.now());
  }
  private markAdoptionActive(record: Continuation): void {
    const adoptionId = record.adoptionId;
    const aliasId = record.aliasId;
    if (!adoptionId) return;
    if (!aliasId) throw new ApplicationSessionRefusal('invalid');
    this.transaction(() => {
      if (
        this.db
          .prepare(
            "UPDATE application_session_adoptions SET state='active' WHERE id=? AND device_id=? AND alias_id=? AND state IN ('issued','active') AND expires_at>?",
          )
          .run(adoptionId, record.deviceId, aliasId, this.now()).changes !== 1
      )
        throw new ApplicationSessionRefusal('invalid');
    });
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
