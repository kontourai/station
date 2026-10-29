import './project-access.css';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  getProjectSharingStepUpStatus,
  type ProjectAccessCommand,
  type ProjectSharingStepUp,
  projectAccessRefusal,
  useProjectAccess,
  useProjectSharingEnablement,
} from '@kontourai/station-sdk/project-access';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { AccessPanelView } from './AccessPanelView';
import {
  ENABLE_SHARING_FORBIDDEN,
  projectAccessErrorMessage,
} from './projectAccessErrorText';

const STEP_UP_OUTCOMES = {
  denied: 'Cancelled. Nothing was applied.',
  expired: 'The review expired. Nothing was applied.',
  target_changed: 'This changed since you asked. Nothing was applied.',
  session_ended: 'Your operator session ended. Nothing was applied.',
  unavailable: 'The review status is unavailable. Refresh access to check.',
} as const;

export function AccessSection({
  slug,
  projectId,
  allowEnableSharing = true,
  writeDisabledReason,
}: {
  slug: string;
  projectId: string;
  allowEnableSharing?: boolean;
  writeDisabledReason?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  return (
    <AccessPanel
      key={`${slug}:${authority?.apiBase}:${authority?.authorityKey}`}
      slug={slug}
      projectId={projectId}
      authority={authority}
      allowEnableSharing={allowEnableSharing}
      writeDisabledReason={writeDisabledReason}
    />
  );
}

/** The section frame for every state that has no administration view to show. */
function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <PageSection
      id="section-access"
      title="People and access"
      description="Who can participate in this Project."
    >
      {children}
    </PageSection>
  );
}

