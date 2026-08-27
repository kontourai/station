/**
 * station#1398 slice 2 — `/api/inference/**`, Station's first
 * inference-serving surface (`docs/design/inference-fleet.md` §3.2 Option A,
 * §3.3, §10 OQ-1/OQ-8, §11 slice 2).
 *
 * **Authorization.** The whole family requires the `inference:invoke` pairing
 * scope, declared once in `src-server/security/pairing-route-scopes.ts` as an
 * `origin: 'explicit'` rule on this prefix. No preset except `inference`
 * grants that scope, `DEFAULT_GRANT_PAIRING_SCOPE` deliberately withholds it,
 * and the operator bootstrap credential therefore does not carry it either —
 * reaching this family always means someone minted a grant for it. On top of
 * station#2051 requires a valid credential at every protected HTTP route,
 * including loopback and SSH-forwarded requests. Both requirements are pinned
 * by tests; neither is enforced in this file, because a route handler
 * re-deriving its own authorization is how the two drift apart.
 *
 * **`PUT /config/app` stays at `orchestration:operate` — on a precondition
 * the code enforces (§5.4, decided here).** §5.4 asked whether flipping
 * `AppConfig.fleetContribution` needs a narrower write path than the generic
 * settings tier, since a `delegation`-scoped peer or a Standard paired device
 * can turn contribution on with no consent step distinct from the one that
 * let it drive orchestration. **Decision: the tier stands for a credential
 * that cannot invoke; a credential that CAN invoke is refused the write.**
 *
 * The tier is defensible for an `orchestration:operate`-only peer because the
 * escalation does not exist in the direction it appears to: that credential
 * already authorizes starting arbitrary agent sessions and driving turns
 * here — strictly MORE authority over this machine's compute than causing it
 * to serve buffered completions — and flipping the opt-in grants it nothing,
 * since it cannot invoke what it enabled. Adding a consent ceremony in front
 * of the lesser of two powers the same credential already holds teaches the
 * wrong lesson about which gate matters.
 *
 * That argument is silent about a grant carrying BOTH scopes, so the guard
 * targets the beneficiary rather than the tier: `routes/system/config.ts`
 * refuses any `fleetContribution` write from a presented credential holding
 * `inference:invoke`. Otherwise such a peer could enable contribution, name a
 * connection — including a BILLABLE hosted one, since `connectionIds` rides
 * the same write — and then spend the owner's money through this very route,
 * with no operator in the loop at any step.
 *
 * What genuinely remains open, and is why this stays written down:
 * `PUT /config/app` is a broad write surface at a broad tier, and the honest
 * fix is narrowing that surface generally rather than carving out one field.
 * The scope vocabulary this slice adds makes that cheap later.
 */

import type {
  FleetInferenceManifestResponse,
  FleetInferenceRefusal,
} from '@kontourai/station-contracts/fleet-inference';
import {
  FLEET_INFERENCE_LIMITS,
  FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
  FLEET_INFERENCE_REFUSAL_STATUS,
} from '@kontourai/station-contracts/fleet-inference';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { FleetInferenceService } from '../../services/inference/fleet-inference-service.js';
import type { UnsealedFleetServeReceipt } from '../../services/inference/fleet-serve-receipt-log.js';
import {
  peerFingerprint,
  promptDigest,
} from '../../services/inference/fleet-serve-receipt-log.js';
import {
  fleetInferenceManifestReadTotal,
  fleetServeReceiptFailures,
} from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import {
  RequestBodyTooLargeError,
  readRequestText,
} from '../schemas/schema-validation.js';

function refusalStatus(refusal: FleetInferenceRefusal): ContentfulStatusCode {
  return FLEET_INFERENCE_REFUSAL_STATUS[refusal.code] as ContentfulStatusCode;
}

/**
 * The serve-side receipt sink (station#1398 slice 3, §3.4 "Both sides
 * record"). Optional so the route stays constructible in a test with no
 * filesystem — but when it is absent nothing is recorded, so a caller wiring
 * this route in production must supply it.
 */
