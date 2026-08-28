import { describe, expect, test } from 'vitest';
import {
  APP_SURFACE_REGISTRY,
  createSurfaceRegistry,
  DEVELOPER_TOOLS_FLAG,
  type SurfaceDefinition,
} from '../surface-registry';

describe('SurfaceRegistry', () => {
  test('drives the exact sidebar and command-palette inventories from one authority', () => {
    // archive#3313 (Settings IA, option A): Settings holds a System slot;
    // Feature Previews is a Settings section (palette deep link only); the
    // Developer surfaces advertise only with the developer-tools flag on.
    //
    // / : Agents, Connections and Activity lead as a
    // flat `primary` band. The order below is also the assertion that
    // `primary` sorts FIRST — sections used to be ordered by
    // `String.localeCompare`, under which 'primary' would have landed between
    // 'customize' and 'system' and put the top-level band in the middle.
    expect(
      APP_SURFACE_REGISTRY.getSidebar().map((surface) => surface.id),
    ).toEqual([
      'agents',
      'connections',
      'activity',
      'guidance',
      'registry',
      'review-queue',
      'plugins',
      'notifications',
      'schedule',
      'settings',
    ]);
    expect(
      APP_SURFACE_REGISTRY.getSidebar(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (surface) => surface.id,
      ),
    ).toEqual([
      'agents',
      'connections',
      'activity',
      'guidance',
      'registry',
      'review-queue',
      'plugins',
      'notifications',
      'schedule',
      'settings',
      'developer',
    ]);
    expect(
      APP_SURFACE_REGISTRY.getPalette().map((surface) => surface.id),
    ).toEqual([
      'agents',
      'guidance-commands',
      'guidance-skills',
      'registry',
      'connections',
      // 6-: Notifications and Profile are top-level destinations that
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
      APP_SURFACE_REGISTRY.getPalette(new Set([DEVELOPER_TOOLS_FLAG])).map(
        (surface) => surface.id,
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

  test('keeps registered preview surfaces wired while advertising only enabled ones', () => {
    const preview: SurfaceDefinition = {
      id: 'preview',
      route: '/preview',
      label: () => 'Preview',
      previewFlag: 'preview-surface',
      hiddenFromNav: true,
      palette: { order: 1 },
    };
    const registry = createSurfaceRegistry([preview]);

    expect(registry.getRegistered()).toHaveLength(1);
    expect(registry.getAdvertised()).toEqual([]);
    expect(
      registry
        .getAdvertised(new Set(['preview-surface']))
        .map((entry) => entry.id),
    ).toEqual(['preview']);
  });

  test('resolves labels and badges at projection time', () => {
    const notifications = APP_SURFACE_REGISTRY.get('notifications');
    expect(notifications?.label()).toBe('Notifications');
    expect(notifications?.badge?.({ attentionCount: 0 })).toBeNull();
    expect(notifications?.badge?.({ attentionCount: 3 })).toEqual({
      count: 3,
      label: '3 need attention',
    });
  });

  test('does not resolve render-time labels during composition or projection', () => {
    let labelCalls = 0;
    const registry = createSurfaceRegistry([
      {
        id: 'late-label',
        route: '/late-label',
        label: () => {
          labelCalls += 1;
          return 'Localized later';
        },
        sidebar: { section: 'system', order: 1 },
      },
    ]);

    expect(labelCalls).toBe(0);
    const [surface] = registry.getSidebar();
    expect(labelCalls).toBe(0);
    expect(surface?.label()).toBe('Localized later');
    expect(labelCalls).toBe(1);
  });

  test('owns exact root routing and semantic management grouping', () => {
    expect(APP_SURFACE_REGISTRY.resolveExactRoute('/schedule')).toEqual({
      type: 'schedule',
    });
    expect(
      APP_SURFACE_REGISTRY.getSurfaceForView({
        type: 'connections-provider-edit',
        id: 'ollama',
      })?.id,
    ).toBe('connections');
  });

  test('returns frozen definitions and projections from immutable composition', () => {
    const registry = createSurfaceRegistry([
      {
        id: 'one',
        route: '/one',
        label: () => 'One',
        keywords: ['first'],
        sidebar: { section: 'customize', order: 1 },
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
      /Duplicate surface id/,
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
      /Duplicate exact surface route/,
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
      /Duplicate sidebar surface order/,
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
      /Duplicate command-palette surface order/,
    ],
  ] as const)(
    'rejects %s at the composition seam',
    (_label, entries, error) => {
      expect(() => createSurfaceRegistry(entries)).toThrow(error);
    },
  );

  // Playbooks are Skills. The palette entry that named the retired concept is
  // gone; the one that replaced it keeps the retired words as KEYWORDS, so
  // someone who learned "playbooks" still finds the surface while reading the
  // one noun that survives.
  test('the retired Playbooks palette entry is replaced by Commands', () => {
    const palette = APP_SURFACE_REGISTRY.getPalette().map(
      (surface) => surface.id,
    );
    expect(palette).not.toContain('guidance-playbooks');
    expect(palette).toContain('guidance-commands');
    const commands = APP_SURFACE_REGISTRY.get('guidance-commands');
    expect(commands?.label()).toBe('Commands');
    expect(commands?.keywords).toContain('playbooks');
  });
});
