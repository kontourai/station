/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PageFrame, PageFrameActions } from '../../page-frame';
import { ACPConnectionsSection } from '../ACPConnectionsSection';

const connectionsState = {
  data: [] as unknown[],
  error: null as unknown,
  isError: false,
  isFetching: false,
  isPending: false,
};
const refetchConnections = vi.fn();
const registryEntries: unknown[] = [
  {
    id: 'kiro',
    name: 'Kiro CLI',
    command: 'kiro',
    installed: false,
    detected: true,
  },
];

vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => ({
    ...connectionsState,
    refetch: refetchConnections,
  }),
  useACPConnectionRegistry: () => ({ data: registryEntries }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useCreateACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useDeleteACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useInstallACPConnectionRegistryEntryMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useReconnectACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useUpdateACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

afterEach(() => {
  connectionsState.data = [];
  connectionsState.error = null;
  connectionsState.isError = false;
  connectionsState.isFetching = false;
  connectionsState.isPending = false;
  refetchConnections.mockReset();
});

/**
 * Stands in for `ConnectionsSectionFrame`: renders the section's ONE
 * "Add engine" action through `PageFrameActions` (into `PageFrame`'s
 * `.page__actions` cell), same as the real component does for every route
 * under the Engines tab.
 */
function SectionFrameStandIn({ children }: { children: ReactNode }) {
  return (
    <>
      <PageFrameActions>
        <button type="button">Add engine</button>
      </PageFrameActions>
      {children}
    </>
  );
}

/**
 * Reproduces the two nested keying boundaries that actually separate the
 * catalogue route from this one in production, both driven by the SAME
 * surface-identity string (`route-identity.ts`'s `routeSurfaceIdentity` —
 * `connections-acp-new` is never folded into `connections-engines`, so a
 * real navigation here always changes this string):
 *
 *  1. `PageFrame`'s OWN `.page__actions` cell carries `key={routeIdentity}`
 *     (`PageFrame.tsx`, pinned by `PageFrame.test.tsx`'s "replaces the
 *     action cell itself" case) — it swaps independently of anything else on
 *     the page.
 *  2. `AppViewContent`'s entrance wrapper carries `key={surfaceKey}`
 *     (`app-shell/AppViewContent.tsx`) — the `SectionFrameStandIn` boundary
 *     below models that: it remounts along with everything under it,
 *     including a FRESH "Add engine" button, matching how a fresh
 *     `ConnectionsSectionFrame` instance renders a fresh one on every route.
 *
 * One `<PageFrame>` instance (never itself remounted — matching
 * `AppViewContent.tsx`'s single, unkeyed `<PageFrame>` call) whose
 * `routeIdentity` PROP changes is what drives both boundaries at once, the
 * same as a real navigation does.
 */
function Harness() {
  const [routeIdentity, setRouteIdentity] = useState('connections-engines');
  return (
    <PageFrame spec={{ title: 'Engines' }} routeIdentity={routeIdentity}>
      <div key={routeIdentity}>
        {routeIdentity === 'connections-engines' ? (
          <SectionFrameStandIn>
            <button
              type="button"
              onClick={() => setRouteIdentity('connections-acp-new:kiro')}
            >
              Kiro CLI
            </button>
          </SectionFrameStandIn>
        ) : (
          <SectionFrameStandIn>
            <ACPConnectionsSection acpAgents={[]} initialProviderId="kiro" />
          </SectionFrameStandIn>
        )}
      </div>
    </PageFrame>
  );
}

describe('ACPConnectionsSection return focus (#592 slice 2, review round 2, M2)', () => {
  // Before this fix: whatever this component tried to capture from the
  // catalogue's route (a chain, a ref) was captured from a DOM node this
  // exact remount already destroyed — the assertion below on
  // `catalogueAddButton.isConnected` is what proves that destruction
  // actually happens in this harness, not just in theory.
  test('closing the confirm dialog restores focus to the CURRENT route`s own Add engine button, not the destroyed catalogue one, not <body>', async () => {
    render(<Harness />);
    const catalogueAddButton = screen.getByRole('button', {
      name: 'Add engine',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kiro CLI' }));

    // The portal cell swap + entrance remount actually happened: the old
    // "Add engine" button is off-document, not merely a stale reference.
    expect(catalogueAddButton.isConnected).toBe(false);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    // A fresh "Add engine" button exists on THIS route — a different node
    // than the one captured above.
    const currentAddButton = screen.getByRole('button', { name: 'Add engine' });
    expect(currentAddButton).not.toBe(catalogueAddButton);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(currentAddButton));
    expect(document.activeElement).not.toBe(document.body);
  });
});
