import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import type { DeveloperTab, NavigationView } from '../types';
import {
  CONNECTION_SECTIONS,
  canonicalConnectionPath,
} from '../views/connections-hub/connection-sections';
import {
  APP_SURFACE_REGISTRY,
  type ManagementSurfaceId,
} from './surface-registry';

export const DEVELOPER_TABS = [
  'logs',
  'system',
  'telemetry',
  'memory',
  'archive',
] as const satisfies readonly DeveloperTab[];
type DeveloperTabsExhaustive =
  DeveloperTab extends (typeof DEVELOPER_TABS)[number]
    ? true
    : [
        'DEVELOPER_TABS is missing a DeveloperTab member:',
        Exclude<DeveloperTab, (typeof DEVELOPER_TABS)[number]>,
      ];
true satisfies DeveloperTabsExhaustive;
export function isDeveloperTab(value: string): value is DeveloperTab {
  return (DEVELOPER_TABS as readonly string[]).includes(value);
}

export function getLegacyPathRedirect(path: string): string | null {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const search = queryIndex >= 0 ? path.slice(queryIndex + 1) : '';
  const preserveSearch = (canonicalPath: string) =>
    `${canonicalPath}${search ? `?${search}` : ''}`;
  const canonicalConnection = canonicalConnectionPath(pathname);
  if (canonicalConnection && canonicalConnection !== pathname) {
    return preserveSearch(canonicalConnection);
  }

  // Connections are path-addressed (`/connections/engines`), but the Agent
  // editor previously linked to the older query spelling. Keep that link
  // routable while canonicalizing it before the root Connections resolver can
  // choose a different section. This also preserves any shell-scoped query
  // state the caller supplied alongside the legacy section selector.
  if (pathname === '/connections') {
    const params = new URLSearchParams(search);
    const section = CONNECTION_SECTIONS.find(
      (candidate) => candidate.id === params.get('section'),
    );
    if (section) {
      params.delete('section');
      const canonicalSearch = params.toString();
      return `${section.path}${canonicalSearch ? `?${canonicalSearch}` : ''}`;
    }
  }

  const redirectPrefix = (
    legacyPrefix: string,
    canonicalPrefix: string,
    canonicalSearch?: string,
  ) => {
    if (pathname !== legacyPrefix && !pathname.startsWith(`${legacyPrefix}/`)) {
      return null;
    }
    const suffix = pathname.slice(legacyPrefix.length);
    const params = new URLSearchParams(canonicalSearch);
    for (const [key, value] of new URLSearchParams(search)) {
      params.append(key, value);
    }
    const mergedSearch = params.toString();
    return `${canonicalPrefix}${suffix}${mergedSearch ? `?${mergedSearch}` : ''}`;
  };

  if (pathname === '/developer/config') {
    const params = new URLSearchParams(search);
    params.delete('view');
    const canonicalParams = new URLSearchParams({ view: 'station-config' });
    for (const [key, value] of params) canonicalParams.append(key, value);
    return `/settings?${canonicalParams.toString()}`;
  }
  // station#3313 (Settings IA, option A): Feature Previews is a Settings
  // section now; the standalone route redirects into it, same pattern as
  // /developer/config above.
  if (pathname === '/feature-previews') {
    const params = new URLSearchParams(search);
    params.delete('view');
    const canonicalParams = new URLSearchParams({ view: 'feature-previews' });
    for (const [key, value] of params) canonicalParams.append(key, value);
    return `/settings?${canonicalParams.toString()}`;
  }
  if (pathname === '/developer/storage') {
    return preserveSearch('/connections/knowledge');
  }
  if (pathname === '/developer/mcp') {
    return preserveSearch('/connections/tools');
  }
  if (pathname.startsWith('/developer/mcp/')) {
    return preserveSearch(
      `/connections/tools/${pathname.slice('/developer/mcp/'.length)}`,
    );
  }
  const legacyAgentPath = pathname.match(
    /^\/agents\/([^/]+)\/(?:tools|workflows)$/,
  );
  if (legacyAgentPath) {
    return preserveSearch(`/agents/${legacyAgentPath[1]}`);
  }

  const prefixRedirects = [
    // Playbooks are Skills. The retired paths land on the surface that
    // absorbed them rather than on a tab that no longer exists.
    ['/prompts', '/guidance', 'tab=skills'],
    ['/playbooks', '/guidance', 'tab=skills'],
    ['/skills', '/guidance', 'tab=skills'],
    ['/integrations', '/connections/tools'],
    ['/manage/agents', '/agents'],
    ['/manage/prompts', '/guidance', 'tab=skills'],
    ['/manage/plugins', '/plugins'],
    ['/manage/integrations', '/connections/tools'],
    ['/manage/providers', '/connections/models'],
  ] as const;
  for (const [
    legacyPrefix,
    canonicalPrefix,
    canonicalSearch,
  ] of prefixRedirects) {
    const redirect = redirectPrefix(
      legacyPrefix,
      canonicalPrefix,
      canonicalSearch,
    );
    if (redirect) return redirect;
  }

  const exactRedirects: Readonly<Record<string, string>> = {
    // station#3280: Activity is canonical before v1. Existing notification
    // and Discord deep links remain valid through this permanent redirect.
    // Both spellings: hand-typed and copy-mangled links commonly carry a
    // trailing slash, and an exact-lookup table would 404 it (review F3).
    '/sessions': '/activity',
    '/sessions/': '/activity',
    '/monitoring': '/developer/telemetry',
    '/sys/monitoring': '/developer/telemetry',
    '/sys/schedule': '/schedule',
    '/manage': '/agents',
    '/tools': '/connections/tools',
  };
  const exactRedirect = exactRedirects[pathname];
  if (exactRedirect) return preserveSearch(exactRedirect);
  return null;
}

