/**
 * Station-run Kiro sign-in: one device-code attempt per scope, polled on
 * Station's side, written to the engine host-auth vault when it completes.
 * The phases are device-code-login.ts's (`HostAuthLoginPhase`): `verifying`
 * is the step where Station resolves the profile and reads the credential
 * back from the vault, so `completed` means a credential actually landed.
 *
 * Also the refresher the issuer uses for `kiro.oidc-access-token`.
 */
import type {
  EngineCredentialScope,
  HostAuthLoginRequest,
  HostAuthLoginStart,
} from '@kontourai/station-contracts/engine-credential-provider';
import type { EngineHostAuthVault, StoredEngineCredential } from '../vault.js';
import {
  BUILDER_ID_PROFILE_ARN,
  BUILDER_ID_REGION,
  BUILDER_ID_START_URL,
  type DeviceAuthorization,
  firstAvailableProfileArn,
  isAwsRegion,
  type KiroOidcEndpoints,
  KiroOidcError,
  pollDeviceToken,
  type RegisteredClient,
  refreshOidcToken,
  registerClient,
  reusableClient,
  startDeviceAuthorization,
} from './oidc.js';

export const KIRO_CREDENTIAL_KIND = 'kiro.oidc-access-token' as const;
const SLOW_DOWN_EXTRA_MS = 5_000;
const URL_MAX = 2048;

export interface KiroSignInDeps {
  fetch: typeof fetch;
  endpoints: KiroOidcEndpoints;
  now: () => number;
  requestTimeoutMs?: number;
  /** Returns a cancel function. Injected so tests drive polling without a clock. */
  schedule: (run: () => void, delayMs: number) => () => void;
  vault: EngineHostAuthVault;
  onSignedIn?: (scope: EngineCredentialScope) => void;
}

/** Why a sign-in request was refused before anything was sent. */
export type HostAuthLoginRefusal = 'start-url' | 'region' | 'identity';

/** The fixed text a refusal shows; the request's own values never appear in it. */
export const HOST_AUTH_LOGIN_REFUSAL_TEXT: Record<
  HostAuthLoginRefusal,
  string
> = {
  'start-url':
    "Enter your company's AWS access portal URL, like https://your-company.awsapps.com/start.",
  region: 'Enter an AWS region, like us-east-1.',
  identity:
    'Station signs in to Kiro with AWS Builder ID or IAM Identity Center.',
};

export class HostAuthLoginRefusedError extends Error {
  constructor(readonly code: HostAuthLoginRefusal) {
    super(HOST_AUTH_LOGIN_REFUSAL_TEXT[code]);
    this.name = 'HostAuthLoginRefusedError';
  }
}

