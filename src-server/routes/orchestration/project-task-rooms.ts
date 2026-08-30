/** Transport adapter for the personal Project/Task room runtime. */

import {
  parseProjectTaskRoomBrowserDiscovery,
  parseProjectTaskRoomBrowserHistory,
  parseProjectTaskRoomBrowserLiveSnapshot,
} from '@kontourai/station-contracts/project-task-room-browser';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  formatInteractiveWorkspaceBatchTiming,
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
  INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
} from '../../../src-shared/interactive-workspace-performance-timing.js';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { getBody, param, validate } from '../schemas/schemas.js';
import { streamSSE } from '../sse-response.js';

export async function settleProjectTaskRoomCadence(input: {
  /** A rejected cadence is operationally incomplete, never authorization proof. */
  readonly cadence: Promise<boolean>;
  readonly aborted: () => boolean;
  readonly terminal: () => boolean;
  readonly subscriptionAlive: () => Promise<boolean>;
  readonly closeTerminal: () => Promise<void>;
  readonly writePing: () => Promise<void>;
}): Promise<void> {
  if (input.aborted()) return;
  let cadenceCompleted = false;
  try {
    cadenceCompleted = await input.cadence;
  } catch {
    // Cadence performs recovery/checkpoint work as well as authorization. Its
    // rejection says nothing about whether this exact request remains valid.
  }
  if (cadenceCompleted) {
    if (!input.terminal() && !input.aborted()) await input.writePing();
    return;
  }
  try {
    if (!(await input.subscriptionAlive())) await input.closeTerminal();
  } catch {
    // An authority-check rejection cannot establish continued authority.
    await input.closeTerminal();
  }
}

