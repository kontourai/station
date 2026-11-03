import {
  useOrchestrationSessionsQuery,
  useReorderProjectsMutation,
} from '@kontourai/station-sdk';
import { formatArtifactBuildTimestamp } from '@kontourai/station-shared/build-provenance';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { memo, useEffect, useMemo, useRef } from 'react';
import { buildInfo } from '../../build-info';
import { useAgents } from '../../contexts/AgentsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import {
  useNavigation,
  useNavigationActions,
} from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useBranding } from '../../hooks/useBranding';
import { useProjectAccents } from '../../hooks/useProjectAccents';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import {
  projectLiveCount,
  projectLiveLabel,
  projectLiveLanesBySlug,
} from '../../views/project-page/project-live-work-model';
import { HomeGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { Skeleton } from '../state';
import { ProjectSidebarHeader } from './ProjectSidebarHeader';
import { ProjectSidebarNav } from './ProjectSidebarNav';
import { ProjectSidebarRow } from './ProjectSidebarRow';
import { useProjectListReorder } from './useProjectListReorder';
import { useProjectSidebarState } from './useProjectSidebarState';
import { buildSidebarClassName } from './utils';
import './ProjectSidebar.css';

const loadProjectSidebarFooter = () =>
  import('./ProjectSidebarFooter').then((module) => ({
    default: module.ProjectSidebarFooter,
  }));

const loadProjectSidebarBoards = () =>
  import('./ProjectSidebarBoards').then((module) => ({
    default: module.ProjectSidebarBoards,
  }));

function ProjectSidebarImpl() {
  const { projects, isLoading } = useProjects();
  // The rows under this component are not memoized, so this subscription is
  // what decides whether they re-render: a whole-snapshot read re-rendered
  // every mounted row on every dock toggle, font-size write and
  // workspace-pane change. These three fields are all the sidebar reads.
  const { selectedProject, selectedProjectLayout, pathname } = useNavigation(
    (state) => ({
      selectedProject: state.selectedProject,
      selectedProjectLayout: state.selectedProjectLayout,
      pathname: state.pathname,
    }),
  );
  const { navigate } = useNavigationActions();
  // #928 C2a: Home is a region surface whose only placement is `main`, so
  // "go Home" REVEALS it — `showSurface('home')` places it in `main` and the
  // model navigates to `/` — rather than navigating to `/` and showing
  // whatever surface currently occupies `main`. Same seam the palette and
  // `ProjectSidebarNav` use for a `regionSurface` destination.
  const showSurface = useShowSurface();
  const goHome = () => {
    showSurface('home');
    if (isMobile) setMobileOpen(false);
  };
  const mainOccupant = useRegionModelOptional()?.regions.main.occupant;
  // Active when `/` is showing Home, not merely when the route is `/`: with
  // another surface in `main`, `/` is not Home.
  const isHomeActive =
    pathname === '/' &&
    (mainOccupant === undefined ||
      mainOccupant === null ||
      mainOccupant === 'home');
  const branding = useBranding();
  const platformProfile = usePlatformProfile();
  // The sidebar is the primary installed-app chrome. Native package identity
  // must win here so a selected remote Station cannot rename Beta/Nightly.
  const releaseChannelBadge =
    platformProfile.isTauri && platformProfile.channel !== 'stable'
      ? platformProfile.channel
      : undefined;
  // Do not parse a channel out of productName: it is package metadata, not
  // presentation authority. Native chrome derives its visible and accessible
  // identity from the same trusted channel report and build metadata.
  const appName = platformProfile.isTauri ? 'Station' : branding.appName;
  const clientBuild = formatArtifactBuildTimestamp(
    platformProfile.clientBuild?.builtAt,
    { development: platformProfile.isDevBuild },
  );
  const homeLabel = platformProfile.isTauri
    ? [
        appName,
        releaseChannelBadge,
        `v${buildInfo.version}`,
        clientBuild.description,
      ]
        .filter(Boolean)
        .join(' ')
    : appName;
  const agents = useAgents();
  const { data: sessions = [] } = useOrchestrationSessionsQuery();
  // The one project-colour allocation every surface shares.
  const accentBySlug = useProjectAccents();
  const projectSlugs = useMemo(
    () => projects.map((project) => project.slug),
    [projects],
  );
  // archive#3315: server-owned order. The list arrives pre-sorted by the
  // persisted positions; a commit sends the full desired slug order back.
  // #481: the reorder captures the host authority at call time, so the
  // optimistic write/rollback/settle target THIS authority's list cache and
  // never another home's.
  const hostRequestAuthority = useHostRequestAuthorityScope();
  const { namespace: durableAuthorityNamespace } = useAuthorityPersistence();
  const reorderProjectsMutation = useReorderProjectsMutation();
  const { rowReorderProps, announcement: reorderAnnouncement } =
    useProjectListReorder(
      projectSlugs,
      (order) =>
        reorderProjectsMutation.mutate({
          order,
          requestScope: hostRequestAuthority,
          requireRequestScope: true,
          // MUST equal the list reader's durable id for this authority, or
          // the optimistic write lands in an entry no reader watches.
          ...(durableAuthorityNamespace
            ? { durableAuthorityId: durableAuthorityNamespace }
            : {}),
        }),
      {
        labelFor: (slug) =>
          projects.find((project) => project.slug === slug)?.name ?? slug,
      },
    );
  // archive#3202: the badge's number is now the Sessions list's own live lanes
  // scoped to one project (`project-live-work-model.ts`) — the same function
  // the project page's Live work section renders from, so the count and the
  // list it sends the reader to cannot disagree. The badge previously folded
  // the conversation inventory here inline; see that module for what changed
  // and why.
  const liveLanesByProject = useMemo(
    () =>
      projectLiveLanesBySlug({
        sessions,
        agents,
        projectSlugs,
        now: Date.now(),
      }),
    [sessions, agents, projectSlugs],
  );
  const {
    effectiveCollapsed,
    isMobile,
    mobileOpen,
    mobileTriggerRef,
    setMobileOpen,
  } = useProjectSidebarState();
  const navigationRef = useRef<HTMLElement>(null);
  const wasMobileOpen = useRef(false);
  const returnFocusRef = useRef<HTMLElement[]>([]);

  // The mobile drawer's return focus goes through the shared module
  // (archive#1245). Its own copy was `if (trigger?.isConnected) trigger.focus`
  // the exact archive#1126 shape: `isConnected` answers "is it in the document", not
  // "can it take focus", and there was no fallback when the trigger did not
  // survive. The drawer navigates, so the header button that opened it can be
  // replaced by the destination's own header, and a hamburger inside a
  // collapsed section is connected but unfocusable.
  useEffect(() => {
    if (!isMobile) {
      wasMobileOpen.current = false;
      return;
    }
    if (mobileOpen) {
      wasMobileOpen.current = true;
      // Captured while the trigger and its ancestors are all still attached:
      // React detaches a removed row on its own, which nulls `parentElement`
      // and leaves nothing to walk at restore time.
      returnFocusRef.current = captureReturnFocus(mobileTriggerRef.current);
      const frame = requestAnimationFrame(() => {
        navigationRef.current
          ?.querySelector<HTMLElement>('.sidebar__mobile-close')
          ?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasMobileOpen.current) return;
    wasMobileOpen.current = false;
    const chain = returnFocusRef.current;
    returnFocusRef.current = [];
    const frame = restoreReturnFocus(chain, navigationRef.current);
    return () => cancelAnimationFrame(frame);
  }, [isMobile, mobileOpen, mobileTriggerRef]);

  const handleNavigationKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isMobile || !mobileOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMobileOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      navigationRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {isMobile && mobileOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <nav
        id="mobile-navigation"
        data-escape-owner={isMobile && mobileOpen ? '' : undefined}
        ref={navigationRef}
        className={buildSidebarClassName({
          isMobile,
          mobileOpen,
          collapsed: effectiveCollapsed,
        })}
        aria-label={isMobile ? 'Mobile navigation' : 'Primary navigation'}
        aria-hidden={isMobile && !mobileOpen ? true : undefined}
        onKeyDown={handleNavigationKeyDown}
      >
        <ProjectSidebarHeader
          appName={appName}
          homeLabel={homeLabel}
          channelBadge={releaseChannelBadge}
          isMobile={isMobile}
          onCloseMobile={() => setMobileOpen(false)}
          onGoHome={goHome}
        />

        <div className="sidebar__body">
          <button
            type="button"
            className={`sidebar__project-btn${isHomeActive ? ' sidebar__project-btn--active' : ''}`}
            aria-label="Home"
            // #1582 D4: exactly one sidebar row may claim to be the current
            // location. `isHomeActive` already derives that from `main`'s
            // occupant rather than the route alone, so it is the honest place
            // to say it. The Activity row reads the same fact for its own
            // surface (`ProjectSidebarNav`), and `main` holds one surface, so
            // at most one of the two is ever current.
            aria-current={isHomeActive ? 'page' : undefined}
            onClick={goHome}
          >
            <span className="sidebar__nav-icon" aria-hidden="true">
              <HomeGlyph />
            </span>
            <span className="sidebar__project-name">Home</span>
          </button>
          {/* #2059 (D3): Activity sits directly under Home as the panel's
              other place. The destination rows used to be a band at the
              BOTTOM of the panel, below the projects, because that band was
              mostly configuration; with the configuration gone the one row
              left belongs beside the place it is a peer of. */}
          <ProjectSidebarNav
            collapsed={effectiveCollapsed}
            isMobile={isMobile}
            navigate={navigate}
            activePath={pathname}
            onAfterNavigate={() => setMobileOpen(false)}
          />
          <div className="sidebar__section-label sidebar__section-label--projects">
            <span className="sidebar__section-label-text">Projects</span>
            <button
              type="button"
              className="sidebar__section-add"
              data-new-project-trigger
              aria-label="New Project"
              title="New Project"
              onClick={() => {
                navigate('/projects/new');
                if (isMobile) setMobileOpen(false);
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          {isLoading && projects.length === 0
            ? // Cold start: hold the list shape with pulsing rows instead of a
              // blank gap until projects resolve.
              Array.from({ length: 3 }, (_, i) => (
                <div className="sidebar__project-skeleton" key={i}>
                  <Skeleton
                    variant="circle"
                    className="sidebar__project-skeleton-icon"
                  />
                  {!effectiveCollapsed && (
                    <Skeleton
                      variant="line"
                      className="sidebar__project-skeleton-label"
                    />
                  )}
                </div>
              ))
            : null}
          {projects.map((project, index) => {
            const isActive = selectedProject === project.slug;
            const liveLanes = liveLanesByProject.get(project.slug) ?? [];
            return (
              <ProjectSidebarRow
                key={`${durableAuthorityNamespace ?? ''}:${isMobile}:${project.slug}`}
                reorder={rowReorderProps(index)}
                project={project}
                isActive={isActive}
                activeLayout={
                  isActive
                    ? ((selectedProjectLayout as string | null) ?? null)
                    : null
                }
                collapsed={effectiveCollapsed}
                onNavigate={isMobile ? () => setMobileOpen(false) : undefined}
                accent={accentBySlug.get(project.slug)}
                liveCount={projectLiveCount(liveLanes)}
                liveLabel={projectLiveLabel(liveLanes)}
              />
            );
          })}
          {/* A keyboard reorder is otherwise silent: the rows swap with no
              announcement and no visible change a screen reader can report.
              Keyboard-only — a pointer drag already shows what it did. */}
          <LazyBoundary
            key={`${durableAuthorityNamespace ?? ''}:${isMobile}`}
            load={loadProjectSidebarBoards}
            pending={null}
            componentProps={{
              collapsed: effectiveCollapsed,
              isMobile,
              navigate,
              activePath: pathname,
              onAfterNavigate: () => setMobileOpen(false),
            }}
          />
          <span
            role="status"
            aria-live="polite"
            className="sidebar__reorder-status"
          >
            {reorderAnnouncement}
          </span>
        </div>

        <LazyBoundary
          key={`${durableAuthorityNamespace ?? ''}:${isMobile}`}
          load={loadProjectSidebarFooter}
          componentProps={{
            activePath: pathname,
            navigate,
            isMobile,
            collapsed: effectiveCollapsed,
            onAfterNavigate: () => setMobileOpen(false),
          }}
          pending={null}
        />
      </nav>
    </>
  );
}

/**
 * The sidebar takes no props, so this boundary is total: it re-renders for
 * its own subscriptions (navigation selector, projects, device
 * settings — context and store reads reach a memoized component unchanged)
 * and for nothing its parent does. `App` reads the whole navigation snapshot,
 * including the `lastProject` memory a selector cannot see, so without this
 * every mounted row still re-rendered on every dock toggle through App's
 * re-render, whatever this component subscribed to.
 */
export const ProjectSidebar = memo(ProjectSidebarImpl);
