import {
  useOrchestrationSessionsQuery,
  useReorderProjectsMutation,
} from '@kontourai/station-sdk';
import { formatArtifactBuildTimestamp } from '@kontourai/station-shared/build-provenance';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { buildInfo } from '../../build-info';
import { useAllActiveChats } from '../../contexts/ActiveChatsContext';
import { useAgents } from '../../contexts/AgentsContext';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { openChatsStore, useOpenChats } from '../../contexts/open-chats-store';
import { useProjects } from '../../contexts/ProjectsContext';
import { useBranding } from '../../hooks/useBranding';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { chatTaskSessionId } from '../../views/home/home-view-model';
import {
  projectLiveCount,
  projectLiveLabel,
  projectLiveLanesBySlug,
} from '../../views/project-page/project-live-work-model';
import { LazyBoundary } from '../LazyBoundary';
import { Skeleton } from '../state';
import { ProjectSidebarHeader } from './ProjectSidebarHeader';
import { ProjectSidebarNav } from './ProjectSidebarNav';
import { ProjectSidebarRow } from './ProjectSidebarRow';
import { projectAccents } from './projectAccent';
import { useProjectListReorder } from './useProjectListReorder';
import { useProjectSidebarState } from './useProjectSidebarState';
import { buildSidebarClassName } from './utils';
import './ProjectSidebar.css';

const loadProjectSidebarStatus = () =>
  import('./ProjectSidebarStatus').then((module) => ({
    default: module.ProjectSidebarStatus,
  }));

/** archive#3314: shared-inbox-row list, lazy so the row module (and its stylesheet)
 *  stays out of the entry chunk this sidebar belongs to. */
const loadSidebarOpenChats = () =>
  import('./SidebarOpenChats').then((module) => ({
    default: module.SidebarOpenChats,
  }));

/**
 * archive#3314: how many open chats the sidebar section lists
 * before folding the rest behind an "N more" affordance that opens the
 * dock's own inbox (the unbounded surface for this list).
 */
export const OPEN_CHATS_SIDEBAR_CAP = 3;

