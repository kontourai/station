import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import {
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
  | 'tool-call';

const TOOL_SERVER_OPERATION_MESSAGES: Record<ToolServerOperation, string> = {
  authorize: 'Tool server authorization could not be started',
  'oauth-exchange': 'OAuth authorization failed',
  probe: 'Tool server probe failed',
  connect: 'Tool server connection failed',
  'resource-read': 'MCP UI resource read failed',
  'tool-call': 'MCP tool call failed',
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

export function isToolServerFailureResult(value: unknown): boolean {
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

/**
 * OAuth credential identity is the URL-standard serialized HTTP request target
 * with its fragment removed. Fragments never reach an HTTP server; path
 * trailing slashes and query ordering remain significant.
 */
export function toolServerOAuthResourceIdentity(
  def: ToolDef,
): string | undefined {
  if (
    (def.transport !== 'sse' && def.transport !== 'streamable-http') ||
    !def.endpoint
  ) {
    return undefined;
  }
  try {
    const endpoint = new URL(def.endpoint);
    endpoint.hash = '';
    return endpoint.href;
  } catch {
    return undefined;
  }
}

const KEYS = {
  tokens: 'oauth.tokens',
  client: 'oauth.client-information',
  verifier: 'oauth.pkce-verifier',
  state: 'oauth.state',
  discovery: 'oauth.discovery',
} as const;

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type BoundRecord<T> = {
  schemaVersion: 1;
  resource: string;
  issuer?: string;
  expiresAt?: number;
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

export class StationToolServerOAuthProvider implements OAuthClientProvider {
  private authorizationUrl?: URL;
  constructor(
    private readonly store: ToolServerCredentialStore,
    private readonly serverId: string,
    private readonly resourceIdentity: string,
    readonly redirectUrl: string,
    private readonly events?: {
      tokensSaved?(refresh: boolean): void;
      authorizationRedirect?(afterRefresh: boolean): void;
    },
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Station',
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
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
    await this.store.remove(this.serverId, KEYS.state);
    return state;
  }
  async clientInformation(ctx?: OAuthClientInformationContext) {
    return this.readBound<StoredOAuthClientInformation>(KEYS.client, ctx);
  }
  async saveClientInformation(
    value: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeBound(KEYS.client, value, this.resolveIssuer(value, ctx));
  }
  async tokens(ctx?: OAuthClientInformationContext) {
    return this.readBound<StoredOAuthTokens>(KEYS.tokens, ctx);
  }
  async saveTokens(
    value: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const refresh = Boolean((await this.tokens())?.refresh_token);
    await this.writeBound(KEYS.tokens, value, this.resolveIssuer(value, ctx));
    this.events?.tokensSaved?.(refresh);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
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
      await removeToolServerOAuthCredentials(this.store, this.serverId);
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
    await this.store.remove(this.serverId, key);
  }

  async clearCredentials(): Promise<void> {
    await removeToolServerOAuthCredentials(this.store, this.serverId);
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
  ): Promise<void> {
    const record: BoundRecord<T> = {
      schemaVersion: 1,
      resource: this.resourceIdentity,
      ...(issuer ? { issuer } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      value,
    };
    await this.store.upsert(this.serverId, key, JSON.stringify(record));
  }

  private async readBound<T>(
    key: string,
    ctx?: OAuthClientInformationContext,
  ): Promise<T | undefined> {
    const record = readJson<BoundRecord<T>>(this.store, this.serverId, key);
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
      await this.store.remove(this.serverId, key);
      return undefined;
    }
    if (ctx && (!record.issuer || record.issuer !== ctx.issuer))
      return undefined;
    return record.value;
  }
}
