import type { NavigationView } from '../types';

type ManagementDestinationId =
  | 'agents'
  | 'guidance'
  | 'registry'
  | 'customize'
  | 'plugins'
  | 'developer'
  | 'notifications'
  | 'schedule';
/**
 * The Customize page's groups, in the order the page lists them. Their words
 * live with the page (`views/customize/`), which loads on demand.
 */
export const CUSTOMIZE_NAV_GROUP_ORDER = [
  'your-agents',
  'run-on',
  'can-reach',
] as const;

export type CustomizeNavGroupId = (typeof CUSTOMIZE_NAV_GROUP_ORDER)[number];

export type DestinationIconId =
  | 'agents'
  | 'appearance'
  | 'customize'
  | 'developer'
  | 'guidance'
  | 'notifications'
  | 'plugins'
  | 'registry'
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

interface DestinationBadgeContext {
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
  /** When set, the palette and the sidebar row open that surface as the page (`useShowSurfacePage`) and `params` are not applied. */
  regionSurface?: string;
  /**
   * A row in the left panel. #2059 (design record D3): the panel lists PLACES
   * only, so this is a flat ordered list with no sections left to order — the
   * `Customize`/`System` disclosure groups and the `primary` band they sat
   * under are gone, and with them the section-order table that existed because
   * `localeCompare` had sorted the top-level band into the middle.
   */
  sidebar?: { order: number };
  /** An item in the Customize page's list. Overrides select the destination's entry tab. */
  customizeNav?: {
    group: CustomizeNavGroupId;
    order: number;
    label?: string;
    route?: string;
  };
  palette?: {
    order: number;
    params?: Readonly<Record<string, string | null>>;
    /** One plain line under the row, for a destination its name does not explain. */
    detail?: string;
  };
  /** Stable semantic owner used by sidebar selection and management routing. */
  managementGroup?: ManagementDestinationId;
  managementViewTypes?: readonly NavigationView['type'][];
  badge?: (context: DestinationBadgeContext) => DestinationBadge | null;
  /** Exact root route projection. Parameterized child routes stay with their domain parser. */
  view?: NavigationView;
}

