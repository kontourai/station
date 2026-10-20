import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { PRODUCER_ID_PREFIX } from '../../src-shared/monitoring-keys.js';
import { MONITORING_SESSION_ID_KEYS } from './monitoring-session-identity.js';
import type {
  AgentTelemetryIngestEvent,
  GenAiOperationName,
  MonitoringEvent,
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpLogsPayload,
  OtlpTracesPayload,
} from './schema.js';
import { K, OP, SPAN } from './schema.js';

function getAttr(attrs: OtlpKeyValue[], key: string): OtlpAnyValue | undefined {
  return attrs.find((a) => a.key === key)?.value;
}

function attrStr(attrs: OtlpKeyValue[], key: string): string | undefined {
  return getAttr(attrs, key)?.stringValue;
}

function attrNum(attrs: OtlpKeyValue[], key: string): number | undefined {
  const v = getAttr(attrs, key);
  if (!v) return undefined;
  if (v.intValue !== undefined) return Number(v.intValue);
  return v.doubleValue;
}

/**
 * The agent telemetry ingest schema, keyed by `schema_version`. Every 0.x
 * version shares this shape and adds fields only, so unknown fields pass
 * through (Flow Agents 0.3.0 sends `hook`, `install_identity` and
 * `run_correlation`). Another major version is refused rather than guessed
 * at. `event_type` is an open vocabulary: a type this mapping does not name
 * is recorded as an `unknown` event rather than refused.
 */
const AGENT_TELEMETRY_SCHEMA_VERSION = /^0\.\d{1,4}(?:\.\d{1,4})?$/;
const boundedText = (max: number) => z.string().min(1).max(max);
const agentTelemetryIngestEventSchema = z.looseObject({
  schema_version: z.string().max(32),
  timestamp: z
    .union([z.string().max(64), z.number()])
    .refine(
      (value) => parseIngestTimestamp(value) !== undefined,
      'must be epoch milliseconds or an ISO-8601 date-time',
    ),
  session_id: boundedText(256),
  event_id: boundedText(256),
  event_type: boundedText(64),
  agent: z.looseObject({
    name: boundedText(256),
    runtime: z.string().max(256),
    version: z.string().max(256),
  }),
  context: z.looseObject({}).optional(),
  enrichment: z.looseObject({}).optional(),
  turn: z.looseObject({}).optional(),
  tool: z
    .looseObject({
      name: z.string().max(256).optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
    })
    .optional(),
  session: z.looseObject({}).optional(),
  delegation: z.looseObject({}).optional(),
});

/** Largest magnitude a JavaScript Date holds (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;
const ISO_8601_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The ISO form, with every component in range: `Date` would otherwise roll
 * `2026-02-30` over to March 2 and accept hour 24. Lowercase `z` and a space
 * separator are refused; the contract names the strict form only.
 */
function parseIsoDateTime(value: string): number | undefined {
  const match = ISO_8601_DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second = '0', offH = '0', offM = '0'] =
    match.slice(1).map((part) => part ?? '0');
  const [y, mo, d] = [Number(year), Number(month), Number(day)];
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, mo - 1, d);
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== mo - 1 ||
    calendar.getUTCDate() !== d ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offH) > 23 ||
    Number(offM) > 59
  )
    return undefined;
  return new Date(value).getTime();
}

/**
 * Epoch milliseconds (digits, or a JSON integer as older producers sent) or
 * an ISO 8601 date-time with an explicit offset; anything else, including
 * `Date`-parseable prose, is `undefined`. The range check matters: an
 * out-of-range time value passes `isFinite` but makes `toISOString()`
 * throw, which was a 500 instead of a 400.
 */
function parseIngestTimestamp(value: string | number): number | undefined {
  const ms =
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
        ? value
        : Number.NaN
      : /^\d{1,16}$/.test(value)
        ? Number(value)
        : (parseIsoDateTime(value) ?? Number.NaN);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : undefined;
}

type IngestRefusal = {
  code: 'invalid_json' | 'unsupported_schema_version' | 'invalid_agent_event';
  message: string;
};

async function readJsonBody(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function validateAgentEvent(
  value: unknown,
): { ok: true; event: AgentTelemetryIngestEvent } | IngestRefusal {
  const version =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { schema_version?: unknown }).schema_version
      : undefined;
  if (
    typeof version !== 'string' ||
    !AGENT_TELEMETRY_SCHEMA_VERSION.test(version)
  )
    return {
      code: 'unsupported_schema_version',
      message:
        'schema_version must be a supported agent telemetry version (0.x).',
    };
  const parsed = agentTelemetryIngestEventSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      code: 'invalid_agent_event',
      message: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, event: parsed.data as AgentTelemetryIngestEvent };
}

/**
 * Every identity a producer row may carry that a reader groups, filters or
 * de-duplicates by: session, trace, tool-call and event ids, and the agent
 * and engine. Namespacing the agent and engine (rather than dropping producer
 * rows from agent aggregates) keeps Insights honest both ways: a producer
 * claiming agent `default` or engine `station` adds nothing to that Station
 * agent or engine, and its own activity still appears, under its own name.
 */