/** https only, no userinfo, bounded: the only links Station shows a person. */
function safeLink(value: string): string | undefined {
  if (value.length > URL_MAX) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** An Identity Center start URL: https, no userinfo, query or fragment. */
function canonicalStartUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

interface Attempt {
  record: HostAuthLoginStart;
  cancel?: () => void;
  client?: RegisteredClient;
  auth?: DeviceAuthorization;
  intervalMs: number;
}

function bucketOf(scope: EngineCredentialScope): string {
  return `${scope.connectionId}:${scope.credentialProfileRef || 'default'}`;
}

export class KiroSignIn {
  readonly #attempts = new Map<string, Attempt>();

  constructor(private readonly deps: KiroSignInDeps) {}

  get #http() {
    return {
      fetch: this.deps.fetch,
      endpoints: this.deps.endpoints,
      now: this.deps.now,
      ...(this.deps.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.deps.requestTimeoutMs }
        : {}),
    };
  }

  attempt(scope: EngineCredentialScope): HostAuthLoginStart | undefined {
    return this.#attempts.get(bucketOf(scope))?.record;
  }

  cancel(scope: EngineCredentialScope): HostAuthLoginStart | undefined {
    const attempt = this.#attempts.get(bucketOf(scope));
    if (!attempt) return undefined;
    if (!isFinished(attempt.record)) {
      attempt.cancel?.();
      attempt.record = { ...attempt.record, phase: 'cancelled' };
    }
    return attempt.record;
  }

  forget(connectionId: string): void {
    for (const [key, attempt] of this.#attempts) {
      if (key.startsWith(`${connectionId}:`)) {
        attempt.cancel?.();
        this.#attempts.delete(key);
      }
    }
  }

  /**
   * Start a device-code sign-in. A running attempt for the scope is returned
   * as it is rather than replaced.
   */
  async start(
    scope: EngineCredentialScope,
    request: HostAuthLoginRequest,
  ): Promise<HostAuthLoginStart> {
    const key = bucketOf(scope);
    const running = this.#attempts.get(key);
    if (running && !isFinished(running.record)) return running.record;

    let region: string;
    let startUrl: string;
    if (request.identity === 'builder-id') {
      region = request.region ?? BUILDER_ID_REGION;
      startUrl = BUILDER_ID_START_URL;
    } else if (request.identity === 'identity-center') {
      const canonical = canonicalStartUrl(request.startUrl);
      if (!canonical) throw new HostAuthLoginRefusedError('start-url');
      region = request.region;
      startUrl = canonical;
    } else {
      throw new HostAuthLoginRefusedError('identity');
    }
    if (!isAwsRegion(region)) throw new HostAuthLoginRefusedError('region');

    const startedAt = this.deps.now();
    const attempt: Attempt = {
      record: {
        kind: KIRO_CREDENTIAL_KIND,
        phase: 'starting',
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(startedAt + 10 * 60 * 1000).toISOString(),
      },
      intervalMs: 5_000,
    };
    this.#attempts.set(key, attempt);
    const fail = (reason: string) => {
      attempt.cancel?.();
      attempt.record = { ...attempt.record, phase: 'failed', reason };
      return attempt.record;
    };
    try {
      const stored = this.deps.vault.read(
        KIRO_CREDENTIAL_KIND,
        scope,
      )?.credential;
      let client = reusableClient(
        stored && {
          region: stored.identity.region,
          clientId: stored.clientId,
          clientSecret: stored.clientSecret,
          clientSecretExpiresAt: stored.clientSecretExpiresAt,
        },
        region,
        startedAt,
      );
      let auth: DeviceAuthorization | undefined;
      if (client) {
        try {
          auth = await startDeviceAuthorization(
            this.#http,
            client,
            region,
            startUrl,
          );
        } catch {
          // A stored registration AWS no longer takes must never stop a new
          // sign-in: register a fresh one below.
          client = undefined;
        }
      }
      if (!client || !auth) {
        client = await registerClient(this.#http, region);
        auth = await startDeviceAuthorization(
          this.#http,
          client,
          region,
          startUrl,
        );
      }
      if (attempt.record.phase === 'cancelled') return attempt.record;
      const link =
        safeLink(auth.verificationUriComplete) ??
        safeLink(auth.verificationUri);
      if (!link)
        return fail('AWS returned a sign-in link Station will not show.');
      attempt.client = client;
      attempt.auth = auth;
      attempt.intervalMs = auth.intervalMs;
      attempt.record = {
        ...attempt.record,
        phase: 'awaiting-approval',
        verificationUri: link,
        userCode: auth.userCode,
        expiresAt: new Date(auth.expiresAt).toISOString(),
      };
      this.#schedulePoll(scope, attempt, {
        identity: request.identity,
        region,
        startUrl,
      });
      return attempt.record;
    } catch (error) {
      return fail(
        error instanceof KiroOidcError
          ? error.message
          : 'The sign-in could not be started.',
      );
    }
  }

  #schedulePoll(
    scope: EngineCredentialScope,
    attempt: Attempt,
    target: {
      identity: 'builder-id' | 'identity-center';
      region: string;
      startUrl: string;
    },
  ): void {
    attempt.cancel = this.deps.schedule(() => {
      void this.#poll(scope, attempt, target);
    }, attempt.intervalMs);
  }

  async #poll(
    scope: EngineCredentialScope,
    attempt: Attempt,
    target: {
      identity: 'builder-id' | 'identity-center';
      region: string;
      startUrl: string;
    },
  ): Promise<void> {
    if (attempt.record.phase !== 'awaiting-approval') return;
    const { client, auth } = attempt;
    if (!client || !auth) return;
    const fail = (reason: string) => {
      attempt.record = { ...attempt.record, phase: 'failed', reason };
    };
    if (this.deps.now() >= auth.expiresAt) {
      fail('The sign-in code expired before it was approved.');
      return;
    }
    let result: Awaited<ReturnType<typeof pollDeviceToken>>;
    try {
      result = await pollDeviceToken(this.#http, client, auth, target.region);
    } catch (error) {
      if (attempt.record.phase === 'awaiting-approval')
        fail(
          error instanceof KiroOidcError
            ? error.message
            : 'The sign-in could not be completed.',
        );
      return;
    }
    if (attempt.record.phase !== 'awaiting-approval') return;
    if (result.kind !== 'authorized') {
      if (result.kind === 'slow-down') attempt.intervalMs += SLOW_DOWN_EXTRA_MS;
      this.#schedulePoll(scope, attempt, target);
      return;
    }
    attempt.record = { ...attempt.record, phase: 'verifying' };
    try {
      const profileArn =
        target.identity === 'builder-id'
          ? BUILDER_ID_PROFILE_ARN
          : await firstAvailableProfileArn(
              this.#http,
              result.tokens.accessToken,
              target.region,
            );
      if (attempt.record.phase !== 'verifying') return;
      const credential: StoredEngineCredential = {
        identity:
          target.identity === 'builder-id'
            ? { kind: 'builder-id', region: target.region }
            : {
                kind: 'identity-center',
                startUrl: target.startUrl,
                region: target.region,
              },
        accessToken: result.tokens.accessToken,
        expiresAt: new Date(result.tokens.expiresAt).toISOString(),
        ...(result.tokens.refreshToken
          ? { refreshToken: result.tokens.refreshToken }
          : {}),
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        ...(client.clientSecretExpiresAt !== undefined
          ? { clientSecretExpiresAt: client.clientSecretExpiresAt }
          : {}),
        attributes: {
          profileArn,
          provider:
            target.identity === 'builder-id' ? 'BuilderId' : 'Enterprise',
        },
        signedInAt: new Date(this.deps.now()).toISOString(),
      };
      await this.deps.vault.write(KIRO_CREDENTIAL_KIND, scope, credential);
      // Completed only once the vault gives the credential back.
      const landed = this.deps.vault.read(KIRO_CREDENTIAL_KIND, scope);
      if (landed?.credential.accessToken !== credential.accessToken) {
        fail('The sign-in finished but Station could not keep the credential.');
        return;
      }
      attempt.record = { ...attempt.record, phase: 'completed' };
      this.deps.onSignedIn?.(scope);
    } catch (error) {
      fail(
        error instanceof KiroOidcError
          ? error.message
          : 'The sign-in finished but Station could not keep the credential.',
      );
    }
  }
}

function isFinished(record: HostAuthLoginStart): boolean {
  return (
    record.phase === 'completed' ||
    record.phase === 'failed' ||
    record.phase === 'cancelled'
  );
}

/** The issuer's refresher for `kiro.oidc-access-token` (SSO-OIDC refresh grant). */
export function kiroCredentialRefresher(deps: {
  fetch: typeof fetch;
  endpoints: KiroOidcEndpoints;
  now: () => number;
  requestTimeoutMs?: number;
}): (credential: StoredEngineCredential) => Promise<StoredEngineCredential> {
  return async (credential) => {
    const region = credential.identity.region ?? BUILDER_ID_REGION;
    if (
      !credential.refreshToken ||
      !credential.clientId ||
      !credential.clientSecret
    )
      throw new KiroOidcError('The stored sign-in cannot be refreshed.');
    const tokens = await refreshOidcToken(deps, {
      region,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      refreshToken: credential.refreshToken,
    });
    return {
      ...credential,
      accessToken: tokens.accessToken,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
    };
  };
}
