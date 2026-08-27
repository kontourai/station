/**
 * The distinct-origin consent listener (station#3677).
 *
 * A MINIMAL, separate Hono app bound on its own first-class port — never the
 * full runtime app, which would duplicate Station's entire attack surface on
 * a second origin. It serves exactly two things:
 *
 *   GET  /consent/:id         — the script-free review page (mints the
 *                               one-use render nonce; requires a top-level
 *                               document navigation and is render-budgeted,
 *                               because each render replaces the nonce —
 *                               review MED 3)
 *   POST /consent/:id/decide  — the decision, refused unless EVERY proof
 *                               holds (see below)
 *
 * Why a second origin: same-origin plugin code can script any consent page
 * served from the app's own origin — rewrite it after opening it, or POST
 * the approval inside its own click's user activation. Sec-Fetch headers
 * prove a navigation happened under activation, NOT that the user reviewed
 * anything. A distinct port is a real browser origin boundary (the same
 * model the MCP Apps frame proxy relies on), and the one-use nonce minted at
 * render is what proves the decision came FROM the review page.
 *
 * The decide POST requires ALL of, each independently refusing:
 *  1. a Host header whose port is the consent port (the origin comparison's
 *     integrity anchor);
 *  2. an `Origin` header EXACTLY equal to the consent origin — a cross-origin
 *     form or fetch from the app origin carries the app origin here and is
 *     refused;
 *  3. expected Fetch Metadata (`Sec-Fetch-Site: same-origin`,
 *     `Sec-Fetch-Mode: navigate`, `Sec-Fetch-User: ?1`) — a script-shaped
 *     POST carries none of these;
 *  4. an authenticated consent session: the device-session cookie proving
 *     the operator or a consent:decide-promoted device
 *     ({@link consentDecisionAuthority}), or the transaction-bound
 *     `station-consent` session cookie;
 *  5. the one-use render nonce, consumed atomically;
 *  6. a still-pending transaction whose target revalidates unchanged.
 *
 * NO CORS anywhere on this app: it answers navigation GETs and same-origin
 * form POSTs only. The consent origin must never be added to the main API's
 * ALLOWED_ORIGINS — that would make consent pages trusted callers of the
 * whole API.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  assertConsentListenerRouteCoverage,
  type ConsentDecisionCredentialResolver,
  consentDecisionAuthority,
} from '../../security/pairing-route-scopes.js';
import {
  CONSENT_SESSION_COOKIE,
  type ConsentChannelService,
} from '../../services/consent/consent-channel.js';
import type {
  ConsentDecision,
  ConsentDecisionAuthority,
  ConsentTransactionView,
} from '../../services/consent/consent-transactions.js';
import { consentDecisionOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { sanitizedTransportError } from '../../utils/outward-error.js';
import { parseDeviceSessionCookie } from '../bootstrap/runtime-http.js';

const CONSENT_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  // station#3752: NOT `no-referrer`. Chromium computes a form submission's
  // Origin under the document's referrer policy, so `no-referrer` made every
  // genuine approve click arrive as `Origin: null` — the page defeating the
  // exact-Origin check on its own decide route, which is why no plugin could
  // be granted trusted access in Chrome at all. `same-origin` keeps the
  // transaction id from leaving this origin (cross-origin requests still get
  // no Referer, and the page loads no subresources: `default-src 'none'`)
  // while letting the browser send a real Origin, so the exact-match proof
  // survives instead of collapsing onto Fetch Metadata alone.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
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

const PAGE_STYLE = `:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090e14;color:#e8edf4}*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:20px}main{width:min(560px,100%);border:1px solid #334155;border-radius:18px;background:#111923;padding:24px;box-shadow:0 24px 70px #0008}
.eyebrow{color:#5eead4;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:24px;margin:10px 0 8px}p{color:#aab7c7;line-height:1.55;margin:0 0 18px}
ul{list-style:none;margin:0 0 22px;padding:0;display:grid;gap:10px}li{display:grid;gap:3px;padding:13px 14px;border:1px solid #3f4c5f;border-radius:12px;background:#17212e}li span{font-size:13px;color:#9aa9ba}
.warning{border-left:3px solid #fb7185;padding:10px 12px;background:#fb718512;color:#fecdd3;border-radius:6px;margin-bottom:22px}.actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
button{min-height:44px;border-radius:10px;padding:0 18px;font:inherit;font-weight:650;cursor:pointer}.deny{border:1px solid #475569;background:#111923;color:#e8edf4}.approve{border:1px solid #5eead4;background:#5eead4;color:#09211d}
@media(max-width:480px){main{padding:20px}.actions{display:grid;grid-template-columns:1fr}.actions form,.actions button{width:100%}}`;

function statusPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main><div class="eyebrow">Station consent</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>You can close this page and return to Station.</p></main></body></html>`;
}

/**
 * The review page. Rendered STRICTLY from the transaction's canonical
 * description — text derived from the transaction, nothing else — with the
 * one-use nonce embedded as a hidden form field. Script-free by construction
 * and by CSP.
 */
