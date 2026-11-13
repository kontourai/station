/**
 * The engine host-auth service: the vault, the issue ledger and audit, the
 * Station-run Kiro sign-in, and the issuers and secret stores built over
 * them. Bootstrap registers one per Station home; nothing else constructs
 * credentials for an engine.
 *
 * Import boundary (pinned by engine-host-auth-import-boundary.test.ts): this
 * directory never imports Station's own principals (the internal API token,
 * ConnectionService, station-control MCP tokens) or the engine API-key store
 * (engine-credentials.ts). Managed policy reaches it as an injected function.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EngineCredentialScope,
  EngineHostAuthPolicy,
  EngineHostAuthStatus,
  HostAuthLoginRequest,
  HostAuthLoginStart,
} from '@kontourai/station-contracts/engine-credential-provider';
import {
  ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  ENGINE_CREDENTIAL_REFRESH_MARGIN_MS,
  engineCredentialBucketKey,
} from '@kontourai/station-contracts/engine-credential-provider';
import type { EngineSecretStorageBinding } from '@kontourai/station-contracts/engine-secret-storage';
import { VaultEngineSecretStore } from './engine-secret-store.js';
import {
  EngineCredentialIssueLedger,
  type EngineHostAuthAuditEvent,
  type EngineHostAuthAuditSink,
  VaultEngineCredentialIssuer,
} from './issuer.js';
import {
  KIRO_CREDENTIAL_KIND,
  KiroSignIn,
  kiroCredentialRefresher,
} from './kiro-oidc/kiro-sign-in.js';
import {
  KIRO_OIDC_ENDPOINTS,
  type KiroOidcEndpoints,
  KiroRefreshRejectedError,
} from './kiro-oidc/oidc.js';
import { EngineHostAuthVault } from './vault.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EngineHostAuthServiceOptions {
  homeDir: string;
  policy: () => EngineHostAuthPolicy;
  fetch?: typeof fetch;
  endpoints?: KiroOidcEndpoints;
  /** Per-request OIDC timeout; defaults to `OIDC_REQUEST_TIMEOUT_MS`. */
  oidcRequestTimeoutMs?: number;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => () => void;
  /** Extra audit sink (the structured log). The JSONL file is always written. */
  audit?: EngineHostAuthAuditSink;
  /**
   * How a connection's process is launched (`engineLaunchFactsFor` from
   * acp-engine-descriptors.ts). Injected, not imported: the descriptor
   * registry's import graph reaches Station's own principals. Absent, no
   * launch qualifies for a responder.
   */
  launchFacts?: (connection: { command: string; args?: readonly string[] }) => {
    builtinDescriptor: boolean;
    argv: readonly string[];
  };
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function normalizeEngineCredentialScope(
  scope: EngineCredentialScope,
): EngineCredentialScope {
  return {
    connectionId: scope.connectionId,
    credentialProfileRef:
      scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  };
}

export class EngineHostAuthService {
  readonly vault: EngineHostAuthVault;
  readonly ledger = new EngineCredentialIssueLedger();
  readonly kiro: KiroSignIn;
  readonly #options: EngineHostAuthServiceOptions;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #endpoints: KiroOidcEndpoints;

