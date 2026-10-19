import { isPendingAttentionItem } from '@kontourai/station-contracts/attention';
import type { PersonalBoardSection } from '@kontourai/station-contracts/personal-board';
import {
  useBoardAttentionQuery,
  useBoardRecentWorkQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { isPlainLeftClick } from '../../utils/attentionOpen';

function StationLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const { navigate } = useNavigation();
  return (
    <a
      href={href}
      onClick={(event) => {
        if (href.startsWith('/') && isPlainLeftClick(event)) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
function ReadState({
  query,
  children,
  empty,
}: {
  query: { isLoading: boolean; isError: boolean; refetch: () => unknown };
  children: ReactNode;
  empty: boolean;
}) {
  if (query.isError)
    return (
      <ErrorState
        variant="compact"
        title="Could not refresh this section"
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      />
    );
  if (query.isLoading)
    return <SkeletonBlock count={2} label="Loading Board section" />;
  return empty ? <Empty label="Nothing here right now." /> : children;
}
function TaskSection({
  section,
}: {
  section: Extract<PersonalBoardSection, { kind: 'tasks' }>;
}) {
  const scope = useHostRequestAuthorityScope();
  const tasks = useTasksQuery(undefined, {
    requestScope: scope,
    enabled: !!scope,
    refetchInterval: 10000,
  });
  const projects = useScopedProjectsQuery();
  const available = new Map(
    (projects.data ?? []).map((project) => [project.slug, project]),
  );
  const rows = (tasks.data ?? [])
    .filter(
      (task) =>
        available.has(task.projectId) &&
        (!section.projectSlug ||
          available.get(task.projectId)?.slug === section.projectSlug) &&
        (section.includeCompleted ||
          !['done', 'canceled'].includes(task.status)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, section.limit);
  const query = {
    isLoading: tasks.isLoading || projects.isLoading,
    isError: tasks.isError || projects.isError,
    refetch: () => {
      void tasks.refetch();
      void projects.refetch();
    },
  };
  return (
    <ReadState query={query} empty={!rows.length}>
      <ul className="personal-board__rows">
        {rows.map((task) => (
          <li key={task.id}>
            <StationLink href={`/tasks/${encodeURIComponent(task.id)}`}>
              {task.title}
            </StationLink>
            <span>
              {task.status === 'todo' || task.status === 'ready'
                ? 'To do'
                : task.status.replaceAll('_', ' ')}
            </span>
          </li>
        ))}
      </ul>
    </ReadState>
  );
}
function AttentionSection({
  section,
}: {
  section: Extract<PersonalBoardSection, { kind: 'attention' }>;
}) {
  const scope = useHostRequestAuthorityScope();
  const query = useBoardAttentionQuery(scope);
  const rows = (query.data?.items ?? [])
    .filter(isPendingAttentionItem)
    .filter(
      (item) =>
        !section.projectSlug || item.projectSlug === section.projectSlug,
    )
    .slice(0, section.limit);
  return (
    <>
      <ReadState query={query} empty={!rows.length}>
        <ul className="personal-board__rows">
          {rows.map((item) => (
            <li key={item.id}>
              {'openHref' in item && item.openHref ? (
                <StationLink href={item.openHref}>{item.title}</StationLink>
              ) : (
                <span>{item.title}</span>
              )}
              <span>{item.kind.replaceAll('-', ' ')}</span>
            </li>
          ))}
        </ul>
      </ReadState>
      {query.data?.unavailableSources?.length ? (
        <p role="status">
          Some attention sources are unavailable. Open Activity to inspect the
          remaining work.
        </p>
      ) : null}
    </>
  );
}
function RecentSection({
  section,
}: {
  section: Extract<PersonalBoardSection, { kind: 'recent-work' }>;
}) {
  const scope = useHostRequestAuthorityScope();
  const query = useBoardRecentWorkQuery(scope);
  const rows = (query.data ?? [])
    .filter(
      (session) =>
        !section.projectSlug || session.projectSlug === section.projectSlug,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, section.limit);
  return (
    <ReadState query={query} empty={!rows.length}>
      <ul className="personal-board__rows">
        {rows.map((session) => (
          <li key={session.threadId}>
            <StationLink
              href={`/?surface=activity&session=${encodeURIComponent(session.threadId)}`}
            >
              {session.displayTitle || 'Untitled conversation'}
            </StationLink>
            <time dateTime={session.updatedAt}>
              {new Date(session.updatedAt).toLocaleDateString()}
            </time>
          </li>
        ))}
      </ul>
    </ReadState>
  );
}
function ProjectsSection({
  section,
}: {
  section: Extract<PersonalBoardSection, { kind: 'projects' }>;
}) {
  const query = useScopedProjectsQuery({ refetchInterval: 15000 });
  const rows = (query.data ?? []).slice(0, section.limit);
  return (
    <ReadState query={query} empty={!rows.length}>
      <ul className="personal-board__rows">
        {rows.map((project) => (
          <li key={project.id}>
            <StationLink href={`/projects/${encodeURIComponent(project.slug)}`}>
              {project.name}
            </StationLink>
          </li>
        ))}
      </ul>
    </ReadState>
  );
}
export function PersonalBoardSectionContent({
  section,
}: {
  section: PersonalBoardSection;
}) {
  switch (section.kind) {
    case 'tasks':
      return <TaskSection section={section} />;
    case 'attention':
      return <AttentionSection section={section} />;
    case 'recent-work':
      return <RecentSection section={section} />;
    case 'projects':
      return <ProjectsSection section={section} />;
    case 'note':
      return (
        <p className="personal-board__note">
          {section.body || 'Add a note in Edit Board.'}
        </p>
      );
    case 'links':
      return (
        <ul className="personal-board__rows">
          {section.links.map((link, index) => (
            <li key={`${index}-${link.href}`}>
              <StationLink href={link.href}>{link.label}</StationLink>
            </li>
          ))}
        </ul>
      );
  }
}
