/**
 * Kiro social (Google, GitHub) sign-in: Kiro's own portal, a PKCE code
 * returned to a loopback listener on this computer, and the code exchange and
 * refresh at Kiro's social auth service. A port of kirocrew
 * `auth/login/portal.py` and `auth/refresh.py` (`_refresh_social`):
 *
 *   open      {portal}/signin?state&code_challenge&code_challenge_method=S256
 *                     &redirect_uri=http://localhost:<port>&redirect_from=kirocli
 *   callback  http://localhost:<port>/oauth/callback?login_option&code&state
 *   exchange  POST {service}/oauth/token   {code, code_verifier, redirect_uri}
 *   refresh   POST {service}/refreshToken  {refreshToken}
 *
 * Identity: Station sends its own User-Agent and no client id. The only
 * kiro-cli-named value is `redirect_from=kirocli`, the portal's parameter for
 * which redirect contract (a loopback `redirect_uri` on an allowlisted port)
 * the sign-in uses; the portal requires it. Kiro's social DEVICE flow is not
 * ported because it takes kiro-cli's client id (see oidc.ts).
 *
 * The callback ports are the ones Kiro's auth service allowlists as redirect
 * URIs (kirocrew `CALLBACK_PORTS`); no other port is accepted there. The
 * listener binds 127.0.0.1 only, answers only the two callback paths, checks
 * the state, takes one outcome and closes. The browser must be on this
 * computer for the redirect to reach it.
 *
 * Every error message here is safe to log: it names a step, a status or an
 * OAuth error code, never a token, a code or a response body.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  expiry,
  type Http,
  isProfileArn,
  KiroOidcError,
  KiroRefreshRejectedError,
  oauthError,
  postJson,
  record,
  requireString,
} from './oidc.js';

/** Kiro's auth service accepts redirect URIs on these loopback ports only. */
export const KIRO_SOCIAL_CALLBACK_PORTS: readonly number[] = Object.freeze([
  3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153,
]);

/** The callback paths Kiro's portal redirects to (kiro-cli honours both). */
const CALLBACK_PATHS: ReadonlySet<string> = new Set([
  '/oauth/callback',
  '/signin/callback',
]);

/** How long a social sign-in waits for the browser to come back (kirocrew `LOOPBACK_TIMEOUT_SECS`). */
export const KIRO_SOCIAL_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Station's own client name on every social request; never another product's. */
const STATION_USER_AGENT = 'Station';

export interface KiroSocialEndpoints {
  /** Kiro's sign-in portal, opened in the person's browser. */
  readonly portalUrl: string;
  /** Kiro's social auth service: the code exchange and refresh. */
  readonly serviceUrl: string;
}

export const KIRO_SOCIAL_ENDPOINTS: KiroSocialEndpoints = Object.freeze({
  portalUrl: 'https://app.kiro.dev',
  serviceUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev',
});

/** The provider a social sign-in stored, from the callback's `login_option`. */
export type KiroSocialProvider = 'google' | 'github';

/** What the engine's token answer names the provider (kirocrew `SocialProvider`). */
export const KIRO_SOCIAL_PROVIDER_ATTRIBUTE: Record<
  KiroSocialProvider,
  string
> = { google: 'Google', github: 'Github' };

export function kiroSocialProvider(
  loginOption: string,
): KiroSocialProvider | undefined {
  const value = loginOption.toLowerCase();
  return value === 'google' || value === 'github' ? value : undefined;
}

/** Why a loopback sign-in ended without a code. */
export type KiroSocialCallbackFailure =
  | 'ports-busy'
  | 'portal-error'
  | 'state-mismatch'
  | 'wrong-path'
  | 'no-code'
  | 'timeout'
  | 'cancelled';

export class KiroSocialCallbackError extends KiroOidcError {
  constructor(
    readonly code: KiroSocialCallbackFailure,
    message: string,
  ) {
    super(message);
    this.name = 'KiroSocialCallbackError';
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest()),
  };
}

