import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
} from '@kontourai/station-contracts/session-lifecycle';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { isSessionUnanswerable } from './answerability';

/**
 * A turn is mid-flight. archive#1073: gated on the summary's turn-level fold, not
 * lifecycleState — an attach-only session projects 'queued' (previously a
 * fabricated 'running'), and neither state means work is in flight. A
 * legacy summary without the fold falls back to lifecycleState 'running'
 * (only an explicit false demotes, mirroring the snapshot rule): against an
 * old server, allowing a concurrent send mid-turn is the unsafe direction.
 */
export function isStreamingSession(
  session: OrchestrationSessionSummary,
): boolean {
  if (session.hasActiveTurn !== undefined) return session.hasActiveTurn;
  return session.lifecycleState === 'running';
}

export function linkedFlowStateLabel(state: unknown): string {
  if (!state || typeof state !== 'object') return 'Active';
  const value = state as Record<string, unknown>;
  const currentStep = value.current_step ?? value.currentStep;
  if (typeof currentStep === 'string' && currentStep) return currentStep;
  return typeof value.status === 'string' && value.status
    ? value.status
    : 'Active';
}

/**
 * `station-delivery` was an internal, Station-specific lifecycle. Historical
 * sessions may still contain its binding, but the implementation identifier
 * is not product vocabulary and must not leak back into user-facing copy.
 */
/**
 * How the Builder run was joined to this session (archive#189), in the
 * user's words. Never collapses to a bare "linked": which of the two join
 * paths produced the row is the difference between Station's own record and a
 * match on a producer-supplied identity, and the reader is entitled to know
 * which one they are looking at.
 */
export function builderRunMatchLabel(
  matchKind: 'started-by-station' | 'correlation-matched' | 'none',
): string {
  switch (matchKind) {
    case 'started-by-station':
      return 'Started by Station';
    case 'correlation-matched':
      return 'Matched on run correlation';
    default:
      return 'Not joined';
  }
}

/**
 * The identity line. `present` is the only status that asserts anything; the
 * other two disclose a gap, and the producer's own reason (when there is one)
 * is what actually explains it, so this returns a label the caller pairs with
 * that reason rather than swallowing it.
 *
 * Says "engine session identity", not "runtime identity" (archive#3139):
 * docs/glossary.md retires "runtime" as a user-facing word precisely because
 * it meant too many things, and names **engine** as the term for the thing
 * that executed the work. The status is about the sidecar's `runtime_session`
 * the engine session the Builder run recorded — so the user-facing wording
 * follows the glossary while the wire field keeps its producer-owned name.
 */
export function builderRunIdentityLabel(
  identityStatus: 'present' | 'unavailable' | 'unsupported',
): string {
  switch (identityStatus) {
    case 'present':
      return 'Engine session identity present';
    case 'unsupported':
      return 'Engine session identity unsupported';
    default:
      return 'Engine session identity unavailable';
  }
}

/**
 * The provenance clause on a projected Builder run. It quotes
 * `state.json.updated_at` — when the sidecar FILE was last written — and
 * claims nothing more: `flow_run` has no currency stamp of its own upstream,
 * so this must never be read as the projection's age. Falls back to the
 * timeless phrasing when the server sent no timestamp, which stays true
 * rather than guessing one.
 */
export function sidecarWriteProvenance(
  sidecarUpdatedAt: string | undefined,
): string {
  if (!sidecarUpdatedAt) return ' · as of the last sidecar write';
  const written = new Date(sidecarUpdatedAt);
  if (Number.isNaN(written.getTime())) {
    return ' · as of the last sidecar write';
  }
  return ` · as of the sidecar write at ${written.toLocaleString()}`;
}