export function ProjectSidebar() {
  const { projects, isLoading } = useProjects();
  const { selectedProject, selectedProjectLayout, navigate, pathname } =
    useNavigation();
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
  const clientBuildLabel =
    clientBuild.state === 'available' ? `Built ${clientBuild.age}` : undefined;
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
  const activeChats = useAllActiveChats();
  const drafts = useSyncExternalStore(
    chatDraftsStore.subscribe,
    chatDraftsStore.getSnapshot,
    chatDraftsStore.getSnapshot,
  );
  const { data: sessions = [] } = useOrchestrationSessionsQuery();
  // #765 A1/A2: pass the server session summaries, exactly as the dock inbox
  // and Sessions view do. Without them `chatLifecycleLabel` has no
  // correlated turn state and falls back to labelling every open chat
  // "Running"/Active from local composer state alone — which is how a
  // session the server had already folded to `failed` kept its "Active"
  // chip in this sidebar.
  const openChats = useOpenChats(agents, sessions);
  const recentTasks = openChats.slice(0, OPEN_CHATS_SIDEBAR_CAP);
  const openChatsOverflow = openChats.length - recentTasks.length;
  // archive#3314: per-section collapse + removal, persisted device-side alongside
  // `projectSidebarCollapsed` (restore for a removed section lives in
  // Settings → Appearance).
  const { sidebarSections } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const setSidebarSection = (patch: Partial<typeof sidebarSections>) =>
    setDeviceSetting('sidebarSections', { ...sidebarSections, ...patch });
  // Drafts are composed from the same store the composer writes and the same
  // active-chat identity that the dock can focus. Do not synthesize a sidebar
  // copy: opening one must restore the exact persisted composer value.
  const unsentDrafts = useMemo(
    () =>
      Object.entries(drafts)
        .filter(([, draft]) => draft.text.trim())
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .map(([sessionId, draft]) => {
          const chat = activeChats[sessionId];
          return {
            sessionId,
            title: chat?.title?.trim() || 'Unsent draft',
            preview: draft.text.trim(),
          };
        }),
    [activeChats, drafts],
  );
  // Allocate the accent palette across the whole sorted project set so every
  // color is used before any repeats, stable regardless of API order.
  const accentBySlug = useMemo(
    () => projectAccents(projects.map((project) => project.slug)),
    [projects],
  );
  const projectSlugs = useMemo(
    () => projects.map((project) => project.slug),
    [projects],
  );
  // archive#3315: server-owned order. The list arrives pre-sorted by the
  // persisted positions; a commit sends the full desired slug order back.
  const reorderProjectsMutation = useReorderProjectsMutation();
  const { rowReorderProps, announcement: reorderAnnouncement } =
    useProjectListReorder(
      projectSlugs,
      (order) => reorderProjectsMutation.mutate(order),
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
    toggleCollapse,
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
          buildLabel={clientBuildLabel}
          buildDescription={clientBuild.description}
          collapsed={effectiveCollapsed}
          isMobile={isMobile}
          onCloseMobile={() => setMobileOpen(false)}
          onGoHome={() => {
            navigate('/');
            if (isMobile) setMobileOpen(false);
          }}
          onToggleCollapse={toggleCollapse}
        />

        <div className="sidebar__body">
          {effectiveCollapsed && !isMobile && (
            <button
              type="button"
              className="sidebar__collapsed-chats"
              aria-label="Open chats"
              title="Open chats"
              onClick={() => openChatsStore.openCollection()}
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 8.5 8.5 0 1 1 0-17 8.3 8.3 0 0 1 7.3 4.2" />
                <path d="M8 10h8M8 14h5" />
              </svg>
            </button>
          )}
          <div className="sidebar__section-label">Work</div>
          <button
            type="button"
            className={`sidebar__project-btn${pathname === '/' ? ' sidebar__project-btn--active' : ''}`}
            onClick={() => {
              navigate('/');
              if (isMobile) setMobileOpen(false);
            }}
          >
            <span aria-hidden="true">⌂</span>
            <span className="sidebar__project-name">Home</span>
          </button>
          {/* archive#3314: Open chats is a mini-inbox — shared inbox rows (compact
              variant), collapsible with the nav groups' disclosure anatomy
              (aria-expanded + aria-controls + hidden), and removable
              (restore in Settings → Appearance). */}
          {!sidebarSections.openChatsHidden && recentTasks.length > 0 && (
            <>
              <div className="sidebar__section-label sidebar__section-label--disclosure">
                <button
                  type="button"
                  className="sidebar__section-toggle"
                  aria-expanded={!sidebarSections.openChatsCollapsed}
                  aria-controls="sidebar-open-chats"
                  onClick={() =>
                    setSidebarSection({
                      openChatsCollapsed: !sidebarSections.openChatsCollapsed,
                    })
                  }
                >
                  <span className="sidebar__section-label-text">
                    Open chats
                  </span>
                  <span className="sidebar__nav-chevron" aria-hidden="true">
                    {sidebarSections.openChatsCollapsed ? '+' : '−'}
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar__section-remove"
                  aria-label="Remove Open chats from sidebar"
                  title="Remove from sidebar — restore in Settings → Appearance"
                  onClick={() => setSidebarSection({ openChatsHidden: true })}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              <div
                id="sidebar-open-chats"
                className="sidebar__open-chats chat-dock-inbox--compact"
                hidden={sidebarSections.openChatsCollapsed}
              >
                <LazyBoundary
                  load={loadSidebarOpenChats}
                  pending={null}
                  componentProps={{
                    items: recentTasks,
                    now: Date.now(),
                    onActivate: (task) => {
                      openChatsStore.focus({
                        sessionId: chatTaskSessionId(task),
                      });
                      if (isMobile) setMobileOpen(false);
                    },
                  }}
                />
                {openChatsOverflow > 0 && (
                  <button
                    type="button"
                    className="sidebar__recent-task sidebar__recent-more"
                    onClick={() => {
                      // Which surface holds the unbounded list depends on the
                      // dock's chrome, so `openCollection` owns that routing —
                      // the sidebar must not decide it from here (archive#3314
                      //).
                      openChatsStore.openCollection();
                      if (isMobile) setMobileOpen(false);
                    }}
                  >
                    <span>{`${openChatsOverflow} more`}</span>
                  </button>
                )}
              </div>
            </>
          )}
          {!sidebarSections.draftsHidden && unsentDrafts.length > 0 && (
            <>
              <div className="sidebar__section-label sidebar__section-label--disclosure">
                <button
                  type="button"
                  className="sidebar__section-toggle"
                  aria-expanded={!sidebarSections.draftsCollapsed}
                  aria-controls="sidebar-drafts"
                  onClick={() =>
                    setSidebarSection({
                      draftsCollapsed: !sidebarSections.draftsCollapsed,
                    })
                  }
                >
                  <span className="sidebar__section-label-text">Drafts</span>
                  <span className="sidebar__nav-chevron" aria-hidden="true">
                    {sidebarSections.draftsCollapsed ? '+' : '−'}
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar__section-remove"
                  aria-label="Remove Drafts from sidebar"
                  title="Remove from sidebar — restore in Settings → Appearance"
                  onClick={() => setSidebarSection({ draftsHidden: true })}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              <div id="sidebar-drafts" hidden={sidebarSections.draftsCollapsed}>
                {unsentDrafts.map((draft) => (
                  <button
                    key={draft.sessionId}
                    type="button"
                    className="sidebar__recent-task"
                    onClick={() => {
                      openChatsStore.focus({ sessionId: draft.sessionId });
                      if (isMobile) setMobileOpen(false);
                    }}
                  >
                    <span>{draft.title}</span>
                    <small>Draft · {draft.preview}</small>
                  </button>
                ))}
              </div>
            </>
          )}
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
                key={project.slug}
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
          <span
            role="status"
            aria-live="polite"
            className="sidebar__reorder-status"
          >
            {reorderAnnouncement}
          </span>
        </div>

        <ProjectSidebarNav
          collapsed={effectiveCollapsed}
          isMobile={isMobile}
          navigate={navigate}
          activePath={pathname}
          onAfterNavigate={() => setMobileOpen(false)}
        />
        <LazyBoundary
          load={loadProjectSidebarStatus}
          componentProps={{}}
          pending={null}
        />
      </nav>
    </>
  );
}
