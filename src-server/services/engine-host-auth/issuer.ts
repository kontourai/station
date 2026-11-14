/**
 * The issuer behind a reviewed engine-credential binding: it answers one
 * engine process's request for an access token from the engine host-auth
 * vault, for the one connection and credential profile it was built for.
 *
 * - Concurrent requests for a scope share one in-flight issue.
 * - At most {@link ENGINE_CREDENTIAL_ISSUES_PER_HOUR} issues per scope per
 *   rolling hour that refresh or hand out a token not already handed out;
 *   the next is refused `rate-limited`. Re-handing the unchanged cached token
 *   is not counted.
 * - A token within {@link ENGINE_CREDENTIAL_REFRESH_MARGIN_MS} of expiry is
 *   refreshed first, under the vault's cross-process lock, and the vault is
 *   re-read inside the lock so a peer's refresh is used rather than repeated.
 * - Only the access token, its expiry and non-secret attributes leave; the
 *   refresh token and client secret never do.
 * - Every outcome is audited without values; managed policy can turn
 *   issuing off.
 */
import { createHash } from 'node:crypto';
import type {
  EngineCredentialBinding,
  EngineCredentialIssueResult,
  EngineCredentialKind,
  EngineCredentialRefusal,
  EngineCredentialScope,
  EngineHostAuthPolicy,
} from '@kontourai/station-contracts/engine-credential-provider';
import {
  ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  ENGINE_CREDENTIAL_ISSUES_PER_HOUR,
  ENGINE_CREDENTIAL_REFRESH_MARGIN_MS,
  engineCredentialBucketKey,
} from '@kontourai/station-contracts/engine-credential-provider';
import type { EngineCredentialIssuer } from '../acp/acp-inbound-extension-policy.js';
import type {
  EngineHostAuthVault,
  StoredEngineCredential,
  VaultRead,
} from './vault.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One audited event. Never a token, a secret or a vendor response. */
export interface EngineHostAuthAuditEvent {
  readonly at: string;
  readonly kind: EngineCredentialKind;
  readonly connectionId: string;
  readonly credentialProfileRef: string;
  readonly event:
    | 'issued'
    | 'refused'
    | 'refreshed'
    | 'signed-in'
    | 'signed-out';
  readonly reason?: EngineCredentialRefusal | string;
}

export type EngineHostAuthAuditSink = (event: EngineHostAuthAuditEvent) => void;

/**
 * Refreshes one stored credential. Throws an error that
 * {@link IssuerDeps.isRefreshRejected} recognises when the issuer refused the
 * grant; any other throw is a transient failure.
 */
export type EngineCredentialRefresher = (
  credential: StoredEngineCredential,
) => Promise<StoredEngineCredential>;

/**
 * Shared across every issuer of one service: the in-flight issues and the
 * issue log per bucket. Only an issue that hands the engine a token it has not
 * already been handed (a refresh, or a new sign-in) is logged; re-handing an
 * unchanged cached token is free, so availability probes and restarts that
 * each ask once cannot use up the hourly cap.
 */
export class EngineCredentialIssueLedger {
  readonly inFlight = new Map<string, Promise<EngineCredentialIssueResult>>();
  readonly #issued = new Map<string, number[]>();
  /** A digest of the last token handed out per bucket, never the token. */
  readonly #lastToken = new Map<string, string>();

  /** Whether `accessToken` is the token this bucket last handed out. */
  isLastIssued(bucket: string, accessToken: string): boolean {
    return this.#lastToken.get(bucket) === tokenDigest(accessToken);
  }

  noteIssued(bucket: string, accessToken: string): void {
    this.#lastToken.set(bucket, tokenDigest(accessToken));
  }

  record(bucket: string, at: number): void {
    const times = this.#prune(bucket, at);
    times.push(at);
    this.#issued.set(bucket, times);
  }

  countSince(bucket: string, now: number, windowMs: number): number {
    return this.#prune(bucket, now).filter((at) => at > now - windowMs).length;
  }

  last(bucket: string): number | undefined {
    const times = this.#issued.get(bucket);
    return times?.[times.length - 1];
  }

  forget(predicate: (bucket: string) => boolean): void {
    for (const bucket of [...this.#issued.keys()])
      if (predicate(bucket)) this.#issued.delete(bucket);
    for (const bucket of [...this.#lastToken.keys()])
      if (predicate(bucket)) this.#lastToken.delete(bucket);
  }

  #prune(bucket: string, now: number): number[] {
    const kept = (this.#issued.get(bucket) ?? []).filter(
      (at) => at > now - DAY_MS,
    );
    this.#issued.set(bucket, kept);
    return kept;
  }
}

export interface IssuerDeps {
  readonly vault: EngineHostAuthVault;
  readonly ledger: EngineCredentialIssueLedger;
  /** Refreshers by credential kind; a kind without one is never issued. */
  readonly refreshers: Partial<
    Record<EngineCredentialKind, EngineCredentialRefresher>
  >;
  readonly isRefreshRejected: (error: unknown) => boolean;
  readonly policy: () => EngineHostAuthPolicy;
  readonly audit: EngineHostAuthAuditSink;
  readonly now: () => number;
}

function tokenDigest(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex');
}

function isFresh(credential: StoredEngineCredential, now: number): boolean {
  return (
    Date.parse(credential.expiresAt) - now > ENGINE_CREDENTIAL_REFRESH_MARGIN_MS
  );
}

export class VaultEngineCredentialIssuer implements EngineCredentialIssuer {
  readonly scope: EngineCredentialScope;

  constructor(
    scope: EngineCredentialScope,
    private readonly deps: IssuerDeps,
  ) {
    this.scope = {
      connectionId: scope.connectionId,
      credentialProfileRef:
        scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE,
    };
    // Validates the scope now, so a bad one fails the install, not an issue.
    engineCredentialBucketKey('kiro.oidc-access-token', this.scope);
  }

  issue(
    binding: EngineCredentialBinding,
  ): Promise<EngineCredentialIssueResult> {
    const bucket = engineCredentialBucketKey(binding.kind, this.scope);
    const pending = this.deps.ledger.inFlight.get(bucket);
    if (pending) return pending;
    const run = this.#issue(binding.kind, bucket).finally(() => {
      if (this.deps.ledger.inFlight.get(bucket) === run)
        this.deps.ledger.inFlight.delete(bucket);
    });
    this.deps.ledger.inFlight.set(bucket, run);
    return run;
  }

  #audit(
    kind: EngineCredentialKind,
    event: EngineHostAuthAuditEvent['event'],
    reason?: EngineHostAuthAuditEvent['reason'],
  ): void {
    try {
      this.deps.audit({
        at: new Date(this.deps.now()).toISOString(),
        kind,
        connectionId: this.scope.connectionId,
        credentialProfileRef: this.scope.credentialProfileRef,
        event,
        ...(reason ? { reason } : {}),
      });
    } catch {
      // An audit sink that fails must not turn into a token on the wire or a
      // refusal the engine cannot explain; the issue result stands.
    }
  }

