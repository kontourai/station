/**
 * OTel GenAI Semantic Convention–aligned monitoring schema.
 *
 * References:
 *   - https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 *   - https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *   - https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/
 *
 * Attribute names use OTel dot-notation stored as flat keys so the
 * monitoring UI can parse events from any OTLP-compatible source.
 */

// ── GenAI operation names (OTel well-known values) ──────────────────

export type GenAiOperationName =
  | 'chat'
  | 'invoke_agent'
  | 'execute_tool'
  | 'embeddings'
  | 'text_completion';

// ── Attribute key constants ─────────────────────────────────────────
// Re-exported from shared — single source of truth for both UI and server.
export { K, OP, SPAN } from '../../src-shared/monitoring-keys.js';

// ── Monitoring event: OTel-shaped, flat attributes ──────────────────

export interface MonitoringEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Epoch ms for sorting/filtering */
  'timestamp.ms': number;
  /**
   * OTel trace ID. Optional for the same reason `gen_ai.conversation.id` is:
   * a span whose trace is unknown has no trace id, and `''` is not the way to
   * say that (archive#3086/#3115). Readers already treat it as possibly
   * absent; the emitter omits the key rather than writing it empty.
   */
  'trace.id'?: string;

  // ── GenAI core ──
  'gen_ai.operation.name': GenAiOperationName;
  'gen_ai.provider.name'?: string; // 'aws.bedrock' | 'station' | 'acp'
  'gen_ai.request.model'?: string;
  'gen_ai.conversation.id'?: string;

  // ── GenAI usage (set on span end / agent-complete) ──
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.response.finish_reasons'?: string[];

  // ── GenAI tool (set on execute_tool spans) ──
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.arguments'?: unknown;
  'gen_ai.tool.call.result'?: unknown;
  /**
   * Explicit producer-reported tool execution outcome; absent means unknown.
   * `unresolved` (station#1558) is itself an explicit report: the session
   * ended with the call still open, so no outcome can ever arrive.
   */
  'gen_ai.tool.call.outcome'?: 'success' | 'error' | 'unresolved';

  // ── Span lifecycle ──
  'span.kind': 'start' | 'end' | 'event' | 'log';

  // ── Station extensions (namespaced) ──
  'station.agent.slug'?: string;
  'station.agent.steps'?: number;
  'station.agent.max_steps'?: number;
  'station.input.chars'?: number;
  'station.output.chars'?: number;
  'station.artifacts'?: Array<{
    type: string;
    name?: string;
    content?: unknown;
  }>;
  'station.user.id'?: string;

  // ── Health (log records) ──
  'station.health.healthy'?: boolean;
  'station.health.checks'?: Record<string, boolean>;
  'station.health.integrations'?: HealthIntegration[];

  // ── Reasoning (log records) ──
  'station.reasoning.text'?: string;

  // ── Agent telemetry ingest (from ACP agents) ──
  'station.agent_telemetry.session_id'?: string;
  'station.agent_telemetry.event_id'?: string;
  'station.agent_telemetry.schema_version'?: string;
  'station.agent_telemetry.context'?: AgentTelemetryContext;
  'station.agent_telemetry.enrichment'?: AgentTelemetryEnrichment;

  /** Catch-all for forward compatibility */
  [key: string]: unknown;
}

export interface HealthIntegration {
  id: string;
  type: string;
  connected: boolean;
  metadata?: { transport?: string; toolCount?: number };
}

// ── Agent telemetry v0.2.0 ingest types ─────────────────────────────

export interface AgentTelemetryContext {
  cwd?: string;
  tty?: string;
  os?: string;
  shell?: string;
  pid?: number;
}

export interface AgentTelemetryEnrichment {
  system?: {
    os?: string;
    os_version?: string;
    shell?: string;
    runtime_version?: string;
    node_version?: string;
    python_version?: string;
  };
  workspace?: {
    has_git?: boolean;
    git_branch_hash?: string;
    file_count?: number;
    primary_languages?: string;
  };
  auth?: {
    mwinit_active?: boolean;
    mwinit_age_minutes?: number;
    cookie_exists?: boolean;
  };
}

/** Raw event shape from SAAgent telemetry.sh */
export interface AgentTelemetryIngestEvent {
  schema_version: string;
  timestamp: string;
  session_id: string;
  event_id: string;
  event_type:
    | 'session.start'
    | 'session.end'
    | 'turn.user'
    | 'tool.invoke'
    | 'tool.result'
    | 'agent.delegate'
    | 'unknown';
  agent: { name: string; runtime: string; version: string };
  context?: AgentTelemetryContext;
  enrichment?: AgentTelemetryEnrichment;
  turn?: { prompt_text?: string; prompt_length?: number };
  tool?: { name?: string; input?: unknown; output?: unknown };
  session?: { duration_s?: number };
  delegation?: { targets?: unknown[] };
}

// ── OTLP JSON envelope types (subset for receiver) ──────────────────

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status?: { code: number; message?: string };
}

export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface OtlpTracesPayload {
  resourceSpans: Array<{
    resource?: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope?: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

export interface OtlpLogsPayload {
  resourceLogs: Array<{
    resource?: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope?: { name: string; version?: string };
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

// ── Monitoring stats (unchanged shape, OTel attribute names) ────────

export interface MonitoringStats {
  agents: AgentStats[];
  summary: {
    totalAgents: number;
    activeAgents: number;
    runningAgents: number;
    totalMessages: number;
    totalCost: number;
  };
}

export interface AgentStats {
  slug: string;
  name: string;
  status: 'idle' | 'running';
  model: string;
  conversationCount: number;
  messageCount: number;
  cost: number;
  healthy: boolean;
}
