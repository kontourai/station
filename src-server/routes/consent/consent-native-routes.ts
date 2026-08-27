/**
 * The NATIVE consent broker's server half (station#3677 PR 3).
 *
 * Why this exists: the distinct-origin consent listener is a browser
 * boundary — its decide chain proves a same-origin, user-activated form
 * navigation from a page the plugin's origin cannot script. A Tauri WebView
 * cannot reach that second port at all on some targets, and simulating the
 * browser proofs from native code would be manufacturing exactly the
 * headers the listener exists to distrust. So the native path swaps the
 * browser-shaped proofs for a mint-time possession proof, and keeps
 * everything else identical.
 *
 * WHO THIS SERVES, precisely — because the authority below decides it, not
 * the intent: the desktop app talking to the Station on its own machine,
 * whose credential is minted from the per-boot owner-only secret file. A
 * phone is NOT served by this slice and keeps using the consent page: it
 * pairs through the ordinary exchange, which stamps no mint, so it can
 * never satisfy the gate no matter which shell it runs. Reaching mobile
 * needs a different authority — an explicitly operator-granted consent
 * scope rather than a possession proof — which is station#3732, not
 * something this file should imply it already has.
 *
 * The authority, and what else is unchanged:
 *
 * - AUTHORITY: `isBoundLocalGrantMintedOperator` — the request's principal
 *   carries BOTH the `locality: 'home-possession'` stamp AND
 *   `mintKind: 'local-grant'`, i.e. the credential was minted by presenting
 *   the per-boot owner-only local-grant secret FILE. That proof cannot be
 *   produced from any browser or webview JS context, which is the point:
 *   the read-only local predicate (`isBoundRuntimeLocalOperator`, used for
 *   unredacted log reads) also admits the UI-bootstrap mint, whose
 *   credential lives in host-browser JS where same-origin plugin code runs
 *   — sufficient to READ your own logs, insufficient to APPROVE on your
 *   behalf. Both flags are bound once at the auth boundary and read here,
 *   never re-derived. A merely-paired remote device — any scope — fails,
 *   because its mint never touched the host's filesystem. No pairing scope
 *   is widened and no preset changes. Belt: the desktop webview's Rust
 *   relay refuses to ferry ANY request to this family — raw OR percent-
 *   decoded, since the router decodes before it matches — so webview script
 *   cannot ride the desktop's own local-grant credential to reach these
 *   routes directly.
 *
 *   What that does NOT claim: the Rust broker command is registered on the
 *   main window's invoke handler, so script running in Station's own bundle
 *   can ASK for a review. It cannot answer one — approval requires the user
 *   to click Approve in OS chrome no page can draw over or script, a
 *   process-wide lease allows one dialog at a time, and the server commits
 *   the decision itself. Plugin UI has no invoke bridge at all (it loads
 *   cross-origin in a sandboxed iframe; no remote-domain IPC is configured).
 * - EVERYTHING ELSE IS THE SAME STORE FLOW the listener uses: review mints
 *   the one-use render nonce (render-budget capped), and decide runs the
 *   atomic nonce + pending-status + target-revalidation sequence inside the
 *   transaction's own decision guard. The native dialog the Rust side shows
 *   is built from the SAME `ConsentDescription` the browser page renders —
 *   one description, two presentation surfaces.
 * - The DECISION IS COMMITTED SERVER-SIDE, exactly as for the listener. The
 *   Rust broker never receives a token that "is" the approval; it receives
 *   the transaction's final status.
 *
 * Failure posture (owner decision 3, applied to this surface): no consent
 * channel on this runtime ⇒ 503, approvals unavailable, nothing granted.
 * These two routes do not consult listener state — the listener is one
 * presentation surface, not the store's owner — so an ALREADY-CREATED
 * transaction stays decidable here while a port conflict has the listener
 * down, and each refusal names its own reason.
 *
 * That is not yet end-to-end listener independence, and this file does not
 * claim it: both production creators (`/api/plugins/host-approvals`,
 * `/api/plugins/home-role/requests`) still refuse before creating anything
 * when the listener is not listening, because they mint a review URL for
 * the browser surface. So on a listener-down runtime no approval can be
 * ORIGINATED on any surface today. Closing that means letting a
 * native-eligible caller create without a review URL, which is a change to
 * those routes, their clients, and the SDK shape — tracked separately
 * (station#3731), not smuggled into this slice.
 */

import { Hono } from 'hono';
import { isBoundLocalGrantMintedOperator } from '../../security/runtime-request-security.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import type { ConsentDecision } from '../../services/consent/consent-transactions.js';
import { consentDecisionOps } from '../../telemetry/metrics.js';

export interface ConsentNativeRouteDeps {
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

  /**
   * Whether THIS caller may use the native broker at all (station#3677 PR 3,
   * review round 1). The host capability answers "can this shell draw an OS
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
    if (!isBoundLocalGrantMintedOperator(c.req.raw)) {
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
      channel.tenantId,
      c.req.param('id'),
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
    if (!isBoundLocalGrantMintedOperator(c.req.raw)) {
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
      channel.tenantId,
      c.req.param('id'),
      decision,
      nonce,
      // The audit vocabulary's native arm: proven by the request principal's
      // mint-time home-possession stamp, not by an operator credential file
      // or a consent:decide scope.
      'native-host',
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
