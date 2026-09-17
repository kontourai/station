import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type { NavigationView } from '../types';

export type ManagementDestinationId =
  | 'agents'
  | 'guidance'
  | 'registry'
  | 'connections'
  | 'plugins'
  | 'activity'
  | 'developer'
  | 'notifications'
  | 'schedule';
/**
 * #2144 slice 4: which Settings navigation group a nav-only entry sits in.
 *
 * These are IDs, not the words on screen. The group headings ("Set up",
 * "Control", "This Station") are presentation and belong to `SettingsView`,
 * which is free to retitle them without this file — and without any settings
 * section id — moving.
 */
export type SettingsNavGroupId = 'set-up' | 'control' | 'this-station';

export type DestinationIconId =
  | 'agents'
  | 'connections'
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
  /** When set, the palette calls `showSurface(regionSurface)` and `params` are not applied. */
  regionSurface?: string;
  /**
   * A row in the left panel. #2059 (design record D3): the panel lists PLACES
   * only, so this is a flat ordered list with no sections left to order — the
   * `Customize`/`System` disclosure groups and the `primary` band they sat
   * under are gone, and with them the section-order table that existed because
   * `localeCompare` had sorted the top-level band into the middle.
   */
  sidebar?: { order: number };
  /**
   * #2144 slice 4: a NAV-ONLY row in the Settings section navigation. It looks
   * like a settings section in the sidebar and behaves like a link: choosing it
   * leaves `/settings` for this destination's own surface. It is not a settings
   * section, so it has no `SettingsSectionId`, no catalog rows, and no entry in
   * `ALL_SETTINGS_VIEWS`.
   *
   * `label` and `route` OVERRIDE the destination's own for this one surface, so
   * a hub can be entered at the tab a reader actually wants (Connections is
   * listed as "Engines & Models" and opens `/connections/engines`) without
   * minting a second destination for a surface that already has one. Both are
   * plain data: nothing here may import the settings catalog or a hub module.
   */
  settingsNav?: {
    group: SettingsNavGroupId;
    order: number;
    label?: string;
    route?: string;
  };
  palette?: { order: number; params?: Readonly<Record<string, string | null>> };
  /** Stable semantic owner used by sidebar selection and management routing. */
  managementGroup?: ManagementDestinationId;
  managementViewTypes?: readonly NavigationView['type'][];
  badge?: (context: DestinationBadgeContext) => DestinationBadge | null;
  /** Exact root route projection. Parameterized child routes stay with their domain parser. */
  view?: NavigationView;
}

/**
 * One nav-only Settings row, with its label and route already RESOLVED against
 * the destination's own. The override lives in exactly one place this way: a
 * consumer reading `entry.route` cannot forget that Connections is entered at
 * its Engines tab here, which is the way a second reader of an overridden
 * value eventually disagrees with the first.
 */
