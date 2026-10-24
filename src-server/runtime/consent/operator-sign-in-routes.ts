import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ConsentDecisionCredentialResolver } from '../../security/pairing-route-scopes.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import {
  OPERATOR_SESSION_ABSOLUTE_MS,
  OPERATOR_SESSION_COOKIE,
  type OperatorSessionService,
  OperatorSignInError,
  parseOperatorSessionCookie,
} from '../../services/identity/operator-sessions.js';
import type { Logger } from '../../utils/logger.js';
import { parseDeviceSessionCookie } from '../bootstrap/runtime-http.js';

const SCRIPT = `
const button = document.querySelector('button');
const status = document.querySelector('[role="status"]');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
async function api(path, body) {
  const response = await fetch(path, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const json = await response.json();
  if (!response.ok) throw new Error(json.message || 'Sign-in failed. Reopen this page to try again.');
  return json;
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    if (button.dataset.action === 'sign-out') {
      await api('/operator/sign-out', {nonce:button.dataset.nonce});
      status.textContent = 'Signed out. You can close this page.';
      return;
    }
    const {options, ceremonyId} = await api('/operator/sign-in/options', {nonce:button.dataset.nonce});
    options.challenge = decode(options.challenge);
    options.allowCredentials = options.allowCredentials.map(item => ({...item, id:decode(item.id)}));
    const credential = await navigator.credentials.get({publicKey: options});
    if (!credential) throw new Error('The passkey prompt was cancelled.');
    const response = {id:credential.id, rawId:encode(credential.rawId), type:credential.type, clientExtensionResults:credential.getClientExtensionResults(), response:{authenticatorData:encode(credential.response.authenticatorData), clientDataJSON:encode(credential.response.clientDataJSON), signature:encode(credential.response.signature), userHandle:credential.response.userHandle ? encode(credential.response.userHandle) : null}};
    await api('/operator/sign-in/complete', {ceremonyId, response});
    status.textContent = 'Signed in. Return to Paired devices in Station. This session ends after 15 minutes idle or 12 hours.';
  } catch (error) { status.textContent = error.message + ' Reopen this page to try again.'; }
});`;

const STYLE = `:root{color-scheme:dark light;--k-bg:#0a0e13;--k-panel:#111824;--k-text:#eef3f8;--k-text-muted:#aebccb;--k-action:#5ce0c6;--k-action-contrast:#06080b;--k-line:rgba(150,180,210,.12);--k-radius:12px;--k-space:16px;font-family:system-ui,sans-serif;background:var(--k-bg);color:var(--k-text)}
@media(prefers-color-scheme:light){:root{--k-bg:#f5f4ef;--k-panel:#fff;--k-text:#202124;--k-text-muted:#5b626b;--k-action:#0e7c64;--k-action-contrast:#fff;--k-line:rgba(36,40,46,.12)}}
*{box-sizing:border-box}body{margin:0;padding:var(--k-space)}main{max-width:560px;margin:48px auto;padding:24px;border:1px solid var(--k-line);border-radius:var(--k-radius);background:var(--k-panel)}h1{font-size:24px}p{line-height:1.6;color:var(--k-text-muted)}button{font:inherit;min-height:44px;padding:12px 20px;border:0;border-radius:var(--k-radius);background:var(--k-action);color:var(--k-action-contrast);cursor:pointer}button:focus-visible{outline:3px solid var(--k-action);outline-offset:4px}button:disabled{opacity:.6;cursor:default}`;