/** Decode a one-segment selection without allowing malformed URL escapes to escape rendering. */
export function decodeUrlSelection(
  selection: string | undefined,
): string | null {
  if (!selection) return null;
  try {
    return decodeURIComponent(selection) || null;
  } catch {
    return null;
  }
}

const REGISTRY_TABS = [
  'agents',
  'skills',
  'integrations',
  'plugins',
  'layouts',
  'kits',
] as const satisfies readonly RegistryCatalogTab[];

// Compile-time exhaustiveness check: if `RegistryCatalogTab` (from the SDK)
// ever gains a member not listed in `REGISTRY_TABS` above, this resolves to
// a descriptive tuple type instead of `true`, and the `satisfies` assignment
// below fails to typecheck — turning a silently-missing `/registry/:tab`
// deep-link into a build break instead. `satisfies readonly
// RegistryCatalogTab[]` above only checks the reverse direction (every
// listed value is a valid tab); this checks the other direction (every
// valid tab is listed).
type RegistryTabsExhaustive =
  RegistryCatalogTab extends (typeof REGISTRY_TABS)[number]
    ? true
    : [
        'REGISTRY_TABS is missing a RegistryCatalogTab member:',
        Exclude<RegistryCatalogTab, (typeof REGISTRY_TABS)[number]>,
      ];
true satisfies RegistryTabsExhaustive;

function isRegistryCatalogTab(value: string): value is RegistryCatalogTab {
  return (REGISTRY_TABS as readonly string[]).includes(value);
}