const STATE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** An unguessable alphanumeric state, the alphabet kiro-cli's own state uses. */
export function socialState(length = 32): string {
  let state = '';
  // 248 = 4 * 62: rejecting larger bytes keeps every character equally likely.
  while (state.length < length)
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && state.length < length)
        state += STATE_ALPHABET[byte % 62];
    }
  return state;
}

export function portalSignInUrl(
  portalUrl: string,
  port: number,
  state: string,
  challenge: string,
): string {
  const url = new URL('/signin', portalUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', `http://localhost:${port}`);
  // The portal's parameter for the loopback redirect contract; see above.
  url.searchParams.set('redirect_from', 'kirocli');
  return url.toString();
}

/** The redirect URI the exchange must repeat exactly (kiro-cli portal.rs). */
export function socialRedirectUri(
  port: number,
  path: string,
  loginOption: string,
): string {
  return `http://localhost:${port}${path}?login_option=${encodeURIComponent(loginOption)}`;
}

export interface KiroSocialCallback {
  readonly code: string;
  readonly loginOption: string;
  readonly path: string;
}

export interface KiroSocialListener {
  readonly port: number;
  /** Settles once: the callback, or a {@link KiroSocialCallbackError}. */
  readonly result: Promise<KiroSocialCallback>;
  /** Resolves when the socket is closed. */
  readonly closed: Promise<void>;
  /** Ends the wait as `cancelled` and closes the socket. */
  cancel(): void;
}

const PAGE = {
  done: 'Signed in to Kiro. You can close this tab and go back to Station.',
  failed:
    'The Kiro sign-in did not finish. Go back to Station to see why and try again.',
  notFound: 'Not found.',
} as const;

function answer(
  response: ServerResponse,
  status: number,
  text: string,
  then?: () => void,
) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  response.end(text, then);
}

function sameState(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.off('listening', onListening);
      resolve(false);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

/**
 * Bind the first free port of `ports` on 127.0.0.1 and wait for the portal's
 * redirect. A busy port is skipped; when every port is busy this rejects
 * with `ports-busy` and nothing is left listening.
 */
export async function openSocialCallbackListener(input: {
  ports: readonly number[];
  state: string;
  timeoutMs: number;
}): Promise<KiroSocialListener> {
  let settle!: (
    outcome:
      | { callback: KiroSocialCallback }
      | { error: KiroSocialCallbackError },
  ) => void;
  let settled = false;
  const result = new Promise<KiroSocialCallback>((resolve, reject) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      if ('callback' in outcome) resolve(outcome.callback);
      else reject(outcome.error);
    };
  });
  // A caller that only awaits `closed` must not see an unhandled rejection.
  result.catch(() => {});
  const fail = (code: KiroSocialCallbackFailure, message: string) =>
    settle({ error: new KiroSocialCallbackError(code, message) });

  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      answer(response, 400, PAGE.notFound);
      return;
    }
    const state = url.searchParams.get('state');
    if (request.method !== 'GET' || !CALLBACK_PATHS.has(url.pathname)) {
      // The exchange must repeat the exact path, so a near miss cannot be
      // used. When it carries this sign-in's state it IS the portal's
      // redirect: fail now rather than wait out the timeout. Anything else
      // (a favicon, a port probe) changes nothing.
      if (!settled && sameState(state, input.state))
        fail(
          'wrong-path',
          'Kiro sent the browser back to an address Station does not listen on.',
        );
      answer(response, 404, PAGE.notFound, settled ? close : undefined);
      return;
    }
    if (settled) {
      answer(response, 410, PAGE.failed, close);
      return;
    }
    const portalError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    let gotCode = false;
    if (portalError !== null) {
      const named = oauthError({ error: portalError });
      fail(
        'portal-error',
        `Kiro's sign-in page refused the sign-in${named ? `: ${named}` : '.'}`,
      );
    } else if (!sameState(state, input.state)) {
      fail(
        'state-mismatch',
        'The sign-in came back from a different attempt, so Station did not use it.',
      );
    } else if (!code) {
      fail('no-code', "Kiro's sign-in page came back without a code.");
    } else {
      gotCode = true;
      settle({
        callback: {
          code,
          loginOption: url.searchParams.get('login_option') ?? '',
          path: url.pathname,
        },
      });
    }
    answer(response, 200, gotCode ? PAGE.done : PAGE.failed, close);
  });
  server.unref();

  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close(): Promise<void> {
    if (timer) clearTimeout(timer);
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    return closing;
  }

  let port: number | undefined;
  for (const candidate of input.ports) {
    if (await listenOn(server, candidate)) {
      port = candidate;
      break;
    }
  }
  if (port === undefined)
    throw new KiroSocialCallbackError(
      'ports-busy',
      "Every port Kiro's Google and GitHub sign-in can return to is in use on this computer.",
    );

  timer = setTimeout(() => {
    fail(
      'timeout',
      'No answer came back from the browser in time. If the browser is not on the computer Station runs on, use AWS Builder ID or IAM Identity Center.',
    );
    void close();
  }, input.timeoutMs);
  timer.unref?.();

  // Close as soon as an outcome is known, even if the response is still
  // being written; `close` waits for it.
  void result.then(close, close);
  const closed = new Promise<void>((resolve) => {
    server.once('close', () => resolve());
  });

  return {
    port,
    result,
    closed,
    cancel: () => {
      fail('cancelled', 'The sign-in was cancelled.');
      void close();
    },
  };
}

