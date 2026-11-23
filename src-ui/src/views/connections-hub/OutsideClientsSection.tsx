import {
  type OutsideClientReviewAction,
  useOutsideClientReviewMutation,
  useOutsideClientReviewStatusQuery,
  useOutsideClientsQuery,
} from '@kontourai/station-sdk';
import { Badge } from '@kontourai/ui/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { PageRow } from '../../components/PageRow';
import { PageSectionGroup } from '../../components/PageSection';
import { describeReadFailure, Empty, ErrorState } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { toastStore } from '../../contexts/ToastContext';
import { copyToClipboard } from '../../lib/clipboard';
import { openExternalLink } from '../../platform/openExternalLink';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import {
  OutsideClientScopeReview,
  type OutsideClientScopeTarget,
} from './OutsideClientScopeReview';
import './OutsideClientsSection.css';

type DirectReviewTarget = Extract<
  OutsideClientReviewAction,
  { operation: 'deny' | 'revoke' }
>;
type ReviewTarget = OutsideClientScopeTarget | DirectReviewTarget;
const reviewTitles = {
  approve: 'Approve request',
  change: 'Change access',
  deny: 'Deny request',
  revoke: 'Revoke access',
};

const decisionMessages = {
  pending: 'Waiting for a passkey decision.',
  approved: 'Decision approved.',
  denied: 'Review canceled or declined.',
  expired: 'Review expired. Go back to start a new one.',
  target_changed: 'Access changed. Go back to review the current details.',
  session_ended: 'The operator session ended.',
};

export function OutsideClientsSection() {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return null;
  return (
    <ScopedOutsideClients
      key={JSON.stringify([scope.apiBase, scope.authorityKey])}
      scope={scope}
    />
  );
}

