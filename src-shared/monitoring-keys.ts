/**
 * OTel GenAI Semantic Convention attribute key constants.
 * Single source of truth — imported by both src-ui and src-server.
 */

export const K = {
  TIMESTAMP: 'timestamp',
  TIMESTAMP_MS: 'timestamp.ms',
  TRACE_ID: 'trace.id',
  SPAN_KIND: 'span.kind',
  OP_NAME: 'gen_ai.operation.name',
  PROVIDER: 'gen_ai.provider.name',
  MODEL: 'gen_ai.request.model',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  FINISH_REASONS: 'gen_ai.response.finish_reasons',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_CALL_ARGS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',
  /** Elapsed milliseconds between a tool call and its result, on the result event. */
  TOOL_DURATION_MS: 'station.tool.duration_ms',
  TOOL_CALL_OUTCOME: 'gen_ai.tool.call.outcome',
  AGENT_SLUG: 'station.agent.slug',
  AGENT_STEPS: 'station.agent.steps',
  AGENT_MAX_STEPS: 'station.agent.max_steps',
  INPUT_CHARS: 'station.input.chars',
  OUTPUT_CHARS: 'station.output.chars',
  ARTIFACTS: 'station.artifacts',
  USER_ID: 'station.user.id',
  HEALTHY: 'station.health.healthy',
  HEALTH_CHECKS: 'station.health.checks',
  HEALTH_INTEGRATIONS: 'station.health.integrations',
  REASONING_TEXT: 'station.reasoning.text',
  AT_SESSION_ID: 'station.agent_telemetry.session_id',
  AT_EVENT_ID: 'station.agent_telemetry.event_id',
  AT_SCHEMA_VERSION: 'station.agent_telemetry.schema_version',
  AT_CONTEXT: 'station.agent_telemetry.context',
  AT_ENRICHMENT: 'station.agent_telemetry.enrichment',
  SYSTEM_TYPE: 'station.system.type',
} as const;

export const OP = {
  CHAT: 'chat',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
} as const;

export const SPAN = {
  START: 'start',
  END: 'end',
  EVENT: 'event',
  LOG: 'log',
} as const;

/**
 * The engine identifier Station's own runtime reports on monitoring events.
 * External engines report their own (`claude-code`, `codex`, an ACP
 * connection id) through the orchestration bridge. Declared here so the two
 * producers cannot drift into different spellings of the same engine.
 */
export const STATION_ENGINE_PROVIDER = 'station';

/**
 * The bucket a monitoring row answers to when its producer reported no agent
 * slug. Absence is a real state — a row with no slug is not a row belonging
 * to an agent named `''` — and it needs a name a human can select, or those
 * rows are unreachable behind every filter and absent from every picker.
 *
 * Declared here because THREE surfaces have to agree on it: the insights
 * rollup, the Monitoring view's filter and picker, and the sidebar's own
 * per-name count. They each derived it independently, which is how the
 * sidebar came to count by a raw field the other two had already renamed.
 */
export const UNNAMED_AGENT = '(unnamed)';

/**
 * The single naming rule. Read a row's agent name the way every surface must
 * read it: a non-empty string slug, or {@link UNNAMED_AGENT}. Anything that
 * filters, groups, counts or lists by agent goes through this — a second
 * spelling of the predicate is the defect, not the string.
 */
export function monitoringAgentName(
  event: Record<string, unknown> | undefined,
): string {
  const slug = event?.[K.AGENT_SLUG];
  return typeof slug === 'string' && slug ? slug : UNNAMED_AGENT;
}
