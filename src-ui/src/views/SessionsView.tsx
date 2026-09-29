import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  interruptOrchestrationTurn,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useMutation } from '@tanstack/react-query';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActionOperationsSection } from '../components/action-operations/ActionOperationsSection';
import { DelegationLauncher } from '../components/chat-dock/DelegationLauncher';
import { DiscardDraftButton } from '../components/drafts/DiscardDraftButton';
import { AgentIcon } from '../components/icons/AgentIcon';
import { LazyBoundary } from '../components/LazyBoundary';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SessionPullRequestConflictChip } from '../components/session/SessionPullRequestConflictChip';
import type { SessionEvidenceReveal } from '../components/session-detail/MutableSessionDetail';
import { SessionDetail } from '../components/session-detail/SessionDetail';
import { StatusGlyph } from '../components/status/StatusGlyph';
import { useAgents } from '../contexts/AgentsContext';
import { navigationStore } from '../contexts/navigation-store';
import { useOpenChats } from '../contexts/open-chats-store';
import { useToast } from '../contexts/ToastContext';
import { copyToClipboard } from '../lib/clipboard';
import { relativeTime, relativeTimeAgo } from '../utils/relativeTime';
import {
  activeTurnProgress,
  orchestrationLifecycleLabel,
  sessionStatusWord,
} from '../utils/session-state';
import {
  isStreamingSession,
  isTerminalSession,
  sessionIconAgent,
  sessionKindLabel,
  sessionProjectLabel,
  sessionRecency,
  sessionTitle,
} from '../utils/sessionDisplay';
import { ActivityFilterBar } from './activity/ActivityFilterBar';
import {
  type ActivityRowAction,
  ActivityRowMenu,
} from './activity/ActivityRowMenu';
import {
  type ActivityFilters,
  activityChatTarget,
  activityOriginOptions,
  activityOriginShortLabel,
  activityProjectOptions,
  activityRunningDetail,
  DATED_STREAM_ORDER,
  datedStreamBucket,
  matchesActivityKind,
  matchesActivityOrigin,
  NO_ACTIVITY_FILTERS,
} from './activity/activity-list-model';
import { olderDraftsLabel } from './home/draft-lane';
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

/**
 * The terminal history lane that reads as a dated stream ("what happened
 * while I was away", docs/design/shell-ownership-and-boards.md). Typed as a
 * lane id on purpose: if the lane model renames or drops it, this line stops
 * compiling instead of silently rendering an undated lane. Every OTHER lane
 * heading is rendered generically from `SESSION_LANE_ORDER` /
 * `SESSION_LANE_LABELS`.
 */