export function registerOperatorSignInRoutes(
  app: Hono,
  deps: {
    service: OperatorSessionService;
    credentials: ConsentDecisionCredentialResolver;
    channel: ConsentChannelService;
    logger?: Logger;
  },
): void {
  const credential = (c: Context) =>
    parseDeviceSessionCookie(
      c.req.header('cookie'),
      (candidate) => deps.credentials.identifyDevice(candidate) !== null,
    );
  const gate = (c: Context, unsafe: boolean): string | Response => {
    if (!deps.service.signInUrl)
      return c.json({ error: 'sign_in_unavailable' }, 503);
    const origin = deps.channel.trustedOrigin!;
    if (
      c.req.header('host') !== new URL(origin).host ||
      (unsafe &&
        (c.req.header('origin') !== origin ||
          c.req.header('sec-fetch-site') !== 'same-origin'))
    )
      return c.json({ error: 'origin_mismatch' }, 403);
    if (
      unsafe &&
      c.req.header('content-type')?.split(';')[0].trim() !== 'application/json'
    )
      return c.json({ error: 'invalid_request' }, 400);
    const who = credential(c);
    return who ?? c.json({ error: 'operator_session_required' }, 401);
  };
  const guarded = async (
    c: Context,
    action: () => Response | Promise<Response>,
  ) => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof OperatorSignInError)
        return c.json(
          {
            error: error.code,
            message:
              'Operator sign-in could not be completed. Reopen this page to try again.',
          },
          error.code === 'rate_limited'
            ? 429
            : error.code === 'sign_in_unavailable'
              ? 503
              : 401,
        );
      const correlationId = randomUUID();
      deps.logger?.error('Operator sign-in request failed', {
        correlationId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return c.json({ error: 'internal_error', correlationId }, 500);
    }
  };
  const limited = bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  for (const path of ['/operator/sign-in', '/operator/sign-out']) {
    app.get(path, (c) =>
      guarded(c, () => {
        const who = gate(c, false);
        if (who instanceof Response) return who;
        if (
          c.req.header('sec-fetch-mode') !== 'navigate' ||
          c.req.header('sec-fetch-dest') !== 'document' ||
          !['same-origin', 'same-site', 'none'].includes(
            c.req.header('sec-fetch-site') ?? '',
          )
        )
          return c.json({ error: 'navigation_required' }, 403);
        const nonce = deps.service.renderNonce(who);
        const scriptNonce = randomUUID();
        const signOut = path === '/operator/sign-out';
        return c.html(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Station operator</title><style>${STYLE}</style></head><body><main><h1>${signOut ? 'Sign out as operator' : 'Sign in as operator'}</h1><p>${signOut ? 'End the operator session in this browser.' : 'Use your operator passkey to view this Station’s paired devices. Each access change requires a separate passkey confirmation.'}</p><button data-action="${signOut ? 'sign-out' : 'sign-in'}" data-nonce="${nonce}">${signOut ? 'Sign out' : 'Sign in with passkey'}</button><p role="status" aria-live="polite"></p></main><script type="module" nonce="${scriptNonce}">${SCRIPT}</script></body></html>`,
          200,
          {
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
            'Cache-Control': 'no-store',
          },
        );
      }),
    );
  }
  app.post('/operator/sign-in/options', limited, (c) =>
    guarded(c, async () => {
      const who = gate(c, true);
      if (who instanceof Response) return who;
      const body = await c.req.json().catch(() => null);
      if (typeof body?.nonce !== 'string')
        return c.json({ error: 'invalid_request' }, 400);
      return c.json(await deps.service.options(body.nonce, who));
    }),
  );
  app.post('/operator/sign-in/complete', limited, (c) =>
    guarded(c, async () => {
      const who = gate(c, true);
      if (who instanceof Response) return who;
      const body = await c.req.json().catch(() => null);
      if (
        typeof body?.ceremonyId !== 'string' ||
        typeof body?.response?.id !== 'string' ||
        !body.response.response
      )
        return c.json({ error: 'invalid_request' }, 400);
      const result = await deps.service.complete(
        body.ceremonyId,
        who,
        body.response,
      );
      c.header(
        'Set-Cookie',
        `${OPERATOR_SESSION_COOKIE}=${result.secret}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${OPERATOR_SESSION_ABSOLUTE_MS / 1000}`,
      );
      return c.json({ signedIn: true, expiresAt: result.session.expiresAt });
    }),
  );
  app.post('/operator/sign-out', limited, (c) =>
    guarded(c, async () => {
      const who = gate(c, true);
      if (who instanceof Response) return who;
      const body = await c.req.json().catch(() => null);
      if (typeof body?.nonce !== 'string')
        return c.json({ error: 'invalid_request' }, 400);
      // Consume a render nonce under the same binding and origin gates as sign-in.
      deps.service.consumeSignOutNonce(body.nonce, who);
      const secret = parseOperatorSessionCookie(c.req.header('cookie'));
      c.header(
        'Set-Cookie',
        `${OPERATOR_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      if (secret) deps.service.signOut(secret, who);
      return c.json({ signedOut: true });
    }),
  );
}