const PRODUCER_NAMESPACED_KEYS: readonly string[] = [
  K.TRACE_ID,
  K.TOOL_CALL_ID,
  K.AT_EVENT_ID,
  K.AGENT_SLUG,
  K.PROVIDER,
  ...MONITORING_SESSION_ID_KEYS,
];

type KnownAgentEventType =
  | 'session.start'
  | 'session.end'
  | 'turn.user'
  | 'tool.invoke'
  | 'tool.result'
  | 'agent.delegate'
  | 'unknown';

function nowMs(): number {
  return Date.now();
}

function baseEvent(
  traceId: string | undefined,
  attrs: OtlpKeyValue[],
  spanKind: MonitoringEvent['span.kind'],
  instanceUserId: string | undefined,
): MonitoringEvent {
  // A producer that reports the user is the better authority than this
  // instance's own account; the receiving instance's user is what an OTLP
  // sender that reports none belongs to. Either way `''` is not an id
  // (archive#3086), so the key is omitted rather than written empty.
  const userId = attrStr(attrs, K.USER_ID) || instanceUserId;
  return {
    timestamp: new Date().toISOString(),
    [K.TIMESTAMP_MS]: nowMs(),
    // Same rule for the trace id, and this is the one place it arrives off
    // the wire: the body is unvalidated, so a sender that omits `traceId`
    // or sends `""` must not be recorded as having reported one (archive#3115).
    ...(traceId ? { [K.TRACE_ID]: traceId } : {}),
    [K.OP_NAME]: (attrStr(attrs, K.OP_NAME) as GenAiOperationName) ?? OP.CHAT,
    [K.PROVIDER]: attrStr(attrs, K.PROVIDER),
    [K.MODEL]: attrStr(attrs, K.MODEL),
    [K.CONVERSATION_ID]: attrStr(attrs, K.CONVERSATION_ID),
    [K.INPUT_TOKENS]: attrNum(attrs, K.INPUT_TOKENS),
    [K.OUTPUT_TOKENS]: attrNum(attrs, K.OUTPUT_TOKENS),
    [K.TOOL_NAME]: attrStr(attrs, K.TOOL_NAME),
    [K.TOOL_CALL_ID]: attrStr(attrs, K.TOOL_CALL_ID),
    [K.AGENT_SLUG]: attrStr(attrs, K.AGENT_SLUG),
    [K.SPAN_KIND]: spanKind,
    ...(userId ? { [K.USER_ID]: userId } : {}),
  };
}

/**
 * archive#3130: every event this receiver builds went to `emitRaw`, the one
 * `MonitoringEmitter` entry point that does not take a `userId` — so none of
 * them carried `station.user.id`, and `queryEvents` (`runtime-event-log.ts`)
 * admits a row only when that field equals the querying user. Ingested rows
 * were therefore invisible to the Monitoring view and to every export built on
 * it, which on the owner's corpus was 14,612 of 29,938 rows and all but one of
 * 12,367 `execute_tool` rows.
 *
 * `resolveUserId` is required, not optional: the omission is exactly what a
 * defaulted parameter would keep reproducing. It is the same identity the read
 * side defaults to and every other writer stamps — `getCachedUser().alias`,
 * injected at the mount seam so this module keeps no route-layer dependency.
 *
 * What the field claims here is scope, not authorship: which Station user's
 * monitoring view a row belongs to. Station has exactly one user identity
 * (even hosted `SessionReadAuthority` derives `userId` from the same call and
 * isolates on tenant instead), and a row this instance ingested belongs to
 * that instance's user by construction.
 */
