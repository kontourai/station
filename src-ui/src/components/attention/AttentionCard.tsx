import {
  approvalRefusalRemedy,
  defaultKeptScope,
  elevatedLabels,
  keptScopeForApproval,
  RequestedScopeChecklist,
  requestedScopeTokens,
} from '@kontourai/station-connect';
import type {
  AttentionPeerRequestReference,
  AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import type { PairingScope } from '@kontourai/station-contracts/environment-security';
import type {
  ApprovalAttentionItem,
  AttentionItem,
  DevicePairingAttentionItem,
  GateBlockedAttentionItem,
  GateExceptionAttentionItem,
  GateReviewAttentionItem,
  GateRouteBackAttentionItem,
  NeedsInputAttentionItem,
  ProposedChangeAttentionItem,
  ReviewPendingAttentionItem,
  SessionFailedAttentionItem,
} from '@kontourai/station-sdk';
import {
  acceptFlowException,
  DevicePairingRequestActionError,
  evaluateFlowGate,
  sendOrchestrationTurn,
  useAcknowledgeAttentionItemMutation,
  useConfirmDevicePairingRequestMutation,
  useDenyDevicePairingRequestMutation,
  useDismissNotificationMutation,
  useNotificationActionMutation,
  useQueryClient,
  useSystemStatusForApiBaseQuery,
} from '@kontourai/station-sdk';
import {
  continueDelegatedTask,
  respondToDelegatedTaskRequest,
} from '@kontourai/station-sdk/client';
import { operatorCliCommand } from '@kontourai/station-shared/ports';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { openApprovalConversation } from '../../lib/openApprovalConversation';
import {
  attentionKindLabel,
  isAcknowledgeableAttentionItem,
  isApprovalLivePending,
  isPeerHostedAttentionItem,
  peerAttentionElsewhereText,
  peerRequestDecision,
  sessionFailedIdentity,
  sessionFailureCause,
} from '../../utils/attention';
import {
  acknowledgeThenOpen,
  isPlainLeftClick,
  navigateToAttentionTarget,
} from '../../utils/attentionOpen';
import { formatNotificationTime } from '../../utils/notifications';
import { StationToolLibraryProvider } from '../../views/agent-editor/ToolLibraryContext';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import { NoticeAction } from '../notifications/NoticeAction';
import { SkeletonList } from '../state';
import './AttentionCard.css';
import { useProposedChangeDecision } from '../review/proposedChangeDecision';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from './notificationRowActions';

/** Recorded on a decision taken from the inbox. See `proposedChangeDecision`. */
const INBOX_DECISION_SURFACE = 'notifications';

const loadPluginProposalActions = () =>
  import('./PluginProposalAttentionActions').then((module) => ({
    default: module.PluginProposalAttentionActions,
  }));

const loadNeedsInputReply = () =>
  import('./NeedsInputReply').then((module) => ({
    default: module.NeedsInputReply,
  }));

export function AttentionCard({
  item,
  focused = false,
}: {
  item: AttentionItem;
  focused?: boolean;
}) {
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) cardRef.current?.focus();
  }, [focused]);
  return (
    <article
      ref={cardRef}
      className={`attention-item${focused ? ' attention-item--focused' : ''}`}
      data-testid="attention-item"
      tabIndex={focused ? -1 : undefined}
    >
      <header className="attention-item__header">
        <div className="attention-item__content">
          <div className="attention-item__type">
            {attentionKindLabel(item.kind)}
          </div>
          <div className="attention-item__message">{item.title}</div>
          {item.kind === 'session-failed' ? (
            <SessionFailedDetail item={item} />
          ) : (
            item.body && (
              <div className="attention-item__detail">{item.body}</div>
            )
          )}
          {item.kind === 'gate-route-back' && (
            <GateRouteBackDetail item={item} />
          )}
        </div>
        <time className="attention-item__time">
          {formatNotificationTime(item.updatedAt)}
        </time>
      </header>
      <div className="attention-item__footer">
        <AttentionAction item={item} />
        {/* #1536 D8: a standing notice is not dismissible — acknowledging the
          only row that says why chat cannot start would leave the inbox
          claiming nothing needs you while it still does. One predicate, shared
          with "Dismiss all" and with the server's own refusal. */}
        {item.kind !== 'approval' && isAcknowledgeableAttentionItem(item) && (
          <DismissAttentionItem item={item} />
        )}
      </div>
    </article>
  );
}

