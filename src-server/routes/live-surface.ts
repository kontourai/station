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
  now?: () => number;
}

const STREAM_QUERY_KEYS: readonly (keyof LiveSurfaceStreamParams)[] = [
  'maxFps',
  'quality',
  'maxWidth',
  'maxHeight',
];

function failure(
  c: Context,
  code: LiveSurfaceRouteErrorCode,
  status: 400 | 403 | 404 | 413,
) {
  return c.json({ success: false, code }, status);
}

export function createLiveSurfaceRoutes(
  registry: LiveSurfaceRegistry,
  options: LiveSurfaceRouteOptions,
) {
  const now = options.now ?? Date.now;
  const recheckMs = options.principalRecheckMs ?? 1_000;
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
   * everything when its registrant supplied none.
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
      if (!(await entry.authorize(caller.principal, action)))
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
          !STREAM_QUERY_KEYS.includes(key as keyof LiveSurfaceStreamParams) ||
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
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const record = await viewer.next(abort.signal);
          if (!record) {
            controller.close();
            return;
          }
          if (now() - lastCheckAt >= recheckMs) {
            lastCheckAt = now();
            // Both the credential and the grant can be withdrawn while a
            // stream runs (scope narrowed, Project admin removed).
            if (
              !options.isRequestPrincipalCurrent(request) ||
              !(await entry.authorize(human.principal, 'view'))
            ) {
              end();
              controller.close();
              return;
            }
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
