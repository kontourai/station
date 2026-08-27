import { Hono } from 'hono';
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
  // (station#3086), so the key is omitted rather than written empty.
  const userId = attrStr(attrs, K.USER_ID) || instanceUserId;
  return {
    timestamp: new Date().toISOString(),
    [K.TIMESTAMP_MS]: nowMs(),
    // Same rule for the trace id, and this is the one place it arrives off
    // the wire: the body is unvalidated, so a sender that omits `traceId`
    // or sends `""` must not be recorded as having reported one (#3115).
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
 * station#3130: every event this receiver builds went to `emitRaw`, the one
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
): Hono {
  const app = new Hono();

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
              baseEvent(span.traceId, span.attributes, kind, resolveUserId()),
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
              baseEvent(rec.traceId, rec.attributes, SPAN.LOG, resolveUserId()),
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

  const EVENT_OP: Record<
    AgentTelemetryIngestEvent['event_type'],
    GenAiOperationName
  > = {
    'session.start': OP.INVOKE_AGENT,
    'session.end': OP.INVOKE_AGENT,
    'turn.user': OP.CHAT,
    'tool.invoke': OP.EXECUTE_TOOL,
    'tool.result': OP.EXECUTE_TOOL,
    'agent.delegate': OP.INVOKE_AGENT,
    unknown: OP.CHAT,
  };

  const EVENT_KIND: Record<
    AgentTelemetryIngestEvent['event_type'],
    MonitoringEvent['span.kind']
  > = {
    'session.start': SPAN.START,
    'session.end': SPAN.END,
    'turn.user': SPAN.EVENT,
    'tool.invoke': SPAN.START,
    'tool.result': SPAN.END,
    'agent.delegate': SPAN.EVENT,
    unknown: SPAN.EVENT,
  };

  app.post('/v1/agent-events', async (c) => {
    try {
      const ev = await c.req.json<AgentTelemetryIngestEvent>();
      const tsMs = /^\d+$/.test(ev.timestamp)
        ? Number(ev.timestamp)
        : new Date(ev.timestamp).getTime();
      // Unlike the OTLP paths above there is no producer-reported user to
      // prefer: `AgentTelemetryIngestEvent` declares no user field at all.
      const userId = resolveUserId();
      const event: MonitoringEvent = {
        timestamp: new Date(tsMs).toISOString(),
        [K.TIMESTAMP_MS]: tsMs,
        [K.TRACE_ID]: ev.session_id,
        [K.OP_NAME]: EVENT_OP[ev.event_type],
        [K.SPAN_KIND]: EVENT_KIND[ev.event_type],
        [K.AGENT_SLUG]: ev.agent.name,
        ...(userId ? { [K.USER_ID]: userId } : {}),
        [K.AT_SESSION_ID]: ev.session_id,
        [K.AT_EVENT_ID]: ev.event_id,
        [K.AT_SCHEMA_VERSION]: ev.schema_version,
        [K.AT_CONTEXT]: ev.context,
        [K.AT_ENRICHMENT]: ev.enrichment,
        ...(ev.tool?.name && { [K.TOOL_NAME]: ev.tool.name }),
        // The ingest schema declares tool.input and this mapping dropped it
        // (station#3078), so an ingested agent's tool arguments were absent
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
      emit(event);
      return c.json({ success: true });
    } catch {
      return c.json({ error: 'parse error' }, 400);
    }
  });

  return app;
}
