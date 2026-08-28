/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PluginFrameHost } from '../components/plugins/PluginFrameHost';
import { pluginNavigationBudget } from '../components/plugins/plugin-frame-budget';
import { NavigationProvider } from '../contexts/NavigationContext';
import { LAST_PROJECT_LAYOUT_KEY } from '../contexts/navigation-store';

/**
 * archive#3323's whole claim is that a granted plugin navigation reaches the
 * REAL navigation seam. The sibling suite mocks `NavigationContext`, so it
 * proves the host calls whatever it was handed — it would stay green if the
 * provider were absent at the real mount point, which is exactly how the
 * capability was dead for so long in the first place. This file mocks no
 * navigation: it mounts the real `NavigationProvider` and reads the real
 * store's observable effects (the URL, and localStorage).
 */

const FRAME_ORIGIN = 'https://plugins.example.test';

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.example.test' }),
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ pluginFrameOrigin: FRAME_ORIGIN }),
}));

vi.stubGlobal('fetch', vi.fn());

function postNavigate(target: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'navigate', params: { target } },
      origin: FRAME_ORIGIN,
      source: window,
    }),
  );
}

function renderGrantedHost() {
  return render(
    <NavigationProvider>
      <PluginFrameHost
        plugin={{
          name: 'demo',
          declaredSlug: 'demo-panel',
          granted: ['navigation.dock'],
        }}
        onObservation={vi.fn()}
        onFailure={vi.fn()}
      />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => window,
  });
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
  pluginNavigationBudget.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  pluginNavigationBudget.reset();
  window.localStorage.clear();
});

describe('plugin navigation against the real navigation seam', () => {
  test('a granted request actually moves the shell', () => {
    renderGrantedHost();
    expect(window.location.pathname).toBe('/');

    postNavigate('/agents');

    expect(window.location.pathname).toBe('/agents');
  });

  test('a project layout moves the shell without repointing what "/" restores', () => {
    renderGrantedHost();

    postNavigate('/projects/apollo/layouts/coding');

    expect(window.location.pathname).toBe('/projects/apollo/layouts/coding');
    // `setLayout` would have written these. A plugin frame is not the user, so
    // its choice must not survive as the user's last-viewed layout — that key
    // outlives the plugin's own removal.
    expect(window.localStorage.getItem('lastProject')).toBeNull();
    expect(window.localStorage.getItem(LAST_PROJECT_LAYOUT_KEY)).toBeNull();
  });

  test('a cross-project navigation cannot carry a File Preview onto the new project', () => {
    // Withholding `setLayout` also forfeited its clearing of the preview
    // query fields, and plain `navigate` starts from the LIVE URL — so a
    // plugin navigating away from alpha would have reconstituted alpha's
    // preview as `beta:src/secret.ts`. Project identity is route-owned
    // (openFilePreviewIntent.ts); the fields must die at the project switch.
    window.history.replaceState(
      {},
      '',
      '/projects/alpha/layouts/coding?previewPath=src%2Fsecret.ts&previewLineStart=3&previewLineEnd=9',
    );
    renderGrantedHost();

    postNavigate('/projects/beta/layouts/coding');

    expect(window.location.pathname).toBe('/projects/beta/layouts/coding');
    const search = new URLSearchParams(window.location.search);
    expect(search.get('previewPath')).toBeNull();
    expect(search.get('previewLineStart')).toBeNull();
    expect(search.get('previewLineEnd')).toBeNull();
  });

  test('an ungranted request cannot move the real shell', () => {
    render(
      <NavigationProvider>
        <PluginFrameHost
          plugin={{ name: 'demo', declaredSlug: 'demo-panel', granted: [] }}
          onObservation={vi.fn()}
          onFailure={vi.fn()}
        />
      </NavigationProvider>,
    );

    postNavigate('/agents');

    expect(window.location.pathname).toBe('/');
  });

  test('the rate bound holds against the real shell, not just a spy', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderGrantedHost();

    postNavigate('/agents');
    expect(window.location.pathname).toBe('/agents');
    postNavigate('/plugins');
    expect(window.location.pathname).toBe('/plugins');
    // Third request in the same interval: the shell must stay where it is.
    postNavigate('/agents');
    expect(window.location.pathname).toBe('/plugins');
  });
});
