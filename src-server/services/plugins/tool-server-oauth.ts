import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { principalIdMatchesKind } from '@kontourai/station-contracts/principal';
import type { CredentialOwner } from '@kontourai/station-contracts/secret-binding';
import {
  isToolClientMetadataDocumentUrl,
  type ToolDef,
  toolServerOAuthResourceIdentity,
} from '@kontourai/station-contracts/tool';
import type {
  AuthProvider,
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import {
  refreshAuthorization,
  registerClient,
} from '@modelcontextprotocol/client';

import {
  claimIntegrationOAuthIssuerPin,
  readIntegrationOAuthIssuerPin,
  withIntegrationOAuthPinLock,
} from '../../domain/config-loader-storage.js';
import {
  principalToolServerCredentialBucket,
  TOOL_SERVER_OAUTH_CREDENTIAL_KEYS,
  ToolServerCredentialStore,
} from './tool-server-credential-store.js';

type ToolServerFailureLogger = {
  debug?(message: string, context?: Record<string, unknown>): void;
};

export type ToolServerOperation =
  | 'authorize'
  | 'oauth-exchange'
  | 'probe'
  | 'connect'
  | 'resource-read'
  | 'tool-call'
  | 'prompt-read';

const TOOL_SERVER_OPERATION_MESSAGES: Record<ToolServerOperation, string> = {
  authorize: 'Tool server authorization could not be started',
  'oauth-exchange': 'OAuth authorization failed',
  probe: 'Tool server probe failed',
  connect: 'Tool server connection failed',
  'resource-read': 'MCP UI resource read failed',
  'tool-call': 'MCP tool call failed',
  'prompt-read': 'MCP prompt read failed',
};

export class ToolServerOperationError extends Error {
  override name = 'ToolServerOperationError';

  constructor(readonly operation: ToolServerOperation) {
    super(TOOL_SERVER_OPERATION_MESSAGES[operation]);
  }
}

/** Marker for Station-authored validation/policy errors that are already safe. */
export class StationOwnedToolServerError extends Error {}

const TOOL_SERVER_FAILURE_RESULT = Object.freeze({
  isError: true,
  content: [{ type: 'text', text: 'MCP tool call failed' }],
});

function isToolServerFailureResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.isError === true || result.status === 'error';
}

export function projectToolServerResult(value: unknown): unknown {
  return isToolServerFailureResult(value) ? TOOL_SERVER_FAILURE_RESULT : value;
}

export function requireToolServerResult(
  value: unknown,
  operation: ToolServerOperation,
  serverId: string,
  logger?: ToolServerFailureLogger,
): unknown {
  if (!isToolServerFailureResult(value)) return value;
  throw captureToolServerOperationFailure(value, operation, serverId, logger);
}

/**
 * The single remote-error boundary for tool-server operations. Every outward
 * path receives bounded, Station-owned vocabulary.
 *
 * Remote text is NOT written anywhere, including debug logs. An earlier
 * revision admitted the raw error to the debug logger on the theory that its
 * deep redaction made that safe; it does not. The redaction seam matches a
 * finite set of secret-shaped patterns, so an opaque token an authorization
 * server chooses to echo back — or a value it splits across the string —
 * passes through unchanged, and `/api/diagnostics/logs` serves those records
 * to any authenticated diagnostics reader. This is the same reasoning that
 * removed the exact-match sanitizer from the persistence path; it applies
 * identically to logs. Only non-reversible shape metadata is recorded, which
 * distinguishes "the server returned something long and unparseable" from
 * "the server returned nothing" without carrying the content.
 */
export function captureToolServerOperationFailure(
  error: unknown,
  operation: ToolServerOperation,
  serverId: string,
  logger?: ToolServerFailureLogger,
): Error {
  if (
    error instanceof ToolServerOperationError ||
    error instanceof StationOwnedToolServerError
  ) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error ?? '');
  logger?.debug?.('Tool server operation failed', {
    serverId,
    operation,
    // Shape only — never the remote text itself.
    detailLength: detail.length,
    detailDigest: createHash('sha256')
      .update(detail)
      .digest('hex')
      .slice(0, 16),
  });
  return new ToolServerOperationError(operation);
}

// One implementation, in the contract module that owns ToolDef.
export { toolServerOAuthResourceIdentity };

const KEYS = {
  tokens: 'oauth.tokens',
  client: 'oauth.client-information',
  verifier: 'oauth.pkce-verifier',
  state: 'oauth.state',
  discovery: 'oauth.discovery',
  scopeChoice: 'oauth.scope-choice',
} as const;

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Stored beside a registration: the scopes Station asked it to cover. */
const REQUESTED_SCOPE_FIELD = 'station_requested_scope';

type BoundRecord<T> = {
  schemaVersion: 1;
  resource: string;
  issuer?: string;
  expiresAt?: number;
  accessTokenExpiresAt?: number;
  needsSignIn?: boolean;
  /** Tokens only: the client that obtained them. */
  clientId?: string;
  value: T;
};

export type PasteBackResult =
  | { ok: true; params: URLSearchParams }
  | { ok: false; reason: string };

export type OAuthFailureCode =
  | 'invalid_client'
  | 'invalid_grant'
  | 'access_denied'
  | 'server_error'
  | 'network_error'
  | 'unexpected_response';

export interface OAuthFailure {
  code: OAuthFailureCode;
  message: string;
}

export type ToolServerProbeFailureCode =
  | 'transport_error'
  | 'network_error'
  | 'authentication_error'
  | 'protocol_error';

export interface ToolServerProbeFailure {
  code: ToolServerProbeFailureCode;
  message: string;
}

const OAUTH_FAILURE_MESSAGES: Record<OAuthFailureCode, string> = {
  invalid_client: 'OAuth client credentials were rejected',
  invalid_grant: 'OAuth authorization grant was rejected or expired',
  access_denied: 'OAuth authorization was denied',
  server_error: 'OAuth authorization server failed to complete the request',
  network_error: 'OAuth authorization server could not be reached',
  unexpected_response:
    'OAuth authorization server returned an unexpected response',
};

const TOOL_SERVER_PROBE_FAILURE_MESSAGES: Record<
  ToolServerProbeFailureCode,
  string
> = {
  transport_error: 'Tool server transport failed',
  network_error: 'Tool server could not be reached',
  authentication_error: 'Tool server authentication failed',
  protocol_error: 'Tool server returned an unexpected protocol response',
};

