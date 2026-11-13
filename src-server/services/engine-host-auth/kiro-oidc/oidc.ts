/**
 * Kiro sign-in through AWS SSO-OIDC: Builder ID and IAM Identity Center
 * device-code flow, and the refresh grant. A port of kirocrew
 * `auth/login/builder_id.py`, `auth/refresh.py` (`_refresh_sso_oidc`) and
 * `auth/login/control_plane.py` (`ListAvailableProfiles`).
 *
 * Station registers its own public OAuth client (`RegisterClient`, client
 * name "Station"), so nothing here presents another product's identity.
 * Social (Google, GitHub) sign-in is not ported: Kiro's device service takes
 * only kiro-cli's own client id, which Station will not present as its own.
 *
 * Endpoints (under `https://oidc.<region>.amazonaws.com`):
 *   POST /client/register        -> {clientId, clientSecret, clientSecretExpiresAt}
 *   POST /device_authorization   -> {deviceCode, userCode, verificationUri,
 *                                    verificationUriComplete, expiresIn, interval}
 *   POST /token (device_code)    -> {accessToken, refreshToken, expiresIn}
 *   POST /token (refresh_token)  -> {accessToken, refreshToken?, expiresIn}
 *
 * Every error message here is safe to log: it names a step and a status or
 * an OAuth error code, never a token, a secret or a response body.
 */

/** The fixed profile every Builder ID sign-in is served under (kirocrew auth/provider.py:34). */
export const BUILDER_ID_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';
export const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
export const BUILDER_ID_REGION = 'us-east-1';
const OIDC_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
] as const;
const OIDC_CLIENT_NAME = 'Station';
/** A registration with less than this left is replaced at the next sign-in. */
const CLIENT_REUSE_MARGIN_SECONDS = 7 * 24 * 3600;
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const LIST_PROFILES_TARGET = 'AmazonCodeWhispererService.ListAvailableProfiles';
const MAX_PROFILE_PAGES = 20;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/** Where the flows send requests. Production uses {@link KIRO_OIDC_ENDPOINTS}; tests point it at a stub. */
export interface KiroOidcEndpoints {
  oidcUrl(region: string): string;
  /** Kiro control-plane hosts to ask for profiles, the login region's first. */
  controlPlaneUrls(region: string): string[];
}

const CONTROL_PLANE: Record<string, string> = {
  'us-east-1': 'https://management.us-east-1.kiro.dev/',
  'eu-central-1': 'https://management.eu-central-1.kiro.dev/',
  'eu-west-1': 'https://management.eu-central-1.kiro.dev/',
};

export const KIRO_OIDC_ENDPOINTS: KiroOidcEndpoints = Object.freeze({
  oidcUrl: (region: string) => `https://oidc.${region}.amazonaws.com`,
  controlPlaneUrls: (region: string) => [
    ...new Set([
      CONTROL_PLANE[region] ?? (CONTROL_PLANE['us-east-1'] as string),
      ...Object.values(CONTROL_PLANE),
    ]),
  ],
});

export function isAwsRegion(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 32 && AWS_REGION.test(value)
  );
}

export class KiroOidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiroOidcError';
  }
}

/** The issuer refused the refresh grant (HTTP 400/401/403): only a new sign-in helps. */
export class KiroRefreshRejectedError extends KiroOidcError {
  constructor(message: string) {
    super(message);
    this.name = 'KiroRefreshRejectedError';
  }
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  /** Epoch seconds. */
  clientSecretExpiresAt?: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Epoch ms. */
  expiresAt: number;
  intervalMs: number;
}

export interface OidcTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type DevicePoll =
  | { kind: 'pending' }
  | { kind: 'slow-down' }
  | { kind: 'authorized'; tokens: OidcTokens };

/**
 * Each OIDC or control-plane request is abandoned after this long. A refresh
 * runs with the vault's refresh lock held, so a stalled endpoint must not hold
 * it (and every issue for that scope) indefinitely.
 */
const OIDC_REQUEST_TIMEOUT_MS = 15_000;

