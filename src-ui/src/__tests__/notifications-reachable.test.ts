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

  it('has a sidebar entry', () => {
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().some(
        (surface) => surface.id === 'notifications',
      ),
    ).toBe(true);
  });
});
