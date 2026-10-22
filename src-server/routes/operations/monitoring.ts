/**
 * Monitoring Routes - agent stats, metrics, and events
 */

import type { EventEmitter } from 'node:events';
import { SSE_KEEPALIVE_INTERVAL_MS } from '../../constants.js';
import { errorMessage } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';

/** Minimal agent shape used by monitoring routes. */
interface MonitoringAgent {
  name: string;
  model?: string | { modelId?: string };
}

import { Hono } from 'hono';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { redactMonitoringContent } from '../../monitoring/redaction.js';
import type { MonitoringEvent } from '../../monitoring/schema.js';

// Type extensions for monitoring routes
interface ModelWithId {
  modelId?: string;
}

import { FLEET_ROUTING_RECEIPT_READ_LIMITS } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { K, OP } from '../../../src-shared/monitoring-keys.js';
import {
  isContentBearingMonitoringEvent,
  monitoringSessionIdentity,
} from '../../monitoring/monitoring-session-identity.js';
import { readFleetRoutingReceipts } from '../../runtime/conversation/fleet-routing-receipt-log.js';
import { EventHistoryLimitError } from '../../runtime/conversation/runtime-event-log.js';
import { readFleetServeReceipts } from '../../services/inference/fleet-serve-receipt-log.js';
import { isTelemetryProducerName } from '../../services/telemetry-producers/telemetry-producer-store.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { streamSSE } from '../sse-response.js';

/** Ceiling for an explicitly requested history limit; omission is unbounded. */
const MAX_EVENT_QUERY_LIMIT = 5000;

export interface MonitoringDeps {
  activeAgents: Map<string, MonitoringAgent>;
  agentStats: Map<
    string,
    { conversationCount: number; messageCount: number; lastUpdated: number }
  >;
  agentStatus: Map<string, 'idle' | 'running'>;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  metricsLog: Array<{
    timestamp: number;
    agentSlug: string;
    event: string;
    conversationId?: string;
    messageCount?: number;
    cost?: number;
  }>;
  /** EventEmitter that produces OTel-shaped MonitoringEvent objects */
  monitoringEvents: EventEmitter;
  queryEventsFromDisk: (
    start: number,
    end: number,
    userId: string,
  ) => Promise<any[]>;
  /**
   * Station home for this instance. Optional only because several older
   * callers construct these routes without one; the fleet receipt leaf says
   * "not available" rather than inventing a path when it is absent.
   */
  projectHomeDir?: string;
  resolveAgentModel?: (
    slug: string,
    agent: MonitoringAgent,
  ) => Promise<string | null | undefined> | string | null | undefined;
  /**
   * The runtime delegates session/content-bearing event classification to the
   * same central orchestration policy used by every other session read.
   * Absent only in personal-mode compatibility wiring.
   */
  readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  canReadMonitoringEvent?: (
    event: unknown,
    authority: SessionReadAuthority,
  ) => boolean;
  /**
   * #2377 slice B (decision 2): the one user whose rows this request may
   * read, when it may not choose — a station-control agent acting for its
   * session's owner. `undefined`: the request names the user as before
   * (the operator's own clients, a bound operator caller). `null`: it acts
   * for no one and reads no rows.
   */
  eventOwnerForRequest?: (request: Request) => string | null | undefined;
}

/** Shared by both receipt leaves so they cannot bound differently. */
function receiptLimit(raw: string | undefined): number {
  const requested = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(requested)
    ? requested
    : FLEET_ROUTING_RECEIPT_READ_LIMITS.defaultLimit;
}

