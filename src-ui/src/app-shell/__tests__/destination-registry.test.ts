import { describe, expect, test } from 'vitest';
import {
  APP_DESTINATION_REGISTRY,
  createDestinationRegistry,
  DEVELOPER_TOOLS_FLAG,
  type DestinationDefinition,
} from '../destination-registry';

describe('DestinationRegistry', () => {
  test('drives the exact panel, Manage and command-palette inventories from one authority', () => {
    // #2059 (design record D3): the left panel lists PLACES only. Activity is
    // the sole `sidebar` row — Home is `hiddenFromNav` and the panel renders
    // it directly, Notifications and Settings became the footer's bell and
    // gear, and the seven configuration destinations moved to `management`.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().map(
        (destination) => destination.id,
      ),
    ).toEqual(['activity']);
    // The developer-tools flag must not put a row back in the panel: it
    // gates Developer's MANAGE entry now.
    expect(
      APP_DESTINATION_REGISTRY.getSidebar(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (destination) => destination.id,
      ),
    ).toEqual(['activity']);
    expect(
      APP_DESTINATION_REGISTRY.getManagement().map(
        (destination) => destination.id,
      ),
    ).toEqual([
      'agents',
      'guidance',
      'connections',
      'registry',
      'plugins',
      'schedule',
    ]);
    expect(
      APP_DESTINATION_REGISTRY.getManagement(
        new Set([DEVELOPER_TOOLS_FLAG]),
      ).map((destination) => destination.id),
    ).toEqual([
      'agents',
      'guidance',
      'connections',
      'registry',
      'plugins',
      'schedule',
      'developer',
    ]);
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
  // asserts the ROUTE, not the id, because Guidance reaches the palette under
  // two entries of its own (`Commands` and `Skills`) rather than its own id —
  // an id-keyed check would have called it unreachable.
  test('every destination behind the gear is also reachable from the palette', () => {
    const flags = new Set([DEVELOPER_TOOLS_FLAG]);
    const paletteRoutes = new Set(
      APP_DESTINATION_REGISTRY.getPalette(flags).map(
        (destination) => destination.route,
      ),
    );
    for (const destination of APP_DESTINATION_REGISTRY.getManagement(flags)) {
      expect(
        paletteRoutes,
        `${destination.id} left the panel with no palette entry for ${destination.route}`,
      ).toContain(destination.route);
    }
  });

  // A destination is a place or a managed setting, never both: two entry
  // points advertising one surface as both a panel row and a Settings item is
  // exactly the split the panel change removes.
  test('refuses a destination that is both a panel place and a managed setting', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'both',
          route: '/both',
          label: () => 'Both',
          sidebar: { order: 1 },
          management: { order: 1 },
        },
      ]),
    ).toThrow(/both a panel place and a managed setting/);
  });

  // `hiddenFromNav` filters `getManagement`, so the pair would declare a
  // Manage entry and then withhold it — the destination would be gone from
  // the panel AND from the group that is supposed to hold what left it, with
  // no error anywhere.
  test('refuses a managed setting that is also hidden from nav', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'hidden-manage',
          route: '/hidden-manage',
          label: () => 'Hidden',
          hiddenFromNav: true,
          management: { order: 1 },
        },
      ]),
    ).toThrow(/cannot be hidden from nav and a managed setting/);
  });

  test('refuses two managed settings in the same slot', () => {
    expect(() =>
      createDestinationRegistry([
        {
          id: 'one',
          route: '/one',
          label: () => 'One',
          management: { order: 1 },
        },
        {
          id: 'two',
          route: '/two',
          label: () => 'Two',
          management: { order: 1 },
        },
      ]),
    ).toThrow(/Duplicate management destination order: 1/);
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
    ]);
    const [definition] = registry.getRegistered();

    expect(Object.isFrozen(registry.getRegistered())).toBe(true);
    expect(Object.isFrozen(registry.getSidebar())).toBe(true);
    expect(Object.isFrozen(registry.getPalette())).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.keywords)).toBe(true);
    expect(Object.isFrozen(definition?.sidebar)).toBe(true);
    expect(Object.isFrozen(definition?.palette?.params)).toBe(true);
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
