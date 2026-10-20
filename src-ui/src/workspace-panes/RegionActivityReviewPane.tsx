import { withNormalizedAnswerability } from '@kontourai/station-contracts/orchestration';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  authenticatedFetch,
  type OrchestrationSessionDetail,
  StationHttpError,
} from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { ArrowLeftGlyph, ArrowRightGlyph } from '../components/icons/Glyph';
import { SessionDetail } from '../components/session-detail/SessionDetail';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import { useActivityReview } from '../contexts/ActivityReviewContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { chatDraftsStore } from '../contexts/chat-drafts-store';
import { navigationStore } from '../contexts/navigation-store';
import { openChatsStore } from '../contexts/open-chats-store';
import { describeRelatedOpenRefusal } from '../contexts/openRelatedFilePreview';
import { usePaneRelations } from '../contexts/PaneRelationsContext';
import { toastStore } from '../contexts/ToastContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { handOffAttachedContinuation } from '../lib/attached-continuation-handoff';
import { openerSelectionKey } from '../regions/pane-relations';
import {
  focusChatEventDetailForAction,
  resolveConversationOpenAction,
} from '../views/home/work-item-open-policy';
import { readActivityReviewPane } from './activityReviewPane';
import { FencedRelatedPane, RelatedPaneStrip } from './RelatedPaneStrip';
import './ActivityReviewPane.css';

export function RegionActivityReviewPane({
  instance,
}: {
  instance: WorkspacePaneInstance;
}) {
  const id = String(instance.instanceId);
  return (
    <FencedRelatedPane instanceId={id}>
      <ActivityReviewPane id={id} />
    </FencedRelatedPane>
  );
}

