/** @vitest-environment jsdom */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ActivityRegionShell } from '../../app-shell/ActivityRegionShell';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
  useShowSurface,
} from '../RegionModelContext';

const sessionsProps = vi.hoisted(() => vi.fn());

vi.mock('../../views/SessionsView', () => ({
  SessionsView: (props: Record<string, unknown>) => {
    sessionsProps(props);
    return <div data-testid="sessions-view" />;
  },
}));
vi.mock('../ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function FallbackProducer() {
  const showSurface = useShowSurface();
  return (
    <button
      type="button"
      onClick={() =>
        showSurface('activity', { session: 'thread/alpha', focus: 'evidence' })
      }
    >
      Reveal
    </button>
  );
}

function Harness({ shell = false }: { shell?: boolean }) {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          {shell ? <ActivityRegionShell regionId="right" /> : null}
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

beforeEach(() => {
  model = null;
  sessionsProps.mockReset();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  setUrl('/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUrl('/');
});

describe('RegionModelProvider surface deep-link adoption', () => {
  test('useShowSurface falls back to the canonical deep link without a provider', () => {
    const { getByRole } = render(<FallbackProducer />);

    act(() => getByRole('button', { name: 'Reveal' }).click());

    expect(window.location.pathname + window.location.search).toBe(
      '/?surface=activity&session=thread%2Falpha&focus=evidence',
    );
    expect(navigationStore.getSnapshot().surfaceIntent).toEqual({
      surfaceId: 'activity',
      sessionId: 'thread/alpha',
      focus: 'evidence',
    });
  });

  test('adopts Activity once, delivers its binding, and clears by replacement', async () => {
    setUrl('/');
    const historyLength = window.history.length;
    const rendered = render(<Harness shell />);
    await waitFor(() => expect(model).not.toBeNull());
    const updateParams = navigationStore.updateParams.bind(navigationStore);
    let deferredClear = false;
    vi.spyOn(navigationStore, 'updateParams').mockImplementation((params) => {
      if (params.surface === null && !deferredClear) {
        deferredClear = true;
        window.dispatchEvent(new PopStateEvent('popstate'));
        setTimeout(() => updateParams(params), 0);
        return;
      }
      updateParams(params);
    });
    act(() => {
      model?.setRegion('bottom', { visible: true });
      navigationStore.updateParams({
        surface: 'activity',
        session: 's1',
        focus: 'evidence',
      });
    });

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          focusHint: 'evidence',
          intentToken: 1,
        }),
      ),
    );
    expect(window.location.search).toBe('?dock=open');
    expect(window.history.length).toBe(historyLength);
    expect(model?.surfaceIntents.activity?.token).toBe(1);

    const token = model?.surfaceIntents.activity?.token;
    rendered.unmount();
    render(<Harness />);
    await act(async () => undefined);
    expect(model?.surfaceIntents.activity).toBeUndefined();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await act(async () => undefined);
    expect(model?.surfaceIntents.activity?.token).not.toBe(token);
  });

  test('preserves dock ordering on desktop and folds to Activity on bottom-only devices', async () => {
    setUrl('/?dock=open&surface=activity');
    const desktop = render(<Harness />);
    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(model?.regions.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
    });
    desktop.unmount();

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    setUrl('/?dock=open&surface=activity');
    render(<Harness />);

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.regions.right.visible).toBe(true);
    expect(model?.regions.bottom.visible).toBe(false);
    expect(model?.lastShownRegion).toBe('right');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
  });

  test('clears an unknown surface without changing the layout', async () => {
    setUrl('/?surface=unknown&session=s1');
    render(<Harness />);

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.regions.right.occupant).toBeNull();
    expect(model?.surfaceIntents.unknown).toBeUndefined();
  });

  test('delivers repeated mounted intents and consumes focus without losing the session', async () => {
    render(<Harness shell />);
    await waitFor(() => expect(model).not.toBeNull());

    act(() =>
      model?.showSurface('activity', { session: 's2', focus: 'evidence' }),
    );
    await waitFor(() =>
      expect(model?.surfaceIntents.activity).toEqual({
        session: 's2',
        focus: 'evidence',
        token: 1,
      }),
    );

    const binding = sessionsProps.mock.lastCall?.[0] as
      | { onFocusConsumed?: () => void }
      | undefined;
    act(() => binding?.onFocusConsumed?.());
    expect(model?.surfaceIntents.activity).toEqual({
      session: 's2',
      focus: undefined,
      token: 1,
    });

    act(() => model?.showSurface('activity', { focus: 'evidence' }));
    expect(model?.surfaceIntents.activity).toEqual({
      session: 's2',
      focus: 'evidence',
      token: 2,
    });
  });
});
