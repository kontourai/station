/** Public operator-installed authentication adapter contract; never a Project plugin API. */
export const DEPLOYMENT_AUTHENTICATION_VERSION =
  'station.authentication/v1' as const;
export const DEPLOYMENT_AUTHENTICATION_BASE_PATH = '/api/account-auth' as const;

export interface DeploymentAuthenticationConfiguration {
  /** Absolute module path selected by the operator at process startup. */
  modulePath: string;
  publicOrigin: string;
}

/** Session verification cannot consume or mutate the destination request body. */
export interface DeploymentAuthenticationRequest {
  url: string;
  method: string;
  headers: Headers;
  signal: AbortSignal;
}

export type DeploymentAuthenticationOperation =
  | 'begin-login'
  | 'callback'
  | 'register'
  | 'verify-contact'
  | 'request-recovery'
  | 'complete-recovery'
  | 'change-password'
  | 'refresh-session'
  | 'logout'
  | 'revoke-session';

export interface DeploymentAuthenticationEndpoint {
  /** A path relative to the Station-assigned authentication base path, beginning with '/'. */
  path: string;
  methods: readonly ('GET' | 'POST')[];
  operation: DeploymentAuthenticationOperation;
}

/** Provider-verified contact evidence. Contact values never define a principal or link accounts. */
export interface VerifiedAuthenticationContact {
  kind: 'email';
  value: string;
  verifiedAt: string;
}

export interface VerifiedAuthenticationSession {
  /** Opaque stable subject within the configured issuer, never an email-derived identity. */
  subject: string;
  displayName: string;
  /** Non-secret session record identity, not a credential accepted on the wire. */
  sessionId: string;
  authenticatedAt: string;
  expiresAt: string;
  contacts: readonly VerifiedAuthenticationContact[];
}

export type DeploymentAuthenticationResult =
  | { kind: 'absent' }
  | {
      kind: 'invalid';
      reason:
        | 'invalid-credential'
        | 'expired'
        | 'revoked'
        | 'conflicting-identity';
    }
  | { kind: 'unavailable' }
  | { kind: 'authenticated'; session: VerifiedAuthenticationSession };

/**
 * Trusted deployment code verifies credentials and manages its account-session lifecycle.
 * Station separately owns device, Project, resource, tenant and execution authorization.
 * A successful result carries no permission, operator role or compute grant.
 */
export interface DeploymentAuthenticationDescriptor {
  version: typeof DEPLOYMENT_AUTHENTICATION_VERSION;
  /** Stable authentication authority. Changing the public URL must not silently change this identity. */
  issuer: string;
  displayName: string;
  endpoints: readonly DeploymentAuthenticationEndpoint[];
  /** Exact account-cookie names; unrelated device cookies never trigger account verification. */
  sessionCookies: readonly string[];
}

export interface DeploymentAuthenticationProvider
  extends DeploymentAuthenticationDescriptor {
  /**
   * Read current account/session state on each new request; do not accept stale
   * revoked cookie caches. Cookie renewal belongs to refresh-session handling,
   * which can deliver its response headers to the device.
   */
  authenticate(
    request: DeploymentAuthenticationRequest,
  ): Promise<DeploymentAuthenticationResult>;
  /** Only declared endpoint/method pairs reach this handler. The adapter owns CSRF and callback proof. */
  handle(request: Request): Promise<Response>;
  close?(): Promise<void>;
}

/** Private host inputs supplied at process composition, never from request or Project metadata. */
export interface DeploymentAuthenticationHost {
  stationId: string;
  publicOrigin: string;
  basePath: string;
  /** The adapter's private persistent data directory within this Station home. */
  stateDirectory: string;
}

/** The named export of an explicitly configured operator-owned module. */
export interface DeploymentAuthenticationModule {
  createStationAuthenticationProvider(
    host: Readonly<DeploymentAuthenticationHost>,
  ): Promise<DeploymentAuthenticationProvider>;
}
