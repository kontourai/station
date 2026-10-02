/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import {
  RegionModelProvider,
  SuspendRegionSurfaces,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  LayoutChatPlacementContext,
  subscribeCenterChatPageRequests,
} from '../chat-placement';
import type { LayoutChatPlacement } from '../project-layout-kind';
import { RegionShells } from '../RegionShells';

vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => <div data-testid="activity-pane" />,
}));
// Chat reaches a region through the region host's renderer; a marker is
// enough to see whether the host rendered it.
vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="ambient-chat" />,
  renderAmbientChatPane: () => <div data-testid="ambient-chat" />,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));

let model: ReturnType<typeof useRegionModel> | null = null;
let suspendedModel: ReturnType<typeof useRegionModel> | null = null;
let showSurface: ReturnType<typeof useShowSurface> | null = null;

function ShowSurfaceProbe() {
  const value = useShowSurface();
  useEffect(() => {
    showSurface = value;
  }, [value]);
  return null;
}

/** What a region shell sees: the model through the centre's suspension. */
function SuspendedProbe() {
  const value = useRegionModel();
  useEffect(() => {
    suspendedModel = value;
  }, [value]);
  return null;
}

/** The UNSUSPENDED model: rendered outside `RegionShells`' suspension. */
function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function Shell({
  placement,
  children,
}: {
  placement: LayoutChatPlacement;
  children?: ReactNode;
}) {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <LayoutChatPlacementContext.Provider value={placement}>
            <div className="app app--with-sidebar">
              <div className="app__main">
                <RegionShells />
                {children}
              </div>
            </div>
          </LayoutChatPlacementContext.Provider>
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/** The dock open: the default arrangement's bottom region holds Chat alone. */
async function openBottom() {
  await waitFor(() => expect(model).not.toBeNull());
  act(() => model?.setRegion('bottom', { visible: true }));
  await settle();
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, '', '/');
});

/**
 * While the Coding layout's centre owns Chat, the region shells render every
 * other pane where the user put it and Chat nowhere — and the arrangement the
 * user saved still has Chat in it.
 */
describe('RegionShells while the Coding centre owns Chat', () => {
  test('control: with no centre placement the open dock renders Chat', async () => {
    render(<Shell placement="none" />);
    await openBottom();
    expect(model?.regions.bottom).toMatchObject({
      visible: true,
      panes: ['chat'],
    });
    expect(await screen.findByTestId('ambient-chat')).toBeTruthy();
    expect(document.querySelector('#chat-dock')).not.toBeNull();
  });

  test('a region holding only Chat mounts nothing: no Chat, no #chat-dock, no empty chooser', async () => {
    render(<Shell placement="center" />);
    await openBottom();

    expect(model?.regions.bottom).toMatchObject({
      visible: true,
      panes: ['chat'],
    });
    expect(screen.queryByTestId('ambient-chat')).toBeNull();
    expect(document.querySelector('#chat-dock')).toBeNull();
    expect(document.querySelector('[data-region="bottom"]')).toBeNull();
  });

  test('Chat beside another pane: that pane renders, Chat does not, and the record keeps Chat', async () => {
    render(<Shell placement="center" />);
    await settle();
    await waitFor(() => expect(model).not.toBeNull());

    act(() => model?.placeSurface('activity', 'bottom'));
    act(() => model?.selectPane('bottom', 'chat'));
    await settle();
    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'chat',
      }),
    );

    expect(await screen.findByTestId('activity-pane')).toBeTruthy();
    expect(screen.queryByTestId('ambient-chat')).toBeNull();
    expect(document.querySelector('#chat-dock')).toBeNull();
    // What is persisted is the user's arrangement, Chat included.
    await waitFor(() =>
      expect(
        JSON.stringify(deviceSettingsStore.get('regionArrangement')),
      ).toContain('"chat"'),
    );
    const bottom = deviceSettingsStore.get('regionArrangement')?.regions
      .bottom as { occupant: unknown } | undefined;
    expect(JSON.stringify(bottom?.occupant)).toContain('"chat"');
    expect(JSON.stringify(bottom?.occupant)).toContain('"activity"');
  });

  test('leaving the Coding layout brings Chat back where it was', async () => {
    const view = render(<Shell placement="center" />);
    await openBottom();
    expect(screen.queryByTestId('ambient-chat')).toBeNull();

    view.rerender(<Shell placement="none" />);
    await settle();
    expect(await screen.findByTestId('ambient-chat')).toBeTruthy();
    expect(model?.regions.bottom.panes).toEqual(['chat']);
  });

  test('a tab reorder written through the suspended view does not drop Chat', async () => {
    render(
      <Shell placement="center">
        <SuspendRegionSurfaces surfaces={['chat']}>
          <SuspendedProbe />
        </SuspendRegionSurfaces>
      </Shell>,
    );
    await openBottom();
    act(() => model?.placeSurface('activity', 'bottom'));
    act(() => model?.placeSurface('workspace-agents', 'bottom'));
    await waitFor(() =>
      expect(model?.regions.bottom.panes).toEqual([
        'chat',
        'activity',
        'workspace-agents',
      ]),
    );
    expect(suspendedModel?.regions.bottom.panes).toEqual([
      'activity',
      'workspace-agents',
    ]);

    // The shape `RegionPaneHost`'s reorder writes: the visible order, moved.
    act(() =>
      suspendedModel?.setRegion('bottom', {
        panes: ['workspace-agents', 'activity'],
      }),
    );
    await waitFor(() =>
      expect(model?.regions.bottom.panes).toEqual([
        'chat',
        'workspace-agents',
        'activity',
      ]),
    );
  });

  test('showSurface("chat") asks the centre for its Chat page and delivers the session, revealing no region', async () => {
    const requests = vi.fn();
    const unsubscribe = subscribeCenterChatPageRequests(requests);
    try {
      render(
        <Shell placement="center">
          <ShowSurfaceProbe />
        </Shell>,
      );
      await settle();
      await waitFor(() => expect(showSurface).not.toBeNull());
      act(() => model?.setRegion('bottom', { visible: false }));
      await settle();
      const before = model?.regions;
      expect(before?.bottom.visible).toBe(false);

      act(() => showSurface?.('chat', { session: 'thread-7' }));

      expect(requests).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(model?.surfaceIntents.chat).toMatchObject({
          session: 'thread-7',
        }),
      );
      expect(model?.regions).toBe(before);
    } finally {
      unsubscribe();
    }
  });
});
