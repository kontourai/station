/**
 * Operator passkey enrollment on the HTTPS consent origin (#3257, S2b).
 *
 * Registered on the consent listener's app, never on the runtime app: a
 * WebAuthn credential is scoped to this origin's registrable domain, and the
 * consent origin is the one origin Station already holds apart from plugin
 * and app code.
 *
 * Every route here is refused outright unless `STATION_TRUSTED_CONSENT_ORIGIN`
 * is configured (D10: a Station reachable only by IP has no remote operator
 * sign-in). Every STATE-CHANGING route additionally requires, each
 * independently:
 *   - the Host header to be the configured origin's host;
 *   - an `Origin` header EXACTLY equal to the configured origin;
 *   - `Sec-Fetch-Site: same-origin`;
 *   - a JSON content type (a cross-site form cannot send one without a
 *     preflight, and this app answers no preflight);
 *   - a paired-device (or operator) cookie, which also BINDS the request: the
 *     request id alone cannot be replayed from another browser.
 *
 * The page's script is served from this same origin (`script-src 'self'`);
 * there is no inline script and no third-party code.
 */

import { randomUUID } from 'node:crypto';
import { sanitizeError } from '@kontourai/station-shared/redaction';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ConsentDecisionCredentialResolver } from '../../security/pairing-route-scopes.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import {
  type EnrollmentRequester,
  OPERATOR_BROWSER_LABEL,
  OperatorPasskeyEnrollmentError,
  type OperatorPasskeyEnrollmentService,
  publicEnrollmentMessage,
} from '../../services/identity/operator-passkey-enrollment.js';
import type { Logger } from '../../utils/logger.js';
import { parseDeviceSessionCookie } from '../bootstrap/runtime-http.js';
import { ENROLLMENT_PAGE_SCRIPT } from './operator-passkey-enrollment-script.js';

const OPERATOR_PASSKEY_ENROLL_PATH = '/operator/passkeys/enroll';

export interface OperatorPasskeyConsentDeps {
  readonly service: OperatorPasskeyEnrollmentService;
  readonly channel: ConsentChannelService;
  readonly credentials: ConsentDecisionCredentialResolver;
  readonly logger?: Logger;
}

const JSON_BODY_LIMIT = 32 * 1024;

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const PAGE_STYLE = `:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090e14;color:#e8edf4}*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:20px}main{width:min(560px,100%);border:1px solid #334155;border-radius:18px;background:#111923;padding:24px;box-shadow:0 24px 70px #0008}
.eyebrow{color:#5eead4;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:24px;margin:10px 0 8px}p{color:#aab7c7;line-height:1.55;margin:0 0 16px}
.code{font:700 40px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-align:center;padding:16px;border:1px dashed #5eead4;border-radius:12px;background:#17212e;margin:0 0 16px}
label{display:block;color:#9aa9ba;font-size:13px;margin:0 0 6px}input{width:100%;min-height:44px;border-radius:10px;border:1px solid #475569;background:#0d141c;color:#e8edf4;padding:0 12px;font:inherit;margin:0 0 16px}
button{min-height:44px;border-radius:10px;padding:0 18px;font:inherit;font-weight:650;cursor:pointer;border:1px solid #5eead4;background:#5eead4;color:#09211d;width:100%}button.secondary{background:#111923;color:#e8edf4;border-color:#475569;margin-top:10px}
[hidden]{display:none!important}.notice{border-left:3px solid #5eead4;padding:10px 12px;background:#5eead412;border-radius:6px;margin:0 0 16px}.error{border-left-color:#fb7185;background:#fb718512;color:#fecdd3}`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function enrollmentPage(
  rpId: string | null,
  unavailable: string | null,
): string {
  const body =
    unavailable !== null
      ? `<h1>Passkey setup is unavailable</h1><p>${escapeHtml(unavailable)}</p>`
      : `<h1>Set up an operator passkey</h1>
<p>A passkey lets you sign in as this Station's operator from this browser without pasting a credential. It is tied to <strong>${escapeHtml(rpId ?? '')}</strong>.</p>
<div id="intro">
<p>You will see a short code. Confirm it on the Station host with <code>station environment operator passkeys approve &lt;code&gt;</code>, then create the passkey here.</p>
<button id="start" type="button">Start</button>
</div>
<div id="waiting" hidden>
<p>Confirm this code on the Station host:</p>
<div class="code" id="code" aria-live="polite"></div>
<p id="waiting-note">Waiting for the host. The code expires after 5 minutes.</p>
</div>
<div id="create" hidden>
<div class="notice">The host confirmed the code.</div>
<label for="label">Name this passkey</label>
<input id="label" maxlength="64" autocomplete="off" placeholder="Primary, Backup key, Phone">
<button id="make" type="button">Create passkey</button>
</div>
<div id="done" hidden>
<div class="notice">Passkey saved.</div>
<p>Add a second passkey, such as a security key or another device, so losing one does not lock you out. Each passkey needs its own confirmation on the host.</p>
<button id="another" class="secondary" type="button">Add another passkey</button>
</div>
<div id="problem" class="notice error" role="alert" hidden></div>
<script src="${OPERATOR_PASSKEY_ENROLL_PATH}.js"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operator passkey</title><style>${PAGE_STYLE}</style></head><body><main><div class="eyebrow">Station operator</div>${body}</main></body></html>`;
}