export function resolveViewFromPath(
  path: string,
  _options?: {
    lastProject?: string | null;
    lastProjectLayout?: string | null;
  },
): NavigationView {
  const queryIndex = path.indexOf('?');
  const search = queryIndex >= 0 ? path.slice(queryIndex + 1) : '';
  path = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const exactSurface = APP_SURFACE_REGISTRY.resolveExactRoute(path);
  if (exactSurface) return exactSurface;

  if (path.startsWith('/agents/')) {
    // Preserve the historically accepted trailing-slash spelling while the
    // registry owns the canonical exact route.
    if (path === '/agents/') return { type: 'agents' };
    if (path === '/agents/new') {
      return { type: 'agent-new' };
    }
    if (path.endsWith('/edit')) {
      const slug = path.split('/')[2];
      return { type: 'agent-edit', slug };
    }
    if (path !== '/agents') {
      const slug = path.split('/')[2];
      if (slug) {
        return { type: 'agent-edit', slug };
      }
    }
    return { type: 'not-found', path };
  }

  if (path === '/guidance' || path.startsWith('/guidance/')) {
    const params = new URLSearchParams(search);
    const tab = params.get('tab');
    const filter = params.get('filter');
    const selectedId = decodeUrlSelection(path.split('/')[2]);
    return {
      type: 'guidance',
      ...(tab === 'skills' || tab === 'commands' ? { tab } : {}),
      ...(filter === 'commands' ? { filter } : {}),
      ...(selectedId ? { selectedId } : {}),
    };
  }
  if (path.startsWith('/registry/')) {
    const tabSegment = path.startsWith('/registry/')
      ? path.split('/')[2]
      : undefined;
    if (tabSegment && isRegistryCatalogTab(tabSegment)) {
      return { type: 'registry', tab: tabSegment };
    }
    return { type: 'registry' };
  }
  if (path === '/activity') {
    const params = new URLSearchParams(search);
    const sessionId = params.get('session')?.trim();
    if (!sessionId) return { type: 'activity' };
    // `focus=evidence` is a one-shot intent that only means anything when it
    // names a session; any other value is ignored rather than carried.
    return params.get('focus') === 'evidence'
      ? { type: 'activity', sessionId, focus: 'evidence' }
      : { type: 'activity', sessionId };
  }
  if (path.startsWith('/plugins/')) {
    return { type: 'plugins' };
  }
  if (path === '/connections/models') {
    return { type: 'connections-providers' };
  }
  if (path.startsWith('/connections/models/')) {
    const id = path.split('/')[3];
    if (id) {
      return { type: 'connections-provider-edit', id };
    }
  }
  // `new/<providerId>` is the command-backed provider setup, not an engine
  // id: it must be matched before the generic `/connections/engines/:id`
  // rule below, which would otherwise read the literal `new` as the id and
  // drop the provider. Legacy `/connections/acp/new/<id>` canonicalises here
  // (CONNECTION_SECTIONS drives that redirect), so this is where it lands.
  if (path.startsWith('/connections/engines/new/')) {
    const providerId = decodeURIComponent(
      path.slice('/connections/engines/new/'.length),
    );
    if (providerId) return { type: 'connections-acp-new', providerId };
  }
  if (path.startsWith('/connections/engines/')) {
    const id = path.split('/')[3];
    if (id) {
      return { type: 'connections-runtime-edit', id };
    }
  }
  if (path === '/connections/engines') {
    return { type: 'connections-engines' };
  }
  if (path === '/connections/acp') {
    return { type: 'connections-acp' };
  }
  if (path.startsWith('/connections/acp/new/')) {
    const providerId = decodeURIComponent(
      path.slice('/connections/acp/new/'.length),
    );
    if (providerId) return { type: 'connections-acp-new', providerId };
  }
  if (path === '/connections/tools') {
    return { type: 'connections-tools' };
  }
  if (path.startsWith('/connections/tools/')) {
    const id = path.split('/')[3];
    if (id) {
      return { type: 'connections-tool-edit', id };
    }
  }
  if (path === '/connections/knowledge') {
    return { type: 'connections-knowledge' };
  }
  if (path === '/connections/computers') {
    return { type: 'connections-computers' };
  }
  if (path.startsWith('/developer/')) {
    const segments = path.slice('/developer/'.length).split('/');
    const [tab] = segments;
    if (!tab || !isDeveloperTab(tab)) return { type: 'not-found', path };
    if (segments.length === 1) return { type: 'developer', tab };
    return { type: 'not-found', path };
  }
  if (path === '/projects/new') {
    return { type: 'project-new' };
  }
  // station#4079 slice 1: /board/session/:id and /board/task/:projectId/:id
  // — URL-reachable, no sidebar item this slice (page-frame-registry.ts).
  if (path.startsWith('/board/session/')) {
    const encodedId = path.slice('/board/session/'.length);
    if (!encodedId || encodedId.includes('/')) {
      return { type: 'not-found', path };
    }
    try {
      const id = decodeURIComponent(encodedId).trim();
      return id
        ? { type: 'board', reference: { kind: 'session', id } }
        : { type: 'not-found', path };
    } catch {
      return { type: 'not-found', path };
    }
  }
  if (path.startsWith('/board/task/')) {
    const segments = path.slice('/board/task/'.length).split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      return { type: 'not-found', path };
    }
    try {
      const projectId = decodeURIComponent(segments[0]).trim();
      const id = decodeURIComponent(segments[1]).trim();
      return projectId && id
        ? { type: 'board', reference: { kind: 'task', projectId, id } }
        : { type: 'not-found', path };
    } catch {
      return { type: 'not-found', path };
    }
  }
  if (path === '/tasks' || path.startsWith('/tasks/')) {
    const encodedTaskId = path.slice('/tasks/'.length);
    if (!encodedTaskId || encodedTaskId.includes('/')) {
      return { type: 'not-found', path };
    }
    try {
      const taskId = decodeURIComponent(encodedTaskId).trim();
      return taskId ? { type: 'task', taskId } : { type: 'not-found', path };
    } catch {
      // A malformed percent escape is not a Task id. Keep the raw path so the
      // normal not-found surface can explain the failed deep link.
      return { type: 'not-found', path };
    }
  }
  if (path.startsWith('/projects/') && path.endsWith('/edit')) {
    const slug = path.split('/')[2];
    return { type: 'project-edit', slug };
  }
  if (path.match(/^\/projects\/[^/]+\/session-board/)) {
    const slug = path.split('/')[2];
    return { type: 'project-session-board', slug };
  }
  if (path.match(/^\/projects\/[^/]+\/flow-console/)) {
    const slug = path.split('/')[2];
    const runId = new URLSearchParams(search).get('run')?.trim();
    return runId
      ? { type: 'project-flow-console', slug, runId }
      : { type: 'project-flow-console', slug };
  }
  const layoutPaneRoute = path.match(
    /^\/projects\/([^/]+)\/layouts\/([^/]+)\/panes\/([^/]+)\/([^/]+)$/,
  );
  if (path.match(/^\/projects\/[^/]+\/layouts\/[^/]+\/panes(?:\/|$)/)) {
    if (!layoutPaneRoute) return { type: 'not-found', path };
    try {
      const projectSlug = decodeURIComponent(layoutPaneRoute[1]).trim();
      const layoutSlug = decodeURIComponent(layoutPaneRoute[2]).trim();
      const descriptorId = decodeURIComponent(layoutPaneRoute[3]).trim();
      const instanceId = decodeURIComponent(layoutPaneRoute[4]).trim();
      return projectSlug && layoutSlug && descriptorId && instanceId
        ? {
            type: 'workspace-pane',
            projectSlug,
            layoutSlug,
            descriptorId,
            instanceId,
          }
        : { type: 'not-found', path };
    } catch {
      return { type: 'not-found', path };
    }
  }
  const paneRoute = path.match(
    /^\/projects\/([^/]+)\/panes\/([^/]+)\/([^/]+)$/,
  );
  if (path.match(/^\/projects\/[^/]+\/panes(?:\/|$)/)) {
    if (!paneRoute) return { type: 'not-found', path };
    try {
      const projectSlug = decodeURIComponent(paneRoute[1]).trim();
      const descriptorId = decodeURIComponent(paneRoute[2]).trim();
      const instanceId = decodeURIComponent(paneRoute[3]).trim();
      return projectSlug && descriptorId && instanceId
        ? { type: 'workspace-pane', projectSlug, descriptorId, instanceId }
        : { type: 'not-found', path };
    } catch {
      return { type: 'not-found', path };
    }
  }
  // A layout TAB is a path segment: `NavigationStore.setLayoutTab` navigates to
  // `/projects/<p>/layouts/<l>/<tabId>`, and the store's own pathname parse
  // reads that third segment back as `activeTab`. 4-HOME-012's rule is that
  // nothing may be silently DISCARDED — not that a third segment cannot exist —
  // so the tab is NAMED on the view here rather than dropped. Matching it
  // exactly (no fourth segment) keeps a genuinely malformed deep link a 404;
  // `panes` is matched above this point and never reaches here. A tab id this
  // layout no longer declares stays visible in the URL and `LayoutView` falls
  // back to the layout's first tab, which is the behaviour it already has for a
  // remembered-but-deleted tab.
  //
  // Without this, every tab in every layout — including every plugin-provided
  // one — navigated to "Page not found".
  const layoutRoute = path.match(
    /^\/projects\/([^/]+)\/layouts\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (layoutRoute) {
    const tab = layoutRoute[3];
    return {
      type: 'layout',
      projectSlug: layoutRoute[1],
      layoutSlug: layoutRoute[2],
      ...(tab ? { tab } : {}),
    };
  }
  // 4-HOME-012: EXACT, so `/projects/<slug>/<anything-else>` falls through to
  // the not-found below instead of silently rendering the project dashboard.
  // The old `startsWith('/projects/')` catch-all took the second segment and
  // discarded the rest, which directly contradicted the comment three lines
  // down — a stale or mistyped deep link looked like a working one. Every
  // real `/projects/...` route (new, edit, session-board, flow-console,
  // panes, layouts) is matched above this point; a trailing slash stays the
  // same route.
  const projectRoute = path.match(/^\/projects\/([^/]+)\/?$/);
  if (projectRoute?.[1]) {
    return { type: 'project', slug: projectRoute[1] };
  }

  // Empty path is the one root spelling outside the registry's canonical '/'.
  if (path === '') return { type: 'home' };

  // A non-root path that matched no route is a genuine 404. Previously these
  // silently redirected to the last project, hiding broken/stale deep links.
  return { type: 'not-found', path };
}

