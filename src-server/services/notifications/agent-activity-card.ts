/**
 * Builds the agent-activity card a Station pushes to registered phones: pure
 * functions from session snapshots to the FCM data fields the Android plugin
 * renders (vocabulary: src-desktop/plugins/agent-activity/android/.../
 * AgentActivityModel.kt; contract: docs/design/notification-delivery.md).
 *
 * Privacy: the only session content that reaches a card is its display title
 * and its project's name, both truncated. Nothing here reads transcripts,
 * prompts, tool output, code or paths — the input type does not carry them.
 */
import { createHash } from 'node:crypto';
import {
  type SessionAttentionSubject,
  sessionAttentionDisposition,
} from '@kontourai/station-contracts/session-attention';

/** The plugin's `ActivityPhase.wire` values. */
export type AgentActivityPhase =
  | 'starting'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'stale'
  | 'completed'
  | 'failed';

/** The plugin's `ActivityPhase.status` row labels (matched exactly on the phone). */
const PHASE_STATUS: Record<AgentActivityPhase, string> = {
  starting: 'Connecting',
  running: 'Working',
  waiting_for_approval: 'Approval',
  waiting_for_input: 'Input',
  stale: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
};

const MAX_ROWS = 5;
const TITLE_MAX = 120;
const PROJECT_MAX = 120;
const STATUS_MAX = 40;
const ALERT_TITLE_MAX = 120;
const ALERT_BODY_MAX = 240;
/** Finished sessions stay on the card this long. */
export const FINISHED_WINDOW_MS = 15 * 60 * 1000;
/** A finish alerts only this soon after it happened. */
export const FINISH_ALERT_WINDOW_MS = 2 * 60 * 1000;
const RUNNING_EXPIRY_MS = 2 * 60 * 60 * 1000;
/**
 * The gateway refuses data over 3800 bytes and then adds `station_key`
 * (~55 bytes); FCM's own ceiling is 4096. Rows are dropped from the tail
 * until the card, per-device fields included, fits this budget.
 */
const DATA_BUDGET_BYTES = 3400;

/** Waiting on the user; `stale` is only ever produced for `blocked`. */
const needsUser = (phase: AgentActivityPhase) =>
  phase === 'waiting_for_approval' ||
  phase === 'waiting_for_input' ||
  phase === 'stale';
/** Alerts go out on entry into an approval or input request only. */
const alertsOnEntry = (phase: AgentActivityPhase) =>
  phase === 'waiting_for_approval' || phase === 'waiting_for_input';
const finished = (phase: AgentActivityPhase) =>
  phase === 'completed' || phase === 'failed';

/** The subset of a session read-model row the card may use. */
export interface AgentActivitySessionFacts extends SessionAttentionSubject {
  /** True while the session has an open turn. */
  hasActiveTurn?: boolean;
  /** True while this Station process has the session's runtime attached. */
  isLoaded: boolean;
  /** `true` only for a session nothing was ever sent to. */
  draft?: boolean;
}

/**
 * Session facts → card phase, or null when the session does not belong on
 * the card. Whether a session is failed, finished, waiting on the user or
 * active is decided by `sessionAttentionDisposition` — the one ordered
 * adjudication the bell and every client label share — and only then
 * refined into the plugin's vocabulary:
 *
 * - The approval signal is the `review_pending` door: the lifecycle fold
 *   turns an unresolved non-input `request.opened` (a tool/permission
 *   approval) and a runtime `awaiting-approval` state into `review_pending`
 *   plus `pendingReview` (session-lifecycle-service.ts). `needs_input` is an
 *   input request. `blocked` waits on the user too but has no plugin phase of
 *   its own; it reads `stale` ("Waiting") and counts as attention.
 * - `canceled` sessions leave the card; other finished sessions read Done.
 * - An absent lifecycle state is not put on the card. The shared
 *   `foldedSessionLifecycleState` default leans live on purpose for in-app
 *   affordances; on a lock-screen card that would read "Working" forever.
 * - `queued` is also what an attached-but-idle session projects (the runtime
 *   `idle`/`configured` states fold to it), so an `active` session reads
 *   `starting` only while a turn is open and is left off otherwise.
 * - Live phases require the runtime to be attached in this process: a
 *   persisted session whose last recorded state was `running` but that
 *   nothing is running is not work in progress.
 */
export function agentActivityPhaseFor(
  facts: AgentActivitySessionFacts,
): AgentActivityPhase | null {
  if (facts.draft === true || facts.lifecycleState === undefined) return null;
  const disposition = sessionAttentionDisposition(facts);
  if (disposition.state === 'failed') return 'failed';
  if (disposition.state === 'finished')
    return facts.lifecycleState === 'canceled' ? null : 'completed';
  if (!facts.isLoaded) return null;
  if (disposition.state === 'awaiting') {
    if (disposition.via === 'needs_input') return 'waiting_for_input';
    if (disposition.via === 'review_pending') return 'waiting_for_approval';
    return 'stale';
  }
  if (facts.lifecycleState === 'running') return 'running';
  return facts.hasActiveTurn === true ? 'starting' : null;
}

