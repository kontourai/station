// FCM HTTP v1 sender. Authenticates as the station-push-gateway service
// account, whose only role is Firebase Cloud Messaging API Admin.

import type { SendRequest } from './send-request.ts';
import { base64UrlEncode } from './station-auth.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_REUSE_SECONDS = 50 * 60; // Google issues one-hour tokens.
const REQUEST_TIMEOUT_MS = 10_000;
/** Matches the Station's sealed `expires_at` for a notification (one hour). */
const NOTIFICATION_TTL = '3600s';

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

export type SendOutcome =
  | { kind: 'sent' }
  // The token no longer reaches an install; the Station must forget it.
  | { kind: 'unregistered' }
  // The request itself was wrong; retrying will not help.
  | { kind: 'rejected'; status: number }
  // Worth retrying later.
  | { kind: 'unavailable'; status: number };

export function parseServiceAccount(
  raw: string | undefined,
): ServiceAccount | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.project_id !== 'string' ||
      typeof value.client_email !== 'string'
    )
      return null;
    if (
      typeof value.private_key !== 'string' ||
      !value.private_key.includes('PRIVATE KEY')
    )
      return null;
    return {
      projectId: value.project_id,
      clientEmail: value.client_email,
      privateKeyPem: value.private_key,
    };
  } catch {
    return null;
  }
}

async function signAssertion(
  account: ServiceAccount,
  nowSeconds: number,
): Promise<string> {
  const der = Uint8Array.from(
    atob(
      account.privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    ),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const encode = (value: object) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

export class FcmSender {
  private cached: { token: string; expiresAt: number } | null = null;
  // One exchange at a time: concurrent cold-start requests share it rather
  // than each signing an assertion and calling Google.
  private pending: Promise<string> | null = null;
  private readonly account: ServiceAccount;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    account: ServiceAccount,
    // Workers throws "Illegal invocation" when fetch is called as a method of
    // another object, so the default must be a wrapper, not the bare global.
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.account = account;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.token);
    }
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const now = this.now();
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: await signAssertion(this.account, now),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Google's error code (e.g. invalid_grant) names the cause; the body
      // never contains the key or the assertion.
      const detail = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new Error(
        `token exchange failed with ${response.status} ${String(detail?.error ?? '')}`.trim(),
      );
    }
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string')
      throw new Error('token exchange returned no access_token');
    this.cached = {
      token: body.access_token,
      expiresAt: now + ACCESS_TOKEN_REUSE_SECONDS,
    };
    return body.access_token;
  }

  async send(request: SendRequest): Promise<SendOutcome> {
    const first = await this.attempt(request);
    // A 401 means Google revoked the cached token early; one fresh try.
    return first === 'retry' ? this.finish(await this.attempt(request)) : first;
  }

  private finish(outcome: SendOutcome | 'retry'): SendOutcome {
    return outcome === 'retry' ? { kind: 'unavailable', status: 401 } : outcome;
  }

  private async attempt(request: SendRequest): Promise<SendOutcome | 'retry'> {
    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (error) {
      console.error(
        'fcm access token unavailable:',
        error instanceof Error ? error.message : 'unknown error',
      );
      return { kind: 'unavailable', status: 503 };
    }
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: request.token,
            // Data-only: the app renders the card itself and applies its own
            // registration and freshness checks. Activity must be high
            // priority or Doze holds it past the app's ten-minute freshness
            // window; a notification is high unless the Station asked for
            // normal (info and done), and lives as long as the phone would
            // still show it (its sealed expires_at).
            data: request.data,
            android: {
              priority: request.priority === 'normal' ? 'NORMAL' : 'HIGH',
              ttl:
                request.data.station_kind === 'station_notification'
                  ? NOTIFICATION_TTL
                  : '300s',
              restricted_package_name: request.packageName,
              ...(request.collapseKey
                ? { collapse_key: request.collapseKey }
                : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ).catch(() => null);
    if (!response) return { kind: 'unavailable', status: 504 };
    if (response.ok) return { kind: 'sent' };
    if (response.status === 401) {
      this.cached = null;
      return 'retry';
    }

    const errorBody = (await response.json().catch(() => null)) as {
      error?: {
        details?: Array<{
          errorCode?: string;
          fieldViolations?: Array<{ field?: string }>;
        }>;
      };
    } | null;
    const details = errorBody?.error?.details ?? [];
    const codes = details.map((detail) => detail.errorCode);
    // FCM reports a malformed token as INVALID_ARGUMENT on message.token. It
    // can never succeed, so the Station must forget it like an unregistered one.
    const badToken = details.some((detail) =>
      detail.fieldViolations?.some((v) => v.field === 'message.token'),
    );
    if (codes.includes('UNREGISTERED') || badToken) {
      return { kind: 'unregistered' };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: 'unavailable', status: response.status };
    }
    return { kind: 'rejected', status: response.status };
  }
}
