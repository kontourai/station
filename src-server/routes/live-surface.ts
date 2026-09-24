import {
  encodeLiveSurfaceRecord,
  isLiveSurfaceId,
  LIVE_SURFACE_FRAMES_CONTENT_TYPE,
  LIVE_SURFACE_INPUT_MAX_BODY_BYTES,
  LIVE_SURFACE_LEASE_MAX_BODY_BYTES,
  type LiveSurfaceAction,
  type LiveSurfaceInputResult,
  type LiveSurfaceLeaseResult,
  type LiveSurfaceRouteErrorCode,
  type LiveSurfaceStreamParams,
  parseLiveSurfaceInputBatch,
  parseLiveSurfaceLeaseRequest,
  parseLiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type { HumanController } from '../services/live-surface/control-lease.js';
import {
  claimHumanControl,
  dispatchHumanInput,
  type LiveSurfaceDecision,
  type LiveSurfaceEntry,
  type LiveSurfaceRegistry,
  releaseHumanControl,
} from '../services/live-surface/registry.js';

/**
 * `/api/live-surfaces/:surfaceId/*` (#90).
 *
 * - `GET  /:surfaceId/frames` — a streaming, length-prefixed binary body of
 *   state and frame records (`LiveSurfaceRecordDecoder` reads it). One
 *   viewer per request; the producer runs while at least one is attached.
 * - `POST /:surfaceId/input` — a bounded batch of human input carrying the
 *   epoch the viewer last observed. Human input auto-claims the lease.
 * - `GET  /:surfaceId/lease` / `POST /:surfaceId/lease` — read the lease, or
 *   claim/release it for the authenticated HUMAN caller. Agents never claim
 *   over HTTP: an agent claim needs a verified session, which the server-side
 *   automation supplies to the registry's `claimAgentControl`.
 *
 * Authorization (D5) is two layers. The pairing scope (`terminal:operate`,
 * `pairing-route-scopes.ts`) gates the family; then every route asks the
 * surface's own authorizer — supplied by whoever registered the producer —
 * for `view`, `input` or `control` for the resolved HUMAN principal. No
 * authorizer means deny. Every route re-checks that the credential is still
 * current at the publication boundary, and the frames stream re-checks both
 * the credential and the `view` grant while it runs. That re-check rides the
 * stream's own records, so on a still page (no frames, only heartbeats)
 * revocation takes effect within one heartbeat (`heartbeatMs`, 5 s by
 * default) plus the re-check interval, not instantly.
 *
 * Who is a human caller is decided by the composition
 * (`resolveHumanCaller`): it returns the principal AND the client it acts
 * from, and refuses anything agent-originated. Each viewer's state records
 * carry that identity back to it, so the UI can say "you" honestly.
 */

export interface LiveSurfaceRouteOptions {
  isRequestPrincipalCurrent: (request: Request) => boolean;
  /**
   * The authenticated HUMAN caller and the client it acts from, or null for
   * an unattributable or agent-originated request (which is then refused).
   */
  resolveHumanCaller: (
    c: Context,
  ) => { principal: string; device: string } | null;
  /** How often a running frames stream re-checks the credential. */
  principalRecheckMs?: number;
  /**
   * How long one frames pull waits on a `view` re-check before delivering
   * under the decision it already has (#2433). The re-check keeps running
   * and its answer applies when it lands; a deny still ends the stream.
   */
  viewRecheckWaitMs?: number;
  /**
   * The longest a stream may run past its last CONFIRMED allow (#2433):
   * through `busy` re-checks, and through a re-check that has not answered
   * at all. Past it the stream ends; the viewer reconnects, and a still-busy
   * host answers that reconnect 503 `surface-busy`.
   *
   * The budget is spent by waiting, not only by `busy`, so it also cuts a
   * HEALTHY stream in two cases: one allowing check that takes longer than
   * about the grace (30 s by default) to answer, and a consumer that pulls
   * so rarely that its single re-check starts after the budget is nearly
   * spent and does not answer within the pull's short wait. Both end in a
   * reconnect, not a refusal: that is the price of never delivering on an
   * allow older than the grace.
   */
  viewBusyGraceMs?: number;
  now?: () => number;
}

/**
 * Added by the Device pane lane (#1970, D12): `?projectSlug=` names the
 * Project a request is made from. The routes never read it; it is context
 * for the surface's AUTHORIZER, which receives the request (a device shared
 * with a Project is reachable by that Project's admins only when the
 * request names it). It never grants anything by itself.
 */
const AUTHORIZATION_CONTEXT_QUERY_KEY = 'projectSlug';

const STREAM_QUERY_KEYS: readonly (keyof LiveSurfaceStreamParams)[] = [
  'maxFps',
  'quality',
  'maxWidth',
  'maxHeight',
];

function failure(
  c: Context,
  code: LiveSurfaceRouteErrorCode,
  status: 400 | 403 | 404 | 413 | 503,
) {
  return c.json({ success: false, code }, status);
}

export function createLiveSurfaceRoutes(
  registry: LiveSurfaceRegistry,
  options: LiveSurfaceRouteOptions,
) {
  const now = options.now ?? Date.now;
  const recheckMs = options.principalRecheckMs ?? 1_000;
  const recheckWaitMs = options.viewRecheckWaitMs ?? 1_000;
  const busyGraceMs = options.viewBusyGraceMs ?? 30_000;
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return failure(c, 'access-denied', 403);
    await next();
  });

  type Found<T> = { ok: true; value: T } | { ok: false; response: Response };

  const lookup = (c: Context): Found<LiveSurfaceEntry> => {
    const surfaceId = c.req.param('surfaceId');
    if (!isLiveSurfaceId(surfaceId))
      return { ok: false, response: failure(c, 'invalid-surface-id', 400) };
    const entry = registry.get(surfaceId);
    if (!entry)
      return { ok: false, response: failure(c, 'unknown-surface', 404) };
    return { ok: true, value: entry };
  };

  const readJson = async (
    c: Context,
    maxBytes: number,
  ): Promise<Found<unknown>> => {
    const body = await readBoundedRequestBody(c.req.raw, maxBytes);
    if (body.status === 'too-large')
      return { ok: false, response: failure(c, 'request-too-large', 413) };
    if (body.status !== 'ok')
      return { ok: false, response: failure(c, 'invalid-request', 400) };
    try {
      return { ok: true, value: JSON.parse(body.body) as unknown };
    } catch {
      return { ok: false, response: failure(c, 'invalid-request', 400) };
    }
  };

  /**
   * Resolve the human caller and require every named action (D5). Viewing,
   * input and control are separate grants; the entry's authorizer denies
   * everything when its registrant supplied none. An authorizer that cannot
   * answer right now is a retryable 503 `surface-busy`, never a 403 (#2433);
   * it admits nothing.
   */
  const authorize = async (
    c: Context,
    entry: LiveSurfaceEntry,
    actions: readonly LiveSurfaceAction[],
  ): Promise<Found<HumanController & { device: string }>> => {
    const caller = options.resolveHumanCaller(c);
    if (!caller)
      return { ok: false, response: failure(c, 'principal-unresolved', 403) };
    for (const action of actions) {
      const decision = await entry.decide(caller.principal, action, {
        request: c.req.raw,
      });
      if (decision === 'busy') {
        c.header('Retry-After', '1');
        return { ok: false, response: failure(c, 'surface-busy', 503) };
      }
      if (decision !== 'allow')
        return { ok: false, response: failure(c, 'access-denied', 403) };
    }
    return {
      ok: true,
      value: {
        kind: 'human',
        principal: caller.principal,
        device: caller.device,
      },
    };
  };

  app.get('/:surfaceId/frames', async (c) => {
    const found = lookup(c);
    if (!found.ok) return found.response;
    const entry = found.value;
    const caller = await authorize(c, entry, ['view']);
    if (!caller.ok) return caller.response;
    const human = caller.value;
    const queryKeys = Object.keys(c.req.queries());
    if (
      queryKeys.some(
        (key) =>
          (!STREAM_QUERY_KEYS.includes(key as keyof LiveSurfaceStreamParams) &&
            key !== AUTHORIZATION_CONTEXT_QUERY_KEY) ||
          (c.req.queries(key)?.length ?? 0) > 1,
      )
    )
      return failure(c, 'invalid-request', 400);
    const parsed = parseLiveSurfaceStreamParams({
      maxFps: c.req.query('maxFps'),
      quality: c.req.query('quality'),
      maxWidth: c.req.query('maxWidth'),
      maxHeight: c.req.query('maxHeight'),
    });
    if (!parsed.ok) return failure(c, 'invalid-request', 400);

    const request = c.req.raw;
    const viewer = entry.hub.attach(parsed.params, {
      principal: human.principal,
      device: human.device,
    });
    const abort = new AbortController();
    const end = () => {
      abort.abort();
      viewer.close();
    };
    request.signal?.addEventListener('abort', end, { once: true });
    let lastCheckAt = now();
    // The stream opened on an allow; `busy` keeps that allow only while it
    // is recent (#2433). A deny, or any other failure, ends the stream. The
    // same budget binds a re-check that has not answered at all: every pull
    // refuses to deliver once the last confirmed allow is older than
    // `busyGraceMs`, pending or not, so a hung authorizer fails closed.
    let lastAllowAt = now();
    let revoked = false;
    let rechecking = false;
    const apply = (decision: LiveSurfaceDecision) => {
      if (decision === 'allow') lastAllowAt = now();
      else if (decision === 'deny' || now() - lastAllowAt > busyGraceMs)
        revoked = true;
    };
    /**
     * Start a `view` re-check. The first pull waits for it up to
     * `recheckWaitMs`, so an ordinary answer still lands before the next
     * frame; a slow one (a saturated host can hold it for its whole queue
     * wait) no longer stalls the stream, and applies when it settles.
     */
    const startRecheck = (): Promise<void> => {
      rechecking = true;
      const done = entry
        .decide(human.principal, 'view', { request })
        .then(apply, () => {
          revoked = true;
        })
        .finally(() => {
          rechecking = false;
          if (revoked) end();
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, recheckWaitMs);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const record = await viewer.next(abort.signal);
          if (!record) {
            controller.close();
            return;
          }
          if (!revoked && now() - lastCheckAt >= recheckMs) {
            lastCheckAt = now();
            // Both the credential and the grant can be withdrawn while a
            // stream runs (scope narrowed, Project admin removed). One
            // `view` re-check at a time; the credential every interval.
            if (!options.isRequestPrincipalCurrent(request)) revoked = true;
            else if (!rechecking) await startRecheck();
          }
          if (now() - lastAllowAt > busyGraceMs) revoked = true;
          if (revoked) {
            end();
            controller.close();
            return;
          }
          controller.enqueue(encodeLiveSurfaceRecord(record));
        },
        cancel() {
          end();
        },
      },
      // Pull only when the consumer asks: nothing buffers ahead of the
      // socket, so the viewer's single slot is the only place a frame waits.
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': LIVE_SURFACE_FRAMES_CONTENT_TYPE,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.post('/:surfaceId/input', async (c) => {
    const found = lookup(c);
    if (!found.ok) return found.response;
    // Human input auto-claims the lease, so it needs control as well as input.
    const caller = await authorize(c, found.value, ['input', 'control']);
    if (!caller.ok) return caller.response;
    const human = caller.value;
    const body = await readJson(c, LIVE_SURFACE_INPUT_MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const batch = parseLiveSurfaceInputBatch(body.value);
    if (!batch) return failure(c, 'invalid-request', 400);
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return failure(c, 'access-denied', 403);
    const result: LiveSurfaceInputResult = await dispatchHumanInput(
      found.value,
      human,
      batch.epoch,
      batch.events,
    );
    return c.json(
      { success: result.ok, data: result },
      result.ok ? 200 : result.code === 'dispatch-failed' ? 502 : 409,
    );
  });

  app.get('/:surfaceId/lease', async (c) => {
    const found = lookup(c);
    if (!found.ok) return found.response;
    const caller = await authorize(c, found.value, ['view']);
    if (!caller.ok) return caller.response;
    return c.json({ success: true, data: found.value.lease.snapshot() });
  });

  app.post('/:surfaceId/lease', async (c) => {
    const found = lookup(c);
    if (!found.ok) return found.response;
    const caller = await authorize(c, found.value, ['control']);
    if (!caller.ok) return caller.response;
    const human = caller.value;
    const body = await readJson(c, LIVE_SURFACE_LEASE_MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const request = parseLiveSurfaceLeaseRequest(body.value);
    if (!request) return failure(c, 'invalid-request', 400);
    if (!options.isRequestPrincipalCurrent(c.req.raw))
      return failure(c, 'access-denied', 403);
    const result: LiveSurfaceLeaseResult =
      request.action === 'claim'
        ? claimHumanControl(found.value, human)
        : releaseHumanControl(found.value, human, request.epoch);
    return c.json({ success: result.ok, data: result }, result.ok ? 200 : 409);
  });

  return app;
}
