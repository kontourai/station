import type { LearningReviewSourceSelection } from '@kontourai/station-contracts/learning-review';
import { isLearningAccessRefusal } from '@kontourai/station-sdk/client/learning-review';
import {
  type LearningReviewRequestScope,
  usePrepareLearningSourceQuery,
} from '@kontourai/station-sdk/learning-review-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectQuery } from '../../contexts/ProjectsContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { errorText } from '../../utils/errorText';
import {
  type LearningReviewProposalContext,
  LearningReviewProposalDialog,
} from './LearningReviewPanel';

export function LearningRecordReviewButton({
  slug,
  projectId,
  selection,
  authority,
}: {
  slug: string;
  projectId: string;
  selection: LearningReviewSourceSelection;
  authority: LearningReviewRequestScope;
}) {
  const flags = useSurfaceVisibilityFlags();
  const enabled = flags.has('learning-lifecycle-review');
  const prepared = usePrepareLearningSourceQuery(
    slug,
    projectId,
    selection,
    authority,
    false,
  );
  const [source, setSource] = useState<LearningReviewProposalContext>();
  const [notice, setNotice] = useState('');
  const refused =
    (source !== undefined && isLearningAccessRefusal(prepared.error)) ||
    (!prepared.isFetching && prepared.data?.state === 'restricted');
  useEffect(() => {
    if (!refused) return;
    setSource(undefined);
    setNotice('Source access changed');
  }, [refused]);
  const open = async () => {
    setNotice('');
    const selected = structuredClone(selection);
    const result = await prepared.refetch();
    if (!authority.isCurrent()) return;
    if (result.error) {
      setNotice(errorText(result.error));
      return;
    }
    if (result.data?.state === 'available')
      setSource({
        selection: selected,
        title: result.data.title,
        body: result.data.body,
        expectedSourceRef: result.data.ref,
        truncated: result.data.truncated,
      });
    else setNotice('The canonical source is unavailable.');
  };
  if (!enabled || !authority.isCurrent()) return null;
  return (
    <>
      <Button
        size="sm"
        onClick={() => void open()}
        disabled={!authority.isCurrent() || prepared.isFetching}
      >
        {prepared.isFetching ? 'Preparing source…' : 'Review as learning'}
      </Button>
      {notice && (
        <ErrorState
          variant="compact"
          title={
            refused || notice === 'Source access changed'
              ? 'Source access changed'
              : 'Learning source unavailable'
          }
          description={
            notice === 'Source access changed'
              ? 'Prepare the source again to check access.'
              : notice
          }
          action={
            <Button
              size="sm"
              disabled={prepared.isFetching}
              onClick={() => void open()}
            >
              Retry source
            </Button>
          }
        />
      )}
      {source && !refused && (
        <LearningReviewProposalDialog
          slug={slug}
          projectId={projectId}
          authority={authority}
          source={source}
          onClose={() => setSource(undefined)}
        />
      )}
    </>
  );
}

/** A saved rating and canonical row turn are necessary; current catalogue identity is only an expected-id pin. */
export function RatedResponseLearningAction({
  conversationId,
  turnId,
  ratingId,
  projectSlug,
}: {
  conversationId: string;
  turnId: string;
  ratingId: string;
  projectSlug: string;
}) {
  const flags = useSurfaceVisibilityFlags();
  const authority = useHostRequestAuthorityScope();
  const project = useScopedProjectQuery(projectSlug, {
    enabled: flags.has('learning-lifecycle-review') && !!authority,
  });
  if (!authority || !flags.has('learning-lifecycle-review')) return null;
  const projectId = project.data?.id;
  if (!projectId || project.error)
    return <span>Learning context unavailable</span>;
  return (
    <LearningRecordReviewButton
      key={JSON.stringify([
        authority.authorityKey,
        projectId,
        ratingId,
        turnId,
      ])}
      slug={projectSlug}
      projectId={projectId}
      authority={authority}
      selection={{ kind: 'rated-feedback', conversationId, turnId, ratingId }}
    />
  );
}
