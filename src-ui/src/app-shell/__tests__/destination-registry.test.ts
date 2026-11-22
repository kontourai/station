import { describe, expect, test } from 'vitest';
import {
  APP_DESTINATION_REGISTRY,
  createDestinationRegistry,
  customizeItemForView,
  DEVELOPER_TOOLS_FLAG,
  type DestinationDefinition,
} from '../destination-registry';

describe('DestinationRegistry', () => {
  test('drives the exact panel and command-palette inventories from one authority', () => {
    // #2059 (design record D3): the left panel lists PLACES only. Activity is
    // the sole `sidebar` row — Home is `hiddenFromNav` and the panel renders
    // it directly, Notifications became the header's bell and Settings the
    // footer account menu's Open settings row, and the configuration
    // destinations moved behind the footer's Customize button.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().map(
        (destination) => destination.id,
      ),
    ).toEqual([]);
    // The developer-tools flag must not put a row back in the panel: it
    // gates Developer's SETTINGS entry now.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (destination) => destination.id,
      ),
    ).toEqual([]);
    expect(
      APP_DESTINATION_REGISTRY.getPalette().map(
        (destination) => destination.id,
      ),
    ).toEqual([
      'agents',
      'guidance-commands',
      'guidance-skills',
      'registry',
      'customize',
      'engines',
      'providers',
      'tools',
      'knowledge',
      // 6-OPS-32: Notifications and Profile are top-level destinations that
      // ⌘K could not reach at all — "notif" and "prof" each returned zero
      // results in a palette carrying 72 entries.
      'notifications',
      'computers',
      'plugins',
      'schedule',
      'feature-previews',
      'appearance',
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
      'customize',
      'engines',
      'providers',
      'tools',
      'knowledge',
      'notifications',
      'computers',
      'plugins',
      'schedule',
      'feature-previews',
      'developer',
      'monitoring',
      'appearance',
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
  test('every destination behind Customize is also reachable from the palette', () => {
    const flags = new Set([DEVELOPER_TOOLS_FLAG]);
    const paletteRoutes = new Set(
      APP_DESTINATION_REGISTRY.getPalette(flags).map(
        (destination) => destination.route,
      ),
    );
    for (const entry of APP_DESTINATION_REGISTRY.getCustomizeNav(flags)) {
      const destination = APP_DESTINATION_REGISTRY.get(entry.id);
      expect(
        paletteRoutes,
        `${entry.id} left the panel with no palette entry for ${destination?.route}`,
      ).toContain(destination?.route);
    }
  });

  // The first-release design took Plugins, Appearance, Developer and
  // Settings out of the Customize list, and Connections stopped being a
  // destination. Every surface the old chooser listed must still have a door:
  // the palette. The inventory is LITERAL, taken from the old chooser, because
  // deriving it from `getCustomizeNav()` would compare the projection with
  // itself and pass however it changed.
  test('every surface the old Customize chooser listed is still reachable from the palette', () => {
    const flags = new Set([DEVELOPER_TOOLS_FLAG]);
    const paletteRoutes = new Set(
      APP_DESTINATION_REGISTRY.getPalette(flags).map(
        (destination) => destination.route,
      ),
    );
    for (const route of [
      '/agents',
      '/guidance',
      // Connections was entered at its Engines section.
      '/customize/engines',
      '/plugins',
      '/developer',
      '/appearance',
      '/settings',
      // Computers left Connections without becoming a Customize item.
      '/connections/computers',
    ]) {
      expect(paletteRoutes, `${route} has no palette entry`).toContain(route);
    }
  });

  // A literal inventory, not a re-read of `getCustomizeNav()`: comparing the
  // projection against itself would pass however it changed.
  test('projects the six Customize items in their groups', () => {
    expect(APP_DESTINATION_REGISTRY.getCustomizeNav()).toEqual([
      {
        id: 'agents',
        group: 'your-agents',
        order: 10,
        label: 'Agents',
        route: '/agents',
      },
      {
        id: 'guidance',
        group: 'your-agents',
        order: 20,
        label: 'Skills',
        // Straight to the tab, so opening Skills is one history entry.
        route: '/guidance?tab=skills',
      },
      {
        id: 'engines',
        group: 'run-on',
        order: 10,
        label: 'Engines',
        route: '/customize/engines',
      },
      {
        id: 'providers',
        group: 'run-on',
        order: 20,
        label: 'Providers',
        route: '/customize/providers',
      },
      {
        id: 'tools',
        group: 'can-reach',
        order: 10,
        label: 'Tools',
        route: '/customize/tools',
      },
      {
        id: 'knowledge',
        group: 'can-reach',
        order: 20,
        label: 'Knowledge',
        route: '/customize/knowledge',
      },
    ]);
    // The developer flag adds nothing: Developer is not a Customize item.
    expect(
      APP_DESTINATION_REGISTRY.getCustomizeNav(
        new Set([DEVELOPER_TOOLS_FLAG]),
      ).map((entry) => entry.id),
    ).toEqual([
      'agents',
      'guidance',
      'engines',
      'providers',
      'tools',
      'knowledge',
    ]);
  });

  test('every view a Customize item hosts belongs to that item', () => {
    const cases: Array<
      [Parameters<typeof customizeItemForView>[0], string | null]
    > = [
      [{ type: 'customize' }, 'customize'],
      [{ type: 'agents' }, 'agents'],
      [{ type: 'agent-edit', slug: 'planner' }, 'agents'],
      [{ type: 'guidance' }, 'guidance'],
      [{ type: 'connections-engines' }, 'engines'],
      [{ type: 'connections-engine-edit', id: 'claude' }, 'engines'],
      [{ type: 'connections-engine-new', providerId: 'custom' }, 'engines'],
      [{ type: 'connections-models' }, 'providers'],
      [{ type: 'connections-model-edit', id: 'ollama' }, 'providers'],
      [{ type: 'connections-tools' }, 'tools'],
      [{ type: 'connections-tool-edit', id: 'docs' }, 'tools'],
      [{ type: 'connections-knowledge' }, 'knowledge'],
      // Not Customize items.
      [{ type: 'connections-computers' }, null],
      [{ type: 'plugins' }, null],
      [{ type: 'settings' }, null],
      [{ type: 'home' }, null],
    ];
    for (const [view, item] of cases) {
      expect(customizeItemForView(view), view.type).toBe(item);
    }
  });

  test('refuses a destination that is both a panel place and a Customize nav entry', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'both',
          route: '/both',
          label: () => 'Both',
          sidebar: { order: 1 },
          customizeNav: { group: 'run-on', order: 1 },
        },
      ]),
    ).toThrow(/both a panel place and a Customize nav entry/);
  });

  test('refuses a Customize nav entry that is also hidden from nav', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'hidden',
          route: '/hidden',
          label: () => 'Hidden',
          hiddenFromNav: true,
          customizeNav: { group: 'run-on', order: 1 },
        },
      ]),
    ).toThrow(/cannot be hidden from nav and a Customize nav entry/);
  });

  test('refuses a relative Customize nav route override', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'relative',
          route: '/relative',
          label: () => 'Relative',
          customizeNav: { group: 'run-on', order: 1, route: 'engines' },
        },
      ]),
    ).toThrow(/absolute Station route for its Customize nav entry/);
  });

  test('orders a group by `order`, not by declaration order', () => {
    // The only ordering `getCustomizeNav` promises, and the only one its
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
        customizeNav: { group: 'run-on', order: 20 },
      },
      {
        id: 'first',
        route: '/first',
        label: () => 'First',
        customizeNav: { group: 'run-on', order: 10 },
      },
    ]);
    expect(registry.getCustomizeNav().map((entry) => entry.id)).toEqual([
      'first',
      'second',
    ]);
  });

  test('lists the groups in page order before ordering within each', () => {
    // Declared against the grain: a later group with a lower order first.
    const registry = createDestinationRegistry([
      {
        id: 'reach',
        route: '/reach',
        label: () => 'Reach',
        customizeNav: { group: 'can-reach', order: 1 },
      },
      {
        id: 'agent',
        route: '/agent',
        label: () => 'Agent',
        customizeNav: { group: 'your-agents', order: 50 },
      },
      {
        id: 'run',
        route: '/run',
        label: () => 'Run',
        customizeNav: { group: 'run-on', order: 5 },
      },
    ]);
    expect(registry.getCustomizeNav().map((entry) => entry.id)).toEqual([
      'agent',
      'run',
      'reach',
    ]);
  });

  test('refuses two Customize nav entries in one slot, but not across groups', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'one',
          route: '/one',
          label: () => 'One',
          customizeNav: { group: 'run-on', order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: () => 'Two',
          customizeNav: { group: 'run-on', order: 1 },
        },
      ]),
    ).toThrow(/Duplicate Customize nav destination order: run-on:1/);
    // Order is unique within a group, not globally: two groups may each have a
    // first row, and refusing that would make the orders one shared sequence.
    expect(() =>
      createDestinationRegistry([
        {
          id: 'one',
          route: '/one',
          label: () => 'One',
          customizeNav: { group: 'run-on', order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: () => 'Two',
          customizeNav: { group: 'can-reach', order: 1 },
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
    expect(APP_DESTINATION_REGISTRY.resolveExactRoute('/automations')).toEqual({
      type: 'schedule',
    });
    expect(
      APP_DESTINATION_REGISTRY.getDestinationForView({
        type: 'connections-model-edit',
        id: 'ollama',
      })?.id,
    ).toBe('providers');
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
        customizeNav: { group: 'run-on', order: 1 },
      },
    ]);
    const [definition, navDefinition] = registry.getRegistered();

    expect(Object.isFrozen(registry.getRegistered())).toBe(true);
    expect(Object.isFrozen(registry.getSidebar())).toBe(true);
    expect(Object.isFrozen(registry.getPalette())).toBe(true);
    expect(Object.isFrozen(registry.getCustomizeNav())).toBe(true);
    expect(Object.isFrozen(registry.getCustomizeNav()[0])).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.keywords)).toBe(true);
    expect(Object.isFrozen(definition?.sidebar)).toBe(true);
    expect(Object.isFrozen(definition?.palette?.params)).toBe(true);
    expect(Object.isFrozen(navDefinition?.customizeNav)).toBe(true);
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
  // Palette membership (Commands in, Playbooks out) is the exact inventory
  // above; this pins only what that inventory cannot see.
  test('the retired Playbooks palette entry is replaced by Commands', () => {
    const commands = APP_DESTINATION_REGISTRY.get('guidance-commands');
    expect(commands?.label()).toBe('Commands');
    expect(commands?.keywords).toContain('playbooks');
  });
});