const messageSchema = z
  .object({
    proposalId: z.string().min(1).max(256),
    text: z
      .string()
      .min(1)
      .max(16 * 1024),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();
const liveSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('join'),
      requestId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z.object({ command: z.literal('heartbeat') }).strict(),
  z
    .object({
      command: z.literal('announce'),
      requestId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('depart'),
      requestId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('watch'),
      paneId: z.string().min(1).max(256),
      targetActorId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      command: z.literal('follow'),
      paneId: z.string().min(1).max(256),
      targetActorId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({ command: z.literal('stop'), paneId: z.string().min(1).max(256) })
    .strict(),
  z.object({ command: z.literal('typing'), active: z.boolean() }).strict(),
  z
    .object({
      command: z.literal('cursor'),
      generation: z.string().min(1).max(256),
      workingRevision: z.string().min(1).max(256),
      selection: z
        .object({
          anchor: z.number().int().nonnegative(),
          focus: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal('finish'),
      requestId: z.string().min(1).max(256).optional(),
      outcome: z.enum(['completed', 'failed', 'cancelled']),
    })
    .strict(),
]);
const editPlanSchema = z
  .object({
    intentId: z.string().min(1).max(256),
    desiredText: z.string().max(16 * 1024),
    selection: z
      .object({
        anchor: z.number().int().nonnegative(),
        focus: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const batchSchema = z
  .object({
    intentId: z.string().min(1).max(256),
    intentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * All request identity comes from the Request passed through to the runtime.
 * In particular this schema deliberately has no principal, Project, device,
 * channel, policy, or grant field.
 */
export function createProjectTaskRoomRoutes(runtime: ProjectTaskRoomRuntime) {
  const app = new Hono();
  app.get('/:taskId/room', async (c) => {
    const result = await runtime.discover({
      taskId: param(c, 'taskId'),
      request: c.req.raw,
    });
    const browser = browserDiscovery(result);
    return response(c, browser ?? { kind: 'unavailable' });
  });
  app.get('/:taskId/room/history', async (c) =>
    response(
      c,
      await historyResponse(
        runtime,
        param(c, 'taskId'),
        c.req.raw,
        c.req.query('cursor'),
        c.req.query('limit'),
      ),
    ),
  );
  app.get('/:taskId/room/document', async (c) =>
    response(
      c,
      await runtime.document({
        taskId: param(c, 'taskId'),
        request: c.req.raw,
        ...(c.req.query('after') ? { after: c.req.query('after')! } : {}),
      }),
    ),
  );
  app.get('/:taskId/room/events', async (c) =>
    streamSSE(c, async (stream) => {
      let writeChain = Promise.resolve();
      let terminal = false;
      let terminalWritten = false;
      let aborted = false;
      let deliveryGeneration = 0;
      let queued = 0;
      const taskId = param(c, 'taskId');
      let cadence: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      let resolveAbort: (() => void) | undefined;
      const abort = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      // Register before the first await. A client can cancel while runtime
      // subscription or its initial authority check is still pending.
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        deliveryGeneration += 1;
        resolveAbort?.();
      };
      stream.onAbort(onAbort);
      // Hono's stream abort hook covers a detached response body; the request
      // signal closes the earlier fetch-cancellation window before that body
      // has been handed to the client.
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
      const closeTerminal = async () => {
        if (aborted || terminalWritten) return;
        terminal = true;
        terminalWritten = true;
        deliveryGeneration += 1;
        await stream.writeSSE({ event: 'terminal', data: '{}' });
        await stream.close();
        resolveAbort?.();
      };
      try {
        const subscribed = await runtime.subscribe({
          taskId,
          request: c.req.raw,
          emit: (event) => {
            if (aborted) return;
            const raw = event as { type?: string };
            const liveProjection =
              raw.type === 'live' ? browserLiveEnvelope(event) : undefined;
            const projected =
              raw.type === 'live'
                ? (liveProjection ?? { type: 'terminal' })
                : event;
            const value = projected as { type?: string; revision?: string };
            if (value.type === 'terminal') {
              terminal = true;
              deliveryGeneration += 1;
            }
            if (queued >= 64) {
              terminal = true;
              deliveryGeneration += 1;
            }
            const generation = deliveryGeneration;
            queued += 1;
            writeChain = writeChain
              .then(async () => {
                queued -= 1;
                if (aborted || generation !== deliveryGeneration) return;
                // Overflow invalidates the whole queued generation. Do not use
                // the decremented queue depth here: by the time this callback
                // reaches the head it may be zero even though the terminal was
                // caused by the original overflow.
                if (terminal || value.type === 'terminal') {
                  await closeTerminal();
                  return;
                }
                // Queueing is not authorization. A device can be revoked after
                // this event was accepted but before its turn reaches the wire.
                // Recheck immediately before every content-bearing write.
                if (
                  !(await runtime.subscriptionAlive({
                    taskId,
                    request: c.req.raw,
                  }))
                ) {
                  await closeTerminal();
                  return;
                }
                if (aborted) return;
                await stream.writeSSE({
                  event: value.type === 'document' ? 'document' : 'room',
                  data: JSON.stringify(projected),
                  ...(value.revision ? { id: value.revision } : {}),
                });
              })
              .catch(() => {});
          },
          ...(c.req.header('Last-Event-ID')
            ? { after: c.req.header('Last-Event-ID')! }
            : {}),
        });
        if (subscribed.kind !== 'subscribed') {
          await closeTerminal();
          return;
        }
        unsubscribe = subscribed.unsubscribe;
        if (aborted) return;
        // Subscription setup may have crossed a worker-backed document read.
        // The initial snapshot is content-bearing too, so reauthorize at the
        // last possible point rather than treating successful setup as a lease.
        if (
          !(await runtime.subscriptionAlive({
            taskId,
            request: c.req.raw,
          }))
        ) {
          await closeTerminal();
          return;
        }
        if (aborted) return;
        const initial = browserLiveEnvelope(subscribed.initial);
        if (!initial) {
          await closeTerminal();
          return;
        }
        // Reference-only diagnostic ordering: strategy arrives before the
        // snapshot's document invalidation can produce the measured layout.
        if (process.env.STATION_PERFORMANCE_REFERENCE === '1') {
          const strategy = performanceDocumentStrategy(
            subscribed.initial.document,
          );
          if (strategy)
            await stream.writeSSE({
              event: 'document',
              data: JSON.stringify(strategy),
            });
        }
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify(initial),
          id:
            (subscribed.initial.document as { revision?: string }).revision ??
            subscribed.initial.generation,
        });
        if (aborted) return;
        // Notifications observed while the initial read was in flight are held
        // by the runtime until this snapshot establishes the replay boundary.
        subscribed.activate();
        cadence = setInterval(() => {
          if (aborted) return;
          void settleProjectTaskRoomCadence({
            cadence: runtime.subscriptionCadence({
              taskId,
              request: c.req.raw,
            }),
            aborted: () => aborted,
            terminal: () => terminal,
            subscriptionAlive: () =>
              runtime.subscriptionAlive({ taskId, request: c.req.raw }),
            closeTerminal,
            writePing: () => stream.writeSSE({ event: 'ping', data: '' }),
          }).catch(() => {});
        }, 15_000);
        await abort;
      } finally {
        c.req.raw.signal.removeEventListener('abort', onAbort);
        if (cadence) clearInterval(cadence);
        unsubscribe?.();
      }
    }),
  );
  app.post('/:taskId/room/messages', validate(messageSchema), async (c) => {
    const body = getBody(c);
    return response(
      c,
      await runtime.message({
        taskId: param(c, 'taskId'),
        request: c.req.raw,
        proposalId: body.proposalId,
        text: body.text,
        ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
      }),
    );
  });
  app.post('/:taskId/room/live', validate(liveSchema), async (c) => {
    const body = getBody(c);
    const result = await runtime.live({
      taskId: param(c, 'taskId'),
      request: c.req.raw,
      ...body,
    });
    return response(
      c,
      result.kind === 'available'
        ? (browserLiveResult(result) ?? { kind: 'unavailable' })
        : result,
    );
  });
  app.post('/:taskId/room/edit-plan', validate(editPlanSchema), async (c) => {
    const body = getBody(c);
    return response(
      c,
      await runtime.editPlan({
        taskId: param(c, 'taskId'),
        request: c.req.raw,
        ...body,
      }),
    );
  });
  // Atom operations remain private to the server editing capability. The
  // browser can settle only the opaque plan receipt returned by edit-plan.
  app.post('/:taskId/room/batches', validate(batchSchema), async (c) => {
    const body = getBody(c);
    const taskId = param(c, 'taskId');
    const diagnostic =
      process.env.STATION_PERFORMANCE_REFERENCE === '1' &&
      c.req.header(INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER) ===
        INTERACTIVE_WORKSPACE_TIMING_MODE;
    const ingressEpochMs = performance.timeOrigin + performance.now();
    let acceptedEpochMs: number | undefined;
    const result = await runtime.submitBatch({
      taskId,
      request: c.req.raw,
      ...body,
      ...(diagnostic
        ? {
            onDurableSettlementForDiagnostic: () => {
              acceptedEpochMs = Math.max(
                ingressEpochMs,
                performance.timeOrigin + performance.now(),
              );
            },
          }
        : {}),
    });
    if (
      diagnostic &&
      acceptedEpochMs !== undefined &&
      (result.kind === 'committed' || result.kind === 'duplicate')
    ) {
      const timing = formatInteractiveWorkspaceBatchTiming({
        taskId,
        ingressEpochMs,
        acceptedEpochMs,
      });
      if (timing) {
        c.header(INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER, timing);
        c.header(
          'Access-Control-Expose-Headers',
          INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
        );
      }
    }
    return response(c, result);
  });
  return app;
}

async function historyResponse(
  runtime: ProjectTaskRoomRuntime,
  taskId: string,
  request: Request,
  encodedCursor: string | undefined,
  encodedLimit: string | undefined,
) {
  const cursor = decodeCursor(encodedCursor);
  const limit = decodeLimit(encodedLimit);
  if (
    (encodedCursor !== undefined && !cursor) ||
    (encodedLimit !== undefined && limit === undefined)
  )
    return { kind: 'invalid-cursor' } as const;
  const result = await runtime.history({
    taskId,
    request,
    project: true,
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  return parseProjectTaskRoomBrowserHistory(result) ?? { kind: 'unavailable' };
}

function browserDiscovery(value: any) {
  if (value?.kind !== 'opened' && value?.kind !== 'existing')
    return parseProjectTaskRoomBrowserDiscovery(value);
  return parseProjectTaskRoomBrowserDiscovery({
    kind: value.kind,
    scope: { projectId: value.scope?.projectId, taskId: value.scope?.taskId },
    channelId: value.channelId,
    assurance: value.assurance,
    capabilities: {
      historyRead: true,
      messageWrite: true,
      live: true,
      documentRead: true,
      documentWrite: true,
      revisionLinks: value.revisionLinksAvailable === true,
    },
  });
}

function browserLiveEnvelope(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  const parsed = parseProjectTaskRoomBrowserLiveSnapshot(value);
  if (!parsed) return undefined;
  if (event.type === 'snapshot')
    return {
      type: 'snapshot',
      generation: parsed.generation,
      viewerActorId: parsed.viewerActorId,
      live: parsed,
      document: event.document,
    };
  if (event.type === 'live' && parsed.result)
    return {
      type: 'live',
      kind: 'available',
      generation: parsed.generation,
      viewerActorId: parsed.viewerActorId,
      result: parsed.result,
      snapshot: parsed,
    };
  return undefined;
}

function browserLiveResult(value: unknown):
  | {
      readonly kind: 'available';
      readonly generation: unknown;
      readonly viewerActorId: unknown;
      readonly result: unknown;
      readonly snapshot: unknown;
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const event = browserLiveEnvelope({ type: 'live', ...raw });
  if (!event || typeof event !== 'object') return undefined;
  const projected = event as Record<string, unknown>;
  return {
    kind: 'available',
    generation: projected.generation,
    viewerActorId: projected.viewerActorId,
    result: projected.result,
    snapshot: projected.snapshot,
  };
}

/** Cursors are bounded base64url JSON; their exact shape is still verified by history. */
function decodeCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (decoded.length > 4096) return undefined;
    const parsed: unknown = JSON.parse(decoded);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Parameters<ProjectTaskRoomRuntime['history']>[0]['cursor'])
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^(?:[1-9]|[1-9][0-9]{1,2})$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= 100 ? limit : undefined;
}

function response(
  c: { json(value: unknown, status?: number): Response },
  result: { readonly kind: string },
) {
  if (result.kind === 'not-found')
    return c.json({ success: false, error: 'Room not found' }, 404);
  if (result.kind === 'unavailable')
    return c.json({ success: false, error: 'Room unavailable' }, 503);
  if (
    result.kind === 'invalid-cursor' ||
    (result.kind === 'rejected' &&
      (result as { reason?: string }).reason === 'malformed')
  )
    return c.json({ success: false, error: 'Invalid room request' }, 400);
  if (
    result.kind === 'rejected' &&
    (result as { reason?: string }).reason === 'idempotency-conflict'
  )
    return c.json({ success: false, error: 'Conflicting room proposal' }, 409);
  if (
    result.kind === 'rejected' &&
    (result as { reason?: string }).reason === 'capacity'
  )
    return c.json({ success: false, error: 'Room capacity exceeded' }, 413);
  return c.json({ success: true, data: result });
}

function performanceDocumentStrategy(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const document = value as {
    kind?: unknown;
    revision?: unknown;
    floor?: unknown;
  };
  if (
    (document.kind === 'delta' || document.kind === 'snapshot') &&
    typeof document.revision === 'string'
  )
    return {
      kind: document.kind,
      revision: document.revision,
      diagnostic: true,
    };
  if (document.kind === 'gap' && typeof document.floor === 'string')
    return { kind: 'gap', floor: document.floor, diagnostic: true };
  return undefined;
}
