/**
 * EventStore's size limits, kept free of the store's runtime dependencies so
 * that admission-time projection (`ingress-event-projection.ts`) can size
 * events against them without importing, or being broken by a test mock of,
 * `event-store.ts`.
 */

/** Last-resort ingress ceiling; upstream adapters own useful projection. */
export const MAX_EVENT_STORE_INGRESS_BYTES = 64 * 1024;

/**
 * Per-event ceiling for a window read. Sized to clear the 16 KiB transcript
 * chunks the session sources persist (`MAX_TEXT_CHUNK_BYTES` in
 * `claude-transcript-session-source.ts` / `codex-rollout-session-source.ts`):
 * at 4 KiB every one of those deltas stripped to identity fields and any
 * turn whose text lived only in them vanished from the transcript while its
 * short user prompt survived. The window-wide
 * `SESSION_EVENT_WINDOW_MAX_SERIALIZED_BYTES` budget still bounds each page;
 * this ceiling only decides when a single event stops being an event.
 */
export const SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES = 24_576;
/**
 * A `turn.completed` carries the turn's full reply text, so it gets the same
 * headroom on every window path (the newest-first path always allowed it;
 * the turn and conversation paths did not, and dropped long replies there).
 */
export const TURN_COMPLETED_SNAPSHOT_MAX_BYTES = 48_000;
/**
 * A `request.opened` is an open decision that a reload, or a second device,
 * rebuilds from a window read (the approval card and toast). Reduced to its
 * identity fields it has no request id, title or form, so it cannot be
 * answered from there. It gets the reply's headroom, and orchestration
 * admission projects every `request.opened` under it
 * (`ingress-event-projection.ts`).
 */
export const REQUEST_OPENED_SNAPSHOT_MAX_BYTES =
  TURN_COMPLETED_SNAPSHOT_MAX_BYTES;