/**
 * archive#3203: the cause and the identity of a failed session. The cause is
 * rendered unconditionally — an absent `body` means no reason was recorded,
 * and saying that is what distinguishes it from a row that simply forgot to
 * show one (the reported "'Session failed' tells me nothing"). The identity
 * line renders only what the projection carried.
 */
function SessionFailedDetail({ item }: { item: SessionFailedAttentionItem }) {
  const identity = sessionFailedIdentity(item);
  return (
    <>
      <div
        className="attention-item__detail attention-item__detail--cause"
        data-testid="attention-cause"
      >
        {sessionFailureCause(item)}
      </div>
      {identity && (
        <div
          className="attention-item__identity"
          data-testid="attention-identity"
        >
          {identity}
        </div>
      )}
    </>
  );
}

const loadToolRequestPanel = () =>
  import('../profile/ToolRequestsPanel').then((module) => ({
    default: module.ToolRequestsPanel,
  }));

function AttentionAction({ item }: { item: AttentionItem }) {
  // A task running on a paired Station: its thread id here names only the
  // local lifecycle record, so a reply or request inspection would address
  // nothing. Same rule, and same note, as the Activity detail's peer branch.
  if (isPeerHostedAttentionItem(item)) return <PeerHostedAction item={item} />;
  switch (item.kind) {
    case 'tool-request':
      return (
        <StationToolLibraryProvider>
          <LazyBoundary
            load={loadToolRequestPanel}
            componentProps={{ requestId: item.source.requestId }}
            pending={<SkeletonList count={1} />}
          />
        </StationToolLibraryProvider>
      );
    case 'approval':
      return item.requestReference ? (
        <ExactRequestAction
          reference={item.requestReference}
          openHref={item.openHref}
        />
      ) : (
        <ApprovalActions item={item} />
      );
    case 'needs_input':
      return <NeedsInputAction item={item} />;
    case 'review_pending':
      return item.requestReference ? (
        <ExactRequestAction
          reference={item.requestReference}
          openHref={item.openHref}
        />
      ) : (
        <OpenSessionAction item={item} />
      );
    case 'session-failed':
      return <SessionFailedAction item={item} />;
    case 'gate-route-back':
    case 'gate-blocked':
      return <GateReEvaluateAction item={item} />;
    case 'gate-exception':
      return <GateExceptionAction item={item} />;
    case 'device-pairing':
      return <DevicePairingActions item={item} />;
    // #2064 D4: the two kinds that moved in from Review.
    case 'proposed-change':
      return <ProposedChangeActions item={item} />;
    case 'gate-review':
      return <GateReviewAction item={item} />;
    // #2323 S5: an agent asked for a plugin change it cannot make itself.
    // Loaded on demand: the summary stays off the first paint.
    case 'plugin-lifecycle-proposal':
      return (
        <LazyBoundary
          load={loadPluginProposalActions}
          componentProps={{ item }}
          pending={<SkeletonList count={1} label="Loading plugin proposal" />}
        />
      );
    // #1536 D8: the requirement's own route out. No secondary action —
    // the item resolves by configuring a connection, not by answering here.
    case 'setup-incomplete':
      return <OpenModelConnectionsLink href={item.openHref} />;
  }
}

const loadRequestInspection = () =>
  import('./RequestInspectionDialog').then((module) => ({
    default: module.RequestInspectionDialog,
  }));

function ExactRequestAction({
  reference,
  openHref,
}: {
  reference: AttentionRequestReference;
  openHref?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  const [selected, setSelected] = useState<{
    reference: AttentionRequestReference;
    authority: NonNullable<typeof authority>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (
      selected &&
      (authority?.authorityKey !== selected.authority.authorityKey ||
        !selected.authority.isCurrent())
    )
      setSelected(null);
  }, [authority, selected]);
  return (
    <>
      <NoticeAction
        type="button"
        className="notice-action--primary"
        onClick={() => {
          if (!authority?.isCurrent()) {
            setError('Reconnect to inspect this request.');
            return;
          }
          setError(null);
          setSelected({ reference: { ...reference }, authority });
        }}
      >
        Inspect request
      </NoticeAction>
      {error ? <p role="alert">{error}</p> : null}
      {selected ? (
        <LazyBoundary
          load={loadRequestInspection}
          componentProps={{
            ...selected,
            openHref,
            onClose: () => setSelected(null),
          }}
          pending={
            <SkeletonList count={1} label="Opening request inspection" />
          }
        />
      ) : null}
    </>
  );
}

