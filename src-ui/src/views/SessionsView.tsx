import type {
  AdoptedSessionResult,
  OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import {
  useOrchestrationSessionsQuery,
  usePairedDevicesQuery,
} from '@kontourai/station-sdk';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionOperationsSection } from '../components/action-operations/ActionOperationsSection';
import { DelegationLauncher } from '../components/chat-dock/DelegationLauncher';
import { AgentIcon } from '../components/icons/AgentIcon';
import { LazyBoundary } from '../components/LazyBoundary';
import { LiveCollaboratorsSection } from '../components/live-activity/LiveCollaboratorsSection';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SessionEvidenceButton } from '../components/session/SessionEvidenceButton';
import { SessionProjectPill } from '../components/session/SessionProjectPill';
import { SessionPullRequestConflictChip } from '../components/session/SessionPullRequestConflictChip';
import { AttachedSessionDetail } from '../components/session-detail/AttachedSessionDetail';
import {
  DelegatedTaskCoordinator,
  DelegatedTaskStarter,
} from '../components/session-detail/DelegatedTaskCoordinator';
import {
  MutableSessionDetail,
  type SessionEvidenceReveal,
} from '../components/session-detail/MutableSessionDetail';
import { StatusGlyph } from '../components/status/StatusGlyph';
import { Tabs, tabElementId, tabPanelElementId } from '../components/Tabs';
import { useAgents } from '../contexts/AgentsContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useOpenChats } from '../contexts/open-chats-store';
import { useSessionEventStream } from '../hooks/orchestration/useSessionEventStream';
import { useMobileVisualViewport } from '../hooks/useMobileVisualViewport';
import { resolveClientOriginActor } from '../utils/clientOrigin';
import { elidedHistoryNoticeText } from '../utils/elidedHistory';
import { modelDisplayLabel } from '../utils/modelCapabilities';
import { relativeTimeAgo } from '../utils/relativeTime';
import {
  activeTurnProgress,
  orchestrationLifecycleLabel,
  sessionStatusWord,
} from '../utils/session-state';
import {
  humanizeId,
  prioritizedDelegatedTasks,
  sessionIconAgent,
  sessionKindLabel,
  sessionProjectLabel,
  sessionRecency,
  sessionTitle,
} from '../utils/sessionDisplay';
import { isTerminalLifecycle } from './home/home-lane-model';
import { foldConversationTurns } from './sessions/conversation-groups';
import { RunBoardSummary } from './sessions/RunBoardSummary';
import { groupDelegatedSessionRuns } from './sessions/run-groups';
import {
  matchesProjectFilter,
  partitionSessionLanes,
  SESSION_LANE_LABELS,
  SESSION_LANE_ORDER,
  type SessionLaneId,
  sessionProjectFilterKey,
} from './sessions/sessions-lane-model';
import './SessionsView.css';
import './page-layout.css';

/** Live-refresh cadence for the all-sessions list (the SSE feed is per-session). */
const SESSION_LIST_REFRESH_MS = 5000;

type ActivityAxis = 'task' | 'origin';
const ACTIVITY_AXIS_TABS = [
  { key: 'task', label: 'By task' },
  { key: 'origin', label: 'By origin' },
] as const;

function originSection(
  session: OrchestrationSessionSummary,
  devices: readonly { id: string; name: string }[],
): string {
  const origin = session.turnOrigin?.latest;
  if (!origin) return 'Origin not recorded';
  return resolveClientOriginActor(origin.actor, devices).label;
}

// Keep the archive#4072 observation on the same lazy-boundary rail as Home. The
// renderer, its relative-time wording, and the watchdog-owned silence
// derivation remain in ProgressSilenceObservation.
const loadProgressSilenceObservation = () =>
  import('../components/home/ProgressSilenceObservation');

function isReadOnlyAttachedSession(
  session: OrchestrationSessionSummary,
): boolean {
  return session.controlMode === 'read-only-attached';
}

/**
 * What a sessions-list search matches on: every string this surface actually
 * puts on screen — the row's own name (`displayTitle`, or the delegated task
 * id it is built from), its project heading (either spelling), its working
 * directory and its agent — plus `threadId`, which is not printed as a name
 * any more but stays searchable because pasting an identifier is a real way
 * to find one session (archive#3139).
 */
