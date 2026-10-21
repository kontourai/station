/**
 * The only identity projection used when monitoring data is related back to
 * an orchestration session.  Monitoring has historically accepted several
 * producer shapes; keep their compatibility here instead of letting each
 * reader choose a different (and potentially unsafe) field precedence.
 */
export const MONITORING_SESSION_ID_KEYS = [
  // OTel GenAI semantic conventions and Station's agent-telemetry schema.
  'gen_ai.conversation.id',
  'station.agent_telemetry.session_id',
  // Station's pre-schema monitoring producers.
  'sessionId',
  'conversationId',
  'threadId',
  'station.session.id',
  'gen_ai.session.id',
  // Camel-case variants emitted by early agent telemetry adapters.
  'station.agent_telemetry.sessionId',
  'session_id',
  'conversation_id',
  'thread_id',
] as const;

/** Returns the canonical session identity for a monitoring row, if present. */
export function monitoringSessionIdentity(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  for (const key of MONITORING_SESSION_ID_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Generic host-health frames remain observable in hosted mode.  Content-like
 * telemetry without a session identity does not: it cannot be authorized to a
 * tenant and therefore must fail closed.
 */
export function isContentBearingMonitoringEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const record = event as Record<string, unknown>;
  if (monitoringSessionIdentity(record)) return true;

  return [
    'body',
    'content',
    'message',
    'messages',
    'prompt',
    'title',
    'station.reasoning.text',
    'station.artifacts',
    'station.agent_telemetry.context',
    'station.agent_telemetry.enrichment',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
  ].some((key) => record[key] !== undefined);
}
