import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { displayableProjectIcon } from '../../components/icons/ProjectIcon';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  useScopedMemberProjectSharedTaskDetails,
  useScopedMemberProjectSharedTasksQuery,
} from '../../contexts/ProjectsContext';
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
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
  const sharedWork = useScopedMemberProjectSharedTasksQuery(
    { id: project.id, slug: project.slug },
    requestScope,
  );
  const selectedWork = sharedWork.data?.find(
    (item) => item.shareId === selectedShareId,
  );

  return (
    <div className="project-page">
      <div className="project-page__inner">
        {/* The one icon rule every surface uses. It refuses a URL or a path,
            so the native relay view never issues a raw image request outside
            the broker; a validated data: image is inline bytes and draws.
            `ProjectIcon` applies the same rule; it is stated again here
            because this is the broker boundary, so a header that stopped
            using `ProjectIcon` could not start loading remote images. */}
        <MemberProjectHeader
          project={{ ...project, icon: displayableProjectIcon(project.icon) }}
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
                  <Button
                    aria-expanded={selectedShareId === item.shareId}
                    onClick={() =>
                      setSelectedShareId((current) =>
                        current === item.shareId ? null : item.shareId,
                      )
                    }
                  >
                    {selectedShareId === item.shareId
                      ? 'Hide shared item details'
                      : `Read shared item: ${item.task.title}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {selectedWork ? (
            <SharedWorkDetails
              project={project}
              sharedTask={selectedWork}
              requestScope={requestScope}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function SharedWorkDetails({
  project,
  sharedTask,
  requestScope,
}: {
  project: MemberProjectView;
  sharedTask: ProjectSharedTaskSummary;
  requestScope: NonNullable<RequestScope>;
}) {
  const { publication, publicationIsCurrent, history, document } =
    useScopedMemberProjectSharedTaskDetails(
      { id: project.id, slug: project.slug },
      sharedTask,
      requestScope,
    );
  const canDisplaySharedDetails =
    publicationIsCurrent && requestScope.isCurrent();

  return (
    <section aria-label={`Shared item details for ${sharedTask.task.title}`}>
      <h3>{sharedTask.task.title}</h3>
      <section aria-label="Shared publication">
        <h4>Publication</h4>
        <Button
          size="sm"
          disabled={!requestScope.isCurrent() || publication.isFetching}
          pending={publication.isFetching}
          onClick={() => void publication.refetch()}
        >
          Refresh publication status
        </Button>
        {publication.isPending ? (
          <SkeletonBlock count={1} label="Checking shared publication" />
        ) : publication.isError ? (
          <p role="status">Publication is unavailable for this account.</p>
        ) : publication.data?.kind === 'shared' ? (
          <p role="status">
            Shared on{' '}
            <time dateTime={publication.data.publication.sharedAt}>
              {new Date(publication.data.publication.sharedAt).toLocaleString()}
            </time>
          </p>
        ) : (
          <p role="status">This shared item is no longer published.</p>
        )}
      </section>
      <section aria-label="Shared history">
        <h4>History</h4>
        {!canDisplaySharedDetails ? (
          <p role="status">
            History is hidden until a current publication is confirmed.
          </p>
        ) : history.isPending ? (
          <SkeletonBlock count={1} label="Loading shared history" />
        ) : history.isError || history.data?.kind !== 'available' ? (
          <p role="status">Shared history is unavailable.</p>
        ) : history.data.records.length === 0 ? (
          <Empty variant="compact" label="Human-message history is empty." />
        ) : (
          <ol aria-label="Shared history records">
            {history.data.records.map((record) => (
              <li key={record.sequence}>
                <p>
                  {record.actor.label} · entry {record.sequence}
                </p>
                <pre>{record.body.text}</pre>
              </li>
            ))}
          </ol>
        )}
        {history.data?.kind === 'available' && history.data.hasMore ? (
          <p>Older shared history is not loaded in this reader.</p>
        ) : null}
      </section>
      <section aria-label="Shared document">
        <h4>Document</h4>
        {!canDisplaySharedDetails ? (
          <p role="status">
            The document is hidden until a current publication is confirmed.
          </p>
        ) : document.isPending ? (
          <SkeletonBlock count={1} label="Loading shared document" />
        ) : document.isError || document.data?.kind !== 'snapshot' ? (
          <p role="status">Shared document is unavailable.</p>
        ) : (
          <pre>{document.data.text}</pre>
        )}
      </section>
    </section>
  );
}
