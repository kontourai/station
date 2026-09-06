import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
import type {
  ApprovalAttentionItem,
  AttentionItem,
  DevicePairingAttentionItem,
  GateBlockedAttentionItem,
  GateExceptionAttentionItem,
  GateRouteBackAttentionItem,
  NeedsInputAttentionItem,
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
} from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import {
  attentionKindLabel,
  isAcknowledgeableAttentionItem,
  isApprovalLivePending,
  sessionFailedIdentity,
  sessionFailureCause,
} from '../../utils/attention';
import {
  acknowledgeThenOpen,
  isPlainLeftClick,
  navigateToAttentionTarget,
} from '../../utils/attentionOpen';
import { formatNotificationTime } from '../../utils/notifications';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonList } from '../state';
import './AttentionCard.css';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from './notificationRowActions';

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
      <AttentionAction item={item} />
      {/* #1536 D8: a standing notice is not dismissible — acknowledging the
          only row that says why chat cannot start would leave the inbox
          claiming nothing needs you while it still does. One predicate, shared
          with "Dismiss all" and with the server's own refusal. */}
      {item.kind !== 'approval' && isAcknowledgeableAttentionItem(item) && (
        <DismissAttentionItem item={item} />
      )}
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

function AttentionAction({ item }: { item: AttentionItem }) {
  switch (item.kind) {
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
      <button
        type="button"
        className="attention-item__action attention-item__action--primary"
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
      </button>
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
  // #765 D5 live verification: `access:approve` is operator-promotion-only,
  // so a paired browser session can read this item but the pairing routes
  // answer its approve/deny with 401 `authentication_required` — the buttons
  // were structurally dead there. `viewerCanDecide` is the server's own
  // boundary predicate evaluated for THIS session; when it says no, render
  // the remedy the panel prints for the same refusal instead of dead buttons.
  if (!item.viewerCanDecide) {
    return (
      <>
        <div
          className="attention-item__detail"
          data-testid="attention-pairing-remedy"
        >
          {pairingApprovalRemedy(item)}
        </div>
        <OpenConnectionsLink href={item.openHref} />
      </>
    );
  }
  return (
    <>
      <div className="attention-item__actions">
        <button
          type="button"
          className="attention-item__action attention-item__action--primary"
          disabled={busy}
          onClick={() => confirmMutation.mutate(item.source.requestId)}
        >
          Approve
        </button>
        <button
          type="button"
          className="attention-item__action attention-item__action--danger"
          disabled={busy}
          onClick={() => denyMutation.mutate(item.source.requestId)}
        >
          Deny
        </button>
      </div>
      <OpenConnectionsLink href={item.openHref} />
      <MutationError
        error={describePairingActionError(
          confirmMutation.error,
          item,
          'approve',
        )}
      />
      <MutationError
        error={describePairingActionError(denyMutation.error, item, 'deny')}
      />
    </>
  );
}

/**
 * The remedy for a session that cannot decide: the SAME sentence the panel
 * and the 403 error path print, because it is the same fact arriving earlier
 * — before a doomed request instead of after one.
 */
function pairingApprovalRemedy(item: DevicePairingAttentionItem): string {
  return `Approving “${item.deviceName}” needs a trusted Station session. Run this on the Station: station environment access approve ${item.source.requestId} --force`;
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
): unknown {
  if (error == null) return null;
  if (!(error instanceof DevicePairingRequestActionError)) return error;
  if (error.status === 401) {
    return new Error(
      "This device's access to this Station needs review. Reconnect it, then try again.",
    );
  }
  if (error.status === 403 && action === 'approve') {
    return new Error(pairingApprovalRemedy(item));
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
      <div className="attention-item__actions">
        {item.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`attention-item__action attention-item__action--${action.variant ?? 'secondary'}`}
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                actionId: action.id,
                id: item.source.notificationId,
              })
            }
          >
            {action.label}
          </button>
        ))}
        {/*
         * Non-actionable/terminal (no live actions, or no resolvable
         * session to view the decision in): dismiss sits at full
         * prominence right alongside whatever actions do exist — there is
         * nothing else useful left to do with this item.
         */}
        {!livePending && (
          <button
            type="button"
            className="attention-item__action attention-item__action--ghost"
            disabled={dismissMutation.isPending}
            onClick={dismiss}
          >
            {DISMISS_NOTIFICATION_ACTION.label}
          </button>
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

function NeedsInputAction({ item }: { item: NeedsInputAttentionItem }) {
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
        <button
          type="submit"
          className="attention-item__action attention-item__action--primary"
          disabled={!answer.trim() || mutation.isPending}
        >
          Send answer
        </button>
      </form>
      <OpenSessionLink href={item.openHref} />
      <MutationError error={mutation.error} />
    </>
  );
}

/**
 * The only affordance for `review_pending`: go look at the session. There is
 * nothing to decide here — the decision lives in the session itself.
 */
function OpenSessionAction({ item }: { item: ReviewPendingAttentionItem }) {
  return (
    <a
      className="attention-item__action attention-item__action--secondary"
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
    <div className="attention-item__actions">
      <button
        type="button"
        className="attention-item__action attention-item__action--ghost"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(item.id)}
      >
        {ACKNOWLEDGE_ATTENTION_ACTION.label}
      </button>
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
      <div className="attention-item__actions">
        <button
          type="button"
          className="attention-item__action attention-item__action--secondary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Re-evaluate
        </button>
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
      <div className="attention-item__actions">
        <button
          type="button"
          className="attention-item__action attention-item__action--primary"
          onClick={() => setIsOpen(true)}
        >
          Accept exception…
        </button>
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
  const titleId = useId();
  const reasonId = useId();
  const authorityId = useId();
  const canSubmit = reason.trim().length > 0 && authority.trim().length > 0;
  return (
    // Backdrop dismiss, same idiom as ResponsiveDialogSurface's overlay:
    // role="presentation" + onPointerDown with a target check (not a
    // stopPropagation handler on the panel below) so only an actual press on
    // the backdrop itself closes the dialog. The Cancel button below is the
    // keyboard path (no Escape binding here), so this stays a mouse-only
    // convenience rather than a second, unlabelled keyboard path.
    <div
      className="modal-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <h3 id={titleId}>Accept exception</h3>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit({ reason, authority });
          }}
        >
          <div className="modal-body attention-exception-fields">
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
          <div className="modal-footer">
            <button
              type="button"
              className="attention-item__action attention-item__action--secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="attention-item__action attention-item__action--primary"
              disabled={!canSubmit || isPending}
            >
              Accept exception
            </button>
          </div>
        </form>
      </div>
    </div>
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
}: {
  href: string;
  onOpen?: () => Promise<unknown>;
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
      Open session
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

function OpenConnectionsLink({ href }: { href: string }) {
  return (
    <a className="attention-open-link" href={href}>
      Open connections
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
