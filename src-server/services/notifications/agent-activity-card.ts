/**
 * Builds the agent-activity card a Station pushes to registered phones: pure
 * functions from session snapshots to the FCM data fields the Android plugin
 * renders (vocabulary: src-desktop/plugins/agent-activity/android/.../
 * AgentActivityModel.kt; contract: docs/design/notification-delivery.md).
 *
 * Privacy: the only session content that reaches a card is its display title
 * and its project's name, both truncated, plus the session id and project
 * slug a tap opens (#2515) — identifiers, sent only inside the sealed card.
 * Nothing here reads transcripts, prompts, tool output, code or paths — the
 * input type does not carry them.
 */
import { createHash } from 'node:crypto';
import {
  isNativePushSessionReference,
  NATIVE_PUSH_SESSION_REFERENCE_FIELDS,
} from '@kontourai/station-contracts/native-push';
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
/** The phone truncates an alert body at 608 characters. */
const ALERT_BODY_MAX = 600;
const ALERT_LIST_MAX = 5;
/** Finished sessions stay on the card this long. */
const FINISHED_WINDOW_MS = 15 * 60 * 1000;
/** A finish alerts only this soon after it happened. */
const FINISH_ALERT_WINDOW_MS = 2 * 60 * 1000;
const RUNNING_EXPIRY_MS = 2 * 60 * 60 * 1000;
/**
 * The card travels sealed: base64url(nonce || ciphertext || tag) inside
 * `{station_kind, device_id, sealed}`. The gateway refuses data over 3800
 * bytes (and then stamps ~60 bytes of `station_key`; FCM's own ceiling is
 * 4096). 2500 plaintext bytes seal to at most
 * ceil((2500 + 28) * 4 / 3) = 3371 characters, which with the routing
 * fields and a 64-character registrationId stays under 3500.
 */
const PLAINTEXT_BUDGET_BYTES = 2500;
/** An alert body is cut to this many bytes before a row is given up. */
const ALERT_BODY_SHORT_BYTES = 400;

/** What the phone's `needsUser` means: an approval or input request. */
const needsUser = (phase: AgentActivityPhase) =>
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
 *   its own; it reads `stale` ("Waiting"). It is not counted as attention:
 *   the phone's attention count means an approval or input request.
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
  /** The session's project slug, when it has one; only used to open it. */
  projectSlug?: string;
  phase: AgentActivityPhase;
  /** Epoch ms the session entered `phase`. */
  enteredAt: number;
  /**
   * Which entry into `phase` this is — derived from the event log (the open
   * request, the turn, the terminal event), so a second approval on the same
   * session is a different entry even when no observation saw it leave.
   */
  entryKey: string;
}

/** One alertable entry: an approval/input request, or a recent finish. */
export interface AgentActivityAlertEntry {
  /** Stable across rebuilds and restarts; see {@link agentActivityEntryId}. */
  id: string;
  /** What a tap on a single-session alert opens; see {@link agentActivitySessionReference}. */
  session?: AgentActivitySessionReference;
  phase: AgentActivityPhase;
  title: string;
  project: string;
  enteredAt: number;
}

/** A session a tap opens: sent only when both parts pass the contract grammar. */
export interface AgentActivitySessionReference {
  sessionId: string;
  projectSlug?: string;
}

/**
 * The reference a tap on this session opens, or undefined when its id (or
 * its project slug) falls outside `NATIVE_PUSH_SESSION_REFERENCE_PATTERN`:
 * the phone would refuse it, so it is not sent and the tap opens the app
 * where it was. A session with no project is referenced by id alone.
 */
function agentActivitySessionReference(session: {
  sessionId: string;
  projectSlug?: string;
}): AgentActivitySessionReference | undefined {
  if (!isNativePushSessionReference(session.sessionId)) return undefined;
  if (session.projectSlug === undefined || session.projectSlug === '')
    return { sessionId: session.sessionId };
  if (!isNativePushSessionReference(session.projectSlug)) return undefined;
  return { sessionId: session.sessionId, projectSlug: session.projectSlug };
}

function sessionReferenceFields(
  kind: keyof typeof NATIVE_PUSH_SESSION_REFERENCE_FIELDS,
  reference: AgentActivitySessionReference | undefined,
): Record<string, string> {
  if (!reference) return {};
  const names = NATIVE_PUSH_SESSION_REFERENCE_FIELDS[kind];
  return {
    [names.sessionId]: reference.sessionId,
    ...(reference.projectSlug
      ? { [names.projectSlug]: reference.projectSlug }
      : {}),
  };
}

