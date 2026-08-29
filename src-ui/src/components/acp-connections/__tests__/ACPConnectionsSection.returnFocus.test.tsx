/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SplitPaneReturnFocusProvider,
  useSplitPaneExternalReturnFocus,
} from '../../split-pane-return-focus-context';
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
 * Stands in for `ConnectionsSectionFrame`'s real "Add engine" button
 * (`ConnectionsSectionFrame.tsx`'s `add` handler): captures itself into the
 * shared `SplitPaneReturnFocusProvider` on click, the same call the frame
 * makes before navigating to `/connections/engines/new`.
 */
function FrameAddTrigger({ onClick }: { onClick: () => void }) {
  const returnFocus = useSplitPaneExternalReturnFocus();
  return (
    <button
      type="button"
      onClick={(event) => {
        returnFocus?.captureExternalReturnFocus(event.currentTarget);
        onClick();
      }}
    >
      Add engine
    </button>
  );
}

/**
 * `ConnectionsSectionFrame` wraps the whole Engines section (both the
 * catalogue's route and this one) in one `SplitPaneReturnFocusProvider` that
 * is not remounted by the route change between them. `mounted` models that:
 * the trigger renders first (matching the catalogue's own "Add engine"
 * click), and `ACPConnectionsSection` only mounts afterward, fresh, with its
 * provider id already named — the same shape a real navigation to
 * `/connections/engines/new/<id>` produces.
 */
function Harness() {
  const [mounted, setMounted] = useState(false);
  return (
    <SplitPaneReturnFocusProvider>
      <FrameAddTrigger onClick={() => setMounted(true)} />
      {mounted && (
        <ACPConnectionsSection acpAgents={[]} initialProviderId="kiro" />
      )}
    </SplitPaneReturnFocusProvider>
  );
}

describe('ACPConnectionsSection return focus (#592 slice 2, review M2)', () => {
  // Before the fix: this section dropped `returnFocusTarget` entirely, so
  // `ResponsiveDialogSurface` fell back to `document.activeElement` at
  // MOUNT time — and the trigger that opened this flow lives in a
  // different route's component tree, so it is never the active element by
  // the time this component's dialog exists. Focus lands on `<body>`.
  test('closing the confirm dialog restores focus to the frame-captured Add engine trigger, not <body>', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Add engine' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.activeElement).not.toBe(document.body);
  });
});
