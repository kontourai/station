import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  fetchOrchestrationSession,
  interruptOrchestrationTurn,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActionOperationsSection } from '../components/action-operations/ActionOperationsSection';
import { Button } from '../components/Button';
import {
  endConversationReferenceDrag,
  startConversationReferenceDrag,
  useReferenceableConversations,
} from '../components/chat/conversationReferenceDrag';
import { DelegationLauncher } from '../components/chat-dock/DelegationLauncher';
import { DiscardDraftButton } from '../components/drafts/DiscardDraftButton';
import { ElapsedDuration } from '../components/ElapsedDuration';
import { AgentIcon } from '../components/icons/AgentIcon';
import {
  InboxRowStatusGlyph,
  WorkStatusLineText,
} from '../components/inbox-row/InboxRowStatus';
import { WorkGroupLabel } from '../components/inbox-row/WorkGroupLabel';
import { workGroupLabelText } from '../components/inbox-row/work-group-label';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { useIsPageFramed } from '../components/page-frame';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { SessionPullRequestConflictChip } from '../components/session/SessionPullRequestConflictChip';
import type { SessionEvidenceReveal } from '../components/session-detail/MutableSessionDetail';
import { SessionDetail } from '../components/session-detail/SessionDetail';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useAgents } from '../contexts/AgentsContext';
import { openChatsStore, useOpenChats } from '../contexts/open-chats-store';
import { toastStore } from '../contexts/ToastContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { copyToClipboard } from '../lib/clipboard';
import { relativeTime } from '../utils/relativeTime';
import { orchestrationLifecycleLabel } from '../utils/session-state';
import {
  humanizeId,
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
  activityOriginOptions,
  activityOriginShortLabel,
  activityProjectOptions,
  matchesActivityKind,
  matchesActivityOrigin,
  NO_ACTIVITY_FILTERS,
} from './activity/activity-list-model';
import { olderDraftsLabel } from './home/draft-lane';
import { isTerminalLifecycle } from './home/home-lane-model';
import {
  focusChatEventDetailForAction,
  resolveConversationOpenAction,
} from './home/work-item-open-policy';
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
  sessionWorkStatus,
} from './sessions/sessions-lane-model';
import './SessionsView.css';
import './page-layout.css';

/** Live-refresh cadence for the all-sessions list (the SSE feed is per-session). */
const SESSION_LIST_REFRESH_MS = 5000;

/** How often relative times and lanes re-derive. */
const ACTIVITY_CLOCK_MS = 30_000;

function isReadOnlyAttachedSession(
  session: OrchestrationSessionSummary,
): boolean {
  return session.controlMode === 'read-only-attached';
}