export interface SettingsNavEntry {
  id: string;
  group: SettingsNavGroupId;
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
  /**
   * The nav-only Settings rows, each carrying the group it belongs to and
   * ordered by `order`. Ordering is meaningful WITHIN a group; grouping them,
   * and placing each group against this page's own sections, is the
   * navigation's job. Flags apply exactly as they do everywhere else, so
   * Developer appears here only while developer tools are enabled on this
   * device.
   */
  getSettingsNav(
    enabledPreviewFlags?: ReadonlySet<string>,
  ): readonly SettingsNavEntry[];
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
        settingsNav: definition.settingsNav
          ? Object.freeze({ ...definition.settingsNav })
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
  const settingsNavSlots = new Set<string>();
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
    if (definition.settingsNav) {
      // Same composition rule the panel/Manage split already carries: a
      // destination is a PLACE in the left panel or a nav-only Settings row,
      // never both, so one surface cannot advertise itself twice.
      if (definition.sidebar) {
        throw new Error(
          `Destination ${definition.id} is both a panel place and a Settings nav entry`,
        );
      }
      // `hiddenFromNav` and `settingsNav` compose to nothing: the pair
      // declares a Settings row and then withholds it, leaving the surface
      // advertised nowhere with no error to read.
      if (definition.hiddenFromNav) {
        throw new Error(
          `Destination ${definition.id} cannot be hidden from nav and a Settings nav entry`,
        );
      }
      const navRoute = definition.settingsNav.route;
      if (navRoute !== undefined && !navRoute.startsWith('/')) {
        throw new Error(
          `Destination ${definition.id} must use an absolute Station route for its Settings nav entry`,
        );
      }
      // Order is unique WITHIN a group; two groups may both have a row 10.
      const slot = `${definition.settingsNav.group}:${definition.settingsNav.order}`;
      if (settingsNavSlots.has(slot)) {
        throw new Error(`Duplicate Settings nav destination order: ${slot}`);
      }
      settingsNavSlots.add(slot);
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
    getSettingsNav: (flags = defaultFlags) =>
      Object.freeze(
        advertised(flags)
          .filter((definition) => definition.settingsNav)
          .map((definition) =>
            Object.freeze({
              id: definition.id,
              group: definition.settingsNav!.group,
              order: definition.settingsNav!.order,
              label: definition.settingsNav!.label ?? definition.label(),
              route: definition.settingsNav!.route ?? definition.route,
            }),
          )
          // `order` only. It is a total order WITHIN a group — the composer
          // refuses two entries in one `group:order` slot — and that is all
          // this projection promises, because sequencing the groups against
          // each other and against the settings sections is the navigation's
          // decision: `settingsSectionNavItems` partitions these rows by
          // `group` and interleaves each partition with the sections of the
          // same group. A list here that also claimed a group sequence would
          // have to agree with that one, and nothing could check that it did.
          .sort((left, right) => left.order - right.order),
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
    // #2059 (D3): configuration is reached through the gear and the palette.
    // RT-13 had promoted Agents to a top-level panel row because it was two
    // clicks deep behind a collapsed group labelled with a verb ("Customize");
    // the fix was that the panel carries no configuration rows at all. #2144
    // slice 4 finished it: within Settings these are rows in its own section
    // navigation, not a separate Manage grid below the fold.
    settingsNav: { group: 'set-up', order: 10 },
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
    settingsNav: { group: 'set-up', order: 20 },
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
    // Entered at its Engines tab and named for what a reader is looking for.
    // `/connections` itself is a resolver frame that immediately picks a
    // section, so listing the hub root put a reader one redirect from the
    // place the row is about.
    settingsNav: {
      group: 'set-up',
      order: 30,
      label: 'Engines & Models',
      route: '/connections/engines',
    },
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
    managementGroup: 'registry',
    palette: { order: 40 },
    managementViewTypes: ['registry'],
    view: { type: 'registry' },
  },
  {
    id: 'plugins',
    route: '/plugins',
    label: () => 'Plugins',
    keywords: ['plugins'],
    icon: 'plugins',
    // #2144 decision 4: Registry FOLDS in here. Browsing the catalogue and
    // managing what it installed are one errand, so Settings offers one row
    // for it; /registry keeps its route, its palette entry and its keywords.
    settingsNav: { group: 'set-up', order: 40 },
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
    route: '/schedule',
    label: () => 'Schedule',
    keywords: ['schedule', 'cron', 'jobs', 'boo'],
    icon: 'schedule',
    settingsNav: { group: 'set-up', order: 50 },
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
    // #2059 (D3): Home and Activity are the panel's two places, and Activity
    // is the only one with a row here — Home is `hiddenFromNav` and
    // `ProjectSidebar` renders it directly.
    sidebar: { order: 10 },
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
    // The device flag gates ADVERTISEMENT only, here exactly as it gated the
    // Manage entry and the panel row before it: /developer stays deep-linkable
    // whether or not this row is offered.
    settingsNav: { group: 'this-station', order: 10 },
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
    // archive#3313 (Settings IA, option A): Feature Previews and always-on
    // Developer folded into this one surface. #2059 (D3): it is the panel
    // footer's gear now rather than a row — and the way every destination in
    // the Manage group is reached.
    id: 'settings',
    route: '/settings',
    label: () => 'Settings',
    keywords: ['settings', 'preferences', 'config'],
    icon: 'settings',
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
