/**
 * A local stand-in for AWS SSO-OIDC and the Kiro control plane, speaking the
 * same JSON the real endpoints do (kirocrew auth/login/builder_id.py,
 * auth/refresh.py, auth/login/control_plane.py). Each test scripts what the
 * token endpoint answers, in order.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KiroOidcEndpoints } from '../../kiro-oidc/oidc.js';

export type TokenAnswer =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'invalid_grant'
  | {
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
      /** Delay before answering, ms. */
      delayMs?: number;
    };

export interface OidcStub {
  readonly origin: string;
  readonly endpoints: KiroOidcEndpoints;
  /** Requests by path, with the parsed JSON body. */
  readonly requests: Array<{ path: string; body: Record<string, unknown> }>;
  deviceAnswers: TokenAnswer[];
  refreshAnswers: TokenAnswer[];
  profiles: string[];
  close(): Promise<void>;
}

export async function startOidcStub(): Promise<OidcStub> {
  const stub = {
    requests: [] as Array<{ path: string; body: Record<string, unknown> }>,
    deviceAnswers: [] as TokenAnswer[],
    refreshAnswers: [] as TokenAnswer[],
    profiles: [] as string[],
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      stub.requests.push({ path, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (path.endsWith('/client/register'))
        return send(200, {
          clientId: 'stub-client-id',
          clientSecret: 'stub-client-secret',
          clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 90 * 86400,
        });
      if (path.endsWith('/device_authorization'))
        return send(200, {
          deviceCode: 'stub-device-code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
          verificationUriComplete:
            'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
          expiresIn: 600,
          interval: 1,
        });
      if (path.endsWith('/token')) {
        const queue =
          body.grantType === 'refresh_token'
            ? stub.refreshAnswers
            : stub.deviceAnswers;
        const answer = queue.shift() ?? 'authorization_pending';
        if (typeof answer === 'string')
          return send(400, { error: answer, error_description: 'stub' });
        if (answer.delayMs)
          await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        return send(200, {
          accessToken: answer.accessToken,
          ...(answer.refreshToken ? { refreshToken: answer.refreshToken } : {}),
          expiresIn: answer.expiresIn ?? 3600,
          tokenType: 'Bearer',
        });
      }
      if (path.startsWith('/cps'))
        return send(200, {
          profiles: stub.profiles.map((arn) => ({ arn, profileName: 'p' })),
        });
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return Object.assign(stub, {
    origin,
    endpoints: {
      oidcUrl: (region: string) => `${origin}/oidc/${region}`,
      controlPlaneUrls: () => [`${origin}/cps/`],
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
