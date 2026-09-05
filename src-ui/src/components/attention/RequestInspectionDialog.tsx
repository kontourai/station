import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
import {
  useAttentionRequestInspection,
  useQueryClient,
} from '@kontourai/station-sdk';
import { respondToRequest } from '@kontourai/station-sdk/client';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import { describeReadFailure, ErrorState, SkeletonList } from '../state';
import './RequestInspectionDialog.css';

type CapturedAuthority = NonNullable<
  ReturnType<typeof useHostRequestAuthorityScope>
>;

export function RequestInspectionDialog({
  reference,
  authority,
  openHref,
  onClose,
}: {
  reference: AttentionRequestReference;
  authority: CapturedAuthority;
  openHref?: string;
  onClose: () => void;
}) {
  const current = authority.isCurrent();
  const query = useAttentionRequestInspection(reference, authority, current);
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);
  const response = useMutation({
    mutationFn: async (decision: 'accept' | 'decline') => {
      if (!authority.isCurrent())
        throw new Error(
          'Station authorization changed. Close and inspect the request again.',
        );
      return respondToRequest(
        authority.apiBase,
        {
          threadId: reference.threadId,
          requestId: reference.requestId,
          expectedRequestEventId: reference.requestEventId,
          decision,
        },
        { requestScope: authority },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
  });
  const decide = (decision: 'accept' | 'decline') => {
    if (
      inFlight.current ||
      response.isError ||
      query.isError ||
      query.isFetching ||
      checking ||
      !current ||
      query.data?.state !== 'open' ||
      !query.data.canRespond
    )
      return;
    inFlight.current = true;
    response.mutate(decision);
  };
  const result = query.data;
  const receipt = response.data?.receipt;
  const receiptId =
    receipt &&
    typeof receipt === 'object' &&
    'commandId' in receipt &&
    typeof receipt.commandId === 'string'
      ? receipt.commandId
      : undefined;
  return (
    <ResponsiveDialogSurface
      ariaLabel="Inspect request"
      onClose={onClose}
      overlayClassName="request-inspection-overlay"
      panelClassName="request-inspection-dialog"
    >
      <ResponsiveDialogHeader
        title="Inspect request"
        closeLabel="Close request inspection"
        onClose={onClose}
      />
      {!current ? (
        <p role="alert">
          Station authorization changed. Close and inspect the request again.
        </p>
      ) : query.isError ? (
        <ErrorState
          variant="compact"
          title="Couldn't inspect this request"
          description={describeReadFailure(query.error)}
          action={
            <Button
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry inspection
            </Button>
          }
        />
      ) : query.isLoading ? (
        <SkeletonList count={3} label="Checking the exact request" />
      ) : response.isSuccess ? (
        <div role="status">
          <p>Decision accepted.</p>
          {receiptId ? (
            <p>
              Receipt: <code>{receiptId}</code>
            </p>
          ) : null}
        </div>
      ) : response.isError ? null : result?.state === 'open' ? (
        <>
          <h3>{result.title}</h3>
          {result.body ? (
            <p className="request-inspection-detail">{result.body}</p>
          ) : null}
          <details>
            <summary>Request identity</summary>
            <dl className="request-inspection-identity">
              <dt>Engine</dt>
              <dd>{result.provider}</dd>
              <dt>Opened event</dt>
              <dd>{reference.requestEventId}</dd>
              <dt>Session</dt>
              <dd>{reference.threadId}</dd>
              <dt>Request</dt>
              <dd>{reference.requestId}</dd>
              <dt>Opened</dt>
              <dd>{result.openedAt}</dd>
            </dl>
          </details>
          {!result.canRespond ? (
            <p role="status">
              This session cannot currently answer the request. Open the session
              for its current status.
            </p>
          ) : (
            <ResponsiveSurfaceActions>
              <Button
                variant="secondary"
                disabled={response.isPending || response.isError}
                onClick={() => decide('decline')}
              >
                Deny
              </Button>
              <Button
                disabled={response.isPending || response.isError}
                onClick={() => decide('accept')}
              >
                Approve once
              </Button>
            </ResponsiveSurfaceActions>
          )}
        </>
      ) : result ? (
        <p role="status">{result.message}</p>
      ) : null}
      {response.isError && current ? (
        <ErrorState
          variant="compact"
          title="Couldn't confirm the decision"
          description={describeReadFailure(response.error)}
          action={
            <Button
              disabled={checking}
              onClick={() => {
                if (checking || !authority.isCurrent()) return;
                setChecking(true);
                void query
                  .refetch()
                  .then((fresh) => {
                    if (
                      authority.isCurrent() &&
                      fresh.isSuccess &&
                      fresh.data
                    ) {
                      response.reset();
                      inFlight.current = false;
                    }
                  })
                  .finally(() => setChecking(false));
              }}
            >
              Check request again
            </Button>
          }
        />
      ) : null}
      <ResponsiveSurfaceActions>
        {openHref ? (
          <a className="request-inspection-session" href={openHref}>
            Open session
          </a>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
