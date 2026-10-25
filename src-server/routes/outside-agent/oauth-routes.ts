// UNWIRED(#4115): isolated non-distributable R3 composition; released runtime retains the compiled refusal until R6.
import { randomBytes } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  type OutsideOAuthExposure,
  outsideIngress,
  validateOutsideExposure,
} from '../../security/outside-agent-ingress.js';
import { canonicalOutsideOrigin } from '../../services/outside-agent/management-service.js';
import {
  DAY,
  MINUTE,
  OutsideOAuthRefusal,
  type Records,
} from '../../services/outside-agent/oauth-records.js';
import { nameLabel } from '../../services/outside-agent/oauth-registration.js';
import type { OutsideAgentGrantStore } from '../../services/outside-agent/oauth-store.js';
import { inspectServePort } from '../../services/tailscale/public-ingress-origin.js';
import { parseOutsideManagementJson } from './request-body.js';

const scopes = ['station-control:read', 'station-control:full'];
const cookieName = 'station-outside-browser';
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ]!,
  );
function unique(params: URLSearchParams): void {
  for (const name of params.keys())
    if (params.getAll(name).length !== 1)
      throw new OutsideOAuthRefusal('invalid_request');
}
function resource(params: URLSearchParams, expected: string): void {
  if (
    params.getAll('resource').length !== 1 ||
    params.get('resource') !== expected
  )
    throw new OutsideOAuthRefusal('invalid_target');
}
function ticket(c: Context): string {
  const matches = (c.req.header('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${cookieName}=`));
  return matches.length === 1 &&
    /^[A-Za-z0-9_-]{43}$/.test(matches[0]!.slice(cookieName.length + 1))
    ? matches[0]!.slice(cookieName.length + 1)
    : '';
}
function recovery(c: Context) {
  return c.html(
    '<!doctype html><meta charset="utf-8"><title>Sign in again</title><h1>Start a new sign-in</h1><p>This client ID is unknown or retired. Cancel the waiting login, log out, then log in again.</p><pre>claude mcp logout &lt;name&gt;\ncodex mcp logout &lt;name&gt;</pre><p>&lt;name&gt; is your configured MCP server name. Station cannot infer it from a client label.</p>',
    400,
  );
}
async function form(c: Context) {
  if (
    c.req.header('content-type')?.split(';')[0] !==
    'application/x-www-form-urlencoded'
  )
    throw new OutsideOAuthRefusal('invalid_request');
  const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
  if (body.status !== 'ok') throw new OutsideOAuthRefusal('invalid_request');
  if (/%(?![a-f\d]{2})/i.test(body.body))
    throw new OutsideOAuthRefusal('invalid_request');
  const params = new URLSearchParams(body.body);
  return params;
}
type ServeCheck = () => Promise<'clear' | 'mapped' | 'unverifiable'>;

/** Does not install a /mcp handler or any runtime auth exemption. */
export async function createOutsideAgentOAuthServer(input: {
  store: OutsideAgentGrantStore;
  validateGrant: (grant: Records['grant']) => boolean;
  exposure: OutsideOAuthExposure;
  checkServe?: ServeCheck;
}) {
  const { store, exposure } = input;
  const issuer = validateOutsideExposure(exposure);
  if (store.options.issuer !== issuer.origin)
    throw new Error('Outside OAuth store/issuer mismatch');
  const target = `${issuer.origin}/mcp`;
  const app = new Hono();
  const checkServe =
    input.checkServe ??
    (() =>
      inspectServePort(
        Number(issuer.port || (issuer.protocol === 'http:' ? 80 : 443)),
      ));
  let serveHealthy = true,
    sweepHealthy = true,
    closed = false;
  const available = () => serveHealthy && sweepHealthy;
  const waiters = new Map<string, Set<() => void>>();
  const wake = () => {
    for (const group of waiters.values())
      for (const listener of [...group]) listener();
  };
  const verifyServe = async () => {
    try {
      serveHealthy = (await checkServe()) === 'clear';
    } catch {
      serveHealthy = false;
    }
    if (!available()) wake();
  };
  if (issuer.protocol === 'http:') {
    await verifyServe();
    if (!available())
      throw new Error(
        'Outside OAuth loopback HTTP refused: Tailscale Serve maps this port or its status is unverifiable',
      );
  }
  const periodic = setInterval(() => {
    if (issuer.protocol === 'http:') void verifyServe();
    try {
      store.sweep();
      sweepHealthy = true;
    } catch {
      sweepHealthy = false;
      wake();
    }
  }, 30_000);
  periodic.unref();
  const unsubscribe = store.onRequestChange(wake);
  const peers = new WeakMap<Request, string | undefined>();
  const tokenAdmissions = new WeakMap<
    Request,
    { params: URLSearchParams; admitted: boolean }
  >();
  const endpoint =
    (handler: (c: Context) => Response | Promise<Response>, browser = false) =>
    async (c: Context) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      c.header('Referrer-Policy', 'no-referrer');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (closed || exposure.hosted || !available()) return c.notFound();
      const ingress = outsideIngress(c, exposure);
      if (!ingress) {
        if (
          issuer.protocol === 'http:' &&
          /^localhost(?::\d+)?$/.test(c.req.header('host') ?? '')
        )
          return c.json(
            {
              error: 'invalid_request',
              error_description: `Use the exact configured resource ${target}; localhost is not an issuer alias.`,
            },
            400,
          );
        return c.notFound();
      }
      if (c.req.method === 'HEAD') return c.body(null, 405);
      peers.set(c.req.raw, ingress.peerKey);
      try {
        // Charge cheap transport/global keys before even reading the stored CORS policy.
        if (c.req.method !== 'OPTIONS') {
          if (c.req.path === '/oauth/register' && !budgets(c, 'register'))
            limited();
          if (c.req.path === '/oauth/authorize' && !budgets(c, 'authorize'))
            limited();
          if (c.req.path === '/oauth/token') {
            const params = await form(c);
            tokenAdmissions.set(c.req.raw, {
              params,
              admitted: budgets(
                c,
                params.get('grant_type') === 'refresh_token'
                  ? 'refresh'
                  : 'code',
              ),
            });
          }
        }
        const origin = c.req.header('origin');
        if (browser) {
          if (
            c.req.header('sec-fetch-site') !== 'same-origin' ||
            (origin !== undefined && origin !== issuer.origin) ||
            (c.req.method === 'POST' && origin !== issuer.origin)
          )
            return c.json({ error: 'invalid_request' }, 403);
        } else if (origin !== undefined) {
          let canonical: string;
          try {
            canonical = canonicalOutsideOrigin(origin).serializedOrigin;
          } catch {
            return c.json({ error: 'untrusted_origin' }, 403);
          }
          if (!store.policy('cors').origins.includes(canonical))
            return c.json({ error: 'untrusted_origin' }, 403);
          c.header('Access-Control-Allow-Origin', origin);
          c.header('Vary', 'Origin');
        }
        return await handler(c);
      } catch (error) {
        if (error instanceof OutsideOAuthRefusal) {
          const limited =
            error.code === 'capacity' || error.code === 'audit_capacity';
          if (limited) c.header('Retry-After', '60');
          return c.json(
            {
              error: limited ? 'temporarily_unavailable' : error.code,
              error_description:
                error.code === 'invalid_grant'
                  ? 'Grant unavailable or ending; sign in again with a new operator review.'
                  : error.code,
            },
            limited ? 429 : 400,
          );
        }
        if (error instanceof SyntaxError)
          return c.json({ error: 'invalid_request' }, 400);
        return c.json({ error: 'temporarily_unavailable' }, 503);
      }
    };
  const metadata = endpoint((c) =>
    c.json({
      resource: target,
      authorization_servers: [issuer.origin],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    }),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);
  app.get('/.well-known/oauth-protected-resource', metadata);
  app.get(
    '/.well-known/oauth-authorization-server',
    endpoint((c) =>
      c.json({
        issuer: issuer.origin,
        authorization_endpoint: `${issuer.origin}/oauth/authorize`,
        token_endpoint: `${issuer.origin}/oauth/token`,
        registration_endpoint: `${issuer.origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: scopes,
        authorization_response_iss_parameter_supported: true,
      }),
    ),
  );
  const budgets = (
    c: Context,
    kind: 'register' | 'authorize' | 'code' | 'refresh',
  ) => {
    const peer = peers.get(c.req.raw);
    const global = { register: 30, authorize: 30, code: 60, refresh: 120 }[
      kind
    ];
    const entries: {
      key: string;
      capacity: number;
      period: number;
      refill?: boolean;
    }[] = [{ key: `${kind}:global`, capacity: global, period: MINUTE }];
    if (kind === 'register') {
      entries.push({
        key: 'register:global:day',
        capacity: 500,
        period: DAY,
        refill: false,
      });
      if (peer)
        entries.push(
          { key: `register:peer:${peer}`, capacity: 5, period: MINUTE },
          {
            key: `register:peer:day:${peer}`,
            capacity: 50,
            period: DAY,
            refill: false,
          },
        );
    } else {
      if (peer)
        entries.push({
          key: `${kind}:peer:${peer}`,
          capacity: kind === 'refresh' ? 60 : 10,
          period: MINUTE,
        });
    }
    return store.chargeBudgets(entries);
  };
  const limited = () => {
    throw new OutsideOAuthRefusal('capacity');
  };
  app.post(
    '/oauth/register',
    endpoint(async (c) => {
      if (c.req.header('content-type')?.split(';')[0] !== 'application/json')
        throw new OutsideOAuthRefusal('invalid_request');
      const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
      if (body.status !== 'ok')
        throw new OutsideOAuthRefusal('invalid_request');
      const client = store.register(parseOutsideManagementJson(body.body));
      return c.json(
        {
          ...client.metadata,
          client_id: client.id,
          client_id_issued_at: Math.floor(client.createdAt / 1000),
        },
        201,
      );
    }),
  );
  app.get(
    '/oauth/authorize',
    endpoint((c) => {
      const params = new URL(c.req.url).searchParams;
      if (Buffer.byteLength(new URL(c.req.url).search) > 16 * 1024)
        throw new OutsideOAuthRefusal('invalid_request');
      if (params.getAll('resource').length > 1)
        throw new OutsideOAuthRefusal('invalid_target');
      unique(params);
      const client = store.client(params.get('client_id') ?? '');
      if (
        client &&
        !store.chargeBudgets([
          {
            key: `authorize:client:${client.id}`,
            capacity: 10,
            period: MINUTE,
          },
        ])
      )
        limited();
      if (!client) return recovery(c);
      resource(params, target);
      if (
        params.get('response_type') !== 'code' ||
        params.get('code_challenge_method') !== 'S256'
      )
        throw new OutsideOAuthRefusal('invalid_request');
      const flow = store.start({
        clientId: client.id,
        redirectUri: params.get('redirect_uri') ?? '',
        resource: target,
        state: params.get('state') ?? '',
        challenge: params.get('code_challenge') ?? '',
        ...(params.has('scope')
          ? { scopes: params.get('scope')!.split(' ') }
          : {}),
        ...(ticket(c) ? { ticket: ticket(c) } : {}),
        peer: peers.get(c.req.raw),
      });
      c.header(
        'Set-Cookie',
        `${cookieName}=${flow.ticket}; Path=/oauth/authorize; HttpOnly; SameSite=Strict; Max-Age=1800${issuer.protocol === 'https:' ? '; Secure' : ''}`,
      );
      // no-referrer makes a form-navigation Origin null; preserve O without disclosing OAuth query values.
      c.header('Referrer-Policy', 'origin');
      const scriptNonce = randomBytes(24).toString('base64url');
      c.header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action http: https:; frame-ancestors 'none'; base-uri 'none'`,
      );
      const callback = new URL(flow.request.redirectUri);
      const remote =
        callback.protocol === 'https:'
          ? `<p>sends access to ${escapeHtml(callback.origin)}, a remote site</p>`
          : '';
      return c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Station client sign-in</title><h1>Compare this code with the host</h1><p id="code">${flow.comparisonCode}</p><p>Unverified client: ${escapeHtml(nameLabel(client.metadata.client_name ?? ''))}</p><p>Client ID: ${escapeHtml(client.id)}</p><p>Callback: ${escapeHtml(flow.request.redirectUri)}</p>${remote}<p>Resource: ${escapeHtml(target)}</p><p>Requested: ${escapeHtml(flow.request.scopes.join(' '))}. Review starts with read-only access.</p><p>Expires in ten minutes. Ask the host operator to list pending outside clients and approve this request ID after comparing details: ${flow.request.id}</p><p id="status">Waiting for operator approval. Opening this page grants no access.</p><form method="post" action="/oauth/authorize/complete"><input type="hidden" name="request_id" value="${flow.request.id}"><input type="hidden" name="nonce" value="${flow.nonce}"></form><script nonce="${scriptNonce}">(async()=>{try{for(;;){const response=await fetch('/oauth/authorize/status?request_id=${flow.request.id}',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error();const result=await response.json();if(result.status==='approved-awaiting-exchange'||result.status==='denied'){document.querySelector('form').submit();return;}if(result.status!=='pending'){document.getElementById('status').textContent='This request ended. Start a new login.';return;}}}catch{document.getElementById('status').textContent='Sign-in unavailable. Start a new login.';}})();</script>`,
      );
    }),
  );
  app.get(
    '/oauth/authorize/status',
    endpoint(async (c) => {
      const params = new URL(c.req.url).searchParams;
      unique(params);
      const id = params.get('request_id') ?? '',
        browserTicket = ticket(c);
      const request = store.browserRequest(id, browserTicket);
      if (!request) return c.notFound();
      if (request.state === 'pending') {
        const group = waiters.get(id) ?? new Set<() => void>();
        if (group.size >= 2) limited();
        waiters.set(id, group);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            c.req.raw.signal.removeEventListener('abort', finish);
            group.delete(changed);
            if (!group.size) waiters.delete(id);
            resolve();
          };
          const changed = () => {
            if (
              !available() ||
              closed ||
              store.browserRequest(id, browserTicket)?.state !== 'pending'
            )
              finish();
          };
          const timeout = setTimeout(
            finish,
            Math.min(
              25_000,
              Math.max(
                1,
                request.expiresAt - (store.options.now ?? Date.now)(),
              ),
            ),
          );
          group.add(changed);
          c.req.raw.signal.addEventListener('abort', finish, { once: true });
          if (c.req.raw.signal.aborted) finish();
          else changed();
        });
      }
      if (!available() || closed) return c.notFound();
      const current = store.browserRequest(id, browserTicket);
      if (!current) return c.notFound();
      return c.json({
        status:
          current.state === 'approved' || current.state === 'coded'
            ? 'approved-awaiting-exchange'
            : current.state,
      });
    }, true),
  );
  app.post(
    '/oauth/authorize/complete',
    endpoint(async (c) => {
      const params = await form(c);
      unique(params);
      const id = params.get('request_id') ?? '',
        browserTicket = ticket(c);
      const request = store.browserRequest(id, browserTicket);
      if (!request) return c.notFound();
      const nonce = params.get('nonce') ?? '';
      const denial = request.state === 'denied';
      const result = denial
        ? store.completeDenial(id, browserTicket, nonce)
        : store.complete(id, browserTicket, nonce);
      const response = new URLSearchParams({
        state: result.state,
        iss: issuer.origin,
      });
      if ('code' in result && typeof result.code === 'string')
        response.set('code', result.code);
      else response.set('error', 'access_denied');
      return c.redirect(
        `${result.redirectUri}${result.redirectUri.includes('?') ? '&' : '?'}${response}`,
        303,
      );
    }, true),
  );
  app.post(
    '/oauth/token',
    endpoint(async (c) => {
      const admission = tokenAdmissions.get(c.req.raw)!;
      const { params } = admission;
      const grantType = params.get('grant_type');
      const clientId =
        params.getAll('client_id').length === 1 ? params.get('client_id')! : '';
      const kind = grantType === 'refresh_token' ? 'refresh' : 'code';
      let admitted = admission.admitted;
      const refreshToken = params.get('refresh_token') ?? '';
      if (admitted) {
        const client = store.client(clientId);
        if (!client) throw new OutsideOAuthRefusal('invalid_grant');
        const familyId =
          kind === 'refresh'
            ? store.refreshFamily(refreshToken, clientId, target)
            : undefined;
        admitted = store.chargeBudgets([
          {
            key: `${kind}:client:${client.id}`,
            capacity: kind === 'refresh' ? 30 : 10,
            period: MINUTE,
          },
          ...(familyId
            ? [
                {
                  key: `refresh:family:${familyId}`,
                  capacity: 3,
                  period: MINUTE / 2,
                },
              ]
            : []),
        ]);
      }
      resource(params, target);
      unique(params);
      if (
        c.req.header('authorization') !== undefined ||
        params.has('client_secret')
      )
        throw new OutsideOAuthRefusal('invalid_client');
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
        return c.json({ error: 'unsupported_grant_type' }, 400);
      const tokens =
        grantType === 'authorization_code'
          ? store.exchange({
              code: params.get('code') ?? '',
              clientId,
              resource: target,
              redirectUri: params.get('redirect_uri') ?? '',
              verifier: params.get('code_verifier') ?? '',
              admitted,
            })
          : store.rotate({
              refreshToken,
              clientId,
              resource: target,
              admitted,
              validateGrant: input.validateGrant,
            });
      return c.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(' '),
      });
    }),
  );
  const preflight = endpoint((c) => {
    if (
      !c.req.header('origin') ||
      c.req.header('access-control-request-method') !== 'POST' ||
      (c.req.header('access-control-request-headers') ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .some((s) => s && s !== 'content-type')
    )
      return c.json({ error: 'invalid_request' }, 403);
    c.header('Access-Control-Allow-Methods', 'POST');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    return c.body(null, 204);
  });
  app.options('/oauth/register', preflight);
  app.options('/oauth/token', preflight);
  return {
    app,
    close: () => {
      closed = true;
      clearInterval(periodic);
      unsubscribe();
      wake();
    },
  };
}