function searchableSessionFields(
  session: OrchestrationSessionSummary,
): string[] {
  return [
    session.threadId,
    session.provider,
    session.projectSlug,
    session.displayTitle,
    session.cwd,
    session.assignedAgentSlug,
    session.delegation?.taskId,
    session.delegation?.targetId,
    session.delegation?.projectSlug,
  ].filter((value): value is string => Boolean(value));
}

/**
 * The row's second line. Ordered loudest to quietest, and every segment is
 * omitted rather than defaulted when its fact is missing:
 * - the kind, only when it is a delegated session ("Session" on every row of
 *   the Sessions list is a word that distinguishes nothing);
 * - the state in words — kept even though a lane heading now names the coarse
 *   state, because "Recently finished" does not say Completed from Failed.
 *   It comes from `sessionStatusWord`, the same fold the lane heading is
 *   built from, so the finer word can never contradict the coarser one
 *   (archive#3227 A1: this row said *Running* under "Recently finished");
 * - a relative time, appended only when there is a parseable stamp.
 *
 * NO SIZE SIGNAL HERE, deliberately (archive#3027). The ticket asked for an
 * at-a-glance "what does this chat contain" clue and the payload audit found
 * exactly one candidate: `eventCount`. It is honest as a number and wrong as
 * that clue — an event is not a message (one streaming turn emits hundreds of
 * `content.text-delta` rows, so the figure carries a provider-dependent
 * multiplier and cannot be compared across engines), and for a
 * `read-only-attached` transcript it is only a LOWER BOUND, because the Claude
 * transcript source cold-starts its ingest at `size - 2MB` and caps each read
 * at 512 events. Rendered, it also pushed the lifecycle label out of a 270px
 * list pane. A truthful "12 messages" needs a per-session message or turn
 * count on the sessions read-model; none exists today, and an untrue proxy on
 * every row is worse than an absent one.
 */
function sessionMetaLine(
  session: OrchestrationSessionSummary,
  now: number,
  foldedTurnCount?: number,
): string {
  const recency = sessionRecency(session);
  const parts: string[] = [];
  if (session.delegation) parts.push(sessionKindLabel(session));
  parts.push(sessionStatusWord(session));
  // NOT the `eventCount` proxy the docblock above refuses: this counts the
  // sibling turn-sessions folded behind this conversation row
  // (`foldConversationTurns`), each one a continuation session the lineage
  // opened for a turn. A session that absorbed a queued/steered extra turn
  // makes this a floor, not an exact transcript count — it says how many
  // rows the fold collapsed, which is the fragmentation fact the reader
  // needs, and is derived entirely from what this list is showing.
  if (foldedTurnCount !== undefined && foldedTurnCount > 1) {
    parts.push(`${foldedTurnCount} turns`);
  }
  if (recency > 0) parts.push(relativeTimeAgo(recency, now));
  return parts.join(' · ');
}

function sessionMemberStatusLine(
  session: OrchestrationSessionSummary,
  agents: ReturnType<typeof useAgents>,
  now: number,
) {
  const state = orchestrationLifecycleLabel(session);
  const agent = sessionIconAgent(session, agents);
  const model =
    session.reportedModel ?? session.effectiveModel ?? session.model;
  const turnProgress = activeTurnProgress(session);

  return (
    <span
      className="session-member-status"
      data-session-id={session.threadId}
      data-testid="session-member-status"
    >
      <span className="session-member-status__identity">
        <StatusGlyph state={state} />
        <span>
          {agent.name} · {modelDisplayLabel(model)}
        </span>
      </span>
      {turnProgress?.lastProgressEventAt && (
        <span>
          Last progress{' '}
          {relativeTimeAgo(Date.parse(turnProgress.lastProgressEventAt), now)}
        </span>
      )}
      {turnProgress?.progressSilence && (
        <LazyBoundary
          load={loadProgressSilenceObservation}
          pending={null}
          componentProps={{ observation: turnProgress.progressSilence }}
          unavailable={() => null}
        />
      )}
      {(state === 'Failed' || state === 'Stopped') &&
        session.terminalAttribution?.detail && (
          <span data-testid="session-member-terminal-attribution">
            {session.terminalAttribution.detail}
          </span>
        )}
    </span>
  );
}

