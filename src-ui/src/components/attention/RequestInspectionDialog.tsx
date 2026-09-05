import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
import {
  useAttentionRequestInspection,
  useQueryClient,
} from '@kontourai/station-sdk';
import { respondToRequest } from '@kontourai/station-sdk/client';
import { useMutation, useMutationState } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
  const mutationKey = [
    'attention-request-response',
    authority.apiBase,
    authority.authorityKey,
    reference.threadId,
    reference.requestId,
    reference.requestEventId,
  ] as const;
  const attempts = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => mutation.state.status,
  });
  const uncertain = useMutationState({
    filters: { mutationKey: mutationKey.slice(0, 3) },
    select: (mutation) => mutation.state.status === 'error',
  });
  const capacityReached = uncertain.filter(Boolean).length >= 64;
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    for (const mutation of cache.findAll({
      mutationKey: ['attention-request-response'],
    })) {
      const isCurrent = mutation.meta?.isAuthorityCurrent;
      if (typeof isCurrent === 'function' && !isCurrent())
        cache.remove(mutation);
    }
    return () => {
      if (!authority.isCurrent()) {
        for (const mutation of cache.findAll({
          mutationKey: [
            'attention-request-response',
            authority.apiBase,
            authority.authorityKey,
          ],
        }))
          cache.remove(mutation);
      }
    };
  }, [queryClient, authority]);
  useEffect(() => {
    if (query.data?.state !== 'resolved' && query.data?.state !== 'changed')
      return;
    const cache = queryClient.getMutationCache();
    for (const mutation of cache.findAll({
      mutationKey: [
        'attention-request-response',
        authority.apiBase,
        authority.authorityKey,
        reference.threadId,
        reference.requestId,
        reference.requestEventId,
      ],
      exact: true,
    })) {
      if (mutation.state.status === 'error') cache.remove(mutation);
    }
  }, [query.data, queryClient, authority, reference]);
  const attempted = attempts.some((status) => status !== 'idle');
  const response = useMutation({
    mutationKey,
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
    onError: () => {
      for (const mutation of queryClient
        .getMutationCache()
        .findAll({ mutationKey, exact: true })) {
        // Preserve only uncertain attempt identity, not this dialog's callbacks.
        mutation.setOptions({
          mutationKey,
          gcTime: Infinity,
          meta: { isAuthorityCurrent: authority.isCurrent },
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
  });
  const decide = (decision: 'accept' | 'decline') => {
    if (
      inFlight.current ||
      attempted ||
      capacityReached ||
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: mutationKey.slice(0, 3) })
        .filter(
          (mutation) =>
            mutation.state.status === 'error' ||
            mutation.state.status === 'pending',
        ).length >= 64 ||
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
      <div className="request-inspection-body">
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
                This session cannot currently answer the request. Open the
                session for its current status.
              </p>
            ) : capacityReached ? (
              <p role="status">
                This Station has too many unconfirmed decisions. Open the
                session to confirm their outcomes before sending another
                decision here.
              </p>
            ) : attempted ? (
              <p role="status">
                A decision was already attempted for this request. Open the
                session to confirm its outcome; this inspector will not send it
                again.
              </p>
            ) : (
              <ResponsiveSurfaceActions className="request-inspection-actions">
                <Button
                  variant="secondary"
                  disabled={response.isPending || response.isError}
                  onClick={() => decide('decline')}
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
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
                        if (
                          fresh.data.state === 'resolved' ||
                          fresh.data.state === 'changed'
                        ) {
                          for (const mutation of queryClient
                            .getMutationCache()
                            .findAll({ mutationKey, exact: true }))
                            queryClient.getMutationCache().remove(mutation);
                        }
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
      </div>
      <ResponsiveSurfaceActions className="request-inspection-actions">
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