export function registerOperatorPasskeyEnrollmentRoutes(
  app: Hono,
  deps: OperatorPasskeyConsentDeps,
): void {
  type Ctx = Context;
  const fail = (
    c: Ctx,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    error: string,
    message: string,
  ) => c.json({ error, message }, status);

  const unavailable = () => {
    const availability = deps.service.availability();
    return availability.available
      ? null
      : (availability.reason ?? 'Unavailable.');
  };

  /** The paired browser (or operator) making this request, or null. */
  const requester = (
    c: Ctx,
  ): {
    credential: string;
    deviceLabel: string;
    requester: EnrollmentRequester;
  } | null => {
    const credential = parseDeviceSessionCookie(c.req.header('cookie'));
    if (credential === undefined) return null;
    if (deps.credentials.verifyOperatorCredential(credential)) {
      return {
        credential,
        deviceLabel: OPERATOR_BROWSER_LABEL,
        requester: {
          kind: 'operator-credential',
          deviceId: 'operator',
          pairedAt: null,
          scope: '',
        },
      };
    }
    const device = deps.credentials.identifyDevice(credential);
    // A device without an id cannot be identified to the host: refuse rather
    // than invent one.
    if (device === null || typeof device.id !== 'string' || device.id === '') {
      return null;
    }
    return {
      credential,
      deviceLabel: device.name ?? 'Paired browser',
      requester: {
        kind: 'paired-device',
        deviceId: device.id,
        pairedAt: device.createdAt ?? null,
        scope: device.scope ?? '',
      },
    };
  };

  /** Shared gate for every JSON route. Returns a refusal or the requester. */
  const gate = (
    c: Ctx,
    options: { mutating: boolean },
  ): Response | NonNullable<ReturnType<typeof requester>> => {
    const reason = unavailable();
    if (reason !== null) return fail(c, 503, 'enrollment_unavailable', reason);
    const origin = deps.channel.trustedOrigin as string;
    if (c.req.header('host')?.toLowerCase() !== new URL(origin).host) {
      return fail(c, 403, 'origin_mismatch', 'Wrong host for passkey setup.');
    }
    if (options.mutating) {
      if (c.req.header('origin') !== origin) {
        return fail(
          c,
          403,
          'origin_mismatch',
          'Wrong origin for passkey setup.',
        );
      }
      if (c.req.header('sec-fetch-site') !== 'same-origin') {
        return fail(
          c,
          403,
          'fetch_metadata',
          'Passkey setup only runs from its own page.',
        );
      }
      if (
        !(c.req.header('content-type') ?? '').startsWith('application/json')
      ) {
        return fail(c, 400, 'invalid_request', 'Expected a JSON body.');
      }
    }
    const who = requester(c);
    if (who === null) {
      return fail(
        c,
        401,
        'authentication_required',
        'Open this page from a browser paired with this Station.',
      );
    }
    return who;
  };

  const limited = bodyLimit({
    maxSize: JSON_BODY_LIMIT,
    onError: (c) =>
      fail(c, 413, 'payload_too_large', 'The request body is too large.'),
  });

  const readJson = async (c: Ctx): Promise<Record<string, unknown> | null> => {
    const text = await c.req.text();
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const guarded = async (c: Ctx, work: () => Promise<Response> | Response) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OperatorPasskeyEnrollmentError) {
        const status =
          error.code === 'request_not_found'
            ? 404
            : error.code === 'too_many_requests'
              ? 429
              : error.code === 'enrollment_unavailable' ||
                  error.code === 'store_unavailable'
                ? 503
                : error.code === 'request_not_confirmed' ||
                    error.code === 'request_closed'
                  ? 409
                  : 400;
        return fail(c, status, error.code, publicEnrollmentMessage(error));
      }
      // Unexpected: keep the cause in the operator's log, give the browser a
      // fixed sentence and a correlation id to quote.
      const correlationId = randomUUID();
      deps.logger?.error('Operator passkey enrollment request failed', {
        correlationId,
        error: sanitizeError(error),
      });
      return c.json(
        {
          error: 'internal_error',
          message: 'The request could not be completed.',
          correlationId,
        },
        500,
      );
    }
  };

  app.get(OPERATOR_PASSKEY_ENROLL_PATH, (c) => {
    const reason = unavailable();
    const html = enrollmentPage(deps.service.rpId, reason);
    return c.html(html, reason === null ? 200 : 503, {
      'Content-Security-Policy': PAGE_CSP,
    });
  });

  app.get(`${OPERATOR_PASSKEY_ENROLL_PATH}.js`, (c) =>
    c.body(ENROLLMENT_PAGE_SCRIPT, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  );

  app.post(`${OPERATOR_PASSKEY_ENROLL_PATH}/requests`, limited, (c) =>
    guarded(c, () => {
      const who = gate(c, { mutating: true });
      if (who instanceof Response) return who;
      return c.json(deps.service.createRequest(who), 201);
    }),
  );

  app.get(`${OPERATOR_PASSKEY_ENROLL_PATH}/requests/:id`, (c) =>
    guarded(c, () => {
      const who = gate(c, { mutating: false });
      if (who instanceof Response) return who;
      return c.json(deps.service.status(c.req.param('id'), who.credential));
    }),
  );

  app.post(
    `${OPERATOR_PASSKEY_ENROLL_PATH}/requests/:id/options`,
    limited,
    (c) =>
      guarded(c, async () => {
        const who = gate(c, { mutating: true });
        if (who instanceof Response) return who;
        return c.json(
          await deps.service.beginRegistration(
            c.req.param('id'),
            who.credential,
          ),
        );
      }),
  );

  app.post(
    `${OPERATOR_PASSKEY_ENROLL_PATH}/requests/:id/verify`,
    limited,
    (c) =>
      guarded(c, async () => {
        const who = gate(c, { mutating: true });
        if (who instanceof Response) return who;
        const body = await readJson(c);
        const response = body?.response;
        if (
          response === null ||
          typeof response !== 'object' ||
          typeof (response as { id?: unknown }).id !== 'string' ||
          typeof (response as { response?: unknown }).response !== 'object' ||
          (response as { response?: unknown }).response === null
        ) {
          return fail(
            c,
            400,
            'invalid_request',
            'Expected a registration response.',
          );
        }
        const stored = await deps.service.finishRegistration(
          c.req.param('id'),
          who.credential,
          response as Parameters<
            OperatorPasskeyEnrollmentService['finishRegistration']
          >[2],
          body?.label,
        );
        return c.json({ passkey: stored }, 201);
      }),
  );
}