function SessionDetail({
  apiBase,
  session,
  onTaskChanged,
  onAdopted,
  getSelectionIntent,
  evidenceReveal,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
  onTaskChanged: () => void;
  onAdopted: (session: AdoptedSessionResult, intent: number) => void;
  getSelectionIntent: () => number;
  evidenceReveal?: SessionEvidenceReveal | null;
}) {
  const {
    events,
    connected,
    hasMore,
    loadOlder,
    upgradeRequired,
    error,
    historyRetrying,
    elidedHistory,
    liveStreamStoppedTerminal,
    historyStoppedTerminal,
    capabilityRecoveryExhausted,
    retryCapabilityRecovery,
  } = useSessionEventStream(apiBase, session.threadId);
  // archive#3386: the same bounded read feeds this surface and
  // the chat dock. The dock disclosed what its budget withheld and this one
  // rendered the identical amputated turn in silence, because both readers in
  // `useSessionEventStream` unwrapped `item.event` and dropped the envelope.
  const elidedHistoryText = elidedHistoryNoticeText(elidedHistory);
  const elidedHistoryNotice = elidedHistoryText ? (
    <p
      className="history-elided"
      role="status"
      data-testid="session-history-elided"
    >
      {elidedHistoryText}
    </p>
  ) : null;
  const visualViewport = useMobileVisualViewport();
  const historyControls = (
    <div className="session-history-controls">
      {hasMore && (
        <button
          type="button"
          className="button button--secondary session-history-controls__more"
          onClick={() => void loadOlder()}
        >
          Load earlier events
        </button>
      )}
      {upgradeRequired && (
        <p role="alert">Update Station to view this session history.</p>
      )}
      {elidedHistoryNotice}
      {error && !upgradeRequired && (
        <p role="alert">
          {/* archive#3378: the two outcomes read identically before this —
              a history read that is coming back and one that has stopped
              both printed the raw cause and nothing else. */}
          {historyRetrying
            ? `${error.message} Retrying session history…`
            : error.message}
        </p>
      )}
    </div>
  );

  if (isReadOnlyAttachedSession(session)) {
    return (
      <>
        {/* Upgrade/error stories render INSIDE the detail for attached
            sessions — only the pagination control and the elision notice
            belong up here, or the update requirement renders twice (sol delta
            review, #2630). The notice is safe in both places precisely
            because it is NOT among the props handed to
            `AttachedSessionDetail`: nothing downstream can render it a second
            time, and these two branches are mutually exclusive anyway. */}
        {(hasMore || elidedHistoryNotice) && (
          <div className="session-history-controls">
            {hasMore && (
              <button
                type="button"
                className="button button--secondary session-history-controls__more"
                onClick={() => void loadOlder()}
              >
                Load earlier events
              </button>
            )}
            {elidedHistoryNotice}
          </div>
        )}
        <AttachedSessionDetail
          key={session.threadId}
          apiBase={apiBase}
          session={session}
          onAdopted={onAdopted}
          getSelectionIntent={getSelectionIntent}
          events={events}
          connected={connected}
          upgradeRequired={upgradeRequired}
          streamError={error}
          liveStreamStoppedTerminal={liveStreamStoppedTerminal}
          historyStoppedTerminal={historyStoppedTerminal}
          capabilityRecoveryExhausted={capabilityRecoveryExhausted}
          onRetryCapabilityRecovery={retryCapabilityRecovery}
          visualViewport={visualViewport}
        />
      </>
    );
  }

  return (
    <>
      {historyControls}
      <MutableSessionDetail
        apiBase={apiBase}
        session={session}
        onTaskChanged={onTaskChanged}
        events={events}
        connected={connected}
        visualViewport={visualViewport}
        evidenceReveal={evidenceReveal}
      />
    </>
  );
}