function ScopedOutsideClients({
  scope,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const { isTauri } = usePlatformProfile();
  const clients = useOutsideClientsQuery(scope);
  const review = useOutsideClientReviewMutation(scope);
  const decision = useOutsideClientReviewStatusQuery(scope, review.data?.id);
  const decisionStatus = decision.data?.status;
  const settled = decisionStatus !== undefined && decisionStatus !== 'pending';
  const refreshInventory = clients.refetch;
  const decisionResult = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (settled) void refreshInventory();
  }, [settled, refreshInventory]);
  useLayoutEffect(() => {
    if (settled) decisionResult.current?.focus();
  }, [settled]);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{
    name: string;
    target: ReviewTarget;
  }>();
  const scopeFormId = useId();
  const selectionOpener = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const inventoryDone = useRef<HTMLButtonElement>(null);
  const scopeForm = useRef<HTMLFormElement>(null);
  const continueReview = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (selection) {
      (
        scopeForm.current?.querySelector('select') ?? continueReview.current
      )?.focus();
    } else if (open && selectionOpener.current) {
      const control = selectionOpener.current;
      (control.isConnected ? control : inventoryDone.current)?.focus();
      selectionOpener.current = null;
    }
  }, [selection, open]);

  const observed = clients.data;
  if (clients.isError) {
    return (
      <section
        className="outside-clients page-frame__body-inset"
        aria-label="MCP access"
      >
        <ErrorState
          variant="compact"
          title="MCP access unavailable"
          description={describeReadFailure(clients.error)}
          action={<Button onClick={() => void clients.refetch()}>Retry</Button>}
        />
      </section>
    );
  }
  if (!observed || observed.state === 'unavailable') return null;
  if (observed.state === 'operator-required') {
    const signInUrl = isTauri ? undefined : observed.signInUrl;
    return (
      <section
        className="outside-clients page-frame__body-inset"
        aria-label="MCP access"
      >
        <PageRow
          title="MCP access"
          description={
            signInUrl
              ? 'Sign in as the Station operator to review access.'
              : isTauri
                ? 'Open Tools in a paired browser to manage MCP access.'
                : 'Manage MCP access from the Station host.'
          }
          control={
            signInUrl ? (
              <ActionRow
                overflowLabel="More operator actions"
                secondary={
                  <Button onClick={() => void clients.refetch()}>
                    Check sign-in
                  </Button>
                }
                primary={
                  <Button
                    onClick={() =>
                      scope.isCurrent() && void openExternalLink(signInUrl)
                    }
                  >
                    Sign in as operator
                  </Button>
                }
              />
            ) : undefined
          }
        />
      </section>
    );
  }

  const { resource, pending, grants, olderGrantsOmitted } = observed.data;
  const close = () => {
    setOpen(false);
    setSelection(undefined);
    selectionOpener.current = null;
    review.reset();
  };
  const requestReview = (action: OutsideClientReviewAction) => {
    if (!review.isPending && scope.isCurrent()) review.mutate(action);
  };
  const selectReview = (
    target: ReviewTarget,
    name: string,
    button: HTMLButtonElement,
  ) => {
    if (review.isPending) return;
    review.reset();
    selectionOpener.current = button;
    setSelection({ target, name: name || 'Unnamed client' });
  };
  const cancelSelection = () => {
    setSelection(undefined);
    review.reset();
  };
  const reviewFailure = review.isError && (
    <ErrorState
      variant="compact"
      title="Could not prepare the review"
      description={describeReadFailure(review.error)}
    />
  );
  const reviewButton = review.data && !settled && (
    <Button
      variant="primary"
      onClick={() => {
        if (scope.isCurrent() && review.data)
          void openExternalLink(review.data.reviewUrl);
      }}
    >
      Review with passkey
    </Button>
  );
  const target = selection?.target;
  const scopeTarget =
    target?.operation === 'approve' || target?.operation === 'change'
      ? target
      : undefined;
  const directTarget =
    target?.operation === 'deny' || target?.operation === 'revoke'
      ? target
      : undefined;

  const decisionMessage =
    decisionStatus === 'approved' && target?.operation === 'approve'
      ? 'Approved. The client can finish signing in.'
      : decisionStatus
        ? decisionMessages[decisionStatus]
        : 'Confirm this decision with your operator passkey.';

  const activeGrants = grants.filter((grant) => grant.state === 'active');
  const endedGrants = grants.filter((grant) => grant.state !== 'active');
  const renderGrant = (grant: (typeof grants)[number]) => {
    const identity = {
      grantId: grant.grantId,
      expectedVersion: grant.version,
      expectedDigest: grant.digest,
    };
    const projectId =
      grant.projectScope.kind === 'project'
        ? grant.projectScope.projectId
        : undefined;
    const access =
      grant.accessLevel === 'read-only' ? 'Read-only' : 'Full access';
    return (
      <OutsideClientRow
        key={grant.grantId}
        client={grant}
        status={grant.state}
        description={`${access} · ${projectId ?? 'Work outside Projects'}`}
        actions={
          grant.state === 'active'
            ? [
                {
                  operation: 'change',
                  ...identity,
                  currentProjectId: projectId ?? 'global',
                  currentExpiry: grant.expiresAt,
                },
                { operation: 'revoke', ...identity },
              ]
            : undefined
        }
        selectReview={selectReview}
      />
    );
  };

  return (
    <section
      className="outside-clients page-frame__body-inset"
      aria-label="MCP access"
    >
      <PageRow
        title="MCP access"
        control={
          <Button
            ref={opener}
            onClick={() => {
              setOpen(true);
              void clients.refetch();
            }}
          >
            Review access
          </Button>
        }
      />
      {open && (
        <Dialog
          title={target ? reviewTitles[target.operation] : 'MCP access'}
          subtitle={
            selection?.name ?? 'Names are reported by the connecting app.'
          }
          closeLabel="Close MCP access"
          onClose={close}
          returnFocusTarget={opener.current}
          footer={
            <>
              {selection ? (
                <Button onClick={cancelSelection}>Back</Button>
              ) : (
                <Button ref={inventoryDone} onClick={close}>
                  Done
                </Button>
              )}
              {reviewButton ||
                (!settled && selection && (
                  <Button
                    ref={continueReview}
                    variant="primary"
                    type={scopeTarget ? 'submit' : 'button'}
                    form={scopeTarget ? scopeFormId : undefined}
                    onClick={
                      directTarget
                        ? () => requestReview(directTarget)
                        : undefined
                    }
                    aria-disabled={review.isPending}
                  >
                    {review.isPending ? 'Preparing review…' : 'Continue'}
                  </Button>
                ))}
            </>
          }
        >
          {reviewFailure}
          {selection &&
            (review.data ? (
              <div className="content-stack">
                {decision.isError && (
                  <ErrorState
                    variant="compact"
                    title="Could not check the decision"
                    description={describeReadFailure(decision.error)}
                  />
                )}
                <PageRow
                  title={
                    <span
                      ref={decisionResult}
                      role="status"
                      tabIndex={settled ? -1 : undefined}
                    >
                      {decisionMessage}
                    </span>
                  }
                  control={
                    !settled && (
                      <Button
                        aria-disabled={decision.isFetching}
                        onClick={() => {
                          if (!decision.isFetching) void decision.refetch();
                        }}
                      >
                        Check decision
                      </Button>
                    )
                  }
                />
              </div>
            ) : scopeTarget ? (
              <OutsideClientScopeReview
                formId={scopeFormId}
                target={scopeTarget}
                scopeForm={scopeForm}
                onSubmit={requestReview}
              />
            ) : (
              <p>Confirm this decision with your operator passkey.</p>
            ))}
          <div hidden={Boolean(selection)}>
            <div className="content-stack content-stack--sections outside-clients__inventory">
              <section aria-label="MCP URL">
                <PageRow
                  title="MCP URL"
                  description={<code>{resource}</code>}
                  control={
                    <Button
                      onClick={async () => {
                        if (!scope.isCurrent()) return;
                        toastStore.show(
                          (await copyToClipboard(resource))
                            ? 'MCP URL copied.'
                            : 'Could not copy the MCP URL.',
                        );
                      }}
                    >
                      Copy URL
                    </Button>
                  }
                />
              </section>
              <PageSectionGroup title="Pending requests">
                {pending.length === 0 ? (
                  <Empty variant="compact" label="No pending requests" />
                ) : (
                  <div className="content-stack content-stack--sections">
                    {pending.map((request) => {
                      const {
                        requestId,
                        clientId,
                        expectedRequestFingerprint,
                      } = request;
                      const identity = {
                        requestId,
                        clientId,
                        expectedRequestFingerprint,
                      };
                      return (
                        <OutsideClientRow
                          key={requestId}
                          client={request}
                          status={request.state.replaceAll('_', ' ')}
                          actions={
                            request.state === 'pending'
                              ? [
                                  { operation: 'approve', ...identity },
                                  { operation: 'deny', ...identity },
                                ]
                              : undefined
                          }
                          selectReview={selectReview}
                        />
                      );
                    })}
                  </div>
                )}
              </PageSectionGroup>
              <PageSectionGroup title="Authorized clients">
                {activeGrants.length === 0 ? (
                  <Empty variant="compact" label="No authorized clients" />
                ) : (
                  <div className="content-stack content-stack--sections">
                    {activeGrants.map(renderGrant)}
                  </div>
                )}
              </PageSectionGroup>
              {endedGrants.length > 0 && (
                <PageSectionGroup
                  title="Access history"
                  description={
                    olderGrantsOmitted
                      ? 'Showing 50 ended grants by approval date.'
                      : undefined
                  }
                >
                  <div className="content-stack content-stack--sections">
                    {endedGrants.map(renderGrant)}
                  </div>
                </PageSectionGroup>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

const dates = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type OutsideClientIdentity = {
  clientName: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  approvedAt?: number;
  lastUsedAt?: number | null;
};

const reviewLabels = {
  approve: 'Approve…',
  change: 'Change access…',
  deny: 'Deny…',
  revoke: 'Revoke…',
};

function OutsideClientRow({
  client,
  status,
  description,
  actions,
  selectReview,
}: {
  client: OutsideClientIdentity;
  status: string;
  description?: string;
  actions?: readonly [OutsideClientScopeTarget, DirectReviewTarget];
  selectReview: (
    target: ReviewTarget,
    name: string,
    button: HTMLButtonElement,
  ) => void;
}) {
  const name = client.clientName || 'Unnamed client';
  const reviewAction = (target: ReviewTarget) => (
    <Button
      variant={target.operation === 'approve' ? 'primary' : undefined}
      onClick={(event) => selectReview(target, name, event.currentTarget)}
    >
      {reviewLabels[target.operation]}
    </Button>
  );
  return (
    <section className="content-stack">
      <div>
        <PageRow
          title={name}
          description={description}
          statusPlacement="label"
          status={
            <Badge
              value={status}
              tone={status === 'active' ? 'positive' : 'neutral'}
            />
          }
          control={
            actions && (
              <ActionRow
                overflowLabel="More client actions"
                primary={reviewAction(actions[0])}
                secondary={reviewAction(actions[1])}
              />
            )
          }
        />
      </div>
      <ClientDetails client={client} />
    </section>
  );
}

function ClientDetails({ client }: { client: OutsideClientIdentity }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <DisclosureToggle
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={id}
      >
        Details
      </DisclosureToggle>
      <dl id={id} hidden={!expanded} className="outside-clients__details">
        <dt>Client ID</dt>
        <dd>
          <code>{client.clientId}</code>
        </dd>
        <dt>Redirect URI</dt>
        <dd>{client.redirectUri}</dd>
        {client.approvedAt !== undefined && (
          <>
            <dt>Approved</dt>
            <dd>{dates.format(client.approvedAt)}</dd>
          </>
        )}
        <dt>Expires</dt>
        <dd>{dates.format(client.expiresAt)}</dd>
        {client.lastUsedAt !== undefined && (
          <>
            <dt>Last used</dt>
            <dd>
              {client.lastUsedAt === null
                ? 'Never'
                : dates.format(client.lastUsedAt)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