function AccessPanel({
  slug,
  projectId,
  authority,
  allowEnableSharing,
  writeDisabledReason,
}: {
  slug: string;
  projectId: string;
  authority?: ApiRequestScope;
  allowEnableSharing: boolean;
  writeDisabledReason?: string;
}) {
  const { query, mutation, change } = useProjectAccess(slug, authority);
  const busy = mutation.isPending || query.isFetching;
  const [enableError, setEnableError] = useState<string>();
  const [review, setReview] = useState<ProjectSharingStepUp>();
  const refused =
    allowEnableSharing &&
    query.error instanceof StationHttpError &&
    query.error.status === 403;
  // #4306: how this caller may turn on sharing. An older host has no such
  // read; the failed query keeps the previous behavior (offer Enable).
  const enablement = useProjectSharingEnablement(slug, authority, refused);
  const ability =
    enablement.isError &&
    enablement.error instanceof StationHttpError &&
    enablement.error.status === 404
      ? 'direct'
      : enablement.data?.enable;
  const reviewStatus = useQuery({
    queryKey: ['project-sharing-step-up', authority?.apiBase, review?.id],
    queryFn: () =>
      getProjectSharingStepUpStatus(authority!.apiBase, review!.id, {
        requestScope: authority,
      }),
    enabled: !!authority && !!review,
    gcTime: 0,
    retry: false,
    refetchInterval: 2000,
  });
  const reviewOutcome = reviewStatus.isError
    ? 'unavailable'
    : reviewStatus.data;
  useEffect(() => {
    if (!reviewOutcome || reviewOutcome === 'pending') return;
    setReview(undefined);
    if (reviewOutcome === 'approved') void query.refetch();
    else setEnableError(STEP_UP_OUTCOMES[reviewOutcome]);
  }, [reviewOutcome, query.refetch]);

  async function enable() {
    setEnableError(undefined);
    // Open during the click, before the request yields user activation.
    const reviewWindow =
      ability === 'operator-passkey'
        ? window.open('about:blank', '_blank')
        : null;
    try {
      const result = await change({
        kind: 'enable',
        localProjectId: projectId,
      });
      if (result.kind !== 'step-up-required') return void reviewWindow?.close();
      reviewWindow?.location.replace(result.transaction.reviewUrl);
      setReview(result.transaction);
    } catch (cause) {
      reviewWindow?.close();
      setEnableError(
        projectAccessErrorMessage(cause, ENABLE_SHARING_FORBIDDEN),
      );
    }
  }

  async function apply(command: ProjectAccessCommand) {
    return change(command);
  }

  if (!authority) {
    return <p>Connect to this Station to manage access.</p>;
  }
  if (query.isPending) {
    return <SkeletonList count={2} />;
  }
  if (query.isError) {
    const error = query.error;
    const refusal = projectAccessRefusal(error);
    const enableButton = (
      <Button
        variant="primary"
        pending={mutation.isPending || !!review}
        onClick={() => void enable()}
      >
        Enable Project sharing
      </Button>
    );
    const enableAlert = enableError && (
      <p role="alert" className="project-access__error">
        {enableError}
      </p>
    );
    if (error instanceof StationHttpError && error.status === 501)
      return (
        <AccessFrame>
          <Empty label="Project sharing is not enabled on this Station." />
        </AccessFrame>
      );
    if (refusal?.sharing === 'off')
      return (
        <AccessFrame>
          <Empty
            label="Sharing is off"
            description={
              allowEnableSharing
                ? 'Turn on sharing to invite people with a link. You become the Project owner.'
                : 'Sharing can be turned on from this Project’s settings.'
            }
            action={
              allowEnableSharing &&
              (ability === 'direct' || ability === 'operator-passkey')
                ? enableButton
                : undefined
            }
          />
          {enablement.data?.enable === 'operator-sign-in' && (
            <p>
              <a
                href={enablement.data.signInUrl}
                target="_blank"
                rel="noreferrer"
              >
                Sign in as operator
              </a>{' '}
              to enable sharing.
            </p>
          )}
          {review && (
            <p role="status">
              Waiting for your passkey.{' '}
              <a href={review.reviewUrl} target="_blank" rel="noreferrer">
                Review sharing change
              </a>
            </p>
          )}
          {enableAlert}
        </AccessFrame>
      );
    if (refusal)
      return (
        <AccessFrame>
          <Empty
            label="You can’t manage people for this Project from here"
            description={
              refusal.sharing === 'on'
                ? 'This Project is shared. Its owner or an admin manages who can access it.'
                : 'A Project owner or admin manages access. Turning sharing on needs Station owner authority.'
            }
          />
          {refusal.sharing === 'undisclosed' &&
            enablement.data?.enable === 'operator-sign-in' && (
              <p>
                <a
                  href={enablement.data.signInUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Sign in as operator
                </a>{' '}
                to enable sharing.
              </p>
            )}
        </AccessFrame>
      );
    if (
      error instanceof StationHttpError &&
      error.status === 403 &&
      error.code === 'project_access_forbidden'
    )
      // An older Station refuses without saying why, so the button stays
      // for the owner who can use it, and a refusal is explained in words.
      return (
        <AccessFrame>
          <Empty
            label="Sharing may be off"
            description="This Station didn’t say whether you can turn on sharing here."
            action={
              allowEnableSharing &&
              (ability === 'direct' || ability === 'operator-passkey')
                ? enableButton
                : undefined
            }
          />
          {enablement.data?.enable === 'operator-sign-in' && (
            <p>
              <a
                href={enablement.data.signInUrl}
                target="_blank"
                rel="noreferrer"
              >
                Sign in as operator
              </a>{' '}
              to enable sharing.
            </p>
          )}
          {review && (
            <p role="status">
              Waiting for your passkey.{' '}
              <a href={review.reviewUrl} target="_blank" rel="noreferrer">
                Review sharing change
              </a>
            </p>
          )}
          <Button disabled={busy} onClick={() => void query.refetch()}>
            Refresh access
          </Button>
          {enableAlert}
        </AccessFrame>
      );
    return (
      <AccessFrame>
        <ErrorState
          variant="compact"
          title="Project access is unavailable"
          description={projectAccessErrorMessage(error)}
          action={
            <Button disabled={busy} onClick={() => void query.refetch()}>
              Refresh access
            </Button>
          }
        />
      </AccessFrame>
    );
  }
  if (!query.data) return null;
  return (
    <AccessPanelView
      view={query.data}
      busy={busy}
      apply={apply}
      writeDisabledReason={writeDisabledReason}
    />
  );
}
