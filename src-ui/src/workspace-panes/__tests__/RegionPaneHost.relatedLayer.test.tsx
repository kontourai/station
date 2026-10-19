/** @vitest-environment jsdom */

/**
 * A related preview opened over Chat on a phone (the phone layer) through the
 * shipped shells: the layer's way back names the conversation the preview was
 * opened from, the opener's exact selection — not a generic "Chat".
 */

import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { AuthorityPersistenceContext } from '../../contexts/AuthorityPersistenceContext';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { PaneRelationsProvider } from '../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { useOpenFilePreviewInRegion } from '../../contexts/useOpenInRegion';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';

vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => null,
  renderAmbientChatPane: () => <p>Chat pane</p>,
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
vi.mock('../../contexts/ConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ConfigContext')>()),
  useConfig: () => null,
}));

const OPENER = {
  occurrenceId: 'chat',
  selection: 'thread:security-review',
  label: 'Security review',
};

const observation: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'station-a',
  principal: { kind: 'human', id: 'operator' },
  grant: { kind: 'operator' },
};

let open: ReturnType<typeof useOpenFilePreviewInRegion> = null;
let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  const openPreview = useOpenFilePreviewInRegion(OPENER);
  useEffect(() => {
    model = value;
    open = openPreview;
  }, [value, openPreview]);
  return null;
}

beforeEach(() => {
  open = null;
  model = null;
  localStorage.clear();
  sessionStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => void | Promise<void>,
      ) => callback({}),
    },
  });
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis.navigator as { locks?: unknown }).locks;
  delete (window as { matchMedia?: unknown }).matchMedia;
  window.history.replaceState({}, '', '/');
});

test('the phone layer’s way back names the conversation a related preview came from', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityPersistenceContext.Provider
          value={{ status: 'verified', namespace: 'ns', observation }}
        >
          <RegionModelProvider>
            <PaneRelationsProvider>
              <Probe />
              <RegionShells />
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityPersistenceContext.Provider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(open).not.toBeNull());
  act(() => {
    open?.({ projectId: 'project-uuid', projectSlug: 'station', path: 'a.ts' });
  });
  await waitFor(() => expect(model?.phoneLayer).not.toBeNull());
  const back = await screen.findByRole('button', {
    name: 'Back to Security review',
  });
  expect(back.textContent).toContain('Security review');
  act(() => back.click());
  await waitFor(() => expect(model?.phoneLayer).toBeNull());
  expect(model?.regions.bottom.occupant).toBe('chat');
});
