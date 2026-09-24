import type { MemberProjectView } from '@kontourai/station-contracts/project';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedMemberProjectSharedTasksQuery } from '../../contexts/ProjectsContext';
import { MemberProjectHeader } from './ProjectPageHeader';
import '../project-page-frame.css';

type RequestScope = ReturnType<typeof useHostRequestAuthorityScope>;

export function MemberProjectPage({
  project,
  requestScope,
}: {
  project: MemberProjectView;
  requestScope: NonNullable<RequestScope>;
}) {
  const sharedWork = useScopedMemberProjectSharedTasksQuery(
    { id: project.id, slug: project.slug },
    requestScope,
  );

  return (
    <div className="project-page">
      <div className="project-page__inner">
        <MemberProjectHeader
          project={project}
          onRefresh={() => void sharedWork.refetch()}
          refreshDisabled={!requestScope.isCurrent() || sharedWork.isFetching}
        />
        <section aria-labelledby="member-project-shared-work-title">
          <h2 id="member-project-shared-work-title">Shared work</h2>
          {sharedWork.isPending ? (
            <SkeletonBlock count={2} label="Loading shared work" />
          ) : sharedWork.isError ? (
            <ErrorState
              title="Shared work is unavailable"
              description={
                sharedWork.error instanceof Error &&
                'status' in sharedWork.error &&
                [401, 403, 404].includes(Number(sharedWork.error.status))
                  ? 'Your access may have changed. Refresh the Project to check again.'
                  : 'Station could not load the work shared with this account.'
              }
              action={
                <Button
                  onClick={() => void sharedWork.refetch()}
                  disabled={!requestScope.isCurrent() || sharedWork.isFetching}
                >
                  Try again
                </Button>
              }
            />
          ) : sharedWork.data.length === 0 ? (
            <Empty
              variant="compact"
              label="There is no shared work in this Project yet."
            />
          ) : (
            <ul aria-label="Shared work items">
              {sharedWork.data.map((item) => (
                <li key={`${item.shareId}:${item.task.id}`}>
                  <strong>{item.task.title}</strong>
                  <span>{item.task.status.replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
