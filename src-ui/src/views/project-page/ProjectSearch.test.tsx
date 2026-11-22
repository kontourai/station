/** @vitest-environment jsdom */
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { ProjectNavigation } from './ProjectNavigation';

const scope = {
  apiBase: 'https://station.test',
  authorityKey: 'epoch-a',
  isCurrent: () => true,
};
vi.mock('../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => scope,
}));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const owner = { kind: 'station', stationId: 'station-a' };
const complete = {
  version: UNIFIED_SEARCH_V1,
  state: 'complete',
  results: [],
  sources: [
    { providerId: 'station.tasks', owner, state: 'available' },
    { providerId: 'station.messages', owner, state: 'available' },
  ],
};

beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
  }));
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

// The unified search route scopes Tasks and messages by Project slug
// (runtime-search.test.ts proves the server half with two Projects). This
// proves the rail Search sends that slug, not the Project's id, which matched
// nothing, and that it offers no way into the Station-wide command palette.
test('the Project rail Search scopes to the Project slug and stays out of the command palette', async () => {
  const bodies: Array<{ filters?: { projectId?: string } }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/search');
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, data: complete }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const openedPalette = vi.fn();
  window.addEventListener('open-command-palette', openedPalette);
  navigationStore.navigate('/projects/alpha-site');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <NavigationProvider>
          <ProjectNavigation slug="alpha-site" />
        </NavigationProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const input = await screen.findByRole('combobox', {
      name: "Search this Station's work",
    });
    fireEvent.change(input, { target: { value: 'zebrafinch' } });
    expect(
      await screen.findByText('No matching work in this Project', undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies)
      expect(body.filters?.projectId).toBe('alpha-site');
    expect(screen.queryByRole('button', { name: 'Back to commands' })).toBe(
      null,
    );
    expect(openedPalette).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('open-command-palette', openedPalette);
    client.clear();
  }
});
