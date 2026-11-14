/**
 * Engine credentials Station issues to an engine process it launched, through
 * a reviewed binding (docs/decisions/engine-credential-provider.md).
 *
 * An engine can be launched so that it delegates its own sign-in to the host:
 * it asks the client for an access token over its protocol instead of reading
 * a credential it keeps itself. Station answers that request only through one
 * of the reviewed bindings below. A binding names one vendor wire method, the
 * credential kind it carries, and the launch arguments Station itself adds to
 * make the engine delegate. Nothing else may answer a credential-shaped
 * method: the generic inbound-extension registry keeps refusing them.
 *
 * These are shapes and pure helpers only. The vault, the issuer and the
 * responder belong to the server.
 */

/** A credential kind Station can issue. Each names a vendor and a token family. */
export type EngineCredentialKind =
  | 'kiro.oidc-access-token'
  | 'openai.chatgpt-auth-tokens';

export const ENGINE_CREDENTIAL_KINDS: readonly EngineCredentialKind[] =
  Object.freeze(['kiro.oidc-access-token', 'openai.chatgpt-auth-tokens']);

/** The id of a reviewed credential binding. */
export type EngineCredentialBindingId =
  | 'kiro.get-access-token'
  | 'codex.chatgpt-auth-tokens-refresh';

/**
 * Where the engine asks. `scope: 'connection'`: the request names no session
 * and is answered for the process's connection.
 */
export type EngineCredentialWire =
  | {
      readonly protocol: 'acp';
      readonly method: '_kiro/auth/getAccessToken';
      readonly scope: 'connection';
    }
  | {
      readonly protocol: 'codex-app-server';
      readonly method: 'account/chatgptAuthTokens/refresh';
      /** A login the client pushes before the engine asks. */
      readonly push?: 'account/login/start';
    };

export interface EngineCredentialBinding {
  readonly id: EngineCredentialBindingId;
  readonly kind: EngineCredentialKind;
  readonly wire: EngineCredentialWire;
  /**
   * The launch arguments Station adds to make the engine delegate its
   * credential to the host. A responder is installed only on a process
   * launched from a built-in descriptor whose argv contains this sequence.
   */
  readonly delegationArgv: readonly string[];
  /** Where the wire shape was observed or published. */
  readonly evidence: string;
}

/**
 * Whose credential an issue draws on: one connection and one of its
 * credential profiles (`default` when the connection names none).
 */
export interface EngineCredentialScope {
  readonly connectionId: string;
  readonly credentialProfileRef: string;
}

export const ENGINE_CREDENTIAL_DEFAULT_PROFILE = 'default' as const;

/**
 * What an issuer hands to a responder: an access token and its expiry, never
 * a refresh token. `attributes` carries the non-secret values the vendor's
 * wire answer puts beside the token (Kiro: `profileArn`, `provider`,
 * `authMethod`).
 */