function activityRecency(session: OrchestrationSessionSummary): number {
  return orchestrationLifecycleLabel(session) === 'Draft'
    ? Date.parse(session.createdAt) || sessionRecency(session)
    : sessionRecency(session);
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
 * - the status ladder's line (`sessionWorkStatus`: the same words and the
 *   same lane fold the inbox rows print, so this list and the dock cannot
 *   name one session two ways), with the ladder's own glyph beside it so
 *   tone never carries the state alone;
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
  const status = sessionWorkStatus(session, agents, now);
  // The server attaches `terminalAttribution` only once a failed session has
  // closed; while it is still loaded the reason lives in the same two fields
  // the detail's failure text folds (`sessionFailureText`), so a fresh
  // failure reads the same in the row and in the detail.
  const freshFailure =
    status.rung === 'failed' && !status.detail
      ? (session.lastRuntimeErrorMessage ?? session.blockedReason)
      : undefined;
  // The server's own account of how a run ended, in the row's accessible
  // text: a failure's cause is already on the line, a stop's is the
  // ladder's reason.
  // Only a run that ENDED has one: a running row's detail is its current
  // tool, never an attribution of how it ended.
  const ended = status.rung === 'failed' || status.rung === 'stopped';
  const terminalAttribution = ended
    ? (status.detail ??
      freshFailure ??
      (status.rung === 'stopped' ? status.reason : undefined))
    : undefined;
  // When the cause IS the line's detail it is attributed in place: a second
  // sr-only copy read the failure twice.
  const attributedInLine =
    terminalAttribution !== undefined && terminalAttribution === status.detail;
  const attached = isReadOnlyAttachedSession(session);
  const agentName = attached ? null : sessionIconAgent(session, agents).name;
  const project = sessionProjectLabel(session);
  // An attached row's origin is the app it was started in, which is also its
  // agent name; the "Elsewhere" word beside it says the rest.
  const origin = activityOriginShortLabel(session);
  const originText = session.turnOrigin?.hasOtherOrigins
    ? `${origin ?? 'Several origins'} (also another origin)`
    : origin;
  const recency = activityRecency(session);
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
      <span
        className="activity-row-meta__state"
        data-tone={status.tone}
        title={status.reason}
      >
        <InboxRowStatusGlyph rung={status.rung} />{' '}
        <span data-testid="activity-row-state">
          {attributedInLine ? (
            <>
              {status.word}
              {' · '}
              <span data-testid="session-member-terminal-attribution">
                {status.detail}
              </span>
              {status.since !== undefined && (
                <>
                  {' · '}
                  <ElapsedDuration since={status.since} />
                </>
              )}
            </>
          ) : (
            <WorkStatusLineText status={status} />
          )}
        </span>
        {status.reason && status.rung !== 'stopped' && (
          <span className="sr-only">{` · ${status.reason}`}</span>
        )}
      </span>
      {terminalAttribution && !attributedInLine && (
        <>
          <span className="sr-only">{' · '}</span>
          <span
            className="sr-only"
            data-testid="session-member-terminal-attribution"
          >
            {terminalAttribution}
          </span>
        </>
      )}
      {freshFailure && (
        <>
          {' · '}
          <span className="activity-row-meta__detail">{freshFailure}</span>
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
        <span className="sr-only">{`, ${relativeTime(recency, now)}`}</span>
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
    data: inventory = [],
    isLoading,
    error: sessionsError,
    refetch,
  } = useOrchestrationSessionsQuery({
    refetchInterval: SESSION_LIST_REFRESH_MS,
  });
  const showSurface = useShowSurface();
  const routeKey = JSON.stringify([apiBase, sessionId, intentToken]);
  const [dismissedRoute, setDismissedRoute] = useState<string | null>(null);
  const lookupEnabled = Boolean(
    sessionId &&
      !isLoading &&
      dismissedRoute !== routeKey &&
      !inventory.some((session) => session.threadId === sessionId),
  );
  const routedSession = useQuery({
    queryKey: ['activity', 'routed-session', apiBase, sessionId],
    queryFn: () => fetchOrchestrationSession(sessionId!, apiBase),
    enabled: lookupEnabled,
    retry: false,
    staleTime: 0,
  });
  const routedSummary = routedSession.data?.session;
  const exactSession =
    lookupEnabled && routedSummary?.threadId === sessionId
      ? routedSummary
      : undefined;
  const sessions = useMemo(
    () => (exactSession ? [...inventory, exactSession] : inventory),
    [inventory, exactSession],
  );
  const agents = useAgents();
  // #3159: rows a message may reference are drag sources onto a composer.
  const referenceable = useReferenceableConversations();
  const framed = useIsPageFramed();
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
  // One clock for everything time-based on this surface — lane membership
  // (the recently-finished window) and the row times — so they age together instead of freezing at the last data change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ACTIVITY_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  // Kind / Project / Started from. Origins come from recorded session
  // provenance; the device management registry is operator-only and reading
  // it here can invalidate a valid browser session.
  const [filters, setFilters] = useState<ActivityFilters>(NO_ACTIVITY_FILTERS);
  const [isDelegationOpen, setIsDelegationOpen] = useState(false);
  /** The row a "Delegate subtask…" was chosen from; null for "New task". */
  const [delegationParent, setDelegationParent] =
    useState<OrchestrationSessionSummary | null>(null);
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
  const returnToList = () => {
    setDismissedRoute(routeKey);
    selectWithIntent(null);
    if (sessionId) showSurface('activity', {});
  };

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
  const matchesSearch = useCallback(
    (s: OrchestrationSessionSummary) => {
      const q = search.trim().toLowerCase();
      return (
        !q ||
        searchableSessionFields(s, agents).some((field) =>
          field.toLowerCase().includes(q),
        )
      );
    },
    [search, agents],
  );
  const filtered = useMemo(
    () => collectionFiltered.filter(matchesSearch),
    [collectionFiltered, matchesSearch],
  );
  // Option counts are FACETED and FOLDED: each picker counts the rows the
  // list would show if you picked that option, given every other active
  // filter and the search — over the same run/conversation-folded
  // population the lane headings count.
  const projectOptions = useMemo(
    () =>
      activityProjectOptions(
        sessions.filter(
          (s) =>
            matchesActivityKind(s, filters.kind) &&
            matchesActivityOrigin(s, filters.origin) &&
            matchesSearch(s),
        ),
        selectedId,
      ),
    [sessions, filters.kind, filters.origin, matchesSearch, selectedId],
  );
  const originOptions = useMemo(
    () =>
      activityOriginOptions(
        sessions.filter(
          (s) =>
            matchesActivityKind(s, filters.kind) &&
            matchesProjectFilter(s, filters.project) &&
            matchesSearch(s),
        ),
        selectedId,
      ),
    [sessions, filters.kind, filters.project, matchesSearch, selectedId],
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
    () => partitionSessionLanes({ sessions: filtered, agents, now }),
    [filtered, agents, now],
  );

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
    return { presentation, members, laneId, order };
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
  // Every Session of each conversation, for a discarded Draft's tab cleanup —
  // built once rather than scanning the whole list per Draft row.
  const threadIdsByConversation = useMemo(() => {
    const byConversation = new Map<string, string[]>();
    for (const session of sessions) {
      const key = session.conversationId ?? session.threadId;
      const ids = byConversation.get(key) ?? [];
      ids.push(session.threadId);
      byConversation.set(key, ids);
    }
    return byConversation;
  }, [sessions]);

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
  /**
   * "Open in chat" through archive#1297's one open policy — the same
   * `resolveConversationOpenAction` → `openChatsStore.focus` path Home and a
   * project's Live work use — so this surface cannot disagree with them about
   * whether a session can be reopened. Only the `rehydrate` outcome is an
   * "open in chat"; `navigate` means Station cannot rehydrate it (no agent,
   * or attached), and Activity already IS that fallback.
   */
  const chatOpenDetail = (session: OrchestrationSessionSummary) => {
    // A paired Station's record (#847) resolves to `navigate` in the policy
    // via `delegationEnvironmentKind`: its transcript is not local.
    const action = resolveConversationOpenAction({
      threadId: session.threadId,
      conversationId: session.conversationId,
      agentSlug: session.assignedAgentSlug,
      controlMode: session.controlMode,
      projectSlug: session.projectSlug,
      model: session.model,
      delegationEnvironmentKind: session.delegation?.environmentKind,
    });
    return action.kind === 'rehydrate'
      ? focusChatEventDetailForAction(action)
      : null;
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
      const detail = chatOpenDetail(s);
      if (detail)
        actions.push({
          id: 'open-in-chat',
          label: 'Open in chat',
          onSelect: () => openChatsStore.focus(detail),
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
    // Delegating a subtask of a delegated task: the launcher with this row
    // as parent (the coordinator card's former "Delegate subtask"). Not for a
    // paired Station's record — its work runs there.
    if (s.delegation && s.delegation.environmentKind !== 'peer')
      actions.push({
        id: 'delegate-subtask',
        label: 'Delegate subtask…',
        onSelect: (trigger) => openDelegation(s, trigger),
      });
    actions.push({
      id: 'copy-id',
      label: 'Copy session ID',
      onSelect: () => {
        void copyToClipboard(s.threadId).then((copied) =>
          // The store directly, not `useToast`: the toast host is the app
          // shell's, and this surface is also embedded where no provider
          // wraps it (the Developer archive tab's test harness).
          toastStore.show(
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
    // A section's count means members CLASSIFIED into this lane. A mixed-state
    // run RENDERS in its highest-priority member lane, but its members still
    // count where their own state belongs: one waiting child in an
    // otherwise-active run is 'Needs you · 1', never '· 2'. Stable across
    // expand/collapse because classification, not visibility, is counted.
    // Turn-sessions folded away by `foldConversationTurns` do NOT count: the
    // folded conversation is the unit this list shows, the same population
    // Home and Project Live Work count.
    //
    // The history lane is "Earlier", as on Home and in the dock (design round
    // 2026-10, C2): it used to split into "Earlier today" / "Yesterday" /
    // "This week" / "Older", a second set of names for one lane. Each row's
    // own time ("3h", "2d", "Sep 12") already says when.
    const classifiedIn = (row: (typeof lanePresentations)[number]) =>
      row.members.filter(
        (member) => lanesByThreadId.get(member.threadId) === laneId,
      ).length;
    const laneCount = lanePresentations.reduce(
      (total, row) => total + classifiedIn(row),
      0,
    );
    const section = workGroupLabelText(SESSION_LANE_LABELS[laneId], laneCount);
    const sectionLabel = (
      <WorkGroupLabel label={SESSION_LANE_LABELS[laneId]} count={laneCount} />
    );
    return lanePresentations.flatMap((row) => {
      const { presentation, members } = row;
      const subtaskCount = members.length - 1;
      // A run renders in its highest-priority member's lane — the point is
      // that a waiting subtask surfaces the run. When that pulls the run
      // above the lane its ROOT is in, the group label says why, so a root
      // reading "Completed" under "Needs you" is explained, not contradicted.
      const pulledUpBy =
        presentation.kind === 'run' &&
        lanesByThreadId.get(members[0].threadId) !== laneId
          ? members
              .slice(1)
              .filter(
                (member) => lanesByThreadId.get(member.threadId) === laneId,
              ).length
          : 0;
      const runLabel = `${subtaskCount} ${subtaskCount === 1 ? 'subtask' : 'subtasks'}${
        pulledUpBy > 0
          ? ` · ${pulledUpBy} ${SESSION_LANE_LABELS[laneId].toLowerCase()}`
          : ''
      }`;
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
                label: runLabel,
                // The board summarises the SAME population the label counts:
                // the subtasks, not the root row above them.
                renderSummary: (focusMember: (memberId: string) => void) => (
                  <RunBoardSummary
                    members={presentation.run.members.slice(1)}
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
        const recency = activityRecency(s);
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
          sectionLabel,
          icon: <AgentIcon agent={sessionIconAgent(s, agents)} size="small" />,
          openChat: openConversationIds.has(s.threadId),
          badge: <SessionPullRequestConflictChip session={s} />,
          ...(referenceable?.apiBase === apiBase &&
          referenceable.ids.has(s.conversationId ?? s.threadId)
            ? {
                onDragStart: (event: React.DragEvent<HTMLElement>) =>
                  startConversationReferenceDrag(event, {
                    id: s.conversationId ?? s.threadId,
                    title: sessionTitle(s),
                    ...(s.projectSlug ? { projectSlug: s.projectSlug } : {}),
                    apiBase,
                  }),
                onDragEnd: endConversationReferenceDrag,
              }
            : {}),
          ...(group ? { group } : {}),
          // Interactive controls live in `trailing`, a sibling of the row
          // button, because a button may not contain interactive content.
          // `responsive-surface-actions`: the shared action-row primitive,
          // whose direct controls get the 44px phone touch floor.
          trailing: (
            <div className="activity-row__actions responsive-surface-actions">
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
                  closeSessionIds={(
                    threadIdsByConversation.get(
                      s.conversationId ?? s.threadId,
                    ) ?? []
                  ).concat(s.conversationId ? [s.conversationId] : [])}
                />
              )}
              <ActivityRowMenu
                itemTitle={sessionTitle(s)}
                actions={rowActions(s, showEvidence)}
              />
            </div>
          ),
        };
      });
    });
  });

  const selected = sessions.find((s) => s.threadId === selectedId) ?? null;
  const lookupFailed =
    lookupEnabled &&
    !selectedId &&
    pendingRouteSelectionRef.current?.intent === selectionIntentRef.current &&
    (routedSession.isError || (routedSession.isSuccess && !exactSession));
  const lookupPending =
    lookupEnabled &&
    !selectedId &&
    routedSession.isFetching &&
    (routedSessionIdRef.current !== sessionId ||
      pendingRouteSelectionRef.current?.intent === selectionIntentRef.current);

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

  // Found by archive#1245's sweep: delegating invalidates the list, so the
  // control that opened the launcher may not survive it. Capture the whole
  // ancestor chain while it is still attached so the restore has a fallback.
  function openDelegation(
    parent: OrchestrationSessionSummary | null,
    trigger: HTMLElement | null,
  ) {
    delegationReturnFocusRef.current = trigger
      ? captureReturnFocus(trigger)
      : [];
    postDelegateSelectRef.current = selectItemRef.current;
    setDelegationParent(parent);
    setIsDelegationOpen(true);
  }
  const openTopLevelDelegation = () =>
    openDelegation(
      null,
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );

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
        onDeselect={
          lookupFailed || lookupPending
            ? returnToList
            : () => selectWithIntent(null)
        }
        unselectedDetailOpen={lookupFailed || lookupPending}
        emptyContent={
          lookupFailed ? (
            <ErrorState
              title="This activity isn't in the current list"
              description={
                routedSession.error?.message ??
                'Station did not return the requested activity item.'
              }
              action={
                <div className="responsive-surface-actions">
                  <Button
                    variant="secondary"
                    disabled={routedSession.isFetching}
                    onClick={() => {
                      void routedSession.refetch();
                      void refetch();
                    }}
                  >
                    Retry
                  </Button>
                  <Button variant="secondary" onClick={returnToList}>
                    Back to activity list
                  </Button>
                </div>
              }
            />
          ) : lookupPending ? (
            <div>
              <SkeletonBlock label="Checking requested activity" count={2} />
              <Button variant="secondary" onClick={returnToList}>
                Back to activity list
              </Button>
            </div>
          ) : undefined
        }
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
        /* "New task" is the header's primary action in every placement:
           framed (Activity as the main page) the layout puts `onAdd` in the
           page header; unframed (a dock pane) the layout would put it in the
           list FOOTER, so it renders at the top of the list instead. */
        {...(framed
          ? { onAdd: openTopLevelDelegation, addLabel: 'New task' }
          : {})}
        listIntro={(selectItem) => {
          selectItemRef.current = selectItem;
          return (
            <>
              {!framed && (
                <div className="activity-header-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={openTopLevelDelegation}
                  >
                    New task
                  </Button>
                </div>
              )}
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
        emptyDescription="Select an item to read what happened and review its evidence."
        firstRunAnchor="activity"
      >
        {selected && (
          <SessionDetail
            key={`${apiBase}\0${selected.threadId}`}
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

      {/* "New task" is always a TOP-LEVEL task (no parent), so the launcher
          never silently files it as someone else's subtask; a subtask comes
          only from a delegated row's "Delegate subtask…". */}
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
        // The parent's own name — the one its row is listed under — not a
        // humanized task id (a UUID stays unreadable however it is split).
        parentTaskLabel={
          delegationParent ? sessionTitle(delegationParent) : undefined
        }
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