/** Kiro's social service turned the sign-in down; a new attempt is needed. */
export class KiroSignInRefusedError extends KiroOidcError {
  constructor(message: string) {
    super(message);
    this.name = 'KiroSignInRefusedError';
  }
}

export interface SocialTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  profileArn?: string;
}

const SOCIAL_JSON = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': STATION_USER_AGENT,
};

function socialTokens(
  http: Http,
  data: unknown,
  step: string,
): Omit<SocialTokens, 'profileArn'> & { profileArn: unknown } {
  const body = record(data, step);
  return {
    accessToken: requireString(body, 'accessToken', step),
    ...(typeof body.refreshToken === 'string' && body.refreshToken
      ? { refreshToken: body.refreshToken }
      : {}),
    expiresAt: expiry(http, body.expiresIn),
    profileArn: body.profileArn,
  };
}

/** Exchange the portal's code at `{service}/oauth/token`. Refused: a {@link KiroOidcError}. */
export async function exchangeSocialCode(
  http: Http,
  serviceUrl: string,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<SocialTokens & { profileArn: string }> {
  const { status, data } = await postJson(
    http,
    `${serviceUrl.replace(/\/+$/, '')}/oauth/token`,
    {
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    SOCIAL_JSON,
  );
  if (status !== 200) {
    const error = oauthError(data);
    throw new KiroSignInRefusedError(
      `Kiro did not accept the sign-in: HTTP ${status}${error ? ` ${error}` : ''}`,
    );
  }
  const tokens = socialTokens(http, data, 'Kiro sign-in');
  if (!isProfileArn(tokens.profileArn))
    throw new KiroOidcError('Kiro sign-in response is missing profileArn');
  return { ...tokens, profileArn: tokens.profileArn };
}

/** Refresh at `{service}/refreshToken`. A 400/401/403 is {@link KiroRefreshRejectedError}. */
export async function refreshSocialToken(
  http: Http,
  serviceUrl: string,
  refreshToken: string,
): Promise<SocialTokens> {
  const { status, data } = await postJson(
    http,
    `${serviceUrl.replace(/\/+$/, '')}/refreshToken`,
    { refreshToken },
    SOCIAL_JSON,
  );
  if (status === 400 || status === 401 || status === 403) {
    const error = oauthError(data);
    throw new KiroRefreshRejectedError(
      `Kiro refused the refresh: HTTP ${status}${error ? ` ${error}` : ''}`,
    );
  }
  if (status !== 200)
    throw new KiroOidcError(`Kiro refresh failed: HTTP ${status}`);
  const { profileArn, ...tokens } = socialTokens(http, data, 'refresh');
  return { ...tokens, ...(isProfileArn(profileArn) ? { profileArn } : {}) };
}