/**
 * #765 D5: Approve/Deny for a pending inbound pairing request, posting to
 * the SAME gated `/api/pairing/requests/:requestId` routes the Connections
 * pairing panel and `station environment access approve|deny` use — the
 * pairing family's authorization at the HTTP boundary decides, never this
 * card. On success both projections refresh and the item resolves out of
 * Needs attention; refusals render the honest remedy (mirrors
 * `HostDevicePairingPanel`'s copy for the same statuses).
 */
function DevicePairingActions({ item }: { item: DevicePairingAttentionItem }) {
  const confirmMutation = useConfirmDevicePairingRequestMutation();
  const denyMutation = useDenyDevicePairingRequestMutation();
  const busy = confirmMutation.isPending || denyMutation.isPending;
  // The approve command names this Station's own CLI, read from its build.
  const { apiBase } = useApiBase();
  const operatorCli = operatorCliCommand(
    useSystemStatusForApiBaseQuery(apiBase).data?.build?.channel,
  );
  // What the approver keeps of what the device asked for; all of it unless
  // limited. An older Station sends no requested scope: no list, and
  // Approve keeps whatever the request carries.
  const requestedScope = item.requestedScope ?? '';
  const [kept, setKept] = useState<ReadonlySet<PairingScope>>(() =>
    defaultKeptScope(requestedScope),
  );
  // The card only says a device is asking; the details and the decision
  // open in a dialog.
  const [reviewing, setReviewing] = useState(false);
  // #765 D5 live verification: `access:approve` is operator-promotion-only,
  // so a paired browser session can read this item but the pairing routes
  // answer its approve/deny with 401 `authentication_required` — the buttons
  // were structurally dead there. `viewerCanDecide` is the server's own
  // boundary predicate evaluated for THIS session; when it says no, render
  // the remedy the panel prints for the same refusal instead of dead buttons.
  if (!item.viewerCanDecide) {
    return (
      <div
        className="attention-item__detail"
        data-testid="attention-pairing-remedy"
      >
        {pairingApprovalRemedy(item, operatorCli, kept)}
      </div>
    );
  }
  const decision = (
    <div className="notice-actions">
      <NoticeAction
        type="button"
        className="notice-action--primary"
        disabled={busy}
        onClick={() => {
          const scope = requestedScope
            ? keptScopeForApproval(requestedScope, kept)
            : undefined;
          confirmMutation.mutate(
            scope === undefined
              ? item.source.requestId
              : { requestId: item.source.requestId, scope },
            // Decided: close rather than offer the same decision again
            // until the item refreshes away.
            { onSuccess: () => setReviewing(false) },
          );
        }}
      >
        Approve
      </NoticeAction>
      <NoticeAction
        type="button"
        className="notice-action--danger"
        disabled={busy}
        onClick={() =>
          denyMutation.mutate(item.source.requestId, {
            onSuccess: () => setReviewing(false),
          })
        }
      >
        Deny
      </NoticeAction>
    </div>
  );
  return (
    <>
      <div className="notice-actions">
        <NoticeAction
          type="button"
          className="notice-action--primary"
          onClick={() => setReviewing(true)}
        >
          Review
        </NoticeAction>
      </div>
      {reviewing && (
        <Dialog
          title={`${item.deviceName} is asking to pair`}
          closeLabel="Close pairing request"
          // Not closable while a decision is in flight, so its outcome shows.
          dismissible={!busy}
          hideClose={busy}
          onClose={() => setReviewing(false)}
          footer={decision}
        >
          {requestedScope ? (
            <RequestedScopeChecklist
              deviceName={item.deviceName}
              requestedScope={requestedScope}
              kept={kept}
              onChange={setKept}
              disabled={busy}
            />
          ) : (
            <p className="attention-item__detail">{item.body}</p>
          )}
          <MutationError
            error={describePairingActionError(
              confirmMutation.error,
              item,
              'approve',
              operatorCli,
              // What the refused approval sent, not the boxes as they are now.
              submittedKept(confirmMutation.variables, requestedScope) ?? kept,
            )}
          />
          <MutationError
            error={describePairingActionError(
              denyMutation.error,
              item,
              'deny',
              operatorCli,
              kept,
            )}
          />
        </Dialog>
      )}
    </>
  );
}

