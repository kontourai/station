import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type { NavigationView } from '../types';

/**
 * `primary` is a flat, always-visible band at the top of the sidebar — no
 * group toggle, nothing to expand. `customize` and `system` are the two
 * disclosure groups below it.
 */
export type DestinationSection = 'primary' | 'customize' | 'system';

/**
 * Sidebar section order. Explicit because the previous ordering was
 * `section.localeCompare(section)`, which put `customize` before `system` by
 * alphabetical accident — adding `primary` under that rule would have sorted
 * the top-level band into the MIDDLE ('customize' < 'primary' < 'system').
 */
export const DESTINATION_SECTION_ORDER: readonly DestinationSection[] = [
  'primary',
  'customize',
  'system',
];
export type ManagementDestinationId =
  | 'agents'
  | 'guidance'
  | 'registry'
  | 'review-queue'
  | 'connections'
  | 'plugins'
  | 'activity'
  | 'developer'
  | 'notifications'
  | 'schedule';
export type DestinationIconId =
  | 'agents'
  | 'connections'
  | 'developer'
  | 'guidance'
  | 'notifications'
  | 'plugins'
  | 'registry'
  | 'review'
  | 'schedule'
  | 'activity'
  | 'settings';

/**
 * archive#3313: gates the Developer destinations' sidebar/palette advertisement.
 * Unlike the other `previewFlag` values (server feature-preview ids), this
 * flag is derived from the device setting `developerToolsEnabled` — see
 * `useSurfaceVisibilityFlags`, which composes both sources into the one
 * enabled-flags set the registry filters on. Deep links are unaffected:
 * `resolveExactRoute`/`getDestinationForView` never consult flags.
 *
 * The `device:` prefix is what keeps those two sources from sharing a flat
 * namespace: server preview ids are bare slugs registered in-process
 * (`fleet-consumer-probes`), so an operator enabling a preview cannot
 * accidentally satisfy a device-scoped gate, whatever a future preview is
 * called. Pinned in `useSurfaceVisibilityFlags`'s tests.
 */
export const DEVELOPER_TOOLS_FLAG = 'device:developer-tools';

export interface DestinationBadgeContext {
  attentionCount: number;
}

export interface DestinationBadge {
  count: number;
  label: string;
}

export interface DestinationDefinition {
  id: string;
  route: string;
  label: () => string;
  keywords?: readonly string[];
  icon?: DestinationIconId;
  previewFlag?: string;
  hiddenFromNav?: boolean;
  /** When set, the palette calls `showSurface(regionSurface)` and `params` are not applied. */
  regionSurface?: string;
  sidebar?: { section: DestinationSection; order: number };
  palette?: { order: number; params?: Readonly<Record<string, string | null>> };
  /** Stable semantic owner used by sidebar selection and management routing. */
  managementGroup?: ManagementDestinationId;
  managementViewTypes?: readonly NavigationView['type'][];
  badge?: (context: DestinationBadgeContext) => DestinationBadge | null;
  /** Exact root route projection. Parameterized child routes stay with their domain parser. */
  view?: NavigationView;
}

export interface DestinationRegistry {
  get(id: string): DestinationDefinition | null;
  getRegistered(): readonly DestinationDefinition[];
  getAdvertised(
    enabledPreviewFlags?: ReadonlySet<string>,
  ): readonly DestinationDefinition[];
  getSidebar(
    enabledPreviewFlags?: ReadonlySet<string>,
  ): readonly DestinationDefinition[];
  getPalette(
    enabledPreviewFlags?: ReadonlySet<string>,
  ): readonly DestinationDefinition[];
  getDestinationForView(view: NavigationView): DestinationDefinition | null;
  resolveExactRoute(pathname: string): NavigationView | null;
}

/**
 * Compose one immutable destination inventory. Contributions are supplied at the
 * composition seam; callers never mutate a process-global registry after UI
 * construction.
 */