export interface AgentActivitySnapshot {
  sessionId: string;
  title: string;
  project: string;
  phase: AgentActivityPhase;
  /** Epoch ms the session entered `phase`; stable across rebuilds. */
  enteredAt: number;
}

export interface AgentActivityCard {
  /** Card fields except the per-device `device_id` and `updated_at`. */
  fields: Record<string, string>;
  /**
   * Identity of what the phone would render (fields minus the clock-driven
   * expiry). Unchanged content is not re-sent.
   */
  contentKey: string;
  /** True when the card has no rows: sending it clears the phone's card. */
  empty: boolean;
}

/** Collapses anything that could break the tab-separated row format. */
function clean(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const flat = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max
    ? flat
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

function rank(snapshot: AgentActivitySnapshot): number {
  if (needsUser(snapshot.phase)) return 0;
  if (snapshot.phase === 'failed') return 1;
  if (!finished(snapshot.phase)) return 2;
  return 3;
}

export function agentActivityAlertId(input: {
  stationId: string;
  sessionId: string;
  phase: AgentActivityPhase;
  enteredAt: number;
}): string {
  return createHash('sha256')
    .update(
      `${input.stationId}|${input.sessionId}|${input.phase}|${input.enteredAt}`,
    )
    .digest('hex');
}

const ALERT_TITLE: Partial<Record<AgentActivityPhase, string>> = {
  waiting_for_approval: 'Approval needed',
  waiting_for_input: 'Input needed',
  completed: 'Agent finished',
  failed: 'Agent failed',
};

export function buildAgentActivityCard(input: {
  sessions: readonly AgentActivitySnapshot[];
  stationId: string;
  now: number;
}): AgentActivityCard {
  const { now, stationId } = input;
  const eligible = input.sessions.filter(
    (session) =>
      !finished(session.phase) || now - session.enteredAt <= FINISHED_WINDOW_MS,
  );
  const ordered = [...eligible].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.enteredAt - a.enteredAt ||
      a.sessionId.localeCompare(b.sessionId),
  );
  const activeCount = eligible.filter((s) => !finished(s.phase)).length;
  const attentionCount = eligible.filter((s) => needsUser(s.phase)).length;
  const active = activeCount > 0;

  const alertSource = eligible
    .filter(
      (s) =>
        alertsOnEntry(s.phase) ||
        (finished(s.phase) && now - s.enteredAt <= FINISH_ALERT_WINDOW_MS),
    )
    .sort(
      (a, b) =>
        b.enteredAt - a.enteredAt || a.sessionId.localeCompare(b.sessionId),
    )[0];

  const base: Record<string, string> = {
    station_kind: 'agent_activity',
    user_id: stationId,
    active: active ? 'true' : 'false',
    activity_active_count: String(activeCount),
    activity_attention_count: String(attentionCount),
  };
  if (alertSource) {
    const title = clean(alertSource.title, TITLE_MAX) || 'Untitled session';
    const project = clean(alertSource.project, PROJECT_MAX);
    base.alert_id = agentActivityAlertId({ stationId, ...alertSource });
    base.alert_title = clean(
      ALERT_TITLE[alertSource.phase] ?? 'Agent activity',
      ALERT_TITLE_MAX,
    );
    base.alert_body = clean(
      project ? `${title} · ${project}` : title,
      ALERT_BODY_MAX,
    );
  }

  const rows = ordered
    .slice(0, MAX_ROWS)
    .map((session) =>
      [
        clean(PHASE_STATUS[session.phase], STATUS_MAX),
        clean(session.title, TITLE_MAX) || 'Untitled session',
        clean(session.project, PROJECT_MAX),
      ].join('\t'),
    );
  const expiresAt =
    rows.length === 0
      ? now
      : now + (active ? RUNNING_EXPIRY_MS : FINISHED_WINDOW_MS);
  // Room for the per-device fields added by the publisher.
  const perDeviceAllowance = JSON.stringify({
    device_id: 'x'.repeat(64),
    updated_at: String(Number.MAX_SAFE_INTEGER),
  }).length;
  const assemble = (count: number) => {
    const fields: Record<string, string> = { ...base };
    const top = ordered[0];
    if (count > 0 && top) fields.activity_phase = top.phase;
    rows.slice(0, count).forEach((row, index) => {
      fields[`activity_line_${index}`] = row;
    });
    fields.activity_expires_at = String(expiresAt);
    return fields;
  };
  let count = rows.length;
  let fields = assemble(count);
  while (
    count > 0 &&
    Buffer.byteLength(JSON.stringify(fields)) + perDeviceAllowance >
      DATA_BUDGET_BYTES
  ) {
    count -= 1;
    fields = assemble(count);
  }
  const { activity_expires_at: _expiry, ...content } = fields;
  return {
    fields,
    contentKey: JSON.stringify(content),
    empty: count === 0,
  };
}