/**
 * The remedy for a session that cannot decide: the SAME sentence the panel
 * and the 403 error path print, because it is the same fact arriving earlier
 * — before a doomed request instead of after one.
 */
function pairingApprovalRemedy(
  item: DevicePairingAttentionItem,
  operatorCli: string,
  kept: ReadonlySet<PairingScope>,
  /** The elevated permissions a refused approval kept, by label. */
  keptElevated: readonly string[] = [],
): string {
  return approvalRefusalRemedy({
    deviceName: item.deviceName,
    requestId: item.source.requestId,
    operatorCli,
    // The printed command grants exactly what this card would have kept.
    keptScope: item.requestedScope
      ? keptScopeForApproval(item.requestedScope, kept)
      : undefined,
    keptElevated,
  });
}

/** The scope an approval mutation sent: all requested for a bodyless one. */
function submittedKept(
  variables: string | { requestId: string; scope?: string } | undefined,
  requestedScope: string,
): ReadonlySet<PairingScope> | undefined {
  if (variables === undefined || !requestedScope) return undefined;
  return new Set(
    requestedScopeTokens(
      typeof variables === 'string'
        ? requestedScope
        : (variables.scope ?? requestedScope),
    ),
  );
}

/**
 * Same status → copy mapping `HostDevicePairingPanel.actOnRequest` renders,
 * so the two approve surfaces describe a refusal identically. 403 on approve
 * is the pairing service's "a request cannot approve itself" refusal
 * (`approval_requires_operator`): the remedy is a credentialed session, so
 * the message names the one that always exists on the host.
 */
function describePairingActionError(
  error: unknown,
  item: DevicePairingAttentionItem,
  action: 'approve' | 'deny',
  operatorCli: string,
  kept: ReadonlySet<PairingScope>,
): unknown {
  if (error == null) return null;
  if (!(error instanceof DevicePairingRequestActionError)) return error;
  if (error.status === 401) {
    return new Error(
      "This device's access to this Station needs review. Reconnect it, then try again.",
    );
  }
  if (error.status === 403 && action === 'approve') {
    return new Error(
      pairingApprovalRemedy(item, operatorCli, kept, elevatedLabels(kept)),
    );
  }
  if (error.status === 404 || error.status === 410) {
    return new Error(
      'That access request has already expired or been removed.',
    );
  }
  return new Error(
    `This Station could not ${action} that access request. Try again.`,
  );
}

/**
 * #2064 (D4): decide a proposed change from the inbox.
 *
 * The decision goes through `useProposedChangeDecision`, the module
 * `ReviewQueueView` also calls, so both surfaces POST to
 * `/api/proposed-changes/:id/approve|reject` with the same payload shape and
 * invalidate the same key. What differs is the recorded surface name, which
 * is the point: the change's decision record says where a human decided it.
 *
 * No bulk affordance here, deliberately (#2064): "Approve all" over a list
 * whose rows the reader has not opened is a decision made by a button, and
 * the inbox is where individual asks land. Bulk stays on Review.
 */
function ProposedChangeActions({
  item,
}: {
  item: ProposedChangeAttentionItem;
}) {
  const decision = useProposedChangeDecision(INBOX_DECISION_SURFACE);
  return (
    <>
      <div className="notice-actions">
        <NoticeAction
          type="button"
          className="notice-action--primary"
          disabled={decision.pending}
          onClick={() =>
            decision.decide(item.source.proposedChangeId, 'approve')
          }
        >
          Approve
        </NoticeAction>
        <NoticeAction
          type="button"
          className="notice-action--danger"
          disabled={decision.pending}
          onClick={() =>
            decision.decide(item.source.proposedChangeId, 'reject')
          }
        >
          Reject
        </NoticeAction>
      </div>
      {/* The diff itself is not in the inbox; deciding blind is not the only
          option offered. */}
      <a
        className="button notice-action notice-action--secondary"
        href={item.openHref}
      >
        Open in Review
      </a>
      <MutationError error={decision.error} />
    </>
  );
}

