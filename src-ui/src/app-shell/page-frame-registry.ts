import type { PageFrameSpec } from '../components/page-frame';
import type { NavigationView } from '../types';
import { APP_SURFACE_REGISTRY } from './surface-registry';

/**
 * Which frame each route renders inside.
 *
 * This table is the reason the app has one page header instead of eight. It
 * is a `Record` over `NavigationView['type']`, so a route added to the union
 * without a decision here is a TYPE ERROR, not a silently bespoke page — the
 * gap SHELL-17 found in the six-file conformance ratchet, closed at the point
 * where routes are actually declared.
 *
 * `null` is a decision too, and every one is justified below. It means the
 * surface owns its whole viewport and a page header would be wrong, not that
 * nobody got to it.
 *
 * Where a spec omits `title`, the view publishes it with `usePageHeader`
 * because only the view can know it (a project's name, a tab remembered in
 * `sessionStorage`, the signed-in user). The frame still owns where that
 * title sits and how big it is — and `resolvePageFrame` still gives the route
 * a FALLBACK title for the window in which the view has not run yet (a cold
 * lazy chunk), so the header is never a blank line.
 */
/** Split-pane routes: header above, panes below, panes flush to the edges. */
const SPLIT_PANE: PageFrameSpec = { width: 'full', body: 'fill', flush: true };

const FRAMES: Record<NavigationView['type'], PageFrameSpec | null> = {
  // Home is the one intentional hero. Its is a prompt ("What do you want
  // to work on?"), not a page name, and a page header above it would title a
  // question. Documented exception, not an omission.
  home: null,

  agents: SPLIT_PANE,
  'agent-new': SPLIT_PANE,
  'agent-edit': SPLIT_PANE,

  // archive#4463: a top-level nav page gets
  // NO eyebrow — the prior pattern of an eyebrow restating the title in caps
  // (`GUIDANCE` over **Guidance**, and every top-level entry below before
  // this change) is retired as one of the audit's findings. The word is
  // already the page's own `<h1>`; repeating it one line above named nothing
  // an ancestor and duplicated the title instead.
  guidance: SPLIT_PANE,

  connections: {
    title: 'Connections',
    subtitle: 'Where work runs and what powers it',
    width: 'narrow',
  },
  'connections-providers': SPLIT_PANE,
  'connections-provider-edit': SPLIT_PANE,
  'connections-engines': SPLIT_PANE,
  'connections-runtime-edit': SPLIT_PANE,
  // The Engines section (CONNECTION_SECTIONS): the frame names the section,
  // so this default must agree with it rather than introduce a second title
  // for the same destination.
  //
  // The eyebrow is the PARENT only ('Connections'), not the retired
  // 'Connections / Engines' breadcrumb-as-eyebrow — the title already says
  // 'Engines' as its own `<h1>`. `ConnectionsSectionFrame` publishes the
  // live (linked) version of this once it mounts; this is only the brief
  // fallback shown before that chunk arrives. (#592 slice 2: the sibling
  // 'connections-acp' route this comment used to justify agreeing with is
  // retired — this is now the only frame naming Engines this way.)
  'connections-acp-new': {
    eyebrow: 'Connections',
    title: 'Engines',
    subtitle: 'Agent CLIs installed here, and custom engines you connected.',
    width: 'narrow',
  },
  'connections-tools': SPLIT_PANE,
  'connections-tool-edit': SPLIT_PANE,
  'connections-knowledge': {
    eyebrow: 'Connections',
    title: 'Knowledge',
    subtitle: 'The knowledge store and its attached namespaces.',
    width: 'narrow',
  },
  'connections-computers': SPLIT_PANE,

  plugins: SPLIT_PANE,
  registry: {
    title: 'Registry',
    width: 'full',
    body: 'fill',
  },
  'review-queue': SPLIT_PANE,
  activity: SPLIT_PANE,

  // 'Developer' is not self-referential here — the title is the active tab
  // ('Logs'/'System'/'Telemetry'/'Memory'/'Archive'), so the eyebrow is a
  // real parent, not a restated title. `DeveloperView` republishes it as a
  // link back to `/developer` once it mounts.
  developer: { eyebrow: 'Developer', width: 'full', body: 'fill' },
  schedule: {
    title: 'Schedule',
    subtitle: 'Manage scheduled jobs and automation',
    firstRunAnchor: 'schedule',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Station configuration for this device and account',
    width: 'narrow',
  },
  profile: {
    title: 'Profile',
    subtitle: 'Your account, usage, and achievements on this Station',
    width: 'narrow',
  },
  notifications: {
    title: 'Notifications',
    // states the page's model in its own subtitle, and the two regions
    // below are named for exactly these two halves.
    subtitle: 'Things that need you, and what happened.',
    width: 'narrow',
  },

  'project-session-board': { width: 'full', body: 'fill' },
  'project-flow-console': { width: 'full', body: 'fill' },

  // archive#4079: the board face is a workspace-like surface (its
  // own grid IS the content), not a management page — same shape as
  // `project`/`layout`/`workspace-pane` below.
  board: null,

  // An editor, not a management page: its header carries the unsaved badge
  // and the Save/Back pair that only exist while you are editing, and a page
  // header above that would be a second title over a surface that already
  // names its subject. It stays on `DetailHeader` deliberately; see
  // docs/design/shell-skeletons.md §2.2.
  'project-edit': null,

  // The project surfaces below are workspaces, not management pages. Each
  // one's own identity header IS its content (a project's avatar/name/path
  // row, a task's status header, a layout or pane rendering a plugin's
  // viewport edge-to-edge). Framing them would put a second title above a
  // surface that already answers "where am I" — and for panes and layouts,
  // steal viewport from a renderer that was handed the whole area.
  project: null,
  task: null,
  layout: null,
  'workspace-pane': null,

  // Not a page: a route-level overlay that renders its own dialog chrome.
  'project-new': null,

  // The error surface is the whole page here; `ErrorState` already carries a
  // title, a description and the recovery action.
  'not-found': null,
};