function ActivityReviewPane({ id }: { id: string }) {
  const state = useMemo(
    () => readActivityReviewPane(window.localStorage, id),
    [id],
  );
  const { apiBase } = useApiBase();
  const relations = usePaneRelations();
  const draftScope = JSON.stringify([
    'activity-review',
    relations.stationId,
    apiBase,
  ]);
  const draft = useSyncExternalStore(chatDraftsStore.subscribe, () =>
    state ? chatDraftsStore.getActivityDraft(draftScope, state.threadId) : '',
  );
  const { DiscardModal } = useUnsavedGuard(draft.trim().length > 0);
  const review = useActivityReview();
  const showSurface = useShowSurface();
  const [pending, setPending] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const intent = useRef(0);
  const query = useQuery({
    queryKey: [
      'activity-review',
      relations.stationId,
      apiBase,
      state?.threadId,
    ],
    enabled: state !== null,
    retry: false,
    refetchInterval: 5000,
    queryFn: async () => {
      if (!state) throw new Error('The saved review is missing.');
      const response = await authenticatedFetch(
        `${apiBase}/api/orchestration/sessions/${encodeURIComponent(state.threadId)}`,
      );
      const result = (await response.json()) as {
        success: boolean;
        data?: OrchestrationSessionDetail;
        error?: string;
      };
      if (!response.ok || !result.success || !result.data)
        throw new StationHttpError(
          response.status,
          result.error ?? 'Station could not read this activity.',
        );
      return {
        ...result.data,
        session: withNormalizedAnswerability(result.data.session),
      };
    },
  });
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const relation = relations.relationOf(id);
  const live = useRef({ relations, relation, apiBase });
  live.current = { relations, relation, apiBase };
  const source = review.source;
  const sameSource =
    relation !== undefined &&
    source !== null &&
    source.stationId === relation.stationId &&
    source.apiBase === apiBase &&
    source.opener.occurrenceId === relation.opener.occurrenceId &&
    (relation.kept ||
      openerSelectionKey(source.opener) ===
        openerSelectionKey(relation.opener));
  const index = sameSource
    ? source.items.findIndex(
        (item) =>
          item.threadId === state?.threadId &&
          (item.projectSlug ?? null) === state.projectSlug,
      )
    : -1;
  const previous = index > 0 ? source?.items[index - 1] : undefined;
  const next = index >= 0 ? source?.items[index + 1] : undefined;
  const move = (threadId: string) => {
    const current = review.readSource();
    if (!sameSource || !current || pending) return;
    setPending(true);
    void current
      .review(threadId)
      .then((outcome) => {
        if (!outcome.ok)
          toastStore.show(describeRelatedOpenRefusal(outcome.reason));
      })
      .finally(() => setPending(false));
  };
  const session = query.data?.session;
  const exact =
    state &&
    session &&
    session.threadId === state.threadId &&
    (session.projectSlug ?? null) === state.projectSlug;
  const open = async () => {
    if (!relation || !exact || pending) return;
    setPending(true);
    const kept = await relations.keep(id);
    if (!kept.ok) toastStore.show(describeRelatedOpenRefusal(kept.reason));
    setPending(false);
  };
  const action = exact
    ? resolveConversationOpenAction({
        threadId: session.threadId,
        conversationId: session.conversationId,
        agentSlug: session.assignedAgentSlug,
        controlMode: session.controlMode,
        projectSlug: session.projectSlug,
        model: session.model,
        delegationEnvironmentKind: session.delegation?.environmentKind,
      })
    : null;
  const openConversation = () => {
    if (action?.kind !== 'rehydrate' || !relation) return;
    const station = relation.stationId;
    navigationStore.runNavigationGuards(
      () => {
        if (
          live.current.relations.stationId !== station ||
          live.current.apiBase !== apiBase
        )
          return;
        const target = focusChatEventDetailForAction(action);
        if (target) openChatsStore.focus(target);
      },
      undefined,
      { owner: id },
    );
  };
  return (
    <section
      className="related-pane activity-review"
      aria-label="Activity quick review"
    >
      <DiscardModal />
      <RelatedPaneStrip instanceId={id} />
      <div className="activity-review__toolbar responsive-surface-actions">
        <h2 tabIndex={-1} ref={heading}>
          Quick review
        </h2>
        <IconButton
          aria-label="Previous"
          title="Previous visible activity"
          size="sm"
          disabled={!previous || pending}
          onClick={() => previous && move(previous.threadId)}
        >
          <ArrowLeftGlyph />
        </IconButton>
        <IconButton
          aria-label="Next"
          title="Next visible activity"
          size="sm"
          disabled={!next || pending}
          onClick={() => next && move(next.threadId)}
        >
          <ArrowRightGlyph />
        </IconButton>
        <ActionRow
          overflowLabel="More review actions"
          primary={
            <Button
              variant="secondary"
              size="sm"
              disabled={!exact || pending || !relation || relation.kept}
              onClick={() => void open()}
            >
              {relation?.kept ? 'Opened' : 'Open'}
            </Button>
          }
          secondary={
            <Button variant="ghost" size="sm" onClick={() => review.close(id)}>
              Close review
            </Button>
          }
          overflow={
            action?.kind === 'rehydrate'
              ? [
                  {
                    key: 'open-conversation',
                    label: 'Open conversation',
                    onSelect: openConversation,
                  },
                ]
              : []
          }
        />
      </div>
      {index < 0 && (
        <p className="activity-review__notice" role="status">
          {sameSource
            ? 'This item is outside Activity’s current visible results. Return to Activity to choose another item.'
            : 'Activity is no longer showing this review’s source. Return to Activity to start a new review.'}
        </p>
      )}
      {!state ? (
        <Empty
          label="This saved review is missing"
          description="Close this pane and review the item again from Activity."
        />
      ) : query.isPending ? (
        <SkeletonBlock label="Loading activity review" count={3} />
      ) : query.error ? (
        <ErrorState
          title={
            query.error instanceof StationHttpError &&
            query.error.status === 404
              ? 'This activity is no longer available'
              : query.error instanceof StationHttpError &&
                  [401, 403].includes(query.error.status)
                ? 'Station denied access to this activity'
                : 'Station could not load this activity'
          }
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : !exact ? (
        <Empty
          label="This activity no longer matches the review"
          description="Its Session or Project changed. Return to Activity and review it again."
        />
      ) : (
        <div className="activity-review__detail">
          <SessionDetail
            key={`${apiBase}\0${session.threadId}`}
            apiBase={apiBase}
            draftScope={draftScope}
            session={session}
            onTaskChanged={() => void query.refetch()}
            getSelectionIntent={() => intent.current}
            onContinueInChat={(draft) => {
              handOffAttachedContinuation({
                threadId: session.threadId,
                draft,
              });
              showSurface('chat', { session: session.threadId });
            }}
            onAdopted={(child, adoptedIntent, message) => {
              if (adoptedIntent !== intent.current) return;
              if (message.trim())
                chatDraftsStore.setActivityDraft(
                  apiBase,
                  child.threadId,
                  message,
                );
              showSurface('chat', { session: child.threadId });
            }}
          />
        </div>
      )}
    </section>
  );
}