function failure(code: OAuthFailureCode): OAuthFailure {
  return { code, message: OAUTH_FAILURE_MESSAGES[code] };
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

/**
 * Converts an OAuth exchange failure into Station-owned, bounded vocabulary.
 * Authorization-server descriptions and response bodies are deliberately
 * ignored: only protocol/system codes, HTTP status, and local error type
 * participate in the classification.
 */
export function classifyOAuthFailure(error: unknown): OAuthFailure {
  const record = errorRecord(error);
  const code = typeof record?.code === 'string' ? record.code : undefined;
  if (code === 'invalid_client' || code === 'unauthorized_client')
    return failure('invalid_client');
  if (code === 'invalid_grant') return failure('invalid_grant');
  if (code === 'access_denied') return failure('access_denied');
  if (code === 'server_error' || code === 'temporarily_unavailable')
    return failure('server_error');
  if (
    code === 'ECONNABORTED' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT'
  ) {
    return failure('network_error');
  }
  const data = errorRecord(record?.data);
  const status =
    typeof record?.status === 'number'
      ? record.status
      : typeof record?.statusCode === 'number'
        ? record.statusCode
        : typeof data?.status === 'number'
          ? data.status
          : undefined;
  if (status !== undefined && status >= 500) return failure('server_error');
  if (error instanceof TypeError) return failure('network_error');
  return failure('unexpected_response');
}

/**
 * Converts a tool-server probe failure into Station-owned vocabulary. Remote
 * response text is never inspected. Only typed protocol/status information
 * and the configured transport participate in the classification.
 */
export function classifyToolServerProbeFailure(
  error: unknown,
  transport: string | undefined,
): ToolServerProbeFailure {
  const record = errorRecord(error);
  const code = typeof record?.code === 'string' ? record.code : undefined;
  const data = errorRecord(record?.data);
  const status =
    typeof record?.status === 'number'
      ? record.status
      : typeof record?.statusCode === 'number'
        ? record.statusCode
        : typeof data?.status === 'number'
          ? data.status
          : undefined;
  if (
    status === 401 ||
    status === 403 ||
    code === 'invalid_client' ||
    code === 'unauthorized_client' ||
    code === 'invalid_grant' ||
    code === 'access_denied'
  ) {
    return {
      code: 'authentication_error',
      message: TOOL_SERVER_PROBE_FAILURE_MESSAGES.authentication_error,
    };
  }
  if (
    error instanceof TypeError ||
    code === 'ECONNABORTED' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT'
  ) {
    return {
      code: 'network_error',
      message: TOOL_SERVER_PROBE_FAILURE_MESSAGES.network_error,
    };
  }
  if (transport === 'stdio') {
    return {
      code: 'transport_error',
      message: TOOL_SERVER_PROBE_FAILURE_MESSAGES.transport_error,
    };
  }
  return {
    code: 'protocol_error',
    message: TOOL_SERVER_PROBE_FAILURE_MESSAGES.protocol_error,
  };
}

export function formatToolServerFailure(
  failure: OAuthFailure | ToolServerProbeFailure,
): string {
  return `${failure.code}: ${failure.message}`;
}

/** Pure hostile-input validator bound to the exact redirect issued for the flow. */
export function validateOAuthCallbackUrl(
  input: string,
  expectedState: string,
  expectedRedirectUrl: string,
): PasteBackResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'callback URL is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'callback URL scheme must be http or https' };
  if (url.username || url.password)
    return { ok: false, reason: 'callback URL must not contain credentials' };
  const expectedRedirect = new URL(expectedRedirectUrl);
  if (
    url.protocol !== expectedRedirect.protocol ||
    url.hostname !== expectedRedirect.hostname ||
    url.port !== expectedRedirect.port ||
    url.pathname !== expectedRedirect.pathname
  )
    return {
      ok: false,
      reason:
        'callback URL does not match the redirect URI issued for this flow',
    };
  if (url.hash)
    return { ok: false, reason: 'callback URL must not contain a fragment' };
  if (url.searchParams.getAll('code').length !== 1)
    return {
      ok: false,
      reason: 'callback URL must contain exactly one code parameter',
    };
  // RFC 9207: the SDK compares iss with the issuer consent was started at;
  // an ambiguous response is refused rather than letting one value win.
  if (url.searchParams.getAll('iss').length > 1)
    return {
      ok: false,
      reason: 'callback URL must contain at most one iss parameter',
    };
  const states = url.searchParams.getAll('state');
  if (states.length !== 1)
    return {
      ok: false,
      reason: 'callback URL must contain exactly one state parameter',
    };
  const actual = Buffer.from(states[0] ?? '');
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return {
      ok: false,
      reason: 'callback URL state does not match the issued flow',
    };
  return { ok: true, params: url.searchParams };
}

export class UnsafeOAuthAuthorizationUrlError extends Error {
  override name = 'UnsafeOAuthAuthorizationUrlError';
}

export function requireHttpAuthorizationUrl(url: URL): URL {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeOAuthAuthorizationUrlError(
      'OAuth authorization URL scheme must be http or https',
    );
  }
  return url;
}

export async function removeToolServerOAuthCredentials(
  store: ToolServerCredentialStore,
  serverId: string,
): Promise<void> {
  for (const key of TOOL_SERVER_OAUTH_CREDENTIAL_KEYS) {
    await store.remove(serverId, key);
  }
}

export const INSTANCE_CREDENTIAL_OWNER: CredentialOwner = Object.freeze({
  kind: 'instance',
});

const MAX_OWNER_ID_LENGTH = 512;
const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * #3279: the credential-store bucket for one server and one owner. The
 * instance bucket is the bare server id, exactly as before, so every existing
 * record keeps working with no rewrite. A person's bucket lives in the
 * separate principal document and is keyed by the whole owner tuple; two
 * principals can never share it, and neither reaches the instance bucket.
 */
function toolServerCredentialBucket(
  serverId: string,
  owner: CredentialOwner,
): string {
  return owner.kind === 'instance'
    ? serverId
    : principalToolServerCredentialBucket(serverId, owner);
}

/** The store document that holds this owner's buckets. */
export function toolServerCredentialStoreFor(
  homeDir: string,
  owner: CredentialOwner,
): ToolServerCredentialStore {
  return new ToolServerCredentialStore(
    homeDir,
    owner.kind === 'instance' ? 'instance' : 'principal',
  );
}

