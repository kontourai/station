/**
 * Registry and Plugins are no longer places. Every address either used to
 * resolve lands on the address that now owns it, and that address resolves
 * to a real view; nothing that used to open a page now reads "not found".
 */
import { describe, expect, test } from 'vitest';
import type { NavigationView } from '../../types';
import { getLegacyPathRedirect, resolveViewFromPath } from '../routing';

/** Follow redirects the way the navigation store does, then resolve. */
function land(address: string): { path: string; view: NavigationView } {
  let path = address;
  for (let hop = 0; hop < 5; hop += 1) {
    const next = getLegacyPathRedirect(path);
    if (next === null) break;
    path = next;
  }
  return { path, view: resolveViewFromPath(path) };
}

describe('retired Registry and Plugins addresses', () => {
  test.each([
    // The catalogue root, the Plugins tab and any segment that names no
    // catalogue: Apps › Discover.
    ['/registry', '/apps/discover', { type: 'apps', tab: 'discover' }],
    ['/registry/', '/apps/discover', { type: 'apps', tab: 'discover' }],
    ['/registry?q=x', '/apps/discover?q=x', { type: 'apps', tab: 'discover' }],
    ['/registry/plugins', '/apps/discover', { type: 'apps', tab: 'discover' }],
    [
      '/registry/plugins/demo-layout',
      '/apps/discover',
      { type: 'apps', tab: 'discover' },
    ],
    [
      '/registry/marketplaces',
      '/apps/discover',
      { type: 'apps', tab: 'discover' },
    ],
    // Plugins: Apps › Library, keeping an installed plugin's name and a
    // proposal's id.
    ['/plugins', '/apps/library', { type: 'apps', tab: 'library' }],
    ['/plugins/', '/apps/library', { type: 'apps', tab: 'library' }],
    [
      '/plugins/enterprise-layout',
      '/apps/library/enterprise-layout',
      { type: 'apps', tab: 'library' },
    ],
    [
      '/plugins?proposal=p-1',
      '/apps/library?proposal=p-1',
      { type: 'apps', tab: 'library' },
    ],
    ['/manage/plugins', '/apps/library', { type: 'apps', tab: 'library' }],
    [
      '/manage/plugins/example',
      '/apps/library/example',
      { type: 'apps', tab: 'library' },
    ],
    // Apps' own addresses with a trailing slash.
    ['/apps/', '/apps', { type: 'apps', tab: 'discover' }],
    ['/apps/discover/', '/apps/discover', { type: 'apps', tab: 'discover' }],
    ['/apps/library/', '/apps/library', { type: 'apps', tab: 'library' }],
    [
      '/apps/library/?proposal=p-1',
      '/apps/library?proposal=p-1',
      { type: 'apps', tab: 'library' },
    ],
  ] as const)('%s lands on %s', (address, canonical, view) => {
    const landed = land(address);
    expect(landed.path).toBe(canonical);
    expect(landed.view).toEqual(view);
  });

  // Each remaining catalogue is a page of its own, entered from where its
  // kind is used, until its owner's own screen replaces it.
  test.each([
    ['/registry/agents', 'agents'],
    ['/registry/skills', 'skills'],
    ['/registry/skills/', 'skills'],
    ['/registry/integrations', 'integrations'],
    ['/registry/layouts', 'layouts'],
    ['/registry/kits', 'kits'],
  ] as const)('%s keeps its catalogue page', (address, tab) => {
    expect(getLegacyPathRedirect(address)).toBeNull();
    expect(resolveViewFromPath(address)).toEqual({ type: 'registry', tab });
  });
});