export function createOtlpReceiverRoutes(
  emit: (event: MonitoringEvent) => void,
  resolveUserId: () => string | undefined,
  /**
   * The telemetry producer the auth boundary admitted for this request, or
   * `undefined` for a paired credential. Required for the same reason
   * `resolveUserId` is: a defaulted resolver silently drops attribution.
   */
  resolveProducer: (
    c: Context,
  ) => { name: string; ownerPrincipalId: string } | undefined,
): Hono {
  const app = new Hono();
  const attributed = (c: Context, event: MonitoringEvent): MonitoringEvent => {
    const producer = resolveProducer(c);
    if (!producer) return event;
    // A producer is a low-trust, possibly remote sender. An id it reports
    // must never equal a Station session, trace or tool-call id: a row that
    // joined a Station conversation would put producer text into that
    // conversation's timeline and into what agents read about it. Every
    // identity it supplies is namespaced by the token name, so it can only
    // ever group with that producer's own rows.
    const namespaced: Record<string, unknown> = {};
    for (const key of PRODUCER_NAMESPACED_KEYS) {
      const value = (event as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0)
        namespaced[key] = `${PRODUCER_ID_PREFIX}${producer.name}:${value}`;
    }
    // A slug-less producer row would otherwise join Station's own
    // `(unnamed)` agent bucket.
    if (namespaced[K.AGENT_SLUG] === undefined)
      namespaced[K.AGENT_SLUG] =
        `${PRODUCER_ID_PREFIX}${producer.name}:(unnamed)`;
    // Last, so no mapped field can shadow the server-derived attribution.
    return {
      ...event,
      ...namespaced,
      [K.TELEMETRY_PRODUCER]: producer.name,
      [K.TELEMETRY_PRODUCER_OWNER]: producer.ownerPrincipalId,
    };
  };

  app.post('/v1/traces', async (c) => {
    try {
      const body = await c.req.json<OtlpTracesPayload>();
      let accepted = 0;
      for (const rs of body.resourceSpans) {
        for (const ss of rs.scopeSpans) {
          for (const span of ss.spans) {
            const kind: MonitoringEvent['span.kind'] = span.endTimeUnixNano
              ? SPAN.END
              : SPAN.START;
            emit(
              attributed(
                c,
                baseEvent(span.traceId, span.attributes, kind, resolveUserId()),
              ),
            );
            accepted++;
          }
        }
      }
      return c.json({ success: true, accepted });
    } catch {
      return c.json({ error: 'parse error' }, 400);
    }
  });

  app.post('/v1/logs', async (c) => {
    try {
      const body = await c.req.json<OtlpLogsPayload>();
      let accepted = 0;
      for (const rl of body.resourceLogs) {
        for (const sl of rl.scopeLogs) {
          for (const rec of sl.logRecords) {
            emit(
              attributed(
                c,
                baseEvent(
                  rec.traceId,
                  rec.attributes,
                  SPAN.LOG,
                  resolveUserId(),
                ),
              ),
            );
            accepted++;
          }
        }
      }
      return c.json({ success: true, accepted });
    } catch {
      return c.json({ error: 'parse error' }, 400);
    }
  });

  const EVENT_OP: Record<KnownAgentEventType, GenAiOperationName> = {
    'session.start': OP.INVOKE_AGENT,
    'session.end': OP.INVOKE_AGENT,
    'turn.user': OP.CHAT,
    'tool.invoke': OP.EXECUTE_TOOL,
    'tool.result': OP.EXECUTE_TOOL,
    'agent.delegate': OP.INVOKE_AGENT,
    unknown: OP.CHAT,
  };

  const EVENT_KIND: Record<KnownAgentEventType, MonitoringEvent['span.kind']> =
    {
      'session.start': SPAN.START,
      'session.end': SPAN.END,
      'turn.user': SPAN.EVENT,
      'tool.invoke': SPAN.START,
      'tool.result': SPAN.END,
      'agent.delegate': SPAN.EVENT,
      unknown: SPAN.EVENT,
    };
  const knownType = (type: string): KnownAgentEventType =>
    Object.hasOwn(EVENT_OP, type) ? (type as KnownAgentEventType) : 'unknown';

  app.post('/v1/agent-events', async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok)
      return c.json(
        {
          error: {
            code: 'invalid_json',
            message: 'The body must be one JSON agent event.',
          },
        },
        400,
      );
    const validated = validateAgentEvent(body.value);
    if (!('ok' in validated))
      return c.json(
        { error: { code: validated.code, message: validated.message } },
        400,
      );
    const ev = validated.event;
    const tsMs = parseIngestTimestamp(ev.timestamp);
    // Unreachable after validation; kept so the two can never disagree.
    if (tsMs === undefined)
      return c.json(
        {
          error: {
            code: 'invalid_agent_event',
            message:
              'timestamp: must be epoch milliseconds or an ISO-8601 date-time',
          },
        },
        400,
      );
    const type = knownType(ev.event_type);
    // Unlike the OTLP paths above there is no producer-reported user to
    // prefer: `AgentTelemetryIngestEvent` declares no user field at all.
    const userId = resolveUserId();
    const event: MonitoringEvent = {
      timestamp: new Date(tsMs).toISOString(),
      [K.TIMESTAMP_MS]: tsMs,
      [K.TRACE_ID]: ev.session_id,
      [K.OP_NAME]: EVENT_OP[type],
      [K.SPAN_KIND]: EVENT_KIND[type],
      [K.AGENT_SLUG]: ev.agent.name,
      ...(userId ? { [K.USER_ID]: userId } : {}),
      [K.AT_SESSION_ID]: ev.session_id,
      [K.AT_EVENT_ID]: ev.event_id,
      [K.AT_SCHEMA_VERSION]: ev.schema_version,
      [K.AT_CONTEXT]: ev.context,
      [K.AT_ENRICHMENT]: ev.enrichment,
      ...(ev.tool?.name && { [K.TOOL_NAME]: ev.tool.name }),
      // The ingest schema declares tool.input and this mapping dropped it
      // (archive#3078), so an ingested agent's tool arguments were absent
      // rather than redacted-but-present — and a reader could not tell
      // "takes no arguments" from "we threw them away". It rides the same
      // redaction seam as every locally produced event.
      ...(ev.tool?.input !== undefined && {
        [K.TOOL_CALL_ARGS]: ev.tool.input,
      }),
      ...(ev.tool?.output !== undefined && {
        [K.TOOL_CALL_RESULT]: ev.tool.output,
      }),
    };
    emit(attributed(c, event));
    return c.json({ success: true });
  });

  return app;
}