export function SessionsView({
  apiBase,
  sessionId,
  focusHint,
  intentToken,
  onFocusConsumed,
}: {
  apiBase: string;
  sessionId?: string;
  /**
   * Region-owned one-shot intent for a selected session's evidence:
   * once the routed session is selected, bring its evidence region into
   * view. Consumed and cleared here after adoption, the same way
   * `openFilePreviewIntent` is cleared after host admission
   * (`navigation-store.ts`) — a cleared param is what lets a second
   * activation on the same session be a fresh prop transition instead of a
   * dead click, and what stops a stale `focus` from re-firing on the next
   * same-path navigation.
   */
  focusHint?: 'evidence';
  intentToken?: number;
  onFocusConsumed?: () => void;
}) {
  const {
    data: sessions = [],
    isLoading,
    error: sessionsError,
    refetch,
  } = useOrchestrationSessionsQuery();
  const agents = useAgents();
  const openChats = useOpenChats(agents, sessions);
  const openConversationIds = useMemo(
    () => new Set(openChats.map((chat) => chat.id)),
    [openChats],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectionIntentRef = useRef(0);
  const adoptedSelectionRef = useRef<{
    threadId: string;
    intent: number;
  } | null>(null);
  const routedSessionIdRef = useRef<string | undefined>(undefined);
  const routedFocusRef = useRef<'evidence' | undefined>(undefined);
  const routedIntentTokenRef = useRef<number | undefined>(undefined);
  const pendingRouteSelectionRef = useRef<{
    sessionId: string;
    intent: number;
    focus?: 'evidence';
  } | null>(null);
  const { updateParams } = useNavigation();
  const evidenceRevealTokenRef = useRef(0);
  const [evidenceReveal, setEvidenceReveal] =
    useState<SessionEvidenceReveal | null>(null);
  const [search, setSearch] = useState('');
  const [axis, setAxis] = useState<ActivityAxis>('task');
  // The device inventory is operator-only on the server
  // (`/api/pairing/devices` answers 401 to a paired device's own session), and
  // this view only needs it to name the groups of the origin axis. Reading it
  // eagerly made every fresh-home Activity visit poll a refused route every
  // 15 s, which the release walkthrough counts as a request-error. Read it
  // only while the origin axis is the one being looked at.
  const { data: pairedDevices = [] } = usePairedDevicesQuery(apiBase, {
    enabled: axis === 'origin',
  });
  /** Active project filter, set by clicking a row's project pill. */
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [delegationParent, setDelegationParent] =
    useState<OrchestrationSessionSummary | null>(null);
  const [isDelegationOpen, setIsDelegationOpen] = useState(false);
  const delegationReturnFocusRef = useRef<HTMLElement[]>([]);
  const postDelegateSelectRef = useRef<((threadId: string) => void) | null>(
    null,
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const setSelection = useCallback((threadId: string | null) => {
    selectedIdRef.current = threadId;
    setSelectedId(threadId);
  }, []);

  const selectWithIntent = useCallback(
    (threadId: string | null) => {
      selectionIntentRef.current += 1;
      // a user-initiated selection never carries an evidence
      // reveal — and a still-standing reveal would RE-FIRE on the detail's
      // next mount, because the once-only consumption record lives in the
      // consumer (a ref that dies at unmount) while the token lives here.
      // Deselect -> reselect, or a mutable->attached->mutable swap, would
      // scroll-steal a plain click. Clear it at the source of every
      // non-arming selection.
      setEvidenceReveal(null);
      setSelection(threadId);
    },
    [setSelection],
  );

  /**
   * Mint a fresh one-shot reveal token for the detail, then clear the
   * consumed `focus` param from the URL (the `openFilePreviewIntent` idiom:
   * route-owned intents are cleared by their consumer after admission).
   */
  const armEvidenceReveal = useCallback(
    (threadId: string) => {
      evidenceRevealTokenRef.current += 1;
      setEvidenceReveal({ threadId, token: evidenceRevealTokenRef.current });
      // Only the routed session's own activation consumes the routed focus.
      // Another row's Evidence click is that row's reveal; reporting or
      // clearing it would discard a `focus=evidence` that was never
      // delivered, and the pending route selection is rebuilt without it.
      if (threadId !== sessionId) return;
      if (!onFocusConsumed) updateParams({ focus: null });
      else onFocusConsumed();
    },
    [onFocusConsumed, sessionId, updateParams],
  );

  useEffect(() => {
    if (isLoading) return;
    // `focusHint` participates in the change detection alongside `sessionId`:
    // the Evidence affordance navigates to the SAME session the URL may
    // already name, and only the added `focus=evidence` distinguishes that
    // activation from the route the reader is already on.
    if (
      sessionId !== routedSessionIdRef.current ||
      focusHint !== routedFocusRef.current ||
      intentToken !== routedIntentTokenRef.current
    ) {
      const intent = ++selectionIntentRef.current;
      routedSessionIdRef.current = sessionId;
      routedFocusRef.current = focusHint;
      routedIntentTokenRef.current = intentToken;
      if (!sessionId) {
        pendingRouteSelectionRef.current = null;
        // a route without a session is never an evidence arm —
        // clear any standing reveal so it cannot re-fire on a later mount.
        setEvidenceReveal(null);
        setSelection(null);
        return;
      }

      // A cold query can briefly report an empty list before cached or fetched
      // sessions arrive. Keep the route pending until its session exists so a
      // direct deep link cannot be consumed by that transient empty result.
      if (sessions.some((session) => session.threadId === sessionId)) {
        pendingRouteSelectionRef.current = null;
        setSelection(sessionId);
        if (focusHint === 'evidence') armEvidenceReveal(sessionId);
        else setEvidenceReveal(null); // Review H1: routed, but not an arm
      } else {
        pendingRouteSelectionRef.current = {
          sessionId,
          intent,
          ...(focusHint === 'evidence' ? { focus: focusHint } : {}),
        };
        setSelection(null);
      }
      return;
    }

    const pendingRouteSelection = pendingRouteSelectionRef.current;
    if (
      pendingRouteSelection &&
      sessions.some(
        (session) => session.threadId === pendingRouteSelection.sessionId,
      )
    ) {
      pendingRouteSelectionRef.current = null;
      if (pendingRouteSelection.intent === selectionIntentRef.current) {
        setSelection(pendingRouteSelection.sessionId);
        if (pendingRouteSelection.focus === 'evidence') {
          armEvidenceReveal(pendingRouteSelection.sessionId);
        }
        return;
      }
    }

    const adoptedSelection = adoptedSelectionRef.current;
    if (
      adoptedSelection &&
      sessions.some((session) => session.threadId === adoptedSelection.threadId)
    ) {
      adoptedSelectionRef.current = null;
      if (adoptedSelection.intent === selectionIntentRef.current) {
        setSelection(adoptedSelection.threadId);
        return;
      }
    }

    if (
      selectedIdRef.current &&
      !sessions.some((session) => session.threadId === selectedIdRef.current)
    ) {
      setSelection(null);
    }
  }, [
    isLoading,
    sessionId,
    focusHint,
    intentToken,
    sessions,
    setSelection,
    armEvidenceReveal,
  ]);

  // The SSE feed is per-session; keep the list itself fresh by polling.
  useEffect(() => {
    const timer = setInterval(() => refetch(), SESSION_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  const toggleProjectFilter = useCallback((filterKey: string) => {
    setProjectFilter((current) => (current === filterKey ? null : filterKey));
  }, []);

  // The project filter and the free-text search COMPOSE: a session must pass
  // both. Search is unchanged from archive#3139 — it matched
  // threadId/provider/projectSlug only, so the only reliable way to find a
  // session was to paste its hash back in; every field it reads now is one the
  // list or its detail actually prints, with `threadId` retained because
  // pasting an identifier is a legitimate power path.
  // the CURRENT project filter's collection with
  // no search query applied — so a project pill that itself has zero
  // sessions reads as genuinely empty, never as "your search matched
  // nothing" the moment a stale query also happens to be typed.
  const projectFiltered = useMemo(
    () => sessions.filter((s) => matchesProjectFilter(s, projectFilter)),
    [sessions, projectFilter],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projectFiltered.filter(
      (s) =>
        !q ||
        searchableSessionFields(s).some((field) =>
          field.toLowerCase().includes(q),
        ),
    );
  }, [projectFiltered, search]);

  /**
   * archive#3027: the list groups by STATE, not by project. The server returns
   * `createdAt` ASCENDING, so archive#3139's newest-first requirement is still
   * satisfied view-locally — `partitionSessionLanes` sorts every lane by the
   * same recency fold — and each lane emits exactly one heading because the
   * lanes are contiguous and their headings unique (the run-length-encoded
   * heading bug archive#3139 fixed cannot recur). The project moved onto the row as a
   * pill, which is also the filter control.
   */
  const lanes = useMemo(
    () =>
      partitionSessionLanes({ sessions: filtered, agents, now: Date.now() }),
    [filtered, agents],
  );

  const now = Date.now();
  const sessionRows = lanes.flatMap((lane) =>
    lane.sessions.map((session) => ({ session, laneId: lane.id })),
  );
  const lanesByThreadId = new Map(
    sessionRows.map((row) => [row.session.threadId, row.laneId]),
  );
  const orderByThreadId = new Map(
    sessionRows.map((row, index) => [row.session.threadId, index]),
  );
  // #765 residue: fold sibling turn-sessions of one conversation into a
  // single representative row (newest state wins; count carried onto the
  // row). Runs first, then the fold — a run group is already its own
  // presentation unit and must not lose members to a conversation fold.
  const { presentations: foldedPresentations, turnCounts } =
    foldConversationTurns(
      groupDelegatedSessionRuns(sessionRows.map((row) => row.session)),
      { pinnedThreadId: selectedId },
    );
  const presentationRows = foldedPresentations.map((presentation) => {
    const members =
      presentation.kind === 'run'
        ? presentation.run.members
        : [presentation.session];
    const laneId = members.reduce<SessionLaneId>((highest, member) => {
      const candidate = lanesByThreadId.get(member.threadId);
      return candidate &&
        SESSION_LANE_ORDER.indexOf(candidate) <
          SESSION_LANE_ORDER.indexOf(highest)
        ? candidate
        : highest;
    }, lanesByThreadId.get(members[0].threadId)!);
    const order = Math.min(
      ...members.map((member) => orderByThreadId.get(member.threadId)!),
    );
    return { presentation, members, laneId, order };
  });
  const laneItems = SESSION_LANE_ORDER.flatMap((laneId) => {
    const lanePresentations = presentationRows
      .filter((row) => row.laneId === laneId)
      .sort((left, right) => left.order - right.order);
    if (lanePresentations.length === 0) return [];
    // The lane count means presentation members CLASSIFIED into this lane.
    // A mixed-state run RENDERS in its highest-priority member lane, but its
    // members still count where their own state belongs: one waiting child
    // in an otherwise-active run is 'Needs you · 1', never '· 2'. Stable
    // across expand/collapse because classification, not visibility, is what
    // is counted. Turn-sessions folded away by `foldConversationTurns` do
    // NOT count: the folded conversation is the unit this list now shows,
    // which is the same conversation-folded population Home and Project Live
    // Work already count ("the same populations with the same words") — the
    // per-turn count was the disagreement, not this.
    const laneSessionCount = lanePresentations.reduce(
      (total, row) =>
        total +
        row.members.filter(
          (member) => lanesByThreadId.get(member.threadId) === laneId,
        ).length,
      0,
    );
    const section = `${SESSION_LANE_LABELS[laneId]} · ${laneSessionCount}`;
    return lanePresentations.flatMap(({ presentation, members }) => {
      const group =
        presentation.kind === 'run'
          ? {
              id: presentation.run.id,
              label: `Run · ${presentation.run.members.length - 1} delegated ${presentation.run.members.length === 2 ? 'session' : 'sessions'}`,
              renderSummary: (focusMember: (memberId: string) => void) => (
                <RunBoardSummary
                  members={presentation.run.members}
                  onFocusMember={focusMember}
                />
              ),
            }
          : undefined;
      return members.map((s) => {
        const filterKey = sessionProjectFilterKey(s);
        const projectLabel = sessionProjectLabel(s);
        // The affordance appears only when both halves of its promise hold:
        // the session genuinely ENDED — the canonical lifecycle fold
        // (`orchestrationLifecycleLabel`) through the ONE terminal predicate
        // (`isTerminalLifecycle`, archive#3227 A6), never a private
        // re-derivation — and its detail is the mutable one that actually
        // renders the receipts/diagnostics region. A read-only attached
        // transcript has no such region, and `revealHomeRegion`'s rule
        // applies: never offer a control whose target may be absent.
        const showEvidence =
          !isReadOnlyAttachedSession(s) &&
          isTerminalLifecycle(orchestrationLifecycleLabel(s));
        return {
          id: s.threadId,
          name: sessionTitle(s),
          subtitle: (
            <>
              {group
                ? sessionMemberStatusLine(s, agents, now)
                : sessionMetaLine(s, now, turnCounts.get(s.threadId))}
              {s.turnOrigin?.hasOtherOrigins && (
                <span className="session-origin-history">
                  Also driven from another origin
                </span>
              )}
            </>
          ),
          // EVERY row in the lane carries the lane section —
          // the layout emits a heading only when section CHANGES between
          // neighbors, so a member with undefined reset the comparison and a
          // following row re-emitted a duplicate lane heading.
          section,
          icon: <AgentIcon agent={sessionIconAgent(s, agents)} size="small" />,
          openChat: openConversationIds.has(s.threadId),
          badge: <SessionPullRequestConflictChip session={s} />,
          ...(group ? { group } : {}),
          // Left undefined — not an element that renders nothing — when this
          // Station knows no project for the session AND no evidence control
          // applies: `SplitPaneLayout` then emits the row's original markup
          // with no empty trailing slot, so an unattributed row is not
          // silently narrower than its neighbours. Interactive controls live
          // HERE, not in the row button — `trailing` is the slot
          // `SplitPaneLayout` renders as a sibling precisely because a button
          // may not contain interactive content (archive#3027).
          trailing:
            showEvidence || projectLabel ? (
              <>
                {showEvidence && (
                  <SessionEvidenceButton
                    sessionTitle={sessionTitle(s)}
                    onActivate={() => {
                      selectionIntentRef.current += 1;
                      setSelection(s.threadId);
                      armEvidenceReveal(s.threadId);
                    }}
                  />
                )}
                {projectLabel ? (
                  <SessionProjectPill
                    label={projectLabel}
                    filterKey={filterKey}
                    active={filterKey !== null && filterKey === projectFilter}
                    onToggle={toggleProjectFilter}
                  />
                ) : undefined}
              </>
            ) : undefined,
        };
      });
    });
  });

  const delegatedTaskIds = new Set(
    presentationRows
      .filter((row) => row.members.some((member) => member.delegation))
      .flatMap((row) => row.members.map((member) => member.threadId)),
  );
  const delegatedCount = laneItems.filter((item) =>
    delegatedTaskIds.has(item.id),
  ).length;
  const operatorCount = laneItems.length - delegatedCount;
  const taskSectionById = new Map<string, string>();
  for (const row of presentationRows) {
    const isDelegated = row.members.some((member) => member.delegation);
    const section = isDelegated
      ? `Delegated/background work · ${delegatedCount}`
      : `Operator sessions · ${operatorCount}`;
    for (const member of row.members) {
      taskSectionById.set(member.threadId, section);
    }
  }
  const originSectionById = new Map(
    sessions.map((session) => [
      session.threadId,
      originSection(session, pairedDevices),
    ]),
  );
  const items = laneItems
    .map((item) => ({
      ...item,
      section:
        axis === 'task'
          ? taskSectionById.get(item.id)
          : originSectionById.get(item.id),
    }))
    .sort((left, right) => {
      if (axis === 'task') {
        const leftDelegated = left.section?.startsWith('Delegated/') ? 0 : 1;
        const rightDelegated = right.section?.startsWith('Delegated/') ? 0 : 1;
        return leftDelegated - rightDelegated;
      }
      const deviceOrder = new Map(
        pairedDevices.map((device, index) => [device.name, index]),
      );
      return (
        (deviceOrder.get(left.section ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (deviceOrder.get(right.section ?? '') ?? Number.MAX_SAFE_INTEGER)
      );
    });
  const emptySections =
    axis === 'origin' ? pairedDevices.map((device) => device.name) : [];

  const selected = sessions.find((s) => s.threadId === selectedId) ?? null;
  const delegatedTasks = useMemo(
    () => prioritizedDelegatedTasks(sessions),
    [sessions],
  );

  const openDelegation = (
    parent: OrchestrationSessionSummary | null,
    selectTask: (threadId: string) => void,
    trigger: HTMLButtonElement,
  ) => {
    // Found by archive#1245's sweep, not listed on the issue. The trigger is a
    // per-row button in the sessions list, and delegating invalidates that list
    // so the row that opened the launcher is exactly the kind of node the
    // launcher's own action removes (archive#1126). The old restore was
    // `requestAnimationFrame( => delegationTriggerRef.current?.focus)`,
    // with no guard at all. Capture the whole ancestor chain while it is still
    // attached so the fallback has something to walk.
    delegationReturnFocusRef.current = captureReturnFocus(trigger);
    postDelegateSelectRef.current = selectTask;
    setDelegationParent(parent);
    setIsDelegationOpen(true);
  };

  const closeDelegation = () => {
    const chain = delegationReturnFocusRef.current;
    delegationReturnFocusRef.current = [];
    setIsDelegationOpen(false);
    restoreReturnFocus(chain);
  };

  const delegationProjectSlug =
    delegationParent?.delegation?.projectSlug ?? delegationParent?.projectSlug;
  const delegationParentTaskId = delegationParent
    ? (delegationParent.delegation?.taskId ?? delegationParent.threadId)
    : undefined;

  return (
    <>
      {/* empty-state action: delegation starter and filter reset are adjacent */}
      <SplitPaneLayout
        items={items}
        emptySections={emptySections}
        selectedId={selectedId}
        onSelect={selectWithIntent}
        onDeselect={() => selectWithIntent(null)}
        onSearch={setSearch}
        searchValue={search}
        searchPlaceholder="Search sessions…"
        loading={isLoading}
        error={sessionsError}
        onRetry={() => void refetch()}
        listEmptyTitle="Nothing has run yet"
        listEmptyDescription="Agent sessions appear here as they run on this host."
        listFilteredEmptyNoun="sessions"
        collectionEmpty={projectFiltered.length === 0}
        /* The only thing above the rows is the active project filter, and only
           when there is one — a permanent filter bar would cost every reader
           space to tell most of them nothing. */
        listIntro={
          <>
            <Tabs
              id="activity-axis"
              items={ACTIVITY_AXIS_TABS}
              activeKey={axis}
              onSelect={(key) => setAxis(key as ActivityAxis)}
              aria-label="Group Activity"
              activation="automatic"
              className="sessions-axis-tabs"
            />
            <div
              role="tabpanel"
              id={tabPanelElementId('activity-axis', axis)}
              aria-labelledby={tabElementId('activity-axis', axis)}
              className="sessions-axis-description"
            >
              {axis === 'task'
                ? 'Delegated work is separated from sessions you are driving directly.'
                : 'Sessions are grouped by their recorded origin; paired devices remain listed when empty.'}
            </div>
            <ActionOperationsSection />
            <LiveCollaboratorsSection />
            {projectFilter ? (
              <div className="sessions-project-filter">
                <span className="sessions-project-filter__label">
                  Filtered to
                </span>
                <button
                  type="button"
                  className="sessions-project-filter__clear"
                  aria-label={`Clear the ${projectFilter} project filter`}
                  onClick={() => setProjectFilter(null)}
                >
                  {projectFilter}
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            ) : null}
          </>
        }
        /* archive#3027: the delegation card is "start something new", not a
           session, so it sits BELOW the list rather than on top of it — and
           the "Needs you" lane now shows every waiting delegated session,
           which is what the card's single `tasks[0]` slot could never do. */
        sidebarActions={(selectTask) =>
          delegatedTasks.length > 0 ? (
            <DelegatedTaskCoordinator
              key={delegatedTasks[0].threadId}
              apiBase={apiBase}
              tasks={delegatedTasks}
              onOpen={selectTask}
              onDelegate={(trigger) =>
                openDelegation(delegatedTasks[0], selectTask, trigger)
              }
              onTaskChanged={() => void refetch()}
            />
          ) : (
            <DelegatedTaskStarter
              onDelegate={(trigger) =>
                openDelegation(null, selectTask, trigger)
              }
            />
          )
        }
        /* station: sessions moved under Home. The surface is named Activity —
           "monitor the AI sessions on this host" — while each row stays a
           session, because that is what the list actually shows
           (`useOrchestrationSessionsQuery`: this Station's sessions, including
           read-only attached external-engine ones). */
        label="Activity"
        title="Activity"
        subtitle="Watch and talk to AI sessions across this host"
        emptyDescription="Select a session to watch its live events and send input."
        firstRunAnchor="activity"
      >
        {selected && (
          <SessionDetail
            apiBase={apiBase}
            session={selected}
            evidenceReveal={evidenceReveal}
            onTaskChanged={() => void refetch()}
            onAdopted={(child, intent) => {
              adoptedSelectionRef.current = {
                threadId: child.threadId,
                intent,
              };
              void refetch().finally(() => {
                if (intent === selectionIntentRef.current) {
                  setSelection(child.threadId);
                }
              });
            }}
            getSelectionIntent={() => selectionIntentRef.current}
          />
        )}
      </SplitPaneLayout>

      <DelegationLauncher
        isOpen={isDelegationOpen}
        apiBase={apiBase}
        projectSlug={delegationProjectSlug}
        projectName={
          delegationProjectSlug ? humanizeId(delegationProjectSlug) : null
        }
        currentAgentId={
          delegationParent?.delegation?.targetId ??
          delegationParent?.assignedAgentSlug
        }
        currentModel={delegationParent?.model}
        parentTaskId={delegationParentTaskId}
        parentTaskLabel={
          delegationParentTaskId
            ? humanizeId(delegationParentTaskId)
            : undefined
        }
        onClose={closeDelegation}
        onDelegated={(task) => {
          setIsDelegationOpen(false);
          void refetch().finally(() => {
            postDelegateSelectRef.current?.(task.sessionId);
          });
        }}
      />
    </>
  );
}
