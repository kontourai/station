/**
 * A local stand-in for Kiro's sign-in portal and social auth service,
 * speaking the wire kirocrew `auth/login/portal.py` and `auth/refresh.py`
 * (`_refresh_social`) speak. The portal only records the `/signin` query (a
 * real one renders a page and later redirects the browser); the service
 * checks the PKCE verifier against the challenge the portal saw, and answers
 * the exchange and refresh as each test scripts.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KiroSocialEndpoints } from '../../kiro-oidc/social.js';

export type SocialAnswer =
  | { status: number; error?: string }
  | {
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
      profileArn?: string;
      /** Delay before answering, ms. */
      delayMs?: number;
    };

export interface SocialStub {
  readonly endpoints: KiroSocialEndpoints;
  readonly portalQueries: URLSearchParams[];
  readonly requests: Array<{
    path: string;
    body: Record<string, unknown>;
    userAgent: string | undefined;
  }>;
  exchangeAnswers: SocialAnswer[];
  refreshAnswers: SocialAnswer[];
  close(): Promise<void>;
}

const SOCIAL_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:123456789012:profile/SOCIALSTUB01';

export { SOCIAL_PROFILE_ARN };

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

export async function startSocialStub(): Promise<SocialStub> {
  const portalQueries: URLSearchParams[] = [];
  const requests: SocialStub['requests'] = [];
  const stub = {
    exchangeAnswers: [] as SocialAnswer[],
    refreshAnswers: [] as SocialAnswer[],
  };
  const portal = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://portal.test');
    if (url.pathname === '/signin') portalQueries.push(url.searchParams);
    response.writeHead(url.pathname === '/signin' ? 200 : 404, {
      'content-type': 'text/html',
    });
    response.end('<p>Kiro sign-in stand-in</p>');
  });
  const service = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
      const path = new URL(request.url ?? '/', 'http://service.test').pathname;
      requests.push({ path, body, userAgent: request.headers['user-agent'] });
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const reply = (answer: SocialAnswer | undefined) => {
        if (!answer) return send(500, { error: 'unscripted' });
        if ('status' in answer)
          return send(answer.status, {
            ...(answer.error ? { error: answer.error } : {}),
          });
        const delay = answer.delayMs ?? 0;
        setTimeout(
          () =>
            send(200, {
              accessToken: answer.accessToken,
              ...(answer.refreshToken
                ? { refreshToken: answer.refreshToken }
                : {}),
              expiresIn: answer.expiresIn ?? 3600,
              ...(answer.profileArn !== undefined
                ? { profileArn: answer.profileArn }
                : {}),
            }),
          delay,
        );
      };
      if (request.method === 'POST' && path === '/oauth/token') {
        // PKCE: the verifier must hash to the challenge the portal was given.
        const challenge = portalQueries.at(-1)?.get('code_challenge');
        const verifier = body.code_verifier;
        if (
          typeof verifier !== 'string' ||
          createHash('sha256').update(verifier).digest('base64url') !==
            challenge
        )
          return send(400, { error: 'invalid_grant' });
        return reply(stub.exchangeAnswers.shift());
      }
      if (request.method === 'POST' && path === '/refreshToken')
        return reply(stub.refreshAnswers.shift());
      send(404, {});
    });
  });
  const [portalUrl, serviceUrl] = await Promise.all([
    listen(portal),
    listen(service),
  ]);
  return Object.assign(stub, {
    endpoints: { portalUrl, serviceUrl },
    portalQueries,
    requests,
    close: async () => {
      portal.closeAllConnections();
      service.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => portal.close(resolve)),
        new Promise((resolve) => service.close(resolve)),
      ]);
    },
  });
}