  #refuse(
    kind: EngineCredentialKind,
    reason: EngineCredentialRefusal,
  ): EngineCredentialIssueResult {
    this.#audit(kind, 'refused', reason);
    return { kind: 'refused', reason };
  }

  async #issue(
    kind: EngineCredentialKind,
    bucket: string,
  ): Promise<EngineCredentialIssueResult> {
    if (this.deps.policy() !== 'allowed')
      return this.#refuse(kind, 'policy-off');
    const refresher = this.deps.refreshers[kind];
    if (!refresher) return this.#refuse(kind, 'unavailable');
    const now = this.deps.now();
    let read: VaultRead | undefined;
    try {
      read = this.deps.vault.read(kind, this.scope);
    } catch {
      return this.#refuse(kind, 'unavailable');
    }
    if (!read) return this.#refuse(kind, 'signed-out');
    let credential = read.credential;
    // Re-handing the token this bucket already handed out costs nothing and
    // is not counted. Anything else (a refresh, a new sign-in's token) is
    // capped and logged.
    const cached =
      isFresh(credential, now) &&
      this.deps.ledger.isLastIssued(bucket, credential.accessToken);
    if (!cached) {
      if (
        this.deps.ledger.countSince(bucket, now, HOUR_MS) >=
        ENGINE_CREDENTIAL_ISSUES_PER_HOUR
      )
        return this.#refuse(kind, 'rate-limited');
      if (!isFresh(credential, now)) {
        const refreshed = await this.#refresh(kind, refresher);
        if ('refused' in refreshed)
          return this.#refuse(kind, refreshed.refused);
        credential = refreshed.credential;
      }
      if (!this.deps.ledger.isLastIssued(bucket, credential.accessToken)) {
        this.deps.ledger.record(bucket, this.deps.now());
        this.deps.ledger.noteIssued(bucket, credential.accessToken);
      }
    }
    this.#audit(kind, 'issued');
    return {
      kind: 'issued',
      issue: {
        accessToken: credential.accessToken,
        expiresAt: new Date(Date.parse(credential.expiresAt)).toISOString(),
        ...(credential.attributes
          ? { attributes: { ...credential.attributes } }
          : {}),
      },
    };
  }

  async #refresh(
    kind: EngineCredentialKind,
    refresher: EngineCredentialRefresher,
  ): Promise<
    | { credential: StoredEngineCredential }
    | { refused: EngineCredentialRefusal }
  > {
    try {
      return await this.deps.vault.withRefreshLock(
        kind,
        this.scope,
        async () => {
          // Re-read inside the lock: a peer may have refreshed (use its token)
          // or signed out (do not bring the credential back).
          const current = this.deps.vault.read(kind, this.scope);
          if (!current) return { refused: 'signed-out' as const };
          if (isFresh(current.credential, this.deps.now()))
            return { credential: current.credential };
          if (
            current.credential.refreshRejectedAt ||
            !current.credential.refreshToken
          )
            return { refused: 'refresh-rejected' as const };
          let next: StoredEngineCredential;
          try {
            next = await refresher(current.credential);
          } catch (error) {
            if (!this.deps.isRefreshRejected(error))
              return { refused: 'unavailable' as const };
            await this.deps.vault.compareAndWrite(
              kind,
              this.scope,
              current.revision,
              {
                ...current.credential,
                refreshRejectedAt: new Date(this.deps.now()).toISOString(),
              },
            );
            this.#audit(kind, 'refused', 'refresh-rejected');
            return { refused: 'refresh-rejected' as const };
          }
          const written = await this.deps.vault.compareAndWrite(
            kind,
            this.scope,
            current.revision,
            next,
          );
          if (!written) {
            // Replaced under us (a sign-in or sign-out outside this lock).
            const after = this.deps.vault.read(kind, this.scope);
            if (!after) return { refused: 'signed-out' as const };
            if (!isFresh(after.credential, this.deps.now()))
              return { refused: 'unavailable' as const };
            return { credential: after.credential };
          }
          this.#audit(kind, 'refreshed');
          return { credential: next };
        },
      );
    } catch {
      // The lock could not be taken in time, or the vault failed.
      return { refused: 'unavailable' };
    }
  }
}
