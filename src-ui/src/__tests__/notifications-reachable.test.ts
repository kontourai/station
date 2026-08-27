import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getManagementNavigationGroup,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';
import { APP_SURFACE_REGISTRY } from '../app-shell/surface-registry';

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
      APP_SURFACE_REGISTRY.getSidebar().some(
        (surface) => surface.id === 'notifications',
      ),
    ).toBe(true);
  });

  it('renders something when there is nothing', () => {
    // Landing on a blank page reads as broken; both lanes say so instead.
    const dir = join(__dirname, '..', 'components');
    expect(
      readFileSync(
        join(dir, 'notifications', 'NotificationSection.tsx'),
        'utf-8',
      ),
    ).toMatch(/length === 0/);
    expect(
      readFileSync(join(dir, 'attention', 'AttentionSection.tsx'), 'utf-8'),
    ).toMatch(/length === 0/);
  });
});
