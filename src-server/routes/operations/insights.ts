import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import { Hono } from 'hono';
import {
  K,
  monitoringAgentName,
  OP,
  SPAN,
} from '../../../src-shared/monitoring-keys.js';
import { monitoringSessionIdentity } from '../../monitoring/monitoring-session-identity.js';
import { insightOps } from '../../telemetry/metrics.js';
import { getCachedUser } from '../system/auth.js';
import { canReadMonitoringEvent } from './monitoring.js';

/**
 * A derived absence, never a value. Parenthesized so it cannot collide with
 * a real tool name — including the literal 'unknown' that events written
 * before station#3073 baked in at write time, which stays its own bucket so
 * the two eras remain distinguishable.
 */
const UNNAMED_TOOL = '(unnamed)';
// Same discipline for agents: a derived absence, never a value (#3082).
// Imported, not re-declared: the Monitoring view filters, lists and
// counts by this same name, and three independent copies is how the
// sidebar came to disagree with the two that already matched.

type MonitoringEventRecord = Record<string, unknown>;

function timestampFor(event: MonitoringEventRecord): number | null {
  const timestampMs = event[K.TIMESTAMP_MS];
  if (typeof timestampMs === 'number' && Number.isFinite(timestampMs)) {
    return timestampMs;
  }
  const timestampValue = event[K.TIMESTAMP];
  if (typeof timestampValue === 'string') {
    const timestamp = Date.parse(timestampValue);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function isHealthProbe(event: MonitoringEventRecord): boolean {
  const traceId = event[K.TRACE_ID];
  return (
    (typeof traceId === 'string' && traceId.startsWith('health:')) ||
    K.HEALTHY in event ||
    K.HEALTH_CHECKS in event ||
    K.HEALTH_INTEGRATIONS in event
  );
}

/**
 * Keep the highest-ranked `limit` entries of a bucket map. Absent `limit`
 * returns the map untouched, so the default response shape is unchanged.
 */
function applyLimit<T>(
  buckets: Record<string, T>,
  limit: number | undefined,
  rank: (value: T) => number,
): Record<string, T> {
  if (limit === undefined) return buckets;
  return Object.fromEntries(
    Object.entries(buckets)
      .sort(([, a], [, b]) => rank(b) - rank(a))
      .slice(0, limit),
  );
}

/**
 * station#3130: this route reads the SAME monitoring directory as
 * `GET /monitoring/events`, which scopes rows two ways — a per-user predicate
 * and a tenant predicate. This one applied neither, so on a multi-user or
 * hosted install it aggregated every user's events into one rollup.
 *
 * Both layers are now required inputs rather than optional conveniences: the
 * predicate is imported from the monitoring route (not re-derived), and the
 * per-user check mirrors `queryEventsFromDisk`'s exactly.
 */
export function createInsightsRoutes(
  monitoringDir: string,
  authz?: {
    readAuthorityForRequest?: (
      request: Request,
    ) => SessionReadAuthority | undefined;
    canReadMonitoringEvent?: (
      event: unknown,
      authority: SessionReadAuthority,
    ) => boolean;
  },
) {
  const app = new Hono();

  app.get('/', async (c) => {
    const days = parseInt(c.req.query('days') || '14', 10);
    insightOps.add(1, { op: 'get_insights' });
    const cutoff = Date.now() - days * MS_PER_DAY;
    // Filters (station#3075). Every dimension here is already on the event;
    // only the endpoint refused to use it, so "tool usage for THIS agent" —
    // the first question anyone asks of the dashboard — meant writing a new
    // consumer. `engine` reads gen_ai.provider.name, present on tool events
    // since station#3074; events written before that carry no engine, so an
    // engine filter necessarily excludes them rather than guessing.
    // Scope note, because these interact (station#3075 review):
    // - `tool` filters the whole scan, so chats/agents/models go to zero for
    //   a tool-filtered request. Tool numbers are the answer; the others are
    //   not "no chats", they are "not asked".
    // - `engine` reads gen_ai.provider.name, which agent-complete does not
    //   carry, so modelUsage is structurally empty under an engine filter.
    // Both are documented in api.md rather than silently shaped.
    const filters = {
      agent: c.req.query('agent'),
      tool: c.req.query('tool'),
      engine: c.req.query('engine'),
    };
    const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 500)
        : undefined;
    const matchesFilters = (event: MonitoringEventRecord): boolean => {
      if (
        filters.agent !== undefined &&
        // Compare through the SHARED naming rule, the same one that produced
        // the bucket keys a caller reads off this rollup. Comparing the raw
        // field means the one agent name the codebase explicitly expects a
        // human to click — '(unnamed)', which exists precisely so slug-less
        // rows are selectable (station#3086) — matches nothing, and the row
        // reading "(unnamed): 47 chats" filters to an all-zero rollup.
        monitoringAgentName(event) !== filters.agent
      ) {
        return false;
      }
      if (filters.tool !== undefined && event[K.TOOL_NAME] !== filters.tool) {
        return false;
      }
      if (
        filters.engine !== undefined &&
        event[K.PROVIDER] !== filters.engine
      ) {
        return false;
      }
      return true;
    };

    const toolUsage: Record<
      string,
      { calls: number; errors: number; outcomeUnknown: number }
    > = {};
    const hourlyActivity: number[] = new Array(24).fill(0);
    const agentUsage: Record<string, { chats: number; tokens: number }> = {};
    const modelUsage: Record<string, number> = {};
    const chatTraceIds = new Set<string>();
    const agentChatTraceIds = new Map<string, Set<string>>();
    let noSessionChats = 0;
    let totalToolCalls = 0;
    let totalErrors = 0;
    let totalOutcomeUnknown = 0;

    if (!existsSync(monitoringDir))
      return c.json({
        success: true,
        data: {
          toolUsage: {},
          hourlyActivity,
          agentUsage: {},
          modelUsage: {},
          totalChats: 0,
          totalToolCalls: 0,
          totalErrors: 0,
          // Same shape as the populated path: a client has LEAST data to
          // sanity-check here, so dropping the honest denominator and the
          // applied-filter echo is exactly the wrong place to do it.
          totalOutcomeUnknown: 0,
          days,
          ...(filters.agent !== undefined ||
          filters.tool !== undefined ||
          filters.engine !== undefined ||
          limit !== undefined
            ? {
                applied: {
                  ...(filters.agent !== undefined
                    ? { agent: filters.agent }
                    : {}),
                  ...(filters.tool !== undefined ? { tool: filters.tool } : {}),
                  ...(filters.engine !== undefined
                    ? { engine: filters.engine }
                    : {}),
                  ...(limit !== undefined ? { limit } : {}),
                },
              }
            : {}),
        },
      });

    const authority = authz?.readAuthorityForRequest?.(c.req.raw);
    // Identical resolution to /monitoring/events (monitoring.ts:330-333),
    // including the alias fallback. Without it the product's only caller
    // (`fetchInsights` sends `?days=N` and nothing else) got an UNSCOPED
    // rollup — the hole station#3130 was filed about, still open through the
    // front door.
    const callerUserId =
      c.req.query('userId') ||
      c.req.header('x-user-id') ||
      getCachedUser().alias;
    // The session predicate reaches sessionOwnerUserId, which deliberately
    // never caches a NEGATIVE, so an ownerless thread re-runs a synchronous
    // SQLite ownership scan (~4.4ms, its own docblock) for EVERY row. On a
    // corpus with ~14.6k unattributed rows that is tens of seconds of
    // event-loop blocking per request. One decision per thread per request.
    const perThreadDecision = new Map<string, boolean>();
    const readableByCaller = (event: MonitoringEventRecord): boolean => {
      // Mirrors runtime-event-log.ts's queryEventsFromDisk predicate. An
      // unattributed row is NOT admitted: "unowned means everyone's" is the
      // wrong default on a hosted install (station#3130).
      const record = event as unknown as Record<string, unknown>;
      // callerUserId is always defined now (alias fallback), so this always
      // runs — matching queryEventsFromDisk, whose userId parameter is
      // required and whose predicate is never skipped.
      if (
        record.userId !== callerUserId &&
        record['station.user.id'] !== callerUserId
      )
        return false;
      // Route EVERY case through the shared predicate, including an absent
      // authority. Short-circuiting `!authority -> true` made this admit rows
      // that /monitoring/events denies whenever a composition supplies the
      // predicate but not the authority resolver — re-deriving the answer,
      // which is the hazard the export exists to prevent.
      // The same identity the predicate itself keys on, so the memo can never
      // conflate two sessions.
      const threadKey = monitoringSessionIdentity(event);
      const cached =
        threadKey === undefined ? undefined : perThreadDecision.get(threadKey);
      if (cached !== undefined) return cached;
      const decision = canReadMonitoringEvent(event, authority, {
        ...(authz?.canReadMonitoringEvent
          ? { canReadMonitoringEvent: authz.canReadMonitoringEvent }
          : {}),
      });
      if (threadKey !== undefined) perThreadDecision.set(threadKey, decision);
      return decision;
    };

    const files = await readdir(monitoringDir);
    for (const file of files.filter(
      (f) => f.startsWith('events-') && f.endsWith('.ndjson'),
    )) {
      try {
        const stream = createReadStream(join(monitoringDir, file));
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as MonitoringEventRecord;
            const ts = timestampFor(event);
            if (ts === null || ts < cutoff || isHealthProbe(event)) continue;
            // station#3130: the same two layers `/monitoring/events` applies.
            // Per-user first, matching `queryEventsFromDisk`'s predicate
            // exactly; then the central tenant predicate, imported rather than
            // re-derived. Without these this rollup counted every user's rows.
            if (!readableByCaller(event)) continue;

            const operation = event[K.OP_NAME];
            const spanKind = event[K.SPAN_KIND];
            // Usage-record envelopes have no GenAI operation and are excluded.
            if (typeof operation !== 'string') continue;
            if (!matchesFilters(event)) continue;

            const hour = new Date(ts).getHours();
            hourlyActivity[hour]++;

            if (
              operation === OP.INVOKE_AGENT &&
              (spanKind === SPAN.START || spanKind === SPAN.END)
            ) {
              const traceId = event[K.TRACE_ID];
              if (
                typeof traceId === 'string' &&
                traceId &&
                traceId !== 'no-session'
              ) {
                chatTraceIds.add(traceId);
              }

              // The shared rule, not a byte-equivalent copy of it. The copy
              // was correct; the next edit to either is what breaks, and
              // "treat the legacy 'unknown' population as absence too" is a
              // plausible next edit that would have silently split the two
              // surfaces again.
              const agent = monitoringAgentName(event);
              if (!agentUsage[agent]) {
                agentUsage[agent] = { chats: 0, tokens: 0 };
              }
              // Real traces count once per agent even when their start and end
              // spans are both present. `no-session` is a shared sentinel, so
              // each END is counted as one chat instead. Live telemetry has
              // reliable terminal spans but may miss a start-only invocation.
              if (traceId === 'no-session' && spanKind === SPAN.END) {
                noSessionChats++;
                agentUsage[agent].chats++;
              } else if (
                typeof traceId === 'string' &&
                traceId &&
                traceId !== 'no-session'
              ) {
                const agentTraces = agentChatTraceIds.get(agent) ?? new Set();
                if (!agentTraces.has(traceId)) {
                  agentTraces.add(traceId);
                  agentUsage[agent].chats++;
                }
                agentChatTraceIds.set(agent, agentTraces);
              }
              if (spanKind === SPAN.END) {
                const model = event[K.MODEL];
                if (typeof model === 'string' && model) {
                  modelUsage[model] = (modelUsage[model] || 0) + 1;
                }
              }
            }
            if (operation === OP.EXECUTE_TOOL && spanKind === SPAN.START) {
              totalToolCalls++;
              // '(unnamed)', not 'unknown': the bucket must be
              // distinguishable from a tool actually NAMED unknown, and from
              // the literal string older events baked in at write time
              // (station#3073). Parenthesized because no real tool name is.
              const toolValue = event[K.TOOL_NAME];
              const tool =
                typeof toolValue === 'string' && toolValue
                  ? toolValue
                  : UNNAMED_TOOL;
              if (!toolUsage[tool]) {
                toolUsage[tool] = { calls: 0, errors: 0, outcomeUnknown: 0 };
              }
              toolUsage[tool].calls++;
            }
            // Count only the explicit producer-reported outcome. Tool output is
            // opaque, and events without this field are legacy/unknown rather
            // than retroactively assumed to have succeeded or failed.
            if (operation === OP.EXECUTE_TOOL && spanKind === SPAN.END) {
              const outcome = event[K.TOOL_CALL_OUTCOME];
              const toolValue = event[K.TOOL_NAME];
              const tool =
                typeof toolValue === 'string' && toolValue
                  ? toolValue
                  : UNNAMED_TOOL;
              if (!toolUsage[tool]) {
                toolUsage[tool] = { calls: 0, errors: 0, outcomeUnknown: 0 };
              }
              if (outcome === 'error') {
                totalErrors++;
                toolUsage[tool].errors++;
              } else if (outcome !== 'success') {
                // The emitter OMITS the outcome when the producer reported
                // no terminal status, so these results are neither successes
                // nor failures. Counting them only in `calls` made the error
                // RATE read better than reality with no signal that the
                // denominator was partly unobserved (station#3075).
                totalOutcomeUnknown++;
                toolUsage[tool].outcomeUnknown++;
              }
            }
          } catch (e) {
            console.debug('Failed to parse insights event line:', e);
          }
        }
      } catch (e) {
        console.debug('Failed to read insights event file:', e);
      }
    }

    return c.json({
      success: true,
      data: {
        // Top-N server-side when asked (station#3075): the client used to
        // sort and slice, so a caller that is not the dashboard had to pull
        // every bucket to see the top ten.
        toolUsage: applyLimit(toolUsage, limit, (bucket) => bucket.calls),
        hourlyActivity,
        agentUsage: applyLimit(agentUsage, limit, (bucket) => bucket.chats),
        modelUsage: applyLimit(modelUsage, limit, (count) => count),
        totalChats: chatTraceIds.size + noSessionChats,
        totalToolCalls,
        totalErrors,
        /**
         * Tool results whose producer reported no terminal status. They are
         * in `totalToolCalls` but are neither successes nor failures, so an
         * error rate computed without them silently flatters itself.
         */
        totalOutcomeUnknown,
        days,
        ...(filters.agent !== undefined ||
        filters.tool !== undefined ||
        filters.engine !== undefined ||
        limit !== undefined
          ? {
              // Echo what was applied: a filtered rollup that looks like a
              // whole-corpus one is how a reader draws the wrong conclusion.
              applied: {
                ...(filters.agent !== undefined
                  ? { agent: filters.agent }
                  : {}),
                ...(filters.tool !== undefined ? { tool: filters.tool } : {}),
                ...(filters.engine !== undefined
                  ? { engine: filters.engine }
                  : {}),
                ...(limit !== undefined ? { limit } : {}),
              },
            }
          : {}),
      },
    });
  });

  return app;
}