  constructor(options: EngineHostAuthServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#endpoints = options.endpoints ?? KIRO_OIDC_ENDPOINTS;
    this.vault = new EngineHostAuthVault(options.homeDir);
    this.kiro = new KiroSignIn({
      fetch: this.#fetch,
      endpoints: this.#endpoints,
      now: this.#now,
      ...(options.oidcRequestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.oidcRequestTimeoutMs }
        : {}),
      schedule: options.schedule ?? defaultSchedule,
      vault: this.vault,
      onSignedIn: (scope) =>
        this.#audit({
          at: new Date(this.#now()).toISOString(),
          kind: KIRO_CREDENTIAL_KIND,
          connectionId: scope.connectionId,
          credentialProfileRef:
            scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE,
          event: 'signed-in',
        }),
    });
  }

  launchFactsFor(connection: { command: string; args?: readonly string[] }): {
    builtinDescriptor: boolean;
    argv: readonly string[];
  } {
    return (
      this.#options.launchFacts?.(connection) ?? {
        builtinDescriptor: false,
        argv: [],
      }
    );
  }

  policy(): EngineHostAuthPolicy {
    try {
      return this.#options.policy() === 'off' ? 'off' : 'allowed';
    } catch {
      return 'off';
    }
  }

  /** Where audit lines go: value-free JSONL, 0600. */
  get auditFile(): string {
    return join(
      this.#options.homeDir,
      'security',
      'engine-host-auth-audit.jsonl',
    );
  }

  #audit(event: EngineHostAuthAuditEvent): void {
    try {
      mkdirSync(join(this.#options.homeDir, 'security'), {
        recursive: true,
        mode: 0o700,
      });
      appendFileSync(this.auditFile, `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      });
      if (process.platform !== 'win32') chmodSync(this.auditFile, 0o600);
    } catch {}
    this.#options.audit?.(event);
  }

  issuerFor(scope: EngineCredentialScope): VaultEngineCredentialIssuer {
    return new VaultEngineCredentialIssuer(
      normalizeEngineCredentialScope(scope),
      {
        vault: this.vault,
        ledger: this.ledger,
        refreshers: {
          [KIRO_CREDENTIAL_KIND]: kiroCredentialRefresher({
            fetch: this.#fetch,
            endpoints: this.#endpoints,
            now: this.#now,
            ...(this.#options.oidcRequestTimeoutMs !== undefined
              ? { requestTimeoutMs: this.#options.oidcRequestTimeoutMs }
              : {}),
          }),
        },
        isRefreshRejected: (error) => error instanceof KiroRefreshRejectedError,
        policy: () => this.policy(),
        audit: (event) => this.#audit(event),
        now: this.#now,
      },
    );
  }

  secretStoreFor(
    scope: EngineCredentialScope,
    binding: EngineSecretStorageBinding,
  ): VaultEngineSecretStore {
    return new VaultEngineSecretStore(
      normalizeEngineCredentialScope(scope),
      binding,
      this.vault,
    );
  }

  /** What Station knows about its own Kiro credential for a scope. Never a value. */
  status(scope: EngineCredentialScope): EngineHostAuthStatus {
    const normalized = normalizeEngineCredentialScope(scope);
    let read: ReturnType<EngineHostAuthVault['read']>;
    try {
      read = this.vault.read(KIRO_CREDENTIAL_KIND, normalized);
    } catch {
      return { owner: 'station', state: 'unknown' };
    }
    const bucket = engineCredentialBucketKey(KIRO_CREDENTIAL_KIND, normalized);
    const now = this.#now();
    const last = this.ledger.last(bucket);
    const usage = {
      ...(last !== undefined
        ? { lastIssuedAt: new Date(last).toISOString() }
        : {}),
      issueCount24h: this.ledger.countSince(bucket, now, DAY_MS),
    };
    if (!read) return { owner: 'station', state: 'signed-out', ...usage };
    const { credential } = read;
    const fresh =
      Date.parse(credential.expiresAt) - now >
      ENGINE_CREDENTIAL_REFRESH_MARGIN_MS;
    const state =
      !fresh && (credential.refreshRejectedAt || !credential.refreshToken)
        ? 'refresh-rejected'
        : 'signed-in';
    return {
      owner: 'station',
      state,
      identity: credential.identity,
      accessExpiresAt: credential.expiresAt,
      ...usage,
    };
  }

  startLogin(
    scope: EngineCredentialScope,
    request: HostAuthLoginRequest,
  ): Promise<HostAuthLoginStart> {
    return this.kiro.start(normalizeEngineCredentialScope(scope), request);
  }

  login(scope: EngineCredentialScope): HostAuthLoginStart | undefined {
    return this.kiro.attempt(normalizeEngineCredentialScope(scope));
  }

  cancelLogin(scope: EngineCredentialScope): HostAuthLoginStart | undefined {
    return this.kiro.cancel(normalizeEngineCredentialScope(scope));
  }

  async signOut(scope: EngineCredentialScope): Promise<void> {
    const normalized = normalizeEngineCredentialScope(scope);
    this.kiro.cancel(normalized);
    await this.vault.withRefreshLock(KIRO_CREDENTIAL_KIND, normalized, () =>
      this.vault.remove(KIRO_CREDENTIAL_KIND, normalized),
    );
    this.#audit({
      at: new Date(this.#now()).toISOString(),
      kind: KIRO_CREDENTIAL_KIND,
      connectionId: normalized.connectionId,
      credentialProfileRef: normalized.credentialProfileRef,
      event: 'signed-out',
    });
  }

  /** The connection was removed: its credentials, secrets and sign-ins go with it. */
  async removeConnection(connectionId: string): Promise<void> {
    this.kiro.forget(connectionId);
    this.ledger.forget((bucket) => bucket.split(':')[1] === connectionId);
    await this.vault.removeConnection(connectionId);
  }
}

let registered: EngineHostAuthService | null = null;

/** Bootstrap installs the instance's service; tests install their own. */
export function registerEngineHostAuth(service: EngineHostAuthService | null) {
  registered = service;
}

export function engineHostAuth(): EngineHostAuthService | null {
  return registered;
}