interface Http {
  fetch: typeof fetch;
  endpoints: KiroOidcEndpoints;
  now: () => number;
  /** Defaults to {@link OIDC_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

const AMZ_JSON_1_1 = {
  'content-type': 'application/x-amz-json-1.1',
  accept: 'application/json',
};

async function postJson(
  http: Http,
  url: string,
  body: unknown,
  headers: Record<string, string> = AMZ_JSON_1_1,
): Promise<{ status: number; data: unknown }> {
  const timeoutMs = http.requestTimeoutMs ?? OIDC_REQUEST_TIMEOUT_MS;
  // One signal covers the response and its body: a server that answers
  // headers and then stalls the body is abandoned too.
  const signal = AbortSignal.timeout(timeoutMs);
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw new KiroOidcError(
      signal.aborted
        ? `${host} did not answer within ${timeoutMs}ms`
        : `Could not reach ${host}: ${(error as Error).name}`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (signal.aborted)
      throw new KiroOidcError(`${host} did not answer within ${timeoutMs}ms`);
    data = undefined;
  }
  return { status: response.status, data };
}

function record(data: unknown, step: string): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new KiroOidcError(`${step} returned a non-object body`);
  return data as Record<string, unknown>;
}

function requireString(
  data: Record<string, unknown>,
  key: string,
  step: string,
): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new KiroOidcError(`${step} response is missing ${key}`);
  return value;
}

function oauthError(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const error = (data as Record<string, unknown>).error;
  // Bounded and character-limited: it becomes part of a log line.
  return typeof error === 'string' && /^[a-z_]{1,64}$/i.test(error)
    ? error
    : '';
}

function expiry(http: Http, expiresIn: unknown): number {
  const seconds =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : DEFAULT_TOKEN_TTL_SECONDS;
  return http.now() + seconds * 1000;
}

export async function registerClient(
  http: Http,
  region: string,
): Promise<RegisteredClient> {
  const { status, data } = await postJson(
    http,
    `${http.endpoints.oidcUrl(region)}/client/register`,
    {
      clientName: OIDC_CLIENT_NAME,
      clientType: 'public',
      scopes: [...OIDC_SCOPES],
    },
  );
  if (status !== 200 && status !== 201)
    throw new KiroOidcError(`RegisterClient failed: HTTP ${status}`);
  const body = record(data, 'RegisterClient');
  const expiresAt = body.clientSecretExpiresAt;
  return {
    clientId: requireString(body, 'clientId', 'RegisterClient'),
    clientSecret: requireString(body, 'clientSecret', 'RegisterClient'),
    ...(typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt)
      ? { clientSecretExpiresAt: expiresAt }
      : {}),
  };
}

/** A stored registration a new sign-in in `region` may reuse, or undefined. */
export function reusableClient(
  stored:
    | {
        region?: string;
        clientId?: string;
        clientSecret?: string;
        clientSecretExpiresAt?: number;
      }
    | undefined,
  region: string,
  nowMs: number,
): RegisteredClient | undefined {
  if (!stored || stored.region !== region) return undefined;
  if (!stored.clientId || !stored.clientSecret) return undefined;
  const lapses = stored.clientSecretExpiresAt;
  if (
    typeof lapses !== 'number' ||
    lapses <= nowMs / 1000 + CLIENT_REUSE_MARGIN_SECONDS
  )
    return undefined;
  return {
    clientId: stored.clientId,
    clientSecret: stored.clientSecret,
    clientSecretExpiresAt: lapses,
  };
}

export async function startDeviceAuthorization(
  http: Http,
  client: RegisteredClient,
  region: string,
  startUrl: string,
): Promise<DeviceAuthorization> {
  const { status, data } = await postJson(
    http,
    `${http.endpoints.oidcUrl(region)}/device_authorization`,
    {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl,
    },
  );
  if (status !== 200) {
    const error = oauthError(data);
    if (
      status === 400 &&
      error === 'invalid_request' &&
      startUrl !== BUILDER_ID_START_URL
    )
      throw new KiroOidcError(
        `AWS did not accept the start URL in region ${region}. Use your company's AWS access portal URL (https://your-company.awsapps.com/start) and the region its Identity Center is in.`,
      );
    throw new KiroOidcError(
      `StartDeviceAuthorization failed: HTTP ${status}${error ? ` ${error}` : ''}`,
    );
  }
  const body = record(data, 'StartDeviceAuthorization');
  const expiresIn = typeof body.expiresIn === 'number' ? body.expiresIn : 600;
  const interval = typeof body.interval === 'number' ? body.interval : 5;
  return {
    deviceCode: requireString(body, 'deviceCode', 'StartDeviceAuthorization'),
    userCode: requireString(body, 'userCode', 'StartDeviceAuthorization'),
    verificationUri: requireString(
      body,
      'verificationUri',
      'StartDeviceAuthorization',
    ),
    verificationUriComplete: requireString(
      body,
      'verificationUriComplete',
      'StartDeviceAuthorization',
    ),
    expiresAt: http.now() + expiresIn * 1000,
    intervalMs: Math.max(1, interval) * 1000,
  };
}

/**
 * One poll of the token endpoint. `authorization_pending` and `slow_down`
 * are "not yet"; `expired_token` and every other refusal end the flow.
 */
export async function pollDeviceToken(
  http: Http,
  client: RegisteredClient,
  auth: DeviceAuthorization,
  region: string,
): Promise<DevicePoll> {
  const { status, data } = await postJson(
    http,
    `${http.endpoints.oidcUrl(region)}/token`,
    {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      grantType: DEVICE_GRANT,
      deviceCode: auth.deviceCode,
    },
  );
  if (status === 200) {
    const body = record(data, 'CreateToken');
    return {
      kind: 'authorized',
      tokens: {
        accessToken: requireString(body, 'accessToken', 'CreateToken'),
        ...(typeof body.refreshToken === 'string' && body.refreshToken
          ? { refreshToken: body.refreshToken }
          : {}),
        expiresAt: expiry(http, body.expiresIn),
      },
    };
  }
  if (data === undefined) return { kind: 'pending' };
  const error = oauthError(data);
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow-down' };
  if (error === 'expired_token')
    throw new KiroOidcError('The sign-in code expired before it was approved.');
  if (error === 'access_denied')
    throw new KiroOidcError('The sign-in was declined.');
  throw new KiroOidcError(
    `The sign-in could not be completed: ${error || `HTTP ${status}`}`,
  );
}

/** The SSO-OIDC refresh grant. A 400/401/403 is {@link KiroRefreshRejectedError}. */
export async function refreshOidcToken(
  http: Http,
  input: {
    region: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
): Promise<OidcTokens> {
  const { status, data } = await postJson(
    http,
    `${http.endpoints.oidcUrl(input.region)}/token`,
    {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      grantType: 'refresh_token',
      refreshToken: input.refreshToken,
    },
  );
  if (status === 400 || status === 401 || status === 403) {
    const error = oauthError(data);
    throw new KiroRefreshRejectedError(
      `SSO-OIDC refused the refresh: HTTP ${status}${error ? ` ${error}` : ''}`,
    );
  }
  if (status !== 200)
    throw new KiroOidcError(`SSO-OIDC refresh failed: HTTP ${status}`);
  const body = record(data, 'refresh');
  return {
    accessToken: requireString(body, 'accessToken', 'refresh'),
    ...(typeof body.refreshToken === 'string' && body.refreshToken
      ? { refreshToken: body.refreshToken }
      : {}),
    expiresAt: expiry(http, body.expiresIn),
  };
}

const PROFILE_ARN =
  /^arn:[-a-z0-9]{1,63}:codewhisperer:[-a-z0-9]{1,63}:\d{12}:profile\/[A-Za-z0-9]{1,64}$/;

/**
 * The first Kiro profile an Identity Center token can use: each control
 * plane is asked, the login region's first, following `nextToken` until a
 * page lists one (kirocrew `list_available_profiles`).
 */
export async function firstAvailableProfileArn(
  http: Http,
  accessToken: string,
  region: string,
): Promise<string> {
  let refused = false;
  for (const url of http.endpoints.controlPlaneUrls(region)) {
    let nextToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
      const { status, data } = await postJson(
        http,
        url,
        { maxResults: 10, ...(nextToken ? { nextToken } : {}) },
        {
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': LIST_PROFILES_TARGET,
          authorization: `Bearer ${accessToken}`,
        },
      );
      if (status !== 200) {
        refused = true;
        break;
      }
      const body = record(data, 'ListAvailableProfiles');
      const profiles = Array.isArray(body.profiles) ? body.profiles : [];
      for (const profile of profiles) {
        const arn = (profile as Record<string, unknown> | null)?.arn;
        if (typeof arn === 'string' && PROFILE_ARN.test(arn)) return arn;
      }
      const token = body.nextToken;
      if (typeof token !== 'string' || token === '' || seen.has(token)) break;
      seen.add(token);
      nextToken = token;
    }
  }
  throw new KiroOidcError(
    refused
      ? 'Kiro did not list a profile for this Identity Center sign-in.'
      : 'This Identity Center account has no Kiro profile.',
  );
}