const DATED_STREAM_LANE: SessionLaneId = 'earlier';

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
 * What an Activity search matches on: every string this surface actually
 * puts on screen — the row's own name, its project (either spelling), its
 * agent and its short origin, the working directory the detail prints —
 * plus `threadId`, which is not printed as a name but stays searchable
 * because pasting an identifier is a real way to find one session
 * (archive#3139).
 */
function searchableSessionFields(
  session: OrchestrationSessionSummary,
  agents: ReturnType<typeof useAgents>,
): string[] {
  return [
    session.threadId,
    sessionTitle(session),
    session.provider,
    session.projectSlug,
    session.displayTitle,
    session.cwd,
    session.assignedAgentSlug,
    sessionIconAgent(session, agents).name,
    activityOriginShortLabel(session),
    session.delegation?.taskId,
    session.delegation?.targetId,
    session.delegation?.projectSlug,
  ].filter((value): value is string => Boolean(value));
}

/**
 * The row's second line: state first, then who, where and from what.
 * Ordered loudest to quietest, and every segment is omitted rather than
 * defaulted when its fact is missing:
 * - the state in words from `sessionStatusWord` — the same fold the lane
 *   heading is built from, so the finer word can never contradict the
 *   coarser one (archive#3227 A1) — with the kit status glyph beside it, so
 *   tone never carries the state alone; a Running row adds how long and
 *   which tool (`activityRunningDetail`), a Failed/Stopped row the server's
 *   own `terminalAttribution.detail`;
 * - the kind, only for a delegated session;
 * - the agent, the project as plain text, and the short origin;
 * - how many turn-sessions the conversation fold collapsed (`foldConversationTurns`).
 *
 * NO SIZE SIGNAL HERE, deliberately (archive#3027): `eventCount` is not a
 * message count (streaming deltas multiply it by an engine-dependent factor
 * and attached transcripts report only a lower bound), and an untrue proxy
 * on every row is worse than an absent one.
 */
function ActivityRowMeta({
  session,
  agents,
  now,
  foldedTurnCount,
}: {
  session: OrchestrationSessionSummary;
  agents: ReturnType<typeof useAgents>;
  now: number;
  foldedTurnCount?: number;
}) {
  const state = orchestrationLifecycleLabel(session);
  const stateWord = sessionStatusWord(session);
  const running =
    state === 'Running' ? activityRunningDetail(session, now) : [];
  const turnProgress = activeTurnProgress(session);
  const attached = isReadOnlyAttachedSession(session);
  const agentName = attached ? null : sessionIconAgent(session, agents).name;
  const project = sessionProjectLabel(session);
  const originShort = activityOriginShortLabel(session);
  // An attached row's state word already names its engine ("Started in
  // Claude Code"); repeating it as the origin says nothing new.
  const origin =
    originShort && !stateWord.includes(originShort) ? originShort : null;
  const originText = session.turnOrigin?.hasOtherOrigins
    ? `${origin ?? 'Several origins'} (also another origin)`
    : origin;
  const recency = sessionRecency(session);
  const segments: Array<{ key: string; text: string }> = [];
  if (session.delegation)
    segments.push({ key: 'kind', text: sessionKindLabel(session) });
  if (agentName) segments.push({ key: 'agent', text: agentName });
  if (project) segments.push({ key: 'project', text: project });
  if (originText) segments.push({ key: 'origin', text: originText });
  // NOT the `eventCount` proxy refused above: the sibling turn-sessions
  // folded behind this conversation row, a floor rather than an exact count.
  if (foldedTurnCount !== undefined && foldedTurnCount > 1)
    segments.push({ key: 'turns', text: `${foldedTurnCount} turns` });
  return (
    <span
      className="activity-row-meta"
      data-session-id={session.threadId}
      data-testid="activity-row-meta"
    >
      <span className="activity-row-meta__state">
        {!attached && <StatusGlyph state={state} />}{' '}
        <span data-testid="activity-row-state">
          {[stateWord, ...running].join(' ')}
        </span>
      </span>
      {turnProgress?.progressSilence && (
        <>
          {' · '}
          <LazyBoundary
            load={loadProgressSilenceObservation}
            pending={null}
            componentProps={{ observation: turnProgress.progressSilence }}
            unavailable={() => null}
          />
        </>
      )}
      {(state === 'Failed' || state === 'Stopped') &&
        session.terminalAttribution?.detail && (
          <>
            {' · '}
            <span
              className="activity-row-meta__detail"
              data-testid="session-member-terminal-attribution"
            >
              {session.terminalAttribution.detail}
            </span>
          </>
        )}
      {segments.map((segment) => (
        <Fragment key={segment.key}>
          {' · '}
          <span data-segment={segment.key}>{segment.text}</span>
        </Fragment>
      ))}
      {recency > 0 && (
        // The visible time sits on the row's first line, outside the row
        // button (`trailing`); this copy keeps it in the row's description.
        <span className="sr-only">{`, ${relativeTimeAgo(recency, now)}`}</span>
      )}
    </span>
  );
}

export function SessionsView({
  apiBase,
  sessionId,
  focusHint,
  intentToken,
  onFocusConsumed,
  onOpenInChat,
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
  onOpenInChat?: (threadId: string) => void;
}) {
  // The SSE feed is per-session, so the list itself is kept fresh by polling.
  // The query owns that poll: an interval beside it calling `refetch()` was a
  // second scheduler over the same cache entry, and it kept running through
  // every state React Query already pauses a `refetchInterval` for.
  const {
    data: sessions = [],
    isLoading,
    error: sessionsError,
    refetch,
  } = useOrchestrationSessionsQuery({
    refetchInterval: SESSION_LIST_REFRESH_MS,
  });
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
  const evidenceRevealTokenRef = useRef(0);
  const [evidenceReveal, setEvidenceReveal] =
    useState<SessionEvidenceReveal | null>(null);
  const [search, setSearch] = useState('');
  // Kind / Project / Started from. Origins come from recorded session
  // provenance; the device management registry is operator-only and reading
  // it here can invalidate a valid browser session.
  const [filters, setFilters] = useState<ActivityFilters>(NO_ACTIVITY_FILTERS);
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
   * Mint a fresh one-shot reveal token for the detail, then report the routed
   * focus consumed to whichever placement delivered it (the
   * `openFilePreviewIntent` idiom: one-shot intents are cleared by their
   * consumer after admission).
   *
   * #928: this used to fall back to clearing `focus` from the URL when no
   * `onFocusConsumed` was supplied, which was the standalone `/activity`
   * placement's way of consuming its own routed param. That placement is
   * gone. The two placements left cannot reach the fallback: the region
   * shell always supplies `onFocusConsumed`, and the Developer archive embed
   * supplies no `sessionId` at all, so the guard below returns first on every
   * activation. The deep link's own params are cleared where they are adopted
   * (`RegionModelContext`'s `clearSurfaceDeepLinkParams`), not from inside
   * the surface — this hook has no business writing the URL.
   */
  const armEvidenceReveal = useCallback(
    (threadId: string) => {
      evidenceRevealTokenRef.current += 1;
      setEvidenceReveal({ threadId, token: evidenceRevealTokenRef.current });
      // Only the routed session's own activation consumes the routed focus.
      // Another row's Evidence click is that row's reveal; reporting it would
      // discard a `focus=evidence` that was never delivered, and the pending
      // route selection is rebuilt without it.
      if (threadId !== sessionId) return;
      onFocusConsumed?.();
    },
    [onFocusConsumed, sessionId],
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

  const { showToast } = useToast();

  // Filters and the free-text search COMPOSE: a session must pass every
  // active filter AND the search. `collectionFiltered` is the filtered
  // collection with no query applied, kept apart so an empty result can say
  // which of the two emptied it.
  const collectionFiltered = useMemo(
    () =>
      sessions.filter(
        (s) =>
          matchesActivityKind(s, filters.kind) &&
          matchesProjectFilter(s, filters.project) &&
          matchesActivityOrigin(s, filters.origin),
      ),
    [sessions, filters],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return collectionFiltered.filter(
      (s) =>
        !q ||
        searchableSessionFields(s, agents).some((field) =>
          field.toLowerCase().includes(q),
        ),
    );
  }, [collectionFiltered, search, agents]);
  const projectOptions = useMemo(
    () => activityProjectOptions(sessions),
    [sessions],
  );
  const originOptions = useMemo(
    () => activityOriginOptions(sessions),
    [sessions],
  );
  const clearSearchAndFilters = useCallback(() => {
    setSearch('');
    setFilters(NO_ACTIVITY_FILTERS);
  }, []);

  /**
   * archive#3027: the list groups by STATE, through the shared Home
   * classifier (`partitionSessionLanes` → `partitionHomeWorkItems`) — never a
   * second one. Each lane is newest-first by the same recency fold, and each
   * emits exactly one heading because its rows are contiguous.
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
    // A delegated run renders in the highest-priority lane any member is in:
    // the run root row stays with its run, and a waiting child pulls the run
    // up to "Needs you" rather than hiding below it.
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
    const recency = Math.max(...members.map(sessionRecency));
    return { presentation, members, laneId, order, recency };
  });
  // #2312: Drafts untouched for a day fold under "N older drafts", collapsed
  // until opened. They are the Drafts lane's trailing rows (the lane is
  // newest-first), so the group is contiguous as SplitPaneLayout requires.
  const olderDraftThreadIds =
    lanes.find((lane) => lane.id === 'drafts')?.olderDraftThreadIds ??
    new Set<string>();
  // A Drafts-lane presentation is never a run, so its one member is the
  // folded conversation's representative — the lane is newest-first, so the
  // conversation's NEWEST Session. Old means the whole conversation is old.
  const isOlderDraft = (members: readonly OrchestrationSessionSummary[]) =>
    olderDraftThreadIds.has(members[0].threadId);

  // "Stop…" always asks first: it ends a turn the reader may not be watching.
  const [stopTarget, setStopTarget] =
    useState<OrchestrationSessionSummary | null>(null);
  const stopReturnFocusRef = useRef<HTMLElement | null>(null);
  const stopTask = useMutation({
    mutationFn: (target: { apiBase: string; threadId: string }) =>
      interruptOrchestrationTurn(target),
    onSuccess: () => {
      setStopTarget(null);
      void refetch();
    },
  });
  const openStationChat = (session: OrchestrationSessionSummary) => {
    const target = activityChatTarget(session);
    navigationStore.navigate(target.pathname, target.params);
  };

  const rowActions = (
    s: OrchestrationSessionSummary,
    showEvidence: boolean,
  ): ActivityRowAction[] => {
    const actions: ActivityRowAction[] = [];
    if (isReadOnlyAttachedSession(s)) {
      // Attached transcripts keep their existing continuation, which lives
      // in the detail ("Continue in Station"); "Open" is that detail.
      actions.push({
        id: 'open',
        label: 'Open',
        onSelect: () => selectWithIntent(s.threadId),
      });
    } else {
      actions.push({
        id: 'open-in-chat',
        label: 'Open in chat',
        onSelect: () => openStationChat(s),
      });
    }
    if (showEvidence)
      actions.push({
        id: 'evidence',
        label: 'Show details & evidence',
        onSelect: () => {
          selectionIntentRef.current += 1;
          setSelection(s.threadId);
          armEvidenceReveal(s.threadId);
        },
      });
    const filterKey = sessionProjectFilterKey(s);
    if (filterKey !== null && filterKey !== filters.project)
      actions.push({
        id: 'filter-project',
        label: 'Filter to this project',
        onSelect: () =>
          setFilters((current) => ({ ...current, project: filterKey })),
      });
    actions.push({
      id: 'copy-id',
      label: 'Copy session ID',
      onSelect: () => {
        void copyToClipboard(s.threadId).then((copied) =>
          showToast(
            copied
              ? 'Session ID copied'
              : "Couldn't copy the session ID — this browser refused clipboard access.",
          ),
        );
      },
    });
    // The coordinator's Stop gate, unchanged: a running turn on a session
    // this Station controls. A peer record's turn is the paired Station's.
    if (
      !isReadOnlyAttachedSession(s) &&
      s.delegation?.environmentKind !== 'peer' &&
      isStreamingSession(s) &&
      !isTerminalSession(s)
    )
      actions.push({
        id: 'stop',
        label: 'Stop…',
        tone: 'danger',
        onSelect: (trigger) => {
          stopReturnFocusRef.current = trigger;
          stopTask.reset();
          setStopTarget(s);
        },
      });
    return actions;
  };

  const items = SESSION_LANE_ORDER.flatMap((laneId) => {
    const lanePresentations = presentationRows
      .filter((row) => row.laneId === laneId)
      .sort((left, right) => left.order - right.order);
    if (lanePresentations.length === 0) return [];
    const olderDraftCount =
      laneId === 'drafts'
        ? lanePresentations.filter(
            (row) =>
              row.presentation.kind !== 'run' && isOlderDraft(row.members),
          ).length
        : 0;
    // The dated stream: the terminal history lane splits into "Earlier
    // today" / "Yesterday" / "This week" / "Older" by the same recency fold
    // the lane sorts by. Sorting by bucket first keeps each sub-section
    // contiguous even when a run's position and recency disagree.
    const dated = laneId === DATED_STREAM_LANE;
    const bucketOf = (row: (typeof lanePresentations)[number]) =>
      datedStreamBucket(row.recency, now);
    if (dated)
      lanePresentations.sort(
        (left, right) =>
          DATED_STREAM_ORDER.indexOf(bucketOf(left)) -
            DATED_STREAM_ORDER.indexOf(bucketOf(right)) ||
          left.order - right.order,
      );
    // A section's count means members CLASSIFIED into this lane. A mixed-state
    // run RENDERS in its highest-priority member lane, but its members still
    // count where their own state belongs: one waiting child in an
    // otherwise-active run is 'Needs you · 1', never '· 2'. Stable across
    // expand/collapse because classification, not visibility, is counted.
    // Turn-sessions folded away by `foldConversationTurns` do NOT count: the
    // folded conversation is the unit this list shows, the same population
    // Home and Project Live Work count.
    const classifiedCount = (rows: typeof lanePresentations) =>
      rows.reduce(
        (total, row) =>
          total +
          row.members.filter(
            (member) => lanesByThreadId.get(member.threadId) === laneId,
          ).length,
        0,
      );
    const sectionFor = (row: (typeof lanePresentations)[number]) => {
      if (!dated)
        return `${SESSION_LANE_LABELS[laneId]} · ${classifiedCount(lanePresentations)}`;
      const bucket = bucketOf(row);
      return `${bucket} · ${classifiedCount(
        lanePresentations.filter((other) => bucketOf(other) === bucket),
      )}`;
    };
    return lanePresentations.flatMap((row) => {
      const { presentation, members } = row;
      const section = sectionFor(row);
      const subtaskCount = members.length - 1;
      const group =
        presentation.kind !== 'run' &&
        olderDraftCount > 0 &&
        isOlderDraft(members)
          ? {
              id: 'older-drafts',
              label: olderDraftsLabel(olderDraftCount),
              collapsedByDefault: true,
            }
          : presentation.kind === 'run'
            ? {
                id: presentation.run.id,
                label: `${subtaskCount} ${subtaskCount === 1 ? 'subtask' : 'subtasks'}`,
                renderSummary: (focusMember: (memberId: string) => void) => (
                  <RunBoardSummary
                    members={presentation.run.members}
                    onFocusMember={focusMember}
                  />
                ),
              }
            : undefined;
      return members.map((s) => {
        // "Show details & evidence" appears only when both halves of its
        // promise hold: the session genuinely ENDED — the canonical fold
        // through the ONE terminal predicate (archive#3227 A6) — and its
        // detail is the mutable one that renders the evidence region. A
        // read-only attached transcript has no such region.
        const showEvidence =
          !isReadOnlyAttachedSession(s) &&
          isTerminalLifecycle(orchestrationLifecycleLabel(s));
        // #2312: the server's Draft fold, read through the same label the
        // Drafts lane files by. Discarding is the server command, no confirm.
        const showDiscard = orchestrationLifecycleLabel(s) === 'Draft';
        const recency = sessionRecency(s);
        return {
          id: s.threadId,
          name: sessionTitle(s),
          subtitle: (
            <ActivityRowMeta
              session={s}
              agents={agents}
              now={now}
              foldedTurnCount={turnCounts.get(s.threadId)}
            />
          ),
          // EVERY row carries its section — the layout emits a heading only
          // when section CHANGES between neighbours.
          section,
          icon: <AgentIcon agent={sessionIconAgent(s, agents)} size="small" />,
          openChat: openConversationIds.has(s.threadId),
          badge: <SessionPullRequestConflictChip session={s} />,
          ...(group ? { group } : {}),
          // Interactive controls live in `trailing`, a sibling of the row
          // button, because a button may not contain interactive content.
          trailing: (
            <>
              {recency > 0 && (
                <time
                  className="activity-row__time"
                  dateTime={new Date(recency).toISOString()}
                  aria-hidden="true"
                >
                  {relativeTime(recency, now)}
                </time>
              )}
              {showDiscard && (
                <DiscardDraftButton
                  threadId={s.threadId}
                  title={sessionTitle(s)}
                  className="session-discard-draft"
                  closeSessionIds={sessions
                    .filter(
                      (other) =>
                        (other.conversationId ?? other.threadId) ===
                        (s.conversationId ?? s.threadId),
                    )
                    .map((other) => other.threadId)
                    .concat(s.conversationId ? [s.conversationId] : [])}
                />
              )}
              <ActivityRowMenu
                itemTitle={sessionTitle(s)}
                actions={rowActions(s, showEvidence)}
              />
            </>
          ),
        };
      });
    });
  });

  const selected = sessions.find((s) => s.threadId === selectedId) ?? null;

  const closeStopConfirm = () => {
    setStopTarget(null);
    stopTask.reset();
    const trigger = stopReturnFocusRef.current;
    stopReturnFocusRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  };

  // Captured from the skeleton's own `selectItem` (via `listIntro`) so a
  // newly started task is selected through the path that keeps the mobile
  // return-focus capture (archive#1259), exactly as the footer card did.
  const selectItemRef = useRef<((threadId: string) => void) | null>(null);

  const openTopLevelDelegation = () => {
    // Found by archive#1245's sweep: delegating invalidates the list, so the
    // control that opened the launcher may not survive it. Capture the whole
    // ancestor chain while it is still attached so the restore has a
    // fallback to walk.
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    delegationReturnFocusRef.current = trigger
      ? captureReturnFocus(trigger)
      : [];
    postDelegateSelectRef.current = selectItemRef.current;
    setIsDelegationOpen(true);
  };

  const closeDelegation = () => {
    const chain = delegationReturnFocusRef.current;
    delegationReturnFocusRef.current = [];
    setIsDelegationOpen(false);
    restoreReturnFocus(chain);
  };

  const searchActive = search.trim().length > 0;
  const collectionEmpty = sessions.length === 0;
  const resultsEmpty = !collectionEmpty && filtered.length === 0;
  const filteredEmptyTitle = searchActive
    ? `No activity matches “${search.trim()}”`
    : 'No activity matches these filters';

  return (
    <>
      <SplitPaneLayout
        heightResponsive
        items={items}
        selectedId={selectedId}
        onSelect={selectWithIntent}
        onDeselect={() => selectWithIntent(null)}
        onSearch={setSearch}
        searchValue={search}
        searchPlaceholder="Search activity…"
        loading={isLoading}
        error={sessionsError}
        onRetry={() => void refetch()}
        listEmptyTitle={
          resultsEmpty ? filteredEmptyTitle : 'Nothing has run yet'
        }
        listEmptyDescription={
          resultsEmpty
            ? 'Try another search, or clear the search and filters.'
            : 'Start a task with New task, or open a chat. What runs shows up here.'
        }
        /* Always the plain empty state: Activity's filtered-empty copy and
           its reset ("Clear search and filters", in the filter bar just
           above) cover filters as well as the query, which the layout's own
           search-only FilteredEmpty cannot. */
        collectionEmpty
        onAdd={openTopLevelDelegation}
        addLabel="New task"
        listIntro={(selectItem) => {
          selectItemRef.current = selectItem;
          return (
            <>
              {!collectionEmpty && (
                <ActivityFilterBar
                  filters={filters}
                  projectOptions={projectOptions}
                  originOptions={originOptions}
                  onChange={setFilters}
                  onClearAll={clearSearchAndFilters}
                  searchActive={searchActive}
                  resultsEmpty={resultsEmpty}
                />
              )}
              <ActionOperationsSection />
            </>
          );
        }}
        /* The surface is named Activity; each row stays a session, because
           that is what the list shows (`useOrchestrationSessionsQuery`: this
           Station's sessions, including read-only attached external-engine
           ones). */
        label="Activity"
        title="Activity"
        subtitle="What's running, what needs you, and what happened."
        emptyDescription="Select an item to read what happened and review its evidence."
        firstRunAnchor="activity"
      >
        {selected && (
          <SessionDetail
            apiBase={apiBase}
            session={selected}
            evidenceReveal={evidenceReveal}
            onTaskChanged={() => void refetch()}
            onOpenInChat={
              onOpenInChat ? () => onOpenInChat(selected.threadId) : undefined
            }
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

      {/* "New task" is always a TOP-LEVEL task: no parent, so the launcher
          never silently files it as someone else's subtask. Delegating a
          subtask belongs to a task's own detail. */}
      <DelegationLauncher
        isOpen={isDelegationOpen}
        apiBase={apiBase}
        onClose={closeDelegation}
        onDelegated={(task) => {
          setIsDelegationOpen(false);
          void refetch().finally(() => {
            postDelegateSelectRef.current?.(task.sessionId);
          });
        }}
      />

      <ConfirmModal
        isOpen={stopTarget !== null}
        role="alertdialog"
        variant="danger"
        title="Stop this turn?"
        message={
          stopTarget
            ? `“${sessionTitle(stopTarget)}” stops working on its current turn. You can send it a new message afterwards.`
            : ''
        }
        confirmLabel="Stop"
        pending={stopTask.isPending}
        error={
          stopTask.error
            ? stopTask.error instanceof Error
              ? stopTask.error.message
              : 'Unable to stop this turn'
            : null
        }
        onCancel={closeStopConfirm}
        onConfirm={() => {
          if (!stopTarget || stopTask.isPending) return;
          stopTask.mutate({ apiBase, threadId: stopTarget.threadId });
        }}
      />
    </>
  );
}