export function createDestinationRegistry(
  definitions: readonly DestinationDefinition[],
): DestinationRegistry {
  const registered = Object.freeze(
    definitions.map((definition) => {
      const id = definition.id.trim();
      const route = definition.route.trim();
      if (!id) throw new Error('Destination id must be nonempty');
      if (!route.startsWith('/')) {
        throw new Error(`Destination ${id} must use an absolute Station route`);
      }
      return Object.freeze({
        ...definition,
        id,
        route,
        keywords: definition.keywords
          ? Object.freeze([...definition.keywords])
          : undefined,
        sidebar: definition.sidebar
          ? Object.freeze({ ...definition.sidebar })
          : undefined,
        palette: definition.palette
          ? Object.freeze({
              ...definition.palette,
              params: definition.palette.params
                ? Object.freeze({ ...definition.palette.params })
                : undefined,
            })
          : undefined,
        managementViewTypes: definition.managementViewTypes
          ? Object.freeze([...definition.managementViewTypes])
          : undefined,
        view: definition.view
          ? (Object.freeze({ ...definition.view }) as NavigationView)
          : undefined,
      });
    }),
  );
  const byId = new Map<string, DestinationDefinition>();
  const byManagementView = new Map<
    NavigationView['type'],
    DestinationDefinition
  >();
  const byExactRoute = new Map<string, NavigationView>();
  const sidebarSlots = new Set<string>();
  const paletteSlots = new Set<number>();
  for (const definition of registered) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate destination id: ${definition.id}`);
    }
    byId.set(definition.id, definition);
    if (definition.sidebar) {
      const slot = `${definition.sidebar.section}:${definition.sidebar.order}`;
      if (sidebarSlots.has(slot)) {
        throw new Error(`Duplicate sidebar destination order: ${slot}`);
      }
      sidebarSlots.add(slot);
    }
    if (definition.palette) {
      if (paletteSlots.has(definition.palette.order)) {
        throw new Error(
          `Duplicate command-palette destination order: ${definition.palette.order}`,
        );
      }
      paletteSlots.add(definition.palette.order);
    }
    if (definition.view) {
      if (byExactRoute.has(definition.route)) {
        throw new Error(
          `Duplicate exact destination route: ${definition.route}`,
        );
      }
      byExactRoute.set(definition.route, definition.view);
    }
    for (const viewType of definition.managementViewTypes ?? []) {
      if (byManagementView.has(viewType)) {
        throw new Error(
          `Duplicate management destination for view: ${viewType}`,
        );
      }
      byManagementView.set(viewType, definition);
    }
  }
  const advertised = (flags: ReadonlySet<string>) =>
    Object.freeze(
      registered.filter(
        (definition) =>
          !definition.previewFlag || flags.has(definition.previewFlag),
      ),
    );
  const defaultFlags = new Set<string>();

  return Object.freeze({
    get: (id: string) => byId.get(id) ?? null,
    getRegistered: () => registered,
    getAdvertised: (flags = defaultFlags) => advertised(flags),
    getSidebar: (flags = defaultFlags) =>
      Object.freeze(
        advertised(flags)
          .filter(
            (definition) => definition.sidebar && !definition.hiddenFromNav,
          )
          .sort((left, right) =>
            left.sidebar!.section === right.sidebar!.section
              ? left.sidebar!.order - right.sidebar!.order
              : DESTINATION_SECTION_ORDER.indexOf(left.sidebar!.section) -
                DESTINATION_SECTION_ORDER.indexOf(right.sidebar!.section),
          ),
      ),
    getPalette: (flags = defaultFlags) =>
      Object.freeze(
        advertised(flags)
          .filter((definition) => definition.palette)
          .sort((left, right) => left.palette!.order - right.palette!.order),
      ),
    getDestinationForView: (view: NavigationView) =>
      byManagementView.get(view.type) ?? null,
    resolveExactRoute: (pathname: string) => byExactRoute.get(pathname) ?? null,
  });
}

const primary = (order: number) => ({ section: 'primary', order }) as const;
const customize = (order: number) => ({ section: 'customize', order }) as const;
const system = (order: number) => ({ section: 'system', order }) as const;

export const APP_DESTINATION_REGISTRY = createDestinationRegistry([
  {
    // #928 C2a: Home is a region surface whose only placement is `main`.
    // The palette's Home entry REVEALS it — `showSurface('home')` places it
    // in `main`, and the model navigates to `/` — rather than navigating to
    // `/` and showing whatever surface currently occupies `main`. `route`
    // and `view` stay: `/` still resolves to the home view, which is what
    // the outlet renders when `main` holds Home (or nothing).
    id: 'home',
    route: '/',
    regionSurface: 'home',
    label: () => 'Home',
    hiddenFromNav: true,
    managementViewTypes: ['home'],
    view: { type: 'home' },
  },
  {
    id: 'agents',
    route: '/agents',
    label: () => 'Agents',
    keywords: ['agents', 'manage'],
    icon: 'agents',
    // RT-13: the owner's #1 surface was two clicks deep behind a collapsed
    // group labelled with a verb ("Customize") that does not obviously
    // contain "my agents".
    sidebar: primary(10),
    managementGroup: 'agents',
    palette: { order: 10 },
    managementViewTypes: ['agents', 'agent-new', 'agent-edit'],
    view: { type: 'agents' },
  },
  {
    id: 'guidance',
    route: '/guidance',
    label: () => 'Guidance',
    keywords: ['guidance', 'skills', 'commands', 'playbooks', 'prompts'],
    icon: 'guidance',
    sidebar: customize(20),
    managementGroup: 'guidance',
    managementViewTypes: ['guidance'],
  },
  {
    id: 'guidance-commands',
    route: '/guidance',
    label: () => 'Commands',
    // The retired words stay as KEYWORDS, not as the label: someone who
    // learned "playbooks" must still find the surface that replaced it, while
    // reading the one noun that survives.
    keywords: ['commands', 'slash', 'playbooks', 'prompts', 'guidance'],
    hiddenFromNav: true,
    palette: { order: 20, params: { tab: 'commands' } },
  },
  {
    id: 'guidance-skills',
    route: '/guidance',
    label: () => 'Skills',
    keywords: ['skills', 'guidance'],
    hiddenFromNav: true,
    palette: { order: 30, params: { tab: 'skills' } },
  },
  {
    id: 'connections',
    route: '/connections',
    label: () => 'Connections',
    keywords: ['connections', 'providers', 'integrations'],
    icon: 'connections',
    // RT-13: promoted alongside Agents.
    sidebar: primary(20),
    managementGroup: 'connections',
    palette: { order: 50 },
    managementViewTypes: [
      'connections',
      'connections-models',
      'connections-model-edit',
      'connections-engines',
      'connections-engine-edit',
      'connections-engine-new',
      'connections-tools',
      'connections-tool-edit',
      'connections-knowledge',
    ],
    view: { type: 'connections' },
  },
  {
    id: 'registry',
    route: '/registry',
    label: () => 'Registry',
    keywords: ['registry', 'browse', 'install'],
    icon: 'registry',
    sidebar: customize(40),
    managementGroup: 'registry',
    palette: { order: 40 },
    managementViewTypes: ['registry'],
    view: { type: 'registry' },
  },
  {
    id: 'review-queue',
    route: '/review-queue',
    label: () => 'Review',
    icon: 'review',
    sidebar: system(10),
    managementGroup: 'review-queue',
    managementViewTypes: ['review-queue'],
    view: { type: 'review-queue' },
  },
  {
    id: 'plugins',
    route: '/plugins',
    label: () => 'Plugins',
    keywords: ['plugins'],
    icon: 'plugins',
    sidebar: system(20),
    managementGroup: 'plugins',
    palette: { order: 60 },
    managementViewTypes: ['plugins'],
    view: { type: 'plugins' },
  },
  {
    id: 'notifications',
    route: '/notifications',
    label: () => 'Notifications',
    keywords: ['notifications', 'inbox', 'alerts', 'attention'],
    icon: 'notifications',
    sidebar: system(30),
    // 6-OPS-32: a top-level destination that ⌘K could not reach — "notif"
    // returned zero results in a palette carrying 72 entries.
    palette: { order: 55 },
    managementGroup: 'notifications',
    managementViewTypes: ['notifications'],
    view: { type: 'notifications' },
    badge: ({ attentionCount }) =>
      attentionCount > 0
        ? {
            count: attentionCount,
            label: `${attentionCount} need attention`,
          }
        : null,
  },
  {
    id: 'schedule',
    route: '/schedule',
    label: () => 'Schedule',
    keywords: ['schedule', 'cron', 'jobs', 'boo'],
    icon: 'schedule',
    sidebar: system(40),
    managementGroup: 'schedule',
    palette: { order: 70 },
    managementViewTypes: ['schedule'],
    view: { type: 'schedule' },
  },
  {
    // archive#3313 (Settings IA, option A): Feature Previews is a Settings
    // section now, not a standalone surface. The old /feature-previews route
    // redirects in routing.ts (getLegacyPathRedirect); the palette entry
    // deep-links into the Settings section directly.
    id: 'feature-previews',
    route: '/settings',
    label: () => 'Feature Previews',
    keywords: ['feature previews', 'previews', 'experimental'],
    hiddenFromNav: true,
    palette: { order: 75, params: { view: 'feature-previews' } },
  },
  {
    // #928: Activity is a REGION surface — it has no standalone placement and
    // therefore no route of its own to resolve. `route` still has to be an
    // absolute Station path (the registry refuses anything else), and the one
    // honest value is the surface's canonical deep link: minted by the same
    // `activityDeepLink` builder the server-side producers use, it is where
    // `/activity` and `/sessions` now redirect and it really does open this
    // surface. `regionSurface` short-circuits both advertised entry points
    // (the palette and the sidebar row call `showSurface`), so the field is
    // only read when something asks this surface for a path — and what it
    // hands back has to be one that works.
    //
    // No `view`: `view` registers an EXACT route, and Activity no longer has
    // a view to register. (It would not resolve if it did — `byExactRoute` is
    // keyed on the raw route string and only ever looked up with a
    // query-stripped path, so this key could never match. A dead map entry,
    // not a resolving pathname.) No
    // `managementViewTypes` either, for the same reason the union no longer
    // has an `activity` member. `sessions` remains a palette keyword for
    // muscle memory.
    id: 'activity',
    route: activityDeepLink(),
    regionSurface: 'activity',
    label: () => 'Activity',
    keywords: ['activity', 'sessions', 'monitor', 'events'],
    icon: 'activity',
    // SHELL-08 / lane 7's open question, decided yes: Activity resolved but
    // had no sidebar entry, so its only advertised entry point was ⌘K.
    sidebar: primary(30),
    palette: { order: 65 },
    managementGroup: 'activity',
  },
  {
    // archive#3313: settings-gated ("Enable developer tools", a device
    // setting). The flag only gates sidebar/palette advertisement — the
    // /developer routes stay resolvable as deep links either way.
    id: 'developer',
    route: '/developer',
    label: () => 'Developer',
    keywords: ['developer', 'logs', 'system', 'telemetry'],
    icon: 'developer',
    previewFlag: DEVELOPER_TOOLS_FLAG,
    sidebar: system(60),
    managementGroup: 'developer',
    palette: { order: 80 },
    managementViewTypes: ['developer'],
    view: { type: 'developer' },
  },
  {
    // Monitoring is the Developer surface's telemetry tab — it advertises
    // and hides with the same flag (archive#3313).
    id: 'monitoring',
    route: '/developer/telemetry',
    label: () => 'Monitoring',
    keywords: ['monitoring', 'observability', 'metrics'],
    previewFlag: DEVELOPER_TOOLS_FLAG,
    hiddenFromNav: true,
    palette: { order: 90 },
  },
  {
    // archive#3313 (Settings IA, option A): Settings takes the System
    // sidebar slot Feature Previews and always-on Developer used to occupy.
    id: 'settings',
    route: '/settings',
    label: () => 'Settings',
    keywords: ['settings', 'preferences', 'config'],
    icon: 'settings',
    sidebar: system(50),
    palette: { order: 100 },
    managementViewTypes: ['settings'],
    view: { type: 'settings' },
  },
  {
    id: 'settings-station',
    route: '/settings',
    label: () => 'Settings: Station',
    keywords: ['settings', 'station', 'diagnostics', 'system', 'host'],
    hiddenFromNav: true,
    palette: {
      order: 110,
      params: { view: 'diagnostics', highlight: 'diagnostics-bundle' },
    },
  },
  {
    id: 'settings-defaults',
    route: '/settings',
    label: () => 'Settings: Defaults',
    keywords: ['settings', 'defaults', 'model', 'region'],
    hiddenFromNav: true,
    palette: {
      order: 120,
      params: { view: 'agent-defaults', highlight: 'default-model' },
    },
  },
  {
    id: 'settings-device',
    route: '/settings',
    label: () => 'Settings: This device',
    keywords: ['settings', 'device', 'appearance', 'theme', 'voice'],
    hiddenFromNav: true,
    palette: {
      order: 130,
      params: { view: 'appearance', highlight: 'theme' },
    },
  },
  {
    id: 'profile',
    route: '/profile',
    label: () => 'Profile',
    keywords: ['profile', 'account', 'me', 'avatar'],
    // 6-OPS-32: `hiddenFromNav` keeps it out of the sidebar; without a
    // `palette` key as well, the header avatar was its only entry point in
    // the entire app.
    palette: { order: 140 },
    hiddenFromNav: true,
    managementViewTypes: ['profile'],
    view: { type: 'profile' },
  },
] as const satisfies readonly DestinationDefinition[]);