export interface EngineCredentialIssue {
  readonly accessToken: string;
  /** ISO 8601. */
  readonly expiresAt: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Why an issue was refused. Each is safe to show and to send back to the
 * engine: none carries a token or a vault path.
 */
export type EngineCredentialRefusal =
  | 'signed-out'
  | 'refresh-rejected'
  | 'rate-limited'
  | 'policy-off'
  | 'scope-mismatch'
  | 'unavailable';

export type EngineCredentialIssueResult =
  | { readonly kind: 'issued'; readonly issue: EngineCredentialIssue }
  | { readonly kind: 'refused'; readonly reason: EngineCredentialRefusal };

/** Issues per scope per rolling hour; the next one is refused `rate-limited`. */
export const ENGINE_CREDENTIAL_ISSUES_PER_HOUR = 30;

/** A token closer than this to expiry is refreshed before it is issued. */
export const ENGINE_CREDENTIAL_REFRESH_MARGIN_MS = 3 * 60 * 1000;

/** The managed-policy control over host-issued engine credentials. */
export type EngineHostAuthPolicy = 'allowed' | 'off';

/**
 * The vault bucket a kind and scope read and write:
 * `<kind>:<connectionId>:<profile>`. Refuses an id or profile containing the
 * separator rather than letting two scopes share a bucket.
 */
export function engineCredentialBucketKey(
  kind: EngineCredentialKind,
  scope: EngineCredentialScope,
): string {
  const profile =
    scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE;
  if (!scope.connectionId || scope.connectionId.includes(':'))
    throw new Error('connectionId must be non-empty and contain no ":"');
  if (profile.includes(':'))
    throw new Error('credentialProfileRef must contain no ":"');
  return `${kind}:${scope.connectionId}:${profile}`;
}

/**
 * Whether `argv` contains `delegationArgv` as a contiguous run. Exact string
 * equality per argument: `--auth=acp-callback` and `--auth acp-callback` are
 * different launches.
 */
export function argvDelegatesTo(
  argv: readonly string[],
  delegationArgv: readonly string[],
): boolean {
  if (delegationArgv.length === 0) return false;
  for (let start = 0; start + delegationArgv.length <= argv.length; start++) {
    if (delegationArgv.every((arg, offset) => argv[start + offset] === arg))
      return true;
  }
  return false;
}

// --- Host sign-in status ---------------------------------------------------

/** Who holds the credential an engine uses. */
export type EngineHostAuthOwner = 'station' | 'engine';

export type EngineHostAuthState =
  | 'signed-in'
  | 'signed-out'
  | 'refresh-rejected'
  | 'unknown';

export interface EngineHostAuthIdentity {
  readonly kind: 'builder-id' | 'identity-center' | 'external-idp' | 'social';
  /**
   * The social provider (`google`, `github`) the person chose on the
   * vendor's sign-in page, or an external identity provider's name.
   */
  readonly provider?: string;
  /** An Identity Center start URL. */
  readonly startUrl?: string;
  readonly region?: string;
}

export interface EngineHostAuthStatus {
  readonly owner: EngineHostAuthOwner;
  readonly state: EngineHostAuthState;
  readonly identity?: EngineHostAuthIdentity;
  /** ISO 8601: when the access token held now expires. */
  readonly accessExpiresAt?: string;
  /** ISO 8601: the last issue to an engine. */
  readonly lastIssuedAt?: string;
  readonly issueCount24h?: number;
}

/**
 * The phases of a Station-run sign-in. The same vocabulary as the
 * device-code engine login (`src-server/services/connections/device-code-login.ts`):
 * `verifying` means the flow ended and Station is checking that a credential
 * actually landed.
 */
export type HostAuthLoginPhase =
  | 'starting'
  | 'awaiting-approval'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** What a person asks to sign in with. */
export type HostAuthLoginRequest =
  | { readonly identity: 'builder-id'; readonly region?: string }
  | {
      readonly identity: 'identity-center';
      readonly startUrl: string;
      readonly region: string;
    }
  /**
   * Google or GitHub, chosen on the vendor's own sign-in page. Needs the
   * browser on the Station's computer: the page returns to a loopback port.
   */
  | { readonly identity: 'social' }
  | { readonly identity: 'external-idp'; readonly issuerUrl: string };

/**
 * Why a sign-in failed, where a client acts on it:
 * - `refused`: the vendor or its sign-in page turned it down, or the answer
 *   came back from another attempt or to the wrong address;
 * - `expired`: nothing came back before the attempt's deadline;
 * - `unavailable`: this computer could not take the sign-in's answer (every
 *   port the vendor allows is in use).
 * Absent on a failure with no such class.
 */
export type HostAuthLoginFailure = 'refused' | 'expired' | 'unavailable';

/** A running or finished Station-run sign-in. */
export interface HostAuthLoginStart {
  readonly kind: EngineCredentialKind;
  readonly phase: HostAuthLoginPhase;
  /** ISO 8601. */
  readonly startedAt: string;
  /** ISO 8601: when Station abandons a login that has not finished. */
  readonly expiresAt: string;
  /** Device flow, from `awaiting-approval` on. */
  readonly verificationUri?: string;
  readonly userCode?: string;
  /** Browser (PKCE) flow, from `awaiting-approval` on. */
  readonly authorizationUrl?: string;
  /** Present on `failed` only. */
  readonly reason?: string;
  /** Present on some `failed` records; see {@link HostAuthLoginFailure}. */
  readonly failure?: HostAuthLoginFailure;
}