export function getPathForView(view: NavigationView): string | null {
  switch (view.type) {
    case 'home':
      return '/';
    case 'agents':
      return '/agents';
    case 'guidance':
      return `/guidance${view.selectedId ? `/${encodeURIComponent(view.selectedId)}` : ''}${view.tab ? `?tab=${view.tab}${view.filter ? `&filter=${view.filter}` : ''}` : ''}`;
    case 'plugins':
      return '/plugins';
    case 'registry':
      return view.tab ? `/registry/${view.tab}` : '/registry';
    case 'review-queue':
      return '/review-queue';
    case 'activity':
      return view.sessionId
        ? `/activity?session=${encodeURIComponent(view.sessionId)}${view.focus === 'evidence' ? '&focus=evidence' : ''}`
        : '/activity';
    case 'connections':
      return '/connections';
    case 'connections-providers':
      return '/connections/models';
    case 'connections-provider-edit':
      return `/connections/models/${view.id}`;
    case 'connections-engines':
      return '/connections/engines';
    case 'connections-runtime-edit':
      return `/connections/engines/${view.id}`;
    // Serializes to its own path (the legacy-redirect table canonicalises it
    // to /connections/engines at navigation time), so view↔path stays a
    // round trip: two views may not share one path.
    case 'connections-acp':
      return '/connections/acp';
    case 'connections-acp-new':
      return `/connections/engines/new/${encodeURIComponent(view.providerId)}`;
    case 'connections-tools':
      return '/connections/tools';
    case 'connections-tool-edit':
      return `/connections/tools/${view.id}`;
    case 'connections-knowledge':
      return '/connections/knowledge';
    case 'connections-computers':
      return '/connections/computers';
    case 'profile':
      return '/profile';
    case 'notifications':
      return '/notifications';
    case 'settings':
      return '/settings';
    case 'developer':
      return view.tab ? `/developer/${view.tab}` : '/developer';
    case 'schedule':
      return '/schedule';
    case 'agent-new':
      return '/agents/new';
    case 'agent-edit':
      return `/agents/${view.slug}`;
    case 'project-new':
      return '/projects/new';
    case 'task':
      return `/tasks/${encodeURIComponent(view.taskId)}`;
    case 'board':
      return view.reference.kind === 'task'
        ? `/board/task/${encodeURIComponent(view.reference.projectId)}/${encodeURIComponent(view.reference.id)}`
        : `/board/session/${encodeURIComponent(view.reference.id)}`;
    case 'project-edit':
      return `/projects/${view.slug}/edit`;
    case 'project':
      return `/projects/${view.slug}`;
    case 'project-session-board':
      return `/projects/${view.slug}/session-board`;
    case 'project-flow-console':
      return view.runId
        ? `/projects/${view.slug}/flow-console?run=${encodeURIComponent(view.runId)}`
        : `/projects/${view.slug}/flow-console`;
    case 'workspace-pane':
      return view.layoutSlug
        ? `/projects/${encodeURIComponent(view.projectSlug)}/layouts/${encodeURIComponent(view.layoutSlug)}/panes/${encodeURIComponent(view.descriptorId)}/${encodeURIComponent(view.instanceId)}`
        : `/projects/${encodeURIComponent(view.projectSlug)}/panes/${encodeURIComponent(view.descriptorId)}/${encodeURIComponent(view.instanceId)}`;
    case 'layout':
      return `/projects/${view.projectSlug}/layouts/${view.layoutSlug}${
        view.tab ? `/${view.tab}` : ''
      }`;
    default:
      return null;
  }
}

