import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
import { StatusBadge } from '@kontourai/ui/react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import {
  projectTaskHistory,
  SharedTaskHistoryList,
} from '../../components/conversation/SharedTaskHistoryList';
import { displayableProjectIcon } from '../../components/icons/ProjectIcon';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  useScopedMemberProjectSharedTaskDetails,
  useScopedMemberProjectSharedTasksQuery,
} from '../../contexts/ProjectsContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ToolLibraryClientContext } from '../agent-editor/ToolLibraryContext';
import { AccessSection } from '../project-settings/AccessSection';
import { ProjectAgentsPanel } from '../project-settings/ProjectAgentsPanel';
import { ProjectNavigation, useProjectDestination } from './ProjectNavigation';
import { ProjectRoom } from './ProjectRoom';
import '../ProjectPage.css';
import { MemberProjectHeader } from './ProjectPageHeader';
import '../project-page-frame.css';
import './MemberProjectPage.css';

type RequestScope = ReturnType<typeof useHostRequestAuthorityScope>;

export function MemberProjectPage({
  project,
  requestScope,
  accessWriteDisabledReason,
}: {
  project: MemberProjectView;
  requestScope: NonNullable<RequestScope>;
  accessWriteDisabledReason?: string;
}) {
  const { destination, room, openRoom, openThread, leaveRoom } =
    useProjectDestination(project.slug);
  // #4795: a channel is its own full screen on a phone.
  const roomScreen = useIsMobile() && destination === 'room';
  const overview = destination === 'overview' || destination === 'sources';
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
  const [toolsProjectId, setToolsProjectId] = useState<string>();
  const sharedWork = useScopedMemberProjectSharedTasksQuery(
    { id: project.id, slug: project.slug },
    requestScope,
  );
  const selectedWork = sharedWork.data?.find(
    (item) => item.shareId === selectedShareId,
  );

  return (
    <div
      className={`project-page project-page--space${roomScreen ? ' project-page--room-screen' : ''}`}
    >
      <div className="project-page__inner project-page__space">
        {/* The one icon rule every surface uses. It refuses a URL or a path,
            so the native relay view never issues a raw image request outside
            the broker; a validated data: image is inline bytes and draws.
            `ProjectIcon` applies the same rule; it is stated again here
            because this is the broker boundary, so a header that stopped
            using `ProjectIcon` could not start loading remote images. */}
        {!roomScreen && (
          <MemberProjectHeader
            project={{ ...project, icon: displayableProjectIcon(project.icon) }}
            onRefresh={() => void sharedWork.refetch()}
            refreshDisabled={!requestScope.isCurrent() || sharedWork.isFetching}
          />
        )}
        <div className="section-nav-rail project-page__layout">
          {!roomScreen && <ProjectNavigation slug={project.slug} member />}
          <section className="section-nav-rail__body project-page__content">
            <div hidden={!overview && destination !== 'room'}>
              <ProjectRoom
                slug={project.slug}
                projectId={project.id}
                requestScope={requestScope}
                variant={destination === 'room' ? 'full' : 'preview'}
                onOpenRoom={openRoom}
                {...(destination === 'room'
                  ? {
                      routeChannel: { id: room.channelId },
                      onRouteChannel: openRoom,
                      thread: { rootId: room.threadId, open: openThread },
                    }
                  : {})}
                {...(roomScreen
                  ? {
                      screen: {
                        backLabel: `Back to ${project.name}`,
                        onBack: leaveRoom,
                      },
                    }
                  : {})}
              />
            </div>
            {!roomScreen && project.actions.includes('manage-members') && (
              <details>
                <summary>Project access</summary>
                <AccessSection
                  slug={project.slug}
                  projectId={project.id}
                  allowEnableSharing={false}
                  writeDisabledReason={accessWriteDisabledReason}
                />
              </details>
            )}
            {!roomScreen &&
              project.actions.includes('manage-members') &&
              (toolsProjectId === project.id ? (
                <ToolLibraryClientContext.Provider
                  value={{
                    apiBase: requestScope.apiBase,
                    options: { requestScope },
                  }}
                >
                  <ProjectAgentsPanel project={project} />
                </ToolLibraryClientContext.Provider>
              ) : (
                <Button onClick={() => setToolsProjectId(project.id)}>
                  Agents and tools
                </Button>
              ))}
            <section
              hidden={!overview && destination !== 'tasks'}
              className="member-project-shared-work"
              aria-labelledby="member-project-shared-work-title"
            >
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
                      disabled={
                        !requestScope.isCurrent() || sharedWork.isFetching
                      }
                    >
                      Retry
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
                      <StatusBadge
                        tone="neutral"
                        status={taskStatusLabel(item.task.status)}
                      />
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
          </section>
        </div>
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
    <section
      className="member-project-shared-details"
      aria-label={`Shared item details for ${sharedTask.task.title}`}
    >
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
        <SharedTaskHistoryList
          records={projectTaskHistory(history.data?.pages ?? []).records}
          readable={canDisplaySharedDetails && !history.readDenied}
          pending={history.isPending}
          failed={history.isError}
          outcome={projectTaskHistory(history.data?.pages ?? []).outcome}
          hasEarlier={history.hasNextPage}
          loadingEarlier={history.isFetchingNextPage}
          onLoadEarlier={() => void history.fetchNextPage()}
          onRetry={() =>
            void (history.isFetchNextPageError
              ? history.fetchNextPage()
              : history.refetch())
          }
        />
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