export interface AgentActivityCard {
  /** `user_id`, `active`, counts and expiry; no rows, alert or timestamp. */
  base: Record<string, string>;
  /** Plugin row strings, in display order; may be cut to fit when sealed. */
  rows: string[];
  topPhase?: AgentActivityPhase;
  /** The session the first row names; a tap on the card opens it. */
  hero?: AgentActivitySessionReference;
  active: boolean;
  /** Absolute expiry the card carries (`activity_expires_at`). */
  expiresAt: number;
  /** What the phone renders, minus the clock-driven expiry. */
  contentKey: string;
  /** Alertable entries currently on the card, newest first. */
  alertables: AgentActivityAlertEntry[];
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

export function agentActivityEntryId(input: {
  stationId: string;
  sessionId: string;
  phase: AgentActivityPhase;
  entryKey: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.stationId}|${input.sessionId}|${input.phase}|${input.entryKey}`,
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
  const base: Record<string, string> = {
    user_id: stationId,
    active: active ? 'true' : 'false',
    activity_active_count: String(activeCount),
    activity_attention_count: String(attentionCount),
  };
  const topPhase = ordered[0]?.phase;
  const hero = ordered[0]
    ? agentActivitySessionReference(ordered[0])
    : undefined;
  const alertables = eligible
    .filter(
      (s) =>
        needsUser(s.phase) ||
        (finished(s.phase) && now - s.enteredAt <= FINISH_ALERT_WINDOW_MS),
    )
    .sort(
      (a, b) =>
        b.enteredAt - a.enteredAt || a.sessionId.localeCompare(b.sessionId),
    )
    .map((s) => {
      const session = agentActivitySessionReference(s);
      return {
        id: agentActivityEntryId({ stationId, ...s }),
        ...(session ? { session } : {}),
        phase: s.phase,
        title: clean(s.title, TITLE_MAX) || 'Untitled session',
        project: clean(s.project, PROJECT_MAX),
        enteredAt: s.enteredAt,
      };
    });
  return {
    base,
    rows,
    ...(topPhase ? { topPhase } : {}),
    ...(hero ? { hero } : {}),
    active,
    expiresAt,
    // The hero is part of what the phone renders: two sessions with the same
    // title and project must not share a card whose tap opens the old one.
    contentKey: JSON.stringify({ base, rows, topPhase, hero }),
    alertables,
  };
}

/**
 * The alert fields for the entries a phone has not been alerted about yet.
 * One entry reads as itself; several are grouped into one alert whose id is
 * derived from the sorted set, so a retry of the same group is recognised.
 */
export function agentActivityAlertFields(
  entries: readonly AgentActivityAlertEntry[],
): Record<string, string> {
  const [first] = entries;
  if (!first) return {};
  if (entries.length === 1) {
    return {
      alert_id: first.id,
      alert_title: clean(
        ALERT_TITLE[first.phase] ?? 'Agent activity',
        ALERT_TITLE_MAX,
      ),
      alert_body: clean(
        first.project ? `${first.title} · ${first.project}` : first.title,
        ALERT_BODY_MAX,
      ),
      ...sessionReferenceFields('alert', first.session),
    };
  }
  const attention = entries.filter((e) => needsUser(e.phase)).length;
  const title =
    attention === entries.length
      ? `${entries.length} agents need you`
      : attention === 0
        ? `${entries.length} agents finished`
        : `${entries.length} agent updates`;
  const lines = entries
    .slice(0, ALERT_LIST_MAX)
    .map((e) => `${PHASE_STATUS[e.phase]}: ${e.title}`);
  if (entries.length > ALERT_LIST_MAX)
    lines.push(`and ${entries.length - ALERT_LIST_MAX} more`);
  let body = lines.join('\n');
  if (Array.from(body).length > ALERT_BODY_MAX)
    body = `${Array.from(body)
      .slice(0, ALERT_BODY_MAX - 1)
      .join('')}…`;
  return {
    alert_id: createHash('sha256')
      .update(
        entries
          .map((e) => e.id)
          .sort()
          .join('|'),
      )
      .digest('hex'),
    alert_title: clean(title, ALERT_TITLE_MAX),
    alert_body: body,
  };
}

/**
 * Serializes the plaintext one phone receives: the card plus that phone's
 * alert and the Station-monotonic `updated_at`. Rows are dropped from the
 * tail, then the alert body is shortened, until it fits the sealed budget.
 */
export function composeAgentActivityPlaintext(
  card: AgentActivityCard,
  alert: Record<string, string>,
  updatedAt: number,
): string {
  const assemble = (rowCount: number, alertFields: Record<string, string>) => {
    const fields: Record<string, string> = {
      user_id: card.base.user_id ?? '',
      updated_at: String(updatedAt),
      active: card.base.active ?? 'false',
    };
    if (rowCount > 0 && card.topPhase) fields.activity_phase = card.topPhase;
    card.rows.slice(0, rowCount).forEach((row, index) => {
      fields[`activity_line_${index}`] = row;
    });
    // The reference names row 0, so it goes when that row does.
    if (rowCount > 0)
      Object.assign(fields, sessionReferenceFields('activity', card.hero));
    fields.activity_active_count = card.base.activity_active_count ?? '0';
    fields.activity_attention_count = card.base.activity_attention_count ?? '0';
    fields.activity_expires_at = String(card.expiresAt);
    return JSON.stringify({ ...fields, ...alertFields });
  };
  const fits = (text: string) =>
    Buffer.byteLength(text, 'utf8') <= PLAINTEXT_BUDGET_BYTES;
  const withBody = (bytes: number) =>
    alert.alert_body === undefined
      ? alert
      : { ...alert, alert_body: truncateBytes(alert.alert_body, bytes) };
  // Rows are what the card is for: shorten a long alert body before giving
  // up a row, and give up rows before dropping the body.
  for (let count = card.rows.length; count >= 0; count -= 1) {
    for (const alertFields of [alert, withBody(ALERT_BODY_SHORT_BYTES)]) {
      const text = assemble(count, alertFields);
      if (fits(text)) return text;
    }
  }
  const { alert_body: _dropped, ...withoutBody } = alert;
  return assemble(0, withoutBody);
}

/** Cuts to at most `bytes` UTF-8 bytes on a code-point boundary. */
function truncateBytes(value: string, bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value;
  let result = '';
  for (const char of value) {
    if (Buffer.byteLength(`${result}${char}…`, 'utf8') > bytes) break;
    result += char;
  }
  return `${result}…`;
}