export interface FleetServeReceiptSink {
  append(receipt: UnsealedFleetServeReceipt): Promise<unknown>;
}

/**
 * Fallback logger for the one message that must never go silent below. Same
 * module-scope pattern as `dispatch-model-policy.ts`'s, and for the same
 * reason: the call path that fails to write a receipt is exactly the path
 * least likely to have had a logger threaded into it.
 */
const moduleLogger = createLogger({ name: 'fleet-inference-routes' });

/**
 * **Which refusals are receipted, and which are not** (security review, L-4).
 *
 * Every refusal the SERVICE decides — `contribution-disabled`,
 * `model-not-contributed`, `model-unavailable`, `capacity-exhausted`,
 * `completion-timeout`, `execution-failed`, … — is receipted below, because
 * the service was reached and made a decision worth recording.
 *
 * Two classes are deliberately NOT receipted, and the distinction is not an
 * oversight:
 *
 * 1. **Refusals this ROUTE decides before the service is reached** — an
 *    oversized or unreadable body (`request-too-large`, `request-invalid`
 *    from the reader/JSON parse). There is no request to describe: the model
 *    id and messages are exactly what could not be read, so a receipt would
 *    carry a null model and a digest of `null`, and a peer could mint
 *    unbounded such records by sending garbage. The bound itself is the
 *    defence; the metric counter is the signal.
 * 2. **Refusals decided ABOVE this route** — 401/403 from the pairing scope
 *    middleware. Those never enter this handler at all, and they belong to
 *    the auth audit log, not to a record of what this Station served.
 *
 * The consequence, stated so nobody reconstructs it from an absence: the
 * serve log answers "what did I serve, and what did I refuse to serve", not
 * "who knocked". It is not an access log and must not be read as one.
 */