/**
 * #2064 (D4): a paused gate review's only affordance is to go read it.
 *
 * There is nothing to decide from a row: the Review page makes no mutation
 * for these sessions either, and the continuation endpoint is driven from the
 * review workbench with the reviewer's own resolutions attached. An
 * Approve-shaped button here would claim an authority this surface does not
 * have.
 */
function GateReviewAction({ item }: { item: GateReviewAttentionItem }) {
  return (
    <a
      className="button notice-action notice-action--secondary"
      href={item.openHref}
    >
      Open review
    </a>
  );
}

function ApprovalActions({ item }: { item: ApprovalAttentionItem }) {
  const mutation = useNotificationActionMutation();
  const dismissMutation = useDismissNotificationMutation();
  const livePending = isApprovalLivePending(item);
  // archive#3779: measured — this does NOT delete. `DELETE /notifications/:id`
  // sets `status: 'dismissed'` and keeps the record; what differs from the bulk
  // acknowledge is the subject and terminality, not destruction.
  const dismiss = () => dismissMutation.mutate(item.source.notificationId);
  return (
    <>
      <div className="notice-actions">
        {item.actions.map((action) => (
          <NoticeAction
            key={action.id}
            type="button"
            className={`notice-action--${action.variant ?? 'secondary'}`}
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                {
                  actionId: action.id,
                  id: item.source.notificationId,
                },
                {
                  onSuccess: () => {
                    if (item.openHref) openApprovalConversation(item.openHref);
                  },
                },
              )
            }
          >
            {action.label}
          </NoticeAction>
        ))}
        {/*
         * Non-actionable/terminal (no live actions, or no resolvable
         * session to view the decision in): dismiss sits at full
         * prominence right alongside whatever actions do exist — there is
         * nothing else useful left to do with this item.
         */}
        {!livePending && (
          <NoticeAction
            type="button"
            className="notice-action--ghost"
            disabled={dismissMutation.isPending}
            onClick={dismiss}
          >
            {DISMISS_NOTIFICATION_ACTION.label}
          </NoticeAction>
        )}
      </div>
      {item.openHref && <OpenSessionLink href={item.openHref} />}
      {/*
       * Genuinely-pending (live actions AND a resolvable session): dismiss
       * stays available but visually secondary so approve/deny stay
       * primary and a casual click can't discard a live decision.
       */}
      {livePending && (
        <button
          type="button"
          className="attention-dismiss-link"
          disabled={dismissMutation.isPending}
          onClick={dismiss}
        >
          {DISMISS_NOTIFICATION_ACTION.label}
        </button>
      )}
      <MutationError error={mutation.error} />
      <MutationError error={dismissMutation.error} />
    </>
  );
}

function PeerHostedAction({
  item,
}: {
  item: NeedsInputAttentionItem | ReviewPendingAttentionItem;
}) {
  const decision = peerRequestDecision(item);
  return (
    <>
      {decision.kind === 'decide' ? (
        <PeerRequestDecisionActions reference={decision.reference} />
      ) : decision.kind === 'answer' ? (
        <PeerInputAnswer reference={decision.reference} itemId={item.id} />
      ) : (
        <div
          className="attention-item__detail"
          data-testid="attention-peer-elsewhere"
        >
          {decision.reason ? `${decision.reason} ` : ''}
          {peerAttentionElsewhereText(item.environmentName)}
        </div>
      )}
      {/* The projection links a peer item to the Activity detail. */}
      <OpenSessionLink href={item.openHref} label="Open in Activity" />
    </>
  );
}

/**
 * Allow/Deny for the paired Station's own open request, forwarded through
 * `POST /api/orchestration/delegations/:taskId/respond` with the record's
 * `environmentId` — the paired Station re-checks that the request is still
 * open and decides it there. Never a local `respondToRequest`: the request
 * id names a request on the other Station.
 */