export function humanizeId(value: string): string {
  return value
    .replace(/^task[:-]?/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name a session is listed under. archive#3139: this used to end at
 * `humanizeId(session.threadId)`, and `humanizeId` only strips a leading
 * `task[:-]?` and swaps `[-_]` for spaces — a NO-OP on a content-derived hex
 * digest, so an attached Claude session was listed as
 * `external:claude:5dfa…`. `displayTitle` (server-derived from the first user
 * turn) was on the same object the whole time and is what
 * `AttachedSessionDetail` and Home already render, so the list and the detail
 * pane disagreed about whether the session had a name.
 *
 * Precedence, and no branch may return a raw thread id: the session's own
 * title, then the delegated task's readable id, then the engine-named
 * fallback `AttachedSessionDetail` already uses ("Claude Code session").
 */
export function sessionTitle(session: OrchestrationSessionSummary): string {
  const displayTitle = session.displayTitle?.trim();
  if (displayTitle) return displayTitle;
  const taskId = session.delegation?.taskId;
  if (taskId) {
    const readable = humanizeId(taskId);
    if (readable) return `Worker task · ${readable}`;
  }
  return `${displayProvider(session)} session`;
}

/**
 * How recent a session is, as one epoch-ms number — the same fold
 * `home-view-model.ts` applies (max of updatedAt/lastEventAt/createdAt) so the
 * two surfaces cannot disagree about which session is newest. `0` means no
 * parseable stamp at all; callers must render that as "no time known" rather
 * than as a real duration (see `relativeTime`'s archive#1795 guard).
 */
export function sessionRecency(session: OrchestrationSessionSummary): number {
  return Math.max(
    parseTimestamp(session.updatedAt),
    parseTimestamp(session.lastEventAt),
    parseTimestamp(session.createdAt),
  );
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sessionKindLabel(session: OrchestrationSessionSummary): string {
  if (!session.delegation) return 'Session';
  return session.delegation.mode === 'isolated-child'
    ? 'Delegated worker'
    : 'Delegated task';
}

/**
 * What this Station knows about a session's project, as one label — or `null`
 * when it knows nothing at all.
 *
 * Every branch says exactly what is known, and no branch drops the session:
 * - a delegated task joined to a REMOTE Station purely by project *name* is
 *   labelled unverified (archive#1463) — slugs are locally generated, so a
 *   cross-machine name match is a coincidence rather than proof of identity;
 * - `directory-corroborated` still carries the unverified-name caveat: the
 *   corroboration proves the DIRECTORY matches the operator-verified path,
 *   and archive#1462 is the standing proof that two projects can sit on one
 *   directory, so it is a weaker claim than a verified binding, not a
 *   substitute for one;
 * - a working directory configured as more than one project reads as
 *   ambiguous with the candidates named (archive#1462), never as one
 *   arbitrarily-chosen project and never as plain "Unassigned", which would
 *   read as "no project" when the truth is "too many". A bounded-away tail
 *   of candidates is counted rather than dropped, so the list never renders
 *   16 of 20 names as if that were all of them.
 *
 * Every surface that names a session's project goes through here — the
 * sessions list ROW PILL (archive#3027 moved it off the heading and onto the
 * row, where it is also the project filter's control) and the detail panel's
 * Project row both — so one click cannot change the answer. The pill renders
 * this string verbatim, caveats included; a long one is visually truncated
 * with the full text on `title`, never rewritten.
 */
export function sessionProjectLabel(
  session: OrchestrationSessionSummary,
): string | null {
  const delegated = session.delegation?.projectSlug;
  if (delegated) {
    switch (session.delegation?.projectSlugJoin) {
      case 'unverified-cross-machine':
        return `${delegated} (unverified name match)`;
      case 'directory-corroborated':
        return `${delegated} (unverified name match, directory corroborated)`;
      default:
        return delegated;
    }
  }
  if (session.projectSlug) return session.projectSlug;
  const attribution = session.projectAttribution;
  if (attribution?.state === 'ambiguous') {
    const named = attribution.candidates.join(', ');
    return attribution.omittedCandidates
      ? `ambiguous (${named}, and ${attribution.omittedCandidates} more)`
      : `ambiguous (${named})`;
  }
  return null;
}

/*
 * `sessionProjectSection` lived here — `Project · <label>`, or `'Unassigned'`
 * when nothing was known — and its own docblock said to retire it if no
 * surface grouped by project again. archive#3227 A3 collected the evidence to
 * decide, and retired it:
 *
 * - It never regained a rendering caller. archive#3027 moved the sessions
 *   list off project headings onto state lanes and nothing moved back; only a
 *   test held it alive, which is the definition of machinery ahead of a call
 *   site (see the archive#1781 note further down this file for the same call).
 * - Home DOES group by project (`activity-bars.tsx`, `HomeSurface.tsx`),
 *   so it was the one plausible caller — and it wants neither half of this
 *   function. The `Project · ` prefix is a section-heading form, and Home
 *   renders the label inside `{kindLabel} · {projectLabel}` and as a bar row
 *   name, where it would read "Session · Project · station". Its `'Unassigned'`
 *   fold also contradicts the `'No project'` Home already shows for a
 *   project-less direct chat, and one Home list must not spell the same
 *   absence two ways.
 *
 * Both callers now read `sessionProjectLabel` and fold `null` themselves at
 * the display site. Every assertion this function carried was kept, retargeted
 * onto `sessionProjectLabel` in `sessionProjectSection.test.ts`.
 */

/**
 * Row-level permission posture (archive#1424) — flags a message row whose
 * session Station only reads, never authored/controls. Deliberately narrowed
 * to the one variant with a real, reachable call site today
 * (`AttachedSessionDetail`'s per-row transcript, gated on the same
 * `controlMode === 'read-only-attached'` check `SessionsView.tsx` already
 * uses) — a `delegated-worker`/`delegated-task` posture was cut in review
 * (archive#1424) because no chat/stream transcript surface
 * renders a delegated session's messages today (`SessionsView`/
 * `SessionDetailHeader` already show the equivalent page-level label via
 * `sessionKindLabel`); reintroduce it alongside a real wired call site in
 * the delegated-posture fast-follow, not as speculative machinery ahead of
 * one. `null` means no posture to flag — no badge renders.
 */
export type PermissionPosture = 'read-only-attached';

export function permissionPostureLabel(posture: PermissionPosture): string {
  switch (posture) {
    case 'read-only-attached':
      return 'Read only';
  }
}

/**
 * Engine display name for a raw orchestration `provider` id, or `null` when
 * this build has no product name for it (docs/glossary.md).
 *
 * This is the ONE place Station turns a provider id into engine vocabulary —
 * session headers, the turn provenance card, and the per-turn engine chip
 * (archive#1434) all read it, so a provider named here is named identically
 * everywhere. Every built-in adapter that can stamp this field is listed:
 * `claude`, `codex`, `acp`, `bedrock`, `ollama`, `station-agent` (their
 * `readonly provider` in `src-server/providers/adapters/*`).
 *
 * `bedrock`/`ollama`/`station-agent` are all **Station's own engine** —
 * Bedrock and Ollama are Model connections it executes through, and the
 * `station-agent` adapter relays to Station's own `/chat`. Naming them
 * "Station" matches `agentEngineDescriptor`'s existing verdict for the same
 * execution (an engineId-carrying Station connection -> `{ name: 'Station' }`), so the
 * picker and a turn's chip cannot disagree about one engine.
 *
 * `null` is reserved for ids this build genuinely does not know — a
 * plugin-contributed adapter, or one added after this build shipped. Callers
 * decide what to do with that; the provenance surfaces show the raw id,
 * because an identifier actually observed on the turn beats an invented
 * label.
 */
/** The minimum an agent catalog entry has to offer to be drawn as an icon. */
export interface SessionIconAgent {
  name: string;
  engineId?: EngineId;
  icon?: string;
  slug?: string;
  iconUrl?: string;
}

/**
 * What a session row's leading icon stands for. Resolves the session's own
 * agent from the catalog first (`delegation.targetId` before
 * `assignedAgentSlug`, the precedence `useMutableSessionDetailState` and the
 * delegation launcher already use), so the icon is the agent's real identity —
 * brand mark, custom icon, or its seeded identicon.
 *
 * When nothing resolves — attribution unavailable, an agent that is gone, an
 * attached external transcript with no assigned agent — it falls back to the
 * ENGINE's product name from `engineDisplayLabel`, the one place Station
 * turns a provider id into engine vocabulary. `AgentIcon` then renders its own
 * fallback for that name: a brand mark when the engine has one ("Claude Code",
 * "Codex"), otherwise a tile with the name's initials. Nothing here invents a
 * glyph, and an unknown provider id shows its own initials rather than being
 * dressed up as some engine it might not be.
 *
 * Lives here rather than in `SessionsView` (archive#3202): the project page's
 * Live work section renders the same rows for the same sessions, and two
 * copies of this precedence is how one surface starts drawing a delegated
 * session as its parent agent.
 */
export function sessionIconAgent(
  session: OrchestrationSessionSummary,
  agents: readonly SessionIconAgent[],
): SessionIconAgent {
  const slug = session.delegation?.targetId ?? session.assignedAgentSlug;
  const resolved = slug
    ? agents.find((agent) => agent.slug === slug)
    : undefined;
  if (resolved) return resolved;
  return {
    name: engineDisplayLabel(session.provider) ?? session.provider,
    engineId: session.provider,
  };
}

/**
 * archive#3408: `'agent'` deliberately has no branch here, and the fallback is
 * the intended label for it.
 *
 * `'agent'` is in fact the ONLY `targetKind` either launch writer persists
 * (`station-control-delegation.ts` and `execution-target-execution.ts`); the
 * two explicit branches below cover contract values no writer in this repo
 * produces. So the fallback is already what every real delegated session
 * renders — before archive#3408 because the projection dropped `'agent'` and left
 * `targetKind` undefined, and after it because `'agent'` falls through here.
 * The label is unchanged either way.
 *
 * That is also the right answer rather than an accident: naming the engine
 * ("Claude Code", "Station") is the engine-chip vocabulary this surface
 * settled on, and a delegated Agent is exactly what the chip should name.
 * Adding an `'agent'` branch would be a live copy change, not a fix.
 */
export function delegationTargetLabel(
  session: OrchestrationSessionSummary,
): string {
  if (session.delegation?.targetKind === 'station-agent') {
    return 'Station agent';
  }
  if (session.delegation?.targetKind === 'agent-app') {
    return 'Engine';
  }
  return engineDisplayLabel(session.provider) ?? 'Station agent';
}

export function displayProvider(session: OrchestrationSessionSummary): string {
  if (session.delegation) {
    const identity =
      session.delegation.targetId ??
      session.assignedAgentSlug ??
      session.provider;
    return `${delegationTargetLabel(session)} · ${identity}`;
  }
  const engineLabel = engineDisplayLabel(session.provider);
  return engineLabel ?? `Station agent · ${session.provider}`;
}

export function displayEnvironment(
  environmentId: string | undefined,
): string | null {
  if (!environmentId) return null;
  return environmentId === 'current' ||
    environmentId === 'local' ||
    environmentId.startsWith('env-current')
    ? 'Current environment'
    : environmentId;
}

/**
 * NAME PREDATES THE CONTRACT'S VOCABULARY — this is the canonical STOPPED
 * predicate (`{completed, failed, canceled}`: the session records a run
 * outcome and is not doing work), not the contract's terminal predicate
 * (`{completed}`: no transition out at all; `failed` and `canceled` are both
 * retryable). archive#3244 replaced the hand-written list that used to sit
 * here — the same drift class archive#1548 deleted server-side — with the
 * derivation, keeping the members identical. Callers gate ranking
 * (`delegatedTaskPriority`) and finished-session affordance removal
 * (`DelegatedTaskCoordinator`) on it, which are stopped-semantics questions;
 * whether the coordinator's follow-up composer should instead follow the
 * terminal predicate, as the session detail's composer now does, is a
 * separate deliberate call (reported on archive#3244).
 */
export function isTerminalSession(
  session: OrchestrationSessionSummary,
): boolean {
  return isSessionLifecycleStateStopped(
    foldedSessionLifecycleState(session.lifecycleState),
  );
}

/**
 * NOTE ON THE SHAPE archive#1781 SUGGESTED. Its "What" §1 offered
 * `isActionableSession(summary)` = not terminal AND answerable as the
 * answerability-aware layer. It was written, and then removed: NO call site
 * wanted the conjunction. Every surface this slice touched needs the two
 * facts SEPARATELY — terminal decides whether an affordance exists at all,
 * while unanswerable decides whether it renders disabled next to the
 * observation that disabled it — so collapsing them into one boolean threw
 * away exactly the distinction the surfaces render. The layer that survived
 * is `isSessionUnanswerable` (`utils/answerability.ts`), consumed here and
 * by the four rendering surfaces. An exported predicate with no caller would
 * be machinery ahead of a call site, and the next reader would have to work
 * out which of the two questions it was for.
 *
 * The independence is real and is pinned in
 * `sessionDisplay-answerability.test.ts`: a `failed` session is
 * terminal-by-fold yet still ANSWERABLE (`failed -> queued | running` is a
 * live retry path, archive#1090), and a `needs_input` session whose provider
 * adapter is gone is non-terminal yet unanswerable.
 */

/**
 * Rank for the delegated-task list. Lower wins, and the list is never
 * filtered — an unanswerable task is DE-PRIORITIZED, not deleted, so the
 * annotation on its card is still reachable (ADR 0012: consumers annotate,
 * they do not silently filter).
 *
 * Rank 3 is archive#1781's addition. Before it, a dead session's sticky
 * `review_pending`/`pendingReview` returned rank 0 — the highest — and
 * `DelegatedTaskCoordinator` renders `tasks[0]` only, so one stranded task
 * occupied the single coordinator slot indefinitely while live work sat
 * behind it. It ranks above `terminal` because a session that has not
 * finished is still more interesting than one that has.
 */
export function delegatedTaskPriority(
  session: OrchestrationSessionSummary,
): number {
  const unanswerable = isSessionUnanswerable(session);
  if (
    !unanswerable &&
    (session.pendingReview || session.lifecycleState === 'review_pending')
  ) {
    return 0;
  }
  if (!unanswerable && isStreamingSession(session)) return 1;
  if (!isTerminalSession(session)) return unanswerable ? 3 : 2;
  return 4;
}

export function prioritizedDelegatedTasks(
  sessions: OrchestrationSessionSummary[],
): OrchestrationSessionSummary[] {
  return sessions
    .filter((session) => Boolean(session.delegation))
    .sort((a, b) => {
      const priority = delegatedTaskPriority(a) - delegatedTaskPriority(b);
      if (priority !== 0) return priority;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}