export function createFleetInferenceRoutes(
  service: FleetInferenceService,
  serveReceipts?: FleetServeReceiptSink,
) {
  const app = new Hono();

  /**
   * Records what this Station served, and to whom, without ever recording
   * what was said.
   *
   * A write failure never fails the response: the completion already
   * happened, and turning it into a 500 would hand the peer a retry that
   * costs this machine a second generation. But it is LOUD (security review,
   * M-2 — the first cut swallowed it and pointed at a counter that only
   * increments on success, so an unwritten serve receipt was invisible on
   * every channel). An unrecorded completion is the "no artifact" posture
   * this feature exists to differentiate against, so it gets its own failure
   * counter and an error line naming what went unrecorded.
   */
  const recordServed = async (
    receipt: UnsealedFleetServeReceipt,
  ): Promise<void> => {
    if (!serveReceipts) return;
    try {
      await serveReceipts.append(receipt);
    } catch (error) {
      fleetServeReceiptFailures.add(1, { outcome: receipt.outcome });
      moduleLogger.error(
        `[fleet-inference] Serve-side receipt could not be written. This Station ${receipt.outcome} a fleet completion for model '${receipt.requestedModelId ?? 'unknown'}' and that is NOT recorded.`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  };

  /**
   * The authenticated fleet route §4.2 names: which models this Station
   * contributes, in slice 1's `station.fleet-contribution/v1` shape, bounded
   * for the machine boundary. Nothing about participation appears on the
   * public handshake — this is the only place it is readable, and only after
   * authenticating (§3.3 point 3, §5.2 rules 1–2).
   */
  app.get('/manifest', async (c) => {
    try {
      const manifest = await service.readManifest();
      fleetInferenceManifestReadTotal.add(1, {
        participation: manifest.participation,
      });
      return c.json({ manifest } satisfies FleetInferenceManifestResponse);
    } catch {
      // Unknown, not empty: an empty manifest and an unreadable one mean
      // opposite things to a consumer deciding whether to route here.
      const refusal: FleetInferenceRefusal = {
        schemaVersion: FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
        code: 'contribution-unavailable',
        message:
          'This Station could not read what it currently contributes. That is unknown, not empty — retry rather than treating this peer as offering nothing.',
        refusedAt: new Date().toISOString(),
      };
      return c.json({ refusal }, refusalStatus(refusal));
    }
  });

  /**
   * One buffered completion against one contributed model.
   *
   * **Ingestion is stream-bounded.** `readRequestText` refuses an oversized
   * declared `Content-Length` before reading a byte, then reads chunk by
   * chunk and cancels the reader the moment observed bytes exceed the cap —
   * so a caller that LIES about its length, or sends a chunked body with no
   * length at all, is stopped mid-stream rather than buffered in full and
   * measured afterwards. That was the residual this route shipped with in
   * review round 1, and it closed by using the repo's existing reader
   * (`routes/schemas/schema-validation.ts`, which `PUT /config/app` has
   * ridden since it was written) instead of `c.req.text()`. Nothing bespoke:
   * it already works on both the node-server and in-process harness paths,
   * which was the stated reason for not reaching for Hono's `bodyLimit`.
   *
   * `stream: true` is refused by name rather than silently buffered
   * (§10 OQ-8) — a consumer told it is streaming when it is not has been
   * told something untrue about the path it routes over.
   *
   * **A local-UI scope distinction worth knowing before debugging one.** Like
   * every protected family, this route rejects a credential-less loopback
   * caller. Station's browser reaches it differently depending on whether a
   * device-session
   * continuity cookie happens to be set: with no cookie it receives the same
   * authentication refusal as any other protected route; with a cookie it
   * and gets 401; with one it presents a credential whose grant is a device
   * preset lacking `inference:invoke`, and gets 403 `insufficient_scope`.
   * Both are correct refusals of the same request; the latter is the
   * family-specific scope refusal worth distinguishing while debugging.
   */
  app.post('/completions', async (c) => {
    let raw: string;
    try {
      raw = await readRequestText(
        c.req.raw,
        FLEET_INFERENCE_LIMITS.maxRequestBytes,
      );
    } catch (error) {
      const tooLarge = error instanceof RequestBodyTooLargeError;
      const refusal: FleetInferenceRefusal = {
        schemaVersion: FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
        code: tooLarge ? 'request-too-large' : 'request-invalid',
        message: tooLarge
          ? `A fleet completion request body carries at most ${FLEET_INFERENCE_LIMITS.maxRequestBytes} bytes.`
          : 'The request body could not be read.',
        refusedAt: new Date().toISOString(),
      };
      return c.json({ refusal }, refusalStatus(refusal));
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      const refusal: FleetInferenceRefusal = {
        schemaVersion: FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
        code: 'request-invalid',
        message: 'The request body must be valid JSON.',
        refusedAt: new Date().toISOString(),
      };
      return c.json({ refusal }, refusalStatus(refusal));
    }

    // The caller's own abort signal is threaded through so a disconnect
    // stops generation and frees the concurrency slot immediately, rather
    // than leaving this Station generating tokens nobody will read until the
    // deadline expires.
    const outcome = await service.complete(body, {
      signal: c.req.raw.signal,
    });

    const requested = body as { model?: unknown; messages?: unknown } | null;
    const receiptBase = {
      recordedAt: new Date().toISOString(),
      peerFingerprint: peerFingerprint(c.req.header('authorization')),
      requestedModelId:
        typeof requested?.model === 'string' ? requested.model : null,
      promptDigest: promptDigest(requested?.messages ?? null),
    };

    if (outcome.kind === 'refused') {
      await recordServed({
        ...receiptBase,
        outcome: 'refused',
        refusalCode: outcome.refusal.code,
        completionCharacters: null,
        elapsedMs: null,
      });
      return c.json(
        { refusal: outcome.refusal },
        refusalStatus(outcome.refusal),
      );
    }
    await recordServed({
      ...receiptBase,
      outcome: 'served',
      refusalCode: null,
      completionCharacters: outcome.response.content.length,
      elapsedMs: outcome.response.elapsedMs,
    });
    return c.json({ completion: outcome.response });
  });

  return app;
}
