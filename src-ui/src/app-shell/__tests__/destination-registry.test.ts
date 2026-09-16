import { describe, expect, test } from 'vitest';
import {
  APP_DESTINATION_REGISTRY,
  createDestinationRegistry,
  DEVELOPER_TOOLS_FLAG,
  type DestinationDefinition,
} from '../destination-registry';

describe('DestinationRegistry', () => {
  test('drives the exact panel and command-palette inventories from one authority', () => {
    // #2059 (design record D3): the left panel lists PLACES only. Activity is
    // the sole `sidebar` row — Home is `hiddenFromNav` and the panel renders
    // it directly, Notifications and Settings became the footer's bell and
    // gear, and the configuration destinations moved behind the gear.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().map(
        (destination) => destination.id,
      ),
    ).toEqual(['activity']);
    // The developer-tools flag must not put a row back in the panel: it
    // gates Developer's SETTINGS entry now.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (destination) => destination.id,
      ),
    ).toEqual(['activity']);
    expect(
      APP_DESTINATION_REGISTRY.getPalette().map(
        (destination) => destination.id,
      ),
    ).toEqual([
      'agents',
      'guidance-commands',
      'guidance-skills',
      'registry',
      'connections',
      // 6-OPS-32: Notifications and Profile are top-level destinations that
      // ⌘K could not reach at all — "notif" and "prof" each returned zero
      // results in a palette carrying 72 entries.
      'notifications',
      'plugins',
      'activity',
      'schedule',
      'feature-previews',
      'settings',
      'settings-station',
      'settings-defaults',
      'settings-device',
      'profile',
    ]);
    expect(
      APP_DESTINATION_REGISTRY.getPalette(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (destination) => destination.id,
      ),
    ).toEqual([
      'agents',
      'guidance-commands',
      'guidance-skills',
      'registry',
      'connections',
      'notifications',
      'plugins',
      'activity',
      'schedule',
      'feature-previews',
      'developer',
      'monitoring',
      'settings',
      'settings-station',
      'settings-defaults',
      'settings-device',
      'profile',
    ]);
  });

  // #2059 acceptance: "Every removed destination remains reachable from the
  // palette and from a Settings entry point." This is the palette half. It
  // asserts the ROUTE, not the id, because the Skills page reaches the palette
  // under two entries of its own (`Commands` and `Skills`) rather than its own
  // id — an id-keyed check would have called it unreachable.
  test('every destination behind the gear is also reachable from the palette', () => {
    const flags = new Set([DEVELOPER_TOOLS_FLAG]);
    const paletteRoutes = new Set(
      APP_DESTINATION_REGISTRY.getPalette(flags).map(
        (destination) => destination.route,
      ),
    );
    for (const entry of APP_DESTINATION_REGISTRY.getSettingsNav(flags)) {
      const destination = APP_DESTINATION_REGISTRY.get(entry.id);
      expect(
        paletteRoutes,
        `${entry.id} left the panel with no palette entry for ${destination?.route}`,
      ).toContain(destination?.route);
    }
  });

  // #2144 slice 4 deleted the Manage grid. This is the other half of the same
  // acceptance: every destination that grid used to list must still have a
  // Settings entry point. The inventory is LITERAL, taken from the grid's own
  // retired test, because deriving it from `getSettingsNav()` would compare
  // the projection with itself and pass however it changed — which is exactly
  // how a surface disappears from the panel AND from the group that was
  // supposed to hold what left it.
  test('every destination the retired Manage grid listed is still reachable from Settings', () => {
    const flags = new Set([DEVELOPER_TOOLS_FLAG]);
    const settingsRoutes = new Set(
      APP_DESTINATION_REGISTRY.getSettingsNav(flags).map(
        (entry) => entry.route,
      ),
    );
    const formerManageRoutes = [
      ['agents', '/agents'],
      ['guidance', '/guidance'],
      // Entered at the section the row names, not the hub root.
      ['connections', '/connections/engines'],
      ['plugins', '/plugins'],
      ['schedule', '/schedule'],
      ['developer', '/developer'],
    ] as const;
    for (const [id, route] of formerManageRoutes) {
      expect(
        settingsRoutes,
        `${id} left the Manage grid with no Settings nav row for ${route}`,
      ).toContain(route);
    }
    // Registry is the one FOLD (#2144 decision 4): it has no row of its own,
    // so its reachability rests on the Plugins surface carrying a step to the
    // catalogue. Asserted here as the fold's precondition — that Plugins IS
    // listed — and end to end in tests/registry.spec.ts, which presses through
    // Plugins to /registry. Without the fold named, a Registry row silently
    // vanishing would read as this list simply being shorter.
    expect(settingsRoutes).not.toContain('/registry');
    expect(settingsRoutes).toContain('/plugins');
  });

  // #2144 slice 4: the Settings navigation's nav-only rows. A literal
  // inventory, not a re-read of `getSettingsNav()` — comparing the projection
  // against itself would pass however it changed, including a destination
  // silently losing the only entry point it has left.
  test('projects the Settings nav-only rows with their overrides resolved', () => {
    expect(APP_DESTINATION_REGISTRY.getSettingsNav()).toEqual([
      {
        id: 'agents',
        group: 'set-up',
        order: 10,
        label: 'Agents',
        route: '/agents',
      },
      {
        id: 'guidance',
        group: 'set-up',
        order: 20,
        label: 'Skills',
        route: '/guidance',
      },
      {
        id: 'connections',
        group: 'set-up',
        order: 30,
        // The whole point of the override: the LABEL is not the destination's
        // own ('Connections') and the ROUTE is not its root ('/connections').
        label: 'Engines & Models',
        route: '/connections/engines',
      },
      {
        id: 'plugins',
        group: 'set-up',
        order: 40,
        label: 'Plugins',
        route: '/plugins',
      },
      {
        id: 'schedule',
        group: 'set-up',
        order: 50,
        label: 'Schedule',
        route: '/schedule',
      },
    ]);
    // Registry is deliberately absent: #2144 decision 4 folds it into Plugins,
    // and it keeps its route, its palette entry and its keywords.
    expect(
      APP_DESTINATION_REGISTRY.getSettingsNav().map((entry) => entry.id),
    ).not.toContain('registry');
  });

  test('offers Developer as a Settings nav row only while developer tools are enabled', () => {
    // archive#3313: the flag gates ADVERTISEMENT. /developer stays
    // deep-linkable either way, which is why this is a row-level assertion and
    // not a claim about routing.
    expect(
      APP_DESTINATION_REGISTRY.getSettingsNav().map((entry) => entry.id),
    ).not.toContain('developer');
    expect(
      APP_DESTINATION_REGISTRY.getSettingsNav(
        new Set([DEVELOPER_TOOLS_FLAG]),
      ).find((entry) => entry.id === 'developer'),
    ).toEqual({
      id: 'developer',
      group: 'this-station',
      order: 10,
      label: 'Developer',
      route: '/developer',
    });
  });

  test('refuses a destination that is both a panel place and a Settings nav entry', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'both',
          route: '/both',
          label: () => 'Both',
          sidebar: { order: 1 },
          settingsNav: { group: 'set-up', order: 1 },
        },
      ]),
    ).toThrow(/both a panel place and a Settings nav entry/);
  });

  test('refuses a Settings nav entry that is also hidden from nav', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'hidden',
          route: '/hidden',
          label: () => 'Hidden',
          hiddenFromNav: true,
          settingsNav: { group: 'set-up', order: 1 },
        },
      ]),
    ).toThrow(/cannot be hidden from nav and a Settings nav entry/);
  });

  test('refuses a relative Settings nav route override', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'relative',
          route: '/relative',
          label: () => 'Relative',
          settingsNav: { group: 'set-up', order: 1, route: 'engines' },
        },
      ]),
    ).toThrow(/absolute Station route for its Settings nav entry/);
  });

  test('orders a group by `order`, not by declaration order', () => {
    // The only ordering `getSettingsNav` promises, and the only one its
    // consumer uses: `settingsSectionNavItems` partitions these rows by group,
    // so what has to be right is the sequence WITHIN a group. Declared
    // backwards on purpose — the real inventory happens to declare its rows
    // in `order` sequence, so against it a sort that did nothing at all would
    // pass.
    const registry = createDestinationRegistry([
      {
        id: 'second',
        route: '/second',
        label: () => 'Second',
        settingsNav: { group: 'set-up', order: 20 },
      },
      {
        id: 'first',
        route: '/first',
        label: () => 'First',
        settingsNav: { group: 'set-up', order: 10 },
      },
    ]);
    expect(registry.getSettingsNav().map((entry) => entry.id)).toEqual([
      'first',
      'second',
    ]);
  });

  test('refuses two Settings nav entries in one slot, but not across groups', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'one',
          route: '/one',
          label: () => 'One',
          settingsNav: { group: 'set-up', order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: () => 'Two',
          settingsNav: { group: 'set-up', order: 1 },
        },
      ]),
    ).toThrow(/Duplicate Settings nav destination order: set-up:1/);
    // Order is unique within a group, not globally: two groups may each have a
    // first row, and refusing that would make the orders one shared sequence.
    expect(() =>
      createDestinationRegistry([
        {
          id: 'one',
          route: '/one',
          label: () => 'One',
          settingsNav: { group: 'set-up', order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: () => 'Two',
          settingsNav: { group: 'this-station', order: 1 },
        },
      ]),
    ).not.toThrow();
  });

  test('keeps registered preview surfaces wired while advertising only enabled ones', () => {
    const preview: DestinationDefinition = {
      id: 'preview',
      route: '/preview',
      label: () => 'Preview',
      previewFlag: 'preview-surface',
      hiddenFromNav: true,
      palette: { order: 1 },
    };
    const registry = createDestinationRegistry([preview]);

    expect(registry.getRegistered()).toHaveLength(1);
    expect(registry.getAdvertised()).toEqual([]);
    expect(
      registry
        .getAdvertised(new Set(['preview-surface']))
        .map((entry) => entry.id),
    ).toEqual(['preview']);
  });

  test('resolves labels and badges at projection time', () => {
    const notifications = APP_DESTINATION_REGISTRY.get('notifications');
    expect(notifications?.label()).toBe('Notifications');
    expect(notifications?.badge?.({ attentionCount: 0 })).toBeNull();
    expect(notifications?.badge?.({ attentionCount: 3 })).toEqual({
      count: 3,
      label: '3 need attention',
    });
  });

  test('does not resolve render-time labels during composition or projection', () => {
    let labelCalls = 0;
    const registry = createDestinationRegistry([
      {
        id: 'late-label',
        route: '/late-label',
        label: () => {
          labelCalls += 1;
          return 'Localized later';
        },
        sidebar: { order: 1 },
      },
    ]);

    expect(labelCalls).toBe(0);
    const [destination] = registry.getSidebar();
    expect(labelCalls).toBe(0);
    expect(destination?.label()).toBe('Localized later');
    expect(labelCalls).toBe(1);
  });

  test('owns exact root routing and semantic management grouping', () => {
    expect(APP_DESTINATION_REGISTRY.resolveExactRoute('/schedule')).toEqual({
      type: 'schedule',
    });
    expect(
      APP_DESTINATION_REGISTRY.getDestinationForView({
        type: 'connections-model-edit',
        id: 'ollama',
      })?.id,
    ).toBe('connections');
  });

  test('returns frozen definitions and projections from immutable composition', () => {
    const registry = createDestinationRegistry([
      {
        id: 'one',
        route: '/one',
        label: () => 'One',
        keywords: ['first'],
        sidebar: { order: 1 },
        palette: { order: 1, params: { tab: 'one' } },
      },
      {
        id: 'two',
        route: '/two',
        label: () => 'Two',
        settingsNav: { group: 'set-up', order: 1 },
      },
    ]);
    const [definition, navDefinition] = registry.getRegistered();

    expect(Object.isFrozen(registry.getRegistered())).toBe(true);
    expect(Object.isFrozen(registry.getSidebar())).toBe(true);
    expect(Object.isFrozen(registry.getPalette())).toBe(true);
    expect(Object.isFrozen(registry.getSettingsNav())).toBe(true);
    expect(Object.isFrozen(registry.getSettingsNav()[0])).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.keywords)).toBe(true);
    expect(Object.isFrozen(definition?.sidebar)).toBe(true);
    expect(Object.isFrozen(definition?.palette?.params)).toBe(true);
    expect(Object.isFrozen(navDefinition?.settingsNav)).toBe(true);
  });

  test.each([
    [
      'duplicate ids',
      [
        { id: 'same', route: '/one', label: () => 'One' },
        { id: 'same', route: '/two', label: () => 'Two' },
      ],
      /Duplicate destination id/,
    ],
    [
      'relative routes',
      [{ id: 'bad', route: 'relative', label: () => 'Bad' }],
      /absolute Station route/,
    ],
    [
      'duplicate exact routes',
      [
        {
          id: 'one',
          route: '/same',
          label: (): string => 'One',
          view: { type: 'home' },
        },
        {
          id: 'two',
          route: '/same',
          label: (): string => 'Two',
          view: { type: 'settings' },
        },
      ],
      /Duplicate exact destination route/,
    ],
    [
      'duplicate sidebar order slots',
      [
        {
          id: 'one',
          route: '/one',
          label: (): string => 'One',
          sidebar: { section: 'system', order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: (): string => 'Two',
          sidebar: { section: 'system', order: 1 },
        },
      ],
      /Duplicate sidebar destination order/,
    ],
    [
      'duplicate command-palette order slots',
      [
        {
          id: 'one',
          route: '/one',
          label: (): string => 'One',
          palette: { order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: (): string => 'Two',
          palette: { order: 1 },
        },
      ],
      /Duplicate command-palette destination order/,
    ],
  ] as const)(
    'rejects %s at the composition seam',
    (_label, entries, error) => {
      expect(() => createDestinationRegistry(entries)).toThrow(error);
    },
  );

  // Playbooks are Skills. The palette entry that named the retired concept is
  // gone; the one that replaced it keeps the retired words as KEYWORDS, so
  // someone who learned "playbooks" still finds the surface while reading the
  // one noun that survives.
  test('the retired Playbooks palette entry is replaced by Commands', () => {
    const palette = APP_DESTINATION_REGISTRY.getPalette().map(
      (destination) => destination.id,
    );
    expect(palette).not.toContain('guidance-playbooks');
    expect(palette).toContain('guidance-commands');
    const commands = APP_DESTINATION_REGISTRY.get('guidance-commands');
    expect(commands?.label()).toBe('Commands');
    expect(commands?.keywords).toContain('playbooks');
  });
});