/**
 * Builds a principal-owned credential owner from server-resolved facts. The
 * id is an existing human `PrincipalRef.id` from request or turn authority
 * (see `connected-account-owner.ts`), never a request body or a new id; an
 * optional Project narrows it.
 */
export function principalCredentialOwner(
  principalId: string,
  projectSlug?: string,
): CredentialOwner {
  if (
    typeof principalId !== 'string' ||
    principalId.length > MAX_OWNER_ID_LENGTH ||
    !principalIdMatchesKind(principalId, 'human')
  )
    throw new StationOwnedToolServerError('Credential owner is invalid');
  if (projectSlug === undefined) return { kind: 'principal', principalId };
  if (typeof projectSlug !== 'string' || !PROJECT_SLUG.test(projectSlug))
    throw new StationOwnedToolServerError('Credential Project is invalid');
  return { kind: 'principal-project', principalId, projectSlug };
}

/**
 * #3279 R2: the owners whose credential a turn may use, most specific first.
 * This is the same shape as the engine credential order
 * (`AgentExecutionConfig.credentialProfileRef`): a narrower explicit selection
 * wins, a person's selection never silently degrades to someone else's, and
 * the shared default is reached only when it is explicitly allowed. An
 * instance-owned integration (no `credentialOwnership`) keeps its single
 * shared credential.
 */
export function toolServerCredentialCandidates(
  def: Pick<ToolDef, 'credentialOwnership'>,
  principalId: string | undefined,
  projectSlug?: string,
): CredentialOwner[] {
  const ownership = def.credentialOwnership;
  if (!ownership) return [INSTANCE_CREDENTIAL_OWNER];
  const candidates: CredentialOwner[] = [];
  if (principalId) {
    if (projectSlug)
      candidates.push(principalCredentialOwner(principalId, projectSlug));
    candidates.push(principalCredentialOwner(principalId));
  }
  if (ownership.allowInstanceFallback === true)
    candidates.push(INSTANCE_CREDENTIAL_OWNER);
  return candidates;
}

/** A person-owned integration has no usable credential for this turn. */
export class ConnectAccountRequiredError extends StationOwnedToolServerError {
  override name = 'ConnectAccountRequiredError';
  constructor(readonly serverId: string) {
    super(
      `Connect your account for integration '${serverId}' to use its tools. Station does not use another person's or the shared account for it.`,
    );
  }
}

/**
 * The authorization server offers no client registration (no DCR endpoint and
 * no usable Client ID Metadata Document) and the integration names no client.
 */
export class OAuthClientRequiredError extends StationOwnedToolServerError {
  override name = 'OAuthClientRequiredError';
  constructor(readonly serverId: string) {
    super(
      `Integration '${serverId}' needs an OAuth client ID. Its server does not register clients automatically; add your own OAuth client in the integration's settings.`,
    );
  }
}

/** The server names an authorization server other than the client's declared one. */
export class OAuthClientIssuerMismatchError extends StationOwnedToolServerError {
  override name = 'OAuthClientIssuerMismatchError';
  constructor(readonly serverId: string) {
    super(
      `Integration '${serverId}' names a different OAuth authorization server than its client's declared one. Station did not use the client there.`,
    );
  }
}

/** A pre-registered client has no declared authorization server. */
export class OAuthClientIssuerRequiredError extends StationOwnedToolServerError {
  override name = 'OAuthClientIssuerRequiredError';
  constructor(readonly serverId: string) {
    super(
      `Integration '${serverId}' has a pre-registered OAuth client but no declared authorization server. Add the client's authorization server in the integration's settings.`,
    );
  }
}

/** Another sign-in replaced this integration's OAuth client first. */
class OAuthConsentSupersededError extends StationOwnedToolServerError {
  override name = 'OAuthConsentSupersededError';
  constructor(readonly serverId: string) {
    super(
      `Another sign-in changed integration '${serverId}''s OAuth client first. Sign in again.`,
    );
  }
}

/** The configured client secret's binding could not be materialized. */
class OAuthClientSecretUnavailableError extends StationOwnedToolServerError {
  override name = 'OAuthClientSecretUnavailableError';
  constructor() {
    super(
      "The OAuth client secret is unavailable. Check the integration's client secret binding.",
    );
  }
}

/**
 * The OAuth client a provider presents. Material-free: the secret is read
 * through `clientSecret` on each use and is never cached or persisted here.
 */
export interface ToolServerOAuthClientConfig {
  clientId?: string;
  /** The operator-declared issuer a pre-registered client may be used with. */
  issuer?: string;
  clientMetadataUrl?: string;
  scopes?: readonly string[];
  /**
   * The person's explicit scope choice for this sign-in (empty: the server's
   * own), remembered with their tokens when the consent completes.
   */
  rememberScopes?: readonly string[];
  clientSecret?: () => Promise<string>;
  /**
   * Without a declared issuer: the authorization server this integration's
   * resource was first registered with, shared by every person's sign-in.
   */
  issuerPin?: {
    read(): string | undefined;
    /** Pins `issuer` if none is pinned; returns the pinned issuer. */
    claim(issuer: string): Promise<string>;
    /** Runs `action` under the integration's OAuth pin lock. */
    withLock<T>(action: () => Promise<T>): Promise<T>;
  };
}

/** The narrow secret-binding capability an OAuth client needs. */
export interface ToolServerOAuthClientSecretSource {
  resolveOAuthClientSecret?(input: {
    integrationId: string;
    bindingId: string;
    issuer: string;
    resource: string;
  }): Promise<string>;
}

const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const MAX_REQUESTED_SCOPES = 32;

/**
 * The scopes a person chose for one sign-in: up to 32 distinct RFC 6749 scope
 * tokens. An empty list chooses the server's advertised scopes over the
 * integration default. Station does not judge which scopes are appropriate;
 * it only bounds the shape. Refuses rather than truncating.
 */
export function parseRequestedOAuthScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_REQUESTED_SCOPES ||
    !value.every(
      (scope) => typeof scope === 'string' && OAUTH_SCOPE_TOKEN.test(scope),
    ) ||
    new Set(value).size !== value.length
  )
    throw new StationOwnedToolServerError(
      'Scopes must be at most 32 distinct OAuth scope values.',
    );
  return [...value];
}

