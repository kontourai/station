/**
 * Why a caller reads the session read model (#4992).
 *
 * `OrchestrationService.listSessionReadModel` is read by many independent
 * consumers, and the read is costly in proportion to the readable thread
 * count. Every caller declares one of these purposes, so the read's
 * telemetry can say who drives the rate and what each reader costs. The
 * vocabulary is closed: it is a metric dimension, so it must stay bounded.
 *
 * This module imports nothing. Structural readers of the service (for
 * example `work-claims.ts`) type their dependency with it without pulling the
 * service module into their typecheck.
 */
export const SESSION_READ_MODEL_PURPOSES = [
  /** `GET /api/orchestration/sessions/read-model`. */
  'session-list',
  /** `GET /api/orchestration/sessions/loaded`. */
  'loaded-session-list',
  /** `/events` connect snapshot, including a replay too large to send. */
  'sse-snapshot',
  /** `/events` present-tense reconcile after a replayed gap. */
  'sse-replay-reconcile',
  /** `/events` recovery after the live buffer overflowed. */
  'sse-overflow-reconcile',
  /** `GET /projects/:slug/session-board`. */
  'project-session-board',
  /** `list_project_activity` and its route. */
  'project-activity',
  /** `get_session_digest`: the subject Session and its delegated children. */
  'session-digest',
  /** The paired-phone agent-activity card publisher. */
  'agent-activity',
  /** The attention projection. */
  'attention',
  /** Running turns a server restart would stop. */
  'restart-running-turns',
  /** One Agent's conversations. */
  'agent-conversations',
  /** The conversation inventory when no history reader is wired. */
  'conversation-inventory',
  /** The knowledge conversation store's session leg. */
  'conversation-store',
  /** Conversation work search. */
  'work-search',
  /** Liveness of work-claim claimants. */
  'work-claims',
  /** Session facts on a Task brief. */
  'task-brief',
  /** Session references on a spatial board. */
  'spatial-board',
  /** `list_delegated_tasks` on this Station. */
  'delegated-task-inventory',
  /** Reconciling peer delegation records from their paired Stations. */
  'peer-delegation-refresh',
  /** Whether a paired Station is recorded as hosting a Task. */
  'peer-delegation-host',
] as const;

export type SessionReadModelPurpose =
  (typeof SESSION_READ_MODEL_PURPOSES)[number];

/** What every `listSessionReadModel` caller passes. */
export interface SessionReadModelReadOptions {
  /** Who is reading, for the read's telemetry only; never changes the result. */
  purpose: SessionReadModelPurpose;
  /**
   * Narrows the read to these sessions. Each is still held to the same
   * readability and ephemeral checks as the full read.
   */
  threadIds?: readonly string[];
  /** Recheck domain admission after adapter refresh, before reading projection events or counts. */
  admitThread?: (threadId: string) => boolean;
}