function PeerRequestDecisionActions({
  reference,
}: {
  reference: AttentionPeerRequestReference;
}) {
  const scope = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (decision: 'accept' | 'decline') => {
      if (!scope?.isCurrent())
        throw new Error('Reconnect to this Station to decide this request.');
      return respondToDelegatedTaskRequest(
        scope.apiBase,
        reference.taskId,
        {
          requestId: reference.requestId,
          decision,
          environmentId: reference.environmentId,
        },
        { requestScope: scope },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
        queryClient.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      ]);
    },
  });
  return (
    <>
      <div className="notice-actions">
        <NoticeAction
          type="button"
          className="notice-action--primary"
          disabled={mutation.isPending || mutation.isSuccess}
          onClick={() => mutation.mutate('accept')}
        >
          Allow
        </NoticeAction>
        <NoticeAction
          type="button"
          className="notice-action--danger"
          disabled={mutation.isPending || mutation.isSuccess}
          onClick={() => mutation.mutate('decline')}
        >
          Deny
        </NoticeAction>
      </div>
      <MutationError error={mutation.error} />
    </>
  );
}

/**
 * A reply to the paired Station's own open input question, delivered through
 * `POST /api/orchestration/delegations/:taskId/continue` with the record's
 * `environmentId` and `expectedInputRequest` naming exactly that request on
 * the paired Station. This Station forwards it only to a Station that
 * advertises enforcing the binding; the paired Station refuses it when the
 * question was answered or replaced, and that refusal is shown.
 */
function PeerInputAnswer({
  reference,
  itemId,
}: {
  reference: AttentionPeerRequestReference & {
    threadId: string;
    requestEventId: string;
  };
  itemId: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState('');
  const mutation = useMutation({
    mutationFn: (message: string) => {
      if (!scope?.isCurrent())
        throw new Error('Reconnect to this Station to answer this request.');
      return continueDelegatedTask(
        scope.apiBase,
        reference.taskId,
        {
          message,
          environmentId: reference.environmentId,
          expectedInputRequest: {
            threadId: reference.threadId,
            requestId: reference.requestId,
            requestEventId: reference.requestEventId,
          },
        },
        { requestScope: scope },
      );
    },
    onSuccess: async () => {
      setAnswer('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
        queryClient.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      ]);
    },
  });
  return (
    <>
      <form
        className="attention-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) mutation.mutate(answer);
        }}
      >
        {/* Same scale as the item's own detail line, and the same compact
            action row as Allow/Deny. */}
        <label
          className="attention-item__detail"
          htmlFor={`attention-peer-answer-${itemId}`}
        >
          Answer on the paired Station
        </label>
        <textarea
          id={`attention-peer-answer-${itemId}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        <div className="notice-actions">
          <NoticeAction
            type="submit"
            className="notice-action--primary"
            disabled={
              !answer.trim() || mutation.isPending || mutation.isSuccess
            }
          >
            Send answer
          </NoticeAction>
        </div>
      </form>
      <MutationError error={mutation.error} />
    </>
  );
}

function NeedsInputAction({ item }: { item: NeedsInputAttentionItem }) {
  return item.requestType === 'input' && item.inputReference ? (
    <ScopedInputReply item={{ ...item, inputReference: item.inputReference }} />
  ) : (
    <LegacyNeedsInputAction item={item} />
  );
}
function ScopedInputReply({
  item,
}: {
  item: NeedsInputAttentionItem & { inputReference: AttentionRequestReference };
}) {
  const scope = useHostRequestAuthorityScope();
  return (
    <>
      {scope?.isCurrent() ? (
        <LazyBoundary
          key={`${scope.apiBase}:${scope.authorityKey}:${item.source.threadId}`}
          load={loadNeedsInputReply}
          componentProps={{ item, scope }}
          pending={<SkeletonList count={1} label="Loading answer controls" />}
        />
      ) : (
        <p role="status">Connect to this Station to answer.</p>
      )}
      <OpenSessionLink href={item.openHref} />
    </>
  );
}
function LegacyNeedsInputAction({ item }: { item: NeedsInputAttentionItem }) {
  const [answer, setAnswer] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (text: string) =>
      sendOrchestrationTurn({ threadId: item.source.threadId, text }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
        queryClient.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      ]);
    },
  });
  return (
    <>
      <form
        className="attention-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) mutation.mutate(answer);
        }}
      >
        <label htmlFor={`attention-answer-${item.id}`}>
          Answer this session
        </label>
        <textarea
          id={`attention-answer-${item.id}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        <NoticeAction
          type="submit"
          className="notice-action--primary"
          disabled={!answer.trim() || mutation.isPending}
        >
          Send answer
        </NoticeAction>
      </form>
      <OpenSessionLink href={item.openHref} />
      <MutationError error={mutation.error} />
    </>
  );
}

