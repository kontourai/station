/**
 * Station-run Kiro sign-in: one attempt per scope, written to the engine
 * host-auth vault when it completes. Builder ID and IAM Identity Center use
 * the device-code flow, polled on Station's side; Google and GitHub use
 * Kiro's portal and a loopback callback (social.ts).
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
import {
  exchangeSocialCode,
  KIRO_SOCIAL_CALLBACK_PORTS,
  KIRO_SOCIAL_CALLBACK_TIMEOUT_MS,
  KIRO_SOCIAL_ENDPOINTS,
  KIRO_SOCIAL_PROVIDER_ATTRIBUTE,
  KiroSignInRefusedError,
  KiroSocialCallbackError,
  type KiroSocialEndpoints,
  type KiroSocialListener,
  kiroSocialProvider,
  openSocialCallbackListener,
  pkcePair,
  portalSignInUrl,
  refreshSocialToken,
  socialRedirectUri,
  socialState,
} from './social.js';

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
  /** Kiro's portal and social service; defaults to {@link KIRO_SOCIAL_ENDPOINTS}. */
  social?: KiroSocialEndpoints;
  /** Defaults to the ports Kiro allowlists; tests pass free ones. */
  socialCallbackPorts?: readonly number[];
  /** Defaults to {@link KIRO_SOCIAL_CALLBACK_TIMEOUT_MS}. */
  socialCallbackTimeoutMs?: number;
}

/** Why a sign-in request was refused before anything was sent. */
export type HostAuthLoginRefusal =
  | 'start-url'
  | 'region'
  | 'identity'
  | 'browser-not-on-host';

/** The fixed text a refusal shows; the request's own values never appear in it. */
export const HOST_AUTH_LOGIN_REFUSAL_TEXT: Record<
  HostAuthLoginRefusal,
  string