/** Builds the provider's client from an integration's `oauthClient`. */
export function toolServerOAuthClientConfig(
  def: Pick<ToolDef, 'id' | 'oauthClient' | 'transport' | 'endpoint'>,
  secrets?: ToolServerOAuthClientSecretSource,
  context: {
    homeDir?: string;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ToolServerOAuthClientConfig | undefined {
  const client = def.oauthClient ?? {};
  const { homeDir } = context;
  // The deployment's metadata document, for integrations that name neither
  // a client ID nor their own document.
  const deploymentMetadataUrl =
    client.clientId || client.clientMetadataUrl
      ? undefined
      : deploymentClientMetadataUrl(context.env ?? process.env);
  const pinResource = toolServerOAuthResourceIdentity(def);
  // A declared issuer is the operator's anchor; otherwise the first server
  // registered with for this resource becomes it.
  const issuerPin =
    homeDir && pinResource && !client.issuer
      ? {
          read: () =>
            readIntegrationOAuthIssuerPin(homeDir, def.id, pinResource),
          claim: (issuer: string) =>
            claimIntegrationOAuthIssuerPin(
              homeDir,
              def.id,
              pinResource,
              issuer,
            ),
          withLock: <T>(action: () => Promise<T>) =>
            withIntegrationOAuthPinLock(homeDir, def.id, action),
        }
      : undefined;
  if (!def.oauthClient && !issuerPin && !deploymentMetadataUrl)
    return undefined;
  const bindingId = client.clientSecretRef;
  // The binding authority releases the secret only for the issuer and
  // resource its grant was made at, so a definition rewritten to name
  // another server cannot materialize it.
  const issuer = client.issuer;
  const resource = toolServerOAuthResourceIdentity(def);
  return {
    ...(client.clientId ? { clientId: client.clientId } : {}),
    ...(client.issuer ? { issuer: client.issuer } : {}),
    ...(client.clientMetadataUrl || deploymentMetadataUrl
      ? { clientMetadataUrl: client.clientMetadataUrl ?? deploymentMetadataUrl }
      : {}),
    ...(client.scopes?.length ? { scopes: [...client.scopes] } : {}),
    ...(issuerPin ? { issuerPin } : {}),
    ...(bindingId
      ? {
          clientSecret: async () => {
            // A configured secret that cannot be read is a refusal, never a
            // silent downgrade to a public client.
            if (!secrets?.resolveOAuthClientSecret || !issuer || !resource)
              throw new OAuthClientSecretUnavailableError();
            try {
              return await secrets.resolveOAuthClientSecret({
                integrationId: def.id,
                bindingId,
                issuer,
                resource,
              });
            } catch {
              throw new OAuthClientSecretUnavailableError();
            }
          },
        }
      : {}),
  };
}

/** Name of the deployment-wide Client ID Metadata Document setting. */
export const OAUTH_CLIENT_METADATA_URL_ENV =
  'STATION_OAUTH_CLIENT_METADATA_URL';

/**
 * The deployment's Client ID Metadata Document URL, or undefined when unset.
 * Nothing is configured by default. A malformed value refuses sign-in rather
 * than being ignored, so a typo cannot silently fall back to registration.
 */
export function deploymentClientMetadataUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[OAUTH_CLIENT_METADATA_URL_ENV]?.trim();
  if (!value) return undefined;
  if (value.length > 2048 || !isToolClientMetadataDocumentUrl(value))
    throw new StationOwnedToolServerError(
      `${OAUTH_CLIENT_METADATA_URL_ENV} must be an HTTPS URL with a path and no credentials or fragment.`,
    );
  return value;
}

/** A refresh outage preserves consent and may be retried after the cooldown. */
export class ToolServerOAuthUnavailableError extends StationOwnedToolServerError {
  override name = 'ToolServerOAuthUnavailableError';
  constructor() {
    super('OAuth token refresh is temporarily unavailable. Try again.');
  }
}

function readJson<T>(
  store: ToolServerCredentialStore,
  id: string,
  key: string,
): T | undefined {
  try {
    return JSON.parse(store.get(id, key)) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    return undefined;
  }
}

const accountRefreshes = new Map<string, Promise<string>>();
const OAUTH_REFRESH_COOLDOWN_MS = 30_000;
const accountRefreshCooldowns = new Map<
  string,
  { expected: StoredOAuthTokens; retryAt: number; forced: boolean }
>();

export class StationToolServerOAuthProvider implements OAuthClientProvider {
  private authorizationUrl?: URL;
  private get refreshKey(): string {
    return JSON.stringify([
      this.store.coordinationKey,
      this.bucket,
      this.resourceIdentity,
    ]);
  }
  /** The only key this provider reads or writes; see `toolServerCredentialBucket`. */
  readonly bucket: string;
  constructor(
    private readonly store: ToolServerCredentialStore,
    private readonly serverId: string,
    private readonly resourceIdentity: string,
    readonly redirectUrl: string,
    private readonly events?: {
      tokensSaved?(refresh: boolean): void;
      authorizationRedirect?(afterRefresh: boolean): void;
    },
    readonly owner: CredentialOwner = INSTANCE_CREDENTIAL_OWNER,
    private readonly client?: ToolServerOAuthClientConfig,
  ) {
    // A person's tokens never enter the shared instance document, and the
    // instance credential is never read through a person's provider.
    if (store.scope !== (owner.kind === 'instance' ? 'instance' : 'principal'))
      throw new Error('Tool-server credential store does not match its owner');
    this.bucket = toolServerCredentialBucket(serverId, owner);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Station',
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(this.client?.scopes ? { scope: this.client.scopes.join(' ') } : {}),
    };
  }
  /**
   * Client ID Metadata Document URL. The SDK uses it only when the server
   * advertises `client_id_metadata_document_supported`; a pre-registered
   * client ID wins over it.
   */
  get clientMetadataUrl(): string | undefined {
    return this.client?.clientId ? undefined : this.client?.clientMetadataUrl;
  }
  async state(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.writeBound(
      KEYS.state,
      state,
      undefined,
      Date.now() + OAUTH_STATE_TTL_MS,
    );
    return state;
  }
  async expectedState(): Promise<string | undefined> {
    return this.readBound<string>(KEYS.state);
  }
  async consumeState(): Promise<string | undefined> {
    const state = await this.expectedState();
    await this.store.remove(this.bucket, KEYS.state);
    return state;
  }
  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const clientId = this.client?.clientId;
    if (clientId) {
      // Pre-registered: rebuilt from configuration on every use, so the
      // secret stays in its binding and never reaches the credential store.
      // Without an issuer there is no server to present it to.
      if (!ctx) return { client_id: clientId };
      if (this.client?.issuer === undefined)
        throw new OAuthClientIssuerRequiredError(this.serverId);
      this.requireDeclaredIssuer(ctx.issuer);
      const secret = this.client?.clientSecret
        ? await this.client.clientSecret()
        : undefined;
      return {
        client_id: clientId,
        ...(secret ? { client_secret: secret } : {}),
        issuer: ctx.issuer,
      };
    }
    if (ctx) this.requireDeclaredIssuer(ctx.issuer);
    return this.readBound<StoredOAuthClientInformation>(KEYS.client, ctx);
  }

  /**
   * GHSA-6qxp-vccf-f47h: resource metadata, not the operator, names the
   * authorization server. A compromised or changed resource could otherwise
   * collect a client secret, or stage a mix-up: send the person to an honest
   * authorization endpoint while naming its own token endpoint, then redeem
   * the code and PKCE verifier Station sends it. A pre-registered client
   * (public or confidential) therefore requires the operator's declared
   * issuer; a declared issuer is enforced for registered and metadata-document
   * clients too. The check reads configuration before any secret, code or
   * verifier leaves Station, so concurrent sign-ins and account resets cannot
   * move it.
   */
  /**
   * The fetch every authorization-server request goes through: Station's own
   * registration and refresh, and the SDK's registration and code exchange
   * (the transport's fetch). A request that carries client or grant material
   * (a POST to the flow's token or registration endpoint, or any POST to
   * another origin than the MCP server's) is checked immediately before it is
   * sent, under the integration's OAuth pin lock: the flow's issuer must match
   * the declared issuer or the current pin. Pinning takes the same lock, so no
   * SDK await between an earlier check and the send can let another sign-in
   * pin a different server unseen. A POST to another origin that is not one of
   * the flow's discovered endpoints is refused outright.
   */
  authorizationFetch(base: FetchLike): FetchLike {
    return async (input, init) => {
      const issuer = await this.authorizationRequestIssuer(input, init);
      if (issuer === undefined) return base(input, init);
      const send = async () => {
        if (issuer === null)
          throw new OAuthClientIssuerMismatchError(this.serverId);
        this.requireDeclaredIssuer(issuer);
        return base(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(15_000),
        });
      };
      const pin = this.client?.issuerPin;
      return pin ? pin.withLock(send) : send();
    };
  }

  /**
   * The issuer a request to an authorization server is made for: undefined
   * when it carries nothing (discovery and MCP traffic), null when it cannot
   * be attributed to the flow's discovered authorization server.
   */
  private async authorizationRequestIssuer(
    input: string | URL | Request,
    init: RequestInit | undefined,
  ): Promise<string | null | undefined> {
    const request = input instanceof Request ? input : undefined;
    const target = new URL(request ? request.url : String(input));
    target.hash = '';
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const discovery = await this.discoveryState();
    const metadata = discovery?.authorizationServerMetadata;
    const endpoints = (
      metadata
        ? [metadata.token_endpoint, metadata.registration_endpoint]
        : discovery
          ? [
              new URL('/token', discovery.authorizationServerUrl).href,
              new URL('/register', discovery.authorizationServerUrl).href,
            ]
          : []
    ).filter((value): value is string => typeof value === 'string');
    const isEndpoint = endpoints.some((endpoint) => {
      try {
        const url = new URL(endpoint);
        url.hash = '';
        return url.href === target.href;
      } catch {
        return false;
      }
    });
    const foreignPost =
      method === 'POST' &&
      target.origin !== new URL(this.resourceIdentity).origin;
    if (!isEndpoint && !foreignPost) return undefined;
    if (!isEndpoint || !discovery) return null;
    return metadata?.issuer ?? String(discovery.authorizationServerUrl);
  }

  private requireDeclaredIssuer(issuer: string): void {
    const anchor = this.client?.issuer ?? this.client?.issuerPin?.read();
    if (anchor !== undefined && anchor !== issuer)
      throw new OAuthClientIssuerMismatchError(this.serverId);
  }

  /**
   * A registration is published only when its consent succeeds (the code
   * exchange passed, with RFC 9207 `iss` checked), and that publication pins
   * the authorization server for everyone when no issuer is declared. Pinning
   * earlier would let a hostile first sign-in that then fails its exchange
   * pin the wrong server. A server pinned first by a concurrent sign-in wins
   * and this one is refused.
   */
  private async pinIssuer(issuer: string | undefined): Promise<void> {
    const pin = this.client?.issuerPin;
    if (!pin || !issuer) return;
    if ((await pin.claim(issuer)) !== issuer)
      throw new OAuthClientIssuerMismatchError(this.serverId);
  }
  async saveClientInformation(
    value: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    if (this.client?.clientId) return;
    await this.writeBound(KEYS.client, value, this.resolveIssuer(value, ctx));
  }

  /**
   * Called when consent has no client yet, after discovery is saved. Refuses
   * with an actionable error when the server can neither register a client nor
   * accept the configured metadata document; without discovered metadata the
   * SDK's own registration fallback decides.
   */
  /**
   * A dynamically registered client is registered for a scope set, and a
   * server may refuse a request outside it (invalid_scope). When the scopes
   * now requested are not all covered, the client is registered again. A
   * registration with no recorded scope counts as not covering them.
   * Pre-registered and metadata-document clients are not re-registered.
   */
  private registrationMissesScopes(
    value: StoredOAuthClientInformation,
  ): boolean {
    const requested = this.client?.scopes;
    if (!requested?.length || this.client?.clientId) return false;
    if (value.client_id === this.clientMetadataUrl) return false;
    // Full registration responses carry `scope`; the stored union type
    // also admits client information without it.
    // A server may grant fewer scopes than asked; what was asked is recorded
    // too, so asking again for the same set does not register again.
    const { scope: granted, [REQUESTED_SCOPE_FIELD]: asked } = value as {
      scope?: unknown;
      [REQUESTED_SCOPE_FIELD]?: unknown;
    };
    const covered = new Set(
      [granted, asked].flatMap((recorded) =>
        typeof recorded === 'string' ? recorded.split(' ') : [],
      ),
    );
    return !requested.every((scope) => covered.has(scope));
  }

  /**
   * Registers a client for this consent when the server needs one. It is
   * not saved here: the consent publishes it with the tokens it obtains, so
   * an abandoned consent leaves any existing client and tokens working.
   */
  private async requireClientRegistration(
    ctx: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const discovery = await this.discoveryState();
    const metadata = discovery?.authorizationServerMetadata;
    if (
      this.clientMetadataUrl &&
      metadata?.client_id_metadata_document_supported === true
    )
      return undefined;
    if (metadata && !metadata.registration_endpoint)
      throw new OAuthClientRequiredError(this.serverId);
    // The SDK registers with the resource's advertised scopes, ahead of the
    // client's. Configured scopes (a default or the person's choice) must be
    // what the client is registered for, so Station registers it here.
    if (!this.client?.scopes || !discovery || !metadata) return undefined;
    const scope = this.client.scopes.join(' ');
    const response = await registerClient(discovery.authorizationServerUrl, {
      metadata,
      clientMetadata: this.clientMetadata,
      scope,
      fetchFn: this.authorizationFetch(fetch),
    });
    // Record what the client was registered for (the server's echo, else
    // what was asked) and what was asked, so a later scope change can tell
    // whether it is covered.
    const registered = {
      ...response,
      scope: response.scope ?? scope,
      [REQUESTED_SCOPE_FIELD]: scope,
      issuer: ctx.issuer,
    } as StoredOAuthClientInformation;
    return registered;
  }
  /** The scopes chosen at this account's last completed sign-in. */
  async rememberedScopes(): Promise<string[] | undefined> {
    const choice = await this.readBound<{ scopes?: unknown }>(KEYS.scopeChoice);
    const scopes = choice?.scopes;
    return Array.isArray(scopes) &&
      scopes.every((scope) => typeof scope === 'string')
      ? [...scopes]
      : undefined;
  }
  async tokens(ctx?: OAuthClientInformationContext) {
    const tokens = await this.readBound<StoredOAuthTokens>(KEYS.tokens, ctx);
    if (!tokens) return undefined;
    // Tokens are usable only with the client that obtained them. Records
    // written before this pairing carry no client id and are trusted as-is.
    const pairedWith = readJson<BoundRecord<StoredOAuthTokens>>(
      this.store,
      this.bucket,
      KEYS.tokens,
    )?.clientId;
    if (pairedWith !== undefined && pairedWith !== this.currentClientId())
      return undefined;
    return tokens;
  }

  /** A repeated 401 retires only the exact credential the remote rejected. */
  async rejectAccessToken(accessToken: string): Promise<void> {
    const expected = await this.tokens();
    if (expected?.access_token === accessToken)
      await this.markNeedsSignInIfCurrent(expected);
  }

  private async markNeedsSignInIfCurrent(
    expected: StoredOAuthTokens,
  ): Promise<void> {
    let serialized: string;
    try {
      serialized = this.store.get(this.bucket, KEYS.tokens);
    } catch {
      return;
    }
    const record = JSON.parse(serialized) as BoundRecord<StoredOAuthTokens>;
    if (
      record.resource !== this.resourceIdentity ||
      !isDeepStrictEqual(record.value, expected)
    )
      return;
    await this.store.compareAndSwap(
      this.bucket,
      KEYS.tokens,
      serialized,
      JSON.stringify({ ...record, needsSignIn: true }),
    );
  }
  /** Existing accounts use Station's coordinator, never the SDK's independent refresh. */
  async forTransport(): Promise<AuthProvider | OAuthClientProvider> {
    if (!(await this.tokens())) return this.forAuthorization();
    let presented: string | undefined;
    return {
      token: async () => {
        presented = await this.accessToken();
        return presented;
      },
      onUnauthorized: async () => {
        await this.accessToken(presented);
      },
    };
  }

  /** Explicit consent never lets the SDK start a second refresh flight. */
  /**
   * The provider one consent flow uses, from redirect to code exchange (the
   * transport holds this one proxy for both).
   *
   * - A pre-registered client's identity comes from configuration, and its
   *   secret is never held here: every read, the code exchange included,
   *   goes back to the binding authority (grant, issuer, MCP URL, instance),
   *   so a secret revoked or unbound mid-consent is not spent.
   * - Any other client is decided once, before the redirect, so the exchange
   *   presents the client the authorization was granted to. A registration
   *   made for this flow is not saved on its own.
   * - On success the tokens are published with the client that obtained
   *   them, in one compare-and-swap against the stored client this flow
   *   started from. A flow superseded by another sign-in is refused rather
   *   than pairing its tokens with someone else's client.
   */
  forAuthorization(): OAuthClientProvider {
    let flowClient: StoredOAuthClientInformation | undefined;
    let flowRegistered = false;
    let startedFrom: string | null = null;
    return new Proxy(this, {
      get(target, key) {
        if (key === 'tokens') return async () => undefined;
        if (key === 'clientInformation')
          return async (ctx?: OAuthClientInformationContext) => {
            if (target.client?.clientId) return target.clientInformation(ctx);
            if (flowClient) {
              // The SDK reads the client again for the code exchange. The
              // declared issuer or pin may have changed since this flow
              // started (another person's sign-in pinned the server), so it
              // is checked here, before the code or verifier is sent.
              if (ctx) target.requireDeclaredIssuer(ctx.issuer);
              return flowClient;
            }
            startedFrom = target.storedRecord(KEYS.client);
            const value = await target.clientInformation(ctx);
            if (!ctx) return value;
            if (value && !target.registrationMissesScopes(value))
              return (flowClient = value);
            const registered = await target.requireClientRegistration(ctx);
            flowRegistered = Boolean(registered);
            flowClient = registered;
            return registered;
          };
        if (key === 'saveClientInformation')
          // The SDK's own registration or metadata-document client: kept for
          // this flow and published with its tokens.
          return async (
            value: StoredOAuthClientInformation,
            ctx?: OAuthClientInformationContext,
          ) => {
            if (target.client?.clientId) return;
            const issuer = target.resolveIssuer(value, ctx);
            flowClient = { ...value, issuer } as StoredOAuthClientInformation;
            flowRegistered = true;
          };
        if (key === 'saveTokens')
          return async (
            value: StoredOAuthTokens,
            ctx?: OAuthClientInformationContext,
          ) =>
            target.publishConsent(value, ctx, {
              client: flowClient,
              registered: flowRegistered,
              startedFrom,
            });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** All Station refreshes join the same document/bucket/resource flight. */
  async accessToken(rejectedToken?: string): Promise<string> {
    const available = await this.tokens();
    const expiresAt = available ? await this.accessTokenExpiresAt() : undefined;
    // Ordinary reads cannot absorb a simultaneous 401 that requires refresh.
    if (
      available?.access_token &&
      available.token_type.toLowerCase() === 'bearer' &&
      rejectedToken !== available.access_token &&
      (expiresAt === undefined || expiresAt > Date.now() + 120_000)
    )
      return available.access_token;
    const key = this.refreshKey;
    const previous = accountRefreshCooldowns.get(key);
    const cooldown =
      previous &&
      previous.retryAt > Date.now() &&
      isDeepStrictEqual(previous.expected, available)
        ? previous
        : undefined;
    const rejected =
      rejectedToken !== undefined && rejectedToken === available?.access_token;
    if (cooldown && (!rejected || cooldown.forced)) {
      if (
        !rejected &&
        available?.access_token &&
        expiresAt !== undefined &&
        expiresAt > Date.now()
      )
        return available.access_token;
      throw new ToolServerOAuthUnavailableError();
    }
    const existing = accountRefreshes.get(key);
    if (existing) return existing;
    // A remote 401 gets one override; ordinary reads need not wait for it.
    if (cooldown) cooldown.forced = true;
    const pending = (async () => {
      const observed = await this.tokens();
      try {
        return await this.resolveAccessToken(rejectedToken);
      } catch (error) {
        if (observed && error instanceof ConnectAccountRequiredError)
          await this.markNeedsSignInIfCurrent(observed);
        throw error;
      }
    })();
    accountRefreshes.set(key, pending);
    try {
      return await pending;
    } finally {
      if (accountRefreshes.get(key) === pending) accountRefreshes.delete(key);
    }
  }

  private async resolveAccessToken(rejectedToken?: string): Promise<string> {
    const needsSignIn = () => new ConnectAccountRequiredError(this.serverId);
    let tokens = await this.tokens();
    if (!tokens?.access_token || tokens.token_type.toLowerCase() !== 'bearer')
      throw needsSignIn();
    const expiresAt = await this.accessTokenExpiresAt();
    // Unknown lifetime (including pre-expiry-stamp envelopes) is resolved by a 401.
    const rejected =
      rejectedToken !== undefined && tokens.access_token === rejectedToken;
    const due = expiresAt !== undefined && expiresAt <= Date.now() + 120_000;
    if (!rejected && !due) return tokens.access_token;
    const discovery = await this.discoveryState();
    const issuer =
      discovery?.authorizationServerMetadata?.issuer ??
      discovery?.authorizationServerUrl;
    const client = issuer
      ? await this.clientInformation({ issuer })
      : undefined;
    const expected = issuer ? await this.tokens({ issuer }) : undefined;
    if (!expected?.refresh_token || !discovery || !client || !issuer)
      throw needsSignIn();
    try {
      const next = await refreshAuthorization(
        discovery.authorizationServerUrl,
        {
          metadata: discovery.authorizationServerMetadata,
          clientInformation: client,
          refreshToken: expected.refresh_token,
          resource:
            discovery.resourceMetadata?.resource ?? this.resourceIdentity,
          fetchFn: this.authorizationFetch(fetch),
        },
      );
      const saved = await this.saveTokensIfCurrent(
        {
          ...next,
          refresh_token: next.refresh_token ?? expected.refresh_token,
          issuer,
        },
        expected,
        { issuer },
      );
      if (saved) {
        const committed = await this.tokens({ issuer });
        if (
          committed?.access_token &&
          committed.token_type.toLowerCase() === 'bearer'
        ) {
          accountRefreshCooldowns.delete(this.refreshKey);
          return committed.access_token;
        }
      }
    } catch (error) {
      // An external writer may have won even when our refresh was rejected.
      tokens = await this.tokens({ issuer });
      if (!tokens?.access_token) throw needsSignIn();
      if (isDeepStrictEqual(tokens, expected)) {
        const { code } = classifyOAuthFailure(error);
        if (code === 'invalid_grant' || code === 'invalid_client')
          throw needsSignIn();
        const key = this.refreshKey;
        const cooldown = accountRefreshCooldowns.get(key);
        if (
          !cooldown ||
          cooldown.retryAt <= Date.now() ||
          !isDeepStrictEqual(cooldown.expected, expected)
        ) {
          const next = {
            expected,
            retryAt: Date.now() + OAUTH_REFRESH_COOLDOWN_MS,
            forced: rejected,
          };
          accountRefreshCooldowns.set(key, next);
          setTimeout(() => {
            if (accountRefreshCooldowns.get(key) === next)
              accountRefreshCooldowns.delete(key);
          }, OAUTH_REFRESH_COOLDOWN_MS).unref();
        }
        if (!rejected && expiresAt !== undefined && expiresAt > Date.now())
          return tokens.access_token;
        throw new ToolServerOAuthUnavailableError();
      }
    }
    tokens = await this.tokens({ issuer });
    if (
      !tokens?.access_token ||
      isDeepStrictEqual(tokens, expected) ||
      tokens.token_type.toLowerCase() !== 'bearer'
    )
      throw needsSignIn();
    accountRefreshCooldowns.delete(this.refreshKey);
    return tokens.access_token;
  }

  async saveTokens(
    value: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const refresh = Boolean((await this.tokens())?.refresh_token);
    await this.store.upsert(
      this.bucket,
      KEYS.tokens,
      JSON.stringify(
        this.tokenRecord(
          value,
          this.resolveIssuer(value, ctx),
          this.currentClientId(),
        ),
      ),
    );
    this.events?.tokensSaved?.(refresh);
  }
  /** The raw stored record for one key, or null when absent. */
  private storedRecord(key: string): string | null {
    try {
      return this.store.get(this.bucket, key);
    } catch {
      return null;
    }
  }

  /** The client tokens must have been obtained by to be usable now. */
  private currentClientId(): string | undefined {
    if (this.client?.clientId) return this.client.clientId;
    return readJson<BoundRecord<StoredOAuthClientInformation>>(
      this.store,
      this.bucket,
      KEYS.client,
    )?.value?.client_id;
  }

  private tokenRecord(
    value: StoredOAuthTokens,
    issuer: string | undefined,
    clientId: string | undefined,
  ): BoundRecord<StoredOAuthTokens> {
    return {
      ...this.boundRecord(
        value,
        issuer,
        undefined,
        value.expires_in === undefined
          ? undefined
          : Date.now() + value.expires_in * 1000,
      ),
      ...(clientId ? { clientId } : {}),
    };
  }

  /** A consent's tokens, published with the client that obtained them. */
  private async publishConsent(
    value: StoredOAuthTokens,
    ctx: OAuthClientInformationContext | undefined,
    flow: {
      client?: StoredOAuthClientInformation;
      registered: boolean;
      startedFrom: string | null;
    },
  ): Promise<void> {
    const refresh = Boolean((await this.tokens())?.refresh_token);
    const issuer = this.resolveIssuer(value, ctx);
    await this.pinIssuer(issuer);
    const clientId = this.client?.clientId ?? flow.client?.client_id;
    const entries: Record<string, string> = {
      [KEYS.tokens]: JSON.stringify(this.tokenRecord(value, issuer, clientId)),
    };
    if (this.client?.rememberScopes)
      entries[KEYS.scopeChoice] = JSON.stringify(
        this.boundRecord({ scopes: [...this.client.rememberScopes] }),
      );
    if (!this.client?.clientId && flow.client && flow.registered)
      entries[KEYS.client] = JSON.stringify(
        this.boundRecord(flow.client, this.resolveIssuer(flow.client, ctx)),
      );
    // A pre-registered client is configuration, not stored state; any other
    // consent must still find the stored client it started from.
    const published = await this.store.compareAndUpsertMany(
      this.bucket,
      entries,
      this.client?.clientId ? {} : { [KEYS.client]: flow.startedFrom },
    );
    if (!published) throw new OAuthConsentSupersededError(this.serverId);
    this.events?.tokensSaved?.(refresh);
  }
  /** A refresh cannot resurrect an account removed while its publication was waiting. */
  async saveTokensIfCurrent(
    value: StoredOAuthTokens,
    expected: StoredOAuthTokens,
    ctx: OAuthClientInformationContext,
  ): Promise<boolean> {
    let serialized: string;
    try {
      serialized = this.store.get(this.bucket, KEYS.tokens);
    } catch {
      return false;
    }
    const record = JSON.parse(serialized) as BoundRecord<StoredOAuthTokens>;
    if (
      record.schemaVersion !== 1 ||
      record.resource !== this.resourceIdentity ||
      !isDeepStrictEqual(record.value, expected)
    )
      return false;
    const next: BoundRecord<StoredOAuthTokens> = {
      schemaVersion: 1,
      resource: this.resourceIdentity,
      issuer: ctx.issuer,
      // A refresh keeps the tokens paired with the client that refreshed them.
      ...(record.clientId !== undefined ? { clientId: record.clientId } : {}),
      value,
      ...(value.expires_in === undefined
        ? {}
        : { accessTokenExpiresAt: Date.now() + value.expires_in * 1000 }),
    };
    const saved = await this.store.compareAndSwap(
      this.bucket,
      KEYS.tokens,
      serialized,
      JSON.stringify(next),
    );
    if (saved) this.events?.tokensSaved?.(Boolean(expected.refresh_token));
    return saved;
  }

  /** Access-token lifetime is separate from the retained refresh credential. */
  async accessTokenExpiresAt(): Promise<number | undefined> {
    await this.tokens(); // Enforce resource binding before reading the envelope.
    return readJson<BoundRecord<StoredOAuthTokens>>(
      this.store,
      this.bucket,
      KEYS.tokens,
    )?.accessTokenExpiresAt;
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    // The SDK prefers the resource's advertised scopes over client metadata,
    // and the provider has no other scope seam. Configured scopes (the
    // integration's default, or the person's choice for this sign-in)
    // replace them here.
    if (this.client?.scopes)
      url.searchParams.set('scope', this.client.scopes.join(' '));
    this.events?.authorizationRedirect?.(
      Boolean((await this.tokens())?.refresh_token),
    );
    this.authorizationUrl = url;
  }
  takeAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }
  async saveCodeVerifier(value: string): Promise<void> {
    await this.writeBound(KEYS.verifier, value);
  }
  async codeVerifier(): Promise<string> {
    const verifier = await this.readBound<string>(KEYS.verifier);
    if (!verifier) throw new Error('OAuth PKCE verifier is missing');
    return verifier;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.writeBound(
      KEYS.discovery,
      value,
      String(value.authorizationServerUrl),
    );
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.readBound<OAuthDiscoveryState>(KEYS.discovery);
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      await removeToolServerOAuthCredentials(this.store, this.bucket);
      return;
    }
    const key =
      scope === 'client'
        ? KEYS.client
        : scope === 'tokens'
          ? KEYS.tokens
          : scope === 'verifier'
            ? KEYS.verifier
            : KEYS.discovery;
    await this.store.remove(this.bucket, key);
  }

  async clearCredentials(): Promise<void> {
    await removeToolServerOAuthCredentials(this.store, this.bucket);
  }

  private resolveIssuer(
    value: object,
    ctx?: OAuthClientInformationContext,
  ): string | undefined {
    const stamped = (value as { issuer?: unknown }).issuer;
    return ctx?.issuer ?? (typeof stamped === 'string' ? stamped : undefined);
  }

  private async writeBound<T>(
    key: string,
    value: T,
    issuer?: string,
    expiresAt?: number,
    accessTokenExpiresAt?: number,
  ): Promise<void> {
    await this.store.upsert(
      this.bucket,
      key,
      JSON.stringify(
        this.boundRecord(value, issuer, expiresAt, accessTokenExpiresAt),
      ),
    );
  }

  private boundRecord<T>(
    value: T,
    issuer?: string,
    expiresAt?: number,
    accessTokenExpiresAt?: number,
  ): BoundRecord<T> {
    return {
      schemaVersion: 1,
      resource: this.resourceIdentity,
      ...(issuer ? { issuer } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt } : {}),
      value,
    };
  }

  private async readBound<T>(
    key: string,
    ctx?: OAuthClientInformationContext,
  ): Promise<T | undefined> {
    const record = readJson<BoundRecord<T>>(this.store, this.bucket, key);
    if (!record) return undefined;
    if (
      record.schemaVersion !== 1 ||
      record.resource !== this.resourceIdentity ||
      !Object.hasOwn(record, 'value')
    ) {
      await this.clearCredentials();
      return undefined;
    }
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      await this.store.remove(this.bucket, key);
      return undefined;
    }
    if (ctx && (!record.issuer || record.issuer !== ctx.issuer))
      return undefined;
    if (key === KEYS.tokens && record.needsSignIn) return undefined;
    return record.value;
  }
}
