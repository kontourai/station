import { describe, expect, test } from 'vitest';
import { buildSidebarClassName } from '../components/project-sidebar/utils';

describe('project-sidebar utils', () => {
  test('buildSidebarClassName handles desktop and mobile states', () => {
    expect(
      buildSidebarClassName({
        isMobile: false,
        mobileOpen: false,
        collapsed: false,
      }),
    ).toBe('sidebar');
    expect(
      buildSidebarClassName({
        isMobile: false,
        mobileOpen: false,
        collapsed: true,
      }),
    ).toBe('sidebar sidebar--collapsed');
    expect(
      buildSidebarClassName({
        isMobile: true,
        mobileOpen: true,
        collapsed: true,
      }),
    ).toBe('sidebar sidebar--expanded');
  });
});