/** Without an exact request reference, review continues in the session. */
function OpenSessionAction({ item }: { item: ReviewPendingAttentionItem }) {
  return (
    <a
      className="button notice-action notice-action--secondary"
      href={item.openHref}
    >
      Open session
    </a>
  );
}

/**
 * archive#1914: `session-failed` is DERIVED on every read (see the item's
 * own doc comment), so "Dismiss" here does not delete a stored notification
 * the way every other Dismiss button does — it records an acknowledgement of
 * THIS version of the failure (`AttentionProjectionService.acknowledge`) and
 * the item drops out of the actionable count while staying visible as
 * history. A session that fails again later (a newer `updatedAt`) surfaces
 * as unacknowledged again, on its own, with no extra plumbing here.
 */
function SessionFailedAction({ item }: { item: SessionFailedAttentionItem }) {
  const { apiBase } = useApiBase();
  const mutation = useAcknowledgeAttentionItemMutation(apiBase);
  return (
    <>
      {/*
       * archive#3203: opening records the SAME acknowledgement Dismiss does.
       * The asymmetry between the two was the bug — both are the user acting
       * on this row, and only one of them decremented the badge.
       *
       * `onOpen` is what makes that true. `OpenSessionLink` returns early
       * without it (`if (!onOpen || !isPlainLeftClick(event)) return`), so the
       * comment above described a behaviour the DOM stopped having when D9
       * (ed3e767) rewrote this component and dropped the prop — a label
       * nothing derived, with its own test left red on main to say so.
       */}
      <OpenSessionLink
        href={item.openHref}
        onOpen={() => mutation.mutateAsync(item.id)}
      />
    </>
  );
}

/**
 * A dismissal hides an attention fact; it does not resolve its source, and it
 * destroys nothing — so it keeps the word "Dismiss" (archive#3779), read from
 * the shared action model rather than written here.
 */
function DismissAttentionItem({ item }: { item: AttentionItem }) {
  const { apiBase } = useApiBase();
  const mutation = useAcknowledgeAttentionItemMutation(apiBase);
  return (
    <div className="notice-actions">
      <NoticeAction
        type="button"
        className="notice-action--ghost"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(item.id)}
      >
        {ACKNOWLEDGE_ATTENTION_ACTION.label}
      </NoticeAction>
      <MutationError error={mutation.error} />
    </div>
  );
}

function GateRouteBackDetail({ item }: { item: GateRouteBackAttentionItem }) {
  if (!item.routeBackTo && typeof item.attempt !== 'number') return null;
  return (
    <div className="attention-item__detail">
      {item.routeBackTo && <>Routes back to {item.routeBackTo}. </>}
      {typeof item.attempt === 'number' && (
        <>
          Attempt {item.attempt}
          {typeof item.maxAttempts === 'number'
            ? ` of ${item.maxAttempts}`
            : ''}
          .
        </>
      )}
    </div>
  );
}

/**
 * Shared affordance for `gate-route-back` and `gate-blocked`: a deep link
 * into the owning Flow run console plus an optional re-evaluate, which posts
 * to the same `POST .../runs/:runId/evaluate` route the console itself uses
 * — resolving the gate here produces the identical run-history trail as
 * resolving it in place.
 */
function GateReEvaluateAction({
  item,
}: {
  item: GateRouteBackAttentionItem | GateBlockedAttentionItem;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      evaluateFlowGate({
        projectSlug: item.source.projectSlug,
        runId: item.source.runId,
        gate: item.source.gateId,
      }),
    onSuccess: () => invalidateGateQueries(queryClient, item.source),
  });
  return (
    <>
      <div className="notice-actions">
        <NoticeAction
          type="button"
          className="notice-action--secondary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Re-evaluate
        </NoticeAction>
      </div>
      <OpenFlowConsoleLink href={item.openHref} />
      <MutationError error={mutation.error} />
    </>
  );
}

