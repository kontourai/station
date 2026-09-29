import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import {
  getLegacyPathRedirect,
  resolveViewFromPath,
} from '../app-shell/routing';

/**
 * archive#3280: Activity owns the canonical `activity` identity. #928 retired
 * its `/activity` route, so BOTH prior spellings are now the permanent
 * redirect boundary: persisted notifications and old Discord messages remain
 * reachable without a store migration, while every current producer mints the
 * canonical deep link.
 */
describe('Activity rename sweep', () => {
  const destination = APP_DESTINATION_REGISTRY.get('activity');

  test('the surface is labeled Activity, on the sidebar and on the palette', () => {
    expect(destination).not.toBeNull();
    expect(destination!.label()).toBe('Activity');
    // SHELL-08 / lane 7's open question, decided yes: Home's lanes were the
    // only advertised way in, and Activity was one of five surfaces that
    // resolved but appeared in no navigation at all. #2059 (D3): it is now
    // the panel's only destination row, directly under Home — the panel
    // lists places, and Activity is one.
    expect(destination!.sidebar).toEqual({ order: 10 });
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().map((entry) => entry.label()),
    ).toContain('Activity');
    // The palette keeps the surface one keystroke away on every device, and
    // still answers to the old name.
    const palette = APP_DESTINATION_REGISTRY.getPalette().find(
      (entry) => entry.id === 'activity',
    );
    expect(palette).toBeDefined();
    expect(palette!.keywords).toContain('sessions');
  });

  test('Activity is a region surface whose retired routes still resolve', () => {
    // #928: no standalone placement, so the registry's `route` is the
    // canonical deep link rather than a path the resolver mounts. The two
    // retired spellings redirect onto it, carrying the only payload either
    // one ever had.
    expect(destination!.route).toBe(activityDeepLink());
    expect(destination!.regionSurface).toBe('activity');
    expect(destination!.view).toBeUndefined();
    expect(resolveViewFromPath(destination!.route)).toEqual({ type: 'home' });
    // These reds if routing.ts loses the permanent redirect entry.
    expect(getLegacyPathRedirect('/activity?session=thread-1')).toBe(
      activityDeepLink({ sessionId: 'thread-1' }),
    );
    expect(
      getLegacyPathRedirect('/sessions?session=thread-1&source=push'),
    ).toBe(activityDeepLink({ sessionId: 'thread-1' }));
  });
});
