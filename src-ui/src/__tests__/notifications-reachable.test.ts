import { describe, expect, it } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import {
  getManagementNavigationGroup,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';

/**
 * #872: "there is no way to navigate to past ones" — the inbox was reachable
 * only from the header popover's "view all", which requires the popover, which
 * in practice requires having a notification. The empty state is exactly when
 * someone goes looking for it.
 */
describe('the notification inbox is a destination', () => {
  it('round-trips its own route', () => {
    expect(resolveViewFromPath('/notifications')).toEqual({
      type: 'notifications',
    });
    expect(getPathForView({ type: 'notifications' })).toBe('/notifications');
  });

  it('is a navigable group, so the sidebar can highlight it', () => {
    expect(getManagementNavigationGroup({ type: 'notifications' })).toBe(
      'notifications',
    );
  });

  it('is advertised where a person can find it without a notification', () => {
    // #2059 (D3) moved it out of the sidebar's row list and into the panel
    // footer's bell, which renders this destination and its badge by id
    // (ProjectSidebarFooter.test.tsx drives that control). The registry's
    // half of #872 is that it stays advertised at all: the palette entry is
    // the one that survives on every device, including the collapsed rail
    // and the mobile drawer.
    expect(
      APP_DESTINATION_REGISTRY.getPalette().some(
        (surface) => surface.id === 'notifications',
      ),
    ).toBe(true);
    // A footer control, not a panel row — and not a Manage entry either:
    // attention is not configuration.
    expect(
      APP_DESTINATION_REGISTRY.get('notifications')?.sidebar,
    ).toBeUndefined();
    expect(
      APP_DESTINATION_REGISTRY.get('notifications')?.management,
    ).toBeUndefined();
  });
});