/** Returns Station's semantic parent, independent of browser arrival history. */
export function getParentView(view: NavigationView): NavigationView | null {
  switch (view.type) {
    case 'home':
      return null;
    case 'agent-edit':
    case 'agent-new':
      return { type: 'agents' };
    case 'connections-provider-edit':
      return { type: 'connections-providers' };
    case 'connections-runtime-edit':
      return { type: 'connections-engines' };
    case 'connections-tool-edit':
      return { type: 'connections-tools' };
    case 'connections-providers':
    case 'connections-engines':
    case 'connections-acp':
    case 'connections-tools':
    case 'connections-knowledge':
      return { type: 'connections' };
    case 'project-edit':
    case 'project-session-board':
    case 'project-flow-console':
      return { type: 'project', slug: view.slug };
    case 'workspace-pane':
      return view.layoutSlug
        ? {
            type: 'layout',
            projectSlug: view.projectSlug,
            layoutSlug: view.layoutSlug,
          }
        : { type: 'project', slug: view.projectSlug };
    case 'layout':
      return { type: 'project', slug: view.projectSlug };
    case 'task':
      return { type: 'home' };
    case 'activity':
      return view.sessionId ? { type: 'activity' } : { type: 'home' };
    case 'registry':
      return view.tab ? { type: 'registry' } : { type: 'home' };
    default:
      return { type: 'home' };
  }
}

export type ManagementNavigationGroup = ManagementSurfaceId;

export function getManagementNavigationGroup(
  view: NavigationView,
): ManagementNavigationGroup | null {
  const surface = APP_SURFACE_REGISTRY.getSurfaceForView(view);
  return surface?.managementGroup ?? null;
}

export function getPathForManagementNavigationGroup(
  group: ManagementNavigationGroup,
): string {
  return APP_SURFACE_REGISTRY.get(group)?.route ?? '/';
}
