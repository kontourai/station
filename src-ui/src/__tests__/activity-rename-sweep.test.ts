import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import {
  getLegacyPathRedirect,
  resolveViewFromPath,
} from '../app-shell/routing';
import { resolveClientOriginActor } from '../utils/clientOrigin';

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
    // resolved but appeared in no navigation at all. It now leads the
    // sidebar's flat `primary` band with Agents and Connections.
    expect(destination!.sidebar).toEqual({ section: 'primary', order: 30 });
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

  /**
   * Every file that renders an affordance INTO the surface, plus the surface
   * itself. A new "… Sessions" affordance added to one of these files reds
   * this test; a new file linking to the surface should be added here when it
   * links by the surface's name.
   */
  const RENAMED_SOURCES = [
    'views/SessionsView.tsx',
    'views/home/HomeSurface.tsx',
    'components/home/HomeRecentWorkSection.tsx',
    'views/project-page/ProjectLiveWorkSection.tsx',
    'app-shell/destination-registry.ts',
  ] as const;

  /**
   * The old surface name in an affordance or label position. Lowercase
   * "session(s)" (the item noun) and identifiers like `useDerivedSessions`
   * stay legitimate; these patterns target the capitalized surface name the
   * rename retired.
   */
  const BANNED = [
    /\b(?:View|Open|All)\s+Sessions\b/,
    /sessions --all/,
    /label:\s*\(\)\s*=>\s*'Sessions'/,
    /(?:title|label)="Sessions"/,
  ] as const;

  test.each(RENAMED_SOURCES)(
    '%s carries no "Sessions" affordance',
    (relative) => {
      const source = readFileSync(join(__dirname, '..', relative), 'utf8');
      for (const pattern of BANNED) {
        expect(
          pattern.test(source),
          `${relative} still matches ${pattern} — the Activity rename must be complete`,
        ).toBe(false);
      }
    },
  );
});

describe('Activity client-origin actor display (#951 step 2)', () => {
  test('resolves a device id against the current name without retaining a stale copy', () => {
    const actor = { kind: 'device' as const, deviceId: 'device-1' };

    expect(
      resolveClientOriginActor(actor, [
        { id: 'device-1', name: 'Brian’s Pixel' },
      ]),
    ).toEqual({
      kind: 'device',
      deviceId: 'device-1',
      name: 'Brian’s Pixel',
      label: 'Brian’s Pixel',
    });
    expect(
      resolveClientOriginActor(actor, [
        { id: 'device-1', name: 'Travel phone' },
      ]),
    ).toEqual({
      kind: 'device',
      deviceId: 'device-1',
      name: 'Travel phone',
      label: 'Travel phone',
    });
  });

  test('keeps an unmatched device visible with its honest opaque id', () => {
    expect(
      resolveClientOriginActor(
        { kind: 'device', deviceId: 'missing-device' },
        [],
      ),
    ).toEqual({
      kind: 'device',
      deviceId: 'missing-device',
      name: null,
      label: 'Unknown device (missing-device)',
    });
  });

  test.each([
    ['operator', 'Operator'],
    ['internal', 'Station'],
    ['unknown', 'Unknown origin'],
  ] as const)('treats %s as the distinct %s category', (kind, label) => {
    expect(resolveClientOriginActor({ kind }, [])).toEqual({
      kind,
      name: null,
      label,
    });
  });

  test('does not present unknown as a named actor', () => {
    expect(resolveClientOriginActor({ kind: 'unknown' }, [])).toMatchObject({
      kind: 'unknown',
      name: null,
    });
  });
});