> = {
  'start-url':
    "Enter your company's AWS access portal URL, like https://your-company.awsapps.com/start.",
  region: 'Enter an AWS region, like us-east-1.',
  identity:
    'Station signs in to Kiro with AWS Builder ID, IAM Identity Center, Google or GitHub.',
  'browser-not-on-host':
    'Google and GitHub sign-in needs the browser on the computer Station runs on. Use AWS Builder ID or IAM Identity Center.',
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
    if (request.identity === 'social') return this.#startSocial(scope, key);

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
      attempt.record = {
        ...attempt.record,
        phase: 'failed',
        reason: 'The sign-in code expired before it was approved.',
        failure: 'expired',
      };
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

  /**
   * Start a Google or GitHub sign-in: bind the callback listener, then hand
   * back Kiro's portal link for the person to open in a browser on this
   * computer. The rest runs when the browser comes back.
   */
  async #startSocial(
    scope: EngineCredentialScope,
    key: string,
  ): Promise<HostAuthLoginStart> {
    const startedAt = this.deps.now();
    const timeoutMs =
      this.deps.socialCallbackTimeoutMs ?? KIRO_SOCIAL_CALLBACK_TIMEOUT_MS;
    const attempt: Attempt = {
      record: {
        kind: KIRO_CREDENTIAL_KIND,
        phase: 'starting',
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(startedAt + timeoutMs).toISOString(),
      },
      intervalMs: 0,
    };
    this.#attempts.set(key, attempt);
    const { verifier, challenge } = pkcePair();
    const state = socialState();
    let listener: KiroSocialListener;
    try {
      listener = await openSocialCallbackListener({
        ports: this.deps.socialCallbackPorts ?? KIRO_SOCIAL_CALLBACK_PORTS,
        state,
        timeoutMs,
      });
    } catch (error) {
      attempt.record = {
        ...attempt.record,
        phase: 'failed',
        reason: `${
          error instanceof KiroSocialCallbackError
            ? error.message
            : 'Station could not listen for the sign-in on this computer.'
        } Use AWS Builder ID or IAM Identity Center instead.`,
        failure: 'unavailable',
      };
      return attempt.record;
    }
    if (attempt.record.phase === 'cancelled') {
      listener.cancel();
      return attempt.record;
    }
    attempt.cancel = () => listener.cancel();
    attempt.record = {
      ...attempt.record,
      phase: 'awaiting-approval',
      authorizationUrl: portalSignInUrl(
        this.#social.portalUrl,
        listener.port,
        state,
        challenge,
      ),
    };
    void this.#finishSocial(scope, attempt, listener, verifier);
    return attempt.record;
  }

  get #social(): KiroSocialEndpoints {
    return this.deps.social ?? KIRO_SOCIAL_ENDPOINTS;
  }

  async #finishSocial(
    scope: EngineCredentialScope,
    attempt: Attempt,
    listener: KiroSocialListener,
    verifier: string,
  ): Promise<void> {
    const fail = (reason: string, failure?: 'refused' | 'expired') => {
      attempt.record = {
        ...attempt.record,
        phase: 'failed',
        reason,
        ...(failure ? { failure } : {}),
      };
    };
    let callback: Awaited<KiroSocialListener['result']>;
    try {
      callback = await listener.result;
    } catch (error) {
      if (attempt.record.phase !== 'awaiting-approval') return;
      if (error instanceof KiroSocialCallbackError)
        fail(error.message, error.code === 'timeout' ? 'expired' : 'refused');
      else fail('The sign-in could not be completed.');
      return;
    }
    if (attempt.record.phase !== 'awaiting-approval') return;
    attempt.record = { ...attempt.record, phase: 'verifying' };
    const provider = kiroSocialProvider(callback.loginOption);
    if (!provider) {
      fail(
        "Kiro's sign-in page returned a sign-in other than Google or GitHub, which Station does not keep here.",
        'refused',
      );
      return;
    }
    try {
      const tokens = await exchangeSocialCode(
        this.#http,
        this.#social.serviceUrl,
        {
          code: callback.code,
          verifier,
          redirectUri: socialRedirectUri(
            listener.port,
            callback.path,
            callback.loginOption,
          ),
        },
      );
      if (attempt.record.phase !== 'verifying') return;
      const credential: StoredEngineCredential = {
        identity: { kind: 'social', provider },
        accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        attributes: {
          profileArn: tokens.profileArn,
          provider: KIRO_SOCIAL_PROVIDER_ATTRIBUTE[provider],
        },
        signedInAt: new Date(this.deps.now()).toISOString(),
      };
      await this.deps.vault.write(KIRO_CREDENTIAL_KIND, scope, credential);
      const landed = this.deps.vault.read(KIRO_CREDENTIAL_KIND, scope);
      if (landed?.credential.accessToken !== credential.accessToken) {
        fail('The sign-in finished but Station could not keep the credential.');
        return;
      }
      attempt.record = { ...attempt.record, phase: 'completed' };
      this.deps.onSignedIn?.(scope);
    } catch (error) {
      if (attempt.record.phase !== 'verifying') return;
      fail(
        error instanceof KiroOidcError
          ? error.message
          : 'The sign-in finished but Station could not keep the credential.',
        error instanceof KiroSignInRefusedError ? 'refused' : undefined,
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

/**
 * The issuer's refresher for `kiro.oidc-access-token`: Kiro's social service
 * for a Google or GitHub sign-in, else the SSO-OIDC refresh grant.
 */
export function kiroCredentialRefresher(deps: {
  fetch: typeof fetch;
  endpoints: KiroOidcEndpoints;
  now: () => number;
  requestTimeoutMs?: number;
  social?: KiroSocialEndpoints;
}): (credential: StoredEngineCredential) => Promise<StoredEngineCredential> {
  return async (credential) => {
    if (credential.identity.kind === 'social') {
      if (!credential.refreshToken)
        throw new KiroOidcError('The stored sign-in cannot be refreshed.');
      const tokens = await refreshSocialToken(
        deps,
        (deps.social ?? KIRO_SOCIAL_ENDPOINTS).serviceUrl,
        credential.refreshToken,
      );
      return {
        ...credential,
        accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        refreshToken: tokens.refreshToken ?? credential.refreshToken,
        ...(tokens.profileArn
          ? {
              attributes: {
                ...credential.attributes,
                profileArn: tokens.profileArn,
              },
            }
          : {}),
      };
    }
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