/**
 * `gate-exception`: the gate's retry budget is exhausted, so re-evaluating
 * cannot resolve it — a human exception decision is genuinely pending. The
 * dialog posts to the EXISTING `POST .../runs/:runId/exception` endpoint
 * (receipt parity with accepting the exception from the run console).
 */
function GateExceptionAction({ item }: { item: GateExceptionAttentionItem }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { reason: string; authority: string }) =>
      acceptFlowException({
        projectSlug: item.source.projectSlug,
        runId: item.source.runId,
        gate: item.source.gateId,
        reason: input.reason,
        authority: input.authority,
      }),
    onSuccess: () => {
      invalidateGateQueries(queryClient, item.source);
      setIsOpen(false);
    },
  });
  return (
    <>
      <div className="notice-actions">
        <NoticeAction
          type="button"
          className="notice-action--primary"
          onClick={() => setIsOpen(true)}
        >
          Accept exception…
        </NoticeAction>
      </div>
      <OpenFlowConsoleLink href={item.openHref} />
      <MutationError error={mutation.error} />
      {isOpen && (
        <AcceptExceptionDialog
          isPending={mutation.isPending}
          onCancel={() => setIsOpen(false)}
          onSubmit={(input) => mutation.mutate(input)}
        />
      )}
    </>
  );
}

function AcceptExceptionDialog({
  isPending,
  onCancel,
  onSubmit,
}: {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (input: { reason: string; authority: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const [authority, setAuthority] = useState('');
  const reasonId = useId();
  const authorityId = useId();
  const canSubmit = reason.trim().length > 0 && authority.trim().length > 0;
  return (
    <Dialog
      title="Accept exception"
      closeLabel="Close accept exception"
      onClose={onCancel}
      historyMode="none"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !isPending) onSubmit({ reason, authority });
        }}
      >
        <div className="attention-exception-fields">
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
          <label htmlFor={authorityId}>Authority</label>
          <input
            id={authorityId}
            type="text"
            value={authority}
            onChange={(event) => setAuthority(event.target.value)}
            required
          />
        </div>
        <div className="notice-actions">
          <NoticeAction type="button" onClick={onCancel}>
            Cancel
          </NoticeAction>
          <NoticeAction
            type="submit"
            className="notice-action--primary"
            disabled={!canSubmit}
            pending={isPending}
          >
            Accept exception
          </NoticeAction>
        </div>
      </form>
    </Dialog>
  );
}

function invalidateGateQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  source: { projectSlug: string; runId: string },
) {
  queryClient.invalidateQueries({ queryKey: ['attention'] });
  queryClient.invalidateQueries({
    queryKey: ['flow-run-console', source.projectSlug, source.runId],
  });
  queryClient.invalidateQueries({
    queryKey: ['flow-runs', source.projectSlug],
  });
}

/**
 * `onOpen`, when supplied, runs to completion before the browser leaves for
 * `href` (archive#3203) — see `acknowledgeThenOpen`. Without it the link keeps
 * its plain, untouched `<a href>` behaviour, which is what every kind other
 * than `session-failed` still wants: none of them has an acknowledgement to
 * record, and the server ignores an ack recorded against them anyway
 * (`decorateAcknowledgement` returns early for every other kind).
 */
function OpenSessionLink({
  href,
  onOpen,
  label = 'Open session',
}: {
  href: string;
  onOpen?: () => Promise<unknown>;
  label?: string;
}) {
  return (
    <a
      className="attention-open-link"
      href={href}
      onClick={(event) => {
        if (!onOpen || !isPlainLeftClick(event)) return;
        event.preventDefault();
        void acknowledgeThenOpen({
          acknowledge: onOpen,
          navigate: () => navigateToAttentionTarget(href),
        });
      }}
    >
      {label}
    </a>
  );
}

function OpenFlowConsoleLink({ href }: { href: string }) {
  return (
    <a className="attention-open-link" href={href}>
      Open flow console
    </a>
  );
}

function OpenModelConnectionsLink({ href }: { href: string }) {
  return (
    <a className="attention-open-link" href={href}>
      Open model connections
    </a>
  );
}

function MutationError({ error }: { error: unknown }) {
  if (error == null) return null;
  return (
    <p className="attention-error" role="alert">
      {error instanceof Error ? error.message : 'Unable to update inbox item.'}
    </p>
  );
}
