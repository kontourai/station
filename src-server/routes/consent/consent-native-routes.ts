/**
 * Native consent presentation. Operator requests require a host-held local-grant
 * mint. Requester-only transactions instead require their exact decision-session
 * secret in X-Station-Requester-Consent plus the original partition. There is no
 * operator fallback for that proof. The native HTTP owner retains the secret;
 * it never crosses IPC, and the generic relay refuses this entire route family.
 *
 * Both paths render the canonical description in OS chrome and commit through
 * the same one-use nonce, target revalidation and decision guard. Main-frame
 * code can request a dialog, but cannot script its answer. Native requester
 * custody and installed-shell behavior require separate qualification.
 */

import { type Context, Hono } from 'hono';
import { isBoundLocalGrantMintedOperator } from '../../security/runtime-request-security.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import type {
  ConsentDecision,
  ConsentDecisionAuthority,
} from '../../services/consent/consent-transactions.js';
import { consentDecisionOps } from '../../telemetry/metrics.js';

interface ConsentNativeRouteDeps {
  consentChannel?: ConsentChannelService;
}

/**
 * Factory shape (like `createAuthRoutes`) so the pairing-route leaf scan can
 * statically resolve the mount's source file and hold every leaf here to the
 * scope inventory.
 */
export function createConsentNativeRoutes(deps: ConsentNativeRouteDeps): Hono {
  const app = new Hono();
  registerConsentNativeRoutes(app, deps);
  return app;
}

export function registerConsentNativeRoutes(
  app: Hono,
  deps: ConsentNativeRouteDeps,
): void {
  const requireChannel = () => deps.consentChannel ?? null;

  // The requester secret is captured and retained by the native HTTP owner,
  // never returned to its renderer. The generic relay refuses this route
  // family and cannot send this header. It is not an operator credential.
  const decisionAuthority = (
    c: Context,
    channel: ConsentChannelService,
  ): {
    tenantId: string;
    via: ConsentDecisionAuthority;
  } | null => {
    const secret = c.req.header('X-Station-Requester-Consent');
    if (secret !== undefined) {
      const tenantId = c.req.query('scope') ?? channel.tenantId;
      const id = c.req.param('id');
      if (
        !id ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(tenantId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        !channel.store.verifyDecisionSession(tenantId, id, secret)
      )
        return null;
      return { tenantId, via: 'consent-session' };
    }
    return isBoundLocalGrantMintedOperator(c.req.raw)
      ? { tenantId: channel.tenantId, via: 'native-host' }
      : null;
  };

  /**
   * Whether THIS caller may use the native broker at all (archive#3677 PR 3).
   * The host capability answers "can this shell draw an OS
   * dialog"; only the server can answer "may this credential decide", and
   * the two are independent: a phone or a desktop app connected to a REMOTE
   * Station reports the capability but pairs through the ordinary exchange,
   * which never stamps the local-grant mint. Without this the client picked
   * the native path from the capability alone and dead-ended on a 403 with
   * no way back to the consent page.
   *
   * GET, and it reveals only whether YOUR OWN credential is local-grant
   * minted — a fact the caller could already learn by attempting a review.
   * `eligible` is the same bound flag the two routes below enforce, not a
   * second derivation, and it is false when no consent channel exists at
   * all, because the native path cannot work there either.
   */
  app.get('/native-eligibility', (c) =>
    c.json({
      success: true,
      eligible:
        requireChannel() !== null && isBoundLocalGrantMintedOperator(c.req.raw),
    }),
  );

  /**
   * Mints the render nonce and returns the canonical description for the
   * native dialog. POST, not GET: rendering consumes render budget and
   * replaces the previously minted nonce — a side effect a cache or
   * prefetcher must never trigger.
   */
  app.post('/requests/:id/native-review', (c) => {
    const channel = requireChannel();
    if (!channel) {
      return c.json(
        {
          success: false,
          error:
            'The consent surface is not configured on this runtime, so approvals are unavailable.',
        },
        503,
      );
    }
    const authority = decisionAuthority(c, channel);
    if (!authority) {
      return c.json(
        {
          success: false,
          error:
            'Only the Station desktop app on this host can review approvals natively. Browsers and paired devices use the consent page instead.',
        },
        403,
      );
    }
    const result = channel.store.renderReview(
      authority.tenantId,
      c.req.param('id'),
      authority.via,
    );
    if (!result.ok) {
      const status =
        result.reason === 'not_found'
          ? 404
          : result.reason === 'render_limited'
            ? 429
            : 409;
      return c.json(
        {
          success: false,
          error:
            result.reason === 'not_found'
              ? 'Approval not found'
              : result.reason === 'render_limited'
                ? 'This approval was re-opened too many times. Let it expire and request it again.'
                : 'This approval was already decided.',
        },
        status,
      );
    }
    return c.json({
      success: true,
      review: {
        id: result.transaction.id,
        status: result.transaction.status,
        description: result.transaction.description,
        expiresAt: result.transaction.expiresAt,
        nonce: result.nonce,
      },
    });
  });

  app.post('/requests/:id/native-decide', async (c) => {
    const channel = requireChannel();
    if (!channel) {
      return c.json(
        {
          success: false,
          error:
            'The consent surface is not configured on this runtime, so approvals are unavailable.',
        },
        503,
      );
    }
    const authority = decisionAuthority(c, channel);
    if (!authority) {
      consentDecisionOps.add(1, {
        result: 'refused',
        reason: 'native_not_local',
      });
      return c.json(
        {
          success: false,
          error:
            'Only the Station desktop app on this host can decide approvals natively. Browsers and paired devices use the consent page instead.',
        },
        403,
      );
    }
    const body = await c.req.json().catch(() => null);
    const decision: ConsentDecision | null =
      body?.decision === 'approve'
        ? 'approved'
        : body?.decision === 'deny'
          ? 'denied'
          : null;
    const nonce = typeof body?.nonce === 'string' ? body.nonce : undefined;
    if (decision === null || nonce === undefined) {
      return c.json({ success: false, error: 'Invalid consent decision' }, 400);
    }
    const result = await channel.store.decide(
      authority.tenantId,
      c.req.param('id'),
      decision,
      nonce,
      authority.via,
    );
    if (!result.ok) {
      consentDecisionOps.add(1, { result: 'refused', reason: result.reason });
      const nonceRefused =
        result.reason === 'nonce_missing' || result.reason === 'nonce_invalid';
      const status =
        result.reason === 'not_found' ? 404 : nonceRefused ? 403 : 409;
      return c.json(
        {
          success: false,
          error:
            result.reason === 'not_found'
              ? 'Approval not found'
              : nonceRefused
                ? 'This dialog is stale — the approval was re-opened elsewhere. Close it and review again.'
                : result.reason === 'target_changed'
                  ? 'The subject of this approval changed while it was being reviewed, so nothing was granted. Review it again.'
                  : result.reason === 'commit_refused'
                    ? (result.detail ??
                      'The approval could not be committed, so nothing was granted.')
                    : 'This approval was already decided or has expired.',
        },
        status,
      );
    }
    consentDecisionOps.add(1, { result: result.status });
    return c.json({
      success: true,
      request: { id: c.req.param('id'), status: result.status },
    });
  });
}
