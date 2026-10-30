import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { openApprovalConversation } from '../../lib/openApprovalConversation';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';
import { describeReadFailure, ErrorState, SkeletonBlock } from '../state';
import { useExactRequestDecision } from './RequestInspectionDialog';
import './ExactRequestInline.css';

type CapturedAuthority = NonNullable<
  ReturnType<typeof useHostRequestAuthorityScope>
>;

/**
 * An approval answered from the inbox row itself: Deny / Approve once on the
 * row, the full request one "Details" away, inline.
 *
 * It answers through `useExactRequestDecision`, the SAME guarded path the
 * inspection dialog uses — never the generic notification action — so a
 * decision from the tray is still bound to the exact request version this
 * row read, sent at most once, and refused while an earlier attempt is
 * unconfirmed. Every state that is not "open and answerable here" says why,
 * on this row, with the way forward.
 */
export function ExactRequestInline({
  reference,
  openHref,
  onOpen,
  quiet,
  open,
}: {
  reference: AttentionRequestReference;
  openHref?: string;
  /** Runs before following `openHref` (the tray closes itself). */
  onOpen?: () => void;
  /** The row's quiet controls (snooze, dismiss), at the bar's left edge. */
  quiet?: ReactNode;
  /** The row's way out (open the chat), just before the decision. */
  open?: ReactNode;
}) {
  const authority = useHostRequestAuthorityScope();
  if (!authority?.isCurrent())
    return (
      <div className="exact-request">
        <p className="exact-request__note" role="status">
          Reconnect to this Station to answer this request.
        </p>
        <div className="exact-request__bar">
          {quiet}
          <div className="exact-request__actions">{open}</div>
        </div>
      </div>
    );
  // A new authority is a new inspection: remount rather than carry a read or
  // an attempt across it.
  return (
    <ExactRequestDecisionRow
      // A new authority or a new exact request is a new inspection: remount
      // rather than carry a read or an attempt latch across it.
      key={`${authority.authorityKey}|${reference.threadId}|${reference.requestId}|${reference.requestEventId}`}
      authority={authority}
      reference={reference}
      openHref={openHref}
      onOpen={onOpen}
      quiet={quiet}
      open={open}
    />
  );
}

function ExactRequestDecisionRow({
  authority,
  reference,
  openHref,
  onOpen,
  quiet,
  open,
}: {
  authority: CapturedAuthority;
  reference: AttentionRequestReference;
  openHref?: string;
  onOpen?: () => void;
  quiet?: ReactNode;
  open?: ReactNode;
}) {
  const decision = useExactRequestDecision(reference, authority);
  // An accepted decision opens its conversation, as every approval action in
  // the inbox does; a row without one stays and says the decision was sent.
  const sent = decision.response.isSuccess;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per success
  useEffect(() => {
    if (!sent || !openHref) return;
    onOpen?.();
    openApprovalConversation(openHref);
  }, [sent]);
  const { query, response, result } = decision;
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const openLink = openHref ? (
    <a className="exact-request__link" href={openHref} onClick={onOpen}>
      Open chat
    </a>
  ) : null;

  let note: ReactNode = null;
  let failure: ReactNode = null;
  if (query.isError) {
    failure = (
      <ErrorState
        variant="compact"
        title="Couldn't load this request"
        description={describeReadFailure(query.error)}
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      />
    );
  } else if (response.isSuccess) {
    note = <>Decision sent. {openLink}</>;
  } else if (response.isError) {
    failure = (
      <ErrorState
        variant="compact"
        title="Couldn't confirm the decision"
        description={`${userFacingErrorMessage(response.error)} It may have gone through; check the chat first.`}
        action={
          <>
            <Button
              size="sm"
              disabled={decision.checking}
              onClick={decision.recheck}
            >
              Check again
            </Button>
            {openLink}
          </>
        }
      />
    );
  } else if (result && result.state !== 'open') {
    note = (
      <>
        {result.message} {openLink}
      </>
    );
  } else if (result?.state === 'open') {
    if (result.requiresAnswers)
      note = <>Answer the agent's questions in the chat. {openLink}</>;
    else if (!result.canRespond)
      note = <>This chat can't answer the request right now. {openLink}</>;
    else if (decision.capacityReached)
      note = (
        <>
          Too many decisions are still unconfirmed. Check them in their chats
          first. {openLink}
        </>
      );
    else if (decision.attempted)
      note = (
        <>A decision was already sent. Confirm it in the chat. {openLink}</>
      );
  }

  const loading = query.isLoading;
  return (
    <div className="exact-request" data-testid="exact-request-inline">
      {expanded && (
        <div id={detailsId} className="exact-request__details">
          {result?.state === 'open' ? (
            <>
              {result.body ? (
                <p className="exact-request__body">{result.body}</p>
              ) : null}
              <p className="exact-request__meta">
                Asked by{' '}
                {engineDisplayLabel(result.provider) ?? result.provider} ·{' '}
                {new Date(result.openedAt).toLocaleString([], {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            </>
          ) : loading ? (
            <SkeletonBlock label="Loading request" />
          ) : (
            <p className="exact-request__body">
              No request details are available.
            </p>
          )}
        </div>
      )}
      {failure}
      {note ? (
        <p className="exact-request__note" role="status">
          {note}
        </p>
      ) : null}
      <div className="exact-request__bar">
        {quiet}
        <button
          type="button"
          className="exact-request__toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide details' : 'Details'}
        </button>
        <div className="exact-request__actions">
          {open}
          <Button
            size="sm"
            variant="secondary"
            disabled={!decision.canDecide}
            aria-busy={loading || response.isPending}
            onClick={() => decision.decide('decline')}
          >
            Deny
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!decision.canDecide}
            aria-busy={loading || response.isPending}
            onClick={() => decision.decide('accept')}
          >
            Approve once
          </Button>
        </div>
      </div>
    </div>
  );
}