function reviewPage(
  transaction: ConsentTransactionView,
  nonce: string,
): string {
  const description = transaction.description;
  const items = description.items
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></li>`,
    )
    .join('');
  const warning = description.warning
    ? `<div class="warning">${escapeHtml(description.warning)}</div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(description.title)}</title>
<style>${PAGE_STYLE}</style></head><body><main><div class="eyebrow">Station consent</div>
<h1>${escapeHtml(description.title)}</h1>
<p>${escapeHtml(description.summary)}</p>
<ul>${items}</ul>${warning}
<form method="post" action="./${encodeURIComponent(transaction.id)}/decide" class="actions">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button class="deny" type="submit" name="decision" value="deny">${escapeHtml(description.denyLabel)}</button>
<button class="approve" type="submit" name="decision" value="approve">${escapeHtml(description.approveLabel)}</button>
</form>
</main></body></html>`;
}

export interface ConsentListenerDeps {
  channel: ConsentChannelService;
  credentials: ConsentDecisionCredentialResolver;
  logger?: Logger;
}

function parseConsentSessionCookie(
  value: string | undefined,
): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  const matches: string[] = [];
  for (const segment of value.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== CONSENT_SESSION_COOKIE) continue;
    const candidate = segment.slice(separator + 1).trim();
    if (!CONSENT_SESSION_PATTERN.test(candidate)) return undefined;
    matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

type ListenerAuthority = ConsentDecisionAuthority;

/**
 * Resolves the caller's decision authority for one transaction, or null.
 * Device-session credential first (operator identity or a consent:decide
 * promotion); the transaction-bound consent session second.
 */
function resolveListenerAuthority(
  deps: ConsentListenerDeps,
  cookieHeader: string | undefined,
  transactionId: string,
): ListenerAuthority | null {
  const deviceCredential = parseDeviceSessionCookie(cookieHeader);
  if (deviceCredential !== undefined) {
    const authority = consentDecisionAuthority(
      deps.credentials,
      deviceCredential,
    );
    if (authority !== null) return authority;
  }
  const sessionSecret = parseConsentSessionCookie(cookieHeader);
  if (
    sessionSecret !== undefined &&
    deps.channel.store.verifyDecisionSession(
      deps.channel.tenantId,
      transactionId,
      sessionSecret,
    )
  ) {
    return 'consent-session';
  }
  return null;
}

/**
 * The consent origin as proven by this request's own Host header, or null
 * when the Host is unusable or names a different port than the one this
 * listener was configured with. The hostname is deliberately the
 * request-visible one (decision 4) — only the PORT is pinned.
 */
function requestConsentOrigin(
  hostHeader: string | undefined,
  consentPort: number,
): string | null {
  if (!hostHeader) return null;
  let url: URL;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }
  const port = url.port === '' ? '80' : url.port;
  if (port !== String(consentPort)) return null;
  return url.origin;
}

export function createConsentApp(deps: ConsentListenerDeps): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(name, value);
    }
  });

  app.get('/consent/:id', (c) => {
    const id = c.req.param('id');
    // Review MED 3: rendering is a WRITE — it replaces the one-use nonce and
    // appends audit — and the transaction cookie's site (not origin) scoping
    // means same-site plugin code can fire credentialed cross-origin GETs
    // whose responses it cannot read but whose side effects still run. Only
    // a top-level document navigation may render: a fetch/XHR/iframe-shaped
    // GET is refused BEFORE any store access, so it can neither invalidate
    // the nonce on the user's open review page nor grow the audit trail.
    if (
      c.req.header('sec-fetch-mode') !== 'navigate' ||
      c.req.header('sec-fetch-dest') !== 'document'
    ) {
      consentDecisionOps.add(1, {
        result: 'refused',
        reason: 'review_fetch_metadata',
      });
      return c.html(
        statusPage(
          'Open this page directly',
          'The consent review only renders as a normal browser page navigation.',
        ),
        403,
      );
    }
    const authority = resolveListenerAuthority(
      deps,
      c.req.header('cookie'),
      id,
    );
    if (authority === null) {
      // No transaction detail leaks to an unauthenticated caller — not even
      // whether the id exists.
      return c.html(
        statusPage(
          'Sign in to Station first',
          'This review page can only be opened by the Station operator, a device promoted to decide consent, or the Station page that requested it.',
        ),
        403,
      );
    }
    const rendered = deps.channel.store.renderReview(deps.channel.tenantId, id);
    if (!rendered.ok) {
      if (rendered.reason === 'not_found') {
        return c.html(
          statusPage(
            'Request not found',
            'This consent link is no longer valid.',
          ),
          404,
        );
      }
      if (rendered.reason === 'render_limited') {
        // Review MED 3: the per-transaction render budget is exhausted. The
        // most recently minted nonce is still valid, so an already-open
        // review page can still decide; otherwise the request must be
        // re-opened.
        return c.html(
          statusPage(
            'Too many review opens',
            'This request was opened too many times and will not render again. Decide on the already-open review page, or open a new request.',
          ),
          429,
        );
      }
      return c.html(
        statusPage(
          'Request already decided',
          `This request is ${rendered.status ?? 'closed'}.`,
        ),
      );
    }
    return c.html(reviewPage(rendered.transaction, rendered.nonce));
  });

  app.post('/consent/:id/decide', async (c) => {
    const id = c.req.param('id');
    const state = deps.channel.state();
    const consentPort = state.status === 'listening' ? state.port : null;
    const refuse = (reason: string, title: string, detail: string) => {
      consentDecisionOps.add(1, { result: 'refused', reason });
      deps.logger?.warn('Consent decision refused', { id, reason });
      return c.html(statusPage(title, detail), 403);
    };

    // 1+2: exact Origin === the consent origin derived from this request's
    // Host (port-pinned). Both header absences refuse.
    const expectedOrigin =
      consentPort === null
        ? null
        : requestConsentOrigin(c.req.header('host'), consentPort);
    if (expectedOrigin === null) {
      return refuse(
        'origin_unresolvable',
        'Decision refused',
        'This request did not arrive at the consent listener the way a review page submission does.',
      );
    }
    // Review LOW 6: the Origin header is matched EXACTLY, never parsed and
    // re-serialized. A real browser sends the canonical serialization; any
    // value that would only match after canonicalization (trailing slash,
    // uppercase scheme, default port spelled out) did not come from a
    // browser's Origin header and is refused.
    //
    // station#3752: `null` stays REFUSED here, and the page's own
    // `Referrer-Policy` was fixed instead (see SECURITY_HEADERS). Admitting
    // `null` was this fix's first shape; independent review was right that
    // it deletes a proof rather than restoring one — it makes Fetch Metadata
    // alone load-bearing, and while script cannot set those headers, script
    // CAN induce a browser to generate a user-activated navigation. Keeping
    // both means an attacker must defeat two independent browser guarantees.
    const origin = c.req.header('origin');
    if (origin === undefined || origin !== expectedOrigin) {
      return refuse(
        'origin_mismatch',
        'Decision refused',
        'Decisions are only accepted from the consent review page itself.',
      );
    }

    // 3: expected Fetch Metadata for a same-origin, user-activated, TOP-LEVEL
    // form navigation. A script-shaped POST (fetch/XHR) carries none of
    // these. `sec-fetch-dest: document` is required so the comment's
    // "top-level" is derived rather than assumed (review LOW): a nested
    // navigation reports `iframe`/`frame`, and a real approve click reports
    // `document` — confirmed against a live browser trace of this exact
    // submission.
    if (
      c.req.header('sec-fetch-site') !== 'same-origin' ||
      c.req.header('sec-fetch-mode') !== 'navigate' ||
      c.req.header('sec-fetch-dest') !== 'document' ||
      c.req.header('sec-fetch-user') !== '?1'
    ) {
      return refuse(
        'fetch_metadata',
        'Decision refused',
        'Decisions can only be submitted from the consent review page.',
      );
    }

    // 4: an authenticated consent session.
    const authority = resolveListenerAuthority(
      deps,
      c.req.header('cookie'),
      id,
    );
    if (authority === null) {
      return refuse(
        'unauthenticated',
        'Sign in to Station first',
        'No consent-decision session accompanied this submission.',
      );
    }

    const body = await c.req
      .parseBody()
      .catch(() => ({}) as Record<string, unknown>);
    const decisionField = body.decision;
    const decision: ConsentDecision | null =
      decisionField === 'approve'
        ? 'approved'
        : decisionField === 'deny'
          ? 'denied'
          : null;
    if (decision === null) {
      return refuse(
        'decision_invalid',
        'Decision refused',
        'The submission did not carry a valid decision.',
      );
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;

    // 5+6: one-use nonce, pending status, and target revalidation — all
    // inside the store's atomic decide.
    const result = await deps.channel.store.decide(
      deps.channel.tenantId,
      id,
      decision,
      nonce,
      authority,
    );
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          consentDecisionOps.add(1, { result: 'refused', reason: 'not_found' });
          return c.html(
            statusPage(
              'Request not found',
              'This consent link is no longer valid.',
            ),
            404,
          );
        case 'not_pending':
          consentDecisionOps.add(1, {
            result: 'refused',
            reason: 'not_pending',
          });
          return c.html(
            statusPage(
              'Request already decided',
              `This request is ${result.status ?? 'closed'}.`,
            ),
            409,
          );
        case 'target_changed':
          consentDecisionOps.add(1, {
            result: 'refused',
            reason: 'target_changed',
          });
          deps.logger?.warn('Consent decision refused: target changed', {
            id,
          });
          return c.html(
            statusPage(
              'Nothing was granted',
              result.detail ??
                'The requested target changed after this review was opened.',
            ),
            409,
          );
        case 'commit_refused':
          consentDecisionOps.add(1, {
            result: 'refused',
            reason: 'commit_refused',
          });
          deps.logger?.warn('Consent approval commit refused', { id });
          return c.html(
            statusPage(
              'Nothing was granted',
              result.detail ?? 'The approval could not be committed.',
            ),
            503,
          );
        default:
          // nonce_missing / nonce_invalid / decision_in_flight.
          return refuse(
            result.reason,
            'Decision refused',
            'This submission did not come from the current review page. Nothing was granted — re-open the review page to decide.',
          );
      }
    }
    consentDecisionOps.add(1, { result: result.status });
    deps.logger?.info('Consent decision recorded', {
      id,
      decision: result.status,
      via: authority,
    });
    const view = deps.channel.store.get(deps.channel.tenantId, id);
    return c.html(
      result.status === 'approved'
        ? statusPage(
            'Approved',
            view
              ? `${view.description.title} — approved. The requester is ready to continue.`
              : 'The request was approved.',
          )
        : statusPage(
            'Denied',
            'Nothing was granted. The requester stays without this access.',
          ),
    );
  });

  app.all('*', (c) => c.html(statusPage('Not found', 'Nothing here.'), 404));

  assertConsentListenerRouteCoverage(app.routes);
  return app;
}

export interface ConsentListener {
  port: number;
  close: () => Promise<void>;
}

export type ConsentListenerStart =
  | { status: 'listening'; listener: ConsentListener }
  | { status: 'unavailable'; reason: string };

/**
 * Binds the consent listener. UNLIKE the MCP frame proxy this never degrades
 * silently: a bind failure is reported as a structured unavailable state that
 * the caller records on the ConsentChannelService, which makes every
 * authority-bearing approval refuse truthfully (owner decision 3) while
 * Station's main surface stays usable.
 */
export async function startConsentListener(opts: {
  app: Hono;
  port: number;
  host?: string;
  logger?: Logger;
}): Promise<ConsentListenerStart> {
  return new Promise((resolve) => {
    let settled = false;
    try {
      const server = serve(
        {
          fetch: opts.app.fetch,
          port: opts.port,
          ...(opts.host ? { hostname: opts.host } : {}),
        },
        (info) => {
          if (settled) return;
          settled = true;
          resolve({
            status: 'listening',
            listener: {
              port: info.port,
              close: () =>
                new Promise<void>((done) => {
                  server.close(() => done());
                }),
            },
          });
        },
      );
      (server as { on?: (e: string, cb: (err: unknown) => void) => void }).on?.(
        'error',
        (error) => {
          if (settled) return;
          settled = true;
          resolve({
            status: 'unavailable',
            reason: `The consent listener failed to bind port ${opts.port}: ${sanitizedTransportError(error).message}`,
          });
        },
      );
    } catch (error) {
      if (!settled) {
        settled = true;
        resolve({
          status: 'unavailable',
          reason: `The consent listener failed to start: ${sanitizedTransportError(error).message}`,
        });
      }
    }
  });
}