/** A resolved item in the Customize page's list. */
export interface CustomizeNavEntry {
  id: string;
  group: CustomizeNavGroupId;
  order: number;
  label: string;
  route: string;
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
  /** Resolved Customize items, in group then item order, filtered by the same live flags as other navigation. */
  getCustomizeNav(
    enabledPreviewFlags?: ReadonlySet<string>,
  ): readonly CustomizeNavEntry[];
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
        customizeNav: definition.customizeNav
          ? Object.freeze({ ...definition.customizeNav })
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
  const sidebarSlots = new Set<number>();
  const customizeNavSlots = new Set<string>();
  const paletteSlots = new Set<number>();
  for (const definition of registered) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate destination id: ${definition.id}`);
    }
    byId.set(definition.id, definition);
    if (definition.sidebar) {
      if (sidebarSlots.has(definition.sidebar.order)) {
        throw new Error(
          `Duplicate sidebar destination order: ${definition.sidebar.order}`,
        );
      }
      sidebarSlots.add(definition.sidebar.order);
    }
    if (definition.customizeNav) {
      // Same composition rule the panel/Manage split already carries: a
      // destination is a PLACE in the left panel or a Customize entry,
      // never both, so one surface cannot advertise itself twice.
      if (definition.sidebar) {
        throw new Error(
          `Destination ${definition.id} is both a panel place and a Customize nav entry`,
        );
      }
      // `hiddenFromNav` and `customizeNav` compose to nothing: the pair
      // declares a Customize entry and then withholds it, leaving the surface
      // advertised nowhere with no error to read.
      if (definition.hiddenFromNav) {
        throw new Error(
          `Destination ${definition.id} cannot be hidden from nav and a Customize nav entry`,
        );
      }
      const navRoute = definition.customizeNav.route;
      if (navRoute !== undefined && !navRoute.startsWith('/')) {
        throw new Error(
          `Destination ${definition.id} must use an absolute Station route for its Customize nav entry`,
        );
      }
      // Order is unique WITHIN a group; two groups may both have a row 10.
      const slot = `${definition.customizeNav.group}:${definition.customizeNav.order}`;
      if (customizeNavSlots.has(slot)) {
        throw new Error(`Duplicate Customize nav destination order: ${slot}`);
      }
      customizeNavSlots.add(slot);
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
          .sort((left, right) => left.sidebar!.order - right.sidebar!.order),
      ),
    getCustomizeNav: (flags = defaultFlags) =>
      Object.freeze(
        advertised(flags)
          .filter((definition) => definition.customizeNav)
          .map((definition) =>
            Object.freeze({
              id: definition.id,
              group: definition.customizeNav!.group,
              order: definition.customizeNav!.order,
              label: definition.customizeNav!.label ?? definition.label(),
              route: definition.customizeNav!.route ?? definition.route,
            }),
          )
          // Order slots are unique within each group, so group then order is total.
          .sort(
            (left, right) =>
              CUSTOMIZE_NAV_GROUP_ORDER.indexOf(left.group) -
                CUSTOMIZE_NAV_GROUP_ORDER.indexOf(right.group) ||
              left.order - right.order,
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
    customizeNav: { group: 'your-agents', order: 10 },
    managementGroup: 'agents',
    palette: { order: 10 },
    managementViewTypes: ['agents', 'agent-new', 'agent-edit'],
    view: { type: 'agents' },
  },
  {
    id: 'guidance',
    route: '/guidance',
    // #2144 slice 4: the surface is called Skills. The id, the route and the
    // `guidance` view member are unchanged — this is the LABEL a reader sees,
    // and the retired word survives as a keyword so ⌘K still answers it.
    label: () => 'Skills',
    keywords: ['guidance', 'skills', 'commands', 'playbooks', 'prompts'],
    icon: 'guidance',
    // Straight to the tab the page would add, so opening Skills is one
    // history entry and Back leaves it.
    customizeNav: {
      group: 'your-agents',
      order: 20,
      route: '/guidance?tab=skills',
    },
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
    // Connections is no longer a destination: its parts are the items below,
    // and this page lists them. Its old words stay as keywords so ⌘K still
    // answers someone who learned them. Item keywords drop only words the
    // label already matches; the palette test pins the rest.
    id: 'customize',
    route: '/customize',
    label: () => 'Customize',
    keywords: ['connections', 'set up', 'providers', 'models', 'integrations'],
    icon: 'customize',
    managementGroup: 'customize',
    palette: { order: 50 },
    managementViewTypes: ['customize'],
    view: { type: 'customize' },
  },
  {
    id: 'engines',
    route: '/customize/engines',
    label: () => 'Engines',
    keywords: ['claude code', 'codex', 'acp'],
    customizeNav: { group: 'run-on', order: 10 },
    managementGroup: 'customize',
    palette: { order: 51 },
    managementViewTypes: [
      'connections-engines',
      'connections-engine-edit',
      'connections-engine-new',
    ],
  },
  {
    id: 'providers',
    route: '/customize/providers',
    label: () => 'Providers',
    keywords: ['models', 'api keys'],
    customizeNav: { group: 'run-on', order: 20 },
    managementGroup: 'customize',
    palette: { order: 52 },
    managementViewTypes: ['connections-models', 'connections-model-edit'],
  },
  {
    id: 'tools',
    route: '/customize/tools',
    label: () => 'Tools',
    keywords: ['tool servers', 'mcp', 'integrations'],
    customizeNav: { group: 'can-reach', order: 10 },
    managementGroup: 'customize',
    palette: { order: 53 },
    managementViewTypes: ['connections-tools', 'connections-tool-edit'],
  },
  {
    id: 'knowledge',
    route: '/customize/knowledge',
    label: () => 'Knowledge',
    keywords: ['search', 'embeddings'],
    customizeNav: { group: 'can-reach', order: 20 },
    managementGroup: 'customize',
    palette: { order: 54 },
    managementViewTypes: ['connections-knowledge'],
  },
  {
    // Not a Customize item: devices move to the Station page. Until then the
    // palette and the Customize landing are its doors.
    id: 'computers',
    route: '/connections/computers',
    label: () => 'Computers',
    keywords: ['devices', 'ssh'],
    hiddenFromNav: true,
    palette: { order: 56 },
    managementViewTypes: ['connections-computers'],
  },
  {
    id: 'registry',
    // Bare /registry redirects to Apps › Discover (`getLegacyPathRedirect`),
    // so the remaining catalogue opens on its first tab.
    route: '/registry/agents',
    label: () => 'Registry',
    keywords: ['registry', 'browse', 'install'],
    icon: 'registry',
    managementGroup: 'registry',
    managementViewTypes: ['registry'],
    view: { type: 'registry', tab: 'agents' },
  },
  {
    id: 'plugins',
    route: '/apps',
    label: () => 'Apps',
    keywords: ['apps', 'discover', 'library', 'plugins'],
    icon: 'plugins',
    // Apps is not a Customize item. Until it has a sidebar row, the palette,
    // the links that point here and the redirects from `/plugins` and
    // `/registry` are its doors.
    managementGroup: 'plugins',
    palette: { order: 60 },
    managementViewTypes: ['apps'],
    view: { type: 'apps', tab: 'discover' },
  },
  {
    id: 'notifications',
    route: '/notifications',
    label: () => 'Notifications',
    keywords: ['notifications', 'inbox', 'alerts', 'attention'],
    icon: 'notifications',
    // #2059 (D3): the panel footer's bell renders this destination and its
    // badge, so it takes no row of its own. `ProjectSidebarFooter` reads it by
    // id, the same way `HeaderActions` does.
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
    route: '/automations',
    label: () => 'Automations',
    keywords: ['automations', 'schedule', 'cron', 'jobs', 'check-backs', 'boo'],
    icon: 'schedule',
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
    // archive#3313: settings-gated ("Enable developer tools", a device
    // setting). The flag only gates sidebar/palette advertisement — the
    // /developer routes stay resolvable as deep links either way.
    id: 'developer',
    route: '/developer',
    label: () => 'Developer',
    keywords: ['developer', 'logs', 'system', 'telemetry'],
    icon: 'developer',
    previewFlag: DEVELOPER_TOOLS_FLAG,
    // The device flag gates ADVERTISEMENT only: /developer stays
    // deep-linkable whether or not the palette offers it.
    managementGroup: 'developer',
    palette: {
      order: 80,
      // #4407: "Developer" alone said nothing about what is there.
      detail: 'Logs, diagnostics and internals of this Station',
    },
    managementViewTypes: ['developer'],
    view: { type: 'developer' },
  },
  {
    // How Station looks: mode, color theme and accent. These rows used to be
    // Settings' Appearance section; Settings keeps a row for each that links
    // here, so its search, the palette's `settings:theme` and
    // `settings:accent-color` targets and old `highlight=` links still land.
    // Before Developer, which is gated and may not be offered at all.
    id: 'appearance',
    route: '/appearance',
    label: () => 'Appearance',
    keywords: [
      'appearance',
      'theme',
      'themes',
      'color',
      'colors',
      'dark',
      'light',
      'catppuccin',
      'accent',
      'palette',
    ],
    icon: 'appearance',
    palette: { order: 95 },
    managementViewTypes: ['appearance'],
    view: { type: 'appearance' },
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
    // archive#3313 (Settings IA, option A): Feature Previews and always-on
    // Developer folded into this one surface. #2059 (D3): it left the panel's
    // rows, and it is the way every destination in the Manage group is
    // reached. The footer's account menu ("Open settings") opens it.
    id: 'settings',
    route: '/settings',
    label: () => 'Settings',
    keywords: ['settings', 'preferences', 'config'],
    icon: 'settings',
    // The footer's account menu, ⌘, and the palette open it.
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
    // The id is the stable palette identity and stays as minted; the LABEL
    // and the section it opens follow #2182's rename. "Defaults" is not a
    // noun for a thing a person can go to, and the palette showed it as one.
    id: 'settings-defaults',
    route: '/settings',
    label: () => 'Settings: Agent runs',
    keywords: ['settings', 'defaults', 'agent runs', 'model', 'region'],
    hiddenFromNav: true,
    palette: {
      order: 120,
      params: { view: 'agent-runs', highlight: 'default-model' },
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

/**
 * Which Customize item a view belongs to: `customize` for the landing, the
 * item's destination id for a view one of its items hosts, or null for a
 * view outside Customize. The registry's Customize list is the only source.
 */
export function customizeItemForView(view: NavigationView): string | null {
  if (view.type === 'customize') return 'customize';
  const destination = APP_DESTINATION_REGISTRY.getDestinationForView(view);
  return destination?.customizeNav ? destination.id : null;
}