/**
 * Fallback titles for the two framed routes the sidebar has no surface for.
 *
 * Every other framed route resolves its fallback from `surface-registry.ts`
 * the SAME `label` the sidebar row and the command palette render, so the
 * word in the header while a chunk loads is by construction the word the user
 * just clicked. These two are reached from inside a project, not from the
 * sidebar, so there is no surface to derive from and the name is recorded
 * here. Both match what the view itself publishes once it mounts.
 */
const UNSURFACED_FALLBACK_TITLES: Partial<
  Record<NavigationView['type'], string>
> = {
  'project-session-board': 'Board',
  'project-flow-console': 'Flow console',
};

/**
 * `FRAMES` with every framed route's fallback title filled in, resolved once
 * at module load.
 *
 * Resolving here rather than per call keeps `resolvePageFrame` returning the
 * same object for the same route — it is called on every render of the shell,
 * and a fresh object each time would defeat every identity comparison
 * downstream of it.
 */
const RESOLVED_FRAMES = ((): Record<
  NavigationView['type'],
  PageFrameSpec | null
> => {
  const resolved = {} as Record<NavigationView['type'], PageFrameSpec | null>;
  for (const [type, spec] of Object.entries(FRAMES) as Array<
    [NavigationView['type'], PageFrameSpec | null]
  >) {
    if (!spec || spec.title !== undefined) {
      resolved[type] = spec;
      continue;
    }
    // `getSurfaceForView` reads `view.type` and nothing else (it is a lookup
    // in the registry's `managementViewTypes` index), so the type alone is
    // the whole input a fallback title can depend on.
    const surface = APP_SURFACE_REGISTRY.getSurfaceForView({
      type,
    } as NavigationView);
    const title = surface?.label() ?? UNSURFACED_FALLBACK_TITLES[type];
    resolved[type] = title ? { ...spec, title } : spec;
  }
  return resolved;
})();

export function resolvePageFrame(view: NavigationView): PageFrameSpec | null {
  return RESOLVED_FRAMES[view.type];
}
