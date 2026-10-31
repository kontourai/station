/**
 * Canonical `logger.child({...})` correlation binding keys (archive#1897,
 * logging slice 2 -> slice 3: nothing bound a log line to a
 * conversation/session, agent, or run before this).
 *
 * NOT a new vocabulary. Every key that has an equivalent monitoring concept
 * re-exports the IDENTICAL string `src-shared/monitoring-keys.ts`'s `K`
 * already defines for OTel GenAI monitoring events (`MonitoringEmitter`,
 * `src-server/monitoring/emitter.ts`) — never a re-declared copy. Binding a
 * child logger with these same key strings means a `read_logs` query
 * (`GET /diagnostics/logs?q=<id>`) and a monitoring-event query correlate on
 * byte-identical JSON field names, not merely matching values: the same
 * `jq` path reaches both surfaces. `LOG_BINDING_KEYS_ALIGNMENT` below (see
 * the paired test in `__tests__/logger-correlation.test.ts`) asserts
 * equality against `K` directly — a hardcoded literal here would silently
 * desync the two surfaces even though each still "worked" independently.
 */
import { K } from '../../src-shared/monitoring-keys.js';

/**
 * Reused monitoring-event keys, applicable anywhere an orchestration
 * session/conversation is the unit of correlation (session lifecycle, the
 * chat execution path). Only the subset an adopted call site actually binds
 * is re-exported — this is not a general-purpose copy of every `K` entry.
 */
export const LOG_BINDING_KEYS = {
  /** Orchestration conversation/session id (`threadId` in
   * `OrchestrationService`/provider adapters). Same key as
   * `MonitoringEmitter`'s per-turn `gen_ai.conversation.id`. */
  CONVERSATION_ID: K.CONVERSATION_ID,
  /** Resolved agent slug. Same key as `MonitoringEmitter`'s
   * `station.agent.slug`. */
  AGENT_SLUG: K.AGENT_SLUG,
  /** Station user id, when known. Same key as `MonitoringEmitter`'s
   * `station.user.id`. */
  USER_ID: K.USER_ID,
} as const;

/** Opaque scheduler identities are local correlation keys, not conversation IDs. */
export const SCHEDULER_LOG_BINDING_KEYS = {
  JOB_ID: 'station.scheduler.job_id',
  JOB_RUN_ID: 'station.scheduler.job_run_id',
  TARGET_KIND: 'station.scheduler.target_kind',
} as const;

/**
 * Builds the `logger.child()` bindings for an orchestration
 * session/conversation. `conversationId` is required — every adopted call
 * site has one by construction (it is the orchestration `threadId`); the
 * others are included only when known, so a child logger never carries a
 * literal `"undefined"` binding.
 */
export function sessionCorrelationBindings(input: {
  conversationId: string;
  agentSlug?: string;
  userId?: string;
}): Record<string, unknown> {
  const bindings: Record<string, unknown> = {
    [LOG_BINDING_KEYS.CONVERSATION_ID]: input.conversationId,
  };
  if (input.agentSlug) bindings[LOG_BINDING_KEYS.AGENT_SLUG] = input.agentSlug;
  if (input.userId) bindings[LOG_BINDING_KEYS.USER_ID] = input.userId;
  return bindings;
}

/** Builds the `logger.child()` bindings for one scheduler job execution
 * attempt. */
export function schedulerJobCorrelationBindings(input: {
  jobId: string;
  jobRunId: string;
  targetKind: 'conversation' | 'dedicated' | 'untargeted';
}): Record<string, unknown> {
  return {
    [SCHEDULER_LOG_BINDING_KEYS.JOB_ID]: input.jobId,
    [SCHEDULER_LOG_BINDING_KEYS.JOB_RUN_ID]: input.jobRunId,
    [SCHEDULER_LOG_BINDING_KEYS.TARGET_KIND]: input.targetKind,
  };
}