export function createMonitoringRoutes(deps: MonitoringDeps) {
  const app = new Hono();

  /**
   * archive#1398 — the bounded fleet routing-receipt read
   * (`docs/design/inference-fleet.md` §3.4, §11 slice 4). "An NDJSON file
   * under `~/.station` that no surface reads is not a receipt, it is a log."
   *
   * **Deliberately NOT under `/api/inference/**`.** That family is the
   * PEER-facing surface: it requires `inference:invoke`. Like every protected
   * route, it rejects bare loopback traffic; a receipt route there would be
   * unreadable by this Station's ordinary UI credential while being reachable
   * by the peers the receipts are ABOUT. Receipts are local-only (§10 OQ-4), so they
   * belong on this Station's own monitoring family at its ordinary read
   * tier — the same tier as every other thing this Station says about
   * itself.
   */
  app.get('/fleet-routing-receipts', async (c) => {
    if (!deps.projectHomeDir) {
      // Unknown, not empty. An empty receipt list here would read as "this
      // Station has never fleet-routed anything", which is a claim this
      // route cannot make when it does not know where the log lives.
      return c.json(
        {
          success: false,
          error:
            'This Station cannot locate its receipt log, so whether it has fleet-routed anything is unknown rather than empty.',
        },
        503,
      );
    }
    const page = await readFleetRoutingReceipts(
      deps.projectHomeDir,
      receiptLimit(c.req.query('limit')),
    );
    return c.json({ success: true, data: page });
  });

  /**
   * archive#1398/4 (security review, M-2) — the SERVING side's own
   * receipts, readable for the same reason the routing ones are: "a receipt
   * nobody can read is a log, not a receipt" is a rule about receipts, not
   * about consumer-side receipts. Without this the serve log was write-only
   * ceremony — the exact "no artifact" posture the fleet design says it is
   * differentiating against, reproduced one directory over.
   *
   * Same scope tier as its sibling (`access:manage`): it names the peer
   * fingerprints that called in, which is fleet-membership information.
   */
  app.get('/fleet-serve-receipts', async (c) => {
    if (!deps.projectHomeDir) {
      return c.json(
        {
          success: false,
          error:
            'This Station cannot locate its receipt log, so what it has served is unknown rather than empty.',
        },
        503,
      );
    }
    const page = await readFleetServeReceipts(
      deps.projectHomeDir,
      receiptLimit(c.req.query('limit')),
    );
    return c.json({ success: true, data: page });
  });

  // Get agent stats
  app.get('/stats', async (c) => {
    try {
      const authority = deps.readAuthorityForRequest?.(c.req.raw);
      const hosted = authority && isHostedSessionReadAuthority(authority);
      const agents = await Promise.all(
        Array.from(deps.activeAgents.entries()).map(async ([slug, agent]) => {
          let stats = deps.agentStats.get(slug);
          // File-memory and this process-wide cache have no tenant binding.
          // Never populate or expose either in hosted mode until a
          // session-authorized aggregate is available.
          if (!stats && !hosted) {
            const adapter = deps.memoryAdapters.get(slug);
            if (adapter) {
              const conversations = await adapter.getConversations(slug);
              let totalMessages = 0;
              for (const conv of conversations) {
                const messages = await adapter.getMessages(
                  conv.userId,
                  conv.id,
                );
                totalMessages += messages.length;
              }
              stats = {
                conversationCount: conversations.length,
                messageCount: totalMessages,
                lastUpdated: Date.now(),
              };
              deps.agentStats.set(slug, stats);
            } else {
              stats = {
                conversationCount: 0,
                messageCount: 0,
                lastUpdated: Date.now(),
              };
            }
          }

          const fallbackModelId =
            typeof agent.model === 'string'
              ? agent.model
              : (agent.model as ModelWithId)?.modelId || 'unknown';
          const modelId =
            (await deps.resolveAgentModel?.(slug, agent)) ||
            fallbackModelId ||
            'unknown';

          const agentState = {
            slug,
            name: agent.name,
            status: deps.agentStatus.get(slug) || 'idle',
            model: modelId,
            healthy: !!agent.model && deps.memoryAdapters.has(slug),
          };
          if (hosted) return agentState;
          // #463: no `cost`. Nothing here prices an agent's usage; this row
          // used to carry a literal 0 that `totalCost` then summed into an
          // invented $0 of spend.
          return {
            ...agentState,
            conversationCount: stats?.conversationCount ?? 0,
            messageCount: stats?.messageCount ?? 0,
          };
        }),
      );

      const totalMessages = hosted
        ? undefined
        : agents.reduce(
            (sum, a) => sum + ('messageCount' in a ? a.messageCount : 0),
            0,
          );

      return c.json({
        success: true,
        data: {
          agents,
          summary: {
            totalAgents: agents.length,
            activeAgents: 0,
            runningAgents: 0,
            ...(hosted ? {} : { totalMessages }),
          },
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get historical metrics with date filtering
  app.get('/metrics', async (c) => {
    try {
      const authority = deps.readAuthorityForRequest?.(c.req.raw);
      if (authority && isHostedSessionReadAuthority(authority)) {
        // metricsLog is an unbound process-wide aggregate. Returning an empty
        // projection avoids both population counts and content-derived cost.
        return c.json({
          success: true,
          data: { range: c.req.query('range') || 'all', metrics: [] },
        });
      }
      const range = c.req.query('range') || 'all';
      const now = Date.now();
      let startTime = 0;

      switch (range) {
        case 'today':
          startTime = now - 24 * 60 * 60 * 1000;
          break;
        case 'week':
          startTime = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case 'month':
          startTime = now - 30 * 24 * 60 * 60 * 1000;
          break;
        default:
          startTime = 0;
      }

      const filteredMetrics = deps.metricsLog.filter(
        (m) => m.timestamp >= startTime,
      );

      // Aggregate by agent
      const agentMetrics = new Map<
        string,
        {
          messages: number;
          conversations: Set<string>;
          pricedCost: number;
          priced: number;
          unpriced: number;
        }
      >();
      for (const metric of filteredMetrics) {
        if (!agentMetrics.has(metric.agentSlug)) {
          agentMetrics.set(metric.agentSlug, {
            messages: 0,
            conversations: new Set(),
            pricedCost: 0,
            priced: 0,
            unpriced: 0,
          });
        }
        const stats = agentMetrics.get(metric.agentSlug)!;
        stats.messages += metric.messageCount || 0;
        // #463: a missing cost means UNPRICED, never free. Sum only the
        // priced completions and count the rest, so an agent with no priced
        // completion has no `totalCost` at all rather than an invented $0.
        if (typeof metric.cost === 'number' && Number.isFinite(metric.cost)) {
          stats.pricedCost += metric.cost;
          stats.priced++;
        } else {
          stats.unpriced++;
        }
        if (metric.conversationId) {
          stats.conversations.add(metric.conversationId);
        }
      }

      const summary = Array.from(agentMetrics.entries()).map(
        ([slug, stats]) => ({
          agentSlug: slug,
          messageCount: stats.messages,
          conversationCount: stats.conversations.size,
          // Absent when nothing was priced. When some completions were
          // unpriced, `totalCost` covers only the priced ones and
          // `unpricedCount` says how many it leaves out.
          ...(stats.priced > 0 ? { totalCost: stats.pricedCost } : {}),
          ...(stats.unpriced > 0 ? { unpricedCount: stats.unpriced } : {}),
        }),
      );

      return c.json({ success: true, data: { range, metrics: summary } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get historical events or stream live events (SSE)
  app.get('/events', async (c) => {
    const authority = deps.readAuthorityForRequest?.(c.req.raw);
    const startTime = c.req.query('start');
    const endTime = c.req.query('end');
    const requestedUserId = c.req.query('userId') || c.req.header('x-user-id');
    const fixedOwner = deps.eventOwnerForRequest?.(c.req.raw);
    if (
      fixedOwner === null ||
      (fixedOwner !== undefined &&
        requestedUserId !== undefined &&
        requestedUserId !== fixedOwner)
    ) {
      // An agent reads its session owner's rows. Another person's rows (or
      // every user's) are an operator-wide read: a bound operator caller's.
      return c.json(
        stationControlRefusalBody(
          stationControlRefusal('station_control_role_required'),
        ),
        403,
      );
    }
    const userId = fixedOwner ?? requestedUserId ?? getCachedUser().alias;

    // If time range specified, return historical events as JSON
    if (startTime || endTime) {
      // Parse digit strings as epoch milliseconds before ISO dates (archive#3076).
      // Invalid supplied bounds must fail rather than silently widen the window.
      const parseBound = (value: string | undefined, fallback: number) => {
        if (!value) return fallback;
        const asNumber = /^\d+$/.test(value) ? Number(value) : Number.NaN;
        const parsed = Number.isFinite(asNumber)
          ? asNumber
          : new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : null;
      };
      const start = parseBound(startTime, 0);
      const end = parseBound(endTime, Date.now());
      if (start === null || end === null) {
        return c.json(
          {
            success: false,
            error: `Unparseable time bound: ${start === null ? `start=${startTime}` : `end=${endTime}`}. Use epoch milliseconds or an ISO 8601 timestamp.`,
          },
          400,
        );
      }

      let filteredEvents: any[];
      try {
        filteredEvents = await deps.queryEventsFromDisk(start, end, userId);
      } catch (error) {
        if (error instanceof EventHistoryLimitError) {
          return c.json(
            { success: false, code: error.code, error: error.message },
            413,
          );
        }
        throw error;
      }

      // Slicing lives HERE, not in a second reader (archive#3076). The rows
      // behind the insights rollup are these rows, and this handler already
      // owns the two authorization layers they require: the per-user filter
      // inside queryEventsFromDisk and the tenant predicate in
      // filterMonitoringEvents. A parallel export elsewhere would have to
      // re-derive both, and an export that re-derives an authorization check
      // is an export that eventually gets one wrong.
      const dimension = {
        agent: c.req.query('agent'),
        tool: c.req.query('tool'),
        engine: c.req.query('engine'),
        conversation: c.req.query('conversation'),
        producer: c.req.query('producer'),
      };
      const toolsOnly = c.req.query('tools') === 'true';
      if (
        dimension.producer !== undefined &&
        !isTelemetryProducerName(dimension.producer)
      ) {
        return c.json(
          {
            success: false,
            error: 'producer must be a telemetry producer name.',
          },
          400,
        );
      }
      // Presentation limits apply after the reader enforces its hard budget.
      // Apply the cap only after both authorization layers and content filters.
      const rawLimit = c.req.query('limit');
      const requestedLimit = Number.parseInt(rawLimit ?? '', 10);
      if (rawLimit !== undefined && !(requestedLimit > 0)) {
        return c.json(
          {
            success: false,
            error: `limit must be a positive integer, got: ${rawLimit}`,
          },
          400,
        );
      }
      const limit =
        rawLimit === undefined
          ? undefined
          : Math.min(requestedLimit, MAX_EVENT_QUERY_LIMIT);

      const matching = filterMonitoringEvents(
        filteredEvents,
        authority,
        deps,
      ).filter((event) => {
        const record = event as Record<string, unknown>;
        // A Station filter (agent, engine, tool, conversation, tools-only)
        // never matches an external producer's row, whatever names it
        // reported; naming the producer selects only its rows. Unfiltered
        // reads list everything. `tools` is a Station filter because its
        // callers compare the rows with Station's own tool totals.
        const producer = record[K.TELEMETRY_PRODUCER];
        if (dimension.producer !== undefined) {
          if (producer !== dimension.producer) return false;
        } else if (
          typeof producer === 'string' &&
          (toolsOnly ||
            dimension.agent !== undefined ||
            dimension.tool !== undefined ||
            dimension.engine !== undefined ||
            dimension.conversation !== undefined)
        ) {
          return false;
        }
        if (toolsOnly && record[K.OP_NAME] !== OP.EXECUTE_TOOL) return false;
        if (
          dimension.agent !== undefined &&
          record[K.AGENT_SLUG] !== dimension.agent
        ) {
          return false;
        }
        if (
          dimension.tool !== undefined &&
          record[K.TOOL_NAME] !== dimension.tool
        ) {
          return false;
        }
        if (
          dimension.engine !== undefined &&
          record[K.PROVIDER] !== dimension.engine
        ) {
          return false;
        }
        if (
          dimension.conversation !== undefined &&
          record[K.CONVERSATION_ID] !== dimension.conversation
        ) {
          return false;
        }
        return true;
      });
      // TAIL, not reversal: this endpoint returns rows oldest-first and the
      // Monitoring view relies on it (reversing here broke a pre-existing
      // test, which is the contract speaking). A bounded read of a growing
      // log is only useful from the recent end, so the cap takes the LAST
      // rows and leaves their order alone — the same semantics read_logs
      // uses.
      //
      // Sort before slicing, and sort by the TIMESTAMP. Taking the last N of
      // whatever order the reader happened to produce makes "most recent"
      // an assumption about `readdir`, which POSIX does not define: APFS
      // returns the daily files sorted, ext4/overlayfs — what the shipped
      // container runs on — hash-orders them. Deriving recency from the
      // field that means recency is correct on every filesystem. Rows
      // without a usable timestamp sort oldest rather than being dropped.
      const eventTime = (event: unknown) => {
        const raw = (event as Record<string, unknown>)[K.TIMESTAMP_MS];
        // typeof, not Number(): Number(null) is 0, which is finite, so a row
        // with a null timestamp.ms and a perfectly good ISO `timestamp`
        // sorted as 1970 and got dropped first by a tail slice. Same guard
        // insights.ts already uses.
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        const parsed = Date.parse(
          String((event as Record<string, unknown>).timestamp ?? ''),
        );
        return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
      };
      // ALWAYS, not only when a limit is present. Sorting conditionally gave
      // the endpoint two order contracts selected by whether you passed a
      // cap: adding a limit that drops nothing still reordered the page, and
      // the caller that most needs chronological order — the Monitoring
      // view, which renders a timeline. Write order and timestamp order genuinely disagree after an
      // OTLP backfill, which persists client-supplied timestamps.
      const ordered = [...matching].sort(
        (left, right) => eventTime(left) - eventTime(right),
      );
      const capped = limit === undefined ? ordered : ordered.slice(-limit);

      return c.json({
        success: true,
        data: capped.map((event) =>
          redactMonitoringContent(event as MonitoringEvent),
        ),
        // Says whether rows were DROPPED, not merely whether the cap was
        // reached: a full page that happens to be the whole result set is
        // not truncated.
        truncated: capped.length < matching.length,
      });
    }

    // Otherwise, stream live events via SSE
    return streamSSE(c, async (stream) => {
      const now = Date.now();
      const connectedEvent: MonitoringEvent = {
        timestamp: new Date(now).toISOString(),
        'timestamp.ms': now,
        'trace.id': 'system',
        'gen_ai.operation.name': 'invoke_agent',
        'span.kind': 'log',
        'station.system.type': 'connected',
      };
      await stream.writeSSE({ data: JSON.stringify(connectedEvent) });

      const eventHandler = (event: any) => {
        if (event.userId && event.userId !== userId) return;
        // An agent's stream carries only rows its owner is named on.
        if (
          fixedOwner !== undefined &&
          event.userId !== fixedOwner &&
          event['station.user.id'] !== fixedOwner
        )
          return;
        if (!canReadMonitoringEvent(event, authority, deps)) return;
        stream
          .writeSSE({
            data: JSON.stringify(
              redactMonitoringContent(event as MonitoringEvent),
            ),
          })
          .catch(() => {});
      };

      deps.monitoringEvents.on('event', eventHandler);

      const interval = setInterval(() => {
        const hbNow = Date.now();
        const heartbeatEvent: MonitoringEvent = {
          timestamp: new Date(hbNow).toISOString(),
          'timestamp.ms': hbNow,
          'trace.id': 'system',
          'gen_ai.operation.name': 'invoke_agent',
          'span.kind': 'log',
          'station.system.type': 'heartbeat',
        };
        stream
          .writeSSE({ data: JSON.stringify(heartbeatEvent) })
          .catch(() => {});
      }, SSE_KEEPALIVE_INTERVAL_MS);

      try {
        await new Promise((_, reject) => {
          stream.onAbort(() => reject(new Error('aborted')));
        });
      } catch {
        /* client disconnected */
      }

      clearInterval(interval);
      deps.monitoringEvents.off('event', eventHandler);
    });
  });

  return app;
}

function filterMonitoringEvents(
  events: readonly unknown[],
  authority: SessionReadAuthority | undefined,
  deps: MonitoringDeps,
): unknown[] {
  return events.filter((event) =>
    canReadMonitoringEvent(event, authority, deps),
  );
}

/**
 * archive#3130: exported so `/api/insights` applies the SAME predicate instead
 * of re-deriving one. The `/events` handler's own comment warns that a parallel
 * reader "would have to re-derive both, and an export that re-derives an
 * authorization check is an export that eventually gets one wrong" — insights
 * was that reader, and it derived neither.
 */
export function canReadMonitoringEvent(
  event: unknown,
  authority: SessionReadAuthority | undefined,
  // Narrowed to what this predicate actually reads, so a second caller need
  // not fabricate an entire MonitoringDeps to ask an authorization question.
  deps: Pick<MonitoringDeps, 'canReadMonitoringEvent'>,
): boolean {
  // A partial hosted composition must not turn into an authorization bypass.
  // Generic non-session telemetry has no session/content identifier and stays
  // available; session-bearing rows require both pieces of central policy.
  const hosted = authority && isHostedSessionReadAuthority(authority);
  // A row a telemetry producer delivered belongs to the principal who owns
  // that token, whatever session id its producer reported: an external
  // agent's session is not a Station session, so the session predicate below
  // refused every such row. The owner key is written by the ingest receiver
  // from the admitted token, never copied from a body. Producer rows are
  // personal-mode only; hosted readers never see them.
  if (event && typeof event === 'object' && K.TELEMETRY_PRODUCER in event) {
    const owner = (event as Record<string, unknown>)[
      K.TELEMETRY_PRODUCER_OWNER
    ];
    return (
      !hosted &&
      typeof owner === 'string' &&
      owner.length > 0 &&
      authority?.userId === owner
    );
  }
  const sessionId = monitoringSessionIdentity(event);
  if (sessionId) {
    // In hosted mode an identity is necessary but not sufficient: route
    // composition must also supply the central session predicate.
    if (!deps.canReadMonitoringEvent) return !hosted;
    if (hosted && !authority.tenantExecutionContext) return false;
    return (
      authority !== undefined &&
      deps.canReadMonitoringEvent(event, authority) === true
    );
  }
  // Content with no resolvable session cannot be attached to a tenant.
  // Generic host-health frames deliberately remain visible.
  return !(hosted && isContentBearingMonitoringEvent(event));
}
